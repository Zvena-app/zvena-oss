// Server-only: what happens after notes are saved (pushNotes). Every write —
// a device's sync, a form response, an automation, a co-editing snapshot —
// goes through pushNotes, so reactions hook in here once: notifications
// (people mentioned or assigned, comment threads), database automations,
// the version history. A handler runs after the write is committed; it may
// write again through pushNotes (with its own `by`, e.g. "automation:<id>").

import type { Note } from "./types";

export interface NoteChange {
  id: string;
  /** The note as stored before (null: new, or brought back from a tombstone). */
  before: Note | null;
  /** The note as saved (null: deleted forever). */
  after: Note | null;
}

export interface PushContext {
  ws: string;
  /** User id, "form", "automation:<id>"… */
  by: string;
  /** The display name of the person who pushed (people's pushes only). */
  author?: string;
}

type Handler = (changes: readonly NoteChange[], ctx: PushContext) => void;

const KEY = Symbol.for("zvena.notes.afterPush");
const g = globalThis as unknown as Record<symbol, Handler[] | undefined>;
const handlers: Handler[] = (g[KEY] ??= []);

/** Registers a reaction (once per process; module state is per route bundle, so this hangs off globalThis). */
export function onAfterPush(name: string, fn: Handler): void {
  const tagged = Object.assign(fn, { reaction: name });
  const i = handlers.findIndex((h) => (h as Handler & { reaction?: string }).reaction === name);
  if (i >= 0) handlers[i] = tagged;
  else handlers.push(tagged);
}

/** Runs the reactions; one failing never fails the write or the others. */
export function runAfterPush(changes: readonly NoteChange[], ctx: PushContext): void {
  if (changes.length === 0) return;
  for (const h of handlers) {
    try {
      h(changes, ctx);
    } catch (e) {
      console.error(`[notes] after-push reaction failed (${e instanceof Error ? e.name : "error"})`);
    }
  }
}
