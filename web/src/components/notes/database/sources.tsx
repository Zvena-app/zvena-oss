"use client";

// Data sources of a database (Notion, 2025): the "Data sources" panel —
// add a new one or link one from another database, rename, change the
// icon, share, move to another database, turn into a database of its own,
// delete or unlink — and the pickers it shares with relations and views.
// The model and its pure edits are in lib/notes/sources.ts; the server
// checks every write as usual (a data source is a note of its own).

import { useMemo, useState } from "react";
import { ArrowUpRight, Check, CornerUpRight, Database, Link2, MoreHorizontal, Pencil, Plus, Search, Share2, SmilePlus, SquareArrowOutUpRight, Trash2, Unlink } from "lucide-react";
import type { DbCtl } from "./useDatabase";
import { Menu, Popover, toast } from "../ui";
import { NoteIcon } from "../NoteIcon";
import { EmojiPicker } from "../EmojiPicker";
import { ShareAccess } from "../ShareAccess";
import { useNotes } from "../context";
import { displayTitle, isSourceNote } from "@/lib/notes/model";
import { childSources, hostOf, keepATab, moveSourcePlan, newSourceSchema, sourceName, sourceView, splitSourcePlan, viewSourceId, viewsWithout, type SourceInfo } from "@/lib/notes/sources";
import type { Note } from "@/lib/notes/types";

/** A data source's icon (its own, else a table glyph). */
export function SourceIcon({ icon, size = 16 }: { icon: string; size?: number }) {
  return <NoteIcon icon={icon} fallback={<Database style={{ width: size, height: size }} />} />;
}

export interface PickedSource {
  /** The data source (a database's own id for its first one). */
  id: string;
  /** Its database. */
  hostId: string;
}

/**
 * Databases and their data sources, grouped as Notion lists them ("Link
 * existing data source", relations, "Move to"). `databases`: pick a
 * database instead of a data source.
 */
export function SourcePicker({
  anchor,
  onClose,
  onPick,
  title,
  databases,
  exclude,
  selected,
  placement = "bottom-start",
}: {
  anchor: HTMLElement;
  onClose: () => void;
  onPick: (s: PickedSource) => void;
  title: string;
  databases?: boolean;
  exclude?: (s: PickedSource) => boolean;
  selected?: string;
  placement?: "bottom-start" | "right-start" | "left-start";
}) {
  const { snap, store, t } = useNotes();
  const [q, setQ] = useState("");
  const untitled = t("db.untitled");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out: { host: Note; items: { id: string; name: string; icon: string }[] }[] = [];
    for (const n of snap.list) {
      if (n.kind !== "database" || n.template || !n.db || store.isTrashed(n.id) || (isSourceNote(n) && hostOf(n, snap.byId))) continue;
      const items = databases
        ? [{ id: n.id, name: displayTitle(n, untitled), icon: n.icon }]
        : [{ id: n.id, name: sourceName(n, n, untitled), icon: n.db.label?.icon ?? n.icon }, ...childSources(n.id, snap.list).map((s) => ({ id: s.id, name: sourceName(n, s, untitled), icon: s.icon }))];
      const shown = items.filter((x) => !exclude?.({ id: x.id, hostId: n.id }) && (!needle || x.name.toLowerCase().includes(needle) || displayTitle(n, untitled).toLowerCase().includes(needle)));
      if (shown.length) out.push({ host: n, items: shown });
    }
    return out.sort((a, b) => b.host.updatedAt - a.host.updatedAt).slice(0, 60);
  }, [snap.list, snap.byId, store, q, untitled, databases, exclude]);
  return (
    <Popover anchor={anchor} onClose={onClose} placement={placement}>
      <div className="nt-srcpick">
        <div className="nt-menu-label">{title}</div>
        <label className="nt-srcpick-search">
          <Search />
          <input className="nt-input" autoFocus value={q} placeholder={t("src.search")} aria-label={t("src.search")} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="nt-srcpick-list" role="listbox" aria-label={title}>
          {groups.map((g) => (
            <div key={g.host.id} className="nt-srcpick-group">
              {/* A database with several sources is a heading over them (one source: the database itself is the row). */}
              {!databases && g.items.length > 1 && <div className="nt-srcpick-db">{displayTitle(g.host, untitled)}</div>}
              {g.items.map((x) => (
                <button key={x.id} type="button" role="option" aria-selected={selected === x.id} className="nt-mi nt-btn-reset" data-indent={(!databases && g.items.length > 1) || undefined} onClick={() => onPick({ id: x.id, hostId: g.host.id })}>
                  <span className="nt-mi-icon">
                    <SourceIcon icon={x.icon} />
                  </span>
                  <span className="nt-mi-label">{x.name}</span>
                  {selected === x.id && <Check size={14} />}
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <div className="nt-panel-empty">{t(q.trim() ? "slash.noResults" : "src.none")}</div>}
        </div>
      </div>
    </Popover>
  );
}

/** Adds a new, empty data source to the database and a view tab of it (Notion's "+ Add data source → New"). */
export function addNewSource(ctl: DbCtl): string | null {
  const { store, t } = ctl.api;
  const host = ctl.host && store.get(ctl.host.id);
  if (!host?.db || !ctl.api.canEdit(host.id)) return null;
  const schema = newSourceSchema({ name: t("db.name"), tags: t("db.tags"), table: t("db.table") });
  const last = childSources(host.id, store.all()).at(-1);
  const src = store.create({ kind: "database", parentId: host.id, title: t("src.newName"), db: schema, order: (last?.order ?? Date.now()) + 1024 });
  const v = sourceView("table", t("db.table"), host.id, src.id, schema);
  store.update(host.id, { db: { ...host.db, views: [...host.db.views, v] } });
  ctl.setViewId(v.id);
  return src.id;
}

/** Links a data source of another database in, with a view tab of it ("+ Add data source → Link existing"). */
export function linkSource(ctl: DbCtl, srcId: string): void {
  const { store, t } = ctl.api;
  const host = ctl.host && store.get(ctl.host.id);
  const src = store.get(srcId);
  if (!host?.db || !src?.db || srcId === host.id || !ctl.api.canEdit(host.id)) return;
  const linked = host.db.linked?.includes(srcId) || src.parentId === host.id ? host.db.linked : [...(host.db.linked ?? []), srcId];
  const v = sourceView("table", t("db.table"), host.id, srcId, src.db);
  store.update(host.id, { db: { ...host.db, ...(linked ? { linked } : {}), views: [...host.db.views, v] } });
  ctl.setViewId(v.id);
}

/** The "Data sources" panel of a database. */
export function SourcesPanel({ ctl, anchor, onClose }: { ctl: DbCtl; anchor: HTMLElement; onClose: () => void }) {
  const api = ctl.api;
  const { t, store, snap } = api;
  const host = ctl.host as Note;
  const [menu, setMenu] = useState<{ src: SourceInfo; el: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [pick, setPick] = useState<{ kind: "link" | "move"; src?: SourceInfo; el: HTMLElement } | null>(null);
  const [iconFor, setIconFor] = useState<{ src: SourceInfo; el: HTMLElement } | null>(null);
  const [shareFor, setShareFor] = useState<{ note: Note; el: HTMLElement } | null>(null);
  const canEdit = !ctl.locked && api.canEdit(host.id);
  const children = ctl.sources.filter((s) => s.kind === "child");

  const rename = (src: SourceInfo, name: string) => {
    const cur = store.get(host.id);
    if (!cur?.db) return;
    const clean = name.trim().slice(0, 200);
    if (src.kind === "own") {
      // The first source answers to the database's name unless it was given its own.
      const label = { ...cur.db.label, name: clean && clean !== cur.title ? clean : undefined };
      store.update(host.id, { db: { ...cur.db, label: label.name || label.icon ? label : undefined } });
    } else if (src.kind === "child" && clean) store.update(src.id, { title: clean });
  };
  const setIcon = (src: SourceInfo, icon: string) => {
    const cur = store.get(host.id);
    if (!cur?.db) return;
    if (src.kind === "own") {
      const label = { ...cur.db.label, icon: icon || undefined };
      store.update(host.id, { db: { ...cur.db, label: label.name || label.icon ? label : undefined } });
    } else if (src.kind === "child") store.update(src.id, { icon });
  };
  const remove = (src: SourceInfo) => {
    const cur = store.get(host.id);
    if (!cur?.db) return;
    const views = keepATab({ ...cur.db, views: viewsWithout(cur.db.views, host.id, src.id) }, t("db.table"));
    if (src.kind === "linked") {
      const linked = (cur.db.linked ?? []).filter((x) => x !== src.id);
      store.update(host.id, { db: { ...views, linked: linked.length ? linked : undefined } });
      toast(t("src.unlinked"));
      return;
    }
    store.update(host.id, { db: views });
    api.trash(src.id);
  };
  const split = (src: SourceInfo) => {
    const cur = store.get(host.id);
    const note = store.get(src.id);
    if (!cur || !note) return;
    const plan = splitSourcePlan(cur, note, t("db.table"));
    if (!plan) return;
    // Beside the database: in its page (a link block there) or in its sidebar section.
    api.relocate(note.id, cur.parentId, null, cur.parentId === null ? (cur.space ?? "") : undefined);
    store.update(note.id, { db: plan.src.db });
    store.update(cur.id, { db: plan.from });
    toast(t("src.turned"));
  };
  const move = (src: SourceInfo, toId: string) => {
    const cur = store.get(host.id);
    const note = store.get(src.id);
    const to = store.get(toId);
    if (!cur || !note || !to) return;
    if (!api.canEdit(to.id)) return toast(t("src.cannotMove"));
    const plan = moveSourcePlan(cur, note, to, store.all(), t("db.table"));
    if (!plan.ok) return toast(t(plan.reason === "own" ? "src.ownStays" : "src.cannotMove"));
    if (src.kind === "own") {
      // The whole database becomes a data source of the other one.
      api.relocate(cur.id, to.id);
      store.update(cur.id, { db: plan.src.db });
    } else {
      api.relocate(note.id, to.id);
      if (plan.from) store.update(cur.id, { db: plan.from });
    }
    store.update(to.id, { db: plan.to });
    toast(t("src.moved", { db: displayTitle(to, t("db.untitled")) }));
    onClose();
    if (src.kind === "own") api.open(to.id);
  };

  /** The row's "•••" menu; what it opens stays anchored to that button (the menu closes). */
  const menuItems = (src: SourceInfo, at: HTMLElement) => {
    const items = [];
    if (src.kind !== "linked") {
      items.push({ key: "rename", label: t("src.rename"), icon: <Pencil />, onSelect: () => (setRenaming({ id: src.id, name: src.name }), setMenu(null)) });
      items.push({ key: "icon", label: t("src.icon"), icon: <SmilePlus />, onSelect: () => (setIconFor({ src, el: at }), setMenu(null)) });
    }
    if (src.kind === "child" && src.note && api.user && api.levelOf(src.id) === "full") items.push({ key: "share", label: t("src.share"), icon: <Share2 />, onSelect: () => (setShareFor({ note: src.note as Note, el: at }), setMenu(null)) });
    if (src.kind !== "linked") {
      const ownStuck = src.kind === "own" && children.length > 0;
      items.push({ key: "move", label: t("src.moveTo"), icon: <CornerUpRight />, disabled: ownStuck, hint: ownStuck ? t("src.ownStaysShort") : undefined, onSelect: () => (setPick({ kind: "move", src, el: at }), setMenu(null)) });
    }
    if (src.kind === "child") items.push({ key: "split", label: t("src.turnIntoDb"), icon: <SquareArrowOutUpRight />, onSelect: () => (split(src), setMenu(null)) });
    if (src.kind === "linked" && src.note) items.push({ key: "open", label: t("src.openOriginal"), icon: <ArrowUpRight />, onSelect: () => (api.open(hostOf(src.note, snap.byId)?.id ?? src.id), onClose()) });
    if (src.kind === "child") items.push({ key: "delete", label: t("src.delete"), icon: <Trash2 />, danger: true, onSelect: () => (remove(src), setMenu(null)) });
    if (src.kind === "linked") items.push({ key: "unlink", label: t("src.unlink"), icon: <Unlink />, danger: true, onSelect: () => (remove(src), setMenu(null)) });
    return items;
  };

  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end">
      <div className="nt-srcpanel" data-testid="sources-panel">
        <div className="nt-menu-label">{t("src.title")}</div>
        {ctl.sources.map((src) => (
          <div key={src.id} className="nt-srcpanel-row" data-kind={src.kind}>
            <span className="nt-srcpanel-icon">
              <SourceIcon icon={src.icon} />
            </span>
            {renaming?.id === src.id ? (
              <input
                className="nt-input nt-srcpanel-name"
                autoFocus
                aria-label={t("src.rename")}
                value={renaming.name}
                onChange={(e) => setRenaming({ id: src.id, name: e.target.value })}
                onBlur={() => (rename(src, renaming.name), setRenaming(null))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span className="nt-srcpanel-name">{src.note ? src.name : t("src.noAccess")}</span>
            )}
            {src.kind === "linked" && (
              <span className="nt-srcpanel-tag">
                <Link2 size={12} />
                {t("src.linked")}
              </span>
            )}
            <span className="nt-srcpanel-count">{t("src.views", { n: ctl.views.filter((v) => viewSourceId(host.id, v) === src.id).length })}</span>
            {canEdit && (
              <button type="button" className="nt-item-act nt-btn-reset" aria-label={t("page.more")} onClick={(e) => setMenu({ src, el: e.currentTarget })}>
                <MoreHorizontal size={14} />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <>
            <div className="nt-tplmenu-sep" />
            <button type="button" className="nt-mi nt-btn-reset" onClick={() => (addNewSource(ctl), onClose())}>
              <span className="nt-mi-icon">
                <Plus />
              </span>
              <span className="nt-mi-label">{t("src.addNew")}</span>
            </button>
            <button type="button" className="nt-mi nt-btn-reset" onClick={(e) => setPick({ kind: "link", el: e.currentTarget })}>
              <span className="nt-mi-icon">
                <Link2 />
              </span>
              <span className="nt-mi-label">{t("src.linkExisting")}</span>
            </button>
          </>
        )}
      </div>
      {menu && (
        <Popover anchor={menu.el} placement="right-start" onClose={() => setMenu(null)}>
          <Menu width={240} onClose={() => setMenu(null)} groups={[{ key: "s", items: menuItems(menu.src, menu.el) }]} />
        </Popover>
      )}
      {iconFor && (
        <Popover anchor={iconFor.el} onClose={() => setIconFor(null)}>
          <EmojiPicker onPick={(e) => (setIcon(iconFor.src, e), setIconFor(null))} onRemove={() => (setIcon(iconFor.src, ""), setIconFor(null))} />
        </Popover>
      )}
      {shareFor && (
        <Popover anchor={shareFor.el} placement="right-start" onClose={() => setShareFor(null)}>
          <div className="nt-share">
            <div className="nt-menu-label">{t("src.shareTitle", { name: displayTitle(shareFor.note, t("db.untitled")) })}</div>
            <ShareAccess note={shareFor.note} />
          </div>
        </Popover>
      )}
      {pick?.kind === "link" && (
        <SourcePicker
          anchor={pick.el}
          placement="right-start"
          title={t("src.linkExisting")}
          onClose={() => setPick(null)}
          exclude={(s) => s.hostId === host.id || ctl.sources.some((x) => x.id === s.id)}
          onPick={(s) => {
            linkSource(ctl, s.id);
            setPick(null);
            onClose();
          }}
        />
      )}
      {pick?.kind === "move" && pick.src && (
        <SourcePicker
          anchor={pick.el}
          placement="right-start"
          databases
          title={t("src.moveTo")}
          onClose={() => setPick(null)}
          exclude={(s) => s.hostId === host.id || !api.canEdit(s.hostId)}
          onPick={(s) => {
            move(pick.src as SourceInfo, s.hostId);
            setPick(null);
          }}
        />
      )}
    </Popover>
  );
}
