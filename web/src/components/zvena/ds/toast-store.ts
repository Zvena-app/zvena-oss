// The toast queue (design system: UndoToast), without React, so every
// section can call `toast()` and tests can drive it. One toast at a time: a
// new one replaces the old, the way people read them. A toast with `undo`
// lives 6 s; hovering it pauses the countdown.

export type ToastKind = "info" | "success" | "error";

export interface ToastOptions {
  kind?: ToastKind;
  /** Puts back what the action did; shows "Undo" (and ⌘Z works while the toast is up). */
  undo?: () => void | Promise<void>;
  /** Any other single action ("Open"). */
  action?: { label: string; run: () => void };
  /** Lifetime in ms (default 3.5 s, 6 s with undo or for an error). */
  ms?: number;
}

export interface ToastItem extends ToastOptions {
  id: number;
  text: string;
  kind: ToastKind;
  /** When it disappears (ms since epoch); Infinity while paused. */
  until: number;
  /** How long it had left when paused. */
  left: number;
}

type Listener = (t: ToastItem | null) => void;

export class ToastStore {
  private current: ToastItem | null = null;
  private seq = 0;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private now: () => number = Date.now) {}

  get(): ToastItem | null {
    return this.current;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  show(text: string, opts: ToastOptions = {}): number {
    const kind = opts.kind ?? "info";
    const ms = opts.ms ?? (opts.undo || kind === "error" ? 6000 : 3500);
    const id = ++this.seq;
    this.set({ ...opts, id, text, kind, until: this.now() + ms, left: ms });
    return id;
  }

  dismiss(id?: number): void {
    if (!this.current || (id !== undefined && this.current.id !== id)) return;
    this.set(null);
  }

  /** Runs the visible toast's undo once and closes it; false when there is none. */
  undo(id?: number): boolean {
    const t = this.current;
    if (!t?.undo || (id !== undefined && t.id !== id)) return false;
    this.set(null);
    void Promise.resolve()
      .then(() => t.undo?.())
      .catch(() => {
        // The section reports its own failure.
      });
    return true;
  }

  pause(): void {
    const t = this.current;
    if (!t || t.until === Infinity) return;
    this.set({ ...t, left: Math.max(0, t.until - this.now()), until: Infinity });
  }

  resume(): void {
    const t = this.current;
    if (!t || t.until !== Infinity) return;
    this.set({ ...t, until: this.now() + Math.max(1500, t.left) });
  }

  /** Closes the toast if its time is up (the timer calls it; tests call it with a fake clock). */
  tick(): void {
    const t = this.current;
    if (t && t.until !== Infinity && this.now() >= t.until) this.set(null);
  }

  private set(t: ToastItem | null): void {
    this.current = t;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (t && t.until !== Infinity) this.timer = setTimeout(() => this.tick(), Math.max(0, t.until - this.now()) + 5);
    this.listeners.forEach((fn) => fn(t));
  }
}

const KEY = Symbol.for("zvena.ds.toasts");
const g = globalThis as unknown as Record<symbol, ToastStore | undefined>;

/** The page's one toast store. */
export function toasts(): ToastStore {
  return (g[KEY] ??= new ToastStore());
}

/**
 * Shows a toast: past tense for what is done ("Issue deleted"), with `undo`
 * when it can be put back. Returns its id.
 */
export function toast(text: string, opts?: ToastOptions): number {
  return toasts().show(text, opts);
}
