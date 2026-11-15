import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isIP } from "node:net";
import { z } from "zod";
import { decorateNodes, activeTunnelId } from "@/lib/health";
import { can } from "@/lib/rbac";
import { backupTunnelMatches, BUNDLE_TECHS } from "@/lib/topology";
import { auditOf } from "@/stores/runtime";
import type { DemoUser, DNSRecord, Node, Protocol, Tunnel, V2BoardCatalogEntry } from "@/types";
import { database, readWorkspace, transaction, writeWorkspace, type Workspace } from "./database";
import { digest } from "./auth";
import { provisionBusy } from "./provision";
import { monitorDomain, monitoredDns, monitoredFailover, monitoredNode, workspaceMode } from "./inventory";
import { ApiError } from "./http";
import { normalDomain, normalIpv6, observeResolver, sameRecords } from "./dns-resolver";
import { updateDnsIncident } from "./observed-incidents";
import { enqueueTelegramAlerts } from "./telegram";
import { canStorePanelCredentials, getPanelCredentials, savePanelCredentials, type PanelCredentials } from "./provider-secrets";
import { publicDispatcher, validatePublicHttps } from "./public-https";
import { arvanEnabled, arvanZoneFor, listArvanRecords } from "./arvan-dns";
import { managedDnsConfigured, managedDnsObservations, managedDnsZoneFor } from "./managed-dns";
import { dnsProviderNames } from "@/lib/managed-dns";

const port = z.union([z.number(), z.string().regex(/^\d{1,5}$/).transform(Number)]).pipe(z.number().int().min(1).max(65535));
const panelCount = z.union([
  z.number().int().min(0).max(10_000_000),
  z.string().regex(/^\d{1,7}$/).transform(Number),
  z.null(),
]).optional().catch(undefined);
const panelParent = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d{1,15}$/).transform(Number),
  z.null(),
]).optional().catch(undefined);
const board = z.object({
  data: z.array(z.object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,20}$/)]),
    type: z.string().regex(/^[a-z0-9-]{1,24}$/i),
    name: z.string().max(256),
    host: z.string().min(1).max(253),
    port: z.union([port, z.string().regex(/^\d{1,5}-\d{1,5}$/)]),
    server_port: z.union([port, z.null(), z.undefined()]).catch(0),
    version: z.union([z.string(), z.number()]).optional(),
    tls: z.unknown(),
    security: z.unknown(),
    network: z.unknown(),
    transport: z.unknown(),
    online: panelCount,
    online_user: panelCount,
    parent_id: panelParent,
  })).max(10000),
});
const cloudflare = z.object({
  success: z.literal(true),
  result: z.array(z.object({
    type: z.string().max(16), name: z.string().max(253), content: z.string().max(8192),
    ttl: z.number().int().nonnegative(), proxied: z.boolean().optional(),
  })).max(5000),
  result_info: z.object({ total_pages: z.number().int().nonnegative() }).optional(),
});

export function boardEnabled() {
  try {
    return Boolean(getPanelCredentials(database()));
  } catch {
    return false;
  }
}
export const cloudflareEnabled = () => Boolean(process.env.NODEGUARD_CF_ZONE_ID && process.env.NODEGUARD_CF_TOKEN);
export const authoritativeDnsEnabled = () => cloudflareEnabled() || arvanEnabled() || managedDnsConfigured();

async function readUpstream(url: URL, authorization?: string, options?: { protected?: boolean; login?: { email: string; password: string }; body?: object }) {
  if (options?.protected) validatePublicHttps(url);
  const dispatcher = options?.protected ? publicDispatcher() : undefined;
  try {
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Unsafe URL");
    const headers = new Headers({ Accept: "application/json" });
    if (authorization) headers.set("Authorization", authorization);
    const body = options?.login ?? options?.body;
    if (body) headers.set("Content-Type", "application/json");
    const response = await fetch(url, {
      method: body ? "POST" : "GET", headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (options?.login) throw new ApiError(502, "PANEL_LOGIN", "ورود به V2Board ناموفق بود. آدرس، ایمیل، رمز و دسترسی ادمین را بررسی کنید.");
      if (options?.protected && [401, 403].includes(response.status)) {
        throw new ApiError(502, "PANEL_SESSION", "دسترسی نشست V2Board معتبر نیست. اتصال ادمین را دوباره انجام دهید.");
      }
      if (options?.body && response.status === 422) {
        throw new ApiError(422, "PANEL_NODE_VALIDATION", "V2Board فیلدهای نود را نپذیرفت. نوع نود و تنظیمات پروتکل را بررسی کنید.");
      }
      throw new Error("Upstream request failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Upstream response too large");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "UPSTREAM", options?.body ? "نتیجهٔ ذخیره در V2Board مشخص نیست. فهرست نودها را بررسی کنید." : "خواندن داده از سرویس بیرونی انجام نشد.");
  } finally {
    await dispatcher?.destroy().catch(() => {});
  }
}

type BoardEntry = z.output<typeof board>["data"][number];
type CachedBoardEntry = Omit<BoardEntry, "tls" | "security" | "network" | "transport" | "online" | "online_user" | "parent_id"> &
  Pick<V2BoardCatalogEntry, "key" | "tls" | "transport">;
type PanelPresence = { online?: number; parentKey?: string };

function panelTls(value: unknown): V2BoardCatalogEntry["tls"] {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (mode === 2 || mode === "2" || mode === "reality") return "Reality";
  if (mode === true || mode === 1 || mode === "1" || mode === "tls" || mode === "xtls") return "TLS";
  if (mode === false || mode === 0 || mode === "0" || mode === "none") return "none";
}

const transportLabels = new Map([
  ["tcp", "TCP"], ["raw", "TCP"], ["udp", "UDP"], ["ws", "WebSocket (TCP)"], ["websocket", "WebSocket (TCP)"],
  ["grpc", "gRPC (TCP)"], ["http", "HTTP (TCP)"], ["h2", "HTTP/2 (TCP)"], ["httpupgrade", "HTTP Upgrade (TCP)"],
  ["kcp", "mKCP (UDP)"], ["mkcp", "mKCP (UDP)"], ["quic", "QUIC (UDP)"], ["h3", "HTTP/3 (UDP)"],
  ["xhttp", "XHTTP"], ["splithttp", "SplitHTTP"],
]);

function panelTransport(value: unknown) {
  return typeof value === "string" ? transportLabels.get(value.trim().toLowerCase()) : undefined;
}
type CachedBoard = { nodes: CachedBoardEntry[]; presence?: Record<string, PanelPresence>; syncedAt: string | null };

function readPresence(cache: CachedBoard, key: string): PanelPresence {
  const item = cache.presence?.[key];
  if (!item || typeof item !== "object") return {};
  const count = item.online;
  const online = typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 10_000_000 ? count : undefined;
  const parentKey = typeof item.parentKey === "string" && item.parentKey !== key && /^[a-z0-9-]+:\d{1,16}$/i.test(item.parentKey) ? item.parentKey : undefined;
  return { ...(online !== undefined ? { online } : {}), ...(parentKey ? { parentKey } : {}) };
}

function cachedBoard(db: DatabaseSync): CachedBoard {
  const row = db.prepare("SELECT payload FROM provider_cache WHERE provider='v2board'").get();
  return row ? JSON.parse(String(row.payload)) as CachedBoard : { nodes: [], syncedAt: null };
}

const panelLeaseMs = 20000;
const panelRetryMs = 60000;
const catalogFreshMs = 15 * 60000;

function panelIntervalMs() {
  const value = process.env.NODEGUARD_V2BOARD_POLL_SECONDS ?? "300";
  const seconds = Number(value);
  return /^\d+$/.test(value) && seconds >= 30 && seconds <= 900 ? seconds * 1000 : null;
}

export function panelSyncSettings() {
  const automatic = workspaceMode() === "monitor" && boardEnabled() && process.env.NODEGUARD_ENABLE_V2BOARD_MONITOR === "1";
  const interval = automatic ? panelIntervalMs() : null;
  return { automatic, intervalSec: interval === null ? null : interval / 1000 };
}

export function observedPanelBindingIsCurrent(record: DNSRecord, now: number) {
  return !record.v2boardMissing && now - Date.parse(record.v2boardObservedAt ?? "") <= catalogFreshMs;
}

function panelSchedule(db: DatabaseSync) {
  return db.prepare("SELECT * FROM v2board_sync WHERE singleton=1").get();
}

function nextPanelSync(cache: CachedBoard, schedule: ReturnType<typeof panelSchedule>, interval: number) {
  if (schedule?.error_code) return Number(schedule.attempted_at) + panelRetryMs;
  return (Date.parse(cache.syncedAt ?? "") || 0) + interval;
}

export function boardBindings(db: DatabaseSync) {
  const mapping = z.record(z.string().regex(/^[a-z0-9-]+:\d+$/), z.string().max(96))
    .parse(JSON.parse(process.env.NODEGUARD_V2BOARD_MAP ?? "{}"));
  const bindings = new Map(Object.entries(mapping));
  for (const row of db.prepare("SELECT panel_key,node_id FROM v2board_bindings").all()) {
    const key = String(row.panel_key);
    const node = String(row.node_id);
    if (bindings.has(key) && bindings.get(key) !== node) throw new Error("Conflicting V2Board binding");
    bindings.set(key, node);
  }
  if (new Set(bindings.values()).size !== bindings.size) throw new Error("Duplicate V2Board target mapping");
  return bindings;
}

export function nodeHasPanelBinding(db: DatabaseSync, nodeId: string) {
  return boardEnabled() && [...boardBindings(db).values()].includes(nodeId);
}

function protocolOf(item: CachedBoardEntry): Protocol | undefined {
  switch (item.type.toLowerCase()) {
    case "vless": return "VLESS";
    case "vmess": return "VMess";
    case "trojan": return "Trojan";
    case "shadowsocks": return "Shadowsocks";
    case "hysteria2": return "Hysteria2";
    case "hysteria": return Number(item.version) === 2 ? "Hysteria2" : undefined;
  }
}

// Resolve the current node host at execution time; tunnel registrations never own a domain.
export function currentNodeDomain(db: DatabaseSync, nodeId: string) {
  const node = readWorkspace(db).state.nodes.find((node) => node.id === nodeId);
  if (!node) throw new ApiError(404, "NODE_UNKNOWN", "نود متصل پیدا نشد.");
  const binding = [...boardBindings(db)].find(([, id]) => id === nodeId);
  if (binding && (!cachedBoard(db).syncedAt || Date.now() - Date.parse(cachedBoard(db).syncedAt!) > catalogFreshMs)) throw new ApiError(409, "PANEL_CATALOG_STALE", "برای واکشی دامنه، کاتالوگ نودها را تازه‌سازی کنید.");
  const host = binding ? panelTunnelHost(db, binding[0]) : node?.domain;
  const domain = host?.trim().toLowerCase().replace(/\.$/, "");
  if (!domain || isIP(domain) || !monitorDomain.safeParse(domain).success) throw new ApiError(409, "NODE_DOMAIN_UNAVAILABLE", "دامنهٔ فعلی نود متصل در دسترس نیست.");
  return domain;
}

export function panelTunnelHost(db: DatabaseSync, key: string) {
  return boardEnabled() ? cachedBoard(db).nodes.find((node) => node.key === key)?.host : undefined;
}

export function reconcilePanelRoutes(db: DatabaseSync, state: Workspace) {
  for (const entry of cachedBoard(db).nodes) {
    let node = state.nodes.find(n => n.id === boardBindings(db).get(entry.key));
    const paths = state.tunnels.filter(t => t.nodeRef?.kind === "v2board" && t.nodeRef.key === entry.key ||
      Boolean(node && (t.nodeRef?.kind === "inventory" && t.nodeRef.id === node.id ||
        t.id === node.primaryTunnelId || t.id === node.backupTunnelId || t.nodeIds.includes(node.id))));
    const primary = paths.find(t => t.id === node?.primaryTunnelId && t.side === "primary")
      ?? paths.find(t => t.side === "primary" && t.status === "healthy") ?? paths.find(t => t.side === "primary");
    const protocol = protocolOf(entry);
    if (!primary || !protocol || !monitorDomain.safeParse(entry.host).success || isIP(entry.host) || typeof entry.port !== "number") continue;
    const foreign = state.servers.find(s => s.id === primary.foreignEndpoint.serverId);
    if (!foreign) continue;
    const backups = paths.filter(t => t.side === "backup" && t.foreignEndpoint.serverId === foreign.id && t.iranEndpoint.serverId !== primary.iranEndpoint.serverId);
    const backup = backups.find(t => t.id === node?.backupTunnelId) ?? (backups.length === 1 ? backups[0] : undefined);
    if (!node) {
      if (state.nodes.some(n => n.domain.toLowerCase() === entry.host.toLowerCase()) || state.nodes.length >= 2000) continue;
      const id = "panel-route-" + digest(entry.key).slice(0, 24);
      node = monitoredNode({ id, name: entry.name, protocol, domain: entry.host, port: entry.port,
        primaryServerId: primary.iranEndpoint.serverId, foreignServerId: foreign.id, primaryTunnelId: primary.id, activeSide: "primary" }, foreign);
      state.nodes.push(node); state.dns.push(monitoredDns(node, entry.host)); state.policies.push(monitoredFailover(id));
      db.prepare("INSERT INTO v2board_bindings(panel_key,node_id) VALUES (?,?) ON CONFLICT(panel_key) DO UPDATE SET node_id=excluded.node_id").run(entry.key, id);
    }
    Object.assign(node, { domain: entry.host, name: entry.name, port: entry.port, primaryTunnelId: primary.id,
      primaryServerId: primary.iranEndpoint.serverId, foreignServerId: foreign.id,
      backupTunnelId: backup?.id, backupServerId: backup?.iranEndpoint.serverId,
      activeSide: node.activeSide === "backup" && backup ? "backup" : "primary", tunnelIds: paths.map(t => t.id) });
    for (const path of paths) path.nodeIds = [...new Set([...path.nodeIds, node.id])];
  }
}

export function tunnelForwarding(db: DatabaseSync, nodes: Node[]) {
  const bindings = new Map([...boardBindings(db)].map(([key, nodeId]) => [nodeId, key]));
  const cache = cachedBoard(db);
  const panelNodes = new Map(cache.nodes.map((node) => [node.key, node]));
  return (tunnel: Tunnel): { port?: number; targetPort?: number; panel?: boolean; error?: string } => {
    if (!BUNDLE_TECHS.some((technology) => technology === tunnel.technology) && !["GOST", "Rathole", "Backhaul"].includes(tunnel.technology)) {
      return { port: tunnel.iranEndpoint.port };
    }
    const ref = tunnel.nodeRef;
    const linked = ref?.kind === "inventory" ? nodes.filter((node) => node.id === ref.id)
      : nodes.filter((node) => node.primaryTunnelId === tunnel.id || node.backupTunnelId === tunnel.id);
    if (ref?.kind === "inventory" && !linked.length) return { error: "نود انتخاب‌شدهٔ تونل در موجودی پیدا نشد." };
    const references = ref?.kind === "v2board" ? [{ key: ref.key, port: undefined }]
      : linked.map((node) => ({ key: bindings.get(node.id), port: node.port }));
    if (!references.length) return { port: tunnel.iranEndpoint.port };

    const pairs = [];
    for (const reference of references) {
      const panel = reference.key ? panelNodes.get(reference.key) : undefined;
      if (reference.key && !panel && (ref?.kind === "v2board" || cache.syncedAt)) {
        return { panel: true, error: "نود تونل در کاتالوگ V2Board در دسترس نیست. فهرست نودها را تازه‌سازی کنید." };
      }
      const listen = port.safeParse(panel?.port ?? reference.port);
      const target = port.safeParse(panel?.server_port ?? (listen.success ? listen.data : undefined));
      if (!listen.success || !target.success) return { panel: Boolean(reference.key), error: "پورت نود و پورت سرویس خارج باید عدد ثابت بین ۱ و ۶۵۵۳۵ باشند." };
      pairs.push({ port: listen.data, targetPort: target.data === listen.data ? undefined : target.data });
    }
    const [first] = pairs;
    if (pairs.some((item) => item.port !== first.port || item.targetPort !== first.targetPort)) {
      return { error: "این مسیر به نودهایی با پورت‌های متفاوت متصل است. نود مبنای هدایت باید مشخص باشد." };
    }
    return { ...first, panel: references.some((item) => Boolean(item.key)) };
  };
}

export function panelCatalog() {
  const db = database();
  const cache = cachedBoard(db);
  const bindings = boardBindings(db);
  const existing = new Set(readWorkspace(db).state.nodes.map((item) => item.id));
  const nodes = cache.nodes.map((item): V2BoardCatalogEntry => {
    const nodeId = bindings.get(item.key);
    return {
      key: item.key, name: item.name, type: item.type, host: item.host, port: item.port,
      tls: item.tls, transport: item.transport,
      protocol: protocolOf(item), nodeId: nodeId && existing.has(nodeId) ? nodeId : undefined,
      fingerprint: digest(JSON.stringify(item)),
      ...readPresence(cache, item.key),
    };
  });
  const enabled = workspaceMode() === "monitor" && boardEnabled();
  const settings = panelSyncSettings();
  const schedule = panelSchedule(db);
  const now = Date.now();
  const next = settings.intervalSec === null ? 0 : nextPanelSync(cache, schedule, settings.intervalSec * 1000);
  return {
    enabled, nodes, syncedAt: cache.syncedAt, ...settings,
    inProgress: enabled && Number(schedule?.lease_until) > now,
    stale: Boolean(cache.syncedAt && now - Date.parse(cache.syncedAt) > catalogFreshMs),
    lastAttemptAt: schedule ? new Date(Number(schedule.attempted_at)).toISOString() : null,
    nextSyncAt: next ? new Date(Math.max(now, next)).toISOString() : null,
    lastError: typeof schedule?.error_code === "string" ? schedule.error_code : null,
  };
}

const importInput = z.object({
  key: z.string().regex(/^[a-z0-9-]+:\d{1,20}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  domain: monitorDomain.refine((value) => !isIP(value)),
  primaryTunnelId: z.string().min(1).max(96),
}).strict();

export function importPanelNode(actor: DemoUser, value: unknown) {
  if (!can(actor.role, "node.edit") || !can(actor.role, "integration.edit")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی مدیریت نود و یکپارچه‌سازی لازم است.");
  }
  if (workspaceMode() !== "monitor" || !boardEnabled()) throw new ApiError(503, "PROVIDER_DISABLED", "واردکردن نود در محیط پایش و اتصال فعال انجام می‌شود.");
  const parsed = importInput.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "PANEL_IMPORT", "کلید، دامنه یا مسیرهای تونل معتبر نیست.", parsed.error.issues);
  const input = parsed.data;
  const domain = input.domain.toLowerCase();

  return transaction((db) => {
    const { state, revision } = readWorkspace(db);
    const bindings = boardBindings(db);
    if (bindings.has(input.key)) {
      const local = db.prepare("SELECT node_id FROM v2board_bindings WHERE panel_key=?").get(input.key);
      const node = state.nodes.find((item) => item.id === local?.node_id);
      if (node && node.domain === domain && node.primaryTunnelId === input.primaryTunnelId) {
        return { node, replay: true };
      }
      throw new ApiError(409, "PANEL_BOUND", "این نود پنل قبلاً برای پایش نگاشت شده است.");
    }
    const cache = cachedBoard(db);
    const entry = cache.nodes.find((item) => item.key === input.key);
    if (!cache.syncedAt || Date.now() - Date.parse(cache.syncedAt) > catalogFreshMs || !entry ||
        digest(JSON.stringify(entry)) !== input.fingerprint) {
      throw new ApiError(409, "PANEL_CATALOG_STALE", "نسخهٔ کاتالوگ قدیمی یا تغییر کرده است. دوباره پنل را بخوانید.");
    }
    const protocol = protocolOf(entry);
    if (!protocol || typeof entry.port !== "number" || (!isIP(entry.host) && !monitorDomain.safeParse(entry.host.replace(/\.$/, "")).success)) {
      throw new ApiError(422, "PANEL_NODE_UNSUPPORTED", "پروتکل، پورت ثابت یا میزبان معتبر برای واردکردن لازم است.");
    }
    if (state.nodes.some((node) => node.domain.toLowerCase() === domain)) {
      throw new ApiError(409, "PANEL_DOMAIN_IN_USE", "این دامنه به یک نود موجود تعلق دارد.");
    }
    if (state.nodes.length >= 2000) throw new ApiError(409, "PANEL_NODE_LIMIT", "ظرفیت موجودی نودها پر است.");
    const primary = state.tunnels.find((item) => item.id === input.primaryTunnelId && item.side === "primary");
    const backups = state.tunnels.filter((item) => item.side === "backup" && item.nodeRef?.kind === "v2board" && item.nodeRef.key === input.key);
    if (backups.length > 1) throw new ApiError(409, "BACKUP_AMBIGUOUS", "بیش از یک بکاپ برای این نود ثبت شده است.");
    const backup = backups[0];
    const foreign = state.servers.find((item) => item.id === primary?.foreignEndpoint.serverId && item.roles.includes("foreign"));
    if (!primary || !foreign || (backup && !backupTunnelMatches(primary, backup))) {
      throw new ApiError(422, "PANEL_TOPOLOGY", "مسیر اصلی و پشتیبان باید از دو میزبان ایران به یک خروج خارجی برسند.");
    }
    if (provisionBusy(db, primary.iranEndpoint.serverId, backup?.iranEndpoint.serverId, foreign.id)) {
      throw new ApiError(409, "PROVISION_HOST_BUSY", "ابتدا اجرای فعال روی میزبان‌های مسیر را پایان دهید.");
    }
    const id = "panel-" + randomUUID();
    const node = monitoredNode({
      id, domain, protocol, port: entry.port, name: entry.name.trim().slice(0, 128) || input.key, activeSide: "primary",
      primaryServerId: primary.iranEndpoint.serverId, backupServerId: backup?.iranEndpoint.serverId, foreignServerId: foreign.id,
      primaryTunnelId: primary.id, backupTunnelId: backup?.id,
    }, foreign);
    state.dns.push({ ...monitoredDns(node, entry.host), v2boardObservedAt: cache.syncedAt });
    state.policies.push(monitoredFailover(id));
    state.tunnels = state.tunnels.map((item) => item.id === primary.id || item.id === backup?.id ||
      item.nodeRef?.kind === "v2board" && item.nodeRef.key === input.key && item.foreignEndpoint.serverId === foreign.id
      ? { ...item, nodeIds: [...new Set([...item.nodeIds, id])] } : item);
    state.nodes = decorateNodes([...state.nodes, node], state.servers, state.tunnels, state.dns, state.settings, true);
    const audit = auditOf({ ...state, currentUserId: actor.id }, "v2board.import", id, input.key);
    state.audit = [{ ...audit, simulated: false }, ...state.audit].slice(0, 2000);
    db.prepare("INSERT INTO v2board_bindings (panel_key,node_id) VALUES (?,?)").run(input.key, id);
    writeWorkspace(db, state, revision + 1);
    return { node: state.nodes.find((item) => item.id === id)!, replay: false };
  });
}


// Match the browser email field and allow V2Board accounts with a single-label domain.
const panelLoginEmail = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const adminLoginInput = z.object({
  address: z.string().trim().min(1).max(2048),
  email: z.string().trim().max(254).regex(panelLoginEmail),
  password: z.string().min(1).max(1024),
}).strict();
const adminSession = z.object({ data: z.object({
  is_admin: z.union([z.literal(true), z.literal(1), z.literal("1")]),
  auth_data: z.string().regex(/^[^\s\x00-\x1f\x7f]{1,4096}$/),
}) });
const catalogPath = /^((?:\/[a-z0-9_-]+)*)\/api\/v1\/([a-z0-9_-]+)\/server\/manage\/getNodes\/?$/i;

export function v2BoardAdminClient() {
  const credential = getPanelCredentials(database());
  const catalog = credential && URL.parse(credential.endpoint);
  const path = catalog && catalog.pathname.match(catalogPath);
  if (!credential || !catalog || !path || catalog.search) {
    throw new ApiError(503, "PROVIDER_CONFIG", "اتصال ادمین V2Board را در تنظیمات برقرار کنید.");
  }
  const [, prefix, adminPath] = path;
  const base = new URL(`${prefix}/api/v1/${adminPath}/`, catalog.origin);
  return {
    panelUrl: new URL(prefix || "/", catalog.origin).href.replace(/\/$/, ""),
    request: (endpoint: string, body?: object) => readUpstream(new URL(endpoint, base), credential.authorization, { protected: true, body }),
    backendConfig: (nodeType: string, nodeId: number, token: string) => {
      const url = new URL(`${prefix}/api/v1/server/UniProxy/config`, catalog.origin);
      url.search = new URLSearchParams({ node_type: nodeType, node_id: String(nodeId), token }).toString();
      return readUpstream(url, undefined, { protected: true });
    },
  };
}

function adminUrls(address: string) {
  const url = URL.parse(address);
  const path = url?.pathname.match(catalogPath) ??
    url?.pathname.match(/^((?:\/[a-z0-9_-]+)*)\/([a-z0-9_-]+)\/?$/i);
  if (!url || !path || url.search) throw new ApiError(422, "PANEL_ADDRESS", "آدرس کامل صفحهٔ ادمین V2Board با مسیر اختصاصی لازم است.");
  validatePublicHttps(url);
  const [ , prefix, adminPath] = path;
  return {
    login: new URL(prefix + "/api/v1/passport/auth/login", url.origin),
    catalog: new URL(prefix + "/api/v1/" + adminPath + "/server/manage/getNodes", url.origin),
  };
}

export async function connectPanelAdmin(actor: DemoUser, value: unknown) {
  if (!can(actor.role, "integration.edit")) throw new ApiError(403, "FORBIDDEN", "دسترسی مدیریت اتصال V2Board لازم است.");
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "اتصال واقعی در حالت پایش در دسترس است.");
  if (!canStorePanelCredentials()) throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید رمزنگاری اعتبارنامه در کنترل‌پلین تنظیم نشده است.");
  const parsed = adminLoginInput.safeParse(value);
  if (!parsed.success) {
    const emailInvalid = parsed.error.issues.some((issue) => issue.path[0] === "email");
    throw new ApiError(422, "PANEL_LOGIN_INPUT", emailInvalid
      ? "شناسهٔ حساب V2Board را به شکل user@domain وارد کنید."
      : "آدرس صفحهٔ ادمین و رمز عبور لازم است.");
  }
  const { address, email, password } = parsed.data;
  const urls = adminUrls(address);
  const lease = claimPanelSync();
  if (!lease) throw new ApiError(409, "PANEL_SYNC_BUSY", "خواندن دیگری از V2Board در حال اجراست.");
  try {
    const db = database();
    if (boardBindings(db).size) {
      const previous = getPanelCredentials(db);
      if (!previous || previous.endpoint.replace(/\/$/, "") !== urls.catalog.href) {
        throw new ApiError(409, "PANEL_BOUND_ADDRESS", "برای حفظ نگاشت نودها، دوباره به آدرس ادمین همین پنل وصل شوید.");
      }
    }
    const response = adminSession.safeParse(await readUpstream(urls.login, undefined, { protected: true, login: { email, password } }));
    if (!response.success) throw new ApiError(502, "PANEL_ADMIN_REQUIRED", "پاسخ ورود شامل نشست ادمین V2Board نیست.");
    return await readPanel(lease, actor, { endpoint: urls.catalog.href, authorization: response.data.data.auth_data });
  } finally {
    database().prepare("UPDATE v2board_sync SET lease=NULL,lease_until=NULL WHERE singleton=1 AND lease=?").run(lease);
  }
}

export async function refreshPanel(actor: DemoUser) {
  if (!can(actor.role, "integration.edit")) throw new ApiError(403, "FORBIDDEN", "دسترسی به همگام‌سازی پنل مجاز نیست.");
  if (workspaceMode() !== "monitor" || !boardEnabled()) {
    throw new ApiError(503, "PROVIDER_DISABLED", "اتصال خواندنی V2Board در محیط پایش لازم است.");
  }
  const lease = claimPanelSync();
  if (!lease) throw new ApiError(409, "PANEL_SYNC_BUSY", "خواندن دیگری از V2Board در حال اجراست.");
  return syncPanel(lease, actor);
}

export async function tickPanelSync() {
  const settings = panelSyncSettings();
  if (!settings.automatic) throw new ApiError(503, "PANEL_MONITOR_DISABLED", "همگام‌سازی دوره‌ای V2Board فعال نیست.");
  if (settings.intervalSec === null) throw new ApiError(503, "PANEL_MONITOR_CONFIG", "فاصلهٔ همگام‌سازی باید بین ۳۰ تا ۹۰۰ ثانیه باشد.");
  const lease = claimPanelSync(settings.intervalSec * 1000);
  if (!lease) return { synced: false, errors: 0 };
  try {
    const result = await syncPanel(lease);
    return { synced: true, count: result.count, errors: 0 };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { synced: false, errors: 1 };
  }
}

function claimPanelSync(interval?: number) {
  return transaction((db) => {
    const now = Date.now();
    const schedule = panelSchedule(db);
    if (Number(schedule?.lease_until) > now ||
        (interval !== undefined && nextPanelSync(cachedBoard(db), schedule, interval) > now)) return null;
    const lease = randomUUID();
    db.prepare(`
      INSERT INTO v2board_sync (singleton,lease,lease_until,attempted_at) VALUES (1,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until,attempted_at=excluded.attempted_at
    `).run(lease, now + panelLeaseMs, now);
    return lease;
  });
}

function panelAudit(actor: DemoUser | undefined, action: string, detail: string, at: string) {
  return {
    id: randomUUID(), at, actor: actor?.name ?? "V2Board Worker", role: actor?.role ?? ("system" as const),
    action, target: "v2board", detail, simulated: false,
  };
}

function settlePanelFailure(lease: string, actor: DemoUser | undefined, error: ApiError) {
  transaction((db) => {
    const now = Date.now();
    const schedule = panelSchedule(db);
    if (schedule?.lease !== lease || Number(schedule.lease_until) <= now) return;
    const { revision, state } = readWorkspace(db);
    const hasCache = Boolean(cachedBoard(db).syncedAt);
    const at = new Date(now).toISOString();
    state.integrations = state.integrations.map((i) => i.type !== "v2board" ? i : {
      ...i, lastTest: at, status: hasCache ? "degraded" : "disconnected", message: error.message,
    });
    if (actor || schedule.error_code !== error.code) {
      state.audit = [panelAudit(actor, "v2board.read.failed", error.message, at), ...state.audit].slice(0, 2000);
    }
    db.prepare("UPDATE v2board_sync SET lease=NULL,lease_until=NULL,attempted_at=?,error_code=? WHERE singleton=1")
      .run(now, error.code);
    writeWorkspace(db, state, revision + 1);
  });
}

async function syncPanel(lease: string, actor?: DemoUser) {
  try {
    return await readPanel(lease, actor);
  } catch (error) {
    settlePanelFailure(lease, actor, error instanceof ApiError ? error
      : new ApiError(503, "PANEL_SYNC_FAILED", "همگام‌سازی کاتالوگ ناموفق بود."));
    throw error;
  }
}

async function readPanel(lease: string, actor?: DemoUser, connection?: PanelCredentials) {
  const credentials = connection ? { ...connection, managed: true } : getPanelCredentials(database());
  if (!credentials) throw new ApiError(503, "PROVIDER_DISABLED", "اتصال V2Board فعال نیست.");
  const endpoint = URL.parse(credentials.endpoint);
  if (!endpoint || !/\/api\/v1\/[^/]+\/server\/manage\/getNodes\/?$/.test(endpoint.pathname) || endpoint.search) {
    throw new ApiError(503, "PROVIDER_CONFIG", "مسیر خواندن V2Board باید به getNodes ختم شود.");
  }
  const response = board.safeParse(await readUpstream(endpoint, credentials.authorization, { protected: credentials.managed }));
  if (!response.success) throw new ApiError(502, "PANEL_SCHEMA", "پاسخ پنل با قرارداد V2Board Admin v1 سازگار نیست.");
  const presence: Record<string, PanelPresence> = {};
  // Online counts change on every read and stay outside the catalog fingerprint.
  const nodes: CachedBoardEntry[] = response.data.data.map(({ tls, security, network, transport, online, online_user, parent_id, ...item }) => {
    const key = `${item.type.toLowerCase()}:${item.id}`;
    const count = typeof online === "number" ? online : typeof online_user === "number" ? online_user : undefined;
    const parentKey = parent_id ? `${item.type.toLowerCase()}:${parent_id}` : undefined;
    if (count !== undefined || parentKey) presence[key] = { ...(count !== undefined ? { online: count } : {}), ...(parentKey ? { parentKey } : {}) };
    return {
      ...item, key,
      tls: panelTls(security) ?? panelTls(tls),
      transport: panelTransport(network) ?? panelTransport(transport),
    };
  });
  if (new Set(nodes.map((item) => item.key)).size !== nodes.length) {
    throw new ApiError(502, "PANEL_DUPLICATE", "پنل برای یک نوع و شناسه چند رکورد فرستاده است.");
  }
  return transaction((db) => {
    const now = Date.now();
    const schedule = panelSchedule(db);
    if (schedule?.lease !== lease || Number(schedule.lease_until) <= now) {
      throw new ApiError(409, "PANEL_SYNC_LEASE", "مهلت خواندن کاتالوگ گذشته است.");
    }
    if (connection) savePanelCredentials(db, connection);
    const syncedAt = new Date(now).toISOString();
    const previous = cachedBoard(db);
    const bindings = boardBindings(db);
    const byNode = new Map(nodes.flatMap((item) => {
      const nodeId = bindings.get(item.key);
      return nodeId ? [[nodeId, item] as const] : [];
    }));
    const { revision, state } = readWorkspace(db);
    const mapped = state.nodes.filter((node) => byNode.has(node.id)).length;
    const bound = new Set(bindings.values());
    state.dns = state.dns.map((record) => {
      if (!bound.has(record.nodeId)) return record;
      const item = byNode.get(record.nodeId);
      if (!item) return { ...record, v2boardMissing: true, v2boardObservedAt: syncedAt };
      const changed = item.host !== record.v2boardHost;
      return {
        ...record, v2boardHost: item.host, v2boardIp: isIP(item.host) ? item.host : undefined,
        v2boardMissing: undefined, v2boardObservedAt: syncedAt,
        ...(changed ? { authoritativeStatus: "propagation" as const, resolverStatus: "propagation" as const, note: "مقصد جدید پنل دریافت شد. بررسی DNS را اجرا کنید." } : {}),
      };
    });
    state.nodes = decorateNodes(state.nodes, state.servers, state.tunnels, state.dns, state.settings, true);
    state.integrations = state.integrations.map((i) => i.type !== "v2board" ? i : {
      ...i, lastSync: syncedAt, lastTest: syncedAt, status: "connected", config: { ...i.config, imported: String(nodes.length) },
      message: `${nodes.length} نود از پنل خوانده شد. ${mapped} نود نگاشت شده است.`,
    });
    if (actor || schedule.error_code || !previous.syncedAt || JSON.stringify(previous.nodes) !== JSON.stringify(nodes)) {
      const audit = panelAudit(actor, "v2board.read", `${nodes.length} نود خوانده شد`, syncedAt);
      state.audit = [audit, ...state.audit].slice(0, 2000);
    }
    db.prepare("UPDATE v2board_sync SET lease=NULL,lease_until=NULL,attempted_at=?,error_code=NULL WHERE singleton=1").run(now);
    db.prepare("INSERT INTO provider_cache VALUES ('v2board', ?) ON CONFLICT(provider) DO UPDATE SET payload = excluded.payload").run(JSON.stringify({ nodes, mapped, syncedAt, presence }));
    reconcilePanelRoutes(db, state);
    writeWorkspace(db, state, revision + 1);
    return { count: nodes.length, mapped, syncedAt };
  });
}

async function listCloudflareRecords(domain: string) {
  if (!cloudflareEnabled()) throw new ApiError(503, "PROVIDER_DISABLED", "اتصال خواندنی Cloudflare پیکربندی نشده است.");
  const zone = process.env.NODEGUARD_CF_ZONE_ID!;
  if (!/^[a-f0-9]{32}$/i.test(zone)) throw new ApiError(503, "PROVIDER_CONFIG", "شناسهٔ ناحیهٔ Cloudflare معتبر نیست.");
  const endpoint = new URL(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`);
  endpoint.searchParams.set("name.exact", domain);
  endpoint.searchParams.set("per_page", "100");
  const payload = cloudflare.safeParse(await readUpstream(endpoint, "Bearer " + process.env.NODEGUARD_CF_TOKEN));
  if (!payload.success || (payload.data.result_info?.total_pages ?? 1) > 1) {
    throw new ApiError(502, "DNS_SCHEMA", "پاسخ کامل رکوردهای Cloudflare دریافت نشد.");
  }
  return payload.data.result;
}

export async function refreshAuthoritativeDns(actor: DemoUser | { lease: string }, nodeId: string) {
  const worker = "lease" in actor;
  if (!worker && !can(actor.role, "dns.check")) throw new ApiError(403, "FORBIDDEN", "دسترسی به بررسی DNS مجاز نیست.");
  if (workspaceMode() !== "monitor") throw new ApiError(503, "PROVIDER_DISABLED", "خواندن DNS فقط در حالت پایش فعال می‌شود.");
  const stored = readWorkspace().state.dns.find((record) => record.nodeId === nodeId);
  const current = stored ? { ...stored, domain: currentNodeDomain(database(), nodeId) } : undefined;
  if (!current) throw new ApiError(404, "DNS_UNKNOWN", "دامنه پیدا نشد.");
  const arvanZone = arvanZoneFor(current.domain);
  const managedZone = managedDnsZoneFor(current.domain);
  const provider = managedZone?.provider ?? (arvanZone ? "arvan" as const : cloudflareEnabled() ? "cloudflare" as const : undefined);
  const providerName = provider ? dnsProviderNames[provider] : "DNS";
  const [source, resolverObservation] = await Promise.all([
    managedZone ? managedDnsObservations(managedZone, current.domain) : arvanZone ? listArvanRecords(arvanZone, current.domain, readUpstream) :
      provider ? listCloudflareRecords(current.domain) : [],
    observeResolver(current.domain).catch(() => {
      throw new ApiError(503, "RESOLVER_CONFIG", "پیکربندی DNS resolver معتبر نیست.");
    }),
  ]);
  const records = source.filter((r) => normalDomain(r.name) === normalDomain(current.domain) &&
    (r.type === "A" || r.type === "AAAA" || r.type === "CNAME"));
  const aRecords = records.filter((r) => r.type === "A" && isIP(r.content) === 4).map((r) => r.content);
  const aaaaRecords = records.filter((r) => r.type === "AAAA" && isIP(r.content) === 6).map((r) => r.content);
  const cname = records.find((r) => r.type === "CNAME")?.content;
  const proxied = records.some((r) => r.proxied);
  const resolvedAddresses = resolverObservation.aRecords.length + resolverObservation.aaaaRecords.length;
  const directMatch = sameRecords(aRecords, resolverObservation.aRecords, (ip) => ip) &&
    sameRecords(aaaaRecords, resolverObservation.aaaaRecords, normalIpv6) && !resolverObservation.cnameRecords.length;
  return transaction((db) => {
    const { revision, state } = readWorkspace(db);
    const row = state.dns.find((record) => record.nodeId === nodeId);
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!row || !node || JSON.stringify(row) !== JSON.stringify(stored) || currentNodeDomain(db, nodeId) !== current.domain) {
      throw new ApiError(409, "DNS_CHANGED", "وضعیت دامنه هم‌زمان تغییر کرد. دوباره بررسی کنید.");
    }
    const domain = normalDomain(current.domain);
    if (worker && !db.prepare(`
      SELECT 1 FROM dns_monitor_schedule WHERE node_id = ? AND domain = ? AND lease = ? AND lease_until > ?
    `).get(nodeId, domain, actor.lease, Date.now())) {
      throw new ApiError(409, "DNS_MONITOR_LEASE", "مهلت بررسی زمان‌بندی‌شدهٔ DNS به پایان رسیده است.");
    }
    const execution = db.prepare(`
      SELECT 1 FROM failover_executions WHERE domain = ? AND status IN ('applying','verifying','rolling_back','review')
    `).get(domain);
    if (execution) throw new ApiError(409, "DNS_EXECUTION_PENDING", "بررسی DNS پس از پایان اجرای Failover در دسترس است.");

    const endpoint = state.tunnels.find((tunnel) => tunnel.id === activeTunnelId(node))?.iranEndpoint;
    const active = state.servers.find((server) => server.id === endpoint?.serverId);
    const activeIp = endpoint?.publicIp;
    const activeIpv6 = active?.publicIpv6 && normalIpv6(active.publicIpv6);
    const panelIp = row.v2boardIp;
    const matchesActive = (a: string[], aaaa: string[]) => {
      const v4Match = a.every((ip) => ip === activeIp);
      const v6Match = aaaa.every((ip) => normalIpv6(ip) === activeIpv6);
      const panelMatch = !panelIp || (isIP(panelIp) === 4
        ? a.includes(panelIp)
        : isIP(panelIp) === 6 && aaaa.some((ip) => normalIpv6(ip) === normalIpv6(panelIp)));
      return v4Match && v6Match && panelMatch;
    };
    const authoritativeStatus = proxied ? "proxied" : cname ? "cname" : !aRecords.length && !aaaaRecords.length ? "error"
      : matchesActive(aRecords, aaaaRecords) ? "matched" : "mismatched";
    let resolverStatus: DNSRecord["resolverStatus"] = authoritativeStatus;
    let note = authoritativeStatus === "mismatched"
      ? `IP رکورد ${providerName} با مسیر فعال یا IP صریح V2Board اختلاف دارد.`
      : `رکوردهای ${providerName} و پاسخ مستقل DNS resolver مقایسه شدند.`;
    if (!provider) {
      resolverStatus = !resolverObservation.complete || !activeIp ? "error"
        : resolvedAddresses > 0 && matchesActive(resolverObservation.aRecords, resolverObservation.aaaaRecords) ? "matched" : "mismatched";
      note = resolverStatus === "matched" ? "پاسخ عمومی DNS با IP ایرانِ تونل فعال تطابق دارد."
        : resolverStatus === "mismatched" ? "پاسخ عمومی DNS به IP ایرانِ تونل فعال اشاره نمی‌کند."
        : "پاسخ کامل DNS یا IP ایرانِ تونل فعال در دسترس نیست.";
    } else if (!resolverObservation.complete) {
      resolverStatus = "error";
      note = "پاسخ کامل DNS resolver در زمان مقرر دریافت نشد.";
    } else if (proxied) {
      resolverStatus = resolvedAddresses ? "proxied" : "error";
      note = resolvedAddresses
        ? `پاسخ DNS برای رکورد پروکسی‌شده می‌تواند IP لبهٔ ${providerName} باشد.`
        : "رکورد پروکسی‌شده است و resolver هیچ IP قابل استفاده‌ای برنگرداند.";
    } else if (cname) {
      const alias = resolverObservation.cnameRecords.some((value) => normalDomain(value) === normalDomain(cname));
      resolverStatus = alias || (!resolverObservation.cnameRecords.length && resolvedAddresses) ? "cname" : "mismatched";
      note = alias ? "مقصد CNAME در پاسخ مستقل نیز دیده شد."
        : resolverStatus === "cname" ? "resolver فقط IP را برگرداند. مقصد CNAME از این پاسخ قابل تأیید نیست."
          : "مقصد CNAME در پاسخ resolver تأیید نشد.";
    } else if (!directMatch) {
      resolverStatus = authoritativeStatus === "matched" ? "propagation" : resolverObservation.cnameRecords.length ? "cname"
        : !resolvedAddresses ? "error"
          : matchesActive(resolverObservation.aRecords, resolverObservation.aaaaRecords) ? "matched" : "mismatched";
      note = `پاسخ resolver با رکورد ${providerName} اختلاف دارد. TTL و IP مشاهده‌شده را بررسی کنید.`;
    }
    const observation: DNSRecord = {
      ...row, domain: current.domain, provider, resolverOnly: provider ? undefined : true, expectedIranIp: activeIp,
      aRecords, aaaaRecords, cname, proxied, authoritativeStatus, resolverStatus, resolverObservation,
      ttl: records.length ? Math.min(...records.map((r) => r.ttl)) : 0,
      lastCheck: new Date().toISOString(),
      note,
    };
    state.dns = state.dns.map((item) => item.id === row.id ? observation : item);
    enqueueTelegramAlerts(db, state, updateDnsIncident(state, node, active, observation));
    if (provider) state.integrations = state.integrations.map((item) => item.type === "cloudflare" ? {
      ...item, lastSync: observation.lastCheck, lastTest: observation.lastCheck, status: "connected", message: `رکوردهای دامنه از ${providerName} خوانده شدند.`,
    } : item);
    state.nodes = decorateNodes(state.nodes, state.servers, state.tunnels, state.dns, state.settings, true);
    const detail = `${authoritativeStatus} / ${resolverStatus}`;
    if (!worker || row.authoritativeStatus !== authoritativeStatus || row.resolverStatus !== resolverStatus || !row.lastCheck) {
      const audit = worker ? {
        id: randomUUID(), at: observation.lastCheck, actor: "پایشگر DNS", role: "system" as const,
        action: "dns.observe.scheduled", target: row.domain, detail,
      } : auditOf({ ...state, currentUserId: actor.id }, "dns.observe", row.domain, detail);
      state.audit = [{ ...audit, simulated: false }, ...state.audit].slice(0, 2000);
    }
    writeWorkspace(db, state, revision + 1);
    return observation;
  });
}

// Read-only presence: does not update catalog bindings or sync leases.
export async function panelOnlineSnapshot() {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "Monitor mode required.");
  const credentials = getPanelCredentials(database());
  if (!credentials) throw new ApiError(503, "PROVIDER_DISABLED", "V2Board connection is disabled.");
  const result = board.safeParse(await readUpstream(new URL(credentials.endpoint), credentials.authorization, { protected: credentials.managed }));
  if (!result.success) throw new ApiError(502, "PANEL_SCHEMA", "Invalid V2Board response.");
  const nodes = result.data.data.map((item) => ({
    key: `${item.type.toLowerCase()}:${item.id}`, name: item.name,
    online: typeof item.online === "number" ? item.online : typeof item.online_user === "number" ? item.online_user : undefined,
    parentKey: item.parent_id ? `${item.type.toLowerCase()}:${item.parent_id}` : undefined,
  }));
  if (new Set(nodes.map((node) => node.key)).size !== nodes.length) throw new ApiError(502, "PANEL_DUPLICATE", "Duplicate panel node.");
  return { nodes, fetchedAt: new Date().toISOString() };
}
