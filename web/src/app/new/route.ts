import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { readCookie } from "@/lib/auth";
import { config } from "@/lib/config";
import { CREATE_ITEMS, DESIGN_PRESETS, itemLabel, type DesignPreset } from "@/lib/create";
import { syncWorkspaceDesign } from "@/lib/design-sync";
import { cardsFor } from "@/lib/eco/cards";
import { addLink } from "@/lib/eco/links";
import { parseRefKey, refKey } from "@/lib/eco/refs";
import { access, currentUser } from "@/lib/http";
import { translate } from "@/lib/i18n";
import { parseAcceptLanguage, readLocale } from "@/lib/locale-server";
import { notesT } from "@/lib/notes/i18n";
import { blankNote, blankSchema, noteSlug } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import { createFile, designConfigured, importTemplate } from "@/lib/penpot";
import { rateLimited } from "@/lib/rate-limit";
import { WS_COOKIE } from "@/lib/session";
import { payerOf, quotaLeft } from "@/lib/storage";
import { personalWorkspace } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// GET /new?ws=<id>&kind=doc|table|issue|design[&preset=presentation|social|story|mobile|website|a4][&for=<ref>][&name=…]
//
// One click from "+ Create", Home's "What will you create?" or Cmd+K: makes
// the thing and opens its editor (lib/create.ts lists what can be made).
//   doc     Documents makes a page in the browser at once (#new); with `for`
//           the page is made here so it can be linked first
//   table   a database with a table view, made here
//   issue   Projects' new-issue form (it makes the issue)
//   design  a Design file; a preset brings one empty board of that format
// `for` ("issue:<id>", "project:<id>", "note:<id>"…) links the new object to
// it (shows in Related). It is a GET because it is a link, so it acts only
// when the navigation starts on zvena itself (Sec-Fetch-Site), never from
// another site.

function go(url: string): NextResponse {
  const res = NextResponse.redirect(url, 303);
  res.headers.set("cache-control", "no-store");
  return res;
}

const PRESETS_DIR = () => join(process.cwd(), "templates/design-presets");

export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const url = new URL(req.url);
  const here = `/new${url.search}`;
  const me = currentUser(req);
  if (!me) return go(`${config.appUrl}/signin?next=${encodeURIComponent(here)}`);
  if (!me.user.consentOk) return go(`${config.appUrl}/consent?next=${encodeURIComponent(here)}`);
  const userId = me.user.id;
  const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
  const ws = url.searchParams.get("ws") || readCookie(req, WS_COOKIE) || personalWorkspace(userId, translate(locale, "ws.personal")).id;
  const home = `${config.appUrl}/home?ws=${encodeURIComponent(ws)}`;
  if (!access(userId, ws, "read")) return go(`${config.appUrl}/home`);
  // A link on another site must not make things in someone's workspace.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return go(home);
  // …nor an image, frame, prefetch or script call on a zvena page: only opening it as a page.
  const dest = req.headers.get("sec-fetch-dest");
  if ((dest && dest !== "document") || req.headers.has("next-router-prefetch") || req.headers.get("purpose") === "prefetch") return go(home);
  if (!access(userId, ws, "edit")) return go(home);

  const kind = url.searchParams.get("kind");
  const forRef = parseRefKey(url.searchParams.get("for"));
  // Link only to something this person can see in this workspace (never to a private team's issue).
  let forKey = forRef ? refKey(forRef) : null;
  if (forKey) {
    try {
      if ((await cardsFor({ userId, wsId: ws, locale }, [forKey])).length !== 1) forKey = null;
    } catch {
      forKey = null;
    }
  }
  const link = (src: string) => {
    if (!forKey) return;
    try {
      addLink(ws, src, forKey, "converted", userId);
    } catch {
      // The new object stands on its own if the link fails.
    }
  };
  const name = url.searchParams.get("name")?.trim().slice(0, 120) || "";
  const label = (id: string) => {
    const item = CREATE_ITEMS.find((x) => x.id === id);
    return item ? itemLabel(item, locale) : "";
  };
  const docs = (slug: string) => `${config.appUrl}/docs?ws=${encodeURIComponent(ws)}#${slug}`;

  // Documents: a page (the browser makes it instantly), or a page or table made here.
  if (kind === "doc" && !forKey && !name) return go(docs("new"));
  if (kind === "doc" || kind === "table") {
    const note =
      kind === "table"
        ? blankNote({ kind: "database", title: name || label("table"), db: blankSchema({ name: notesT(locale, "db.name"), tags: notesT(locale, "db.tags"), table: notesT(locale, "db.table") }) })
        : blankNote({ kind: "page", title: name });
    const payer = payerOf(ws);
    const left = payer ? await quotaLeft(payer) : 0;
    const res = pushNotes(ws, [{ id: note.id, note }], { by: userId, quotaLeft: left });
    if (!res.saved.includes(note.id)) return go(`${home}&created=quota`);
    link(`note:${note.id}`);
    return go(docs(noteSlug(note)));
  }

  // Projects: its own form makes the issue (titles, team, status…).
  if (kind === "issue") {
    const q = new URLSearchParams({ ws, create: "issue" });
    if (forKey) q.set("for", forKey);
    if (name) q.set("title", name);
    return go(`${config.appUrl}/projects?${q.toString()}`);
  }

  if (kind === "design") {
    if (!designConfigured()) return go(`${home}&design=off`);
    let teamId: string | null = null;
    try {
      teamId = await syncWorkspaceDesign(ws);
    } catch {
      teamId = null;
    }
    if (!teamId) return go(`${home}&design=off`);
    const preset = DESIGN_PRESETS.find((p) => p === url.searchParams.get("preset")) as DesignPreset | undefined;
    const fileName = name || label(preset ?? "blank") || "Design";
    try {
      let fileId: string;
      if (preset) {
        const data = await readFile(join(PRESETS_DIR(), `${preset}.penpot`));
        fileId = (await importTemplate(userId, teamId, fileName, data)).fileId;
      } else {
        fileId = (await createFile(userId, teamId, fileName)).fileId;
      }
      link(`design:${fileId}`);
      return go(`${config.designUrl}/#/workspace?team-id=${teamId}&file-id=${fileId}`);
    } catch {
      return go(`${home}&design=off`);
    }
  }

  return go(home);
}
