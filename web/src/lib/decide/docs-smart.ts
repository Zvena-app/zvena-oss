// Documents' database automations in the automations hub. Server-only.
//
// Two things join Notion-style automations ("when a page is added / a
// property changes → set, add a page, notify, webhook") to the hub:
//
//   journal   every run (on a write, by the clock, after a yes) is a line of
//             the journal (journal.ts): Home shows it with the rest, and
//             Undo puts back what it set (options, numbers, dates,
//             checkboxes, people) and takes away the pages it added, while
//             nobody changed them since;
//   judge     "Run only if …": the automation asks the decision model a
//             yes/no question about the page, sending only the properties
//             it names (never one that names a person, never a column its
//             author may not see). Sure (≥ 85 %): it runs. Less sure
//             (≥ 60 %), or set to always ask: it waits as a suggestion for
//             a person's yes, and its author hears of it in the Inbox.
//             Unsure, smart suggestions off or the model down: it does not
//             run, and the automation's last run says why.
//
// The writes are the automation's own (lib/notes/automations-server.ts): its
// author's access, or, after a person's yes, that person's.

import { createHash } from "node:crypto";
import { AccessResolver } from "../notes/access";
import { automationAuthor, noteRun, runAutomationNow, setAutomationHooks, type RanInfo } from "../notes/automations-server";
import { deniedColumns } from "../notes/column-perms";
import { valueText } from "../notes/db";
import { sanitizeNote } from "../notes/model";
import { pushNotes } from "../notes/server-store";
import type { Automation } from "../notes/automations";
import type { DbProperty, Note } from "../notes/types";
import { notify } from "../eco/inbox";
import { sql } from "../store";
import { NOT_SENT_TYPES, personalColumns } from "./adapters";
import { ensureSchema, settingsOf } from "./engine";
import { ask, noul, smartAvailable } from "./smart";
import { recordHub, registerHubKind, type HubPayload, type Settle } from "./journal";

/** Sure enough to run by itself / to ask a person. */
export const AUTO = 0.85;
export const SUGGEST = 0.6;
/** Questions per workspace per hour, and journal lines per workspace per minute. */
const ASKS_PER_HOUR = 200;
const LINES_PER_MINUTE = 60;
/** Columns never sent, whatever the automation lists (files, buttons, formulas, rollups, relations: adapters.ts). */
const NOT_SENT = NOT_SENT_TYPES;
/** Values Undo can put back: ids, numbers, dates, booleans — never text. */
const UNDOABLE = new Set<DbProperty["type"]>(["select", "status", "multi_select", "checkbox", "number", "date", "person"]);

interface State {
  started: boolean;
  asks: Map<string, { at: number; n: number }>;
  lines: Map<string, { at: number; n: number }>;
  /** Rows being judged now (one question per row and automation at a time). */
  judging: Set<string>;
}
const KEY = Symbol.for("zvena.decide.docs-smart");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const st: State = (g[KEY] ??= { started: false, asks: new Map(), lines: new Map(), judging: new Set() });

function within(map: Map<string, { at: number; n: number }>, ws: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const cur = map.get(ws);
  const w = cur && now - cur.at < windowMs ? cur : { at: now, n: 0 };
  if (w.n >= max) return false;
  w.n++;
  map.set(ws, w);
  if (map.size > 5000) map.clear();
  return true;
}

function load(ws: string, id: string): Note | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  try {
    return r?.json ? sanitizeNote(JSON.parse(r.json)) : null;
  } catch {
    return null;
  }
}

/** What the model is told about a row: the named properties as a person reads them, minus people and columns hidden from `author`. */
export function factsFor(ws: string, db: Note, row: Note, fields: readonly string[], author: string | null): Record<string, string> {
  const props = db.db?.properties ?? [];
  const hidden = author ? deniedColumns(db.db, { id: author, ...groupsOf(ws, author, db.id) }) : new Map<string, string>();
  const personal = new Set(personalColumns(props));
  const out: Record<string, string> = {};
  for (const id of fields) {
    const p = props.find((x) => x.id === id);
    if (!p || personal.has(p.name) || hidden.get(p.id) === "view" || NOT_SENT.has(p.type)) continue;
    const text = p.type === "title" ? row.title : valueText(p, row.props?.[p.id] ?? null, "en");
    out[p.name || p.id] = String(text ?? "").slice(0, 2000);
  }
  return out;
}

function groupsOf(ws: string, userId: string, dbId: string): { groups: ReadonlySet<string>; full: boolean } {
  const acc = new AccessResolver(ws, userId);
  return { groups: acc.groups, full: acc.level(dbId) === "full" };
}

const subjectOf = (row: string | null, db: string) => `note:${row ?? db}`;

/** What the model judged, as a short hash: a yes given later holds only while the page still says the same. */
export const factsHash = (state: Record<string, string>): string => createHash("sha256").update(JSON.stringify(state)).digest("base64url").slice(0, 22);

/** A waiting yes for this automation on this row, if any. */
function waiting(ws: string, row: string, automation: string): boolean {
  return Boolean(
    sql("SELECT 1 FROM dz_decisions WHERE ws = ? AND row_id = ? AND status = 'pending' AND json_valid(actions) AND json_extract(actions, '$.kind') = 'automation' AND json_extract(actions, '$.automation') = ?").get(ws, row, automation)
  );
}

/** Judges one fired "run only if …" automation (exported for tests; awaited there). */
export async function judgeAutomation(job: { ws: string; db: Note; row: Note; automation: Automation; actorId: string | null }): Promise<"ran" | "waiting" | "no" | "off" | "skip"> {
  const { ws, db, row, automation: a } = job;
  if (!a.onlyIf) return "skip";
  const k = `${ws}|${row.id}|${a.id}`;
  if (st.judging.has(k) || waiting(ws, row.id, a.id)) return "skip";
  if (!settingsOf(ws).smart || !smartAvailable()) {
    noteRun(ws, db.id, a.id, "smart suggestions and automations are off");
    return "off";
  }
  if (!within(st.asks, ws, ASKS_PER_HOUR, 3600_000)) {
    noteRun(ws, db.id, a.id, "too many checks this hour");
    return "off";
  }
  const author = automationAuthor(ws, db, a);
  // A page its author cannot open is no subject of theirs: nothing about it goes anywhere.
  if (!author || new AccessResolver(ws, author).level(row.id) === null) {
    noteRun(ws, db.id, a.id, "its author cannot open this page");
    return "skip";
  }
  const state = factsFor(ws, db, row, a.onlyIf.fields, author);
  if (!Object.keys(state).length) {
    noteRun(ws, db.id, a.id, "no property the condition may read");
    return "no";
  }
  st.judging.add(k);
  try {
    const out = await ask(ws, state, { yes: noul(a.onlyIf.question) }, { timeoutMs: 4000 });
    if (!out) {
      noteRun(ws, db.id, a.id, "the condition could not be checked in time");
      return "off";
    }
    const p = out.answers.yes.noul;
    const verdict = { confidence: p, model: out.model, ms: out.ms };
    if (p >= AUTO && !a.onlyIf.confirm) {
      const res = runAutomationNow(ws, { db: db.id, row: row.id, automation: a.id, onlyIf: JSON.stringify(a.onlyIf) }, { actorId: job.actorId, verdict });
      return res ? "ran" : "skip";
    }
    if (p >= SUGGEST) {
      ensureSchema();
      recordHub(ws, {
        subject: subjectOf(row.id, db.id),
        source: "model",
        mode: "suggest",
        status: "pending",
        payload: { kind: "automation", db: db.id, row: row.id, automation: a.id, onlyIf: JSON.stringify(a.onlyIf), facts: factsHash(state) },
        confidence: p,
        model: out.model,
        ms: out.ms,
        by: author ?? "",
      });
      noteRun(ws, db.id, a.id, null);
      if (author) notify(author, { ws, kind: "proposal", ref: `note:${row.id}`, by: null, text: `${a.name || "⚡"}: ${row.title || ""}`.slice(0, 280) });
      return "waiting";
    }
    noteRun(ws, db.id, a.id, `condition not met (${Math.round(p * 100)}%)`);
    return "no";
  } finally {
    st.judging.delete(k);
  }
}

/** The values a run set that Undo can put back, before and after. */
function changes(db: Note, before: Note | null, after: Note | null): { prev: Record<string, unknown>; next: Record<string, unknown> } | null {
  if (!before || !after) return null;
  const prev: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const p of db.db?.properties ?? []) {
    if (!UNDOABLE.has(p.type)) continue;
    const a = before.props?.[p.id] ?? null;
    const b = after.props?.[p.id] ?? null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    prev[p.id] = a;
    next[p.id] = b;
  }
  return Object.keys(next).length ? { prev, next } : null;
}

/** A run lands in the journal. */
export function journalRun(info: RanInfo): string | null {
  const { ws, db, before, automation: a, result } = info;
  if (result.error && !result.saved.length) return null;
  const after = before ? (result.saved.find((n) => n.id === before.id) ?? null) : null;
  const ch = changes(db, before, after);
  const added = result.saved.filter((n) => n.id !== before?.id).map((n) => n.id);
  const payload: HubPayload = {
    kind: "automation",
    db: db.id,
    row: before?.id ?? null,
    automation: a.id,
    ...(a.onlyIf ? { onlyIf: JSON.stringify(a.onlyIf) } : {}),
    ...(ch ? ch : {}),
    ...(added.length ? { added } : {}),
  };
  ensureSchema();
  // A person's yes: the proposal itself becomes what was done.
  if (info.verdict?.accepted) {
    sql("UPDATE dz_decisions SET actions = ? WHERE id = ? AND ws = ?").run(JSON.stringify(payload), info.verdict.accepted, ws);
    return info.verdict.accepted;
  }
  if (!within(st.lines, ws, LINES_PER_MINUTE, 60_000)) return null;
  return recordHub(ws, {
    subject: subjectOf(before?.id ?? null, db.id),
    source: info.verdict ? "model" : "rule",
    mode: "auto",
    status: "applied",
    payload,
    ...(info.verdict ? { confidence: info.verdict.confidence, model: info.verdict.model, ms: info.verdict.ms } : {}),
    by: info.as ?? "",
  });
}

function canEdit(ws: string, userId: string, id: string): boolean {
  const l = new AccessResolver(ws, userId).level(id);
  return l === "full" || l === "edit";
}

/** A person says yes to a waiting automation: it runs now, with their access (and never more than its author's in what it sends). */
function accept(ws: string, id: string, p: HubPayload, by: string): Settle {
  if (p.kind !== "automation" || !p.row) return "gone";
  if (!canEdit(ws, by, p.row)) return "forbidden";
  const db = load(ws, p.db);
  const a = db?.db?.automations?.find((x) => x.id === p.automation);
  const row = load(ws, p.row);
  if (!db || !a?.onlyIf || !row) return "gone";
  const author = automationAuthor(ws, db, a);
  // Nobody vouches for it any more (its author left or lost the page): it cannot run.
  if (!author || new AccessResolver(ws, author).level(p.row) === null) return "forbidden";
  // The model judged the page as it was: changed since, the question is stale.
  if (p.facts && factsHash(factsFor(ws, db, row, a.onlyIf.fields, author)) !== p.facts) return "gone";
  const conf = (sql("SELECT confidence FROM dz_decisions WHERE id = ?").get(id) as { confidence: number | null } | undefined)?.confidence ?? 0;
  // The writes are the automation's, with its author's access, as any run of it; the person who
  // says yes must be able to edit the page too, and what goes out shows neither more than either may see.
  const as = author === by ? [by] : [author, by];
  const res = runAutomationNow(ws, { db: p.db, row: p.row, automation: p.automation, ...(p.onlyIf !== undefined ? { onlyIf: p.onlyIf } : {}) }, { actorId: by, as, verdict: { confidence: conf, accepted: id } });
  if (!res) return "gone";
  sql("UPDATE dz_decisions SET status = 'accepted', resolved_by = ?, resolved_at = ? WHERE id = ?").run(by, Date.now(), id);
  return res.error ? "unchanged" : "applied";
}

/** Undo: the values it set go back, the pages it added go to the trash — only what nobody changed since. */
function undo(ws: string, p: HubPayload, by: string): Settle {
  if (p.kind !== "automation") return "gone";
  let did = false;
  const now = Date.now();
  if (p.row && p.prev && p.next) {
    if (!canEdit(ws, by, p.row)) return "forbidden";
    const row = load(ws, p.row);
    if (!row) return "gone";
    const props = { ...(row.props ?? {}) };
    for (const [k, v] of Object.entries(p.next)) {
      if (JSON.stringify(props[k] ?? null) !== JSON.stringify(v ?? null)) continue;
      props[k] = (p.prev[k] ?? null) as never;
      did = true;
    }
    if (did) {
      const res = pushNotes(ws, [{ id: row.id, note: { ...row, props, updatedAt: now } }], { by, quotaLeft: Infinity, access: { userId: by } });
      if (!res.saved.includes(row.id)) return "forbidden";
    }
  }
  for (const id of p.added ?? []) {
    const n = load(ws, id);
    if (!n || n.trashedAt !== null || n.updatedAt - n.createdAt > 5000 || !canEdit(ws, by, id)) continue;
    const res = pushNotes(ws, [{ id, note: { ...n, trashedAt: now, updatedAt: now } }], { by, quotaLeft: Infinity, access: { userId: by } });
    if (res.saved.includes(id)) did = true;
  }
  return "undone";
}

/** Joins database automations to the hub (once per process; hub.ts). */
export function startDocsSmart(): void {
  if (st.started) return;
  st.started = true;
  setAutomationHooks({
    judge(job) {
      void judgeAutomation(job).catch(() => {});
    },
    ran(info) {
      journalRun(info);
    },
  });
  registerHubKind("automation", { accept, undo });
}
