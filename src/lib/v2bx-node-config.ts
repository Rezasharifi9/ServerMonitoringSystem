import { z } from "zod";
import type { PanelAdminNode } from "./v2board-node-fields";

const settings = z.object({
  server_name: z.string().nullish(), serverName: z.string().nullish(),
  allow_insecure: z.union([z.string(), z.number(), z.boolean()]).nullish(),
  allowInsecure: z.union([z.string(), z.number(), z.boolean()]).nullish(),
}).passthrough();

export const v2bxBackendSettings = z.object({
  server_port: z.coerce.number().int().min(1).max(65535),
  tls: z.coerce.number().int().min(0).max(2).optional(),
  server_name: z.string().nullish(), host: z.string().nullish(), network: z.string().nullish(),
  tls_settings: settings.nullish(), tlsSettings: settings.nullish(),
}).passthrough();

export function v2bxCertificate(node: PanelAdminNode, remote: z.infer<typeof v2bxBackendSettings>, suffix: string) {
  const tls = (["vmess", "vless"].includes(node.type) && remote.tls === 1) || node.type === "trojan" || node.type === "hysteria";
  if (!tls) return { CertMode: "none" };
  // VMess UniProxy omits tlsSettings; use its admin record for SNI/insecure.
  // V2bX gives camelCase settings priority when both API variants are present.
  const admin = settings.parse(node.fields.tlsSettings ?? node.fields.tls_settings ?? {});
  const config = remote.tlsSettings ?? remote.tls_settings ?? admin;
  const domain = String(remote.server_name || config.server_name || config.serverName ||
    admin.server_name || admin.serverName || node.fields.server_name || remote.host || node.fields.host || "").trim().toLowerCase();
  const insecure = config.allow_insecure ?? config.allowInsecure ?? admin.allow_insecure ?? admin.allowInsecure ??
    node.fields.insecure ?? node.fields.allow_insecure;
  const selfSigned = insecure === true || insecure === 1 || insecure === "1";
  if (!selfSigned && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("PANEL_NODE_CERT_DOMAIN");
  }
  return { CertMode: selfSigned ? "self" : "http", CertDomain: domain,
    CertFile: `fullchain${suffix}.pem`, KeyFile: `private-key${suffix}.pem` };
}
