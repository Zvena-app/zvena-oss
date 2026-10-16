import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FileText, Home as HomeIcon, PenTool, Plus } from "lucide-react";
import { CreateHero } from "@/components/zvena/create/CreateHero";
import { AppShell } from "@/components/zvena/AppShell";
import { HomeInbox, LiveCards } from "@/components/eco/HomeParts";
import { JevPanel } from "@/components/eco/JevPanel";
import { myDay } from "@/lib/eco/myday";
import { formatBytes, translate, type Locale } from "@/lib/i18n";
import { intlTag } from "@/i18n/locales";
import { requireUser, pageLocale } from "@/lib/page";
import { recentDocs } from "@/lib/docs-summary";
import { notesT } from "@/lib/notes/i18n";
import { designConfigured, teamFiles, type DesignFile } from "@/lib/penpot";
import { syncWorkspaceDesign } from "@/lib/design-sync";
import { usageOf } from "@/lib/storage";
import { productHref } from "@/lib/products";
import { pt } from "@/components/projects/i18n";
import "./home.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "nav.home"), robots: { index: false, follow: false } };
}

/** Home's "Recent designs" rows: Design answers in time (1.5 s) or the section says it is off. */
async function RecentDesigns({ userId, wsId, q, canEdit, locale }: { userId: string; wsId: string; q: string; canEdit: boolean; locale: Locale }) {
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(locale, k, v);
  const designs = await Promise.race([
    (async (): Promise<DesignFile[] | null> => {
      if (!designConfigured()) return null;
      try {
        const teamId = await syncWorkspaceDesign(wsId);
        return teamId ? (await teamFiles(userId, teamId)).files.slice(0, 8) : [];
      } catch {
        return null;
      }
    })(),
    new Promise<null>((r) => setTimeout(() => r(null), 1500)),
  ]);
  if (designs === null) return <div className="eco-home-empty">{t("home.designOff")}</div>;
  if (designs.length === 0)
    return (
      <div className="eco-home-empty">
        {t("home.noDesigns")}{" "}
        {canEdit && (
          <a href={`/design?${q}&new=1`}>
            <Plus size={14} style={{ verticalAlign: -2 }} aria-hidden /> {t("home.newDesign")}
          </a>
        )}
      </div>
    );
  return (
    <>
      {designs.map((f) => (
        <a key={f.id} className="eco-home-row" href={`/design?${q}&file=${encodeURIComponent(f.id)}`}>
          <span className="eco-home-icon">
            <PenTool size={16} aria-hidden />
          </span>
          <span className="eco-home-title">{f.name}</span>
          <span className="eco-home-sub">{f.project}</span>
          <time className="eco-home-meta" dateTime={f.modifiedAt}>
            {when(Date.parse(f.modifiedAt), locale)}
          </time>
        </a>
      ))}
    </>
  );
}

type Props = { searchParams: Promise<{ ws?: string; team?: string; welcome?: string }> };

/** Linear's short time: the hour today, the day otherwise (the year only when it is another one). */
function when(ts: number, locale: Locale): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(intlTag(locale), { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(intlTag(locale), { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

// Home is "My day": what is on this person's plate across every product —
// their issues (overdue first), the Inbox, where they are mentioned, the
// projects under way — and then the latest documents and designs.
// It is laid out like a Linear view: a thin header, dense lists with group
// heads, and a side panel; Canva's part is the one-click "create" row.
export default async function HomePage({ searchParams }: Props) {
  const sp = await searchParams;
  const { user, locale } = await requireUser("/home", sp.ws, sp.team);
  const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(locale, k, v);
  const ws = user.ws;
  const q = `ws=${encodeURIComponent(ws.id)}`;
  const docs = recentDocs(ws.id, 8, notesT(locale, "page.untitled"), user.id);
  const [day, usage] = await Promise.all([myDay({ userId: user.id, wsId: ws.id, locale }), usageOf(user.id)]);
  const pct = usage.quota ? Math.min(100, Math.round((usage.total / usage.quota) * 100)) : 0;
  const canEdit = ws.role === "owner" || ws.role === "editor";
  const today = new Date().toLocaleDateString(intlTag(locale), { weekday: "long", month: "long", day: "numeric" });
  const counts = [day.overdue ? t("home.overdue", { n: day.overdue }) : null, day.dueToday ? t("home.dueToday", { n: day.dueToday }) : null].filter(Boolean).join(" · ");
  const prio = [0, 1, 2, 3, 4].map((n) => pt(locale, `prio.${n}` as "prio.0"));
  return (
    <AppShell user={user} section="home">
      <div className="eco-home">
        {/* Linear's view header: what this is on the left, the day on the right. */}
        <header className="eco-home-head">
          <h1>
            <HomeIcon size={16} aria-hidden />
            {t("nav.home")}
          </h1>
          <span className="eco-home-today">
            {today} · {ws.name}
          </span>
        </header>
        <div className="eco-home-body">
          <div className="eco-home-main">
            <p className="eco-home-hello">{t("home.hello", { name: user.name.split(/\s+/)[0] })}</p>
            {sp.welcome && ws.personal && <p className="zv-banner eco-home-banner">{t("ws.personalNote")}</p>}
            {/* One way to create anything, the same here, in the sidebar (C) and in Cmd+K. */}
            <CreateHero ws={ws.id} canEdit={canEdit} />
            {/* Jev runs the workspace: goals with their numbers, what it proposes, what it did. */}
            <JevPanel ws={ws.id} canEdit={canEdit} owner={ws.role === "owner"} />

            <section className="eco-home-list" aria-labelledby="eh-issues">
              <div className="eco-home-group">
                <h2 id="eh-issues">{t("home.myIssues")}</h2>
                {day.issues.length > 0 && <span className="eco-home-count">{day.issues.length}</span>}
                {counts && <span className="eco-home-counts">{counts}</span>}
                <Link className="eco-home-all" href={`/projects/my-issues?${q}`}>
                  {t("home.openAll")}
                </Link>
              </div>
              {day.hasProjects || day.issues.length ? (
                <LiveCards ws={ws.id} cards={day.issues} check={canEdit} prio={prio} list empty={t("home.myIssuesEmpty")} />
              ) : (
                <div className="eco-home-empty">
                  {t("home.setupProjects")} <Link href={productHref("projects", ws.id)}>{t("home.openProjects")}</Link>
                </div>
              )}
            </section>

            {day.mentions.length > 0 && (
              <section className="eco-home-list" aria-labelledby="eh-mentions">
                <div className="eco-home-group">
                  <h2 id="eh-mentions">{t("home.mentions")}</h2>
                  <span className="eco-home-count">{day.mentions.length}</span>
                </div>
                <LiveCards ws={ws.id} cards={day.mentions} list />
              </section>
            )}

            <section className="eco-home-list" aria-labelledby="eh-docs">
              <div className="eco-home-group">
                <h2 id="eh-docs">{t("home.recentDocs")}</h2>
                <Link className="eco-home-all" href={productHref("docs", ws.id)}>
                  {t("home.openAll")}
                </Link>
              </div>
              {docs.length === 0 ? (
                <div className="eco-home-empty">{t("home.noDocs")}</div>
              ) : (
                docs.map((d) => (
                  <Link key={d.id} className="eco-home-row" href={d.href}>
                    <span className="eco-home-icon">{d.icon || <FileText size={16} aria-hidden />}</span>
                    <span className="eco-home-title">{d.title}</span>
                    <time className="eco-home-meta" dateTime={new Date(d.updatedAt).toISOString()}>
                      {when(d.updatedAt, locale)}
                    </time>
                  </Link>
                ))
              )}
            </section>

            <section className="eco-home-list" aria-labelledby="eh-designs">
              <div className="eco-home-group">
                <h2 id="eh-designs">{t("home.recentDesigns")}</h2>
                {/* A plain link: /design redirects to Design's own address (nothing to prefetch). */}
                <a className="eco-home-all" href={productHref("design", ws.id)}>
                  {t("home.openAll")}
                </a>
              </div>
              {/* Design is a separate service: Home is sent at once and its files follow when it answers. */}
              <Suspense fallback={<div className="eco-home-empty" aria-busy="true">…</div>}>
                <RecentDesigns userId={user.id} wsId={ws.id} q={q} canEdit={canEdit} locale={locale} />
              </Suspense>
            </section>
          </div>

          {/* Linear's side panel: the Inbox, the projects under way, the storage. */}
          <aside className="eco-home-side">
            <section className="eco-home-panel" aria-labelledby="eh-inbox">
              <div className="eco-home-panel-head">
                <h2 id="eh-inbox">{t("home.inbox")}</h2>
                <Link className="eco-home-all" href={`/inbox?${q}`}>
                  {t("home.openAll")}
                </Link>
              </div>
              <HomeInbox ws={ws.id} me={user.id} />
            </section>

            {day.projects.length > 0 && (
              <section className="eco-home-panel" aria-labelledby="eh-projects">
                <div className="eco-home-panel-head">
                  <h2 id="eh-projects">{t("home.projects")}</h2>
                  <Link className="eco-home-all" href={productHref("projects", ws.id)}>
                    {t("home.openAll")}
                  </Link>
                </div>
                <LiveCards ws={ws.id} cards={day.projects} />
              </section>
            )}

            <section className="eco-home-panel" aria-labelledby="eh-storage">
              <div className="eco-home-panel-head">
                <h2 id="eh-storage">{t("home.storage")}</h2>
                <Link className="eco-home-all" href="/settings">
                  {t("nav.settings")}
                </Link>
              </div>
              <div className="zv-meter" data-full={pct >= 100 || undefined} role="progressbar" aria-labelledby="eh-storage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <p className="eco-home-storage">{t("settings.storageOf", { used: formatBytes(usage.total, locale), quota: formatBytes(usage.quota, locale) })}</p>
            </section>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
