import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { z } from "zod";
import { can } from "@/lib/rbac";
import type { DemoUser, ProvisionProfile } from "@/types";
import { authorizeAgent, digest } from "./auth";
import { database } from "./database";
import { ApiError } from "./http";
import { profiles } from "./provision-catalog";
import { builtInBbrManifest } from "./provision-bbr";
import { workspaceMode } from "./inventory";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const filename = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const limit = 96 * 1024 * 1024;
const artifactChunkBytes = 128 * 1024;
const compress = promisify(gzip);
const fileDigest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function directory(sha256: string) {
  return resolve(dirname(process.env.NODEGUARD_DB_PATH || ".nodeguard/monitor.sqlite"), "provision-artifacts", checksum.parse(sha256));
}

export function hasProvisionDownload(profile: ProvisionProfile) {
  return Boolean(builtInBbrManifest(profile)) || existsSync(join(directory(profile.sha256), "manifest.json"));
}

export async function storeProvisionDownload(profile: ProvisionProfile, source: string) {
  const target = directory(profile.sha256);
  if (hasProvisionDownload(profile)) return;
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(parent, ".bundle-"));
  try {
    const names = await readdir(source);
    let size = 0;
    for (const name of names) {
      filename.parse(name);
      const file = join(source, name);
      size += (await stat(file)).size;
      if (size > limit + 16384) throw new Error("Provision bundle exceeds size limit");
      const data = await readFile(file);
      if (name === "manifest.json" && fileDigest(data) !== profile.sha256) throw new Error("Generated manifest digest mismatch");
      await writeFile(join(temporary, name), data, { mode: 0o600, flag: "wx" });
    }
    if (!names.includes("manifest.json")) throw new Error("Missing provision manifest");
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!hasProvisionDownload(profile)) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function uploadProvisionArtifacts(actor: DemoUser, request: Request, serverId: string, profileId: string) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "deploy.run") || !can(actor.role, "server.configure") || !can(actor.role, "tunnel.mutate")) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی ثبت بسته لازم است.");
  }
  const profile = profiles(database()).find((item) => item.serverId === serverId && item.id === profileId);
  if (!profile) throw new ApiError(404, "PROVISION_PROFILE", "ابتدا فرادادهٔ این بسته را ثبت کنید.");
  const type = request.headers.get("content-type") ?? "";
  if (!request.body || !type.startsWith("multipart/form-data;")) throw new ApiError(415, "CONTENT_TYPE", "فایل‌های بسته را انتخاب کنید.");
  let bytes = 0;
  let form: FormData;
  try {
    form = await new Response(request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > limit + 65536) throw new ApiError(413, "BODY_TOO_LARGE", "اندازهٔ بسته بیش از حد مجاز است.");
        controller.enqueue(chunk);
      },
    })), { headers: { "Content-Type": type } }).formData();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "PROVISION_ARTIFACT", "فایل‌های بسته قابل خواندن نیستند.");
  }
  const files = form.getAll("files");
  const invalid = () => new ApiError(422, "PROVISION_ARTIFACT", "نام و هش تمام فایل‌ها باید با manifest.json بسته منطبق باشد.");
  if (!files.length || files.length > 13 || files.some((file) => typeof file === "string" || !filename.safeParse(file.name).success)) throw invalid();
  const map = new Map((files as File[]).map((file) => [file.name, file]));
  const manifestFile = map.get("manifest.json");
  if (!manifestFile || manifestFile.size > 16384 || map.size !== files.length) throw invalid();
  const raw = Buffer.from(await manifestFile.arrayBuffer());
  if (fileDigest(raw) !== profile.sha256) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw invalid(); }
  const verified = z.object({ id: z.literal(profile.id), version: z.literal(profile.version), component: z.literal(profile.component),
    files: z.array(z.object({ source: filename, sha256: checksum })).max(12).optional(),
  }).safeParse(parsed);
  if (!verified.success) throw invalid();
  const manifest = verified.data;
  const expected = new Map((manifest.files ?? []).map((file) => [file.source, file.sha256]));
  if (expected.has("manifest.json") || expected.size !== (manifest.files?.length ?? 0) || map.size !== expected.size + 1) throw invalid();
  const source = await mkdtemp(join(tmpdir(), "nodeguard-upload-"));
  try {
    await writeFile(join(source, "manifest.json"), raw, { mode: 0o600 });
    for (const [name, hash] of expected) {
      const file = map.get(name);
      if (!file) throw invalid();
      const data = Buffer.from(await file.arrayBuffer());
      if (fileDigest(data) !== hash) throw invalid();
      await writeFile(join(source, name), data, { mode: 0o600, flag: "wx" });
    }
    if (!profiles(database()).some((item) => item.serverId === serverId && item.id === profileId && item.sha256 === profile.sha256)) {
      throw new ApiError(409, "PROVISION_PROFILE_CHANGED", "فرادادهٔ بسته هم‌زمان تغییر کرده است.");
    }
    await storeProvisionDownload(profile, source);
    return { uploaded: true };
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

export async function downloadProvisionArtifact(request: Request, jobId: string, input: unknown) {
  const parsed = z.object({ serverId: z.string().max(96), lease: checksum, name: filename,
    offset: z.number().int().min(0).max(limit).optional(),
  }).strict().safeParse(input);
  if (!parsed.success || !z.string().uuid().safeParse(jobId).success) {
    throw new ApiError(422, "PROVISION_ARTIFACT", "درخواست بسته معتبر نیست.");
  }
  const { serverId, lease, name, offset } = parsed.data;
  const db = database();
  authorizeAgent(request, serverId, db);
  const row = db.prepare(`SELECT profile FROM provision_jobs WHERE id=? AND server_id=? AND lease_digest=?
    AND status='running' AND lease_until>? AND ((rollback_of IS NULL AND operation IS NULL)
      OR (operation='restart-v2bx' AND rollback_of IS NOT NULL AND json_extract(profile,'$.component')='V2bX'))`)
    .get(jobId, serverId, digest(lease), Date.now());
  if (!row) throw new ApiError(403, "PROVISION_LEASE", "مجوز دریافت بسته معتبر نیست.");
  const profile = JSON.parse(String(row.profile)) as ProvisionProfile;
  const builtIn = builtInBbrManifest(profile);
  if (builtIn) {
    if (name !== "manifest.json") throw new ApiError(404, "PROVISION_ARTIFACT", "فایل بسته پیدا نشد.");
    if (offset !== undefined && offset !== 0) throw new ApiError(416, "PROVISION_ARTIFACT_RANGE", "موقعیت دریافت بسته خارج از محدوده است.");
    return new Response(builtIn, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  }
  const file = join(directory(profile.sha256), name);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new ApiError(404, "PROVISION_ARTIFACT", "فایل بسته پیدا نشد.");
  if (offset !== undefined && offset >= info.size && (offset !== 0 || info.size !== 0)) {
    throw new ApiError(416, "PROVISION_ARTIFACT_RANGE", "موقعیت دریافت بسته خارج از محدوده است.");
  }
  const partial = offset !== undefined && info.size > 0;
  const end = Math.min((offset ?? 0) + artifactChunkBytes, info.size) - 1;
  const headers = new Headers({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store",
    "Content-Length": String(partial ? end - offset + 1 : info.size),
  });
  if (partial) headers.set("Content-Range", `bytes ${offset}-${end}/${info.size}`);
  if (partial && info.size > artifactChunkBytes && request.headers.get("X-NodeGuard-Artifact-Gzip") === "1") {
    const source = await open(file, "r");
    try {
      const payload = Buffer.alloc(end - offset + 1);
      const { bytesRead } = await source.read(payload, 0, payload.length, offset);
      if (bytesRead !== payload.length) throw new ApiError(503, "PROVISION_ARTIFACT", "خواندن بخش بسته کامل نشد.");
      const packed = await compress(payload);
      headers.set("X-NodeGuard-Artifact-Encoding", "gzip");
      headers.set("Content-Length", String(packed.length));
      return new Response(Uint8Array.from(packed), { status: 206, headers });
    } finally {
      await source.close();
    }
  }
  const stream = createReadStream(file, partial ? { start: offset, end } : undefined);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: partial ? 206 : 200, headers });
}
