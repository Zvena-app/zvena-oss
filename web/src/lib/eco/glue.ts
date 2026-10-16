// Joins products that do not import each other. Server-only.
//
// Projects announces its changes on its own hook (lib/projects/events.ts) so
// that it builds without the pulse; here they become pokes on the workspace's
// pulse: open screens refresh and the indexer and reactions hear them.
//
//   { entity: "comment", id, issueId }  →  { type: "projects", ref: issueId }
//   { entity: "issue" | "project" …, id } →  { type: "projects", ref: id }

import { onChange, type PjChange } from "../projects/events";
import { emit } from "../pulse/bus";
import { registerEcoFilters } from "./visibility";

const KEY = Symbol.for("zvena.eco.glue");
const g = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export function projectsToPulse(c: PjChange): void {
  emit(c.ws, {
    type: "projects",
    ref: c.issueId ?? c.id,
    by: c.by,
    origin: c.origin,
    data: {
      entity: c.entity,
      id: c.id,
      deleted: c.deleted === true,
      // A goal that moved: what happened, never names or counts (they may include
      // teams a listener cannot see; clients re-read what they may see).
      ...(c.goal ? { goal: c.goal.kind, ...(c.goal.milestone ? { milestone: c.goal.milestone } : {}) } : {}),
    },
  });
}

/** Once per process. */
export function startGlue(): void {
  g[KEY] ??= onChange(projectsToPulse);
  // Private teams' pokes reach their members only.
  registerEcoFilters();
}
