import { body, ownerOnly } from "@/lib/enterprise/http";
import { guestsOf, removeGuest } from "@/lib/enterprise/guests";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Settings → Guests (owner).
// GET  ?ws=                              → { guests: [{ id, name, email, pages: [{ id, title|null, level }] }] }
// POST ?ws= { op: "remove", userId }     → { ok }   their access to every page here goes
export async function GET(req: Request) {
  const g = await ownerOnly(req, { scope: "ws-guests" });
  if (g instanceof Response) return g;
  return json({ guests: guestsOf(g.ws, g.user.id) });
}

export async function POST(req: Request) {
  const g = await ownerOnly(req, { scope: "ws-guests" });
  if (g instanceof Response) return g;
  const b = await body(req, 2_000);
  if (b.op !== "remove" || typeof b.userId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(b.userId)) return fail(400, "bad request");
  return removeGuest(g.ws, g.user.id, b.userId) ? json({ ok: true }) : fail(404, "not found");
}
