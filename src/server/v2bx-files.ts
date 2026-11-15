import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { can } from "@/lib/rbac";
import { v2bxFilesSchema } from "@/lib/v2bx-files";
import type { DemoUser } from "@/types";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { ApiError } from "./http";
import { readSealedCredential, writeSealedCredential, canStorePanelCredentials } from "./provider-secrets";
import { runServerInstaller } from "./ssh-connection";
import { withHosts } from "./ssh-provision";
import { workspaceMode } from "./inventory";
import { pushAudit } from "./activity-log";
import { provisionBusy } from "./provision";

const scope = (id: string) => `v2bx-files:${id}`;
function allow(actor: DemoUser, id: string) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "server.configure") || !can(actor.role, "deploy.run"))
    throw new ApiError(403, "FORBIDDEN", "دسترسی نصب و پیکربندی سرور لازم است.");
  if (!readWorkspace().state.servers.some(s => s.id === id && s.roles.includes("foreign")))
    throw new ApiError(404, "V2BX_HOST", "سرور خارج پیدا نشد.");
}
export function readV2bxFiles(id: string) {
  return v2bxFilesSchema.parse(readSealedCredential(database(), scope(id)) ?? { route: null, outbound: null });
}
export function getV2bxFiles(actor: DemoUser, id: string) { allow(actor, id); return readV2bxFiles(id); }
export async function saveV2bxFiles(actor: DemoUser, id: string, value: unknown, restartStopped = false) {
  allow(actor, id);
  const parsed = v2bxFilesSchema.extend({ apply: z.boolean() }).strict().safeParse(value);
  if (!parsed.success) throw new ApiError(422, "V2BX_FILES", parsed.error.issues[0]?.message ?? "JSON معتبر نیست.");
  if (!canStorePanelCredentials()) throw new ApiError(503, "CREDENTIAL_STORAGE_DISABLED", "کلید رمزنگاری کنترل‌پلین تنظیم نشده است.");
  const { apply, ...files } = parsed.data;
  return withHosts([id], async () => {
    if (provisionBusy(database(), id)) throw new ApiError(409, "SERVER_OPERATION_BUSY", "ابتدا منتظر پایان عملیات جاری سرور بمانید.");
    if (apply) {
      const program = await readFile(join(process.cwd(), "agent", "v2bx_files.py"), "utf8");
      await runServerInstaller(actor, id, program, Readable.from([JSON.stringify({ ...files, restartStopped })]), "v2bx-files");
    }
    transaction(db => {
      writeSealedCredential(db, scope(id), files);
      const workspace = readWorkspace(db);
      pushAudit(workspace.state, actor, "server.v2bx-files", id, apply ? "فایل‌های Route و Outbound در V2bX اعمال شدند." : "فایل‌های Route و Outbound برای نصب ذخیره شدند.");
      writeWorkspace(db, workspace.state, workspace.revision + 1);
    });
    return files;
  }, "v2bx-files");
}

function allowGlobal(actor: DemoUser) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "settings.edit") || !can(actor.role, "server.configure") ||
      !can(actor.role, "deploy.run") || !can(actor.role, "server.restart"))
    throw new ApiError(403, "FORBIDDEN", "دسترسی تنظیمات، نصب و راه‌اندازی مجدد سرور لازم است.");
}
export function getGlobalV2bxFiles(actor: DemoUser) {
  allowGlobal(actor);
  return v2bxFilesSchema.parse(readSealedCredential(database(), "v2bx-global-files") ?? { route: null, outbound: null });
}
export function saveGlobalV2bxFiles(actor: DemoUser, value: unknown) {
  allowGlobal(actor);
  const parsed = v2bxFilesSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "V2BX_FILES", parsed.error.issues[0]?.message ?? "JSON معتبر نیست.");
  transaction(db => {
    writeSealedCredential(db, "v2bx-global-files", parsed.data);
    const workspace = readWorkspace(db);
    pushAudit(workspace.state, actor, "settings.v2bx-files", "settings", "فایل‌های مشترک Route و Outbound ذخیره شدند.");
    writeWorkspace(db, workspace.state, workspace.revision + 1);
  });
  return parsed.data;
}
export async function applyGlobalV2bxFiles(actor: DemoUser, value: unknown) {
  allowGlobal(actor);
  const parsed = v2bxFilesSchema.extend({ serverId: z.string().min(1).max(96) }).strict().safeParse(value);
  if (!parsed.success) throw new ApiError(422, "V2BX_FILES", "مشخصات فایل‌ها یا سرور معتبر نیست.");
  const { serverId, ...files } = parsed.data;
  return saveV2bxFiles(actor, serverId, { ...files, apply: true }, true);
}
