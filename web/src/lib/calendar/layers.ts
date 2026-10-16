// Server-only: Docs databases and Projects on the calendar (Notion
// Calendar's "add a Notion database").
//
//   docs     a database with a date property: its rows are events; dragging
//            one changes that date through Documents' own write path
//            (pushNotes with the person's access: page levels, column
//            permissions, automations and reminders all apply);
//   issues   due dates of my issues or of one project, read-only, through
//            the ecosystem's issueList (Projects decides what one may see);
//   cycles   the teams' cycles, read-only, through the ecosystem's cycleList.

import { AccessResolver, atLeast } from "../notes/access";
import { displayTitle, noteSlug, sanitizeNote } from "../notes/model";
import { inTrash, pushNotes, readableFor } from "../notes/server-store";
import { isDateValue, type DateValue, type Note } from "../notes/types";
import { cycleList, issueList, projectOptions } from "../eco/lists";
import { payerOf, quotaLeft } from "../storage";
import { sql } from "../store";
import type { Locale } from "@/i18n/locales";
import type { CalAccess } from "./access";
import { calDb } from "./db";
import { CalError } from "./events";
import { CAL_COLORS, COLOR_RE, type LayerInfo, type LayerItem } from "./types";

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
/** Rows read from one database for the calendar. */
const MAX_ROWS = 5000;

function loadNote(ws: string, id: string): Note | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  try {
    return sanitizeNote(JSON.parse(r?.json ?? "null"));
  } catch {
    return null;
  }
}

const docsUrl = (ws: string, n: Pick<Note, "id" | "title">) => `/docs?ws=${encodeURIComponent(ws)}#${noteSlug(n)}`;

/** Databases the person may read that have a date property (what can become a layer). */
export function listDatabases(acc: CalAccess): { id: string; title: string; icon: string; props: { id: string; name: string }[] }[] {
  if (!acc.member) return [];
  const res = new AccessResolver(acc.ws, acc.userId);
  const out: { id: string; title: string; icon: string; props: { id: string; name: string }[] }[] = [];
  const rows = sql("SELECT id, json FROM notes WHERE ws = ? AND deleted = 0 AND json_extract(json, '$.kind') = 'database' LIMIT 1000").all(acc.ws) as { id: string; json: string | null }[];
  for (const r of rows) {
    if (!res.level(r.id)) continue;
    let n: Note | null;
    try {
      n = sanitizeNote(JSON.parse(r.json ?? "null"));
    } catch {
      n = null;
    }
    if (!n?.db || n.template || n.synced || inTrash(acc.ws, n)) continue;
    const visible = readableFor(acc.ws, acc.userId, n);
    const props = (visible.db?.properties ?? []).filter((p) => p.type === "date" && p.denied !== "view").map((p) => ({ id: p.id, name: p.name }));
    if (props.length) out.push({ id: n.id, title: displayTitle(n, ""), icon: typeof n.icon === "string" && !n.icon.startsWith("/") && !n.icon.startsWith("icon:") ? n.icon : "", props });
  }
  return out.slice(0, 200);
}

interface LayerRow {
  kind: "docs" | "issues" | "cycles";
  ref: string;
  prop: string;
  color: string;
  hidden: number;
}

/** The person's layers in this workspace, with names (layers they may no longer read are left out). */
export function listLayers(acc: CalAccess, locale: Locale): LayerInfo[] {
  calDb();
  if (!acc.member) return [];
  const rows = sql("SELECT kind, ref, prop, color, hidden FROM cal_layers WHERE user_id = ? AND ws_id = ? ORDER BY created_at").all(acc.userId, acc.ws) as unknown as LayerRow[];
  const projects = rows.some((r) => r.kind === "issues" && r.ref !== "mine") ? projectOptions({ userId: acc.userId, wsId: acc.ws, locale }) : [];
  const out: LayerInfo[] = [];
  for (const r of rows) {
    if (r.kind === "docs") {
      const db = new AccessResolver(acc.ws, acc.userId).level(r.ref) ? loadNote(acc.ws, r.ref) : null;
      if (!db?.db || inTrash(acc.ws, db)) continue;
      out.push({ kind: "docs", ref: r.ref, prop: r.prop, name: displayTitle(db, ""), color: r.color, hidden: r.hidden === 1, icon: db.icon && !db.icon.startsWith("/") && !db.icon.startsWith("icon:") ? db.icon : undefined });
    } else if (r.kind === "issues") {
      if (r.ref === "mine") out.push({ kind: "issues", ref: "mine", prop: "", name: "", color: r.color, hidden: r.hidden === 1 });
      else {
        const p = projects.find((x) => x.id === r.ref);
        if (p) out.push({ kind: "issues", ref: r.ref, prop: "", name: p.name, color: r.color, hidden: r.hidden === 1, icon: p.icon ?? undefined });
      }
    } else out.push({ kind: "cycles", ref: "all", prop: "", name: "", color: r.color, hidden: r.hidden === 1 });
  }
  return out;
}

export function addLayer(acc: CalAccess, input: { kind?: unknown; ref?: unknown; prop?: unknown; color?: unknown }, now = Date.now()): void {
  calDb();
  if (!acc.member) throw new CalError(403, "forbidden");
  const kind = input.kind;
  const have = Number((sql("SELECT COUNT(*) AS n FROM cal_layers WHERE user_id = ? AND ws_id = ?").get(acc.userId, acc.ws) as { n: number }).n);
  if (have >= 30) throw new CalError(429, "too many layers");
  const color = typeof input.color === "string" && COLOR_RE.test(input.color) ? input.color : CAL_COLORS[(have + 4) % CAL_COLORS.length];
  let ref = "";
  let prop = "";
  if (kind === "docs") {
    const db = listDatabases(acc).find((d) => d.id === input.ref);
    if (!db) throw new CalError(404, "database not found");
    const p = db.props.find((x) => x.id === input.prop) ?? db.props[0];
    ref = db.id;
    prop = p.id;
  } else if (kind === "issues") {
    if (input.ref === "mine") ref = "mine";
    else if (typeof input.ref === "string" && projectOptions({ userId: acc.userId, wsId: acc.ws, locale: "en" }).some((p) => p.id === input.ref)) ref = input.ref;
    else throw new CalError(404, "project not found");
  } else if (kind === "cycles") ref = "all";
  else throw new CalError(400, "bad layer");
  sql("INSERT INTO cal_layers (user_id, ws_id, kind, ref, prop, color, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(user_id, ws_id, kind, ref) DO UPDATE SET prop = excluded.prop, hidden = 0").run(acc.userId, acc.ws, kind, ref, prop, color, now);
}

export function updateLayer(acc: CalAccess, kind: string, ref: string, input: { color?: unknown; hidden?: unknown; prop?: unknown }): void {
  calDb();
  const cur = sql("SELECT kind, ref, prop, color, hidden FROM cal_layers WHERE user_id = ? AND ws_id = ? AND kind = ? AND ref = ?").get(acc.userId, acc.ws, kind, ref) as LayerRow | undefined;
  if (!cur) throw new CalError(404, "layer not found");
  const color = input.color !== undefined ? (typeof input.color === "string" && COLOR_RE.test(input.color) ? input.color : null) : cur.color;
  if (!color) throw new CalError(400, "bad color");
  let prop = cur.prop;
  if (input.prop !== undefined && kind === "docs") {
    const db = listDatabases(acc).find((d) => d.id === ref);
    if (!db?.props.some((p) => p.id === input.prop)) throw new CalError(400, "bad property");
    prop = input.prop as string;
  }
  sql("UPDATE cal_layers SET color = ?, hidden = ?, prop = ? WHERE user_id = ? AND ws_id = ? AND kind = ? AND ref = ?").run(color, input.hidden !== undefined ? (input.hidden === true ? 1 : 0) : cur.hidden, prop, acc.userId, acc.ws, kind, ref);
}

export function removeLayer(acc: CalAccess, kind: string, ref: string): void {
  calDb();
  sql("DELETE FROM cal_layers WHERE user_id = ? AND ws_id = ? AND kind = ? AND ref = ?").run(acc.userId, acc.ws, kind, ref);
}

/** The day range a Docs date covers (end inclusive in Notion; the calendar draws [start, end]). */
function daysOf(v: DateValue): [string, string] {
  const s = v.start.slice(0, 10);
  const e = (v.end ?? v.start).slice(0, 10);
  return [s, e < s ? s : e];
}

/** Layer items in a day range [fromDay, toDay] (the browser places Docs times on its own wall clock). */
export async function layerItems(acc: CalAccess, locale: Locale, fromDay: string, toDay: string): Promise<LayerItem[]> {
  calDb();
  if (!acc.member) return [];
  const layers = (sql("SELECT kind, ref, prop, color, hidden FROM cal_layers WHERE user_id = ? AND ws_id = ? AND hidden = 0").all(acc.userId, acc.ws) as unknown as LayerRow[]).slice(0, 30);
  const out: LayerItem[] = [];
  const v = { userId: acc.userId, wsId: acc.ws, locale };
  for (const l of layers) {
    if (l.kind === "docs") {
      const res = new AccessResolver(acc.ws, acc.userId);
      if (!res.level(l.ref)) continue;
      const db = loadNote(acc.ws, l.ref);
      if (!db?.db || inTrash(acc.ws, db)) continue;
      const shown = readableFor(acc.ws, acc.userId, db);
      const prop = shown.db?.properties.find((p) => p.id === l.prop && p.type === "date");
      if (!prop || prop.denied === "view") continue;
      const rows = sql("SELECT id, json FROM notes WHERE ws = ? AND parent_id = ? AND deleted = 0 LIMIT ?").all(acc.ws, l.ref, MAX_ROWS) as { id: string; json: string | null }[];
      for (const r of rows) {
        let row: Note | null;
        try {
          row = sanitizeNote(JSON.parse(r.json ?? "null"));
        } catch {
          row = null;
        }
        if (!row || row.template || row.trashedAt !== null) continue;
        const level = res.level(row.id);
        if (!level) continue;
        const seen = readableFor(acc.ws, acc.userId, row);
        const val = seen.props?.[prop.id];
        if (!isDateValue(val) || !DATE_RE.test(val.start)) continue;
        const [s, e] = daysOf(val);
        if (s > toDay || e < fromDay) continue;
        out.push({
          kind: "doc",
          key: `doc:${row.id}`,
          layer: `docs:${l.ref}`,
          title: displayTitle(row, ""),
          start: val.start,
          ...(val.end && DATE_RE.test(val.end) ? { end: val.end } : {}),
          url: docsUrl(acc.ws, row),
          color: l.color,
          canEdit: atLeast(level, "edit") && prop.denied !== "edit",
          dbId: db.id,
          propId: prop.id,
          sub: displayTitle(db, ""),
        });
      }
    } else if (l.kind === "issues") {
      const cards = await issueList(v, { ...(l.ref === "mine" ? { mine: true } : { project: l.ref }), limit: 100, dueFrom: fromDay, dueTo: toDay });
      for (const c of cards) {
        if (!c.due || c.due < fromDay || c.due > toDay) continue;
        out.push({ kind: "issue", key: `issue:${c.key.slice(6)}:${l.ref}`, layer: `issues:${l.ref}`, title: c.title, start: c.due, url: c.url, color: l.color, canEdit: false, ...(c.sub ? { sub: c.sub } : {}) });
      }
    } else {
      for (const c of cycleList(v)) {
        if (c.startsOn > toDay || c.endsOn < fromDay) continue;
        out.push({ kind: "cycle", key: `cycle:${c.id}`, layer: "cycles:all", title: c.name ? `${c.teamKey} · ${c.name}` : `${c.teamKey} · #${c.number}`, start: c.startsOn, end: c.endsOn, url: c.url, color: l.color, canEdit: false, sub: c.teamName });
      }
    }
  }
  return out;
}

/**
 * A Docs row dragged on the calendar: its date property gets the new start
 * (and end). Written like any edit of that person in Documents.
 */
export async function moveDocRow(user: { id: string; name: string }, ws: string, input: { dbId?: unknown; rowId?: unknown; propId?: unknown; start?: unknown; end?: unknown }, now = Date.now()): Promise<DateValue> {
  const { dbId, rowId, propId, start, end } = input;
  if (typeof dbId !== "string" || typeof rowId !== "string" || typeof propId !== "string" || !ID_RE.test(dbId) || !ID_RE.test(rowId) || !/^[\w-]{1,40}$/.test(propId)) throw new CalError(400, "bad row");
  if (typeof start !== "string" || !DATE_RE.test(start) || (end !== undefined && end !== null && (typeof end !== "string" || !DATE_RE.test(end) || end < start))) throw new CalError(400, "bad date");
  const res = new AccessResolver(ws, user.id);
  if (!res.level(rowId)) throw new CalError(404, "row not found");
  const row = loadNote(ws, rowId);
  const db = loadNote(ws, dbId);
  if (!row || !db?.db || row.parentId !== db.id || inTrash(ws, row)) throw new CalError(404, "row not found");
  const prop = db.db.properties.find((p) => p.id === propId && p.type === "date");
  if (!prop) throw new CalError(400, "not a date property");
  const cur = row.props?.[propId];
  const value: DateValue = { start, ...(typeof end === "string" && end !== start ? { end } : {}), ...(isDateValue(cur) && cur.remind ? { remind: cur.remind } : {}) };
  const note: Note = { ...row, props: { ...(row.props ?? {}), [propId]: value }, updatedAt: now };
  const payer = payerOf(ws);
  const left = payer ? await quotaLeft(payer) : 0;
  const result = pushNotes(ws, [{ id: row.id, note, fields: [`props.${propId}`] }], { by: user.id, quotaLeft: left, author: user.name, access: { userId: user.id } });
  if (!result.saved.includes(row.id)) throw new CalError(403, result.rejected[0]?.reason === "forbidden" ? "forbidden" : "not saved");
  const after = loadNote(ws, row.id)?.props?.[propId];
  // Column permissions may have kept the old value: report what is stored.
  if (!isDateValue(after) || after.start !== start) throw new CalError(403, "forbidden");
  return after;
}

