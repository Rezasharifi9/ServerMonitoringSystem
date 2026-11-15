# Browser refresh policy

`src/lib/polling.ts` defines browser read cadence in milliseconds. These are application choices, following Grafana's advice to use the slowest interval that meets the monitoring need; they are not a universal monitoring standard.

- Workspace status: 15 seconds after completion of the previous read. Concurrent callers share one request per session generation. Timeout: 15 seconds. Failures slow the next read to 30, then 60 seconds; success restores 15 seconds.
- Metrics, availability and server pings: 30 seconds. Ping timeout: 10 seconds.
- Inventory: 60 seconds. Agent registration, failover preflight and small log previews: 15 seconds.
- Live logs: 5 seconds, only on the first live page. Explicit date ranges and frozen snapshots do not poll.
- Active jobs: 3 seconds while queued/running/applying/verifying/rolling back. Idle lists: 60 seconds. Human review is not an active execution state.
- Static Gmail settings: no interval; cached for 5 minutes. Saving updates the cache immediately.

All query intervals skip in-flight/paused reads and wait at least 60 seconds after failure. React Query background intervals are disabled; workspace polling also checks visibility and network availability. GET requests have a 30-second transport timeout, combined with any caller cancellation or shorter timeout. Mutating requests retain their existing behavior.

Sidebar and server-list links do not prefetch unused routes. Monitoring metric keys exclude simulation-only stress changes to prevent extra reads on telemetry updates.

Collection, health checks, alerting, failover and agent worker timing remain independent from browser refresh. Hiding a browser tab does not stop backend monitoring.

Validation:

```powershell
node tests/polling.mjs
node tests/workspace-sync.mjs
node tests/polling-ui.mjs <playwright-core/index.mjs> <standalone-release-directory>
```

Reference: https://grafana.com/docs/learning-paths/visualization-metrics/time-range-refresh/
