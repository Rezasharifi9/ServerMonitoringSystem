import { isIP } from "node:net";
import { z } from "zod";
import { normalDomain } from "./dns-resolver";
import { ApiError } from "./http";
import { monitorDomain } from "./inventory";

const record = z.object({
  type: z.string(), name: z.string(), ttl: z.number().int().nonnegative(), cloud: z.boolean().optional(), value: z.unknown(),
});
const page = z.object({
  data: z.array(record).max(1000),
  meta: z.object({ current_page: z.number().int(), last_page: z.number().int().min(1) }),
});

export function arvanZoneFor(domain: string) {
  try {
    const zones = z.array(monitorDomain).max(100).parse(JSON.parse(process.env.NODEGUARD_ARVAN_ZONES ?? "[]"));
    const hostname = normalDomain(domain);
    return zones.map(normalDomain).filter((zone) => hostname === zone || hostname.endsWith("." + zone))
      .sort((a, b) => b.length - a.length)[0];
  } catch {
    throw new ApiError(503, "ARVAN_CONFIG", "فهرست ناحیه‌های DNS آروان معتبر نیست.");
  }
}

export const arvanEnabled = () => Boolean(process.env.NODEGUARD_ARVAN_TOKEN && process.env.NODEGUARD_ARVAN_ZONES);

type DnsRecord = { type: string; name: string; content: string; ttl: number; proxied?: boolean };
export async function listArvanRecords(zone: string, domain: string, read: (url: URL, authorization: string) => Promise<unknown>) {
  const token = process.env.NODEGUARD_ARVAN_TOKEN?.trim();
  if (!token || !/^(?:apikey )?[a-zA-Z0-9-]{16,256}$/i.test(token)) {
    throw new ApiError(503, "ARVAN_CONFIG", "کلید خواندن DNS آروان معتبر نیست.");
  }
  const authorization = /^apikey /i.test(token) ? token : "Apikey " + token;
  const endpoint = new URL(`https://napi.arvancloud.ir/cdn/4.0/domains/${zone}/dns-records`);
  endpoint.searchParams.set("per_page", "100");
  const result: DnsRecord[] = [];
  const target = normalDomain(domain);
  for (let number = 1; number <= 10; number++) {
    endpoint.searchParams.set("page", String(number));
    const parsed = page.safeParse(await read(endpoint, authorization));
    if (!parsed.success || parsed.data.meta.current_page !== number || parsed.data.meta.last_page > 10) break;
    for (const entry of parsed.data.data) {
      const type = entry.type.toUpperCase();
      if (!["A", "AAAA", "CNAME"].includes(type)) continue;
      const relative = normalDomain(entry.name);
      const name = relative === "@" || !relative ? zone :
        relative === zone || relative.endsWith("." + zone) ? relative : relative + "." + zone;
      if (name !== target) continue;
      const base = { type, name, ttl: entry.ttl, proxied: entry.cloud };
      if (type === "CNAME") {
        const value = z.object({ host: z.string().min(1) }).safeParse(entry.value);
        if (!value.success) throw new ApiError(502, "ARVAN_DNS_SCHEMA", "مقدار CNAME آروان معتبر نیست.");
        result.push({ ...base, content: value.data.host });
      } else {
        const values = z.array(z.object({ ip: z.string().refine((ip) => isIP(ip) === (type === "A" ? 4 : 6)) })).safeParse(entry.value);
        if (!values.success) throw new ApiError(502, "ARVAN_DNS_SCHEMA", "مقدار آدرس DNS آروان معتبر نیست.");
        result.push(...values.data.map(({ ip }) => ({ ...base, content: ip })));
      }
    }
    if (number === parsed.data.meta.last_page) return result;
  }
  throw new ApiError(502, "ARVAN_DNS_PAGES", "پاسخ کامل صفحه‌بندی رکوردهای آروان دریافت نشد.");
}
