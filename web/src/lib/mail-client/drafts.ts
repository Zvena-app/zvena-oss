// Server-only: drafts. The composer saves as the person types (a few
// seconds apart); each save lands here at once and, a little later, in the
// mailbox's own Drafts folder (one copy, replaced on every save, same
// Message-ID), so the draft is there in any other mail app too.

import { simpleParser } from "mailparser";
import { newId, sql } from "../store";
import { buildMessage, cleanDraft, newMessageId } from "./compose";
import { fetchSource, dropDraftCopy, saveDraftCopy } from "./imap";
import { mailDb } from "./schema";
import { accountById, ownAccount, ownMessage, type AccountRow } from "./store";
import { cleanOutgoingHtml } from "./compose";
import { enqueueOp, withImap } from "./worker";
import type { Addr, Draft } from "./types";
import { BOX } from "./views";

const MAX_DRAFTS = 500;
/** Saves into the Drafts folder wait this long for the next keystroke. */
const IMAP_DELAY = 8_000;

interface DraftRow {
  id: string;
  user_id: string;
  account_id: string | null;
  json: string;
  msgid: string;
  imap_folder: string | null;
  imap_uid: number | null;
  updated_at: number;
}

const parse = (r: DraftRow): Draft | null => {
  try {
    return { ...(JSON.parse(r.json) as Draft), id: r.id, updatedAt: Number(r.updated_at) };
  } catch {
    return null;
  }
};

export function draftsOf(userId: string): Draft[] {
  mailDb();
  return (sql("SELECT * FROM mail_drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200").all(userId) as unknown as DraftRow[]).map(parse).filter((d): d is Draft => d !== null);
}

export function draftOf(userId: string, id: string): Draft | null {
  const r = sql("SELECT * FROM mail_drafts WHERE id = ? AND user_id = ?").get(id, userId) as DraftRow | undefined;
  return r ? parse(r) : null;
}

/** The Message-IDs of the person's drafts (their server copies are not listed twice). */
export function draftMsgids(userId: string): Set<string> {
  return new Set((sql("SELECT msgid FROM mail_drafts WHERE user_id = ?").all(userId) as { msgid: string }[]).map((r) => r.msgid));
}

/** Saves a draft (new or changed) and queues its copy for the server. */
export function saveDraft(userId: string, id: string, raw: unknown): Draft | null {
  mailDb();
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return null;
  const d = cleanDraft(raw, id);
  const acct = d.accountId ? ownAccount(userId, d.accountId) : null;
  if (d.accountId && !acct) return null;
  const prev = sql("SELECT * FROM mail_drafts WHERE id = ?").get(id) as DraftRow | undefined;
  if (prev && prev.user_id !== userId) return null;
  // A late autosave of a message already in the outbox must not bring its draft back.
  if (sql("SELECT 1 FROM mail_outbox WHERE user_id = ? AND json_extract(draft, '$.id') = ?").get(userId, id)) return null;
  if (!prev && Number((sql("SELECT COUNT(*) AS n FROM mail_drafts WHERE user_id = ?").get(userId) as { n: number }).n) >= MAX_DRAFTS) return null;
  const now = Date.now();
  const json = JSON.stringify({ ...d, updatedAt: now });
  if (prev) {
    // Another mailbox now: the old one's copy goes.
    if (prev.account_id && prev.account_id !== d.accountId && prev.imap_uid) enqueueOp(prev.account_id, "draft-delete", [], { items: [], draftId: id, raw: JSON.stringify({ folder: prev.imap_folder, uid: prev.imap_uid }) });
    sql("UPDATE mail_drafts SET account_id = ?, json = ?, updated_at = ? WHERE id = ?").run(d.accountId || null, json, now, id);
  } else sql("INSERT INTO mail_drafts (id, user_id, account_id, json, msgid, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, d.accountId || null, json, newMessageId(acct?.email ?? "x@zvena.app"), now);
  if (acct) {
    // One pending save per draft: the newest text wins.
    sql("DELETE FROM mail_ops WHERE account_id = ? AND kind = 'draft-save' AND json_extract(arg, '$.draftId') = ?").run(acct.id, id);
    enqueueOp(acct.id, "draft-save", [], { items: [], draftId: id }, IMAP_DELAY);
  }
  return { ...d, updatedAt: now };
}

/** Deletes a draft here and on the server. */
export function deleteDraft(userId: string, id: string): boolean {
  const r = sql("SELECT * FROM mail_drafts WHERE id = ? AND user_id = ?").get(id, userId) as DraftRow | undefined;
  if (!r) return false;
  sql("DELETE FROM mail_drafts WHERE id = ?").run(id);
  if (r.account_id) {
    sql("DELETE FROM mail_ops WHERE account_id = ? AND kind = 'draft-save' AND json_extract(arg, '$.draftId') = ?").run(r.account_id, id);
    if (r.imap_uid) enqueueOp(r.account_id, "draft-delete", [], { items: [], draftId: id, raw: JSON.stringify({ folder: r.imap_folder, uid: r.imap_uid }) });
  }
  return true;
}

/** The worker's part: writes the draft's copy into the Drafts folder (or drops a stale one). */
export async function runDraftOp(acct: AccountRow, kind: string, arg: { draftId?: string; raw?: string }, client: import("imapflow").ImapFlow): Promise<"done" | "retry"> {
  if (kind === "draft-delete") {
    try {
      const prev = JSON.parse(arg.raw ?? "{}") as { folder: string | null; uid: number | null };
      await dropDraftCopy(client, prev);
    } catch {
      // Gone already.
    }
    return "done";
  }
  const r = arg.draftId ? (sql("SELECT * FROM mail_drafts WHERE id = ? AND user_id = ?").get(arg.draftId, acct.user_id) as DraftRow | undefined) : undefined;
  const d = r ? parse(r) : null;
  if (!r || !d || d.accountId !== acct.id) return "done";
  const built = await buildMessage(acct.user_id, acct, acct.name, d, { msgid: r.msgid });
  const out = await saveDraftCopy(client, acct, built.copy, { folder: r.imap_folder, uid: r.imap_uid });
  if (!out) return "done";
  // Sent or discarded while the copy was on its way: the copy goes at once.
  if (!sql("SELECT 1 FROM mail_drafts WHERE id = ?").get(r.id)) await dropDraftCopy(client, out);
  else sql("UPDATE mail_drafts SET imap_folder = ?, imap_uid = ? WHERE id = ?").run(out.folder, out.uid, r.id);
  return "done";
}

/** A draft written in another app (a message in Drafts) opened in the composer: it becomes a zvena draft. */
export async function draftFromMessage(userId: string, messageId: string): Promise<Draft | null> {
  const m = ownMessage(userId, messageId);
  // Only a draft (in Drafts): any other message opened this way would load its remote pictures in the composer.
  if (!m || !(Number(m.boxes) & BOX.drafts)) return null;
  const acct = accountById(m.account_id);
  if (!acct || acct.user_id !== userId) return null;
  const src = await withImap(acct, (c) => fetchSource(c, m.folder, Number(m.uid), 25_000_000)).catch(() => null);
  const p = src ? await simpleParser(src, { skipImageLinks: true }).catch(() => null) : null;
  const list = (v: unknown): Addr[] => {
    const arr = (Array.isArray(v) ? v : v ? [v] : []) as { value?: { name?: string; address?: string }[] }[];
    return arr.flatMap((x) => x.value ?? []).filter((a) => a.address).map((a) => ({ name: a.name ?? "", address: a.address as string }));
  };
  const id = newId(12);
  const d = saveDraft(userId, id, {
    accountId: acct.id,
    to: p ? list(p.to) : [],
    cc: p ? list(p.cc) : [],
    bcc: p ? list(p.bcc) : [],
    subject: p?.subject ?? m.subject,
    html: p ? (typeof p.html === "string" ? cleanOutgoingHtml(p.html) : (p.textAsHtml ?? "")) : "",
    mode: "new",
    attachments: [],
  });
  if (!d) return null;
  // The old copy on the server is replaced by this draft's own.
  sql("UPDATE mail_drafts SET imap_folder = ?, imap_uid = ? WHERE id = ?").run(m.folder, Number(m.uid) > 0 ? Number(m.uid) : null, id);
  if (m.msgid) sql("UPDATE mail_drafts SET msgid = ? WHERE id = ?").run(m.msgid, id);
  return d;
}
