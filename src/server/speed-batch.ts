import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { summarizePings } from "@/lib/speed-report";
import { can } from "@/lib/rbac";
import type { DemoUser, SpeedBatch, SpeedBatchTarget } from "@/types";
import { authorizeAgent } from "./auth";
import { readWorkspace, transaction, writeWorkspace, type Workspace } from "./database";
import { ApiError } from "./http";
import { iperfTargetsForHost } from "./iperf-jobs";
import { workspaceMode } from "./inventory";

const id = z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i);
const iface = /^[a-z\d][a-z\d_.:-]{0,14}$/i;
const attempts = 10;
const limit = 8;
const leaseMs = 150_000;
const queueMs = 20 * 60_000;
const iperfSeconds = 8;
const iperfMbps = 100;
const resultError = z.enum(["ping_failed", "speedtest_missing", "bandwidth_failed", "iperf_missing", "timeout", "target"]);

type Probe = {
  id?: string;
  mode: "gre" | "internet";
  pingCount: number;
  peer?: string;
  interface?: string;
  bandwidth: "iperf" | "speedtest";
  iperf?: { sourceIp: string; peerIp: string; port: number; seconds: number; mbps: number };
};

function expire(db: DatabaseSync, now: number) {
  db.prepare(`
    UPDATE speed_batch_targets
    SET status = 'failed', error = 'timeout', finished_at = ?
    WHERE (status = 'queued' AND created_at <= ?)
      OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
  `).run(now, now - queueMs, now);
  for (const batch of db.prepare(`SELECT id FROM speed_batches WHERE status = 'running'`).all()) {
    settle(db, String(batch.id), now);
  }
}

function settle(db: DatabaseSync, batchId: string, now: number) {
  const pending = db.prepare(`SELECT 1 FROM speed_batch_targets WHERE batch_id = ? AND status IN ('queued','running') LIMIT 1`).get(batchId);
  if (!pending) db.prepare(`UPDATE speed_batches SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'`).run(now, batchId);
}

function storedPings(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = z.array(z.number().finite()).max(attempts).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function targetOf(row: Record<string, unknown>): SpeedBatchTarget {
  const samples = storedPings(row.pings);
  const ping = samples ? summarizePings(samples) ?? undefined : undefined;
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    label: String(row.label),
    status: row.status as SpeedBatchTarget["status"],
    samples: samples?.length ? samples : undefined,
    ping,
    avgMbps: typeof row.bandwidth_mbps === "number" ? row.bandwidth_mbps : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
  };
}

function batchOf(db: DatabaseSync, batchId: string, actorId: string): SpeedBatch {
  const batch = db.prepare(`SELECT * FROM speed_batches WHERE id = ? AND actor_id = ?`).get(batchId, actorId);
  if (!batch) throw new ApiError(404, "SPEED_BATCH_UNKNOWN", "تست تجمیعی پیدا نشد.");
  const targets = db.prepare(`SELECT * FROM speed_batch_targets WHERE batch_id = ? ORDER BY position, id`).all(batchId);
  return {
    id: String(batch.id),
    mode: batch.mode === "internet" ? "internet" : "gre",
    status: batch.status === "running" ? "running" : "completed",
    createdAt: new Date(Number(batch.created_at)).toISOString(),
    targets: targets.map((row) => targetOf(row)),
  };
}

function greTargets(state: Workspace, ids: string[]) {
  return ids.map((targetId) => {
    const tunnel = state.tunnels.find((item) => item.id === targetId);
    const face = tunnel?.iranEndpoint.interfaceName;
    const peer = tunnel?.foreignEndpoint.tunnelIp;
    if (!tunnel || tunnel.kind !== "interface" || (tunnel.technology !== "GRE" && tunnel.technology !== "GRE6")
        || !face || !iface.test(face) || !peer || !isIP(peer)) {
      throw new ApiError(422, "SPEED_BATCH_TARGET", "فقط تونل GRE با رابط و IP داخلی قابل تست است.");
    }
    const enrolled = iperfTargetsForHost(state, tunnel.iranEndpoint.serverId).find((item) => item.tunnelId === tunnel.id);
    const spec: Probe = enrolled
      ? {
          mode: "gre", pingCount: attempts, peer, interface: face, bandwidth: "iperf",
          iperf: { sourceIp: enrolled.sourceIp, peerIp: enrolled.peerIp, port: enrolled.port, seconds: iperfSeconds, mbps: iperfMbps },
        }
      : { mode: "gre", pingCount: attempts, peer, interface: face, bandwidth: "speedtest" };
    return { serverId: tunnel.iranEndpoint.serverId, targetId, label: tunnel.name.slice(0, 120), spec };
  });
}

function internetTargets(state: Workspace, ids: string[]) {
  return ids.map((targetId) => {
    const server = state.servers.find((item) => item.id === targetId);
    if (!server) throw new ApiError(422, "SPEED_BATCH_TARGET", "سرور انتخاب‌شده پیدا نشد.");
    const spec: Probe = { mode: "internet", pingCount: attempts, bandwidth: "speedtest" };
    return { serverId: server.id, targetId, label: server.name.slice(0, 120), spec };
  });
}

function recordAudit(db: DatabaseSync, actor: DemoUser, target: string) {
  const { state, revision } = readWorkspace(db);
  state.audit = [{
    id: randomUUID(), at: new Date().toISOString(), actor: actor.name, role: actor.role,
    action: "speedtest.batch", target, detail: "تست تجمیعی سرعت", simulated: false,
  }, ...state.audit].slice(0, 2000);
  writeWorkspace(db, state, revision + 1);
}

export function pendingSpeedBatches(serverId: string) {
  return transaction((db) => {
    const now = Date.now();
    expire(db, now);
    const running = db.prepare(`SELECT spec FROM speed_batch_targets WHERE server_id = ? AND status = 'running' LIMIT 1`).get(serverId);
    if (running && typeof running.spec === "string") return [JSON.parse(running.spec) as Probe];
    const next = db.prepare(`
      SELECT id, spec FROM speed_batch_targets
      WHERE server_id = ? AND status = 'queued'
      ORDER BY created_at, position, id LIMIT 1
    `).get(serverId);
    if (!next || typeof next.spec !== "string") return [];
    db.prepare(`UPDATE speed_batch_targets SET status = 'running', lease_until = ? WHERE id = ? AND status = 'queued'`)
      .run(now + leaseMs, next.id);
    return [JSON.parse(next.spec) as Probe];
  });
}

export function latestSpeedBatch(actor: DemoUser) {
  if (workspaceMode() !== "monitor") return null;
  return transaction((db) => {
    expire(db, Date.now());
    const row = db.prepare(`SELECT id FROM speed_batches WHERE actor_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(actor.id);
    return row ? batchOf(db, String(row.id), actor.id) : null;
  });
}

export function readSpeedBatch(actor: DemoUser, batchId: string) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "تست تجمیعی در حالت پایش در دسترس است.");
  const parsed = z.string().uuid().safeParse(batchId);
  if (!parsed.success) throw new ApiError(404, "SPEED_BATCH_UNKNOWN", "تست تجمیعی پیدا نشد.");
  return transaction((db) => {
    expire(db, Date.now());
    return batchOf(db, parsed.data, actor.id);
  });
}

export function startSpeedBatch(actor: DemoUser, input: unknown) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "تست تجمیعی در حالت پایش در دسترس است.");
  if (!can(actor.role, "speedtest.run")) throw new ApiError(403, "FORBIDDEN", "اجازهٔ اجرای تست را ندارید.");
  const body = z.object({ mode: z.enum(["gre", "internet"]), ids: z.array(id).min(1).max(limit) }).strict().safeParse(input);
  if (!body.success) throw new ApiError(422, "SPEED_BATCH_INPUT", "انتخاب تست تجمیعی معتبر نیست.");
  const ids = [...new Set(body.data.ids)];
  return transaction((db) => {
    const now = Date.now();
    expire(db, now);
    if (db.prepare(`SELECT id FROM speed_batches WHERE status = 'running' LIMIT 1`).get()) {
      throw new ApiError(409, "SPEED_BATCH_BUSY", "یک تست تجمیعی در حال اجراست.");
    }
    const { state } = readWorkspace(db);
    const targets = body.data.mode === "gre" ? greTargets(state, ids) : internetTargets(state, ids);
    const batchId = randomUUID();
    db.prepare(`INSERT INTO speed_batches (id, actor_id, mode, status, created_at) VALUES (?, ?, ?, 'running', ?)`)
      .run(batchId, actor.id, body.data.mode, now);
    const insert = db.prepare(`
      INSERT INTO speed_batch_targets
        (id, batch_id, server_id, target_id, label, status, spec, created_at, position)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `);
    for (const [position, target] of targets.entries()) {
      const rowId = randomUUID();
      insert.run(rowId, batchId, target.serverId, target.targetId, target.label, JSON.stringify({ ...target.spec, id: rowId }), now, position);
    }
    recordAudit(db, actor, batchId);
    return batchOf(db, batchId, actor.id);
  });
}

export function finishSpeedBatch(request: Request, input: unknown) {
  const value = z.object({
    id: z.string().uuid(),
    serverId: id,
    pingsMs: z.array(z.number().min(0).max(120000)).max(attempts),
    bandwidthMbps: z.number().min(0).max(100000).optional(),
    error: resultError.optional(),
  }).strict().safeParse(input);
  if (!value.success) throw new ApiError(422, "SPEED_BATCH_RESULT", "نتیجهٔ تست تجمیعی معتبر نیست.");
  const { id: probeId, serverId, pingsMs, bandwidthMbps, error } = value.data;
  return transaction((db) => {
    authorizeAgent(request, serverId, db);
    const now = Date.now();
    const row = db.prepare(`SELECT batch_id, status FROM speed_batch_targets WHERE id = ? AND server_id = ?`).get(probeId, serverId);
    if (!row) return false;
    if (row.status === "running") {
      const samples = pingsMs.slice(0, attempts);
      const failed = samples.length === 0;
      db.prepare(`
        UPDATE speed_batch_targets
        SET status = ?, pings = ?, bandwidth_mbps = ?, error = ?, finished_at = ?
        WHERE id = ? AND server_id = ? AND status = 'running'
      `).run(failed ? "failed" : "completed", JSON.stringify(samples), failed || bandwidthMbps === undefined ? null : bandwidthMbps,
        failed ? error ?? "ping_failed" : error ?? null, now, probeId, serverId);
      settle(db, String(row.batch_id), now);
      return true;
    }
    expire(db, now);
    const current = db.prepare(`SELECT status FROM speed_batch_targets WHERE id = ? AND server_id = ?`).get(probeId, serverId);
    return current?.status === "completed" || current?.status === "failed";
  });
}
