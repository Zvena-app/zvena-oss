// Server-only: Google One Tap. The browser gets an ID token (a JWT signed by
// Google) from Google's script and posts it here; unlike the OAuth code flow
// (oauth.ts) the token passed through the browser, so its RS256 signature is
// checked against Google's published keys, as are the issuer, the audience
// (our client id), the expiry and a one-time nonce bound to this browser by
// an HttpOnly cookie (no replay of a token issued for another visit).

import { createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { cookieSecure } from "./auth";
import type { ProviderProfile } from "./auth";
import { config } from "./config";
import { googleProfile } from "./oauth";

export const ONETAP_NONCE_COOKIE = "zv_otn";
const NONCE_TTL_SEC = 600;
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";

interface GoogleJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

let cache: { keys: GoogleJwk[]; until: number } | null = null;

/** Google's current signing keys, cached for as long as Google says (Cache-Control max-age). */
async function googleKeys(): Promise<GoogleJwk[]> {
  if (cache && cache.until > Date.now()) return cache.keys;
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`google certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: GoogleJwk[] };
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  cache = { keys: Array.isArray(body.keys) ? body.keys : [], until: Date.now() + Math.min(Math.max(maxAge, 60), 86_400) * 1000 };
  return cache.keys;
}

/** A fresh nonce and the cookie that binds it to this browser. */
export function issueNonce(): { nonce: string; cookie: string } {
  const nonce = randomBytes(24).toString("base64url");
  return { nonce, cookie: `${ONETAP_NONCE_COOKIE}=${nonce}; Path=/api/auth/google; HttpOnly; SameSite=Lax${cookieSecure() ? "; Secure" : ""}; Max-Age=${NONCE_TTL_SEC}` };
}

export function clearNonceCookie(): string {
  return `${ONETAP_NONCE_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax${cookieSecure() ? "; Secure" : ""}; Max-Age=0`;
}

/**
 * Verifies a One Tap credential. `keys` may be passed (tests); otherwise
 * Google's are fetched. Returns the profile, or null for any failure.
 */
export async function verifyOneTap(credential: string, nonce: string | null, opts: { clientId?: string; keys?: GoogleJwk[]; now?: number } = {}): Promise<ProviderProfile | null> {
  const clientId = opts.clientId ?? config.google.clientId;
  if (!clientId || !nonce || typeof credential !== "string" || credential.length > 4096) return null;
  const parts = credential.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  let keys: GoogleJwk[];
  try {
    keys = opts.keys ?? (await googleKeys());
  } catch {
    return null;
  }
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return null;
  let ok = false;
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
    ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) return null;
  if (claims.nonce !== nonce) return null;
  const now = opts.now ?? Date.now();
  const iat = Number(claims.iat);
  if (Number.isFinite(iat) && iat * 1000 > now + 5 * 60_000) return null;
  return googleProfile(claims, clientId, now);
}
