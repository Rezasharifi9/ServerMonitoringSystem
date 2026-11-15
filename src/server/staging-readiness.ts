import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { activeTunnelId } from "@/lib/health";
import { summarizeProxyProbes } from "@/lib/proxy-health";
import type { Workspace } from "./database";
import { database, readWorkspace } from "./database";
import { observedAvailability } from "./availability";
import { checkFailover } from "./failover-preflight";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { readMonitorLogs } from "./log-storage";
import { projectObserverHealth } from "./probe-observers";
import { observedPanelBindingIsCurrent } from "./providers";

const querySchema = z.object({
  nodeId: z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i),
  since: z.string().datetime({ offset: true }).optional(),
});

type Check = { key: string; ok: boolean; detail: string };

function exerciseChecks(db: DatabaseSync, state: Workspace, node: Workspace["nodes"][number], since: number, now: number): Check[] {
  const tunnels = [node.primaryTunnelId, node.backupTunnelId ?? null];
  const servers = [node.primaryServerId, node.backupServerId ?? null, node.foreignServerId];
  const jobs = db.prepare(`
    SELECT DISTINCT json_extract(config,'$.protocol') AS protocol FROM iperf_jobs
    WHERE status='completed' AND finished_at BETWEEN ? AND ?
      AND json_extract(config,'$.tunnelId') IN (?,?)
  `).all(since, now, ...tunnels);
  const protocols = new Set(jobs.map((row) => row.protocol));
  const failover = db.prepare(`
    SELECT e.status, e.rollback_at, json_extract(p.preflight,'$.target') AS target
    FROM failover_executions e JOIN failover_plans p ON p.id=e.plan_id
    WHERE p.node_id=? AND e.attempted_at BETWEEN ? AND ? AND e.updated_at<=?
      AND e.status IN ('succeeded','rolled_back')
  `).all(node.id, since, now, now);
  const provision = db.prepare(`
    SELECT 1 FROM tunnel_deployments d
    WHERE d.tunnel_id IN (?,?) AND d.created_at BETWEEN ? AND ? AND d.status='rolled_back'
      AND d.verified_at BETWEEN ? AND ?
      AND 4 = (SELECT COUNT(*) FROM tunnel_deployment_steps s JOIN provision_jobs j ON j.id=s.job_id
        WHERE s.deployment_id=d.id AND s.phase IN ('foreign_apply','iran_apply','iran_restore','foreign_restore')
          AND j.status='succeeded')
  `).get(...tunnels, since, now, since, now);
  const bbr = db.prepare(`
    SELECT 1 FROM provision_jobs a JOIN provision_jobs r ON r.rollback_of=a.id AND r.server_id=a.server_id
    WHERE a.server_id IN (?,?,?) AND json_extract(a.profile,'$.component')='BBR'
      AND a.status='succeeded' AND a.detail='applied' AND a.rollback_of IS NULL
      AND r.status='succeeded' AND r.detail='restored'
      AND a.created_at BETWEEN ? AND ? AND r.created_at BETWEEN a.created_at AND ?
  `).get(...servers, since, now, now);
  const linkedAlert = new Set(state.alerts.filter((item) => item.nodeId === node.id ||
    (item.tunnelId && tunnels.includes(item.tunnelId)) || (item.serverId && servers.includes(item.serverId))).map((item) => item.id));
  const sent = db.prepare(`
    SELECT alert_id FROM telegram_outbox WHERE status='sent' AND message_id IS NOT NULL AND last_attempt BETWEEN ? AND ?
  `).all(since, now);
  const incidentRecovered = state.incidents.some((item) =>
    (item.nodeId === node.id || (item.tunnelId && tunnels.includes(item.tunnelId)) || (item.serverId && servers.includes(item.serverId))) &&
    (item.id.startsWith("obs:") || item.id.startsWith("proxy-") || item.id.startsWith("dns-")) &&
    item.status === "resolved" && Date.parse(item.openedAt) >= since && Date.parse(item.resolvedAt ?? "") <= now);

  return [
    { key: "iperf-tcp", ok: protocols.has("tcp"), detail: "تست TCP تکمیل‌شده روی تونل canary" },
    { key: "iperf-udp", ok: protocols.has("udp"), detail: "تست UDP تکمیل‌شده روی تونل canary" },
    { key: "provision-rollback", ok: Boolean(provision), detail: "نصب، کاوش موفق و بازگردانی هر دو سمت تونل" },
    { key: "bbr-rollback", ok: Boolean(bbr), detail: "ثبت اعمال و بازگردانی BBR روی یکی از میزبان‌های canary" },
    { key: "failover", ok: failover.some((run) => run.target === "backup" && run.status === "succeeded"), detail: "سوییچ تأییدشده به پشتیبان" },
    { key: "failback", ok: failover.some((run) => run.target === "primary" && run.status === "succeeded"), detail: "بازگشت تأییدشده به مسیر اصلی" },
    { key: "dns-rollback", ok: failover.some((run) => run.status === "rolled_back" && Number(run.rollback_at) >= since), detail: "بازگردانی تأییدشدهٔ DNS" },
    { key: "incident-recovery", ok: incidentRecovered, detail: "رخداد مشاهده‌شده با ثبت بازگشت" },
    { key: "telegram", ok: sent.some(({ alert_id }) => alert_id === null || linkedAlert.has(String(alert_id))),
      detail: "تحویل اعلان canary یا پیام آزمایشی سراسری" },
  ];
}

export function readStagingReadiness(query: URLSearchParams) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "شواهد staging در محیط پایش در دسترس است.");
  const parsed = querySchema.safeParse({ nodeId: query.get("nodeId"), since: query.get("since") ?? undefined });
  if (!parsed.success) throw new ApiError(422, "STAGING_QUERY", "شناسهٔ نود و زمان شروع ISO معتبر لازم است.");
  const now = Date.now();
  const since = parsed.data.since === undefined ? undefined : Date.parse(parsed.data.since);
  if (since !== undefined && (!Number.isFinite(since) || since > now || since < now - 30 * 86400000)) {
    throw new ApiError(422, "STAGING_RANGE", "زمان شروع باید در ۳۰ روز گذشته باشد.");
  }

  const db = database();
  const { state } = readWorkspace(db);
  const node = state.nodes.find((item) => item.id === parsed.data.nodeId);
  if (!node) throw new ApiError(404, "NODE_UNKNOWN", "نود canary پیدا نشد.");
  const tunnelIds = [node.primaryTunnelId, node.backupTunnelId];
  const hostIds = [node.primaryServerId, node.backupServerId, node.foreignServerId];
  const freshness = Math.max(90000, state.settings.monitoringIntervalSec * 3000);
  const fresh = (value?: string, limit = freshness) => {
    const timestamp = Date.parse(value ?? "");
    return timestamp >= now - limit && timestamp <= now + 30000;
  };
  const agents = hostIds.map((id) => state.servers.find((item) => item.id === id));
  const tunnels = tunnelIds.map((id) => state.tunnels.find((item) => item.id === id));
  const dns = state.dns.find((item) => item.nodeId === node.id);
  const [observed] = projectObserverHealth([node]);
  const availability = observedAvailability("15m", [node.id], tunnelIds.filter((id) => id !== undefined));
  const source = (kind: "v2bx-shared" | "v2bx-node") => readMonitorLogs(db, {
    minutes: 10, limit: 1, page: 1, through: now, server: node.foreignServerId,
    node: kind === "v2bx-node" ? node.id : null, source: kind,
  }).total;
  const sharedLogs = source("v2bx-shared");
  const nodeLogs = source("v2bx-node");
  const target = node.activeSide === "primary" ? "backup" : "primary";
  const preflight = checkFailover(node.id, target, db, now).result;
  const checks: Check[] = [
    { key: "topology", ok: new Set(hostIds).size === 3 && new Set(tunnelIds).size === 2 &&
      agents.every(Boolean) && tunnels.every((tunnel, index) => tunnel?.iranEndpoint.serverId === hostIds[index] &&
        tunnel?.foreignEndpoint.serverId === node.foreignServerId), detail: "سه میزبان و دو مسیر canary ثبت شده‌اند" },
    { key: "agents", ok: agents.every((server) => server?.agent.status === "online" && fresh(server.agent.lastHeartbeat)),
      detail: "heartbeat تازه برای ایران اصلی، ایران پشتیبان و خروج" },
    { key: "tunnels", ok: tunnels.every((tunnel) => tunnel?.status === "healthy" && fresh(tunnel.lastCheck)) &&
      tunnelIds.every((id) => id !== undefined && (availability.tunnels[id]?.successful ?? 0) > 0), detail: "کاوش تازه و سابقهٔ موفق هر دو مسیر" },
    { key: "v2bx", ok: preflight.checks.some((check) => check.code === "foreign" && check.ok), detail: "گزارش تازهٔ V2bX فعال روی خروج مشترک" },
    { key: "v2board", ok: Boolean(dns && observedPanelBindingIsCurrent(dns, now)), detail: "نگاشت مشاهده‌شده و تازهٔ V2Board" },
    { key: "dns", ok: Boolean(dns?.authoritativeStatus === "matched" && dns.resolverStatus === "matched" &&
      dns.resolverObservation?.complete && fresh(dns.lastCheck, 300000) && fresh(dns.resolverObservation.checkedAt, 300000)),
      detail: "تطابق مشاهدهٔ Cloudflare و resolver مستقل" },
    { key: "proxy", ok: summarizeProxyProbes(observed, state.settings, now) === "up" &&
      (availability.nodes[node.id]?.successful ?? 0) > 0, detail: "شاهد تازه و سابقهٔ موفق مسیر فعال از مشاهده‌گر مستقل" },
    { key: "logs-shared", ok: sharedLogs > 0, detail: `${sharedLogs} لاگ مشترک V2bX در ۱۰ دقیقه` },
    { key: "logs-node", ok: nodeLogs > 0, detail: `${nodeLogs} لاگ منتسب به نود در ۱۰ دقیقه` },
    { key: "failover-preflight", ok: preflight.ready, detail: `پیش‌بررسی مقصد ${target}` },
  ];
  const exercises = since === undefined ? undefined : exerciseChecks(db, state, node, since, now);
  return {
    nodeId: node.id, checkedAt: new Date(now).toISOString(), activeTunnelId: activeTunnelId(node),
    ready: checks.every((item) => item.ok),
    checks, preflight: preflight.checks.map(({ code, ok }) => ({ code, ok })),
    evidence: exercises && { since: parsed.data.since, complete: exercises.every((item) => item.ok), checks: exercises },
  };
}
