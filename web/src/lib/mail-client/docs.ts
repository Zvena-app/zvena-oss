// Server-only: Mail with the rest of zvena (Notion Mail's tie to Notion).
//   - save a conversation to Documents: a page (in the person's Private
//     section, or under a page they can edit) or a row of a database; written
//     through Documents' own push with the person's access;
//   - turn a conversation into a Projects issue (lib/eco/actions.ts's
//     issueFromDoc, for mail);
//   - before a Docs link goes out in a message: who of the recipients cannot
//     open the page (the composer offers to share it with them).
// Each conversion leaves a "converted" link (mail:<thread> → the new object),
// and the text copied out of the mail is inert: plain text in Documents, the
// quote escaped in an issue's Markdown, so a mail can never smuggle links,
// mentions or markup into either.

import { cardsFor, type Viewer } from "../eco/cards";
import { EcoError, teamFor, visibleProjectId } from "../eco/actions";
import { indexNote } from "../eco/indexer";
import { addLink } from "../eco/links";
import { ecoText } from "../eco/strings";
import type { Card } from "../eco/types";
import { intlOf, type Locale } from "@/i18n/locales";
import { AccessResolver, atLeast } from "../notes/access";
import { blankNote, newNoteId, noteSlug } from "../notes/model";
import { pushNotes } from "../notes/server-store";
import type { Note } from "../notes/types";
import { ctxFor, PjError } from "../projects/core";
import { createIssue } from "../projects/issues";
import { payerOf, quotaLeft } from "../storage";
import { sql } from "../store";
import { refHref } from "../eco/refs";
import { config } from "../config";
import { htmlToPlain } from "./sanitize";
import { threadOf } from "./store";
import type { MailThread } from "./types";
import { mailText } from "./strings";

export class DocsError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

const blockId = () => newNoteId().slice(0, 12);
const MAX_PARAGRAPHS = 400;
const MAX_PARAGRAPH = 4000;

type Inline = { type: "text"; text: string; styles: Record<string, boolean> } | { type: "link"; href: string; content: { type: "text"; text: string; styles: Record<string, never> }[] };
const text = (t: string, styles: Record<string, boolean> = {}): Inline => ({ type: "text", text: t, styles });
const para = (content: Inline[]) => ({ id: blockId(), type: "paragraph", props: {}, content, children: [] });
const heading = (t: string, level: 2 | 3) => ({ id: blockId(), type: "heading", props: { level }, content: [text(t)], children: [] });
const quote = (t: string) => ({ id: blockId(), type: "quote", props: {}, content: [text(t)], children: [] });

/** The mail's address in Mail (for the owner; a link back from the saved page). */
export function threadUrl(ws: string, threadId: string): string {
  return refHref({ kind: "mail", id: threadId }, ws);
}

/** A conversation as page blocks: who wrote when, then what they wrote, as plain text only. */
export function threadBlocks(t: MailThread, locale: string, ws: string): unknown[] {
  const fmt = new Intl.DateTimeFormat(intlOf(locale), { dateStyle: "medium", timeStyle: "short" });
  const out: unknown[] = [];
  out.push(para([text(`${mailText(locale, "docs.savedFrom")} `, { italic: true }), { type: "link", href: `${config.appUrl}${threadUrl(ws, t.id)}`, content: [{ type: "text", text: t.subject || mailText(locale, "noSubject"), styles: {} }] }]));
  let n = 0;
  for (const m of t.messages) {
    if (m.draft) continue;
    out.push(heading(`${m.from.name || m.from.address} · ${fmt.format(new Date(m.date))}`, 3));
    const to = [...m.to, ...m.cc].map((a) => a.name || a.address).join(", ");
    if (to) out.push(para([text(`${mailText(locale, "to")}: ${to}`, { italic: true })]));
    const body = (m.text ?? (m.snippet || "")).replace(/\r\n?/g, "\n");
    const chunks = body.split(/\n{2,}/).map((c) => c.trim()).filter(Boolean);
    for (const c of chunks) {
      if (n++ >= MAX_PARAGRAPHS) break;
      const lines = c.split("\n");
      const quoted = lines.every((l) => /^\s*>/.test(l));
      const plain = (quoted ? lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n") : c).slice(0, MAX_PARAGRAPH);
      out.push(quoted ? quote(plain) : para([text(plain)]));
    }
  }
  return out;
}

/**
 * Saves a conversation into Documents. `parent`: a database (the mail becomes
 * a row), a page (a sub-page), or none (the person's Private pages).
 */
export async function saveThreadToDocs(v: Viewer & { name: string }, threadId: unknown, parent: unknown): Promise<{ noteId: string; url: string }> {
  const t = threadOf(v.userId, threadId);
  if (!t) throw new DocsError(404, "not found");
  const acc = new AccessResolver(v.wsId, v.userId);
  if (!acc.present) throw new DocsError(403, "forbidden");
  // Texts not fetched yet are filled from what the server already has.
  for (const m of t.messages) if (!m.text) m.text = htmlToPlain((sql("SELECT html FROM mail_messages WHERE id = ?").get(m.id) as { html: string | null } | undefined)?.html ?? "") || m.snippet;
  let parentId: string | null = null;
  if (typeof parent === "string" && parent) {
    const p = sql("SELECT json_extract(json, '$.kind') AS kind FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(v.wsId, parent) as { kind: string | null } | undefined;
    if (!p || !atLeast(acc.level(parent), "edit")) throw new DocsError(403, "forbidden");
    parentId = parent;
  }
  const note: Note = blankNote({
    kind: "page",
    title: t.subject || mailText(v.locale, "noSubject"),
    icon: "✉️",
    parentId,
    content: threadBlocks(t, v.locale, v.wsId),
    ...(parentId ? {} : { space: "private" }),
  });
  const payer = payerOf(v.wsId);
  const left = payer ? await quotaLeft(payer) : 0;
  const res = pushNotes(v.wsId, [{ id: note.id, note }], { by: v.userId, quotaLeft: left, author: v.name, access: { userId: v.userId } });
  if (!res.saved.includes(note.id)) throw new DocsError(res.rejected.some((r) => r.reason === "forbidden") ? 403 : 507, "not saved");
  indexNote(v.wsId, note.id);
  addLink(v.wsId, `mail:${t.id}`, `note:${note.id}`, "converted", v.userId);
  return { noteId: note.id, url: refHref({ kind: "note", id: note.id }, v.wsId, { slug: noteSlug(note) }) };
}

/** Markdown that shows as written: no links, mentions, images or HTML can come out of a mail's text. */
export function inertMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~@&:/?=%]/g, (c) => `\\${c}`);
}

/** A conversation becomes an issue: its subject the title, the newest message quoted (inert), a link back. */
export async function issueFromThread(v: Viewer, input: { thread?: unknown; title?: unknown; teamId?: unknown; projectId?: unknown; assigneeId?: unknown }): Promise<Card> {
  const t = threadOf(v.userId, input.thread);
  if (!t) throw new DocsError(404, "not found");
  let ctx;
  try {
    ctx = ctxFor(v.userId, v.wsId, "edit");
  } catch {
    throw new DocsError(403, "forbidden");
  }
  const title = (typeof input.title === "string" && input.title.trim() ? input.title : t.subject || mailText(v.locale, "noSubject")).replace(/\s+/g, " ").trim().slice(0, 300);
  let teamId: string;
  let projectId: string | undefined;
  try {
    teamId = typeof input.teamId === "string" && input.teamId ? input.teamId : teamFor(ctx, v.locale);
    projectId = visibleProjectId(ctx, input.projectId);
  } catch (e) {
    if (e instanceof EcoError) throw new DocsError(e.status, e.code);
    throw e;
  }
  const last = [...t.messages].reverse().find((m) => !m.draft) ?? t.messages[t.messages.length - 1];
  const body = (last.text ?? last.snippet ?? "").replace(/\r\n?/g, "\n").split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim().slice(0, 4000);
  const from = `${last.from.name || last.from.address}`;
  const description = [
    `${ecoText(v.locale, "fromDoc")} [${inertMarkdown(t.subject || mailText(v.locale, "noSubject"))}](${threadUrl(v.wsId, t.id)}) — ${inertMarkdown(from)}`,
    "",
    ...body.split("\n").map((l) => `> ${inertMarkdown(l)}`),
  ].join("\n");
  let issue;
  try {
    issue = createIssue(ctx, { teamId, title, description, projectId, assigneeId: input.assigneeId === "me" ? v.userId : undefined });
  } catch (e) {
    if (e instanceof PjError) throw new DocsError(e.status, e.code);
    throw e;
  }
  addLink(v.wsId, `mail:${t.id}`, `issue:${issue.id}`, "converted", v.userId);
  const [card] = await cardsFor(v, [`issue:${issue.id}`]);
  if (!card) throw new DocsError(500, "not created");
  return card;
}

/**
 * Which of these addresses cannot open the page (no account, or an account
 * without access). Asked only by someone with full access to it (they see
 * its sharing anyway); anyone else learns nothing.
 */
export function docsAccessFor(v: Viewer, noteId: string, emails: string[]): { canShare: boolean; missing: string[]; title: string } | null {
  const acc = new AccessResolver(v.wsId, v.userId);
  const level = acc.level(noteId);
  if (!level) return null;
  const title = String((sql("SELECT json_extract(json, '$.title') AS t FROM notes WHERE ws = ? AND id = ? AND deleted = 0").get(v.wsId, noteId) as { t: string | null } | undefined)?.t ?? "");
  if (level !== "full") return { canShare: false, missing: [], title };
  const missing: string[] = [];
  for (const raw of emails.slice(0, 50)) {
    const email = raw.trim().toLowerCase();
    const u = sql("SELECT id FROM users WHERE lower(email) = ? AND blocked_at IS NULL").get(email) as { id: string } | undefined;
    if (!u || !new AccessResolver(v.wsId, u.id).level(noteId)) missing.push(email);
  }
  return { canShare: true, missing, title };
}

export type { Locale };
