import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { can } from "@/lib/rbac";
import type { DemoUser, ProvisionJob, ProvisionProfile, TunnelDeploymentPreview } from "@/types";
import { authorizeAgent, digest } from "./auth";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { profiles, tunnelBindings } from "./provision-catalog";
import { validateStandbyClaim } from "./standby-preflight";
import { markWorkerPoll, supportsHostReboot, supportsProvisionDownload, supportsV2bxRemove, supportsV2bxRestart } from "./agent-workers";
import { panelNodeReference, v2bxRemovalTarget } from "./v2board-nodes";
import { hasProvisionDownload } from "./provision-download";
import { bbrProfile, bbrProfileId, builtInBbrManifest } from "./provision-bbr";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const finishSchema = z.object({
  serverId: id, lease: sha256, status: z.enum(["succeeded", "failed", "review"]),
  detail: z.enum(["applied", "verified", "attached", "restored", "removed", "restarted", "started", "stopped", "rebooted", "restart_failed", "preflight", "listener_conflict", "reverted", "tcp_target_unreachable", "tcp_forward_unreachable", "external_change", "interrupted", "agent_error"]),
}).strict();
export const provisionEnabled = () => workspaceMode() === "monitor" && process.env.NODEGUARD_ENABLE_PROVISION === "1";
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function requireEnabled() {
  if (!provisionEnabled()) throw new ApiError(503, "PROVISION_DISABLED", "Provision عملیاتی فعال نشده است.");
}

function allow(actor: DemoUser) {
  if (!can(actor.role, "deploy.run") || !can(actor.role, "server.configure")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی نصب و پیکربندی سرور لازم است.");
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const value = schema.safeParse(input);
  if (!value.success) throw new ApiError(422, "PROVISION_INPUT", "پارامترهای نصب معتبر نیست.", value.error.issues);
  return value.data;
}

export function viewProvisionJob(row: Row, db?: DatabaseSync): ProvisionJob {
  return {
    id: String(row.id), profile: JSON.parse(String(row.profile)),
    operation: row.operation === "remove" || row.operation === "restart-v2bx" || row.operation === "remove-v2bx" || row.operation === "reboot" || ["start-service", "stop-service", "restart-service"].includes(String(row.operation)) ? row.operation as ProvisionJob["operation"] : row.rollback_of ? "rollback" : "apply",
    status: row.status as ProvisionJob["status"], rollbackOf: typeof row.rollback_of === "string" ? row.rollback_of : undefined,
    createdAt: new Date(Number(row.created_at)).toISOString(), detail: String(row.detail), coordinated: row.coordinated === 1,
    checks: db?.prepare("SELECT step FROM provision_progress WHERE job_id=? ORDER BY at").all(String(row.id))
      .map(({ step }) => step as NonNullable<ProvisionJob["checks"]>[number]),
  };
}

function find(db: DatabaseSync, key: string) {
  const row = db.prepare("SELECT * FROM provision_jobs WHERE id=?").get(key);
  if (!row) throw new ApiError(404, "PROVISION_UNKNOWN", "کار نصب پیدا نشد.");
  return row;
}

export function expireProvisionJobs(db: DatabaseSync, now: number) {
  db.prepare("UPDATE provision_jobs SET status='cancelled', detail='queue_expired' WHERE status='queued' AND queue_until<=?").run(now);
  db.prepare("UPDATE provision_jobs SET status='review', detail='agent_missing' WHERE status='running' AND lease_until<=?").run(now);
}

export function provisionAuditDetail(event: string, component?: string) {
  if (event === "apply" && component === "BBR") return "فعال‌سازی BBR در صف Agent قرار گرفت.";
  if (event === "apply" && component === "V2bX") return "نصب V2bX در صف Agent قرار گرفت.";
  if (event === "apply") return `نصب ${component ?? "بسته"} در صف Agent قرار گرفت.`;
  const messages: Record<string, string> = {
    "restart-v2bx": "راه‌اندازی مجدد V2bX در صف Agent قرار گرفت.",
    "reinstall-v2bx": "نصب مجدد V2bX در صف Agent قرار گرفت.",
    "remove-v2bx": "حذف V2bX این نود در صف Agent قرار گرفت.",
    reboot: "ریستارت سرور در صف Agent قرار گرفت.",
    rollback: "بازگردانی نصب در صف Agent قرار گرفت.",
    review: "بررسی عملیات نصب ثبت شد.",
    "tunnel.start": "نصب تونل در صف Agent قرار گرفت.",
    "tunnel.standby": "نصب آماده‌باش تونل در صف Agent قرار گرفت.",
    "tunnel.destroy": "حذف تونل از سرور در صف Agent قرار گرفت.",
    "tunnel.rebuild": "نصب دوبارهٔ تونل از صفر در صف Agent قرار گرفت.",
    "tunnel.rollback": "بازگردانی تونل در صف Agent قرار گرفت.",
    "tunnel.review": "بررسی استقرار تونل ثبت شد.",
  };
  return messages[event] ?? "عملیات سرور در صف Agent قرار گرفت.";
}

function provisionResultDetail(operation: string, component: string | undefined, reinstall: boolean, status: "succeeded" | "failed" | "review") {
  const name = operation === "reboot" ? "ریستارت سرور"
    : operation === "start-service" ? "شروع سرویس تونل"
    : operation === "stop-service" ? "توقف سرویس تونل"
    : operation === "restart-service" ? "ری‌استارت سرویس تونل"
    : operation === "restart-v2bx" && reinstall ? "نصب مجدد V2bX"
    : operation === "restart-v2bx" ? "راه‌اندازی مجدد V2bX"
    : operation === "remove-v2bx" ? "حذف V2bX نود"
    : operation === "remove" ? "حذف نصب"
    : reinstall && component === "BBR" ? "بازگردانی BBR"
    : component === "BBR" ? "فعال‌سازی BBR"
    : component === "V2bX" ? "نصب V2bX"
    : reinstall ? "بازگردانی نصب"
    : `نصب ${component ?? "بسته"}`;
  const outcome = status === "succeeded" ? "تأیید شد" : status === "failed" ? "ناموفق بود" : "نیاز به بررسی دارد";
  return `${name} ${outcome}.`;
}

function recordProvisionResult(db: DatabaseSync, row: Row, status: "succeeded" | "failed" | "review") {
  const profile = JSON.parse(String(row.profile)) as { component?: string };
  const operation = row.operation === "remove" || row.operation === "restart-v2bx" || row.operation === "remove-v2bx" || row.operation === "reboot" || String(row.operation).endsWith("-service")
    ? String(row.operation) : row.rollback_of ? "rollback" : "apply";
  const detail = provisionResultDetail(operation, profile.component, Boolean(row.rollback_of), status);
  const { state, revision } = readWorkspace(db);
  state.audit = [{
    id: randomUUID(), at: new Date().toISOString(), actor: "Agent", role: "system" as const, action: "provision.result",
    target: String(row.server_id), detail, simulated: false,
  }, ...state.audit].slice(0, 2000);
  writeWorkspace(db, state, revision + 1);
}

export function auditProvision(db: DatabaseSync, actor: DemoUser, event: string, targets: string[], detail = provisionAuditDetail(event)) {
  const { state, revision } = readWorkspace(db);
  const at = new Date().toISOString();
  const entries = [...new Set(targets)].map((target) => ({
    id: randomUUID(), actor: actor.name, role: actor.role, action: "provision." + event, at,
    target, detail, simulated: false,
  }));
  state.audit = [...entries, ...state.audit].slice(0, 2000);
  writeWorkspace(db, state, revision + 1);
}

export function checkProvisionHost(db: DatabaseSync, serverId: string) {
  const { state } = readWorkspace(db);
  const host = state.servers.find((item) => item.id === serverId);
  if (!host) throw new ApiError(404, "PROVISION_HOST", "سرور پیدا نشد.");
  const now = Date.now();
  const heartbeat = Date.parse(host.agent.lastHeartbeat);
  if (host.agent.status !== "online" || !Number.isFinite(heartbeat) || now - heartbeat > Math.max(90000, state.settings.monitoringIntervalSec * 3000)) {
    throw new ApiError(409, "PROVISION_PREFLIGHT", "گزارش تازهٔ عامل لازم است.");
  }
  const speedtest = db.prepare(`
    SELECT 1 FROM iperf_jobs WHERE (source_id=? OR dest_id=?)
    AND ((status='queued' AND queue_until>?) OR (status IN ('running','cancel_requested') AND lease_until>?))
  `).get(serverId, serverId, now, now);
  const moving = db.prepare(`
    SELECT node_id FROM failover_executions e JOIN failover_plans p ON p.id=e.plan_id
    WHERE e.status IN ('applying','verifying','rolling_back','review')
  `).all();
  if (speedtest || moving.some((item) => state.nodes.some((node) => node.id === item.node_id &&
      [node.primaryServerId, node.backupServerId, node.foreignServerId].includes(serverId)))) {
    throw new ApiError(409, "PROVISION_HOST_BUSY", "عملیات دیگری روی سرور یا مسیر آن فعال است.");
  }
}

export function provisionBusy(db: DatabaseSync, ...serverIds: (string | undefined)[]) {
  const lookup = db.prepare(`
    SELECT 1 FROM provision_jobs WHERE server_id=?
      AND (status IN ('running','review') OR (status='queued' AND queue_until>?))
  `);
  const now = Date.now();
  const pair = db.prepare(`
    SELECT 1 FROM tunnel_deployments WHERE (iran_id=? OR foreign_id=?)
      AND status IN ('deploying','verifying','rolling_back','review')
  `);
  return serverIds.some((serverId) => serverId !== undefined && Boolean(lookup.get(serverId, now) || pair.get(serverId, serverId)));
}

export function listProvision() {
  return transaction((db) => {
    expireProvisionJobs(db, Date.now());
    return {
      enabled: provisionEnabled(), profiles: provisionEnabled() ? profiles(db) : [],
      jobs: db.prepare(`
        SELECT j.*, EXISTS (SELECT 1 FROM tunnel_deployment_steps WHERE job_id=j.id) AS coordinated
        FROM provision_jobs j ORDER BY created_at DESC, id DESC LIMIT 50
      `).all().map((row) => viewProvisionJob(row, db)),
    };
  });
}

function requireForeignHost(db: DatabaseSync, serverId: string) {
  const host = readWorkspace(db).state.servers.find((item) => item.id === serverId);
  if (!host) throw new ApiError(404, "PROVISION_HOST", "سرور پیدا نشد.");
  if (!host.roles.includes("foreign")) throw new ApiError(403, "V2BX_HOST", "راه‌اندازی V2bX فقط برای سرور خارج در دسترس است.");
}

function managedV2bxInstall(db: DatabaseSync, serverId: string) {
  return db.prepare(`SELECT j.* FROM provision_jobs j WHERE j.server_id=?
    AND ((j.operation IS NULL AND j.rollback_of IS NULL) OR j.operation='restart-v2bx')
    AND j.status='succeeded' AND j.detail IN ('applied','verified')
    AND json_extract(j.profile,'$.component')='V2bX'
    AND NOT EXISTS (SELECT 1 FROM provision_jobs r WHERE r.rollback_of=j.id AND r.status='succeeded' AND r.operation IS NULL)
    ORDER BY j.rowid DESC LIMIT 1`).get(serverId);
}

export function v2bxRestartStatus(serverId: string, reinstall = false) {
  return transaction((db) => {
    requireForeignHost(db, serverId);
    const now = Date.now();
    expireProvisionJobs(db, now);
    const row = db.prepare("SELECT * FROM provision_jobs WHERE server_id=? AND operation='restart-v2bx' AND (rollback_of IS NOT NULL)=? ORDER BY rowid DESC LIMIT 1").get(serverId, Number(reinstall));
    return { ready: provisionEnabled() && supportsV2bxRestart(db, serverId, now) && (!reinstall || Boolean(managedV2bxInstall(db, serverId))), job: row ? viewProvisionJob(row) : null };
  });
}

export function queueV2bxRestart(actor: DemoUser, serverId: string, key: string, reinstall = false) {
  if (!can(actor.role, "server.restart")) throw new ApiError(403, "FORBIDDEN", "دسترسی راه‌اندازی مجدد سرویس لازم است.");
  requireEnabled();
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  if (reinstall) allow(actor);
  const fingerprint = digest(JSON.stringify([reinstall ? "reinstall-v2bx" : "restart-v2bx", serverId]));
  return transaction((db) => {
    requireForeignHost(db, serverId);
    const existing = db.prepare("SELECT * FROM provision_jobs WHERE actor_id=? AND request_key=?").get(actor.id, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "این شناسه برای درخواست دیگری ثبت شده است.");
      return viewProvisionJob(existing);
    }
    const now = Date.now();
    expireProvisionJobs(db, now);
    if (!supportsV2bxRestart(db, serverId, now)) throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "Agent را به‌روز کنید و منتظر اتصال Worker بمانید.");
    checkProvisionHost(db, serverId);
    if (provisionBusy(db, serverId) || db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id=? AND expires_at>?").get(serverId, now)) {
      throw new ApiError(409, "PROVISION_HOST_BUSY", "کار دیگری روی این سرور در جریان است یا بررسی می‌خواهد.");
    }
    const original = reinstall ? managedV2bxInstall(db, serverId) : undefined;
    if (reinstall && !original) throw new ApiError(409, "V2BX_MANAGED_INSTALL", "A NodeGuard-managed V2bX installation is required.");
    const profile = original ? viewProvisionJob(original).profile :
      { id: "restart-v2bx", serverId, component: "V2bX", version: "1", sha256: fingerprint, summary: "Restart V2bX" };
    const job = insertProvisionJob(db, actor.id, key, fingerprint, profile, original ? String(original.id) : null, now, "restart-v2bx");
    auditProvision(db, actor, reinstall ? "reinstall-v2bx" : "restart-v2bx", [serverId]);
    return viewProvisionJob(find(db, job));
  });
}

function removalNode(reference: string) {
  const parsed = panelNodeReference.safeParse(reference);
  if (!parsed.success) throw new ApiError(422, "V2BX_CONFIG", "نود V2Board معتبر نیست.");
  const [nodeType, id] = reference.split(":");
  return { nodeType, nodeId: Number(id), alternate: nodeType === "hysteria" ? "hysteria2" : nodeType };
}

export function v2bxRemoveStatus(serverId: string, reference: string) {
  const node = removalNode(reference);
  return transaction((db) => {
    requireForeignHost(db, serverId);
    const now = Date.now();
    expireProvisionJobs(db, now);
    const row = db.prepare(`
      SELECT * FROM provision_jobs WHERE server_id=? AND operation='remove-v2bx'
        AND json_extract(profile, '$.v2bxNode.nodeId')=?
        AND json_extract(profile, '$.v2bxNode.nodeType') IN (?, ?)
      ORDER BY rowid DESC LIMIT 1
    `).get(serverId, node.nodeId, node.nodeType, node.alternate);
    return { ready: provisionEnabled() && supportsV2bxRemove(db, serverId, now), job: row ? viewProvisionJob(row) : null };
  });
}

export async function queueV2bxRemove(actor: DemoUser, serverId: string, key: string, input: unknown) {
  if (!can(actor.role, "server.restart")) throw new ApiError(403, "FORBIDDEN", "دسترسی راه‌اندازی مجدد سرویس لازم است.");
  allow(actor);
  requireEnabled();
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  const reference = parse(z.object({ panelNode: panelNodeReference }).strict(), input).panelNode;
  const replay = database().prepare("SELECT * FROM provision_jobs WHERE actor_id=? AND request_key=?").get(actor.id, key);
  if (replay) {
    const previous = viewProvisionJob(replay);
    const wanted = removalNode(reference);
    const saved = previous.profile.v2bxNode;
    if (previous.operation !== "remove-v2bx" || previous.profile.serverId !== serverId || saved?.nodeId !== wanted.nodeId ||
        ![wanted.nodeType, wanted.alternate].includes(saved.nodeType)) {
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "این شناسه برای درخواست دیگری ثبت شده است.");
    }
    return previous;
  }
  const target = await v2bxRemovalTarget(actor, reference, serverId);
  const fingerprint = digest(JSON.stringify(["remove-v2bx", serverId, target]));
  return transaction((db) => {
    requireForeignHost(db, serverId);
    const existing = db.prepare("SELECT * FROM provision_jobs WHERE actor_id=? AND request_key=?").get(actor.id, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "این شناسه برای درخواست دیگری ثبت شده است.");
      return viewProvisionJob(existing);
    }
    const now = Date.now();
    expireProvisionJobs(db, now);
    if (!supportsV2bxRemove(db, serverId, now)) throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "Agent را به‌روز کنید و منتظر اتصال Worker بمانید.");
    checkProvisionHost(db, serverId);
    if (provisionBusy(db, serverId) || db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id=? AND expires_at>?").get(serverId, now)) {
      throw new ApiError(409, "PROVISION_HOST_BUSY", "کار دیگری روی این سرور در جریان است یا بررسی می‌خواهد.");
    }
    const profile: ProvisionProfile = {
      id: "remove-v2bx", serverId, component: "V2bX", version: "1", sha256: fingerprint,
      summary: `Remove V2bX node ${reference}`, v2bxNode: target,
    };
    const job = insertProvisionJob(db, actor.id, key, fingerprint, profile, null, now, "remove-v2bx");
    auditProvision(db, actor, "remove-v2bx", [serverId]);
    return viewProvisionJob(find(db, job));
  });
}

export function bbrStatus(serverId: string) {
  return transaction((db) => {
    if (!readWorkspace(db).state.servers.some((host) => host.id === serverId)) {
      throw new ApiError(404, "PROVISION_HOST", "سرور پیدا نشد.");
    }
    const now = Date.now();
    expireProvisionJobs(db, now);
    const profile = bbrProfile(serverId);
    const row = db.prepare(`
      SELECT * FROM provision_jobs WHERE server_id=? AND json_extract(profile,'$.id')=?
        AND json_extract(profile,'$.sha256')=? ORDER BY rowid DESC LIMIT 1
    `).get(serverId, profile.id, profile.sha256);
    return { ready: provisionEnabled() && supportsProvisionDownload(db, serverId, now), job: row ? viewProvisionJob(row) : null };
  });
}

export function queueBbr(actor: DemoUser, serverId: string, key: string) {
  const { id: profileId, sha256 } = bbrProfile(serverId);
  return queueProvision(actor, { operation: "apply", serverId, profileId, sha256 }, key);
}

export function rebootStatus(serverId: string) {
  return transaction((db) => {
    if (!readWorkspace(db).state.servers.some((host) => host.id === serverId)) {
      throw new ApiError(404, "PROVISION_HOST", "سرور پیدا نشد.");
    }
    const now = Date.now();
    expireProvisionJobs(db, now);
    const row = db.prepare("SELECT * FROM provision_jobs WHERE server_id=? AND operation='reboot' ORDER BY rowid DESC LIMIT 1").get(serverId);
    return { ready: provisionEnabled() && supportsHostReboot(db, serverId, now), job: row ? viewProvisionJob(row) : null };
  });
}

export function queueHostReboot(actor: DemoUser, serverId: string, key: string) {
  if (!can(actor.role, "server.restart")) throw new ApiError(403, "FORBIDDEN", "دسترسی راه‌اندازی مجدد سرور لازم است.");
  requireEnabled();
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  const fingerprint = digest(JSON.stringify(["reboot", serverId]));
  return transaction((db) => {
    if (!readWorkspace(db).state.servers.some((host) => host.id === serverId)) {
      throw new ApiError(404, "PROVISION_HOST", "سرور پیدا نشد.");
    }
    const existing = db.prepare("SELECT * FROM provision_jobs WHERE actor_id=? AND request_key=?").get(actor.id, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "این شناسه برای درخواست دیگری ثبت شده است.");
      return viewProvisionJob(existing);
    }
    const now = Date.now();
    expireProvisionJobs(db, now);
    if (!supportsHostReboot(db, serverId, now)) throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "Agent را به‌روز کنید و منتظر اتصال Worker بمانید.");
    checkProvisionHost(db, serverId);
    if (provisionBusy(db, serverId) || db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id=? AND expires_at>?").get(serverId, now)) {
      throw new ApiError(409, "PROVISION_HOST_BUSY", "کار دیگری روی این سرور در جریان است یا بررسی می‌خواهد.");
    }
    const profile: ProvisionProfile = {
      id: "reboot-host", serverId, component: "NodeGuard Agent", version: "1", sha256: fingerprint, summary: "Reboot host",
    };
    const job = insertProvisionJob(db, actor.id, key, fingerprint, profile, null, now, "reboot");
    auditProvision(db, actor, "reboot", [serverId]);
    return viewProvisionJob(find(db, job));
  });
}

export function queueProvision(actor: DemoUser, input: unknown, key: string) {
  allow(actor);
  requireEnabled();
  const spec = parse(z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("apply"), serverId: id, profileId: id, sha256 }).strict(),
    z.object({ operation: z.literal("rollback"), jobId: uuid }).strict(),
  ]), input);
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  const fingerprint = digest(JSON.stringify(spec));
  return transaction((db) => {
    const now = Date.now();
    expireProvisionJobs(db, now);
    const existing = db.prepare("SELECT * FROM provision_jobs WHERE actor_id=? AND request_key=?").get(actor.id, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "این شناسه برای درخواست دیگری ثبت شده است.");
      return { job: viewProvisionJob(existing), replay: true };
    }
    let profile: ProvisionProfile;
    let rollbackOf: string | null = null;
    if (spec.operation === "rollback") {
      if (db.prepare("SELECT 1 FROM tunnel_deployment_steps WHERE job_id=?").get(spec.jobId)) {
        throw new ApiError(409, "PROVISION_ROLLBACK", "بازگشت این کار از صفحهٔ استقرار دو سمت انجام می‌شود.");
      }
      const original = viewProvisionJob(find(db, spec.jobId));
      if (original.operation !== "apply" || original.status !== "succeeded" || original.detail === "attached") throw new ApiError(409, "PROVISION_ROLLBACK", "فقط یک نصب تأییدشده قابل بازگشت است.");
      const later = db.prepare(`
        SELECT 1 FROM provision_jobs WHERE server_id=? AND rowid>(SELECT rowid FROM provision_jobs WHERE id=?)
          AND status='succeeded' AND coalesce(operation, '') NOT IN ('restart-v2bx', 'remove-v2bx', 'reboot', 'start-service', 'stop-service', 'restart-service')
      `).get(original.profile.serverId, original.id);
      if (later) throw new ApiError(409, "PROVISION_ROLLBACK", "ابتدا اثر نصب‌های جدیدتر این سرور را بررسی کنید.");
      profile = original.profile;
      rollbackOf = original.id;
    } else {
      const current = spec.profileId === bbrProfileId ? bbrProfile(spec.serverId) :
        profiles(db).find((item) => item.serverId === spec.serverId && item.id === spec.profileId);
      if (!current || current.sha256 !== spec.sha256) throw new ApiError(409, "PROVISION_PROFILE_CHANGED", "بسته یا هش تأییدشده تغییر کرده است.");
      profile = current;
    }
    const download = !rollbackOf && hasProvisionDownload(profile);
    checkProvisionHost(db, profile.serverId);
    if (download && !supportsProvisionDownload(db, profile.serverId, now)) {
      throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "Agent میزبان را به‌روز کنید و منتظر اتصال Worker بمانید.", { serverId: profile.serverId });
    }
    if (provisionBusy(db, profile.serverId) || (builtInBbrManifest(profile) &&
        db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id=? AND expires_at>?").get(profile.serverId, now))) {
      throw new ApiError(409, "PROVISION_HOST_BUSY", "کار دیگری روی این سرور در جریان است یا بررسی می‌خواهد.");
    }
    const job = insertProvisionJob(db, actor.id, key, fingerprint, profile, rollbackOf, now);
    auditProvision(db, actor, spec.operation, [profile.serverId], provisionAuditDetail(spec.operation, profile.component));
    return { job: viewProvisionJob(find(db, job)), replay: false };
  });
}

export function insertProvisionJob(db: DatabaseSync, actorId: string, key: string, fingerprint: string,
  profile: ProvisionProfile, rollbackOf: string | null, now: number, operation: "remove" | "restart-v2bx" | "remove-v2bx" | "reboot" | "start-service" | "stop-service" | "restart-service" | null = null) {
  const job = randomUUID();
  db.prepare(`
    INSERT INTO provision_jobs (id, actor_id, request_key, fingerprint, server_id, profile, rollback_of, status, detail, created_at, queue_until, operation)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'waiting', ?, ?, ?)
  `).run(job, actorId, key, fingerprint, profile.serverId, JSON.stringify(profile), rollbackOf, now, now + 180000, operation);
  return job;
}

export function claimProvision(request: Request, input: unknown) {
  requireEnabled();
  const { serverId, claimId } = parse(z.object({ serverId: id, claimId: sha256.optional() }).strict(), input);
  const canRemove = request.headers.get("X-NodeGuard-Provision-Remove") === "1";
  const canDownload = request.headers.get("X-NodeGuard-Provision-Download") === "1";
  const canRestart = request.headers.get("X-NodeGuard-V2bX-Restart") === "1";
  const canIptables = request.headers.get("X-NodeGuard-Provision-Iptables") === "1";
  const canReboot = request.headers.get("X-NodeGuard-Host-Reboot") === "1";
  const canRemoveV2bx = request.headers.get("X-NodeGuard-V2bX-Remove") === "1";
  return transaction((db) => {
    authorizeAgent(request, serverId, db);
    const now = Date.now();
    markWorkerPoll(db, serverId, "provision", now, canRemove, canDownload, canRestart, canIptables, canReboot, canRemoveV2bx);
    expireProvisionJobs(db, now);
    const previous = claimId ? db.prepare("SELECT * FROM provision_jobs WHERE server_id=? AND lease_digest=?").get(serverId, digest(claimId)) : undefined;
    // Never reuse an acknowledged request for a different task, or revive a
    // completed/expired lease. The Agent retires its marker on a null response.
    if (previous && (previous.status !== "running" || Number(previous.lease_until) <= now)) return null;
    const row = previous ?? db.prepare("SELECT * FROM provision_jobs WHERE server_id=? AND status='queued' ORDER BY created_at LIMIT 1").get(serverId);
    if (!row || (row.operation === "remove" && !canRemove)) return null;
    const job = viewProvisionJob(row);
    if (job.operation.endsWith("-service") && request.headers.get("X-NodeGuard-Service-Control") !== "1") return null;
    const restart = job.operation === "restart-v2bx";
    const reboot = job.operation === "reboot";
    const removeNode = job.operation === "remove-v2bx";
    if (restart && !canRestart) return null;
    if (reboot && !canReboot) return null;
    if (removeNode && !canRemoveV2bx) return null;
    if (restart && job.rollbackOf && request.headers.get("X-NodeGuard-V2bX-Reinstall") !== "1") return null;
    const download = (job.operation === "apply" || (restart && Boolean(job.rollbackOf))) && hasProvisionDownload(job.profile);
    if (download && (job.profile.id.startsWith("link-iran-") || job.profile.id.startsWith("nat-")) &&
        job.profile.version === "1.1" && job.profile.forwardPort && !canIptables) return null;
    if (download && !canDownload) return null;
    try {
      checkProvisionHost(db, serverId);
      if (restart || removeNode) requireForeignHost(db, serverId);
      else if (!reboot && !job.rollbackOf) {
        const pair = db.prepare(`
          SELECT d.iran_id,d.foreign_id,d.tunnel_id,d.preview,r.node_id,r.foreign_job_id
          FROM tunnel_deployment_steps s JOIN tunnel_deployments d ON d.id=s.deployment_id
          LEFT JOIN failover_standby_repairs r ON r.deployment_id=d.id
          WHERE s.job_id=? AND d.status='deploying'
        `).get(job.id);
        if (pair?.node_id) {
          const preview = JSON.parse(String(pair.preview)) as TunnelDeploymentPreview;
          const binding = tunnelBindings(db).find((item) => item.tunnelId === pair.tunnel_id);
          if (binding?.iranProfileId !== preview.iran.id || binding?.foreignProfileId !== preview.foreign.id ||
              !profiles(db).some((item) => item.serverId === preview.foreign.serverId && item.id === preview.foreign.id && item.sha256 === preview.foreign.sha256)) {
            throw new ApiError(409, "PROVISION_PROFILE_CHANGED", "بستهٔ آمادهٔ سمت خارج تغییر کرده است.");
          }
          validateStandbyClaim(db, String(pair.node_id), String(pair.tunnel_id), preview.foreign, String(pair.foreign_job_id), now);
        } else if (pair) {
          checkProvisionHost(db, String(pair.iran_id === serverId ? pair.foreign_id : pair.iran_id));
        }
      }
      if (!restart && !reboot && !removeNode && !job.rollbackOf && !builtInBbrManifest(job.profile) &&
          !profiles(db).some((item) => item.serverId === serverId && item.id === job.profile.id && item.sha256 === job.profile.sha256)) {
        throw new ApiError(409, "PROVISION_PROFILE_CHANGED", "بسته تغییر کرده است.");
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      db.prepare("UPDATE provision_jobs SET status='failed', detail='preflight' WHERE id=?").run(job.id);
      return null;
    }
    const lease = claimId ?? randomBytes(32).toString("hex");
    if (!previous) db.prepare("UPDATE provision_jobs SET status='running', detail='leased', lease_digest=?, lease_until=? WHERE id=?")
      .run(digest(lease), now + (download ? 900000 : 300000), job.id);
    const pair = download ? db.prepare(`SELECT p.status FROM tunnel_deployment_steps s LEFT JOIN tunnel_deployment_steps f
      ON f.deployment_id=s.deployment_id AND f.phase='foreign_apply' LEFT JOIN provision_jobs p ON p.id=f.job_id
      WHERE s.job_id=? AND s.phase='iran_apply'`).get(job.id) : undefined;
    const waitForPeer = pair?.status === "running" || pair?.status === "queued";
    const verify = Boolean(pair) && (!waitForPeer || request.headers.get("X-NodeGuard-Provision-Parallel") === "1");
    return download ? { ...job, lease, download: true, verify, waitForPeer } : { ...job, lease };
  });
}

export function reportProvisionProgress(request: Request, jobId: string, input: unknown) {
  const key = parse(uuid, jobId);
  const { serverId, lease, step } = parse(z.object({ serverId: id, lease: sha256,
    step: z.enum(["package", "service", "icmp", "tcp"]) }).strict(), input);
  return transaction((db) => {
    authorizeAgent(request, serverId, db);
    const row = find(db, key);
    if (row.server_id !== serverId || row.lease_digest !== digest(lease)) throw new ApiError(403, "PROVISION_LEASE", "مجوز کار معتبر نیست.");
    if (row.status !== "running" || Number(row.lease_until) <= Date.now()) throw new ApiError(409, "PROVISION_JOB_STATE", "مهلت گزارش مراحل پایان یافته است.");
    db.prepare("INSERT OR IGNORE INTO provision_progress VALUES (?,?,?)").run(key, step, Date.now());
    return true;
  });
}

export function finishProvision(request: Request, jobId: string, input: unknown) {
  const key = parse(uuid, jobId);
  const report = parse(finishSchema, input);
  return transaction((db) => {
    authorizeAgent(request, report.serverId, db);
    const row = db.prepare("SELECT * FROM provision_jobs WHERE id=?").get(key);
    // Inventory deletion may purge an acknowledged final removal before its
    // response reaches the Worker. Its durable retry must become terminal.
    if (!row) throw new ApiError(409, "PROVISION_JOB_STATE", "این کار دیگر نتیجه نمی‌پذیرد.");
    if (row.server_id !== report.serverId || row.lease_digest !== digest(report.lease)) {
      throw new ApiError(403, "PROVISION_LEASE", "مجوز کار به این عامل تعلق ندارد.");
    }
    const signature = digest(JSON.stringify(report));
    if (row.finish_digest === signature) return { job: viewProvisionJob(row), replay: true };
    if (row.status !== "running" && !(row.status === "review" && row.detail === "agent_missing")) {
      throw new ApiError(409, "PROVISION_JOB_STATE", "این کار دیگر نتیجه نمی‌پذیرد.");
    }
    const resultCodes = {
      succeeded: row.operation === "start-service" ? ["started"] : row.operation === "stop-service" ? ["stopped"] : row.operation === "restart-service" ? ["restarted"] : row.operation === "reboot" ? ["rebooted"] : row.operation === "restart-v2bx" ? ["restarted"] : row.operation === "remove" || row.operation === "remove-v2bx" ? ["removed"] : row.rollback_of ? ["restored"] : ["applied", "verified", "attached"],
      failed: String(row.operation).endsWith("-service") || row.operation === "reboot" || row.operation === "restart-v2bx" || row.operation === "remove-v2bx" ? ["preflight", "restart_failed"] : row.rollback_of ? ["preflight"] :
        ["preflight", "listener_conflict", "reverted", "tcp_target_unreachable", "tcp_forward_unreachable"],
      review: ["external_change", "interrupted", "agent_error"],
    };
    if (!resultCodes[report.status].includes(report.detail)) {
      throw new ApiError(422, "PROVISION_RESULT", "نتیجه با نوع عملیات سازگار نیست.");
    }
    db.prepare("UPDATE provision_jobs SET status=?, detail=?, finish_digest=? WHERE id=?").run(report.status, report.detail, signature, key);
    recordProvisionResult(db, row, report.status);
    return { job: viewProvisionJob(find(db, key)), replay: false };
  });
}

export function dismissProvisionReview(actor: DemoUser, jobId: string) {
  allow(actor);
  return transaction((db) => {
    expireProvisionJobs(db, Date.now());
    const key = parse(uuid, jobId);
    const row = find(db, key);
    if (db.prepare("SELECT 1 FROM tunnel_deployment_steps WHERE job_id=?").get(key)) {
      throw new ApiError(409, "PROVISION_JOB_STATE", "بررسی این کار از صفحهٔ استقرار دو سمت انجام می‌شود.");
    }
    if (row.status !== "review") throw new ApiError(409, "PROVISION_JOB_STATE", "کار در انتظار بررسی نیست.");
    db.prepare("UPDATE provision_jobs SET status='failed', detail='operator_review' WHERE id=?").run(key);
    auditProvision(db, actor, "review", [String(row.server_id)]);
    return viewProvisionJob(find(db, key));
  });
}
