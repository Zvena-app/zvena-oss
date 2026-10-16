"use client";

// Database filters: the operators each property type offers, and Notion's
// advanced filter (rules and groups joined by "and" / "or", nested twice).

import { useState } from "react";
import { Copy, Layers, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { Menu, Popover } from "../ui";
import { filterNeedsValue, isPeopleType } from "@/lib/notes/db";
import { ME } from "@/lib/notes/people";
import { usePeople } from "../people";
import { useNotes } from "../context";
import { shortId } from "@/lib/notes/model";
import { MAX_FILTER_DEPTH, isFilterGroup, type DbFilter, type DbFilterGroup, type DbProperty, type FilterOp } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { DATE_TOKENS, WITHIN_TOKENS, isDateToken } from "@/lib/notes/date-filter";

const DATE_OPS: readonly FilterOp[] = ["is", "before", "after", "on_or_before", "on_or_after"];
export const isDateType = (t: string) => t === "date" || t === "created_time" || t === "last_edited_time";

/** A date rule's value, as Notion offers it: Today, One week ago… or an exact date; "relative to today" picks a range. */
export function DateRuleValue({ op, value, onChange, className = "nt-fsel nt-advf-value" }: { op: FilterOp; value: string; onChange: (v: string) => void; className?: string }) {
  const { t } = useNotes();
  if (op === "within")
    return (
      <select className={className} value={value} onChange={(e) => onChange(e.target.value)} data-test="filter-within">
        <option value="">{t("db.valuePlaceholder")}</option>
        {WITHIN_TOKENS.map((k) => (
          <option key={k} value={k}>
            {t(`within.${k}` as NotesKey)}
          </option>
        ))}
      </select>
    );
  if (!DATE_OPS.includes(op)) return null;
  const exact = !isDateToken(value) && value !== "";
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
      <select className={className} value={exact ? "__exact" : value} onChange={(e) => onChange(e.target.value === "__exact" ? new Date().toISOString().slice(0, 10) : e.target.value)} data-test="filter-day">
        <option value="">{t("db.valuePlaceholder")}</option>
        {DATE_TOKENS.map((k) => (
          <option key={k} value={k}>
            {t(`datetok.${k}` as NotesKey)}
          </option>
        ))}
        <option value="__exact">{t("datetok.exact")}</option>
      </select>
      {exact && <input className="nt-input nt-advf-value" type="date" value={value} onChange={(e) => onChange(e.target.value)} />}
    </span>
  );
}

/** How a date rule's value reads on its chip ("Today", "Past week", or the date). */
export function dateValueLabel(t: (k: NotesKey) => string, value: string): string {
  if (isDateToken(value)) return t(`datetok.${value}` as NotesKey);
  if ((WITHIN_TOKENS as readonly string[]).includes(value)) return t(`within.${value}` as NotesKey);
  return value;
}

export const OPS_BY_TYPE: Record<string, FilterOp[]> = {
  text: ["contains", "not_contains", "is", "is_not", "starts_with", "ends_with", "empty", "not_empty"],
  title: ["contains", "not_contains", "is", "is_not", "starts_with", "ends_with", "empty", "not_empty"],
  url: ["contains", "not_contains", "is", "empty", "not_empty"],
  email: ["contains", "not_contains", "is", "empty", "not_empty"],
  phone: ["contains", "is", "empty", "not_empty"],
  number: ["is", "is_not", "gt", "lt", "gte", "lte", "empty", "not_empty"],
  select: ["is", "is_not", "empty", "not_empty"],
  status: ["is", "is_not", "empty", "not_empty"],
  multi_select: ["contains", "not_contains", "empty", "not_empty"],
  date: ["is", "before", "after", "on_or_before", "on_or_after", "within", "empty", "not_empty"],
  created_time: ["is", "before", "after", "on_or_before", "on_or_after", "within"],
  last_edited_time: ["is", "before", "after", "on_or_before", "on_or_after", "within"],
  checkbox: ["checked", "unchecked"],
  formula: ["contains", "not_contains", "is", "is_not", "gt", "lt", "gte", "lte", "before", "after", "on_or_before", "on_or_after", "within", "checked", "unchecked", "empty", "not_empty"],
  rollup: ["is", "is_not", "gt", "lt", "gte", "lte", "contains", "before", "after", "on_or_before", "on_or_after", "within", "empty", "not_empty"],
  relation: ["contains", "not_contains", "empty", "not_empty"],
  files: ["empty", "not_empty"],
  unique_id: ["is", "gt", "lt", "gte", "lte"],
  person: ["contains", "not_contains", "empty", "not_empty"],
  created_by: ["contains", "not_contains"],
  last_edited_by: ["contains", "not_contains"],
  place: ["contains", "not_contains", "empty", "not_empty"],
  verification: ["is", "is_not"],
};

/** A Verification rule's values (Notion's Verified / Expired / None). */
export const VERIFY_STATES = ["verified", "expired", "unverified"] as const;

/** The operator a new rule on this property starts with. */
export function defaultOp(p: DbProperty): FilterOp {
  if (p.type === "checkbox") return "checked";
  if (p.type === "select" || p.type === "status" || p.type === "number" || p.type === "rollup" || p.type === "unique_id" || p.type === "verification") return "is";
  if (p.type === "date" || p.type === "created_time" || p.type === "last_edited_time") return "after";
  if (p.type === "files") return "not_empty";
  return "contains";
}

export const newRule = (p: DbProperty): DbFilter => ({ id: shortId(), prop: p.id, op: defaultOp(p), value: "" });

/** "3 rules" / "3 правила" (Russian has three plural forms). */
export function rulesLabel(t: DbCtl["api"]["t"], locale: string, n: number): string {
  const ru = locale === "ru";
  const m10 = n % 10;
  const m100 = n % 100;
  const form = ru ? (m10 === 1 && m100 !== 11 ? "one" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "few" : "many") : n === 1 ? "one" : "many";
  return t(`db.rules.${form}` as NotesKey, { n });
}

/** Rules in an advanced filter (groups count their rules). */
export function countRules(g: DbFilterGroup | undefined): number {
  if (!g) return 0;
  return g.items.reduce((n, x) => n + (isFilterGroup(x) ? countRules(x) : 1), 0);
}

/** A person rule's value: "Me" or a member. */
function PeopleRuleValue({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { t } = useNotes();
  const list = usePeople();
  return (
    <select className="nt-fsel nt-advf-value" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      <option value={ME}>{t("people.me")}</option>
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function VerifyRuleValue({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { t } = useNotes();
  return (
    <select className="nt-fsel nt-advf-value" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {VERIFY_STATES.map((s) => (
        <option key={s} value={s}>
          {t(`verify.${s}` as NotesKey)}
        </option>
      ))}
    </select>
  );
}

function RuleValue({ prop, rule, onChange, placeholder }: { prop: DbProperty; rule: DbFilter; onChange: (v: string) => void; placeholder: string }) {
  const v = rule.value ?? "";
  if (isPeopleType(prop.type)) return <PeopleRuleValue value={v} onChange={onChange} placeholder={placeholder} />;
  if (prop.type === "verification") return <VerifyRuleValue value={v} onChange={onChange} placeholder={placeholder} />;
  if (isDateType(prop.type) || rule.op === "within" || ((rule.op === "on_or_before" || rule.op === "on_or_after" || rule.op === "before" || rule.op === "after") && (prop.type === "formula" || prop.type === "rollup")))
    return <DateRuleValue op={rule.op} value={v} onChange={onChange} />;
  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select")
    return (
      <select className="nt-fsel nt-advf-value" value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {(prop.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  const num = prop.type === "number" || prop.type === "unique_id";
  return <input className="nt-input nt-advf-value" type={num ? "number" : "text"} value={v} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function RuleRow({ ctl, rule, onChange }: { ctl: DbCtl; rule: DbFilter; onChange: (r: DbFilter) => void }) {
  const { t } = ctl.api;
  const props = ctl.schema?.properties ?? [];
  const prop = props.find((p) => p.id === rule.prop);
  const ops = prop ? (OPS_BY_TYPE[prop.type] ?? OPS_BY_TYPE.text) : [];
  return (
    <div className="nt-advf-rule">
      <select
        className="nt-fsel nt-advf-prop"
        value={prop ? rule.prop : ""}
        onChange={(e) => {
          const p = props.find((x) => x.id === e.target.value);
          if (p) onChange({ ...rule, prop: p.id, op: defaultOp(p), value: "" });
        }}
      >
        {!prop && <option value="">{t("db.deletedProp")}</option>}
        {props.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {prop && (
        <select className="nt-fsel nt-advf-op" value={rule.op} onChange={(e) => {
          const op = e.target.value as FilterOp;
          // A range ("relative to today") and a day are different values: switching between them starts afresh.
          onChange(op === "within" || rule.op === "within" ? { ...rule, op, value: "" } : { ...rule, op });
        }}>
          {ops.map((op) => (
            <option key={op} value={op}>
              {t(`op.${op}` as NotesKey)}
            </option>
          ))}
        </select>
      )}
      {prop && filterNeedsValue(rule.op) && <RuleValue prop={prop} rule={rule} placeholder={t("db.valuePlaceholder")} onChange={(value) => onChange({ ...rule, value })} />}
    </div>
  );
}

type Item = DbFilter | DbFilterGroup;

function ItemMenu({ ctl, depth, item, onRemove, onDuplicate, onWrap }: { ctl: DbCtl; depth: number; item: Item; onRemove: () => void; onDuplicate: () => void; onWrap: () => void }) {
  const { t } = ctl.api;
  const [el, setEl] = useState<HTMLElement | null>(null);
  const items = [
    { key: "rm", label: t("db.removeRule"), icon: <Trash2 />, danger: true, onSelect: () => (onRemove(), setEl(null)) },
    { key: "dup", label: t("menu.duplicate"), icon: <Copy />, onSelect: () => (onDuplicate(), setEl(null)) },
    ...(!isFilterGroup(item) && depth < MAX_FILTER_DEPTH ? [{ key: "wrap", label: t("db.turnIntoGroup"), icon: <Layers />, onSelect: () => (onWrap(), setEl(null)) }] : []),
  ];
  return (
    <>
      <button type="button" className="nt-icon-btn nt-btn-reset nt-advf-more" aria-label={t("db.ruleActions")} title={t("db.ruleActions")} onClick={(e) => setEl(e.currentTarget)}>
        <MoreHorizontal />
      </button>
      {el && (
        <Popover anchor={el} onClose={() => setEl(null)} placement="bottom-end">
          <Menu width={220} groups={[{ key: "a", items }]} />
        </Popover>
      )}
    </>
  );
}

/** Deep copy with fresh ids. */
function cloneItem(x: Item): Item {
  return isFilterGroup(x) ? { id: shortId(), conj: x.conj, items: x.items.map(cloneItem) } : { ...x, id: shortId() };
}

function AddMenu({ ctl, depth, onAdd, label }: { ctl: DbCtl; depth: number; onAdd: (x: Item) => void; label: string }) {
  const { t } = ctl.api;
  const [el, setEl] = useState<HTMLElement | null>(null);
  const first = ctl.schema?.properties[0];
  if (!first) return null;
  return (
    <>
      <button type="button" className="nt-advf-add nt-btn-reset" onClick={(e) => setEl(e.currentTarget)}>
        <Plus />
        {label}
      </button>
      {el && (
        <Popover anchor={el} onClose={() => setEl(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "a",
                items: [
                  { key: "rule", label: t("db.addRule"), icon: <Plus />, onSelect: () => (onAdd(newRule(first)), setEl(null)) },
                  ...(depth < MAX_FILTER_DEPTH
                    ? [{ key: "group", label: t("db.addGroup"), icon: <Layers />, onSelect: () => (onAdd({ id: shortId(), conj: "and", items: [newRule(first)] }), setEl(null)) }]
                    : []),
                ],
              },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

function GroupBody({ ctl, group, depth, onChange }: { ctl: DbCtl; group: DbFilterGroup; depth: number; onChange: (g: DbFilterGroup) => void }) {
  const { t } = ctl.api;
  const setItem = (i: number, x: Item) => onChange({ ...group, items: group.items.map((y, j) => (j === i ? x : y)) });
  return (
    <div className="nt-advf-rows">
      {group.items.map((x, i) => (
        <div key={x.id} className="nt-advf-row">
          <div className="nt-advf-conj">
            {i === 0 ? (
              <span>{t("db.where")}</span>
            ) : i === 1 ? (
              <select className="nt-fsel" value={group.conj} onChange={(e) => onChange({ ...group, conj: e.target.value === "or" ? "or" : "and" })}>
                <option value="and">{t("db.and")}</option>
                <option value="or">{t("db.or")}</option>
              </select>
            ) : (
              <span>{group.conj === "or" ? t("db.or") : t("db.and")}</span>
            )}
          </div>
          <div className="nt-advf-item">
            {isFilterGroup(x) ? (
              <div className="nt-advf-group" data-depth={depth + 1}>
                <GroupBody ctl={ctl} group={x} depth={depth + 1} onChange={(g) => setItem(i, g)} />
                <AddMenu ctl={ctl} depth={depth + 1} label={t("db.addRule")} onAdd={(y) => setItem(i, { ...x, items: [...x.items, y] })} />
              </div>
            ) : (
              <RuleRow ctl={ctl} rule={x} onChange={(r) => setItem(i, r)} />
            )}
          </div>
          <ItemMenu
            ctl={ctl}
            depth={depth}
            item={x}
            onRemove={() => onChange({ ...group, items: group.items.filter((_, j) => j !== i) })}
            onDuplicate={() => onChange({ ...group, items: [...group.items.slice(0, i + 1), cloneItem(x), ...group.items.slice(i + 1)] })}
            onWrap={() => setItem(i, { id: shortId(), conj: "and", items: [x] })}
          />
        </div>
      ))}
    </div>
  );
}

/** Notion's advanced filter panel for the current view. */
export function AdvancedFilter({ ctl, anchor, onClose }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const view = ctl.view;
  if (!view || !ctl.schema) return null;
  const group: DbFilterGroup = view.filterGroup ?? { id: shortId(), conj: "and", items: [] };
  const set = (g: DbFilterGroup | undefined) => ctl.updateView({ filterGroup: g });
  return (
    <Popover anchor={anchor} onClose={onClose} className="nt-advf-pop">
      <div className="nt-advf">
        {group.items.length === 0 && <div className="nt-advf-empty">{t("db.advEmpty")}</div>}
        <GroupBody ctl={ctl} group={group} depth={0} onChange={set} />
        <div className="nt-advf-foot">
          <AddMenu ctl={ctl} depth={0} label={t("db.addRule")} onAdd={(x) => set({ ...group, items: [...group.items, x] })} />
          <button
            type="button"
            className="nt-advf-add nt-advf-delete nt-btn-reset"
            onClick={() => {
              set(undefined);
              onClose();
            }}
          >
            <Trash2 />
            {t("db.deleteAdvFilter")}
          </button>
        </div>
      </div>
    </Popover>
  );
}
