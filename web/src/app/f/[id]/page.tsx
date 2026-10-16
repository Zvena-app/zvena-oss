import type { Metadata } from "next";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";
import "@/i18n/server-catalogs";
import { formServable } from "@/lib/enterprise/site-domains";
import { formForVisitor, formRespondent, readNoteForm } from "@/lib/notes/server-store";
import PublicForm from "@/components/notes/PublicForm";
import { iconText } from "@/lib/notes/model";
import { notesT } from "@/lib/notes/i18n";
import { pageLocale, pageUser } from "@/lib/page";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

// Public zvena Documents forms: anyone with the link can respond; never indexed.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const form = formServable(id) ? readNoteForm(id) : null;
  if (!form) return { title: "zvena", robots: { index: false, follow: false } };
  // An "icon:…" or uploaded-image icon has no text form: the title goes without it.
  const icon = iconText(form.icon);
  const title = `${icon ? `${icon} ` : ""}${form.title || notesT(await pageLocale(), "form.untitled")}`;
  const description = form.description.replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, siteName: "zvena", type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function FormPage({ params }: Props) {
  const { id } = await params;
  // A workspace that turned publishing off serves no form (Settings → Security).
  // The form speaks the visitor's language from the first paint (the Documents catalog goes with it).
  const lang = await pageLocale();
  // Who answers: a members-only form asks others to sign in, and a member's response carries their name.
  const { user } = await pageUser();
  const who = { signedIn: Boolean(user), member: formRespondent(id, user?.id ?? null).member, name: user?.name ?? "" };
  return (
    <Messages ns="docs" locale={lang} dict={messagesOf("docs", lang)}>
      <PublicForm form={formServable(id) ? formForVisitor(id, who.member) : null} who={who} />
    </Messages>
  );
}
