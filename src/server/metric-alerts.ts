import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { alertMetrics, alertOperators, tunnelAlertMetric, type AlertMetric, type AlertOperator } from "@/lib/alert-rules";
import type { Alert, Server } from "@/types";
import type { Workspace } from "./database";

type Values = Partial<Record<AlertMetric, number | null>>;
const compare: Record<AlertOperator, (value: number, threshold: number) => boolean> = {
  gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b,
  lte: (a, b) => a <= b, eq: (a, b) => a === b, neq: (a, b) => a !== b,
};

export function evaluateMetricAlerts(db: DatabaseSync, state: Workspace, host: Server, at: string, values: Values, tunnels: Map<string, Values>) {
  const observed = Date.parse(at);
  const claim = db.prepare(`INSERT INTO metric_alert_cooldowns VALUES (?,?)
    ON CONFLICT(rule_id) DO UPDATE SET emitted_at=excluded.emitted_at WHERE emitted_at<=?`);
  for (const rule of state.settings.metricAlertRules ?? []) {
    if (!rule.enabled) continue;
    const isTunnel = tunnelAlertMetric(rule.metric);
    const targets: [string, Values][] = isTunnel
      ? [...tunnels].filter(([id]) => rule.targetId === "all" || rule.targetId === id)
      : rule.targetId === "all" || rule.targetId === host.id ? [[host.id, values]] : [];
    for (const [targetId, metrics] of targets) {
    const value = metrics[rule.metric];
    if (value == null || !Number.isFinite(value)) continue;
    const matches = (alert: Alert) => alert.metricRuleId === rule.id && alert.serverId === host.id &&
      (isTunnel ? alert.tunnelId === targetId : !alert.tunnelId);
    if (!compare[rule.operator](value, rule.threshold)) {
      state.alerts = state.alerts.map((alert) => matches(alert) && !alert.resolved ? { ...alert, resolved: true } : alert);
      continue;
    }
    if (state.alerts.some((alert) => matches(alert) && !alert.resolved)) continue;
    const key = JSON.stringify([rule.id, host.id, targetId]);
    if (!claim.run(key, observed, observed - rule.cooldownMinutes * 60000).changes) continue;
    const tunnel = isTunnel ? state.tunnels.find(({ id }) => id === targetId) : undefined;
    const alert: Alert = { id: randomUUID(), metricRuleId: rule.id, title: rule.name, severity: rule.severity ?? "warning", serverId: host.id, tunnelId: tunnel?.id,
      category: rule.metric.endsWith("Loss") ? "high-loss" : ["cpu", "ram", "disk"].includes(rule.metric) ? "high-resource" : "high-rtt",
      detail: `${tunnel?.name ?? host.name} · ${alertMetrics[rule.metric]} · ${value} ${alertOperators[rule.operator]} ${rule.threshold}`,
      createdAt: at, acked: false, resolved: false,
    };
    state.alerts = [alert, ...state.alerts].slice(0, 2000);
    }
  }
}
