// Around an issue: its detail page (relations, comments, history, files),
// comments and reactions, subscriptions, relations between issues and
// attachments.

import { mac, safeEqual } from "../auth";
import { recordFile } from "../storage";
import { sql, tx } from "../store";
import { inlineType, NOTE_FILE_TYPES } from "../notes/files";
import { bad, bump, emit, forbidden, needs, notFound, PjError, pid, str, type Ctx } from "./core";
import { commentAdded, commentEdited, notify, record, subscribe } from "./effects";
import { aliasesOf, fieldValues, getIssueBrief, issueRefs, issueState, subIssues } from "./issues";
import type { Activity, Attachment, Comment, IssueDetail, Relation, RelationType } from "./types";

// --- Detail --------------------------------------------------------------------

export function issueDetail(ctx: Ctx, id: string): IssueDetail {
  const st = issueState(ctx, id);
  const base = getIssueBrief(ctx, id);
  const parent = st.parent_id ? (issueRefs(ctx, [st.parent_id]).get(st.parent_id) ?? null) : null;
  const sub = sql("SELECT user_id FROM pj_issue_subscribers WHERE issue_id = ? AND muted = 0").all(id) as { user_id: string }[];
  return {
    ...base,
    description: st.description,
    parent,
    children: subIssues(ctx, id),
    relations: relationsOf(ctx, id),
    comments_: commentsOf(id),
    activity: activityOf(ctx, id),
    attachmentList: attachmentsOf(ctx, id),
    subscribed: sub.some((s) => s.user_id === ctx.userId),
    subscriberIds: sub.map((s) => s.user_id),
    fields: fieldValues(id),
    aliases: aliasesOf(id),
  };
}

/**
 * The history of an issue as the person may see it: other issues named in it
 * (relations, parent) are shown by identifier when visible, and blanked when
 * they belong to a team the person does not see.
 */
export function activityOf(ctx: Ctx, issueId: string, limit = 500): Activity[] {
  const rows = (
    sql("SELECT id, actor_id, kind, from_value, to_value, created_at, via FROM pj_activity WHERE issue_id = ? ORDER BY id DESC LIMIT ?").all(issueId, limit) as {
      id: number;
      via: string | null;
      actor_id: string | null;
      kind: string;
      from_value: string | null;
      to_value: string | null;
      created_at: number;
    }[]
  )
    .reverse()
    .map((r) => ({
      id: Number(r.id),
      actorId: r.actor_id,
      ...(r.via === "jev" ? { via: "jev" as const } : {}),
      kind: r.kind,
      from: r.from_value ? (JSON.parse(r.from_value) as unknown) : null,
      to: r.to_value ? (JSON.parse(r.to_value) as unknown) : null,
      createdAt: r.created_at,
    }));
  const named = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && typeof (v as { issue?: unknown }).issue === "string") return (v as { issue: string }).issue;
    return null;
  };
  const ids = rows.filter((r) => r.kind === "parent" || r.kind === "relation" || r.kind === "relation_removed").flatMap((r) => [named(r.from), named(r.to)]).filter((x): x is string => Boolean(x));
  const refs = issueRefs(ctx, [...new Set(ids)]);
  const show = (v: unknown): unknown => {
    const id = named(v);
    if (!id) return v;
    const ident = refs.get(id)?.identifier ?? null;
    return typeof v === "string" ? { identifier: ident } : { ...(v as object), issue: ident ? id : null, identifier: ident };
  };
  return rows.map((r) => (r.kind === "parent" || r.kind === "relation" || r.kind === "relation_removed" ? { ...r, from: show(r.from), to: show(r.to) } : r));
}

// --- Comments ------------------------------------------------------------------

interface CommentRow {
  id: string;
  issue_id: string;
  author_id: string | null;
  parent_id: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
}

function reactionsOf(ids: string[]): Map<string, { emoji: string; userIds: string[] }[]> {
  const out = new Map<string, { emoji: string; userIds: string[] }[]>();
  if (!ids.length) return out;
  const rows = sql("SELECT comment_id, emoji, user_id FROM pj_reactions WHERE comment_id IN (SELECT value FROM json_each(?)) ORDER BY created_at").all(JSON.stringify(ids)) as {
    comment_id: string;
    emoji: string;
    user_id: string;
  }[];
  for (const r of rows) {
    const list = out.get(r.comment_id) ?? [];
    const e = list.find((x) => x.emoji === r.emoji);
    if (e) e.userIds.push(r.user_id);
    else list.push({ emoji: r.emoji, userIds: [r.user_id] });
    out.set(r.comment_id, list);
  }
  return out;
}

const toComment = (r: CommentRow, reactions: Map<string, { emoji: string; userIds: string[] }[]>): Comment => ({
  id: r.id,
  issueId: r.issue_id,
  authorId: r.author_id,
  parentId: r.parent_id,
  body: r.body,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  editedAt: r.edited_at,
  reactions: reactions.get(r.id) ?? [],
});

export function commentsOf(issueId: string): Comment[] {
  const rows = sql("SELECT id, issue_id, author_id, parent_id, body, created_at, updated_at, edited_at FROM pj_comments WHERE issue_id = ? ORDER BY created_at").all(issueId) as unknown as CommentRow[];
  const reactions = reactionsOf(rows.map((r) => r.id));
  return rows.map((r) => toComment(r, reactions));
}

function commentRow(ctx: Ctx, id: string): CommentRow {
  const r = sql("SELECT id, issue_id, author_id, parent_id, body, created_at, updated_at, edited_at FROM pj_comments WHERE id = ? AND ws_id = ?").get(id, ctx.wsId) as CommentRow | undefined;
  if (!r) throw notFound("comment not found");
  issueState(ctx, r.issue_id); // the issue must be visible
  return r;
}

const BODY_MAX = 50_000;

export function addComment(ctx: Ctx, issueId: string, input: { body?: unknown; parentId?: unknown }): Comment {
  needs(ctx, "comment");
  const issue = issueState(ctx, issueId);
  const body = str(input.body, BODY_MAX, { trim: false });
  if (!body.trim()) throw bad("empty comment");
  let parentAuthor: string | null = null;
  let parentId: string | null = null;
  if (typeof input.parentId === "string") {
    const p = commentRow(ctx, input.parentId);
    if (p.issue_id !== issueId) throw bad("parent of another issue");
    // Replies stay one level deep (a reply to a reply joins the same thread).
    parentId = p.parent_id ?? p.id;
    parentAuthor = p.author_id;
  }
  const id = pid();
  const now = Date.now();
  tx(() => {
    sql("INSERT INTO pj_comments (id, ws_id, issue_id, author_id, parent_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, ctx.wsId, issueId, ctx.userId, parentId, body, now, now);
    sql("UPDATE pj_issues SET updated_at = ? WHERE id = ?").run(now, issueId);
    commentAdded(ctx, { id: issueId, team_id: issue.team_id }, { id, body, parentAuthor }, now);
    bump(ctx.wsId);
  });
  emit(ctx, "comment", id, { issueId, created: true });
  return toComment(commentRow(ctx, id), new Map());
}

export function editComment(ctx: Ctx, id: string, input: { body?: unknown }): Comment {
  needs(ctx, "comment");
  const cur = commentRow(ctx, id);
  if (cur.author_id !== ctx.userId) throw forbidden();
  const body = str(input.body, BODY_MAX, { trim: false });
  if (!body.trim()) throw bad("empty comment");
  const now = Date.now();
  tx(() => {
    sql("UPDATE pj_comments SET body = ?, updated_at = ?, edited_at = ? WHERE id = ?").run(body, now, now, id);
    const issue = issueState(ctx, cur.issue_id);
    commentEdited(ctx, { id: cur.issue_id, team_id: issue.team_id }, id, cur.body, body);
    bump(ctx.wsId);
  });
  emit(ctx, "comment", id, { issueId: cur.issue_id });
  return toComment(commentRow(ctx, id), reactionsOf([id]));
}

/** The author deletes their comment; the workspace owner may delete any. */
export function deleteComment(ctx: Ctx, id: string): void {
  needs(ctx, "comment");
  const cur = commentRow(ctx, id);
  if (cur.author_id !== ctx.userId && ctx.role !== "owner") throw forbidden();
  tx(() => {
    sql("DELETE FROM pj_comments WHERE id = ?").run(id);
    sql("DELETE FROM pj_activity WHERE issue_id = ? AND kind = 'comment' AND json_extract(to_value, '$.comment') = ?").run(cur.issue_id, id);
    bump(ctx.wsId);
  });
  emit(ctx, "comment", id, { issueId: cur.issue_id, deleted: true });
}

const EMOJI = new Set(["👍", "👎", "❤️", "🎉", "😄", "😕", "🚀", "👀", "✅", "🔥"]);

export function toggleReaction(ctx: Ctx, commentId: string, emoji: unknown): Comment {
  needs(ctx, "comment");
  const cur = commentRow(ctx, commentId);
  if (typeof emoji !== "string" || !EMOJI.has(emoji)) throw bad("bad emoji");
  tx(() => {
    const had = Number(sql("DELETE FROM pj_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?").run(commentId, ctx.userId, emoji).changes) > 0;
    if (!had) sql("INSERT INTO pj_reactions (comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)").run(commentId, ctx.userId, emoji, Date.now());
    bump(ctx.wsId);
  });
  emit(ctx, "comment", commentId, { issueId: cur.issue_id });
  return toComment(cur, reactionsOf([commentId]));
}

// --- Subscriptions -------------------------------------------------------------

export function setSubscribed(ctx: Ctx, issueId: string, on: boolean): void {
  // Subscribing is for those who take part (commenters and up); anyone may stop notifications.
  if (on) needs(ctx, "comment");
  issueState(ctx, issueId);
  if (on) subscribe(issueId, ctx.userId, true);
  else sql("INSERT INTO pj_issue_subscribers (issue_id, user_id, muted) VALUES (?, ?, 1) ON CONFLICT(issue_id, user_id) DO UPDATE SET muted = 1").run(issueId, ctx.userId);
  bump(ctx.wsId);
}

// --- Relations -----------------------------------------------------------------

const REL_TYPES: readonly RelationType[] = ["blocks", "blocked_by", "related", "duplicate", "duplicated_by"];

export function relationsOf(ctx: Ctx, issueId: string): Relation[] {
  const rows = sql("SELECT id, issue_id, related_id, type FROM pj_issue_relations WHERE ws_id = ? AND (issue_id = ? OR related_id = ?) ORDER BY created_at, rowid").all(ctx.wsId, issueId, issueId) as {
    id: string;
    issue_id: string;
    related_id: string;
    type: "blocks" | "related" | "duplicate";
  }[];
  const other = (r: (typeof rows)[number]) => (r.issue_id === issueId ? r.related_id : r.issue_id);
  const refs = issueRefs(ctx, rows.map(other));
  const out: Relation[] = [];
  for (const r of rows) {
    const ref = refs.get(other(r));
    if (!ref) continue; // the other side is in a team this person does not see
    const mine = r.issue_id === issueId;
    const type: RelationType = r.type === "related" ? "related" : r.type === "blocks" ? (mine ? "blocks" : "blocked_by") : mine ? "duplicate" : "duplicated_by";
    out.push({ id: r.id, type, issue: ref });
  }
  return out;
}

/** Would "a blocks b" close a loop (b already blocks a, directly or not)? */
function blocksLoop(a: string, b: string): boolean {
  const seen = new Set<string>();
  const stack = [b];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === a) return true;
    if (seen.has(cur) || seen.size > 5000) continue;
    seen.add(cur);
    for (const r of sql("SELECT related_id FROM pj_issue_relations WHERE issue_id = ? AND type = 'blocks'").all(cur) as { related_id: string }[]) stack.push(r.related_id);
  }
  return false;
}

export function addRelation(ctx: Ctx, issueId: string, input: { type?: unknown; relatedId?: unknown }): Relation[] {
  needs(ctx, "edit");
  const type = input.type as RelationType;
  if (!REL_TYPES.includes(type)) throw bad("bad relation type");
  const a = issueState(ctx, issueId);
  if (typeof input.relatedId !== "string") throw bad("bad issue");
  const b = issueState(ctx, input.relatedId);
  if (a.id === b.id) throw bad("an issue cannot relate to itself");
  // Stored one way: blocks (issue → related), duplicate (duplicate → original), related.
  const [from, to, stored] =
    type === "blocked_by" ? [b.id, a.id, "blocks"] : type === "duplicated_by" ? [b.id, a.id, "duplicate"] : [a.id, b.id, type];
  tx(() => {
    const dup = sql("SELECT 1 FROM pj_issue_relations WHERE ((issue_id = ? AND related_id = ?) OR (issue_id = ? AND related_id = ?)) AND type = ?").get(from, to, to, from, stored);
    if (dup) throw new PjError(409, "relation exists");
    if (stored === "blocks" && blocksLoop(from, to)) throw new PjError(409, "blocking loop");
    sql("INSERT INTO pj_issue_relations (id, ws_id, issue_id, related_id, type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(pid(), ctx.wsId, from, to, stored, ctx.userId, Date.now());
    record(ctx, a.id, "relation", null, { type, issue: b.id });
    record(ctx, b.id, "relation", null, { type: inverse(type), issue: a.id });
    if (stored === "blocks") {
      const blocked = from === a.id ? b : a;
      if (blocked.assignee_id) notify(ctx, blocked.assignee_id, "blocked", { issueId: blocked.id, teamId: blocked.team_id });
    }
    bump(ctx.wsId);
  });
  emit(ctx, "issue", a.id);
  emit(ctx, "issue", b.id);
  return relationsOf(ctx, issueId);
}

function inverse(t: RelationType): RelationType {
  return t === "blocks" ? "blocked_by" : t === "blocked_by" ? "blocks" : t === "duplicate" ? "duplicated_by" : t === "duplicated_by" ? "duplicate" : "related";
}

export function removeRelation(ctx: Ctx, relationId: string): void {
  needs(ctx, "edit");
  const r = sql("SELECT id, issue_id, related_id, type FROM pj_issue_relations WHERE id = ? AND ws_id = ?").get(relationId, ctx.wsId) as
    | { id: string; issue_id: string; related_id: string; type: string }
    | undefined;
  if (!r) throw notFound("relation not found");
  issueState(ctx, r.issue_id);
  issueState(ctx, r.related_id);
  tx(() => {
    sql("DELETE FROM pj_issue_relations WHERE id = ?").run(relationId);
    record(ctx, r.issue_id, "relation_removed", { type: r.type, issue: r.related_id }, null);
    record(ctx, r.related_id, "relation_removed", { type: r.type, issue: r.issue_id }, null);
    bump(ctx.wsId);
  });
  emit(ctx, "issue", r.issue_id);
  emit(ctx, "issue", r.related_id);
}

// --- Attachments ---------------------------------------------------------------

interface AttRow {
  id: string;
  issue_id: string;
  file: string;
  name: string;
  bytes: number;
  uploaded_by: string | null;
  created_at: number;
}

function toAttachment(r: AttRow): Attachment {
  const ext = r.file.split(".").pop() ?? "";
  return {
    id: r.id,
    name: r.name,
    bytes: r.bytes,
    ext,
    url: `/api/projects/attachments/${r.id}`,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    image: /^(png|jpg|gif|webp|avif)$/.test(ext),
  };
}

export function attachmentsOf(ctx: Ctx, issueId: string): Attachment[] {
  return (sql("SELECT id, issue_id, file, name, bytes, uploaded_by, created_at FROM pj_attachments WHERE issue_id = ? AND ws_id = ? ORDER BY created_at").all(issueId, ctx.wsId) as unknown as AttRow[]).map(
    toAttachment
  );
}

export function addAttachment(ctx: Ctx, issueId: string, file: { name: string; stored: string; bytes: number; payer: string }): Attachment {
  needs(ctx, "edit");
  issueState(ctx, issueId);
  const id = pid();
  const now = Date.now();
  tx(() => {
    const n = sql("SELECT COUNT(*) AS n FROM pj_attachments WHERE issue_id = ?").get(issueId) as { n: number };
    if (Number(n.n) >= 200) throw new PjError(409, "too many attachments");
    sql("INSERT INTO pj_attachments (id, ws_id, issue_id, file, name, bytes, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      ctx.wsId,
      issueId,
      file.stored,
      file.name.slice(0, 200),
      file.bytes,
      ctx.userId,
      now
    );
    recordFile({ kind: "user", id: file.payer }, file.stored, file.bytes);
    record(ctx, issueId, "attachment", null, { name: file.name.slice(0, 200) }, now);
    sql("UPDATE pj_issues SET updated_at = ? WHERE id = ?").run(now, issueId);
    bump(ctx.wsId);
  });
  emit(ctx, "issue", issueId);
  return toAttachment(sql("SELECT id, issue_id, file, name, bytes, uploaded_by, created_at FROM pj_attachments WHERE id = ?").get(id) as unknown as AttRow);
}

/** An attachment the person may read (null: not found or not theirs to see). */
export function attachmentFor(ctx: Ctx, id: string): (Attachment & { file: string }) | null {
  const r = sql("SELECT id, issue_id, file, name, bytes, uploaded_by, created_at FROM pj_attachments WHERE id = ? AND ws_id = ?").get(id, ctx.wsId) as AttRow | undefined;
  if (!r) return null;
  try {
    issueState(ctx, r.issue_id);
  } catch {
    return null;
  }
  return { ...toAttachment(r), file: r.file };
}

/** The attachment row by id alone (for signed links, which carry no session). */
export function attachmentById(id: string): { file: string; name: string } | null {
  const r = sql("SELECT file, name FROM pj_attachments WHERE id = ?").get(id) as { file: string; name: string } | undefined;
  return r ?? null;
}

export function deleteAttachment(ctx: Ctx, id: string): void {
  needs(ctx, "edit");
  const a = attachmentFor(ctx, id);
  if (!a) throw notFound("attachment not found");
  tx(() => {
    const r = sql("SELECT issue_id FROM pj_attachments WHERE id = ?").get(id) as { issue_id: string };
    sql("DELETE FROM pj_attachments WHERE id = ?").run(id);
    record(ctx, r.issue_id, "attachment_removed", { name: a.name }, null);
    bump(ctx.wsId);
    emit(ctx, "issue", r.issue_id);
  });
}

// Signed links: a short-lived URL that opens one attachment without a session
// (an external viewer, a download manager). HMAC over id and expiry.
const LINK_TTL = 15 * 60_000;

export function signedLink(ctx: Ctx, id: string, now = Date.now()): { url: string; expiresAt: number } {
  if (!attachmentFor(ctx, id)) throw notFound("attachment not found");
  const exp = now + LINK_TTL;
  return { url: `/api/projects/attachments/${id}?exp=${exp}&sig=${mac("pj-attachment", `${id}.${exp}`)}`, expiresAt: exp };
}

export function checkSignedLink(id: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  if (!exp || !sig || !/^\d{10,16}$/.test(exp) || Number(exp) < now || Number(exp) > now + LINK_TTL + 60_000) return false;
  return safeEqual(sig, mac("pj-attachment", `${id}.${exp}`));
}

export function attachmentType(file: string): { type: string; inline: boolean } | null {
  const ext = file.split(".").pop() ?? "";
  const type = NOTE_FILE_TYPES[ext];
  return type ? { type, inline: inlineType(ext) } : null;
}

