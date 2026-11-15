import { createInterface } from "node:readline";
import { connect } from "node:tls";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { can } from "@/lib/rbac";
import type { Alert, DemoUser } from "@/types";
import { digest } from "./auth";
import { database, readWorkspace, transaction, type Workspace } from "./database";
import { ApiError } from "./http";
import { workspaceMode } from "./inventory";
import { readSealedCredential, writeSealedCredential } from "./provider-secrets";

const address = z.string().trim().email().max(254).regex(/^[a-z\d._+%!-]+@[a-z\d.-]+$/i);
const credentials = z.object({ sender: address, recipient: address,
  appPassword: z.string().transform((value) => value.replaceAll(" ", "")).pipe(z.string().regex(/^[a-z\d]{16}$/i)),
}).strict();
type Gmail = z.output<typeof credentials>;
const rank = { info: 0, warning: 1, critical: 2 };
const destination = (config: Gmail) => digest(config.sender + "\n" + config.recipient);

function config(db: DatabaseSync) {
  return credentials.safeParse(readSealedCredential(db, "gmail")).data;
}

function allow(actor: DemoUser) {
  if (workspaceMode() !== "monitor" || !can(actor.role, "settings.edit")) throw new ApiError(403, "FORBIDDEN", "دسترسی مدیریت اعلان لازم است.");
}

export function gmailSettings(actor: DemoUser) {
  allow(actor);
  const db = database();
  const gmail = config(db);
  const history = db.prepare("SELECT status, created_at AS createdAt FROM email_outbox ORDER BY created_at DESC LIMIT 10").all();
  return { sender: gmail?.sender, recipient: gmail?.recipient, history };
}

export function saveGmail(actor: DemoUser, input: unknown) {
  allow(actor);
  const gmail = credentials.safeParse(input);
  if (!gmail.success) throw new ApiError(422, "GMAIL_CONFIG", "آدرس فرستنده و گیرنده و رمز برنامهٔ ۱۶ کاراکتری را بررسی کنید.");
  transaction((db) => writeSealedCredential(db, "gmail", gmail.data));
  return gmailSettings(actor);
}

export function enqueueGmailAlerts(db: DatabaseSync, state: Workspace, alerts: Alert[]) {
  if (!state.settings.notifications.email || !alerts.length) return;
  let gmail: Gmail | undefined;
  try { gmail = config(db); } catch { return; }
  if (!gmail) return;
  const insert = db.prepare("INSERT OR IGNORE INTO email_outbox (alert_id,destination,body,status,created_at) VALUES (?,?,?,'pending',?)");
  for (const alert of alerts) {
    if (rank[alert.severity] >= rank[state.settings.notifications.onSeverity]) {
      insert.run(alert.id, destination(gmail), `NodeGuard · ${alert.severity}\n${alert.title}\n${alert.detail}`.slice(0, 2000), Date.now());
    }
  }
}

async function deliver(gmail: Gmail, body: string) {
  const socket = connect({ host: "smtp.gmail.com", port: 465, servername: "smtp.gmail.com" });
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  lines.on("error", () => lines.close());
  socket.on("error", () => lines.close());
  const iterator = lines[Symbol.asyncIterator]();
  const timeout = setTimeout(() => socket.destroy(new Error("SMTP timeout")), 12000);
  let submitted = false;
  let smtpStatus: number | undefined;
  async function command(code: number, value?: string) {
    if (value) socket.write(value + "\r\n");
    for (let count = 0; count < 32; count++) {
      const line = (await iterator.next()).value;
      smtpStatus = typeof line === "string" && /^\d{3}[ -]/.test(line) ? Number(line.slice(0, 3)) : undefined;
      if (smtpStatus !== code) throw new Error("SMTP rejected command");
      if (line[3] === " ") return;
    }
    throw new Error("SMTP reply exceeded line limit");
  }
  try {
    await command(220);
    await command(250, "EHLO nodeguard.local");
    await command(235, "AUTH PLAIN " + Buffer.from(`\0${gmail.sender}\0${gmail.appPassword}`).toString("base64"));
    await command(250, `MAIL FROM:<${gmail.sender}>`);
    await command(250, `RCPT TO:<${gmail.recipient}>`);
    await command(354, "DATA");
    const encoded = Buffer.from(body).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
    submitted = true;
    await command(250, `From: ${gmail.sender}\r\nTo: ${gmail.recipient}\r\nSubject: NodeGuard alert\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n.`);
    return "sent";
  } catch {
    if (smtpStatus && smtpStatus >= 400 && smtpStatus < 500) return "retry";
    if (smtpStatus && smtpStatus >= 500) return "failed";
    return submitted ? "unknown" : "retry";
  } finally {
    clearTimeout(timeout);
    lines.close();
    socket.destroy();
  }
}

export async function tickGmail() {
  const task = transaction((db) => {
    const now = Date.now();
    db.prepare("UPDATE email_outbox SET status='unknown' WHERE status='sending' AND attempted_at<?").run(now - 20000);
    db.prepare("UPDATE email_outbox SET status='skipped' WHERE status='pending' AND created_at<?").run(now - 3600000);
    db.prepare("DELETE FROM email_outbox WHERE created_at<? AND status NOT IN ('pending','sending')").run(now - 30 * 86400000);
    if (db.prepare("SELECT 1 FROM email_outbox WHERE status='sending'").get()) return null;
    const pending = db.prepare("SELECT * FROM email_outbox WHERE status='pending' AND due_at<=? ORDER BY created_at LIMIT 1").get(now);
    if (!pending) return null;
    const { state } = readWorkspace(db);
    const alert = state.alerts.find(({ id }) => id === pending.alert_id);
    const gmail = state.settings.notifications.email ? config(db) : undefined;
    const id = String(pending.alert_id);
    if (!gmail || !alert || alert.resolved || pending.destination !== destination(gmail) || rank[alert.severity] < rank[state.settings.notifications.onSeverity] ||
      (alert.metricRuleId && !state.settings.metricAlertRules?.some(({ id, enabled }) => id === alert.metricRuleId && enabled))) {
      db.prepare("UPDATE email_outbox SET status='skipped' WHERE alert_id=?").run(id);
      return null;
    }
    const delayUntil = Date.parse(alert.silencedUntil ?? "") || 0;
    if (delayUntil > now) {
      db.prepare("UPDATE email_outbox SET due_at=? WHERE alert_id=?").run(delayUntil, id);
      return null;
    }
    db.prepare("UPDATE email_outbox SET status='sending', attempted_at=?, attempts=attempts+1 WHERE alert_id=?").run(now, id);
    return { id, gmail, body: String(pending.body), attempt: Number(pending.attempts) + 1 };
  });
  if (!task) return { processed: 0 };
  const result = await deliver(task.gmail, task.body);
  const status = result === "retry" ? task.attempt < 4 ? "pending" : "failed" : result;
  database().prepare("UPDATE email_outbox SET status=?, due_at=? WHERE alert_id=? AND status='sending' AND attempts=?")
    .run(status, Date.now() + task.attempt * 15000, task.id, task.attempt);
  return { processed: 1 };
}
