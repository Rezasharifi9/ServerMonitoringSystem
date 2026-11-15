import { telemetryIntervals, type TelemetryIntervals, type TelemetryStream } from "./telemetry-policy";

const streams: Record<string, TelemetryStream> = {
  cpu: "cpu", ram: "ram", diskReadMiBps: "disk", diskWriteMiBps: "disk",
  rx: "traffic", tx: "traffic", bandwidth: "tunnelTraffic",
  serverRtt: "serverPing", serverLoss: "serverPing",
  rtt: "tunnelProbe", jitter: "tunnelProbe", loss: "tunnelProbe",
  forwardLatency: "tunnelProbe", availability: "proxy",
};

// Each metric has its own cadence: reports for another stream are not zero samples.
export function observedChartSeries(data: object[], key: string, configured: Partial<TelemetryIntervals> = {}, source?: TelemetryStream) {
  const stream = source ?? streams[key];
  const interval = stream ? configured[stream] ?? telemetryIntervals[stream] : 300;
  // Minute aggregation limits the precision of short sampling intervals.
  const maxGap = Math.max(60000, interval * 2000);
  const samples = data.map((point) => point as Record<string, unknown>)
    .filter((point) => typeof point.ts === "number" && Number.isFinite(point.ts)
      && typeof point[key] === "number" && Number.isFinite(point[key]))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const points: Record<string, unknown>[] = [];
  for (const sample of samples) {
    const previous = points.at(-1);
    if (previous && Number(sample.ts) - Number(previous.ts) > maxGap) {
      points.push({ ts: (Number(previous.ts) + Number(sample.ts)) / 2, [key]: null });
    }
    points.push(sample);
  }
  return { points, samples };
}
