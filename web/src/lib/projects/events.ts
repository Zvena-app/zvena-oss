// Change events of Projects: every committed mutation announces itself here,
// so other parts of zvena (a live-update bus, an indexer) can follow without
// Projects importing them. Subscribers run after the current call stack
// (setImmediate), i.e. after the transaction committed, and their errors
// never reach the request that made the change.

export type PjEntity = "issue" | "project" | "comment" | "cycle" | "team" | "view" | "label" | "status";

export interface PjChange {
  ws: string;
  entity: PjEntity;
  id: string;
  /** The issue a comment belongs to. */
  issueId?: string;
  by: string;
  origin?: string;
  deleted?: boolean;
  /** A new issue or comment (not an edit). */
  created?: boolean;
  /** Made automatically (the autopilot) on the person's behalf. */
  via?: "auto";
  /** Background work (first-run examples): no autopilot. */
  quiet?: boolean;
  /** A project (goal) moved by its issues: met, reopened, started, a milestone met, or its counts moved (lib/projects/goals.ts). */
  goal?: { kind: "met" | "reopened" | "started" | "milestone" | "moved"; milestone?: string };
}

// One registry per process: Next bundles route handlers and instrumentation
// separately, so a module-level Set could exist once per bundle.
const KEY = Symbol.for("zvena.projects.events");
const g = globalThis as unknown as Record<symbol, Set<(c: PjChange) => void> | undefined>;
const subscribers = (g[KEY] ??= new Set());

export function onChange(fn: (c: PjChange) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function changed(c: PjChange): void {
  if (!subscribers.size) return;
  setImmediate(() => {
    for (const fn of [...subscribers]) {
      try {
        fn(c);
      } catch {
        // A subscriber's failure is its own.
      }
    }
  });
}
