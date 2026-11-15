import { createStore } from "zustand/vanilla";
import { z } from "zod";
import { decorateNodes } from "@/lib/health";
import { can, type AppAction } from "@/lib/rbac";
import { createInfraWorkflows, type InfraState } from "@/stores/infra-workflows";
import { auditOf } from "@/stores/runtime";
import type { DemoUser } from "@/types";
import { digest } from "./auth";
import { readWorkspace, transaction, writeWorkspace, type Workspace } from "./database";
import { projectSpeedtest, settleSpeedtest } from "./speedtest";
import { monitorDomain, monitoredDns, workspaceMode } from "./inventory";
import { ApiError } from "./http";
import { telemetryStreams, type TelemetryIntervals } from "@/lib/telemetry-policy";
import { tunnelAlertMetric } from "@/lib/alert-rules";

const id = z.string().min(1).max(280).regex(/^[a-z\d][a-z\d_.:-]*$/i);
const text = z.string().max(512);
const percent = z.number().min(0).max(100);
const port = z.number().int().min(1).max(65535);
const mtu = z.number().int().min(576).max(9000);
const side = z.enum(["primary", "backup"]);
const scenario = z.enum(["primary-failure", "tunnel-failure", "v2bx-failure", "dns-mismatch", "backup-unavailable", "validation-failed", "auto-recovery", "manual"]);
const tech = z.enum(["GRE", "IPIP", "SIT", "WireGuard", "GOST", "Backhaul", "Rathole", "GRE6", "Geneve"]);
const policy = z.object({
  trigger: z.enum(["independent", "server-ping", "packet-loss", "tunnel-ping", "tunnel-loss"]).optional(),
  packetLossThreshold: z.number().min(1).max(100).optional(),
  notifyTelegram: z.boolean().optional(),
  intervalSec: z.number().int().min(5).max(86400),
  failureThreshold: z.number().int().min(1).max(100),
  probeTimeoutMs: z.number().int().min(100).max(120000),
  minConfirmations: z.number().int().min(1).max(100),
  autoEnabled: z.boolean(),
  manualApproval: z.boolean(),
  cooldownSec: z.number().int().min(0).max(604800),
  backupPriority: z.enum(["latency", "capacity", "manual"]),
  minBackupCapacity: percent,
  autoFailback: z.boolean(),
  stabilitySec: z.number().int().min(0).max(604800),
  dnsStrategy: z.enum(["lowest-ttl", "weighted", "manual-preview"]),
  rollbackStrategy: z.enum(["restore-primary-dns", "keep-backup", "freeze"]),
}).strict();
const settings = z.object({
  metricAlertRules: z.array(z.object({ id, name: z.string().trim().min(1).max(96), targetId: id,
    metric: z.enum(["disk", "cpu", "ram", "serverRtt", "serverLoss", "tunnelRtt", "tunnelLoss", "jitter"]),
    operator: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]), threshold: z.number().min(0).max(120000),
    cooldownMinutes: z.number().int().min(1).max(10080), enabled: z.boolean(), severity: z.enum(["info", "warning", "critical"]).optional(),
  }).strict()).max(100).refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length &&
    rules.every(({ metric, threshold }) => !["disk", "cpu", "ram", "serverLoss", "tunnelLoss"].includes(metric) || threshold <= 100)),
  telemetryIntervals: z.record(z.enum(telemetryStreams), z.number().int().min(5).max(86400))
    .refine((value) => telemetryStreams.every((stream) => value[stream] !== undefined)).transform((value) => value as TelemetryIntervals),
  orgName: text.min(1),
  monitoringIntervalSec: z.number().int().min(5).max(86400),
  dataRetentionDays: z.number().int().min(1).max(365),
  thresholds: z.object({ rttMs: z.number().min(1).max(120000), lossPct: percent, cpu: percent, ram: percent, disk: percent }).strict(),
  failover: policy,
  notifications: z.object({
    telegram: z.boolean(),
    email: z.boolean(),
    webhook: z.boolean(),
    telegramChat: text,
    emailTo: text,
    webhookUrl: text,
    onSeverity: z.enum(["info", "warning", "critical"]),
  }).strict(),
}).partial().strict();
const speedtest = z.object({
  mode: z.enum(["tunnel", "internet"]),
  sourceServerId: id,
  destServerId: id.optional(),
  tunnelId: id.optional(),
  protocol: z.enum(["tcp", "udp"]),
  direction: z.enum(["download", "upload", "bidirectional"]),
  reverse: z.boolean(),
  durationSec: z.number().int().min(1).max(120),
  streams: z.number().int().min(1).max(16),
  bandwidthLimitMbps: z.number().min(0).max(10000).optional(),
  nodeId: id.optional(),
}).strict();
const domain = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i);
const deployment = z.object({
  serverId: id,
  component: z.enum(["NodeGuard Agent", "V2bX", "GOST", "Backhaul", "Rathole", "GRE", "IPIP", "WireGuard", "BBR"]),
  options: z.object({ port: z.string().regex(/^\d{0,5}$/).refine((p) => !p || port.safeParse(Number(p)).success).optional(), forceConflict: z.enum(["yes", "no"]).optional() }).strict(),
  outcome: z.enum(["success", "fail", "rollback"]),
}).strict();

function exists<T>(value: T | undefined): T {
  if (value === undefined) throw new ApiError(404, "NOT_FOUND", "مورد انتخاب‌شده پیدا نشد.");
  return value;
}

function node(s: InfraState, key: string) { return exists(s.nodes.find((item) => item.id === key)); }
function server(s: InfraState, key: string) { return exists(s.servers.find((item) => item.id === key)); }
function tunnel(s: InfraState, key: string) { return exists(s.tunnels.find((item) => item.id === key)); }
function incident(s: InfraState, key: string) { return exists(s.incidents.find((item) => item.id === key)); }
function integration(s: InfraState, key: string) { return exists(s.integrations.find((item) => item.id === key)); }

function action<S extends z.ZodTypeAny>(
  permission: AppAction,
  schema: S,
  run: (state: InfraState, args: z.output<S>) => string | null | void | Promise<string | null | void>,
) {
  return (actor: DemoUser, state: InfraState, args: unknown) => {
    if (!can(actor.role, permission)) throw new ApiError(403, "FORBIDDEN", "نقش شما اجازهٔ انجام این عملیات را ندارد.");
    const parsed = schema.safeParse(args);
    if (!parsed.success) throw new ApiError(422, "VALIDATION", "ورودی عملیات معتبر نیست.", parsed.error.issues);
    return run(state, parsed.data);
  };
}

const commands = {
  updateSettings: action("settings.edit", z.tuple([settings]), (s, [patch]) => {
    for (const rule of patch.metricAlertRules ?? []) {
      const targets = tunnelAlertMetric(rule.metric) ? s.tunnels : s.servers;
      if (rule.enabled && rule.targetId !== "all" && !targets.some((target) => target.id === rule.targetId)) throw new ApiError(422, "ALERT_TARGET", "مقصد هشدار پیدا نشد.");
    }
    return s.updateSettings(patch);
  }),
  applyFailoverDefaults: action("failover.configure", z.tuple([]), (s) => s.applyFailoverDefaults()),
  updatePolicy: action("failover.configure", z.tuple([id, policy.partial()]), (s, [key, patch]) => {
    exists(s.policies.find((p) => p.nodeId === key));
    if (workspaceMode() === "monitor" && (patch.autoEnabled || patch.autoFailback) && !node(s, key).backupTunnelId) {
      throw new ApiError(409, "BACKUP_ROUTE_REQUIRED", "برای فعال‌سازی Failover خودکار ابتدا مسیر پشتیبان را ثبت کنید.");
    }
    return s.updatePolicy(key, patch);
  }),
  updateNodeSettings: action("node.edit", z.tuple([id, z.object({
    remark: text, rateLimitMbps: z.number().min(0).max(100000), probeEnabled: z.boolean(),
    alertOnLoss: z.boolean(), name: text.min(1), domain, port,
  }).partial().strict()]), (s, [key, patch]) => {
    node(s, key);
    if (workspaceMode() === "monitor" && patch.domain) {
      const normalized = patch.domain.toLowerCase();
      if (!monitorDomain.safeParse(normalized).success || s.nodes.some((item) => item.id !== key && item.domain.toLowerCase() === normalized)) {
        throw new ApiError(409, "NODE_DOMAIN", "دامنهٔ پایش معتبر نیست یا به نود دیگری تعلق دارد.");
      }
      return s.updateNodeSettings(key, { ...patch, domain: normalized });
    }
    return s.updateNodeSettings(key, patch);
  }),
  refreshMetrics: action("server.configure", z.tuple([]), (s) => s.refreshMetrics()),
  restartService: action("server.restart", z.tuple([id, id]), (s, [key, name]) => {
    exists(server(s, key).services.find((service) => service.name === name));
    return s.restartService(key, name);
  }),
  updateServerNotes: action("server.configure", z.tuple([id, z.string().max(4096)]), (s, [key, note]) => {
    server(s, key);
    return s.updateServerNotes(key, note);
  }),
  tunnelAction: action("tunnel.mutate", z.tuple([id, z.enum(["start", "stop", "restart"])]), (s, [key, command]) => {
    tunnel(s, key);
    return s.tunnelAction(key, command);
  }),
  deleteTunnel: action("tunnel.delete", z.tuple([id]), (s, [key]) => {
    tunnel(s, key);
    return s.deleteTunnel(key);
  }),
  reconfigureTunnel: action("tunnel.mutate", z.tuple([id, mtu]), (s, [key, size]) => {
    tunnel(s, key);
    return s.reconfigureTunnel(key, size);
  }),
  createTunnel: action("tunnel.create", z.tuple([z.object({
    technology: tech, iranServerId: id, foreignServerId: id, mtu, port: port.max(65534).optional(),
    outcome: z.enum(["success", "fail"]),
  }).strict()]), (s, [input]) => {
    const iran = server(s, input.iranServerId);
    const foreign = server(s, input.foreignServerId);
    if (iran.id === foreign.id || !iran.roles.some((role) => role === "iran" || role === "iran-primary" || role === "iran-backup") || !foreign.roles.includes("foreign")) {
      throw new ApiError(422, "ENDPOINT_ROLE", "نقش سرورهای ابتدا و انتهای تونل معتبر نیست.");
    }
    return s.createTunnel(input);
  }),
  checkDns: action("dns.check", z.tuple([id]), (s, [key]) => {
    exists(s.dns.find((record) => record.nodeId === key));
    return s.checkDns(key);
  }),
  simulateDnsSwitch: action("dns.switch", z.tuple([id, side]), (s, [key, target]) => {
    exists(s.dns.find((record) => record.nodeId === key));
    return s.simulateDnsSwitch(key, target);
  }),
  acknowledgeIncident: action("alert.manage", z.tuple([id]), (s, [key]) => {
    if (incident(s, key).status === "resolved") throw new ApiError(409, "INCIDENT_RESOLVED", "حادثه قبلاً بسته شده است.");
    return s.acknowledgeIncident(key);
  }),
  resolveIncident: action("alert.manage", z.tuple([id]), (s, [key]) => {
    if (incident(s, key).status !== "resolved") return s.resolveIncident(key);
  }),
  assignIncident: action("alert.manage", z.tuple([id, text.min(1)]), (s, [key, assignee]) => {
    incident(s, key);
    return s.assignIncident(key, assignee);
  }),
  silenceAlert: action("alert.manage", z.tuple([id, z.number().int().min(1).max(10080)]), (s, [key, minutes]) => {
    exists(s.alerts.find((item) => item.id === key));
    return s.silenceAlert(key, minutes);
  }),
  archiveAlert: action("alert.manage", z.tuple([id]), (s, [key]) => {
    exists(s.alerts.find((item) => item.id === key));
    return s.archiveAlert(key);
  }),
  restoreAlert: action("alert.manage", z.tuple([id]), (s, [key]) => {
    exists(s.alerts.find((item) => item.id === key));
    return s.restoreAlert(key);
  }),
  testNotification: action("settings.edit", z.tuple([z.enum(["telegram", "email", "webhook"])]), (s, [channel]) => s.testNotification(channel)),
  testIntegration: action("integration.edit", z.tuple([id]), (s, [key]) => { integration(s, key); return s.testIntegration(key); }),
  syncIntegration: action("integration.edit", z.tuple([id]), (s, [key]) => { integration(s, key); return s.syncIntegration(key); }),
  updateIntegration: action("integration.edit", z.tuple([id, z.object({
    panelUrl: text.optional(), securePath: text.optional(), zone: text.optional(),
  }).strict()]), (s, [key, config]) => {
    integration(s, key);
    const fields = Object.fromEntries(Object.entries(config).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return s.updateIntegration(key, fields);
  }),
  startSpeedtest: action("speedtest.run", z.tuple([speedtest]), (s, [config]) => {
    server(s, config.sourceServerId);
    if (config.nodeId) node(s, config.nodeId);
    if (config.mode === "tunnel") {
      const link = tunnel(s, config.tunnelId ?? "");
      const endpoints = [link.iranEndpoint.serverId, link.foreignEndpoint.serverId];
      if (!config.destServerId || config.destServerId === config.sourceServerId || !endpoints.includes(config.sourceServerId) || !endpoints.includes(config.destServerId)) {
        throw new ApiError(422, "SPEEDTEST_ENDPOINTS", "مبدأ و مقصد باید دو سر تونل انتخاب‌شده باشند.");
      }
    }
    return s.startSpeedtest(config);
  }),
  stopSpeedtest: action("speedtest.run", z.tuple([]), (s) => {
    if (!s.speedtestRun?.running) throw new ApiError(409, "TEST_NOT_RUNNING", "تست فعالی وجود ندارد.");
    return s.stopSpeedtest();
  }),
  simulateFailover: action("failover.run", z.tuple([id, scenario]), (s, [key, which]) => s.simulateFailover(key, which)),
  rollbackFailover: action("failover.run", z.tuple([id]), (s, [key]) => s.rollbackFailover(key)),
  createDeployment: action("deploy.run", z.tuple([deployment]), (s, [input]) => { server(s, input.serverId); return s.createDeployment(input); }),
  rollbackDeployment: action("deploy.run", z.tuple([id]), (s, [key]) => {
    const job = exists(s.deployments.find((item) => item.id === key));
    if (job.status !== "completed") throw new ApiError(409, "DEPLOYMENT_STATE", "فقط استقرار کامل‌شده قابل بازگشت است.");
    return s.rollbackDeployment(key);
  }),
};

const monitorActions = new Set(["updateSettings", "updatePolicy", "applyFailoverDefaults", "updateNodeSettings", "updateServerNotes", "acknowledgeIncident", "resolveIncident", "assignIncident", "silenceAlert", "archiveAlert", "restoreAlert"]);

const envelope = z.object({ action: id, args: z.array(z.unknown()).max(4) }).strict();

async function simulate(state: Workspace, actor: DemoUser, input: z.infer<typeof envelope>, command: typeof commands[keyof typeof commands]) {
  const scheduled: Promise<void>[] = [];
  const intervals = new Map<number, () => void>();
  let timerId = 0;
  const store = createStore(createInfraWorkflows(state, {
    pause: async () => {},
    interval: (fn) => { intervals.set(++timerId, fn); return timerId; },
    cancelInterval: (timer) => { intervals.delete(timer); },
    later: (fn) => { scheduled.push(Promise.resolve().then(fn)); },
    track: (task) => { scheduled.push(task); },
  }));
  store.setState({ currentUserId: actor.id, failoverRun: state.failoverRun, speedtestRun: projectSpeedtest(state).speedtestRun });
  const error = await command(actor, store.getState(), input.args);
  if (typeof error === "string") throw new ApiError(409, "WORKFLOW_REJECTED", error);
  await Promise.all(scheduled);
  // A demo speed test produces at most 240 samples. No task or network process is started here.
  for (let tick = 0; intervals.size && tick < 240; tick += 1) {
    for (const fn of intervals.values()) fn();
  }
  if (intervals.size) throw new Error("Unfinished simulation");

  const next = store.getState();
  const snapshot = { ...state };
  const copy = <K extends keyof InfraState & keyof Workspace>(key: K) => { snapshot[key] = next[key]; };
  for (const key of Object.keys(state) as (keyof Workspace)[]) {
    if (key !== "pendingSpeedtest") copy(key);
  }
  if (input.action === "startSpeedtest" && next.speedtestRun && next.speedtests[0]) {
    const run = next.speedtestRun;
    const result = next.speedtests[0];
    snapshot.speedtests = state.speedtests;
    snapshot.pendingSpeedtest = {
      result: { ...result, createdAt: new Date(Date.parse(run.startedAt) + result.durationSec * 1000).toISOString() },
      actor: actor.id,
    };
    snapshot.speedtestRun = { ...run, running: true, elapsedSec: 0, samples: [], currentMbps: 0 };
    snapshot.audit = [auditOf(next, "speedtest.start", result.mode, "تست نمایشی شروع شد."), ...state.audit];
  }
  if (input.action === "stopSpeedtest") snapshot.pendingSpeedtest = null;
  if (snapshot.audit[0]?.id === state.audit[0]?.id) {
    snapshot.audit = [auditOf(next, input.action, String(input.args[0] ?? "workspace").slice(0, 96), "عملیات از API ثبت شد."), ...snapshot.audit];
  }
  if (workspaceMode() === "monitor") {
    if (input.action === "applyFailoverDefaults") {
      const withoutBackup = new Set(state.nodes.filter((item) => !item.backupTunnelId).map((item) => item.id));
      snapshot.policies = snapshot.policies.map((item) => withoutBackup.has(item.nodeId)
        ? { ...item, autoEnabled: false, autoFailback: false } : item);
    }
    if (input.action === "updateNodeSettings") {
      const before = state.nodes.find((item) => item.id === input.args[0]);
      const after = snapshot.nodes.find((item) => item.id === input.args[0]);
      if (before && after && before.domain !== after.domain) {
        snapshot.dns = snapshot.dns.map((record) => {
          if (record.nodeId !== after.id) return record;
          const observed = state.dns.find((item) => item.nodeId === after.id);
          return { ...monitoredDns(after, observed?.v2boardHost ?? before.domain), id: record.id };
        });
        snapshot.nodes = decorateNodes(snapshot.nodes, snapshot.servers, snapshot.tunnels, snapshot.dns, snapshot.settings, true);
      }
    }
    snapshot.audit = snapshot.audit.map((entry, index) => index === 0 ? { ...entry, simulated: false } : entry);
  }
  snapshot.audit = snapshot.audit.slice(0, 2000);
  return snapshot;
}

export async function execute(actor: DemoUser, body: unknown, key: string) {
  const input = envelope.safeParse(body);
  if (!input.success) throw new ApiError(422, "VALIDATION", "ساختار عملیات معتبر نیست.", input.error.issues);
  if (!Object.hasOwn(commands, input.data.action)) throw new ApiError(404, "UNKNOWN_ACTION", "عملیات شناخته نشد.");
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  if (workspaceMode() === "monitor" && !monitorActions.has(input.data.action)) {
    throw new ApiError(409, "MONITOR_ONLY", "در محیط پایش، عملیات شبیه‌سازی روی دادهٔ عملیاتی مجاز نیست.");
  }
  const command = commands[input.data.action as keyof typeof commands];
  const fingerprint = digest(JSON.stringify(input.data));
  const receipt = (db: Parameters<typeof readWorkspace>[0]) => db?.prepare(
    "SELECT fingerprint FROM action_receipts WHERE actor = ? AND key = ?",
  ).get(actor.id, key);
  const replayed = (existing: ReturnType<typeof receipt>) => {
    if (existing && existing.fingerprint !== fingerprint) {
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "این شناسه برای درخواست دیگری استفاده شده است.");
    }
    return Boolean(existing);
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = transaction((db) => ({ ...settleSpeedtest(db), replay: replayed(receipt(db)) }));
    if (current.replay) return current;
    const snapshot = await simulate(current.state, actor, input.data, command);
    const result = transaction((db) => {
      const latest = readWorkspace(db);
      if (replayed(receipt(db))) return { ...latest, replay: true };
      if (latest.revision !== current.revision) return null;
      if (workspaceMode() === "monitor" && input.data.action === "updateNodeSettings") {
        const before = latest.state.nodes.find((item) => item.id === input.data.args[0]);
        const after = snapshot.nodes.find((item) => item.id === input.data.args[0]);
        if (before && after && (before.domain !== after.domain || before.port !== after.port) &&
            db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id=? AND expires_at>?").get(before.foreignServerId, Date.now())) {
          throw new ApiError(409, "NODE_ROUTES_BUSY", "ابتدا عملیات فعال روی مسیر نود را پایان دهید.");
        }
        if (before && after && (before.domain !== after.domain || before.port !== after.port) &&
            db.prepare(`
              SELECT 1 FROM failover_executions e JOIN failover_plans p ON p.id=e.plan_id
              WHERE p.node_id=? AND e.status IN ('applying','verifying','rolling_back','review')
            `).get(before.id)) {
          throw new ApiError(409, "FAILOVER_DOMAIN_BUSY", "ابتدا اجرای تغییر مسیر این نود را پایان دهید.");
        }
      }
      const revision = current.revision + 1;
      writeWorkspace(db, snapshot, revision);
      db.prepare("INSERT INTO action_receipts VALUES (?, ?, ?, ?, ?)").run(actor.id, key, fingerprint, revision, Date.now());
      db.prepare("DELETE FROM action_receipts WHERE created_at < ?").run(Date.now() - 7 * 86400 * 1000);
      return { revision, state: snapshot, replay: false };
    });
    if (result) {
      if (!result.replay && input.data.action === "updateSettings" && workspaceMode() === "monitor") {
        const { notifyTelemetrySettings } = await import("./telemetry-policy");
        notifyTelemetrySettings();
      }
      return result;
    }
  }
  throw new ApiError(409, "REVISION_CONFLICT", "داده هم‌زمان تغییر کرد. دوباره تلاش کنید.");
}
