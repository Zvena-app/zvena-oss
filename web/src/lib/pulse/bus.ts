// Pulse: the live channel of a workspace. Server-only.
//
// Every product writes through its own permission-checked API, then calls
// `emit()`: "something of type T (ref R) changed in workspace W". Browsers
// with the workspace open hear it at once over /api/pulse (SSE) and pull the
// change through the same APIs they always use; server-side reactions
// (src/lib/decide) hear it through `listenAll()`. An event is a poke, not
// data: ids and a type, never document content, so the stream needs no
// permissions of its own beyond "may read this workspace".
//
// One process serves the app (store.ts: SQLite, one writer), so the bus is an
// in-process map. It hangs off globalThis because Next bundles each route
// separately and a module-level map could exist once per bundle. With more
// than one process this becomes Valkey pub/sub (already in the stack).

// "links": the links or backlinks of `ref` changed (src/lib/eco); the objects
// themselves still get their own pokes. "inbox": `ref` (a user id) has a new
// notification. "doc": the co-edited body of note `ref` changed (the edits
// themselves travel on the page's own channel, never here). "calendar": events
// of calendar `ref` changed (`refs`: their ids); lib/eco/visibility.ts decides
// who hears it. "mail": the mail of `ref` (a user id, its owner and only
// listener) changed (src/lib/mail-client).
export const PULSE_TYPES = ["notes", "projects", "design", "links", "inbox", "doc", "metric", "decision", "calendar", "mail"] as const;
export type PulseType = (typeof PULSE_TYPES)[number];

export interface PulseEvent {
  /** Increasing per process; a reconnect with a gap resyncs. */
  id: number;
  ws: string;
  type: PulseType;
  /** The object that changed (a note, an issue, a file…), when there is one. */
  ref?: string;
  /** Several objects changed in one write (at most 50 ids). */
  refs?: string[];
  /** The browser tab that made the change: it ignores its own echo. */
  origin?: string;
  /** Who made the change (user id), "form", "rule"… */
  by?: string;
  at: number;
  /** Small, non-content details (a metric's value, a decision's mode). */
  data?: Record<string, string | number | boolean | null>;
}

export type PulseInput = Omit<PulseEvent, "id" | "ws" | "at">;
type Listener = (e: PulseEvent) => void;

/** Whether `userId` may hear this event (a product's rule: private teams, hidden objects). */
export type PulseFilter = (userId: string, e: PulseEvent) => boolean;

/** The most ids one event carries; a bigger write is announced as several events. */
export const REFS_PER_EVENT = 50;

interface Bus {
  seq: number;
  byWs: Map<string, Set<Listener>>;
  all: Set<Listener>;
  filters?: Map<PulseType, Set<PulseFilter>>;
}

const KEY = Symbol.for("zvena.pulse.bus");
const g = globalThis as unknown as Record<symbol, Bus | undefined>;
const bus: Bus = (g[KEY] ??= { seq: 0, byWs: new Map(), all: new Set() });

const ORIGIN_RE = /^[A-Za-z0-9_-]{8,40}$/;

/** A browser tab id from a request header (x-zvena-origin), if well-formed. */
export function originOf(req: Request): string | undefined {
  const o = req.headers.get("x-zvena-origin");
  return o && ORIGIN_RE.test(o) ? o : undefined;
}

/**
 * Announces a change. Call it after the write has committed. Listeners run
 * on a later tick, so emitting never slows down the request that wrote.
 */
export function emit(ws: string, input: PulseInput): PulseEvent {
  // Never drop ids: a write of more than REFS_PER_EVENT objects becomes several events.
  if (input.refs && input.refs.length > REFS_PER_EVENT) {
    const [first, ...rest] = Array.from({ length: Math.ceil(input.refs.length / REFS_PER_EVENT) }, (_, i) => input.refs!.slice(i * REFS_PER_EVENT, (i + 1) * REFS_PER_EVENT));
    const head = emit(ws, { ...input, refs: first });
    for (const refs of rest) emit(ws, { ...input, refs });
    return head;
  }
  const e: PulseEvent = { ...input, id: ++bus.seq, ws, at: Date.now() };
  const local = bus.byWs.get(ws);
  if (!local?.size && !bus.all.size) return e;
  setImmediate(() => {
    for (const fn of [...(local ?? []), ...bus.all]) {
      try {
        fn(e);
      } catch {
        // One broken listener never stops the others.
      }
    }
  });
  return e;
}

/** Hears one workspace (the SSE route, one per open tab). */
export function listen(ws: string, fn: Listener): () => void {
  let set = bus.byWs.get(ws);
  if (!set) bus.byWs.set(ws, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0 && bus.byWs.get(ws) === set) bus.byWs.delete(ws);
  };
}

/** Hears every workspace (server-side reactions). */
export function listenAll(fn: Listener): () => void {
  bus.all.add(fn);
  return () => bus.all.delete(fn);
}

/**
 * A product's visibility rule for one event type: the live stream sends an
 * event to a person only when every filter of its type says yes. A filter
 * that throws counts as no. Server-side listeners (reactions, the indexer)
 * hear everything; they check permissions themselves.
 */
export function registerPulseFilter(type: PulseType, fn: PulseFilter): () => void {
  bus.filters ??= new Map();
  let set = bus.filters.get(type);
  if (!set) bus.filters.set(type, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

/** Whether the live stream may send `e` to `userId`. */
export function visibleTo(userId: string, e: PulseEvent): boolean {
  const set = bus.filters?.get(e.type);
  if (!set?.size) return true;
  for (const fn of set) {
    try {
      if (!fn(userId, e)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The last event id given out (a fresh SSE stream starts from it). */
export function lastId(): number {
  return bus.seq;
}

/** Open live streams (for /status and tests). */
export function streams(ws?: string): number {
  if (ws) return bus.byWs.get(ws)?.size ?? 0;
  let n = 0;
  for (const s of bus.byWs.values()) n += s.size;
  return n;
}
