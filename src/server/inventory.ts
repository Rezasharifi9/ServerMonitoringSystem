import { readFileSync } from "node:fs";
import { adminAccount, adminConfig } from "./admin-config";
import { isIP } from "node:net";
import { z } from "zod";
import { buildSeed, defaultFailover } from "@/data/seed";
import { decorateNodes } from "@/lib/health";
import { isIranServer, NODE_DOMAIN_PATTERN, INVENTORY_SERVER_ROLES, tunnelKind, TUNNEL_TECHS } from "@/lib/topology";
import type { DemoSnapshot, Node, Server, Tunnel } from "@/types";

export function workspaceMode() {
  const mode = process.env.NODEGUARD_WORKSPACE_MODE ?? "simulation";
  if (mode !== "simulation" && mode !== "monitor") throw new Error("Invalid NODEGUARD_WORKSPACE_MODE");
  return mode;
}

const id = z.string().min(1).max(96).regex(/^[a-z\d][a-z\d_.:-]*$/i);
const label = z.string().trim().min(1).max(128);
const ipv4 = z.string().refine((ip) => isIP(ip) === 4);
const ipv6 = z.string().refine((ip) => isIP(ip) === 6);
const address = z.string().refine((ip) => Boolean(isIP(ip)));
export const monitorDomain = z.string().max(253).regex(NODE_DOMAIN_PATTERN);
const tech = z.enum(TUNNEL_TECHS);
export const tunnelPort = z.number().int().min(1).max(65535);
export const serverInput = z.object({
  id, name: label, country: label, countryCode: z.string().regex(/^[A-Z]{2}$/), city: label,
  publicIpv4: ipv4, publicIpv6: ipv6.optional(), tunnelIp: address.optional(),
  provider: label, os: label, roles: z.array(z.enum(INVENTORY_SERVER_ROLES)).min(1).max(3),
}).strict();
export const tunnelInput = z.object({
  id, name: label, technology: tech, iranServerId: id, foreignServerId: id, side: z.enum(["primary", "backup"]),
  mtu: z.number().int().min(576).max(9000), interfaceName: z.string().max(15).optional(),
  foreignInterfaceName: z.string().max(15).optional(), serviceName: label.optional(),
  iranTunnelIp: address.optional(), foreignTunnelIp: address.optional(), port: tunnelPort.optional(),
  greTransport: z.enum(["native", "udp"]).optional(),
}).strict();
const nodeInput = z.object({
  id, name: label, protocol: z.enum(["VLESS", "VMess", "Trojan", "Shadowsocks", "Hysteria2"]),
  port: z.number().int().min(1).max(65535), domain: monitorDomain, primaryServerId: id, backupServerId: id.optional(), foreignServerId: id,
  primaryTunnelId: id, backupTunnelId: id.optional(), activeSide: z.enum(["primary", "backup"]).default("primary"),
}).strict();
const inventory = z.object({
  servers: z.array(serverInput).max(500),
  tunnels: z.array(tunnelInput).max(2000),
  nodes: z.array(nodeInput).max(2000),
}).strict();

function index<T extends { id: string }>(items: T[]) {
  const map = new Map(items.map((item) => [item.id, item]));
  if (map.size !== items.length) throw new Error("Duplicate inventory ID");
  return map;
}


export function monitoredServer(entry: z.output<typeof serverInput>): Server {
  return {
    ...entry, region: entry.city, tunnelIp: entry.tunnelIp ?? "", cpu: 0, ram: 0, disk: 0, rxMbps: 0, txMbps: 0,
    agent: { id: "agent-" + entry.id, serverId: entry.id, version: "—", status: "offline", lastHeartbeat: "", capabilities: [] },
    status: "offline", interfaces: [], services: [], uptimeSec: 0, notes: "",
  };
}

export function monitoredTunnel(
  input: z.output<typeof tunnelInput>,
  iran: Pick<Server, "id" | "publicIpv4" | "tunnelIp">,
  foreign: Pick<Server, "id" | "publicIpv4" | "tunnelIp">,
  nodeIds: string[] = [],
): Tunnel {
  const { id, name, technology, mtu, interfaceName, serviceName, side, port } = input;
  return {
    id, name, technology, mtu, configuredMtu: mtu, interfaceName, serviceName, side, kind: tunnelKind(technology),
    iranEndpoint: { serverId: iran.id, publicIp: iran.publicIpv4, tunnelIp: input.iranTunnelIp ?? (iran.tunnelIp || undefined), interfaceName, port },
    foreignEndpoint: { serverId: foreign.id, publicIp: foreign.publicIpv4, tunnelIp: input.foreignTunnelIp ?? (foreign.tunnelIp || undefined), interfaceName: input.foreignInterfaceName, port },
    status: "offline", rttMs: 0, jitterMs: 0, packetLoss: 0, rxMbps: 0, txMbps: 0,
    lastCheck: "", uptimePct: 0, config: technology === "GRE" ? { greTransport: input.greTransport ?? "udp" } : {}, nodeIds,
  };
}

export function monitoredNode(entry: z.output<typeof nodeInput>, foreign: Pick<Server, "country" | "countryCode" | "city">): Node {
  return {
    ...entry, country: foreign.country, countryCode: foreign.countryCode, city: foreign.city,
    v2bxNodeState: "active", failoverState: "HEALTHY", health: "offline",
    v2bxStatus: "stopped", dnsStatus: "error", rttMs: 0, packetLoss: 0, jitterMs: 0, uptimePct: 0,
    tags: [], settings: { remark: "", rateLimitMbps: 0, probeEnabled: true, alertOnLoss: true },
  };
}

export function monitoredDns(node: Node, panelHost = node.domain) {
  return {
    id: "dns-" + node.id, nodeId: node.id, domain: node.domain, v2boardHost: panelHost,
    v2boardIp: isIP(panelHost) ? panelHost : undefined,
    aRecords: [], aaaaRecords: [], ttl: 0, authoritativeStatus: "error" as const, resolverStatus: "error" as const,
    proxied: false, lastCheck: "", note: "هنوز مشاهدهٔ DNS ثبت نشده است.",
  };
}

export function monitoredFailover(nodeId: string) {
  return { ...defaultFailover(), autoEnabled: false, autoFailback: false, manualApproval: true, nodeId };
}

export function initialSnapshot(): DemoSnapshot {
  const seed = buildSeed();
  if (adminConfig()) seed.users = [adminAccount];
  if (workspaceMode() === "simulation") return seed;
  const filename = process.env.NODEGUARD_INVENTORY_PATH;
  if (!filename) throw new Error("Set NODEGUARD_INVENTORY_PATH for monitor mode");
  const config = inventory.parse(JSON.parse(readFileSync(/*turbopackIgnore: true*/ filename, "utf8")));
  const serversById = index(config.servers);
  const tunnelsById = index(config.tunnels);
  index(config.nodes);
  if (new Set(config.nodes.map((node) => node.domain.toLowerCase())).size !== config.nodes.length) {
    throw new Error("Duplicate inventory domain");
  }
  const servers = config.servers.map(monitoredServer);
  const tunnels = config.tunnels.map((entry) => {
    const { iranServerId, foreignServerId } = entry;
    const iran = serversById.get(iranServerId);
    const foreign = serversById.get(foreignServerId);
    if (iranServerId === foreignServerId || !iran || !isIranServer(iran.roles) || !foreign?.roles.includes("foreign")) {
      throw new Error("Invalid tunnel endpoints for " + entry.id);
    }
    const nodeIds = config.nodes.filter((node) => node.primaryTunnelId === entry.id || node.backupTunnelId === entry.id).map((node) => node.id);
    return monitoredTunnel(entry, { ...iran, tunnelIp: iran.tunnelIp ?? "" }, { ...foreign, tunnelIp: foreign.tunnelIp ?? "" }, nodeIds);
  });
  const nodes: Node[] = config.nodes.map((entry) => {
    const foreign = serversById.get(entry.foreignServerId);
    const primary = tunnelsById.get(entry.primaryTunnelId);
    const backup = entry.backupTunnelId ? tunnelsById.get(entry.backupTunnelId) : undefined;
    const expectsBackup = Boolean(entry.backupServerId || entry.backupTunnelId || entry.activeSide === "backup");
    if (!foreign || !primary || primary.side !== "primary" || primary.iranServerId !== entry.primaryServerId ||
      primary.foreignServerId !== foreign.id || (expectsBackup && (!backup || backup.side !== "backup" ||
        backup.iranServerId !== entry.backupServerId || backup.foreignServerId !== foreign.id ||
        entry.primaryServerId === entry.backupServerId))) {
      throw new Error("Invalid topology for " + entry.id);
    }
    return monitoredNode(entry, foreign);
  });
  const dns = nodes.map((node) => monitoredDns(node));
  return {
    ...seed, nodes: decorateNodes(nodes, servers, tunnels, dns, seed.settings), servers, tunnels, dns,
    integrations: seed.integrations.map((item) => ({
      id: item.id, type: item.type, name: item.name, status: "disconnected",
      config: {}, message: "هنوز داده‌ای از این اتصال خوانده نشده است.",
    })),
    policies: nodes.map((node) => monitoredFailover(node.id)),
    alerts: [], incidents: [], audit: [], failoverEvents: [], deployments: [], speedtests: [], logs: [],
  };
}
