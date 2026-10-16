"use client";

// Cmd+K (Ctrl+K): one box to find anything in the workspace — documents,
// issues, projects, designs, events — and to go anywhere or create anything. The same
// palette opens on every page of the shell and in Documents; Projects and
// Design list its results inside their own command menus (/api/eco/search).
//
// Mount once per page: <CommandPalette ws={ws} />. Anything can open it with
// openPalette() (a search button, a menu item).

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, CalendarPlus, CircleDot, FilePlus2, FileText, FolderKanban, Home, Inbox, PenTool, Table2, Users } from "lucide-react";
import { CREATE_ITEMS, createHref, itemLabel } from "@/lib/create";
import { ecoText } from "@/lib/eco/strings";
import type { Card } from "@/lib/eco/types";
import { translate, type MessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-react";
import { useModKey } from "./client";
import { useEt } from "./i18n";
import { SearchList, type ExtraItem } from "./SearchList";
import "./eco.css";

const OPEN_EVENT = "zvena:palette";

export function openPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}


export function CommandPalette({ ws, canEdit = true, onOpenCard }: { ws: string; canEdit?: boolean; onOpenCard?: (c: Card) => boolean }) {
  const et = useEt();
  const [open, setOpen] = useState(false);
  const { locale } = useI18n();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        // Text selected in a document: ⌘K adds a link there (Notion); the palette waits.
        if ((e.target as HTMLElement | null)?.closest?.(".bn-editor") && !(window.getSelection()?.isCollapsed ?? true)) return;
        e.preventDefault();
        e.stopPropagation();
        setOpen((v) => !v);
      }
    };
    const show = () => setOpen(true);
    // Capture: the palette answers before an editor or a page's own shortcuts.
    window.addEventListener("keydown", key, true);
    window.addEventListener(OPEN_EVENT, show);
    // The shortcut works from here on (checks wait for it).
    document.documentElement.dataset.ecoPalette = "ready";
    return () => {
      delete document.documentElement.dataset.ecoPalette;
      window.removeEventListener("keydown", key, true);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const go = useCallback((url: string) => {
    setOpen(false);
    location.href = url;
  }, []);
  const q = `ws=${encodeURIComponent(ws)}`;
  const extras: ExtraItem[] = useMemo(() => {
    // The shared list of things to create (lib/create.ts): the same as the sidebar's "Create" and Home.
    const icon = (kind: string) => (kind === "issue" ? <CircleDot size={16} /> : kind === "table" ? <Table2 size={16} /> : kind === "design" ? <PenTool size={16} /> : <FilePlus2 size={16} />);
    const create: ExtraItem[] = canEdit
      ? CREATE_ITEMS.map((it) => ({
          key: `new-${it.id}`,
          label: ecoText(locale, "paletteNew", { item: itemLabel(it, locale) }),
          icon: icon(it.kind),
          run: () => go(createHref(it, ws)),
        }))
      : [];
    // Calendar: a new event opens Calendar with its editor (components/calendar).
    if (canEdit) create.push({ key: "new-event", label: ecoText(locale, "newEvent"), icon: <CalendarPlus size={16} />, run: () => go(`/calendar?${q}&new=1`) });
    const place = (key: MessageKey) => ecoText(locale, "paletteGoto", { place: translate(locale, key) });
    const nav: ExtraItem[] = [
      { key: "go-home", label: place("nav.home"), icon: <Home size={16} />, run: () => go(`/home?${q}`) },
      { key: "go-inbox", label: place("nav.inbox"), icon: <Inbox size={16} />, run: () => go(`/inbox?${q}`) },
      { key: "go-docs", label: place("nav.docs"), icon: <FileText size={16} />, run: () => go(`/docs?${q}`) },
      { key: "go-projects", label: place("nav.projects"), icon: <FolderKanban size={16} />, run: () => go(`/projects?${q}`) },
      { key: "go-calendar", label: place("nav.calendar"), icon: <CalendarDays size={16} />, run: () => go(`/calendar?${q}`) },
      { key: "go-design", label: place("nav.design"), icon: <PenTool size={16} />, run: () => go(`/design?${q}`) },
      { key: "go-team", label: place("nav.team"), icon: <Users size={16} />, run: () => go(`/team?${q}`) },
    ];
    return [...create, ...nav];
  }, [canEdit, go, q, ws, locale]);
  const mod = useModKey();
  if (!open || !ws) return null;
  return createPortal(
    <div className="eco-layer eco-root" role="dialog" aria-modal="true" aria-label={et("searchPlaceholder")}>
      <div className="eco-scrim" onClick={close} />
      <div className="eco-palette">
        <SearchList
          ws={ws}
          extras={extras}
          onClose={close}
          onPick={(c) => {
            if (onOpenCard?.(c)) return close();
            go(c.url);
          }}
        />
        <div className="eco-palette-foot">
          <span>
            <kbd className="eco-kbd">↑</kbd>
            <kbd className="eco-kbd">↓</kbd> {et("kbdNav")}
          </span>
          <span>
            <kbd className="eco-kbd">↵</kbd> {et("kbdOpen")}
          </span>
          <span>
            <kbd className="eco-kbd">Esc</kbd> {et("kbdClose")}
          </span>
          <span style={{ marginInlineStart: "auto" }}>
            <kbd className="eco-kbd">{mod}</kbd>
            <kbd className="eco-kbd">K</kbd>
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
