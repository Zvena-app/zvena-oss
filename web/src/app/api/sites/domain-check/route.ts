import { customDomainsOn, normalizeDomain } from "@/lib/enterprise/hosts";
import { shareForHost } from "@/lib/enterprise/site-domains";

export const dynamic = "force-dynamic";

// GET /api/sites/domain-check?domain=docs.example.com — Caddy's on-demand
// TLS "ask" endpoint (deploy/caddy/Caddyfile): 200 only for a verified
// custom domain whose site is live, so certificates are issued for those
// and nothing else. One indexed lookup; no body worth reading.
export async function GET(req: Request) {
  if (!customDomainsOn()) return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const domain = normalizeDomain(new URL(req.url).searchParams.get("domain"));
  const ok = Boolean(domain && shareForHost(domain));
  return new Response(ok ? "ok\n" : "unknown domain\n", { status: ok ? 200 : 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
