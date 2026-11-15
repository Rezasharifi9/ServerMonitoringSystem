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
    if(url.endsWith('/src/server/failover-worker.ts'))return {format:'module-typescript',shortCircuit:true,source:readFileSync(new URL(url),'utf8')+'\nexport {simpleDnsChange};'};
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

const {simpleDnsChange}=await import('../src/server/failover-worker.ts');
try{
 const state=readWorkspace().state, node=state.nodes[0],now=Date.now();
 Object.assign(state.settings.failover,{autoEnabled:true,autoFailback:true,minConfirmations:2,stabilitySec:180,cooldownSec:0,intervalSec:60,failureThreshold:1,packetLossThreshold:50});
 const primary=state.tunnels.find(t=>t.id===node.primaryTunnelId),backup=state.tunnels.find(t=>t.id===node.backupTunnelId);
 backup.nodeIds=[node.id];
 function fresh(at){for(const server of state.servers)Object.assign(server.agent,{status:'online',lastHeartbeat:new Date(at).toISOString()});for(const t of [primary,backup])Object.assign(t,{status:'healthy',packetLoss:0,lastCheck:new Date(at).toISOString()});}
 fresh(now);primary.status='offline';assert.equal(simpleDnsChange(db,node,state,now),null);assert.equal(simpleDnsChange(db,node,state,now+1).target,'backup');
 backup.status='offline';assert.equal(simpleDnsChange(db,node,state,now+2),null,'Never select an offline backup');
 node.activeSide='backup';fresh(now+3);assert.equal(simpleDnsChange(db,node,state,now+3),null,'Recovery requires stability');fresh(now+179000);assert.equal(simpleDnsChange(db,node,state,now+179000),null);fresh(now+180004);assert.equal(simpleDnsChange(db,node,state,now+180004).target,'primary');
 fresh(now+180005);primary.lastCheck=new Date(now+90005).toISOString();assert.equal(simpleDnsChange(db,node,state,now+180005).target,'primary','A valid 120-second probe cadence must not reset recovery at 60 seconds');
 console.log('PASS: automatic failover requires consecutive failures and a healthy backup; failback waits for stable primary recovery.');
}finally{db.close();await rm(temp,{recursive:true,force:true});}
