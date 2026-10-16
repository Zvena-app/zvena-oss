"use client";

// "Linked view of database" (Notion): a new linked view block first asks
// which database to show. Once picked, the block shows that database with
// views of its own (see useDatabase's `scope`).

import { useMemo, useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { useNotes } from "../context";
import { NoteIcon } from "../NoteIcon";
import { displayTitle } from "@/lib/notes/model";

function DbGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3 8h14M8 8v8" />
    </svg>
  );
}

export function LinkedPicker({ onPick }: { onPick: (dbId: string) => void }) {
  const { snap, store, t } = useNotes();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const untitled = t("db.untitled");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return snap.list
      .filter((n) => n.kind === "database" && !n.template && !store.isTrashed(n.id))
      .filter((n) => !needle || displayTitle(n, untitled).toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
  }, [snap.list, store, q, untitled]);
  const at = Math.min(active, Math.max(0, list.length - 1));

  return (
    <div className="nt-linked-pick">
      <div className="nt-linked-head">
        <ArrowUpRight />
        {t("db.linkedPick")}
      </div>
      <label className="nt-linked-search">
        <Search />
        <input
          autoFocus
          value={q}
          placeholder={t("db.linkedSearch")}
          aria-label={t("db.linkedSearch")}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(Math.min(at + 1, list.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(Math.max(at - 1, 0));
            } else if (e.key === "Enter" && list[at]) {
              e.preventDefault();
              onPick(list[at].id);
            } else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <div className="nt-linked-list" role="listbox" aria-label={t("db.linkedPick")}>
        {list.map((n, i) => {
          const parent = n.parentId ? snap.byId.get(n.parentId) : undefined;
          return (
            <button
              key={n.id}
              type="button"
              role="option"
              aria-selected={i === at}
              className="nt-linked-row nt-btn-reset"
              data-active={i === at || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(n.id)}
            >
              <span className="nt-linked-icon">
                <NoteIcon icon={n.icon} fallback={<DbGlyph />} />
              </span>
              <span className="nt-linked-title">{displayTitle(n, untitled)}</span>
              {parent && <span className="nt-linked-path">{displayTitle(parent, t("page.untitled"))}</span>}
            </button>
          );
        })}
        {!list.length && <div className="nt-linked-empty">{t(q.trim() ? "slash.noResults" : "db.linkedNone")}</div>}
      </div>
    </div>
  );
}
