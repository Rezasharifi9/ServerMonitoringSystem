import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type { DNSResolverObservation } from "@/types";

export const normalDomain = (domain: string) => domain.toLowerCase().replace(/\.$/, "");
export const normalIpv6 = (ip: string) => new URL(`http://[${ip.split("%", 1)[0]}]/`).hostname;

export function configuredResolver() {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const configured = process.env.NODEGUARD_DNS_RESOLVERS;
  if (configured) {
    const servers: unknown = JSON.parse(configured);
    if (!Array.isArray(servers) || !servers.length || servers.length > 4 ||
        !servers.every((server) => typeof server === "string" && isIP(server))) {
      throw new Error("Invalid NODEGUARD_DNS_RESOLVERS");
    }
    resolver.setServers(servers);
  }
  return resolver;
}

async function lookup<T>(query: Promise<T[]>): Promise<{ values: T[]; complete: boolean }> {
  try {
    return { values: await query, complete: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { values: [], complete: code === "ENODATA" || code === "ENOTFOUND" };
  }
}

export async function observeResolver(domain: string): Promise<DNSResolverObservation> {
  const name = normalDomain(domain);
  const resolver = configuredResolver();
  const [a, aaaa, cname] = await Promise.all([
    lookup(resolver.resolve4(name, { ttl: true })),
    lookup(resolver.resolve6(name, { ttl: true })),
    lookup(resolver.resolveCname(name)),
  ]);
  const ttls = [...a.values, ...aaaa.values].map(({ ttl }) => ttl);
  return {
    aRecords: a.values.map(({ address }) => address),
    aaaaRecords: aaaa.values.map(({ address }) => address),
    cnameRecords: cname.values,
    ...(ttls.length ? { ttl: Math.min(...ttls) } : {}),
    checkedAt: new Date().toISOString(),
    complete: a.complete && aaaa.complete && cname.complete,
  };
}

export function sameRecords(left: string[], right: string[], normalize: (value: string) => string) {
  const expected = new Set(left.map(normalize));
  const received = new Set(right.map(normalize));
  return expected.size === received.size && [...received].every((record) => expected.has(record));
}
