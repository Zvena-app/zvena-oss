import type { Metadata } from "next";
import {
  BookOpen, BookMarked, CalendarDays, ClipboardList, Compass, Component, FileCode2, FileText, Flag, FlaskConical, GraduationCap, Hand, Heart, Kanban, Lightbulb, ListChecks,
  Map as MapIcon, Monitor, NotebookPen, Palette, PenLine, Presentation, Repeat, Rocket, ScrollText, Smartphone, Target, Timer, UserPlus, Users, Video,
} from "lucide-react";
import { enRu } from "@/i18n/locales";
import { AppShell } from "@/components/zvena/AppShell";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "@/components/notes/templates";
import { DESIGN_TEMPLATES, templateFile } from "@/lib/design-templates";
import { translate, type MessageKey } from "@/lib/i18n";
import { notesT, type NotesKey } from "@/lib/notes/i18n";
import { requireUser, pageLocale } from "@/lib/page";
import { TemplateCard } from "./TemplateCard";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "nav.templates"), robots: { index: false, follow: false } };
}

/** Docs templates as line icons on a tint per gallery section (the page they create keeps its emoji). */
const DOC_ICON: Record<string, React.ReactNode> = {
  getStarted: <Hand />, homework: <NotebookPen />, schedule: <CalendarDays />, lecture: <Presentation />, exam: <GraduationCap />, essay: <PenLine />, diploma: <ScrollText />,
  todo: <ListChecks />, journal: <BookOpen />, reading: <BookMarked />, habits: <Repeat />, personal: <Heart />, notes: <FileText />,
  meeting: <Video />, projects: <Kanban />, weekly: <Timer />, docs: <FileCode2 />, roadmap: <MapIcon />,
  teamWiki: <Users />, productSpec: <Lightbulb />, taskTracker: <ClipboardList />, sprint: <Rocket />, onboarding: <UserPlus />, techSpec: <Compass />,
  userResearch: <FlaskConical />, designReview: <Palette />, brief: <Flag />, okr: <Target />, releases: <Rocket />,
};
const CATEGORY_TINT: Record<string, string> = { start: "var(--ui-tint-blue)", team: "var(--ui-tint-indigo)", school: "var(--ui-tint-green)", work: "var(--ui-tint-orange)", life: "var(--ui-tint-pink)" };

/** Design templates as line icons on the tints of "What will you create?" (website, mobile, components). */
const DESIGN_ICON: Record<string, { icon: React.ReactNode; tint: string }> = {
  landing: { icon: <Monitor />, tint: "var(--ui-tint-indigo)" },
  mobileApp: { icon: <Smartphone />, tint: "var(--ui-tint-teal)" },
  uiKit: { icon: <Component />, tint: "var(--ui-tint-purple)" },
};

type Props = { searchParams: Promise<{ ws?: string; team?: string }> };

export default async function TemplatesPage({ searchParams }: Props) {
  const sp = await searchParams;
  const { user, locale } = await requireUser("/templates", sp.ws, sp.team);
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);
  const nt = (k: string) => notesT(locale, k as NotesKey);
  const ws = user.ws;
  const canEdit = ws.role === "owner" || ws.role === "editor";
  const designReady = DESIGN_TEMPLATES.filter((d) => templateFile(d, enRu(locale)) !== null);
  return (
    <AppShell user={user} section="templates" title={t("templates.title")}>
      <div className="zv-content">
        <p className="zv-page-lead">
          {t("templates.lead")} {!canEdit && `(${t("ws.readOnly").replace("{role}", t(`ws.role.${ws.role}`))})`}
        </p>
        {designReady.length > 0 && (
          <section className="zv-sec">
            <div className="zv-sec-head">
              <h2>{t("templates.design")}</h2>
            </div>
            <div className="zv-grid">
              {designReady.map((d) => (
                <TemplateCard key={d.key} icon={DESIGN_ICON[d.key]?.icon ?? d.icon} tint={DESIGN_ICON[d.key]?.tint} title={t(`dtpl.${d.key}.name` as MessageKey)} description={t(`dtpl.${d.key}.description` as MessageKey)} href={`/api/design/template?ws=${encodeURIComponent(ws.id)}&key=${d.key}`} disabled={!canEdit} label={t("templates.use")} />
              ))}
            </div>
          </section>
        )}
        {TEMPLATE_CATEGORIES.map((cat) => {
          const list = TEMPLATES.filter((x) => x.category === cat);
          if (!list.length) return null;
          return (
            <section className="zv-sec" key={cat}>
              <div className="zv-sec-head">
                <h2>
                  {t("templates.docs")} · {nt(`tpl.cat.${cat}`)}
                </h2>
              </div>
              <div className="zv-grid">
                {list.map((x) => (
                  <TemplateCard key={x.key} icon={DOC_ICON[x.key] ?? x.icon} tint={CATEGORY_TINT[cat]} title={nt(`tpl.${x.key}`)} href={`/docs?ws=${encodeURIComponent(ws.id)}#tpl=${x.key}/${locale}`} disabled={!canEdit} label={t("templates.use")} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
