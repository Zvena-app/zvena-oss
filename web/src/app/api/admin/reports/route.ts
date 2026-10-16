import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { listReports, parseTarget, resolveReport, restoreContent, type ReportKind } from "@/lib/reports";
import { removeFileByModerator } from "@/lib/storage";
import { audit } from "@/lib/store";
import { readJsonCapped } from "@/lib/safe-json";

export const dynamic = "force-dynamic";

// The moderators' queue (administrators only).
// GET ?status=new|done                         → { reports }
// POST { id, action: "removed" | "rejected", note? } → { ok }
// POST { restore: { kind, target } }           → { ok }
// POST { deleteFile: "<file link or name>" }   → { ok, removed } — takes an
//   uploaded file down without a report (deleted, blocked from coming back)

function admin(req: Request) {
  const me = currentUser(req);
  return me?.user.isAdmin ? me.user : null;
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "admin");
  if (rl) return rl;
  if (!admin(req)) return fail(404, "not found");
  const status = new URL(req.url).searchParams.get("status") === "done" ? "done" : "new";
  return json({ reports: listReports(status) });
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "admin");
  if (rl) return rl;
  const bad = crossSite(req);
  if (bad) return bad;
  const user = admin(req);
  if (!user) return fail(404, "not found");
  const p = await readJsonCapped(req, 10_000);
  if (!p.ok) return fail(400, "bad request");
  const b = p.value as { id?: unknown; action?: unknown; note?: unknown; restore?: { kind?: unknown; target?: unknown }; deleteFile?: unknown };
  if (b.deleteFile !== undefined) {
    const t = typeof b.deleteFile === "string" ? parseTarget(b.deleteFile.includes("/") ? b.deleteFile : `/api/notes/file/${b.deleteFile}`) : null;
    if (t?.kind !== "file") return fail(400, "not a file link");
    const removed = await removeFileByModerator(t.target, user.id);
    audit(user.id, "file.removed", t.target);
    return json({ ok: true, removed });
  }
  if (b.restore && (b.restore.kind === "page" || b.restore.kind === "form") && typeof b.restore.target === "string") {
    restoreContent(b.restore.kind as ReportKind, b.restore.target, user.id);
    return json({ ok: true });
  }
  if (typeof b.id !== "string" || (b.action !== "removed" && b.action !== "rejected")) return fail(400, "bad request");
  try {
    const ok = await resolveReport(b.id, user.id, b.action, typeof b.note === "string" ? b.note : "");
    return ok ? json({ ok }) : fail(409, "already resolved");
  } catch {
    return fail(503, "design unavailable");
  }
}
