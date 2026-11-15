import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { decorateNodes } from "@/lib/health";
import { can } from "@/lib/rbac";
import { asciiDigits, LINUX_DISTRIBUTIONS, serverIdentifier } from "@/lib/server-inventory";
import { isIranServer, INVENTORY_SERVER_ROLES } from "@/lib/topology";
import type { DemoUser, Server } from "@/types";
import { readWorkspace, transaction, writeWorkspace } from "./database";
import { normalIpv6 } from "./dns-resolver";
import { ApiError } from "./http";
import { monitoredServer, workspaceMode } from "./inventory";
import { panelAdminNodes, panelNodeReference } from "./v2board-nodes";
import { provisionBusy } from "./provision";
import { publicIp } from "./public-https";
import { inventorySshFields, prepareInventorySsh } from "./ssh-connection";

export const inventoryIpv4 = z.string().trim().transform(asciiDigits).refine((value) => isIP(value) === 4 && publicIp(value));
const ipv6 = z.string().trim().transform(asciiDigits).refine((value) => !value.includes("%") && isIP(value) === 6 && publicIp(value));
const serverForm = z.object({
  panelNodeRefs: z.array(panelNodeReference).max(500).transform((refs) => [...new Set(refs)].sort()).optional(),
  publicIpv4: inventoryIpv4,
  publicIpv6: ipv6.optional(),
  os: z.enum(LINUX_DISTRIBUTIONS),
  roles: z.array(z.enum(INVENTORY_SERVER_ROLES)).min(1).max(3).transform((roles) => [...new Set(roles.map((role) => role === "foreign" ? "foreign" as const : "iran" as const))]).refine((roles) => roles.length === 1),
  ...inventorySshFields,
}).strict();

const fieldErrors: Record<string, string> = {
  publicIpv4: "IPv4 عمومی معتبر وارد کنید.",
  publicIpv6: "IPv6 عمومی معتبر وارد کنید یا فیلد را خالی بگذارید.",
  os: "توزیع لینوکس را انتخاب کنید.",
  roles: "حداقل یک نقش معتبر برای سرور انتخاب کنید.",
  sshUsername: "نام کاربری SSH را بررسی کنید.",
  sshPort: "پورت SSH باید عددی بین ۱ و ۶۵۵۳۵ باشد.",
  password: "طول رمز SSH باید بین ۱ و ۱۰۲۴ کاراکتر باشد.",
  fingerprint: "کلید میزبان SSH را دوباره بررسی کنید.",
};

const lookupResult = z.object({
  success: z.literal(true), ip: z.string(), country: z.string().trim().min(1).max(128),
  country_code: z.string().regex(/^[A-Z]{2}$/),
  connection: z.object({ isp: z.string().trim().min(1).max(128) }),
});

type IpMetadata = Pick<Server, "country" | "countryCode" | "provider">;
const lookups = new Map<string, { expires: number; result: Promise<IpMetadata> }>();

function allow(actor: DemoUser) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "مدیریت موجودی عملیاتی در حالت پایش در دسترس است.");
  if (!can(actor.role, "server.configure")) throw new ApiError(403, "FORBIDDEN", "دسترسی پیکربندی سرور لازم است.");
}

async function fetchIpMetadata(ip: string): Promise<IpMetadata> {
  try {
    const response = await fetch(`https://ipwho.is/${ip}?fields=success,ip,country,country_code,connection.isp`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const { success, data } = lookupResult.safeParse(await response.json());
      if (success && data.ip === ip) return { country: data.country, countryCode: data.country_code, provider: data.connection.isp };
    }
  } catch {
    // The registration form can retry a temporary provider failure.
  }
  throw new ApiError(502, "IP_LOOKUP_UNAVAILABLE", "تشخیص ارائه‌دهنده و کد کشور برای این IP موفق نبود. دوباره تلاش کنید.");
}

export function lookupServerIp(actor: DemoUser, value: unknown) {
  allow(actor);
  const parsed = inventoryIpv4.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "PUBLIC_IPV4", "یک IPv4 عمومی معتبر وارد کنید.");
  const ip = parsed.data;
  const cached = lookups.get(ip);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (lookups.size >= 512) lookups.delete(lookups.keys().next().value!);
  const result = fetchIpMetadata(ip).catch((error) => {
    if (lookups.get(ip)?.result === result) lookups.delete(ip);
    throw error;
  });
  lookups.set(ip, { result, expires: Date.now() + 3600000 });
  return result;
}

function getServer(servers: Server[], id: string) {
  const server = servers.find((item) => item.id === id);
  if (!server) throw new ApiError(404, "SERVER_UNKNOWN", "سرور پیدا نشد.");
  return server;
}

function configuration(server: Pick<Server, "publicIpv4" | "publicIpv6" | "os" | "roles" | "sshUsername" | "sshPort" | "panelNodeRefs">) {
  const { publicIpv4, publicIpv6, os, roles, sshUsername, sshPort, panelNodeRefs } = server;
  return { publicIpv4, publicIpv6, os, roles, panelNodeRefs, sshUsername: sshUsername ?? "root", sshPort: sshPort ?? 22 };
}

function checkUnique(servers: Server[], addresses: Pick<Server, "publicIpv4" | "publicIpv6">, previous?: Server) {
  const v4 = addresses.publicIpv4 !== previous?.publicIpv4 ? addresses.publicIpv4 : undefined;
  const v6 = addresses.publicIpv6 && normalIpv6(addresses.publicIpv6);
  const oldV6 = previous?.publicIpv6 && normalIpv6(previous.publicIpv6);
  if (servers.some((server) => server.id !== previous?.id && (server.publicIpv4 === v4 ||
    (v6 && v6 !== oldV6 && server.publicIpv6 && normalIpv6(server.publicIpv6) === v6)))) {
    throw new ApiError(409, "SERVER_ADDRESS_EXISTS", "این IP برای سرور دیگری ثبت شده است.");
  }
}

function existingRegistration(servers: Server[], settings: ReturnType<typeof configuration>, password?: string) {
  const resource = servers.find((server) => server.publicIpv4 === settings.publicIpv4);
  if (!resource) return undefined;
  if (!password && JSON.stringify(configuration(resource)) === JSON.stringify(configuration(settings))) return { resource, replay: true };
  throw new ApiError(409, "SERVER_ADDRESS_EXISTS", "این IP از قبل ثبت شده است. برای تغییر اطلاعات از ویرایش استفاده کنید.");
}

export async function saveInventoryServer(actor: DemoUser, value: unknown, id?: string) {
  allow(actor);
  const { state: before } = readWorkspace();
  const previous = id === undefined ? undefined : getServer(before.servers, id);
  // Existing inventories can contain lab addresses. A changed address must be public.
  const schema = previous ? serverForm.extend({
    publicIpv4: z.union([inventoryIpv4, z.literal(previous.publicIpv4)]),
    publicIpv6: previous.publicIpv6 ? z.union([ipv6, z.literal(previous.publicIpv6)]).optional() : ipv6.optional(),
    os: z.union([serverForm.shape.os, z.literal(previous.os)]),
  }) : serverForm;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0].path[0] ?? "");
    throw new ApiError(422, "SERVER_INPUT", fieldErrors[field] ?? "فرم اطلاعات سرور معتبر نیست.", { field });
  }
  const { password, fingerprint, sshAuth, ...input } = parsed.data;
  if (input.panelNodeRefs?.length) {
    if (!input.roles.includes("foreign")) throw new ApiError(422, "SERVER_NODE_ROLE", "اتصال نود فقط برای سرور خارج مجاز است.");
    const catalog = await panelAdminNodes(actor);
    const available = new Set(catalog.nodes.filter((node) => !node.fields.parent_id).map((node) => `${node.type}:${node.id}`));
    if (input.panelNodeRefs.some((ref) => !available.has(ref))) throw new ApiError(422, "SERVER_NODE_UNKNOWN", "نود انتخاب‌شده معتبر نیست.");
  }
  const sameIpv6 = previous?.publicIpv6 && input.publicIpv6 && normalIpv6(previous.publicIpv6) === normalIpv6(input.publicIpv6);
  const settings = { ...input, panelNodeRefs: input.panelNodeRefs ?? previous?.panelNodeRefs, publicIpv6: sameIpv6 ? previous.publicIpv6 : input.publicIpv6, roles: [...input.roles].sort() };
  const existing = !previous && existingRegistration(before.servers, settings, password ?? sshAuth);
  if (existing) return existing;
  checkUnique(before.servers, settings, previous);
  const addressChanged = previous?.publicIpv4 !== settings.publicIpv4;
  const metadata = addressChanged ? await lookupServerIp(actor, settings.publicIpv4) : {
    country: previous.country, countryCode: previous.countryCode, provider: previous.provider,
  };
  const ssh = await prepareInventorySsh(id, { ...settings, password, fingerprint, sshAuth });

  return transaction((db) => {
    const { state, revision } = readWorkspace(db);
    const existing = !previous && existingRegistration(state.servers, settings, password ?? sshAuth);
    if (existing) return existing;
    checkUnique(state.servers, settings, previous);
    const current = id === undefined ? undefined : getServer(state.servers, id);
    const identifier = serverIdentifier({ ...metadata, ...settings });
    const resourceId = current?.id ?? (state.servers.some((server) => server.id === identifier) ? randomUUID() : identifier);
    let resource: Server;
    if (current) {
      if (!previous || JSON.stringify(configuration(current)) !== JSON.stringify(configuration(previous))) {
        throw new ApiError(409, "SERVER_SETTINGS_CHANGED", "اطلاعات سرور هم‌زمان تغییر کرده است. فرم را دوباره باز کنید.");
      }
      if ((addressChanged || current.publicIpv6 !== settings.publicIpv6) && provisionBusy(db, current.id)) {
        throw new ApiError(409, "PROVISION_HOST_BUSY", "ابتدا اجرای فعال روی این میزبان را پایان دهید.");
      }
      const name = current.name === serverIdentifier(current) ? identifier : current.name;
      resource = {
        ...current, ...settings, ...metadata, name,
        ...(addressChanged ? { city: "", region: metadata.country } : {}),
      };
      state.servers = state.servers.map((server) => server.id === current.id ? resource : server);
      state.tunnels = state.tunnels.map((tunnel) => {
        const iran = tunnel.iranEndpoint.serverId === current.id;
        const foreign = tunnel.foreignEndpoint.serverId === current.id;
        if (!iran && !foreign) return tunnel;
        if ((iran && !isIranServer(settings.roles)) || (foreign && !settings.roles.includes("foreign"))) {
          throw new ApiError(409, "SERVER_ROLE_IN_USE", "این نقش برای یکی از تونل‌های ثبت‌شده لازم است.");
        }
        if (tunnel.technology === "GRE6" && current.publicIpv6 && !settings.publicIpv6) {
          throw new ApiError(409, "SERVER_IPV6_IN_USE", "این IPv6 برای تونل GRE6 ثبت‌شده لازم است.");
        }
        if (!addressChanged) return tunnel;
        return iran ? { ...tunnel, iranEndpoint: { ...tunnel.iranEndpoint, publicIp: settings.publicIpv4 } }
          : { ...tunnel, foreignEndpoint: { ...tunnel.foreignEndpoint, publicIp: settings.publicIpv4 } };
      });
      if (addressChanged) {
        state.nodes = decorateNodes(state.nodes.map((node) => node.foreignServerId === current.id
          ? { ...node, country: resource.country, countryCode: resource.countryCode, city: resource.city } : node),
        state.servers, state.tunnels, state.dns, state.settings, true);
      }
    } else {
      if (state.servers.length >= 500) throw new ApiError(409, "TOPOLOGY_LIMIT", "ظرفیت موجودی پر است.");
      resource = {
        ...monitoredServer({ ...metadata, ...settings, id: resourceId, name: identifier, city: "" }),
        region: metadata.country,
      };
      state.servers.push(resource);
    }
    ssh.persist(db, resourceId);
    state.audit = [{
      id: randomUUID(), at: new Date().toISOString(), actor: actor.name, role: actor.role,
      action: current ? "servers.update" : "servers.register", target: resourceId,
      detail: current ? "اطلاعات سرور به‌روزرسانی شد." : "سرور در موجودی پایش ثبت شد.", simulated: false,
    }, ...state.audit].slice(0, 2000);
    writeWorkspace(db, state, revision + 1);
    return { resource, replay: false };
  });
}
