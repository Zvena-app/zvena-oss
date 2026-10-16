// Server-only: OpenID Connect as a workspace's identity provider (Okta,
// Microsoft Entra ID, Google Workspace…), through openid-client: discovery
// (the issuer must match), the authorization code flow with PKCE (S256),
// state and nonce, client_secret_basic, and the ID token checked in full —
// issuer, audience, expiry, nonce and its signature against the provider's
// published keys. Every request goes through net.ts's guarded fetch.

import * as oc from "openid-client";
import { config } from "../config";
import { idpFetch } from "./net";
import { seal, unseal } from "./seal";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  /** The client secret, sealed (seal.ts) for this workspace. */
  secret: string;
}

export class OidcConfigError extends Error {}
export class OidcError extends Error {}

export const oidcRedirectUri = (ws: string) => `${config.appUrl}/api/sso/oidc/${ws}/callback`;

function issuerUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.protocol !== "https:" && !(u.protocol === "http:" && config.isTestStand)) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Settings from the form; an empty secret keeps the one stored (`prev`). */
export function cleanOidcSettings(ws: string, v: unknown, prev: OidcSettings | null): OidcSettings {
  const r = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const issuer = issuerUrl(r.issuer);
  if (!issuer) throw new OidcConfigError("issuer");
  const clientId = typeof r.clientId === "string" ? r.clientId.trim() : "";
  if (!clientId || clientId.length > 300 || /\s/.test(clientId)) throw new OidcConfigError("client id");
  const secret = typeof r.clientSecret === "string" ? r.clientSecret.trim() : "";
  if (secret.length > 1000) throw new OidcConfigError("client secret");
  if (!secret && !prev?.secret) throw new OidcConfigError("client secret");
  return { issuer, clientId, secret: secret ? seal(secret, `oidc:${ws}`) : (prev as OidcSettings).secret };
}

const cache = new Map<string, { at: number; config: oc.Configuration }>();

async function configFor(ws: string, s: OidcSettings): Promise<oc.Configuration> {
  const secret = unseal(s.secret, `oidc:${ws}`);
  if (!secret) throw new OidcError("secret");
  const key = `${ws}\n${s.issuer}\n${s.clientId}\n${s.secret}`;
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - 3600_000) return hit.config;
  let c: oc.Configuration;
  try {
    c = await oc.discovery(new URL(s.issuer), s.clientId, { client_secret: secret, redirect_uris: [oidcRedirectUri(ws)], response_types: ["code"] }, oc.ClientSecretBasic(secret), {
      [oc.customFetch]: idpFetch as unknown as oc.CustomFetch,
      timeout: 10,
      ...(s.issuer.startsWith("http:") ? { execute: [oc.allowInsecureRequests] } : {}),
    });
  } catch (e) {
    throw new OidcError(`discovery: ${e instanceof Error ? e.message.slice(0, 160) : "failed"}`);
  }
  // The ID token's signature too, not only its claims (it comes over TLS, but costs one key fetch).
  oc.enableNonRepudiationChecks(c);
  cache.set(key, { at: Date.now(), config: c });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return c;
}

/** Checks a configuration by fetching the provider's discovery document. */
export async function testOidc(ws: string, s: OidcSettings): Promise<void> {
  await configFor(ws, s);
}

export async function oidcRequest(ws: string, s: OidcSettings, state: string): Promise<{ url: string; verifier: string; nonce: string }> {
  const c = await configFor(ws, s);
  const verifier = oc.randomPKCECodeVerifier();
  const nonce = oc.randomNonce();
  const url = oc.buildAuthorizationUrl(c, {
    redirect_uri: oidcRedirectUri(ws),
    scope: "openid email profile",
    response_type: "code",
    state,
    nonce,
    code_challenge: await oc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return { url: url.toString(), verifier, nonce };
}

export interface OidcIdentity {
  sub: string;
  email: string | null;
  name: string;
  /** The ID token's identifier for replay protection (jti, else sub+iat+nonce). */
  tokenId: string;
  exp: number;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Whether an issuer is one Entra ID tenant (login.microsoftonline.com/<tenant id>/v2.0 or sts.windows.net/<tenant id>/). */
export function entraTenantIssuer(iss: string): boolean {
  const m = /^https:\/\/(?:login\.microsoftonline\.com|sts\.windows\.net)\/([^/]+)(?:\/v2\.0)?\/?$/.exec(iss);
  return Boolean(m && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m[1]));
}

/** Exchanges the code from the callback (its query is `params`) and reads the person from the ID token. */
export async function oidcCallback(ws: string, s: OidcSettings, params: URLSearchParams, checks: { verifier: string; nonce: string; state: string }): Promise<OidcIdentity> {
  const c = await configFor(ws, s);
  const current = new URL(oidcRedirectUri(ws));
  for (const [k, v] of params) current.searchParams.append(k, v);
  let claims: oc.IDToken | undefined;
  try {
    const tokens = await oc.authorizationCodeGrant(c, current, { pkceCodeVerifier: checks.verifier, expectedNonce: checks.nonce, expectedState: checks.state, idTokenExpected: true });
    claims = tokens.claims();
  } catch (e) {
    // The library's own words name the check that failed (its cause), not just "invalid response".
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
    throw new OidcError((cause || (e instanceof Error ? e.message : "token")).slice(0, 200));
  }
  if (!claims) throw new OidcError("no id token");
  const sub = str(claims.sub);
  if (!sub || sub.length > 255) throw new OidcError("sub");
  // An address counts only when the provider vouches for it: email_verified === true.
  // Entra ID (a specific tenant, never common/organizations/consumers) sends no
  // email_verified; there the sign-in name (upn / preferred_username) is the
  // tenant's own and stands in. Anything else (a provider where people register
  // themselves and type any address) gives no address: no account is matched.
  const entra = entraTenantIssuer(str(claims.iss));
  // In Entra the sign-in name (upn) is the tenant's own; its "email" is a profile field an admin may set to anything.
  const raw = entra ? str(claims.upn) || str(claims.preferred_username) || str(claims.email) : claims.email_verified === true ? str(claims.email) : "";
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase().slice(0, 254) : null;
  const name = (str(claims.name) || [str(claims.given_name), str(claims.family_name)].filter(Boolean).join(" ")).slice(0, 120);
  const tokenId = str(claims.jti) || `${sub}:${String(claims.iat)}:${checks.nonce}`;
  return { sub, email, name, tokenId, exp: Number(claims.exp) * 1000 || Date.now() + 3600_000 };
}
