// Reports about public content (the "Report" button) and the moderators'
// queue. A report names a public page (/n/<id>), a form (/f/<id>), a
// published design (Design's view link with share-id) or an uploaded file
// (/api/notes/file/<hash>.<ext>). A moderator takes it down or rejects the
// report; both are recorded. A file taken down is deleted and blocked.

import { config } from "./config";
import { NOTE_FILE_RE } from "./notes/files";
import { NOTE_SHARE_ID_RE } from "./notes/server-store";
import { FORM_ID_RE } from "./notes/types";
import { unpublish } from "./penpot";
import { removeFileByModerator } from "./storage";
import { audit, newId, sql } from "./store";

export type ReportKind = "page" | "form" | "design" | "file";
export const REASONS = ["illegal", "harassment", "violence", "children", "selfharm", "personal", "copyright", "fraud", "spam", "other"] as const;
export type Reason = (typeof REASONS)[number];

export interface Report {
  id: string;
  kind: ReportKind;
  target: string;
  url: string;
  reason: Reason;
  details: string;
  contact: string;
  createdAt: number;
  status: "new" | "removed" | "rejected";
  resolution: string;
  resolvedAt: number | null;
}

/** The public thing a link points to, or null. */
export function parseTarget(raw: string): { kind: ReportKind; target: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), config.appUrl);
  } catch {
    return null;
  }
  const page = /^\/n\/([A-Za-z0-9]{16,40})\/?$/.exec(u.pathname);
  if (page && NOTE_SHARE_ID_RE.test(page[1])) return { kind: "page", target: page[1] };
  const form = /^\/f\/([A-Za-z0-9_-]{10,40})\/?$/.exec(u.pathname);
  if (form && FORM_ID_RE.test(form[1])) return { kind: "form", target: form[1] };
  const file = /^\/api\/notes\/file\/([^/]+)$/.exec(u.pathname);
  if (file && NOTE_FILE_RE.test(file[1])) return { kind: "file", target: file[1] };
  // Design: …/#/view?file-id=…&share-id=<uuid>
  const share = /share-id=([0-9a-f-]{36})/i.exec(u.hash || u.search);
  if (share) return { kind: "design", target: share[1].toLowerCase() };
  return null;
}

export function urlOf(kind: ReportKind, target: string): string {
  if (kind === "page") return `${config.appUrl}/n/${target}`;
  if (kind === "form") return `${config.appUrl}/f/${target}`;
  if (kind === "file") return `${config.appUrl}/api/notes/file/${target}`;
  return `${config.designUrl}/#/view?share-id=${target}`;
}

export function createReport(input: { kind: ReportKind; target: string; reason: Reason; details: string; contact: string; reporterId: string | null }): string {
  const id = newId(12);
  sql("INSERT INTO reports (id, kind, target, reason, details, contact, reporter_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    input.kind,
    input.target,
    input.reason,
    input.details.slice(0, 4000),
    input.contact.slice(0, 300),
    input.reporterId,
    Date.now()
  );
  return id;
}

export function listReports(status: "new" | "done", limit = 200): Report[] {
  const rows = sql(
    status === "new"
      ? "SELECT * FROM reports WHERE status = 'new' ORDER BY created_at ASC LIMIT ?"
      : "SELECT * FROM reports WHERE status != 'new' ORDER BY resolved_at DESC LIMIT ?"
  ).all(limit) as {
    id: string;
    kind: ReportKind;
    target: string;
    reason: Reason;
    details: string;
    contact: string;
    created_at: number;
    status: Report["status"];
    resolution: string;
    resolved_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    target: r.target,
    url: urlOf(r.kind, r.target),
    reason: r.reason,
    details: r.details,
    contact: r.contact,
    createdAt: r.created_at,
    status: r.status,
    resolution: r.resolution,
    resolvedAt: r.resolved_at,
  }));
}

export function reportCounts(): { new: number; done: number } {
  const r = sql("SELECT SUM(status = 'new') AS n, SUM(status != 'new') AS d FROM reports").get() as { n: number | null; d: number | null };
  return { new: Number(r.n ?? 0), done: Number(r.d ?? 0) };
}

/**
 * Resolves a report. "removed" takes the content down (every open report on
 * the same target is resolved with it); "rejected" leaves it up.
 */
export async function resolveReport(id: string, moderator: string, action: "removed" | "rejected", note: string): Promise<boolean> {
  const r = sql("SELECT kind, target, status FROM reports WHERE id = ?").get(id) as { kind: ReportKind; target: string; status: string } | undefined;
  if (!r || r.status !== "new") return false;
  const now = Date.now();
  if (action === "removed") {
    if (r.kind === "page") sql("UPDATE note_shares SET removed_at = ? WHERE id = ?").run(now, r.target);
    else if (r.kind === "form") sql("UPDATE note_forms SET removed_at = ? WHERE id = ?").run(now, r.target);
    else if (r.kind === "file") await removeFileByModerator(r.target, moderator);
    else await unpublish(r.target);
    sql("UPDATE reports SET status = 'removed', resolved_by = ?, resolved_at = ?, resolution = ? WHERE kind = ? AND target = ? AND status = 'new'").run(moderator, now, note.slice(0, 1000), r.kind, r.target);
  } else {
    sql("UPDATE reports SET status = 'rejected', resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?").run(moderator, now, note.slice(0, 1000), id);
  }
  audit(moderator, `report.${action}`, id, { kind: r.kind });
  return true;
}

/** Puts content back after a mistaken take-down (pages and forms). */
export function restoreContent(kind: ReportKind, target: string, moderator: string): void {
  if (kind === "page") sql("UPDATE note_shares SET removed_at = NULL WHERE id = ?").run(target);
  if (kind === "form") sql("UPDATE note_forms SET removed_at = NULL WHERE id = ?").run(target);
  audit(moderator, "report.restore", target, { kind });
}
