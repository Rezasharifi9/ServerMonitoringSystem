import { z } from "zod";
import type { DemoUser, ProvisionProfile } from "@/types";
import { digest } from "./auth";
import { transaction, readWorkspace } from "./database";
import { getForwarderSettings } from "./forwarder-settings";
import { ApiError } from "./http";
import { checkProvisionHost, provisionBusy, provisionEnabled, insertProvisionJob, auditProvision } from "./provision";
import { tunnelBindings } from "./provision-catalog";

export function controlForwarder(actor: DemoUser, tunnelId: string, input: unknown, key: string) {
  getForwarderSettings(actor, tunnelId); // common permission and target checks
  const parsed = z.object({ action: z.enum(["start", "stop", "restart"]), side: z.enum(["iran", "foreign", "both"]) }).strict().safeParse(input);
  if (!parsed.success || !/^[\w-]{12,128}$/.test(key)) throw new ApiError(422, "SERVICE_CONTROL_INPUT", "عملیات و سمت سرویس معتبر نیست.");
  if (!provisionEnabled()) throw new ApiError(503, "PROVISION_DISABLED", "Agent Provision فعال نیست.");
  return transaction(db => {
    const binding = tunnelBindings(db).find(b => b.tunnelId === tunnelId);
    if (!binding) throw new ApiError(409, "SERVICE_NOT_INSTALLED", "ابتدا تونل را مستقر کنید.");
    const fingerprint = digest(JSON.stringify([tunnelId, parsed.data]));
    const jobs = [];
    for (const side of parsed.data.side === "both" ? ["iran", "foreign"] as const : [parsed.data.side]) {
      const requestKey = key + ":" + side;
      const existing = db.prepare("SELECT id,fingerprint FROM provision_jobs WHERE actor_id=? AND request_key=?").get(actor.id, requestKey);
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "شناسهٔ درخواست تکراری است."); jobs.push(String(existing.id)); continue; }
      const profileId = side === "iran" ? binding.iranProfileId : binding.foreignProfileId;
      const original = db.prepare(`SELECT j.* FROM provision_jobs j WHERE json_extract(profile,'$.id')=? AND status='succeeded' AND rollback_of IS NULL
        AND NOT EXISTS (SELECT 1 FROM provision_jobs r WHERE r.rollback_of=j.id AND r.status='succeeded' AND coalesce(r.operation,'rollback') NOT IN ('start-service','stop-service','restart-service')) ORDER BY created_at DESC LIMIT 1`).get(profileId);
      if (!original) throw new ApiError(409, "SERVICE_NOT_INSTALLED", "نصب فعال این سمت پیدا نشد.");
      const profile = JSON.parse(String(original.profile)) as ProvisionProfile;
      checkProvisionHost(db, profile.serverId);
      const host = readWorkspace(db).state.servers.find(s => s.id === profile.serverId);
      const parts = host?.agent.version.split(".").map(Number) ?? [];
      if (!(parts[0] > 0 || parts[0] === 0 && parts[1] >= 5)) throw new ApiError(409, "PROVISION_AGENT_UPGRADE", "Agent میزبان را به نسخهٔ 0.5.0 یا جدیدتر ارتقا دهید.");
      if (provisionBusy(db, profile.serverId)) throw new ApiError(409, "PROVISION_HOST_BUSY", "عملیات دیگری روی میزبان فعال است.");
      jobs.push(insertProvisionJob(db, actor.id, requestKey, fingerprint, profile, String(original.id), Date.now(), `${parsed.data.action}-service`));
    }
    auditProvision(db, actor, "tunnel." + parsed.data.action, [tunnelId]);
    return { jobs };
  });
}
