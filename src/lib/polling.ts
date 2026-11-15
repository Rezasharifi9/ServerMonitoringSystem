// Browser refresh cadence. Collection, alerting and failover workers run independently.
export const POLLING = {
  workspace: 15_000,
  metrics: 30_000,
  inventory: 60_000,
  ping: 30_000,
  logs: 5_000,
  preview: 15_000,
  job: 3_000,
  idle: 60_000,
  configuration: 300_000,
  error: 60_000,
  readTimeout: 30_000,
} as const;

/** Avoid overlapping reads; slow down after an error without retry bursts. */
export function pollingInterval(query: { state: { fetchStatus: string; status: string } }, interval: number | false): number | false {
  if (interval === false || query.state.fetchStatus !== "idle") return false;
  return query.state.status === "error" ? Math.max(interval, POLLING.error) : interval;
}

export function jobActive(job: { status: string }): boolean {
  return ["queued", "pending", "running", "deploying", "verifying", "rolling_back", "executing", "applying"].includes(job.status);
}
