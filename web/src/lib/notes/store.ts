// zvena Documents: the browser-side store.
//
// All notes live in memory (a Map) and in IndexedDB, so the workspace opens
// instantly, works offline and needs no account. Signed-in users also sync
// with the server (sync.ts pushes `pending` and merges what others wrote).
// React reads through useSyncExternalStore: every change bumps `version` and
// rebuilds one immutable snapshot.

import { patchFields, withFields } from "./fields";
import { blankNote, isSourceNote, newNoteId, orderBetween, remapNote, subtreeIds, treeChildren } from "./model";
import type { Note } from "./types";

export interface HistoryEntry {
  key: string;
  noteId: string;
  at: number;
  title: string;
  content: unknown[];
}

export interface NotesSnapshot {
  version: number;
  ready: boolean;
  /** Every note, trashed included (synced-block contents only in byId: they are never listed). */
  list: readonly Note[];
  byId: ReadonlyMap<string, Note>;
}

interface Meta {
  /** Whose notes these are: "" = guest (this browser only), else the account email. */
  owner: string;
  /** Sync cursor (server stamp). */
  cursor: number;
  /** Recently opened pages, newest first. */
  recent: { id: string; at: number }[];
  /** Expanded sidebar rows. */
  expanded: string[];
  /** Notes changed here and not yet confirmed by the server. */
  pending: string[];
  /** Notes deleted forever here, not yet confirmed by the server. */
  deleted: string[];
  /** The onboarding page was created once (never again, even if deleted). */
  seeded: boolean;
  /** Per pending note, the fields changed here since the server confirmed it ("*": the whole note). */
  fields?: Record<string, string[]>;
}

const DB_NAME = "zvena-docs";
const DB_VERSION = 2;
const META_KEY = "meta";
/** A guest's pages put aside while the account opens a shared workspace (the personal one adopts them). */
const GUEST_KEY = "guest";

/** What a tab tells the others after writing (`owner`: whose store it wrote). */
interface ChangeMsg {
  owner?: string;
  ids?: string[];
  removed?: string[];
}

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      // v2: page history (local snapshots, newest restorable).
      if (!db.objectStoreNames.contains("history")) {
        const h = db.createObjectStore("history", { keyPath: "key" });
        h.createIndex("noteId", "noteId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const EMPTY_META: Meta = { owner: "", cursor: 0, recent: [], expanded: [], pending: [], deleted: [], seeded: false };

type Listener = () => void;

export class NotesStore {
  private notes = new Map<string, Note>();
  private listeners = new Set<Listener>();
  private snap: NotesSnapshot = { version: 0, ready: false, list: [], byId: new Map() };
  private db: IDBDatabase | null = null;
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  /** This tab is switching the browser's store to another owner (account / workspace): the next write may replace the other's. */
  private claim = false;
  /** Another tab switched the store to another owner: this tab keeps its notes in memory only and never writes over that store. */
  private detached = false;
  private loaded = false;
  /** Notes this tab changed or deleted since its last write (another tab's meta does not list them yet). */
  private unsaved = new Set<string>();
  meta: Meta = { ...EMPTY_META };
  /** Called after local changes (sync.ts schedules a push). */
  onLocalChange: (() => void) | null = null;
  /** Another tab took this browser's copy for another workspace (this tab now keeps its changes in memory). */
  onDetached: (() => void) | null = null;
  /**
   * Favorites of the signed-in person (Notion's are personal): null for a
   * guest's local workspace, where the star stays on the note itself.
   */
  private favorites: Set<string> | null = null;
  /** A favorite was added or removed here (sync sends it). */
  onFavorite: ((id: string, on: boolean) => void) | null = null;
  /** The section new top-level pages land in ("private" for a signed-in member; none on a guest device). */
  private defaultSpace: string | undefined = undefined;
  setDefaultSpace(space: string | undefined): void {
    this.defaultSpace = space;
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): NotesSnapshot => this.snap;

  private emit(): void {
    const fav = this.favorites;
    // The person's own favorites show through `favorite`, so the UI reads one field either way.
    const shown = (n: Note) => (fav === null || n.favorite === fav.has(n.id) ? n : { ...n, favorite: fav.has(n.id) });
    const byId = fav === null ? new Map(this.notes) : new Map([...this.notes].map(([id, n]) => [id, shown(n)]));
    const list = [...byId.values()].filter((n) => !n.synced);
    this.snap = { version: this.snap.version + 1, ready: true, list, byId };
    for (const fn of this.listeners) fn();
  }

  async load(): Promise<void> {
    // Documents opened again in the same tab (the rail routes on the client):
    // the copy in memory is current (other tabs reach it through the channel).
    if (this.loaded) {
      // Another tab took this browser's copy meanwhile: a fresh page, as before.
      if (this.detached) {
        location.reload();
        return new Promise<void>(() => {});
      }
      return this.emit();
    }
    this.loaded = true;
    this.db = await openDb();
    if (this.db) {
      try {
        const t = this.db.transaction(["notes", "kv"], "readonly");
        const [rows, meta] = await Promise.all([
          reqDone(t.objectStore("notes").getAll() as IDBRequest<Note[]>),
          reqDone(t.objectStore("kv").get(META_KEY) as IDBRequest<Meta | undefined>),
        ]);
        for (const n of rows) this.notes.set(n.id, n);
        if (meta) this.meta = { ...EMPTY_META, ...meta };
      } catch {
        // A broken store still lets the workspace run in memory.
      }
    }
    try {
      this.channel = new BroadcastChannel(DB_NAME);
      this.channel.onmessage = (e: MessageEvent<ChangeMsg>) => void this.reloadFromDisk(e.data);
    } catch {
      this.channel = null;
    }
    this.emit();
  }

  /** Another tab changed these notes: read them back from IndexedDB. */
  private async reloadFromDisk(msg: ChangeMsg): Promise<void> {
    // Another account's or workspace's store (a tab switched it): none of this tab's notes.
    if (!this.db || this.detached || msg.owner !== this.meta.owner) return;
    let changed = false;
    for (const id of msg.removed ?? []) changed = this.notes.delete(id) || changed;
    try {
      const t = this.db.transaction(["notes", "kv"], "readonly");
      const os = t.objectStore("notes");
      for (const id of msg.ids ?? []) {
        const n = await reqDone(os.get(id) as IDBRequest<Note | undefined>);
        const cur = this.notes.get(id);
        // This tab's own newer edit, not written yet, stays.
        if (n && !(cur && (this.dirty.has(id) || this.unsaved.has(id)) && cur.updatedAt > n.updatedAt)) {
          this.notes.set(id, n);
          changed = true;
        }
      }
      const meta = await reqDone(t.objectStore("kv").get(META_KEY) as IDBRequest<Meta | undefined>);
      // The other tab's meta, plus what this tab has queued since its own last
      // write (the other tab's write must not drop this tab's unsent edits).
      if (meta && meta.owner === this.meta.owner) {
        const mine = (ids: readonly string[]) => ids.filter((id) => this.unsaved.has(id));
        const myFields = Object.fromEntries(Object.entries(this.meta.fields ?? {}).filter(([id]) => this.unsaved.has(id)));
        this.meta = { ...EMPTY_META, ...meta, expanded: this.meta.expanded, pending: union(meta.pending ?? [], mine(this.meta.pending)), deleted: union(meta.deleted ?? [], mine(this.meta.deleted)), fields: { ...(meta.fields ?? {}), ...myFields } };
      }
    } catch {
      // Keep what we have.
    }
    if (changed) {
      this.emit();
      this.externalListeners.forEach((fn) => fn(msg.ids ?? []));
    }
  }

  /** Listeners told when notes change outside this tab's editing (other tabs, sync). */
  private externalListeners = new Set<(ids: string[]) => void>();
  onExternalChange(fn: (ids: string[]) => void): () => void {
    this.externalListeners.add(fn);
    return () => this.externalListeners.delete(fn);
  }

  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), 250);
  }

  /** Writes changed notes and the meta record to IndexedDB. */
  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const ids = [...this.dirty];
    const removed = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    if (!this.db || this.detached) return;
    const owner = this.meta.owner;
    const claim = this.claim;
    let foreign = false;
    let written: string[] = [];
    try {
      const t = this.db.transaction(["notes", "kv"], "readwrite");
      const os = t.objectStore("notes");
      const kv = t.objectStore("kv");
      const check = kv.get(META_KEY) as IDBRequest<Meta | undefined>;
      check.onsuccess = () => {
        // One store per browser: when another tab has opened another account's
        // or workspace's documents in it, writing this tab's notes there would
        // mix the two (and sync them into the wrong workspace).
        if (!claim && check.result && check.result.owner !== owner) {
          foreign = true;
          t.abort();
          return;
        }
        for (const id of ids) {
          const n = this.notes.get(id);
          if (n) os.put(n);
        }
        // A note deleted and then brought back (sync) before this write stays.
        for (const id of removed) if (!this.notes.has(id)) os.delete(id);
        kv.put(this.meta, META_KEY);
        written = [...this.unsaved];
      };
      await txDone(t);
      written.forEach((id) => this.unsaved.delete(id));
      if (claim && this.meta.owner === owner) this.claim = false;
      if (ids.length || removed.length) this.channel?.postMessage({ owner, ids, removed } satisfies ChangeMsg);
    } catch {
      if (foreign) {
        this.detached = true;
        this.onDetached?.();
        return;
      }
      // Quota or a closed connection: the notes stay in memory and the
      // next change retries.
      ids.forEach((id) => this.dirty.add(id));
      removed.forEach((id) => this.removed.add(id));
    }
  }

  saveMeta(patch: Partial<Meta>): void {
    if (patch.owner !== undefined && patch.owner !== this.meta.owner) this.claim = true;
    // Changed fields are kept only for notes still pending.
    if (patch.pending && this.meta.fields && patch.fields === undefined) {
      const keep = new Set(patch.pending);
      patch = { ...patch, fields: Object.fromEntries(Object.entries(this.meta.fields).filter(([id]) => keep.has(id))) };
    }
    this.meta = { ...this.meta, ...patch };
    this.schedule();
  }

  get(id: string): Note | undefined {
    return this.notes.get(id);
  }

  all(): Note[] {
    return [...this.notes.values()];
  }

  private touch(id: string, local: boolean): void {
    this.dirty.add(id);
    if (local) this.unsaved.add(id);
    if (local && !this.meta.pending.includes(id)) this.meta = { ...this.meta, pending: [...this.meta.pending, id] };
    this.schedule();
    if (local) this.onLocalChange?.();
  }

  private localWriters = new Set<(prev: Note | undefined, next: Note) => void>();

  /** Listens to this device's own writes (not to notes that sync brings in). */
  onLocalWrite(fn: (prev: Note | undefined, next: Note) => void): () => void {
    this.localWriters.add(fn);
    return () => this.localWriters.delete(fn);
  }

  /** Saves a note as given (new or replaced) — a local edit. */
  put(n: Note): Note {
    const prev = this.notes.get(n.id);
    this.notes.set(n.id, n);
    this.markFields(n.id, ["*"]);
    this.touch(n.id, true);
    this.emit();
    this.localWriters.forEach((fn) => fn(prev, n));
    return n;
  }

  /** Merges a patch; `quiet` keeps updatedAt (view state such as expanded rows). */
  update(id: string, patch: Partial<Note>, opts?: { quiet?: boolean }): Note | undefined {
    const cur = this.notes.get(id);
    if (!cur) return undefined;
    if (this.favorites !== null && patch.favorite !== undefined) {
      const { favorite, ...rest } = patch;
      this.setFavorite(id, favorite);
      if (Object.keys(rest).length === 0) return cur;
      patch = rest;
    }
    if (!opts?.quiet && (patch.content !== undefined || patch.title !== undefined)) this.snapshot(cur);
    const next: Note = { ...cur, ...patch, id, ...(opts?.quiet ? {} : { updatedAt: Date.now() }) };
    this.notes.set(id, next);
    this.markFields(id, patchFields(cur, patch));
    this.touch(id, true);
    this.emit();
    this.localWriters.forEach((fn) => fn(cur, next));
    return next;
  }

  /** Remembers which fields of a pending note changed here (sent with the push, so the server merges per field). */
  private markFields(id: string, fields: readonly string[]): void {
    if (fields.length === 0) return;
    const all = this.meta.fields ?? {};
    const had = all[id] ?? [];
    const next = had.includes("*") || fields.includes("*") ? ["*"] : [...new Set([...had, ...fields])];
    this.meta = { ...this.meta, fields: { ...all, [id]: next } };
  }

  /** The fields to send for a pending note; undefined: the whole note. */
  fieldsOf(id: string): string[] | undefined {
    const f = this.meta.fields?.[id];
    return f && f.length && !f.includes("*") ? f : undefined;
  }

  /** The signed-in person's favorites (from the server); null: favorites live on the notes (guests). */
  setFavorites(ids: readonly string[] | null): void {
    this.favorites = ids === null ? null : new Set(ids);
    this.emit();
  }

  /** Stars or unstars a page for this person. */
  setFavorite(id: string, on: boolean): void {
    if (this.favorites === null) {
      this.update(id, { favorite: on }, { quiet: true });
      return;
    }
    if (this.favorites.has(id) === on) return;
    if (on) this.favorites.add(id);
    else this.favorites.delete(id);
    this.emit();
    this.onFavorite?.(id, on);
  }

  /** Applies notes that came from the server (no push back). */
  applyRemote(notes: Note[], removedIds: string[]): string[] {
    const changed: string[] = [];
    const deleting = new Set(this.meta.deleted);
    for (const n of notes) {
      const cur = this.notes.get(n.id);
      // …a deletion forever not sent yet wins over the server's copy.
      if (deleting.has(n.id)) continue;
      const mine = cur && this.meta.pending.includes(n.id) ? this.fieldsOf(n.id) : undefined;
      if (cur && mine) {
        // Someone else's change, around the fields this device has not sent yet (per property).
        this.notes.set(n.id, withFields(n, cur, mine));
        this.dirty.add(n.id);
        changed.push(n.id);
        continue;
      }
      // A local edit still waiting for the server wins over an older copy.
      if (cur && this.meta.pending.includes(n.id) && cur.updatedAt > n.updatedAt) continue;
      this.notes.set(n.id, n);
      this.dirty.add(n.id);
      changed.push(n.id);
    }
    for (const id of removedIds) {
      if (this.notes.delete(id)) {
        this.removed.add(id);
        changed.push(id);
      }
    }
    if (changed.length) {
      this.schedule();
      this.emit();
      this.externalListeners.forEach((fn) => fn(changed));
    }
    return changed;
  }

  /**
   * Forgets every note (workspace or account switch, sign-out on this
   * device). Page history (kept only on this device) goes too when the
   * account changes or signs out; switching workspaces keeps it.
   */
  async reset(owner: string): Promise<void> {
    const account = (key: string) => key.split(":")[0];
    const forgetHistory = this.meta.owner !== "" && account(this.meta.owner) !== account(owner);
    for (const id of this.notes.keys()) this.removed.add(id);
    this.notes.clear();
    this.dirty.clear();
    this.meta = { ...EMPTY_META, owner, seeded: true };
    this.unsaved.clear();
    this.claim = true;
    await this.flush();
    if (forgetHistory && !this.detached && this.db) {
      try {
        const t = this.db.transaction("history", "readwrite");
        t.objectStore("history").clear();
        await txDone(t);
      } catch {
        // History is best effort.
      }
    }
    this.lastSig.clear();
    this.lastSnap.clear();
    this.emit();
  }

  /** Before a shared workspace opens: keeps a guest's pages aside (they never go into a shared workspace). */
  async stashGuest(): Promise<void> {
    const notes = this.all();
    if (!this.db || this.detached || notes.length === 0) return;
    try {
      const t = this.db.transaction("kv", "readwrite");
      const kv = t.objectStore("kv");
      const got = kv.get(GUEST_KEY);
      got.onsuccess = () => {
        const ids = new Set(notes.map((n) => n.id));
        const prev = Array.isArray(got.result) ? (got.result as Note[]) : [];
        kv.put([...prev.filter((n) => !ids.has(n.id)), ...notes], GUEST_KEY);
      };
      await txDone(t);
    } catch {
      // Nothing to keep them in: they go as before.
    }
  }

  /** The personal workspace takes the guest's pages kept aside (they upload like local edits). */
  async adoptGuestStash(): Promise<void> {
    if (!this.db || this.detached) return;
    let stash: Note[] = [];
    try {
      const t = this.db.transaction("kv", "readonly");
      const got = await reqDone(t.objectStore("kv").get(GUEST_KEY));
      stash = Array.isArray(got) ? (got as Note[]).filter((n) => n && typeof n.id === "string") : [];
    } catch {
      return;
    }
    if (stash.length === 0) return;
    const fresh = stash.filter((n) => !this.notes.has(n.id));
    for (const n of fresh) {
      this.notes.set(n.id, n);
      this.dirty.add(n.id);
    }
    if (fresh.length) {
      this.meta = { ...this.meta, pending: union(this.meta.pending, fresh.map((n) => n.id)) };
      fresh.forEach((n) => this.unsaved.add(n.id));
      this.emit();
    }
    await this.flush();
    // Dropped only once the pages are in the store.
    if (this.detached || this.dirty.size > 0) return;
    try {
      const t = this.db.transaction("kv", "readwrite");
      t.objectStore("kv").delete(GUEST_KEY);
      await txDone(t);
    } catch {
      // Tried again next time (pages already here are skipped).
    }
  }

  // ---------------------------------------------------------------------
  // Actions

  /** Live siblings under a parent in order: sidebar children, or a database's rows. */
  private siblingsOf(parentId: string | null): Note[] {
    const parent = parentId ? this.notes.get(parentId) : undefined;
    if (parent?.kind !== "database") return treeChildren(parentId, this.all(), this.notes);
    return this.all()
      .filter((n) => n.parentId === parentId && n.trashedAt === null && !n.template && !isSourceNote(n))
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  create(partial: Partial<Note> & Pick<Note, "kind">, place?: { after?: string; first?: boolean }): Note {
    const siblings = this.siblingsOf(partial.parentId ?? null);
    let order: number;
    if (place?.first) order = orderBetween(undefined, siblings[0]?.order);
    else if (place?.after) {
      const i = siblings.findIndex((s) => s.id === place.after);
      order = orderBetween(siblings[i]?.order, siblings[i + 1]?.order);
    } else order = orderBetween(siblings[siblings.length - 1]?.order, undefined);
    // A top-level page without a section goes to the person's Private (Notion); "" asks for the workspace's pages.
    const space = (partial.parentId ?? null) === null ? (partial.space ?? this.defaultSpace) : undefined;
    const n = blankNote({ ...partial, order: partial.order ?? order, ...(space ? { space } : {}) });
    if (!space) delete n.space;
    return this.put(n);
  }

  /** Moves a note under a new parent at a position (sidebar drag and drop, "Move to"). */
  move(id: string, parentId: string | null, beforeId?: string | null, space?: string): void {
    if (parentId && subtreeIds(id, this.all()).includes(parentId)) return;
    const siblings = treeChildren(parentId, this.all(), this.notes).filter((s) => s.id !== id);
    let order: number;
    if (beforeId) {
      const i = siblings.findIndex((s) => s.id === beforeId);
      order = orderBetween(siblings[i - 1]?.order, siblings[i]?.order);
    } else order = orderBetween(siblings[siblings.length - 1]?.order, undefined);
    // At the top level a page sits in a sidebar section (Private, a teamspace, the workspace's: ""); sub-pages have none.
    const cur = this.notes.get(id);
    const at = parentId === null ? (space !== undefined ? space || undefined : cur?.space) : undefined;
    this.update(id, { parentId, order, inline: false, space: at });
  }

  /** Moves a note and its sub-pages to the trash (restorable). */
  trash(id: string): void {
    const now = Date.now();
    const cur = this.notes.get(id);
    if (!cur) return;
    // Only the root carries trashedAt; descendants follow it (Notion keeps
    // the subtree together and restores it as one).
    this.update(id, { trashedAt: now, favorite: false });
  }

  restore(id: string): void {
    const cur = this.notes.get(id);
    if (!cur) return;
    let parentId = cur.parentId;
    // Restoring into a parent that is itself gone puts it at the top level.
    if (parentId && (!this.notes.get(parentId) || this.isTrashed(parentId))) parentId = null;
    this.update(id, { trashedAt: null, parentId });
  }

  /** Deletes a note and its whole subtree for good. */
  destroy(id: string): void {
    const ids = subtreeIds(id, this.all());
    for (const x of ids) {
      this.notes.delete(x);
      this.removed.add(x);
    }
    const gone = new Set(ids);
    ids.forEach((x) => this.unsaved.add(x));
    this.dropHistory(ids);
    this.meta = {
      ...this.meta,
      pending: this.meta.pending.filter((x) => !gone.has(x)),
      deleted: [...new Set([...this.meta.deleted, ...ids])],
      recent: this.meta.recent.filter((r) => !gone.has(r.id)),
    };
    this.schedule();
    this.onLocalChange?.();
    this.emit();
  }

  /** True when the note or any ancestor is in the trash. */
  isTrashed(id: string): boolean {
    const seen = new Set<string>();
    let cur = this.notes.get(id);
    while (cur && !seen.has(cur.id)) {
      if (cur.trashedAt !== null) return true;
      seen.add(cur.id);
      cur = cur.parentId ? this.notes.get(cur.parentId) : undefined;
    }
    return false;
  }

  /** Copies a note with its subtree; returns the copy of the root. */
  duplicate(id: string, titleSuffix: string): Note | undefined {
    const src = this.notes.get(id);
    if (!src) return undefined;
    // Sub-pages in the trash (and what is under them) stay out of the copy.
    const all = this.all();
    const binned = new Set(all.filter((n) => n.id !== id && n.trashedAt !== null).flatMap((n) => subtreeIds(n.id, all)));
    const ids = subtreeIds(id, all).filter((x) => !binned.has(x));
    const map = new Map<string, string>();
    for (const x of ids) map.set(x, newNoteId());
    const now = Date.now();
    let root: Note | undefined;
    for (const x of ids) {
      const n = this.notes.get(x);
      if (!n) continue;
      // Links, relations (sub-items, dependencies) and templates inside the copy point at the copy, not at the original.
      const copy: Note = remapNote(
        {
          ...structuredClone(n),
          id: map.get(x) as string,
          parentId: x === id ? n.parentId : n.parentId ? (map.get(n.parentId) ?? n.parentId) : null,
          createdAt: now,
          updatedAt: now,
          favorite: false,
        },
        map
      );
      delete copy.share;
      if (x === id) {
        copy.title = n.title ? `${n.title} ${titleSuffix}`.trim() : n.title;
        const siblings = this.siblingsOf(n.parentId);
        const i = siblings.findIndex((s) => s.id === id);
        copy.order = orderBetween(n.order, siblings[i + 1]?.order);
        root = copy;
      }
      this.notes.set(copy.id, copy);
      this.touch(copy.id, true);
    }
    this.emit();
    return root;
  }

  // ---------------------------------------------------------------------
  // Page history: the state before an edit is kept at most every 10 minutes
  // (and on the first edit of a session), up to 60 versions per page.

  private lastSnap = new Map<string, number>();
  private lastSig = new Map<string, string>();

  private static isBlank(n: Note): boolean {
    if (n.title.trim()) return false;
    if (n.content.length === 0) return true;
    return n.content.length === 1 && JSON.stringify(n.content).length < 200 && !/"text":"[^"]/.test(JSON.stringify(n.content));
  }

  private writeVersion(n: Note): void {
    if (!this.db || NotesStore.isBlank(n)) return;
    const sig = `${n.title}\u0000${JSON.stringify(n.content)}`;
    if (this.lastSig.get(n.id) === sig) return;
    this.lastSig.set(n.id, sig);
    const entry: HistoryEntry = { key: `${n.id}:${n.updatedAt}`, noteId: n.id, at: n.updatedAt, title: n.title, content: n.content };
    try {
      const t = this.db.transaction("history", "readwrite");
      const os = t.objectStore("history");
      os.put(entry);
      const req = os.index("noteId").getAllKeys(n.id);
      req.onsuccess = () => {
        const keys = (req.result as string[]).sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
        for (const k of keys.slice(0, Math.max(0, keys.length - 60))) os.delete(k);
      };
    } catch {
      // History is best effort.
    }
  }

  /** Before an edit: keep the previous state if the last version is 10+ minutes old. */
  private snapshot(prev: Note): void {
    const now = Date.now();
    if (now - (this.lastSnap.get(prev.id) ?? 0) < 10 * 60_000) return;
    this.lastSnap.set(prev.id, now);
    this.writeVersion(prev);
  }

  /** Leaving a page: keep its current state as a version if it changed. */
  checkpoint(id: string): void {
    const n = this.notes.get(id);
    if (n && n.kind === "page") this.writeVersion(n);
  }

  /** Pages deleted forever leave no versions behind on this device. */
  private dropHistory(ids: readonly string[]): void {
    if (!this.db || this.detached) return;
    try {
      const t = this.db.transaction("history", "readwrite");
      const os = t.objectStore("history");
      for (const id of ids) {
        const req = os.index("noteId").getAllKeys(id);
        req.onsuccess = () => (req.result as IDBValidKey[]).forEach((k) => os.delete(k));
      }
    } catch {
      // History is best effort.
    }
  }

  /** Saved versions of a page, newest first. */
  async history(noteId: string): Promise<HistoryEntry[]> {
    if (!this.db) return [];
    try {
      const t = this.db.transaction("history", "readonly");
      const rows = await reqDone(t.objectStore("history").index("noteId").getAll(noteId) as IDBRequest<HistoryEntry[]>);
      return rows.sort((a, b) => b.at - a.at);
    } catch {
      return [];
    }
  }

  visit(id: string): void {
    const recent = [{ id, at: Date.now() }, ...this.meta.recent.filter((r) => r.id !== id)].slice(0, 40);
    this.saveMeta({ recent });
  }

  setExpanded(id: string, open: boolean): void {
    const set = new Set(this.meta.expanded);
    if (open) set.add(id);
    else set.delete(id);
    this.saveMeta({ expanded: [...set] });
    this.emit();
  }
}

let singleton: NotesStore | null = null;

export function notesStore(): NotesStore {
  singleton ??= new NotesStore();
  return singleton;
}
