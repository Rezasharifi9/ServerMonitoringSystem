import { isIP } from "node:net";
import { z } from "zod";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { configuredResolver, normalDomain } from "./dns-resolver";

export { normalDomain };

const recordId = z.string().regex(/^[a-f0-9]{32}$/i);
const record = z.object({
  id: recordId,
  type: z.string(),
  name: z.string(),
  content: z.string(),
  ttl: z.number().int().positive(),
  proxied: z.boolean().optional(),
  comment: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  modified_on: z.string().min(1),
});
export type ManagedRecord = z.infer<typeof record>;
const list = z.object({
  success: z.literal(true),
  result: z.array(record),
  result_info: z.object({ total_pages: z.number().int() }).optional(),
});
const updated = z.object({ success: z.literal(true), result: record });

export function dnsExecutionEnabled() {
  return workspaceMode() === "monitor" && process.env.NODEGUARD_ENABLE_DNS_FAILOVER === "1";
}

export const automaticFailoverEnabled = () => dnsExecutionEnabled() && process.env.NODEGUARD_ENABLE_AUTO_FAILOVER === "1";

export function enrolledRecord(nodeId: string) {
  const map = z.record(recordId).parse(JSON.parse(process.env.NODEGUARD_CF_FAILOVER_RECORDS ?? "{}"));
  const zone = recordId.safeParse(process.env.NODEGUARD_CF_ZONE_ID);
  const id = Object.hasOwn(map, nodeId) ? map[nodeId] : undefined;
  if (!zone.success || !id || !process.env.NODEGUARD_CF_WRITE_TOKEN || !process.env.NODEGUARD_CF_TOKEN) {
    throw new ApiError(409, "FAILOVER_ENROLLMENT", "رکورد و اعتبارنامه‌های جداگانهٔ خواندن و نوشتن برای این نود ثبت نشده‌اند.");
  }
  return { id, zone: zone.data };
}

type Enrollment = ReturnType<typeof enrolledRecord>;

const owns = (value: ManagedRecord) => value.tags?.includes("nodeguard:managed");
const comment = (value: ManagedRecord) => value.comment ?? "";
export const recordComment = comment;
export const matchesRecord = (a: ManagedRecord, b: ManagedRecord) =>
  a.id === b.id && a.modified_on === b.modified_on && a.content === b.content &&
  a.ttl === b.ttl && comment(a) === comment(b) && JSON.stringify(a.tags?.slice().sort()) === JSON.stringify(b.tags?.slice().sort());

async function call(url: URL, token: string, body?: { content: string; comment: string }) {
  try {
    const reply = await fetch(url, {
      method: body ? "PATCH" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    if (!reply.ok || !reply.body) throw new Error("Provider reply invalid");
    const reader = reply.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error("Provider reply oversized");
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(502, "FAILOVER_DNS_UPSTREAM", "پاسخ معتبر از Cloudflare دریافت نشد.");
  }
}

export async function readManagedRecord(enrollment: Enrollment, domain: string) {
  const url = new URL(`https://api.cloudflare.com/client/v4/zones/${enrollment.zone}/dns_records`);
  url.searchParams.set("name.exact", domain);
  url.searchParams.set("per_page", "100");
  const parsed = list.safeParse(await call(url, process.env.NODEGUARD_CF_TOKEN!));
  if (!parsed.success || (parsed.data.result_info?.total_pages ?? 1) > 1) {
    throw new ApiError(502, "FAILOVER_DNS_UPSTREAM", "فهرست کامل رکوردها دریافت نشد.");
  }
  const candidates = parsed.data.result.filter((r) => normalDomain(r.name) === normalDomain(domain) &&
    ["A", "AAAA", "CNAME"].includes(r.type));
  const [result] = candidates;
  if (candidates.length !== 1 || result.id !== enrollment.id || result.type !== "A" || result.proxied !== false ||
      !owns(result) || isIP(result.content) !== 4 || result.ttl < 30 || result.ttl > 900) {
    throw new ApiError(409, "FAILOVER_DNS_CONFLICT", "رکورد باید تنها A مستقیم دامنه، با مالکیت ثبت‌شده و TTL بین ۳۰ تا ۹۰۰ ثانیه باشد.");
  }
  return result;
}

export async function changeManagedRecord(enrollment: Enrollment, content: string, note: string) {
  const url = new URL(`https://api.cloudflare.com/client/v4/zones/${enrollment.zone}/dns_records/${enrollment.id}`);
  const parsed = updated.safeParse(await call(url, process.env.NODEGUARD_CF_WRITE_TOKEN!, { content, comment: note }));
  if (!parsed.success) throw new ApiError(502, "FAILOVER_DNS_UPSTREAM", "نتیجهٔ تغییر رکورد نیاز به بازخوانی دارد.");
}

export async function resolverMatches(domain: string, ip: string) {
  try {
    const addresses = await configuredResolver().resolve4(normalDomain(domain));
    return addresses.length > 0 && addresses.every((address) => address === ip);
  } catch {
    return false;
  }
}
