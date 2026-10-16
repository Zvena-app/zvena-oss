"use client";

// zvena Documents UI primitives: portals, popovers, menus, tooltips, modals and
// toasts — the Notion look (soft shadow, 6px rows, 10px radius) in one place.

import { MARK_PATHS } from "@/components/brand/BrandLogo";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, FileText } from "lucide-react";

/** A ref that always holds the latest value, for listeners registered once. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Portal layer (inherits the theme tokens through .nt-layer)

let layerEl: HTMLElement | null = null;
/** The shared layer for anything Notes renders outside its root (it carries the design tokens). */
export function layer(): HTMLElement {
  if (layerEl && document.body.contains(layerEl)) return layerEl;
  layerEl = document.createElement("div");
  layerEl.className = "nt-layer";
  document.body.appendChild(layerEl);
  return layerEl;
}

export function Portal({ children }: { children: ReactNode }) {
  // Notes renders only in the browser, so the layer exists on the first
  // render: popovers can measure themselves in their layout effect.
  const [el] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : layer()));
  return el ? createPortal(children, el) : null;
}

// ---------------------------------------------------------------------------
// Popover

export type Anchor = HTMLElement | DOMRect | { x: number; y: number; w?: number; h?: number } | null;

function anchorRect(a: Anchor): { left: number; top: number; right: number; bottom: number; width: number; height: number } | null {
  if (!a) return null;
  if (a instanceof HTMLElement) {
    const r = a.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  if (a instanceof DOMRect) return { left: a.left, top: a.top, right: a.right, bottom: a.bottom, width: a.width, height: a.height };
  const w = a.w ?? 0;
  const h = a.h ?? 0;
  return { left: a.x, top: a.y, right: a.x + w, bottom: a.y + h, width: w, height: h };
}

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "right-start" | "left-start" | "bottom-center";

export function Popover({
  anchor,
  onClose,
  placement = "bottom-start",
  offset = 4,
  className,
  style,
  children,
  closeOnScroll = false,
  modalScrim = false,
  anchored = false,
}: {
  anchor: Anchor;
  onClose: () => void;
  placement?: Placement;
  offset?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  closeOnScroll?: boolean;
  /** Notion dims nothing, but blocks clicks underneath until closed. */
  modalScrim?: boolean;
  /** Stays next to its anchor on phones too (no bottom sheet). */
  anchored?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useLatest(onClose);
  // Phones: a bottom sheet over a dimmed page (Notion's iOS app), above the keyboard.
  const sheet = usePhoneSheet() && !anchored;
  const keyboard = useKeyboardInset(sheet);

  const place = useCallback(() => {
    const el = ref.current;
    const r = anchorRect(anchor);
    // A sheet is placed by CSS (responsive/docs.css).
    if (!el || !r || sheet) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.left;
    let top = r.bottom + offset;
    if (placement === "bottom-end") left = r.right - w;
    if (placement === "bottom-center") left = r.left + r.width / 2 - w / 2;
    if (placement === "top-start") top = r.top - h - offset;
    if (placement === "right-start") {
      left = r.right + offset;
      top = r.top - 4;
      if (left + w > vw - 8) left = r.left - w - offset;
    }
    if (placement === "left-start") {
      left = r.left - w - offset;
      top = r.top;
      if (left < 8) left = r.right + offset;
    }
    // Flip vertically when there is no room below.
    if ((placement.startsWith("bottom") || placement === "right-start") && top + h > vh - 8) {
      const above = r.top - h - offset;
      top = above >= 8 ? above : Math.max(8, vh - h - 8);
    }
    if (placement === "top-start" && top < 8) top = r.bottom + offset;
    left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
    top = Math.min(Math.max(8, top), Math.max(8, vh - h - 8));
    setPos({ left, top });
  }, [anchor, placement, offset, sheet]);

  useLayoutEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [place]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      // Clicks inside another popover opened from this one (sub-menus, or the scrim of its sheet) stay.
      const layerHost = (t as HTMLElement).closest?.(".nt-popover, .nt-sheet-scrim");
      if (layerHost && layerHost !== ref.current && Number((layerHost as HTMLElement).dataset.depth ?? 0) > Number(ref.current?.dataset.depth ?? 0)) return;
      if (anchor instanceof HTMLElement && anchor.contains(t)) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // One Escape closes one layer: a sub-menu opened from this popover goes first.
      const mine = Number(ref.current?.dataset.depth ?? 0);
      if ([...document.querySelectorAll<HTMLElement>(".nt-popover")].some((p) => p !== ref.current && Number(p.dataset.depth ?? 0) > mine)) return;
      e.stopPropagation();
      closeRef.current();
    };
    const onScroll = (e: Event) => {
      if (sheet) return;
      if (!closeOnScroll) return place();
      if (ref.current?.contains(e.target as Node)) return;
      closeRef.current();
    };
    const id = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDown, true);
    }, 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, closeOnScroll, place, closeRef, sheet]);

  const depth = useContext(DepthContext);
  return (
    <Portal>
      {modalScrim && !sheet && <div style={{ position: "fixed", inset: 0, zIndex: 999 }} />}
      {sheet && <div className="nt-sheet-scrim" data-depth={depth + 1} style={{ zIndex: 999 + depth }} />}
      <DepthContext.Provider value={depth + 1}>
        <div
          ref={ref}
          data-depth={depth + 1}
          data-sheet={sheet || undefined}
          className={cx("nt-popover", className)}
          // Unplaced popovers stay focusable (autoFocus inputs) but invisible.
          style={
            sheet
              ? { ...style, bottom: keyboard, maxHeight: keyboard ? `calc(100dvh - ${keyboard}px - 16px)` : undefined, zIndex: 1000 + depth }
              : { ...style, left: pos?.left ?? 0, top: pos?.top ?? 0, opacity: pos ? 1 : 0, pointerEvents: pos ? undefined : "none", zIndex: 1000 + depth }
          }
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </DepthContext.Provider>
    </Portal>
  );
}

const DepthContext = createContext(0);

// Phones (and phones on their side): popovers open as bottom sheets.
const SHEET_QUERY = "(max-width: 640px), (max-height: 500px) and (pointer: coarse)";

function usePhoneSheet(): boolean {
  const [on, setOn] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(SHEET_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(SHEET_QUERY);
    const on = () => setOn(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return on;
}

/** How much of the layout viewport the on-screen keyboard covers (iOS shrinks only the visual viewport). */
export function useKeyboardInset(active = true): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) return;
    const place = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    place();
    vv.addEventListener("resize", place);
    vv.addEventListener("scroll", place);
    return () => {
      vv.removeEventListener("resize", place);
      vv.removeEventListener("scroll", place);
    };
  }, [active]);
  return inset;
}

// ---------------------------------------------------------------------------
// Menus

export interface MenuEntry {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  toggle?: boolean;
  submenu?: boolean;
  onSelect?: (el: HTMLElement) => void;
}

export interface MenuGroup {
  key: string;
  label?: ReactNode;
  items: MenuEntry[];
}

/** A keyboard-navigable Notion menu (↑↓ moves, ↵ picks, → opens a submenu). */
export function Menu({ groups, onClose, header, footer, width, autoFocus = true }: { groups: MenuGroup[]; onClose?: () => void; header?: ReactNode; footer?: ReactNode; width?: number; autoFocus?: boolean }) {
  const flat = useMemo(() => groups.flatMap((g) => g.items.filter((i) => !i.disabled)), [groups]);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus && !header) ref.current?.focus({ preventScroll: true });
  }, [autoFocus, header]);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(1, flat.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? flat.length - 1 : a - 1));
    } else if ((e.key === "Enter" || e.key === "ArrowRight") && active >= 0) {
      const item = flat[active];
      if (!item || (e.key === "ArrowRight" && !item.submenu)) return;
      e.preventDefault();
      const el = ref.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(item.key)}"]`);
      if (el) item.onSelect?.(el);
    } else if (e.key === "Escape") {
      onClose?.();
    }
  };
  return (
    <div ref={ref} className="nt-menu" tabIndex={-1} style={width ? { width } : undefined} onKeyDown={onKey} role="menu">
      {header && <div role="group">{header}</div>}
      {groups.map((g) =>
        g.items.length === 0 ? null : (
          <div key={g.key} className="nt-menu-section">
            {g.label && <div className="nt-menu-label">{g.label}</div>}
            {g.items.map((item) => {
              const idx = flat.indexOf(item);
              return (
                <button
                  type="button"
                  key={item.key}
                  data-key={item.key}
                  role={item.toggle ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={item.toggle ? Boolean(item.checked) : undefined}
                  className="nt-mi nt-btn-reset"
                  data-active={idx === active || undefined}
                  data-danger={item.danger || undefined}
                  aria-disabled={item.disabled || undefined}
                  onMouseEnter={() => setActive(idx)}
                  onClick={(e) => item.onSelect?.(e.currentTarget)}
                >
                  {item.icon !== undefined && <span className="nt-mi-icon">{item.icon}</span>}
                  <span className="nt-mi-label">{item.label}</span>
                  {item.hint && <span className="nt-mi-hint">{item.hint}</span>}
                  {item.toggle !== undefined && item.toggle && <span className="nt-mi-toggle" data-on={item.checked ? "true" : "false"} />}
                  {item.checked && !item.toggle && <Check className="nt-mi-check" strokeWidth={2} />}
                  {item.submenu && <ChevronRight className="nt-mi-sub" />}
                </button>
              );
            })}
          </div>
        )
      )}
      {footer}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip (hover, Notion's dark pill with an optional shortcut line)

export function Tip({ label, sub, children, side = "bottom" }: { label: ReactNode; sub?: ReactNode; children: ReactNode; side?: "bottom" | "top" | "right" }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = wrap.current?.firstElementChild as HTMLElement | null;
      if (el) setRect(el.getBoundingClientRect());
    }, 450);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setRect(null);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <span ref={wrap} style={{ display: "contents" }} onPointerEnter={show} onPointerLeave={hide} onPointerDown={hide}>
      {children}
      {rect && (
        <Portal>
          <TipBubble rect={rect} side={side}>
            <div>{label}</div>
            {sub && <div className="nt-tip-sub">{sub}</div>}
          </TipBubble>
        </Portal>
      )}
    </span>
  );
}

function TipBubble({ rect, side, children }: { rect: DOMRect; side: "bottom" | "top" | "right"; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.bottom + 6;
    if (side === "top") top = rect.top - h - 6;
    if (side === "right") {
      left = rect.right + 8;
      top = rect.top + rect.height / 2 - h / 2;
    }
    left = Math.min(Math.max(6, left), window.innerWidth - w - 6);
    top = Math.min(Math.max(6, top), window.innerHeight - h - 6);
    setPos({ left, top });
  }, [rect, side]);
  return (
    <div ref={ref} className="nt-tip" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, textAlign: "center" }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal

export function Modal({ onClose, children, className, label }: { onClose: () => void; children: ReactNode; className?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus goes back where it was (the button that opened the dialog) on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
      <div
        className="nt-modal-scrim"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div ref={ref} className={cx("nt-modal", className)} role="dialog" aria-modal="true" aria-label={label}>
          {children}
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------
// Toasts

interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

type ToastListener = (items: ToastItem[]) => void;
let toastItems: ToastItem[] = [];
const toastListeners = new Set<ToastListener>();
let toastSeq = 0;

export function toast(text: string, action?: { label: string; run: () => void }, ms = 4500): void {
  const item: ToastItem = { id: ++toastSeq, text, action };
  toastItems = [...toastItems.slice(-2), item];
  toastListeners.forEach((fn) => fn(toastItems));
  setTimeout(() => {
    toastItems = toastItems.filter((x) => x.id !== item.id);
    toastListeners.forEach((fn) => fn(toastItems));
  }, ms);
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>(toastItems);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <Portal>
      <div className="nt-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="nt-toast">
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="nt-btn-reset"
                onClick={() => {
                  t.action?.run();
                  toastItems = toastItems.filter((x) => x.id !== t.id);
                  toastListeners.forEach((fn) => fn(toastItems));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------
// Note icon (emoji or the default page glyph)

export function NoteIcon({ icon, size = 18, fallback }: { icon: string; size?: number; fallback?: ReactNode }) {
  if (icon) return <span style={{ fontSize: size, lineHeight: 1 }}>{icon}</span>;
  return <>{fallback ?? <FileText style={{ width: size, height: size }} strokeWidth={1.6} />}</>;
}

/** The "Z" of zvena's mark (components/brand/BrandLogo.tsx), white by default, for a navy chip. */
export function BrandMark({ color = "#ffffff", className }: { color?: string; className?: string }) {
  // zvena's two-shape mark (components/brand/BrandLogo), for a coloured tile.
  return (
    <svg viewBox="0 0 185 185" className={className} aria-hidden="true">
      <path d={MARK_PATHS.join("")} fill={color} />
    </svg>
  );
}

/** The same mark under its earlier name. */
export const BlueMark = BrandMark;


/** Closes on outside pointer-down (for inline popups that are not portals). */
export function useOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, active = true): void {
  const cb = useLatest(onOutside);
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.(".nt-popover")) return;
      cb.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [ref, active, cb]);
}
