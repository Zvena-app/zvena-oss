"use client";

// The live parts of Home: cards the server picked (so the page paints at
// once) that then follow their objects, the Inbox's newest items, and the
// search button that opens Cmd+K.

import { useEffect } from "react";
import { Search } from "lucide-react";
import type { Card, InboxItem } from "@/lib/eco/types";
import { PriorityIcon } from "@/components/projects/icons";
import { cardStore, useCard, useModKey } from "./client";
import { CardView } from "./CardView";
import { openPalette } from "./CommandPalette";
import { InboxView } from "./InboxView";
import { useEt } from "./i18n";
import "./eco.css";

function Live({ ws, card, check, prio }: { ws: string; card: Card; check: boolean; prio?: string[] }) {
  const live = useCard(ws, card.key);
  const c = live === undefined ? card : live;
  if (c === null) return null;
  if (!check || c.kind !== "issue") return <CardView card={c} />;
  const p = c.priority ?? 0;
  return <CardView card={c} variant="block" statusWs={ws} lead={prio && p >= 0 && p <= 4 ? <PriorityIcon priority={p as 0 | 1 | 2 | 3 | 4} size={16} title={prio[p]} /> : undefined} />;
}

/**
 * Server-picked cards, live from here on. `check`: issues get their status menu;
 * `prio`: the five priority names (none, urgent … low) — issues show theirs.
 */
export function LiveCards({ ws, cards, empty, check = false, prio, list = false }: { ws: string; cards: Card[]; empty?: string; check?: boolean; prio?: string[]; list?: boolean }) {
  useEffect(() => {
    cardStore(ws).seed(cards);
  }, [ws, cards]);
  if (!cards.length) return empty ? <div className={list ? "eco-home-empty" : "zv-empty"}>{empty}</div> : null;
  return (
    <div className="eco-root" style={list ? { display: "flex", flexDirection: "column" } : { display: "flex", flexDirection: "column", gap: check ? 6 : 2 }}>
      {cards.map((c) => (
        <Live key={c.key} ws={ws} card={c} check={check} prio={prio} />
      ))}
    </div>
  );
}

export function HomeInbox({ ws, me, initial }: { ws: string; me: string; initial?: { items: InboxItem[]; unread: number } | null }) {
  return <InboxView ws={ws} me={me} limit={5} initial={initial} />;
}

export function SearchButton({ label }: { label?: string }) {
  const et = useEt();
  const mod = useModKey();
  return (
    <button type="button" className="zv-btn" onClick={() => openPalette()} aria-keyshortcuts="Control+K Meta+K">
      <Search />
      {label ?? et("searchPlaceholder")}
      <kbd className="eco-kbd" style={{ marginInlineStart: 4 }}>
        {mod} K
      </kbd>
    </button>
  );
}
