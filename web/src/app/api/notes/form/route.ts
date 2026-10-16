import { publishingAllowed } from "@/lib/enterprise/security";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { atLeast, docsPresence, levelOf } from "@/lib/notes/access";
import { closeNoteForm, noteFormDbId, noteFormSource, openNoteForm } from "@/lib/notes/server-store";
import { FORM_ID_RE, NOTE_ID_RE } from "@/lib/notes/types";

export const dynamic = "force-dynamic";

// Documents forms: people who may edit the database open or close the public link of a form view.
// POST   ?ws=<id> { dbId, viewId } → { id }   (responses become rows of that database)
// DELETE ?ws=<id> { id }           → { ok }

async function guard(req: Request): Promise<{ ws: string; userId: string; body: Record<string, unknown> } | Response> {
  const rl = rateLimited(req, "notes-share");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "sign in required");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const parsed = await readJsonCapped(req, 10_000);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return fail(400, "bad request");
  return { ws: ws as string, userId: me.user.id, body: parsed.value as Record<string, unknown> };
}

export async function POST(req: Request) {
  const g = await guard(req);
  if (g instanceof Response) return g;
  const { dbId, viewId } = g.body;
  if (typeof dbId !== "string" || !NOTE_ID_RE.test(dbId) || typeof viewId !== "string" || !/^[\w-]{1,40}$/.test(viewId)) return fail(400, "bad request");
  if (!atLeast(levelOf(g.ws, g.userId, dbId), "edit")) return fail(403, "forbidden");
  // A public form link is publishing to the web (Settings → Security can switch it off).
  if (!publishingAllowed(g.ws)) return fail(403, "publishing is disabled in this workspace");
  // Responses become rows of the view's data source: the opener must be able to add them there too.
  const src = noteFormSource(g.ws, dbId, viewId);
  if (src && src !== dbId && !atLeast(levelOf(g.ws, g.userId, src), "edit")) return fail(403, "forbidden");
  try {
    return json({ id: openNoteForm(g.ws, dbId, viewId) });
  } catch (e) {
    if (e instanceof Error && e.message === "removed") return fail(451, "removed by moderator");
    return fail(503, "unavailable");
  }
}

export async function DELETE(req: Request) {
  const g = await guard(req);
  if (g instanceof Response) return g;
  const { id } = g.body;
  if (typeof id !== "string" || !FORM_ID_RE.test(id)) return fail(400, "bad request");
  const dbId = noteFormDbId(id, g.ws);
  if (dbId && !atLeast(levelOf(g.ws, g.userId, dbId), "edit")) return fail(403, "forbidden");
  try {
    return json({ ok: closeNoteForm(id, g.ws) });
  } catch {
    return fail(503, "unavailable");
  }
}
