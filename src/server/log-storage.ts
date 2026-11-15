import type { DatabaseSync } from "node:sqlite";
import type { LogEntry } from "@/types";

export function storeMonitorLogs(db: DatabaseSync, entries: LogEntry[]) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO monitor_logs (id, ts_ms, server_id, node_id, source, severity, searchable, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seen = db.prepare("INSERT OR IGNORE INTO monitor_log_events VALUES (?,?)");
  const duplicate = db.prepare(`SELECT seq,payload FROM monitor_logs WHERE server_id IS ? AND node_id IS ?
    AND source=? AND severity=? AND ts_ms>=? AND ts_ms<? AND searchable=?
    AND json_extract(payload,'$.message')=? LIMIT 1`);
  for (const log of entries) {
    const at = Date.parse(log.ts);
    if (!Number.isFinite(at)) continue;
    if (!seen.run(log.id, at).changes || db.prepare("SELECT 1 FROM monitor_logs WHERE id=?").get(log.id)) continue;
    const bucket = Math.floor(at / 300000) * 300000;
    const repeated = ["INFO", "DEBUG"].includes(log.severity) ? duplicate.get(log.serverId ?? null, log.nodeId ?? null,
      log.source, log.severity, bucket, bucket + 300000, log.message.toLowerCase(), log.message) : undefined;
    if (repeated) {
      const entry = JSON.parse(String(repeated.payload)) as LogEntry;
      entry.repeatCount = (entry.repeatCount ?? 1) + 1;
      entry.lastTs = !entry.lastTs || Date.parse(log.ts) > Date.parse(entry.lastTs) ? log.ts : entry.lastTs;
      db.prepare("UPDATE monitor_logs SET payload=? WHERE seq=?").run(JSON.stringify(entry), repeated.seq!);
    } else insert.run(log.id, at, log.serverId ?? null, log.nodeId ?? null, log.source, log.severity,
      log.message.toLowerCase(), JSON.stringify(log));
  }
}

export function readMonitorLogs(db: DatabaseSync, filters: {
  minutes: number; page: number; limit: number; through: number; watermark?: number;
  node?: string | null; server?: string | null; source?: string | null; severity?: string | null; search?: string;
  v2bxHosts?: string[];
}) {
  const { minutes, page, limit, through } = filters;
  const latest = Number(db.prepare("SELECT coalesce(MAX(seq), 0) AS seq FROM monitor_logs").get()?.seq ?? 0);
  const watermark = Math.min(filters.watermark ?? latest, latest);
  const clauses = ["ts_ms >= ?", "ts_ms <= ?", "seq <= ?"];
  const args: (string | number)[] = [through - minutes * 60000, through, watermark];
  const scopes = [
    ["server_id", filters.server], ["node_id", filters.node], ["source", filters.source === "v2bx" ? null : filters.source], ["severity", filters.severity],
  ];
  if (filters.source === "v2bx") clauses.push("source IN ('v2bx-node','v2bx-shared')");
  if (filters.v2bxHosts) {
    clauses.push("(source NOT IN ('v2bx-node','v2bx-shared') OR server_id IN (SELECT value FROM json_each(?)))");
    args.push(JSON.stringify(filters.v2bxHosts));
  }
  for (const [column, value] of scopes) {
    if (!value) continue;
    clauses.push(column + " = ?");
    args.push(value);
  }
  if (filters.search) {
    clauses.push("instr(searchable, ?) > 0");
    args.push(filters.search);
  }
  const where = clauses.join(" AND ");
  const rows = db.prepare(`SELECT payload FROM monitor_logs WHERE ${where} ORDER BY ts_ms DESC, seq DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, (page - 1) * limit);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM monitor_logs WHERE ${where}`).get(...args)?.n ?? 0);
  return { data: rows.map((row) => JSON.parse(String(row.payload)) as LogEntry), page, limit, total, snapshot: { through, watermark } };
}
