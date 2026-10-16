// Server-only: SAML 2.0 for a workspace's single sign-on, through
// @node-saml/node-saml (signatures by xml-crypto, wrapping-safe: only the
// XML a signature covers is read). What we require of a response:
//
//   signed     the assertion, or the whole response, by one of the IdP
//              certificates the owner configured (SHA-256 or better offered)
//   ours       Audience = our SP entity id; Destination, when present, our
//              ACS URL; the assertion's Issuer = the IdP entity id
//   fresh      within NotBefore / NotOnOrAfter (1 minute of clock skew) and
//              at most 10 minutes after IssueInstant
//   once       InResponseTo = an AuthnRequest we issued for this browser
//              (ent_saml_requests, used once); unsolicited (IdP-initiated)
//              responses only when the owner allowed them; the assertion id
//              is remembered until it expires, so no assertion works twice
//
// Encrypted assertions are not accepted (no SP decryption key is published).

import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import { config } from "../config";
import { sql } from "../store";
import { ensureTables } from "./tables";

export interface SamlSettings {
  idpEntityId: string;
  ssoUrl: string;
  binding: "redirect" | "post";
  /** Base64 DER of the IdP's signing certificates. */
  certs: string[];
  /** Accept responses the IdP sends unasked (its app dashboard). */
  allowIdpInitiated: boolean;
}

export class SamlConfigError extends Error {}

const REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const DS = "http://www.w3.org/2000/09/xmldsig#";
const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const MAX_XML = 512 * 1024;

// --- Our side (the service provider) ---------------------------------------------

export const spEntityId = (ws: string) => `${config.appUrl}/api/sso/saml/${ws}/metadata`;
export const acsUrl = (ws: string) => `${config.appUrl}/api/sso/saml/${ws}/acs`;

export function spMetadata(ws: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="${MD}" entityID="${esc(spEntityId(ws))}">`,
    `  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`,
    `    <md:NameIDFormat>${EMAIL_FORMAT}</md:NameIDFormat>`,
    `    <md:AssertionConsumerService Binding="${POST}" Location="${esc(acsUrl(ws))}" index="0" isDefault="true"/>`,
    `  </md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
    ``,
  ].join("\n");
}

// --- Their side (the identity provider) --------------------------------------------

/** A certificate pasted as PEM or bare base64 → its base64 DER, if it is an X.509 certificate. */
export function normalizeCert(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 20_000) return null;
  const body = raw.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body) || body.length < 100) return null;
  try {
    const c = new X509Certificate(Buffer.from(body, "base64"));
    return c.raw.toString("base64");
  } catch {
    return null;
  }
}

export interface CertInfo {
  subject: string;
  validTo: string;
  expired: boolean;
  sha256: string;
}

export function certInfo(b64: string, now = Date.now()): CertInfo | null {
  try {
    const c = new X509Certificate(Buffer.from(b64, "base64"));
    return { subject: c.subject.replace(/\n/g, ", ").slice(0, 200), validTo: new Date(c.validTo).toISOString(), expired: Date.parse(c.validTo) < now, sha256: c.fingerprint256 };
  } catch {
    return null;
  }
}

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password) return null;
    if (u.protocol === "https:" || (u.protocol === "http:" && config.isTestStand)) return u.toString();
  } catch {
    // not a URL
  }
  return null;
}

/** The IdP's metadata XML → entity id, sign-in URL (HTTP-Redirect preferred) and signing certificates. */
export function parseIdpMetadata(xml: unknown): Omit<SamlSettings, "allowIdpInitiated"> {
  if (typeof xml !== "string" || !xml.trim() || xml.length > MAX_XML) throw new SamlConfigError("metadata");
  // No DTDs: entity tricks have no place in metadata.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SamlConfigError("metadata");
  let doc: Document;
  try {
    const errors: string[] = [];
    doc = new DOMParser({ errorHandler: { error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m), warning: () => {} } }).parseFromString(xml, "text/xml") as unknown as Document;
    if (errors.length || !doc?.documentElement) throw new Error("parse");
  } catch {
    throw new SamlConfigError("metadata");
  }
  const all = (parent: Document | Element, ns: string, name: string) => Array.from(parent.getElementsByTagNameNS(ns, name));
  const entity = doc.documentElement.localName === "EntityDescriptor" ? doc.documentElement : all(doc, MD, "EntityDescriptor")[0];
  const idp = entity ? all(entity, MD, "IDPSSODescriptor")[0] : undefined;
  if (!entity || !idp) throw new SamlConfigError("metadata");
  const entityId = (entity.getAttribute("entityID") ?? "").trim();
  const services = all(idp, MD, "SingleSignOnService");
  const pick = services.find((s) => s.getAttribute("Binding") === REDIRECT) ?? services.find((s) => s.getAttribute("Binding") === POST);
  const ssoUrl = httpsUrl(pick?.getAttribute("Location"));
  const certs = all(idp, MD, "KeyDescriptor")
    .filter((k) => !k.getAttribute("use") || k.getAttribute("use") === "signing")
    .flatMap((k) => all(k, DS, "X509Certificate").map((c) => normalizeCert(c.textContent ?? "")))
    .filter((c): c is string => Boolean(c));
  if (!entityId || entityId.length > 1000 || !ssoUrl || certs.length === 0) throw new SamlConfigError("metadata");
  return { idpEntityId: entityId, ssoUrl, binding: pick?.getAttribute("Binding") === POST ? "post" : "redirect", certs: [...new Set(certs)].slice(0, 5) };
}

/** Settings from the form (entity id, URL, certificate) or from metadata XML; throws SamlConfigError. */
export function cleanSamlSettings(v: unknown): SamlSettings {
  const r = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const base = typeof r.metadata === "string" && r.metadata.trim() ? parseIdpMetadata(r.metadata) : null;
  const entityId = base?.idpEntityId ?? (typeof r.idpEntityId === "string" ? r.idpEntityId.trim() : "");
  const ssoUrl = base?.ssoUrl ?? httpsUrl(r.ssoUrl);
  const certs = base?.certs ?? (Array.isArray(r.certs) ? r.certs : [r.cert]).map(normalizeCert).filter((c): c is string => Boolean(c));
  if (!entityId || entityId.length > 1000) throw new SamlConfigError("entity id");
  if (!ssoUrl) throw new SamlConfigError("sso url");
  if (certs.length === 0) throw new SamlConfigError("certificate");
  return { idpEntityId: entityId, ssoUrl, binding: base?.binding ?? (r.binding === "post" ? "post" : "redirect"), certs: certs.slice(0, 5), allowIdpInitiated: r.allowIdpInitiated === true };
}

// --- Requests we issued (node-saml's cache provider, in SQLite) -----------------------

const requestCache: CacheProvider = {
  async saveAsync(key, value) {
    ensureTables();
    const at = Date.parse(value) || Date.now();
    sql("INSERT INTO ent_saml_requests (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(key, at);
    return { value, createdAt: at };
  },
  async getAsync(key) {
    ensureTables();
    const r = sql("SELECT created_at FROM ent_saml_requests WHERE id = ?").get(key) as { created_at: number } | undefined;
    return r ? new Date(r.created_at).toISOString() : null;
  },
  async removeAsync(key) {
    if (!key) return null;
    ensureTables();
    const n = Number(sql("DELETE FROM ent_saml_requests WHERE id = ?").run(key).changes);
    return n ? key : null;
  },
};

const REQUEST_TTL = 10 * 60_000;

function client(ws: string, s: SamlSettings, mode: ValidateInResponseTo, requestId?: string): SAML {
  return new SAML({
    callbackUrl: acsUrl(ws),
    issuer: spEntityId(ws),
    audience: spEntityId(ws),
    entryPoint: s.ssoUrl,
    idpCert: s.certs,
    identifierFormat: EMAIL_FORMAT,
    // Entra ID and others refuse a requested password context for people who sign in otherwise.
    disableRequestedAuthnContext: true,
    // Either the response or the assertion is signed; node-saml reads only what the signature covers.
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: false,
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: 10 * 60_000,
    validateInResponseTo: mode,
    requestIdExpirationPeriodMs: REQUEST_TTL,
    cacheProvider: requestCache,
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
    authnRequestBinding: s.binding === "post" ? "HTTP-POST" : "HTTP-Redirect",
    signatureAlgorithm: "sha256",
  });
}

/** A new AuthnRequest: the IdP URL to send the browser to (redirect binding) or a form to post (POST binding). */
export async function samlRequest(ws: string, s: SamlSettings, relayState: string): Promise<{ requestId: string; url?: string; form?: string }> {
  const requestId = `_${randomBytes(20).toString("hex")}`;
  const saml = client(ws, s, ValidateInResponseTo.always, requestId);
  if (s.binding === "post") return { requestId, form: await saml.getAuthorizeFormAsync(relayState, undefined, {}) };
  return { requestId, url: await saml.getAuthorizeUrlAsync(relayState, undefined, {}) };
}

export interface SamlIdentity {
  nameId: string;
  email: string | null;
  name: string;
  inResponseTo: string | null;
}

export class SamlError extends Error {}

const ATTR_EMAIL = ["email", "mail", "Email", "emailAddress", "urn:oid:0.9.2342.19200300.100.1.3", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "http://schemas.xmlsoap.org/claims/EmailAddress"];
const ATTR_NAME = ["displayName", "name", "http://schemas.microsoft.com/identity/claims/displayname", "urn:oid:2.16.840.1.113730.3.1.241"];
const ATTR_GIVEN = ["givenName", "firstName", "first_name", "urn:oid:2.5.4.42", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"];
const ATTR_FAMILY = ["sn", "surname", "lastName", "last_name", "urn:oid:2.5.4.4", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"];

function attr(p: Profile, names: string[]): string {
  for (const n of names) {
    const v = p[n];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim()) return s.trim().slice(0, 254);
  }
  return "";
}

function xmlDoc(xml: string): Document | null {
  try {
    return new DOMParser({ errorHandler: { error: () => {}, fatalError: () => {}, warning: () => {} } }).parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    return null;
  }
}

/**
 * Validates a SAMLResponse posted to the workspace's ACS. `requestId`: the
 * AuthnRequest this browser started (null: an unsolicited response, only
 * when the settings allow it). Throws SamlError on anything wrong.
 */
export async function validateSamlResponse(ws: string, s: SamlSettings, samlResponse: string, requestId: string | null, now = Date.now()): Promise<SamlIdentity> {
  if (typeof samlResponse !== "string" || samlResponse.length > 2 * MAX_XML || !/^[A-Za-z0-9+/=\s]+$/.test(samlResponse)) throw new SamlError("malformed");
  const xml = Buffer.from(samlResponse, "base64").toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SamlError("malformed");
  const doc = xmlDoc(xml);
  const root = doc?.documentElement;
  if (!root || root.localName !== "Response") throw new SamlError("malformed");
  const destination = root.getAttribute("Destination");
  if (destination && destination !== acsUrl(ws)) throw new SamlError("destination");
  const inResponseTo = root.getAttribute("InResponseTo") || null;
  if (requestId === null) {
    if (!s.allowIdpInitiated) throw new SamlError("unsolicited");
    // An answer to some request is not unsolicited: it needs its browser's state.
    if (inResponseTo) throw new SamlError("in-response-to");
  } else if (inResponseTo !== requestId) throw new SamlError("in-response-to");
  let profile: Profile | null;
  try {
    const saml = client(ws, s, requestId === null ? ValidateInResponseTo.never : ValidateInResponseTo.always);
    profile = (await saml.validatePostResponseAsync({ SAMLResponse: samlResponse })).profile;
  } catch (e) {
    throw new SamlError(e instanceof Error ? e.message.slice(0, 200) : "invalid");
  } finally {
    // A request id answers once, whatever the outcome.
    if (requestId) await requestCache.removeAsync(requestId);
  }
  if (!profile || !profile.nameID) throw new SamlError("no subject");
  if (profile.issuer !== s.idpEntityId) throw new SamlError("issuer");
  // Replay: the signed assertion's id, kept until the assertion would expire anyway.
  const assertion = xmlDoc(profile.getAssertionXml?.() ?? "")?.documentElement;
  const assertionId = assertion?.getAttribute("ID") ?? "";
  if (!assertionId) throw new SamlError("no assertion id");
  ensureTables();
  const key = `saml:${createHash("sha256").update(`${s.idpEntityId}\n${assertionId}`).digest("base64url")}`;
  try {
    sql("INSERT INTO ent_sso_replay (id, exp) VALUES (?, ?)").run(key, now + 15 * 60_000);
  } catch {
    throw new SamlError("replay");
  }
  const nameId = String(profile.nameID).trim().slice(0, 500);
  const fromNameId = profile.nameIDFormat === EMAIL_FORMAT || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nameId) ? nameId : "";
  const email = (attr(profile, ATTR_EMAIL) || fromNameId || "").toLowerCase() || null;
  const name = attr(profile, ATTR_NAME) || [attr(profile, ATTR_GIVEN), attr(profile, ATTR_FAMILY)].filter(Boolean).join(" ");
  return { nameId, email, name, inResponseTo };
}
