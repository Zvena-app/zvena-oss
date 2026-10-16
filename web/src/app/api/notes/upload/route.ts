import { onForeignHost } from "@/lib/enterprise/hosts";
import { rateLimited } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/safe-json";
import { crossSite, currentUser, fail, guestCookie, guestId, json } from "@/lib/http";
import { canEditSomewhere } from "@/lib/notes/access";
import { cookieSecure } from "@/lib/auth";
import { compressImage } from "@/lib/images";
import { inlineType, saveNoteFile, uploadExt } from "@/lib/notes/files";
import { NOTE_LIMITS } from "@/lib/notes/types";
import { newGuestId, payerOf, quotaLeft, recordFile, touchGuest, type Owner } from "@/lib/storage";
import { sql } from "@/lib/store";

export const dynamic = "force-dynamic";

// POST /api/notes/upload?ws=<id> — the raw file as the body; x-file-name carries
// its name (URI-encoded). → { url, name, size }
// Signed in: editors of the workspace; the file counts against the workspace
// owner's storage quota. Guests (Documents work without an account) get a
// cookie id and a small allowance; their files are removed after a period
// without visits (lib/storage.ts). Photos are compressed and lose EXIF.

const GUEST_BYTES = 200 * 1024 * 1024;

export async function POST(req: Request) {
  const rl = rateLimited(req, "notes-upload");
  if (rl) return rl;
  // Never on a site's custom domain (this route skips the proxy that guards those).
  if (onForeignHost(req)) return fail(404, "not found");
  const bad = crossSite(req);
  if (bad) return bad;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > NOTE_LIMITS.uploadBytes) return fail(413, "too large");

  let owner: Owner;
  let left: number;
  let setCookie: string | undefined;
  const me = currentUser(req);
  if (me) {
    const ws = new URL(req.url).searchParams.get("ws");
    // Anyone who may edit some page there (a guest with an edit share too).
    if (!ws || !canEditSomewhere(ws, me.user.id)) return fail(403, "forbidden");
    const payer = payerOf(ws as string) as string;
    owner = { kind: "user", id: payer };
    left = await quotaLeft(payer);
  } else {
    let g = guestId(req);
    if (!g) {
      g = newGuestId();
      setCookie = guestCookie(g, cookieSecure());
    }
    touchGuest(g);
    owner = { kind: "guest", id: g };
    const used = sql("SELECT COALESCE(SUM(bytes), 0) AS b FROM files WHERE owner_kind = 'guest' AND owner_id = ?").get(g) as { b: number };
    left = GUEST_BYTES - Number(used.b);
  }

  let fileName = "file";
  try {
    fileName = decodeURIComponent(req.headers.get("x-file-name") ?? "file").slice(0, 200);
  } catch {
    // keep the default
  }
  const ext0 = uploadExt(fileName, req.headers.get("content-type") ?? "");
  if (!ext0) return fail(415, "type not allowed");
  // Streamed with a cap: a chunked body (no Content-Length) cannot grow past the limit in memory.
  const body = await readBodyCapped(req, NOTE_LIMITS.uploadBytes);
  if (!body.ok) return body.status === 413 ? fail(413, "too large") : fail(400, "bad request");
  if (body.bytes.byteLength === 0) return fail(400, "empty");
  const { bytes, ext } = await compressImage(body.bytes, ext0);
  if (bytes.byteLength > left) return fail(507, "quota");
  try {
    const saved = await saveNoteFile(bytes, ext);
    if ("error" in saved) return fail(507, "storage full");
    recordFile(owner, saved.name, bytes.byteLength);
    // A file the browser cannot show downloads under its own name, not the content hash.
    const url = `/api/notes/file/${saved.name}${inlineType(ext) ? "" : `?download=${encodeURIComponent(fileName)}`}`;
    return json({ url, name: fileName, size: bytes.byteLength }, 200, setCookie ? { "set-cookie": setCookie } : {});
  } catch {
    return fail(503, "unavailable");
  }
}
