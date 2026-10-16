// Server-only: sending. A sent message first waits in the outbox — a few
// seconds for "Undo" (mail_prefs.undoSeconds) or until the time a person
// chose ("Send later") — and the clock (tick.ts) hands it to the account's
// SMTP server. Then a copy is filed in Sent (unless the service does that
// itself), the message replied to is marked answered, the draft goes, and
// the zvena links in it become links of the conversation (ecosystem).

import { rm } from "node:fs/promises";
import { join } from "node:path";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { refsInNote, refsInMarkdown } from "../eco/extract";
import { origins, resolveTargets } from "../eco/indexer";
import { setDerived } from "../eco/links";
import { ctxFor } from "../projects/core";
import { newId, sql, tx } from "../store";
import { roleIn } from "../workspaces";
import { buildMessage, ComposeError, uploadsDir, type Built } from "./compose";
import { unseal } from "./crypto";
import { deleteDraft, saveDraft } from "./drafts";
import { mailChanged } from "./events";
import { checkEndpoint, resolveEndpoint, tlsOptions } from "./guard";
import { failureOf, placeholderUid } from "./imap";
import { signIn, type MailSecret } from "./providers";
import { mailDb } from "./schema";
import { accountById, folderByRole, ownAccount, ownMessage, upsertMessage, type AccountRow } from "./store";
import { prefsOf } from "./prefs";
import { htmlToPlain } from "./sanitize";
import { BOX } from "./views";
import { enqueueOp } from "./worker";
import type { Draft, OutboxItem } from "./types";

/** An SMTP transport for the account, through the address guard. */
export async function smtpTransport(acct: Pick<AccountRow, "id" | "user_id" | "auth" | "username" | "secret" | "smtp_host" | "smtp_port" | "smtp_tls">) {
  const ep = checkEndpoint("smtp", acct.smtp_host, acct.smtp_port, acct.smtp_tls);
  const at = await resolveEndpoint(ep.host);
  const { smtp } = await signIn(acct, unseal<MailSecret>(acct.secret, { accountId: acct.id, userId: acct.user_id }));
  const opts: SMTPTransport.Options & { servername?: string } = {
    host: at.address,
    port: ep.port,
    secure: ep.security === "tls",
    requireTLS: ep.security === "starttls",
    ignoreTLS: ep.security === "none",
    ...(at.servername ? { servername: at.servername } : {}),
    auth: smtp,
    tls: tlsOptions(at.servername),
    name: "zvena.app",
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  };
  return nodemailer.createTransport(opts);
}

const MAX_SEND_LATER = 366 * 86_400_000;
const MAX_QUEUED_PER_USER = 200;

/** Bytes a person may have waiting in the outbox (scheduled mail with attachments adds up). */
export function outboxQuota(): number {
  const v = Number(process.env.ZVENA_MAIL_OUTBOX_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200 * 1024 ** 2;
}

export interface SendInput {
  draft: Draft;
  /** Send at this time (ms); absent: now, after the undo delay. */
  sendAt?: number;
  /** The workspace the person wrote from: zvena links in the message are linked there. */
  ws?: string;
  /** Attachments of the forwarded message to send along (their ids). */
  forwardAttachments?: string[];
}

/** Puts a message in the outbox; it leaves at `sendAt` (or after the undo delay). */
export async function queueSend(userId: string, senderName: string, input: SendInput): Promise<OutboxItem> {
  mailDb();
  const acct = ownAccount(userId, input.draft.accountId);
  if (!acct) throw new ComposeError(404, "account not found");
  const d = input.draft;
  if (!d.to.length && !d.cc.length && !d.bcc.length) throw new ComposeError(400, "no recipients");
  const queued = Number((sql("SELECT COUNT(*) AS n FROM mail_outbox WHERE user_id = ?").get(userId) as { n: number }).n);
  if (queued >= MAX_QUEUED_PER_USER) throw new ComposeError(429, "outbox full");
  const now = Date.now();
  const later = typeof input.sendAt === "number" && input.sendAt > now + 30_000;
  if (later && (input.sendAt as number) > now + MAX_SEND_LATER) throw new ComposeError(400, "too far");
  const sendAt = later ? Math.floor(input.sendAt as number) : now + prefsOf(userId).undoSeconds * 1000;
  // Forwarded attachments are downloaded now (the original may be gone by the time it sends).
  const forwarded: { filename: string; type: string; content: Buffer }[] = [];
  if (d.mode === "forward" && d.replyTo && input.forwardAttachments?.length) {
    const orig = ownMessage(userId, d.replyTo);
    if (orig) {
      const { forwardedParts } = await import("./attachments");
      forwarded.push(...(await forwardedParts(userId, orig, input.forwardAttachments)));
    }
  }
  const built = await buildMessage(userId, acct, acct.name || senderName, d, { forwarded });
  const held = Number((sql("SELECT COALESCE(SUM(length(raw) + IFNULL(length(copy), 0)), 0) AS b FROM mail_outbox WHERE user_id = ?").get(userId) as { b: number }).b);
  if (held + built.raw.length + built.copy.length > outboxQuota()) throw new ComposeError(507, "outbox full");
  const id = newId(12);
  const ws = typeof input.ws === "string" && roleIn(userId, input.ws) ? input.ws : null;
  sql("INSERT INTO mail_outbox (id, user_id, account_id, send_at, state, envelope, raw, copy, draft, ws, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)").run(
    id,
    userId,
    acct.id,
    sendAt,
    JSON.stringify({ ...built.envelope, msgid: built.msgid, inReplyTo: built.inReplyTo, references: built.references }),
    built.raw,
    built.copy,
    JSON.stringify(d),
    ws,
    now
  );
  // The draft is the outbox's now (Undo brings it back); its copy in the Drafts folder goes too.
  deleteDraft(userId, d.id);
  scheduleSend(id, sendAt);
  return outboxItem(userId, id) as OutboxItem;
}

interface OutboxRow {
  id: string;
  user_id: string;
  account_id: string;
  send_at: number;
  state: "queued" | "sending" | "failed";
  error: string | null;
  envelope: string;
  draft: string;
  ws: string | null;
}

function toItem(r: OutboxRow): OutboxItem {
  let d: Partial<Draft> = {};
  try {
    d = JSON.parse(r.draft) as Draft;
  } catch {
    d = {};
  }
  return { id: r.id, accountId: r.account_id, sendAt: Number(r.send_at), state: r.state, ...(r.error ? { error: r.error } : {}), subject: d.subject ?? "", to: [...(d.to ?? []), ...(d.cc ?? [])].map((a) => a.address) };
}

export function outboxItem(userId: string, id: string): OutboxItem | null {
  const r = sql("SELECT id, user_id, account_id, send_at, state, error, envelope, draft, ws FROM mail_outbox WHERE id = ? AND user_id = ?").get(id, userId) as OutboxRow | undefined;
  return r ? toItem(r) : null;
}

export function outboxOf(userId: string): OutboxItem[] {
  mailDb();
  return (sql("SELECT id, user_id, account_id, send_at, state, error, envelope, draft, ws FROM mail_outbox WHERE user_id = ? ORDER BY send_at").all(userId) as unknown as OutboxRow[]).map(toItem);
}

/** Undo send / cancel a scheduled message: the draft comes back, or null when it already left. */
export function cancelSend(userId: string, id: string): Draft | null {
  const r = sql("SELECT draft FROM mail_outbox WHERE id = ? AND user_id = ? AND state IN ('queued', 'failed')").get(id, userId) as { draft: string } | undefined;
  if (!r) return null;
  const gone = Number(sql("DELETE FROM mail_outbox WHERE id = ? AND user_id = ? AND state IN ('queued', 'failed')").run(id, userId).changes);
  if (!gone) return null;
  try {
    const d = JSON.parse(r.draft) as Draft;
    saveDraft(userId, d.id, d);
    return d;
  } catch {
    return null;
  }
}

/** A failed message tries again now. */
export function retrySend(userId: string, id: string): boolean {
  const ok = Number(sql("UPDATE mail_outbox SET state = 'queued', error = NULL, send_at = ? WHERE id = ? AND user_id = ? AND state = 'failed'").run(Date.now(), id, userId).changes) > 0;
  if (ok) scheduleSend(id, Date.now());
  return ok;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Sends right at its time (the 5-second clock catches anything a timer missed, e.g. after a restart). */
function scheduleSend(id: string, at: number): void {
  const wait = at - Date.now();
  if (wait > 6 * 3600_000) return;
  clearTimeout(timers.get(id));
  const t = setTimeout(() => {
    timers.delete(id);
    void sendOne(id).catch(() => undefined);
  }, Math.max(0, wait) + 30);
  (t as { unref?: () => void }).unref?.();
  timers.set(id, t);
}

/** Every message whose time has come (the clock). */
export async function sendDue(now = Date.now()): Promise<number> {
  mailDb();
  // A message stuck "sending" (the server stopped mid-send) waits for a person: it may have left.
  const due = sql("SELECT id FROM mail_outbox WHERE state = 'queued' AND send_at <= ? ORDER BY send_at LIMIT 20").all(now) as { id: string }[];
  let n = 0;
  for (const r of due) if (await sendOne(r.id)) n++;
  return n;
}

/** The zvena links in what a person sends, as links of the conversation in the workspace they wrote from. */
function linkSent(userId: string, ws: string | null, threadId: string, msgId: string, d: Draft): void {
  if (!ws || !roleIn(userId, ws)) return;
  let ctx = null;
  try {
    ctx = ctxFor(userId, ws, "read");
  } catch {
    ctx = null;
  }
  const o = origins();
  const found = d.blocks?.length ? refsInNote({ content: d.blocks }, o) : [];
  const hrefs = [...d.html.matchAll(/href="([^"]{1,2000})"/g)].map((m) => `[](${m[1].replace(/&amp;/g, "&")})`).join(" ");
  found.push(...refsInMarkdown(hrefs, o));
  // Mentions of people point at members; the conversation stays its owner's (cards show it to nobody else).
  setDerived(ws, `mail:${threadId}`, `m:${msgId}`, resolveTargets(ws, found, ctx), userId);
}

async function sendOne(id: string): Promise<boolean> {
  const claimed = Number(sql("UPDATE mail_outbox SET state = 'sending' WHERE id = ? AND state = 'queued'").run(id).changes);
  if (!claimed) return false;
  const row = sql("SELECT id, user_id, account_id, raw, copy, envelope, draft, ws FROM mail_outbox WHERE id = ?").get(id) as
    | { id: string; user_id: string; account_id: string; raw: Uint8Array; copy: Uint8Array | null; envelope: string; draft: string; ws: string | null }
    | undefined;
  if (!row) return false;
  const acct = accountById(row.account_id);
  if (!acct || acct.user_id !== row.user_id) {
    sql("DELETE FROM mail_outbox WHERE id = ?").run(id);
    return false;
  }
  const env = { ...(JSON.parse(row.envelope) as Built["envelope"] & { msgid: string; inReplyTo: string; references: string[] }), copy: Buffer.from(row.copy ?? row.raw).toString("base64") };
  const d = JSON.parse(row.draft) as Draft;
  try {
    const t = await smtpTransport(acct);
    try {
      await t.sendMail({ envelope: { from: env.from, to: env.to }, raw: Buffer.from(row.raw) });
    } finally {
      t.close();
    }
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    sql("UPDATE mail_outbox SET state = 'failed', error = ? WHERE id = ?").run(code === "EAUTH" ? "auth" : code === "EENVELOPE" ? "refused" : failureOf(e).error, id);
    mailChanged(acct.user_id, acct.id);
    return false;
  }
  // It left: whatever happens next, it never leaves twice.
  sql("DELETE FROM mail_outbox WHERE id = ?").run(id);
  try {
    afterSent(acct, row.ws, env, d);
  } catch (e) {
    console.error(`[mail] after-send upkeep failed (${e instanceof Error ? e.name : "error"})`);
  }
  mailChanged(acct.user_id, acct.id, 0);
  return true;
}

function afterSent(acct: AccountRow, ws: string | null, env: { msgid: string; inReplyTo: string; references: string[]; copy: string; to: string[] }, d: Draft): void {
  const userId = acct.user_id;
  // The local copy in Sent, so the conversation shows the reply at once (the sync later gives it its UID).
  const home = acct.gmail === 1 ? folderByRole(acct.id, "all") : folderByRole(acct.id, "sent");
  const local = upsertMessage(userId, {
    accountId: acct.id,
    folder: home?.path ?? "Sent",
    uid: placeholderUid(),
    msgid: env.msgid,
    inReplyTo: env.inReplyTo,
    references: env.references,
    subject: d.subject,
    from: { name: acct.name, address: acct.email },
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    replyTo: [],
    date: Date.now(),
    boxes: BOX.sent,
    seen: true,
    flagged: false,
    answered: false,
    size: Math.floor((env.copy.length * 3) / 4),
    unsubscribe: "",
    attachments: d.attachments.map((a, i) => ({ part: String(i + 2), filename: a.filename, type: a.type, size: a.size, inline: false })),
    labels: [],
    text: d.html ? htmlToPlain(d.html) : "",
    html: d.html,
  });
  if (acct.saves_sent !== 1) enqueueOp(acct.id, "append", [], { items: [], toRole: "sent", raw: env.copy, flags: ["\\Seen"] });
  if (d.replyTo && d.mode !== "forward") {
    const parent = ownMessage(userId, d.replyTo);
    if (parent) {
      sql("UPDATE mail_messages SET answered = 1 WHERE id = ?").run(parent.id);
      enqueueOp(acct.id, "flags", [parent.id], { items: [{ id: parent.id, folder: parent.folder, uid: Number(parent.uid) }], add: ["\\Answered"] });
    }
  }
  try {
    linkSent(userId, ws, local.threadId, local.id, d);
  } catch {
    // Links are a convenience: the message left either way.
  }
  void dropUploads(userId, d.attachments.map((a) => a.id));
}

/** Files attached to a sent message are not kept. */
export async function dropUploads(userId: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    const gone = tx(() => Number(sql("DELETE FROM mail_uploads WHERE id = ? AND user_id = ?").run(id, userId).changes));
    if (gone) await rm(join(uploadsDir(), userId, id), { force: true }).catch(() => undefined);
  }
}
