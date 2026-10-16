// Server-only: database automations (Notion) run here, once, for every
// write of a signed-in workspace — a member's device, a form response, an
// import, a button, the clock. lib/notes/automations.ts holds the rules
// ("when … do …"); this file runs them:
//   - an after-push reaction (lib/notes/after-push.ts) checks the saved rows
//     against their database's "page added" / "property edited" triggers;
//   - a ticker runs "schedule" triggers at their wall-clock time in the
//     workspace's time zone, exactly once per occurrence (repeating
//     templates are schedule automations that add a page from a template);
//   - Button properties run their actions through the same engine
//     (/api/notes/button).
// Writes go through pushNotes with by "automation:<id>"; those writes do not
// trigger automations again (no chains, no loops). The automations hub hears every run
// (its journal, with Undo) and judges "run only if …" automations
// (lib/decide/docs-smart.ts registers both through setAutomationHooks). Webhooks go out after the
// response, through the SSRF guard of lib/web-read.ts. A guest's local-only
// workspace runs its automations in the browser (components/notes/automations-run.ts).

import { config } from "../config";
import { notify } from "../eco/inbox";
import { AccessResolver } from "./access";
import { deniedColumns, type Who } from "./column-perms";
import { sql } from "../store";
import { postJson } from "../web-read";
import { onAfterPush, type NoteChange, type PushContext } from "./after-push";
import { fires, resolveValues, type AutoAction, type Automation } from "./automations";
import { propValue, valueText } from "./db";
import { blankNote, displayTitle, noteSlug, sanitizeNote } from "./model";
import { DEFAULT_TZ, nextRun, validTimeZone, zonedNow, type ScheduleTrigger } from "./schedule";
import { inTrash, pushNotes } from "./server-store";
import { COMPUTED_TYPES, NO_VALUE_TYPES, type Note } from "./types";

const DAY = 86_400_000;
/** Action runs one write may set off… */
const MAX_PER_PUSH = 50;
/** …and one workspace in a minute. */
const MAX_PER_MINUTE = 300;
/** Webhooks in flight / waiting, process-wide. */
const WEBHOOKS_IN_FLIGHT = 4;
const WEBHOOKS_QUEUED = 200;
/** A scheduled run missed by more than this (server down) is skipped, not run late. */
const LATE_LIMIT = DAY;

const USER_RE = /^[A-Za-z0-9_-]{6,64}$/;

// --- Tables (created on first use; this module owns them) -----------------------

let ready = false;
function ensureTables(): void {
  if (ready) return;
  sql(
    "CREATE TABLE IF NOT EXISTS note_automation_runs (ws TEXT NOT NULL, db_id TEXT NOT NULL, automation_id TEXT NOT NULL, at INTEGER NOT NULL, runs INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1, error TEXT, PRIMARY KEY (ws, db_id, automation_id))"
  ).run();
  sql("CREATE TABLE IF NOT EXISTS note_schedules (ws TEXT NOT NULL, db_id TEXT NOT NULL, automation_id TEXT NOT NULL, spec TEXT NOT NULL, next_at INTEGER, PRIMARY KEY (ws, db_id, automation_id))").run();
  sql("CREATE INDEX IF NOT EXISTS note_schedules_next ON note_schedules(next_at)").run();
  ready = true;
}

// --- Workspace time zone --------------------------------------------------------

function defaultTz(): string {
  const env = process.env.ZVENA_TZ;
  return validTimeZone(env) ? env : DEFAULT_TZ;
}

/** The zone a workspace's scheduled automations keep time in. */
export function workspaceTz(ws: string): string {
  const row = sql("SELECT v FROM kv WHERE k = ?").get(`ws-tz:${ws}`) as { v: string } | undefined;
  return row && validTimeZone(row.v) ? row.v : defaultTz();
}

/** Sets the zone and re-times the workspace's schedules from now. */
export function setWorkspaceTz(ws: string, tz: string, now = Date.now()): boolean {
  if (!validTimeZone(tz)) return false;
  sql("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(`ws-tz:${ws}`, tz);
  ensureTables();
  for (const r of sql("SELECT db_id, automation_id, spec FROM note_schedules WHERE ws = ?").all(ws) as { db_id: string; automation_id: string; spec: string }[]) {
    sql("UPDATE note_schedules SET next_at = ? WHERE ws = ? AND db_id = ? AND automation_id = ?").run(nextRun(JSON.parse(r.spec) as ScheduleTrigger, tz, now), ws, r.db_id, r.automation_id);
  }
  return true;
}

// --- Reading notes ---------------------------------------------------------------

function load(ws: string, id: string): Note | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  try {
    return sanitizeNote(JSON.parse(r?.json ?? "null"));
  } catch {
    return null;
  }
}

/** The order after a database's last row (rows are ordered by a fractional key). */
function afterLastRow(ws: string, dbId: string, now: number): number {
  let last = 0;
  for (const r of sql("SELECT json FROM notes WHERE ws = ? AND deleted = 0 AND json LIKE ?").all(ws, `%"parentId":"${dbId}"%`) as { json: string | null }[]) {
    try {
      const n = JSON.parse(r.json ?? "null") as { parentId?: string; order?: number; template?: boolean } | null;
      if (n?.parentId === dbId && !n.template && typeof n.order === "number" && n.order > last) last = n.order;
    } catch {
      // An unreadable row does not stop the automation.
    }
  }
  return last ? last + 1024 : now;
}

// --- Limits ----------------------------------------------------------------------

const KEY = Symbol.for("zvena.notes.automations");
interface State {
  minute: Map<string, { at: number; n: number }>;
  hooks: { url: string; body: unknown; ws: string; dbId: string; automationId: string }[];
  inFlight: number;
}
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (g[KEY] ??= { minute: new Map(), hooks: [], inFlight: 0 });

/** Takes `n` runs from the workspace's minute budget and the push's budget. */
function take(ws: string, n: number, budget: { left: number }, now: number): boolean {
  if (budget.left < n) return false;
  const w = state.minute.get(ws);
  const cur = w && now - w.at < 60_000 ? w : { at: now, n: 0 };
  if (cur.n + n > MAX_PER_MINUTE) return false;
  cur.n += n;
  state.minute.set(ws, cur);
  budget.left -= n;
  return true;
}

// --- Run log ---------------------------------------------------------------------

function logRun(ws: string, dbId: string, automationId: string, error: string | null, now = Date.now()): void {
  ensureTables();
  sql(
    "INSERT INTO note_automation_runs (ws, db_id, automation_id, at, runs, ok, error) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(ws, db_id, automation_id) DO UPDATE SET at = excluded.at, runs = runs + 1, ok = excluded.ok, error = excluded.error"
  ).run(ws, dbId, automationId, now, error ? 0 : 1, error);
}

/** Notes a run that did not happen (smart suggestions off, condition not met…) where the automation's last run shows. */
export function noteRun(ws: string, dbId: string, automationId: string, error: string | null): void {
  logRun(ws, dbId, automationId, error);
}

export interface AutomationRun {
  automationId: string;
  at: number;
  runs: number;
  ok: boolean;
  error?: string;
  nextAt?: number;
}

/** The last run of each automation of a database (and the next time of scheduled ones). */
export function automationRuns(ws: string, dbId: string): AutomationRun[] {
  ensureTables();
  const runs = new Map<string, AutomationRun>();
  for (const r of sql("SELECT automation_id, at, runs, ok, error FROM note_automation_runs WHERE ws = ? AND db_id = ?").all(ws, dbId) as { automation_id: string; at: number; runs: number; ok: number; error: string | null }[]) {
    runs.set(r.automation_id, { automationId: r.automation_id, at: Number(r.at), runs: Number(r.runs), ok: r.ok === 1, ...(r.error ? { error: r.error } : {}) });
  }
  for (const r of sql("SELECT automation_id, next_at FROM note_schedules WHERE ws = ? AND db_id = ?").all(ws, dbId) as { automation_id: string; next_at: number | null }[]) {
    if (r.next_at === null) continue;
    const cur = runs.get(r.automation_id) ?? { automationId: r.automation_id, at: 0, runs: 0, ok: true };
    runs.set(r.automation_id, { ...cur, nextAt: Number(r.next_at) });
  }
  return [...runs.values()];
}

// --- Webhooks --------------------------------------------------------------------

function pageLink(ws: string, n: Pick<Note, "id" | "title">): string {
  return `${config.appUrl}/docs?ws=${encodeURIComponent(ws)}#${noteSlug(n)}`;
}

function webhookBody(ws: string, db: Note, row: Note | null, automation: { id: string; name: string }, now: number, hidden: ReadonlySet<string> = new Set()): unknown {
  const properties: Record<string, string> = {};
  for (const p of db.db?.properties ?? []) {
    if (!row || NO_VALUE_TYPES.includes(p.type) || hidden.has(p.id)) continue;
    properties[p.name || p.id] = valueText(p, propValue(row, p), "en");
  }
  return {
    event: "automation",
    automation,
    database: { id: db.id, title: db.title, url: pageLink(ws, db) },
    page: row ? { id: row.id, title: row.title, url: pageLink(ws, row), properties, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() } : null,
    at: new Date(now).toISOString(),
  };
}

/** Sends queued webhooks, a few at a time (never on the write's own path). */
function pumpWebhooks(): void {
  while (state.inFlight < WEBHOOKS_IN_FLIGHT && state.hooks.length) {
    const job = state.hooks.shift() as State["hooks"][number];
    state.inFlight++;
    void postJson(job.url, job.body)
      .then((r) => {
        if (!r.ok) logRun(job.ws, job.dbId, job.automationId, `webhook: ${r.error ?? `HTTP ${r.status}`}`);
      })
      .catch(() => logRun(job.ws, job.dbId, job.automationId, "webhook: failed"))
      .finally(() => {
        state.inFlight--;
        pumpWebhooks();
      });
  }
}

function queueWebhook(job: State["hooks"][number]): boolean {
  if (state.hooks.length >= WEBHOOKS_QUEUED) return false;
  state.hooks.push(job);
  setImmediate(pumpWebhooks);
  return true;
}

/** Test hook: webhooks waiting to be sent. */
export function pendingWebhooks(): readonly { url: string; body: unknown }[] {
  return state.hooks;
}

// --- The hub's hooks -------------------------------------------------------------

export interface RanInfo {
  ws: string;
  db: Note;
  /** The row as it was before the run (null: a scheduled run). */
  before: Note | null;
  automation: Automation;
  result: RunResult;
  /** Whose access the writes used. */
  as: string | null;
  /** The condition's verdict, when the automation asked. */
  verdict?: { confidence: number; model?: string; ms?: number; accepted?: string };
}

export interface AutomationHooks {
  /** An automation with a "run only if" condition fired on a row: the hub judges it (later, off the write's path). */
  judge(job: { ws: string; db: Note; row: Note; automation: Automation; actorId: string | null }): void;
  /** An automation ran (on a write, by the clock, or after the condition's or a person's yes). */
  ran(info: RanInfo): void;
}

// On globalThis: the server's bundles (instrumentation, each route) share one hub.
const HOOKS = Symbol.for("zvena.notes.automation-hooks");
const gh = globalThis as unknown as Record<symbol, AutomationHooks | null | undefined>;
export function setAutomationHooks(h: AutomationHooks | null): void {
  gh[HOOKS] = h;
}
const hooksNow = (): AutomationHooks | null => gh[HOOKS] ?? null;

// --- Running actions -------------------------------------------------------------

export interface RunContext {
  ws: string;
  /** Who the writes are attributed to: "automation:<id>", or the person who clicked a button. */
  by: string;
  /** The person whose action set it off (null: the clock, a form). */
  actorId: string | null;
  /**
   * The people whose access the run has (never more): an automation's
   * author; a button's clicker and its author. The first one's access
   * checks the writes; what any of them may not see stays out of webhooks
   * and notifications. Empty: nobody can vouch for it, nothing is written.
   */
  as: readonly string[];
  automation: { id: string; name: string };
  now: number;
}

export interface RunResult {
  /** Notes written (the row and pages added), as stored. */
  saved: Note[];
  error: string | null;
}

/** People an action's targets name, on a row (or on the database for scheduled runs). */
export function notifyTargets(to: readonly string[], row: Note | null, db: Note, ctx: Pick<RunContext, "actorId"> & { ws?: string }): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && USER_RE.test(v) && !v.startsWith("automation")) out.add(v);
  };
  for (const t of to) {
    if (t === "creator") add((row ?? db).createdBy);
    else if (t === "editor") add(row?.editedBy ?? ctx.actorId);
    else if (t.startsWith("prop:")) {
      const v = row?.props?.[t.slice(5)];
      if (Array.isArray(v)) v.forEach(add);
    } else add(t);
  }
  // Only people who can open what the notification is about.
  const subject = row ?? db;
  return ctx.ws ? [...out].filter((id) => new AccessResolver(ctx.ws as string, id).level(subject.id) !== null) : [...out];
}

/** Column rules of one person on a database. */
function whoOn(ws: string, userId: string, dbId: string): Who {
  const acc = new AccessResolver(ws, userId);
  return { id: userId, groups: acc.groups, full: acc.level(dbId) === "full" };
}

/** Properties of the database any of the people behind a run may not see. */
function hiddenFor(ctx: RunContext, db: Note): Set<string> {
  const out = new Set<string>();
  if (!db.db?.properties.some((p) => p.perms)) return out;
  for (const id of ctx.as) for (const [prop, kind] of deniedColumns(db.db, whoOn(ctx.ws, id, db.id))) if (kind === "view") out.add(prop);
  return out;
}

/** A run's writes: with the access (and column permissions) of the person it acts for. */
function write(ctx: RunContext, note: Note) {
  const userId = ctx.as[0];
  if (!userId) return { saved: [] as string[], rejected: [{ id: note.id, reason: "no author" }] };
  return pushNotes(ctx.ws, [{ id: note.id, note }], { by: ctx.by, quotaLeft: Infinity, access: { userId } });
}

function addPage(act: Extract<AutoAction, { type: "addPage" }>, db: Note, ctx: RunContext): Note | null {
  const target = act.dbId === db.id ? db : load(ctx.ws, act.dbId);
  if (!target || target.kind !== "database" || !target.db || inTrash(ctx.ws, target)) return null;
  const tpl = act.templateId ? load(ctx.ws, act.templateId) : null;
  const template = tpl && tpl.template && tpl.parentId === target.id && tpl.trashedAt === null ? tpl : null;
  const schema = target.db;
  // Unique IDs are numbered afresh (by the devices); the rest of a template is copied.
  const tplProps = Object.fromEntries(Object.entries(template?.props ?? {}).filter(([k]) => schema.properties.find((p) => p.id === k)?.type !== "unique_id"));
  const values = resolveValues(act.values, schema, zonedNow(ctx.now, workspaceTz(ctx.ws)));
  const page = sanitizeNote(
    blankNote({
      kind: "page",
      parentId: target.id,
      title: act.title || template?.title || "",
      icon: template?.icon ?? "",
      cover: template?.cover ?? null,
      content: template ? structuredClone(template.content) : [],
      props: { ...tplProps, ...values },
      order: afterLastRow(ctx.ws, target.id, ctx.now),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
  );
  if (!page) return null;
  const res = write(ctx, page);
  if (!res.saved.includes(page.id)) return null;
  // As stored (column permissions may have kept some values out).
  return load(ctx.ws, page.id) ?? page;
}

/**
 * Runs actions on a row (null for a scheduled run) of `db`. Browser-only
 * steps (open, confirm) are skipped here. The row is written once at the end.
 */
export function runActions(db: Note, row: Note | null, actions: readonly AutoAction[], ctx: RunContext): RunResult {
  const schema = db.db;
  const saved: Note[] = [];
  let error: string | null = null;
  let cur = row ? (structuredClone(row) as Note) : null;
  let changed = false;
  for (const act of actions) {
    if (act.type === "set") {
      const prop = schema?.properties.find((p) => p.id === act.prop);
      if (!cur || !prop || prop.type === "relation" || COMPUTED_TYPES.includes(prop.type) || NO_VALUE_TYPES.includes(prop.type)) continue;
      const v = resolveValues({ [prop.id]: act.value }, schema, zonedNow(ctx.now, workspaceTz(ctx.ws)))[prop.id] ?? null;
      if (prop.type === "title") cur = { ...cur, title: typeof v === "string" ? v : "" };
      else cur = { ...cur, props: { ...(cur.props ?? {}), [prop.id]: v } };
      changed = true;
    } else if (act.type === "addPage") {
      const page = addPage(act, db, ctx);
      if (page) saved.push(page);
      else error = "add page: the database is gone or full";
    } else if (act.type === "notify") {
      const subject = cur ?? db;
      const text = (act.text || ctx.automation.name || displayTitle(subject, "")).slice(0, 280);
      for (const userId of notifyTargets(act.to, cur, db, ctx)) notify(userId, { ws: ctx.ws, kind: "automation", ref: `note:${subject.id}`, by: ctx.actorId, text });
    } else if (act.type === "webhook") {
      if (!queueWebhook({ url: act.url, body: webhookBody(ctx.ws, db, cur, ctx.automation, ctx.now, hiddenFor(ctx, db)), ws: ctx.ws, dbId: db.id, automationId: ctx.automation.id })) error = "webhook: too many waiting";
    }
  }
  if (cur && changed) {
    cur = { ...cur, updatedAt: ctx.now };
    const res = write(ctx, cur);
    if (res.saved.includes(cur.id)) saved.unshift(load(ctx.ws, cur.id) ?? cur);
    else error = `set: ${res.rejected[0]?.reason ?? "not saved"}`;
  }
  return { saved, error };
}

function runAutomation(
  db: Note,
  row: Note | null,
  a: Automation,
  opts: { ws: string; actorId: string | null; budget: { left: number }; now: number; as?: string[]; verdict?: RanInfo["verdict"] }
): RunResult {
  const author = authorOf(opts.ws, db, a.by);
  const as = opts.as ?? (author ? [author] : []);
  const ctx: RunContext = { ws: opts.ws, by: `automation:${a.id}`, actorId: opts.actorId, as, automation: { id: a.id, name: a.name }, now: opts.now };
  let res: RunResult = { saved: [], error: null };
  if (!take(opts.ws, Math.max(1, a.actions.length), opts.budget, opts.now)) res.error = "too many runs, try later";
  else {
    try {
      res = runActions(db, row, a.actions, ctx);
    } catch (e) {
      res = { saved: [], error: e instanceof Error ? e.message.slice(0, 200) : "failed" };
    }
  }
  logRun(opts.ws, db.id, a.id, res.error, opts.now);
  try {
    hooksNow()?.ran({ ws: opts.ws, db, before: row, automation: a, result: res, as: as[0] ?? null, ...(opts.verdict ? { verdict: opts.verdict } : {}) });
  } catch {
    // The journal never stops a run.
  }
  return res;
}

/**
 * Runs one automation on a row now, after the condition's (or a person's) yes: the
 * database, the row and the automation as they are at this moment — gone,
 * off or changed since, nothing runs. `as`: whose access (default: its author).
 */
export function runAutomationNow(
  ws: string,
  ref: { db: string; row: string; automation: string; onlyIf?: string },
  opts: { actorId: string | null; as?: string[]; verdict?: RanInfo["verdict"] },
  now = Date.now()
): RunResult | null {
  const db = load(ws, ref.db);
  const row = load(ws, ref.row);
  const a = db?.db?.automations?.find((x) => x.id === ref.automation);
  if (!db?.db || !row || !a || !a.on || row.parentId !== db.id || row.template || inTrash(ws, row)) return null;
  // Asked about one question: an automation edited since asks again.
  if (ref.onlyIf !== undefined && JSON.stringify(a.onlyIf ?? null) !== ref.onlyIf) return null;
  return runAutomation(db, row, a, { ws, actorId: opts.actorId, budget: { left: MAX_PER_PUSH }, now, ...(opts.as ? { as: opts.as } : {}), ...(opts.verdict ? { verdict: opts.verdict } : {}) });
}

/** Who an automation acts for (its author; see authorOf). */
export function automationAuthor(ws: string, db: Note, a: Automation): string | null {
  return authorOf(ws, db, a.by);
}

// --- Write triggers (after-push reaction) ----------------------------------------

/**
 * Who an automation or button acts for: its author; one set up before
 * authors were recorded, the database's creator, else the workspace's owner.
 */
function authorOf(ws: string, db: Note, by: string | undefined): string | null {
  if (by && USER_RE.test(by)) return by;
  if (db.createdBy && USER_RE.test(db.createdBy)) return db.createdBy;
  const r = sql("SELECT owner_id FROM workspaces WHERE id = ?").get(ws) as { owner_id: string } | undefined;
  return r?.owner_id ?? null;
}

const actorOf = (by: string): string | null => (USER_RE.test(by) ? by : null);

function onPush(changes: readonly NoteChange[], ctx: PushContext): void {
  // Writes of automations themselves set nothing else off.
  if (ctx.by.startsWith("automation:")) return;
  const now = Date.now();
  const batch = new Map<string, Note>();
  for (const c of changes) if (c.after) batch.set(c.id, c.after);
  // A database saved or deleted: its schedules follow its automations.
  for (const c of changes) {
    if (c.after?.kind === "database" || (!c.after && c.before?.kind === "database")) indexSchedules(ctx.ws, c.id, c.after, now);
  }
  const dbs = new Map<string, Note | null>();
  const dbOf = (id: string): Note | null => {
    if (!dbs.has(id)) {
      const n = batch.get(id) ?? load(ctx.ws, id);
      dbs.set(id, n?.kind === "database" && n.db?.automations?.length && !inTrash(ctx.ws, n) ? n : null);
    }
    return dbs.get(id) ?? null;
  };
  const budget = { left: MAX_PER_PUSH };
  // Rows written by an earlier automation of this same push (several may fire on one row).
  const latest = new Map<string, Note>();
  for (const c of changes) {
    const row = c.after;
    if (!row || row.kind !== "page" || !row.parentId || row.template) continue;
    const db = dbOf(row.parentId);
    if (!db?.db) continue;
    // A page moved into the database counts as added there.
    const before = c.before && c.before.parentId === row.parentId ? c.before : undefined;
    // A page that reaches the server long after it was made (a guest's pages
    // adopted by the account, an old offline copy) was not "added" just now.
    const stale = !before && row.createdAt < now - DAY;
    for (const a of db.db.automations ?? []) {
      if (a.trigger.type === "added" && stale) continue;
      if (!fires(a, before, row, db.db)) continue;
      if (a.onlyIf) {
        // The hub judges it off the write's path; without the hub it does not run.
        const hooks = hooksNow();
        if (hooks) hooks.judge({ ws: ctx.ws, db, row: latest.get(row.id) ?? row, automation: a, actorId: actorOf(ctx.by) });
        else logRun(ctx.ws, db.id, a.id, "the condition cannot be checked here", now);
        continue;
      }
      const res = runAutomation(db, latest.get(row.id) ?? row, a, { ws: ctx.ws, actorId: actorOf(ctx.by), budget, now });
      const again = res.saved.find((n) => n.id === row.id);
      if (again) latest.set(row.id, again);
    }
  }
}

onAfterPush("automations", onPush);

// --- Buttons ---------------------------------------------------------------------

export type ButtonResult = { ok: true; saved: Note[] } | { ok: false; status: number; error: string };

/** A click on a Button property of a row: its server-side actions, as the person who clicked. */
export function pressButton(ws: string, dbId: string, rowId: string, propId: string, actor: { id: string }, now = Date.now()): ButtonResult {
  const db = load(ws, dbId);
  const row = load(ws, rowId);
  if (!db || db.kind !== "database" || !db.db || !row || row.parentId !== db.id || inTrash(ws, row)) return { ok: false, status: 404, error: "not found" };
  const prop = db.db.properties.find((p) => p.id === propId && p.type === "button");
  if (!prop?.button) return { ok: false, status: 404, error: "no such button" };
  const actions = prop.button.actions.filter((a) => a.type !== "openUrl" && a.type !== "openPage" && a.type !== "confirm");
  if (!take(ws, Math.max(1, actions.length), { left: MAX_PER_PUSH }, now)) return { ok: false, status: 429, error: "too many runs" };
  // The clicker is who changed things: their edits set off the database's automations as usual.
  // Writes with the clicker's access; webhooks and notifications show neither more than the clicker nor the button's author may see.
  const author = authorOf(ws, db, prop.button.by);
  const as = author && author !== actor.id ? [actor.id, author] : [actor.id];
  const res = runActions(db, row, actions, { ws, by: actor.id, actorId: actor.id, as, automation: { id: `button-${prop.id}`, name: prop.name }, now });
  if (res.error) return { ok: false, status: 500, error: res.error };
  return { ok: true, saved: res.saved };
}

// --- Schedules -------------------------------------------------------------------

/** Keeps note_schedules in step with a database's scheduled automations. */
export function indexSchedules(ws: string, dbId: string, db: Note | null, now = Date.now()): void {
  ensureTables();
  const want = new Map<string, ScheduleTrigger>();
  for (const a of db?.db?.automations ?? []) if (a.on && a.trigger.type === "schedule") want.set(a.id, a.trigger);
  const have = new Map((sql("SELECT automation_id, spec FROM note_schedules WHERE ws = ? AND db_id = ?").all(ws, dbId) as { automation_id: string; spec: string }[]).map((r) => [r.automation_id, r.spec]));
  for (const id of have.keys()) if (!want.has(id)) sql("DELETE FROM note_schedules WHERE ws = ? AND db_id = ? AND automation_id = ?").run(ws, dbId, id);
  const tz = want.size ? workspaceTz(ws) : DEFAULT_TZ;
  for (const [id, trigger] of want) {
    const spec = JSON.stringify(trigger);
    // An unchanged schedule keeps its next time (a re-save must not skip or repeat a run).
    if (have.get(id) === spec) continue;
    sql("INSERT INTO note_schedules (ws, db_id, automation_id, spec, next_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ws, db_id, automation_id) DO UPDATE SET spec = excluded.spec, next_at = excluded.next_at").run(
      ws,
      dbId,
      id,
      spec,
      nextRun(trigger, tz, now)
    );
  }
}

/** Builds the schedule index from the stored databases once (databases saved later keep it current). */
function indexAllOnce(now: number): void {
  if (sql("SELECT 1 FROM kv WHERE k = 'notes-schedules-indexed'").get()) return;
  for (const r of sql("SELECT ws, id, json FROM notes WHERE deleted = 0 AND json LIKE '%\"schedule\"%'").all() as { ws: string; id: string; json: string | null }[]) {
    try {
      const n = sanitizeNote(JSON.parse(r.json ?? "null"));
      if (n?.kind === "database") indexSchedules(r.ws, r.id, n, now);
    } catch {
      // Skip a broken row.
    }
  }
  sql("INSERT INTO kv (k, v) VALUES ('notes-schedules-indexed', '1') ON CONFLICT(k) DO NOTHING").run();
}

/** Runs the scheduled automations that are due; returns how many ran. */
export function runDueSchedules(now = Date.now()): number {
  ensureTables();
  indexAllOnce(now);
  let ran = 0;
  const due = sql("SELECT ws, db_id, automation_id, spec, next_at FROM note_schedules WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 200").all(now) as {
    ws: string;
    db_id: string;
    automation_id: string;
    spec: string;
    next_at: number;
  }[];
  for (const r of due) {
    const trigger = JSON.parse(r.spec) as ScheduleTrigger;
    // Claim the occurrence first: one run per occurrence, however the ticks overlap.
    const claimed = Number(
      sql("UPDATE note_schedules SET next_at = ? WHERE ws = ? AND db_id = ? AND automation_id = ? AND next_at = ?").run(nextRun(trigger, workspaceTz(r.ws), now), r.ws, r.db_id, r.automation_id, r.next_at).changes
    );
    if (claimed !== 1 || now - Number(r.next_at) > LATE_LIMIT) continue;
    const db = load(r.ws, r.db_id);
    const a = db?.db?.automations?.find((x) => x.id === r.automation_id);
    if (!db || !a || !a.on || a.trigger.type !== "schedule" || inTrash(r.ws, db)) continue;
    runAutomation(db, null, a, { ws: r.ws, actorId: null, budget: { left: MAX_PER_PUSH }, now });
    ran++;
  }
  return ran;
}

let ticking = false;

/** Starts the ticker (once per process; ZVENA_MAINTENANCE=off keeps it off, as in tests). */
export function startNotesScheduler(): void {
  if (ticking || process.env.ZVENA_MAINTENANCE === "off") return;
  ticking = true;
  const tick = () => {
    try {
      const n = runDueSchedules();
      if (n) console.log(`[automations] scheduled runs=${n}`);
    } catch (e) {
      console.error(`[automations] scheduler failed (${e instanceof Error ? e.name : "error"})`);
    }
  };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, 30_000).unref();
}
