import type { DatabaseSync } from "node:sqlite";
import { isIP } from "node:net";
import { activeServerId } from "@/lib/health";
import type { FailoverPreflight } from "@/types";
import { digest } from "./auth";
import { database, readWorkspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { observerIds, observersByNode } from "./probe-observers";
import { hostSilenceFailover } from "./failover-silence";
import { probeAddress } from "./server-ping";
import { currentNodeDomain, authoritativeDnsEnabled, cloudflareEnabled, nodeHasPanelBinding, observedPanelBindingIsCurrent } from "./providers";
import { arvanZoneFor } from "./arvan-dns";

type Side = FailoverPreflight["target"];

interface Probe {
  observer: string;
  reportRow: number;
  at: number;
  side: Side;
  ok: boolean;
  elapsedMs?: number;
}

function loadEvidence(db: DatabaseSync, nodeId: string, observers: Set<string>, now: number, windowMs: number): Probe[] {
  if (!observers.size) return [];
  const keys = Array.from(observers);
  const placeholders = keys.map(() => "?").join(",");
  return db.prepare(`
    SELECT agent_reports.rowid AS report_row, server_id, observed_at, json_extract(probe.value, '$.side') AS side,
      json_extract(probe.value, '$.ok') AS ok, json_extract(probe.value, '$.elapsedMs') AS elapsed_ms
    FROM agent_reports, json_each(payload, '$.proxyProbes') AS probe
    WHERE server_id IN (${placeholders}) AND observed_at >= ? AND observed_at <= ?
      AND NOT EXISTS (SELECT 1 FROM agent_credentials c WHERE c.server_id = agent_reports.server_id
        AND (c.credential_digest IS NULL OR c.updated_at > agent_reports.observed_at))
      AND json_extract(probe.value, '$.nodeId') = ? AND json_extract(probe.value, '$.side') IN ('primary','backup')
    ORDER BY observed_at DESC LIMIT 4096
  `).all(...keys, now - windowMs, now + 30000, nodeId).map((row) => ({
    observer: String(row.server_id), reportRow: Number(row.report_row), at: Number(row.observed_at),
    side: row.side as Side, ok: row.ok === 1, elapsedMs: typeof row.elapsed_ms === "number" ? row.elapsed_ms : undefined,
  }));
}

function consecutive(readings: Probe[], cadence: number, desired: boolean, timeout: number) {
  const selected: Probe[] = [];
  for (const reading of readings) {
    if (reading.ok && reading.elapsedMs === undefined) break;
    const success = reading.ok && reading.elapsedMs! <= timeout;
    const previous = selected.at(-1);
    if (success !== desired || (previous && previous.at - reading.at > cadence * 2.25)) break;
    if (previous && previous.at - reading.at < cadence * 0.9) continue;
    selected.push(reading);
  }
  return selected;
}

const hostname = (name: string) => name.toLowerCase().replace(/\.$/, "");

export function checkFailover(nodeId: string, target: Side, db = database(), now = Date.now()) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "پیش‌بررسی عملیاتی در محیط پایش در دسترس است.");
  const { state } = readWorkspace(db);
  const node = state.nodes.find((item) => item.id === nodeId);
  const simple = state.settings.failover.trigger === "tunnel-loss";
  const policy = simple ? state.settings.failover : state.policies.find((item) => item.nodeId === nodeId);
  if (!node || !policy) throw new ApiError(404, "NODE_UNKNOWN", "نود یا سیاست پیدا نشد.");
  const domain = currentNodeDomain(db, nodeId);
  const source = state.servers.find((server) => server.id === activeServerId(node));
  const receiverId = target === "primary" ? node.primaryServerId : node.backupServerId;
  const tunnelId = target === "primary" ? node.primaryTunnelId : node.backupTunnelId;
  const receiver = state.servers.find((server) => server.id === receiverId);
  const foreign = state.servers.find((server) => server.id === node.foreignServerId);
  const tunnel = state.tunnels.find((item) => item.id === tunnelId);
  const dns = state.dns.find((item) => item.nodeId === node.id);
  const observers = observerIds(observersByNode(), nodeId);
  for (const host of [node.primaryServerId, node.backupServerId, node.foreignServerId]) {
    if (host) observers.delete(host);
  }

  const cadence = policy.intervalSec * 1000;
  const fresh = Math.max(90000, state.settings.monitoringIntervalSec * 3000);
  const freshAt = (value?: string, within = fresh) => {
    const at = Date.parse(value ?? "");
    return Number.isFinite(at) && now - at <= within && at <= now + 30000;
  };
  const evidence = loadEvidence(db, nodeId, observers, now,
    Math.max(cadence * (policy.failureThreshold + 3), policy.stabilitySec * 1000 + cadence * 2));
  const repair = target === "backup" ? db.prepare(`
    SELECT d.status, d.created_at, d.verify_from, d.verification_baseline, r.invalidated_at FROM failover_standby_repairs r
    JOIN tunnel_deployments d ON d.id=r.deployment_id
    WHERE d.tunnel_id=? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1
  `).get(tunnelId ?? null) : undefined;
  const targetSince = Number(repair?.invalidated_at ?? repair?.verify_from ?? repair?.created_at ?? 0);
  const targetWatermark = Number(repair?.verification_baseline ?? 0);
  const repairBusy = ["deploying", "verifying", "rolling_back", "review"].includes(String(repair?.status));
  const targetEvidence = new Map<string, Probe[]>();
  const sourceEvidence = new Map<string, Probe[]>();
  let sourceRecoveryConfirmations = 0;
  for (const observer of observers) {
    const reads = evidence.filter((item) => item.observer === observer);
    const targetReads = reads.filter((item) => item.side === target && item.at >= targetSince && item.reportRow > targetWatermark);
    const sourceReads = reads.filter((item) => item.side === node.activeSide);
    if (targetReads.length && now - targetReads[0].at <= cadence * 2.25) {
      targetEvidence.set(observer, consecutive(targetReads, cadence, true, policy.probeTimeoutMs));
    }
    if (sourceReads.length && now - sourceReads[0].at <= cadence * 2.25) {
      sourceEvidence.set(observer, consecutive(sourceReads, cadence, false, policy.probeTimeoutMs));
      if (consecutive(sourceReads, cadence, true, policy.probeTimeoutMs).length) sourceRecoveryConfirmations += 1;
    }
  }
  const confirmations = Array.from(targetEvidence.values()).filter((reads) => reads.length).length;
  const failures = Array.from(sourceEvidence.values()).filter((reads) => reads.length >= policy.failureThreshold).length;
  const metricTrigger = policy.trigger && policy.trigger !== "independent";
  const switchedAt = Date.parse(node.lastFailoverAt ?? "") || 0;
  const returningToPrimary = simple && target === "primary";
  const metricServer = returningToPrimary ? receiver : source;
  const recoveryFreshness = (state.settings.telemetryIntervals?.tunnelProbe ?? 120) * 2000 + 30000;
  let metricRecovered = false;
  let metricFailed = false;
  if (metricTrigger && metricServer && (target === "backup" || returningToPrimary)) {
    const tunnelTrigger = policy.trigger === "tunnel-ping" || policy.trigger === "tunnel-loss";
    const samples = tunnelTrigger ? db.prepare(`
      SELECT observed_at, json_extract(sample.value,'$.packetLoss') AS loss FROM agent_reports,
      json_each(payload,'$.tunnels') AS sample WHERE server_id=? AND observed_at BETWEEN ? AND ?
      AND json_extract(sample.value,'$.tunnelId')=? ORDER BY observed_at DESC LIMIT 4096
    `).all(metricServer.id, returningToPrimary ? Math.max(switchedAt, now - recoveryFreshness) :
      now - cadence * (policy.failureThreshold + 2), now, node.primaryTunnelId) :
      db.prepare(`SELECT observed_at, json_extract(payload,'$.serverPing.packetLoss') AS loss FROM agent_reports
        WHERE server_id=? AND observed_at BETWEEN ? AND ? AND json_type(payload,'$.serverPing.packetLoss') IS NOT NULL
        ORDER BY observed_at DESC LIMIT 4096`).all(metricServer.id, now - cadence * (policy.failureThreshold + 2), now);
    const credential = db.prepare("SELECT updated_at, credential_digest FROM agent_credentials WHERE server_id=?").get(metricServer.id);
    const readings = samples.filter((row) => typeof row.loss === "number" &&
      (!credential || (credential.credential_digest && Number(row.observed_at) >= Number(credential.updated_at))));
    const threshold = simple ? policy.packetLossThreshold ?? 10 : policy.trigger === "packet-loss" ? policy.packetLossThreshold ?? 50 : 100;
    const latestLoss = readings[0]?.loss;
    metricRecovered = returningToPrimary && typeof latestLoss === "number" && latestLoss < threshold;
    let previous = now;
    let failed = 0;
    for (const row of returningToPrimary ? [] : readings) {
      const at = Number(row.observed_at);
      if (previous - at > cadence * 2.25 || (simple ? Number(row.loss) <= threshold && Number(row.loss) !== 100 : Number(row.loss) < threshold)) break;
      if (failed && previous - at < cadence * 0.9) continue;
      failed++;
      previous = at;
      if (failed >= policy.failureThreshold) { metricFailed = true; break; }
    }
  }
  const silenceMs = cadence * policy.failureThreshold;
  const heartbeatAt = Date.parse(metricServer?.agent.lastHeartbeat ?? "");
  const latestReport = metricServer ? db.prepare("SELECT MAX(observed_at) AS at FROM agent_reports WHERE server_id=?").get(metricServer.id) : undefined;
  const latestReportAt = Number(latestReport && typeof latestReport.at === "number" ? latestReport.at : 0);
  let sourceDead = false;
  if (metricTrigger && target === "backup" && metricServer && hostSilenceFailover({
    now, heartbeatAt, latestReportAt, windowMs: silenceMs, ping: "unreachable",
  })) sourceDead = probeAddress(metricServer.publicIpv4) === "unreachable";
  const stable = Array.from(targetEvidence.values()).filter((reads) => {
    const afterSwitch = reads.filter((reading) => reading.at >= switchedAt);
    return afterSwitch.length && afterSwitch[0].at - afterSwitch.at(-1)!.at >= policy.stabilitySec * 1000;
  }).length;
  const capacity = receiver ? 100 - Math.max(receiver.cpu, receiver.ram, receiver.disk) : 0;
  const agentReady = (server: typeof receiver) => Boolean(server && server.agent.status === "online" &&
    server.status !== "offline" && freshAt(server.agent.lastHeartbeat));
  const foreignEvidence = db.prepare(`
    SELECT observed_at, json_extract(payload, '$.v2bx') AS status FROM agent_reports
    WHERE server_id = ? AND json_type(payload, '$.v2bx') = 'text'
      AND NOT EXISTS (SELECT 1 FROM agent_credentials c WHERE c.server_id = agent_reports.server_id
        AND (c.credential_digest IS NULL OR c.updated_at > agent_reports.observed_at))
    ORDER BY observed_at DESC LIMIT 1
  `).get(node.foreignServerId);
  const v2bxReady = foreignEvidence?.status === "running" && now - Number(foreignEvidence.observed_at) <=
    Math.max(fresh, (state.settings.telemetryIntervals?.service ?? 20) * 2000 + 30000);
  const checks: FailoverPreflight["checks"] = [];
  const add = (code: string, ok: boolean, label: string) => { checks.push({ code, ok, label }); };
  add("host-operation", ![node.primaryServerId, node.backupServerId, node.foreignServerId].some((id) => id &&
    db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id=? AND expires_at>?").get(id, now)), "عملیات دیگری روی میزبان‌های مسیر فعال نباشد.");
  add("target", node.activeSide !== target && Boolean(source && receiver && source.id !== receiver.id),
    receiverId ? "مقصد جایگزین باید با مسیر فعال متفاوت باشد." : "برای این نود مسیر پشتیبان ثبت نشده است.");
  add("cooldown", !node.lastFailoverAt || now - Date.parse(node.lastFailoverAt) >= policy.cooldownSec * 1000,
    "دورهٔ خنک‌سازی سیاست سپری شده باشد.");
  if (!simple) {
    add("receiver", agentReady(receiver) && capacity >= policy.minBackupCapacity, "Agent مقصد تازه و ظرفیت آزاد کافی باشد.");
    add("foreign", agentReady(foreign) && v2bxReady, "Agent سرور خارجی تازه و V2bX فعال باشد.");
  }
  const observedAfterRepair = !targetWatermark || db.prepare(`
    SELECT 1 FROM agent_reports WHERE server_id=? AND rowid>? AND observed_at>=? AND observed_at<=?
      AND (EXISTS (SELECT 1 FROM json_each(payload,'$.tunnels') WHERE json_extract(value,'$.tunnelId')=?)
        OR EXISTS (SELECT 1 FROM json_each(payload,'$.forwarderChecks') WHERE json_extract(value,'$.tunnelId')=?))
    LIMIT 1
  `).get(receiverId ?? null, targetWatermark, targetSince, now, tunnelId ?? null, tunnelId ?? null);
  add("tunnel", Boolean(tunnel && tunnel.status === "healthy" && freshAt(tunnel.lastCheck,
    Math.max(fresh, (state.settings.telemetryIntervals?.tunnelProbe ?? 120) * 2000 + 30000)) &&
    observedAfterRepair && Date.parse(tunnel.lastCheck) >= targetSince &&
    tunnel.iranEndpoint.serverId === receiver?.id && tunnel.foreignEndpoint.serverId === foreign?.id),
    "تونل جایگزین سالم و متعلق به همان مسیر باشد.");
  if (!simple) add("probes", confirmations >= policy.minConfirmations, "کاوش‌های مستقل روی مسیر جایگزین موفق باشند.");
  if (repair) add("standby-repair", !repairBusy, "کار آماده‌سازی مسیر پشتیبان به وضعیت نهایی رسیده باشد.");
  if (dns?.v2boardObservedAt || nodeHasPanelBinding(db, node.id)) {
    add("panel", Boolean(dns && observedPanelBindingIsCurrent(dns, now)), "نگاشت V2Board در کاتالوگ تازه حاضر باشد.");
  }
  add("dns", Boolean((simple ? authoritativeDnsEnabled() : cloudflareEnabled()) && !arvanZoneFor(domain) && dns && freshAt(dns.lastCheck, 300000) && hostname(dns.domain) === hostname(domain) &&
    (simple || hostname(dns.v2boardHost) === hostname(domain)) && !dns.v2boardIp && dns.authoritativeStatus === "matched" && !dns.proxied &&
    !dns.cname && !dns.aaaaRecords.length && dns.aRecords.length === 1 && dns.aRecords[0] === source?.publicIpv4 &&
    isIP(source?.publicIpv4 ?? "") === 4 && isIP(receiver?.publicIpv4 ?? "") === 4 && source?.publicIpv4 !== receiver?.publicIpv4),
    "دامنهٔ پنل به یک رکورد A مستقیم، تازه و منطبق با IP فعلی اشاره کند.");
  const ready = checks.every((check) => check.ok);
  const result: FailoverPreflight = {
    nodeId, target, domain, fromIp: source?.publicIpv4 ?? null, toIp: receiver?.publicIpv4 ?? null,
    ready, automaticEligible: ready && (target === "backup" ? policy.autoEnabled &&
      (metricTrigger ? metricFailed || sourceDead || (!simple && !agentReady(source) && failures >= policy.minConfirmations) : failures >= policy.minConfirmations)
      : policy.autoFailback && (simple ? policy.autoEnabled && metricRecovered : stable >= policy.minConfirmations)),
    requiredConfirmations: policy.minConfirmations, targetConfirmations: confirmations, failureConfirmations: failures, checks,
  };
  const fingerprint = digest(JSON.stringify({
    nodeId, activeSide: node.activeSide, target, domain, from: source?.id, to: receiver?.id, foreign: foreign?.id,
    currentIp: result.fromIp, targetIp: result.toIp, tunnelId, panelHost: dns?.v2boardHost, ttl: dns?.ttl,
    zone: process.env.NODEGUARD_CF_ZONE_ID, policy,
  }));
  return { result, fingerprint, sourceRecoveryConfirmations,
    requireSecondActor: policy.manualApproval, automaticRetryMs: Math.max(120, policy.cooldownSec) * 1000 };
}
