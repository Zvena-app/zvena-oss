"use client";

// Settings → Sites (Notion Sites → Custom domain): each published page of
// the workspace with the domain connected to it — the DNS records to add,
// verification, and where it is live (app/api/ws/site-domains).

import { useState } from "react";
import { ExternalLink, Globe, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import type { SiteDomain } from "@/lib/enterprise/site-domains";
import { api, CopyValue, Section } from "./parts";
import { domainError } from "./IdentityPanel";

function siteError(code: string | undefined, t: ReturnType<typeof useI18n>["t"]): string {
  if (code === "domain in use") return t("settings.sites.errInUse");
  if (code === "site has a domain") return t("settings.sites.errOneDomain");
  return domainError(code, t);
}

export function SitesPanel({ ws, sites, initial, scheme }: { ws: string; sites: { id: string; title: string }[]; initial: SiteDomain[]; scheme: "https" | "http" }) {
  const { t } = useI18n();
  const [domains, setDomains] = useState(initial);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const q = `/api/ws/site-domains?ws=${encodeURIComponent(ws)}`;
  const upsert = (d: SiteDomain) => setDomains((l) => [...l.filter((x) => x.domain !== d.domain), d]);
  const run = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(true);
    setErrors((e) => ({ ...e, [key]: "" }));
    const err = await fn();
    if (err) setErrors((e) => ({ ...e, [key]: err }));
    setBusy(false);
  };

  if (sites.length === 0) return <p className="zst-note">{t("settings.sites.empty")}</p>;
  return (
    <>
      {sites.map((s) => {
        const d = domains.find((x) => x.shareId === s.id);
        return (
          <Section key={s.id} title={s.title || t("settings.sites.untitled")} action={<a className="zst-btn zst-btn-sm" href={`/n/${s.id}`} target="_blank" rel="noopener"><ExternalLink />{t("settings.sites.open")}</a>}>
            {!d ? (
              <form
                className="zst-inline"
                style={{ padding: "14px 0" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(s.id, async () => {
                    const r = await api<{ domain: SiteDomain }>("POST", q, { op: "add", shareId: s.id, domain: draft[s.id] ?? "" });
                    if (!r.ok) return siteError(r.data.error, t);
                    upsert(r.data.domain);
                    return null;
                  });
                }}
              >
                <input className="zst-input" placeholder="docs.example.com" aria-label={t("settings.sites.domain")} value={draft[s.id] ?? ""} maxLength={253} onChange={(e) => setDraft((x) => ({ ...x, [s.id]: e.target.value }))} data-test="site-domain-input" />
                <button type="submit" className="zst-btn" disabled={busy || !(draft[s.id] ?? "").trim()}>
                  <Globe />
                  {t("settings.sites.connect")}
                </button>
              </form>
            ) : (
              <div className="zst-item" data-site-domain={d.domain}>
                <div className="zst-item-head">
                  <span className="zst-item-name">
                    {d.domain}
                    {d.verifiedAt ? <span className="zst-badge zst-badge-ok">{t("settings.sites.live")}</span> : <span className="zst-badge zst-badge-warn">{t("settings.sites.pending")}</span>}
                  </span>
                  <span className="zst-inline">
                    {d.verifiedAt ? (
                      <a className="zst-btn zst-btn-sm" href={`${scheme}://${d.domain}`} target="_blank" rel="noopener">
                        <ExternalLink />
                        {t("settings.sites.open")}
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="zst-btn zst-btn-sm zst-btn-primary"
                        disabled={busy}
                        data-test="site-verify"
                        onClick={() =>
                          void run(d.domain, async () => {
                            const r = await api<{ domain: SiteDomain }>("POST", q, { op: "verify", domain: d.domain });
                            if (!r.ok) return siteError(r.data.error, t);
                            upsert(r.data.domain);
                            return null;
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
                          if (r.ok) setDomains((l) => l.filter((x) => x.domain !== d.domain));
                          return r.ok ? null : t("common.error");
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
                    <span className="zst-muted">{t("settings.sites.dns")}</span>
                    <div className="zst-kv">
                      <span>{t("settings.sites.cname")}</span>
                      <span />
                      <span>{t("settings.sites.name")}</span>
                      <CopyValue value={d.domain} />
                      <span>{t("settings.sites.value")}</span>
                      <div data-test="site-cname">
                        <CopyValue value={d.cname} />
                      </div>
                      <span>{t("settings.sites.txt")}</span>
                      <span />
                      <span>{t("settings.sites.name")}</span>
                      <CopyValue value={d.txtName} />
                      <span>{t("settings.sites.value")}</span>
                      <CopyValue value={d.txtValue} />
                    </div>
                  </>
                )}
              </div>
            )}
            {(errors[s.id] || (d && errors[d.domain])) && (
              <p className="zst-error" role="alert">
                {errors[s.id] || (d ? errors[d.domain] : "")}
              </p>
            )}
          </Section>
        );
      })}
    </>
  );
}
