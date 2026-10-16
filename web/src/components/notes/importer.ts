"use client";

// Imports into zvena Documents (Notion's Import): Notion's "Markdown & CSV"
// export (.zip with nested pages, databases as CSV, images), plain
// Markdown/text, HTML (files or a zipped site), Word (.docx), Confluence
// space exports, Trello boards (JSON), CSV from Asana, Jira or a spreadsheet
// (→ database) and Evernote (.enex). Big imports report progress and yield
// to the page between files, so the tab never freezes.

import { blankNote, defaultView, linkedChildIds, newNoteId, shortId } from "@/lib/notes/model";
import { sourceView } from "@/lib/notes/sources";
import type { NotesStore } from "@/lib/notes/store";
import type { DbProperty, DbSchema, Note, PropValue, SelectOption } from "@/lib/notes/types";
import { NOTE_COLORS } from "@/lib/notes/types";
import { inferType, isTrelloBoard, notionSources, parseCsv, titleColumn, toIsoDate, trelloPlan } from "@/lib/notes/import-formats";
import { unzip, type UnzippedFile } from "@/lib/notes/zip";
import { htmlToBlocks, markdownToBlocks } from "./md-blocks";
import { notesT } from "@/lib/notes/i18n";

/** The interface language (imported databases get their column names in it). */
const uiLang = (): string => (typeof document !== "undefined" && document.documentElement.lang) || "en";

export { parseCsv };

/** Import progress: files handled so far of all. */
export type ImportProgress = (done: number, total: number) => void;

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

const NOTION_ID = /\s+[0-9a-f]{32}$/i;
const dec = new TextDecoder("utf-8");

function baseName(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

function cleanTitle(s: string): string {
  return s.replace(NOTION_ID, "").trim();
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// ---------------------------------------------------------------------------
// CSV → database

const OPT_COLORS = NOTE_COLORS.filter((c) => c !== "default");

/**
 * A database from CSV rows (first row = property names, first column =
 * title); `rowId` may name a row's id ahead (links to it). `pickTitle`: the
 * title is the Name / Summary / Title column wherever it is (Asana, Jira).
 */
export function csvToDatabase(store: NotesStore, title: string, rows: string[][], parentId: string | null, rowBodies?: Map<string, unknown[]>, dbId?: string, rowId?: (title: string) => string | undefined, pickTitle = false): Note {
  const tc = pickTitle ? titleColumn(rows[0] ?? []) : 0;
  if (tc > 0) rows = rows.map((r) => [r[tc] ?? "", ...r.filter((_, i) => i !== tc)]);
  const head = rows[0] ?? ["Name"];
  const data = rows.slice(1);
  const properties: DbProperty[] = [{ id: "title", name: head[0] || "Name", type: "title" }];
  const colProps: (DbProperty | null)[] = [null];
  for (let c = 1; c < head.length; c++) {
    const type = inferType(data.map((r) => r[c] ?? ""), head[c] ?? "");
    const prop: DbProperty = { id: shortId(), name: head[c] || `Column ${c}`, type };
    if (type === "select" || type === "multi_select") {
      const names = new Set<string>();
      for (const r of data) {
        const v = (r[c] ?? "").trim();
        if (!v) continue;
        if (type === "multi_select") v.split(/,\s*/).forEach((x) => x && names.add(x));
        else names.add(v);
      }
      prop.options = [...names].slice(0, 200).map<SelectOption>((name, i) => ({ id: shortId(), name, color: OPT_COLORS[i % OPT_COLORS.length] }));
    }
    properties.push(prop);
    colProps.push(prop);
  }
  const schema: DbSchema = { properties, views: [] };
  schema.views.push(defaultView("table", notesT(uiLang(), "db.table"), schema));
  const db = store.create({ kind: "database", parentId, title, icon: "", db: schema, ...(dbId ? { id: dbId } : {}) });
  let order = Date.now();
  const used = new Set<string>();
  for (const r of data) {
    const props: Record<string, PropValue> = {};
    for (let c = 1; c < head.length; c++) {
      const prop = colProps[c];
      const raw = (r[c] ?? "").trim();
      if (!prop || !raw) continue;
      if (prop.type === "checkbox") props[prop.id] = /^(yes|true|да|✓|x)$/i.test(raw);
      else if (prop.type === "number") props[prop.id] = Number(raw.replace(/\s/g, "").replace(",", ".").replace("%", ""));
      else if (prop.type === "date") {
        const [a, b] = raw.split(" → ");
        const s = toIsoDate(a);
        const e = b ? toIsoDate(b) : null;
        if (s) props[prop.id] = e ? { start: s, end: e } : { start: s };
      } else if (prop.type === "select") props[prop.id] = prop.options?.find((o) => o.name === raw)?.id ?? null;
      else if (prop.type === "multi_select") props[prop.id] = raw.split(/,\s*/).map((x) => prop.options?.find((o) => o.name === x)?.id).filter((x): x is string => Boolean(x));
      else props[prop.id] = raw;
    }
    const rowTitle = (r[0] ?? "").trim();
    // Two rows with one title: the second gets an id of its own.
    const id = rowId?.(rowTitle);
    const own = id && !used.has(id) ? id : undefined;
    if (own) used.add(own);
    store.put({ ...blankNote({ kind: "page", parentId: db.id, title: rowTitle, props, content: rowBodies?.get(rowTitle) ?? [] }), ...(own ? { id: own } : {}), order: order++ });
  }
  return db;
}

// ---------------------------------------------------------------------------
// Markdown with images from the ZIP

async function uploadImages(md: string, dir: string, files: Map<string, UnzippedFile>, upload: (f: File) => Promise<string>): Promise<string> {
  // "Image (1).png": one level of parentheses belongs to the path.
  const refs = [...md.matchAll(/!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+)\)/g)];
  let out = md;
  for (const m of refs) {
    const src = m[2].trim();
    if (/^(https?:|data:)/.test(src)) continue;
    let path: string;
    try {
      path = decodeURIComponent(src);
    } catch {
      path = src;
    }
    const full = dir ? `${dir}/${path}` : path;
    const f = files.get(full) ?? files.get(path);
    if (!f) continue;
    try {
      const url = await upload(new File([f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer], baseName(f.name) + (f.name.match(/\.[^.]+$/)?.[0] ?? "")));
      out = out.split(`](${m[2]})`).join(`](${url})`);
    } catch {
      // Keep the broken reference; the rest of the page still imports.
    }
  }
  return out;
}

/**
 * Links to other files of the ZIP (PDFs, documents, audio… next to a
 * Notion page) are uploaded too and point at the uploaded file; links to
 * pages (.md, .csv, .html) are left to the page linking.
 */
async function uploadLinkedFiles(md: string, dir: string, files: Map<string, UnzippedFile>, upload: (f: File) => Promise<string>): Promise<string> {
  let out = md;
  const done = new Map<string, string>();
  for (const m of md.matchAll(/(?<!!)\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g)) {
    const href = m[2].trim();
    if (/^(https?:|mailto:|data:|\/|#)/i.test(href) || /\.(md|markdown|csv|html?)$/i.test(href) || done.has(href)) continue;
    let path: string;
    try {
      path = decodeURIComponent(href);
    } catch {
      path = href;
    }
    const f = files.get(normalizePath(dir ? `${dir}/${path}` : path)) ?? files.get(path);
    if (!f) continue;
    try {
      const url = await upload(new File([f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer], f.name.split("/").pop() || "file"));
      done.set(href, url);
    } catch {
      // Not an allowed type or over the limit: the link stays as it was.
    }
  }
  for (const [href, url] of done) out = out.split(`](${href})`).join(`](${url})`);
  return out;
}

/** <img src="…"> files of the ZIP go to Documents' files (an HTML site or a Confluence export). */
async function uploadHtmlImages(html: string, dir: string, files: Map<string, UnzippedFile>, upload: (f: File) => Promise<string>): Promise<string> {
  let out = html;
  const seen = new Map<string, string>();
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc=(["'])([^"']+)\1/gi)) {
    const src = m[2];
    if (/^(https?:|data:|\/)/i.test(src) || seen.has(src)) continue;
    let path: string;
    try {
      path = decodeURIComponent(src.split("?")[0]);
    } catch {
      path = src.split("?")[0];
    }
    const f = files.get(normalizePath(dir ? `${dir}/${path}` : path)) ?? files.get(path);
    if (!f) continue;
    try {
      const url = await upload(new File([f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer], f.name.split("/").pop() || "image"));
      seen.set(src, url);
    } catch {
      // Keep the broken reference; the rest of the page still imports.
    }
  }
  for (const [src, url] of seen) out = out.split(`"${src}"`).join(`"${url}"`).split(`'${src}'`).join(`'${url}'`);
  return out;
}

/** "a/b/../c.png" → "a/c.png" (paths inside a ZIP). */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

/** Links between the imported HTML files point at the new pages. */
function htmlPageLinks(html: string, dir: string, idOf: (path: string) => string | undefined): string {
  return html.replace(/(<a\b[^>]*?\shref=)(["'])([^"'#?]+\.html?)([#?][^"']*)?\2/gi, (whole, pre: string, q: string, href: string) => {
    if (/^https?:/i.test(href)) return whole;
    let path: string;
    try {
      path = decodeURIComponent(href);
    } catch {
      path = href;
    }
    const id = idOf(normalizePath(dir ? `${dir}/${path}` : path)) ?? idOf(path);
    return id ? `${pre}${q}/docs#${id}${q}` : whole;
  });
}

/** A Notion HTML export's body without the title heading (it becomes the page title); a row's property table stays. */
function htmlBody(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.querySelector(".page-body");
  if (!body) return html;
  return (doc.querySelector("header table.properties")?.outerHTML ?? "") + body.innerHTML;
}

/**
 * "# Title" first, then the body. Notion's database rows also start with
 * "Prop: value" lines (their values come from the CSV): those are split off
 * for rows only, so a page opening with "Note: …" keeps that line.
 */
function splitNotionMd(md: string, row = false): { title: string | null; body: string } {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let title: string | null = null;
  let i = 0;
  if (/^#\s+/.test(lines[0] ?? "")) {
    title = lines[0].replace(/^#\s+/, "").trim();
    i = 1;
  }
  // Property block: consecutive "Key: value" lines right after the title.
  let j = i;
  while (j < lines.length && !lines[j].trim()) j++;
  let k = j;
  while (k < lines.length && /^[^\s#>*\-|][^:]{0,60}: .+/.test(lines[k])) k++;
  const body = (row && k > j && k - j <= 30 ? lines.slice(k) : lines.slice(i)).join("\n");
  return { title, body: notionAside(body) };
}

/** Notion exports callouts as <aside> HTML: turn them into quotes. */
function notionAside(md: string): string {
  return md.replace(/<aside>\s*([\s\S]*?)\s*<\/aside>/g, (_m, inner: string) =>
    inner
      .split("\n")
      .map((l) => `> ${l.replace(/<[^>]+>/g, "")}`)
      .join("\n")
  );
}

export interface ImportResult {
  root: Note | null;
  pages: number;
}

/** Notion "Markdown & CSV" export, or any zip of .md/.csv/.html files. */
export async function importZip(buf: ArrayBuffer, store: NotesStore, upload: (f: File) => Promise<string>, parentId: string | null, rootTitle: string, onProgress?: ImportProgress): Promise<ImportResult> {
  const all = await unzip(buf);
  const files = new Map(all.map((f) => [f.name, f]));
  if (isConfluence(all)) return importConfluence(all, files, store, upload, parentId, rootTitle, onProgress);
  const docs = all.filter((f) => /\.(md|markdown|txt|csv|html?)$/i.test(f.name) && !/(^|\/)__MACOSX\//.test(f.name) && !/_all\.csv$/i.test(f.name));
  const root = store.create({ kind: "page", parentId, title: rootTitle, icon: "📥", content: [] });
  let pages = 0;
  // Folder → created note (a page "X abc.md" owns the folder "X abc/").
  const owner = new Map<string, string>();
  owner.set("", root.id);
  const byDepth = [...docs].sort((a, b) => a.name.split("/").length - b.name.split("/").length || a.name.localeCompare(b.name));
  const parentOf = (path: string): string => {
    let dir = parentDir(path);
    while (dir && !owner.has(dir)) dir = parentDir(dir);
    return owner.get(dir) ?? root.id;
  };
  // Row bodies of CSV databases: "DB abc/Row xyz.md" next to "DB abc.csv".
  const csvDirs = new Set(docs.filter((f) => /\.csv$/i.test(f.name)).map((f) => f.name.replace(/\.csv$/i, "")));
  // A database with several data sources (Notion, 2025) exports one CSV per
  // source: "DB abc.csv" (the first) with the others inside "DB abc/" (rows
  // are .md there, so a CSV there is a data source), or only CSVs in a
  // folder no page owns. Each further CSV becomes a data source of the first.
  const sourceOf = notionSources(docs.map((f) => f.name));
  const sourceIds = new Map<string, string>();
  // Every page gets its id up front, so a parent's "[Child](Child abc.md)"
  // line can become the child's page block right where Notion had it.
  const idOf = new Map<string, string>();
  for (const f of docs) idOf.set(f.name, newNoteId());
  const linkedId = (href: string, dir: string): string | undefined => {
    let path: string;
    try {
      path = decodeURIComponent(href);
    } catch {
      path = href;
    }
    return idOf.get(dir ? `${dir}/${path}` : path) ?? idOf.get(path);
  };
  // A link alone on its line is the child's place; one inside text stays a link, to the imported page.
  const childLinks = (md: string, dir: string): string =>
    md
      // Spaces only around it: \s would swallow the blank lines and glue the marker to the next paragraph.
      .replace(/^[ \t]*\[([^\]]+)\]\(([^)]+\.(?:md|csv|html?))\)[ \t]*$/gim, (line, _t: string, href: string) => {
        const id = linkedId(href, dir);
        return id ? `${PAGE_MARK}${id}${PAGE_MARK}` : line;
      })
      .replace(/\]\(([^)\s]+\.(?:md|csv|html?))\)/gi, (link, href: string) => {
        const id = linkedId(href, dir);
        return id ? `](/docs#${id})` : link;
      });
  const links: { parent: string; child: string; kind: "page" | "database" }[] = [];
  for (const f of byDepth) {
    const dir = parentDir(f.name);
    if (csvDirs.has(dir) && /\.md$/i.test(f.name)) continue; // handled with its CSV
    const text = dec.decode(f.data);
    const title = cleanTitle(baseName(f.name));
    const parent = parentOf(f.name);
    let note: Note;
    if (/\.csv$/i.test(f.name)) {
      const rowsDir = f.name.replace(/\.csv$/i, "");
      const bodies = new Map<string, unknown[]>();
      // Each row page keeps the id links to its file were given; its folder (sub-pages, files) by the row's title.
      const rowIds = new Map<string, string>();
      const rowDirs = new Map<string, string>();
      for (const rf of docs) {
        if (parentDir(rf.name) !== rowsDir || !/\.md$/i.test(rf.name)) continue;
        const split = splitNotionMd(dec.decode(rf.data), true);
        const md = childLinks(await uploadLinkedFiles(await uploadImages(split.body, parentDir(rf.name), files, upload), parentDir(rf.name), files, upload), parentDir(rf.name));
        const key = split.title ?? cleanTitle(baseName(rf.name));
        bodies.set(key, placePageBlocks(markdownToBlocks(md)));
        const id = idOf.get(rf.name);
        if (id && !rowIds.has(key)) {
          rowIds.set(key, id);
          rowDirs.set(key, rf.name.replace(/\.md$/i, ""));
        }
      }
      // Notion writes the open view's rows to "DB.csv" and every row to "DB_all.csv".
      const every = files.get(`${rowsDir}_all.csv`);
      const src = sourceOf.get(f.name);
      const host = src?.host ? store.get(sourceIds.get(src.host) ?? "") : undefined;
      note = csvToDatabase(store, title, parseCsv(every ? dec.decode(every.data) : text), host ? host.id : parent, bodies, idOf.get(f.name), (rowTitle) => rowIds.get(rowTitle));
      sourceIds.set(f.name, note.id);
      if (host?.db && note.db) {
        // A further data source: marked so, with a view tab in its database.
        store.update(note.id, { db: { ...note.db, dataSource: true } }, { quiet: true });
        store.update(host.id, { db: { ...host.db, views: [...host.db.views, sourceView("table", notesT(uiLang(), "db.table"), host.id, note.id, note.db)] } }, { quiet: true });
      } else if (src && !src.host && note.db && src.folder) {
        // The first source of a database exported as a folder: the database takes the folder's name.
        store.update(note.id, { title: cleanTitle(baseName(src.folder)), db: { ...note.db, label: { name: title } } }, { quiet: true });
      }
      // Pages inside a row's folder belong to that row, not to the database as extra rows.
      for (const [key, id] of rowIds) if (store.get(id)?.parentId === note.id) owner.set(rowDirs.get(key) as string, id);
      if (!host) links.push({ parent, child: note.id, kind: "page" });
    } else if (/\.html?$/i.test(f.name)) {
      const t = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
      const html = htmlPageLinks(await uploadHtmlImages(htmlBody(text), dir, files, upload), dir, (path) => idOf.get(path));
      note = store.create({ id: idOf.get(f.name), kind: "page", parentId: parent, title: t ? decodeEntities(t) : title, content: htmlToBlocks(html) });
      links.push({ parent, child: note.id, kind: "page" });
    } else {
      const split = splitNotionMd(text);
      const md = childLinks(await uploadLinkedFiles(await uploadImages(split.body, dir, files, upload), dir, files, upload), dir);
      note = store.create({ id: idOf.get(f.name), kind: "page", parentId: parent, title: split.title ?? title, content: placePageBlocks(markdownToBlocks(md)) });
      links.push({ parent, child: note.id, kind: "page" });
    }
    pages += 1;
    owner.set(f.name.replace(/\.[^.]+$/, ""), note.id);
    onProgress?.(pages, byDepth.length);
    if (pages % 5 === 0) await yieldToUi();
  }
  // Sub-pages show up in their parent's body as page blocks.
  const byParent = new Map<string, string[]>();
  for (const l of links) byParent.set(l.parent, [...(byParent.get(l.parent) ?? []), l.child]);
  for (const [pid, kids] of byParent) {
    const p = store.get(pid);
    if (!p || p.kind !== "page") continue;
    // Child blocks already placed anywhere in the body (also inside toggles and lists).
    const existing = new Set(linkedChildIds(p.content));
    const add = kids.filter((k) => !existing.has(k)).map((k) => ({ type: "page", props: { noteId: k } }));
    if (add.length) store.update(pid, { content: [...p.content.filter((b) => !isEmptyPara(b)), ...add] }, { quiet: true });
  }
  return { root, pages };
}

const PAGE_MARK = "§§NTPAGE§§";

/** Paragraphs holding a child-page marker become page blocks. */
function placePageBlocks(blocks: unknown[]): unknown[] {
  return blocks.map((raw) => {
    const b = raw as { type?: string; content?: unknown; children?: unknown[] };
    if (b?.type === "paragraph") {
      const text = Array.isArray(b.content) ? (b.content as { text?: string }[]).map((c) => c.text ?? "").join("") : typeof b.content === "string" ? b.content : "";
      const m = new RegExp(`^${PAGE_MARK}([A-Za-z0-9_-]+)${PAGE_MARK}$`).exec(text.trim());
      if (m) return { type: "page", props: { noteId: m[1] } };
    }
    return Array.isArray(b?.children) && b.children.length ? { ...b, children: placePageBlocks(b.children) } : raw;
  });
}

function isEmptyPara(b: unknown): boolean {
  const x = b as { type?: string; content?: unknown };
  return x?.type === "paragraph" && (!x.content || (Array.isArray(x.content) && x.content.length === 0) || x.content === "");
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

// ---------------------------------------------------------------------------
// Confluence (Space export as HTML: index.html, Page-Title_123.html, attachments/)

function isConfluence(all: UnzippedFile[]): boolean {
  const html = all.filter((f) => /\.html?$/i.test(f.name));
  if (!html.some((f) => /(^|\/)index\.html$/i.test(f.name))) return false;
  return html.slice(0, 20).some((f) => {
    const head = dec.decode(f.data.subarray(0, 20_000));
    return /id="main-content"/.test(head) && /id="breadcrumbs"|confluence/i.test(head);
  });
}

async function importConfluence(all: UnzippedFile[], files: Map<string, UnzippedFile>, store: NotesStore, upload: (f: File) => Promise<string>, parentId: string | null, rootTitle: string, onProgress?: ImportProgress): Promise<ImportResult> {
  const pagesHtml = all.filter((f) => /\.html?$/i.test(f.name) && !/(^|\/)index\.html$/i.test(f.name) && !/(^|\/)(styles|images|attachments)\//.test(f.name));
  const index = all.find((f) => /(^|\/)index\.html$/i.test(f.name));
  const indexDoc = index ? new DOMParser().parseFromString(dec.decode(index.data), "text/html") : null;
  const space = indexDoc?.querySelector("#title-text, title")?.textContent?.split(" : ")[0]?.trim();
  const root = store.create({ kind: "page", parentId, title: space || rootTitle, icon: "📚", content: [] });
  const idOf = new Map<string, string>();
  for (const f of pagesHtml) idOf.set(f.name, newNoteId());
  // Parents from each page's breadcrumbs (the last crumb is the direct parent).
  const parsed = pagesHtml.map((f) => {
    const doc = new DOMParser().parseFromString(dec.decode(f.data), "text/html");
    const dir = parentDir(f.name);
    const crumbs = [...doc.querySelectorAll("#breadcrumbs li a")].map((a) => a.getAttribute("href") ?? "").filter((h) => h && !/index\.html?$/i.test(h));
    const parentHref = crumbs[crumbs.length - 1];
    const parentFile = parentHref ? normalizePath(dir ? `${dir}/${parentHref}` : parentHref) : null;
    const heading = doc.querySelector("#title-text")?.textContent ?? doc.title;
    const title = (heading.includes(" : ") ? heading.split(" : ").slice(1).join(" : ") : heading).trim() || cleanTitle(baseName(f.name));
    const body = doc.querySelector("#main-content")?.innerHTML ?? doc.body.innerHTML;
    return { f, dir, title, body, parentFile };
  });
  const byFile = new Map(parsed.map((x) => [x.f.name, x]));
  const depth = (x: (typeof parsed)[number]): number => {
    let d = 0;
    for (let cur = x.parentFile; cur && byFile.has(cur) && d < 50; cur = byFile.get(cur)?.parentFile ?? null) d++;
    return d;
  };
  const ordered = [...parsed].sort((a, b) => depth(a) - depth(b));
  const kids = new Map<string, string[]>();
  let done = 0;
  for (const x of ordered) {
    const parent = x.parentFile && idOf.has(x.parentFile) ? (idOf.get(x.parentFile) as string) : root.id;
    const html = htmlPageLinks(await uploadHtmlImages(x.body, x.dir, files, upload), x.dir, (path) => idOf.get(path));
    const note = store.create({ id: idOf.get(x.f.name), kind: "page", parentId: parent, title: decodeEntities(x.title), content: htmlToBlocks(html) });
    kids.set(parent, [...(kids.get(parent) ?? []), note.id]);
    done += 1;
    onProgress?.(done, ordered.length);
    if (done % 5 === 0) await yieldToUi();
  }
  for (const [pid, list] of kids) {
    const p = store.get(pid);
    if (!p) continue;
    const existing = new Set(linkedChildIds(p.content));
    const add = list.filter((k) => !existing.has(k)).map((k) => ({ type: "page", props: { noteId: k } }));
    if (add.length) store.update(pid, { content: [...p.content.filter((b) => !isEmptyPara(b)), ...add] }, { quiet: true });
  }
  return { root, pages: done };
}

// ---------------------------------------------------------------------------
// Trello (board → Export as JSON)

function importTrello(json: unknown, store: NotesStore, parentId: string | null, lang: string): ImportResult {
  const plan = trelloPlan(json, shortId);
  const statusProp: DbProperty = {
    id: shortId(),
    name: notesT(lang, "db.status"),
    type: "status",
    options: plan.statuses.map((x) => ({ id: x.id, name: x.name, color: x.group === "done" ? "green" : x.group === "doing" ? "blue" : "default", group: x.group })),
  };
  const labelsProp: DbProperty = { id: shortId(), name: notesT(lang, "db.labels"), type: "multi_select", options: plan.labels };
  const dueProp: DbProperty = { id: shortId(), name: notesT(lang, "db.due"), type: "date" };
  const membersProp: DbProperty = { id: shortId(), name: notesT(lang, "ts.members"), type: "text" };
  const linkProp: DbProperty = { id: shortId(), name: "Trello", type: "url" };
  const schema: DbSchema = { properties: [{ id: "title", name: notesT(lang, "db.name"), type: "title" }, statusProp, labelsProp, dueProp, membersProp, linkProp], views: [] };
  schema.views.push({ ...defaultView("board", notesT(lang, "db.board"), schema), groupBy: statusProp.id });
  schema.views.push(defaultView("table", notesT(lang, "db.table"), schema));
  const db = store.create({ kind: "database", parentId, title: plan.title, icon: "📋", db: schema });
  let order = Date.now();
  for (const r of plan.rows) {
    const props: Record<string, PropValue> = {};
    const status = statusProp.options?.find((o) => o.name === r.status);
    if (status) props[statusProp.id] = status.id;
    if (r.labels.length) props[labelsProp.id] = r.labels;
    if (r.due) props[dueProp.id] = { start: r.due };
    if (r.members) props[membersProp.id] = r.members;
    if (r.url) props[linkProp.id] = r.url;
    const content: unknown[] = r.description.trim() ? markdownToBlocks(r.description) : [];
    for (const c of r.checklists) {
      content.push({ type: "heading", props: { level: 3 }, content: c.name });
      for (const item of c.items) content.push({ type: "checkListItem", props: { checked: item.done }, content: item.text });
    }
    if (r.comments.length) {
      content.push({
        type: "toggleListItem",
        content: `${notesT(lang, "comments.title")} (${r.comments.length})`,
        children: r.comments.map((c) => ({ type: "paragraph", content: [{ type: "text", text: `${c.author || "?"}${c.at ? ` · ${c.at.slice(0, 10)}` : ""}: `, styles: { bold: true } }, { type: "text", text: c.text, styles: {} }] })),
      });
    }
    store.put({ ...blankNote({ kind: "page", parentId: db.id, title: r.title, props, content }), order: order++ });
  }
  return { root: db, pages: plan.rows.length + 1 };
}

/** Evernote .enex: one page per note. */
export function importEnex(text: string, store: NotesStore, parentId: string | null, rootTitle: string): ImportResult {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const notes = [...doc.getElementsByTagName("note")];
  const root = store.create({ kind: "page", parentId, title: rootTitle, icon: "🐘", content: [] });
  const ids: string[] = [];
  for (const n of notes) {
    const title = n.getElementsByTagName("title")[0]?.textContent?.trim() || "Untitled";
    const content = n.getElementsByTagName("content")[0]?.textContent ?? "";
    const html = content.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, "").replace(/<\/?en-note[^>]*>/g, "").replace(/<en-todo checked="true"\s*\/?>/g, "☑ ").replace(/<en-todo[^>]*\/?>/g, "☐ ");
    const created = n.getElementsByTagName("created")[0]?.textContent ?? "";
    const page = store.create({ kind: "page", parentId: root.id, title, content: htmlToBlocks(html) });
    const m = /^(\d{4})(\d{2})(\d{2})T/.exec(created);
    if (m) store.update(page.id, { createdAt: new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime() }, { quiet: true });
    ids.push(page.id);
  }
  store.update(root.id, { content: ids.map((id) => ({ type: "page", props: { noteId: id } })) }, { quiet: true });
  return { root, pages: notes.length };
}

/** One file of any supported type. */
export async function importFile(file: File, store: NotesStore, upload: (f: File) => Promise<string>, parentId: string | null, onProgress?: ImportProgress): Promise<ImportResult> {
  const name = file.name;
  const title = cleanTitle(baseName(name));
  const lang = uiLang();
  if (/\.zip$/i.test(name)) return importZip(await file.arrayBuffer(), store, upload, parentId, title || "Import", onProgress);
  if (/\.docx$/i.test(name)) {
    // mammoth loads only for Word files.
    const { docxToHtml } = await import("@/lib/notes/docx");
    const r = await docxToHtml(await file.arrayBuffer(), upload);
    return { root: store.create({ kind: "page", parentId, title: r.title ?? title, content: htmlToBlocks(r.html) }), pages: 1 };
  }
  const text = await file.text();
  if (/\.json$/i.test(name)) {
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (isTrelloBoard(json)) return importTrello(json, store, parentId, lang);
    throw new Error("unsupported json");
  }
  if (/\.enex$/i.test(name)) return importEnex(text, store, parentId, title);
  if (/\.csv$/i.test(name)) return { root: csvToDatabase(store, title, parseCsv(text), parentId, undefined, undefined, undefined, true), pages: 1 };
  if (/\.html?$/i.test(name)) {
    const t = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    return { root: store.create({ kind: "page", parentId, title: t ? decodeEntities(t) : title, content: htmlToBlocks(htmlBody(text)) }), pages: 1 };
  }
  const split = splitNotionMd(text);
  return { root: store.create({ kind: "page", parentId, title: split.title ?? title, content: markdownToBlocks(split.body) }), pages: 1 };
}


