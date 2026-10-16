"use client";

// An issue's status wherever the ecosystem shows it (a live block in a
// document, Home, a project's list on its page): Linear's status icon, and a
// click opens the team's whole workflow — Backlog, Todo, In progress, In
// review, Done, Canceled, Duplicate… — not a done / not done checkbox.
//
// Keyboard: Enter / Space / ArrowDown open it; ↑ ↓ Home End move; Enter or
// the status's number picks; Escape closes and gives the focus back.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, CircleDashed } from "lucide-react";
import type { Card, StatusOption } from "@/lib/eco/types";
import { cardStore, eco, type CardState } from "./client";
import { StatusIcon } from "@/components/projects/icons";
import { useEt } from "./i18n";

/** Each issue's statuses, kept while the page is open (a team's workflow rarely changes; a pick refreshes it). */
const known = new Map<string, StatusOption[]>();

function Menu({ ws, card, anchor, onClose }: { ws: string; card: Card; anchor: HTMLElement; onClose: (refocus: boolean) => void }) {
  const et = useEt();
  const issueId = card.key.slice("issue:".length);
  const [options, setOptions] = useState<StatusOption[] | null>(() => known.get(issueId) ?? null);
  const [failed, setFailed] = useState(false);
  const current = card.status?.id;
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [pos] = useState(() => {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(240, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
    const below = r.bottom + 4;
    return { top: below + 300 > window.innerHeight ? Math.max(16, r.top - 304) : below, left, width: w };
  });

  useEffect(() => {
    let live = true;
    eco
      .issueStatuses(ws, issueId)
      .then((r) => {
        known.set(issueId, r.statuses);
        if (!live) return;
        setOptions(r.statuses);
        setActive(Math.max(0, r.statuses.findIndex((s) => s.id === r.current)));
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [ws, issueId]);

  useLayoutEffect(() => {
    ref.current?.focus();
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("mousedown", down, true);
    return () => document.removeEventListener("mousedown", down, true);
  }, [anchor, onClose]);

  const pick = (s: StatusOption) => {
    onClose(true);
    if (s.id === current) return;
    const before = card;
    // At once on every card of this issue; the server's answer (or the old card) follows.
    cardStore(ws).seed([{ ...card, status: { id: s.id, name: s.name, color: s.color, category: s.category, fraction: s.fraction } }]);
    eco
      .issueStatus(ws, issueId, s.id)
      .then((r) => cardStore(ws).seed([r.card]))
      .catch(() => cardStore(ws).seed([before]));
  };

  const onKey = (e: KeyboardEvent) => {
    const n = options?.length ?? 0;
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (!n) return;
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + n) % n);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (options?.[active]) pick(options[active]);
    } else if (/^[1-9]$/.test(e.key) && options?.[Number(e.key) - 1]) {
      e.preventDefault();
      pick(options[Number(e.key) - 1]);
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="eco-popover eco-root eco-status-menu"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      role="menu"
      aria-label={et("statusChange")}
      tabIndex={-1}
      aria-activedescendant={options?.[active] ? `eco-st-${issueId}-${options[active].id}` : undefined}
      onKeyDown={onKey}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="eco-status-menu-head">{et("statusChange")}</div>
      {!options && !failed && <div className="eco-search-empty">{et("loading")}</div>}
      {failed && !options && <div className="eco-search-empty">{et("failed")}</div>}
      {options?.map((s, i) => (
        <div
          key={s.id}
          id={`eco-st-${issueId}-${s.id}`}
          role="menuitemradio"
          aria-checked={s.id === current}
          data-active={i === active || undefined}
          className="eco-status-opt"
          onMouseMove={() => setActive(i)}
          onClick={() => pick(s)}
        >
          <StatusIcon category={s.category} color={s.color} fraction={s.fraction} size={14} />
          <span className="eco-status-opt-name">{s.name}</span>
          {s.id === current && <Check size={14} aria-hidden className="eco-status-opt-check" />}
          {i < 9 && <kbd className="eco-kbd">{i + 1}</kbd>}
        </div>
      ))}
    </div>,
    document.body
  );
}

/** The status icon of an issue card; with `ws` it opens the status menu (else it only shows the status). */
export function StatusButton({ ws, card, size = 16, disabled }: { ws?: string; card: CardState; size?: number; disabled?: boolean }) {
  const et = useEt();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean) => {
    setAnchor(null);
    if (refocus) btn.current?.focus();
  }, []);
  if (!card) return null;
  const icon = card.status ? <StatusIcon category={card.status.category} color={card.status.color} fraction={card.status.fraction} size={size} /> : <CircleDashed size={size} />;
  const label = card.status ? et("statusOf", { status: card.status.name }) : et("statusChange");
  if (!ws)
    return (
      <span className="eco-kind" role="img" aria-label={label} title={label}>
        {icon}
      </span>
    );
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="eco-check"
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        aria-label={`${label} · ${et("statusChange")}`}
        title={label}
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !anchor) {
            e.preventDefault();
            setAnchor(e.currentTarget);
          }
        }}
      >
        {icon}
      </button>
      {anchor && <Menu ws={ws} card={card} anchor={anchor} onClose={close} />}
    </>
  );
}
