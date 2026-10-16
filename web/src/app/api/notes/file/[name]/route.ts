import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { isImageExt, NOTE_FILE_RE, NOTE_FILE_TYPES, notesFilesDir } from "@/lib/notes/files";
import { isRemovedFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

// GET /api/notes/file/<hash>.<ext> — a file placed in a page. Immutable
// (content-addressed). Served sandboxed: an SVG or HTML-ish file opened
// directly can never run script on this origin. Only pictures open in the
// browser when the link is followed; everything else downloads (a PDF still
// shows inside a page's own PDF block, which embeds it from this origin).
// A file a moderator took down answers 451.
// Cached by the person's own browser only ("private"): no CDN or proxy copy
// outlives a deleted account. Errors are never cached anywhere (a file
// asked for just before its upload finished must not stay a 404).
const NO_STORE = { "cache-control": "private, no-store" };
const notFound = () => new Response("not found", { status: 404, headers: NO_STORE });

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!NOTE_FILE_RE.test(name)) return notFound();
  const ext = name.split(".").pop() as string;
  const type = NOTE_FILE_TYPES[ext];
  if (!type) return notFound();
  if (isRemovedFile(name)) return new Response("removed by moderator", { status: 451, headers: NO_STORE });
  const file = join(notesFilesDir(), name);
  try {
    const st = await stat(file);
    if (!st.isFile()) return notFound();
    // A PDF shows in place only inside a page of this site (the PDF block's
    // frame); a followed link, or a frame elsewhere, downloads it.
    const pdfEmbed = ext === "pdf" && /^(iframe|embed|object)$/.test(req.headers.get("sec-fetch-dest") ?? "") && req.headers.get("sec-fetch-site") === "same-origin";
    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      // Chrome will not show a PDF in a sandboxed document; its viewer
      // isolates PDF scripts by itself.
      "content-security-policy": pdfEmbed ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
      "accept-ranges": "bytes",
    };
    if (ext === "pdf") headers.vary = "sec-fetch-dest, sec-fetch-site";
    const dl = new URL(req.url).searchParams.get("download");
    // Pictures may open in place; anything else is an attachment (video and
    // audio still play in a page: players ignore the disposition).
    if (!(isImageExt(ext) || pdfEmbed) || dl !== null) {
      // An ASCII fallback plus the real (e.g. Cyrillic) name for browsers that read filename*.
      // The name always ends in the stored type: a picture cannot download as "invoice.exe".
      let real = (dl || name).replace(/[\u0000-\u001f\u007f"\\/]+/g, "_").slice(0, 120);
      if (!real.toLowerCase().endsWith(`.${ext}`) && !(ext === "jpg" && /\.jpeg$/i.test(real))) real = `${real.replace(/\.+$/, "")}.${ext}`;
      const fname = real.replace(/[^\w.\- ]+/g, "_");
      headers["content-disposition"] = `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(real)}`;
    }
    // Video and audio seek with Range requests.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(st.size - 1, end);
      if (start > end) return new Response(null, { status: 416, headers: { ...NO_STORE, "content-range": `bytes */${st.size}` } });
      headers["content-range"] = `bytes ${start}-${end}/${st.size}`;
      headers["content-length"] = String(end - start + 1);
      return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, { status: 206, headers });
    }
    headers["content-length"] = String(st.size);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
  } catch {
    return notFound();
  }
}
