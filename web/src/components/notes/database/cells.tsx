"use client";

// Database cells: how each property type looks, and its editors (select /
// multi-select / status picker, date picker) — Notion's popovers.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlignLeft,
  AtSign,
  Calendar,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock,
  GripVertical,
  Hash,
  Link as LinkIcon,
  List,
  MoreHorizontal,
  Phone,
  Trash2,
  Type,
  X,
  Check,
  Sigma,
  ArrowUpRight,
  Paperclip,
  ScanSearch,
  FileText,
  Fingerprint,
  Users,
  CircleUser,
  UserPen,
  MousePointerClick,
  MapPin,
  Lock,
  BadgeCheck,
} from "lucide-react";
import { PeopleValue } from "../people";
import { useNotes } from "../context";
import { ButtonCell } from "./ButtonCell";
import { VerificationChip } from "./verification";
import { useMondayFirst } from "../prefs";
import { Menu, Popover } from "../ui";
import { fmtDate, isEmptyValue, isPercentRollup, newOption, optionById, valueText } from "@/lib/notes/db";
import { parseFileItem } from "@/lib/notes/compute";
import { safeUrl } from "@/lib/notes/model";
import type { DateValue, DbProperty, Note, NoteColor, PropType, PropValue, SelectOption } from "@/lib/notes/types";
import { NOTE_COLORS, isPlaceValue } from "@/lib/notes/types";
import type { NotesKey } from "@/lib/notes/i18n";
import { DAY_REMINDERS, TIME_REMINDERS, dateTimePart, reminderFor } from "@/lib/notes/reminders";
import { formatTimeLabel, parseTimeInput } from "@/lib/notes/dates";
import { askReminderPermission, reminderReach, type ReminderReach } from "@/lib/notes/notify-permission";
import { intlOf } from "@/i18n/locales";

export function PropIcon({ type, size = 16 }: { type: PropType; size?: number }) {
  const s = { width: size, height: size };
  switch (type) {
    case "title":
      return <Type style={s} />;
    case "text":
      return <AlignLeft style={s} />;
    case "number":
      return <Hash style={s} />;
    case "select":
      return <ChevronDown style={s} />;
    case "multi_select":
      return <List style={s} />;
    case "status":
      return <CircleDot style={s} />;
    case "date":
      return <Calendar style={s} />;
    case "checkbox":
      return <CheckSquare style={s} />;
    case "url":
      return <LinkIcon style={s} />;
    case "email":
      return <AtSign style={s} />;
    case "phone":
      return <Phone style={s} />;
    case "created_time":
    case "last_edited_time":
      return <Clock style={s} />;
    case "formula":
      return <Sigma style={s} />;
    case "relation":
      return <ArrowUpRight style={s} />;
    case "rollup":
      return <ScanSearch style={s} />;
    case "files":
      return <Paperclip style={s} />;
    case "unique_id":
      return <Fingerprint style={s} />;
    case "person":
      return <Users style={s} />;
    case "created_by":
      return <CircleUser style={s} />;
    case "last_edited_by":
      return <UserPen style={s} />;
    case "button":
      return <MousePointerClick style={s} />;
    case "place":
      return <MapPin style={s} />;
    case "verification":
      return <BadgeCheck style={s} />;
    default:
      return <AlignLeft style={s} />;
  }
}

export function Tag({ option, status, onRemove }: { option: SelectOption; status?: boolean; onRemove?: () => void }) {
  return (
    <span className={status ? "nt-tag nt-tag-status" : "nt-tag"} data-color={option.color}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{option.name}</span>
      {onRemove && (
        <span
          className="nt-tag-x"
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X />
        </span>
      )}
    </span>
  );
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)(?:$|[?#])/i;

/** File chips (images as thumbnails); links open in a new tab. */
export function FilesValue({ value, compact }: { value: PropValue; compact?: boolean }) {
  const items = (Array.isArray(value) ? value : []).map(parseFileItem).filter((f) => safeUrl(f.url));
  return (
    <span className="nt-files">
      {items.map((f, i) =>
        IMAGE_RE.test(f.url) && !compact ? (
          <a key={i} className="nt-file-thumb" href={f.url} target="_blank" rel="noopener noreferrer nofollow" title={f.name} onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={f.url} alt={f.name} loading="lazy" />
          </a>
        ) : (
          <a key={i} className="nt-file-chip" href={f.url} target="_blank" rel="noopener noreferrer nofollow" title={f.name} onClick={(e) => e.stopPropagation()}>
            <Paperclip />
            <span>{f.name}</span>
          </a>
        )
      )}
    </span>
  );
}

/** A formula or rollup result, drawn by its runtime type. */
function ComputedValue({ prop, value }: { prop: DbProperty; value: PropValue }) {
  const { locale } = useNotes();
  if (typeof value === "boolean")
    return (
      <span className="nt-cb" data-on={value || undefined} data-readonly>
        {value && <Check strokeWidth={3} />}
      </span>
    );
  if (isEmptyValue(value)) return null;
  if (typeof value === "number") {
    if (isPercentRollup(prop)) {
      const pct = Math.max(0, Math.min(1, value));
      return (
        <span className="nt-cell-pct">
          <span className="nt-pct-bar">
            <span style={{ width: `${pct * 100}%` }} data-full={pct >= 1 || undefined} />
          </span>
          <span className="nt-cell-num">{valueText(prop, value, locale)}</span>
        </span>
      );
    }
    if (prop.show) return <NumberShow prop={prop} value={value} text={valueText(prop, value, locale)} />;
    return <span className="nt-cell-num">{valueText(prop, value, locale)}</span>;
  }
  if (Array.isArray(value))
    return (
      <span className="nt-tags">
        {value.map((x, i) => (
          <span key={i} className="nt-tag" data-color="default">
            {x}
          </span>
        ))}
      </span>
    );
  return <span>{valueText(prop, value, locale)}</span>;
}

/** A number shown as a bar or a ring (Notion's number "Show as"), with the number beside it unless hidden. */
function NumberShow({ prop, value, text }: { prop: DbProperty; value: number; text: string }) {
  const show = prop.show as NonNullable<DbProperty["show"]>;
  const divide = show.divide ?? (prop.numberFormat === "percent" ? 1 : 100);
  const pct = Math.max(0, Math.min(1, value / divide));
  const len = 2 * Math.PI * 7;
  return (
    <span className="nt-numshow" data-as={show.as} data-color={show.color ?? "blue"} title={text}>
      {show.as === "bar" ? (
        <span className="nt-numshow-bar">
          <span style={{ width: `${pct * 100}%` }} />
        </span>
      ) : (
        <svg className="nt-numshow-ring" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="7" className="nt-numshow-track" />
          <circle cx="9" cy="9" r="7" className="nt-numshow-fill" strokeDasharray={`${pct * len} ${len}`} transform="rotate(-90 9 9)" />
        </svg>
      )}
      {show.number !== false && <span className="nt-cell-num">{text}</span>}
    </span>
  );
}

/** Read-only rendering of a value (cells, cards, lists). */
export function CellValue({ prop, value, compact, row }: { prop: DbProperty; value: PropValue; compact?: boolean; /** The row (a Button property runs on it). */ row?: Note }) {
  const { locale, t } = useNotes();
  // Column permissions: a value this person may not see shows as a lock.
  if (prop.denied === "view")
    return (
      <span className="nt-cell-locked" title={t("cols.hiddenFromYou")}>
        <Lock />
      </span>
    );
  if (prop.type === "button") return row ? <ButtonCell prop={prop} row={row} /> : <span className="nt-prop-button">{prop.button?.label || prop.name}</span>;
  if (prop.type === "formula" || prop.type === "rollup") return <ComputedValue prop={prop} value={value} />;
  if (prop.type === "checkbox") {
    return (
      <span className="nt-cb" data-on={value === true || undefined}>
        {value === true && <Check strokeWidth={3} />}
      </span>
    );
  }
  if (isEmptyValue(value)) {
    return null;
  }
  switch (prop.type) {
    case "select":
    case "status": {
      const o = optionById(prop, String(value));
      return o ? <Tag option={o} status={prop.type === "status"} /> : null;
    }
    case "multi_select":
      return (
        <span className="nt-tags">
          {(Array.isArray(value) ? value : []).map((id) => {
            const o = optionById(prop, id);
            return o ? <Tag key={id} option={o} /> : null;
          })}
        </span>
      );
    case "url":
      // Values come from imports, forms and other members: only safe schemes become links.
      if (!safeUrl(String(value))) return <span>{String(value)}</span>;
      return (
        <a className="nt-cell-url" href={String(value)} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()}>
          {String(value).replace(/^https?:\/\/(www\.)?/, "")}
        </a>
      );
    case "email":
      return (
        <a className="nt-cell-url" href={`mailto:${String(value)}`} onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      );
    case "phone":
      return (
        <a className="nt-cell-url" href={`tel:${String(value)}`} onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      );
    case "number":
      if (prop.show && typeof value === "number") return <NumberShow prop={prop} value={value} text={valueText(prop, value, locale)} />;
      return <span className="nt-cell-num">{valueText(prop, value, locale)}</span>;
    case "relation":
      return (
        <span className="nt-rel-chips">
          {(Array.isArray(value) ? value : []).map((title, i) => (
            <span key={i} className="nt-rel-chip">
              <FileText />
              <span>{title || t("page.untitled")}</span>
            </span>
          ))}
        </span>
      );
    case "files":
      return <FilesValue value={value} compact={compact} />;
    case "person":
    case "created_by":
    case "last_edited_by":
      return <PeopleValue ids={Array.isArray(value) ? value : []} />;
    case "place":
      return isPlaceValue(value) ? (
        <span className="nt-cell-place" title={value.address ?? value.name}>
          <MapPin />
          <span>{value.name}</span>
        </span>
      ) : null;
    case "verification":
      return <VerificationChip value={value} />;
    default:
      return <span>{valueText(prop, value, locale)}</span>;
  }
}

// ---------------------------------------------------------------------------
// Select / multi-select / status editor

function OptionMenu({ prop, option, anchor, onClose, onChange, onDelete }: { prop: DbProperty; option: SelectOption; anchor: HTMLElement; onClose: () => void; onChange: (o: SelectOption) => void; onDelete: () => void }) {
  const { t } = useNotes();
  const [name, setName] = useState(option.name);
  void prop;
  return (
    <Popover anchor={anchor} placement="right-start" onClose={() => (name.trim() && name !== option.name && onChange({ ...option, name: name.trim() }), onClose())}>
      <Menu
        width={220}
        header={
          <div className="nt-menu-input-wrap">
            <input
              className="nt-input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (name.trim()) onChange({ ...option, name: name.trim() });
                  onClose();
                }
              }}
            />
          </div>
        }
        groups={[
          {
            key: "del",
            items: [{ key: "del", label: t("db.deleteOption"), icon: <Trash2 />, danger: true, onSelect: () => (onDelete(), onClose()) }],
          },
          {
            key: "colors",
            label: t("block.color"),
            items: NOTE_COLORS.map((c) => ({
              key: c,
              label: t(`color.${c}` as NotesKey),
              icon: <span className="nt-tag" data-color={c} style={{ width: 18, height: 18, padding: 0, margin: 0 }} />,
              checked: option.color === c,
              onSelect: () => onChange({ ...option, name: name.trim() || option.name, color: c as NoteColor }),
            })),
          },
        ]}
      />
    </Popover>
  );
}

export function SelectEditor({
  prop,
  value,
  anchor,
  onClose,
  onValue,
  onProp,
}: {
  prop: DbProperty;
  value: PropValue;
  anchor: HTMLElement | null;
  onClose: () => void;
  onValue: (v: PropValue) => void;
  onProp: (patch: Partial<DbProperty>) => void;
}) {
  const { t } = useNotes();
  const multi = prop.type === "multi_select";
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [optMenu, setOptMenu] = useState<{ o: SelectOption; el: HTMLElement } | null>(null);
  const selected: string[] = multi ? (Array.isArray(value) ? value : []) : value ? [String(value)] : [];
  const options = useMemo(() => prop.options ?? [], [prop.options]);
  const filtered = useMemo(() => options.filter((o) => o.name.toLowerCase().includes(q.trim().toLowerCase())), [options, q]);
  const exact = options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim() && !exact && prop.type !== "status";
  const rows = [...filtered.map((o) => ({ kind: "opt" as const, o })), ...(canCreate ? [{ kind: "new" as const }] : [])];
  const pick = (id: string) => {
    if (multi) onValue(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    else {
      onValue(selected[0] === id ? null : id);
      onClose();
    }
    setQ("");
  };
  const create = () => {
    const o = newOption(prop, q.trim());
    onProp({ options: [...options, o] });
    if (multi) onValue([...selected, o.id]);
    else {
      onValue(o.id);
      onClose();
    }
    setQ("");
  };
  const groups =
    prop.type === "status"
      ? (["todo", "doing", "done"] as const).map((g) => ({ g, items: filtered.filter((o) => (o.group ?? "todo") === g) }))
      : null;
  const renderRow = (o: SelectOption) => {
    const idx = rows.findIndex((r) => r.kind === "opt" && r.o.id === o.id);
    return (
      <div key={o.id} className="nt-opt-row" data-active={idx === active || undefined} onMouseEnter={() => setActive(idx)} onClick={() => pick(o.id)}>
        <GripVertical className="nt-opt-grip" />
        <Tag option={o} status={prop.type === "status"} />
        {selected.includes(o.id) && <Check size={14} style={{ marginInlineStart: 4, color: "var(--nt-text-2)" }} />}
        <button
          type="button"
          className="nt-item-act nt-btn-reset nt-opt-more"
          onClick={(e) => {
            e.stopPropagation();
            setOptMenu({ o, el: e.currentTarget });
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="nt-selectpop">
        <div className="nt-selectpop-input">
          {selected.map((id) => {
            const o = optionById(prop, id);
            return o ? <Tag key={id} option={o} status={prop.type === "status"} onRemove={() => onValue(multi ? selected.filter((x) => x !== id) : null)} /> : null;
          })}
          <input
            autoFocus
            value={q}
            placeholder={selected.length ? "" : t("db.selectPlaceholder")}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const r = rows[active];
                if (!r) return;
                if (r.kind === "new") create();
                else pick(r.o.id);
              } else if (e.key === "Backspace" && !q && selected.length) {
                onValue(multi ? selected.slice(0, -1) : null);
              } else if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div style={{ maxHeight: 300, overflowY: "auto", padding: "4px 0 6px" }}>
          {prop.type !== "status" && <div className="nt-selectpop-hint">{t("db.selectPlaceholder").replace("…", "")}</div>}
          {groups
            ? groups.map(({ g, items }) =>
                items.length ? (
                  <div key={g}>
                    <div className="nt-selectpop-hint">{t(g === "todo" ? "status.groupTodo" : g === "doing" ? "status.groupDoing" : "status.groupDone")}</div>
                    {items.map(renderRow)}
                  </div>
                ) : null
              )
            : filtered.map(renderRow)}
          {canCreate && (
            <div className="nt-opt-row" data-active={active === rows.length - 1 || undefined} onMouseEnter={() => setActive(rows.length - 1)} onClick={create}>
              <span style={{ color: "var(--nt-text-2)", fontSize: 14 }}>{t("db.addOption")}</span>
              <span className="nt-tag" data-color={newOption(prop, q).color}>
                {q.trim()}
              </span>
            </div>
          )}
        </div>
      </div>
      {optMenu && (
        <OptionMenu
          prop={prop}
          option={optMenu.o}
          anchor={optMenu.el}
          onClose={() => setOptMenu(null)}
          onChange={(o) => onProp({ options: options.map((x) => (x.id === o.id ? o : x)) })}
          onDelete={() => {
            onProp({ options: options.filter((x) => x.id !== optMenu.o.id) });
            if (selected.includes(optMenu.o.id)) onValue(multi ? selected.filter((x) => x !== optMenu.o.id) : null);
          }}
        />
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Date picker

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function monthGrid(year: number, month: number, mondayFirst: boolean): Date[] {
  const first = new Date(year, month, 1);
  const shift = mondayFirst ? (first.getDay() + 6) % 7 : first.getDay();
  const start = new Date(year, month, 1 - shift);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export function weekdayNames(locale: string, mondayFirst: boolean): string[] {
  const base = new Date(2024, 0, 7); // a Sunday
  const names = Array.from({ length: 7 }, (_, i) => new Date(base.getFullYear(), 0, 7 + i).toLocaleDateString(intlOf(locale), { weekday: "short" }));
  return mondayFirst ? [...names.slice(1), names[0]] : names;
}

/** "октябрь 2026 г." → "Октябрь 2026 г." (CSS capitalize would make it "2026 Г."). */
export function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The time a date gets when "Include time" is turned on: the next full hour. */
function defaultTime(): string {
  return `${String((new Date().getHours() + 1) % 24).padStart(2, "0")}:00`;
}

/**
 * The time of a date in the interface's own format (24-hour in Russian,
 * "7:00 AM" in English): `<input type="time">` follows the browser's
 * locale instead, so a Russian page in an English browser said "07:00 AM".
 * Typed times are read on Enter or leaving the field ("7", "730", "19.30",
 * "7 вечера", "7pm"); arrows move it by 15 minutes.
 */
function TimeField({ value, locale, label, onTime }: { value: string; locale: string; label: string; onTime: (hhmm: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = parseTimeInput(draft);
    setDraft(null);
    if (v && v !== value) onTime(v);
  };
  // Closing the picker (Escape, a click outside) unmounts the field before
  // it ever blurs: a typed time is kept then too.
  const pending = useRef({ draft, value, onTime });
  useEffect(() => {
    pending.current = { draft, value, onTime };
  });
  useEffect(
    () => () => {
      const { draft: d, value: was, onTime: apply } = pending.current;
      const v = d === null ? null : parseTimeInput(d);
      if (v && v !== was) apply(v);
    },
    []
  );
  const step = (minutes: number) => {
    const [h, m] = value.split(":").map(Number);
    const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
    onTime(`${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`);
  };
  return (
    <input
      type="text"
      className="nt-input nt-date-time-input"
      aria-label={label}
      value={draft ?? formatTimeLabel(value, locale)}
      placeholder={formatTimeLabel("09:00", locale)}
      autoComplete="off"
      spellCheck={false}
      data-invalid={(draft !== null && draft.trim() !== "" && !parseTimeInput(draft)) || undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          setDraft(null);
          step(e.key === "ArrowUp" ? 15 : -15);
        }
      }}
    />
  );
}

/** `withTime`: the date may carry a time ("YYYY-MM-DDTHH:mm": date mentions and date properties). */
export function DateEditor({ value, anchor, onClose, onValue, withTime = false }: { value: PropValue; anchor: HTMLElement | null; onClose: () => void; onValue: (v: PropValue) => void; withTime?: boolean }) {
  const { t, locale } = useNotes();
  const cur = (value && typeof value === "object" && !Array.isArray(value) ? value : null) as DateValue | null;
  const [range, setRange] = useState(Boolean(cur?.end));
  const [editingEnd, setEditingEnd] = useState(false);
  // Opened by a click (never rendered on the server): the browser's answer is known.
  const [reach, setReach] = useState<ReminderReach | null>(() => (typeof window === "undefined" ? null : reminderReach()));
  const base = cur?.start ? new Date(`${cur.start.slice(0, 10)}T00:00:00`) : new Date();
  const [ym, setYm] = useState({ y: base.getFullYear(), m: base.getMonth() });
  const monday = useMondayFirst(locale);
  const days = monthGrid(ym.y, ym.m, monday);
  const today = ymd(new Date());
  // A reminder stays with the date as it moves, and so does its time.
  const keep = cur?.remind ? { remind: cur.remind } : {};
  const time = withTime ? dateTimePart(cur?.start ?? "") : null;
  const pick = (picked: string) => {
    const d = time && !range ? `${picked}T${time}` : picked;
    if (range) {
      if (!cur?.start || !editingEnd) {
        onValue({ start: d, ...(cur?.end && cur.end >= d ? { end: cur.end } : {}), ...keep });
        setEditingEnd(true);
      } else {
        const s = cur.start.slice(0, 10);
        onValue(d < s ? { start: d, end: s, ...keep } : { start: s, end: d, ...keep });
        setEditingEnd(false);
      }
    } else {
      onValue({ start: d, ...keep });
      onClose();
    }
  };
  const label = new Date(ym.y, ym.m, 1).toLocaleDateString(intlOf(locale), { month: "long", year: "numeric" });
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="nt-datepop">
        <div style={{ padding: "0 10px 8px", display: "flex", gap: 6 }}>
          <input className="nt-input" readOnly value={cur?.start ? fmtDate(cur.start, locale) : ""} placeholder={t("db.date")} onClick={() => setEditingEnd(false)} />
          {range && <input className="nt-input" readOnly value={cur?.end ? fmtDate(cur.end, locale) : ""} placeholder={t("db.endDate")} onClick={() => setEditingEnd(true)} />}
        </div>
        <div className="nt-cal-head">
          <span>{upperFirst(label)}</span>
          <div>
            <button type="button" className="nt-btn-reset nt-db-tool" onClick={() => setYm({ y: new Date().getFullYear(), m: new Date().getMonth() })}>
              {t("db.today")}
            </button>
            <button type="button" className="nt-btn-reset nt-db-tool" aria-label={t("db.prev")} onClick={() => setYm((s) => (s.m === 0 ? { y: s.y - 1, m: 11 } : { y: s.y, m: s.m - 1 }))}>
              <ChevronLeft />
            </button>
            <button type="button" className="nt-btn-reset nt-db-tool" aria-label={t("db.next")} onClick={() => setYm((s) => (s.m === 11 ? { y: s.y + 1, m: 0 } : { y: s.y, m: s.m + 1 }))}>
              <ChevronRight />
            </button>
          </div>
        </div>
        <div className="nt-cal-grid">
          {weekdayNames(locale, monday).map((w) => (
            <div key={w} className="nt-cal-dow">
              {/* "Mo", "Tu"… but never half a word in other scripts (Arabic "الأحد" → "ال" seven times). */}
              {/^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w) ? w.slice(0, 2) : w}
            </div>
          ))}
          {days.map((d) => {
            const k = ymd(d);
            const s = cur?.start?.slice(0, 10);
            const e = cur?.end?.slice(0, 10);
            return (
              <button
                type="button"
                key={k}
                className="nt-cal-day nt-btn-reset"
                data-other={d.getMonth() !== ym.m || undefined}
                data-today={k === today || undefined}
                data-sel={k === s || k === e || undefined}
                data-range={(s && e && k > s && k < e) || undefined}
                onClick={() => pick(k)}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
        <div className="nt-menu-section">
          <label className="nt-mi nt-date-remind">
            <span className="nt-mi-label">{t("remind.label")}</span>
            <select
              className="nt-fsel"
              value={cur?.remind ?? ""}
              disabled={!cur?.start}
              onChange={(e) => {
                if (!cur?.start) return;
                const remind = e.target.value;
                const { remind: _old, ...rest } = cur;
                void _old;
                onValue(remind ? { ...rest, remind } : rest);
                // Reminders also show as system notifications (and push) when the browser allows them.
                if (remind) void askReminderPermission().then((p) => p && setReach(reminderReach()));
              }}
            >
              <option value="">{t("remind.none")}</option>
              {(time ? TIME_REMINDERS : DAY_REMINDERS).map((r) => (
                <option key={r} value={r}>
                  {t(`remind.${r}` as NotesKey)}
                </option>
              ))}
            </select>
          </label>
          {cur?.remind && reach && (
            // Whether it will ring while Notes is closed, and the one tap that makes it so.
            <div className="nt-date-remind-hint" data-reach={reach}>
              {t(`remind.hint.${reach}` as NotesKey)}
              {reach === "ask" && (
                <button type="button" className="nt-btn-reset nt-date-remind-allow" onClick={() => void askReminderPermission().then(() => setReach(reminderReach()))}>
                  {t("remind.hint.allow")}
                </button>
              )}
            </div>
          )}
          {withTime && !range && (
            <div className="nt-date-time">
              <button
                type="button"
                className="nt-mi nt-btn-reset nt-date-time-toggle"
                disabled={!cur?.start}
                onClick={() => {
                  if (!cur?.start) return;
                  const day = cur.start.slice(0, 10);
                  const next = time ? day : `${day}T${defaultTime()}`;
                  const remind = reminderFor(cur.remind, !time);
                  onValue({ start: next, ...(remind ? { remind } : {}) });
                }}
              >
                <span className="nt-mi-label">{t("date.includeTime")}</span>
                <span className="nt-mi-toggle" data-on={time ? "true" : "false"} />
              </button>
              {time && (
                <TimeField
                  value={time}
                  locale={locale}
                  label={t("date.time")}
                  onTime={(v) => {
                    if (cur?.start) onValue({ ...cur, start: `${cur.start.slice(0, 10)}T${v}` });
                  }}
                />
              )}
            </div>
          )}
          <button
            type="button"
            className="nt-mi nt-btn-reset"
            onClick={() => {
              const next = !range;
              setRange(next);
              if (!next && cur?.start) onValue({ start: cur.start, ...keep });
              setEditingEnd(next && Boolean(cur?.start));
            }}
          >
            <span className="nt-mi-label">{t("db.endDate")}</span>
            <span className="nt-mi-toggle" data-on={range ? "true" : "false"} />
          </button>
          <button
            type="button"
            className="nt-mi nt-btn-reset"
            onClick={() => {
              onValue(null);
              onClose();
            }}
          >
            <span className="nt-mi-label">{t("db.clear")}</span>
          </button>
        </div>
      </div>
    </Popover>
  );
}

/** Inline text editing for text-like properties (Enter commits, Esc cancels). */
export function TextCellInput({ initial, type, onCommit, onCancel, multiline }: { initial: string; type: PropType; onCommit: (v: string) => void; onCancel: () => void; multiline?: boolean }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(v);
  };
  const common = {
    className: "nt-cell-input",
    autoFocus: true,
    value: v,
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        done.current = true;
        onCancel();
      }
      e.stopPropagation();
    },
  };
  if (multiline)
    return (
      <textarea
        {...common}
        rows={Math.min(8, Math.max(1, v.split("\n").length))}
        onChange={(e) => setV(e.target.value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
      />
    );
  return (
    <input
      {...common}
      type={type === "number" ? "text" : type === "email" ? "email" : type === "url" ? "url" : "text"}
      inputMode={type === "number" ? "decimal" : type === "phone" ? "tel" : undefined}
      onChange={(e) => setV(e.target.value)}
    />
  );
}

/** Parses an edited text value for its property type (undefined: not a number, keep the old value). */
export function parseTextValue(type: PropType, s: string): PropValue | undefined {
  const v = s.trim();
  if (!v) return null;
  if (type === "number") {
    // "1 234,5", "1,234.5", "1,234,567", "$12", "12 €", "CHF 12": spaces, currency signs and group commas go.
    let num = v.replace(/\s/g, "").replace(/^[^\d+\-.,]+|[^\d.,]+$/gu, "");
    num = num.includes(".") || (num.match(/,/g) ?? []).length > 1 ? num.replace(/,/g, "") : num.replace(",", ".");
    const n = num ? Number(num) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "url" && !/^[a-z]+:/i.test(v)) return `https://${v}`;
  return type === "text" ? s : v;
}

export function textOf(prop: DbProperty, row: Note): string {
  if (prop.type === "title") return row.title;
  const v = row.props?.[prop.id];
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? "" : String(v);
}

export type CellChild = ReactNode;
