import type { Alert, AppSettings } from "@/types";

export function configuredAlert(alert: Alert, settings: AppSettings) {
  return Boolean(alert.metricRuleId && settings.metricAlertRules?.some(rule => rule.id === alert.metricRuleId && rule.enabled));
}
