import { crossSite, currentUser, fail, json } from "@/lib/http";
import { docsPrefs, setDocsPrefs } from "@/lib/notes/follows";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// The signed-in person's Documents settings (lib/notes/follows.ts): which
// notifications come to their Inbox, and whether their page views are kept.
// GET                                      → { muted: [kind], viewHistory }
// POST { notify?: { kind: bool }, viewHistory?: bool } → the same, saved

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  return json(docsPrefs(me.user.id));
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const parsed = await readJsonCapped(req, 2_000);
  if (!parsed.ok) return fail(parsed.status, "bad request");
  return json(setDocsPrefs(me.user.id, parsed.value));
}
