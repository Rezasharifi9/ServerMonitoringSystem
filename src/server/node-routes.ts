import { z } from "zod";
import { can } from "@/lib/rbac";
import { decorateNodes } from "@/lib/health";
import type { DemoUser } from "@/types";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { syncPrimaryTunnelDns } from "./managed-dns";
import { withHosts } from "./ssh-provision";
import { provisionBusy } from "./provision";
import { pushAudit } from "./activity-log";
import { currentNodeDomain, panelTunnelHost } from "./providers";
import { workspaceMode } from "./inventory";

const input = z.object({ primaryTunnelId: z.string(), backupTunnelId: z.string().optional(), activeSide: z.enum(["primary", "backup"]) }).strict();

export async function selectNodeRoutes(actor: DemoUser, nodeId: string, value: unknown) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "انتخاب مسیر عملیاتی در حالت پایش در دسترس است.");
  if (!can(actor.role, "node.edit") || !can(actor.role, "failover.run") || !can(actor.role, "dns.switch")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی انتخاب مسیر و تغییر DNS لازم است.");
  }
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "NODE_ROUTES_INPUT", "مسیرهای منتخب معتبر نیستند.");
  const selection = parsed.data;
  const original = readWorkspace().state.nodes.find((node) => node.id === nodeId);
  if (!original) throw new ApiError(404, "NODE_UNKNOWN", "نود پیدا نشد.");
  const state = readWorkspace().state;
  const candidates = state.tunnels.filter((tunnel) => original.tunnelIds?.includes(tunnel.id) || tunnel.nodeIds.includes(nodeId));
  const primary = candidates.find((tunnel) => tunnel.id === selection.primaryTunnelId);
  const backup = candidates.find((tunnel) => tunnel.id === selection.backupTunnelId);
  if (!primary || primary.foreignEndpoint.serverId !== original.foreignServerId ||
      selection.backupTunnelId && (!backup || backup.id === primary.id || backup.foreignEndpoint.serverId !== primary.foreignEndpoint.serverId || backup.iranEndpoint.serverId === primary.iranEndpoint.serverId) || selection.activeSide === "backup" && !backup) {
    throw new ApiError(422, "NODE_ROUTES_TOPOLOGY", "تونل‌ها باید به همین نود و سرور خارج متصل باشند و اصلی و بکاپ از دو سرور ایران متفاوت باشند.");
  }
  const changedRoles = candidates.filter((tunnel) => tunnel.side !== (tunnel.id === backup?.id ? "backup" : "primary"));
  if (changedRoles.some((tunnel) => state.nodes.some((node) => node.id !== nodeId &&
      (node.primaryTunnelId === tunnel.id || node.backupTunnelId === tunnel.id)))) {
    throw new ApiError(409, "NODE_ROUTES_SHARED", "نقش تونل مشترک با نود دیگر را نمی‌توان تغییر داد.");
  }
  const destination = selection.activeSide === "primary" ? primary : backup!;
  const activeId = original.activeSide === "primary" ? original.primaryTunnelId : original.backupTunnelId;
  const checkedAt = Date.parse(destination.lastCheck);
  if (destination.id !== activeId && (destination.status !== "healthy" ||
      !Number.isFinite(checkedAt) || checkedAt > Date.now() + 30000 ||
      Date.now() - checkedAt > Math.max(90000, (state.settings.telemetryIntervals?.tunnelProbe ?? 120) * 2000 + 30000))) {
    throw new ApiError(409, "NODE_ROUTES_UNHEALTHY", "برای فعال‌سازی، تونل مقصد باید گزارش سلامت تازه داشته باشد.");
  }
  const host = state.servers.find((server) => server.id === destination.iranEndpoint.serverId);
  if (!host) throw new ApiError(422, "NODE_ROUTES_HOST", "سرور مقصد پیدا نشد.");
  const hosts = [...new Set([original.primaryServerId, original.backupServerId, original.foreignServerId,
    primary.iranEndpoint.serverId, backup?.iranEndpoint.serverId].filter((id): id is string => Boolean(id)))];
  return withHosts(hosts, async () => {
    transaction((db) => {
      const current = readWorkspace(db).state.nodes.find((node) => node.id === nodeId);
      if (JSON.stringify(current) !== JSON.stringify(original) || JSON.stringify(readWorkspace(db).state.tunnels) !== JSON.stringify(state.tunnels) || provisionBusy(db, ...hosts) || db.prepare(`SELECT 1 FROM failover_plans p
        LEFT JOIN failover_executions e ON e.plan_id=p.id WHERE p.node_id=? AND
        ((p.status IN ('approved','awaiting_approval') AND p.expires_at>?) OR e.status IN ('applying','verifying','rolling_back','review'))`).get(nodeId, Date.now())) {
        throw new ApiError(409, "NODE_ROUTES_BUSY", "وضعیت نود تغییر کرده یا عملیات دیگری فعال است؛ دوباره تلاش کنید.");
      }
    });
    // Use the same provider path as operational failover, before changing the selected route.
    if (destination.id !== activeId) await syncPrimaryTunnelDns(actor, currentNodeDomain(database(), original.id), host.publicIpv4);
    return transaction((db) => {
      const { state, revision } = readWorkspace(db);
      const at = new Date().toISOString();
      // Retain retired routes and their installation history without contacting either endpoint.
      state.tunnels = state.tunnels.map((tunnel) => candidates.some((item) => item.id === tunnel.id)
        ? { ...tunnel, side: tunnel.id === backup?.id ? "backup" : "primary" } : tunnel);
      state.nodes = decorateNodes(state.nodes.map((node) => node.id === nodeId ? { ...node, ...selection,
        backupTunnelId: backup?.id, primaryServerId: primary.iranEndpoint.serverId, backupServerId: backup?.iranEndpoint.serverId,
        lastFailoverAt: at, proxyProbe: undefined, proxyObservationSet: undefined } : node), state.servers, state.tunnels, state.dns, state.settings, true);
      if (destination.id !== activeId) state.dns = state.dns.map((record) => record.nodeId === nodeId ? { ...record,
        aRecords: [host.publicIpv4], expectedIranIp: host.publicIpv4, authoritativeStatus: "matched", lastCheck: at } : record);
      pushAudit(state, actor, "nodes.routes.select", nodeId, `${destination.id} → ${host.publicIpv4}`);
      writeWorkspace(db, state, revision + 1);
      return state.nodes.find((node) => node.id === nodeId)!;
    });
  });
}

export async function setTunnelDns(actor: DemoUser, tunnelId: string) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "dns.switch")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی تغییر DNS لازم است.");
  }
  const initial = readWorkspace().state.tunnels.find((item) => item.id === tunnelId);
  if (!initial) throw new ApiError(404, "TUNNEL_UNKNOWN", "تونل پیدا نشد.");
  return withHosts([initial.iranEndpoint.serverId, initial.foreignEndpoint.serverId], async () => {
    const db = database();
    const { state } = readWorkspace(db);
    const tunnel = state.tunnels.find((item) => item.id === tunnelId);
    if (!tunnel || JSON.stringify(tunnel) !== JSON.stringify(initial)) {
      throw new ApiError(409, "TUNNEL_CHANGED", "وضعیت تونل تغییر کرده است؛ دوباره تلاش کنید.");
    }
    const checkedAt = Date.parse(tunnel.lastCheck);
    if (tunnel.status !== "healthy" || !Number.isFinite(checkedAt) || checkedAt > Date.now() + 30000 ||
        Date.now() - checkedAt > Math.max(90000, (state.settings.telemetryIntervals?.tunnelProbe ?? 120) * 2000 + 30000)) {
      throw new ApiError(409, "TUNNEL_UNHEALTHY", "برای تنظیم DNS، تونل باید فعال و دارای گزارش سلامت تازه باشد.");
    }
    const node = tunnel.nodeRef?.kind === "inventory"
      ? state.nodes.find((item) => tunnel.nodeRef?.kind === "inventory" && item.id === tunnel.nodeRef.id)
      : state.nodes.find((item) => tunnel.nodeIds.includes(item.id));
    const domain = tunnel.nodeRef?.kind === "v2board" ? panelTunnelHost(db, tunnel.nodeRef.key) : node ? currentNodeDomain(db, node.id) : undefined;
    const host = state.servers.find((item) => item.id === tunnel.iranEndpoint.serverId);
    if (!domain || !host) throw new ApiError(409, "TUNNEL_DNS_TARGET", "دامنه نود متصل یا سرور ایران پیدا نشد.");
    if (provisionBusy(db, initial.iranEndpoint.serverId, initial.foreignEndpoint.serverId) ||
        db.prepare("SELECT 1 FROM tunnel_deployments WHERE tunnel_id=? AND status IN ('deploying','verifying','rolling_back','review')").get(tunnelId) ||
        db.prepare(`SELECT 1 FROM failover_plans p LEFT JOIN failover_executions e ON e.plan_id=p.id
          WHERE p.node_id IN (SELECT json_extract(value, '$.id') FROM json_each(?, '$.nodes') WHERE lower(json_extract(value, '$.domain'))=lower(?))
          AND ((p.status IN ('approved','awaiting_approval') AND p.expires_at>?) OR e.status IN ('applying','verifying','rolling_back','review'))`)
          .get(JSON.stringify(state), domain, Date.now())) {
      throw new ApiError(409, "TUNNEL_DNS_BUSY", "عملیات دیگری روی این مسیر فعال است؛ دوباره تلاش کنید.");
    }
    const result = await syncPrimaryTunnelDns(actor, domain, host.publicIpv4);
    transaction((connection) => {
      const { state: current, revision } = readWorkspace(connection);
      pushAudit(current, actor, "tunnels.dns.set", tunnelId, `${domain} → ${host.publicIpv4}`);
      writeWorkspace(connection, current, revision + 1);
    });
    return { ...result, domain, ip: host.publicIpv4 };
  });
}
