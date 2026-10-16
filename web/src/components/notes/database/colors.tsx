"use client";

// Notion's conditional color (view settings → "Conditional color"): rules,
// top first, that color a row or card — or only one property's cell — when
// all their conditions hold. Rules are saved in the view (each view of each
// data source has its own); lib/notes/db.ts rowColors() applies them.

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { Popover } from "../ui";
import { RuleRow, newRule } from "./filters";
import { shortId } from "@/lib/notes/model";
import { MAX_COLOR_RULES, NOTE_COLORS, type ColorRule, type DbView } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";

export const RULE_COLORS = NOTE_COLORS.filter((c): c is ColorRule["color"] => c !== "default");

/** Layouts with conditional color (Notion: tables, boards, lists and galleries). */
export const COLOR_LAYOUTS: readonly DbView["type"][] = ["table", "board", "list", "gallery"];

function RuleCard({ ctl, rule, index, count, onChange, onRemove, onMove }: { ctl: DbCtl; rule: ColorRule; index: number; count: number; onChange: (r: ColorRule) => void; onRemove: () => void; onMove: (by: -1 | 1) => void }) {
  const { t } = ctl.api;
  const props = (ctl.schema?.properties ?? []).filter((p) => p.type !== "button");
  const first = props[0];
  const isCard = ctl.view?.type === "board" || ctl.view?.type === "gallery";
  return (
    <div className="nt-ccolor-rule" data-testid="color-rule">
      <div className="nt-ccolor-head">
        <span className="nt-ccolor-swatch" data-color={rule.color} aria-hidden="true" />
        <select className="nt-fsel" aria-label={t("ccolor.color")} value={rule.color} onChange={(e) => onChange({ ...rule, color: e.target.value as ColorRule["color"] })}>
          {RULE_COLORS.map((c) => (
            <option key={c} value={c}>
              {t(`color.${c}` as NotesKey)}
            </option>
          ))}
        </select>
        <select className="nt-fsel" aria-label={t("ccolor.applyTo")} value={rule.prop ?? ""} onChange={(e) => onChange(e.target.value ? { ...rule, prop: e.target.value } : { id: rule.id, color: rule.color, filters: rule.filters })}>
          <option value="">{t(isCard ? "ccolor.card" : "ccolor.row")}</option>
          {props.map((p) => (
            <option key={p.id} value={p.id}>
              {t("ccolor.cellOf", { prop: p.name })}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("ccolor.up")} title={t("ccolor.up")} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp size={14} />
        </button>
        <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("ccolor.down")} title={t("ccolor.down")} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown size={14} />
        </button>
        <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("ccolor.remove")} title={t("ccolor.remove")} onClick={onRemove}>
          <Trash2 size={14} />
        </button>
      </div>
      <div className="nt-ccolor-when">{t("ccolor.when")}</div>
      {rule.filters.map((f, i) => (
        <div key={f.id} className="nt-ccolor-cond">
          {i > 0 && <span className="nt-ccolor-and">{t("db.and")}</span>}
          <RuleRow ctl={ctl} rule={f} onChange={(next) => onChange({ ...rule, filters: rule.filters.map((x) => (x.id === f.id ? next : x)) })} />
          <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("db.removeRule")} title={t("db.removeRule")} onClick={() => onChange({ ...rule, filters: rule.filters.filter((x) => x.id !== f.id) })}>
            <X size={14} />
          </button>
        </div>
      ))}
      {first && (
        <button type="button" className="nt-advf-add nt-btn-reset" onClick={() => onChange({ ...rule, filters: [...rule.filters, newRule(first)] })}>
          <Plus />
          {t("ccolor.addCondition")}
        </button>
      )}
    </div>
  );
}

/** The "Conditional color" panel of the current view. */
export function ColorRulesPanel({ ctl, anchor, onClose }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const view = ctl.view;
  const first = ctl.schema?.properties.find((p) => p.type !== "button");
  if (!view || !first) return null;
  const rules = view.colors ?? [];
  const set = (next: ColorRule[]) => {
    ctl.updateView({ colors: next.length ? next : undefined });
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="left-start" className="nt-advf-pop">
      <div className="nt-ccolor" data-testid="color-panel">
        <div className="nt-menu-label">{t("ccolor.title")}</div>
        {rules.length === 0 && <div className="nt-advf-empty">{t("ccolor.empty")}</div>}
        {rules.map((r, i) => (
          <RuleCard
            key={r.id}
            ctl={ctl}
            rule={r}
            index={i}
            count={rules.length}
            onChange={(next) => set(rules.map((x) => (x.id === r.id ? next : x)))}
            onRemove={() => set(rules.filter((x) => x.id !== r.id))}
            onMove={(by) => {
              const next = [...rules];
              const j = i + by;
              if (j < 0 || j >= next.length) return;
              [next[i], next[j]] = [next[j], next[i]];
              set(next);
            }}
          />
        ))}
        <div className="nt-advf-foot">
          {rules.length < MAX_COLOR_RULES && (
            <button type="button" className="nt-advf-add nt-btn-reset" onClick={() => set([...rules, { id: shortId(), color: "red", filters: [newRule(first)] }])}>
              <Plus />
              {t("ccolor.add")}
            </button>
          )}
        </div>
      </div>
    </Popover>
  );
}
