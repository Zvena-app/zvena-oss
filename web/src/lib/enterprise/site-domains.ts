// Server-only: custom domains of published sites (Notion Sites → Custom
// domain). The owner of a workspace claims docs.example.com for one of its
// published pages and proves it, either way:
//
//   CNAME  docs.example.com → <claim>.<ZVENA_SITES_CNAME> (default
//          sites.<APP_URL's host>; a wildcard record sends every such name
//          to this server)
//   TXT    _zvena-site.docs.example.com = "zvena-site=<token>" (for a bare
//          domain, whose A record then points at this server)
//
// Both carry the claim's own secret: a CNAME to the shared sites.zvena.app
// alone proves nothing (anyone could claim a domain whose old CNAME was left
// dangling), so it routes but does not verify. A domain is verified by one
// workspace at a time; other claims stay pending. Once verified, requests
// for that host serve the site (src/proxy.ts) and Caddy may get it a
// certificate (on-demand TLS asks /api/sites/domain-check). It serves only
// while its page is published, not taken down by a moderator, and its
// workspace allows publishing.

import { randomBytes } from "node:crypto";
import { config } from "../config";
import { audit, sql } from "../store";
import { dns } from "./dns";
import { sitesCnameTarget } from "./domains";
import { hostOnly, isSameOrSub, normalizeDomain, customDomainsOn } from "./hosts";
import { publishingAllowed } from "./security";
import { ensureTables } from "./tables";

export const SITE_TXT_PREFIX = "zvena-site=";
const MAX_PER_WS = 20;

export interface SiteDomain {
  domain: string;
  shareId: string;
  title: string;
  verifiedAt: number | null;
  checkedAt: number | null;
  lastError: string | null;
  /** What to set at the DNS provider: the CNAME target, or the TXT record. */
  cname: string;
  txtName: string;
  txtValue: string;
}

export class SiteDomainError extends Error {}

interface Row {
  domain: string;
  ws: string;
  share_id: string;
  token: string;
  verified_at: number | null;
  checked_at: number | null;
  last_error: string | null;
  title: string | null;
}

/** The claim's own CNAME label: lower-case hex derived from its token (DNS labels are case-blind). */
function claimTarget(token: string): string {
  return `zv-${Buffer.from(token, "base64url").toString("hex").slice(0, 20)}.${sitesCnameTarget()}`;
}

const toSite = (r: Row): SiteDomain => ({
  domain: r.domain,
  shareId: r.share_id,
  title: r.title ?? "",
  verifiedAt: r.verified_at,
  checkedAt: r.checked_at,
  lastError: r.last_error,
  cname: claimTarget(r.token),
  txtName: `_zvena-site.${r.domain}`,
  txtValue: `${SITE_TXT_PREFIX}${r.token}`,
});

const SELECT = "SELECT d.domain, d.ws, d.share_id, d.token, d.verified_at, d.checked_at, d.last_error, s.title FROM ent_site_domains d LEFT JOIN note_shares s ON s.id = d.share_id";

function hostOf(url: string): string {
  try {
    return hostOnly(new URL(url).host);
  } catch {
    return "";
  }
}

function one(ws: string, domain: string): Row | undefined {
  return sql(`${SELECT} WHERE d.ws = ? AND d.domain = ?`).get(ws, domain) as Row | undefined;
}

export function siteDomainsOf(ws: string): SiteDomain[] {
  ensureTables();
  return (sql(`${SELECT} WHERE d.ws = ? ORDER BY d.domain`).all(ws) as unknown as Row[]).map(toSite);
}

/** The workspace's published pages a domain can point at. */
export function publishedSitesOf(ws: string): { id: string; title: string }[] {
  return (sql("SELECT id, title FROM note_shares WHERE ws = ? AND removed_at IS NULL ORDER BY updated_at DESC LIMIT 500").all(ws) as { id: string; title: string }[]).map((r) => ({ id: r.id, title: r.title }));
}

export function addSiteDomain(ws: string, actor: string, shareId: unknown, raw: unknown): SiteDomain {
  ensureTables();
  const domain = normalizeDomain(raw);
  if (!domain) throw new SiteDomainError("invalid domain");
  const own = [hostOf(config.appUrl), hostOf(config.designUrl), sitesCnameTarget()].filter(Boolean);
  if (own.some((h) => isSameOrSub(domain, h) || isSameOrSub(h, domain))) throw new SiteDomainError("reserved domain");
  if (typeof shareId !== "string" || !sql("SELECT 1 FROM note_shares WHERE id = ? AND ws = ? AND removed_at IS NULL").get(shareId, ws)) throw new SiteDomainError("no such site");
  const mine = one(ws, domain);
  if (mine) {
    if (mine.share_id !== shareId) throw new SiteDomainError("domain in use");
    return toSite(mine);
  }
  if (sql("SELECT 1 FROM ent_site_domains WHERE share_id = ?").get(shareId)) throw new SiteDomainError("site has a domain");
  const n = sql("SELECT COUNT(*) AS n FROM ent_site_domains WHERE ws = ?").get(ws) as { n: number };
  if (Number(n.n) >= MAX_PER_WS) throw new SiteDomainError("too many domains");
  sql("INSERT INTO ent_site_domains (domain, ws, share_id, token, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(domain, ws, shareId, randomBytes(18).toString("base64url"), actor, Date.now());
  audit(actor, "site.domain.add", ws, { domain, share: shareId });
  return toSite(one(ws, domain) as Row);
}

export function removeSiteDomain(ws: string, actor: string, domain: string): boolean {
  ensureTables();
  const ok = Number(sql("DELETE FROM ent_site_domains WHERE ws = ? AND domain = ?").run(ws, domain).changes) > 0;
  if (ok) audit(actor, "site.domain.remove", ws, { domain });
  return ok;
}

export type SiteVerify = { ok: true; site: SiteDomain; via: "cname" | "txt" } | { ok: false; error: "not found" | "record missing" | "taken" | "dns" };

/** Looks the claim's CNAME (or its TXT record) up. */
export async function verifySiteDomain(ws: string, actor: string, domain: string, now = Date.now()): Promise<SiteVerify> {
  ensureTables();
  const row = one(ws, domain);
  if (!row) return { ok: false, error: "not found" };
  const fail = (error: "record missing" | "taken" | "dns"): SiteVerify => {
    sql("UPDATE ent_site_domains SET checked_at = ?, last_error = ? WHERE ws = ? AND domain = ?").run(now, error, ws, domain);
    return { ok: false, error };
  };
  let via: "cname" | "txt" | null = null;
  try {
    if ((await dns().cname(domain)).includes(claimTarget(row.token))) via = "cname";
    else if ((await dns().txt(`_zvena-site.${domain}`)).some((v) => v.trim() === `${SITE_TXT_PREFIX}${row.token}`)) via = "txt";
  } catch {
    return fail("dns");
  }
  if (!via) return fail("record missing");
  if (sql("SELECT 1 FROM ent_site_domains WHERE domain = ? AND verified_at IS NOT NULL AND ws <> ?").get(domain, ws)) return fail("taken");
  try {
    sql("UPDATE ent_site_domains SET checked_at = ?, last_error = NULL, verified_at = COALESCE(verified_at, ?) WHERE ws = ? AND domain = ?").run(now, now, ws, domain);
  } catch {
    return fail("taken");
  }
  if (!row.verified_at) audit(actor, "site.domain.verify", ws, { domain, via });
  return { ok: true, site: toSite(one(ws, domain) as Row), via };
}

/** The published page a request's Host serves (verified, live, publishing allowed), or null. */
export function shareForHost(host: string | null | undefined): string | null {
  const h = hostOnly(host);
  if (!customDomainsOn() || !h || !normalizeDomain(h)) return null;
  ensureTables();
  const row = sql(
    "SELECT d.share_id, d.ws FROM ent_site_domains d JOIN note_shares s ON s.id = d.share_id AND s.ws = d.ws AND s.removed_at IS NULL WHERE d.domain = ? AND d.verified_at IS NOT NULL"
  ).get(h) as { share_id: string; ws: string } | undefined;
  if (!row || !publishingAllowed(row.ws)) return null;
  return row.share_id;
}

/** The verified custom domain of a published page (its canonical address), if any. */
export function customDomainOf(shareId: string): string | null {
  ensureTables();
  return (sql("SELECT domain FROM ent_site_domains WHERE share_id = ? AND verified_at IS NOT NULL").get(shareId) as { domain: string } | undefined)?.domain ?? null;
}

/** The address a custom domain is reached at (https; plain http on a test stand served over http). */
export function siteOrigin(domain: string): string {
  return `${config.isTestStand && config.appUrl.startsWith("http://") ? "http" : "https"}://${domain}`;
}

/** Whether a published page may be served: its workspace has not turned publishing off (Settings → Security). */
export function shareServable(shareId: string): boolean {
  const row = sql("SELECT ws FROM note_shares WHERE id = ?").get(shareId) as { ws: string } | undefined;
  return !row || publishingAllowed(row.ws);
}

/** The same for a public form link. */
export function formServable(formId: string): boolean {
  const row = sql("SELECT ws FROM note_forms WHERE id = ?").get(formId) as { ws: string } | undefined;
  return !row || publishingAllowed(row.ws);
}
