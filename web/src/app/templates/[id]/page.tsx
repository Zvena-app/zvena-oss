import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { TEMPLATES } from "@/components/notes/templates";
import { PublicFooter, PublicHeader } from "@/components/zvena/PublicChrome";
import { DESIGN_TEMPLATES } from "@/lib/design-templates";
import { pageMetadata } from "@/lib/meta";
import { notesT, type NotesKey } from "@/lib/notes/i18n";
import { pageUser } from "@/lib/page";
import { publicTemplate, templatePath, templateSignIn, templateUseHref, type PublicTemplate } from "@/lib/public-templates";
import { TemplatePreview, templateSummary } from "./TemplatePreview";
import "./template.css";

// A template before you use it (and before you have an account): what it is
// and what is in it, rendered from the template itself. "Use this template"
// signs a visitor in and comes back here with ?use=1 (lib/public-templates.ts),
// which then adds it to the open workspace. The page is in English.

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ use?: string }> };

function info(t: PublicTemplate) {
  if (t.kind === "design") {
    const d = DESIGN_TEMPLATES.find((x) => x.key === t.key)!;
    return { name: d.name.en, icon: d.icon, lead: d.description.en, where: "It opens in Design as a new file of your workspace, yours to change." };
  }
  const tpl = TEMPLATES.find((x) => x.key === t.key)!;
  const node = tpl.build("en");
  return { name: notesT("en", `tpl.${t.key}` as NotesKey), icon: tpl.icon, lead: templateSummary(node), where: "It is added to your Docs as a copy, yours to change.", node };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const t = publicTemplate((await params).id);
  if (!t) return { title: "Template not found", robots: { index: false, follow: false } };
  const i = info(t);
  return pageMetadata({ title: `${i.name} template`, description: `${i.lead} A free ${t.kind === "design" ? "zvena Design" : "zvena Docs"} template: preview it, then use it in one click.`, path: templatePath(t.id) });
}

export default async function TemplatePage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const t = publicTemplate(id);
  if (!t) notFound();
  const { user, locale } = await pageUser();
  const i = info(t);
  const canAdd = Boolean(user) && user!.ws.role !== "viewer" && user!.ws.role !== "commenter";
  const useHref = user ? templateUseHref(t, user.ws.id, locale) : templateSignIn(t.id);
  if (user && sp.use === "1") {
    if (!user.consentOk) redirect(`/consent?next=${encodeURIComponent(templatePath(t.id, true))}`);
    // Back from sign-in: add it now. Only when the request started on zvena
    // (sign-in, /welcome) or was typed in — a link on another site shows the
    // button instead, as /api/design/template itself refuses cross-site starts.
    const site = (await headers()).get("sec-fetch-site");
    if (canAdd && (!site || site === "same-origin" || site === "none")) redirect(useHref);
  }
  return (
    <>
      <PublicHeader locale={locale} signedIn={Boolean(user)} />
      <main className="zv-prose zt">
        <p className="zt-back">
          <Link href="/#explore">
            <ArrowLeft aria-hidden="true" />
            Templates
          </Link>
        </p>
        <p className="zv-eyebrow">{t.kind === "design" ? "Design template" : "Docs template"}</p>
        <h1>
          <span aria-hidden="true">{i.icon}</span> {i.name}
        </h1>
        <p className="zv-prose-lead">{i.lead}</p>
        <div className="zt-cta">
          {user && !canAdd ? (
            <p className="zv-banner">You can view this workspace but not add to it. Switch to a workspace where you are an editor to use this template.</p>
          ) : (
            <div className="zv-actions">
              <a className="zv-btn zv-btn-primary zv-btn-lg" href={useHref} data-test="template-use">
                {user ? "Use this template" : "Sign in to use this template"}
              </a>
              {!user && t.kind === "doc" && (
                <a className="zv-btn zv-btn-lg" href={`/docs#tpl=${t.key}/en`} data-test="template-try">
                  Try it without an account
                </a>
              )}
            </div>
          )}
          <p className="zt-note">
            {i.where}
            {user ? ` It goes to “${user.ws.name}”.` : t.kind === "doc" ? " Without an account it stays in this browser only." : " Design needs a free account."}
          </p>
        </div>
        <section className="zt-preview" aria-label={`Preview of ${i.name}`}>
          {i.node ? (
            <div className="zt-doc">
              <h2 className="zt-title">
                <span aria-hidden="true">{i.node.icon}</span> {i.node.title}
              </h2>
              <TemplatePreview node={i.node} />
            </div>
          ) : (
            <p className="zt-muted">Open it in Design to see every screen.</p>
          )}
        </section>
      </main>
      <PublicFooter locale={locale} />
    </>
  );
}
