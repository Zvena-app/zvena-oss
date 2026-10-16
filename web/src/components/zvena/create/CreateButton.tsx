"use client";

// "+ Create" at the top of every sidebar (Canva keeps its Create button in
// the same place on every screen): one click opens the picker next to it,
// a second click on a tile makes the thing. "C" opens it from anywhere that
// is not a text field, a menu or a dialog, unless the section binds "C"
// itself (`hotkey={false}`: Projects makes a new issue). Esc or a click
// outside closes it. On a phone it is a sheet from the bottom.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, SquarePen, X } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { CreatePicker } from "./CreatePicker";
import { isTyping, overlayOpen } from "@/components/zvena/ds/keys";
import { ct } from "./i18n";
import "./create.css";

/** `compact`: Linear's compose button — a round icon next to the workspace menu (the rail's header). */
export function CreateButton({ ws, canEdit, hotkey = true, compact = false }: { ws: string; canEdit: boolean; hotkey?: boolean; compact?: boolean }) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    // The rail's compose button sits at the rail's right edge: the picker opens beside the rail, under it.
    setPos(r ? { top: Math.max(8, compact ? r.bottom + 6 : r.top), left: r.right + 8 } : null);
    setOpen(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (hotkey && canEdit && !open && !e.defaultPrevented && (e.key === "c" || e.key === "с") && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target) && !overlayOpen(document)) {
        e.preventDefault();
        show();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (open && !pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, canEdit, hotkey]);

  if (!canEdit) return null;
  return (
    <>
      {compact ? (
        <button
          ref={btn}
          type="button"
          className="zc-create-icon"
          aria-label={ct("create", locale)}
          title={hotkey ? `${ct("create", locale)} (C)` : ct("create", locale)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-keyshortcuts={hotkey ? "C" : undefined}
          onClick={() => (open ? setOpen(false) : show())}
        >
          <SquarePen />
        </button>
      ) : (
        <button ref={btn} type="button" className="zc-create-btn" aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts={hotkey ? "C" : undefined} onClick={() => (open ? setOpen(false) : show())}>
          <Plus />
          {ct("create", locale)}
        </button>
      )}
      {/* In a portal: the rail's compose button lives in the phone drawer, which is hidden (and moved off-screen) once the sheet opens. */}
      {open &&
        createPortal(
          <>
            <div className="zc-scrim" onClick={() => setOpen(false)} />
            <div ref={pop} className="zc-pop" role="dialog" aria-label={ct("create", locale)} style={pos ? ({ "--zc-top": `${pos.top}px`, "--zc-left": `${pos.left}px` } as React.CSSProperties) : undefined}>
              <button type="button" className="zc-pop-close" aria-label={ct("close", locale)} onClick={() => setOpen(false)}>
                <X />
              </button>
              <CreatePicker ws={ws} autoFocus />
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
