// Which addresses the app opens, and where shared items go. The native code
// mirrors these rules (android/.../Links.java, ios/App/App/Links.swift); the
// tests in test/links.test.mjs pin them down.
//
//   zvena://docs?ws=…#Page-<id>   → <APP_URL>/docs?ws=…#Page-<id>
//   zvena://open?url=<abs URL>    → that URL, only on the app's own origin
//   <APP_URL>/docs…               → itself (universal links / App Links)
// Anything else, or anything that would leave the app's origin, opens nothing.

"use strict";

/** Paths the app claims as universal links / App Links (the rest open in the browser). */
const LINK_PATHS = ["/docs", "/n/", "/share/", "/join/", "/projects", "/home", "/inbox", "/clip"];

const MAX = 8000;

function originOf(appUrl) {
  const u = new URL(appUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("APP_URL must be http(s)");
  return u.origin;
}

/** A URL on the app's origin, or null. */
function sameOrigin(raw, origin) {
  try {
    const u = new URL(raw);
    return u.origin === origin && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Whether an https link of the app's origin is one the app handles. */
function claimedPath(pathname) {
  return LINK_PATHS.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
}

/** The page to load for a deep link, universal link or app link; null: ignore it. */
function resolveLink(raw, appUrl) {
  if (typeof raw !== "string" || !raw || raw.length > MAX) return null;
  const origin = originOf(appUrl);
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "https:" || u.protocol === "http:") {
    const same = sameOrigin(raw, origin);
    return same && claimedPath(new URL(same).pathname) ? same : null;
  }
  // No user info ("zvena://x@host"): the path is all there is.
  if (u.protocol !== "zvena:" || /^zvena:\/\/[^/?#]*@/i.test(raw)) return null;
  // new URL("zvena://docs?x#y"): host "docs", pathname "", search "?x", hash "#y".
  const head = `${u.host}${u.pathname}`.replace(/^\/+/, "");
  if (head === "open") {
    const target = u.searchParams.get("url");
    return target ? sameOrigin(target, origin) : `${origin}/`;
  }
  // Backslashes and encoded slashes could turn the path into another host in some parsers.
  if (/[\\]|%2f|%5c/i.test(head)) return null;
  return sameOrigin(`${origin}/${head}${u.search}${u.hash}`, origin);
}

/** The first http(s) URL in shared text. */
function firstUrl(text) {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text || "");
  return m ? m[0].replace(/[).,;:!?\]]+$/, "") : "";
}

/**
 * Where a shared item goes: the web app's "Save to zvena" screen, filled in
 * (it saves only after a tap there). `text` without its URL, `subject` as the title.
 */
function clipUrl(shared, appUrl) {
  const origin = originOf(appUrl);
  const text = String(shared.text || "").slice(0, MAX);
  const url = String(shared.url || "") || firstUrl(text);
  const rest = url ? text.split(url).join(" ").replace(/\s+/g, " ").trim() : text.trim();
  const q = new URLSearchParams();
  if (url) q.set("url", url);
  if (shared.subject) q.set("title", String(shared.subject).slice(0, 300));
  if (rest) q.set("text", rest.slice(0, 4000));
  return `${origin}/clip${q.toString() ? `?${q}` : ""}`;
}

module.exports = { LINK_PATHS, resolveLink, firstUrl, clipUrl, originOf };
