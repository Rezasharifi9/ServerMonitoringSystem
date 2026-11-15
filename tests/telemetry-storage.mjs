import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(join(root, "src", specifier.slice(2))).href;
    if (context.parentURL?.startsWith(pathToFileURL(join(root, "src")).href) || specifier.startsWith(pathToFileURL(join(root, "src")).href)) {
      if (specifier.startsWith(".") || specifier.startsWith("file:")) {
        const url = new URL(specifier, context.parentURL);
        if (existsSync(fileURLToPath(url) + ".ts")) specifier = url.href + ".ts";
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.includes("/src/i18n/") && url.endsWith(".json")) return { format: "module", source: "export default " + readFileSync(new URL(url), "utf8"), shortCircuit: true };
    return next(url, context);
  },
});
const temp = await mkdtemp(join(tmpdir(), "nodeguard-history-"));
process.env.NODEGUARD_DB_PATH = join(temp, "test.sqlite");
process.env.NODEGUARD_WORKSPACE_MODE = "monitor";
process.env.NODEGUARD_INVENTORY_PATH = join(root, "inventory.example.json");
const { database, readWorkspace, writeWorkspace, writeTelemetryWorkspace, transaction } = await import("../src/server/database.ts");
const { maintainTelemetryHistory, summarizeTelemetry } = await import("../src/server/telemetry-history.ts");
const { observedAvailability } = await import("../src/server/availability.ts");
const { observedMetrics, observedSampleReport, metricBucketMs } = await import("../src/server/metrics.ts");
const { storeMonitorLogs, readMonitorLogs } = await import("../src/server/log-storage.ts");
const { telemetryDue } = await import("../src/server/telemetry-policy.ts");
const db = database();
try {
  const initial = readWorkspace(db);
  const cadenceAt = Date.now();
  db.prepare("INSERT INTO telemetry_cadence VALUES (?,?,?)").run(initial.state.servers[0].id, "disk", cadenceAt);
  assert.equal(telemetryDue(db, initial.state.servers[0].id, initial.state.settings, 90).disk, cadenceAt + 300000);
  assert.equal(telemetryDue(db, initial.state.servers[0].id, initial.state.settings, 10).disk, cadenceAt + 900000);
  const snapshot = db.prepare("SELECT snapshot FROM workspace").get().snapshot;
  const before = structuredClone(initial.state);
  initial.state.servers[0].cpu = 77;
  initial.state.servers[0].agent.lastHeartbeat = new Date().toISOString();
  transaction(() => writeTelemetryWorkspace(db, before, initial.state, initial.revision + 1));
  assert.equal(db.prepare("SELECT snapshot FROM workspace").get().snapshot, snapshot, "Heartbeat must not rewrite inventory JSON");
  assert.equal(readWorkspace(db).state.servers[0].cpu, 77);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workspace_live").get().n, 1);
  transaction(() => {
    const current = readWorkspace(db);
    current.state.servers[0].notes = "edited after heartbeat";
    writeWorkspace(db, current.state, current.revision + 1);
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workspace_live").get().n, 0);
  assert.equal(readWorkspace(db).state.servers[0].cpu, 77, "Inventory edit must retain live state");
  assert.throws(() => transaction(() => {
    const current = readWorkspace(db), before = structuredClone(current.state);
    current.state.servers[0].cpu = 99;
    writeTelemetryWorkspace(db, before, current.state, current.revision + 1);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(readWorkspace(db).state.servers[0].cpu, 77);
  db.exec("CREATE TEMP TRIGGER relations_unchanged BEFORE DELETE ON server_panel_nodes BEGIN SELECT RAISE(ABORT,'unnecessary relation rebuild'); END");
  transaction(() => {
    const current = readWorkspace(db);
    writeWorkspace(db, current.state, current.revision + 1);
  });
  db.exec("DROP TRIGGER relations_unchanged");
  const now = Date.now(), day = 86400000;
  const bucket = Math.floor((now - 4 * day) / 300000) * 300000;
  const insert = db.prepare("INSERT INTO agent_reports VALUES (?,?,?,?,?)");
  for (const [i, cpu, ok] of [[1,20,true],[2,80,false],[3,80,true]]) {
    insert.run("history-host", randomUUID(), bucket + i * 1000, "fixture", JSON.stringify({
      observedAt: new Date(bucket + i * 1000).toISOString(), cpu,
      tunnels: [{ tunnelId: "history-tunnel", status: ok ? "healthy" : "offline", rttMs: ok ? 10 : 0, packetLoss: ok ? 0 : 100, jitterMs: ok ? 2 : 999 }],
      forwarderChecks: [{ tunnelId: "history-forward", ok, elapsedMs: ok ? 10 : 30000 }],
      proxyProbes: [{ nodeId: "history-node", ok }],
    }));
  }
  insert.run("history-host", randomUUID(), now, "fixture", JSON.stringify({ observedAt: new Date(now).toISOString(), cpu: 30 }));
  const availabilityBefore = observedAvailability("7d", ["history-node"], ["history-tunnel", "history-forward"]);
  transaction(() => maintainTelemetryHistory(db, 60, now));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_reports").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM telemetry_history").get().n, 1);
  const availabilityAfter = observedAvailability("7d", ["history-node"], ["history-tunnel", "history-forward"]);
  assert.deepEqual(availabilityAfter.proxy, availabilityBefore.proxy);
  assert.deepEqual(availabilityAfter.tunnels, availabilityBefore.tunnels);
  assert.deepEqual(availabilityAfter.proxy, { samples: 3, successful: 2 });
  const cpu = observedMetrics("7d", "history-host").find((point) => point.cpu === 60);
  assert.ok(cpu, "Archived CPU mean must remain queryable");
  const tunnel = observedMetrics("7d", undefined, "history-tunnel").find((point) => point.rtt === 10);
  assert.equal(tunnel.jitter, 2, "Failed probes must not pollute jitter");
  const forward = observedMetrics("7d", undefined, "history-forward").find((point) => point.forwardLatency !== null);
  assert.equal(forward.forwardLatency, 10, "Failed connection timeouts must not pollute successful latency");
  const exported = observedSampleReport(new URLSearchParams({ stream: "cpu", id: "history-host", days: "7" }));
  const summary = exported.samples.find((sample) => sample.sampleKind === "summary");
  assert.equal(summary.cpuMin, 20);
  assert.equal(summary.cpuMax, 80);
  assert.equal(summary.cpuCount, 3);
  const merged = summarizeTelemetry([JSON.parse(db.prepare("SELECT payload FROM telemetry_history").get().payload), { cpu: 100 }], bucket);
  assert.equal(merged.cpu, 70, "Merging summaries must weight by original sample counts");
  assert.equal(merged._counts.cpu, 4);
  assert.ok(observedMetrics("30d", "history-host").length <= 722);
  const custom = observedMetrics("1h", "history-host", undefined, { from: now - 60000, to: now });
  assert.ok(custom.some(point => point.cpu === 30), "Custom dates include matching live sample");
  assert.ok(!custom.some(point => point.cpu === 60), "Custom dates exclude archived samples outside the requested period");
  const oldWindow = observedMetrics("1h", "history-host", undefined, { from: bucket - 60000, to: bucket + 3600000 });
  assert.ok(oldWindow.some(point => point.cpu === 60), "Custom dates can query historical periods independently of now");
  assert.ok(!oldWindow.some(point => point.cpu === 30), "Historical end excludes later samples");
  assert.ok(observedMetrics("1h", "history-host", undefined, { from: now - 30 * 86400000, to: now }).length <= 1002, "Custom charts remain bounded");
  assert.equal(metricBucketMs("15m"), 60000);
  const log = { id: "log-a", ts: new Date(now).toISOString(), serverId: "history-host", source: "agent", severity: "INFO", message: "routine message" };
  transaction(() => storeMonitorLogs(db, [log, { ...log, id: "log-b" }, { ...log, id: "log-b" }]));
  const logs = readMonitorLogs(db, { minutes: 60, page: 1, limit: 20, through: now + 1 });
  assert.equal(logs.total, 1);
  assert.equal(logs.data[0].repeatCount, 2, "Replayed event IDs must not inflate repetitions");
  transaction(() => storeMonitorLogs(db, [
    { ...log, id: "old-info", ts: new Date(now - 8 * day).toISOString() },
    { ...log, id: "old-error", severity: "ERROR", ts: new Date(now - 8 * day).toISOString() },
  ]));
  transaction(() => maintainTelemetryHistory(db, 60, now + 60001));
  assert.equal(db.prepare("SELECT 1 FROM monitor_logs WHERE id='old-info'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM monitor_logs WHERE id='old-error'").get());
  const hourlyAt = Math.floor((now - 35 * day) / 3600000) * 3600000;
  const archive = db.prepare("INSERT INTO telemetry_history VALUES (?,?,?,?)");
  archive.run("hourly", hourlyAt, 300000, JSON.stringify(summarizeTelemetry([{ cpu: 10 }, { cpu: 30 }], hourlyAt)));
  archive.run("hourly", hourlyAt + 300000, 300000, JSON.stringify(summarizeTelemetry([{ cpu: 80 }], hourlyAt + 300000)));
  transaction(() => maintainTelemetryHistory(db, 60, now + 120002));
  const hourly = db.prepare("SELECT step_ms,payload FROM telemetry_history WHERE server_id='hourly'").all();
  assert.equal(hourly.length, 1);
  assert.equal(hourly[0].step_ms, 3600000);
  assert.equal(JSON.parse(hourly[0].payload).cpu, 40);
  transaction(() => {
    for (let i = 0; i < 1001; i++) insert.run("expired-backlog", randomUUID(), now - 45 * day, "fixture", "{}");
  });
  transaction(() => maintainTelemetryHistory(db, 30, now + 180003));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE server_id='expired-backlog'").get().n, 501,
    "First retention pass must delete at most 500 expired reports");
  transaction(() => maintainTelemetryHistory(db, 30, now + 180004));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE server_id='expired-backlog'").get().n, 1,
    "Backlog must continue without waiting another minute");
  transaction(() => maintainTelemetryHistory(db, 30, now + 180005));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_reports WHERE server_id='expired-backlog'").get().n, 0);
  console.log("PASS: live-state isolation, inventory consistency, rollback, unchanged relations, weighted history, extrema, availability, conditional latency, bounded charts, log deduplication, retention and hourly rollups.");
} finally {
  db.close();
  await rm(temp, { recursive: true, force: true });
}
