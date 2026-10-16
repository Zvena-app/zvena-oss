"use client";

// The one frame of every section (design system: Shell), arranged as Linear's:
// a quiet rail on the app's grey — the workspace menu (account, settings,
// switching, language, sign out) with search and compose beside it; Home,
// Inbox, My tasks; foldable groups (Workspace, the section's own block such
// as Docs' page tree or Projects' teams, Try); "?" at the bottom — and the
// work in an inset white panel. The look comes from the shell classes
// app/ui-theme.css styles (.zv-shell, .zv-side, .zv-nav…); ds.css adds the rest.
//
//   <Shell user={user} section="projects" sectionNav={<MyTree/>}>…</Shell>
//
// Cross-section links route on the client (RailLink: next/link, the data of
// the place fetched when the pointer comes near), so moving between sections
// keeps the loaded app — no page load, no second download of the scripts.
// Design (another app on its own host) and the workspace switch (the server
// reads ?ws=) stay plain <a>. A section's own items use ShellNavItem with
// onClick for its own client routing.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  CircleUser,
  FileText,
  Home,
  Import,
  Inbox,
  LayoutTemplate,
  ListTodo,
  LogOut,
  Mail,
  Menu as MenuIcon,
  PenTool,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Activity,
  Scale,
  UserPlus,
  Users,
} from "lucide-react";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { CommandPalette, openPalette } from "@/components/eco/CommandPalette";
import { useUnread } from "@/components/eco/client";
import { CreateButton } from "@/components/zvena/create/CreateButton";
import { useI18n } from "@/lib/i18n-react";
import { productHref } from "@/lib/products";
import { dt } from "./i18n";
import { Kbd } from "./Kbd";
import { LanguagePicker } from "./LanguagePicker";
import { ShareDialog } from "./Share";
import { Toaster } from "./Toaster";
import "./ds.css";

export type ShellSection = "home" | "inbox" | "my" | "docs" | "projects" | "calendar" | "mail" | "design" | "templates" | "team" | "settings" | "admin";

export interface ShellUser {
  id: string;
  name: string;
  isAdmin?: boolean;
  ws: {
    id: string;
    name: string;
    role: "owner" | "editor" | "commenter" | "viewer" | "guest";
  };
  workspaces: readonly { id: string; name: string }[];
}

export interface ShellProps {
  user: ShellUser;
  section: ShellSection;
  /** The section's own block in the rail (its tree, teams, favorites). */
  sectionNav?: ReactNode;
  /** The block's heading; defaults to the section's name. */
  sectionTitle?: string;
  /** A button next to the heading (Docs: new page; Projects: new team). */
  sectionAction?: ReactNode;
  /** Mount the ecosystem's ⌘K palette (off where a section brings its own). */
  palette?: boolean;
  /** "C" opens + Create (off where a section binds "C" itself, as Projects does for a new issue). */
  createHotkey?: boolean;
  /** The search button: the ecosystem's palette, or the section's own search. */
  onSearch?: () => void;
  /** The work area fills the panel and scrolls inside (Docs, Projects); else the panel scrolls. */
  fill?: boolean;
  /** Mount the shared Toaster (off where a section already renders ds toasts elsewhere). */
  toaster?: boolean;
  children: ReactNode;
}

const SECTIONS = [
  { id: "docs", icon: <FileText />, label: "nav.docs" },
  { id: "projects", icon: <ListTodo />, label: "nav.projects" },
  { id: "calendar", icon: <CalendarDays />, label: "nav.calendar" },
  { id: "mail", icon: <Mail />, label: "nav.mail" },
  { id: "design", icon: <PenTool />, label: "nav.design" },
] as const;

// The rail's groups a person folded (Linear: "Workspace ▾", "Your teams ▾", "Try ▾"), per browser.
const FOLDS_KEY = "zv.rail.folds";

function readFolds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// What this tab already knows, kept between client navigations (every page mounts the Shell again):
// the folds and the rail's scroll position are drawn at once, with no flash of open groups or a jump to the top.
let knownFolds: string[] | null = null;
let railScrollTop = 0;

function useFolds() {
  const [folds, setFolds] = useState<string[]>(() => knownFolds ?? []);
  // localStorage exists only in the browser: on a page load it is read after the first paint (the server draws every group open).
  useEffect(() => {
    if (knownFolds !== null) return;
    knownFolds = readFolds();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFolds(knownFolds);
  }, []);
  const toggle = useCallback((id: string) => {
    setFolds((f) => {
      const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
      knownFolds = next;
      try {
        localStorage.setItem(FOLDS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  return { folded: (id: string) => folds.includes(id), toggle };
}

/** The rail's scrolling part; its position is carried over to the next page of a client navigation. */
function RailScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current && railScrollTop) ref.current.scrollTop = railScrollTop;
  }, []);
  return (
    <div className="ds-rail-scroll" ref={ref} onScroll={(e) => (railScrollTop = e.currentTarget.scrollTop)}>
      {children}
    </div>
  );
}

/** A foldable group of the rail: a quiet heading with a caret, as in Linear. */
function RailGroup({ id, title, action, folds, children }: { id: string; title: string; action?: ReactNode; folds: ReturnType<typeof useFolds>; children: ReactNode }) {
  const closed = folds.folded(id);
  return (
    <div className="ds-rail-group" data-closed={closed || undefined}>
      <div className="ds-nav-title">
        <button type="button" className="ds-rail-fold" aria-expanded={!closed} onClick={() => folds.toggle(id)}>
          <span>{title}</span>
          <ChevronDown aria-hidden />
        </button>
        {action}
      </div>
      {!closed && children}
    </div>
  );
}

// What a rail popup's arrow keys move between.
const ITEMS = '[role^="menuitem"], a[href], button, select';

/** Arrow keys, Home/End move between a popup's items; Esc closes it (and Tab, in a menu). */
function menuKeys(e: ReactKeyboardEvent<HTMLElement>, close: () => void, tabCloses: boolean) {
  if ((e.target as Element).tagName === "SELECT" && (e.key === "ArrowDown" || e.key === "ArrowUp")) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const go = (n: number) => {
    e.preventDefault();
    items[(n + items.length) % items.length]?.focus();
  };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
  else if (e.key === "Escape" || (tabCloses && e.key === "Tab")) {
    if (e.key === "Escape") e.preventDefault();
    close();
  }
}

/**
 * A popup anchored in the rail: closes on a click outside, Esc, or after a choice; focus returns to its button.
 * `menu`: only menu items (help). Otherwise a small dialog (the workspace menu, which also holds the language select).
 */
function RailMenu({ className, menuClassName, label, title, button, menu = false, children }: { className: string; menuClassName: string; label: string; title?: string; button: ReactNode; menu?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    btn.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onDown = (e: globalThis.MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <>
      <button ref={btn} type="button" className={className} aria-haspopup={menu ? "menu" : "dialog"} aria-expanded={open} aria-label={title ? undefined : label} title={title ?? label} onClick={() => setOpen((v) => !v)}>
        {button}
      </button>
      {open && (
        <div
          ref={pop}
          className={`ds-menu ${menuClassName}`}
          role={menu ? "menu" : "dialog"}
          aria-label={label}
          onKeyDown={(e) => menuKeys(e, close, menu)}
          onClick={(e) => (e.target as Element).closest("a[href], button") && setOpen(false)}
        >
          {children}
        </div>
      )}
    </>
  );
}

export function Shell({ user, section, sectionNav, sectionTitle, sectionAction, palette = true, createHotkey = true, onSearch, fill = false, toaster = true, children }: ShellProps) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState(false);
  const folds = useFolds();
  const ws = user.ws;
  // ?share=1 (after "Start a team" in Share) opens Share once in the new workspace.
  useEffect(() => {
    const u = new URL(location.href);
    if (u.searchParams.get("share") !== "1") return;
    u.searchParams.delete("share");
    history.replaceState(history.state, "", u.toString());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShare(true);
  }, []);
  // The drawer (≤ 860 px) closes once the person goes somewhere: a link in it,
  // or any change of the address (Docs' tree and Projects' nav route on the
  // client, so no page load closes it), and on Escape. Focus moves into it
  // and back to the menu button.
  const menuBtn = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const href = location.href;
    // …and once a dialog or a bottom sheet opens over it (Docs' Import, settings, and on phones its popovers as sheets — buttons that change no address).
    const moved = setInterval(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .nt-popover[data-sheet]')].some((d) => !side.current?.contains(d));
      if (location.href !== href || dialog) setOpen(false);
    }, 150);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && setOpen(false);
    addEventListener("keydown", onKey);
    side.current?.querySelector<HTMLElement>("a[href], button")?.focus({ preventScroll: true });
    const btn = menuBtn.current;
    const panel = side.current;
    return () => {
      clearInterval(moved);
      removeEventListener("keydown", onKey);
      if (btn && btn.offsetParent && (!document.activeElement || document.activeElement === document.body || panel?.contains(document.activeElement))) btn.focus({ preventScroll: true });
    };
  }, [open]);
  const leave = (e: MouseEvent) => {
    if (!open || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const t = e.target as Element;
    const a = t.closest("a[href]");
    if (a && a.getAttribute("target") !== "_blank") setOpen(false);
    // Compose opens + Create as a sheet: the drawer goes, as for Search and Invite.
    else if (t.closest(".zc-create-icon")) setOpen(false);
  };
  const canEdit = ws.role === "owner" || ws.role === "editor";
  const unread = useUnread(ws.id, user.id);
  const initial = (ws.name.trim().charAt(0) || "z").toUpperCase();
  const me = (user.name.trim().charAt(0) || "?").toUpperCase();
  const at = (s: ShellSection) => (section === s ? ("page" as const) : undefined);
  const q = `?ws=${encodeURIComponent(ws.id)}`;
  const blockTitle = sectionTitle ?? (SECTIONS.find((s) => s.id === section) ? t(SECTIONS.find((s) => s.id === section)!.label) : "");
  const search = () => {
    setOpen(false);
    if (onSearch) onSearch();
    else openPalette();
  };
  const invite = () => {
    setOpen(false);
    setShare(true);
  };
  const signOut = () => void fetch("/api/auth/logout", { method: "POST" }).finally(() => (location.href = "/"));

  return (
    <div className="zv-shell ds-shell" data-open={open || undefined} data-fill={fill || undefined}>
      <div className="zv-scrim" onClick={() => setOpen(false)} />
      <aside ref={side} className="zv-side" aria-label={t("nav.menu")} onClick={leave}>
        {/* Linear's header: the workspace menu, then search and compose. */}
        <div className="ds-rail-head">
          <RailMenu
            className="ds-ws-btn"
            menuClassName="ds-ws-menu"
            label={ws.name}
            title={`${ws.name} · ${t(`ws.role.${ws.role}`)}`}
            button={
              <>
                <span className="zv-ws-avatar" aria-hidden>
                  {initial}
                </span>
                <span className="zv-ws-name">{ws.name}</span>
                <ChevronDown className="ds-ws-caret" aria-hidden />
              </>
            }
          >
            <>
              <div className="ds-menu-who">
                <span className="zv-avatar" aria-hidden>
                  {me}
                </span>
                <span className="ds-menu-who-text">
                  <span className="zv-user-name" title={user.name}>
                    {user.name}
                  </span>
                  <span className="ds-menu-sub">
                    {ws.name} · {t(`ws.role.${ws.role}`)}
                  </span>
                </span>
              </div>
              <div className="ds-menu-sep" role="separator" />
              <RailLink href="/settings" aria-current={at("settings")}>
                <Settings />
                {t("nav.settings")}
              </RailLink>
              <button type="button" onClick={invite}>
                <UserPlus />
                {dt(locale, "invitePeople")}
              </button>
              <RailLink href={productHref("team", ws.id)} aria-current={at("team")}>
                <Users />
                {t("nav.team")}
              </RailLink>
              {user.isAdmin && (
                <RailLink href="/admin" aria-current={at("admin")}>
                  <ShieldCheck />
                  {t("nav.admin")}
                </RailLink>
              )}
              <div className="ds-menu-sep" role="separator" />
              <div className="ds-menu-label">{dt(locale, "switchWorkspace")}</div>
              {user.workspaces.map((w) => (
                <a key={w.id} aria-current={w.id === ws.id ? "true" : undefined} href={`?ws=${encodeURIComponent(w.id)}`}>
                  {w.id === ws.id ? <Check /> : <span className="ds-menu-gap" />}
                  <span className="ds-menu-text">{w.name}</span>
                </a>
              ))}
              <a href="/team?new=1">
                <Plus />
                {t("nav.newWorkspace")}
              </a>
              <div className="ds-menu-sep" role="separator" />
              <div className="ds-menu-row">
                <LanguagePicker label={t("settings.language")} />
              </div>
              <button type="button" onClick={signOut}>
                <LogOut />
                {t("nav.signout")}
              </button>
            </>
          </RailMenu>
          <button type="button" className="ds-head-btn" aria-label={t("nav.search")} title={`${t("nav.search")} (⌘K)`} aria-keyshortcuts="Control+K Meta+K" onClick={search}>
            <Search />
          </button>
          <CreateButton ws={ws.id} canEdit={canEdit} hotkey={createHotkey} compact />
        </div>
        <RailScroll>
          <nav className="zv-nav" aria-label={t("nav.menu")}>
            <RailLink href={`/home${q}`} aria-current={at("home")}>
              <Home />
              {t("nav.home")}
            </RailLink>
            <RailLink href={`/inbox${q}`} aria-current={at("inbox")}>
              <Inbox />
              {t("nav.inbox")}
              {unread > 0 && <span className="ds-nav-badge">{unread > 99 ? "99+" : unread}</span>}
            </RailLink>
            <RailLink href={`/projects/my-issues${q}`} aria-current={at("my")}>
              <CircleUser />
              {dt(locale, "myTasks")}
            </RailLink>
          </nav>
          <RailGroup id="workspace" title={dt(locale, "workspace")} folds={folds}>
            <nav className="zv-nav" aria-label={dt(locale, "workspace")}>
              {SECTIONS.map((s) => (
                <RailLink key={s.id} href={productHref(s.id, ws.id)} aria-current={at(s.id)} external={s.id === "design"}>
                  {s.icon}
                  {t(s.label)}
                </RailLink>
              ))}
            </nav>
          </RailGroup>
          {sectionNav && (
            <RailGroup id={`section:${section}`} title={blockTitle} action={sectionAction} folds={folds}>
              <div className="ds-section-nav">{sectionNav}</div>
            </RailGroup>
          )}
          <RailGroup id="try" title={dt(locale, "try")} folds={folds}>
            <nav className="zv-nav" aria-label={dt(locale, "try")}>
              {/* Docs' own block has Import already. */}
              {canEdit && section !== "docs" && (
                <RailLink href={`/docs?import=1&ws=${encodeURIComponent(ws.id)}`}>
                  <Import />
                  {dt(locale, "importDocs")}
                </RailLink>
              )}
              <button type="button" onClick={invite}>
                <UserPlus />
                {dt(locale, "invitePeople")}
              </button>
              <RailLink href={productHref("templates", ws.id)} aria-current={at("templates")}>
                <LayoutTemplate />
                {t("nav.templates")}
              </RailLink>
            </nav>
          </RailGroup>
        </RailScroll>
        {/* Linear keeps only "?" at the very bottom; the account lives in the workspace menu. */}
        <div className="ds-rail-foot">
          <RailMenu className="ds-help-btn" menuClassName="ds-help-menu" menu label={dt(locale, "help")} button={<CircleHelp />}>
            <>
              <a role="menuitem" tabIndex={-1} href="/help">
                <BookOpen />
                {dt(locale, "helpCenter")}
              </a>
              <a role="menuitem" tabIndex={-1} href="/status">
                <Activity />
                {dt(locale, "systemStatus")}
              </a>
              <a role="menuitem" tabIndex={-1} href="/legal/privacy">
                <Scale />
                {dt(locale, "terms")}
              </a>
            </>
          </RailMenu>
        </div>
      </aside>
      <main className={`zv-main${fill ? " ds-main-fill" : ""}`}>
        <div className="zv-top">
          <button ref={menuBtn} type="button" className="zv-btn zv-btn-ghost zv-btn-sm ds-menu-btn" aria-label={t("nav.menu")} aria-expanded={open} onClick={() => setOpen(true)}>
            <MenuIcon size={18} />
          </button>
          <BrandLogo />
        </div>
        {children}
      </main>
      {palette && <CommandPalette ws={ws.id} canEdit={canEdit} />}
      {toaster && <Toaster />}
      {share && <ShareDialog ws={ws.id} me={user.name} onClose={() => setShare(false)} />}
    </div>
  );
}

/**
 * A rail link to another place of zvena: a client navigation (the loaded app,
 * its scripts and its data stay), with the place's data fetched as soon as the
 * pointer or the keyboard reaches the link — by the click it is usually there.
 * Not on every page load (ten rail links would fetch ten places each time), and
 * not on touch (a finger scrolling the rail would fetch every link it crosses).
 * `external`: a plain link (Design is another app on its own host).
 */
function RailLink({ href, external, children, ...rest }: { href: string; external?: boolean; children: ReactNode; "aria-current"?: "page" | "true" }) {
  const router = useRouter();
  if (external) return <a href={href} {...rest}>{children}</a>;
  // A full prefetch (the page's data too, kept 30 s: next.config staleTimes).
  const warm = () => router.prefetch(href, { kind: "full" as never });
  return (
    <Link href={href} prefetch={false} onPointerEnter={warm} onFocus={warm} {...rest}>
      {children}
    </Link>
  );
}

export interface ShellNavItemProps {
  href: string;
  label: ReactNode;
  icon?: ReactNode;
  /** A project or label color instead of an icon. */
  dot?: string;
  active?: boolean;
  badge?: number;
  keys?: readonly string[];
  indent?: boolean;
  /** Client routing: call preventDefault() and navigate. */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/** An item of a section's block in the rail, drawn like the rest of the rail. */
export function ShellNavItem({ href, label, icon, dot, active, badge, keys, indent, onClick }: ShellNavItemProps) {
  return (
    <a href={href} aria-current={active ? "page" : undefined} onClick={onClick} className={indent ? "ds-nav-indent" : undefined}>
      {dot ? <span className="ds-nav-dot" style={{ background: dot }} aria-hidden /> : icon}
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {badge ? <span className="ds-nav-badge">{badge > 99 ? "99+" : badge}</span> : keys ? <Kbd keys={keys} /> : null}
    </a>
  );
}

/** A list of ShellNavItems with the rail's spacing. */
export function ShellNavList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <nav className="zv-nav" aria-label={label}>
      {children}
    </nav>
  );
}

/** Linear's page header: a thin sticky bar with the page's icon and name, and its own controls at the end. */
export function PageHead({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="ds-page-head">
      <h1>
        {icon}
        {title}
      </h1>
      {children && <div className="ds-page-head-end">{children}</div>}
    </header>
  );
}
