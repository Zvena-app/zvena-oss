"use client";

// Dragging issues (board cards, list rows, calendar chips) with pointer
// events: works from anywhere on a card (title included), shows a ghost and
// the drop place, scrolls the board and lists near their edges, and Escape
// cancels. Drop zones are elements with data-drop-zone="<key>"; the items
// inside them (rows, cards) carry data-id. On touch screens (Linear's iOS
// app): a swipe scrolls as usual; a long press (450 ms, still) presses the
// item, then moving drags it and letting go opens its menu (onLongPress).

import type { PointerEvent as ReactPointerEvent } from "react";
import { Store } from "./data";

export interface DropTarget {
  zone: string;
  /** The item shown above the drop place, and the one below it. */
  before: string | null;
  after: string | null;
  index: number;
}

export const dragState = new Store<{ issueId: string | null; target: DropTarget | null }>({ issueId: null, target: null });

const INTERACTIVE = "button, input, select, textarea, label, [contenteditable='true'], .pj-prop-btn";

function targetAt(x: number, y: number, issueId: string, itemSelector: string): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const zone = el?.closest<HTMLElement>("[data-drop-zone]");
  if (!zone) return null;
  const items = [...zone.querySelectorAll<HTMLElement>(itemSelector)].filter((i) => i.dataset.id !== issueId);
  let index = items.length;
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      index = i;
      break;
    }
  }
  return { zone: zone.dataset.dropZone as string, before: items[index - 1]?.dataset.id ?? null, after: items[index]?.dataset.id ?? null, index };
}

/** The scrollable ancestor in one direction (the board scrolls sideways, columns and the page down). */
function scroller(el: Element | null, axis: "x" | "y"): HTMLElement | null {
  for (let cur = el as HTMLElement | null; cur; cur = cur.parentElement) {
    const st = getComputedStyle(cur);
    const ov = axis === "x" ? st.overflowX : st.overflowY;
    if ((ov === "auto" || ov === "scroll") && (axis === "x" ? cur.scrollWidth > cur.clientWidth : cur.scrollHeight > cur.clientHeight)) return cur;
  }
  return null;
}

let lastPointer = "mouse";
if (typeof window !== "undefined") window.addEventListener("pointerdown", (e) => (lastPointer = e.pointerType), true);
/** The last pointer was a finger (a tap while issues are selected toggles them, as on Linear's iOS app). */
export const touchedLast = (): boolean => lastPointer === "touch";

const PRESS_MS = 450;
const SLOP = 8;

/** Call from onPointerDown of a draggable issue element. */
export function beginDrag(
  e: ReactPointerEvent<HTMLElement>,
  issueId: string,
  opts: { itemSelector: string; onDrop: (issueId: string, target: DropTarget) => void; onLongPress?: (x: number, y: number) => void; drag?: boolean }
): void {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
  if (e.pointerType === "touch") return touchPress(e, issueId, opts);
  if (opts.drag === false) return;
  const src = e.currentTarget;
  const startX = e.clientX;
  const startY = e.clientY;
  const rect = src.getBoundingClientRect();
  let ghost: HTMLElement | null = null;
  let last = { x: startX, y: startY };
  let raf = 0;

  const place = () => {
    if (!ghost) return;
    ghost.style.transform = `translate(${last.x - (startX - rect.left)}px, ${last.y - (startY - rect.top)}px) rotate(1.2deg)`;
    dragState.set({ issueId, target: targetAt(last.x, last.y, issueId, opts.itemSelector) });
  };
  const autoscroll = () => {
    if (!ghost) return;
    const under = document.elementFromPoint(last.x, last.y);
    const edge = 48;
    const sx = scroller(under, "x");
    if (sx) {
      const r = sx.getBoundingClientRect();
      if (last.x < r.left + edge) sx.scrollLeft -= 14;
      else if (last.x > r.right - edge) sx.scrollLeft += 14;
    }
    const sy = scroller(under, "y");
    if (sy) {
      const r = sy.getBoundingClientRect();
      if (last.y < r.top + edge) sy.scrollTop -= 12;
      else if (last.y > r.bottom - edge) sy.scrollTop += 12;
    }
    place();
    raf = requestAnimationFrame(autoscroll);
  };
  const start = () => {
    ghost = src.cloneNode(true) as HTMLElement;
    ghost.classList.add("pj-drag-ghost");
    Object.assign(ghost.style, { position: "fixed", left: "0", top: "0", width: `${rect.width}px`, height: `${rect.height}px`, pointerEvents: "none", zIndex: "2000", margin: "0" });
    document.body.appendChild(ghost);
    src.classList.add("pj-dragging");
    document.body.classList.add("pj-drag-active");
    raf = requestAnimationFrame(autoscroll);
  };
  const cleanup = () => {
    cancelAnimationFrame(raf);
    ghost?.remove();
    src.classList.remove("pj-dragging");
    document.body.classList.remove("pj-drag-active");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
  };
  const onMove = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      start();
    }
    ev.preventDefault();
    place();
  };
  const onUp = (ev: PointerEvent) => {
    const dragged = Boolean(ghost);
    const target = dragged ? targetAt(ev.clientX, ev.clientY, issueId, opts.itemSelector) : null;
    cleanup();
    dragState.set({ issueId: null, target: null });
    if (!dragged) return;
    // The click that ends a drag must not open the issue.
    const swallow = (c: MouseEvent) => {
      c.preventDefault();
      c.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (target) opts.onDrop(issueId, target);
  };
  const onCancel = () => {
    cleanup();
    dragState.set({ issueId: null, target: null });
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !ghost) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    onCancel();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}

/** The mouse events a browser makes up after a long press must neither open the issue nor close the menu just opened. */
function swallowClick(): void {
  const swallow = (c: Event) => {
    c.preventDefault();
    c.stopPropagation();
  };
  for (const type of ["mousedown", "mouseup", "click"] as const) window.addEventListener(type, swallow, { capture: true, once: true });
  setTimeout(() => {
    for (const type of ["mousedown", "mouseup", "click"] as const) window.removeEventListener(type, swallow, { capture: true });
  }, 400);
}

/** Touch: wait for a still long press; until then the browser scrolls as usual (it cancels the pointer). */
function touchPress(e: ReactPointerEvent<HTMLElement>, issueId: string, opts: { itemSelector: string; onDrop: (issueId: string, target: DropTarget) => void; onLongPress?: (x: number, y: number) => void; drag?: boolean }): void {
  const src = e.currentTarget;
  const startX = e.clientX;
  const startY = e.clientY;
  let pressed = false;
  let ghost: HTMLElement | null = null;
  let rect = src.getBoundingClientRect();
  let last = { x: startX, y: startY };
  let raf = 0;
  const timer = window.setTimeout(() => {
    pressed = true;
    rect = src.getBoundingClientRect();
    src.classList.add("pj-pressed");
  }, PRESS_MS);

  const place = () => {
    if (!ghost) return;
    ghost.style.transform = `translate(${last.x - (startX - rect.left)}px, ${last.y - (startY - rect.top)}px) rotate(1.2deg) scale(1.02)`;
    dragState.set({ issueId, target: targetAt(last.x, last.y, issueId, opts.itemSelector) });
  };
  const autoscroll = () => {
    if (!ghost) return;
    const under = document.elementFromPoint(last.x, last.y);
    const edge = 56;
    const sx = scroller(under, "x");
    if (sx) {
      const r = sx.getBoundingClientRect();
      if (last.x < r.left + edge) sx.scrollLeft -= 12;
      else if (last.x > r.right - edge) sx.scrollLeft += 12;
    }
    const sy = scroller(under, "y");
    if (sy) {
      const r = sy.getBoundingClientRect();
      if (last.y < r.top + edge) sy.scrollTop -= 10;
      else if (last.y > r.bottom - edge) sy.scrollTop += 10;
    }
    place();
    raf = requestAnimationFrame(autoscroll);
  };
  // Once pressed, the finger moves the item, not the page; the long-press menu of the browser stays shut.
  const blockScroll = (ev: TouchEvent) => pressed && ev.cancelable && ev.preventDefault();
  const blockMenu = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  const cleanup = () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    ghost?.remove();
    src.classList.remove("pj-pressed", "pj-dragging");
    document.body.classList.remove("pj-drag-active");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("scroll", onCancel, true);
    window.removeEventListener("touchmove", blockScroll);
    setTimeout(() => window.removeEventListener("contextmenu", blockMenu, true), 0);
  };
  const onMove = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    const far = Math.hypot(ev.clientX - startX, ev.clientY - startY) > SLOP;
    if (!pressed) {
      if (far) onCancel();
      return;
    }
    if (!ghost) {
      if (!far || opts.drag === false) return;
      ghost = src.cloneNode(true) as HTMLElement;
      ghost.classList.remove("pj-pressed");
      ghost.classList.add("pj-drag-ghost");
      Object.assign(ghost.style, { position: "fixed", left: "0", top: "0", width: `${rect.width}px`, height: `${rect.height}px`, pointerEvents: "none", zIndex: "2000", margin: "0" });
      document.body.appendChild(ghost);
      src.classList.remove("pj-pressed");
      src.classList.add("pj-dragging");
      document.body.classList.add("pj-drag-active");
      window.removeEventListener("scroll", onCancel, true); // the board scrolls under the finger now
      raf = requestAnimationFrame(autoscroll);
    }
    place();
  };
  const onUp = (ev: PointerEvent) => {
    const wasPressed = pressed;
    const dragged = Boolean(ghost);
    const target = dragged ? targetAt(ev.clientX, ev.clientY, issueId, opts.itemSelector) : null;
    cleanup();
    dragState.set({ issueId: null, target: null });
    if (!wasPressed) return;
    swallowClick();
    if (dragged) {
      if (target) opts.onDrop(issueId, target);
    } else opts.onLongPress?.(ev.clientX, ev.clientY);
  };
  const onCancel = () => {
    cleanup();
    dragState.set({ issueId: null, target: null });
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("scroll", onCancel, true);
  window.addEventListener("touchmove", blockScroll, { passive: false });
  window.addEventListener("contextmenu", blockMenu, true);
}
