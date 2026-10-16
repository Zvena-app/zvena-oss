import { designContext } from "@/lib/design-api";
import { fail, json } from "@/lib/http";
import { teamFiles } from "@/lib/penpot";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/design/files?ws=<id> → { files } — the workspace's designs (the "Insert a design" picker).
export async function GET(req: Request) {
  const rl = rateLimited(req, "design");
  if (rl) return rl;
  const c = await designContext(req);
  if (c instanceof Response) return c;
  try {
    return json(await teamFiles(c.userId, c.teamId));
  } catch {
    return fail(503, "design unavailable");
  }
}
