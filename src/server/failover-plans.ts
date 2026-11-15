import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { can } from "@/lib/rbac";
import type { DemoUser, OperationalFailoverPlan } from "@/types";
import { digest } from "./auth";
import { readWorkspace, transaction, writeWorkspace } from "./database";
import { executionFor } from "./failover-execution";
import { checkFailover } from "./failover-preflight";
import { automaticFailoverEnabled } from "./cloudflare-failover";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";

const input = z.object({
  nodeId: z.string().regex(/^[a-z\d][a-z\d_.:-]{0,95}$/i),
  target: z.enum(["primary", "backup"]),
}).strict();

type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function view(row: Row, db: DatabaseSync): OperationalFailoverPlan {
  const preflight = JSON.parse(String(row.preflight)) as OperationalFailoverPlan["preflight"];
  return {
    id: String(row.id), nodeId: String(row.node_id), target: preflight.target, preflight,
    status: row.status as OperationalFailoverPlan["status"], requestedBy: String(row.actor_id),
    decidedBy: typeof row.decided_by === "string" ? row.decided_by : undefined,
    createdAt: new Date(Number(row.created_at)).toISOString(), expiresAt: new Date(Number(row.expires_at)).toISOString(),
    requireSecondActor: row.second_actor === 1, automatic: row.automatic === 1, execution: executionFor(String(row.id), db),
  };
}

function find(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM failover_plans WHERE id = ?").get(id);
  if (!row) throw new ApiError(404, "FAILOVER_PLAN_UNKNOWN", "طرح Failover پیدا نشد.");
  return row;
}

function expire(db: DatabaseSync) {
  db.prepare("UPDATE failover_plans SET status = 'expired' WHERE status IN ('awaiting_approval','approved') AND expires_at <= ? AND NOT EXISTS (SELECT 1 FROM failover_executions WHERE plan_id = failover_plans.id)").run(Date.now());
}

function audit(db: DatabaseSync, actor: DemoUser, action: string, id: string) {
  const { state, revision } = readWorkspace(db);
  state.audit = [{
    id: randomUUID(), at: new Date().toISOString(), actor: actor.name, role: actor.role, action,
    target: id, detail: "ثبت طرح عملیاتی Failover", simulated: false,
  }, ...state.audit].slice(0, 2000);
  writeWorkspace(db, state, revision + 1);
}

function allow(actor?: DemoUser) {
  if (workspaceMode() !== "monitor") throw new ApiError(409, "MONITOR_REQUIRED", "طرح عملیاتی در محیط پایش در دسترس است.");
  if (actor && !can(actor.role, "failover.run")) throw new ApiError(403, "FORBIDDEN", "اجازهٔ ایجاد یا بررسی طرح را ندارید.");
}

export function listFailoverPlans() {
  allow();
  return transaction((db) => {
    expire(db);
    return db.prepare("SELECT * FROM failover_plans ORDER BY created_at DESC, id DESC LIMIT 60").all().map((row) => view(row, db));
  });
}

export function prepareFailoverPlan(actor: DemoUser, value: unknown, key: string, automatic = false) {
  allow(actor);
  const spec = input.safeParse(value);
  if (!spec.success) throw new ApiError(422, "FAILOVER_PLAN_INPUT", "مشخصات طرح معتبر نیست.", spec.error.issues);
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  const fingerprint = digest(JSON.stringify(spec.data));
  return transaction((db) => {
    expire(db);
    const current = db.prepare("SELECT * FROM failover_plans WHERE actor_id = ? AND request_key = ?").get(actor.id, key);
    if (current) {
      if (current.request_fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "کلید درخواست قبلاً برای طرح دیگری ثبت شده است.");
      return { plan: view(current, db), replay: true };
    }
    const { nodeId, target } = spec.data;
    const preflight = checkFailover(nodeId, target, db);
    if (!preflight.result.ready || (automatic && (!automaticFailoverEnabled() || !preflight.result.automaticEligible))) throw new ApiError(409, "FAILOVER_PREFLIGHT", "پیش‌شرط‌های طرح برقرار نیست.", preflight.result.checks);
    const busy = db.prepare(`
      SELECT id FROM failover_plans WHERE node_id = ? AND status IN ('awaiting_approval','approved')
      AND NOT EXISTS (SELECT 1 FROM failover_executions WHERE plan_id = failover_plans.id AND status IN ('succeeded','rolled_back','aborted'))
    `).get(nodeId);
    if (busy) throw new ApiError(409, "FAILOVER_PLAN_BUSY", "برای این نود طرح فعالی وجود دارد.");
    const id = randomUUID();
    const now = Date.now();
    if (automatic && db.prepare(`
      SELECT 1 FROM failover_plans WHERE node_id=? AND automatic=1 AND status='rejected'
      AND json_extract(preflight,'$.target')=? AND COALESCE(decided_at,created_at)>?
    `).get(nodeId, target, now - preflight.automaticRetryMs)) {
      throw new ApiError(409, "FAILOVER_AUTO_REJECTED", "پس از رد طرح، فاصلهٔ تلاش خودکار هنوز سپری نشده است.");
    }
    const autoApprove = automatic && !preflight.requireSecondActor;
    db.prepare(`
      INSERT INTO failover_plans (id, node_id, actor_id, request_key, request_fingerprint, state_fingerprint,
        preflight, second_actor, automatic, status, created_at, expires_at, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, nodeId, actor.id, key, fingerprint, preflight.fingerprint,
      JSON.stringify(preflight.result), Number(preflight.requireSecondActor), Number(automatic),
      autoApprove ? "approved" : "awaiting_approval", now, now + 120000, autoApprove ? actor.id : null, autoApprove ? now : null);
    audit(db, actor, autoApprove ? "failover.plan.auto_approved" : "failover.plan.prepare", id);
    return { plan: view(find(db, id), db), replay: false };
  });
}

export function decideFailoverPlan(actor: DemoUser, id: string, value: unknown) {
  allow(actor);
  const decision = z.object({ decision: z.enum(["approve", "reject"]) }).strict().safeParse(value);
  if (!z.string().uuid().safeParse(id).success || !decision.success) {
    throw new ApiError(422, "FAILOVER_PLAN_INPUT", "تصمیم یا شناسهٔ طرح معتبر نیست.");
  }
  return transaction((db) => {
    expire(db);
    const row = find(db, id);
    const plan = view(row, db);
    if (plan.execution) throw new ApiError(409, "FAILOVER_RUN_STATE", "اجرای طرح ثبت شده است.");
    const approve = decision.data.decision === "approve";
    const status = approve ? "approved" : "rejected";
    if (plan.status === status && plan.decidedBy === actor.id) return plan;
    if (plan.status !== "awaiting_approval" && !(plan.status === "approved" && !approve)) {
      throw new ApiError(409, "FAILOVER_PLAN_STATE", "وضعیت طرح برای این تصمیم معتبر نیست.");
    }
    if (approve && plan.requireSecondActor && plan.requestedBy === actor.id) {
      throw new ApiError(403, "FAILOVER_SECOND_ACTOR", "این سیاست به تأیید کاربر دیگری نیاز دارد.");
    }
    if (approve) {
      const current = checkFailover(plan.nodeId, plan.target, db);
      if (!current.result.ready || current.fingerprint !== row.state_fingerprint ||
          (plan.automatic && (!automaticFailoverEnabled() || !current.result.automaticEligible))) {
        db.prepare("UPDATE failover_plans SET status = 'stale' WHERE id = ?").run(id);
        audit(db, actor, "failover.plan.stale", id);
        return view(find(db, id), db);
      }
    }
    db.prepare("UPDATE failover_plans SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(status, actor.id, Date.now(), id);
    audit(db, actor, "failover.plan." + status, id);
    return view(find(db, id), db);
  });
}
