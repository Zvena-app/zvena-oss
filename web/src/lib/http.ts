// Request helpers for the API routes: who is asking, CSRF origin check,
// workspace permission checks, JSON answers that are never cached.

import { NextResponse } from "next/server";
import { readCookie, refreshSession, type AuthUser } from "./auth";
import { rejectCrossSiteWrite, requestSelfOrigin } from "./request-guard";
import { GUEST_COOKIE, isGuestId } from "./storage";
import { sweepExpired } from "./store";
import { can, roleIn, type Role } from "./workspaces";

export const NO_STORE = { "cache-control": "private, no-store" };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function fail(status: number, error: string): NextResponse {
  return json({ error }, status);
}

/** The signed-in user (and a rotated cookie to set, if any). */
export function currentUser(req: Request): { user: AuthUser; setCookie?: string } | null {
  sweepExpired();
  return refreshSession(req.headers.get("cookie"));
}

/** Rejects a state-changing request from another site (CSRF). */
export function crossSite(req: Request): NextResponse | null {
  return rejectCrossSiteWrite(req, requestSelfOrigin(req)) ? fail(403, "forbidden origin") : null;
}

export type Need = "read" | "comment" | "edit" | "manage";

/** The user's role when it allows `need` in the workspace; else null. */
export function access(userId: string, wsId: string | null, need: Need): Role | null {
  if (!wsId || !/^[A-Za-z0-9_-]{8,40}$/.test(wsId)) return null;
  const role = roleIn(userId, wsId);
  return role && can[need](role) ? role : null;
}

export function guestId(req: Request): string | null {
  const g = readCookie(req, GUEST_COOKIE);
  return isGuestId(g) ? g : null;
}

export function guestCookie(id: string, secure: boolean): string {
  return `${GUEST_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${400 * 86400}`;
}
