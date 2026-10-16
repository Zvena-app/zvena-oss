// Minimal OpenID Connect provider: Design (the Penpot fork) signs people in
// with their zvena account.
//
// Authorization-code flow, confidential client (client_secret_post or
// client_secret_basic), userinfo endpoint; no id_token (Penpot reads claims
// from /userinfo). Codes are one-time and live 2 minutes; access tokens are
// HMAC-signed and live 10 minutes (used once, right after the exchange).
// Design learns only a technical login (u-<id>@users.zvena.invalid), the display
// name, the id and the interface language (`locale`, from the zv_lang cookie
// at /authorize) — not the person's real e-mail or provider identities.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { getUser, mac, safeEqual, type AuthUser } from "./auth";
import { config } from "./config";
import { designLogin } from "./penpot";
import { sql, sweepExpired } from "./store";
import { isLocale, type Locale } from "@/i18n/locales";

export interface OidcClient {
  id: string;
  secret: string;
  redirectUris: string[];
}

const CODE_TTL = 2 * 60 * 1000;
const TOKEN_TTL = 10 * 60 * 1000;

/** The Design client: DESIGN_OIDC_CLIENT_ID / _SECRET (32+ chars) / _REDIRECT_URIS (space-separated). */
export function designClient(): OidcClient | null {
  const id = (process.env.DESIGN_OIDC_CLIENT_ID || "").trim();
  const secret = (process.env.DESIGN_OIDC_CLIENT_SECRET || "").trim();
  const uris = (process.env.DESIGN_OIDC_REDIRECT_URIS || `${config.designUrl}/api/auth/oidc/callback`).split(/\s+/).filter(Boolean);
  if (!id || secret.length < 32) return null;
  return { id, secret, redirectUris: uris };
}

export function findClient(id: string | null | undefined): OidcClient | null {
  const c = designClient();
  return c && id && c.id === id ? c : null;
}

export function clientSecretOk(client: OidcClient, secret: string): boolean {
  // Compare digests so the secret's length does not leak through timing.
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  return safeEqual(h(client.secret), h(secret));
}

export function issueCode(userId: string, client: OidcClient, redirectUri: string, nonce: string | null, locale: Locale | null = null): string {
  sweepExpired();
  const code = randomBytes(32).toString("base64url");
  sql("INSERT INTO oidc_codes (code, user_id, client_id, redirect_uri, nonce, exp, locale) VALUES (?, ?, ?, ?, ?, ?, ?)").run(mac("oidc-code", code), userId, client.id, redirectUri, nonce, Date.now() + CODE_TTL, isLocale(locale) ? locale : null);
  return code;
}

/** One-time: the row is deleted whether or not the checks pass. */
export function consumeCode(code: string, client: OidcClient, redirectUri: string): { userId: string; locale: Locale | null } | null {
  const h = mac("oidc-code", code);
  const row = sql("SELECT user_id, client_id, redirect_uri, exp, locale FROM oidc_codes WHERE code = ?").get(h) as { user_id: string; client_id: string; redirect_uri: string; exp: number; locale: string | null } | undefined;
  sql("DELETE FROM oidc_codes WHERE code = ?").run(h);
  if (!row || row.exp < Date.now() || row.client_id !== client.id || row.redirect_uri !== redirectUri) return null;
  return { userId: row.user_id, locale: isLocale(row.locale) ? row.locale : null };
}

function key(): string {
  const s = process.env.AUTH_SECRET || "";
  if (s.length < 32) throw new Error("oidc misconfigured: AUTH_SECRET missing");
  return s;
}

export function issueAccessToken(userId: string, client: OidcClient, locale: Locale | null = null): string {
  const body = Buffer.from(JSON.stringify({ u: userId, c: client.id, x: Date.now() + TOKEN_TTL, ...(locale ? { l: locale } : {}) })).toString("base64url");
  const sig = createHmac("sha256", key()).update(`oidc-at:${body}`).digest("base64url");
  return `${body}.${sig}`;
}

export function readAccessToken(token: string): { userId: string; locale: Locale | null } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", key()).update(`oidc-at:${body}`).digest("base64url");
  if (!safeEqual(sig, want)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: string; c?: string; x?: number; l?: unknown };
    if (!v.u || !v.c || typeof v.x !== "number" || v.x < Date.now() || !findClient(v.c)) return null;
    return { userId: v.u, locale: isLocale(v.l) ? v.l : null };
  } catch {
    return null;
  }
}

export function userClaims(user: AuthUser, locale: Locale | null = null): Record<string, unknown> {
  const login = designLogin(user.id);
  return {
    sub: user.id,
    email: login,
    email_verified: true,
    name: user.name.slice(0, 250),
    preferred_username: login.split("@")[0],
    // The person's chosen interface language, when they chose one (OIDC "locale", a BCP 47 tag).
    ...(locale ? { locale } : {}),
  };
}

export { getUser };
