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

process.env.NODEGUARD_V2BOARD_ENDPOINT='https://panel.example.org/api/v1/test/server/manage/getNodes';
process.env.NODEGUARD_V2BOARD_AUTH='Bearer fixture';
const {registrationPrimaryRoutes}=await import('../src/lib/tunnel-registration.ts');
const {registerTunnel,getTunnelBundleRecipe}=await import('../src/server/topology.ts');
try{
 transaction(c=>{const {state,revision}=readWorkspace(c);state.nodes[0].backupTunnelId=undefined;state.nodes[0].backupServerId=undefined;state.tunnels=state.tunnels.filter(t=>t.side!=='backup');state.servers.push({...structuredClone(state.servers.find(s=>s.id==='exit-1')),id:'unrelated-exit',publicIpv4:'198.51.100.88'});const primary=structuredClone(state.tunnels.find(t=>t.id==='tun-main'));Object.assign(primary,{id:'direct-primary',nodeRef:{kind:'v2board',key:'vless:999'},nodeIds:[]});state.tunnels.push(primary);writeWorkspace(c,state,revision+1);});
 db.prepare("INSERT INTO provider_cache(provider,payload) VALUES ('v2board',?) ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload").run(JSON.stringify({syncedAt:new Date().toISOString(),nodes:[{id:999,key:'vless:999',type:'vless',name:'Node five',host:'five.example.org',port:2083,server_port:2083}]}));
 const state=readWorkspace().state;
 assert.deepEqual([...new Set(registrationPrimaryRoutes({kind:'inventory',id:'node-1'},state.nodes,state.tunnels).map(t=>t.foreignEndpoint.serverId))],['exit-1']);
 const ref={kind:'v2board',key:'vless:999'};
 assert.deepEqual(registrationPrimaryRoutes(ref,state.nodes,state.tunnels).map(t=>t.id),['direct-primary']);
 const input={technology:'GRE',side:'backup',iranServerId:'ir-backup',foreignServerId:'unrelated-exit',nodeRef:ref,greTransport:'udp'};
 assert.throws(()=>registerTunnel(actor,input),{code:'BACKUP_ROUTE_TOPOLOGY'},'Direct panel references must not bypass destination validation');
 assert.throws(()=>registerTunnel(actor,{...input,nodeRef:{kind:'v2board',key:'vless:998'}}),{code:'TUNNEL_NODE_CHANGED'});
 const added=registerTunnel(actor,{...input,foreignServerId:'exit-1'}).resource;
 assert.equal(added.iranEndpoint.serverId,'ir-backup');assert.equal(added.foreignEndpoint.serverId,'exit-1');
 assert.equal((await getTunnelBundleRecipe(actor,added.id)).port,2083,'TCP forwarding uses the selected node port, never an unrelated node port');
 assert.equal(readWorkspace().state.nodes.find(n=>n.domain==='five.example.org').backupTunnelId,added.id);
 assert.throws(()=>registerTunnel(actor,{...input,foreignServerId:'exit-1',routeKey:randomUUID()}),{code:'BACKUP_ALREADY_REGISTERED'});
 const {reconcilePanelRoutes}=await import('../src/server/providers.ts');
 transaction(c=>{const {state,revision}=readWorkspace(c);const node=state.nodes.find(n=>n.domain==='five.example.org');state.tunnels.find(t=>t.id===added.id).nodeRef={kind:'inventory',id:node.id};reconcilePanelRoutes(c,state);assert.equal(node.backupTunnelId,added.id,'Catalog refresh must preserve a backup registered through an imported inventory node');writeWorkspace(c,state,revision+1);});
 console.log('PASS: primary-derived destinations, rejection of unrelated hosts, direct panel bindings, selected-node TCP port and duplicate backup validation.');
}finally{db.close();await rm(temp,{recursive:true,force:true});}
