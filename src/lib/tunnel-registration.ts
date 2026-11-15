import type { Node, Tunnel, TunnelNodeRef } from "@/types";

/** Resolve destinations from registered primary paths, never from unrelated hosts. */
export function registrationPrimaryRoutes(ref: TunnelNodeRef, nodes: Node[], tunnels: Tunnel[], linkedId?: string) {
  const node = nodes.find(n => n.id === (ref.kind === "inventory" ? ref.id : linkedId));
  return tunnels.filter(t => t.side === "primary" &&
    (!node || t.foreignEndpoint.serverId === node.foreignServerId) && (
      ref.kind === "v2board" && t.nodeRef?.kind === "v2board" && t.nodeRef.key === ref.key ||
      ref.kind === "inventory" && t.nodeRef?.kind === "inventory" && t.nodeRef.id === ref.id ||
      Boolean(node && (t.id === node.primaryTunnelId || t.nodeIds.includes(node.id) || node.tunnelIds?.includes(t.id)))
    ));
}
