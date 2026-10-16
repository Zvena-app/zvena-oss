"use client";

// Parts of Notes the first paint doesn't need — databases, dialogs,
// history, templates, export — load as their own chunks: on first use, and
// ahead of time once the app is idle (preloadParts), so opening them later
// doesn't wait. A part that is already here renders at once, with no
// Suspense flash.

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
        for (const l of listeners) l();
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
  const use = () => {
    const m = useSyncExternalStore(subscribe, get, get);
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

export const databasePart = lazyPart(() => import("./parts/database"));
export const panelsPart = lazyPart(() => import("./parts/panels"));
export const dialogsPart = lazyPart(() => import("./parts/dialogs"));
export const historyPart = lazyPart(() => import("./parts/history"));
export const templatesPart = lazyPart(() => import("./parts/templates"));
export const exportPart = lazyPart(() => import("./parts/export"));
export const iconsPart = lazyPart(() => import("./icons"));
export const editorPart = lazyPart(() => import("./parts/editor"));

/**
 * Loads the parts people reach for most (databases, search, templates, icons)
 * a little after the page has painted, one after another so they never
 * compete with what is on screen.
 */
export function preloadParts(): () => void {
  let stopped = false;
  const queue: Part<unknown>[] = [databasePart, panelsPart, templatesPart, iconsPart, dialogsPart];
  const idle = (fn: () => void) =>
    typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(fn, { timeout: 3000 }) : window.setTimeout(fn, 600);
  const next = () => {
    const part = queue.shift();
    if (stopped || !part) return;
    part
      .load()
      .catch(() => {})
      .finally(() => idle(next));
  };
  // A few seconds' head start for what the page itself still loads (images,
  // an inline database), so slow phones get the page first.
  const timer = window.setTimeout(() => idle(next), 2500);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}
