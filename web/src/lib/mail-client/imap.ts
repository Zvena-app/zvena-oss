// Server-only: talking to a mailbox over IMAP (imapflow). Connecting through
// the address guard, finding the folders and what they are for, syncing a
// folder into the store (new mail, flags, what was deleted elsewhere),
// fetching a message's text and attachments when someone opens them, and
// carrying the person's changes (mail_ops) to the server.
//
// Bounded by design: a folder is synced back ZVENA_MAIL_SYNC_DAYS (default
// 90) and at most ZVENA_MAIL_MAX_PER_FOLDER messages (default 2000); texts
// are fetched for the last ZVENA_MAIL_BODY_DAYS (default 30) in the
// background and for anything older when it is opened; attachments stay on
// the mail server until someone downloads one.
//
// Gmail (X-GM-EXT-1) is synced as Gmail sees itself: All Mail, Trash and
// Spam, with labels (\Inbox is the inbox) instead of a copy per label.

import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageStructureObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { Readable } from "node:stream";
import { unseal } from "./crypto";
import { checkEndpoint, resolveEndpoint, tlsOptions } from "./guard";
import { MailAuthError, signIn, type MailSecret } from "./providers";
import { htmlToPlain } from "./sanitize";
import { cleanMsgId, parseIdList } from "./threading";
import { BOX } from "./views";
import { sql } from "../store";
import {
  dropFolder,
  folderByRole,
  foldersOf,
  placeholderAge,
  placeholderUid,
  setBody,
  setFolderSync,
  upsertFolder,
  upsertMessage,
  type AccountRow,
  type AttachmentMeta,
  type FolderRole,
  type FolderRow,
  type IncomingMessage,
} from "./store";
import type { Addr } from "./types";

const int = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
};
export const syncDays = () => int("ZVENA_MAIL_SYNC_DAYS", 90);
export const maxPerFolder = () => int("ZVENA_MAIL_MAX_PER_FOLDER", 2000);
export const bodyDays = () => int("ZVENA_MAIL_BODY_DAYS", 30);
/** The largest text part fetched (bytes); bigger texts show as "too big to show". */
const MAX_TEXT = 2_000_000;
/** Folders synced per account (the rest are listed, not synced). */
const MAX_FOLDERS = 60;

export interface ConnectOptions {
  /** Keep the connection for IDLE (the sync worker) or for one-off commands. */
  idle?: boolean;
}

/** An open, signed-in IMAP connection to the account's server. */
export async function connectImap(acct: Pick<AccountRow, "id" | "user_id" | "auth" | "username" | "secret" | "imap_host" | "imap_port" | "imap_tls">, opts: ConnectOptions = {}): Promise<ImapFlow> {
  const ep = checkEndpoint("imap", acct.imap_host, acct.imap_port, acct.imap_tls);
  const at = await resolveEndpoint(ep.host);
  const secret = unseal<MailSecret>(acct.secret, { accountId: acct.id, userId: acct.user_id });
  const { imap } = await signIn(acct, secret);
  const client = new ImapFlow({
    host: at.address,
    port: ep.port,
    secure: ep.security === "tls",
    ...(at.servername ? { servername: at.servername } : {}),
    doSTARTTLS: ep.security === "starttls" ? true : ep.security === "none" ? false : undefined,
    auth: imap,
    tls: tlsOptions(at.servername),
    logger: false,
    clientInfo: { name: "zvena", vendor: "zvena" },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: opts.idle ? 35 * 60_000 : 120_000,
    maxIdleTime: 10 * 60_000,
    disableAutoIdle: !opts.idle,
    // IDLE starts a second after the last command: new mail shows within moments.
    autoIdleDelay: 1000,
  });
  // A dropped connection is an event, never an unhandled error.
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

/** A failure as the account's state shows it (never the server's own words, which may echo the address). */
export function failureOf(e: unknown): { state: "auth" | "error"; error: string } {
  const err = e as { authenticationFailed?: boolean; code?: string; responseStatus?: string; serverResponseCode?: string; message?: string } | null;
  // Credentials that no longer open (AUTH_SECRET changed) or an OAuth provider gone: the person signs in again.
  if (e instanceof MailAuthError) return { state: "auth", error: "auth" };
  if (err?.authenticationFailed || err?.serverResponseCode === "AUTHENTICATIONFAILED" || /auth/i.test(err?.serverResponseCode ?? "")) return { state: "auth", error: "auth" };
  const code = err?.code ?? "";
  if (/ENOTFOUND|EAI_AGAIN|unresolved/.test(code) || err?.message === "unresolved") return { state: "error", error: "unresolved" };
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(code)) return { state: "error", error: "unreachable" };
  if (/ETIMEDOUT|ETIMEOUT|timeout/i.test(code) || /timeout/i.test(err?.message ?? "")) return { state: "error", error: "timeout" };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return { state: "error", error: "certificate" };
  if (["bad host", "bad port", "blocked address", "insecure"].includes(err?.message ?? "")) return { state: "error", error: err?.message as string };
  return { state: "error", error: "connection" };
}

// --- Folders -----------------------------------------------------------------------

const ROLE_OF: Record<string, FolderRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "spam",
  "\\Archive": "archive",
  "\\All": "all",
  "\\Flagged": "flagged",
  "\\Important": "important",
};

function roleOf(l: ListResponse): FolderRole | null {
  if (l.path.toUpperCase() === "INBOX") return "inbox";
  return l.specialUse ? (ROLE_OF[l.specialUse] ?? null) : null;
}

/** Lists the server's folders into the store (gone ones are dropped); returns what to sync. */
export async function discoverFolders(client: ImapFlow, acct: AccountRow): Promise<FolderRow[]> {
  const list = (await client.list()).filter((l) => !l.flags.has("\\Noselect") && !l.flags.has("\\NonExistent"));
  const seen = new Set<string>();
  for (const l of list.slice(0, 500)) {
    seen.add(l.path);
    upsertFolder(acct.id, { path: l.path, name: l.path.split(l.delimiter || "/").join(" / "), delimiter: l.delimiter || "/", role: roleOf(l) });
  }
  for (const f of foldersOf(acct.id)) if (!seen.has(f.path)) dropFolder(acct.id, f.path);
  // Gmail with All Mail hidden from IMAP (its settings allow that): synced folder by folder instead.
  if (acct.gmail === 1 && !folderByRole(acct.id, "all")) {
    sql("UPDATE mail_accounts SET gmail = 0 WHERE id = ?").run(acct.id);
    acct.gmail = 0;
  }
  return syncedFolders(acct);
}

/** The folders the sync keeps: Gmail's three, or the special ones and the person's own. */
export function syncedFolders(acct: AccountRow): FolderRow[] {
  const all = foldersOf(acct.id);
  if (acct.gmail === 1) return all.filter((f) => f.role === "all" || f.role === "trash" || f.role === "spam");
  const special = all.filter((f) => f.role && f.role !== "all" && f.role !== "flagged" && f.role !== "important");
  const own = all.filter((f) => !f.role);
  return [...special, ...own].slice(0, MAX_FOLDERS);
}

/** The folder new mail arrives in (IDLE watches it). */
export function watchedFolder(acct: AccountRow): string {
  if (acct.gmail === 1) return folderByRole(acct.id, "all")?.path ?? "INBOX";
  return folderByRole(acct.id, "inbox")?.path ?? "INBOX";
}

// --- Reading messages --------------------------------------------------------------

function addrs(list: { name?: string; address?: string }[] | undefined): Addr[] {
  return (list ?? []).filter((a) => a.address).map((a) => ({ name: (a.name ?? "").trim(), address: (a.address ?? "").trim() }));
}

const decodedSize = (n: MessageStructureObject) => (n.encoding?.toLowerCase() === "base64" ? Math.floor(((n.size ?? 0) * 3) / 4) : (n.size ?? 0));

/** Text parts and attachments from the structure (parts are fetched later, one by one). */
export function partsOf(root: MessageStructureObject | undefined): { text: string | null; html: string | null; attachments: AttachmentMeta[] } {
  const out = { text: null as string | null, html: null as string | null, attachments: [] as AttachmentMeta[] };
  if (!root) return out;
  const walk = (n: MessageStructureObject, inAttached: boolean) => {
    const type = (n.type || "").toLowerCase();
    if (type.startsWith("multipart/")) {
      for (const c of n.childNodes ?? []) walk(c, inAttached);
      return;
    }
    const part = n.part ?? "1";
    const disp = (n.disposition ?? "").toLowerCase();
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name ?? "";
    const cid = n.id ? cleanMsgId(n.id) : "";
    const isText = type === "text/plain" || type === "text/html";
    if (type === "message/rfc822") {
      out.attachments.push({ part, filename: filename || "message.eml", type, size: n.size ?? 0, inline: false });
      return;
    }
    if (isText && disp !== "attachment" && !inAttached && !filename) {
      if (type === "text/plain" && !out.text) out.text = part;
      if (type === "text/html" && !out.html) out.html = part;
      return;
    }
    if (out.attachments.length < 100) out.attachments.push({ part, filename: filename || (type.startsWith("image/") ? "image" : "file"), type: type || "application/octet-stream", size: decodedSize(n), ...(cid ? { cid } : {}), inline: disp === "inline" || (!disp && Boolean(cid)) });
  };
  walk(root, false);
  return out;
}

const HEADERS = ["references", "in-reply-to", "list-unsubscribe", "message-id"];

async function headersOf(raw: Buffer | undefined): Promise<{ references: string[]; inReplyTo: string; unsubscribe: string; msgid: string }> {
  const out = { references: [] as string[], inReplyTo: "", unsubscribe: "", msgid: "" };
  if (!raw?.length) return out;
  try {
    const p = await simpleParser(Buffer.concat([raw, Buffer.from("\r\n")]), { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    const refs = Array.isArray(p.references) ? p.references.join(" ") : (p.references ?? "");
    out.references = parseIdList(refs);
    out.inReplyTo = cleanMsgId(p.inReplyTo ?? "");
    out.msgid = cleanMsgId(p.messageId ?? "");
    const unsub = p.headerLines.find((h) => h.key === "list-unsubscribe")?.line ?? "";
    // Only the https and mailto targets, never anything else.
    out.unsubscribe = [...unsub.matchAll(/<((?:https:\/\/|mailto:)[^>\s]{1,1000})>/gi)].map((m) => m[1]).join(" ");
  } catch {
    // Unreadable headers: the envelope's ids are used.
  }
  return out;
}

function boxesOf(acct: AccountRow, folder: FolderRow, flags: Set<string>, labels: Set<string> | undefined): number {
  if (acct.gmail === 1) {
    if (folder.role === "trash") return BOX.trash;
    if (folder.role === "spam") return BOX.spam;
    let b = 0;
    if (labels?.has("\\Inbox")) b |= BOX.inbox;
    if (labels?.has("\\Sent")) b |= BOX.sent;
    if (labels?.has("\\Draft") || flags.has("\\Draft")) b |= BOX.drafts;
    return b;
  }
  switch (folder.role) {
    case "inbox":
      return BOX.inbox;
    case "sent":
      return BOX.sent;
    case "drafts":
      return BOX.drafts;
    case "trash":
      return BOX.trash;
    case "spam":
      return BOX.spam;
    default:
      return 0;
  }
}

function labelsOf(acct: AccountRow, folder: FolderRow, labels: Set<string> | undefined): IncomingMessage["labels"] {
  if (acct.gmail === 1) return [...(labels ?? [])].filter((l) => !l.startsWith("\\") && l.length <= 200).slice(0, 50).map((l) => ({ kind: "gmail" as const, path: l, name: l }));
  return folder.role ? [] : [{ kind: "folder", path: folder.path, name: folder.name }];
}

async function toIncoming(acct: AccountRow, folder: FolderRow, m: FetchMessageObject): Promise<IncomingMessage> {
  const env = m.envelope ?? {};
  const h = await headersOf(m.headers);
  const flags = m.flags ?? new Set<string>();
  const parts = partsOf(m.bodyStructure);
  const date = env.date ? new Date(env.date).getTime() : m.internalDate ? new Date(m.internalDate).getTime() : Date.now();
  const from = addrs(env.from)[0] ?? addrs(env.sender)[0] ?? null;
  return {
    accountId: acct.id,
    folder: folder.path,
    uid: m.uid,
    msgid: cleanMsgId(env.messageId ?? "") || h.msgid,
    inReplyTo: cleanMsgId(env.inReplyTo ?? "") || h.inReplyTo,
    references: h.references,
    gmMsgid: acct.gmail === 1 ? (m.emailId ?? null) : null,
    gmThread: acct.gmail === 1 ? (m.threadId ?? null) : null,
    subject: (env.subject ?? "").replace(/\s+/g, " ").trim(),
    from,
    to: addrs(env.to),
    cc: addrs(env.cc),
    bcc: addrs(env.bcc),
    replyTo: addrs(env.replyTo),
    date: Number.isFinite(date) ? Math.min(date, Date.now() + 86_400_000) : Date.now(),
    boxes: boxesOf(acct, folder, flags, m.labels),
    seen: flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    answered: flags.has("\\Answered"),
    size: m.size ?? 0,
    unsubscribe: h.unsubscribe,
    attachments: parts.attachments,
    labels: labelsOf(acct, folder, m.labels),
    textPart: parts.text,
    htmlPart: parts.html,
  };
}

export interface SyncResult {
  /** Messages seen for the first time (n, thread), when this was not the folder's first sync. */
  fresh: { n: number; threadId: string }[];
  changed: boolean;
}

/** Ids of the account's messages with changes still on their way to the server. */
export function pendingIds(accountId: string): Set<string> {
  const out = new Set<string>();
  for (const r of sql("SELECT message_ids FROM mail_ops WHERE account_id = ?").all(accountId) as { message_ids: string }[]) {
    try {
      for (const id of JSON.parse(r.message_ids) as string[]) out.add(id);
    } catch {
      // A broken row keeps nothing back.
    }
  }
  return out;
}

const chunks = <T,>(list: T[], n: number): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

/**
 * Brings one folder up to date: new messages since the last UID; with `full`,
 * also every flag in the window and what was deleted on the server.
 */
export async function syncFolder(client: ImapFlow, acct: AccountRow, folder: FolderRow, full: boolean): Promise<SyncResult> {
  const res: SyncResult = { fresh: [], changed: false };
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    const mb = client.mailbox;
    if (!mb) return res;
    const validity = String(mb.uidValidity);
    let last = Number(folder.last_uid);
    if (folder.uidvalidity && folder.uidvalidity !== validity) {
      // The server renumbered the folder: start it over.
      sql("DELETE FROM mail_messages WHERE account_id = ? AND folder = ? AND uid > 0").run(acct.id, folder.path);
      last = 0;
      res.changed = true;
    }
    const first = last === 0;
    const since = new Date(Date.now() - syncDays() * 86_400_000);
    // Changes still on their way to the server win over its flags (read again per batch: a click during a long pass counts).
    let pending = pendingIds(acct.id);
    const keep = (id: string) => pending.has(id);
    const query = {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
      internalDate: true,
      size: true,
      headers: HEADERS,
      ...(acct.gmail === 1 ? { labels: true, threadId: true, emailId: true } : {}),
    };
    let window: number[] | null = null;
    const windowUids = async () => {
      if (window) return window;
      if (mb.exists === 0) return (window = []);
      const found = (await client.search({ since }, { uid: true })) || [];
      return (window = (found as number[]).sort((a, b) => a - b).slice(-maxPerFolder()));
    };
    let fresh: number[];
    if (first) fresh = await windowUids();
    // UIDNEXT is not refreshed by EXISTS on an open mailbox: ask for what is past the last UID instead.
    else if (mb.exists > 0) fresh = (((await client.search({ uid: `${last + 1}:*` }, { uid: true })) || []) as number[]).filter((u) => u > last);
    else fresh = [];
    let maxUid = last;
    for (const group of chunks(fresh.slice(-maxPerFolder()), 100)) {
      pending = pendingIds(acct.id);
      for await (const m of client.fetch(group.join(","), query, { uid: true })) {
        if (m.uid <= last && !first) continue;
        const r = upsertMessage(acct.user_id, await toIncoming(acct, folder, m), keep);
        if (r.isNew) {
          res.changed = true;
          if (!first) res.fresh.push({ n: r.n, threadId: r.threadId });
        }
        if (m.uid > maxUid) maxUid = m.uid;
      }
    }
    if (full && !first) {
      const uids = await windowUids();
      // Flags and labels changed elsewhere (read on the phone, starred on the web).
      for (const group of chunks(uids, 500)) {
        pending = pendingIds(acct.id);
        for await (const m of client.fetch(group.join(","), { uid: true, flags: true, ...(acct.gmail === 1 ? { labels: true } : {}) }, { uid: true })) {
          const row = sql("SELECT id, seen, flagged, boxes FROM mail_messages WHERE account_id = ? AND folder = ? AND uid = ?").get(acct.id, folder.path, m.uid) as { id: string; seen: number; flagged: number; boxes: number } | undefined;
          if (!row || keep(row.id)) continue;
          const flags = m.flags ?? new Set<string>();
          const boxes = boxesOf(acct, folder, flags, m.labels);
          const seen = flags.has("\\Seen") ? 1 : 0;
          const flagged = flags.has("\\Flagged") ? 1 : 0;
          if (seen !== row.seen || flagged !== row.flagged || boxes !== Number(row.boxes)) {
            sql("UPDATE mail_messages SET seen = ?, flagged = ?, answered = ?, boxes = ? WHERE id = ?").run(seen, flagged, flags.has("\\Answered") ? 1 : 0, boxes, row.id);
            res.changed = true;
          }
          if (acct.gmail === 1 && m.labels) {
            const n = (sql("SELECT n FROM mail_messages WHERE id = ?").get(row.id) as { n: number }).n;
            sql("DELETE FROM mail_message_labels WHERE message_n = ? AND label_id IN (SELECT id FROM mail_labels WHERE account_id = ?)").run(n, acct.id);
            for (const l of labelsOf(acct, folder, m.labels)) {
              const id = (sql("SELECT id FROM mail_labels WHERE user_id = ? AND account_id = ? AND kind = 'gmail' AND path = ?").get(acct.user_id, acct.id, l.path) as { id: string } | undefined)?.id;
              if (id) sql("INSERT OR IGNORE INTO mail_message_labels (message_n, label_id) VALUES (?, ?)").run(n, id);
            }
          }
        }
      }
      // Deleted or moved elsewhere, or out of the window now: gone here too (local copies on their way stay).
      const live = new Set(uids);
      const local = sql("SELECT id, uid FROM mail_messages WHERE account_id = ? AND folder = ? AND uid > 0").all(acct.id, folder.path) as { id: string; uid: number }[];
      pending = pendingIds(acct.id);
      const gone = local.filter((r) => !live.has(Number(r.uid)) && !keep(r.id)).map((r) => r.id);
      // Local copies the server never confirmed (no such message arrived here within an hour): gone too.
      for (const r of sql("SELECT id, uid FROM mail_messages WHERE account_id = ? AND folder = ? AND uid < 0").all(acct.id, folder.path) as { id: string; uid: number }[])
        if (placeholderAge(Number(r.uid)) > 3600_000 && !keep(r.id)) gone.push(r.id);
      if (gone.length) {
        sql("DELETE FROM mail_messages WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(gone));
        res.changed = true;
      }
    }
    setFolderSync(acct.id, folder.path, { uidvalidity: validity, lastUid: Math.max(maxUid, first ? Number(mb.uidNext) - 1 : maxUid), modseq: mb.highestModseq ? String(mb.highestModseq) : null });
  } finally {
    lock.release();
  }
  return res;
}

// --- Text and attachments ----------------------------------------------------------

async function readStream(s: Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of s) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    size += b.length;
    if (size > max) {
      s.destroy();
      return null;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** Fetches a message's text (plain and HTML parts) into the store; false when it could not. */
export async function fetchBody(client: ImapFlow, row: { n: number; folder: string; uid: number; text_part: string | null; html_part: string | null }): Promise<boolean> {
  if (row.uid <= 0) return false;
  const lock = await client.getMailboxLock(row.folder, { readOnly: true });
  try {
    let text: string | null = null;
    let html: string | null = null;
    const get = async (part: string) => {
      const d = await client.download(String(row.uid), part, { uid: true, maxBytes: MAX_TEXT + 1 });
      if (!d.content) return null;
      const b = await readStream(d.content, MAX_TEXT);
      return b ? b.toString("utf8") : null;
    };
    if (row.html_part) html = await get(row.html_part);
    if (row.text_part) text = await get(row.text_part);
    if (text === null && html === null && !row.text_part && !row.html_part) {
      // No text part in the structure (an odd message): read it whole.
      const d = await client.download(String(row.uid), undefined, { uid: true, maxBytes: MAX_TEXT + 1 });
      const b = d.content ? await readStream(d.content, MAX_TEXT) : null;
      if (b) {
        const p = await simpleParser(b, { skipImageLinks: true });
        text = p.text ?? null;
        html = typeof p.html === "string" ? p.html : null;
      }
    }
    if (text === null && html === null) {
      setBody(row.n, null);
      return false;
    }
    setBody(row.n, { text: text ?? htmlToPlain(html ?? ""), html });
    return true;
  } catch {
    setBody(row.n, null);
    return false;
  } finally {
    lock.release();
  }
}

/** A part's content as a stream (an attachment download), or null. */
export async function openPart(client: ImapFlow, folder: string, uid: number, part: string, maxBytes: number): Promise<{ content: Readable; release: () => void } | null> {
  if (uid <= 0) return null;
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const d = await client.download(String(uid), part, { uid: true, maxBytes });
    if (!d.content) {
      lock.release();
      return null;
    }
    let released = false;
    const release = () => {
      if (!released) lock.release();
      released = true;
    };
    d.content.once("end", release);
    d.content.once("error", release);
    d.content.once("close", release);
    return { content: d.content, release };
  } catch {
    lock.release();
    return null;
  }
}

/** The whole message (a server draft opened for editing, a forward as an attachment). */
export async function fetchSource(client: ImapFlow, folder: string, uid: number, max = 30_000_000): Promise<Buffer | null> {
  if (uid <= 0) return null;
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const d = await client.download(String(uid), undefined, { uid: true, maxBytes: max + 1 });
    return d.content ? await readStream(d.content, max) : null;
  } catch {
    return null;
  } finally {
    lock.release();
  }
}

// --- Changes to the server ---------------------------------------------------------

/** Where a message is on the server for an operation: its current place, else where it was when the person acted. */
export interface OpItem {
  id: string;
  folder: string;
  uid: number;
  /** Found by it when the UID is not known (yet). */
  msgid?: string;
}

export interface OpArg {
  items: OpItem[];
  add?: string[];
  remove?: string[];
  /** move: the destination folder (a path, or a role to find or make). */
  to?: string;
  toRole?: FolderRole;
  /** append: the raw message (base64), its flags. */
  raw?: string;
  flags?: string[];
  /** draft-save / draft-delete. */
  draftId?: string;
}

function placeOf(item: OpItem, useCurrent: boolean): OpItem | null {
  if (useCurrent) {
    const cur = sql("SELECT folder, uid FROM mail_messages WHERE id = ?").get(item.id) as { folder: string; uid: number } | undefined;
    if (cur && Number(cur.uid) > 0) return { id: item.id, folder: cur.folder, uid: Number(cur.uid) };
  }
  return item.uid > 0 ? item : null;
}

/** The UID of a message in a folder by its Message-ID (a copy moved without UIDPLUS, or moved twice before the server answered). */
async function findUid(client: ImapFlow, folder: string, msgid: string): Promise<number | null> {
  if (!msgid) return null;
  try {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const found = (await client.search({ header: { "message-id": msgid } }, { uid: true })) || [];
      return (found as number[]).length ? Math.max(...(found as number[])) : null;
    } finally {
      lock.release();
    }
  } catch {
    return null;
  }
}

async function byFolder(client: ImapFlow, items: OpItem[], useCurrent: boolean): Promise<{ places: Map<string, OpItem[]>; waiting: boolean }> {
  const places = new Map<string, OpItem[]>();
  let waiting = false;
  for (const it of items) {
    let p = placeOf(it, useCurrent);
    if (!p && it.msgid) {
      // Not known by UID yet: found by its Message-ID where it is now, or where it was.
      const cur = useCurrent ? (sql("SELECT folder FROM mail_messages WHERE id = ?").get(it.id) as { folder: string } | undefined) : undefined;
      for (const folder of [...new Set([cur?.folder, it.folder].filter((f): f is string => Boolean(f)))]) {
        const uid = await findUid(client, folder, it.msgid);
        if (!uid) continue;
        p = { ...it, folder, uid };
        // The local copy waiting in that folder is this one.
        sql("UPDATE OR IGNORE mail_messages SET uid = ? WHERE id = ? AND folder = ? AND uid < 0").run(uid, it.id, folder);
        break;
      }
    }
    if (!p) {
      waiting = true;
      continue;
    }
    const list = places.get(p.folder) ?? [];
    list.push(p);
    places.set(p.folder, list);
  }
  return { places, waiting };
}

/** The folder for a role, made when the server has none (Archive on a plain IMAP server). */
async function folderFor(client: ImapFlow, acct: AccountRow, role: FolderRole): Promise<string | null> {
  const f = folderByRole(acct.id, role);
  if (f) return f.path;
  if (role !== "archive") return null;
  try {
    const made = await client.mailboxCreate("Archive");
    upsertFolder(acct.id, { path: made.path, name: "Archive", delimiter: "/", role: "archive" });
    return made.path;
  } catch {
    // Already there under that name (not marked \Archive): use it.
    const hit = foldersOf(acct.id).find((x) => x.path.toLowerCase() === "archive");
    if (hit) {
      sql("UPDATE mail_folders SET role = 'archive' WHERE account_id = ? AND path = ?").run(acct.id, hit.path);
      return hit.path;
    }
    return null;
  }
}

/** Runs one change on the server. "retry": something it needs is not there yet (a moved copy's UID). */
export async function runOp(client: ImapFlow, acct: AccountRow, kind: string, arg: OpArg): Promise<"done" | "retry"> {
  switch (kind) {
    case "flags":
    case "labels": {
      const { places, waiting } = await byFolder(client, arg.items, true);
      for (const [folder, list] of places) {
        const lock = await client.getMailboxLock(folder);
        try {
          const range = list.map((i) => i.uid).join(",");
          const useLabels = kind === "labels";
          if (arg.add?.length) await client.messageFlagsAdd(range, arg.add, { uid: true, useLabels });
          if (arg.remove?.length) await client.messageFlagsRemove(range, arg.remove, { uid: true, useLabels });
        } finally {
          lock.release();
        }
      }
      return waiting ? "retry" : "done";
    }
    case "move": {
      const to = arg.to ?? (arg.toRole ? await folderFor(client, acct, arg.toRole) : null);
      if (!to) return "done";
      // A folder made just now (Archive) may be named differently than guessed: the local copies follow.
      if (arg.toRole) for (const it of arg.items) sql("UPDATE mail_messages SET folder = ? WHERE id = ? AND uid < 0 AND folder != ?").run(to, it.id, to);
      const { places, waiting } = await byFolder(client, arg.items, false);
      for (const [folder, list] of places) {
        if (folder === to) continue;
        const lock = await client.getMailboxLock(folder);
        try {
          const r = await client.messageMove(list.map((i) => i.uid).join(","), to, { uid: true });
          // The new UIDs (UIDPLUS): the local copies become the server's at once.
          for (const it of list) {
            const nu = r && r.uidMap ? r.uidMap.get(it.uid) : undefined;
            if (nu) sql("UPDATE OR IGNORE mail_messages SET uid = ? WHERE id = ? AND uid < 0 AND folder = ?").run(nu, it.id, to);
          }
        } finally {
          lock.release();
        }
      }
      return waiting ? "retry" : "done";
    }
    case "expunge": {
      const { places, waiting } = await byFolder(client, arg.items, true);
      for (const [folder, list] of places) {
        const lock = await client.getMailboxLock(folder);
        try {
          await client.messageDelete(list.map((i) => i.uid).join(","), { uid: true });
        } finally {
          lock.release();
        }
      }
      // A copy still on its way to Trash is deleted once it is there.
      return waiting ? "retry" : "done";
    }
    case "append": {
      const to = arg.to ?? (arg.toRole ? await folderFor(client, acct, arg.toRole) : null);
      if (!to || !arg.raw) return "done";
      await client.append(to, Buffer.from(arg.raw, "base64"), arg.flags ?? ["\\Seen"]);
      return "done";
    }
    default:
      return "done";
  }
}

/** Saves a draft into the server's Drafts folder (replacing its previous copy); the new UID, or null. */
export async function saveDraftCopy(client: ImapFlow, acct: AccountRow, raw: Buffer, prev: { folder: string | null; uid: number | null }): Promise<{ folder: string; uid: number | null } | null> {
  const folder = folderByRole(acct.id, "drafts")?.path;
  if (!folder) return null;
  const r = await client.append(folder, raw, ["\\Draft", "\\Seen"]);
  await dropDraftCopy(client, prev);
  return { folder, uid: r && r.uid ? r.uid : null };
}

export async function dropDraftCopy(client: ImapFlow, prev: { folder: string | null; uid: number | null }): Promise<void> {
  if (!prev.folder || !prev.uid || prev.uid <= 0) return;
  const lock = await client.getMailboxLock(prev.folder);
  try {
    await client.messageDelete(String(prev.uid), { uid: true });
  } finally {
    lock.release();
  }
}

export { placeholderUid };
