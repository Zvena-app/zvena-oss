"use client";

// Calendar's small building blocks: a dialog, a popover anchored to a
// button, a menu, a switch, the color dots. Drawn with the shell's tokens
// (app/ui-theme.css) in calendar.css; dialogs and menus are real ARIA
// dialogs and menus (the shell's single-key shortcuts pause while one is open).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { CAL_COLORS } from "@/lib/calendar/types";
import { useI18n } from "@/lib/i18n-react";
import { dt } from "@/components/zvena/ds/i18n";
import { Switch as DsSwitch } from "@/components/zvena/ds";
import type { CalKey } from "@/lib/calendar/strings";
import { useCt } from "./i18n";

export function Modal({ title, onClose, children, wide, footer, label }: { title?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { locale } = useI18n();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea, button");
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };
  return createPortal(
    <div className="cal-layer" onKeyDown={onKey}>
      <div className="cal-scrim" onMouseDown={onClose} />
      <div ref={ref} className={`cal-modal${wide ? " cal-modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
        {title !== undefined && (
          <div className="cal-modal-head">
            <h2>{title}</h2>
            <button type="button" className="cal-icon-btn" aria-label={dt(locale, "close")} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        )}
        <div className="cal-modal-body">{children}</div>
        {footer && <div className="cal-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/** A floating panel under (or above) an anchor element; closes on outside click and Esc. */
export function Popover({ anchor, onClose, children, width = 260, className, align = "start", role = "dialog", label }: { anchor: HTMLElement | DOMRect; onClose: () => void; children: ReactNode; width?: number; className?: string; align?: "start" | "end"; role?: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
    const h = ref.current?.offsetHeight ?? 200;
    const w = Math.min(width, window.innerWidth - 16);
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ left, top, width: w });
  }, [anchor, width, align]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className={`cal-pop${className ? ` ${className}` : ""}`} style={pos} role={role} aria-label={label}>
      {children}
    </div>,
    document.body
  );
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** A menu that the keyboard drives (↑ ↓ Enter Esc). */
export function Menu({ anchor, items, onClose, width = 240, align }: { anchor: HTMLElement | DOMRect; items: (MenuItem | "sep")[]; onClose: () => void; width?: number; align?: "start" | "end" }) {
  const [at, setAt] = useState(-1);
  const list = items.filter((i): i is MenuItem => i !== "sep");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      let i = at;
      for (let n = 0; n < list.length; n++) {
        i = (i + step + list.length) % list.length;
        if (!list[i].disabled) break;
      }
      setAt(i);
    } else if (e.key === "Enter" && at >= 0 && !list[at].disabled) {
      e.preventDefault();
      list[at].run();
      onClose();
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={width} align={align} role="presentation">
      <div ref={ref} className="cal-menu" role="menu" tabIndex={-1} onKeyDown={onKey}>
        {items.map((it, i) =>
          it === "sep" ? (
            <div key={`sep-${i}`} className="cal-menu-sep" role="separator" />
          ) : (
            <button
              key={it.key}
              type="button"
              role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={it.checked}
              className="cal-menu-item"
              data-active={list[at]?.key === it.key || undefined}
              data-danger={it.danger || undefined}
              disabled={it.disabled}
              onMouseEnter={() => setAt(list.indexOf(it))}
              onClick={() => {
                it.run();
                onClose();
              }}
            >
              <span className="cal-menu-icon">{it.checked ? <Check size={14} /> : it.icon}</span>
              <span className="cal-menu-label">{it.label}</span>
              {it.hint && <span className="cal-menu-hint">{it.hint}</span>}
            </button>
          )
        )}
      </div>
    </Popover>
  );
}

/** zvena's one on/off control (components/zvena/ds Switch), with Calendar's call shape. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <DsSwitch checked={on} onChange={onChange} label={label} disabled={disabled} />;
}

/** The palette's names (what a screen reader says, not the hex). */
const COLOR_NAME: Record<(typeof CAL_COLORS)[number], CalKey> = {
  "#2f80ed": "color.blue",
  "#eb5757": "color.red",
  "#f2994a": "color.orange",
  "#f2c94c": "color.yellow",
  "#27ae60": "color.green",
  "#2d9cdb": "color.sky",
  "#9b51e0": "color.purple",
  "#e86aa6": "color.pink",
  "#6fcf97": "color.mint",
  "#56ccf2": "color.cyan",
  "#bb6bd9": "color.lavender",
  "#828282": "color.gray",
};

export function ColorDots({ value, onChange, label }: { value: string | null; onChange: (c: string) => void; label: string }) {
  const { t } = useCt();
  return (
    <div className="cal-colors" role="radiogroup" aria-label={label}>
      {CAL_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={t(COLOR_NAME[c])} title={t(COLOR_NAME[c])} className="cal-color" style={{ background: c }} onClick={() => onChange(c)}>
          {value === c && <Check size={12} color="#fff" />}
        </button>
      ))}
    </div>
  );
}

/** A labelled row of a form (label left, control right; stacked on phones). */
export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="cal-field">
      <span className="cal-field-label">{label}</span>
      <span className="cal-field-control">{children}</span>
      {hint && <span className="cal-field-hint">{hint}</span>}
    </label>
  );
}

/**
 * The click that follows a press which opened something (the event panel, a
 * sheet) must not land on what now lies under the finger or the pointer.
 */
export function swallowClick(): void {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 450);
}

export function copyText(text: string): Promise<boolean> {
  return navigator.clipboard
    ?.writeText(text)
    .then(() => true)
    .catch(() => false) ?? Promise.resolve(false);
}
