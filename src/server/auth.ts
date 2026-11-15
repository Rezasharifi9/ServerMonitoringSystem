import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DEMO_USERS } from "@/data/seed";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { adminAccount, adminConfig, adminHashPattern } from "./admin-config";
import { ApiError, json, jsonBody, requireSecureCredentialOrigin } from "./http";

const SESSION_COOKIE = "nodeguard_session";
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 8;
const adminLoginSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) }).strict();
const changePasswordSchema = z.object({
  currentPassword: adminLoginSchema.shape.password,
  newPassword: z.string().max(256).refine((value) => [...value].length >= 15),
}).strict();
type Db = ReturnType<typeof database>;
type Admin = NonNullable<ReturnType<typeof adminConfig>>;
const adminWorkers = {
  "/api/v1/failover/worker/tick": "NODEGUARD_FAILOVER_WORKER_TOKEN",
  "/api/v1/notifications/telegram/tick": "NODEGUARD_TELEGRAM_WORKER_TOKEN",
} as const;
const credentialsSchema = z.record(z.string(), z.string().min(32).max(256));
const agentCredentialsSchema = z.record(z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i), z.string().min(32).max(256));
const loginSchema = z.object({ userId: z.string().max(64), token: z.string().min(32).max(256) }).strict();

function credentials() {
  if (adminConfig()) return {};
  const source = process.env.NODEGUARD_USER_TOKENS;
  if (!source) return {};
  const tokens = credentialsSchema.parse(JSON.parse(source));
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length ||
      Object.keys(tokens).some((id) => !DEMO_USERS.some((user) => user.id === id))) {
    throw new Error("Invalid NODEGUARD_USER_TOKENS configuration");
  }
  return tokens;
}

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function matchesDigest(candidate: string, expected: unknown) {
  return typeof expected === "string" && /^[\da-f]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(digest(candidate), "hex"), Buffer.from(expected, "hex"));
}

function match(candidate: string, expected?: string) {
  const actual = Buffer.from(digest(candidate), "hex");
  const reference = Buffer.from(digest(expected ?? ""), "hex");
  return timingSafeEqual(actual, reference) && Boolean(expected);
}

export function cookie(request: Request, name = SESSION_COOKIE) {
  return request.headers.get("cookie")?.split(";").map((pair) => pair.trim()).find((pair) => pair.startsWith(name + "="))?.slice(name.length + 1);
}

function secureCookie(request: Request) {
  return new URL(request.url).protocol === "https:" || process.env.NODEGUARD_SECURE_COOKIE === "1" ? "; Secure" : "";
}

export function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = process.env.NODEGUARD_ORIGIN ?? new URL(request.url).origin;
  if (origin && origin !== allowed) throw new ApiError(403, "ORIGIN", "مبدأ درخواست مجاز نیست.");
}

const monitorWorkers = { DNS: "DNS", HEALTH: "Agent", V2BOARD: "V2Board" } as const;

export function authorizeMonitorWorker(request: Request, worker: keyof typeof monitorWorkers) {
  assertOrigin(request);
  const expected = process.env[`NODEGUARD_${worker}_WORKER_TOKEN`] ?? "";
  const supplied = /^Bearer ([a-f\d]{64})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const name = monitorWorkers[worker];
  if (!/^[a-f\d]{64}$/i.test(expected) || !supplied || !match(supplied, expected)) {
    throw new ApiError(401, worker + "_WORKER_AUTH", `اعتبارنامهٔ پایشگر ${name} معتبر نیست.`);
  }
  const otherTokens = Object.keys(monitorWorkers).filter((kind) => kind !== worker)
    .map((kind) => process.env[`NODEGUARD_${kind}_WORKER_TOKEN`]);
  const managed = database().prepare("SELECT 1 FROM agent_credentials WHERE credential_digest = ?").get(digest(expected));
  if (managed || [...Object.values(credentials()), ...Object.values(legacyAgents()), ...otherTokens].includes(expected)) {
    throw new ApiError(503, worker + "_WORKER_CONFIG", `توکن پایشگر ${name} باید مستقل باشد.`);
  }
}

function adminSource(config: Admin) {
  return digest(JSON.stringify([config.username, config.hash]));
}

export function effectiveAdminHash(db: Db, config: Admin) {
  const saved = db.prepare("SELECT password_hash FROM admin_password WHERE singleton=1 AND source_digest=?").get(adminSource(config));
  return saved ? String(saved.password_hash) : config.hash;
}

function validAdminSession(db: Db, session: string, hash: string) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sessions WHERE digest = ? AND expires_at > ? AND actor = ? AND credential_digest = ?",
  ).get(digest(session), Date.now(), adminAccount.id, digest(hash)));
}

export function adminSession(request: Request, connection?: Db) {
  const config = adminConfig();
  const session = cookie(request);
  if (!config || !session || !/^[\da-f]{64}$/.test(session)) return false;
  const db = connection ?? database();
  return validAdminSession(db, session, effectiveAdminHash(db, config));
}

function checkAdminLoginLimit(db: Db, now: number) {
  const guard = db.prepare("SELECT failures, expires_at FROM admin_login_guard WHERE singleton=1").get();
  if (guard && Number(guard.expires_at) > now && Number(guard.failures) >= LOGIN_ATTEMPTS) {
    throw new ApiError(429, "LOGIN_LIMIT", "تعداد تلاش‌ها بیش از حد مجاز است. تا ۱۵ دقیقه دیگر دوباره تلاش کنید.");
  }
}

function recordPasswordFailure(db: Db, now: number) {
  db.prepare(`
    INSERT INTO admin_login_guard VALUES (1, 1, ?)
    ON CONFLICT(singleton) DO UPDATE SET failures = CASE WHEN expires_at > ? THEN failures + 1 ELSE 1 END,
      expires_at = CASE WHEN expires_at > ? THEN expires_at ELSE excluded.expires_at END
  `).run(now + LOGIN_WINDOW_MS, now, now);
}

function matchesAdminPassword(password: string, hash: string) {
  const parts = adminHashPattern.exec(hash);
  if (!parts) throw new Error("Invalid stored NodeGuard admin password hash");
  const [, salt, expected] = parts;
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, "hex"), 32), Buffer.from(expected, "hex"));
}

export function authenticate(request: Request) {
  if (adminConfig()) {
    if (adminSession(request)) return adminAccount;
    const path = new URL(request.url).pathname;
    const key = Object.hasOwn(adminWorkers, path) ? adminWorkers[path as keyof typeof adminWorkers] : undefined;
    const supplied = /^Bearer ([a-f\d]{64})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const expected = key && process.env[key];
    if (request.method === "POST" && supplied && expected && match(supplied, expected)) return adminAccount;
    throw new ApiError(401, "UNAUTHENTICATED", "برای دسترسی وارد شوید.");
  }
  const tokens = credentials();
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer && bearer.length <= 256) {
    const actor = DEMO_USERS.find((user) => match(bearer, tokens[user.id]));
    if (actor) return actor;
  }
  const session = cookie(request);
  if (session && /^[\da-f]{64}$/.test(session)) {
    const row = database().prepare("SELECT actor, credential_digest FROM sessions WHERE digest = ? AND expires_at > ?")
      .get(digest(session), Date.now());
    const actor = DEMO_USERS.find((user) => user.id === row?.actor);
    if (actor && tokens[actor.id] && row?.credential_digest === digest(tokens[actor.id])) return actor;
  }
  throw new ApiError(401, "UNAUTHENTICATED", "برای دسترسی به بک‌اند وارد شوید.");
}

export async function login(request: Request) {
  assertOrigin(request);
  const body = await jsonBody(request, 2048);
  const admin = adminConfig();
  if (admin) {
    const input = adminLoginSchema.safeParse(body);
    if (!input.success) throw new ApiError(400, "INVALID_LOGIN", "نام کاربری و رمز عبور را وارد کنید.");
    const response = transaction((db) => {
      const now = Date.now();
      checkAdminLoginLimit(db, now);
      const hash = effectiveAdminHash(db, admin);
      if (!matchesAdminPassword(input.data.password, hash) || !match(input.data.username, admin.username)) {
        recordPasswordFailure(db, now);
        return null;
      }
      db.prepare("DELETE FROM admin_login_guard WHERE singleton=1").run();
      return createAdminSession(db, request, hash);
    });
    if (!response) throw new ApiError(401, "UNAUTHENTICATED", "نام کاربری یا رمز عبور نامعتبر است.");
    return response;
  }
  const input = loginSchema.safeParse(body);
  if (!input.success) throw new ApiError(400, "INVALID_LOGIN", "شناسهٔ کاربر و توکن معتبر وارد کنید.");
  const tokens = credentials();
  const actor = DEMO_USERS.find((user) => user.id === input.data.userId);
  if (!actor || !match(input.data.token, tokens[actor.id])) {
    throw new ApiError(401, "UNAUTHENTICATED", "شناسهٔ کاربر یا توکن نامعتبر است.");
  }
  return createSession(database(), request, actor, input.data.token, "/api/v1");
}

export async function changeAdminPassword(request: Request) {
  assertOrigin(request);
  requireSecureCredentialOrigin(request);
  const config = adminConfig();
  const session = cookie(request);
  if (!config || !session || !/^[\da-f]{64}$/.test(session)) {
    throw new ApiError(401, "UNAUTHENTICATED", "با حساب مدیر وارد پنل شوید.");
  }
  const input = changePasswordSchema.safeParse(await jsonBody(request, 4096));
  if (!input.success) throw new ApiError(422, "PASSWORD_INPUT", "رمز جدید باید دست‌کم ۱۵ کاراکتر داشته باشد.");
  const { currentPassword, newPassword } = input.data;
  const response = transaction((db) => {
    if (!checkCurrentAdminPassword(db, request, config, currentPassword)) return null;
    const now = Date.now();
    if (newPassword === currentPassword) throw new ApiError(422, "PASSWORD_UNCHANGED", "رمز جدید باید با رمز فعلی فرق داشته باشد.");

    const salt = randomBytes(16);
    const nextHash = `scrypt:${salt.toString("hex")}:${scryptSync(newPassword, salt, 32).toString("hex")}`;
    db.prepare(`INSERT INTO admin_password VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET source_digest=excluded.source_digest, password_hash=excluded.password_hash`)
      .run(adminSource(config), nextHash);
    db.prepare("DELETE FROM sessions WHERE actor=?").run(adminAccount.id);
    db.prepare("DELETE FROM admin_passkeys").run();
    db.prepare("DELETE FROM admin_login_guard WHERE singleton=1").run();
    const { state, revision } = readWorkspace(db);
    state.audit = [{ id: randomBytes(16).toString("hex"), at: new Date(now).toISOString(), actor: adminAccount.name,
      role: adminAccount.role, action: "admin.password.change", target: adminAccount.id,
      detail: "رمز عبور حساب مدیر تغییر کرد.", simulated: false }, ...state.audit].slice(0, 2000);
    writeWorkspace(db, state, revision + 1);
    return createAdminSession(db, request, nextHash);
  });
  if (!response) throw new ApiError(403, "PASSWORD_INCORRECT", "رمز فعلی درست نیست.");
  return response;
}

function checkCurrentAdminPassword(db: Db, request: Request, config: Admin, password: string) {
  const session = cookie(request);
  const hash = effectiveAdminHash(db, config);
  if (!session || !/^[\da-f]{64}$/.test(session) || !validAdminSession(db, session, hash)) {
    throw new ApiError(401, "UNAUTHENTICATED", "نشست مدیریت منقضی شده است.");
  }
  const now = Date.now();
  checkAdminLoginLimit(db, now);
  if (matchesAdminPassword(password, hash)) return hash;
  recordPasswordFailure(db, now);
  return null;
}

export function confirmAdminPassword(request: Request, config: Admin, password: string) {
  const hash = transaction((db) => checkCurrentAdminPassword(db, request, config, password));
  if (!hash) throw new ApiError(403, "PASSWORD_INCORRECT", "رمز فعلی درست نیست.");
  return hash;
}

export function createAdminSession(db: Db, request: Request, hash: string) {
  return createSession(db, request, adminAccount, hash, "/");
}

function createSession(db: Db, request: Request, actor: typeof adminAccount, credential: string, path: string) {
  const session = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR digest = ?").run(Date.now(), digest(cookie(request) ?? ""));
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(digest(session), actor.id, digest(credential), Date.now() + SESSION_SECONDS * 1000);
  return json({ data: actor }, { headers: {
    "Set-Cookie": `${SESSION_COOKIE}=${session}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secureCookie(request)}`,
  } });
}

export function logout(request: Request) {
  assertOrigin(request);
  const session = cookie(request);
  if (session) database().prepare("DELETE FROM sessions WHERE digest = ?").run(digest(session));
  return json({ data: null }, { headers: {
    "Set-Cookie": `${SESSION_COOKIE}=; Path=${adminConfig() ? "/" : "/api/v1"}; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie(request)}`,
  } });
}

function legacyAgents() {
  const configured = agentCredentialsSchema.parse(JSON.parse(process.env.NODEGUARD_AGENT_TOKENS ?? "{}"));
  const tokens = Object.values(configured);
  const users = Object.values(credentials());
  if (new Set(tokens).size !== tokens.length || tokens.some((token) => users.includes(token))) {
    throw new Error("Agent credentials must be unique");
  }
  return configured;
}

export function legacyAgentToken(serverId: string) {
  const configured = legacyAgents();
  return Object.hasOwn(configured, serverId) ? configured[serverId] : undefined;
}

export function agentTokenReserved(token: string) {
  return [
    ...Object.values(legacyAgents()), ...Object.values(credentials()),
    ...Object.values(adminWorkers).map((key) => process.env[key]),
    ...Object.keys(monitorWorkers).map((kind) => process.env[`NODEGUARD_${kind}_WORKER_TOKEN`]),
  ].includes(token);
}

export function authorizeAgent(request: Request, serverId: string, db: ReturnType<typeof database>) {
  const supplied = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (supplied && supplied.length <= 256) {
    const managed = db.prepare("SELECT credential_digest FROM agent_credentials WHERE server_id = ?").get(serverId);
    if (managed ? matchesDigest(supplied, managed.credential_digest) : match(supplied, legacyAgentToken(serverId))) return;
  }
  throw new ApiError(401, "AGENT_AUTH", "اعتبارنامهٔ عامل برای این سرور معتبر نیست.");
}

