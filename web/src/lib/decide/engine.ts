// The reactions engine. Server-only. It hears every workspace's pulse, finds
// the reactions whose `when` matches, judges each subject and acts:
//
//   compare / always   exact and instant: acts on the edge (false → true)
//   ask (the model)    only where the workspace owner left smart suggestions
//                      on; the chosen fields go out, nothing else. Confidence
//                      ≥ auto: act; ≥ suggest: a person confirms (pulse
//                      "decision"); below, or the model off/slow/down: nothing happens.
//
// Every judgement that leads somewhere is written to dz_decisions (ids,
// verdict, confidence, timing; never document content), so "why did this
// change?" always has an answer. A chain of reactions stops at depth 3, and a
// reaction never fires on its own write.

import { randomBytes, createHash } from "node:crypto";
import { emit, listenAll, registerPulseFilter, type PulseEvent } from "../pulse/bus";
import { AccessResolver, atLeast } from "../notes/access";
import { keyVisible } from "../eco/visibility";
import { sql, store, tx } from "../store";
import { runAction, subjectsFor, targetsOf, type Subject } from "./adapters";
import { ask, noul, setWorkspaceGate, smartAvailable, smartDefault } from "./smart";
import { cleanAction, cleanReaction, compare, MAX_REACTIONS, type Action, type Reaction } from "./model";
import { metricReadable } from "./sources";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dz_reactions (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dz_reactions_ws ON dz_reactions(ws);
-- The last verdict per reaction and subject: reactions fire on the edge.
CREATE TABLE IF NOT EXISTS dz_edges (
  reaction_id TEXT NOT NULL REFERENCES dz_reactions(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  hit INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (reaction_id, subject)
);
CREATE TABLE IF NOT EXISTS dz_decisions (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reaction_id TEXT,
  subject TEXT NOT NULL,
  source TEXT NOT NULL,              -- rule | model
  confidence REAL,                   -- model: probability of yes
  mode TEXT NOT NULL,                -- auto | suggest
  status TEXT NOT NULL,              -- applied | unchanged | pending | accepted | rejected | expired
  model TEXT,
  ms INTEGER,
  actions TEXT,                      -- JSON, what a pending suggestion will do
  row_id TEXT,
  at INTEGER NOT NULL,
  resolved_by TEXT,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS dz_decisions_ws ON dz_decisions(ws, at);
CREATE TABLE IF NOT EXISTS dz_settings (
  ws TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  smart INTEGER NOT NULL DEFAULT 0,
  ingest_hash TEXT UNIQUE,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
-- The latest value of each live number (dashboards read it; reactions judge it).
CREATE TABLE IF NOT EXISTS dz_metrics (
  ws TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  label TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (ws, key)
);
`;

const DEPTH_MAX = 3;
const ASK_QUIET_MS = 2500;
const DECISIONS_KEEP = 90 * 24 * 3600_000;
const SUGGESTION_TTL = 14 * 24 * 3600_000;

interface EngineState {
  started: boolean;
  dbFile: object | null;
  reactions: Map<string, Reaction[]>;
  /** Writes made by reactions: `${ws}:${noteId | issueId}` → chain depth (for a few seconds). */
  chain: Map<string, { depth: number; reaction: string; until: number }>;
  /** Ask conditions wait for a quiet moment per reaction and subject. */
  waiting: Map<string, ReturnType<typeof setTimeout>>;
  /** Actions taken per reaction in the current minute. */
  budget: Map<string, { since: number; used: number }>;
  lastPurge: number;
}
const KEY = Symbol.for("zvena.decide.engine");
const g = globalThis as unknown as Record<symbol, EngineState | undefined>;
const st: EngineState = (g[KEY] ??= { started: false, dbFile: null, reactions: new Map(), chain: new Map(), waiting: new Map(), budget: new Map(), lastPurge: 0 });
st.budget ??= new Map();

/** Creates the tables on the open database (once per database handle). */
export function ensureSchema(): void {
  const d = store();
  if (st.dbFile === d) return;
  d.exec(SCHEMA);
  st.dbFile = d;
  st.reactions.clear();
}

// ---------------------------------------------------------------- settings

export interface DecideSettings {
  /** Smart suggestions and automations (the decision model) in this workspace. */
  smart: boolean;
  ingest: boolean;
}

export function settingsOf(ws: string): DecideSettings {
  ensureSchema();
  const r = sql("SELECT smart, ingest_hash FROM dz_settings WHERE ws = ?").get(ws) as { smart: number; ingest_hash: string | null } | undefined;
  // A workspace whose owner never chose follows ZVENA_AI_DEFAULT: on unless set to "off"
  // (on everywhere until a workspace owner turns it off; ZVENA_AI_DEFAULT=off makes it opt-in).
  return { smart: r ? r.smart === 1 : smartDefault(), ingest: Boolean(r?.ingest_hash) };
}

export { smartDefault };

// The one switch smart.ts checks before anything leaves the server.
setWorkspaceGate((ws) => settingsOf(ws).smart);

/** The owner's switch: may this workspace's chosen fields be sent to the decision model? On unless turned off. */
export function setSmart(ws: string, on: boolean, by: string): void {
  ensureSchema();
  sql("INSERT INTO dz_settings (ws, smart, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ws) DO UPDATE SET smart = excluded.smart, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(ws, on ? 1 : 0, by, Date.now());
}

const tokenHash = (t: string) => createHash("sha256").update(`zvena-ingest:${t}`).digest("base64url");

/** A new secret for pushing live numbers (shown once; the old one stops working). */
export function newIngestToken(ws: string, by: string): string {
  ensureSchema();
  const token = `zvi_${randomBytes(24).toString("base64url")}`;
  // A first row keeps the default (on); an existing row keeps the owner's choice.
  sql("INSERT INTO dz_settings (ws, smart, ingest_hash, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ws) DO UPDATE SET ingest_hash = excluded.ingest_hash, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(ws, smartDefault() ? 1 : 0, tokenHash(token), by, Date.now());
  return token;
}

export function revokeIngestToken(ws: string): void {
  ensureSchema();
  sql("UPDATE dz_settings SET ingest_hash = NULL WHERE ws = ?").run(ws);
}

/** The workspace an ingest secret belongs to. */
export function wsOfIngestToken(token: string): string | null {
  if (!/^zvi_[A-Za-z0-9_-]{32}$/.test(token)) return null;
  ensureSchema();
  const r = sql("SELECT ws FROM dz_settings WHERE ingest_hash = ?").get(tokenHash(token)) as { ws: string } | undefined;
  return r?.ws ?? null;
}

// ----------------------------------------------------------------- metrics

export const METRIC_KEY_RE = /^[\p{L}\p{N}_.:-]{1,64}$/u;
/** Keys of numbers counted from the workspace ("docs:…", "project:…"). */
export const SOURCE_KEY_RE = /^(docs|project|calendar|mail):/;
const MAX_METRICS = 500;

/** Stores a live number and puts it on the pulse (dashboards redraw, reactions judge). */
export function putMetric(ws: string, key: string, value: number, label: string | null, by: string): boolean {
  ensureSchema();
  if (!METRIC_KEY_RE.test(key) || !Number.isFinite(value)) return false;
  // A number counted from the workspace (lib/decide/sources.ts) is written by its source only:
  // typed in or pushed, it could close the goals on it.
  if (SOURCE_KEY_RE.test(key) && by !== "source") return false;
  const exists = sql("SELECT 1 FROM dz_metrics WHERE ws = ? AND key = ?").get(ws, key);
  if (!exists) {
    const n = sql("SELECT COUNT(*) AS n FROM dz_metrics WHERE ws = ?").get(ws) as { n: number };
    if (Number(n.n) >= MAX_METRICS) return false;
  }
  const at = Date.now();
  sql("INSERT INTO dz_metrics (ws, key, value, label, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ws, key) DO UPDATE SET value = excluded.value, label = COALESCE(excluded.label, dz_metrics.label), at = excluded.at").run(ws, key, value, label, at);
  emit(ws, { type: "metric", ref: key, by, data: { value, ...(label ? { label } : {}) } });
  return true;
}

export function metricsOf(ws: string): { key: string; value: number; label: string | null; at: number }[] {
  ensureSchema();
  return sql("SELECT key, value, label, at FROM dz_metrics WHERE ws = ? ORDER BY key").all(ws) as { key: string; value: number; label: string | null; at: number }[];
}

// --------------------------------------------------------------- reactions

export function reactionsOf(ws: string): Reaction[] {
  ensureSchema();
  const hit = st.reactions.get(ws);
  if (hit) return hit;
  const rows = sql("SELECT json FROM dz_reactions WHERE ws = ? ORDER BY updated_at").all(ws) as { json: string }[];
  const list = rows.map((r) => cleanReaction(JSON.parse(r.json))).filter((r): r is Reaction => r !== null);
  st.reactions.set(ws, list);
  return list;
}

export function saveReaction(ws: string, raw: unknown, by: string): Reaction | { error: string } {
  ensureSchema();
  const r = cleanReaction(raw);
  if (!r) return { error: "invalid" };
  const other = sql("SELECT ws FROM dz_reactions WHERE id = ?").get(r.id) as { ws: string } | undefined;
  if (other && other.ws !== ws) return { error: "invalid" };
  if (!other && reactionsOf(ws).length >= MAX_REACTIONS) return { error: "limit" };
  if (r.when.type === "notes" && !sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, r.when.db)) return { error: "no database" };
  // A rule reads and writes as the person who saves it: only Documents they may open (and edit, to change).
  const docs = new AccessResolver(ws, by);
  if (r.when.type === "notes" && docs.level(r.when.db) === null) return { error: "forbidden" };
  for (const a of r.then) {
    if ((a.do === "notes.done" || a.do === "notes.set") && a.note !== "$row" && !atLeast(docs.level(a.note), "edit")) return { error: "forbidden" };
    if (a.do === "links.done" && a.from.startsWith("note:") && docs.level(a.from.slice(5)) === null) return { error: "forbidden" };
  }
  // A rule on a live number reads it as the person who saves it, as a goal set from an issue does:
  // a number counted from the workspace only while they may see it (never a colleague's mail).
  if (r.when.type === "metric" && !metricReadable(ws, r.when.key, by)) return { error: "forbidden" };
  tx(() => {
    sql("INSERT INTO dz_reactions (id, ws, json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(r.id, ws, JSON.stringify(r), by, Date.now());
    // A changed reaction judges every subject afresh.
    sql("DELETE FROM dz_edges WHERE reaction_id = ?").run(r.id);
  });
  st.reactions.delete(ws);
  // A goal saved when its number already meets it is judged now, not at the number's next change.
  if (r.on && r.when.type === "metric") {
    const m = sql("SELECT value, label FROM dz_metrics WHERE ws = ? AND key = ?").get(ws, r.when.key) as { value: number; label: string | null } | undefined;
    if (m) {
      const e: PulseEvent = { id: 0, ws, type: "metric", ref: r.when.key, at: Date.now(), data: { value: m.value, ...(m.label ? { label: m.label } : {}) } };
      for (const s of subjectsFor(ws, r.when, e, r.id)) void fire(ws, r, s, 0).catch(() => {});
    }
  }
  return r;
}

export function deleteReaction(ws: string, id: string): boolean {
  ensureSchema();
  const n = Number(sql("DELETE FROM dz_reactions WHERE ws = ? AND id = ?").run(ws, id).changes);
  st.reactions.delete(ws);
  return n > 0;
}

// ------------------------------------------------------------------ engine

export interface Verdict {
  hit: boolean;
  source: "rule" | "model";
  mode: "auto" | "suggest" | "none";
  confidence?: number;
  model?: string;
  ms?: number;
}

/** Judges one subject. `null`: no verdict (the model off, slow or unsure) — nothing happens, the edge is kept. */
export async function judge(ws: string, r: Reaction, s: Subject): Promise<Verdict | null> {
  const c = r.if;
  if (c.kind === "always") return { hit: true, source: "rule", mode: "auto" };
  if (c.kind === "compare") return { hit: compare(s.facts[c.field], c.op, c.value), source: "rule", mode: "auto" };
  if (!settingsOf(ws).smart || !smartAvailable()) return null;
  // Only the chosen fields leave the server, and never one that names a person (an assignee,
  // a person, e-mail or phone column, a formula or rollup that may read one; the people a page's
  // text mentions): a question about those has no answer, nothing happens.
  const state: Record<string, unknown> = {};
  for (const f of c.fields) if (f in s.facts && !s.personal?.includes(f)) state[f] = f === "@body" && s.bodyForModel ? s.bodyForModel() : s.facts[f];
  if (!Object.keys(state).length) return null;
  const out = await ask(ws, state, { yes: noul(c.question) });
  if (!out) return null;
  const p = out.answers.yes.noul;
  const mode = p >= c.auto ? "auto" : p >= c.suggest ? "suggest" : "none";
  return { hit: mode !== "none", source: "model", mode, confidence: p, model: out.model, ms: out.ms };
}

function edge(reactionId: string, subject: string, hit: boolean): boolean {
  const prev = sql("SELECT hit FROM dz_edges WHERE reaction_id = ? AND subject = ?").get(reactionId, subject) as { hit: number } | undefined;
  sql("INSERT INTO dz_edges (reaction_id, subject, hit, at) VALUES (?, ?, ?, ?) ON CONFLICT(reaction_id, subject) DO UPDATE SET hit = excluded.hit, at = excluded.at").run(reactionId, subject, hit ? 1 : 0, Date.now());
  return hit && prev?.hit !== 1;
}

/** Actions per reaction per minute: past it a reaction rests (a runaway rule cannot flood a workspace). */
const ACTIONS_PER_MINUTE = 120;

function overBudget(reactionId: string, n: number): boolean {
  const now = Date.now();
  let b = st.budget.get(reactionId);
  if (!b || now - b.since > 60_000) st.budget.set(reactionId, (b = { since: now, used: 0 }));
  if (b.used + n > ACTIONS_PER_MINUTE) return true;
  b.used += n;
  if (st.budget.size > 5000) st.budget.clear();
  return false;
}

function applyAll(ws: string, r: Reaction, actions: Action[], s: Subject, depth: number): boolean {
  if (overBudget(r.id, actions.length)) return false;
  let changed = false;
  const mark = (id: string) => st.chain.set(`${ws}:${id}`, { depth: depth + 1, reaction: r.id, until: Date.now() + 10_000 });
  for (const a of actions) {
    for (const id of targetsOf(ws, a, s)) mark(id);
    const created: string[] = [];
    try {
      if (runAction(ws, a, s, `rule:${r.id}`, created)) changed = true;
    } catch {
      // One failed action does not stop the others.
    }
    // What the rule made is its own write too: it never fires on it.
    for (const id of created) mark(id);
  }
  return changed;
}

function record(ws: string, r: Reaction, s: Subject, v: Verdict, status: string): string {
  const id = randomBytes(12).toString("base64url");
  sql("INSERT INTO dz_decisions (id, ws, reaction_id, subject, source, confidence, mode, status, model, ms, actions, row_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    ws,
    r.id,
    s.key,
    v.source,
    v.confidence ?? null,
    v.mode,
    status,
    v.model ?? null,
    v.ms ?? null,
    status === "pending" ? JSON.stringify(r.then) : null,
    s.rowId ?? s.issueId ?? null,
    Date.now()
  );
  return id;
}

/** Judges and acts for one reaction and subject (exported for tests). */
export async function fire(ws: string, r: Reaction, s: Subject, depth: number): Promise<"applied" | "unchanged" | "pending" | "skip"> {
  const v = await judge(ws, r, s);
  if (!v) return "skip";
  // The reaction may have been switched off or removed while the question was out.
  if (!reactionsOf(ws).some((x) => x.id === r.id && x.on)) return "skip";
  if (!edge(r.id, s.key, v.hit)) return "skip";
  if (v.mode === "suggest") {
    const id = record(ws, r, s, v, "pending");
    emit(ws, { type: "decision", ref: id, by: `rule:${r.id}`, data: { mode: "suggest", reaction: r.id } });
    return "pending";
  }
  const changed = applyAll(ws, r, r.then, s, depth);
  const id = record(ws, r, s, v, changed ? "applied" : "unchanged");
  if (changed) emit(ws, { type: "decision", ref: id, by: `rule:${r.id}`, data: { mode: "auto", reaction: r.id } });
  return changed ? "applied" : "unchanged";
}

/**
 * Projects' changes come in bursts (a bulk edit of 200 issues, a cycle
 * closing): they are coalesced per issue and judged in slices of a few
 * milliseconds, so a burst never holds the server up.
 */
const projectsQueue = new Map<string, PulseEvent>();
let projectsTimer: ReturnType<typeof setTimeout> | null = null;
const SLICE_MS = 8;

function drainProjects(): void {
  projectsTimer = null;
  const until = Date.now() + SLICE_MS;
  for (const [k, e] of projectsQueue) {
    projectsQueue.delete(k);
    try {
      judgeEvent(e);
    } catch {
      // One event never stops the others.
    }
    if (Date.now() > until) break;
  }
  if (projectsQueue.size && !projectsTimer) projectsTimer = setTimeout(drainProjects, 0);
}

/** One pulse event: every matching reaction of the workspace judges its subjects. */
export function onEvent(e: PulseEvent): void {
  if (e.type === "projects") {
    // Only workspaces with rules on Projects pay anything for its events.
    let any = false;
    try {
      any = reactionsOf(e.ws).some((r) => r.on && r.when.type === "projects");
    } catch {
      any = false;
    }
    if (!any || !e.ref) return;
    projectsQueue.set(`${e.ws}|${e.ref}`, e);
    projectsTimer ??= setTimeout(drainProjects, 0);
    return;
  }
  judgeEvent(e);
}

function judgeEvent(e: PulseEvent): void {
  if (e.type !== "metric" && e.type !== "notes" && e.type !== "projects") return;
  let list: Reaction[];
  try {
    list = reactionsOf(e.ws).filter((r) => r.on && r.when.type === e.type);
  } catch {
    return;
  }
  if (!list.length) return;
  const now = Date.now();
  for (const [k, c] of st.chain) if (c.until < now) st.chain.delete(k);
  for (const r of list) {
    // A rule's own write (or a chain past its depth) is skipped before anything is read.
    if (e.type === "projects" && e.ref) {
      const pre = st.chain.get(`${e.ws}:${e.ref}`);
      if (pre && (pre.reaction === r.id || pre.depth >= DEPTH_MAX)) continue;
    }
    let subjects: Subject[];
    try {
      subjects = subjectsFor(e.ws, r.when, e, r.id);
    } catch {
      continue;
    }
    for (const s of subjects) {
      const own = s.rowId ?? s.issueId;
      const link = own ? st.chain.get(`${e.ws}:${own}`) : undefined;
      if (link && (link.reaction === r.id || link.depth >= DEPTH_MAX)) continue;
      const depth = link?.depth ?? 0;
      const run = () => void fire(e.ws, r, s, depth).catch(() => {});
      if (r.if.kind !== "ask") {
        run();
        continue;
      }
      // A row being typed into changes every second: ask once it settles.
      const key = `${r.id}|${s.key}`;
      const t = st.waiting.get(key);
      if (t) clearTimeout(t);
      st.waiting.set(
        key,
        setTimeout(() => {
          st.waiting.delete(key);
          // The subject as it is now, not as it was when the first edit came in.
          try {
            const fresh = subjectsFor(e.ws, r.when, e, r.id).find((x) => x.key === s.key);
            if (fresh) void fire(e.ws, r, fresh, depth).catch(() => {});
          } catch {
            // The subject cannot be read now (deleted meanwhile): nothing to judge.
          }
        }, ASK_QUIET_MS)
      );
    }
  }
  purgeOld(now);
}

function purgeOld(now: number): void {
  if (now - st.lastPurge < 3600_000) return;
  st.lastPurge = now;
  try {
    pruneDecisions(now);
  } catch {
    // Retried next hour.
  }
}

/**
 * The decision log keeps 90 days (/legal/privacy#retention), and a suggestion nobody answered
 * expires after 14. Runs hourly from lib/maintenance.ts in every workspace, rules or not
 * (the hub's and Documents automations' records live here too). Returns how many went.
 */
export function pruneDecisions(now = Date.now()): number {
  ensureSchema();
  const n = Number(sql("DELETE FROM dz_decisions WHERE at < ?").run(now - DECISIONS_KEEP).changes);
  sql("UPDATE dz_decisions SET status = 'expired' WHERE status = 'pending' AND at < ?").run(now - SUGGESTION_TTL);
  return n;
}

/** Starts hearing the pulse (once per process; src/instrumentation.ts). */
export function startReactions(): void {
  if (st.started) return;
  st.started = true;
  listenAll(onEvent);
}

// --------------------------------------------------------------- decisions

export interface DecisionRow {
  id: string;
  reaction_id: string | null;
  subject: string;
  source: string;
  confidence: number | null;
  mode: string;
  status: string;
  model: string | null;
  ms: number | null;
  row_id: string | null;
  at: number;
  resolved_by: string | null;
  resolved_at: number | null;
}

/**
 * What a person may see of the workspace's rules and decisions: a rule over a database or
 * rows they cannot open, and a decision about something hidden from them, are not theirs to know.
 */
export function visibleRules(ws: string, userId: string, reactions: Reaction[], decisions: DecisionRow[]): { reactions: Reaction[]; decisions: DecisionRow[] } {
  const docs = new AccessResolver(ws, userId);
  const noteOk = (id: string) => docs.level(id) !== null;
  const ruleOk = (r: Reaction) =>
    (r.when.type !== "notes" || noteOk(r.when.db)) &&
    // A rule on a number counted from what the person cannot see (someone else's mail) is not theirs to know.
    (r.when.type !== "metric" || metricReadable(ws, r.when.key, userId)) &&
    r.then.every((a) => {
      if ((a.do === "notes.done" || a.do === "notes.set") && a.note !== "$row") return noteOk(a.note);
      if ((a.do === "issue.done" || a.do === "issue.set") && a.issue !== "$subject") return keyVisible(userId, ws, `issue:${a.issue}`);
      if (a.do === "links.done" && a.from.includes(":")) return keyVisible(userId, ws, a.from);
      return true;
    });
  const shown = reactions.filter(ruleOk);
  // A decision of a rule hidden from the person is hidden too; one of a rule since deleted goes by its subject.
  const hidden = new Set(reactions.filter((r) => !ruleOk(r)).map((r) => r.id));
  return { reactions: shown, decisions: decisions.filter((d) => !(d.reaction_id && hidden.has(d.reaction_id)) && keyVisible(userId, ws, d.subject)) };
}

/** Whether a person may know of a decision: its subject and its rule (if any) are visible to them. */
export function decisionVisible(ws: string, userId: string, reactionId: string | null, subject: string): boolean {
  if (!keyVisible(userId, ws, subject)) return false;
  if (!reactionId) return true;
  const r = reactionsOf(ws).find((x) => x.id === reactionId);
  if (!r) return true;
  return visibleRules(ws, userId, [r], []).reactions.length === 1;
}

/** "decision" events reach only people who may know of the decision. */
registerPulseFilter("decision", (userId, e) => {
  if (!e.ref) return true;
  try {
    const d = sql("SELECT reaction_id, subject FROM dz_decisions WHERE ws = ? AND id = ?").get(e.ws, e.ref) as { reaction_id: string | null; subject: string } | undefined;
    return d ? decisionVisible(e.ws, userId, d.reaction_id, d.subject) : true;
  } catch {
    return false;
  }
});

export function decisionsOf(ws: string, limit = 50): DecisionRow[] {
  ensureSchema();
  return sql(
    "SELECT id, reaction_id, subject, source, confidence, mode, status, model, ms, row_id, at, resolved_by, resolved_at FROM dz_decisions WHERE ws = ? ORDER BY at DESC LIMIT ?"
  ).all(ws, Math.min(200, Math.max(1, limit))) as unknown as DecisionRow[];
}

/** A person confirms or dismisses a suggestion. */
export function resolveDecision(ws: string, id: string, accept: boolean, by: string): "applied" | "unchanged" | "rejected" | "gone" {
  ensureSchema();
  const row = sql("SELECT reaction_id, subject, actions, row_id FROM dz_decisions WHERE ws = ? AND id = ? AND status = 'pending'").get(ws, id) as
    | { reaction_id: string; subject: string; actions: string; row_id: string | null }
    | undefined;
  if (!row) return "gone";
  // Only someone who may see what the suggestion is about, and the rule behind it, may settle it.
  if (!keyVisible(by, ws, row.subject)) return "gone";
  if (row.reaction_id && !decisionVisible(ws, by, row.reaction_id, row.subject)) return "gone";
  const now = Date.now();
  if (!accept) {
    sql("UPDATE dz_decisions SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE id = ?").run(by, now, id);
    emit(ws, { type: "decision", ref: id, by, data: { mode: "rejected" } });
    return "rejected";
  }
  let actions: Action[] = [];
  try {
    actions = (JSON.parse(row.actions) as unknown[]).map(cleanAction).filter((a): a is Action => a !== null);
  } catch {
    actions = [];
  }
  const r: Reaction = { id: row.reaction_id, name: "", on: true, when: { type: "metric", key: "-" }, if: { kind: "always" }, then: actions };
  // The subject as it was judged: a Documents row or an issue (its facts are read again by the actions).
  const subject: Subject = row.subject.startsWith("issue:") ? { key: row.subject, facts: {}, issueId: row.subject.slice(6) } : { key: row.subject, facts: {}, rowId: row.row_id ?? undefined };
  const changed = applyAll(ws, r, actions, subject, 0);
  sql("UPDATE dz_decisions SET status = 'accepted', resolved_by = ?, resolved_at = ? WHERE id = ?").run(by, now, id);
  emit(ws, { type: "decision", ref: id, by, data: { mode: "accepted" } });
  return changed ? "applied" : "unchanged";
}
