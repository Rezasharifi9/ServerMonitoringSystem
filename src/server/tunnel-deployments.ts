import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decorateNodes } from "@/lib/health";
import { tunnelInstallationWarning } from "@/lib/tunnel-installation-warning";
import { can } from "@/lib/rbac";
import type { DemoUser, ProvisionJob, ProvisionProfile, ProvisionTunnelBinding, Tunnel, TunnelDeployment, TunnelDeploymentPreview } from "@/types";
import { digest } from "./auth";
import { supportsProvisionDownload, supportsProvisionRemoval } from "./agent-workers";
import { hasProvisionDownload } from "./provision-download";
import { database, readWorkspace, transaction, writeWorkspace, type Workspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import {
  auditProvision, checkProvisionHost, expireProvisionJobs, insertProvisionJob,
  provisionBusy, provisionEnabled, viewProvisionJob,
} from "./provision";
import { matchingTunnelPort, profiles, tunnelBindings } from "./provision-catalog";
import { tunnelForwarding } from "./providers";
import { stagedForeignJob, standbyPreflight } from "./standby-preflight";
import { bbrProfile } from "./provision-bbr";
import { syncPrimaryTunnelDns } from "./managed-dns";
import { currentNodeDomain, panelTunnelHost } from "./providers";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/);
const request = z.union([
  z.object({ tunnelId: identifier, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), operation: z.literal("rebuild").optional() }).strict(),
  z.object({ tunnelId: identifier, operation: z.literal("destroy") }).strict(),
]);
const uuid = z.string().uuid();
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;
type Phase = TunnelDeployment["phase"];
type Status = TunnelDeployment["status"];
type RemovalPhase = "iran_remove" | "foreign_remove";
type Cleanup = { deleteInventory?: boolean; operation: "destroy" | "rebuild"; jobs: { id: string; phase: RemovalPhase }[] };

function cleanupPlan(row: Row): Cleanup | undefined {
  if (typeof row.cleanup !== "string") return undefined;
  try {
    return JSON.parse(row.cleanup) as Cleanup;
  } catch {
    return undefined;
  }
}

function previews(db: DatabaseSync, requireCurrentPorts = true) {
  if (!provisionEnabled()) return [];
  const catalog = profiles(db);
  const configured = tunnelBindings(db);
  const { state } = readWorkspace(db);
  const forwarding = requireCurrentPorts ? tunnelForwarding(db, state.nodes) : undefined;
  return configured.flatMap((entry): TunnelDeploymentPreview[] => {
    const tunnel = state.tunnels.find((item) => item.id === entry.tunnelId);
    if (!tunnel) return [];
    const iran = catalog.find((item) => item.serverId === tunnel.iranEndpoint.serverId && item.id === entry.iranProfileId);
    const foreign = catalog.find((item) => item.serverId === tunnel.foreignEndpoint.serverId && item.id === entry.foreignProfileId);
    if (!iran || !foreign || iran.serverId === foreign.serverId || iran.component !== tunnel.technology || foreign.component !== tunnel.technology) return [];
    if (forwarding && !matchingTunnelPort(tunnel.technology, forwarding(tunnel), iran)) return [];
    if (requireCurrentPorts && tunnel.technology === "GRE") {
      const selected = tunnel.config.greTransport === "native" ? "native" : "udp";
      const mode = (p: ProvisionProfile) => p.greTransport ?? (p.summary.includes("GRE over UDP") ? "udp" : "native");
      if (mode(iran) !== selected || mode(foreign) !== selected) return [];
    }
    const preview = { tunnelId: tunnel.id, technology: tunnel.technology, iran, foreign };
    return [{ ...preview, fingerprint: digest(JSON.stringify(preview)) }];
  });
}

export function tunnelDeploymentPreview(db: DatabaseSync, tunnelId: string) {
  return previews(db).find((item) => item.tunnelId === tunnelId);
}

function allow(actor: DemoUser) {
  if (!can(actor.role, "deploy.run") || !can(actor.role, "server.configure") || !can(actor.role, "tunnel.mutate")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی پیکربندی تونل و نصب روی سرور لازم است.");
  }
  if (!provisionEnabled()) throw new ApiError(503, "PROVISION_DISABLED", "استقرار عملیاتی فعال نیست.");
}

function find(db: DatabaseSync, key: string) {
  const row = db.prepare("SELECT d.*, r.node_id FROM tunnel_deployments d LEFT JOIN failover_standby_repairs r ON r.deployment_id=d.id WHERE d.id=?").get(key);
  if (!row) throw new ApiError(404, "TUNNEL_DEPLOYMENT_UNKNOWN", "استقرار تونل پیدا نشد.");
  return row;
}

function steps(db: DatabaseSync, key: string) {
  return db.prepare(`
    SELECT j.*, s.phase FROM tunnel_deployment_steps s JOIN provision_jobs j ON j.id=s.job_id
    WHERE s.deployment_id=? ORDER BY j.rowid
  `).all(key).map((row) => ({ phase: String(row.phase).split(":", 1)[0] as Phase, job: viewProvisionJob(row, db) }));
}

function view(db: DatabaseSync, row: Row): TunnelDeployment {
  const run: TunnelDeployment = {
    id: String(row.id), operation: cleanupPlan(row)?.operation, standbyNodeId: typeof row.node_id === "string" ? row.node_id : undefined,
    preview: JSON.parse(String(row.preview)) as TunnelDeploymentPreview,
    status: row.status as Status, phase: row.phase as Phase, detail: String(row.detail),
    createdAt: new Date(Number(row.created_at)).toISOString(), steps: steps(db, String(row.id)),
    activation: db.prepare("SELECT status FROM tunnel_activations WHERE deployment_id=?").get(row.id)?.status as TunnelDeployment["activation"],
  };
  if (tunnelInstallationWarning(run)) {
    const tunnel = readWorkspace(db).state.tunnels.find(t => t.id === run.preview.tunnelId);
    const nodeIds = JSON.stringify(tunnel?.nodeIds ?? []);
    const messages = db.prepare(`SELECT json_extract(payload,'$.message') AS message FROM monitor_logs
      WHERE server_id=? AND source IN ('v2bx-shared','v2bx-node') AND severity IN ('ERROR','CRITICAL','WARNING')
      AND ts_ms BETWEEN ? AND ? AND (node_id IS NULL OR node_id IN (SELECT value FROM json_each(?)))
      ORDER BY ts_ms DESC LIMIT 100`).all(run.preview.foreign.serverId,
      Number(row.created_at) - 15 * 60000, Number(row.created_at) + 15 * 60000, nodeIds);
    run.warning = tunnelInstallationWarning(run, messages.map(log => String(log.message)));
  }
  return run;
}

function move(db: DatabaseSync, run: TunnelDeployment, status: Status, phase: Phase, detail: string) {
  db.prepare("UPDATE tunnel_deployments SET status=?, phase=?, detail=? WHERE id=?").run(status, phase, detail, run.id);
  if (run.standbyNodeId && (status === "rolled_back" || status === "failed")) {
    db.prepare("UPDATE failover_standby_repairs SET invalidated_at=? WHERE deployment_id=?").run(Date.now(), run.id);
    db.prepare("UPDATE tunnel_deployments SET verification_baseline=(SELECT coalesce(MAX(rowid),0) FROM agent_reports) WHERE id=?")
      .run(run.id);
  }
}

function queueStep(db: DatabaseSync, run: TunnelDeployment, actorId: string, phase: "iran_apply" | "foreign_apply" | "iran_restore" | "foreign_restore", now: number) {
  const restoration = phase === "iran_restore" || phase === "foreign_restore";
  const iran = phase === "iran_apply" || phase === "iran_restore";
  const profile: ProvisionProfile = iran ? run.preview.iran : run.preview.foreign;
  const original = restoration ? run.steps.find((step) => step.phase === (iran ? "iran_apply" : "foreign_apply"))?.job : undefined;
  if (restoration && original?.status !== "succeeded") throw new Error("Missing successful tunnel installation for rollback");
  const key = "tunnel:" + run.id + ":" + phase;
  const job = insertProvisionJob(db, actorId, key, run.preview.fingerprint, profile, original?.id ?? null, now);
  db.prepare("INSERT INTO tunnel_deployment_steps (deployment_id,phase,job_id) VALUES (?,?,?)").run(run.id, phase, job);
  move(db, run, restoration ? "rolling_back" : "deploying", phase,
    restoration ? "restoring" : phase === "foreign_apply" ? "starting_foreign" : "starting_iran");
}

function linkVerified(db: DatabaseSync, run: TunnelDeployment, now: number) {
  db.prepare("UPDATE tunnel_deployments SET verified_at=? WHERE id=?").run(now, run.id);
  const tunnel = readWorkspace(db).state.tunnels.find(t => t.id === run.preview.tunnelId);
  if (tunnel?.side === "primary" && tunnel.nodeRef) {
    db.prepare("INSERT OR IGNORE INTO tunnel_activations(deployment_id,status) VALUES (?,'pending')").run(run.id);
    move(db, run, "deploying", "dns", "waiting_for_dns");
  } else move(db, run, "succeeded", "verify", "link_verified");
}

function queueBbrSteps(db: DatabaseSync, run: TunnelDeployment, actorId: string, now: number) {
  for (const [phase, serverId] of [["iran_bbr", run.preview.iran.serverId], ["foreign_bbr", run.preview.foreign.serverId]] as const) {
    const job = insertProvisionJob(db, actorId, `tunnel:${run.id}:${phase}`, run.preview.fingerprint, bbrProfile(serverId), null, now);
    db.prepare("INSERT INTO tunnel_deployment_steps VALUES (?,?,?)").run(run.id, phase, job);
  }
  move(db, run, "deploying", "foreign_bbr", "installing_bbr");
}

export async function finalizeTunnelActivations() {
  if (!provisionEnabled()) return;
  const db = database();
  const tasks = db.prepare("SELECT a.deployment_id FROM tunnel_activations a JOIN tunnel_deployments d ON d.id=a.deployment_id WHERE d.phase='dns' AND d.status='deploying' AND (a.status='pending' OR a.status='working' AND a.lease_until<?) LIMIT 4").all(Date.now());
  for (const task of tasks) {
    const claimed = transaction(connection => connection.prepare("UPDATE tunnel_activations SET status='working',lease_until=? WHERE deployment_id=? AND (status='pending' OR status='working' AND lease_until<?)").run(Date.now()+120000, task.deployment_id!, Date.now()).changes);
    if (!claimed) continue;
    try {
      const row = find(db, String(task.deployment_id)); const run = view(db, row);
      const { state } = readWorkspace(db); const actor = state.users.find(u => u.id === row.actor_id);
      const tunnel = state.tunnels.find(t => t.id === run.preview.tunnelId);
      if (!actor || !tunnel || tunnel.side !== "primary" || !can(actor.role, "dns.switch")) throw new ApiError(403,"DNS_ACTIVATION_PERMISSION","دسترسی تنظیم DNS لازم است.");
      const domain = tunnel.nodeRef?.kind === "v2board" ? panelTunnelHost(db, tunnel.nodeRef.key)
        : tunnel.nodeRef?.kind === "inventory" ? currentNodeDomain(db, tunnel.nodeRef.id) : undefined;
      if (!domain) throw new ApiError(409,"NODE_DOMAIN_UNAVAILABLE","دامنه نود پیدا نشد.");
      await syncPrimaryTunnelDns(actor, domain, tunnel.iranEndpoint.publicIp);
      transaction(connection => {
        connection.prepare("UPDATE tunnel_activations SET status='succeeded',lease_until=NULL,detail=NULL WHERE deployment_id=?").run(run.id);
        move(connection, run, "succeeded", "verify", "link_verified");
        auditProvision(connection, actor, "tunnel.activate", [run.preview.iran.serverId,run.preview.foreign.serverId], `${domain} → ${tunnel.iranEndpoint.publicIp}`);
      });
    } catch (error) {
      transaction(connection => {
        connection.prepare("UPDATE tunnel_activations SET status='failed',lease_until=NULL,detail=? WHERE deployment_id=?").run(error instanceof ApiError ? error.code : "DNS_ACTIVATION_FAILED", task.deployment_id!);
        move(connection, view(connection,find(connection,String(task.deployment_id))), "review", "dns", "dns_activation_failed");
      });
    }
  }
}

function queuePair(db: DatabaseSync, run: TunnelDeployment, actorId: string, now: number) {
  queueStep(db, run, actorId, "foreign_apply", now);
  if (hasProvisionDownload(run.preview.iran) && hasProvisionDownload(run.preview.foreign)) {
    queueStep(db, run, actorId, "iran_apply", now);
  }
}

function queueRemoval(db: DatabaseSync, run: TunnelDeployment, actorId: string, target: Cleanup["jobs"][number], now: number) {
  const original = db.prepare("SELECT * FROM provision_jobs WHERE id=? AND status='succeeded' AND rollback_of IS NULL").get(target.id);
  if (!original) throw new Error("Missing tunnel installation for removal");
  const step = `${target.phase}:${target.id}`;
  const job = insertProvisionJob(db, actorId, `tunnel:${run.id}:${step}`, run.preview.fingerprint, viewProvisionJob(original).profile, target.id, now, "remove");
  db.prepare("INSERT INTO tunnel_deployment_steps (deployment_id,phase,job_id) VALUES (?,?,?)").run(run.id, step, job);
  move(db, run, "rolling_back", target.phase, "removing");
}

function installedJobs(db: DatabaseSync, tunnel: Tunnel, previousBinding?: ProvisionTunnelBinding) {
  const binding = tunnelBindings(db).find((item) => item.tunnelId === tunnel.id);
  const rows = db.prepare(`
    SELECT j.*, d.tunnel_id AS owner FROM provision_jobs j
    LEFT JOIN tunnel_deployment_steps s ON s.job_id=j.id
    LEFT JOIN tunnel_deployments d ON d.id=s.deployment_id
    WHERE j.server_id IN (?,?) AND j.status='succeeded' AND j.rollback_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM provision_jobs r WHERE r.rollback_of=j.id AND r.status='succeeded' AND coalesce(r.operation,'rollback') IN ('rollback','remove'))
      AND NOT EXISTS (SELECT 1 FROM provision_jobs r WHERE r.server_id=j.server_id AND r.operation='remove'
        AND r.status='succeeded' AND r.rowid>j.rowid AND json_extract(r.profile,'$.id')=json_extract(j.profile,'$.id'))
    ORDER BY j.rowid DESC
  `).all(tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId);
  const staged = new Set(db.prepare(`
    SELECT r.foreign_job_id FROM failover_standby_repairs r JOIN tunnel_deployments d ON d.id=r.deployment_id WHERE d.tunnel_id=?
  `).all(tunnel.id).map((row) => row.foreign_job_id));
  const installed = new Map<string, { job: ProvisionJob; phase: RemovalPhase }>();
  const shared = new Set<string>();
  for (const row of rows) {
    const job = viewProvisionJob(row);
    if (job.profile.component !== tunnel.technology) continue;
    const iran = job.profile.serverId === tunnel.iranEndpoint.serverId;
    const profileIds = [binding, previousBinding].map((item) => iran ? item?.iranProfileId : item?.foreignProfileId);
    const key = `${job.profile.serverId}/${job.profile.id}`;
    if (typeof row.owner === "string" && row.owner !== tunnel.id) shared.add(key);
    const belongs = row.owner === tunnel.id || staged.has(job.id) || (row.owner === null && profileIds.includes(job.profile.id));
    if (belongs && !installed.has(key)) installed.set(key, { job, phase: iran ? "iran_remove" : "foreign_remove" });
  }
  return [...installed].map(([key, target]) => ({ ...target, shared: shared.has(key) }))
    .sort((a, b) => Number(a.phase === "foreign_remove") - Number(b.phase === "foreign_remove"));
}

function assertExclusiveProfiles(db: DatabaseSync, tunnel: Tunnel, targets: ReturnType<typeof installedJobs>) {
  const bindings = tunnelBindings(db);
  const others = readWorkspace(db).state.tunnels.filter((item) => item.id !== tunnel.id);
  for (const { job, shared } of targets) {
    const { serverId, id } = job.profile;
    const otherBinding = others.some((item) => {
      const binding = bindings.find((entry) => entry.tunnelId === item.id);
      return (item.iranEndpoint.serverId === serverId && binding?.iranProfileId === id) ||
        (item.foreignEndpoint.serverId === serverId && binding?.foreignProfileId === id);
    });
    if (shared || otherBinding) {
      throw new ApiError(409, "TUNNEL_PROFILE_SHARED", "یکی از بسته‌های نصب‌شده به مسیر دیگری هم تعلق دارد.");
    }
  }
}

function clearTunnelHealth(db: DatabaseSync, tunnelId: string) {
  const { state, revision } = readWorkspace(db);
  const tunnel = state.tunnels.find((item) => item.id === tunnelId);
  if (!tunnel) return;
  Object.assign(tunnel, { status: "offline", lastCheck: "", rxMbps: 0, txMbps: 0, forwarderProbe: undefined });
  state.nodes = decorateNodes(state.nodes, state.servers, state.tunnels, state.dns, state.settings, true);
  writeWorkspace(db, state, revision + 1);
}

function healthyAfterInstallation(db: DatabaseSync, row: Row, run: TunnelDeployment, now: number) {
  const report = db.prepare(`
    SELECT observed_at, payload FROM agent_reports
    WHERE server_id=? AND rowid>? AND observed_at>=? AND observed_at<=?
      AND (EXISTS (SELECT 1 FROM json_each(payload, '$.tunnels') WHERE json_extract(value, '$.tunnelId')=?)
        OR EXISTS (SELECT 1 FROM json_each(payload, '$.forwarderChecks') WHERE json_extract(value, '$.tunnelId')=?))
    ORDER BY observed_at DESC LIMIT 1
  `).get(run.preview.iran.serverId, Number(row.verification_baseline), Math.max(Number(row.verify_from), now - 90000),
    now, run.preview.tunnelId, run.preview.tunnelId);
  if (!report) return false;
  let data: {
    tunnels?: { tunnelId: string; status: string; measuredAt?: string }[];
    forwarderChecks?: { tunnelId: string; ok: boolean; measuredAt: string }[];
  };
  try {
    data = JSON.parse(String(report.payload)) as typeof data;
  } catch {
    return false;
  }
  const fresh = (item: { tunnelId: string; measuredAt?: string }) => {
    const at = Date.parse(item.measuredAt ?? "");
    return item.tunnelId === run.preview.tunnelId && at >= Math.max(Number(row.verify_from), now - 90000) && at <= now;
  };
  return ["GOST", "Backhaul", "Rathole"].includes(run.preview.technology)
    ? Boolean(data.forwarderChecks?.some((item) => fresh(item) && item.ok))
    : Boolean(data.tunnels?.some((item) => fresh(item) && item.status === "healthy"));
}

function advance(db: DatabaseSync, now: number) {
  expireProvisionJobs(db, now);
  if (!provisionEnabled()) return;
  const rows = db.prepare(`
    SELECT d.*, r.node_id FROM tunnel_deployments d LEFT JOIN failover_standby_repairs r ON r.deployment_id=d.id
    WHERE d.status IN ('deploying','verifying','rolling_back')
  `).all();
  for (const row of rows) {
    let run: TunnelDeployment;
    try {
      run = view(db, row);
    } catch {
      continue;
    }
    const actorId = String(row.actor_id);
    if (run.status === "verifying") {
      if (now <= Number(row.verify_until) && healthyAfterInstallation(db, row, run, now)) {
        db.prepare("UPDATE tunnel_deployments SET verified_at=? WHERE id=?").run(now, run.id);
        linkVerified(db, run, now);
      } else if (now >= Number(row.verify_until)) {
        queueStep(db, run, actorId, "iran_restore", now);
      }
      continue;
    }
    if (run.phase === "dns") continue;

    const job = run.steps.findLast((step) => step.phase === run.phase)?.job;
    if (!job) {
      move(db, run, "review", run.phase, "missing_step");
      continue;
    }
    if (job.status === "queued" || job.status === "running") continue;
    if (run.phase === "foreign_bbr") {
      const bbr = run.steps.filter(s => s.phase === "iran_bbr" || s.phase === "foreign_bbr");
      if (bbr.some(s => s.job.status === "running" || s.job.status === "queued")) continue;
      if (bbr.some(s => s.job.status !== "succeeded")) { move(db,run,"review",run.phase,"bbr_failed"); continue; }
      db.prepare("UPDATE tunnel_deployments SET verify_from=?,verify_until=?,verification_baseline=(SELECT coalesce(MAX(rowid),0) FROM agent_reports) WHERE id=?").run(now,now+300000,run.id);
      move(db,run,"verifying","verify","waiting_for_probe");
      continue;
    }
    if (job.status === "review" || (run.status === "rolling_back" && job.status !== "succeeded")) {
      move(db, run, "review", run.phase, "host_state_uncertain");
      continue;
    }
    if (job.operation === "remove") {
      const cleanup = cleanupPlan(row)!;
      const next = cleanup.jobs.find(({ id }) => !run.steps.some((step) => step.job.rollbackOf === id));
      if (next) {
        queueRemoval(db, run, actorId, next, now);
      } else {
        clearTunnelHealth(db, run.preview.tunnelId);
        if (cleanup.operation === "rebuild") queuePair(db, run, actorId, now);
        else {
          move(db, run, "destroyed", run.phase, "configuration_removed");
          if (cleanup.deleteInventory) {
            const { state, revision } = readWorkspace(db);
            const tunnel = state.tunnels.find((item) => item.id === run.preview.tunnelId);
            if (tunnel) {
              removeTunnelData(db, state, tunnel);
              writeWorkspace(db, state, revision + 1);
            }
          }
        }
      }
      continue;
    }
    const peer = run.phase === "iran_apply" ? run.steps.find((step) => step.phase === "foreign_apply")?.job : undefined;
    if (peer?.status === "queued" || peer?.status === "running") continue;
    if (peer?.status === "review") {
      move(db, run, "review", run.phase, "host_state_uncertain");
      continue;
    }
    if (peer && peer.status !== "succeeded" && job.status === "succeeded") {
      queueStep(db, run, actorId, "iran_restore", now);
      continue;
    }
    if (job.status !== "succeeded") {
      if (peer?.status === "succeeded") queueStep(db, run, actorId, "foreign_restore", now);
      else move(db, run, "failed", run.phase, run.standbyNodeId ? "standby_install_failed" : "foreign_install_failed");
      continue;
    }
    if (run.phase === "foreign_apply") {
      queueStep(db, run, actorId, "iran_apply", now);
    } else if (run.phase === "iran_apply") {
      if (readWorkspace(db).state.tunnels.find(t => t.id === run.preview.tunnelId)?.side === "primary") {
        queueBbrSteps(db,run,actorId,now); continue;
      }
      const baseline = db.prepare("SELECT coalesce(MAX(rowid),0) AS rowid FROM agent_reports").get();
      if (job.detail === "verified") {
        db.prepare("UPDATE tunnel_deployments SET verify_from=?,verified_at=?,verification_baseline=? WHERE id=?")
          .run(now, now, Number(baseline?.rowid ?? 0), run.id);
        move(db, run, "succeeded", "verify", "link_verified");
        continue;
      }
      const settings = readWorkspace(db).state.settings;
      const interval = settings.telemetryIntervals?.tunnelProbe ?? (hasProvisionDownload(job.profile) ? 120 : settings.monitoringIntervalSec);
      const deadline = now + Math.max(90000, (interval * 2 + 30) * 1000);
      db.prepare("UPDATE tunnel_deployments SET verify_from=?,verify_until=?,verification_baseline=? WHERE id=?")
        .run(now, deadline, Number(baseline?.rowid ?? 0), run.id);
      move(db, run, "verifying", "verify", "waiting_for_probe");
    } else if (run.phase === "iran_restore" && run.steps.some(({ phase, job }) => phase === "foreign_apply" && job.status === "succeeded")) {
      queueStep(db, run, actorId, "foreign_restore", now);
    } else {
      move(db, run, "rolled_back", run.phase, "previous_configuration_restored");
    }
  }
}

export function advanceTunnelDeployments() {
  if (provisionEnabled()) transaction((db) => advance(db, Date.now()));
}

export function listTunnelDeployments(tunnelId?: string) {
  return transaction((db) => {
    db.exec("SAVEPOINT tunnel_list_advance");
    try {
      advance(db, Date.now());
      db.exec("RELEASE tunnel_list_advance");
    } catch (error) {
      db.exec("ROLLBACK TO tunnel_list_advance");
      db.exec("RELEASE tunnel_list_advance");
      if (error instanceof ApiError) throw error;
      console.error("NodeGuard tunnel advance skipped:", error instanceof Error ? error.name : "unknown");
    }
    const { state } = readWorkspace(db);
    const tunnel = tunnelId ? state.tunnels.find((item) => item.id === tunnelId) : undefined;
    return {
      enabled: provisionEnabled(), previews: previews(db),
      hasManagedInstall: Boolean(tunnel && installedJobs(db, tunnel).length),
      forwarding: tunnel ? tunnelForwarding(db, state.nodes)(tunnel) : undefined,
      deployments: db.prepare(`
        SELECT d.*, r.node_id FROM tunnel_deployments d LEFT JOIN failover_standby_repairs r ON r.deployment_id=d.id
        WHERE (? IS NULL OR d.tunnel_id=?)
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 40
      `).all(tunnelId ?? null, tunnelId ?? null).flatMap((row) => {
        try {
          return [view(db, row)];
        } catch {
          return [];
        }
      }),
    };
  });
}

function reserve(db: DatabaseSync, preview: TunnelDeploymentPreview, options: { foreignPrepared?: boolean; destroyingHosts?: string[] } = {}) {
  const hosts = [preview.iran.serverId, preview.foreign.serverId];
  if (provisionBusy(db, ...hosts)) throw new ApiError(409, "TUNNEL_DEPLOYMENT_BUSY", "یکی از دو میزبان درگیر نصب یا بررسی دیگری است.");
  const targets = options.destroyingHosts ?? (options.foreignPrepared ? hosts.slice(0, 1) : hosts);
  for (const host of new Set(targets)) checkProvisionHost(db, host);
  if (!options.destroyingHosts) {
    const pending = options.foreignPrepared ? [preview.iran] : [preview.iran, preview.foreign];
    for (const profile of pending) {
      if (hasProvisionDownload(profile) && !supportsProvisionDownload(db, profile.serverId, Date.now())) {
        throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "Agent میزبان را به‌روز کنید و منتظر اتصال Worker بمانید.", { serverId: profile.serverId });
      }
    }
  }
}

function assertNoSshOperation(db: DatabaseSync, iran: string, foreign: string, now: number, leaseOwner?: string) {
  const operation = db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id IN (?,?) AND expires_at>? AND owner<>?")
    .get(iran, foreign, now, leaseOwner ?? "");
  if (operation) throw new ApiError(409, "SSH_OPERATION_BUSY", "آماده‌سازی SSH روی یکی از میزبان‌ها در جریان است.");
}

function purgeTunnelHistory(db: DatabaseSync, tunnel: Tunnel, keepJobIds: string[] = []) {
  const tunnelId = tunnel.id;
  const runs = "SELECT id FROM tunnel_deployments WHERE tunnel_id=?";
  const jobs = db.prepare(`SELECT job_id FROM tunnel_deployment_steps WHERE deployment_id IN (${runs})`).all(tunnelId);
  db.prepare(`DELETE FROM failover_standby_repairs WHERE deployment_id IN (${runs})`).run(tunnelId);
  db.prepare(`DELETE FROM tunnel_deployment_steps WHERE deployment_id IN (${runs})`).run(tunnelId);
  db.prepare("DELETE FROM tunnel_deployments WHERE tunnel_id=?").run(tunnelId);
  const removable = db.prepare(`SELECT id FROM provision_jobs WHERE id IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM failover_standby_repairs WHERE foreign_job_id=provision_jobs.id)
    AND NOT EXISTS (SELECT 1 FROM provision_jobs AS dependent WHERE dependent.rollback_of=provision_jobs.id
      AND dependent.id NOT IN (SELECT value FROM json_each(?)))`);
  const ids = JSON.stringify(jobs.map(({ job_id }) => job_id));
  const keep = new Set(keepJobIds);
  const removed = JSON.stringify(removable.all(ids, ids).map(({ id }) => id).filter((id) => !keep.has(String(id))));
  db.prepare("DELETE FROM provision_progress WHERE job_id IN (SELECT value FROM json_each(?))").run(removed);
  db.prepare("DELETE FROM provision_jobs WHERE id IN (SELECT value FROM json_each(?))").run(removed);
  db.prepare("DELETE FROM tunnel_probe_requests WHERE tunnel_id=?").run(tunnelId);
  db.prepare("DELETE FROM iperf_jobs WHERE json_extract(config,'$.tunnelId')=?").run(tunnelId);
  for (const table of ["agent_reports", "telemetry_history"] as const) {
    const identity = table === "agent_reports" ? "id" : "observed_at,step_ms";
    const reports = db.prepare(`SELECT server_id, ${identity}, payload FROM ${table} WHERE (
      EXISTS (SELECT 1 FROM json_each(payload,'$.tunnels') WHERE json_extract(value,'$.tunnelId')=?)
      OR EXISTS (SELECT 1 FROM json_each(payload,'$.tunnelTraffic') WHERE json_extract(value,'$.tunnelId')=?)
      OR EXISTS (SELECT 1 FROM json_each(payload,'$.forwarderChecks') WHERE json_extract(value,'$.tunnelId')=?))`)
      .all(tunnelId, tunnelId, tunnelId);
    const update = db.prepare(table === "agent_reports"
      ? "UPDATE agent_reports SET payload=? WHERE server_id=? AND id=?"
      : "UPDATE telemetry_history SET payload=? WHERE server_id=? AND observed_at=? AND step_ms=?");
    for (const row of reports) {
      let payload: { tunnels?: { tunnelId: string }[]; tunnelTraffic?: { tunnelId: string }[]; forwarderChecks?: { tunnelId: string }[] };
      try {
        payload = JSON.parse(String(row.payload));
      } catch {
        continue;
      }
      for (const key of ["tunnels", "tunnelTraffic", "forwarderChecks"] as const) {
        if (Array.isArray(payload[key])) payload[key] = payload[key].filter((entry: { tunnelId: string }) => entry.tunnelId !== tunnelId);
      }
      if (table === "agent_reports") update.run(JSON.stringify(payload), row.server_id, row.id);
      else update.run(JSON.stringify(payload), row.server_id, row.observed_at, row.step_ms);
    }
  }
}

// Purge entity history without touching other routes on the same hosts.
function removeTunnelData(db: DatabaseSync, state: Workspace, tunnel: Tunnel, keepJobIds: string[] = []) {
  const id = tunnel.id;
  const ruleIds = state.settings.metricAlertRules?.filter((rule) => rule.targetId === id).map((rule) => rule.id) ?? [];
  const alerts = state.alerts.filter((alert) => alert.tunnelId === id || ruleIds.includes(alert.metricRuleId ?? ""));
  const alertIds = JSON.stringify(alerts.map((alert) => alert.id));
  db.prepare("DELETE FROM telegram_outbox WHERE alert_id IN (SELECT value FROM json_each(?))").run(alertIds);
  db.prepare("DELETE FROM email_outbox WHERE alert_id IN (SELECT value FROM json_each(?))").run(alertIds);
  db.prepare("DELETE FROM metric_alert_cooldowns WHERE rule_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ruleIds));
  state.alerts = state.alerts.filter((alert) => !alerts.includes(alert));
  state.incidents = state.incidents.filter((incident) => incident.tunnelId !== id);
  state.audit = state.audit.filter((entry) => entry.target !== id);
  state.tunnels = state.tunnels.filter((item) => item.id !== id);
  state.settings.metricAlertRules = state.settings.metricAlertRules?.filter((rule) => rule.targetId !== id);
  db.prepare("DELETE FROM topology_registrations WHERE kind='tunnels' AND id=?").run(id);
  db.prepare("DELETE FROM provision_tunnel_bindings WHERE tunnel_id=?").run(id);
  db.prepare("DELETE FROM provider_credentials WHERE provider=?").run("forwarder:" + id);
  db.prepare("DELETE FROM activity_logs WHERE tunnel_id=? OR target=?").run(id, id);
  const plans = db.prepare("SELECT id FROM failover_plans WHERE instr(preflight,?)>0").all(JSON.stringify(id));
  for (const plan of plans) {
    db.prepare("DELETE FROM failover_executions WHERE plan_id=?").run(plan.id);
    db.prepare("DELETE FROM failover_plans WHERE id=?").run(plan.id);
  }
  purgeTunnelHistory(db, tunnel, keepJobIds);
  if (!keepJobIds.length) db.prepare("DELETE FROM tunnel_reinstall_jobs WHERE tunnel_id=?").run(id);
  db.prepare("INSERT INTO retired_tunnel_sources VALUES (?,?,?) ON CONFLICT DO UPDATE SET kind=excluded.kind")
    .run(id, tunnel.iranEndpoint.serverId, tunnel.kind);
  state.nodes = decorateNodes(state.nodes, state.servers, state.tunnels, state.dns, state.settings, true);
}

function detachTunnel(db: DatabaseSync, state: Workspace, tunnelId: string) {
  const removedNodes = new Set<string>();
  const affected = new Set<string>();
  state.nodes = state.nodes.flatMap((node) => {
    node = { ...node, tunnelIds: node.tunnelIds?.filter((id) => id !== tunnelId) };
    const primary = node.primaryTunnelId === tunnelId;
    const backup = node.backupTunnelId === tunnelId;
    if (!primary && !backup) return [node];
    if (primary && node.tunnelIds?.some((id) => state.tunnels.some((tunnel) => tunnel.id === id && tunnel.side === "primary"))) {
      throw new ApiError(409, "TUNNEL_ROUTE_SELECTED", "ابتدا تونل اصلی دیگری را برای این نود انتخاب کنید.");
    }
    affected.add(node.id);
    if (backup && !primary) {
      return [{
        ...node, backupTunnelId: undefined, backupServerId: undefined,
        activeSide: node.activeSide === "backup" ? "primary" : node.activeSide,
      }];
    }
    if (node.backupTunnelId && node.backupServerId && node.backupTunnelId !== tunnelId) {
      throw new ApiError(409, "TUNNEL_ROUTE_SELECTED", "ابتدا تونل بکاپ وابسته را حذف کنید؛ بکاپ به مسیر اصلی تبدیل نمی‌شود.");
    }
    removedNodes.add(node.id);
    return [];
  });
  state.tunnels = state.tunnels.map((item) => ({
    ...item,
    nodeIds: item.id === tunnelId ? [] : item.nodeIds.filter((id) => !removedNodes.has(id)),
    nodeRef: item.nodeRef?.kind === "inventory" && removedNodes.has(item.nodeRef.id) ? undefined : item.nodeRef,
  }));
  const tunnel = state.tunnels.find((item) => item.id === tunnelId);
  if (tunnel) tunnel.nodeRef = undefined;
  state.dns = state.dns.filter((item) => !removedNodes.has(item.nodeId));
  state.policies = state.policies.filter((item) => !removedNodes.has(item.nodeId)).map((policy) =>
    affected.has(policy.nodeId) ? { ...policy, autoEnabled: false, autoFailback: false } : policy);
  if (state.settings.metricAlertRules) {
    state.settings.metricAlertRules = state.settings.metricAlertRules.filter((rule) => !removedNodes.has(rule.targetId));
  }
  for (const id of removedNodes) {
    db.prepare("DELETE FROM v2board_bindings WHERE node_id=?").run(id);
    db.prepare("DELETE FROM dns_monitor_schedule WHERE node_id=?").run(id);
  }
  state.nodes = decorateNodes(state.nodes, state.servers, state.tunnels, state.dns, state.settings, true);
}

function rememberedRemovals(db: DatabaseSync, tunnel: Tunnel) {
  const rows = db.prepare(`SELECT job_id, phase FROM tunnel_reinstall_jobs WHERE tunnel_id=? AND iran_id=? AND foreign_id=?`)
    .all(tunnel.id, tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId);
  const jobs: { id: string; phase: RemovalPhase; serverId: string; job: ProvisionJob }[] = [];
  for (const row of rows) {
    if (row.phase !== "iran_remove" && row.phase !== "foreign_remove") continue;
    const stored = db.prepare(`SELECT * FROM provision_jobs WHERE id=? AND status='succeeded' AND rollback_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM provision_jobs r WHERE r.rollback_of=provision_jobs.id AND r.status='succeeded' AND r.operation='remove')
    `).get(String(row.job_id));
    if (!stored) continue;
    const job = viewProvisionJob(stored);
    jobs.push({ id: job.id, phase: row.phase, serverId: job.profile.serverId, job });
  }
  return jobs;
}

function forgetRemovals(db: DatabaseSync, tunnel: Tunnel) {
  db.prepare("DELETE FROM tunnel_reinstall_jobs WHERE tunnel_id=? AND iran_id=? AND foreign_id=?")
    .run(tunnel.id, tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId);
}

function exclusiveRemovals(db: DatabaseSync, tunnel: Tunnel, jobs: ReturnType<typeof rememberedRemovals>) {
  try {
    assertExclusiveProfiles(db, tunnel, jobs.map((item) => ({ job: item.job, phase: item.phase, shared: false })));
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "TUNNEL_PROFILE_SHARED") return false;
    throw error;
  }
}

export function deleteTunnelInventory(actor: DemoUser, tunnelId: string) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "حذف موجودی عملیاتی در حالت پایش در دسترس است.");
  if (!can(actor.role, "tunnel.delete")) throw new ApiError(403, "FORBIDDEN", "دسترسی حذف تونل مجاز نیست.");
  return transaction((db) => {
    const now = Date.now();
    advance(db, now);
    const { state, revision } = readWorkspace(db);
    const tunnel = state.tunnels.find((item) => item.id === tunnelId);
    if (!tunnel) return { removed: false };
    const linked = state.nodes.filter((node) => node.primaryTunnelId === tunnelId || node.backupTunnelId === tunnelId).map((node) => node.id);
    const changing = db.prepare(`SELECT p.node_id FROM failover_plans p JOIN failover_executions e ON e.plan_id=p.id
      WHERE e.status IN ('applying','verifying','rolling_back','review')`).all();
    if (changing.some((row) => linked.includes(String(row.node_id)))) {
      throw new ApiError(409, "TUNNEL_FAILOVER_ACTIVE", "جابه‌جایی فعال این نود باید تمام شود.");
    }
    assertNoSshOperation(db, tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId, now);
    const hosts = [tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId];
    const limit = Math.max(90000, state.settings.monitoringIntervalSec * 3000);
    const connected = (id: string) => {
      const host = state.servers.find((item) => item.id === id);
      const last = Date.parse(host?.agent.lastHeartbeat ?? "");
      return host?.agent.status === "online" && Number.isFinite(last) && now - last <= limit;
    };
    const running = db.prepare("SELECT 1 FROM tunnel_deployments WHERE tunnel_id=? AND status IN ('deploying','verifying','rolling_back')").get(tunnelId) ||
      db.prepare("SELECT 1 FROM iperf_jobs WHERE json_extract(config,'$.tunnelId')=? AND status IN ('queued','running','cancel_requested')").get(tunnelId);
    if (running) throw new ApiError(409, "TUNNEL_DEPLOYMENT_STATE", "پیش از حذف از پنل، کار جاری را پایان دهید و تنظیمات نصب‌شدهٔ تونل را تخریب کنید.");
    const installed = installedJobs(db, tunnel);
    const leftovers = installed.filter((item) => !item.shared);
    detachTunnel(db, state, tunnelId);
    const at = new Date(now).toISOString();
    state.audit = [...hosts.map((target) => ({
      id: randomUUID(), at, actor: actor.name, role: actor.role, action: "tunnels.detach", target,
      detail: "اتصال تونل از نود جدا شد.", simulated: false,
    })), ...state.audit].slice(0, 2000);
    const agentRemoval = hosts.every(connected) && leftovers.length > 0;
    if (agentRemoval) {
      if (provisionBusy(db, ...hosts)) throw new ApiError(409, "TUNNEL_DEPLOYMENT_BUSY", "یکی از دو میزبان درگیر نصب یا بررسی دیگری است.");
      writeWorkspace(db, state, revision + 1);
      const deployment = startTunnelDeployment(actor, { tunnelId, operation: "destroy" }, "delete-" + randomUUID(), { db }).deployment;
      db.prepare("UPDATE tunnel_deployments SET cleanup=json_set(cleanup,'$.deleteInventory',json('true')) WHERE id=?").run(deployment.id);
      return { removed: false, deployment };
    }
    if (leftovers.length) {
      const remember = db.prepare(`INSERT INTO tunnel_reinstall_jobs (tunnel_id, iran_id, foreign_id, job_id, phase)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
      for (const item of leftovers) remember.run(tunnel.id, hosts[0], hosts[1], item.job.id, item.phase);
    }
    removeTunnelData(db, state, tunnel, leftovers.map((item) => item.job.id));
    writeWorkspace(db, state, revision + 1);
    return { removed: true };
  });
}

export function deleteServerInventory(actor: DemoUser, serverId: string, value: unknown) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "server.configure") || !can(actor.role, "tunnel.delete")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی حذف سرور و تونل لازم است.");
  }
  const input = z.object({ tunnelIds: z.array(identifier).max(500) }).strict().safeParse(value);
  if (!input.success) throw new ApiError(422, "SERVER_DELETE_INPUT", "تأیید فهرست تونل‌ها معتبر نیست.");
  return transaction((db) => {
    const now = Date.now();
    advance(db, now);
    const { state, revision } = readWorkspace(db);
    if (!state.servers.some(({ id }) => id === serverId)) return { removed: false };
    const tunnels = state.tunnels.filter(({ iranEndpoint, foreignEndpoint }) => [iranEndpoint.serverId, foreignEndpoint.serverId].includes(serverId));
    const ids = new Set(tunnels.map(({ id }) => id));
    if (input.data.tunnelIds.length !== ids.size || [...ids].some((id) => !input.data.tunnelIds.includes(id))) {
      throw new ApiError(409, "SERVER_TUNNELS_CHANGED", "فهرست تونل‌ها تغییر کرده است. دوباره بررسی و تأیید کنید.");
    }
    assertNoSshOperation(db, serverId, serverId, now);
    for (const tunnel of tunnels) {
      assertNoSshOperation(db, tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId, now);
      if (provisionBusy(db, tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId) || installedJobs(db, tunnel).length) {
        throw new ApiError(409, "SERVER_TUNNEL_ACTIVE", "ابتدا پاک‌سازی تنظیمات تونل روی میزبان‌ها باید تأیید شود.");
      }
    }
    const removedNodes = new Set(state.nodes.filter((node) => ids.has(node.primaryTunnelId) ||
      (node.activeSide === "backup" && node.backupTunnelId && ids.has(node.backupTunnelId))).map(({ id }) => id));
    const affectedNodes = new Set(state.nodes.filter((node) => removedNodes.has(node.id) || (node.backupTunnelId && ids.has(node.backupTunnelId))).map(({ id }) => id));
    const changing = db.prepare(`SELECT p.node_id FROM failover_plans p JOIN failover_executions e ON e.plan_id=p.id
      WHERE e.status IN ('applying','verifying','rolling_back','review')`).all();
    if (provisionBusy(db, serverId) || changing.some((row) => affectedNodes.has(String(row.node_id))) || db.prepare(`SELECT 1 FROM iperf_jobs
      WHERE (source_id=? OR dest_id=?) AND status IN ('queued','running','cancel_requested')`).get(serverId, serverId)) {
      throw new ApiError(409, "PROVISION_HOST_BUSY", "ابتدا عملیات فعال سرور را پایان دهید.");
    }
    state.servers = state.servers.filter(({ id }) => id !== serverId);
    state.tunnels = state.tunnels.filter(({ id }) => !ids.has(id)).map((tunnel) => ({ ...tunnel,
      nodeIds: tunnel.nodeIds.filter((id) => !removedNodes.has(id)),
      nodeRef: tunnel.nodeRef?.kind === "inventory" && removedNodes.has(tunnel.nodeRef.id) ? undefined : tunnel.nodeRef,
    }));
    state.nodes = state.nodes.filter(({ id }) => !removedNodes.has(id)).map((node) => node.backupTunnelId && ids.has(node.backupTunnelId)
      ? { ...node, backupServerId: undefined, backupTunnelId: undefined } : node);
    state.dns = state.dns.filter(({ nodeId }) => !removedNodes.has(nodeId));
    state.policies = state.policies.filter(({ nodeId }) => !removedNodes.has(nodeId)).map((policy) => affectedNodes.has(policy.nodeId)
      ? { ...policy, autoEnabled: false } : policy);
    if (state.settings.metricAlertRules) state.settings.metricAlertRules = state.settings.metricAlertRules.filter((rule) => rule.targetId !== serverId && !ids.has(rule.targetId));
    for (const id of removedNodes) {
      db.prepare("DELETE FROM v2board_bindings WHERE node_id=?").run(id);
      db.prepare("DELETE FROM dns_monitor_schedule WHERE node_id=?").run(id);
    }
    for (const tunnel of tunnels) {
      db.prepare("DELETE FROM topology_registrations WHERE kind='tunnels' AND id=?").run(tunnel.id);
      db.prepare("DELETE FROM provision_tunnel_bindings WHERE tunnel_id=?").run(tunnel.id);
      purgeTunnelHistory(db, tunnel);
      db.prepare("INSERT INTO retired_tunnel_sources VALUES (?,?,?) ON CONFLICT DO UPDATE SET kind=excluded.kind").run(tunnel.id, tunnel.iranEndpoint.serverId, tunnel.kind);
    }
    db.prepare("DELETE FROM topology_registrations WHERE kind='servers' AND id=?").run(serverId);
    db.prepare("DELETE FROM provider_credentials WHERE provider=?").run(`ssh:${serverId}`);
    db.prepare("DELETE FROM agent_invitations WHERE server_id=?").run(serverId);
    db.prepare("DELETE FROM agent_worker_polls WHERE server_id=?").run(serverId);
    db.prepare("DELETE FROM provision_profiles WHERE server_id=?").run(serverId);
    db.prepare(`INSERT INTO agent_credentials VALUES (?,NULL,?) ON CONFLICT(server_id) DO UPDATE SET credential_digest=NULL,updated_at=excluded.updated_at`).run(serverId, now);
    state.nodes = decorateNodes(state.nodes, state.servers, state.tunnels, state.dns, state.settings, true);
    state.audit = [{ id: randomUUID(), at: new Date(now).toISOString(), actor: actor.name, role: actor.role, action: "servers.delete",
      target: serverId, detail: `سرور و ${ids.size} تونل از موجودی حذف شدند.`, simulated: false }, ...state.audit].slice(0, 2000);
    writeWorkspace(db, state, revision + 1);
    return { removed: true, tunnels: ids.size };
  });
}

function createDeployment(
  db: DatabaseSync, actor: DemoUser, preview: TunnelDeploymentPreview, key: string, now: number,
  standby?: { nodeId: string; foreignJobId: string }, cleanup?: Cleanup,
) {
  const phase = standby ? "iran_apply" : "foreign_apply";
  const id = randomUUID();
  db.prepare(`
    INSERT INTO tunnel_deployments (id,tunnel_id,iran_id,foreign_id,actor_id,request_key,preview,status,phase,detail,created_at,cleanup)
    VALUES (?,?,?,?,?,?,?,'deploying',?,'waiting',?,?)
  `).run(id, preview.tunnelId, preview.iran.serverId, preview.foreign.serverId, actor.id, key, JSON.stringify(preview), phase, now,
    cleanup ? JSON.stringify(cleanup) : null);
  if (standby) {
    db.prepare("INSERT INTO failover_standby_repairs (deployment_id,node_id,foreign_job_id) VALUES (?,?,?)")
      .run(id, standby.nodeId, standby.foreignJobId);
  }
  const run = view(db, find(db, id));
  if (cleanup?.jobs.length) {
    queueRemoval(db, run, actor.id, cleanup.jobs[0], now);
    clearTunnelHealth(db, preview.tunnelId);
    db.prepare(`UPDATE failover_standby_repairs SET cleared_at=?, invalidated_at=? WHERE deployment_id IN
      (SELECT id FROM tunnel_deployments WHERE tunnel_id=?)`).run(now, now, preview.tunnelId);
  } else {
    if (standby) queueStep(db, run, actor.id, "iran_apply", now);
    else queuePair(db, run, actor.id, now);
  }
  auditProvision(db, actor, `tunnel.${cleanup?.operation ?? (standby ? "standby" : "start")}`, [preview.iran.serverId, preview.foreign.serverId]);
  return view(db, find(db, id));
}

export function prepareAutomaticStandby(actor: DemoUser, nodeId: string) {
  allow(actor);
  return transaction((db) => {
    const now = Date.now();
    const preflight = standbyPreflight(db, nodeId, now);
    if (!preflight) return false;
    if (preflight.recovered) {
      db.prepare("UPDATE failover_standby_repairs SET cleared_at=? WHERE node_id=? AND cleared_at IS NULL").run(now, nodeId);
    }
    if (!preflight.repairable) return false;
    advance(db, now);
    const alreadyAttempted = db.prepare(`
      SELECT 1 FROM failover_standby_repairs r JOIN tunnel_deployments d ON d.id=r.deployment_id
      WHERE r.cleared_at IS NULL AND (r.node_id=? OR d.tunnel_id=?)
    `).get(nodeId, preflight.tunnelId);
    const planPending = db.prepare(`
      SELECT 1 FROM failover_plans p WHERE p.node_id=? AND p.expires_at>?
      AND p.status IN ('approved','awaiting_approval') AND NOT EXISTS (SELECT 1 FROM failover_executions e WHERE e.plan_id=p.id)
    `).get(nodeId, now);
    if (alreadyAttempted || planPending) return false;
    const preview = previews(db).find((item) => item.tunnelId === preflight.tunnelId);
    if (!preview) return false;
    const foreignJobId = stagedForeignJob(db, preview.foreign);
    if (typeof foreignJobId !== "string") return false;
    assertNoSshOperation(db, preview.iran.serverId, preview.foreign.serverId, now);
    reserve(db, preview, { foreignPrepared: true });
    createDeployment(db, actor, preview, "standby-" + randomUUID(), now, { nodeId, foreignJobId });
    return true;
  });
}

export function startTunnelDeployment(actor: DemoUser, value: unknown, key: string,
  staging?: { db: DatabaseSync; leaseOwner?: string; previousBinding?: ProvisionTunnelBinding }) {
  allow(actor);
  const input = request.safeParse(value);
  if (!input.success) throw new ApiError(422, "TUNNEL_DEPLOYMENT_INPUT", "مشخصات استقرار معتبر نیست.", input.error.issues);
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  const spec = input.data;
  const start = (db: DatabaseSync) => {
    const now = Date.now();
    advance(db, now);
    const existing = db.prepare(`
      SELECT d.*, r.node_id FROM tunnel_deployments d LEFT JOIN failover_standby_repairs r ON r.deployment_id=d.id
      WHERE d.actor_id=? AND d.request_key=?
    `).get(actor.id, key);
    if (existing) {
      const deployment = view(db, existing);
      if (deployment.preview.tunnelId !== spec.tunnelId || deployment.operation !== spec.operation ||
          ("fingerprint" in spec && deployment.preview.fingerprint !== spec.fingerprint)) {
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "این شناسه برای طرح دیگری ثبت شده است.");
      }
      return { deployment, replay: true };
    }
    const current = spec.operation === "destroy" ? undefined : tunnelDeploymentPreview(db, spec.tunnelId);
    if (spec.operation) {
      const tunnel = readWorkspace(db).state.tunnels.find((item) => item.id === spec.tunnelId);
      if (!tunnel) throw new ApiError(404, "TUNNEL_UNKNOWN", "تونل پیدا نشد.");
      const installed = installedJobs(db, tunnel, staging?.previousBinding);
      const remembered = spec.operation === "rebuild" ? rememberedRemovals(db, tunnel) : [];
      const targets = installed.length ? installed : remembered.filter(() => exclusiveRemovals(db, tunnel, remembered))
        .map((item) => ({ job: item.job, phase: item.phase, shared: false }));
      if (remembered.length && targets.some((item) => remembered.some((saved) => saved.id === item.job.id))) forgetRemovals(db, tunnel);
      const historical = db.prepare(`SELECT preview FROM tunnel_deployments WHERE tunnel_id=? AND iran_id=? AND foreign_id=?
        ORDER BY rowid DESC LIMIT 1`).get(tunnel.id, tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId);
      const preview = spec.operation === "destroy"
        ? (historical && JSON.parse(String(historical.preview)) as TunnelDeploymentPreview) ?? previews(db, false).find((item) => item.tunnelId === tunnel.id)
        : current?.fingerprint === spec.fingerprint ? current : undefined;
      if (!preview || (spec.operation === "destroy" && !targets.length)) {
        throw new ApiError(409, "TUNNEL_DEPLOYMENT_STATE", "بستهٔ نصب‌شده یا طرح معتبر برای این عملیات پیدا نشد.");
      }
      assertExclusiveProfiles(db, tunnel, targets);
      assertNoSshOperation(db, preview.iran.serverId, preview.foreign.serverId, now, staging?.leaseOwner);
      reserve(db, preview, spec.operation === "destroy" ? { destroyingHosts: targets.map(({ job }) => job.profile.serverId) } : {});
      if (targets.some(({ job }) => !supportsProvisionRemoval(db, job.profile.serverId, now))) {
        throw new ApiError(409, "TUNNEL_WORKER_UPGRADE", "Worker سمت‌های دارای نصب را به‌روز کنید و منتظر اتصال دوبارهٔ آن بمانید.");
      }
      const cleanup = { operation: spec.operation, jobs: targets.map(({ job, phase }) => ({ id: job.id, phase })) };
      return { deployment: createDeployment(db, actor, preview, key, now, undefined, cleanup), replay: false };
    }
    const preview = current?.fingerprint === spec.fingerprint ? current : undefined;
    if (!preview) throw new ApiError(409, "TUNNEL_DEPLOYMENT_CHANGED", "طرح تأییدشده با بسته‌های جاری منطبق نیست.");
    const tunnel = readWorkspace(db).state.tunnels.find((item) => item.id === spec.tunnelId);
    const remembered = tunnel ? rememberedRemovals(db, tunnel) : [];
    if (tunnel && remembered.length && exclusiveRemovals(db, tunnel, remembered)) {
      if (remembered.some((item) => !supportsProvisionRemoval(db, item.serverId, now))) {
        throw new ApiError(409, "TUNNEL_WORKER_UPGRADE", "Worker سمت‌های دارای نصب را به‌روز کنید و منتظر اتصال دوبارهٔ آن بمانید.");
      }
      assertNoSshOperation(db, preview.iran.serverId, preview.foreign.serverId, now, staging?.leaseOwner);
      reserve(db, preview, { destroyingHosts: remembered.map((item) => item.serverId) });
      forgetRemovals(db, tunnel);
      return {
        deployment: createDeployment(db, actor, preview, key, now, undefined, {
          operation: "rebuild", jobs: remembered.map(({ id, phase }) => ({ id, phase })),
        }),
        replay: false,
      };
    }
    if (tunnel && remembered.length) forgetRemovals(db, tunnel);
    assertNoSshOperation(db, preview.iran.serverId, preview.foreign.serverId, now, staging?.leaseOwner);
    reserve(db, preview);
    return { deployment: createDeployment(db, actor, preview, key, now), replay: false };
  };
  return staging ? start(staging.db) : transaction(start);
}

export function manageTunnelDeployment(actor: DemoUser, id: string, action: "rollback" | "review") {
  allow(actor);
  if (!uuid.safeParse(id).success) throw new ApiError(422, "TUNNEL_DEPLOYMENT_INPUT", "شناسهٔ استقرار معتبر نیست.");
  return transaction((db) => {
    const now = Date.now();
    advance(db, now);
    const run = view(db, find(db, id));
    if (action === "review") {
      if (run.status !== "review") throw new ApiError(409, "TUNNEL_DEPLOYMENT_STATE", "استقرار در انتظار بررسی دستی نیست.");
      if (run.phase === "dns" && run.activation === "failed") {
        db.prepare("UPDATE tunnel_activations SET status='pending',detail=NULL WHERE deployment_id=?").run(id);
        move(db,run,"deploying","dns","waiting_for_dns");
        return view(db,find(db,id));
      }
      db.prepare(`
        UPDATE provision_jobs SET status='failed', detail='operator_review' WHERE status='review'
        AND id IN (SELECT job_id FROM tunnel_deployment_steps WHERE deployment_id=?)
      `).run(id);
      move(db, run, "failed", run.phase, "operator_review");
    } else {
      if (run.status === "rolling_back" || run.status === "rolled_back") return run;
      if (run.status !== "succeeded") throw new ApiError(409, "TUNNEL_DEPLOYMENT_STATE", "بازگشت دستی پس از تأیید استقرار قابل ثبت است.");
      assertNoSshOperation(db, run.preview.iran.serverId, run.preview.foreign.serverId, now);
      reserve(db, run.preview, { foreignPrepared: Boolean(run.standbyNodeId) });
      const newer = db.prepare(`
        SELECT 1 FROM provision_jobs WHERE server_id=? AND status='succeeded' AND coalesce(operation, '') NOT IN ('restart-v2bx', 'remove-v2bx', 'reboot', 'start-service', 'stop-service', 'restart-service')
          AND rowid>(SELECT rowid FROM provision_jobs WHERE id=?)
          AND id NOT IN (SELECT job_id FROM tunnel_deployment_steps WHERE deployment_id=?)
      `);
        if (run.steps.some((step) => newer.get(step.job.profile.serverId, step.job.id, run.id))) {
        throw new ApiError(409, "TUNNEL_DEPLOYMENT_STATE", "نصب جدیدتری روی یکی از دو میزبان ثبت شده است.");
      }
      queueStep(db, run, actor.id, "iran_restore", now);
    }
    auditProvision(db, actor, "tunnel." + action, [run.preview.iran.serverId, run.preview.foreign.serverId]);
    return view(db, find(db, id));
  });
}
