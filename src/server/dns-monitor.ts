import { randomUUID } from "node:crypto";
import { transaction, readWorkspace } from "./database";
import { normalDomain } from "./dns-resolver";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { refreshAuthoritativeDns } from "./providers";

const parallel = 4;
const leaseMs = 25000;
const retryMs = 30000;

function intervalMs() {
  const raw = process.env.NODEGUARD_DNS_POLL_SECONDS ?? "120";
  const seconds = Number(raw);
  return /^\d+$/.test(raw) && seconds >= 30 && seconds <= 3600 ? seconds * 1000 : null;
}

export function dnsStaleAfterMs() {
  return process.env.NODEGUARD_ENABLE_DNS_MONITOR === "1" ? 2 * (intervalMs() ?? 120000) + retryMs : 300000;
}

function claim(interval: number) {
  return transaction((db) => {
    const now = Date.now();
    const schedule = new Map(db.prepare("SELECT * FROM dns_monitor_schedule").all().map((row) => [String(row.node_id), row]));
    const active = [...schedule.values()].filter((row) => Number(row.lease_until) > now).length;
    if (active >= parallel) return [];
    const blocked = new Set(db.prepare(`
      SELECT domain FROM failover_executions WHERE status IN ('applying','verifying','rolling_back','review')
    `).all().map((row) => String(row.domain)));
    const candidates = readWorkspace(db).state.dns.flatMap((record) => {
      const row = schedule.get(record.nodeId);
      const domain = normalDomain(record.domain);
      if (blocked.has(domain) || Number(row?.lease_until) > now) return [];
      const last = Date.parse(record.lastCheck) || 0;
      const retryAt = row?.domain === domain ? Number(row.retry_at) : 0;
      const dueAt = Math.max(last ? last + interval : 0, retryAt);
      return dueAt <= now ? [{ nodeId: record.nodeId, domain, dueAt }] : [];
    }).sort((a, b) => a.dueAt - b.dueAt).slice(0, parallel - active);
    const reserve = db.prepare(`
      INSERT INTO dns_monitor_schedule (node_id, domain, retry_at, lease, lease_until) VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET domain = excluded.domain, retry_at = 0,
        lease = excluded.lease, lease_until = excluded.lease_until
    `);
    return candidates.map(({ nodeId, domain }) => {
      const lease = randomUUID();
      reserve.run(nodeId, domain, lease, now + leaseMs);
      return { nodeId, lease };
    });
  });
}

export async function tickDnsMonitor() {
  if (workspaceMode() !== "monitor" || process.env.NODEGUARD_ENABLE_DNS_MONITOR !== "1") {
    throw new ApiError(503, "DNS_MONITOR_DISABLED", "پایش زمان‌بندی‌شدهٔ DNS در این محیط فعال نیست.");
  }
  const interval = intervalMs();
  if (interval === null) throw new ApiError(503, "DNS_MONITOR_CONFIG", "فاصلهٔ پایش DNS باید بین ۳۰ تا ۳۶۰۰ ثانیه باشد.");
  const jobs = claim(interval);
  const outcomes = await Promise.allSettled(jobs.map(async ({ nodeId, lease }) => {
    let retry = false;
    try {
      await refreshAuthoritativeDns({ lease }, nodeId);
      return "checked";
    } catch (error) {
      retry = true;
      if (error instanceof ApiError && error.status === 409) return "skipped";
      throw error;
    } finally {
      transaction((db) => {
        db.prepare("UPDATE dns_monitor_schedule SET lease = NULL, lease_until = NULL, retry_at = ? WHERE node_id = ? AND lease = ?")
          .run(retry ? Date.now() + retryMs : 0, nodeId, lease);
      });
    }
  }));
  return {
    checked: outcomes.filter((item) => item.status === "fulfilled" && item.value === "checked").length,
    skipped: outcomes.filter((item) => item.status === "fulfilled" && item.value === "skipped").length,
    errors: outcomes.filter((item) => item.status === "rejected").length,
  };
}
