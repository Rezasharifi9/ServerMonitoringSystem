import type { ServerRole, Tunnel, TunnelTech } from "@/types";

export const SERVER_ROLES = ["iran", "foreign"] as const satisfies readonly ServerRole[];
export const INVENTORY_SERVER_ROLES = [...SERVER_ROLES, "iran-primary", "iran-backup"] as const;
export const TUNNEL_TECHS = ["GRE", "IPIP", "SIT", "WireGuard", "GOST", "Backhaul", "Rathole", "GRE6", "Geneve"] as const satisfies readonly TunnelTech[];

export const BUNDLE_TECHS = ["GRE", "GRE6", "IPIP", "SIT", "WireGuard", "Geneve"] as const;
export const FORWARDER_TECHS = ["GOST", "Backhaul", "Rathole"] as const;
export const NODE_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function tunnelNodeDomain(host: string) {
  const domain = host.trim().toLowerCase().replace(/\.$/, "");
  return domain.length <= 253 && NODE_DOMAIN_PATTERN.test(domain) && !/^\d+(?:\.\d+){3}$/.test(domain) ? domain : undefined;
}

export function tunnelKind(technology: TunnelTech) {
  return FORWARDER_TECHS.some((item) => item === technology) ? "forwarder" : "interface";
}

export function backupTunnelMatches(primary: Tunnel, backup: Tunnel) {
  return backup.side === "backup" && backup.foreignEndpoint.serverId === primary.foreignEndpoint.serverId &&
    backup.iranEndpoint.serverId !== primary.iranEndpoint.serverId;
}

export function isIranServer(roles: readonly ServerRole[]) {
  return roles.some((role) => role === "iran" || role === "iran-primary" || role === "iran-backup");
}
