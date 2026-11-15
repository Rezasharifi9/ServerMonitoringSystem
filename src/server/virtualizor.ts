import { z } from "zod";
import { can } from "@/lib/rbac";
import type { DemoUser } from "@/types";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { pushAudit } from "./activity-log";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { canStorePanelCredentials, readSealedCredential, writeSealedCredential } from "./provider-secrets";
import { publicDispatcher, validatePublicHttps } from "./public-https";

const configSchema = z.object({ endpoint: z.string().url().max(512), apiKey: z.string().trim().min(1).max(256), apiPassword: z.string().min(1).max(512) }).strict();
const bindingSchema = z.object({ vpsId: z.string().regex(/^[1-9]\d{0,9}$/) }).strict();
const storedBindingSchema = bindingSchema.extend({ endpoint: z.string() });
const actionSchema = z.object({ action: z.enum(["start", "stop", "restart", "poweroff"]) }).strict();
type Config = z.infer<typeof configSchema>;
function allow(actor: DemoUser, permission?: "settings.edit" | "server.configure" | "server.restart") {
  if (workspaceMode() !== "monitor" || (permission && !can(actor.role, permission))) throw new ApiError(403, "FORBIDDEN", "دسترسی Virtualizor مجاز نیست.");
}
function config() { return configSchema.safeParse(readSealedCredential(database(), "virtualizor")).data; }
function audit(actor: DemoUser, action: string, target: string) {
  transaction((db) => { const { state, revision } = readWorkspace(db); pushAudit(state, actor, "virtualizor." + action, target, "Virtualizor: " + action); writeWorkspace(db, state, revision + 1); });
}
function server(actor: DemoUser, id: string) {
  allow(actor);
  const item = readWorkspace().state.servers.find((s) => s.id === id);
  if (!item) throw new ApiError(404, "SERVER_NOT_FOUND", "سرور پیدا نشد.");
  if (item.countryCode.toUpperCase() !== "IR" && !item.roles.some((r) => r === "iran" || r.startsWith("iran-"))) throw new ApiError(422, "VIRTUALIZOR_IRAN", "Virtualizor فقط برای سرورهای ایران فعال است.");
  return item;
}
export function virtualizorSettings(actor: DemoUser) {
  allow(actor, "settings.edit"); const saved = config();
  return { endpoint: saved?.endpoint ?? "", configured: Boolean(saved), storageEnabled: canStorePanelCredentials() };
}
export function saveVirtualizorSettings(actor: DemoUser, input: unknown) {
  allow(actor, "settings.edit");
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(422, "VIRTUALIZOR_CONFIG", "آدرس پنل، API Key و API Password را بررسی کنید.");
  const url = new URL(parsed.data.endpoint); validatePublicHttps(url);
  if (url.search || url.hash || !["/", "/index.php"].includes(url.pathname)) throw new ApiError(422, "VIRTUALIZOR_URL", "آدرس پایهٔ پنل Virtualizor را وارد کنید.");
  parsed.data.endpoint = url.origin;
  transaction((db) => writeSealedCredential(db, "virtualizor", parsed.data));
  audit(actor, "settings", "virtualizor"); return virtualizorSettings(actor);
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function scalar(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 256) : undefined; }
export function virtualizorInfo(data: Record<string, unknown>, id: string) {
  const info = record(data.info); const vps = Object.keys(record(info.vps)).length ? record(info.vps) : Object.keys(record(data.vpsinfo)).length ? record(data.vpsinfo) : info;
  const actualId = scalar(vps.vpsid ?? info.vpsid ?? data.vpsid);
  if (actualId !== id) throw new ApiError(502, "VIRTUALIZOR_VPS", "شناسهٔ VPS پاسخ با سرور انتخابی مطابقت ندارد.");
  const rawStatus = scalar(info.status ?? vps.status ?? data.status);
  const status = rawStatus === "1" || rawStatus === "online" ? "online" : rawStatus === "0" || rawStatus === "offline" ? "offline" : "unknown";
  return { vpsId: id, status, hostname: scalar(vps.hostname ?? info.hostname), virtualization: scalar(info.virt ?? vps.virt), ip: scalar(vps.ip ?? (Array.isArray(info.ip) ? info.ip[0] : info.ip)), os: scalar(vps.os_name ?? record(info.os).name ?? vps.os), cpuCores: scalar(vps.cores), ramMb: scalar(vps.ram), diskGb: scalar(vps.space), bandwidthGb: scalar(vps.bandwidth) };
}
async function call(saved: Config, id: string, action = "vpsmanage") {
  const url = new URL("/index.php", saved.endpoint); validatePublicHttps(url);
  url.search = new URLSearchParams({ act: action, svs: id, api: "json", apikey: saved.apiKey, apipass: saved.apiPassword, ...(action !== "vpsmanage" ? { do: "1" } : {}) }).toString();
  const dispatcher = publicDispatcher();
  try {
    const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000), dispatcher } as RequestInit);
    if (!response.ok || !response.body) throw new Error("upstream");
    const reader = response.body.getReader(); let body = ""; let size = 0; const decoder = new TextDecoder();
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new Error("size"); } body += decoder.decode(chunk.value, { stream: true }); } } finally { reader.releaseLock(); }
    const data = record(JSON.parse(body + decoder.decode()));
    if ((data.error && Object.keys(Object(data.error)).length) || (data.errors && Object.keys(Object(data.errors)).length) || (action !== "vpsmanage" && !data.done)) throw new Error("rejected");
    return data;
  } catch { throw new ApiError(502, "VIRTUALIZOR_UPSTREAM", action === "vpsmanage" ? "خواندن اطلاعات Virtualizor ناموفق بود؛ اتصال و اعتبارنامه را بررسی کنید." : "نتیجهٔ فرمان Virtualizor مشخص نیست؛ پیش از تلاش دوباره وضعیت سرور را تازه‌سازی کنید."); }
  finally { await dispatcher.destroy().catch(() => {}); }
}
export async function serverVirtualizor(actor: DemoUser, id: string) {
  server(actor, id); const saved = config(); const binding = storedBindingSchema.safeParse(readSealedCredential(database(), "virtualizor-server:" + id)).data;
  if (!saved || !binding || binding.endpoint !== saved.endpoint) return { configured: Boolean(saved), vpsId: "", info: null };
  return { configured: true, vpsId: binding.vpsId, info: virtualizorInfo(await call(saved, binding.vpsId), binding.vpsId) };
}
export async function bindVirtualizor(actor: DemoUser, id: string, input: unknown) {
  allow(actor, "server.configure"); server(actor, id);
  const parsed = bindingSchema.safeParse(input); const saved = config();
  if (!parsed.success || !saved) throw new ApiError(422, "VIRTUALIZOR_BINDING", "ابتدا تنظیمات Virtualizor و شناسهٔ VPS را تکمیل کنید.");
  const info = virtualizorInfo(await call(saved, parsed.data.vpsId), parsed.data.vpsId);
  transaction((db) => writeSealedCredential(db, "virtualizor-server:" + id, { ...parsed.data, endpoint: saved.endpoint })); audit(actor, "bind", id);
  return { configured: true, vpsId: parsed.data.vpsId, info };
}
export function unbindVirtualizor(actor: DemoUser, id: string) {
  allow(actor, "server.configure"); server(actor, id);
  database().prepare("DELETE FROM provider_credentials WHERE provider=?").run("virtualizor-server:" + id); audit(actor, "unbind", id);
  return { configured: Boolean(config()), vpsId: "", info: null };
}
const pending = new Set<string>();
export async function controlVirtualizor(actor: DemoUser, id: string, input: unknown) {
  allow(actor, "server.restart"); server(actor, id); const parsed = actionSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(422, "VIRTUALIZOR_ACTION", "فرمان Virtualizor معتبر نیست.");
  const saved = config(); const binding = storedBindingSchema.safeParse(readSealedCredential(database(), "virtualizor-server:" + id)).data;
  if (!saved || !binding || binding.endpoint !== saved.endpoint) throw new ApiError(422, "VIRTUALIZOR_BINDING", "اتصال Virtualizor را تکمیل کنید.");
  const lock = saved.endpoint + ":" + binding.vpsId;
  if (pending.has(lock)) throw new ApiError(409, "VIRTUALIZOR_BUSY", "یک فرمان برای این VPS در حال اجرا است.");
  pending.add(lock);
  try { virtualizorInfo(await call(saved, binding.vpsId), binding.vpsId); audit(actor, parsed.data.action + ".requested", id); await call(saved, binding.vpsId, parsed.data.action); audit(actor, parsed.data.action + ".accepted", id); return { accepted: true }; }
  finally { pending.delete(lock); }
}
