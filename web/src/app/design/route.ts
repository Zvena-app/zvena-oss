import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { syncWorkspaceDesign } from "@/lib/design-sync";
import { access, currentUser } from "@/lib/http";
import { createFile, designConfigured } from "@/lib/penpot";
import { rateLimited } from "@/lib/rate-limit";
import { readCookie } from "@/lib/auth";
import { WS_COOKIE } from "@/lib/session";
import { personalWorkspace } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// GET /design?ws=<id>[&new=1][&file=<id>] — opens Design for a workspace:
// its Penpot team is brought in step with the members and roles first, then
// the browser goes to Design, which signs in through zvena (OIDC) without a
// second login. `new=1` creates an empty file (editors), `file` opens one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function go(url: string): NextResponse {
  const res = NextResponse.redirect(url, 303);
  res.headers.set("cache-control", "no-store");
  return res;
}

export async function GET(req: Request) {
  const rl = rateLimited(req, "design");
  if (rl) return rl;
  const url = new URL(req.url);
  const me = currentUser(req);
  if (!me) return go(`${config.appUrl}/signin?next=${encodeURIComponent(`/design${url.search}`)}`);
  if (!me.user.consentOk) return go(`${config.appUrl}/consent?next=${encodeURIComponent(`/design${url.search}`)}`);
  const want = url.searchParams.get("ws") || readCookie(req, WS_COOKIE) || personalWorkspace(me.user.id, "Personal").id;
  const role = access(me.user.id, want, "read");
  if (!role) return go(`${config.appUrl}/home`);
  if (!designConfigured()) return go(`${config.appUrl}/home?ws=${encodeURIComponent(want)}&design=off`);
  let teamId: string | null;
  try {
    teamId = await syncWorkspaceDesign(want);
  } catch {
    teamId = null;
  }
  if (!teamId) return go(`${config.appUrl}/home?ws=${encodeURIComponent(want)}&design=off`);
  const base = config.designUrl;
  const file = url.searchParams.get("file");
  if (file && UUID.test(file)) return go(`${base}/#/workspace?team-id=${teamId}&file-id=${file}`);
  if (url.searchParams.get("new") === "1" && (role === "owner" || role === "editor")) {
    try {
      const f = await createFile(me.user.id, teamId, url.searchParams.get("name")?.slice(0, 120) || "New design");
      return go(`${base}/#/workspace?team-id=${teamId}&file-id=${f.fileId}`);
    } catch {
      // Fall through to the team's files.
    }
  }
  return go(`${base}/#/dashboard/recent?team-id=${teamId}`);
}
