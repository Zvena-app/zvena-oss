"use client";

// A published zvena Documents page (/n/<id>): read-only, with its published
// sub-pages and databases navigable inside the snapshot (#<note id>).

import "@blocknote/ariakit/style.css";
import "./notes.css";
import "./theme.css";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import { Copy, FileText } from "lucide-react";
import { notesSchema, registerDbRenderer, registerSyncedRenderer } from "./blocks";
import { PageIdContext, ReadOnlyContext } from "./context";
import { BrandMarkIcon } from "@/components/brand/BrandLogo";
import { coverCss } from "./cover";
import { ancestry, displayTitle, iconText, linkedNoteId, outlineOf } from "@/lib/notes/model";
import { applyView, propValue, rowsOf, valueText, visibleProps, optionById } from "@/lib/notes/db";
import { notesT, useNotesT } from "@/lib/notes/i18n";
import type { DbSchema, DbView, Note } from "@/lib/notes/types";
import { sourceName, sourceTables } from "@/lib/notes/sources";
import type { NoteShareSnapshot } from "@/lib/notes/server-store";
import { NoteIcon } from "./NoteIcon";
import { CodeHighlightExtension } from "./codeHighlight";
import { intlOf } from "@/i18n/locales";

function PublicDatabase({ db, notes, open, locale, scope }: { db: Note; notes: Note[]; open: (id: string) => void; locale: string; scope?: string }) {
  if (!db.db) return null;
  // One table per published data source (lib/notes/sources.ts).
  const tables = sourceTables(db, notes, scope);
  return (
    <div className="nt-db" style={{ margin: "8px 0" }}>
      {db.inline && <div className="nt-db-titlebar"><div className="nt-db-title">{displayTitle(db, notesT(locale, "db.untitled"))}</div></div>}
      {tables.map(({ view, src }) => (
        <PublicSourceTable key={src.id} db={db} src={src} view={view} caption={tables.length > 1} notes={notes} open={open} locale={locale} />
      ))}
    </div>
  );
}

function PublicSourceTable({ db, src, view, caption, notes, open, locale }: { db: Note; src: Note; view: DbView | undefined; caption: boolean; notes: Note[]; open: (id: string) => void; locale: string }) {
  const schema = { ...(src.db as DbSchema), views: db.db?.views ?? [] };
  const rows = view ? applyView(rowsOf(src.id, notes), { ...view, filters: [] }, schema, "", locale) : rowsOf(src.id, notes);
  const props = view ? visibleProps(schema, view) : schema.properties;
  return (
    <>
      {caption && <div className="nt-db-srccaption">{sourceName(db, src, notesT(locale, "db.untitled"))}</div>}
      <div className="nt-table-wrap">
        <div className="nt-table" style={{ minWidth: props.length * 180 }}>
          <div className="nt-thead">
            <div className="nt-tr">
              {props.map((p) => (
                <div key={p.id} className="nt-th" style={{ width: p.type === "title" ? 280 : 180, cursor: "default" }}>
                  <span className="nt-th-name">{p.name}</span>
                </div>
              ))}
            </div>
          </div>
          {rows.map((r) => (
            <div key={r.id} className="nt-tr nt-tr-body">
              {props.map((p) => {
                const v = propValue(r, p);
                let cell: React.ReactNode = valueText(p, v, locale);
                if (p.type === "title")
                  cell = (
                    <span className="nt-td-title" style={{ cursor: "pointer" }} onClick={() => open(r.id)}>
                      {r.icon && <span className="nt-row-icon"><NoteIcon icon={r.icon} /></span>}
                      <span className="nt-td-title-text">{r.title || notesT(locale, "db.untitled")}</span>
                    </span>
                  );
                else if ((p.type === "select" || p.type === "status") && typeof v === "string") {
                  const o = optionById(p, v);
                  cell = o ? <span className={p.type === "status" ? "nt-tag nt-tag-status" : "nt-tag"} data-color={o.color}>{o.name}</span> : null;
                } else if (p.type === "multi_select" && Array.isArray(v)) {
                  cell = (
                    <span className="nt-tags">
                      {v.map((id) => {
                        const o = optionById(p, id);
                        return o ? <span key={id} className="nt-tag" data-color={o.color}>{o.name}</span> : null;
                      })}
                    </span>
                  );
                }
                return (
                  <div key={p.id} className="nt-td" style={{ width: p.type === "title" ? 280 : 180, cursor: "default" }}>
                    <div className="nt-td-inner">{cell}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function PublicBody({ note, open }: { note: Note; open?: (id: string) => boolean }) {
  const editor = useCreateBlockNote(
    {
      schema: notesSchema,
      extensions: [CodeHighlightExtension()],
      initialContent: note.content.length ? (note.content as never) : undefined,
      links: {
        // A link to another page of this published copy moves within it.
        onClick: (event: MouseEvent) => {
          const href = (event.target as HTMLElement).closest("a")?.getAttribute("href") ?? "";
          const id = href ? linkedNoteId(href, location.href) : null;
          if (id && open?.(id)) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
    [note.id]
  );
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return (
    <PageIdContext.Provider value={note.id}>
      <div className="nt-editor">
        <BlockNoteView editor={editor as never} editable={false} theme={dark ? "dark" : "light"} sideMenu={false} slashMenu={false} formattingToolbar={false} />
      </div>
    </PageIdContext.Provider>
  );
}

// Synced blocks on a public page show their content read-only.
registerSyncedRenderer(({ note }) => <PublicBody note={note} />);

/** The page outline beside the page (site setting "Show page outline"); a heading click scrolls to it. */
function Outline({ note, label, untitled }: { note: Note; label: string; untitled: string }) {
  const heads = outlineOf(note.content);
  if (heads.length < 2) return null;
  return (
    <nav className="nt-pub-outline" aria-label={label}>
      {heads.map((h) => (
        <button
          key={h.id}
          type="button"
          className="nt-pub-outline-item nt-btn-reset"
          data-level={h.level}
          onClick={() => document.querySelector(`.nt-editor [data-id="${CSS.escape(h.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          {h.text || untitled}
        </button>
      ))}
    </nav>
  );
}

/** `app`: zvena's own address when the page is served on a site's custom domain (its links to zvena then leave that domain). */
export default function PublicNote({ snapshot, updatedAt, shareId, app = "" }: { snapshot: NoteShareSnapshot; updatedAt: number; shareId?: string; app?: string }) {
  const { t, locale } = useNotesT();
  const byId = useMemo(() => new Map(snapshot.notes.map((n) => [n.id, n])), [snapshot.notes]);
  const [id, setId] = useState(snapshot.rootId);

  useEffect(() => {
    const read = () => {
      const h = location.hash.replace(/^#/, "");
      setId(h && byId.has(h) ? h : snapshot.rootId);
      window.scrollTo({ top: 0 });
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [byId, snapshot.rootId]);

  const open = (to: string): boolean => {
    if (!byId.has(to)) return false;
    // Navigation goes through the hash, so Back and Forward work.
    // eslint-disable-next-line react-hooks/immutability
    location.hash = to === snapshot.rootId ? "" : to;
    return true;
  };

  useEffect(() => {
    registerDbRenderer(({ dbId, scope }) => {
      const db = byId.get(dbId);
      return db ? <PublicDatabase db={db} notes={snapshot.notes} open={open} locale={locale} scope={scope} /> : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, locale]);

  const note = byId.get(id) ?? byId.get(snapshot.rootId);
  useEffect(() => {
    if (note) document.title = `${iconText(note.icon) ? `${iconText(note.icon)} ` : ""}${displayTitle(note, t("page.untitled"))}`;
  }, [note, t]);
  if (!note) return <div className="nt-pub" style={{ padding: 48 }}>{t("public.notFound")}</div>;
  const chain = ancestry(note.id, byId).filter((n) => byId.has(n.id));
  const roContext = { readOnly: true, notes: byId as ReadonlyMap<string, Note>, openPublic: open };

  return (
    <ReadOnlyContext.Provider value={roContext}>
      <div className="nt-pub">
        <header className="nt-pub-top">
          <nav className="nt-crumbs">
            {!snapshot.options?.noCrumbs && chain.map((n, i) => (
              <span key={n.id} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                {i > 0 && <span className="nt-crumb-sep">/</span>}
                <button type="button" className="nt-crumb nt-btn-reset" onClick={() => open(n.id)}>
                  {n.icon ? <span className="nt-crumb-icon"><NoteIcon icon={n.icon} /></span> : <FileText size={14} />}
                  <span className="nt-crumb-text">{displayTitle(n, t("page.untitled"))}</span>
                </button>
              </span>
            ))}
          </nav>
          <span className="nt-pub-actions">
            {!snapshot.options?.noDup && (
              <a className="nt-pub-dup" href={`${app}/docs#dup=${shareId ?? location.pathname.split("/").pop() ?? ""}`} title={t("dup.hint")} rel="nofollow">
                <Copy size={14} />
                <span className="nt-pub-dup-label">{t("dup.button")}</span>
              </a>
            )}
            <Link className="nt-pub-brand" href={`${app}/`}>
              <BrandMarkIcon className="nt-pub-mark" />
              {t("public.try")}
            </Link>
          </span>
        </header>
        <div className="nt-page" data-cover={note.cover ? "true" : "false"} data-noicon={note.icon ? "false" : "true"} data-full={note.style?.full || note.kind === "database" || undefined} data-font={note.style?.font ?? "default"} data-small={note.style?.small || undefined} style={{ paddingBottom: 0 }}>
          {note.cover && (
            <div className="nt-cover" style={note.cover.kind === "image" ? undefined : { background: coverCss(note.cover.value) }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the cover is a workspace file or a URL the person pasted, any size */}
              {note.cover.kind === "image" && <img src={note.cover.value} alt="" style={{ objectPosition: `center ${note.cover.y}%` }} />}
            </div>
          )}
          <div className="nt-head">
            <div className="nt-head-pad">
              {note.icon && (
                <div className="nt-page-icon" style={{ cursor: "default" }}>
                  <span><NoteIcon icon={note.icon} /></span>
                </div>
              )}
              {!note.icon && !note.cover && <div style={{ height: 80 }} />}
              <h1 className="nt-title" style={{ cursor: "default" }}>
                {displayTitle(note, t("page.untitled"))}
              </h1>
            </div>
          </div>
          <div className="nt-body">
            {note.kind === "database" ? <PublicDatabase db={note} notes={snapshot.notes} open={open} locale={locale} /> : <PublicBody key={note.id} note={note} open={open} />}
          </div>
          {snapshot.options?.outline && note.kind === "page" && <Outline note={note} label={t("outline.label")} untitled={t("page.untitled")} />}
          <footer className="nt-pub-foot">
            <span>{t("public.updated", { when: new Date(updatedAt).toLocaleDateString(intlOf(locale), { dateStyle: "medium" }) })}</span>
            <Link href={`${app}/`}>{t("public.by")}</Link>
            <a href={`${app}/report?url=${encodeURIComponent(typeof location === "undefined" ? "" : location.href)}`} rel="nofollow">
              {t("public.reportAbuse")}
            </a>
          </footer>
        </div>
      </div>
    </ReadOnlyContext.Provider>
  );
}
