import type { Metadata } from "next";
import { Scissors } from "lucide-react";
import { CHALLENGE_RE, STATE_RE, cleanClient } from "@/lib/clipper";
import { translate } from "@/lib/i18n";
import { pageLocale, requireUser } from "@/lib/page";
import { ConnectButtons } from "./ConnectButtons";
import "../clipper.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "clipper.connect.title"), robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<{ state?: string; challenge?: string; client?: string }> };

const BROWSER: Record<string, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari" };

// The Web Clipper's "Connect" (lib/clipper.ts): the extension opened this tab
// with its state and PKCE challenge; the signed-in person allows it here.
// The page lives on our origin only (no frames: frame-ancestors 'none').
export default async function ConnectClipperPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
  const { user, locale } = await requireUser(`/clipper/connect${q ? `?${q}` : ""}`);
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string>) => translate(locale, k, v);
  const valid = typeof sp.state === "string" && STATE_RE.test(sp.state) && typeof sp.challenge === "string" && CHALLENGE_RE.test(sp.challenge);
  const client = cleanClient(sp.client);
  return (
    <main className="zv-center">
      <div className="zv-panel zv-clipper">
        <span className="zv-clipper-logo" role="img" aria-label="zvena" />
        <div className="zv-panel-icon">
          <Scissors />
        </div>
        <h1>{t("clipper.connect.title")}</h1>
        {valid ? (
          <>
            <p className="zv-lead">{t("clipper.connect.lead", { app: BROWSER[client] ? `${t("clipper.name")} · ${BROWSER[client]}` : t("clipper.name") })}</p>
            <div className="zv-clipper-scope">
              <p>{t("clipper.connect.can")}</p>
              <ul>
                <li>{t("clipper.connect.can1")}</li>
                <li>{t("clipper.connect.can2")}</li>
              </ul>
              <p className="zv-muted zv-small">{t("clipper.connect.cannot")}</p>
            </div>
            <p className="zv-muted zv-small zv-clipper-who">{t("clipper.connect.as", { name: user.name })}</p>
            <ConnectButtons state={sp.state as string} challenge={sp.challenge as string} client={client} />
          </>
        ) : (
          <p className="zv-lead" role="alert">
            {t("clipper.connect.bad")}
          </p>
        )}
      </div>
    </main>
  );
}
