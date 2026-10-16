import { ownerOnly } from "@/lib/enterprise/http";
import { fail, json } from "@/lib/http";
import { ANALYTICS_SPANS, workspaceAnalytics } from "@/lib/notes/ws-analytics";

export const dynamic = "force-dynamic";

// Settings → Analytics (owner): members' activity and the pages read and edited.
// GET ?ws=&span=7|28|90&tz=<minutes east of UTC> → WorkspaceAnalytics
export async function GET(req: Request) {
  const g = await ownerOnly(req, { scope: "ws-analytics" });
  if (g instanceof Response) return g;
  const url = new URL(req.url);
  const span = Number(url.searchParams.get("span") ?? "28");
  const tz = Number(url.searchParams.get("tz") ?? "0");
  if (!(ANALYTICS_SPANS as readonly number[]).includes(span)) return fail(400, "bad request");
  try {
    return json(workspaceAnalytics(g.ws, g.user.id, span, Date.now(), Number.isFinite(tz) ? tz : 0));
  } catch {
    return fail(503, "unavailable");
  }
}
