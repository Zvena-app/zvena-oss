import { config } from "@/lib/config";
import { designContext, UUID_RE } from "@/lib/design-api";
import { fail, json } from "@/lib/http";
import { framePreview } from "@/lib/penpot";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/design/frame?ws=<id>&file=<uuid>&frame=<uuid> → { name, revn, hasImage, openUrl }
// The live design block polls this: a new revn means the design changed and
// the image is fetched again (with ?v=<revn>).
export async function GET(req: Request) {
  const rl = rateLimited(req, "design-preview");
  if (rl) return rl;
  const c = await designContext(req);
  if (c instanceof Response) return c;
  const u = new URL(req.url);
  const file = u.searchParams.get("file") ?? "";
  const frame = u.searchParams.get("frame") ?? "";
  if (!UUID_RE.test(file) || !UUID_RE.test(frame)) return fail(400, "bad ids");
  try {
    const p = await framePreview(c.userId, file, frame);
    if (p.teamId !== c.teamId) return fail(404, "not found");
    const open = new URL(`${config.designUrl}/`);
    open.hash = `/workspace?team-id=${c.teamId}&file-id=${file}${p.pageId ? `&page-id=${p.pageId}` : ""}&board-id=${frame}`;
    return json({ name: p.name, revn: p.revn, hasImage: Boolean(p.mediaId), openUrl: open.toString() });
  } catch {
    return fail(404, "not found");
  }
}
