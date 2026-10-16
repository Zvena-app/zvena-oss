// Server-only: a received e-mail's HTML made safe to show. An allow-list of
// tags and attributes (htmlparser2, never a regex over HTML): no scripts,
// event handlers, forms, frames, plugins, SVG or <base>; links only to
// http(s), mailto and tel, opened in a new tab without the referrer.
//
// Remote content is a tracking pixel until proven otherwise: images, CSS
// url()s and @imports never point at the sender's servers. With images
// blocked they are removed (and counted, for the "Show images" bar); with
// images allowed they go through zvena's image proxy (/api/mail/img), so the
// sender learns neither the reader's address nor when they read. Inline
// images (cid:) are served from the message's own parts.
//
// The result is rendered in a sandboxed frame with its own strict CSP
// (no scripts at all), so this is the second wall, not the only one.

import { Parser } from "htmlparser2";

export interface SanitizeOptions {
  /** Load remote images through the proxy (true) or drop them (false). */
  images: boolean;
  /** The proxied address of a remote image, or null to drop it. */
  proxy?: (url: string) => string | null;
  /** The address of an inline part (cid:…), or null when the message has no such part. */
  cid?: (cid: string) => string | null;
  /** Cut the output at this many characters (default 2 MB). */
  maxChars?: number;
  /**
   * zvena's own origin: a link there opens only pages that show things (a
   * doc, an issue, a conversation), never an address that does something on
   * a plain visit; the message frame is same-origin, so its links count as
   * zvena's own.
   */
  ownOrigin?: string;
}

const OWN_PAGES = /^\/(docs|notes|projects|mail|n\/|design|home|inbox|share\/|templates)(\/|$|\?|#)/;

function linkAllowed(u: string, own: string | undefined): boolean {
  if (!SAFE_HREF.test(u)) return false;
  if (!own || !/^https?:/i.test(u)) return true;
  try {
    const url = new URL(u);
    return url.origin !== own || OWN_PAGES.test(url.pathname + (url.search ? "?" : ""));
  } catch {
    return false;
  }
}

export interface Sanitized {
  html: string;
  /** Remote images and backgrounds that were dropped (images: false) or proxied (images: true). */
  remote: number;
}

const VOID = new Set(["br", "hr", "img", "col", "wbr", "area"]);

const ALLOWED = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup",
  "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong",
  "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
]);

/** Dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "template", "title", "audio", "video",
  "canvas", "form", "button", "select", "textarea", "input", "option", "datalist", "dialog", "map", "picture", "source", "track", "xml",
]);

const GLOBAL_ATTRS = new Set(["style", "class", "dir", "lang", "title", "align", "valign", "bgcolor", "width", "height", "role", "aria-label", "aria-hidden"]);
const TAG_ATTRS: Record<string, readonly string[]> = {
  a: ["href", "name"],
  img: ["src", "alt", "border", "hspace", "vspace"],
  table: ["border", "cellpadding", "cellspacing", "frame", "rules", "summary"],
  td: ["colspan", "rowspan", "nowrap", "abbr", "scope", "headers"],
  th: ["colspan", "rowspan", "nowrap", "abbr", "scope", "headers"],
  col: ["span"],
  colgroup: ["span"],
  font: ["color", "face", "size"],
  ol: ["start", "type", "reversed"],
  ul: ["type"],
  li: ["value", "type"],
  time: ["datetime"],
  hr: ["size", "noshade", "color"],
  details: ["open"],
};

const SAFE_HREF = /^(https?:|mailto:|tel:|#)/i;
const DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const MAX_DATA_IMAGE = 1_000_000;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Characters browsers ignore inside a URL scheme ("java\tscript:") are gone before the scheme is read. */
function urlOf(raw: string): string {
  return raw.replace(/[\u0000-\u0020\u007f-\u009f]+/g, (m) => (m.includes(" ") ? "%20" : "")).trim();
}

interface Ctx {
  opts: SanitizeOptions;
  remote: number;
}

/** A remote, cid or data URL as it may appear in the output, or null to drop it. */
function imageUrl(raw: string, c: Ctx): string | null {
  const u = urlOf(raw);
  if (DATA_IMAGE.test(u)) return u.length <= MAX_DATA_IMAGE ? u.replace(/\s+/g, "") : null;
  if (/^cid:/i.test(u)) return c.opts.cid?.(u.slice(4).replace(/^<|>$/g, "")) ?? null;
  if (/^https?:\/\//i.test(u) || u.startsWith("//")) {
    c.remote++;
    if (!c.opts.images) return null;
    return c.opts.proxy?.(u.startsWith("//") ? `https:${u}` : u) ?? null;
  }
  return null;
}

/**
 * CSS from a style attribute or a <style> block: no script-ish features
 * (expression(), behaviors, bindings, javascript:), no @import, and every
 * url() rewritten like an image (or the declaration dropped).
 */
export function sanitizeCss(css: string, c: Ctx): string {
  let s = css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (m, e: string) => {
    // CSS escapes could spell "expression" or "url" in disguise: decode the plain ones, drop the rest.
    const hex = /^[0-9a-f]{1,6}\s?$/i.test(e) ? parseInt(e, 16) : NaN;
    return Number.isFinite(hex) && hex > 31 && hex < 127 ? String.fromCharCode(hex) : e.length === 1 && /[\w\s-]/.test(e) ? e : "";
  });
  if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|@charset|@namespace/i.test(s)) {
    s = s.replace(/@import[^;]*;?/gi, "").replace(/@(charset|namespace)[^;]*;?/gi, "");
    if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding/i.test(s)) return "";
  }
  // image-set() and cross-fade() take bare strings as images: never a way around url().
  s = s.replace(/(?:-webkit-)?(?:image-set|cross-fade)\s*\([^)]*\)/gi, "none");
  const out = rewriteUrls(s, c);
  // Anything else that names a resource (image(), src(), a url() the scanner could not read): no CSS at all.
  if (out === null || /(?:^|[^\w-])(?:image|src)\s*\(/i.test(out)) return "";
  return out;
}

const enc = (u: string) => u.replace(/[()"'\\\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);

/**
 * Every url(…) rewritten like an image, read by a scanner (quoted values may
 * hold ")" or quotes of the other kind): what the browser would load is
 * exactly what is checked. Null when a url( cannot be read to its end.
 */
function rewriteUrls(s: string, c: Ctx): string | null {
  const re = /url\s*\(/gi;
  let out = "";
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out += s.slice(at, m.index);
    let j = re.lastIndex;
    while (j < s.length && /\s/.test(s[j])) j++;
    let value: string;
    const q = s[j] === '"' || s[j] === "'" ? s[j] : "";
    if (q) {
      const end = s.indexOf(q, j + 1);
      if (end < 0) return null;
      value = s.slice(j + 1, end);
      j = end + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] !== ")") return null;
    } else {
      const end = s.indexOf(")", j);
      if (end < 0) return null;
      value = s.slice(j, end).trim();
      if (/["'(\s]/.test(value)) return null;
      j = end;
    }
    const u = imageUrl(value, c);
    out += u ? `url("${enc(u)}")` : "none";
    at = j + 1;
    re.lastIndex = at;
  }
  return out + s.slice(at);
}

/** Safe HTML of a received message (for its sandboxed frame). */
export function sanitizeHtml(input: string, opts: SanitizeOptions): Sanitized {
  const c: Ctx = { opts, remote: 0 };
  const max = opts.maxChars ?? 2_000_000;
  const out: string[] = [];
  let size = 0;
  const push = (s: string) => {
    if (size > max) return;
    size += s.length;
    out.push(s);
  };
  // Open elements: the tag as written out ("" when it was unwrapped), to close them in order.
  const stack: { tag: string; out: string }[] = [];
  let drop = 0;
  let inStyle = false;
  let styleText = "";

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const tag = name.toLowerCase();
        if (drop > 0) {
          if (!VOID.has(tag)) {
            drop++;
            stack.push({ tag, out: "" });
          }
          return;
        }
        if (tag === "style") {
          inStyle = true;
          styleText = "";
          stack.push({ tag, out: "" });
          return;
        }
        if (DROP_WITH_CONTENT.has(tag)) {
          drop = 1;
          stack.push({ tag, out: "" });
          return;
        }
        if (!ALLOWED.has(tag)) {
          // html, body, unknown and custom tags: their content stays.
          if (!VOID.has(tag)) stack.push({ tag, out: "" });
          return;
        }
        const allowed = TAG_ATTRS[tag] ?? [];
        const parts: string[] = [];
        for (const [k0, v0] of Object.entries(attrs)) {
          const k = k0.toLowerCase();
          const v = v0 ?? "";
          if (!GLOBAL_ATTRS.has(k) && !allowed.includes(k)) {
            // A table's background image is a remote image like any other.
            if (k === "background") {
              const u = imageUrl(v, c);
              if (u) parts.push(`style="background-image:url(&quot;${escAttr(u)}&quot;)"`);
            }
            continue;
          }
          if (k === "style") {
            const css = sanitizeCss(v, c).replace(/[<>]/g, "");
            if (css.trim()) parts.push(`style="${escAttr(css)}"`);
            continue;
          }
          if (k === "href") {
            const u = urlOf(v);
            if (linkAllowed(u, c.opts.ownOrigin)) parts.push(`href="${escAttr(u)}"`);
            continue;
          }
          if (k === "src") {
            const u = imageUrl(v, c);
            if (u) parts.push(`src="${escAttr(u)}"`);
            continue;
          }
          if (k === "class") {
            // Classes stay (the message's own <style> needs them), names only.
            const cls = v.replace(/[^\w\s-]/g, "").trim().slice(0, 200);
            if (cls) parts.push(`class="${escAttr(cls)}"`);
            continue;
          }
          parts.push(`${k}="${escAttr(v.slice(0, 500))}"`);
        }
        if (tag === "a") parts.push('target="_blank" rel="noopener noreferrer nofollow"');
        // A dropped image leaves nothing behind (no broken-image icon).
        if (tag === "img" && !parts.some((p) => p.startsWith("src="))) return;
        const open = `<${tag}${parts.length ? ` ${parts.join(" ")}` : ""}>`;
        push(open);
        if (!VOID.has(tag)) stack.push({ tag, out: tag });
      },
      ontext(text) {
        if (inStyle) {
          styleText += text;
          return;
        }
        if (drop > 0) return;
        push(esc(text));
      },
      onclosetag(name, implied) {
        const tag = name.toLowerCase();
        if (VOID.has(tag)) return;
        // Close up to the matching open element (browsers do the same with stray tags).
        const i = stack.map((s) => s.tag).lastIndexOf(tag);
        if (i < 0) return;
        void implied;
        while (stack.length > i) {
          const s = stack.pop()!;
          if (s.tag === "style" && inStyle) {
            inStyle = false;
            if (drop === 0) {
              const css = sanitizeCss(styleText, c).replace(/<\/?\s*style/gi, "");
              if (css.trim()) push(`<style>${css.replace(/</g, "\\3c ")}</style>`);
            }
            styleText = "";
            continue;
          }
          if (drop > 0) {
            drop--;
            continue;
          }
          if (s.out) push(`</${s.out}>`);
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true }
  );
  parser.write(input.length > max * 2 ? input.slice(0, max * 2) : input);
  parser.end();
  while (stack.length) {
    const s = stack.pop()!;
    if (drop > 0) drop--;
    else if (s.out) push(`</${s.out}>`);
  }
  return { html: out.join(""), remote: c.remote };
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/gi;

/** A plain-text message as HTML: escaped, links clickable, quoted lines (">") set apart. */
export function textToHtml(text: string, ownOrigin?: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let quoted = false;
  for (const raw of lines) {
    const q = /^\s*>/.test(raw);
    if (q !== quoted) {
      out.push(q ? '<blockquote class="zv-quote">' : "</blockquote>");
      quoted = q;
    }
    const line = q ? raw.replace(/^\s*>\s?/, "") : raw;
    let html = "";
    let last = 0;
    for (const m of line.matchAll(URL_RE)) {
      html += esc(line.slice(last, m.index));
      if (!linkAllowed(m[0], ownOrigin)) {
        html += esc(m[0]);
        last = (m.index ?? 0) + m[0].length;
        continue;
      }
      html += `<a href="${escAttr(m[0])}" target="_blank" rel="noopener noreferrer nofollow">${esc(m[0])}</a>`;
      last = (m.index ?? 0) + m[0].length;
    }
    html += esc(line.slice(last));
    out.push(`${html}<br>`);
  }
  if (quoted) out.push("</blockquote>");
  return `<div class="zv-plain">${out.join("")}</div>`;
}

/** The readable text of HTML (search, snippets, saving to Docs). */
export function htmlToPlain(input: string, max = 200_000): string {
  const out: string[] = [];
  let size = 0;
  let skip = 0;
  const BLOCK = /^(p|div|br|tr|li|h[1-6]|blockquote|pre|table|section|article|header|footer|hr)$/;
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "style" || name === "script" || name === "head" || name === "title" || name === "noscript") skip++;
        else if (BLOCK.test(name)) out.push("\n");
      },
      ontext(t) {
        if (skip || size > max) return;
        size += t.length;
        out.push(t);
      },
      onclosetag(name) {
        if (name === "style" || name === "script" || name === "head" || name === "title" || name === "noscript") skip = Math.max(0, skip - 1);
        else if (BLOCK.test(name)) out.push("\n");
      },
    },
    { decodeEntities: true, lowerCaseTags: true }
  );
  parser.write(input.slice(0, max * 4));
  parser.end();
  return out
    .join("")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** A one-line preview of a message's text. */
export function snippetOf(text: string, max = 200): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
