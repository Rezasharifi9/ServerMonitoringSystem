import type { AppSettings, DNSRecord, Node, Server, Tunnel } from "@/types";

export type Quality = "healthy" | "degraded" | "offline" | "unknown";
export type StatusPanelNode = { key: string; name: string; host: string };
export type StatusState = { nodes: Node[]; servers: Server[]; tunnels: Tunnel[]; dns: DNSRecord[]; settings: AppSettings };
const normal = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");
export function statusFresh(at: string | undefined, now: number, maxAge: number) {
  const age = now - Date.parse(at ?? "");
  return age >= -30000 && age <= maxAge;
}

export function publicNodeCandidates(state: StatusState, panel: StatusPanelNode[], bindings: Map<string, string>) {
  const local = new Map(state.nodes.map(node => [node.id, node]));
  const bound = new Set<string>();
  const entries = panel.map(entry => {
    const node = local.get(bindings.get(entry.key) ?? "");
    if (node) bound.add(node.id);
    const paths = state.tunnels.filter(t => t.nodeRef?.kind === "v2board" && t.nodeRef.key === entry.key ||
      Boolean(node && (t.id === node.primaryTunnelId || t.id === node.backupTunnelId || t.nodeIds.includes(node.id) || node.tunnelIds?.includes(t.id))));
    // Include configured panel nodes even if they have not been imported as inventory nodes.
    const host = state.servers.find(s => s.panelNodeRefs?.includes(entry.key));
    return { key: entry.key, name: entry.name, domain: entry.host, node, paths, host };
  }).filter(entry => entry.paths.length || entry.node || entry.host);
  for (const node of state.nodes) {
    if (bound.has(node.id) || node.v2bxNodeState === "disabled") continue;
    entries.push({ key: node.id, name: node.name, domain: node.domain, node,
      paths: state.tunnels.filter(t => t.id === node.primaryTunnelId || t.id === node.backupTunnelId || t.nodeIds.includes(node.id) || node.tunnelIds?.includes(t.id)),
      host: state.servers.find(s => s.id === node.foreignServerId) });
  }
  return entries;
}
export type StatusCandidate = ReturnType<typeof publicNodeCandidates>[number];

export function assessPublicNode(entry: StatusCandidate, state: StatusState, now: number, simulation: boolean,
  resolved?: { addresses: string[]; at: string }) {
  const tunnelAge = Math.max(90000, (state.settings.telemetryIntervals?.tunnelProbe ?? 120) * 2000 + 30000);
  const fresh = (at: string | undefined, ms: number) => simulation || statusFresh(at, now, ms);
  const selectedId = entry.node?.activeSide === "backup" ? entry.node.backupTunnelId : entry.node?.primaryTunnelId;
  const matchingDns = state.dns.find(record => normal(record.domain) === normal(entry.domain) && !record.stale);
  const observed = matchingDns?.resolverObservation;
  const observation = resolved ?? (observed?.complete ? { addresses: observed.aRecords, at: observed.checkedAt }
    : matchingDns && matchingDns.authoritativeStatus !== "error" && !matchingDns.proxied ? { addresses: matchingDns.aRecords, at: matchingDns.lastCheck } : undefined);
  // For directly linked panel nodes the resolved address determines which route users actually take.
  const dnsFresh = observation && fresh(observation.at, 300000);
  const tunnel = (dnsFresh ? entry.paths.find(t => observation.addresses.includes(t.iranEndpoint.publicIp)) : undefined)
    ?? entry.paths.find(t => t.id === selectedId)
    ?? entry.paths.find(t => t.side === "primary") ?? entry.paths[0];
  const iran = state.servers.find(s => s.id === tunnel?.iranEndpoint.serverId);
  const foreign = state.servers.find(s => s.id === tunnel?.foreignEndpoint.serverId) ?? entry.host;
  const directForeign = Boolean(dnsFresh && foreign && observation.addresses.length === 1 &&
    observation.addresses[0] === foreign.publicIpv4);
  const heartbeatAge = Math.max(90000, state.settings.monitoringIntervalSec * 3000);
  const agentState = (server?: Server): Quality => !server || !fresh(server.agent.lastHeartbeat, heartbeatAge) ? "unknown"
    : server.agent.status === "offline" ? "offline" : server.agent.status === "online" ? "healthy" : "degraded";
  const service = foreign?.services.find(s => s.name.toLowerCase() === "v2bx");
  const serviceAge = Math.max(90000, (state.settings.telemetryIntervals?.service ?? 20) * 3000);
  const v2bx: Quality = entry.node?.v2bxNodeState === "disabled" || entry.node?.v2bxNodeState === "config-error" ? "offline"
    : !service || !fresh(service.observedAt ?? foreign?.agent.lastHeartbeat, serviceAge) ? "unknown"
    : service.status === "running" ? "healthy" : service.status === "stopped" ? "offline" : "degraded";
  const path: Quality = !tunnel ? "offline" : !fresh(tunnel.lastCheck, tunnelAge) ? "unknown"
    : tunnel.status === "offline" ? "offline" : "healthy";
  const dns: Quality = !observation || !fresh(observation.at, 300000) || !iran && !directForeign ? "unknown"
    : directForeign || observation.addresses.length === 1 && observation.addresses[0] === iran?.publicIpv4 ? "healthy" : "offline";
  const requirements = directForeign ? [agentState(foreign), v2bx, dns] : [agentState(iran), agentState(foreign), v2bx, path, dns];
  const connection: Quality = requirements.includes("offline") ? "offline" : requirements.includes("unknown") ? "unknown"
    : requirements.includes("degraded") ? "degraded" : "healthy";
  const loss = tunnel?.packetLoss;
  // Forwarder probes report HTTP reachability, not measured packet loss.
  const measured = !directForeign && tunnel && tunnel.kind !== "forwarder" && path !== "unknown" && typeof loss === "number" && Number.isFinite(loss);
  const speed: Quality = !measured ? "unknown" : loss === 0 ? "healthy" : "degraded";
  const speedLabel = !measured ? "در حال بررسی" : loss === 0 ? "مناسب" : loss > 5 ? "اختلال جزئی" : "افت خفیف کیفیت";
  const stability: Quality = connection === "offline" ? "offline" : connection === "unknown" || speed === "unknown" ? "unknown"
    : connection === "healthy" && speed === "healthy" ? "healthy" : "degraded";
  const status: Quality = directForeign ? connection : stability;
  return { key: entry.key, nodeId: entry.node?.id, name: entry.name, location: foreign ? `${foreign.country} · ${foreign.city}` : "",
    country: foreign?.countryCode ?? "", status, connection, speed, speedLabel, stability };
}
