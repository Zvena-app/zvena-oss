"use client";

// A page as Notion lays it out: cover, icon, "Add icon / Add cover" on
// hover, the big title, database-row properties, then the body (editor) or
// a full-page database. Also renders inside the side peek.

import { withWs } from "@/lib/notes/workspace";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, Smile, Table2, LayoutTemplate, Download, KanbanSquare, CornerDownRight, FileText, MessageSquare, Link2 } from "lucide-react";
import { openLinkPicker, Related } from "@/components/eco/Related";
import { et } from "@/components/eco/i18n";
import { useNotes } from "./context";
import type { EditorHandle } from "./Editor";
import { StaticBlocks } from "./StaticBlocks";
import { EmojiPicker, randomIcon } from "./EmojiPicker";
import { Popover, cx } from "./ui";
import { COVER_BG, coverCss } from "./cover";
import { databasePart, editorPart, lazyComponent } from "./lazy";
import { Comments } from "./Comments";
import { blankSchema, defaultView, displayTitle, outlineOf, shortId, STATUS_OPTIONS } from "@/lib/notes/model";
import type { NotesKey } from "@/lib/notes/i18n";
import type { Note, NoteCover } from "@/lib/notes/types";
import { NoteIcon } from "./NoteIcon";
import type { CollabProvider } from "@/lib/notes/collab-client";
import { useCollab } from "./collab";
import { useSuggesting } from "./suggest-mode";
import { useBlockLink } from "./block-link";
import type { SuggestMode } from "./suggest";

// The editor loads as its own part right after the workspace's first chunk;
// until it arrives the page reads as static text in the same layout.
if (typeof window !== "undefined") editorPart.load().catch(() => {});

type NoteEditorProps = { note: Note; readOnly?: boolean; onTitleFocusRequest?: () => void; embedded?: boolean; collab?: CollabProvider | null; canComment?: boolean; suggest?: SuggestMode };

const NoteEditor = forwardRef<EditorHandle, NoteEditorProps>(function NoteEditor(props, ref) {
  const m = editorPart.use();
  if (!m) return <StaticBlocks content={props.note.content} />;
  const Editor = m.NoteEditor;
  return <Editor {...props} ref={ref} />;
});

// The database code loads after the page; a full-page database keeps its
// room meanwhile so nothing jumps.
const DatabaseView = lazyComponent(databasePart, (m) => m.DatabaseView, <div className="nt-db-wait" aria-busy="true" />);
const RowProps = lazyComponent(databasePart, (m) => m.RowProps);
const RowHeaderProps = lazyComponent(databasePart, (m) => m.RowHeaderProps);
const VerifyBar = lazyComponent(databasePart, (m) => m.VerifyBar);

// ---------------------------------------------------------------------------
// Cover

const COVER_COLORS = ["red", "yellow", "blue", "green", "purple", "pink", "orange", "gray"];
const COVER_GRADIENTS = Object.keys(COVER_BG).filter((k) => k.startsWith("g-"));

function CoverPicker({ anchor, onClose, onPick, onRemove }: { anchor: HTMLElement | null; onClose: () => void; onPick: (c: NoteCover) => void; onRemove: () => void }) {
  const { t, upload } = useNotes();
  const [tab, setTab] = useState<"gallery" | "upload" | "link">("gallery");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end">
      <div className="nt-coverpick">
        <div className="nt-emoji-tabs">
          {(["gallery", "upload", "link"] as const).map((k) => (
            <button type="button" key={k} className="nt-emoji-tab nt-btn-reset" data-active={tab === k || undefined} onClick={() => setTab(k)}>
              {t(`cover.${k}`)}
            </button>
          ))}
          <span className="nt-emoji-tab-spacer" />
          <button type="button" className="nt-emoji-tab nt-btn-reset" onClick={onRemove}>
            {t("cover.remove")}
          </button>
        </div>
        <div className="nt-coverpick-body">
          {tab === "gallery" && (
            <>
              <div className="nt-menu-label" style={{ padding: "0 2px" }}>
                {t("cover.colors")}
              </div>
              <div className="nt-cover-grid">
                {[...COVER_GRADIENTS, ...COVER_COLORS].map((k) => (
                  <button type="button" key={k} className="nt-cover-swatch nt-btn-reset" style={{ background: coverCss(k) }} onClick={() => onPick({ kind: k.startsWith("g-") ? "gradient" : "color", value: k, y: 50 })} />
                ))}
              </div>
            </>
          )}
          {tab === "upload" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "16px 0" }}>
              <input
                ref={file}
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setBusy(true);
                  try {
                    const url = await upload(f);
                    onPick({ kind: "image", value: url, y: 50 });
                  } catch {
                    // upload() already told the user
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <button type="button" className="nt-btn nt-btn-plain nt-btn-reset" style={{ width: "100%" }} disabled={busy} onClick={() => file.current?.click()}>
                {busy ? "…" : t("cover.uploadBtn")}
              </button>
              <div style={{ fontSize: 12, color: "var(--nt-text-3)" }}>{t("cover.uploadHint")}</div>
            </div>
          )}
          {tab === "link" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 0" }}>
              <input className="nt-input" autoFocus placeholder={t("cover.linkPlaceholder")} value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === "Enter" && /^https:\/\//.test(link) && onPick({ kind: "image", value: link.trim(), y: 50 })} />
              <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" disabled={!/^https:\/\//.test(link.trim())} onClick={() => onPick({ kind: "image", value: link.trim(), y: 50 })}>
                {t("cover.submit")}
              </button>
            </div>
          )}
        </div>
      </div>
    </Popover>
  );
}

function Cover({ note, readOnly }: { note: Note; readOnly: boolean }) {
  const { t, store } = useNotes();
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [reposition, setReposition] = useState(false);
  // The position being dragged; the saved one shows otherwise.
  const [dragY, setY] = useState<number | null>(null);
  const y = dragY ?? note.cover?.y ?? 50;
  const ref = useRef<HTMLDivElement>(null);
  if (!note.cover) return null;
  const c = note.cover;
  const onDown = (e: React.PointerEvent) => {
    if (!reposition) return;
    e.preventDefault();
    const startY = e.clientY;
    const start = y;
    const h = ref.current?.offsetHeight ?? 200;
    const move = (ev: PointerEvent) => setY(Math.max(0, Math.min(100, start - ((ev.clientY - startY) / h) * 100)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={ref} className="nt-cover" data-repositioning={reposition || undefined} onPointerDown={onDown} style={c.kind === "image" ? undefined : { background: coverCss(c.value) }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the cover is a workspace file or a URL the person pasted, any size; repositioned with object-position */}
      {c.kind === "image" && <img src={c.value} alt="" style={{ objectPosition: `center ${y}%` }} draggable={false} />}
      {reposition && <div className="nt-cover-hint">{t("page.reposition")}</div>}
      {!readOnly && (
        <div className="nt-cover-actions">
          {reposition ? (
            <>
              <button
                type="button"
                className="nt-btn-reset"
                onClick={() => {
                  store.update(note.id, { cover: { ...c, y } });
                  setY(null);
                  setReposition(false);
                }}
              >
                {t("page.savePosition")}
              </button>
              <button
                type="button"
                className="nt-btn-reset"
                onClick={() => {
                  setY(null);
                  setReposition(false);
                }}
              >
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="nt-btn-reset" onClick={(e) => setPicker(e.currentTarget)}>
                {t("page.changeCover")}
              </button>
              {c.kind === "image" && (
                <button type="button" className="nt-btn-reset" onClick={() => setReposition(true)}>
                  {t("page.reposition")}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {picker && (
        <CoverPicker
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(cv) => {
            store.update(note.id, { cover: cv });
            setPicker(null);
          }}
          onRemove={() => {
            store.update(note.id, { cover: null });
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Title

function Title({ note, readOnly, onEnter, focusRef }: { note: Note; readOnly: boolean; onEnter: () => void; focusRef: React.MutableRefObject<(() => void) | null> }) {
  const { t, store } = useNotes();
  const [v, setV] = useState(note.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setV(note.title);
  }, [note.title]);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [v]);
  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    focusRef.current = () => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    };
  }, [focusRef]);
  const flush = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value !== store.get(note.id)?.title) store.update(note.id, { title: value });
  };
  return (
    <textarea
      ref={ref}
      className="nt-title"
      rows={1}
      value={v}
      readOnly={readOnly}
      placeholder={note.kind === "database" ? t("db.untitled") : t("page.newPage")}
      spellCheck
      onFocus={() => (editing.current = true)}
      onBlur={() => {
        editing.current = false;
        flush(v);
      }}
      onChange={(e) => {
        const val = e.target.value.replace(/\n/g, "");
        setV(val);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(val), 400);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || (e.key === "ArrowDown" && ref.current && ref.current.selectionStart === ref.current.value.length)) {
          e.preventDefault();
          flush(v);
          onEnter();
        }
      }}
      style={{ whiteSpace: "pre-wrap" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Empty-page starters ("Get started with")

function Starters({ note }: { note: Note }) {
  const api = useNotes();
  const { t } = api;
  const toDb = (view: "table" | "board") => {
    // Notion turns the empty page itself into a database (links to it stay).
    const schema = blankSchema({ name: t("db.name"), tags: t("db.tags"), table: t("db.table") });
    if (view === "board") {
      schema.properties.push({ id: shortId(), name: t("db.status"), type: "status", options: STATUS_OPTIONS.map((o) => ({ ...o, name: t(`status.${o.id}` as NotesKey) })) });
      schema.views = [defaultView("board", t("db.board"), schema)];
    }
    api.store.update(note.id, { kind: "database", db: schema, content: [] });
  };
  return (
    <div className="nt-empty-start">
      <div className="nt-empty-start-title">{t("page.getStarted")}</div>
      <div className="nt-empty-chips">
        <button type="button" className="nt-chip nt-btn-reset" onClick={() => toDb("table")}>
          <Table2 />
          {t("db.table")}
        </button>
        <button type="button" className="nt-chip nt-btn-reset" onClick={() => toDb("board")}>
          <KanbanSquare />
          {t("db.board")}
        </button>
        <button type="button" className="nt-chip nt-btn-reset" onClick={api.openTemplates}>
          <LayoutTemplate />
          {t("page.emptyTemplates")}
        </button>
        <button type="button" className="nt-chip nt-btn-reset" onClick={api.openImport}>
          <Download />
          {t("page.emptyImport")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backlinks: pages that mention or link this one (not the parent's own
// sub-page block). Each note's outgoing references are cached by version.

const refCache = new Map<string, { at: number; refs: Set<string> }>();

function refsOf(n: Note): Set<string> {
  const hit = refCache.get(n.id);
  if (hit && hit.at === n.updatedAt) return hit.refs;
  const refs = new Set<string>();
  const walk = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const raw of blocks) {
      const b = raw as { type?: string; props?: { noteId?: string }; content?: unknown; children?: unknown; href?: string };
      if (!b || typeof b !== "object") continue;
      if (b.type === "mention" && b.props?.noteId) refs.add(b.props.noteId);
      if (b.type === "page" && b.props?.noteId) refs.add(`page:${b.props.noteId}`);
      if (b.type === "link" && typeof b.href === "string") {
        const m = /([0-9a-f]{32})/.exec(b.href);
        if (m && /\/(docs|notes)(\?[^#]*)?#/.test(b.href)) refs.add(m[1]);
      }
      walk(b.content);
      walk(b.children);
    }
  };
  walk(n.content);
  refCache.set(n.id, { at: n.updatedAt, refs });
  return refs;
}

function Backlinks({ note }: { note: Note }) {
  const api = useNotes();
  const { t, snap, store } = api;
  const mode = note.style?.backlinks;
  const [toggled, setOpen] = useState(false);
  const open = toggled || mode === "expanded";
  const list = useMemo(
    () =>
      snap.list.filter((n) => {
        if (n.id === note.id || store.isTrashed(n.id)) return false;
        const refs = refsOf(n);
        return refs.has(note.id) || (refs.has(`page:${note.id}`) && note.parentId !== n.id);
      }),
    [note.id, note.parentId, snap.list, store]
  );
  if (list.length === 0 || mode === "off") return null;
  return (
    <div className="nt-backlinks" data-mode={mode}>
      <button type="button" className="nt-backlinks-btn nt-btn-reset" disabled={mode === "expanded"} onClick={() => setOpen((v) => !v)}>
        <CornerDownRight />
        {list.length === 1 ? t("backlinks.one") : t("backlinks.count", { n: list.length })}
      </button>
      {open && (
        <div className="nt-backlinks-list">
          {list.map((n) => (
            <button type="button" key={n.id} className="nt-pageblock nt-btn-reset" onClick={() => api.open(n.id)}>
              <span className="nt-pageblock-icon"><NoteIcon icon={n.icon} fallback={<FileText strokeWidth={1.6} />} /></span>
              <span className="nt-pageblock-title">{n.title || t("page.untitled")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating outline (Notion): marks at the page's right edge for its headings,
// the list on hover; the heading being read is marked.

function PageOutline({ note }: { note: Note }) {
  const { t } = useNotes();
  const heads = useMemo(() => outlineOf(note.content), [note.content]);
  const [active, setActive] = useState<string | null>(null);
  const many = heads.length >= 3;
  useEffect(() => {
    if (!many) return;
    const scroller = document.querySelector(".nt-scroller");
    if (!scroller) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      // At the very bottom the last headings can't reach the top: the last one on screen counts.
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      const line = atEnd ? scroller.getBoundingClientRect().bottom - 40 : 160;
      let cur: string | null = null;
      for (const h of heads) {
        const el = document.querySelector(`.nt-editor [data-id="${CSS.escape(h.id)}"]`);
        if (el && el.getBoundingClientRect().top < line) cur = h.id;
      }
      setActive(cur ?? heads[0]?.id ?? null);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [heads, many]);
  if (!many) return null;
  const go = (id: string) => document.querySelector(`.nt-editor [data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <nav className="nt-outline" aria-label={t("outline.label")}>
      <div className="nt-outline-inner">
        <div className="nt-outline-marks" aria-hidden="true">
          {heads.map((h) => (
            <span key={h.id} data-level={h.level} data-active={h.id === active || undefined} />
          ))}
        </div>
        <div className="nt-outline-list">
          {heads.map((h) => (
            <button key={h.id} type="button" className="nt-btn-reset" data-level={h.level} data-active={h.id === active || undefined} onClick={() => go(h.id)}>
              {h.text || t("page.untitled")}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}

function isEmptyBody(content: unknown[]): boolean {
  if (content.length === 0) return true;
  if (content.length > 1) return false;
  const b = content[0] as { type?: string; content?: unknown[]; children?: unknown[] };
  return b?.type === "paragraph" && (!b.content || b.content.length === 0) && (!b.children || b.children.length === 0);
}

// ---------------------------------------------------------------------------
// zvena: who else is editing this document (heartbeat every 30 s), and the
// configurable limit of editors at once (app/api/notes/presence).

function usePresence(noteId: string, off: boolean): { others: string[]; full: boolean; limit: number } {
  const api = useNotes();
  const [state, setState] = useState<{ others: string[]; full: boolean; limit: number }>({ others: [], full: false, limit: 0 });
  useEffect(() => {
    if (off || !api.user) return;
    let live = true;
    const beat = (leave = false) =>
      fetch(withWs("/api/notes/presence"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ noteId, leave }), keepalive: leave })
        .then((r) => (r.ok ? (r.json() as Promise<{ others: string[]; full: boolean; limit: number }>) : null))
        .then((s) => {
          if (live && s && !leave) setState(s);
        })
        .catch(() => undefined);
    void beat();
    const id = setInterval(() => document.visibilityState === "visible" && void beat(), 30_000);
    return () => {
      live = false;
      clearInterval(id);
      void beat(true);
    };
  }, [noteId, off, api.user]);
  return state;
}

const DOC_RELATED = ["issue", "project", "design"] as const;

export function PageView({ note, peek }: { note: Note; peek?: boolean }) {
  const api = useNotes();
  const { t, store } = api;
  // zvena: a viewer or commenter, or a newcomer to a document that already
  // has the maximum of editors at once, reads only.
  // A sub-page of a trashed page is in the trash too (only the root carries trashedAt).
  const trashed = store.isTrashed(note.id);
  // The person's level on this very page (a share can open one page to a viewer or a guest).
  const level = api.levelOf(note.id);
  const canEditPage = level === "full" || level === "edit";
  // Members edit a page together live (components/notes/collab.tsx); the
  // session also enforces the editors limit, so the heartbeat runs only without one.
  const collab = useCollab(note, Boolean(api.user) && note.kind === "page" && !trashed);
  const inSession = collab.mode === "connecting" || collab.mode === "live";
  const presence = usePresence(note.id, peek || !canEditPage || trashed || inSession);
  const full = presence.full || Boolean(collab.init?.full);
  const limit = presence.full ? presence.limit : (collab.init?.limit ?? 0);
  const readOnly = Boolean(note.style?.locked) || trashed || !canEditPage || full || (collab.mode === "live" && !collab.canEdit);
  // Comments stay open on locked pages and to commenters (Notion), never in the trash
  // nor past the editors limit (a comment saves the whole note, over the others' edits).
  const canComment = (canEditPage || level === "comment") && !trashed && !full && note.style?.comments !== "off";
  // Suggested edits (Notion): someone who may only comment always suggests; an editor when they switch to it.
  // Signed-in people only (a suggestion is signed); never on a locked page.
  const suggesting = useSuggesting(note.id);
  const mayOnlyComment = level === "comment" && canComment && Boolean(api.user) && !note.style?.locked && (collab.mode !== "live" || Boolean(collab.provider?.canComment));
  const suggest: SuggestMode = mayOnlyComment ? "only" : suggesting && !readOnly && Boolean(api.user) ? "on" : "off";
  const [iconPick, setIconPick] = useState<HTMLElement | null>(null);
  const [commenting, setCommenting] = useState(false);
  // A link to one of its blocks: scrolled to and highlighted once the editor shows it.
  useBlockLink(note.id);
  // zvena's ecosystem: what this page is linked with in Projects and Design
  // (pages linking pages stay in Backlinks). Workspace documents only.
  // "Related" across products is the workspace's: members only (a guest sees just the pages shared with them).
  const ecoWs = api.user && api.user.ws.role !== "guest" && !note.template && !note.synced ? api.user.ws.id : "";
  const editorRef = useRef<EditorHandle>(null);
  const titleFocus = useRef<(() => void) | null>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const isRow = Boolean(note.parentId && api.snap.byId.get(note.parentId)?.kind === "database");
  // A page in a wiki: its verification under the title (Notion).
  const inWiki = isRow && Boolean(api.snap.byId.get(note.parentId ?? "")?.db?.wiki?.verification);
  // The database's page layout may put the property panel beside the body.
  const sidePanel = isRow && api.snap.byId.get(note.parentId ?? "")?.db?.layout?.panel === "side";
  const [showStarters, setShowStarters] = useState(() => note.kind === "page" && !isRow && isEmptyBody(note.content) && Date.now() - note.createdAt < 60_000);
  // Once the page has a body the starters are gone for good, as in Notion.
  if (showStarters && !isEmptyBody(note.content)) setShowStarters(false);

  // New pages start in the title (Notion).
  useEffect(() => {
    if (!readOnly && !note.title && Date.now() - note.createdAt < 4000) setTimeout(() => titleFocus.current?.(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  // Enter in the title before the editor is there (a live session still connecting shows the page
  // as saved): the title lets go at once, what is typed meanwhile is kept and lands in the body.
  const pendingBody = useRef<{ text: string; until: number } | null>(null);
  const stopPending = useRef<(() => void) | null>(null);
  const focusBody = useCallback(() => {
    setShowStarters(false);
    // The editor took the caret: its view is in the page and the focus is inside it now (focus is synchronous).
    const focused = () => {
      const ed = editorRef.current;
      const dom = ed?.editor?.domElement;
      if (!ed || !dom?.isConnected) return false;
      ed.focusStart();
      return dom.contains(document.activeElement);
    };
    if (focused()) return;
    stopPending.current?.();
    pendingBody.current = { text: "", until: Date.now() + 8000 };
    (document.activeElement as HTMLElement | null)?.blur();
    const onKey = (e: KeyboardEvent) => {
      const p = pendingBody.current;
      if (!p || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      // Typing somewhere else meanwhile (search, a comment, a field) is theirs: the wait for the body ends.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) {
        stop();
        return;
      }
      if (e.key.length === 1) p.text += e.key;
      else if (e.key === "Backspace") p.text = p.text.slice(0, -1);
      else return;
      e.preventDefault();
    };
    const stop = () => {
      clearInterval(tick);
      window.removeEventListener("keydown", onKey, true);
      pendingBody.current = null;
      stopPending.current = null;
    };
    window.addEventListener("keydown", onKey, true);
    const tick = setInterval(() => {
      const p = pendingBody.current;
      if (!p || Date.now() > p.until) return stop();
      // Not an editor object alone: its view mounted and holding the caret.
      if (!focused()) return;
      stop();
      if (p.text) editorRef.current?.editor?.insertInlineContent(p.text);
    }, 40);
    stopPending.current = stop;
  }, []);
  // Another page, or this one closed: nothing waits for its body any more.
  useEffect(() => () => stopPending.current?.(), [note.id]);



  return (
    <div
      className="nt-page"
      data-cover={note.cover ? "true" : "false"}
      data-noicon={note.icon ? "false" : "true"}
      data-full={note.style?.full || note.kind === "database" || undefined}
      data-font={note.style?.font ?? "default"}
      data-small={note.style?.small || undefined}
    >
      {!peek && note.kind === "page" && <PageOutline note={note} />}
      {note.template && <div className="nt-tpl-banner">{t("db.templateBanner", { db: displayTitle(api.snap.byId.get(note.parentId ?? "") ?? note, t("db.untitled")) })}</div>}
      <Cover note={note} readOnly={readOnly} />
      <div className="nt-head">
        <div className="nt-head-pad">
          {note.icon && (
            <div ref={iconRef} className="nt-page-icon" role="button" aria-label={t("page.addIcon")} onClick={(e) => !readOnly && setIconPick(e.currentTarget)}>
              <span><NoteIcon icon={note.icon} /></span>
            </div>
          )}
          {(!readOnly || canComment) && (
            <div className="nt-head-controls">
              {!readOnly && !note.icon && (
                <button type="button" className="nt-btn-reset" onClick={() => store.update(note.id, { icon: randomIcon() })}>
                  <Smile />
                  {t("page.addIcon")}
                </button>
              )}
              {!readOnly && !note.cover && (
                <button type="button" className="nt-btn-reset" onClick={() => store.update(note.id, { cover: { kind: "gradient", value: COVER_GRADIENTS[Math.floor(Math.random() * COVER_GRADIENTS.length)], y: 50 } })}>
                  <ImageIcon />
                  {t("page.addCover")}
                </button>
              )}
              {canComment && !(note.comments ?? []).some((c) => !c.thread) && (
                <button type="button" className="nt-btn-reset" onClick={() => setCommenting(true)}>
                  <MessageSquare />
                  {t("page.addComment")}
                </button>
              )}
              {ecoWs && !readOnly && (
                <button type="button" className="nt-btn-reset" onClick={(e) => openLinkPicker(`note:${note.id}`, e.currentTarget)}>
                  <Link2 />
                  {et("link")}
                </button>
              )}
            </div>
          )}
          <Title note={note} readOnly={readOnly} onEnter={focusBody} focusRef={titleFocus} />
          {isRow && <RowHeaderProps row={note} readOnly={readOnly} />}
          {inWiki && <VerifyBar row={note} readOnly={Boolean(note.style?.locked) || trashed || full} />}
          <Backlinks note={note} />
          {ecoWs && <Related ws={ecoWs} refKey={`note:${note.id}`} kinds={DOC_RELATED} collapsible defaultOpen={false} hideWhenEmpty incomingOnly canEdit={!readOnly} />}
          {canComment && <Comments note={note} active={commenting} onActive={setCommenting} />}
          {(full || presence.others.length > 0) && (
            <div className="nt-presence" role="status">
              {full ? t("presence.full", { n: limit }) : t("presence.editing", { names: presence.others.join(", ") })}
            </div>
          )}
        </div>
      </div>
      <div className={cx("nt-body")}>
        {isRow && !sidePanel && (
          <div style={{ padding: "0 8px" }}>
            <RowProps row={note} readOnly={readOnly} />
          </div>
        )}
        {note.kind === "database" ? (
          <>
            {/* A wiki keeps a body above its pages (a page turned into a wiki keeps what it said). */}
            {(note.db?.wiki || !isEmptyBody(note.content)) && <NoteEditor key={note.id} ref={editorRef} note={note} readOnly={readOnly} canComment={canComment} suggest={suggest} onTitleFocusRequest={() => titleFocus.current?.()} />}
            <div style={{ padding: "8px 0 0" }}>
              <DatabaseView dbId={note.id} />
            </div>
          </>
        ) : sidePanel ? (
          <div className="nt-row-split">
            <div className="nt-row-main">
              {showStarters && !readOnly && <Starters note={note} />}
              <NoteEditor key={note.id} ref={editorRef} note={note} readOnly={readOnly} canComment={canComment} suggest={suggest} onTitleFocusRequest={() => titleFocus.current?.()} />
            </div>
            <aside className="nt-row-aside">
              <RowProps row={note} readOnly={readOnly} side />
            </aside>
          </div>
        ) : (
          <>
            {showStarters && !readOnly && <Starters note={note} />}
            {collab.mode === "connecting" ? (
              // The session answers within moments; until then the page reads as it was saved.
              <StaticBlocks content={note.content} />
            ) : (
              <NoteEditor
                key={collab.mode === "live" ? `${note.id}:live` : note.id}
                ref={editorRef}
                note={note}
                readOnly={readOnly}
                canComment={canComment}
                suggest={suggest}
                collab={collab.mode === "live" ? collab.provider : null}
                onTitleFocusRequest={() => titleFocus.current?.()}
              />
            )}
          </>
        )}
      </div>
      {iconPick && (
        <Popover anchor={iconPick} onClose={() => setIconPick(null)}>
          <EmojiPicker
            onPick={(e) => {
              store.update(note.id, { icon: e });
              setIconPick(null);
            }}
            onRemove={() => {
              store.update(note.id, { icon: "" });
              setIconPick(null);
            }}
          />
        </Popover>
      )}
      {peek && <div style={{ height: 40 }} />}
    </div>
  );
}
