import { moveOutAllowed } from "@/lib/enterprise/security";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { movePageToWorkspace } from "@/lib/notes/move-workspace";
import "@/lib/notes/reactions";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// Moves a page (and everything under it) to another workspace (Notion's "Move to").
// POST { from, to, noteId } → { id, moved }   (full access to the page; may add pages in the destination)

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-move-ws", 10);
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const p = await readJsonCapped(req, 2_000);
  const b = p.ok && typeof p.value === "object" && p.value !== null ? (p.value as Record<string, unknown>) : {};
  const ws = /^[A-Za-z0-9_-]{8,40}$/;
  if (typeof b.from !== "string" || typeof b.to !== "string" || typeof b.noteId !== "string" || !ws.test(b.from) || !ws.test(b.to) || !NOTE_ID_RE.test(b.noteId)) return fail(400, "bad request");
  // The owner may keep pages in (Settings → Security → Disable moving pages to other workspaces).
  if (b.from !== b.to && !moveOutAllowed(b.from)) return fail(403, "moving pages out of this workspace is disabled");
  try {
    const r = await movePageToWorkspace(b.from, b.to, b.noteId, me.user.id, me.user.name);
    return r.ok ? json({ id: r.id, moved: r.moved }) : fail(r.status, r.error);
  } catch {
    return fail(503, "unavailable");
  }
}
