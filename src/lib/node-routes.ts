import { activeTunnelId } from "./health";
import type { Node, Tunnel, V2BoardCatalogEntry } from "@/types";
export function nodeTunnels(node: Node | undefined, panel: V2BoardCatalogEntry | undefined, tunnels: Tunnel[]) {
  return tunnels.filter((tunnel) => {
    if (tunnel.nodeRef?.kind === "v2board" && panel) return tunnel.nodeRef.key === panel.key;
    return Boolean(node && (tunnel.id === activeTunnelId(node) || node.tunnelIds?.includes(tunnel.id) || tunnel.nodeIds?.includes(node.id) ||
      tunnel.nodeRef?.kind === "inventory" && tunnel.nodeRef.id === node.id));
  });
}
export function nodeDisplayTunnel(node: Node | undefined, panel: V2BoardCatalogEntry | undefined, tunnels: Tunnel[], freshMs: number, now = Date.now()) {
  const paths = nodeTunnels(node, panel, tunnels);
  const selected = node && paths.find((path) => path.id === activeTunnelId(node));
  if (selected) return selected;
  const fresh = paths.filter((path) => { const at = Date.parse(path.lastCheck); return Number.isFinite(at) && at <= now + 30000 && now - at <= freshMs; });
  return fresh.find((path) => path.status === "healthy") ?? fresh.find((path) => path.status === "degraded") ?? fresh[0] ?? paths[0];
}
