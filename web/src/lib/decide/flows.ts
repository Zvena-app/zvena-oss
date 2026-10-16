// Issues that follow the other products. Server-only.
//
//   Design    an issue made from a Design comment (lib/eco/design.ts) is done
//             when its comment thread is resolved in Design, and opens again
//             when the thread is reopened — if Jev was the one who closed it
//             and nobody moved it since. (The other way round, closing the
//             issue resolves the thread, is lib/eco/design.ts.)
//   Calendar  an issue made from a meeting (lib/eco/calendar.ts) is due on
//             the meeting's day; when the meeting moves, the due date moves
//             with it — while the issue is open and nobody changed the date
//             by hand.
//
// Exact rules, no AI: they run whatever the Jev switch says, with the rights
// of the person whose change set them off (or who made the issue), and each
// step lands in Jev's journal with Undo. The workspace's owner turns each of
// them off in the hub's settings (hub.ts).

import { calDb } from "../calendar/db";
import { eventRow } from "../calendar/events";
import { commentThread } from "../eco/design";
import { ecoDb } from "../eco/schema";
import { ctxFor, type Ctx } from "../projects/core";
import { getIssueBrief, updateIssue } from "../projects/issues";
import { statusOfCategory } from "../projects/teams";
import { listenAll, type PulseEvent } from "../pulse/bus";
import { sql, store } from "../store";
import { ensureSchema } from "./engine";
import { lastApplied, recordHub } from "./journal";

const USER_RE = /^[A-Za-z0-9_-]{6,64}$/;
/** Threads of one file looked at per change in Design. */
const THREADS_PER_FILE = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dz_flows (
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  issue TEXT NOT NULL,
  day TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (ws, event, issue)
) WITHOUT ROWID;
`;

interface State {
  started: boolean;
  db: object | null;
}
const KEY = Symbol.for("zvena.decide.flows");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const st: State = (g[KEY] ??= { started: false, db: null });

function schema(): void {
  ensureSchema();
  const d = store();
  if (st.db === d) return;
  d.exec(SCHEMA);
  st.db = d;
}

type Enabled = (ws: string) => boolean;

function categoryOf(statusId: string): string | null {
  return (sql("SELECT category FROM pj_statuses WHERE id = ?").get(statusId) as { category: string } | undefined)?.category ?? null;
}

function jevCtx(userId: string, ws: string): Ctx | null {
  try {
    return { ...ctxFor(userId, ws, "edit"), via: "jev" };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Design

/** A person (not "design", a rule or the clock) whose rights a step may use. */
const personOf = (by: string | null | undefined): string | null => (by && by !== "design" && USER_RE.test(by) ? by : null);

/** The first of these people who may edit the issue: their context and the issue as they see it. */
function editorOf(ws: string, issueId: string, people: (string | null)[]): { ctx: Ctx; issue: ReturnType<typeof getIssueBrief>; who: string } | null {
  for (const who of [...new Set(people.filter((p): p is string => Boolean(p)))]) {
    const ctx = jevCtx(who, ws);
    if (!ctx) continue;
    try {
      return { ctx, issue: getIssueBrief(ctx, issueId), who };
    } catch {
      // Not theirs to see: the next one.
    }
  }
  return null;
}

/**
 * Something changed in a file's comment threads: the issues made from them
 * follow their threads. `thread`: the one that changed (Design says which
 * when one is resolved or reopened; else the file's newest threads are
 * looked at). `by`: the person who changed it in Design — else, or when they
 * may not edit the issue, the issue's maker acts. Returns how many issues
 * moved (tests).
 */
export async function followThreads(ws: string, file: string, by: string | null, enabled: Enabled = () => true, thread: string | null = null): Promise<number> {
  if (!enabled(ws)) return 0;
  ecoDb();
  const rows = (
    thread
      ? sql("SELECT thread_id, issue_id, created_by, resolved FROM eco_design_threads WHERE ws_id = ? AND file_id = ? AND thread_id = ?").all(ws, file, thread)
      : sql("SELECT thread_id, issue_id, created_by, resolved FROM eco_design_threads WHERE ws_id = ? AND file_id = ? ORDER BY created_at DESC LIMIT ?").all(ws, file, THREADS_PER_FILE)
  ) as { thread_id: string; issue_id: string; created_by: string; resolved: number }[];
  let moved = 0;
  for (const r of rows) {
    const person = personOf(by);
    // Read as someone who may: Design says whether they may read the file.
    let t = person ? await commentThread(person, r.thread_id) : null;
    if (!t) t = await commentThread(r.created_by, r.thread_id);
    if (!t || typeof t.isResolved !== "boolean" || t.isResolved === Boolean(r.resolved)) continue;
    const ed = editorOf(ws, r.issue_id, [person, r.created_by]);
    // Nobody here may move the issue: the thread's state stays as it was, to be followed on its next change.
    if (!ed) continue;
    const { ctx, issue, who } = ed;
    // The thread's state first, so the issue's own follow-up (resolving the thread) finds nothing to do.
    sql("UPDATE eco_design_threads SET resolved = ? WHERE ws_id = ? AND thread_id = ?").run(t.isResolved ? 1 : 0, ws, r.thread_id);
    const cat = categoryOf(issue.statusId);
    if (t.isResolved && cat !== "completed" && cat !== "canceled") {
      const done = statusOfCategory(issue.teamId, "completed");
      if (!done) continue;
      try {
        updateIssue(ctx, issue.id, { statusId: done });
      } catch {
        continue;
      }
      recordHub(ws, { subject: `issue:${issue.id}`, source: "rule", mode: "auto", status: "applied", payload: { kind: "issue", issue: issue.id, field: "status", prev: issue.statusId, next: done, why: "thread_resolved", from: `design:${file}` }, by: who });
      moved++;
    } else if (!t.isResolved && cat === "completed") {
      // Only an issue Jev closed for its thread, still where Jev put it.
      const last = lastApplied(ws, issue.id, "issue");
      if (!last || last.payload.kind !== "issue" || last.payload.why !== "thread_resolved" || last.payload.next !== issue.statusId || !last.payload.prev) continue;
      try {
        updateIssue(ctx, issue.id, { statusId: last.payload.prev });
      } catch {
        continue;
      }
      recordHub(ws, { subject: `issue:${issue.id}`, source: "rule", mode: "auto", status: "applied", payload: { kind: "issue", issue: issue.id, field: "status", prev: issue.statusId, next: last.payload.prev, why: "thread_reopened", from: `design:${file}` }, by: who });
      moved++;
    }
  }
  return moved;
}

// ------------------------------------------------------------------ Calendar

/** An issue made from a meeting follows its day from now on (lib/eco/calendar.ts calls it). */
export function trackEvent(ws: string, eventId: string, issueId: string, day: string, by: string): void {
  schema();
  sql("INSERT INTO dz_flows (ws, event, issue, day, by, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ws, event, issue) DO UPDATE SET day = excluded.day, by = excluded.by, at = excluded.at").run(ws, eventId, issueId, day, by, Date.now());
}

/** Meetings changed: the issues made from them follow their day. Returns how many moved (tests). */
export function followEvents(ws: string, ids: readonly string[], by: string | null, enabled: Enabled = () => true): number {
  schema();
  calDb();
  let moved = 0;
  for (const id of ids.slice(0, 50)) {
    const rows = sql("SELECT issue, day, by FROM dz_flows WHERE ws = ? AND event = ?").all(ws, id) as { issue: string; day: string; by: string }[];
    if (!rows.length) continue;
    const ev = eventRow(id);
    if (!ev || ev.deleted_at || ev.ws_id !== ws) {
      sql("DELETE FROM dz_flows WHERE ws = ? AND event = ?").run(ws, id);
      continue;
    }
    // A meeting that became a series has no single day to follow.
    if (ev.rrule) continue;
    const day = ev.start_day;
    for (const r of rows) {
      if (r.day === day || !enabled(ws)) continue;
      // The person who moved it, else (they may not edit the issue, or a calendar sync moved it) the issue's maker.
      const ed = editorOf(ws, r.issue, [personOf(by), r.by]);
      // Nobody here may: the day it follows stays, to be caught up on the meeting's next change.
      if (!ed) continue;
      const { ctx, issue, who } = ed;
      sql("UPDATE dz_flows SET day = ?, at = ? WHERE ws = ? AND event = ? AND issue = ?").run(day, Date.now(), ws, id, r.issue);
      const cat = categoryOf(issue.statusId);
      // A closed issue, or a date someone set by hand, stays.
      if (cat === "completed" || cat === "canceled" || issue.dueDate !== r.day) continue;
      try {
        updateIssue(ctx, issue.id, { dueDate: day });
      } catch {
        continue;
      }
      recordHub(ws, { subject: `issue:${issue.id}`, source: "rule", mode: "auto", status: "applied", payload: { kind: "issue", issue: issue.id, field: "due", prev: r.day, next: day, why: "event_moved", from: `event:${id}` }, by: who });
      moved++;
    }
  }
  return moved;
}

/** Starts following Design and Calendar (once per process; hub.ts). */
export function startFlows(design: Enabled, calendar: Enabled): void {
  if (st.started) return;
  st.started = true;
  listenAll((e: PulseEvent) => {
    try {
      if (e.type === "design" && e.ref && e.data?.event === "update-comment-thread") {
        const thread = typeof e.data.thread === "string" && /^[0-9a-f-]{36}$/.test(e.data.thread) ? e.data.thread : null;
        void followThreads(e.ws, e.ref, e.by ?? null, design, thread).catch(() => {});
      }
      else if (e.type === "calendar" && e.refs?.length) followEvents(e.ws, e.refs, e.by ?? null, calendar);
    } catch {
      // One failed step never stops the change that set it off.
    }
  });
}
