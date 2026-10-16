import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import { userIdOfLogin } from "@/lib/penpot";
import { docsUsage } from "@/lib/storage";

export const dynamic = "force-dynamic";

// GET /api/internal/usage?login=u-<id>@users.zvena.app → { quota, docs }
// For Design's backend (app.zvena.limits): the account's quota and what its
// documents and files take. Internal: the shared key ZVENA_INTERNAL_KEY in
// x-zvena-key; the public nginx never routes /api/internal/.
function keyOk(req: Request): boolean {
  const want = process.env.ZVENA_INTERNAL_KEY || "";
  const got = req.headers.get("x-zvena-key") || "";
  if (want.length < 32) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(want), h(got));
}

export async function GET(req: Request) {
  if (!keyOk(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  const id = userIdOfLogin(new URL(req.url).searchParams.get("login") ?? "");
  const d = id ? docsUsage(id) : { notes: 0, files: 0 };
  return Response.json({ quota: config.storageQuota, docs: d.notes + d.files }, { headers: { "cache-control": "no-store" } });
}
