"use client";

// The small shared pieces of every section (design system: PropertyPill,
// ViewSwitcher, SelectionBar, EmptyStart, ListRow). They draw; the section
// keeps its data, pickers and permissions.

import { useEffect, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { dt } from "./i18n";
import { Kbd } from "./Kbd";
import { isTyping, overlayOpen } from "./keys";
import "./ds.css";

// ------------------------------------------------------------------ Pill

export type PillTone = "default" | "late" | "empty";

export interface PillProps {
  children: ReactNode;
  /** A lucide icon, a StatusIcon, a priority mark, an avatar… */
  icon?: ReactNode;
  /** A label or project color (a ui-label-* value or the option's color). */
  dot?: string;
  tone?: PillTone;
  /** Makes it a button that opens the section's picker. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  className?: string;
}

/** One property, shown and edited in one click: status, priority, assignee, due date, label, project. */
export function Pill({ children, icon, dot, tone = "default", onClick, title, className }: PillProps) {
  const inner = (
    <>
      {dot && <span className="ds-pill-dot" style={{ background: dot }} aria-hidden />}
      {icon}
      <span className="ds-pill-text">{children}</span>
    </>
  );
  const cls = `ds-pill${className ? ` ${className}` : ""}`;
  return onClick ? (
    <button type="button" className={cls} data-tone={tone} onClick={onClick} title={title} aria-haspopup="listbox">
      {inner}
    </button>
  ) : (
    <span className={cls} data-tone={tone} title={title}>
      {inner}
    </span>
  );
}

// ------------------------------------------------------------------ ViewSwitcher

export interface ViewOption<V extends string> {
  id: V;
  label: string;
  icon?: ReactNode;
}

/** List, board, table, calendar, timeline: one switcher for Projects and Docs databases. ⌘1…⌘5 pick a view. */
export function ViewSwitcher<V extends string>({ views, value, onChange, hotkeys = false, label }: { views: readonly ViewOption<V>[]; value: V; onChange: (v: V) => void; hotkeys?: boolean; label?: string }) {
  const { locale } = useI18n();
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || isTyping(e.target)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > views.length) return;
      e.preventDefault();
      onChange(views[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, views, onChange]);
  return (
    <div className="ds-views" role="radiogroup" aria-label={label ?? dt(locale, "views")}>
      {views.map((v, i) => (
        <button key={v.id} type="button" role="radio" aria-checked={v.id === value} className="ds-view" onClick={() => onChange(v.id)} title={hotkeys ? `${v.label} · ${i + 1}` : v.label}>
          {v.icon}
          {v.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ SelectionBar

/** Floats at the bottom once two or more rows are picked: the count, the bulk actions, Esc to clear. */
export function SelectionBar({ count, onClear, children, inline = false }: { count: number; onClear: () => void; children: ReactNode; inline?: boolean }) {
  const { locale } = useI18n();
  useEffect(() => {
    if (count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isTyping(e.target) || overlayOpen(document)) return;
      onClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, onClear]);
  if (count === 0) return null;
  return (
    <div className="ds-selbar" role="toolbar" aria-label={dt(locale, "selected", { n: count })} data-inline={inline || undefined}>
      <span className="ds-selbar-count">
        {dt(locale, "selected", { n: count })}
        <button type="button" className="ds-icon-btn" aria-label={dt(locale, "clearSelection")} title={dt(locale, "clearSelection")} onClick={onClear}>
          <X aria-hidden />
        </button>
      </span>
      <span className="ds-selbar-scroll">{children}</span>
    </div>
  );
}

export function SelectionAction({ icon, children, onClick, tone, keys }: { icon?: ReactNode; children: ReactNode; onClick: (e: MouseEvent<HTMLButtonElement>) => void; tone?: "danger"; keys?: readonly string[] }) {
  return (
    <button type="button" className="ds-selbar-btn" data-tone={tone} onClick={onClick}>
      {icon}
      {children}
      {keys && <Kbd keys={keys} />}
    </button>
  );
}

// ------------------------------------------------------------------ EmptyStart

export interface Start {
  id: string;
  label: string;
  icon: ReactNode;
  /** A ui-tint-* color for the icon's ground (var(--ui-tint-orange)…). */
  tint?: string;
  href?: string;
  onClick?: () => void;
  keys?: readonly string[];
}

/** An empty screen that offers the next step instead of saying "nothing here". The first start always makes something.
 * `level`: the heading's level under the screen's own (an h1 above: 2, the default; inside a section: 3). */
export function EmptyStart({ title, hint, starts, level = 2 }: { title: string; hint?: ReactNode; starts: readonly Start[]; level?: 2 | 3 }) {
  const H = level === 3 ? "h3" : "h2";
  return (
    <div className="ds-empty">
      <H className="ds-empty-title">{title}</H>
      {hint && <p className="ds-empty-hint">{hint}</p>}
      {starts.length > 0 && (
        <div className="ds-starts">
          {starts.map((s) => {
            const body = (
              <>
                <span className="ds-start-icon" style={{ background: s.tint ?? "var(--ui-bg-2)" }}>
                  {s.icon}
                </span>
                {s.label}
                {s.keys && <Kbd keys={s.keys} />}
              </>
            );
            return s.href ? (
              <a key={s.id} className="ds-start" href={s.href} onClick={s.onClick}>
                {body}
              </a>
            ) : (
              <button key={s.id} type="button" className="ds-start" onClick={s.onClick}>
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ ListRow

export interface ListRowProps {
  title: ReactNode;
  /** The object's identifier (ZVN-12), muted. */
  id?: string;
  /** Before the id: priority mark, status icon, page icon. */
  lead?: ReactNode;
  /** Right side: pills, date, avatar. */
  props?: ReactNode;
  /** On hover and keyboard focus: quick actions (they take the props' place when `hideProps`). */
  quick?: ReactNode;
  hideProps?: boolean;
  /** Shows a checkbox (visible on hover, when selected, or while selecting). */
  check?: { checked: boolean; onChange: (checked: boolean, e: MouseEvent) => void; label: string };
  selecting?: boolean;
  selected?: boolean;
  focused?: boolean;
  comfy?: boolean;
  href?: string;
  onOpen?: (e: MouseEvent | ReactKeyboardEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  className?: string;
  style?: CSSProperties;
}

/** A dense row of a list (Linear's), the same in Projects, Docs databases, Inbox and search. */
export function ListRow({ title, id, lead, props, quick, hideProps = true, check, selecting, selected, focused, comfy, href, onOpen, onContextMenu, className, style }: ListRowProps) {
  const attrs = {
    className: `ds-row${className ? ` ${className}` : ""}`,
    "data-selected": selected || undefined,
    "data-focused": focused || undefined,
    "data-selecting": selecting || undefined,
    "data-comfy": comfy || undefined,
    onContextMenu,
    style,
  };
  const inner = (
    <>
      {check && (
        <input
          type="checkbox"
          className="ds-row-check"
          checked={check.checked}
          aria-label={check.label}
          onClick={(e) => {
            e.stopPropagation();
            check.onChange(!check.checked, e);
          }}
          onChange={() => {}}
        />
      )}
      {lead}
      {id && <span className="ds-row-id">{id}</span>}
      <span className="ds-row-title">{title}</span>
      {props && (
        <span className="ds-row-props" data-hide-on-hover={(quick && hideProps) || undefined}>
          {props}
        </span>
      )}
      {quick && (
        <span className="ds-row-quick" onClick={(e) => e.stopPropagation()}>
          {quick}
        </span>
      )}
    </>
  );
  return href ? (
    <a {...attrs} href={href} onClick={onOpen}>
      {inner}
    </a>
  ) : (
    <div
      {...attrs}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onOpen(e);
              }
            }
          : undefined
      }
    >
      {inner}
    </div>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What it turns on (read by screen readers; the visible label sits beside it). */
  label: string;
  disabled?: boolean;
  className?: string;
}

/** An on/off setting (Figma's toggle): a button with role="switch"; the thumb moves to the end side, also in RTL. */
export function Switch({ checked, onChange, label, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`ds-switch${className ? ` ${className}` : ""}`}
      onClick={() => onChange(!checked)}
    />
  );
}
