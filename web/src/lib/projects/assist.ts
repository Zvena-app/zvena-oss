// The assistant of Projects ("Помощник").
//
// No generative model (README, scripts/check-no-ai.mjs): no text-writing
// provider, SDK or key, and the CSP lets the browser talk to zvena only.
// Every action here is computed from the workspace's own data by explicit
// rules — reproducible, explainable, and never sent anywhere:
//
//   describe     a structured description template from a short request
//   breakdown    sub-issues from the description's list / checklist items
//   digest       an extractive digest of a long discussion (decisions, open questions)
//   triage       priority and labels suggested by keywords and label names
//   projectUpdate a status update draft from the project's real numbers
//   blockers     what blocks a project / cycle from finishing (open blockers, chains)
//   cycleReport  a cycle summary: scope, done, carry-over, per person
//   stale        overdue issues and issues stuck in progress
//   parseQuery   a natural-language request ("мои срочные баги") into a filter
//
// Nothing here changes data: actions return proposals; the browser shows
// them and applies the accepted ones through the normal, permission-checked
// API (bulk changes ask for confirmation first).
//
// One exception is Jev, zvena's sanctioned decision model (src/lib/decide/jev.ts):
// when the server has it and the workspace owner turned it on, triage asks it
// first (assist-jev.ts) and falls back to the rules here. A generative model
// could sit behind `AssistProvider`; none is wired (`provider()` is null).

import { sql } from "../store";
import { needs, notFound, type Ctx } from "./core";
import { issueState, queryIssues } from "./issues";
import { listItems, plainText } from "./markdown";
import { getProject, getCycle, listProjects } from "./planning";
import { commentsOf } from "./social";
import { listLabels } from "./teams";
import { dayOf, daysBetween, type Health, type IssueFilter, type Priority, type StatusCategory } from "./types";
import { projText, type ProjKey } from "./strings";

/** A generative backend (not configured in zvena; kept as the one seam for it). */
export interface AssistProvider {
  name: string;
  complete(prompt: string, opts: { maxChars: number }): Promise<string>;
}

export function provider(): AssistProvider | null {
  return null;
}

/** The interface language (any of zvena's): what Jev writes is in it. */
type Lang = string;

/** A case-insensitive pattern where \b and \w also work for Cyrillic. */
function R(src: string, flags = "iu"): RegExp {
  return new RegExp(src.replaceAll("\\b", "(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))").replaceAll("\\w", "[\\p{L}\\p{N}_]"), flags);
}

// --- describe ------------------------------------------------------------------

export function describe(request: string, lang: Lang): { title: string; description: string } {
  const text = request.trim().replace(/\s+/g, " ").slice(0, 500);
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const title = (first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first).replace(/[.!?]+$/, "");
  const isBug = R(String.raw`\b(ошибк|баг|падает|не работает|сломал|crash|bug|broken|error|fails?)\w*`).test(text);
  const w = (k: ProjKey) => projText(lang, k);
  const sections = isBug
    ? [`## ${w("jev.bug.happens")}`, text, `## ${w("jev.bug.steps")}`, "1. ", `## ${w("jev.bug.expected")}`, "", `## ${w("jev.bug.env")}`, `- ${w("jev.bug.device")}: `, `## ${w("jev.doneWhen")}`, `- [ ] ${w("jev.bug.gone")}`, `- [ ] ${w("jev.bug.test")}`]
    : [`## ${w("jev.task.context")}`, text, `## ${w("jev.task.goal")}`, "", `## ${w("jev.task.tasks")}`, "- [ ] ", `## ${w("jev.doneWhen")}`, "- [ ] ", `## ${w("jev.task.outOfScope")}`, "- "];
  return { title, description: sections.join("\n\n") };
}

// --- breakdown -----------------------------------------------------------------

export function breakdown(ctx: Ctx, issueId: string): { items: { title: string; done: boolean }[]; existing: string[] } {
  const st = issueState(ctx, issueId);
  const existing = (
    sql("SELECT title FROM pj_issues WHERE parent_id = ? AND ws_id = ? AND team_id IN (SELECT value FROM json_each(?))").all(issueId, ctx.wsId, JSON.stringify([...ctx.teams()])) as { title: string }[]
  ).map((r) => r.title);
  const have = new Set(existing.map((t) => t.toLocaleLowerCase()));
  const items = listItems(st.description)
    .filter((i) => !have.has(i.text.toLocaleLowerCase()))
    .slice(0, 50)
    .map((i) => ({ title: i.text.slice(0, 300), done: i.done }));
  return { items, existing };
}

// --- digest --------------------------------------------------------------------

const DECISION_RE = R(String.raw`(решил[иа]?|договорил|итог|решение|согласовал|делаем|не делаем|decided|decision|agreed|let's go with|we will|conclusion|resolved)`);
const ACTION_RE = R(String.raw`(нужно|надо|сделаю|возьму|todo|to do|will do|i'll|action item|next step|следующ\w* шаг)`);

export function digest(ctx: Ctx, issueId: string): {
  comments: number;
  participants: { userId: string | null; comments: number }[];
  decisions: { commentId: string; authorId: string | null; text: string }[];
  questions: { commentId: string; authorId: string | null; text: string }[];
  actions: { commentId: string; authorId: string | null; text: string }[];
  latest: { commentId: string; authorId: string | null; text: string } | null;
  span: { from: number; to: number } | null;
} {
  issueState(ctx, issueId);
  const comments = commentsOf(issueId);
  const by = new Map<string | null, number>();
  const decisions: { commentId: string; authorId: string | null; text: string }[] = [];
  const questions: typeof decisions = [];
  const actions: typeof decisions = [];
  for (const c of comments) {
    by.set(c.authorId, (by.get(c.authorId) ?? 0) + 1);
    const sentences = plainText(c.body, 4000).split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      const text = s.trim().slice(0, 240);
      if (!text) continue;
      if (DECISION_RE.test(text)) decisions.push({ commentId: c.id, authorId: c.authorId, text });
      else if (text.endsWith("?")) questions.push({ commentId: c.id, authorId: c.authorId, text });
      else if (ACTION_RE.test(text)) actions.push({ commentId: c.id, authorId: c.authorId, text });
    }
  }
  // A question answered by a later comment of someone else is no longer open.
  const open = questions.filter((q) => {
    const at = comments.findIndex((c) => c.id === q.commentId);
    return !comments.slice(at + 1).some((c) => c.authorId !== q.authorId);
  });
  const last = comments[comments.length - 1];
  return {
    comments: comments.length,
    participants: [...by.entries()].map(([userId, n]) => ({ userId, comments: n })).sort((a, b) => b.comments - a.comments),
    decisions: decisions.slice(-8),
    questions: open.slice(-8),
    actions: actions.slice(-8),
    latest: last ? { commentId: last.id, authorId: last.authorId, text: plainText(last.body, 300) } : null,
    span: comments.length ? { from: comments[0].createdAt, to: last.createdAt } : null,
  };
}

// --- triage --------------------------------------------------------------------

const PRIORITY_RULES: [RegExp, Priority, string][] = [
  [R(String.raw`(срочн|критич|блокер|прод(?:е|уктив)\w* (?:упал|лежит)|не работает вход|утечк|security|urgent|critical|outage|data loss|asap|blocker|p0)`), 1, "urgent"],
  [R(String.raw`(падает|ошибк|сломал|не открывается|не сохраня|crash|broken|fails?|error|regression|регресс|bug|баг|times? out|timeout|таймаут|зависа|не отвечает|hangs?)`), 2, "high"],
  [R(String.raw`(улучш|оптимиз|медленн|неудобн|improve|slow|optimi[sz]e|refactor|рефактор)`), 3, "medium"],
  [R(String.raw`(опечат|косметич|выравнив|цвет|typo|cosmetic|nice to have|polish|мелоч)`), 4, "low"],
];

const LABEL_HINTS: Record<string, RegExp> = {
  bug: R(String.raw`(ошибк|баг|падает|сломал|не работает|зависа|таймаут|crash|bug|broken|error|regression|fails?|times? out|timeout)`),
  feature: R(String.raw`(добавить|нов\w* функц|возможност|feature|^add\b|add support|implement|new)`),
  improvement: R(String.raw`(улучш|оптимиз|ускор|improve|optimi[sz]e|speed up|polish)`),
  design: R(String.raw`(дизайн|макет|ui|ux|интерфейс|design|layout|mockup)`),
  docs: R(String.raw`(документац|readme|инструкц|docs?|documentation|guide)`),
  performance: R(String.raw`(медленн|производительн|тормоз|slow|performance|latency)`),
  security: R(String.raw`(безопасн|уязвим|xss|csrf|injection|security|vulnerab)`),
};

const LABEL_ALIASES: Record<string, string[]> = {
  bug: ["bug", "баг", "ошибка", "дефект"],
  feature: ["feature", "фича", "функция", "новое"],
  improvement: ["improvement", "улучшение"],
  design: ["design", "дизайн", "ui", "ux"],
  docs: ["docs", "documentation", "документация"],
  performance: ["performance", "производительность", "perf"],
  security: ["security", "безопасность"],
};

export function triage(ctx: Ctx, input: { title: string; description: string; teamId?: string | null }): {
  priority: Priority | null;
  priorityReason: string | null;
  labels: { id: string; reason: string }[];
} {
  const text = `${input.title}\n${plainText(input.description, 4000)}`;
  let priority: Priority | null = null;
  let priorityReason: string | null = null;
  for (const [re, p] of PRIORITY_RULES) {
    const m = re.exec(text);
    if (m) {
      priority = p;
      priorityReason = m[0];
      break;
    }
  }
  const labels: { id: string; reason: string }[] = [];
  const lower = text.toLocaleLowerCase();
  for (const l of listLabels(ctx)) {
    if (l.isGroup || (l.teamId && input.teamId && l.teamId !== input.teamId)) continue;
    const name = l.name.toLocaleLowerCase();
    // The label's own name in the text, or a known synonym group with a keyword hit.
    if (name.length >= 3 && lower.includes(name)) {
      labels.push({ id: l.id, reason: l.name });
      continue;
    }
    for (const [hint, re] of Object.entries(LABEL_HINTS)) {
      if (LABEL_ALIASES[hint].includes(name)) {
        const m = re.exec(text);
        if (m) {
          labels.push({ id: l.id, reason: m[0] });
          break;
        }
      }
    }
  }
  return { priority, priorityReason, labels: labels.slice(0, 5) };
}

// --- project update ------------------------------------------------------------

export function projectUpdate(ctx: Ctx, projectId: string, lang: Lang): { health: Health; body: string; facts: Record<string, number | string | null> } {
  needs(ctx, "read");
  const p = getProject(ctx, projectId);
  const visible = JSON.stringify([...ctx.teams()]);
  const now = Date.now();
  const week = now - 7 * 86_400_000;
  const today = dayOf(now);
  const rows = sql(
    `SELECT i.id, i.title, t.key || '-' || i.number AS ident, s.category, i.completed_at, i.due_date, i.assignee_id,
       (SELECT COUNT(*) FROM pj_issue_relations r JOIN pj_issues b ON b.id = r.issue_id JOIN pj_statuses bs ON bs.id = b.status_id
         WHERE r.related_id = i.id AND r.type = 'blocks' AND bs.category NOT IN ('completed', 'canceled') AND b.team_id IN (SELECT value FROM json_each(?2))) AS blockers
     FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id JOIN pj_statuses s ON s.id = i.status_id
     WHERE i.project_id = ?1 AND i.archived_at IS NULL AND i.team_id IN (SELECT value FROM json_each(?2))`
  ).all(projectId, visible) as { id: string; title: string; ident: string; category: StatusCategory; completed_at: number | null; due_date: string | null; assignee_id: string | null; blockers: number }[];
  const live = rows.filter((r) => r.category !== "canceled");
  const done = live.filter((r) => r.category === "completed");
  const doneWeek = done.filter((r) => (r.completed_at ?? 0) >= week);
  const inProgress = live.filter((r) => r.category === "started");
  const overdue = live.filter((r) => r.category !== "completed" && r.due_date && r.due_date < today);
  const blocked = live.filter((r) => r.category !== "completed" && Number(r.blockers) > 0);
  const pct = live.length ? Math.round((done.length / live.length) * 100) : 0;
  // Health: behind schedule when the elapsed share of time outruns the done share.
  let health: Health = "on_track";
  if (p.targetDate) {
    const start = p.startDate ?? dayOf(p.createdAt);
    const total = Math.max(1, daysBetween(start, p.targetDate));
    const elapsed = Math.min(1, Math.max(0, daysBetween(start, today) / total));
    const gap = elapsed * 100 - pct;
    if (today > p.targetDate && pct < 100) health = "off_track";
    else if (gap > 35) health = "off_track";
    else if (gap > 15 || blocked.length > 0) health = "at_risk";
  } else if (blocked.length > 2 || overdue.length > 2) health = "at_risk";
  const w = (k: ProjKey, vars?: Record<string, string | number>) => projText(lang, k, vars);
  const list = (items: typeof rows) => items.slice(0, 6).map((r) => `- ${r.ident} ${r.title}`).join("\n");
  const parts = [
    w("jev.upd.progress", { pct, done: done.length, total: live.length }),
    p.targetDate ? w("jev.upd.target", { date: p.targetDate }) : "",
    doneWeek.length ? `**${w("jev.upd.doneWeek")}** (${doneWeek.length}):\n${list(doneWeek)}` : w("jev.upd.noneWeek"),
    inProgress.length ? `**${w("jev.upd.inProgress")}** (${inProgress.length}):\n${list(inProgress)}` : "",
    blocked.length ? `**${w("jev.upd.blocked")}** (${blocked.length}):\n${list(blocked)}` : "",
    overdue.length ? `**${w("jev.upd.overdue")}** (${overdue.length}):\n${list(overdue)}` : "",
  ].filter(Boolean);
  return {
    health,
    body: parts.join("\n\n"),
    facts: { progress: pct, total: live.length, done: done.length, doneWeek: doneWeek.length, inProgress: inProgress.length, blocked: blocked.length, overdue: overdue.length, target: p.targetDate },
  };
}

// --- blockers ------------------------------------------------------------------

export function blockers(ctx: Ctx, scope: { projectId?: string; cycleId?: string }): {
  open: number;
  blocked: { issue: { id: string; identifier: string; title: string }; by: { id: string; identifier: string; title: string; status: string; assigneeId: string | null; outside: boolean }[] }[];
  roots: { id: string; identifier: string; title: string; blocks: number; assigneeId: string | null }[];
} {
  if (!scope.projectId && !scope.cycleId) throw notFound();
  if (scope.projectId) getProject(ctx, scope.projectId);
  if (scope.cycleId) getCycle(ctx, scope.cycleId);
  const visible = JSON.stringify([...ctx.teams()]);
  const where = scope.projectId ? "i.project_id = ?" : "i.cycle_id = ?";
  const open = sql(
    `SELECT i.id, t.key || '-' || i.number AS ident, i.title FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id JOIN pj_statuses s ON s.id = i.status_id
     WHERE ${where} AND i.archived_at IS NULL AND s.category NOT IN ('completed', 'canceled') AND i.team_id IN (SELECT value FROM json_each(?))`
  ).all(scope.projectId ?? scope.cycleId ?? "", visible) as { id: string; ident: string; title: string }[];
  const inScope = new Set(open.map((o) => o.id));
  const blocked: ReturnType<typeof blockers>["blocked"] = [];
  const rootCount = new Map<string, { id: string; identifier: string; title: string; blocks: number; assigneeId: string | null }>();
  for (const o of open) {
    const by = sql(
      `SELECT b.id, t.key || '-' || b.number AS ident, b.title, s.name AS status, b.assignee_id FROM pj_issue_relations r JOIN pj_issues b ON b.id = r.issue_id
       JOIN pj_teams t ON t.id = b.team_id JOIN pj_statuses s ON s.id = b.status_id
       WHERE r.related_id = ? AND r.type = 'blocks' AND b.archived_at IS NULL AND s.category NOT IN ('completed', 'canceled') AND b.team_id IN (SELECT value FROM json_each(?))`
    ).all(o.id, visible) as { id: string; ident: string; title: string; status: string; assignee_id: string | null }[];
    if (!by.length) continue;
    blocked.push({
      issue: { id: o.id, identifier: o.ident, title: o.title },
      by: by.map((b) => ({ id: b.id, identifier: b.ident, title: b.title, status: b.status, assigneeId: b.assignee_id, outside: !inScope.has(b.id) })),
    });
    for (const b of by) {
      const e = rootCount.get(b.id) ?? { id: b.id, identifier: b.ident, title: b.title, blocks: 0, assigneeId: b.assignee_id };
      e.blocks++;
      rootCount.set(b.id, e);
    }
  }
  return { open: open.length, blocked, roots: [...rootCount.values()].sort((a, b) => b.blocks - a.blocks).slice(0, 10) };
}

// --- cycle report --------------------------------------------------------------

export function cycleReport(ctx: Ctx, cycleId: string, lang: Lang): { text: string; facts: Record<string, number | string> } {
  const c = getCycle(ctx, cycleId);
  const today = dayOf(Date.now());
  const days = Math.max(1, daysBetween(c.startsOn, c.endsOn) + 1);
  const passed = Math.min(days, Math.max(0, daysBetween(c.startsOn, today) + 1));
  const pct = c.progress.total ? Math.round((c.progress.completed / c.progress.total) * 100) : 0;
  const added = c.burnup.length ? c.burnup[c.burnup.length - 1].scope - c.burnup[0].scope : 0;
  const w = (k: ProjKey, vars?: Record<string, string | number>) => projText(lang, k, vars);
  const lines = [
    w(c.name ? "jev.cyc.headNamed" : "jev.cyc.head", { n: c.number, name: c.name ?? "", from: c.startsOn, to: c.endsOn, passed, days }),
    w("jev.cyc.done", { done: c.progress.completed, total: c.progress.total, pct, started: c.progress.started }),
    c.progress.points ? w("jev.cyc.points", { done: c.progress.pointsDone, total: c.progress.points }) : "",
    added > 0 ? w("jev.cyc.added", { n: added }) : "",
    c.summary ? w("jev.cyc.completed", { carried: c.summary.carriedOver, canceled: c.summary.canceled }) : passed / days > pct / 100 + 0.25 ? w("jev.cyc.behind") : "",
  ].filter(Boolean);
  return { text: lines.join("\n"), facts: { total: c.progress.total, completed: c.progress.completed, started: c.progress.started, pct, passed, days, added } };
}

// --- stale and overdue ---------------------------------------------------------

export function stale(ctx: Ctx, opts: { days?: number; today?: string } = {}): {
  overdue: { id: string; identifier: string; title: string; dueDate: string; assigneeId: string | null; days: number }[];
  stuck: { id: string; identifier: string; title: string; assigneeId: string | null; days: number }[];
  unassignedUrgent: { id: string; identifier: string; title: string }[];
} {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const today = opts.today ?? dayOf(Date.now());
  const visible = JSON.stringify([...ctx.teams()]);
  const base = "FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id JOIN pj_statuses s ON s.id = i.status_id WHERE i.ws_id = ? AND i.archived_at IS NULL AND i.team_id IN (SELECT value FROM json_each(?))";
  const overdue = (
    sql(`SELECT i.id, t.key || '-' || i.number AS ident, i.title, i.due_date, i.assignee_id ${base} AND i.due_date < ? AND s.category NOT IN ('completed', 'canceled') ORDER BY i.due_date LIMIT 100`).all(
      ctx.wsId,
      visible,
      today
    ) as { id: string; ident: string; title: string; due_date: string; assignee_id: string | null }[]
  ).map((r) => ({ id: r.id, identifier: r.ident, title: r.title, dueDate: r.due_date, assigneeId: r.assignee_id, days: daysBetween(r.due_date, today) }));
  const cutoff = Date.now() - days * 86_400_000;
  const stuck = (
    sql(`SELECT i.id, t.key || '-' || i.number AS ident, i.title, i.assignee_id, i.updated_at, i.status_changed_at ${base} AND s.category = 'started' AND i.updated_at < ? ORDER BY i.updated_at LIMIT 100`).all(
      ctx.wsId,
      visible,
      cutoff
    ) as { id: string; ident: string; title: string; assignee_id: string | null; updated_at: number }[]
  ).map((r) => ({ id: r.id, identifier: r.ident, title: r.title, assigneeId: r.assignee_id, days: Math.floor((Date.now() - r.updated_at) / 86_400_000) }));
  const unassignedUrgent = (
    sql(`SELECT i.id, t.key || '-' || i.number AS ident, i.title ${base} AND i.priority = 1 AND i.assignee_id IS NULL AND s.category NOT IN ('completed', 'canceled') LIMIT 50`).all(ctx.wsId, visible) as {
      id: string;
      ident: string;
      title: string;
    }[]
  ).map((r) => ({ id: r.id, identifier: r.ident, title: r.title }));
  return { overdue, stuck, unassignedUrgent };
}

// --- natural language → filter -------------------------------------------------

export interface ParsedQuery {
  filter: IssueFilter;
  /** The words that were understood, for the UI to show what was applied. */
  matched: string[];
  /** What was left (used as a text search). */
  rest: string;
}

const STATUS_WORDS: [RegExp, StatusCategory[]][] = [
  [R(String.raw`\b(в работе|в процессе|начат\w*|in progress|started|active|doing)\b`), ["started"]],
  [R(String.raw`\b(не начат\w*|к выполнению|todo|to do|unstarted)\b`), ["unstarted"]],
  [R(String.raw`\b(бэклог\w*|backlog)\b`), ["backlog"]],
  [R(String.raw`\b(готов\w*|сделан\w*|выполнен\w*|закрыт\w*|завершен\w*|завершён\w*|done|completed|closed|finished)\b`), ["completed"]],
  [R(String.raw`\b(отменен\w*|отменён\w*|canceled|cancelled)\b`), ["canceled"]],
  [R(String.raw`\b(открыт\w*|незакрыт\w*|open|unfinished|незавершен\w*|незавершён\w*)\b`), ["backlog", "unstarted", "started"]],
];

const PRIORITY_WORDS: [RegExp, Priority[]][] = [
  [R(String.raw`\b(срочн\w*|urgent|критичн\w*|critical)\b`), [1]],
  [R(String.raw`\b(высок\w* приоритет\w*|важн\w*|high priority|high|important)\b`), [2]],
  [R(String.raw`\b(средн\w* приоритет\w*|medium)\b`), [3]],
  [R(String.raw`\b(низк\w* приоритет\w*|неважн\w*|low priority|low)\b`), [4]],
  [R(String.raw`\b(без приоритета|no priority)\b`), [0]],
];

/** Russian word forms: a stem match against label/project/team names. */
function stem(s: string): string {
  const w = s.toLocaleLowerCase();
  return w.length > 5 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, w.length - 1) : w;
}

export function parseQuery(ctx: Ctx, input: string): ParsedQuery {
  let text = ` ${input.trim().slice(0, 300)} `;
  const f: IssueFilter = {};
  const matched: string[] = [];
  const take = (re: RegExp, apply: (m: RegExpExecArray) => void) => {
    const m = re.exec(text);
    if (!m) return false;
    apply(m);
    matched.push(m[0].trim());
    text = text.replace(m[0], " ");
    return true;
  };
  take(R(String.raw`\b(мои|мне|моих|назначенн\w* на меня|assigned to me|my|mine)\b`), () => (f.assignee = ["me"]));
  take(R(String.raw`\b(без исполнителя|не назначен\w*|никому не назначен\w*|unassigned|no assignee)\b`), () => (f.assignee = ["none"]));
  take(R(String.raw`\b(созданн\w* мной|я создал\w*|created by me)\b`), () => (f.creator = ["me"]));
  for (const [re, cats] of STATUS_WORDS) if (take(re, () => (f.category = [...new Set([...(f.category ?? []), ...cats])]))) break;
  for (const [re, p] of PRIORITY_WORDS) if (take(re, () => (f.priority = [...new Set([...(f.priority ?? []), ...p])]))) break;
  take(R(String.raw`\b(просрочен\w*|overdue|late)\b`), () => (f.due = "overdue"));
  take(R(String.raw`\b(срок сегодня|due today|на сегодня)\b`), () => (f.due = "today"));
  take(R(String.raw`\b(на этой неделе|на неделю|this week|due this week)\b`), () => (f.due = "week"));
  take(R(String.raw`\b(в этом месяце|this month)\b`), () => (f.due = "month"));
  take(R(String.raw`\b(без срока|no due date)\b`), () => (f.due = "none"));
  take(R(String.raw`\b(заблокированн\w*|blocked)\b`), () => (f.blocked = true));
  take(R(String.raw`\b(блокирующ\w*|blocking)\b`), () => (f.blocking = true));
  take(R(String.raw`\b(текущ\w* цикл\w*|в цикле|current cycle|this cycle)\b`), () => (f.cycle = ["current"]));
  take(R(String.raw`\b(без проекта|no project)\b`), () => (f.project = ["none"]));
  take(R(String.raw`\b(обновлённ\w*|обновленн\w*|изменённ\w*|updated) (?:за|в|this|last)? ?(день|сегодня|неделю|week|месяц|month|day|today)\b`), (m) => {
    f.updated = R(String.raw`нед|week`).test(m[2]) ? "week" : R(String.raw`мес|month`).test(m[2]) ? "month" : "day";
  });
  take(R(String.raw`\b(созданн\w*|новые|created) (?:за|в|this|last)? ?(день|сегодня|неделю|week|месяц|month|day|today)\b`), (m) => {
    f.created = R(String.raw`нед|week`).test(m[2]) ? "week" : R(String.raw`мес|month`).test(m[2]) ? "month" : "day";
  });
  // Names of people, labels, projects and teams.
  const words = text.split(/[\s,.;:!?«»"()]+/).filter((w) => w.length >= 3);
  const stems = new Set(words.map(stem));
  const hit = (name: string) => {
    const parts = name.toLocaleLowerCase().split(/\s+/).filter((p) => p.length >= 3);
    return parts.length > 0 && parts.every((p) => stems.has(stem(p)) || words.some((w) => w.toLocaleLowerCase() === p));
  };
  const dropWords = (name: string) => {
    for (const p of name.toLocaleLowerCase().split(/\s+/)) text = text.replace(new RegExp(`\\S*${p.slice(0, Math.max(3, p.length - 2)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\S*`, "i"), " ");
  };
  for (const l of listLabels(ctx)) {
    if (l.isGroup) continue;
    if (hit(l.name)) {
      f.label = [...(f.label ?? []), l.id];
      matched.push(l.name);
      dropWords(l.name);
    }
  }
  // "баги" → a label named "Баг" by stem; English plurals too.
  const people = sql("SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.ws_id = ?").all(ctx.wsId) as { id: string; name: string }[];
  for (const p of people) {
    const first = p.name.split(/\s+/)[0];
    if (first && first.length >= 3 && stems.has(stem(first)) && !f.assignee) {
      f.assignee = [p.id];
      matched.push(p.name);
      dropWords(first);
    }
  }
  const projects = listProjects(ctx).map((p) => ({ id: p.id, name: p.name }));
  for (const p of projects) {
    if (hit(p.name)) {
      f.project = [...(f.project ?? []).filter((x) => x !== "none"), p.id];
      matched.push(p.name);
      dropWords(p.name);
    }
  }
  const teams = sql("SELECT id, key, name FROM pj_teams WHERE ws_id = ? AND id IN (SELECT value FROM json_each(?))").all(ctx.wsId, JSON.stringify([...ctx.teams()])) as { id: string; key: string; name: string }[];
  for (const t of teams) {
    const keyRe = new RegExp(`\\b${t.key}\\b`);
    if (keyRe.test(text) || hit(t.name)) {
      f.team = [...(f.team ?? []), t.id];
      matched.push(t.name);
      text = text.replace(keyRe, " ");
      dropWords(t.name);
    }
  }
  const filler = R(String.raw`\b(задач\w*|issues?|tasks?|все|всё|all|show|покажи|найди|find|с|со|и|в|на|по|для|that|the|with|and|in|of|for|которые|где|есть)\b`, "giu");
  const rest = text.replace(filler, " ").replace(/\s+/g, " ").trim();
  if (rest && rest.length >= 3) f.q = rest;
  return { filter: f, matched, rest };
}

/** Issues of a parsed query (a preview before the filter is applied). */
export function previewQuery(ctx: Ctx, filter: IssueFilter, today?: string): number {
  return queryIssues(ctx, { filter, display: { group: "none", completed: "all" }, limit: 1, today }).total;
}
