"use client";

// A column's menu (header click): rename, change type, formula / relation /
// rollup setup, sort, filter, hide, wrap, freeze, insert left/right,
// duplicate, delete.

import { useState } from "react";
import { ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUp, ArrowUpRight, CalendarDays, ChartNoAxesColumn, Clock, Copy, Eye, EyeOff, FileText, Filter, Fingerprint, Hash, Info, Lock, Pin, PinOff, Repeat2, ScanSearch, Sigma, Trash2, User, WrapText, Zap } from "lucide-react";
import { ColumnPermsDialog } from "./ColumnPerms";
import { Menu, Popover } from "../ui";
import { PropIcon } from "./cells";
import { FormulaEditor, RelationSetup, RollupSetup } from "./advanced";
import { ButtonSetup } from "./automations";
import { formatNumber, propValue, valueText } from "@/lib/notes/db";
import { displayTitle } from "@/lib/notes/model";
import type { DbCtl } from "./useDatabase";
import { NOTE_COLORS, NUMBER_FORMATS, PROP_TYPES, type DbProperty, type PropType } from "@/lib/notes/types";
import { shortId, STATUS_OPTIONS } from "@/lib/notes/model";
import type { NotesKey } from "@/lib/notes/i18n";

export function PropertyMenu({
  ctl,
  prop: opened,
  anchor,
  onClose,
  inTable,
}: {
  ctl: DbCtl;
  prop: DbProperty;
  anchor: HTMLElement;
  onClose: () => void;
  /** Opened from a table header: offers "Freeze up to column". */
  inTable?: boolean;
}) {
  const { t } = ctl.api;
  // The live property: a type change must show the new type's items at once.
  const prop = ctl.schema?.properties.find((p) => p.id === opened.id) ?? opened;
  const [name, setName] = useState(prop.name);
  // Only a name the user typed is saved on close (setup screens may rename too).
  const [nameDirty, setNameDirty] = useState(false);
  const [sub, setSub] = useState<{ kind: "type" | "format" | "prefix" | "vis" | "dateFmt" | "timeFmt" | "show" | "desc"; el: HTMLElement } | null>(null);
  // Column permissions: people with full access to the database set who sees and edits this property.
  const [perms, setPerms] = useState(false);
  const canPerms = Boolean(ctl.api.user && ctl.db && ctl.api.levelOf(ctl.db.id) === "full");
  const isDate = prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time";
  // Formula / relation / rollup setup replaces the menu under the column header.
  const [mode, setMode] = useState<"menu" | "formula" | "relation" | "rollup" | "button">("menu");
  const view = ctl.view;
  const commitName = () => {
    if (nameDirty && name.trim() && name !== prop.name) ctl.updateProp(prop.id, { name: name.trim() });
    setNameDirty(false);
  };
  const close = () => {
    commitName();
    onClose();
  };
  const changeType = (type: PropType) => {
    if (type === prop.type) {
      setSub(null);
      return;
    }
    const patch: Partial<DbProperty> = { type };
    // A typed name sticks; an untouched default name follows the new type (Notion).
    const typed = nameDirty && name.trim() && name !== prop.name ? name.trim() : null;
    if (typed) {
      patch.name = typed;
      setNameDirty(false);
    }
    else if (prop.name === t(`prop.${prop.type}` as NotesKey)) {
      patch.name = t(`prop.${type}` as NotesKey);
      setName(patch.name);
    }
    if ((type === "select" || type === "multi_select") && !prop.options) patch.options = [];
    // Select options become To-do statuses (Notion), so the cells keep their values.
    if (type === "status" && !(prop.options ?? []).some((o) => o.group))
      patch.options = prop.options?.length ? prop.options.map((o) => ({ ...o, group: "todo" as const })) : STATUS_OPTIONS.map((o) => ({ ...o, name: t(`status.${o.id}` as NotesKey) }));
    if (type === "formula" && !prop.formula) patch.formula = { expr: "" };
    if (prop.type === "relation") ctl.unlinkMirror(prop);
    const computed = prop.type === "formula" || prop.type === "rollup" || prop.type === "relation";
    // Computed values become plain text or numbers (Notion keeps what you saw).
    const carried = computed && ["text", "number", "url", "email", "phone"].includes(type) ? new Map(ctl.allRows.map((r) => [r.id, valueText(prop, propValue(r, prop), ctl.api.locale)])) : null;
    ctl.updateProp(prop.id, patch);
    if (carried) {
      for (const r of ctl.allRows) {
        const text = carried.get(r.id) ?? "";
        const asNum = Number(String(propValue(r, prop) ?? ""));
        ctl.setValue(r, { ...prop, type }, type === "number" ? (Number.isFinite(asNum) && text ? asNum : null) : text || null);
      }
    }
    // Values that cannot carry over (e.g. a date into a number) are dropped.
    else if (["checkbox", "date", "number", "select", "multi_select", "status", "relation", "files", "unique_id", "person", "place", "verification"].includes(type) || ["checkbox", "date", "select", "multi_select", "status", "relation", "files", "unique_id", "person", "place", "verification"].includes(prop.type)) {
      for (const r of ctl.allRows) {
        const v = r.props?.[prop.id];
        if (v === undefined) continue;
        let next: unknown = null;
        if (type === "multi_select" && (prop.type === "select" || prop.type === "status") && typeof v === "string") next = [v];
        else if ((type === "select" || type === "status") && prop.type === "multi_select" && Array.isArray(v)) next = v[0] ?? null;
        else if ((type === "select" || type === "status") && (prop.type === "select" || prop.type === "status")) next = v;
        else if (["text", "url", "email", "phone"].includes(type) && typeof v === "string") next = v;
        // People become their names as text (Notion keeps what you saw).
        else if (type === "text" && prop.type === "person" && Array.isArray(v)) next = valueText(prop, v, ctl.api.locale) || null;
        else if (type === "number" && typeof v === "string" && Number.isFinite(Number(v))) next = Number(v);
        else if (type === "files" && typeof v === "string" && /^https?:\/\//i.test(v)) next = [v];
        ctl.setValue(r, { ...prop, type: type === "relation" ? "text" : type }, next as never);
      }
    }
    setSub(null);
    if (type === "button" && !prop.button) patch.button = { label: "", actions: [] };
    if (type === "formula" || type === "relation" || type === "rollup" || type === "button") setMode(type);
  };
  const isTitle = prop.type === "title";
  const relTarget = prop.relation ? ctl.api.snap.byId.get(prop.relation.dbId) : undefined;
  const groups = [
    {
      key: "type",
      items: isTitle
        ? []
        : [
            { key: "type", label: t("db.propType"), icon: <Repeat2 />, hint: t(`prop.${prop.type}` as NotesKey), submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "type", el }) },
            ...(prop.type === "number" || prop.type === "formula" || prop.type === "rollup" ? [{ key: "fmt", label: t("prop.number"), icon: <Hash />, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "format", el }) }] : []),
            // Notion's number "Show as": a number, a bar or a ring.
            ...(prop.type === "number" || prop.type === "formula" || prop.type === "rollup"
              ? [{ key: "show", label: t("num.showAs"), icon: <ChartNoAxesColumn />, hint: t(prop.show ? (prop.show.as === "bar" ? "num.bar" : "num.ring") : "num.number"), submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "show", el }) }]
              : []),
            ...(prop.type === "formula" ? [{ key: "formula", label: t("formula.edit"), icon: <Sigma />, onSelect: () => setMode("formula") }] : []),
            ...(isDate
              ? [
                  { key: "dateFmt", label: t("db.dateFormat"), icon: <CalendarDays />, hint: t(`db.df.${prop.dateFormat ?? "full"}` as NotesKey), submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "dateFmt", el }) },
                  { key: "timeFmt", label: t("db.timeFormat"), icon: <Clock />, hint: prop.timeFormat ? t(`db.tf.${prop.timeFormat}` as NotesKey) : t("db.tf.auto"), submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "timeFmt", el }) },
                ]
              : []),
            ...(prop.type === "relation"
              ? [{ key: "relation", label: t("relation.setup"), icon: <ArrowUpRight />, hint: relTarget ? displayTitle(relTarget, t("db.untitled")) : "", submenu: true, onSelect: () => setMode("relation") }]
              : []),
            ...(prop.type === "rollup" ? [{ key: "rollup", label: t("rollup.setup"), icon: <ScanSearch />, submenu: true, onSelect: () => setMode("rollup") }] : []),
            ...(prop.type === "button" ? [{ key: "button", label: t("auto.buttonSetup"), icon: <Zap />, submenu: true, onSelect: () => setMode("button") }] : []),
            ...(prop.type === "unique_id" ? [{ key: "prefix", label: t("db.idPrefix"), icon: <Fingerprint />, hint: prop.prefix ?? "", submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "prefix", el }) }] : []),
            { key: "desc", label: t("prop.description"), icon: <Info />, hint: prop.description ? "…" : undefined, submenu: true, onSelect: (el: HTMLElement) => setSub({ kind: "desc", el }) },
            // Notion's "Limit": no limit, or 1 person.
            ...(prop.type === "person" ? [{ key: "single", label: t("people.limitOne"), icon: <User />, checked: Boolean(prop.single), onSelect: () => ctl.updateProp(prop.id, { single: prop.single ? undefined : true }) }] : []),
            ...(prop.type === "relation" ? [{ key: "single", label: t("relation.limitOne"), icon: <FileText />, checked: Boolean(prop.single), onSelect: () => ctl.updateProp(prop.id, { single: prop.single ? undefined : true }) }] : []),
          ],
    },
    {
      key: "view",
      items: [
        {
          key: "asc",
          label: t("db.sortAsc"),
          icon: <ArrowUp />,
          onSelect: () => (ctl.updateView({ sorts: [{ prop: prop.id, dir: "asc" }] }), close()),
        },
        {
          key: "desc",
          label: t("db.sortDesc"),
          icon: <ArrowDown />,
          onSelect: () => (ctl.updateView({ sorts: [{ prop: prop.id, dir: "desc" }] }), close()),
        },
        {
          key: "filter",
          label: t("db.filterBy"),
          icon: <Filter />,
          onSelect: () => {
            const op = prop.type === "checkbox" ? "checked" : prop.type === "select" || prop.type === "status" ? "is" : "contains";
            ctl.updateView({ filters: [...(view?.filters ?? []), { id: shortId(), prop: prop.id, op, value: "" }] });
            close();
          },
        },
        ...(isTitle ? [] : [{ key: "hide", label: t("db.hide"), icon: <EyeOff />, onSelect: () => (ctl.updateView({ hidden: [...(view?.hidden ?? []), prop.id] }), close()) }]),
        ...(isTitle
          ? []
          : [
              {
                key: "vis",
                label: t("db.pageVis"),
                icon: <Eye />,
                hint: t(prop.pageVis === "hide" ? "db.visHide" : prop.pageVis === "hideEmpty" ? "db.visHideEmpty" : "db.visShow"),
                submenu: true,
                onSelect: (el: HTMLElement) => setSub({ kind: "vis", el }),
              },
            ]),
        // Notion's "Wrap column": this column only ("Wrap all columns" is in the layout options).
        {
          key: "wrap",
          label: t("db.wrap"),
          icon: <WrapText />,
          toggle: true,
          checked: Boolean(view?.wrap || view?.wrapCols?.includes(prop.id)),
          disabled: Boolean(view?.wrap),
          onSelect: () => {
            const cols = view?.wrapCols ?? [];
            const next = cols.includes(prop.id) ? cols.filter((c) => c !== prop.id) : [...cols, prop.id];
            ctl.updateView({ wrapCols: next.length ? next : undefined });
          },
        },
        ...(inTable
          ? [
              view?.freeze === prop.id
                ? { key: "freeze", label: t("db.unfreeze"), icon: <PinOff />, onSelect: () => (ctl.updateView({ freeze: undefined }), close()) }
                : { key: "freeze", label: t("db.freeze"), icon: <Pin />, onSelect: () => (ctl.updateView({ freeze: prop.id }), close()) },
            ]
          : []),
      ],
    },
    {
      key: "insert",
      items: [
        { key: "left", label: t("db.insertLeft"), icon: <ArrowLeftToLine />, onSelect: () => (ctl.addProp("text", { beforeId: prop.id }), close()) },
        { key: "right", label: t("db.insertRight"), icon: <ArrowRightToLine />, onSelect: () => (ctl.addProp("text", { afterId: prop.id }), close()) },
        ...(isTitle
          ? []
          : [
              {
                key: "dup",
                label: t("db.duplicateProp"),
                icon: <Copy />,
                onSelect: () => {
                  const copy = ctl.addProp(prop.type, { name: `${prop.name} 2`, afterId: prop.id });
                  ctl.updateProp(copy.id, {
                    options: prop.options,
                    numberFormat: prop.numberFormat,
                    formula: prop.formula,
                    rollup: prop.rollup,
                    relation: prop.relation ? { dbId: prop.relation.dbId } : undefined,
                    prefix: prop.prefix,
                    dateFormat: prop.dateFormat,
                    timeFormat: prop.timeFormat,
                  });
                  for (const r of ctl.allRows) if (r.props?.[prop.id] !== undefined) ctl.setValue(r, copy, r.props[prop.id]);
                  close();
                },
              },
              ...(canPerms ? [{ key: "perms", label: t("cols.edit"), icon: <Lock />, hint: prop.perms ? t("cols.limited") : undefined, onSelect: () => setPerms(true) }] : []),
              { key: "del", label: t("db.deleteProp"), icon: <Trash2 />, danger: true, onSelect: () => (ctl.deleteProp(prop.id), onClose()) },
            ]),
      ],
    },
  ];
  if (perms) return <ColumnPermsDialog ctl={ctl} prop={prop} onClose={close} />;
  if (mode === "formula") return <FormulaEditor ctl={ctl} prop={prop} anchor={anchor} onClose={close} />;
  if (mode === "relation") return <RelationSetup ctl={ctl} prop={prop} anchor={anchor} placement="bottom-start" onClose={close} />;
  if (mode === "rollup") return <RollupSetup ctl={ctl} prop={prop} anchor={anchor} placement="bottom-start" onClose={close} />;
  if (mode === "button") return <ButtonSetup ctl={ctl} prop={prop} anchor={anchor} onClose={close} />;
  return (
    <Popover anchor={anchor} onClose={close}>
      <Menu
        width={290}
        header={
          <div className="nt-menu-input-wrap" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 6, boxShadow: "inset 0 0 0 1px var(--nt-border-2)", color: "var(--nt-text-2)", flex: "none" }}>
              <PropIcon type={prop.type} />
            </span>
            <input
              className="nt-input"
              autoFocus
              readOnly={ctl.locked}
              value={name}
              placeholder={t("db.propName")}
              onChange={(e) => {
                setName(e.target.value);
                setNameDirty(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") close();
              }}
            />
          </div>
        }
        // A locked database still sorts and filters; its properties stay as they are.
        groups={ctl.locked ? groups.filter((g) => g.key === "view").map((g) => ({ ...g, items: g.items.filter((i) => i.key === "asc" || i.key === "desc" || i.key === "filter") })) : groups}
      />
      {sub?.kind === "type" && (
        <Popover anchor={sub.el} placement="right-start" onClose={() => setSub(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "types",
                label: t("db.propType"),
                // Verification belongs to wikis (Notion).
                items: PROP_TYPES.filter((x) => x !== "title" && (x !== "verification" || Boolean(ctl.schema?.wiki) || prop.type === "verification")).map((type) => ({
                  key: type,
                  label: t(`prop.${type}` as NotesKey),
                  icon: <PropIcon type={type} />,
                  checked: prop.type === type,
                  onSelect: () => changeType(type),
                })),
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "format" && (
        <Popover anchor={sub.el} placement="right-start" onClose={() => setSub(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "fmt",
                // Notion's list: plain numbers, then every currency with its sample.
                items: NUMBER_FORMATS.map((f) => ({
                  key: f,
                  label: f === "number" ? "1234" : f === "comma" ? "1,234" : f === "percent" ? "12%" : formatNumber(1234, f, ctl.api.locale),
                  checked: (prop.numberFormat ?? "number") === f,
                  onSelect: () => (ctl.updateProp(prop.id, { numberFormat: f }), setSub(null)),
                })),
              },
              {
                key: "dec",
                label: t("num.decimals"),
                // Notion's "Decimal places": as typed, or 0–6 digits after the point.
                items: [undefined, 0, 1, 2, 3, 4, 5, 6].map((d) => ({
                  key: `d${d ?? "auto"}`,
                  label: d === undefined ? t("num.decimalsAuto") : formatNumber(1234.5, prop.numberFormat === "percent" ? "number" : prop.numberFormat, ctl.api.locale, d),
                  checked: prop.decimals === d,
                  onSelect: () => (ctl.updateProp(prop.id, { decimals: d }), setSub(null)),
                })),
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "prefix" && <PrefixSetup ctl={ctl} prop={prop} anchor={sub.el} onClose={() => setSub(null)} />}
      {sub?.kind === "show" && <ShowAsSetup ctl={ctl} prop={prop} anchor={sub.el} onClose={() => setSub(null)} />}
      {sub?.kind === "desc" && <DescriptionSetup ctl={ctl} prop={prop} anchor={sub.el} onClose={() => setSub(null)} />}
      {(sub?.kind === "dateFmt" || sub?.kind === "timeFmt") && (
        <Popover anchor={sub.el} placement="right-start" onClose={() => setSub(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: sub.kind,
                items:
                  sub.kind === "dateFmt"
                    ? (["full", "mdy", "dmy", "ymd", "relative"] as const).map((f) => ({
                        key: f,
                        label: t(`db.df.${f}` as NotesKey),
                        checked: (prop.dateFormat ?? "full") === f,
                        onSelect: () => (ctl.updateProp(prop.id, { dateFormat: f === "full" ? undefined : f }), setSub(null)),
                      }))
                    : (
                        [
                          [undefined, "db.tf.auto"],
                          ["12", "db.tf.12"],
                          ["24", "db.tf.24"],
                        ] as const
                      ).map(([f, label]) => ({ key: label, label: t(label), checked: prop.timeFormat === f, onSelect: () => (ctl.updateProp(prop.id, { timeFormat: f }), setSub(null)) })),
              },
            ]}
          />
        </Popover>
      )}
      {sub?.kind === "vis" && (
        <Popover anchor={sub.el} placement="right-start" onClose={() => setSub(null)}>
          <Menu
            width={220}
            groups={[
              {
                key: "vis",
                label: t("db.pageVisHint"),
                items: (
                  [
                    [undefined, "db.visShow"],
                    ["hideEmpty", "db.visHideEmpty"],
                    ["hide", "db.visHide"],
                  ] as const
                ).map(([v, label]) => ({ key: label, label: t(label), checked: prop.pageVis === v, onSelect: () => (ctl.updateProp(prop.id, { pageVis: v }), setSub(null)) })),
              },
            ]}
          />
        </Popover>
      )}
    </Popover>
  );
}


/** Notion's number "Show as": Number, Bar or Ring, with a color, what 100% is, and whether the number shows too. */
function ShowAsSetup({ ctl, prop, anchor, onClose }: { ctl: DbCtl; prop: DbProperty; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const show = prop.show;
  const [divide, setDivide] = useState(String(show?.divide ?? (prop.numberFormat === "percent" ? 1 : 100)));
  const set = (patch: Partial<NonNullable<DbProperty["show"]>> | null) => ctl.updateProp(prop.id, { show: patch === null ? undefined : { as: show?.as ?? "bar", ...show, ...patch } });
  const commitDivide = () => {
    const n = Number(divide);
    if (show && Number.isFinite(n) && n > 0) set({ divide: n });
  };
  return (
    <Popover anchor={anchor} placement="right-start" onClose={() => (commitDivide(), onClose())}>
      <div style={{ width: 240 }} data-testid="number-show">
        <Menu
          width={240}
          autoFocus={false}
          groups={[
            {
              key: "as",
              label: t("num.showAs"),
              items: (
                [
                  [null, "num.number"],
                  ["bar", "num.bar"],
                  ["ring", "num.ring"],
                ] as const
              ).map(([as, label]) => ({ key: label, label: t(label), checked: (show?.as ?? null) === as, onSelect: () => set(as ? { as } : null) })),
            },
            ...(show
              ? [
                  {
                    key: "color",
                    label: t("ccolor.color"),
                    items: NOTE_COLORS.filter((c) => c !== "default").map((c) => ({
                      key: c,
                      label: t(`color.${c}` as NotesKey),
                      icon: <span className="nt-ccolor-swatch" data-color={c} />,
                      checked: (show.color ?? "blue") === c,
                      onSelect: () => set({ color: c }),
                    })),
                  },
                  { key: "num", items: [{ key: "shownum", label: t("num.showNumber"), toggle: true, checked: show.number !== false, onSelect: () => set({ number: show.number === false ? undefined : false }) }] },
                ]
              : []),
          ]}
        />
        {show && (
          <label className="nt-numshow-divide">
            <span>{t("num.divideBy")}</span>
            <input className="nt-input" type="number" min={0} value={divide} onChange={(e) => setDivide(e.target.value)} onBlur={commitDivide} onKeyDown={(e) => e.key === "Enter" && commitDivide()} />
          </label>
        )}
      </div>
    </Popover>
  );
}

/** Notion's property description: a hint shown on the column header and on pages. */
function DescriptionSetup({ ctl, prop, anchor, onClose }: { ctl: DbCtl; prop: DbProperty; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const [v, setV] = useState(prop.description ?? "");
  const save = () => {
    const clean = v.trim().slice(0, 1000);
    if (clean !== (prop.description ?? "")) ctl.updateProp(prop.id, { description: clean || undefined });
    onClose();
  };
  return (
    <Popover anchor={anchor} placement="right-start" onClose={save}>
      <div style={{ width: 280, padding: 10 }}>
        <div className="nt-menu-label" style={{ padding: "0 0 6px" }}>
          {t("prop.description")}
        </div>
        <textarea className="nt-input" autoFocus rows={3} maxLength={1000} value={v} placeholder={t("prop.descriptionHint")} onChange={(e) => setV(e.target.value)} />
      </div>
    </Popover>
  );
}

/** Unique ID prefix ("TASK" → TASK-12). */
function PrefixSetup({ ctl, prop, anchor, onClose }: { ctl: DbCtl; prop: DbProperty; anchor: HTMLElement; onClose: () => void }) {
  const { t } = ctl.api;
  const [v, setV] = useState(prop.prefix ?? "");
  const save = () => {
    const clean = v.replace(/[^\p{L}\p{N}_]/gu, "").toUpperCase().slice(0, 20);
    ctl.updateProp(prop.id, { prefix: clean || undefined });
    onClose();
  };
  return (
    <Popover anchor={anchor} placement="right-start" onClose={save}>
      <div style={{ width: 240, padding: 10 }}>
        <div className="nt-menu-label" style={{ padding: "0 0 6px" }}>
          {t("db.idPrefix")}
        </div>
        <input className="nt-input" autoFocus value={v} placeholder="TASK" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <div style={{ fontSize: 12, color: "var(--nt-text-2)", marginTop: 6 }}>{(v.replace(/[^\p{L}\p{N}_]/gu, "").toUpperCase() || "") + (v ? "-" : "")}1, 2, 3…</div>
      </div>
    </Popover>
  );
}
