export const dnsProviders = ["cloudflare", "arvan"] as const;
export type DnsProvider = (typeof dnsProviders)[number];
export const dnsProviderNames = { cloudflare: "Cloudflare", arvan: "آروان‌کلاد" };
export const editableDnsTypes = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
export type EditableDnsType = (typeof editableDnsTypes)[number];
export const arvanTtls = [120, 180, 300, 600, 900, 1800, 3600, 7200, 18000, 43200, 86400, 172800, 432000];
export const proxyDnsTypes: readonly string[] = ["A", "AAAA", "CNAME"];

export type ManagedDnsZone = { provider: DnsProvider; id: string; name: string; status?: string };
export type ManagedDnsRecord = {
  id: string; type: string; name: string; content: string; ttl: number;
  proxied: boolean; priority?: number; editable: boolean; revision: string;
};
export type DnsRecordInput = {
  id?: string; revision?: string; type: EditableDnsType; name: string;
  content: string; ttl: number; proxied: boolean; priority?: number;
};
