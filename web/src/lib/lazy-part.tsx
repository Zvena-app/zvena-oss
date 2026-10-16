"use client";

// Parts of a section its first paint does not need (panels, dialogs, other
// screens) as chunks of their own: loaded on first use, and ahead of time
// once the page is idle (preloadWhenIdle), so opening them later does not
// wait. A part that is already here renders at once, with no Suspense flash
// (Documents has the same for its parts: components/notes/lazy.tsx).

import { useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

export interface Part<M> {
  /** Starts loading (once); resolves with the module. */
  load: () => Promise<M>;
  /** The module if it is here, else null (and starts loading). */
  use: () => M | null;
}

export function lazyPart<M>(importer: () => Promise<M>): Part<M> {
  let mod: M | null = null;
  let promise: Promise<M> | null = null;
  const listeners = new Set<() => void>();
  const load = () =>
    (promise ??= importer().then(
      (m) => {
        mod = m;
        for (const l of [...listeners]) l();
        return m;
      },
      (e: unknown) => {
        // A failed chunk (offline, a deploy moved on) is tried again next time.
        promise = null;
        throw e;
      }
    ));
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  };
  const get = () => mod;
  const none = () => null;
  const use = () => {
    const m = useSyncExternalStore(subscribe, get, none);
    useEffect(() => {
      if (!m) load().catch(() => {});
    }, [m]);
    return m;
  };
  return { load, use };
}

/** A component from a part; `fallback` holds its place while the part loads. */
export function lazyComponent<M, P extends object>(part: Part<M>, pick: (m: M) => ComponentType<P>, fallback: ReactNode = null): ComponentType<P> {
  function Lazy(props: P) {
    const m = part.use();
    if (!m) return fallback;
    const C = pick(m);
    return <C {...props} />;
  }
  return Lazy;
}

/** Loads parts one after another once the browser is idle (they never compete with what is on screen). */
export function preloadWhenIdle(parts: { load: () => Promise<unknown> }[]): () => void {
  if (typeof window === "undefined") return () => {};
  let stopped = false;
  const queue = [...parts];
  const idle = (fn: () => void) => (typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(fn, { timeout: 4000 }) : window.setTimeout(fn, 1200));
  const next = () => {
    if (stopped) return;
    const p = queue.shift();
    if (!p) return;
    p.load().then(
      () => idle(next),
      () => idle(next)
    );
  };
  idle(next);
  return () => {
    stopped = true;
  };
}
