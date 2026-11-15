import assert from 'node:assert/strict';
import { publicNodeCandidates, assessPublicNode } from '../src/lib/public-node-status.ts';
const now = Date.now();
const at = new Date(now).toISOString();
const iran = { id:'ir', publicIpv4:'192.0.2.10', country:'Iran', city:'Tehran', countryCode:'IR', agent:{status:'online',lastHeartbeat:at}, services:[] };
const foreign = { id:'foreign', country:'Germany', city:'Frankfurt', countryCode:'DE', agent:{status:'online',lastHeartbeat:at}, services:[{name:'v2bx',status:'running',observedAt:at}] };
const panel = Array.from({length:8},(_,i)=>({key:`vless:${i+1}`,name:`V2ray ${i+1}`,host:`node${i+1}.example.test`}));
const state = {
 servers:[iran,foreign],
 settings:{monitoringIntervalSec:20,telemetryIntervals:{tunnelProbe:120,service:20}},
 nodes:[{id:'local',name:'Old internal name',domain:panel[0].host,primaryTunnelId:'t0',foreignServerId:'foreign',v2bxNodeState:'active',activeSide:'primary'}],
 tunnels:panel.map((p,i)=>({id:`t${i}`,nodeRef:{kind:'v2board',key:p.key},nodeIds:[],side:'primary',kind:'interface',status:'healthy',packetLoss:0,rttMs:2000,lastCheck:at,iranEndpoint:{serverId:'ir',publicIp:iran.publicIpv4},foreignEndpoint:{serverId:'foreign'}})),
 dns:panel.map((p,i)=>({nodeId:`n${i}`,domain:p.host,authoritativeStatus:'matched',aRecords:[iran.publicIpv4],lastCheck:at,resolverObservation:{complete:true,aRecords:[iran.publicIpv4],checkedAt:at}})),
};
const bindings = new Map([[panel[0].key,'local']]);
const entries=publicNodeCandidates(state,panel,bindings);
assert.equal(entries.length,8,'Include all eight directly connected panel nodes; merge imported duplicate');
assert.deepEqual(entries.map(e=>e.name),panel.map(p=>p.name));
const assess = (s=state,e=entries[0]) => assessPublicNode(e,s,now,false);
assert.equal(assess().connection,'healthy','No independent proxy probe is required');
assert.equal(assess().speed,'healthy','Zero packet loss is suitable even at high RTT');
assert.equal(assess().stability,'healthy');
function changed(mutator) {const s=structuredClone(state);mutator(s);return assessPublicNode(publicNodeCandidates(s,panel,bindings)[0],s,now,false);}
for(const loss of [0.1,5,5.1,100]) {
 const result=changed(s=>{s.tunnels[0].packetLoss=loss;});
 assert.equal(result.speed,'degraded');assert.equal(result.stability,'degraded');
 assert.equal(result.speedLabel,loss>5?'اختلال جزئی':'افت خفیف کیفیت');
}
for(const mutate of [s=>s.servers[1].services[0].status='stopped',s=>s.servers[0].agent.status='offline',s=>s.servers[1].agent.status='offline',s=>s.tunnels[0].status='offline',s=>s.dns[0].resolverObservation.aRecords=['192.0.2.99']]){
 const r=changed(mutate);assert.equal(r.connection,'offline');assert.equal(r.stability,'offline');
}
assert.equal(changed(s=>s.dns[0].resolverObservation.checkedAt=new Date(now-600000).toISOString()).connection,'unknown');
assert.equal(changed(s=>s.tunnels[0].lastCheck=new Date(now-600000).toISOString()).connection,'unknown');
assert.equal(changed(s=>s.servers[1].agent.lastHeartbeat=new Date(now-600000).toISOString()).connection,'unknown');
assert.equal(changed(s=>s.tunnels[0].kind='forwarder').speed,'unknown','Do not fabricate forwarder packet loss');
const backup=structuredClone(state);backup.tunnels.push({...backup.tunnels[0],id:'backup',side:'backup',status:'offline'});
assert.equal(assess(backup).connection,'healthy','Unused backup must not affect active route');
const missing=structuredClone(state);missing.dns=[];
const c=publicNodeCandidates(missing,panel,bindings)[0];
assert.equal(assessPublicNode(c,missing,now,false,{addresses:[iran.publicIpv4],at}).connection,'healthy');
console.log('Public status: eight-node catalog, deduplication, connection prerequisites, DNS, freshness and packet-loss boundaries passed.');

{
 const copy=structuredClone(state);const backup=structuredClone(copy.tunnels[0]);backup.id='dns-active-backup';backup.side='backup';backup.iranEndpoint={...backup.iranEndpoint,serverId:'ir-backup',publicIp:'192.0.2.11'};copy.tunnels.push(backup);copy.tunnels[0].status='offline';copy.servers.push({...structuredClone(iran),id:'ir-backup',publicIpv4:'192.0.2.11'});
 copy.dns[0].aRecords=['192.0.2.11'];copy.dns[0].resolverObservation.aRecords=['192.0.2.11'];
 assert.equal(assessPublicNode(publicNodeCandidates(copy,panel,bindings)[0],copy,now,false).connection,'healthy','Actual DNS-selected backup takes precedence over stale inventory selection');
}

{
 const copy=structuredClone(state);copy.servers[1].publicIpv4='198.51.100.9';copy.servers[0].agent.status='offline';copy.tunnels[0].status='offline';copy.dns[0].aRecords=['198.51.100.9'];copy.dns[0].resolverObservation.aRecords=['198.51.100.9'];
 const result=assessPublicNode(publicNodeCandidates(copy,panel,bindings)[0],copy,now,false);assert.equal(result.connection,'healthy');assert.equal(result.status,'healthy');assert.equal(result.speed,'unknown','A direct foreign endpoint must not inherit unrelated tunnel loss');
 copy.servers[1].services[0].status='stopped';assert.equal(assessPublicNode(publicNodeCandidates(copy,panel,bindings)[0],copy,now,false).connection,'offline');
}
