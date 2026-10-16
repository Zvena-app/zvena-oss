// Server-only: where a mailbox may be reached. A person types the IMAP and
// SMTP servers themselves, so the hosts are untrusted (SSRF): only public
// addresses, only mail ports, and the address is resolved once and connected
// to directly (the name still checks the TLS certificate), so there is no
// window for DNS rebinding between the check and the connection. On a test
// stand (ZVENA_STAND=test) loopback and private addresses, any port, plain
// connections and self-signed certificates are allowed for the local test
// server; nowhere else.

import { lookup } from "node:dns/promises";
import net from "node:net";
import { isBlockedAddress } from "../web-read";

export type Security = "tls" | "starttls" | "none";
export const SECURITIES: readonly Security[] = ["tls", "starttls", "none"];

export const IMAP_PORTS: readonly number[] = [993, 143];
// Not 25: submission ports only (25 would let anyone make zvena talk to any mail server).
export const SMTP_PORTS: readonly number[] = [465, 587, 2525];

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class MailGuardError extends Error {
  constructor(public code: "bad host" | "bad port" | "blocked address" | "unresolved" | "insecure") {
    super(code);
  }
}

/** The local test server may be used (a test stand only). */
export function testStand(): boolean {
  return process.env.ZVENA_STAND === "test";
}

/** A host name as typed, lower-cased, or null when it is not one. */
export function cleanHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 253) return null;
  if (net.isIP(h)) return h;
  return HOST_RE.test(h) ? h : null;
}

/** Shape checks without I/O: a host name, a mail port, TLS (plain only on a test stand). */
export function checkEndpoint(kind: "imap" | "smtp", host: unknown, port: unknown, security: unknown): { host: string; port: number; security: Security } {
  const h = cleanHost(host);
  if (!h) throw new MailGuardError("bad host");
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new MailGuardError("bad port");
  const test = testStand();
  if (!test && !(kind === "imap" ? IMAP_PORTS : SMTP_PORTS).includes(p)) throw new MailGuardError("bad port");
  if (typeof security !== "string" || !SECURITIES.includes(security as Security)) throw new MailGuardError("insecure");
  if (security === "none" && !test) throw new MailGuardError("insecure");
  if (!test && (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || (net.isIP(h) && isBlockedAddress(h)))) throw new MailGuardError("blocked address");
  return { host: h, port: p, security: security as Security };
}

export interface Resolved {
  /** The address to connect to. */
  address: string;
  /** The name the TLS certificate must carry (undefined for a bare IP). */
  servername?: string;
}

/** Resolves a checked host to one allowed address (connect to it, check the certificate against the name). */
export async function resolveEndpoint(host: string): Promise<Resolved> {
  const test = testStand();
  if (net.isIP(host)) {
    if (!test && isBlockedAddress(host)) throw new MailGuardError("blocked address");
    return { address: host };
  }
  let all: { address: string }[];
  try {
    all = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new MailGuardError("unresolved");
  }
  const ok = test ? all : all.filter((a) => !isBlockedAddress(a.address));
  if (!ok.length) throw new MailGuardError(all.length ? "blocked address" : "unresolved");
  return { address: ok[0].address, servername: host };
}

/** TLS options for a connection: certificates are always checked, except on a test stand. */
export function tlsOptions(servername: string | undefined): { servername?: string; rejectUnauthorized: boolean; minVersion: "TLSv1.2" } {
  return { ...(servername ? { servername } : {}), rejectUnauthorized: !testStand(), minVersion: "TLSv1.2" };
}
