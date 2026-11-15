import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { can } from "@/lib/rbac";
import { BUNDLE_TECHS, FORWARDER_TECHS, isIranServer, tunnelKind } from "@/lib/topology";
import type { DemoUser, ForwarderBundleRecipe, Server, Tunnel, TunnelBundleRecipe, TunnelNodeRef } from "@/types";
import { digest } from "./auth";
import { database, readWorkspace, transaction, writeWorkspace, type Workspace } from "./database";
import { normalIpv6 } from "./dns-resolver";
import { ApiError } from "./http";
import { monitoredServer, monitoredTunnel, serverInput, tunnelInput, workspaceMode } from "./inventory";
import { panelTunnelHost, refreshPanel, tunnelForwarding, reconcilePanelRoutes, boardBindings } from "./providers";
import { pushAudit } from "./activity-log";
import { registrationPrimaryRoutes } from "@/lib/tunnel-registration";

const interfaceName = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,14}$/i);
const runtimeTunnel = tunnelInput.extend({
  interfaceName: interfaceName.optional(),
  foreignInterfaceName: interfaceName.optional(),
  serviceName: z.string().regex(/^[a-z\d][a-z\d_.@-]{0,100}\.service$/i).optional(),
});
const referencedTunnel = runtimeTunnel.pick({
  technology: true, iranServerId: true, foreignServerId: true, side: true,
  interfaceName: true, foreignInterfaceName: true, serviceName: true, port: true,
  greTransport: true,
}).extend({
  routeKey: z.string().uuid().optional(),
  nodeRef: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inventory"), id: tunnelInput.shape.id }).strict(),
    z.object({ kind: z.literal("v2board"), key: z.string().regex(/^[a-z0-9-]{1,24}:\d{1,20}$/) }).strict(),
  ]),
  mtu: tunnelInput.shape.mtu.default(1400),
});
const MAX_SERVERS = 500;
const MAX_TUNNELS = 2000;

function allow(actor: DemoUser, permission: "server.configure" | "tunnel.create" | "node.edit") {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "ثبت موجودی عملیاتی در حالت پایش در دسترس است.");
  if (!can(actor.role, permission)) throw new ApiError(403, "FORBIDDEN", "دسترسی ثبت موجودی مجاز نیست.");
}

function register<T extends Server | Tunnel>(
  actor: DemoUser,
  kind: "servers" | "tunnels",
  input: { id: string },
  getList: (state: Workspace) => T[],
  create: (state: Workspace, db: DatabaseSync) => T,
  afterInsert?: (state: Workspace, db: DatabaseSync, resource: T) => void,
) {
  return transaction((db) => {
    const { state, revision } = readWorkspace(db);
    const entries = getList(state);
    const fingerprint = digest(JSON.stringify(input));
    const existing = entries.find((entry) => entry.id === input.id);
    if (existing) {
      const receipt = db.prepare("SELECT fingerprint FROM topology_registrations WHERE kind = ? AND id = ?").get(kind, input.id);
      if (receipt?.fingerprint === fingerprint) return { resource: existing, replay: true };
      throw new ApiError(409, "TOPOLOGY_ID_EXISTS", "این شناسه از قبل در موجودی ثبت شده است.");
    }
    if (entries.length >= (kind === "servers" ? MAX_SERVERS : MAX_TUNNELS)) {
      throw new ApiError(409, "TOPOLOGY_LIMIT", "ظرفیت موجودی پر است.");
    }

    const resource = create(state, db);
    entries.push(resource);
    afterInsert?.(state, db, resource);
    db.prepare("INSERT INTO topology_registrations VALUES (?, ?, ?)").run(kind, input.id, fingerprint);
    state.audit = [{
      id: randomUUID(), at: new Date().toISOString(), actor: actor.name, role: actor.role, action: kind + ".register",
      target: input.id, detail: "موجودی پایش به‌روزرسانی شد.", simulated: false,
    }, ...state.audit].slice(0, 2000);
    writeWorkspace(db, state, revision + 1);
    return { resource, replay: false };

  });
}

export async function getTunnelBundleRecipe(actor: DemoUser, tunnelId: string, refresh = false): Promise<TunnelBundleRecipe | ForwarderBundleRecipe> {
  allow(actor, "server.configure");
  if (!can(actor.role, "deploy.run") || !can(actor.role, "tunnel.mutate")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی آماده‌سازی بستهٔ تونل مجاز نیست.");
  }
  const db = database();
  const { state } = readWorkspace(db);
  const tunnel = state.tunnels.find((item) => item.id === tunnelId);
  if (!tunnel) throw new ApiError(404, "TUNNEL_UNKNOWN", "تونل پیدا نشد.");
  const resolve = tunnelForwarding(db, state.nodes);
  const { port, targetPort, error, panel } = resolve(tunnel);
  if (refresh && panel) {
    await refreshPanel(actor);
    return getTunnelBundleRecipe(actor, tunnelId);
  }
  if (error) throw new ApiError(422, "TUNNEL_NODE_PORT", error);
  if (!["Rathole", "Backhaul"].includes(tunnel.technology) && port !== undefined && state.tunnels.some((item) => item.id !== tunnelId &&
      item.iranEndpoint.serverId === tunnel.iranEndpoint.serverId && resolve(item).port === port)) {
    throw new ApiError(409, "TUNNEL_PORT_EXISTS", "پورت نود روی سرور ایران به مسیر دیگری تعلق دارد.");
  }
  const forwarder = z.enum(FORWARDER_TECHS).safeParse(tunnel.technology);
  if (forwarder.success && tunnel.kind === "forwarder") {
    return {
      schema: 1, tunnelId, technology: forwarder.data, port, targetPort,
      iran: { serverId: tunnel.iranEndpoint.serverId, outerIp: tunnel.iranEndpoint.publicIp },
      foreign: { serverId: tunnel.foreignEndpoint.serverId, outerIp: tunnel.foreignEndpoint.publicIp },
    };
  }
  const technology = z.enum(BUNDLE_TECHS).safeParse(tunnel.technology);
  if (!technology.success) throw new ApiError(422, "TUNNEL_BUNDLE_TECH", "ساخت بستهٔ آماده برای این فناوری ارائه نشده است.");
  const endpoint = (value: Tunnel["iranEndpoint"]) => {
    const host = state.servers.find((item) => item.id === value.serverId);
    const outerIp = technology.data === "GRE6" ? host?.publicIpv6 : value.publicIp;
    if (!host || !outerIp || !value.tunnelIp) {
      throw new ApiError(422, "TUNNEL_BUNDLE_ADDRESS", "ابتدا IP داخلی و آدرس بیرونی هر دو میزبان را ثبت کنید.");
    }
    return { serverId: host.id, interfaceName: value.interfaceName ?? "", innerIp: value.tunnelIp, outerIp };
  };
  return {
    schema: 1, tunnelId, technology: technology.data, mtu: tunnel.configuredMtu ?? tunnel.mtu, port, targetPort,
    ...(technology.data === "GRE" ? { greTransport: tunnel.config.greTransport === "native" ? "native" as const : "udp" as const } : {}),
    iran: endpoint(tunnel.iranEndpoint), foreign: endpoint(tunnel.foreignEndpoint),
  };
}

export function saveGreTransport(actor: DemoUser, tunnelId: string, value: unknown) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "tunnel.mutate") || !can(actor.role, "server.configure") || !can(actor.role, "deploy.run")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی مدیریت تونل لازم است.");
  }
  const parsed = z.object({ transport: z.enum(["native", "udp"]) }).strict().safeParse(value);
  if (!parsed.success) throw new ApiError(422, "GRE_TRANSPORT", "روش انتقال GRE معتبر نیست.");
  return transaction((db) => {
    const { state, revision } = readWorkspace(db);
    const tunnel = state.tunnels.find((item) => item.id === tunnelId);
    if (!tunnel || tunnel.technology !== "GRE") throw new ApiError(422, "GRE_TARGET", "تونل GRE را انتخاب کنید.");
    const hosts = [tunnel.iranEndpoint.serverId, tunnel.foreignEndpoint.serverId];
    if (db.prepare("SELECT 1 FROM provision_jobs WHERE server_id IN (?,?) AND status IN ('queued','running')").get(...hosts) ||
        db.prepare("SELECT 1 FROM tunnel_deployments WHERE (iran_id IN (?,?) OR foreign_id IN (?,?)) AND status IN ('deploying','verifying','rolling_back','review')").get(...hosts, ...hosts) ||
        db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id IN (?,?) AND expires_at>?").get(...hosts, Date.now())) {
      throw new ApiError(409, "PROVISION_HOST_BUSY", "ابتدا عملیات جاری روی سرورهای تونل را تمام کنید.");
    }
    if (parsed.data.transport === "native" && state.tunnels.some((item) => item.id !== tunnelId && item.technology === "GRE" &&
        item.config.greTransport === "native" && item.iranEndpoint.serverId === hosts[0] && item.foreignEndpoint.serverId === hosts[1])) {
      throw new ApiError(409, "GRE_NATIVE_EXISTS", "بین این دو سرور یک تونل GRE معمولی ثبت شده است.");
    }
    tunnel.config = { ...tunnel.config, greTransport: parsed.data.transport };
    pushAudit(state, actor, "tunnel.gre.transport", tunnelId, parsed.data.transport);
    writeWorkspace(db, state, revision + 1);
    return { transport: parsed.data.transport };
  });
}

export function registerServer(actor: DemoUser, input: unknown) {
  allow(actor, "server.configure");
  const parsed = serverInput.safeParse(input);
  if (!parsed.success || new Set(parsed.data.roles).size !== parsed.data.roles.length) {
    throw new ApiError(422, "SERVER_REGISTRATION", "نام، شناسه، آدرس‌ها، موقعیت و نقش‌های سرور را بررسی کنید.");
  }
  const entry = { ...parsed.data, roles: [...parsed.data.roles].sort() };
  return register(actor, "servers", entry, (state) => state.servers, () => monitoredServer(entry));
}

export function registerTunnel(actor: DemoUser, input: unknown) {
  allow(actor, "tunnel.create");
  const parsed = z.union([referencedTunnel, runtimeTunnel]).safeParse(input);
  if (!parsed.success || ("id" in parsed.data && parsed.data.id === "new")) {
    throw new ApiError(422, "TUNNEL_REGISTRATION", "شناسه، نوع تونل و فیلدهای مسیر را بررسی کنید.");
  }
  const automatic = "nodeRef" in parsed.data;
  if (parsed.data.greTransport && parsed.data.technology !== "GRE") throw new ApiError(422, "GRE_TARGET", "روش انتقال فقط برای تونل GRE است.");
  const entry: z.output<typeof runtimeTunnel> & { nodeRef?: TunnelNodeRef } = "nodeRef" in parsed.data
    ? { ...parsed.data, id: referencedTunnelId(JSON.stringify(parsed.data.nodeRef), parsed.data.side, parsed.data.iranServerId, parsed.data.foreignServerId, parsed.data.technology, parsed.data.routeKey), name: `${parsed.data.technology} ${parsed.data.side}` }
    : parsed.data;
  if (entry.side === "backup" && !entry.nodeRef) throw new ApiError(422, "BACKUP_NODE_REQUIRED", "هنگام تعریف تونل بکاپ، نود را انتخاب کنید.");
  return register(actor, "tunnels", entry, (state) => state.tunnels, (state, db) => {
    const nodeRef = entry.nodeRef;
    if (entry.port === undefined && !(nodeRef && (FORWARDER_TECHS.some(technology => technology === entry.technology) || BUNDLE_TECHS.some((technology) => technology === entry.technology)))) {
      throw new ApiError(422, "TUNNEL_PORT", "پورت تونل را وارد کنید.");
    }
    if (nodeRef) {
      if (nodeRef.kind === "inventory") {
        const node = state.nodes.find((item) => item.id === nodeRef.id);
        if (node && db.prepare("SELECT 1 FROM ssh_operation_leases WHERE server_id=? AND expires_at>?").get(node.foreignServerId, Date.now())) {
          throw new ApiError(409, "PROVISION_HOST_BUSY", "عملیات دیگری روی میزبان نود در جریان است.");
        }
      }
      const linkedId = nodeRef.kind === "inventory" ? nodeRef.id : boardBindings(db).get(nodeRef.key);
      const linked = state.nodes.find((node) => node.id === linkedId);
      if (nodeRef.kind === "inventory" ? !linked : !panelTunnelHost(db, nodeRef.key)) throw new ApiError(409, "TUNNEL_NODE_CHANGED", "نود انتخاب‌شده در دسترس نیست.");
      if (entry.side === "backup") {
        const primaries = registrationPrimaryRoutes(nodeRef, state.nodes, state.tunnels, linkedId ? String(linkedId) : undefined);
        if (linked?.backupTunnelId || state.tunnels.some((tunnel) => tunnel.side === "backup" && JSON.stringify(tunnel.nodeRef) === JSON.stringify(nodeRef))) throw new ApiError(409, "BACKUP_ALREADY_REGISTERED", "این نود تونل بکاپ دارد؛ ابتدا آن را حذف کنید.");
        if (!primaries.some(primary => primary.foreignEndpoint.serverId === entry.foreignServerId && primary.iranEndpoint.serverId !== entry.iranServerId)) throw new ApiError(422, "BACKUP_ROUTE_TOPOLOGY", "بکاپ باید از سرور ایران دیگری به سرور خارج مسیر اصلی همین نود برسد.");
      }
    }
    const iran = state.servers.find((server) => server.id === entry.iranServerId);
    const foreign = state.servers.find((server) => server.id === entry.foreignServerId);
    if (entry.technology === "GRE" && entry.greTransport === "native" && state.tunnels.some((item) => item.technology === "GRE" &&
        item.config.greTransport === "native" && item.iranEndpoint.serverId === entry.iranServerId && item.foreignEndpoint.serverId === entry.foreignServerId)) {
      throw new ApiError(409, "GRE_NATIVE_EXISTS", "بین این دو سرور یک تونل GRE معمولی ثبت شده است.");
    }
    if (iran?.id === foreign?.id || !iran || !isIranServer(iran.roles) || !foreign?.roles.includes("foreign")) {
      throw new ApiError(422, "TUNNEL_ENDPOINTS", "مسیر به دو میزبان متفاوت با نقش ایران و خارج نیاز دارد.");
    }
    if (tunnelKind(entry.technology) === "forwarder") {
      if (entry.interfaceName || entry.foreignInterfaceName || entry.iranTunnelIp || entry.foreignTunnelIp) {
        throw new ApiError(422, "TUNNEL_FORWARDER_CONFIG", "برای هدایت پورت، مشخصات رابط و IP داخلی را خالی بگذارید.");
      }
      if (entry.port !== undefined) checkTunnelPort(state, iran.id, entry.port);
      return { ...monitoredTunnel(entry, { ...iran, tunnelIp: "" }, { ...foreign, tunnelIp: "" }), nodeRef };
    }

    const used = occupiedAddresses(state);
    const pair = automatic ? allocateTunnelAddresses(used, entry.technology === "SIT") : undefined;
    const local = pair?.[0] ?? entry.iranTunnelIp ?? iran.tunnelIp;
    const peer = pair?.[1] ?? entry.foreignTunnelIp ?? foreign.tunnelIp;
    const version = isIP(local);
    if ((!automatic && !entry.interfaceName) || !version || version !== isIP(peer) ||
        addressKey(local) === addressKey(peer) || entry.serviceName || (version === 6 && entry.mtu < 1280)) {
      throw new ApiError(422, "TUNNEL_INTERFACE_CONFIG", "نام رابط، IPهای داخلی و MTU تونل را بررسی کنید.");
    }
    const usedInterfaces = new Map([[iran.id, new Set<string>()], [foreign.id, new Set<string>()]]);
    for (const tunnel of state.tunnels) {
      for (const endpoint of [tunnel.iranEndpoint, tunnel.foreignEndpoint]) {
        if (endpoint.interfaceName) usedInterfaces.get(endpoint.serverId)?.add(endpoint.interfaceName);
      }
    }
    const localNames = usedInterfaces.get(iran.id)!;
    const peerNames = usedInterfaces.get(foreign.id)!;
    if ((entry.interfaceName && localNames.has(entry.interfaceName)) ||
        (entry.foreignInterfaceName && peerNames.has(entry.foreignInterfaceName))) {
      throw new ApiError(409, "TUNNEL_INTERFACE_EXISTS", "این رابط روی میزبان برای تونل دیگری ثبت شده است.");
    }
    if (used.tunnels.has(addressKey(local)) || used.tunnels.has(addressKey(peer))) {
      throw new ApiError(409, "TUNNEL_IP_EXISTS", "یکی از IPهای داخلی برای تونل دیگری ثبت شده است.");
    }
    if (entry.port !== undefined) checkTunnelPort(state, iran.id, entry.port);
    const autoName = automatic ? allocateInterfaceName(entry.id, new Set([
      ...localNames, ...peerNames, ...iran.interfaces.map(({ name }) => name), ...foreign.interfaces.map(({ name }) => name),
    ])) : undefined;
    return {
      ...monitoredTunnel({
        ...entry, iranTunnelIp: local, foreignTunnelIp: peer,
        interfaceName: entry.interfaceName ?? autoName, foreignInterfaceName: entry.foreignInterfaceName ?? autoName,
      }, iran, foreign),
      nodeRef,
    };
  }, (state, db, tunnel) => {
    if (!tunnel.nodeRef) return;
    if (!can(actor.role, "node.edit")) throw new ApiError(403, "FORBIDDEN", "دسترسی ویرایش نود لازم است.");
    if (tunnel.nodeRef.kind === "v2board") reconcilePanelRoutes(db, state);
    const linkedId = tunnel.nodeRef.kind === "inventory" ? tunnel.nodeRef.id : boardBindings(db).get(tunnel.nodeRef.key);
    const linkedNode = state.nodes.find((item) => item.id === linkedId);
    if (!linkedNode && tunnel.nodeRef.kind === "v2board") return;
    if (!linkedNode || linkedNode.foreignServerId !== tunnel.foreignEndpoint.serverId) {
      throw new ApiError(422, "TUNNEL_NODE_HOST", "تونل باید به سرور خارج همین نود متصل باشد.");
    }
    if (tunnel.side === "backup") {
      linkedNode.backupTunnelId = tunnel.id;
      linkedNode.backupServerId = tunnel.iranEndpoint.serverId;
    }
    tunnel.nodeIds = [...new Set([...tunnel.nodeIds, linkedNode.id])];
    linkedNode.tunnelIds = [...new Set([...(linkedNode.tunnelIds ?? []), linkedNode.primaryTunnelId,
      ...(linkedNode.backupTunnelId ? [linkedNode.backupTunnelId] : []), tunnel.id])];

  });
}

function checkTunnelPort(state: Workspace, sourceId: string, port: number) {
  if (state.tunnels.some(({ iranEndpoint }) => iranEndpoint.serverId === sourceId && iranEndpoint.port === port)) {
    throw new ApiError(409, "TUNNEL_PORT_EXISTS", "این پورت روی سرور مبدأ برای مسیر دیگری ثبت شده است.");
  }
}

function referencedTunnelId(reference: string, side: Tunnel["side"], iran: string, foreign: string, technology: string, key?: string) {
  // Reuse only a live registration for request retries. A deleted route never owns its next incarnation.
  const prefix = `route:${digest(JSON.stringify([reference, side, iran, foreign, technology, key])).slice(0, 20)}:`;
  return readWorkspace().state.tunnels.find((tunnel) => tunnel.id.startsWith(prefix))?.id ?? prefix + randomUUID();
}

function addressKey(address: string) {
  const normalized = isIP(address) === 6 ? normalIpv6(address) : address;
  const mapped = /^\[::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})\]$/.exec(normalized);
  if (!mapped) return normalized;
  return mapped.slice(1).flatMap((part) => {
    const value = Number.parseInt(part, 16);
    return [value >> 8, value & 255];
  }).join(".");
}

function occupiedAddresses(state: Workspace) {
  const tunnels = new Set<string>();
  const all = new Set<string>();
  const add = (set: Set<string>, address?: string) => {
    const ip = address?.split("/", 1)[0];
    if (ip && isIP(ip)) set.add(addressKey(ip));
  };
  for (const tunnel of state.tunnels) {
    for (const endpoint of [tunnel.iranEndpoint, tunnel.foreignEndpoint]) {
      add(tunnels, endpoint.tunnelIp);
      add(all, endpoint.publicIp);
    }
  }
  for (const server of state.servers) {
    add(all, server.tunnelIp);
    add(all, server.publicIpv4);
    add(all, server.publicIpv6);
    for (const link of server.interfaces) {
      add(all, link.ipv4);
      add(all, link.ipv6);
    }
  }
  for (const address of tunnels) all.add(address);
  return { tunnels, all };
}

function allocateTunnelAddresses(used: ReturnType<typeof occupiedAddresses>, ipv6: boolean) {
  // Reserve a separate block for each pair from the private or ULA pool.
  const address = ipv6
    ? (offset: number) => `fd93:9b42:708c:5ad2::${offset.toString(16)}`
    : (offset: number) => `10.254.${offset >> 8}.${offset & 255}`;
  for (let base = 0; base < 65_536; base += 4) {
    const block = [0, 1, 2, 3].map((offset) => address(base + offset));
    if (block.every((ip) => !used.all.has(addressKey(ip)))) return [block[1], block[2]] as const;
  }
  throw new ApiError(409, "TUNNEL_IP_POOL_EXHAUSTED", "ظرفیت تخصیص IP داخلی تونل پر است.");
}

function allocateInterfaceName(id: string, occupied: Set<string>) {
  for (let attempt = 0; ; attempt++) {
    const name = "ng" + digest(`${id}/${attempt}`).slice(0, 12);
    if (!occupied.has(name)) return name;
  }
}
