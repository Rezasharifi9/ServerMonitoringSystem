import type { DatabaseSync } from "node:sqlite";

const minute = 60000;
export const RAW_HISTORY_DAYS = 3;
// Telemetry JSON is recursive and carries arbitrary metric names.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sample = Record<string, any>;

/** Merge means using their original sample counts, retaining peaks and failures. */
export function summarizeTelemetry(samples: Sample[], observedAt: number): Sample {
  const result: Sample = { observedAt: new Date(observedAt).toISOString(), _summary: true, _counts: {}, _min: {}, _max: {} };
  const keys = new Set(samples.flatMap((sample) => Object.keys(sample)));
  for (const key of keys) {
    if (key.startsWith("_") || key === "observedAt" || key === "measuredAt" || key === "hardware") continue;
    const present = samples.filter((sample) => sample[key] !== undefined && sample[key] !== null);
    if (!present.length) continue;
    const value = present[0][key];
    if (typeof value === "number" || typeof value === "boolean") {
      let count = 0, sum = 0, min = Infinity, max = -Infinity;
      for (const sample of present) {
        const n = Number(sample[key]);
        if (!Number.isFinite(n)) continue;
        const weight = sample._counts?.[key] ?? 1;
        count += weight;
        sum += n * weight;
        min = Math.min(min, sample._min?.[key] ?? n);
        max = Math.max(max, sample._max?.[key] ?? n);
      }
      if (count) {
        result[key] = sum / count;
        result._counts[key] = count;
        result._min[key] = min;
        result._max[key] = max;
      }
    } else if (Array.isArray(value)) {
      const groups = new Map<string, Sample[]>();
      for (const sample of present) for (const item of sample[key]) {
        const id = JSON.stringify([item.tunnelId ?? item.nodeId, item.side ?? "active"]);
        groups.set(id, [...(groups.get(id) ?? []), item]);
      }
      result[key] = [...groups.values()].map((items) => {
        const summary = summarizeTelemetry(items, observedAt);
        if (key === "tunnels") {
          summary._samples = items.reduce((n, item) => n + (item._samples ?? 1), 0);
          summary._successful = items.reduce((n, item) => n + (item._successful ?? Number(["healthy", "degraded"].includes(item.status))), 0);
        }
        return summary;
      });
    } else if (typeof value === "object") {
      result[key] = summarizeTelemetry(present.map((sample) => sample[key]), observedAt);
    } else {
      result[key] = value;
    }
  }
  // Conditional means must exclude failed probes even after several rollup tiers.
  result._valid = { _counts: {}, _min: {}, _max: {} };
  for (const key of ["rttMs", "jitterMs", "elapsedMs"]) {
    let count = 0, sum = 0, min = Infinity, max = -Infinity;
    for (const sample of samples) {
      const valid = key === "rttMs" ? sample[key] > 0 : key === "jitterMs" ? sample.packetLoss < 100 : sample.ok === true || sample.ok === 1;
      const value = sample._summary ? sample._valid?.[key] : valid ? sample[key] : undefined;
      if (typeof value !== "number") continue;
      const weight = sample._summary ? sample._valid._counts[key] : 1;
      sum += value * weight;
      count += weight;
      min = Math.min(min, sample._valid?._min?.[key] ?? value);
      max = Math.max(max, sample._valid?._max?.[key] ?? value);
    }
    if (count) {
      result._valid[key] = sum / count;
      result._valid._counts[key] = count;
      result._valid._min[key] = min;
      result._valid._max[key] = max;
    }
  }
  return result;
}

/** Bounded, transactional housekeeping. Never runs on every heartbeat. */
export function maintainTelemetryHistory(db: DatabaseSync, retentionDays: number, now = Date.now()) {
  const last = Number(db.prepare("SELECT value FROM workspace_meta WHERE key='telemetry_housekeeping'").get()?.value ?? 0);
  if (now - last < minute) return;
  const retainedSince = now - retentionDays * 86400000;
  const rawUntil = Math.floor((now - Math.min(RAW_HISTORY_DAYS, retentionDays) * 86400000) / (5 * minute)) * 5 * minute;
  const earliest = db.prepare("SELECT observed_at FROM agent_reports WHERE observed_at>=? AND observed_at<? ORDER BY observed_at LIMIT 1")
    .get(retainedSince, rawUntil);
  const firstBucket = earliest ? Math.floor(Number(earliest.observed_at) / (5 * minute)) * 5 * minute : rawUntil;
  const groups = db.prepare(`SELECT server_id, ? AS bucket
    FROM agent_reports WHERE observed_at>=? AND observed_at<? AND observed_at>=?
    GROUP BY server_id LIMIT 32`).all(firstBucket, firstBucket, Math.min(firstBucket + 5 * minute, rawUntil), retainedSince);
  const archive = db.prepare(`INSERT INTO telemetry_history VALUES (?,?,?,?)
    ON CONFLICT(server_id,observed_at,step_ms) DO UPDATE SET payload=excluded.payload`);
  for (const group of groups) {
    const bucket = Number(group.bucket);
    const rows = db.prepare("SELECT payload FROM agent_reports WHERE server_id=? AND observed_at>=? AND observed_at<?")
      .all(group.server_id!, bucket, bucket + 5 * minute);
    const previous = db.prepare("SELECT payload FROM telemetry_history WHERE server_id=? AND observed_at=? AND step_ms=?")
      .get(group.server_id!, bucket, 5 * minute);
    const payloads = [...rows, ...(previous ? [previous] : [])].map((row) => JSON.parse(String(row.payload)));
    archive.run(group.server_id!, bucket, 5 * minute, JSON.stringify(summarizeTelemetry(payloads, bucket)));
    db.prepare("DELETE FROM agent_reports WHERE server_id=? AND observed_at>=? AND observed_at<?")
      .run(group.server_id!, bucket, bucket + 5 * minute);
  }
  const hourlyUntil = Math.floor((now - 30 * 86400000) / (60 * minute)) * 60 * minute;
  const old = db.prepare(`SELECT server_id, CAST(observed_at / ? AS INTEGER) * ? AS bucket
    FROM telemetry_history WHERE step_ms=? AND observed_at<?
    GROUP BY server_id,bucket ORDER BY bucket LIMIT 32`).all(60 * minute, 60 * minute, 5 * minute, hourlyUntil);
  for (const group of old) {
    const bucket = Number(group.bucket);
    const rows = db.prepare("SELECT payload FROM telemetry_history WHERE server_id=? AND observed_at>=? AND observed_at<?")
      .all(group.server_id!, bucket, bucket + 60 * minute);
    archive.run(group.server_id!, bucket, 60 * minute,
      JSON.stringify(summarizeTelemetry(rows.map((row) => JSON.parse(String(row.payload))), bucket)));
    db.prepare("DELETE FROM telemetry_history WHERE server_id=? AND observed_at>=? AND observed_at<? AND step_ms=?")
      .run(group.server_id!, bucket, bucket + 60 * minute, 5 * minute);
  }
  const routineSince = now - Math.min(7, retentionDays) * 86400000;
  // Retention deletes also need a bound: an existing multi-GB database can contain
  // millions of expired rows when this policy is first deployed.
  let expiredBacklog = false;
  for (const [table, key, predicate, cutoff] of [
    ["agent_reports", "rowid", "observed_at<?", retainedSince],
    ["telemetry_history", "rowid", "observed_at<?", retainedSince],
    ["monitor_logs", "seq", "ts_ms<? AND severity IN ('DEBUG','INFO')", routineSince],
    ["monitor_logs", "seq", "ts_ms<?", retainedSince],
    ["monitor_log_events", "rowid", "ts_ms<?", routineSince],
  ] as const) {
    const deleted = db.prepare(`DELETE FROM ${table} WHERE ${key} IN
      (SELECT ${key} FROM ${table} WHERE ${predicate} LIMIT 500)`).run(cutoff);
    if (Number(deleted.changes) === 500) expiredBacklog = true;
  }
  const backlog = db.prepare("SELECT 1 FROM agent_reports WHERE observed_at>=? AND observed_at<? LIMIT 1").get(retainedSince, rawUntil);
  // While migrating a backlog, continue on the next report; steady state runs once a minute.
  db.prepare("INSERT OR REPLACE INTO workspace_meta VALUES ('telemetry_housekeeping',?)")
    .run(String(backlog || expiredBacklog || old.length === 32 ? now - minute : now));
}
