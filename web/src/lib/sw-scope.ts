// Server-only: whose page this is, for the service worker's offline copies
// (public/sw.js). An HMAC of the account id — stable across sessions of one
// person, unrelated between people, and not the id itself — or "guest".
// The worker stores a page only under the scope the page itself names, and
// drops everyone else's copies when the scope changes.

import { mac, readSession } from "./auth";

export function swScope(cookieHeader: string | null): string {
  try {
    const u = readSession(cookieHeader);
    return u ? mac("sw-scope", u.id).slice(0, 32) : "guest";
  } catch {
    // No AUTH_SECRET (a misconfigured server): nothing personal is kept offline.
    return "guest";
  }
}
