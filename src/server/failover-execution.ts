import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decorateNodes } from "@/lib/health";
import { can } from "@/lib/rbac";
import type { Alert, DemoUser, FailoverPreflight, FailoverExecution, FailoverEvent, Node } from "@/types";
import { enqueueTelegramAlerts } from "./telegram";
import { automaticFailoverEnabled, changeManagedRecord, dnsExecutionEnabled, enrolledRecord, matchesRecord, normalDomain,
  readManagedRecord, recordComment, resolverMatches, type ManagedRecord } from "./cloudflare-failover";
import { database, readWorkspace, transaction, writeWorkspace } from "./database";
import { checkFailover } from "./failover-preflight";
import { ApiError } from "./http";
import { provisionBusy } from "./provision";
import { observerIds, observersByNode } from "./probe-observers";
import { arvanZoneFor } from "./arvan-dns";

const uuid = z.string().uuid();
type Status = FailoverExecution["status"];
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function publicRun(row: Row): FailoverExecution {
  return {
    status: row.status as Status,
    detail: String(row.detail),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

export function executionFor(planId: string, db = database()) {
  const row = db.prepare("SELECT * FROM failover_executions WHERE plan_id = ?").get(planId);
  return row ? publicRun(row) : undefined;
}

export function operationalFailoverEvents(nodes: Node[], retentionDays: number): FailoverEvent[] {
  const inventory = new Map(nodes.map((node) => [node.id, node]));
  const records = database().prepare(`
    SELECT f.plan_id, f.status, f.detail, f.updated_at, p.node_id, p.preflight ->> '$.target' AS target
    FROM failover_executions f JOIN failover_plans p ON p.id = f.plan_id
    WHERE f.status IN ('succeeded','rolled_back','aborted') AND f.updated_at >= ?
    ORDER BY f.updated_at DESC, f.plan_id LIMIT 1000
  `).all(Date.now() - retentionDays * 86400000);
  return records.flatMap((entry) => {
    const node = inventory.get(String(entry.node_id));
    if (!node) return [];
    const target = entry.target === "backup" ? node.backupServerId : node.primaryServerId;
    const original = entry.target === "backup" ? node.primaryServerId : node.backupServerId;
    if (!target || !original) return [];
    const rolledBack = entry.status === "rolled_back";
    const success = entry.status === "succeeded";
    return [{
      id: String(entry.plan_id), nodeId: node.id, at: new Date(Number(entry.updated_at)).toISOString(),
      scenario: "operational", fromServerId: rolledBack ? target : original, toServerId: rolledBack ? original : target,
      result: rolledBack ? "rolled-back" : success ? "success" : "failed",
      state: rolledBack ? "ROLLBACK" : success ? "RECOVERED" : "FAILED",
      summary: String(entry.detail),
    }];
  });
}

function allow(actor: DemoUser, id: string) {
  if (!can(actor.role, "failover.run") || !can(actor.role, "dns.switch")) {
    throw new ApiError(403, "FORBIDDEN", "اجازهٔ اجرای Failover و تغییر DNS لازم است.");
  }
  if (!uuid.safeParse(id).success) throw new ApiError(422, "FAILOVER_PLAN_INPUT", "شناسهٔ طرح معتبر نیست.");
}

function saveAudit(db: DatabaseSync, actor: DemoUser, id: string, status: Status, detail: string, settled?: {
  plan: FailoverPreflight;
  record: ManagedRecord;
  side: "primary" | "backup";
}) {
  const { revision, state } = readWorkspace(db);
  if (settled) {
    const { plan, record, side } = settled;
    const at = new Date().toISOString();
    state.dns = state.dns.map((item) => item.nodeId === plan.nodeId && normalDomain(item.domain) === normalDomain(plan.domain)
      ? { ...item, aRecords: [record.content], aaaaRecords: [], cname: undefined, proxied: false,
        ttl: record.ttl, lastCheck: at, provider: "cloudflare", resolverOnly: undefined,
        expectedIranIp: record.content, authoritativeStatus: "matched",
        resolverStatus: status === "succeeded" ? "matched" : "propagation", resolverObservation: undefined, note: detail } : item);
    const nodes = state.nodes.map((node) => node.id === plan.nodeId
      ? { ...node, activeSide: side, lastFailoverAt: at, proxyProbe: undefined, proxyObservationSet: undefined,
        failoverState: status === "succeeded" ? "RECOVERED" as const : "ROLLBACK" as const }
      : node);
    state.nodes = decorateNodes(nodes, state.servers, state.tunnels, state.dns, state.settings, true);
    if (status === "succeeded") {
      state.alerts = state.alerts.map((alert) => alert.id.startsWith("failover-switch:") && alert.nodeId === plan.nodeId
        ? { ...alert, resolved: true } : alert);
      if (side === "backup") {
        const alert: Alert = { id: "failover-switch:" + id, nodeId: plan.nodeId, category: "failover", severity: "critical",
          title: "DNS switched to the backup route", detail: `${plan.domain} → ${record.content}`, createdAt: at, acked: false, resolved: false };
        state.alerts = [alert, ...state.alerts].slice(0, 2000);
        const policy = state.settings.failover.trigger === "tunnel-loss" ? state.settings.failover : state.policies.find((item) => item.nodeId === plan.nodeId);
        if (policy?.notifyTelegram) enqueueTelegramAlerts(db, state, [alert]);
      }
    }
    if (status === "succeeded") db.prepare("UPDATE failover_standby_repairs SET cleared_at=? WHERE node_id=? AND cleared_at IS NULL")
      .run(Date.parse(at), plan.nodeId);
  }
  state.audit = [{
    id: randomUUID(), actor: actor.name, role: actor.role, at: new Date().toISOString(), simulated: false,
    action: "failover.execute." + status, target: id, detail,
  }, ...state.audit].slice(0, 2000);
  writeWorkspace(db, state, revision + 1);
}

function find(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM failover_executions WHERE plan_id = ?").get(id);
  if (!row) throw new ApiError(404, "FAILOVER_RUN_UNKNOWN", "اجرای ثبت‌شده‌ای برای طرح وجود ندارد.");
  return row;
}

export function startFailoverExecution(actor: DemoUser, id: string) {
  allow(actor, id);
  if (!dnsExecutionEnabled()) throw new ApiError(503, "DNS_WRITE_DISABLED", "اجرای تغییر DNS در این محیط فعال نیست.");
  return transaction((db) => {
    const existing = executionFor(id, db);
    if (existing) return existing;
    const row = db.prepare("SELECT * FROM failover_plans WHERE id = ?").get(id);
    if (!row || row.status !== "approved" || Number(row.expires_at) <= Date.now()) {
      throw new ApiError(409, "FAILOVER_PLAN_STATE", "طرح تأییدشده و معتبر لازم است.");
    }
    const plan = JSON.parse(String(row.preflight)) as FailoverPreflight;
    const current = checkFailover(plan.nodeId, plan.target, db);
    if (!current.result.ready || current.fingerprint !== row.state_fingerprint ||
        (row.automatic === 1 && (!automaticFailoverEnabled() || !current.result.automaticEligible))) {
      throw new ApiError(409, "FAILOVER_PREFLIGHT", "شواهد اجرای طرح تغییر کرده است.", current.result.checks);
    }
    const state = readWorkspace(db).state;
    const node = state.nodes.find((item) => item.id === plan.nodeId)!;
    if (provisionBusy(db, node.primaryServerId, node.backupServerId, node.foreignServerId)) {
      throw new ApiError(409, "FAILOVER_DOMAIN_BUSY", "روی یکی از سرورهای مسیر عملیات نصب فعال است.");
    }
    const enrollment = enrolledRecord(plan.nodeId);
    const busy = db.prepare(`
      SELECT plan_id FROM failover_executions WHERE (domain = ? OR record_id = ?)
      AND status IN ('applying','verifying','rolling_back','review')
    `).get(normalDomain(plan.domain), enrollment.id);
    if (busy) throw new ApiError(409, "FAILOVER_DOMAIN_BUSY", "برای دامنه یا رکورد، کار فعال یا نیازمند بررسی وجود دارد.");
    const policy = readWorkspace(db).state.policies.find((item) => item.nodeId === plan.nodeId)!;
    const detail = "اجرای طرح ثبت شد و در انتظار اعمال است.";
    db.prepare(`
      INSERT INTO failover_executions (plan_id, domain, record_id, zone_id, status, detail, updated_at, verify_policy)
      VALUES (?, ?, ?, ?, 'applying', ?, ?, ?)
    `).run(id, normalDomain(plan.domain), enrollment.id, enrollment.zone, detail, Date.now(), JSON.stringify(policy));
    saveAudit(db, actor, id, "applying", detail);
    return publicRun(find(db, id));
  });
}

const inProgress = (value: unknown) => value === "applying" || value === "verifying" || value === "rolling_back";
const decode = (value: unknown): ManagedRecord | undefined => typeof value === "string" ? JSON.parse(value) : undefined;

export function requestFailoverRollback(actor: DemoUser, id: string) {
  allow(actor, id);
  if (!dnsExecutionEnabled()) throw new ApiError(503, "DNS_WRITE_DISABLED", "اجرای تغییر DNS در این محیط فعال نیست.");
  return transaction((db) => {
    const row = find(db, id);
    if (row.status === "rolling_back" || row.status === "rolled_back") return publicRun(row);
    if (row.status !== "verifying" || Number(row.lease_until ?? 0) > Date.now()) {
      throw new ApiError(409, "FAILOVER_RUN_STATE", "بازگشت در این مرحله یا هم‌زمان با عملیات دیگر مجاز نیست.");
    }
    const detail = "درخواست بازگشت ثبت شد.";
    db.prepare("UPDATE failover_executions SET status = 'rolling_back', detail = ?, updated_at = ? WHERE plan_id = ?")
      .run(detail, Date.now(), id);
    saveAudit(db, actor, id, "rolling_back", detail);
    return publicRun(find(db, id));
  });
}

function confirmedProbes(plan: FailoverPreflight, since: number, timeout: number) {
  const observers = observerIds(observersByNode(), plan.nodeId);
  const { state } = readWorkspace();
  const node = state.nodes.find((item) => item.id === plan.nodeId);
  if (!node) return 0;
  for (const id of [node.primaryServerId, node.backupServerId, node.foreignServerId]) {
    if (id) observers.delete(id);
  }
  const newest = new Map<string, boolean>();
  const rows = database().prepare(`
    SELECT server_id, json_extract(probe.value, '$.ok') AS ok, json_extract(probe.value, '$.elapsedMs') AS elapsed
    FROM agent_reports, json_each(payload, '$.proxyProbes') AS probe
    WHERE observed_at >= ? AND observed_at <= ?
      AND NOT EXISTS (SELECT 1 FROM agent_credentials c WHERE c.server_id = agent_reports.server_id
        AND (c.credential_digest IS NULL OR c.updated_at > agent_reports.observed_at))
      AND json_extract(probe.value, '$.nodeId') = ?
      AND coalesce(json_extract(probe.value, '$.side'), 'active') = 'active'
    ORDER BY observed_at DESC
  `).all(Math.max(since, Date.now() - 90000), Date.now(), plan.nodeId);
  for (const row of rows) {
    const id = String(row.server_id);
    if (!observers.has(id) || newest.has(id)) continue;
    newest.set(id, row.ok === 1 && typeof row.elapsed === "number" && row.elapsed <= timeout);
  }
  return [...newest.values()].filter(Boolean).length;
}

export async function advanceFailoverExecution(actor: DemoUser, id: string, reconcile = false) {
  allow(actor, id);
  if (!dnsExecutionEnabled()) throw new ApiError(503, "DNS_WRITE_DISABLED", "اجرای تغییر DNS در این محیط فعال نیست.");
  const lease = randomUUID();
  const claimed = transaction((db) => {
    const row = find(db, id);
    if ((reconcile ? row.status !== "review" : !inProgress(row.status)) || Number(row.lease_until ?? 0) > Date.now()) return { row, planRow: undefined };
    const planRow = db.prepare("SELECT * FROM failover_plans WHERE id = ?").get(id);
    if (!planRow) throw new Error("Missing failover plan");
    db.prepare("UPDATE failover_executions SET lease = ?, lease_until = ? WHERE plan_id = ?").run(lease, Date.now() + 45000, id);
    return { row, planRow };
  });
  const { row, planRow } = claimed;
  if (!planRow) return publicRun(row);

  const plan = JSON.parse(String(planRow.preflight)) as FailoverPreflight;
  const policy = JSON.parse(String(row.verify_policy)) as { probeTimeoutMs: number; minConfirmations: number; rollbackStrategy: string };
  const enrollment = { id: String(row.record_id), zone: String(row.zone_id) };
  const previous = decode(row.before_record);
  const applied = decode(row.applied_record);
  const marker = "NodeGuard failover " + id;
  const sameContent = (record: ManagedRecord, before: ManagedRecord, content: string, note: string) =>
    record.content === content && recordComment(record) === note && record.ttl === before.ttl &&
    JSON.stringify(record.tags?.slice().sort()) === JSON.stringify(before.tags?.slice().sort());

  const fenced = <T>(fn: (db: DatabaseSync) => T) => transaction((db) => {
    const live = find(db, id);
    if (live.lease !== lease || Number(live.lease_until) <= Date.now()) {
      throw new ApiError(409, "FAILOVER_LEASE", "مهلت این مرحله پایان یافته است.");
    }
    return fn(db);
  });
  const transition = (status: Status, detail: string, record?: ManagedRecord) => fenced((db) => {
    const now = Date.now();
    db.prepare(`
      UPDATE failover_executions SET status = ?, detail = ?, updated_at = ?, lease = NULL, lease_until = NULL,
        applied_record = coalesce(?, applied_record),
        verify_after = coalesce(?, verify_after), verify_until = coalesce(?, verify_until)
      WHERE plan_id = ?
    `).run(status, detail, now, status === "verifying" && record ? JSON.stringify(record) : null,
      status === "verifying" && record ? now + record.ttl * 1000 : null,
      status === "verifying" && record ? now + (record.ttl + 120) * 1000 : null, id);
    if (status !== row.status) {
      const side = status === "succeeded" ? plan.target : plan.target === "backup" ? "primary" : "backup";
      saveAudit(db, actor, id, status, detail, record && (status === "succeeded" || status === "rolled_back") ? { plan, record, side } : undefined);
    }
    return publicRun(find(db, id));
  });
  const review = (detail: string) => transition("review", detail);

  try {
    if (arvanZoneFor(plan.domain)) return review("سرویس‌دهندهٔ دامنه تغییر کرده است. اجرای Cloudflare متوقف شد.");
    const enabled = enrolledRecord(plan.nodeId);
    if (enabled.id !== enrollment.id || enabled.zone !== enrollment.zone) {
      return review("پیکربندی رکورد مدیریت‌شده تغییر کرده است.");
    }
    const current = await readManagedRecord(enrollment, plan.domain);
    if (row.status === "review") {
      if (previous && sameContent(current, previous, previous.content, recordComment(previous))) {
        return transition("rolled_back", "بازخوانی، بازیابی مقدار authoritative پیشین را تأیید کرد.", current);
      }
      if (previous && !row.rollback_at && (applied
        ? matchesRecord(current, applied)
        : sameContent(current, previous, plan.toIp!, marker))) {
        return transition("verifying", "رکورد متعلق به همین اجراست. راستی‌آزمایی از سر گرفته شد.", current);
      }
      return review("رکورد با نسخهٔ پیشین یا تغییر ثبت‌شده هم‌خوانی ندارد.");
    }
    if (row.status === "applying") {
      if (previous) {
        if (sameContent(current, previous, plan.toIp!, marker)) {
          return transition("verifying", "تغییر authoritative ثبت شد. در انتظار TTL و کاوش دامنه.", current);
        }
        if (matchesRecord(current, previous) && Date.now() - Number(row.attempted_at) < 20000) {
          return transition("applying", "نتیجهٔ نوشتن هنوز مشاهده نشده است.");
        }
        return review("نتیجهٔ تغییر قطعی نیست یا رکورد در بیرون تغییر کرده است.");
      }
      const accepted = fenced((db) => {
        const recheck = checkFailover(plan.nodeId, plan.target, db);
        const ttl = readWorkspace(db).state.dns.find((item) => item.nodeId === plan.nodeId)?.ttl;
        if (Number(planRow.expires_at) <= Date.now() || !recheck.result.ready || recheck.fingerprint !== planRow.state_fingerprint ||
            (planRow.automatic === 1 && (!automaticFailoverEnabled() || !recheck.result.automaticEligible)) ||
            current.content !== plan.fromIp || current.ttl !== ttl) return false;
        db.prepare("UPDATE failover_executions SET before_record = ?, attempted_at = ? WHERE plan_id = ?")
          .run(JSON.stringify(current), Date.now(), id);
        return true;
      });
      if (!accepted) return transition("aborted", "طرح، شواهد یا رکورد مبنا دیگر منطبق نیست.");
      try {
        await changeManagedRecord(enrollment, plan.toIp!, marker);
      } catch {
        // The provider may have applied the write before the response was lost.
      }
      const observed = await readManagedRecord(enrollment, plan.domain);
      if (sameContent(observed, current, plan.toIp!, marker)) {
        return transition("verifying", "تغییر authoritative ثبت شد. در انتظار TTL و کاوش دامنه.", observed);
      }
      return matchesRecord(observed, current)
        ? transition("applying", "نتیجهٔ نوشتن هنوز مشاهده نشده است.")
        : review("رکورد پس از درخواست با تغییر مورد انتظار هم‌خوانی ندارد.");
    }

    if (!applied || !previous) return review("تصویر قبل و بعد رکورد کامل نیست.");
    if (row.status === "verifying") {
      if (!matchesRecord(current, applied)) return review("رکورد بعد از سوییچ در بیرون تغییر کرده است.");
      const after = Number(row.verify_after);
      if (Date.now() >= after && confirmedProbes(plan, after, policy.probeTimeoutMs) >= policy.minConfirmations &&
          await resolverMatches(plan.domain, plan.toIp!)) {
        const confirmed = await readManagedRecord(enrollment, plan.domain);
        if (!matchesRecord(confirmed, applied)) return review("رکورد در زمان راستی‌آزمایی در بیرون تغییر کرد.");
        const { state } = readWorkspace();
        const node = state.nodes.find((item) => item.id === plan.nodeId);
        const dns = state.dns.find((item) => item.nodeId === plan.nodeId);
        if (!node || !dns || node.activeSide === plan.target || normalDomain(node.domain) !== normalDomain(plan.domain) ||
            normalDomain(dns.domain) !== normalDomain(plan.domain) || normalDomain(dns.v2boardHost) !== normalDomain(plan.domain) || dns.v2boardIp) {
          return review("توپولوژی یا مقصد V2Board در زمان راستی‌آزمایی تغییر کرد.");
        }
        return transition("succeeded", "رکورد authoritative، resolver و کاوش مستقل مسیر را تأیید کردند.", confirmed);
      }
      if (Date.now() >= Number(row.verify_until)) {
        return policy.rollbackStrategy === "restore-primary-dns"
          ? transition("rolling_back", "مهلت راستی‌آزمایی گذشت. بازگشت به رکورد قبلی در صف است.")
          : review("مهلت راستی‌آزمایی گذشت و سیاست نیازمند بررسی اپراتور است.");
      }
      return transition("verifying", "در انتظار راستی‌آزمایی DNS و کاوش مستقل دامنه.");
    }

    if (row.rollback_at) {
      if (sameContent(current, previous, previous.content, recordComment(previous))) {
        return transition("rolled_back", "مقدار authoritative به رکورد پیشین بازگشت.", current);
      }
      return matchesRecord(current, applied) && Date.now() - Number(row.rollback_at) < 20000
        ? transition("rolling_back", "نتیجهٔ بازگشت هنوز مشاهده نشده است.")
        : review("بازگشت تأیید نشد یا رکورد خارج از NodeGuard تغییر کرده است.");
    }
    if (!matchesRecord(current, applied)) return review("بازگشت به دلیل تغییر رکورد توسط نویسندهٔ دیگری متوقف شد.");
    fenced((db) => {
      db.prepare("UPDATE failover_executions SET rollback_at = ? WHERE plan_id = ?").run(Date.now(), id);
    });
    try {
      await changeManagedRecord(enrollment, previous.content, recordComment(previous));
    } catch {
      // Reconcile the authoritative value below.
    }
    const restored = await readManagedRecord(enrollment, plan.domain);
    if (sameContent(restored, previous, previous.content, recordComment(previous))) {
      return transition("rolled_back", "مقدار authoritative به رکورد پیشین بازگشت.", restored);
    }
    return matchesRecord(restored, applied)
      ? transition("rolling_back", "نتیجهٔ بازگشت هنوز مشاهده نشده است.")
      : review("مقدار رکورد پس از بازگشت با انتظار منطبق نیست.");
  } catch (error) {
    if (!(error instanceof ApiError) || error.code === "FAILOVER_LEASE") throw error;
    if (error.code === "FAILOVER_DNS_UPSTREAM") {
      if (row.status === "applying" && !previous && Number(planRow.expires_at) <= Date.now()) {
        return transition("aborted", "مهلت طرح قبل از ارسال تغییر به پایان رسید.");
      }
      if ((row.attempted_at && row.status === "applying" && Date.now() - Number(row.attempted_at) > 120000) ||
          (row.status === "verifying" && Date.now() > Number(row.verify_until) + 120000) ||
          (row.rollback_at && Date.now() - Number(row.rollback_at) > 120000)) {
        return review("تا پایان مهلت، وضعیت authoritative قابل بررسی نبود.");
      }
      return transition(row.status as Status, "Cloudflare در دسترس نیست. نتیجه از روی رکورد دوباره بررسی می‌شود.");
    }
    return row.status === "applying" && !previous && error.code !== "FAILOVER_DNS_UPSTREAM"
      ? transition("aborted", error.message) : review(error.message);
  }
}
