// Pulse in the browser: one live stream per tab for the open workspace
// (see src/lib/pulse/bus.ts). Products subscribe to the types they show and
// pull through their own APIs when a change arrives; "hello" means the stream
// (re)connected and anything may have been missed, so pull everything.
//
// Without a stream (offline, a proxy that buffers, too many tabs) products
// keep their own timer: `live()` tells them how often they need to poll.

export interface PulseMessage {
  type: string;
  ref?: string;
  refs?: string[];
  origin?: string;
  by?: string;
  at: number;
  data?: Record<string, string | number | boolean | null>;
}

type Handler = (m: PulseMessage) => void;

/**
 * How long the stream stays open after its last product left: the rail
 * switches sections without a page load, and the next section joins the open
 * stream instead of connecting again (and pulling everything on "hello").
 */
const LINGER_MS = 15_000;

/** This tab's id: sent with every write (x-zvena-origin) so its own echo is skipped. */
export const PULSE_ORIGIN = (() => {
  const a = new Uint8Array(12);
  if (typeof crypto !== "undefined") crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[b & 63]).join("");
})();

/** Headers for a write, so the writer's own tab is not poked about it. */
export const pulseHeaders = (): Record<string, string> => ({ "x-zvena-origin": PULSE_ORIGIN });

class PulseClient {
  private es: EventSource | null = null;
  private ws = "";
  private users = 0;
  private handlers = new Map<string, Set<Handler>>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isLive = false;
  private statusFns = new Set<(live: boolean) => void>();

  /** True while the stream is open: pokes arrive within milliseconds. */
  live(): boolean {
    return this.isLive;
  }

  onStatus(fn: (live: boolean) => void): () => void {
    this.statusFns.add(fn);
    return () => this.statusFns.delete(fn);
  }

  /** Hears `type` ("notes", "projects", "hello", "*"…) in the joined workspace. */
  on(type: string, fn: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Opens (or shares) the stream of a workspace; call the returned function to leave. */
  join(ws: string): () => void {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return () => {};
    if (ws !== this.ws) {
      this.close();
      this.ws = ws;
      this.users = 0;
    }
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    this.users++;
    if (!this.es) this.open();
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--this.users <= 0) this.closeSoon();
    };
  }

  private linger: ReturnType<typeof setTimeout> | null = null;

  private closeSoon(): void {
    if (this.linger) clearTimeout(this.linger);
    this.linger = setTimeout(() => {
      this.linger = null;
      if (this.users <= 0) this.close();
    }, LINGER_MS);
  }

  private watching = false;

  private open(): void {
    if (!this.ws || this.es) return;
    if (!this.watching) {
      this.watching = true;
      // Back online or back to the tab: reconnect now rather than after the backoff.
      const now = () => {
        if (this.users > 0 && !this.es && document.visibilityState === "visible") {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.retry = 0;
          this.open();
        }
      };
      window.addEventListener("online", now);
      document.addEventListener("visibilitychange", now);
    }
    const es = new EventSource(`/api/pulse?ws=${encodeURIComponent(this.ws)}`, { withCredentials: true });
    this.es = es;
    es.addEventListener("hello", () => {
      this.retry = 0;
      this.setLive(true);
      this.fire("hello", { type: "hello", at: Date.now() });
    });
    es.onmessage = (ev) => {
      let m: PulseMessage;
      try {
        m = JSON.parse(ev.data) as PulseMessage;
      } catch {
        return;
      }
      if (m.origin === PULSE_ORIGIN) return;
      this.fire(m.type, m);
      this.fire("*", m);
    };
    es.onerror = () => {
      this.setLive(false);
      // CONNECTING: the browser retries by itself. CLOSED: the server said no
      // (401/403/429) or the network is gone; try again later, slower each time.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        this.es = null;
        this.schedule();
      }
    };
  }

  private schedule(): void {
    if (this.timer || this.users <= 0) return;
    const wait = Math.min(60_000, 2_000 * 2 ** this.retry++) * (0.75 + Math.random() / 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.users > 0 && navigator.onLine !== false) this.open();
      else this.schedule();
    }, wait);
  }

  private close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    this.es?.close();
    this.es = null;
    this.retry = 0;
    this.setLive(false);
  }

  private setLive(v: boolean): void {
    if (this.isLive === v) return;
    this.isLive = v;
    this.statusFns.forEach((fn) => fn(v));
  }

  private fire(type: string, m: PulseMessage): void {
    this.handlers.get(type)?.forEach((fn) => {
      try {
        fn(m);
      } catch {
        // A product's handler never breaks the stream.
      }
    });
  }
}

let client: PulseClient | null = null;

/** The tab's pulse (one stream however many products listen). */
export function pulse(): PulseClient {
  return (client ??= new PulseClient());
}
