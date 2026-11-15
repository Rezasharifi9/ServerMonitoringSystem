import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ApiError } from "./http";

const credentials = z.object({ endpoint: z.string(), authorization: z.string() }).strict();
export type PanelCredentials = z.infer<typeof credentials>;

function encryptionKey() {
  const source = process.env.NODEGUARD_CREDENTIAL_KEY;
  return source && /^[a-f0-9]{64}$/i.test(source) ? Buffer.from(source, "hex") : undefined;
}

export const canStorePanelCredentials = () => Boolean(encryptionKey());
const associatedData = (scope: string) => Buffer.from(scope === "v2board" ? "nodeguard:v2board-admin:v1" : "nodeguard:" + scope + ":v1");

export function readSealedCredential(db: DatabaseSync, scope: string): unknown {
  const stored = db.prepare("SELECT sealed FROM provider_credentials WHERE provider=?").get(scope);
  if (!stored) return undefined;
  try {
    const key = encryptionKey();
    if (!key) throw new Error("Missing credential key");
    const [iv, tag, encrypted] = String(stored.sealed).split(".").map((value) => Buffer.from(value, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(associatedData(scope));
    decipher.setAuthTag(tag);
    const data = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    throw new ApiError(503, "SEALED_CREDENTIAL", "اعتبارنامهٔ ذخیره‌شده قابل خواندن نیست. کلید رمزنگاری کنترل‌پلین را بررسی کنید.");
  }
}

export function writeSealedCredential(db: DatabaseSync, scope: string, value: unknown) {
  const key = encryptionKey();
  if (!key) throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید رمزنگاری اعتبارنامه در کنترل‌پلین تنظیم نشده است.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(scope));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const sealed = [iv, cipher.getAuthTag(), encrypted].map((item) => item.toString("base64url")).join(".");
  db.prepare(`INSERT INTO provider_credentials (provider,sealed) VALUES (?,?)
    ON CONFLICT(provider) DO UPDATE SET sealed=excluded.sealed`).run(scope, sealed);
}

export function getPanelCredentials(db: DatabaseSync) {
  const stored = readSealedCredential(db, "v2board");
  if (stored !== undefined) return { ...credentials.parse(stored), managed: true };
  const endpoint = process.env.NODEGUARD_V2BOARD_ENDPOINT;
  const authorization = process.env.NODEGUARD_V2BOARD_AUTH;
  return endpoint && authorization ? { endpoint, authorization, managed: false } : undefined;
}

export function savePanelCredentials(db: DatabaseSync, value: PanelCredentials) {
  writeSealedCredential(db, "v2board", value);
}
