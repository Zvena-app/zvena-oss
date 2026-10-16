// Turning one thing into another, and linking things by hand. Server-only.
//
// Every action writes through the product that owns the object, with that
// product's own permission checks (Projects' Ctx, Documents' pushNotes,
// Design as the person), and leaves a link so either side can find the other:
//
//   a line of a document  → an issue            (the issue's description links back)
//   an issue              → a document           (the doc starts with the live issue)
//   an issue              → a design file        (named after the issue)
//   an issue's checkbox   → done / not done      (the issue's workflow, not a copy)

import { canRead } from "../notes/access";
import { ecoText } from "./strings";
import { blankNote, newNoteId, noteSlug } from "../notes/model";
import { pushNotes } from "../notes/server-store";
import { createFile, designConfigured } from "../penpot";
import { syncWorkspaceDesign } from "../design-sync";
import { ctxFor, PjError, type Ctx } from "../projects/core";
import { createIssue, getIssueBrief, updateIssue } from "../projects/issues";
import { getProject, listProjects } from "../projects/planning";
import { defaultStatus, ensureTeam, listStatuses, listTeams, statusOfCategory } from "../projects/teams";
import { payerOf, quotaLeft } from "../storage";
import { sql } from "../store";
import { cardsFor, type Viewer } from "./cards";
import { indexNote } from "./indexer";
import { addLink, linksOf, removeManual } from "./links";
import { parseRefKey, refHref } from "./refs";
import { keyVisible, restricted } from "./visibility";
import type { Card } from "./types";

export class EcoError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

export interface Actor extends Viewer {
  name: string;
  /** The browser tab that asked (its own pulse echo is skipped). */
  origin?: string;
}

function editCtx(a: Actor): Ctx {
  try {
    return ctxFor(a.userId, a.wsId, "edit");
  } catch {
    throw new EcoError(403, "forbidden");
  }
}

/** The team new issues go to: the person's own team, else Projects' first team (made for editors when there is none). */
export function teamFor(ctx: Ctx, locale: string): string {
  const mine = listTeams(ctx).find((t) => t.isMember && !t.archivedAt);
  if (mine) return mine.id;
  try {
    return ensureTeam(ctx, locale).id;
  } catch (e) {
    if (e instanceof PjError && e.status === 403) throw new EcoError(403, "forbidden");
    throw e;
  }
}

/** A project id the person may see, or undefined (a project of private teams only is "not there" for others). */
export function visibleProjectId(ctx: Ctx, id: unknown): string | undefined {
  if (id === undefined || id === null || id === "") return undefined;
  if (typeof id !== "string" || !listProjects(ctx).some((p) => p.id === id)) throw new EcoError(404, "project not found");
  return id;
}

function noteBrief(ws: string, id: string): { title: string } | null {
  const r = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(ws, id) as { json: string | null } | undefined;
  if (!r?.json) return null;
  try {
    const n = JSON.parse(r.json) as { title?: unknown };
    return { title: typeof n.title === "string" ? n.title : "" };
  } catch {
    return null;
  }
}

/** A workspace of one (a freelancer, a person on their own): what they create is theirs to do. */
function alone(ws: string): boolean {
  const r = sql("SELECT COUNT(*) AS n FROM members WHERE ws_id = ?").get(ws) as { n: number };
  return Number(r.n) <= 1;
}

/** Markdown link text: brackets would end it early. */
const mdText = (s: string) => s.replace(/[[\]\\]/g, (c) => `\\${c}`).replace(/\s+/g, " ").trim();

/**
 * A line of a document becomes an issue. The issue's description says where
 * it came from (a link the indexer reads back), and a "converted" link keeps
 * that even if the line is later deleted from the page.
 */
export async function issueFromDoc(a: Actor, input: { note?: unknown; title?: unknown; teamId?: unknown; projectId?: unknown; assigneeId?: unknown; dueDate?: unknown }): Promise<Card> {
  const ctx = editCtx(a);
  const noteId = typeof input.note === "string" ? input.note : "";
  // The person must be able to read the page (Documents' page access) to make an issue from it.
  const note = noteId && canRead(a.wsId, a.userId, noteId) ? noteBrief(a.wsId, noteId) : null;
  if (!note) throw new EcoError(404, "document not found");
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  if (!title) throw new EcoError(400, "title required");
  const teamId = typeof input.teamId === "string" && input.teamId ? input.teamId : teamFor(ctx, a.locale);
  const projectId = visibleProjectId(ctx, input.projectId);
  // A page not every member may open (Private, a closed teamspace, invited people only) is
  // named in the issue by no title: whoever sees the issue does not learn what it is called.
  const open = openToWorkspace(a.wsId, noteId);
  const url = refHref({ kind: "note", id: noteId }, a.wsId, open ? { slug: noteSlug({ id: noteId, title: note.title }) } : {});
  const docTitle = mdText(note.title) || ecoText(a.locale, "untitled");
  const issue = createIssue(ctx, {
    teamId,
    title,
    description: open ? `${ecoText(a.locale, "fromDoc")} [${docTitle}](${url})` : `[${ecoText(a.locale, "fromPrivateDoc")}](${url})`,
    projectId,
    assigneeId: input.assigneeId === "me" ? a.userId : input.assigneeId || (alone(a.wsId) ? a.userId : undefined),
    dueDate: input.dueDate || undefined,
  });
  addLink(a.wsId, `note:${noteId}`, `issue:${issue.id}`, "converted", a.userId, a.origin);
  const [card] = await cardsFor(a, [`issue:${issue.id}`]);
  if (!card) throw new EcoError(500, "not created");
  return card;
}

/** An issue's checkbox wherever it shows: done moves it to the team's first completed status, undone to its first unstarted one. */
export async function setIssueDone(a: Actor, issueId: unknown, done: boolean): Promise<Card> {
  const ctx = editCtx(a);
  if (typeof issueId !== "string") throw new EcoError(400, "bad issue");
  let issue;
  try {
    issue = getIssueBrief(ctx, issueId);
  } catch {
    throw new EcoError(404, "issue not found");
  }
  // Already where the checkbox says (any completed status counts as done): left as it is.
  const category = listStatuses(ctx).find((st) => st.id === issue.statusId)?.category;
  const isDone = category === "completed";
  if (isDone !== done) {
    const statusId = statusOfCategory(issue.teamId, done ? "completed" : "unstarted") ?? defaultStatus(issue.teamId);
    if (statusId !== issue.statusId) updateIssue(ctx, issue.id, { statusId });
  }
  const [card] = await cardsFor(a, [`issue:${issue.id}`]);
  if (!card) throw new EcoError(404, "issue not found");
  return card;
}

const blockId = () => newNoteId().slice(0, 12);

interface Subject {
  key: string;
  title: string;
  /** Issues: KEY-N. */
  ident?: string;
  kind: "issue" | "project";
  id: string;
}

/** The issue or project a document or design is made for, as the person sees it. */
function subjectOf(ctx: Ctx, ref: unknown): Subject {
  const r = parseRefKey(ref);
  if (r?.kind === "issue") {
    try {
      const i = getIssueBrief(ctx, r.id);
      return { key: `issue:${i.id}`, title: i.title, ident: i.identifier, kind: "issue", id: i.id };
    } catch {
      throw new EcoError(404, "issue not found");
    }
  }
  if (r?.kind === "project") {
    try {
      const p = getProject(ctx, r.id);
      return { key: `project:${p.id}`, title: p.name, kind: "project", id: p.id };
    } catch {
      throw new EcoError(404, "project not found");
    }
  }
  throw new EcoError(400, "bad ref");
}

/**
 * A document for an issue (a spec, notes) or a project (its page): it opens
 * with the live issue, or the project's live list of issues, and the issue
 * or project lists it.
 */
export async function docFor(a: Actor, ref: unknown): Promise<{ noteId: string; url: string }> {
  // An editor of the workspace (editCtx) may create its shared pages, where the team sees the
  // new document (Documents' access: a top-level page with no section is the workspace's).
  const ctx = editCtx(a);
  const s = subjectOf(ctx, ref);
  // Made already (a second click, another tab): the person gets that document, not a copy.
  for (const l of linksOf(a.wsId, s.key)) {
    if (l.via !== "converted" || !l.dst.startsWith("note:")) continue;
    const id = l.dst.slice(5);
    const row = sql("SELECT json FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(a.wsId, id) as { json: string | null } | undefined;
    let existing: { title?: string; trashedAt?: number | null } | null = null;
    try {
      existing = row?.json ? (JSON.parse(row.json) as { title?: string; trashedAt?: number | null }) : null;
    } catch {
      existing = null;
    }
    if (existing && !existing.trashedAt && canRead(a.wsId, a.userId, id)) return { noteId: id, url: refHref({ kind: "note", id }, a.wsId, { slug: noteSlug({ id, title: existing.title ?? "" }) }) };
  }
  const head =
    s.kind === "issue"
      ? { id: blockId(), type: "issue", props: { issueId: s.id, ident: s.ident ?? "" }, children: [] }
      : { id: blockId(), type: "issues", props: { projectId: s.id, scope: "project" }, children: [] };
  // A private team's issue or project gets a document in its maker's Private section, never a
  // workspace page: the rest of the workspace must not learn its title. They can share it from there.
  const note = blankNote({
    kind: "page",
    title: s.title,
    content: [head, { id: blockId(), type: "paragraph", props: {}, content: [], children: [] }],
    ...(restricted(a.wsId, s.key) ? { space: `private:${a.userId}` } : {}),
  });
  const payer = payerOf(a.wsId);
  const left = payer ? await quotaLeft(payer) : 0;
  const res = pushNotes(a.wsId, [{ id: note.id, note }], { by: a.userId, quotaLeft: left, author: a.name, origin: a.origin });
  if (!res.saved?.includes(note.id)) throw new EcoError(507, "not saved");
  indexNote(a.wsId, note.id);
  addLink(a.wsId, s.key, `note:${note.id}`, "converted", a.userId, a.origin);
  return { noteId: note.id, url: refHref({ kind: "note", id: note.id }, a.wsId, { slug: noteSlug(note) }) };
}

/** A design file for an issue or a project, named after it; the issue or project lists it. */
export async function designFor(a: Actor, ref: unknown): Promise<{ file: string; url: string }> {
  const ctx = editCtx(a);
  const s = subjectOf(ctx, ref);
  if (!designConfigured()) throw new EcoError(503, "design off");
  let teamId: string | null = null;
  try {
    teamId = await syncWorkspaceDesign(a.wsId);
  } catch {
    teamId = null;
  }
  if (!teamId) throw new EcoError(503, "design unavailable");
  // Design files are seen by the whole workspace's Design team: a private team's issue or
  // project lends its file no name (the link keeps them together).
  const name = restricted(a.wsId, s.key) ? ecoText(a.locale, "untitled") : (s.ident ? `${s.ident} ${s.title}` : s.title).slice(0, 120);
  const f = await createFile(a.userId, teamId, name);
  addLink(a.wsId, s.key, `design:${f.fileId}`, "converted", a.userId, a.origin);
  return { file: f.fileId, url: refHref({ kind: "design", file: f.fileId }, a.wsId) };
}

export const docForIssue = (a: Actor, issueId: unknown) => docFor(a, typeof issueId === "string" ? `issue:${issueId}` : null);
export const designForIssue = (a: Actor, issueId: unknown) => designFor(a, typeof issueId === "string" ? `issue:${issueId}` : null);

/** Links two objects by hand; both must exist and be visible to the person. */
export async function link(a: Actor, src: unknown, dst: unknown): Promise<boolean> {
  const s = parseRefKey(src);
  const d = parseRefKey(dst);
  if (!s || !d || src === dst) throw new EcoError(400, "bad refs");
  const cards = await cardsFor(a, [src as string, dst as string]);
  if (cards.length < 2) throw new EcoError(404, "not found");
  return addLink(a.wsId, src as string, dst as string, "manual", a.userId, a.origin);
}

/**
 * May every member of the workspace open this page? Not when it sits in someone's Private
 * section or a teamspace that is not open, or under a page shared with invited people only.
 */
function openToWorkspace(ws: string, noteId: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = noteId;
  let space: string | null = null;
  while (cur && !seen.has(cur) && seen.size < 100) {
    seen.add(cur);
    if ((sql("SELECT restricted FROM note_access WHERE ws = ? AND note_id = ?").get(ws, cur) as { restricted: number } | undefined)?.restricted) return false;
    const r = sql("SELECT parent_id, space FROM notes WHERE ws = ? AND id = ?").get(ws, cur) as { parent_id: string | null; space: string | null } | undefined;
    if (!r) return false;
    space = r.space;
    cur = r.parent_id;
  }
  if (!space) return true;
  if (space.startsWith("private:")) return false;
  if (space.startsWith("ts:")) {
    const ts = sql("SELECT privacy FROM teamspaces WHERE id = ? AND ws = ?").get(space.slice(3), ws) as { privacy: string } | undefined;
    return !ts || ts.privacy === "open";
  }
  return true;
}

export function unlink(a: Actor, src: unknown, dst: unknown): boolean {
  if (!parseRefKey(src) || !parseRefKey(dst)) throw new EcoError(400, "bad refs");
  // Only between things the person may know of (an object that is gone tells nothing).
  if (!keyVisible(a.userId, a.wsId, src as string) || !keyVisible(a.userId, a.wsId, dst as string)) throw new EcoError(404, "not found");
  return removeManual(a.wsId, src as string, dst as string, a.userId, a.origin);
}
