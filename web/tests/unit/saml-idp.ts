// A self-made SAML identity provider for the unit tests: it writes a
// Response with one Assertion and signs it (RSA-SHA256, exclusive C14N)
// with a test key from tests/fixtures/saml (idp: the configured one; evil:
// a key nobody configured).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SignedXml } from "xml-crypto";

const dir = join(process.cwd(), "tests/fixtures/saml");
export const IDP_KEY = readFileSync(join(dir, "idp.key"), "utf8");
export const IDP_CERT = readFileSync(join(dir, "idp.crt"), "utf8");
export const EVIL_KEY = readFileSync(join(dir, "evil.key"), "utf8");
export const EVIL_CERT = readFileSync(join(dir, "evil.crt"), "utf8");
export const IDP_ENTITY = "https://idp.acme.test/saml";
export const IDP_SSO = "https://idp.acme.test/sso";

export interface AssertionOpts {
  acs: string;
  audience: string;
  nameId: string;
  inResponseTo?: string | null;
  issuer?: string;
  email?: string;
  name?: string;
  destination?: string | null;
  notBefore?: number;
  notOnOrAfter?: number;
  issueInstant?: number;
  key?: string;
  cert?: string;
  /** Sign the whole Response instead of the Assertion. */
  signResponse?: boolean;
  unsigned?: boolean;
  assertionId?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function samlResponseXml(o: AssertionOpts): string {
  const now = Date.now();
  const issuer = o.issuer ?? IDP_ENTITY;
  const irt = o.inResponseTo ? ` InResponseTo="${esc(o.inResponseTo)}"` : "";
  const dest = o.destination === null ? "" : ` Destination="${esc(o.destination ?? o.acs)}"`;
  const aid = o.assertionId ?? `_a${randomBytes(12).toString("hex")}`;
  const nb = iso(o.notBefore ?? now - 30_000);
  const noa = iso(o.notOnOrAfter ?? now + 5 * 60_000);
  const attrs = [
    o.email ? `<saml:Attribute Name="email"><saml:AttributeValue>${esc(o.email)}</saml:AttributeValue></saml:Attribute>` : "",
    o.name ? `<saml:Attribute Name="displayName"><saml:AttributeValue>${esc(o.name)}</saml:AttributeValue></saml:Attribute>` : "",
  ].join("");
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${iso(o.issueInstant ?? now)}">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(o.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${noa}" Recipient="${esc(o.acs)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : "") +
    `</saml:Assertion>`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${iso(now)}"${dest}${irt}>` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  if (o.unsigned) return xml;
  const sig = new SignedXml({
    privateKey: o.key ?? IDP_KEY,
    publicCert: o.cert ?? IDP_CERT,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  const target = o.signResponse ? "/*[local-name(.)='Response']" : "//*[local-name(.)='Assertion']";
  sig.addReference({ xpath: target, digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  sig.computeSignature(xml, { location: { reference: `${target}/*[local-name(.)='Issuer']`, action: "after" } });
  return sig.getSignedXml();
}

export const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");

/** IdP metadata as Okta / Entra publish it. */
export function idpMetadata(cert = IDP_CERT): string {
  const body = cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP_ENTITY}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP_SSO}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_SSO}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}
