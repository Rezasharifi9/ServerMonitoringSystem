import type { DatabaseSync } from "node:sqlite";

// Project activity from durable work, so every browser sees the same host lock.
export function serverActivities(db: DatabaseSync, now = Date.now()) {
  const activity = new Map<string, string>();
  for (const row of db.prepare(`SELECT server_id, operation FROM provision_jobs
    WHERE status='running' OR (status='queued' AND queue_until>?) ORDER BY created_at`).all(now)) {
    activity.set(String(row.server_id), String(row.operation ?? "apply"));
  }
  for (const row of db.prepare(`SELECT iran_id, foreign_id FROM tunnel_deployments
    WHERE status IN ('deploying','verifying','rolling_back')`).all()) {
    activity.set(String(row.iran_id), "tunnel");
    activity.set(String(row.foreign_id), "tunnel");
  }
  for (const row of db.prepare(`SELECT server_id, owner FROM ssh_operation_leases WHERE expires_at>?`).all(now)) {
    activity.set(String(row.server_id), String(row.owner).split("/")[0]);
  }
  return activity;
}
