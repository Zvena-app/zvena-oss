import { onForeignHost } from "@/lib/enterprise/hosts";
import { publishingAllowed } from "@/lib/enterprise/security";
import { shareServable } from "@/lib/enterprise/site-domains";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { docsPresence, levelOf } from "@/lib/notes/access";
import { deleteNoteShare, noteShareLive, noteShareNoteId, readNoteShare, saveNoteShare, siteSnapshot } from "@/lib/notes/server-store";
import { cleanSiteOptions } from "@/lib/notes/sites";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { audit } from "@/lib/store";

export const dynamic = "force-dynamic";

// Documents "Publish to web": a frozen, read-only copy at /n/<id>.
// POST   ?ws=<id> { noteId, snapshot: { rootId, options } } → { id }   (full access to the page)
//        { …, live: true }: the quiet republish after edits — only a page published now, with its stored settings
//        The pages the copy shows are the server's: the page and what is under it that the publisher can read,
//        never below a page with restricted access of its own (siteSnapshot); a device's notes are not used.
// DELETE ?ws=<id> { id }               → { ok }   (full access to the page)
// GET    ?id=<share id>                → { snapshot } (public; "Duplicate")
// Publishing needs an account: every public page has a responsible
// workspace, and people can report it (the "Report" button).

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-share");
  if (rl) return rl;
  // Never on a site's custom domain (this route skips the proxy that guards those).
  if (onForeignHost(req)) return fail(404, "not found");
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "sign in required");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const parsed = await readJsonCapped(req, 24_000_000);
  if (!parsed.ok) return fail(parsed.status, parsed.status === 413 ? "request too large" : "bad request");
  const body = parsed.value as { noteId?: unknown; snapshot?: unknown; live?: unknown };
  const noteId = typeof body.noteId === "string" && NOTE_ID_RE.test(body.noteId) ? body.noteId : "";
  const sent = typeof body.snapshot === "object" && body.snapshot !== null ? (body.snapshot as { rootId?: unknown; options?: unknown }) : null;
  if (!noteId || (sent?.rootId !== undefined && sent.rootId !== noteId)) return fail(400, "bad request");
  const live = body.live === true;
  // Publishing to the web is a full-access action (Notion)…
  if (levelOf(ws as string, me.user.id, noteId) !== "full") return fail(403, "forbidden");
  // …that the workspace owner may switch off (Settings → Security).
  if (!publishingAllowed(ws)) return fail(403, "publishing is disabled in this workspace");
  try {
    const existing = noteShareLive(ws as string, noteId);
    // The quiet republish never publishes anything, and never changes how a site is set up.
    if (live && !existing) return fail(409, "not published");
    const options = live ? existing?.options : cleanSiteOptions(sent?.options);
    const snapshot = siteSnapshot(ws as string, me.user.id, noteId, options);
    if (!snapshot) return fail(403, "forbidden");
    const id = saveNoteShare(ws as string, me.user.id, noteId, snapshot);
    // Publishing is logged, and so is changing a published page's settings; an edit reaching the copy is not.
    if (!existing) audit(me.user.id, "page.publish", ws as string, { share: id });
    else if (!live && JSON.stringify(cleanSiteOptions(existing.options)) !== JSON.stringify(cleanSiteOptions(options))) audit(me.user.id, "page.publish.settings", ws as string, { share: id });
    return json({ id });
  } catch (e) {
    if (e instanceof Error && e.message === "removed") return fail(451, "removed by moderator");
    return fail(503, "unavailable");
  }
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "share-read");
  if (rl) return rl;
  // Never on a site's custom domain (this route skips the proxy that guards those).
  if (onForeignHost(req)) return fail(404, "not found");
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const share = readNoteShare(id);
  if (!share || !shareServable(share.id)) return fail(404, "not found");
  // The author turned "Allow duplicate" off.
  if (share.snapshot.options?.noDup) return fail(403, "duplicating is off");
  return json({ snapshot: share.snapshot });
}

export async function DELETE(req: Request) {
  const rl = rateLimited(req, "notes-share");
  if (rl) return rl;
  // Never on a site's custom domain (this route skips the proxy that guards those).
  if (onForeignHost(req)) return fail(404, "not found");
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "sign in required");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const parsed = await readJsonCapped(req, 10_000);
  if (!parsed.ok) return fail(parsed.status, "bad request");
  const body = parsed.value as { id?: unknown };
  if (typeof body.id !== "string") return fail(400, "bad request");
  const noteId = noteShareNoteId(body.id, ws as string);
  if (noteId && levelOf(ws as string, me.user.id, noteId) !== "full") return fail(403, "forbidden");
  try {
    const ok = deleteNoteShare(body.id, ws as string);
    if (ok) audit(me.user.id, "page.unpublish", ws as string, { share: body.id });
    return json({ ok });
  } catch {
    return fail(503, "unavailable");
  }
}
