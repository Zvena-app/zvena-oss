// Server-only: real-time co-editing of a page (Notion's live collaboration).
//
// One room per open page (ws:noteId), hung off globalThis (Next bundles each
// route on its own; the stream and the POST must meet in the same room).
// A room holds the page's Yjs document and the awareness (who is here, their
// cursors); browsers stream what others do (GET /api/notes/collab, SSE) and
// send what they do (POST). Updates are applied here, relayed to the others
// and saved to note_ydocs within a second; the JSON snapshot of the page
// (notes.json) is written by the editors through the normal sync.

import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { config } from "../config";
import { sql } from "../store";
import { atLeast, levelOf } from "./access";
import { onAccessChanged } from "./access-events";
import { onAfterPush } from "./after-push";
import { COLLAB_FRAGMENT, COLLAB_MAX_STATE, COLLAB_META, toBase64, type CollabInit } from "./collab-shared";
import { canon, changedThreads, isCommentKey, markThread, threadStarters } from "./comment-marks";
import { blockSuggestion, isDelKey, isInsKey, ownsSuggestion, suggestionRecords, type Ownership, defaultSettings, SUGGESTABLE_TYPES } from "./suggestions";
import type { NoteComment } from "./types";

export interface CollabConn {
  /** The browser's id for this open page (one stream per page per tab). */
  id: string;
  userId: string;
  /** The person's role allows editing (before the editors limit). */
  mayEdit: boolean;
  /** Edits accepted from this connection (role and limit). */
  canEdit: boolean;
  /** May add and remove the marks of their own inline discussions (Can comment). */
  mayComment?: boolean;
  send: (event: string, data: string) => void;
  close: () => void;
  /** Awareness client ids this connection speaks for (removed when it goes). */
  aware: Set<number>;
}

interface Room {
  key: string;
  ws: string;
  noteId: string;
  doc: Y.Doc;
  awareness: Awareness;
  conns: Map<string, CollabConn>;
  /** Who may seed or reset the document now (one browser at a time). */
  lock: { conn: string; until: number } | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  /** Size of the saved state (refuses growth past COLLAB_MAX_STATE). */
  bytes: number;
  /** Suggestions a commenter brought in here whose record (by sync) has not arrived yet: their author. */
  suggesters: Map<string, string>;
}

const KEY = Symbol.for("zvena.notes.collab");
const g = globalThis as unknown as Record<symbol, Map<string, Room> | undefined>;
const rooms: Map<string, Room> = (g[KEY] ??= new Map());

const SAVE_DELAY = 1000;
const CLOSE_DELAY = 30_000;
const LOCK_MS = 10_000;

const roomKey = (ws: string, noteId: string) => `${ws}:${noteId}`;

function broadcast(room: Room, event: string, data: string, except?: string): void {
  for (const c of room.conns.values()) {
    if (c.id === except) continue;
    try {
      c.send(event, data);
    } catch {
      // A stream that went away is dropped on its abort.
    }
  }
}

/** The page exists on the server (a page just created reaches it with its first sync, a moment later). */
function pageSaved(ws: string, noteId: string): boolean {
  return Boolean(sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, noteId));
}

function save(room: Room): void {
  if (room.saveTimer) clearTimeout(room.saveTimer);
  room.saveTimer = null;
  if (!room.dirty) return;
  // Not yet synced: the state waits in memory (and goes with the room if the page never comes).
  if (!pageSaved(room.ws, room.noteId)) {
    if (room.conns.size) room.saveTimer = setTimeout(() => save(room), SAVE_DELAY * 3);
    return;
  }
  const state = Y.encodeStateAsUpdate(room.doc);
  sql("INSERT INTO note_ydocs (ws, note_id, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ws, note_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at").run(
    room.ws,
    room.noteId,
    state,
    Date.now()
  );
  room.bytes = state.byteLength;
  room.dirty = false;
}

function scheduleSave(room: Room): void {
  room.dirty = true;
  if (!room.saveTimer) room.saveTimer = setTimeout(() => save(room), SAVE_DELAY);
}

function dispose(room: Room): void {
  if (room.closeTimer) clearTimeout(room.closeTimer);
  room.closeTimer = null;
  try {
    save(room);
  } catch {
    // The database went away (tests closing it): nothing more to keep.
  }
  room.awareness.destroy();
  room.doc.destroy();
  rooms.delete(room.key);
}

/** The room of a page, loaded from note_ydocs on first use. */
export function openRoom(ws: string, noteId: string): Room {
  const key = roomKey(ws, noteId);
  const had = rooms.get(key);
  if (had) {
    if (had.closeTimer) clearTimeout(had.closeTimer);
    had.closeTimer = null;
    return had;
  }
  const doc = new Y.Doc();
  const row = sql("SELECT state FROM note_ydocs WHERE ws = ? AND note_id = ?").get(ws, noteId) as { state: Uint8Array } | undefined;
  let bytes = 0;
  if (row?.state?.byteLength) {
    try {
      Y.applyUpdate(doc, row.state);
      bytes = row.state.byteLength;
    } catch {
      // A broken state: the page reseeds from its JSON.
    }
  }
  const awareness = new Awareness(doc);
  // The server is not a participant.
  awareness.setLocalState(null);
  const room: Room = { key, ws, noteId, doc, awareness, conns: new Map(), lock: null, saveTimer: null, closeTimer: null, dirty: false, bytes, suggesters: new Map() };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    scheduleSave(room);
    broadcast(room, "update", toBase64(update), typeof origin === "string" ? origin : undefined);
  });
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const from = typeof origin === "string" ? room.conns.get(origin) : undefined;
    if (from) {
      for (const id of [...added, ...updated]) from.aware.add(id);
      for (const id of removed) from.aware.delete(id);
      // Someone who only reads shows as an avatar, never as a caret in the others' text (Notion).
      if (!from.canEdit) {
        for (const id of [...added, ...updated]) {
          const st = awareness.states.get(id) as Record<string, unknown> | undefined;
          if (st?.cursor) awareness.states.set(id, { ...st, cursor: null });
        }
      }
    }
    const changed = [...added, ...updated, ...removed];
    if (changed.length) broadcast(room, "awareness", toBase64(encodeAwarenessUpdate(awareness, changed)), from?.id);
  });
  rooms.set(key, room);
  return room;
}

export function findRoom(ws: string, noteId: string): Room | undefined {
  return rooms.get(roomKey(ws, noteId));
}

/** The document holds a session's content (a seed or an earlier session). */
export function seeded(room: Room): boolean {
  return room.doc.getMap(COLLAB_META).has("h");
}

/** People editing now (distinct), for the editors limit. */
function editorsNow(room: Room): Set<string> {
  return new Set([...room.conns.values()].filter((c) => c.canEdit).map((c) => c.userId));
}

/** Adds a browser to the room; returns what its stream sends first. */
/**
 * Re-checks everyone in a workspace's open rooms after its access changed:
 * whoever may no longer read the page is disconnected at once; whoever may
 * no longer edit keeps reading, their edits refused (as on the next POST).
 */
export function recheckRooms(ws: string): void {
  for (const room of rooms.values()) {
    if (room.ws !== ws) continue;
    for (const conn of [...room.conns.values()]) {
      const level = levelOf(ws, conn.userId, room.noteId);
      if (!level) {
        conn.close();
        continue;
      }
      const edit = atLeast(level, "edit");
      if (!edit) {
        conn.mayEdit = false;
        conn.canEdit = false;
      }
      conn.mayComment = !edit && atLeast(level, "comment");
    }
  }
}
onAccessChanged(recheckRooms);

export function join(room: Room, conn: Omit<CollabConn, "canEdit" | "aware">, now = Date.now()): { conn: CollabConn; init: CollabInit } {
  // The same browser reconnecting replaces its earlier stream.
  const old = room.conns.get(conn.id);
  if (old) {
    leave(room, old.id, { keepOpen: true });
    try {
      old.close();
    } catch {
      // Already gone.
    }
  }
  const limit = config.maxEditorsPerDoc;
  const editors = editorsNow(room);
  // Someone already editing keeps their place; a newcomer reads while the page is full.
  const full = conn.mayEdit && limit > 0 && !editors.has(conn.userId) && editors.size >= limit;
  const c: CollabConn = { ...conn, canEdit: conn.mayEdit && !full, aware: new Set() };
  room.conns.set(c.id, c);
  const isSeeded = seeded(room);
  let seed = false;
  if (c.canEdit && !isSeeded && (!room.lock || room.lock.until < now || room.lock.conn === c.id)) {
    room.lock = { conn: c.id, until: now + LOCK_MS };
    seed = true;
  }
  const states = [...room.awareness.getStates().keys()];
  const init: CollabInit = {
    state: toBase64(Y.encodeStateAsUpdate(room.doc)),
    sv: toBase64(Y.encodeStateVector(room.doc)),
    awareness: states.length ? toBase64(encodeAwarenessUpdate(room.awareness, states)) : "",
    seeded: isSeeded,
    seed,
    full,
    limit,
    canEdit: c.canEdit,
    canComment: !c.canEdit && Boolean(c.mayComment),
  };
  return { conn: c, init };
}

/** A browser left (its stream closed): its cursors go, and an empty room closes a little later. */
export function leave(room: Room, connId: string, opts: { keepOpen?: boolean } = {}): void {
  const c = room.conns.get(connId);
  if (!c) return;
  room.conns.delete(connId);
  if (room.lock?.conn === connId) room.lock = null;
  if (c.aware.size) removeAwarenessStates(room.awareness, [...c.aware], "leave");
  if (room.conns.size === 0 && !opts.keepOpen && !room.closeTimer) room.closeTimer = setTimeout(() => dispose(room), CLOSE_DELAY);
}

export type UpdateResult = "ok" | "forbidden" | "too large" | "bad";

/** A document update from a browser (already checked: it may edit). */
export function applyUpdate(room: Room, connId: string, update: Uint8Array): UpdateResult {
  const c = room.conns.get(connId);
  if (!c) return "forbidden";
  if (room.bytes + update.byteLength > COLLAB_MAX_STATE) return "too large";
  // Someone who may only comment: an update that marks or unmarks the text of their own
  // discussions, or that makes or takes back their own suggestions (lib/notes/suggestions.ts).
  if (!c.canEdit && !(c.mayComment && marksOnlyUpdate(room, update, c.userId))) return "forbidden";
  try {
    Y.applyUpdate(room.doc, update, connId);
  } catch {
    return "bad";
  }
  return "ok";
}

/**
 * A page's body as text and blocks with the suggestions `take` names taken
 * out (their inserted text and empty suggested blocks dropped, their deletion
 * marks removed), without discussion marks (runs a mark split are joined),
 * the characters each thread marks, and every suggestion on the page.
 */
function readBody(doc: Y.Doc, take: (sid: string) => boolean = () => false): { body: string; marked: Map<string, number>; suggestions: Set<string> } {
  const marked = new Map<string, number>();
  const suggestions = new Set<string>();
  const insOf = (attrs: Record<string, unknown> | undefined): string | null => {
    for (const [k, v] of Object.entries(attrs ?? {})) if (isInsKey(k)) return markThread(v);
    return null;
  };
  /** Child nodes; an own suggested block left with nothing in it is not the page. */
  const children = (node: Y.XmlFragment | Y.XmlElement): unknown[] => {
    const out: unknown[] = [];
    for (const x of node.toArray()) {
      const w = walk(x as Y.XmlElement);
      if (x instanceof Y.XmlElement) {
        const sid = blockSuggestion(x.getAttribute("id"));
        if (sid && take(sid) && emptyBlock(w)) continue;
      }
      out.push(w);
    }
    return out;
  };
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.XmlHook): unknown => {
    if (node instanceof Y.XmlText) {
      const out: { insert: unknown; attributes: Record<string, unknown> }[] = [];
      for (const op of node.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        const ins = insOf(op.attributes);
        if (ins) suggestions.add(ins);
        // One's own suggested text (or inline node) is not the page.
        if (ins && take(ins)) continue;
        const attributes: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(op.attributes ?? {})) {
          if (isCommentKey(k)) {
            const id = markThread(v);
            if (id) marked.set(id, (marked.get(id) ?? 0) + (typeof op.insert === "string" ? op.insert.length : 1));
          } else if (isDelKey(k)) {
            const id = markThread(v);
            if (id) suggestions.add(id);
            if (!id || !take(id)) attributes[k] = v;
          } else attributes[k] = v;
        }
        const insert = op.insert instanceof Y.AbstractType ? walk(op.insert as Y.XmlElement) : op.insert;
        const prev = out[out.length - 1];
        if (prev && typeof prev.insert === "string" && typeof insert === "string" && canon(prev.attributes) === canon(attributes)) prev.insert += insert;
        else out.push({ insert, attributes });
      }
      return { t: out };
    }
    if (node instanceof Y.XmlElement) {
      const sid = blockSuggestion(node.getAttribute("id"));
      if (sid) suggestions.add(sid);
      return { n: node.nodeName, a: node.getAttributes(), c: children(node) };
    }
    if (node instanceof Y.XmlFragment) return { c: children(node) };
    return { hook: true };
  };
  const body = canon([walk(doc.getXmlFragment(COLLAB_FRAGMENT)), doc.getMap(COLLAB_META).toJSON()]);
  return { body, marked, suggestions };
}

/**
 * A block as readBody reads it that a suggestion may leave empty and gone: a
 * line of text (paragraph, list item…) with default settings, no text and no
 * nested blocks. An embed, an image or a file is never one (it has no text to
 * be empty of), so it counts as a change to the page.
 */
function emptyBlock(w: unknown): boolean {
  const block = w as { a?: Record<string, unknown>; c?: unknown[] };
  if (!defaultSettings(block.a, ["id"])) return false;
  const c = block.c ?? [];
  if (c.length !== 1) return false;
  const content = c[0] as { n?: string; a?: Record<string, unknown>; c?: { t?: unknown[] }[] };
  if (typeof content.n !== "string" || !SUGGESTABLE_TYPES.has(content.n) || !defaultSettings(content.a)) return false;
  const inner = content.c ?? [];
  return inner.every((x) => Array.isArray(x.t) && x.t.length === 0);
}

/** The page's discussions as stored (who started each). */
function storedComments(room: Room): NoteComment[] {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(room.ws, room.noteId) as { json: string | null } | undefined;
  try {
    return (JSON.parse(r?.json ?? "null") as { comments?: NoteComment[] } | null)?.comments ?? [];
  } catch {
    return [];
  }
}

/**
 * Does this update change nothing but discussion marks — only on threads the
 * person started (or new ones, whose first comment comes by sync) — and the
 * person's own open suggestions? Tried on a copy; an update that leaves
 * anything pending (missing what it builds on) is refused, so nothing
 * unchecked can join the document later.
 */
export function marksOnlyUpdate(room: Room, update: Uint8Array, userId: string): boolean {
  const probe = new Y.Doc();
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(room.doc));
    const comments = storedComments(room);
    const { starters, decided } = suggestionRecords(comments);
    const present = readBody(probe).suggestions;
    const own: Ownership = { starters, decided, before: present, owners: room.suggesters };
    const take = (sid: string) => ownsSuggestion(own, sid, userId);
    const before = readBody(probe, take);
    Y.applyUpdate(probe, update);
    if (probe.store.pendingStructs || probe.store.pendingDs) return false;
    // Only the page body and the session data, as BlockNote keeps them.
    for (const k of probe.share.keys()) if (k !== COLLAB_FRAGMENT && k !== COLLAB_META) return false;
    const after = readBody(probe, take);
    if (before.body !== after.body) return false;
    const changed = changedThreads(before.marked, after.marked);
    const threads = threadStarters(comments);
    if (!changed.every((id) => !threads.has(id) || threads.get(id) === userId)) return false;
    // A new suggestion is this person's until its record arrives by sync.
    for (const sid of after.suggestions) if (!present.has(sid) && !starters.has(sid)) room.suggesters.set(sid, userId);
    return true;
  } catch {
    return false;
  } finally {
    probe.destroy();
  }
}

export function applyAwareness(room: Room, connId: string, update: Uint8Array): boolean {
  if (!room.conns.has(connId)) return false;
  try {
    applyAwarenessUpdate(room.awareness, update, connId);
    return true;
  } catch {
    return false;
  }
}

/** Asks for the right to seed or reset the document (one browser at a time, for a few seconds). */
export function claim(room: Room, connId: string, now = Date.now()): boolean {
  const c = room.conns.get(connId);
  if (!c?.canEdit) return false;
  if (room.lock && room.lock.until >= now && room.lock.conn !== connId) return false;
  room.lock = { conn: connId, until: now + LOCK_MS };
  return true;
}

/** The page was deleted for good: its room closes and its state goes. */
export function dropRoom(ws: string, noteId: string): void {
  const room = rooms.get(roomKey(ws, noteId));
  if (room) {
    broadcast(room, "gone", "");
    for (const c of room.conns.values()) c.close();
    room.conns.clear();
    room.dirty = false;
    dispose(room);
  }
  sql("DELETE FROM note_ydocs WHERE ws = ? AND note_id = ?").run(ws, noteId);
}

/** Writes every open room's state now (tests; a shutdown). */
export function flushRooms(): void {
  for (const r of rooms.values()) save(r);
}

/** Closes every room (tests). */
export function closeRooms(): void {
  for (const r of [...rooms.values()]) {
    for (const c of r.conns.values()) c.close();
    r.conns.clear();
    dispose(r);
  }
}

// A page deleted forever takes its Yjs state with it.
onAfterPush("collab", (changes, ctx) => {
  for (const ch of changes) if (ch.after === null) dropRoom(ctx.ws, ch.id);
});
