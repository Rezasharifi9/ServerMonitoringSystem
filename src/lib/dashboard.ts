import { nodeDisplayTunnel } from "@/lib/node-routes";
import type { Node, Tunnel, V2BoardCatalogEntry } from "@/types";

export function dashboardNodeCounts(entries: V2BoardCatalogEntry[], nodes: Node[], tunnels: Tunnel[], freshMs: number, now = Date.now()) {
  const byNode = new Map(nodes.map((node) => [node.id, node]));
  const counts = { healthy: 0, degraded: 0, offline: 0, unknown: 0 };
  for (const entry of entries) {
    const node = entry.nodeId ? byNode.get(entry.nodeId) : undefined;
    const tunnel = nodeDisplayTunnel(node, entry, tunnels, freshMs, now);
    const checked = tunnel ? Date.parse(tunnel.lastCheck) : NaN;
    if (!tunnel || !Number.isFinite(checked) || checked > now + 30000 || now - checked > freshMs) { counts.unknown++; continue; }
    if (tunnel.status === "offline") { counts.offline++; counts.degraded++; }
    else { counts.healthy++; if (tunnel.packetLoss > 15) counts.degraded++; }
  }
  return counts;
}
