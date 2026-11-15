import { isIranServer } from "@/lib/topology";
import type { Server, TimeRange } from "@/types";
import { database } from "./database";
import { z } from "zod";
import { ApiError } from "./http";

export const rangeMs: Record<TimeRange, number> = {
  "15m": 900000, "1h": 3600000, "6h": 21600000,
  "24h": 86400000, "7d": 604800000, "30d": 2592000000,
};

export function metricTime(range: TimeRange) {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    ...(range === "7d" || range === "30d" ? { month: "numeric", day: "numeric" } : {}),
    hour: "2-digit", minute: "2-digit",
    ...(range === "15m" ? { second: "2-digit" } : {}),
  });
}

export function metricBucketMs(range: TimeRange) {
  if (range === "30d") return 3600000;
  if (range === "7d") return 900000;
  if (range === "24h") return 300000;
  return 60000;
}

const hostFields = ["cpu", "ram", "serverRtt", "serverLoss", "diskReadMiBps", "diskWriteMiBps", "rx", "tx"] as const;
const tunnelFields = ["rtt", "jitter", "loss", "bandwidth", "forwardLatency"] as const;

function weighted(json: string, path: string, condition = "1") {
  const segments = path.slice(2).split(".");
  const field = segments.pop()!;
  const countPath = "$." + [...segments, "_counts", field].join(".");
  const summary = `json_extract(${json}, '$._summary')=1`;
  const value = condition === "1" ? `json_extract(${json}, '${path}')`
    : `CASE WHEN ${summary} THEN json_extract(${json}, '$._valid.${field}') WHEN ${condition} THEN json_extract(${json}, '${path}') END`;
  const count = condition === "1" ? `coalesce(json_extract(${json}, '${countPath}'),1)`
    : `CASE WHEN ${summary} THEN json_extract(${json}, '$._valid._counts.${field}') ELSE 1 END`;
  return `1.0 * SUM((${value}) * (${count})) /
    NULLIF(SUM(CASE WHEN (${value}) IS NOT NULL THEN (${count}) END),0)`;
}

export function observedMetrics(range: TimeRange, serverId?: string, tunnelId?: string, bounds?: { from: number; to: number }) {
  const through = bounds?.to ?? Date.now();
  const since = bounds?.from ?? through - rangeMs[range];
  const bucket = Math.max(metricBucketMs(range), Math.ceil((through - since) / 1000 / 60000) * 60000);
  const db = database();
  const hosts = tunnelId ? [] : db.prepare(`
    SELECT CAST(observed_at / ? AS INTEGER) * ? AS ts,
           ${weighted("payload", "$.cpu")} AS cpu,
           ${weighted("payload", "$.ram")} AS ram,
           ${weighted("payload", "$.serverPing.rttMs")} AS serverRtt,
           ${weighted("payload", "$.serverPing.packetLoss")} AS serverLoss,
           ${weighted("payload", "$.diskIo.readMiBps")} AS diskReadMiBps,
           ${weighted("payload", "$.diskIo.writeMiBps")} AS diskWriteMiBps,
           ${weighted("payload", "$.rxMbps")} AS rx,
           ${weighted("payload", "$.txMbps")} AS tx
    FROM historical_reports WHERE observed_at >= ? AND observed_at <= ? AND (? IS NULL OR server_id = ?)
    GROUP BY ts ORDER BY ts
  `).all(bucket, bucket, since, through, serverId ?? null, serverId ?? null);
  const links = serverId ? [] : db.prepare(`
    SELECT CAST(observed_at / ? AS INTEGER) * ? AS ts,
           ${weighted("j.value", "$.rttMs", "json_extract(j.value, '$.rttMs') <> 0")} AS rtt,
           ${weighted("j.value", "$.jitterMs", "json_extract(j.value, '$.packetLoss') < 100")} AS jitter,
           ${weighted("j.value", "$.packetLoss")} AS loss,
           (${weighted("j.value", "$.rxMbps")} + ${weighted("j.value", "$.txMbps")}) AS bandwidth
    FROM historical_reports, json_each(payload, '$.tunnels') AS j
    WHERE observed_at >= ? AND observed_at <= ? AND (? IS NULL OR json_extract(j.value, '$.tunnelId') = ?)
    GROUP BY ts ORDER BY ts
  `).all(bucket, bucket, since, through, tunnelId ?? null, tunnelId ?? null);
  const throughput = serverId ? [] : db.prepare(`
    SELECT CAST(observed_at / ? AS INTEGER) * ? AS ts,
           (${weighted("j.value", "$.rxMbps")} + ${weighted("j.value", "$.txMbps")}) AS bandwidth
    FROM historical_reports, json_each(payload, '$.tunnelTraffic') AS j
    WHERE observed_at >= ? AND observed_at <= ? AND (? IS NULL OR json_extract(j.value, '$.tunnelId') = ?)
    GROUP BY ts ORDER BY ts
  `).all(bucket, bucket, since, through, tunnelId ?? null, tunnelId ?? null);
  const forwards = !tunnelId || serverId ? [] : db.prepare(`
    SELECT CAST(observed_at / ? AS INTEGER) * ? AS ts,
           ${weighted("j.value", "$.elapsedMs", "json_extract(j.value, '$.ok')=1")} AS forwardLatency
    FROM historical_reports, json_each(payload, '$.forwarderChecks') AS j
    WHERE observed_at >= ? AND observed_at <= ? AND json_extract(j.value, '$.tunnelId')=?
    GROUP BY ts ORDER BY ts
  `).all(bucket, bucket, since, through, tunnelId);
  const rows = new Map<number, Record<string, number>>();
  for (const row of [...hosts, ...links, ...throughput, ...forwards]) {
    const ts = Number(row.ts);
    const values = Object.fromEntries(Object.entries(row).flatMap(([key, value]) =>
      key !== "ts" && typeof value === "number" ? [[key, value]] : []));
    if (Object.keys(values).length) rows.set(ts, { ...rows.get(ts), ...values });
  }
  const fields = tunnelId ? tunnelFields : serverId ? hostFields : [...hostFields, ...tunnelFields];
  const formatter = metricTime(range);
  const start = Math.floor(since / bucket) * bucket;
  const end = Math.floor(through / bucket) * bucket;
  const series: Record<string, number | string | null>[] = [];
  for (let ts = start; ts <= end; ts += bucket) {
    const observed = rows.get(ts);
    const point: Record<string, number | string | null> = { ts, label: formatter.format(ts) };
    for (const field of fields) point[field] = observed?.[field] ?? null;
    series.push(point);
  }
  return series;
}

const reportStreams = {
  cpu: { scope: "server", fields: { cpu: "$.cpu" } },
  ram: { scope: "server", fields: { ram: "$.ram" } },
  disk: { scope: "server", fields: { disk: "$.disk", diskReadMiBps: "$.diskIo.readMiBps", diskWriteMiBps: "$.diskIo.writeMiBps" } },
  traffic: { scope: "server", fields: { rxMbps: "$.rxMbps", txMbps: "$.txMbps" } },
  serverPing: { scope: "server", fields: { rttMs: "$.serverPing.rttMs", packetLoss: "$.serverPing.packetLoss" } },
  tunnelProbe: { scope: "tunnel", path: "$.tunnels", fields: { rttMs: "$.rttMs", jitterMs: "$.jitterMs", packetLoss: "$.packetLoss" } },
  tunnelTraffic: { scope: "tunnel", path: "$.tunnelTraffic", fields: { rxMbps: "$.rxMbps", txMbps: "$.txMbps" } },
  forwarder: { scope: "tunnel", path: "$.forwarderChecks", fields: { ok: "$.ok", elapsedMs: "$.elapsedMs" } },
} as const;

export function observedSampleReport(query: URLSearchParams) {
  const input = z.object({ stream: z.enum(["cpu", "ram", "disk", "traffic", "serverPing", "tunnelProbe", "tunnelTraffic", "forwarder"]),
    id: z.string().min(1).max(96), days: z.coerce.number().int().min(1).max(30) }).safeParse(Object.fromEntries(query));
  if (!input.success) throw new ApiError(422, "METRIC_REPORT", "سنجه، مقصد یا بازهٔ گزارش معتبر نیست.");
  const { stream, id, days } = input.data;
  const spec = reportStreams[stream];
  const json = spec.scope === "tunnel" ? "sample.value" : "payload";
  const fields = Object.entries(spec.fields);
  const selectors = fields.map(([name, path]) => `json_extract(${json}, '${path}') AS ${name}`);
  selectors.push(`CASE WHEN json_extract(payload, '$._summary')=1 THEN 'summary' ELSE 'raw' END AS sampleKind`);
  for (const [name, path] of fields) {
    const parts = path.slice(2).split(".");
    const leaf = parts.pop()!;
    for (const [suffix, meta] of [["Min", "_min"], ["Max", "_max"], ["Count", "_counts"]]) {
      const metaPath = "$." + [...parts, meta, leaf].join(".");
      selectors.push(`coalesce(json_extract(${json}, '${metaPath}'), ${suffix === "Count" ? "1" : `json_extract(${json}, '${path}')`}) AS ${name}${suffix}`);
    }
  }
  const present = fields.map(([, path]) => `json_type(${json}, '${path}') IS NOT NULL`).join(" OR ");
  const source = spec.scope === "tunnel" ? `historical_reports, json_each(payload, '${spec.path}') AS sample` : "historical_reports";
  const owner = spec.scope === "tunnel" ? "json_extract(sample.value, '$.tunnelId')" : "server_id";
  const time = spec.scope === "tunnel" ? "coalesce(json_extract(sample.value, '$.measuredAt'), json_extract(payload, '$.observedAt'))" : "json_extract(payload, '$.observedAt')";
  const legacyTraffic = stream === "tunnelTraffic" ? `UNION ALL SELECT observed_at, coalesce(json_extract(sample.value, '$.measuredAt'),json_extract(payload,'$.observedAt')),
    ${selectors.join(",")} FROM historical_reports, json_each(payload,'$.tunnels') AS sample
    WHERE observed_at>=? AND json_extract(sample.value,'$.tunnelId')=? AND json_type(sample.value,'$.rxMbps') IS NOT NULL` : "";
  const since = Date.now() - days * 86400000;
  const rows = database().prepare(`SELECT observed_at, ${time} AS sampledAt, ${selectors.join(",")}
    FROM ${source} WHERE observed_at>=? AND ${owner}=? AND (${present}) ${legacyTraffic}
    ORDER BY observed_at DESC LIMIT 10001`).all(...(legacyTraffic ? [since, id, since, id] : [since, id]));
  return { fields: [...fields.map(([name]) => name), "sampleKind", ...fields.flatMap(([name]) => [name + "Min", name + "Max", name + "Count"])], samples: rows.slice(0, 10000).map(({ observed_at, ...row }) => ({
    ...row, sampledAt: row.sampledAt ?? new Date(Number(observed_at)).toISOString(),
  })), limited: rows.length > 10000 };
}

export function iranBandwidth(range: TimeRange, servers: Server[], now = Date.now()) {
  const ids = servers.filter((server) => isIranServer(server.roles)).map((server) => server.id);
  const bucket = metricBucketMs(range);
  const rows = ids.length ? database().prepare(`
    SELECT ts, SUM(rx + tx) AS bandwidth, COUNT(*) AS reporting FROM (
      SELECT CAST(observed_at / ? AS INTEGER) * ? AS ts, server_id,
        ${weighted("payload", "$.rxMbps")} AS rx, ${weighted("payload", "$.txMbps")} AS tx
      FROM historical_reports WHERE observed_at BETWEEN ? AND ? AND server_id IN (${ids.map(() => "?").join(",")})
        AND json_type(payload, '$.rxMbps') IN ('integer', 'real') AND json_type(payload, '$.txMbps') IN ('integer', 'real')
      GROUP BY ts, server_id
    ) GROUP BY ts ORDER BY ts
  `).all(bucket, bucket, now - rangeMs[range], now, ...ids) : [];
  const byTime = new Map(rows.map((row) => [Number(row.ts), row]));
  const series = [];
  const formatter = metricTime(range);
  for (let ts = Math.floor((now - rangeMs[range]) / bucket) * bucket; ts <= now; ts += bucket) {
    const row = byTime.get(ts);
    // Partial fleet snapshots must not masquerade as fleet totals.
    series.push({ ts, label: formatter.format(ts), bandwidth: row && Number(row.reporting) === ids.length ? Number(row.bandwidth) : null });
  }
  return series;
}
