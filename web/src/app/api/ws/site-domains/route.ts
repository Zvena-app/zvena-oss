import { body, ownerOnly } from "@/lib/enterprise/http";
import { addSiteDomain, publishedSitesOf, removeSiteDomain, SiteDomainError, siteDomainsOf, verifySiteDomain } from "@/lib/enterprise/site-domains";
import { customDomainsOn } from "@/lib/enterprise/hosts";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Settings → Sites → Custom domains (owner).
// GET  ?ws=                                    → { domains, sites }
// POST ?ws= { op: "add", shareId, domain }     → { domain }   (the CNAME / TXT to set)
// POST ?ws= { op: "verify", domain }           → { domain, via } | 409 { error }
// POST ?ws= { op: "remove", domain }           → { ok }

export async function GET(req: Request) {
  if (!customDomainsOn()) return fail(404, "not found");
  const g = await ownerOnly(req);
  if (g instanceof Response) return g;
  return json({ domains: siteDomainsOf(g.ws), sites: publishedSitesOf(g.ws) });
}

export async function POST(req: Request) {
  if (!customDomainsOn()) return fail(404, "not found");
  const g = await ownerOnly(req, { scope: "ent-domains" });
  if (g instanceof Response) return g;
  const b = await body(req, 4_000);
  const domain = typeof b.domain === "string" ? b.domain.trim().toLowerCase() : "";
  try {
    if (b.op === "add") return json({ domain: addSiteDomain(g.ws, g.user.id, b.shareId, b.domain) });
    if (b.op === "verify" && domain) {
      const r = await verifySiteDomain(g.ws, g.user.id, domain);
      return r.ok ? json({ domain: r.site, via: r.via }) : fail(r.error === "not found" ? 404 : r.error === "dns" ? 503 : 409, r.error);
    }
    if (b.op === "remove" && domain) return json({ ok: removeSiteDomain(g.ws, g.user.id, domain) });
  } catch (e) {
    if (e instanceof SiteDomainError) return fail(400, e.message);
    throw e;
  }
  return fail(400, "bad request");
}
