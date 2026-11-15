import { generateKeyPairSync, randomBytes } from "node:crypto";
import { can } from "@/lib/rbac";
import { forwarderSettingsSchema, nativeLogSecrets, type ForwarderSettings } from "@/lib/forwarder-config";
import type { DemoUser } from "@/types";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { readSealedCredential, writeSealedCredential } from "./provider-secrets";
import { workspaceMode } from "./inventory";
import { pushAudit } from "./activity-log";
import forge from "node-forge";
import { z } from "zod";
import { isIP } from "node:net";
import { tunnelForwarding } from "./providers";
import { forwarderControlPort, forwarderListeners, listenersOverlap, type ForwarderListener } from "@/lib/forwarder-listeners";

const scope = (id: string) => "forwarder:" + id;
function allow(actor: DemoUser, id: string) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "server.configure") || !can(actor.role, "deploy.run") || !can(actor.role, "tunnel.mutate")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی مدیریت تونل لازم است.");
  }
  const tunnel = readWorkspace().state.tunnels.find((t) => t.id === id);
  if (!tunnel || !["Rathole", "Backhaul"].includes(tunnel.technology)) throw new ApiError(422, "FORWARDER_TARGET", "تونل Rathole یا Backhaul را انتخاب کنید.");
  return tunnel;
}
export function readForwarderSettings(id: string) {
  const saved = readSealedCredential(database(), scope(id));
  return saved === undefined ? undefined : forwarderSettingsSchema.parse(saved);
}

function defaultControlPort(tunnel: ReturnType<typeof allow>) {
  const { state } = readWorkspace();
  const reserved = new Set<number>([22]);
  const unsaved = [];
  const resolve = tunnelForwarding(database(), state.nodes);
  for (const other of state.tunnels) {
    if (other.iranEndpoint.serverId === tunnel.iranEndpoint.serverId) {
      const port = resolve(other).port;
      if (port) reserved.add(port);
    }
    if (!["Backhaul", "Rathole"].includes(other.technology)) continue;
    const settings = readForwarderSettings(other.id);
    for (const side of ["iran", "foreign"] as const) {
      if (settings && other[side === "iran" ? "iranEndpoint" : "foreignEndpoint"].serverId === tunnel.iranEndpoint.serverId) {
        for (const listener of forwarderListeners(settings, side)) reserved.add(listener.port);
      }
    }
    if (!settings && other.iranEndpoint.serverId === tunnel.iranEndpoint.serverId) unsaved.push(other);
  }
  for (const other of unsaved.sort((a, b) => a.id.localeCompare(b.id))) {
    let port = other.technology === "Backhaul" ? 3080 : 2333;
    while (reserved.has(port) && port <= 65535) port++;
    if (port > 65535) throw new ApiError(409, "FORWARDER_PORT_EXHAUSTED", "پورت آزاد برای کنترل تونل پیدا نشد.");
    if (other.id === tunnel.id) return port;
    reserved.add(port);
  }
  throw new ApiError(404, "FORWARDER_TARGET", "تونل پیدا نشد.");
}

export function validateForwarderListeners(id: string, value: ForwarderSettings) {
  const { state } = readWorkspace();
  const tunnel = state.tunnels.find(t => t.id === id);
  if (!tunnel) throw new ApiError(404, "FORWARDER_TARGET", "تونل پیدا نشد.");
  let incoming: Record<"iran" | "foreign", ForwarderListener[]>;
  try {
    incoming = { iran: forwarderListeners(value, "iran"), foreign: forwarderListeners(value, "foreign") };
    const remotePort = Number(value.foreign.options.remote_addr.split(":").at(-1));
    if (remotePort !== forwarderControlPort(value)) throw new Error("Control port mismatch");
  } catch {
    throw new ApiError(422, "FORWARDER_LISTENERS", "نگاشت پورت‌ها معتبر نیست یا پورت remote_addr با bind_addr یکسان نیست.");
  }
  const conflict = (port: number, owner?: string): never => {
    throw new ApiError(409, "FORWARDER_PORT_CONFLICT", `پورت ${port} روی این سرور ${owner ? `به تونل «${owner}» تعلق دارد` : "تکراری یا رزروشده است"}؛ برای هر تونل پورت کنترل و پورت ورودی مستقل انتخاب کنید.`, { port, tunnelId: id });
  };
  const resolve = tunnelForwarding(database(), state.nodes);
  for (const side of ["iran", "foreign"] as const) {
    const serverId = tunnel[side === "iran" ? "iranEndpoint" : "foreignEndpoint"].serverId;
    const own = incoming[side];
    for (let i = 0; i < own.length; i++) {
      if (own[i].port === 22 || own.slice(0, i).some(l => listenersOverlap(l, own[i]))) conflict(own[i].port);
    }
    for (const other of state.tunnels) {
      if (other.id === id) continue;
      const settings = ["Backhaul", "Rathole"].includes(other.technology) ? readForwarderSettings(other.id) : undefined;
      for (const otherSide of ["iran", "foreign"] as const) {
        if (other[otherSide === "iran" ? "iranEndpoint" : "foreignEndpoint"].serverId !== serverId) continue;
        const port = otherSide === "iran" ? resolve(other).port : undefined;
        const listeners = settings ? forwarderListeners(settings, otherSide) : port ? [{ host: "0.0.0.0", port, protocol: "tcp" as const }] : [];
        for (const listener of own) if (listeners.some(l => listenersOverlap(l, listener))) conflict(listener.port, other.name);
      }
    }
  }
}
export function getForwarderSettings(actor: DemoUser, id: string) {
  const tunnel = allow(actor, id);
  const saved = readForwarderSettings(id);
  if (saved) return { saved: true, settings: saved };
  const token = randomBytes(24).toString("base64url");
  const forward = tunnelForwarding(database(), readWorkspace().state.nodes)(tunnel);
  const port = forward.port ?? tunnel.iranEndpoint.port ?? 2083;
  const targetPort = forward.targetPort ?? port;
  const controlPort = defaultControlPort(tunnel);
  const iran = { architecture: "amd64" as const, restartSeconds: 0 as const, assets: [] };
  const foreign = { ...iran };
  const settings: ForwarderSettings = tunnel.technology === "Rathole" ? {
    technology: "Rathole", core: "official", iran: { ...iran, options: { bind_addr: `0.0.0.0:${controlPort}`, default_token: token, heartbeat_interval: 30,
      transport: { type: "tcp", tcp: { nodelay: true } }, services: { node: { type: "tcp", bind_addr: `0.0.0.0:${port}` } } } },
    foreign: { ...foreign, options: { remote_addr: `${tunnel.iranEndpoint.publicIp}:${controlPort}`, default_token: token, heartbeat_timeout: 40, retry_interval: 1,
      transport: { type: "tcp", tcp: { nodelay: true } }, services: { node: { type: "tcp", local_addr: `127.0.0.1:${targetPort}` } } } },
  } : { technology: "Backhaul", core: "official", iran: { ...iran, options: { bind_addr: `0.0.0.0:${controlPort}`, token, transport: "tcp", skip_optz: true,
    nodelay: true, keepalive_period: 75, heartbeat: 40, channel_size: 2048, ports: [port === targetPort ? String(port) : `${port}=${targetPort}`] } },
    foreign: { ...foreign, options: { remote_addr: `${tunnel.iranEndpoint.publicIp}:${controlPort}`, token, transport: "tcp", skip_optz: true,
      nodelay: true, connection_pool: 8, retry_interval: 3, dial_timeout: 10 } } };
  return { saved: false, settings };
}
export function saveForwarderSettings(actor: DemoUser, id: string, input: unknown) {
  const tunnel = allow(actor, id);
  const parsed = forwarderSettingsSchema.safeParse(input);
  if (!parsed.success || parsed.data.technology !== tunnel.technology) throw new ApiError(422, "FORWARDER_CONFIG", "گزینه‌های تونل معتبر نیست؛ نوع، آدرس‌ها و محدودهٔ اعداد را بررسی کنید.");
  const value = parsed.data;
  if (value.technology === "Rathole") {
    const names = Object.keys(value.iran.options.services);
    if (!names.length || names.length > 256 || names.length !== Object.keys(value.foreign.options.services).length || names.some(name => !value.foreign.options.services[name] || value.foreign.options.services[name].type !== value.iran.options.services[name].type)) {
      throw new ApiError(422, "FORWARDER_SERVICES", "نام و پروتکل سرویس‌های دو سمت باید یکسان باشد.");
    }
    if (names.some(name => (value.iran.options.services[name].token ?? value.iran.options.default_token) !== (value.foreign.options.services[name].token ?? value.foreign.options.default_token))) throw new ApiError(422, "FORWARDER_TOKEN", "توکن هر سرویس باید در دو سمت یکسان باشد.");
    if (value.iran.options.transport.type !== value.foreign.options.transport.type) throw new ApiError(422, "FORWARDER_TRANSPORT", "ترنسپورت دو سمت باید یکسان باشد.");
    if (value.core !== "official" && [value.iran, value.foreign].some(host => host.architecture !== "amd64")) throw new ApiError(422, "FORWARDER_ARCH", "هستهٔ Modified فقط amd64 است.");
    for (const side of ["iran", "foreign"] as const) {
      const tls = value[side].options.transport.tls;
      for (const file of [tls?.pkcs12, tls?.trusted_root]) if (file && !value[side].assets.some(a => a.name === file)) throw new ApiError(422, "FORWARDER_TLS_ASSET", "نام فایل TLS باید با فایل بارگذاری‌شده تطبیق داشته باشد.");
    }
  } else {
    if (value.iran.options.transport !== value.foreign.options.transport) throw new ApiError(422, "FORWARDER_TRANSPORT", "ترنسپورت دو سمت باید یکسان باشد.");
    for (const file of [value.iran.options.tls_cert, value.iran.options.tls_key]) if (file && !value.iran.assets.some(a => a.name === file)) throw new ApiError(422, "FORWARDER_TLS_ASSET", "گواهی و کلید TLS را بارگذاری کنید.");
  }
  for (const side of ["iran", "foreign"] as const) {
    if (nativeLogSecrets(value[side].options).reduce((sum, secret) => sum + Buffer.byteLength(secret), 0) > 65536) throw new ApiError(422, "FORWARDER_SECRET_LIMIT", "حجم مجموع توکن‌ها و کلیدهای این سمت باید کمتر از ۶۴ کیلوبایت باشد.");
    const assets = value[side].assets;
    if (new Set(assets.map(a => a.name)).size !== assets.length || assets.reduce((n, a) => n + Buffer.from(a.content, "base64").length, 0) > 900 * 1024 || assets.some(a => !a.content || Buffer.from(a.content, "base64").toString("base64") !== a.content)) throw new ApiError(422, "FORWARDER_ASSET", "فایل‌های خصوصی نامعتبر، تکراری یا بزرگ‌تر از ۹۰۰ کیلوبایت هستند.");
  }
  const serverToken = "default_token" in value.iran.options ? value.iran.options.default_token : value.iran.options.token;
  const clientToken = "default_token" in value.foreign.options ? value.foreign.options.default_token : value.foreign.options.token;
  if (serverToken !== clientToken) throw new ApiError(422, "FORWARDER_TOKEN", "توکن دو سمت باید یکسان باشد.");
  transaction((db) => {
    validateForwarderListeners(id, value);
    writeSealedCredential(db, scope(id), value);
    const { state, revision } = readWorkspace(db);
    pushAudit(state, actor, "tunnel.configure", id, "تنظیمات سرویس تونل به‌صورت رمز‌شده ذخیره شد.");
    writeWorkspace(db, state, revision + 1);
  });
  return { saved: true };
}
export function forwarderNoiseKeys(actor: DemoUser, id: string) {
  allow(actor, id);
  const pair = generateKeyPairSync("x25519");
  return { privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64") };
}

export async function forwarderCertificate(actor: DemoUser, id: string, input: unknown) {
  const tunnel = allow(actor, id);
  const value = z.object({ hostname: z.string().regex(/^[a-zA-Z\d.:-]{1,253}$/), days: z.number().int().min(1).max(3650).default(365) }).strict().safeParse(input);
  if (!value.success) throw new ApiError(422, "TLS_HOSTNAME", "نام میزبان و مدت اعتبار گواهی را بررسی کنید.");
  const keys = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) => forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 2 }, (error, keys) => error ? reject(error) : resolve(keys)));
  const cert = forge.pki.createCertificate(); cert.publicKey = keys.publicKey; cert.serialNumber = "01" + randomBytes(15).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60000); cert.validity.notAfter = new Date(Date.now() + value.data.days * 86400000);
  const attrs = [{ name: "commonName", value: value.data.hostname }]; cert.setSubject(attrs); cert.setIssuer(attrs);
  const ip = isIP(value.data.hostname);
  cert.setExtensions([{ name: "basicConstraints", cA: true }, { name: "keyUsage", digitalSignature: true, keyEncipherment: true, keyCertSign: true },
    { name: "extKeyUsage", serverAuth: true }, { name: "subjectAltName", altNames: [ip ? { type: 7, ip: value.data.hostname } : { type: 2, value: value.data.hostname }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const password = randomBytes(20).toString("hex");
  const pem = forge.pki.certificateToPem(cert);
  const encode = (name: string, content: string) => ({ name, content: Buffer.from(content).toString("base64") });
  return { technology: tunnel.technology, hostname: value.data.hostname, password, certificate: encode("server.crt", pem), key: encode("server.key", forge.pki.privateKeyToPem(keys.privateKey)),
    identity: { name: "identity.p12", content: Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, password, { algorithm: "3des" })).getBytes(), "binary").toString("base64") } };
}
