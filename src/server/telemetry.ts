import { z } from "zod";
import { decorateNodes } from "@/lib/health";
import { authorizeAgent, digest } from "./auth";
import { readWorkspace, transaction, writeWorkspace, writeTelemetryWorkspace } from "./database";
import { independentObservers, observersByNode, projectProxyObservations } from "./probe-observers";
import { workspaceMode } from "./inventory";
import { enqueueTelegramAlerts } from "./telegram";
import { updateAgentHeartbeatIncident, updateObservedIncidents, updateProxyIncident } from "./observed-incidents";
import { ApiError, jsonBody } from "./http";
import { storeMonitorLogs } from "./log-storage";
import { telemetryStreams } from "@/lib/telemetry-policy";
import { claimTelemetryStreams } from "./telemetry-policy";
import { evaluateMetricAlerts } from "./metric-alerts";
import { enqueueGmailAlerts } from "./gmail";
import { maintainTelemetryHistory } from "./telemetry-history";

const id = z.string().min(1).max(96).regex(/^[a-z\d][a-z\d_.:-]*$/i);
const percent = z.number().min(0).max(100);
const traffic = z.number().min(0).max(1000000);
const timestamp = z.string().datetime({ offset: true });
const severity = z.enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);
const report = z.object({
  serverId: id,
  reportId: z.string().uuid(),
  observedAt: timestamp,
  version: z.string().min(1).max(48),
  streams: z.array(z.enum(telemetryStreams)).max(telemetryStreams.length).optional(),
  cpu: percent.optional(),
  ram: percent.optional(),
  disk: percent.optional(),
  hardware: z.object({
    cpuCores: z.number().int().positive().max(100000),
    ramBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    diskBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict().optional(),
  diskIo: z.object({ readMiBps: traffic, writeMiBps: traffic }).strict().optional(),
  rxMbps: traffic.optional(),
  txMbps: traffic.optional(),
  serverPing: z.object({ rttMs: z.number().min(0).max(120000).nullable(), packetLoss: percent }).strict().optional(),
  uptimeSec: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  v2bx: z.enum(["running", "stopped", "degraded"]).optional(),
  tunnels: z.array(z.object({
    tunnelId: id, measuredAt: timestamp.optional(),
    status: z.enum(["healthy", "degraded", "offline"]),
    rttMs: z.number().min(0).max(120000),
    jitterMs: z.number().min(0).max(120000),
    packetLoss: percent,
    rxMbps: traffic.optional(),
    txMbps: traffic.optional(),
    mtu: z.number().int().min(576).max(9000),
  }).strict()).max(128).default([]),
  tunnelTraffic: z.array(z.object({ tunnelId: id, rxMbps: traffic, txMbps: traffic }).strict()).max(128).optional(),
  forwarderChecks: z.array(z.object({
    tunnelId: id, measuredAt: timestamp, ok: z.boolean(), elapsedMs: z.number().min(0).max(30000),
  }).strict()).max(12).default([]),
  proxyProbes: z.array(z.object({
    nodeId: id, side: z.enum(["active", "primary", "backup"]).optional(), ok: z.boolean(), elapsedMs: z.number().min(0).max(30000).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict()).max(12).default([]),
  logs: z.array(z.object({
    ts: timestamp,
    severity,
    source: z.enum(["agent", "tunnel", "v2bx-shared", "v2bx-node"]),
    nodeId: id.optional(),
    eventKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    message: z.string().min(1).max(2048),
  }).strict()).max(100).default([]),
}).strict();

function validateStreams(data: z.output<typeof report>) {
  const { streams, cpu, ram, disk, rxMbps, txMbps, serverPing, diskIo, hardware, v2bx, tunnels, tunnelTraffic, forwarderChecks, proxyProbes, logs } = data;
  if (!streams) return [cpu, ram, disk, rxMbps, txMbps].every((metric) => metric !== undefined) &&
    serverPing === undefined && tunnelTraffic === undefined && tunnels.every((item) => item.rxMbps !== undefined && item.txMbps !== undefined);
  const active = new Set(streams);
  return active.has("cpu") === (cpu !== undefined) && active.has("ram") === (ram !== undefined) &&
    active.has("disk") === (disk !== undefined) && active.has("traffic") === (rxMbps !== undefined && txMbps !== undefined) &&
    (rxMbps === undefined) === (txMbps === undefined) && (diskIo === undefined || active.has("disk")) &&
    (hardware === undefined || active.has("disk")) && (serverPing === undefined || active.has("serverPing")) &&
    (v2bx === undefined || active.has("service")) && (logs.length === 0 || active.has("logs") ||
      active.has("service") && logs.every((log) => ["ERROR", "CRITICAL"].includes(log.severity))) &&
    (proxyProbes.length === 0 || active.has("proxy")) && (tunnelTraffic === undefined || active.has("tunnelTraffic")) &&
    (tunnels.length + forwarderChecks.length === 0 || active.has("tunnelProbe")) &&
    tunnels.every((item) => item.rxMbps === undefined && item.txMbps === undefined);
}

export async function ingestTelemetry(request: Request) {
  const body = report.safeParse(await jsonBody(request, 256 * 1024));
  if (!body.success) throw new ApiError(422, "VALIDATION", "گزارش عامل معتبر نیست.", body.error.issues);
  if (!validateStreams(body.data)) throw new ApiError(422, "TELEMETRY_STREAMS", "سنجه‌ها با جریان‌های گزارش منطبق نیستند.");
  const { serverId, reportId, observedAt, version, streams, cpu, ram, disk, hardware, diskIo, rxMbps, txMbps, serverPing,
    uptimeSec, v2bx, tunnels, tunnelTraffic, forwarderChecks, logs, proxyProbes } = body.data;
  const observedMs = Date.parse(observedAt);
  const now = Date.now();

  return transaction((db) => {
    authorizeAgent(request, serverId, db);
    const { revision, state } = readWorkspace(db);
    const before = structuredClone(state);
    const server = state.servers.find((item) => item.id === serverId);
    if (!server) throw new ApiError(404, "SERVER_UNKNOWN", "سرور در فهرست ثبت نشده است.");
    const previous = db.prepare("SELECT fingerprint FROM agent_reports WHERE server_id = ? AND id = ?").get(serverId, reportId);
    const { forwarderChecks: newChecks, ...legacyReport } = body.data;
    const fingerprint = digest(JSON.stringify(newChecks.length ? body.data : legacyReport));
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ApiError(409, "REPORT_CONFLICT", "شناسهٔ گزارش قبلاً ثبت شده است.");
      return { revision, replay: true };
    }
    const latest = db.prepare("SELECT observed_at FROM agent_reports WHERE server_id = ? ORDER BY observed_at DESC LIMIT 1").get(serverId);
    if (observedMs > now + 30000 || observedMs < now - 5 * 60000 || (latest && Number(latest.observed_at) >= observedMs)) {
      throw new ApiError(409, "STALE_REPORT", "زمان مشاهده قدیمی، تکراری یا خارج از محدوده است.");
    }
    if (streams) claimTelemetryStreams(db, serverId, state.settings, streams, observedMs, server.disk);
    else if ((workspaceMode() === "monitor" && process.env.NODEGUARD_ALLOW_LEGACY_TELEMETRY !== "1") ||
      state.settings.telemetryIntervals || db.prepare("SELECT 1 FROM telemetry_cadence WHERE server_id=? LIMIT 1").get(serverId)) {
      throw new ApiError(409, "TELEMETRY_UPGRADE", "برای ارسال گزارش زمان‌بندی‌شده Agent را به‌روز کنید.");
    }
    const owned = new Map(state.tunnels.filter((item) => item.iranEndpoint.serverId === serverId).map((item) => [item.id, item.kind]));
    const retired = new Map(db.prepare("SELECT tunnel_id, kind FROM retired_tunnel_sources WHERE server_id=?")
      .all(serverId).map((row) => [String(row.tunnel_id), row.kind]));
    const observations = new Map(tunnels.map((item) => [item.tunnelId, item]));
    if (observations.size !== tunnels.length || tunnels.some(({ tunnelId }) => !owned.has(tunnelId) && !retired.has(tunnelId))) {
      throw new ApiError(422, "TUNNEL_OWNERSHIP", "فقط عامل مبدأ می‌تواند وضعیت تونل را ثبت کند.");
    }
    const forwards = new Map(forwarderChecks.map((item) => [item.tunnelId, item]));
    if (forwards.size !== forwarderChecks.length || forwarderChecks.some(({ tunnelId }) => observations.has(tunnelId) ||
        (owned.get(tunnelId) ?? retired.get(tunnelId)) !== "forwarder")) {
      throw new ApiError(422, "TUNNEL_OWNERSHIP", "عامل این سرویس هدایت پورت را مدیریت نمی‌کند.");
    }
    if ([...tunnels, ...forwarderChecks].some((entry) => entry.measuredAt &&
        (Date.parse(entry.measuredAt) > observedMs || Date.parse(entry.measuredAt) < observedMs - 300000))) {
      throw new ApiError(422, "PROBE_TIME", "زمان نمونه‌برداری تونل با گزارش منطبق نیست.");
    }
    for (const tunnelId of retired.keys()) {
      if (!owned.has(tunnelId)) {
        observations.delete(tunnelId);
        forwards.delete(tunnelId);
      }
    }
    const throughput = new Map(tunnelTraffic?.filter(({ tunnelId }) => owned.has(tunnelId)).map((item) => [item.tunnelId, item]));
    if (tunnelTraffic && throughput.size !== tunnelTraffic.length) throw new ApiError(422, "TUNNEL_OWNERSHIP", "نمونهٔ پهنای باند به این عامل تعلق ندارد.");
    for (const log of logs) {
      if (Date.parse(log.ts) > now + 30000 || (log.source === "v2bx-node"
        ? !state.nodes.some((n) => n.id === log.nodeId && n.foreignServerId === serverId)
        : log.nodeId !== undefined)) {
        throw new ApiError(422, "LOG_SCOPE", "زمان یا انتساب لاگ به نود معتبر نیست.");
      }
    }
    const activeProbes = new Map(proxyProbes.filter((probe) => !probe.side || probe.side === "active").map((probe) => [probe.nodeId, probe]));
    if (proxyProbes.length) {
      const authorized = observersByNode();
      const nodes = new Map(state.nodes.map((node) => [node.id, node]));
      const keys = new Set(proxyProbes.map((probe) => probe.nodeId + "/" + (probe.side ?? "active")));
      if (workspaceMode() !== "monitor" || keys.size !== proxyProbes.length || proxyProbes.some(({ nodeId, side }) => {
        const node = nodes.get(nodeId);
        return !node || (side === "backup" && !node.backupTunnelId) || !independentObservers(authorized, node).has(serverId);
      })) {
        throw new ApiError(422, "PROBE_SCOPE", "عامل برای کاوش مستقل این نود ثبت نشده است.");
      }
      state.nodes = state.nodes.map((node) => {
        const result = activeProbes.get(node.id);
        return result ? projectProxyObservations(node, independentObservers(authorized, node), {
          serverId, observedAt, ok: result.ok, elapsedMs: result.elapsedMs, httpStatus: result.httpStatus,
        }) : node;
      });
    }
    const services = v2bx === undefined ? server.services : server.services.some((service) => service.name === "v2bx")
      ? server.services.map((service) => service.name === "v2bx" ? { ...service, status: v2bx, observedAt } : service)
      : [...server.services, { id: `v2bx-${server.id}`, name: "v2bx", status: v2bx, version: "unknown", observedAt }];
    state.servers = state.servers.map((item) => item.id !== serverId ? item : {
      ...item, cpu: cpu ?? item.cpu, ram: ram ?? item.ram, disk: disk ?? item.disk, hardware: hardware ?? item.hardware,
      rxMbps: rxMbps ?? item.rxMbps, txMbps: txMbps ?? item.txMbps, uptimeSec, services,
      status: "healthy",
      agent: { ...item.agent, version, status: "online", lastHeartbeat: observedAt },
    });
    state.tunnels = state.tunnels.map((item) => {
      const rates = throughput.get(item.id);
      if (rates) item = { ...item, rxMbps: rates.rxMbps, txMbps: rates.txMbps };
      const forward = forwards.get(item.id);
      if (forward) return { ...item, status: forward.ok ? "healthy" as const : "offline" as const,
        forwarderProbe: { ok: forward.ok, elapsedMs: forward.elapsedMs }, lastCheck: forward.measuredAt };
      const reading = observations.get(item.id);
      if (!reading) return item;
      return {
        ...item, status: reading.status, rttMs: reading.rttMs, jitterMs: reading.jitterMs,
        packetLoss: reading.packetLoss, mtu: reading.mtu, rxMbps: reading.rxMbps ?? item.rxMbps,
        txMbps: reading.txMbps ?? item.txMbps, lastCheck: reading.measuredAt ?? observedAt,
      };
    });
    if (workspaceMode() === "monitor") {
      const host = state.servers.find((item) => item.id === serverId)!;
      const previousAlerts = state.alerts;
      updateAgentHeartbeatIncident(state, host, now, "recover");
      updateObservedIncidents(state, host, state.tunnels.filter((item) => observations.has(item.id) || forwards.has(item.id)), v2bx !== undefined, observedAt);
      for (const node of state.nodes) {
        if (activeProbes.has(node.id)) updateProxyIncident(state, node, now);
      }
      evaluateMetricAlerts(db, state, host, observedAt, { cpu, ram, disk, serverRtt: serverPing?.rttMs, serverLoss: serverPing?.packetLoss },
        new Map([...observations].map(([key, sample]) => [key, {
          tunnelRtt: sample.packetLoss < 100 ? sample.rttMs : null, tunnelLoss: sample.packetLoss,
          jitter: sample.packetLoss < 100 ? sample.jitterMs : null,
        }])));
      const known = new Set(previousAlerts.map((alert) => alert.id));
      const newAlerts = state.alerts.filter((alert) => !known.has(alert.id));
      enqueueTelegramAlerts(db, state, newAlerts);
      enqueueGmailAlerts(db, state, newAlerts);
    }
    state.nodes = decorateNodes(state.nodes, state.servers, state.tunnels, state.dns, state.settings, workspaceMode() === "monitor");
    const retainedSince = now - state.settings.dataRetentionDays * 86400000;
    const entries = logs.map(({ eventKey, ...entry }, index) => ({
      ...entry, id: `${serverId}/${eventKey ?? reportId + "/" + index}`, serverId,
    }));
    if (workspaceMode() === "monitor") {
      storeMonitorLogs(db, entries.filter((entry) => Date.parse(entry.ts) >= retainedSince &&
        (server.roles.includes("foreign") || (entry.source !== "v2bx-shared" && entry.source !== "v2bx-node"))));
    } else {
      state.logs = [...state.logs, ...entries]
        .filter((entry) => Date.parse(entry.ts) >= retainedSince)
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
        .slice(-5000);
    }
    db.prepare("INSERT INTO agent_reports VALUES (?, ?, ?, ?, ?)").run(
      serverId, reportId, observedMs, fingerprint, JSON.stringify({ observedAt, cpu, ram, disk, diskIo, rxMbps, txMbps, v2bx, serverPing, tunnelTraffic,
        tunnels: [...observations.values()], forwarderChecks: [...forwards.values()], proxyProbes }),
    );
    maintainTelemetryHistory(db, state.settings.dataRetentionDays, now);
    if (workspaceMode() === "monitor") writeTelemetryWorkspace(db, before, state, revision + 1);
    else writeWorkspace(db, state, revision + 1);
    return { revision: revision + 1, replay: false };
  });
}
