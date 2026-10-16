"use client";

// Database layouts: Table, Board, List, Gallery, Calendar.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, GripVertical, Maximize2, MoreHorizontal, Plus, Trash2, Copy, FileText, ArrowUpRight, Eye, EyeOff, Lock } from "lucide-react";
import { CellValue, DateEditor, PropIcon, SelectEditor, Tag, TextCellInput, monthGrid, parseTextValue, textOf, upperFirst, weekdayNames } from "./cells";
import { PropertyMenu } from "./PropertyMenu";
import { FilesEditor, RelationEditor } from "./advanced";
import { PersonChip, PersonPicker } from "../people";
import { PlaceEditor } from "./place";
import { VerificationEditor } from "./verification";
import type { DbCtl } from "./useDatabase";
import { Menu, Popover, cx, toast } from "../ui";
import { canGroupBy, firstImage, fmtDate, formatNumber, groupRows, groupRowsFor, isEmptyValue, movedOptions, movedOrder, nestRows, propValue, rowColors, splitGroups, type RowColors, type RowGroup } from "@/lib/notes/db";
import { calcColumn, calcFnsFor } from "@/lib/notes/compute";
import type { NotesKey } from "@/lib/notes/i18n";
import { blocksText, displayTitle, orderBetween } from "@/lib/notes/model";
import { COMPUTED_TYPES, NO_VALUE_TYPES, isDateValue, isPlaceValue, type DateValue, type DbProperty, type Note, type PropType, type PropValue, type RollupFn } from "@/lib/notes/types";
import { NoteIcon } from "../NoteIcon";
import { coverCss } from "../cover";
import { useMondayFirst } from "../prefs";
import { intlOf } from "@/i18n/locales";

/** The words a grouping needs: the empty group, checkboxes, and dates by relative time. */
export function groupLabels(t: DbCtl["api"]["t"], prop: DbProperty) {
  return {
    none: t("db.noGroup", { prop: prop.name }),
    checked: t("db.checked"),
    unchecked: t("db.unchecked"),
    relative: { today: t("db.today"), tomorrow: t("grp.tomorrow"), yesterday: t("grp.yesterday"), next7: t("grp.next7"), last7: t("grp.last7"), next30: t("grp.next30"), last30: t("grp.last30"), weekOf: t("grp.weekOf", { date: "{date}" }) },
  };
}

/** A row's conditional colors in the view shown (Notion's "Conditional color"). */
function colorsOf(ctl: DbCtl, row: Note): RowColors {
  return ctl.view?.colors?.length && ctl.schema ? rowColors(row, ctl.view, ctl.schema) : NO_ROW_COLORS;
}
const NO_ROW_COLORS: RowColors = { cells: {} };

export function RowIcon({ row }: { row: Note }) {
  return <span className="nt-row-icon"><NoteIcon icon={row.icon} fallback={<FileText strokeWidth={1.6} />} /></span>;
}

const DEFAULT_W: Partial<Record<DbProperty["type"], number>> = { title: 280, checkbox: 110, number: 140, date: 200, created_time: 200, last_edited_time: 200 };

function colWidth(ctl: DbCtl, p: DbProperty): number {
  return ctl.view?.widths[p.id] ?? DEFAULT_W[p.type] ?? 200;
}

// ---------------------------------------------------------------------------
// Cell editing (shared by table cells and row property lists)

const PAGE = 50;

const POPOVER_TYPES: readonly PropType[] = ["select", "multi_select", "status", "date", "relation", "files", "person", "place", "verification"];

export function useCellEdit(ctl: DbCtl) {
  const [editing, setEditing] = useState<{ rowId: string; propId: string; el: HTMLElement | null } | null>(null);
  const start = (row: Note, prop: DbProperty, el: HTMLElement | null) => {
    // Viewers and commenters only browse a relation's linked pages.
    if (COMPUTED_TYPES.includes(prop.type) || NO_VALUE_TYPES.includes(prop.type) || (ctl.readOnly && prop.type !== "relation")) return;
    // Column permissions: a value one may not see or not change stays put.
    if (prop.denied) return;
    if (prop.type === "checkbox") {
      ctl.setValue(row, prop, !(row.props?.[prop.id] === true));
      return;
    }
    setEditing({ rowId: row.id, propId: prop.id, el });
  };
  const popover = (() => {
    if (!editing) return null;
    const row = ctl.api.snap.byId.get(editing.rowId);
    const prop = ctl.schema?.properties.find((p) => p.id === editing.propId);
    if (!row || !prop) return null;
    const close = () => setEditing(null);
    if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status")
      return <SelectEditor prop={prop} value={propValue(row, prop)} anchor={editing.el} onClose={close} onValue={(v) => ctl.setValue(row, prop, v)} onProp={(patch) => ctl.updateProp(prop.id, patch)} />;
    if (prop.type === "date") return <DateEditor withTime value={propValue(row, prop)} anchor={editing.el} onClose={close} onValue={(v) => ctl.setValue(row, prop, v)} />;
    if (prop.type === "relation") return <RelationEditor ctl={ctl} prop={prop} row={row} anchor={editing.el} onClose={close} />;
    if (prop.type === "files") return <FilesEditor ctl={ctl} prop={prop} row={row} anchor={editing.el} onClose={close} />;
    if (prop.type === "person") {
      const v = propValue(row, prop);
      return <PersonPicker value={Array.isArray(v) ? v : []} single={prop.single} anchor={editing.el} onClose={close} onValue={(ids) => ctl.setValue(ctl.api.store.get(row.id) ?? row, prop, ids)} />;
    }
    if (prop.type === "place") return <PlaceEditor value={propValue(row, prop)} anchor={editing.el} onClose={close} onValue={(v) => ctl.setValue(row, prop, v)} />;
    if (prop.type === "verification") return <VerificationEditor row={row} prop={prop} schema={ctl.schema} anchor={editing.el} onClose={close} onValue={(v) => ctl.setValue(ctl.api.store.get(row.id) ?? row, prop, v)} />;
    return null;
  })();
  const inlineFor = (row: Note, prop: DbProperty): boolean => editing?.rowId === row.id && editing.propId === prop.id && !POPOVER_TYPES.includes(prop.type);
  return { editing, setEditing, start, popover, inlineFor };
}

/** A footer cell: "Calculate" on hover, or the chosen calculation (Notion). */
function CalcCell({ ctl, prop, rows, width, pin }: { ctl: DbCtl; prop: DbProperty; rows: Note[]; width: number; pin?: Pin }) {
  const { t, locale, snap } = ctl.api;
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const set = ctl.view?.calcs?.[prop.id];
  // The title column counts rows unless told otherwise.
  const fn = set ?? (prop.type === "title" ? "count" : undefined);
  const value = fn ? calcColumn(fn, rows, prop, snap.byId, locale) : null;
  const text = (() => {
    if (!fn) return "";
    if (value === null) return "—";
    if (typeof value === "number") {
      if (fn.startsWith("percent_")) return `${Math.round(value * 1000) / 10}%`;
      if (["sum", "average", "median", "min", "max", "range"].includes(fn)) return formatNumber(Math.round(value * 100) / 100, prop.numberFormat, locale, prop.decimals);
      return String(value);
    }
    if (isDateValue(value)) return value.end ? `${fmtDate(value.start, locale)} → ${fmtDate(value.end, locale)}` : fmtDate(value.start, locale);
    if (isPlaceValue(value)) return value.name;
    return String(value);
  })();
  const pick = (next: RollupFn | null) => {
    const calcs = { ...(ctl.view?.calcs ?? {}) };
    if (next) calcs[prop.id] = next;
    else delete calcs[prop.id];
    ctl.updateView({ calcs });
    setMenu(null);
  };
  return (
    <div
      className={cx("nt-calc", pin && "nt-frozen")}
      data-set={fn ? "true" : undefined}
      data-col={`${ctl.db?.id}:${prop.id}`}
      data-frozen-last={pin?.last || undefined}
      style={{ width, ...pin?.style }}
      role="button"
      // Clicks inside the menu (a portal) bubble here through React: ignore them.
      onClick={(e) => !ctl.locked && e.currentTarget.contains(e.target as Node) && setMenu(e.currentTarget)}
    >
      {fn ? (
        <>
          <span className="nt-calc-label">{t(fn === "count" ? "db.count" : (`rollup.fn.${fn}` as NotesKey))}</span>
          <b>{text}</b>
        </>
      ) : (
        <span className="nt-calc-hint">
          {t("db.calculate")}
          <ChevronDown size={12} />
        </span>
      )}
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} placement="top-start">
          <Menu
            width={220}
            onClose={() => setMenu(null)}
            groups={[
              {
                key: "c",
                items: [
                  { key: "none", label: t("db.calcNone"), checked: !fn, onSelect: () => pick(null) },
                  ...calcFnsFor(prop).map((f) => ({ key: f, label: t(f === "count" ? "db.count" : (`rollup.fn.${f}` as NotesKey)), checked: f === fn, onSelect: () => pick(f) })),
                ],
              },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

function RowMenu({ ctl, row, anchor, onClose }: { ctl: DbCtl; row: Note; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <Menu
        width={220}
        groups={[
          {
            key: "m",
            items: [
              { key: "open", label: t("db.openRow"), icon: <ArrowUpRight />, onSelect: () => (ctl.openRow(row.id), onClose()) },
              { key: "dup", label: t("db.duplicateRow"), icon: <Copy />, onSelect: () => (ctl.api.duplicate(row.id), onClose()) },
              { key: "del", label: t("db.deleteRow"), icon: <Trash2 />, danger: true, onSelect: () => (ctl.api.trash(row.id), onClose()) },
            ],
          },
        ]}
      />
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Hidden groups (Notion's "Hide group")

function setGroupHidden(ctl: DbCtl, key: string, hidden: boolean) {
  const cur = ctl.view?.hiddenGroups ?? [];
  const next = hidden ? [...cur.filter((k) => k !== key), key] : cur.filter((k) => k !== key);
  ctl.updateView({ hiddenGroups: next.length ? next : undefined });
}

function HideGroupButton({ ctl, groupKey }: { ctl: DbCtl; groupKey: string }) {
  const { t } = ctl.api;
  if (ctl.locked) return null;
  return (
    <button
      type="button"
      className="nt-item-act nt-btn-reset nt-group-hide"
      aria-label={t("db.hideGroup")}
      title={t("db.hideGroup")}
      onClick={(e) => {
        e.stopPropagation();
        setGroupHidden(ctl, groupKey, true);
      }}
    >
      <EyeOff size={14} />
    </button>
  );
}

/** Hidden groups under a grouped table or list, each with "Show". */
function HiddenGroups({ ctl, groups, status }: { ctl: DbCtl; groups: { key: string; label?: string; option: RowGroup["option"]; rows: Note[] }[]; status?: boolean }) {
  const { t } = ctl.api;
  const [open, setOpen] = useState(false);
  if (!groups.length) return null;
  return (
    <div className="nt-hidden-groups">
      <button type="button" className="nt-tgroup-head nt-btn-reset" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className="nt-tgroup-chev" data-open={open || undefined} />
        <span className="nt-tgroup-label">{t("db.hiddenGroups")}</span>
        <span className="nt-tgroup-count">{groups.length}</span>
      </button>
      {open && <HiddenGroupRows ctl={ctl} groups={groups} status={status} />}
    </div>
  );
}

function HiddenGroupRows({ ctl, groups, status }: { ctl: DbCtl; groups: { key: string; label?: string; option: RowGroup["option"]; rows: Note[] }[]; status?: boolean }) {
  const { t } = ctl.api;
  return (
    <>
      {groups.map((g) => (
        <div key={g.key} className="nt-hidden-group">
          {g.option ? <Tag option={g.option} status={status} /> : <span className="nt-tgroup-label">{g.label ?? t("db.noGroupShort")}</span>}
          <span className="nt-tgroup-count">{g.rows.length}</span>
          {!ctl.locked && (
            <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("db.showGroup")} title={t("db.showGroup")} onClick={() => setGroupHidden(ctl, g.key, false)}>
              <Eye size={14} />
            </button>
          )}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Table

/** A frozen column's sticky offset. */
type Pin = { style: { left: number }; last: boolean };

/** Room a frozen block must leave for the rest of the table (else it does not stick, as on phones). */
const FREEZE_ROOM = 120;

export function TableView({ ctl }: { ctl: DbCtl }) {
  const { t } = ctl.api;
  const { props, rows, view } = ctl;
  const edit = useCellEdit(ctl);
  const [propMenu, setPropMenu] = useState<{ prop: DbProperty; el: HTMLElement } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ row: Note; el: HTMLElement } | null>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over?: string } | null>(null);
  // Column drag (Notion): drop on a header's left or right half; the title stays first.
  const [colDrag, setColDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null);
  const [newTitleFor, setNewTitleFor] = useState<string | null>(null);
  const titleProp = props.find((p) => p.type === "title");
  const total = props.reduce((s, p) => s + colWidth(ctl, p), 0) + 34;

  // Row selection (Notion): checkboxes in the gutter, Shift-click for a range,
  // and a bar that acts on every selected row.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [lastPick, setLastPick] = useState<string | null>(null);

  // Frozen columns (Notion's "Freeze up to column"): sticky on sideways
  // scroll, unless they would leave too little room for the rest.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const freezeN = view?.freeze ? props.findIndex((p) => p.id === view.freeze) + 1 : 0;
  const lefts: number[] = [];
  let frozenW = 0;
  for (let i = 0; i < freezeN; i++) {
    lefts.push(frozenW);
    frozenW += colWidth(ctl, props[i]);
  }
  const frozen = freezeN > 0 && wrapW > 0 && frozenW <= wrapW - FREEZE_ROOM ? freezeN : 0;
  const pin = (i: number): Pin | undefined => (i < frozen ? { style: { left: lefts[i] }, last: i === frozen - 1 } : undefined);

  useEffect(() => {
    if (!newTitleFor || !titleProp) return;
    // Runs after the new row has rendered, so its title cell exists.
    edit.setEditing({ rowId: newTitleFor, propId: titleProp.id, el: null });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNewTitleFor(null);
  }, [newTitleFor, titleProp, edit]);

  const startResize = (e: React.PointerEvent, p: DbProperty) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidth(ctl, p);
    setResizing(p.id);
    let w = startW;
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const cells = (id: string) => (wrapRef.current ?? document).querySelectorAll<HTMLElement>(`[data-col="${CSS.escape(`${ctl.db?.id}:${id}`)}"]`);
    const at = props.findIndex((x) => x.id === p.id);
    const move = (ev: PointerEvent) => {
      w = Math.max(80, Math.min(1000, startW + ev.clientX - startX));
      th.style.width = `${w}px`;
      cells(p.id).forEach((el) => (el.style.width = `${w}px`));
      // Frozen columns to the right move with the edge.
      for (let i = at + 1; i < frozen; i++) cells(props[i].id).forEach((el) => (el.style.left = `${lefts[i] + w - startW}px`));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(null);
      if (view) ctl.updateView({ widths: { ...view.widths, [p.id]: Math.round(w) } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const manual = (view?.sorts.length ?? 0) === 0 && !ctl.readOnly;
  const dropRow = (targetId: string) => {
    if (!drag || drag.id === targetId) return setDrag(null);
    const list = rows.filter((r) => r.id !== drag.id);
    const i = list.findIndex((r) => r.id === targetId);
    const order = orderBetween(list[i - 1]?.order, list[i]?.order);
    ctl.api.store.update(drag.id, { order }, { quiet: true });
    setDrag(null);
  };


  // Grouping (Notion's "Group"): shared with the board's setting.
  const groupProp = view?.groupBy ? ctl.schema?.properties.find((p) => p.id === view.groupBy && canGroupBy(p)) : undefined;
  const allGroups = useMemo(
    () => (groupProp ? groupRowsFor(rows, groupProp, groupLabels(t, groupProp), ctl.api.locale, { groupDate: view?.groupDate, groupOrder: view?.groupOrder }) : null),
    [groupProp, rows, t, ctl.api.locale, view?.groupDate, view?.groupOrder]
  );
  const split = allGroups ? splitGroups(allGroups, view) : null;
  const groups = split?.shown ?? null;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Big tables render 50 rows at a time ("Load more", as in Notion).
  // Notion's "Load limit": that many rows, then "Load more".
  const [extra, setExtra] = useState(0);
  const page = ctl.view?.limit ?? PAGE;
  const limit = page + extra;
  const more = (n: number) =>
    n > limit ? (
      <button type="button" className="nt-load-more nt-btn-reset" onClick={() => setExtra((x) => x + page * 2)}>
        <ChevronDown size={14} />
        {t("db.loadMoreN", { n: n - limit })}
      </button>
    ) : null;
  const toggleGroup = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const newInGroup = (g: RowGroup) => {
    const r = ctl.addRow({ stay: true, props: groupProp && g.value !== undefined ? { [groupProp.id]: g.value } : undefined });
    setNewTitleFor(r.id);
  };

  // Sub-items (Notion): rows nest under their parent item, collapsed at first.
  const subProp = ctl.schema?.subItems ? ctl.schema.properties.find((p) => p.id === ctl.schema?.subItems?.parentProp) : undefined;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => (subProp && !groups ? nestRows(rows, subProp.id) : null), [subProp, groups, rows]);
  const flat = useMemo(() => {
    if (!tree) return null;
    const out: { row: Note; depth: number; kids: number }[] = [];
    const walk = (list: Note[], depth: number) => {
      for (const r of list) {
        const kids = tree.children.get(r.id) ?? [];
        out.push({ row: r, depth, kids: kids.length });
        if (kids.length && expanded.has(r.id) && depth < 12) walk(kids, depth + 1);
      }
    };
    walk(tree.roots, 0);
    return out;
  }, [tree, expanded]);
  const toggleRow = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const addSubItem = (parent: Note) => {
    if (!subProp) return;
    const r = ctl.addRow({ stay: true });
    ctl.setValue(ctl.api.store.get(r.id) ?? r, subProp, [parent.id]);
    setExpanded((s) => new Set(s).add(parent.id));
    setNewTitleFor(r.id);
  };

  // Only rows on screen can be selected: not those in hidden or collapsed
  // groups, nor past "Load more" (a bulk delete must never reach unseen rows).
  const shownRows = useMemo(() => {
    const list = groups ? groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.rows.slice(0, limit)) : flat ? flat.slice(0, limit).map((x) => x.row) : rows.slice(0, limit);
    const seen = new Set<string>();
    return list.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
  }, [groups, collapsed, flat, rows, limit]);
  const selected = shownRows.filter((r) => picked.has(r.id));
  const selecting = selected.length > 0;
  const pick = (id: string, on: boolean, range: boolean) => {
    setPicked((cur) => {
      const next = new Set(cur);
      const a = range && lastPick ? shownRows.findIndex((r) => r.id === lastPick) : -1;
      const b = shownRows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next[on ? "add" : "delete"](shownRows[i].id);
      else next[on ? "add" : "delete"](id);
      return next;
    });
    setLastPick(id);
  };
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Keys typed into fields belong to them (a row checkbox is fine).
      if (el?.closest("input:not([type=checkbox]), textarea, [contenteditable=true], .nt-popover")) return;
      if (e.key === "Escape") setPicked(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  const renderRow = (row: Note, group?: RowGroup, nest?: { depth: number; kids: number }, colors = colorsOf(ctl, row)) => (
    <div
      key={row.id}
      className={cx("nt-tr nt-tr-body", drag?.over === row.id && "nt-row-drop-before")}
      data-selected={picked.has(row.id) || undefined}
      data-ccolor={colors.row}
      onDragOver={(e) => {
        if (!drag || !manual) return;
        e.preventDefault();
        if (drag.over !== row.id) setDrag({ ...drag, over: row.id });
      }}
      onDrop={(e) => {
        e.preventDefault();
        dropRow(row.id);
      }}
    >
      {!ctl.readOnly && (
      <div className="nt-row-handle" data-on={rowMenu?.row.id === row.id || undefined}>
        <button
          type="button"
          className="nt-btn-reset"
          aria-label={t("db.addRow")}
          onClick={() => {
            const i = rows.findIndex((r) => r.id === row.id);
            const r = ctl.addRow({ stay: true, props: groupProp && group?.value !== undefined ? { [groupProp.id]: group.value } : undefined });
            ctl.api.store.update(r.id, { order: orderBetween(row.order, rows[i + 1]?.order) }, { quiet: true });
            setNewTitleFor(r.id);
          }}
        >
          <Plus />
        </button>
        <button
          type="button"
          className="nt-btn-reset"
          draggable={manual}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", row.id);
            setDrag({ id: row.id });
          }}
          onDragEnd={() => setDrag(null)}
          onClick={(e) => setRowMenu({ row, el: e.currentTarget })}
        >
          <GripVertical />
        </button>
      </div>
      )}
      <label className="nt-row-sel" data-on={selecting || undefined} onClick={(e) => e.stopPropagation()}>
        {!ctl.readOnly && (
          <input
            type="checkbox"
            className="nt-row-check"
            aria-label={t("db.selectRow")}
            checked={picked.has(row.id)}
            onChange={(e) => pick(row.id, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)}
          />
        )}
      </label>
      {props.map((p, i) => {
        const inline = edit.inlineFor(row, p);
        const pinned = pin(i);
        return (
          <div
            key={p.id}
            className={cx("nt-td", pinned && "nt-frozen")}
            data-col={`${ctl.db?.id}:${p.id}`}
            data-ccolor={colors.cells[p.id]}
            data-wrap={view?.wrapCols?.includes(p.id) || undefined}
            data-frozen-last={pinned?.last || undefined}
            data-editing={inline || (edit.editing?.rowId === row.id && edit.editing.propId === p.id) || undefined}
            style={{ width: colWidth(ctl, p), ...pinned?.style }}
            onClick={(e) => {
              if (inline) return;
              // Touch screens have no hover for "Open": a tap on the name opens the row (Notion's apps).
              if (p.type === "title" && window.matchMedia("(hover: none) and (pointer: coarse)").matches) return ctl.openRow(row.id);
              edit.start(row, p, e.currentTarget);
            }}
          >
            {inline ? (
              <TextCellInput
                initial={textOf(p, row)}
                type={p.type}
                multiline={p.type === "text"}
                onCancel={() => edit.setEditing(null)}
                onCommit={(v) => {
                  const next = p.type === "title" ? v : parseTextValue(p.type, v);
                  if (next !== undefined) ctl.setValue(row, p, next);
                  edit.setEditing(null);
                }}
              />
            ) : p.type === "title" ? (
              <div className="nt-td-inner nt-td-title" style={nest ? { paddingInlineStart: 4 + nest.depth * 22 } : undefined}>
                {nest &&
                  (nest.kids ? (
                    <button
                      type="button"
                      className="nt-sub-toggle nt-btn-reset"
                      aria-expanded={expanded.has(row.id)}
                      aria-label={t("db.toggleSubItems", { n: nest.kids })}
                      title={t("db.toggleSubItems", { n: nest.kids })}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRow(row.id);
                      }}
                    >
                      <ChevronRight />
                    </button>
                  ) : (
                    <span className="nt-sub-toggle" aria-hidden="true" />
                  ))}
                {!view?.hideIcons && <RowIcon row={row} />}
                <span className="nt-td-title-text">{row.title || <span className="nt-cell-muted">{t("db.untitled")}</span>}</span>
                {nest && !ctl.readOnly && (
                  <button
                    type="button"
                    className="nt-td-sub nt-btn-reset"
                    aria-label={t("db.newSubItem")}
                    title={t("db.newSubItem")}
                    onClick={(e) => {
                      e.stopPropagation();
                      addSubItem(row);
                    }}
                  >
                    <Plus />
                  </button>
                )}
                <button
                  type="button"
                  className="nt-td-open nt-btn-reset"
                  onClick={(e) => {
                    e.stopPropagation();
                    ctl.openRow(row.id);
                  }}
                >
                  <Maximize2 />
                  {t("db.openRow")}
                </button>
              </div>
            ) : (
              <div className="nt-td-inner">
                <CellValue prop={p} value={propValue(row, p)} row={row} />
              </div>
            )}
          </div>
        );
      })}
      <div className="nt-td" style={{ width: 34 }} />
    </div>
  );

  return (
    <>
    {selecting && <BulkBar ctl={ctl} rows={selected} onDone={() => setPicked(new Set())} />}
    <div
      className="nt-table-wrap"
      ref={wrapRef}
      data-selecting={selecting || undefined}
      data-scrolled={(frozen > 0 && scrolled) || undefined}
      onScroll={frozen ? (e) => setScrolled(e.currentTarget.scrollLeft > 0) : undefined}
    >
      <div className="nt-table" data-wrap={view?.wrap || undefined} data-lines={view?.noLines ? "off" : undefined} style={{ minWidth: total }}>
        <div className="nt-thead">
          <div className="nt-tr">
            <label className="nt-row-sel nt-row-sel-all" data-on={selecting || undefined}>
              {!ctl.readOnly && (
                <input
                  type="checkbox"
                  className="nt-row-check"
                  aria-label={t("db.selectAll")}
                  checked={selecting && selected.length === shownRows.length}
                  ref={(el) => {
                    if (el) el.indeterminate = selecting && selected.length < shownRows.length;
                  }}
                  onChange={(e) => setPicked(e.target.checked ? new Set(shownRows.map((r) => r.id)) : new Set())}
                />
              )}
            </label>
            {props.map((p, i) => (
              <div
                key={p.id}
                className={cx("nt-th", pin(i) && "nt-frozen")}
                data-col={`${ctl.db?.id}:${p.id}`}
                data-frozen-last={pin(i)?.last || undefined}
                data-dragging={colDrag?.id === p.id || undefined}
                data-drop={colDrag?.over === p.id ? (colDrag.after ? "r" : "l") : undefined}
                style={{ width: colWidth(ctl, p), ...pin(i)?.style }}
                draggable={p.type !== "title" && !ctl.locked}
                onDragStart={(e) => {
                  if ((e.target as HTMLElement).closest(".nt-th-resize")) return e.preventDefault();
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", p.name);
                  setColDrag({ id: p.id });
                }}
                onDragOver={(e) => {
                  if (!colDrag || colDrag.id === p.id) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const after = p.type === "title" || e.clientX > r.left + r.width / 2;
                  if (colDrag.over !== p.id || colDrag.after !== after) setColDrag({ ...colDrag, over: p.id, after });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (colDrag?.over && ctl.schema && view) ctl.updateView({ order: movedOrder(ctl.schema, view, colDrag.id, colDrag.over, Boolean(colDrag.after)) });
                  setColDrag(null);
                }}
                onDragEnd={() => setColDrag(null)}
                onClick={(e) => !ctl.readOnly && setPropMenu({ prop: p, el: e.currentTarget })}
              >
                <PropIcon type={p.type} />
                <span className="nt-th-name" title={p.description || undefined}>{p.name}</span>
                {(p.perms || p.denied) && <Lock className="nt-prop-lock" aria-label={ctl.api.t("cols.limited")} />}
                {!ctl.locked && <span className="nt-th-resize" data-active={resizing === p.id || undefined} onPointerDown={(e) => startResize(e, p)} onClick={(e) => e.stopPropagation()} />}
              </div>
            ))}
            {!ctl.locked && (
            <div
              className="nt-th nt-th-add"
              role="button"
              aria-label={t("db.addProp")}
              title={t("db.addProp")}
              onClick={(e) => {
                const p = ctl.addProp("text");
                const el = e.currentTarget;
                setTimeout(() => setPropMenu({ prop: p, el }), 0);
              }}
            >
              <Plus />
            </div>
            )}
          </div>
        </div>
        {groups
          ? groups.map((g) => {
              const open = !collapsed.has(g.key);
              return (
                <div key={g.key} className="nt-tgroup">
                  <div className="nt-tgroup-head" role="button" onClick={() => toggleGroup(g.key)}>
                    <ChevronRight className="nt-tgroup-chev" data-open={open || undefined} />
                    {g.option ? <Tag option={g.option} status={groupProp?.type === "status"} /> : <span className="nt-tgroup-label">{g.label}</span>}
                    <span className="nt-tgroup-count">{g.rows.length}</span>
                    <HideGroupButton ctl={ctl} groupKey={g.key} />
                    {!ctl.readOnly && (
                      <button
                        type="button"
                        className="nt-item-act nt-btn-reset nt-tgroup-add"
                        aria-label={t("db.newRow")}
                        onClick={(e) => {
                          e.stopPropagation();
                          newInGroup(g);
                        }}
                      >
                        <Plus size={14} />
                      </button>
                    )}
                  </div>
                  {open && (
                    <>
                      {g.rows.slice(0, limit).map((row) => renderRow(row, g))}
                      {more(g.rows.length)}
                      {!ctl.readOnly && (
                        <div className="nt-table-new" role="button" onClick={() => newInGroup(g)}>
                          <Plus />
                          {t("db.newRow")}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })
          : flat
            ? flat.slice(0, limit).map((x) => renderRow(x.row, undefined, x))
            : rows.slice(0, limit).map((row) => renderRow(row))}
        {split && <HiddenGroups ctl={ctl} groups={split.hidden} status={groupProp?.type === "status"} />}
        {!groups && more(flat ? flat.length : rows.length)}
        {!groups && !ctl.readOnly && (
        <div
          className="nt-table-new"
          role="button"
          onClick={() => {
            const r = ctl.addRow({ stay: true });
            setNewTitleFor(r.id);
          }}
        >
          <Plus />
          {t("db.newRow")}
        </div>
        )}
        <div className="nt-table-calc">
          {props.map((p, i) => (
            <CalcCell key={p.id} ctl={ctl} prop={p} rows={rows} width={colWidth(ctl, p)} pin={pin(i)} />
          ))}
        </div>
      </div>
      {edit.popover}
      {propMenu && <PropertyMenu ctl={ctl} prop={propMenu.prop} anchor={propMenu.el} onClose={() => setPropMenu(null)} inTable />}
      {rowMenu && <RowMenu ctl={ctl} row={rowMenu.row} anchor={rowMenu.el} onClose={() => setRowMenu(null)} />}
    </div>
    </>
  );
}

/** Actions on the selected rows: set a property, duplicate, delete (with undo). */
function BulkBar({ ctl, rows, onDone }: { ctl: DbCtl; rows: Note[]; onDone: () => void }) {
  const { t, store } = ctl.api;
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [propFor, setPropFor] = useState<{ prop: DbProperty; el: HTMLElement } | null>(null);
  const editable = (ctl.schema?.properties ?? []).filter((p) => p.type === "select" || p.type === "status" || p.type === "multi_select" || p.type === "checkbox");
  const setAll = (prop: DbProperty, value: (row: Note) => PropValue) => {
    for (const r of rows) {
      const fresh = store.get(r.id);
      if (fresh) ctl.setValue(fresh, prop, value(fresh));
    }
    setPropFor(null);
    setMenu(null);
  };
  const remove = () => {
    const ids = rows.map((r) => r.id);
    for (const id of ids) store.trash(id);
    toast(t("db.bulkTrashed", { n: ids.length }), { label: t("toast.undo"), run: () => ids.forEach((id) => store.restore(id)) });
    onDone();
  };
  return (
    <div className="nt-bulk" role="toolbar" aria-label={t("db.selectedN", { n: rows.length })}>
      <span className="nt-bulk-count">{t("db.selectedN", { n: rows.length })}</span>
      {editable.length > 0 && (
        <button type="button" className="nt-bulk-btn nt-btn-reset" onClick={(e) => setMenu(e.currentTarget)}>
          {t("db.editProp")}
          <ChevronDown size={14} />
        </button>
      )}
      <button
        type="button"
        className="nt-bulk-btn nt-btn-reset"
        onClick={() => {
          for (const r of rows) ctl.api.duplicate(r.id);
          onDone();
        }}
      >
        <Copy size={14} />
        {t("menu.duplicate")}
      </button>
      <button type="button" className="nt-bulk-btn nt-bulk-danger nt-btn-reset" onClick={remove}>
        <Trash2 size={14} />
        {t("block.delete")}
      </button>
      <button type="button" className="nt-bulk-btn nt-bulk-x nt-btn-reset" aria-label={t("db.clearSelection")} title={t("db.clearSelection")} onClick={onDone}>
        ✕
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          <Menu
            width={220}
            groups={[{ key: "p", items: editable.map((p) => ({ key: p.id, label: p.name, icon: <PropIcon type={p.type} />, submenu: true, onSelect: (el: HTMLElement) => setPropFor({ prop: p, el }) })) }]}
          />
          {propFor && (
            <Popover anchor={propFor.el} placement="right-start" onClose={() => setPropFor(null)}>
              <Menu
                width={220}
                groups={[
                  {
                    key: "v",
                    label: propFor.prop.name,
                    items:
                      propFor.prop.type === "checkbox"
                        ? [
                            { key: "on", label: t("db.checked"), onSelect: () => setAll(propFor.prop, () => true) },
                            { key: "off", label: t("db.unchecked"), onSelect: () => setAll(propFor.prop, () => false) },
                          ]
                        : [
                            ...(propFor.prop.options ?? []).map((o) => ({
                              key: o.id,
                              label: <Tag option={o} status={propFor.prop.type === "status"} />,
                              onSelect: () =>
                                setAll(propFor.prop, (r) => {
                                  if (propFor.prop.type !== "multi_select") return o.id;
                                  const cur = r.props?.[propFor.prop.id];
                                  const list = Array.isArray(cur) ? cur : [];
                                  return list.includes(o.id) ? list : [...list, o.id];
                                }),
                            })),
                            { key: "__clear", label: t("db.clearValue"), onSelect: () => setAll(propFor.prop, () => (propFor.prop.type === "multi_select" ? [] : null)) },
                          ],
                  },
                ]}
              />
            </Popover>
          )}
        </Popover>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card props (board, gallery)

export function CardProps({ ctl, row }: { ctl: DbCtl; row: Note }) {
  const items = ctl.props.filter((p) => p.type !== "title" && (p.type === "button" || !isEmptyValue(propValue(row, p))));
  const colors = colorsOf(ctl, row);
  if (!items.length) return null;
  return (
    <div className="nt-card-props">
      {items.map((p) => (
        <div key={p.id} className="nt-card-prop-text" data-ccolor={colors.cells[p.id]}>
          <CellValue prop={p} value={propValue(row, p)} row={row} compact />
        </div>
      ))}
    </div>
  );
}

function CardMore({ ctl, row }: { ctl: DbCtl; row: Note }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  if (ctl.readOnly) return null;
  return (
    <>
      <div className="nt-card-more">
        <button
          type="button"
          className="nt-btn-reset"
          onClick={(e) => {
            e.stopPropagation();
            setEl(e.currentTarget);
          }}
        >
          <MoreHorizontal />
        </button>
      </div>
      {el && <RowMenu ctl={ctl} row={row} anchor={el} onClose={() => setEl(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Board

export function BoardView({ ctl }: { ctl: DbCtl }) {
  const { t, locale } = ctl.api;
  const groupProp = ctl.schema?.properties.find((p) => p.id === ctl.view?.groupBy && (p.type === "status" || p.type === "select" || p.type === "multi_select" || p.type === "person"));
  // Person columns: a card may name several people, like a multi-select.
  const multi = groupProp?.type === "multi_select" || groupProp?.type === "person";
  // Notion's "Sub-group": horizontal lanes, each with every column.
  const subProp = ctl.view?.subGroupBy ? ctl.schema?.properties.find((p) => p.id === ctl.view?.subGroupBy && p.id !== groupProp?.id && canGroupBy(p)) : undefined;
  // `from`: the column the card was picked up in (a multi-select card shows in several).
  const [drag, setDrag] = useState<{ id: string; from?: string; col?: string; lane?: string; before?: string } | null>(null);
  // Column drag (Notion): a column's header moves its group (the property's option order).
  const [colDrag, setColDrag] = useState<{ key: string; over?: string; after?: boolean } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const lanes = useMemo(
    () => (subProp ? groupRowsFor(ctl.rows, subProp, groupLabels(t, subProp), locale, { groupDate: ctl.view?.groupDate, groupOrder: ctl.view?.groupOrder }).filter((l) => l.rows.length > 0 || l.option) : null),
    [ctl.rows, subProp, t, locale, ctl.view?.groupDate, ctl.view?.groupOrder]
  );
  if (!groupProp) {
    return (
      <div className="nt-panel-empty" style={{ textAlign: "left", padding: "24px 4px" }}>
        {t("db.noGroupProp")}
      </div>
    );
  }
  const colValue = (col: string): PropValue => (col === "__none" ? (multi ? [] : null) : multi ? [col] : col);
  const drop = (col: string, lane?: RowGroup, laneRows?: Note[]) => {
    if (!drag) return;
    const row = ctl.api.snap.byId.get(drag.id);
    if (!row) return setDrag(null);
    // Multi-select: the card trades the tag it was dragged from for the new one, keeping the rest.
    if (drag.from !== col && multi) {
      const cur = Array.isArray(row.props?.[groupProp.id]) ? (row.props?.[groupProp.id] as string[]) : [];
      const kept = drag.from === undefined ? [] : cur.filter((x) => x !== drag.from);
      ctl.setValue(row, groupProp, col === "__none" ? [] : kept.includes(col) ? kept : [...kept, col]);
    } else if (drag.from !== col) ctl.setValue(row, groupProp, colValue(col));
    // A card dropped in another lane takes that lane's value too.
    if (subProp && lane && lane.value !== undefined && !(laneRows ?? []).some((r) => r.id === drag.id)) {
      const fresh = ctl.api.store.get(drag.id);
      if (fresh) ctl.setValue(fresh, subProp, lane.value);
    }
    if (drag.before && (ctl.view?.sorts.length ?? 0) === 0) {
      const g = groupRows(laneRows ?? ctl.rows, groupProp).find((x) => x.key === col);
      const list = (g?.rows ?? []).filter((r) => r.id !== drag.id);
      const i = list.findIndex((r) => r.id === drag.before);
      if (i >= 0) ctl.api.store.update(drag.id, { order: orderBetween(list[i - 1]?.order, list[i]?.order) }, { quiet: true });
    }
    setDrag(null);
  };
  const columns = (rows: Note[], lane?: RowGroup, withHidden = true) => {
    const laneKey = lane?.key;
    const extra = (col: string): Record<string, PropValue> => ({ [groupProp.id]: colValue(col), ...(subProp && lane && lane.value !== undefined ? { [subProp.id]: lane.value } : {}) });
    const { shown, hidden } = splitGroups(groupRows(rows, groupProp), ctl.view);
    const hiddenCol =
      withHidden && hidden.length > 0 ? (
        <div key="__hidden" className="nt-board-col nt-board-hidden">
          <div className="nt-board-head">
            <span className="nt-board-hidden-title">{t("db.hiddenGroups")}</span>
          </div>
          <HiddenGroupRows ctl={ctl} groups={hidden.map((g) => ({ ...g, label: t("db.noGroup", { prop: groupProp.name }) }))} status={groupProp.type === "status"} />
        </div>
      ) : null;
    return [...shown.map((g) =>
      g.key === "__none" && g.rows.length === 0 ? null : (
        <div
          key={g.key}
          className="nt-board-col"
          data-color={g.option && g.option.color !== "default" && !ctl.view?.plainCols ? g.option.color : undefined}
          data-drop={(drag?.col === g.key && drag.lane === laneKey) || undefined}
          data-col-drop={colDrag?.over === g.key ? (colDrag.after ? "r" : "l") : undefined}
          data-col-dragging={colDrag?.key === g.key || undefined}
          onDragOver={(e) => {
            if (colDrag) {
              if (!g.option || colDrag.key === g.key) return;
              const r = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > r.left + r.width / 2;
              if (!movedOptions(groupProp, colDrag.key, g.key, after)) return;
              e.preventDefault();
              if (colDrag.over !== g.key || colDrag.after !== after) setColDrag({ ...colDrag, over: g.key, after });
              return;
            }
            if (!drag) return;
            e.preventDefault();
            if (drag.col !== g.key || drag.lane !== laneKey) setDrag({ ...drag, col: g.key, lane: laneKey, before: undefined });
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (colDrag) {
              const next = colDrag.over ? movedOptions(groupProp, colDrag.key, colDrag.over, Boolean(colDrag.after)) : null;
              if (next) ctl.updateProp(groupProp.id, { options: next });
              setColDrag(null);
              return;
            }
            drop(g.key, lane, rows);
          }}
        >
          <div
            className="nt-board-head"
            draggable={Boolean(g.option) && !ctl.locked && groupProp.type !== "person"}
            onDragStart={(e) => {
              if ((e.target as HTMLElement).closest("button")) return e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", g.option?.name ?? "");
              setColDrag({ key: g.key });
            }}
            onDragEnd={() => setColDrag(null)}
          >
            {g.option ? (
              groupProp.type === "person" ? (
                <PersonChip id={g.option.id} />
              ) : (
                <Tag option={g.option} status={groupProp.type === "status"} />
              )
            ) : (
              <span style={{ color: "var(--nt-text-2)" }}>{t("db.noGroup", { prop: groupProp.name })}</span>
            )}
            <span className="nt-board-count">{g.rows.length}</span>
            <span className="nt-board-head-acts">
              <HideGroupButton ctl={ctl} groupKey={g.key} />
              {!ctl.readOnly && (
                <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("db.new")} onClick={() => ctl.addRow({ props: extra(g.key), stay: false })}>
                  <Plus size={14} />
                </button>
              )}
            </span>
          </div>
          <div className="nt-board-cards">
            {g.rows.map((row) => (
              <div
                key={row.id}
                className={cx("nt-card", drag?.col === g.key && drag.lane === laneKey && drag.before === row.id && "nt-card-drop-before")}
                data-ccolor={colorsOf(ctl, row).row}
                draggable={!ctl.readOnly}
                data-dragging={drag?.id === row.id || undefined}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", row.id);
                  setDrag({ id: row.id, from: g.key });
                }}
                onDragOver={(e) => {
                  if (!drag || drag.id === row.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (drag.before !== row.id || drag.col !== g.key || drag.lane !== laneKey) setDrag({ ...drag, col: g.key, lane: laneKey, before: row.id });
                }}
                onDrop={(e) => {
                  // A column dropped over a card belongs to the column.
                  if (colDrag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  drop(g.key, lane, rows);
                }}
                onDragEnd={() => setDrag(null)}
                onClick={() => ctl.openRow(row.id)}
              >
                <Preview row={row} mode={ctl.view?.preview ?? "none"} />
                <div className="nt-card-body">
                  <div className="nt-card-title">
                    {row.icon && !ctl.view?.hideIcons && <span className="nt-row-icon"><NoteIcon icon={row.icon} /></span>}
                    <span>{row.title || <span className="nt-cell-muted">{t("db.untitled")}</span>}</span>
                  </div>
                  <CardProps ctl={ctl} row={row} />
                </div>
                <CardMore ctl={ctl} row={row} />
              </div>
            ))}
          </div>
          {!ctl.readOnly && (
            <button type="button" className="nt-board-add nt-btn-reset" onClick={() => ctl.addRow({ props: extra(g.key), stay: false })}>
              <Plus />
              {t("db.new")}
            </button>
          )}
        </div>
      )
    ), hiddenCol];
  };
  const size = ctl.view?.cardSize ?? "medium";
  const fit = ctl.view?.fitImage || undefined;
  if (!lanes)
    return (
      <div className="nt-board" data-size={size} data-fit={fit}>
        {columns(ctl.rows)}
      </div>
    );
  return (
    <div className="nt-board-lanes" data-size={size} data-fit={fit}>
      {lanes.map((lane, li) => {
        const open = !collapsed.has(lane.key);
        return (
          <div key={lane.key} className="nt-board-lane">
            <div
              className="nt-tgroup-head nt-board-lane-head"
              role="button"
              onClick={() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(lane.key)) next.delete(lane.key);
                  else next.add(lane.key);
                  return next;
                })
              }
            >
              <ChevronRight className="nt-tgroup-chev" data-open={open || undefined} />
              {lane.option ? <Tag option={lane.option} status={subProp?.type === "status"} /> : <span className="nt-tgroup-label">{lane.label}</span>}
              <span className="nt-tgroup-count">{lane.rows.length}</span>
            </div>
            {open && <div className="nt-board">{columns(lane.rows, lane, li === 0)}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List

export function ListView({ ctl }: { ctl: DbCtl }) {
  const { t, locale } = ctl.api;
  const view = ctl.view;
  const groupProp = view?.groupBy ? ctl.schema?.properties.find((p) => p.id === view.groupBy && canGroupBy(p)) : undefined;
  const split = groupProp ? splitGroups(groupRowsFor(ctl.rows, groupProp, groupLabels(t, groupProp), locale, view), view) : null;
  const groups = split?.shown ?? null;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const dragProps = useRowDrag(ctl, ctl.rows);
  const row = (r: Note) => <ListRow key={r.id} ctl={ctl} row={r} dragProps={dragProps(r, "y")} />;
  // Notion's "Load limit": that many rows, then "Load more".
  const [extra, setExtra] = useState(0);
  const page = ctl.view?.limit ?? PAGE;
  const limit = page + extra;
  const more = (n: number) =>
    n > limit ? (
      <button type="button" className="nt-load-more nt-btn-reset" onClick={() => setExtra((x) => x + page * 2)}>
        <ChevronDown size={14} />
        {t("db.loadMoreN", { n: n - limit })}
      </button>
    ) : null;
  return (
    <div className="nt-list">
      {groups
        ? groups.map((g) => (
            <div key={g.key} className="nt-tgroup">
              <div
                className="nt-tgroup-head"
                role="button"
                onClick={() =>
                  setCollapsed((c) => {
                    const next = new Set(c);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  })
                }
              >
                <ChevronRight className="nt-tgroup-chev" data-open={!collapsed.has(g.key) || undefined} />
                {g.option ? <Tag option={g.option} status={groupProp?.type === "status"} /> : <span className="nt-tgroup-label">{g.label}</span>}
                <span className="nt-tgroup-count">{g.rows.length}</span>
                <HideGroupButton ctl={ctl} groupKey={g.key} />
              </div>
              {!collapsed.has(g.key) && g.rows.slice(0, limit).map(row)}
              {!collapsed.has(g.key) && more(g.rows.length)}
            </div>
          ))
        : ctl.rows.slice(0, limit).map(row)}
      {split && <HiddenGroups ctl={ctl} groups={split.hidden} status={groupProp?.type === "status"} />}
      {!groups && more(ctl.rows.length)}
      {!ctl.readOnly && (
        <button type="button" className="nt-table-new nt-btn-reset" style={{ width: "100%", boxShadow: "none" }} onClick={() => ctl.addRow({ stay: false })}>
          <Plus />
          {t("db.newRow")}
        </button>
      )}
    </div>
  );
}

/** Manual order by drag in lists and galleries (Notion: while the view has no sort). */
function useRowDrag(ctl: DbCtl, list: Note[]) {
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null);
  const manual = (ctl.view?.sorts.length ?? 0) === 0 && !ctl.readOnly;
  return (row: Note, axis: "x" | "y"): React.HTMLAttributes<HTMLDivElement> & Record<string, unknown> =>
    manual
      ? {
          draggable: true,
          "data-dragging": drag?.id === row.id || undefined,
          "data-drop": drag?.over === row.id ? (drag.after ? "after" : "before") : undefined,
          onDragStart: (e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", row.id);
            setDrag({ id: row.id });
          },
          onDragOver: (e) => {
            if (!drag || drag.id === row.id) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const after = axis === "x" ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
            if (drag.over !== row.id || drag.after !== after) setDrag({ ...drag, over: row.id, after });
          },
          onDrop: (e) => {
            e.preventDefault();
            if (drag?.over) {
              const rest = list.filter((r) => r.id !== drag.id);
              const at = rest.findIndex((r) => r.id === drag.over) + (drag.after ? 1 : 0);
              ctl.api.store.update(drag.id, { order: orderBetween(rest[at - 1]?.order, rest[at]?.order) }, { quiet: true });
            }
            setDrag(null);
          },
          onDragEnd: () => setDrag(null),
        }
      : {};
}

function ListRow({ ctl, row, dragProps }: { ctl: DbCtl; row: Note; dragProps?: React.HTMLAttributes<HTMLDivElement> }) {
  const { t } = ctl.api;
  const colors = colorsOf(ctl, row);
  return (
        <div className="nt-list-row" data-ccolor={colors.row} onClick={() => ctl.openRow(row.id)} {...dragProps}>
          <div className="nt-list-title">
            {!ctl.view?.hideIcons && <RowIcon row={row} />}
            <span>{row.title || t("db.untitled")}</span>
          </div>
          <div className="nt-list-props">
            {ctl.props
              .filter((p) => p.type !== "title" && (p.type === "button" || !isEmptyValue(propValue(row, p))))
              .slice(0, 4)
              .map((p) => (
                <span key={p.id} className="nt-list-prop" data-ccolor={colors.cells[p.id]}>
                  <CellValue prop={p} value={propValue(row, p)} row={row} compact />
                </span>
              ))}
          </div>
        </div>
  );
}

// ---------------------------------------------------------------------------
// Gallery

function Preview({ row, mode }: { row: Note; mode: "none" | "cover" | "content" }) {
  if (mode === "none") return null;
  const img = mode === "cover" ? (row.cover?.kind === "image" ? row.cover.value : "") : firstImage(row.content) || (row.cover?.kind === "image" ? row.cover.value : "");
  if (img) {
    return (
      <div className="nt-card-preview">
        <img src={img} alt="" loading="lazy" />
      </div>
    );
  }
  if (mode === "cover") return <div className="nt-card-preview" style={row.cover ? { background: coverCss(row.cover.value) } : undefined} />;
  const text = blocksText(row.content, 0, 600);
  return (
    <div className="nt-card-preview">
      <div className="nt-card-preview-text">{text}</div>
    </div>
  );
}

export function GalleryView({ ctl }: { ctl: DbCtl }) {
  const { t, locale } = ctl.api;
  const view = ctl.view;
  // Grouped galleries (Notion): a heading per group, its cards below.
  const groupProp = view?.groupBy ? ctl.schema?.properties.find((p) => p.id === view.groupBy && canGroupBy(p)) : undefined;
  const split = groupProp ? splitGroups(groupRowsFor(ctl.rows, groupProp, groupLabels(t, groupProp), locale, view), view) : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  if (split) {
    return (
      <div className="nt-gallery-groups">
        {split.shown.map((g) => (
          <div key={g.key} className="nt-tgroup">
            <div
              className="nt-tgroup-head"
              role="button"
              onClick={() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(g.key)) next.delete(g.key);
                  else next.add(g.key);
                  return next;
                })
              }
            >
              <ChevronRight className="nt-tgroup-chev" data-open={!collapsed.has(g.key) || undefined} />
              {g.option ? <Tag option={g.option} status={groupProp?.type === "status"} /> : <span className="nt-tgroup-label">{g.label}</span>}
              <span className="nt-tgroup-count">{g.rows.length}</span>
              <HideGroupButton ctl={ctl} groupKey={g.key} />
            </div>
            {!collapsed.has(g.key) && <GalleryGrid ctl={ctl} rows={g.rows} newProps={groupProp && g.value !== undefined ? { [groupProp.id]: g.value } : undefined} />}
          </div>
        ))}
        <HiddenGroups ctl={ctl} groups={split.hidden} status={groupProp?.type === "status"} />
      </div>
    );
  }
  return <GalleryGrid ctl={ctl} rows={ctl.rows} />;
}

/** Gallery cards; "New" adds a row (in a group: with its value). */
function GalleryGrid({ ctl, rows, newProps }: { ctl: DbCtl; rows: Note[]; newProps?: Record<string, PropValue> }) {
  const { t } = ctl.api;
  const mode = ctl.view?.preview ?? "content";
  const dragProps = useRowDrag(ctl, rows);
  return (
    <div className="nt-gallery" data-size={ctl.view?.cardSize ?? "medium"} data-fit={ctl.view?.fitImage || undefined}>
      {rows.map((row) => (
        <div key={row.id} className="nt-card" data-ccolor={colorsOf(ctl, row).row} onClick={() => ctl.openRow(row.id)} {...dragProps(row, "x")}>
          <Preview row={row} mode={mode} />
          <div className="nt-card-body">
            <div className="nt-card-title">
              {row.icon && !ctl.view?.hideIcons && <span className="nt-row-icon"><NoteIcon icon={row.icon} /></span>}
              <span>{row.title || <span className="nt-cell-muted">{t("db.untitled")}</span>}</span>
            </div>
            <CardProps ctl={ctl} row={row} />
          </div>
          <CardMore ctl={ctl} row={row} />
        </div>
      ))}
      {!ctl.readOnly && (
        <button type="button" className="nt-gallery-new nt-btn-reset" onClick={() => ctl.addRow({ stay: false, props: newProps })}>
          <Plus size={16} />
          {t("db.newRow")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function CalendarView({ ctl }: { ctl: DbCtl }) {
  const { t, locale } = ctl.api;
  const dateProp = ctl.schema?.properties.find((p) => p.id === ctl.view?.dateProp && p.type === "date") ?? ctl.schema?.properties.find((p) => p.type === "date");
  // The day the calendar is on; month view shows its month, week view its week.
  const [anchor, setAnchor] = useState(() => new Date());
  const [drag, setDrag] = useState<{ id: string; over?: string } | null>(null);
  const monday = useMondayFirst(locale);
  // Read-only members switch month / week for themselves (the view setting is shared).
  const [ownMode, setOwnMode] = useState<"week" | "month" | null>(null);
  const week = (ownMode ?? (ctl.view?.calMode === "week" ? "week" : "month")) === "week";
  const setMode = (mode: "week" | "month") => (ctl.readOnly ? setOwnMode(mode) : ctl.updateView({ calMode: mode === "week" ? "week" : undefined }));
  const ym = { y: anchor.getFullYear(), m: anchor.getMonth() };
  const weekStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - (monday ? (anchor.getDay() + 6) % 7 : anchor.getDay()));
  // "Show weekends" off drops the Saturday and Sunday columns.
  const noWeekends = Boolean(ctl.view?.noWeekends);
  const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
  const allDays = week ? Array.from({ length: 7 }, (_, i) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i)) : monthGrid(ym.y, ym.m, monday);
  const days = noWeekends ? allDays.filter((d) => !isWeekend(d)) : allDays;
  const dows = weekdayNames(locale, monday).filter((_, i) => !noWeekends || !isWeekend(allDays[i]));
  const shift = (dir: 1 | -1) => setAnchor((a) => (week ? new Date(a.getFullYear(), a.getMonth(), a.getDate() + dir * 7) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  const today = ymd(new Date());
  const byDay = useMemo(() => {
    const map = new Map<string, Note[]>();
    if (!dateProp) return map;
    for (const r of ctl.rows) {
      const v = r.props?.[dateProp.id] as DateValue | undefined;
      if (!v?.start) continue;
      const s = v.start.slice(0, 10);
      const e = (v.end ?? v.start).slice(0, 10);
      // Ranges show on every day they cover (bounded to 62 days).
      const start = new Date(`${s}T00:00:00`);
      for (let i = 0; i < 62; i++) {
        const d = ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
        // An end before the start (imported data) still shows the start day.
        if (i > 0 && d > e) break;
        const list = map.get(d) ?? [];
        list.push(r);
        map.set(d, list);
      }
    }
    return map;
  }, [ctl.rows, dateProp]);
  if (!dateProp) return <div className="nt-panel-empty" style={{ textAlign: "left", padding: "24px 4px" }}>{t("db.noDateProp")}</div>;
  const loc = intlOf(locale);
  const label = week
    ? `${days[0].toLocaleDateString(loc, { day: "numeric", month: "short" })} – ${days[days.length - 1].toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" })}`
    : new Date(ym.y, ym.m, 1).toLocaleDateString(loc, { month: "long", year: "numeric" });
  const move = (rowId: string, day: string) => {
    const row = ctl.api.snap.byId.get(rowId);
    if (!row) return;
    const v = row.props?.[dateProp.id] as DateValue | undefined;
    if (v?.start?.slice(0, 10) === day) return;
    // The time of day and the reminder move with the date.
    let next: DateValue = { start: day + (v?.start?.slice(10) ?? ""), ...(v?.remind ? { remind: v.remind } : {}) };
    if (v?.end && v.start) {
      const len = Math.round((new Date(`${v.end.slice(0, 10)}T00:00:00`).getTime() - new Date(`${v.start.slice(0, 10)}T00:00:00`).getTime()) / 86_400_000);
      const d = new Date(`${day}T00:00:00`);
      next = { ...next, end: ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + len)) + v.end.slice(10) };
    }
    ctl.setValue(row, dateProp, next);
  };
  return (
    <div className="nt-calendar">
      <div className="nt-calendar-head">
        <span className="nt-calendar-month">{week ? label : upperFirst(label)}</span>
        <select className="nt-fsel nt-calendar-mode" aria-label={t("db.calendar")} value={week ? "week" : "month"} onChange={(e) => setMode(e.target.value === "week" ? "week" : "month")}>
          <option value="month">{t("db.month")}</option>
          <option value="week">{t("db.week")}</option>
        </select>
        <button type="button" className="nt-db-tool nt-btn-reset" onClick={() => setAnchor(new Date())}>
          {t("db.today")}
        </button>
        <button type="button" className="nt-db-tool nt-btn-reset" aria-label={t("db.prev")} onClick={() => shift(-1)}>
          <ChevronLeft />
        </button>
        <button type="button" className="nt-db-tool nt-btn-reset" aria-label={t("db.next")} onClick={() => shift(1)}>
          <ChevronRight />
        </button>
      </div>
      <div className="nt-calendar-grid" data-week={week || undefined} data-days={noWeekends ? 5 : undefined}>
        {dows.map((w) => (
          <div key={w} className="nt-calendar-dow">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const k = ymd(d);
          const list = byDay.get(k) ?? [];
          return (
            <div
              key={k}
              className="nt-calendar-cell"
              data-other={(!week && d.getMonth() !== ym.m) || undefined}
              data-today={k === today || undefined}
              data-drop={drag?.over === k || undefined}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.over !== k) setDrag({ ...drag, over: k });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag) move(drag.id, k);
                setDrag(null);
              }}
            >
              {!ctl.readOnly && (
                <button type="button" className="nt-calendar-add nt-btn-reset" aria-label={t("db.new")} onClick={() => ctl.addRow({ props: { [dateProp.id]: { start: k } }, stay: false })}>
                  <Plus />
                </button>
              )}
              <span className="nt-calendar-num">{d.getDate() === 1 || (week && d === days[0]) ? d.toLocaleDateString(loc, { month: "short", day: "numeric" }) : d.getDate()}</span>
              {(week ? list : list.slice(0, 4)).map((r) => (
                <div
                  key={r.id}
                  className="nt-calendar-event"
                  draggable={!ctl.readOnly}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", r.id);
                    setDrag({ id: r.id });
                  }}
                  onDragEnd={() => setDrag(null)}
                  onClick={() => ctl.openRow(r.id)}
                >
                  {r.icon && !ctl.view?.hideIcons && <span><NoteIcon icon={r.icon} /></span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{displayTitle(r, t("db.untitled"))}</span>
                </div>
              ))}
              {!week && list.length > 4 && (
                // Notion: the rest of a busy day opens in the week view.
                <button
                  type="button"
                  className="nt-calendar-more nt-btn-reset"
                  onClick={() => {
                    setAnchor(d);
                    setMode("week");
                  }}
                >
                  {t("db.more", { n: list.length - 4 })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

