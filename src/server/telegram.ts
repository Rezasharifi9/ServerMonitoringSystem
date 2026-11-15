import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readSealedCredential, writeSealedCredential } from "./provider-secrets";
import type { DatabaseSync } from "node:sqlite";
import type { Alert, DemoUser } from "@/types";
import { can } from "@/lib/rbac";
import { digest } from "./auth";
import { database, readWorkspace, transaction, type Workspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { configuredAlert } from "@/lib/configured-alerts";
import { formatTelegramAlert } from "@/lib/telegram-alert-text";
import type { V2BoardCatalogEntry } from "@/types";

const rank = { info: 0, warning: 1, critical: 2 };
const MAX_AGE = 3600000;
const credentials = z.object({
  token: z.string().regex(/^\d{1,20}:[A-Za-z\d_-]{20,100}$/),
  adminId: z.string().regex(/^-?[1-9]\d{0,15}$/),
  botId: z.string().regex(/^[1-9]\d{0,19}$/),
}).strict().refine((value) => value.token.split(":")[0] === value.botId);

export function telegramConfig(actor: DemoUser) {
  allow(actor);
  const saved = credentials.safeParse(readSealedCredential(database(), "telegram-bot"));
  return saved.success ? { configured: true, adminId: saved.data.adminId, botId: saved.data.botId } : { configured: false };
}

export function saveTelegramConfig(actor: DemoUser, input: unknown) {
  allow(actor);
  const parsed = credentials.safeParse(input);
  if (!parsed.success) throw new ApiError(422, "TELEGRAM_CONFIG", "توکن، شناسهٔ ربات و شناسهٔ مقصد را بررسی کنید. شناسهٔ ربات باید با ابتدای توکن یکی باشد.");
  transaction((db) => writeSealedCredential(db, "telegram-bot", parsed.data));
  return telegramConfig(actor);
}

function destination() {
  if (workspaceMode() !== "monitor") return null;
  const saved = credentials.safeParse(readSealedCredential(database(), "telegram-bot"));
  if (saved.success) return { token: saved.data.token, chat: saved.data.adminId };
  if (process.env.NODEGUARD_ENABLE_TELEGRAM !== "1") return null;
  const token = process.env.NODEGUARD_TELEGRAM_BOT_TOKEN ?? "";
  const chat = process.env.NODEGUARD_TELEGRAM_CHAT_ID ?? "";
  return /^\d{1,20}:[A-Za-z\d_-]{20,100}$/.test(token) && /^-?[1-9]\d{0,15}$/.test(chat) ? { token, chat } : null;
}

function enqueue(db: DatabaseSync, key: string, alertId: string | null, body: string, chat: string, due: number) {
  db.prepare(`
    INSERT OR IGNORE INTO telegram_outbox (id, dedup_key, alert_id, text, recipient, status, attempts, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(randomUUID(), key, alertId, body.slice(0, 4000), digest(chat), due, Date.now());
}

export function enqueueTelegramAlerts(db: DatabaseSync, state: Workspace, alerts: Alert[]) {
  const target = destination();
  const settings = state.settings.notifications;
  if (!target || !settings.telegram) return;
  for (const alert of alerts) {
    if (!configuredAlert(alert, state.settings)) continue;
    if (rank[alert.severity] < rank[settings.onSeverity]) continue;
    const now = Date.now();
    const due = Math.max(now, Date.parse(alert.silencedUntil ?? "") || 0);
    enqueue(db, "alert:" + alert.id, alert.id, telegramAlertText(state, alert), target.chat, due);
  }
}

export function telegramAlertText(state: Workspace, alert: Alert) {
  const tunnel = state.tunnels.find(t => t.id === alert.tunnelId);
  const cached = tunnel?.nodeRef?.kind === "v2board"
    ? database().prepare("SELECT payload FROM provider_cache WHERE provider='v2board'").get() : undefined;
  const panelNodes = cached ? (JSON.parse(String(cached.payload)) as { nodes: V2BoardCatalogEntry[] }).nodes : [];
  return formatTelegramAlert(state, alert, panelNodes);
}

function allow(actor: DemoUser) {
  if (!can(actor.role, "settings.edit")) throw new ApiError(403, "FORBIDDEN", "دسترسی مدیریت اعلان لازم است.");
}

export function telegramHistory(actor: DemoUser) {
  allow(actor);
  const history = database().prepare(`
    SELECT id, alert_id AS alertId, status, attempts, created_at AS createdAt, message_id AS messageId, detail
    FROM telegram_outbox ORDER BY created_at DESC LIMIT 30
  `).all();
  return { enabled: Boolean(destination()), history };
}

export function queueTelegramTest(actor: DemoUser, key: string) {
  allow(actor);
  const target = destination();
  if (!target) throw new ApiError(503, "TELEGRAM_DISABLED", "تحویل تلگرام در تنظیمات محیط فعال نشده است.");
  if (!/^[\w-]{12,128}$/.test(key)) throw new ApiError(400, "IDEMPOTENCY_KEY", "شناسهٔ یکتای درخواست لازم است.");
  const dedup = "test:" + actor.id + ":" + key;
  return transaction((db) => {
    const replay = db.prepare("SELECT id FROM telegram_outbox WHERE dedup_key = ?").get(dedup);
    if (replay) return { id: replay.id, replay: true };
    const recent = db.prepare("SELECT 1 FROM telegram_outbox WHERE alert_id IS NULL AND created_at > ?").get(Date.now() - 30000);
    if (recent) throw new ApiError(429, "TELEGRAM_TEST_RATE", "برای ثبت آزمایش بعدی ۳۰ ثانیه صبر کنید.");
    enqueue(db, dedup, null, "NodeGuard\nاین پیام آزمایشی از صف اعلان زیرساخت ارسال شد.", target.chat, Date.now());
    return { id: db.prepare("SELECT id FROM telegram_outbox WHERE dedup_key = ?").get(dedup)?.id, replay: false };
  });
}

type Delivery = { status: "sent"; messageId: number } | { status: "pending"; retryMs: number } |
  { status: "failed" | "unknown"; detail: string };

export async function sendTelegramTest(actor: DemoUser, key: string) {
  const queued = queueTelegramTest(actor, key);
  if (!queued.replay) await tickTelegram(actor, String(queued.id));
  const delivery = database().prepare("SELECT status, detail FROM telegram_outbox WHERE id=?").get(String(queued.id));
  return { ...queued, status: String(delivery?.status ?? "pending"), detail: delivery?.detail as string | null };
}

async function deliver(target: NonNullable<ReturnType<typeof destination>>, text: string): Promise<Delivery> {
  try {
    const response = await fetch("https://api.telegram.org/bot" + target.token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
      body: JSON.stringify({ chat_id: target.chat, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(6000),
    });
    const payload = await response.json();
    if (response.ok && payload.ok === true && Number.isSafeInteger(payload.result?.message_id)) {
      return { status: "sent", messageId: payload.result.message_id };
    }
    if (response.status === 429 || (payload.ok === false && response.status >= 500)) {
      const seconds = payload.parameters?.retry_after;
      return { status: "pending", retryMs: Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : 15000 };
    }
    if (payload.ok === false && response.status >= 400 && response.status < 500) {
      const detail = response.status === 401 || response.status === 404 ? "invalid_token"
        : response.status === 403 ? "bot_forbidden"
        : response.status === 400 ? "invalid_chat" : "telegram_rejected";
      return { status: "failed", detail };
    }
  } catch {
    // A lost reply does not prove that a message was not sent.
  }
  return { status: "unknown", detail: "delivery_unconfirmed" };
}

export async function tickTelegram(actor: DemoUser, testId?: string) {
  allow(actor);
  const target = destination();
  if (!target) throw new ApiError(503, "TELEGRAM_DISABLED", "تحویل تلگرام فعال نیست.");
  const row = transaction((db) => {
    const now = Date.now();
    db.prepare("UPDATE telegram_outbox SET status='unknown', detail='worker_interrupted' WHERE status='sending' AND last_attempt <= ?")
      .run(now - 20000);
    db.prepare("UPDATE telegram_outbox SET status='skipped', detail='expired' WHERE status='pending' AND created_at < ?")
      .run(now - MAX_AGE);
    db.prepare("DELETE FROM telegram_outbox WHERE created_at < ? AND status NOT IN ('sending','pending')").run(now - 30 * 86400000);
    const { state } = readWorkspace(db);
    if (!testId && state.settings.notifications.telegram) {
      const latest = db.prepare("SELECT MAX(MAX(created_at, COALESCE(last_attempt, 0))) AS at FROM telegram_outbox WHERE alert_id=?");
      for (const alert of state.alerts) {
        if (!configuredAlert(alert, state.settings)) continue;
        if (alert.resolved || rank[alert.severity] < rank[state.settings.notifications.onSeverity]) continue;
        if (alert.metricRuleId && !state.settings.metricAlertRules?.some((rule) => rule.id === alert.metricRuleId && rule.enabled)) continue;
        if (db.prepare("SELECT 1 FROM telegram_outbox WHERE alert_id=? AND status IN ('pending','sending')").get(alert.id)) continue;
        const previous = latest.get(alert.id)?.at;
        if (typeof previous === "number" && now - previous < 3600000) continue;
        enqueue(db, previous == null ? "alert:" + alert.id : `reminder:${alert.id}:${previous}`, alert.id,
          telegramAlertText(state, alert), target.chat, Math.max(now, Date.parse(alert.silencedUntil ?? "") || 0));
      }
    }
    if (db.prepare("SELECT 1 FROM telegram_outbox WHERE status='sending'").get()) return null;
    if (!testId && db.prepare("SELECT 1 FROM telegram_outbox WHERE last_attempt > ?").get(now - 3000)) return null;
    const task = testId
      ? db.prepare("SELECT * FROM telegram_outbox WHERE id=? AND alert_id IS NULL AND status='pending' AND due_at <= ?").get(testId, now)
      : db.prepare("SELECT * FROM telegram_outbox WHERE status='pending' AND due_at <= ? ORDER BY created_at LIMIT 1").get(now);
    if (!task) return null;
    const settings = state.settings.notifications;
    const alert = task.alert_id ? state.alerts.find((item) => item.id === task.alert_id) : undefined;
    if (task.recipient !== digest(target.chat) || (task.alert_id &&
        (!alert || alert.resolved || !settings.telegram || rank[alert.severity] < rank[settings.onSeverity] ||
          (alert.metricRuleId && !state.settings.metricAlertRules?.some(({ id, enabled }) => id === alert.metricRuleId && enabled))))) {
      db.prepare("UPDATE telegram_outbox SET status='skipped', detail='policy_changed' WHERE id=?").run(task.id);
      return null;
    }
    const waitUntil = alert ? Date.parse(alert.silencedUntil ?? "") || 0 : 0;
    if (waitUntil > now) {
      db.prepare("UPDATE telegram_outbox SET due_at=? WHERE id=?").run(waitUntil, task.id);
      return null;
    }
    db.prepare("UPDATE telegram_outbox SET status='sending', last_attempt=?, attempts=attempts+1 WHERE id=?").run(now, task.id);
    return { id: String(task.id), text: alert ? telegramAlertText(state, alert) : String(task.text), createdAt: Number(task.created_at), attempt: Number(task.attempts) + 1 };
  });
  if (!row) return { processed: 0 };
  const result = await deliver(target, String(row.text));
  transaction((db) => {
    const now = Date.now();
    const retry = result.status === "pending" && row.attempt < 5 && now + result.retryMs < row.createdAt + MAX_AGE;
    const status = retry ? "pending" : result.status === "pending" ? "failed" : result.status;
    db.prepare(`
      UPDATE telegram_outbox SET status=?, due_at=?, message_id=?, detail=?
      WHERE id=? AND status='sending' AND attempts=?
    `).run(status, retry && result.status === "pending" ? now + Math.max(result.retryMs, row.attempt * 5000) : now,
      result.status === "sent" ? result.messageId : null,
      result.status === "failed" || result.status === "unknown" ? result.detail : result.status === "pending" ? "telegram_retry" : null,
      row.id, row.attempt);
  });
  return { processed: 1 };
}
