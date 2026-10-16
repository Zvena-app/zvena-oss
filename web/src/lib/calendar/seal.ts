// Server-only: secrets Calendar keeps at rest — CalDAV app passwords and the
// tokens of secret ICS feeds — sealed with AES-256-GCM under a key derived
// from AUTH_SECRET (HKDF, its own label), so a copy of the database alone
// opens nothing. Rotating AUTH_SECRET makes them unreadable: people connect
// their accounts again and get new feed addresses.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

let cached: { secret: string; key: Buffer } | null = null;

function key(): Buffer {
  const s = process.env.AUTH_SECRET || "";
  if (s.length < 32) throw new Error("calendar misconfigured: AUTH_SECRET (32+ chars) missing");
  if (cached?.secret !== s) cached = { secret: s, key: Buffer.from(hkdfSync("sha256", s, "zvena-calendar", "calendar secrets at rest v1", 32)) };
  return cached.key;
}

/** "v1." + base64url(iv | tag | ciphertext). `aad` binds it to its row (a sealed value moved to another row does not open). */
export function seal(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
}

/** The plain text, or null when it was not sealed here (another key, another row, tampered). */
export function open(sealed: string | null | undefined, aad: string): string | null {
  if (!sealed || !sealed.startsWith("v1.")) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A lookup handle for a token (the database keeps this, never the token in the clear). */
export function tokenHash(purpose: string, token: string): string {
  return createHmac("sha256", key()).update(`${purpose}:${token}`).digest("base64url");
}

export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
