import type { Metadata } from "next";
import { FileText } from "lucide-react";
import { AppShell } from "@/components/zvena/AppShell";
import { AccessResolver } from "@/lib/notes/access";
import { displayTitle, noteSlug } from "@/lib/notes/model";
import type { Note } from "@/lib/notes/types";
import { notesT, type NotesKey } from "@/lib/notes/i18n";
import { pageLocale, requireUser } from "@/lib/page";
import { sql } from "@/lib/store";

export async function generateMetadata(): Promise<Metadata> {
  return { title: notesT(await pageLocale(), "dsgn.docsTitle"), robots: { index: false, follow: false } };
}

type Props = { searchParams: Promise<{ file?: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The documents (in the person's workspaces) that show a design — the link
// from a design back to its documents (Design's menu → "Documents with this design").
export default async function DesignLinksPage({ searchParams }: Props) {
  const sp = await searchParams;
  const file = typeof sp.file === "string" && UUID_RE.test(sp.file) ? sp.file : "";
  const { user, locale } = await requireUser(`/design-links${file ? `?file=${file}` : ""}`);
  const t = (k: NotesKey) => notesT(locale, k);
  const rows = file
    ? (sql(
        `SELECT n.ws, n.json, w.name AS ws_name FROM notes n
           JOIN members m ON m.ws_id = n.ws AND m.user_id = ?
           JOIN workspaces w ON w.id = n.ws
          WHERE n.deleted = 0 AND n.json LIKE ?
          LIMIT 200`
      ).all(user.id, `%"fileId":"${file}"%`) as { ws: string; json: string; ws_name: string }[])
    : [];
  const resolvers = new Map<string, AccessResolver>();
  const readable = (ws: string, id: string) => {
    if (!resolvers.has(ws)) resolvers.set(ws, new AccessResolver(ws, user.id));
    return (resolvers.get(ws) as AccessResolver).level(id) !== null;
  };
  const docs = rows
    .map((r) => {
      try {
        const n = JSON.parse(r.json) as Note;
        // Only pages the person may open (not someone else's Private or a restricted page).
        return n.trashedAt === null && readable(r.ws, n.id) ? { n, ws: r.ws, wsName: r.ws_name } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { n: Note; ws: string; wsName: string } => x !== null);
  return (
    <AppShell user={user} section="docs">
      <div className="zv-content zv-content-narrow">
        <h1 className="zv-page-title">{t("dsgn.docsTitle")}</h1>
        <p className="zv-page-lead">{t("dsgn.docsLead")}</p>
        {docs.length === 0 ? (
          <div className="zv-empty">{t("dsgn.docsEmpty")}</div>
        ) : (
          <div className="zv-card">
            <div className="zv-list">
              {docs.map(({ n, ws, wsName }) => (
                <a key={`${ws}-${n.id}`} className="zv-row" href={`/docs?ws=${encodeURIComponent(ws)}#${noteSlug(n)}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <FileText size={18} color="var(--zv-text-3)" />
                  <div className="zv-row-main">
                    <div className="zv-row-title">{displayTitle(n, t("page.untitled"))}</div>
                    <div className="zv-row-sub">{wsName}</div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
