// Where to go after sign-in: same-origin paths only.

import { config } from "./config";

/**
 * Only same-origin paths may be returned to after sign-in. Control characters
 * and spaces are refused outright: URL parsing drops tabs and newlines, so
 * "/\t/evil.com" would otherwise become "//evil.com" (another site). What is
 * returned is the path, query and fragment of a URL on zvena's own origin.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/home";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.length > 2000) return "/home";
  if (/[\x00-\x20\x7f]/.test(raw)) return "/home";
  try {
    const base = new URL(config.appUrl);
    const u = new URL(raw, base);
    if (u.origin !== base.origin) return "/home";
    const out = `${u.pathname}${u.search}${u.hash}`;
    return out.startsWith("//") ? "/home" : out;
  } catch {
    return "/home";
  }
}
