import type { Metadata } from "next";
import { translate } from "@/lib/i18n";
import { pageLocale } from "@/lib/page";
import { ConnectedStatus } from "./ConnectedStatus";
import "../clipper.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "clipper.connected.title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

// Where /clipper/connect sends the code (#code=…&state=…). The extension's
// content script reads and clears it before this page's script runs; the
// page only says how it went.
export default async function ClipperConnectedPage() {
  const locale = await pageLocale();
  return (
    <main className="zv-center">
      <div className="zv-panel zv-clipper">
        <span className="zv-clipper-logo" role="img" aria-label="zvena" />
        <ConnectedStatus
          labels={{
            title: translate(locale, "clipper.connected.title"),
            lead: translate(locale, "clipper.connected.lead"),
            deniedTitle: translate(locale, "clipper.connected.denied"),
            deniedLead: translate(locale, "clipper.connected.deniedLead"),
            missing: translate(locale, "clipper.connected.noExtension"),
          }}
        />
      </div>
    </main>
  );
}
