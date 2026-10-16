import { designContext, UUID_RE } from "@/lib/design-api";
import { fail, json } from "@/lib/http";
import { fileFrames } from "@/lib/penpot";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/design/frames?ws=<id>&file=<uuid> → { name, frames } — top-level frames of a design.
export async function GET(req: Request) {
  const rl = rateLimited(req, "design");
  if (rl) return rl;
  const c = await designContext(req);
  if (c instanceof Response) return c;
  const file = new URL(req.url).searchParams.get("file") ?? "";
  if (!UUID_RE.test(file)) return fail(400, "bad file");
  try {
    const r = await fileFrames(c.userId, file);
    if (r.teamId !== c.teamId) return fail(404, "not found");
    return json({ name: r.name, revn: r.revn, frames: r.frames });
  } catch {
    return fail(404, "not found");
  }
}
