import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/zvena/AppShell";
import { translate } from "@/lib/i18n";
import { requireUser, pageLocale } from "@/lib/page";
import { listReports, reportCounts } from "@/lib/reports";
import { sql } from "@/lib/store";
import { AdminQueue } from "./AdminQueue";

export async function generateMetadata(): Promise<Metadata> {
  return { title: translate(await pageLocale(), "nav.admin"), robots: { index: false, follow: false } };
}

export default async function AdminPage() {
  const { user, locale } = await requireUser("/admin");
  if (!user.isAdmin) notFound();
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);
  // Counts only: no names, no content.
  const stats = {
    users: Number((sql("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n),
    workspaces: Number((sql("SELECT COUNT(*) AS n FROM workspaces WHERE personal = 0").get() as { n: number }).n),
    pages: Number((sql("SELECT COUNT(*) AS n FROM note_shares WHERE removed_at IS NULL").get() as { n: number }).n),
    ...reportCounts(),
  };
  return (
    <AppShell user={user} section="admin" title={t("admin.title")}>
      <div className="zv-content">
        <div className="zv-actions" style={{ marginBottom: 24 }}>
          <span className="zv-badge">Users: {stats.users}</span>
          <span className="zv-badge">Shared workspaces: {stats.workspaces}</span>
          <span className="zv-badge">Public pages: {stats.pages}</span>
          <span className="zv-badge zv-badge-accent">
            {t("admin.new")}: {stats.new}
          </span>
          <span className="zv-badge">
            {t("admin.done")}: {stats.done}
          </span>
        </div>
        <AdminQueue fresh={listReports("new")} done={listReports("done", 50)} />
      </div>
    </AppShell>
  );
}
