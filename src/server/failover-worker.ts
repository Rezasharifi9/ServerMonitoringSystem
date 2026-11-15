import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { decorateNodes } from "@/lib/health";
import { can } from "@/lib/rbac";
import type { DemoUser } from "@/types";
import { automaticFailoverEnabled, dnsExecutionEnabled, enrolledRecord } from "./cloudflare-failover";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { advanceFailoverExecution, startFailoverExecution } from "./failover-execution";
import { prepareFailoverPlan } from "./failover-plans";
import { agentIsSilent, failoverCause } from "./failover-silence";
import { currentNodeDomain, refreshAuthoritativeDns, reconcilePanelRoutes } from "./providers";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { syncPrimaryTunnelDns } from "./managed-dns";
import { advanceTunnelDeployments, prepareAutomaticStandby } from "./tunnel-deployments";
import { standbyEnrollment } from "./standby-preflight";
import { provisionEnabled } from "./provision";

const expected = new Set(["FAILOVER_ENROLLMENT", "FAILOVER_PREFLIGHT", "FAILOVER_PLAN_BUSY", "FAILOVER_DOMAIN_BUSY",
  "FAILOVER_PLAN_STATE", "FAILOVER_AUTO_REJECTED", "DNS_CHANGED", "DNS_EXECUTION_PENDING",
  "TUNNEL_DEPLOYMENT_BUSY", "PROVISION_PREFLIGHT", "PROVISION_HOST_BUSY"]);

function nextCandidates() {
  return transaction((db) => {
    const { state, revision } = readWorkspace(db);
    const before = JSON.stringify([state.nodes, state.tunnels]);
    reconcilePanelRoutes(db, state);
    if (before !== JSON.stringify([state.nodes, state.tunnels])) writeWorkspace(db, state, revision + 1);
    const simple = state.settings.failover.trigger === "tunnel-loss";
    const policies = new Map(state.policies.map((policy) => [policy.nodeId, simple ? state.settings.failover : policy]));
    const now = Date.now();
    const marker = db.prepare("SELECT value FROM workspace_meta WHERE key=?");
    const candidates = state.nodes.filter((node) => {
      const policy = policies.get(node.id);
      if (policy?.trigger && policy.trigger !== "independent" &&
          now - Number(marker.get("failover_check:" + node.id)?.value ?? 0) < policy.intervalSec * 1000) return false;
      return node.backupTunnelId && (node.activeSide === "primary" ? policy?.autoEnabled :
        policy?.autoFailback && (!simple || policy.autoEnabled));
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (!candidates.length) return { selected: [], dns: state.dns };
    const cursor = db.prepare("SELECT value FROM workspace_meta WHERE key='auto_failover_cursor'").get()?.value;
    const offset = typeof cursor === "string" ? candidates.findIndex((node) => node.id.localeCompare(cursor) > 0) : 0;
    const start = Math.max(0, offset);
    const selected = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 4);
    db.prepare(`INSERT INTO workspace_meta VALUES ('auto_failover_cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(selected.at(-1)!.id);
    const mark = db.prepare("INSERT INTO workspace_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    for (const node of selected) if (policies.get(node.id)?.trigger) mark.run("failover_check:" + node.id, String(now));
    return { selected, dns: state.dns, simple };
  });
}

function simpleFailoverArmed() {
  if (workspaceMode() !== "monitor") return false;
  const policy = readWorkspace().state.settings.failover;
  return policy.trigger === "tunnel-loss" && policy.autoEnabled;
}

function nodeTunnelDomain(node: { id: string; domain: string; primaryTunnelId: string; backupTunnelId?: string }, state: ReturnType<typeof readWorkspace>["state"]) {
  const backup = state.tunnels.find((tunnel) => tunnel.id === node.backupTunnelId);
  if (!backup || !backup.nodeIds.includes(node.id) && !(backup.nodeRef?.kind === "inventory" && backup.nodeRef.id === node.id)) return "";
  return currentNodeDomain(database(), node.id);
}

function primaryRouteFailed(db: ReturnType<typeof database>, node: { primaryServerId: string; primaryTunnelId: string }, state: ReturnType<typeof readWorkspace>["state"], policy: { intervalSec: number; failureThreshold: number; packetLossThreshold?: number }, now: number) {
  const tunnel = state.tunnels.find((item) => item.id === node.primaryTunnelId);
  const server = state.servers.find((item) => item.id === node.primaryServerId);
  const windowMs = policy.intervalSec * 1000 * Math.max(1, policy.failureThreshold);
  const heartbeatAt = Date.parse(server?.agent.lastHeartbeat ?? "");
  const latest = server ? db.prepare("SELECT MAX(observed_at) AS at FROM agent_reports WHERE server_id=?").get(server.id) : undefined;
  const latestReportAt = Number(latest && typeof latest.at === "number" ? latest.at : 0);
  const tunnelAt = Date.parse(tunnel?.lastCheck ?? "");
  const probeWindowMs = Math.max(windowMs, (state.settings.telemetryIntervals?.tunnelProbe ?? 120) * 2000 + 30000);
  const tunnelFresh = Number.isFinite(tunnelAt) && now - tunnelAt <= probeWindowMs && tunnelAt <= now + 30000;
  return failoverCause({
    tunnelStatus: tunnelFresh ? tunnel?.status : undefined,
    packetLoss: tunnelFresh ? tunnel?.packetLoss : undefined,
    lossThreshold: policy.packetLossThreshold ?? 10,
    agentSilent: agentIsSilent({ now, heartbeatAt, latestReportAt, windowMs }),
  });
}

function primaryRouteRecovered(db: ReturnType<typeof database>, node: { primaryServerId: string; primaryTunnelId: string }, state: ReturnType<typeof readWorkspace>["state"], policy: { intervalSec: number; failureThreshold: number; packetLossThreshold?: number }, now: number) {
  const tunnel = state.tunnels.find((item) => item.id === node.primaryTunnelId);
  const server = state.servers.find((item) => item.id === node.primaryServerId);
  const windowMs = policy.intervalSec * 1000 * Math.max(1, policy.failureThreshold);
  const heartbeatAt = Date.parse(server?.agent.lastHeartbeat ?? "");
  const latest = server ? db.prepare("SELECT MAX(observed_at) AS at FROM agent_reports WHERE server_id=?").get(server.id) : undefined;
  const latestReportAt = Number(latest && typeof latest.at === "number" ? latest.at : 0);
  if (agentIsSilent({ now, heartbeatAt, latestReportAt, windowMs })) return false;
  const tunnelAt = Date.parse(tunnel?.lastCheck ?? "");
  const probeWindowMs = Math.max(windowMs, (state.settings.telemetryIntervals?.tunnelProbe ?? 120) * 2000 + 30000);
  if (!Number.isFinite(tunnelAt) || now - tunnelAt > probeWindowMs || tunnelAt > now + 30000) return false;
  if (!tunnel || !["healthy", "degraded"].includes(tunnel.status)) return false;
  if (typeof tunnel.packetLoss === "number" && tunnel.packetLoss >= (policy.packetLossThreshold ?? 10)) return false;
  return true;
}

function simpleDnsChange(db: ReturnType<typeof database>, node: { id: string; domain: string; activeSide: "primary" | "backup"; primaryServerId: string; backupServerId?: string; primaryTunnelId: string; backupTunnelId?: string }, state: ReturnType<typeof readWorkspace>["state"], now: number) {
  const policy = state.settings.failover;
  const domain = nodeTunnelDomain(node, state);
  if (!domain || !node.backupServerId || !node.backupTunnelId) return null;
  const onBackup = node.activeSide === "backup";
  const failed = primaryRouteFailed(db, node, state, policy, now);
  const recovered = primaryRouteRecovered(db, node, state, policy, now);
  const target = !onBackup && failed ? "backup" as const
    : onBackup && recovered && policy.autoFailback ? "primary" as const
    : onBackup && failed ? "backup" as const
    : !onBackup && recovered ? "primary" as const
    : null;
  if (!target) {
    db.prepare("DELETE FROM workspace_meta WHERE key=?").run("simple_failover_evidence:" + node.id);
    return null;
  }
  // Never move traffic to an unobserved or failed backup. Require consecutive
  // failure observations and a stable recovery window before changing sides.
  if (target === "backup" && !primaryRouteRecovered(db, {
    primaryServerId: node.backupServerId, primaryTunnelId: node.backupTunnelId,
  }, state, policy, now)) return null;
  const key = "simple_failover_evidence:" + node.id;
  if (target === node.activeSide) {
    db.prepare("DELETE FROM workspace_meta WHERE key=?").run(key);
  } else {
    const value = db.prepare("SELECT value FROM workspace_meta WHERE key=?").get(key)?.value;
    let evidence: { target: string; since: number; count: number };
    try { evidence = JSON.parse(String(value)); } catch { evidence = { target, since: now, count: 0 }; }
    if (!evidence || evidence.target !== target || !Number.isFinite(evidence.since) || !Number.isFinite(evidence.count)) evidence = { target, since: now, count: 0 };
    evidence.count += 1;
    db.prepare("INSERT INTO workspace_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(evidence));
    const minimum = target === "backup" ? Math.max(1, policy.minConfirmations) : 1;
    const stableMs = target === "primary" ? policy.stabilitySec * 1000 : 0;
    const lastSwitch = state.nodes.find(item => item.id === node.id)?.lastFailoverAt;
    if (evidence.count < minimum || now - evidence.since < stableMs ||
        (lastSwitch && now - Date.parse(lastSwitch) < policy.cooldownSec * 1000)) return null;
  }
  if (target === "backup" && !policy.autoEnabled) return null;
  if (target === "primary" && onBackup && !policy.autoFailback) return null;
  const destination = state.servers.find((item) => item.id === (target === "backup" ? node.backupServerId : node.primaryServerId));
  if (!destination || isIP(destination.publicIpv4) !== 4) return null;
  return {
    target,
    domain,
    ip: destination.publicIpv4,
    sideChange: node.activeSide !== target,
  };
}

function recordSimpleSwitch(actor: DemoUser, nodeId: string, target: "primary" | "backup", domain: string, ip: string, sideChange: boolean) {
  transaction((db) => {
    const { revision, state } = readWorkspace(db);
    const at = new Date().toISOString();
    state.dns = state.dns.map((item) => item.nodeId === nodeId ? {
      ...item, aRecords: [ip], aaaaRecords: [], cname: undefined, proxied: false, lastCheck: at,
      authoritativeStatus: "matched", expectedIranIp: ip, note: `${domain} → ${ip}`,
    } : item);
    const nodes = state.nodes.map((item) => item.id === nodeId
      ? { ...item, ...(sideChange ? { activeSide: target, lastFailoverAt: at, failoverState: "RECOVERED" as const } : {}) } : item);
    state.nodes = decorateNodes(nodes, state.servers, state.tunnels, state.dns, state.settings, true);
    state.audit = [{
      id: randomUUID(), at, actor: actor.name, role: actor.role, simulated: false,
      action: "failover.execute.succeeded", target: nodeId, detail: `${domain} → ${ip}`,
    }, ...state.audit].slice(0, 2000);
    writeWorkspace(db, state, revision + 1);
  });
}

export async function tickFailover(actor: DemoUser) {
  if (!can(actor.role, "failover.run") || !can(actor.role, "dns.switch")) {
    throw new ApiError(403, "FORBIDDEN", "اجازهٔ کنترل Failover لازم است.");
  }
  const simpleAuto = simpleFailoverArmed();
  if (!dnsExecutionEnabled() && !simpleAuto) throw new ApiError(503, "DNS_WRITE_DISABLED", "اجرای تغییر DNS در این محیط فعال نیست.");
  const db = database();
  const pending = db.prepare(`
    SELECT plan_id FROM failover_executions WHERE status IN ('applying','verifying','rolling_back')
      AND (lease_until IS NULL OR lease_until <= ?) ORDER BY updated_at LIMIT 4
  `).all(Date.now());
  const outcomes = await Promise.allSettled(pending.map((row) => advanceFailoverExecution(actor, String(row.plan_id))));
  let prepared = 0;
  let standbyStarted = 0;
  let scheduleErrors = 0;
  let resumed = 0;
  if (automaticFailoverEnabled()) {
    try {
      advanceTunnelDeployments();
    } catch {
      scheduleErrors += 1;
    }
    const unstarted = db.prepare(`
      SELECT p.id FROM failover_plans p WHERE p.automatic=1 AND p.second_actor=0 AND p.status='approved' AND p.expires_at>?
      AND NOT EXISTS (SELECT 1 FROM failover_executions WHERE plan_id=p.id)
      ORDER BY p.created_at LIMIT 4
    `).all(Date.now());
    for (const row of unstarted) {
      try {
        startFailoverExecution(actor, String(row.id));
        resumed += 1;
      } catch (error) {
        if (!(error instanceof ApiError && expected.has(error.code))) scheduleErrors += 1;
      }
    }
    const { selected, dns, simple } = nextCandidates();
    const scheduled = await Promise.allSettled(selected.map(async (node) => {
      try {
        const enrollment = enrolledRecord(node.id);
        const running = db.prepare(`
          SELECT 1 FROM failover_executions WHERE record_id = ?
          AND status IN ('applying','verifying','rolling_back','review')
        `).get(enrollment.id);
        if (running) return false;
        const observation = dns.find((item) => item.nodeId === node.id);
        if (!observation || !(Date.now() - Date.parse(observation.lastCheck) < 120000)) {
          await refreshAuthoritativeDns(actor, node.id);
        }
        const target = node.activeSide === "primary" ? "backup" : "primary";
        try {
          if (!simple && target === "backup" && provisionEnabled() && standbyEnrollment(node.id) && prepareAutomaticStandby(actor, node.id)) {
            standbyStarted += 1;
            return false;
          }
        } catch (error) {
          if (!(error instanceof ApiError && expected.has(error.code))) scheduleErrors += 1;
        }
        const { plan } = prepareFailoverPlan(actor, { nodeId: node.id, target }, "auto-" + randomUUID(), true);
        if (plan.status === "approved") startFailoverExecution(actor, plan.id);
        return true;
      } catch (error) {
        if (error instanceof ApiError && expected.has(error.code)) return false;
        throw error;
      }
    }));
    prepared = scheduled.filter((item) => item.status === "fulfilled" && item.value).length;
    scheduleErrors += scheduled.filter((item) => item.status === "rejected").length;
  }
  let switched = 0;
  const reasons: string[] = [];
  if (simpleAuto && !automaticFailoverEnabled()) {
    const { selected } = nextCandidates();
    const { state } = readWorkspace();
    for (const node of selected) {
      try {
        const change = simpleDnsChange(db, node, state, Date.now());
        if (!change) continue;
        if ([node.primaryServerId, node.backupServerId, node.foreignServerId].some((id) => id &&
          db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id=? AND expires_at>?").get(id, Date.now()))) continue;
        await syncPrimaryTunnelDns(actor, change.domain, change.ip);
        recordSimpleSwitch(actor, node.id, change.target, change.domain, change.ip, change.sideChange);
        switched += 1;
      } catch (error) {
        if (error instanceof ApiError) reasons.push(`${node.domain}:${error.code}`);
        else scheduleErrors += 1;
      }
    }
  }
  return {
    advanced: outcomes.filter((item) => item.status === "fulfilled").length,
    errors: scheduleErrors + outcomes.filter((item) => item.status === "rejected").length,
    prepared,
    resumed,
    standbyStarted,
    switched,
    reasons,
  };
}
