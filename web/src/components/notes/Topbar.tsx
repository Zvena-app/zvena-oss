"use client";

// The top bar: breadcrumbs, "Edited …", Share (publish to web), favorite,
// and the page "•••" menu (style, small text, full width, lock, copy link,
// duplicate, move, trash, export, word count).

import { withWs } from "@/lib/notes/workspace";
import { inDesktopApp, inMobileApp, openInDesktop } from "@/lib/apps";
import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  MessageSquare,
  Copy,
  CornerUpRight,
  Download,
  Globe,
  Link,
  Lock,
  MoreHorizontal,
  Star,
  Trash2,
  Upload,
  Check,
  ExternalLink,
  History,
  SlidersHorizontal,
  Settings2,
  ChartLine,
  Clock,
  Plug,
  BookOpen,
  PencilLine,
  FilePen,
  ChevronDown,
  CheckCheck,
  X,
  Search,
  Bell,
  PanelRight,
} from "lucide-react";
import { ConnectionsMenu } from "./Integrations";
import { useNotes } from "./context";
import { ExpiryRow, SiteSettingsDialog, ViewsSparkline, siteOptionsOf } from "./SiteSettings";
import { cleanSiteOptions, type SiteOptions } from "@/lib/notes/sites";
import { Menu, Popover, Tip, toast, cx } from "./ui";
import { exportPart, historyPart, lazyComponent } from "./lazy";
import { ExportDialog } from "./ExportDialog";
import { ancestry, blankSchema, blocksText, defaultView, displayTitle, noteSlug, shortId } from "@/lib/notes/model";
import { asWiki, withoutWiki } from "@/lib/notes/verification";
import { withoutProp } from "@/lib/notes/db";
import { relativeTime } from "@/lib/notes/i18n";
import type { Note, NoteComment } from "@/lib/notes/types";
import { NoteIcon } from "./NoteIcon";
import { CollabFaces } from "./collab";
import { ShareAccess } from "./ShareAccess";
import { intlOf } from "@/i18n/locales";
import { suggestionIds, suggestionParts, type SuggestionPart } from "@/lib/notes/suggestions";
import { decideSuggestions, setSuggesting, useSuggesting } from "./suggest-mode";
import { useFollow } from "./follow";
import { publishSite } from "./live-site";
import { jumpToThread, setCommentsDocked, useCommentsDocked } from "./Comments";

/** The page's open suggestions (on the page, not yet accepted or rejected). */
function openSuggestionCount(note: Note): number {
  const decided = new Set((note.comments ?? []).filter((c) => c.suggestion?.state && c.thread).map((c) => c.thread as string));
  let n = 0;
  for (const sid of suggestionIds(note.content)) if (!decided.has(sid)) n += 1;
  return n;
}

/** Whether the person can only suggest here (Can comment), as PageView decides. */
function onlySuggests(api: ReturnType<typeof useNotes>, note: Note): boolean {
  return Boolean(api.user) && api.levelOf(note.id) === "comment" && !note.style?.locked && note.style?.comments !== "off" && !api.store.isTrashed(note.id);
}

const ModeLabel = ({ title, hint }: { title: string; hint: string }) => (
  <span className="nt-mi-2">
    <span>{title}</span>
    <small>{hint}</small>
  </span>
);

/** Notion's "Editing / Suggesting" switch at the top of a page. */
function SuggestChip({ note }: { note: Note }) {
  const api = useNotes();
  const { t } = api;
  const on = useSuggesting(note.id);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const only = onlySuggests(api, note);
  const canSwitch = Boolean(api.user) && api.canEdit(note.id) && !note.style?.locked;
  if (!only && !(canSwitch && on)) return null;
  if (only)
    return (
      <Tip label={t("suggest.onlyHint")}>
        <span className="nt-sug-chip" role="status">
          <FilePen size={14} />
          {t("suggest.suggesting")}
        </span>
      </Tip>
    );
  return (
    <>
      <button type="button" className="nt-sug-chip nt-btn-reset" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget)}>
        <FilePen size={14} />
        {t("suggest.suggesting")}
        <ChevronDown size={13} />
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} placement="bottom-end">
          <Menu
            width={280}
            onClose={() => setMenu(null)}
            groups={[
              {
                key: "mode",
                items: [
                  { key: "edit", label: <ModeLabel title={t("suggest.editing")} hint={t("suggest.editingHint")} />, icon: <PencilLine />, checked: !on, onSelect: () => (setSuggesting(note.id, false), setMenu(null)) },
                  { key: "suggest", label: <ModeLabel title={t("suggest.suggesting")} hint={t("suggest.suggestingHint")} />, icon: <FilePen />, checked: on, onSelect: () => (setSuggesting(note.id, true), setMenu(null)) },
                ],
              },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

const HistoryDialog = lazyComponent(historyPart, (m) => m.HistoryDialog);
const UpdatesPanel = lazyComponent(historyPart, (m) => m.UpdatesPanel);
const AnalyticsDialog = lazyComponent(historyPart, (m) => m.AnalyticsDialog);

function SharePopover({ note, anchor, onClose }: { note: Note; anchor: HTMLElement; onClose: () => void }) {
  const api = useNotes();
  const { t, locale, store } = api;
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = note.share ? `${location.origin}/n/${note.share.id}` : "";
  // How often the public page was opened (Notion's page analytics, in short).
  const [views, setViews] = useState<number | null>(null);
  const [days, setDays] = useState<{ day: string; n: number }[]>([]);
  const [siteDialog, setSiteDialog] = useState(false);
  const shareId = note.share?.id;
  const shareKey = note.share?.key;
  useEffect(() => {
    if (!shareId) return;
    let live = true;
    void fetch(withWs("/api/notes/share/stats"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: shareId, key: shareKey }) })
      .then((r) => (r.ok ? (r.json() as Promise<{ views: number; days?: { day: string; n: number }[] }>) : null))
      .then((j) => {
        if (!live || !j) return;
        setViews(j.views);
        setDays(j.days ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [shareId, shareKey]);
  const site = siteOptionsOf(note.share);
  /** Publishes (or republishes) with the site settings changed by `opts`; true when it worked. */
  const publish = async (opts?: Partial<SiteOptions>): Promise<boolean> => {
    const settings = cleanSiteOptions({ ...site, ...opts });
    setBusy(true);
    try {
      // The page, what is under it and its synced blocks' content (live-site.ts, as the quiet republish sends it).
      await publishSite(store, note, settings);
      toast(t(opts ? "share.saved" : "toast.published"));
      return true;
    } catch {
      toast(t("share.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const unpublish = async () => {
    if (!note.share) return;
    setBusy(true);
    try {
      const res = await fetch(withWs("/api/notes/share"), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: note.share.id, key: note.share.key }) });
      // Only a confirmed take-down clears the link: otherwise the page would still be public while it looks private.
      if (!res.ok) throw new Error(String(res.status));
      store.update(note.id, { share: undefined }, { quiet: true });
      toast(t("toast.unpublished"));
    } catch {
      toast(t("share.failed"));
    } finally {
      setBusy(false);
    }
  };
  // Notion's Share menu: "Share" (who has access) and "Publish" (to the web, full access).
  const canPublish = api.levelOf(note.id) === "full";
  const [tab, setTab] = useState<"share" | "publish">(api.user ? "share" : "publish");
  // The Site settings dialog takes the popover's place while it is open (a click in it must not close the popover under it).
  if (siteDialog && note.share && canPublish) return <SiteSettingsDialog note={note} options={site} onSave={(o) => publish(o)} onClose={() => setSiteDialog(false)} />;
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end">
      <div className="nt-share">
        {api.user && (
          <div className="nt-share-tabs">
            <button type="button" className="nt-share-tab nt-btn-reset" data-active={tab === "share" || undefined} onClick={() => setTab("share")}>
              {t("share.shareTab")}
            </button>
            {(canPublish || note.share) && (
              <button type="button" className="nt-share-tab nt-btn-reset" data-active={tab === "publish" || undefined} onClick={() => setTab("publish")}>
                {t("share.publish")}
              </button>
            )}
          </div>
        )}
        {api.user && tab === "share" && <ShareAccess note={note} />}
        {tab === "publish" && (canPublish || note.share) && (
          <>
            {!api.user && (
              <div className="nt-share-tabs">
                <button type="button" className="nt-share-tab nt-btn-reset" data-active="true">
                  {t("share.publish")}
                </button>
              </div>
            )}
            <div className="nt-share-body">
              {!canPublish ? (
                // Viewers and commenters cannot publish: they get the public link, if there is one.
                note.share ? (
                  <>
                    <div className="nt-share-title" style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center", color: "var(--nt-blue-text)" }}>
                      <Globe size={16} />
                      {t("share.published")}
                    </div>
                    <div className="nt-share-link">
                      <input className="nt-input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                      <a className="nt-btn nt-btn-plain nt-btn-sm" href={url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={14} />
                        {t("share.view")}
                      </a>
                    </div>
                  </>
                ) : null
              ) : note.share ? (
                <>
                  <div className="nt-share-title" style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center", color: "var(--nt-blue-text)" }}>
                    <Globe size={16} />
                    {t("share.published")}
                  </div>
                  <div className="nt-share-hint">
                    {t("share.lastPublished", { when: relativeTime(t, locale, note.share.at) })}
                    {views !== null && <span className="nt-share-views"> · {t("share.views", { n: views })}</span>}
                  </div>
                  <ViewsSparkline days={days} />
                  <div className="nt-share-link">
                    <input className="nt-input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                    <button
                      type="button"
                      className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset"
                      onClick={() => {
                        void navigator.clipboard?.writeText(url).catch(() => undefined);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      {copied ? <Check size={14} /> : <Link size={14} />}
                      {copied ? t("share.copied") : t("share.copy")}
                    </button>
                  </div>
                  {/* Notion's publish settings; a change republishes at once. */}
                  <div className="nt-share-opts">
                    <label className="nt-share-opt">
                      <span>
                        <b>{t("share.allowDup")}</b>
                        <small>{t("share.allowDupHint")}</small>
                      </span>
                      <button type="button" role="switch" aria-checked={!note.share.noDup} className="nt-switch nt-btn-reset" disabled={busy} onClick={() => void publish({ noDup: !note.share?.noDup })}>
                        <span />
                      </button>
                    </label>
                    <label className="nt-share-opt">
                      <span>
                        <b>{t("share.index")}</b>
                        <small>{t("share.indexHint")}</small>
                      </span>
                      <button type="button" role="switch" aria-checked={!!note.share.index} className="nt-switch nt-btn-reset" disabled={busy} onClick={() => void publish({ index: !note.share?.index })}>
                        <span />
                      </button>
                    </label>
                    <ExpiryRow options={site} busy={busy} onChange={(expiresAt) => void publish({ expiresAt })} />
                    <button type="button" className="nt-mi nt-btn-reset nt-site-open" onClick={() => setSiteDialog(true)}>
                      <span className="nt-mi-icon">
                        <Settings2 />
                      </span>
                      <span className="nt-mi-label">{t("site.settings")}</span>
                    </button>
                  </div>
                  <div className="nt-share-row">
                    <button type="button" className="nt-btn nt-btn-danger nt-btn-sm nt-btn-reset" disabled={busy} onClick={unpublish}>
                      {t("share.unpublish")}
                    </button>
                    <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" disabled={busy} onClick={() => void publish()}>
                      {t("share.update")}
                    </button>
                    <a className="nt-btn nt-btn-plain nt-btn-sm" href={url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={14} />
                      {t("share.view")}
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <div className="nt-share-globe">
                    <Globe strokeWidth={1.4} />
                  </div>
                  <div className="nt-share-title">{t("share.publishTitle")}</div>
                  {/* Publishing needs an account (the server refuses a guest): say so instead of failing. */}
                  <div className="nt-share-hint">{api.user ? t("share.publishHint") : t("share.guestPublish")}</div>
                  {api.user ? (
                    <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" style={{ width: "100%" }} disabled={busy} onClick={() => void publish()}>
                      {busy ? "…" : t("share.publishBtn")}
                    </button>
                  ) : (
                    <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" style={{ width: "100%" }} onClick={() => (onClose(), api.signIn())}>
                      {t("settings.signIn")}
                    </button>
                  )}
                  <div style={{ marginTop: 12, fontSize: 12, color: "var(--nt-text-3)", textAlign: "center" }}>{t("share.privateNote")}</div>
                </>
              )}
            </div>
          </>
        )}
        <div style={{ boxShadow: "0 -1px 0 var(--nt-border)", padding: "4px 0" }}>
          <button type="button" className="nt-mi nt-btn-reset" onClick={() => (api.copyLink(note.id), onClose())}>
            <span className="nt-mi-icon">
              <Link />
            </span>
            <span className="nt-mi-label">{t("share.copyPageLink")}</span>
          </button>
        </div>
      </div>
    </Popover>
  );
}

function StyleButton({ label, family, active, onClick }: { label: string; family: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="nt-style-btn nt-btn-reset"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "6px 0", borderRadius: 4, color: active ? "var(--nt-blue-text)" : "var(--nt-text)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--nt-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ fontSize: 24, fontFamily: family, lineHeight: 1.2 }}>Ag</span>
      <span style={{ fontSize: 12, color: active ? "var(--nt-blue-text)" : "var(--nt-text-2)" }}>{label}</span>
    </button>
  );
}

function MoreMenu({ note, anchor, onClose, onHistory, onUpdates, onAnalytics, onExport }: { note: Note; anchor: HTMLElement; onClose: () => void; onHistory: () => void; onUpdates: () => void; onAnalytics: () => void; onExport: () => void }) {
  const api = useNotes();
  const { t, store, locale } = api;
  // The export code loads when this menu opens (the dialog runs it).
  useEffect(() => void exportPart.load().catch(() => {}), []);
  const [custom, setCustom] = useState<HTMLElement | null>(null);
  const [conn, setConn] = useState<HTMLElement | null>(null);
  const style = note.style ?? {};
  const setStyle = (patch: Partial<NonNullable<Note["style"]>>) => store.update(note.id, { style: { ...style, ...patch } }, { quiet: true });
  const words = useMemo(() => blocksText(note.content).split(/\s+/).filter(Boolean).length, [note.content]);
  // Notion's "Turn into wiki" (full access; a full page, not a database's row): the page's
  // sub-pages become the wiki's pages, each with an Owner and a Verification.
  const parent = note.parentId ? api.snap.byId.get(note.parentId) : undefined;
  const canWiki = api.levelOf(note.id) === "full" && !note.inline && !note.template && parent?.kind !== "database" && (note.kind === "page" || Boolean(note.db));
  const turnIntoWiki = () => {
    const names = { owner: t("wiki.owner"), verification: t("prop.verification") };
    const me = api.user?.id;
    let schema = note.db;
    if (!schema) {
      schema = blankSchema({ name: t("db.name"), tags: t("db.tags"), table: t("wiki.allPages") });
      schema.views = [defaultView("list", t("wiki.allPages"), schema)];
    }
    const wiki = asWiki(schema, names, shortId);
    const ownerId = wiki.wiki?.owner as string;
    // The sub-pages become the wiki's pages: their links in the body are the list now.
    const rows = api.snap.list.filter((n) => n.parentId === note.id && !n.inline && !n.synced && !n.template && n.trashedAt === null);
    const rowIds = new Set(rows.map((n) => n.id));
    const content = note.kind === "page" ? note.content.filter((b) => !((b as { type?: string }).type === "page" && rowIds.has(String((b as { props?: { noteId?: unknown } }).props?.noteId)))) : note.content;
    store.update(note.id, { kind: "database", db: wiki, content });
    // Each page is owned by whoever made it (or by the one turning it into a wiki).
    for (const r of rows) {
      if (Array.isArray(r.props?.[ownerId]) && (r.props?.[ownerId] as string[]).length) continue;
      const owner = r.createdBy && /^[A-Za-z0-9_-]{6,64}$/.test(r.createdBy) ? r.createdBy : me;
      if (owner) store.update(r.id, { props: { ...(r.props ?? {}), [ownerId]: [owner] } }, { quiet: true });
    }
    toast(t("wiki.turned"));
    onClose();
  };
  // Without edit access to this page: copy the link, the page's history (no restore), updates, analytics, export.
  const ro = !api.canEdit(note.id);
  const suggesting = useSuggesting(note.id);
  const pending = useMemo(() => openSuggestionCount(note), [note]);
  const follow = useFollow(note.id);
  const findItem = note.kind === "page" ? [{ key: "find", label: t("menu.find"), icon: <Search />, hint: "Ctrl+F", onSelect: () => (onClose(), window.dispatchEvent(new CustomEvent("nt-find", { detail: note.id }))) }] : [];
  const followItem = follow.on !== null ? [{ key: "follow", label: t("menu.follow"), icon: <Bell />, toggle: true, checked: follow.on, onSelect: follow.toggle }] : [];
  const suggestItems =
    api.user && !ro && !style.locked && note.kind === "page"
      ? [
          { key: "suggest", label: t("suggest.menu"), icon: <FilePen />, toggle: true, checked: suggesting, onSelect: () => setSuggesting(note.id, !suggesting) },
          ...(pending
            ? [
                { key: "acceptAll", label: t("suggest.acceptAll"), icon: <CheckCheck />, onSelect: () => (decideSuggestions(note.id, true), onClose()) },
                { key: "rejectAll", label: t("suggest.rejectAll"), icon: <X />, onSelect: () => (decideSuggestions(note.id, false), onClose()) },
              ]
            : []),
        ]
      : [];
  // The workspace's history, updates and analytics (members; a guest's pages keep this browser's history only).
  const historyItems = [
    { key: "history", label: t("menu.history"), icon: <History />, onSelect: () => (onClose(), onHistory()) },
    ...(api.user
      ? [
          { key: "updates", label: t("menu.updates"), icon: <Clock />, onSelect: () => (onClose(), onUpdates()) },
          { key: "analytics", label: t("menu.analytics"), icon: <ChartLine />, onSelect: () => (onClose(), onAnalytics()) },
        ]
      : []),
  ];
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end">
      <Menu
        width={270}
        header={
          note.kind === "page" && !ro ? (
            <div style={{ padding: "6px 10px 6px", boxShadow: "0 1px 0 var(--nt-border)" }}>
              <div className="nt-menu-label" style={{ padding: "0 4px", margin: "0 0 2px" }}>
                {t("menu.style")}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {/* Notion's Style: Default (zvena's Inter), Serif, Mono. "sans" is how older pages said Default. */}
                <StyleButton label={t("menu.default")} family="var(--nt-font)" active={!style.font || style.font === "default" || style.font === "sans"} onClick={() => setStyle({ font: "default" })} />
                <StyleButton label={t("menu.serif")} family="var(--nt-serif)" active={style.font === "serif"} onClick={() => setStyle({ font: "serif" })} />
                <StyleButton label={t("menu.mono")} family="var(--nt-mono)" active={style.font === "mono"} onClick={() => setStyle({ font: "mono" })} />
              </div>
            </div>
          ) : undefined
        }
        groups={[
          {
            key: "toggles",
            items: ro ? [] : [
              ...(note.kind === "page"
                ? [
                    { key: "small", label: t("menu.smallText"), toggle: true, checked: Boolean(style.small), onSelect: () => setStyle({ small: !style.small }) },
                    { key: "full", label: t("menu.fullWidth"), toggle: true, checked: Boolean(style.full), onSelect: () => setStyle({ full: !style.full }) },
                  ]
                : []),
              { key: "lock", label: t("menu.lock"), icon: <Lock />, toggle: true, checked: Boolean(style.locked), onSelect: () => setStyle({ locked: !style.locked }) },
            ],
          },
          { key: "suggest", items: suggestItems },
          {
            key: "actions",
            items: ro ? [{ key: "link", label: t("menu.copyLink"), icon: <Link />, onSelect: () => (api.copyLink(note.id), onClose()) }, ...findItem, ...followItem, ...historyItems] : [
              { key: "fav", label: note.favorite ? t("menu.removeFromFavorites") : t("menu.addToFavorites"), icon: <Star />, onSelect: () => (store.update(note.id, { favorite: !note.favorite }, { quiet: true }), onClose()) },
              { key: "link", label: t("menu.copyLink"), icon: <Link />, onSelect: () => (api.copyLink(note.id), onClose()) },
              { key: "dup", label: t("menu.duplicate"), icon: <Copy />, onSelect: () => (api.duplicate(note.id), onClose()) },
              { key: "move", label: t("menu.moveTo"), icon: <CornerUpRight />, onSelect: (el) => api.openMove(note.id, el) },
              ...findItem,
              ...followItem,
              ...(canWiki && !note.db?.wiki ? [{ key: "wiki", label: t("wiki.turnInto"), icon: <BookOpen />, onSelect: turnIntoWiki }] : []),
              ...(canWiki && note.db?.wiki ? [{ key: "unwiki", label: t("wiki.revert"), icon: <BookOpen />, onSelect: () => (note.db && store.update(note.id, { db: withoutWiki(note.db, withoutProp) }), onClose()) }] : []),
              // Notion's "Connections": integrations that may use this page (signed-in workspaces only).
              ...(api.user ? [{ key: "connections", label: t("menu.connections"), icon: <Plug />, submenu: true, onSelect: (el: HTMLElement) => setConn(el) }] : []),
              ...historyItems,
              { key: "customize", label: t("menu.customize"), icon: <SlidersHorizontal />, submenu: true, onSelect: (el: HTMLElement) => setCustom(el) },
              { key: "trash", label: t("menu.delete"), icon: <Trash2 />, danger: true, onSelect: () => (api.trash(note.id), onClose()) },
            ],
          },
          {
            key: "io",
            items: [
              ...(ro ? [] : [{ key: "import", label: t("menu.import"), icon: <Upload />, onSelect: () => (onClose(), api.openImport()) }]),
              ...(api.user?.ws.noExport ? [] : [{ key: "export", label: t("menu.export"), icon: <Download />, onSelect: () => (onClose(), onExport()) }]),
              // Notion's "Open in Mac/Windows app": the desktop app takes zvena:// links (clients/desktop).
              ...(api.user && !inDesktopApp() && !inMobileApp() ? [{ key: "desktop", label: t("menu.openInApp"), icon: <AppWindow />, onSelect: () => (onClose(), openInDesktop(`${location.origin}${withWs("/docs")}#${noteSlug(note)}`)) }] : []),
            ],
          },
        ]}
        footer={
          <div className="nt-menu-meta">
            {note.kind === "page" && <div>{t("menu.wordCount", { n: words })}</div>}
            <div>{t("menu.lastEdited", { when: relativeTime(t, locale, note.updatedAt) })}</div>
            <div>{t("menu.created", { when: new Date(note.createdAt).toLocaleString(intlOf(locale), { dateStyle: "medium", timeStyle: "short" }) })}</div>
          </div>
        }
      />
      {/* Notion's "Customize page": where backlinks and page comments show. */}
      {conn && <ConnectionsMenu note={note} anchor={conn} onClose={() => setConn(null)} onManage={() => (onClose(), api.openSettings())} />}
      {custom && (
        <Popover anchor={custom} placement="left-start" onClose={() => setCustom(null)}>
          <Menu
            width={240}
            groups={[
              {
                key: "bl",
                label: t("customize.backlinks"),
                items: (
                  [
                    ["expanded", "customize.expanded"],
                    [undefined, "customize.popover"],
                    ["off", "customize.off"],
                  ] as const
                ).map(([v, label]) => ({ key: `bl-${label}`, label: t(label), checked: style.backlinks === v, onSelect: () => setStyle({ backlinks: v }) })),
              },
              {
                key: "cm",
                label: t("customize.comments"),
                items: (
                  [
                    [undefined, "customize.expanded"],
                    ["off", "customize.off"],
                  ] as const
                ).map(([v, label]) => ({ key: `cm-${label}`, label: t(label), checked: style.comments === v, onSelect: () => setStyle({ comments: v }) })),
              },
            ]}
          />
        </Popover>
      )}
    </Popover>
  );
}

/** What a suggestion adds and removes, on one line. */
const suggestionLine = (p: SuggestionPart | undefined) => (p ? [p.ins.trim() && `+ ${p.ins.trim()}`, p.del.trim() && `− ${p.del.trim()}`].filter(Boolean).join("  ") : "");

/** All open discussions on the page; a click jumps to the marked text. */
function DiscussionsPopover({ note, anchor, onClose }: { note: Note; anchor: HTMLElement; onClose: () => void }) {
  const { t, locale } = useNotes();
  // Notion's comment list: open discussions, or resolved ones (decided suggestions are history, not discussions).
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const all = note.comments ?? [];
  const decided = new Set(all.filter((c) => c.suggestion?.state && c.thread).map((c) => c.thread as string));
  const shown = all.filter((c) => (tab === "open" ? !c.resolved : c.resolved && !(c.thread && decided.has(c.thread))));
  const parts = useMemo(() => suggestionParts(note.content), [note.content]);
  const threads = new Map<string, NoteComment[]>();
  for (const c of shown) {
    const key = c.thread ?? `page:${c.id}`;
    threads.set(key, [...(threads.get(key) ?? []), c]);
  }
  const go = (key: string) => {
    onClose();
    jumpToThread(key);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end">
      <div className="nt-discuss">
        <div className="nt-discuss-tabs" role="tablist" aria-label={t("comments.all")}>
          {(["open", "resolved"] as const).map((k) => (
            <button type="button" key={k} role="tab" aria-selected={tab === k} className="nt-discuss-tab nt-btn-reset" onClick={() => setTab(k)}>
              {t(k === "open" ? "comments.openTab" : "comments.resolvedTab")}
            </button>
          ))}
          {/* Notion's "Open in sidebar": the list pinned beside the page, threads in full. */}
          <button
            type="button"
            className="nt-icon-btn nt-btn-reset nt-discuss-dock nt-hide-mobile"
            aria-label={t("comments.dock")}
            title={t("comments.dock")}
            data-test="comments-dock"
            onClick={() => {
              onClose();
              setCommentsDocked(true);
            }}
          >
            <PanelRight size={16} />
          </button>
        </div>
        {threads.size === 0 && <p className="nt-discuss-empty">{t(tab === "open" ? "comments.noneOpen" : "comments.noneResolved")}</p>}
        {[...threads.entries()].map(([key, list]) => (
          <button type="button" key={key} className="nt-discuss-row nt-btn-reset" onClick={() => go(key)}>
            {list[0].suggestion ? (
              <span className="nt-thread-quote">{suggestionLine(parts.get(key))}</span>
            ) : list[0].quote ? (
              <span className="nt-thread-quote">{list[0].quote}</span>
            ) : (
              <span className="nt-discuss-page">{t("comments.onPage")}</span>
            )}
            <span className="nt-discuss-text">
              <b>{list[0].author || t("comments.you")}</b> {list[0].suggestion ? <span className="nt-discuss-sug">{t("suggest.title")}</span> : list[0].text}
            </span>
            <span className="nt-discuss-meta">
              {relativeTime(t, locale, list[list.length - 1].at)}
              {list.length > 1 ? ` · ${t("comments.replies", { n: list.length - 1 })}` : ""}
            </span>
          </button>
        ))}
      </div>
    </Popover>
  );
}

export function Topbar({ note, title }: { note: Note | null; title?: string }) {
  const api = useNotes();
  const { t, locale, snap, store } = api;
  const [share, setShare] = useState<HTMLElement | null>(null);
  const [discuss, setDiscuss] = useState<HTMLElement | null>(null);
  const docked = useCommentsDocked();
  const [more, setMore] = useState<HTMLElement | null>(null);
  const [history, setHistory] = useState(false);
  const [updates, setUpdates] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [exporting, setExporting] = useState(false);
  const chain = note ? ancestry(note.id, snap.byId) : [];
  // What the person may do on this page (a share can let a viewer edit one page, or a commenter only comment).
  const canEdit = note ? api.canEdit(note.id) : false;
  // Long paths collapse in the middle ("A / … / C / D"), as in Notion.
  const crumbs = chain.length > 3 ? [chain[0], null, ...chain.slice(-2)] : chain;
  return (
    <header className="nt-topbar">
      <nav className="nt-crumbs" aria-label={t("slash.breadcrumb")}>
        {note ? (
          crumbs.map((n, i) => (
            <span key={n ? n.id : `gap-${i}`} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
              {i > 0 && <span className="nt-crumb-sep">/</span>}
              {n ? (
                <button type="button" className="nt-crumb nt-btn-reset" onClick={() => api.open(n.id)}>
                  {n.icon ? <span className="nt-crumb-icon"><NoteIcon icon={n.icon} /></span> : null}
                  <span className="nt-crumb-text">{displayTitle(n, n.kind === "database" ? t("db.untitled") : t("page.untitled"))}</span>
                </button>
              ) : (
                <span className="nt-crumb">…</span>
              )}
            </span>
          ))
        ) : (
          <span className="nt-crumb">{title}</span>
        )}
        {note?.style?.locked && (
          <button type="button" className="nt-locked-pill nt-btn-reset" disabled={!canEdit} onClick={() => canEdit && store.update(note.id, { style: { ...note.style, locked: false } }, { quiet: true })}>
            <Lock size={12} />
            {t("page.locked")}
          </button>
        )}
        {/* Only people invited can open it (Notion's lock next to the page path). */}
        {note && (note.access?.restricted || (note.parentId === null && note.space?.startsWith("private:") && api.user && note.space !== `private:${api.user.id}`)) && (
          <Tip label={t("access.onlyInvited")}>
            <span className="nt-locked-pill" aria-label={t("access.onlyInvited")}>
              <Lock size={12} />
            </span>
          </Tip>
        )}
      </nav>
      {note && (
        <div className="nt-top-actions">
          <span className="nt-top-edited">{t("page.edited", { when: relativeTime(t, locale, note.updatedAt) })}</span>
          {/* Who else is in the page now (Notion's avatars before Share). */}
          <CollabFaces noteId={note.id} />
          <SuggestChip note={note} />
          <button type="button" className="nt-top-btn nt-top-share nt-btn-reset" onClick={(e) => setShare(e.currentTarget)}>
            {note.share ? <Globe size={15} style={{ color: "var(--nt-blue-text)" }} /> : null}
            {t("page.share")}
          </button>
          {(note.comments ?? []).some((c) => !c.suggestion?.state) && (
            <Tip label={t("comments.all")}>
              <button type="button" className="nt-top-btn nt-btn-reset nt-top-cm" aria-label={t("comments.all")} aria-pressed={docked} onClick={(e) => (docked ? setCommentsDocked(false) : setDiscuss(e.currentTarget))}>
                <MessageSquare />
                {(note.comments ?? []).some((c) => !c.resolved) && <span>{new Set((note.comments ?? []).filter((c) => !c.resolved).map((c) => c.thread ?? c.id)).size}</span>}
              </button>
            </Tip>
          )}
          {canEdit && (
            <Tip label={note.favorite ? t("page.unfavorite") : t("page.favorite")}>
              <button type="button" className={cx("nt-top-btn nt-btn-reset nt-hide-mobile")} data-on={note.favorite || undefined} aria-label={t("page.favorite")} aria-pressed={note.favorite} onClick={() => store.update(note.id, { favorite: !note.favorite }, { quiet: true })}>
                <Star />
              </button>
            </Tip>
          )}
          <Tip label={t("page.more")}>
            <button type="button" className="nt-top-btn nt-btn-reset" aria-label={t("page.more")} onClick={(e) => setMore(e.currentTarget)}>
              <MoreHorizontal />
            </button>
          </Tip>
        </div>
      )}
      {share && note && <SharePopover note={note} anchor={share} onClose={() => setShare(null)} />}
      {discuss && note && <DiscussionsPopover note={note} anchor={discuss} onClose={() => setDiscuss(null)} />}
      {more && note && <MoreMenu note={note} anchor={more} onClose={() => setMore(null)} onHistory={() => setHistory(true)} onUpdates={() => setUpdates(true)} onAnalytics={() => setAnalytics(true)} onExport={() => setExporting(true)} />}
      {history && note && <HistoryDialog note={note} onClose={() => setHistory(false)} />}
      {updates && note && <UpdatesPanel note={note} onClose={() => setUpdates(false)} />}
      {analytics && note && <AnalyticsDialog note={note} onClose={() => setAnalytics(false)} />}
      {exporting && note && <ExportDialog note={note} onClose={() => setExporting(false)} />}
    </header>
  );
}
