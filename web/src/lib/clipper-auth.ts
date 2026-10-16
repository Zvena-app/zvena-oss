// Who is calling a clip route: the Web Clipper with its token (lib/clipper.ts),
// or the web app itself (the /clip page, the phone apps' WebView) with the
// session cookie and the usual same-origin check. A request that carries a
// token is judged by the token alone; cookies never stand in for it.

import type { NextResponse } from "next/server";
import type { AuthUser } from "./auth";
import { bearerOf, clipperUser } from "./clipper";
import { crossSite, currentUser, fail } from "./http";
import { requestSelfOrigin } from "./request-guard";

export interface ClipCaller {
  user: AuthUser;
  via: "token" | "session";
  tokenId?: string;
}

/**
 * A token request may come from an extension (chrome-extension://,
 * moz-extension://, safari-web-extension://) or without an Origin; a web
 * page of another site is refused even with a token (it should never hold
 * one). `write`: the cookie path checks the origin (CSRF).
 */
export function clipCaller(req: Request, write: boolean): ClipCaller | NextResponse {
  const bearer = bearerOf(req);
  if (bearer !== null) {
    const origin = (req.headers.get("origin") || "").trim();
    if (origin && /^https?:/i.test(origin) && hostOf(origin) !== hostOf(requestSelfOrigin(req))) return fail(403, "forbidden origin");
    const who = bearer ? clipperUser(bearer) : null;
    if (!who) return fail(401, "unauthorized");
    return { user: who.user, via: "token", tokenId: who.tokenId };
  }
  if (write) {
    const bad = crossSite(req);
    if (bad) return bad;
  }
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  return { user: me.user, via: "session" };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Clips per person per hour (the per-address limit is in lib/rate-limit.ts): a leaked token cannot fill a workspace. */
const PER_HOUR = 120;
const clips = new Map<string, number[]>();

export function clipBudget(userId: string, now = Date.now()): boolean {
  const recent = (clips.get(userId) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= PER_HOUR) {
    clips.set(userId, recent);
    return false;
  }
  recent.push(now);
  clips.set(userId, recent);
  if (clips.size > 5000) for (const [k, v] of clips) if (!v.some((t) => now - t < 3600_000)) clips.delete(k);
  return true;
}
