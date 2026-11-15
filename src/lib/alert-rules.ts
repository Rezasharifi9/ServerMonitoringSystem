export const alertMetrics = {
  disk: "مصرف دیسک (%)", cpu: "مصرف CPU (%)", ram: "مصرف RAM (%)", serverRtt: "پینگ سرور به پنل (ms)", serverLoss: "اتلاف سرور (%)",
  tunnelRtt: "پینگ تونل (ms)", tunnelLoss: "اتلاف تونل (%)", jitter: "Jitter تونل (ms)",
};
export const alertOperators = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", neq: "≠" };
export type AlertMetric = keyof typeof alertMetrics;
export type AlertOperator = keyof typeof alertOperators;
export const tunnelAlertMetric = (metric: AlertMetric) => metric === "tunnelRtt" || metric === "tunnelLoss" || metric === "jitter";

export interface MetricAlertRule {
  id: string;
  name: string;
  targetId: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  cooldownMinutes: number;
  enabled: boolean;
  severity?: "info" | "warning" | "critical";
}
