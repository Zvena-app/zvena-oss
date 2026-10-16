// Projects in the account's data export (/api/export): everything the person
// can see in a workspace — teams and their workflows, labels, projects with
// updates and milestones, cycles, and every issue with its comments,
// relations and history — as one JSON file per workspace, plus the issues
// as CSV for spreadsheets.

import { sql } from "../store";
import { ctxFor } from "./core";
import { commentsOf, activityOf, relationsOf, attachmentsOf } from "./social";
import { fieldValues, issuesByIds, queryIssues } from "./issues";
import { listCycles, listProjects, projectUpdates } from "./planning";
import { listFields, listLabels, listStatuses, listTeams } from "./teams";
import { people } from "./workspace";

export function exportProjects(userId: string, wsId: string): { json: string; csv: string } | null {
  let ctx;
  try {
    ctx = ctxFor(userId, wsId, "read");
  } catch {
    return null;
  }
  const teams = listTeams(ctx);
  if (!teams.length) return null;
  const ids = (sql("SELECT id FROM pj_issues WHERE ws_id = ? AND team_id IN (SELECT value FROM json_each(?)) ORDER BY team_id, number").all(wsId, JSON.stringify([...ctx.teams()])) as { id: string }[]).map(
    (r) => r.id
  );
  const issues = [];
  for (let i = 0; i < ids.length; i += 200) {
    for (const it of issuesByIds(ctx, ids.slice(i, i + 200))) {
      const description = (sql("SELECT description FROM pj_issues WHERE id = ?").get(it.id) as { description: string }).description;
      issues.push({
        ...it,
        description,
        comments: commentsOf(it.id),
        relations: relationsOf(ctx, it.id),
        history: activityOf(ctx, it.id, 10_000),
        attachments: attachmentsOf(ctx, it.id).map((a) => ({ name: a.name, bytes: a.bytes, createdAt: a.createdAt })),
        fields: fieldValues(it.id),
      });
    }
  }
  const projects = listProjects(ctx).concat(listProjects(ctx, { archived: true })).map((p) => ({ ...p, updates: projectUpdates(ctx, p.id) }));
  const data = {
    format: "zvena-projects/1",
    exportedAt: new Date().toISOString(),
    people: people(ctx).map((p) => ({ id: p.id, name: p.name })),
    teams,
    statuses: listStatuses(ctx),
    labels: listLabels(ctx),
    fields: listFields(ctx),
    projects,
    cycles: listCycles(ctx),
    issues,
  };
  const status = new Map(data.statuses.map((s) => [s.id, s.name]));
  const project = new Map(projects.map((p) => [p.id, p.name]));
  const person = new Map(data.people.map((p) => [p.id, p.name]));
  const label = new Map(data.labels.map((l) => [l.id, l.name]));
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // A leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["id", "title", "status", "priority", "assignee", "project", "labels", "due", "estimate", "created", "updated", "completed"];
  const rows = issues.map((i) =>
    [
      i.identifier,
      i.title,
      status.get(i.statusId),
      i.priority,
      i.assigneeId ? person.get(i.assigneeId) : "",
      i.projectId ? project.get(i.projectId) : "",
      i.labelIds.map((l) => label.get(l)).join(", "),
      i.dueDate,
      i.estimate,
      new Date(i.createdAt).toISOString(),
      new Date(i.updatedAt).toISOString(),
      i.completedAt ? new Date(i.completedAt).toISOString() : "",
    ]
      .map(cell)
      .join(",")
  );
  return { json: JSON.stringify(data, null, 1), csv: [head.join(","), ...rows].join("\n") };
}

/** Open issues assigned to the person (the zvena home page), most urgent first. */
export function myOpenIssues(userId: string, wsId: string, limit = 6): { identifier: string; title: string; priority: number; dueDate: string | null; status: string; category: string; color: string }[] {
  let ctx;
  try {
    ctx = ctxFor(userId, wsId, "read");
  } catch {
    return [];
  }
  const page = queryIssues(ctx, { filter: { assignee: ["me"], category: ["unstarted", "started"] }, display: { group: "none", order: "priority", subIssues: true }, limit });
  const st = new Map(listStatuses(ctx).map((s) => [s.id, s]));
  return (page.groups[0]?.items ?? []).map((i) => ({
    identifier: i.identifier,
    title: i.title,
    priority: i.priority,
    dueDate: i.dueDate,
    status: st.get(i.statusId)?.name ?? "",
    category: st.get(i.statusId)?.category ?? "unstarted",
    color: st.get(i.statusId)?.color ?? "#95a2b3",
  }));
}
