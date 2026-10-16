// One Inbox for the whole workspace. Server-only.
//
// Documents, Design and Mail send their notifications here (`notify`); Projects
// keeps its own (pj_notifications, with snoozing and per-issue rules) and the
// Inbox reads both as one list, newest first. A notification holds ids and a
// short excerpt, never a document; what it is about is shown as a card, so a
// person who lost access to it sees nothing.

import { AccessResolver } from "../notes/access";
import { emit } from "../pulse/bus";
import { ctxFor, type Ctx } from "../projects/core";
import { inbox as projectsInbox, markNotifications, unreadCount as projectsUnread } from "../projects/workspace";
import { newId, sql } from "../store";
import { cardsFor, namesOf, type Viewer } from "./cards";
import { parseRefKey } from "./refs";
import { ecoDb } from "./schema";
import { keyVisible } from "./visibility";
import { mutedKind } from "../notes/follows";
import type { InboxItem } from "./types";

export type { InboxItem };

export type InboxKind = "mention" | "comment" | "reply" | "assigned" | "reminder" | "invite" | "automation" | "mail" | "suggestion" | "suggestion_accepted" | "suggestion_rejected" | "page_update" | "jev";

/** One notification as a product sends it. */
export interface InboxNote {
  ws: string;
  kind: InboxKind;
  /** A ref key: "note:<id>", "issue:<id>", "design:<file>/<frame>"… */
  ref: string;
  /** A block id or comment id for the deep link. */
  part?: string;
  /** Who did it (user id), null for the system (a form, an automation). */
  by: string | null;
  /** A short plain-text excerpt (≤ 280 characters). */
  text?: string;
}
const KINDS: readonly string[] = ["mention", "comment", "reply", "assigned", "reminder", "invite", "automation", "mail", "suggestion", "suggestion_accepted", "suggestion_rejected", "page_update", "jev"];

const PART_RE = /^[A-Za-z0-9_:-]{1,80}$/;

function isMember(ws: string, userId: string): boolean {
  return Boolean(sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(ws, userId));
}

/**
 * A workspace's guests (people some pages are shared with, Documents) hear
 * about those pages only: a page ref they can open right now. Checked when
 * the notification is made and again whenever it is read, so a page that is
 * no longer shared with them disappears from their Inbox.
 */
function guestReads(acc: AccessResolver, ref: string): boolean {
  return ref.startsWith("note:") && acc.level(ref.slice(5)) !== null;
}

/**
 * Tells a person about something in a workspace. Nothing happens for one's
 * own action, for someone outside the workspace (a guest only about a page
 * they can open), or for a kind the person turned off (Documents'
 * notification settings, lib/notes/follows.ts); an unread notification of the
 * same kind about the same thing is refreshed rather than repeated.
 */
export function notify(userId: string, n: InboxNote): void {
  if (!userId || userId === n.by || !KINDS.includes(n.kind) || !parseRefKey(n.ref)) return;
  if (mutedKind(userId, n.kind)) return;
  ecoDb();
  if (!isMember(n.ws, userId) && !guestReads(new AccessResolver(n.ws, userId), n.ref)) return;
  const part = n.part && PART_RE.test(n.part) ? n.part : "";
  const text = (n.text ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  const now = Date.now();
  const same = sql("SELECT id FROM eco_inbox WHERE user_id = ? AND ws_id = ? AND kind = ? AND ref = ? AND part = ? AND read_at IS NULL AND archived_at IS NULL").get(userId, n.ws, n.kind, n.ref, part) as { id: string } | undefined;
  if (same) sql("UPDATE eco_inbox SET actor_id = ?, text = ?, updated_at = ? WHERE id = ?").run(n.by, text, now, same.id);
  else sql("INSERT INTO eco_inbox (id, ws_id, user_id, kind, ref, part, actor_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(newId(12), n.ws, userId, n.kind, n.ref, part, n.by, text, now, now);
  emit(n.ws, { type: "inbox", ref: userId, by: n.by ?? undefined });
}


function projectsCtx(v: Viewer): Ctx | null {
  try {
    return ctxFor(v.userId, v.wsId, "read");
  } catch {
    return null;
  }
}

interface Row {
  id: string;
  kind: string;
  ref: string;
  part: string;
  actor_id: string | null;
  text: string;
  updated_at: number;
  read_at: number | null;
}

/** Both lists as one, newest first. */
export async function inboxOf(v: Viewer, opts: { archived?: boolean; limit?: number } = {}): Promise<{ items: InboxItem[]; unread: number }> {
  ecoDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  // Two plain conditions (not "(archived_at IS NULL) = ?") so the index serves the order.
  const rows = (
    opts.archived
      ? sql("SELECT id, kind, ref, part, actor_id, text, updated_at, read_at FROM eco_inbox WHERE user_id = ? AND ws_id = ? AND archived_at IS NOT NULL ORDER BY updated_at DESC LIMIT ?")
      : sql("SELECT id, kind, ref, part, actor_id, text, updated_at, read_at FROM eco_inbox WHERE user_id = ? AND ws_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?")
  ).all(v.userId, v.wsId, limit) as unknown as Row[];
  const ctx = projectsCtx(v);
  const pj = ctx ? projectsInbox(ctx, { archived: opts.archived, limit }).items : [];
  // Only the names shown (never the whole directory).
  const names = namesOf([...rows.map((r) => r.actor_id), ...pj.map((n) => n.actorId)].filter((x): x is string => Boolean(x)));
  const keys = [...rows.map((r) => r.ref), ...pj.filter((n) => n.issue).map((n) => `issue:${n.issue!.id}`), ...pj.filter((n) => !n.issue && n.projectId).map((n) => `project:${n.projectId}`)];
  const cards = new Map((await cardsFor(v, keys)).map((c) => [c.key, c]));
  const actor = (id: string | null) => (id ? { id, name: names.get(id) ?? "" } : null);
  const items: InboxItem[] = [];
  for (const r of rows) {
    const card = cards.get(r.ref) ?? null;
    // About something the person can no longer see: left out.
    if (!card) continue;
    const url = r.part && card.kind === "note" ? `${card.url}&b=${encodeURIComponent(r.part)}` : card.url;
    items.push({ id: `eco:${r.id}`, kind: r.kind, card, actor: actor(r.actor_id), text: r.text, at: r.updated_at, read: r.read_at !== null, url });
  }
  for (const n of pj) {
    const key = n.issue ? `issue:${n.issue.id}` : n.projectId ? `project:${n.projectId}` : null;
    const card = key ? (cards.get(key) ?? null) : null;
    if (key && !card) continue;
    items.push({ id: `pj:${n.id}`, kind: n.kind, card, actor: actor(n.actorId), text: n.excerpt, at: n.updatedAt, read: n.readAt !== null, url: card?.url ?? `/projects/inbox?ws=${encodeURIComponent(v.wsId)}` });
  }
  items.sort((a, b) => b.at - a.at);
  return { items: items.slice(0, limit), unread: unreadOf(v) };
}

/** Read notifications older than this are dropped (archived or not): the Inbox is about now. */
const KEEP_READ_MS = 90 * 24 * 3600_000;

export function purgeInbox(now = Date.now()): number {
  ecoDb();
  return Number(sql("DELETE FROM eco_inbox WHERE read_at IS NOT NULL AND updated_at < ?").run(now - KEEP_READ_MS).changes);
}

export function unreadOf(v: Viewer): number {
  ecoDb();
  if (!isMember(v.wsId, v.userId)) {
    // A guest: their page notifications that are still theirs to open.
    const refs = sql("SELECT ref FROM eco_inbox WHERE user_id = ? AND ws_id = ? AND read_at IS NULL AND archived_at IS NULL LIMIT 500").all(v.userId, v.wsId) as { ref: string }[];
    const acc = new AccessResolver(v.wsId, v.userId);
    return refs.filter((r) => guestReads(acc, r.ref)).length;
  }
  // Only items the person may still open count (a page made private since, an issue of a team they left).
  const refs = sql("SELECT ref FROM eco_inbox WHERE user_id = ? AND ws_id = ? AND read_at IS NULL AND archived_at IS NULL LIMIT 500").all(v.userId, v.wsId) as { ref: string }[];
  const mine = refs.filter((r) => keyVisible(v.userId, v.wsId, r.ref)).length;
  const ctx = projectsCtx(v);
  return mine + (ctx ? projectsUnread(ctx) : 0);
}

/** read / unread / archive / unarchive, for items of either list ("eco:…", "pj:…") or "all". */
export function markInbox(v: Viewer, ids: unknown, action: "read" | "unread" | "archive" | "unarchive"): number {
  ecoDb();
  const all = ids === "all";
  if (!all && (!Array.isArray(ids) || ids.length > 500)) return 0;
  const list = all ? [] : (ids as unknown[]).filter((x): x is string => typeof x === "string");
  const mine = list.filter((x) => x.startsWith("eco:")).map((x) => x.slice(4));
  const theirs = list.filter((x) => x.startsWith("pj:")).map((x) => x.slice(3));
  const now = Date.now();
  const set = { read: "read_at = IFNULL(read_at, ?)", unread: "read_at = NULL", archive: "archived_at = ?, read_at = IFNULL(read_at, ?)", unarchive: "archived_at = NULL" }[action];
  const vals: number[] = action === "read" ? [now] : action === "archive" ? [now, now] : [];
  let n = 0;
  if (all || mine.length) {
    const where = all ? "user_id = ? AND ws_id = ? AND archived_at IS NULL" : "user_id = ? AND ws_id = ? AND id IN (SELECT value FROM json_each(?))";
    const params = all ? [v.userId, v.wsId] : [v.userId, v.wsId, JSON.stringify(mine)];
    n += Number(sql(`UPDATE eco_inbox SET ${set} WHERE ${where}`).run(...vals, ...params).changes);
  }
  const ctx = projectsCtx(v);
  if (ctx && (all || theirs.length)) n += markNotifications(ctx, all ? "all" : theirs, action);
  if (n) emit(v.wsId, { type: "inbox", ref: v.userId, by: v.userId });
  return n;
}
