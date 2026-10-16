// Server-only: the history of Documents (Notion's Page history, Updates and
// Analytics), shared by everyone in the workspace.
//
// Versions. Every write goes through pushNotes, and this after-push reaction
// keeps snapshots of pages, rows and databases (their schema): one version
// is one person's editing session — the same person's edits within
// `versionsGapMinutes` of the session's start update it in place, another
// person or a later edit starts a new one. The state before a delete forever
// is always kept. Only what a page *is* counts (title, icon, cover, content,
// properties, schema, style), not comments, favorites or sibling order.
// Snapshots are gzip'd JSON; they never count towards the storage quota, but
// a workspace's history has a hard cap (the oldest go first, never a page's
// newest version). Retention: the newest `versionsKeepNewest` of a page and
// everything newer than `versionsKeepDays` stay; older versions are thinned
// to one a day and dropped after `versionsMaxDays`. A page deleted forever
// loses its versions after `versionsDeletedDays`.
//
// Accepted suggestions (lib/notes/suggestions.ts) are their author's: the
// version an editor's "Accept" makes is kept under the person who suggested
// it (kind "suggestion:<who accepted>"), one per suggester.
//
// Events (moves, trash, restore, create) feed the Updates panel together
// with the versions and the page's own comments. Views (a member opening a
// page, at most once per 30 minutes) feed Analytics.

import { gunzipSync, gzipSync } from "node:zlib";
import { config } from "../config";
import { sql, tx } from "../store";
import { onAfterPush, type NoteChange, type PushContext } from "./after-push";
import { hiddenViewers, keepsViews } from "./follows";
import { sanitizeNote } from "./model";
import { decideSuggestion } from "./suggestions";
import type { Note } from "./types";

const DAY = 86_400_000;
const VIEW_GAP = 30 * 60_000;

export type VersionKind = "edit" | "delete" | "suggestion";
export type EventKind = "create" | "move" | "trash" | "restore" | "delete";

export interface VersionMeta {
  id: number;
  at: number;
  /** When the editing session started (`at` is its last edit). */
  started: number;
  by: string | null;
  kind: VersionKind;
  /** An accepted suggestion (by = who suggested it): who accepted it. */
  acceptedBy?: string;
  title: string;
  bytes: number;
}

export interface NoteEvent {
  at: number;
  by: string | null;
  kind: EventKind;
  /** move: the parents before and after. */
  from?: string | null;
  to?: string | null;
}

// ---------------------------------------------------------------------------
// Snapshots

/** What a version keeps of a note: what the page is, not who favorited it or its comments. */
export function versionBody(n: Note): Partial<Note> {
  const out: Partial<Note> = { id: n.id, kind: n.kind, parentId: n.parentId, title: n.title, icon: n.icon, cover: n.cover, content: n.content, updatedAt: n.updatedAt };
  if (n.props) out.props = n.props;
  if (n.db) out.db = n.db;
  if (n.style) out.style = n.style;
  if (n.template) out.template = true;
  if (n.synced) out.synced = true;
  if (n.inline) out.inline = true;
  return out;
}

/** The part of a note whose change makes a version (not the parent: a move is an event). */
function signature(n: Note): string {
  const { id: _i, parentId: _p, updatedAt: _u, ...body } = versionBody(n);
  void _i;
  void _p;
  void _u;
  return JSON.stringify(body);
}

/** A page with nothing in it yet (a fresh "Untitled"): not worth a version. */
function isBlank(n: Note): boolean {
  if (n.title.trim() || n.props || n.db) return false;
  if (n.content.length === 0) return true;
  const json = JSON.stringify(n.content);
  return n.content.length === 1 && json.length < 200 && !/"text":"[^"]/.test(json);
}

function encode(n: Note): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(versionBody(n))));
}

function decode(data: Uint8Array): unknown {
  try {
    return JSON.parse(gunzipSync(data).toString("utf8"));
  } catch {
    return null;
  }
}

function insertVersion(ws: string, n: Note, by: string | null, kind: VersionKind | `suggestion:${string}`, at: number, started = at): void {
  const data = encode(n);
  sql("INSERT INTO note_versions (ws, note_id, started, at, by, kind, title, bytes, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ws,
    n.id,
    started,
    at,
    by,
    kind,
    n.title.slice(0, 300),
    data.byteLength,
    data
  );
}

const who = (by: string | undefined | null): string | null => (by ? by.slice(0, 80) : null);

/** Keeps `after` as the page's current version (a new one, or the open session updated). */
function snapshot(ws: string, before: Note | null, after: Note, by: string | null, now: number): void {
  let last = sql("SELECT id, started, by, kind FROM note_versions WHERE ws = ? AND note_id = ? ORDER BY at DESC, id DESC LIMIT 1").get(ws, after.id) as
    | { id: number; started: number; by: string | null; kind: VersionKind }
    | undefined;
  // A page older than the history: its state before this first edit is the baseline.
  if (!last && before && !isBlank(before)) {
    const at = Math.min(before.updatedAt, now - 1);
    insertVersion(ws, before, who(before.editedBy), "edit", at);
    last = { id: -1, started: at, by: who(before.editedBy), kind: "edit" };
  }
  const gap = config.versionsGapMinutes * 60_000;
  if (last && last.id > 0 && last.kind === "edit" && last.by === by && now - last.started < gap) {
    const data = encode(after);
    sql("UPDATE note_versions SET at = ?, title = ?, bytes = ?, data = ? WHERE id = ?").run(now, after.title.slice(0, 300), data.byteLength, data, last.id);
    return;
  }
  insertVersion(ws, after, by, "edit", now);
  pruneNote(ws, after.id, now);
}

/** Who suggested what this write accepts (people's ids, in order, once each). */
export function acceptedSuggesters(before: Note, after: Note): string[] {
  const was = new Map((before.comments ?? []).map((c) => [c.id, c.suggestion?.state]));
  const out: string[] = [];
  for (const c of after.comments ?? []) {
    if (c.suggestion?.state !== "accepted" || was.get(c.id) === "accepted" || !c.authorId) continue;
    const who = personId(c.authorId);
    if (who && !out.includes(who)) out.push(who);
  }
  return out;
}

/**
 * The page as it would be with only this write's accepted suggestions taken
 * in (the rest as before): when it reads as `after` (block ids aside), the
 * write was nothing but accepting, and `after` itself is returned.
 */
export function acceptedOnly(before: Note, after: Note): Note {
  const was = new Map((before.comments ?? []).map((c) => [c.id, c.suggestion?.state]));
  let content: unknown = before.content;
  for (const c of after.comments ?? []) {
    if (!c.thread || c.suggestion?.state !== "accepted" || was.get(c.id) === "accepted") continue;
    content = decideSuggestion(content, c.thread, true, () => "accepted");
  }
  const noIds = (v: unknown): unknown => (Array.isArray(v) ? v.map(noIds) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "id").map(([k, x]) => [k, noIds(x)])) : v);
  const same = JSON.stringify(noIds(content)) === JSON.stringify(noIds(after.content)) && signature({ ...after, content: before.content }) === signature({ ...before, content: before.content, updatedAt: after.updatedAt });
  return same ? after : { ...before, content: content as Note["content"], comments: after.comments, updatedAt: after.updatedAt };
}

const personId = (id: string): string | null => (/^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : null);

/** A version's kind as stored ("suggestion:<who accepted>") as the API tells it. */
function kindOf(kind: string): { kind: VersionKind; acceptedBy?: string } {
  if (kind === "delete") return { kind: "delete" };
  if (kind.startsWith("suggestion:")) return { kind: "suggestion", acceptedBy: kind.slice(11) };
  return { kind: "edit" };
}

function event(ws: string, noteId: string, at: number, by: string | null, kind: EventKind, data?: Record<string, string | null>): void {
  sql("INSERT INTO note_events (ws, note_id, at, by, kind, data) VALUES (?, ?, ?, ?, ?, ?)").run(ws, noteId, at, by, kind, data ? JSON.stringify(data) : null);
}

/** The after-push reaction: versions and events of what was just saved. */
export function recordChanges(changes: readonly NoteChange[], ctx: PushContext, now = Date.now()): void {
  const by = who(ctx.by);
  let wrote = false;
  tx(() => {
    for (const c of changes) {
      const { before, after } = c;
      if (!after) {
        // Deleted forever: its last state stays (for a while) in the history.
        if (before) {
          insertVersion(ctx.ws, before, by, "delete", now);
          event(ctx.ws, c.id, now, by, "delete");
          wrote = true;
        }
        continue;
      }
      if (!before) {
        event(ctx.ws, c.id, now, by, "create");
        if (!isBlank(after)) {
          insertVersion(ctx.ws, after, by, "edit", now);
          wrote = true;
        }
        continue;
      }
      if (before.parentId !== after.parentId) event(ctx.ws, c.id, now, by, "move", { from: before.parentId, to: after.parentId });
      if (before.trashedAt === null && after.trashedAt !== null) event(ctx.ws, c.id, now, by, "trash");
      if (before.trashedAt !== null && after.trashedAt === null) event(ctx.ws, c.id, now, by, "restore");
      // Suggestions accepted in this write: the new state is their authors' (one version each).
      const accepted = acceptedSuggesters(before, after);
      if (accepted.length && by) {
        // The accepted text is its authors'; anything else the editor changed in the same write is the editor's.
        const onlyAccepted = acceptedOnly(before, after);
        for (const who of accepted) insertVersion(ctx.ws, onlyAccepted, who, `suggestion:${by}`, now);
        if (signature(onlyAccepted) !== signature(after)) snapshot(ctx.ws, onlyAccepted, after, by, now);
        pruneNote(ctx.ws, after.id, now);
        wrote = true;
      } else if (signature(before) !== signature(after)) {
        snapshot(ctx.ws, before, after, by, now);
        wrote = true;
      }
    }
  });
  if (wrote) enforceCap(ctx.ws, now);
}

onAfterPush("versions", (changes, ctx) => recordChanges(changes, ctx));

// ---------------------------------------------------------------------------
// Retention

/**
 * Which versions of a page stay: the newest `keepNewest`, everything newer
 * than `keepDays`, the last one of each day up to `maxDays`. The versions of
 * a page deleted forever go `deletedDays` after the deletion. Pure (tested).
 */
export function versionsToDrop(rows: readonly { id: number; at: number; kind: string }[], now: number, opts = retention()): number[] {
  const sorted = [...rows].sort((a, b) => b.at - a.at || b.id - a.id);
  if (sorted[0]?.kind === "delete" && now - sorted[0].at > opts.deletedDays * DAY) return sorted.map((r) => r.id);
  const drop: number[] = [];
  const days = new Set<number>();
  sorted.forEach((r, i) => {
    const age = now - r.at;
    const day = Math.floor(r.at / DAY);
    const firstOfDay = !days.has(day);
    days.add(day);
    if (i < opts.keepNewest || age < opts.keepDays * DAY) return;
    if (age < opts.maxDays * DAY && firstOfDay) return;
    drop.push(r.id);
  });
  return drop;
}

function retention() {
  return { keepNewest: config.versionsKeepNewest, keepDays: config.versionsKeepDays, maxDays: config.versionsMaxDays, deletedDays: config.versionsDeletedDays };
}

function dropIds(ids: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    n += Number(sql(`DELETE FROM note_versions WHERE id IN (${part.map(() => "?").join(",")})`).run(...part).changes);
  }
  return n;
}

export function pruneNote(ws: string, noteId: string, now = Date.now()): number {
  const rows = sql("SELECT id, at, kind FROM note_versions WHERE ws = ? AND note_id = ?").all(ws, noteId) as { id: number; at: number; kind: string }[];
  return dropIds(versionsToDrop(rows, now));
}

const lastCapCheck = (() => {
  const KEY = Symbol.for("zvena.notes.versionsCap");
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[KEY] ??= new Map());
})();

/** Over the workspace's cap: the oldest versions go (never a page's newest). Checked at most once a minute per workspace. */
export function enforceCap(ws: string, now = Date.now(), force = false): number {
  if (!force && now - (lastCapCheck.get(ws) ?? 0) < 60_000) return 0;
  lastCapCheck.set(ws, now);
  const cap = config.versionsWorkspaceBytes;
  let total = Number((sql("SELECT COALESCE(SUM(bytes), 0) AS b FROM note_versions WHERE ws = ?").get(ws) as { b: number }).b);
  if (cap === 0 || total <= cap) return 0;
  let dropped = 0;
  while (total > cap) {
    const rows = sql(
      "SELECT id, bytes FROM note_versions WHERE ws = ? AND id NOT IN (SELECT MAX(id) FROM note_versions WHERE ws = ? GROUP BY note_id) ORDER BY at ASC LIMIT 500"
    ).all(ws, ws) as { id: number; bytes: number }[];
    if (rows.length === 0) break;
    const ids: number[] = [];
    for (const r of rows) {
      if (total <= cap) break;
      ids.push(r.id);
      total -= Number(r.bytes);
    }
    dropped += dropIds(ids);
  }
  return dropped;
}

/** The daily upkeep: thinning, deleted pages' versions, old events and views. */
export function pruneHistory(now = Date.now()): { versions: number; events: number; views: number } {
  const opts = retention();
  let versions = 0;
  const notes = sql("SELECT DISTINCT ws, note_id FROM note_versions WHERE at < ?").all(now - Math.min(opts.keepDays, opts.deletedDays) * DAY) as { ws: string; note_id: string }[];
  for (const n of notes) versions += pruneNote(n.ws, n.note_id, now);
  const events = Number(sql("DELETE FROM note_events WHERE at < ?").run(now - opts.maxDays * DAY).changes);
  const views = Number(sql("DELETE FROM note_views WHERE at < ?").run(now - 365 * DAY).changes);
  return { versions, events, views };
}

// ---------------------------------------------------------------------------
// Reading

export function listVersions(ws: string, noteId: string, limit = 300): VersionMeta[] {
  return (
    sql("SELECT id, started, at, by, kind, title, bytes FROM note_versions WHERE ws = ? AND note_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(ws, noteId, limit) as {
      id: number;
      started: number;
      at: number;
      by: string | null;
      kind: string;
      title: string;
      bytes: number;
    }[]
  ).map((r) => ({ id: Number(r.id), started: Number(r.started), at: Number(r.at), by: r.by, ...kindOf(r.kind), title: r.title, bytes: Number(r.bytes) }));
}

/** One version as a note (sanitized: it may be shown and restored). */
export function readVersion(ws: string, noteId: string, id: number): { meta: VersionMeta; note: Note } | null {
  const r = sql("SELECT id, started, at, by, kind, title, bytes, data FROM note_versions WHERE ws = ? AND note_id = ? AND id = ?").get(ws, noteId, id) as
    | { id: number; started: number; at: number; by: string | null; kind: string; title: string; bytes: number; data: Uint8Array }
    | undefined;
  if (!r) return null;
  const body = decode(r.data);
  const note = sanitizeNote(typeof body === "object" && body !== null ? { ...body, id: noteId } : null);
  if (!note) return null;
  return {
    meta: { id: Number(r.id), started: Number(r.started), at: Number(r.at), by: r.by, ...kindOf(r.kind), title: r.title, bytes: Number(r.bytes) },
    note,
  };
}

export function eventsOf(ws: string, noteId: string, limit = 300): NoteEvent[] {
  return (
    sql("SELECT at, by, kind, data FROM note_events WHERE ws = ? AND note_id = ? ORDER BY at DESC LIMIT ?").all(ws, noteId, limit) as { at: number; by: string | null; kind: string; data: string | null }[]
  ).map((r) => {
    let data: { from?: string | null; to?: string | null } = {};
    try {
      data = r.data ? (JSON.parse(r.data) as typeof data) : {};
    } catch {
      data = {};
    }
    return { at: Number(r.at), by: r.by, kind: r.kind as EventKind, ...(r.kind === "move" ? { from: data.from ?? null, to: data.to ?? null } : {}) };
  });
}

/** Names of the people behind `ids` (user ids; "form" and "automation:…" are not people). */
export function namesOf(ids: Iterable<string | null>): Record<string, string> {
  const want = [...new Set([...ids].filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(x)))];
  const out: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 200) {
    const part = want.slice(i, i + 200);
    for (const r of sql(`SELECT id, name FROM users WHERE id IN (${part.map(() => "?").join(",")})`).all(...part) as { id: string; name: string }[]) out[r.id] = r.name;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Views (Analytics)

/** A member opened a page; true when it counted (one per person and page per 30 minutes; never for someone whose page view history is off). */
export function recordView(ws: string, noteId: string, userId: string, now = Date.now()): boolean {
  if (!keepsViews(userId)) return false;
  const recent = sql("SELECT 1 FROM note_views WHERE ws = ? AND note_id = ? AND user_id = ? AND at > ? LIMIT 1").get(ws, noteId, userId, now - VIEW_GAP);
  if (recent) return false;
  sql("INSERT INTO note_views (ws, note_id, user_id, at) VALUES (?, ?, ?, ?)").run(ws, noteId, userId, now);
  return true;
}

export interface PageAnalytics {
  views: number;
  viewers: number;
  /** Views per day, oldest first, the last entry being today (in the asker's time zone)… */
  days: number[];
  /** …and different people per day. */
  uniqueDays: number[];
  recentViewers: { id: string; name: string; at: number; views: number }[];
  editors: { id: string; name: string; at: number; versions: number }[];
}

/** `tz`: the asker's offset from UTC in minutes (as Date#getTimezoneOffset, negated: Tokyo = 540). */
export function analyticsOf(ws: string, noteId: string, now = Date.now(), tz = 0, span = 28): PageAnalytics {
  const offset = Math.max(-840, Math.min(840, Math.round(tz))) * 60_000;
  const totals = sql("SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM note_views WHERE ws = ? AND note_id = ?").get(ws, noteId) as { n: number; u: number };
  const today = Math.floor((now + offset) / DAY);
  const days = new Array<number>(span).fill(0);
  const people = Array.from({ length: span }, () => new Set<string>());
  for (const r of sql("SELECT at, user_id FROM note_views WHERE ws = ? AND note_id = ? AND at >= ?").all(ws, noteId, (today - span + 1) * DAY - offset) as { at: number; user_id: string }[]) {
    const i = Math.floor((Number(r.at) + offset) / DAY) - (today - span + 1);
    if (i < 0 || i >= span) continue;
    days[i] += 1;
    people[i].add(r.user_id);
  }
  const viewers = sql("SELECT user_id, MAX(at) AS at, COUNT(*) AS n FROM note_views WHERE ws = ? AND note_id = ? GROUP BY user_id ORDER BY at DESC LIMIT 50").all(ws, noteId) as {
    user_id: string;
    at: number;
    n: number;
  }[];
  const editors = sql("SELECT by, MAX(at) AS at, COUNT(*) AS n FROM note_versions WHERE ws = ? AND note_id = ? AND by IS NOT NULL GROUP BY by ORDER BY at DESC LIMIT 50").all(ws, noteId) as {
    by: string;
    at: number;
    n: number;
  }[];
  // Someone who turned their page view history off is not shown among the viewers.
  const hidden = hiddenViewers(viewers.map((v) => v.user_id));
  const names = namesOf([...viewers.map((v) => v.user_id), ...editors.map((e) => e.by)]);
  return {
    views: Number(totals.n),
    viewers: Number(totals.u),
    days,
    uniqueDays: people.map((p) => p.size),
    recentViewers: viewers.filter((v) => !hidden.has(v.user_id)).map((v) => ({ id: v.user_id, name: names[v.user_id] ?? "", at: Number(v.at), views: Number(v.n) })),
    editors: editors.map((e) => ({ id: e.by, name: names[e.by] ?? "", at: Number(e.at), versions: Number(e.n) })),
  };
}

/** Everything of a workspace (it is deleted). */
export function dropWorkspaceHistory(ws: string): void {
  sql("DELETE FROM note_versions WHERE ws = ?").run(ws);
  sql("DELETE FROM note_events WHERE ws = ?").run(ws);
  sql("DELETE FROM note_views WHERE ws = ?").run(ws);
}
