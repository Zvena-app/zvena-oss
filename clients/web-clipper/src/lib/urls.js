// URLs as the clip sends them: absolute, http(s) (or a small data: image),
// never javascript: or other schemes the server would drop anyway.

/** Inline images bigger than this are left out (the server keeps links, not blobs). */
export const MAX_DATA_URL = 200_000;

/** An absolute http(s) URL for `raw` against `base`, or "" when it is not one. */
export function absUrl(raw, base, { image = false } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^data:/i.test(s)) return image && /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(s) && s.length <= MAX_DATA_URL ? s : "";
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return "";
  }
  if (u.protocol === "mailto:" && !image) return u.href;
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (u.username || u.password) return "";
  return u.href;
}

/**
 * The best candidate of a srcset: the widest "w" descriptor, else the
 * highest density "x" (a plain URL counts as 1x). Commas inside URLs are
 * split by the "URL then descriptor" grammar, not blindly.
 */
export function pickSrcset(srcset) {
  const s = String(srcset ?? "");
  const items = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    let url = "";
    while (i < s.length && !/\s/.test(s[i])) url += s[i++];
    // A URL ending in commas: those are separators.
    const trailing = /,+$/.exec(url);
    let desc = "";
    if (trailing) url = url.slice(0, -trailing[0].length);
    else {
      while (i < s.length && s[i] !== ",") desc += s[i++];
    }
    if (!url) continue;
    const d = desc.trim();
    const w = /^(\d+)w$/.exec(d);
    const x = /^(\d+(?:\.\d+)?)x$/.exec(d);
    items.push({ url, w: w ? Number(w[1]) : 0, x: x ? Number(x[1]) : w ? 0 : 1 });
  }
  if (!items.length) return "";
  const byW = items.filter((c) => c.w > 0).sort((a, b) => b.w - a.w);
  if (byW.length) return byW[0].url;
  return items.sort((a, b) => b.x - a.x)[0].url;
}

/** The origin of a server URL the person typed ("zvena.example.com" → https://zvena.example.com), or "". */
export function serverOrigin(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    // Plain http only for this machine (a local test server); a real server needs TLS.
    if (u.protocol === "http:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return "";
    return u.origin;
  } catch {
    return "";
  }
}

/** The match pattern for an origin (patterns carry no port: it matches every port of the host). */
export function originPattern(origin) {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}
