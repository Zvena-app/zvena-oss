"use client";

// One search over the whole workspace, as a list the keyboard can drive.
// The command palette (Cmd+K), "Link…" in a Related panel and "link an
// existing issue" in a document all use it.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import type { Card, SearchHit } from "@/lib/eco/types";
import type { RefKind } from "@/lib/eco/refs";
import { cardStore, eco } from "./client";
import { CardView } from "./CardView";
import { type EcoKey, useEt } from "./i18n";

const GROUP: Record<RefKind, EcoKey> = { issue: "issues", note: "docs", project: "projects", design: "designs", user: "people", event: "events", mail: "mail" };
const ORDER: RefKind[] = ["issue", "note", "project", "event", "design", "mail"];

export function useSearch(ws: string, q: string, kinds?: readonly RefKind[]): { hits: SearchHit[]; loading: boolean } {
  // The last answer and the query it answers: while a new one is on its way the old hits stay.
  const [res, setRes] = useState<{ q: string; hits: SearchHit[] } | null>(null);
  useEffect(() => {
    if (!ws) return;
    const ctl = new AbortController();
    const t = setTimeout(
      () => {
        eco
          .search(ws, q, ctl.signal)
          .then((r) => {
            const list = kinds ? r.hits.filter((h) => kinds.includes(h.kind)) : r.hits;
            cardStore(ws).seed(list);
            setRes({ q, hits: list });
          })
          .catch(() => {
            if (!ctl.signal.aborted) setRes({ q, hits: [] });
          });
      },
      q ? 120 : 0
    );
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // `kinds` is a constant per caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, q]);
  return { hits: res?.hits ?? [], loading: res?.q !== q };
}

export interface ExtraItem {
  key: string;
  label: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

export function SearchList({
  ws,
  placeholder,
  kinds,
  exclude,
  onPick,
  onClose,
  extras = [],
  extrasTitle,
  autoFocus = true,
}: {
  ws: string;
  placeholder?: string;
  kinds?: readonly RefKind[];
  exclude?: readonly string[];
  onPick: (card: Card) => void;
  onClose?: () => void;
  extras?: ExtraItem[];
  extrasTitle?: string;
  autoFocus?: boolean;
}) {
  const et = useEt();
  const [q, setQ] = useState("");
  const { hits, loading } = useSearch(ws, q, kinds);
  // The highlighted row belongs to a query: typing starts again from the top.
  const [sel, setSel] = useState<{ q: string; i: number }>({ q: "", i: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const skip = new Set(exclude ?? []);
    return hits.filter((h) => !skip.has(h.key));
  }, [hits, exclude]);
  const groups = useMemo(() => ORDER.map((k) => ({ kind: k, items: shown.filter((h) => h.kind === k) })).filter((g) => g.items.length), [shown]);
  const extrasShown = useMemo(() => (q ? extras.filter((x) => x.label.toLowerCase().includes(q.trim().toLowerCase())) : extras), [extras, q]);
  // One flat order for the keyboard: results first, then actions.
  const flat = useMemo(() => [...groups.flatMap((g) => g.items.map((c) => ({ type: "card" as const, card: c }))), ...extrasShown.map((x) => ({ type: "extra" as const, x }))], [groups, extrasShown]);
  const active = sel.q === q ? Math.min(sel.i, Math.max(0, flat.length - 1)) : 0;
  const setActive = (fn: number | ((a: number) => number)) => setSel({ q, i: typeof fn === "function" ? fn(active) : fn });
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const choose = (i: number) => {
    const it = flat[i];
    if (!it) return;
    if (it.type === "card") onPick(it.card);
    else it.x.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
    }
  };
  let i = -1;
  return (
    <div className="eco-search" onKeyDown={onKey}>
      <label className="eco-search-input">
        <Search size={16} aria-hidden />
        <input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? et("searchPlaceholder")} aria-label={placeholder ?? et("searchPlaceholder")} spellCheck={false} />
      </label>
      <div className="eco-search-list" ref={listRef} role="listbox">
        {!q && groups.length > 0 && <div className="eco-search-head">{et("recent")}</div>}
        {groups.map((g) => (
          <div key={g.kind} role="group" aria-label={et(GROUP[g.kind])}>
            {q && <div className="eco-search-head">{et(GROUP[g.kind])}</div>}
            {g.items.map((c) => {
              const idx = ++i;
              return (
                <div key={c.key} role="option" aria-selected={idx === active} data-active={idx === active || undefined} onMouseMove={() => setActive(idx)}>
                  <CardView card={c} onPick={onPick} active={idx === active} />
                  {c.snippet && q && <div className="eco-snippet">{c.snippet}</div>}
                </div>
              );
            })}
          </div>
        ))}
        {!loading && q && groups.length === 0 && <div className="eco-search-empty">{et("searchEmpty")}</div>}
        {loading && groups.length === 0 && <div className="eco-search-empty">{et("loading")}</div>}
        {extrasShown.length > 0 && (
          <div role="group">
            <div className="eco-search-head">{extrasTitle ?? et("actions")}</div>
            {extrasShown.map((x) => {
              const idx = ++i;
              return (
                <button key={x.key} type="button" role="option" aria-selected={idx === active} className="eco-card eco-row eco-extra" data-active={idx === active || undefined} onMouseMove={() => setActive(idx)} onClick={() => x.run()}>
                  <span className="eco-kind">{x.icon}</span>
                  <span className="eco-text">
                    <span className="eco-title">{x.label}</span>
                  </span>
                  {x.hint && <kbd className="eco-kbd">{x.hint}</kbd>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
