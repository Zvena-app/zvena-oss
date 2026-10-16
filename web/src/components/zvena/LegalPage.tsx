// The frame of a legal text: public header/footer and the effective date. Who
// runs zvena comes from config.company (a non-commercial project unless
// ZVENA_COMPANY_* is set, see deploy/.env.example).

import type { ReactNode } from "react";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "./PublicChrome";

/** "2026-10-15" → "October 15, 2026". */
export function legalDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export async function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  const { user, locale } = await pageUser();
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-prose zv-legal">
        <h1>{title}</h1>
        <p className="zv-muted">Effective date: {legalDate(updated)}</p>
        {children}
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
