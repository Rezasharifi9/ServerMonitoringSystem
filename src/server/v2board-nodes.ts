import { createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { can } from "@/lib/rbac";
import { panelNodeFields, panelNodeTypes, type PanelAdminNode, type PanelAdminNodes } from "@/lib/v2board-node-fields";
import { v2bxBackendSettings, v2bxCertificate } from "@/lib/v2bx-node-config";
import type { DemoUser } from "@/types";
import { digest } from "./auth";
import { ApiError } from "./http";
import { monitorDomain, workspaceMode } from "./inventory";
import { boardBindings, v2BoardAdminClient } from "./providers";
import { pushAudit } from "./activity-log";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";

const positiveId = z.coerce.number().int().positive().safe();
const nodeType = z.enum(panelNodeTypes);
export const panelNodeReference = z.string().regex(/^(vmess|vless|shadowsocks|trojan|hysteria):[1-9]\d{0,14}$/);
const nodeKey = z.object({ id: positiveId, type: nodeType }).passthrough();
const catalog = z.object({ data: z.array(z.record(z.unknown())).max(10000) });
const namedIds = z.object({ data: z.array(z.object({ id: positiveId, name: z.string() })).max(10000) });
const routeIds = z.object({ data: z.array(z.object({ id: positiveId, remarks: z.string() })).max(10000) });
type AdminClient = ReturnType<typeof v2BoardAdminClient>;

function allow(actor: DemoUser) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "node.edit") || !can(actor.role, "integration.edit")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی مدیریت نودهای V2Board لازم است.");
  }
}

async function readNodes(client: AdminClient): Promise<PanelAdminNode[]> {
  const result = catalog.safeParse(await client.request("server/manage/getNodes"));
  if (!result.success) throw new ApiError(502, "PANEL_NODE_SCHEMA", "پاسخ فهرست نودهای V2Board معتبر نیست.");
  return result.data.data.flatMap((raw) => {
    const parsed = nodeKey.safeParse(raw);
    if (!parsed.success) return [];
    const { id, type } = parsed.data;
    const fields = Object.fromEntries(panelNodeFields(type).map(({ key }) => [key, raw[key] ?? null]));
    return [{ id, type, fields, revision: digest(JSON.stringify(fields)) }];
  });
}

export async function panelAdminNodes(actor: DemoUser): Promise<PanelAdminNodes> {
  allow(actor);
  const client = v2BoardAdminClient();
  const [nodes, groupResponse, routeResponse] = await Promise.all([
    readNodes(client), client.request("server/group/fetch"), client.request("server/route/fetch"),
  ]);
  const groups = namedIds.safeParse(groupResponse);
  const routes = routeIds.safeParse(routeResponse);
  if (!groups.success || !routes.success) throw new ApiError(502, "PANEL_GROUP_SCHEMA", "فهرست گروه‌های V2Board معتبر نیست.");
  return { nodes, groups: groups.data.data, routes: routes.data.data.map(({ id, remarks }) => ({ id, name: remarks })) };
}

export async function changePanelNode(actor: DemoUser, value: unknown) {
  allow(actor);
  const input = z.object({ type: nodeType, id: z.number().int().positive().safe(), revision: z.string().regex(/^[a-f0-9]{64}$/),
    show: z.boolean().optional() }).strict().safeParse(value);
  if (!input.success) throw new ApiError(422, "PANEL_NODE_INPUT", "مشخصات نود معتبر نیست.");
  const { type, id, show, revision } = input.data;
  const key = `${type}:${id}`;
  if (show === undefined && database().prepare(`SELECT 1 FROM v2board_bindings b JOIN failover_plans p ON p.node_id=b.node_id
    JOIN failover_executions e ON e.plan_id=p.id WHERE b.panel_key=? AND e.status IN ('applying','verifying','rolling_back','review')`).get(key)) {
    throw new ApiError(409, "PANEL_NODE_BUSY", "ابتدا عملیات فعال نود را پایان دهید.");
  }
  const client = v2BoardAdminClient();
  const nodes = await readNodes(client);
  const node = nodes.find((item) => item.id === id && item.type === type);
  if ((!node && show !== undefined) || (node && node.revision !== revision)) throw new ApiError(409, "PANEL_NODE_CHANGED", "اطلاعات نود تغییر کرده است. فهرست را تازه‌سازی کنید.");
  if (show === undefined && nodes.some((item) => item.type === type && Number(item.fields.parent_id) === id)) {
    throw new ApiError(409, "PANEL_NODE_CHILDREN", "پیش از حذف، اتصال نودهای فرزند را تغییر دهید.");
  }
  if (node) {
    const response = await client.request(`server/${type}/${show === undefined ? "drop" : "update"}`, show === undefined ? { id } : { id, show: Number(show) });
    if (!z.object({ data: z.literal(true) }).safeParse(response).success) throw new ApiError(502, "PANEL_NODE_WRITE", "V2Board تغییر نود را تأیید نکرد.");
  }
  if (show === undefined) {
    transaction((db) => {
      const binding = db.prepare("SELECT node_id FROM v2board_bindings WHERE panel_key=?").get(key);
      const { state, revision } = readWorkspace(db);
      if (node) pushAudit(state, actor, "node.panel", String(binding?.node_id ?? key), "نود V2Board حذف شد.");
      const nodeId = binding?.node_id;
      state.nodes = state.nodes.filter((item) => item.id !== nodeId);
      state.dns = state.dns.filter((item) => item.nodeId !== nodeId);
      state.policies = state.policies.filter((item) => item.nodeId !== nodeId);
      state.tunnels = state.tunnels.map((tunnel) => ({ ...tunnel, nodeIds: tunnel.nodeIds.filter((item) => item !== nodeId),
        nodeRef: (tunnel.nodeRef?.kind === "v2board" && tunnel.nodeRef.key === key) ||
          (tunnel.nodeRef?.kind === "inventory" && tunnel.nodeRef.id === nodeId) ? undefined : tunnel.nodeRef,
      }));
      db.prepare("DELETE FROM v2board_bindings WHERE panel_key=?").run(key);
      if (typeof nodeId === "string") db.prepare("DELETE FROM dns_monitor_schedule WHERE node_id=?").run(nodeId);
      writeWorkspace(db, state, revision + 1);
    });
  } else if (node) notePanel(actor, key, show ? "نود V2Board نمایش داده شد." : "نود V2Board مخفی شد.");
  return { changed: Boolean(node) };
}

function notePanel(actor: DemoUser, key: string, detail: string) {
  transaction((db) => {
    const bound = key ? db.prepare("SELECT node_id FROM v2board_bindings WHERE panel_key=?").get(key) : undefined;
    const { state, revision } = readWorkspace(db);
    pushAudit(state, actor, "node.panel", String(bound?.node_id ?? (key || "v2board")), detail);
    writeWorkspace(db, state, revision + 1);
  });
}

const save = z.object({ type: nodeType, id: z.number().int().positive().safe().optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(), fields: z.record(z.unknown()) }).strict();

const x25519PrivateKeyHeader = Buffer.from("302e020100300506032b656e04220420", "hex");
const realitySettings = z.object({
  server_name: z.string().trim().pipe(monitorDomain),
  dest: z.string().trim().nullish(),
  server_port: z.union([z.string(), z.number()]).nullish(),
  xver: z.union([z.enum(["0", "1", "2"]), z.number().int().min(0).max(2)]).nullish(),
  private_key: z.string().trim().nullish(),
  public_key: z.string().trim().nullish(),
  short_id: z.string().trim().nullish(),
  fingerprint: z.string().trim().nullish(),
}).passthrough();

function completeRealitySettings(value: unknown) {
  const result = realitySettings.safeParse(value ?? {});
  if (!result.success) {
    const message = result.error.issues.some((issue) => issue.path[0] === "server_name")
      ? "نام دامنهٔ مقصد Reality (SNI) را بدون پروتکل یا پورت وارد کنید."
      : "تنظیمات پیشرفتهٔ Reality معتبر نیست.";
    throw new ApiError(422, "PANEL_REALITY_INPUT", message);
  }
  const settings = result.data;
  let privateKey;
  if (settings.private_key) {
    const raw = Buffer.from(settings.private_key, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== settings.private_key) {
      throw new ApiError(422, "PANEL_REALITY_KEY", "کلید خصوصی Reality باید یک کلید X25519 معتبر باشد.");
    }
    // Node 24 imports an X25519 private scalar in its RFC 8410 PKCS#8 wrapper.
    privateKey = createPrivateKey({ key: Buffer.concat([x25519PrivateKeyHeader, raw]), format: "der", type: "pkcs8" });
  } else {
    if (settings.public_key) {
      throw new ApiError(422, "PANEL_REALITY_KEY", "برای استفاده از کلید عمومی دستی، کلید خصوصی متناظر را وارد کنید.");
    }
    privateKey = generateKeyPairSync("x25519").privateKey;
  }
  const { d, x } = privateKey.export({ format: "jwk" });
  if (!d || !x || (settings.public_key && settings.public_key !== x)) {
    throw new ApiError(422, "PANEL_REALITY_KEY", "کلید عمومی و کلید خصوصی Reality با هم مطابقت ندارند.");
  }
  const shortId = settings.short_id || randomBytes(8).toString("hex");
  if (!/^(?:[a-f0-9]{2}){1,8}$/i.test(shortId)) {
    throw new ApiError(422, "PANEL_REALITY_SHORT_ID", "Short ID باید ۲ تا ۱۶ رقم هگزادسیمال و طول زوج داشته باشد.");
  }
  const port = String(settings.server_port ?? "").trim() || "443";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new ApiError(422, "PANEL_REALITY_PORT", "پورت مقصد Reality باید بین ۱ و ۶۵۵۳۵ باشد.");
  }
  return { ...settings, dest: settings.dest || settings.server_name, server_port: port,
    ...(settings.xver != null && { xver: String(settings.xver) }),
    fingerprint: settings.fingerprint || "chrome", private_key: d, public_key: x, short_id: shortId };
}

export async function savePanelNode(actor: DemoUser, value: unknown) {
  allow(actor);
  const parsed = save.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "PANEL_NODE_INPUT", "فرم نود V2Board معتبر نیست.");
  const { type, id, revision, fields } = parsed.data;
  const fieldList = panelNodeFields(type);
  if (Object.keys(fields).some((key) => !fieldList.some((field) => field.key === key))) {
    throw new ApiError(422, "PANEL_NODE_INPUT", "یکی از فیلدها برای این پروتکل پشتیبانی نمی‌شود.");
  }
  if (id === undefined && (fields.server_port == null || fields.server_port === "")) {
    const range = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(String(fields.port ?? ""));
    const first = Number(range?.[1]);
    const last = Number(range?.[2] ?? first);
    if (!range || first < 1 || first > last || last > 65535) {
      throw new ApiError(422, "PANEL_NODE_PORT", "پورت اتصال یا بازهٔ آن باید بین ۱ و ۶۵۵۳۵ باشد.");
    }
    fields.server_port = range[1];
  }
  for (const { key, label, required } of fieldList) {
    const item = fields[key];
    if (required && (item == null || item === "" || (Array.isArray(item) && !item.length))) {
      throw new ApiError(422, "PANEL_NODE_INPUT", `مقدار ${label} را وارد کنید.`);
    }
  }
  const client = v2BoardAdminClient();
  if (id !== undefined) {
    const node = (await readNodes(client)).find((item) => item.id === id && item.type === type);
    if (!node || node.revision !== revision) throw new ApiError(409, "PANEL_NODE_CHANGED", "نود در V2Board تغییر کرده است. فرم را دوباره باز کنید.");
  } else if (type === "vless" && String(fields.tls) === "2") {
    fields.tls_settings = completeRealitySettings(fields.tls_settings);
  } else if (type === "hysteria" && typeof fields.obfs === "string" && fields.obfs.trim() && !fields.obfs_password) {
    fields.obfs_password = randomBytes(16).toString("hex");
  }
  const response = z.object({ data: z.literal(true) }).safeParse(await client.request(`server/${type}/save`, { ...fields, id }));
  if (!response.success) throw new ApiError(502, "PANEL_NODE_RESULT", "V2Board نتیجهٔ ذخیره را تأیید نکرد. فهرست نودها را بررسی کنید.");
  notePanel(actor, id === undefined ? "" : `${type}:${id}`, id === undefined ? "نود V2Board ساخته شد." : "نود V2Board ویرایش شد.");
  return { saved: true };
}

const serverSettings = z.object({ data: z.object({ server: z.object({ server_token: z.string().trim().min(1).max(1024) }) }) });

function listensOnUdp(node: PanelAdminNode) {
  if (node.type === "hysteria") return true;
  const network = String(node.fields.network ?? "").toLowerCase();
  return network === "quic" || network === "kcp";
}

export function serverV2bxReferences(serverId: string) {
  const db = database();
  const { state } = readWorkspace(db);
  if (!state.servers.some((host) => host.id === serverId && host.roles.includes("foreign"))) throw new ApiError(404, "V2BX_HOST", "سرور خارج پیدا نشد.");
  const linked = new Set(state.servers.find((host) => host.id === serverId)?.panelNodeRefs ?? []);
  const local = new Set(state.nodes.filter((node) => node.foreignServerId === serverId).map((node) => node.id));
  const refs = new Set([...boardBindings(db)].filter(([, nodeId]) => local.has(nodeId)).map(([key]) => key));
  for (const row of db.prepare("SELECT node_reference FROM server_panel_nodes WHERE server_id=?").all(serverId)) refs.add(String(row.node_reference));
  for (const row of db.prepare(`SELECT n.reference FROM v2bx_install_nodes n JOIN provision_jobs j ON j.id=n.job_id
    WHERE n.server_id=? AND j.status='succeeded'`).all(serverId)) refs.add(String(row.reference));
  for (const ref of linked) refs.add(ref);
  for (const ref of refs) {
    if (linked.has(ref)) continue;
    const [type, id] = ref.split(":");
    const removed = db.prepare(`SELECT created_at FROM provision_jobs WHERE server_id=? AND operation='remove-v2bx' AND status='succeeded'
      AND json_extract(profile,'$.v2bxNode.nodeId')=? AND json_extract(profile,'$.v2bxNode.nodeType') IN (?,?) ORDER BY created_at DESC LIMIT 1`)
      .get(serverId, Number(id), type, type === "hysteria" ? "hysteria2" : type);
    const install = db.prepare(`SELECT j.created_at FROM v2bx_install_nodes n JOIN provision_jobs j ON j.id=n.job_id
      WHERE n.server_id=? AND n.reference=? AND j.status='succeeded' ORDER BY j.created_at DESC LIMIT 1`).get(serverId, ref);
    if (removed && (!install || Number(removed.created_at) >= Number(install.created_at))) refs.delete(ref);
  }
  return refs;
}

export async function serverV2bxNodes(actor: DemoUser, serverId: string) {
  const refs = serverV2bxReferences(serverId);
  const all = await panelAdminNodes(actor);
  return { ...all, nodes: all.nodes.filter((node) => refs.has(`${node.type}:${node.id}`) && !node.fields.parent_id) };
}

export async function v2bxRemovalTarget(actor: DemoUser, reference: string, serverId?: string) {
  allow(actor);
  if (serverId && !serverV2bxReferences(serverId).has(reference)) throw new ApiError(422, "V2BX_NODE_HOST", "نود انتخاب‌شده به این سرور متصل نیست.");
  if (!panelNodeReference.safeParse(reference).success) throw new ApiError(422, "V2BX_CONFIG", "نود V2Board معتبر نیست.");
  const client = v2BoardAdminClient();
  const node = (await readNodes(client)).find(({ id, type }) => `${type}:${id}` === reference);
  if (!node) throw new ApiError(404, "PANEL_NODE_UNKNOWN", "نود انتخاب‌شده در V2Board پیدا نشد.");
  if (node.fields.parent_id) throw new ApiError(422, "PANEL_NODE_PARENT", "نود فرزند سرویس جدا ندارد. حذف V2bX را روی نود والد انجام دهید.");
  if (!client.panelUrl.startsWith("https://")) throw new ApiError(422, "PANEL_NODE_TOKEN", "آدرس پنل باید HTTPS باشد.");
  const nodeType = node.type === "hysteria" && Number(node.fields.version) === 2 ? "hysteria2" : node.type;
  return { apiHost: client.panelUrl.replace(/\/$/, ""), nodeId: node.id, nodeType };
}

export async function buildPanelV2bxConfig(actor: DemoUser, references: readonly string[]) {
  allow(actor);
  if (references.length < 1 || references.length > 2 || new Set(references).size !== references.length) {
    throw new ApiError(422, "V2BX_CONFIG", "یک یا دو نود متفاوت V2Board را برای نصب انتخاب کنید.");
  }
  const client = v2BoardAdminClient();
  const [nodes, settings] = await Promise.all([readNodes(client), client.request("config/fetch?key=server")]);
  const selected = references.map((reference) => {
    const node = nodes.find(({ id, type }) => `${type}:${id}` === reference);
    if (!node) throw new ApiError(404, "PANEL_NODE_UNKNOWN", "نود انتخاب‌شده در V2Board پیدا نشد.");
    if (node.fields.parent_id) throw new ApiError(422, "PANEL_NODE_PARENT", "برای نصب V2bX، نود والد را انتخاب کنید. نود فرزند از همان سرویس استفاده می‌کند.");
    return node;
  });
  const settingsResult = serverSettings.safeParse(settings);
  if (!settingsResult.success) throw new ApiError(422, "PANEL_NODE_TOKEN", "کلید ارتباط سرور در تنظیمات V2Board مشخص نشده است.");
  const token = settingsResult.data.data.server.server_token;
  const built: { core: "xray" | "sing"; port: number; udp: boolean; entry: Record<string, unknown> }[] = [];
  for (const node of selected) {
    const type = node.type === "hysteria" && Number(node.fields.version) === 2 ? "hysteria2" : node.type;
    const remote = v2bxBackendSettings.safeParse(await client.backendConfig(type, node.id, token));
    if (!remote.success) throw new ApiError(502, "PANEL_NODE_CONFIG", "تنظیمات نود از API سرویس V2Board دریافت نشد.");
    if (["vmess", "vless"].includes(node.type) && (remote.data.tls === undefined ||
      (node.type === "vmess" && remote.data.tls === 2))) {
      throw new ApiError(422, "PANEL_NODE_CONFIG", "حالت TLS در API نود معتبر نیست.");
    }
    const networks = node.type === "trojan" ? ["tcp", "ws", "grpc"]
      : ["tcp", "ws", "grpc", "httpupgrade", "splithttp", "xhttp"];
    if (["vmess", "vless", "trojan"].includes(node.type) &&
      !networks.includes(remote.data.network || (node.type === "trojan" ? "tcp" : ""))) {
      throw new ApiError(422, "PANEL_NODE_NETWORK", "این transport در هستهٔ Xray نسخهٔ نصب‌شده پشتیبانی نمی‌شود.");
    }
    const core = node.type === "hysteria" ? "sing" : "xray";
    const certificate = selected.length > 1 ? `-${node.type}-${node.id}` : "";
    let certConfig;
    try { certConfig = v2bxCertificate(node, remote.data, certificate); }
    catch { throw new ApiError(422, "PANEL_NODE_CERT_DOMAIN", "دامنه و تنظیمات گواهی TLS نود را در V2Board بررسی کنید."); }
    built.push({
      core, port: remote.data.server_port, udp: listensOnUdp({ ...node, fields: { ...node.fields, network: remote.data.network ?? node.fields.network } }),
      entry: {
        Core: core, ApiHost: client.panelUrl, ApiKey: token, NodeID: node.id, NodeType: type, Timeout: 30,
        ListenIP: "0.0.0.0", SendIP: "0.0.0.0", SniffEnabled: true,
        CertConfig: certConfig,
      },
    });
  }
  const seen = new Set<string>();
  for (const item of built) {
    const key = `${item.udp ? "udp" : "tcp"}:${item.port}`;
    if (seen.has(key)) throw new ApiError(422, "V2BX_NODE_PORT", "پورت سرویس این دو نود یکسان است. در V2Board برای هر نود پورت جدا تنظیم کنید.");
    seen.add(key);
  }
  return JSON.stringify({
    Log: { Level: "info" }, Cores: [...new Set(built.map((item) => item.core))].map((Type) => ({ Type })),
    Nodes: built.map((item) => item.entry),
  });
}
