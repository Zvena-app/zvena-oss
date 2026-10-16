// Link previews (web bookmarks in Documents): title, description, image and
// icon of a fetched page. The page is hostile input, so it is read with
// htmlparser2 (linear time, never a regex over the markup), only up to the
// end of <head> and never past the first HEAD_LIMIT characters; previews are
// remembered for a while per URL so a page is not fetched and parsed again
// on every request.
import { Parser } from "htmlparser2";

export interface Preview {
  url: string;
  title: string;
  description: string;
  image: string;
  icon: string;
}

/** Open Graph / Twitter tags and <title> live in <head>; nothing past this is read. */
export const HEAD_LIMIT = 64_000;

const TITLE = ["og:title", "twitter:title"];
const DESCRIPTION = ["og:description", "twitter:description", "description"];
const IMAGE = ["og:image", "og:image:url", "og:image:secure_url", "twitter:image"];

function abs(href: string, base: string): string {
  try {
    const u = new URL(href, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

function first(found: Map<string, string>, names: string[]): string {
  for (const n of names) {
    const v = found.get(n);
    if (v) return v;
  }
  return "";
}

/** Reads the preview fields of a page's HTML (only its head, at most HEAD_LIMIT characters). */
export function parsePreview(html: string, pageUrl: string): Preview {
  const meta = new Map<string, string>();
  let title = "";
  let inTitle = false;
  let icon = "";
  let done = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (done) return;
        if (name === "body") {
          done = true;
          return;
        }
        if (name === "title" && !title) inTitle = true;
        else if (name === "meta") {
          const key = (attrs.property || attrs.name || "").trim().toLowerCase();
          const content = (attrs.content ?? "").trim();
          if (key && content && !meta.has(key)) meta.set(key, content.slice(0, 2000));
        } else if (name === "link" && !icon) {
          const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
          if (rel.includes("icon") && attrs.href) icon = attrs.href.trim().slice(0, 2000);
        }
      },
      ontext(text) {
        if (inTitle && !done && title.length < 1000) title += text;
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        if (name === "head") done = true;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  // Fed in slices so the parse stops soon after </head> instead of reading on.
  const src = html.length > HEAD_LIMIT ? html.slice(0, HEAD_LIMIT) : html;
  for (let i = 0; i < src.length && !done; i += 4096) parser.write(src.slice(i, i + 4096));
  parser.end();
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  return {
    url: pageUrl,
    title: clean(first(meta, TITLE) || title).slice(0, 300),
    description: clean(first(meta, DESCRIPTION)).slice(0, 500),
    image: abs(first(meta, IMAGE), pageUrl).slice(0, 1000),
    icon: abs(icon || "/favicon.ico", pageUrl).slice(0, 1000),
  };
}

// --- Per-URL cache ------------------------------------------------------------

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: Preview | null }>();
const pending = new Map<string, Promise<Preview | null>>();

/**
 * The preview of `url`, from the cache when fetched in the last minutes;
 * concurrent requests for one URL share one fetch. `load` returns null when
 * the page could not be read (that answer is cached too, so a dead or slow
 * page is not retried on every keystroke).
 */
export async function cachedPreview(url: string, load: () => Promise<Preview | null>): Promise<Preview | null> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const running = pending.get(url);
  if (running) return running;
  const p = load()
    .catch(() => null)
    .then((value) => {
      if (cache.size >= MAX_ENTRIES) {
        for (const [k, v] of cache) if (Date.now() - v.at >= TTL_MS || cache.size >= MAX_ENTRIES) cache.delete(k);
      }
      cache.set(url, { at: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(url));
  pending.set(url, p);
  return p;
}
