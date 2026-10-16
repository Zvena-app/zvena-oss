// The body of POST /api/notes/clip, within the server's caps: 4 MB in all,
// short fields cut to their limits, an article too long for the request cut
// at a tag boundary (the server cleans the HTML either way).

export const MAX_BODY_BYTES = 4_000_000;
/** Room for everything but the HTML (JSON escaping of the HTML can grow it, so leave margin). */
const RESERVE = 64_000;
export const MODES = ["article", "bookmark", "selection"];

const enc = new TextEncoder();
export const byteLength = (s) => enc.encode(s).byteLength;

const cut = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The longest prefix of `html` whose JSON form fits `bytes`, ending after a closing tag when it is cut. */
export function capHtml(html, bytes) {
  const s = String(html ?? "");
  if (byteLength(JSON.stringify(s)) <= bytes) return s;
  // Binary search on characters, then back off to the last complete tag.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(JSON.stringify(s.slice(0, mid))) <= bytes) lo = mid;
    else hi = mid - 1;
  }
  const head = s.slice(0, lo);
  // After the last complete closing tag, so no element is cut in half.
  for (let i = head.lastIndexOf("</"); i >= 0; i = i > 0 ? head.lastIndexOf("</", i - 1) : -1) {
    const end = head.indexOf(">", i);
    if (end > 0) return head.slice(0, end + 1);
  }
  return "";
}

function cleanTarget(t) {
  if (t && (t.type === "page" || t.type === "database") && typeof t.id === "string" && t.id) return { type: t.type, id: t.id };
  return { type: "private" };
}

/** The request body for a clip; `page` is what the extraction (or a context menu) found. */
export function buildPayload({ ws, target, mode, title, page }) {
  const m = MODES.includes(mode) ? mode : "article";
  const p = page ?? {};
  const body = {
    ws: String(ws ?? ""),
    target: cleanTarget(target),
    mode: m,
    url: String(p.url ?? ""),
    title: cut(title || p.title || p.url, 300),
  };
  if (p.excerpt) body.excerpt = cut(p.excerpt, 1000);
  if (p.cover) body.cover = String(p.cover).slice(0, 2000);
  if (p.siteName) body.siteName = cut(p.siteName, 200);
  if (p.favicon) body.favicon = String(p.favicon).slice(0, 2000);
  const html = m === "article" ? p.content : m === "selection" ? p.selection : "";
  if (html) {
    const room = MAX_BODY_BYTES - RESERVE - byteLength(JSON.stringify(body));
    const capped = capHtml(html, room);
    if (capped) body.html = capped;
  }
  return body;
}
