import { createHash } from "node:crypto";
import { readCookie, signInWith } from "@/lib/auth";
import { config } from "@/lib/config";
import { crossSite, fail, guestId } from "@/lib/http";
import { parseAcceptLanguage, resolveLocale, translate, UI_LANG_COOKIE } from "@/lib/i18n";
import { safeNext } from "@/lib/oauth";
import { rateLimited } from "@/lib/rate-limit";
import { readFormCapped } from "@/lib/safe-json";
import { finishSignIn, signInError } from "@/lib/signin";

export const dynamic = "force-dynamic";

// POST /api/auth/dev (form: name, next) — the test sign-in of a test
// stand (ZVENA_STAND=test and ZVENA_DEV_LOGIN=1 together; 404 anywhere else).
// The same name signs in to the same fake account, so a checklist can come
// back as the same person. Never enabled in production.
export async function POST(req: Request) {
  if (!config.devLogin) return fail(404, "not found");
  const rl = rateLimited(req, "auth-dev");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const form = await readFormCapped(req);
  const name = String(form?.get("name") ?? "").trim().slice(0, 60) || "Test User";
  const next = safeNext(String(form?.get("next") ?? "/home"));
  const subject = createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 24);
  const result = signInWith({ provider: "dev", subject, name }, config.consentVersion);
  if (!result.ok) return signInError(result.error, next);
  const locale = resolveLocale(readCookie(req, UI_LANG_COOKIE), parseAcceptLanguage(req.headers.get("accept-language")));
  return finishSignIn(result.user, { next, guest: guestId(req), isNew: result.isNew, personalName: translate(locale, "ws.personal") });
}
