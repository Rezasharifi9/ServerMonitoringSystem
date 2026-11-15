import type { DatabaseSync } from "node:sqlite";
import type { AgentWorker } from "@/types";

const kinds = ["iperf", "provision"] as const;
const pollWindow = 45000;

export function markWorkerPoll(db: DatabaseSync, serverId: string, kind: AgentWorker["kind"], now: number, canRemove = false, canDownload = false, canRestartV2bx = false, canIptables = false, canReboot = false, canRemoveV2bx = false) {
  db.prepare(`
    INSERT INTO agent_worker_polls (server_id, kind, last_seen, can_remove, can_download, can_restart_v2bx, can_iptables, can_reboot, can_remove_v2bx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (server_id, kind) DO UPDATE SET last_seen=excluded.last_seen, can_remove=excluded.can_remove,
      can_download=excluded.can_download, can_restart_v2bx=excluded.can_restart_v2bx, can_iptables=excluded.can_iptables,
      can_reboot=excluded.can_reboot, can_remove_v2bx=excluded.can_remove_v2bx
    WHERE agent_worker_polls.last_seen <= excluded.last_seen - 5000 OR agent_worker_polls.can_remove<>excluded.can_remove
      OR agent_worker_polls.can_download<>excluded.can_download OR agent_worker_polls.can_restart_v2bx<>excluded.can_restart_v2bx
      OR agent_worker_polls.can_iptables<>excluded.can_iptables OR agent_worker_polls.can_reboot<>excluded.can_reboot
      OR agent_worker_polls.can_remove_v2bx<>excluded.can_remove_v2bx
  `).run(serverId, kind, now, Number(canRemove), Number(canDownload), Number(canRestartV2bx), Number(canIptables), Number(canReboot), Number(canRemoveV2bx));
}

export function supportsIptables(db: DatabaseSync, serverId: string, now: number) {
  return Boolean(db.prepare("SELECT 1 FROM agent_worker_polls WHERE server_id=? AND kind='provision' AND can_iptables=1 AND last_seen>=?")
    .get(serverId, now - pollWindow));
}

export function supportsHostReboot(db: DatabaseSync, serverId: string, now: number) {
  return Boolean(db.prepare("SELECT 1 FROM agent_worker_polls WHERE server_id=? AND kind='provision' AND can_reboot=1 AND last_seen>=?")
    .get(serverId, now - pollWindow));
}

export function supportsV2bxRestart(db: DatabaseSync, serverId: string, now: number) {
  return Boolean(db.prepare("SELECT 1 FROM agent_worker_polls WHERE server_id=? AND kind='provision' AND can_restart_v2bx=1 AND last_seen>=?")
    .get(serverId, now - pollWindow));
}

export function supportsV2bxRemove(db: DatabaseSync, serverId: string, now: number) {
  return Boolean(db.prepare("SELECT 1 FROM agent_worker_polls WHERE server_id=? AND kind='provision' AND can_remove_v2bx=1 AND last_seen>=?")
    .get(serverId, now - pollWindow));
}
export function supportsProvisionDownload(db: DatabaseSync, serverId: string, now: number) {
  return Boolean(db.prepare("SELECT 1 FROM agent_worker_polls WHERE server_id=? AND kind='provision' AND can_download=1 AND last_seen>=?")
    .get(serverId, now - pollWindow));
}

export function supportsProvisionRemoval(db: DatabaseSync, serverId: string, now: number) {
  return Boolean(db.prepare("SELECT 1 FROM agent_worker_polls WHERE server_id=? AND kind='provision' AND can_remove=1 AND last_seen>=?")
    .get(serverId, now - pollWindow));
}

export function observedAgentWorkers(db: DatabaseSync, now: number, enabled: Record<AgentWorker["kind"], boolean>) {
  const rows = db.prepare("SELECT server_id, kind, last_seen FROM agent_worker_polls").all();
  const polls = new Map(rows.map((row) => [row.server_id + "/" + row.kind, Number(row.last_seen)]));
  const leases = db.prepare(`
    SELECT source_id AS server_id, 'iperf' AS kind FROM iperf_jobs
    WHERE status IN ('running','cancel_requested') AND lease_until > ?
    UNION
    SELECT server_id, 'provision' AS kind FROM provision_jobs
    WHERE status='running' AND lease_until > ?
  `).all(now, now);
  const busy = new Set(leases.map((row) => row.server_id + "/" + row.kind));
  return (serverId: string): AgentWorker[] => kinds.map((kind) => {
    const key = serverId + "/" + kind;
    const seen = polls.get(key);
    const status = !enabled[kind] ? "disabled" : seen === undefined ? "unseen" : busy.has(key) ? "busy"
      : now - seen <= pollWindow ? "recent" : "stale";
    return { kind, status, lastSeen: seen === undefined ? undefined : new Date(seen).toISOString() };
  });
}
