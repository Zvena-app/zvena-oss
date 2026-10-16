import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { translate } from "@/lib/i18n";
import { safeNext } from "@/lib/safe-next";
import { pageUser } from "@/lib/page";
import { legalDate } from "@/components/zvena/LegalPage";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { ReconsentForm } from "../signin/SignInForm";

export const metadata: Metadata = { title: "Updated Terms", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ next?: string }> };

// The Terms or the Privacy Policy changed (ZVENA_CONSENT_VERSION): a
// signed-in person accepts the new version before going on.
export default async function ConsentPage({ searchParams }: Props) {
  const next = safeNext((await searchParams).next);
  const { user, locale } = await pageUser();
  if (!user) redirect(`/signin?next=${encodeURIComponent(next)}`);
  if (user.consentOk) redirect(next);
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string>) => translate(locale, k, v);
  return (
    <>
      <PublicHeader locale={locale} signedIn />
      <main className="zv-center">
        <div className="zv-panel">
          <h1>{t("consent.title")}</h1>
          <p className="zv-lead">{t("consent.lead", { date: legalDate(config.legalUpdated) })}</p>
          <ReconsentForm next={next} />
        </div>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
