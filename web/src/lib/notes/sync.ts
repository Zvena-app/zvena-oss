// zvena Documents: browser ⇄ server sync of a workspace's documents.
//
// Local-first: the store is the source of truth for the UI; this pushes
// notes listed in meta.pending (and forever-deletions in meta.deleted) and
// pulls what other devices wrote since the cursor. Last write wins per note;
// a local edit that is still pending beats an older server copy.
//
// Pulls are pushed to us: the workspace's live stream (src/lib/pulse) pokes
// this tab the moment another device, member, form or rule saves a note, and
// the slow timer is only a safety net (or the way when there is no stream).

import { pulse, pulseHeaders } from "../pulse/client";
import type { NotesStore } from "./store";
import { NOTE_LIMITS, type Note } from "./types";

export interface SyncState {
  user: string | null;
  online: boolean;
  syncing: boolean;
  error: boolean;
}

type Listener = (s: SyncState) => void;

/** A pause in typing this long sends the edit… */
const PUSH_DELAY = 400;
/** …and while typing on, an edit never waits longer than this. */
const PUSH_MAX_WAIT = 1500;
/** Polling without a live stream; with one, a safety pull this often. */
const PULL_EVERY = 30_000;
const SAFETY_PULL = 5 * 60_000;
/** UTF-8 bytes per request (the route takes up to 24 MB; Cyrillic text is two bytes a letter). */
const BATCH_BYTES = 18_000_000;

const utf8 = new TextEncoder();

export class NotesSync {
  state: SyncState = { user: null, online: true, syncing: false, error: false };
  private listeners = new Set<Listener>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private pushing = false;
  private pulling = false;
  private pullAgain = false;
  private lastPull = 0;
  private pullSoonTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPending = 0;
  private again = false;
  private leavePulse: (() => void)[] = [];
  private stopped = true;
  private ws = "";
  onRejected: ((ids: string[]) => void) | null = null;
  /** Another tab took this browser's copy for another workspace (see NotesStore.onDetached). */
  onDetached: (() => void) | null = null;

  constructor(private store: NotesStore) {
    store.onDetached = () => this.onDetached?.();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn(this.state));
  }

  /**
   * Ties the local store to an account's workspace (`key` = "user:workspace",
   * null = guest): guest documents move into the personal workspace once
   * (`adoptGuest`), another account's or workspace's copy is cleared, then
   * syncing starts.
   */
  async start(target: { key: string; ws: string; adoptGuest: boolean; guest?: boolean } | null): Promise<void> {
    const owner = this.store.meta.owner;
    if (target) {
      const key = target.key;
      this.ws = target.ws;
      // Another account's or workspace's copy (or none yet) is replaced and pulled
      // from the start: those reads go out now, alongside the local reset.
      if (owner !== key) {
        this.earlyPull = this.get(`/api/notes/sync?ws=${encodeURIComponent(target.ws)}&since=0`);
        this.earlyFavorites = this.get(`/api/notes/favorites?ws=${encodeURIComponent(target.ws)}`);
      }
      // A guest's documents never go into a shared workspace (an invite link
      // opens one first): they wait aside for the personal one instead of
      // being cleared with the store.
      if (owner === "" && !target.adoptGuest && this.store.all().length > 0) await this.store.stashGuest();
      if (owner === "" && target.adoptGuest && this.store.all().length > 0) {
        // Guest documents move into the personal workspace: upload everything once.
        this.store.saveMeta({ owner: key, cursor: 0, pending: this.store.all().map((n) => n.id) });
      } else if (owner !== key) {
        await this.store.reset(key);
      }
      if (target.adoptGuest) await this.store.adoptGuestStash();
      this.set({ user: key });
      this.stopped = false;
      this.store.onLocalChange = () => this.schedulePush();
      // Guests get the stream too, with only the pages shared with them (api/pulse).
      const live = pulse();
      this.leavePulse = live ? [live.on("notes", () => this.pullSoon()), live.on("hello", () => this.pullSoon()), live.join(target.ws)] : [];
      this.store.onFavorite = (id, on) => this.sendFavorite(id, on);
      // Favorites and the pull are independent: one round trip, not two.
      await Promise.all([this.loadFavorites(), this.pull()]);
      await this.push();
      this.pullTimer = setInterval(() => {
        if (!live.live() || Date.now() - this.lastPull > SAFETY_PULL) void this.pull();
      }, PULL_EVERY);
      window.addEventListener("focus", this.onFocus);
      document.addEventListener("visibilitychange", this.onFocus);
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
    } else {
      // Signed out (or the session expired). The account's notes stay on the
      // server; this browser forgets them unless it holds unsent edits.
      if (owner !== "" && this.store.meta.pending.length === 0 && this.store.meta.deleted.length === 0) await this.store.reset("");
      // A guest's favorites stay on the pages of the local workspace.
      this.store.setFavorites(null);
      this.store.onFavorite = null;
      this.set({ user: null });
    }
  }

  /**
   * After stop(): sends what is pending once — Documents left for another
   * section without a page load, so no page close sends it.
   */
  async pushOnce(): Promise<void> {
    if (!this.stopped || !this.state.user || !this.ws) return;
    // A push already under way when the app left skipped the last keystrokes: after it.
    for (let i = 0; this.pushing && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    if (!this.stopped) return;
    this.stopped = false;
    try {
      await this.push();
    } finally {
      this.stopped = true;
      if (this.pushTimer) clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.pullTimer) clearInterval(this.pullTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pullSoonTimer) clearTimeout(this.pullSoonTimer);
    this.leavePulse.forEach((leave) => leave());
    this.leavePulse = [];
    this.store.onLocalChange = null;
    window.removeEventListener("focus", this.onFocus);
    document.removeEventListener("visibilitychange", this.onFocus);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
  }

  private onFocus = () => {
    if (document.visibilityState === "visible") void this.pull();
  };
  private onOnline = () => {
    this.set({ online: true });
    void this.pull().then(() => this.push());
    void this.flushFavorites();
  };
  private onOffline = () => this.set({ online: false });

  schedulePush(): void {
    if (this.stopped) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    const now = Date.now();
    if (!this.firstPending) this.firstPending = now;
    const wait = Math.max(0, Math.min(PUSH_DELAY, this.firstPending + PUSH_MAX_WAIT - now));
    this.pushTimer = setTimeout(() => void this.push(), wait);
  }

  /** A poke from the live stream: pull shortly (a burst of pokes makes one pull). */
  pullSoon(): void {
    if (this.stopped || this.pullSoonTimer) return;
    this.pullSoonTimer = setTimeout(() => {
      this.pullSoonTimer = null;
      void this.pull();
    }, 30);
  }

  /** Sends pending notes now (also used before the page unloads). */
  async push(): Promise<void> {
    if (this.stopped || !this.state.user) return;
    if (this.pushing) {
      this.again = true;
      return;
    }
    this.pushing = true;
    this.firstPending = 0;
    this.set({ syncing: true });
    try {
      await this.store.flush();
      let unfinished = true;
      for (let round = 0; round < 50; round++) {
        const meta = this.store.meta;
        const items: { id: string; deleted?: boolean; note?: Note; fields?: string[] }[] = [];
        const sent = new Map<string, Note>();
        const tooLarge: string[] = [];
        let bytes = 0;
        for (const id of meta.deleted) {
          if (items.length >= NOTE_LIMITS.pushBatch) break;
          items.push({ id, deleted: true });
        }
        for (const id of meta.pending) {
          if (items.length >= NOTE_LIMITS.pushBatch) break;
          const n = this.store.get(id);
          if (!n) continue;
          const size = utf8.encode(JSON.stringify(n)).length;
          // The server refuses a note this big anyway; sent, it would fail the
          // whole request (413) every time and hold up everything behind it.
          if (size > NOTE_LIMITS.noteBytes) {
            tooLarge.push(id);
            continue;
          }
          if (items.length > 0 && bytes + size > BATCH_BYTES) break;
          bytes += size;
          items.push({ id, note: n, ...(this.store.fieldsOf(id) ? { fields: this.store.fieldsOf(id) } : {}) });
          sent.set(id, n);
        }
        // Pending ids whose note no longer exists locally (or cannot be sent): forget them.
        const missing = meta.pending.filter((id) => !this.store.get(id));
        if (missing.length || tooLarge.length) {
          const drop = new Set([...missing, ...tooLarge]);
          this.store.saveMeta({ pending: meta.pending.filter((id) => !drop.has(id)) });
        }
        if (tooLarge.length) this.onRejected?.(tooLarge);
        if (items.length === 0) {
          unfinished = false;
          break;
        }
        const res = await fetch(`/api/notes/sync?ws=${encodeURIComponent(this.ws)}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...pulseHeaders() },
          body: JSON.stringify({ items }),
          credentials: "same-origin",
        });
        if (res.status === 401) {
          this.stop();
          this.set({ user: null });
          return;
        }
        if (res.status === 403) {
          // Read-only here (a viewer, or the role was lowered): what this
          // device changed cannot be saved. It is dropped and the server's
          // copy comes back with a full pull; access lost altogether shows
          // up there (a 403 on pull) and stops sync.
          this.store.saveMeta({ pending: [], deleted: [], cursor: 0 });
          this.onRejected?.(items.map((x) => x.id));
          void this.pull();
          return;
        }
        if (!res.ok) throw new Error(`push ${res.status}`);
        const out = (await res.json()) as { saved?: string[]; rejected?: { id: string; reason: string }[] };
        const saved = new Set(out.saved ?? []);
        const rejected = (out.rejected ?? []).map((r) => r.id);
        const done = new Set([...saved, ...rejected]);
        const cur = this.store.meta;
        this.store.saveMeta({
          // A note changed again while the request was in flight stays pending
          // (by identity: "quiet" changes such as view settings keep updatedAt).
          pending: cur.pending.filter((id) => {
            if (!done.has(id)) return true;
            const n = this.store.get(id);
            return n !== undefined && sent.has(id) && n !== sent.get(id);
          }),
          deleted: cur.deleted.filter((id) => !done.has(id)),
        });
        if (rejected.length) this.onRejected?.(rejected);
        // Changes the person may not make on these pages: the server's copy comes back over them.
        const forbidden = (out.rejected ?? []).filter((r) => r.reason === "forbidden" || r.reason === "read only").map((r) => r.id);
        if (forbidden.length) void this.refetch(forbidden);
        // The server answered for none of them: sending again would loop.
        if (!items.some((x) => done.has(x.id))) {
          unfinished = false;
          break;
        }
      }
      this.set({ error: false });
      // More than 50 rounds' worth (a large guest workspace adopted at once): carry on shortly.
      if (unfinished) this.again = true;
    } catch {
      this.set({ error: navigator.onLine, online: navigator.onLine });
      // Retry later (exponential-ish): the next local change or pull also retries.
      if (this.pushTimer) clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => void this.push(), 15_000);
    } finally {
      this.pushing = false;
      this.set({ syncing: false });
      if (this.again) {
        this.again = false;
        this.schedulePush();
      }
    }
  }

  /** Reads started before the store was ready for them (start): the first pull's page and the favorites. */
  private earlyPull: Promise<Response> | null = null;
  private earlyFavorites: Promise<Response> | null = null;

  private get(url: string): Promise<Response> {
    const p = fetch(url, { credentials: "same-origin", cache: "no-store" });
    // Read (or dropped) later; a failure then is handled where it is read.
    p.catch(() => {});
    return p;
  }

  /** The person's own favorites in this workspace (stars set offline are sent after). */
  private favQueue = new Map<string, boolean>();

  private async loadFavorites(): Promise<void> {
    try {
      const pre = this.earlyFavorites;
      this.earlyFavorites = null;
      const r = await (pre ?? fetch(`/api/notes/favorites?ws=${encodeURIComponent(this.ws)}`, { credentials: "same-origin", cache: "no-store" }));
      if (!r.ok) return;
      const j = (await r.json()) as { ids?: string[] };
      const ids = new Set(j.ids ?? []);
      for (const [id, on] of this.favQueue) {
        if (on) ids.add(id);
        else ids.delete(id);
      }
      this.store.setFavorites([...ids]);
    } catch {
      // Offline: favorites show once the server answers.
    }
  }

  private sendFavorite(id: string, on: boolean): void {
    this.favQueue.set(id, on);
    void this.flushFavorites();
  }

  private async flushFavorites(): Promise<void> {
    for (const [id, on] of [...this.favQueue]) {
      try {
        const r = await fetch(`/api/notes/favorites?ws=${encodeURIComponent(this.ws)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, on }),
          credentials: "same-origin",
        });
        if (r.ok || r.status === 400) this.favQueue.delete(id);
        else return;
      } catch {
        return;
      }
    }
  }

  /**
   * Leaving the page: the latest edits go out in a keepalive request, which
   * the browser finishes after the tab is gone (such requests are limited
   * to 64 KB). `pending` stays as it is: the next visit pushes again, and
   * the server takes that as the same write.
   */
  sendOnUnload(): void {
    if (this.stopped || !this.state.user) return;
    const items: { id: string; deleted?: boolean; note?: Note; fields?: string[] }[] = [];
    let bytes = 0;
    for (const id of this.store.meta.deleted.slice(0, NOTE_LIMITS.pushBatch)) {
      items.push({ id, deleted: true });
      bytes += id.length + 32;
    }
    // The most recent edits are at the end of the list.
    for (const id of [...this.store.meta.pending].reverse()) {
      if (items.length >= NOTE_LIMITS.pushBatch) break;
      const n = this.store.get(id);
      if (!n) continue;
      const size = utf8.encode(JSON.stringify(n)).length + 32;
      if (bytes + size > 60_000) continue;
      items.push({ id, note: n, ...(this.store.fieldsOf(id) ? { fields: this.store.fieldsOf(id) } : {}) });
      bytes += size;
    }
    if (items.length === 0) return;
    try {
      void fetch(`/api/notes/sync?ws=${encodeURIComponent(this.ws)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => {});
    } catch {
      // A keepalive request over the browser's budget throws: the next visit sends it.
    }
  }

  /** The server's copy of some notes (or their removal when the person cannot read them). */
  private async refetch(ids: string[]): Promise<void> {
    try {
      const res = await fetch(`/api/notes/sync?ws=${encodeURIComponent(this.ws)}&ids=${ids.map(encodeURIComponent).join(",")}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const out = (await res.json()) as { notes: Note[]; deleted: string[] };
      this.store.applyRemote(out.notes ?? [], out.deleted ?? []);
    } catch {
      // The next pull brings them anyway when they change.
    }
  }

  async pull(): Promise<void> {
    if (this.stopped || !this.state.user) return;
    if (this.pulling) {
      // A poke while pulling: the running pull may have missed it.
      this.pullAgain = true;
      return;
    }
    this.pulling = true;
    this.pullAgain = false;
    this.lastPull = Date.now();
    try {
      for (let page = 0; page < 200; page++) {
        // The first pull of a replaced store may already be on its way (start).
        const pre = page === 0 && this.store.meta.cursor === 0 ? this.earlyPull : null;
        this.earlyPull = null;
        const res = await (pre ?? fetch(`/api/notes/sync?ws=${encodeURIComponent(this.ws)}&since=${this.store.meta.cursor}`, { credentials: "same-origin", cache: "no-store" }));
        if (res.status === 401 || res.status === 403) {
          this.stop();
          this.set({ user: null });
          return;
        }
        if (!res.ok) throw new Error(`pull ${res.status}`);
        const out = (await res.json()) as { notes: Note[]; deleted: string[]; cursor: number; more: boolean };
        this.store.applyRemote(out.notes ?? [], out.deleted ?? []);
        this.store.saveMeta({ cursor: out.cursor });
        if (!out.more) break;
      }
      this.set({ online: true });
    } catch {
      this.set({ online: navigator.onLine });
    } finally {
      this.pulling = false;
      if (this.pullAgain) {
        this.pullAgain = false;
        this.pullSoon();
      }
    }
  }
}
