"use client";

// Settings → Identity (Notion's Identity tab): verified domains and allowed
// e-mail domains, single sign-on (SAML 2.0 or OpenID Connect) and SCIM
// provisioning. Everything is checked again on the server
// (app/api/ws/domains, sso, scim).

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, KeyRound, Plus, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { intlTag } from "@/i18n/locales";
import type { WsDomain } from "@/lib/enterprise/domains";
import type { ScimToken } from "@/lib/enterprise/scim";
import type { SpInfo, SsoView } from "@/lib/enterprise/sso-view";
import { api, CopyValue, Row, Section, Switch } from "./parts";

type Role = "editor" | "commenter" | "viewer";

export function domainError(code: string | undefined, t: ReturnType<typeof useI18n>["t"]): string {
  if (code === "record missing") return t("settings.domains.errRecord");
  if (code === "taken") return t("settings.domains.errTaken");
  if (code === "dns") return t("settings.domains.errDns");
  if (code === "invalid domain") return t("settings.domains.errInvalid");
  if (code === "reserved domain") return t("settings.domains.errReserved");
  return t("common.error");
}

function Domains({ ws, initial, onChange }: { ws: string; initial: WsDomain[]; onChange: (list: WsDomain[]) => void }) {
  const { t } = useI18n();
  const [list, setList] = useState(initial);
  useEffect(() => onChange(list), [list, onChange]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const q = `/api/ws/domains?ws=${encodeURIComponent(ws)}`;
  const upsert = (d: WsDomain) => setList((l) => [...l.filter((x) => x.domain !== d.domain), d].sort((a, b) => a.domain.localeCompare(b.domain)));
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(true);
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("settings.domains.title")} hint={t("settings.domains.hint")}>
      <form
        className="zst-inline"
        style={{ padding: "14px 0" }}
        onSubmit={(e) => {
          e.preventDefault();
          void run("_new", async () => {
            const r = await api<{ domain: WsDomain }>("POST", q, { op: "add", domain: name });
            if (r.ok) {
              upsert(r.data.domain);
              setName("");
            } else setErrors((x) => ({ ...x, _new: domainError(r.data.error, t) }));
          });
        }}
      >
        <input className="zst-input" placeholder={t("settings.domains.placeholder")} aria-label={t("settings.domains.add")} value={name} maxLength={253} onChange={(e) => setName(e.target.value)} data-test="domain-input" />
        <button type="submit" className="zst-btn" disabled={busy || !name.trim()}>
          <Plus />
          {t("settings.domains.add")}
        </button>
      </form>
      {errors._new && <p className="zst-error" role="alert">{errors._new}</p>}
      {list.length === 0 && <p className="zst-muted">{t("settings.domains.empty")}</p>}
      {list.map((d) => (
        <div key={d.domain} className="zst-item" data-domain={d.domain}>
          <div className="zst-item-head">
            <span className="zst-item-name">
              {d.domain}
              {d.verifiedAt ? <span className="zst-badge zst-badge-ok">{t("settings.domains.verified")}</span> : <span className="zst-badge zst-badge-warn">{t("settings.domains.pending")}</span>}
            </span>
            <span className="zst-inline">
              {!d.verifiedAt && (
                <button
                  type="button"
                  className="zst-btn zst-btn-sm zst-btn-primary"
                  disabled={busy}
                  data-test="domain-verify"
                  onClick={() =>
                    void run(d.domain, async () => {
                      const r = await api<{ domain: WsDomain }>("POST", q, { op: "verify", domain: d.domain });
                      if (r.ok) upsert(r.data.domain);
                      else setErrors((x) => ({ ...x, [d.domain]: domainError(r.data.error, t) }));
                    })
                  }
                >
                  {t("settings.domains.verify")}
                </button>
              )}
              <button
                type="button"
                className="zst-btn zst-btn-sm zst-btn-danger"
                disabled={busy}
                onClick={() =>
                  void run(d.domain, async () => {
                    const r = await api("POST", q, { op: "remove", domain: d.domain });
                    if (r.ok) setList((l) => l.filter((x) => x.domain !== d.domain));
                  })
                }
              >
                <Trash2 />
                {t("settings.domains.remove")}
              </button>
            </span>
          </div>
          {!d.verifiedAt && (
            <>
              <span className="zst-muted">{t("settings.domains.record", { domain: d.domain })}</span>
              <CopyValue value={d.record} />
            </>
          )}
          {errors[d.domain] && <p className="zst-error" role="alert">{errors[d.domain]}</p>}
          {d.verifiedAt && (
            <Row title={t("settings.domains.allowJoin")} hint={t("settings.domains.allowJoinHint")}>
              <Switch
                on={d.allowJoin}
                label={t("settings.domains.allowJoin")}
                disabled={busy}
                testId="domain-join"
                onChange={(on) =>
                  void run(d.domain, async () => {
                    const r = await api("POST", q, { op: "join", domain: d.domain, on });
                    if (r.ok) upsert({ ...d, allowJoin: on });
                  })
                }
              />
            </Row>
          )}
        </div>
      ))}
    </Section>
  );
}

function Sso({ ws, initial, sp, hasDomain }: { ws: string; initial: SsoView | null; sp: SpInfo; hasDomain: boolean }) {
  const { t, locale } = useI18n();
  const [sso, setSso] = useState(initial);
  const [kind, setKind] = useState<"saml" | "oidc">(initial?.kind ?? "saml");
  const [metadata, setMetadata] = useState("");
  const [entityId, setEntityId] = useState(initial?.saml?.idpEntityId ?? "");
  const [ssoUrl, setSsoUrl] = useState(initial?.saml?.ssoUrl ?? "");
  const [cert, setCert] = useState("");
  const [issuer, setIssuer] = useState(initial?.oidc?.issuer ?? "");
  const [clientId, setClientId] = useState(initial?.oidc?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const q = `/api/ws/sso?ws=${encodeURIComponent(ws)}`;
  const date = (iso: string) => new Date(iso).toLocaleDateString(intlTag(locale), { year: "numeric", month: "short", day: "numeric" });

  const put = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    setOk("");
    const r = await api<{ sso: SsoView }>("PUT", q, body);
    if (r.ok) {
      setSso(r.data.sso);
      setOk(t("settings.saved"));
      setMetadata("");
      setCert("");
      setSecret("");
    } else setError(t("settings.sso.err", { reason: r.data.error ?? String(r.status) }));
    setBusy(false);
    return r.ok;
  };
  const provider = () =>
    kind === "saml"
      ? metadata.trim()
        ? { metadata, allowIdpInitiated: sso?.saml?.allowIdpInitiated ?? false }
        : { idpEntityId: entityId, ssoUrl, cert, allowIdpInitiated: sso?.saml?.allowIdpInitiated ?? false }
      : { issuer, clientId, clientSecret: secret };
  const configured = Boolean(sso && sso.kind === kind);

  return (
    <Section title={t("settings.sso.title")} hint={t("settings.sso.hint")}>
      <Row title={t("settings.sso.protocol")}>
        <select className="zst-select" aria-label={t("settings.sso.protocol")} value={kind} onChange={(e) => setKind(e.target.value as "saml" | "oidc")} data-test="sso-kind">
          <option value="saml">{t("settings.sso.saml")}</option>
          <option value="oidc">{t("settings.sso.oidc")}</option>
        </select>
      </Row>
      <div className="zst-stack">
        <div className="zst-row-title">{t("settings.sso.sp")}</div>
        {kind === "saml" ? (
          <div className="zst-kv">
            <span>{t("settings.sso.entityId")}</span>
            <CopyValue value={sp.entityId} />
            <span>{t("settings.sso.acs")}</span>
            <CopyValue value={sp.acsUrl} />
            <span />
            <a className="zst-btn zst-btn-sm" style={{ justifySelf: "start" }} href={`${sp.metadataUrl}?download=1`} download>
              <Download />
              {t("settings.sso.metadata")}
            </a>
          </div>
        ) : (
          <div className="zst-kv">
            <span>{t("settings.sso.redirect")}</span>
            <CopyValue value={sp.oidcRedirectUri} />
          </div>
        )}
      </div>
      <form
        className="zst-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void put({ kind, provider: provider() });
        }}
      >
        {kind === "saml" ? (
          <>
            <label className="zst-field">
              <span className="zst-label">{t("settings.sso.idpMetadata")}</span>
              <textarea className="zst-textarea" value={metadata} onChange={(e) => setMetadata(e.target.value)} spellCheck={false} data-test="sso-metadata" />
              <span className="zst-muted">{t("settings.sso.idpMetadataHint")}</span>
            </label>
            <div>
              <input
                ref={file}
                type="file"
                accept=".xml,application/xml,text/xml"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && f.size < 512 * 1024) void f.text().then(setMetadata);
                }}
              />
              <button type="button" className="zst-btn zst-btn-sm" onClick={() => file.current?.click()}>
                <Upload />
                {t("settings.sso.upload")}
              </button>
            </div>
            <label className="zst-field">
              <span className="zst-label">{t("settings.sso.idpEntity")}</span>
              <input className="zst-input" value={entityId} onChange={(e) => setEntityId(e.target.value)} spellCheck={false} />
            </label>
            <label className="zst-field">
              <span className="zst-label">{t("settings.sso.ssoUrl")}</span>
              <input className="zst-input" type="url" value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} spellCheck={false} placeholder="https://" />
            </label>
            <label className="zst-field">
              <span className="zst-label">{t("settings.sso.cert")}</span>
              <textarea className="zst-textarea" value={cert} onChange={(e) => setCert(e.target.value)} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" />
              {(sso?.saml?.certs ?? []).map((c) => (
                <span key={c.sha256} className="zst-muted">
                  <ShieldCheck size={13} style={{ verticalAlign: "-2px", marginInlineEnd: 4 }} />
                  {t("settings.sso.certInfo", { subject: c.subject, date: date(c.validTo) })} {c.expired && <span className="zst-badge zst-badge-warn">{t("settings.sso.certExpired")}</span>}
                </span>
              ))}
            </label>
          </>
        ) : (
          <>
            <label className="zst-field">
              <span className="zst-label">{t("settings.sso.issuer")}</span>
              <input className="zst-input" type="url" value={issuer} onChange={(e) => setIssuer(e.target.value)} spellCheck={false} placeholder="https://" data-test="oidc-issuer" />
            </label>
            <label className="zst-field">
              <span className="zst-label">{t("settings.sso.clientId")}</span>
              <input className="zst-input" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} data-test="oidc-client" />
            </label>
            <label className="zst-field">
              <span className="zst-label">{t("settings.sso.clientSecret")}</span>
              <input className="zst-input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={sso?.oidc?.hasSecret ? t("settings.sso.secretKept") : ""} data-test="oidc-secret" />
            </label>
          </>
        )}
        <div className="zst-inline">
          <button type="submit" className="zst-btn zst-btn-primary" disabled={busy} data-test="sso-save">
            <KeyRound />
            {t("settings.sso.save")}
          </button>
          {configured && kind === "oidc" && (
            <button
              type="button"
              className="zst-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setOk("");
                const r = await api("POST", q, { op: "test" });
                if (r.ok) setOk(t("settings.sso.testOk"));
                else setError(t("settings.sso.err", { reason: r.data.error ?? String(r.status) }));
                setBusy(false);
              }}
            >
              {t("settings.sso.test")}
            </button>
          )}
        </div>
        {error && <p className="zst-error" role="alert">{error}</p>}
        {ok && <p className="zst-ok" role="status">{ok}</p>}
      </form>
      {configured && sso && (
        <>
          <Row title={t("settings.sso.enabled")} hint={t("settings.sso.enabledHint")}>
            <Switch on={sso.enabled} label={t("settings.sso.enabled")} disabled={busy} testId="sso-enabled" onChange={(v) => void put({ kind, enabled: v })} />
          </Row>
          <Row title={t("settings.sso.enforced")} hint={hasDomain ? t("settings.sso.enforcedHint") : t("settings.sso.needDomain")}>
            <Switch on={sso.enforced} label={t("settings.sso.enforced")} disabled={busy || !sso.enabled || !hasDomain} testId="sso-enforced" onChange={(v) => void put({ kind, enforced: v })} />
          </Row>
          <Row title={t("settings.sso.jit")} hint={t("settings.sso.jitHint")}>
            <select className="zst-select" aria-label={t("settings.sso.jitRole")} value={sso.jitRole} disabled={busy || !sso.jit} onChange={(e) => void put({ kind, jitRole: e.target.value as Role })}>
              {(["editor", "commenter", "viewer"] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`ws.role.${r}`)}
                </option>
              ))}
            </select>
            <Switch on={sso.jit} label={t("settings.sso.jit")} disabled={busy} onChange={(v) => void put({ kind, jit: v })} />
          </Row>
          {kind === "saml" && sso.saml && (
            <Row title={t("settings.sso.idpInitiated")} hint={t("settings.sso.idpInitiatedHint")}>
              <Switch
                on={sso.saml.allowIdpInitiated}
                label={t("settings.sso.idpInitiated")}
                disabled={busy}
                onChange={(v) => void put({ kind, allowIdpInitiated: v })}
              />
            </Row>
          )}
          <div style={{ paddingTop: 14 }}>
            <button
              type="button"
              className="zst-btn zst-btn-danger"
              disabled={busy}
              onClick={async () => {
                if (!confirm(t("settings.sso.removeConfirm"))) return;
                const r = await api("DELETE", q);
                if (r.ok) setSso(null);
              }}
            >
              <Trash2 />
              {t("settings.sso.remove")}
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

function Scim({ ws, base, initial }: { ws: string; base: string; initial: ScimToken[] }) {
  const { t, locale } = useI18n();
  const [tokens, setTokens] = useState(initial);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = `/api/ws/scim?ws=${encodeURIComponent(ws)}`;
  const date = (ms: number) => new Date(ms).toLocaleString(intlTag(locale), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <Section title={t("settings.scim.title")} hint={t("settings.scim.hint")}>
      <div className="zst-stack">
        <div className="zst-kv">
          <span>{t("settings.scim.base")}</span>
          <CopyValue value={base} />
        </div>
        <span className="zst-muted">{t("settings.scim.domainsNote")}</span>
      </div>
      <form
        className="zst-inline"
        style={{ padding: "14px 0" }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await api<{ token: string; info: ScimToken }>("POST", q, { name: name.trim() || "SCIM" });
          if (r.ok) {
            setFresh(r.data.token);
            setTokens((l) => [r.data.info, ...l]);
            setName("");
          }
          setBusy(false);
        }}
      >
        <input className="zst-input" placeholder={t("settings.scim.tokenName")} aria-label={t("settings.scim.tokenName")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="zst-btn" disabled={busy} data-test="scim-new">
          <Plus />
          {t("settings.scim.newToken")}
        </button>
      </form>
      {fresh && (
        <div className="zst-stack">
          <p className="zst-note zst-note-warn" style={{ margin: 0 }}>
            {t("settings.scim.tokenOnce")}
          </p>
          <div data-test="scim-token">
            <CopyValue value={fresh} />
          </div>
        </div>
      )}
      {tokens.length === 0 && <p className="zst-muted">{t("settings.scim.empty")}</p>}
      {tokens.map((tk) => (
        <Row key={tk.id} title={tk.name} hint={tk.lastUsedAt ? t("settings.scim.lastUsed", { date: date(tk.lastUsedAt) }) : t("settings.scim.never")}>
          <button
            type="button"
            className="zst-btn zst-btn-sm zst-btn-danger"
            disabled={busy}
            onClick={async () => {
              const r = await api("DELETE", q, { id: tk.id });
              if (r.ok) setTokens((l) => l.filter((x) => x.id !== tk.id));
            }}
          >
            {t("settings.scim.revoke")}
          </button>
        </Row>
      ))}
    </Section>
  );
}

export function IdentityPanel(props: { ws: string; domains: WsDomain[]; sso: SsoView | null; sp: SpInfo; scimBase: string; tokens: ScimToken[] }) {
  const [verified, setVerified] = useState(props.domains.some((d) => d.verifiedAt));
  const onDomains = useCallback((list: WsDomain[]) => setVerified(list.some((d) => d.verifiedAt)), []);
  return (
    <>
      <Domains ws={props.ws} initial={props.domains} onChange={onDomains} />
      <Sso ws={props.ws} initial={props.sso} sp={props.sp} hasDomain={verified} />
      <Scim ws={props.ws} base={props.scimBase} initial={props.tokens} />
    </>
  );
}
