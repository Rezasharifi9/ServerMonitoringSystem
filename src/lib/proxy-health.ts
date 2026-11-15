import type { AppSettings, Node } from "@/types";

export function summarizeProxyProbes(node: Node, settings: AppSettings, now = Date.now()) {
  const expected = node.proxyObservationSet?.expectedObservers ?? 1;
  const samples = node.proxyObservationSet?.samples ?? (node.proxyProbe ? [node.proxyProbe] : []);
  const cutoff = Math.max(now - Math.max(90, settings.monitoringIntervalSec * 3) * 1000, Date.parse(node.lastFailoverAt ?? "") || 0);
  const fresh = samples.filter(({ observedAt }) => {
    const observed = Date.parse(observedAt);
    return observed > cutoff && observed <= now + 30000;
  });
  const required = Math.min(2, Math.max(1, expected));
  const successful = fresh.filter((sample) => sample.ok).length;
  const failed = fresh.length - successful;
  if (!fresh.length) return "unobserved";
  if (successful && failed) return "mixed";
  if (fresh.length < required) return "insufficient";
  return successful ? "up" : "down";
}
