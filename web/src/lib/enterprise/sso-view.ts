// Server-only: what Settings → Identity shows of a workspace's SSO. The
// client secret never leaves the server; certificates show as their subject
// and expiry.

import { oidcRedirectUri } from "./oidc";
import { acsUrl, certInfo, spEntityId, type CertInfo } from "./saml";
import type { JitRole, SsoConfig, SsoKind } from "./sso";

export interface SsoView {
  kind: SsoKind;
  enabled: boolean;
  enforced: boolean;
  jit: boolean;
  jitRole: JitRole;
  updatedAt: number;
  saml?: { idpEntityId: string; ssoUrl: string; binding: "redirect" | "post"; allowIdpInitiated: boolean; certs: CertInfo[] };
  oidc?: { issuer: string; clientId: string; hasSecret: boolean };
}

export interface SpInfo {
  entityId: string;
  acsUrl: string;
  metadataUrl: string;
  oidcRedirectUri: string;
}

export function ssoView(c: SsoConfig | null): SsoView | null {
  if (!c) return null;
  return {
    kind: c.kind,
    enabled: c.enabled,
    enforced: c.enforced,
    jit: c.jit,
    jitRole: c.jitRole,
    updatedAt: c.updatedAt,
    ...(c.saml
      ? {
          saml: {
            idpEntityId: c.saml.idpEntityId,
            ssoUrl: c.saml.ssoUrl,
            binding: c.saml.binding,
            allowIdpInitiated: c.saml.allowIdpInitiated,
            certs: c.saml.certs.map((x) => certInfo(x)).filter((x): x is CertInfo => x !== null),
          },
        }
      : {}),
    ...(c.oidc ? { oidc: { issuer: c.oidc.issuer, clientId: c.oidc.clientId, hasSecret: Boolean(c.oidc.secret) } } : {}),
  };
}

export const spInfo = (ws: string): SpInfo => ({ entityId: spEntityId(ws), acsUrl: acsUrl(ws), metadataUrl: spEntityId(ws), oidcRedirectUri: oidcRedirectUri(ws) });
