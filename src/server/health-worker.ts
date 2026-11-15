import { readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { updateAgentHeartbeatIncident } from "./observed-incidents";
import { enqueueTelegramAlerts } from "./telegram";
import { enqueueGmailAlerts } from "./gmail";
import { maintainTelemetryHistory } from "./telemetry-history";

export function tickAgentHealth() {
  if (workspaceMode() !== "monitor" || process.env.NODEGUARD_ENABLE_HEALTH_MONITOR !== "1") {
    throw new ApiError(503, "HEALTH_MONITOR_DISABLED", "پایش زمان‌بندی‌شدهٔ Agent فعال نیست.");
  }
  return transaction((db) => {
    const { state, revision } = readWorkspace(db);
    const now = Date.now();
    maintainTelemetryHistory(db, state.settings.dataRetentionDays, now);
    const alerts = state.servers.flatMap((server) => {
      const alert = updateAgentHeartbeatIncident(state, server, now, "detect");
      return alert ? [alert] : [];
    });
    if (alerts.length) {
      enqueueTelegramAlerts(db, state, alerts);
      enqueueGmailAlerts(db, state, alerts);
      writeWorkspace(db, state, revision + 1);
    }
    return { checked: state.servers.length, opened: alerts.length };
  });
}
