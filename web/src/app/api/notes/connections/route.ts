import { access, crossSite, currentUser, fail, json } from "@/lib/http";
import { connectPage, connectionChain, disconnectPage, listIntegrations } from "@/lib/notes/api/integrations";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { docsPresence, pageLevel } from "@/lib/notes/access";

export const dynamic = "force-dynamic";

// A page's connections (Notion's page menu → Connections).
// GET    ?ws=&id=<note>                  → { integrations, direct, inherited }   (members)
// POST   ?ws= { integration, noteId }   → { ok }  (editors: the integration sees the page and what is under it)
// DELETE ?ws= { integration, noteId }   → { ok }

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const u = new URL(req.url);
  const ws = u.searchParams.get("ws");
  const id = u.searchParams.get("id") ?? "";
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  if (!NOTE_ID_RE.test(id)) return fail(400, "bad request");
  if (!pageLevel(me.user.id, ws, id)) return fail(404, "not found");
  // Integrations are the workspace's: a guest sees that a page is connected, not to what.
  const integrations = docsPresence(me.user.id, ws)?.guest ? [] : listIntegrations(ws as string).map((i) => ({ id: i.id, name: i.name, icon: i.icon }));
  return json({ integrations, ...connectionChain(ws as string, id) });
}

async function change(req: Request, on: boolean) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!access(me.user.id, ws, "edit")) return fail(403, "forbidden");
  const p = await readJsonCapped(req, 2_000);
  const b = p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
  if (typeof b.integration !== "string" || typeof b.noteId !== "string" || !NOTE_ID_RE.test(b.noteId)) return fail(400, "bad request");
  // Connecting changes who reads the page (Notion: full access).
  if (pageLevel(me.user.id, ws, b.noteId) !== "full") return fail(403, "forbidden");
  const ok = on ? connectPage(me.user.id, ws as string, b.integration, b.noteId) : disconnectPage(me.user.id, ws as string, b.integration, b.noteId);
  return ok ? json({ ok }) : fail(404, "not found");
}

export const POST = (req: Request) => change(req, true);
export const DELETE = (req: Request) => change(req, false);
