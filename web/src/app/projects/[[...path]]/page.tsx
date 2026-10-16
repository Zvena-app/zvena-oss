import type { Metadata } from "next";
import { ProjectsApp } from "@/components/projects/ProjectsApp";
import { initialBootstrap } from "@/lib/projects/api";
import { pageLocale, requireUser } from "@/lib/page";
import { pt } from "@/components/projects/i18n";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";

export async function generateMetadata(): Promise<Metadata> {
  return { title: pt(await pageLocale(), "app.name"), robots: { index: false, follow: false } };
}

// Zvena Projects: issues, projects, cycles and the roadmap of the open
// workspace. One page for every /projects/... address: the app switches
// screens itself and reads the place from the URL (src/components/projects).

type Props = { params: Promise<{ path?: string[] }>; searchParams: Promise<{ ws?: string; team?: string }> };

/** When the page's bootstrap was read (the app refetches it when it is old). */
const readAt = () => Date.now();

export default async function ProjectsPage({ params, searchParams }: Props) {
  const [{ path }, sp] = await Promise.all([params, searchParams]);
  const here = `/projects${path?.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}`;
  const { user, locale } = await requireUser(here, sp.ws, sp.team);
  const initial = initialBootstrap(user.id, user.ws.id, locale);
  const at = readAt();
  // The Projects words of the page's language (English and Russian live in the code).
  return (
    <Messages ns="projects" locale={locale} dict={messagesOf("projects", locale)}>
      <ProjectsApp user={user} initial={initial} initialAt={at} />
    </Messages>
  );
}
