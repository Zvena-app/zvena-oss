"use client";

// The sidebar, as Notion's: the workspace switcher (its menu holds the
// account, the workspaces, Settings and Import) with "close sidebar" and
// "new page"; Search / Home / Inbox; Favorites and Pages (the page tree with
// drag and drop); zvena's other products where Notion lists its apps; then
// Settings, Templates, Trash and Help. Resizable; closed, it hides and peeks
// out from the left edge on hover; a drawer on phones.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  CircleHelp,
  Inbox,
  SquarePen,
  Copy,
  Download,
  FileText,
  Home,
  LayoutTemplate,
  Link,
  LogOut,
  UserCog,
  Users,
  MoreHorizontal,
  PenLine,
  Plus,
  Search,
  Settings,
  Star,
  StarOff,
  Trash2,
  ArrowUpRight,
  CornerUpRight,
  Cloud,
  HardDrive,
  LogIn,
  PenTool,
  ListTodo,
} from "lucide-react";
import { PRODUCTS, productHref, type ProductId } from "@/lib/products";
import { useNotes, type NotesTeamspace } from "./context";
import { BrandMark, Menu, Popover, Tip, cx } from "./ui";
import { BrowseTeamspaces, TeamspaceDialog } from "./TeamspaceDialog";
import { useInbox } from "./inbox-hook";
import { displayTitle, lostRoots, noteSlug, subtreeIds, treeChildren } from "@/lib/notes/model";
import { sectionOf } from "@/lib/notes/access-client";
import { initials } from "@/lib/notes/people";
import { withWs } from "@/lib/notes/workspace";
import type { Note } from "@/lib/notes/types";
import type { SyncState } from "@/lib/notes/sync";
import { NoteIcon } from "./NoteIcon";

function TableGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3 8h14M8 8v8" />
    </svg>
  );
}

function NoteGlyph({ note }: { note: Note }) {
  if (note.icon) return <span className="nt-emoji-in-row"><NoteIcon icon={note.icon} /></span>;
  return note.kind === "database" ? <TableGlyph /> : <FileText strokeWidth={1.6} />;
}

type DropPos = "before" | "after" | "into";

// zvena's other sections (Documents itself is this app; its Home and
// Templates are the Documents ones above).
const APPS: readonly ProductId[] = PRODUCTS.filter((id) => id === "projects" || id === "design" || id === "team");
const APP_ICON: Partial<Record<ProductId, ReactNode>> = { projects: <ListTodo />, design: <PenTool />, team: <Users /> };
const APP_LABEL = { projects: "side.projects", design: "side.board", team: "side.team" } as const;

function NavItem({ icon, label, onClick, onOpen, active, children }: { icon: ReactNode; label: string; onClick: () => void; onOpen?: (el: HTMLElement) => void; active?: boolean; children?: ReactNode }) {
  const run = (el: HTMLElement) => (onOpen ? onOpen(el) : onClick());
  return (
    <div className="nt-item" role="button" tabIndex={0} data-active={active || undefined} onClick={(e) => run(e.currentTarget)} onKeyDown={(e) => e.key === "Enter" && run(e.currentTarget)}>
      <span className="nt-item-icon">{icon}</span>
      <span className="nt-item-label">{label}</span>
      {children}
    </div>
  );
}

function PageMenu({ note, anchor, onClose, onRename }: { note: Note; anchor: HTMLElement; onClose: () => void; onRename: () => void }) {
  const api = useNotes();
  const { t, store } = api;
  // Without edit access to the page: only copy and open links.
  const ro = !api.canEdit(note.id);
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <Menu
        width={260}
        groups={[
          {
            key: "a",
            items: ro ? [] : [
              {
                key: "fav",
                label: note.favorite ? t("menu.removeFromFavorites") : t("menu.addToFavorites"),
                icon: note.favorite ? <StarOff /> : <Star />,
                onSelect: () => (store.update(note.id, { favorite: !note.favorite }, { quiet: true }), onClose()),
              },
            ],
          },
          {
            key: "b",
            items: [
              { key: "link", label: t("menu.copyLink"), icon: <Link />, onSelect: () => (api.copyLink(note.id), onClose()) },
              ...(ro ? [] : [
                { key: "dup", label: t("menu.duplicate"), icon: <Copy />, onSelect: () => (api.duplicate(note.id), onClose()) },
                { key: "rename", label: t("menu.rename"), icon: <PenLine />, onSelect: () => (onRename(), onClose()) },
                { key: "move", label: t("menu.moveTo"), icon: <CornerUpRight />, onSelect: (el: HTMLElement) => api.openMove(note.id, el) },
                { key: "del", label: t("menu.delete"), icon: <Trash2 />, danger: true, onSelect: () => (api.trash(note.id), onClose()) },
              ]),
            ],
          },
          {
            key: "c",
            items: [{ key: "tab", label: t("menu.openNewTab"), icon: <ArrowUpRight />, onSelect: () => (window.open(`${withWs("/docs")}#${noteSlug(note)}`, "_blank", "noopener"), onClose()) }],
          },
        ]}
      />
    </Popover>
  );
}

function RenameBox({ note, anchor, onClose }: { note: Note; anchor: HTMLElement; onClose: () => void }) {
  const { store, t } = useNotes();
  const [v, setV] = useState(note.title);
  const done = () => {
    if (v !== note.title) store.update(note.id, { title: v });
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={done}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: 6, width: 320 }}>
        <span style={{ width: 28, height: 28, display: "grid", placeItems: "center", borderRadius: 6, boxShadow: "inset 0 0 0 1px var(--nt-border-2)" }}><NoteIcon icon={note.icon} fallback={<FileText size={16} />} /></span>
        <input className="nt-input" autoFocus value={v} placeholder={t("page.untitled")} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && done()} />
      </div>
    </Popover>
  );
}

function TreeRow({
  note,
  depth,
  drag,
  setDrag,
  noDrag,
  trail,
}: {
  note: Note;
  depth: number;
  /** Favorites: the same row without drag and drop. */
  noDrag?: boolean;
  /** Rows above this one: a page moved into its own sub-page on another device is not shown again inside itself. */
  trail?: ReadonlySet<string>;
  drag: { id: string; over?: string; pos?: DropPos } | null;
  setDrag: (d: { id: string; over?: string; pos?: DropPos } | null) => void;
}) {
  const api = useNotes();
  const { t, store, snap } = api;
  const open = store.meta.expanded.includes(note.id);
  const path = useMemo(() => new Set([...(trail ?? []), note.id]), [trail, note.id]);
  const kids = useMemo(() => treeChildren(note.id, snap.list, snap.byId).filter((k) => !path.has(k.id)), [note.id, snap.list, snap.byId, path]);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [rename, setRename] = useState<HTMLElement | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const active = api.currentId === note.id;
  const isDb = note.kind === "database";
  const dropClass = drag?.over === note.id && drag.id !== note.id ? (drag.pos === "into" ? "nt-row-drop-into" : drag.pos === "before" ? "nt-row-drop-before" : "nt-row-drop-after") : "";
  return (
    <>
      <div
        ref={rowRef}
        className={cx("nt-item nt-tree-row", dropClass, drag?.id === note.id && "nt-row-dragging")}
        style={{ paddingInlineStart: depth * 12 }}
        data-active={active || undefined}
        data-menu={menu ? "true" : undefined}
        role="treeitem"
        aria-expanded={isDb ? undefined : open}
        aria-selected={active}
        tabIndex={0}
        draggable={!noDrag && api.canEdit(note.id)}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          // Not text/plain: dropped on a page by mistake, the id would land in its text.
          e.dataTransfer.setData("application/x-zvena-note", note.id);
          setDrag({ id: note.id });
        }}
        onDragOver={(e) => {
          if (!drag || drag.id === note.id) return;
          if (subtreeIds(drag.id, snap.list).includes(note.id)) return;
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = e.clientY - r.top;
          const pos: DropPos = isDb ? (y < r.height / 2 ? "before" : "after") : y < r.height * 0.28 ? "before" : y > r.height * 0.72 ? "after" : "into";
          if (drag.over !== note.id || drag.pos !== pos) setDrag({ ...drag, over: note.id, pos });
        }}
        onDragLeave={(e) => {
          if (drag?.over === note.id && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrag({ id: drag.id });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (!drag || drag.id === note.id) return setDrag(null);
          if (drag.pos === "into") {
            api.relocate(drag.id, note.id);
            store.setExpanded(note.id, true);
          } else {
            const siblings = treeChildren(note.parentId, snap.list, snap.byId).filter((s) => s.id !== drag.id);
            const i = siblings.findIndex((s) => s.id === note.id);
            const before = drag.pos === "before" ? note.id : siblings[i + 1]?.id;
            // Next to a top-level page: into that page's section (Private, a teamspace…).
            api.relocate(drag.id, note.parentId, before ?? null, note.parentId === null ? (note.space ?? "") : undefined);
          }
          setDrag(null);
        }}
        onDragEnd={() => setDrag(null)}
        onClick={() => api.open(note.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") api.open(note.id);
          if (e.key === "ArrowRight" && !isDb) store.setExpanded(note.id, true);
          if (e.key === "ArrowLeft") store.setExpanded(note.id, false);
        }}
      >
        {/* Touch screens have no hover: the expand arrow sits before the icon. */}
        {!isDb && (
          <span
            className="nt-chev-touch"
            data-open={open || undefined}
            role="button"
            aria-label={open ? t("side.collapseRow") : t("side.expandRow")}
            onClick={(e) => {
              e.stopPropagation();
              store.setExpanded(note.id, !open);
            }}
          >
            <ChevronRight />
          </span>
        )}
        <span className="nt-item-icon">
          <NoteGlyph note={note} />
          {!isDb && (
            <span
              className="nt-chev"
              data-open={open || undefined}
              role="button"
              aria-label={open ? t("side.collapseRow") : t("side.expandRow")}
              onClick={(e) => {
                e.stopPropagation();
                store.setExpanded(note.id, !open);
              }}
            >
              <ChevronRight />
            </span>
          )}
        </span>
        <span className="nt-item-label">{displayTitle(note, isDb ? t("db.untitled") : t("page.untitled"))}</span>
        <span className="nt-item-actions">
          <Tip label={t("side.more")}>
            <button
              type="button"
              className="nt-item-act nt-btn-reset"
              aria-label={t("side.more")}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(e.currentTarget);
              }}
            >
              <MoreHorizontal />
            </button>
          </Tip>
          {!isDb && api.canEdit(note.id) && (
            <Tip label={t("side.addInside")}>
              <button
                type="button"
                className="nt-item-act nt-btn-reset"
                aria-label={t("side.addInside")}
                onClick={(e) => {
                  e.stopPropagation();
                  store.setExpanded(note.id, true);
                  api.newPage(note.id);
                }}
              >
                <Plus />
              </button>
            </Tip>
          )}
        </span>
      </div>
      {open && !isDb && (
        <div role="group">
          {kids.length === 0 ? (
            <div className="nt-tree-empty" style={{ paddingInlineStart: depth * 12 + 32 }}>
              {t("side.noPages")}
            </div>
          ) : (
            kids.map((k) => <TreeRow key={k.id} note={k} depth={depth + 1} drag={drag} setDrag={setDrag} trail={path} />)
          )}
        </div>
      )}
      {menu && <PageMenu note={note} anchor={menu} onClose={() => setMenu(null)} onRename={() => setRename(rowRef.current)} />}
      {rename && <RenameBox note={note} anchor={rename} onClose={() => setRename(null)} />}
    </>
  );
}

type DragState = { id: string; over?: string; pos?: DropPos } | null;

/** A sidebar section (Shared, Private, the workspace's pages): its top-level pages; a page dropped on it moves there (`space`). */
function Section({ title, pages, space, onAdd, addRow, drag, setDrag }: { title: string; pages: Note[]; space?: string; onAdd?: () => void; addRow?: boolean; drag: DragState; setDrag: (d: DragState) => void }) {
  const api = useNotes();
  const { t } = api;
  const [open, setOpen] = useState(true);
  return (
    <div className="nt-section">
      <div className="nt-section-head" onClick={() => setOpen((v) => !v)}>
        <span className="nt-section-title">{title}</span>
        <span className="nt-section-acts">
          {onAdd && (
            <button
              type="button"
              className="nt-item-act nt-btn-reset"
              aria-label={t("side.addPage")}
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
            >
              <Plus />
            </button>
          )}
        </span>
      </div>
      {open && (
        <div
          role="tree"
          onDragOver={(e) => {
            if (drag && !drag.over && space !== undefined) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!drag || drag.over || space === undefined) return;
            e.preventDefault();
            api.relocate(drag.id, null, null, space);
            setDrag(null);
          }}
        >
          {pages.map((n) => (
            <TreeRow key={n.id} note={n} depth={0} drag={drag} setDrag={setDrag} />
          ))}
        </div>
      )}
      {open && addRow && onAdd && (
        <div className="nt-item nt-item-add" role="button" tabIndex={0} onClick={onAdd} onKeyDown={(e) => e.key === "Enter" && onAdd()}>
          <span className="nt-item-icon">
            <Plus />
          </span>
          <span className="nt-item-label">{t("side.addPage")}</span>
        </div>
      )}
    </div>
  );
}

/** A teamspace in the sidebar: its name (settings, add a page) and, opened, its top-level pages. */
function TeamspaceItem({ ts, pages, drag, setDrag, onSettings, onAdd }: { ts: NotesTeamspace; pages: Note[]; drag: DragState; setDrag: (d: DragState) => void; onSettings: () => void; onAdd: () => void }) {
  const api = useNotes();
  const { t, store } = api;
  const key = `ts:${ts.id}`;
  const open = !store.meta.expanded.includes(`${key}:closed`);
  return (
    <>
      <div
        className="nt-item nt-tree-row"
        role="treeitem"
        aria-expanded={open}
        aria-selected={false}
        tabIndex={0}
        onClick={() => store.setExpanded(`${key}:closed`, open)}
        onDragOver={(e) => drag && e.preventDefault()}
        onDrop={(e) => {
          if (!drag) return;
          e.preventDefault();
          api.relocate(drag.id, null, null, key);
          setDrag(null);
        }}
      >
        <span className="nt-item-icon">
          <span className="nt-cm-avatar">{ts.icon || initials(ts.name)}</span>
        </span>
        <span className="nt-item-label">{ts.name}</span>
        <span className="nt-item-actions">
          <Tip label={t("ts.settings")}>
            <button
              type="button"
              className="nt-item-act nt-btn-reset"
              aria-label={t("ts.settings")}
              onClick={(e) => {
                e.stopPropagation();
                onSettings();
              }}
            >
              <MoreHorizontal />
            </button>
          </Tip>
          {ts.role && !api.readOnly && (
            <Tip label={t("side.addPage")}>
              <button
                type="button"
                className="nt-item-act nt-btn-reset"
                aria-label={t("side.addPage")}
                onClick={(e) => {
                  e.stopPropagation();
                  onAdd();
                }}
              >
                <Plus />
              </button>
            </Tip>
          )}
        </span>
      </div>
      {open && pages.map((n) => <TreeRow key={n.id} note={n} depth={1} drag={drag} setDrag={setDrag} />)}
    </>
  );
}

export function Sidebar({
  width,
  onWidth,
  collapsed,
  onCollapse,
  mobileOpen,
  onMobileClose,
  peek = false,
  onPeekEnd,
  view,
  sync,
  rail = false,
}: {
  /** Inside zvena's shared rail: the Documents block only (no frame of its own). */
  rail?: boolean;
  width: number;
  onWidth: (w: number) => void;
  collapsed: boolean;
  onCollapse: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  /** Closed on a wide screen and hovered at the left edge: the sidebar floats over the page (Notion's peek). */
  peek?: boolean;
  onPeekEnd?: () => void;
  view: "home" | "page";
  sync: SyncState;
}) {
  const api = useNotes();
  const { t, snap, store, user } = api;
  const inbox = useInbox();
  const [drag, setDrag] = useState<{ id: string; over?: string; pos?: DropPos } | null>(null);
  const [wsMenu, setWsMenu] = useState<HTMLElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const [favOpen, setFavOpen] = useState(true);
  const [tsOpen, setTsOpen] = useState(true);
  const [tsDialog, setTsDialog] = useState<NotesTeamspace | "new" | null>(null);
  const [browse, setBrowse] = useState<HTMLElement | null>(null);
  const { teamspaces } = api;
  // An archived teamspace leaves the sidebar (Browse lists it).
  const myTeamspaces = useMemo(() => teamspaces.filter((x) => x.role && !x.archived), [teamspaces]);
  const canCreateTs = Boolean(user && (user.ws.role === "owner" || user.ws.role === "editor"));
  // Pages cut off from the tree by concurrent edits on two devices show at the top level too
  // (and pages shared on their own, whose parent this person cannot open).
  const [appsOpen, setAppsOpen] = useState(true);
  const roots = useMemo(() => [...treeChildren(null, snap.list, snap.byId), ...lostRoots(snap.list, snap.byId)], [snap.list, snap.byId]);
  const bySection = useMemo(() => {
    const out = { private: [] as Note[], shared: [] as Note[], workspace: [] as Note[], teamspace: new Map<string, Note[]>() };
    for (const n of roots) {
      const s = sectionOf(n, snap.byId, user ? { id: user.id } : null);
      if (!s) continue;
      if (s.kind === "teamspace") {
        // A teamspace the person is not in (or that is gone) is reached through Browse; its pages wait there.
        if (!teamspaces.some((x) => x.id === s.id && x.role)) {
          if (!teamspaces.some((x) => x.id === s.id)) out.workspace.push(n);
          continue;
        }
        out.teamspace.set(s.id, [...(out.teamspace.get(s.id) ?? []), n]);
      } else if (s.kind === "workspace" && user?.ws.personal) out.private.push(n);
      else out[s.kind].push(n);
    }
    return out;
  }, [roots, snap.byId, teamspaces, user]);
  const favorites = useMemo(() => snap.list.filter((n) => n.favorite && n.trashedAt === null && !store.isTrashed(n.id)).sort((a, b) => a.title.localeCompare(b.title)), [snap.list, store]);
  const trashCount = useMemo(() => snap.list.filter((n) => n.trashedAt !== null).length, [snap.list]);
  const wsName = user ? user.ws.name : t("app.workspaceGuest");
  const wsId = user?.ws.id ?? null;
  const initial = (user?.ws.name || user?.name || "Z").trim().charAt(0).toUpperCase();

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      setResizing(true);
      const move = (ev: PointerEvent) => onWidth(Math.max(200, Math.min(480, startW + ev.clientX - startX)));
      const up = () => {
        setResizing(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [onWidth, width]
  );

  const go = (fn: () => void) => () => {
    fn();
    onMobileClose();
  };

  // Notion: closed, the sidebar is gone (a phone's drawer is always full);
  // hovered at the left edge, it floats over the page until the pointer leaves.
  const floating = collapsed && peek && !mobileOpen;
  const hidden = collapsed && !floating && !mobileOpen;

  // Notion's sections: Favorites, Teamspaces, Shared, the workspace's pages, Private.
  const sections = (
    <>
    {favorites.length > 0 && (
      <div className="nt-section">
        <div className="nt-section-head" onClick={() => setFavOpen((v) => !v)}>
          <span className="nt-section-title">{t("side.favorites")}</span>
        </div>
        {favOpen && favorites.map((n) => <TreeRow key={`f-${n.id}`} note={n} depth={0} drag={null} setDrag={() => undefined} noDrag />)}
      </div>
    )}
    {/* Notion's sections: Teamspaces, Shared (pages shared with me on their own), Private. */}
    {user && !user.ws.personal && user.ws.role !== "guest" && (teamspaces.length > 0 || canCreateTs) && (
      <div className="nt-section">
        <div className="nt-section-head" onClick={() => setTsOpen((v) => !v)}>
          <span className="nt-section-title">{t("side.teamspaces")}</span>
        </div>
        {tsOpen &&
          myTeamspaces.map((ts) => (
            <TeamspaceItem key={ts.id} ts={ts} pages={bySection.teamspace.get(ts.id) ?? []} drag={drag} setDrag={setDrag} onSettings={() => setTsDialog(ts)} onAdd={() => (api.newPage(null, { space: `ts:${ts.id}` }), onMobileClose())} />
          ))}
        {tsOpen && teamspaces.some((x) => !x.role || x.archived) && (
          <div className="nt-item nt-item-add" role="button" tabIndex={0} onClick={(e) => setBrowse(e.currentTarget)} onKeyDown={(e) => e.key === "Enter" && setBrowse(e.currentTarget)}>
            <span className="nt-item-icon">
              <Users />
            </span>
            <span className="nt-item-label">{t("ts.browse")}</span>
          </div>
        )}
        {tsOpen && canCreateTs && (
          <div className="nt-item nt-item-add" role="button" tabIndex={0} onClick={() => setTsDialog("new")} onKeyDown={(e) => e.key === "Enter" && setTsDialog("new")}>
            <span className="nt-item-icon">
              <Plus />
            </span>
            <span className="nt-item-label">{t("ts.new")}</span>
          </div>
        )}
      </div>
    )}
    {bySection.shared.length > 0 && <Section title={t("side.shared")} pages={bySection.shared} drag={drag} setDrag={setDrag} />}
    {/* The workspace's shared pages from before teamspaces (a personal workspace shows them as Private). */}
    {bySection.workspace.length > 0 && (
      <Section title={t("side.workspaceSection")} pages={bySection.workspace} space="" drag={drag} setDrag={setDrag} onAdd={!api.readOnly ? () => (api.newPage(null, { space: "" }), onMobileClose()) : undefined} />
    )}
    {user?.ws.role !== "guest" && (
      <Section
        title={t("side.privateSection")}
        pages={bySection.private}
        space="private"
        drag={drag}
        setDrag={setDrag}
        onAdd={!api.readOnly ? () => (api.newPage(null, { space: "private" }), onMobileClose()) : undefined}
        addRow
      />
    )}
    </>
  );
  const dialogs = (
    <>
      {tsDialog && <TeamspaceDialog ts={tsDialog === "new" ? undefined : tsDialog} onClose={() => setTsDialog(null)} />}
      {browse && <BrowseTeamspaces anchor={browse} onClose={() => setBrowse(null)} onSettings={(ts) => (setBrowse(null), setTsDialog(ts))} />}
    </>
  );

  // Inside zvena's shared rail (components/zvena/ds/Shell.tsx): only Documents' own block —
  // the rail already has the workspace, + Create, Search, Home, Inbox, Templates and Settings.
  if (rail) {
    return (
      <div className="nt-rail">
        {sections}
        <div className="nt-section nt-side-tools">
          {!api.readOnly && <NavItem icon={<Download />} label={t("side.import")} onClick={go(api.openImport)} />}
          <NavItem icon={<Trash2 />} label={t("side.trash")} onClick={() => {}} onOpen={(el) => api.openTrash(el)}>
            {trashCount > 0 ? <span className="nt-item-kbd">{trashCount}</span> : null}
          </NavItem>
          <NavItem icon={<Settings />} label={t("side.docSettings")} onClick={go(api.openSettings)} />
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <>
      {mobileOpen && <div className="nt-drawer-scrim" onClick={onMobileClose} />}
      <aside
        className={cx("nt-side", floating && "nt-side-float")}
        style={hidden ? undefined : { width }}
        data-collapsed={hidden || undefined}
        data-mobile-open={mobileOpen || undefined}
        aria-label={t("app.name")}
        onMouseLeave={floating && !wsMenu ? onPeekEnd : undefined}
      >
        <div className="nt-side-inner">
          <div className="nt-ws">
            <button type="button" className="nt-ws-btn nt-btn-reset" aria-haspopup="menu" onClick={(e) => setWsMenu(e.currentTarget)}>
              <span className="nt-ws-avatar">{user ? initial : <BrandMark />}</span>
              <span className="nt-ws-name">{wsName}</span>
              <ChevronDown className="nt-ws-chev" size={14} />
            </button>
            {!floating && (
              <Tip label={t("side.collapse")} sub="Ctrl+\">
                <button type="button" className="nt-icon-btn nt-side-hide nt-btn-reset" aria-label={t("side.collapse")} onClick={mobileOpen ? onMobileClose : onCollapse}>
                  <ChevronsLeft />
                </button>
              </Tip>
            )}
            {!api.readOnly && (
              <Tip label={t("side.newPage")} sub="Ctrl+Alt+N">
                <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("side.newPage")} onClick={go(() => api.newPage(null))}>
                  <SquarePen />
                </button>
              </Tip>
            )}
          </div>
          <nav className="nt-side-nav">
            <NavItem icon={<Search />} label={t("side.search")} onClick={go(api.openSearch)} />
            <NavItem icon={<Home />} label={t("side.home")} onClick={go(api.goHome)} active={view === "home"} />
            {inbox && (
              <NavItem icon={<Inbox />} label={t("side.inbox")} onClick={() => {}} onOpen={(el) => (inbox.open(el), onMobileClose())}>
                {inbox.unread ? <span className="nt-item-badge">{inbox.unread > 99 ? "99+" : inbox.unread}</span> : null}
              </NavItem>
            )}
          </nav>
          <div className="nt-side-scroll">
            {sections}
            {/* zvena's other products, where Notion lists its apps. Full loads on
                purpose: Design is another site, Team a separate page; both keep the open workspace. */}
            {user && (
              <div className="nt-section">
                <div className="nt-section-head" onClick={() => setAppsOpen((v) => !v)}>
                  <span className="nt-section-title">{t("side.apps")}</span>
                </div>
                {appsOpen && APPS.map((id) => <NavItem key={id} icon={APP_ICON[id]} label={t(APP_LABEL[id as keyof typeof APP_LABEL])} onClick={() => (location.href = productHref(id, wsId))} />)}
              </div>
            )}
            <div className="nt-section nt-side-tools">
              <NavItem icon={<Settings />} label={t("side.settings")} onClick={go(api.openSettings)} />
              <NavItem icon={<LayoutTemplate />} label={t("side.templates")} onClick={go(api.openTemplates)} />
              <NavItem icon={<Trash2 />} label={t("side.trash")} onClick={() => {}} onOpen={(el) => api.openTrash(el)}>
                {trashCount > 0 ? <span className="nt-item-kbd">{trashCount}</span> : null}
              </NavItem>
              <NavItem icon={<CircleHelp />} label={t("side.help")} onClick={() => window.open("/help", "_blank", "noopener")} />
            </div>
          </div>
        </div>
        {!hidden && !floating && <div className="nt-side-resize" data-active={resizing || undefined} onPointerDown={startResize} onDoubleClick={() => onWidth(240)} />}
        {dialogs}
        {wsMenu && (
          <Popover anchor={wsMenu} onClose={() => setWsMenu(null)} placement="bottom-start">
            <Menu
              width={300}
              header={
                <div className="nt-ws-menu-head">
                  <span className="nt-ws-avatar nt-ws-avatar-lg">{user ? initial : <BrandMark />}</span>
                  <div className="nt-ws-menu-text">
                    <div className="nt-ws-menu-name">{wsName}</div>
                    <div className="nt-ws-menu-sub" title={sync.user ? t("side.syncOnFull") : undefined}>
                      {sync.user ? <Cloud size={12} /> : <HardDrive size={12} />}
                      <span>{user ? `${user.name} · ${sync.user ? t("side.syncOn") : t("side.syncOff")}` : t("side.syncOff")}</span>
                    </div>
                  </div>
                </div>
              }
              groups={[
                {
                  key: "a",
                  items: [
                    { key: "settings", label: t("side.settings"), icon: <Settings />, onSelect: () => (setWsMenu(null), api.openSettings()) },
                    ...(user ? [{ key: "team", label: t("side.team"), icon: <Users />, onSelect: () => (location.href = productHref("team", wsId)) }] : []),
                    ...(api.readOnly ? [] : [{ key: "import", label: t("side.import"), icon: <Download />, onSelect: () => (setWsMenu(null), api.openImport()) }]),
                  ],
                },
                ...(user && user.workspaces.length > 0
                  ? [
                      {
                        key: "ws",
                        label: user.email || user.name,
                        items: [
                          ...user.workspaces.map((w) => ({
                            key: `ws-${w.id}`,
                            label: w.name,
                            icon: <span className="nt-ws-avatar nt-ws-avatar-sm">{(w.name || "Z").trim().charAt(0).toUpperCase()}</span>,
                            hint: w.id === user.ws.id ? "✓" : undefined,
                            onSelect: () => {
                              setWsMenu(null);
                              if (w.id !== user.ws.id) location.href = `/docs?ws=${encodeURIComponent(w.id)}`;
                            },
                          })),
                          { key: "ws-new", label: t("side.newWorkspace"), icon: <Plus />, onSelect: () => (location.href = "/team?new=1") },
                        ],
                      },
                    ]
                  : []),
                {
                  key: "b",
                  items: [
                    ...(user ? [{ key: "account", label: t("side.account"), icon: <UserCog />, onSelect: () => (location.href = "/settings") }] : []),
                    ...(user
                      ? [{ key: "signout", label: t("side.signOut"), icon: <LogOut />, onSelect: () => void fetch("/api/auth/logout", { method: "POST" }).finally(() => (location.href = "/")) }]
                      : [{ key: "signin", label: t("side.signIn"), icon: <LogIn />, onSelect: () => (setWsMenu(null), api.signIn()) }]),
                  ],
                },
              ]}
            />
          </Popover>
        )}
      </aside>
    </>
  );
}
