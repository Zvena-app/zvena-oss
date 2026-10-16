// The Connect flow's one-time values (RFC 7636 PKCE): `state` ties the code
// that comes back to the flow this extension started; the `verifier` never
// leaves the extension until the code is exchanged, so a code read off the
// page by anyone else is useless.

const STATE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export const STATE_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** `length` characters of `alphabet`, uniformly (rejection sampling: no modulo bias). */
export function randomString(length, alphabet) {
  const out = [];
  const limit = 256 - (256 % alphabet.length);
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit) out.push(alphabet[b % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

export const makeState = () => randomString(32, STATE_ALPHABET);
export const makeVerifier = () => randomString(64, VERIFIER_ALPHABET);

export function base64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** S256: base64url(SHA-256(verifier)), no padding. */
export async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}
