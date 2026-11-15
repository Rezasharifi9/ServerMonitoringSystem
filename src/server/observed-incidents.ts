import { createHash, randomUUID } from "node:crypto";
import type { Alert, AlertCategory, AlertSeverity, DNSRecord, Node, Server, Tunnel } from "@/types";
import type { Workspace } from "./database";
import { activeServerId } from "@/lib/health";
import { summarizeProxyProbes } from "@/lib/proxy-health";

export function updateDnsIncident(state: Workspace, node: Node, active: Server | undefined, dns: DNSRecord): Alert[] {
  const mismatch = dns.authoritativeStatus === "mismatched" || dns.resolverStatus === "mismatched";
  const matched = (dns.resolverOnly || dns.authoritativeStatus === "matched") && dns.resolverStatus === "matched";
  return updateNodeIncident(state, {
    nodeId: node.id, serverId: active?.id, category: "dns-mismatch", severity: "warning",
    title: `عدم تطابق DNS · ${dns.domain}`,
  }, dns.lastCheck, mismatch, matched,
  dns.note, "پاسخ DNS با IP مسیر فعال تطبیق پیدا کرد.");
}

export function updateProxyIncident(state: Workspace, node: Node, now: number) {
  const proxy = summarizeProxyProbes(node, state.settings, now);
  if (proxy !== "up" && proxy !== "down") return;

  const activeId = activeServerId(node);
  updateNodeIncident(state, {
    nodeId: node.id, serverId: activeId, category: "proxy-unreachable", severity: "critical",
    title: `قطعی سرتاسری پروکسی · ${node.name}`,
  }, new Date(now).toISOString(), proxy === "down", proxy === "up",
  "کاوش‌های تازهٔ مشاهده‌گرهای مستقل، قطعی مسیر فعال پروکسی را تأیید کردند.",
  "کاوش‌های تازهٔ مشاهده‌گرهای مستقل، بازگشت دسترسی سرتاسری را تأیید کردند.");
}

type NodeIncidentContext = Pick<Alert, "title" | "severity" | "category" | "serverId"> & { nodeId: string };

function updateNodeIncident(
  state: Workspace, context: NodeIncidentContext, at: string,
  breached: boolean, recovered: boolean, detail: string, recoveryDetail: string,
): Alert[] {
  const open = state.incidents.find((item) =>
    item.nodeId === context.nodeId && item.category === context.category && item.status !== "resolved");
  if (open && recovered) {
    state.incidents = state.incidents.map((item) => item.id !== open.id ? item : {
      ...item, status: "resolved", resolvedAt: at, updatedAt: at,
      timeline: [...item.timeline, { at, text: recoveryDetail }],
    });
    state.alerts = state.alerts.map((item) => item.incidentId !== open.id ? item : { ...item, resolved: true });
  }
  if (!breached || open) return [];

  const incidentId = (context.category === "dns-mismatch" ? "dns-" : "proxy-") + randomUUID();
  state.incidents = [{
    id: incidentId, ...context, summary: detail, status: "open", openedAt: at, updatedAt: at,
    timeline: [{ at, text: detail }],
  }, ...state.incidents];
  const alert: Alert = {
    id: "alert-" + randomUUID(), incidentId, ...context, detail, createdAt: at, acked: false, resolved: false,
  };
  state.alerts = [alert, ...state.alerts];
  return [alert];
}

type Condition = {
  key: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  breached: boolean;
  tunnelId?: string;
  detail?: string;
};

export function updateAgentHeartbeatIncident(state: Workspace, server: Server, now: number, mode: "detect" | "recover") {
  const at = Date.parse(server.agent.lastHeartbeat);
  if (!Number.isFinite(at)) return;
  const stale = now - at > Math.max(90, state.settings.monitoringIntervalSec * 3) * 1000;
  if ((mode === "detect") !== stale) return;
  return updateServerIncident(state, server, {
    key: "agent-heartbeat", category: "agent-disconnected", severity: "warning",
    title: "گزارش Agent متوقف شده است", breached: stale,
    detail: "از آخرین گزارش Agent بیش از مهلت پایش گذشته است.",
  }, new Date(now).toISOString());
}

export function updateObservedIncidents(state: Workspace, server: Server, observedTunnels: Tunnel[], reportedV2bX: boolean, at: string) {
  const thresholds = state.settings.thresholds;
  const conditions: Condition[] = [{
    key: "resources", category: "high-resource", severity: "warning", title: "مصرف منابع از آستانه گذشته است",
    breached: server.cpu >= thresholds.cpu || server.ram >= thresholds.ram || server.disk >= thresholds.disk,
  }];
  if (reportedV2bX) {
    conditions.push({
      key: "v2bx", category: "v2bx-failure", severity: "critical", title: "V2bX فعال گزارش نشده است",
      breached: server.services.find((service) => service.name === "v2bx")?.status !== "running",
    });
  }
  for (const tunnel of observedTunnels) {
    conditions.push(
      { key: tunnel.id + "/down", category: "tunnel-disconnected", severity: "critical", title: "تونل قطع گزارش شده است", breached: tunnel.status === "offline", tunnelId: tunnel.id },
      { key: tunnel.id + "/loss", category: "high-loss", severity: "warning", title: "اتلاف بسته از آستانه گذشته است", breached: tunnel.kind === "interface" && tunnel.status !== "offline" && tunnel.packetLoss >= thresholds.lossPct, tunnelId: tunnel.id },
      { key: tunnel.id + "/rtt", category: "high-rtt", severity: "warning", title: "تأخیر تونل از آستانه گذشته است", breached: tunnel.kind === "interface" && tunnel.status !== "offline" && tunnel.rttMs >= thresholds.rttMs, tunnelId: tunnel.id },
    );
  }

  const now = Date.parse(at);

  for (const condition of conditions) updateServerIncident(state, server, condition, at);

  const retained = now - state.settings.dataRetentionDays * 86400000;
  state.incidents = state.incidents.filter((item) => item.status !== "resolved" || Date.parse(item.updatedAt) >= retained);
  state.alerts = state.alerts.filter((item) => !item.resolved || Date.parse(item.createdAt) >= retained);
}

function updateServerIncident(state: Workspace, server: Server, condition: Condition, at: string) {
  const key = createHash("sha256").update(JSON.stringify([server.id, condition.key])).digest("hex").slice(0, 32);
  const prefix = "obs:" + key + ":";
  const active = state.incidents.find((item) => item.id.startsWith(prefix) && item.status !== "resolved");
  if (!condition.breached && active) {
    state.incidents = state.incidents.map((item) => item.id !== active.id ? item : {
      ...item, status: "resolved", resolvedAt: at, updatedAt: at,
      timeline: [...item.timeline, { at, text: "گزارش تازهٔ Agent بازگشت به محدودهٔ عادی را ثبت کرد." }],
    });
    state.alerts = state.alerts.map((item) => item.incidentId !== active.id ? item : { ...item, resolved: true });
  }
  if (!condition.breached || active) return;

  const incidentId = prefix + randomUUID();
  const title = `${condition.title} · ${condition.tunnelId ?? server.name}`;
  const summary = condition.detail ?? "بر اساس گزارش دریافت‌شده از عامل سرور.";
  state.incidents = [{
    id: incidentId, title, summary, status: "open", category: condition.category, severity: condition.severity,
    serverId: server.id, tunnelId: condition.tunnelId, openedAt: at, updatedAt: at,
    timeline: [{ at, text: summary }],
  }, ...state.incidents];
  const alert: Alert = {
    id: "alert-" + randomUUID(), incidentId, title, detail: summary, createdAt: at,
    category: condition.category, severity: condition.severity, serverId: server.id, tunnelId: condition.tunnelId,
    acked: false, resolved: false,
  };
  state.alerts = [alert, ...state.alerts];
  return alert;
}
