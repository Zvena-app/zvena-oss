// Server-only: Mail's rows — accounts, folders, messages and conversations,
// labels, the full-text index — read and written for one owner at a time.
// Every reader takes the owner's user id and never returns another person's
// row; the API (app/api/mail) passes the signed-in person, the sync worker
// the account's owner.

import { newId, sql, tx } from "../store";
import { mailDb } from "./schema";
import { snippetOf } from "./sanitize";
import { baseSubject, cleanMsgId, threadKeys } from "./threading";
import { BOX, compileFilter, type Matchable, type ViewFilter, ftsOwner } from "./views";
import type { Addr, MailAccount, MailAttachment, MailLabel, MailMessage, MailThread, ThreadSummary } from "./types";

// --- Accounts ----------------------------------------------------------------------

export interface AccountRow {
  id: string;
  user_id: string;
  email: string;
  name: string;
  provider: string;
  auth: string;
  username: string;
  secret: string;
  imap_host: string;
  imap_port: number;
  imap_tls: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: string;
  saves_sent: number;
  gmail: number;
  signature: string;
  color: string;
  state: string;
  error: string | null;
  synced_at: number | null;
  position: number;
  created_at: number;
}

/** An account as the browser sees it (never the secret). */
export function publicAccount(a: AccountRow): MailAccount {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    provider: a.provider,
    state: a.state,
    ...(a.error ? { error: a.error } : {}),
    ...(a.synced_at ? { syncedAt: Number(a.synced_at) } : {}),
    signature: a.signature,
    color: a.color,
    gmail: a.gmail === 1,
    imap: { host: a.imap_host, port: Number(a.imap_port), security: a.imap_tls },
    smtp: { host: a.smtp_host, port: Number(a.smtp_port), security: a.smtp_tls },
  };
}

export function accountsOf(userId: string): AccountRow[] {
  mailDb();
  return sql("SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY position, created_at").all(userId) as unknown as AccountRow[];
}

/** The person's own account, or null (another person's account is "not there"). */
export function ownAccount(userId: string, id: unknown): AccountRow | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) return null;
  mailDb();
  return (sql("SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?").get(id, userId) as unknown as AccountRow | undefined) ?? null;
}

/** For the worker: an account by id, whoever owns it. */
export function accountById(id: string): AccountRow | null {
  mailDb();
  return (sql("SELECT * FROM mail_accounts WHERE id = ?").get(id) as unknown as AccountRow | undefined) ?? null;
}

export function setAccountState(id: string, state: string, error: string | null = null, syncedAt?: number): void {
  if (syncedAt) sql("UPDATE mail_accounts SET state = ?, error = ?, synced_at = ? WHERE id = ?").run(state, error, syncedAt, id);
  else sql("UPDATE mail_accounts SET state = ?, error = ? WHERE id = ?").run(state, error, id);
}

/** The person's own addresses (their messages show as "me"). */
export function myAddresses(userId: string): Set<string> {
  return new Set(accountsOf(userId).map((a) => a.email.toLowerCase()));
}

// --- Folders -----------------------------------------------------------------------

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "spam" | "archive" | "all" | "flagged" | "important";

export interface FolderRow {
  account_id: string;
  path: string;
  name: string;
  delimiter: string;
  role: FolderRole | null;
  uidvalidity: string | null;
  last_uid: number;
  modseq: string | null;
  synced_at: number | null;
}

export function foldersOf(accountId: string): FolderRow[] {
  mailDb();
  return sql("SELECT * FROM mail_folders WHERE account_id = ? ORDER BY path").all(accountId) as unknown as FolderRow[];
}

export function folderByRole(accountId: string, role: FolderRole): FolderRow | null {
  return (sql("SELECT * FROM mail_folders WHERE account_id = ? AND role = ? ORDER BY length(path) LIMIT 1").get(accountId, role) as unknown as FolderRow | undefined) ?? null;
}

export function upsertFolder(accountId: string, f: { path: string; name: string; delimiter: string; role: FolderRole | null }): void {
  sql(
    "INSERT INTO mail_folders (account_id, path, name, delimiter, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, delimiter = excluded.delimiter, role = excluded.role"
  ).run(accountId, f.path, f.name, f.delimiter, f.role);
}

/** A folder that is gone from the server: its messages go too. */
export function dropFolder(accountId: string, path: string): void {
  tx(() => {
    sql("DELETE FROM mail_messages WHERE account_id = ? AND folder = ?").run(accountId, path);
    sql("DELETE FROM mail_labels WHERE account_id = ? AND kind = 'folder' AND path = ?").run(accountId, path);
    sql("DELETE FROM mail_folders WHERE account_id = ? AND path = ?").run(accountId, path);
  });
}

export function setFolderSync(accountId: string, path: string, v: { uidvalidity?: string; lastUid?: number; modseq?: string | null }): void {
  if (v.uidvalidity !== undefined) sql("UPDATE mail_folders SET uidvalidity = ? WHERE account_id = ? AND path = ?").run(v.uidvalidity, accountId, path);
  if (v.lastUid !== undefined) sql("UPDATE mail_folders SET last_uid = ? WHERE account_id = ? AND path = ?").run(v.lastUid, accountId, path);
  if (v.modseq !== undefined) sql("UPDATE mail_folders SET modseq = ? WHERE account_id = ? AND path = ?").run(v.modseq, accountId, path);
  sql("UPDATE mail_folders SET synced_at = ? WHERE account_id = ? AND path = ?").run(Date.now(), accountId, path);
}

// --- Labels ------------------------------------------------------------------------

interface LabelRow {
  id: string;
  user_id: string;
  account_id: string | null;
  kind: "folder" | "gmail" | "manual";
  path: string;
  name: string;
  color: string;
  position: number;
}

const toLabel = (r: LabelRow): MailLabel => ({ id: r.id, accountId: r.account_id, kind: r.kind, name: r.name, color: r.color });

export function labelsOf(userId: string): MailLabel[] {
  mailDb();
  return (sql("SELECT * FROM mail_labels WHERE user_id = ? ORDER BY kind = 'manual' DESC, position, lower(name)").all(userId) as unknown as LabelRow[]).map(toLabel);
}

export function ownLabel(userId: string, id: unknown): LabelRow | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) return null;
  return (sql("SELECT * FROM mail_labels WHERE id = ? AND user_id = ?").get(id, userId) as unknown as LabelRow | undefined) ?? null;
}

/** The label of an IMAP folder or Gmail label (made on first sight). */
export function ensureLabel(userId: string, accountId: string, kind: "folder" | "gmail", path: string, name: string): string {
  const hit = sql("SELECT id FROM mail_labels WHERE user_id = ? AND IFNULL(account_id, '') = ? AND kind = ? AND path = ?").get(userId, accountId, kind, path) as { id: string } | undefined;
  if (hit) return hit.id;
  const id = newId(12);
  sql("INSERT INTO mail_labels (id, user_id, account_id, kind, path, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, userId, accountId, kind, path, name.slice(0, 120), Date.now());
  return id;
}

export function createManualLabel(userId: string, name: string, color: string): MailLabel {
  mailDb();
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
  const path = clean.toLowerCase();
  const hit = sql("SELECT * FROM mail_labels WHERE user_id = ? AND account_id IS NULL AND kind = 'manual' AND path = ?").get(userId, path) as unknown as LabelRow | undefined;
  if (hit) return toLabel(hit);
  const id = newId(12);
  const pos = Number((sql("SELECT COUNT(*) AS n FROM mail_labels WHERE user_id = ? AND kind = 'manual'").get(userId) as { n: number }).n);
  sql("INSERT INTO mail_labels (id, user_id, account_id, kind, path, name, color, position, created_at) VALUES (?, ?, NULL, 'manual', ?, ?, ?, ?, ?)").run(id, userId, path, clean, color, pos, Date.now());
  return { id, accountId: null, kind: "manual", name: clean, color };
}

export function updateManualLabel(userId: string, id: string, v: { name?: string; color?: string }): boolean {
  const l = ownLabel(userId, id);
  if (!l || l.kind !== "manual") return false;
  const name = v.name?.replace(/\s+/g, " ").trim().slice(0, 80) || l.name;
  sql("UPDATE mail_labels SET name = ?, path = ?, color = ? WHERE id = ?").run(name, name.toLowerCase(), v.color ?? l.color, id);
  return true;
}

export function deleteManualLabel(userId: string, id: string): boolean {
  const l = ownLabel(userId, id);
  if (!l || l.kind !== "manual") return false;
  sql("DELETE FROM mail_labels WHERE id = ?").run(id);
  return true;
}

// --- Messages ----------------------------------------------------------------------

export interface MessageRow {
  n: number;
  id: string;
  user_id: string;
  account_id: string;
  folder: string;
  uid: number;
  msgid: string;
  in_reply_to: string;
  refs: string;
  thread_id: string;
  gm_msgid: string | null;
  subject: string;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to: string;
  date: number;
  snippet: string;
  boxes: number;
  seen: number;
  flagged: number;
  answered: number;
  has_att: number;
  size: number;
  unsubscribe: string;
  body: number;
  text: string | null;
  html: string | null;
  body_bytes: number;
  text_part: string | null;
  html_part: string | null;
  snoozed_until: number | null;
  bumped_at: number | null;
  created_at: number;
}

export interface AttachmentMeta {
  part: string;
  filename: string;
  type: string;
  size: number;
  cid?: string;
  inline: boolean;
}

/** A message as the sync (or the outbox) found it. */
export interface IncomingMessage {
  accountId: string;
  folder: string;
  /** The IMAP UID; below 0 for a local copy not on the server yet. */
  uid: number;
  msgid: string;
  inReplyTo: string;
  references: string[];
  gmMsgid?: string | null;
  gmThread?: string | null;
  subject: string;
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  replyTo: Addr[];
  date: number;
  boxes: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  size: number;
  unsubscribe: string;
  attachments: AttachmentMeta[];
  /** Labels of the folder or Gmail labels (kind + path + name). */
  labels: { kind: "folder" | "gmail"; path: string; name: string }[];
  textPart?: string | null;
  htmlPart?: string | null;
  /** Known text (a message zvena sent: its own copy). */
  text?: string;
  html?: string;
}

const addrJson = (list: Addr[]) => JSON.stringify(list.slice(0, 200).map((a) => ({ name: a.name.slice(0, 200), address: a.address.slice(0, 320) })));

function parseAddrs(s: string): Addr[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((a): a is Addr => !!a && typeof a === "object" && typeof (a as Addr).address === "string").map((a) => ({ name: String(a.name ?? ""), address: a.address })) : [];
  } catch {
    return [];
  }
}

const people = (list: Addr[]) => list.map((a) => `${a.name} ${a.address}`).join(" ");

let lastPlaceholder = 0;

/**
 * A negative UID for a copy that is not on the server yet: strictly
 * decreasing in this process (a bulk move gives every row its own), and it
 * tells when it was made (-ms × 1000), so old ones can be swept.
 */
export function placeholderUid(): number {
  lastPlaceholder = Math.min(lastPlaceholder - 1, -(Date.now() * 1000));
  return lastPlaceholder;
}

/** When a placeholder UID was made (ms). */
export function placeholderAge(uid: number, now = Date.now()): number {
  return now - Math.floor(-uid / 1000);
}

/** Conversations one message may merge (a crafted References header could otherwise sew a mailbox together). */
const MAX_MERGE = 5;

const sameSubject = (a: string, b: string) => baseSubject(a).toLocaleLowerCase() === baseSubject(b).toLocaleLowerCase();

/**
 * The conversation for a new message: it joins the ones it names or that
 * name it, and merges them when it links several. References are written by
 * the sender, so a conversation is only joined or merged on them when its
 * subject matches (Gmail does the same); the message it answers directly
 * (In-Reply-To), Gmail's own thread id and copies of the same message are
 * trusted as they are.
 */
function threadFor(accountId: string, userId: string, m: { subject: string; inReplyTo: string }, keys: { own: string[]; refs: string[] }): string {
  const names = [...new Set([...keys.own, ...keys.refs])];
  if (!names.length) return newId(12);
  const found = sql(
    `SELECT DISTINCT thread_id AS t, msgid AS via, 1 AS direct FROM mail_messages WHERE account_id = ? AND msgid IN (SELECT value FROM json_each(?))
     UNION SELECT DISTINCT m.thread_id, r.ref, 0 FROM mail_refs r JOIN mail_messages m ON m.n = r.message_n WHERE r.account_id = ? AND r.ref IN (SELECT value FROM json_each(?))`
  ).all(accountId, JSON.stringify(names), accountId, JSON.stringify(names)) as { t: string; via: string; direct: number }[];
  if (!found.length) return newId(12);
  // Trusted: another copy of this very message, the message it answers, Gmail's thread. Not: a message
  // that merely claims to answer this one (anyone can write that header before this one arrives).
  const trusted = (r: { via: string; direct: number }) =>
    r.via.startsWith("gm:") || (r.direct === 1 && (keys.own.includes(r.via) || (Boolean(m.inReplyTo) && r.via === cleanMsgId(m.inReplyTo))));
  const threads = [...new Set(found.map((r) => r.t))];
  const info = new Map(
    (sql("SELECT thread_id AS t, MIN(date) AS d, (SELECT subject FROM mail_messages s WHERE s.thread_id = x.thread_id ORDER BY s.date LIMIT 1) AS subject FROM mail_messages x WHERE thread_id IN (SELECT value FROM json_each(?)) GROUP BY thread_id").all(JSON.stringify(threads)) as {
      t: string;
      d: number;
      subject: string;
    }[]).map((r) => [r.t, r])
  );
  const ok = threads
    .filter((t) => found.some((r) => r.t === t && trusted(r)) || sameSubject(info.get(t)?.subject ?? "", m.subject))
    .sort((a, b) => Number(info.get(a)?.d ?? 0) - Number(info.get(b)?.d ?? 0))
    .slice(0, MAX_MERGE);
  if (!ok.length) return newId(12);
  // Several conversations turn out to be one: they keep the oldest one's id.
  const keep = ok[0];
  for (const t of ok.slice(1)) mergeThread(userId, t, keep);
  return keep;
}

/** Moves every message of conversation `from` into `into`, with the ecosystem's links and notifications about it. */
function mergeThread(userId: string, from: string, into: string): void {
  sql("UPDATE mail_messages SET thread_id = ? WHERE thread_id = ? AND user_id = ?").run(into, from, userId);
  const a = `mail:${from}`;
  const b = `mail:${into}`;
  // Links of a conversation live in its owner's workspaces only: each is looked up by its index (ws_id first).
  for (const { ws_id: ws } of sql("SELECT ws_id FROM members WHERE user_id = ?").all(userId) as { ws_id: string }[]) {
    sql("UPDATE OR IGNORE eco_links SET src = ? WHERE ws_id = ? AND src = ?").run(b, ws, a);
    sql("UPDATE OR IGNORE eco_links SET dst = ? WHERE ws_id = ? AND dst = ?").run(b, ws, a);
    sql("DELETE FROM eco_links WHERE ws_id = ? AND (src = ? OR dst = ?)").run(ws, a, a);
  }
  sql("UPDATE eco_inbox SET ref = ? WHERE ref = ? AND user_id = ?").run(b, a, userId);
}

function insertAttachments(n: number, userId: string, list: AttachmentMeta[]): void {
  for (const a of list.slice(0, 100))
    sql("INSERT INTO mail_attachments (id, message_n, user_id, part, filename, type, size, cid, inline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      newId(12),
      n,
      userId,
      a.part,
      a.filename.slice(0, 255),
      a.type.slice(0, 120),
      a.size,
      a.cid ?? null,
      a.inline ? 1 : 0
    );
}

function setLabels(userId: string, n: number, accountId: string, labels: IncomingMessage["labels"]): void {
  // The server's labels of this mailbox are replaced; zvena's own labels stay.
  sql("DELETE FROM mail_message_labels WHERE message_n = ? AND label_id IN (SELECT id FROM mail_labels WHERE account_id = ?)").run(n, accountId);
  for (const l of labels) sql("INSERT OR IGNORE INTO mail_message_labels (message_n, label_id) VALUES (?, ?)").run(n, ensureLabel(userId, accountId, l.kind, l.path, l.name));
}

function indexText(n: number, userId: string, subject: string, ppl: string, body: string): void {
  sql("DELETE FROM mail_fts WHERE rowid = ?").run(n);
  sql("INSERT INTO mail_fts (rowid, owner, subject, people, body) VALUES (?, ?, ?, ?, ?)").run(n, ftsOwner(userId), subject, ppl, body.slice(0, 100_000));
}

function touchContacts(userId: string, list: Addr[], field: "sent" | "received", at: number, mine: Set<string>): void {
  for (const a of list.slice(0, 50)) {
    const email = a.address.trim().toLowerCase();
    if (!email || !email.includes("@") || mine.has(email) || email.length > 320) continue;
    sql(
      `INSERT INTO mail_contacts (user_id, email, name, ${field}, last_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id, email) DO UPDATE SET ${field} = ${field} + 1, name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END, last_at = MAX(last_at, excluded.last_at)`
    ).run(userId, email, a.name.slice(0, 200), at);
  }
}

/**
 * Stores a message (new or seen again): flags and where it is are refreshed;
 * a new one is threaded, indexed and its people remembered. `keepFlags`:
 * the person changed this message and the change has not reached the
 * server yet, so the server's old flags must not undo it.
 */
export function upsertMessage(userId: string, m: IncomingMessage, keepFlags: (id: string) => boolean = () => false): { n: number; id: string; threadId: string; isNew: boolean } {
  return tx(() => {
    let row = sql("SELECT n, id, thread_id FROM mail_messages WHERE account_id = ? AND folder = ? AND uid = ?").get(m.accountId, m.folder, m.uid) as { n: number; id: string; thread_id: string } | undefined;
    if (!row && m.uid > 0 && m.msgid) {
      // A local copy (moved, sent) waiting for its UID: this is it.
      const local = sql("SELECT n, id, thread_id FROM mail_messages WHERE account_id = ? AND folder = ? AND uid < 0 AND msgid = ? ORDER BY n LIMIT 1").get(m.accountId, m.folder, m.msgid) as
        | { n: number; id: string; thread_id: string }
        | undefined;
      if (local) {
        // The server's copy decides its parts (attachments are fetched from it).
        sql("UPDATE mail_messages SET uid = ?, text_part = ?, html_part = ?, size = ? WHERE n = ?").run(m.uid, m.textPart ?? null, m.htmlPart ?? null, m.size, local.n);
        sql("DELETE FROM mail_attachments WHERE message_n = ?").run(local.n);
        insertAttachments(Number(local.n), userId, m.attachments);
        row = local;
      }
    }
    if (row) {
      if (!keepFlags(row.id)) sql("UPDATE mail_messages SET seen = ?, flagged = ?, answered = ?, boxes = ? WHERE n = ?").run(m.seen ? 1 : 0, m.flagged ? 1 : 0, m.answered ? 1 : 0, m.boxes, row.n);
      if (!keepFlags(row.id)) setLabels(userId, row.n, m.accountId, m.labels);
      return { n: Number(row.n), id: row.id, threadId: row.thread_id, isNew: false };
    }
    const threadId = threadFor(m.accountId, userId, m, threadKeys({ msgid: m.msgid, inReplyTo: m.inReplyTo, references: m.references, gmThread: m.gmThread }));
    const id = newId(12);
    const now = Date.now();
    const subject = m.subject.slice(0, 1000);
    const text = m.text ?? null;
    const snippet = text ? snippetOf(text) : "";
    const res = sql(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, msgid, in_reply_to, refs, thread_id, gm_msgid, subject, from_addr, from_name, to_json, cc_json, bcc_json, reply_to,
         date, snippet, boxes, seen, flagged, answered, has_att, size, unsubscribe, body, text, html, body_bytes, text_part, html_part, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      m.accountId,
      m.folder,
      m.uid,
      m.msgid,
      m.inReplyTo,
      m.references.join(" "),
      threadId,
      m.gmMsgid ?? null,
      subject,
      (m.from?.address ?? "").slice(0, 320),
      (m.from?.name ?? "").slice(0, 200),
      addrJson(m.to),
      addrJson(m.cc),
      addrJson(m.bcc),
      addrJson(m.replyTo),
      m.date,
      snippet,
      m.boxes,
      m.seen ? 1 : 0,
      m.flagged ? 1 : 0,
      m.answered ? 1 : 0,
      m.attachments.some((a) => !a.inline) ? 1 : 0,
      m.size,
      m.unsubscribe.slice(0, 2000),
      text !== null ? 1 : 0,
      text,
      m.html ?? null,
      (text?.length ?? 0) + (m.html?.length ?? 0),
      m.textPart ?? null,
      m.htmlPart ?? null,
      now
    );
    const n = Number(res.lastInsertRowid);
    const keys = threadKeys({ msgid: m.msgid, inReplyTo: m.inReplyTo, references: m.references, gmThread: m.gmThread });
    for (const r of keys.refs) sql("INSERT OR IGNORE INTO mail_refs (account_id, ref, message_n) VALUES (?, ?, ?)").run(m.accountId, r, n);
    insertAttachments(n, userId, m.attachments);
    setLabels(userId, n, m.accountId, m.labels);
    indexText(n, userId, subject, `${m.from?.name ?? ""} ${m.from?.address ?? ""} ${people(m.to)} ${people(m.cc)}`, text ?? "");
    const mine = myAddresses(userId);
    if (m.boxes & BOX.sent) touchContacts(userId, [...m.to, ...m.cc, ...m.bcc], "sent", m.date, mine);
    else if (m.from && (m.boxes & (BOX.spam | BOX.trash)) === 0) touchContacts(userId, [m.from], "received", m.date, mine);
    return { n, id, threadId, isNew: true };
  });
}

/** The text of a message, once fetched (for search, snippets, quoting). */
export function setBody(n: number, v: { text: string; html: string | null } | null): void {
  if (!v) {
    sql("UPDATE mail_messages SET body = 2 WHERE n = ?").run(n);
    return;
  }
  const r = sql("SELECT user_id, subject, from_name, from_addr, to_json, cc_json FROM mail_messages WHERE n = ?").get(n) as { user_id: string; subject: string; from_name: string; from_addr: string; to_json: string; cc_json: string } | undefined;
  if (!r) return;
  tx(() => {
    sql("UPDATE mail_messages SET body = 1, text = ?, html = ?, body_bytes = ?, snippet = ? WHERE n = ?").run(v.text, v.html, v.text.length + (v.html?.length ?? 0), snippetOf(v.text), n);
    indexText(n, r.user_id, r.subject, `${r.from_name} ${r.from_addr} ${people(parseAddrs(r.to_json))} ${people(parseAddrs(r.cc_json))}`, v.text);
  });
}

export function messageRowByN(n: number): MessageRow | null {
  return (sql("SELECT * FROM mail_messages WHERE n = ?").get(n) as unknown as MessageRow | undefined) ?? null;
}

/** The person's own message, or null. */
export function ownMessage(userId: string, id: unknown): MessageRow | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) return null;
  mailDb();
  return (sql("SELECT * FROM mail_messages WHERE id = ? AND user_id = ?").get(id, userId) as unknown as MessageRow | undefined) ?? null;
}

/** The owner of a conversation (the ecosystem's cards and pulse filter ask), or null. */
export function threadOwner(threadId: string): string | null {
  mailDb();
  return (sql("SELECT user_id FROM mail_messages WHERE thread_id = ? LIMIT 1").get(threadId) as { user_id: string } | undefined)?.user_id ?? null;
}

/** The person's own conversations among `ids` (others' are left out): subject, the latest sender, when. */
export function threadBriefs(userId: string, ids: readonly string[]): { id: string; subject: string; from: string; at: number }[] {
  if (!ids.length) return [];
  mailDb();
  const rows = sql(
    `SELECT m.thread_id AS id, MAX(m.date) AS at,
       (SELECT s.subject FROM mail_messages s WHERE s.thread_id = m.thread_id AND s.user_id = m.user_id ORDER BY s.date LIMIT 1) AS subject,
       (SELECT CASE WHEN l.from_name != '' THEN l.from_name ELSE l.from_addr END FROM mail_messages l WHERE l.thread_id = m.thread_id AND l.user_id = m.user_id ORDER BY l.date DESC LIMIT 1) AS who
     FROM mail_messages m WHERE m.user_id = ? AND m.thread_id IN (SELECT value FROM json_each(?)) GROUP BY m.thread_id`
  ).all(userId, JSON.stringify(ids.slice(0, 300))) as { id: string; at: number; subject: string | null; who: string | null }[];
  return rows.map((r) => ({ id: r.id, subject: baseSubject(r.subject ?? "") || (r.subject ?? ""), from: r.who ?? "", at: Number(r.at) }));
}

/** Messages of the person's conversations (ids of threads the person owns only). */
export function messagesOfThreads(userId: string, threadIds: readonly string[]): MessageRow[] {
  if (!threadIds.length) return [];
  return sql("SELECT * FROM mail_messages WHERE user_id = ? AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY date").all(userId, JSON.stringify(threadIds.slice(0, 500))) as unknown as MessageRow[];
}

/** The person's messages by id (others' ids are skipped). */
export function ownMessages(userId: string, ids: readonly string[]): MessageRow[] {
  if (!ids.length) return [];
  return sql("SELECT * FROM mail_messages WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))").all(userId, JSON.stringify(ids.slice(0, 2000))) as unknown as MessageRow[];
}

export function labelIdsOf(ns: readonly number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!ns.length) return out;
  for (const r of sql("SELECT message_n AS n, label_id AS l FROM mail_message_labels WHERE message_n IN (SELECT value FROM json_each(?))").all(JSON.stringify(ns)) as { n: number; l: string }[]) {
    const list = out.get(Number(r.n)) ?? [];
    list.push(r.l);
    out.set(Number(r.n), list);
  }
  return out;
}

export function attachmentsOf(n: number): (MailAttachment & { part: string; cid: string | null })[] {
  return (sql("SELECT id, part, filename, type, size, cid, inline FROM mail_attachments WHERE message_n = ? ORDER BY part").all(n) as { id: string; part: string; filename: string; type: string; size: number; cid: string | null; inline: number }[]).map((a) => ({
    id: a.id,
    part: a.part,
    filename: a.filename,
    type: a.type,
    size: Number(a.size),
    cid: a.cid,
    inline: a.inline === 1,
  }));
}

export function ownAttachment(userId: string, id: unknown): { id: string; part: string; filename: string; type: string; size: number; message_n: number } | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) return null;
  mailDb();
  return (sql("SELECT id, part, filename, type, size, message_n FROM mail_attachments WHERE id = ? AND user_id = ?").get(id, userId) as { id: string; part: string; filename: string; type: string; size: number; message_n: number } | undefined) ?? null;
}

/** The fields a view filter reads, of a stored message (views.ts matches). */
export function matchableOf(r: MessageRow, labels: readonly string[]): Matchable {
  return {
    accountId: r.account_id,
    boxes: Number(r.boxes),
    fromAddr: r.from_addr,
    fromName: r.from_name,
    recipients: `${people(parseAddrs(r.to_json))} ${people(parseAddrs(r.cc_json))}`,
    subject: r.subject,
    text: r.text ?? r.snippet,
    labels,
    seen: r.seen === 1,
    flagged: r.flagged === 1,
    attachment: r.has_att === 1,
    date: Number(r.date),
    snoozedUntil: r.snoozed_until === null ? null : Number(r.snoozed_until),
  };
}

// --- Conversations -----------------------------------------------------------------

/** Conversations with at least one message in the filter, newest first. */
export function listThreads(userId: string, f: ViewFilter, opts: { limit?: number; offset?: number; now?: number; exclude?: ReadonlySet<string> } = {}): { threads: ThreadSummary[]; more: boolean } {
  mailDb();
  const now = opts.now ?? Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const { where, params } = compileFilter(f, now, userId);
  const trashView = f.box === "trash" || f.box === "spam";
  // In the trash, a conversation is what was thrown away; elsewhere thrown-away messages do not count.
  const visible = trashView ? "1 = 1" : `(m.boxes & ${BOX.trash | BOX.spam}) = 0`;
  const rows = sql(
    `SELECT m.thread_id AS t, MAX(MAX(m.date), IFNULL(MAX(m.bumped_at), 0)) AS last
     FROM mail_messages m
     WHERE m.user_id = ? AND m.thread_id IN (SELECT m.thread_id FROM mail_messages m WHERE m.user_id = ? AND ${where}) AND ${visible}
     GROUP BY m.thread_id ORDER BY last DESC, m.thread_id LIMIT ? OFFSET ?`
  ).all(userId, userId, ...params, limit + 1, offset) as { t: string; last: number }[];
  const more = rows.length > limit;
  const ids = rows.slice(0, limit).map((r) => r.t);
  return { threads: summaries(userId, ids, trashView, now, opts.exclude), more };
}

/** How many conversations have a message in the filter (`unread`: an unread one), as the view's list counts them. */
export function countThreads(userId: string, f: ViewFilter, opts: { unread?: boolean; now?: number } = {}): number {
  mailDb();
  const { where, params } = compileFilter(f, opts.now ?? Date.now(), userId);
  const trashView = f.box === "trash" || f.box === "spam";
  const visible = trashView ? "1 = 1" : `(m.boxes & ${BOX.trash | BOX.spam}) = 0`;
  const r = sql(
    `SELECT COUNT(DISTINCT m.thread_id) AS n FROM mail_messages m
     WHERE m.user_id = ? AND ${visible}${opts.unread ? " AND m.seen = 0" : ""} AND m.thread_id IN (SELECT m.thread_id FROM mail_messages m WHERE m.user_id = ? AND ${where})`
  ).get(userId, userId, ...params) as { n: number };
  return Number(r.n);
}

/** One line of the list for each conversation, in the order given. */
export function summaries(userId: string, threadIds: readonly string[], trashView = false, now = Date.now(), exclude?: ReadonlySet<string>): ThreadSummary[] {
  const msgs = messagesOfThreads(userId, threadIds);
  const labels = labelIdsOf(msgs.map((m) => Number(m.n)));
  const mine = myAddresses(userId);
  const by = new Map<string, MessageRow[]>();
  for (const m of msgs) {
    if (!trashView && Number(m.boxes) & (BOX.trash | BOX.spam)) continue;
    // Server copies of zvena's own drafts: the draft itself is listed instead.
    if (exclude?.has(m.msgid)) continue;
    const list = by.get(m.thread_id) ?? [];
    list.push(m);
    by.set(m.thread_id, list);
  }
  const out: ThreadSummary[] = [];
  for (const t of threadIds) {
    const all = by.get(t);
    if (!all?.length) continue;
    // The same message in two folders counts once.
    const seen = new Set<string>();
    const list = all.filter((m) => {
      const k = m.msgid || m.id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const last = list[list.length - 1];
    const ppl: ThreadSummary["people"] = [];
    for (const m of list) {
      const me = mine.has(m.from_addr.toLowerCase());
      if (!ppl.some((p) => p.address === m.from_addr)) ppl.push({ name: m.from_name, address: m.from_addr, me });
    }
    const snoozed = list.map((m) => (m.snoozed_until ? Number(m.snoozed_until) : 0)).reduce((a, b) => Math.max(a, b), 0);
    const lbl = new Set<string>();
    for (const m of all) for (const l of labels.get(Number(m.n)) ?? []) lbl.add(l);
    out.push({
      id: t,
      subject: baseSubject(list[0].subject) || list[0].subject,
      snippet: last.snippet,
      people: ppl.slice(-6),
      count: list.length,
      unread: list.some((m) => m.seen === 0),
      starred: list.some((m) => m.flagged === 1),
      attachment: list.some((m) => m.has_att === 1),
      draft: list.some((m) => Number(m.boxes) & BOX.drafts),
      at: Math.max(...list.map((m) => Number(m.date)), ...list.map((m) => Number(m.bumped_at ?? 0))),
      snoozedUntil: snoozed > now ? snoozed : null,
      labels: [...lbl],
      accounts: [...new Set(list.map((m) => m.account_id))],
      inbox: all.some((m) => (Number(m.boxes) & BOX.inbox) !== 0 && (Number(m.boxes) & (BOX.trash | BOX.spam)) === 0),
      trash: all.every((m) => (Number(m.boxes) & BOX.trash) !== 0),
      spam: all.every((m) => (Number(m.boxes) & BOX.spam) !== 0),
    });
  }
  return out;
}

export function imagesAllowed(userId: string, sender: string): boolean {
  if (!sender) return false;
  return Boolean(sql("SELECT 1 FROM mail_image_senders WHERE user_id = ? AND sender = ?").get(userId, sender.toLowerCase()));
}

export function allowImages(userId: string, sender: string): void {
  const s = sender.trim().toLowerCase();
  if (s && s.length <= 320) sql("INSERT OR IGNORE INTO mail_image_senders (user_id, sender) VALUES (?, ?)").run(userId, s);
}

export function messageView(userId: string, r: MessageRow, labels: string[], mine: Set<string>, always: boolean): MailMessage {
  const atts = attachmentsOf(Number(r.n));
  return {
    id: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    msgid: r.msgid,
    subject: r.subject,
    from: { name: r.from_name, address: r.from_addr },
    to: parseAddrs(r.to_json),
    cc: parseAddrs(r.cc_json),
    bcc: parseAddrs(r.bcc_json),
    replyTo: parseAddrs(r.reply_to),
    date: Number(r.date),
    snippet: r.snippet,
    seen: r.seen === 1,
    flagged: r.flagged === 1,
    draft: (Number(r.boxes) & BOX.drafts) !== 0,
    trash: (Number(r.boxes) & BOX.trash) !== 0,
    body: r.body === 1 ? "ok" : r.body === 2 ? "error" : "none",
    html: Boolean(r.html) || (r.body !== 1 && Boolean(r.html_part)),
    ...(r.text ? { text: r.text.slice(0, 50_000) } : {}),
    attachments: atts.filter((a) => !a.inline || !a.cid).map((a) => ({ id: a.id, filename: a.filename, type: a.type, size: a.size, inline: a.inline })),
    labels,
    imagesAllowed: always || imagesAllowed(userId, r.from_addr),
    ...(r.unsubscribe ? { unsubscribe: r.unsubscribe } : {}),
    mine: mine.has(r.from_addr.toLowerCase()),
  };
}

/** A conversation as the reading pane shows it, or null when it is not the person's. */
export function threadOf(userId: string, threadId: unknown, always = false): MailThread | null {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9_-]{6,40}$/.test(threadId)) return null;
  mailDb();
  const all = messagesOfThreads(userId, [threadId]);
  if (!all.length) return null;
  // One copy of each message: the one outside the trash, else any.
  const best = new Map<string, MessageRow>();
  for (const m of all) {
    const k = m.msgid || m.id;
    const prev = best.get(k);
    if (!prev || (Number(prev.boxes) & BOX.trash && !(Number(m.boxes) & BOX.trash)) || (prev.uid < 0 && m.uid > 0)) best.set(k, m);
  }
  const list = [...best.values()].sort((a, b) => Number(a.date) - Number(b.date));
  const labels = labelIdsOf(list.map((m) => Number(m.n)));
  const mine = myAddresses(userId);
  const msgs = list.map((m) => messageView(userId, m, labels.get(Number(m.n)) ?? [], mine, always));
  const lbl = new Set<string>();
  for (const m of msgs) for (const l of m.labels) lbl.add(l);
  const snoozed = list.map((m) => Number(m.snoozed_until ?? 0)).reduce((a, b) => Math.max(a, b), 0);
  return { id: threadId, subject: baseSubject(list[0].subject) || list[0].subject, messages: msgs, labels: [...lbl], snoozedUntil: snoozed > Date.now() ? snoozed : null };
}

/** Unread conversations per built-in box (the rail's counts). */
export function unreadCounts(userId: string, now = Date.now()): { inbox: number; spam: number; drafts: number } {
  mailDb();
  const inbox = sql(
    `SELECT COUNT(DISTINCT thread_id) AS n FROM mail_messages WHERE user_id = ? AND seen = 0 AND (boxes & ${BOX.inbox}) != 0 AND (boxes & ${BOX.trash | BOX.spam}) = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?)`
  ).get(userId, now) as { n: number };
  const spam = sql(`SELECT COUNT(DISTINCT thread_id) AS n FROM mail_messages WHERE user_id = ? AND seen = 0 AND (boxes & ${BOX.spam}) != 0`).get(userId) as { n: number };
  const drafts = sql("SELECT COUNT(*) AS n FROM mail_drafts WHERE user_id = ?").get(userId) as { n: number };
  return { inbox: Number(inbox.n), spam: Number(spam.n), drafts: Number(drafts.n) };
}

// --- Bounded storage ---------------------------------------------------------------

/** Mail text kept per person (bytes); older texts are dropped first and fetched again when opened. */
export function bodyQuota(): number {
  const v = Number(process.env.ZVENA_MAIL_BODY_QUOTA_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 512 * 1024 ** 2;
}

/** Drops the oldest texts of a person past the quota; returns how many. */
export function pruneBodies(userId: string, quota = bodyQuota()): number {
  const used = Number((sql("SELECT COALESCE(SUM(body_bytes), 0) AS b FROM mail_messages WHERE user_id = ?").get(userId) as { b: number }).b);
  if (used <= quota) return 0;
  let over = used - quota * 0.9;
  let dropped = 0;
  for (const r of sql("SELECT n, body_bytes FROM mail_messages WHERE user_id = ? AND body_bytes > 0 ORDER BY date LIMIT 2000").all(userId) as { n: number; body_bytes: number }[]) {
    if (over <= 0) break;
    sql("UPDATE mail_messages SET body = 0, text = NULL, html = NULL, body_bytes = 0 WHERE n = ?").run(r.n);
    over -= Number(r.body_bytes);
    dropped++;
  }
  return dropped;
}
