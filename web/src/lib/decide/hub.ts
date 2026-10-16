// Jev's hub: one place that starts and steers everything zvena does by itself.
// Server-only.
//
//   reactions   "when → if → then" on every product's pulse (engine.ts):
//               goals on numbers, rules on Documents rows and issues;
//   sources     live numbers from inside zvena — a Documents chart, a
//               project's progress, a calendar's meetings, one's own mail —
//               kept current (sources.ts);
//   autogoal    a new issue that states a target is linked to the number
//               that measures it (autogoal.ts);
//   cascade     a parent issue follows its sub-issues (cascade.ts);
//   flows       an issue follows Design (its comment thread resolved) and
//               Calendar (its meeting moved) (flows.ts);
//   docs        Documents' database automations: every run in the journal,
//               "only if Jev agrees" judged by Jev (docs-jev.ts);
//   autopilot   a new issue's priority, label, project, assignee and
//               duplicates; "is it done?" on comments (lib/projects/autopilot.ts);
//   journal     what all of them did or propose, with Undo (journal.ts).
//
// The Jev switch (dz_settings.jev, the owner's) decides whether anything goes
// to the model; the hub's own switches decide whether exact rules act by
// themselves. Both are the workspace owner's.

import { startAutopilot } from "../projects/autopilot";
import { sql, store } from "../store";
import { startAutogoal } from "./autogoal";
import { startCascade } from "./cascade";
import { startDocsJev } from "./docs-jev";
import { ensureSchema, settingsOf, startReactions } from "./engine";
import { startFlows } from "./flows";
import { jevConfigured, jevStats } from "./jev";
import { pruneSources, refreshTimed, startSources } from "./sources";

export interface HubSettings {
  /** A parent issue is done with its last sub-issue (and reopens with one). */
  parents: boolean;
  /** A new issue that states a target is linked to its number. */
  goals: boolean;
  /** An issue made from a Design comment is done when the thread is resolved (and reopens with it). */
  design: boolean;
  /** An issue made from a meeting keeps its due date on the meeting's day. */
  calendar: boolean;
}
const SWITCHES = ["parents", "goals", "design", "calendar"] as const;
const DEFAULTS: HubSettings = { parents: true, goals: true, design: true, calendar: true };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dz_hub (
  ws TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
`;

interface State {
  started: boolean;
  db: object | null;
  cache: Map<string, HubSettings>;
  timer: ReturnType<typeof setInterval> | null;
}
const KEY = Symbol.for("zvena.decide.hub");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const st: State = (g[KEY] ??= { started: false, db: null, cache: new Map(), timer: null });

function schema(): void {
  ensureSchema();
  const d = store();
  if (st.db === d) return;
  d.exec(SCHEMA);
  st.db = d;
  st.cache.clear();
}

export function hubSettings(ws: string): HubSettings {
  schema();
  const hit = st.cache.get(ws);
  if (hit) return hit;
  const r = sql("SELECT json FROM dz_hub WHERE ws = ?").get(ws) as { json: string } | undefined;
  let out = { ...DEFAULTS };
  try {
    const v = r ? (JSON.parse(r.json) as Partial<HubSettings>) : {};
    out = { parents: v.parents !== false, goals: v.goals !== false, design: v.design !== false, calendar: v.calendar !== false };
  } catch {
    out = { ...DEFAULTS };
  }
  st.cache.set(ws, out);
  return out;
}

export function setHubSettings(ws: string, patch: unknown, by: string): HubSettings {
  const p = (patch ?? {}) as Record<string, unknown>;
  const next = { ...hubSettings(ws) };
  for (const k of SWITCHES) {
    const v = p[k];
    if (typeof v === "boolean") next[k] = v;
  }
  sql("INSERT INTO dz_hub (ws, json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ws) DO UPDATE SET json = excluded.json, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(
    ws,
    JSON.stringify(next),
    by,
    Date.now()
  );
  st.cache.set(ws, next);
  return next;
}

const safely = (fn: (ws: string) => boolean) => (ws: string) => {
  try {
    return fn(ws);
  } catch {
    return false;
  }
};

/** Starts all of Jev's work (once per process; src/instrumentation.ts). */
export function startJev(): void {
  if (st.started) return;
  st.started = true;
  startReactions();
  startSources();
  startAutopilot();
  startCascade(safely((ws) => hubSettings(ws).parents));
  startAutogoal(safely((ws) => hubSettings(ws).goals));
  startFlows(
    safely((ws) => hubSettings(ws).design),
    safely((ws) => hubSettings(ws).calendar)
  );
  startDocsJev();
  // Every five minutes: numbers the clock moves (this week's meetings, snoozed mail);
  // hourly: sources no goal uses any more.
  let ticks = 0;
  st.timer = setInterval(() => {
    try {
      refreshTimed();
      if (++ticks % 12 === 0) pruneSources();
    } catch {
      // Next time.
    }
  }, 300_000);
  st.timer.unref?.();
}

/** What Jev runs in a workspace (the Home panel, settings): the model's state and the owner's switches. */
export function hubOverview(ws: string): { jev: { configured: boolean; on: boolean; breakerOpen: boolean }; rules: HubSettings; ingest: boolean } {
  const s = settingsOf(ws);
  // `ingest`: a key for numbers from outside exists (never the key itself).
  return { jev: { configured: jevConfigured(), on: s.jev, breakerOpen: jevStats().breakerOpen }, rules: hubSettings(ws), ingest: s.ingest };
}
