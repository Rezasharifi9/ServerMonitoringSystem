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

process.env.NODEGUARD_ENABLE_PROVISION = "1";
const { database, transaction, readWorkspace, writeWorkspace } = await import("../src/server/database.ts");
const { claimProvision, queueBbr, finishProvision } = await import("../src/server/provision.ts");
const { markWorkerPoll } = await import("../src/server/agent-workers.ts");
const { createHash } = await import("node:crypto");
const actor = { id: "usr-reza", name: "Test admin", role: "super-admin", email: "" };
const db = database();
const tokens = JSON.parse(process.env.NODEGUARD_AGENT_TOKENS);
const request = (serverId) => new Request("https://nodeguard.test/api/v1/agent/provision/claim", { method: "POST", headers: { Authorization: "Bearer " + tokens[serverId], "X-NodeGuard-Provision-Download": "1" } });
try {
  transaction(connection => {
    const { state, revision } = readWorkspace(connection);
    for (const host of state.servers) host.agent = { ...host.agent, status: "online", lastHeartbeat: new Date().toISOString() };
    writeWorkspace(connection, state, revision + 1);
  });
  markWorkerPoll(db, "exit-1", "provision", Date.now(), true, true);
  const queued = queueBbr(actor, "exit-1", randomUUID()).job;
  const claimId = "a".repeat(64);
  const first = claimProvision(request("exit-1"), { serverId: "exit-1", claimId });
  assert.equal(first.id, queued.id);
  assert.equal(first.lease, claimId);
  const expiry = db.prepare("SELECT lease_until FROM provision_jobs WHERE id=?").get(first.id).lease_until;
  // Drop the first response and repeat the exact durable request.
  const replay = claimProvision(request("exit-1"), { serverId: "exit-1", claimId });
  assert.equal(replay.id, first.id);
  assert.equal(replay.lease, first.lease);
  assert.equal(db.prepare("SELECT lease_until FROM provision_jobs WHERE id=?").get(first.id).lease_until, expiry);
  assert.equal(claimProvision(request("ir-main"), { serverId: "ir-main", claimId }), null);
  assert.equal(db.prepare("SELECT lease_digest FROM provision_jobs WHERE id=?").get(first.id).lease_digest, createHash("sha256").update(claimId).digest("hex"));
  finishProvision(request("exit-1"), first.id, { serverId: "exit-1", lease: claimId, status: "succeeded", detail: "applied" });
  const next = queueBbr(actor, "exit-1", randomUUID()).job;
  assert.equal(claimProvision(request("exit-1"), { serverId: "exit-1", claimId }), null);
  assert.equal(db.prepare("SELECT status FROM provision_jobs WHERE id=?").get(next.id).status, "queued");
  const legacy = claimProvision(request("exit-1"), { serverId: "exit-1" });
  assert.equal(legacy.id, next.id);
  finishProvision(request("exit-1"), legacy.id, { serverId: "exit-1", lease: legacy.lease, status: "succeeded", detail: "applied" });
  const expired = queueBbr(actor, "exit-1", randomUUID()).job;
  claimProvision(request("exit-1"), { serverId: "exit-1", claimId: "b".repeat(64) });
  db.prepare("UPDATE provision_jobs SET lease_until=? WHERE id=?").run(Date.now()-1, expired.id);
  assert.equal(claimProvision(request("exit-1"), { serverId: "exit-1", claimId: "b".repeat(64) }), null);
  assert.equal(db.prepare("SELECT status FROM provision_jobs WHERE id=?").get(expired.id).status, "review");
  assert.throws(() => claimProvision(request("exit-1"), { serverId: "exit-1", claimId: "bad" }), { status: 422 });
  console.log("PASS: lost claim response replays the same task and lease; no renewal, cross-host replay, terminal reuse or expired execution; legacy Agents remain compatible.");
} finally {
  db.close();
  await rm(temp, { recursive: true, force: true });
}
