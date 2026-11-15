import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { activityCategories, activityFromAudit, isActivityCategory } from "@/lib/activity";
import type { ActivityCategory, ActivityEntry, ActivityPage, AuditEvent } from "@/types";

export function pushAudit(
  state: { audit: AuditEvent[] },
  actor: { name: string; role: AuditEvent["role"] },
  action: string,
  target: string,
  detail: string,
) {
  state.audit = [{
    id: randomUUID(),
    at: new Date().toISOString(),
    actor: actor.name,
    role: actor.role,
    action,
    target: target.slice(0, 200),
    detail: detail.slice(0, 500),
    simulated: false,
  }, ...state.audit].slice(0, 2000);
}

export function storeActivity(db: DatabaseSync, entries: AuditEvent[], retentionDays: number) {
  if (!entries.length) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO activity_logs (
      id, ts_ms, category, action, actor, role, target, server_id, node_id, tunnel_id, outcome, searchable, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of entries.slice().reverse()) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;
    const record = activityFromAudit(entry);
    insert.run(
      record.id, at, record.category, record.action, record.actor, record.role, record.target,
      record.serverId ?? null, record.nodeId ?? null, record.tunnelId ?? null, record.outcome,
      `${record.action} ${record.actor} ${record.target} ${record.detail}`.toLowerCase(),
      JSON.stringify(record),
    );
  }
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? Math.min(retentionDays, 3650) : 30;
  db.prepare("DELETE FROM activity_logs WHERE ts_ms < ?").run(Date.now() - days * 86400000);
}

export function readActivity(db: DatabaseSync, filters: {
  minutes: number; page: number; limit: number; from?: number; to?: number;
  category?: string | null; server?: string | null; node?: string | null; search?: string | null;
}): ActivityPage {
  const end = filters.to ?? Date.now();
  const start = filters.from ?? end - filters.minutes * 60000;
  const clauses = ["ts_ms >= ?", "ts_ms <= ?"];
  const args: (string | number)[] = [start, end];
  if (filters.server) {
    clauses.push("(server_id = ? OR target = ?)");
    args.push(filters.server, filters.server);
  }
  if (filters.node) {
    clauses.push("(node_id = ? OR target = ?)");
    args.push(filters.node, filters.node);
  }
  if (filters.search) {
    clauses.push("instr(searchable, ?) > 0");
    args.push(filters.search);
  }
  const base = clauses.join(" AND ");
  const summary = Object.fromEntries(activityCategories.map((item) => [item, 0])) as Record<ActivityCategory, number>;
  for (const row of db.prepare(`SELECT category, COUNT(*) AS n FROM activity_logs WHERE ${base} GROUP BY category`).all(...args)) {
    const category = String(row.category);
    if (isActivityCategory(category)) summary[category] = Number(row.n);
  }
  const category = filters.category && isActivityCategory(filters.category) ? filters.category : undefined;
  const where = category ? `${base} AND category = ?` : base;
  const scoped = category ? [...args, category] : args;
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM activity_logs WHERE ${where}`).get(...scoped)?.n ?? 0);
  const rows = db.prepare(`SELECT payload FROM activity_logs WHERE ${where} ORDER BY ts_ms DESC, seq DESC LIMIT ? OFFSET ?`)
    .all(...scoped, filters.limit, (filters.page - 1) * filters.limit);
  return {
    data: rows.map((row) => JSON.parse(String(row.payload)) as ActivityEntry),
    page: filters.page,
    limit: filters.limit,
    total,
    summary,
    from: start,
    to: end,
  };
}
