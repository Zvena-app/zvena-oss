import type { Metadata, Viewport } from "next";
import { Messages } from "@/i18n/Messages";
import { messagesOf } from "@/i18n/runtime";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth";
import { UI_LANG_COOKIE, parseAcceptLanguage, resolveLocale, translate } from "@/lib/i18n";
import { notesT, type NotesKey } from "@/lib/notes/i18n";
import { pageLocale } from "@/lib/page";
import { sessionUser, WS_COOKIE } from "@/lib/session";
import type { ShellLabels } from "@/components/notes/NotesShell";
import type { NotesUser } from "@/components/notes/context";
import { NotesRoot } from "./NotesRoot";

// zvena Documents: pages and databases of the open workspace. Everything
// renders in the browser (local-first store); the server page sends the
// loading shell in the person's language, with who is signed in and which
// workspace is open (the page is private, no-store), so the first paint has
// the sidebar and the workspace can show this device's pages at once.

export async function generateMetadata(): Promise<Metadata> {
  return { title: { absolute: notesT(await pageLocale(), "app.name") }, robots: { index: false, follow: false } };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

type Props = { searchParams: Promise<{ ws?: string; team?: string }> };

export default async function DocsPage({ searchParams }: Props) {
  const [h, c, sp] = await Promise.all([headers(), cookies(), searchParams]);
  const locale = resolveLocale(c.get(UI_LANG_COOKIE)?.value, parseAcceptLanguage(h.get("accept-language")));
  let user: NotesUser | null = null;
  let stale = false;
  try {
    const u = readSession(h.get("cookie"));
    stale = Boolean(u && !u.consentOk);
    if (u) user = sessionUser(u, typeof sp.ws === "string" ? sp.ws : null, c.get(WS_COOKIE)?.value, translate(locale, "ws.personal"), typeof sp.team === "string" ? sp.team : null);
  } catch {
    user = null;
  }
  if (stale) {
    const q = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
    redirect(`/consent?next=${encodeURIComponent(`/docs${q ? `?${q}` : ""}`)}`);
  }
  const t = (k: NotesKey) => notesT(locale, k);
  const labels: ShellLabels = {
    notes: t("app.notesShort"),
    newPage: t("side.newPage"),
    search: t("side.search"),
    home: t("side.home"),
    templates: t("side.templates"),
    apps: { home: t("side.zhome"), docs: t("app.notesShort"), projects: t("side.projects"), calendar: translate(locale, "nav.calendar"), mail: translate(locale, "nav.mail"), design: t("side.board"), templates: t("side.ztemplates"), team: t("side.team") },
    pages: t("side.private"),
    guest: t("app.workspaceGuest"),
    sync: user ? t("side.syncOn") : t("side.syncOff"),
    settings: t("side.settings"),
    trash: t("side.trash"),
    help: t("side.help"),
    appsTitle: t("side.apps"),
  };
  // The Docs words of the page's language (English and Russian live in the code).
  return (
    <Messages ns="docs" locale={locale} dict={messagesOf("docs", locale)}>
      <NotesRoot user={user} labels={labels} />
    </Messages>
  );
}
