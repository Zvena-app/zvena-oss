// Sign-in with Google and GitHub (OAuth 2.0 authorization code + PKCE).
//
// Keys come from the settings (GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/
// SECRET); a provider without keys is simply not offered. We ask for the
// name and the e-mail only and keep the e-mail only when the provider says
// it is verified. Google One Tap (an ID token straight from the browser)
// lives in google.ts.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import type { ProviderProfile } from "./auth";
import { sql, sweepExpired } from "./store";

export type OAuthProvider = "google" | "github";

const STATE_TTL = 10 * 60 * 1000;
/** Our User-Agent toward the providers: this instance's own address, never someone else's. */
const ua = () => `zvena (+${config.appUrl})`;

export function isOAuthProvider(v: unknown): v is OAuthProvider {
  return v === "google" || v === "github";
}

export function providerEnabled(p: OAuthProvider): boolean {
  return p === "google" ? config.google.enabled : config.github.enabled;
}

export function callbackUrl(p: OAuthProvider): string {
  return `${config.appUrl}/api/auth/callback/${p}`;
}

/**
 * Only same-origin paths may be returned to after sign-in. Control characters
 * and spaces are refused outright: URL parsing drops tabs and newlines, so
 * "/\t/evil.com" would otherwise become "//evil.com" (another site). What is
 * returned is the path, query and fragment of a URL on zvena's own origin.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/home";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.length > 2000) return "/home";
  if (/[\x00-\x20\x7f]/.test(raw)) return "/home";
  try {
    const base = new URL(config.appUrl);
    const u = new URL(raw, base);
    if (u.origin !== base.origin) return "/home";
    const out = `${u.pathname}${u.search}${u.hash}`;
    return out.startsWith("//") ? "/home" : out;
  } catch {
    return "/home";
  }
}

/**
 * Login CSRF: a callback URL (code + state) captured by someone else must not
 * sign this browser in. The state is also kept in an HttpOnly cookie set when
 * the sign-in starts, scoped to the callback path, and the callback accepts a
 * state only when this browser holds the same one (as SSO does, lib/enterprise/sso.ts).
 */
export const OAUTH_COOKIE = "zv_oauth";

export function oauthBindCookie(state: string, maxAge = STATE_TTL / 1000): string {
  const secure = config.appUrl.startsWith("http://") ? "" : "; Secure";
  return `${OAUTH_COOKIE}=${state}; Path=/api/auth/callback; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

export const clearOAuthBindCookie = () => oauthBindCookie("", 0);

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The provider's authorization URL and the cookie that binds it to this
 * browser; the state row remembers PKCE, the Terms version shown and the
 * return path.
 */
export function startOAuth(p: OAuthProvider, opts: { consent: string | null; next: string; guest: string | null }): { url: string; cookie: string } {
  const state = randomBytes(24).toString("base64url");
  return { url: authorizeUrl(p, state, opts), cookie: oauthBindCookie(state) };
}

function authorizeUrl(p: OAuthProvider, state: string, opts: { consent: string | null; next: string; guest: string | null }): string {
  const verifier = randomBytes(48).toString("base64url");
  sweepExpired();
  sql("INSERT INTO oauth_state (state, provider, verifier, consent, next, guest, exp) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    state,
    p,
    verifier,
    opts.consent,
    safeNext(opts.next),
    opts.guest,
    Date.now() + STATE_TTL
  );
  if (p === "google") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: config.google.clientId,
      redirect_uri: callbackUrl("google"),
      scope: "openid email profile",
      state,
      code_challenge: challenge(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return u.toString();
  }
  const u = new URL("https://github.com/login/oauth/authorize");
  u.search = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: callbackUrl("github"),
    scope: "read:user user:email",
    state,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    allow_signup: "true",
  }).toString();
  return u.toString();
}

export interface ConsumedState {
  provider: OAuthProvider;
  verifier: string;
  consent: string | null;
  next: string;
  guest: string | null;
}

/**
 * One-time: the state is deleted whether or not it is valid. `bound` is the
 * state this browser's cookie holds (OAUTH_COOKIE); a state from another
 * browser is refused.
 */
export function consumeState(state: string | null, provider: OAuthProvider, bound: string | null): ConsumedState | null {
  if (!state || !/^[A-Za-z0-9_-]{20,64}$/.test(state)) return null;
  if (!bound || !sameState(state, bound)) {
    // Spent all the same: a captured callback URL cannot be retried in its own browser either.
    sql("DELETE FROM oauth_state WHERE state = ?").run(state);
    return null;
  }
  const row = sql("SELECT provider, verifier, consent, next, guest, exp FROM oauth_state WHERE state = ?").get(state) as
    | { provider: string; verifier: string; consent: string | null; next: string | null; guest: string | null; exp: number }
    | undefined;
  sql("DELETE FROM oauth_state WHERE state = ?").run(state);
  if (!row || row.exp < Date.now() || row.provider !== provider) return null;
  return { provider, verifier: row.verifier, consent: row.consent, next: safeNext(row.next), guest: row.guest };
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": ua() },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function getJson(url: string, token: string): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": ua() },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The claims of a JWT (no signature check: only for tokens received straight from the issuer over TLS). */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Google's ID token claims → a profile, after the checks every Google ID token needs. */
export function googleProfile(claims: Record<string, unknown> | null, clientId: string, now = Date.now()): ProviderProfile | null {
  if (!claims) return null;
  const iss = str(claims.iss);
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") return null;
  const aud = claims.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) return null;
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 < now - 60_000) return null;
  const subject = str(claims.sub);
  if (!/^[0-9A-Za-z_-]{1,255}$/.test(subject)) return null;
  const email = str(claims.email);
  const verified = claims.email_verified === true || claims.email_verified === "true";
  return { provider: "google", subject, name: str(claims.name) || [str(claims.given_name), str(claims.family_name)].filter(Boolean).join(" "), ...(email ? { email, emailVerified: verified } : {}) };
}

/** GitHub's user + e-mails → a profile (the primary verified e-mail, else any verified one). */
export function githubProfile(user: unknown, emails: unknown): ProviderProfile | null {
  const u = user && typeof user === "object" ? (user as Record<string, unknown>) : null;
  const subject = str(u?.id);
  if (!/^\d{1,20}$/.test(subject)) return null;
  const list = Array.isArray(emails) ? (emails as Record<string, unknown>[]) : [];
  const verified = list.filter((e) => e && e.verified === true && typeof e.email === "string" && !/@users\.noreply\.github\.com$/i.test(String(e.email)));
  const pick = verified.find((e) => e.primary === true) ?? verified[0];
  const email = pick ? str(pick.email) : "";
  return { provider: "github", subject, name: str(u?.name) || str(u?.login), ...(email ? { email, emailVerified: true } : {}) };
}

/** Exchanges the code and reads the person's profile. */
export async function exchange(p: OAuthProvider, params: URLSearchParams, st: ConsumedState): Promise<ProviderProfile | null> {
  const code = params.get("code");
  if (!code) return null;
  if (p === "google") {
    const tok = await postForm("https://oauth2.googleapis.com/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: st.verifier,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: callbackUrl("google"),
    });
    // The ID token comes straight from Google's token endpoint over TLS:
    // its claims are checked, the signature need not be (OIDC Core 3.1.3.7).
    return googleProfile(jwtClaims(str(tok?.id_token)), config.google.clientId);
  }
  const tok = await postForm("https://github.com/login/oauth/access_token", {
    client_id: config.github.clientId,
    client_secret: config.github.clientSecret,
    code,
    code_verifier: st.verifier,
    redirect_uri: callbackUrl("github"),
  });
  const accessToken = str(tok?.access_token);
  if (!accessToken) return null;
  const [user, emails] = await Promise.all([getJson("https://api.github.com/user", accessToken), getJson("https://api.github.com/user/emails", accessToken)]);
  return githubProfile(user, emails);
}
