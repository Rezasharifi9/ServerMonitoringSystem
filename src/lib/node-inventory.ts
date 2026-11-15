import { nodeDisplayTunnel, nodeTunnels } from "@/lib/node-routes";
import type { PanelAdminNode } from "@/lib/v2board-node-fields";
import type { DNSRecord, Node, Server, Tunnel, V2BoardCatalogEntry } from "@/types";

function domainKey(domain: string) {
  return domain.toLowerCase().replace(/\.$/, "");
}

export const nodeRouteLabels = { healthy: "Online", backup: "Online - Backup", tunnel: "تونل قطع", dns: "قطع DNS", unknown: "نامشخص" };

export function nodeInventoryRows(
  nodes: Node[], catalog: V2BoardCatalogEntry[], tunnels: Tunnel[], servers: Server[],
  dns: DNSRecord[], monitoringIntervalSec: number, monitor: boolean, adminNodes: PanelAdminNode[],
) {
  const byNode = new Map(nodes.map((node) => [node.id, node]));
  const byTunnel = new Map(tunnels.map((tunnel) => [tunnel.id, tunnel]));
  const byServer = new Map(servers.map((server) => [server.id, server]));
  const byDns = new Map(dns.map((record) => [record.nodeId, record]));
  const admins = new Map(adminNodes.map((item) => [`${item.type}:${item.id}`, item]));
  const linked = new Set(catalog.map((item) => item.nodeId));
  const cutoff = Date.now() - Math.max(90, monitoringIntervalSec * 3) * 1000;

  function row(node?: Node, panel?: V2BoardCatalogEntry, admin?: PanelAdminNode) {
    const panelKey = panel?.key.replace(/:0+(?=\d)/, ":") ?? (admin && `${admin.type}:${admin.id}`);
    const primary = node && byTunnel.get(node.primaryTunnelId);
    const backup = node?.backupTunnelId ? byTunnel.get(node.backupTunnelId) : undefined;
    const paths = nodeTunnels(node, panel, tunnels);
    const tunnel = nodeDisplayTunnel(node, panel, tunnels, Date.now() - cutoff);
    const foreign = tunnel && byServer.get(tunnel.foreignEndpoint.serverId);
    const service = foreign?.services.find((item) => item.name === "v2bx");
    const observedTunnel = tunnel && (!monitor || Date.parse(tunnel.lastCheck) >= cutoff);
    const observedPing = observedTunnel && (!monitor || tunnel.kind === "interface" &&
      Boolean(tunnel.iranEndpoint.tunnelIp && tunnel.foreignEndpoint.tunnelIp));
    const domain = panel?.host || node?.domain || String(admin?.fields.host ?? "");
    const dnsRecord = node && byDns.get(node.id);
    const expectedIp = tunnel?.iranEndpoint.publicIp;
    const dnsObserved = dnsRecord && expectedIp && domainKey(domain) === domainKey(dnsRecord.domain) &&
      Boolean(dnsRecord.lastCheck) && (!dnsRecord.expectedIranIp || dnsRecord.expectedIranIp === expectedIp);
    const resolver = dnsRecord && domainKey(domain) === domainKey(dnsRecord.domain) && !dnsRecord.stale
      ? dnsRecord.resolverObservation : undefined;
    const resolved = resolver?.complete ? resolver.aRecords : undefined;
    const matching = resolved?.length === 1 ? paths.find((path) => path?.iranEndpoint.publicIp === resolved[0]) : undefined;
    const probe = (path: Tunnel | undefined) => path && (!monitor || Date.parse(path.lastCheck) >= cutoff && Date.parse(path.lastCheck) <= Date.now() + 30000)
      ? path.kind === "forwarder" ? path.forwarderProbe?.ok : path.status !== "offline" && path.packetLoss < 100 : undefined;
    const reachable = probe(matching ?? tunnel);
    const onBackup = (matching ?? tunnel)?.side === "backup";
    const routeStatus: keyof typeof nodeRouteLabels = !tunnel ? "unknown" : !monitor && resolved && !matching ? "dns" : reachable === false ? "tunnel"
      : reachable === true ? (onBackup ? "backup" : "healthy") : "unknown";
    const v2bxFresh = service && foreign?.agent.status === "online" &&
      Date.parse(service.observedAt ?? foreign.agent.lastHeartbeat) >= cutoff;
    return {
      id: panelKey ? "v2board:" + (panel?.key ?? panelKey) : "node:" + node!.id,
      name: panel?.name || node?.name || String(admin?.fields.name ?? panelKey ?? ""),
      domain, panel, panelKey, node,
      port: panel?.port ?? node?.port ?? (admin ? String(admin.fields.port ?? "") : undefined),
      protocol: panel?.protocol ?? panel?.type ?? node?.protocol ?? admin?.type,
      transport: panel?.transport ?? String((admin ?? (panelKey ? admins.get(panelKey) : undefined))?.fields.network ?? ""),
      routeStatus,
      primaryIp: primary?.iranEndpoint.publicIp,
      backupIp: backup?.iranEndpoint.publicIp,
      foreignIp: tunnel?.foreignEndpoint.publicIp,
      technology: tunnel?.technology,
      tunnelStatus: observedTunnel ? tunnel.status : undefined,
      ping: observedPing && tunnel.packetLoss < 100 && tunnel.rttMs > 0 ? tunnel.rttMs : undefined,
      loss: observedPing ? tunnel.packetLoss : undefined,
      online: panel?.online,
      v2bx: monitor ? v2bxFresh ? service.status : undefined : node?.v2bxStatus,
      dnsStatus: !monitor || dnsObserved ? node?.dnsStatus : undefined,
      resolverOnly: dnsObserved ? dnsRecord.resolverOnly : undefined,
      dnsRecord: dnsObserved ? dnsRecord : undefined,
      sourceEndpoint: tunnel?.iranEndpoint,
      destinationEndpoint: tunnel?.foreignEndpoint,
      expectedIp,
    };
  }

  const panelRows = catalog.map((panel) => row(panel.nodeId ? byNode.get(panel.nodeId) : undefined, panel));
  const panelKeys = new Set(panelRows.map((item) => item.panelKey));
  return [
    ...panelRows,
    ...adminNodes.filter(({ type, id }) => !panelKeys.has(`${type}:${id}`)).map((admin) => row(undefined, undefined, admin)),
    ...nodes.filter((node) => !linked.has(node.id)).map((node) => row(node)),
  ];
}

export function panelOnlineSummary(entries: Pick<V2BoardCatalogEntry, "key" | "name" | "online" | "parentKey" | "nodeId">[]) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const reported = entries.filter((entry): entry is typeof entry & { online: number } => typeof entry.online === "number");
  let shared = 0;
  const total = reported.reduce((sum, entry) => {
    const parent = entry.parentKey && entry.parentKey !== entry.key ? byKey.get(entry.parentKey) : undefined;
    if (parent && parent.online === entry.online) {
      shared += 1;
      return sum;
    }
    return sum + entry.online;
  }, 0);
  return {
    total, shared,
    reported: [...reported].sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)),
  };
}
