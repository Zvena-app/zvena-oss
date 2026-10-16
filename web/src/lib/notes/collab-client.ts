// zvena Documents (browser): the co-editing provider of one open page. It
// streams the page's Yjs document from the server (/api/notes/collab, SSE),
// sends this browser's edits and cursor in small batches, and on a lost
// connection keeps editing locally, reconnects with backoff and resyncs:
// the server sends its whole state, this browser sends back what it has
// beyond it (Yjs merges both ways, nothing is lost).

import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { fromBase64, toBase64, type CollabInit } from "./collab-shared";

export type CollabStatus = "connecting" | "live" | "offline" | "closed" | "gone";

/** What a browser tells the others about itself (BlockNote's cursor plugin reads `user`). */
export interface CollabUser {
  id: string;
  name: string;
  color: string;
}

/** Someone in the page, as the Topbar shows them. */
export interface CollabPeer {
  uid: string;
  name: string;
  color: string;
  editing: boolean;
}

const BATCH = 80;
const BACKOFF = [1000, 2000, 5000, 10_000, 30_000];

function clientId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"[b & 63]).join("");
}

export class CollabProvider {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  readonly client = clientId();
  status: CollabStatus = "connecting";
  init: CollabInit | null = null;
  canEdit = false;
  /** Reads only, but may mark the text of their own discussions (Can comment). */
  canComment = false;
  /** Until then this reader's own changes go out: the discussion mark just made (the server checks it). */
  private commentUntil = 0;
  private es: EventSource | null = null;
  private queue: Uint8Array[] = [];
  private inflight = 0;
  private sendAwareness = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private listeners = new Set<() => void>();
  private ready: { resolve: (i: CollabInit) => void; reject: (e: Error) => void } | null = null;

  constructor(
    private readonly ws: string,
    private readonly noteId: string,
    readonly user: CollabUser
  ) {
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState({ user: { name: user.name, color: user.color }, uid: user.id, editing: false });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      // What came from the server is not sent back; a reader's local changes (schema tidying) are not edits.
      if (origin === this || !this.mayWrite()) return;
      this.queue.push(update);
      this.schedule();
    });
    this.awareness.on("update", (_: unknown, origin: unknown) => {
      if (origin !== "local") return;
      this.sendAwareness = true;
      this.schedule();
    });
  }

  private url(extra = ""): string {
    return `/api/notes/collab?ws=${encodeURIComponent(this.ws)}&id=${encodeURIComponent(this.noteId)}${extra}`;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  private setStatus(s: CollabStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit();
  }

  /** Opens the stream; resolves with the server's first answer, rejects after `timeoutMs` without one. */
  connect(timeoutMs = 4000): Promise<CollabInit> {
    const p = new Promise<CollabInit>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    const timer = setTimeout(() => {
      if (!this.ready) return;
      this.ready.reject(new Error("timeout"));
      this.ready = null;
    }, timeoutMs);
    void p.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer)
    );
    this.open();
    return p;
  }

  private open(): void {
    if (this.status === "closed" || this.status === "gone") return;
    const es = new EventSource(this.url(`&client=${this.client}`), { withCredentials: true });
    this.es = es;
    es.addEventListener("init", (e) => this.onInit(JSON.parse((e as MessageEvent<string>).data) as CollabInit));
    es.addEventListener("update", (e) => {
      try {
        Y.applyUpdate(this.doc, fromBase64((e as MessageEvent<string>).data), this);
      } catch {
        // A broken update: the next resync brings the state.
      }
    });
    es.addEventListener("awareness", (e) => {
      try {
        applyAwarenessUpdate(this.awareness, fromBase64((e as MessageEvent<string>).data), this);
      } catch {
        // Ignored: cursors only.
      }
    });
    es.addEventListener("gone", () => {
      this.setStatus("gone");
      this.stopStream();
    });
    es.onerror = () => {
      // The browser would retry on its own; this provider retries with backoff and a full resync.
      this.stopStream();
      if (this.status === "closed" || this.status === "gone") return;
      if (this.ready) {
        this.ready.reject(new Error("stream failed"));
        this.ready = null;
      }
      this.setStatus("offline");
      this.reconnect();
    };
  }

  private stopStream(): void {
    if (this.es) {
      this.es.onerror = null;
      this.es.close();
      this.es = null;
    }
  }

  private reconnect(): void {
    if (this.retryTimer || this.status === "closed" || this.status === "gone") return;
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private onInit(init: CollabInit): void {
    this.attempt = 0;
    this.init = init;
    this.canEdit = init.canEdit;
    this.canComment = Boolean(init.canComment);
    try {
      Y.applyUpdate(this.doc, fromBase64(init.state), this);
      if (init.awareness) applyAwarenessUpdate(this.awareness, fromBase64(init.awareness), this);
    } catch {
      // A broken state: the stream reconnects on the next error.
    }
    // What this browser holds beyond the server's state (edits made while the stream was down).
    if (this.canEdit) {
      const diff = Y.encodeStateAsUpdate(this.doc, fromBase64(init.sv));
      if (diff.byteLength > 2) this.queue.push(diff);
    }
    this.awareness.setLocalStateField("editing", this.canEdit);
    this.sendAwareness = true;
    this.setStatus("live");
    this.schedule(0);
    if (this.ready) {
      this.ready.resolve(init);
      this.ready = null;
    }
    this.emit();
  }

  private schedule(delay = BATCH): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delay);
  }

  private async post(body: Record<string, unknown>, keepalive = false): Promise<Response> {
    return fetch(this.url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: this.client, ...body }),
      credentials: "same-origin",
      keepalive,
    });
  }

  private async flush(): Promise<void> {
    if (this.status !== "live") return;
    const updates = this.canEdit || this.canComment ? this.queue.splice(0) : [];
    if (!this.canEdit && !this.canComment) this.queue = [];
    const aware = this.sendAwareness;
    this.sendAwareness = false;
    if (!updates.length && !aware) return;
    const body: Record<string, unknown> = {};
    if (updates.length) body.update = toBase64(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
    if (aware) body.awareness = toBase64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    if (updates.length) this.inflight += 1;
    const requeue = () => {
      this.queue.unshift(...updates);
      if (aware) this.sendAwareness = true;
    };
    try {
      const r = await this.post(body);
      if (r.status === 409) {
        // The server does not know this stream (it restarted): reconnect and resync.
        requeue();
        this.stopStream();
        this.setStatus("offline");
        this.reconnect();
      } else if (r.status === 403) {
        // Read-only now (the role was lowered), or a mark the server refused: edits stop going out.
        this.canEdit = false;
        if (updates.length) this.canComment = false;
        this.emit();
      } else if (!r.ok) {
        requeue();
        if (this.status === "live") setTimeout(() => this.schedule(0), 1000);
      }
    } catch {
      requeue();
      if (this.status === "live") setTimeout(() => this.schedule(0), 1000);
    } finally {
      if (updates.length) this.inflight -= 1;
      this.emit();
    }
  }

  /** Edits not yet confirmed by the server. */
  get pending(): number {
    return this.queue.length + this.inflight;
  }

  /** Waits until every edit made so far is on the server (false after `timeoutMs`). */
  whenSent(timeoutMs = 3000): Promise<boolean> {
    if (this.pending === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        off();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const off = this.subscribe(() => {
        if (this.pending === 0) done(true);
      });
    });
  }

  /** Asks for the right to seed or reset the page (one browser at a time). */
  async claim(): Promise<boolean> {
    if (this.status !== "live" || !this.canEdit) return false;
    try {
      const r = await this.post({ claim: true });
      return r.ok && ((await r.json()) as { granted?: boolean }).granted === true;
    } catch {
      return false;
    }
  }

  /** People in the page now (one per person; this person's other tabs left out). */
  peers(): CollabPeer[] {
    const out = new Map<string, CollabPeer>();
    for (const [id, s] of this.awareness.getStates()) {
      if (id === this.doc.clientID) continue;
      const st = s as { uid?: unknown; user?: { name?: unknown; color?: unknown }; editing?: unknown };
      if (typeof st.uid !== "string" || st.uid === this.user.id) continue;
      const prev = out.get(st.uid);
      out.set(st.uid, {
        uid: st.uid,
        name: typeof st.user?.name === "string" ? st.user.name : "",
        color: typeof st.user?.color === "string" ? st.user.color : "#787774",
        editing: Boolean(st.editing) || Boolean(prev?.editing),
      });
    }
    return [...out.values()];
  }

  private mayWrite(): boolean {
    return this.canEdit || (this.canComment && Date.now() < this.commentUntil);
  }

  /** A reader who may comment is about to mark (or unmark) the text of a discussion: that change goes out. */
  commentMark(run: () => void): void {
    this.commentUntil = Date.now() + 3000;
    run();
  }

  /** Leaves the page: the cursor goes at once, the stream closes. */
  destroy(): void {
    if (this.status === "closed") return;
    const wasLive = this.status === "live";
    this.status = "closed";
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    if (wasLive) {
      // Unsent edits and the goodbye go out even as the page closes.
      const body: Record<string, unknown> = {};
      // A keepalive request carries 64 KB at most; a bigger backlog is in the page's JSON
      // snapshot (not confirmed by a session, so the next session merges it back in).
      const update = (this.canEdit || this.canComment) && this.queue.length ? toBase64(Y.mergeUpdates(this.queue)) : "";
      if (update && update.length < 60_000) body.update = update;
      this.awareness.setLocalState(null);
      body.awareness = toBase64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      void this.post(body, true).catch(() => undefined);
    }
    this.stopStream();
    this.awareness.destroy();
    this.emit();
    this.listeners.clear();
  }
}
