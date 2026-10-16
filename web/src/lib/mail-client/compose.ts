// Server-only: what the composer wrote, checked and turned into a MIME
// message (nodemailer's MailComposer). The same builder makes the copy that
// is sent, the copy filed in Sent (with Bcc) and the drafts kept in the
// server's Drafts folder.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import MailComposer from "nodemailer/lib/mail-composer";
import { config } from "../config";
import { sql } from "../store";
import { htmlToPlain, sanitizeHtml } from "./sanitize";
import { cleanMsgId, replyReferences } from "./threading";
import { ownMessage, type AccountRow } from "./store";
import type { Addr, Draft, DraftAttachment } from "./types";

export const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[^\s@<>"',;.]{2,24}$/;
export const MAX_RECIPIENTS = 100;
/** Attachments of one message, together (most providers refuse more than 25 MB). */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 ** 2;
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

export class ComposeError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

export function uploadsDir(): string {
  return join(process.env.ZVENA_FILES_DIR || "/var/lib/zvena/files", "mail-uploads");
}

function cleanAddrs(v: unknown): Addr[] {
  if (!Array.isArray(v)) return [];
  const out: Addr[] = [];
  for (const a of v.slice(0, MAX_RECIPIENTS + 1)) {
    const address = typeof a === "string" ? a.trim() : a && typeof a === "object" && typeof (a as Addr).address === "string" ? (a as Addr).address.trim() : "";
    const name = a && typeof a === "object" && typeof (a as Addr).name === "string" ? (a as Addr).name.replace(/[\r\n"<>]+/g, " ").trim().slice(0, 120) : "";
    if (!address) continue;
    if (!EMAIL_RE.test(address)) throw new ComposeError(400, "bad address");
    if (!out.some((x) => x.address.toLowerCase() === address.toLowerCase())) out.push({ name, address });
  }
  return out;
}

function cleanAttachments(v: unknown): DraftAttachment[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((a): a is DraftAttachment => !!a && typeof a === "object" && typeof (a as DraftAttachment).id === "string" && ID_RE.test((a as DraftAttachment).id))
    .slice(0, 40)
    .map((a) => ({ id: a.id, filename: String(a.filename ?? "").slice(0, 200), type: String(a.type ?? "application/octet-stream").slice(0, 120), size: Number(a.size) || 0 }));
}

/** Outgoing HTML: the same allow-list as received mail; https images stay as written (the recipient's client decides). */
export function cleanOutgoingHtml(html: string): string {
  return sanitizeHtml(html.slice(0, 2_000_000), { images: true, proxy: (u) => (u.startsWith("https://") ? u : null) }).html;
}

/** A draft from untrusted JSON (the composer). */
export function cleanDraft(v: unknown, id: string): Draft {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const mode = r.mode === "reply" || r.mode === "replyAll" || r.mode === "forward" ? r.mode : "new";
  const d: Draft = {
    id,
    accountId: typeof r.accountId === "string" && ID_RE.test(r.accountId) ? r.accountId : "",
    to: cleanAddrs(r.to),
    cc: cleanAddrs(r.cc),
    bcc: cleanAddrs(r.bcc),
    subject: typeof r.subject === "string" ? r.subject.replace(/[\r\n]+/g, " ").slice(0, 500) : "",
    html: typeof r.html === "string" ? cleanOutgoingHtml(r.html) : "",
    attachments: cleanAttachments(r.attachments),
    mode,
    updatedAt: Date.now(),
  };
  if (Array.isArray(r.blocks) && JSON.stringify(r.blocks).length <= 1_000_000) d.blocks = r.blocks;
  if (typeof r.replyTo === "string" && ID_RE.test(r.replyTo)) d.replyTo = r.replyTo;
  if (typeof r.threadId === "string" && ID_RE.test(r.threadId)) d.threadId = r.threadId;
  if (d.to.length + d.cc.length + d.bcc.length > MAX_RECIPIENTS) throw new ComposeError(400, "too many recipients");
  return d;
}

/** A new Message-ID on the sender's domain. */
export function newMessageId(email: string): string {
  const own = new URL(config.appUrl).hostname;
  const domain = (email.split("@")[1] ?? own).replace(/[^a-z0-9.-]/gi, "") || own;
  return `${randomBytes(12).toString("base64url")}.zvena@${domain}`;
}

export interface Built {
  /** As sent (no Bcc header). */
  raw: Buffer;
  /** For Sent and Drafts (with Bcc). */
  copy: Buffer;
  msgid: string;
  inReplyTo: string;
  references: string[];
  envelope: { from: string; to: string[] };
  text: string;
}

async function nodeBuffer(mail: ConstructorParameters<typeof MailComposer>[0], keepBcc: boolean): Promise<Buffer> {
  const node = new MailComposer(mail).compile() as ReturnType<MailComposer["compile"]> & { keepBcc: boolean };
  node.keepBcc = keepBcc;
  return new Promise((resolve, reject) => node.build((err, buf) => (err ? reject(err) : resolve(buf))));
}

/**
 * The MIME message of a draft. Attachments come from the person's uploads
 * (`attachments`) and, when forwarding, from the original (`forwarded`,
 * already downloaded); their total is capped.
 */
export async function buildMessage(
  userId: string,
  acct: AccountRow,
  senderName: string,
  d: Draft,
  opts: { msgid?: string; forwarded?: { filename: string; type: string; content: Buffer }[]; date?: Date } = {}
): Promise<Built> {
  const msgid = opts.msgid ?? newMessageId(acct.email);
  let inReplyTo = "";
  let references: string[] = [];
  if (d.replyTo && d.mode !== "forward") {
    const parent = ownMessage(userId, d.replyTo);
    if (parent) {
      inReplyTo = cleanMsgId(parent.msgid);
      references = replyReferences({ msgid: parent.msgid, references: parent.refs.split(" ").filter(Boolean) });
    }
  }
  const files: { filename: string; contentType: string; content: Buffer }[] = [];
  let total = 0;
  for (const a of d.attachments) {
    const up = sql("SELECT id, filename, type, size FROM mail_uploads WHERE id = ? AND user_id = ?").get(a.id, userId) as { id: string; filename: string; type: string; size: number } | undefined;
    if (!up) continue;
    total += Number(up.size);
    if (total > MAX_ATTACHMENTS_BYTES) throw new ComposeError(413, "attachments too big");
    files.push({ filename: up.filename, contentType: up.type, content: await readFile(join(uploadsDir(), userId, up.id)) });
  }
  for (const f of opts.forwarded ?? []) {
    total += f.content.length;
    if (total > MAX_ATTACHMENTS_BYTES) throw new ComposeError(413, "attachments too big");
    files.push({ filename: f.filename, contentType: f.type, content: f.content });
  }
  const text = htmlToPlain(d.html);
  const from = { name: senderName.replace(/[\r\n"<>]+/g, " ").trim(), address: acct.email };
  const mail = {
    from,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    html: d.html ? `<!doctype html><html><head><meta charset="utf-8"></head><body>${d.html}</body></html>` : undefined,
    text,
    messageId: `<${msgid}>`,
    date: opts.date ?? new Date(),
    ...(inReplyTo ? { inReplyTo: `<${inReplyTo}>` } : {}),
    ...(references.length ? { references: references.map((r) => `<${r}>`).join(" ") } : {}),
    attachments: files,
    headers: { "X-Mailer": "zvena Mail" },
  };
  const [raw, copy] = await Promise.all([nodeBuffer(mail, false), nodeBuffer(mail, true)]);
  const rcpt = [...new Set([...d.to, ...d.cc, ...d.bcc].map((a) => a.address))];
  return { raw, copy, msgid, inReplyTo, references, envelope: { from: acct.email, to: rcpt }, text };
}
