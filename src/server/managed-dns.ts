import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";
import { arvanTtls, dnsProviderNames, dnsProviders, editableDnsTypes, proxyDnsTypes, type DnsProvider, type DnsRecordInput, type ManagedDnsRecord, type ManagedDnsZone } from "@/lib/managed-dns";
import { can } from "@/lib/rbac";
import type { DemoUser } from "@/types";
import { digest } from "./auth";
import { dnsExecutionEnabled } from "./cloudflare-failover";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { monitorDomain, workspaceMode } from "./inventory";
import { canStorePanelCredentials, readSealedCredential, writeSealedCredential } from "./provider-secrets";

const providerSchema = z.enum(dnsProviders);
const zoneId = z.string().regex(/^[a-f0-9]{32}$/i);
const recordId = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/i);
const nameOf = (name: string) => domainToASCII(name.toLowerCase().replace(/\.$/, ""));
const source = (provider: DnsProvider) => `dns-management:${provider}`;
const tokenSchema = z.string().trim().regex(/^(?:apikey )?[A-Za-z0-9_-]{16,256}$/i);
const writable = (type: string) => editableDnsTypes.some((item) => item === type);
const base = { cloudflare: "https://api.cloudflare.com/client/v4", arvan: "https://napi.arvancloud.ir/cdn/4.0" };
const cfEnvelope = z.object({ success: z.literal(true), result: z.unknown(), result_info: z.object({ total_pages: z.number().int().nonnegative() }).optional() });
const arvanEnvelope = z.object({ data: z.unknown(), meta: z.object({ current_page: z.number().int(), last_page: z.number().int().positive() }).optional() });

function allow(actor: DemoUser, permission: "integration.edit" | "dns.check" | "dns.switch") {
  if (workspaceMode() !== "monitor" || !can(actor.role, permission)) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی مدیریت دامنه‌ها لازم است.");
  }
}

function configuredToken(provider: DnsProvider) {
  const stored = readSealedCredential(database(), source(provider));
  const environment = provider === "cloudflare" ? process.env.NODEGUARD_CF_TOKEN : process.env.NODEGUARD_ARVAN_TOKEN;
  return tokenSchema.safeParse(stored ?? environment).data;
}

export function dnsManagementSettings(actor: DemoUser) {
  allow(actor, "integration.edit");
  return { canStore: canStorePanelCredentials(), providers: dnsProviders.map((provider) => ({ provider, connected: Boolean(configuredToken(provider)) })) };
}

async function providerRequest(provider: DnsProvider, token: string, path: string, method = "GET", body?: object) {
  try {
    const auth = provider === "cloudflare" ? `Bearer ${token}` : `Apikey ${token.replace(/^apikey\s+/i, "")}`;
    const response = await fetch(base[provider] + path, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8500),
      headers: { Authorization: auth, Accept: "application/json", ...(body && { "Content-Type": "application/json" }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new ApiError(403, "DNS_PROVIDER_AUTH", `کلید یا دسترسی API در ${dnsProviderNames[provider]} معتبر نیست.`);
      if (response.status === 404) throw new ApiError(404, "DNS_PROVIDER_MISSING", "دامنه یا رکورد در سرویس‌دهنده پیدا نشد.");
      if (response.status === 400 || response.status === 409 || response.status === 422) {
        throw new ApiError(422, "DNS_PROVIDER_INPUT", "سرویس‌دهنده رکورد را نپذیرفت. نوع، مقدار و رکوردهای هم‌نام را بررسی کنید.");
      }
      throw new Error();
    }
    const payload: unknown = await response.json();
    if (provider === "cloudflare") {
      const { result, result_info } = cfEnvelope.parse(payload);
      return { data: result, pages: result_info?.total_pages };
    }
    const { data, meta } = arvanEnvelope.parse(payload);
    return { data, pages: meta?.last_page, page: meta?.current_page };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "DNS_PROVIDER", `پاسخ ${dnsProviderNames[provider]} دریافت نشد.`);
  }
}

async function pages<T>(provider: DnsProvider, token: string, path: string, item: z.ZodType<T>, extraQuery = "") {
  const items: T[] = [];
  const schema = z.array(item);
  for (let page = 1; page <= 100; page++) {
    const { data, pages, page: received } = await providerRequest(provider, token, `${path}?page=${page}&per_page=50${extraQuery}`);
    const parsed = schema.safeParse(data);
    if (!parsed.success || (received !== undefined && received !== page) || pages === undefined) break;
    items.push(...parsed.data);
    if (page >= pages) return items;
  }
  throw new ApiError(502, "DNS_PROVIDER_PAGES", `فهرست کامل ${dnsProviderNames[provider]} دریافت نشد.`);
}

async function fetchZones(provider: DnsProvider, token: string): Promise<ManagedDnsZone[]> {
  if (provider === "cloudflare") {
    const zones = await pages(provider, token, "/zones", z.object({ id: zoneId, name: monitorDomain, status: z.string().optional() }));
    return zones.map((zone) => ({ ...zone, name: nameOf(zone.name), provider }));
  }
  const zones = await pages(provider, token, "/domains", z.object({
    name: monitorDomain.optional(), domain: monitorDomain.optional(), status: z.string().optional(),
  }));
  return zones.flatMap(({ name, domain, status }) => name || domain ? [{ id: nameOf((name ?? domain)!), name: nameOf((name ?? domain)!), status, provider }] : []);
}

function cachedZones(provider: DnsProvider) {
  const row = database().prepare("SELECT payload FROM provider_cache WHERE provider=?").get(source(provider));
  return row ? JSON.parse(String(row.payload)) as { zones: ManagedDnsZone[]; syncedAt: string } : undefined;
}

export function managedDnsZoneFor(domain: string) {
  const name = nameOf(domain);
  return dnsProviders.flatMap((provider) => cachedZones(provider)?.zones ?? [])
    .filter((zone) => name === zone.name || name.endsWith(`.${zone.name}`))
    .sort((left, right) => right.name.length - left.name.length)[0];
}

export function managedDnsConfigured() {
  return dnsProviders.some((provider) => Boolean(cachedZones(provider)?.zones.length && configuredToken(provider)));
}

function storeZones(provider: DnsProvider, zones: ManagedDnsZone[], token?: string) {
  transaction((db) => {
    if (token) writeSealedCredential(db, source(provider), token);
    db.prepare(`INSERT INTO provider_cache VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload`)
      .run(source(provider), JSON.stringify({ zones, syncedAt: new Date().toISOString() }));
  });
}

export async function connectDnsManagement(actor: DemoUser, providerInput: string, value: unknown) {
  allow(actor, "integration.edit");
  const provider = providerSchema.safeParse(providerInput);
  const input = z.object({ token: tokenSchema }).strict().safeParse(value);
  if (!provider.success || !input.success || (provider.data === "cloudflare" && /\s/.test(input.data.token))) {
    throw new ApiError(422, "DNS_PROVIDER_TOKEN", "کلید API سرویس‌دهنده را بررسی کنید.");
  }
  if (!canStorePanelCredentials()) throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید رمزنگاری کنترل‌پلین تنظیم نشده است.");
  const zones = await fetchZones(provider.data, input.data.token);
  storeZones(provider.data, zones, input.data.token);
  return { count: zones.length };
}

export function dnsZones(actor: DemoUser) {
  allow(actor, "dns.check");
  return dnsProviders.map((provider) => ({ provider, connected: Boolean(configuredToken(provider)), ...cachedZones(provider) }));
}

export async function syncDnsZones(actor: DemoUser) {
  allow(actor, "dns.check");
  const errors: Partial<Record<DnsProvider, string>> = {};
  await Promise.all(dnsProviders.map(async (provider) => {
    const token = configuredToken(provider);
    if (!token) return;
    try {
      const zones = await fetchZones(provider, token);
      if (token === configuredToken(provider)) storeZones(provider, zones);
    } catch (error) {
      errors[provider] = error instanceof ApiError ? error.message : "همگام‌سازی فهرست دامنه‌ها ناموفق بود.";
    }
  }));
  return { providers: dnsZones(actor), errors };
}

function accessZone(providerInput: string, id: string) {
  const parsed = providerSchema.safeParse(providerInput);
  const provider = parsed.data;
  const zone = provider && cachedZones(provider)?.zones.find((item) => item.id === id);
  if (!zone || !provider) throw new ApiError(404, "DNS_ZONE", "دامنه را از فهرست همگام‌شده انتخاب کنید.");
  const token = configuredToken(provider);
  if (!token) throw new ApiError(503, "DNS_PROVIDER_TOKEN", "کلید سرویس‌دهندهٔ DNS در تنظیمات لازم است.");
  const path = provider === "cloudflare" ? `/zones/${zone.id}/dns_records` : `/domains/${zone.name}/dns-records`;
  return { provider, zone, token, path };
}

const cfRecord = z.object({ id: recordId, type: z.string(), name: z.string(), content: z.string().optional(), ttl: z.number(),
  proxied: z.boolean().optional(), proxiable: z.boolean().optional(), priority: z.number().optional(), data: z.unknown(), modified_on: z.string().optional() });
const arvanRecord = z.object({ id: recordId, type: z.string(), name: z.string(), value: z.unknown(), ttl: z.number(), cloud: z.boolean().optional(),
  is_protected: z.boolean().optional(), upstream_https: z.string().nullable().optional(), ip_filter_mode: z.unknown(), updated_at: z.string().optional() });

function fqdn(input: string, zone: string) {
  const value = input.trim();
  if (!value || value === "@") return zone;
  const name = nameOf(value);
  return value.endsWith(".") || name === zone || name.endsWith(`.${zone}`) ? name : `${name}.${zone}`;
}

function cloudflareManaged(zone: string) {
  if (!dnsExecutionEnabled() || process.env.NODEGUARD_CF_ZONE_ID !== zone) return new Set<string>();
  return new Set(Object.values(z.record(zoneId).parse(JSON.parse(process.env.NODEGUARD_CF_FAILOVER_RECORDS ?? "{}"))));
}

function mapCloudflare(entry: z.infer<typeof cfRecord>, protectedIds: Set<string>): ManagedDnsRecord {
  return { id: entry.id, type: entry.type, name: entry.name, content: entry.content ?? JSON.stringify(entry.data ?? ""), ttl: entry.ttl,
    proxied: entry.proxied ?? false, priority: entry.priority, editable: writable(entry.type) && !protectedIds.has(entry.id),
    revision: digest(JSON.stringify(entry)) };
}

const arvanAddress = z.array(z.object({ ip: z.string(), port: z.number().nullable().optional(), weight: z.number().nullable().optional(), country: z.string().nullable().optional() }));
const arvanValue = z.object({ host: z.string().optional(), text: z.string().optional(), priority: z.number().nullable().optional(),
  host_header: z.string().nullable().optional(), port: z.number().nullable().optional() });

function mapArvan(entry: z.infer<typeof arvanRecord>, zone: string): ManagedDnsRecord {
  const value = arvanValue.safeParse(entry.value).data;
  const ips = arvanAddress.safeParse(entry.value).data;
  const type = entry.type.toUpperCase();
  return { id: entry.id, type, name: fqdn(entry.name, zone), ttl: entry.ttl, proxied: entry.cloud ?? false,
    content: ips?.map(({ ip }) => ip).join("\n") ?? value?.host ?? value?.text ?? JSON.stringify(entry.value ?? ""),
    priority: value?.priority ?? undefined, editable: writable(type) && !entry.is_protected, revision: digest(JSON.stringify(entry)) };
}

export async function dnsRecords(actor: DemoUser, providerInput: string, id: string) {
  allow(actor, "dns.check");
  return listRecords(providerInput, id);
}

async function listRecords(providerInput: string, id: string, domain?: string) {
  const { provider, zone, token, path } = accessZone(providerInput, id);
  const suffix = domain && provider === "cloudflare" ? `&name.exact=${encodeURIComponent(domain)}` : "";
  if (provider === "cloudflare") {
    const protectedIds = cloudflareManaged(zone.id);
    return (await pages(provider, token, path, cfRecord, suffix)).map((record) => mapCloudflare(record, protectedIds));
  }
  return (await pages(provider, token, path, arvanRecord)).map((record) => mapArvan(record, zone.name));
}

export async function managedDnsObservations(zone: ManagedDnsZone, domain: string) {
  const name = nameOf(domain);
  const records = await listRecords(zone.provider, zone.id, name);
  return records.filter((record) => nameOf(record.name) === name).flatMap((record) =>
    (record.type === "A" || record.type === "AAAA" ? record.content.split("\n") : [record.content])
      .map((content) => ({ ...record, content })));
}

export async function syncPrimaryTunnelDns(actor: DemoUser, domain: string, ip: string) {
  allow(actor, "dns.switch");
  const name = nameOf(domain);
  let zone = managedDnsZoneFor(name);
  if (!zone && can(actor.role, "dns.check")) {
    await syncDnsZones(actor);
    zone = managedDnsZoneFor(name);
  }
  if (!zone) throw new ApiError(409, "DNS_ZONE_NOT_FOUND", "دامنه در هیچ Zone متصل به پنل پیدا نشد.");
  const records = (await listRecords(zone.provider, zone.id, name)).filter((record) => nameOf(record.name) === name);
  const addresses = records.filter((record) => record.type === "A");
  if (addresses.length > 1 || records.some((record) => record.type === "CNAME")) {
    throw new ApiError(409, "DNS_RECORD_CONFLICT", "دامنه CNAME یا چند رکورد A دارد. رکورد مقصد را در مدیریت DNS مشخص کنید.");
  }
  const current = addresses[0];
  if (current?.content === ip && !current.proxied) return { status: "matched" as const };
  await saveDnsRecord(actor, zone.provider, zone.id, {
    id: current?.id, revision: current?.revision, name: name + ".", type: "A", content: ip,
    ttl: current?.ttl ?? 300, proxied: false,
  });
  return { status: current ? "updated" as const : "created" as const };
}

const recordInput = z.object({ id: recordId.optional(), revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  type: z.enum(editableDnsTypes), name: z.string().max(253), content: z.string().trim().min(1).max(4096),
  ttl: z.number().int(), proxied: z.boolean(), priority: z.number().int().min(0).max(65535).optional() }).strict();

function normalizeRecord(input: DnsRecordInput, zone: ManagedDnsZone) {
  const name = fqdn(input.name, zone.name);
  if ((input.name.trim() && input.name.trim() !== "@" && !nameOf(input.name.trim())) || !/^(?:\*\.)?[a-z0-9_.-]{1,253}$/i.test(name) ||
      (name !== zone.name && !name.endsWith(`.${zone.name}`)) || name.split(".").some((label) => !label || label.length > 63)) {
    throw new ApiError(422, "DNS_NAME", "نام رکورد باید در همین دامنه باشد.");
  }
  const { type, content, ttl, proxied, priority } = input;
  if ((proxied && !proxyDnsTypes.includes(type)) || (zone.provider === "arvan" ? !arvanTtls.includes(ttl) : ttl !== 1 && (ttl < 30 || ttl > 86400))) {
    throw new ApiError(422, "DNS_OPTIONS", "TTL یا حالت پروکسی برای این رکورد معتبر نیست.");
  }
  const address = type === "A" || type === "AAAA";
  const values = address ? [...new Set(content.split(/[\s,،]+/))] : [type === "TXT" ? content : nameOf(content)];
  if (address ? values.length > (zone.provider === "arvan" ? 20 : 1) || values.some((ip) => isIP(ip) !== (type === "A" ? 4 : 6)) :
    type !== "TXT" && !monitorDomain.safeParse(values[0]).success) {
    throw new ApiError(422, "DNS_CONTENT", "مقدار رکورد با نوع آن سازگار نیست.");
  }
  if (type === "MX" && (priority === undefined || (zone.provider === "arvan" && priority > 9999))) {
    throw new ApiError(422, "DNS_PRIORITY", "اولویت رکورد MX معتبر نیست.");
  }
  if (zone.provider === "arvan" && type === "TXT" && content.length > 500) throw new ApiError(422, "DNS_CONTENT", "رکورد TXT آروان حداکثر ۵۰۰ کاراکتر دارد.");
  return { name, values };
}

export async function saveDnsRecord(actor: DemoUser, providerInput: string, id: string, value: unknown) {
  allow(actor, "dns.switch");
  const { provider, zone, token, path } = accessZone(providerInput, id);
  const parsed = recordInput.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "DNS_RECORD", "فرم رکورد DNS معتبر نیست.");
  const { type, ttl, proxied, priority, id: key, revision } = parsed.data;
  const { name, values } = normalizeRecord(parsed.data, zone);
  const endpoint = key ? `${path}/${key}` : path;
  const changed = () => new ApiError(409, "DNS_RECORD_CHANGED", "رکورد تغییر کرده است یا برای ویرایش دستی در دسترس نیست. فهرست را دوباره بخوانید.");
  let saved: ManagedDnsRecord;
  if (provider === "cloudflare") {
    const protectedIds = cloudflareManaged(zone.id);
    if (key) {
      const current = mapCloudflare(cfRecord.parse((await providerRequest(provider, token, endpoint)).data), protectedIds);
      if (!current.editable || current.revision !== revision || current.type !== type) throw changed();
    }
    const result = await providerRequest(provider, token, endpoint, key ? "PATCH" : "POST", { name, type, content: values[0],
      ttl: proxied ? 1 : ttl, ...(proxyDnsTypes.includes(type) && { proxied }), ...(type === "MX" && { priority }) });
    saved = mapCloudflare(cfRecord.parse(result.data), protectedIds);
  } else {
    let previous: z.infer<typeof arvanRecord> | undefined;
    if (key) {
      previous = arvanRecord.parse((await providerRequest(provider, token, endpoint)).data);
      const current = mapArvan(previous, zone.name);
      if (!current.editable || current.revision !== revision || current.type !== type) throw changed();
    }
    const oldValue = arvanValue.safeParse(previous?.value).data;
    const oldAddresses = arvanAddress.safeParse(previous?.value).data;
    const recordValue = type === "A" || type === "AAAA" ? values.map((ip) => oldAddresses?.find((item) => item.ip === ip) ?? { ip }) :
      type === "TXT" ? { text: values[0] } : type === "MX" ? { host: values[0], priority } :
        type === "CNAME" ? { host: values[0], host_header: oldValue?.host_header ?? "source", port: oldValue?.port } : { host: values[0] };
    const result = await providerRequest(provider, token, endpoint, key ? "PUT" : "POST", { type: type.toLowerCase(),
      name: name === zone.name ? "@" : name.slice(0, -(zone.name.length + 1)), ttl, cloud: proxied, value: recordValue,
      upstream_https: previous?.upstream_https ?? undefined, ip_filter_mode: previous?.ip_filter_mode ?? undefined });
    saved = mapArvan(arvanRecord.parse(result.data), zone.name);
  }
  transaction((db) => {
    const { state, revision } = readWorkspace(db);
    state.audit = [{ id: randomUUID(), at: new Date().toISOString(), actor: actor.name, role: actor.role,
      action: key ? "dns.record.update" : "dns.record.create", target: saved.name, detail: `${saved.type} · ${dnsProviderNames[provider]}`,
      simulated: false }, ...state.audit].slice(0, 2000);
    writeWorkspace(db, state, revision + 1);
  });
  return saved;
}
