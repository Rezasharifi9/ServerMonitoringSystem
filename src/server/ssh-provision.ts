import { createHash, createHmac, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { can } from "@/lib/rbac";
import type { DemoUser, ForwarderBundleRecipe, ProvisionProfile, TunnelBundleRecipe } from "@/types";
import { issueAgentInvitation } from "./agent-enrollment";
import { downloadAgentInstaller } from "./agent-installer";
import { pushAudit } from "./activity-log";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { tunnelPort, workspaceMode } from "./inventory";
import { checkProvisionHost, provisionBusy, provisionEnabled, queueProvision } from "./provision";
import { importProvisionCatalog, previewProvisionCatalog, tunnelBindings } from "./provision-catalog";
import { inventoryIpv4, lookupServerIp, saveInventoryServer } from "./server-management";
import { inventorySshFields, runServerInstaller, serverSshSettings } from "./ssh-connection";
import { getTunnelBundleRecipe } from "./topology";
import { startTunnelDeployment, tunnelDeploymentPreview } from "./tunnel-deployments";
import { buildPanelV2bxConfig, panelNodeReference } from "./v2board-nodes";
import { storeProvisionDownload } from "./provision-download";
import { supportsIptables, supportsProvisionDownload } from "./agent-workers";
import { readForwarderSettings, validateForwarderListeners } from "./forwarder-settings";
import type { ForwarderSettings } from "@/lib/forwarder-config";
import { readV2bxFiles } from "./v2bx-files";

const exec = promisify(execFile);
const root = () => join(process.cwd(), "agent");
const id = z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i);
const profileId = z.string().regex(/^[a-z\d][a-z\d_-]{0,59}$/i);
const iface = z.string().regex(/^[a-z\d][a-z\d_.:-]{0,14}$/i);
const architecture = z.enum(["amd64", "arm64"]);
const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("v2bx"), serverId: id, architecture,
    config: z.string().min(2).max(96000).optional(), panelNode: panelNodeReference.optional(),
    secondPanelNode: panelNodeReference.optional(), applyFiles: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal("tunnel"), tunnelId: id, iranPort: tunnelPort.optional(), foreignPort: tunnelPort.optional(),
    gostArchitecture: architecture.optional(), operation: z.literal("rebuild").optional() }).strict(),
]);

export function sshInstallEnabled() {
  return workspaceMode() === "monitor" && process.env.NODEGUARD_ENABLE_SSH_INSTALL === "1";
}

function allow(actor: DemoUser) {
  if (!sshInstallEnabled()) throw new ApiError(503, "SSH_INSTALL_DISABLED", "نصب از راه SSH در کنترل‌پلین فعال نیست.");
  if (!can(actor.role, "server.configure") || !can(actor.role, "deploy.run") || !can(actor.role, "agent.enroll")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی نصب و مدیریت سرور لازم است.");
  }
}

export async function withHosts<T>(ids: string[], work: (leaseOwner: string) => Promise<T>, activity = "ssh") {
  const owner = activity + "/" + randomUUID();
  transaction((db) => {
    const now = Date.now();
    const claim = db.prepare(`INSERT INTO ssh_operation_leases VALUES (?,?,?)
      ON CONFLICT(server_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
      WHERE ssh_operation_leases.expires_at<=?`);
    for (const id of new Set(ids)) {
      if (!claim.run(id, owner, now + 600000, now).changes) {
        throw new ApiError(409, "SSH_OPERATION_BUSY", "عملیات آماده‌سازی SSH دیگری روی این میزبان فعال است.");
      }
    }
  });
  try {
    return await work(owner);
  } finally {
    transaction((db) => db.prepare("DELETE FROM ssh_operation_leases WHERE owner=?").run(owner));
  }
}

function requireLogin(actor: DemoUser, serverId: string) {
  if (!serverSshSettings(actor, serverId).connection) {
    throw new ApiError(409, "SSH_REQUIRED", "ابتدا اتصال SSH میزبان را در جزئیات سرور ذخیره کنید.");
  }
}

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
async function remote(actor: DemoUser, serverId: string, header: { kind: "agent" } & Record<string, unknown>, data: Iterable<Buffer>) {
  const program = await readFile(join(root(), "ssh_stage.py"), "utf8");
  for (let attempt = 0; ; attempt++) {
    const payload = Readable.from((async function* () {
      yield Buffer.from(JSON.stringify(header) + "\n");
      yield* data;
    })(), { objectMode: false });
    try {
      await runServerInstaller(actor, serverId, program.replaceAll("\r\n", "\n"), payload);
      return;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const details = error.details as { phase?: string; reason?: string } | undefined;
      if (attempt === 0 && error.code === "SSH_CONNECTION" && details?.phase === "handshake" &&
          ["client-socket", "client-timeout"].includes(details.reason ?? "")) {
        await delay(500);
        continue;
      }
      throw new ApiError(error.status, error.code, error.message, { ...details, serverId, operation: header.kind });
    }
  }
}

function requireAgentInstall(actor: DemoUser) {
  allow(actor);
  const origin = URL.parse(process.env.NODEGUARD_ORIGIN ?? "");
  if (!origin || origin.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new ApiError(409, "SSH_AGENT_ORIGIN", "برای ثبت از راه دور، کنترل‌پلین باید یک نشانی HTTPS قابل دسترسی از میزبان داشته باشد.");
  }
}

const latestAgentReport = (serverId: string) => database().prepare(
  "SELECT id FROM agent_reports WHERE server_id=? ORDER BY observed_at DESC LIMIT 1",
).get(serverId)?.id;

export async function installAgentOverSsh(actor: DemoUser, serverId: string, value: unknown, request: Request) {
  requireAgentInstall(actor);
  requireLogin(actor, serverId);
  const input = z.object({ interface: iface.optional() }).strict().safeParse(value);
  if (!input.success) throw new ApiError(422, "SSH_AGENT_INTERFACE", "نام رابط شبکهٔ میزبان معتبر نیست.");
  return withHosts([serverId], async () => {
    // An old job awaiting review must not prevent repairing the Agent itself.
    // Keep live queued/running provision work protected during credential rotation.
    if (database().prepare(`SELECT 1 FROM provision_jobs WHERE server_id=?
      AND ((status='queued' AND queue_until>?) OR (status='running' AND lease_until>?))`)
      .get(serverId, Date.now(), Date.now())) {
      throw new ApiError(409, "PROVISION_HOST_BUSY", "ابتدا کار فعال روی میزبان را پایان دهید.");
    }
    const installer = Buffer.from(await (await downloadAgentInstaller(actor, serverId, request)).arrayBuffer());
    // Panel credentials do not prove that the remote token survived an OS rebuild.
    // Enrollment rotates the credential only after the remote installer redeems it.
    const code = issueAgentInvitation(actor, serverId).code;
    const previousReport = latestAgentReport(serverId);
    await remote(actor, serverId, { kind: "agent", interface: input.data.interface ?? null, code, size: installer.length, sha256: digest(installer) }, [installer]);
    transaction((db) => {
      const { state, revision } = readWorkspace(db);
      pushAudit(state, actor, "install.agent", serverId, "نصب Agent از طریق SSH انجام شد.");
      writeWorkspace(db, state, revision + 1);
    });
    const deadline = Date.now() + 25000;
    do {
      const report = latestAgentReport(serverId);
      if (report && report !== previousReport) return { installed: true, reporting: true, serverId };
      await delay(1000);
    } while (Date.now() < deadline);
    return { installed: true, reporting: false, serverId };
  }, "agent");
}

const agentHostInput = z.object({ publicIpv4: inventoryIpv4, ...inventorySshFields }).required({ password: true }).strict();

export async function registerAndInstallAgent(actor: DemoUser, value: unknown, request: Request) {
  requireAgentInstall(actor);
  const parsed = agentHostInput.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "SSH_AGENT_HOST", "IPv4 عمومی، نام کاربری، پورت و رمز SSH را بررسی کنید.");
  const input = parsed.data;
  const existing = readWorkspace().state.servers.find((server) => server.publicIpv4 === input.publicIpv4);
  const countryCode = existing?.countryCode ?? (await lookupServerIp(actor, input.publicIpv4)).countryCode;
  const { resource } = await saveInventoryServer(actor, {
    ...input, publicIpv6: existing?.publicIpv6, os: existing?.os ?? "Other Linux",
    roles: existing?.roles ?? [countryCode === "IR" ? "iran" : "foreign"],
  }, existing?.id);
  return installAgentOverSsh(actor, resource.id, {}, request);
}

function preflightHosts(ids: string[]) {
  if (!provisionEnabled()) throw new ApiError(503, "PROVISION_DISABLED", "Provision عملیاتی در کنترل‌پلین فعال نیست.");
  transaction((db) => {
    for (const id of ids) {
      checkProvisionHost(db, id);
      if (!supportsProvisionDownload(db, id, Date.now())) {
        throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "Agent میزبان را از مدیریت سرورها نصب یا به‌روز کنید و منتظر اتصال Worker بمانید.", { serverId: id });
      }
    }
    if (provisionBusy(db, ...ids)) throw new ApiError(409, "PROVISION_HOST_BUSY", "روی یکی از میزبان‌ها عملیات نصب فعال است.");
  });
}

function wgKey(requestKey: string, actorId: string, tunnelId: string, side: string, port: number) {
  const secret = process.env.NODEGUARD_CREDENTIAL_KEY ?? "";
  if (!/^[a-f\d]{64}$/i.test(secret)) throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید کنترل‌پلین برای تولید کلید WireGuard لازم است.");
  const bytes = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(JSON.stringify(["nodeguard-wireguard-v1", actorId, requestKey, tunnelId, side])).digest();
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), bytes]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { key: bytes.toString("base64"), publicKey: publicKey.toString("base64"), port };
}

type Enrollment = {
  NODEGUARD_PROVISION_PROFILES: ProvisionProfile[];
  NODEGUARD_TUNNEL_PROFILES?: { tunnelId: string; iranProfileId: string; foreignProfileId: string }[];
};

async function storePackages(output: string, enrollment: Enrollment) {
  const sideFolders = await readdir(output, { withFileTypes: true });
  const profiles = enrollment.NODEGUARD_PROVISION_PROFILES;
  const paths = new Map<string, string>();
  for (const side of sideFolders.filter((entry) => entry.isDirectory())) {
    for (const profile of await readdir(join(output, side.name))) {
      if (!profileId.safeParse(profile).success || paths.has(profile)) throw new Error("Unexpected profile");
      paths.set(profile, join(output, side.name, profile));
    }
  }
  for (const profile of profiles) {
    const directory = paths.get(profile.id);
    if (!directory) throw new Error("Missing generated profile");
    await storeProvisionDownload(profile, directory);
  }
}

export async function installFromPanel(actor: DemoUser, value: unknown, requestKey: string) {
  if (!can(actor.role, "server.configure") || !can(actor.role, "deploy.run")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی نصب و مدیریت سرور لازم است.");
  }
  if (!/^[\w-]{12,128}$/.test(requestKey)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "SSH_PROVISION_INPUT", "مشخصات نصب یا تونل معتبر نیست.");
  const input = parsed.data;
  let recipe: TunnelBundleRecipe | ForwarderBundleRecipe | undefined;
  let keys: Record<"iran" | "foreign", ReturnType<typeof wgKey>> | undefined;
  let config: string | undefined;
  let forwarder: ForwarderSettings | undefined;
  if (input.kind === "v2bx") {
    const references = [input.panelNode, input.secondPanelNode].filter((item): item is string => Boolean(item));
    if (Boolean(input.config) === Boolean(input.panelNode) || Boolean(input.config && input.secondPanelNode)) {
      throw new ApiError(422, "V2BX_CONFIG", "یک نود V2Board را برای نصب انتخاب کنید.");
    }
    if (input.panelNode && input.secondPanelNode === input.panelNode) {
      throw new ApiError(422, "V2BX_CONFIG", "نود دوم باید با نود اول متفاوت باشد.");
    }
    if (input.panelNode && !readWorkspace().state.servers.some((server) => server.id === input.serverId && server.roles.includes("foreign"))) {
      throw new ApiError(422, "V2BX_HOST", "برای نصب V2bX یک سرور خارج را انتخاب کنید.");
    }
    const host = readWorkspace().state.servers.find((server) => server.id === input.serverId);
    if (host?.panelNodeRefs && references.some((ref) => !host.panelNodeRefs!.includes(ref))) {
      throw new ApiError(422, "V2BX_NODE_HOST", "نود انتخاب‌شده به این سرور متصل نیست.");
    }
    config = references.length ? await buildPanelV2bxConfig(actor, references) : input.config;
    try {
      const parsedConfig = JSON.parse(config ?? "");
      if (!parsedConfig || !Array.isArray(parsedConfig.Nodes) || !parsedConfig.Nodes.length) throw new Error("Nodes");
    } catch {
      throw new ApiError(422, "V2BX_CONFIG", "پیکربندی JSON باید دست‌کم یک نود در Nodes داشته باشد.");
    }
  } else {
    const selected = await getTunnelBundleRecipe(actor, input.tunnelId, true);
    recipe = selected;
    if (["Rathole", "Backhaul"].includes(recipe.technology)) {
      forwarder = readForwarderSettings(input.tunnelId);
      if (!forwarder || forwarder.technology !== recipe.technology) throw new ApiError(422, "FORWARDER_SETTINGS_REQUIRED", "ابتدا تنظیمات دو سمت تونل را در پنل ذخیره کنید.");
      validateForwarderListeners(input.tunnelId, forwarder);
    }
    if (!("mtu" in recipe) && !forwarder && (recipe.technology !== "GOST" || !recipe.port)) {
      throw new ApiError(422, "TUNNEL_AGENT_TECH", "نصب خودکار برای تونل‌های رابط‌دار و مسیر GOST دارای پورت ثبت‌شده در دسترس است.");
    }
    if (recipe.technology === "GOST" && recipe.iran.outerIp === recipe.foreign.outerIp) {
      throw new ApiError(422, "TUNNEL_ENDPOINTS", "آدرس عمومی مبدأ و مقصد هدایت GOST باید متفاوت باشد.");
    }
    if ("mtu" in recipe && (!recipe.iran.interfaceName || !recipe.foreign.interfaceName)) {
      throw new ApiError(422, "TUNNEL_INTERFACES", "نام رابط هر دو سمت تونل را ثبت کنید.");
    }
    if (recipe.technology === "WireGuard") {
      if (!input.iranPort || !input.foreignPort) throw new ApiError(422, "WIREGUARD_PORTS", "پورت UDP هر دو سمت را وارد کنید.");
      keys = {
        iran: wgKey(requestKey, actor.id, input.tunnelId, "iran", input.iranPort),
        foreign: wgKey(requestKey, actor.id, input.tunnelId, "foreign", input.foreignPort),
      };
    } else if (input.iranPort || input.foreignPort) {
      throw new ApiError(422, "TUNNEL_PORTS", "پورت‌های UDP دو سمت فقط برای WireGuard هستند.");
    }
  }
  const servers = recipe ? [recipe.iran.serverId] : input.kind === "v2bx" ? [input.serverId] : [];
  if (recipe) servers.push(recipe.foreign.serverId);
  if (!can(actor.role, "tunnel.mutate")) throw new ApiError(403, "FORBIDDEN", "دسترسی ثبت بسته لازم است.");
  return withHosts(servers, async (leaseOwner) => {
    preflightHosts(servers);
    if (forwarder && servers.some(id => {
      const parts = readWorkspace().state.servers.find(s => s.id === id)?.agent.version.split(".").map(Number) ?? [];
      return !(parts[0] > 0 || parts[0] === 0 && (parts[1] > 5 || parts[1] === 5 && parts[2] >= 2));
    })) throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "برای پیکربندی و پایش Rathole/Backhaul، Agent هر دو میزبان را به نسخهٔ 0.5.2 ارتقا دهید.");
    const forwardingHost = recipe?.port && !forwarder ? recipe.iran.serverId : undefined;
    if (forwardingHost && !transaction((db) => supportsIptables(db, forwardingHost, Date.now()))) {
      throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "Agent سمت ایران را برای پشتیبانی از iptables به‌روز کنید.");
    }
    const temp = await mkdtemp(join(tmpdir(), "nodeguard-build-"));
    try {
      const spec = join(temp, "input.json");
      const output = join(temp, "bundle");
      const v2bxFiles = input.kind === "v2bx" && input.applyFiles ? readV2bxFiles(input.serverId) : undefined;
      if (v2bxFiles && (v2bxFiles.route !== null || v2bxFiles.outbound !== null) &&
          !JSON.parse(config!).Cores?.some((core: { Type?: string }) => core.Type === "xray")) {
        throw new ApiError(422, "V2BX_FILES_CORE", "فایل‌های Route و Outbound فقط برای هستهٔ Xray قابل اعمال هستند؛ گزینهٔ اعمال فایل‌ها را غیرفعال کنید یا نود Xray انتخاب کنید.");
      }
      await writeFile(spec, JSON.stringify({ ...input, config, recipe, keys, forwarder,
        ...(v2bxFiles ? { v2bxFiles } : {}) }), { mode: 0o600 });
      try {
        const python = process.env.NODEGUARD_BUILD_PYTHON ?? (process.platform === "win32" ? "python" : "/usr/bin/python3");
        await exec(python, ["-B", join(root(), "build_ssh_bundle.py"), spec, output],
          { timeout: 90000, maxBuffer: 32 * 1024 });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
        const reason = /NodeGuard bundle error: ([A-Za-z]+)\b/.exec(stderr)?.[1];
        throw new ApiError(502, "PROVISION_BUILD", "ساخت بسته ناموفق بود. دسترسی به نسخهٔ تأییدشده و Python 3.11 یا بالاتر را بررسی کنید.", { code, reason });
      }
      const enrollment = JSON.parse(await readFile(join(output, "enrollment.json"), "utf8")) as Enrollment;
      const preview = previewProvisionCatalog(actor, enrollment);
      await storePackages(output, enrollment);
      if (input.kind === "v2bx") {
        importProvisionCatalog(actor, { enrollment, fingerprint: preview.fingerprint });
        const [profile] = enrollment.NODEGUARD_PROVISION_PROFILES;
        const result = queueProvision(actor, { operation: "apply", serverId: profile.serverId, profileId: profile.id, sha256: profile.sha256 }, requestKey);
        return transaction((db) => {
          for (const reference of [input.panelNode, input.secondPanelNode].filter((item): item is string => Boolean(item))) {
            db.prepare(`INSERT OR IGNORE INTO v2bx_install_nodes VALUES (?,?,?)`)
              .run(input.serverId, reference, result.job.id);
          }
          return result;
        });
      }
      return transaction((db) => {
        const previousBinding = tunnelBindings(db).find((item) => item.tunnelId === input.tunnelId);
        importProvisionCatalog(actor, { enrollment, fingerprint: preview.fingerprint }, db);
        const current = tunnelDeploymentPreview(db, input.tunnelId);
        if (!current) throw new ApiError(409, "TUNNEL_DEPLOYMENT_CHANGED", "پیش‌نمایش ثبت‌شدهٔ تونل پیدا نشد.");
        return startTunnelDeployment(actor, { tunnelId: input.tunnelId, fingerprint: current.fingerprint, operation: input.operation }, requestKey,
          { db, leaseOwner, previousBinding });
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, input.kind);
}
