import type { Metadata } from "next";
import { translate } from "@/lib/i18n";
import { pageUser } from "@/lib/page";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { SignOutButtons } from "./SignOutButtons";

export const metadata: Metadata = { title: "Sign out", robots: { index: false, follow: false } };

// Where Design sends people after "Sign out" there: end the zvena session
// too, or go back home (Design signs in through zvena by itself).
export default async function SignOutPage() {
  const { user, locale } = await pageUser();
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-center">
        <div className="zv-panel">
          <h1>{user ? translate(locale, "signout.title") : translate(locale, "nav.signout")}</h1>
          <p className="zv-lead">{translate(locale, user ? "signout.fromDesign" : "signout.done")}</p>
          <SignOutButtons signedIn={Boolean(user)} />
        </div>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
