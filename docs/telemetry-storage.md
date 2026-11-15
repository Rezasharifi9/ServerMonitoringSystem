# Lightweight telemetry storage

The panel applies this policy automatically when the updated server starts. Existing
custom intervals are preserved; the former defaults for disk (600 seconds) and logs
(10 seconds) migrate to 900 and 120 seconds. Service/proxy checks remain at their
existing intervals. Above 85% disk usage, disk sampling runs at least every 300
seconds. CPU, RAM and traffic intervals remain configurable in Settings.

## Storage and retention

- Monitor heartbeats update changed entities in `workspace_live`, plus the workspace
  revision. Inventory edits materialize the latest live state into the base snapshot
  within the same transaction. Server/node relations rebuild only when they change.
- Raw reports remain for up to three days. Older reports become five-minute summaries;
  after 30 days they become hourly summaries. The configured retention period is an
  upper limit for every tier, including installations configured for less than three days.
- Summaries preserve weighted means, minima, maxima and sample counts. Availability
  retains successful/total check counts. Recent raw evidence remains available to
  failover/preflight and deployment verification. Conditional latency/jitter averages
  continue excluding failed probes.
- Historical charts and CSV exports include summaries. `sampleKind` distinguishes
  raw and summary export rows; `Min`, `Max`, `Count` columns identify their statistics.
- Routine INFO/DEBUG logs expire after at most seven days. Warnings/errors follow
  the configured retention. Identical routine messages from the same source, server
  and node within a five-minute window share a row with repeat count and last time.
  Event receipts prevent retransmissions from increasing that count.
- Cleanup runs in bounded batches on telemetry ingestion or the health worker;
  steady state runs once a minute. Existing history migrates progressively.
- Charts use one-minute buckets for short ranges, five minutes for 24 hours,
  15 minutes for seven days and one hour for 30 days.

## Agent rollout

Agent 0.4.1 sends hardware specifications at startup, on change, or daily, instead
of with every disk sample. Hardware is kept in current server inventory, not copied
into historical report payloads. DEBUG logs are disabled by default. For temporary
debugging, set `debugLogsUntil` in the agent configuration to a Unix timestamp in
seconds; debug collection stops at that timestamp.

Routine journal collection follows the logs interval. ERROR/CRITICAL messages also
use a separate cursor on the fast service interval, including structured Go messages
that journald labels INFO. All cursors advance past filtered messages and persist
only after the report is acknowledged.

Deploy/restart the panel normally, then use the existing Agent update operation in
Settings to roll out 0.4.1 to the servers. Existing agents remain compatible; they
receive the new cadence but need upgrading for daily hardware and fast error-only
collection. This repository change does not itself SSH into production servers.

SQLite reuses pages released by cleanup. The on-disk file may therefore remain the
same size initially. If reclaiming filesystem space is necessary, make a consistent
backup and run `VACUUM` as a separate maintenance operation; it is deliberately not
run during a heartbeat transaction.

## Verification

`npm run test:telemetry` verifies live-state isolation, transaction rollback, unchanged
inventory relationships, history compaction, weighted/conditional means, extrema,
availability, log deduplication/retention, hourly compaction and chart sizes.
Management tests also check removal of a route from archived history without
removing other routes. Python agent tests cover structured errors, debug filtering
and cursor advancement.
