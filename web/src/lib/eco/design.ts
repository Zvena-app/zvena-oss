// The ecosystem's side of Design. Server-only.
//
// Design (the Penpot fork) answers through its management API as the person
// (their technical login), so it decides what they may read:
//
//   comment-thread  { email, threadId } → one comment thread: where it is
//                   (file, page, frame) and what was said
//   file-comments   { email, fileId }   → every thread of a file, for links
//
//   resolve-comment-thread { email, threadId, resolved } → the thread resolved or reopened, as the person
//
// From those: a comment becomes an issue (`issueFromComment`, once per thread),
// closing that issue resolves the thread (`followIssueForThread`), people
// mentioned in a Design comment hear it in their Inbox (`designMentions`), and
// links written in comments ("see /projects/issue/ZVN-12") become links of
// the frame they sit on (`indexDesignFile`, on every "design" poke).

import { ctxFor } from "../projects/core";
import { createIssue, getIssueBrief } from "../projects/issues";
import { listStatuses } from "../projects/teams";
import { designConfigured, designLogin, userIdOfLogin } from "../penpot";
import { notify } from "./inbox";
import { ecoDb } from "./schema";
import { sql } from "../store";
import { EcoError, teamFor, visibleProjectId, type Actor } from "./actions";
import { cardsFor } from "./cards";
import { ecoText } from "./strings";
import { refsInMarkdown } from "./extract";
import { origins, resolveTargets, systemCtx } from "./indexer";
import { addLink, dropParts, linksOf, setDerived, type DerivedVia } from "./links";
import { isUuid, refKey, type Ref } from "./refs";
import type { Card } from "./types";

export interface DesignComment {
  id: string;
  content: string;
  /** The author's technical login (u-<id>@…), when known. */
  author?: string | null;
  createdAt?: string | number | null;
}

export interface DesignThread {
  id: string;
  fileId: string;
  pageId?: string | null;
  frameId?: string | null;
  fileName?: string | null;
  frameName?: string | null;
  teamId?: string | null;
  /** Resolved in Design (from Design builds that say; older ones leave it out). */
  isResolved?: boolean;
  comments: DesignComment[];
}

async function mgmt<T>(action: string, body: Record<string, unknown>): Promise<T | null> {
  if (!designConfigured()) return null;
  const base = (process.env.PENPOT_MGMT_URL || "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/management/zvena/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-shared-key": process.env.PENPOT_MGMT_KEY || "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function wsTeam(ws: string): string | null {
  return (sql("SELECT penpot_team_id FROM workspaces WHERE id = ?").get(ws) as { penpot_team_id: string | null } | undefined)?.penpot_team_id ?? null;
}

/** The workspace whose Design team is `team` (Design's own requests name the team). */
export function wsOfTeam(team: string | null | undefined): string | null {
  if (!isUuid(team)) return null;
  return (sql("SELECT id FROM workspaces WHERE penpot_team_id = ?").get(team) as { id: string } | undefined)?.id ?? null;
}

/** One comment thread, as the person sees it (null: no such thread, or not theirs to read, or Design is off). */
export async function commentThread(userId: string, threadId: string): Promise<DesignThread | null> {
  if (!isUuid(threadId)) return null;
  return mgmt<DesignThread>("comment-thread", { email: designLogin(userId), threadId });
}

/** Markdown-inert text: what a comment says can never become a link, an image or a mention. */
const inert = (s: string) => s.replace(/[\\[\]()<>!*_`#|~]/g, (c) => `\\${c}`);

const quote = (s: string) =>
  s
    .split("\n")
    .map((l) => `> ${inert(l)}`)
    .join("\n");

/**
 * A comment on a design becomes an issue: the comment is quoted in it, the
 * frame (or file) is linked both ways, and the issue lists the design.
 */
/** The issue a thread already became, as the person sees it (null: none yet, or not theirs to see). */
export async function issueOfThread(a: Actor, threadId: string): Promise<Card | null> {
  ecoDb();
  const row = sql("SELECT issue_id FROM eco_design_threads WHERE ws_id = ? AND thread_id = ?").get(a.wsId, threadId) as { issue_id: string } | undefined;
  if (!row) return null;
  const [card] = await cardsFor(a, [`issue:${row.issue_id}`]);
  return card ?? null;
}

export async function issueFromComment(a: Actor, input: { thread?: unknown; title?: unknown; teamId?: unknown; projectId?: unknown }): Promise<Card> {
  const thread = typeof input.thread === "string" ? await commentThread(a.userId, input.thread) : null;
  if (!thread) throw new EcoError(404, "comment not found");
  // Only a design of this workspace.
  if (!thread.teamId || thread.teamId !== wsTeam(a.wsId)) throw new EcoError(404, "comment not found");
  let ctx;
  try {
    ctx = ctxFor(a.userId, a.wsId, "edit");
  } catch {
    throw new EcoError(403, "forbidden");
  }
  // One thread, one issue: asked again (a second click, another tab), the person gets that issue.
  const made = await issueOfThread(a, thread.id);
  if (made) return made;
  // …and one they cannot see (a private team's) is still the thread's issue: no second one.
  const mapped = sql("SELECT t.issue_id FROM eco_design_threads t JOIN pj_issues i ON i.id = t.issue_id WHERE t.ws_id = ? AND t.thread_id = ?").get(a.wsId, thread.id);
  if (mapped) throw new EcoError(409, "already an issue");
  const first = thread.comments[0]?.content?.trim() ?? "";
  const title = (typeof input.title === "string" && input.title.trim() ? input.title : first.split("\n")[0]).replace(/\s+/g, " ").trim().slice(0, 300);
  if (!title) throw new EcoError(400, "title required");
  const ref: Ref = isUuid(thread.frameId) ? { kind: "design", file: thread.fileId, frame: thread.frameId } : { kind: "design", file: thread.fileId };
  const where = (thread.frameName || thread.fileName || ecoText(a.locale, "design")).replace(/\s+/g, " ").trim().slice(0, 120);
  const link = `/design?ws=${encodeURIComponent(a.wsId)}&file=${thread.fileId}${isUuid(thread.frameId) ? `&frame=${thread.frameId}` : ""}`;
  const said = thread.comments
    .slice(0, 20)
    .map((c) => c.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const from = ecoText(a.locale, "fromComment");
  const issue = createIssue(ctx, {
    teamId: typeof input.teamId === "string" && input.teamId ? input.teamId : teamFor(ctx, a.locale),
    title,
    description: `${from} [${inert(where)}](${link})\n\n${quote(said.slice(0, 20_000))}`,
    projectId: visibleProjectId(ctx, input.projectId),
  });
  addLink(a.wsId, refKey(ref), `issue:${issue.id}`, "converted", a.userId, a.origin);
  ecoDb();
  sql("INSERT INTO eco_design_threads (ws_id, thread_id, issue_id, file_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ws_id, thread_id) DO UPDATE SET issue_id = excluded.issue_id, file_id = excluded.file_id, resolved = 0, created_by = excluded.created_by").run(
    a.wsId,
    thread.id,
    issue.id,
    thread.fileId,
    a.userId,
    Date.now()
  );
  const [card] = await cardsFor(a, [`issue:${issue.id}`]);
  if (!card) throw new EcoError(500, "not created");
  return card;
}

/**
 * An issue made from a Design comment changed: closed (done or canceled), its thread is
 * resolved in Design; opened again, the thread is reopened. Done only as the person who
 * changed the issue (Design checks they may comment there), never in someone else's name.
 */
export async function followIssueForThread(ws: string, issueId: string, by: string | undefined): Promise<void> {
  ecoDb();
  const rows = sql("SELECT thread_id, created_by, resolved FROM eco_design_threads WHERE ws_id = ? AND issue_id = ?").all(ws, issueId) as { thread_id: string; created_by: string; resolved: number }[];
  if (!rows.length) return;
  let closed: boolean;
  try {
    const ctx = ctxFor(rows[0].created_by, ws, "read");
    const issue = getIssueBrief(ctx, issueId);
    const cat = listStatuses(ctx).find((s) => s.id === issue.statusId)?.category;
    closed = cat === "completed" || cat === "canceled";
  } catch {
    return;
  }
  for (const r of rows) {
    if (Boolean(r.resolved) === closed) continue;
    // A rule or the system (no person) leaves the thread as it is.
    if (!by || !/^[A-Za-z0-9_-]{6,64}$/.test(by) || by.startsWith("rule")) continue;
    const res = await mgmt<{ id: string; isResolved: boolean }>("resolve-comment-thread", { email: designLogin(by), threadId: r.thread_id, resolved: closed });
    if (res && res.isResolved === closed) sql("UPDATE eco_design_threads SET resolved = ? WHERE ws_id = ? AND thread_id = ?").run(closed ? 1 : 0, ws, r.thread_id);
  }
}

/**
 * People mentioned in a Design comment hear it in their Inbox. The thread is read as each
 * of them (Design says what they may see), so nobody learns of a file they cannot open.
 */
export async function designMentions(ws: string, input: { file: string; thread: string; comment?: string | null; logins: readonly string[]; by: string | null }): Promise<number> {
  if (!isUuid(input.file) || !isUuid(input.thread)) return 0;
  let n = 0;
  for (const login of [...new Set(input.logins)].slice(0, 50)) {
    const userId = userIdOfLogin(login);
    if (!userId || userId === input.by) continue;
    const thread = await commentThread(userId, input.thread);
    if (!thread || thread.fileId !== input.file || thread.teamId !== wsTeam(ws)) continue;
    const said = (input.comment ? thread.comments.find((c) => c.id === input.comment) : null) ?? thread.comments[thread.comments.length - 1];
    notify(userId, {
      ws,
      kind: "mention",
      ref: isUuid(thread.frameId) ? `design:${thread.fileId}/${thread.frameId}` : `design:${thread.fileId}`,
      part: thread.id,
      by: input.by,
      text: said?.content ?? "",
    });
    n++;
  }
  return n;
}

/**
 * Links written in a design's comments become the links of the frame they
 * sit on (or of the file). Read as the workspace owner; shown per viewer.
 */
/** Files being indexed now, and those changed again meanwhile (indexed once more right after). */
const running = new Map<string, boolean>();

export async function indexDesignFile(ws: string, fileId: string): Promise<void> {
  if (!isUuid(fileId)) return;
  const k = `${ws}|${fileId}`;
  // One run per file at a time: an older answer from Design never lands after a newer one.
  if (running.has(k)) {
    running.set(k, true);
    return;
  }
  running.set(k, false);
  try {
    do {
      running.set(k, false);
      await indexDesignFileOnce(ws, fileId);
    } while (running.get(k));
  } finally {
    running.delete(k);
  }
}

async function indexDesignFileOnce(ws: string, fileId: string): Promise<void> {
  const owner = (sql("SELECT owner_id FROM workspaces WHERE id = ?").get(ws) as { owner_id: string } | undefined)?.owner_id;
  if (!owner) return;
  const res = await mgmt<{ teamId?: string; threads: DesignThread[] }>("file-comments", { email: designLogin(owner), fileId });
  // Only a file of this workspace's own Design team.
  if (!res || !Array.isArray(res.threads) || !res.teamId || res.teamId !== wsTeam(ws)) return;
  const o = origins();
  const ctx = systemCtx(ws);
  const bySrc = new Map<string, { part: string; targets: { dst: string; via: DerivedVia }[] }[]>();
  for (const t of res.threads) {
    const src = isUuid(t.frameId) ? `design:${fileId}/${t.frameId}` : `design:${fileId}`;
    const found = refsInMarkdown(t.comments.map((c) => c.content).join("\n"), o);
    const list = bySrc.get(src) ?? [];
    list.push({ part: `c:${t.id}`, targets: resolveTargets(ws, found, ctx) });
    bySrc.set(src, list);
  }
  for (const [src, parts] of bySrc) {
    for (const p of parts) setDerived(ws, src, p.part, p.targets);
    dropParts(ws, src, parts.map((p) => p.part));
  }
  // Frames whose threads are all gone lose their comment links too.
  const before = new Set(linksOf(ws, `design:${fileId}`, 5000).filter((l) => l.part.startsWith("c:")).map((l) => l.src));
  for (const src of before) if (!bySrc.has(src)) dropParts(ws, src, []);
}
