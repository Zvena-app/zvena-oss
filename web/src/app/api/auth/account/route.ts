import { deleteAccount } from "@/lib/account";
import { clearSessionCookie } from "@/lib/auth";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { translate } from "@/lib/i18n";
import { LOCALES } from "@/i18n/locales";
import "@/i18n/server-catalogs";

// The word typed to confirm, in any of the interface's languages ("DELETE", "УДАЛИТЬ", "删除"…).
const CONFIRM_WORDS = new Set(["DELETE", ...LOCALES.map((l) => translate(l, "settings.deleteWord").trim().toUpperCase())]);

export const dynamic = "force-dynamic";

// DELETE /api/auth/account { confirm: "DELETE" | the word in the person's language } — erases the account (lib/account.ts).
export async function DELETE(req: Request) {
  const rl = rateLimited(req, "auth-account");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const p = await readJsonCapped(req, 1_000);
  const confirm = p.ok ? String((p.value as { confirm?: unknown }).confirm ?? "").trim().toUpperCase() : "";
  if (!CONFIRM_WORDS.has(confirm)) return fail(400, "confirmation required");
  try {
    await deleteAccount(me.user.id);
  } catch {
    return fail(503, "unavailable");
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}
