// Server-only: saving a web page into Documents (Notion's Web Clipper, the
// share sheet of the phone apps and of the installed web app).
//
// A clip becomes a new page: in the person's Private, under a page, or as a
// row of a database (its URL property set to the page's address). The
// article arrives as cleaned HTML (the extension runs Readability) and is
// converted here (html-blocks.ts), so nothing the browser sends is trusted
// as blocks. Pictures are downloaded through the SSRF guard of
// lib/web-read.ts into the workspace owner's file storage (their quota), or
// stay links when that fails. Everything is written through pushNotes with
// the person's own access, like an edit from their device.

import { randomUUID } from "node:crypto";
import { compressImage } from "../images";
import { payerOf, quotaLeft, recordFile } from "../storage";
import { sql } from "../store";
import { fetchFile } from "../web-read";
import { AccessResolver, atLeast, docsPresence } from "./access";
import { saveNoteFile } from "./files";
import { absoluteUrl, htmlToBlocks, imageBlocks, textToBlocks, type Block } from "./html-blocks";
import { blankNote, cleanIcon, noteSlug, orderBetween, sanitizeBlocks, sanitizeNote } from "./model";
import { inTrash, pushNotes } from "./server-store";
import { NOTE_ID_RE, NOTE_LIMITS, type Note, type PropValue } from "./types";
import "./reactions";

export const CLIP_LIMITS = {
  /** The request body (an article with its HTML). */
  bodyBytes: 4_000_000,
  htmlChars: 2_000_000,
  textChars: 100_000,
  titleChars: 300,
  blocks: 3000,
  /** Pictures downloaded per clip, each and together. */
  images: 40,
  imageBytes: 10 * 1024 * 1024,
  imagesBytes: 40 * 1024 * 1024,
  /** All downloads of one clip end by then (the rest stay links). */
  imagesDeadlineMs: 25_000,
  /** A note's JSON stays under the per-note limit with room to spare. */
  noteBytes: NOTE_LIMITS.noteBytes - 100_000,
};

export type ClipTarget = { type: "private" } | { type: "page"; id: string } | { type: "database"; id: string };
export type ClipMode = "article" | "bookmark" | "selection" | "text";

export interface ClipRequest {
  ws: string;
  target: ClipTarget;
  mode: ClipMode;
  url: string;
  title: string;
  html?: string;
  text?: string;
  excerpt?: string;
  cover?: string;
  siteName?: string;
  favicon?: string;
  /** "link": keep pictures where they are (no download). */
  images?: "save" | "link";
}

const WS_RE = /^[A-Za-z0-9_-]{8,40}$/;
const MODES: readonly ClipMode[] = ["article", "bookmark", "selection", "text"];

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** A clip request from untrusted JSON, or null. */
export function validClipRequest(v: unknown): ClipRequest | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.ws !== "string" || !WS_RE.test(r.ws)) return null;
  const mode = MODES.find((m) => m === r.mode);
  if (!mode) return null;
  const t = (typeof r.target === "object" && r.target !== null ? r.target : {}) as Record<string, unknown>;
  let target: ClipTarget;
  if (t.type === "private") target = { type: "private" };
  else if ((t.type === "page" || t.type === "database") && typeof t.id === "string" && NOTE_ID_RE.test(t.id)) target = { type: t.type, id: t.id };
  else return null;
  if (typeof r.html === "string" && r.html.length > CLIP_LIMITS.htmlChars) return null;
  if (typeof r.text === "string" && r.text.length > CLIP_LIMITS.textChars) return null;
  // The page's own address: http(s) only (a clip of a local file or a browser page has none).
  const url = typeof r.url === "string" && r.url.length <= 2000 ? absoluteUrl(r.url, undefined) : "";
  if ((mode === "bookmark" || mode === "article") && !url) return null;
  const html = str(r.html, CLIP_LIMITS.htmlChars);
  const text = str(r.text, CLIP_LIMITS.textChars);
  if (mode !== "bookmark" && !html.trim() && !text.trim()) return null;
  return {
    ws: r.ws,
    target,
    mode,
    url,
    title: str(r.title, CLIP_LIMITS.titleChars).replace(/\s+/g, " ").trim(),
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(typeof r.excerpt === "string" && r.excerpt.trim() ? { excerpt: r.excerpt.replace(/\s+/g, " ").trim().slice(0, 1000) } : {}),
    ...(absoluteUrl(str(r.cover, 4000), url || undefined) ? { cover: absoluteUrl(str(r.cover, 4000), url || undefined) } : {}),
    ...(typeof r.siteName === "string" && r.siteName.trim() ? { siteName: r.siteName.trim().slice(0, 200) } : {}),
    ...(absoluteUrl(str(r.favicon, 4000), url || undefined) ? { favicon: absoluteUrl(str(r.favicon, 4000), url || undefined) } : {}),
    ...(r.images === "link" ? { images: "link" as const } : {}),
  };
}

export type ClipResult = { ok: true; id: string; title: string; path: string } | { ok: false; status: number; error: string };

/** How pictures are fetched and stored (tests replace both). */
export interface ClipDeps {
  fetchImage(url: string, maxBytes: number, signal: AbortSignal): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** Stores the bytes for the workspace owner; returns the file's address in Documents, or null. */
  storeImage(bytes: Uint8Array, ext: string, payer: string): Promise<string | null>;
}

export const defaultClipDeps: ClipDeps = {
  async fetchImage(url, maxBytes, signal) {
    const f = await fetchFile(url, { maxBytes, timeoutMs: 10_000, signal, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9" });
    return f && !f.truncated ? { body: f.body, contentType: f.contentType } : null;
  },
  async storeImage(bytes, ext, payer) {
    const saved = await saveNoteFile(bytes, ext);
    if ("error" in saved) return null;
    recordFile({ kind: "user", id: payer }, saved.name, bytes.byteLength);
    return `/api/notes/file/${saved.name}`;
  },
};

/** The picture's format by its first bytes (the declared type is not trusted); only these are kept. */
export function sniffImage(b: Uint8Array): "png" | "jpg" | "gif" | "webp" | "avif" | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "avif";
  return null;
}

function storedNote(ws: string, id: string): Note | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  try {
    return sanitizeNote(JSON.parse(r?.json ?? "null"));
  } catch {
    return null;
  }
}

/** The order after the last child of `parentId` (sub-pages and rows go at the end). */
function orderAfterChildren(ws: string, parentId: string): number {
  let last = Number.NEGATIVE_INFINITY;
  for (const r of sql("SELECT json_extract(json, '$.order') AS o FROM notes WHERE ws = ? AND parent_id = ? AND deleted = 0").all(ws, parentId) as { o: number | null }[]) {
    if (typeof r.o === "number" && r.o > last) last = r.o;
  }
  return Number.isFinite(last) ? orderBetween(last, undefined) : Date.now();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function paragraph(content: unknown[]): Block {
  return { id: randomUUID(), type: "paragraph", props: {}, content };
}

/** The page body of a clip (before its pictures are stored). */
export function clipBlocks(req: ClipRequest, opts: { sourceLine: boolean }): Block[] {
  const blocks: Block[] = [];
  const bookmark: Block = { id: randomUUID(), type: "bookmark", props: { url: req.url, title: req.title || hostOf(req.url), description: req.excerpt ?? "", image: req.cover ?? "", icon: req.favicon ?? "" } };
  if (req.mode === "bookmark") {
    blocks.push(bookmark);
    if (req.text?.trim()) blocks.push(...textToBlocks(req.text, { maxBlocks: CLIP_LIMITS.blocks }));
    return blocks;
  }
  const body = req.html?.trim() ? htmlToBlocks(req.html, { base: req.url || undefined, maxBlocks: CLIP_LIMITS.blocks }) : textToBlocks(req.text ?? "", { maxBlocks: CLIP_LIMITS.blocks });
  // A page outside a database keeps where it came from as its first line (a row has its URL property).
  if (opts.sourceLine && req.url) blocks.push(paragraph([{ type: "link", href: req.url, content: [{ type: "text", text: req.siteName || hostOf(req.url) || req.url, styles: {} }] }]));
  blocks.push(...body);
  if (!body.length && req.url) blocks.push(bookmark);
  return blocks;
}

/**
 * Downloads the clip's pictures (and its cover) into the owner's storage;
 * each one that cannot be fetched, is not a real picture, or does not fit
 * the quota stays a link. Returns the bytes stored.
 */
async function storeImages(blocks: Block[], cover: { url: string } | null, payer: string, left: number, deps: ClipDeps): Promise<number> {
  const targets = imageBlocks(blocks);
  const urls = [...new Set([...(cover ? [cover.url] : []), ...targets.map((b) => String(b.props.url ?? ""))])].filter(Boolean).slice(0, CLIP_LIMITS.images);
  const stored = new Map<string, string>();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CLIP_LIMITS.imagesDeadlineMs);
  let total = 0;
  try {
    const queue = [...urls];
    const worker = async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        if (ac.signal.aborted) return;
        try {
          let bytes: Uint8Array | null = null;
          const inline = /^data:image\/[a-z]+;base64,(.*)$/i.exec(url);
          if (inline) bytes = Buffer.from(inline[1], "base64");
          else {
            const room = Math.min(CLIP_LIMITS.imageBytes, CLIP_LIMITS.imagesBytes - total);
            if (room <= 0) return;
            bytes = (await deps.fetchImage(url, room, ac.signal))?.body ?? null;
          }
          if (!bytes || bytes.byteLength > CLIP_LIMITS.imageBytes) continue;
          const kind = sniffImage(bytes);
          if (!kind) continue;
          const out = await compressImage(bytes, kind);
          if (total + out.bytes.byteLength > Math.min(left, CLIP_LIMITS.imagesBytes)) continue;
          const at = await deps.storeImage(out.bytes, out.ext, payer);
          if (!at) continue;
          total += out.bytes.byteLength;
          stored.set(url, at);
        } catch {
          // This one stays a link.
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    clearTimeout(timer);
  }
  for (const b of targets) {
    const at = stored.get(String(b.props.url ?? ""));
    if (at) b.props = { ...b.props, url: at };
    // An inline picture that was not stored would bloat the page: it goes.
    else if (/^data:/i.test(String(b.props.url ?? ""))) b.props = { ...b.props, url: "" };
  }
  if (cover) cover.url = stored.get(cover.url) ?? (/^data:/i.test(cover.url) ? "" : cover.url);
  return total;
}

/** The body cut to fit one note (a very long article keeps its beginning). */
function fitBlocks(note: Note): Note {
  let content = note.content;
  const size = () => Buffer.byteLength(JSON.stringify({ ...note, content }));
  if (size() <= CLIP_LIMITS.noteBytes) return note;
  let lo = 0;
  let hi = content.length;
  // The longest prefix that fits (binary search over block counts).
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    content = note.content.slice(0, mid);
    if (size() <= CLIP_LIMITS.noteBytes - 2000) lo = mid;
    else hi = mid - 1;
  }
  content = [...note.content.slice(0, lo), paragraph([{ type: "text", text: "…", styles: {} }])];
  return { ...note, content };
}

/**
 * Saves a clip for `who`. The target must be one they may add to (edit on
 * the page or database; Private for members who can create pages); a
 * target they cannot see is "not found", never "forbidden".
 */
export async function saveClip(req: ClipRequest, who: { id: string; name: string }, deps: ClipDeps = defaultClipDeps, now = Date.now()): Promise<ClipResult> {
  const ws = req.ws;
  if (!docsPresence(who.id, ws)) return { ok: false, status: 403, error: "forbidden" };
  const acc = new AccessResolver(ws, who.id);
  let parent: Note | null = null;
  if (req.target.type === "private") {
    if (!atLeast(acc.levelForNew(null, `private:${who.id}`), "edit")) return { ok: false, status: 403, error: "forbidden" };
  } else {
    parent = storedNote(ws, req.target.id);
    const level = parent ? acc.level(parent.id) : null;
    if (!parent || !level || inTrash(ws, parent) || parent.kind !== (req.target.type === "database" ? "database" : "page")) return { ok: false, status: 404, error: "not found" };
    if (!atLeast(level, "edit")) return { ok: false, status: 403, error: "forbidden" };
  }
  const isRow = parent?.kind === "database";
  const blocks = clipBlocks(req, { sourceLine: !isRow });
  const payer = payerOf(ws);
  const left = payer ? await quotaLeft(payer) : 0;
  const cover = req.cover ? { url: req.cover } : null;
  const saveImages = req.images !== "link" && payer !== null && left > 0;
  const imageBytes = saveImages ? await storeImages(blocks, cover, payer, left, deps) : 0;

  const props: Record<string, PropValue> = {};
  if (isRow && parent?.db && req.url) {
    // The database's URL property (the one named like it first): where the page came from.
    const urls = parent.db.properties.filter((p) => p.type === "url");
    const prop = urls.find((p) => /^(url|link|source|address|ссылка|источник)$/i.test(p.name.trim())) ?? urls[0];
    if (prop) props[prop.id] = req.url;
  }
  const title = req.title || hostOf(req.url) || "";
  let note = blankNote({
    kind: "page",
    parentId: parent?.id ?? null,
    title,
    icon: "",
    content: sanitizeBlocks(blocks),
    cover: cover?.url ? { kind: "image", value: cover.url, y: 50 } : null,
    order: parent ? orderAfterChildren(ws, parent.id) : now,
    createdAt: now,
    updatedAt: now,
    ...(Object.keys(props).length ? { props } : {}),
  });
  if (!parent) note.space = "private";
  note = fitBlocks(note);
  const clean = sanitizeNote(note);
  if (!clean) return { ok: false, status: 400, error: "bad request" };
  const items: { id: string; note: Note; fields?: string[] }[] = [{ id: clean.id, note: clean }];
  // A sub-page also appears in its parent's body, where the app places it (only the body changes).
  if (parent && !isRow) items.push({ id: parent.id, note: { ...parent, content: [...parent.content, { id: randomUUID(), type: "page", props: { noteId: clean.id } }] }, fields: ["content"] });
  const res = pushNotes(ws, items, { by: who.id, quotaLeft: Math.max(0, left - imageBytes), author: who.name, access: { userId: who.id } });
  if (!res.saved.includes(clean.id)) {
    const reason = res.rejected.find((r) => r.id === clean.id)?.reason ?? "";
    if (reason === "quota") return { ok: false, status: 507, error: "storage full" };
    if (reason === "too large") return { ok: false, status: 413, error: "too large" };
    if (reason === "forbidden" || reason === "read only") return { ok: false, status: 403, error: "forbidden" };
    return { ok: false, status: 503, error: "unavailable" };
  }
  return { ok: true, id: clean.id, title: clean.title, path: `/docs?ws=${encodeURIComponent(ws)}#${noteSlug(clean)}` };
}

// ---------------------------------------------------------------------------
// Where a clip can go

export interface ClipDestination {
  id: string;
  kind: "page" | "database";
  title: string;
  icon: string;
  /** The titles above it ("Projects / 2026"). */
  path: string;
}

interface Row {
  id: string;
  parent_id: string | null;
  title: string | null;
  kind: string | null;
  icon: string | null;
  trashed: number | null;
  template: number | null;
  synced: number | null;
}

/**
 * Pages and databases of the workspace the person may add to (edit
 * access), matching `q` in the title (empty: the recently edited ones).
 * Database rows, templates, synced blocks and the trash are not places.
 */
export function clipDestinations(ws: string, userId: string, q: string, limit = 30): ClipDestination[] {
  if (!docsPresence(userId, ws)) return [];
  const acc = new AccessResolver(ws, userId);
  const needle = q.trim().toLowerCase().slice(0, 100);
  const cols =
    "id, parent_id, json_extract(json, '$.title') AS title, json_extract(json, '$.kind') AS kind, json_extract(json, '$.icon') AS icon, json_extract(json, '$.trashedAt') AS trashed, json_extract(json, '$.template') AS template, json_extract(json, '$.synced') AS synced";
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = (
    needle
      ? sql(`SELECT ${cols} FROM notes WHERE ws = ? AND deleted = 0 AND json IS NOT NULL AND lower(json_extract(json, '$.title')) LIKE ? ESCAPE '\\' ORDER BY stamp DESC LIMIT 400`).all(ws, like)
      : sql(`SELECT ${cols} FROM notes WHERE ws = ? AND deleted = 0 AND json IS NOT NULL ORDER BY stamp DESC LIMIT 400`).all(ws)
  ) as unknown as Row[];
  const cache = new Map<string, Row | null>();
  const node = (id: string): Row | null => {
    if (!cache.has(id)) cache.set(id, (sql(`SELECT ${cols} FROM notes WHERE ws = ? AND id = ? AND deleted = 0`).get(ws, id) as unknown as Row | undefined) ?? null);
    return cache.get(id) ?? null;
  };
  for (const r of rows) cache.set(r.id, r);
  const out: ClipDestination[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if ((r.kind !== "page" && r.kind !== "database") || r.trashed !== null || r.template || r.synced) continue;
    // Its ancestors: none trashed, none a database (a row is not a place), titles for the path.
    const chain: string[] = [];
    let ok = true;
    const seen = new Set<string>([r.id]);
    for (let p = r.parent_id; p && ok; ) {
      if (seen.has(p) || seen.size > 60) break;
      seen.add(p);
      const a = node(p);
      if (!a) break;
      if (a.trashed !== null || a.kind === "database") ok = false;
      // A page above that this person can't open (a guest's shared sub-page) shows no title.
      chain.unshift(acc.level(p) ? String(a.title ?? "").trim() || "…" : "…");
      p = a.parent_id;
    }
    if (!ok || !atLeast(acc.level(r.id), "edit")) continue;
    const icon = typeof r.icon === "string" ? cleanIcon(r.icon) : "";
    out.push({ id: r.id, kind: r.kind, title: String(r.title ?? "").slice(0, 300), icon: icon.startsWith("icon:") || icon.startsWith("/") ? "" : icon, path: chain.join(" / ").slice(0, 300) });
  }
  return out;
}
