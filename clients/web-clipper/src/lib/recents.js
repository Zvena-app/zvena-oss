// Recent destinations, as in Notion's clipper: the last few places a clip
// went, per server and workspace, newest first.

export const MAX_RECENTS = 5;

export const recentsKey = (server, ws) => `recent:${server}|${ws}`;
export const lastKey = (server) => `last:${server}`;

/** A destination as kept: only what the picker shows. */
export function cleanDest(d) {
  if (!d || (d.kind !== "page" && d.kind !== "database") || typeof d.id !== "string" || !d.id) return null;
  return { id: d.id, kind: d.kind, title: String(d.title ?? "").slice(0, 200), icon: safeIcon(d.icon), path: String(d.path ?? "").slice(0, 300) };
}

/** `dest` first, no duplicates, at most MAX_RECENTS. */
export function pushRecent(list, dest, max = MAX_RECENTS) {
  const d = cleanDest(dest);
  const rest = (Array.isArray(list) ? list : []).map(cleanDest).filter(Boolean);
  if (!d) return rest.slice(0, max);
  return [d, ...rest.filter((x) => x.id !== d.id)].slice(0, max);
}

/** Emoji icons only: custom icons ("icon:…") and uploaded ones ("/api/…") are the app's, not text. */
export function safeIcon(icon) {
  const s = typeof icon === "string" ? icon : "";
  if (!s || s.startsWith("icon:") || s.startsWith("/") || /[<>]/.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s)) return "";
  return s.slice(0, 16);
}
