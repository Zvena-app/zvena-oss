// Server-only: "Enforce SAML SSO" (Notion) at every way in. When a
// workspace has verified a domain and enforces its single sign-on, the
// addresses at that domain sign in only through the workspace's identity
// provider: Google, GitHub, the e-mail link or code and the test sign-in
// refuse them (lib/auth.ts signInWith asks here), and the e-mail sign-in
// sends them to SSO instead of sending a letter. Break-glass: the
// workspace's owners keep every other way in, so a broken identity provider
// never locks the workspace out.
//
// Kept apart from sso.ts so lib/auth.ts can import it without a cycle.

import { sql } from "../store";
import { workspaceOfEmailDomain } from "./domains";
import { ensureTables } from "./tables";

/** The workspace that enforces SSO for `email`, or null. */
export function enforcingWorkspace(email: string | null | undefined): string | null {
  const ws = workspaceOfEmailDomain(email);
  if (!ws) return null;
  ensureTables();
  const row = sql("SELECT 1 FROM ent_sso WHERE ws = ? AND enabled = 1 AND enforced = 1").get(ws);
  return row ? ws : null;
}

function isOwner(userId: string, ws: string): boolean {
  return Boolean(sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ? AND role = 'owner'").get(ws, userId));
}

/**
 * Whether a sign-in with `provider` must go through SSO instead: the
 * address the provider vouches for and the account's own address are both
 * looked at (a sign-in without an e-mail, linked to a company account, is still that
 * account). Returns the enforcing workspace, or null to let it through.
 */
export function ssoRequired(provider: string, userId: string | null, emails: (string | null | undefined)[]): string | null {
  if (provider === "sso") return null;
  const own = userId ? (sql("SELECT email FROM users WHERE id = ?").get(userId) as { email: string | null } | undefined)?.email : null;
  for (const e of [...emails, own]) {
    const ws = enforcingWorkspace(e);
    if (ws && !(userId && isOwner(userId, ws))) return ws;
  }
  return null;
}

/**
 * Before an e-mail sign-in letter goes out: the SSO start URL when the
 * address must sign in through SSO (an owner's account gets the letter).
 */
export function ssoStartForEmail(email: string | null, next: string): string | null {
  if (!email) return null;
  const ws = enforcingWorkspace(email);
  if (!ws) return null;
  const account = sql("SELECT id FROM users WHERE email = ? COLLATE NOCASE ORDER BY created_at LIMIT 1").get(email) as { id: string } | undefined;
  if (account && isOwner(account.id, ws)) return null;
  return `/api/sso/start?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;
}
