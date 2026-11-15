import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { can } from "@/lib/rbac";
import { BUNDLE_TECHS } from "@/lib/topology";
import type { DemoUser, ProvisionCatalogPreview, ProvisionProfile, ProvisionTunnelBinding } from "@/types";
import { digest } from "./auth";
import { readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { tunnelPort, workspaceMode } from "./inventory";
import { tunnelForwarding } from "./providers";
import { bbrProfileId } from "./provision-bbr";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/);
const profileId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const profile = z.object({
  id: profileId, serverId: id, sha256: hash,
  component: z.enum(["NodeGuard Agent", "V2bX", "GOST", "Backhaul", "Rathole", "GRE", "GRE6", "IPIP", "SIT", "WireGuard", "Geneve", "BBR"]),
  version: z.string().regex(/^[\w.+-]{1,64}$/), summary: z.string().min(1).max(300),
  forwardPort: tunnelPort.optional(), forwardTargetPort: tunnelPort.optional(),
  greTransport: z.enum(["native", "udp"]).optional(),
}).strict();
const binding = z.object({ tunnelId: id, iranProfileId: profileId, foreignProfileId: profileId }).strict();
const enrollment = z.object({
  NODEGUARD_PROVISION_PROFILES: z.array(profile).min(1).max(30),
  NODEGUARD_TUNNEL_PROFILES: z.array(binding).max(15).default([]),
}).strict();
const confirmation = z.object({ enrollment, fingerprint: hash }).strict();
type Enrollment = z.output<typeof enrollment>;

const reservedProfiles = new Set(["agent", "iperf", "provision", bbrProfileId]);
const reservedProfile = (id: string) => reservedProfiles.has(id) || id.startsWith("iperf-rx-");
const profileKey = (entry: ProvisionProfile) => entry.serverId + "/" + entry.id;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function profiles(db: DatabaseSync): ProvisionProfile[] {
  const values = z.array(profile).max(500).parse(JSON.parse(process.env.NODEGUARD_PROVISION_PROFILES ?? "[]"));
  const catalog = new Map(values.map((item) => [profileKey(item), item]));
  if (catalog.size !== values.length) throw new Error("Duplicate provision profile");
  for (const row of db.prepare("SELECT payload FROM provision_profiles ORDER BY server_id, profile_id").all()) {
    const stored = profile.parse(JSON.parse(String(row.payload)));
    catalog.set(profileKey(stored), stored);
  }
  return [...catalog.values()].filter((entry) => !reservedProfile(entry.id));
}

export function tunnelBindings(db: DatabaseSync): ProvisionTunnelBinding[] {
  const legacyBinding = binding.extend({ iranProfileId: id, foreignProfileId: id });
  const values = z.array(legacyBinding).max(250).parse(JSON.parse(process.env.NODEGUARD_TUNNEL_PROFILES ?? "[]"));
  const bindings = new Map(values.map((item) => [item.tunnelId, item]));
  if (bindings.size !== values.length) throw new Error("Duplicate tunnel deployment enrollment");
  for (const row of db.prepare("SELECT DISTINCT tunnel_id FROM retired_tunnel_sources").all()) bindings.delete(String(row.tunnel_id));
  for (const row of db.prepare("SELECT payload FROM provision_tunnel_bindings ORDER BY tunnel_id").all()) {
    const stored = binding.parse(JSON.parse(String(row.payload)));
    bindings.set(stored.tunnelId, stored);
  }
  return [...bindings.values()];
}

export function matchingTunnelPort(technology: string, forward: { port?: number; targetPort?: number; error?: string }, iran: ProvisionProfile) {
  const bindsPort = BUNDLE_TECHS.some((item) => item === technology) || (technology === "GOST" && iran.forwardPort !== undefined);
  return !bindsPort || (!forward.error && iran.forwardPort === forward.port &&
    (iran.forwardTargetPort ?? iran.forwardPort) === (forward.targetPort ?? forward.port));
}

function allow(actor: DemoUser) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "ثبت بسته در حالت پایش در دسترس است.");
  if (!can(actor.role, "deploy.run") || !can(actor.role, "server.configure") || !can(actor.role, "tunnel.mutate")) {
    throw new ApiError(403, "FORBIDDEN", "مدیریت کاتالوگ بسته به دسترسی نصب و پیکربندی نیاز دارد.");
  }
}

function plan(db: DatabaseSync, input: Enrollment) {
  const requested = input.NODEGUARD_PROVISION_PROFILES;
  const links = input.NODEGUARD_TUNNEL_PROFILES;
  if (new Set(requested.map(profileKey)).size !== requested.length ||
      new Set(links.map((entry) => entry.tunnelId)).size !== links.length || requested.some((entry) => reservedProfile(entry.id))) {
    throw new ApiError(422, "PROVISION_CATALOG_INPUT", "شناسهٔ تکراری یا رزروشده در فایل ثبت وجود دارد.");
  }
  const workspace = readWorkspace(db);
  const resolveForwarding = tunnelForwarding(db, workspace.state.nodes);
  const catalog = new Map(profiles(db).map((item) => [profileKey(item), item]));
  const bindings = new Map(tunnelBindings(db).map((item) => [item.tunnelId, item]));
  const persistedProfiles = new Set(db.prepare("SELECT server_id, profile_id FROM provision_profiles").all()
    .map((row) => row.server_id + "/" + row.profile_id));
  const persistedLinks = new Set(db.prepare("SELECT tunnel_id FROM provision_tunnel_bindings").all().map((row) => row.tunnel_id));
  const reviewed = new Map<string, ProvisionProfile>();
  for (const entry of requested) {
    if (!workspace.state.servers.some((host) => host.id === entry.serverId)) {
      throw new ApiError(422, "PROVISION_CATALOG_HOST", "میزبان یکی از بسته‌ها در موجودی ثبت نشده است.");
    }
    const existing = catalog.get(profileKey(entry));
    if (existing && !same(existing, entry)) {
      throw new ApiError(409, "PROVISION_CATALOG_PROFILE", "شناسهٔ این بسته قبلاً با مشخصات دیگری ثبت شده است. برای نسخهٔ تازه شناسهٔ تازه بسازید.");
    }
    reviewed.set(profileKey(entry), entry);
    catalog.set(profileKey(entry), entry);
  }

  const updated = links.filter((entry) => {
    const tunnel = workspace.state.tunnels.find((item) => item.id === entry.tunnelId);
    const iran = tunnel && catalog.get(tunnel.iranEndpoint.serverId + "/" + entry.iranProfileId);
    const foreign = tunnel && catalog.get(tunnel.foreignEndpoint.serverId + "/" + entry.foreignProfileId);
    if (!tunnel || !iran || !foreign || iran.serverId === foreign.serverId ||
        iran.component !== tunnel.technology || foreign.component !== tunnel.technology) {
      throw new ApiError(422, "PROVISION_CATALOG_LINK", "بسته‌های دو سمت باید با میزبان‌ها و فناوری تونل ثبت‌شده منطبق باشند.");
    }
    if (!matchingTunnelPort(tunnel.technology, resolveForwarding(tunnel), iran)) {
      throw new ApiError(422, "PROVISION_CATALOG_PORT", "پورت‌های هدایت GOST بستهٔ مبدأ باید با پورت فعلی نود منطبق باشند.");
    }
    reviewed.set(profileKey(iran), iran);
    reviewed.set(profileKey(foreign), foreign);
    if (same(bindings.get(entry.tunnelId), entry)) return !persistedLinks.has(entry.tunnelId);
    const active = db.prepare(`
      SELECT 1 FROM tunnel_deployments WHERE tunnel_id=? AND status IN ('deploying','verifying','rolling_back','review')
    `).get(entry.tunnelId);
    if (active) throw new ApiError(409, "PROVISION_CATALOG_BUSY", "استقرار یا بررسی فعال این تونل را پیش از تغییر نگاشت پایان دهید.");
    return true;
  });
  const reviewedProfiles = [...reviewed.values()];
  const added = reviewedProfiles.filter((entry) => !persistedProfiles.has(profileKey(entry)));
  if ((added.length && catalog.size > 500) ||
      (updated.length && bindings.size + updated.filter((item) => !bindings.has(item.tunnelId)).length > 250)) {
    throw new ApiError(409, "PROVISION_CATALOG_LIMIT", "ظرفیت کاتالوگ بسته یا نگاشت تونل پر است.");
  }

  const preview: ProvisionCatalogPreview = {
    fingerprint: digest(JSON.stringify([input, reviewedProfiles, added.map(profileKey),
      links.map((entry) => [bindings.get(entry.tunnelId) ?? null, persistedLinks.has(entry.tunnelId)])])),
    profiles: reviewedProfiles,
    tunnels: links.map((entry) => ({ ...entry, previous: bindings.get(entry.tunnelId) })),
    addedProfiles: added.length, updatedTunnels: updated.length,
  };
  return { workspace, preview, added, updated };
}

export function previewProvisionCatalog(actor: DemoUser, value: unknown) {
  allow(actor);
  const result = enrollment.safeParse(value);
  if (!result.success) throw new ApiError(422, "PROVISION_CATALOG_INPUT", "فایل فرادادهٔ بسته معتبر نیست.");
  return transaction((db) => plan(db, result.data).preview);
}

export function importProvisionCatalog(actor: DemoUser, value: unknown, connection?: DatabaseSync) {
  allow(actor);
  const result = confirmation.safeParse(value);
  if (!result.success) throw new ApiError(422, "PROVISION_CATALOG_INPUT", "پیش‌نمایش یا فایل فرادادهٔ بسته معتبر نیست.");
  const apply = (db: DatabaseSync) => {
    const { workspace, preview, added, updated } = plan(db, result.data.enrollment);
    if (!added.length && !updated.length) return { addedProfiles: 0, updatedTunnels: 0, replay: true };
    if (preview.fingerprint !== result.data.fingerprint) {
      throw new ApiError(409, "PROVISION_CATALOG_CHANGED", "کاتالوگ بعد از پیش‌نمایش تغییر کرده است. دوباره بررسی کنید.");
    }

    const add = db.prepare("INSERT INTO provision_profiles VALUES (?, ?, ?)");
    for (const entry of added) add.run(entry.serverId, entry.id, JSON.stringify(entry));
    const bind = db.prepare(`
      INSERT INTO provision_tunnel_bindings VALUES (?, ?)
      ON CONFLICT(tunnel_id) DO UPDATE SET payload=excluded.payload
    `);
    for (const entry of updated) bind.run(entry.tunnelId, JSON.stringify(entry));
    workspace.state.audit = [{
      id: randomUUID(), at: new Date().toISOString(), actor: actor.name, role: actor.role,
      action: "provision.catalog.import", target: "provision",
      detail: `${added.length} بسته و ${updated.length} نگاشت ثبت شد.`, simulated: false,
    }, ...workspace.state.audit].slice(0, 2000);
    writeWorkspace(db, workspace.state, workspace.revision + 1);
    return { addedProfiles: added.length, updatedTunnels: updated.length, replay: false };
  };
  return connection ? apply(connection) : transaction(apply);
}
