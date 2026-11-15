import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// Isolated inventory, database and mocked DNS provider. No production endpoints.
const temp = await mkdtemp(join(process.cwd(), ".nodeguard/backup-policy-"));
const inventory = JSON.parse(await readFile("inventory.example.json", "utf8"));
const node = inventory.nodes[0];
delete node.backupTunnelId; delete node.backupServerId;
node.domain = "old.example.org";
inventory.tunnels = inventory.tunnels.filter(t => t.side !== "backup");
await writeFile(join(temp, "inventory.json"), JSON.stringify(inventory));
const socket = createServer(); await new Promise(r => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString("hex");
const dbPath = join(temp, "test.sqlite");
let output = "";
const child = spawn(process.execPath, ["--import", "./tests/cloudflare-fixture.mjs", "--import", "./tests/v2board-fixture.mjs", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  windowsHide: true,
  env: { ...process.env, NODEGUARD_DB_PATH: dbPath, NODEGUARD_WORKSPACE_MODE: "monitor", NODEGUARD_INVENTORY_PATH: join(temp, "inventory.json"),
    NODEGUARD_USER_TOKENS: JSON.stringify({ "usr-reza": token }),
    NODEGUARD_V2BOARD_MAP: "{}", NODEGUARD_V2BOARD_ENDPOINT: "https://panel.nodeguard.example/api/v1/fixture-admin/server/manage/getNodes", NODEGUARD_V2BOARD_AUTH: "Bearer fixture-panel-token",
    NODEGUARD_CREDENTIAL_KEY: randomBytes(32).toString("hex"), NODEGUARD_CF_TOKEN: "fixture-managed-cf-key",
    NODEGUARD_ENABLE_DNS_FAILOVER: "0", NODEGUARD_ENABLE_AUTO_FAILOVER: "0", NODEGUARD_ORIGIN: base, NODEGUARD_SECURE_COOKIE: "0" }
});
child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
async function api(path, method = "GET", body, status = 200) {
  const response = await fetch(base + "/api/v1/" + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data.data;
}
function mutate(fn) {
  const db = new DatabaseSync(dbPath);
  try { const state = JSON.parse(db.prepare("SELECT snapshot FROM workspace").get().snapshot); fn(state, db); db.prepare("UPDATE workspace SET snapshot=?, revision=revision+1").run(JSON.stringify(state)); } finally { db.close(); }
}
try {
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error(output); if ((await fetch(base + "/api/v1/status").catch(() => null))?.ok) break; await delay(100); }
  const registration = { nodeRef: { kind: "inventory", id: node.id }, side: "backup", technology: "GRE", iranServerId: "ir-backup", foreignServerId: "exit-1", routeKey: "00000000-0000-4000-8000-000000000001" };
  await api("tunnels", "POST", { ...registration, nodeDomain: "forbidden.example.org" }, 422);
  await api("tunnels", "POST", { ...registration, iranServerId: node.primaryServerId }, 422);
  const backup = await api("tunnels", "POST", registration, 201);
  assert.equal(backup.nodeDomain, undefined); assert.ok(!JSON.stringify(backup).includes("old.example.org"));
  assert.equal((await api("tunnels", "POST", registration)).id, backup.id);
  const saved = (await api("workspace")).nodes.find(n => n.id === node.id);
  assert.equal(saved.backupTunnelId, backup.id); assert.equal(saved.backupServerId, "ir-backup"); assert.equal(saved.primaryTunnelId, node.primaryTunnelId);
  await api("tunnels", "POST", { ...registration, routeKey: "00000000-0000-4000-8000-000000000002" }, 409);
  await api(`nodes/${node.id}/backup-route`, "POST", { tunnelId: backup.id }, 410);
  await api(`nodes/${node.id}/routes`, "PUT", { primaryTunnelId: node.primaryTunnelId, activeSide: "backup" }, 422);
  await api("providers/v2board/import", "POST", { key: "vless:1", fingerprint: "a".repeat(64), domain: "x.example.org", primaryTunnelId: node.primaryTunnelId, backupTunnelId: backup.id }, 422);
  mutate(state => { state.nodes[0].domain = "current.example.org"; const tunnel = state.tunnels.find(t => t.id === backup.id); tunnel.status = "healthy"; tunnel.lastCheck = new Date().toISOString(); tunnel.nodeDomain = "stale.example.org"; });
  const dns = await api(`tunnels/${encodeURIComponent(backup.id)}/dns`, "POST");
  assert.equal(dns.domain, "current.example.org"); assert.equal(dns.ip, "192.0.2.11");
  mutate(state => {
    state.nodes[0].domain = "renamed.example.org";
    state.settings.failover = { ...state.settings.failover, trigger: "tunnel-loss", autoEnabled: true, intervalSec: 60, failureThreshold: 3, minConfirmations: 1 };
    for (const server of state.servers) Object.assign(server.agent, { status: "online", lastHeartbeat: new Date().toISOString() });
    Object.assign(state.tunnels.find(t => t.id === node.primaryTunnelId), { status: "offline", packetLoss: 100, lastCheck: new Date().toISOString() });
    Object.assign(state.tunnels.find(t => t.id === backup.id), { packetLoss: 0 });
  });
  const tick = await api("failover/worker/tick", "POST");
  assert.equal(tick.switched, 1);
  const after = (await api("workspace")).nodes.find(n => n.id === node.id);
  assert.equal(after.activeSide, "backup"); assert.equal(after.backupTunnelId, backup.id);
  const audit = await api("audit"); assert.ok(audit.some(a => a.action === "failover.execute.succeeded" && a.detail.includes("renamed.example.org")));
  // The primary host is lost: promote the active backup without removing or contacting it.
  mutate(state => { const old = state.tunnels.find(t => t.id === node.primaryTunnelId); old.status = "offline"; old.lastCheck = ""; });
  const promoted = await api(`nodes/${node.id}/routes`, "PUT", { primaryTunnelId: backup.id, activeSide: "primary" });
  assert.equal(promoted.primaryTunnelId, backup.id); assert.equal(promoted.backupTunnelId, undefined);
  assert.equal(promoted.primaryServerId, "ir-backup"); assert.equal(promoted.activeSide, "primary");
  let routes = (await api("workspace")).tunnels;
  assert.ok(routes.some(t => t.id === node.primaryTunnelId));
  assert.equal(routes.find(t => t.id === backup.id).side, "primary");
  await api(`nodes/${node.id}/routes`, "PUT", { primaryTunnelId: backup.id, backupTunnelId: backup.id, activeSide: "primary" }, 422);
  const replacement = await api("tunnels", "POST", { ...registration, iranServerId: node.primaryServerId, routeKey: "00000000-0000-4000-8000-000000000003" }, 201);
  assert.equal((await api("workspace")).nodes.find(n => n.id === node.id).backupTunnelId, replacement.id);
  mutate(state => { const tunnel = state.tunnels.find(t => t.id === replacement.id); tunnel.status = "healthy"; tunnel.lastCheck = new Date().toISOString(); });
  const swapped = await api(`nodes/${node.id}/routes`, "PUT", { primaryTunnelId: replacement.id, backupTunnelId: backup.id, activeSide: "backup" });
  assert.equal(swapped.primaryTunnelId, replacement.id); assert.equal(swapped.backupTunnelId, backup.id);
  routes = (await api("workspace")).tunnels;
  assert.equal(routes.find(t => t.id === replacement.id).side, "primary");
  assert.equal(routes.find(t => t.id === backup.id).side, "backup");
  mutate((state, db) => {
    assert.ok(state.tunnels.every(t => t.nodeDomain === undefined));
    db.prepare("INSERT INTO v2board_bindings(panel_key,node_id) VALUES (?,?)").run("vmess:7", node.id);
    db.prepare("INSERT INTO provider_cache VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload").run("v2board", JSON.stringify({ nodes: [{ key: "vmess:7", host: "panel-current.example.org" }], syncedAt: new Date().toISOString() }));
  });
  assert.equal((await api(`tunnels/${encodeURIComponent(backup.id)}/dns`, "POST")).domain, "panel-current.example.org");
  mutate((state, db) => db.prepare("UPDATE provider_cache SET payload=? WHERE provider='v2board'").run(JSON.stringify({ nodes: [], syncedAt: new Date().toISOString() })));
  await api(`tunnels/${encodeURIComponent(backup.id)}/dns`, "POST", undefined, 409);
  console.log("PASS: backup promotion with lost primary, replacement registration, role swapping, topology validation, idempotency, duplicate rejection, legacy API denial, current-node DNS lookup and automatic switch after domain rename, current V2Board host lookup and missing-node refusal.");
} catch (error) { console.error(output); throw error; } finally {
  child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
}
