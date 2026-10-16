// Server-only: finishing a sign-in — the session cookie, the guest's files
// moving into the account, and where to go next.

import { NextResponse } from "next/server";
import { cookieSecure, issueSession, sessionCookie, type AuthUser } from "./auth";
import { config } from "./config";
import { domainJoinUrl } from "./enterprise/join";
import { adoptGuestFiles, GUEST_COOKIE, isGuestId } from "./storage";
import { personalWorkspace } from "./workspaces";

export function finishSignIn(user: AuthUser, opts: { next: string; guest: string | null; isNew: boolean; personalName: string }): NextResponse {
  personalWorkspace(user.id, opts.personalName);
  if (isGuestId(opts.guest)) adoptGuestFiles(opts.guest, user.id);
  // safeNext() already vetted `next`; never leave zvena's origin regardless.
  let target = new URL(opts.next || "/home", config.appUrl);
  if (target.origin !== new URL(config.appUrl).origin) target = new URL("/home", config.appUrl);
  if (opts.isNew) {
    // A new account sets zvena up first (name, look, team: app/welcome), then goes on.
    target.searchParams.set("welcome", "1");
    const then = `${target.pathname}${target.search}${target.hash}`;
    target = new URL("/welcome", config.appUrl);
    target.searchParams.set("next", then);
  }
  // An address whose domain a workspace opened to its people: that workspace is offered first (lib/enterprise/join.ts).
  const res = NextResponse.redirect(domainJoinUrl(user.id, target) ?? target, 303);
  res.headers.set("cache-control", "no-store");
  res.headers.append("set-cookie", sessionCookie(issueSession(user.id)));
  // The guest id has done its job.
  res.headers.append("set-cookie", `${GUEST_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${cookieSecure() ? "; Secure" : ""}; Max-Age=0`);
  return res;
}

export function signInError(code: string, next: string): NextResponse {
  const u = new URL("/signin", config.appUrl);
  u.searchParams.set("error", code);
  if (next && next !== "/home") u.searchParams.set("next", next);
  const res = NextResponse.redirect(u, 303);
  res.headers.set("cache-control", "no-store");
  return res;
}
