// zvena Documents: database automations (Notion). "When a page is added",
// "when a property changes (to a value)" or on a schedule, do: set
// properties of that page, add a page to a database, notify people, send a
// webhook. Pure logic; the server runs it (automations-server.ts) for every
// write of a signed-in workspace, and the browser only for a guest's
// local-only workspace (components/notes/automations-run.ts).

import { LEGACY_ONLY_IF_FIELD } from "../legacy-names";
import { localYmd } from "./dates";
import type { DbSchema, Note, PropValue } from "./types";

export type AutoTrigger =
  | { type: "added" }
  | { type: "edited"; prop: string; /** Option id, "checked" / "unchecked"; none = any change. */ value?: string }
  /**
   * Every day / week (weekdays 0–6, Sunday 0) / month (monthday 1–31) / year (month 1–12 + monthday)
   * at a local time "HH:MM" of the workspace's zone, every `interval` periods counted from `from`
   * ("YYYY-MM-DD"; Notion's recurring trigger and repeating templates). `weekday` is the older single day.
   */
  | {
      type: "schedule";
      every: "day" | "week" | "month" | "year";
      at: string;
      weekday?: number;
      weekdays?: number[];
      monthday?: number;
      month?: number;
      interval?: number;
      from?: string;
    };

/** Who a notification goes to: a user id, the people of a Person property ("prop:<id>"), or the page's creator / last editor. */
export type NotifyTarget = string;

export type AutoAction =
  | { type: "set"; prop: string; /** A value, or a relative date ("@today", "@tomorrow", "@week"). */ value: PropValue }
  /** `templateId`: a template of that database the new page copies (content, icon, cover, values). */
  | { type: "addPage"; dbId: string; title: string; values?: Record<string, PropValue>; templateId?: string }
  | { type: "notify"; to: NotifyTarget[]; text: string }
  /** POSTs the page (title, properties, link) to an https URL, from the server. */
  | { type: "webhook"; url: string }
  // Button properties only (they run in the browser of whoever clicks):
  | { type: "openUrl"; url: string }
  | { type: "openPage"; noteId: string }
  | { type: "confirm"; text: string };

/**
 * "Run only if …" (signed-in workspaces; not on a schedule): a condition in
 * words — a yes/no question about the page for the decision model — and the
 * only properties sent with it (never one that names a person). Sure: it
 * runs; less sure: it waits for a person as a suggestion; unsure, or smart
 * suggestions off: it does not run.
 */
export interface AutoOnlyIf {
  question: string;
  /** Property ids sent with the question. */
  fields: string[];
  /** Always wait for a person, however sure the answer is. */
  confirm?: boolean;
}

export interface Automation {
  id: string;
  name: string;
  on: boolean;
  trigger: AutoTrigger;
  /** Run only if … (lib/decide/docs-smart.ts). */
  onlyIf?: AutoOnlyIf;
  actions: AutoAction[];
  /** Who set it up (the server's word): its runs write with their access, never more. */
  by?: string;
}

export const MAX_AUTOMATIONS = 20;

const RELATIVE_DAYS: Record<string, number> = { "@today": 0, "@tomorrow": 1, "@week": 7 };

/** Preset values with relative dates resolved to the day it runs. */
export function resolveValues(values: Record<string, PropValue> | undefined, schema: DbSchema | undefined, now = new Date()): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  if (!values || !schema) return out;
  for (const [id, v] of Object.entries(values)) {
    const prop = schema.properties.find((p) => p.id === id);
    if (!prop || v === undefined || v === "") continue;
    if (prop.type === "date" && typeof v === "string" && v in RELATIVE_DAYS) {
      out[id] = { start: localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + RELATIVE_DAYS[v])) };
    } else out[id] = v;
  }
  return out;
}

const same = (a: PropValue | undefined, b: PropValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether a local write of `next` (with `prev` before it) fires the automation. */
export function fires(a: Automation, prev: Note | undefined, next: Note, schema: DbSchema): boolean {
  if (!a.on || next.template || next.trashedAt !== null) return false;
  if (a.trigger.type === "added") return !prev;
  // Scheduled automations run by the clock (on the server), not on writes.
  if (a.trigger.type === "schedule" || !prev) return false;
  const { prop, value } = a.trigger;
  const p = schema.properties.find((x) => x.id === prop);
  if (!p) return false;
  const before = p.type === "title" ? prev.title : prev.props?.[prop];
  const after = p.type === "title" ? next.title : next.props?.[prop];
  if (same(before, after)) return false;
  if (value === undefined || value === "") return true;
  if (p.type === "checkbox") return value === "checked" ? after === true : after !== true;
  if (p.type === "multi_select") return Array.isArray(after) && after.includes(value) && !(Array.isArray(before) && before.includes(value));
  return after === value;
}

function cleanValue(v: unknown): PropValue | undefined {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return v.slice(0, 2000);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").slice(0, 100);
  if (typeof v === "object" && typeof (v as { start?: unknown }).start === "string") return { start: String((v as { start: string }).start).slice(0, 40) };
  return undefined;
}

function cleanValues(v: unknown): Record<string, PropValue> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, PropValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
    const c = cleanValue(x);
    if (c !== undefined) out[k.slice(0, 40)] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

const NOTIFY_TARGET_RE = /^(creator|editor|prop:[\w-]{1,40}|[A-Za-z0-9_-]{6,64})$/;

/** Actions as stored on an automation or a Button property (sync input is untrusted). */
export function cleanActions(v: unknown, max = 10): AutoAction[] {
  const actions: AutoAction[] = [];
  for (const x of Array.isArray(v) ? v.slice(0, max) : []) {
    const a = x as Record<string, unknown>;
    if (a?.type === "set" && typeof a.prop === "string") {
      const value = cleanValue(a.value);
      if (value !== undefined) actions.push({ type: "set", prop: a.prop.slice(0, 40), value });
    } else if (a?.type === "addPage" && typeof a.dbId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(a.dbId)) {
      const values = cleanValues(a.values);
      const templateId = typeof a.templateId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(a.templateId) ? a.templateId : undefined;
      actions.push({ type: "addPage", dbId: a.dbId, title: typeof a.title === "string" ? a.title.slice(0, 2000) : "", ...(values ? { values } : {}), ...(templateId ? { templateId } : {}) });
    } else if (a?.type === "notify" && Array.isArray(a.to)) {
      const to = [...new Set(a.to.filter((t): t is string => typeof t === "string" && NOTIFY_TARGET_RE.test(t)))].slice(0, 20);
      if (to.length) actions.push({ type: "notify", to, text: typeof a.text === "string" ? a.text.slice(0, 280) : "" });
    } else if (a?.type === "webhook" && typeof a.url === "string" && /^https:\/\/[^\s]{1,2000}$/i.test(a.url)) {
      actions.push({ type: "webhook", url: a.url });
    } else if (a?.type === "openUrl" && typeof a.url === "string" && /^(https?:|mailto:)/i.test(a.url)) {
      actions.push({ type: "openUrl", url: a.url.slice(0, 2000) });
    } else if (a?.type === "openPage" && typeof a.noteId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(a.noteId)) {
      actions.push({ type: "openPage", noteId: a.noteId });
    } else if (a?.type === "confirm" && typeof a.text === "string") {
      actions.push({ type: "confirm", text: a.text.slice(0, 300) });
    }
  }
  return actions;
}

const int = (v: unknown, lo: number, hi: number): number | undefined => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : undefined);

/** A schedule trigger from untrusted JSON (null: not a valid one). */
export function cleanSchedule(t: Record<string, unknown>): Extract<AutoTrigger, { type: "schedule" }> | null {
  if (t.every !== "day" && t.every !== "week" && t.every !== "month" && t.every !== "year") return null;
  if (typeof t.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.at)) return null;
  const weekdays = Array.isArray(t.weekdays) ? [...new Set(t.weekdays.map((x) => int(x, 0, 6)).filter((x): x is number => x !== undefined))].sort() : [];
  const weekday = int(t.weekday, 0, 6);
  const monthday = int(t.monthday, 1, 31);
  const month = int(t.month, 1, 12);
  const interval = int(t.interval, 1, 99);
  return {
    type: "schedule",
    every: t.every,
    at: t.at,
    ...(t.every === "week" && weekdays.length ? { weekdays } : t.every === "week" && weekday !== undefined ? { weekdays: [weekday] } : {}),
    ...((t.every === "month" || t.every === "year") && monthday ? { monthday } : {}),
    ...(t.every === "year" && month ? { month } : {}),
    ...(interval && interval > 1 ? { interval } : {}),
    ...(typeof t.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.from) ? { from: t.from } : {}),
  };
}

/** A "run only if" condition from untrusted JSON (undefined: none). */
export function cleanOnlyIf(v: unknown): AutoOnlyIf | undefined {
  const j = v as Record<string, unknown> | null;
  if (!j || typeof j !== "object" || typeof j.question !== "string" || !j.question.trim()) return undefined;
  const fields = [...new Set((Array.isArray(j.fields) ? j.fields : []).filter((f): f is string => typeof f === "string" && /^[\w-]{1,40}$/.test(f)))].slice(0, 12);
  if (!fields.length) return undefined;
  return { question: j.question.replace(/\s+/g, " ").trim().slice(0, 500), fields, ...(j.confirm === true ? { confirm: true } : {}) };
}

/** Automations as stored on a database (sync input is untrusted). */
export function cleanAutomations(v: unknown): Automation[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Automation[] = [];
  for (const raw of v.slice(0, MAX_AUTOMATIONS)) {
    const r = raw as Record<string, unknown>;
    if (!r || typeof r !== "object" || typeof r.id !== "string") continue;
    const t = r.trigger as Record<string, unknown> | undefined;
    let trigger: AutoTrigger | null = null;
    if (t?.type === "added") trigger = { type: "added" };
    else if (t?.type === "edited" && typeof t.prop === "string") trigger = { type: "edited", prop: t.prop.slice(0, 40), ...(typeof t.value === "string" && t.value ? { value: t.value.slice(0, 40) } : {}) };
    else if (t?.type === "schedule") trigger = cleanSchedule(t);
    if (!trigger) continue;
    // Browser-only steps (open, confirm) belong to buttons, not to automations.
    const actions = cleanActions(r.actions).filter((a) => a.type !== "openUrl" && a.type !== "openPage" && a.type !== "confirm");
    const by = typeof r.by === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(r.by) ? r.by : undefined;
    // A schedule has no page to ask about.
    // Databases saved by earlier releases keep the condition under its legacy key (lib/legacy-names.ts).
    const onlyIf = trigger.type === "schedule" ? undefined : cleanOnlyIf(r.onlyIf ?? r[LEGACY_ONLY_IF_FIELD]);
    out.push({ id: r.id.slice(0, 40), name: typeof r.name === "string" ? r.name.slice(0, 200) : "", on: r.on !== false, trigger, ...(onlyIf ? { onlyIf } : {}), actions, ...(by ? { by } : {}) });
  }
  return out.length ? out : undefined;
}

const sameActions = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A pushed database with the author of every automation and button as the
 * server sees it: unchanged ones keep theirs, the ones a person changed or
 * added are theirs (`by` a user id). A push by anything else (an
 * integration) cannot change what they do: those stay as stored, new ones
 * are dropped. The browser's word on `by` is never taken.
 */
export function stampOwners(stored: Note | null, pushed: Note, by: string): Note {
  if (pushed.kind !== "database" || !pushed.db) return pushed;
  const person = /^[A-Za-z0-9_-]{6,64}$/.test(by);
  const before = new Map((stored?.kind === "database" ? stored.db?.automations : undefined)?.map((a) => [a.id, a]) ?? []);
  let automations: Automation[] | undefined;
  if (pushed.db.automations) {
    automations = [];
    for (const { by: _b, ...a } of pushed.db.automations) {
      void _b;
      const old = before.get(a.id);
      const { by: oldBy, ...was } = old ?? ({} as Partial<Automation>);
      if (old && sameActions({ ...was, on: true, name: "" }, { ...a, on: true, name: "" })) automations.push({ ...a, ...(oldBy ? { by: oldBy } : {}) });
      else if (person) automations.push({ ...a, by });
      else if (old) automations.push(old);
    }
  }
  const props = new Map((stored?.kind === "database" ? stored.db?.properties : undefined)?.map((p) => [p.id, p]) ?? []);
  const properties = pushed.db.properties.map((p) => {
    if (p.type !== "button" || !p.button) return p;
    const { by: _b, ...button } = p.button;
    void _b;
    const old = props.get(p.id)?.button;
    if (old && sameActions(old.actions, button.actions)) return { ...p, button: { ...button, ...(old.by ? { by: old.by } : {}) } };
    if (person) return { ...p, button: { ...button, by } };
    return { ...p, button: old ? { ...button, actions: old.actions, ...(old.by ? { by: old.by } : {}) } : { ...button, actions: [] } };
  });
  const db = { ...pushed.db, properties };
  if (automations?.length) db.automations = automations;
  else delete db.automations;
  return { ...pushed, db };
}
