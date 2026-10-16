"use client";

// The Filter and Display menus of issue screens, the bar of active filter
// chips, and "describe in words" (a phrase parsed into a filter by the
// assistant's rules on the server). Filters and display live in the URL.

import { useState, type ReactNode } from "react";
import { Calendar, Columns3, Filter as FilterIcon, LayoutList, Rows3, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { filterCount } from "@/lib/projects/filter";
import {
  COMPLETED_RANGES,
  DISPLAY_PROPS,
  GROUPINGS,
  ORDERINGS,
  PRIORITIES,
  STATUS_CATEGORIES,
  type IssueDisplay,
  type IssueFilter,
  type Layout,
} from "@/lib/projects/types";
import { api, errorText, localToday, toast, useLookups } from "./data";
import { CycleGlyph, Glyph, PriorityIcon, ProjectGlyph, StatusIcon, uiColor } from "./icons";
import { useT, type PKey } from "./i18n";
import { Avatar, Menu, Popover, Toggle, UnassignedIcon, usePopover, type MenuItem } from "./ui";

export type FilterKey = "status" | "category" | "assignee" | "creator" | "priority" | "label" | "project" | "cycle" | "team" | "due" | "created" | "updated" | "flags";

const KEY_LABEL: Record<FilterKey, PKey> = {
  status: "f.status",
  category: "f.category",
  assignee: "f.assignee",
  creator: "f.creator",
  priority: "f.priority",
  label: "f.labels",
  project: "f.project",
  cycle: "f.cycle",
  team: "f.team",
  due: "f.due",
  created: "f.created",
  updated: "f.updated",
  flags: "f.blocked",
};

const CAT_COLOR: Record<string, string> = { backlog: "#95a2b3", unstarted: "#99a2b2", started: "#f2c94c", completed: "#5e6ad2", canceled: "#95a2b3" };

/** The values of one filter key, as menu items toggling them in `f`. */
function useValueItems(key: FilterKey, f: IssueFilter, set: (f: IssueFilter) => void): MenuItem[] {
  const L = useLookups();
  const { t } = useT();
  const toggle = <K extends keyof IssueFilter>(k: K, v: string | number) => {
    const cur = ((f[k] as (string | number)[] | undefined) ?? []) as (string | number)[];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    const out = { ...f, [k]: next.length ? next : undefined };
    if (!next.length) delete out[k];
    set(out);
  };
  const has = (k: keyof IssueFilter, v: string | number) => ((f[k] as (string | number)[] | undefined) ?? []).includes(v);
  switch (key) {
    case "status": {
      const seen = new Set<string>();
      return L.b.statuses
        .filter((s) => (seen.has(`${s.category}${s.name}`) ? false : (seen.add(`${s.category}${s.name}`), true)))
        .map((s) => {
          const ids = L.b.statuses.filter((x) => x.name === s.name && x.category === s.category).map((x) => x.id);
          const on = ids.every((id) => has("status", id));
          return {
            id: s.id,
            label: s.name,
            icon: <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} />,
            checked: on,
            onSelect: () => {
              const cur = f.status ?? [];
              const next = on ? cur.filter((x) => !ids.includes(x)) : [...new Set([...cur, ...ids])];
              const out: IssueFilter = { ...f, status: next };
              if (!next.length) delete out.status;
              set(out);
            },
          };
        });
    }
    case "category":
      return STATUS_CATEGORIES.map((c) => ({ id: c, label: t(`cat.${c}`), icon: <StatusIcon category={c} color={CAT_COLOR[c]} />, checked: has("category", c), onSelect: () => toggle("category", c) }));
    case "assignee":
    case "creator": {
      const k = key;
      const list: MenuItem[] = [{ id: "me", label: t("f.me"), icon: <Avatar name={L.b.me.name} id={L.b.me.id} size={18} />, checked: has(k, "me"), onSelect: () => toggle(k, "me") }];
      if (k === "assignee") list.push({ id: "none", label: t("f.noAssignee"), icon: <UnassignedIcon size={18} />, checked: has(k, "none"), onSelect: () => toggle(k, "none") });
      for (const p of L.b.people) list.push({ id: p.id, label: p.name, icon: <Avatar name={p.name} id={p.id} size={18} src={p.avatar} faded={!p.role} />, checked: has(k, p.id), onSelect: () => toggle(k, p.id) });
      return list;
    }
    case "priority":
      return PRIORITIES.map((p) => ({ id: String(p), label: t(`prio.${p}`), icon: <PriorityIcon priority={p} />, checked: has("priority", p), onSelect: () => toggle("priority", p) }));
    case "label":
      return L.b.labels.map((l) => ({ id: l.id, label: l.name, icon: <span className="pj-dot" style={{ background: uiColor(l.color) }} />, checked: has("label", l.id), onSelect: () => toggle("label", l.id) }));
    case "project":
      return [
        { id: "none", label: t("f.noProject"), checked: has("project", "none"), onSelect: () => toggle("project", "none") },
        ...L.b.projects.map((p) => ({ id: p.id, label: p.name, icon: <ProjectGlyph icon={p.icon} color={p.color} />, checked: has("project", p.id), onSelect: () => toggle("project", p.id) })),
      ];
    case "cycle":
      return [
        { id: "current", label: t("f.currentCycle"), icon: <CycleGlyph progress={0.5} />, checked: has("cycle", "current"), onSelect: () => toggle("cycle", "current") },
        { id: "none", label: t("f.noCycle"), checked: has("cycle", "none"), onSelect: () => toggle("cycle", "none") },
        ...L.b.cycles.map((c) => ({
          id: c.id,
          label: `${L.team.get(c.teamId)?.key ?? ""} · ${c.name || t("cy.name", { n: c.number })}`,
          right: <span className="pj-menu-hint">{c.startsOn.slice(5)}</span>,
          checked: has("cycle", c.id),
          onSelect: () => toggle("cycle", c.id),
        })),
      ];
    case "team":
      return L.b.teams.map((x) => ({ id: x.id, label: x.name, icon: <Glyph icon={x.icon} color={x.color} text={x.name} size={16} />, checked: has("team", x.id), onSelect: () => toggle("team", x.id) }));
    case "due":
      return (["overdue", "today", "week", "month", "none", "any"] as const).map((d) => ({
        id: d,
        label: t(({ overdue: "f.overdue", today: "f.today", week: "f.week", month: "f.month", none: "f.noDue", any: "f.anyDue" } as const)[d]),
        checked: f.due === d,
        onSelect: () => {
          const out = { ...f, due: f.due === d ? undefined : d };
          if (!out.due) delete out.due;
          set(out);
        },
      }));
    case "created":
    case "updated": {
      const k = key;
      return (["day", "week", "month"] as const).map((d) => ({
        id: d,
        label: t(({ day: "f.day", week: "f.pastWeek", month: "f.pastMonth" } as const)[d]),
        checked: f[k] === d,
        onSelect: () => {
          const out = { ...f, [k]: f[k] === d ? undefined : d };
          if (!out[k]) delete out[k];
          set(out);
        },
      }));
    }
    case "flags":
      return (
        [
          ["blocked", "f.blocked"],
          ["blocking", "f.blocking"],
          ["subscribed", "f.subscribed"],
          ["archived", "f.archived"],
        ] as const
      ).map(([k, label]) => ({
        id: k,
        label: t(label),
        checked: Boolean(f[k]),
        onSelect: () => {
          const out = { ...f, [k]: f[k] ? undefined : true };
          if (!out[k]) delete out[k];
          set(out);
        },
      }));
  }
}

function ValueMenu({ k, f, set, onClose }: { k: FilterKey; f: IssueFilter; set: (f: IssueFilter) => void; onClose: () => void }) {
  const items = useValueItems(k, f, set);
  const single = k === "due" || k === "created" || k === "updated";
  return <Menu items={items} multi={!single} onClose={onClose} />;
}

export function FilterButton({ f, set, hide = [] }: { f: IssueFilter; set: (f: IssueFilter) => void; hide?: FilterKey[] }) {
  const { t } = useT();
  const pop = usePopover();
  const [key, setKey] = useState<FilterKey | null>(null);
  const keys = (Object.keys(KEY_LABEL) as FilterKey[]).filter((k) => !hide.includes(k));
  const n = filterCount(f);
  return (
    <>
      <button
        type="button"
        className="pj-btn pj-btn-sm"
        data-filter-button=""
        aria-label={t("f.filter")}
        title={`${t("f.filter")} (F)`}
        onClick={(e) => {
          setKey(null);
          pop.toggle(e.currentTarget);
        }}
      >
        <FilterIcon size={14} />
        <span>{t("f.filter")}</span>
        {n > 0 && <span className="pj-count-badge">{n}</span>}
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={250} label={t("f.filter")}>
          {key ? (
            <ValueMenu k={key} f={f} set={set} onClose={pop.close} />
          ) : (
            <Menu
              items={keys.map((k) => ({ id: k, label: t(KEY_LABEL[k]), keepOpen: true, onSelect: () => setKey(k) }))}
              onClose={pop.close}
              placeholder={t("f.filter")}
            />
          )}
        </Popover>
      )}
    </>
  );
}

/** Active filters as removable chips (click a chip to change its values). */
export function FilterChips({ f, set, hide = [] }: { f: IssueFilter; set: (f: IssueFilter) => void; hide?: FilterKey[] }) {
  const { t } = useT();
  const L = useLookups();
  const pop = usePopover();
  const [key, setKey] = useState<FilterKey | null>(null);
  const chips: { key: FilterKey; label: string; value: string; clear: () => void }[] = [];
  const names = (k: keyof IssueFilter, map: (v: string) => string) => ((f[k] as string[] | undefined) ?? []).map(map).join(", ");
  const drop = (...ks: (keyof IssueFilter)[]) => () => {
    const out = { ...f };
    for (const k of ks) delete out[k];
    set(out);
  };
  if (f.status && !hide.includes("status"))
    chips.push({ key: "status", label: t("f.status"), value: [...new Set(f.status.map((id) => L.status.get(id)?.name ?? "?"))].join(", "), clear: drop("status") });
  if (f.category && !hide.includes("category")) chips.push({ key: "category", label: t("f.category"), value: f.category.map((c) => t(`cat.${c}`)).join(", "), clear: drop("category") });
  const person = (id: string) => (id === "me" ? t("f.me") : id === "none" ? t("f.noAssignee") : (L.person.get(id)?.name ?? "?"));
  if (f.assignee && !hide.includes("assignee")) chips.push({ key: "assignee", label: t("f.assignee"), value: names("assignee", person), clear: drop("assignee") });
  if (f.creator && !hide.includes("creator")) chips.push({ key: "creator", label: t("f.creator"), value: names("creator", person), clear: drop("creator") });
  if (f.priority && !hide.includes("priority")) chips.push({ key: "priority", label: t("f.priority"), value: f.priority.map((p) => t(`prio.${p}`)).join(", "), clear: drop("priority") });
  if (f.label && !hide.includes("label")) chips.push({ key: "label", label: t("f.labels"), value: names("label", (id) => L.label.get(id)?.name ?? "?"), clear: drop("label", "labelMode") });
  if (f.project && !hide.includes("project")) chips.push({ key: "project", label: t("f.project"), value: names("project", (id) => (id === "none" ? t("f.noProject") : (L.project.get(id)?.name ?? "?"))), clear: drop("project") });
  if (f.cycle && !hide.includes("cycle"))
    chips.push({
      key: "cycle",
      label: t("f.cycle"),
      value: names("cycle", (id) => (id === "none" ? t("f.noCycle") : id === "current" ? t("f.currentCycle") : (L.cycle.get(id)?.name || `#${L.cycle.get(id)?.number ?? "?"}`))),
      clear: drop("cycle"),
    });
  if (f.team && !hide.includes("team")) chips.push({ key: "team", label: t("f.team"), value: names("team", (id) => L.team.get(id)?.name ?? "?"), clear: drop("team") });
  if (f.due && !hide.includes("due"))
    chips.push({ key: "due", label: t("f.due"), value: t(({ overdue: "f.overdue", today: "f.today", week: "f.week", month: "f.month", none: "f.noDue", any: "f.anyDue" } as const)[f.due]), clear: drop("due") });
  if (f.created) chips.push({ key: "created", label: t("f.created"), value: t(({ day: "f.day", week: "f.pastWeek", month: "f.pastMonth" } as const)[f.created]), clear: drop("created") });
  if (f.updated) chips.push({ key: "updated", label: t("f.updated"), value: t(({ day: "f.day", week: "f.pastWeek", month: "f.pastMonth" } as const)[f.updated]), clear: drop("updated") });
  for (const [k, label] of [
    ["blocked", "f.blocked"],
    ["blocking", "f.blocking"],
    ["subscribed", "f.subscribed"],
    ["archived", "f.archived"],
  ] as const)
    if (f[k]) chips.push({ key: "flags", label: t(label), value: t("c.yes"), clear: drop(k) });
  if (f.q) chips.push({ key: "flags", label: t("f.textRest"), value: `“${f.q}”`, clear: drop("q") });
  if (!chips.length) return null;
  return (
    <div className="pj-chips" role="list">
      {chips.map((c, i) => (
        <span className="pj-chip" role="listitem" key={`${c.key}${i}`}>
          <button
            type="button"
            className="pj-chip-main"
            onClick={(e) => {
              setKey(c.key);
              pop.open(e.currentTarget);
            }}
          >
            <span className="pj-chip-key">{c.label}</span>
            <span className="pj-chip-val">{c.value}</span>
          </button>
          {c.key === "label" && (f.label?.length ?? 0) > 1 && (
            <button type="button" className="pj-chip-mode" onClick={() => set({ ...f, labelMode: f.labelMode === "all" ? undefined : "all" })}>
              {f.labelMode === "all" ? t("f.allOf") : t("f.anyOf")}
            </button>
          )}
          <button type="button" className="pj-chip-x" aria-label={t("f.clear")} onClick={c.clear}>
            <X size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="pj-link pj-small" onClick={() => set({})}>
        {t("f.clear")}
      </button>
      {pop.anchor && key && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={250} label={t("f.filter")}>
          <ValueMenu k={key} f={f} set={set} onClose={pop.close} />
        </Popover>
      )}
    </div>
  );
}

// --- Display -------------------------------------------------------------------

const LAYOUT_ICON: Record<Layout, ReactNode> = { list: <LayoutList size={15} />, board: <Columns3 size={15} />, calendar: <Calendar size={15} /> };

export function DisplayButton({ d, set, onReset, layouts = ["list", "board", "calendar"] }: { d: IssueDisplay; set: (d: IssueDisplay) => void; onReset: () => void; layouts?: Layout[] }) {
  const { t } = useT();
  const pop = usePopover();
  const sel = <T extends string>(label: string, value: T, options: readonly T[], name: (v: T) => string, on: (v: T) => void) => (
    <label className="pj-display-row">
      <span>{label}</span>
      <select className="pj-select" value={value} onChange={(e) => on(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {name(o)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <button type="button" className="pj-btn pj-btn-sm" aria-label={t("f.display")} title={t("f.display")} onClick={(e) => pop.toggle(e.currentTarget)}>
        <SlidersHorizontal size={14} />
        <span>{t("f.display")}</span>
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={320} align="end" label={t("f.display")}>
          <div className="pj-display">
            <div className="pj-seg" role="radiogroup" aria-label={t("d.layout")}>
              {layouts.map((l) => (
                <button key={l} type="button" role="radio" aria-checked={d.layout === l} data-on={d.layout === l || undefined} onClick={() => set({ ...d, layout: l })}>
                  {LAYOUT_ICON[l]}
                  {t(`d.${l}`)}
                </button>
              ))}
            </div>
            {d.layout !== "calendar" && sel(t("d.grouping"), d.group, GROUPINGS, (g) => t(`g.${g}`), (g) => set({ ...d, group: g }))}
            {sel(t("d.ordering"), d.order, ORDERINGS, (o) => t(`o.${o}`), (o) => set({ ...d, order: o }))}
            {sel(t("d.completed"), d.completed, COMPLETED_RANGES, (c) => t(`d.completed.${c}`), (c) => set({ ...d, completed: c }))}
            <div className="pj-display-row">
              <span>{t("d.subIssues")}</span>
              <Toggle on={d.subIssues} label={t("d.subIssues")} onChange={(v) => set({ ...d, subIssues: v })} />
            </div>
            {d.layout !== "calendar" && (
              <div className="pj-display-row">
                <span>{t("d.emptyGroups")}</span>
                <Toggle on={d.emptyGroups} label={t("d.emptyGroups")} onChange={(v) => set({ ...d, emptyGroups: v })} />
              </div>
            )}
            <div className="pj-display-sub">{t("d.props")}</div>
            <div className="pj-prop-chips">
              {DISPLAY_PROPS.map((p) => (
                <button key={p} type="button" className="pj-prop-chip" data-on={d.props.includes(p) || undefined} aria-pressed={d.props.includes(p)} onClick={() => set({ ...d, props: d.props.includes(p) ? d.props.filter((x) => x !== p) : [...d.props, p] })}>
                  {t(`p.${p}`)}
                </button>
              ))}
            </div>
            <div className="pj-row-end">
              <button type="button" className="pj-link pj-small" onClick={onReset}>
                {t("d.reset")}
              </button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

export function LayoutSwitch({ d, set }: { d: IssueDisplay; set: (d: IssueDisplay) => void }) {
  const { t } = useT();
  return (
    <div className="pj-seg pj-seg-sm" role="radiogroup" aria-label={t("d.layout")}>
      {(["list", "board"] as const).map((l) => (
        <button key={l} type="button" role="radio" title={t(`d.${l}`)} aria-label={t(`d.${l}`)} aria-checked={d.layout === l} data-on={d.layout === l || undefined} onClick={() => set({ ...d, layout: l })}>
          {l === "list" ? <Rows3 size={14} /> : <Columns3 size={14} />}
        </button>
      ))}
    </div>
  );
}

// --- Describe in words ---------------------------------------------------------

export function AskButton({ apply }: { apply: (f: IssueFilter) => void }) {
  const { t } = useT();
  const pop = usePopover();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ filter: IssueFilter; matched: string[]; count: number } | null>(null);
  const run = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setRes(await api("assist", { method: "POST", body: { action: "parseQuery", text, today: localToday() } }));
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="pj-btn pj-btn-sm pj-btn-ghost" title={t("f.ask")} aria-label={t("f.ask")} onClick={(e) => pop.toggle(e.currentTarget)}>
        <Sparkles size={14} />
      </button>
      {pop.anchor && (
        <Popover anchor={pop.anchor} onClose={pop.close} width={360} align="end" label={t("f.ask")}>
          <div className="pj-ask">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              <div className="pj-ask-input">
                <Search size={14} />
                <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("f.askHint")} aria-label={t("f.ask")} />
              </div>
            </form>
            {res && (
              <div className="pj-ask-res">
                <div className="pj-small pj-muted">{t("f.askFound", { n: res.count })}</div>
                {res.matched.length > 0 && (
                  <div className="pj-ask-tags">
                    {t("f.understood")}:{" "}
                    {res.matched.map((m) => (
                      <span key={m} className="pj-tag">
                        {m}
                      </span>
                    ))}
                  </div>
                )}
                {res.filter.q && (
                  <div className="pj-small">
                    {t("f.textRest")}: «{res.filter.q}»
                  </div>
                )}
                <button
                  type="button"
                  className="pj-btn pj-btn-primary pj-btn-sm"
                  onClick={() => {
                    apply(res.filter);
                    pop.close();
                  }}
                >
                  {t("f.askApply")}
                </button>
              </div>
            )}
            <div className="pj-small pj-muted pj-ask-note">
              {busy ? t("c.loading") : t("as.parseNote")}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
