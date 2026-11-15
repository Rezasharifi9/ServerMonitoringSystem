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
    if (url.endsWith("/src/server/managed-dns.ts")) return {
      format: "module-typescript", shortCircuit: true,
      source: readFileSync(new URL(url), "utf8").replace(/export async function syncPrimaryTunnelDns[\s\S]*?(?=\nconst recordInput)/,
        "export async function syncPrimaryTunnelDns(actor, domain, ip) { return globalThis.fixtureDns(domain, ip); }\n"),
    };
    if (url.endsWith("/src/server/ssh-connection.ts")) {
      const source = readFileSync(new URL(url), "utf8")
        .replace('import { Client, utils, type ClientChannel } from "ssh2";', 'import ssh2 from "ssh2"; import type { ClientChannel } from "ssh2"; const { Client, utils } = ssh2;')
        .replace(/export async function runServerInstaller[\s\S]*$/, `export async function runServerInstaller(actor, serverId, program, input) {
        return globalThis.fixtureInstall(serverId, input);
      }`);
      return { format: "module-typescript", source, shortCircuit: true };
    }
    return next(url, context);
  },
});

const temp = await mkdtemp(join(tmpdir(), "nodeguard-management-"));
process.env.NODEGUARD_DB_PATH = join(temp, "test.sqlite");
process.env.NODEGUARD_WORKSPACE_MODE = "monitor";
process.env.NODEGUARD_INVENTORY_PATH = join(root, "inventory.example.json");
process.env.NODEGUARD_CREDENTIAL_KEY = "a".repeat(64);
process.env.NODEGUARD_ENABLE_SSH_INSTALL = "1";
process.env.NODEGUARD_ORIGIN = "https://nodeguard.test";
let index = 1;
process.env.NODEGUARD_AGENT_TOKENS = JSON.stringify(Object.fromEntries(["ir-main", "ir-backup", "exit-1", "observer-1", "observer-2"].map((id) => [id, (index++).toString(16).padStart(64, "a")])));

const { database, transaction, readWorkspace, writeWorkspace } = await import("../src/server/database.ts");
const { writeSealedCredential } = await import("../src/server/provider-secrets.ts");
const { queueAgentUpdates, listAgentUpdates, drainAgentUpdates } = await import("../src/server/agent-updates.ts");
const { registerTunnel, saveGreTransport, getTunnelBundleRecipe } = await import("../src/server/topology.ts");
const { selectNodeRoutes, setTunnelDns } = await import("../src/server/node-routes.ts");
const { prepareInventorySsh } = await import("../src/server/ssh-connection.ts");
const { serverV2bxReferences, v2bxRemovalTarget } = await import("../src/server/v2board-nodes.ts");
const { countryPresentation } = await import("../src/lib/country.ts");
const { getV2bxFiles, saveV2bxFiles, getGlobalV2bxFiles, saveGlobalV2bxFiles, applyGlobalV2bxFiles } = await import("../src/server/v2bx-files.ts");
const actor = { id: "usr-reza", name: "Test admin", role: "super-admin", email: "" };
const request = new Request("https://nodeguard.test/api/v1/settings/agent-updates");
const db = database();
try {
  const auxiliary = { route: '{"rules":[]}', outbound: '[{"tag":"direct","protocol":"freedom","settings":{"password":"auxiliary-secret"}}]' };
  assert.deepEqual(getV2bxFiles(actor, "exit-1"), { route: null, outbound: null });
  await saveV2bxFiles(actor, "exit-1", { ...auxiliary, apply: false });
  assert.deepEqual(getV2bxFiles(actor, "exit-1"), auxiliary);
  assert.ok(!String(db.prepare("SELECT sealed FROM provider_credentials WHERE provider=?").get("v2bx-files:exit-1").sealed).includes("auxiliary-secret"));
  assert.ok(!JSON.stringify(readWorkspace().state.audit).includes("auxiliary-secret"));
  await assert.rejects(saveV2bxFiles(actor, "exit-1", { route: "[]", outbound: null, apply: false }), { code: "V2BX_FILES" });
  await assert.rejects(saveV2bxFiles(actor, "ir-main", { ...auxiliary, apply: false }), { code: "V2BX_HOST" });
  await assert.rejects(saveV2bxFiles({ ...actor, role: "readonly" }, "exit-1", { ...auxiliary, apply: false }), { code: "FORBIDDEN" });
  globalThis.fixtureInstall = async () => { throw new Error("fixture restart failure"); };
  await assert.rejects(saveV2bxFiles(actor, "exit-1", { route: null, outbound: null, apply: true }), /fixture restart failure/);
  assert.deepEqual(getV2bxFiles(actor, "exit-1"), auxiliary);
  await saveV2bxFiles(actor, "exit-1", { route: null, outbound: null, apply: false });
  assert.deepEqual(getV2bxFiles(actor, "exit-1"), { route: null, outbound: null });
  const sshHost = readWorkspace().state.servers.find((host) => host.id === "exit-1");
  assert.deepEqual(getGlobalV2bxFiles(actor), { route: null, outbound: null });
  saveGlobalV2bxFiles(actor, auxiliary);
  assert.deepEqual(getGlobalV2bxFiles(actor), auxiliary);
  assert.deepEqual(getV2bxFiles(actor, "exit-1"), { route: null, outbound: null });
  assert.throws(() => saveGlobalV2bxFiles({ ...actor, role: "operator" }, auxiliary), { code: "FORBIDDEN" });
  await assert.rejects(applyGlobalV2bxFiles(actor, { ...auxiliary, serverId: "ir-main" }), { code: "V2BX_HOST" });
  await assert.rejects(applyGlobalV2bxFiles(actor, { ...auxiliary, serverId: "exit-1" }), /fixture restart failure/);
  assert.deepEqual(getV2bxFiles(actor, "exit-1"), { route: null, outbound: null });
  globalThis.fixtureInstall = async (serverId, input) => {
    let raw = "";
    for await (const chunk of input) raw += chunk;
    assert.equal(serverId, "exit-1");
    assert.deepEqual(JSON.parse(raw), { ...auxiliary, restartStopped: true });
  };
  await applyGlobalV2bxFiles(actor, { ...auxiliary, serverId: "exit-1" });
  assert.deepEqual(getV2bxFiles(actor, "exit-1"), auxiliary);
  assert.ok(!JSON.stringify(readWorkspace().state.audit).includes("auxiliary-secret"));
  await saveV2bxFiles(actor, "exit-1", { route: null, outbound: null, apply: false });
  console.log("PASS: global V2bX files enforce permissions and foreign hosts, preserve failed targets, and apply with mandatory restart.");
  const originalLogin = { method: "password", password: "fixture-old-password", port: 22, username: "root", ip: sshHost.publicIpv4, fingerprint: "SHA256:" + "A".repeat(43) };
  writeSealedCredential(db, "ssh:exit-1", originalLogin);
  const settings = { publicIpv4: sshHost.publicIpv4, sshUsername: "root", sshPort: 22 };
  const unchanged = await prepareInventorySsh("exit-1", settings);
  transaction((connection) => unchanged.persist(connection, "exit-1"));
  const samePassword = await prepareInventorySsh("exit-1", { ...settings, password: originalLogin.password });
  transaction((connection) => samePassword.persist(connection, "exit-1"));
  const pending = await prepareInventorySsh("exit-1", settings);
  writeSealedCredential(db, "ssh:exit-1", { ...originalLogin, password: "concurrent-change" });
  assert.throws(() => transaction((connection) => pending.persist(connection, "exit-1")), { code: "SSH_SETTINGS_CHANGED" });
  db.prepare("DELETE FROM provider_credentials WHERE provider='ssh:exit-1'").run();
  console.log("PASS: unchanged SSH credentials survive key ordering, same password requires no connection, and real concurrent changes are rejected.");
  transaction((connection) => {
    const { state, revision } = readWorkspace(connection);
    state.servers.find((server) => server.id === "exit-1").panelNodeRefs = ["vless:123", "vmess:456"];
    writeWorkspace(connection, state, revision + 1);
  });
  assert.deepEqual(db.prepare("SELECT node_reference FROM server_panel_nodes WHERE server_id='exit-1' ORDER BY node_reference").all().map((row) => row.node_reference), ["vless:123", "vmess:456"]);
  assert.throws(() => db.prepare("INSERT INTO server_panel_nodes VALUES ('missing-host','vless:123')").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO server_panel_nodes VALUES ('exit-1','vless:999')").run(), /FOREIGN KEY/);
  assert.ok(serverV2bxReferences("exit-1").has("vless:123"));
  transaction((connection) => {
    const { state, revision } = readWorkspace(connection);
    delete state.servers.find((server) => server.id === "exit-1").panelNodeRefs;
    writeWorkspace(connection, state, revision + 1);
  });
  assert.equal(db.prepare("SELECT count(*) AS n FROM server_panel_nodes").get().n, 0);
  assert.equal(countryPresentation("de", "en-US").name, "Germany");
  assert.equal(countryPresentation("IR", "fa-IR").name, "ایران");
  for (const code of ["", "ZZ", "XX", "123", undefined]) assert.equal(countryPresentation(code, "fa-IR"), null);
  const { dashboardNodeCounts } = await import("../src/lib/dashboard.ts");
  const { panelOnlineSummary } = await import("../src/lib/node-inventory.ts");
  const { iranBandwidth } = await import("../src/server/metrics.ts");
  const time = Math.floor(Date.now() / 60000) * 60000 + 30000;
  const entry = { key: "vmess:1", nodeId: "n" };
  const node = { id: "n", primaryTunnelId: "p", backupTunnelId: "b", activeSide: "primary" };
  const tunnel = { id: "p", status: "healthy", packetLoss: 15, lastCheck: new Date(time).toISOString() };
  const count = (n = node, links = [tunnel]) => dashboardNodeCounts([entry], [n], links, 90000, time);
  assert.deepEqual(count(), { healthy: 1, degraded: 0, offline: 0, unknown: 0 });
  assert.deepEqual(count(node, [{ ...tunnel, packetLoss: 15.01 }]), { healthy: 1, degraded: 1, offline: 0, unknown: 0 });
  assert.deepEqual(count(node, [{ ...tunnel, status: "offline" }]), { healthy: 0, degraded: 1, offline: 1, unknown: 0 });
  assert.equal(count(node, []).unknown, 1);
  assert.equal(count(node, [{ ...tunnel, lastCheck: "" }]).unknown, 1);
  assert.equal(count(node, [{ ...tunnel, lastCheck: new Date(time - 90001).toISOString() }]).unknown, 1);
  assert.equal(count({ ...node, activeSide: "backup" }, [{ ...tunnel, status: "offline" }, { ...tunnel, id: "b" }]).healthy, 1);
  const { nodeInventoryRows } = await import("../src/lib/node-inventory.ts");
  const panelEntry = { key: "vless:292", host: "ro.example", name: "RO", type: "vless" };
  const direct = { ...tunnel, id: "direct", nodeRef: { kind: "v2board", key: panelEntry.key }, nodeDomain: panelEntry.host, nodeIds: [], kind: "interface", side: "primary", iranEndpoint: { publicIp: "192.0.2.1" }, foreignEndpoint: { serverId: "exit" } };
  assert.equal(dashboardNodeCounts([panelEntry], [], [direct], 90000, time).healthy, 1);
  assert.equal(dashboardNodeCounts([{ ...panelEntry, key: "vless:999" }], [], [direct], 90000, time).unknown, 1);
  assert.equal(dashboardNodeCounts([panelEntry], [], [{ ...direct, lastCheck: new Date(time + 31000).toISOString() }], 90000, time).unknown, 1);
  assert.equal(nodeInventoryRows([], [panelEntry], [{ ...direct, lastCheck: new Date().toISOString() }], [], [], 120, true, [])[0].routeStatus, "healthy");
  const { evaluateMetricAlerts } = await import("../src/server/metric-alerts.ts");
  const alertState = structuredClone(readWorkspace().state);
  const alertHost = alertState.servers[0];
  alertState.alerts = [];
  alertState.settings.metricAlertRules = [{ id: "test-rule-lifecycle", name: "CPU", metric: "cpu", targetId: alertHost.id, operator: "gt", threshold: 50, cooldownMinutes: 1, enabled: true, severity: "critical" }];
  evaluateMetricAlerts(db, alertState, alertHost, new Date(time).toISOString(), { cpu: 80 }, new Map());
  evaluateMetricAlerts(db, alertState, alertHost, new Date(time + 120000).toISOString(), { cpu: 80 }, new Map());
  assert.equal(alertState.alerts.length, 1, "Continuing outage must not create duplicate alerts");
  assert.equal(alertState.alerts[0].severity, "critical");
  evaluateMetricAlerts(db, alertState, alertHost, new Date(time + 121000).toISOString(), { cpu: 40 }, new Map());
  assert.equal(alertState.alerts[0].resolved, true);
  evaluateMetricAlerts(db, alertState, alertHost, new Date(time + 122000).toISOString(), { cpu: 80 }, new Map());
  assert.equal(alertState.alerts.length, 2, "Recovery permits a new incident after cooldown");
  db.prepare("DELETE FROM metric_alert_cooldowns WHERE rule_id='test-rule-lifecycle'").run();
  alertState.alerts = [];
  alertState.settings.metricAlertRules[0].targetId = "all";
  const secondHost = alertState.servers.find((server) => server.id !== alertHost.id);
  evaluateMetricAlerts(db, alertState, alertHost, new Date(time + 300000).toISOString(), { cpu: 80 }, new Map());
  evaluateMetricAlerts(db, alertState, secondHost, new Date(time + 300000).toISOString(), { cpu: 80 }, new Map());
  assert.equal(alertState.alerts.filter((alert) => !alert.resolved).length, 2);
  evaluateMetricAlerts(db, alertState, alertHost, new Date(time + 301000).toISOString(), { cpu: 10 }, new Map());
  assert.equal(alertState.alerts.find((alert) => alert.serverId === secondHost.id).resolved, false);
  assert.equal(alertState.alerts.find((alert) => alert.serverId === alertHost.id).resolved, true);
  const { tickTelegram, saveTelegramConfig, sendTelegramTest } = await import("../src/server/telegram.ts");
  saveTelegramConfig(actor, { token: "123456:" + "a".repeat(30), botId: "123456", adminId: "12345" });
  transaction((connection) => {
    const { state, revision } = readWorkspace(connection);
    state.alerts = alertState.alerts;
    state.settings.metricAlertRules = alertState.settings.metricAlertRules;
    state.settings.notifications.telegram = true;
    state.settings.notifications.onSeverity = "info";
    writeWorkspace(connection, state, revision + 1);
  });
  const telegramOriginalFetch = globalThis.fetch;
  const telegramOriginalNow = Date.now;
  let clock = telegramOriginalNow();
  let sends = 0;
  Date.now = () => clock;
  globalThis.fetch = async () => { sends++; return Response.json({ ok: true, result: { message_id: sends } }); };
  try {
    await tickTelegram(actor);
    assert.equal(sends, 1);
    clock += 3599999;
    await tickTelegram(actor);
    assert.equal(sends, 1, "No reminder before one hour");
    clock += 1;
    await tickTelegram(actor);
    assert.equal(sends, 2, "Unresolved alert repeats after one hour");
    transaction((connection) => {
      const { state, revision } = readWorkspace(connection);
      state.alerts = state.alerts.map((alert) => ({ ...alert, resolved: true }));
      writeWorkspace(connection, state, revision + 1);
    });
    clock += 3600000;
    await tickTelegram(actor);
    assert.equal(sends, 2, "Recovery stops reminders");
    const testKey = randomUUID();
    const testResult = await sendTelegramTest(actor, testKey);
    assert.equal(testResult.status, "sent", "Test sends without a background worker");
    assert.equal(sends, 3);
    assert.equal((await sendTelegramTest(actor, testKey)).replay, true);
    assert.equal(sends, 3, "Replaying a test must not send twice");
    clock += 30001;
    globalThis.fetch = async () => Response.json({ ok: false }, { status: 403 });
    const rejected = await sendTelegramTest(actor, randomUUID());
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.detail, "bot_forbidden");
  } finally { globalThis.fetch = telegramOriginalFetch; Date.now = telegramOriginalNow; }
  console.log("PASS: global rules isolate servers and Telegram reminders repeat hourly until recovery.");
  const summary = panelOnlineSummary([{ key: "p", name: "Parent", online: 7 }, { key: "c", name: "Child", online: 7, parentKey: "p" }, { key: "z", name: "Zero", online: 0 }, { key: "u", name: "Missing" }]);
  assert.equal(summary.total, 7);
  assert.equal(summary.shared, 1);
  assert.equal(summary.reported.length, 3);
  const hosts = [{ id: "test-ir-a", roles: ["iran"] }, { id: "test-ir-b", roles: ["iran-backup"] }, { id: "test-exit", roles: ["foreign"] }];
  const insert = db.prepare("INSERT INTO agent_reports (server_id,id,observed_at,fingerprint,payload) VALUES (?,?,?,?,?)");
  for (const [id, rx, tx] of [["test-ir-a", 10, 20], ["test-ir-a", 30, 40], ["test-ir-b", 5, 5], ["test-exit", 900, 900]]) {
    insert.run(id, randomUUID(), time - 1000, "fixture", JSON.stringify({ rxMbps: rx, txMbps: tx, tunnels: [{ rxMbps: 9999, txMbps: 9999 }] }));
  }
  // CPU-only reports must not dilute the traffic average.
  insert.run("test-ir-a", randomUUID(), time - 500, "fixture", JSON.stringify({ cpu: 40 }));
  const fleet = iranBandwidth("15m", hosts, time);
  assert.equal(fleet.at(-1).bandwidth, 60);
  assert.equal(fleet.at(-2).bandwidth, null);
  assert.equal(iranBandwidth("15m", [...hosts, { id: "missing", roles: ["iran"] }], time).at(-1).bandwidth, null);
  assert.ok(iranBandwidth("15m", [], time).every((point) => point.bandwidth === null));
  db.prepare("DELETE FROM agent_reports WHERE server_id LIKE 'test-%'").run();
  const { panelOnlineSnapshot, panelCatalog } = await import("../src/server/providers.ts");
  const previousEndpoint = process.env.NODEGUARD_V2BOARD_ENDPOINT;
  const previousAuth = process.env.NODEGUARD_V2BOARD_AUTH;
  const originalFetch = globalThis.fetch;
  process.env.NODEGUARD_V2BOARD_ENDPOINT = "https://panel.nodeguard.example/api/v1/admin/server/manage/getNodes";
  process.env.NODEGUARD_V2BOARD_AUTH = "fixture-online-token";
  let reads = 0;
  let failOnline = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), process.env.NODEGUARD_V2BOARD_ENDPOINT);
    assert.equal(options.headers.get("Authorization"), "fixture-online-token");
    assert.equal(options.method, "GET");
    assert.equal(options.cache, "no-store");
    if (failOnline) return new Response(null, { status: 502 });
    reads++;
    return Response.json({ data: [{ id: 1, type: "vmess", name: "Live", host: "test.example", port: 443, online: reads },
      { id: 2, type: "vmess", name: "Zero", host: "test.example", port: 443, online: 0 },
      { id: 3, type: "vmess", name: "Missing", host: "test.example", port: 443 }] });
  };
  try {
    const before = JSON.stringify({ workspace: readWorkspace(), catalog: panelCatalog() });
    const first = await panelOnlineSnapshot();
    const second = await panelOnlineSnapshot();
    assert.equal(first.nodes[0].online, 1);
    assert.equal(second.nodes[0].online, 2);
    assert.equal(second.nodes[1].online, 0);
    assert.equal(second.nodes[2].online, undefined);
    assert.ok(Number.isFinite(Date.parse(second.fetchedAt)));
    assert.equal(JSON.stringify({ workspace: readWorkspace(), catalog: panelCatalog() }), before);
    failOnline = true;
    await assert.rejects(panelOnlineSnapshot(), { code: "UPSTREAM" });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEndpoint === undefined) delete process.env.NODEGUARD_V2BOARD_ENDPOINT; else process.env.NODEGUARD_V2BOARD_ENDPOINT = previousEndpoint;
    if (previousAuth === undefined) delete process.env.NODEGUARD_V2BOARD_AUTH; else process.env.NODEGUARD_V2BOARD_AUTH = previousAuth;
  }
  const { execute } = await import("../src/server/actions.ts");
  const beforeArchive = readWorkspace();
  const archiveId = "dashboard-archive-fixture";
  transaction((database) => {
    const current = readWorkspace(database);
    current.state.settings.metricAlertRules.push({ id: "archive-rule", name: "Fixture", enabled: true, targetId: "all", metric: "serverLoss", operator: "gt", threshold: 10, cooldownMinutes: 60, severity: "warning" });
    current.state.alerts.push({ id: archiveId, metricRuleId: "archive-rule", title: "Fixture", severity: "warning", category: "high-loss", createdAt: new Date().toISOString(), acked: false, resolved: false, detail: "Test" });
    writeWorkspace(database, current.state, current.revision + 1);
  });
  await assert.rejects(execute({ ...actor, id: "usr-leila", role: "readonly" }, { action: "archiveAlert", args: [archiveId] }, randomUUID()), { code: "FORBIDDEN" });
  await execute(actor, { action: "archiveAlert", args: [archiveId] }, randomUUID());
  const archived = readWorkspace().state.alerts.find((alert) => alert.id === archiveId);
  assert.equal(archived.archived, true);
  assert.equal(archived.resolved, false);
  assert.equal(JSON.parse(db.prepare("SELECT snapshot FROM workspace").get().snapshot).alerts.find((alert) => alert.id === archiveId).archived, true);
  await execute(actor, { action: "restoreAlert", args: [archiveId] }, randomUUID());
  assert.equal(readWorkspace().state.alerts.find((alert) => alert.id === archiveId).archived, false);
  await assert.rejects(execute(actor, { action: "archiveAlert", args: ["nonexistent-alert"] }, randomUUID()));
  transaction((database) => writeWorkspace(database, beforeArchive.state, readWorkspace(database).revision + 1));
  console.log("PASS: fresh read-only online statistics, zero/missing/error cases and durable archive/restore permissions.");
  console.log("PASS: dashboard tunnel status, strict 15% threshold, backup route, stale observations, shared online counts and per-server Iran bandwidth aggregation.");
  const initial = readWorkspace().state;
  const original = initial.nodes[0];
  assert.ok(original.tunnelIds.includes(original.primaryTunnelId));
  assert.ok(original.tunnelIds.includes(original.backupTunnelId));
  const route = (side, iran, technology = "GRE") => registerTunnel(actor, {
    nodeRef: { kind: "inventory", id: original.id }, routeKey: randomUUID(),
    iranServerId: iran, foreignServerId: original.foreignServerId, technology, side,
  }).resource;
  assert.throws(() => route("backup", "ir-backup"), { code: "BACKUP_ALREADY_REGISTERED" });
  const registeredBackup = initial.tunnels.find(tunnel => tunnel.id === original.backupTunnelId);
  const extras = [route("primary", "ir-main"), route("primary", "ir-main"), registeredBackup, registeredBackup];
  const isolatedRecipe = async (id) => {
    const saved = readWorkspace().state;
    transaction(connection => writeWorkspace(connection, { ...saved, tunnels: saved.tunnels.filter(t => t.id === id) }, readWorkspace(connection).revision + 1));
    try { return await getTunnelBundleRecipe(actor, id); }
    finally { transaction(connection => writeWorkspace(connection, saved, readWorkspace(connection).revision + 1)); }
  };
  assert.equal((await isolatedRecipe(extras[0].id)).greTransport, "udp");
  assert.throws(() => saveGreTransport({ ...actor, role: "readonly" }, extras[0].id, { transport: "native" }), { code: "FORBIDDEN" });
  assert.throws(() => saveGreTransport(actor, extras[0].id, { transport: "other" }), { code: "GRE_TRANSPORT" });
  saveGreTransport(actor, extras[0].id, { transport: "native" });
  assert.equal(readWorkspace().state.tunnels.find(t => t.id === extras[0].id).config.greTransport, "native");
  assert.equal((await isolatedRecipe(extras[0].id)).greTransport, "native");
  assert.throws(() => saveGreTransport(actor, extras[1].id, { transport: "native" }), { code: "GRE_NATIVE_EXISTS" });
  saveGreTransport(actor, extras[0].id, { transport: "udp" });
  console.log("PASS: GRE transport is validated, permission checked, persisted and exported to recipes; native duplicates are rejected.");
  const linked = readWorkspace().state.nodes[0];
  assert.equal(linked.primaryTunnelId, original.primaryTunnelId);
  assert.equal(linked.backupTunnelId, original.backupTunnelId);
  assert.ok(extras.every((tunnel) => linked.tunnelIds.includes(tunnel.id)));
  assert.equal(new Set(extras.map((tunnel) => tunnel.id)).size, 3);
  const choose = (primary, backup, activeSide = "primary") => selectNodeRoutes(actor, original.id, { primaryTunnelId: primary, backupTunnelId: backup, activeSide });
  await assert.rejects(choose("unlinked", extras[2].id), { code: "NODE_ROUTES_TOPOLOGY" });
  await assert.rejects(choose(extras[0].id, extras[2].id), { code: "NODE_ROUTES_UNHEALTHY" });
  await assert.rejects(choose(original.primaryTunnelId, undefined, "backup"), { code: "NODE_ROUTES_TOPOLOGY" });
  assert.equal(readWorkspace().state.nodes[0].primaryTunnelId, original.primaryTunnelId);
  transaction((database) => {
    const { state, revision } = readWorkspace(database);
    state.tunnels = state.tunnels.map((tunnel) => extras.some((extra) => extra.id === tunnel.id)
      ? { ...tunnel, status: "healthy", lastCheck: new Date().toISOString() } : tunnel);
    writeWorkspace(database, state, revision + 1);
  });
  let dnsChanges = [];
  globalThis.fixtureDns = async (domain, ip) => { dnsChanges.push({ domain, ip }); };
  await assert.rejects(setTunnelDns({ ...actor, role: "readonly" }, extras[0].id), { code: "FORBIDDEN" });
  await assert.rejects(setTunnelDns(actor, "missing-tunnel"), { code: "TUNNEL_UNKNOWN" });
  await setTunnelDns(actor, extras[0].id);
  assert.equal(dnsChanges.at(-1).domain, original.domain);
  assert.equal(dnsChanges.at(-1).ip, initial.servers.find((host) => host.id === "ir-main").publicIpv4);
  assert.equal(readWorkspace().state.nodes[0].primaryTunnelId, original.primaryTunnelId);
  transaction((connection) => {
    const { state, revision } = readWorkspace(connection);
    state.tunnels.find((item) => item.id === extras[0].id).lastCheck = "2000-01-01T00:00:00Z";
    writeWorkspace(connection, state, revision + 1);
  });
  const changesBefore = dnsChanges.length;
  await assert.rejects(setTunnelDns(actor, extras[0].id), { code: "TUNNEL_UNHEALTHY" });
  assert.equal(dnsChanges.length, changesBefore);
  transaction((connection) => {
    const { state, revision } = readWorkspace(connection);
    state.tunnels.find((item) => item.id === extras[0].id).lastCheck = new Date().toISOString();
    writeWorkspace(connection, state, revision + 1);
  });
  console.log("PASS: tunnel DNS uses linked domain and Iran public IP, checks permissions and fresh health, and preserves route selection.");
  await choose(extras[0].id, extras[2].id);
  assert.equal(readWorkspace().state.nodes[0].primaryTunnelId, extras[0].id);
  await choose(extras[0].id, extras[2].id, "backup");
  assert.equal(readWorkspace().state.nodes[0].activeSide, "backup");
  assert.equal(readWorkspace().state.nodes[0].backupTunnelId, extras[2].id);
  assert.equal(dnsChanges.at(-1).ip, initial.servers.find((host) => host.id === "ir-backup").publicIpv4);
  globalThis.fixtureDns = async () => { throw new Error("fixture DNS failure"); };
  await assert.rejects(setTunnelDns(actor, extras[0].id), /fixture DNS failure/);
  await assert.rejects(choose(extras[1].id, extras[3].id), /fixture DNS failure/);
  assert.equal(readWorkspace().state.nodes[0].primaryTunnelId, extras[0].id);
  assert.equal(readWorkspace().state.nodes[0].activeSide, "backup");

  const { deleteTunnelInventory } = await import("../src/server/tunnel-deployments.ts");
  const deletionInput = { nodeRef: { kind: "inventory", id: original.id }, technology: "GRE", side: "primary", port: 61991, iranServerId: "ir-main", foreignServerId: "exit-1", routeKey: randomUUID() };
  const disposable = registerTunnel(actor, deletionInput).resource;
  assert.equal(registerTunnel(actor, deletionInput).replay, true);
  transaction((connection) => {
    const { state, revision } = readWorkspace(connection);
    state.alerts.push({ id: "delete-fixture-alert", tunnelId: disposable.id, title: "Delete", severity: "warning", category: "high-loss", detail: "", createdAt: new Date().toISOString(), acked: false, resolved: false });
    state.incidents.push({ id: "delete-fixture-incident", tunnelId: disposable.id });
    writeWorkspace(connection, state, revision + 1);
  });
  db.prepare("INSERT INTO telemetry_history VALUES (?,?,?,?)").run("ir-main", Date.now() - 4 * 86400000, 300000,
    JSON.stringify({ tunnels: [{ tunnelId: disposable.id }, { tunnelId: "other-history-route" }] }));
  assert.equal(deleteTunnelInventory(actor, disposable.id).removed, true);
  const purgedArchive = JSON.parse(db.prepare("SELECT payload FROM telemetry_history WHERE server_id='ir-main'").get().payload);
  assert.deepEqual(purgedArchive.tunnels, [{ tunnelId: "other-history-route" }]);

  assert.ok(!readWorkspace().state.alerts.some((item) => item.tunnelId === disposable.id));
  assert.ok(!readWorkspace().state.incidents.some((item) => item.tunnelId === disposable.id));
  assert.equal(db.prepare("SELECT count(*) AS n FROM activity_logs WHERE tunnel_id=? OR target=?").get(disposable.id, disposable.id).n, 0);
  const replacement = registerTunnel(actor, deletionInput).resource;
  assert.notEqual(replacement.id, disposable.id, "Recreated route must get a new identity even for an identical request");
  deleteTunnelInventory(actor, replacement.id);
  console.log("PASS: direct panel tunnel health, alert recovery/deduplication, deletion history purge and fresh recreated route identities.");
  const installEvidence = (id, status, createdAt) => {
    db.prepare(`INSERT INTO provision_jobs (id,actor_id,request_key,fingerprint,server_id,profile,status,detail,created_at,queue_until)
      VALUES (?,'fixture',?,'fixture','exit-1','{}',?,'fixture',?,?)`).run(id, id, status, createdAt, createdAt + 100000);
    db.prepare("INSERT INTO v2bx_install_nodes VALUES ('exit-1','vmess:7',?)").run(id);
  };
  installEvidence("installed", "succeeded", 1);
  installEvidence("failed-reinstall", "failed", 2);
  assert.ok(serverV2bxReferences("exit-1").has("vmess:7"));
  assert.ok(!serverV2bxReferences("observer-1").has("vmess:7"));
  await assert.rejects(v2bxRemovalTarget(actor, "vmess:7", "observer-1"), { code: "V2BX_NODE_HOST" });
  db.prepare(`INSERT INTO provision_jobs (id,actor_id,request_key,fingerprint,server_id,profile,status,detail,created_at,queue_until,operation)
    VALUES ('removed','fixture','removed','fixture','exit-1',?,'succeeded','removed',3,4,'remove-v2bx')`)
    .run(JSON.stringify({ v2bxNode: { nodeId: 7, nodeType: "vmess" } }));
  assert.ok(!serverV2bxReferences("exit-1").has("vmess:7"));
  installEvidence("reinstalled", "succeeded", 4);
  assert.ok(serverV2bxReferences("exit-1").has("vmess:7"));

  for (const host of initial.servers.filter((host) => host.id !== "observer-2")) {
    writeSealedCredential(db, "ssh:" + host.id, { ip: host.publicIpv4, username: "root", port: 22, fingerprint: "SHA256:" + "a".repeat(43), method: "password", password: "fixture-password" });
  }
  let active = 0;
  let maximum = 0;
  let fail = true;
  globalThis.fixtureInstall = async (serverId, input) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      let size = 0;
      for await (const chunk of input) size += chunk.length;
      assert.ok(size > 10000);
      await new Promise((done) => setTimeout(done, 50));
      if (serverId === "observer-1" && fail) throw new Error("fixture offline");
      db.prepare("INSERT INTO agent_reports VALUES (?,?,?,?,?)").run(serverId, randomUUID(), Date.now(), "fixture", "{}");
    } finally { active--; }
  };
  const queued = queueAgentUpdates(actor);
  assert.equal(queued.jobs.length, initial.servers.length);
  assert.throws(() => queueAgentUpdates(actor), { code: "AGENT_UPDATE_BUSY" });
  await drainAgentUpdates(request);
  const done = listAgentUpdates(actor);
  assert.equal(maximum, 3);
  assert.equal(done.jobs.filter((job) => job.status === "succeeded" && job.reporting).length, 3);
  assert.equal(done.jobs.filter((job) => job.status === "failed").length, 2);
  assert.ok(done.jobs.find((job) => job.serverId === "observer-2").detail.includes("SSH"));
  fail = false;
  const retried = queueAgentUpdates(actor, true);
  assert.equal(retried.jobs.length, 2);
  // Simulate a process disappearing after claiming a job. Recovery resumes the
  // durable batch without re-running already successful jobs.
  db.prepare("UPDATE agent_update_jobs SET status='running',lease_until=? WHERE id=?").run(Date.now() - 1, retried.jobs[0].id);
  await drainAgentUpdates(request);
  assert.equal(listAgentUpdates(actor).jobs.find((job) => job.serverId === "observer-1").status, "succeeded");
  assert.equal(listAgentUpdates(actor).jobs.find((job) => job.serverId === "observer-2").status, "failed");
  assert.throws(() => queueAgentUpdates({ ...actor, role: "readonly" }), { code: "FORBIDDEN" });
  transaction((database) => {
    const { state, revision } = readWorkspace(database);
    writeWorkspace(database, state, revision + 1);
  });
  const persisted = JSON.parse(db.prepare("SELECT snapshot FROM workspace").get().snapshot);
  assert.ok(extras.every((tunnel) => persisted.nodes[0].tunnelIds.includes(tunnel.id)));
  for (const technology of ["Rathole", "Backhaul"]) {
    const created = registerTunnel(actor, { technology, side: "primary", iranServerId: "ir-main", foreignServerId: "exit-1", nodeRef: { kind: "inventory", id: "node-1" } }).resource;
    assert.equal(created.kind, "forwarder", "Linked forwarders derive the node port without a duplicate manual port");
    assert.equal(typeof (await getTunnelBundleRecipe(actor, created.id)).port, "number");
  }
  console.log("PASS: localized countries, multi-tunnel migration and registration, route validation, durable Agent update queue, concurrency limit, partial failure, retries and interrupted-job recovery.");
} finally {
  db.close();
  await rm(temp, { recursive: true, force: true });
}

