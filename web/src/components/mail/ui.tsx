"use client";

// Mail's small parts: a popover anchored to a button, a menu, a dialog, an
// avatar, an icon button with its shortcut in the tooltip. Styled by
// mail.css with zvena's tokens (--ui-*).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Kbd } from "@/components/zvena/ds";

export type Anchor = HTMLElement | { x: number; y: number };

function rectOf(a: Anchor): { left: number; top: number; bottom: number; right: number } {
  if (a instanceof HTMLElement) return a.getBoundingClientRect();
  return { left: a.x, top: a.y, bottom: a.y, right: a.x };
}

/** A floating panel next to its anchor; closes on Escape and outside clicks. */
export function Popover({ anchor, onClose, children, width = 260, align = "start", label }: { anchor: Anchor; onClose: () => void; children: ReactNode; width?: number; align?: "start" | "end"; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const r = rectOf(anchor);
    const h = ref.current?.offsetHeight ?? 200;
    const w = Math.min(width, window.innerWidth - 16);
    const rtl = document.documentElement.dir === "rtl";
    let left = (align === "end") !== rtl ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ left, top, width: w });
  }, [anchor, width, align]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="zm-pop" style={pos} role="dialog" aria-label={label} data-zm-overlay="">
      {children}
    </div>,
    document.body
  );
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  keys?: readonly string[];
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** Runs without closing the menu (it shows something else in its place). */
  keep?: boolean;
  run: () => void;
}

/** A keyboard-friendly list of items (↑↓, Enter), optionally filtered by a search box. */
export function Menu({ items, onClose, search, placeholder, empty, footer }: { items: MenuItem[]; onClose: () => void; search?: boolean; placeholder?: string; empty?: ReactNode; footer?: ReactNode }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const shown = search && q ? items.filter((it) => (typeof it.label === "string" ? it.label : it.id).toLowerCase().includes(q.toLowerCase())) : items;
  const pick = (it: MenuItem | undefined) => {
    if (!it || it.disabled) return;
    if (it.keep) return it.run();
    onClose();
    it.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setI((x) => Math.min(x + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setI((x) => Math.max(x - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[i]);
    }
  };
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!search) listRef.current?.focus();
  }, [search]);
  return (
    <div className="zm-menu" onKeyDown={onKey} tabIndex={search ? undefined : -1} ref={listRef}>
      {search && (
        <input
          className="zm-menu-search"
          autoFocus
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
        />
      )}
      <div className="zm-menu-items" role="menu">
        {shown.map((it, n) => (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className="zm-menu-item"
            data-active={n === i || undefined}
            data-danger={it.danger || undefined}
            disabled={it.disabled}
            onMouseEnter={() => setI(n)}
            onClick={() => pick(it)}
          >
            {it.icon && <span className="zm-menu-icon">{it.icon}</span>}
            <span className="zm-menu-label">{it.label}</span>
            {it.hint && <span className="zm-menu-hint">{it.hint}</span>}
            {it.checked && <span className="zm-menu-check" aria-hidden>✓</span>}
            {it.keys && <Kbd keys={it.keys} />}
          </button>
        ))}
        {!shown.length && empty && <div className="zm-menu-empty">{empty}</div>}
      </div>
      {footer}
    </div>
  );
}

/** A modal dialog (Escape and the scrim close it). */
export function Dialog({ title, onClose, children, width = 520, footer, label }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode; label?: string }) {
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  return createPortal(
    <div className="zm-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-zm-overlay="">
      <div className="zm-dialog" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)} style={{ maxWidth: width }}>
        <div className="zm-dialog-head">
          <div className="zm-dialog-title">{title}</div>
          <button type="button" className="zm-icon-btn" onClick={onClose} aria-label="×">
            <X size={16} />
          </button>
        </div>
        <div className="zm-dialog-body">{children}</div>
        {footer && <div className="zm-dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

const HUES = [210, 260, 330, 20, 150, 190, 40, 290];

/** A round initial, colored by the address (the same person always has the same color). */
export function Avatar({ name, address, size = 28 }: { name: string; address: string; size?: number }) {
  const s = (name || address).trim();
  const initial = (s.charAt(0) || "?").toUpperCase();
  let h = 0;
  for (const c of address.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className="zm-avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${HUES[h % HUES.length]} 55% 52%)` }} aria-hidden>
      {initial}
    </span>
  );
}

/** An icon button whose tooltip names it and its key. */
export function IconBtn({ icon, label, keys, onClick, active, danger, disabled, className }: { icon: ReactNode; label: string; keys?: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean; danger?: boolean; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      className={`zm-icon-btn${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={keys ? `${label} · ${keys}` : label}
      aria-pressed={active}
      data-danger={danger || undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      {icon}
    </button>
  );
}

/** A label's color dot. */
export function Dot({ color }: { color?: string }) {
  return <span className="zm-dot" style={{ background: color || "var(--ui-text-3)" }} aria-hidden />;
}
