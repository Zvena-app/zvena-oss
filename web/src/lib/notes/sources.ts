// zvena Documents: databases with several data sources (Notion, 2025).
//
// A database holds one or more data sources; each has its own properties,
// rows, templates and automations, and each view names the one it shows.
// Stored so that nothing older breaks:
//   - the database note's own schema and rows are its first data source
//     (every database has it; one created before data sources has only it);
//   - each further data source is a database note under the database, marked
//     `db.dataSource`; its rows are notes under it, so access (a source can
//     be shared or restricted on its own), column permissions, automations,
//     forms, history and search treat it like any database;
//   - a data source of another database can be linked in (`db.linked`);
//   - views stay in the database's schema and name their source
//     (`view.source`; absent: the first one).
// Pure helpers: the browser, the server and the API use them alike.

import { blankSchema, defaultView, isSourceNote } from "./model";
import { groupWithoutProp } from "./db";
import type { DbSchema, DbView, Note } from "./types";

export interface SourceInfo {
  /** The data source's id: the database's own for the first one. */
  id: string;
  /** Its note (the database itself for the first one); undefined when it is not on this device (no access, deleted). */
  note: Note | undefined;
  /** "own": the database's first; "child": a further one in it; "linked": one of another database. */
  kind: "own" | "child" | "linked";
  name: string;
  icon: string;
}

/** A data source note's database (its parent), or undefined. */
export function hostOf(n: Note | undefined, byId: ReadonlyMap<string, Note>): Note | undefined {
  if (!n || !isSourceNote(n) || !n.parentId) return undefined;
  const p = byId.get(n.parentId);
  return p?.kind === "database" ? p : undefined;
}

/** Whether the note is a data source sitting in a database (not a database of its own). */
export function isDataSource(n: Note | undefined, byId: ReadonlyMap<string, Note>): boolean {
  return Boolean(hostOf(n, byId));
}

/** The database a note belongs to as a page would: a data source → its database; anything else → itself. */
export function databaseOf(n: Note | undefined, byId: ReadonlyMap<string, Note>): Note | undefined {
  return hostOf(n, byId) ?? n;
}

/** The data sources stored in a database (not the first), live, in order. */
export function childSources(hostId: string, all: Iterable<Note>): Note[] {
  const out: Note[] = [];
  for (const n of all) if (n.parentId === hostId && n.trashedAt === null && isSourceNote(n)) out.push(n);
  return out.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/** The name a data source goes by: its own, else its database's. */
export function sourceName(host: Pick<Note, "title" | "db">, src: Pick<Note, "id" | "title" | "db"> | undefined, untitled: string): string {
  const own = !src || src === host || (src as Note).id === (host as Note).id;
  const name = own ? host.db?.label?.name || host.title : src.title;
  return name.trim() || untitled;
}

export function sourceIcon(host: Pick<Note, "icon" | "db">, src: Pick<Note, "icon"> | undefined): string {
  return !src || src === host ? (host.db?.label?.icon ?? host.icon) : src.icon;
}

/** Every data source a database shows: its own, its further ones, then linked ones. */
export function sourcesOf(host: Note, all: Iterable<Note>, byId: ReadonlyMap<string, Note>, untitled: string): SourceInfo[] {
  const out: SourceInfo[] = [{ id: host.id, note: host, kind: "own", name: sourceName(host, host, untitled), icon: sourceIcon(host, host) }];
  for (const s of childSources(host.id, all)) out.push({ id: s.id, note: s, kind: "child", name: sourceName(host, s, untitled), icon: s.icon });
  for (const id of host.db?.linked ?? []) {
    if (out.some((x) => x.id === id)) continue;
    const n = byId.get(id);
    const live = n && n.kind === "database" && n.trashedAt === null ? n : undefined;
    const h = live ? (hostOf(live, byId) ?? live) : undefined;
    out.push({ id, note: live, kind: "linked", name: live && h ? sourceName(h, live === h ? h : live, untitled) : untitled, icon: live && h ? sourceIcon(h, live === h ? h : live) : "" });
  }
  return out;
}

/** The id of the data source a view shows. */
export function viewSourceId(hostId: string, view: Pick<DbView, "source"> | undefined): string {
  return view?.source && view.source !== hostId ? view.source : hostId;
}

/** Whether a database shows more than its own data source. */
export function hasSeveralSources(host: Note, all: Iterable<Note>): boolean {
  return Boolean(host.db?.linked?.length) || childSources(host.id, all).length > 0;
}

/**
 * The schema a view works with: the data source's properties (and
 * templates, automations…) with the database's views. Views live in the
 * database; everything else in the data source.
 */
export function mergedSchema(host: DbSchema, src: DbSchema | undefined, same: boolean): DbSchema | undefined {
  if (same) return host;
  return src ? { ...src, views: host.views } : undefined;
}

/**
 * A change made to a merged schema, split back: the database's new views
 * (null: unchanged) and the data source's new schema (null: unchanged).
 */
export function splitSchema(host: DbSchema, src: DbSchema, next: DbSchema): { views: DbView[] | null; source: DbSchema | null } {
  const { views, ...rest } = next;
  const { views: srcViews, ...before } = src;
  const keys = new Set([...Object.keys(rest), ...Object.keys(before)]);
  let changed = false;
  for (const k of keys) if ((rest as Record<string, unknown>)[k] !== (before as Record<string, unknown>)[k]) changed = true;
  return { views: views === host.views ? null : views, source: changed ? { ...(rest as DbSchema), views: srcViews } : null };
}

/** A new data source of a database: Name + Tags, as Notion starts one. */
export function newSourceSchema(labels: { name: string; tags: string; table: string }): DbSchema {
  return { ...blankSchema(labels), dataSource: true };
}

/** The database's views without those of a data source (their own ones, not linked-view blocks or dashboard tiles). */
export function viewsWithout(views: readonly DbView[], hostId: string, srcId: string): DbView[] {
  return views.filter((v) => v.scope || viewSourceId(hostId, v) !== srcId);
}

/** The database's views of a data source (tabs only). */
export function viewsOf(views: readonly DbView[], hostId: string, srcId: string): DbView[] {
  return views.filter((v) => !v.scope && viewSourceId(hostId, v) === srcId);
}

/**
 * Moving a data source to another database (Notion's "Move to"): the
 * source's view tabs go with it; linked-view blocks and dashboard tiles
 * stay and keep showing it from where it went. `src` may be the
 * database's own source only while it has no other: then the whole
 * database becomes a data source of the target.
 */
export function moveSourcePlan(
  from: Note,
  src: Note,
  to: Note,
  all: Iterable<Note>,
  tableName = "Table"
): { ok: true; from: DbSchema | null; to: DbSchema; src: Partial<Note> } | { ok: false; reason: "same" | "own" | "cycle" | "notDb" } {
  if (!from.db || !to.db || !src.db || to.kind !== "database") return { ok: false, reason: "notDb" };
  if (to.id === from.id || to.id === src.id) return { ok: false, reason: "same" };
  if (isSourceNote(to)) return { ok: false, reason: "notDb" };
  const list = [...all];
  const own = src.id === from.id;
  if (own && childSources(from.id, list).length) return { ok: false, reason: "own" };
  // Never into its own subtree (a database inside one of its rows).
  for (let cur: Note | undefined = to, depth = 0; cur && depth < 200; cur = cur.parentId ? list.find((n) => n.id === cur?.parentId) : undefined, depth++) {
    if (cur.id === src.id) return { ok: false, reason: "cycle" };
  }
  const moving = own ? from.db.views.filter((v) => !v.scope) : viewsOf(from.db.views, from.id, src.id);
  const toViews = moving.map((v) => {
    const id = viewSourceId(from.id, v);
    return { ...v, source: id };
  });
  // Linked sources the moved views show come along as links.
  const links = own ? (from.db.linked ?? []).filter((id) => id !== to.id) : [];
  const linked = [...new Set([...(to.db.linked ?? []), ...links])].filter((id) => id !== to.id);
  const nextTo: DbSchema = { ...to.db, views: [...to.db.views, ...toViews.map((v) => (v.source === to.id ? withoutSource(v) : v))], ...(linked.length ? { linked } : {}) };
  if (own) {
    const { linked: _l, ...rest } = from.db;
    void _l;
    return { ok: true, from: null, to: nextTo, src: { parentId: to.id, inline: false, db: { ...rest, views: from.db.views.filter((v) => v.scope), dataSource: true } } };
  }
  return { ok: true, from: keepATab({ ...from.db, views: viewsWithout(from.db.views, from.id, src.id) }, tableName), to: nextTo, src: { parentId: to.id, inline: false } };
}

/** A database always keeps a view tab (of its own data source when the others went). */
export function keepATab(schema: DbSchema, tableName: string): DbSchema {
  return schema.views.some((v) => !v.scope) ? schema : { ...schema, views: [...schema.views, defaultView("table", tableName, schema)] };
}

const withoutSource = (v: DbView): DbView => {
  const { source: _s, ...rest } = v;
  void _s;
  return rest;
};

/**
 * Turning a data source into a database of its own (Notion's "Turn into
 * database"): it leaves the database for the database's place (beside it),
 * its view tabs go with it, and it is a database again.
 */
export function splitSourcePlan(from: Note, src: Note, tableName = "Table"): { from: DbSchema; src: Partial<Note> } | null {
  if (!from.db || !src.db || src.id === from.id || src.parentId !== from.id) return null;
  const moving = viewsOf(from.db.views, from.id, src.id).map(withoutSource);
  const { dataSource: _d, ...rest } = src.db;
  void _d;
  // The views the source kept for itself (made before it was added here) give way to the moved tabs.
  const own = moving.length ? [...moving, ...rest.views.filter((v) => v.scope)] : keepATab(rest, tableName).views;
  return {
    from: keepATab({ ...from.db, views: viewsWithout(from.db.views, from.id, src.id) }, tableName),
    src: { parentId: from.parentId, ...(from.parentId === null && from.space ? { space: from.space } : {}), inline: false, db: { ...rest, views: own } },
  };
}

/** A view of a data source, made for the database (Notion's "New view" with a source picked). */
export function sourceView(type: DbView["type"], name: string, hostId: string, srcId: string, schema: DbSchema): DbView {
  const v = defaultView(type, name, schema);
  if (srcId !== hostId) v.source = srcId;
  return v;
}

/**
 * A view switched to another data source (Notion's view "Source"): its
 * filters, sorts, grouping and the rest keep only what that source has;
 * a board or calendar picks that source's first fitting property.
 */
export function retargetView(v: DbView, hostId: string, srcId: string, schema: DbSchema): DbView {
  const known = new Set(schema.properties.map((p) => p.id));
  const has = (id: string | undefined) => (id && known.has(id) ? id : undefined);
  const fresh = defaultView(v.type, v.name, schema);
  let group = v.filterGroup;
  if (group) for (const id of propIdsIn(group)) if (!known.has(id)) group = group && groupWithoutProp(group, id);
  const out: DbView = {
    ...v,
    filters: v.filters.filter((f) => known.has(f.prop)),
    filterGroup: group,
    sorts: v.sorts.filter((x) => known.has(x.prop)),
    hidden: v.hidden.filter((h) => known.has(h)),
    widths: Object.fromEntries(Object.entries(v.widths).filter(([k]) => known.has(k))),
    order: v.order?.filter((o) => known.has(o)),
    groupBy: has(v.groupBy) ?? fresh.groupBy,
    subGroupBy: has(v.subGroupBy),
    dateProp: has(v.dateProp) ?? fresh.dateProp,
    endProp: has(v.endProp),
    freeze: has(v.freeze),
    calcs: v.calcs ? Object.fromEntries(Object.entries(v.calcs).filter(([k]) => known.has(k))) : undefined,
    hiddenGroups: undefined,
    ...(v.form ? { form: { ...v.form, questions: v.form.questions.filter((q) => known.has(q.prop)) } } : {}),
    ...(v.chart ? { chart: { ...v.chart, x: has(v.chart.x), ...(v.chart.y?.prop && !known.has(v.chart.y.prop) ? { y: { fn: "count" as const } } : {}) } } : {}),
    ...(v.map ? { map: { ...v.map, prop: has(v.map.prop) ?? fresh.map?.prop } } : {}),
    colors: v.colors?.filter((c) => (!c.prop || known.has(c.prop)) && c.filters.every((f) => known.has(f.prop))),
  };
  if (srcId === hostId) delete out.source;
  else out.source = srcId;
  for (const k of Object.keys(out) as (keyof DbView)[]) if (out[k] === undefined) delete out[k];
  return out;
}

function propIdsIn(g: NonNullable<DbView["filterGroup"]>, out: string[] = []): string[] {
  for (const x of g.items) {
    if ("items" in x) propIdsIn(x, out);
    else out.push(x.prop);
  }
  return out;
}

/**
 * What a static copy of a database shows (public pages, exports): one
 * table per data source, each by the first view tab of that source; a
 * linked-view block (`scope`) shows its own first view. Sources not in
 * `notes` (not published, not readable) are left out.
 */
export function sourceTables(db: Note, notes: readonly Note[], scope?: string): { view: DbView | undefined; src: Note }[] {
  const views = db.db?.views ?? [];
  const byId = new Map(notes.map((n) => [n.id, n]));
  const pick = (v: DbView): Note | undefined => {
    const id = viewSourceId(db.id, v);
    const src = id === db.id ? db : byId.get(id);
    return src?.kind === "database" && src.db && src.trashedAt === null ? src : undefined;
  };
  if (scope) {
    const v = views.find((x) => x.scope === scope);
    const src = v ? pick(v) : undefined;
    if (src) return [{ view: v, src }];
  }
  const out: { view: DbView | undefined; src: Note }[] = [];
  const seen = new Set<string>();
  for (const v of views) {
    if (v.scope || v.type === "dashboard" || v.type === "form") continue;
    const src = pick(v);
    if (!src || seen.has(src.id)) continue;
    seen.add(src.id);
    out.push({ view: v, src });
  }
  return out.length ? out : [{ view: views.find((x) => !x.scope), src: db }];
}
