"use client";

// Notion's Dashboard view: widgets in rows of four columns, each one a view
// of this database (a chart, a table, a board…) with its own filters, sorts
// and layout. Widget views live in the database with the scope
// "dash:<dashboard view id>", so they never show as tabs; each widget's own
// "•••" renames, resizes, moves or removes it. Editors only change it.

import { useState, type ComponentType, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Columns3, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { Menu, Popover } from "../ui";
import { dashScope, shortId } from "@/lib/notes/model";
import { newWidgetView, withWidgets } from "@/lib/notes/dbviews";
import type { DashboardWidget, DbSchema, DbView, ViewType } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { SourceIcon } from "./sources";

const WIDGET_TYPES: readonly ViewType[] = ["chart", "table", "board", "list", "gallery", "calendar", "timeline", "map", "feed"];

export function DashboardView({ ctl, renderWidget, Icon }: { ctl: DbCtl; renderWidget: (viewId: string) => ReactNode; Icon: ComponentType<{ type: ViewType; size?: number }> }) {
  const { t } = ctl.api;
  const view = ctl.view as DbView;
  const schema = ctl.schema as DbSchema;
  const scope = dashScope(view.id);
  const own = new Map(schema.views.filter((v) => v.scope === scope).map((v) => [v.id, v]));
  const widgets = (view.dashboard?.widgets ?? []).filter((w) => own.has(w.viewId));
  const editable = !ctl.locked;
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [widthMenu, setWidthMenu] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // Several data sources: a new widget shows the one picked (Notion's dashboards mix sources).
  const [widgetSource, setWidgetSource] = useState<string | null>(null);
  const hostId = ctl.host?.id ?? "";
  const pickedSource = ctl.sources.find((x) => x.id === (widgetSource ?? ctl.srcId) && x.note?.db) ?? ctl.sources[0];
  const update = (fn: (w: DashboardWidget[]) => DashboardWidget[], opts?: { add?: DbView[]; drop?: string[] }) => ctl.updateSchema((s) => withWidgets(s, view.id, fn, opts));
  const add = (type: ViewType) => {
    const srcSchema = pickedSource?.note?.db ?? schema;
    const v = newWidgetView(type, t(`db.${type}` as NotesKey), srcSchema, view.id);
    if (pickedSource && pickedSource.id !== hostId) v.source = pickedSource.id;
    update((list) => [...list, { id: shortId(), viewId: v.id, width: type === "chart" ? 2 : 4 }], { add: [v] });
    setAdding(null);
  };
  const move = (id: string, by: -1 | 1) =>
    update((list) => {
      const i = list.findIndex((w) => w.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const rename = (viewId: string, name: string) => ctl.updateSchema((s) => ({ ...s, views: s.views.map((v) => (v.id === viewId ? { ...v, name: name.trim().slice(0, 200) } : v)) }));
  const current = menu ? widgets.find((w) => w.id === menu.id) : undefined;

  return (
    <div className="nt-dash">
      {widgets.length === 0 && (
        <div className="nt-dash-empty">
          <span>{t("dash.empty")}</span>
        </div>
      )}
      <div className="nt-dash-grid">
        {widgets.map((w) => {
          const v = own.get(w.viewId) as DbView;
          return (
            <section key={w.id} className="nt-dash-widget" style={{ gridColumn: `span ${w.width}` }} data-width={w.width}>
              <header className="nt-dash-head">
                <span className="nt-dash-icon">
                  <Icon type={v.type} size={14} />
                </span>
                {renaming?.id === v.id ? (
                  <input
                    className="nt-input nt-dash-rename"
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: v.id, name: e.target.value })}
                    onBlur={() => (renaming.name.trim() && rename(v.id, renaming.name), setRenaming(null))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="nt-dash-title">{v.name || t(`db.${v.type}` as NotesKey)}</span>
                )}
                {editable && (
                  <button type="button" className="nt-db-tool nt-dash-more nt-btn-reset" aria-label={t("dash.settings")} title={t("dash.settings")} onClick={(e) => setMenu({ id: w.id, el: e.currentTarget })}>
                    <MoreHorizontal />
                  </button>
                )}
              </header>
              <div className="nt-dash-body">{renderWidget(v.id)}</div>
            </section>
          );
        })}
        {editable && (
          <button type="button" className="nt-dash-add nt-btn-reset" onClick={(e) => setAdding(e.currentTarget)}>
            <Plus />
            {t("dash.add")}
          </button>
        )}
      </div>
      {adding && (
        <Popover anchor={adding} onClose={() => (setAdding(null), setWidgetSource(null))}>
          <Menu
            width={240}
            groups={[
              ...(ctl.sources.length > 1
                ? [
                    {
                      key: "src",
                      label: t("src.newViewOf"),
                      items: ctl.sources.map((x) => ({
                        key: `src-${x.id}`,
                        label: x.note ? x.name : t("src.noAccess"),
                        icon: <SourceIcon icon={x.icon} />,
                        checked: x.id === pickedSource?.id,
                        disabled: !x.note?.db,
                        onSelect: () => setWidgetSource(x.id),
                      })),
                    },
                  ]
                : []),
              {
                key: "w",
                label: t("dash.add"),
                items: WIDGET_TYPES.map((type) => ({ key: type, label: t(`db.${type}` as NotesKey), icon: <Icon type={type} />, onSelect: () => add(type) })),
              },
            ]}
          />
        </Popover>
      )}
      {menu && current && (
        <Popover anchor={menu.el} placement="bottom-end" onClose={() => (setMenu(null), setWidthMenu(null))}>
          <Menu
            width={220}
            groups={[
              {
                key: "m",
                items: [
                  {
                    key: "rename",
                    label: t("dash.rename"),
                    icon: <Pencil />,
                    onSelect: () => {
                      const v = own.get(current.viewId);
                      setRenaming({ id: current.viewId, name: v?.name ?? "" });
                      setMenu(null);
                    },
                  },
                  { key: "width", label: t("dash.width"), icon: <Columns3 />, hint: t("dash.cols", { n: current.width }), submenu: true, onSelect: (el: HTMLElement) => setWidthMenu(el) },
                  ...(widgets.indexOf(current) > 0 ? [{ key: "left", label: t("dash.moveLeft"), icon: <ArrowLeft />, onSelect: () => (move(current.id, -1), setMenu(null)) }] : []),
                  ...(widgets.indexOf(current) < widgets.length - 1 ? [{ key: "right", label: t("dash.moveRight"), icon: <ArrowRight />, onSelect: () => (move(current.id, 1), setMenu(null)) }] : []),
                ],
              },
              {
                key: "d",
                items: [
                  {
                    key: "remove",
                    label: t("dash.remove"),
                    icon: <Trash2 />,
                    danger: true,
                    onSelect: () => {
                      update((list) => list.filter((w) => w.id !== current.id), { drop: [current.viewId] });
                      setMenu(null);
                    },
                  },
                ],
              },
            ]}
          />
          {widthMenu && (
            <Popover anchor={widthMenu} placement="left-start" onClose={() => setWidthMenu(null)}>
              <Menu
                width={180}
                groups={[
                  {
                    key: "w",
                    items: ([1, 2, 3, 4] as const).map((n) => ({
                      key: String(n),
                      label: t("dash.cols", { n }),
                      checked: current.width === n,
                      onSelect: () => {
                        update((list) => list.map((w) => (w.id === current.id ? { ...w, width: n } : w)));
                        setWidthMenu(null);
                        setMenu(null);
                      },
                    })),
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
