import { randomUUID } from "node:crypto";
import { AGENT_VERSION } from "@/lib/agent-version";
import { can } from "@/lib/rbac";
import type { AgentUpdateJob, DemoUser } from "@/types";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { getAgentRegistration } from "./agent-enrollment";
import { installAgentOverSsh, sshInstallEnabled } from "./ssh-provision";
import { pushAudit } from "./activity-log";

function allow(actor: DemoUser) {
  if (!can(actor.role, "settings.edit") || !can(actor.role, "agent.enroll") || !can(actor.role, "server.configure") || !can(actor.role, "deploy.run")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی تنظیمات و نصب Agent لازم است.");
  }
}

export function listAgentUpdates(actor: DemoUser) {
  allow(actor);
  const db = database();
  const servers = readWorkspace(db).state.servers;
  const batch = db.prepare("SELECT batch_id FROM agent_update_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
  const jobs: AgentUpdateJob[] = batch ? db.prepare("SELECT * FROM agent_update_jobs WHERE batch_id=? ORDER BY created_at, rowid").all(batch.batch_id!).map((row) => ({
    id: String(row.id), serverId: String(row.server_id), status: row.status as AgentUpdateJob["status"], detail: String(row.detail),
    reporting: row.reporting === 1 || row.status === "succeeded" && servers.some((server) => server.id === row.server_id &&
      Date.parse(server.agent.lastHeartbeat) >= Number(row.updated_at)), updatedAt: new Date(Number(row.updated_at)).toISOString(),
  })) : [];
  return { version: AGENT_VERSION, enabled: sshInstallEnabled(), batchId: batch ? String(batch.batch_id) : null, jobs };
}

export function queueAgentUpdates(actor: DemoUser, retry = false) {
  allow(actor);
  if (!sshInstallEnabled()) throw new ApiError(503, "SSH_INSTALL_DISABLED", "نصب SSH در این محیط فعال نیست.");
  return transaction((db) => {
    if (db.prepare("SELECT 1 FROM agent_update_jobs WHERE status IN ('queued','running')").get()) {
      throw new ApiError(409, "AGENT_UPDATE_BUSY", "به‌روزرسانی گروهی دیگری در جریان است.");
    }
    const last = listAgentUpdates(actor);
    const failed = new Set(last.jobs.filter((job) => job.status === "failed").map((job) => job.serverId));
    const { state, revision } = readWorkspace(db);
    const hosts = state.servers.filter((host) => retry ? failed.has(host.id) :
      Boolean(host.agent.lastHeartbeat) || getAgentRegistration(actor, host.id).state === "active");
    if (!hosts.length) throw new ApiError(409, "AGENT_UPDATE_EMPTY", "سروری برای به‌روزرسانی پیدا نشد.");
    const batch = randomUUID();
    const now = Date.now();
    for (const host of hosts) db.prepare(`INSERT INTO agent_update_jobs
      (id,batch_id,server_id,actor,status,created_at,updated_at) VALUES (?,?,?,?,'queued',?,?)`)
      .run(randomUUID(), batch, host.id, JSON.stringify(actor), now, now);
    pushAudit(state, actor, "agent.update.all", batch, `${AGENT_VERSION}: ${hosts.length}`);
    writeWorkspace(db, state, revision + 1);
    return listAgentUpdates(actor);
  });
}

export async function drainAgentUpdates(request: Request) {
  if (!sshInstallEnabled()) return;
  for (;;) {
    const claimed = transaction((db) => {
      const now = Date.now();
      // A process can disappear mid-install. The host lock expires first, so a
      // recovered job can safely repeat the idempotent installation.
      db.prepare("UPDATE agent_update_jobs SET status='queued', detail='' WHERE status='running' AND lease_until<=?").run(now);
      const slots = 3 - Number(db.prepare("SELECT COUNT(*) AS n FROM agent_update_jobs WHERE status='running'").get()!.n);
      if (slots <= 0) return [];
      const jobs = db.prepare("SELECT * FROM agent_update_jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT ?").all(slots);
      for (const job of jobs) db.prepare("UPDATE agent_update_jobs SET status='running', updated_at=?, lease_until=? WHERE id=?")
        .run(now, now + 660000, job.id!);
      return jobs;
    });
    if (!claimed.length) return;
    await Promise.allSettled(claimed.map(async (job) => {
      try {
        const actor = JSON.parse(String(job.actor)) as DemoUser;
        allow(actor);
        const result = await installAgentOverSsh(actor, String(job.server_id), {}, request);
        database().prepare("UPDATE agent_update_jobs SET status='succeeded', detail='', reporting=?, updated_at=?, lease_until=0 WHERE id=?")
          .run(Number(result.reporting), Date.now(), job.id!);
      } catch (error) {
        const detail = error instanceof ApiError ? error.message : "به‌روزرسانی Agent ناموفق بود.";
        database().prepare("UPDATE agent_update_jobs SET status='failed', detail=?, updated_at=?, lease_until=0 WHERE id=?")
          .run(detail, Date.now(), job.id!);
      }
    }));
  }
}
