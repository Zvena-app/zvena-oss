// HTML → BlockNote blocks without a DOM (the Web Clipper's article, shared
// pages): the browser importer (components/notes/md-blocks.ts) needs a
// headless editor, the server has none.
//
// The input is untrusted: a small tokenizer builds a tree, only known
// elements become blocks or styles, everything else is unwrapped to its
// text; scripts, styles, forms and frames never pass. Links and images are
// resolved against the page's address and kept only as http(s) (mailto for
// links), so a relative "/x" of the clipped site never points at zvena.
// Bounded: input length, depth, block count, table size.

import { decodeEntities } from "../web-read";

export interface HtmlBlocksOptions {
  /** The clipped page's address: relative links and images resolve against it. */
  base?: string;
  /** At most this many blocks (the rest of the article is cut). */
  maxBlocks?: number;
  /** Block ids (tests pass a counter). */
  newId?: () => string;
}

type Styles = { bold?: true; italic?: true; underline?: true; strike?: true; code?: true; backgroundColor?: string };
type Inline = { type: "text"; text: string; styles: Styles } | { type: "link"; href: string; content: { type: "text"; text: string; styles: Styles }[] };
export interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children?: Block[];
}

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = El | string;

const MAX_INPUT = 3_000_000;
const MAX_DEPTH = 60;
const MAX_TEXT = 20_000;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is not markup (skipped up to the closing tag). */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "template"]);
/** Dropped with everything inside. */
const SKIP = new Set(["script", "style", "noscript", "template", "svg", "math", "canvas", "form", "button", "input", "select", "option", "textarea", "object", "embed", "head", "title", "meta", "link", "base", "nav", "dialog", "map", "area", "audio", "video", "source", "track", "picture-source"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "center", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html", "iframe", "img", "li", "main", "ol", "p", "pre", "section", "summary", "table", "ul", "tbody", "thead", "tfoot", "tr", "td", "th", "caption",
]);
/** A start tag of one of these closes an open <p>. */
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "ol", "p", "pre", "section", "table", "ul"]);
const EMBED_HOSTS = /^(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|loom\.com|www\.loom\.com)$/i;

// ---------------------------------------------------------------------------
// Tokenizer → tree

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s)) && n++ < 40) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** A forgiving tree of the markup (Readability's output is well formed; pasted HTML may not be). */
export function parseHtml(html: string): Node[] {
  const src = html.length > MAX_INPUT ? html.slice(0, MAX_INPUT) : html;
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1];
  const closeTo = (tag: string): boolean => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) {
        stack.length = i;
        return true;
      }
    }
    return false;
  };
  // No part of a tag runs past the next "<" outside quotes (and quotes are bounded): a page of
  // unclosed "<a<a<a…" or "<!<!<!…" stays linear instead of rescanning to the end from every "<".
  const tagRe = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^<>]*>|<\?[^<>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]{0,20000}"|'[^']{0,20000}')*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    if (m.index > last) top().children.push(decodeEntities(src.slice(last, m.index)));
    last = tagRe.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      // </p> without an open <p> is an empty paragraph in browsers; here it is nothing.
      closeTo(tag);
      continue;
    }
    if (!m[2]) continue; // comment, doctype, CDATA, processing instruction
    const tag = m[2].toLowerCase();
    const attrs = parseAttrs(m[3] ?? "");
    if (CLOSES_P.has(tag) && stack.some((e) => e.tag === "p")) closeTo("p");
    if (tag === "li") closeSibling(stack, "li", ["ul", "ol"]);
    if ((tag === "dt" || tag === "dd") && !closeSibling(stack, tag === "dt" ? "dd" : "dt", ["dl"])) closeSibling(stack, tag, ["dl"]);
    if (tag === "tr") closeSibling(stack, "tr", ["table", "tbody", "thead", "tfoot"]);
    if ((tag === "td" || tag === "th") && !closeSibling(stack, "td", ["tr"])) closeSibling(stack, "th", ["tr"]);
    const el: El = { tag, attrs, children: [] };
    if (stack.length < MAX_DEPTH) top().children.push(el);
    if (RAW.has(tag)) {
      // Raw text up to its own closing tag; never parsed as markup.
      const end = new RegExp(`</${tag}\\s*>`, "ig");
      end.lastIndex = last;
      const e = end.exec(src);
      last = e ? end.lastIndex : src.length;
      tagRe.lastIndex = last;
      continue;
    }
    if (!VOID.has(tag) && !m[4] && stack.length < MAX_DEPTH) stack.push(el);
  }
  if (last < src.length) top().children.push(decodeEntities(src.slice(last)));
  return root.children;
}

/** Closes an open `tag` when it is the nearest of `tag` and `scope` (a new <li> closes the previous one, not an outer list's). */
function closeSibling(stack: El[], tag: string, scope: string[]): boolean {
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i].tag === tag) {
      stack.length = i;
      return true;
    }
    if (scope.includes(stack[i].tag)) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// URLs

/** An absolute http(s) address (mailto too for links), resolved against the page; else "". */
export function absoluteUrl(raw: string | undefined, base: string | undefined, link = false): string {
  const v = (raw ?? "").trim();
  if (!v || v.length > 4000) return "";
  try {
    const u = base ? new URL(v, base) : new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:") return u.username || u.password ? "" : u.toString();
    if (link && u.protocol === "mailto:") return u.toString();
    return "";
  } catch {
    return "";
  }
}

/** The best candidate of a srcset (the widest, or the highest density). */
export function srcsetBest(srcset: string | undefined): string {
  if (!srcset) return "";
  let best = "";
  let score = -1;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [url, desc = "1x"] = part.trim().split(/\s+/);
    const n = parseFloat(desc) * (desc.endsWith("w") ? 1 : 1000);
    if (url && Number.isFinite(n) && n > score) {
      score = n;
      best = url;
    }
  }
  return best;
}

function imageSrc(el: El, base: string | undefined): string {
  const a = el.attrs;
  const candidates = [a.src, a["data-src"], a["data-original"], a["data-lazy-src"], srcsetBest(a.srcset), srcsetBest(a["data-srcset"])];
  for (const c of candidates) {
    if (!c) continue;
    if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(c.trim())) return c.trim().length <= 2_800_000 ? c.trim() : "";
    const u = absoluteUrl(c, base);
    if (u) return u;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Tree → blocks

interface Ctx {
  styles: Styles;
  href?: string;
  pre?: boolean;
}

interface Piece {
  text: string;
  styles: Styles;
  href?: string;
}

const INLINE_STYLE: Record<string, Styles> = {
  b: { bold: true },
  strong: { bold: true },
  em: { italic: true },
  i: { italic: true },
  cite: { italic: true },
  dfn: { italic: true },
  u: { underline: true },
  ins: { underline: true },
  s: { strike: true },
  strike: { strike: true },
  del: { strike: true },
  code: { code: true },
  kbd: { code: true },
  samp: { code: true },
  tt: { code: true },
  mark: { backgroundColor: "yellow" },
};

class Converter {
  out: Block[] = [];
  private count = 0;
  constructor(
    private base: string | undefined,
    private max: number,
    private newId: () => string
  ) {}

  full(): boolean {
    return this.count >= this.max;
  }

  block(type: string, props: Record<string, unknown> = {}, content?: unknown, children?: Block[]): Block {
    this.count++;
    return { id: this.newId(), type, props, ...(content !== undefined ? { content } : {}), ...(children ? { children } : {}) };
  }

  /** Inline content of collected pieces: whitespace collapsed and trimmed, same-styled neighbours merged, links grouped. */
  inline(pieces: Piece[], pre = false): Inline[] {
    const items = pre ? pieces : collapse(pieces);
    const out: Inline[] = [];
    let total = 0;
    for (const p of items) {
      if (!p.text) continue;
      const text = p.text.slice(0, Math.max(0, MAX_TEXT - total));
      if (!text) break;
      total += text.length;
      const node = { type: "text" as const, text, styles: { ...p.styles } };
      const prev = out[out.length - 1];
      if (p.href) {
        if (prev?.type === "link" && prev.href === p.href) mergeText(prev.content, node);
        else out.push({ type: "link", href: p.href, content: [node] });
      } else if (prev?.type === "text" && sameStyles(prev.styles, node.styles)) prev.text += node.text;
      else out.push(node);
    }
    return out;
  }

  /** Blocks of a list of nodes; `pieces` collects inline text until a block boundary flushes it as a paragraph. */
  walk(nodes: Node[], ctx: Ctx, out: Block[], pieces: Piece[], depth = 0): void {
    for (const node of nodes) {
      if (this.full()) return;
      if (typeof node === "string") {
        pieces.push({ text: node, styles: ctx.styles, ...(ctx.href ? { href: ctx.href } : {}) });
        continue;
      }
      const tag = node.tag;
      if (SKIP.has(tag) || depth > MAX_DEPTH) continue;
      if (node.attrs.hidden !== undefined || node.attrs["aria-hidden"] === "true") continue;
      if (tag === "br") {
        pieces.push({ text: "\n", styles: ctx.styles });
        continue;
      }
      if (tag === "wbr") continue;
      const style = INLINE_STYLE[tag];
      if (style || tag === "a" || !BLOCK.has(tag)) {
        const href = tag === "a" ? absoluteUrl(node.attrs.href, this.base, true) || undefined : ctx.href;
        this.walk(node.children, { ...ctx, styles: style ? { ...ctx.styles, ...style } : ctx.styles, href }, out, pieces, depth + 1);
        continue;
      }
      this.flush(pieces, out);
      this.element(node, ctx, out, depth);
    }
  }

  flush(pieces: Piece[], out: Block[]): void {
    if (!pieces.length) return;
    const content = this.inline(pieces.splice(0));
    if (content.length && !this.full()) out.push(this.block("paragraph", {}, content));
  }

  /** The blocks of an element's children (a paragraph for loose text). */
  blocksOf(nodes: Node[], ctx: Ctx, depth: number): Block[] {
    const out: Block[] = [];
    const pieces: Piece[] = [];
    this.walk(nodes, ctx, out, pieces, depth + 1);
    this.flush(pieces, out);
    return out;
  }

  /**
   * Inline content of an element. Paragraphs inside (a <p> in a <li>) join
   * it, one per line; when real blocks are inside (a picture in a heading),
   * `content` is empty and `blocks` keeps everything in order.
   */
  inlineOf(nodes: Node[], ctx: Ctx, depth: number): { content: Inline[]; blocks: Block[] } {
    const blocks: Block[] = [];
    const pieces: Piece[] = [];
    this.walk(nodes, ctx, blocks, pieces, depth + 1);
    if (blocks.some((b) => b.type !== "paragraph")) {
      this.flush(pieces, blocks);
      return { content: [], blocks };
    }
    const content: Inline[] = [];
    const add = (part: Inline[]) => {
      if (!part.length) return;
      if (content.length) content.push({ type: "text", text: "\n", styles: {} });
      content.push(...part);
    };
    for (const b of blocks) add(b.content as Inline[]);
    add(this.inline(pieces));
    return { content, blocks: [] };
  }

  /** A block of inline content (a heading, a paragraph); mixed content keeps its blocks, the first paragraph taking the type. */
  textBlock(type: string, props: Record<string, unknown>, nodes: Node[], ctx: Ctx, out: Block[], depth: number): void {
    const { content, blocks } = this.inlineOf(nodes, ctx, depth);
    if (content.length) {
      out.push(this.block(type, props, content));
      return;
    }
    let typed = false;
    for (const b of blocks) {
      if (!typed && b.type === "paragraph") {
        typed = true;
        out.push({ ...b, type, props });
      } else out.push(b);
    }
  }

  element(el: El, ctx: Ctx, out: Block[], depth: number): void {
    const tag = el.tag;
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        this.textBlock("heading", { level: Math.min(3, Number(tag[1])) }, el.children, ctx, out, depth);
        return;
      case "p":
      case "summary":
      case "dd":
      case "caption":
      case "figcaption":
        this.textBlock("paragraph", {}, el.children, ctx, out, depth);
        return;
      case "dt":
        this.textBlock("paragraph", {}, el.children, { ...ctx, styles: { ...ctx.styles, bold: true } }, out, depth);
        return;
      case "ul":
      case "ol":
        this.list(el, tag === "ol" ? "numberedListItem" : "bulletListItem", ctx, out, depth);
        return;
      case "li":
        // A list item outside a list.
        this.listItem(el, "bulletListItem", ctx, out, depth);
        return;
      case "blockquote": {
        for (const b of this.blocksOf(el.children, ctx, depth)) out.push(b.type === "paragraph" ? { ...b, type: "quote" } : b);
        return;
      }
      case "pre": {
        const code = textOf(el).replace(/^\n/, "").replace(/\s+$/, "").slice(0, 100_000);
        const lang = languageOf(el);
        if (code) out.push(this.block("codeBlock", { language: lang }, [{ type: "text", text: code, styles: {} }]));
        return;
      }
      case "hr":
        out.push(this.block("divider"));
        return;
      case "img": {
        const url = imageSrc(el, this.base);
        // Tracking pixels and spacers are not pictures.
        if (!url || Number(el.attrs.width) === 1 || Number(el.attrs.height) === 1) return;
        const alt = (el.attrs.alt ?? "").trim().slice(0, 500);
        out.push(this.block("image", { url, ...(alt ? { name: alt } : {}) }));
        return;
      }
      case "figure": {
        const blocks = this.blocksOf(el.children.filter((c) => typeof c === "string" || c.tag !== "figcaption"), ctx, depth);
        const cap = el.children.find((c): c is El => typeof c !== "string" && c.tag === "figcaption");
        const caption = cap ? collapseText(textOf(cap)).slice(0, 2000) : "";
        const img = blocks.find((b) => b.type === "image");
        if (img && caption) img.props = { ...img.props, caption };
        out.push(...blocks);
        if (!img && caption) out.push(this.block("paragraph", {}, [{ type: "text", text: caption, styles: { italic: true } }]));
        return;
      }
      case "table":
        this.table(el, ctx, out, depth);
        return;
      case "iframe": {
        const url = absoluteUrl(el.attrs.src, this.base);
        try {
          if (url && url.startsWith("https://") && EMBED_HOSTS.test(new URL(url).hostname)) out.push(this.block("embed", { url }));
        } catch {
          // Not a frame we show.
        }
        return;
      }
      case "details": {
        const sum = el.children.find((c): c is El => typeof c !== "string" && c.tag === "summary");
        const head = sum ? this.inlineOf(sum.children, ctx, depth).content : [];
        const body = this.blocksOf(el.children.filter((c) => c !== sum), ctx, depth);
        out.push(this.block("toggleListItem", {}, head, body));
        return;
      }
      default: {
        // Sectioning containers: their children, with block boundaries around.
        for (const b of this.blocksOf(el.children, ctx, depth)) out.push(b);
      }
    }
  }

  list(el: El, type: string, ctx: Ctx, out: Block[], depth: number): void {
    for (const c of el.children) {
      if (this.full()) return;
      if (typeof c === "string") {
        if (c.trim()) out.push(this.block(type, {}, this.inline([{ text: c, styles: ctx.styles }])));
        continue;
      }
      if (c.tag === "li") this.listItem(c, type, ctx, out, depth);
      else if (c.tag === "ul" || c.tag === "ol") this.list(c, c.tag === "ol" ? "numberedListItem" : "bulletListItem", ctx, out, depth + 1);
      else if (!SKIP.has(c.tag)) this.walkInto(c, ctx, out, depth);
    }
  }

  private walkInto(el: El, ctx: Ctx, out: Block[], depth: number): void {
    const pieces: Piece[] = [];
    this.walk([el], ctx, out, pieces, depth + 1);
    this.flush(pieces, out);
  }

  listItem(li: El, type: string, ctx: Ctx, out: Block[], depth: number): void {
    // A checkbox makes it a to-do (task lists of GitHub-style pages).
    const box = findFirst(li, (e) => e.tag === "input" && (e.attrs.type ?? "").toLowerCase() === "checkbox", 3);
    const nested = li.children.filter((c): c is El => typeof c !== "string" && (c.tag === "ul" || c.tag === "ol"));
    const { content, blocks } = this.inlineOf(
      li.children.filter((c) => typeof c === "string" || (c.tag !== "ul" && c.tag !== "ol")),
      ctx,
      depth
    );
    const children: Block[] = [...blocks];
    for (const n of nested) this.list(n, n.tag === "ol" ? "numberedListItem" : "bulletListItem", ctx, children, depth + 1);
    const t = box ? "checkListItem" : type;
    out.push(this.block(t, box ? { checked: box.attrs.checked !== undefined } : {}, content, children.length ? children : undefined));
  }

  table(el: El, ctx: Ctx, out: Block[], depth: number): void {
    const rows: El[] = [];
    const collect = (e: El, d: number) => {
      for (const c of e.children) {
        if (typeof c === "string" || d > 4) continue;
        if (c.tag === "tr") rows.push(c);
        else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") collect(c, d + 1);
      }
    };
    collect(el, 0);
    if (!rows.length) return;
    const caption = el.children.find((c): c is El => typeof c !== "string" && c.tag === "caption");
    if (caption) {
      const text = collapseText(textOf(caption));
      if (text) out.push(this.block("paragraph", {}, [{ type: "text", text: text.slice(0, 2000), styles: { bold: true } }]));
    }
    const grid = rows.slice(0, 500).map((r) => r.children.filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th")).slice(0, 50));
    const width = Math.max(1, ...grid.map((r) => r.length));
    const images: Block[] = [];
    const cells = grid.map((r) => ({
      cells: Array.from({ length: width }, (_, i) => {
        const cell = r[i];
        if (!cell) return [];
        const { content, blocks } = this.inlineOf(cell.children, ctx, depth);
        if (!blocks.length) return content;
        // A cell holds text only: its paragraphs one per line, its pictures after the table.
        images.push(...imageBlocks(blocks));
        const text: Inline[] = [];
        for (const b of blocks) {
          if (b.type === "image" || !Array.isArray(b.content)) continue;
          if (text.length) text.push({ type: "text", text: "\n", styles: {} });
          text.push(...(b.content as Inline[]));
        }
        return text;
      }),
    }));
    const header = grid[0]?.length > 0 && grid[0].every((c) => c.tag === "th");
    out.push(this.block("table", {}, { type: "tableContent", columnWidths: Array(width).fill(null), ...(header ? { headerRows: 1 } : {}), rows: cells }));
    // Pictures inside cells follow the table (a cell holds text only).
    out.push(...images);
  }
}

function sameStyles(a: Styles, b: Styles): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k as keyof Styles] === b[k as keyof Styles]);
}

function mergeText(list: { type: "text"; text: string; styles: Styles }[], node: { type: "text"; text: string; styles: Styles }): void {
  const prev = list[list.length - 1];
  if (prev && sameStyles(prev.styles, node.styles)) prev.text += node.text;
  else list.push(node);
}

/** Collapses whitespace like a browser: runs become one space, none at the ends or around line breaks. */
function collapse(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  let space = true; // at the start: leading spaces go
  for (const p of pieces) {
    if (p.text === "\n") {
      const prev = out[out.length - 1];
      if (prev) prev.text = prev.text.replace(/ +$/, "");
      out.push({ ...p });
      space = true;
      continue;
    }
    let t = p.text.replace(/[\t\n\r\f ]+/g, " ").replace(/ /g, " ");
    if (space) t = t.replace(/^ /, "");
    if (!t) continue;
    space = t.endsWith(" ");
    out.push({ ...p, text: t });
  }
  // Trailing spaces and line breaks go.
  while (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/[ \n]+$/, "");
    if (last.text) break;
    out.pop();
  }
  while (out.length && out[0].text === "\n") out.shift();
  return out;
}

function collapseText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function textOf(n: Node): string {
  if (typeof n === "string") return n;
  if (SKIP.has(n.tag)) return "";
  if (n.tag === "br") return "\n";
  return n.children.map(textOf).join("");
}

function findFirst(el: El, pred: (e: El) => boolean, depth: number): El | null {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    if (pred(c)) return c;
    if (depth > 0 && c.tag !== "ul" && c.tag !== "ol") {
      const f = findFirst(c, pred, depth - 1);
      if (f) return f;
    }
  }
  return null;
}

function languageOf(pre: El): string {
  const code = pre.children.find((c): c is El => typeof c !== "string" && c.tag === "code");
  const cls = `${pre.attrs.class ?? ""} ${code?.attrs.class ?? ""} ${pre.attrs["data-lang"] ?? ""}`;
  const m = /(?:^|\s)(?:language|lang)-([a-z0-9+#-]{1,30})/i.exec(cls) ?? /^\s*([a-z0-9+#-]{1,30})\s*$/i.exec(pre.attrs["data-lang"] ?? "");
  return m ? m[1].toLowerCase() : "text";
}

/** BlockNote blocks of an HTML fragment (see the header). */
export function htmlToBlocks(html: string, opts: HtmlBlocksOptions = {}): Block[] {
  const conv = new Converter(opts.base, opts.maxBlocks ?? 3000, opts.newId ?? (() => globalThis.crypto.randomUUID()));
  const nodes = parseHtml(html);
  const out: Block[] = [];
  const pieces: Piece[] = [];
  conv.walk(nodes, { styles: {} }, out, pieces);
  conv.flush(pieces, out);
  return out;
}

/** Plain text as paragraphs (one per line; blank lines dropped), bounded. */
export function textToBlocks(text: string, opts: { maxBlocks?: number; newId?: () => string } = {}): Block[] {
  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, opts.maxBlocks ?? 3000)
    .map((l) => ({ id: newId(), type: "paragraph", props: {}, content: [{ type: "text", text: l.slice(0, MAX_TEXT), styles: {} }] }));
}

/** Every image block (nested too), for downloading and rewriting their addresses. */
export function imageBlocks(blocks: readonly Block[], out: Block[] = []): Block[] {
  for (const b of blocks) {
    if (b.type === "image") out.push(b);
    if (b.children) imageBlocks(b.children, out);
  }
  return out;
}
