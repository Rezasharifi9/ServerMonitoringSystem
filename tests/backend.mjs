import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import ssh2 from "ssh2";

const parent = join(process.cwd(), ".nodeguard");
await mkdir(parent, { recursive: true });
const temp = await mkdtemp(join(parent, "integration-"));
const listener = createServer();
await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
const { port } = listener.address();
await new Promise((resolve) => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;

async function newPersianPage(browser) {
  const page = await browser.newPage({ locale: "fa-IR" });
  await page.context().addCookies([{ name: "nodeguard-locale", value: "fa-IR", url: base }]);
  await page.addInitScript(() => localStorage.setItem("nodeguard-locale", "fa-IR"));
  return page;
}
const admin = randomBytes(32).toString("hex");
const readonly = randomBytes(32).toString("hex");
const agent = randomBytes(32).toString("hex");
const observer = randomBytes(32).toString("hex");
const receiver = randomBytes(32).toString("hex");
const backupAgent = randomBytes(32).toString("hex");
const observerTwo = randomBytes(32).toString("hex");
const infra = randomBytes(32).toString("hex");
const dnsWorker = randomBytes(32).toString("hex");
const healthWorker = randomBytes(32).toString("hex");
const panelWorker = randomBytes(32).toString("hex");
const credentialKey = randomBytes(32).toString("hex");
const panelDb = join(temp, "panel-scheduled.sqlite");
const panelStatePath = join(temp, "v2board-state.json");
const heartbeatDb = join(temp, "heartbeat.sqlite");
const standbyDb = join(temp, "standby.sqlite");
const passwordDb = join(temp, "password.sqlite");
const scheduledDb = join(temp, "agent-scheduled.sqlite");
const artifactManifest = JSON.stringify({ id: "download-test", component: "BBR", version: "1.0" });
const artifactHash = createHash("sha256").update(artifactManifest).digest("hex");
const artifactDirectory = join(temp, "provision-artifacts", artifactHash);
const db = join(temp, "test.sqlite");
const autoDbPath = join(temp, "automatic.sqlite");
const providerStatePath = join(temp, "dns-fixture.json");
const telegramStatePath = join(temp, "telegram-fixture.json");
const gmailStatePath = join(temp, "gmail-fixture.txt");
const registrationConfig = join(temp, "agent-enrollment.json");
const downloadedInstaller = join(temp, "nodeguard-agent-install.py");
const registrationToken = join(temp, "agent-enrollment.token");
let child;

async function start(serverId = "", mode = "simulation", iperf = false, failoverFixture = false, provisionFixture = false, dnsMonitor = false, options = {}) {
  child = spawn(process.execPath, ["--import", "./tests/ip-lookup-fixture.mjs", ...(failoverFixture ? ["--import", "./tests/cloudflare-fixture.mjs"] : []), ...(provisionFixture ? ["--import", "./tests/telegram-fixture.mjs", "--import", "./tests/v2board-fixture.mjs"] : []), ...(options.gmailFixture ? ["--import", "./tests/gmail-fixture.mjs"] : []), "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env,
      NODEGUARD_DB_PATH: options.dbPath ?? (mode === "monitor" ? join(temp, "monitor.sqlite") : db),
      NODEGUARD_WORKSPACE_MODE: mode,
      NODEGUARD_ALLOW_LEGACY_TELEMETRY: options.dbPath === scheduledDb ? "0" : "1",
      NODEGUARD_GMAIL_TEST_STATE: options.gmailFixture ? gmailStatePath : "",
      NODEGUARD_INVENTORY_PATH: "inventory.example.json",
      NODEGUARD_CREDENTIAL_KEY: credentialKey,
      NODEGUARD_V2BOARD_ENDPOINT: provisionFixture ? "https://panel.nodeguard.example/api/v1/fixture-admin/server/manage/getNodes" : "",
      NODEGUARD_V2BOARD_AUTH: provisionFixture ? "Bearer fixture-panel-token" : "",
      NODEGUARD_V2BOARD_MAP: provisionFixture ? JSON.stringify({ "vmess:7": "node-1" }) : "{}",
      NODEGUARD_ENABLE_V2BOARD_MONITOR: options.panelMonitor ? "1" : "0",
      NODEGUARD_V2BOARD_WORKER_TOKEN: panelWorker,
      NODEGUARD_V2BOARD_POLL_SECONDS: "300",
      NODEGUARD_V2BOARD_TEST_STATE: options.panelMonitor ? panelStatePath : "",
      NODEGUARD_CF_ZONE_ID: failoverFixture && !options.resolverOnly ? "a".repeat(32) : "",
      NODEGUARD_CF_TOKEN: failoverFixture && !options.resolverOnly ? "fixture-dns-token" : "",
      NODEGUARD_ARVAN_ZONES: options.arvan ? JSON.stringify(["nodeguard.example"]) : "[]",
      NODEGUARD_ARVAN_TOKEN: options.arvan ? "fixture-arvan-read-key" : "",
      NODEGUARD_CF_WRITE_TOKEN: failoverFixture ? "fixture-dns-write-token" : "",
      NODEGUARD_CF_FAILOVER_RECORDS: JSON.stringify({ "node-1": "b".repeat(32) }),
      NODEGUARD_CF_TEST_STATE: providerStatePath,
      NODEGUARD_DNS_RESOLVERS: failoverFixture ? JSON.stringify(["192.0.2.53"]) : "",
      NODEGUARD_ENABLE_DNS_FAILOVER: failoverFixture && !dnsMonitor ? "1" : "0",
      NODEGUARD_ENABLE_DNS_MONITOR: dnsMonitor ? "1" : "0",
      NODEGUARD_DNS_WORKER_TOKEN: dnsWorker,
      NODEGUARD_ENABLE_HEALTH_MONITOR: options.healthMonitor ? "1" : "0",
      NODEGUARD_HEALTH_WORKER_TOKEN: healthWorker,
      NODEGUARD_DNS_POLL_SECONDS: "120",
      NODEGUARD_ENABLE_AUTO_FAILOVER: options.autoFailover ? "1" : "0",
      NODEGUARD_ENABLE_AUTO_STANDBY: options.autoStandby ? "1" : "0",
      NODEGUARD_AUTO_STANDBY_TUNNELS: options.autoStandby ? JSON.stringify({ "node-1": "tun-backup" }) : "{}",
      NODEGUARD_ENABLE_PROVISION: provisionFixture ? "1" : "0",
      NODEGUARD_PROVISION_PROFILES: provisionFixture ? JSON.stringify([
        { id: "bbr-lab", serverId: "exit-1", component: "BBR", version: "1.0", sha256: "c".repeat(64), summary: "Fixture BBR" },
        { id: "gre-in", serverId: "ir-main", component: "GRE", version: "1.0", sha256: "d".repeat(64), summary: "Fixture GRE Iran", forwardPort: 443, greTransport: "udp" },
        { id: "gre-out", serverId: "exit-1", component: "GRE", version: "1.0", sha256: "e".repeat(64), summary: "Fixture GRE foreign", greTransport: "udp" },
        ...(options.autoStandby ? [
          { id: "wg-standby-in", serverId: "ir-backup", component: "WireGuard", version: "1.0", sha256: "a".repeat(64), summary: "Fixture standby Iran", forwardPort: 443 },
          { id: "wg-standby-out", serverId: "exit-1", component: "WireGuard", version: "1.0", sha256: "b".repeat(64), summary: "Fixture standby foreign" },
        ] : []),
      ]) : "[]",
      NODEGUARD_TUNNEL_PROFILES: provisionFixture ? JSON.stringify([
        { tunnelId: "tun-main", iranProfileId: "gre-in", foreignProfileId: "gre-out" },
        ...(options.autoStandby ? [{ tunnelId: "tun-backup", iranProfileId: "wg-standby-in", foreignProfileId: "wg-standby-out" }] : []),
      ]) : "[]",
      NODEGUARD_ENABLE_TELEGRAM: provisionFixture ? "1" : "0",
      NODEGUARD_TELEGRAM_BOT_TOKEN: provisionFixture ? "100:fixture_test_token_abcdef" : "",
      NODEGUARD_TELEGRAM_CHAT_ID: provisionFixture ? "-100123456789" : "",
      NODEGUARD_TELEGRAM_TEST_STATE: telegramStatePath,
      NODEGUARD_ENABLE_IPERF: iperf ? "1" : "0",
      NODEGUARD_IPERF_TARGETS: JSON.stringify({ "tun-main": { receiverServerId: "exit-1", port: 5201 } }),
      NODEGUARD_ORIGIN: base,
      ...(options.adminHash && { NODEGUARD_ADMIN_USER: "fixture-admin", NODEGUARD_ADMIN_PASSWORD_HASH: options.adminHash }),
      NODEGUARD_USER_TOKENS: JSON.stringify({ "usr-reza": admin, "usr-leila": readonly, "usr-sara": infra }),
      NODEGUARD_AGENT_TOKENS: JSON.stringify(mode === "monitor" ? { [serverId]: agent, "observer-1": observer, "observer-2": observerTwo, "exit-1": receiver, "ir-backup": backupAgent } : serverId ? { [serverId]: agent } : {}),
      NODEGUARD_PROXY_OBSERVERS: JSON.stringify(mode === "monitor" ? { "node-1": ["observer-1", "observer-2"] } : {}),
      NODEGUARD_SECURE_COOKIE: "0",
    },
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(output);
    if ((await fetch(base + "/api/v1/status").catch(() => null))?.ok) return;
    await delay(100);
  }
  throw new Error("NodeGuard did not start.\n" + output);
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}

async function api(path, { token = admin, status = 200, headers, body, method = body ? "POST" : "GET" } = {}) {
  const response = await fetch(base + "/api/v1/" + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const content = await response.text();
  assert.equal(response.status, status, `${method} ${path} ${content.slice(0, 500)}`);
  const payload = JSON.parse(content);
  return { ...payload, headers: response.headers };
}

function action(action, args, options) {
  return api("actions", {
    body: { action, args }, ...options,
    headers: { "Idempotency-Key": randomUUID(), ...options?.headers },
  });
}

try {
  await start();
  await api("servers", { body: {}, status: 409 });
  await api("tunnels", { body: {}, status: 409 });
  await api("tunnels/tun-main/bundle-recipe", { status: 409 });
  await api("provision/catalog/preview", { body: {}, status: 409 });
  await api("agent/enroll", { body: {}, status: 409 });
  await api("servers/ir-main/agent/installer", { status: 409 });
  await api("staging/readiness?nodeId=node-1", { status: 409 });
  await api("dns/monitor/tick", { method: "POST", token: dnsWorker, status: 503 });
  await api("health/worker/tick", { method: "POST", token: healthWorker, status: 503 });
  assert.equal((await fetch(base + "/")).status, 200);
  await api("workspace", { token: null, status: 401 });
  const workspace = await api("workspace");
  assert.equal(workspace.data.nodes.length, 24);
  assert.ok(workspace.data.integrations.every((i) => !("token" in i.config)));
  assert.equal((await api("nodes?limit=5&page=2")).data.length, 5);
  const [server] = workspace.data.servers;
  const [node] = workspace.data.nodes;
  if (process.argv[2] && process.argv[3]) {
    const { chromium } = await import(pathToFileURL(process.argv[2]).href);
    const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
    try {
      const page = await newPersianPage(browser);
      await page.goto(base + "/");
      await page.getByRole("button", { name: /رضا مرادی/ }).click();
      await page.getByRole("button", { name: "ورود به بک‌اند", exact: true }).click();
      await page.locator("#backend-token").fill(admin);
      await page.getByRole("button", { name: "ورود", exact: true }).click();
      await page.getByText("بک‌اند · عملیات نمایشی").waitFor();
      await page.goto(base + "/servers/" + server.id);
      await page.locator("textarea").fill("ذخیره از مرورگر");
      const saved = page.waitForResponse((response) => response.url().endsWith("/api/v1/actions") && response.request().method() === "POST");
      await page.getByRole("button", { name: "ذخیره پیکربندی نمایشی" }).click();
      assert.equal((await saved).status(), 200);
      await page.reload();
      await page.locator("textarea").waitFor();
      assert.equal(await page.locator("textarea").inputValue(), "ذخیره از مرورگر");
      assert.equal((await api("servers/" + server.id)).data.notes, "ذخیره از مرورگر");
      console.log("PASS: browser login, server notes save, and persistence after reload.");
    } finally {
      await browser.close();
    }
  }
  await api("nodes/" + node.id + "/health");
  await api("logs");
  await api("metrics?range=30d");
  await api("session", { token: null, body: { userId: "__proto__", token: admin }, status: 401 });
  const login = await api("session", { token: null, body: { userId: "usr-leila", token: readonly } });
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const session = login.headers.get("set-cookie").split(";")[0];
  await api("workspace", { token: null, headers: { Cookie: session } });
  await action("updateServerNotes", [server.id, "denied"], { token: null, headers: { Cookie: session }, status: 403 });
  await action("updateServerNotes", [server.id, "denied"], { headers: { Origin: "https://invalid.example" }, status: 403 });
  await action("updateNodeSettings", [node.id, { port: -1 }], { status: 422 });
  await api("session", { token: null, headers: { Cookie: session }, method: "DELETE" });
  await api("workspace", { token: null, headers: { Cookie: session }, status: 401 });

  const initialBrowserAuditId = process.argv[2] ? (await api("audit")).data.find((entry) => entry.action === "server.notes")?.id : undefined;
  const key = randomUUID();
  const headers = { "Idempotency-Key": key };
  const note = "یادداشت ماندگار";
  const results = await Promise.all([
    action("updateServerNotes", [server.id, note], { headers }),
    action("updateServerNotes", [server.id, note], { headers }),
    action("updatePolicy", [node.id, { intervalSec: 120 }]),
  ]);
  assert.equal(results.filter((result) => result.replay).length, 1);
  await action("updateServerNotes", [server.id, "different"], { headers, status: 409 });
  assert.equal((await api("servers/" + server.id)).data.notes, note);
  const after = await api("workspace");
  assert.equal(after.data.audit.filter((entry) => entry.action === "server.notes" && entry.target === server.id && entry.id !== initialBrowserAuditId).length, 1);
  assert.equal(after.data.policies.find((p) => p.nodeId === node.id).intervalSec, 120);

  await api("providers/v2board/catalog");
  await api("providers/v2board/sync", { method: "POST", status: 503 });
  await api("providers/v2board/worker/tick", { method: "POST", token: panelWorker, status: 503 });
  await api("providers/cloudflare/" + node.id, { method: "POST", status: 503 });
  const speedtest = { mode: "internet", sourceServerId: server.id, protocol: "udp", direction: "upload", reverse: true, durationSec: 4, streams: 2, bandwidthLimitMbps: 4 };
  const running = await action("startSpeedtest", [speedtest]);
  assert.equal(running.data.speedtestRun.running, true);
  assert.equal("pendingSpeedtest" in running.data, false);
  await action("startSpeedtest", [speedtest], { status: 409 });
  const stopped = await action("stopSpeedtest", []);
  assert.equal(stopped.data.speedtests[0].status, "stopped");
  await action("startSpeedtest", [{ ...speedtest, durationSec: 1 }]);
  await delay(1200);
  const completed = await api("workspace");
  assert.equal(completed.data.speedtestRun.running, false);
  assert.equal(completed.data.speedtests[0].status, "completed");
  assert.ok(completed.data.speedtests[0].maxMbps <= speedtest.bandwidthLimitMbps);

  const target = after.data.nodes.find((n) => n.activeSide === "primary" && !n.lastFailoverAt &&
    after.data.servers.some((s) => s.id === n.backupServerId && s.status !== "offline" && s.agent.status !== "offline") &&
    after.data.tunnels.some((t) => t.id === n.backupTunnelId && t.status !== "offline"));
  assert.ok(target);
  const switched = await action("simulateFailover", [target.id, "manual"]);
  assert.equal(switched.data.nodes.find((n) => n.id === target.id).activeSide, "backup");
  assert.equal(switched.data.failoverRun.state, "RECOVERED");
  assert.ok(switched.data.failoverRun.log.length > 3);
  assert.equal(switched.data.dns.find((d) => d.nodeId === target.id).aRecords[0],
    switched.data.servers.find((s) => s.id === target.backupServerId).publicIpv4);
  const rollout = await action("createDeployment", [{ serverId: server.id, component: "NodeGuard Agent", options: {}, outcome: "success" }]);
  assert.equal(rollout.data.deployments[0].status, "completed");
  await action("rollbackDeployment", [rollout.data.deployments[0].id]);

  await stop();
  await start(server.id);
  assert.equal((await api("servers/" + server.id)).data.notes, note);
  const observedAt = new Date().toISOString();
  const report = {
    serverId: server.id, reportId: randomUUID(), observedAt, version: "test",
    cpu: 31, ram: 22, disk: 15, rxMbps: 1, txMbps: 2, uptimeSec: 60,
    logs: [{ ts: observedAt, severity: "INFO", source: "v2bx-shared", message: "agent integration log" }],
  };
  await api("agent/telemetry", { body: report, status: 401 });
  await api("agent/telemetry", { body: report, token: agent });
  assert.equal((await api("agent/telemetry", { body: report, token: agent })).data.replay, true);
  assert.equal((await api("servers/" + server.id + "/telemetry")).data[0].cpu, 31);
  assert.equal((await api("logs?q=agent+integration+log&source=v2bx-shared")).total, 1);
  assert.equal((await api("logs?q=agent+integration+log&nodeId=" + node.id)).total, 0);
  await stop();
  await start("ir-main", "monitor");
  const monitor = await api("workspace");
  assert.equal(monitor.mode, "monitor");
  assert.equal(monitor.data.nodes.length, 1);
  assert.equal(monitor.data.nodes[0].id, "node-1");
  assert.deepEqual(monitor.data.logs, []);
  await action("simulateFailover", ["node-1", "manual"], { status: 409 });
  assert.equal((await api("metrics?range=15m")).simulated, false);
  const probeHistory = (range = "15m") => api("availability?range=" + range).then((result) => result.data);
  const noProbes = await probeHistory();
  assert.deepEqual(noProbes.proxy, { samples: 0, successful: 0 });
  assert.ok(noProbes.series.every((point) => point.availability === null));
  assert.ok(noProbes.series.length > 1);
  assert.equal(noProbes.series.at(-1).ts % 60000, 0);
  await api("availability?range=invalid", { status: 422 });
  const fresh = { ...report, serverId: "ir-main", reportId: randomUUID(), observedAt: new Date().toISOString(),
    logs: [], tunnels: [{ tunnelId: "tun-main", status: "healthy", rttMs: 42, jitterMs: 2, packetLoss: 0, rxMbps: 11, txMbps: 8, mtu: 1400 }],
  };
  await api("agent/telemetry", { body: fresh, token: agent });
  const measurements = await api("metrics?range=15m&tunnelId=tun-main");
  assert.ok(measurements.data.length > 1);
  assert.equal(measurements.data.at(-1).ts % 60000, 0);
  assert.equal(measurements.data[1].ts - measurements.data[0].ts, 60000);
  assert.equal(measurements.data.find((point) => point.rtt === 42)?.rtt, 42);
  assert.ok(measurements.data.some((point) => point.rtt === null));
  assert.equal(measurements.data.find((point) => point.rtt === 42)?.loss, 0);
  assert.equal((await api("metrics?range=15m&serverId=ir-main")).data.find((point) => point.cpu === 31)?.cpu, 31);
  await api("agent/telemetry", { body: { ...fresh, reportId: randomUUID() }, token: agent, status: 409 });
  await api("agent/telemetry", { body: { ...fresh, reportId: randomUUID(), observedAt: new Date(Date.now() + 1000).toISOString(), tunnels: [{ ...fresh.tunnels[0], tunnelId: "tun-backup" }] }, token: agent, status: 422 });
  const probe = { nodeId: "node-1", ok: true, elapsedMs: 72, httpStatus: 204 };
  await api("agent/telemetry", { body: { ...fresh, reportId: randomUUID(), observedAt: new Date(Date.now() + 1500).toISOString(), proxyProbes: [probe] }, token: agent, status: 422 });
  const latestProbe = { ...fresh, serverId: "observer-1", reportId: randomUUID(), observedAt: new Date().toISOString(), tunnels: [], proxyProbes: [probe] };
  await api("agent/telemetry", { body: latestProbe, token: observer });
  const probeHealth = () => api("nodes/node-1/health").then((result) => result.data.dimensions.find((d) => d.key === "e2e"));
  const proxyIncidents = () => api("incidents").then((result) => result.data.filter((item) => item.category === "proxy-unreachable"));
  assert.equal((await probeHealth()).status, "degraded");
  assert.match((await probeHealth()).summary, /کافی نیست/);
  assert.equal((await proxyIncidents()).length, 0);
  const legacyProbe = { ...latestProbe, serverId: "observer-2", reportId: randomUUID(),
    observedAt: new Date(Date.parse(latestProbe.observedAt) - 1500).toISOString(),
    proxyProbes: [
      { nodeId: "node-1", side: "active", ok: false, elapsedMs: 900 },
      { nodeId: "node-1", side: "backup", ok: false, elapsedMs: 900 },
    ],
  };
  await api("agent/telemetry", { body: legacyProbe, token: observerTwo });
  await api("agent/telemetry", { body: legacyProbe, token: observerTwo });
  assert.equal((await probeHealth()).status, "degraded");
  assert.match((await probeHealth()).summary, /متفاوتی/);
  assert.equal((await proxyIncidents()).length, 0);
  assert.equal((await api("nodes/node-1")).data.proxyProbe.serverId, "observer-1");
  const observed = await probeHistory();
  assert.deepEqual(observed.proxy, { samples: 2, successful: 1 });
  assert.deepEqual(observed.nodes["node-1"], observed.proxy);
  assert.deepEqual(observed.tunnels["tun-main"], { samples: 1, successful: 1 });
  assert.equal(observed.series.reduce((sum, point) => sum + point.samples, 0), 2);
  assert.ok(observed.series.some((point) => point.samples === 0));
  const monitoredOverview = (await api("overview")).data;
  assert.equal(monitoredOverview.uptimePct, null);
  assert.deepEqual(monitoredOverview.availability, { samples: 2, successful: 1, pct: 50, range: "24h" });
  const reportProbe = (base, token, side, ok, offset) => api("agent/telemetry", { token, body: {
    ...base, reportId: randomUUID(),
    observedAt: new Date(Date.parse(latestProbe.observedAt) + offset).toISOString(),
    proxyProbes: [{ nodeId: "node-1", side, ok }],
  } });
  await reportProbe(latestProbe, observer, "backup", false, 100);
  assert.equal((await proxyIncidents()).length, 0);
  assert.match((await probeHealth()).summary, /متفاوتی/);
  await reportProbe(latestProbe, observer, "active", false, 200);
  assert.equal((await probeHealth()).status, "offline");
  const [proxyOutage] = await proxyIncidents();
  assert.equal(proxyOutage.status, "open");
  assert.equal(proxyOutage.severity, "critical");
  assert.equal(proxyOutage.serverId, "ir-main");
  await reportProbe(legacyProbe, observerTwo, "active", false, 300);
  assert.equal((await proxyIncidents()).length, 1);
  await reportProbe(latestProbe, observer, "active", true, 400);
  assert.equal((await probeHealth()).status, "degraded");
  assert.equal((await proxyIncidents())[0].status, "open");
  await reportProbe(legacyProbe, observerTwo, "active", true, 500);
  assert.equal((await probeHealth()).status, "healthy");
  assert.equal((await proxyIncidents())[0].status, "resolved");
  const proxyAlerts = (await api("alerts")).data.filter((item) => item.incidentId === proxyOutage.id);
  assert.equal(proxyAlerts.length, 0, "Only configured metric rules are displayed as alerts");
  console.log("PASS: independent proxy consensus, pinned isolation, incident deduplication, and recovery.");
  const pressure = { ...fresh, cpu: 99, reportId: randomUUID(), observedAt: new Date(Date.now() + 2000).toISOString() };
  await api("agent/telemetry", { body: pressure, token: agent });
  const incident = (await api("incidents")).data.find((item) => item.category === "high-resource");
  assert.equal(incident.status, "open");
  await api("agent/telemetry", { body: { ...pressure, reportId: randomUUID(), observedAt: new Date(Date.now() + 3000).toISOString() }, token: agent });
  assert.equal((await api("incidents")).data.filter((item) => item.category === "high-resource").length, 1);
  await action("acknowledgeIncident", [incident.id]);
  await api("agent/telemetry", { body: { ...pressure, cpu: 15, reportId: randomUUID(), observedAt: new Date(Date.now() + 4000).toISOString() }, token: agent });
  assert.equal((await api("incidents/" + incident.id)).data.status, "resolved");
  await api("iperf/jobs", { body: {}, status: 503 });
  await stop();
  await start("ir-main", "monitor", true);
  const foreignReport = { ...fresh, serverId: "exit-1", reportId: randomUUID(),
    observedAt: new Date().toISOString(), tunnels: [], logs: [] };
  await api("agent/telemetry", { body: foreignReport, token: receiver });
  const spec = { tunnelId: "tun-main", sourceServerId: "ir-main", destServerId: "exit-1",
    protocol: "udp", direction: "bidirectional", durationSec: 4, streams: 2, bandwidthLimitMbps: 20 };
  const jobKey = { "Idempotency-Key": randomUUID() };
  await api("iperf/jobs", { body: spec, token: readonly, headers: jobKey, status: 403 });
  await api("iperf/jobs", { body: { ...spec, bandwidthLimitMbps: 0 }, headers: jobKey, status: 422 });
  await api("iperf/jobs", { body: { ...spec, destServerId: "ir-backup" }, headers: jobKey, status: 422 });
  const [queued, duplicate] = await Promise.all([
    api("iperf/jobs", { body: spec, headers: jobKey }),
    api("iperf/jobs", { body: spec, headers: jobKey }),
  ]);
  assert.equal(queued.data.job.id, duplicate.data.job.id);
  assert.notEqual(queued.data.replay, duplicate.data.replay);
  await api("iperf/jobs", { body: { ...spec, streams: 3 }, headers: jobKey, status: 409 });
  await api("iperf/jobs", { body: spec, headers: { "Idempotency-Key": randomUUID() }, status: 409 });
  const jobId = queued.data.job.id;
  await stop();
  await start("ir-main", "monitor", true);
  assert.equal((await api("iperf/jobs")).data.jobs.find((j) => j.id === jobId).status, "queued");

  const claim = (serverId, token, status = 200) => api("agent/jobs/claim", { body: { serverId }, token, status });
  const agentWorker = (kind) => api("servers/ir-main").then((result) => result.data.agent.workers.find((item) => item.kind === kind));
  assert.equal((await agentWorker("provision")).status, "disabled");
  assert.equal((await claim("exit-1", receiver)).data, null);
  await claim("ir-main", receiver, 401);
  assert.equal((await agentWorker("iperf")).status, "unseen");
  const claims = await Promise.all([claim("ir-main", agent), claim("ir-main", agent)]);
  const [leased] = claims.flatMap((r) => r.data ? [r.data] : []);
  assert.equal(claims.filter((r) => r.data).length, 1);
  assert.equal(leased.id, jobId);
  assert.equal(leased.endpoint.peerIp, "10.20.0.2");
  assert.equal((await agentWorker("iperf")).status, "busy");
  assert.ok(!JSON.stringify((await api("iperf/jobs")).data).includes(leased.lease));
  await api("agent/jobs/" + jobId + "/control", { body: { serverId: "exit-1", lease: leased.lease }, token: receiver, status: 403 });
  const agentBody = { serverId: "ir-main", lease: leased.lease };
  assert.equal((await api("agent/jobs/" + jobId + "/control", { body: agentBody, token: agent })).data.stop, false);
  const finish = (body, status = 200) => api("agent/jobs/" + jobId + "/finish", { body: { ...agentBody, ...body }, token: agent, status });
  await finish({ outcome: "completed", result: { downloadMbps: 8, samples: [] } }, 422);
  const reportResult = { outcome: "completed", result: { uploadMbps: 8, downloadMbps: 9, lossPct: 0, jitterMs: 2, samples: [{ t: 1, uploadMbps: 8, downloadMbps: 9 }] } };
  assert.equal((await finish(reportResult)).data.job.result.downloadMbps, 9);
  assert.equal((await finish(reportResult)).data.replay, true);
  const evidenceSince = new Date(Date.now() - 60000).toISOString();
  const firstEvidence = (await api("staging/readiness?nodeId=node-1&since=" + encodeURIComponent(evidenceSince), { token: readonly })).data.evidence;
  assert.equal(firstEvidence.checks.find(({ key }) => key === "iperf-udp").ok, true);
  assert.equal(firstEvidence.checks.find(({ key }) => key === "iperf-tcp").ok, false);
  assert.equal(firstEvidence.complete, false);
  assert.equal((await agentWorker("iperf")).status, "recent");
  await finish({ outcome: "failed", error: "exit" }, 409);

  const next = (await api("iperf/jobs", { body: spec, headers: { "Idempotency-Key": randomUUID() } })).data.job;
  const nextLease = (await claim("ir-main", agent)).data;
  assert.equal(nextLease.id, next.id);
  const cancelled = await api("iperf/jobs/" + next.id + "/cancel", { method: "POST" });
  assert.equal(cancelled.data.status, "cancel_requested");
  const cancellingAgent = { serverId: "ir-main", lease: nextLease.lease };
  assert.equal((await api("agent/jobs/" + next.id + "/control", { body: cancellingAgent, token: agent })).data.stop, true);
  await api("iperf/jobs", { body: spec, headers: { "Idempotency-Key": randomUUID() }, status: 409 });
  assert.equal((await api("agent/jobs/" + next.id + "/finish", { body: { ...cancellingAgent, outcome: "cancelled" }, token: agent })).data.job.status, "cancelled");
  const cancelledBeforeClaim = (await api("iperf/jobs", { body: spec, headers: { "Idempotency-Key": randomUUID() } })).data.job;
  assert.equal((await api("iperf/jobs/" + cancelledBeforeClaim.id + "/cancel", { method: "POST" })).data.status, "cancelled");
  assert.equal((await claim("ir-main", agent)).data, null);
  console.log("PASS: durable iperf queue, authorization, preflight, one lease, completion, and cancellation.");
  await stop();
  await start("ir-main", "monitor", true, true, false, true);
  const tickDns = (options = {}) => api("dns/monitor/tick", { method: "POST", token: dnsWorker, ...options }).then((result) => result.data);
  await tickDns({ token: admin, status: 401 });
  await tickDns({ headers: { Origin: "https://untrusted.invalid" }, status: 403 });
  await api("workspace", { token: dnsWorker, status: 401 });
  assert.equal((await api("failover/plans")).executionEnabled, false);

  const cfForDnsMonitor = {
    record: { id: "b".repeat(32), name: "de.nodeguard.example", type: "A", content: "192.0.2.10", proxied: false, ttl: 60 },
    writes: 0, readDelayMs: 200,
  };
  const dnsDatabase = new DatabaseSync(join(temp, "monitor.sqlite"));
  try {
    const ageObservation = () => {
      const stored = JSON.parse(dnsDatabase.prepare("SELECT snapshot FROM workspace").get().snapshot);
      const observation = stored.dns.find((row) => row.nodeId === "node-1");
      observation.lastCheck = new Date(Date.now() - 600000).toISOString();
      dnsDatabase.prepare("UPDATE workspace SET snapshot = ?").run(JSON.stringify(stored));
    };
    const saveProvider = (overrides = {}) => writeFile(providerStatePath, JSON.stringify({ ...cfForDnsMonitor, ...overrides }));
    await saveProvider();
    const ticks = await Promise.all([tickDns(), tickDns()]);
    assert.equal(ticks.reduce((n, value) => n + value.checked, 0), 1);
    assert.equal(ticks.reduce((n, value) => n + value.errors + value.skipped, 0), 0);
    assert.equal((await api("dns/dns-node-1")).data.resolverStatus, "matched");
    const scheduleAudit = () => api("audit").then((result) => result.data.filter((entry) => entry.action === "dns.observe.scheduled"));
    assert.equal((await scheduleAudit())[0].role, "system");
    assert.equal((await tickDns()).checked, 0);

    ageObservation();
    assert.equal((await api("dns/dns-node-1")).data.stale, true);
    assert.equal((await api("nodes/node-1")).data.dnsStatus, "stale");
    const observedHealth = (await api("nodes/node-1/health")).data;
    assert.equal(observedHealth.dimensions.find((dimension) => dimension.key === "dns").status, "degraded");

    await saveProvider({ readError: true });
    assert.deepEqual(await tickDns(), { checked: 0, skipped: 0, errors: 1 });
    await stop();
    await start("ir-main", "monitor", true, true, false, true);
    assert.deepEqual(await tickDns(), { checked: 0, skipped: 0, errors: 0 });
    assert.equal((await api("dns/dns-node-1")).data.stale, true);

    dnsDatabase.prepare("UPDATE dns_monitor_schedule SET retry_at = 0, lease = 'abandoned', lease_until = ? WHERE node_id = 'node-1'").run(Date.now() + 25000);
    assert.equal((await tickDns()).checked, 0);
    dnsDatabase.prepare("UPDATE dns_monitor_schedule SET lease_until = ? WHERE node_id = 'node-1'").run(Date.now() - 1);
    await saveProvider({ record: { ...cfForDnsMonitor.record, content: "192.0.2.99" } });
    assert.equal((await tickDns()).checked, 1);
    assert.equal((await api("nodes/node-1")).data.dnsStatus, "mismatched");
    const dnsIncidents = () => api("incidents").then((result) => result.data.filter((item) => item.category === "dns-mismatch"));
    const [incident] = await dnsIncidents();
    assert.equal(incident.nodeId, "node-1");
    assert.equal(incident.status, "open");
    ageObservation();
    assert.equal((await tickDns()).checked, 1);
    assert.equal((await dnsIncidents()).length, 1);
    assert.equal((await scheduleAudit()).length, 2);

    await saveProvider();
    ageObservation();
    const runner = spawn(process.execPath, ["agent/failover_worker.mjs", "--dns", "--once"], {
      env: { ...process.env, NODEGUARD_CONTROL_URL: base, NODEGUARD_DNS_WORKER_TOKEN: dnsWorker },
      windowsHide: true, stdio: "pipe",
    });
    const exit = await new Promise((resolve, reject) => runner.once("error", reject).once("close", resolve));
    assert.equal(exit, 0);
    assert.equal((await api("dns/dns-node-1")).data.stale, undefined);
    assert.equal((await dnsIncidents())[0].status, "resolved");
    const alertsAfterRecovery = (await api("alerts")).data.filter((item) => item.incidentId === incident.id);
    assert.equal(alertsAfterRecovery.length, 0, "DNS incidents do not bypass configured alert rules");
    assert.equal(JSON.parse(await readFile(providerStatePath, "utf8")).writes, 0);
  } finally {
    dnsDatabase.close();
  }
  await rm(providerStatePath);
  console.log("PASS: independent scheduled DNS, scoped authentication, concurrent lease, restart/backoff, stale health, and incident recovery.");
  await stop();
  await start("ir-main", "monitor", true, true);
  const getPreflight = () => api("failover/preflight/node-1?target=backup");
  const initialChecks = (await getPreflight()).data;
  assert.equal(initialChecks.ready, false);
  assert.equal(initialChecks.targetConfirmations, 0); // A live-domain probe is not evidence for standby.
  const future = (offset) => new Date(Date.now() + offset).toISOString();
  const backupReport = {
    ...fresh, serverId: "ir-backup", reportId: randomUUID(), observedAt: future(0),
    tunnels: [{ ...fresh.tunnels[0], tunnelId: "tun-backup", rttMs: 48 }], logs: [],
  };
  await api("agent/telemetry", { body: backupReport, token: backupAgent });
  await api("agent/telemetry", { body: { ...foreignReport, reportId: randomUUID(), observedAt: future(1000), v2bx: "running" }, token: receiver });
  const observeDns = () => api("providers/cloudflare/node-1", { method: "POST" }).then((result) => result.data);
  await api("providers/cloudflare/node-1", { method: "POST", token: readonly, status: 403 });
  const matching = await observeDns();
  assert.equal(matching.authoritativeStatus, "matched");
  assert.equal(matching.resolverStatus, "matched");
  assert.deepEqual(matching.resolverObservation.aRecords, ["192.0.2.10"]);
  assert.equal(matching.resolverObservation.ttl, 37);
  await action("updatePolicy", ["node-1", { intervalSec: 5, failureThreshold: 2, autoEnabled: true }]);
  const pinned = (token, serverId, at, backupOk = true) => api("agent/telemetry", {
    token, body: {
      ...fresh, serverId, reportId: randomUUID(), observedAt: at, tunnels: [],
      proxyProbes: [
        { nodeId: "node-1", side: "primary", ok: false, elapsedMs: 2000 },
        { nodeId: "node-1", side: "backup", ok: backupOk, elapsedMs: 72, httpStatus: backupOk ? 204 : 500 },
      ],
    },
  });
  await pinned(observer, "observer-1", future(3000));
  const single = (await getPreflight()).data;
  assert.equal(single.targetConfirmations, 1);
  assert.equal(single.ready, false);
  await pinned(observerTwo, "observer-2", future(3000));
  const qualified = (await getPreflight()).data;
  assert.equal(qualified.ready, true);
  assert.equal(qualified.automaticEligible, false);
  assert.equal(qualified.failureConfirmations, 0);
  await pinned(observer, "observer-1", future(9000));
  await pinned(observerTwo, "observer-2", future(9000));
  assert.equal((await getPreflight()).data.automaticEligible, true);
  const body = { nodeId: "node-1", target: "backup" };
  const planHeaders = { "Idempotency-Key": randomUUID() };
  await api("failover/plans", { body, headers: planHeaders, token: readonly, status: 403 });
  const firstPlan = (await api("failover/plans", { body, headers: planHeaders })).data.plan;
  assert.equal((await api("failover/plans", { body, headers: planHeaders })).data.replay, true);
  await api("failover/plans", { body, headers: { "Idempotency-Key": randomUUID() }, status: 409 });
  assert.equal(firstPlan.status, "awaiting_approval");
  const decide = (plan, decision, token = infra, status = 200) => api("failover/plans/" + plan.id + "/decision", { body: { decision }, token, status });
  await decide(firstPlan, "approve", admin, 403);
  assert.equal((await decide(firstPlan, "approve")).data.status, "approved");
  assert.equal((await decide(firstPlan, "approve")).data.status, "approved");
  assert.equal((await api("nodes/node-1")).data.activeSide, "primary");
  assert.equal((await decide(firstPlan, "reject")).data.status, "rejected");

  const stalePlan = (await api("failover/plans", { body, headers: { "Idempotency-Key": randomUUID() } })).data.plan;
  await pinned(observerTwo, "observer-2", future(14000), false);
  assert.equal((await decide(stalePlan, "approve")).data.status, "stale");
  assert.equal((await api("failover/plans")).data.find((item) => item.id === stalePlan.id).status, "stale");
  console.log("PASS: read-only DNS fixture, independent pinned evidence, approval, and invalidation on new failure.");
  const failoverCall = (plan, route, token = infra, status = 200) => api("failover/plans/" + plan.id + "/" + route, { method: "POST", token, status });
  const prepare = async (target = "backup") => {
    const result = await api("failover/plans", {
      body: { nodeId: "node-1", target }, headers: { "Idempotency-Key": randomUUID() },
    });
    const plan = result.data.plan;
    const approved = await decide(plan, "approve");
    assert.equal(approved.data.status, "approved");
    return plan;
  };
  const workerTick = () => api("failover/worker/tick", { method: "POST", token: infra });
  const providerState = () => readFile(providerStatePath, "utf8").then(JSON.parse);
  const settleSoon = (plan, overdue = false) => {
    const liveDb = new DatabaseSync(join(temp, "monitor.sqlite"));
    liveDb.prepare("UPDATE failover_executions SET verify_after = ?, verify_until = ? WHERE plan_id = ?")
      .run(Date.now() - 1, Date.now() + (overdue ? -1 : 60000), plan.id);
    liveDb.close();
  };

  await action("updatePolicy", ["node-1", { cooldownSec: 0 }]);
  await pinned(observerTwo, "observer-2", future(20000));
  const rollbackPlan = await prepare();
  await failoverCall(rollbackPlan, "execute", readonly, 403);
  assert.equal((await failoverCall(rollbackPlan, "execute")).data.status, "applying");
  assert.equal((await failoverCall(rollbackPlan, "execute")).data.status, "applying");
  const pathOfState = providerStatePath;
  const initialProviderState = {
    record: { id: "b".repeat(32), type: "A", name: "de.nodeguard.example", content: "192.0.2.10",
      ttl: 60, proxied: false, tags: ["nodeguard:managed"], comment: "fixture original", modified_on: "2020-01-01T00:00:00.000Z" },
    writes: 0, dropNext: true,
  };
  await writeFile(pathOfState, JSON.stringify(initialProviderState));
  await Promise.all([failoverCall(rollbackPlan, "advance"), failoverCall(rollbackPlan, "advance")]);
  assert.equal((await providerState()).writes, 1);
  assert.equal((await providerState()).record.content, "192.0.2.11");
  const findPlan = async (plan) => (await api("failover/plans")).data.find((item) => item.id === plan.id);
  assert.equal((await findPlan(rollbackPlan)).execution.status, "verifying");
  assert.equal((await api("nodes/node-1")).data.activeSide, "primary");
  settleSoon(rollbackPlan, true);
  await workerTick();
  assert.equal((await findPlan(rollbackPlan)).execution.status, "rolling_back");
  await workerTick();
  assert.equal((await findPlan(rollbackPlan)).execution.status, "rolled_back");
  const restoredEvent = (await api("failovers/" + rollbackPlan.id)).data;
  assert.equal(restoredEvent.result, "rolled-back");
  assert.equal(restoredEvent.toServerId, "ir-main");
  assert.equal((await providerState()).record.content, "192.0.2.10");
  assert.equal((await providerState()).record.comment, "fixture original");
  assert.equal((await providerState()).writes, 2);

  const successfulPlan = await prepare();
  await failoverCall(successfulPlan, "execute");
  await workerTick();
  assert.equal((await findPlan(successfulPlan)).execution.status, "verifying");
  // Let the test observer clocks catch up, then deliver fresh active-domain evidence.
  await delay(20500);
  settleSoon(successfulPlan);
  const activeProbe = (serverId, token) => api("agent/telemetry", { token, body: {
    ...fresh, reportId: randomUUID(), serverId, observedAt: new Date().toISOString(), tunnels: [],
    proxyProbes: [{ nodeId: "node-1", side: "active", ok: true, elapsedMs: 80, httpStatus: 204 }],
  } });
  await activeProbe("observer-1", observer);
  await activeProbe("observer-2", observerTwo);
  await workerTick();
  assert.equal((await findPlan(successfulPlan)).execution.status, "succeeded");
  const switchedEvent = (await api("failovers/" + successfulPlan.id)).data;
  assert.equal(switchedEvent.result, "success");
  assert.equal(switchedEvent.fromServerId, "ir-main");
  assert.equal(switchedEvent.toServerId, "ir-backup");
  assert.ok((await api("workspace")).data.failoverEvents.some((event) => event.id === successfulPlan.id));
  const switchedNode = (await api("nodes/node-1")).data;
  assert.equal(switchedNode.activeSide, "backup");
  assert.deepEqual(switchedNode.proxyObservationSet.samples, []);
  assert.equal((await api("dns/dns-node-1")).data.resolverObservation, undefined);
  assert.match((await probeHealth()).summary, /در دسترس نیست/);
  await activeProbe("observer-1", observer);
  assert.match((await probeHealth()).summary, /کافی نیست/);
  await activeProbe("observer-2", observerTwo);
  assert.equal((await probeHealth()).status, "healthy");

  const reverseEvidence = (serverId, token) => api("agent/telemetry", { token, body: {
    ...fresh, reportId: randomUUID(), serverId, observedAt: future(2000), tunnels: [],
    proxyProbes: [{ nodeId: "node-1", side: "primary", ok: true, elapsedMs: 60, httpStatus: 204 }],
  } });
  await api("agent/telemetry", { token: agent, body: { ...fresh, reportId: randomUUID(), observedAt: new Date().toISOString() } });
  await reverseEvidence("observer-1", observer);
  await reverseEvidence("observer-2", observerTwo);
  const conflictPlan = await prepare("primary");
  await failoverCall(conflictPlan, "execute");
  await workerTick();
  assert.equal((await findPlan(conflictPlan)).execution.status, "verifying");
  const external = await providerState();
  external.record.content = "192.0.2.99";
  external.record.modified_on = new Date().toISOString();
  await writeFile(pathOfState, JSON.stringify(external));
  await failoverCall(conflictPlan, "rollback");
  await workerTick();
  assert.equal((await findPlan(conflictPlan)).execution.status, "review");
  assert.equal((await providerState()).record.content, "192.0.2.99");
  assert.equal((await providerState()).writes, 4);
  assert.equal((await api("nodes/node-1")).data.activeSide, "backup");
  assert.equal((await failoverCall(conflictPlan, "reconcile")).data.status, "review");
  const repaired = await providerState();
  repaired.record.content = "192.0.2.11";
  repaired.record.comment = "NodeGuard failover " + successfulPlan.id;
  repaired.record.modified_on = new Date().toISOString();
  await writeFile(pathOfState, JSON.stringify(repaired));
  assert.equal((await failoverCall(conflictPlan, "reconcile")).data.status, "rolled_back");
  assert.equal((await providerState()).writes, 4);
  console.log("PASS: Cloudflare write with lost response, durable rollback, resolver and probe verification, and external-write conflict.");
  const dnsFixture = async (record, resolver, additionalRecords = []) => {
    await writeFile(pathOfState, JSON.stringify({ ...repaired, record: { ...repaired.record, ...record }, resolver, additionalRecords }));
    return observeDns();
  };
  const stale = await dnsFixture({}, { a: ["192.0.2.10"] });
  assert.equal(stale.authoritativeStatus, "matched");
  assert.equal(stale.resolverStatus, "propagation");
  assert.equal(stale.resolverObservation.complete, true);
  const partial = await dnsFixture({}, { v6Timeout: true });
  assert.equal(partial.resolverStatus, "error");
  assert.equal(partial.resolverObservation.complete, false);
  assert.deepEqual(partial.resolverObservation.aRecords, ["192.0.2.11"]);
  const proxy = await dnsFixture({ proxied: true, ttl: 1 }, { a: ["203.0.113.45"], aaaa: ["2001:db8::9"] });
  assert.equal(proxy.authoritativeStatus, "proxied");
  assert.equal(proxy.resolverStatus, "proxied");
  assert.equal(proxy.resolverObservation.ttl, 19);
  assert.deepEqual(proxy.resolverObservation.aaaaRecords, ["2001:db8::9"]);
  const alias = await dnsFixture({ type: "CNAME", content: "alias.nodeguard.example." }, { cname: ["Alias.NodeGuard.Example"], a: ["192.0.2.11"] });
  assert.equal(alias.resolverStatus, "cname");
  const wrongAlias = await dnsFixture({ type: "CNAME", content: "alias.nodeguard.example." }, { cname: ["other.nodeguard.example"] });
  assert.equal(wrongAlias.authoritativeStatus, "cname");
  assert.equal(wrongAlias.resolverStatus, "mismatched");
  assert.equal((await api("nodes/node-1")).data.dnsStatus, "mismatched");
  const wrongIpv6 = await dnsFixture({}, { a: ["192.0.2.11"] }, [
    { ...repaired.record, type: "AAAA", content: "2001:db8::10" },
  ]);
  assert.equal(wrongIpv6.authoritativeStatus, "mismatched");
  assert.equal(wrongIpv6.resolverStatus, "matched");
  await writeFile(pathOfState, JSON.stringify(repaired));
  assert.equal((await observeDns()).resolverStatus, "matched");
  assert.equal((await providerState()).writes, 4);
  console.log("PASS: independent resolver A/AAAA/CNAME observations, TTL, propagation, timeout, proxy, and drift without DNS writes.");
  await stop();
  await start("ir-main", "monitor", true, true, true);
  const profile = { operation: "apply", serverId: "exit-1", profileId: "bbr-lab", sha256: "c".repeat(64) };
  const provision = (body, options = {}) => api("provision/jobs", { body, headers: { "Idempotency-Key": randomUUID() }, ...options });
  assert.equal((await api("provision/jobs")).data.profiles[0].id, "bbr-lab");
  await provision(profile, { token: readonly, status: 403 });
  await provision({ ...profile, sha256: "b".repeat(64) }, { status: 409 });
  const requestKey = { "Idempotency-Key": randomUUID() };
  const install = (await provision(profile, { headers: requestKey })).data.job;
  const exercise = async (key, since) => {
    // Earlier DNS exercises can outlast the catalog freshness window. Readiness
    // requires a current catalog independently of the provision evidence under test.
    await api("providers/v2board/sync", { method: "POST" });
    const { data } = await api("staging/readiness?nodeId=node-1&since=" + encodeURIComponent(since), { token: readonly });
    return data.evidence.checks.find((check) => check.key === key).ok;
  };
  assert.equal(install.status, "queued");
  assert.equal((await provision(profile, { headers: requestKey })).data.replay, true);
  await provision(profile, { status: 409 });
  const claimProvision = (serverId, token, status = 200, remove = false) => api("agent/provision/claim", {
    body: { serverId }, token, status, headers: remove ? { "X-NodeGuard-Provision-Remove": "1" } : undefined,
  });
  await claimProvision("exit-1", agent, 401);
  assert.equal((await claimProvision("ir-main", agent)).data, null);
  await stop();
  await start("ir-main", "monitor", true, true, true);
  const claimsProvision = await Promise.all([claimProvision("exit-1", receiver), claimProvision("exit-1", receiver)]);
  const held = claimsProvision.map((item) => item.data).filter(Boolean);
  assert.equal(held.length, 1);
  assert.equal(held[0].id, install.id);
  const finishProvision = (job, status, detail, token = receiver, httpStatus = 200) => api("agent/provision/" + job.id + "/finish", {
    body: { serverId: "exit-1", lease: job.lease, status, detail }, token, status: httpStatus,
  });
  await finishProvision(held[0], "succeeded", "applied", agent, 401);
  assert.equal((await finishProvision(held[0], "succeeded", "applied")).data.job.status, "succeeded");
  assert.equal((await finishProvision(held[0], "succeeded", "applied")).data.replay, true);
  const rollbackJob = (await provision({ operation: "rollback", jobId: install.id })).data.job;
  assert.equal(rollbackJob.rollbackOf, install.id);
  const rollbackLease = (await claimProvision("exit-1", receiver)).data;
  assert.equal((await finishProvision(rollbackLease, "review", "external_change")).data.job.status, "review");
  await provision(profile, { status: 409 });
  const review = await api("provision/jobs/" + rollbackJob.id + "/review", { method: "POST" });
  assert.equal(review.data.status, "failed");
  assert.equal(await exercise("bbr-rollback", install.createdAt), false);
  const retryRollback = (await provision({ operation: "rollback", jobId: install.id })).data.job;
  assert.equal(retryRollback.rollbackOf, install.id);
  const retryLease = (await claimProvision("exit-1", receiver)).data;
  await finishProvision(retryLease, "succeeded", "restored");
  assert.equal(await exercise("bbr-rollback", install.createdAt), true);
  console.log("PASS: Provision profile pinning, durable exclusive lease, replay, rollback and review.");

  const restartPath = "servers/exit-1/v2bx-restart";
  const restartKey = { "Idempotency-Key": randomUUID() };
  const restart = (path = restartPath, options = {}) => api(path, { method: "POST", headers: restartKey, status: 202, ...options });
  const capable = () => api("agent/provision/claim", {
    body: { serverId: "exit-1" }, token: receiver, headers: { "X-NodeGuard-V2bX-Restart": "1" },
  });
  await restart("servers/ir-main/v2bx-restart", { status: 403 });
  await restart(restartPath, { token: readonly, status: 403 });
  await restart(restartPath, { status: 409 });
  assert.equal((await capable()).data, null);
  assert.equal((await api(restartPath)).data.ready, true);
  const restartJob = (await restart()).data;
  assert.equal((await restart()).data.id, restartJob.id);
  assert.equal((await claimProvision("exit-1", receiver)).data, null);
  const restartLease = (await capable()).data;
  assert.equal(restartLease.operation, "restart-v2bx");
  await finishProvision(restartLease, "succeeded", "applied", receiver, 422);
  assert.equal((await finishProvision(restartLease, "succeeded", "restarted")).data.job.status, "succeeded");
  assert.ok((await api("audit")).data.some((item) => item.target === "exit-1" && item.detail === "راه‌اندازی مجدد V2bX تأیید شد."));
  assert.equal((await api(restartPath)).data.job.id, restartJob.id);
  const bbrPath = "servers/exit-1/bbr";
  const downloadHeaders = { "X-NodeGuard-Provision-Download": "1" };
  const claimDownload = () => api("agent/provision/claim", { body: { serverId: "exit-1" }, token: receiver, headers: downloadHeaders });
  assert.equal((await claimDownload()).data, null);
  assert.equal((await api(bbrPath)).data.ready, true);
  const bbr = (await api(bbrPath, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, status: 202 })).data;
  const bbrLease = (await claimDownload()).data;
  assert.equal(bbrLease.id, bbr.id);
  const manifest = await fetch(`${base}/api/v1/agent/provision/${bbr.id}/artifact`, {
    method: "POST", headers: { Authorization: `Bearer ${receiver}`, "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: "exit-1", lease: bbrLease.lease, name: "manifest.json", offset: 0 }),
  });
  assert.equal(manifest.status, 200);
  assert.equal(createHash("sha256").update(await manifest.text()).digest("hex"), bbr.profile.sha256);
  await finishProvision(bbrLease, "succeeded", "applied");
  const rebootHeaders = { "X-NodeGuard-Host-Reboot": "1" };
  assert.equal((await api("agent/provision/claim", { body: { serverId: "exit-1" }, token: receiver, headers: rebootHeaders })).data, null);
  const rebootPath = "servers/exit-1/reboot";
  assert.equal((await api(rebootPath)).data.ready, true);
  await api("servers/ir-main/reboot", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, status: 409 });
  const rebootJob = (await api(rebootPath, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, status: 202 })).data;
  assert.equal(rebootJob.operation, "reboot");
  const rebootLease = (await api("agent/provision/claim", { body: { serverId: "exit-1" }, token: receiver, headers: rebootHeaders })).data;
  assert.equal(rebootLease.id, rebootJob.id);
  await finishProvision(rebootLease, "succeeded", "rebooted");
  const rebootAudit = (await api("audit")).data.find((item) => item.action === "provision.reboot" && item.target === "exit-1");
  assert.equal(rebootAudit.detail, "ریستارت سرور در صف Agent قرار گرفت.");

  const telegramTick = () => api("notifications/telegram/tick", { method: "POST" });
  const telegramStatus = async () => (await api("notifications/telegram")).data.history;
  await action("updateSettings", [{ metricAlertRules: [{ id: "telegram-cpu-rule", name: "CPU test", targetId: "observer-1", metric: "cpu", operator: "gt", threshold: 90, cooldownMinutes: 60, enabled: true, severity: "warning" }] }]);
  const loud = (offset) => api("agent/telemetry", { token: observer, body: {
    ...fresh, serverId: "observer-1", reportId: randomUUID(), observedAt: future(offset), cpu: 99, tunnels: [],
  } });
  await loud(4000);
  await loud(5000);
  assert.equal((await telegramStatus()).filter((item) => item.alertId).length, 1);
  const telegramRequest = { method: "POST", headers: { "Idempotency-Key": randomUUID() } };
  await api("notifications/telegram/test", { ...telegramRequest, token: readonly, status: 403 });
  const testMessage = (await api("notifications/telegram/test", telegramRequest)).data.id;
  assert.equal((await api("notifications/telegram/test", telegramRequest)).data.replay, true);
  const retry = (await telegramStatus()).find((item) => item.id === testMessage);
  assert.equal(retry.status, "pending");
  assert.equal(retry.attempts, 1);
  const liveDb = new DatabaseSync(join(temp, "monitor.sqlite"));
  liveDb.prepare("UPDATE telegram_outbox SET last_attempt=? WHERE id=?").run(Date.now() - 4000, retry.id);
  const [tickA, tickB] = await Promise.all([telegramTick(), telegramTick()]);
  assert.equal(tickA.data.processed + tickB.data.processed, 1);
  try {
    const retryAt = liveDb.prepare("SELECT due_at,last_attempt FROM telegram_outbox WHERE id=?").get(retry.id);
    assert.ok(retryAt.due_at - retryAt.last_attempt >= 20000);
    const alertDelivery = (await telegramStatus()).find((item) => item.alertId && item.status === "sent");
    assert.equal(alertDelivery?.messageId, 502);
    liveDb.prepare("UPDATE telegram_outbox SET due_at=?,last_attempt=? WHERE id=?").run(Date.now() - 1, Date.now() - 4000, retry.id);
    liveDb.prepare("UPDATE telegram_outbox SET last_attempt=? WHERE id=?").run(Date.now() - 4000, alertDelivery.id);
    await telegramTick();
    assert.equal((await telegramStatus()).find((item) => item.id === testMessage).status, "unknown");
    liveDb.prepare("UPDATE telegram_outbox SET last_attempt=? WHERE id=?").run(Date.now() - 4000, testMessage);
    await telegramTick();
    assert.equal((await telegramStatus()).find((item) => item.id === testMessage).attempts, 2, "Unconfirmed delivery must not be retried");
  } finally {
    liveDb.close();
  }
  console.log("PASS: Telegram alert deduplication, worker rate limit, 429 retry and ambiguous delivery.");
  const pairList = async () => (await api("provision/tunnels")).data;
  const pair = (body, options = {}) => api("provision/tunnels", { body, headers: { "Idempotency-Key": randomUUID() }, ...options });
  const pairedStatus = async (id) => (await pairList()).deployments.find((item) => item.id === id);
  const tunnelPreview = (await pairList()).previews.find((item) => item.tunnelId === "tun-main");
  assert.equal(tunnelPreview.iran.serverId, "ir-main");
  assert.equal(tunnelPreview.foreign.serverId, "exit-1");
  assert.equal((await api("tunnels/tun-main/bundle-recipe")).data.port, 443);
  const pairBody = { tunnelId: tunnelPreview.tunnelId, fingerprint: tunnelPreview.fingerprint };
  const finishSide = (job, status, detail, token, httpStatus = 200) => api("agent/provision/" + job.id + "/finish", {
    body: { serverId: job.profile.serverId, lease: job.lease, status, detail }, token, status: httpStatus,
  });
  await pair(pairBody, { token: readonly, status: 403 });
  await pair({ ...pairBody, fingerprint: "b".repeat(64) }, { status: 409 });

  const pairedKey = { "Idempotency-Key": randomUUID() };
  const failurePair = (await pair(pairBody, { headers: pairedKey })).data.deployment;
  assert.equal(failurePair.phase, "foreign_apply");
  assert.equal((await pair(pairBody, { headers: pairedKey })).data.replay, true);
  assert.equal((await claimProvision("ir-main", agent)).data, null);
  await provision(profile, { status: 409 });
  await pair(pairBody, { status: 409 });
  const outsideStep = (await claimProvision("exit-1", receiver)).data;
  assert.equal(outsideStep.profile.id, "gre-out");
  await finishSide(outsideStep, "succeeded", "applied", receiver);
  await provision({ operation: "rollback", jobId: outsideStep.id }, { status: 409 });
  const insideStep = (await claimProvision("ir-main", agent)).data;
  assert.equal(insideStep.profile.id, "gre-in");
  await finishSide(insideStep, "failed", "external_change", agent, 422);
  await finishSide(insideStep, "failed", "reverted", agent);
  assert.equal((await pairedStatus(failurePair.id)).phase, "foreign_restore");
  const automaticRollback = (await claimProvision("exit-1", receiver)).data;
  assert.equal(automaticRollback.rollbackOf, outsideStep.id);
  await finishSide(automaticRollback, "succeeded", "restored", receiver);
  assert.equal((await pairedStatus(failurePair.id)).status, "rolled_back");
  assert.equal(await exercise("provision-rollback", failurePair.createdAt), false);

  const installBoth = async () => {
    const run = (await pair(pairBody)).data.deployment;
    const out = (await claimProvision("exit-1", receiver)).data;
    await finishSide(out, "succeeded", "applied", receiver);
    const inside = (await claimProvision("ir-main", agent)).data;
    await finishSide(inside, "succeeded", "applied", agent);
    for (const [serverId, token] of [["ir-main", agent], ["exit-1", receiver]]) {
      const bbr = (await api("agent/provision/claim", { body: { serverId }, token, headers: downloadHeaders })).data;
      assert.equal(bbr.profile.component, "BBR");
      await finishSide(bbr, "succeeded", "applied", token);
    }
    assert.equal((await pairedStatus(run.id)).status, "verifying");
    return { run, out, inside };
  };
  const expireVerification = (run) => {
    const pairedDb = new DatabaseSync(join(temp, "monitor.sqlite"));
    try {
      pairedDb.prepare("UPDATE tunnel_deployments SET verify_until=? WHERE id=?").run(Date.now() - 1, run.id);
    } finally {
      pairedDb.close();
    }
  };
  const timeoutPair = await installBoth();
  expireVerification(timeoutPair.run);
  assert.equal((await pairedStatus(timeoutPair.run.id)).phase, "iran_restore");
  await finishSide((await claimProvision("ir-main", agent)).data, "succeeded", "restored", agent);
  await finishSide((await claimProvision("exit-1", receiver)).data, "succeeded", "restored", receiver);
  assert.equal((await pairedStatus(timeoutPair.run.id)).status, "rolled_back");
  assert.equal(await exercise("provision-rollback", timeoutPair.run.createdAt), false);

  const good = await installBoth();
  const observeLink = (delayMs) => {
    const stamp = Date.now();
    return api("agent/telemetry", { token: agent, body: {
      ...fresh, reportId: randomUUID(), observedAt: new Date(stamp).toISOString(),
      tunnels: fresh.tunnels.map((reading) => ({ ...reading, measuredAt: new Date(stamp - delayMs).toISOString() })),
    } });
  };
  await observeLink(10000);
  assert.equal((await pairedStatus(good.run.id)).status, "verifying");
  await delay(8);
  await observeLink(0);
  assert.equal((await pairedStatus(good.run.id)).status, "succeeded");

  const requestRollback = () => api("provision/tunnels/" + good.run.id + "/rollback", { method: "POST" });
  assert.equal((await requestRollback()).data.phase, "iran_restore");
  assert.equal((await requestRollback()).data.phase, "iran_restore");
  assert.equal((await claimProvision("exit-1", receiver)).data, null);
  const innerRollback = (await claimProvision("ir-main", agent)).data;
  assert.equal(innerRollback.rollbackOf, good.inside.id);
  await finishSide(innerRollback, "succeeded", "restored", agent);
  const outerRollback = (await claimProvision("exit-1", receiver)).data;
  assert.equal(outerRollback.rollbackOf, good.out.id);
  await finishSide(outerRollback, "succeeded", "restored", receiver);
  assert.equal((await pairedStatus(good.run.id)).status, "rolled_back");
  assert.equal(await exercise("provision-rollback", good.run.createdAt), true);

  const previous = await installBoth();
  await delay(8);
  await observeLink(0);
  assert.equal((await pairedStatus(previous.run.id)).status, "succeeded");
  const rebuildSpec = { ...pairBody, operation: "rebuild" };
  assert.equal((await pair(rebuildSpec, { status: 409 })).error.code, "TUNNEL_WORKER_UPGRADE");
  await claimProvision("ir-main", agent, 200, true);
  await claimProvision("exit-1", receiver, 200, true);
  const rebuildHeaders = { "Idempotency-Key": randomUUID() };
  const rebuild = (await pair(rebuildSpec, { headers: rebuildHeaders })).data.deployment;
  assert.equal(rebuild.phase, "iran_remove");
  assert.equal((await pair(rebuildSpec, { headers: rebuildHeaders })).data.replay, true);
  assert.equal((await claimProvision("exit-1", receiver, 200, true)).data, null);
  assert.equal((await claimProvision("ir-main", agent)).data, null);
  const removeIran = (await claimProvision("ir-main", agent, 200, true)).data;
  assert.equal(removeIran.operation, "remove");
  assert.equal(removeIran.rollbackOf, previous.inside.id);
  await finishSide(removeIran, "succeeded", "removed", agent);
  await stop();
  await start("ir-main", "monitor", true, true, true);
  const removeForeign = (await claimProvision("exit-1", receiver, 200, true)).data;
  assert.equal(removeForeign.operation, "remove");
  assert.equal(removeForeign.rollbackOf, previous.out.id);
  await finishSide(removeForeign, "succeeded", "removed", receiver);
  assert.equal((await pairedStatus(rebuild.id)).phase, "foreign_apply");
  const rebuiltForeign = (await claimProvision("exit-1", receiver, 200, true)).data;
  await finishSide(rebuiltForeign, "succeeded", "applied", receiver);
  const rebuiltIran = (await claimProvision("ir-main", agent, 200, true)).data;
  await finishSide(rebuiltIran, "succeeded", "applied", agent);
  for (const [serverId, token] of [["ir-main", agent], ["exit-1", receiver]]) {
    const bbr = (await api("agent/provision/claim", { body: { serverId }, token, headers: { ...downloadHeaders, "X-NodeGuard-Provision-Remove": "1" } })).data;
    assert.equal(bbr.profile.component, "BBR");
    await finishSide(bbr, "succeeded", "applied", token);
  }
  await delay(8);
  await observeLink(0);
  assert.equal((await pairedStatus(rebuild.id)).status, "succeeded");
  const destroySpec = { tunnelId: pairBody.tunnelId, operation: "destroy" };
  const changePortDb = new DatabaseSync(join(temp, "monitor.sqlite"));
  const previousPanelCache = changePortDb.prepare("SELECT payload FROM provider_cache WHERE provider='v2board'").get();
  changePortDb.prepare(`INSERT INTO provider_cache VALUES ('v2board',?) ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload`)
    .run(JSON.stringify({ syncedAt: new Date().toISOString(), nodes: [{ key: "vmess:7", port: 1443, server_port: 2443 }] }));
  changePortDb.close();
  const currentForwarding = (await api("tunnels/tun-main/bundle-recipe")).data;
  assert.equal(currentForwarding.port, 1443);
  assert.equal(currentForwarding.targetPort, 2443);
  assert.equal((await pair(rebuildSpec, { status: 409 })).error.code, "TUNNEL_DEPLOYMENT_STATE");
  await pair(destroySpec, { token: readonly, status: 403 });
  const destroy = (await pair(destroySpec)).data.deployment;
  const destroyedIran = (await claimProvision("ir-main", agent, 200, true)).data;
  assert.equal(destroyedIran.rollbackOf, rebuiltIran.id);
  await finishSide(destroyedIran, "succeeded", "removed", agent);
  const destroyedForeign = (await claimProvision("exit-1", receiver, 200, true)).data;
  assert.equal(destroyedForeign.rollbackOf, rebuiltForeign.id);
  await finishSide(destroyedForeign, "review", "external_change", receiver);
  assert.equal((await pairedStatus(destroy.id)).status, "review");
  await pair(rebuildSpec, { status: 409 });
  await api(`provision/tunnels/${destroy.id}/review`, { method: "POST" });
  const retriedDestroy = (await pair(destroySpec)).data.deployment;
  assert.equal(retriedDestroy.phase, "foreign_remove");
  assert.equal((await claimProvision("ir-main", agent, 200, true)).data, null);
  const retryForeign = (await claimProvision("exit-1", receiver, 200, true)).data;
  await finishSide(retryForeign, "succeeded", "removed", receiver);
  assert.equal((await pairedStatus(retriedDestroy.id)).status, "destroyed");
  const afterDestroy = (await api("provision/tunnels?tunnelId=tun-main")).data;
  assert.equal(afterDestroy.hasManagedInstall, false);
  assert.ok(!afterDestroy.previews.some((item) => item.tunnelId === "tun-main"));
  assert.equal(afterDestroy.forwarding.port, 1443);
  const restorePortDb = new DatabaseSync(join(temp, "monitor.sqlite"));
  if (previousPanelCache) restorePortDb.prepare("UPDATE provider_cache SET payload=? WHERE provider='v2board'").run(previousPanelCache.payload);
  else restorePortDb.prepare("DELETE FROM provider_cache WHERE provider='v2board'").run();
  restorePortDb.close();
  assert.equal((await pairList()).previews.find((item) => item.tunnelId === "tun-main").fingerprint, pairBody.fingerprint);
  assert.equal((await api("tunnels/tun-main")).data.status, "offline");
  const retired = (await api("tunnels", { status: 201, body: {
    nodeRef: { kind: "inventory", id: "node-1" }, technology: "GRE", side: "primary", port: 61843,
    iranServerId: "ir-main", foreignServerId: "exit-1",
  } })).data;
  const linkDb = new DatabaseSync(join(temp, "monitor.sqlite"));
  try {
    const row = linkDb.prepare("SELECT snapshot FROM workspace WHERE singleton=1").get();
    const snap = JSON.parse(row.snapshot);
    const sample = snap.nodes.find((node) => node.id === "node-1");
    snap.nodes.push({
      ...sample, id: "node-retired", name: "Retired", domain: "detach.nodeguard.example",
      primaryTunnelId: retired.id, backupTunnelId: undefined, backupServerId: undefined, activeSide: "primary",
      tunnelIds: [retired.id],
    });
    const linked = snap.tunnels.find((item) => item.id === retired.id);
    linked.nodeIds = ["node-retired"];
    linkDb.prepare("UPDATE workspace SET snapshot=?, revision=revision+1 WHERE singleton=1").run(JSON.stringify(snap));
  } finally {
    linkDb.close();
  }
  await api(`tunnels/${retired.id}`, { method: "DELETE" });
  assert.equal((await api("nodes/node-retired", { status: 404 })).error.code, "NOT_FOUND");
  assert.equal((await api("nodes/node-1")).data.primaryTunnelId, "tun-main");
  assert.equal((await api("nodes/node-1")).data.backupTunnelId, "tun-backup");
  await delay(8);
  const stamp = new Date().toISOString();
  await api("agent/telemetry", { token: agent, body: {
    ...fresh, reportId: randomUUID(), observedAt: stamp,
    tunnels: [{ ...fresh.tunnels[0], tunnelId: retired.id, measuredAt: stamp }],
  } });
  await api(`tunnels/${retired.id}`, { status: 404 });
  console.log("PASS: tunnel cleanup capability, ordered removal, durable rebuild, verified redeployment and preserved inventory.");

  const noProbe = await installBoth();
  expireVerification(noProbe.run);
  assert.equal((await pairedStatus(noProbe.run.id)).phase, "iran_restore");
  const unclear = (await claimProvision("ir-main", agent)).data;
  await finishSide(unclear, "review", "external_change", agent);
  assert.equal((await pairedStatus(noProbe.run.id)).status, "review");
  assert.equal((await claimProvision("exit-1", receiver)).data, null);
  await pair(pairBody, { status: 409 });
  await api("provision/jobs/" + unclear.id + "/review", { method: "POST", status: 409 });
  await stop();
  await start("ir-main", "monitor", true, true, true);
  assert.equal((await pairedStatus(noProbe.run.id)).status, "review");
  assert.equal((await api("provision/tunnels/" + noProbe.run.id + "/review", { method: "POST" })).data.status, "failed");
  console.log("PASS: coordinated tunnel order, per-host leases, fresh verification, compensation, rollback and restart recovery.");

  const forwardTime = new Date().toISOString();
  const forwardReport = {
    ...fresh, reportId: randomUUID(), observedAt: forwardTime, tunnels: [],
    forwarderChecks: [{ tunnelId: "tun-forward-lab", measuredAt: forwardTime, ok: true, elapsedMs: 37 }],
  };
  await api("agent/telemetry", { token: receiver, body: { ...forwardReport, serverId: "exit-1" }, status: 422 });
  await api("agent/telemetry", { token: agent, body: forwardReport });
  const forwarded = (await api("tunnels/tun-forward-lab")).data;
  assert.equal(forwarded.status, "healthy");
  assert.equal(forwarded.forwarderProbe.elapsedMs, 37);
  assert.equal((await api("metrics?tunnelId=tun-forward-lab&range=1h")).data.find((point) => point.forwardLatency === 37)?.forwardLatency, 37);
  assert.deepEqual((await probeHistory("1h")).tunnels["tun-forward-lab"], { samples: 1, successful: 1 });
  console.log("PASS: measured availability and tunnel reliability, excluding pinned probes and preserving gaps.");
  console.log("PASS: forwarder telemetry ownership, distinct HTTPS status and latency history.");
  const inventoryHost = {
    id: "ir-registered", name: "میزبان ثبت‌شده", country: "ایران", countryCode: "IR", city: "تهران",
    publicIpv4: "192.0.2.55", publicIpv6: "2001:db8::55", provider: "Lab", os: "Ubuntu",
    tunnelIp: "10.55.0.1", roles: ["iran-primary", "iran-backup"],
  };
  const addHost = (body, options = {}) => api("servers", { body, ...options });
  const addTunnel = (body, options = {}) => api("tunnels", { body, ...options });
  const serverForm = { publicIpv4: "8.8.4.4", publicIpv6: "2001:4860:4860::8844", os: "Debian", roles: ["foreign"] };
  await api("servers/lookup?ip=8.8.4.4", { token: readonly, status: 403 });
  assert.equal((await api("servers/lookup?ip=8.8.4.4")).data.provider, "Google LLC");
  await addHost({ ...serverForm, publicIpv4: "127.0.0.1" }, { status: 422 });
  await addHost({ ...serverForm, publicIpv6: "fd00::4" }, { status: 422 });
  await addHost({ ...serverForm, os: "Windows" }, { status: 422 });
  await addHost({ ...serverForm, publicIpv4: "9.9.9.9" }, { status: 502 });
  const modern = (await addHost(serverForm, { status: 201 })).data;
  assert.equal(modern.id, "US-8.8.4.4");
  assert.equal(modern.provider, "Google LLC");
  assert.equal(modern.sshUsername, "root");
  assert.equal(modern.sshPort, 22);
  assert.equal((await addHost(serverForm)).replay, true);
  const modernPath = "servers/" + modern.id;
  const modernEdit = { ...serverForm, publicIpv4: "1.0.0.1", publicIpv6: undefined, sshPort: 2222 };
  await api(modernPath, { method: "PUT", body: modernEdit, token: readonly, status: 403 });
  const edited = (await api(modernPath, { method: "PUT", body: modernEdit })).data;
  assert.equal(edited.id, modern.id);
  assert.equal(edited.name, "AU-1.0.0.1");
  assert.equal(edited.countryCode, "AU");
  assert.equal(edited.publicIpv6, undefined);
  assert.equal(edited.sshPort, 2222);
  await addHost(inventoryHost, { token: readonly, status: 403 });
  await addHost({ ...inventoryHost, publicIpv4: "bad" }, { status: 422 });
  const hostRace = await Promise.all([201, 200].map(() => fetch(base + "/api/v1/servers", {
    method: "POST", headers: { Authorization: "Bearer " + infra, "Content-Type": "application/json" },
    body: JSON.stringify(inventoryHost),
  })));
  assert.deepEqual(hostRace.map((response) => response.status).sort(), [200, 201]);
  const newHost = (await api("servers/" + inventoryHost.id)).data;
  const sshHost = { ...inventoryHost, id: "ssh-fixture", publicIpv4: "127.0.0.1" };
  await addHost(sshHost, { status: 201 });
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
  const userKey = ssh2.utils.generateKeyPairSync("ed25519", { passphrase: "fixture-key-passphrase", cipher: "aes256-cbc" });
  const publicKey = ssh2.utils.parseKey(userKey.public);
  assert.ok(!(publicKey instanceof Error));
  let authenticated = 0;
  let authenticationAttempts = 0;
  let remoteSessions = 0;
  let consoleEnabled = false;
  let consoleWindow = null;
  const sshServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (connection) => {
    connection.on("error", () => {});
    connection.on("authentication", (ctx) => {
      authenticationAttempts += 1;
      const match = ctx.username === "fixture" && (
        (ctx.method === "password" && ["fixture-ssh-password", "fixture-ssh-password-updated"].includes(ctx.password)) ||
        (ctx.method === "publickey" && ctx.key.data.equals(publicKey.getPublicSSH()) &&
          (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true))
      );
      if (match) {
        if (ctx.method === "password" || ctx.signature) authenticated += 1;
        ctx.accept();
      } else ctx.reject(["password", "publickey"]);
    });
    connection.on("session", (accept, reject) => {
      remoteSessions += 1;
      if (!consoleEnabled) { reject(); return; }
      const session = accept();
      session.on("pty", (accept) => accept());
      session.on("window-change", (_accept, _reject, info) => { consoleWindow = info; });
      session.on("shell", (accept) => {
        const channel = accept();
        channel.write("fixture-console-ready\r\n");
        channel.on("data", (bytes) => channel.write(bytes));
      });
    });
  });
  await new Promise((resolve, reject) => sshServer.listen(0, "127.0.0.1", resolve).once("error", reject));
  try {
    const fingerprint = "SHA256:" + createHash("sha256").update(Buffer.from(hostKey.public.split(" ")[1], "base64")).digest("base64").replace(/=$/, "");
    const sshRequest = { ip: sshHost.publicIpv4, username: "fixture", port: sshServer.address().port, fingerprint };
    const passwordInput = { ...sshRequest, method: "password", password: "fixture-ssh-password" };
    const sshTest = (body, options = {}) => api("servers/" + sshHost.id + "/ssh-test", { body, ...options });
    await sshTest(passwordInput, { token: readonly, status: 403 });
    await sshTest({ ...passwordInput, ip: "127.0.0.2" }, { status: 422 });
    const wrongKey = await sshTest({ ...passwordInput, fingerprint: "SHA256:" + "A".repeat(43) }, { status: 409 });
    assert.equal(wrongKey.error.code, "SSH_HOST_KEY");
    assert.equal(authenticated, 0);
    await sshTest({ ...passwordInput, password: "wrong" }, { status: 502 });
    assert.deepEqual((await sshTest(passwordInput)).data, { connected: true });
    assert.deepEqual((await sshTest({ ...sshRequest, method: "key", privateKey: userKey.private,
      passphrase: "fixture-key-passphrase" })).data, { connected: true });
    assert.equal(authenticated, 2);
    const sshPath = "servers/" + sshHost.id + "/ssh";
    await api(sshPath, { method: "PUT", body: passwordInput, token: readonly, status: 403 });
    assert.equal((await api(sshPath, { method: "PUT", body: passwordInput })).data.connection.username, "fixture");
    const storedConnection = (await api(sshPath)).data.connection;
    assert.equal(storedConnection.ip, "127.0.0.1");
    assert.ok(!JSON.stringify(storedConnection).includes("fixture-ssh-password"));
    const sshStore = new DatabaseSync(join(temp, "monitor.sqlite"), { readOnly: true });
    try {
      const { sealed } = sshStore.prepare("SELECT sealed FROM provider_credentials WHERE provider=?").get("ssh:" + sshHost.id);
      assert.equal(sealed.split(".").length, 3);
      assert.ok(!sealed.includes(passwordInput.password));
    } finally { sshStore.close(); }
    assert.equal((await api(sshPath, { method: "DELETE" })).data.removed, true);
    assert.equal((await api(sshPath)).data.connection, null);
    assert.equal(remoteSessions, 0);
    console.log("PASS: real SSH password and encrypted key, pinned host identity, and no remote command session.");
    const ping = (await api(`servers/${sshHost.id}/ping`)).data;
    assert.ok(["reachable", "unavailable"].includes(ping.status));
    assert.ok(Number.isFinite(Date.parse(ping.checkedAt)));
    const profilePath = "servers/" + sshHost.id;
    const profile = { publicIpv4: sshHost.publicIpv4, publicIpv6: sshHost.publicIpv6,
      os: "Debian", roles: sshHost.roles, sshUsername: sshRequest.username, sshPort: sshRequest.port };
    const loginProfile = { ...profile, password: passwordInput.password };
    const attemptsBeforeDiscovery = authenticationAttempts;
    const { error: confirmation } = await api(profilePath, { method: "PUT", body: loginProfile, status: 422 });
    assert.equal(confirmation.code, "SSH_HOST_CONFIRMATION");
    assert.equal(confirmation.details.fingerprint, fingerprint);
    assert.equal(authenticationAttempts, attemptsBeforeDiscovery);
    assert.equal((await api(sshPath)).data.connection, null);
    const withLogin = (await api(profilePath, { method: "PUT", body: { ...loginProfile, fingerprint: confirmation.details.fingerprint } })).data;
    assert.equal(withLogin.hardware, undefined);
    assert.equal(remoteSessions, 0);
    assert.ok(!JSON.stringify(withLogin).includes(passwordInput.password));
    const verifiedCount = authenticated;
    await api(profilePath, { method: "PUT", body: { ...profile, password: passwordInput.password } });
    assert.equal(authenticated, verifiedCount);

    await api(profilePath, { method: "PUT", body: { ...profile, os: "Ubuntu" } });
    assert.equal(authenticated, verifiedCount);
    assert.equal((await api(sshPath)).data.connection.method, "password");
    assert.equal((await api(sshPath)).data.connection.fingerprint, fingerprint);
    assert.ok(!JSON.stringify((await api(sshPath)).data).includes(passwordInput.password));
    await api(profilePath + "/ssh-password", { method: "POST", token: readonly, status: 403 });
    assert.deepEqual((await api(profilePath + "/ssh-password", { method: "POST" })).data, { password: passwordInput.password });
    const beforePasswordChange = authenticated;
    await api(profilePath, { method: "PUT", body: { ...profile, password: "fixture-ssh-password-updated" } });
    assert.equal(authenticated, beforePasswordChange + 1);
    assert.equal((await api(profilePath + "/ssh-password", { method: "POST" })).data.password, "fixture-ssh-password-updated");
    await api(profilePath, { method: "PUT", body: { ...profile, password: passwordInput.password } });
    const panelKey = () => api("servers/panel-ssh-key", { method: "POST" });
    const publicPart = (await panelKey()).data;
    assert.match(publicPart.publicKey, /^ssh-ed25519 /);
    assert.deepEqual((await panelKey()).data, publicPart);
    consoleEnabled = true;
    const consolePath = profilePath + "/console/" + randomUUID();
    const abort = new AbortController();
    try {
      const consoleResponse = await fetch(base + "/api/v1/" + consolePath + "/open", {
        method: "POST", headers: { Authorization: "Bearer " + admin }, signal: abort.signal,
      });
      assert.equal(consoleResponse.status, 200);
      const reader = consoleResponse.body.getReader();
      assert.match(Buffer.from((await reader.read()).value).toString(), /fixture-console-ready/);
      await api(consolePath + "/input", { body: { text: "fixture-input" } });
      assert.match(Buffer.from((await reader.read()).value).toString(), /fixture-input/);
      await api(consolePath + "/resize", { body: { cols: 1, rows: 48 }, status: 422 });
      await api(consolePath + "/resize", { body: { cols: 180, rows: 48 } });
      const resizeDeadline = Date.now() + 2000;
      while ((!consoleWindow || consoleWindow.cols !== 180) && Date.now() < resizeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(consoleWindow?.cols, 180);
      assert.equal(consoleWindow?.rows, 48);
      await reader.cancel();
    } finally { abort.abort(); }
  } finally {
    await new Promise((resolve) => sshServer.close(resolve));
  }
  assert.equal(newHost.agent.status, "offline");
  assert.equal(newHost.agent.lastHeartbeat, "");
  assert.equal((await addHost({ ...inventoryHost, roles: [...inventoryHost.roles].reverse() })).replay, true);
  await addHost({ ...inventoryHost, publicIpv4: "192.0.2.56" }, { status: 409 });
  assert.equal((await api("servers/" + inventoryHost.id + "/agent")).data.state, "unconfigured");

  const newRoute = {
    id: "tun-registered", name: "مسیر پایش ثبت‌شده", technology: "WireGuard", side: "primary", mtu: 1420, port: 443,
    iranServerId: inventoryHost.id, foreignServerId: "exit-1", interfaceName: "ng-wg55",
    foreignInterfaceName: "ng-wg-out55", iranTunnelIp: "10.55.8.1", foreignTunnelIp: "10.55.8.2",
  };
  await addTunnel(newRoute, { token: readonly, status: 403 });
  await addTunnel({ ...newRoute, port: undefined }, { status: 422 });
  await addTunnel({ ...newRoute, port: 65536 }, { status: 422 });
  await addTunnel({ ...newRoute, iranServerId: "exit-1" }, { status: 422 });
  await addTunnel({ ...newRoute, foreignServerId: inventoryHost.id }, { status: 422 });
  await addTunnel({ ...newRoute, iranTunnelIp: "2001:db8::1", foreignTunnelIp: "2001:0db8:0:0::1" }, { status: 422 });
  await addTunnel({ ...newRoute, iranTunnelIp: "2001:db8::1" }, { status: 422 });
  await addTunnel({ ...newRoute, id: "new" }, { status: 422 });
  const link = (await addTunnel(newRoute, { token: infra, status: 201 })).data;
  await api("servers/" + inventoryHost.id, { method: "PUT", body: {
    publicIpv4: inventoryHost.publicIpv4, os: "Ubuntu", roles: ["foreign"],
  }, status: 409 });
  assert.equal(link.status, "offline");
  assert.equal(link.iranEndpoint.tunnelIp, "10.55.8.1");
  assert.equal(link.foreignEndpoint.interfaceName, "ng-wg-out55");
  assert.equal(link.iranEndpoint.port, 443);
  await addTunnel({ ...newRoute, id: "tun-same-interface" }, { status: 409 });
  await addTunnel({ ...newRoute, mtu: 1400 }, { status: 409 });
  const forwardSpec = {
    id: "tun-registered-forwarder", name: "هدایت پورت ثبت‌شده", technology: "GOST", side: "primary",
    iranServerId: "ir-backup", foreignServerId: "exit-1", mtu: 1400, port: 8443, serviceName: "gost.service",
  };
  await addTunnel({ ...forwardSpec, interfaceName: "gost0" }, { status: 422 });
  const forwardLink = (await addTunnel(forwardSpec, { status: 201 })).data;
  assert.deepEqual((await api("tunnels/" + forwardSpec.id + "/bundle-recipe")).data, {
    schema: 1, tunnelId: forwardSpec.id, technology: "GOST", port: 8443,
    iran: { serverId: "ir-backup", outerIp: "192.0.2.11" },
    foreign: { serverId: "exit-1", outerIp: "198.51.100.10" },
  });
  await api("tunnels/missing/bundle-recipe", { status: 404 });
  await api("tunnels/" + newRoute.id + "/bundle-recipe", { token: readonly, status: 403 });
  assert.equal(forwardLink.kind, "forwarder");
  assert.equal(forwardLink.iranEndpoint.tunnelIp, undefined);
  assert.equal(forwardLink.foreignEndpoint.tunnelIp, undefined);

  const reservedRoute = { ...newRoute, id: "tun-reserved-pool", port: 444, interfaceName: "ng-reserved",
    foreignInterfaceName: "ng-reserved", iranTunnelIp: "10.254.0.2", foreignTunnelIp: "10.254.0.3" };
  await addTunnel(reservedRoute, { status: 201 });
  const autoRoute = {
    nodeRef: { kind: "inventory", id: "node-1" }, technology: "GRE", side: "primary",
    iranServerId: inventoryHost.id, foreignServerId: "exit-1", port: 445,
  };
  await addTunnel({ ...autoRoute, nodeDomain: "192.0.2.22" }, { status: 422 });
  await addTunnel({ ...autoRoute, iranTunnelIp: "10.254.0.50" }, { status: 422 });
  const [primaryRoute, backupRoute] = (await Promise.all([
    addTunnel(autoRoute, { status: 201 }),
    addTunnel({ ...autoRoute, side: "primary", iranServerId: "ir-main" }, { status: 201 }),
  ])).map(({ data }) => data);
  assert.match(primaryRoute.id, /^route:[a-f0-9]{20}:[a-f0-9-]{36}$/);
  assert.notEqual(backupRoute.id, primaryRoute.id);
  assert.equal(backupRoute.nodeDomain, undefined);
  assert.equal(primaryRoute.nodeDomain, undefined);
  assert.equal(primaryRoute.configuredMtu, 1400);
  const assigned = [primaryRoute, backupRoute].flatMap((tunnel) => [
    tunnel.iranEndpoint.tunnelIp, tunnel.foreignEndpoint.tunnelIp,
  ]);
  assert.equal(new Set(assigned).size, 4);
  assert.ok(assigned.every((ip) => /^10\.254\./.test(ip) && !["10.254.0.1", "10.254.0.2", "10.254.0.3"].includes(ip)));
  assert.notEqual(primaryRoute.foreignEndpoint.interfaceName, backupRoute.foreignEndpoint.interfaceName);
  const replayed = await addTunnel({ ...autoRoute, mtu: 1400 });
  assert.equal(replayed.replay, true);
  assert.equal(replayed.data.iranEndpoint.tunnelIp, primaryRoute.iranEndpoint.tunnelIp);
  const recipe = (await api("tunnels/" + encodeURIComponent(backupRoute.id) + "/bundle-recipe")).data;
  assert.equal(recipe.port, autoRoute.port);
  assert.equal(recipe.foreign.innerIp, backupRoute.foreignEndpoint.tunnelIp);
  assert.match(recipe.foreign.interfaceName, /^ng[a-f0-9]{12}$/);
  const reusedIp = await addTunnel({ ...reservedRoute, id: "tun-reused-ip", interfaceName: "ng-reused",
    foreignInterfaceName: "ng-reused", iranTunnelIp: primaryRoute.foreignEndpoint.tunnelIp }, { status: 409 });
  assert.equal(reusedIp.error.code, "TUNNEL_IP_EXISTS");
  await addTunnel({ ...autoRoute, technology: "SIT", mtu: 1200 }, { status: 422 });
  assert.equal((await addTunnel({ ...autoRoute, technology: "SIT" }, { status: 409 })).error.code, "TUNNEL_PORT_EXISTS");
  const sitRoute = (await addTunnel({ ...autoRoute, technology: "SIT", port: 446 }, { status: 201 })).data;
  assert.match(sitRoute.iranEndpoint.tunnelIp, /^fd.*::1$/);
  assert.match(sitRoute.foreignEndpoint.tunnelIp, /^fd.*::2$/);
  await api(`tunnels/${sitRoute.id}`, { method: "DELETE", token: readonly, status: 403 });
  assert.equal((await api(`tunnels/${sitRoute.id}`, { method: "DELETE" })).data.removed, true);
  await api(`tunnels/${sitRoute.id}`, { status: 404 });
  const restoredRegistration = await addTunnel({ ...autoRoute, technology: "SIT", port: 446 }, { status: 201 });
  assert.notEqual(restoredRegistration.data.id, sitRoute.id);

  const readPanel = () => api("providers/v2board/catalog");
  const panelSync = () => api("providers/v2board/sync", { method: "POST" });
  const panelImport = (body, options = {}) => api("providers/v2board/import", { body, ...options });
  assert.equal((await readPanel()).data.enabled, true);
  assert.equal((await readPanel()).data.nodes.length, 0);
  await api("providers/v2board/sync", { method: "POST", token: readonly, status: 403 });
  const panelLogin = { address: "https://panel.nodeguard.example/fixture-admin/#/dashboard",
    email: "admin@nodeguard", password: "fixture-admin-password" };
  const connectV2Board = (body, options = {}) => api("providers/v2board/connect", { body, ...options });
  await connectV2Board(panelLogin, { token: readonly, status: 403 });
  await connectV2Board({ ...panelLogin, address: "https://127.0.0.1/fixture-admin" }, { status: 422 });
  assert.equal((await connectV2Board({ ...panelLogin, email: "missing-domain" }, { status: 422 })).error.code, "PANEL_LOGIN_INPUT");
  await connectV2Board({ ...panelLogin, password: "wrong" }, { status: 502 });
  await connectV2Board({ ...panelLogin, email: "user@nodeguard.example" }, { status: 502 });
  const connected = await connectV2Board(panelLogin);
  assert.equal(connected.data.count, 3);
  assert.ok(!JSON.stringify(connected).includes("fixture.v2board.admin-session"));
  const credentialsDb = new DatabaseSync(join(temp, "monitor.sqlite"), { readOnly: true });
  try {
    const { sealed } = credentialsDb.prepare("SELECT sealed FROM provider_credentials WHERE provider='v2board'").get();
    assert.equal(sealed.split(".").length, 3);
    assert.ok(!sealed.includes(panelLogin.password) && !sealed.includes("fixture.v2board.admin-session"));
  } finally {
    credentialsDb.close();
  }
  assert.equal((await panelSync()).data.count, 3);
  const catalogNodes = (await readPanel()).data.nodes;
  assert.equal(catalogNodes.find((item) => item.key === "vmess:7").nodeId, "node-1");
  assert.equal(catalogNodes.find((item) => item.key === "vless:8").online, 11);
  assert.equal(catalogNodes.find((item) => item.key === "vless:8").parentKey, "vless:1");
  assert.equal(catalogNodes.find((item) => item.key === "hysteria:9").online, 3);
  assert.equal(catalogNodes.find((item) => item.key === "hysteria:9").parentKey, undefined);
  await api("agent/telemetry", { body: { ...fresh, serverId: "exit-1", reportId: randomUUID(), observedAt: new Date().toISOString(), tunnels: [], logs: [] }, token: receiver });
  const removeHeaders = { "X-NodeGuard-V2bX-Remove": "1" };
  assert.equal((await api("agent/provision/claim", { body: { serverId: "exit-1" }, token: receiver, headers: removeHeaders })).data, null);
  const removePath = "servers/exit-1/v2bx-remove";
  assert.equal((await api(removePath + "?panelNode=vmess:7")).data.ready, true);
  await api("servers/ir-main/v2bx-remove?panelNode=vmess:7", { status: 403 });
  await api(removePath, { method: "POST", body: { panelNode: "vless:8" }, headers: { "Idempotency-Key": randomUUID() }, status: 422 });
  await api(removePath, { method: "POST", token: readonly, body: { panelNode: "vmess:7" }, headers: { "Idempotency-Key": randomUUID() }, status: 403 });
  const removeKey = { "Idempotency-Key": randomUUID() };
  const removal = (await api(removePath, { method: "POST", body: { panelNode: "vmess:7" }, headers: removeKey, status: 202 })).data;
  assert.equal(removal.operation, "remove-v2bx");
  assert.deepEqual(removal.profile.v2bxNode, { apiHost: "https://panel.nodeguard.example", nodeId: 7, nodeType: "vmess" });
  assert.equal((await api(removePath, { method: "POST", body: { panelNode: "vmess:7" }, headers: removeKey, status: 202 })).data.id, removal.id);
  assert.equal((await api("agent/provision/claim", { body: { serverId: "exit-1" }, token: receiver })).data, null);
  const removalLease = (await api("agent/provision/claim", { body: { serverId: "exit-1" }, token: receiver, headers: removeHeaders })).data;
  assert.equal(removalLease.id, removal.id);
  assert.equal((await api("agent/provision/" + removal.id + "/finish", {
    method: "POST", token: receiver, body: { serverId: "exit-1", lease: removalLease.lease, status: "succeeded", detail: "removed" },
  })).data.job.status, "succeeded");
  assert.equal((await api(removePath + "?panelNode=vmess:7")).data.job.id, removal.id);
  await api(removePath, { method: "POST", body: { panelNode: "hysteria:9" }, headers: { "Idempotency-Key": randomUUID() }, status: 422 });
  assert.deepEqual((await api("servers/exit-1/v2bx-nodes")).data.nodes, []);
  assert.ok((await api("audit")).data.some((item) => item.detail === "حذف V2bX نود تأیید شد."));
  const vmessBefore = catalogNodes.find((item) => item.key === "vmess:7");
  assert.equal(typeof vmessBefore.online, "number");
  await panelSync();
  const vmessAfter = (await readPanel()).data.nodes.find((item) => item.key === "vmess:7");
  assert.notEqual(vmessAfter.online, vmessBefore.online);
  assert.equal(vmessAfter.fingerprint, vmessBefore.fingerprint);
  assert.equal(catalogNodes.find((item) => item.key === "hysteria:9").protocol, "Hysteria2");
  const catalogRef = { kind: "v2board", key: "hysteria:9" };
  const catalogTunnel = { ...autoRoute, side: "backup", iranServerId: "ir-backup", nodeRef: catalogRef, port: undefined };
  await addTunnel({ ...catalogTunnel, nodeDomain: "wrong.nodeguard.example" }, { status: 422 });
  const catalogRoute = (await addTunnel(catalogTunnel, { status: 201 })).data;
  assert.deepEqual(catalogRoute.nodeRef, catalogRef);
  assert.equal(JSON.stringify(catalogNodes).includes("discard this field"), false);
  const selectedPanelNode = catalogNodes.find((item) => item.key === "vless:8");
  assert.equal(selectedPanelNode.tls, "Reality");
  assert.equal(selectedPanelNode.transport, "TCP");
  assert.equal(catalogNodes.find((item) => item.key === "vmess:7").transport, "WebSocket (TCP)");
  assert.equal(catalogNodes.find((item) => item.key === "hysteria:9").transport, "UDP");
  assert.equal(catalogNodes.find((item) => item.key === "hysteria:9").tls, undefined);
  assert.ok(!JSON.stringify(catalogNodes).includes("discard private key"));
  const nodeInput = { key: selectedPanelNode.key, fingerprint: selectedPanelNode.fingerprint,
    domain: "import.nodeguard.example", primaryTunnelId: newRoute.id };
  await panelImport(nodeInput, { token: readonly, status: 403 });
  await panelImport({ ...nodeInput, fingerprint: "a".repeat(64) }, { status: 409 });
  await panelImport({ ...nodeInput, backupTunnelId: "tun-main" }, { status: 422 });
  await panelImport({ ...nodeInput, domain: "de.nodeguard.example" }, { status: 409 });
  const range = catalogNodes.find((item) => item.key === "hysteria:9");
  await panelImport({ ...nodeInput, key: range.key, fingerprint: range.fingerprint }, { status: 422 });
  const primaryOnly = nodeInput;
  const [nodeFirst, nodeSecond] = await Promise.all([panelImport(primaryOnly), panelImport(primaryOnly)]);
  const imported = nodeFirst.data.node;
  assert.equal(imported.id, nodeSecond.data.node.id);
  assert.notEqual(nodeFirst.data.replay, nodeSecond.data.replay);
  assert.equal(imported.protocol, "VLESS");
  assert.equal(imported.port, 8443);
  assert.equal(imported.primaryServerId, inventoryHost.id);
  assert.equal(imported.backupServerId, undefined);
  assert.equal(imported.backupTunnelId, undefined);
  assert.equal(imported.activeSide, "primary");
  await api("failover/preflight/" + imported.id + "?target=backup", { status: 409 });
  await api("staging/readiness?nodeId=" + imported.id + "&since=" + encodeURIComponent(evidenceSince), { status: 409 });
  const prematureAutomation = await action("updatePolicy", [imported.id, { autoEnabled: true }], { status: 409 });
  assert.equal(prematureAutomation.error.code, "BACKUP_ROUTE_REQUIRED");
  await api("nodes/" + imported.id + "/backup-route", { body: { tunnelId: "tun-backup" }, status: 410 });
  const registeredBackup = (await addTunnel({ nodeRef: { kind: "inventory", id: imported.id }, side: "backup", technology: "GRE", iranServerId: "ir-backup", foreignServerId: "exit-1" }, { status: 201 })).data;
  const backupAssigned = (await api("workspace")).data.nodes.find(node => node.id === imported.id);
  assert.equal(backupAssigned.backupTunnelId, registeredBackup.id);
  assert.equal(backupAssigned.backupServerId, "ir-backup");
  assert.equal(backupAssigned.activeSide, "primary");
  const getImportedDns = async () => (await api("dns")).data.find((item) => item.nodeId === imported.id);
  assert.equal((await getImportedDns()).v2boardIp, "192.0.2.77");
  assert.equal((await api("policies")).data.find((item) => item.nodeId === imported.id).autoEnabled, false);
  assert.ok((await api("tunnels/" + newRoute.id)).data.nodeIds.includes(imported.id));
  const linkedNodes = (await api("tunnels/" + registeredBackup.id)).data.nodeIds;
  assert.equal(linkedNodes.filter((id) => id === imported.id).length, 1);
  await action("updateNodeSettings", [imported.id, { domain: "DE.NodeGuard.Example" }], { status: 409 });
  await action("updateNodeSettings", [imported.id, { domain: "changed.nodeguard.example" }]);
  assert.equal((await getImportedDns()).domain, "changed.nodeguard.example");
  assert.equal((await getImportedDns()).v2boardHost, "192.0.2.77");
  assert.equal((await getImportedDns()).lastCheck, "");
  await panelSync();
  await stop();
  const logMigration = new DatabaseSync(join(temp, "monitor.sqlite"));
  try {
    const stored = JSON.parse(logMigration.prepare("SELECT snapshot FROM workspace").get().snapshot);
    stored.logs = [{ id: "legacy-observed-log", ts: new Date(Date.now() - 5000).toISOString(), source: "v2bx-shared",
      severity: "WARNING", message: "legacy migrated message", serverId: "exit-1" }];
    stored.logs.push({ ...stored.logs[0], id: "legacy-iran-v2bx", serverId: "ir-main" });
    logMigration.prepare("UPDATE workspace SET snapshot=?").run(JSON.stringify(stored));
    logMigration.prepare("DELETE FROM workspace_meta WHERE key='monitor_logs_v1'").run();
  } finally {
    logMigration.close();
  }
  await start("ir-main", "monitor", true, true, true);
  assert.equal((await api("logs?source=v2bx-shared&q=legacy+migrated")).data[0].id, "legacy-observed-log");
  assert.equal((await api("logs?source=v2bx&serverId=ir-main")).total, 0);
  assert.deepEqual((await api("workspace")).data.logs, []);
  const sendObservedLogs = (logs) => api("agent/telemetry", { token: receiver, body: {
    ...foreignReport, reportId: randomUUID(), observedAt: new Date().toISOString(), logs,
  } });
  const oneNodeLog = { eventKey: "e".repeat(64), ts: new Date(Date.now() - 1000).toISOString(),
    severity: "INFO", source: "v2bx-node", nodeId: "node-1", message: "V2bX fixture node entry" };
  const delayedLog = { ...oneNodeLog, eventKey: "f".repeat(64), ts: new Date(Date.now() - 2000).toISOString(),
    severity: "ERROR", message: "V2bX delayed node entry" };
  await sendObservedLogs([oneNodeLog]);
  await sendObservedLogs([{ ...oneNodeLog, message: "duplicate journal cursor" }]);
  const frozenLogs = await api("logs?nodeId=node-1&limit=1");
  assert.equal(frozenLogs.total, 1);
  assert.equal(frozenLogs.data[0].message, oneNodeLog.message);
  assert.equal((await api("logs?serverId=exit-1&source=v2bx-shared")).total, 1);
  await api("logs?watermark=-1", { status: 422 });
  const spoofedLog = await api("agent/telemetry", { token: agent, status: 422, body: {
    ...fresh, reportId: randomUUID(), observedAt: new Date(Date.now() + 15000).toISOString(), tunnels: [], logs: [oneNodeLog],
  } });
  assert.equal(spoofedLog.error.code, "LOG_SCOPE");
  assert.equal((await readPanel()).data.nodes.find((item) => item.key === "vless:8").nodeId, imported.id);
  assert.equal((await panelSync()).data.count, 3);
  const persistedImport = (await api("nodes/" + imported.id)).data;
  assert.equal(persistedImport.domain, "changed.nodeguard.example");
  assert.equal(persistedImport.backupTunnelId, backupTunnelId);
  assert.equal((await addHost(inventoryHost)).replay, true);
  assert.equal((await addTunnel(newRoute)).replay, true);
  const persistedRoute = (await api("tunnels/" + encodeURIComponent(backupRoute.id))).data;
  assert.deepEqual(persistedRoute.foreignEndpoint, backupRoute.foreignEndpoint);
  if (process.argv[2] && process.argv[3]) {
    const { chromium } = await import(pathToFileURL(process.argv[2]).href);
    const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
    try {
      const page = await newPersianPage(browser);
      await page.goto(base + "/");
      await page.getByRole("button", { name: /رضا مرادی/ }).click();
      await page.getByRole("button", { name: "ورود به بک‌اند", exact: true }).click();
      await page.locator("#backend-token").fill(admin);
      await page.getByRole("button", { name: "ورود", exact: true }).click();
      await page.getByText("بک‌اند · پایش", { exact: true }).waitFor();
      await page.goto(base + "/integrations");
      await page.getByLabel("آدرس صفحهٔ ادمین").fill(panelLogin.address);
      await page.getByLabel("ایمیل ادمین").fill(panelLogin.email);
      await page.getByLabel("رمز عبور ادمین").fill(panelLogin.password);
      await page.getByRole("button", { name: "اتصال و خواندن نودها", exact: true }).click();
      await page.getByText("3 نود از V2Board خوانده شد", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("رمز عبور ادمین").inputValue(), "");
      await page.goto(base + "/servers/" + sshHost.id);
      const sshCard = page.getByText("نصب NodeGuard Agent روی سرور", { exact: true });
      await sshCard.waitFor();
      for (let attempt = 0; attempt < 3; attempt++) {
        const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/v1/workspace") && response.ok());
        await page.getByRole("button", { name: "تازه‌سازی سنجه", exact: true }).click();
        await refreshed;
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await sshCard.count(), 1, "Workspace refresh must keep exactly one Agent installation card");
      }
      await page.getByText("تنظیمات اتصال SSH", { exact: true }).click();
      await page.getByLabel("روش احراز هویت").click();
      await page.getByRole("option", { name: "کلید خصوصی SSH", exact: true }).click();
      await page.getByLabel("کلید خصوصی SSH", { exact: true }).waitFor();
      await page.goto(base + "/");
      await page.getByText("دسترس‌پذیری مشاهده‌شده", { exact: true }).waitFor();
      await page.getByText(/از \d+ کاوش موفق/).waitFor();
      await page.goto(base + "/health");
      await page.getByText("کاوش‌های مسیر فعال در ۲۴ ساعت اخیر", { exact: true }).waitFor();
      await page.locator(".recharts-area-dot").first().waitFor({ state: "attached" });
      await page.goto(base + "/reports");
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "خروجی CSV" }).click();
      const csv = await readFile(await (await download).path(), "utf8");
      assert.match(csv, /"proxy_success_pct","successful_probes","probe_samples"/);
      assert.match(csv, /"node-1","[^"]+","\d+\.\d{2}","\d+","\d+"/);
      await page.goto(base + "/tunnels/new");
      await page.getByText("استقرار هماهنگ دو سر تونل", { exact: true }).waitFor();
      await page.getByRole("button", { name: "ثبت استقرار دو سمت" }).click();
      await page.getByRole("button", { name: "تأیید عملیات", exact: true }).waitFor();
      await page.getByRole("button", { name: "انصراف", exact: true }).click();
      await page.goto(base + "/nodes");
      await page.getByRole("heading", { name: "همگام‌سازی V2Board" }).waitFor();
      await page.locator('a[href="/nodes/' + imported.id + '"]').first().waitFor();
      const removeV2bx = page.getByRole("button", { name: "حذف پیکربندی V2bX", exact: true });
      await page.getByRole("row", { name: /Mapped V2Board node/ }).getByRole("button", { name: "ویرایش نود" }).waitFor();
      assert.equal(await removeV2bx.count(), 0);
      await page.goto(base + "/servers/exit-1");
      await removeV2bx.click();
      const removalDialog = page.getByRole("dialog", { name: "حذف پیکربندی V2bX" });
      await removalDialog.getByText("نود متصل به این سرور برای حذف پیکربندی پیدا نشد.", { exact: true }).waitFor();
      assert.equal(await removalDialog.locator('option[value="vmess:7"]').count(), 0);
      assert.equal(await removalDialog.locator('option[value="hysteria:9"]').count(), 0);
      await removalDialog.getByRole("button", { name: "انصراف" }).click();
      console.log("PASS: nodes management loads without V2bX removal; foreign server details select a node for removal.");
      await page.goto(base + "/dns");
      await page.getByRole("heading", { name: "مدیریت دامنه‌ها" }).waitFor();
      await page.getByText("رکوردهای دامنه فقط از API کلودفلر و آروان خوانده می‌شوند و در این سامانه ذخیره نمی‌شوند.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("heading", { name: "پایش DNS نودها" }).count(), 0);
      assert.equal(await page.getByPlaceholder("جستجوی دامنه یا نود").count(), 0);
      assert.equal(await page.getByRole("button", { name: "سوییچ نمایشی", exact: true }).count(), 0);
      await page.goto(base + "/servers/ir-main");
      await page.getByRole("heading", { name: "ارتباط Workerهای میزبان" }).waitFor();
      assert.equal(await removeV2bx.count(), 0);
      await page.getByRole("button", { name: "نصب NodeGuard Agent", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "صدور کد ثبت Agent" }).count(), 0);
      await page.getByRole("link", { name: "مشاهده لاگ" }).click();
      await page.waitForURL("**/logs?server=ir-main");
      await page.goto(base + "/tunnels");
      await page.getByRole("button", { name: "ثبت مسیر تونل" }).click();
      const tunnelForm = page.getByRole("dialog", { name: "ثبت مسیر تونل" });
      const nodeSelect = tunnelForm.getByLabel("شناسهٔ تونل (دامنهٔ نود)");
      await nodeSelect.getByRole("option", { name: /hy\.nodeguard\.example/ }).waitFor({ state: "attached" });
      await nodeSelect.selectOption("node:node-1");
      assert.equal(await tunnelForm.getByLabel("MTU").inputValue(), "1400");
      assert.equal(await tunnelForm.getByLabel("IP داخلی مبدأ").getAttribute("readonly"), "");
      assert.equal(await tunnelForm.getByLabel("IP داخلی مقصد").getAttribute("readonly"), "");
      await tunnelForm.getByLabel("فناوری").selectOption("Rathole");
      assert.equal(await tunnelForm.getByLabel("IP داخلی مبدأ").count(), 0);
      await tunnelForm.getByLabel("فناوری").selectOption("GRE");
      await tunnelForm.getByLabel("سرور مبدأ (ایران)").selectOption(inventoryHost.id);
      await tunnelForm.getByLabel("سرور مقصد (خارج)").selectOption("exit-1");
      await tunnelForm.getByRole("button", { name: "ثبت تغییر" }).click();
      await page.waitForURL("**/tunnels/de.nodeguard.example");
      await page.getByRole("heading", { name: "de.nodeguard.example" }).waitFor();
      await page.locator('main a[href="/nodes/node-1"]').waitFor();
      assert.deepEqual((await api("tunnels/de.nodeguard.example")).data.nodeRef, { kind: "inventory", id: "node-1" });
      assert.equal(await page.getByText(/^10\.254\./).count(), 2);
      await page.goto(base + "/tunnels");
      await page.getByRole("button", { name: "ثبت مسیر تونل" }).click();
      await nodeSelect.selectOption("node:node-1");
      await tunnelForm.getByLabel("نقش مسیر").selectOption("backup");
      await tunnelForm.getByLabel("سرور مبدأ (ایران)").selectOption("ir-backup");
      await tunnelForm.getByLabel("سرور مقصد (خارج)").selectOption("exit-1");
      await tunnelForm.getByRole("button", { name: "ثبت تغییر" }).click();
      await page.waitForURL("**/tunnels/de.nodeguard.example%3Abackup");
      await page.getByRole("heading", { name: "de.nodeguard.example" }).waitFor();
      await page.getByText("بکاپ", { exact: true }).waitFor();
      assert.equal((await api("nodes/node-1")).data.primaryTunnelId, "tun-main");
      await page.goto(base + "/nodes/node-1");
      await page.getByRole("tab", { name: "لاگ", exact: true }).click();
      await page.getByText(oneNodeLog.message, { exact: false }).waitFor();
      await page.getByText("legacy migrated message", { exact: false }).waitFor();
      await page.getByRole("link", { name: "باز کردن لاگ نود", exact: true }).click();
      await page.getByText(oneNodeLog.message, { exact: true }).waitFor();
      await page.getByRole("button", { name: "مکث", exact: true }).click();
      await page.getByText("نمای لاگ ثابت است.", { exact: true }).waitFor();
      await sendObservedLogs([delayedLog]);
      assert.equal(await page.getByText(delayedLog.message, { exact: true }).count(), 0);
      await page.getByRole("button", { name: "ادامه", exact: true }).click();
      await page.getByText(delayedLog.message, { exact: true }).waitFor();
      await page.getByLabel("سطح لاگ").selectOption("ERROR");
      await page.getByText(delayedLog.message, { exact: true }).waitFor();
      assert.equal(await page.getByText(oneNodeLog.message, { exact: true }).count(), 0);
      await page.goto(base + "/tunnels/" + newRoute.id);
      const recipeDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "دانلود مشخصات ساخت بسته" }).click();
      const recipeJson = JSON.parse(await readFile(await (await recipeDownload).path(), "utf8"));
      assert.equal(recipeJson.technology, "WireGuard");
      assert.equal(recipeJson.foreign.interfaceName, newRoute.foreignInterfaceName);
      await page.goto(base + "/deployments");
      assert.equal(await page.getByRole("heading", { name: "نصب NodeGuard Agent از راه SSH" }).count(), 0);
      assert.equal(await page.getByText("ابتدا NodeGuard Agent را از جزئیات میزبان نصب کنید.", { exact: false }).count(), 0);
      console.log("PASS: browser availability, CSV, deployment preview, V2Board, DNS, Agent enrollment and inventory registration.");
    } finally {
      await browser.close();
    }
  }
  console.log("PASS: V2Board catalog redaction, topology validation, atomic import, DNS provenance and durable mapping.");
  const adminNodesPath = "providers/v2board/nodes";
  await api(adminNodesPath, { token: readonly, status: 403 });
  const adminNodeFields = { name: "VLESS management canary", host: "canary.example.org", port: "9443-9445",
    group_id: [1], route_id: [2], rate: 1, show: 0, tls: 2, network: "tcp", tls_settings: { server_name: "target.example.org" } };
  const saveAdminNode = (body, options) => api(adminNodesPath, { body, ...options });
  await saveAdminNode({ type: "vless", fields: adminNodeFields });
  const adminInventory = (await api(adminNodesPath)).data;
  assert.deepEqual(adminInventory.routes, [{ id: 2, name: "Canary route" }]);
  const adminNode = adminInventory.nodes.find(({ id }) => id === 10);
  const reality = adminNode.fields.tls_settings;
  assert.equal(adminNode.fields.server_port, "9443");
  assert.equal(reality.server_name, "target.example.org");
  assert.equal(reality.dest, "target.example.org");
  assert.equal(reality.server_port, "443");
  assert.equal(reality.fingerprint, "chrome");
  assert.ok(/^[a-f0-9]{16}$/.test(reality.short_id));
  const privateKey = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "X25519", d: reality.private_key, x: reality.public_key } });
  assert.ok(createPublicKey(privateKey).export({ format: "jwk" }).x === reality.public_key);
  const editAdminNode = { type: "vless", id: adminNode.id, revision: adminNode.revision, fields: { ...adminNode.fields, rate: 2 } };
  await saveAdminNode(editAdminNode);
  await saveAdminNode(editAdminNode, { status: 409 });
  const editedAdminFields = (await api(adminNodesPath)).data.nodes.find(({ id }) => id === 10).fields;
  assert.equal(editedAdminFields.rate, 2);
  assert.ok(editedAdminFields.tls_settings.private_key === reality.private_key &&
    editedAdminFields.tls_settings.public_key === reality.public_key && editedAdminFields.tls_settings.short_id === reality.short_id);
  await saveAdminNode({ type: "hysteria", fields: { name: "Hysteria management canary", host: "hy.example.org",
    port: "7443", group_id: [1], rate: 1, version: 2, insecure: 0, up_mbps: 100, down_mbps: 100, obfs: "salamander" } });
  const hysteria = (await api(adminNodesPath)).data.nodes.find(({ type, id }) => type === "hysteria" && id === 10).fields;
  assert.equal(hysteria.server_port, "7443");
  assert.ok(/^[a-f0-9]{32}$/.test(hysteria.obfs_password));

  if (!process.argv[2] || !process.argv[3]) await sendObservedLogs([delayedLog]);
  const fixed = await api("logs?nodeId=node-1&limit=1&through=" + frozenLogs.snapshot.through + "&watermark=" + frozenLogs.snapshot.watermark);
  assert.equal(fixed.total, 1);
  assert.equal(fixed.data[0].message, oneNodeLog.message);
  const olderPage = await api("logs?nodeId=node-1&limit=1&page=2");
  assert.equal(olderPage.total, 2);
  assert.equal(olderPage.data[0].message, delayedLog.message);
  assert.equal((await api("logs?nodeId=node-1&severity=ERROR&q=DELAYED")).total, 1);
  console.log("PASS: observed log migration, strict host attribution, journal deduplication, stable pause and pagination.");

  const registration = "servers/ir-main/agent";
  const ticket = async (path = registration) => {
    const response = await api(path, { method: "POST", token: infra });
    assert.match(response.data.code, /^[a-f\d]{64}$/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    return response.data.code;
  };
  const redeem = (code, credential, serverId = "ir-main", status = 200) => api("agent/enroll", {
    token: code, status, body: { serverId, credential },
  }).then((response) => response.data);
  const addedTicket = await ticket("servers/" + inventoryHost.id + "/agent");
  const addedToken = randomBytes(32).toString("hex");
  assert.equal((await redeem(addedTicket, addedToken, inventoryHost.id)).enrolled, true);
  const hardware = { cpuCores: 8, ramBytes: 16 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 };
  await api("agent/telemetry", { token: addedToken, body: {
    ...fresh, serverId: inventoryHost.id, reportId: randomUUID(), observedAt: new Date().toISOString(), logs: [],
    hardware, diskIo: { readMiBps: 4.25, writeMiBps: 2.5 },
    tunnels: [{ ...fresh.tunnels[0], tunnelId: newRoute.id, mtu: 1380 }],
  } });
  assert.equal((await api("servers/" + inventoryHost.id)).data.agent.status, "online");
  assert.deepEqual((await api("servers/" + inventoryHost.id)).data.hardware, hardware);
  const hostMetrics = (await api(`metrics?serverId=${inventoryHost.id}&range=1h`)).data.find((point) => point.diskReadMiBps === 4.25);
  assert.equal(hostMetrics?.diskReadMiBps, 4.25);
  assert.equal(hostMetrics?.diskWriteMiBps, 2.5);
  assert.equal((await api("tunnels/" + newRoute.id)).data.mtu, 1380);
  assert.equal((await addTunnel(newRoute)).data.mtu, 1380);
  const bundleRecipe = (await api("tunnels/" + newRoute.id + "/bundle-recipe", { token: infra })).data;
  assert.deepEqual(bundleRecipe, {
    schema: 1, tunnelId: newRoute.id, technology: "WireGuard", mtu: 1420, port: 8443, targetPort: 9443,
    iran: { serverId: inventoryHost.id, interfaceName: "ng-wg55", innerIp: "10.55.8.1", outerIp: "192.0.2.55" },
    foreign: { serverId: "exit-1", interfaceName: "ng-wg-out55", innerIp: "10.55.8.2", outerIp: "198.51.100.10" },
  });
  const inventoryAudit = (await api("audit")).data.filter((item) => item.action === "servers.register" && item.target === inventoryHost.id);
  assert.equal(inventoryAudit.length, 1);
  console.log("PASS: validated server and tunnel inventory, concurrent replay, V2Board binding, Agent telemetry and restart persistence.");

  await api(registration, { token: readonly, status: 403 });
  await api(registration, { method: "POST", token: readonly, status: 403 });
  await api(registration, { method: "DELETE", token: readonly, status: 403 });
  assert.equal((await api(registration)).data.source, "environment");
  const previousTicket = await ticket();
  const replacement = await ticket();
  await redeem(previousTicket, randomBytes(32).toString("hex"), "ir-main", 401);
  await redeem(replacement, randomBytes(32).toString("hex"), "ir-backup", 401);
  await redeem(replacement, agent, "ir-main", 409);
  assert.deepEqual(Object.keys((await api(registration)).data).sort(), ["invitationExpiresAt", "source", "state"]);
  const registrationDb = new DatabaseSync(join(temp, "monitor.sqlite"));
  try {
    registrationDb.prepare("UPDATE agent_invitations SET expires_at = ? WHERE server_id = 'ir-main'").run(Date.now() - 1);
  } finally {
    registrationDb.close();
  }
  await redeem(replacement, randomBytes(32).toString("hex"), "ir-main", 401);

  const bootstrapCode = await ticket();
  await writeFile(registrationConfig, JSON.stringify({
    endpoint: base + "/api/v1/agent/telemetry", serverId: "ir-main", tokenFile: registrationToken,
  }));
  const python = process.env.NODEGUARD_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const installerPath = registration + "/installer";
  await api(installerPath, { token: null, status: 401 });
  await api(installerPath, { token: readonly, status: 403 });
  await api("servers/nonexistent/agent/installer", { status: 404 });
  const installer = await fetch(base + "/api/v1/" + installerPath, { headers: { Authorization: "Bearer " + admin } });
  assert.equal(installer.status, 200);
  assert.equal(installer.headers.get("cache-control"), "no-store");
  assert.match(installer.headers.get("content-disposition"), /nodeguard-agent-install\.py/);
  const script = await installer.text();
  assert.ok(!script.includes(bootstrapCode) && !script.includes(agent));
  await writeFile(downloadedInstaller, script);
  const { stdout: preview } = await promisify(execFile)(python, ["-I", downloadedInstaller, "--check", "--interface", "ens3"], { windowsHide: true });
  const installation = JSON.parse(preview);
  assert.equal(installation.config.serverId, "ir-main");
  assert.equal(installation.config.endpoint, base + "/api/v1/agent/telemetry");
  assert.equal(installation.config.tokenFile, "/etc/nodeguard/agent.token");
  assert.equal(installation.config.interface, "ens3");
  assert.ok(installation.config.tunnels.some(({ id, interface: name }) => id === "tun-main" && name === "gre1"));
  assert.deepEqual(installation.services, ["nodeguard-agent.service"]);
  assert.deepEqual(installation.config.iperfTargets, [{
    tunnelId: "tun-main", receiverServerId: "exit-1", sourceIp: "10.20.0.1", peerIp: "10.20.0.2", port: 5201,
  }]);
  for (const name of ["nodeguard-agent.service", "nodeguard-iperf.service", "nodeguard-provision.service"]) {
    assert.match(installation.sha256[name], /^[a-f\d]{64}$/);
  }
  const { stdout: withWorkers } = await promisify(execFile)(python, [
    "-I", downloadedInstaller, "--check", "--with-iperf", "--with-provision",
  ], { windowsHide: true });
  assert.deepEqual(JSON.parse(withWorkers).services, ["nodeguard-agent.service", "nodeguard-iperf.service", "nodeguard-provision.service"]);
  const installerForReceiver = await fetch(base + "/api/v1/servers/exit-1/agent/installer", {
    headers: { Authorization: "Bearer " + admin },
  });
  assert.equal(installerForReceiver.status, 200);
  await writeFile(downloadedInstaller, await installerForReceiver.text());
  const { stdout: receiverPlan } = await promisify(execFile)(python, [
    "-I", downloadedInstaller, "--check", "--sync-iperf-receivers",
  ], { windowsHide: true });
  const receiverPreview = JSON.parse(receiverPlan);
  assert.deepEqual(receiverPreview.config.iperfTargets, []);
  assert.deepEqual(receiverPreview.config.iperfReceivers, [{
    tunnelId: "tun-main", sourceServerId: "ir-main", sourceIp: "10.20.0.1", bindIp: "10.20.0.2", port: 5201,
  }]);
  assert.equal(receiverPreview.services.length, 2);
  assert.match(receiverPreview.services[1], /^nodeguard-iperf-rx-[a-f0-9]{24}\.service$/);
  assert.match(receiverPreview.sha256[receiverPreview.services[1]], /^[a-f0-9]{64}$/);
  const enroll = spawn(python, ["-B", "agent/nodeguard_enroll.py", registrationConfig, "--stdin-code"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let enrollmentOutput = "";
  for (const stream of [enroll.stdout, enroll.stderr]) stream.on("data", (chunk) => { enrollmentOutput += chunk; });
  const enrollExit = new Promise((resolve, reject) => enroll.once("error", reject).once("close", resolve));
  enroll.stdin.end(bootstrapCode + "\n");
  assert.equal(await enrollExit, 0, enrollmentOutput);
  const enrolledToken = (await readFile(registrationToken, "utf8")).trim();
  assert.match(enrolledToken, /^[a-f\d]{64}$/);
  assert.ok(!enrollmentOutput.includes(enrolledToken) && !enrollmentOutput.includes(bootstrapCode));
  assert.deepEqual(await redeem(bootstrapCode, enrolledToken), { enrolled: true, replay: true });
  await redeem(bootstrapCode, randomBytes(32).toString("hex"), "ir-main", 401);
  assert.equal((await api(registration)).data.source, "managed");
  assert.equal((await api("servers/ir-main")).data.agent.status, "offline");
  await api("workspace", { token: enrolledToken, status: 401 });
  const enrolledReport = { ...fresh, reportId: randomUUID(), observedAt: new Date(Date.now() + 5000).toISOString(), tunnels: [], logs: [] };
  await api("agent/telemetry", { body: enrolledReport, token: agent, status: 401 });
  await api("agent/telemetry", { body: { ...enrolledReport, serverId: "ir-backup" }, token: enrolledToken, status: 401 });
  await api("agent/telemetry", { body: enrolledReport, token: enrolledToken });
  assert.equal((await api("servers/ir-main")).data.agent.status, "online");
  assert.equal((await agentWorker("iperf")).status, "unseen");
  await claim("ir-main", enrolledToken);
  await claimProvision("ir-main", enrolledToken);
  assert.equal((await agentWorker("iperf")).status, "recent");
  assert.equal((await agentWorker("provision")).status, "recent");
  const pollsDb = new DatabaseSync(join(temp, "monitor.sqlite"));
  try {
    pollsDb.prepare("UPDATE agent_worker_polls SET last_seen=? WHERE server_id=? AND kind=?")
      .run(Date.now() - 46000, "ir-main", "provision");
  } finally {
    pollsDb.close();
  }
  assert.equal((await agentWorker("provision")).status, "stale");

  const rotation = await ticket();
  const contenders = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  const rotations = await Promise.all(contenders.map((credential) => fetch(base + "/api/v1/agent/enroll", {
    method: "POST", headers: { Authorization: "Bearer " + rotation, "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: "ir-main", credential }),
  })));
  assert.deepEqual(rotations.map((response) => response.status).sort(), [200, 401]);
  const winner = contenders[rotations.findIndex((response) => response.status === 200)];
  assert.equal((await agentWorker("iperf")).status, "unseen");
  assert.equal((await agentWorker("provision")).status, "unseen");
  const bodyAfterRotation = { ...enrolledReport, reportId: randomUUID(), observedAt: new Date(Date.parse(enrolledReport.observedAt) + 1000).toISOString() };
  await api("agent/telemetry", { body: bodyAfterRotation, token: enrolledToken, status: 401 });
  await stop();
  await start("ir-main", "monitor", true, true, true);
  await api("agent/telemetry", { body: bodyAfterRotation, token: winner });
  assert.equal((await api(registration, { method: "DELETE" })).data.state, "revoked");
  await api("agent/telemetry", { body: bodyAfterRotation, token: winner, status: 401 });
  await api("agent/telemetry", { body: bodyAfterRotation, token: agent, status: 401 });
  await claim("ir-main", winner, 401);
  await claimProvision("ir-main", winner, 401);
  assert.equal((await api("servers/ir-main")).data.agent.status, "offline");
  const audits = (await api("audit")).data.filter((entry) => entry.target === "ir-main" && entry.action.startsWith("agent."));
  assert.ok(audits.some((entry) => entry.action === "agent.enroll") && audits.some((entry) => entry.action === "agent.revoke"));
  assert.ok(!JSON.stringify(audits).includes(bootstrapCode) && !JSON.stringify(audits).includes(winner));
  console.log("PASS: Agent enrollment CLI, scoped one-time tickets, RBAC, race-safe rotation, restart persistence and revocation.");

  const profileIn = { id: "gost-ir-a", serverId: "ir-backup", component: "GOST", version: "v3.fixture",
    sha256: "1".repeat(64), summary: "Iran bundle fixture" };
  const profileOut = { ...profileIn, id: "gost-out-a", serverId: "exit-1", sha256: "2".repeat(64), summary: "Foreign bundle fixture" };
  const makeEnrollment = (iran, foreign) => ({
    NODEGUARD_PROVISION_PROFILES: [iran, foreign],
    NODEGUARD_TUNNEL_PROFILES: [{ tunnelId: forwardSpec.id, iranProfileId: iran.id, foreignProfileId: foreign.id }],
  });
  const upload = makeEnrollment(profileIn, profileOut);
  const previewCatalog = (body, options = {}) => api("provision/catalog/preview", { body, ...options }).then((result) => result.data);
  const saveCatalog = (enrollment, fingerprint, options = {}) =>
    api("provision/catalog/import", { body: { enrollment, fingerprint }, ...options }).then((result) => result.data);
  const linkProfile = { ...profileIn, component: newRoute.technology, serverId: newRoute.iranServerId, id: "wg-forward-test" };
  const peerProfile = { ...profileOut, component: newRoute.technology, id: "wg-peer-test" };
  const linkEnrollment = {
    NODEGUARD_PROVISION_PROFILES: [linkProfile, peerProfile],
    NODEGUARD_TUNNEL_PROFILES: [{ tunnelId: newRoute.id, iranProfileId: linkProfile.id, foreignProfileId: peerProfile.id }],
  };
  await previewCatalog(linkEnrollment, { status: 422 });
  const forwardedLink = await previewCatalog({ ...linkEnrollment,
    NODEGUARD_PROVISION_PROFILES: [{ ...linkProfile, forwardPort: 8443, forwardTargetPort: 9443 }, peerProfile],
  });
  assert.equal(forwardedLink.profiles[0].forwardPort, 8443);
  assert.equal(forwardedLink.profiles[0].forwardTargetPort, 9443);
  await previewCatalog(upload, { token: readonly, status: 403 });
  await previewCatalog(upload, { headers: { Origin: "https://different.invalid" }, status: 403 });
  await previewCatalog({ ...upload, configContents: "must not be stored" }, { status: 422 });
  await previewCatalog(makeEnrollment({ ...profileIn, serverId: "missing" }, profileOut), { status: 422 });
  await previewCatalog(makeEnrollment({ ...profileIn, component: "Rathole" }, profileOut), { status: 422 });
  for (const id of ["agent", "iperf", "provision", "iperf-rx-" + "f".repeat(24)]) {
    await previewCatalog({ NODEGUARD_PROVISION_PROFILES: [{ ...profileIn, id }] }, { status: 422 });
  }
  await previewCatalog(makeEnrollment({ ...profileIn, serverId: "exit-1" }, profileOut), { status: 422 });
  const registeredCount = (await api("provision/jobs")).data.jobs.length;
  const draft = await previewCatalog(upload, { token: infra });
  assert.equal(draft.addedProfiles, 2);
  assert.equal(draft.updatedTunnels, 1);
  assert.equal(draft.profiles[0].sha256, profileIn.sha256);
  assert.equal((await pairList()).previews.some((item) => item.tunnelId === forwardSpec.id), false);
  await saveCatalog(upload, "0".repeat(64), { status: 409 });
  const race = await Promise.all([saveCatalog(upload, draft.fingerprint), saveCatalog(upload, draft.fingerprint)]);
  assert.deepEqual(race.map((item) => item.replay).sort(), [false, true]);
  assert.equal((await api("provision/jobs")).data.jobs.length, registeredCount);
  await previewCatalog(makeEnrollment({ ...profileIn, sha256: "f".repeat(64) }, profileOut), { status: 409 });

  const versionA = { ...profileIn, id: "gost-ir-b", sha256: "3".repeat(64) };
  const versionB = { ...profileIn, id: "gost-ir-c", sha256: "4".repeat(64) };
  const uploadA = makeEnrollment(versionA, profileOut);
  const uploadB = makeEnrollment(versionB, profileOut);
  const oldPair = (await pairList()).previews.find((item) => item.tunnelId === forwardSpec.id);
  const [draftA, draftB] = await Promise.all([previewCatalog(uploadA), previewCatalog(uploadB)]);
  assert.equal(draftA.tunnels[0].previous.iranProfileId, profileIn.id);
  assert.equal((await saveCatalog(uploadA, draftA.fingerprint)).updatedTunnels, 1);
  await saveCatalog(uploadB, draftB.fingerprint, { status: 409 });
  assert.ok(!(await api("provision/jobs")).data.profiles.some((item) => item.id === versionB.id));
  await pair({ tunnelId: forwardSpec.id, fingerprint: oldPair.fingerprint }, { status: 409 });

  await stop();
  await start("ir-main", "monitor", true, true, true);
  const catalogPair = (await pairList()).previews.find((item) => item.tunnelId === forwardSpec.id);
  assert.equal(catalogPair.iran.sha256, versionA.sha256);
  assert.equal(catalogPair.foreign.sha256, profileOut.sha256);
  for (const [serverId, token] of [["ir-backup", backupAgent], ["exit-1", receiver]]) {
    await api("agent/telemetry", { token, body: { ...fresh, serverId, reportId: randomUUID(),
      observedAt: new Date(Date.now() + 10000).toISOString(), tunnels: [], logs: [],
    } });
  }
  const deployment = (await pair({ tunnelId: forwardSpec.id, fingerprint: catalogPair.fingerprint })).data.deployment;
  assert.equal(deployment.phase, "foreign_apply");
  await previewCatalog(uploadB, { status: 409 });
  const claimedProfile = (await claimProvision("exit-1", receiver)).data;
  assert.equal(claimedProfile.profile.sha256, profileOut.sha256);
  await finishSide(claimedProfile, "failed", "preflight", receiver);
  assert.equal((await pairedStatus(deployment.id)).status, "failed");
  for (const [profile, token] of [[catalogPair.foreign, receiver], [catalogPair.iran, backupAgent]]) {
    const { data } = await provision({ operation: "apply", serverId: profile.serverId, profileId: profile.id, sha256: profile.sha256 });
    const { data: job } = await claimProvision(profile.serverId, token, 200, true);
    assert.equal(job.id, data.job.id);
    await finishSide(job, "succeeded", "applied", token);
  }
  const inactiveDestroy = (await pair({ tunnelId: forwardSpec.id, operation: "destroy" })).data.deployment;
  for (const [serverId, token] of [["ir-backup", backupAgent], ["exit-1", receiver]]) {
    const { data: removal } = await claimProvision(serverId, token, 200, true);
    assert.equal(removal.operation, "remove");
    await finishSide(removal, "succeeded", "removed", token);
  }
  assert.equal((await pairedStatus(inactiveDestroy.id)).status, "destroyed");
  console.log("PASS: previewed catalog import, immutable pins, atomic remapping, restart persistence and coordinated job claim.");

  {
    await stop();
    await writeFile(pathOfState, JSON.stringify({ ...initialProviderState, dropNext: false }));
    const startAutomatic = (autoFailover = true) => start("ir-main", "monitor", false, true, false, false, { dbPath: autoDbPath, autoFailover });
    await startAutomatic();
    const autoPolicy = (patch) => action("updatePolicy", ["node-1", patch]);
    await autoPolicy({
      intervalSec: 5, failureThreshold: 2, minConfirmations: 2,
      autoEnabled: true, autoFailback: true, manualApproval: true, stabilitySec: 5, cooldownSec: 0,
    });
    for (const [token, report] of [[agent, fresh], [backupAgent, backupReport], [receiver, { ...foreignReport, v2bx: "running" }]]) {
      await api("agent/telemetry", { token, body: { ...report, reportId: randomUUID(), observedAt: future(0) } });
    }
    const autoDb = (query, ...args) => {
      const connection = new DatabaseSync(autoDbPath);
      try { return connection.prepare(query).run(...args); }
      finally { connection.close(); }
    };
    const observers = [["observer-1", observer], ["observer-2", observerTwo]];
    const evidence = async (at, primary, backup) => {
      for (const [serverId, token] of observers) {
        await api("agent/telemetry", { token, body: {
          ...fresh, serverId, reportId: randomUUID(), observedAt: at, tunnels: [], logs: [],
          proxyProbes: [{ nodeId: "node-1", side: "primary", ok: primary, elapsedMs: 45 },
            { nodeId: "node-1", side: "backup", ok: backup, elapsedMs: 48 }],
        } });
      }
    };
    const resetEvidence = () => autoDb("DELETE FROM agent_reports WHERE server_id IN ('observer-1','observer-2')");
    const failedSource = async () => {
      resetEvidence();
      await evidence(future(-7000), false, true);
      await evidence(future(-1000), false, true);
    };
    const plansForAuto = async () => (await api("failover/plans")).data.filter((item) => item.automatic);
    const settleAuto = (id) => autoDb("UPDATE failover_executions SET verify_after=?, verify_until=? WHERE plan_id=?",
      Date.now() - 1, Date.now() + 60000, id);
    const reportActive = async () => {
      for (const [serverId, token] of observers) {
        await api("agent/telemetry", { token, body: { ...fresh, serverId, reportId: randomUUID(), observedAt: future(0), tunnels: [], logs: [],
          proxyProbes: [{ nodeId: "node-1", side: "active", ok: true, elapsedMs: 50 }],
        } });
      }
    };

    await evidence(future(-7000), false, true);
    assert.equal((await workerTick()).data.prepared, 0);
    await evidence(future(-1000), false, true);
    const decisions = await Promise.all([workerTick(), workerTick()]);
    assert.equal(decisions.reduce((sum, item) => sum + item.data.prepared, 0), 1);
    const held = (await plansForAuto())[0];
    assert.equal(held.status, "awaiting_approval");
    assert.equal(held.execution, undefined);
    assert.equal((await providerState()).writes, 0);
    await decide(held, "approve", infra, 403);
    assert.equal((await decide(held, "reject", admin)).data.status, "rejected");
    assert.equal((await workerTick()).data.prepared, 0);
    autoDb("UPDATE failover_plans SET decided_at=? WHERE id=?", Date.now() - 121000, held.id);
    assert.equal((await workerTick()).data.prepared, 1);
    const recovered = (await plansForAuto()).find((item) => item.status === "awaiting_approval");
    await evidence(future(0), true, true);
    assert.equal((await decide(recovered, "approve", admin)).data.status, "stale");

    await autoPolicy({ manualApproval: false });
    await failedSource();
    assert.equal((await workerTick()).data.prepared, 1);
    const beforeWrite = (await plansForAuto()).find((item) => item.execution?.status === "applying");
    await evidence(future(0), true, true);
    await workerTick();
    assert.equal((await findPlan(beforeWrite)).execution.status, "aborted");
    assert.equal((await providerState()).writes, 0);

    await failedSource();
    await workerTick();
    const disabledPlan = (await plansForAuto()).find((item) => item.execution?.status === "applying");
    await stop();
    await startAutomatic(false);
    await workerTick();
    assert.equal((await findPlan(disabledPlan)).execution.status, "aborted");
    assert.equal((await providerState()).writes, 0);
    await stop();
    await startAutomatic();

    await failedSource();
    await workerTick();
    const automaticSwitch = (await plansForAuto()).find((item) => item.execution?.status === "applying");
    assert.equal(autoDb("DELETE FROM failover_executions WHERE plan_id=? AND attempted_at IS NULL", automaticSwitch.id).changes, 1);
    await stop();
    await startAutomatic();
    assert.equal((await workerTick()).data.resumed, 1);
    assert.equal((await providerState()).writes, 0);
    await workerTick();
    assert.equal((await findPlan(automaticSwitch)).execution.status, "verifying");
    assert.equal((await providerState()).record.content, "192.0.2.11");
    assert.equal((await api("nodes/node-1")).data.activeSide, "primary");
    settleAuto(automaticSwitch.id);
    await reportActive();
    await workerTick();
    assert.equal((await findPlan(automaticSwitch)).execution.status, "succeeded");
    assert.equal((await api("nodes/node-1")).data.activeSide, "backup");

    resetEvidence();
    await evidence(future(-7000), true, true);
    await evidence(future(-1000), true, true);
    assert.equal((await workerTick()).data.prepared, 0);
    await evidence(future(0), true, true);
    assert.equal((await workerTick()).data.prepared, 0);
    await delay(5200);
    await evidence(future(0), true, true);
    assert.equal((await workerTick()).data.prepared, 1);
    const automaticReturn = (await plansForAuto()).find((item) => item.target === "primary" && item.execution?.status === "applying");
    await workerTick();
    assert.equal((await findPlan(automaticReturn)).execution.status, "verifying");
    assert.equal((await providerState()).record.content, "192.0.2.10");
    settleAuto(automaticReturn.id);
    await reportActive();
    await workerTick();
    assert.equal((await findPlan(automaticReturn)).execution.status, "succeeded");
    assert.equal((await api("nodes/node-1")).data.activeSide, "primary");
    assert.equal((await providerState()).writes, 2);
    console.log("PASS: automatic failure quorum, rejection cooldown, evidence recovery and disabled-worker guards, restart recovery, failover and failback.");
  }

  {
    await stop();
    await writeFile(pathOfState, JSON.stringify({ ...initialProviderState, dropNext: false }));
    const startStandby = () => start("ir-main", "monitor", false, true, true, false, {
      dbPath: standbyDb, autoFailover: true, autoStandby: true,
    });
    await startStandby();
    await panelSync();
    await action("updatePolicy", ["node-1", {
      intervalSec: 5, failureThreshold: 2, minConfirmations: 2,
      autoEnabled: true, manualApproval: true, cooldownSec: 0,
    }]);
    for (const [token, report] of [[agent, fresh], [backupAgent, { ...backupReport, tunnels: [] }], [receiver, { ...foreignReport, v2bx: "running" }]]) {
      await api("agent/telemetry", { token, body: { ...report, reportId: randomUUID(), observedAt: future(0) } });
    }
    const peers = [["observer-1", observer], ["observer-2", observerTwo]];
    const evidence = async (at, primary, backup) => {
      for (const [serverId, token] of peers) {
        await api("agent/telemetry", { token, body: {
          ...fresh, serverId, reportId: randomUUID(), observedAt: new Date(at).toISOString(), tunnels: [], logs: [],
          proxyProbes: [
            { nodeId: "node-1", side: "primary", ok: primary, elapsedMs: 44 },
            { nodeId: "node-1", side: "backup", ok: backup, elapsedMs: 48 },
          ],
        } });
      }
    };
    const firstSample = Date.now() - 10000;
    await evidence(firstSample, false, false);
    await evidence(firstSample + 4800, false, false);
    assert.equal((await workerTick()).data.standbyStarted, 0);
    assert.equal((await pairList()).deployments.length, 0);

    await provision({ operation: "apply", serverId: "exit-1", profileId: "wg-standby-out", sha256: "b".repeat(64) });
    const staged = (await claimProvision("exit-1", receiver)).data;
    await finishSide(staged, "succeeded", "applied", receiver);
    const triggers = await Promise.all([workerTick(), workerTick()]);
    assert.equal(triggers.reduce((sum, tick) => sum + tick.data.standbyStarted, 0), 1);
    const [firstRepair] = (await pairList()).deployments;
    assert.equal(firstRepair.standbyNodeId, "node-1");
    assert.equal(firstRepair.phase, "iran_apply");
    assert.equal((await claimProvision("exit-1", receiver)).data, null);

    await stop();
    await startStandby();
    assert.equal((await workerTick()).data.standbyStarted, 0);
    const firstJob = (await claimProvision("ir-backup", backupAgent)).data;
    assert.equal(firstJob.profile.id, "wg-standby-in");
    await finishSide(firstJob, "succeeded", "applied", backupAgent);
    assert.equal((await pairedStatus(firstRepair.id)).status, "verifying");
    const standbySql = (sql, ...args) => {
      const connection = new DatabaseSync(standbyDb);
      try { return connection.prepare(sql).run(...args); }
      finally { connection.close(); }
    };
    standbySql("UPDATE tunnel_deployments SET verify_until=? WHERE id=?", Date.now() - 1, firstRepair.id);
    await workerTick();
    const compensation = (await claimProvision("ir-backup", backupAgent)).data;
    assert.equal(compensation.rollbackOf, firstJob.id);
    await finishSide(compensation, "succeeded", "restored", backupAgent);
    assert.equal((await pairedStatus(firstRepair.id)).status, "rolled_back");
    assert.equal((await claimProvision("exit-1", receiver)).data, null);
    assert.equal((await workerTick()).data.standbyStarted, 0);

    await evidence(firstSample + 4850, true, false);
    assert.equal((await workerTick()).data.standbyStarted, 0);
    await evidence(firstSample + 4900, false, false);
    await evidence(firstSample + 9800, false, false);
    assert.equal((await workerTick()).data.standbyStarted, 1);
    const [secondRepair] = (await pairList()).deployments;
    assert.notEqual(secondRepair.id, firstRepair.id);
    const secondJob = (await claimProvision("ir-backup", backupAgent)).data;
    const clockAhead = Date.now() + 1500;
    await evidence(clockAhead, false, true);
    await delay(8);
    await finishSide(secondJob, "succeeded", "applied", backupAgent);
    await delay(8);
    const sampledAt = future(0);
    await api("agent/telemetry", { token: backupAgent, body: {
      ...backupReport, reportId: randomUUID(), observedAt: sampledAt,
      tunnels: [{ ...backupReport.tunnels[0], measuredAt: sampledAt }],
    } });
    await workerTick();
    assert.equal((await pairedStatus(secondRepair.id)).status, "succeeded");
    assert.equal((await getPreflight()).data.targetConfirmations, 0);
    assert.equal((await api("failover/plans")).data.length, 0);
    assert.equal((await providerState()).writes, 0);
    await evidence(Math.max(Date.now(), clockAhead + 1), false, true);
    assert.equal((await workerTick()).data.prepared, 1);
    const [plan] = (await api("failover/plans")).data;
    assert.equal(plan.status, "awaiting_approval");
    assert.equal(plan.execution, undefined);
    assert.equal((await providerState()).writes, 0);
    assert.equal((await decide(plan, "approve", admin)).data.status, "approved");
    await failoverCall(plan, "execute");
    await workerTick();
    assert.equal((await findPlan(plan)).execution.status, "verifying");
    assert.equal((await providerState()).writes, 1);
    console.log("PASS: opted-in standby installation, durable deduplication, Iran-only compensation, fresh evidence and manual DNS approval.");
  }

  await stop();
  {
    const startPanelMonitor = () => start("ir-main", "monitor", false, true, true, false, { dbPath: panelDb, panelMonitor: true });
    const panelSql = (query, ...args) => {
      const connection = new DatabaseSync(panelDb);
      try { return connection.prepare(query).run(...args); }
      finally { connection.close(); }
    };
    const ageCatalog = () => panelSql("UPDATE provider_cache SET payload=json_set(payload,'$.syncedAt',?) WHERE provider='v2board'",
      new Date(Date.now() - 360000).toISOString());
    const fixtureState = () => readFile(panelStatePath, "utf8").then(JSON.parse);
    const fixturePatch = async (patch) => writeFile(panelStatePath, JSON.stringify({ ...await fixtureState(), ...patch }));
    const tickPanel = (options = {}) => api("providers/v2board/worker/tick", {
      method: "POST", token: panelWorker, ...options,
    }).then((result) => result.data);
    await writeFile(panelStatePath, JSON.stringify({ delayMs: 900, requests: 0 }));
    await startPanelMonitor();
    await tickPanel({ token: dnsWorker, status: 401 });
    await api("workspace", { token: panelWorker, status: 401 });
    await api("providers/v2board/sync", { method: "POST", token: panelWorker, status: 401 });
    assert.equal((await getPreflight()).data.checks.find(({ code }) => code === "panel").ok, false);

    const firstSync = tickPanel();
    for (let attempt = 0; (await fixtureState()).requests === 0 && attempt < 50; attempt += 1) await delay(10);
    assert.equal((await readPanel()).data.inProgress, true);
    await api("providers/v2board/sync", { method: "POST", status: 409 });
    assert.equal((await tickPanel()).synced, false);
    assert.equal((await firstSync).synced, true);
    assert.equal((await fixtureState()).requests, 1);
    assert.equal((await readPanel()).data.intervalSec, 300);
    assert.equal((await readPanel()).data.nodes.length, 3);
    assert.equal((await getPreflight()).data.checks.find(({ code }) => code === "panel").ok, true);
    assert.ok((await api("audit")).data.some((item) => item.action === "v2board.read" && item.role === "system"));
    panelSql("UPDATE workspace SET snapshot=json_set(snapshot,'$.dns[0].v2boardObservedAt',?)",
      new Date(Date.now() - 901000).toISOString());
    assert.equal((await getPreflight()).data.checks.find(({ code }) => code === "panel").ok, false);

    ageCatalog();
    await fixturePatch({ delayMs: 0, failure: true });
    assert.deepEqual(await tickPanel(), { synced: false, errors: 1 });
    const cached = (await readPanel()).data;
    assert.equal(cached.lastError, "UPSTREAM");
    assert.equal(cached.nodes.length, 3);
    assert.equal((await api("integrations")).data.find((item) => item.type === "v2board").status, "degraded");
    if (process.argv[2] && process.argv[3]) {
      const { chromium } = await import(pathToFileURL(process.argv[2]).href);
      const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
      try {
        const page = await newPersianPage(browser);
        assert.equal((await page.request.post(base + "/api/v1/session", { data: { userId: "usr-reza", token: admin } })).status(), 200);
        await page.goto(base + "/nodes");
        await page.getByText(/همگام‌سازی دوره‌ای هر 300 ثانیه/).waitFor();
        await page.getByText(/دادهٔ آخرین دریافت موفق نمایش داده می‌شود/).waitFor();
        await page.getByText("New inventory node", { exact: true }).waitFor();
      } finally {
        await browser.close();
      }
    }
    const requestsBeforeRestart = (await fixtureState()).requests;
    await stop();
    await startPanelMonitor();
    assert.equal((await tickPanel()).synced, false);
    assert.equal((await fixtureState()).requests, requestsBeforeRestart);

    await fixturePatch({ failure: false, omit: 7 });
    panelSql("UPDATE v2board_sync SET attempted_at=?,lease=?,lease_until=? WHERE singleton=1", Date.now() - 61000,
      "expired-worker-lease", Date.now() - 1000);
    assert.equal((await tickPanel()).synced, true);
    assert.equal((await readPanel()).data.lastError, null);
    assert.equal((await readPanel()).data.nodes.length, 2);
    assert.equal((await api("dns/dns-node-1")).data.v2boardMissing, true);
    assert.equal((await getPreflight()).data.checks.find(({ code }) => code === "panel").ok, false);

    await fixturePatch({ omit: null });
    await panelSync();
    assert.equal((await api("dns/dns-node-1")).data.v2boardMissing, undefined);
    assert.equal((await getPreflight()).data.checks.find(({ code }) => code === "panel").ok, true);
    ageCatalog();
    const { stdout: scheduledCli } = await promisify(execFile)(process.execPath, ["agent/failover_worker.mjs", "--v2board", "--once"], {
      env: { ...process.env, NODEGUARD_CONTROL_URL: base, NODEGUARD_V2BOARD_WORKER_TOKEN: panelWorker },
      windowsHide: true,
    });
    assert.match(scheduledCli, /synced: true/);
    await api("staging/readiness?nodeId=node-1", { token: null, status: 401 });
    await api("staging/readiness?nodeId=unknown", { token: readonly, status: 404 });
    await api("staging/readiness?nodeId=node-1&since=invalid", { token: readonly, status: 422 });
    const staging = () => api("staging/readiness?nodeId=node-1", { token: readonly }).then((result) => result.data);
    assert.equal((await staging()).ready, false);
    const sampleAt = future(0);
    await api("agent/telemetry", { token: agent, body: { ...fresh, reportId: randomUUID(), observedAt: sampleAt } });
    await api("agent/telemetry", { token: backupAgent, body: { ...backupReport, reportId: randomUUID(), observedAt: sampleAt } });
    await api("agent/telemetry", { token: receiver, body: {
      ...foreignReport, reportId: randomUUID(), observedAt: sampleAt, v2bx: "running",
      logs: [
        { ts: sampleAt, severity: "INFO", source: "v2bx-shared", message: "staging shared secret marker" },
        { ts: sampleAt, severity: "INFO", source: "v2bx-node", nodeId: "node-1", message: "staging node secret marker" },
      ],
    } });
    for (const [serverId, token] of [["observer-1", observer], ["observer-2", observerTwo]]) {
      await api("agent/telemetry", { token, body: {
        ...fresh, serverId, reportId: randomUUID(), observedAt: future(0), tunnels: [],
        proxyProbes: [{ nodeId: "node-1", side: "active", ok: true, elapsedMs: 40 },
          { nodeId: "node-1", side: "backup", ok: true, elapsedMs: 45 }],
      } });
    }
    await writeFile(pathOfState, JSON.stringify({ ...initialProviderState, dropNext: false }));
    await observeDns();
    const baseline = await staging();
    assert.equal(baseline.ready, true, JSON.stringify(baseline));
    assert.ok(!JSON.stringify(baseline).includes("secret marker"));

    const beforeRead = (await api("workspace", { token: readonly })).revision;
    const { stdout: stagingCli } = await promisify(execFile)(process.execPath, ["agent/staging_check.mjs", "--node", "node-1"], {
      env: { ...process.env, NODEGUARD_CONTROL_URL: base, NODEGUARD_STAGING_TOKEN: readonly },
      windowsHide: true,
    });
    assert.equal(JSON.parse(stagingCli).ready, true);
    assert.equal((await api("workspace", { token: readonly })).revision, beforeRead);
    await assert.rejects(promisify(execFile)(process.execPath, ["agent/staging_check.mjs", "--node", "node-1", "--since", evidenceSince], {
      env: { ...process.env, NODEGUARD_CONTROL_URL: base, NODEGUARD_STAGING_TOKEN: readonly },
      windowsHide: true,
    }), (error) => error.code === 1 && JSON.parse(error.stdout).evidence.complete === false);
    console.log("PASS: authenticated read-only staging CLI, fresh canary checks, bounded receipts and redacted output.");
    console.log("PASS: scheduled V2Board reads, scoped auth, shared lease, durable backoff, last good catalog and missing-binding guard.");
    await stop();
  }

  const startHeartbeat = () => start("ir-main", "monitor", false, false, false, false, {
    dbPath: heartbeatDb, healthMonitor: true,
  });
  await startHeartbeat();
  const healthTick = (token = healthWorker, status = 200) => api("health/worker/tick", { method: "POST", token, status });
  await healthTick(admin, 401);
  await healthTick(dnsWorker, 401);
  await api("workspace", { token: healthWorker, status: 401 });
  const heartbeatIncidents = () => api("incidents").then((result) => result.data.filter((item) => item.category === "agent-disconnected"));
  assert.equal((await healthTick()).data.opened, 0);
  const staleHeartbeat = Date.now() - 120000;
  const heartbeat = (serverId, token, at) => api("agent/telemetry", { token, body: {
    ...fresh, serverId, reportId: randomUUID(), observedAt: new Date(at).toISOString(), tunnels: [],
  } });
  await heartbeat("ir-main", agent, staleHeartbeat);
  await heartbeat("exit-1", receiver, Date.now());
  const ticks = await Promise.all([healthTick(), healthTick()]);
  assert.equal(ticks.reduce((sum, tick) => sum + tick.data.opened, 0), 1);
  assert.equal((await api("servers/ir-main")).data.agent.status, "offline");
  const [disconnection] = await heartbeatIncidents();
  assert.equal(disconnection.serverId, "ir-main");
  assert.equal(disconnection.status, "open");
  await stop();
  await startHeartbeat();
  assert.equal((await healthTick()).data.opened, 0);
  await heartbeat("ir-main", agent, staleHeartbeat + 1000);
  assert.equal((await heartbeatIncidents())[0].status, "open");
  await heartbeat("ir-main", agent, Date.now());
  assert.equal((await heartbeatIncidents())[0].status, "resolved");
  assert.equal((await api("servers/ir-main")).data.agent.status, "online");
  const heartbeatAlerts = (await api("alerts")).data.filter((item) => item.incidentId === disconnection.id);
  assert.equal(heartbeatAlerts.length, 0, "Heartbeat incidents do not bypass configured alert rules");
  console.log("PASS: scoped heartbeat worker, restart and concurrent deduplication, and fresh recovery.");
  await stop();
  const arvanDb = join(temp, "arvan.sqlite");
  await writeFile(providerStatePath, JSON.stringify({ ...initialProviderState, resolver: { a: ["192.0.2.10"] } }));
  await start("ir-main", "monitor", false, true, false, false, { dbPath: arvanDb, arvan: true });
  const arvan = await api("providers/dns/node-1", { method: "POST" });
  assert.equal(arvan.data.provider, "arvan");
  assert.deepEqual(arvan.data.aRecords, ["192.0.2.10"]);
  assert.equal(arvan.data.resolverStatus, "matched");
  const arvanPreflight = (await api("failover/preflight/node-1?target=backup")).data;
  assert.equal(arvanPreflight.checks.find((check) => check.code === "dns").ok, false);
  console.log("PASS: paginated Arvan DNS reads, independent resolver, and Cloudflare failover isolation.");
  for (const [provider, zone, ttl] of [["cloudflare", "e".repeat(32), 60], ["arvan", "example.org", 120]]) {
    const token = provider === "arvan" ? "fixture-managed-arvan-key" : "fixture-managed-cf-key";
    const settingsPath = `providers/dns-settings/${provider}`;
    await api(settingsPath, { method: "PUT", body: { token }, token: readonly, status: 403 });
    assert.equal((await api(settingsPath, { method: "PUT", body: { token } })).data.count, 1);
    const sync = (await api("domains", { method: "POST" })).data;
    assert.equal(sync.providers.find((item) => item.provider === provider).zones[0].name, "example.org");
    const path = `domains/${provider}/${zone}/records`;
    const draft = { type: "AAAA", name: "test", content: "2001:db8::10", ttl, proxied: false };
    const { data: created } = await api(path, { body: draft });
    assert.equal(created.name, "test.example.org");
    const edit = { ...draft, id: created.id, revision: created.revision, proxied: true };
    assert.equal((await api(path, { body: edit })).data.proxied, true);
    await api(path, { body: edit, status: 409 });
    assert.equal((await api(path)).data[0].content, "2001:db8::10");
  }
  console.log("PASS: domain sync and record creation and proxy changes with Cloudflare and Arvan API fixtures.");
  await stop();
  await start("ir-main", "monitor", false, true, false, true, { dbPath: join(temp, "resolver-only.sqlite"), resolverOnly: true });
  assert.equal((await api("dns/monitor/tick", { method: "POST", token: dnsWorker })).data.checked, 1);
  const resolverOnly = (await api("dns")).data.find((record) => record.nodeId === "node-1");
  assert.equal(resolverOnly.resolverOnly, true);
  assert.equal(resolverOnly.expectedIranIp, "192.0.2.10");
  assert.equal(resolverOnly.resolverStatus, "matched");
  assert.equal(resolverOnly.authoritativeStatus, "error");
  await writeFile(providerStatePath, JSON.stringify({ ...initialProviderState, resolver: { a: ["192.0.2.11"] } }));
  const mismatch = (await api("providers/dns/node-1", { method: "POST" })).data;
  assert.equal(mismatch.resolverStatus, "mismatched");
  console.log("PASS: public DNS monitoring compares the active tunnel IP without DNS provider credentials.");
  await stop();
  const passwordHash = (password) => {
    const salt = randomBytes(16);
    return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
  };
  const firstPassword = "first fixture password";
  const nextPassword = "new fixture pass phrase";
  const recoveryPassword = "recovery fixture phrase";
  const initialHash = passwordHash(firstPassword);
  const startAdmin = (adminHash = initialHash) => start("", "monitor", false, false, false, false, { dbPath: passwordDb, adminHash });
  const loginAdmin = (password, status = 200) => api("session", { token: null, status, body: { username: "fixture-admin", password } });
  const changePassword = (headers, currentPassword, newPassword, status = 200) => api("session/password", {
    method: "PUT", token: null, headers, status, body: { currentPassword, newPassword },
  });
  const cookieOf = ({ headers }) => ({ Cookie: headers.get("set-cookie").split(";")[0] });
  await startAdmin();
  const firstSession = cookieOf(await loginAdmin(firstPassword));
  const otherSession = cookieOf(await loginAdmin(firstPassword));
  const registerPasskey = (headers, password, status = 200) => api("session/passkeys/register/options", {
    token: null, headers, status, body: { password },
  });
  await registerPasskey({ Origin: base }, firstPassword, 401);
  await registerPasskey({ ...firstSession, Origin: "https://other.invalid" }, firstPassword, 403);
  await registerPasskey({ ...firstSession, Origin: base }, "wrong", 403);
  const passkeyOptions = await registerPasskey({ ...firstSession, Origin: base }, firstPassword);
  assert.equal(passkeyOptions.data.authenticatorSelection.userVerification, "required");
  assert.equal(passkeyOptions.data.authenticatorSelection.residentKey, "required");
  assert.match(passkeyOptions.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const noPasskey = await api("session/passkeys/login/options", {
    token: null, headers: { Origin: base }, method: "POST", status: 404,
  });
  assert.equal(noPasskey.error.code, "NO_PASSKEY");
  await changePassword({}, firstPassword, nextPassword, 401);
  await changePassword({ ...firstSession, Origin: "https://other.invalid" }, firstPassword, nextPassword, 403);
  await changePassword(firstSession, firstPassword, "short", 422);
  await changePassword(firstSession, firstPassword, firstPassword, 422);
  await changePassword(firstSession, "wrong", nextPassword, 403);
  const activeSession = cookieOf(await changePassword(firstSession, firstPassword, nextPassword));
  for (const headers of [firstSession, otherSession]) await api("session", { token: null, headers, status: 401 });
  await api("session", { token: null, headers: activeSession });
  await loginAdmin(firstPassword, 401);
  const audit = (await api("audit", { token: null, headers: activeSession })).data;
  assert.ok(audit.some((event) => event.action === "admin.password.change"));
  assert.ok(!JSON.stringify(audit).includes(nextPassword));
  await stop();
  await startAdmin();
  const persisted = cookieOf(await loginAdmin(nextPassword));
  await stop();
  await startAdmin(passwordHash(recoveryPassword));
  await api("session", { token: null, headers: persisted, status: 401 });
  await loginAdmin(nextPassword, 401);
  await loginAdmin(recoveryPassword);
  console.log("PASS: authenticated admin password change, current-password and origin checks, session rotation, persistence and server recovery.");
  await stop();
  {
    await start("ir-main", "monitor", false, false, true, false, { dbPath: scheduledDb, gmailFixture: true, healthMonitor: true });
    const clock = Date.now();
    const legacy = await api("agent/telemetry", { token: agent, status: 409, body: {
      serverId: "ir-main", reportId: randomUUID(), observedAt: new Date(clock).toISOString(), version: "0.2.0",
      uptimeSec: 120, cpu: 20, ram: 10, disk: 10, rxMbps: 1, txMbps: 1,
    } });
    assert.equal(legacy.error.code, "TELEMETRY_UPGRADE");
    const settingsForAgent = { cpu: 120, ram: 600, disk: 600, traffic: 3600, serverPing: 300,
      tunnelProbe: 120, tunnelTraffic: 3600, logs: 10, service: 20, proxy: 20 };
    const watchSettings = (serverId, token, version) => api("agent/telemetry/settings", { token, body: { serverId, version } });
    const watched = await Promise.all([["ir-main", agent], ["exit-1", receiver]].map(async ([id, token]) => {
      const initial = (await watchSettings(id, token)).data.version;
      return { initial, waiting: watchSettings(id, token, initial) };
    }));
    await delay(150);
    const savedAt = Date.now();
    await action("updateSettings", [{ telemetryIntervals: settingsForAgent, metricAlertRules: [{
      id: "cpu-alert", name: "CPU fixture", targetId: "ir-main", metric: "cpu", operator: "gt", threshold: 50, cooldownMinutes: 30, enabled: true,
    }] }]);
    for (const { initial, waiting } of watched) assert.notEqual((await waiting).data.version, initial);
    assert.ok(Date.now() - savedAt < 5000, "Connected agents must receive settings changes before the long poll expires");
    const notifications = (await api("settings")).data.notifications;
    await action("updateSettings", [{ notifications: { ...notifications, email: true } }]);
    const gmail = { sender: "sender@gmail.com", recipient: "receiver@example.com", appPassword: "aaaa bbbb cccc dddd" };
    const savedGmail = (await api("notifications/gmail", { method: "PUT", body: gmail })).data;
    assert.equal(savedGmail.sender, gmail.sender);
    assert.equal("appPassword" in savedGmail, false);
    await api("notifications/gmail", { token: readonly, status: 403 });
    const reading = (ms, cpu, streams = ["cpu"]) => ({ serverId: "ir-main", reportId: randomUUID(), observedAt: new Date(ms).toISOString(),
      version: "0.3.0", uptimeSec: 100, cpu, streams });
    const sendReading = (body, status = 200) => api("agent/telemetry", { token: agent, body, status });
    const firstCpu = reading(clock - 125000, 70);
    await sendReading(firstCpu);
    assert.equal((await sendReading(firstCpu)).data.replay, true);
    assert.equal((await sendReading(reading(clock - 123000, 81), 409)).error.code, "TELEMETRY_CADENCE");
    await sendReading(reading(clock - 121000, 90, []), 422);
    const plan = (await api("agent/telemetry/plan", { token: agent, body: { serverId: "ir-main" } })).data;
    assert.equal(plan.due.cpu, clock - 5000);
    await sendReading(reading(clock - 1000, 80));
    assert.equal((await api("workspace")).data.alerts.filter(({ title }) => title === "CPU fixture").length, 1);
    const samples = (await api("metrics/samples?stream=cpu&id=ir-main&days=1")).data;
    assert.deepEqual(samples.samples.map(({ cpu }) => cpu), [80, 70]);
    const queuedPing = (await api("tunnels/tun-main/ping", { method: "POST" })).data;
    assert.equal(queuedPing.status, "pending");
    const finishPing = (token, serverId) => api("agent/telemetry/tunnel-ping", { token, body: {
      serverId, id: queuedPing.id, result: { rttMs: 25, jitterMs: 1, packetLoss: 0 },
    } });
    assert.equal((await finishPing(receiver, "exit-1")).data, false);
    assert.equal((await finishPing(agent, "ir-main")).data, true);
    assert.equal((await api("tunnels/tun-main/ping")).data.result.rttMs, 25);
    await api("speedtests/batch", { token: readonly, body: { mode: "gre", ids: ["tun-main"] }, status: 403 });
    await api("speedtests/batch", { body: { mode: "gre", ids: ["tun-forward-lab"] }, status: 422 });
    const speedBatch = (await api("speedtests/batch", { body: { mode: "gre", ids: ["tun-main"] } })).data;
    assert.equal(speedBatch.mode, "gre");
    assert.equal(speedBatch.status, "running");
    assert.equal(speedBatch.targets[0].status, "queued");
    assert.equal(speedBatch.targets[0].label, "مسیر اصلی");
    await api("speedtests/batch", { body: { mode: "internet", ids: ["ir-main"] }, status: 409 });
    const speedPlan = (await api("agent/telemetry/plan", { token: agent, body: { serverId: "ir-main" } })).data;
    assert.equal(speedPlan.speedBatches.length, 1);
    assert.equal(speedPlan.speedBatches[0].pingCount, 10);
    assert.equal(speedPlan.speedBatches[0].interface, "gre1");
    assert.equal(speedPlan.speedBatches[0].bandwidth, "speedtest");
    const speedProbeId = speedPlan.speedBatches[0].id;
    assert.equal((await api("agent/telemetry/speed-batch", { token: receiver, body: {
      serverId: "exit-1", id: speedProbeId, pingsMs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], bandwidthMbps: 1,
    } })).data, false);
    assert.equal((await api("agent/telemetry/speed-batch", { token: agent, body: {
      serverId: "ir-main", id: speedProbeId, pingsMs: [80, 90, 100, 85, 95, 88, 92, 91, 89, 90], bandwidthMbps: 100,
    } })).data, true);
    const speedReport = (await api(`speedtests/batch/${speedBatch.id}`)).data;
    assert.equal(speedReport.status, "completed");
    assert.equal(speedReport.targets[0].ping.minMs, 80);
    assert.equal(speedReport.targets[0].ping.avgMs, 90);
    assert.equal(speedReport.targets[0].ping.maxMs, 100);
    assert.equal(speedReport.targets[0].ping.attempts, 10);
    assert.equal(speedReport.targets[0].ping.replies, 10);
    assert.equal(speedReport.targets[0].avgMbps, 100);
    assert.deepEqual(speedReport.targets[0].samples, [80, 90, 100, 85, 95, 88, 92, 91, 89, 90]);
    await api("health/worker/tick", { method: "POST", token: healthWorker });
    assert.ok((await api("notifications/gmail")).data.history.some(({ status }) => status === "sent"));
    assert.equal(await readFile(gmailStatePath, "utf8"), "accepted\n");
    const externalHost = (await api("servers", { body: serverForm, status: 201 })).data;
    const externalPing = (await api(`servers/${externalHost.id}/check-host`, { method: "POST" })).data;
    assert.deepEqual(externalPing.map(({ rttMs, packetLoss }) => [rttMs, packetLoss]), [[40, 50], [null, null]]);
    const enrollment = { NODEGUARD_PROVISION_PROFILES: [{ id: "download-test", serverId: "ir-main", component: "BBR",
      version: "1.0", sha256: artifactHash, summary: "Agent HTTP delivery fixture" }] };
    const receipt = (await api("provision/catalog/preview", { body: enrollment })).data;
    await api("provision/catalog/import", { body: { enrollment, fingerprint: receipt.fingerprint } });
    const uploadArtifact = (data) => {
      const body = new FormData();
      body.append("files", new Blob([data]), "manifest.json");
      return fetch(`${base}/api/v1/provision/profiles/ir-main/download-test/artifacts`, {
        method: "POST", headers: { Authorization: `Bearer ${admin}` }, body,
      });
    };
    assert.equal((await uploadArtifact("invalid fixture")).status, 422);
    assert.equal((await uploadArtifact(artifactManifest)).status, 200);
    const claim = (headers) => api("agent/provision/claim", { token: agent, body: { serverId: "ir-main" }, headers });
    const supportsDownload = { "X-NodeGuard-Provision-Download": "1" };
    assert.equal((await claim(supportsDownload)).data, null);
    await api("provision/jobs", { body: { operation: "apply", serverId: "ir-main", profileId: "download-test", sha256: artifactHash },
      headers: { "Idempotency-Key": randomUUID() } });
    assert.equal((await claim({})).data, null);
    const job = (await claim(supportsDownload)).data;
    assert.equal(job.download, true);
    const artifact = `agent/provision/${job.id}/artifact`;
    const params = { serverId: "ir-main", lease: job.lease, name: "manifest.json" };
    await api(artifact, { token: receiver, body: { ...params, serverId: "exit-1" }, status: 403 });
    await api(artifact, { token: agent, body: { ...params, name: "../manifest.json" }, status: 422 });
    const bytes = await fetch(`${base}/api/v1/${artifact}`, { method: "POST", headers: {
      Authorization: `Bearer ${agent}`, "Content-Type": "application/json",
    }, body: JSON.stringify(params) });
    assert.equal(bytes.headers.get("content-type"), "application/octet-stream");
    assert.equal(await bytes.text(), artifactManifest);
    const range = await fetch(`${base}/api/v1/${artifact}`, { method: "POST", headers: {
      Authorization: `Bearer ${agent}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ ...params, offset: 5 }) });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 5-${artifactManifest.length - 1}/${artifactManifest.length}`);
    assert.equal(await range.text(), artifactManifest.slice(5));
    await api(artifact, { token: agent, body: { ...params, offset: artifactManifest.length }, status: 416 });
    const artifactProbe = Buffer.alloc(140 * 1024, 42);
    const probeFile = join(artifactDirectory, "range-test.bin");
    await writeFile(probeFile, artifactProbe);
    try {
      const packed = await fetch(`${base}/api/v1/${artifact}`, { method: "POST", headers: {
        Authorization: `Bearer ${agent}`, "Content-Type": "application/json", "X-NodeGuard-Artifact-Gzip": "1",
      }, body: JSON.stringify({ ...params, name: "range-test.bin", offset: 1 }) });
      assert.equal(packed.status, 206);
      assert.equal(packed.headers.get("X-NodeGuard-Artifact-Encoding"), "gzip");
      assert.equal(packed.headers.get("Content-Range"), `bytes 1-${128 * 1024}/${artifactProbe.length}`);
      assert.deepEqual(gunzipSync(Buffer.from(await packed.arrayBuffer())), artifactProbe.subarray(1, 1 + 128 * 1024));
    } finally {
      await rm(probeFile, { force: true });
    }
    await api(`agent/provision/${job.id}/progress`, { token: agent, body: { serverId: "ir-main", lease: job.lease, step: "package" } });
    assert.deepEqual((await api("provision/jobs")).data.jobs.find((item) => item.id === job.id).checks, ["package"]);
    await api(`agent/provision/${job.id}/finish`, { token: agent, body: { serverId: "ir-main", lease: job.lease, status: "succeeded", detail: "applied" } });
    await api(artifact, { token: agent, body: params, status: 403 });
    console.log("PASS: per-stream Agent cadence, replay, alert cooldown, raw samples, scoped manual tunnel ping and sealed Gmail configuration.");
  }
  console.log("PASS: HTTP, authentication, RBAC, validation, retries, concurrency, simulation, restart persistence, Agent telemetry, and separation of the monitor workspace.");
} finally {
  await stop();
  await rm(join(artifactDirectory, "manifest.json"), { force: true });
  await rmdir(artifactDirectory).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await rmdir(join(temp, "provision-artifacts")).catch((error) => { if (error.code !== "ENOENT") throw error; });
  for (const file of [db, join(temp, "monitor.sqlite"), autoDbPath, heartbeatDb, standbyDb, panelDb, passwordDb, scheduledDb, join(temp, "arvan.sqlite"), join(temp, "resolver-only.sqlite")]) {
    for (const suffix of ["", "-wal", "-shm"]) await rm(file + suffix, { force: true });
  }
  await rm(providerStatePath, { force: true });
  await rm(telegramStatePath, { force: true });
  await rm(gmailStatePath, { force: true });
  await rm(panelStatePath, { force: true });
  await rm(panelStatePath + ".pending", { force: true });
  await rm(registrationConfig, { force: true });
  await rm(downloadedInstaller, { force: true });
  await rm(registrationToken, { force: true });
  await rmdir(temp);
}
