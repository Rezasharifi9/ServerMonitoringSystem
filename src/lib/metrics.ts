import type { MetricPoint, TimeRange } from "@/types";
import { chartLabel } from "@/lib/format";
import { clamp, mulberry32 } from "@/lib/utils";

const RANGE_MS: Record<TimeRange, { span: number; points: number }> = {
  "15m": { span: 15 * 60 * 1000, points: 30 },
  "1h": { span: 60 * 60 * 1000, points: 36 },
  "6h": { span: 6 * 60 * 60 * 1000, points: 36 },
  "24h": { span: 24 * 60 * 60 * 1000, points: 48 },
  "7d": { span: 7 * 24 * 60 * 60 * 1000, points: 42 },
  "30d": { span: 30 * 24 * 60 * 60 * 1000, points: 30 },
};

export function rangeMeta(range: TimeRange) {
  return RANGE_MS[range];
}

export function buildMetrics(range: TimeRange, seedKey: string, stress = 0): MetricPoint[] {
  const { span, points } = RANGE_MS[range];
  const rand = mulberry32(
    seedKey.split("").reduce((sum, char) => sum + char.charCodeAt(0), 17) + Math.round(stress * 100),
  );
  const end = Date.now();
  const step = span / (points - 1);
  return Array.from({ length: points }, (_, index) => {
    const progress = index / (points - 1);
    const ts = end - span + step * index;
    const wave = Math.sin(progress * Math.PI * 4 + rand());
    const recent = progress > 0.82 ? (progress - 0.82) / 0.18 : 0;
    const stressHit = stress * recent;
    const availability = clamp(99.2 + wave * 0.35 - stressHit * 8 - rand() * 0.15, 70, 100);
    const rtt = clamp(38 + wave * 8 + stressHit * 140 + rand() * 6, 8, 420);
    const loss = clamp(0.15 + Math.max(0, wave) * 0.2 + stressHit * 6 + rand() * 0.1, 0, 30);
    const bandwidth = clamp(620 + wave * 80 - stressHit * 260 + rand() * 30, 20, 2000);
    return {
      ts,
      label: chartLabel(ts, span),
      availability: Number(availability.toFixed(2)),
      rtt: Number(rtt.toFixed(1)),
      loss: Number(loss.toFixed(2)),
      bandwidth: Number(bandwidth.toFixed(1)),
      cpu: Number(clamp(34 + wave * 8 + stressHit * 25 + rand() * 4, 8, 98).toFixed(1)),
      ram: Number(clamp(48 + wave * 6 + rand() * 3, 15, 96).toFixed(1)),
      rx: Number(clamp(280 + wave * 40 + rand() * 20, 10, 1500).toFixed(1)),
      tx: Number(clamp(260 + wave * 36 + rand() * 18, 10, 1400).toFixed(1)),
      incidents: stressHit > 0.45 && index % 7 === 0 ? 1 : rand() > 0.93 ? 1 : 0,
      failovers: stressHit > 0.7 && index === points - 2 ? 1 : rand() > 0.97 ? 1 : 0,
    };
  });
}

export function buildEntitySeries(
  range: TimeRange,
  seedKey: string,
  base: { rtt: number; loss: number; rx: number; tx: number; offline?: boolean },
) {
  const { span, points } = RANGE_MS[range];
  const rand = mulberry32(seedKey.split("").reduce((sum, char) => sum + char.charCodeAt(0), 91));
  const step = span / (points - 1);
  const end = Date.now();
  return Array.from({ length: points }, (_, index) => {
    const progress = index / (points - 1);
    const wave = Math.sin(progress * Math.PI * 6 + rand());
    const drop = base.offline && progress > 0.75 ? (progress - 0.75) / 0.25 : 0;
    const ts = end - span + step * index;
    return {
      ts,
      label: chartLabel(ts, span),
      rtt: Number(clamp(base.rtt + wave * 6 + drop * 80, 1, 500).toFixed(1)),
      loss: Number(clamp(base.loss + Math.max(0, wave) * 0.3 + drop * 40, 0, 100).toFixed(2)),
      rx: Number(clamp(base.rx * (1 - drop) + wave * 8, 0, 2000).toFixed(1)),
      tx: Number(clamp(base.tx * (1 - drop) + wave * 7, 0, 2000).toFixed(1)),
      cpu: Number(clamp(30 + wave * 10 + rand() * 5, 5, 99).toFixed(1)),
      ram: Number(clamp(46 + wave * 4, 10, 97).toFixed(1)),
    };
  });
}
