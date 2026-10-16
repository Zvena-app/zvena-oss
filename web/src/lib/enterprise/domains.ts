// Server-only: a workspace's verified domains (Notion's Settings → Identity
// → Verified domains). The owner adds example.com, puts the TXT record
// "zvena-verification=<token>" on it, and we check it with DNS. A verified
// domain is the workspace's alone (one workspace at a time) and unlocks:
//
//   allowed e-mail domains   people with a verified address at it may join
//                            the workspace from the sign-in page
//   SSO enforcement          its addresses sign in only through the
//                            workspace's identity provider (lib/enterprise/sso.ts)
//
// Addresses match a domain exactly (verifying example.com does not cover
// eng.example.com).

import { randomBytes } from "node:crypto";
import { config } from "../config";
import { audit, sql } from "../store";
import { dns } from "./dns";
import { hostOnly, isSameOrSub, normalizeDomain } from "./hosts";
import { ensureTables } from "./tables";

export const TXT_PREFIX = "zvena-verification=";
const MAX_DOMAINS = 50;

export interface WsDomain {
  domain: string;
  /** The TXT value to publish (shown to the owner until verified). */
  record: string;
  verifiedAt: number | null;
  checkedAt: number | null;
  allowJoin: boolean;
}

export class DomainError extends Error {}

interface Row {
  domain: string;
  token: string;
  verified_at: number | null;
  checked_at: number | null;
  allow_join: number;
}

const toDomain = (r: Row): WsDomain => ({ domain: r.domain, record: `${TXT_PREFIX}${r.token}`, verifiedAt: r.verified_at, checkedAt: r.checked_at, allowJoin: r.allow_join === 1 });

/** Domains that are zvena's own can never be claimed. */
function reserved(domain: string): boolean {
  const own = [hostOnly(safeHost(config.appUrl)), hostOnly(safeHost(config.designUrl)), sitesCnameTarget()].filter(Boolean);
  if (own.some((h) => isSameOrSub(domain, h) || isSameOrSub(h, domain))) return true;
  // Names that never resolve on the internet (a test stand uses .test ones).
  return !config.isTestStand && /\.(localhost|local|internal|test|example|invalid)$/.test(domain);
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

/** Where custom domains of sites point (CNAME): ZVENA_SITES_CNAME, default sites.zvena.app. */
export function sitesCnameTarget(): string {
  return normalizeDomain(process.env.ZVENA_SITES_CNAME || "") ?? "sites.zvena.app";
}

export function domainsOf(ws: string): WsDomain[] {
  ensureTables();
  return (sql("SELECT domain, token, verified_at, checked_at, allow_join FROM ent_domains WHERE ws = ? ORDER BY domain").all(ws) as unknown as Row[]).map(toDomain);
}

export function addDomain(ws: string, actor: string, raw: unknown): WsDomain {
  ensureTables();
  const domain = normalizeDomain(raw);
  if (!domain) throw new DomainError("invalid domain");
  if (reserved(domain)) throw new DomainError("reserved domain");
  const n = sql("SELECT COUNT(*) AS n FROM ent_domains WHERE ws = ?").get(ws) as { n: number };
  if (Number(n.n) >= MAX_DOMAINS) throw new DomainError("too many domains");
  const existing = sql("SELECT domain, token, verified_at, checked_at, allow_join FROM ent_domains WHERE ws = ? AND domain = ?").get(ws, domain) as Row | undefined;
  if (existing) return toDomain(existing);
  const token = randomBytes(24).toString("base64url");
  sql("INSERT INTO ent_domains (ws, domain, token, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(ws, domain, token, actor, Date.now());
  audit(actor, "domain.add", ws, { domain });
  return toDomain(sql("SELECT domain, token, verified_at, checked_at, allow_join FROM ent_domains WHERE ws = ? AND domain = ?").get(ws, domain) as unknown as Row);
}

export function removeDomain(ws: string, actor: string, domain: string): boolean {
  ensureTables();
  const ok = Number(sql("DELETE FROM ent_domains WHERE ws = ? AND domain = ?").run(ws, domain).changes) > 0;
  if (ok) audit(actor, "domain.remove", ws, { domain });
  return ok;
}

export type VerifyResult = { ok: true; domain: WsDomain } | { ok: false; error: "not found" | "record missing" | "taken" | "dns" };

/** Looks the TXT record up; a domain another workspace verified first stays theirs. */
export async function verifyDomain(ws: string, actor: string, domain: string, now = Date.now()): Promise<VerifyResult> {
  ensureTables();
  const row = sql("SELECT domain, token, verified_at, checked_at, allow_join FROM ent_domains WHERE ws = ? AND domain = ?").get(ws, domain) as Row | undefined;
  if (!row) return { ok: false, error: "not found" };
  let values: string[];
  try {
    values = await dns().txt(domain);
  } catch {
    return { ok: false, error: "dns" };
  }
  sql("UPDATE ent_domains SET checked_at = ? WHERE ws = ? AND domain = ?").run(now, ws, domain);
  const want = `${TXT_PREFIX}${row.token}`;
  if (!values.some((v) => v.trim() === want)) return { ok: false, error: "record missing" };
  const other = sql("SELECT ws FROM ent_domains WHERE domain = ? AND verified_at IS NOT NULL AND ws <> ?").get(domain, ws) as { ws: string } | undefined;
  if (other) return { ok: false, error: "taken" };
  if (!row.verified_at) {
    try {
      sql("UPDATE ent_domains SET verified_at = ? WHERE ws = ? AND domain = ?").run(now, ws, domain);
    } catch {
      // The unique index: another workspace verified it a moment ago.
      return { ok: false, error: "taken" };
    }
    audit(actor, "domain.verify", ws, { domain });
  }
  return { ok: true, domain: toDomain(sql("SELECT domain, token, verified_at, checked_at, allow_join FROM ent_domains WHERE ws = ? AND domain = ?").get(ws, domain) as unknown as Row) };
}

/** "Allowed e-mail domains" on or off for a verified domain. */
export function setAllowJoin(ws: string, actor: string, domain: string, on: boolean): boolean {
  ensureTables();
  const ok = Number(sql("UPDATE ent_domains SET allow_join = ? WHERE ws = ? AND domain = ? AND verified_at IS NOT NULL").run(on ? 1 : 0, ws, domain).changes) > 0;
  if (ok) audit(actor, on ? "domain.join.on" : "domain.join.off", ws, { domain });
  return ok;
}

/** The domain part of an address (lower-cased), or "". */
export function emailDomain(email: string | null | undefined): string {
  const at = String(email ?? "").lastIndexOf("@");
  return at > 0 ? String(email).slice(at + 1).trim().toLowerCase().replace(/\.+$/, "") : "";
}

/** The workspace that verified the domain of `email`, if any. */
export function workspaceOfEmailDomain(email: string | null | undefined): string | null {
  const d = emailDomain(email);
  if (!d) return null;
  ensureTables();
  const row = sql("SELECT ws FROM ent_domains WHERE domain = ? AND verified_at IS NOT NULL").get(d) as { ws: string } | undefined;
  return row?.ws ?? null;
}

/** Whether `email` is at one of the workspace's verified domains. */
export function isWorkspaceEmail(ws: string, email: string | null | undefined): boolean {
  const d = emailDomain(email);
  if (!d) return false;
  ensureTables();
  return Boolean(sql("SELECT 1 FROM ent_domains WHERE ws = ? AND domain = ? AND verified_at IS NOT NULL").get(ws, d));
}
