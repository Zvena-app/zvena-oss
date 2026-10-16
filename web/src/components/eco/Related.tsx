"use client";

// "Related": everything an object is linked with, across products — the
// issues a page mentions, the pages that mention an issue, the designs made
// for it — live, grouped by kind. People can link more by hand ("Link…") and
// remove what they linked; links that come from text change with the text.
//
//   <Related ws={ws} refKey="note:<id>" />                 a full panel
//   <Related ws={ws} refKey="issue:<id>" collapsible />    a one-line bar that opens

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Link2, Network, X } from "lucide-react";
import type { RefKind } from "@/lib/eco/refs";
import type { Card, RelatedItem } from "@/lib/eco/types";
import { eco, useCard, useRelated } from "./client";
import { CardView } from "./CardView";
import { type EcoKey, useEt } from "./i18n";
import { SearchList } from "./SearchList";
import "./eco.css";

const ORDER: RefKind[] = ["issue", "note", "project", "event", "design", "mail", "user"];
const GROUP: Record<RefKind, EcoKey> = { issue: "issues", note: "docs", project: "projects", design: "designs", user: "people", event: "events", mail: "mail" };

function LiveRow({ ws, item, canEdit, onUnlink }: { ws: string; item: RelatedItem; canEdit: boolean; onUnlink: (c: Card) => void }) {
  const et = useEt();
  // The panel's answer seeds the store; the row then follows the object live.
  const live = useCard(ws, item.card.key);
  const card = live === undefined ? item.card : live;
  return (
    <div className="eco-related-item" title={`${et(`via_${item.via}` as EcoKey)} · ${et(item.dir)}`}>
      <CardView
        card={card}
        right={
          <>
            {item.via === "converted" && <span className="eco-via">{et("via_converted")}</span>}
            {item.manual && canEdit && (
              <button
                type="button"
                className="eco-icon-btn"
                aria-label={et("unlink")}
                title={et("unlink")}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onUnlink(item.card);
                }}
              >
                <X size={14} />
              </button>
            )}
          </>
        }
      />
    </div>
  );
}

/** A goal (a linked project) in the panel's header: its progress fills live as its issues close. */
function GoalChip({ ws, item }: { ws: string; item: RelatedItem }) {
  const live = useCard(ws, item.card.key);
  const card = live === undefined ? item.card : live;
  if (!card) return null;
  const pct = Math.round(Math.max(0, Math.min(1, card.progress ?? 0)) * 100);
  const done = card.status?.category === "completed";
  return (
    <a className="eco-goal-chip" href={card.url} data-done={done || undefined} title={`${card.title} · ${pct}%`}>
      <span className="eco-goal-chip-name">{card.icon ? `${card.icon} ` : ""}{card.title}</span>
      <span className="eco-progress" aria-hidden>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="eco-goal-chip-pct">{done ? "✓" : `${pct}%`}</span>
    </a>
  );
}

/** A small floating search to pick something to link. */
export function LinkPopover({ ws, anchor, exclude, onPick, onClose, kinds, placeholder }: { ws: string; anchor: HTMLElement; exclude: string[]; onPick: (c: Card) => void; onClose: () => void; kinds?: readonly RefKind[]; placeholder?: string }) {
  const et = useEt();
  const ref = useRef<HTMLDivElement>(null);
  // Under the button, or above it when there is no room below.
  const pos = useMemo(() => {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(420, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
    const below = r.bottom + 6;
    return { top: below + 380 > window.innerHeight ? Math.max(16, r.top - 386) : below, left };
  }, [anchor]);
  useLayoutEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", down, true);
    return () => document.removeEventListener("mousedown", down, true);
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="eco-popover eco-root" style={{ top: pos.top, left: pos.left }} role="dialog">
      <SearchList ws={ws} kinds={kinds} exclude={exclude} placeholder={placeholder ?? et("linkSearch")} onPick={onPick} onClose={onClose} />
    </div>,
    document.body
  );
}

const LINK_EVENT = "zvena:link";

/** Opens the "Link…" search of the Related panel of `refKey` (a menu item elsewhere on the page). */
export function openLinkPicker(refKey: string, anchor: HTMLElement): void {
  window.dispatchEvent(new CustomEvent(LINK_EVENT, { detail: { refKey, anchor } }));
}

export function Related({
  ws,
  refKey,
  canEdit = true,
  collapsible = false,
  defaultOpen = true,
  title,
  kinds,
  hideWhenEmpty = false,
  incomingOnly = false,
}: {
  ws: string;
  refKey: string;
  canEdit?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
  title?: string;
  /** Only these kinds (a document's panel leaves pages to its own backlinks). */
  kinds?: readonly RefKind[];
  /** Nothing at all while nothing is linked ("Link…" can still be opened with openLinkPicker). */
  hideWhenEmpty?: boolean;
  /** Only what points here and links made by hand (a page already shows what it points at). */
  incomingOnly?: boolean;
}) {
  const et = useEt();
  const { data, error, reload } = useRelated(ws, refKey);
  const [open, setOpen] = useState(defaultOpen);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ refKey: string; anchor: HTMLElement }>).detail;
      if (d?.refKey === refKey) {
        setOpen(true);
        setPicker(d.anchor);
      }
    };
    window.addEventListener(LINK_EVENT, on);
    return () => window.removeEventListener(LINK_EVENT, on);
  }, [refKey]);
  const items = useMemo(() => (data?.items ?? []).filter((i) => (!kinds || kinds.includes(i.card.kind)) && (!incomingOnly || i.dir === "in" || i.manual)), [data, kinds, incomingOnly]);
  // Goals (projects) show their progress in the header, open or not.
  const goals = useMemo(() => items.filter((i) => i.card.kind === "project"), [items]);
  const groups = useMemo(() => ORDER.map((k) => ({ kind: k, items: items.filter((i) => i.card.kind === k) })).filter((g) => g.items.length), [items]);
  const add = async (c: Card) => {
    setPicker(null);
    try {
      await eco.link(ws, refKey, c.key);
      setFailed(false);
      reload();
    } catch {
      setFailed(true);
    }
  };
  const remove = async (c: Card) => {
    try {
      await eco.unlink(ws, refKey, c.key);
      reload();
    } catch {
      setFailed(true);
    }
  };
  const count = items.length;
  const Chevron = open ? ChevronDown : ChevronRight;
  const pickerEl = picker && (
    <LinkPopover ws={ws} anchor={picker} exclude={[refKey, ...items.map((i) => i.card.key)]} onPick={(c) => void add(c)} onClose={() => setPicker(null)} kinds={kinds ?? ["issue", "note", "project", "design"]} />
  );
  if (hideWhenEmpty && count === 0) return pickerEl || null;
  return (
    <section className="eco-related" aria-label={title ?? et("related")} data-eco-related={refKey}>
      <div className="eco-related-head">
        {collapsible ? (
          <button type="button" className="eco-related-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Network size={14} />
            <span>{title ?? et("related")}</span>
            {data && <span className="eco-count">{count}</span>}
            <Chevron size={14} />
          </button>
        ) : (
          <>
            <Network size={14} />
            <span>{title ?? et("related")}</span>
            {data && <span className="eco-count">{count}</span>}
          </>
        )}
        {goals.length > 0 && (
          <span className="eco-goal-chips">
            {goals.slice(0, 3).map((i) => (
              <GoalChip key={i.card.key} ws={ws} item={i} />
            ))}
          </span>
        )}
        <span className="eco-spacer" />
        {canEdit && (
          <button type="button" className="eco-btn eco-btn-ghost" onClick={(e) => setPicker(e.currentTarget)} aria-haspopup="dialog">
            <Link2 size={14} />
            {et("link")}
          </button>
        )}
      </div>
      {open && (
        <div>
          {groups.map((g) => (
            <div key={g.kind} className="eco-related-group">
              <div className="eco-related-group-title">{et(GROUP[g.kind])}</div>
              {g.items.map((i) => (
                <LiveRow key={i.card.key} ws={ws} item={i} canEdit={canEdit} onUnlink={remove} />
              ))}
            </div>
          ))}
          {data && count === 0 && <div className="eco-related-empty">{et("relatedEmpty")}</div>}
          {data?.indexing && <div className="eco-related-note">{et("indexing")}</div>}
          {(error || failed) && <div className="eco-related-note">{et("failed")}</div>}
        </div>
      )}
      {pickerEl}
    </section>
  );
}

/** One live card by key, for places that show a single linked object. */
export function LiveCard({ ws, refKey, variant = "row" }: { ws: string; refKey: string; variant?: "row" | "chip" | "block" }) {
  const card = useCard(ws, refKey);
  return <CardView card={card} variant={variant} />;
}
