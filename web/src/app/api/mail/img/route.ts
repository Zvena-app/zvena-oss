import { onForeignHost } from "@/lib/enterprise/hosts";
import { currentUser } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { validProxy } from "@/lib/mail-client/body";
import { fetchFile } from "@/lib/web-read";

export const dynamic = "force-dynamic";

// GET /api/mail/img?u=<url>&s=<signature> — a remote image of a message,
// fetched by the server so the sender never sees the reader (no address, no
// cookies, no referrer, no "opened at"). Only for the person the signature
// was made for (lib/mail-client/body.ts), only public addresses (the SSRF
// guard of lib/web-read.ts), only raster images (never SVG, which could
// carry script if opened directly), at most 8 MB.

const TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/;
const MAX = 8_000_000;

function none(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

export async function GET(req: Request) {
  // Off the proxy (src/proxy.ts): a site's custom domain gets nothing of Mail.
  if (onForeignHost(req)) return new Response("Not found\n", { status: 404 });
  const rl = rateLimited(req, "mail-img", 900);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return none(401);
  const u = new URL(req.url);
  const url = u.searchParams.get("u") ?? "";
  const sig = u.searchParams.get("s") ?? "";
  if (url.length > 2000 || !validProxy(me.user.id, url, sig)) return none(403);
  const f = await fetchFile(url, { timeoutMs: 12_000, maxBytes: MAX, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8" });
  const type = (f?.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!f || f.truncated || !TYPES.test(type)) return none(404);
  return new Response(new Uint8Array(f.body), {
    headers: {
      "content-type": type,
      "content-length": String(f.body.length),
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
