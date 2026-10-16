"use client";

// One database's live state and mutations, shared by its views, toolbar and
// row pages.

import { takeView } from "../block-link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotes } from "../context";
import { notesT, type NotesKey } from "@/lib/notes/i18n";
import { applyView, rowsOf, visibleProps, withoutProp, withProp, withView } from "@/lib/notes/db";
import { mergedSchema, sourceView, sourcesOf, splitSchema, viewSourceId } from "@/lib/notes/sources";
import { renamePropInFormula } from "@/lib/notes/formula";
import { uniqueIdFixes } from "@/lib/notes/compute";
import { COMPUTED_TYPES, isFilterGroup } from "@/lib/notes/types";
import { shortId } from "@/lib/notes/model";
import type { DbFilter, DbFilterGroup, DbProperty, DbSchema, DbView, Note, PropType, PropValue } from "@/lib/notes/types";
import { STATUS_OPTIONS } from "@/lib/notes/model";

/** A property still carrying a default name, in either UI language. */
const defaultName = (name: string, key: NotesKey) => name === notesT("ru", key) || name === notesT("en", key);

const VIEW_KEY = (id: string, scope?: string) => `nt-view-${id}${scope ? `:${scope}` : ""}`;

/**
 * `scope`: a linked view block's id. Its views live in the source database
 * but only that block shows them (Notion's "Linked view of database"). A
 * dashboard widget passes its dashboard's scope ("dash:<id>") and its own
 * view (`fixedViewId`).
 *
 * Data sources (lib/notes/sources.ts): the views are the database's
 * (`host`); the view shown names a data source (`db`), whose properties,
 * rows, templates and automations the rest works with. `schema` is that
 * source's schema with the database's views; `updateSchema` writes each
 * part where it lives.
 */
export function useDatabase(dbId: string, scope?: string, fixedViewId?: string) {
  const api = useNotes();
  const { store, snap, t, locale } = api;
  const host = snap.byId.get(dbId);
  const hostSchema: DbSchema | undefined = host?.db;
  const [viewId, setViewIdState] = useState<string>(() => {
    try {
      return localStorage.getItem(VIEW_KEY(dbId, scope)) ?? "";
    } catch {
      return "";
    }
  });
  const [search, setSearch] = useState("");
  const views = useMemo(() => (hostSchema?.views ?? []).filter((v) => (v.scope ?? "") === (scope ?? "")), [hostSchema, scope]);
  const view: DbView | undefined = fixedViewId ? views.find((v) => v.id === fixedViewId) : (views.find((v) => v.id === viewId) ?? views[0]);
  // The data source the view shows: the database's own, another one in it, or one linked from elsewhere.
  const srcId = viewSourceId(dbId, view);
  const own = srcId === dbId;
  const found = own ? host : snap.byId.get(srcId);
  const db = found?.kind === "database" && found.db && (own || !store.isTrashed(srcId)) ? found : undefined;
  /** The view names a data source this person cannot open here (no access, deleted, or in the trash). */
  const sourceMissing = Boolean(host?.db && !own && !db);
  const schema: DbSchema | undefined = useMemo(() => (hostSchema ? mergedSchema(hostSchema, db?.db, own) : undefined), [hostSchema, db?.db, own]);
  const sources = useMemo(() => (host?.db ? sourcesOf(host, snap.list, snap.byId, t("db.untitled")) : []), [host, snap.list, snap.byId, t]);
  // Without edit access to the database and its data source (their own levels: a share can open one,
  // a restriction can close it) nothing here changes: the server refuses it.
  const readOnly = !api.canEdit(dbId) || (!own && !api.canEdit(srcId));
  const allRows = useMemo(() => (db ? rowsOf(srcId, snap.list, { byId: snap.byId, locale }) : []), [db, srcId, snap.list, snap.byId, locale]);
  const rows = useMemo(() => (schema && view ? applyView(allRows, view, schema, search, locale) : allRows), [allRows, schema, view, search, locale]);
  const props = useMemo(() => (schema && view ? visibleProps(schema, view) : []), [schema, view]);

  const setViewId = useCallback(
    (id: string) => {
      setViewIdState(id);
      try {
        localStorage.setItem(VIEW_KEY(dbId, scope), id);
      } catch {
        // ignore
      }
    },
    [dbId, scope, setViewIdState]
  );
  // A link to a view ("Copy link to view": …#<page>&v=<view id>) opens on it, once its views are here.
  useEffect(() => {
    if (fixedViewId) return;
    const v = takeView((id) => views.some((x) => x.id === id));
    if (v) setViewId(v);
  }, [views, fixedViewId, setViewId]);

  // Unique IDs: new, imported or duplicated rows get the next numbers (trashed rows keep theirs).
  const idProps = useMemo(() => (schema?.properties ?? []).filter((p) => p.type === "unique_id"), [schema]);
  useEffect(() => {
    if (!idProps.length || !db || readOnly) return;
    const all = snap.list.filter((n) => n.parentId === srcId && !n.template && n.kind === "page");
    for (const p of idProps) {
      for (const fix of uniqueIdFixes(all, p)) {
        const cur = store.get(fix.id);
        if (cur) store.update(fix.id, { props: { ...(cur.props ?? {}), [p.id]: fix.n } }, { quiet: true });
      }
    }
  }, [idProps, db, srcId, snap.list, store, readOnly]);

  const updateSchema = useCallback(
    (fn: (s: DbSchema) => DbSchema) => {
      const cur = store.get(dbId);
      if (!cur?.db || readOnly) return;
      if (srcId === dbId) {
        store.update(dbId, { db: fn(cur.db) });
        return;
      }
      const src = store.get(srcId);
      if (!src?.db) return;
      // Views go to the database, properties (and the rest) to the data source.
      const parts = splitSchema(cur.db, src.db, fn({ ...src.db, views: cur.db.views }));
      if (parts.source) store.update(srcId, { db: parts.source });
      if (parts.views) store.update(dbId, { db: { ...cur.db, views: parts.views } });
    },
    [dbId, srcId, store, readOnly]
  );

  // A linked view block gets its first view on first show (and again if its
  // views were deleted elsewhere).
  useEffect(() => {
    // Dashboard widgets are made by their dashboard, never here.
    if (!scope || scope.startsWith("dash:") || !schema || views.length) return;
    updateSchema((s) => (s.views.some((v) => v.scope === scope) ? s : { ...s, views: [...s.views, { ...sourceView("table", t("db.table"), dbId, srcId, s), scope }] }));
  }, [scope, schema, views.length, updateSchema, t, dbId, srcId]);

  // Rows open where the view says (Notion's "Open pages in").
  const openIn = view?.openIn;
  const openRow = useCallback((id: string) => (openIn === "full" ? api.open(id) : api.open(id, { peek: openIn === "center" ? "center" : true })), [api, openIn]);

  /** The database's views (they live there whichever data source they show; a view whose source is out of reach still changes). */
  const updateViews = useCallback(
    (fn: (views: DbView[]) => DbView[]) => {
      const cur = store.get(dbId);
      if (!cur?.db || !api.canEdit(dbId)) return;
      store.update(dbId, { db: { ...cur.db, views: fn(cur.db.views) } });
    },
    [api, dbId, store]
  );
  const updateView = useCallback((patch: Partial<DbView>) => view && updateViews((vs) => withView({ properties: [], views: vs }, view.id, patch).views), [updateViews, view]);
  const updateProp = useCallback(
    (propId: string, patch: Partial<DbProperty>) =>
      updateSchema((s) => {
        const old = s.properties.find((p) => p.id === propId);
        let next = withProp(s, propId, patch);
        // A deleted option leaves no filter or hidden board column pointing at it.
        const gone = new Set((old?.options ?? []).map((o) => o.id).filter((id) => patch.options && !patch.options.some((o) => o.id === id)));
        if (gone.size) {
          const keep = (f: DbFilter) => !(f.prop === propId && f.value !== undefined && gone.has(f.value));
          const prune = (g: DbFilterGroup): DbFilterGroup => ({ ...g, items: g.items.filter((x) => isFilterGroup(x) || keep(x)).map((x) => (isFilterGroup(x) ? prune(x) : x)) });
          next = {
            ...next,
            views: next.views.map((v) => {
              const hidden = v.hiddenGroups?.filter((k) => !gone.has(k));
              return { ...v, filters: v.filters.filter(keep), ...(v.filterGroup ? { filterGroup: prune(v.filterGroup) } : {}), hiddenGroups: hidden?.length ? hidden : undefined };
            }),
          };
        }
        // Formulas follow a renamed property (Notion keeps them working).
        if (old && patch.name !== undefined && patch.name !== old.name) {
          next = {
            ...next,
            properties: next.properties.map((p) => (p.type === "formula" && p.formula ? { ...p, formula: { expr: renamePropInFormula(p.formula.expr, old.name, patch.name as string) } } : p)),
          };
        }
        return next;
      }),
    [updateSchema]
  );

  /** Links a row to pages of the related database; two-way relations update the other side. */
  const setRelation = useCallback(
    (rowId: string, prop: DbProperty, ids: string[]) => {
      const cur = store.get(rowId);
      if (!cur || readOnly) return;
      const before = Array.isArray(cur.props?.[prop.id]) ? (cur.props?.[prop.id] as string[]) : [];
      const next = [...new Set(ids)];
      store.update(rowId, { props: { ...(cur.props ?? {}), [prop.id]: next } });
      const sync = prop.relation?.syncedPropId;
      const target = prop.relation?.dbId;
      if (!sync || !target) return;
      const touch = (id: string, add: boolean) => {
        const other = store.get(id);
        if (!other || other.parentId !== target) return;
        const list = Array.isArray(other.props?.[sync]) ? (other.props?.[sync] as string[]) : [];
        if (add === list.includes(rowId)) return;
        store.update(id, { props: { ...(other.props ?? {}), [sync]: add ? [...list, rowId] : list.filter((x) => x !== rowId) } }, { quiet: true });
      };
      for (const id of next) if (!before.includes(id)) touch(id, true);
      for (const id of before) if (!next.includes(id)) touch(id, false);
    },
    [store, readOnly]
  );

  const setValue = useCallback(
    (row: Note, prop: DbProperty, value: PropValue) => {
      // Column permissions: the server keeps such a value anyway; the cell does not pretend.
      if (readOnly || prop.denied) return;
      if (prop.type === "title") {
        store.update(row.id, { title: typeof value === "string" ? value : "" });
        return;
      }
      if (COMPUTED_TYPES.includes(prop.type)) return;
      if (prop.type === "relation") {
        setRelation(row.id, prop, Array.isArray(value) ? value : []);
        return;
      }
      const cur = store.get(row.id);
      if (!cur) return;
      store.update(row.id, { props: { ...(cur.props ?? {}), [prop.id]: value } });
    },
    [setRelation, store, readOnly]
  );

  /** Drops the "other side" link of a two-way relation (the mirror stays, one-way). */
  const unlinkMirror = useCallback(
    (prop: DbProperty) => {
      const rel = prop.relation;
      if (!rel?.syncedPropId || readOnly) return;
      const other = store.get(rel.dbId);
      if (!other?.db) return;
      const mirror = other.db.properties.find((p) => p.id === rel.syncedPropId);
      if (!mirror?.relation) return;
      store.update(rel.dbId, { db: withProp(other.db, mirror.id, { relation: { dbId: mirror.relation.dbId } }) });
    },
    [store, readOnly]
  );

  /** Points a relation at a database; two-way adds a mirror property there (filled from current links). */
  const linkRelation = useCallback(
    (propId: string, targetId: string, twoWay: boolean) => {
      const dbId = srcId;
      const prop = store.get(dbId)?.db?.properties.find((p) => p.id === propId);
      if (!prop || readOnly) return;
      const old = prop.relation;
      const sameTarget = old?.dbId === targetId;
      if (old?.syncedPropId && (!sameTarget || !twoWay)) unlinkMirror(prop);
      let syncedPropId = sameTarget && twoWay ? old?.syncedPropId : undefined;
      if (twoWay && !syncedPropId) {
        const target = store.get(targetId);
        if (target?.db) {
          syncedPropId = shortId();
          const name = (store.get(dbId)?.title || t("db.untitled")).slice(0, 100);
          const mirror: DbProperty = { id: syncedPropId, name: targetId === dbId ? `${prop.name} ↩` : name, type: "relation", relation: { dbId, syncedPropId: propId } };
          store.update(targetId, {
            db: { ...target.db, properties: [...target.db.properties, mirror], views: target.db.views.map((v) => (v.order ? { ...v, order: [...v.order, mirror.id] } : v)) },
          });
          // Existing links show on the other side right away.
          if (sameTarget) {
            for (const r of rowsOf(dbId, store.all())) {
              const ids = Array.isArray(r.props?.[propId]) ? (r.props?.[propId] as string[]) : [];
              for (const id of ids) {
                const o = store.get(id);
                if (!o || o.parentId !== targetId) continue;
                const list = Array.isArray(o.props?.[mirror.id]) ? (o.props?.[mirror.id] as string[]) : [];
                if (!list.includes(r.id)) store.update(id, { props: { ...(o.props ?? {}), [mirror.id]: [...list, r.id] } }, { quiet: true });
              }
            }
          }
        }
      }
      const cur = store.get(dbId)?.db;
      if (!cur) return;
      store.update(dbId, { db: withProp(cur, propId, { relation: { dbId: targetId, ...(syncedPropId ? { syncedPropId } : {}) } }) });
      // Links to another database's pages make no sense after a switch.
      if (old && !sameTarget) {
        for (const r of rowsOf(dbId, store.all())) {
          if (r.props?.[propId] === undefined) continue;
          const { [propId]: _drop, ...rest } = r.props ?? {};
          void _drop;
          store.update(r.id, { props: rest }, { quiet: true });
        }
      }
    },
    [srcId, store, t, unlinkMirror, readOnly]
  );

  const addProp = useCallback(
    (type: PropType = "text", opts?: { name?: string; afterId?: string; beforeId?: string }): DbProperty => {
      const id = shortId();
      const prop: DbProperty = { id, name: opts?.name ?? t(`prop.${type}` as never), type };
      if (type === "status") prop.options = STATUS_OPTIONS.map((o) => ({ ...o, name: t(`status.${o.id}` as never) }));
      if (type === "select" || type === "multi_select") prop.options = [];
      updateSchema((s) => {
        const list = [...s.properties];
        const anchor = opts?.afterId ?? opts?.beforeId;
        const i = anchor ? list.findIndex((p) => p.id === anchor) : -1;
        if (i >= 0) list.splice(opts?.afterId ? i + 1 : i, 0, prop);
        else list.push(prop);
        // Keep the new column visible in every view (and in place in this one).
        const views = s.views.map((v) => {
          if (!v.order) return v;
          const order = [...v.order];
          const j = anchor ? order.indexOf(anchor) : -1;
          if (j >= 0) order.splice(opts?.afterId ? j + 1 : j, 0, id);
          else order.push(id);
          return { ...v, order };
        });
        return { ...s, properties: list, views };
      });
      return prop;
    },
    [t, updateSchema]
  );

  const deleteProp = useCallback(
    (propId: string) => {
      const prop = store.get(srcId)?.db?.properties.find((p) => p.id === propId);
      if (prop?.type === "relation") unlinkMirror(prop);
      // The views of this data source let go of it (another source's views have properties of their own).
      updateSchema((s) => {
        const next = withoutProp(s, propId);
        return { ...next, views: s.views.map((v, i) => (viewSourceId(dbId, v) === srcId ? next.views[i] : v)) };
      });
    },
    [dbId, srcId, store, unlinkMirror, updateSchema]
  );

  /** Timeline dependencies: "Blocked by" ↔ "Blocking", a relation of the database to itself. */
  // The earlier pair is found by its default name in either language (the UI language may have changed since).
  const setDeps = useCallback(
    (on: boolean) => {
      const dbId = srcId;
      updateSchema((s) => {
        if (!on) return { ...s, deps: undefined };
        if (s.deps) return s;
        const old = s.properties.find((p) => p.type === "relation" && p.relation?.dbId === dbId && defaultName(p.name, "db.blockedBy") && s.properties.some((c) => c.id === p.relation?.syncedPropId));
        if (old?.relation?.syncedPropId) return { ...s, deps: { blockedBy: old.id, blocking: old.relation.syncedPropId } };
        const blockedBy = shortId();
        const blocking = shortId();
        const a: DbProperty = { id: blockedBy, name: t("db.blockedBy"), type: "relation", relation: { dbId, syncedPropId: blocking } };
        const b: DbProperty = { id: blocking, name: t("db.blocking"), type: "relation", relation: { dbId, syncedPropId: blockedBy } };
        return {
          ...s,
          properties: [...s.properties, a, b],
          views: s.views.map((v) => (v.order ? { ...v, order: [...v.order, blockedBy, blocking] } : v)),
          deps: { blockedBy, blocking },
        };
      });
    },
    [srcId, t, updateSchema]
  );

  /** Notion's sub-items: a parent ↔ sub-items relation of the database to itself. */
  const setSubItems = useCallback(
    (on: boolean) => {
      const dbId = srcId;
      updateSchema((s) => {
        if (!on) return { ...s, subItems: undefined };
        if (s.subItems) return s;
        // Turned off and on again: the earlier pair comes back.
        const old = s.properties.find((p) => p.type === "relation" && p.relation?.dbId === dbId && defaultName(p.name, "db.parentItem") && s.properties.some((c) => c.id === p.relation?.syncedPropId));
        if (old?.relation?.syncedPropId) return { ...s, subItems: { parentProp: old.id, childProp: old.relation.syncedPropId } };
        const parentProp = shortId();
        const childProp = shortId();
        const child: DbProperty = { id: childProp, name: t("db.subItemsProp"), type: "relation", relation: { dbId, syncedPropId: parentProp } };
        const parent: DbProperty = { id: parentProp, name: t("db.parentItem"), type: "relation", relation: { dbId, syncedPropId: childProp } };
        return {
          ...s,
          properties: [...s.properties, child, parent],
          views: s.views.map((v) => (v.order ? { ...v, order: [...v.order, childProp, parentProp] } : v)),
          subItems: { parentProp, childProp },
        };
      });
    },
    [srcId, t, updateSchema]
  );

  /** A new view (Notion's "New view"), of the data source picked (default: the one shown now). */
  const addView = useCallback(
    (type: DbView["type"], sourceId?: string) => {
      const cur = store.get(dbId);
      const target = sourceId ?? srcId;
      const tnote = target === dbId ? cur : store.get(target);
      if (!cur?.db || !tnote?.db || !api.canEdit(dbId)) return;
      const names: Record<DbView["type"], string> = { table: t("db.table"), board: t("db.board"), list: t("db.list"), gallery: t("db.gallery"), calendar: t("db.calendar"), timeline: t("db.timeline"), chart: t("db.chart"), form: t("db.form"), map: t("db.map"), dashboard: t("db.dashboard"), feed: t("db.feed") };
      let s: DbSchema = tnote.db;
      // A map needs a Place property (as boards need a status).
      if (type === "map" && !s.properties.some((p) => p.type === "place")) {
        s = { ...s, properties: [...s.properties, { id: shortId(), name: t("prop.place"), type: "place" }] };
      }
      // Boards need a select/status column, calendars a date column.
      if (type === "board" && !s.properties.some((p) => p.type === "status" || p.type === "select")) {
        s = { ...s, properties: [...s.properties, { id: shortId(), name: t("db.status"), type: "status", options: STATUS_OPTIONS.map((o) => ({ ...o, name: t(`status.${o.id}` as never) })) }] };
      }
      if ((type === "calendar" || type === "timeline") && !s.properties.some((p) => p.type === "date")) {
        s = { ...s, properties: [...s.properties, { id: shortId(), name: t("db.date"), type: "date" }] };
      }
      const v = sourceView(type, names[type], dbId, target, s);
      if (scope) v.scope = scope;
      // A property the layout needed goes to that data source (when this person may change it).
      if (s !== tnote.db && api.canEdit(target)) store.update(target, { db: target === dbId ? { ...s, views: cur.db.views } : s });
      const base = target === dbId && s !== tnote.db && api.canEdit(target) ? (store.get(dbId)?.db ?? cur.db) : cur.db;
      store.update(dbId, { db: { ...base, views: [...base.views, v] } });
      setViewId(v.id);
    },
    [api, dbId, srcId, scope, setViewId, store, t]
  );

  // New rows start from the default template, if any ("blank": an empty page).
  const addRow = useCallback(
    (opts?: { props?: Note["props"]; title?: string; stay?: boolean; first?: boolean; blank?: boolean }) => {
      const { blank, ...rest } = opts ?? {};
      // The view's own default template wins over the data source's (Notion: "For this view" / "For all views").
      const pick = (id: string | undefined) => {
        const found = id ? store.get(id) : undefined;
        return found && found.template && found.parentId === srcId && !store.isTrashed(found.id) ? found : undefined;
      };
      const tpl = blank ? undefined : (pick(view?.template) ?? pick(schema?.defaultTemplate));
      let o = rest;
      if (tpl) {
        // Unique IDs are numbered afresh; values given here win over the template's.
        const props = Object.fromEntries(Object.entries(tpl.props ?? {}).filter(([k]) => schema?.properties.find((p) => p.id === k)?.type !== "unique_id"));
        o = { ...rest, title: rest.title ?? tpl.title, props: { ...props, ...(rest.props ?? {}) } };
      }
      // Two-way relation links are set afterwards, so the linked pages list the new row too.
      const synced = (schema?.properties ?? []).filter((p) => p.type === "relation" && p.relation?.syncedPropId && Array.isArray(o.props?.[p.id]) && (o.props?.[p.id] as string[]).length);
      const links = synced.map((p) => [p, o.props?.[p.id] as string[]] as const);
      if (links.length) o = { ...o, props: Object.fromEntries(Object.entries(o.props ?? {}).filter(([k]) => !synced.some((p) => p.id === k))) };
      const r = api.newRow(srcId, { ...o, stay: true });
      if (tpl) store.update(r.id, { icon: tpl.icon, cover: tpl.cover, content: structuredClone(tpl.content) }, { quiet: true });
      for (const [p, ids] of links) setRelation(r.id, p, ids);
      if (opts?.stay === false) openRow(r.id);
      return r;
    },
    [api, srcId, openRow, schema, setRelation, store, view?.template]
  );

  // Notion's "Lock database": properties and views stay as they are; rows can still be edited.
  // zvena: viewers and commenters see databases locked.
  const locked = Boolean(host?.style?.locked) || api.readOnly;
  return { api, host, db, srcId, sources, sourceMissing, schema, views, scope, view, locked, readOnly, openRow, rows, allRows, props, search, setSearch, setViewId, updateSchema, updateViews, updateView, updateProp, setValue, setRelation, linkRelation, unlinkMirror, addProp, deleteProp, addView, addRow, setSubItems, setDeps };
}

export type DbCtl = ReturnType<typeof useDatabase>;
