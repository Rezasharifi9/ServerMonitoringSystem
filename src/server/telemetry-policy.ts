import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { telemetryIntervals, telemetryStreams, type TelemetryStream } from "@/lib/telemetry-policy";
import type { AppSettings } from "@/types";
import { authorizeAgent, digest } from "./auth";
import { database, readWorkspace } from "./database";
import { ApiError } from "./http";
import { tunnelForwarding } from "./providers";
import { pendingSpeedBatches } from "./speed-batch";
import { pendingTunnelPings } from "./tunnel-ping";
import { tunnelBindings } from "./provision-catalog";
import { readForwarderSettings } from "./forwarder-settings";
import { nativeLogSecrets } from "@/lib/forwarder-config";

const settingsWaiters = new Map<string, () => void>();

export function notifyTelemetrySettings() {
  for (const wake of settingsWaiters.values()) wake();
}

export async function watchTelemetrySettings(request: Request, input: unknown) {
  const parsed = z.object({ serverId: z.string().min(1).max(96), version: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(input);
  if (!parsed.success) throw new ApiError(422, "VALIDATION", "نسخهٔ تنظیمات عامل معتبر نیست.");
  const { serverId, version } = parsed.data;
  const current = () => {
    const db = database();
    authorizeAgent(request, serverId, db);
    const { state } = readWorkspace(db);
    if (!state.servers.some((host) => host.id === serverId)) throw new ApiError(404, "SERVER_UNKNOWN", "سرور پیدا نشد.");
    const intervals = { ...telemetryIntervals, ...state.settings.telemetryIntervals };
    const heartbeatSec = Math.min(60, state.settings.monitoringIntervalSec);
    return digest(JSON.stringify({ intervals, heartbeatSec }));
  };
  const initial = current();
  if (version !== initial) return { version: initial };
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", done);
      if (settingsWaiters.get(serverId) === done) settingsWaiters.delete(serverId);
      resolve();
    };
    const timer = setTimeout(done, 20000);
    settingsWaiters.get(serverId)?.();
    settingsWaiters.set(serverId, done);
    request.signal.addEventListener("abort", done, { once: true });
    if (request.signal.aborted) done();
  });
  return { version: current() };
}

export function telemetryDue(db: DatabaseSync, serverId: string, settings: AppSettings, diskUsage = 0) {
  const previous = new Map(db.prepare("SELECT stream, observed_at FROM telemetry_cadence WHERE server_id=?")
    .all(serverId).map((row) => [String(row.stream), Number(row.observed_at)]));
  const intervals = { ...telemetryIntervals, ...settings.telemetryIntervals };
  if (diskUsage >= 85) intervals.disk = Math.min(intervals.disk, 300);
  return Object.fromEntries(telemetryStreams.map((stream) => [stream,
    previous.has(stream) ? previous.get(stream)! + intervals[stream] * 1000 : 0,
  ])) as Record<TelemetryStream, number>;
}

export function claimTelemetryStreams(db: DatabaseSync, serverId: string, settings: AppSettings, streams: TelemetryStream[], observedAt: number, diskUsage = 0) {
  const due = telemetryDue(db, serverId, settings, diskUsage);
  if (new Set(streams).size !== streams.length || streams.some((stream) => observedAt < due[stream])) {
    throw new ApiError(409, "TELEMETRY_CADENCE", "زمان همگام‌سازی یک یا چند سنجه هنوز نرسیده است.");
  }
  const update = db.prepare(`INSERT INTO telemetry_cadence VALUES (?,?,?)
    ON CONFLICT(server_id, stream) DO UPDATE SET observed_at=excluded.observed_at`);
  for (const stream of streams) update.run(serverId, stream, observedAt);
}

export function agentTelemetryPlan(request: Request, input: unknown) {
  const body = z.object({ serverId: z.string().min(1).max(96) }).strict().safeParse(input);
  if (!body.success) throw new ApiError(422, "VALIDATION", "شناسهٔ عامل معتبر نیست.");
  const { serverId } = body.data;
  const db = database();
  authorizeAgent(request, serverId, db);
  const { state } = readWorkspace(db);
  const host = state.servers.find((item) => item.id === serverId);
  if (!host) throw new ApiError(404, "SERVER_UNKNOWN", "سرور پیدا نشد.");
  const forwarding = tunnelForwarding(db, state.nodes);
  const owned = state.tunnels.filter((item) => item.iranEndpoint.serverId === serverId);
  const profiles = new Map(tunnelBindings(db).map((item) => [item.tunnelId, item.iranProfileId]));
  return {
    heartbeatSec: Math.min(60, state.settings.monitoringIntervalSec),
    due: telemetryDue(db, serverId, state.settings, host.disk),
    v2bxLogs: host.roles.includes("foreign"),
    pings: pendingTunnelPings(serverId),
    speedBatches: pendingSpeedBatches(serverId),
    forwarderUnits: owned.flatMap((item) => {
      if (item.kind !== "forwarder") return [];
      const profile = profiles.get(item.id);
      const unit = profile ? `nodeguard-${profile}.service` : item.serviceName;
      return unit ? [{ id: item.id, unit }] : [];
    }).slice(0, 12),
    nativeForwarders: owned.flatMap(item => {
      if (!["Rathole", "Backhaul"].includes(item.technology)) return [];
      const settings = readForwarderSettings(item.id);
      const profile = profiles.get(item.id);
      if (!settings || !profile) return [];
      return [{ id: item.id, unit: `nodeguard-${profile}.service`, controlPort: Number(settings.iran.options.bind_addr.split(":").at(-1)) }];
    }).slice(0, 12),
    nativeForwarderLogs: state.tunnels.flatMap(item => {
      if (!["Rathole", "Backhaul"].includes(item.technology)) return [];
      const binding = tunnelBindings(db).find(b => b.tunnelId === item.id);
      const profile = item.iranEndpoint.serverId === serverId ? binding?.iranProfileId : item.foreignEndpoint.serverId === serverId ? binding?.foreignProfileId : undefined;
      const settings = readForwarderSettings(item.id);
      const side = item.iranEndpoint.serverId === serverId ? "iran" : "foreign";
      return profile && settings ? [{ id: item.id, unit: `nodeguard-${profile}.service`, redact: nativeLogSecrets(settings[side].options) }] : [];
    }).slice(0, 12),
    tunnels: owned.flatMap((item) => item.kind === "interface" && item.iranEndpoint.interfaceName && item.foreignEndpoint.tunnelIp
      ? [{ id: item.id, interface: item.iranEndpoint.interfaceName, peer: item.foreignEndpoint.tunnelIp, mtu: item.configuredMtu ?? item.mtu }] : []).slice(0, 128),
    tcpForwards: owned.flatMap((item) => {
      if (item.technology !== "GOST") return [];
      const { port, targetPort, error } = forwarding(item);
      const listenHost = profiles.get(item.id)?.startsWith("nat-") ? item.iranEndpoint.publicIp : undefined;
      return port && !error ? [{ id: item.id, port, listenHost, target: item.foreignEndpoint.publicIp, targetPort: targetPort ?? port }] : [];
    }).slice(0, 12),
  };
}
