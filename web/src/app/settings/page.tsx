import "./settings.css";
import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ChartLine, FileText, UserCheck, Fingerprint, Globe, ListTodo, Mail, ScrollText, Shield, UserRound } from "lucide-react";
import { AppShell } from "@/components/zvena/AppShell";
import { identitiesOf } from "@/lib/auth";
import { config } from "@/lib/config";
import { auditFacets } from "@/lib/enterprise/audit-log";
import { domainsOf } from "@/lib/enterprise/domains";
import { scimTokensOf } from "@/lib/enterprise/scim";
import { securityOf } from "@/lib/enterprise/security";
import { publishedSitesOf, siteDomainsOf } from "@/lib/enterprise/site-domains";
import { ssoOf } from "@/lib/enterprise/sso";
import { spInfo, ssoView } from "@/lib/enterprise/sso-view";
import { translate, type MessageKey } from "@/lib/i18n";
import { requireUser, pageLocale } from "@/lib/page";
import { usageOf } from "@/lib/storage";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { GuestsPanel } from "./GuestsPanel";
import { AuditPanel } from "./AuditPanel";
import { IdentityPanel } from "./IdentityPanel";
import { ScrollToCurrent } from "./parts";
import { SecurityPanel } from "./SecurityPanel";
import { SettingsPanel } from "./SettingsPanel";
import { SitesPanel } from "./SitesPanel";
import { customDomainsOn } from "@/lib/enterprise/hosts";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "nav.settings"), robots: { index: false, follow: false } };
}

type Tab = "account" | "security" | "identity" | "guests" | "audit" | "analytics" | "sites";
const WORKSPACE_TABS: { tab: Exclude<Tab, "account">; key: MessageKey; Icon: typeof Shield }[] = [
  { tab: "security", key: "settings.nav.security", Icon: Shield },
  { tab: "identity", key: "settings.nav.identity", Icon: Fingerprint },
  { tab: "guests", key: "settings.nav.guests", Icon: UserCheck },
  { tab: "audit", key: "settings.nav.audit", Icon: ScrollText },
  { tab: "analytics", key: "settings.nav.analytics", Icon: ChartLine },
  { tab: "sites", key: "settings.nav.sites", Icon: Globe },
];

/** Each app's own settings, reached from here (Notion keeps them in one Settings). */
const APP_SETTINGS: { key: MessageKey; Icon: typeof Shield; href: (ws: string) => string; test: string }[] = [
  { key: "nav.docs", Icon: FileText, href: (ws) => `/docs?ws=${ws}&settings=1#home`, test: "docs" },
  { key: "nav.projects", Icon: ListTodo, href: (ws) => `/projects/settings?ws=${ws}`, test: "projects" },
  { key: "nav.calendar", Icon: CalendarDays, href: (ws) => `/calendar?ws=${ws}&settings=1`, test: "calendar" },
  { key: "nav.mail", Icon: Mail, href: (ws) => `/mail/settings?ws=${ws}`, test: "mail" },
];

type Props = { searchParams: Promise<{ ws?: string; tab?: string }> };

// Settings, as in Notion: the account's own section, then the open
// workspace's (its owners only) — Security, Identity, Audit log, Sites.
export default async function SettingsPage({ searchParams }: Props) {
  const sp = await searchParams;
  // Sites (custom domains) only where the server can serve them (ZVENA_SITES_CUSTOM_DOMAINS).
  const tabs = WORKSPACE_TABS.filter((x) => x.tab !== "sites" || customDomainsOn());
  const tab: Tab = tabs.some((x) => x.tab === sp.tab) ? (sp.tab as Tab) : "account";
  const { user, locale } = await requireUser(tab === "account" ? "/settings" : `/settings?tab=${tab}`, sp.ws);
  const t = (k: MessageKey, v?: Record<string, string | number>) => translate(locale, k, v);
  const ws = user.ws;
  const owner = ws.role === "owner";
  const href = (x: Tab) => `/settings?ws=${encodeURIComponent(ws.id)}${x === "account" ? "" : `&tab=${x}`}`;
  const title = tab === "account" ? t("settings.title") : t(WORKSPACE_TABS.find((x) => x.tab === tab)?.key ?? "settings.title");

  let body: React.ReactNode;
  if (tab === "account") {
    body = <SettingsPanel name={user.name} email={user.email} usage={await usageOf(user.id)} identities={identitiesOf(user.id).map((i) => i.provider)} />;
  } else if (!owner) {
    body = <p className="zst-note">{t("settings.ownerOnly")}</p>;
  } else if (tab === "security") {
    body = (
      <>
        <p className="zst-lead">{t("settings.security.lead", { workspace: ws.name })}</p>
        <SecurityPanel ws={ws.id} initial={securityOf(ws.id)} personal={ws.personal} />
      </>
    );
  } else if (tab === "identity") {
    body = ws.personal ? (
      <p className="zst-note">{t("settings.identity.sharedOnly")}</p>
    ) : (
      <>
        <p className="zst-lead">{t("settings.identity.lead")}</p>
        <IdentityPanel ws={ws.id} domains={domainsOf(ws.id)} sso={ssoView(ssoOf(ws.id))} sp={spInfo(ws.id)} scimBase={`${config.appUrl}/scim/v2`} tokens={scimTokensOf(ws.id)} />
      </>
    );
  } else if (tab === "audit") {
    body = (
      <>
        <p className="zst-lead">{t("settings.audit.lead")}</p>
        <AuditPanel ws={ws.id} people={auditFacets(ws.id).actors} />
      </>
    );
  } else if (tab === "guests") {
    body = (
      <>
        <p className="zst-lead">{t("settings.guests.lead")}</p>
        <GuestsPanel ws={ws.id} />
      </>
    );
  } else if (tab === "analytics") {
    body = (
      <>
        <p className="zst-lead">{t("settings.analytics.lead")}</p>
        <AnalyticsPanel ws={ws.id} />
      </>
    );
  } else {
    body = (
      <>
        <p className="zst-lead">{t("settings.sites.lead")}</p>
        <SitesPanel ws={ws.id} sites={publishedSitesOf(ws.id)} initial={siteDomainsOf(ws.id)} scheme={config.isTestStand && config.appUrl.startsWith("http://") ? "http" : "https"} />
      </>
    );
  }

  return (
    <AppShell user={user} section="settings">
      <div className="zst">
        <nav className="zst-nav" aria-label={t("nav.settings")}>
          <div className="zst-nav-label">{user.name}</div>
          <Link className="zst-nav-link" href={href("account")} aria-current={tab === "account" ? "page" : undefined}>
            <UserRound />
            {t("settings.nav.account")}
          </Link>
          {owner && (
            <>
              <div className="zst-nav-label">{ws.name}</div>
              {tabs.map(({ tab: x, key, Icon }) => (
                <Link key={x} className="zst-nav-link" href={href(x)} aria-current={tab === x ? "page" : undefined} data-test={`settings-${x}`}>
                  <Icon />
                  {t(key)}
                </Link>
              ))}
            </>
          )}
          <div className="zst-nav-label">{t("settings.nav.apps")}</div>
          {APP_SETTINGS.map(({ key, Icon, href: to, test }) => (
            <a key={test} className="zst-nav-link" href={to(encodeURIComponent(ws.id))} data-test={`settings-app-${test}`}>
              <Icon />
              {t(key)}
            </a>
          ))}
          <ScrollToCurrent />
        </nav>
        <div className="zst-main">
          <h1 className="zst-title">{title}</h1>
          {tab === "account" && <p className="zst-lead">{user.name}</p>}
          {body}
        </div>
      </div>
    </AppShell>
  );
}
