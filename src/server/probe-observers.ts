import { z } from "zod";
import type { Node, ProxyProbeReading } from "@/types";

const id = z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i);

export function observersByNode() {
  return z.record(id, z.union([id, z.array(id).min(1).max(8)]))
    .parse(JSON.parse(process.env.NODEGUARD_PROXY_OBSERVERS ?? "{}"));
}

export function observerIds(config: ReturnType<typeof observersByNode>, nodeId: string) {
  const value = Object.hasOwn(config, nodeId) ? config[nodeId] : undefined;
  return value ? new Set(typeof value === "string" ? [value] : value) : new Set<string>();
}

export function independentObservers(config: ReturnType<typeof observersByNode>, node: Node) {
  const ids = observerIds(config, node.id);
  for (const serverId of [node.primaryServerId, node.backupServerId, node.foreignServerId]) {
    if (serverId) ids.delete(serverId);
  }
  return ids;
}

export function projectProxyObservations(node: Node, ids: Set<string>, reading?: ProxyProbeReading): Node {
  const previous = node.proxyObservationSet?.samples ?? (node.proxyProbe ? [node.proxyProbe] : []);
  const samples = previous.filter((sample) => ids.has(sample.serverId) && sample.serverId !== reading?.serverId);
  if (reading) samples.push(reading);
  samples.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  return { ...node, proxyProbe: samples[0], proxyObservationSet: { expectedObservers: ids.size, samples } };
}

export function projectObserverHealth(nodes: Node[]) {
  let config: ReturnType<typeof observersByNode>;
  try {
    config = observersByNode();
  } catch {
    // An invalid allowlist invalidates stored probe evidence. Ingest still rejects the configuration.
    config = {};
  }
  return nodes.map((node) => projectProxyObservations(node, independentObservers(config, node)));
}
