// Server-only: zvena Documents of a workspace, synced across devices and
// members, and public read-only copies (/n/<id>).
//
// Each note is stored whole as JSON under a server stamp (strictly
// increasing in this process). Devices pull what changed since their cursor
// and push what changed locally; the last write wins per note. Deleting
// forever leaves a tombstone so other devices drop the note too.

import { randomBytes } from "node:crypto";
import { emit } from "../pulse/bus";
import { sql, tx } from "../store";
import { AccessResolver, accessAnchor, atLeast, lastRevocation, principals, readableSets, revokedSince, settleAccess, subtreeOf } from "./access";
import { runAfterPush, type NoteChange } from "./after-push";
import { stampOwners } from "./automations";
import { cleanFields, withFields } from "./fields";
import { annotateSchema, deniedColumns, guardRow, guardSchema, stripRow, type Who } from "./column-perms";
import { nextStamp } from "./stamp";
import { guardWiki, type WikiPusher } from "./wiki-guard";
import { guardSources, type SourcePusher } from "./sources-guard";
import { viewSourceId } from "./sources";
import { canon } from "./comment-marks";
import { contributionOnly, dropUnsuggestable } from "./suggestions";
import { blankNote, safeUrl, sanitizeBlocks, sanitizeNote } from "./model";
import { cleanSiteOptions, siteExpired, type SiteOptions } from "./sites";
import { FORM_ID_RE, FORM_PROP_TYPES, NOTE_ID_RE, NOTE_LIMITS, SPACE_RE, type DbView, type FormCondition, type Note, type NoteComment, type PropType, type PropValue } from "./types";
import { shownQuestions } from "./form-logic";

export interface NotePull {
  notes: Note[];
  deleted: string[];
  cursor: number;
  more: boolean;
}

export interface NotePushItem {
  id: string;
  deleted?: boolean;
  note?: Note;
  /** The fields the device changed (lib/notes/fields.ts); absent: the whole note. */
  fields?: string[];
}

/**
 * Column permissions of one person (or integration) across a request: the
 * schemas of the databases their rows belong to, read once.
 */
class ColumnGuard {
  private schemas = new Map<string, Note | null>();
  constructor(
    private ws: string,
    private principal: string,
    private groups: ReadonlySet<string>,
    private fullOn: (dbId: string) => boolean,
    /** Full access on a note not stored yet (a database someone creates with permissions). */
    private fullOnNew: (note: Note) => boolean = () => false
  ) {}

  private database(id: string): Note | null {
    if (!this.schemas.has(id)) {
      const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(this.ws, id) as { json: string | null } | undefined;
      const n = storedNote(r?.json ?? null);
      this.schemas.set(id, n && n.kind === "database" ? n : null);
    }
    return this.schemas.get(id) ?? null;
  }

  private who(dbId: string): Who {
    return { id: this.principal, groups: this.groups, full: this.fullOn(dbId) };
  }

  /** What the person may not see or change in a database (formulas and rollups over hidden properties included). */
  private denied(db: Note, depth = 0): Map<string, "view" | "edit"> {
    return deniedColumns(db.db, this.who(db.id), (id) => {
      const other = depth < 2 && id !== db.id ? this.database(id) : null;
      return other?.db ? { schema: other.db, denied: this.denied(other, depth + 1) } : undefined;
    });
  }

  /** A note as this person may read it. */
  read(n: Note): Note {
    if (n.kind === "database" && n.db) {
      const denied = this.denied(n);
      return denied.size || n.db.properties.some((p) => p.perms) ? annotateSchema(n, this.who(n.id), denied) : n;
    }
    const db = n.parentId ? this.database(n.parentId) : null;
    return db ? stripRow(n, deniedColumns(db.db, this.who(db.id))) : n;
  }

  /** A pushed note as this person may write it (protected values and definitions as stored). */
  write(stored: Note | null, pushed: Note): Note {
    if (pushed.kind === "database") {
      if (stored ? this.fullOn(pushed.id) : this.fullOnNew(pushed)) {
        // Full access manages permissions; runtime marks never get stored.
        return pushed.db ? { ...pushed, db: { ...pushed.db, properties: pushed.db.properties.map(({ denied: _d, ...p }) => (void _d, p)) } } : pushed;
      }
      return guardSchema(stored, pushed);
    }
    let out = pushed;
    for (const dbId of new Set([pushed.parentId, stored?.parentId])) {
      const db = dbId ? this.database(dbId) : null;
      if (db) out = guardRow(stored, out, deniedColumns(db.db, this.who(db.id)));
    }
    return out;
  }
}

export function validNotePush(v: unknown): NotePushItem | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as { id?: unknown; deleted?: unknown; note?: unknown; fields?: unknown };
  if (typeof r.id !== "string" || !NOTE_ID_RE.test(r.id)) return null;
  if (r.deleted === true) return { id: r.id, deleted: true };
  const note = sanitizeNote(r.note);
  if (!note || note.id !== r.id) return null;
  const fields = cleanFields(r.fields);
  return { id: r.id, note, ...(fields ? { fields } : {}) };
}

/**
 * Notes written after `since`, oldest first, one page at a time. With a
 * `viewer` (a person's pull), only what they may read, each note with their
 * level (`access`), and the notes they lost since (in `deleted`).
 */
export function pullNotes(ws: string, since: number, viewer?: string): NotePull {
  const rows = sql("SELECT id, stamp, deleted, json FROM notes WHERE ws = ? AND stamp > ? ORDER BY stamp ASC LIMIT ?").all(
    ws,
    since,
    NOTE_LIMITS.pullPage + 1
  ) as { id: string; stamp: number; deleted: number; json: string | null }[];
  const more = rows.length > NOTE_LIMITS.pullPage;
  const page = more ? rows.slice(0, NOTE_LIMITS.pullPage) : rows;
  const acc = viewer ? new AccessResolver(ws, viewer) : null;
  const columns = acc ? new ColumnGuard(ws, acc.userId, acc.groups, (id) => acc.level(id) === "full") : null;
  const notes: Note[] = [];
  const deleted: string[] = [];
  for (const r of page) {
    // Unreadable notes are left out without a trace (deletions included).
    if (acc && acc.level(r.id) === null) continue;
    if (r.deleted) {
      deleted.push(r.id);
      continue;
    }
    try {
      const n = sanitizeNote(JSON.parse(r.json ?? "null"));
      const info = acc?.info(r.id);
      // Column permissions: values the person may not see stay on the server.
      if (n) notes.push(info && columns ? { ...columns.read(n), access: info } : n);
    } catch {
      // A corrupt row is skipped, not fatal for the whole pull.
    }
  }
  let cursor = page.length ? page[page.length - 1].stamp : since;
  if (acc && viewer) {
    // Revocations carry stamps of their own: those up to this page's end (all of them on the last page).
    const until = more ? cursor : Math.max(cursor, lastRevocation(ws, viewer));
    const have = new Set([...notes.map((n) => n.id), ...deleted]);
    for (const id of revokedSince(ws, viewer, since, until)) if (!have.has(id)) deleted.push(id);
    if (!more) cursor = until;
  }
  return { notes, deleted, cursor, more };
}

/** A stored note as one person may read it (column permissions); for other read paths such as history and export. */
export function readableFor(ws: string, userId: string, note: Note): Note {
  const acc = new AccessResolver(ws, userId);
  return new ColumnGuard(ws, userId, acc.groups, (id) => acc.level(id) === "full").read(note);
}

/** The server's copy of some notes (a device that was refused a change takes it back); unreadable or gone ones come as deleted. */
export function pullNotesById(ws: string, ids: readonly string[], viewer: string): { notes: Note[]; deleted: string[] } {
  const acc = new AccessResolver(ws, viewer);
  const columns = new ColumnGuard(ws, acc.userId, acc.groups, (id) => acc.level(id) === "full");
  const notes: Note[] = [];
  const deleted: string[] = [];
  for (const id of ids) {
    const r = sql("SELECT deleted, json FROM notes WHERE ws = ? AND id = ?").get(ws, id) as { deleted: number; json: string | null } | undefined;
    const info = r && !r.deleted ? acc.info(id) : null;
    const n = info ? storedNote(r?.json ?? null) : null;
    if (n && info) notes.push({ ...columns.read(n), access: info });
    else deleted.push(id);
  }
  return { notes, deleted };
}

export interface NotePushResult {
  stamp: number;
  saved: string[];
  rejected: { id: string; reason: string }[];
}

/**
 * Saves a batch (one transaction); oversize notes and quota overflows are
 * rejected per note. `quotaLeft` is what the workspace owner's storage quota
 * still allows (documents, files and designs share one quota). A commenter
 * may only change the comments of a note (`commentsOnly`): the rest of
 * the pushed note is ignored. With `author` (a person's push), comments are
 * merged by the rules of `mergeComments`. Whatever saved is announced on the
 * workspace's pulse (`origin`: the tab that wrote it).
 */
export function pushNotes(
  ws: string,
  items: NotePushItem[],
  opts: {
    by: string;
    quotaLeft: number;
    commentsOnly?: boolean;
    author?: string;
    /** A person's push: every note is checked against their level (lib/notes/access.ts); server-side writers pass none. */
    access?: { userId: string };
    /** The browser tab that wrote (its own pulse echo is skipped). */
    origin?: string;
    /** An integration's push (the API): its column permissions apply, as "integration:<id>". */
    columnsFor?: string;
  } = { by: "", quotaLeft: Infinity }
): NotePushResult {
  const key = ws;
  const saved: string[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const changes: NoteChange[] = [];
  let stamp = 0;
  const pusher = opts.access ? new AccessResolver(ws, opts.access.userId) : null;
  const guard = pusher
    ? new ColumnGuard(ws, pusher.userId, pusher.groups, (id) => pusher.level(id) === "full", (n) => pusher.levelForNew(n.parentId, n.space) === "full")
    : opts.columnsFor
      ? new ColumnGuard(ws, opts.columnsFor, new Set(), () => false)
      : null;
  // Wikis: who may verify a page or make a database a wiki (people; integrations never; server-side writers pass).
  const wikiWho: WikiPusher | null | undefined = pusher
    ? { userId: pusher.userId, full: (n, isNew) => (isNew ? pusher.levelForNew(n.parentId, n.space) : pusher.level(n.id)) === "full" }
    : opts.columnsFor
      ? null
      : undefined;
  // Data sources: a database points only at sources its pusher may read (forms: edit).
  const sourceWho: SourcePusher | null = pusher
    ? {
        canRead: (id) => pusher.level(id) !== null,
        canEdit: (id) => atLeast(pusher.level(id), "edit"),
        parentOf: (id) => (sql("SELECT parent_id FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(key, id) as { parent_id: string | null } | undefined)?.parent_id ?? null,
        exists: (id) => Boolean(sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(key, id)),
      }
    : null;
  const schemas = new Map<string, Note["db"]>();
  const schemaOf = (dbId: string) => {
    if (!schemas.has(dbId)) schemas.set(dbId, storedNote((sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(key, dbId) as { json: string | null } | undefined)?.json ?? null)?.db);
    return schemas.get(dbId);
  };
  tx(() => {
    const usage = sql("SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM notes WHERE ws = ? AND deleted = 0").get(key) as {
      bytes: number;
      n: number;
    };
    let bytes = Number(usage.bytes);
    let count = Number(usage.n);
    let added = 0;
    for (let item of items) {
      const prev = sql("SELECT bytes, deleted, json FROM notes WHERE ws = ? AND id = ?").get(key, item.id) as { bytes: number; deleted: number; json: string | null } | undefined;
      const stored = prev && !prev.deleted ? storedNote(prev.json) : null;
      // Only the fields the device changed land on the stored note (Notion merges per property).
      if (item.note && item.fields && stored) item = { ...item, note: withFields(stored, item.note, item.fields) };
      // A top-level page's section, as the server sees it.
      if (item.note) item = { ...item, note: withSpace(item.note, stored, opts.by) };
      // Column permissions: what the person may not change stays as stored.
      if (item.note && guard) item = { ...item, note: guard.write(stored, item.note) };
      // Automations and buttons run with their author's access: who that is, the server says.
      if (item.note) item = { ...item, note: stampOwners(stored, item.note, opts.by) };
      // Wiki verification and the wiki itself: what this pusher may not change stays as stored.
      if (item.note && wikiWho !== undefined) item = { ...item, note: guardWiki(stored, item.note, wikiWho, schemaOf) };
      if (item.note && sourceWho) item = { ...item, note: guardSources(stored, item.note, sourceWho) };
      // What this person may do with this note (a commenter's level: comments only).
      let commentsOnly = Boolean(opts.commentsOnly);
      let moved = false;
      if (opts.access) {
        const res = new AccessResolver(ws, opts.access.userId);
        const check = checkPush(res, item, stored);
        if (check === "forbidden") {
          rejected.push({ id: item.id, reason: "forbidden" });
          continue;
        }
        if (check === "comment") commentsOnly = true;
        moved = check === "moved";
        // Publishing is full access (Notion): what a page's `share` says changes only by someone with full access to it.
        if (item.note && !item.deleted) {
          const level = stored ? res.level(item.id) : res.levelForNew(item.note.parentId, item.note.space);
          if (level !== "full" && JSON.stringify(item.note.share ?? null) !== JSON.stringify(stored?.share ?? null)) {
            const { share: _planted, ...rest } = item.note;
            void _planted;
            item = { ...item, note: stored?.share ? { ...rest, share: stored.share } : rest };
          }
        }
      }
      if (commentsOnly && (item.deleted || !item.note || !stored)) {
        rejected.push({ id: item.id, reason: "read only" });
        continue;
      }
      if (item.note && opts.author !== undefined && (commentsOnly || item.note.comments?.length || stored?.comments?.length)) {
        const comments = mergeComments(stored?.comments ?? [], item.note.comments ?? [], opts.author, !commentsOnly, WHO_RE.test(opts.by) ? opts.by : undefined);
        // A commenter's push changes nothing but the comments of the stored note,
        // and in its body the marks of discussions they started (lib/notes/comment-marks.ts)
        // and their own open suggestions (lib/notes/suggestions.ts).
        const marks = Boolean(
          commentsOnly && stored && USER_RE.test(opts.by) && canon(stored.content) !== canon(item.note.content) && contributionOnly(stored.content, item.note.content, { stored: stored.comments, merged: comments }, opts.by)
        );
        const base: Note = commentsOnly && stored ? (marks ? { ...stored, content: item.note.content } : stored) : item.note;
        const { comments: _old, ...rest } = base;
        void _old;
        item = { ...item, note: comments.length ? { ...rest, comments } : rest };
      }
      // Who created and who last edited it: the server's word, not the device's.
      if (item.note) {
        const who = WHO_RE.test(opts.by) ? opts.by : undefined;
        const createdBy = stored ? stored.createdBy : who;
        const editedBy = commentsOnly ? stored?.editedBy : (who ?? stored?.editedBy);
        const { createdBy: _c, editedBy: _e, ...rest } = item.note;
        void _c;
        void _e;
        item = { ...item, note: { ...rest, ...(createdBy ? { createdBy } : {}), ...(editedBy ? { editedBy } : {}) } };
      }
      const prevBytes = prev && !prev.deleted ? Number(prev.bytes) : 0;
      stamp = nextStamp();
      if (item.deleted) {
        sql(
          "INSERT INTO notes (ws, id, stamp, client_at, deleted, bytes, json, updated_by) VALUES (?, ?, ?, ?, 1, 0, NULL, ?) ON CONFLICT(ws, id) DO UPDATE SET stamp = excluded.stamp, client_at = excluded.client_at, deleted = 1, bytes = 0, json = NULL, updated_by = excluded.updated_by"
        ).run(key, item.id, stamp, Date.now(), opts.by);
        // A page deleted for good takes its views with it (the privacy policy's word: "with the page").
        sql("DELETE FROM note_views WHERE ws = ? AND note_id = ?").run(key, item.id);
        bytes -= prevBytes;
        if (prev && !prev.deleted) count -= 1;
        saved.push(item.id);
        changes.push({ id: item.id, before: stored, after: null });
        continue;
      }
      let json = JSON.stringify(item.note);
      // A suggested block that may not be one (an embed, an image, a file…) never reaches a reader, whoever wrote it.
      if (item.note && json.includes('"sg~')) {
        item = { ...item, note: { ...item.note, content: dropUnsuggestable(item.note.content) as Note["content"] } };
        json = JSON.stringify(item.note);
      }
      const size = Buffer.byteLength(json);
      if (size > NOTE_LIMITS.noteBytes) {
        rejected.push({ id: item.id, reason: "too large" });
        continue;
      }
      const isNew = !prev || prev.deleted === 1;
      const grow = size - prevBytes;
      if (bytes + grow > NOTE_LIMITS.userBytes || (grow > 0 && grow > opts.quotaLeft - added) || (isNew && count + 1 > NOTE_LIMITS.userNotes)) {
        rejected.push({ id: item.id, reason: "quota" });
        continue;
      }
      // A move (another parent or section) changes who may read the subtree: compared before and after.
      const subtree = moved ? subtreeOf(ws, [item.id]) : [];
      const before = moved ? readableSets(ws, principals(ws), subtree) : null;
      sql(
        "INSERT INTO notes (ws, id, stamp, client_at, deleted, bytes, json, updated_by, parent_id, space) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT(ws, id) DO UPDATE SET stamp = excluded.stamp, client_at = excluded.client_at, deleted = 0, bytes = excluded.bytes, json = excluded.json, updated_by = excluded.updated_by, parent_id = excluded.parent_id, space = excluded.space"
      ).run(key, item.id, stamp, item.note?.updatedAt ?? Date.now(), size, json, opts.by, item.note?.parentId ?? null, item.note?.space ?? null);
      if (before) settleAccess(ws, subtree, before, new Set([item.id]));
      if (grow > 0) added += grow;
      bytes += grow;
      if (isNew) count += 1;
      saved.push(item.id);
      if (item.note) changes.push({ id: item.id, before: stored, after: item.note });
    }
  });
  runAfterPush(changes, { ws, by: opts.by, ...(opts.author !== undefined ? { author: opts.author } : {}) });
  // One poke names at most 50 notes (the bus's limit): a big push is announced in parts, so nothing is missed.
  for (let i = 0; i < saved.length; i += 50) {
    const part = saved.slice(i, i + 50);
    emit(ws, { type: "notes", ...(part.length === 1 ? { ref: part[0] } : { refs: part }), by: opts.by, origin: opts.origin });
  }
  return { stamp, saved, rejected };
}

/** A user id, "form", "automation:<id>" or "integration:<id>" (the same rule as the note sanitizer). */
const WHO_RE = /^(form|automation:[\w-]{1,40}|integration:[a-f0-9]{32}|[A-Za-z0-9_-]{6,64})$/;
const USER_RE = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * A top-level page's section as stored: the same as before, or the pusher's
 * own Private ("private" from a device), or a teamspace; sub-pages have none.
 */
function withSpace(note: Note, stored: Note | null, by: string): Note {
  const { space: want, ...rest } = note;
  if (note.parentId !== null || !want) return rest;
  if (stored && stored.parentId === null && want === stored.space) return { ...rest, space: want };
  if (want === "private" || want.startsWith("private:")) return USER_RE.test(by) ? { ...rest, space: `private:${by}` } : rest;
  return SPACE_RE.test(want) ? { ...rest, space: want } : rest;
}

/**
 * May the person write this note? "comment": only its comments (a
 * commenter's level); "moved": yes, and it changes place (who can read the
 * subtree is settled after the write).
 */
function checkPush(res: AccessResolver, item: NotePushItem, stored: Note | null): "ok" | "forbidden" | "comment" | "moved" {
  if (item.deleted) {
    // Deleting what is already gone (or never was) changes nothing for anyone.
    if (!stored) return res.present ? "ok" : "forbidden";
    return atLeast(res.level(item.id), "edit") ? "ok" : "forbidden";
  }
  const note = item.note as Note;
  if (!stored) return atLeast(res.levelForNew(note.parentId, note.space), "edit") ? "ok" : "forbidden";
  const level = res.level(item.id);
  if (!level || level === "view") return "forbidden";
  if (level === "comment") return "comment";
  if (note.parentId === stored.parentId && (note.space ?? null) === (stored.space ?? null)) return "ok";
  // Moving: edit where it goes, and full access when it leaves its section (that changes who reads it).
  if (!atLeast(res.levelForNew(note.parentId, note.space), "edit")) return "forbidden";
  const from = res.rootSpace(item.id);
  const to = note.parentId ? res.rootSpace(note.parentId) : (note.space ?? "");
  if (from !== to && level !== "full") return "forbidden";
  // …and when it leaves (or enters) a restricted or shared part of the tree: that changes who reads it too.
  if (level !== "full" && accessAnchor(res.ws, stored.parentId, from) !== accessAnchor(res.ws, note.parentId, to)) return "forbidden";
  // Never under itself (the app prevents it; a crafted push must not make a cycle).
  if (note.parentId && subtreeOf(res.ws, [item.id]).includes(note.parentId)) return "forbidden";
  return "moved";
}

function storedNote(json: string | null): Note | null {
  try {
    return sanitizeNote(JSON.parse(json ?? "null"));
  } catch {
    return null;
  }
}

/** A reaction adds or removes only the pusher's own name. */
function mergeReactions(prev: NoteComment["reactions"], next: NoteComment["reactions"], me: string): NoteComment["reactions"] {
  const out: Record<string, string[]> = {};
  for (const emoji of new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})])) {
    const base = prev?.[emoji] ?? [];
    const who = (next?.[emoji] ?? []).includes(me) ? (base.includes(me) ? base : [...base, me]) : base.filter((x) => x !== me);
    if (who.length) out[emoji] = who;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Comments as a person may leave them: a new comment is theirs (its author
 * is their name, whatever the device sent); they edit or delete only their
 * own; anyone who comments may resolve; a reaction changes only their own
 * name. Someone else's comment missing from the push is deleted only by an
 * editor (`moderator`) — a commenter's stale copy cannot drop it.
 * A suggested edit (`suggestion`) only ever opens its thread, and only an
 * editor accepts or rejects it (the server signs who and when); it is
 * resolved exactly when it is decided.
 */
export function mergeComments(prev: NoteComment[], next: NoteComment[], me: string, moderator: boolean, meId?: string): NoteComment[] {
  const before = new Map(prev.map((c) => [c.id, c]));
  // Own comments are known by the author's id (by name for comments older than ids).
  const mine = (c: NoteComment) => (c.authorId && meId ? c.authorId === meId : c.author === me);
  const signed = (c: NoteComment): NoteComment => ({ ...c, author: me, ...(meId ? { authorId: meId } : {}) });
  const pushed = new Set(next.map((c) => c.id));
  const out: NoteComment[] = [];
  const clean = (c: NoteComment, resolved: boolean | undefined, reactions: NoteComment["reactions"]): NoteComment => {
    const { resolved: _r, reactions: _x, ...rest } = c;
    void _r;
    void _x;
    return { ...rest, ...(resolved ? { resolved: true } : {}), ...(reactions ? { reactions } : {}) };
  };
  // Threads already open before this push (a suggestion cannot join one).
  const opened = new Set(prev.filter((c) => c.thread).map((c) => c.thread as string));
  const now = Date.now();
  /** A suggestion's decision as stored, or as an editor just made it (signed by them). */
  const decision = (p: NoteComment["suggestion"], n: NoteComment["suggestion"]): NonNullable<NoteComment["suggestion"]> => {
    if (!moderator || (p?.state ?? null) === (n?.state ?? null)) return p ?? {};
    return n?.state ? { state: n.state, ...(meId ? { by: meId } : {}), at: now } : {};
  };
  const suggestionOf = (c: NoteComment, s: NonNullable<NoteComment["suggestion"]>): NoteComment => {
    const { resolved: _r, ...rest } = c;
    void _r;
    return { ...rest, text: "", suggestion: s, ...(s.state ? { resolved: true } : {}) };
  };
  for (const n of next) {
    const p = before.get(n.id);
    if (p?.suggestion) {
      // The suggestion entry: its author, thread and time as stored; the decision an editor's.
      const s = decision(p.suggestion, n.suggestion);
      out.push(suggestionOf(clean(p, undefined, mergeReactions(p.reactions, n.reactions, me)), s));
      continue;
    }
    if (!p && n.suggestion) {
      // A new suggestion opens a thread of its own; nothing else may claim to be one.
      if (!n.thread || opened.has(n.thread) || next.some((x) => x.id !== n.id && x.thread === n.thread && x.at < n.at)) continue;
      opened.add(n.thread);
      out.push(suggestionOf(clean(signed(n), undefined, mergeReactions(undefined, n.reactions, me)), decision(undefined, n.suggestion)));
      continue;
    }
    const plain = n.suggestion ? (({ suggestion: _s, ...rest }) => (void _s, rest))(n) : n;
    if (!p) out.push(clean(signed(plain), plain.resolved, mergeReactions(undefined, plain.reactions, me)));
    else if (mine(p)) out.push(clean(signed(plain), plain.resolved, mergeReactions(p.reactions, plain.reactions, me)));
    else out.push(clean(p, plain.resolved, mergeReactions(p.reactions, plain.reactions, me)));
  }
  if (!moderator) for (const p of prev) if (!pushed.has(p.id) && !mine(p)) out.push(p);
  // Restored comments go back to their place (comments are kept in the order they were written).
  return out.sort((a, b) => a.at - b.at);
}

/** Drops tombstones older than 180 days (devices offline longer re-upload what they still have). */
export function purgeNoteTombstones(now = Date.now()): void {
  // Views of pages deleted before their views went with them.
  sql("DELETE FROM note_views WHERE EXISTS (SELECT 1 FROM notes n WHERE n.ws = note_views.ws AND n.id = note_views.note_id AND n.deleted = 1)").run();
  sql("DELETE FROM notes WHERE deleted = 1 AND stamp < ?").run(now - 180 * 86_400_000);
}

// ---------------------------------------------------------------------------
// Public pages

export interface NoteShareSnapshot {
  /** The shared page first, then its published sub-pages, databases and rows. */
  notes: Note[];
  rootId: string;
  /** Site settings (lib/notes/sites.ts): duplicating, indexing, SEO, expiry, layout, theme. */
  options?: SiteOptions;
}

export interface StoredNoteShare {
  id: string;
  title: string;
  snapshot: NoteShareSnapshot;
  createdAt: number;
  updatedAt: number;
}

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const NOTE_SHARE_ID_RE = /^[A-Za-z0-9]{16,40}$/;

function newShareId(): string {
  const bytes = randomBytes(22);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}

/**
 * What a public copy keeps of a note: the page itself, never what is the
 * owner's — share keys, comments (text, names, reactions), favorites, a
 * form's response link.
 */
function publicNote(n: Note): Note {
  const c: Note = { ...n, favorite: false };
  delete c.share;
  delete c.comments;
  // Who wrote it and whose Private it sits in are the workspace's, not the web's (they carry user ids).
  delete c.space;
  delete c.createdBy;
  delete c.editedBy;
  delete c.access;
  if (c.db?.views.some((v) => v.form?.shareId)) {
    c.db = {
      ...c.db,
      views: c.db.views.map((v) => {
        if (!v.form?.shareId) return v;
        const { shareId: _link, ...form } = v.form;
        void _link;
        return { ...v, form };
      }),
    };
  }
  return c;
}

export function validShareSnapshot(v: unknown): NoteShareSnapshot | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as { notes?: unknown; rootId?: unknown; options?: unknown };
  if (typeof r.rootId !== "string" || !Array.isArray(r.notes) || r.notes.length === 0 || r.notes.length > 2000) return null;
  const notes = r.notes
    .map(sanitizeNote)
    .filter((n): n is Note => n !== null)
    // Only safe URLs, and no inline-discussion marks.
    .map((n) => ({ ...publicNote(n), content: sanitizeBlocks(n.content) }));
  if (!notes.some((n) => n.id === r.rootId)) return null;
  const options = cleanSiteOptions(r.options);
  return { notes, rootId: r.rootId, ...(Object.keys(options).length ? { options } : {}) };
}

/**
 * A public copy never carries a column someone limited (column permissions):
 * the values of a property with a "who can see" list stay out, whoever
 * publishes, and no permission lists go public.
 */
function publicColumns(ws: string, snapshot: NoteShareSnapshot): NoteShareSnapshot {
  const hidden = new Map<string, Set<string>>();
  const of = (dbId: string): Set<string> => {
    let h = hidden.get(dbId);
    if (!h) {
      const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, dbId) as { json: string | null } | undefined;
      const db = storedNote(r?.json ?? null);
      h = new Set((db?.kind === "database" ? (db.db?.properties ?? []) : []).filter((p) => p.perms?.view).map((p) => p.id));
      hidden.set(dbId, h);
    }
    return h;
  };
  const notes = snapshot.notes.map((n) => {
    if (n.kind === "database" && n.db) return { ...n, db: { ...n.db, properties: n.db.properties.map(({ perms: _p, denied: _d, ...p }) => (void _p, void _d, p)) } };
    const h = n.parentId ? of(n.parentId) : null;
    if (!h?.size || !n.props) return n;
    return { ...n, props: Object.fromEntries(Object.entries(n.props).filter(([k]) => !h.has(k))) };
  });
  return { ...snapshot, notes };
}

/**
 * What a site of `rootId` may show, built here from the stored pages (never
 * from what a device sent): the page and what is under it that `by` can read
 * — not in the trash, and not below a page with restricted access of its own
 * (those stay as private as they are) — plus the synced blocks' content that
 * reads the same as the page. The device's copy only says which options.
 */
export function siteSnapshot(ws: string, by: string, rootId: string, options: SiteOptions | undefined): NoteShareSnapshot | null {
  const res = new AccessResolver(ws, by);
  const load = (id: string): Note | null => storedNote((sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined)?.json ?? null);
  const root = load(rootId);
  if (!root || res.level(rootId) !== "full") return null;
  const restricted = (id: string) => Boolean(sql("SELECT 1 FROM note_access WHERE ws = ? AND note_id = ? AND restricted = 1").get(ws, id));
  const anchor = accessAnchor(ws, rootId, res.rootSpace(rootId));
  const out = new Map<string, Note>([[rootId, root]]);
  // Breadth first from the root: a child joins when it can be read, is not in the trash and has no restriction of its own.
  const queue = [rootId];
  while (queue.length && out.size < 2000) {
    const parent = queue.shift() as string;
    for (const r of sql("SELECT id FROM notes WHERE ws = ? AND parent_id = ? AND deleted = 0").all(ws, parent) as { id: string }[]) {
      if (out.has(r.id) || restricted(r.id) || !res.level(r.id)) continue;
      const n = load(r.id);
      if (!n || n.trashedAt !== null) continue;
      out.set(r.id, n);
      queue.push(r.id);
    }
  }
  // Synced blocks show content kept in their own notes: those under the page came along; one elsewhere only when it reads the same.
  const seen = new Set<string>();
  for (const n of [...out.values()]) {
    for (const sid of syncedIdsOf(n.content)) {
      if (out.has(sid) || seen.has(sid) || out.size >= 2000) continue;
      seen.add(sid);
      const s = load(sid);
      if (!s?.synced || !res.level(sid) || s.parentId === null || accessAnchor(ws, sid, res.rootSpace(sid)) !== anchor) continue;
      out.set(sid, s);
    }
  }
  const notes = [...out.values()].map((n) => ({ ...publicNote(n), content: sanitizeBlocks(n.content) }));
  const clean = cleanSiteOptions(options);
  return { notes, rootId, ...(Object.keys(clean).length ? { options: clean } : {}) };
}

/** Synced-block note ids in a page's blocks. */
function syncedIdsOf(blocks: unknown): string[] {
  const out: string[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const b of list as { type?: string; props?: { noteId?: unknown }; children?: unknown }[]) {
      if (b?.type === "synced" && typeof b.props?.noteId === "string") out.push(b.props.noteId);
      walk(b?.children);
    }
  };
  walk(blocks);
  return out;
}

/** Whether the note has a public copy now (published, not taken down). */
export function noteShareLive(ws: string, noteId: string): { id: string; options: SiteOptions | undefined } | null {
  const r = sql("SELECT id, json FROM note_shares WHERE ws = ? AND note_id = ? AND removed_at IS NULL").get(ws, noteId) as { id: string; json: string } | undefined;
  if (!r) return null;
  try {
    return { id: r.id, options: (JSON.parse(r.json) as NoteShareSnapshot).options };
  } catch {
    return { id: r.id, options: undefined };
  }
}

/** Publishes the note or refreshes its public copy; returns the link id. */
export function saveNoteShare(ws: string, by: string, noteId: string, snapshot: NoteShareSnapshot): string {
  const now = Date.now();
  snapshot = publicColumns(ws, snapshot);
  const root = snapshot.notes.find((n) => n.id === snapshot.rootId);
  const title = (root?.title || "").slice(0, 300);
  const json = JSON.stringify(snapshot);
  const prev = sql("SELECT id, removed_at FROM note_shares WHERE ws = ? AND note_id = ?").get(ws, noteId) as { id: string; removed_at: number | null } | undefined;
  if (prev) {
    // A page taken down after a complaint stays down (a moderator restores it).
    if (prev.removed_at) throw new Error("removed");
    sql("UPDATE note_shares SET title = ?, json = ?, updated_at = ? WHERE id = ?").run(title, json, now, prev.id);
    return prev.id;
  }
  const id = newShareId();
  sql("INSERT INTO note_shares (id, ws, note_id, created_by, title, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, ws, noteId, by, title, json, now, now);
  return id;
}

export function readNoteShare(id: string, countView = false): StoredNoteShare | null {
  if (!NOTE_SHARE_ID_RE.test(id)) return null;
  const row = sql("SELECT id, title, json, created_at, updated_at FROM note_shares WHERE id = ? AND removed_at IS NULL").get(id) as
    | { id: string; title: string; json: string; created_at: number; updated_at: number }
    | undefined;
  if (!row) return null;
  try {
    const stored = JSON.parse(row.json) as NoteShareSnapshot;
    const options = cleanSiteOptions(stored.options);
    // An expired link shows nothing (noteShareExpired tells the page why).
    if (siteExpired(options)) return null;
    if (countView) countShareView(id);
    // Copies published before comments, the author's name and form links were
    // left out are served without them too.
    const snapshot: NoteShareSnapshot = { notes: stored.notes.map(publicNote), rootId: stored.rootId, ...(Object.keys(options).length ? { options } : {}) };
    return { id: row.id, title: row.title, snapshot, createdAt: row.created_at, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

/** Whether a public link exists but its expiry date has passed. */
export function noteShareExpired(id: string, now = Date.now()): boolean {
  if (!NOTE_SHARE_ID_RE.test(id)) return false;
  const row = sql("SELECT json_extract(json, '$.options.expiresAt') AS at FROM note_shares WHERE id = ? AND removed_at IS NULL").get(id) as { at: number | null } | undefined;
  return typeof row?.at === "number" && row.at <= now;
}

// Views by day (UTC) for the Publish panel's chart; the table is the
// public pages' own, created on first use.
const VIEWS_KEY = Symbol.for("zvena.notes.shareViewsTable");
function viewsTable(): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[VIEWS_KEY]) return;
  sql("CREATE TABLE IF NOT EXISTS note_share_views (id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, day))").run();
  g[VIEWS_KEY] = true;
}

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

function countShareView(id: string, now = Date.now()): void {
  sql("UPDATE note_shares SET views = views + 1 WHERE id = ?").run(id);
  viewsTable();
  sql("INSERT INTO note_share_views (id, day, n) VALUES (?, ?, 1) ON CONFLICT(id, day) DO UPDATE SET n = n + 1").run(id, utcDay(now));
}

/** The last `days` days of views (oldest first, zeros included), for members of its workspace; null: not theirs. */
export function noteShareViewsByDay(id: string, ws: string, days = 28, now = Date.now()): { day: string; n: number }[] | null {
  if (noteShareViews(id, ws) === null) return null;
  viewsTable();
  const from = utcDay(now - (days - 1) * 86_400_000);
  const rows = sql("SELECT day, n FROM note_share_views WHERE id = ? AND day >= ?").all(id, from) as { day: string; n: number }[];
  const byDay = new Map(rows.map((r) => [r.day, Number(r.n)]));
  return Array.from({ length: days }, (_, i) => {
    const day = utcDay(now - (days - 1 - i) * 86_400_000);
    return { day, n: byDay.get(day) ?? 0 };
  });
}

/** Published pages search engines may list (index on, not taken down or expired), newest first. */
export function indexedNoteShares(limit = 50_000, now = Date.now()): { id: string; updatedAt: number }[] {
  const rows = sql(
    "SELECT id, updated_at FROM note_shares WHERE removed_at IS NULL AND json_extract(json, '$.options.index') = 1 AND (json_extract(json, '$.options.expiresAt') IS NULL OR json_extract(json, '$.options.expiresAt') > ?) ORDER BY updated_at DESC LIMIT ?"
  ).all(now, limit) as { id: string; updated_at: number }[];
  return rows.map((r) => ({ id: r.id, updatedAt: Number(r.updated_at) }));
}

/** Whether a public page was taken down by a moderator. */
export function noteShareRemoved(id: string): boolean {
  if (!NOTE_SHARE_ID_RE.test(id)) return false;
  return Boolean(sql("SELECT 1 FROM note_shares WHERE id = ? AND removed_at IS NOT NULL").get(id));
}

/** How many times the public page was opened (members of its workspace; null: not theirs or gone). */
export function noteShareViews(id: string, ws: string): number | null {
  if (!NOTE_SHARE_ID_RE.test(id)) return null;
  const row = sql("SELECT views FROM note_shares WHERE id = ? AND ws = ?").get(id, ws) as { views: number } | undefined;
  return row ? Number(row.views) : null;
}

/** The page a public link of the workspace copies (for permission checks). */
export function noteShareNoteId(id: string, ws: string): string | null {
  if (!NOTE_SHARE_ID_RE.test(id)) return null;
  return (sql("SELECT note_id FROM note_shares WHERE id = ? AND ws = ?").get(id, ws) as { note_id: string } | undefined)?.note_id ?? null;
}

/** The database a form link of the workspace adds rows to. */
export function noteFormDbId(id: string, ws: string): string | null {
  if (!FORM_ID_RE.test(id)) return null;
  return (sql("SELECT db_id FROM note_forms WHERE id = ? AND ws = ?").get(id, ws) as { db_id: string } | undefined)?.db_id ?? null;
}

/** The workspace a public link belongs to (for permission checks). */
export function noteShareWorkspace(id: string): string | null {
  if (!NOTE_SHARE_ID_RE.test(id)) return null;
  const row = sql("SELECT ws FROM note_shares WHERE id = ?").get(id) as { ws: string } | undefined;
  return row?.ws ?? null;
}

export function deleteNoteShare(id: string, ws: string): boolean {
  return Number(sql("DELETE FROM note_shares WHERE id = ? AND ws = ? AND removed_at IS NULL").run(id, ws).changes) > 0;
}

// ---------------------------------------------------------------------------
// Forms (/f/<id>): a public link to a form view of a signed-in user's
// database. The questions are read from the synced database at request
// time, so the link always shows the current form; each response is saved
// as a new row of that database (and reaches the owner's devices by sync).

/** A form as respondents see it (no other data of the owner). */
export interface PublicForm {
  id: string;
  title: string;
  description: string;
  icon: string;
  thanks: string;
  questions: { prop: string; type: PropType; name: string; help: string; required: boolean; options?: { id: string; name: string; color: string }[]; when?: FormCondition }[];
  /** Only signed-in members of the workspace may answer. */
  membersOnly: boolean;
  /** Members' responses do not say who sent them. */
  anonymous: boolean;
}

/** Opens (or returns) the public link of a form view. */
export function openNoteForm(ws: string, dbId: string, viewId: string, now = Date.now()): string {
  const prev = sql("SELECT id, removed_at FROM note_forms WHERE ws = ? AND db_id = ? AND view_id = ?").get(ws, dbId, viewId) as { id: string; removed_at: number | null } | undefined;
  if (prev) {
    if (prev.removed_at) throw new Error("removed");
    return prev.id;
  }
  const id = randomBytes(16).toString("base64url").slice(0, 22);
  sql("INSERT INTO note_forms (id, ws, db_id, view_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, ws, dbId, viewId, now);
  return id;
}

/** Stops a form from accepting responses (its link then says so). */
export function closeNoteForm(id: string, ws: string): boolean {
  return Number(sql("DELETE FROM note_forms WHERE id = ? AND ws = ? AND removed_at IS NULL").run(id, ws).changes) > 0;
}

/** Whether the note or one of its ancestors is in the trash (only a trashed subtree's root carries trashedAt). */
export function inTrash(ws: string, note: Pick<Note, "parentId" | "trashedAt">): boolean {
  let cur: Pick<Note, "parentId" | "trashedAt"> | null = note;
  for (let depth = 0; cur && depth < 100; depth++) {
    if (cur.trashedAt !== null) return true;
    if (!cur.parentId) return false;
    const rec = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, cur.parentId) as { json: string | null } | undefined;
    try {
      const p = JSON.parse(rec?.json ?? "null") as Note | null;
      cur = p ? { parentId: p.parentId ?? null, trashedAt: p.trashedAt ?? null } : null;
    } catch {
      cur = null;
    }
  }
  return false;
}

/**
 * The data source a form view of a database adds rows to: the database
 * itself, one of its own further data sources, or one linked into it.
 */
function formSource(ws: string, db: Note, view: DbView): Note | null {
  const srcId = viewSourceId(db.id, view);
  if (srcId === db.id) return db;
  const rec = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, srcId) as { json: string | null } | undefined;
  const src = storedNote(rec?.json ?? null);
  if (!src || src.kind !== "database" || !src.db || inTrash(ws, src)) return null;
  const own = src.parentId === db.id && src.db.dataSource === true;
  return own || db.db?.linked?.includes(src.id) ? src : null;
}

/** The data source a database's form view adds rows to (null: not a form of a data source it may use). */
export function noteFormSource(ws: string, dbId: string, viewId: string): string | null {
  const db = storedNote((sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, dbId) as { json: string | null } | undefined)?.json ?? null);
  const view = db?.db?.views.find((v) => v.id === viewId);
  if (!db || !view || view.type !== "form") return null;
  return formSource(ws, db, view)?.id ?? null;
}

/** The form behind a link: open, still a form view, and still pointing at this link. */
function formTarget(id: string): { ws: string; db: Note; view: DbView; src: Note } | null {
  if (!FORM_ID_RE.test(id)) return null;
  const row = sql("SELECT ws, db_id, view_id FROM note_forms WHERE id = ? AND removed_at IS NULL").get(id) as { ws: string; db_id: string; view_id: string } | undefined;
  if (!row) return null;
  const rec = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(row.ws, row.db_id) as { json: string | null } | undefined;
  let db: Note | null = null;
  try {
    db = sanitizeNote(JSON.parse(rec?.json ?? "null"));
  } catch {
    db = null;
  }
  if (!db || db.kind !== "database" || !db.db || inTrash(row.ws, db)) return null;
  const view = db.db.views.find((v) => v.id === row.view_id);
  if (!view || view.type !== "form" || view.form?.shareId !== id) return null;
  // The rows go to the view's data source (the database's own unless it names another).
  const src = formSource(row.ws, db, view);
  if (!src) return null;
  return { ws: row.ws, db, view, src };
}

export function readNoteForm(id: string): PublicForm | null {
  const target = formTarget(id);
  if (!target) return null;
  const { db, view, src } = target;
  const form = view.form ?? { questions: [] };
  const questions: PublicForm["questions"] = [];
  for (const q of form.questions) {
    const p = src.db?.properties.find((x) => x.id === q.prop);
    if (!p || !FORM_PROP_TYPES.includes(p.type)) continue;
    questions.push({
      prop: p.id,
      type: p.type,
      name: p.name,
      help: q.help ?? "",
      required: !!q.required,
      ...(p.options ? { options: p.options.map((o) => ({ id: o.id, name: o.name, color: o.color })) } : {}),
      ...(q.when ? { when: q.when } : {}),
    });
  }
  return { id, title: form.title || db.title, description: form.description ?? "", icon: db.icon, thanks: form.thanks ?? "", questions, membersOnly: form.access === "workspace", anonymous: !!form.anonymous };
}

/** One answer checked against its question; undefined = left empty. */
function formAnswer(q: PublicForm["questions"][number], v: unknown): PropValue | undefined | "invalid" {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || v === false) return undefined;
  const optionIds = new Set((q.options ?? []).map((o) => o.id));
  switch (q.type) {
    case "title":
    case "text":
    case "phone":
      return typeof v === "string" ? v.slice(0, q.type === "text" ? 20_000 : 2000) : "invalid";
    case "email":
      return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().slice(0, 320) : "invalid";
    case "url":
      if (typeof v !== "string") return "invalid";
      return safeUrl(/^[a-z][a-z0-9+.-]*:/i.test(v.trim()) ? v.trim() : `https://${v.trim()}`) ? v.trim().slice(0, 2000) : "invalid";
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : "invalid";
    case "select":
    case "status":
      return typeof v === "string" && optionIds.has(v) ? v : "invalid";
    case "multi_select":
      return Array.isArray(v) && v.every((x) => typeof x === "string" && optionIds.has(x)) ? [...new Set(v as string[])] : "invalid";
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? { start: v } : "invalid";
    case "checkbox":
      return v === true ? true : "invalid";
    default:
      return "invalid";
  }
}

export type FormSubmitResult = { ok: true; rowId: string } | { ok: false; status: number; error: string; prop?: string };

/** The form as a visitor may see it: a members-only form shows anyone else its title and description only (never its questions). */
export function formForVisitor(id: string, member: boolean): PublicForm | null {
  const form = readNoteForm(id);
  if (!form || !form.membersOnly || member) return form;
  return { ...form, thanks: "", questions: [] };
}

/** Whether someone is a member of the form's workspace (who may answer a members-only form, and whose response is theirs). */
export function formRespondent(id: string, userId: string | null): { member: boolean } {
  const target = userId ? formTarget(id) : null;
  return { member: Boolean(target && sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(target.ws, userId)) };
}

/**
 * Saves a response as a new row at the end of the database. `userId`: the
 * signed-in person answering, if any — a members-only form needs a member;
 * a member's response is created by them unless the form is anonymous
 * (anyone else's never says who sent it).
 */
export function submitNoteForm(id: string, answers: unknown, now = Date.now(), userId: string | null = null): FormSubmitResult {
  const target = formTarget(id);
  const form = target && readNoteForm(id);
  if (!target || !form) return { ok: false, status: 404, error: "closed" };
  const member = formRespondent(id, userId).member;
  if (form.membersOnly && !member) return { ok: false, status: userId ? 403 : 401, error: userId ? "members only" : "sign in" };
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return { ok: false, status: 400, error: "bad request" };
  const given = answers as Record<string, unknown>;
  const props: Record<string, PropValue> = {};
  let title = "";
  // Conditional logic: a question hidden by the answers is neither required nor kept.
  const shown = shownQuestions(form.questions, given);
  for (const q of form.questions) {
    if (!shown.has(q.prop)) continue;
    const v = formAnswer(q, given[q.prop]);
    if (v === "invalid") return { ok: false, status: 400, error: "invalid", prop: q.prop };
    if (v === undefined) {
      if (q.required) return { ok: false, status: 400, error: "required", prop: q.prop };
      continue;
    }
    if (q.type === "title") title = String(v).trim();
    else props[q.prop] = v;
  }
  // After the database's last row (rows are ordered by a fractional key).
  let last = 0;
  const rows = sql("SELECT json FROM notes WHERE ws = ? AND deleted = 0 AND parent_id = ?").all(target.ws, target.src.id) as { json: string | null }[];
  for (const r of rows) {
    try {
      const n = JSON.parse(r.json ?? "null") as { parentId?: string; order?: number } | null;
      if (n?.parentId === target.src.id && typeof n.order === "number" && n.order > last) last = n.order;
    } catch {
      // Unreadable rows do not block a response.
    }
  }
  const row = sanitizeNote(blankNote({ kind: "page", parentId: target.src.id, title, props, order: last ? last + 1024 : now, createdAt: now, updatedAt: now }));
  if (!row) return { ok: false, status: 400, error: "bad request" };
  // Form answers count against the workspace like any row, without a per-person quota check.
  const res = pushNotes(target.ws, [{ id: row.id, note: row }], { by: member && !form.anonymous && userId ? userId : "form", quotaLeft: Infinity });
  if (!res.saved.includes(row.id)) return { ok: false, status: 507, error: res.rejected[0]?.reason ?? "unavailable" };
  sql("UPDATE note_forms SET responses = responses + 1 WHERE id = ?").run(id);
  return { ok: true, rowId: row.id };
}
