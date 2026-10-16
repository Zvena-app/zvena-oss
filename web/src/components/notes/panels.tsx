"use client";

// Search (⌘K), Trash, "Move to", and Settings.

import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppWindow, Bell, Check, ChevronDown, CornerDownLeft, FileText, History, Search, Trash2, Undo2, Plus, X, Lock as LockIcon, Moon, Sun, Monitor, Download, Keyboard, Plug, SlidersHorizontal, Upload, UserRound, Users } from "lucide-react";
import { useNotes } from "./context";
import { Modal, Popover, toast } from "./ui";
import { ancestry, displayTitle, subtreeIds } from "@/lib/notes/model";
import { initials, people, subscribePeople } from "@/lib/notes/people";
import { clearSearches, matchRanges, queryWords, recentSearches, rememberSearch, searchNotes, type SearchOpts } from "@/lib/notes/search";
import { relativeTime } from "@/lib/notes/i18n";
import type { Note } from "@/lib/notes/types";
import { NoteIcon } from "./NoteIcon";
import { ExportDialog } from "./ExportDialog";
import { applyTheme, readTheme, setOpenOnStart, setWeekStart, useMondayFirst, useOpenOnStart, type OpenOnStart, type Theme } from "./prefs";
import { NOTIFY_SETTINGS, fetchDocsPrefs, saveDocsPrefs, type DocsPrefs, type NotifySetting } from "@/lib/notes/prefs-client";
import type { NotesKey } from "@/lib/notes/i18n";
import { NOTES_SHORTCUTS, shortcutKey } from "@/lib/notes/shortcuts";
import { IntegrationsPanel } from "./Integrations";
import { GroupsPanel } from "./GroupsPanel";
import { AppsSettings } from "./AppsSettings";
import { intlOf } from "@/i18n/locales";
import { Kbd } from "@/components/zvena/ds";

function TableGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3 8h14M8 8v8" />
    </svg>
  );
}

export function NoteGlyph({ note, size = 16 }: { note: Note; size?: number }) {
  if (note.icon) return <span style={{ fontSize: size, lineHeight: 1 }}><NoteIcon icon={note.icon} /></span>;
  return note.kind === "database" ? <TableGlyph /> : <FileText strokeWidth={1.6} />;
}

// ---------------------------------------------------------------------------
// Search

function Hl({ text, q }: { text: string; q: string }) {
  const ranges = matchRanges(text, queryWords(q));
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) parts.push(<span key={`t${i}`}>{text.slice(at, s)}</span>);
    parts.push(<mark key={`m${i}`}>{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) parts.push(<span key="end">{text.slice(at)}</span>);
  return <>{parts}</>;
}

const SORTS = ["best", "edited", "editedOld", "created"] as const;
const DATES = [0, 1, 7, 30] as const;

const ymd = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Local midnight of a "YYYY-MM-DD" (the range's ends are whole days)… */
const dayStart = (s: string) => new Date(`${s}T00:00:00`).getTime();
/** …and of the day after it (DST-safe). */
const nextDayStart = (s: string) => {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.getTime();
};

/** Notion's search filters: sort, titles only, created by, in a page, date edited. */
/** The sidebar section a note sits in (its top-level page's: "private:<id>", "ts:<id>", or "" for the workspace's). */
function sectionOf(n: Note, byId: ReadonlyMap<string, Note>): string {
  let cur = n;
  const seen = new Set<string>();
  while (cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const up = byId.get(cur.parentId);
    if (!up) break;
    cur = up;
  }
  return cur.space ?? "";
}

type SearchScope = { kind: "page"; note: Note } | { kind: "space"; key: string; name: string };

function SearchFilters({ opts, setOpts, inPage, setInPage }: { opts: SearchOpts; setOpts: (o: SearchOpts) => void; inPage: SearchScope | null; setInPage: (n: SearchScope | null) => void }) {
  const { t, snap, store, user, locale, teamspaces } = useNotes();
  const [pop, setPop] = useState<{ kind: "sort" | "in" | "date" | "who"; el: HTMLElement } | null>(null);
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState(false);
  const days = opts.days ?? 0;
  const everyone = useSyncExternalStore(subscribePeople, people, people);
  const pages = snap.list.filter((n) => n.trashedAt === null && !store.isTrashed(n.id) && !n.template && (!q.trim() || n.title.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 30);
  const who = opts.createdBy ? [...opts.createdBy] : [];
  const whoLabel = who.map((id) => (id === user?.id ? t("search.me") : (everyone.find((p) => p.id === id)?.name ?? "?"))).join(", ");
  // "Me" first, then the other members (Notion's Created by list).
  const candidates = [...everyone].sort((a, b) => (a.id === user?.id ? -1 : b.id === user?.id ? 1 : a.name.localeCompare(b.name))).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const fmt = (at: number) => new Date(at).toLocaleDateString(intlOf(locale), { day: "numeric", month: "short" });
  const dateLabel = days > 0 ? t(`search.date.${days}` as never) : opts.since || opts.until ? t("search.date.range", { from: opts.since ? fmt(opts.since) : "…", to: opts.until ? fmt(opts.until - 1) : "…" }) : t("search.date.any");
  const toggleWho = (id: string) => {
    const next = new Set(who);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpts({ ...opts, createdBy: next.size ? next : undefined });
  };
  const active = (opts.sort ?? "best") !== "best" || opts.titleOnly || opts.createdBy || inPage || opts.since || opts.until;
  const open = (kind: "sort" | "in" | "date" | "who") => (e: React.MouseEvent<HTMLElement>) => {
    setQ("");
    setCustom(false);
    setPop({ kind, el: e.currentTarget });
  };
  return (
    <div className="nt-search-filters">
      <button type="button" className="nt-db-pill nt-btn-reset" data-on={(opts.sort ?? "best") !== "best" || undefined} onClick={open("sort")}>
        {t(`search.sort.${opts.sort ?? "best"}`)}
        <ChevronDown />
      </button>
      <button type="button" className="nt-db-pill nt-btn-reset" data-on={opts.titleOnly || undefined} aria-pressed={!!opts.titleOnly} onClick={() => setOpts({ ...opts, titleOnly: !opts.titleOnly || undefined })}>
        {t("search.titleOnly")}
      </button>
      {everyone.length > 0 && (
        <button type="button" className="nt-db-pill nt-btn-reset" data-on={who.length > 0 || undefined} onClick={open("who")}>
          {who.length ? t("search.createdByWho", { who: whoLabel }) : t("search.createdBy")}
          <ChevronDown />
        </button>
      )}
      <button type="button" className="nt-db-pill nt-btn-reset" data-on={inPage ? true : undefined} onClick={open("in")}>
        {inPage?.kind === "page" ? t("search.inPage", { page: displayTitle(inPage.note, t("page.untitled")) }) : inPage ? t("search.inTeamspace", { name: inPage.name }) : t("search.inAll")}
        <ChevronDown />
      </button>
      <button type="button" className="nt-db-pill nt-btn-reset" data-on={days > 0 || opts.since || opts.until ? true : undefined} onClick={open("date")}>
        {dateLabel}
        <ChevronDown />
      </button>
      {active && (
        <button type="button" className="nt-search-reset nt-btn-reset" onClick={() => (setOpts({}), setInPage(null))}>
          {t("search.reset")}
        </button>
      )}
      {pop?.kind === "who" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)}>
          <div className="nt-menu" style={{ width: 260 }}>
            <div className="nt-menu-input-wrap">
              <input className="nt-input" autoFocus value={q} placeholder={t("search.findPerson")} onChange={(e) => setQ(e.target.value)} />
            </div>
            {candidates.slice(0, 50).map((p) => (
              <button type="button" key={p.id} role="menuitemcheckbox" aria-checked={who.includes(p.id)} className="nt-mi nt-btn-reset" data-active={who.includes(p.id) || undefined} onClick={() => toggleWho(p.id)}>
                <span className="nt-mi-icon">
                  <span className="nt-avatar-xs" aria-hidden="true">
                    {initials(p.name)}
                  </span>
                </span>
                <span className="nt-mi-label">{p.id === user?.id ? `${p.name} (${t("search.me")})` : p.name}</span>
                {who.includes(p.id) && <Check size={14} />}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {pop?.kind === "sort" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)}>
          <div className="nt-menu" style={{ width: 240 }}>
            {SORTS.map((s) => (
              <button type="button" key={s} className="nt-mi nt-btn-reset" data-active={(opts.sort ?? "best") === s || undefined} onClick={() => (setOpts({ ...opts, sort: s === "best" ? undefined : s }), setPop(null))}>
                <span className="nt-mi-label">{t(`search.sort.${s}`)}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
      {pop?.kind === "date" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)}>
          <div className="nt-menu" style={{ width: 240 }}>
            {DATES.map((d) => (
              <button
                type="button"
                key={d}
                className="nt-mi nt-btn-reset"
                data-active={(d ? days === d : !days && !opts.since && !opts.until) || undefined}
                // "Today" starts at local midnight; the others count whole days back.
                onClick={() => (setOpts({ ...opts, days: d || undefined, since: d === 1 ? dayStart(ymd(Date.now())) : d ? Date.now() - d * 86_400_000 : undefined, until: undefined }), setPop(null))}
              >
                <span className="nt-mi-label">{d ? t(`search.date.${d}` as never) : t("search.date.any")}</span>
              </button>
            ))}
            <button type="button" className="nt-mi nt-btn-reset" data-active={(!days && Boolean(opts.since || opts.until)) || undefined} onClick={() => setCustom(true)}>
              <span className="nt-mi-label">{t("search.date.custom")}</span>
            </button>
            {(custom || (!days && (opts.since || opts.until))) && (
              <div className="nt-search-range">
                <label>
                  <span>{t("search.from")}</span>
                  <input
                    className="nt-input"
                    type="date"
                    value={opts.since && !days ? ymd(opts.since) : ""}
                    onChange={(e) => setOpts({ ...opts, days: undefined, since: e.target.value ? dayStart(e.target.value) : undefined })}
                  />
                </label>
                <label>
                  <span>{t("search.to")}</span>
                  <input
                    className="nt-input"
                    type="date"
                    value={opts.until ? ymd(opts.until - 1) : ""}
                    // Through the end of that day.
                    onChange={(e) => setOpts({ ...opts, days: undefined, until: e.target.value ? nextDayStart(e.target.value) : undefined })}
                  />
                </label>
              </div>
            )}
          </div>
        </Popover>
      )}
      {pop?.kind === "in" && (
        <Popover anchor={pop.el} onClose={() => setPop(null)}>
          <div className="nt-menu" style={{ width: 280 }}>
            <div className="nt-menu-input-wrap">
              <input className="nt-input" autoFocus value={q} placeholder={t("search.findPage")} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button type="button" className="nt-mi nt-btn-reset" data-active={!inPage || undefined} onClick={() => (setInPage(null), setPop(null))}>
              <span className="nt-mi-label">{t("search.inAll")}</span>
            </button>
            {/* Notion's "In" also takes a teamspace (or a section of the sidebar). */}
            {teamspaces.filter((ts) => !q.trim() || ts.name.toLowerCase().includes(q.trim().toLowerCase())).length > 0 && <div className="nt-menu-label">{t("search.teamspaces")}</div>}
            {teamspaces
              .filter((ts) => !q.trim() || ts.name.toLowerCase().includes(q.trim().toLowerCase()))
              .map((ts) => (
                <button type="button" key={ts.id} className="nt-mi nt-btn-reset" data-active={(inPage?.kind === "space" && inPage.key === `ts:${ts.id}`) || undefined} onClick={() => (setInPage({ kind: "space", key: `ts:${ts.id}`, name: ts.name }), setPop(null))}>
                  <span className="nt-mi-icon">{ts.icon || "👥"}</span>
                  <span className="nt-mi-label">{ts.name}</span>
                </button>
              ))}
            {pages.length > 0 && <div className="nt-menu-label">{t("search.pages")}</div>}
            {pages.map((n) => (
              <button type="button" key={n.id} className="nt-mi nt-btn-reset" data-active={(inPage?.kind === "page" && inPage.note.id === n.id) || undefined} onClick={() => (setInPage({ kind: "page", note: n }), setPop(null))}>
                <span className="nt-mi-icon">
                  <NoteGlyph note={n} />
                </span>
                <span className="nt-mi-label">{displayTitle(n, t("page.untitled"))}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const api = useNotes();
  const { t, snap, store, locale } = api;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // The open workspace by its name (a team's, not the person's first name).
  const ws = api.user ? t("app.workspace", { name: api.user.ws.name }) : t("app.workspaceGuest");
  const recent = useMemo(
    () =>
      store.meta.recent
        .map((r) => snap.byId.get(r.id))
        .filter((n): n is Note => Boolean(n) && !(n as Note).synced && !store.isTrashed((n as Note).id))
        .slice(0, 12),
    [snap.byId, store]
  );
  const [opts, setOpts] = useState<SearchOpts>({});
  const [inPage, setInPage] = useState<SearchScope | null>(null);
  const within = useMemo(
    () => (inPage?.kind === "page" ? new Set(subtreeIds(inPage.note.id, snap.list)) : inPage ? new Set(snap.list.filter((n) => sectionOf(n, snap.byId) === inPage.key).map((n) => n.id)) : undefined),
    [inPage, snap.byId, snap.list]
  );
  const results = useMemo(() => searchNotes(snap.list, q, (id) => store.isTrashed(id), { ...opts, within }), [q, snap.list, store, opts, within]);
  // With an empty box: recent searches, then recently visited pages (Notion).
  const [queries, setQueries] = useState<string[]>(() => recentSearches());
  type Row = { kind: "new" | "note" | "query"; note?: Note; snippet?: string; query?: string; block?: string };
  const rows: Row[] = q.trim()
    ? [...results.map((r) => ({ kind: "note" as const, note: r.note, snippet: r.snippet, block: r.block })), ...(api.readOnly ? [] : [{ kind: "new" as const }])]
    : [...queries.map((s) => ({ kind: "query" as const, query: s })), ...recent.map((n) => ({ kind: "note" as const, note: n }))];
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const pick = (r: Row) => {
    if (r.kind === "query") {
      setQ(r.query ?? "");
      setActive(0);
      return;
    }
    if (q.trim()) rememberSearch(q);
    onClose();
    if (r.kind === "new") api.newPage(null, { title: q.trim() });
    else if (r.note) api.open(r.note.id, { peek: false, ...(r.block ? { block: r.block } : {}) });
  };
  const firstRecent = rows.findIndex((r) => r.kind === "note");
  const path = (n: Note) =>
    ancestry(n.id, snap.byId)
      .slice(0, -1)
      .map((x) => displayTitle(x, t("page.untitled")))
      .join(" / ");
  return (
    <Modal onClose={onClose} label={t("side.search")}>
      <div className="nt-search-head">
        <Search />
        <input
          autoFocus
          value={q}
          placeholder={t("search.placeholder", { ws })}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(rows.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && rows[active]) {
              e.preventDefault();
              pick(rows[active]);
            }
          }}
        />
        {q && (
          <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("db.clear")} onClick={() => {
            setQ("");
            setActive(0);
          }}>
            <X />
          </button>
        )}
        {/* Full-screen on phones: iOS's Cancel (hidden on larger screens). */}
        <button type="button" className="nt-search-cancel nt-btn-reset" onClick={onClose}>
          {t("common.cancel")}
        </button>
      </div>
      {q.trim() && <SearchFilters opts={opts} setOpts={(o) => (setOpts(o), setActive(0))} inPage={inPage} setInPage={(n) => (setInPage(n), setActive(0))} />}
      <div className="nt-search-list" ref={list}>
        {!q.trim() && queries.length > 0 && (
          <div className="nt-menu-label nt-search-label">
            <span>{t("search.recentSearches")}</span>
            <button type="button" className="nt-search-reset nt-btn-reset" onClick={() => (clearSearches(), setQueries([]), setActive(0))}>
              {t("search.clearRecent")}
            </button>
          </div>
        )}
        {q.trim() && results.length > 0 && <div className="nt-menu-label" style={{ order: 1 }}>{t("search.pages")}</div>}
        {rows.length === 0 && <div className="nt-panel-empty">{t("search.noResults")}</div>}
        {rows.map((r, i) => (
          <Fragment key={r.kind === "note" ? r.note!.id : r.kind === "query" ? `q:${r.query}` : r.kind}>
          {!q.trim() && i === firstRecent && <div className="nt-menu-label">{t("search.recent")}</div>}
          <div className="nt-search-row" data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => pick(r)}>
            <span className="nt-search-row-icon">{r.kind === "new" ? <Plus /> : r.kind === "query" ? <History size={16} /> : <NoteGlyph note={r.note!} />}</span>
            <div className="nt-search-row-main">
              {r.kind === "new" ? (
                <div className="nt-search-row-title">{t("search.newPage", { q: q.trim() })}</div>
              ) : r.kind === "query" ? (
                <div className="nt-search-row-title">{r.query}</div>
              ) : (
                <>
                  <div className="nt-search-row-title">
                    <Hl text={displayTitle(r.note!, t("page.untitled"))} q={q.trim()} />
                    {path(r.note!) && <span style={{ fontWeight: 400, color: "var(--nt-text-3)", fontSize: 12, marginInlineStart: 8 }}>{path(r.note!)}</span>}
                  </div>
                  {r.snippet && (
                    <div className="nt-search-row-sub">
                      <Hl text={r.snippet} q={q.trim()} />
                    </div>
                  )}
                </>
              )}
            </div>
            {r.kind === "note" && <span className="nt-search-row-meta">{relativeTime(t, locale, r.note!.updatedAt)}</span>}
            {i === active && <CornerDownLeft size={14} style={{ color: "var(--nt-text-3)", flex: "none" }} />}
          </div>
          </Fragment>
        ))}
      </div>
      <div className="nt-search-foot">
        <span>{t("search.hint")}</span>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Trash

export function TrashPanel({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const api = useNotes();
  const { t, snap, store, locale, teamspaces, user } = api;
  const [q, setQ] = useState("");
  // Notion's Trash filters: who edited it last, and where it was.
  const [editedBy, setEditedBy] = useState<string | null>(null);
  const [where, setWhere] = useState<{ key: string; name: string } | null>(null);
  const [pop, setPop] = useState<{ kind: "who" | "in"; el: HTMLElement } | null>(null);
  const everyone = useSyncExternalStore(subscribePeople, people, people);
  const trashed = useMemo(() => snap.list.filter((n) => n.trashedAt !== null), [snap.list]);
  const editors = useMemo(() => [...new Set(trashed.map((n) => n.editedBy).filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(x)))], [trashed]);
  const nameOf = (id: string) => (id === user?.id ? t("search.me") : (everyone.find((p) => p.id === id)?.name ?? "?"));
  const sections = useMemo(() => {
    const keys = new Set(trashed.map((n) => sectionOf(n, snap.byId)));
    const label = (k: string) =>
      k.startsWith("ts:") ? (teamspaces.find((ts) => `ts:${ts.id}` === k)?.name ?? t("side.teamspaces")) : k.startsWith("private") ? t("side.privateSection") : t("side.workspaceSection");
    return [...keys].map((key) => ({ key, name: label(key) }));
  }, [snap.byId, t, teamspaces, trashed]);
  const items = useMemo(
    () =>
      trashed
        .filter((n) => n.title.toLowerCase().includes(q.trim().toLowerCase()))
        .filter((n) => !editedBy || n.editedBy === editedBy)
        .filter((n) => !where || sectionOf(n, snap.byId) === where.key)
        .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)),
    [editedBy, q, snap.byId, trashed, where]
  );
  return (
    <Popover anchor={anchor} onClose={onClose} placement="right-start">
      <div className="nt-panel">
        <div className="nt-panel-head">
          <input className="nt-input" autoFocus placeholder={t("trash.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          {(editors.length > 0 || sections.length > 1) && (
            <div className="nt-trash-filters">
              {editors.length > 0 && (
                <button type="button" className="nt-db-pill nt-btn-reset" data-on={editedBy ? true : undefined} onClick={(e) => setPop({ kind: "who", el: e.currentTarget })}>
                  {editedBy ? `${t("trash.editedBy")}: ${nameOf(editedBy)}` : t("trash.editedBy")}
                  <ChevronDown />
                </button>
              )}
              {sections.length > 1 && (
                <button type="button" className="nt-db-pill nt-btn-reset" data-on={where ? true : undefined} onClick={(e) => setPop({ kind: "in", el: e.currentTarget })}>
                  {where ? t("trash.inWhere", { where: where.name }) : t("trash.inAll")}
                  <ChevronDown />
                </button>
              )}
            </div>
          )}
        </div>
        {pop && (
          <Popover anchor={pop.el} onClose={() => setPop(null)}>
            <div className="nt-menu" style={{ width: 240 }}>
              {pop.kind === "who" ? (
                <>
                  <button type="button" className="nt-mi nt-btn-reset" data-active={!editedBy || undefined} onClick={() => (setEditedBy(null), setPop(null))}>
                    <span className="nt-mi-label">{t("trash.anyone")}</span>
                  </button>
                  {editors.map((id) => (
                    <button type="button" key={id} className="nt-mi nt-btn-reset" data-active={editedBy === id || undefined} onClick={() => (setEditedBy(id), setPop(null))}>
                      <span className="nt-mi-icon">
                        <span className="nt-avatar-xs" aria-hidden="true">
                          {initials(nameOf(id))}
                        </span>
                      </span>
                      <span className="nt-mi-label">{nameOf(id)}</span>
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <button type="button" className="nt-mi nt-btn-reset" data-active={!where || undefined} onClick={() => (setWhere(null), setPop(null))}>
                    <span className="nt-mi-label">{t("trash.inAll")}</span>
                  </button>
                  {sections.map((s) => (
                    <button type="button" key={s.key} className="nt-mi nt-btn-reset" data-active={where?.key === s.key || undefined} onClick={() => (setWhere(s), setPop(null))}>
                      <span className="nt-mi-label">{s.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </Popover>
        )}
        <div className="nt-panel-list">
          {items.length === 0 && (
            <div className="nt-panel-empty">
              <Trash2 size={28} style={{ opacity: 0.4, marginBottom: 6 }} />
              <div>{t("trash.empty")}</div>
            </div>
          )}
          {items.map((n) => {
            const parent = n.parentId ? snap.byId.get(n.parentId) : undefined;
            return (
              <div key={n.id} className="nt-panel-row" onClick={() => (api.open(n.id), onClose())}>
                <span className="nt-panel-row-icon">
                  <NoteGlyph note={n} />
                </span>
                <div className="nt-panel-row-main">
                  <div className="nt-panel-row-title">{displayTitle(n, t("page.untitled"))}</div>
                  <div className="nt-panel-row-sub">
                    {parent ? t("trash.in", { where: displayTitle(parent, t("page.untitled")) }) : relativeTime(t, locale, n.trashedAt ?? n.updatedAt)}
                  </div>
                </div>
                {!api.readOnly && (
                  <>
                    <button
                      type="button"
                      className="nt-item-act nt-btn-reset"
                      title={t("trash.restore")}
                      aria-label={t("trash.restore")}
                      onClick={(e) => {
                        e.stopPropagation();
                        store.restore(n.id);
                        toast(t("toast.restored"));
                      }}
                    >
                      <Undo2 size={16} />
                    </button>
                    <button
                      type="button"
                      className="nt-item-act nt-btn-reset"
                      title={t("trash.delete")}
                      aria-label={t("trash.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(t("trash.confirm"))) {
                          store.destroy(n.id);
                          toast(t("toast.deleted"));
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="nt-panel-foot">{t("trash.hint")}</div>
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Move to

export function MovePanel({ id, anchor, onClose }: { id: string; anchor: HTMLElement; onClose: () => void }) {
  const api = useNotes();
  const { t, snap, store } = api;
  const [q, setQ] = useState("");
  const blocked = useMemo(() => new Set(subtreeIds(id, snap.list)), [id, snap.list]);
  const targets = useMemo(
    () =>
      snap.list
        .filter((n) => n.kind === "page" && !blocked.has(n.id) && !store.isTrashed(n.id) && !(n.parentId && snap.byId.get(n.parentId)?.kind === "database"))
        // Only into pages the person may edit (the server refuses the rest).
        .filter((n) => api.canEdit(n.id))
        .filter((n) => n.title.toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50),
    [api, blocked, q, snap.byId, snap.list, store]
  );
  // Top-level destinations: Private, the person's teamspaces, the workspace's pages (Notion's sections).
  const sections = useMemo(() => {
    const out: { key: string; space: string; label: string; icon: React.ReactNode }[] = [];
    if (api.user?.ws.role === "guest") return out;
    out.push({ key: "private", space: "private", label: t("side.privateSection"), icon: <LockIcon size={16} /> });
    if (!api.readOnly) for (const ts of api.teamspaces.filter((x) => x.role)) out.push({ key: ts.id, space: `ts:${ts.id}`, label: ts.name, icon: <span className="nt-cm-avatar">{ts.icon || initials(ts.name)}</span> });
    if (!api.readOnly && api.user && !api.user.ws.personal) out.push({ key: "ws", space: "", label: t("side.workspaceSection"), icon: <Users size={16} /> });
    return out;
  }, [api.readOnly, api.teamspaces, api.user, t]);
  // Other workspaces where the person may add pages (Notion's "Move to" another workspace; full access here).
  const others = useMemo(
    () => (api.levelOf(id) !== "full" ? [] : (api.user?.workspaces ?? []).filter((w) => w.id !== api.user?.ws.id && (w.role === "owner" || w.role === "editor"))),
    [api, id]
  );
  const [moving, setMoving] = useState(false);
  const moveToWorkspace = async (w: { id: string; name: string }) => {
    const user = api.user;
    if (!user || moving || !snap.byId.get(id)) return;
    if (!window.confirm(t("move.wsConfirm", { name: w.name }))) return;
    setMoving(true);
    try {
      // The server moves what it has: the device's pending edits go first.
      await api.flush();
      const r = await fetch("/api/notes/move-workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: user.ws.id, to: w.id, noteId: id }) });
      const body = (await r.json().catch(() => null)) as { id?: string } | null;
      if (!r.ok || !body?.id) {
        toast(r.status === 507 ? t("move.wsQuota") : r.status === 403 ? t("move.wsForbidden") : t("move.wsFailed"));
        return;
      }
      const to = body.id;
      toast(t("toast.moved", { where: w.name }), { label: t("move.wsOpen"), run: () => void window.open(`${location.origin}/docs?ws=${encodeURIComponent(w.id)}#${to}`, "_self") }, 8000);
      onClose();
      if (api.currentId && blocked.has(api.currentId)) api.goHome();
      api.syncNow();
    } finally {
      setMoving(false);
    }
  };
  const moveTo = (parentId: string | null, space?: { space: string; label: string }) => {
    if (!snap.byId.get(id)) return;
    api.relocate(id, parentId, null, space?.space);
    const where = parentId ? displayTitle(store.get(parentId), t("page.untitled")) : (space?.label ?? t("menu.privateRoot"));
    toast(t("toast.moved", { where }));
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} placement="right-start">
      <div className="nt-panel" style={{ width: 360 }}>
        <div className="nt-panel-head">
          <input className="nt-input" autoFocus placeholder={t("menu.moveToPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="nt-panel-list">
          {sections.map((s) => (
            <div key={s.key} className="nt-panel-row" onClick={() => moveTo(null, s)}>
              <span className="nt-panel-row-icon">{s.icon}</span>
              <div className="nt-panel-row-main">
                <div className="nt-panel-row-title">{s.label}</div>
              </div>
            </div>
          ))}
          {targets.map((n) => (
            <div key={n.id} className="nt-panel-row" onClick={() => moveTo(n.id)}>
              <span className="nt-panel-row-icon">
                <NoteGlyph note={n} />
              </span>
              <div className="nt-panel-row-main">
                <div className="nt-panel-row-title">{displayTitle(n, t("page.untitled"))}</div>
                <div className="nt-panel-row-sub">
                  {ancestry(n.id, snap.byId)
                    .slice(0, -1)
                    .map((x) => displayTitle(x, t("page.untitled")))
                    .join(" / ")}
                </div>
              </div>
            </div>
          ))}
          {others.length > 0 && !q.trim() && (
            <>
              <div className="nt-menu-label">{t("move.otherWorkspaces")}</div>
              {others.map((w) => (
                <div key={w.id} className="nt-panel-row" role="button" aria-disabled={moving} onClick={() => void moveToWorkspace(w)}>
                  <span className="nt-panel-row-icon">
                    <span className="nt-cm-avatar">{initials(w.name)}</span>
                  </span>
                  <div className="nt-panel-row-main">
                    <div className="nt-panel-row-title">{w.name}</div>
                    <div className="nt-panel-row-sub">{t("move.wsSub")}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Settings

type SettingsTab = "prefs" | "notifications" | "account" | "data" | "connections" | "keys" | "groups" | "apps";

/** Notion's "My notifications": what comes to the Inbox (lib/notes/follows.ts). */
function NotificationSettings() {
  const { t } = useNotes();
  const [prefs, setPrefs] = useState<DocsPrefs | null>(null);
  useEffect(() => {
    let live = true;
    fetchDocsPrefs().then(
      (p) => live && setPrefs(p),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);
  if (!prefs) return <p className="nt-settings-hint">{t("app.loading")}</p>;
  const flip = (k: NotifySetting) => {
    const on = prefs.muted.includes(k);
    setPrefs({ ...prefs, muted: on ? prefs.muted.filter((x) => x !== k) : [...prefs.muted, k] });
    saveDocsPrefs({ notify: { [k]: on } }).then(setPrefs, () => {
      setPrefs(prefs);
      toast(t("notify.saveFailed"));
    });
  };
  return (
    <>
      <p className="nt-settings-hint">{t("settings.notifyHint")}</p>
      {NOTIFY_SETTINGS.map((k) => (
        <div key={k} className="nt-settings-row">
          <div>
            <div>{t(`notify.${k}` as NotesKey)}</div>
            <div style={{ fontSize: 12, color: "var(--nt-text-2)" }}>{t(`notify.${k}Hint` as NotesKey)}</div>
          </div>
          <button type="button" role="switch" aria-checked={!prefs.muted.includes(k)} aria-label={t(`notify.${k}` as NotesKey)} className="nt-switch nt-btn-reset" onClick={() => flip(k)}>
            <span />
          </button>
        </div>
      ))}
      {/* Notion's e-mail notifications: what stays unread in the Inbox comes by e-mail too. */}
      <div className="nt-settings-row">
        <div>
          <div>{t("settings.emailDigest")}</div>
          <div style={{ fontSize: 12, color: "var(--nt-text-2)" }}>{t("settings.emailDigestHint")}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={prefs.emailDigest}
          aria-label={t("settings.emailDigest")}
          className="nt-switch nt-btn-reset"
          data-test="email-digest"
          onClick={() => {
            setPrefs({ ...prefs, emailDigest: !prefs.emailDigest });
            saveDocsPrefs({ emailDigest: !prefs.emailDigest }).then(setPrefs, () => {
              setPrefs(prefs);
              toast(t("notify.saveFailed"));
            });
          }}
        >
          <span />
        </button>
      </div>
    </>
  );
}

/** Every IANA time zone this browser knows. */
function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** Notion's "Time zone": the browser's (automatically), or one the person picks; reminders follow it. */
function TimeZoneSetting() {
  const { t } = useNotes();
  const [state, setState] = useState<{ tz: string; manual: boolean } | null>(null);
  const [zones] = useState(timeZones);
  useEffect(() => {
    let live = true;
    fetch("/api/notes/tz", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ tz: string; manual: boolean }>) : null))
      .then((j) => live && j && setState(j))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!state) return null;
  const browser = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const save = (tz: string, manual: boolean) => {
    const prev = state;
    setState({ tz, manual });
    fetch("/api/notes/tz", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz, manual }), credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
      })
      .catch(() => {
        setState(prev);
        toast(t("notify.saveFailed"));
      });
  };
  return (
    <>
      <div className="nt-settings-row">
        <div>
          <div>{t("settings.tzAuto")}</div>
          <div style={{ fontSize: 12, color: "var(--nt-text-2)" }}>{t("settings.timeZoneHint")}</div>
        </div>
        <button type="button" role="switch" aria-checked={!state.manual} aria-label={t("settings.tzAuto")} className="nt-switch nt-btn-reset" onClick={() => save(state.manual ? browser : state.tz, !state.manual)}>
          <span />
        </button>
      </div>
      <div className="nt-settings-row">
        <div>{t("settings.timeZone")}</div>
        <select className="nt-input nt-settings-select" aria-label={t("settings.timeZone")} disabled={!state.manual || zones.length === 0} value={state.manual ? state.tz : browser} onChange={(e) => save(e.target.value, true)}>
          {(zones.includes(state.tz) ? zones : [state.tz, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/** Notion's "Page view history" (a person's own privacy setting, kept on the server). */
function ViewHistorySetting() {
  const { t } = useNotes();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetchDocsPrefs().then(
      (p) => live && setOn(p.viewHistory),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);
  if (on === null) return null;
  return (
    <div className="nt-settings-row">
      <div>
        <div>{t("settings.viewHistory")}</div>
        <div style={{ fontSize: 12, color: "var(--nt-text-2)" }}>{t("settings.viewHistoryHint")}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t("settings.viewHistory")}
        className="nt-switch nt-btn-reset"
        onClick={() => {
          setOn(!on);
          saveDocsPrefs({ viewHistory: !on }).then(
            (p) => setOn(p.viewHistory),
            () => {
              setOn(on);
              toast(t("notify.saveFailed"));
            }
          );
        }}
      >
        <span />
      </button>
    </div>
  );
}

/** Notion's settings dialog: sections on the left, the chosen one on the right. */
export function SettingsDialog({ onClose, tab: initialTab }: { onClose: () => void; tab?: SettingsTab }) {
  const api = useNotes();
  const { t, snap, locale } = api;
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "prefs");
  const start = useOpenOnStart();
  const monday = useMondayFirst(locale);
  const count = snap.list.filter((n) => n.trashedAt === null).length;
  const who = api.user?.name || t("app.workspaceGuest");
  const nav = (key: SettingsTab, icon: ReactNode, label: string) => (
    <button type="button" key={key} className="nt-settings-nav-item nt-btn-reset" data-active={tab === key || undefined} onClick={() => setTab(key)}>
      {icon}
      <span>{label}</span>
    </button>
  );
  const [exportAll, setExportAll] = useState(false);
  if (exportAll) return <ExportDialog note={null} onClose={() => setExportAll(false)} />;
  return (
    <Modal onClose={onClose} label={t("settings.title")} className="nt-settings">
      {/* Full-screen on phones: no backdrop to tap, so a close button (hidden on larger screens). */}
      <button type="button" className="nt-settings-close nt-btn-reset" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
        <X size={18} />
      </button>
      <div className="nt-settings-layout">
        <nav className="nt-settings-nav" aria-label={t("settings.title")}>
          <div className="nt-settings-who">
            <span className="nt-ws-avatar">{who.trim().charAt(0).toUpperCase()}</span>
            <span>{who}</span>
          </div>
          {nav("prefs", <SlidersHorizontal size={16} />, t("settings.appearance"))}
          {api.user && nav("notifications", <Bell size={16} />, t("settings.notifications"))}
          {nav("account", <UserRound size={16} />, t("settings.account"))}
          {nav("data", <Download size={16} />, t("settings.data"))}
          {api.user && nav("connections", <Plug size={16} />, t("settings.connections"))}
          {api.user && !api.user.ws.personal && api.user.ws.role !== "guest" && nav("groups", <Users size={16} />, t("groups.title"))}
          {nav("keys", <Keyboard size={16} />, t("kbd.title"))}
          {nav("apps", <AppWindow size={16} />, t("settings.apps"))}
          {api.user && (
            <>
              <div className="nt-settings-nav-label">{api.user.ws.name}</div>
              <a className="nt-settings-nav-item" href={`/team?ws=${encodeURIComponent(api.user.ws.id)}`}>
                <Users size={16} />
                <span>{t("side.team")}</span>
              </a>
              {!api.readOnly && (
                <button type="button" className="nt-settings-nav-item nt-btn-reset" onClick={() => (onClose(), api.openImport())}>
                  <Upload size={16} />
                  <span>{t("side.import")}</span>
                </button>
              )}
            </>
          )}
        </nav>
        <div className="nt-settings-body">
          {tab === "prefs" && (
            <>
              <h2>{t("settings.appearance")}</h2>
              <div className="nt-settings-row">
                <div>
                  <div>{t("settings.theme")}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(
                    [
                      ["light", <Sun key="s" size={14} />, "settings.light"],
                      ["dark", <Moon key="m" size={14} />, "settings.dark"],
                      ["system", <Monitor key="c" size={14} />, "settings.system"],
                    ] as const
                  ).map(([k, icon, label]) => (
                    <button
                      type="button"
                      key={k}
                      className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset"
                      style={theme === k ? { boxShadow: "inset 0 0 0 2px var(--nt-blue)", color: "var(--nt-blue-text)" } : undefined}
                      onClick={() => {
                        setTheme(k);
                        applyTheme(k);
                      }}
                    >
                      {icon}
                      {t(label)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="nt-settings-row">
                <div>
                  <div>{t("settings.weekMonday")}</div>
                  <div style={{ fontSize: 12, color: "var(--nt-text-2)" }}>{t("settings.weekMondayHint")}</div>
                </div>
                <button type="button" role="switch" aria-checked={monday} aria-label={t("settings.weekMonday")} className="nt-switch nt-btn-reset" onClick={() => setWeekStart(monday ? "sun" : "mon")}>
                  <span />
                </button>
              </div>
              <div className="nt-settings-row">
                <div>
                  <div>{t("settings.openOnStart")}</div>
                  <div style={{ fontSize: 12, color: "var(--nt-text-2)" }}>{t("settings.openOnStartHint")}</div>
                </div>
                <select className="nt-input nt-settings-select" aria-label={t("settings.openOnStart")} value={start} onChange={(e) => setOpenOnStart(e.target.value as OpenOnStart)}>
                  <option value="last">{t("settings.openLast")}</option>
                  <option value="home">{t("settings.openHome")}</option>
                  <option value="top">{t("settings.openTop")}</option>
                </select>
              </div>
              {api.user && (
                <>
                  <TimeZoneSetting />
                  <h2 style={{ marginTop: 24 }}>{t("settings.privacy")}</h2>
                  <ViewHistorySetting />
                </>
              )}
            </>
          )}
          {tab === "notifications" && api.user && (
            <>
              <h2>{t("settings.notifications")}</h2>
              <NotificationSettings />
            </>
          )}
          {tab === "account" && (
            <>
              <h2>{t("settings.account")}</h2>
              <div className="nt-settings-row">
                <p style={{ fontSize: 14, color: "var(--nt-text)" }}>{api.user ? t("settings.signedInAs", { email: api.user.name }) : t("settings.guest")}</p>
                {api.user === null ? (
                  <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" onClick={api.signIn}>
                    {t("settings.signIn")}
                  </button>
                ) : (
                  <a className="nt-btn nt-btn-plain nt-btn-sm" href="/settings">
                    {t("side.account")}
                  </a>
                )}
              </div>
            </>
          )}
          {tab === "data" && (
            <>
              <h2>{t("settings.data")}</h2>
              <div className="nt-settings-row">
                <p style={{ fontSize: 14, color: "var(--nt-text)" }}>{t("settings.storage", { n: count })}</p>
                {!api.user?.ws.noExport && (
                  <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={() => setExportAll(true)}>
                    <Download size={14} />
                    {t("settings.exportAll")}
                  </button>
                )}
              </div>
            </>
          )}
          {tab === "apps" && <AppsSettings />}
          {tab === "connections" && api.user && (
            <>
              <h2>{t("settings.connections")}</h2>
              <IntegrationsPanel />
            </>
          )}
          {tab === "groups" && api.user && (
            <>
              <h2>{t("groups.title")}</h2>
              <GroupsPanel />
            </>
          )}
          {tab === "keys" && (
            <>
              <h2>{t("kbd.title")}</h2>
              <Shortcuts />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Notion's keyboard shortcuts, as they work here. */
function Shortcuts() {
  const { t } = useNotes();
  // zvena's keycaps (components/zvena/ds Kbd: it shows ⌘ ⌥ ⇧ on a Mac, Ctrl Alt Shift elsewhere).
  const rows = NOTES_SHORTCUTS.map(([label, keys]) => [label, keys.map((k) => shortcutKey(k, true))] as const);
  return (
    <div className="nt-kbd-list">
      {rows.map(([label, keys]) => (
        <div key={label} className="nt-kbd-row">
          <span>{t(label)}</span>
          <Kbd keys={keys} className="nt-kbd-keys" />
        </div>
      ))}
    </div>
  );
}


