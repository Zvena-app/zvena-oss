import { scimAuth, scimError, scimRequest } from "@/lib/enterprise/scim";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// SCIM 2.0 (RFC 7644) for identity providers: /scim/v2/Users, /Groups,
// /ServiceProviderConfig, /ResourceTypes, /Schemas. Bearer token only (no
// cookies): see lib/enterprise/scim.ts.

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, { params }: Ctx): Promise<Response> {
  const rl = rateLimited(req, "scim", 600);
  if (rl) return scimError(429, "Too many requests.");
  const who = scimAuth(req.headers.get("authorization"));
  if (!who) return new Response(JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401", detail: "A valid bearer token is required." }), {
    status: 401,
    headers: { "content-type": "application/scim+json; charset=utf-8", "www-authenticate": 'Bearer realm="zvena SCIM"', "cache-control": "no-store" },
  });
  const { path } = await params;
  return scimRequest(req, path, who);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
