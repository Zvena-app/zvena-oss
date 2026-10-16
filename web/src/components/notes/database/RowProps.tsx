"use client";

// A database row opened as a page: its properties under the title (Notion's
// property list), with "N more properties" for hidden ones. The database's
// page layout (Notion's "Customize layout", components/notes/database/
// layout.tsx) pins up to four of them under the title, groups the rest in
// sections, and may put the panel beside the page body. Loaded with the
// database code, after the page itself.

import "./views.css";
import { useState } from "react";
import { ChevronDown, ChevronRight, LayoutTemplate, Plus } from "lucide-react";
import { useDatabase } from "./useDatabase";
import { CellValue, PropIcon, TextCellInput, parseTextValue, textOf } from "./cells";
import { useCellEdit } from "./views";
import { PropertyMenu } from "./PropertyMenu";
import { LayoutEditor } from "./layout";
import { isEmptyValue, propValue } from "@/lib/notes/db";
import type { DbProperty, Note } from "@/lib/notes/types";

/** `readOnly`: the page cannot be edited right now (e.g. too many editors). `side`: the panel beside the body. */
export function RowProps({ row, readOnly, side }: { row: Note; readOnly?: boolean; side?: boolean }) {
  const ctl = useDatabase(row.parentId as string);
  // A row page in the trash or locked keeps its properties as they are.
  const frozen = Boolean(readOnly) || row.trashedAt !== null || Boolean(row.style?.locked);
  const { t } = ctl.api;
  const edit = useCellEdit(ctl);
  const [propMenu, setPropMenu] = useState<{ prop: DbProperty; el: HTMLElement } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [customize, setCustomize] = useState<HTMLElement | null>(null);
  if (!ctl.schema) return null;
  // The database's rows carry computed values (formulas, rollups, relation titles).
  const shown = ctl.allRows.find((r) => r.id === row.id) ?? row;
  const layout = ctl.schema.layout;
  const pinned = new Set(layout?.header ?? []);
  const byId = new Map(ctl.schema.properties.map((p) => [p.id, p]));
  // A wiki page shows its verification in the bar under the title (VerifyBar).
  const all = ctl.schema.properties.filter((p) => p.type !== "title" && !pinned.has(p.id) && !(ctl.schema?.wiki && p.type === "verification"));
  const sections = layout?.sections ?? [];
  const grouped = new Set(sections.flatMap((s) => s.props));
  const loose = all.filter((p) => !grouped.has(p.id));
  const isEditing = (p: DbProperty) => edit.editing?.propId === p.id;
  // "Property visibility": hidden always, or while empty (and not being edited).
  const isHidden = (p: DbProperty) => p.pageVis === "hide" || (p.pageVis === "hideEmpty" && isEmptyValue(propValue(shown, p)) && !isEditing(p));
  const hidden = loose.filter(isHidden);
  const props = showHidden ? loose : loose.filter((p) => !isHidden(p));
  const editable = !ctl.locked && !frozen;
  const line = (p: DbProperty) => {
    const inline = edit.inlineFor(row, p);
    const v = propValue(shown, p);
    return (
      <div key={p.id} className="nt-prop">
        <div className="nt-prop-name" title={p.description || undefined} onClick={(e) => !ctl.readOnly && !frozen && setPropMenu({ prop: p, el: e.currentTarget })}>
          <PropIcon type={p.type} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
        </div>
        <div className="nt-prop-value" onClick={(e) => !inline && !frozen && edit.start(row, p, e.currentTarget)}>
          {inline ? (
            <TextCellInput
              initial={textOf(p, row)}
              type={p.type}
              multiline={p.type === "text"}
              onCancel={() => edit.setEditing(null)}
              onCommit={(val) => {
                const next = parseTextValue(p.type, val);
                if (next !== undefined) ctl.setValue(row, p, next);
                edit.setEditing(null);
              }}
            />
          ) : isEmptyValue(v) && p.type !== "checkbox" && p.type !== "button" ? (
            <span className="nt-cell-muted">{t("db.empty")}</span>
          ) : (
            <CellValue prop={p} value={v} row={shown} />
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="nt-props" data-side={side || undefined}>
      {props.map(line)}
      {hidden.length > 0 && (
        <button type="button" className="nt-prop-add nt-prop-more nt-btn-reset" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
          <ChevronDown style={{ transform: showHidden ? "rotate(180deg)" : undefined }} />
          {showHidden ? t("db.hideHiddenProps", { n: hidden.length }) : t("db.moreProps", { n: hidden.length })}
        </button>
      )}
      {sections.map((s) => {
        const list = s.props
          .map((id) => byId.get(id))
          .filter((p): p is DbProperty => Boolean(p) && !pinned.has((p as DbProperty).id))
          .filter((p) => p.pageVis !== "hide" && !((s.hideEmpty || p.pageVis === "hideEmpty") && isEmptyValue(propValue(shown, p)) && !isEditing(p)));
        const isOpen = open[s.id] ?? !s.collapsed;
        return (
          <div key={s.id} className="nt-props-section">
            <button type="button" className="nt-props-section-head nt-btn-reset" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [s.id]: !isOpen }))}>
              <ChevronRight style={{ transform: isOpen ? "rotate(90deg)" : undefined }} />
              <span>{s.name || t("layout.untitledSection")}</span>
            </button>
            {isOpen && list.map(line)}
          </div>
        );
      })}
      {editable && (
        <div className="nt-props-actions">
          <button
            type="button"
            className="nt-prop-add nt-btn-reset"
            onClick={(e) => {
              const p = ctl.addProp("text");
              const el = e.currentTarget;
              setTimeout(() => setPropMenu({ prop: p, el }), 0);
            }}
          >
            <Plus />
            {t("db.addProp")}
          </button>
          <button type="button" className="nt-prop-add nt-btn-reset" onClick={(e) => setCustomize(e.currentTarget)}>
            <LayoutTemplate />
            {t("layout.customize")}
          </button>
        </div>
      )}
      {edit.popover}
      {propMenu && <PropertyMenu ctl={ctl} prop={propMenu.prop} anchor={propMenu.el} onClose={() => setPropMenu(null)} />}
      {customize && <LayoutEditor ctl={ctl} anchor={customize} onClose={() => setCustomize(null)} />}
    </div>
  );
}

/** Properties pinned under a row page's title (the layout's header), as Notion shows them. */
export function RowHeaderProps({ row, readOnly }: { row: Note; readOnly?: boolean }) {
  const ctl = useDatabase(row.parentId as string);
  const edit = useCellEdit(ctl);
  const frozen = Boolean(readOnly) || row.trashedAt !== null || Boolean(row.style?.locked);
  const ids = ctl.schema?.layout?.header ?? [];
  if (!ctl.schema || ids.length === 0) return null;
  const shown = ctl.allRows.find((r) => r.id === row.id) ?? row;
  const props = ids.map((id) => ctl.schema?.properties.find((p) => p.id === id)).filter((p): p is DbProperty => Boolean(p));
  return (
    <div className="nt-props-pinned">
      {props.map((p) => {
        const v = propValue(shown, p);
        const inline = edit.inlineFor(row, p);
        return (
          <div key={p.id} className="nt-props-pin" title={p.name} onClick={(e) => !inline && !frozen && edit.start(row, p, e.currentTarget)}>
            <PropIcon type={p.type} size={14} />
            {inline ? (
              <TextCellInput
                initial={textOf(p, row)}
                type={p.type}
                onCancel={() => edit.setEditing(null)}
                onCommit={(val) => {
                  const next = parseTextValue(p.type, val);
                  if (next !== undefined) ctl.setValue(row, p, next);
                  edit.setEditing(null);
                }}
              />
            ) : isEmptyValue(v) && p.type !== "checkbox" ? (
              <span className="nt-cell-muted">{p.name}</span>
            ) : (
              <CellValue prop={p} value={v} compact />
            )}
          </div>
        );
      })}
      {edit.popover}
    </div>
  );
}
