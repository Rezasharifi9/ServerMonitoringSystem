import { randomBytes, randomUUID } from "node:crypto";
import { BlockList, isIP, SocketAddress } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { can } from "@/lib/rbac";
import type { DemoUser, IperfConfig, IperfJob, IperfResult, Tunnel } from "@/types";
import { digest, authorizeAgent } from "./auth";
import { readWorkspace, transaction, writeWorkspace, type Workspace } from "./database";
import { ApiError } from "./http";
import { provisionBusy } from "./provision";
import { workspaceMode } from "./inventory";
import { markWorkerPoll } from "./agent-workers";

const id = z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i);
const lease = z.string().regex(/^[a-f\d]{64}$/);
const uuid = z.string().uuid();
const port = z.number().int().min(1024).max(65535);
const config = z.object({
  tunnelId: id, sourceServerId: id, destServerId: id,
  protocol: z.enum(["tcp", "udp"]),
  direction: z.enum(["upload", "download", "bidirectional"]),
  durationSec: z.number().int().min(1).max(30),
  streams: z.number().int().min(1).max(4),
  bandwidthLimitMbps: z.number().int().min(1).max(100),
}).strict();
const rate = z.number().min(0).max(1000);
const result = z.object({
  uploadMbps: rate.optional(), downloadMbps: rate.optional(),
  jitterMs: z.number().min(0).max(30000).optional(), lossPct: z.number().min(0).max(100).optional(),
  samples: z.array(z.object({ t: z.number().positive().max(36), uploadMbps: rate.optional(), downloadMbps: rate.optional() }).strict()).max(36),
}).strict();
const finishBody = z.discriminatedUnion("outcome", [
  z.object({ serverId: id, lease, outcome: z.literal("completed"), result }).strict(),
  z.object({ serverId: id, lease, outcome: z.literal("cancelled") }).strict(),
  z.object({ serverId: id, lease, outcome: z.literal("failed"),
    error: z.enum(["target", "launch", "timeout", "output", "exit", "lease"]) }).strict(),
]);

const privateNetworks = new BlockList();
privateNetworks.addSubnet("10.0.0.0", 8);
privateNetworks.addSubnet("172.16.0.0", 12);
privateNetworks.addSubnet("192.168.0.0", 16);
privateNetworks.addSubnet("fc00::", 7, "ipv6");

function privateAddress(value?: string) {
  if (!value || value.includes("%")) return undefined;
  const version = isIP(value);
  const family = version === 6 ? "ipv6" : "ipv4";
  if (version && privateNetworks.check(value, family)) return new SocketAddress({ address: value, family }).address;
}

function targets() {
  const target = z.object({ receiverServerId: id, port }).strict();
  const registered = z.record(id, z.union([target, z.array(target).min(1).max(2)]))
    .parse(JSON.parse(process.env.NODEGUARD_IPERF_TARGETS ?? "{}"));
  return Object.entries(registered).flatMap(([tunnelId, entries]) =>
    (Array.isArray(entries) ? entries : [entries]).map((entry) => ({ tunnelId, ...entry })));
}

export function iperfEnabled() {
  return workspaceMode() === "monitor" && process.env.NODEGUARD_ENABLE_IPERF === "1";
}

function tunnelAddresses(tunnel: Tunnel, sourceServerId: string, receiverServerId: string) {
  const endpoints = [tunnel.iranEndpoint, tunnel.foreignEndpoint];
  const sourceIp = endpoints.find((endpoint) => endpoint.serverId === sourceServerId)?.tunnelIp;
  const peerIp = endpoints.find((endpoint) => endpoint.serverId === receiverServerId)?.tunnelIp;
  const sourceAddress = privateAddress(sourceIp);
  const peerAddress = privateAddress(peerIp);
  if (sourceIp && peerIp && sourceAddress && peerAddress &&
      isIP(sourceAddress) === isIP(peerAddress) && sourceAddress !== peerAddress) {
    return { sourceIp, peerIp };
  }
}

function installerIperfTargets() {
  if (!iperfEnabled()) return [];
  try {
    return targets();
  } catch {
    // An invalid optional enrollment must leave telemetry available without syncing an empty receiver plan.
    return null;
  }
}

export function iperfTargetsForHost(state: Workspace, serverId: string) {
  const registered = installerIperfTargets() ?? [];
  return state.tunnels.flatMap((tunnel) => {
    const target = registered.find((entry) => entry.tunnelId === tunnel.id && entry.receiverServerId !== serverId);
    if (!target || tunnel.kind !== "interface") return [];
    const addresses = tunnelAddresses(tunnel, serverId, target.receiverServerId);
    return addresses ? [{ ...target, ...addresses }] : [];
  });
}

export function iperfReceiversForHost(state: Workspace, serverId: string) {
  const registered = installerIperfTargets();
  if (!registered) return null;
  const entries = [];
  for (const target of registered) {
    const { tunnelId } = target;
    if (target.receiverServerId !== serverId) continue;
    const tunnel = state.tunnels.find((item) => item.id === tunnelId);
    if (tunnel?.kind !== "interface") return null;
    const source = [tunnel.iranEndpoint, tunnel.foreignEndpoint].find((endpoint) => endpoint.serverId !== serverId);
    if (!source) return null;
    const addresses = tunnelAddresses(tunnel, source.serverId, serverId);
    if (!addresses) return null;
    entries.push({
      tunnelId, sourceServerId: source.serverId, sourceIp: addresses.sourceIp, bindIp: addresses.peerIp, port: target.port,
    });
  }
  return entries;
}

function checkEnabled() {
  if (!iperfEnabled()) throw new ApiError(503, "IPERF_DISABLED", "اجرای iperf3 در این محیط فعال نیست.");
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "IPERF_INPUT", "پارامتر تست iperf3 معتبر نیست.", parsed.error.issues);
  return parsed.data;
}

function preflight(state: Workspace, spec: IperfConfig) {
  const tunnel = state.tunnels.find((item) => item.id === spec.tunnelId);
  const target = targets().find((entry) => entry.tunnelId === spec.tunnelId && entry.receiverServerId === spec.destServerId);
  if (!tunnel || tunnel.kind !== "interface" || !target ||
      spec.destServerId === spec.sourceServerId) {
    throw new ApiError(422, "IPERF_TARGET", "مقصد باید شنوندهٔ ثبت‌شدهٔ یک تونل رابط‌دار باشد.");
  }

  const addresses = tunnelAddresses(tunnel, spec.sourceServerId, spec.destServerId);
  if (!addresses) {
    throw new ApiError(422, "IPERF_ADDRESS", "دو آدرس خصوصی هم‌خانواده و متمایز روی تونل لازم است.");
  }

  const recent = Math.max(90000, state.settings.monitoringIntervalSec * 3000);
  const now = Date.now();
  const ready = (at: string) => Number.isFinite(Date.parse(at)) && now - Date.parse(at) <= recent;
  if (tunnel.status === "offline" || !ready(tunnel.lastCheck) ||
      [spec.sourceServerId, spec.destServerId].some((key) => {
        const server = state.servers.find((item) => item.id === key);
        return !server || server.status === "offline" || server.agent.status !== "online" || !ready(server.agent.lastHeartbeat);
      })) {
    throw new ApiError(409, "IPERF_PREFLIGHT", "تونل و دو عامل باید گزارش تازه داشته باشند.");
  }
  return { ...addresses, port: target.port };
}

const date = (value: unknown) => typeof value === "number" ? new Date(value).toISOString() : undefined;
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function jobOf(row: Row): IperfJob {
  return {
    id: String(row.id), status: row.status as IperfJob["status"],
    config: JSON.parse(String(row.config)) as IperfConfig,
    createdAt: date(row.created_at)!, startedAt: date(row.started_at), finishedAt: date(row.finished_at),
    result: row.result ? JSON.parse(String(row.result)) as IperfResult : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
  };
}

function find(db: DatabaseSync, jobId: string) {
  const row = db.prepare("SELECT * FROM iperf_jobs WHERE id = ?").get(jobId);
  if (!row) throw new ApiError(404, "IPERF_UNKNOWN", "تست سرعت پیدا نشد.");
  return row;
}

function expire(db: DatabaseSync, now: number) {
  db.prepare(`
    UPDATE iperf_jobs
    SET status = 'failed', error = CASE WHEN status = 'queued' THEN 'queue_expired' ELSE 'lease_expired' END,
        finished_at = ?
    WHERE (status = 'queued' AND queue_until <= ?)
      OR (status IN ('running','cancel_requested') AND lease_until <= ?)
  `).run(now, now, now);
}

function recordAudit(db: DatabaseSync, actor: DemoUser, action: string, target: string) {
  const { state, revision } = readWorkspace(db);
  state.audit = [{
    id: randomUUID(), at: new Date().toISOString(), actor: actor.name, role: actor.role,
    action, target, detail: "درخواست عملیاتی iperf3", simulated: false,
  }, ...state.audit].slice(0, 2000);
  writeWorkspace(db, state, revision + 1);
}

export function listIperfJobs() {
  return transaction((db) => {
    expire(db, Date.now());
    return {
      enabled: iperfEnabled(),
      targets: iperfEnabled() ? targets().map(({ tunnelId, receiverServerId }) => ({ tunnelId, receiverServerId })) : [],
      jobs: db.prepare("SELECT * FROM iperf_jobs ORDER BY created_at DESC, id DESC LIMIT 40").all().map(jobOf),
    };
  });
}

export function enqueueIperf(actor: DemoUser, input: unknown, key: string) {
  checkEnabled();
  if (!can(actor.role, "speedtest.run")) throw new ApiError(403, "FORBIDDEN", "اجازهٔ اجرای تست را ندارید.");
  const spec = parse(config, input);
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  const fingerprint = digest(JSON.stringify(spec));
  return transaction((db) => {
    const now = Date.now();
    expire(db, now);
    const existing = db.prepare("SELECT * FROM iperf_jobs WHERE actor_id = ? AND request_key = ?").get(actor.id, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "این شناسه برای پارامتر دیگری ثبت شده است.");
      return { job: jobOf(existing), replay: true };
    }
    if (provisionBusy(db, spec.sourceServerId, spec.destServerId)) throw new ApiError(409, "IPERF_BUSY", "روی یکی از سرورها عملیات نصب فعال است.");
    const endpoint = preflight(readWorkspace(db).state, spec);
    const busy = db.prepare(`
      SELECT id FROM iperf_jobs WHERE status IN ('queued','running','cancel_requested')
      AND (source_id IN (?, ?) OR dest_id IN (?, ?)) LIMIT 1
    `).get(spec.sourceServerId, spec.destServerId, spec.sourceServerId, spec.destServerId);
    if (busy) throw new ApiError(409, "IPERF_BUSY", "روی یکی از دو سرور تست دیگری در جریان است.");
    const jobId = randomUUID();
    db.prepare(`
      INSERT INTO iperf_jobs (id, actor_id, request_key, fingerprint, source_id, dest_id, config, endpoint,
        status, created_at, queue_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(jobId, actor.id, key, fingerprint, spec.sourceServerId, spec.destServerId, JSON.stringify(spec),
      JSON.stringify(endpoint), now, now + 60000);
    recordAudit(db, actor, "iperf.enqueue", jobId);
    return { job: jobOf(find(db, jobId)), replay: false };
  });
}

export function cancelIperf(actor: DemoUser, inputId: string) {
  if (!can(actor.role, "speedtest.run")) throw new ApiError(403, "FORBIDDEN", "اجازهٔ توقف تست را ندارید.");
  const jobId = parse(uuid, inputId);
  return transaction((db) => {
    const now = Date.now();
    expire(db, now);
    const row = find(db, jobId);
    if (row.actor_id !== actor.id && actor.role !== "infra-admin" && actor.role !== "super-admin") {
      throw new ApiError(403, "FORBIDDEN", "فقط سازندهٔ تست یا مدیر می‌تواند آن را متوقف کند.");
    }
    if (row.status === "queued") db.prepare("UPDATE iperf_jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now, jobId);
    else if (row.status === "running") db.prepare("UPDATE iperf_jobs SET status = 'cancel_requested' WHERE id = ?").run(jobId);
    if (row.status === "queued" || row.status === "running") recordAudit(db, actor, "iperf.cancel", jobId);
    return jobOf(find(db, jobId));
  });
}

export function claimIperf(request: Request, input: unknown) {
  checkEnabled();
  const { serverId } = parse(z.object({ serverId: id }).strict(), input);
  return transaction((db) => {
    authorizeAgent(request, serverId, db);
    const now = Date.now();
    markWorkerPoll(db, serverId, "iperf", now);
    expire(db, now);
    const row = db.prepare("SELECT * FROM iperf_jobs WHERE source_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1").get(serverId);
    if (!row) return null;

    const job = jobOf(row);
    let endpoint: ReturnType<typeof preflight>;
    try {
      endpoint = preflight(readWorkspace(db).state, job.config);
      if (JSON.stringify(endpoint) !== row.endpoint) throw new ApiError(409, "IPERF_CHANGED", "مسیر تست تغییر کرده است.");
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      db.prepare("UPDATE iperf_jobs SET status = 'failed', error = 'preflight', finished_at = ? WHERE id = ?").run(now, job.id);
      return null;
    }

    const token = randomBytes(32).toString("hex");
    const leaseMs = (job.config.durationSec + 18) * 1000;
    db.prepare("UPDATE iperf_jobs SET status = 'running', started_at = ?, lease_until = ?, lease_digest = ? WHERE id = ?")
      .run(now, now + leaseMs, digest(token), job.id);
    return { id: job.id, lease: token, leaseMs, config: job.config, endpoint };
  });
}

function agentRow(db: DatabaseSync, request: Request, jobId: string, serverId: string, token: string) {
  authorizeAgent(request, serverId, db);
  const row = find(db, parse(uuid, jobId));
  if (row.source_id !== serverId || row.lease_digest !== digest(token)) {
    throw new ApiError(403, "IPERF_LEASE", "مجوز اجرا متعلق به این عامل نیست.");
  }
  return row;
}

export function iperfControl(request: Request, jobId: string, input: unknown) {
  const { serverId, lease: token } = parse(z.object({ serverId: id, lease }).strict(), input);
  return transaction((db) => {
    const row = agentRow(db, request, jobId, serverId, token);
    return { stop: !iperfEnabled() || row.status !== "running" || Number(row.lease_until) <= Date.now() };
  });
}

export function finishIperf(request: Request, jobId: string, input: unknown) {
  const body = parse(finishBody, input);
  return transaction((db) => {
    const row = agentRow(db, request, jobId, body.serverId, body.lease);
    const now = Date.now();
    const fingerprint = digest(JSON.stringify(body));
    if (row.finish_fingerprint === fingerprint) return { job: jobOf(row), replay: true };
    if (Number(row.lease_until) <= now || (row.status !== "running" && row.status !== "cancel_requested")) {
      throw new ApiError(409, "IPERF_TERMINAL", "مهلت اجرا پایان یافته یا نتیجه قبلاً ثبت شده است.");
    }
    if (body.outcome === "cancelled" && row.status === "running" && iperfEnabled()) {
      throw new ApiError(409, "IPERF_CANCEL", "توقف برای این تست ثبت نشده است.");
    }
    const spec = jobOf(row).config;
    if (body.outcome === "completed") {
      const measured = body.result;
      const includesUpload = spec.direction !== "download";
      const includesDownload = spec.direction !== "upload";
      const matches = (entry: { uploadMbps?: number; downloadMbps?: number }) =>
        (entry.uploadMbps !== undefined) === includesUpload && (entry.downloadMbps !== undefined) === includesDownload;
      if (!matches(measured) || measured.samples.some((entry, index, samples) =>
        !matches(entry) || entry.t > spec.durationSec + 5 || (index > 0 && entry.t <= samples[index - 1].t))) {
        throw new ApiError(422, "IPERF_RESULT", "نتیجه با جهت یا مدت تست منطبق نیست.");
      }
    }
    const status = row.status === "cancel_requested" ? "cancelled" : body.outcome;
    db.prepare(`
      UPDATE iperf_jobs SET status = ?, finished_at = ?, result = ?, error = ?, finish_fingerprint = ? WHERE id = ?
    `).run(status, now, status === "completed" && body.outcome === "completed" ? JSON.stringify(body.result) : null,
      status === "failed" && body.outcome === "failed" ? body.error : null, fingerprint, jobId);
    return { job: jobOf(find(db, jobId)), replay: false };
  });
}
