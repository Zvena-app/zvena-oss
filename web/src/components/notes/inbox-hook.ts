"use client";

// The sidebar's "Inbox" row (Notion's). The ecosystem's Inbox plugs in here
// with registerInbox(): it opens its panel and reports the unread count.
// Without it the row stays hidden — Documents never shows an empty Inbox.

import { useSyncExternalStore } from "react";

export interface InboxHook {
  open: (anchor: HTMLElement) => void;
  unread?: number;
}

type Listener = () => void;
interface Registry {
  hook: InboxHook | null;
  listeners: Set<Listener>;
}

const KEY = Symbol.for("zvena.notes.inbox");
const g = globalThis as unknown as Record<symbol, Registry | undefined>;
const reg: Registry = (g[KEY] ??= { hook: null, listeners: new Set() });

/** Plugs the Inbox in (null unplugs it); call again to update the unread count. */
export function registerInbox(hook: InboxHook | null): void {
  reg.hook = hook;
  reg.listeners.forEach((fn) => fn());
}

export function useInbox(): InboxHook | null {
  return useSyncExternalStore(
    (fn) => {
      reg.listeners.add(fn);
      return () => reg.listeners.delete(fn);
    },
    () => reg.hook,
    () => null
  );
}
