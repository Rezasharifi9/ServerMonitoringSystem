import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";
import { type Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { Client, utils, type ClientChannel } from "ssh2";
import { z } from "zod";
import { can } from "@/lib/rbac";
import type { DemoUser } from "@/types";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { canStorePanelCredentials, readSealedCredential, writeSealedCredential } from "./provider-secrets";

const username = z.string().trim().regex(/^[a-zA-Z0-9_.@-]{1,128}$/);
const port = z.number().int().min(1).max(65535);
const fingerprint = z.string().trim().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
const password = z.string().min(1).max(1024);
const common = { ip: z.string().refine((value) => Boolean(isIP(value))), username, port, fingerprint };
const sshInput = z.discriminatedUnion("method", [
  z.object({ ...common, method: z.literal("password"), password }).strict(),
  z.object({ ...common, method: z.literal("key"), privateKey: z.string().trim().min(1).max(20000),
    passphrase: z.string().max(1024).optional() }).strict(),
]);
type Login = z.infer<typeof sshInput>;
type SshTarget = Pick<Login, "ip" | "username" | "port">;
const scope = (id: string) => "ssh:" + id;

export const inventorySshFields = {
  sshUsername: username.default("root"), sshPort: port.default(22),
  password: password.optional(), fingerprint: fingerprint.optional(),
  sshAuth: z.literal("panel-key").optional(),
};

function panelSshKey() {
  if (!canStorePanelCredentials()) throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید رمزنگاری کنترل‌پلین لازم است.");
  return transaction((db) => {
    const scope = "ssh-panel-key";
    const saved = readSealedCredential(db, scope);
    if (saved) return z.object({ private: z.string(), public: z.string() }).parse(saved);
    const key = utils.generateKeyPairSync("ed25519", { comment: "nodeguard-panel" });
    writeSealedCredential(db, scope, key);
    return key;
  });
}

export function panelSshPublicKey(actor: DemoUser) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "server.configure")) throw new ApiError(403, "FORBIDDEN", "دسترسی پیکربندی سرور لازم است.");
  return { publicKey: panelSshKey().public };
}

export async function prepareInventorySsh(serverId: string | undefined, input: {
  publicIpv4: string; publicIpv6?: string; sshUsername: string; sshPort: number; password?: string; fingerprint?: string; sshAuth?: "panel-key";
}) {
  const previous = serverId ? savedLogin(serverId) : undefined;
  const newCredential = (input.password && (previous?.method !== "password" || input.password !== previous.password)) || input.sshAuth;
  const ip = previous && !newCredential && [input.publicIpv4, input.publicIpv6].includes(previous.ip)
    ? previous.ip : input.publicIpv4;
  const pin = input.fingerprint ?? (previous?.ip === ip || !newCredential ? previous?.fingerprint : undefined);
  const settings = { ip, username: input.sshUsername, port: input.sshPort };
  if (newCredential && !pin) {
    if (!canStorePanelCredentials()) {
      throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید رمزنگاری کنترل‌پلین برای ذخیرهٔ رمز SSH لازم است.");
    }
    return withSsh(settings, async () => {
      throw new ApiError(502, "SSH_CONNECTION", "دریافت کلید میزبان SSH موفق نبود.");
    });
  }
  const login = input.sshAuth && pin ? { ...settings, fingerprint: pin, method: "key" as const, privateKey: panelSshKey().private }
    : input.password && pin ? { ...settings, fingerprint: pin, method: "password" as const, password: input.password }
    : previous ? { ...previous, ...settings } : undefined;
  const changed = !isDeepStrictEqual(previous, login);
  if (login && changed && !canStorePanelCredentials()) {
    throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید رمزنگاری کنترل‌پلین برای ذخیرهٔ رمز SSH لازم است.");
  }
  if (login && changed) await withSsh(login, async () => undefined);
  return {
    persist(db: DatabaseSync, id: string) {
      const current = serverId ? readSealedCredential(db, scope(id)) : undefined;
      if (serverId && !isDeepStrictEqual(current === undefined ? undefined : parseLogin(id, current), previous)) {
        throw new ApiError(409, "SSH_SETTINGS_CHANGED", "تنظیمات SSH هم‌زمان تغییر کرده است. دوباره تلاش کنید.");
      }
      if (login && changed) writeSealedCredential(db, scope(id), login);
    },
  };
}

function validateHost(serverId: string, ip?: string) {
  const host = readWorkspace().state.servers.find((item) => item.id === serverId);
  if (!host) throw new ApiError(404, "SERVER_UNKNOWN", "سرور در موجودی ثبت نشده است.");
  if (ip && ![host.publicIpv4, host.publicIpv6].includes(ip)) {
    throw new ApiError(422, "SSH_ADDRESS", "IP اتصال باید یکی از آدرس‌های ثبت‌شدهٔ همین سرور باشد.");
  }
}

function allow(actor: DemoUser, serverId: string) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "SSH در حالت پایش در دسترس است.");
  if (!can(actor.role, "server.configure")) throw new ApiError(403, "FORBIDDEN", "دسترسی پیکربندی سرور لازم است.");
  validateHost(serverId);
}

function parseLogin(serverId: string, value: unknown) {
  const parsed = sshInput.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "SSH_INPUT", "IP، نام کاربری، روش ورود و اثرانگشت SHA256 میزبان را بررسی کنید.");
  validateHost(serverId, parsed.data.ip);
  return parsed.data;
}

function withSsh<T>(target: Login | SshTarget, work: (client: Client) => Promise<T>, timeoutMs = 9000) {
  const login = "method" in target ? target : undefined;
  const expected = login && Buffer.from(login.fingerprint.slice(7), "base64");
  return new Promise<T>((resolve, reject) => {
    const client = new Client();
    let hostError: ApiError | undefined;
    let finished = false;
    let ready = false;
    const unavailable = (reason?: string) => hostError ?? new ApiError(502, "SSH_CONNECTION",
      ready ? "اتصال SSH هنگام اجرای عملیات قطع شد." : "ارتباط یا احراز هویت SSH موفق نبود.",
      { phase: ready ? "operation" : "handshake", reason });
    const timeout = setTimeout(() => { fail(unavailable()); client.destroy(); }, timeoutMs);
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      settle();
      client.end();
    };
    const fail = (error: unknown) => finish(() => reject(error));
    client.on("error", (error) => fail(unavailable(error.level)));
    client.once("close", () => fail(unavailable()));
    client.once("ready", () => {
      ready = true;
      void work(client).then((value) => finish(() => resolve(value)), fail);
    });
    try {
      client.connect({
        host: target.ip, port: target.port, username: target.username,
        readyTimeout: Math.min(timeoutMs - 1000, 20000), keepaliveInterval: 5000,
        hostVerifier: (key: Buffer) => {
          const digest = createHash("sha256").update(key).digest();
          if (!expected) {
            hostError = new ApiError(422, "SSH_HOST_CONFIRMATION", "کلید میزبان SSH را تأیید کنید.", {
              fingerprint: "SHA256:" + digest.toString("base64").replace(/=$/, ""),
            });
          } else if (!timingSafeEqual(digest, expected)) {
            hostError = new ApiError(409, "SSH_HOST_KEY", "اثر انگشت میزبان SSH با مقدار تأییدشده مطابقت ندارد.");
          }
          return !hostError;
        },
        ...(login?.method === "password" && { password: login.password }),
        ...(login?.method === "key" && { privateKey: login.privateKey, passphrase: login.passphrase }),
      });
    } catch {
      fail(new ApiError(422, "SSH_KEY", "قالب کلید SSH یا گذرواژهٔ کلید معتبر نیست."));
    }
  });
}

function savedLogin(serverId: string) {
  const value = readSealedCredential(database(), scope(serverId));
  return value === undefined ? undefined : parseLogin(serverId, value);
}

export function serverSshSettings(actor: DemoUser, serverId: string) {
  allow(actor, serverId);
  const login = savedLogin(serverId);
  return { available: canStorePanelCredentials(), connection: login ? {
    ip: login.ip, username: login.username, port: login.port, fingerprint: login.fingerprint, method: login.method,
  } : null };
}

export function revealServerSshPassword(actor: DemoUser, serverId: string) {
  allow(actor, serverId);
  const login = savedLogin(serverId);
  if (login?.method !== "password") throw new ApiError(404, "SSH_PASSWORD", "رمز SSH برای این سرور ذخیره نشده است.");
  return { password: login.password };
}

const consoles = new Map<string, { actor: string; server: string; channel?: ClientChannel }>();

const consoleGeometry = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(200),
}).strict();

function consoleSize(value: unknown, fallback: boolean) {
  if (value == null && fallback) return { cols: 100, rows: 28 };
  const parsed = consoleGeometry.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "SSH_CONSOLE", "اندازهٔ کنسول معتبر نیست.");
  return parsed.data;
}

export function openServerConsole(actor: DemoUser, serverId: string, id: string, signal: AbortSignal, requestedSize?: unknown) {
  allow(actor, serverId);
  const login = savedLogin(serverId);
  if (!login) throw new ApiError(409, "SSH_REQUIRED", "ابتدا اتصال SSH این سرور را ذخیره کنید.");
  if (!z.string().uuid().safeParse(id).success) throw new ApiError(422, "SSH_CONSOLE", "شناسهٔ کنسول معتبر نیست.");
  if (consoles.size >= 8 || consoles.has(id) || [...consoles.values()].some((session) => session.actor === actor.id && session.server === serverId)) {
    throw new ApiError(409, "SSH_CONSOLE", "یک نشست کنسول برای این سرور باز است یا ظرفیت نشست‌ها تکمیل شده است.");
  }
  const size = consoleSize(requestedSize, true);
  const session: { actor: string; server: string; channel?: ClientChannel } = { actor: actor.id, server: serverId };
  consoles.set(id, session);
  let closed = false;
  let disconnect: (() => void) | undefined;
  const stop = () => {
    closed = true;
    consoles.delete(id);
    signal.removeEventListener("abort", stop);
    disconnect?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      if (closed) { controller.close(); return; }
      const output = (data: Buffer | Uint8Array) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(data));
        if ((controller.desiredSize ?? 0) <= 0) session.channel?.pause();
      };
      void withSsh(login, (client) => new Promise<void>((resolve, reject) => {
        disconnect = () => { client.end(); resolve(); };
        if (closed) { disconnect(); return; }
        client.shell({ term: "xterm-256color", cols: size.cols, rows: size.rows }, (error, channel) => {
          if (error) { reject(error); return; }
          if (closed) { channel.close(); resolve(); return; }
          session.channel = channel;
          channel.on("data", output).on("error", reject).once("close", resolve);
          channel.stderr.on("data", output);
        });
      }), 15 * 60000).catch(() => output(new TextEncoder().encode("\r\nSSH connection closed or unavailable.\r\n")))
        .finally(() => {
          if (!closed) controller.close();
          stop();
        });
    },
    pull() { session.channel?.resume(); },
    cancel: stop,
  });
  return new Response(stream, { headers: {
    "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no",
  } });
}

export function sendServerConsoleInput(actor: DemoUser, serverId: string, id: string, value: unknown) {
  allow(actor, serverId);
  const parsed = z.object({ text: z.string().min(1).max(8192) }).strict().safeParse(value);
  if (!parsed.success) throw new ApiError(422, "SSH_CONSOLE", "ورودی کنسول معتبر نیست.");
  const session = consoles.get(id);
  if (!session?.channel || session.actor !== actor.id || session.server !== serverId) {
    throw new ApiError(409, "SSH_CONSOLE", "اتصال کنسول آماده نیست.");
  }
  if (session.channel.writableNeedDrain) throw new ApiError(429, "SSH_CONSOLE", "ارسال ورودی کنسول موقتاً متوقف شده است.");
  session.channel.write(parsed.data.text);
}

export function resizeServerConsole(actor: DemoUser, serverId: string, id: string, value: unknown) {
  allow(actor, serverId);
  const size = consoleSize(value, false);
  const session = consoles.get(id);
  if (!session?.channel || session.actor !== actor.id || session.server !== serverId) {
    throw new ApiError(409, "SSH_CONSOLE", "اتصال کنسول آماده نیست.");
  }
  try { session.channel.setWindow(size.rows, size.cols, size.rows * 17, size.cols * 9); }
  catch { throw new ApiError(409, "SSH_CONSOLE", "اتصال کنسول آماده نیست."); }
}

export async function saveServerSsh(actor: DemoUser, serverId: string, value: unknown) {
  allow(actor, serverId);
  if (!canStorePanelCredentials()) throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید رمزنگاری کنترل‌پلین لازم است.");
  const login = parseLogin(serverId, value);
  await withSsh(login, async () => {});
  transaction((db) => {
    validateHost(serverId, login.ip);
    writeSealedCredential(db, scope(serverId), login);
    const { state, revision } = readWorkspace(db);
    state.servers = state.servers.map((server) => server.id === serverId
      ? { ...server, sshUsername: login.username, sshPort: login.port } : server);
    state.audit = [{
      id: randomUUID(), at: new Date().toISOString(), actor: actor.name, role: actor.role, action: "ssh.configure",
      target: serverId, detail: "اتصال SSH تأیید و اعتبارنامه رمزنگاری شد.", simulated: false,
    }, ...state.audit].slice(0, 2000);
    writeWorkspace(db, state, revision + 1);
  });
  return serverSshSettings(actor, serverId);
}

export function deleteServerSsh(actor: DemoUser, serverId: string) {
  allow(actor, serverId);
  database().prepare("DELETE FROM provider_credentials WHERE provider=?").run(scope(serverId));
  return { removed: true };
}

export async function testServerSsh(actor: DemoUser, serverId: string, value: unknown) {
  allow(actor, serverId);
  await withSsh(parseLogin(serverId, value), async () => {});
  return { connected: true };
}

export async function runServerInstaller(actor: DemoUser, serverId: string, program: string, input: Readable,
  context: "agent" | "v2bx-files" = "agent") {
  allow(actor, serverId);
  const login = savedLogin(serverId);
  if (!login) throw new ApiError(409, "SSH_REQUIRED", "ابتدا اتصال SSH این سرور را تأیید و ذخیره کنید.");
  const bootstrap = "set -eu; if [ $(id -u) != 0 ]; then echo NODEGUARD_PHASE:privilege >&2; exit 1; fi; " +
    "echo NODEGUARD_PHASE:prerequisites >&2; " +
    "if [ ! -x /usr/bin/python3 ]; then export DEBIAN_FRONTEND=noninteractive; " +
    "apt-get -o DPkg::Lock::Timeout=180 update >&2 && apt-get -o DPkg::Lock::Timeout=180 install -y python3 ca-certificates >&2; fi; " +
    "exec /usr/bin/python3 -I -c '" + program.replaceAll("'", "'\\''") + "'";
  const quoted = "'" + bootstrap.replaceAll("'", "'\\''") + "'";
  try {
    await withSsh(login, async (client) => {
      const passwordless = login.username === "root" || await new Promise<boolean>((resolve) => {
        client.exec("/usr/bin/sudo -n -- /usr/bin/true", (error, channel) => {
          if (error) return resolve(false);
          channel.resume(); channel.stderr.resume();
          channel.once("error", () => resolve(false));
          channel.once("close", (status: number) => resolve(status === 0));
        });
      });
      if (!passwordless && login.method !== "password") throw new ApiError(403, "SSH_PRIVILEGE", "کاربر SSH به sudo بدون رمز دسترسی ندارد؛ اتصال root یا کاربر دارای دسترسی مناسب را ذخیره کنید.", { phase: "privilege" });
      const command = (login.username === "root" ? "" : passwordless ? "/usr/bin/sudo -n -- " : "/usr/bin/sudo -S -p '' -- ") + "/bin/sh -c " + quoted;
      await new Promise<void>((resolve, reject) => {
        client.exec(command, (error, channel) => {
          if (error) { reject(new ApiError(502, "SSH_EXEC", "باز کردن نشست نصب روی میزبان ناموفق بود.")); return; }
          let phase = "privilege";
          let tail = "";
          channel.resume();
          channel.stderr.on("data", (data: Buffer) => {
            tail = (tail + data.toString()).slice(-4096);
            for (const match of tail.matchAll(/NODEGUARD_PHASE:(privilege|prerequisites|upload|installation|enrollment|services)/g)) phase = match[1];
          });
          channel.once("error", () => reject(new ApiError(502, "SSH_EXEC", "انتقال بسته روی SSH متوقف شد.", { phase: "upload" })));
          channel.once("close", (status: number) => {
            if (status === 0) return resolve();
            if (context === "v2bx-files" && phase === "installation") {
              const restored = tail.includes("NODEGUARD_V2BX_FILES:rolled_back");
              const recovering = tail.includes("NODEGUARD_V2BX_FILES:rollback_failed");
              const missingAssets = tail.includes("Required Xray geodata missing:");
              const message = restored
                ? "اعمال تنظیمات V2bX ناموفق بود؛ تنظیمات قبلی و سرویس با موفقیت بازگردانده شدند."
                : recovering
                  ? "اعمال تنظیمات V2bX و بازگردانی فوری ناموفق بود؛ بازیاب مستقل سرور بازگردانی را دوباره انجام می‌دهد."
                  : missingAssets
                    ? "فایل GeoIP یا GeoSite موردنیاز روی سرور موجود نیست؛ سرویس V2bX تغییر نکرد."
                    : "اعمال فایل‌های V2bX ناموفق بود؛ بررسی تنظیمات یا آماده‌سازی بازگردانی روی سرور انجام نشد.";
              reject(new ApiError(502, "V2BX_FILES_APPLY", message, {
                phase, rollback: restored ? "succeeded" : recovering ? "pending" : "not_started",
              }));
              return;
            }
            const messages: Record<string, string> = {
              privilege: "دسترسی root یا تأیید رمز sudo ناموفق بود.",
              prerequisites: "آماده‌سازی Python، گواهی‌ها یا پیش‌نیازهای Ubuntu ناموفق بود؛ وضعیت مخزن بسته‌ها را بررسی کنید.",
              upload: "انتقال یا بررسی صحت بسته Agent ناموفق بود.",
              installation: "نوشتن فایل‌ها یا بررسی تنظیمات Agent ناموفق بود.",
              enrollment: "ثبت اعتبارنامه Agent در پنل ناموفق بود؛ دسترسی HTTPS میزبان به پنل را بررسی کنید.",
              services: "راه‌اندازی سرویس Agent ناموفق بود؛ گزارش سرویس systemd را بررسی کنید.",
            };
            reject(new ApiError(502, "SSH_INSTALLER", messages[phase], { phase }));
          });
          input.once("error", () => { reject(new ApiError(502, "SSH_EXEC", "خواندن فایل بسته ناموفق بود.")); channel.destroy(); });
          if (!passwordless && login.method === "password") channel.write(login.password + "\n");
          input.pipe(channel);
        });
      });
    }, 540000);

  } finally {
    input.destroy();
  }
}
