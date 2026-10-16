import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { translate } from "@/lib/i18n";
import { pageLocale } from "@/lib/page";
import { OfflineRetry } from "./OfflineRetry";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "pwa.offlineTitle"), robots: { index: false, follow: false } };
}

// What the installed app shows for a page it has no offline copy of
// (public/sw.js keeps this one from the install on). Nothing personal: the
// worker stores it for everyone.
export default async function OfflinePage() {
  const locale = await pageLocale();
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);
  return (
    <main className="zv-center">
      <div className="zv-panel">
        <div className="zv-panel-icon">
          <WifiOff />
        </div>
        <h1>{t("pwa.offlineTitle")}</h1>
        <p className="zv-lead">{t("pwa.offlineLead")}</p>
        <div className="zv-stack">
          <a className="zv-btn zv-btn-primary zv-btn-lg zv-btn-block" href="/docs">
            {t("pwa.openDocs")}
          </a>
          <OfflineRetry label={t("pwa.retry")} />
        </div>
      </div>
    </main>
  );
}
