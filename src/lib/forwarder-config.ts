import { z } from "zod";

const number = z.number().int().min(0).max(2147483647);
const text = z.string().max(8192);
const addr = z.string().min(3).max(512).refine((s) => /^(?:\[[a-f\d:]+\]|[^\s:]+):\d{1,5}$/i.test(s) && Number(s.slice(s.lastIndexOf(":") + 1)) > 0 && Number(s.slice(s.lastIndexOf(":") + 1)) <= 65535, "host:port");
const tcp = z.object({ nodelay: z.boolean().optional(), keepalive_secs: number.optional(), keepalive_interval: number.optional(), proxy: text.optional() }).strict();
const transport = z.object({ type: z.enum(["tcp", "tls", "noise", "websocket"]), tcp: tcp.optional(),
  tls: z.object({ hostname: text.optional(), trusted_root: text.optional(), pkcs12: text.optional(), pkcs12_password: text.optional() }).strict().optional(),
  noise: z.object({ pattern: text.optional(), local_private_key: text.optional(), remote_public_key: text.optional() }).strict().optional(),
  websocket: z.object({ tls: z.boolean() }).strict().optional(),
}).strict();
const service = { type: z.enum(["tcp", "udp"]), token: text.optional(), nodelay: z.boolean().optional() };
const name = z.string().regex(/^[a-zA-Z\d_.-]{1,64}$/);
const ratholeServer = z.object({ bind_addr: addr, default_token: text.min(1), heartbeat_interval: number.optional(), transport,
  services: z.record(name, z.object({ ...service, bind_addr: addr }).strict()) }).strict();
const ratholeClient = z.object({ remote_addr: addr, default_token: text.min(1), heartbeat_timeout: number.optional(), retry_interval: number.optional(),
  transport,
  services: z.record(name, z.object({ ...service, local_addr: addr, retry_interval: number.optional() }).strict()) }).strict();
const common = { transport: z.enum(["tcp", "tcpmux", "udp", "ws", "wss", "wsmux", "wssmux"]), token: text.min(1),
  nodelay: z.boolean().optional(), keepalive_period: number.optional(), log_level: z.enum(["panic", "fatal", "error", "warn", "info", "debug", "trace"]).optional(),
  pprof: z.boolean().optional(), mux_session: number.optional(), mux_version: z.union([z.literal(1), z.literal(2)]).optional(),
  mux_framesize: number.optional(), mux_recievebuffer: number.optional(), mux_streambuffer: number.optional(), sniffer: z.boolean().optional(),
  web_port: number.max(65535).optional(), sniffer_log: z.string().regex(/^[a-zA-Z\d][a-zA-Z\d_.-]{0,63}$/).optional(), skip_optz: z.literal(true),
  mss: number.max(65535).optional(), so_rcvbuf: number.optional(), so_sndbuf: number.optional() };
const backhaulServer = z.object({ ...common, bind_addr: addr, channel_size: number.optional(), heartbeat: number.optional(), mux_con: number.optional(),
  accept_udp: z.boolean().optional(), proxy_protocol: z.boolean().optional(), tls_cert: text.optional(), tls_key: text.optional(), ports: z.array(text.min(1)).min(1).max(256) }).strict();
const backhaulClient = z.object({ ...common, remote_addr: addr, connection_pool: number.optional(), retry_interval: number.optional(),
  dial_timeout: number.optional(), aggressive_pool: z.boolean().optional(), edge_ip: text.optional() }).strict();
const host = { architecture: z.enum(["amd64", "arm64"]), restartSeconds: z.union([z.literal(0), z.literal(1800), z.literal(3600), z.literal(7200), z.literal(14400), z.literal(21600), z.literal(43200), z.literal(86400)]),
  limitNofile: z.number().int().min(1024).max(1048576).optional(),
  assets: z.array(z.object({ name: z.string().regex(/^[a-zA-Z\d][a-zA-Z\d_.-]{0,63}$/).refine(s => !s.endsWith(".service") && !["manifest.json", "service-bin", "service.toml"].includes(s)), content: z.string().max(1228800) }).strict()).max(8) };
export const forwarderSettingsSchema = z.discriminatedUnion("technology", [
  z.object({ technology: z.literal("Rathole"), core: z.enum(["official", "modified", "modified-ubuntu22"]),
    iran: z.object({ ...host, options: ratholeServer }).strict(), foreign: z.object({ ...host, options: ratholeClient }).strict() }).strict(),
  z.object({ technology: z.literal("Backhaul"), core: z.literal("official"),
    iran: z.object({ ...host, options: backhaulServer }).strict(), foreign: z.object({ ...host, options: backhaulClient }).strict() }).strict(),
]);
export type ForwarderSettings = z.infer<typeof forwarderSettingsSchema>;
export type NativeOptions = Record<string, unknown>;

export function nativeLogSecrets(value: unknown): string[] {
  const secrets = new Set<string>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (typeof child === "string" && child && /token|password|private_key|^proxy$/i.test(key)) secrets.add(child);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return [...secrets];
}

// The native keys are intentionally retained beside translated labels so users
// can match every option against the upstream documentation.
export const backhaulFields = {
  common: { nodelay: "boolean", keepalive_period: "number", log_level: "text", pprof: "boolean", mux_session: "number", mux_version: "number",
    mux_framesize: "number", mux_recievebuffer: "number", mux_streambuffer: "number", sniffer: "boolean", web_port: "number", sniffer_log: "text",
    mss: "number", so_rcvbuf: "number", so_sndbuf: "number" },
  iran: { channel_size: "number", heartbeat: "number", mux_con: "number", accept_udp: "boolean", proxy_protocol: "boolean", tls_cert: "text", tls_key: "text" },
  foreign: { connection_pool: "number", retry_interval: "number", dial_timeout: "number", aggressive_pool: "boolean", edge_ip: "text" },
} as const;
export const ratholeFields = {
  common: { "transport.tcp.nodelay": "boolean", "transport.tcp.keepalive_secs": "number", "transport.tcp.keepalive_interval": "number", "transport.tcp.proxy": "text",
    "transport.tls.hostname": "text", "transport.tls.trusted_root": "text", "transport.tls.pkcs12": "text", "transport.tls.pkcs12_password": "secret",
    "transport.noise.pattern": "text", "transport.noise.local_private_key": "secret", "transport.noise.remote_public_key": "text", "transport.websocket.tls": "boolean" },
  iran: { heartbeat_interval: "number" }, foreign: { heartbeat_timeout: "number", retry_interval: "number" },
} as const;
