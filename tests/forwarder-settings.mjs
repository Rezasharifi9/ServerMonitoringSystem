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

const temp = await mkdtemp(join(tmpdir(), "nodeguard-forwarder-"));
process.env.NODEGUARD_DB_PATH = join(temp, "test.sqlite");
process.env.NODEGUARD_WORKSPACE_MODE = "monitor";
process.env.NODEGUARD_INVENTORY_PATH = join(root, "inventory.example.json");
process.env.NODEGUARD_CREDENTIAL_KEY = "a".repeat(64);
process.env.NODEGUARD_ENABLE_PROVISION = "1";
process.env.NODEGUARD_AGENT_TOKENS = JSON.stringify({ "ir-main": "b".repeat(64), "exit-1": "c".repeat(64) });
const { database, readWorkspace, writeWorkspace } = await import("../src/server/database.ts");
const { getForwarderSettings, saveForwarderSettings, readForwarderSettings, forwarderNoiseKeys, forwarderCertificate } = await import("../src/server/forwarder-settings.ts");
const { forwarderSettingsSchema } = await import("../src/lib/forwarder-config.ts");
const { createPrivateKey, createPublicKey } = await import("node:crypto");
const forge = (await import("node-forge")).default;
const actor = { id: "usr-reza", name: "Test admin", role: "super-admin", email: "" };
const db = database();
try {
  const { state, revision } = readWorkspace();
  const target = state.tunnels[0];
  target.technology = "Rathole"; target.kind = "forwarder";
  writeWorkspace(db, state, revision + 1);
  const initial = getForwarderSettings(actor, target.id);
  assert.equal(initial.saved, false);
  assert(forwarderSettingsSchema.safeParse(initial.settings).success);
  assert.throws(() => getForwarderSettings({ ...actor, role: "viewer" }, target.id));
  const settings = initial.settings;
  saveForwarderSettings(actor, target.id, settings);
  assert.deepEqual(readForwarderSettings(target.id), settings);
  const sealed = db.prepare("SELECT sealed FROM provider_credentials WHERE provider=?").get("forwarder:" + target.id).sealed;
  assert(!sealed.includes(settings.iran.options.default_token));
  const wrong = structuredClone(settings); wrong.foreign.options.default_token = "wrong";
  assert.throws(() => saveForwarderSettings(actor, target.id, wrong), e => e.code === "FORWARDER_TOKEN");
  const mismatch = structuredClone(settings); mismatch.foreign.options.services = {};
  assert.throws(() => saveForwarderSettings(actor, target.id, mismatch), e => e.code === "FORWARDER_SERVICES");
  const bad = structuredClone(settings); bad.iran.assets = [{ name: "key.pem", content: "bad-encoding" }];
  assert.throws(() => saveForwarderSettings(actor, target.id, bad), e => e.code === "FORWARDER_ASSET");
  const keys = forwarderNoiseKeys(actor, target.id);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(keys.privateKey, "base64")]), type: "pkcs8", format: "der" });
  assert.equal(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), keys.publicKey);
  const cert = await forwarderCertificate(actor, target.id, { hostname: "tunnel.example.test", days: 30 });
  const pem = Buffer.from(cert.certificate.content, "base64").toString();
  const parsedCert = forge.pki.certificateFromPem(pem);
  assert.equal(parsedCert.subject.getField("CN").value, "tunnel.example.test");
  assert(parsedCert.verify(parsedCert));
  const asn = forge.asn1.fromDer(Buffer.from(cert.identity.content, "base64").toString("binary"));
  assert(forge.pkcs12.pkcs12FromAsn1(asn, cert.password));
  const now = readWorkspace(); now.state.tunnels[0].technology = "Backhaul"; writeWorkspace(db, now.state, now.revision + 1);
  db.prepare("DELETE FROM provider_credentials WHERE provider=?").run("forwarder:"+target.id);
  const backhaul = getForwarderSettings(actor, target.id).settings;
  assert.equal(backhaul.technology, "Backhaul");
  backhaul.iran.options.sniffer = true; backhaul.iran.options.web_port = 2060;
  saveForwarderSettings(actor, target.id, backhaul);
  assert.equal(readForwarderSettings(target.id).iran.options.sniffer, true);
  // Independent control/data ports allow multiple reverse tunnels on one host.
  const peers = readWorkspace();
  const second = structuredClone(peers.state.tunnels.find(t => t.id === target.id));
  second.id = "tun-second-backhaul"; second.name = "Second Backhaul";
  second.nodeIds = []; delete second.nodeRef; second.iranEndpoint.port = 2023;
  peers.state.tunnels.push(second);
  writeWorkspace(db, peers.state, peers.revision + 1);
  const secondConfig = getForwarderSettings(actor, second.id).settings;
  assert.equal(secondConfig.iran.options.bind_addr, "0.0.0.0:3081");
  assert.equal(secondConfig.foreign.options.remote_addr.split(":").at(-1), "3081");
  secondConfig.iran.options.ports = ["2023"];
  saveForwarderSettings(actor, second.id, secondConfig);
  const collision = structuredClone(secondConfig);
  collision.iran.options.bind_addr = backhaul.iran.options.bind_addr;
  collision.foreign.options.remote_addr = backhaul.foreign.options.remote_addr;
  assert.throws(() => saveForwarderSettings(actor, second.id, collision), e => e.code === "FORWARDER_PORT_CONFLICT");
  const dataCollision = structuredClone(secondConfig);
  dataCollision.iran.options.ports = structuredClone(backhaul.iran.options.ports);
  assert.throws(() => saveForwarderSettings(actor, second.id, dataCollision), e => e.code === "FORWARDER_PORT_CONFLICT");
  const monitoringCollision = structuredClone(secondConfig);
  monitoringCollision.iran.options.web_port = 2060;
  assert.throws(() => saveForwarderSettings(actor, second.id, monitoringCollision), e => e.code === "FORWARDER_PORT_CONFLICT");
  const remoteMismatch = structuredClone(secondConfig);
  remoteMismatch.foreign.options.remote_addr = "192.0.2.10:9000";
  assert.throws(() => saveForwarderSettings(actor, second.id, remoteMismatch), e => e.code === "FORWARDER_LISTENERS");
  const { forwarderListeners } = await import("../src/lib/forwarder-listeners.ts");
  const ranges = structuredClone(secondConfig);
  ranges.iran.options.ports = ["8000-8002:9000", "127.0.0.1:8100-8101=127.0.0.1:22"];
  assert.deepEqual(forwarderListeners(ranges, "iran").map(l => l.port), [3081, 8000, 8001, 8002, 8100, 8101]);
  const unchanged = readForwarderSettings(target.id);
  assert.equal(unchanged.iran.options.bind_addr, "0.0.0.0:3080");
  const live = readWorkspace();
  for (const host of live.state.servers) {
    host.agent.status = "online"; host.agent.version = "0.5.2"; host.agent.lastHeartbeat = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO agent_worker_polls(server_id,kind,last_seen,can_remove,can_download,can_iptables) VALUES (?,'provision',?,1,1,1)").run(host.id, Date.now());
  }
  writeWorkspace(db, live.state, live.revision + 1);
  const { installFromPanel } = await import("../src/server/ssh-provision.ts");
  const { controlForwarder } = await import("../src/server/forwarder-control.ts");
  const { claimProvision, finishProvision } = await import("../src/server/provision.ts");
  const installed = await installFromPanel(actor, { kind: "tunnel", tunnelId: target.id }, randomUUID());
  assert.equal(installed.deployment.steps.length, 2);
  for (const step of installed.deployment.steps) {
    assert.equal(step.job.profile.component, "Backhaul");
    db.prepare("UPDATE provision_jobs SET status='succeeded',detail='applied' WHERE id=?").run(step.job.id);
  }
  db.prepare("UPDATE tunnel_deployments SET status='succeeded',detail='link_verified' WHERE id=?").run(installed.deployment.id);
  const requestKey = randomUUID();
  const controlled = controlForwarder(actor, target.id, { action: "start", side: "both" }, requestKey);
  assert.equal(controlled.jobs.length, 2);
  assert.deepEqual(controlForwarder(actor, target.id, { action: "start", side: "both" }, requestKey), controlled);
  const oldWorker = new Request("https://panel.test", { headers: { Authorization: "Bearer " + "b".repeat(64) } });
  assert.equal(claimProvision(oldWorker, { serverId: "ir-main" }), null);
  const newWorker = new Request("https://panel.test", { headers: { Authorization: "Bearer " + "b".repeat(64), "X-NodeGuard-Service-Control": "1" } });
  const claimed = claimProvision(newWorker, { serverId: "ir-main" });
  assert.equal(claimed.operation, "start-service");
  assert(claimed.rollbackOf);
  const finished = finishProvision(newWorker, claimed.id, { serverId: "ir-main", lease: claimed.lease, status: "succeeded", detail: "started" });
  assert.equal(finished.job.status, "succeeded");
  // A lost final deletion response can be retried after inventory/job purge.
  const retiredReport = { serverId: "ir-main", lease: claimed.lease, status: "succeeded", detail: "removed" };
  assert.throws(() => finishProvision(newWorker, randomUUID(), retiredReport), e => e.status === 409 && e.code === "PROVISION_JOB_STATE");
  assert.throws(() => finishProvision(new Request("https://panel.test"), randomUUID(), retiredReport), e => e.status === 401);
  // Lifecycle commands reference the original install, but do not uninstall it.
  for (const jobId of controlled.jobs) db.prepare("UPDATE provision_jobs SET status='succeeded',detail='started' WHERE id=?").run(jobId);
  db.prepare("UPDATE agent_worker_polls SET can_remove=1,can_download=1,last_seen=?").run(Date.now());
  const { startTunnelDeployment } = await import("../src/server/tunnel-deployments.ts");
  const rebuilt = startTunnelDeployment(actor, { tunnelId: target.id, operation: "rebuild", fingerprint: installed.deployment.preview.fingerprint }, randomUUID());
  assert.equal(rebuilt.deployment.steps[0].phase, "iran_remove", "Rebuild must remove both original profiles after start/stop/restart");
  assert.equal(rebuilt.deployment.steps[0].job.operation, "remove");
  assert.equal(rebuilt.deployment.steps[0].job.rollbackOf, installed.deployment.steps.find(s => s.phase === "iran_apply").job.id);
  console.log("Real paired package build, Agent queue, service-control idempotency, capability gating and finish protocol passed");
  console.log("Forwarder permissions, schemas, encrypted settings, matching roles/tokens, assets, Noise and TLS generation passed");
} finally { db.close(); await rm(temp, { recursive: true, force: true }); }
