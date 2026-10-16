// Goals from a document: a Docs page (meeting notes, a plan, a brief) becomes
// projects (its goals) with issues (the work under each goal).
//
//   1. readDoc     the lines a person may read: headings, list and checklist
//                  items, short paragraphs (at most 40, 200 characters each);
//   2. classify    Jev decides for each line: a goal, a task, or neither
//                  (rules decide when Jev is off: goal words and headings are
//                  goals, list items are tasks); tasks belong to the goal above;
//   3. create      only what the person ticked: projects for the goals in the
//                  chosen team, issues under them — through the normal
//                  permission-checked write path;
//   4. convert     when the person may edit the page, its task lines are
//                  queued to become live issue blocks: the next editor that
//                  opens the page swaps them (useDocConversions), so the
//                  lines tick themselves as the issues close.
// Lines that already exist as an issue with the same title are marked, so a
// second run does not repeat them.

import { sql, tx } from "../store";
import { ask, choice, type Question } from "../decide/jev";
import { AccessResolver, levelOf } from "../notes/access";
import { inlineText } from "../notes/model";
import { pullNotesById } from "../notes/server-store";
import { jevOn } from "./assist-jev";
import { bad, needs, notFound, type Ctx } from "./core";
import { createIssue } from "./issues";
import { createProject } from "./planning";
import { defaultStatus, statusOfCategory } from "./teams";

const MAX_LINES = 40;
const BLOCK_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NOTE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CONVERSION_TTL = 30 * 86_400_000;
const MAX_CHARS = 200;

export type DocLineKind = "goal" | "task" | "none";

export interface DocLine {
  text: string;
  /** What the line looks like in the document. */
  block: "heading" | "item" | "check" | "text";
  checked?: boolean;
  kind: DocLineKind;
  confidence?: number;
  /** Index of the goal this task belongs to (the nearest goal above). */
  goal?: number;
  /** An issue with this title already exists. */
  exists?: string;
  /** The line's block in the page (it can become a live issue block). */
  blockId?: string;
}

export interface DocPlan {
  note: { id: string; title: string };
  lines: DocLine[];
  source: "jev" | "rules";
}

interface Block {
  id?: unknown;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown[];
}

function linesOf(blocks: unknown, out: Omit<DocLine, "kind">[]): void {
  if (!Array.isArray(blocks)) return;
  for (const raw of blocks) {
    if (out.length >= MAX_LINES) return;
    const b = raw as Block;
    if (!b || typeof b !== "object") continue;
    const text = inlineText(b.content).replace(/\s+/g, " ").trim();
    if (text && [...text].length >= 3) {
      const block = b.type === "heading" ? "heading" : b.type === "checkListItem" ? "check" : b.type === "bulletListItem" || b.type === "numberedListItem" || b.type === "toggleListItem" ? "item" : b.type === "paragraph" ? "text" : null;
      if (block && !(block === "text" && [...text].length > MAX_CHARS))
        out.push({
          text: [...text].slice(0, MAX_CHARS).join(""),
          block,
          ...(block === "check" ? { checked: b.props?.checked === true } : {}),
          ...(typeof b.id === "string" && BLOCK_RE.test(b.id) ? { blockId: b.id } : {}),
        });
    }
    if (Array.isArray(b.children)) linesOf(b.children, out);
  }
}

const GOAL_WORDS = /\b(goal|objective|target|okr|kpi|key result|milestone|launch|reach|grow|increase|reduce|by (?:q[1-4]|end of|january|february|march|april|may|june|july|august|september|october|november|december))\b|цел[ьи]|задача квартала|достичь|увеличить|снизить|запустить|к концу/i;

function byRules(l: Omit<DocLine, "kind">): DocLineKind {
  if (GOAL_WORDS.test(l.text)) return "goal";
  if (l.block === "heading") return "none";
  if (l.block === "check" || l.block === "item") return "task";
  return "none";
}

/** Reads a document the person may open and proposes goals and tasks from it. */
export async function planFromDoc(ctx: Ctx, noteId: unknown): Promise<DocPlan> {
  if (typeof noteId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(noteId)) throw bad("bad document");
  // Documents' own access rules (private pages, teamspaces, invite-only pages).
  if (new AccessResolver(ctx.wsId, ctx.userId).level(noteId) === null) throw notFound("document not found");
  const note = pullNotesById(ctx.wsId, [noteId], ctx.userId).notes[0];
  if (!note) throw notFound("document not found");
  const raw: Omit<DocLine, "kind">[] = [];
  linesOf(note.content, raw);

  let source: DocPlan["source"] = "rules";
  let kinds: { kind: DocLineKind; confidence?: number }[] = raw.map((l) => ({ kind: byRules(l) }));
  if (raw.length && jevOn(ctx.wsId)) {
    const criteria = {
      goal: "An outcome to reach: a goal, objective, target, key result or milestone.",
      task: "A concrete piece of work one person can do.",
      none: "Neither: context, a note, a question, a heading without intent.",
    };
    const questions: Record<string, Question> = {};
    raw.forEach((l, i) => {
      questions[`l${i}`] = choice(`In the document "${note.title.slice(0, 120)}", what is the line: "${l.text}"?`, criteria);
    });
    const out = await ask(ctx.wsId, { document: note.title.slice(0, 120), lines: raw.map((l) => l.text) }, questions);
    if (out) {
      source = "jev";
      const answers = out.answers as Record<string, { choice: string; probabilities: Record<string, number>; confidence: number }>;
      kinds = raw.map((l, i) => {
        const a = answers[`l${i}`];
        if (!a) return { kind: byRules(l) };
        const k = (["goal", "task", "none"].includes(a.choice) ? a.choice : "none") as DocLineKind;
        return { kind: k, confidence: Math.round((a.probabilities[a.choice] ?? a.confidence) * 100) / 100 };
      });
    }
  }
  const titles = raw.map((l) => l.text.toLocaleLowerCase());
  const existing = new Map(
    (
      sql(
        "SELECT lower(i.title) AS t, t.key || '-' || i.number AS ident FROM pj_issues i JOIN pj_teams t ON t.id = i.team_id WHERE i.ws_id = ? AND i.team_id IN (SELECT value FROM json_each(?)) AND lower(i.title) IN (SELECT value FROM json_each(?))"
      ).all(ctx.wsId, JSON.stringify([...ctx.teams()]), JSON.stringify(titles)) as { t: string; ident: string }[]
    ).map((r) => [r.t, r.ident])
  );
  let goal: number | undefined;
  const lines: DocLine[] = raw.map((l, i) => {
    const k = kinds[i];
    const line: DocLine = { ...l, kind: k.kind, ...(k.confidence !== undefined ? { confidence: k.confidence } : {}) };
    if (k.kind === "goal") goal = i;
    else if (k.kind === "task" && goal !== undefined) line.goal = goal;
    const ex = existing.get(l.text.toLocaleLowerCase());
    if (ex) line.exists = ex;
    return line;
  });
  return { note: { id: note.id, title: note.title }, lines, source };
}

/** Creates the ticked goals (projects) and tasks (issues) in a team; queues the task lines of a page the person may edit. */
export function createFromDoc(ctx: Ctx, input: { teamId?: unknown; goals?: unknown; tasks?: unknown; noteId?: unknown }): { projects: string[]; issues: string[]; converting: number } {
  needs(ctx, "edit");
  if (typeof input.teamId !== "string" || !ctx.teams().has(input.teamId)) throw notFound("team not found");
  const teamId = input.teamId;
  const goals = Array.isArray(input.goals) ? input.goals.slice(0, MAX_LINES) : [];
  const tasks = Array.isArray(input.tasks) ? input.tasks.slice(0, MAX_LINES) : [];
  const projects: string[] = [];
  const issues: string[] = [];
  const lines: { blockId: string; issueId: string }[] = [];
  for (const g of goals) {
    const name = typeof (g as { text?: unknown })?.text === "string" ? (g as { text: string }).text.trim().slice(0, 80) : "";
    if (name) projects.push(createProject(ctx, { name, teamIds: [teamId] }).id);
  }
  for (const t of tasks) {
    const x = t as { text?: unknown; goal?: unknown; done?: unknown };
    const title = typeof x.text === "string" ? x.text.trim().slice(0, 300) : "";
    if (!title) continue;
    const g = typeof x.goal === "number" && Number.isInteger(x.goal) ? projects[x.goal] : undefined;
    const statusId = x.done === true ? (statusOfCategory(teamId, "completed") ?? defaultStatus(teamId)) : undefined;
    const id = createIssue(ctx, { teamId, title, ...(g ? { projectId: g } : {}), ...(statusId ? { statusId } : {}) }).id;
    issues.push(id);
    const blockId = (t as { blockId?: unknown }).blockId;
    if (typeof blockId === "string" && BLOCK_RE.test(blockId)) lines.push({ blockId, issueId: id });
  }
  // Only an editor of the page may have its lines swapped (Documents' own access rules).
  const noteId = typeof input.noteId === "string" && NOTE_RE.test(input.noteId) ? input.noteId : null;
  let converting = 0;
  if (noteId && lines.length && canEditNote(ctx, noteId)) {
    // Only lines that are on the page now (the page exists and the block is one of its lines).
    const note = pullNotesById(ctx.wsId, [noteId], ctx.userId).notes[0];
    const onPage: Omit<DocLine, "kind">[] = [];
    if (note) linesOf(note.content, onPage);
    const ids = new Set(onPage.map((l) => l.blockId).filter(Boolean));
    const now = Date.now();
    tx(() => {
      for (const l of lines.filter((x) => ids.has(x.blockId)))
        converting += Number(
          sql("INSERT OR REPLACE INTO pj_doc_conversions (ws_id, note_id, block_id, issue_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(ctx.wsId, noteId, l.blockId, l.issueId, ctx.userId, now).changes
        );
    });
  }
  return { projects, issues, converting };
}

function canEditNote(ctx: Ctx, noteId: string): boolean {
  // A page of this workspace that is not in the trash, and the person may edit it.
  if (!sql("SELECT 1 FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ctx.wsId, noteId)) return false;
  const level = levelOf(ctx.wsId, ctx.userId, noteId);
  return level === "full" || level === "edit";
}

export interface DocConversion {
  blockId: string;
  issueId: string;
  /** KEY-12, what the live block shows while it loads. */
  ident: string;
}

function conversionRows(ctx: Ctx, noteId: string, blockIds?: string[]): DocConversion[] {
  const rows = sql(
    `SELECT c.block_id, c.issue_id, t.key || '-' || i.number AS ident FROM pj_doc_conversions c JOIN pj_issues i ON i.id = c.issue_id JOIN pj_teams t ON t.id = i.team_id
     WHERE c.ws_id = ? AND c.note_id = ? AND c.created_at > ? AND i.team_id IN (SELECT value FROM json_each(?))${blockIds ? " AND c.block_id IN (SELECT value FROM json_each(?))" : ""}`
  ).all(...([ctx.wsId, noteId, Date.now() - CONVERSION_TTL, JSON.stringify([...ctx.teams()]), ...(blockIds ? [JSON.stringify(blockIds)] : [])] as never[])) as {
    block_id: string;
    issue_id: string;
    ident: string;
  }[];
  return rows.map((r) => ({ blockId: r.block_id, issueId: r.issue_id, ident: r.ident }));
}

/** Lines of a page waiting to become live issue blocks (for an editor of the page). */
export function pendingConversions(ctx: Ctx, noteId: unknown): DocConversion[] {
  if (typeof noteId !== "string" || !NOTE_RE.test(noteId) || !canEditNote(ctx, noteId)) return [];
  return conversionRows(ctx, noteId);
}

/** Takes these lines for this editor (one editor swaps each line, even with the page open twice). */
export function claimConversions(ctx: Ctx, noteId: unknown, blockIds: unknown): DocConversion[] {
  needs(ctx, "edit");
  if (typeof noteId !== "string" || !NOTE_RE.test(noteId) || !canEditNote(ctx, noteId)) throw notFound("document not found");
  if (!Array.isArray(blockIds) || blockIds.length > MAX_LINES) throw bad("bad blocks");
  const ids = blockIds.filter((b): b is string => typeof b === "string" && BLOCK_RE.test(b));
  return tx(() => {
    const rows = conversionRows(ctx, noteId, ids);
    for (const r of rows) sql("DELETE FROM pj_doc_conversions WHERE ws_id = ? AND note_id = ? AND block_id = ?").run(ctx.wsId, noteId, r.blockId);
    return rows;
  });
}

/** Queued lines nobody opened the page for in 30 days are forgotten (hourly maintenance). */
export function pruneConversions(now = Date.now()): number {
  return Number(sql("DELETE FROM pj_doc_conversions WHERE created_at <= ?").run(now - CONVERSION_TTL).changes);
}
