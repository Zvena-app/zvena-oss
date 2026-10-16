// Server-only: the endpoints of the public API (Notion's shapes). Routes in
// src/app/api/v1 are thin wrappers around these.

import { randomUUID } from "node:crypto";
import { uniqueIdFixes } from "../compute";
import { blankNote, defaultView, newNoteId, safeUrl, shortId } from "../model";
import type { Note, NoteComment, NoteCover } from "../types";
import { childBlocks, fromNotionBlocks, toNotionBlock, updateBlock, type NotionBlock, readableBlocks } from "./blocks";
import { listIntegrations } from "./integrations";
import { botObject, computed, contexts, databaseObject, dataSourceObject, isFurtherSource, noteObject, pageObject, personObject } from "./objects";
import { moveSourcePlan, sourceView } from "../sources";
import { principals, readableSets, settleAccess, subtreeOf } from "../access";
import { restricted } from "./respond";
import { patchSchema, propertyKeys, propertyValue, schemaFromRequest, titleFromRequest, valuesFromRequest } from "./properties";
import { matches, paginate, sortRows } from "./query";
import { notFound, type ApiCtx } from "./respond";
import { fromRichText, InputError, noteIdOf, toRichText } from "./richtext";
import { idForms, toUuid, usesDataSources, type RawBlock, type Space } from "./space";
import { orderAtEnd, save } from "./write";

const params = (ctx: ApiCtx) => new URL(ctx.req.url).searchParams;

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** A visible page or database by any id form; 404 otherwise. */
function noteOr404(space: Space, id: string, what = "page"): Note {
  const n = space.note(id);
  if (!n || n.synced) throw notFound(`${what} with ID: ${id}`);
  return n;
}

// --- Users -------------------------------------------------------------------------

export function listUsers(ctx: ApiCtx): unknown {
  const dir = ctx.people();
  const withEmail = ctx.integration.caps.users === "emails";
  const people = [...dir.people.values()].map((p) => personObject(p, withEmail));
  const bots = listIntegrations(ctx.integration.ws).map((i) => ({ object: "user", id: toUuid(i.id), type: "bot", name: i.name, avatar_url: null, bot: {} }));
  const q = params(ctx);
  return paginate([...people, ...bots], q.get("start_cursor") ?? undefined, q.get("page_size") ?? undefined, "user");
}

export function me(ctx: ApiCtx): unknown {
  return botObject(ctx.integration);
}

export function getUser(ctx: ApiCtx, id: string): unknown {
  const dir = ctx.people();
  const p = dir.people.get(id);
  if (p) return personObject(p, ctx.integration.caps.users === "emails");
  const raw = id.replace(/-/g, "");
  const bot = listIntegrations(ctx.integration.ws).find((i) => i.id === raw);
  if (bot) return bot.id === ctx.integration.id ? botObject(bot) : { object: "user", id: toUuid(bot.id), type: "bot", name: bot.name, avatar_url: null, bot: {} };
  throw notFound(`user with ID: ${id}`);
}

// --- Search ------------------------------------------------------------------------

export async function search(ctx: ApiCtx): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const dir = ctx.people();
  const query = typeof body.query === "string" ? body.query.trim().toLowerCase() : "";
  const filter = body.filter as Record<string, unknown> | undefined;
  // 2025-09-03 searches data sources ("data_source"); older versions databases.
  const dbWord = usesDataSources(ctx.version) ? "data_source" : "database";
  const only = filter && filter.property === "object" && (filter.value === "page" || filter.value === dbWord) ? (filter.value === "page" ? "page" : "database") : null;
  if (filter && !only) throw new InputError(`filter should be { "property": "object", "value": "page" | "${dbWord}" }`);
  const sort = body.sort as Record<string, unknown> | undefined;
  const dir2 = sort?.direction === "ascending" ? 1 : -1;
  let found = space.visible().filter((n) => !n.synced && !space.inTrash(n) && (!only || (only === "database") === (n.kind === "database")));
  if (query) found = found.filter((n) => n.title.toLowerCase().includes(query));
  found.sort((a, b) => {
    if (query && !sort) {
      const ap = a.title.toLowerCase().startsWith(query) ? 0 : 1;
      const bp = b.title.toLowerCase().startsWith(query) ? 0 : 1;
      if (ap !== bp) return ap - bp;
    }
    return (a.updatedAt - b.updatedAt) * dir2;
  });
  const page = paginate(found, body.start_cursor, body.page_size, "page_or_database");
  return { ...page, results: page.results.map((n) => noteObject(n, space, dir)) };
}

// --- Pages -------------------------------------------------------------------------

function iconFrom(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return "";
  const r = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  if (r.type === "emoji" || typeof r.emoji === "string") {
    const e = typeof r.emoji === "string" ? r.emoji : "";
    if (!e || e.length > 16 || /[<>]/.test(e)) throw new InputError("icon.emoji is not valid");
    return e;
  }
  throw new InputError("icon: only emoji icons can be set through the API");
}

function coverFrom(v: unknown): NoteCover | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const url = ((v as Record<string, unknown>)?.external as Record<string, unknown> | undefined)?.url;
  if (typeof url !== "string" || !/^https:\/\//i.test(url) || !safeUrl(url, true)) throw new InputError("cover: an https external url is required");
  return { kind: "image", value: url.slice(0, 2000), y: 50 };
}

function parentOf(space: Space, parent: unknown, version: string): Note {
  const r = (typeof parent === "object" && parent !== null ? parent : {}) as Record<string, unknown>;
  // A data source names where a row goes; with it, a database_id is only informative.
  const raw = r.page_id ?? r.data_source_id ?? r.database_id;
  const id = noteIdOf(raw);
  if (!id) throw new InputError("parent should be { page_id }, { data_source_id } or { database_id }");
  const n = space.note(id);
  if (!n || n.synced) throw notFound(`parent with ID: ${String(raw)}`);
  if (r.data_source_id !== undefined) {
    if (n.kind !== "database") throw new InputError("parent.data_source_id is a page, not a data source");
    return n;
  }
  if (r.database_id !== undefined && n.kind !== "database") throw new InputError("parent.database_id is a page, not a database");
  if (r.database_id !== undefined && usesDataSources(version)) {
    // A database with several data sources does not say which one the row goes to (Notion).
    if (isFurtherSource(n, space)) throw new InputError(`${String(raw)} is a data source: use parent.data_source_id`);
    if (space.sourcesOf(n).length > 1) throw new InputError("this database has several data sources: name one with parent.data_source_id");
  }
  if (r.page_id !== undefined && n.kind !== "page") throw new InputError("parent.page_id is a database: use database_id");
  return n;
}

/** Fills Unique ID properties of new rows (the app numbers them the same way). */
function numberRows(db: Note, rows: Note[]): void {
  for (const p of db.db?.properties ?? []) {
    if (p.type !== "unique_id") continue;
    for (const fix of uniqueIdFixes(rows, p)) {
      const r = rows.find((x) => x.id === fix.id);
      if (r) r.props = { ...(r.props ?? {}), [p.id]: fix.n };
    }
  }
}

function writeContext(space: Space, ctx: ApiCtx) {
  return {
    related: (id: string, dbId: string) => space.note(id)?.parentId === dbId,
    member: (id: string) => ctx.people().people.has(id),
  };
}

export async function createPage(ctx: ApiCtx): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const parent = parentOf(space, body.parent, ctx.version);
  const canLink = (id: string) => space.note(id) !== null;
  const content = body.children === undefined ? [] : fromNotionBlocks(body.children, canLink);
  const icon = iconFrom(body.icon);
  const cover = coverFrom(body.cover);
  const now = Date.now();
  const toSave: Note[] = [];
  let page: Note;
  if (parent.kind === "database") {
    const db = clone(parent);
    if (!db.db) throw new InputError("the database has no schema");
    const w = valuesFromRequest(db.db, body.properties, writeContext(space, ctx));
    const rows = space.rows(db.id);
    page = blankNote({ kind: "page", parentId: db.id, title: w.title ?? "", props: w.props, content, order: orderAtEnd(rows), createdAt: now, updatedAt: now, ...(icon ? { icon } : {}), ...(cover ? { cover } : {}) });
    if (w.newOptions.length && db.db) {
      db.db = { ...db.db, properties: db.db.properties.map((p) => ({ ...p, options: [...(p.options ?? []), ...w.newOptions.filter((o) => o.propId === p.id && !(p.options ?? []).some((x) => x.id === o.option.id)).map((o) => o.option)] })) };
      toSave.push(db);
    }
    numberRows(db, [...rows, page]);
  } else {
    const title = titleFromRequest(body.properties) ?? "";
    page = blankNote({ kind: "page", parentId: parent.id, title, content, order: orderAtEnd(space.children(parent.id).filter((n) => n.kind === "page" || n.kind === "database")), createdAt: now, updatedAt: now, ...(icon ? { icon } : {}), ...(cover ? { cover } : {}) });
    // A sub-page also appears in its parent's body, as the app places it.
    const p = clone(parent);
    p.content = [...p.content, { id: randomUUID(), type: "page", props: { noteId: page.id } }];
    toSave.push(p);
  }
  toSave.unshift(page);
  await save(ctx, toSave);
  return pageObject(noteOr404(space, page.id), space, ctx.people());
}

export function getPage(ctx: ApiCtx, id: string): unknown {
  const space = ctx.space();
  const n = noteOr404(space, id);
  if (n.kind === "database") throw new InputError(`${id} is a database, not a page; use GET /v1/${usesDataSources(ctx.version) ? "data_sources" : "databases"}/${id}`);
  return pageObject(n, space, ctx.people());
}

function trashFlag(body: Record<string, unknown>): boolean | undefined {
  const v = body.in_trash ?? body.archived;
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new InputError("in_trash should be true or false");
  return v;
}

export async function updatePage(ctx: ApiCtx, id: string): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const cur = noteOr404(space, id);
  if (cur.kind === "database") throw new InputError(`${id} is a database; use PATCH /v1/databases/${id}`);
  const n = clone(cur);
  const toSave: Note[] = [n];
  const parent = n.parentId ? space.notes.get(n.parentId) : undefined;
  if (body.properties !== undefined) {
    if (parent?.kind === "database" && parent.db) {
      const db = clone(parent);
      const w = valuesFromRequest(db.db as NonNullable<Note["db"]>, body.properties, writeContext(space, ctx));
      if (w.title !== undefined) n.title = w.title;
      n.props = { ...(n.props ?? {}), ...w.props };
      if (w.newOptions.length && db.db) {
        db.db = { ...db.db, properties: db.db.properties.map((p) => ({ ...p, options: [...(p.options ?? []), ...w.newOptions.filter((o) => o.propId === p.id && !(p.options ?? []).some((x) => x.id === o.option.id)).map((o) => o.option)] })) };
        toSave.push(db);
      }
    } else {
      const title = titleFromRequest(body.properties);
      if (title !== undefined) n.title = title;
    }
  }
  const icon = iconFrom(body.icon);
  if (icon !== undefined) n.icon = icon;
  const cover = coverFrom(body.cover);
  if (cover !== undefined) n.cover = cover;
  const trash = trashFlag(body);
  if (trash === true && n.trashedAt === null) n.trashedAt = Date.now();
  if (trash === false && n.trashedAt !== null) n.trashedAt = null;
  n.updatedAt = Date.now();
  await save(ctx, toSave);
  return pageObject(noteOr404(space, n.id), space, ctx.people());
}

export function getPageProperty(ctx: ApiCtx, id: string, propId: string): unknown {
  const space = ctx.space();
  const n = noteOr404(space, id);
  const parent = n.parentId ? space.notes.get(n.parentId) : undefined;
  const dir = ctx.people();
  const vctx = contexts(space, dir, n.id);
  let value: Record<string, unknown>;
  const key = decodeURIComponent(propId);
  if (parent?.kind === "database" && parent.db) {
    const p = parent.db.properties.find((x) => x.id === key) ?? [...propertyKeys(parent.db)].find(([k]) => k === key)?.[1];
    if (!p) throw notFound(`property ${propId}`);
    value = propertyValue(computed(n, space), p, parent.db, vctx);
  } else if (key === "title") {
    value = { id: "title", type: "title", title: toRichText(n.title ? [{ type: "text", text: n.title, styles: {} }] : [], vctx) };
  } else throw notFound(`property ${propId}`);
  const type = String(value.type);
  // Lists (title, rich_text, relation, people) come as paginated property items, as in Notion.
  if (type === "title" || type === "rich_text" || type === "relation" || type === "people") {
    const items = (value[type] as unknown[]).map((x) => ({ object: "property_item", id: value.id, type, [type]: x }));
    const q = params(ctx);
    return { ...paginate(items, q.get("start_cursor") ?? undefined, q.get("page_size") ?? undefined, "property_item"), property_item: { id: value.id, next_url: null, type, [type]: {} } };
  }
  return { object: "property_item", ...value };
}

// --- Databases ---------------------------------------------------------------------

export async function createDatabase(ctx: ApiCtx): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const parent = parentOf(space, body.parent, ctx.version);
  if (parent.kind !== "page") throw new InputError("a database is created inside a page (parent.page_id)");
  const id = newNoteId();
  const title = textOf(body.title);
  // 2025-09-03: the first data source's properties come as initial_data_source.properties.
  const initial = (body.initial_data_source ?? {}) as Record<string, unknown>;
  const props = usesDataSources(ctx.version) && body.initial_data_source !== undefined ? initial.properties : body.properties;
  const { schema, mirrors } = schemaFromRequest(props, id, title, (x) => (space.note(x)?.kind === "database" ? space.note(x)?.title ?? "" : null));
  schema.views = [defaultView("table", "Table", schema)];
  const inline = body.is_inline === true;
  const now = Date.now();
  const icon = iconFrom(body.icon);
  const cover = coverFrom(body.cover);
  const db = blankNote({ id, kind: "database", parentId: parent.id, title, db: schema, order: orderAtEnd(space.children(parent.id)), createdAt: now, updatedAt: now, ...(inline ? { inline: true } : {}), ...(icon ? { icon } : {}), ...(cover ? { cover } : {}) });
  const p = clone(parent);
  p.content = [...p.content, { id: randomUUID(), type: inline ? "database" : "page", props: inline ? { noteId: id, view: "" } : { noteId: id } }];
  const others = mirrors.map((m) => {
    const t = clone(space.note(m.dbId) as Note);
    if (t.db) t.db = { ...t.db, properties: [...t.db.properties, m.property] };
    return t;
  });
  await save(ctx, [db, p, ...others]);
  return databaseObject(noteOr404(space, id, "database"), space, ctx.people());
}

const textOf = (v: unknown) => (Array.isArray(v) ? (fromRichText(v) as { text?: string }[]).map((x) => x.text ?? "").join("").slice(0, 2000) : "");

function dbOr404(space: Space, id: string): Note {
  const n = noteOr404(space, id, "database");
  if (n.kind !== "database") throw new InputError(`${id} is a page, not a database`);
  // 2025-09-03: a further data source is not a database of its own.
  if (usesDataSources(space.version) && isFurtherSource(n, space)) throw new InputError(`${id} is a data source; use /v1/data_sources/${id}`);
  return n;
}

export function getDatabase(ctx: ApiCtx, id: string): unknown {
  const space = ctx.space();
  return databaseObject(dbOr404(space, id), space, ctx.people());
}

export async function updateDatabase(ctx: ApiCtx, id: string): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const db = clone(dbOr404(space, id));
  // 2025-09-03: properties belong to data sources.
  if (usesDataSources(ctx.version) && body.properties !== undefined) throw new InputError(`properties belong to data sources: use PATCH /v1/data_sources/{id}`);
  if (Array.isArray(body.title)) db.title = textOf(body.title);
  const { schema, mirrors } = patchSchema(db.db ?? { properties: [], views: [] }, body.properties, db.id, db.title, (x) => (space.note(x)?.kind === "database" ? space.note(x)?.title ?? "" : null));
  db.db = schema;
  const icon = iconFrom(body.icon);
  if (icon !== undefined) db.icon = icon;
  const cover = coverFrom(body.cover);
  if (cover !== undefined) db.cover = cover;
  const trash = trashFlag(body);
  if (trash === true && db.trashedAt === null) db.trashedAt = Date.now();
  if (trash === false && db.trashedAt !== null) db.trashedAt = null;
  db.updatedAt = Date.now();
  const others = mirrors.map((m) => {
    const t = clone(space.note(m.dbId) as Note);
    if (t.db) t.db = { ...t.db, properties: [...t.db.properties, m.property] };
    return t;
  });
  await save(ctx, [db, ...others]);
  return databaseObject(noteOr404(space, db.id, "database"), space, ctx.people());
}

export async function queryDatabase(ctx: ApiCtx, id: string): Promise<unknown> {
  // 2025-09-03: rows are queried per data source.
  if (usesDataSources(ctx.version)) throw new InputError(`query a data source instead: POST /v1/data_sources/{id}/query (GET /v1/databases/${id} lists them)`);
  const space = ctx.space();
  return queryRows(ctx, dbOr404(space, id));
}

/** The rows of a database or data source, filtered, sorted and paginated as the request asks. */
async function queryRows(ctx: ApiCtx, db: Note): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const schema = db.db ?? { properties: [], views: [] };
  const dir = ctx.people();
  const names = (uid: string) => dir.name(uid) ?? "";
  const now = Date.now();
  let rows = space.rows(db.id).filter((r) => !space.inTrash(r));
  rows = rows.map((r) => computed(r, space));
  rows = rows.filter((r) => matches(r, schema, body.filter, now, names));
  rows = sortRows(rows, schema, body.sorts, names);
  const page = paginate(rows, body.start_cursor, body.page_size, "page_or_database");
  return { ...page, results: page.results.map((r) => pageObject(r, space, dir)) };
}

// --- Data sources (Notion API 2025-09-03) -----------------------------------------

function sourceOr404(space: Space, id: string): Note {
  const n = noteOr404(space, id, "data source");
  if (n.kind !== "database") throw new InputError(`${id} is a page, not a data source`);
  return n;
}

export function getDataSource(ctx: ApiCtx, id: string): unknown {
  const space = ctx.space();
  return dataSourceObject(sourceOr404(space, id), space, ctx.people());
}

export async function queryDataSource(ctx: ApiCtx, id: string): Promise<unknown> {
  return queryRows(ctx, sourceOr404(ctx.space(), id));
}

/** A data source's page templates (Notion's GET /v1/data_sources/{id}/templates). */
export function listTemplates(ctx: ApiCtx, id: string): unknown {
  const space = ctx.space();
  const src = sourceOr404(space, id);
  const tpls = space
    .children(src.id)
    .filter((n) => n.template && !space.inTrash(n) && space.canSee(n.id))
    .map((n) => ({ id: toUuid(n.id), name: n.title, is_default: src.db?.defaultTemplate === n.id }));
  const q = params(ctx);
  const page = paginate(tpls, q.get("start_cursor") ?? undefined, q.get("page_size") ?? undefined, "template");
  const { results, ...rest } = page;
  return { ...rest, templates: results };
}

/** POST /v1/data_sources { parent: { database_id }, title, properties, icon } — a further data source in a database. */
export async function createDataSource(ctx: ApiCtx): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const r = (typeof body.parent === "object" && body.parent !== null ? body.parent : {}) as Record<string, unknown>;
  const hostId = noteIdOf(r.database_id);
  if (!hostId) throw new InputError("parent should be { database_id }");
  const host = space.note(hostId);
  if (!host || host.synced || host.kind !== "database") throw notFound(`database with ID: ${String(r.database_id)}`);
  if (isFurtherSource(host, space)) throw new InputError(`${String(r.database_id)} is a data source, not a database`);
  const id = newNoteId();
  const title = textOf(body.title);
  const { schema, mirrors } = schemaFromRequest(body.properties, id, title, (x) => (space.note(x)?.kind === "database" ? space.note(x)?.title ?? "" : null));
  schema.views = [defaultView("table", "Table", schema)];
  schema.dataSource = true;
  const now = Date.now();
  const icon = iconFrom(body.icon);
  const src = blankNote({ id, kind: "database", parentId: host.id, title, db: schema, order: orderAtEnd(space.sourcesOf(host).slice(1)), createdAt: now, updatedAt: now, ...(icon ? { icon } : {}) });
  // A view tab of it in its database, as the app adds one.
  const h = clone(host);
  if (h.db) h.db = { ...h.db, views: [...h.db.views, sourceView("table", title || "Table", h.id, id, schema)] };
  const others = mirrors.map((m) => {
    const t = clone(space.note(m.dbId) as Note);
    if (t.db) t.db = { ...t.db, properties: [...t.db.properties, m.property] };
    return t;
  });
  await save(ctx, [src, h, ...others]);
  return dataSourceObject(noteOr404(space, id, "data source"), space, ctx.people());
}

/** PATCH /v1/data_sources/{id} { title, icon, properties, in_trash, parent: { database_id } }. */
export async function updateDataSource(ctx: ApiCtx, id: string): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const n = clone(sourceOr404(space, id));
  const host = space.hostOf(n);
  const first = host.id === n.id;
  const toSave: Note[] = [n];
  if (Array.isArray(body.title)) {
    const name = textOf(body.title);
    // The first data source has the database's name unless it was given its own.
    if (first && n.db) {
      const label = { ...n.db.label, name: name && name !== n.title ? name : undefined };
      n.db = { ...n.db, label: label.name || label.icon ? label : undefined };
    } else n.title = name;
  }
  const icon = iconFrom(body.icon);
  if (icon !== undefined) {
    if (first && n.db) {
      const label = { ...n.db.label, icon: icon || undefined };
      n.db = { ...n.db, label: label.name || label.icon ? label : undefined };
    } else n.icon = icon;
  }
  const { schema, mirrors } = patchSchema(n.db ?? { properties: [], views: [] }, body.properties, n.id, n.title, (x) => (space.note(x)?.kind === "database" ? space.note(x)?.title ?? "" : null));
  n.db = schema;
  const trash = trashFlag(body);
  if (trash !== undefined && first) throw new InputError(`the first data source goes with its database: PATCH /v1/databases/${toUuid(host.id)} { in_trash }`);
  if (trash === true && n.trashedAt === null) n.trashedAt = Date.now();
  if (trash === false && n.trashedAt !== null) n.trashedAt = null;
  // Moving to another database (Notion: parent { database_id }): who may read it changes, so it is settled afterwards.
  let moved: { ids: string[]; before: Map<string, Set<string>> } | null = null;
  if (body.parent !== undefined) {
    const p = (typeof body.parent === "object" && body.parent !== null ? body.parent : {}) as Record<string, unknown>;
    const toId = noteIdOf(p.database_id);
    const to = toId ? space.note(toId) : null;
    if (!to || to.kind !== "database") throw notFound(`database with ID: ${String(p.database_id)}`);
    if (to.id !== host.id) {
      // As in the app: edit where it goes, and full access when it leaves its sidebar section.
      if (!space.canWrite(to.id)) throw restricted("The integration may not change that database.");
      if (sectionOf(space, n) !== sectionOf(space, to) && space.level(n.id) !== "full") throw restricted("Moving this data source there needs full access to it.");
      const ids = subtreeOf(ctx.integration.ws, [n.id]);
      moved = { ids, before: readableSets(ctx.integration.ws, principals(ctx.integration.ws), ids) };
      const from = first ? n : clone(host);
      const plan = moveSourcePlan(from, n, clone(to), space.notes.values());
      if (!plan.ok) throw new InputError(plan.reason === "own" ? "the first data source stays with its database while it has others" : "the data source cannot move there");
      Object.assign(n, plan.src);
      const target = clone(to);
      target.db = plan.to;
      toSave.push(target);
      if (!first && plan.from) {
        from.db = plan.from;
        toSave.push(from);
      }
      // A whole database that became a data source leaves its page's body.
      const oldParent = first && host.parentId ? space.notes.get(host.parentId) : undefined;
      if (oldParent?.kind === "page") {
        const page = clone(oldParent);
        page.content = (page.content as RawBlock[]).filter((b) => b?.props?.noteId !== n.id);
        toSave.push(page);
      }
    }
  }
  n.updatedAt = Date.now();
  const others = mirrors.map((m) => {
    const t = clone(space.note(m.dbId) as Note);
    if (t.db) t.db = { ...t.db, properties: [...t.db.properties, m.property] };
    return t;
  });
  await save(ctx, [...toSave, ...others]);
  if (moved) settleAccess(ctx.integration.ws, moved.ids, moved.before);
  return dataSourceObject(noteOr404(space, n.id, "data source"), space, ctx.people());
}

/** The sidebar section above a note: its top-level page's ("" for the workspace's pages). */
function sectionOf(space: Space, n: Note): string {
  let cur: Note | undefined = n;
  for (let depth = 0; cur && depth < 200; depth++) {
    if (!cur.parentId) return cur.space ?? "";
    cur = space.notes.get(cur.parentId);
  }
  return "";
}

// --- Blocks ------------------------------------------------------------------------

/** A page or database as the block its parent shows (child_page / child_database). */
function noteAsBlock(n: Note, space: Space, ctx: ApiCtx): NotionBlock {
  const parent = n.parentId ? space.notes.get(n.parentId) : undefined;
  const bctx = contexts(space, ctx.people(), parent?.id ?? "");
  const type = n.kind === "database" ? "child_database" : "child_page";
  return {
    object: "block",
    id: toUuid(n.id),
    parent: parent ? (parent.kind === "database" ? { type: "database_id", database_id: toUuid(parent.id) } : { type: "page_id", page_id: toUuid(parent.id) }) : ({ type: "workspace", workspace: true } as never),
    created_time: new Date(n.createdAt).toISOString(),
    last_edited_time: new Date(n.updatedAt).toISOString(),
    created_by: bctx.user(n.createdBy),
    last_edited_by: bctx.user(n.editedBy ?? n.createdBy),
    has_children: n.kind === "page" && n.content.length > 0,
    archived: space.inTrash(n),
    in_trash: space.inTrash(n),
    type,
    [type]: { title: n.title },
  };
}

function blockOr404(space: Space, id: string) {
  const hit = space.findBlock(id);
  if (!hit) throw notFound(`block with ID: ${id}`);
  return hit;
}

export function getBlock(ctx: ApiCtx, id: string): unknown {
  const space = ctx.space();
  const n = space.note(id);
  if (n && !n.synced) return noteAsBlock(n, space, ctx);
  const hit = blockOr404(space, id);
  return toNotionBlock(hit.block, hit.note, hit.parent?.id ?? null, contexts(space, ctx.people(), hit.note.id));
}

export async function updateBlockById(ctx: ApiCtx, id: string): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const trash = trashFlag(body);
  const n = space.note(id);
  if (n && !n.synced) {
    const c = clone(n);
    const payload = (body.child_page ?? body.child_database) as Record<string, unknown> | undefined;
    if (payload && typeof payload.title === "string") c.title = payload.title.slice(0, 2000);
    if (trash === true && c.trashedAt === null) c.trashedAt = Date.now();
    if (trash === false && c.trashedAt !== null) c.trashedAt = null;
    c.updatedAt = Date.now();
    await save(ctx, [c]);
    return noteAsBlock(noteOr404(space, c.id), space, ctx);
  }
  const hit = blockOr404(space, id);
  const page = clone(hit.note);
  const again = findByPath(page, hit.block);
  if (!again) throw notFound(`block with ID: ${id}`);
  if (trash === true) again.list.splice(again.index, 1);
  else updateBlock(again.block, body, (x) => space.note(x) !== null);
  page.updatedAt = Date.now();
  await save(ctx, [page]);
  const out = toNotionBlock(again.block, page, hit.parent?.id ?? null, contexts(space, ctx.people(), page.id));
  return trash === true ? { ...out, archived: true, in_trash: true } : out;
}

export async function deleteBlock(ctx: ApiCtx, id: string): Promise<unknown> {
  const space = ctx.space();
  const n = space.note(id);
  if (n && !n.synced) {
    const c = clone(n);
    if (c.trashedAt === null) c.trashedAt = Date.now();
    c.updatedAt = Date.now();
    await save(ctx, [c]);
    return { ...noteAsBlock(noteOr404(space, c.id), space, ctx), archived: true, in_trash: true };
  }
  const hit = blockOr404(space, id);
  const page = clone(hit.note);
  const again = findByPath(page, hit.block);
  if (!again) throw notFound(`block with ID: ${id}`);
  const [removed] = again.list.splice(again.index, 1);
  page.updatedAt = Date.now();
  await save(ctx, [page]);
  return { ...toNotionBlock(removed, page, hit.parent?.id ?? null, contexts(space, ctx.people(), page.id)), archived: true, in_trash: true };
}

/** The same block inside a cloned page (found again by id). */
function findByPath(page: Note, block: RawBlock): { block: RawBlock; list: RawBlock[]; index: number; parent: RawBlock | null } | null {
  const id = block.id;
  const walk = (list: RawBlock[], parent: RawBlock | null): ReturnType<typeof findByPath> => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b?.id === id) return { block: b, list, index: i, parent };
      if (Array.isArray(b?.children)) {
        const hit = walk(b.children, b);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(page.content as RawBlock[], null);
}

export function listChildren(ctx: ApiCtx, id: string): unknown {
  const space = ctx.space();
  const dir = ctx.people();
  const q = params(ctx);
  const n = space.note(id);
  let blocks: NotionBlock[];
  if (n && !n.synced) {
    if (n.kind === "database") throw new InputError(`${id} is a database; query its rows with POST /v1/${usesDataSources(ctx.version) ? "data_sources" : "databases"}/${id}/query`);
    const bctx = contexts(space, dir, n.id);
    blocks = readableBlocks(n.content).map((b) => toNotionBlock(b, n, null, bctx));
  } else {
    const hit = blockOr404(space, id);
    const bctx = contexts(space, dir, hit.note.id);
    const { blocks: kids, page } = childBlocks(hit.block, bctx);
    const owner = page ?? hit.note;
    const kctx = page ? contexts(space, dir, page.id) : bctx;
    blocks = kids.map((b) => toNotionBlock(b, owner, page ? null : String(hit.block.id), kctx));
    if (page) blocks = blocks.map((b) => ({ ...b, parent: { type: "block_id", block_id: toUuid(String(hit.block.id)) } }));
  }
  return paginate(blocks, q.get("start_cursor") ?? undefined, q.get("page_size") ?? undefined, "block");
}

const NESTING = new Set(["paragraph", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "quote", "callout", "column", "heading"]);

export async function appendChildren(ctx: ApiCtx, id: string): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const blocks = fromNotionBlocks(body.children, (x) => space.note(x) !== null);
  if (blocks.length === 0) throw new InputError("children should list at least one block");
  const after = typeof body.after === "string" ? body.after : null;
  const n = space.note(id);
  let page: Note;
  let list: RawBlock[];
  let parentBlockId: string | null = null;
  if (n && !n.synced) {
    if (n.kind === "database") throw new InputError(`${id} is a database; add rows with POST /v1/pages`);
    page = clone(n);
    list = page.content as RawBlock[];
  } else {
    const hit = blockOr404(space, id);
    if (hit.block.type === "synced") {
      const src = space.note(String(hit.block.props?.noteId ?? ""));
      if (!src) throw notFound(`block with ID: ${id}`);
      page = clone(src);
      list = page.content as RawBlock[];
    } else {
      if (!NESTING.has(String(hit.block.type)) || (hit.block.type === "heading" && hit.block.props?.isToggleable !== true)) throw new InputError(`a ${String(hit.block.type)} block cannot have children`);
      page = clone(hit.note);
      const again = findByPath(page, hit.block);
      if (!again) throw notFound(`block with ID: ${id}`);
      again.block.children = Array.isArray(again.block.children) ? again.block.children : [];
      list = again.block.children;
      parentBlockId = String(hit.block.id);
    }
  }
  let at = list.length;
  if (after) {
    const forms = new Set(idForms(after));
    const i = list.findIndex((b) => typeof b.id === "string" && forms.has(b.id));
    if (i < 0) throw new InputError("after: no such child block");
    at = i + 1;
  }
  list.splice(at, 0, ...blocks);
  page.updatedAt = Date.now();
  await save(ctx, [page]);
  const bctx = contexts(space, ctx.people(), page.id);
  const results = blocks.map((b) => toNotionBlock(b, page, parentBlockId, bctx));
  return { object: "list", results, next_cursor: null, has_more: false, type: "block", block: {} };
}

// --- Comments ----------------------------------------------------------------------

const MENTION_RE = /<@([A-Za-z0-9_:-]{1,80})>/g;

function commentRich(c: NoteComment, ctx: ApiCtx, space: Space): unknown[] {
  // "<@userId>" tokens in a comment are mentions of people.
  const parts: unknown[] = [];
  let last = 0;
  for (const m of c.text.matchAll(MENTION_RE)) {
    if (m.index > last) parts.push({ type: "text", text: c.text.slice(last, m.index), styles: {} });
    parts.push({ type: "mention", props: { userId: m[1] } });
    last = m.index + m[0].length;
  }
  if (last < c.text.length) parts.push({ type: "text", text: c.text.slice(last), styles: {} });
  return toRichText(parts, contexts(space, ctx.people()));
}

function commentObject(c: NoteComment, note: Note, blockId: string | null, ctx: ApiCtx, space: Space): Record<string, unknown> {
  const dir = ctx.people();
  return {
    object: "comment",
    id: c.id,
    parent: blockId ? { type: "block_id", block_id: toUuid(blockId) } : { type: "page_id", page_id: toUuid(note.id) },
    discussion_id: c.thread ?? c.id,
    created_time: new Date(c.at).toISOString(),
    last_edited_time: new Date(c.at).toISOString(),
    created_by: c.authorId ? dir.user(c.authorId) : { object: "user", id: null },
    rich_text: commentRich(c, ctx, space),
    display_name: { type: "custom", resolved_name: c.author },
  };
}

function threadsIn(content: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(content)) for (const x of content) threadsIn(x, out);
  else if (content && typeof content === "object") {
    const r = content as { styles?: { comment?: unknown }; content?: unknown; rows?: unknown };
    if (typeof r.styles?.comment === "string") out.add(r.styles.comment);
    if (r.content !== undefined) threadsIn(r.content, out);
    if (r.rows !== undefined) threadsIn(r.rows, out);
    if ((r as { cells?: unknown }).cells !== undefined) threadsIn((r as { cells: unknown }).cells, out);
  }
  return out;
}

export function listComments(ctx: ApiCtx): unknown {
  const space = ctx.space();
  const q = params(ctx);
  const id = q.get("block_id") ?? "";
  if (!id) throw new InputError("block_id is required");
  const n = space.note(id);
  let out: Record<string, unknown>[];
  if (n && !n.synced) {
    out = (n.comments ?? []).filter((c) => !c.thread && !c.suggestion).map((c) => commentObject(c, n, null, ctx, space));
  } else {
    const hit = blockOr404(space, id);
    const threads = threadsIn(hit.block.content);
    // A suggested edit's own record is not a comment (Notion's API lists discussions only), nor is a still-open suggestion's thread.
    const pending = new Set((hit.note.comments ?? []).filter((c) => c.suggestion && !c.suggestion.state && c.thread).map((c) => c.thread as string));
    out = (hit.note.comments ?? []).filter((c) => c.thread && threads.has(c.thread) && !c.suggestion && !pending.has(c.thread)).map((c) => commentObject(c, hit.note, String(hit.block.id), ctx, space));
  }
  return paginate(out, q.get("start_cursor") ?? undefined, q.get("page_size") ?? undefined, "comment");
}

/** A comment's text from rich_text: plain text, people as "<@id>" tokens, pages by title. */
function commentText(v: unknown, space: Space): string {
  return (fromRichText(v) as { type?: string; text?: string; content?: { text?: string }[]; props?: Record<string, string> }[])
    .map((x) => {
      if (x.type === "text") return x.text ?? "";
      if (x.type === "link") return (x.content ?? []).map((c) => c.text ?? "").join("");
      if (x.type === "mention" && x.props?.userId) return `<@${x.props.userId}>`;
      if (x.type === "mention" && x.props?.noteId) return space.note(x.props.noteId)?.title ?? "";
      if (x.type === "mention" && x.props?.date) return x.props.date;
      if (x.type === "inlineEquation") return x.props?.latex ?? "";
      return "";
    })
    .join("")
    .slice(0, 8000);
}

export async function createComment(ctx: ApiCtx): Promise<unknown> {
  const body = await ctx.body();
  const space = ctx.space();
  const text = commentText(body.rich_text, space);
  if (!text.trim()) throw new InputError("rich_text should not be empty");
  let note: Note | null = null;
  let thread: string | undefined;
  let blockId: string | null = null;
  if (typeof body.discussion_id === "string" && body.discussion_id) {
    const d = body.discussion_id;
    for (const n of space.visible()) {
      const c = (n.comments ?? []).find((x) => !x.suggestion && (x.thread === d || x.id === d));
      if (c) {
        note = n;
        thread = c.thread;
        break;
      }
    }
    if (!note) throw notFound(`discussion with ID: ${d}`);
  } else {
    const parent = (body.parent ?? {}) as Record<string, unknown>;
    const id = typeof parent.page_id === "string" ? parent.page_id : "";
    if (!id) throw new InputError("parent.page_id or discussion_id is required");
    note = noteOr404(space, id);
  }
  const c = clone(note);
  const comment: NoteComment = { id: shortId(), text, at: Date.now(), author: ctx.integration.name, ...(thread ? { thread } : {}) };
  c.comments = [...(c.comments ?? []), comment];
  await save(ctx, [c]);
  const stored = (space.notes.get(c.id)?.comments ?? []).find((x) => x.id === comment.id) ?? comment;
  if (thread) {
    const host = (space.notes.get(c.id)?.content as RawBlock[] | undefined) ?? [];
    const found = findThreadBlock(host, thread);
    blockId = found ? String(found.id) : null;
  }
  return commentObject(stored, space.notes.get(c.id) ?? c, blockId, ctx, space);
}

function findThreadBlock(list: RawBlock[], thread: string): RawBlock | null {
  for (const b of list) {
    if (threadsIn(b.content).has(thread)) return b;
    if (Array.isArray(b.children)) {
      const hit = findThreadBlock(b.children, thread);
      if (hit) return hit;
    }
  }
  return null;
}
