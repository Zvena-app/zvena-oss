import { addDomain, DomainError, domainsOf, removeDomain, setAllowJoin, verifyDomain } from "@/lib/enterprise/domains";
import { body, ownerOnly } from "@/lib/enterprise/http";
import { fail, json } from "@/lib/http";

export const dynamic = "force-dynamic";

// Settings → Identity → Verified domains (owner of a shared workspace).
// GET  ?ws=                                  → { domains }
// POST ?ws= { op: "add", domain }            → { domain }   (the TXT record to publish)
// POST ?ws= { op: "verify", domain }         → { domain } | 409 { error }
// POST ?ws= { op: "join", domain, on }       → { ok }       "Allowed e-mail domains"
// POST ?ws= { op: "remove", domain }         → { ok }

export async function GET(req: Request) {
  const g = await ownerOnly(req, { shared: true });
  if (g instanceof Response) return g;
  return json({ domains: domainsOf(g.ws) });
}

export async function POST(req: Request) {
  const g = await ownerOnly(req, { shared: true, scope: "ent-domains" });
  if (g instanceof Response) return g;
  const b = await body(req, 4_000);
  const domain = typeof b.domain === "string" ? b.domain.trim().toLowerCase() : "";
  try {
    if (b.op === "add") return json({ domain: addDomain(g.ws, g.user.id, b.domain) });
    if (b.op === "verify" && domain) {
      const r = await verifyDomain(g.ws, g.user.id, domain);
      return r.ok ? json({ domain: r.domain }) : fail(r.error === "not found" ? 404 : r.error === "dns" ? 503 : 409, r.error);
    }
    if (b.op === "join" && domain && typeof b.on === "boolean") return json({ ok: setAllowJoin(g.ws, g.user.id, domain, b.on) });
    if (b.op === "remove" && domain) return json({ ok: removeDomain(g.ws, g.user.id, domain) });
  } catch (e) {
    if (e instanceof DomainError) return fail(400, e.message);
    throw e;
  }
  return fail(400, "bad request");
}
