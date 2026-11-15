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
const {insertProvisionJob}=await import('../src/server/provision.ts');
const {advanceTunnelDeployments,finalizeTunnelActivations,manageTunnelDeployment}=await import('../src/server/tunnel-deployments.ts');
try {
 const now=Date.now(),id=randomUUID();
 transaction(c=>{const {state,revision}=readWorkspace(c);for(const host of state.servers)Object.assign(host.agent,{status:'online',lastHeartbeat:new Date().toISOString()});state.tunnels.find(t=>t.id==='tun-main').nodeRef={kind:'inventory',id:'node-1'};writeWorkspace(c,state,revision+1);});
 const profile=serverId=>({id:'fixture-'+serverId,component:'GRE',version:'1',serverId,sha256:'c'.repeat(64),summary:'Fixture'});
 const preview={tunnelId:'tun-main',technology:'GRE',iran:profile('ir-main'),foreign:profile('exit-1'),fingerprint:'d'.repeat(64)};
 db.prepare('INSERT INTO tunnel_deployments (id,tunnel_id,iran_id,foreign_id,actor_id,request_key,preview,status,phase,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,'tun-main','ir-main','exit-1',actor.id,randomUUID(),JSON.stringify(preview),'deploying','iran_apply','installing',now);
 for(const [phase,p] of [['foreign_apply',preview.foreign],['iran_apply',preview.iran]]){const j=insertProvisionJob(db,actor.id,randomUUID(),'d'.repeat(64),p,null,now);db.prepare("UPDATE provision_jobs SET status='succeeded',detail='verified' WHERE id=?").run(j);db.prepare('INSERT INTO tunnel_deployment_steps VALUES (?,?,?)').run(id,phase,j);}
 const run=()=>db.prepare('SELECT * FROM tunnel_deployments WHERE id=?').get(id);
 let writes=0;globalThis.fixtureDns=async()=>{writes++;throw Error('provider unavailable');};
 advanceTunnelDeployments();assert.equal(run().phase,'foreign_bbr');assert.equal(db.prepare("SELECT count(*) n FROM tunnel_deployment_steps WHERE deployment_id=? AND phase IN ('iran_bbr','foreign_bbr')").get(id).n,2);
 await finalizeTunnelActivations();assert.equal(writes,0);
 const bbr=db.prepare("SELECT job_id FROM tunnel_deployment_steps WHERE deployment_id=? AND phase IN ('iran_bbr','foreign_bbr') ORDER BY phase").all(id);
 db.prepare("UPDATE provision_jobs SET status='succeeded' WHERE id=?").run(bbr[0].job_id);advanceTunnelDeployments();assert.equal(run().phase,'foreign_bbr');
 db.prepare("UPDATE provision_jobs SET status='succeeded' WHERE id=?").run(bbr[1].job_id);advanceTunnelDeployments();assert.equal(run().status,'verifying');
 await finalizeTunnelActivations();assert.equal(writes,0);
 const at=Date.now();db.prepare('INSERT INTO agent_reports VALUES (?,?,?,?,?)').run('ir-main',randomUUID(),at,'f'.repeat(64),JSON.stringify({tunnels:[{tunnelId:'tun-main',status:'healthy',measuredAt:new Date(at).toISOString()}]}));
 advanceTunnelDeployments();assert.equal(run().phase,'dns');await finalizeTunnelActivations();assert.equal(writes,1);assert.equal(run().status,'review');
 globalThis.fixtureDns=async(domain,ip)=>{writes++;assert.equal(domain,'de.nodeguard.example');assert.equal(ip,'192.0.2.10');};
 manageTunnelDeployment(actor,id,'review');await finalizeTunnelActivations();assert.equal(run().status,'succeeded');assert.equal(writes,2);
 markWorkerPoll(db,'ir-main','provision',Date.now(),true,true);markWorkerPoll(db,'exit-1','provision',Date.now(),true,true);assert.equal(manageTunnelDeployment(actor,id,'rollback').phase,'iran_restore','BBR steps belonging to the deployment must not prevent rollback');
 console.log('PASS: both BBR jobs precede fresh link verification and DNS; provider failure remains reviewable and DNS retries preserve installed tunnels.');
} finally {db.close();await rm(temp,{recursive:true,force:true});}
