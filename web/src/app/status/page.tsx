import type { Metadata } from "next";
import { pageMetadata } from "@/lib/meta";
import { health, type Overall, type PartState, type Parts } from "@/lib/health";
import { translate, type MessageKey } from "@/lib/i18n";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import "../content.css";

const description = "Live status of zvena: the website and Docs, database, file storage, Design and email.";

export const metadata: Metadata = pageMetadata({ title: "Service status", description: description, path: "/status", previewTitle: "zvena status" });
export const dynamic = "force-dynamic";

const STATE: Record<PartState, string> = {
  ok: "zv-yes",
  degraded: "zv-part",
  down: "zv-no",
  off: "zv-muted",
  unverified: "zv-muted",
};

// The banner: anything short of every part working shows.
const BANNER: Record<Overall, [MessageKey, string]> = {
  operational: ["status.operational", "zv-banner"],
  degraded: ["status.degraded", "zv-banner zv-banner-warn"],
  partial_outage: ["status.partial", "zv-banner zv-banner-error"],
  major_outage: ["status.major", "zv-banner zv-banner-error"],
};

export default async function StatusPage() {
  const { user, locale } = await pageUser();
  const t = (k: MessageKey) => translate(locale, k);
  const h = await health();
  const checked = new Date(h.at).toLocaleString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const [banner, bannerClass] = BANNER[h.status];
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-prose">
        <h1>{t("status.title")}</h1>
        <p className={bannerClass} role="status">
          {t(banner)}
        </p>
        <table className="zc-status">
          <tbody>
            {(Object.entries(h.parts) as [keyof Parts, PartState][]).map(([k, v]) => (
              <tr key={k}>
                <td>{t(`status.part.${k}`)}</td>
                <td className={STATE[v]}>
                  <span className="zc-dot" aria-hidden="true" />
                  {t(`status.state.${v}`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="zv-muted zv-small">
          {t("status.checked")} <time dateTime={h.at}>{checked} UTC</time>. {t("status.live")}
          {h.parts.mail === "off" ? null : ` ${t("status.mailNote")}`}
        </p>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
