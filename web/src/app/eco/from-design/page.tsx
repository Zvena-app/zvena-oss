import type { Metadata } from "next";
import { AppShell } from "@/components/zvena/AppShell";
import { FromDesignForm } from "@/components/eco/FromDesignForm";
import { ecoText as et } from "@/lib/eco/strings";
import { CardView } from "@/components/eco/CardView";
import { commentThread, issueOfThread, wsOfTeam } from "@/lib/eco/design";
import { requireUser } from "@/lib/page";
import { ctxFor } from "@/lib/projects/core";
import { listProjects } from "@/lib/projects/planning";
import { listTeams } from "@/lib/projects/teams";
import { sql } from "@/lib/store";

export const metadata: Metadata = { title: "New issue from a design comment", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ team?: string; ws?: string; thread?: string; file?: string; frame?: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Design's "Create issue in zvena" on a comment thread opens this page:
//   /eco/from-design?team=<Design team>&thread=<thread>[&file&frame]
// The thread is read from Design as the signed-in person; nothing is created
// until they confirm.
export default async function FromDesignPage({ searchParams }: Props) {
  const sp = await searchParams;
  const want = sp.ws || wsOfTeam(sp.team);
  const query = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string"));
  const { user, locale } = await requireUser(`/eco/from-design?${query}`, want);
  const ws = user.ws;
  const thread = sp.thread && UUID.test(sp.thread) ? await commentThread(user.id, sp.thread) : null;
  const team = (sql("SELECT penpot_team_id FROM workspaces WHERE id = ?").get(ws.id) as { penpot_team_id: string | null } | undefined)?.penpot_team_id;
  const ok = thread && thread.teamId === team;
  let teams: { id: string; name: string }[] = [];
  let projects: { id: string; name: string }[] = [];
  try {
    const ctx = ctxFor(user.id, ws.id, "read");
    teams = listTeams(ctx)
      .filter((t) => !t.archivedAt)
      .sort((a, b) => Number(b.isMember) - Number(a.isMember))
      .map((t) => ({ id: t.id, name: t.name }));
    projects = listProjects(ctx)
      .filter((p) => p.state !== "completed" && p.state !== "canceled")
      .map((p) => ({ id: p.id, name: p.name }));
  } catch {
    // Not allowed to read Projects here: the form says so when sent.
  }
  const file = thread?.fileId ?? (sp.file && UUID.test(sp.file) ? sp.file : "");
  const frame = thread?.frameId ?? (sp.frame && UUID.test(sp.frame) ? sp.frame : "");
  const back = file ? `/design?ws=${encodeURIComponent(ws.id)}&file=${file}${frame ? `&frame=${frame}` : ""}` : `/design?ws=${encodeURIComponent(ws.id)}`;
  const said = ok ? thread.comments.map((c) => c.content.trim()).filter(Boolean) : [];
  // Made into an issue before: that issue, not a second one.
  const made = ok ? await issueOfThread({ userId: user.id, wsId: ws.id, locale, name: user.name }, thread.id) : null;
  return (
    <AppShell user={user} section="projects">
      <div className="zv-content zv-content-narrow">
        <h1 className="zv-page-title">{et(locale, "fromDesign")}</h1>
        <p className="zv-page-lead">{et(locale, frame ? "fromDesignLead" : "fromDesignLeadFile")}</p>
        {made ? (
          <div className="eco-root" style={{ display: "grid", gap: 16 }}>
            <p className="zv-banner">{et(locale, "alreadyIssue")}</p>
            <CardView card={made} variant="block" />
            <div className="zv-actions">
              <a className="zv-btn zv-btn-primary" href={made.url}>
                {et(locale, "issueOpen")}
              </a>
              <a className="zv-btn" href={back}>
                {et(locale, "backToDesign")}
              </a>
            </div>
          </div>
        ) : ok ? (
          <FromDesignForm
            ws={ws.id}
            thread={thread.id}
            title={(said[0] ?? "").split("\n")[0].slice(0, 300)}
            quote={said.join("\n\n").slice(0, 4000)}
            where={[thread.fileName, thread.frameName].filter(Boolean).join(" · ")}
            back={back}
            teams={teams}
            projects={projects}
          />
        ) : (
          <div className="zv-empty">
            {et(locale, "commentMissing")}{" "}
            <a href={back}>{et(locale, "backToDesign")}</a>
          </div>
        )}
      </div>
    </AppShell>
  );
}
