// Notion's Export (loaded on first use): a page — with its sub-pages if asked —
// or the whole workspace as PDF (the print dialog), HTML or Markdown & CSV
// (a ZIP of pages in folders, databases as CSV, uploaded files alongside).

import { applyView, databaseToCsv, propValue, rowPropLines, rowsOf, valueText, visibleProps } from "@/lib/notes/db";
import { EXPORT_CSS, blocksToHtml, esc, inlineHtml, type HtmlContext } from "@/lib/notes/html-export";
import { noteToMarkdown, mdToHtml } from "@/lib/notes/markdown";
import { ancestry, displayTitle, iconText, subtreeIds } from "@/lib/notes/model";
import { zipFiles } from "@/lib/notes/zip";
import { hostOf, sourceName, sourcesOf, viewSourceId } from "@/lib/notes/sources";
import type { DbSchema, DbView, Note } from "@/lib/notes/types";

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function download(name: string, text: string, type: string) {
  downloadBlob(name, new Blob([text], { type }));
}

export function safeFileName(s: string): string {
  return (s || "Untitled").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
}

/** The quick exports (one file): kept for callers that need no options. */
export function exportNote(note: Note, kind: "md" | "html" | "csv", all: readonly Note[], byId: ReadonlyMap<string, Note>, locale: string) {
  const lookup = (id: string) => byId.get(id);
  const parent = note.parentId ? byId.get(note.parentId) : undefined;
  const propLines = parent?.kind === "database" && parent.db ? rowPropLines(note, parent.db, locale) : [];
  if (kind === "csv" && note.kind === "database") {
    download(`${safeFileName(note.title)}.csv`, databaseToCsv(note, rowsOf(note.id, all), locale), "text/csv;charset=utf-8");
    return;
  }
  const md = noteToMarkdown(note, lookup, propLines);
  if (kind === "md") {
    download(`${safeFileName(note.title)}.md`, md, "text/markdown;charset=utf-8");
    return;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(note.title)}</title><style>${EXPORT_CSS}</style></head><body>${mdToHtml(md)}</body></html>`;
  download(`${safeFileName(note.title)}.html`, html, "text/html;charset=utf-8");
}

// ---------------------------------------------------------------------------
// Notion's Export dialog

export type ExportFormat = "pdf" | "html" | "md";
export type PageFormat = "A4" | "A3" | "Letter" | "Legal" | "Tabloid";

export interface ExportOptions {
  format: ExportFormat;
  /** Databases as their current view (this device's) or their default (first) view. */
  databases: "current" | "default";
  /** Everything, or no files or images (Notion's "Include content"). */
  content: "all" | "nofiles";
  subpages: boolean;
  /** Sub-pages in folders named after their parent page. */
  folders: boolean;
  pageFormat: PageFormat;
  /** PDF scale, percent. */
  scale: number;
}

export const DEFAULT_EXPORT: ExportOptions = { format: "pdf", databases: "current", content: "all", subpages: false, folders: true, pageFormat: "A4", scale: 100 };

export interface ExportLabels {
  untitled: string;
}

const FILE_RE = /\/api\/notes\/file\/([a-f0-9]{40}\.[a-z0-9]{1,5})/g;
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Not in the trash (itself or through an ancestor), not a synced block's content or a template. */
function exportable(n: Note, byId: ReadonlyMap<string, Note>): boolean {
  if (n.synced || n.template) return false;
  return !ancestry(n.id, byId).some((x) => x.trashedAt !== null);
}

/**
 * The view a data source exports with (its database's tab of it; a source
 * without one, its own), and its schema with those views.
 */
function exportView(db: Note, which: ExportOptions["databases"], byId: ReadonlyMap<string, Note>): { view: DbView | undefined; schema: DbSchema | undefined } {
  const host = hostOf(db, byId) ?? db;
  const tabs = (host.db?.views ?? []).filter((v) => !v.scope && viewSourceId(host.id, v) === db.id);
  const views = tabs.length || host === db ? tabs : (db.db?.views.filter((v) => !v.scope) ?? []);
  const schema = db.db ? { ...db.db, views: tabs.length ? (host.db?.views ?? []) : db.db.views } : undefined;
  if (which === "current") {
    try {
      const id = localStorage.getItem(`nt-view-${host.id}`);
      const v = views.find((x) => x.id === id);
      if (v) return { view: v, schema };
    } catch {
      // No storage: the default view.
    }
  }
  return { view: views[0], schema };
}

interface Plan {
  notes: Note[];
  /** Path without extension, "Parent/Child". */
  path: Map<string, string>;
}

/** Which notes go out and under which names (pages in tree order, folders for sub-pages). */
function plan(rootIds: string[], opts: ExportOptions, all: readonly Note[], byId: ReadonlyMap<string, Note>, labels: ExportLabels): Plan {
  const included = new Set<string>();
  for (const id of rootIds) {
    const ids = opts.subpages ? subtreeIds(id, all) : [id];
    for (const x of ids) {
      const n = byId.get(x);
      if (n && exportable(n, byId)) included.add(x);
    }
  }
  // Tree order: parents before children, siblings by order.
  const kids = new Map<string | null, Note[]>();
  for (const id of included) {
    const n = byId.get(id) as Note;
    const parent = n.parentId && included.has(n.parentId) ? n.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), n]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const notes: Note[] = [];
  const path = new Map<string, string>();
  const used = new Set<string>();
  const walk = (parent: string | null, dir: string) => {
    for (const n of kids.get(parent) ?? []) {
      const base = `${dir}${safeFileName(displayTitle(n, labels.untitled))}`;
      let name = base;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`;
      used.add(name.toLowerCase());
      path.set(n.id, name);
      notes.push(n);
      walk(n.id, opts.folders ? `${name}/` : "");
    }
  };
  walk(null, "");
  return { notes, path };
}

const relTo = (from: string, to: string) => {
  const depth = from.split("/").length - 1;
  return `${"../".repeat(depth)}${to.split("/").map(encodeURIComponent).join("/")}`;
};

/** An uploaded file's name in the ZIP's files/ folder. */
const fileName = (url: string) => /\/api\/notes\/file\/([a-f0-9]{40}\.[a-z0-9]{1,5})/.exec(url)?.[1] ?? null;

function propsTable(n: Note, byId: ReadonlyMap<string, Note>, locale: string): string {
  const parent = n.parentId ? byId.get(n.parentId) : undefined;
  if (parent?.kind !== "database" || !parent.db) return "";
  const rows = parent.db.properties
    .filter((p) => p.type !== "title" && p.type !== "button")
    .map((p) => [p.name, valueText(p, propValue(n, p), locale)] as const)
    .filter(([, v]) => v);
  return rows.length ? `<table class="props">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>` : "";
}

function pageHeader(n: Note, ctx: HtmlContext, byId: ReadonlyMap<string, Note>, locale: string, labels: ExportLabels): string {
  const cover = n.cover?.kind === "image" ? ctx.fileUrl(n.cover.value) : null;
  const icon = n.icon.startsWith("/api/notes/file/") ? ctx.fileUrl(n.icon) : null;
  return [
    cover ? `<img class="page-cover" src="${esc(cover)}" alt="">` : "",
    icon ? `<img class="page-icon" src="${esc(icon)}" alt="" style="width:64px;height:64px">` : iconText(n.icon) ? `<div class="page-icon">${esc(iconText(n.icon))}</div>` : "",
    `<h1 class="page-title">${esc(displayTitle(n, labels.untitled))}</h1>`,
    propsTable(n, byId, locale),
  ].join("");
}

/**
 * Runs an export. `rootIds`: the page (and, with sub-pages, everything under
 * it) or the workspace's top-level pages. Progress counts pages and files.
 */
export async function runExport(
  rootIds: string[],
  opts: ExportOptions,
  data: { all: readonly Note[]; byId: ReadonlyMap<string, Note>; locale: string; labels: ExportLabels; zipName: string },
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const { all, byId, locale, labels } = data;
  const { notes, path } = plan(rootIds, opts, all, byId, labels);
  if (!notes.length) return;

  // Files the pages show (uploads only; another site's images stay links).
  const files = new Set<string>();
  if (opts.content === "all" && opts.format !== "pdf") {
    for (const n of notes) for (const m of JSON.stringify([n.content, n.cover, n.icon, n.props]).matchAll(FILE_RE)) files.add(m[1]);
  }
  const total = notes.length + files.size;
  let done = 0;
  const tick = async () => {
    done += 1;
    onProgress?.(done, total);
    if (done % 20 === 0) await yieldToUi();
  };

  if (opts.format === "pdf") {
    await printPdf(notes, opts, data, path);
    onProgress?.(total, total);
    return;
  }

  const out: { name: string; data: string | Uint8Array }[] = [];
  const ext = opts.format === "html" ? "html" : "md";
  for (const n of notes) {
    const own = path.get(n.id) as string;
    const href = (id: string) => (path.has(id) ? relTo(own, `${path.get(id)}.${ext}`) : null);
    const fileUrl = (url: string) => {
      if (opts.content === "nofiles") return url.startsWith("/api/notes/file/") ? null : /^https?:/i.test(url) ? url : null;
      const f = fileName(url);
      if (f) return relTo(own, `files/${f}`);
      return /^https?:/i.test(url) ? url : null;
    };
    if (opts.format === "html") {
      const ctx = htmlContext(byId, labels, href, fileUrl, (id) => databaseTable(id, opts, data, href));
      const body = n.kind === "database" ? databaseTable(n.id, opts, data, href, true) : blocksToHtml(n.content, ctx);
      out.push({ name: `${own}.html`, data: htmlDoc(displayTitle(n, labels.untitled), pageHeader(n, ctx, byId, locale, labels) + body) });
    } else {
      if (n.kind === "database") {
        // One CSV per data source (each further one is a database note under it, exported in turn).
        const { view, schema } = exportView(n, opts.databases, byId);
        const rows = rowsOf(n.id, all, { byId, locale });
        out.push({ name: `${own}.csv`, data: databaseToCsv(n, view && schema ? applyView(rows, view, schema, "", locale) : rows, locale) });
      } else {
        const parent = n.parentId ? byId.get(n.parentId) : undefined;
        const props = parent?.kind === "database" && parent.db ? rowPropLines(n, parent.db, locale) : [];
        let md = noteToMarkdown(n, (id) => byId.get(id), props);
        // Page links ([Title](<id>)) point at the exported files; uploads at files/.
        md = md.replace(/\]\(([A-Za-z0-9_-]{6,64})\)/g, (whole, id: string) => {
          const to = href(id);
          return to ? `](${to.replace(/ /g, "%20")})` : whole;
        });
        md = md.replace(/(!?)\[([^\]]*)\]\((\/api\/notes\/file\/[^)\s]+)\)/g, (_m, bang: string, text: string, url: string) => {
          const to = fileUrl(url);
          return to ? `${bang}[${text}](${to})` : bang ? "" : text;
        });
        out.push({ name: `${own}.md`, data: md });
      }
    }
    await tick();
  }
  for (const f of files) {
    try {
      const r = await fetch(`/api/notes/file/${f}`, { credentials: "same-origin" });
      if (r.ok) out.push({ name: `files/${f}`, data: new Uint8Array(await r.arrayBuffer()) });
    } catch {
      // A file that cannot be read stays a broken link in the export.
    }
    await tick();
  }
  if (out.length === 1 && typeof out[0].data === "string") {
    const only = out[0];
    download(only.name.split("/").pop() as string, only.data as string, ext === "html" ? "text/html;charset=utf-8" : only.name.endsWith(".csv") ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8");
    return;
  }
  downloadBlob(`${safeFileName(data.zipName)}.zip`, zipFiles(out));
}

function htmlContext(byId: ReadonlyMap<string, Note>, labels: ExportLabels, pageHref: (id: string) => string | null, fileUrl: (url: string) => string | null, databaseHtml: (id: string) => string): HtmlContext {
  return {
    lookup: (id) => byId.get(id),
    pageHref,
    fileUrl,
    databaseHtml,
    untitled: labels.untitled,
  };
}

function htmlDoc(title: string, body: string, extraCss = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${EXPORT_CSS}${extraCss}</style></head><body><article>${body}</article></body></html>`;
}

/** A database as tables of its data sources, each by its export view (title column links to the row pages that are exported). */
function databaseTable(id: string, opts: ExportOptions, data: { all: readonly Note[]; byId: ReadonlyMap<string, Note>; locale: string; labels: ExportLabels }, href: (id: string) => string | null, fullPage = false): string {
  const db = data.byId.get(id);
  if (!db?.db) return "";
  // A database page shows all its data sources; a data source alone, itself.
  const srcs = hostOf(db, data.byId) ? [db] : sourcesOf(db, data.all, data.byId, data.labels.untitled).flatMap((s) => (s.note?.db ? [s.note] : []));
  const ctx: HtmlContext = { lookup: (x) => data.byId.get(x), pageHref: href, fileUrl: () => null, untitled: data.labels.untitled };
  const title = fullPage ? "" : `<div class="db-title">${iconText(db.icon) ? `${esc(iconText(db.icon))} ` : ""}${inlineHtml(displayTitle(db, data.labels.untitled), ctx)}</div>`;
  return title + srcs.map((s) => (srcs.length > 1 ? `<div class="db-title">${esc(sourceName(db, s, data.labels.untitled))}</div>` : "") + sourceTable(s, opts, data, href)).join("");
}

function sourceTable(db: Note, opts: ExportOptions, data: { all: readonly Note[]; byId: ReadonlyMap<string, Note>; locale: string; labels: ExportLabels }, href: (id: string) => string | null): string {
  const { view, schema } = exportView(db, opts.databases, data.byId);
  if (!schema) return "";
  const rows = rowsOf(db.id, data.all, { byId: data.byId, locale: data.locale });
  const shown = view ? applyView(rows, view, schema, "", data.locale) : rows;
  const props = view ? visibleProps(schema, view) : schema.properties;
  const head = props.map((p) => `<th>${esc(p.name)}</th>`).join("");
  const body = shown
    .map((r) => {
      const cells = props.map((p) => {
        if (p.type === "title") {
          const to = href(r.id);
          const t = esc(displayTitle(r, data.labels.untitled));
          return `<td>${to ? `<a href="${esc(to)}">${t}</a>` : t}</td>`;
        }
        return `<td>${esc(valueText(p, propValue(r, p), data.locale))}</td>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** PDF: one printable document (sub-pages follow, each on a new sheet) in a hidden frame, then the print dialog. */
async function printPdf(notes: Note[], opts: ExportOptions, data: { all: readonly Note[]; byId: ReadonlyMap<string, Note>; locale: string; labels: ExportLabels }, path: Map<string, string>): Promise<void> {
  const { byId, locale, labels } = data;
  const anchor = (id: string) => (path.has(id) ? `#p-${id}` : null);
  const fileUrl = (url: string) => {
    if (opts.content === "nofiles") return null;
    return url.startsWith("/api/notes/file/") || /^https?:/i.test(url) ? url : null;
  };
  const parts: string[] = [];
  for (const [i, n] of notes.entries()) {
    const ctx = htmlContext(byId, labels, anchor, fileUrl, (id) => databaseTable(id, opts, data, anchor));
    const body = n.kind === "database" ? databaseTable(n.id, opts, data, anchor, true) : blocksToHtml(n.content, ctx);
    parts.push(`<section id="p-${n.id}"${i < notes.length - 1 ? ' class="page-break"' : ""}>${pageHeader(n, ctx, byId, locale, labels)}${body}</section>`);
    if (i % 20 === 19) await yieldToUi();
  }
  const scale = Math.min(200, Math.max(10, Math.round(opts.scale || 100))) / 100;
  const css = `@page{size:${opts.pageFormat};margin:16mm}body{zoom:${scale}}`;
  const doc = htmlDoc(displayTitle(notes[0], labels.untitled), parts.join(""), css);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.srcdoc = doc;
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    setTimeout(resolve, 3000);
  });
  // Images load before the dialog opens (or after 5 s at most).
  const imgs = [...(frame.contentDocument?.images ?? [])];
  await Promise.race([Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((r) => ((im.onload = r), (im.onerror = r)))))), new Promise((r) => setTimeout(r, 5000))]);
  const w = frame.contentWindow;
  if (w) {
    w.focus();
    w.print();
  }
  setTimeout(() => frame.remove(), 60_000);
}
