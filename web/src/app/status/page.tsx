import type { Metadata } from "next";
import { pageMetadata } from "@/lib/meta";
import { health, type PartState } from "@/lib/health";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import "../content.css";

const description = "Live status of zvena: the website and Docs, database, file storage, Design and email.";

export const metadata: Metadata = pageMetadata({ title: "Service status", description: description, path: "/status", previewTitle: "zvena status" });
export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = {
  web: "Website and Docs",
  database: "Database",
  files: "File storage",
  design: "Design",
  mail: "Email",
};

const STATE: Record<PartState, [string, string]> = {
  ok: ["Operational", "zv-yes"],
  degraded: ["Degraded performance", "zv-part"],
  down: ["Outage", "zv-no"],
  off: ["Not configured", "zv-muted"],
};

export default async function StatusPage() {
  const { user, locale } = await pageUser();
  const h = await health();
  const checked = new Date(h.at).toLocaleString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-prose">
        <h1>zvena status</h1>
        <p className={h.ok ? "zv-banner" : "zv-banner zv-banner-error"} role="status">
          {h.ok ? "All systems operational." : "Some systems are having problems. We're on it."}
        </p>
        <table className="zc-status">
          <tbody>
            {Object.entries(h.parts).map(([k, v]) => (
              <tr key={k}>
                <td>{LABEL[k] ?? k}</td>
                <td className={STATE[v][1]}>
                  <span className="zc-dot" aria-hidden="true" />
                  {STATE[v][0]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="zv-muted zv-small">
          Checked: <time dateTime={h.at}>{checked} UTC</time>. This page checks every part live each time it loads.
        </p>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
