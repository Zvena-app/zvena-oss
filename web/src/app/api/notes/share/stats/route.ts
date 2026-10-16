import { onForeignHost } from "@/lib/enterprise/hosts";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { canRead, docsPresence } from "@/lib/notes/access";
import { noteShareNoteId, noteShareViews, noteShareViewsByDay } from "@/lib/notes/server-store";

export const dynamic = "force-dynamic";

// Views of a published page, for the Publish panel (people who may read the page).
// POST ?ws=<id> { id } → { views, days: [{ day: "YYYY-MM-DD", n }] (the last 28 days) }
export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-share");
  if (rl) return rl;
  // Never on a site's custom domain (this route skips the proxy that guards those).
  if (onForeignHost(req)) return fail(404, "not found");
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "sign in required");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const parsed = await readJsonCapped(req, 10_000);
  if (!parsed.ok) return fail(400, "bad request");
  const body = parsed.value as { id?: unknown };
  if (typeof body.id !== "string") return fail(400, "bad request");
  const noteId = noteShareNoteId(body.id, ws as string);
  if (!noteId || !canRead(ws as string, me.user.id, noteId)) return fail(404, "not found");
  const views = noteShareViews(body.id, ws as string);
  if (views === null) return fail(404, "not found");
  return json({ views, days: noteShareViewsByDay(body.id, ws as string) ?? [] });
}
