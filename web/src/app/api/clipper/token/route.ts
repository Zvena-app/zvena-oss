import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { bearerOf, clipperUser, redeemClipperCode, revokeClipper } from "@/lib/clipper";
import { fail, json } from "@/lib/http";
import { requestSelfOrigin } from "@/lib/request-guard";

export const dynamic = "force-dynamic";

// POST   /api/clipper/token { code, verifier } → { token, user: { id, name }, expiresAt }
//        The extension trades the one-time code of /clipper/connect (PKCE).
// DELETE /api/clipper/token (Authorization: Bearer …) → { ok } — the extension's Disconnect.
// No cookies here: a web page of another site is refused (it has no business with this).

function foreignPage(req: Request): boolean {
  const o = (req.headers.get("origin") || "").trim();
  if (!o || !/^https?:/i.test(o)) return false;
  try {
    return new URL(o).host !== new URL(requestSelfOrigin(req)).host;
  } catch {
    return true;
  }
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "clipper-token");
  if (rl) return rl;
  if (foreignPage(req)) return fail(403, "forbidden origin");
  const parsed = await readJsonCapped(req, 4000);
  if (!parsed.ok) return fail(parsed.status, "bad request");
  const b = parsed.value as { code?: unknown; verifier?: unknown };
  const issued = redeemClipperCode(b.code, b.verifier);
  if (!issued) return fail(400, "invalid code");
  return json({ token: issued.token, user: { id: issued.user.id, name: issued.user.name }, expiresAt: issued.expiresAt });
}

export async function DELETE(req: Request) {
  const rl = rateLimited(req, "clipper-token");
  if (rl) return rl;
  if (foreignPage(req)) return fail(403, "forbidden origin");
  const token = bearerOf(req);
  const who = token ? clipperUser(token) : null;
  if (!who) return fail(401, "unauthorized");
  revokeClipper(who.user.id, who.tokenId);
  return json({ ok: true });
}
