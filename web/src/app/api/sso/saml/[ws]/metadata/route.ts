import { spMetadata } from "@/lib/enterprise/saml";
import { ssoOf } from "@/lib/enterprise/sso";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/sso/saml/<workspace>/metadata — our service-provider metadata
// (entity id = this URL, the ACS URL): public, as identity providers fetch
// it by URL. ?download=1 saves it as a file.
export async function GET(req: Request, { params }: { params: Promise<{ ws: string }> }) {
  const rl = rateLimited(req, "share-read");
  if (rl) return rl;
  const { ws } = await params;
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(ws) || ssoOf(ws)?.kind === "oidc") return new Response("not found", { status: 404 });
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new Response(spMetadata(ws), {
    headers: {
      "content-type": "application/samlmetadata+xml; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(download ? { "content-disposition": `attachment; filename="zvena-sp-metadata-${ws}.xml"` } : {}),
    },
  });
}
