import { onForeignHost } from "@/lib/enterprise/hosts";
import { clientKey, rateLimited } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/safe-json";
import { crossSite, currentUser, fail, guestCookie, guestId, json } from "@/lib/http";
import { canEditSomewhere } from "@/lib/notes/access";
import { cookieSecure } from "@/lib/auth";
import { compressImage } from "@/lib/images";
import { guestMayUpload, inlineType, looksLikeImage, noteFileName, saveNoteFile, uploadExt } from "@/lib/notes/files";
import { NOTE_LIMITS } from "@/lib/notes/types";
import { config } from "@/lib/config";
import { guestUploadAllowed, isRemovedFile, newGuestId, noteGuestUpload, payerOf, quotaLeft, recordFile, touchGuest, type Owner } from "@/lib/storage";

export const dynamic = "force-dynamic";

// POST /api/notes/upload?ws=<id> — the raw file as the body; x-file-name carries
// its name (URI-encoded). → { url, name, size }
// Signed in: editors of the workspace; the file counts against the workspace
// owner's storage quota. Guests (Documents work without an account) get a
// cookie id and may add pictures only, within a small allowance per guest,
// per network and per day for the whole server; their files are removed
// after the guest TTL (lib/storage.ts). Anything else needs an account: the
// answer then carries `signIn: true` so the editor can say so.
// Photos are compressed and lose EXIF. Content a moderator took down is refused.

const signInFirst = (status: number, error: string) => json({ error, signIn: true }, status);

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
  let guest = false;
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
    if (declared > config.guestUploadMb * 1024 * 1024) return signInFirst(413, "too large without an account");
    touchGuest(g);
    owner = { kind: "guest", id: g };
    guest = true;
    left = Infinity; // checked below, once the size is known
  }

  let fileName = "file";
  try {
    fileName = decodeURIComponent(req.headers.get("x-file-name") ?? "file").slice(0, 200);
  } catch {
    // keep the default
  }
  const ext0 = uploadExt(fileName, req.headers.get("content-type") ?? "");
  if (!ext0) return fail(415, "type not allowed");
  if (guest && !guestMayUpload(ext0)) return signInFirst(401, "sign in to upload files other than pictures");
  // Streamed with a cap: a chunked body (no Content-Length) cannot grow past the limit in memory.
  const cap = guest ? Math.min(NOTE_LIMITS.uploadBytes, config.guestUploadMb * 1024 * 1024) : NOTE_LIMITS.uploadBytes;
  const body = await readBodyCapped(req, cap);
  if (!body.ok) return body.status === 413 ? (guest ? signInFirst(413, "too large without an account") : fail(413, "too large")) : fail(400, "bad request");
  if (body.bytes.byteLength === 0) return fail(400, "empty");
  if (guest && !looksLikeImage(body.bytes, ext0)) return signInFirst(415, "not a picture");
  const { bytes, ext } = await compressImage(body.bytes, ext0);
  if (bytes.byteLength > left) return fail(507, "quota");
  if (guest) {
    const ok = guestUploadAllowed(owner.id, clientKey(req), bytes.byteLength);
    if (!ok.ok) return signInFirst(507, ok.why === "guest" ? "guest quota" : "guest uploads paused");
  }
  if (isRemovedFile(noteFileName(bytes, ext))) return fail(451, "removed by moderator");
  try {
    const saved = await saveNoteFile(bytes, ext);
    if ("error" in saved) return fail(507, "storage full");
    recordFile(owner, saved.name, bytes.byteLength);
    if (guest) noteGuestUpload(clientKey(req), bytes.byteLength);
    // A file the browser cannot show downloads under its own name, not the content hash.
    const url = `/api/notes/file/${saved.name}${inlineType(ext) ? "" : `?download=${encodeURIComponent(fileName)}`}`;
    return json({ url, name: fileName, size: bytes.byteLength }, 200, setCookie ? { "set-cookie": setCookie } : {});
  } catch {
    return fail(503, "unavailable");
  }
}
