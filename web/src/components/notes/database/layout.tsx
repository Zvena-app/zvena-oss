"use client";

// Notion's "Customize layout" for a database's pages: where the property
// panel goes (above the content or beside it), up to four properties pinned
// under the title, and property groups (named, folded by default or not,
// hiding their empty properties). It applies to every page of the database.

import { ArrowDown, ArrowUp, PanelRight, PanelTop, Plus, Trash2 } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { PropIcon } from "./cells";
import { Popover } from "../ui";
import { shortId } from "@/lib/notes/model";
import { MAX_PINNED, withPinned, withPropInSection } from "@/lib/notes/dbviews";
import type { LayoutSection, PageLayout } from "@/lib/notes/types";

export function LayoutEditor({ ctl, anchor, onClose }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const layout: PageLayout = ctl.schema?.layout ?? {};
  const props = (ctl.schema?.properties ?? []).filter((p) => p.type !== "title");
  const pinned = layout.header ?? [];
  const sections = layout.sections ?? [];
  const save = (next: PageLayout) => ctl.updateSchema((s) => ({ ...s, layout: next }));
  const setSection = (id: string, patch: Partial<LayoutSection>) => save({ ...layout, sections: sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const moveSection = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    save({ ...layout, sections: next });
  };
  const sectionOf = (propId: string) => sections.find((s) => s.props.includes(propId))?.id ?? "";

  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-start">
      <div className="nt-layout-editor" role="dialog" aria-label={t("layout.title")}>
        <div className="nt-layout-title">{t("layout.title")}</div>

        <div className="nt-menu-label">{t("layout.panel")}</div>
        <div className="nt-layout-choice" role="radiogroup" aria-label={t("layout.panel")}>
          {(
            [
              ["top", "layout.top", <PanelTop key="t" />],
              ["side", "layout.side", <PanelRight key="s" />],
            ] as const
          ).map(([k, label, icon]) => (
            <button
              type="button"
              key={k}
              role="radio"
              aria-checked={(layout.panel ?? "top") === k}
              className="nt-layout-option nt-btn-reset"
              data-on={(layout.panel ?? "top") === k || undefined}
              onClick={() => save({ ...layout, panel: k === "side" ? "side" : undefined })}
            >
              {icon}
              <span>{t(label)}</span>
            </button>
          ))}
        </div>

        <div className="nt-menu-label">{t("layout.header")}</div>
        <div className="nt-layout-hint">{t("layout.headerHint")}</div>
        <div className="nt-layout-list">
          {props.map((p) => {
            const on = pinned.includes(p.id);
            return (
              <label key={p.id} className="nt-mi nt-layout-row">
                <span className="nt-mi-icon">
                  <PropIcon type={p.type} />
                </span>
                <span className="nt-mi-label">{p.name}</span>
                <input type="checkbox" checked={on} disabled={!on && pinned.length >= MAX_PINNED} onChange={(e) => save(withPinned(layout, p.id, e.target.checked))} />
              </label>
            );
          })}
        </div>

        <div className="nt-menu-label">{t("layout.sections")}</div>
        {sections.map((s, i) => (
          <div key={s.id} className="nt-layout-section">
            <div className="nt-layout-section-head">
              <input className="nt-input" value={s.name} placeholder={t("layout.untitledSection")} aria-label={t("layout.untitledSection")} onChange={(e) => setSection(s.id, { name: e.target.value.slice(0, 100) })} />
              <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("layout.moveUp")} title={t("layout.moveUp")} disabled={i === 0} onClick={() => moveSection(i, -1)}>
                <ArrowUp />
              </button>
              <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("layout.moveDown")} title={t("layout.moveDown")} disabled={i === sections.length - 1} onClick={() => moveSection(i, 1)}>
                <ArrowDown />
              </button>
              <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("layout.deleteSection")} title={t("layout.deleteSection")} onClick={() => save({ ...layout, sections: sections.filter((x) => x.id !== s.id) })}>
                <Trash2 />
              </button>
            </div>
            <label className="nt-layout-toggle">
              <input type="checkbox" checked={Boolean(s.hideEmpty)} onChange={(e) => setSection(s.id, { hideEmpty: e.target.checked || undefined })} />
              {t("layout.hideEmpty")}
            </label>
            <label className="nt-layout-toggle">
              <input type="checkbox" checked={Boolean(s.collapsed)} onChange={(e) => setSection(s.id, { collapsed: e.target.checked || undefined })} />
              {t("layout.collapsed")}
            </label>
          </div>
        ))}
        <button type="button" className="nt-mi nt-btn-reset" onClick={() => save({ ...layout, sections: [...sections, { id: shortId(), name: "", props: [] }] })}>
          <span className="nt-mi-icon">
            <Plus />
          </span>
          <span className="nt-mi-label">{t("layout.addSection")}</span>
        </button>

        {sections.length > 0 && (
          <div className="nt-layout-list">
            {props
              .filter((p) => !pinned.includes(p.id))
              .map((p) => (
                <label key={p.id} className="nt-mi nt-layout-row">
                  <span className="nt-mi-icon">
                    <PropIcon type={p.type} />
                  </span>
                  <span className="nt-mi-label">{p.name}</span>
                  <select className="nt-input nt-layout-select" aria-label={t("layout.group")} value={sectionOf(p.id)} onChange={(e) => save(withPropInSection(layout, p.id, e.target.value || null))}>
                    <option value="">{t("layout.noSection")}</option>
                    {sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || t("layout.untitledSection")}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
          </div>
        )}
        <div className="nt-layout-foot">
          <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" onClick={onClose}>
            {t("layout.done")}
          </button>
        </div>
      </div>
    </Popover>
  );
}
