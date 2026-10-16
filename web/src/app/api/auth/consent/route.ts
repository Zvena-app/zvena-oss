import { NextResponse } from "next/server";
import { recordConsent } from "@/lib/auth";
import { config } from "@/lib/config";
import { crossSite, currentUser, fail } from "@/lib/http";
import { safeNext } from "@/lib/safe-next";
import { rateLimited } from "@/lib/rate-limit";
import { readFormCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// POST /api/auth/consent (form: consent=1, next) — agreeing to the current
// version of the documents (the /consent page).
export async function POST(req: Request) {
  const rl = rateLimited(req, "auth-account");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const form = await readFormCapped(req);
  const next = safeNext(String(form?.get("next") ?? "/home"));
  if (form?.get("consent") !== "1") return NextResponse.redirect(new URL(`/consent?next=${encodeURIComponent(next)}`, config.appUrl), 303);
  recordConsent(me.user.id);
  const res = NextResponse.redirect(new URL(next, config.appUrl), 303);
  res.headers.set("cache-control", "no-store");
  return res;
}
