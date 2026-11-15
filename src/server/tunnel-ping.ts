import { randomUUID } from "node:crypto";
import { z } from "zod";
import { can } from "@/lib/rbac";
import type { DemoUser } from "@/types";
import { authorizeAgent } from "./auth";
import { database, readWorkspace, transaction } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";

const duration = 60000;
const measurement = z.object({ rttMs: z.number().min(0).max(120000).nullable(), jitterMs: z.number().min(0).max(120000).nullable(),
  packetLoss: z.number().min(0).max(100) }).strict();

export function tunnelPing(actor: DemoUser, tunnelId: string, start: boolean) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "کاوش در حالت پایش در دسترس است.");
  if (start && !can(actor.role, "dns.check")) throw new ApiError(403, "FORBIDDEN", "دسترسی اجرای کاوش لازم است.");
  return transaction((db) => {
    const tunnel = readWorkspace(db).state.tunnels.find(({ id }) => id === tunnelId);
    if (!tunnel || tunnel.kind !== "interface" || !tunnel.iranEndpoint.interfaceName || !tunnel.foreignEndpoint.tunnelIp) {
      throw new ApiError(422, "TUNNEL_PING_TARGET", "رابط مبدأ و IP داخلی مقصد را ثبت کنید.");
    }
    const now = Date.now();
    let row = db.prepare("SELECT * FROM tunnel_probe_requests WHERE tunnel_id=?").get(tunnelId);
    if (start && (!row || Number(row.requested_at) <= now - (row.result ? 10000 : duration))) {
      db.prepare("INSERT OR REPLACE INTO tunnel_probe_requests VALUES (?,?,?,?,NULL)")
        .run(tunnelId, randomUUID(), tunnel.iranEndpoint.serverId, now);
      row = db.prepare("SELECT * FROM tunnel_probe_requests WHERE tunnel_id=?").get(tunnelId);
    }
    if (!row) return null;
    return { id: String(row.id), status: row.result ? "complete" : Number(row.requested_at) <= now - duration ? "expired" : "pending",
      result: row.result ? measurement.nullable().parse(JSON.parse(String(row.result))) : null };
  });
}

export function pendingTunnelPings(serverId: string) {
  return database().prepare("SELECT id, tunnel_id AS tunnelId FROM tunnel_probe_requests WHERE server_id=? AND result IS NULL AND requested_at>? LIMIT 6")
    .all(serverId, Date.now() - duration).map((row) => ({ id: String(row.id), tunnelId: String(row.tunnelId) }));
}

export function finishTunnelPing(request: Request, input: unknown) {
  const value = z.object({ id: z.string().uuid(), serverId: z.string().min(1).max(96), result: measurement.nullable() }).strict().safeParse(input);
  if (!value.success) throw new ApiError(422, "TUNNEL_PING_RESULT", "نتیجهٔ پینگ معتبر نیست.");
  const { id, serverId, result } = value.data;
  return transaction((db) => {
    authorizeAgent(request, serverId, db);
    return Boolean(db.prepare("UPDATE tunnel_probe_requests SET result=? WHERE id=? AND server_id=? AND result IS NULL AND requested_at>?")
      .run(JSON.stringify(result), id, serverId, Date.now() - duration).changes);
  });
}
