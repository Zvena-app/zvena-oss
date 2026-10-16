import { onForeignHost } from "@/lib/enterprise/hosts";
import { rateLimited } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/safe-json";
import { crossSite, currentUser, fail, json } from "@/lib/http";
import { docsPresence } from "@/lib/notes/access";
import { pullNotes, pullNotesById, purgeNoteTombstones, pushNotes, validNotePush } from "@/lib/notes/server-store";
import { NOTE_ID_RE, NOTE_LIMITS } from "@/lib/notes/types";
import { originOf } from "@/lib/pulse/bus";
import { payerOf, quotaLeft } from "@/lib/storage";
import "@/lib/notes/reactions";

export const dynamic = "force-dynamic";

// Documents sync of one workspace (see src/lib/notes/server-store.ts).
// GET  /api/notes/sync?ws=<id>&since=<stamp>   → { notes, deleted, cursor, more }   (members and guests: what they may read)
// GET  /api/notes/sync?ws=<id>&ids=<a,b,…>     → { notes, deleted }                 (the server's copy of these notes)
// POST /api/notes/sync?ws=<id> { items: [...] } → { stamp, saved, rejected }         (each note by the person's level on it)

export async function GET(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  // Never on a site's custom domain (this route skips the proxy that guards those).
  if (onForeignHost(req)) return fail(404, "not found");
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const ids = url.searchParams.get("ids");
  if (ids !== null) {
    const list = ids.split(",").filter((id) => NOTE_ID_RE.test(id)).slice(0, NOTE_LIMITS.pushBatch);
    return json(pullNotesById(ws as string, list, me.user.id));
  }
  const since = Number(url.searchParams.get("since") ?? "0");
  try {
    return json(pullNotes(ws as string, Number.isFinite(since) && since > 0 ? since : 0, me.user.id));
  } catch {
    return fail(503, "unavailable");
  }
}

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-sync");
  if (rl) return rl;
  // Never on a site's custom domain (this route skips the proxy that guards those).
  if (onForeignHost(req)) return fail(404, "not found");
  const bad = crossSite(req);
  if (bad) return bad;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const ws = new URL(req.url).searchParams.get("ws");
  if (!docsPresence(me.user.id, ws)) return fail(403, "forbidden");
  const parsed = await readJsonCapped(req, 24_000_000);
  if (!parsed.ok) return fail(parsed.status, parsed.status === 413 ? "request too large" : "bad request");
  const raw = (parsed.value as { items?: unknown }).items;
  if (!Array.isArray(raw) || raw.length > NOTE_LIMITS.pushBatch) return fail(400, "bad request");
  const items = raw.map(validNotePush);
  // Malformed notes are reported one by one; the rest of the batch still saves.
  const good = items.filter((x): x is NonNullable<typeof x> => x !== null);
  const badItems = raw
    .map((r, i) => (items[i] ? null : { id: typeof (r as { id?: unknown })?.id === "string" ? String((r as { id: string }).id).slice(0, 64) : "?", reason: "invalid" }))
    .filter((x): x is { id: string; reason: string } => x !== null);
  try {
    const payer = payerOf(ws as string);
    const left = payer ? await quotaLeft(payer) : 0;
    // Each note is checked against the person's level on it (lib/notes/access.ts).
    const result = pushNotes(ws as string, good, { by: me.user.id, quotaLeft: left, author: me.user.name, access: { userId: me.user.id }, origin: originOf(req) });
    if (Math.random() < 0.01) purgeNoteTombstones();
    return json({ ...result, rejected: [...result.rejected, ...badItems] });
  } catch {
    return fail(503, "unavailable");
  }
}
