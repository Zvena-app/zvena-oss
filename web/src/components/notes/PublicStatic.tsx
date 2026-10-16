// A published page (/n/<id>) as server-rendered HTML: search engines and
// link previews read the content, and visitors see the page at once. It
// mirrors PublicNote's layout and BlockNote's DOM (.bn-block-group >
// .bn-block-outer > .bn-block > .bn-block-content[data-content-type]), so
// notes.css draws it like the interactive view that takes over after load.
// No hooks and no client state: it renders on the server (and on the client
// only as the loading view). Everything comes from the published copy, which
// has no comments, share keys or form links (server-store publicNote); links
// and media are checked again here (safe schemes only), design frames show
// only their name, and people mentions show no names. Its styles are
// imported by the page (app/n/[id]/page.tsx), so this stays plain to test.

import Link from "next/link";
import { BrandMarkIcon } from "@/components/brand/BrandLogo";
import { Fragment, type ReactNode } from "react";
import { coverCss } from "./cover";
import { applyView, fmtDate, optionById, propValue, rowsOf, valueText, visibleProps } from "@/lib/notes/db";
import { notesT, type NotesKey } from "@/lib/notes/i18n";
import { ancestry, displayTitle, iconText, linkedNoteId, outlineOf, safeUrl } from "@/lib/notes/model";
import type { SiteOptions } from "@/lib/notes/sites";
import type { DbSchema, DbView, Note } from "@/lib/notes/types";
import { sourceName, sourceTables } from "@/lib/notes/sources";
import { intlOf } from "@/i18n/locales";

type Inline = { type?: string; text?: string; styles?: Record<string, unknown>; href?: string; content?: unknown; props?: Record<string, unknown> };
type Block = { id?: string; type?: string; props?: Record<string, unknown>; content?: unknown; children?: Block[] };

interface Ctx {
  byId: ReadonlyMap<string, Note>;
  locale: string;
  /** This site's origin: in-app page links (/docs#…) to pages of the copy become #<id>. */
  base: string;
  t: (k: NotesKey, vars?: Record<string, string | number>) => string;
  /** The page being shown (its table of contents). */
  page: Note;
  /** Synced blocks this block is inside (a synced block inside itself stops). */
  synced: ReadonlySet<string>;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A page icon as NoteIcon draws it; a monochrome "icon:" keeps its box until the interactive view draws it. */
function NoteIcon({ icon, fallback = null }: { icon: string | undefined | null; fallback?: ReactNode }): ReactNode {
  if (!icon) return fallback;
  if (icon.startsWith("icon:")) return <span className="nt-licon nt-licon-wait" aria-hidden="true" />;
  // eslint-disable-next-line @next/next/no-img-element
  if (icon.startsWith("/api/notes/file/")) return <img className="nt-imgicon" src={icon} alt="" />;
  return iconText(icon) || fallback;
}

/** A link target a visitor may follow: http(s), mailto, same-site paths; a page of this copy becomes #<id>. */
function href(raw: string, ctx: Ctx): string | undefined {
  if (!raw || !safeUrl(raw)) return undefined;
  const id = linkedNoteId(raw, ctx.base);
  if (id) return ctx.byId.has(id) ? `#${id}` : undefined;
  return raw;
}

function inline(content: unknown, ctx: Ctx, key = "i"): ReactNode {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return (content as Inline[]).map((n, i) => {
    const k = `${key}${i}`;
    if (!n || typeof n !== "object") return null;
    if (n.type === "link") {
      const to = href(str(n.href), ctx);
      const inner = inline(n.content, ctx, k);
      return to ? (
        <a key={k} href={to} {...(to.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer nofollow" })}>
          {inner}
        </a>
      ) : (
        <Fragment key={k}>{inner}</Fragment>
      );
    }
    if (n.type === "mention") {
      const date = str(n.props?.date);
      if (date) {
        return (
          <span key={k} className="nt-mention nt-mention-datebox">
            <span className="nt-mention-date">{fmtDate(date, ctx.locale)}</span>
          </span>
        );
      }
      // A person: the published copy names nobody.
      if (str(n.props?.userId)) return <span key={k} className="nt-mention">@</span>;
      const note = ctx.byId.get(str(n.props?.noteId));
      const body = (
        <>
          <span>
            <NoteIcon icon={note?.icon} fallback="📄" />
          </span>
          <span className="nt-mention-title">{note ? displayTitle(note, ctx.t("page.untitled")) : "—"}</span>
        </>
      );
      return note ? (
        <a key={k} className="nt-mention" href={`#${note.id}`}>
          {body}
        </a>
      ) : (
        <span key={k} className="nt-mention">
          {body}
        </span>
      );
    }
    if (n.type === "inlineEquation") return <code key={k}>{str(n.props?.latex)}</code>;
    if (n.type !== "text") return <Fragment key={k}>{inline(n.content, ctx, k)}</Fragment>;
    const st = n.styles ?? {};
    let el: ReactNode = n.text ?? "";
    if (st.code) el = <code>{el}</code>;
    if (st.bold) el = <strong>{el}</strong>;
    if (st.italic) el = <em>{el}</em>;
    if (st.underline) el = <u>{el}</u>;
    if (st.strike) el = <s>{el}</s>;
    if (typeof st.textColor === "string" && st.textColor !== "default") el = <span data-style-type="textColor" data-value={st.textColor}>{el}</span>;
    if (typeof st.backgroundColor === "string" && st.backgroundColor !== "default") el = <span data-style-type="backgroundColor" data-value={st.backgroundColor}>{el}</span>;
    return <Fragment key={k}>{el}</Fragment>;
  });
}

function blockAttrs(b: Block): Record<string, string> {
  const p = b.props ?? {};
  const out: Record<string, string> = { "data-content-type": String(b.type ?? "paragraph") };
  if (typeof p.textColor === "string" && p.textColor !== "default") out["data-text-color"] = p.textColor;
  if (typeof p.backgroundColor === "string" && p.backgroundColor !== "default") out["data-background-color"] = p.backgroundColor;
  if (typeof p.textAlignment === "string" && p.textAlignment !== "left") out["data-text-alignment"] = p.textAlignment;
  return out;
}

function Group({ blocks, ctx, depth }: { blocks: Block[]; ctx: Ctx; depth: number }) {
  // Numbered lists count consecutive items, as BlockNote's data-index does.
  const indexes: number[] = [];
  for (const b of blocks) indexes.push(b.type === "numberedListItem" ? (indexes.at(-1) ?? 0) + 1 : 0);
  return (
    <div className="bn-block-group" data-node-type="blockGroup">
      {blocks.map((b, i) => (
        <StaticBlock key={b.id ?? i} block={b} index={indexes[i]} ctx={ctx} depth={depth} />
      ))}
    </div>
  );
}

const HEADINGS = { 1: "h1", 2: "h2", 3: "h3", 4: "h4" } as const;

function tableRows(content: unknown): unknown[][] {
  const t = content as { type?: string; rows?: { cells?: unknown[] }[] } | null;
  if (!t || t.type !== "tableContent" || !Array.isArray(t.rows)) return [];
  return t.rows.map((r) => (Array.isArray(r.cells) ? r.cells.map((c) => (typeof c === "object" && c !== null && "content" in c ? (c as { content: unknown }).content : c)) : []));
}

function Media({ b, ctx }: { b: Block; ctx: Ctx }) {
  const p = b.props ?? {};
  const url = str(p.url);
  const ok = url && safeUrl(url, b.type === "image") ? url : "";
  const caption = str(p.caption);
  const name = str(p.name) || caption || url.split("/").pop() || "";
  let el: ReactNode;
  if (!ok) el = <div className="nt-static-box" />;
  else if (b.type === "image") el = (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={ok} alt={caption} loading="lazy" style={{ maxWidth: "100%", width: typeof p.previewWidth === "number" ? p.previewWidth : undefined }} />
  );
  else if (b.type === "video") el = <video src={ok} controls preload="none" style={{ maxWidth: "100%" }} />;
  else if (b.type === "audio") el = <audio src={ok} controls preload="none" />;
  else el = (
    <a href={ok} target="_blank" rel="noopener noreferrer nofollow">
      📎 {name}
    </a>
  );
  return (
    <figure style={{ margin: 0 }}>
      {el}
      {caption && b.type !== "file" && <figcaption className="nt-static-caption">{inline(caption, ctx)}</figcaption>}
    </figure>
  );
}

function StaticBlock({ block: b, index, ctx, depth }: { block: Block; index: number; ctx: Ctx; depth: number }) {
  const p = b.props ?? {};
  const attrs = blockAttrs(b);
  let body: ReactNode;
  let kids: Block[] | null = Array.isArray(b.children) && b.children.length ? b.children : null;
  let hideKids = false;
  switch (b.type) {
    case "heading": {
      const n = Number(p.level);
      const level = (n >= 1 && n <= 4 ? n : 1) as 1 | 2 | 3 | 4;
      if (level !== 1) attrs["data-level"] = String(level);
      const Tag = HEADINGS[level];
      body = <Tag className="bn-inline-content">{inline(b.content, ctx)}</Tag>;
      // A toggle heading is shown closed (its children are in the HTML for search engines).
      if (p.isToggleable) hideKids = true;
      break;
    }
    case "numberedListItem":
      attrs["data-index"] = String(index);
      body = <p className="bn-inline-content">{inline(b.content, ctx)}</p>;
      break;
    case "checkListItem":
      if (p.checked) attrs["data-checked"] = "true";
      body = (
        <>
          <input type="checkbox" checked={Boolean(p.checked)} readOnly tabIndex={-1} aria-hidden="true" />
          <p className="bn-inline-content">{inline(b.content, ctx)}</p>
        </>
      );
      break;
    case "quote":
      body = <blockquote className="bn-inline-content">{inline(b.content, ctx)}</blockquote>;
      break;
    case "codeBlock":
    case "mermaid":
      body = (
        <pre>
          <code className="bn-inline-content">{b.type === "mermaid" ? str(p.code) : inline(b.content, ctx)}</code>
        </pre>
      );
      break;
    case "equation":
      body = (
        <pre>
          <code>{str(p.latex)}</code>
        </pre>
      );
      break;
    case "divider":
      body = <hr />;
      break;
    case "callout":
      body = (
        <div className="nt-callout" data-color={typeof p.color === "string" ? p.color : undefined}>
          <div className="nt-callout-icon">
            <NoteIcon icon={str(p.icon) || "💡"} />
          </div>
          <div className="nt-callout-body">
            <p className="bn-inline-content">{inline(b.content, ctx)}</p>
          </div>
        </div>
      );
      break;
    case "image":
    case "video":
    case "audio":
    case "file":
      body = <Media b={b} ctx={ctx} />;
      break;
    case "table": {
      const rows = tableRows(b.content);
      body = (
        <table className="nt-static-table">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{inline(c, ctx, `t${i}-${j}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      break;
    }
    case "toggleListItem":
      // BlockNote's own toggle markup (closed); the children stay in the HTML.
      hideKids = true;
      body = (
        <div>
          <div className="bn-toggle-wrapper" data-show-children="false">
            <button className="bn-toggle-button" type="button" tabIndex={-1} aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
                <path d="M320-200v-560l440 280-440 280Z" />
              </svg>
            </button>
            <p className="bn-inline-content">{inline(b.content, ctx)}</p>
          </div>
        </div>
      );
      break;
    case "columnList":
      body = (
        <div className="nt-cols" data-node-type="columnList">
          {(kids ?? []).map((c, i) => (
            <div key={c.id ?? i} className="nt-col" data-node-type="column" style={typeof c.props?.width === "number" && c.props.width !== 1 ? { flexGrow: c.props.width } : undefined}>
              {Array.isArray(c.children) && <Group blocks={c.children} ctx={ctx} depth={depth + 1} />}
            </div>
          ))}
        </div>
      );
      kids = null;
      break;
    case "tabs":
      // The bar is radio buttons: tabs switch without a script (notes.css shows the checked one's panel).
      body = (
        <div className="nt-tabs nt-tabs-static" data-node-type="tabs">
          <div className="nt-tabs-bar" role="radiogroup">
            {(kids ?? []).map((c, i) => (
              <label key={c.id ?? i}>
                <input type="radio" name={`tabs-${b.id ?? depth}`} defaultChecked={i === 0} />
                {str(c.props?.title).trim() || ctx.t("tabs.untitled", { n: i + 1 })}
              </label>
            ))}
          </div>
          <div className="nt-tabs-body">
            {(kids ?? []).map((c, i) => (
              <div key={c.id ?? i} className="nt-tab" data-node-type="tab">
                {Array.isArray(c.children) && <Group blocks={c.children} ctx={ctx} depth={depth + 1} />}
              </div>
            ))}
          </div>
        </div>
      );
      kids = null;
      break;
    case "page":
    case "database": {
      const note = ctx.byId.get(str(p.noteId));
      if (!note) {
        body = null;
        break;
      }
      // An inline database shows its first view; a page (or a full-page database) is a link.
      if (b.type === "database" && note.kind === "database" && note.inline) {
        body = <StaticDatabase db={note} ctx={ctx} scope={str(p.view) || undefined} />;
        break;
      }
      body = (
        <a className="nt-pageblock" href={`#${note.id}`}>
          <span className="nt-pageblock-icon">
            <NoteIcon icon={note.icon} fallback="📄" />
          </span>
          <span className="nt-pageblock-title">{displayTitle(note, ctx.t("page.untitled"))}</span>
        </a>
      );
      break;
    }
    case "bookmark": {
      const to = href(str(p.url), ctx);
      body = to ? (
        <a className="nt-bookmark" href={to} target="_blank" rel="noopener noreferrer nofollow">
          <span className="nt-bookmark-text">
            <span className="nt-bookmark-title">{str(p.title) || to}</span>
            {str(p.description) && <span className="nt-bookmark-desc">{str(p.description)}</span>}
            <span className="nt-bookmark-url">{to}</span>
          </span>
        </a>
      ) : null;
      break;
    }
    case "embed": {
      const to = str(p.url).startsWith("https:") ? str(p.url) : "";
      body = to ? (
        <a href={to} target="_blank" rel="noopener noreferrer nofollow">
          {to}
        </a>
      ) : null;
      break;
    }
    case "toc": {
      const heads = outlineOf(ctx.page.content);
      body = heads.length ? (
        <ul className="nt-toc">
          {heads.map((h) => (
            <li key={h.id} data-level={h.level}>
              {h.text || ctx.t("page.untitled")}
            </li>
          ))}
        </ul>
      ) : null;
      break;
    }
    case "design":
      // Only the frame's name: the design itself is never public through a document.
      body = <div className="nt-static-box">{str(p.name)}</div>;
      break;
    case "synced": {
      const src = ctx.byId.get(str(p.noteId));
      if (!src || ctx.synced.has(src.id) || depth > 20) {
        body = null;
        break;
      }
      body = <Group blocks={Array.isArray(src.content) ? (src.content as Block[]) : []} ctx={{ ...ctx, synced: new Set([...ctx.synced, src.id]) }} depth={depth + 1} />;
      break;
    }
    case "button":
    case "breadcrumb":
      body = null;
      break;
    default:
      body = <p className="bn-inline-content">{inline(b.content, ctx)}</p>;
  }
  if (body === null && !kids) return null;
  return (
    <div className="bn-block-outer" data-node-type="blockOuter">
      <div className="bn-block" data-node-type="blockContainer" data-id={b.id}>
        <div className="bn-block-content" {...attrs}>
          {body}
        </div>
        {kids && depth < 40 && (
          <div hidden={hideKids || undefined}>
            <Group blocks={kids} ctx={ctx} depth={depth + 1} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A database as a plain table of its first view (rows link to their pages in the copy). */
function StaticDatabase({ db, ctx, scope }: { db: Note; ctx: Ctx; scope?: string }) {
  if (!db.db) return null;
  const notes = [...ctx.byId.values()];
  // One table per published data source (lib/notes/sources.ts).
  const tables = sourceTables(db, notes, scope);
  return (
    <div className="nt-db" style={{ margin: "8px 0" }}>
      {db.inline && (
        <div className="nt-db-titlebar">
          <div className="nt-db-title">{displayTitle(db, ctx.t("db.untitled"))}</div>
        </div>
      )}
      {tables.map(({ view, src }) => (
        <StaticSourceTable key={src.id} db={db} src={src} view={view} caption={tables.length > 1} notes={notes} ctx={ctx} />
      ))}
    </div>
  );
}

function StaticSourceTable({ db, src, view, caption, notes, ctx }: { db: Note; src: Note; view: DbView | undefined; caption: boolean; notes: Note[]; ctx: Ctx }) {
  const schema = { ...(src.db as DbSchema), views: db.db?.views ?? [] };
  const rows = view ? applyView(rowsOf(src.id, notes), { ...view, filters: [] }, schema, "", ctx.locale) : rowsOf(src.id, notes);
  const props = (view ? visibleProps(schema, view) : schema.properties).filter((p) => p.type !== "button");
  return (
    <>
      {caption && <div className="nt-db-srccaption">{sourceName(db, src, ctx.t("db.untitled"))}</div>}
      <div className="nt-table-wrap">
        <table className="nt-static-table nt-static-db">
          <thead>
            <tr>
              {props.map((p) => (
                <th key={p.id}>{p.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((r) => (
              <tr key={r.id}>
                {props.map((p) => {
                  if (p.type === "title")
                    return (
                      <td key={p.id}>
                        <a href={`#${r.id}`}>{r.title || ctx.t("db.untitled")}</a>
                      </td>
                    );
                  const v = propValue(r, p);
                  if ((p.type === "select" || p.type === "status") && typeof v === "string") {
                    const o = optionById(p, v);
                    return <td key={p.id}>{o ? <span className={p.type === "status" ? "nt-tag nt-tag-status" : "nt-tag"} data-color={o.color}>{o.name}</span> : null}</td>;
                  }
                  if (p.type === "multi_select" && Array.isArray(v))
                    return (
                      <td key={p.id}>
                        {v.map((id) => {
                          const o = optionById(p, id);
                          return o ? (
                            <span key={id} className="nt-tag" data-color={o.color}>
                              {o.name}
                            </span>
                          ) : null;
                        })}
                      </td>
                    );
                  // People are not named on a public page.
                  if (p.type === "person" || p.type === "created_by" || p.type === "last_edited_by") return <td key={p.id} />;
                  return <td key={p.id}>{valueText(p, v, ctx.locale)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The page outline beside a published page (site setting "Show page outline"). */
export function PublicOutline({ note, label, untitled }: { note: Note; label: string; untitled: string }) {
  const heads = outlineOf(note.content);
  if (heads.length < 2) return null;
  return (
    <nav className="nt-pub-outline" aria-label={label}>
      {heads.map((h) => (
        <span key={h.id} className="nt-pub-outline-item" data-level={h.level} data-target={h.id}>
          {h.text || untitled}
        </span>
      ))}
    </nav>
  );
}

/** Forces the site theme before the first paint (site setting "Theme"); the visitor's own otherwise. */
export function SiteThemeScript({ theme, nonce }: { theme: SiteOptions["theme"]; nonce?: string }) {
  if (!theme) return null;
  const js = `(function(){var r=document.documentElement;r.classList.toggle("dark",${theme === "dark"});r.style.colorScheme="${theme}";})();`;
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: js }} />;
}

/** `app`: zvena's own address when served on a site's custom domain (links to zvena leave that domain); "" on zvena itself. */
export function PublicStatic({ notes, rootId, options, updatedAt, locale, base, shareId, app = "" }: { notes: Note[]; rootId: string; options?: SiteOptions; updatedAt: number; locale: string; base: string; shareId: string; app?: string }) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const note = byId.get(rootId);
  const t = (k: NotesKey, vars?: Record<string, string | number>) => notesT(locale, k, vars);
  if (!note) return <div className="nt-pub" style={{ padding: 48 }}>{t("public.notFound")}</div>;
  const ctx: Ctx = { byId, locale, base, t, page: note, synced: new Set() };
  const chain = ancestry(note.id, byId).filter((n) => byId.has(n.id));
  return (
    <div className="nt-pub" data-static="true">
      <header className="nt-pub-top">
        <nav className="nt-crumbs">
          {!options?.noCrumbs &&
            chain.map((n, i) => (
              <span key={n.id} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                {i > 0 && <span className="nt-crumb-sep">/</span>}
                <a className="nt-crumb" href={n.id === rootId ? "#" : `#${n.id}`}>
                  {n.icon && (
                    <span className="nt-crumb-icon">
                      <NoteIcon icon={n.icon} />
                    </span>
                  )}
                  <span className="nt-crumb-text">{displayTitle(n, t("page.untitled"))}</span>
                </a>
              </span>
            ))}
        </nav>
        <span className="nt-pub-actions">
          {!options?.noDup && (
            <a className="nt-pub-dup" href={`${app}/docs#dup=${shareId}`} title={t("dup.hint")} rel="nofollow">
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
            {note.cover.kind === "image" && safeUrl(note.cover.value, true) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={note.cover.value} alt="" style={{ objectPosition: `center ${note.cover.y}%` }} />
            )}
          </div>
        )}
        <div className="nt-head">
          <div className="nt-head-pad">
            {note.icon && (
              <div className="nt-page-icon" style={{ cursor: "default" }}>
                <span>
                  <NoteIcon icon={note.icon} />
                </span>
              </div>
            )}
            {!note.icon && !note.cover && <div style={{ height: 80 }} />}
            <h1 className="nt-title" style={{ cursor: "default" }}>
              {displayTitle(note, t("page.untitled"))}
            </h1>
          </div>
        </div>
        <div className="nt-body">
          {note.kind === "database" ? (
            <StaticDatabase db={note} ctx={ctx} />
          ) : (
            <div className="nt-editor nt-static">
              <div className="bn-container">
                <div className="bn-editor">
                  <Group blocks={Array.isArray(note.content) ? (note.content as Block[]) : []} ctx={ctx} depth={0} />
                </div>
              </div>
            </div>
          )}
        </div>
        {options?.outline && note.kind === "page" && <PublicOutline note={note} label={t("outline.label")} untitled={t("page.untitled")} />}
        <footer className="nt-pub-foot">
          <span>{t("public.updated", { when: new Date(updatedAt).toLocaleDateString(intlOf(locale), { dateStyle: "medium" }) })}</span>
          <Link href={`${app}/`}>{t("public.by")}</Link>
          <a href={`${app}/report?url=${encodeURIComponent(`${base}/n/${shareId}`)}`} rel="nofollow">
            {t("public.report")}
          </a>
        </footer>
      </div>
    </div>
  );
}
