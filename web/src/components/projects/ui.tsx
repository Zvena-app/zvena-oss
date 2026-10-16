"use client";

// UI primitives of Projects, built on zvena's tokens (--zv-*): popovers,
// searchable menus with keyboard navigation, context menus, modals,
// confirmations, toasts, avatars, a date picker and the loading / empty /
// error states. Overlays form a stack: Escape closes the top one only, and
// single-key shortcuts are off while any overlay is open.

import { createPortal } from "react-dom";
import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Kbd as DsKbd } from "@/components/zvena/ds";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { EmptyStart, Switch, type Start } from "@/components/zvena/ds";
import { Store, useStore } from "./data";
import { useT } from "./i18n";
import { intlOf, weekdayNames, weekStartIn } from "@/i18n/locales";

// --- Overlay stack -------------------------------------------------------------

export const overlays = new Store<string[]>([]);

function useOverlay(id: string, onEscape: () => void, active = true): void {
  const esc = useRef(onEscape);
  useLayoutEffect(() => {
    esc.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    overlays.update((l) => [...l, id]);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const stack = overlays.get();
      if (stack[stack.length - 1] !== id) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      esc.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      overlays.update((l) => l.filter((x) => x !== id));
    };
  }, [id, active]);
}

// --- Popover -------------------------------------------------------------------

export type Anchor = HTMLElement | { x: number; y: number } | null;

function rectOf(a: Exclude<Anchor, null>): { left: number; top: number; bottom: number; right: number } {
  if (a instanceof HTMLElement) return a.getBoundingClientRect();
  return { left: a.x, right: a.x, top: a.y, bottom: a.y };
}

export function Popover({ anchor, onClose, children, width, align = "start", className, label }: { anchor: Anchor; onClose: () => void; children: ReactNode; width?: number; align?: "start" | "end"; className?: string; label?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);
  useOverlay(id, onClose, anchor !== null);
  // Focus goes back where it was when the popover closes (keyboard flow, Ctrl+Enter in forms).
  // Taken in a layout effect: the menu inside focuses its search field right after.
  useLayoutEffect(() => {
    if (!anchor) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected || Boolean(node?.contains(now));
      if (prev && prev.isConnected && lost) prev.focus({ preventScroll: true });
    };
  }, [anchor]);
  const place = useCallback(() => {
    if (!anchor || !ref.current) return;
    const r = rectOf(anchor);
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const top = h + 4 <= below || below >= above ? r.bottom + 4 : Math.max(8, r.top - 4 - Math.min(h, above));
    setPos({ left, top, maxH: Math.max(160, top >= r.bottom ? below - 4 : above - 4) });
  }, [anchor, align]);
  useLayoutEffect(() => {
    place();
  }, [place, children]);
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) return;
      // A click inside a newer overlay (a nested popover or a modal on top) is not "outside".
      const layer = t.closest?.("[data-pj-layer]") as HTMLElement | null;
      if (layer && Number(layer.dataset.pjDepth) > Number(ref.current?.dataset.pjDepth ?? 0)) return;
      onClose();
    };
    const onResize = () => place();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, onClose, place]);
  if (!anchor || typeof document === "undefined") return null;
  const depth = overlays.get().length;
  return createPortal(
    <>
      {/* On phones the popover is a bottom sheet over a scrim (responsive/projects.css); a tap there only closes it. */}
      <div className="pj-pop-scrim" aria-hidden="true" data-pj-layer="" data-pj-depth={depth} />
      <div
        ref={ref}
        className={`pj-popover ${className ?? ""}`}
        role="dialog"
        aria-label={label}
        data-pj-layer=""
        data-pj-depth={depth}
        // Measured off-screen first; still focusable there (a hidden element cannot take focus).
        style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width, maxHeight: pos?.maxH, opacity: pos ? 1 : 0 }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body
  );
}

export function usePopover(): { anchor: Anchor; open: (a: Anchor) => void; close: () => void; toggle: (a: HTMLElement) => void } {
  const [anchor, setAnchor] = useState<Anchor>(null);
  const close = useCallback(() => setAnchor(null), []);
  const toggle = useCallback((a: HTMLElement) => setAnchor((cur) => (cur ? null : a)), []);
  return { anchor, open: setAnchor, close, toggle };
}

// --- Searchable menu -----------------------------------------------------------

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  right?: ReactNode;
  checked?: boolean;
  hint?: string;
  keywords?: string;
  group?: string;
  danger?: boolean;
  disabled?: boolean;
  /** A key that picks the item while the menu is open (e.g. "1" for urgent). */
  hotkey?: string;
  /** Picking it keeps the menu open (it opens a sub-menu). */
  keepOpen?: boolean;
  /** Shown whatever is typed (results already found by the server). */
  always?: boolean;
  onSelect: () => void;
}

export function Menu({
  items,
  placeholder,
  onClose,
  multi = false,
  search = true,
  footer,
  emptyText,
  onCreate,
  createLabel,
  query,
  onQuery,
  autoFocus = true,
}: {
  items: MenuItem[];
  placeholder?: string;
  onClose: () => void;
  multi?: boolean;
  search?: boolean;
  footer?: ReactNode;
  emptyText?: string;
  /** Typed text that matches nothing can create an item (a new label). */
  onCreate?: (text: string) => void;
  createLabel?: (text: string) => string;
  /** Controlled search text (the command palette also searches the server). */
  query?: string;
  onQuery?: (q: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useT();
  const [own, setOwn] = useState("");
  const [active, setActive] = useState(0);
  const q = query ?? own;
  const setQ = (v: string) => {
    setActive(0);
    (onQuery ?? setOwn)(v);
  };
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const s = q.trim().toLocaleLowerCase();
    if (!s) return items;
    const words = s.split(/\s+/);
    return items.filter((i) => {
      if (i.always) return true;
      const hay = `${i.label} ${i.keywords ?? ""} ${i.hint ?? ""}`.toLocaleLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, q]);
  const canCreate = Boolean(onCreate && q.trim() && !items.some((i) => i.label.toLocaleLowerCase() === q.trim().toLocaleLowerCase()));
  const total = filtered.length + (canCreate ? 1 : 0);
  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    if (!search) listRef.current?.focus();
  }, [search, autoFocus]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const pick = (i: number) => {
    if (i === filtered.length && canCreate) {
      onCreate?.(q.trim());
      setQ("");
      if (!multi) onClose();
      return;
    }
    const it = filtered[i];
    if (!it || it.disabled) return;
    it.onSelect();
    if (!multi && !it.keepOpen) onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (total ? (a + 1) % total : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (total ? (a - 1 + total) % total : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(active);
    } else if (!q && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const hk = filtered.findIndex((i) => i.hotkey && i.hotkey === e.key);
      if (hk >= 0) {
        e.preventDefault();
        pick(hk);
      }
    }
  };
  const heads = filtered.map((it, i) => (it.group && it.group !== filtered[i - 1]?.group ? it.group : null));
  return (
    <div className="pj-menu" onKeyDown={onKey}>
      {search && (
        <div className="pj-menu-search">
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? t("c.search")} aria-label={placeholder ?? t("c.search")} />
        </div>
      )}
      <div className="pj-menu-list" ref={listRef} role="listbox" tabIndex={search ? -1 : 0} aria-multiselectable={multi || undefined}>
        {filtered.map((it, i) => {
          const head = heads[i];
          return (
            <div key={it.id}>
              {head && <div className="pj-menu-group">{head}</div>}
              <div
                role="option"
                aria-selected={it.checked ?? i === active}
                aria-disabled={it.disabled || undefined}
                data-idx={i}
                data-active={i === active || undefined}
                data-danger={it.danger || undefined}
                className="pj-menu-item"
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
              >
                {multi && <span className="pj-check" data-on={it.checked || undefined}>{it.checked && <Check size={11} strokeWidth={3} />}</span>}
                {it.icon !== undefined && <span className="pj-menu-icon">{it.icon}</span>}
                <span className="pj-menu-label">{it.label}</span>
                {it.right}
                {!multi && it.checked && <Check size={14} className="pj-menu-tick" />}
                {it.hotkey && <kbd className="pj-kbd pj-menu-kbd">{it.hotkey}</kbd>}
              </div>
            </div>
          );
        })}
        {canCreate && (
          <div role="option" aria-selected={active === filtered.length} data-idx={filtered.length} data-active={active === filtered.length || undefined} className="pj-menu-item" onMouseMove={() => setActive(filtered.length)} onClick={() => pick(filtered.length)}>
            <span className="pj-menu-label">{createLabel ? createLabel(q.trim()) : q.trim()}</span>
          </div>
        )}
        {total === 0 && <div className="pj-menu-empty">{emptyText ?? t("c.noResults")}</div>}
      </div>
      {footer}
    </div>
  );
}

// --- Modal ---------------------------------------------------------------------

export function Modal({ onClose, children, width = 560, label, className, top }: { onClose: () => void; children: ReactNode; width?: number; label: string; className?: string; top?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(id, onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[autofocus], input, textarea, [contenteditable=true], button");
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="pj-scrim" data-top={top || undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-pj-layer="" data-pj-depth={overlays.get().length}>
      <div ref={ref} className={`pj-modal ${className ?? ""}`} role="dialog" aria-modal="true" aria-label={label} style={{ maxWidth: width }} onKeyDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  );
}

// --- Confirmation --------------------------------------------------------------

interface ConfirmReq {
  title: string;
  body?: string;
  ok: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
const confirmStore = new Store<ConfirmReq | null>(null);

export function confirmDialog(opts: { title: string; body?: string; ok: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => confirmStore.set({ ...opts, resolve }));
}

export function ConfirmHost() {
  const req = useStore(confirmStore);
  const { t } = useT();
  if (!req) return null;
  const done = (v: boolean) => {
    confirmStore.set(null);
    req.resolve(v);
  };
  return (
    <Modal onClose={() => done(false)} label={req.title} width={440} top>
      <div className="pj-confirm">
        <h2>{req.title}</h2>
        {req.body && <p>{req.body}</p>}
        <div className="pj-row-end">
          <button type="button" className="pj-btn" onClick={() => done(false)}>
            {t("c.cancel")}
          </button>
          <button type="button" className={`pj-btn ${req.danger ? "pj-btn-danger" : "pj-btn-primary"}`} autoFocus onClick={() => done(true)}>
            {req.ok}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Small pieces --------------------------------------------------------------

const AVATAR_COLORS = ["#0d99ff", "#26b5ce", "#4cb782", "#d4a72c", "#f2994a", "#eb5757", "#bb87fc", "#e05fa8", "#2b6aa8", "#0f783c"];
const LIGHT_AVATARS = new Set(["#0d99ff", "#26b5ce", "#4cb782", "#d4a72c", "#f2994a", "#eb5757", "#bb87fc", "#e05fa8"]);

export function Avatar({ name, id, size = 20, src, faded }: { name: string; id?: string | null; size?: number; src?: string | null; faded?: boolean }) {
  const key = id ?? name;
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  // One letter, like every avatar in zvena (the shell, Docs, sharing).
  const initial = ([...name.trim()][0] ?? "?").toUpperCase();
  const bg = AVATAR_COLORS[h % AVATAR_COLORS.length];
  // White on the dark colors, dark text on the light ones (contrast 4.5:1 or better either way).
  const style: CSSProperties = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)), background: bg, color: LIGHT_AVATARS.has(bg) ? "#1e1e1e" : "#ffffff", opacity: faded ? 0.55 : 1 };
  if (src && /^(https:\/\/|\/)/.test(src))
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="pj-avatar" src={src} alt="" style={style} referrerPolicy="no-referrer" />;
  return (
    <span className="pj-avatar" style={style} aria-hidden="true">
      {initial}
    </span>
  );
}

export function UnassignedIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className="pj-unassigned">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeDasharray="2.2 2.2" />
      <circle cx="8" cy="6.5" r="2" fill="currentColor" />
      <path d="M4.5 11.8c.7-1.4 2-2.1 3.5-2.1s2.8.7 3.5 2.1" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** A keycap: zvena's design-system Kbd (one look for shortcuts everywhere). */
export function Kbd({ children }: { children: ReactNode }) {
  return <DsKbd keys={[String(children)]} />;
}

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = () => (isMac() ? "⌘" : "Ctrl");

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="pj-spin" aria-hidden="true" />;
}

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  const { t } = useT();
  return (
    <div className="pj-skeleton" aria-busy="true" aria-label={t("c.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="pj-skel-row">
          <span className="pj-skel" style={{ width: 16 }} />
          <span className="pj-skel" style={{ width: 52 }} />
          <span className="pj-skel" style={{ width: `${30 + ((i * 17) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** An empty screen (design system: EmptyStart): says what to do next, with its starts. */
export function Empty({ title, hint, action, starts }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode; starts?: Start[] }) {
  return (
    <div className="pj-empty-start">
      <EmptyStart title={title} hint={hint} starts={starts ?? []} />
      {action && <div className="pj-empty-action">{action}</div>}
    </div>
  );
}

export function ErrorState({ text, onRetry }: { text?: string; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div className="pj-empty pj-error" role="alert">
      <div className="pj-empty-icon">
        <AlertTriangle size={22} />
      </div>
      <div className="pj-empty-title">{text ?? t("c.error")}</div>
      {onRetry && (
        <button type="button" className="pj-btn" onClick={onRetry}>
          {t("c.retry")}
        </button>
      )}
    </div>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, { label: string; children: ReactNode; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean; disabled?: boolean; className?: string; kbd?: string }>(
  function IconButton({ label, children, onClick, active, disabled, className, kbd }, ref) {
    return (
      <button ref={ref} type="button" className={`pj-icon-btn ${className ?? ""}`} aria-label={label} title={kbd ? `${label} (${kbd})` : label} data-active={active || undefined} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  }
);

/** zvena's one on/off control (ds Switch), under the name Projects has used. */
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <Switch checked={on} onChange={onChange} label={label} disabled={disabled} />;
}

// --- Date picker ---------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function DatePicker({ value, onPick, onClose, allowClear = true }: { value: string | null; onPick: (v: string | null) => void; onClose: () => void; allowClear?: boolean }) {
  const { t, lang } = useT();
  const today = new Date();
  const start = value ? new Date(`${value}T12:00:00`) : today;
  const [month, setMonth] = useState(new Date(start.getFullYear(), start.getMonth(), 1));
  const weekStart = weekStartIn(lang);
  const first = (month.getDay() - weekStart + 7) % 7; // the language's first day of the week
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array.from({ length: first }, () => null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  const fmt = new Intl.DateTimeFormat(intlOf(lang), { month: "long", year: "numeric" });
  const wd = weekdayNames(lang, "compact", weekStart);
  const pick = (v: string | null) => {
    onPick(v);
    onClose();
  };
  const plus = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  return (
    <div className="pj-date">
      <div className="pj-date-quick">
        <button type="button" onClick={() => pick(plus(0))}>
          {t("c.today")}
        </button>
        <button type="button" onClick={() => pick(plus(1))}>
          {t("c.tomorrow")}
        </button>
        <button type="button" onClick={() => pick(plus(7))}>
          {t("c.nextWeek")}
        </button>
      </div>
      <div className="pj-date-head">
        <button type="button" className="pj-icon-btn" aria-label="‹" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          <ChevronLeft size={15} />
        </button>
        <span>{fmt.format(month).replace(/^./, (c) => c.toUpperCase())}</span>
        <button type="button" className="pj-icon-btn" aria-label="›" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="pj-date-grid">
        {wd.map((d) => (
          <span key={d} className="pj-date-wd">
            {d}
          </span>
        ))}
        {cells.map((d, i) =>
          d ? (
            <button type="button" key={i} className="pj-date-day" data-today={iso(d) === iso(today) || undefined} data-on={value === iso(d) || undefined} onClick={() => pick(iso(d))}>
              {d.getDate()}
            </button>
          ) : (
            <span key={i} />
          )
        )}
      </div>
      <div className="pj-date-foot">
        <input type="date" className="pj-input pj-input-sm" defaultValue={value ?? ""} onChange={(e) => e.target.value && pick(e.target.value)} aria-label={t("a11y.date")} />
        {allowClear && value && (
          <button type="button" className="pj-btn pj-btn-sm" onClick={() => pick(null)}>
            <X size={13} />
            {t("c.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

// --- Formatting ----------------------------------------------------------------

export function useFormat() {
  const { t, lang } = useT();
  return useMemo(() => {
    const loc = intlOf(lang);
    const dShort = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short" });
    const dLong = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", year: "numeric" });
    const dt = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const thisYear = new Date().getFullYear();
    return {
      day: (v: string | number) => {
        const d = typeof v === "number" ? new Date(v) : new Date(`${v}T12:00:00`);
        return d.getFullYear() === thisYear ? dShort.format(d) : dLong.format(d);
      },
      dateTime: (ts: number) => dt.format(new Date(ts)),
      ago: (ts: number) => {
        const s = Math.max(0, (Date.now() - ts) / 1000);
        if (s < 60) return t("c.justNow");
        if (s < 3600) return t("c.minAgo", { n: Math.floor(s / 60) });
        if (s < 86400) return t("c.hAgo", { n: Math.floor(s / 3600) });
        if (s < 86400 * 30) return t("c.dAgo", { n: Math.floor(s / 86400) });
        return dShort.format(new Date(ts));
      },
    };
  }, [lang, t]);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
