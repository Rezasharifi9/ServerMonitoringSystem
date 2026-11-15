import { createHmac, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import { adminConfig } from "./admin-config";
import { adminSession, confirmAdminPassword, cookie, createAdminSession, digest, effectiveAdminHash } from "./auth";
import { database, transaction } from "./database";
import { ApiError, json, jsonBody, requireSecureCredentialOrigin } from "./http";

const challengeMs = 5 * 60 * 1000;
const maxPasskeys = 10;
const route = "session/passkeys";
type Flow = "register" | "login";
type Db = ReturnType<typeof database>;
type Admin = NonNullable<ReturnType<typeof adminConfig>>;

const credentialId = z.string().min(1).max(1400).regex(/^[\w-]+$/);
const webAuthnResponse = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal("public-key"),
  clientExtensionResults: z.object({}),
});
const registration = z.object({
  name: z.string().trim().min(1).max(64),
  response: webAuthnResponse.extend({ response: z.object({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
  }) }),
});
const authentication = webAuthnResponse.extend({ response: z.object({
  clientDataJSON: z.string().min(1),
  authenticatorData: z.string().min(1),
  signature: z.string().min(1),
  userHandle: z.string(),
}) });

function passkeys(db: Db, account: string) {
  return db.prepare("SELECT id, name, created_at AS createdAt FROM admin_passkeys WHERE account_digest = ? ORDER BY created_at DESC").all(account);
}

function requireAdminSession(request: Request, db?: Db) {
  if (!adminSession(request, db)) throw new ApiError(401, "UNAUTHENTICATED", "با حساب مدیر وارد پنل شوید.");
}

function invalidPasskey() {
  return new ApiError(401, "PASSKEY_INVALID", "تأیید کلید ورود ناموفق بود. دوباره تلاش کنید.");
}

function full() {
  return new ApiError(409, "PASSKEY_LIMIT", "حداکثر ۱۰ کلید ورود می‌توانید ثبت کنید.");
}

function challengeCookie(flow: Flow) {
  return `nodeguard_passkey_${flow}`;
}

function challengeSignature(request: Request, origin: URL, hash: string, flow: Flow, challenge: string, expires: number) {
  const session = flow === "register" ? cookie(request) : undefined;
  return createHmac("sha256", hash).update(JSON.stringify([flow, origin.origin, session, challenge, expires])).digest("hex");
}

function sendOptions<T extends { challenge: string }>(request: Request, origin: URL, hash: string, flow: Flow, data: T) {
  const expires = Date.now() + challengeMs;
  const signature = challengeSignature(request, origin, hash, flow, data.challenge, expires);
  const secure = origin.protocol === "https:" ? "; Secure" : "";
  return json({ data }, { headers: { "Set-Cookie":
    `${challengeCookie(flow)}=${data.challenge}.${expires}.${signature}; Path=/api/v1/${route}; HttpOnly; SameSite=Strict; Max-Age=${challengeMs / 1000}${secure}`,
  } });
}

function readChallenge(request: Request, origin: URL, hash: string, flow: Flow) {
  const token = cookie(request, challengeCookie(flow)) ?? "";
  const match = /^([\w-]{32,128})\.(\d{13})\.([\da-f]{64})$/.exec(token);
  if (!match) throw invalidPasskey();
  const [, value, expiry, signature] = match;
  const expires = Number(expiry);
  const expected = challengeSignature(request, origin, hash, flow, value, expires);
  if (expires <= Date.now() || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    throw invalidPasskey();
  }
  return { value, expires };
}

// Consume the challenge and update credentials in the same transaction as the successful ceremony.
function consumeChallenge(db: Db, admin: Admin, hash: string, { value, expires }: ReturnType<typeof readChallenge>) {
  const now = Date.now();
  if (expires <= now || effectiveAdminHash(db, admin) !== hash) throw invalidPasskey();
  db.prepare("DELETE FROM admin_passkey_challenges_used WHERE expires_at <= ?").run(now);
  if (!db.prepare("INSERT OR IGNORE INTO admin_passkey_challenges_used VALUES (?, ?)").run(value, expires).changes) {
    throw invalidPasskey();
  }
}

export async function handleAdminPasskeys(request: Request, endpoint: string) {
  const admin = adminConfig();
  if (!admin) throw new ApiError(404, "NOT_FOUND", "مسیر API پیدا نشد.");
  requireSecureCredentialOrigin(request);
  const origin = new URL(process.env.NODEGUARD_ORIGIN ?? request.url);
  if (request.method !== "GET" && request.headers.get("origin") !== origin.origin) {
    throw new ApiError(403, "ORIGIN", "مبدأ درخواست مجاز نیست.");
  }

  const db = database();
  const hash = effectiveAdminHash(db, admin);
  const account = digest(JSON.stringify([admin.username, hash]));
  const userId = Buffer.from(digest(`nodeguard-admin:${admin.username}`), "hex");
  const rpID = origin.hostname;
  const verification = { expectedOrigin: origin.origin, expectedRPID: rpID, requireUserVerification: true };

  if (endpoint === route && request.method === "GET") {
    requireAdminSession(request);
    return json({ data: passkeys(db, account) });
  }
  if (endpoint === route && request.method === "DELETE") {
    requireAdminSession(request);
    const input = credentialId.safeParse(await jsonBody(request, 2048));
    if (!input.success) throw new ApiError(422, "PASSKEY_INPUT", "کلید ورود نامعتبر است.");
    return transaction((db) => {
      requireAdminSession(request, db);
      db.prepare("DELETE FROM admin_passkeys WHERE id = ? AND account_digest = ?").run(input.data, account);
      return json({ data: null });
    });
  }
  if (endpoint === route + "/register/options" && request.method === "POST") {
    requireAdminSession(request);
    const input = z.object({ password: z.string().min(1).max(256) }).strict().safeParse(await jsonBody(request, 2048));
    if (!input.success) throw new ApiError(422, "PASSKEY_INPUT", "رمز فعلی مدیر را وارد کنید.");
    const confirmedHash = confirmAdminPassword(request, admin, input.data.password);
    const existing = passkeys(db, digest(JSON.stringify([admin.username, confirmedHash])));
    if (existing.length >= maxPasskeys) throw full();
    const options = await generateRegistrationOptions({
      rpName: "NodeGuard", rpID, userName: admin.username, userID: userId, timeout: challengeMs,
      attestationType: "none",
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
      excludeCredentials: existing.map((row) => ({ id: String(row.id) })),
    });
    return sendOptions(request, origin, confirmedHash, "register", options);
  }
  if (endpoint === route + "/register/verify" && request.method === "POST") {
    requireAdminSession(request);
    const input = registration.safeParse(await jsonBody(request, 32 * 1024));
    if (!input.success) throw invalidPasskey();
    const challenge = readChallenge(request, origin, hash, "register");
    const result = await verifyRegistrationResponse({
      ...verification, response: input.data.response, expectedChallenge: challenge.value,
    }).catch(() => { throw invalidPasskey(); });
    if (!result.verified) throw invalidPasskey();
    const { id, publicKey, counter } = result.registrationInfo.credential;
    return transaction((db) => {
      requireAdminSession(request, db);
      consumeChallenge(db, admin, hash, challenge);
      if (passkeys(db, account).length >= maxPasskeys) throw full();
      if (!db.prepare("INSERT OR IGNORE INTO admin_passkeys VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, account, input.data.name, publicKey, counter, Date.now()).changes) {
        throw new ApiError(409, "PASSKEY_EXISTS", "این کلید ورود قبلاً ثبت شده است.");
      }
      return json({ data: passkeys(db, account) });
    });
  }
  if (endpoint === route + "/login/options" && request.method === "POST") {
    if (!passkeys(db, account).length) {
      throw new ApiError(404, "NO_PASSKEY", "هنوز کلید ورودی ثبت نشده است. با رمز وارد شوید و از بخش امنیت یک کلید ثبت کنید.");
    }
    const options = await generateAuthenticationOptions({ rpID, timeout: challengeMs, userVerification: "required" });
    return sendOptions(request, origin, hash, "login", options);
  }
  if (endpoint === route + "/login/verify" && request.method === "POST") {
    const input = authentication.safeParse(await jsonBody(request, 16 * 1024));
    if (!input.success || input.data.response.userHandle !== userId.toString("base64url")) throw invalidPasskey();
    const challenge = readChallenge(request, origin, hash, "login");
    const row = db.prepare("SELECT public_key, counter FROM admin_passkeys WHERE id = ? AND account_digest = ?").get(input.data.id, account);
    const publicKey = row?.public_key;
    if (!row || !(publicKey instanceof Uint8Array)) throw invalidPasskey();
    const counter = Number(row.counter);
    const result = await verifyAuthenticationResponse({
      ...verification, expectedTopOrigin: origin.origin, response: input.data, expectedChallenge: challenge.value,
      credential: { id: input.data.id, publicKey: Uint8Array.from(publicKey), counter },
    }).catch(() => { throw invalidPasskey(); });
    if (!result.verified) throw invalidPasskey();
    return transaction((db) => {
      consumeChallenge(db, admin, hash, challenge);
      const updated = db.prepare("UPDATE admin_passkeys SET counter = ? WHERE id = ? AND account_digest = ? AND counter = ? AND public_key = ?")
        .run(result.authenticationInfo.newCounter, input.data.id, account, counter, publicKey);
      if (!updated.changes) throw invalidPasskey();
      return createAdminSession(db, request, hash);
    });
  }
  throw new ApiError(404, "NOT_FOUND", "مسیر API پیدا نشد.");
}
