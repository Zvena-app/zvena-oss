import { currentUser, fail, json } from "@/lib/http";
import { listVersions, namesOf, readVersion } from "@/lib/notes/versions";
import { NOTE_ID_RE } from "@/lib/notes/types";
import { rateLimited } from "@/lib/rate-limit";
import { docsPresence, pageLevel } from "@/lib/notes/access";
import { readableFor } from "@/lib/notes/server-store";

export const dynamic = "force-dynamic";

// Page history of Documents (lib/notes/versions.ts), for members of the workspace.
// GET ?ws=&id=       → { versions: [{ id, at, started, by, kind, title, bytes }], names: { userId: name } }
// GET ?ws=&id=&v=<n> → { version: { …meta }, note, names }
// Restoring is an ordinary edit of the page (it syncs like any other).
export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-history", 120);
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const id = url.searchParams.get("id") ?? "";
  if (!NOTE_ID_RE.test(id)) return fail(400, "bad request");
  // History is the page's: whoever may read the page (Private and restricted pages stay closed).
  if (!pageLevel(me.user.id, ws, id)) return fail(404, "not found");
  const v = url.searchParams.get("v");
  try {
    if (v !== null) {
      const n = Number(v);
      const found = Number.isSafeInteger(n) && n > 0 ? readVersion(ws as string, id, n) : null;
      if (!found) return fail(404, "not found");
      // Column permissions apply to old versions too.
      return json({ version: found.meta, note: readableFor(ws as string, me.user.id, found.note), names: namesOf([found.meta.by, found.meta.acceptedBy ?? null]) });
    }
    const versions = listVersions(ws as string, id);
    return json({ versions, names: namesOf(versions.flatMap((x) => [x.by, x.acceptedBy ?? null])) });
  } catch {
    return fail(503, "unavailable");
  }
}
