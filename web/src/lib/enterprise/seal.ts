// Server-only: secrets kept for a workspace (an OIDC client secret) are
// sealed with AES-256-GCM under a key derived from AUTH_SECRET, so a copy
// of the database alone does not reveal them. The workspace id is bound in
// as associated data: a sealed value moved to another workspace fails.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

function key(): Buffer {
  const s = process.env.AUTH_SECRET || "";
  if (s.length < 32) throw new Error("auth misconfigured: AUTH_SECRET (32+ chars) missing");
  return Buffer.from(hkdfSync("sha256", s, "zvena-enterprise-seal", "v1", 32));
}

export function seal(plain: string, bind: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(bind));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${body.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}

export function unseal(sealed: string, bind: string): string | null {
  const [v, iv, body, tag] = String(sealed).split(".");
  if (v !== "v1" || !iv || !body || !tag) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(bind));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
