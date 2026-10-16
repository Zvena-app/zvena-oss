import { onForeignHost } from "@/lib/enterprise/hosts";
import { currentUser } from "@/lib/http";
import { rateLimited } from "@/lib/rate-limit";
import { bodyCsp, renderBody } from "@/lib/mail-client/body";

export const dynamic = "force-dynamic";

// GET /api/mail/body/<message id>[?images=1][&dark=1] — one of the person's
// messages as the document of its sandboxed frame. Outside the page proxy:
// its own policy allows no script at all, no forms and no frames, images
// only from this server (the image proxy, inline parts) and data:, and only
// zvena's own pages may frame it.

const headers = () => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": bodyCsp(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Off the proxy (src/proxy.ts): a site's custom domain gets nothing of Mail.
  if (onForeignHost(req)) return new Response("Not found\n", { status: 404 });
  const rl = rateLimited(req, "mail", 900);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return new Response("unauthorized", { status: 401, headers: headers() });
  const { id } = await params;
  const u = new URL(req.url);
  const out = await renderBody(me.user.id, id, { images: u.searchParams.get("images") === "1", dark: u.searchParams.get("dark") === "1" });
  if (!out) return new Response("not found", { status: 404, headers: headers() });
  return new Response(out.html, { headers: { ...headers(), "x-zvena-blocked-images": String(out.blocked) } });
}
