import { onForeignHost } from "@/lib/enterprise/hosts";
import { currentUser } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { attachmentContent } from "@/lib/mail-client/attachments";

export const dynamic = "force-dynamic";

// GET /api/mail/att/<id>[?inline=1] — one of the person's attachments,
// downloaded from their mail server now (nothing is kept on zvena's disk).
// Always a download, except images shown inside a message (?inline=1, from
// its frame); served sandboxed and never sniffed, so no file can run script
// on zvena's origin.

const INLINE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Off the proxy (src/proxy.ts): a site's custom domain gets nothing of Mail.
  if (onForeignHost(req)) return new Response("Not found\n", { status: 404 });
  const rl = rateLimited(req, "mail-att", 240);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return new Response("unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  const { id } = await params;
  const a = await attachmentContent(me.user.id, id);
  if (!a) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const inline = new URL(req.url).searchParams.get("inline") === "1" && INLINE.test(a.type);
  const real = (a.filename || "file").replace(/[\u0000-\u001f\u007f"\\/]+/g, "_").slice(0, 150);
  const ascii = real.replace(/[^\w.\- ]+/g, "_");
  return new Response(new Uint8Array(a.content), {
    headers: {
      "content-type": inline ? a.type : "application/octet-stream",
      "content-length": String(a.content.length),
      "content-disposition": inline ? "inline" : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(real)}`,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
