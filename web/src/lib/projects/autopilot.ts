// The autopilot in Projects: the decision model (src/lib/decide/smart.ts) looks at
// every new issue and comment and does what a careful teammate would.
//
// On a new issue it decides, in one call:
//   - priority (a score, low → urgent), the label (a choice among the team's
//     labels), the project (a choice among the team's active projects);
//   - whom to call: the assignee (a choice among the team's members, each
//     described only by what they recently worked on — never by name);
//   - whether it duplicates an open issue (a choice among similar ones the
//     full-text index found).
// On a new comment: does it say the work is finished?
//
// What happens with an answer depends on its confidence and on the stakes:
//   - empty priority / label / project, confidence ≥ AUTO: filled in at once,
//     marked "Automation" in the history (on behalf of the issue's author), with Undo;
//   - otherwise, or for anything a person would notice — the assignee, a
//     duplicate, closing the issue — a suggestion one click accepts;
//   - it never overwrites what a person set, never deletes, never closes.
//
// It runs when the server has the model and the workspace did not turn it off; when
// the model is slow, down or unsure nothing happens (the issue is already saved).

import { sql } from "../store";
import { ask, choice, noul, score, type ChoiceQ, type Question } from "../decide/smart";
import { smartOn } from "./assist-smart";
import { bad, bump, ctxFor, emit, needs, notFound, pid, visibleIssue, type Ctx } from "./core";
import { notify } from "./effects";
import { onChange, type PjChange } from "./events";
import { ftsQuery, getIssueBrief, issueDescription, issueRefs, updateIssue } from "./issues";
import { plainText } from "./markdown";
import { listProjects } from "./planning";
import { addRelation } from "./social";
import { listLabels, listTeams, statusOfCategory } from "./teams";
import type { Issue, Priority, Suggestion, SuggestionKind } from "./types";

/** Fill an empty field at once from this confidence (a project needs a bit more). */
export const AUTO = 0.8;
export const AUTO_PROJECT = 0.85;
/** Show a suggestion from this confidence. */
export const SUGGEST = 0.6;
/** A duplicate is suggested from this confidence. */
export const DUPLICATE = 0.7;

// Score levels low → urgent (the model's level index → Projects' priority).
const LEVELS: Priority[] = [4, 3, 2, 1];
const MAX_OPTIONS = 12;

// --- Wiring ----------------------------------------------------------------------

/** At most this many autopilot calls to the model per workspace and hour (mass-created issues stop costing). */
export const HOURLY_LIMIT = 300;

const BUDGET = Symbol.for("zvena.projects.autopilot.budget");
const gb = globalThis as unknown as Record<symbol, Map<string, { hour: number; n: number }> | undefined>;
const budget = (gb[BUDGET] ??= new Map());

/** Takes one call from the workspace's hourly budget; false when it is spent. */
export function spend(ws: string, now = Date.now()): boolean {
  const hour = Math.floor(now / 3_600_000);
  const b = budget.get(ws);
  if (!b || b.hour !== hour) {
    if (budget.size > 10_000) budget.clear();
    budget.set(ws, { hour, n: 1 });
    return true;
  }
  if (b.n >= HOURLY_LIMIT) return false;
  b.n++;
  return true;
}

const KEY = Symbol.for("zvena.projects.autopilot");
const g = globalThis as unknown as Record<symbol, { off: () => void; running: Set<Promise<unknown>> } | undefined>;

/** Starts listening to Projects' changes (once per process; instrumentation and the API both call it). */
export function startAutopilot(): void {
  if (g[KEY]) return;
  const running = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    running.add(p);
    void p.finally(() => running.delete(p));
  };
  const off = onChange((c) => {
    if (!c.created || c.quiet || c.via || c.deleted) return;
    if (c.entity === "issue") track(afterIssueCreated(c).catch(() => undefined));
    else if (c.entity === "comment" && c.issueId) track(afterCommentCreated(c).catch(() => undefined));
  });
  g[KEY] = { off, running };
}

/** Test hook: wait until the autopilot finished what it started. */
export async function autopilotIdle(): Promise<void> {
  const st = g[KEY];
  // Change events run after the current stack; give them a turn first.
  await new Promise((r) => setImmediate(r));
  while (st && st.running.size) await Promise.all([...st.running]);
}

/** Acting automatically on the person's behalf (their rights; the history says "Automation"). */
function autoCtx(userId: string, ws: string): Ctx | null {
  try {
    return { ...ctxFor(userId, ws, "edit"), via: "auto" };
  } catch {
    return null;
  }
}

// --- Similar issues (duplicates) ---------------------------------------------------

interface Candidate {
  id: string;
  identifier: string;
  title: string;
  snippet: string;
}

/** Open issues whose text shares words with this one (any of them), best first. */
function candidates(ctx: Ctx, text: string, exclude: string | null, limit = 5): Candidate[] {
  const words = [...new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].sort((a, b) => b.length - a.length).slice(0, 8);
  if (!words.length) return [];
  const q = words.map((w) => ftsQuery(w)).filter(Boolean).join(" OR ");
  if (!q) return [];
  const rows = sql(
    `SELECT i.id, t.key, i.number, i.title, snippet(pj_issues_fts, 1, '', '', '…', 16) AS snippet
       FROM pj_issues_fts JOIN pj_issues i ON i.fts_id = pj_issues_fts.rowid JOIN pj_teams t ON t.id = i.team_id JOIN pj_statuses s ON s.id = i.status_id
      WHERE pj_issues_fts MATCH ? AND i.ws_id = ? AND i.team_id IN (SELECT value FROM json_each(?)) AND i.archived_at IS NULL
        AND s.category NOT IN ('completed', 'canceled') AND i.id <> ?
      ORDER BY bm25(pj_issues_fts, 10.0, 1.0) LIMIT ?`
  ).all(q, ctx.wsId, JSON.stringify([...ctx.teams()]), exclude ?? "", limit) as { id: string; key: string; number: number; title: string; snippet: string | null }[];
  return rows.map((r) => ({ id: r.id, identifier: `${r.key}-${r.number}`, title: r.title, snippet: r.snippet ?? "" }));
}

function duplicateQuestion(list: Candidate[]): { q: ChoiceQ; keys: Map<string, string> } {
  const criteria: Record<string, string> = { none: "None of these: the new issue is about something else." };
  const keys = new Map<string, string>();
  list.forEach((c, i) => {
    criteria[`d${i}`] = `${c.title}${c.snippet ? ` — ${c.snippet.slice(0, 200)}` : ""}`;
    keys.set(`d${i}`, c.id);
  });
  return { q: choice("Which existing issue describes the same problem or request as the new issue?", criteria), keys };
}

/**
 * Issues that may already describe this one, for the create dialog as one
 * types. The full-text index finds them; the model (when on) says which one is the
 * same and how sure it is.
 */
export async function similarIssues(ctx: Ctx, input: { title: string; description?: string; excludeId?: string | null }): Promise<{ issues: (Candidate & { confidence?: number })[]; source: "model" | "rules" }> {
  const title = input.title.trim().slice(0, 300);
  if ([...title].length < 6) return { issues: [], source: "rules" };
  const list = candidates(ctx, title, input.excludeId ?? null, 5);
  if (!list.length || !smartOn(ctx.wsId) || !spend(ctx.wsId)) return { issues: list.slice(0, 3), source: "rules" };
  const { q, keys } = duplicateQuestion(list);
  const out = await ask(ctx.wsId, { title, description: plainText(input.description ?? "", 1000) }, { same: q });
  if (!out) return { issues: list.slice(0, 3), source: "rules" };
  const a = out.answers.same;
  const best = keys.get(a.choice);
  const conf = a.probabilities[a.choice] ?? a.confidence;
  if (!best || conf < DUPLICATE) return { issues: [], source: "model" };
  const hit = list.find((c) => c.id === best) as Candidate;
  return { issues: [{ ...hit, confidence: conf }], source: "model" };
}

// --- A new issue ----------------------------------------------------------------------

function memberCriteria(ctx: Ctx, teamId: string): { criteria: Record<string, string>; keys: Map<string, string> } | null {
  const team = listTeams(ctx).find((x) => x.id === teamId);
  if (!team || !team.members.length) return null;
  const criteria: Record<string, string> = { none: "Nobody in particular; leave it unassigned." };
  const keys = new Map<string, string>();
  team.members.slice(0, MAX_OPTIONS).forEach((m, i) => {
    // Only people who can take an issue (editors); the model never sees their names, only what they work on.
    if (!sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ? AND role IN ('owner', 'editor')").get(ctx.wsId, m.userId)) return;
    const recent = (sql("SELECT title FROM pj_issues WHERE team_id = ? AND assignee_id = ? ORDER BY updated_at DESC LIMIT 3").all(teamId, m.userId) as { title: string }[]).map((r) => r.title.slice(0, 80));
    const who = `Teammate ${i + 1}${m.role === "lead" ? " (team lead)" : ""}`;
    criteria[`p${i}`] = recent.length ? `${who} — recently worked on: ${recent.join("; ")}` : `${who} — nothing assigned yet`;
    keys.set(`p${i}`, m.userId);
  });
  return keys.size ? { criteria, keys } : null;
}

/**
 * A new issue: one question about its empty fields. `again`: whether a title or description
 * changed while the question was out is asked about once more (the second round does not).
 */
async function afterIssueCreated(c: PjChange, again = true): Promise<void> {
  if (!smartOn(c.ws)) return;
  const ctx = autoCtx(c.by, c.ws);
  if (!ctx) return;
  let issue: Issue;
  try {
    issue = getIssueBrief(ctx, c.id);
  } catch {
    return;
  }
  const description = issueDescription(ctx, issue.id);
  const questions: Record<string, Question> = {};
  const maps: Record<string, Map<string, string>> = {};

  if (issue.priority === 0)
    questions.priority = score("How urgent is this issue for the team that owns it? Judge by user impact, who is blocked and deadlines in the text.", [
      "Low: nice to have; nobody is blocked.",
      "Medium: normal work for an upcoming cycle.",
      "High: important; affects many users or blocks other work.",
      "Urgent: production is down, data is lost, a security hole, or a deadline today.",
    ]);
  if (!issue.labelIds.length) {
    const labels = listLabels(ctx)
      .filter((l) => !l.isGroup && (!l.teamId || l.teamId === issue.teamId))
      .slice(0, MAX_OPTIONS);
    if (labels.length) {
      const criteria: Record<string, string> = { none: "None of these labels fits." };
      maps.label = new Map();
      labels.forEach((l, i) => {
        criteria[`l${i}`] = l.description ? `${l.name}: ${l.description.slice(0, 160)}` : l.name;
        maps.label.set(`l${i}`, l.id);
      });
      questions.label = choice("What kind of issue is this? Pick the team's label that fits it best.", criteria);
    }
  }
  if (!issue.projectId) {
    const projects = listProjects(ctx)
      .filter((p) => p.teamIds.includes(issue.teamId) && !["completed", "canceled"].includes(p.state))
      .slice(0, MAX_OPTIONS);
    if (projects.length) {
      const criteria: Record<string, string> = { none: "It belongs to none of these projects." };
      maps.project = new Map();
      projects.forEach((p, i) => {
        const about = p.summary;
        criteria[`j${i}`] = about ? `${p.name}: ${about.slice(0, 160)}` : p.name;
        maps.project.set(`j${i}`, p.id);
      });
      questions.project = choice("Which of the team's projects does this issue belong to?", criteria);
    }
  }
  if (!issue.assigneeId) {
    const m = memberCriteria(ctx, issue.teamId);
    if (m) {
      maps.assignee = m.keys;
      questions.assignee = choice("Who on the team is the best person to handle this issue?", m.criteria);
    }
  }
  const dupes = candidates(ctx, `${issue.title} ${plainText(description, 300)}`, issue.id, 5);
  if (dupes.length) {
    const d = duplicateQuestion(dupes);
    maps.duplicate = d.keys;
    questions.duplicate = d.q;
  }
  if (!Object.keys(questions).length || !spend(c.ws)) return;

  const out = await ask(c.ws, { title: issue.title, description: plainText(description, 2000) }, questions);
  if (!out) return;
  // The answer is about the text as it was sent: changed meanwhile, it is not used (the new
  // text is asked about once more), as for goals (lib/decide/autogoal.ts).
  let after: Issue;
  try {
    after = getIssueBrief(ctx, issue.id);
  } catch {
    return;
  }
  if (after.title !== issue.title || issueDescription(ctx, issue.id) !== description) {
    if (again) await afterIssueCreated(c, false);
    return;
  }
  const answers = out.answers as Record<string, { type: string; score?: number; choice?: string; probabilities: Record<string, number>; confidence: number }>;
  const made: string[] = [];
  const now = Date.now();
  const save = (kind: SuggestionKind, value: Record<string, unknown>, conf: number, state: "open" | "applied", prev: Record<string, unknown> | null = null) => {
    sql("INSERT INTO pj_suggestions (id, ws_id, issue_id, kind, value, prev, confidence, model, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      pid(),
      ctx.wsId,
      issue.id,
      kind,
      JSON.stringify(value),
      prev ? JSON.stringify(prev) : null,
      Math.round(conf * 1000) / 1000,
      out.model,
      state,
      now
    );
    made.push(kind);
  };
  // The person may have changed the issue while the question was out: re-read before filling.
  const fresh = () => getIssueBrief(ctx, issue.id);

  const p = answers.priority;
  if (p && typeof p.score === "number") {
    const level = Math.round(p.score);
    const conf = p.probabilities[String(level)] ?? p.confidence;
    const priority = LEVELS[level];
    if (priority && conf >= AUTO && fresh().priority === 0) {
      updateIssue(ctx, issue.id, { priority });
      save("priority", { priority }, conf, "applied", { priority: 0 });
    } else if (priority && conf >= SUGGEST) save("priority", { priority }, conf, "open");
  }
  const pick = (name: string): { id: string; conf: number } | null => {
    const a = answers[name];
    if (!a || typeof a.choice !== "string" || a.choice === "none") return null;
    const id = maps[name]?.get(a.choice);
    const conf = a.probabilities[a.choice] ?? a.confidence;
    return id ? { id, conf } : null;
  };
  const label = pick("label");
  if (label) {
    if (label.conf >= AUTO && !fresh().labelIds.length) {
      updateIssue(ctx, issue.id, { addLabelIds: [label.id] });
      save("label", { labelId: label.id }, label.conf, "applied", { labelIds: [] });
    } else if (label.conf >= SUGGEST) save("label", { labelId: label.id }, label.conf, "open");
  }
  const project = pick("project");
  if (project) {
    if (project.conf >= AUTO_PROJECT && !fresh().projectId) {
      updateIssue(ctx, issue.id, { projectId: project.id });
      save("project", { projectId: project.id }, project.conf, "applied", { projectId: null });
    } else if (project.conf >= SUGGEST) save("project", { projectId: project.id }, project.conf, "open");
  }
  const who = pick("assignee");
  if (who && who.conf >= SUGGEST && !fresh().assigneeId) save("assignee", { userId: who.id }, who.conf, "open");
  const dup = pick("duplicate");
  if (dup && dup.conf >= DUPLICATE) {
    save("duplicate", { issueId: dup.id }, dup.conf, "open");
    const team = issue.teamId;
    notify(ctx, c.by, "duplicate", { issueId: issue.id, teamId: team }, { of: dup.id, confidence: Math.round(dup.conf * 100) }, { selfOk: true });
  }
  if (made.length) {
    bump(ctx.wsId);
    emit(ctx, "issue", issue.id);
  }
}

// --- A new comment ----------------------------------------------------------------

async function afterCommentCreated(c: PjChange): Promise<void> {
  if (!smartOn(c.ws) || !c.issueId) return;
  let ctx: Ctx;
  try {
    ctx = { ...ctxFor(c.by, c.ws, "read"), via: "auto" };
  } catch {
    return;
  }
  const row = sql("SELECT i.id, i.team_id, i.title, s.category FROM pj_issues i JOIN pj_statuses s ON s.id = i.status_id WHERE i.id = ? AND i.ws_id = ?").get(c.issueId, c.ws) as
    | { id: string; team_id: string; title: string; category: string }
    | undefined;
  if (!row || !visibleIssue(ctx, row.id) || row.category === "completed" || row.category === "canceled") return;
  if (sql("SELECT 1 FROM pj_suggestions WHERE issue_id = ? AND kind = 'done' AND state = 'open'").get(row.id)) return;
  const body = sql("SELECT body FROM pj_comments WHERE id = ? AND ws_id = ?").get(c.id, c.ws) as { body: string } | undefined;
  if (!body) return;
  const text = plainText(body.body, 1000);
  if ([...text].length < 4) return;
  const statusId = statusOfCategory(row.team_id, "completed");
  if (!statusId || !spend(c.ws)) return;
  const out = await ask(c.ws, { issue: row.title, comment: text }, { done: noul("Does the comment say that the work described in the issue is finished — done, fixed, shipped or merged?") });
  if (!out) return;
  const p = out.answers.done.noul;
  if (p < AUTO) return;
  sql("INSERT INTO pj_suggestions (id, ws_id, issue_id, kind, value, prev, confidence, model, state, created_at) VALUES (?, ?, ?, 'done', ?, NULL, ?, ?, 'open', ?)").run(
    pid(),
    c.ws,
    row.id,
    JSON.stringify({ statusId, commentId: c.id }),
    Math.round(p * 1000) / 1000,
    out.model,
    Date.now()
  );
  bump(c.ws);
  emit(ctx, "issue", row.id);
}

// --- Reading and resolving -----------------------------------------------------------

interface SuggestionRow {
  id: string;
  issue_id: string;
  kind: SuggestionKind;
  value: string;
  prev: string | null;
  confidence: number;
  model: string;
  state: Suggestion["state"];
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

const KEEP_APPLIED_MS = 7 * 86_400_000;

/** What is suggested on an issue, and what was filled in automatically lately (with Undo). Only what this person may see. */
export function suggestionsOf(ctx: Ctx, issueId: string): Suggestion[] {
  if (!visibleIssue(ctx, issueId)) return [];
  const rows = sql("SELECT * FROM pj_suggestions WHERE issue_id = ? AND ws_id = ? AND (state = 'open' OR (state = 'applied' AND created_at > ?)) ORDER BY created_at").all(
    issueId,
    ctx.wsId,
    Date.now() - KEEP_APPLIED_MS
  ) as unknown as SuggestionRow[];
  const dupIds = rows.filter((r) => r.kind === "duplicate").map((r) => String((JSON.parse(r.value) as { issueId?: string }).issueId ?? ""));
  const refs = dupIds.length ? issueRefs(ctx, dupIds) : new Map();
  const out: Suggestion[] = [];
  for (const r of rows) {
    const value = JSON.parse(r.value) as Suggestion["value"];
    if (r.kind === "duplicate") {
      const ref = refs.get(value.issueId as string);
      if (!ref) continue; // the original is not visible to this person
      value.identifier = ref.identifier;
      value.title = ref.title;
    }
    out.push({ id: r.id, issueId: r.issue_id, kind: r.kind, value, confidence: r.confidence, state: r.state, createdAt: r.created_at });
  }
  return out;
}

/** A person accepts, dismisses, or undoes (an automatic change) one of the suggestions — with their own rights. */
export function resolveSuggestion(ctx: Ctx, id: string, action: unknown): Suggestion[] {
  needs(ctx, "edit");
  if (action !== "accept" && action !== "dismiss" && action !== "undo") throw bad("bad action");
  const r = sql("SELECT * FROM pj_suggestions WHERE id = ? AND ws_id = ?").get(id, ctx.wsId) as unknown as SuggestionRow | undefined;
  if (!r || !visibleIssue(ctx, r.issue_id)) throw notFound("suggestion not found");
  const v = JSON.parse(r.value) as Record<string, unknown>;
  const now = Date.now();
  const close = (state: Suggestion["state"]) => sql("UPDATE pj_suggestions SET state = ?, resolved_at = ?, resolved_by = ? WHERE id = ?").run(state, now, ctx.userId, id);
  if (action === "dismiss") {
    if (r.state !== "open") throw bad("not open");
    close("dismissed");
  } else if (action === "accept") {
    if (r.state !== "open") throw bad("not open");
    switch (r.kind) {
      case "priority":
        updateIssue(ctx, r.issue_id, { priority: v.priority });
        break;
      case "label":
        updateIssue(ctx, r.issue_id, { addLabelIds: [v.labelId] });
        break;
      case "project":
        updateIssue(ctx, r.issue_id, { projectId: v.projectId });
        break;
      case "assignee":
        updateIssue(ctx, r.issue_id, { assigneeId: v.userId });
        break;
      case "done":
        updateIssue(ctx, r.issue_id, { statusId: v.statusId });
        break;
      case "duplicate": {
        // The relation closes it in the team's Duplicate status (social.ts).
        addRelation(ctx, r.issue_id, { type: "duplicate", relatedId: v.issueId });
        break;
      }
    }
    close("accepted");
  } else {
    if (r.state !== "applied") throw bad("not applied");
    const cur = getIssueBrief(ctx, r.issue_id);
    const prev = r.prev ? (JSON.parse(r.prev) as Record<string, unknown>) : {};
    // Undo only what is still the automation's: a person's later change stays.
    if (r.kind === "priority" && cur.priority === v.priority) updateIssue(ctx, r.issue_id, { priority: prev.priority ?? 0 });
    if (r.kind === "label" && cur.labelIds.includes(String(v.labelId))) updateIssue(ctx, r.issue_id, { removeLabelIds: [v.labelId] });
    if (r.kind === "project" && cur.projectId === v.projectId) updateIssue(ctx, r.issue_id, { projectId: prev.projectId ?? null });
    close("undone");
  }
  bump(ctx.wsId);
  emit(ctx, "issue", r.issue_id);
  return suggestionsOf(ctx, r.issue_id);
}

/** Suggestions are kept 90 days; open ones too (an old suggestion is no longer useful). */
export const SUGGESTION_DAYS = 90;

export function pruneSuggestions(now = Date.now()): number {
  return Number(sql("DELETE FROM pj_suggestions WHERE created_at < ?").run(now - SUGGESTION_DAYS * 86_400_000).changes);
}
