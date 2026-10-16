import type { Metadata } from "next";
import { translate } from "@/lib/i18n";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { ReportForm } from "./ReportForm";

export const metadata: Metadata = { title: "Report content", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ url?: string }> };

export default async function ReportPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { user, locale } = await pageUser();
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-center">
        <div className="zv-panel zv-panel-wide">
          <h1>{t("report.title")}</h1>
          <p className="zv-lead">{t("report.lead")}</p>
          <ReportForm initialUrl={typeof sp.url === "string" ? sp.url.slice(0, 2000) : ""} />
        </div>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
