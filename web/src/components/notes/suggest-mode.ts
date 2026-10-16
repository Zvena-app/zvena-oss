"use client";

// zvena Documents: whether an editor suggests on a page (Notion's "Editing /
// Suggesting" switch), remembered per page on this device. People who may
// only comment always suggest (PageView decides that, not this).

import { useSyncExternalStore } from "react";

const KEY = "nt-suggest";
const listeners = new Set<() => void>();
let pages: Set<string> | null = null;

function load(): Set<string> {
  if (pages) return pages;
  pages = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) for (const id of raw.slice(-200)) if (typeof id === "string") pages.add(id);
  } catch {
    // No storage (a private window): the switch lasts for this tab.
  }
  return pages;
}

export function isSuggesting(noteId: string): boolean {
  return typeof window !== "undefined" && load().has(noteId);
}

export function setSuggesting(noteId: string, on: boolean): void {
  const set = load();
  if (on === set.has(noteId)) return;
  if (on) set.add(noteId);
  else set.delete(noteId);
  try {
    localStorage.setItem(KEY, JSON.stringify([...set].slice(-200)));
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((fn) => fn());
}

export function useSuggesting(noteId: string | null | undefined): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => (noteId ? isSuggesting(noteId) : false),
    () => false
  );
}

/** Asks the open page's editor to accept or reject suggestions (all of them, or one). */
export function decideSuggestions(noteId: string, accept: boolean, sid?: string): void {
  window.dispatchEvent(new CustomEvent("nt-suggest-decide", { detail: { noteId, accept, sid } }));
}
