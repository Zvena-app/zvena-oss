"use client";

// Custom BlockNote blocks and inline content for zvena Documents: callout,
// sub-page, inline database, table of contents, block/inline equation, web
// bookmark, embed, Mermaid diagram, and page/date mentions.

import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BlockNoteSchema, createCodeBlockSpec, createStyleSpec, defaultBlockSpecs, defaultInlineContentSpecs, defaultProps, defaultStyleSpecs } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec, createReactStyleSpec } from "@blocknote/react";
import { DesignBlock } from "./design";
import { PdfBlock } from "./pdf";
import { CustomEmojiInline } from "./custom-emoji-inline";
import { LinkMentionInline } from "./link-mention";
import { IssueBlock } from "@/components/eco/IssueBlock";
import { IssuesBlock } from "@/components/eco/IssuesBlock";
import { AlarmClock, ArrowUpRight, Copy, Link2, RefreshCw, Sigma, Globe, Unlink, Workflow, FileText } from "lucide-react";
import { PageIdContext, ReadOnlyContext, useNotesMaybe } from "./context";
import { EmojiPicker } from "./EmojiPicker";
import { Popover, toast } from "./ui";
import { ColumnBlock, ColumnListBlock } from "./columns";
import { TabBlock, TabsBlock } from "./tabs";
import { ButtonBlock } from "./button";
import { databasePart, lazyComponent } from "./lazy";
import { ancestry, displayTitle, iconText, inlineText, syncedIds, withoutBlockIds } from "@/lib/notes/model";
import { localYmd } from "@/lib/notes/dates";
import { dateTimePart } from "@/lib/notes/reminders";
import { people, personById, subscribePeople } from "@/lib/notes/people";
import type { Note } from "@/lib/notes/types";
import { NoteIcon } from "./NoteIcon";
import { intlOf, nearDay } from "@/i18n/locales";
import { notesT } from "@/lib/notes/i18n";

// The date picker comes with the database code, on first use.
const DateEditor = lazyComponent(databasePart, (m) => m.DateEditor);

// ---------------------------------------------------------------------------
// Helpers shared by blocks

function useNoteLookup(): { get: (id: string) => Note | undefined; open: (id: string) => void; readOnly: boolean; untitled: string; trashed: (id: string) => boolean } {
  const ctx = useNotesMaybe();
  const ro = useContext(ReadOnlyContext);
  return useMemo(() => {
    if (ctx && !ro.readOnly) {
      return {
        get: (id: string) => ctx.snap.byId.get(id),
        open: (id: string) => ctx.open(id),
        readOnly: false,
        untitled: ctx.t("page.untitled"),
        trashed: (id: string) => ctx.store.isTrashed(id),
      };
    }
    return {
      get: (id: string) => ro.notes?.get(id),
      open: (id: string) => ro.openPublic?.(id),
      readOnly: true,
      untitled: ctx?.t("page.untitled") ?? "Untitled",
      trashed: () => false,
    };
  }, [ctx, ro]);
}

let katexPromise: Promise<typeof import("katex")> | null = null;
function loadKatex() {
  katexPromise ??= import("katex");
  return katexPromise;
}

function Katex({ latex, display }: { latex: string; display: boolean }) {
  const [html, setHtml] = useState<string>("");
  const [err, setErr] = useState<string>("");
  useEffect(() => {
    let live = true;
    void loadKatex().then((k) => {
      if (!live) return;
      try {
        const render = (k.default ?? k).renderToString;
        setHtml(render(latex, { displayMode: display, throwOnError: true, output: "html" }));
        setErr("");
      } catch (e) {
        setErr(e instanceof Error ? e.message.replace(/^KaTeX parse error: /, "") : "Invalid equation");
      }
    });
    return () => {
      live = false;
    };
  }, [latex, display]);
  if (err) return <span className="nt-equation-error">{err}</span>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------------------------------------------------------------------------
// Callout

function CalloutIcon({ icon, onChange, readOnly }: { icon: string; onChange: (icon: string) => void; readOnly: boolean }) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  return (
    <>
      <div className="nt-callout-icon" contentEditable={false} onClick={(e) => !readOnly && setOpen(e.currentTarget)}>
        <NoteIcon icon={icon} fallback="💡" />
      </div>
      {open && (
        <Popover anchor={open} onClose={() => setOpen(null)}>
          <EmojiPicker
            onPick={(e) => {
              onChange(e);
              setOpen(null);
            }}
            onRemove={() => {
              onChange("💡");
              setOpen(null);
            }}
          />
        </Popover>
      )}
    </>
  );
}

export const CalloutBlock = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      textColor: defaultProps.textColor,
      icon: { default: "💡" },
      color: { default: "default" },
    },
    content: "inline",
  },
  {
    render: function CalloutRender(props) {
      const ro = useContext(ReadOnlyContext);
      return (
        <div className="nt-callout" data-color={props.block.props.color}>
          <CalloutIcon icon={props.block.props.icon} readOnly={ro.readOnly || !props.editor.isEditable} onChange={(icon) => props.editor.updateBlock(props.block, { props: { icon } })} />
          <div className="nt-callout-body" ref={props.contentRef} />
        </div>
      );
    },
    toExternalHTML: function CalloutHtml(props) {
      return (
        <div data-callout={props.block.props.icon} style={{ display: "flex", gap: 8, padding: 16, borderRadius: 6, background: "rgb(241,241,239)" }}>
          <span>{iconText(props.block.props.icon) || "💡"}</span>
          <div ref={props.contentRef} />
        </div>
      );
    },
  }
);

// ---------------------------------------------------------------------------
// Sub-page (a page living inside this page)

function PageLink({ noteId }: { noteId: string }) {
  const look = useNoteLookup();
  const note = look.get(noteId);
  const gone = !note || look.trashed(noteId);
  const isDb = note?.kind === "database";
  return (
    <div
      className="nt-pageblock"
      contentEditable={false}
      data-gone={gone || undefined}
      role="link"
      tabIndex={-1}
      onClick={() => {
        if (note && !gone) look.open(noteId);
      }}
    >
      <span className="nt-pageblock-icon"><NoteIcon icon={note?.icon} fallback={isDb ? <TableGlyph /> : <FileText strokeWidth={1.6} />} /></span>
      <span className="nt-pageblock-title">{note ? displayTitle(note, look.untitled) : "—"}</span>
    </div>
  );
}

function TableGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3 8h14M8 8v8" />
    </svg>
  );
}

export const PageBlock = createReactBlockSpec(
  { type: "page", propSchema: { noteId: { default: "" } }, content: "none" },
  {
    render: (props) => <PageLink noteId={props.block.props.noteId} />,
    toExternalHTML: function PageHtml(props) {
      return <p data-note-page={props.block.props.noteId}>↗ {props.block.props.noteId}</p>;
    },
  }
);

// ---------------------------------------------------------------------------
// Inline database (rendered by the database view; registered at runtime to
// avoid an import cycle with the editor)

// A linked view block ("Linked view of database") has a `view` scope id and
// starts with no database: the renderer then offers a picker (`onPick`).
type DbRenderer = (props: { dbId: string; scope?: string; onPick?: (dbId: string) => void }) => React.ReactNode;
let dbRenderer: DbRenderer | null = null;
// Blocks already on screen re-render once a renderer registers (the editor
// loads the database view lazily, after a reloaded page's first render).
const rendererListeners = new Set<() => void>();
const subscribeRenderers = (l: () => void) => {
  rendererListeners.add(l);
  return () => {
    rendererListeners.delete(l);
  };
};
export function registerDbRenderer(r: DbRenderer): void {
  dbRenderer = r;
  rendererListeners.forEach((l) => l());
}
const useDbRenderer = () => useSyncExternalStore(subscribeRenderers, () => dbRenderer, () => dbRenderer);

export const DatabaseBlock = createReactBlockSpec(
  { type: "database", propSchema: { noteId: { default: "" }, view: { default: "" } }, content: "none" },
  {
    // The database handles its own clicks and keys (cells, menus, drag):
    // ProseMirror must not select or steal focus from it.
    meta: { selectable: false },
    render: function DbRender(props) {
      const renderDb = useDbRenderer();
      return (
        <div className="nt-inline-db" contentEditable={false} onKeyDown={(e) => e.stopPropagation()} onPaste={(e) => e.stopPropagation()}>
          {renderDb
            ? renderDb({
                dbId: props.block.props.noteId,
                scope: props.block.props.view || undefined,
                onPick: props.editor.isEditable ? (dbId) => props.editor.updateBlock(props.block, { props: { noteId: dbId } }) : undefined,
              })
            : null}
        </div>
      );
    },
  }
);

// ---------------------------------------------------------------------------
// Synced block (Notion): the same content on several pages. The content is a
// hidden note (`synced: true`); every synced block pointing at it shows and
// edits it, so a change anywhere shows everywhere. The editor (and the public
// page) register how to render that note.

type SyncedRenderer = (props: { note: Note; readOnly: boolean }) => React.ReactNode;
let syncedRenderer: SyncedRenderer | null = null;
export function registerSyncedRenderer(r: SyncedRenderer): void {
  syncedRenderer = r;
  rendererListeners.forEach((l) => l());
}
const useSyncedRenderer = () => useSyncExternalStore(subscribeRenderers, () => syncedRenderer, () => syncedRenderer);

/** Synced notes being shown around this point (a synced block inside its own content stops). */
const SyncedChain = createContext<readonly string[]>([]);

/** Pages (and synced contents) that show this synced content. */
function syncedUses(noteId: string, notes: Iterable<Note>): number {
  let n = 0;
  for (const x of notes) if (x.trashedAt === null && syncedIds(x.content).includes(noteId)) n += 1;
  return n;
}

function SyncedView({ noteId, blockId, editor }: { noteId: string; blockId: string; editor: { isEditable: boolean; replaceBlocks: (a: string[], b: never) => unknown } }) {
  const ctx = useNotesMaybe();
  const ro = useContext(ReadOnlyContext);
  const chain = useContext(SyncedChain);
  const renderSynced = useSyncedRenderer();
  const [uses, setUses] = useState<number | null>(null);
  const readOnly = ro.readOnly || !ctx || !editor.isEditable;
  const note = ro.readOnly || !ctx ? ro.notes?.get(noteId) : ctx.snap.byId.get(noteId);
  if (!note || !note.synced || note.trashedAt !== null)
    return (
      <div className="nt-synced nt-synced-missing" contentEditable={false}>
        {ctx?.t("synced.missing") ?? "The original synced block was deleted"}
      </div>
    );
  if (chain.includes(noteId) || chain.length > 4)
    return (
      <div className="nt-synced nt-synced-missing" contentEditable={false}>
        {ctx?.t("synced.loop") ?? "A synced block cannot contain itself"}
      </div>
    );
  return (
    <div className="nt-synced" contentEditable={false} data-readonly={readOnly || undefined} onMouseEnter={() => ctx && !readOnly && setUses(syncedUses(noteId, ctx.snap.byId.values()))}>
      {ctx && !readOnly && (
        <div className="nt-synced-bar">
          <span className="nt-synced-label">
            <RefreshCw />
            {ctx.t("synced.label")}
            {uses !== null && uses > 1 && <span className="nt-synced-uses">· {ctx.t("synced.uses", { n: uses })}</span>}
          </span>
          <button
            type="button"
            className="nt-synced-btn nt-btn-reset"
            onClick={() => {
              void navigator.clipboard?.writeText(`zvena-synced:${noteId}`).catch(() => undefined);
              toast(ctx.t("synced.copied"));
            }}
          >
            <Copy />
            {ctx.t("synced.copy")}
          </button>
          <button
            type="button"
            className="nt-synced-btn nt-btn-reset"
            title={notesT(ctx?.locale ?? "en", "block.syncCopy")}
            onClick={() => {
              const blocks = note.content.length ? withoutBlockIds(note.content) : [{ type: "paragraph" }];
              editor.replaceBlocks([blockId], blocks as never);
            }}
          >
            <Unlink />
            {ctx.t("synced.unsync")}
          </button>
        </div>
      )}
      <SyncedChain.Provider value={[...chain, noteId]}>
        <div className="nt-synced-body">{renderSynced?.({ note, readOnly })}</div>
      </SyncedChain.Provider>
    </div>
  );
}

export const SyncedBlock = createReactBlockSpec(
  { type: "synced", propSchema: { noteId: { default: "" } }, content: "none" },
  {
    // The content is its own editor: ProseMirror must not select or steal focus from it.
    meta: { selectable: false },
    render: (props) => <SyncedView noteId={props.block.props.noteId} blockId={props.block.id} editor={props.editor as never} />,
  }
);

// ---------------------------------------------------------------------------
// Breadcrumb (Notion "/breadcrumb"): where the page sits, each step a link

function Breadcrumb() {
  const id = useContext(PageIdContext);
  const lookup = useNoteLookup();
  const ctx = useNotesMaybe();
  const ro = useContext(ReadOnlyContext);
  const byId = ctx && !ro.readOnly ? ctx.snap.byId : ro.notes;
  const chain = id && byId ? ancestry(id, byId) : [];
  return (
    <nav className="nt-crumbs-block" contentEditable={false} aria-label={ctx?.t("slash.breadcrumb") ?? "Breadcrumb"}>
      {chain.map((n, i) => (
        <Fragment key={n.id}>
          {i > 0 && <span className="nt-crumbs-sep">/</span>}
          <button type="button" className="nt-crumbs-item nt-btn-reset" aria-current={i === chain.length - 1 ? "page" : undefined} onClick={() => lookup.open(n.id)}>
            <span className="nt-crumbs-icon"><NoteIcon icon={n.icon} fallback={<FileText />} /></span>
            <span className="nt-crumbs-label">{displayTitle(n, lookup.untitled)}</span>
          </button>
        </Fragment>
      ))}
    </nav>
  );
}

export const BreadcrumbBlock = createReactBlockSpec({ type: "breadcrumb", propSchema: {}, content: "none" }, { render: () => <Breadcrumb /> });

// ---------------------------------------------------------------------------
// Table of contents

function Toc({ editor }: { editor: { document: unknown[]; onChange: (cb: () => void) => (() => void) | void } }) {
  const [heads, setHeads] = useState<{ id: string; level: number; text: string }[]>([]);
  const ctx = useNotesMaybe();
  useEffect(() => {
    const read = () => {
      const out: { id: string; level: number; text: string }[] = [];
      const walk = (blocks: unknown[]) => {
        for (const raw of blocks) {
          const b = raw as { id: string; type: string; props?: { level?: number }; content?: unknown; children?: unknown[] };
          // inlineText: a link's or mention's words count too.
          if (b.type === "heading") out.push({ id: b.id, level: b.props?.level ?? 1, text: inlineText(b.content) });
          if (b.children?.length) walk(b.children);
        }
      };
      walk(editor.document);
      setHeads(out);
    };
    read();
    const off = editor.onChange(read);
    return () => {
      if (typeof off === "function") off();
    };
  }, [editor]);
  if (heads.length === 0) return <div className="nt-toc-empty">{notesT(ctx?.locale ?? "en", "block.tocEmpty")}</div>;
  return (
    <div className="nt-toc" contentEditable={false}>
      {heads.map((h) => (
        <a
          key={h.id}
          style={{ paddingInlineStart: 2 + (h.level - 1) * 24 }}
          onClick={(e) => {
            e.preventDefault();
            document.querySelector(`[data-id="${CSS.escape(h.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
        >
          <span>{h.text || (ctx?.t("page.untitled") ?? "Untitled")}</span>
        </a>
      ))}
    </div>
  );
}

export const TocBlock = createReactBlockSpec(
  { type: "toc", propSchema: {}, content: "none" },
  {
    render: (props) => <Toc editor={props.editor as unknown as { document: unknown[]; onChange: (cb: () => void) => () => void }} />,
  }
);

// ---------------------------------------------------------------------------
// Block equation

function EquationEditor({ value, onDone, anchor, placeholder }: { value: string; onDone: (v: string) => void; anchor: HTMLElement | null; placeholder: string }) {
  const [v, setV] = useState(value);
  const ctx = useNotesMaybe();
  return (
    <Popover anchor={anchor} onClose={() => onDone(v)} placement="bottom-center">
      <div style={{ width: 380, padding: 8, display: "flex", gap: 8, alignItems: "flex-start" }}>
        <textarea
          className="nt-input"
          autoFocus
          value={v}
          placeholder={placeholder}
          spellCheck={false}
          style={{ fontFamily: "var(--nt-code-font)", fontSize: 13, minHeight: 64 }}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onDone(v);
            }
          }}
        />
        <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" onClick={() => onDone(v)}>
          {notesT(ctx?.locale ?? "en", "button.done")}
        </button>
      </div>
    </Popover>
  );
}

export const EquationBlock = createReactBlockSpec(
  { type: "equation", propSchema: { latex: { default: "" } }, content: "none" },
  {
    render: function EquationRender(props) {
      const ref = useRef<HTMLDivElement>(null);
      const ro = useContext(ReadOnlyContext);
      // Public pages, viewers and locked pages: the equation only shows.
      const readOnly = ro.readOnly || !props.editor.isEditable;
      const [editing, setEditing] = useState(!props.block.props.latex && !readOnly);
      const latex = props.block.props.latex;
      const ctx = useNotesMaybe();
      return (
        <>
          <div ref={ref} className={latex ? "nt-equation" : "nt-equation nt-equation-empty"} contentEditable={false} onClick={() => !ro.readOnly && props.editor.isEditable && setEditing(true)}>
            {latex ? (
              <Katex latex={latex} display />
            ) : (
              <>
                <Sigma size={20} />
                {notesT(ctx?.locale ?? "en", "block.texEmpty")}
              </>
            )}
          </div>
          {editing && (
            <EquationEditor
              anchor={ref.current}
              value={latex}
              placeholder="E = mc^2"
              onDone={(v) => {
                setEditing(false);
                if (v !== latex) props.editor.updateBlock(props.block, { props: { latex: v } });
              }}
            />
          )}
        </>
      );
    },
  }
);

// ---------------------------------------------------------------------------
// Web bookmark

interface Unfurl {
  title: string;
  description: string;
  image: string;
  icon: string;
  url: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function UrlPrompt({ anchor, onDone, placeholder, onCancel }: { anchor: HTMLElement | null; onDone: (url: string) => void; onCancel: () => void; placeholder: string }) {
  const [v, setV] = useState("");
  const ctx = useNotesMaybe();
  return (
    <Popover anchor={anchor} onClose={onCancel} placement="bottom-center">
      <div style={{ width: 460, maxWidth: "calc(100vw - 16px)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          className="nt-input"
          autoFocus
          placeholder={placeholder}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && v.trim()) onDone(v.trim());
          }}
        />
        <button type="button" className="nt-btn nt-btn-primary nt-btn-reset" disabled={!v.trim()} onClick={() => onDone(v.trim())}>
          {notesT(ctx?.locale ?? "en", "button.done")}
        </button>
      </div>
    </Popover>
  );
}

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

export const BookmarkBlock = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: { url: { default: "" }, title: { default: "" }, description: { default: "" }, image: { default: "" }, icon: { default: "" } },
    content: "none",
  },
  {
    render: function BookmarkRender(props) {
      const p = props.block.props;
      const ref = useRef<HTMLDivElement>(null);
      const ro = useContext(ReadOnlyContext);
      const readOnly = ro.readOnly || !props.editor.isEditable;
      const [asking, setAsking] = useState(!p.url && !readOnly);
      const ctx = useNotesMaybe();
      const fetched = useRef(false);
      useEffect(() => {
        if (!p.url || p.title || fetched.current || readOnly) return;
        fetched.current = true;
        void fetch(`/api/notes/unfurl?url=${encodeURIComponent(p.url)}`)
          .then((r) => (r.ok ? (r.json() as Promise<Unfurl>) : null))
          .then((u) => {
            if (!u) return;
            props.editor.updateBlock(props.block, { props: { title: u.title || hostOf(p.url), description: u.description, image: u.image, icon: u.icon } });
          })
          .catch(() => undefined);
      }, [p.url, p.title, props.editor, props.block, readOnly]);
      if (!p.url) {
        return (
          <>
            <div ref={ref} className="nt-media-input" contentEditable={false} onClick={() => !ro.readOnly && props.editor.isEditable && setAsking(true)}>
              <Globe />
              {notesT(ctx?.locale ?? "en", "block.bookmarkEmpty")}
            </div>
            {asking && (
              <UrlPrompt
                anchor={ref.current}
                placeholder={notesT(ctx?.locale ?? "en", "block.bookmarkPlaceholder")}
                onCancel={() => setAsking(false)}
                onDone={(url) => {
                  setAsking(false);
                  props.editor.updateBlock(props.block, { props: { url: normalizeUrl(url) } });
                }}
              />
            )}
          </>
        );
      }
      return (
        <a className="nt-bookmark" href={p.url} target="_blank" rel="noopener noreferrer nofollow" contentEditable={false}>
          <div className="nt-bookmark-text">
            <div className="nt-bookmark-title">{p.title || hostOf(p.url)}</div>
            <div className="nt-bookmark-desc">{p.description}</div>
            <div className="nt-bookmark-url">
              {p.icon && <img src={p.icon} alt="" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />}
              <span>{p.url}</span>
            </div>
          </div>
          {p.image && (
            <div className="nt-bookmark-image">
              <img src={p.image} alt="" referrerPolicy="no-referrer" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).parentElement!.style.display = "none")} />
            </div>
          )}
        </a>
      );
    },
  }
);

// ---------------------------------------------------------------------------
// Embed (YouTube, Vimeo, Figma, Maps, Loom, CodePen, Spotify, any https page)

/** The services the slash menu offers by name (Notion's "Google Drive", "Figma", "Tweet"…): brand names, never translated. */
export const EMBED_PROVIDERS = {
  drive: "Google Drive",
  figma: "Figma",
  maps: "Google Maps",
  gist: "GitHub Gist",
  tweet: "X (Twitter)",
  loom: "Loom",
  miro: "Miro",
  codepen: "CodePen",
  whimsical: "Whimsical",
  canva: "Canva",
  spotify: "Spotify",
  airtable: "Airtable",
} as const;
export type EmbedProvider = keyof typeof EMBED_PROVIDERS;

export function embedSrc(raw: string): { src: string; height: number } | null {
  let u: URL;
  try {
    u = new URL(normalizeUrl(raw));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    const id = host === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v") || /\/(?:embed|shorts|live)\/([\w-]+)/.exec(u.pathname)?.[1];
    if (id) return { src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`, height: 405 };
  }
  if (host === "vimeo.com") {
    const id = /\/(\d+)/.exec(u.pathname)?.[1];
    if (id) return { src: `https://player.vimeo.com/video/${id}`, height: 405 };
  }
  if (host === "loom.com") {
    const id = /\/share\/([\w-]+)/.exec(u.pathname)?.[1];
    if (id) return { src: `https://www.loom.com/embed/${id}`, height: 405 };
  }
  if (host === "figma.com") return { src: `https://www.figma.com/embed?embed_host=zvena&url=${encodeURIComponent(u.toString())}`, height: 450 };
  if (host === "open.spotify.com") return { src: `https://open.spotify.com/embed${u.pathname}`, height: 352 };
  if (host === "codepen.io") return { src: u.toString().replace("/pen/", "/embed/"), height: 400 };
  if (host === "google.com" && u.pathname.startsWith("/maps")) return { src: `https://maps.google.com/maps?q=${encodeURIComponent(u.searchParams.get("q") || u.pathname.split("/")[3] || "")}&output=embed`, height: 400 };
  // Google Docs, Sheets, Slides and Drive files: their preview.
  if (host === "docs.google.com") {
    // A published one ("/d/e/…") embeds as it is.
    const m = /^\/(document|spreadsheets|presentation|forms)\/d\/([\w-]+)/.exec(u.pathname);
    if (m && m[2] !== "e") return { src: `https://docs.google.com/${m[1]}/d/${m[2]}/${m[1] === "forms" ? "viewform?embedded=true" : m[1] === "presentation" ? "embed" : "preview"}`, height: m[1] === "presentation" ? 405 : 600 };
  }
  if (host === "drive.google.com") {
    const id = /\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1];
    if (id) return { src: `https://drive.google.com/file/d/${id}/preview`, height: 480 };
  }
  if (host === "miro.com") {
    const id = /\/app\/board\/([\w=-]+)/.exec(u.pathname)?.[1];
    if (id) return { src: `https://miro.com/app/live-embed/${id}/`, height: 480 };
  }
  if (host === "codesandbox.io") {
    const id = /^\/(?:s|p\/sandbox)\/([\w-]+)/.exec(u.pathname)?.[1];
    if (id) return { src: `https://codesandbox.io/embed/${id}`, height: 500 };
  }
  if (host === "airtable.com" && /^\/(shr|app)/.test(u.pathname) && !u.pathname.startsWith("/embed")) return { src: `https://airtable.com/embed${u.pathname}`, height: 533 };
  if (host === "canva.com" && /^\/design\//.test(u.pathname)) return { src: `https://www.canva.com${u.pathname.replace(/\/(edit|view)$/, "")}/view?embed`, height: 450 };
  if (host === "whimsical.com" && !u.pathname.startsWith("/embed")) return { src: `https://whimsical.com/embed${u.pathname}`, height: 480 };
  if (host === "soundcloud.com") return { src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(u.toString())}`, height: 166 };
  if (host === "music.apple.com") return { src: `https://embed.music.apple.com${u.pathname}${u.search}`, height: 450 };
  // A GitHub Gist: its page made for embedding.
  if (host === "gist.github.com") {
    const m = /^\/([\w-]+)\/([0-9a-f]{6,64})/.exec(u.pathname);
    if (m) return { src: `https://gist.github.com/${m[1]}/${m[2]}.pibb`, height: 360 };
  }
  // A post on X (Twitter).
  if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") {
    const id = /\/status(?:es)?\/(\d{5,25})/.exec(u.pathname)?.[1];
    if (id) return { src: `https://platform.twitter.com/embed/Tweet.html?id=${id}`, height: 560 };
  }
  return { src: u.toString(), height: 400 };
}

export const EmbedBlock = createReactBlockSpec(
  { type: "embed", propSchema: { url: { default: "" }, height: { default: 0, type: "number" }, provider: { default: "" } }, content: "none" },
  {
    render: function EmbedRender(props) {
      const p = props.block.props;
      const ref = useRef<HTMLDivElement>(null);
      const ro = useContext(ReadOnlyContext);
      const readOnly = ro.readOnly || !props.editor.isEditable;
      const [asking, setAsking] = useState(!p.url && !readOnly);
      const ctx = useNotesMaybe();
      const e = p.url ? embedSrc(p.url) : null;
      if (!e) {
        return (
          <>
            <div ref={ref} className="nt-media-input" contentEditable={false} onClick={() => !ro.readOnly && props.editor.isEditable && setAsking(true)}>
              <Link2 />
              {/* "Embed Figma" … from the slash menu's own entries (Notion), else any link. */}
              {p.provider ? notesT(ctx?.locale ?? "en", "block.embedOf", { name: EMBED_PROVIDERS[p.provider as EmbedProvider] ?? p.provider }) : notesT(ctx?.locale ?? "en", "block.embedEmpty")}
            </div>
            {asking && (
              <UrlPrompt
                anchor={ref.current}
                placeholder={p.provider ? notesT(ctx?.locale ?? "en", "block.embedOfPlaceholder", { name: EMBED_PROVIDERS[p.provider as EmbedProvider] ?? p.provider }) : notesT(ctx?.locale ?? "en", "block.embedPlaceholder")}
                onCancel={() => setAsking(false)}
                onDone={(url) => {
                  setAsking(false);
                  props.editor.updateBlock(props.block, { props: { url: normalizeUrl(url) } });
                }}
              />
            )}
          </>
        );
      }
      return (
        <div className="nt-embed" contentEditable={false} style={{ height: (p.height || e.height) + 30 }}>
          <iframe
            src={e.src}
            title={p.url}
            style={{ height: p.height || e.height }}
            loading="lazy"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
          <div className="nt-embed-bar">
            <ArrowUpRight size={14} />
            <a href={p.url} target="_blank" rel="noopener noreferrer nofollow">
              {p.url}
            </a>
          </div>
        </div>
      );
    },
  }
);

// ---------------------------------------------------------------------------
// Mermaid diagram

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let mermaidSeq = 0;

function MermaidView({ code, dark }: { code: string; dark: boolean }) {
  const [svg, setSvg] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    mermaidPromise ??= import("mermaid");
    void mermaidPromise.then(async (m) => {
      const mermaid = m.default;
      try {
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", fontFamily: "inherit" });
        const { svg } = await mermaid.render(`nt-mmd-${++mermaidSeq}`, code || "graph TD; A-->B");
        if (live) {
          setSvg(svg);
          setErr("");
        }
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message.split("\n")[0] : "Diagram error");
      }
    });
    return () => {
      live = false;
    };
  }, [code, dark]);
  if (err) return <div className="nt-equation-error">{err}</div>;
  return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}

export const MermaidBlock = createReactBlockSpec(
  { type: "mermaid", propSchema: { code: { default: "graph TD\n  A[Idea] --> B{Plan}\n  B --> C[Build]\n  B --> D[Test]" } }, content: "none" },
  {
    meta: { selectable: false },
    render: function MermaidRender(props) {
      const ro = useContext(ReadOnlyContext);
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState(props.block.props.code);
      const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
      return (
        <div className="nt-mermaid" contentEditable={false}>
          {editing && (
            <textarea
              autoFocus
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setEditing(false);
                if (draft !== props.block.props.code) props.editor.updateBlock(props.block, { props: { code: draft } });
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
          )}
          <div className="nt-mermaid-view" onClick={() => !ro.readOnly && props.editor.isEditable && setEditing(true)} title="Mermaid">
            <MermaidView code={editing ? draft : props.block.props.code} dark={dark} />
          </div>
        </div>
      );
    },
  }
);

// ---------------------------------------------------------------------------
// Inline: page mention / date, inline equation

/** "@Today" / "@15 октября 2026"; a click opens the date picker (Notion). */
function DateMention({ date, remind, locale, editable, onChange }: { date: string; remind: string; locale: string; editable: () => boolean; onChange: (date: string, remind: string) => void }) {
  const ro = useContext(ReadOnlyContext);
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const day = date.slice(0, 10);
  const time = dateTimePart(date);
  const d = new Date(`${day}T00:00:00`);
  const today = localYmd(new Date());
  const shift = (n: number) => {
    const x = new Date();
    return localYmd(new Date(x.getFullYear(), x.getMonth(), x.getDate() + n));
  };
  const tag = intlOf(locale);
  // Today, Tomorrow, Yesterday in the reader's language, capitalised like Notion's.
  const near = (n: number) => nearDay(locale, n);
  const dayLabel =
    day === today ? near(0) : day === shift(1) ? near(1) : day === shift(-1) ? near(-1) : Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(tag, { month: "long", day: "numeric", year: "numeric" });
  const label = time ? `${dayLabel}${locale === "en" ? " " : ", "}${new Date(`${day}T${time}:00`).toLocaleTimeString(tag, { hour: "numeric", minute: "2-digit" })}` : dayLabel;
  return (
    <>
      <span className="nt-mention nt-mention-datebox" title={date.replace("T", " ")} onClick={(e) => !ro.readOnly && editable() && setOpen(e.currentTarget)}>
        <span className="nt-mention-date">{label}</span>
        {remind && <AlarmClock className="nt-mention-bell" aria-label={notesT(locale, "remind.aria")} />}
      </span>
      {open && (
        <DateEditor
          withTime
          value={{ start: date, ...(remind ? { remind } : {}) }}
          anchor={open}
          onClose={() => setOpen(null)}
          onValue={(v) => {
            const d = v && typeof v === "object" && !Array.isArray(v) && "start" in v ? (v as { start: string; remind?: string }) : null;
            if (d?.start) onChange(String(d.start).slice(0, 16), d.remind ?? "");
          }}
        />
      )}
    </>
  );
}

/** "@Анна Петрова": a mention of a member (the name stored with it shows once they have left). */
function PersonMention({ userId, name }: { userId: string; name: string }) {
  const ctx = useNotesMaybe();
  useSyncExternalStore(subscribePeople, people, people);
  const known = personById(userId)?.name;
  const unknown = ctx ? ctx.t("people.unknown") : "Unknown";
  return <span className="nt-mention nt-mention-person">@{known || name || unknown}</span>;
}

export const MentionInline = createReactInlineContentSpec(
  { type: "mention", propSchema: { noteId: { default: "" }, date: { default: "" }, remind: { default: "" }, userId: { default: "" }, name: { default: "" } }, content: "none" },
  {
    render: function MentionRender(props) {
      const look = useNoteLookup();
      const { noteId, date, remind, userId, name } = props.inlineContent.props;
      const ctx = useNotesMaybe();
      if (userId || (name && !noteId && !date)) return <PersonMention userId={userId} name={name} />;
      if (date) return <DateMention date={date} remind={remind} locale={ctx?.locale ?? "en"} editable={() => props.editor.isEditable} onChange={(next, r) => props.updateInlineContent({ type: "mention", props: { noteId: "", date: next, remind: r, userId: "", name: "" } })} />;
      const note = look.get(noteId);
      return (
        <span className="nt-mention" onClick={() => note && look.open(noteId)}>
          <span><NoteIcon icon={note?.icon} fallback="📄" /></span>
          <span className="nt-mention-title">{note ? displayTitle(note, look.untitled) : "—"}</span>
        </span>
      );
    },
  }
);

export const InlineEquation = createReactInlineContentSpec(
  { type: "inlineEquation", propSchema: { latex: { default: "x^2" } }, content: "none" },
  {
    render: function InlineEqRender(props) {
      const ref = useRef<HTMLSpanElement>(null);
      const ro = useContext(ReadOnlyContext);
      const [editing, setEditing] = useState(false);
      return (
        <>
          <span ref={ref} className="nt-inline-eq" onClick={() => !ro.readOnly && props.editor.isEditable && setEditing(true)}>
            <Katex latex={props.inlineContent.props.latex} display={false} />
          </span>
          {editing && (
            <EquationEditor
              anchor={ref.current}
              value={props.inlineContent.props.latex}
              placeholder="x^2"
              onDone={(v) => {
                setEditing(false);
                props.updateInlineContent({ type: "inlineEquation", props: { latex: v || "x" } });
              }}
            />
          )}
        </>
      );
    },
  }
);

// ---------------------------------------------------------------------------
// Schema

const { pageBreak: _pageBreak, ...baseBlocks } = defaultBlockSpecs as typeof defaultBlockSpecs & { pageBreak?: unknown };
void _pageBreak;

/** What a block's render returns, as far as the names below need it. */
type ControlView = { dom: Node; ignoreMutation?: (m: MutationRecord | { type: "selection"; target: Node }) => boolean; destroy?: () => void };

/**
 * Names for screen readers on BlockNote's own controls (axe, 2026-10-11):
 * the to-do's checkbox and the toggle's arrow had none. They are set as the
 * block renders, before ProseMirror owns the DOM: it redraws a node whose
 * DOM is changed from outside, so labelling it later looped. The arrow's
 * aria-expanded follows BlockNote's data-show-children through an observer
 * whose writes the view is told to ignore.
 */
function labelControls(view: ControlView): void {
  const root = view.dom as ParentNode;
  if (typeof root.querySelector !== "function") return;
  const lang = document.documentElement.lang || "en";
  root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.setAttribute("aria-label", notesT(lang, "block.checked"));
  const arrow = root.querySelector<HTMLButtonElement>(".bn-toggle-button");
  const wrapper = arrow?.parentElement;
  if (!arrow || !wrapper) return;
  arrow.setAttribute("aria-label", notesT(lang, "block.toggle"));
  const sync = () => arrow.setAttribute("aria-expanded", wrapper.getAttribute("data-show-children") === "true" ? "true" : "false");
  sync();
  const watch = new MutationObserver(sync);
  watch.observe(wrapper, { attributes: true, attributeFilter: ["data-show-children"] });
  const ignore = view.ignoreMutation;
  view.ignoreMutation = (m) => (m.type === "attributes" && m.target === arrow && (m as MutationRecord).attributeName === "aria-expanded") || (ignore ? ignore(m) : false);
  const destroy = view.destroy;
  view.destroy = () => {
    watch.disconnect();
    destroy?.();
  };
}

/**
 * A default block whose render adds the names above. BlockNote's default
 * specs are still unbuilt here ({config, implementation, extensions}: the
 * schema makes the Tiptap node from them), so wrapping the render is enough.
 */
function withControlNames<S>(spec: S): S {
  const s = spec as unknown as { implementation: { render: (this: unknown, ...args: unknown[]) => ControlView } };
  const render = s.implementation.render;
  return {
    ...s,
    implementation: {
      ...s.implementation,
      render(this: unknown, ...args: unknown[]) {
        const view = render.apply(this, args);
        labelControls(view);
        return view;
      },
    },
  } as unknown as S;
}

// Code block languages (Notion's picker; the name also labels Markdown
// fences). BlockNote's picker throws on a language it doesn't list — one
// typed as ```foo or imported — so `in` always answers yes and an unknown
// language simply shows no name.
const CODE_LANGS: Record<string, { name: string; aliases?: string[] }> = {
  text: { name: "Plain text", aliases: ["plaintext", "txt", "none"] },
  bash: { name: "Shell", aliases: ["sh", "shell", "zsh"] },
  c: { name: "C" },
  cpp: { name: "C++", aliases: ["c++"] },
  csharp: { name: "C#", aliases: ["cs", "c#"] },
  css: { name: "CSS" },
  dart: { name: "Dart" },
  dockerfile: { name: "Docker", aliases: ["docker"] },
  go: { name: "Go", aliases: ["golang"] },
  graphql: { name: "GraphQL", aliases: ["gql"] },
  haskell: { name: "Haskell", aliases: ["hs"] },
  html: { name: "HTML" },
  java: { name: "Java" },
  javascript: { name: "JavaScript", aliases: ["js", "jsx"] },
  json: { name: "JSON" },
  kotlin: { name: "Kotlin", aliases: ["kt"] },
  latex: { name: "LaTeX", aliases: ["tex"] },
  lua: { name: "Lua" },
  markdown: { name: "Markdown", aliases: ["md"] },
  matlab: { name: "MATLAB" },
  pascal: { name: "Pascal" },
  php: { name: "PHP" },
  powershell: { name: "PowerShell", aliases: ["ps1"] },
  python: { name: "Python", aliases: ["py", "python3"] },
  r: { name: "R" },
  ruby: { name: "Ruby", aliases: ["rb"] },
  rust: { name: "Rust", aliases: ["rs"] },
  scala: { name: "Scala" },
  scss: { name: "SCSS", aliases: ["sass"] },
  sql: { name: "SQL" },
  swift: { name: "Swift" },
  typescript: { name: "TypeScript", aliases: ["ts", "tsx"] },
  xml: { name: "XML" },
  yaml: { name: "YAML", aliases: ["yml"] },
};
const codeLanguages = new Proxy(CODE_LANGS, { has: () => true });

/** An inline discussion's text mark; the editor highlights open threads only. */
export const CommentStyle = createReactStyleSpec(
  { type: "comment", propSchema: "string" },
  {
    render: (props) => <span ref={props.contentRef} className="nt-cmark" data-thread={props.value} />,
  }
);

/**
 * Suggested edits (lib/notes/suggestions.ts): text suggested by someone, and
 * text suggested for removal. Plain DOM (a React mark view mounts after the
 * caret is placed, which threw typing at the start of the line), and never
 * read back from pasted HTML: a copied suggestion pastes as plain text.
 */
const suggestMark = (tag: "ins" | "del") => (value: string | undefined) => {
  const dom = document.createElement(tag);
  dom.className = tag === "ins" ? "nt-sins" : "nt-sdel";
  if (value) dom.dataset.sid = value;
  return { dom, contentDOM: dom };
};
export const SuggestInsStyle = createStyleSpec({ type: "suggestIns", propSchema: "string" }, { render: suggestMark("ins"), parse: () => undefined });
export const SuggestDelStyle = createStyleSpec({ type: "suggestDel", propSchema: "string" }, { render: suggestMark("del"), parse: () => undefined });

export const notesSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...baseBlocks,
    checkListItem: withControlNames(baseBlocks.checkListItem),
    toggleListItem: withControlNames(baseBlocks.toggleListItem),
    heading: withControlNames(baseBlocks.heading),
    codeBlock: createCodeBlockSpec({ supportedLanguages: codeLanguages, defaultLanguage: "text" }),
    callout: CalloutBlock(),
    page: PageBlock(),
    database: DatabaseBlock(),
    toc: TocBlock(),
    equation: EquationBlock(),
    bookmark: BookmarkBlock(),
    embed: EmbedBlock(),
    mermaid: MermaidBlock(),
    columnList: ColumnListBlock,
    column: ColumnBlock,
    // Notion's Tabs block (components/notes/tabs.ts).
    tabs: TabsBlock,
    tab: TabBlock,
    button: ButtonBlock(),
    breadcrumb: BreadcrumbBlock(),
    synced: SyncedBlock(),
    // zvena: a live frame from Design (components/notes/design.tsx).
    design: DesignBlock(),
    pdf: PdfBlock(),
    // zvena: a live issue from Projects (components/eco/IssueBlock.tsx).
    issue: IssueBlock(),
    // zvena: a live list of a project's issues (components/eco/IssuesBlock.tsx).
    issues: IssuesBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: MentionInline,
    inlineEquation: InlineEquation,
    customEmoji: CustomEmojiInline,
    linkMention: LinkMentionInline,
  },
  styleSpecs: { ...defaultStyleSpecs, comment: CommentStyle, suggestIns: SuggestInsStyle, suggestDel: SuggestDelStyle },
});

export type NotesSchema = typeof notesSchema;
export type NotesEditor = import("@blocknote/core").BlockNoteEditor<NotesSchema["blockSchema"], NotesSchema["inlineContentSchema"], NotesSchema["styleSchema"]>;
export type NotesBlock = import("@blocknote/core").Block<NotesSchema["blockSchema"], NotesSchema["inlineContentSchema"], NotesSchema["styleSchema"]>;
export type NotesPartialBlock = import("@blocknote/core").PartialBlock<NotesSchema["blockSchema"], NotesSchema["inlineContentSchema"], NotesSchema["styleSchema"]>;

export { Workflow as MermaidIcon };
