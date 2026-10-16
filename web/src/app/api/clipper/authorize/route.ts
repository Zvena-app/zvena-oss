import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { CHALLENGE_RE, STATE_RE, cleanClient, issueClipperCode } from "@/lib/clipper";
import { crossSite, currentUser, fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// POST /api/clipper/authorize { state, challenge, client } → { code }
// The person pressed Allow on /clipper/connect (our own page, signed in):
// a one-time code for the extension that holds the challenge's verifier.

export async function POST(req: Request) {
  const rl = rateLimited(req, "clipper-token");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  if (!me.user.consentOk) return fail(403, "consent required");
  const parsed = await readJsonCapped(req, 4000);
  if (!parsed.ok) return fail(parsed.status, "bad request");
  const b = parsed.value as { state?: unknown; challenge?: unknown; client?: unknown };
  if (typeof b.state !== "string" || !STATE_RE.test(b.state) || typeof b.challenge !== "string" || !CHALLENGE_RE.test(b.challenge)) return fail(400, "bad request");
  return json({ code: issueClipperCode(me.user.id, b.challenge, cleanClient(b.client)) });
}
