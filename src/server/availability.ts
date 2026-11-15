import type { AvailabilityCount, ObservedAvailability, TimeRange } from "@/types";
import { addAvailability, availabilityPct } from "@/lib/availability";
import { database } from "./database";
import { metricBucketMs, metricTime, rangeMs } from "./metrics";

const empty: AvailabilityCount = { samples: 0, successful: 0 };

export function observedAvailability(range: TimeRange, nodeIds: string[], tunnelIds?: string[]): ObservedAvailability {
  const through = Date.now();
  const since = through - rangeMs[range];
  const bucket = metricBucketMs(range);
  const db = database();
  const nodes = new Set(nodeIds);
  const rows = nodes.size ? db.prepare(`
    SELECT CAST(observed_at / ? AS INTEGER) * ? AS ts, probe.value ->> '$.nodeId' AS node_id,
      SUM(coalesce(probe.value ->> '$._counts.ok',1)) AS samples, SUM((probe.value ->> '$.ok') * coalesce(probe.value ->> '$._counts.ok',1)) AS successful
    FROM historical_reports, json_each(payload, '$.proxyProbes') AS probe
    WHERE observed_at BETWEEN ? AND ?
      AND COALESCE(probe.value ->> '$.side', 'active') = 'active'
    GROUP BY ts, node_id
  `).all(bucket, bucket, since, through) : [];

  const totals = new Map<string, AvailabilityCount>();
  const timeline = new Map<number, AvailabilityCount>();
  let proxy = empty;
  for (const row of rows) {
    const id = String(row.node_id);
    if (!nodes.has(id)) continue;
    const ts = Number(row.ts);
    const count = { samples: Number(row.samples), successful: Number(row.successful) };
    totals.set(id, addAvailability(totals.get(id) ?? empty, count));
    timeline.set(ts, addAvailability(timeline.get(ts) ?? empty, count));
    proxy = addAvailability(proxy, count);
  }

  const formatter = metricTime(range);
  const series: ObservedAvailability["series"] = [];
  for (let ts = Math.floor(since / bucket) * bucket; ts <= through; ts += bucket) {
    const count = timeline.get(ts) ?? empty;
    series.push({ ts, label: formatter.format(ts), ...count, availability: availabilityPct(count) });
  }

  const tunnels = new Set(tunnelIds);
  const tunnelRows = tunnels.size ? db.prepare(`
    WITH checks AS (
      SELECT probe.value ->> '$.tunnelId' AS id, (probe.value ->> '$.status') IN ('healthy','degraded') AS ok, coalesce(probe.value ->> '$._samples',1) AS samples, coalesce(probe.value ->> '$._successful', (probe.value ->> '$.status') IN ('healthy','degraded')) AS successful
      FROM historical_reports, json_each(payload, '$.tunnels') AS probe WHERE observed_at BETWEEN ? AND ?
      UNION ALL
      SELECT probe.value ->> '$.tunnelId', probe.value ->> '$.ok', coalesce(probe.value ->> '$._counts.ok',1), (probe.value ->> '$.ok') * coalesce(probe.value ->> '$._counts.ok',1)
      FROM historical_reports, json_each(payload, '$.forwarderChecks') AS probe WHERE observed_at BETWEEN ? AND ?
    )
    SELECT id, SUM(samples) AS samples, SUM(successful) AS successful FROM checks GROUP BY id
  `).all(since, through, since, through) : [];
  return {
    range, since, through, proxy, series,
    nodes: Object.fromEntries(totals),
    tunnels: Object.fromEntries(tunnelRows.flatMap((row) => {
      const id = String(row.id);
      return tunnels.has(id) ? [[id, { samples: Number(row.samples), successful: Number(row.successful) }]] : [];
    })),
  };
}
