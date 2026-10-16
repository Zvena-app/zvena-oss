// Terms of Service and Privacy Policy are the operator's own documents: the
// open-source edition ships no legal text of its own. With ZVENA_TERMS_URL /
// ZVENA_PRIVACY_URL set, the page sends visitors there; without them it says
// so plainly, and points the operator to the setting.

import { redirect } from "next/navigation";
import { config } from "@/lib/config";
import { Email } from "./Email";
import { LegalPage } from "./LegalPage";

export async function OperatorLegal({ kind }: { kind: "terms" | "privacy" }) {
  const url = kind === "terms" ? config.legal.termsUrl : config.legal.privacyUrl;
  if (url) redirect(url);
  const title = kind === "terms" ? "Terms of Service" : "Privacy Policy";
  const env = kind === "terms" ? "ZVENA_TERMS_URL" : "ZVENA_PRIVACY_URL";
  return (
    <LegalPage title={title} updated={config.legalUpdated}>
      <p>
        This zvena server is run by its operator, who is responsible for the {title.toLowerCase()} that applies to it. The operator has not published it here yet.
      </p>
      <p>
        Questions: <Email address={config.company.email} />.
      </p>
      <p className="zv-muted">
        For the operator: publish your {title} and set <code>{env}</code> to its address; this page will send people there. The software itself is described in
        the <a href="/source">source code</a>.
      </p>
    </LegalPage>
  );
}
