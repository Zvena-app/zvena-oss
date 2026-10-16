// Server-only: the mailbox passwords (and, later, OAuth refresh tokens) at
// rest. AES-256-GCM with a key derived from AUTH_SECRET by HKDF-SHA256 under
// its own label, so the key is never the session secret itself. Each value
// is bound to its account and owner (additional data): a sealed password
// copied into another row of the table does not open. Sealed values never
// leave the server and are never logged.
//
//   v1.<base64url: iv (12) | tag (16) | ciphertext>

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const SALT = "zvena.mail.credentials";
const INFO = "aes-256-gcm v1";

let cached: { secret: string; key: Buffer } | null = null;

function key(): Buffer {
  const secret = process.env.AUTH_SECRET || "";
  if (secret.length < 32) throw new Error("mail misconfigured: AUTH_SECRET (32+ chars) missing");
  if (cached?.secret === secret) return cached.key;
  const k = Buffer.from(hkdfSync("sha256", secret, SALT, INFO, 32));
  cached = { secret, key: k };
  return k;
}

/** What a sealed value is bound to: the account and its owner. */
export interface SealContext {
  accountId: string;
  userId: string;
}

const aad = (c: SealContext) => Buffer.from(`${c.userId}\u0000${c.accountId}`);

/** Encrypts a secret (a JSON-able value) for one account. */
export function seal(value: unknown, ctx: SealContext): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(aad(ctx));
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return `${VERSION}.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
}

/** The secret back, or null when it was tampered with, belongs elsewhere, or the key changed. */
export function unseal<T = unknown>(sealed: string, ctx: SealContext): T | null {
  if (typeof sealed !== "string" || !sealed.startsWith(`${VERSION}.`)) return null;
  try {
    const raw = Buffer.from(sealed.slice(VERSION.length + 1), "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAAD(aad(ctx));
    d.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
