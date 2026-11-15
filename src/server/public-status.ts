import { Worker } from "node:worker_threads";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { database, readWorkspace } from "./database";
import { workspaceMode } from "./inventory";
import { configuredResolver } from "./dns-resolver";
import { assessPublicNode, publicNodeCandidates, statusFresh, type Quality, type StatusPanelNode } from "@/lib/public-node-status";

const dnsCache = new Map<string, { addresses: string[]; at: string; expires: number }>();
const dnsPending = new Map<string, Promise<void>>();
async function resolveDomain(domain: string) {
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!host || isIP(host) || (dnsCache.get(host)?.expires ?? 0) > Date.now()) return;
  const pending = dnsPending.get(host);
  if (pending) return pending;
  const task = (async () => {
    try {
      const addresses = await configuredResolver().resolve4(host);
      if (dnsCache.size > 4000) dnsCache.delete(dnsCache.keys().next().value!);
      dnsCache.set(host, { addresses, at: new Date().toISOString(), expires: Date.now() + 60000 });
    } catch {
      dnsCache.set(host, { addresses: [], at: "", expires: Date.now() + 15000 });
    } finally { dnsPending.delete(host); }
  })();
  dnsPending.set(host, task);
  await task;
}
const histories = new WeakMap<DatabaseSync, { expires: number; start: number; days: Map<string, Map<number, Quality>> }>();
const historyWorkers = new WeakSet<DatabaseSync>();
function nodeHistories(db: DatabaseSync, now: number, start: number, day: number) {
  const cached = histories.get(db);
  if (cached && cached.start === start && cached.expires > now) return cached.days;
  if (!historyWorkers.has(db)) {
    historyWorkers.add(db);
    const file = String(db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file ?? "");
    // Large telemetry scans run off the request/event-loop thread. Current status never waits for history.
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.file,{readOnly:true});
      try {
        db.exec('PRAGMA busy_timeout=1000');
        const rows=db.prepare(\`SELECT CAST(observed_at / ? AS INTEGER) * ? AS day, probe.value ->> '$.nodeId' AS node_id,
          SUM((probe.value ->> '$.ok') * coalesce(probe.value ->> '$._counts.ok',1)) AS successful,
          SUM(coalesce(probe.value ->> '$._counts.ok',1)) AS samples
          FROM historical_reports, json_each(payload,'$.proxyProbes') AS probe
          WHERE observed_at BETWEEN ? AND ? AND coalesce(probe.value ->> '$.side','active')='active' GROUP BY day,node_id\`)
          .all(workerData.day,workerData.day,workerData.start,workerData.now);
        parentPort.postMessage(rows);
      } finally { db.close(); }
    `, { eval: true, workerData: { file, day, start, now } });
    const timer = setTimeout(() => { void worker.terminate(); }, 20000);
    worker.once("message", (rows: { node_id: string; day: number; successful: number; samples: number }[]) => {
      const days = new Map<string, Map<number, Quality>>();
      for (const row of rows) {
        if (!days.has(row.node_id)) days.set(row.node_id, new Map());
        const ratio = row.successful / row.samples;
        days.get(row.node_id)!.set(row.day, ratio === 1 ? "healthy" : ratio === 0 ? "offline" : "degraded");
      }
      histories.set(db, { start, expires: Date.now() + 300000, days });
    });
    worker.once("error", () => { /* Retry later; missing history is never marked as downtime. */ });
    worker.once("exit", () => {
      clearTimeout(timer); historyWorkers.delete(db);
      if (!histories.get(db) || histories.get(db)!.expires <= now) histories.set(db, { start, expires: Date.now() + 300000, days: cached?.days ?? new Map() });
    });
    worker.unref();
  }
  return cached?.start === start ? cached.days : new Map<string, Map<number, Quality>>();
}

async function loadPublicStatus(db: DatabaseSync) {
  const { state } = readWorkspace(db);
  const now = Date.now();
  const simulation = workspaceMode() === "simulation";
  const row = db.prepare("SELECT payload FROM provider_cache WHERE provider='v2board'").get();
  const catalog = row ? JSON.parse(String(row.payload)) as { nodes: StatusPanelNode[] } : { nodes: [] };
  const bindings = new Map<string,string>(Object.entries(JSON.parse(process.env.NODEGUARD_V2BOARD_MAP ?? "{}")));
  for (const row of db.prepare("SELECT panel_key,node_id FROM v2board_bindings").all()) bindings.set(String(row.panel_key), String(row.node_id));
  const candidates = publicNodeCandidates(state, catalog.nodes, bindings);
  if (!simulation) await Promise.all([...new Set(candidates.filter(entry => !state.dns.some(record =>
    record.domain.toLowerCase().replace(/\.$/, "") === entry.domain.toLowerCase().replace(/\.$/, "") && !record.stale &&
    (record.resolverObservation?.complete && statusFresh(record.resolverObservation.checkedAt, now, 300000) ||
      !record.resolverObservation && record.authoritativeStatus !== "error" && !record.proxied && statusFresh(record.lastCheck, now, 300000))))
    .map(entry => entry.domain))].map(resolveDomain));
  const day = 86400000;
  const start = Math.floor(now / day) * day - 29 * day;
  // Historical scans are opt-in on large installations; live status stays independent.
  const historyEnabled = process.env.NODEGUARD_PUBLIC_STATUS_HISTORY === "1";
  const days = historyEnabled ? nodeHistories(db, now, start, day) : new Map<string, Map<number, Quality>>();
  const nodes = candidates.map(entry => {
    const resolved = dnsCache.get(entry.domain.trim().toLowerCase().replace(/\.$/, ""));
    const { key, nodeId, ...node } = assessPublicNode(entry, state, now, simulation, resolved && resolved.expires > now && resolved.at ? resolved : undefined);
    return { ...node, history: Array.from({ length: 30 }, (_, i) => ({ at: start + i * day, status: days.get(nodeId ?? key)?.get(start + i * day) ?? "unknown" })) };
  });
  const visible = new Map(candidates.filter(n => n.node).map(n => [n.node!.id, n.name]));
  const incidents = state.incidents.filter(item => item.nodeId && visible.has(item.nodeId))
    .sort((a,b) => Date.parse(b.openedAt) - Date.parse(a.openedAt)).slice(0, 8).map(item => ({
      at: item.openedAt, resolved: item.status === "resolved",
      title: `${item.status === "resolved" ? "بازگشت اتصال" : "بررسی کیفیت اتصال"} · ${visible.get(item.nodeId!)}`,
    }));
  return { updatedAt: now, simulation, historyEnabled, nodes, incidents };
}
export type PublicStatus = Awaited<ReturnType<typeof loadPublicStatus>>;
const responses = new WeakMap<DatabaseSync, { expires: number; result: Promise<PublicStatus> }>();
export function publicStatus() {
  const db = database();
  const cached = responses.get(db);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = loadPublicStatus(db).catch(error => { responses.delete(db); throw error; });
  responses.set(db, { expires: Date.now() + 5000, result });
  return result;
}
