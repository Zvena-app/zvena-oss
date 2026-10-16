import { onForeignHost } from "@/lib/enterprise/hosts";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/safe-json";
import { saveUpload, UploadError } from "@/lib/mail-client/attachments";
import { MAX_ATTACHMENTS_BYTES } from "@/lib/mail-client/compose";

export const dynamic = "force-dynamic";

// POST /api/mail/upload?name=<file name> (body: the file; content-type: its
// type) — a file attached in the composer. Outside the page proxy, which
// would cut bodies at 10 MB; the body is capped here at 25 MB (and the
// person's waiting files at ZVENA_MAIL_UPLOADS_BYTES).

export async function POST(req: Request) {
  // Off the proxy (src/proxy.ts): a site's custom domain gets nothing of Mail.
  if (onForeignHost(req)) return new Response("Not found\n", { status: 404 });
  const bad = crossSite(req);
  if (bad) return bad;
  const rl = rateLimited(req, "mail-upload", 60);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const b = await readBodyCapped(req, MAX_ATTACHMENTS_BYTES);
  if (!b.ok) return fail(b.status, b.status === 413 ? "file too big" : "bad request");
  const name = new URL(req.url).searchParams.get("name") ?? "file";
  try {
    const att = await saveUpload(me.user.id, { name, type: (req.headers.get("content-type") ?? "").split(";")[0].trim(), bytes: b.bytes });
    return json({ attachment: att });
  } catch (e) {
    if (e instanceof UploadError) return fail(e.status, e.code);
    console.error(`[mail] upload failed (${e instanceof Error ? e.name : "error"})`);
    return fail(500, "internal error");
  }
}
