// Server-only: who hears about a write (an after-push reaction, see
// after-push.ts). Notion's notifications for Documents:
//   - someone @mentioned in a page (once, when the mention first appears);
//   - someone @mentioned in a comment;
//   - a reply in a discussion → the people who wrote in it before;
//   - a new page comment → the page's creator;
//   - someone added to a Person property → "assigned".
//   - a suggested edit → the page's editors (who made or edited it and may edit it now);
//   - a suggestion accepted or rejected → the person who suggested it;
//   - a followed page edited or commented on → its followers (lib/notes/follows.ts).
// The Inbox (lib/eco/inbox.ts) stores and shows them. Never the actor, never
// a non-member; one notification per person per write (the strongest kind).

import { notify, type InboxKind, type InboxNote } from "../eco/inbox";
import { sql } from "../store";
import { roleIn } from "../workspaces";
import { docsPresence } from "./access";
import { onAfterPush, type NoteChange, type PushContext } from "./after-push";
import { AccessResolver, atLeast } from "./access";
import { inlineText } from "./model";
import { dropFollows, followersOf } from "./follows";
import { suggestionParts } from "./suggestions";
import { commentMentions, commentPlain } from "./people";
import type { DbSchema, Note, NoteComment } from "./types";

type Notifier = (userId: string, n: InboxNote) => void;
let send: Notifier = notify;

/** Tests: puts another Inbox in place; returns the one before. */
export function setNotifierForTests(fn: Notifier): Notifier {
  const prev = send;
  send = fn;
  return prev;
}

const EXCERPT = 280;
const excerpt = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > EXCERPT ? `${t.slice(0, EXCERPT - 1)}…` : t;
};

/** Every person a page's blocks @mention: user id → the first block naming them and its text. */
export function contentMentions(blocks: unknown, out = new Map<string, { block: string; text: string }>(), depth = 0): Map<string, { block: string; text: string }> {
  if (!Array.isArray(blocks) || depth > 40) return out;
  const scan = (content: unknown, block: string, text: () => string, d = 0): void => {
    if (d > 20) return;
    if (Array.isArray(content)) {
      for (const raw of content) {
        const n = raw as { type?: string; props?: { userId?: unknown }; content?: unknown } | null;
        if (!n || typeof n !== "object") continue;
        if (n.type === "mention" && typeof n.props?.userId === "string" && n.props.userId && !out.has(n.props.userId)) out.set(n.props.userId, { block, text: text() });
        else if (n.content) scan(n.content, block, text, d + 1);
      }
      return;
    }
    // A table's cells.
    const table = content as { type?: string; rows?: { cells?: unknown[] }[] } | null;
    if (table?.type === "tableContent" && Array.isArray(table.rows)) {
      for (const r of table.rows) for (const c of r.cells ?? []) scan(typeof c === "object" && c !== null && "content" in c ? (c as { content: unknown }).content : c, block, text, d + 1);
    }
  };
  for (const raw of blocks) {
    const b = raw as { id?: unknown; content?: unknown; children?: unknown } | null;
    if (!b || typeof b !== "object") continue;
    const id = typeof b.id === "string" ? b.id : "";
    scan(b.content, id, () => excerpt(inlineText(b.content)));
    contentMentions(b.children, out, depth + 1);
  }
  return out;
}

/** A user's name (for excerpts: mentions in comments read "@Name"). */
function nameOf(id: string): string {
  const r = sql("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | undefined;
  return r?.name ?? "";
}

/** What a suggestion adds or removes, as one line ("+ new words − old words"). */
function suggestionExcerpt(content: unknown, sid: string): string {
  const p = suggestionParts(content).get(sid);
  if (!p) return "";
  return [p.ins.trim() && `+ ${p.ins.trim()}`, p.del.trim() && `− ${p.del.trim()}`].filter(Boolean).join(" ");
}

/**
 * The people who look after a page: who created it, last edited it, and the
 * most recent authors of its history — those who may still edit it.
 */
export function pageEditors(ws: string, note: Note): string[] {
  const ids = new Set<string>();
  for (const id of [note.createdBy, note.editedBy]) if (id && USER_ID_RE.test(id)) ids.add(id);
  try {
    for (const r of sql("SELECT by, MAX(at) AS at FROM note_versions WHERE ws = ? AND note_id = ? AND by IS NOT NULL GROUP BY by ORDER BY at DESC LIMIT 20").all(ws, note.id) as { by: string }[]) {
      // An accepted suggestion's version is its suggester's, not an editor's.
      if (USER_ID_RE.test(r.by)) ids.add(r.by);
    }
  } catch {
    // No history yet (a fresh database): the page's own names are enough.
  }
  return [...ids].filter((id) => atLeast(new AccessResolver(ws, id).level(note.id), "edit"));
}

const USER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** A database's schema (to know which properties name people), cached for one write. */
function schemaOf(ws: string, dbId: string, cache: Map<string, DbSchema | null>): DbSchema | null {
  if (cache.has(dbId)) return cache.get(dbId) ?? null;
  let schema: DbSchema | null = null;
  try {
    const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, dbId) as { json: string | null } | undefined;
    const n = JSON.parse(r?.json ?? "null") as Note | null;
    schema = n?.kind === "database" && n.db ? n.db : null;
  } catch {
    schema = null;
  }
  cache.set(dbId, schema);
  return schema;
}

// Mentions on content seen for the first time long after it was written (a
// guest's pages uploaded at sign-in, an import) tell no one.
const FRESH_MS = 15 * 60_000;

/** Kinds by strength: one person hears the strongest reason only. */
const RANK: Record<InboxKind, number> = { mention: 5, assigned: 4, suggestion_accepted: 3, suggestion_rejected: 3, reply: 3, suggestion: 2, comment: 2, page_update: 1, reminder: 1, invite: 1, automation: 1, jev: 1, mail: 0 };

export function peopleReaction(changes: readonly NoteChange[], ctx: PushContext, now = Date.now()): void {
  const schemas = new Map<string, DbSchema | null>();
  for (const ch of changes) {
    const after = ch.after;
    // Deleted for good: nobody follows it any more.
    if (!after && ch.before) dropFollows(ctx.ws, ch.id);
    if (!after || after.template || after.synced) continue;
    const before = ch.before;
    const fresh = before !== null || now - after.updatedAt < FRESH_MS;
    const out = new Map<string, InboxNote>();
    const put = (userId: string, kind: InboxKind, n: Omit<InboxNote, "ws" | "kind" | "ref" | "by">) => {
      if (!userId || userId === ctx.by) return;
      const prev = out.get(userId);
      if (prev && RANK[prev.kind] >= RANK[kind]) return;
      out.set(userId, { ws: ctx.ws, kind, ref: `note:${after.id}`, by: /^(form|automation:)/.test(ctx.by) ? null : ctx.by, ...n });
    };

    // @mentions in the page.
    if (fresh) {
      const had = before ? contentMentions(before.content) : new Map();
      for (const [userId, at] of contentMentions(after.content)) if (!had.has(userId)) put(userId, "mention", { ...(at.block ? { part: at.block } : {}), text: at.text || excerpt(after.title) });
    }

    // New comments: mentions, replies to a discussion, a page comment for its creator.
    const known = new Set((before?.comments ?? []).map((c) => c.id));
    const all = after.comments ?? [];
    const was = new Map((before?.comments ?? []).map((c) => [c.id, c]));
    for (const c of all) {
      if (!c.suggestion || !c.thread) continue;
      // Suggested edits: a new one tells the page's editors; a decision tells its author.
      if (!known.has(c.id) && (before || fresh)) {
        const text = excerpt(suggestionExcerpt(after.content, c.thread) || after.title);
        for (const userId of pageEditors(ctx.ws, after)) put(userId, "suggestion", { part: c.thread, text });
      }
      const state = c.suggestion.state;
      // …only while they can still open the page (a guest whose share ended hears nothing of it).
      if (state && was.get(c.id)?.suggestion?.state !== state && c.authorId && new AccessResolver(ctx.ws, c.authorId).level(after.id) !== null) {
        const text = excerpt(suggestionExcerpt(before?.content, c.thread) || after.title);
        put(c.authorId, state === "accepted" ? "suggestion_accepted" : "suggestion_rejected", { part: c.thread, text });
      }
    }
    for (const c of all) {
      if (known.has(c.id) || (!before && !fresh) || c.suggestion) continue;
      const text = excerpt(commentPlain(c.text, nameOf));
      for (const userId of commentMentions(c.text)) put(userId, "mention", { part: c.id, text });
      const earlier = all.filter((x: NoteComment) => x.id !== c.id && (x.thread ?? "") === (c.thread ?? "") && x.at <= c.at);
      for (const x of earlier) if (x.authorId) put(x.authorId, "reply", { part: c.id, text });
      if (!c.thread && after.createdBy) put(after.createdBy, "comment", { part: c.id, text });
    }

    // Followers: every new comment, and the page's edits (one unread notification per page, kept fresh).
    const followers = before ? followersOf(ctx.ws, after.id) : [];
    if (followers.length) {
      const newComments = (after.comments ?? []).filter((c) => !known.has(c.id) && !c.suggestion);
      const edited = before !== null && (before.title !== after.title || JSON.stringify(before.content) !== JSON.stringify(after.content) || JSON.stringify(before.props ?? null) !== JSON.stringify(after.props ?? null));
      for (const userId of followers) {
        if (!new AccessResolver(ctx.ws, userId).level(after.id)) continue;
        const c = newComments[newComments.length - 1];
        if (c) put(userId, "comment", { part: c.id, text: excerpt(commentPlain(c.text, nameOf)) });
        else if (edited) put(userId, "page_update", { text: excerpt(after.title) });
      }
    }

    // People added to a Person property of a row.
    const schema = after.parentId ? schemaOf(ctx.ws, after.parentId, schemas) : null;
    if (schema && (fresh || before)) {
      for (const p of schema.properties) {
        if (p.type !== "person") continue;
        const was = new Set(Array.isArray(before?.props?.[p.id]) ? (before?.props?.[p.id] as string[]) : []);
        const ids = Array.isArray(after.props?.[p.id]) ? (after.props?.[p.id] as string[]) : [];
        for (const userId of ids) if (!was.has(userId)) put(userId, "assigned", { text: excerpt(after.title) });
      }
    }

    for (const [userId, n] of out) {
      // Members of the workspace, and its guests (pages shared with them): the Inbox
      // tells a guest only about a page they can open. A left member, a stray id: nobody.
      if (!roleIn(userId, ctx.ws) && !docsPresence(userId, ctx.ws)?.guest) continue;
      send(userId, n);
    }
  }
}

onAfterPush("people", (changes, ctx) => peopleReaction(changes, ctx));
