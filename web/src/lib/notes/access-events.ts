// Server-only: "who may read what in this workspace changed" — a page's
// restriction or shares, a member gone. Listeners (the co-editing rooms,
// lib/notes/collab.ts) re-check the people they serve. No imports, so any
// module may announce it without a cycle.

type Listener = (ws: string) => void;
const KEY = Symbol.for("zvena.notes.accessChanged");
const g = globalThis as unknown as Record<symbol, Set<Listener> | undefined>;
const listeners: Set<Listener> = (g[KEY] ??= new Set());

export function onAccessChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const GEN = Symbol.for("zvena.notes.accessGeneration");
const gens: Map<string, number> = ((g as unknown as Record<symbol, Map<string, number> | undefined>)[GEN] ??= new Map());

/** A number that moves (at once, inside the write) whenever access in the workspace changes: caches compare it. */
export function accessGeneration(ws: string): number {
  return gens.get(ws) ?? 0;
}

/** Announces a change; listeners run once the current write is done (after its transaction). */
export function accessChanged(ws: string): void {
  gens.set(ws, (gens.get(ws) ?? 0) + 1);
  setImmediate(() => {
    for (const fn of listeners) {
      try {
        fn(ws);
      } catch {
        // A listener's trouble is its own.
      }
    }
  });
}
