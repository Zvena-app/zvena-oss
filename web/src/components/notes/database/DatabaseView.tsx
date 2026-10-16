"use client";

// A database (full page or inline in a page): view tabs, Filter / Sort /
// Search / view settings, the blue "New" button and the active layout.

import "./views.css";
import { useRef, useState } from "react";
import {
  ArrowUpDown,
  CalendarDays,
  GanttChart,
  ChartColumn,
  Rows3,
  ChevronDown,
  Eye,
  EyeOff,
  Filter,
  GalleryHorizontalEnd,
  KanbanSquare,
  LayoutGrid,
  List,
  Maximize2,
  MoreHorizontal,
  Plus,
  Search,
  Table2,
  Trash2,
  Copy,
  X,
  FileText,
  Pencil,
  ListTree,
  ClipboardList,
  Zap,
  ArrowUpRight,
  Star,
  Lock,
  Repeat,
  MessageSquare,
  Map as MapIcon,
  LayoutDashboard,
  Newspaper,
  MoveVertical,
  MapPin,
  Database,
  Palette,
  Link2,
} from "lucide-react";
import { useDatabase, type DbCtl } from "./useDatabase";
import { BoardView, CalendarView, GalleryView, ListView, TableView, groupLabels } from "./views";
import { TimelineView } from "./timeline";
import { ChartView } from "./chart";
import { FormView } from "./form";
import { MapView, mapProp } from "./map";
import { FeedView } from "./feed";
import { DashboardView } from "./dashboard";
import { AutomationsPanel, RepeatSetup, repeatIdOf } from "./automations";
import { PropIcon } from "./cells";
import { AdvancedFilter, DateRuleValue, OPS_BY_TYPE, VERIFY_STATES, countRules, dateValueLabel, defaultOp, isDateType, newRule, rulesLabel } from "./filters";
import { Menu, Popover, toast } from "../ui";
import { canGroupBy, groupRowsFor, isPeopleType, personText } from "@/lib/notes/db";
import { ME } from "@/lib/notes/people";
import { PersonChip, usePeople } from "../people";
import { useNotes } from "../context";
import { dashScope, defaultView, displayTitle, shortId } from "@/lib/notes/model";
import { copyView, withoutView } from "@/lib/notes/dbviews";
import { retargetView, viewSourceId } from "@/lib/notes/sources";
import { SourceIcon, SourcesPanel, addNewSource } from "./sources";
import { COLOR_LAYOUTS, ColorRulesPanel } from "./colors";
import type { DbFilter, DbProperty, DbView as DbViewT, Note, ViewType } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";

export function ViewIcon({ type, size = 16 }: { type: ViewType; size?: number }) {
  const s = { width: size, height: size };
  if (type === "board") return <KanbanSquare style={s} />;
  if (type === "list") return <List style={s} />;
  if (type === "gallery") return <GalleryHorizontalEnd style={s} />;
  if (type === "calendar") return <CalendarDays style={s} />;
  if (type === "timeline") return <GanttChart style={s} />;
  if (type === "chart") return <ChartColumn style={s} />;
  if (type === "form") return <ClipboardList style={s} />;
  if (type === "map") return <MapIcon style={s} />;
  if (type === "dashboard") return <LayoutDashboard style={s} />;
  if (type === "feed") return <Newspaper style={s} />;
  return <Table2 style={s} />;
}

/** A people filter's value: "Me" (whoever looks at the view) or a member. */
function PeopleFilterValue({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  const { t } = useNotes();
  const list = usePeople();
  return (
    <div style={{ maxHeight: 220, overflowY: "auto" }}>
      {[ME, ...list.map((p) => p.id)].map((id) => (
        <button type="button" key={id} className="nt-opt-row nt-btn-reset" style={{ width: "100%" }} onClick={() => onPick(id)}>
          <input type="checkbox" readOnly checked={value === id} className="nt-row-check" />
          {id === ME ? <span className="nt-person-name">{t("people.me")}</span> : <PersonChip id={id} />}
        </button>
      ))}
    </div>
  );
}

function FilterEditor({ ctl, filter, anchor, onClose }: { ctl: DbCtl; filter: DbFilter; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const prop = ctl.schema?.properties.find((p) => p.id === filter.prop);
  const [opMenu, setOpMenu] = useState<HTMLElement | null>(null);
  if (!prop || !ctl.view) return null;
  const update = (patch: Partial<DbFilter>) => ctl.updateView({ filters: ctl.view!.filters.map((f) => (f.id === filter.id ? { ...f, ...patch } : f)) });
  const remove = () => {
    ctl.updateView({ filters: ctl.view!.filters.filter((f) => f.id !== filter.id) });
    onClose();
  };
  const needsValue = !["empty", "not_empty", "checked", "unchecked"].includes(filter.op);
  const ops = OPS_BY_TYPE[prop.type] ?? OPS_BY_TYPE.text;
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div style={{ width: 300, padding: "8px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px 6px", fontSize: 12, color: "var(--nt-text-2)" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prop.name}</span>
          <button type="button" className="nt-db-tool nt-btn-reset" style={{ fontSize: 12, height: 22 }} onClick={(e) => setOpMenu(e.currentTarget)}>
            {t(`op.${filter.op}` as NotesKey)}
            <ChevronDown size={12} />
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("db.deleteFilter")} title={t("db.deleteFilter")} onClick={remove}>
            <Trash2 size={14} />
          </button>
        </div>
        {needsValue && (
          <div style={{ padding: "0 10px" }}>
            {isPeopleType(prop.type) ? (
              <PeopleFilterValue value={filter.value ?? ""} onPick={(id) => update({ value: filter.value === id ? "" : id })} />
            ) : prop.type === "verification" ? (
              <div>
                {VERIFY_STATES.map((s) => (
                  <button type="button" key={s} className="nt-opt-row nt-btn-reset" style={{ width: "100%" }} onClick={() => update({ value: filter.value === s ? "" : s })}>
                    <input type="checkbox" readOnly checked={filter.value === s} className="nt-row-check" />
                    <span>{t(`verify.${s}` as NotesKey)}</span>
                  </button>
                ))}
              </div>
            ) : prop.type === "select" || prop.type === "status" || prop.type === "multi_select" ? (
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {(prop.options ?? []).map((o) => (
                  <button type="button" key={o.id} className="nt-opt-row nt-btn-reset" style={{ width: "100%" }} onClick={() => update({ value: filter.value === o.id ? "" : o.id })}>
                    <input type="checkbox" readOnly checked={filter.value === o.id} className="nt-row-check" />
                    <span className="nt-tag" data-color={o.color}>
                      {o.name}
                    </span>
                  </button>
                ))}
              </div>
            ) : isDateType(prop.type) || filter.op === "within" ? (
              <DateRuleValue op={filter.op} value={filter.value ?? ""} onChange={(value) => update({ value })} className="nt-fsel" />
            ) : (
              <input
                className="nt-input"
                autoFocus
                type={prop.type === "number" ? "number" : "text"}
                placeholder={t("db.valuePlaceholder")}
                value={filter.value ?? ""}
                onChange={(e) => update({ value: e.target.value })}
              />
            )}
          </div>
        )}
      </div>
      {opMenu && (
        <Popover anchor={opMenu} onClose={() => setOpMenu(null)}>
          <Menu
            width={200}
            groups={[
              {
                key: "ops",
                items: ops.map((op) => ({
                  key: op,
                  label: t(`op.${op}` as NotesKey),
                  checked: filter.op === op,
                  // A range and a day are different values: switching between them starts afresh.
                  onSelect: () => (update(op === "within" || filter.op === "within" ? { op, value: "" } : { op }), setOpMenu(null)),
                })),
              },
            ]}
          />
        </Popover>
      )}
    </Popover>
  );
}

/** "New ▾": the database's page templates (Notion). */
function TemplatesMenu({ ctl, anchor, onClose }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void }) {
  const { t, snap, store } = ctl.api;
  const [more, setMore] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [repeat, setRepeat] = useState<{ id: string; el: HTMLElement } | null>(null);
  const db = ctl.db;
  if (!db) return null;
  // Repeating templates are scheduled automations: they run on the server (signed-in workspaces).
  const canRepeat = Boolean(ctl.api.user) && !ctl.readOnly;
  const repeats = (tplId: string) => (ctl.schema?.automations ?? []).some((a) => a.id === repeatIdOf(tplId) && a.on);
  const templates = snap.list.filter((n) => n.parentId === db.id && n.template && n.trashedAt === null).sort((a, b) => a.order - b.order);
  const fromTemplate = (tplId: string) => {
    const tpl = store.get(tplId);
    if (!tpl) return;
    // Unique IDs are numbered afresh; everything else is copied.
    const props = Object.fromEntries(Object.entries(tpl.props ?? {}).filter(([k]) => ctl.schema?.properties.find((p) => p.id === k)?.type !== "unique_id"));
    const r = ctl.addRow({ stay: true, first: true, title: tpl.title, props, blank: true });
    store.update(r.id, { icon: tpl.icon, cover: tpl.cover, content: structuredClone(tpl.content) });
    onClose();
    ctl.openRow(r.id);
  };
  const newTemplate = () => {
    const n = store.create({ kind: "page", parentId: db.id, template: true, title: "" });
    onClose();
    ctl.openRow(n.id);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end">
      <div className="nt-tplmenu">
        <div className="nt-menu-label">{t("db.templatesFor", { db: displayTitle(db, t("db.untitled")) })}</div>
        {templates.map((tpl) => (
          <div key={tpl.id} className="nt-mi nt-tplmenu-row" role="button" onClick={() => fromTemplate(tpl.id)}>
            <span className="nt-mi-icon">{tpl.icon || <FileText />}</span>
            <span className="nt-mi-label">{displayTitle(tpl, t("page.untitled"))}</span>
            {repeats(tpl.id) && <Repeat size={14} aria-label={t("auto.repeats")} style={{ color: "var(--nt-text-3)", flex: "none" }} />}
            {(ctl.view?.template === tpl.id || (!ctl.view?.template && ctl.schema?.defaultTemplate === tpl.id)) && <span className="nt-tplmenu-default">{t(ctl.view?.template === tpl.id ? "tpl.defaultView" : "db.defaultTemplate")}</span>}
            <button
              type="button"
              className="nt-item-act nt-btn-reset"
              aria-label={t("page.more")}
              onClick={(e) => {
                e.stopPropagation();
                setMore({ id: tpl.id, el: e.currentTarget });
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        ))}
        <div className="nt-mi" role="button" onClick={() => (ctl.addRow({ stay: false, first: true, blank: true }), onClose())}>
          <span className="nt-mi-icon">
            <FileText />
          </span>
          <span className="nt-mi-label">{t("db.emptyPage")}</span>
        </div>
        <div className="nt-tplmenu-sep" />
        <div className="nt-mi" role="button" onClick={newTemplate}>
          <span className="nt-mi-icon">
            <Plus />
          </span>
          <span className="nt-mi-label">{t("db.newTemplate")}</span>
        </div>
      </div>
      {more && (
        <Popover anchor={more.el} placement="right-start" onClose={() => setMore(null)}>
          <Menu
            width={200}
            onClose={() => setMore(null)}
            groups={[
              {
                key: "t",
                items: [
                  { key: "edit", label: t("db.editTemplate"), icon: <Pencil />, onSelect: () => (onClose(), ctl.openRow(more.id)) },
                  // Notion's "Set as default": for this view, or for all views of the data source.
                  ctl.view?.template === more.id
                    ? { key: "undefv", label: t("tpl.unsetForView"), icon: <Star />, onSelect: () => (ctl.updateView({ template: undefined }), setMore(null)) }
                    : { key: "defv", label: t("tpl.setForView"), icon: <Star />, onSelect: () => (ctl.updateView({ template: more.id }), setMore(null)) },
                  ctl.schema?.defaultTemplate === more.id
                    ? { key: "undef", label: t("db.unsetDefaultTemplate"), icon: <Star />, onSelect: () => (ctl.updateSchema((s) => ({ ...s, defaultTemplate: undefined })), setMore(null)) }
                    : { key: "def", label: t("tpl.setForAll"), icon: <Star />, onSelect: () => (ctl.updateSchema((s) => ({ ...s, defaultTemplate: more.id })), setMore(null)) },
                  ...(canRepeat
                    ? [{ key: "repeat", label: t("auto.repeat"), icon: <Repeat />, hint: repeats(more.id) ? t("auto.repeats") : undefined, submenu: true, onSelect: (el: HTMLElement) => (setRepeat({ id: more.id, el }), setMore(null)) }]
                    : []),
                  { key: "dup", label: t("menu.duplicate"), icon: <Copy />, onSelect: () => (ctl.api.duplicate(more.id), setMore(null)) },
                  { key: "del", label: t("menu.delete"), icon: <Trash2 />, danger: true, onSelect: () => (ctl.api.trash(more.id), setMore(null)) },
                ],
              },
            ]}
          />
        </Popover>
      )}
      {repeat && snap.byId.get(repeat.id) && <RepeatSetup ctl={ctl} template={snap.byId.get(repeat.id) as Note} anchor={repeat.el} onClose={() => setRepeat(null)} />}
    </Popover>
  );
}

function PropPicker({ ctl, anchor, onPick, onClose, title, footer }: { ctl: DbCtl; anchor: HTMLElement; onPick: (p: DbProperty) => void; onClose: () => void; title: string; footer?: React.ReactNode }) {
  const [q, setQ] = useState("");
  // Buttons hold no values: nothing to filter or sort by.
  const list = (ctl.schema?.properties ?? []).filter((p) => p.type !== "button" && p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <Menu
        width={240}
        header={
          <div className="nt-menu-input-wrap">
            <input className="nt-input" autoFocus placeholder={title} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        }
        groups={[{ key: "p", items: list.map((p) => ({ key: p.id, label: p.name, icon: <PropIcon type={p.type} />, onSelect: () => onPick(p) })) }]}
        footer={footer}
      />
    </Popover>
  );
}

function SortEditor({ ctl, anchor, onClose }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const [pick, setPick] = useState<HTMLElement | null>(null);
  const sorts = ctl.view?.sorts ?? [];
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div style={{ width: 340, padding: "8px 0" }}>
        {sorts.map((s, i) => {
          const p = ctl.schema?.properties.find((x) => x.id === s.prop);
          return (
            <div key={`${s.prop}-${i}`} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 10px" }}>
              <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, fontSize: 14, overflow: "hidden" }}>
                {p && <PropIcon type={p.type} />}
                {p?.name ?? "—"}
              </span>
              <select
                className="nt-select"
                value={s.dir}
                onChange={(e) => ctl.updateView({ sorts: sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)) })}
              >
                <option value="asc">{t("db.sortAsc")}</option>
                <option value="desc">{t("db.sortDesc")}</option>
              </select>
              <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("db.deleteSort")} onClick={() => ctl.updateView({ sorts: sorts.filter((_, j) => j !== i) })}>
                <X size={14} />
              </button>
            </div>
          );
        })}
        <button type="button" className="nt-mi nt-btn-reset" onClick={(e) => setPick(e.currentTarget)}>
          <span className="nt-mi-icon">
            <Plus />
          </span>
          <span className="nt-mi-label">{t("db.addSort")}</span>
        </button>
      </div>
      {pick && (
        <PropPicker
          ctl={ctl}
          anchor={pick}
          title={t("db.sort")}
          onClose={() => setPick(null)}
          onPick={(p) => {
            ctl.updateView({ sorts: [...sorts.filter((x) => x.prop !== p.id), { prop: p.id, dir: "asc" }] });
            setPick(null);
          }}
        />
      )}
    </Popover>
  );
}

/** Layouts a view can take: a dashboard's widget cannot be a dashboard (or a form) itself. */
const LAYOUTS: readonly ViewType[] = ["table", "board", "list", "gallery", "calendar", "timeline", "chart", "form", "map", "feed", "dashboard"];
const WIDGET_LAYOUTS: readonly ViewType[] = ["chart", "table", "board", "list", "gallery", "calendar", "timeline", "map", "feed"];

function ViewSettings({ ctl, anchor, onClose, onOpenFull, inline, widget }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void; onOpenFull?: () => void; inline?: boolean; widget?: boolean }) {
  const { t } = ctl.api;
  const view = ctl.view as DbViewT;
  const [sub, setSub] = useState<{ kind: "layout" | "props" | "group" | "subgroup" | "date" | "enddate" | "preview" | "size" | "mapprop" | "mapheight" | "source" | "sources" | "colors"; el: HTMLElement } | null>(null);
  const srcId = viewSourceId(ctl.host?.id ?? "", view);
  const srcInfo = ctl.sources.find((x) => x.id === srcId);
  const [sub2, setSub2] = useState<{ kind: "openIn" | "limit"; el: HTMLElement } | null>(null);
  // The groups of the grouped property, for the group panel.
  const groupProp = view.groupBy ? ctl.schema?.properties.find((p) => p.id === view.groupBy) : undefined;
  const groupList =
    groupProp && (view.type === "board" || view.type === "table" || view.type === "list" || view.type === "gallery") && canGroupBy(groupProp)
      ? groupRowsFor(ctl.rows, groupProp, groupLabels(t, groupProp), ctl.api.locale, view)
      : [];
  const [name, setName] = useState(view.name);
  const commit = () => name.trim() && name !== view.name && ctl.updateView({ name: name.trim() });
  const close = () => {
    commit();
    onClose();
  };
  const layoutNames: Record<ViewType, NotesKey> = { table: "db.table", board: "db.board", list: "db.list", gallery: "db.gallery", calendar: "db.calendar", timeline: "db.timeline", chart: "db.chart", form: "db.form", map: "db.map", dashboard: "db.dashboard", feed: "db.feed" };
  const groups = [
    {
      key: "main",
      items: [
        { key: "layout", label: t("db.layout"), icon: <LayoutGrid />, hint: t(layoutNames[view.type]), submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "layout", el }) },
        // Notion (2025): the view's data source, and the database's data sources.
        ...(!widget || ctl.sources.length > 1
          ? [{ key: "source", label: t("src.source"), icon: <Database />, hint: srcInfo?.name ?? t("src.noAccess"), submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "source", el }) }]
          : []),
        { key: "props", label: t("db.properties"), icon: <Eye />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "props", el }) },
        ...(COLOR_LAYOUTS.includes(view.type) ? [{ key: "colors", label: t("ccolor.title"), icon: <Palette />, hint: view.colors?.length ? String(view.colors.length) : undefined, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "colors", el }) }] : []),
        ...(view.type === "board"
          ? [
              { key: "group", label: t("db.groupBy"), icon: <KanbanSquare />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "group", el }) },
              {
                key: "subgroup",
                label: t("db.subGroup"),
                icon: <Rows3 />,
                hint: ctl.schema?.properties.find((p) => p.id === view.subGroupBy)?.name ?? t("db.calcNone"),
                submenu: true,
                onSelect: (el: HTMLElement) => setSub({ kind: "subgroup", el }),
              },
            ]
          : []),
        ...(view.type === "table" || view.type === "list" || view.type === "gallery"
          ? [{ key: "group", label: t("db.group"), icon: <Rows3 />, hint: ctl.schema?.properties.find((p) => p.id === view.groupBy && canGroupBy(p))?.name ?? t("db.calcNone"), submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "group", el }) }]
          : []),
        ...(view.type === "calendar" ? [{ key: "date", label: t("db.calendarBy"), icon: <CalendarDays />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "date", el }) }] : []),
        ...(view.type === "timeline"
          ? [
              { key: "date", label: t("db.timelineBy"), icon: <GanttChart />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "date", el }) },
              {
                key: "enddate",
                label: t("tl.endBy"),
                icon: <CalendarDays />,
                hint: ctl.schema?.properties.find((p) => p.id === view.endProp)?.name ?? t("tl.sameProp"),
                submenu: true,
                onSelect: (el: HTMLElement) => setSub({ kind: "enddate", el }),
              },
            ]
          : []),
        ...(view.type === "map"
          ? [
              { key: "mapprop", label: t("map.by"), icon: <MapPin />, hint: mapProp(ctl)?.name ?? "", submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "mapprop", el }) },
              ...(widget ? [] : [{ key: "mapheight", label: t("map.height"), icon: <MoveVertical />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "mapheight", el }) }]),
            ]
          : []),
        ...(view.type === "feed"
          ? [
              { key: "feedcontent", label: t("feed.content"), icon: <FileText />, toggle: true, checked: !view.feed?.hideContent, onSelect: () => ctl.updateView({ feed: { ...view.feed, hideContent: view.feed?.hideContent ? undefined : true } }) },
              { key: "feedcomments", label: t("feed.comments"), icon: <MessageSquare />, toggle: true, checked: !view.feed?.hideComments, onSelect: () => ctl.updateView({ feed: { ...view.feed, hideComments: view.feed?.hideComments ? undefined : true } }) },
            ]
          : []),
        ...(view.type === "gallery" || view.type === "board"
          ? [
              { key: "preview", label: t("db.cardPreview"), icon: <GalleryHorizontalEnd />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "preview", el }) },
              { key: "size", label: t("db.cardSize"), icon: <LayoutGrid />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "size", el }) },
            ]
          : []),
        ...(view.type === "dashboard" ? [] : [{ key: "subitems", label: t("db.subItems"), icon: <ListTree />, toggle: true, checked: !!ctl.schema?.subItems, onSelect: () => ctl.setSubItems(!ctl.schema?.subItems) }]),
      ],
    },
    // A widget's own chrome removes or moves it; the dashboard keeps the rest.
    ...(widget ? [] : [{
      key: "view",
      items: [
        ...(inline && onOpenFull ? [{ key: "full", label: t("db.openAsPage"), icon: <Maximize2 />, onSelect: () => (onOpenFull(), close()) }] : []),
        {
          key: "lock",
          label: t("db.lock"),
          icon: <Lock />,
          onSelect: () => {
            // The lock is the database's (all its data sources and views).
            if (ctl.host) ctl.api.store.update(ctl.host.id, { style: { ...(ctl.host.style ?? {}), locked: true } }, { quiet: true });
            close();
          },
        },
        {
          key: "viewlink",
          label: t("db.copyViewLink"),
          icon: <Link2 />,
          onSelect: () => {
            // The page on screen, opened on this view (Notion's "Copy link to view").
            const u = new URL(location.href);
            u.hash = `${u.hash.replace(/^#/, "").replace(/[?&](v|b)=[^&]*/g, "")}&v=${view.id}`;
            void navigator.clipboard?.writeText(u.toString()).catch(() => undefined);
            toast(t("page.copyLinkDone"));
            close();
          },
        },
        {
          key: "dupview",
          label: t("db.duplicateView"),
          icon: <Copy />,
          onSelect: () => {
            const copies = copyView(ctl.host?.db?.views ?? [], view, `${view.name} 2`);
            ctl.updateViews((vs) => [...vs, ...copies]);
            ctl.setViewId(copies[0].id);
            close();
          },
        },
        ...(ctl.views.length > 1
          ? [
              {
                key: "delview",
                label: t("db.deleteView"),
                icon: <Trash2 />,
                danger: true,
                onSelect: () => {
                  ctl.updateViews((vs) => withoutView(vs, view.id));
                  onClose();
                },
              },
            ]
          : []),
      ],
    }]),
  ];
  const props = ctl.schema?.properties ?? [];
  return (
    <Popover anchor={anchor} onClose={close} placement="bottom-end">
      <Menu
        width={280}
        header={
          <div className="nt-menu-input-wrap" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 6, boxShadow: "inset 0 0 0 1px var(--nt-border-2)", color: "var(--nt-text-2)", flex: "none" }}>
              <ViewIcon type={view.type} />
            </span>
            <input className="nt-input" value={name} placeholder={t("db.viewName")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && close()} />
          </div>
        }
        groups={groups}
      />
      {sub?.kind === "layout" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={260}
            groups={[
              {
                key: "l",
                items: (widget ? WIDGET_LAYOUTS : LAYOUTS).map((type) => ({
                  key: type,
                  label: t(layoutNames[type]),
                  icon: <ViewIcon type={type} />,
                  checked: view.type === type,
                  onSelect: () => {
                    const patch: Partial<DbViewT> = { type };
                    if (type === "board" && !view.groupBy) patch.groupBy = props.find((p) => p.type === "status" || p.type === "select")?.id;
                    if ((type === "calendar" || type === "timeline") && !view.dateProp) patch.dateProp = props.find((p) => p.type === "date")?.id;
                    if (type === "timeline" && !view.zoom) patch.zoom = "month";
                    if (type === "form" && !view.form) patch.form = defaultView("form", "", ctl.schema ?? undefined).form;
                    if (type === "map" && !view.map?.prop) patch.map = { ...view.map, prop: props.find((p) => p.type === "place")?.id };
                    if (type === "dashboard" && !view.dashboard) patch.dashboard = { widgets: [] };
                    ctl.updateView(patch);
                  },
                })),
              },
              // The chosen layout's options, as in Notion's Layout panel.
              {
                key: "opts",
                items: [
                  ...(inline ? [{ key: "title", label: t("db.showTitle"), toggle: true, checked: !view.hideTitle, onSelect: () => ctl.updateView({ hideTitle: view.hideTitle ? undefined : true }) }] : []),
                  ...(view.type === "table" ? [{ key: "lines", label: t("db.showLines"), toggle: true, checked: !view.noLines, onSelect: () => ctl.updateView({ noLines: view.noLines ? undefined : true }) }] : []),
                  ...(view.type === "board" ? [{ key: "colors", label: t("db.colorCols"), toggle: true, checked: !view.plainCols, onSelect: () => ctl.updateView({ plainCols: view.plainCols ? undefined : true }) }] : []),
                  ...(view.type === "calendar" ? [{ key: "weekends", label: t("db.showWeekends"), toggle: true, checked: !view.noWeekends, onSelect: () => ctl.updateView({ noWeekends: view.noWeekends ? undefined : true }) }] : []),
                  ...(view.type !== "chart" && view.type !== "form" && view.type !== "dashboard"
                    ? [{ key: "icons", label: t("db.showIcons"), toggle: true, checked: !view.hideIcons, onSelect: () => ctl.updateView({ hideIcons: view.hideIcons ? undefined : true }) }]
                    : []),
                  ...(view.type === "gallery" || view.type === "board"
                    ? [{ key: "fit", label: t("db.fitImage"), toggle: true, checked: Boolean(view.fitImage), onSelect: () => ctl.updateView({ fitImage: view.fitImage ? undefined : true }) }]
                    : []),
                  ...(view.type === "table" ? [{ key: "wrap", label: t("db.wrapAll"), toggle: true, checked: Boolean(view.wrap), onSelect: () => ctl.updateView({ wrap: view.wrap ? undefined : true }) }] : []),
                  ...(view.type !== "chart" && view.type !== "form" && view.type !== "dashboard"
                    ? [
                        {
                          key: "openIn",
                          label: t("db.openIn"),
                          hint: t(view.openIn === "center" ? "db.openCenter" : view.openIn === "full" ? "db.openFull" : "db.openSide"),
                          submenu: true,
                          onSelect: (el: HTMLElement) => setSub2({ kind: "openIn", el }),
                        },
                      ]
                    : []),
                  ...(view.type === "table" || view.type === "list" || view.type === "feed"
                    ? [{ key: "limit", label: t("db.loadLimit"), hint: String(view.limit ?? (view.type === "feed" ? 25 : 50)), submenu: true, onSelect: (el: HTMLElement) => setSub2({ kind: "limit", el }) }]
                    : []),
                ],
              },
            ]}
          />
          {sub2 && (
            <Popover anchor={sub2.el} placement="left-start" onClose={() => setSub2(null)}>
              <Menu
                width={sub2.kind === "openIn" ? 220 : 160}
                groups={[
                  {
                    key: sub2.kind,
                    items:
                      sub2.kind === "openIn"
                        ? (
                            [
                              [undefined, "db.openSide"],
                              ["center", "db.openCenter"],
                              ["full", "db.openFull"],
                            ] as const
                          ).map(([k, label]) => ({ key: label, label: t(label), checked: view.openIn === k, onSelect: () => (ctl.updateView({ openIn: k }), setSub2(null)) }))
                        : ([10, 25, 50, 100] as const).map((n) => ({
                            key: String(n),
                            label: t("db.loadLimitN", { n }),
                            checked: (view.limit ?? 50) === n,
                            onSelect: () => (ctl.updateView({ limit: n === 50 ? undefined : n }), setSub2(null)),
                          })),
                  },
                ]}
              />
            </Popover>
          )}
        </Popover>
      )}
      {sub?.kind === "source" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={260}
            groups={[
              {
                key: "src",
                label: t("src.source"),
                items: ctl.sources.map((x) => ({
                  key: x.id,
                  label: x.note ? x.name : t("src.noAccess"),
                  icon: <SourceIcon icon={x.icon} />,
                  checked: x.id === srcId,
                  disabled: !x.note || !x.note.db,
                  onSelect: () => {
                    if (x.id !== srcId && x.note?.db && ctl.host) ctl.updateView(retargetView(view, ctl.host.id, x.id, x.note.db));
                    setSub(null);
                  },
                })),
              },
              ...(widget
                ? []
                : [{ key: "manage", items: [{ key: "manage", label: t("src.manage"), icon: <Database />, onSelect: () => setSub({ kind: "sources", el: sub.el }) }] }]),
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "sources" && <SourcesPanel ctl={ctl} anchor={sub.el} onClose={() => setSub(null)} />}
      {sub?.kind === "colors" && <ColorRulesPanel ctl={ctl} anchor={sub.el} onClose={() => setSub(null)} />}
      {sub?.kind === "props" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={260}
            groups={[
              {
                key: "p",
                label: t("db.properties"),
                items: props.map((p) => {
                  const hidden = view.hidden.includes(p.id);
                  return {
                    key: p.id,
                    label: p.name,
                    icon: <PropIcon type={p.type} />,
                    hint: p.type === "title" ? "" : hidden ? <EyeOff size={14} /> : <Eye size={14} />,
                    disabled: p.type === "title",
                    onSelect: () => ctl.updateView({ hidden: hidden ? view.hidden.filter((h) => h !== p.id) : [...view.hidden, p.id] }),
                  };
                }),
              },
              {
                key: "all",
                items: [
                  { key: "show", label: t("db.showAll"), onSelect: () => ctl.updateView({ hidden: [] }) },
                  { key: "hide", label: t("db.hideAll"), onSelect: () => ctl.updateView({ hidden: props.filter((p) => p.type !== "title").map((p) => p.id) }) },
                ],
              },
            ]}
          />
        </Popover>
      )}
      {(sub?.kind === "group" || sub?.kind === "date") && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "g",
                items: [
                  // Tables and lists can drop grouping; boards always group.
                  ...(sub.kind === "group" && view.type !== "board" ? [{ key: "__none", label: t("db.calcNone"), checked: !view.groupBy, onSelect: () => (ctl.updateView({ groupBy: undefined }), setSub(null)) }] : []),
                  ...props
                    .filter((p) => (sub.kind === "group" ? (view.type === "board" ? p.type === "status" || p.type === "select" || p.type === "multi_select" || p.type === "person" : canGroupBy(p)) : p.type === "date"))
                    .map((p) => ({
                      key: p.id,
                      label: p.name,
                      icon: <PropIcon type={p.type} />,
                      checked: (sub.kind === "group" ? view.groupBy : view.dateProp) === p.id,
                      onSelect: () => (ctl.updateView(sub.kind === "group" ? (view.groupBy === p.id ? {} : { groupBy: p.id, hiddenGroups: undefined }) : { dateProp: p.id }), setSub(null)),
                    })),
                ],
              },
              // Notion's group options: dates by relative / day / week / month / year, and the order of the groups.
              ...(sub.kind === "group" && groupProp && !["select", "status", "multi_select", "checkbox"].includes(groupProp.type)
                ? [
                    {
                      key: "gopts",
                      label: t("grp.options"),
                      items: [
                        ...(["date", "created_time", "last_edited_time"].includes(groupProp.type) || (groupProp.type === "formula" && view.groupDate)
                          ? (["relative", "day", "week", "month", "year"] as const).map((g) => ({
                              key: `gd-${g}`,
                              label: t(`grp.by.${g}` as NotesKey),
                              checked: (view.groupDate ?? "month") === g,
                              onSelect: () => ctl.updateView({ groupDate: g === "month" ? undefined : g, hiddenGroups: undefined }),
                            }))
                          : []),
                        {
                          key: "gorder",
                          label: t(["date", "created_time", "last_edited_time"].includes(groupProp.type) ? (view.groupOrder === "desc" ? "grp.newest" : "grp.oldest") : view.groupOrder === "desc" ? "grp.za" : "grp.az"),
                          icon: <ArrowUpDown />,
                          onSelect: () => ctl.updateView({ groupOrder: view.groupOrder === "desc" ? undefined : "desc" }),
                        },
                      ],
                    },
                  ]
                : []),
              // Notion's group panel: hide empty groups, show / hide each group.
              ...(sub.kind === "group" && groupList.length
                ? [
                    {
                      key: "vis",
                      label: t("db.groups"),
                      items: [
                        { key: "__empty", label: t("db.hideEmpty"), toggle: true, checked: Boolean(view.hideEmpty), onSelect: () => ctl.updateView({ hideEmpty: view.hideEmpty ? undefined : true }) },
                        ...groupList.map((g) => {
                          const hidden = (view.hiddenGroups ?? []).includes(g.key);
                          return {
                            key: `g-${g.key}`,
                            label: g.label,
                            icon: g.option ? <span className="nt-group-dot" data-color={g.option.color} /> : undefined,
                            hint: hidden ? <EyeOff size={14} /> : <Eye size={14} />,
                            onSelect: () => {
                              const cur = view.hiddenGroups ?? [];
                              const next = hidden ? cur.filter((k) => k !== g.key) : [...cur, g.key];
                              ctl.updateView({ hiddenGroups: next.length ? next : undefined });
                            },
                          };
                        }),
                      ],
                    },
                  ]
                : []),
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "enddate" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={260}
            groups={[
              {
                key: "e",
                items: [
                  { key: "__same", label: t("tl.sameProp"), checked: !view.endProp, onSelect: () => (ctl.updateView({ endProp: undefined }), setSub(null)) },
                  ...props
                    .filter((p) => p.type === "date" && p.id !== view.dateProp)
                    .map((p) => ({ key: p.id, label: p.name, icon: <PropIcon type={p.type} />, checked: view.endProp === p.id, onSelect: () => (ctl.updateView({ endProp: p.id }), setSub(null)) })),
                ],
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "subgroup" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "sg",
                items: [
                  { key: "__none", label: t("db.calcNone"), checked: !view.subGroupBy, onSelect: () => (ctl.updateView({ subGroupBy: undefined }), setSub(null)) },
                  ...props
                    .filter((p) => canGroupBy(p) && p.id !== view.groupBy)
                    .map((p) => ({ key: p.id, label: p.name, icon: <PropIcon type={p.type} />, checked: view.subGroupBy === p.id, onSelect: () => (ctl.updateView({ subGroupBy: p.id }), setSub(null)) })),
                ],
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "mapprop" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "mp",
                items: [
                  ...props
                    .filter((p) => p.type === "place")
                    .map((p) => ({ key: p.id, label: p.name, icon: <PropIcon type={p.type} />, checked: mapProp(ctl)?.id === p.id, onSelect: () => (ctl.updateView({ map: { ...view.map, prop: p.id } }), setSub(null)) })),
                  {
                    key: "__new",
                    label: t("map.addPlace"),
                    icon: <Plus />,
                    onSelect: () => {
                      const p = ctl.addProp("place");
                      ctl.updateView({ map: { ...view.map, prop: p.id } });
                      setSub(null);
                    },
                  },
                ],
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "mapheight" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={200}
            groups={[
              {
                key: "mh",
                items: (
                  [
                    [320, "db.small"],
                    [480, "db.medium"],
                    [720, "db.large"],
                  ] as const
                ).map(([h, label]) => ({ key: label, label: t(label), checked: (view.map?.height ?? 480) === h, onSelect: () => (ctl.updateView({ map: { ...view.map, height: h === 480 ? undefined : h } }), setSub(null)) })),
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "preview" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={220}
            groups={[
              {
                key: "pv",
                items: (
                  [
                    ["none", "db.none"],
                    ["cover", "db.pageCover"],
                    ["content", "db.pageContent"],
                  ] as const
                ).map(([k, label]) => ({ key: k, label: t(label), checked: (view.preview ?? (view.type === "board" ? "none" : "content")) === k, onSelect: () => (ctl.updateView({ preview: k }), setSub(null)) })),
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "size" && (
        <Popover anchor={sub.el} placement="left-start" onClose={() => setSub(null)}>
          <Menu
            width={200}
            groups={[
              {
                key: "sz",
                items: (
                  [
                    ["small", "db.small"],
                    ["medium", "db.medium"],
                    ["large", "db.large"],
                  ] as const
                ).map(([k, label]) => ({ key: k, label: t(label), checked: (view.cardSize ?? "medium") === k, onSelect: () => (ctl.updateView({ cardSize: k }), setSub(null)) })),
              },
            ]}
          />
        </Popover>
      )}
    </Popover>
  );
}

export function DatabaseView({
  dbId,
  inline,
  scope,
  widgetViewId,
}: {
  dbId: string;
  inline?: boolean;
  /** A linked view block's id, or a dashboard's widget scope ("dash:<id>"). */
  scope?: string;
  /** A dashboard widget: this one view, without tabs or title. */
  widgetViewId?: string;
}) {
  const ctl = useDatabase(dbId, scope, widgetViewId);
  const widget = Boolean(widgetViewId);
  const { t } = ctl.api;
  const [pop, setPop] = useState<{ kind: "filter" | "sort" | "settings" | "addview" | "filterprop" | "advfilter" | "viewtab" | "auto" | "sources"; el: HTMLElement; id?: string } | null>(null);
  // "New view": the data source it shows (Notion asks when there are several).
  const [newViewSource, setNewViewSource] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tplMenu, setTplMenu] = useState<HTMLElement | null>(null);
  const [title, setTitle] = useState(ctl.db?.title ?? "");
  const searchInput = useRef<HTMLInputElement>(null);

  // The title field is a draft of the saved title; follow outside renames.
  const [seenTitle, setSeenTitle] = useState(ctl.db?.title);
  if (seenTitle !== ctl.db?.title) {
    setSeenTitle(ctl.db?.title);
    setTitle(ctl.db?.title ?? "");
  }

  // A linked view of a database that went to the trash shows a note instead.
  if (!ctl.host?.db || (!ctl.sourceMissing && (!ctl.db || !ctl.schema)) || (scope && ctl.api.store.isTrashed(dbId))) {
    return <div className="nt-panel-empty">{t(scope ? "db.linkedGone" : "page.deletedPage")}</div>;
  }
  // A new linked view: its first view is being added.
  if (!ctl.view) return null;
  const view = ctl.view;
  const views = ctl.views;
  // Notion keeps a few view tabs visible and folds the rest into "N more…" (fewer when tabs also name their source).
  const named = ctl.sources.length > 1 || views.some((v) => viewSourceId(dbId, v) !== dbId);
  const maxTabs = (inline ? 3 : 4) - (named ? 1 : 0);
  const shownViews = views.length <= maxTabs ? views : [...views.slice(0, maxTabs - 1).filter((v) => v.id !== view.id), view].slice(0, maxTabs);
  const ordered = views.filter((v) => shownViews.includes(v));
  const hiddenViews = views.filter((v) => !shownViews.includes(v));
  const filters = view.filters;
  const advRules = countRules(view.filterGroup);

  // Dashboards hold views; they have no rows of their own to filter, search or add.
  const rowsView = view.type !== "form" && view.type !== "dashboard" && !ctl.sourceMissing;
  // Several data sources: each tab says which one it shows.
  const several = named;
  const sourceOf = (v: DbViewT) => ctl.sources.find((x) => x.id === viewSourceId(dbId, v));
  const pickedSource = newViewSource && ctl.sources.some((x) => x.id === newViewSource && x.note) ? newViewSource : ctl.srcId;
  return (
    <div className="nt-db" data-widget={widget || undefined}>
      {inline && !widget && !view.hideTitle && (
        <div className="nt-db-titlebar">
          {scope && (
            <span className="nt-db-linked" title={t("db.linkedHint")} aria-label={t("db.linkedHint")}>
              <ArrowUpRight />
            </span>
          )}
          <input
            className="nt-db-title"
            value={title}
            readOnly={ctl.readOnly}
            placeholder={t("db.untitled")}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== ctl.db?.title && ctl.api.store.update(dbId, { title })}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <button type="button" className="nt-db-tool nt-btn-reset" title={t("db.openAsPage")} aria-label={t("db.openAsPage")} onClick={() => ctl.api.open(dbId)}>
            <Maximize2 />
          </button>
        </div>
      )}
      <div className="nt-db-bar">
        {!widget && (
        <div className="nt-db-tabs">
          {/* Only the tabs are in the tablist; "more" and "+" sit beside it (display: contents keeps the row). */}
          <div role="tablist" style={{ display: "contents" }}>
          {ordered.map((v) => (
            <button
              type="button"
              key={v.id}
              role="tab"
              className="nt-db-tab nt-btn-reset"
              data-active={v.id === view.id || undefined}
              aria-selected={v.id === view.id}
              onClick={(e) => (v.id !== view.id ? ctl.setViewId(v.id) : !ctl.locked && setPop({ kind: "settings", el: e.currentTarget }))}
            >
              <ViewIcon type={v.type} />
              {v.name || t(`db.${v.type}` as NotesKey)}
              {several && <span className="nt-db-tab-src">{sourceOf(v)?.note ? sourceOf(v)?.name : t("src.noAccess")}</span>}
            </button>
          ))}
          </div>
          {hiddenViews.length > 0 && (
            <button type="button" className="nt-db-tab nt-btn-reset" onClick={(e) => setPop({ kind: "viewtab", el: e.currentTarget })}>
              {t("db.moreViews", { n: hiddenViews.length })}
            </button>
          )}
          {!ctl.locked && (
            <button type="button" className="nt-db-tool nt-btn-reset" aria-label={t("db.addView")} title={t("db.addView")} onClick={(e) => setPop({ kind: "addview", el: e.currentTarget })}>
              <Plus />
            </button>
          )}
        </div>
        )}
        <div className="nt-db-tools">
          {rowsView && (
            <>
            {/* Filters and sorts are saved in the shared view: read-only members cannot change them. */}
            {!ctl.readOnly && (
              <>
                <button type="button" className="nt-db-tool nt-btn-reset" data-on={filters.length + advRules > 0 || undefined} onClick={(e) => setPop({ kind: "filterprop", el: e.currentTarget })} title={t("db.filter")}>
                  <Filter />
                  <span className="nt-hide-mobile">{t("db.filter")}</span>
                </button>
                <button type="button" className="nt-db-tool nt-btn-reset" data-on={view.sorts.length > 0 || undefined} onClick={(e) => setPop({ kind: "sort", el: e.currentTarget })} title={t("db.sort")}>
                  <ArrowUpDown />
                  <span className="nt-hide-mobile">{t("db.sort")}</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="nt-db-tool nt-btn-reset"
              aria-label={t("db.search")}
              onClick={() => {
                setSearchOpen(true);
                setTimeout(() => searchInput.current?.focus(), 0);
              }}
            >
              <Search />
            </button>
            <input
              ref={searchInput}
              className="nt-db-search"
              data-open={searchOpen || ctl.search ? "true" : "false"}
              placeholder={t("db.search")}
              value={ctl.search}
              onChange={(e) => ctl.setSearch(e.target.value)}
              onBlur={() => !ctl.search && setSearchOpen(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  ctl.setSearch("");
                  setSearchOpen(false);
                }
              }}
            />
            </>
          )}
          {ctl.sourceMissing ? null : ctl.locked ? (
            // Locked: a click unlocks, as in Notion.
            <button
              type="button"
              className="nt-db-tool nt-db-locked nt-btn-reset"
              title={ctl.readOnly ? undefined : t("db.lockedHint")}
              disabled={ctl.readOnly}
              onClick={() => !ctl.readOnly && ctl.host && ctl.api.store.update(ctl.host.id, { style: { ...(ctl.host.style ?? {}), locked: false } }, { quiet: true })}
            >
              <Lock />
              <span className="nt-hide-mobile">{t("db.locked")}</span>
            </button>
          ) : (
            <>
              {!widget && (
              <button
                type="button"
                className="nt-db-tool nt-btn-reset"
                data-on={(ctl.schema?.automations ?? []).some((a) => a.on) || undefined}
                aria-label={t("auto.title")}
                title={t("auto.title")}
                onClick={(e) => setPop({ kind: "auto", el: e.currentTarget })}
              >
                <Zap />
              </button>
              )}
              <button type="button" className="nt-db-tool nt-btn-reset" aria-label={t("db.layout")} onClick={(e) => setPop({ kind: "settings", el: e.currentTarget })}>
                <MoreHorizontal />
              </button>
            </>
          )}
          {!ctl.readOnly && rowsView && !widget && (
            <span className="nt-db-new">
              <button
                type="button"
                className="nt-btn-reset"
                onClick={() => {
                  const r = ctl.addRow({ stay: true, first: true });
                  ctl.openRow(r.id);
                }}
              >
                {t("db.new")}
              </button>
              <button type="button" className="nt-btn-reset" aria-label={t("db.templates")} onClick={(e) => setTplMenu(e.currentTarget)}>
                <ChevronDown />
              </button>
            </span>
          )}
          {tplMenu && <TemplatesMenu ctl={ctl} anchor={tplMenu} onClose={() => setTplMenu(null)} />}
        </div>
      </div>
      {rowsView && (filters.length > 0 || advRules > 0 || view.sorts.length > 0) && (
        <div className="nt-db-filters">
          {view.sorts.length > 0 && (
            <button type="button" className="nt-db-pill nt-btn-reset" disabled={ctl.readOnly} onClick={(e) => setPop({ kind: "sort", el: e.currentTarget })}>
              <ArrowUpDown />
              {view.sorts.map((s) => ctl.schema?.properties.find((p) => p.id === s.prop)?.name).join(", ")}
              <ChevronDown />
            </button>
          )}
          {advRules > 0 && (
            <button type="button" className="nt-db-pill nt-btn-reset" data-adv="true" disabled={ctl.readOnly} onClick={(e) => setPop({ kind: "advfilter", el: e.currentTarget })}>
              <Filter />
              {rulesLabel(t, ctl.api.locale, advRules)}
              <ChevronDown />
            </button>
          )}
          {filters.map((f) => {
            const p = ctl.schema?.properties.find((x) => x.id === f.prop);
            if (!p) return null;
            let val = f.value ?? "";
            if (p.options && val) val = p.options.find((o) => o.id === val)?.name ?? val;
            if (isPeopleType(p.type) && val) val = val === ME ? t("people.me") : personText(val, ctl.api.locale);
            if (val && (isDateType(p.type) || f.op === "within")) val = dateValueLabel(t, val);
            return (
              <button type="button" key={f.id} className="nt-db-pill nt-btn-reset" disabled={ctl.readOnly} onClick={(e) => setPop({ kind: "filter", el: e.currentTarget, id: f.id })}>
                <PropIcon type={p.type} size={13} />
                {p.name}
                {val ? `: ${val}` : ["empty", "not_empty", "checked", "unchecked"].includes(f.op) ? `: ${t(`op.${f.op}` as NotesKey)}` : ""}
                <ChevronDown />
              </button>
            );
          })}
          {!ctl.readOnly && (
            <button type="button" className="nt-db-pill nt-db-pill-plain nt-btn-reset" onClick={(e) => setPop({ kind: "filterprop", el: e.currentTarget })}>
              <Plus />
              {t("db.addFilter")}
            </button>
          )}
          {filters.length + advRules > 0 && !ctl.readOnly && (
            <button type="button" className="nt-db-pill nt-db-pill-plain nt-btn-reset" onClick={() => ctl.updateView({ filters: [], filterGroup: undefined })}>
              {t("db.resetFilters")}
            </button>
          )}
        </div>
      )}
      {ctl.sourceMissing && (
        <div className="nt-panel-empty nt-db-nosource" data-testid="source-missing">
          <Lock />
          {t("src.missing")}
        </div>
      )}
      {ctl.sourceMissing ? null : (
        <>
      {view.type === "table" && <TableView ctl={ctl} />}
      {view.type === "board" && <BoardView ctl={ctl} />}
      {view.type === "list" && <ListView ctl={ctl} />}
      {view.type === "gallery" && <GalleryView ctl={ctl} />}
      {view.type === "calendar" && <CalendarView ctl={ctl} />}
      {view.type === "timeline" && <TimelineView ctl={ctl} />}
      {view.type === "chart" && <ChartView ctl={ctl} />}
      {view.type === "form" && <FormView ctl={ctl} />}
      {view.type === "map" && <MapView ctl={ctl} compact={widget} />}
      {view.type === "feed" && <FeedView ctl={ctl} />}
      {view.type === "dashboard" && !widget && <DashboardView ctl={ctl} Icon={ViewIcon} renderWidget={(viewId) => <DatabaseView dbId={dbId} scope={dashScope(view.id)} widgetViewId={viewId} />} />}
      {ctl.rows.length === 0 && ctl.allRows.length > 0 && ["table", "board", "list", "gallery"].includes(view.type) && <div className="nt-panel-empty">{t("db.noResults")}</div>}
        </>
      )}

      {pop?.kind === "filterprop" && (
        <PropPicker
          ctl={ctl}
          anchor={pop.el}
          title={t("db.filter")}
          onClose={() => setPop(null)}
          onPick={(p) => {
            const f: DbFilter = { id: shortId(), prop: p.id, op: defaultOp(p), value: "" };
            ctl.updateView({ filters: [...filters, f] });
            setPop({ kind: "filter", el: pop.el, id: f.id });
          }}
          footer={
            <button
              type="button"
              className="nt-mi nt-btn-reset"
              onClick={() => {
                const first = ctl.schema?.properties[0];
                if (!view.filterGroup?.items.length && first) ctl.updateView({ filterGroup: { id: shortId(), conj: "and", items: [newRule(first)] } });
                setPop({ kind: "advfilter", el: pop.el });
              }}
            >
              <span className="nt-mi-icon">
                <Plus />
              </span>
              <span className="nt-mi-label">{t("db.addAdvFilter")}</span>
            </button>
          }
        />
      )}
      {pop?.kind === "advfilter" && <AdvancedFilter ctl={ctl} anchor={pop.el} onClose={() => setPop(null)} />}
      {pop?.kind === "auto" && <AutomationsPanel ctl={ctl} anchor={pop.el} onClose={() => setPop(null)} />}
      {pop?.kind === "filter" && pop.id && filters.find((f) => f.id === pop.id) && (
        <FilterEditor ctl={ctl} filter={filters.find((f) => f.id === pop.id) as DbFilter} anchor={pop.el} onClose={() => setPop(null)} />
      )}
      {pop?.kind === "sort" && <SortEditor ctl={ctl} anchor={pop.el} onClose={() => setPop(null)} />}
      {pop?.kind === "settings" && <ViewSettings ctl={ctl} anchor={pop.el} onClose={() => setPop(null)} inline={inline} widget={widget} onOpenFull={() => ctl.api.open(dbId)} />}
      {pop?.kind === "viewtab" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)}>
          <Menu
            width={220}
            groups={[
              {
                key: "v",
                label: t("db.views"),
                items: views.map((v) => ({
                  key: v.id,
                  label: v.name || t(`db.${v.type}` as NotesKey),
                  hint: several ? sourceOf(v)?.name : undefined,
                  icon: <ViewIcon type={v.type} />,
                  checked: v.id === view.id,
                  onSelect: () => {
                    ctl.setViewId(v.id);
                    setPop(null);
                  },
                })),
              },
            ]}
          />
        </Popover>
      )}
      {pop?.kind === "addview" && (
        <Popover anchor={pop.el} onClose={() => (setPop(null), setNewViewSource(null))}>
          <Menu
            width={240}
            groups={[
              // Several data sources: which one the new view shows (Notion asks first).
              ...(several
                ? [
                    {
                      key: "src",
                      label: t("src.newViewOf"),
                      items: ctl.sources.map((x) => ({
                        key: `src-${x.id}`,
                        label: x.note ? x.name : t("src.noAccess"),
                        icon: <SourceIcon icon={x.icon} />,
                        checked: x.id === pickedSource,
                        disabled: !x.note,
                        onSelect: () => setNewViewSource(x.id),
                      })),
                    },
                  ]
                : []),
              {
                key: "v",
                label: t("db.addView"),
                items: LAYOUTS.map((type) => ({
                  key: type,
                  label: t(`db.${type}` as NotesKey),
                  icon: <ViewIcon type={type} />,
                  onSelect: () => {
                    ctl.addView(type, pickedSource);
                    setPop(null);
                    setNewViewSource(null);
                  },
                })),
              },
              // Notion's "+ Add data source" sits under the layouts (not in linked views).
              ...(!scope && !ctl.readOnly
                ? [
                    {
                      key: "ds",
                      items: [
                        { key: "newsrc", label: t("src.addNew"), icon: <Plus />, onSelect: () => (addNewSource(ctl), setPop(null)) },
                        // The panel opens where "+" is (this menu closes).
                        { key: "mansrc", label: t("src.manage"), icon: <Database />, onSelect: () => setPop({ kind: "sources", el: pop.el }) },
                      ],
                    },
                  ]
                : []),
            ]}
          />
        </Popover>
      )}
      {pop?.kind === "sources" && <SourcesPanel ctl={ctl} anchor={pop.el} onClose={() => setPop(null)} />}
    </div>
  );
}

