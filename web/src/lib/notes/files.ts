// Server-only: files placed in zvena Documents (images, video, audio,
// PDFs and other attachments). Content-addressed on disk: the name is a hash
// of the bytes, so the same file uploaded twice is stored once, and a link
// cannot be guessed without having the file.

import { createHash } from "node:crypto";
import { mkdir, rename, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function notesFilesDir(): string {
  return process.env.ZVENA_FILES_DIR || "/var/lib/zvena/files";
}

/** Extension → served type. Anything else is refused at upload. */
export const NOTE_FILE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  heic: "image/heic",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  rtf: "application/rtf",
  epub: "application/epub+zip",
};

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/x-m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "text/plain": "txt",
};

/** The stored extension for an upload, from its name or type; null = not allowed. */
export function uploadExt(name: string, type: string): string | null {
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  if (fromName === "jpeg") return "jpg";
  if (fromName && NOTE_FILE_TYPES[fromName]) return fromName;
  const t = type.split(";")[0].trim().toLowerCase();
  if (MIME_EXT[t]) return MIME_EXT[t];
  const sub = /^[a-z]+\/([a-z0-9.+-]+)$/.exec(t)?.[1];
  if (sub && NOTE_FILE_TYPES[sub]) return sub;
  return null;
}

/** Types a browser may show in place; the rest download. */
export function inlineType(ext: string): boolean {
  return /^(png|jpg|gif|webp|avif|svg|ico|heic|mp4|webm|mov|mp3|m4a|wav|ogg|oga|flac|pdf|txt|md|csv|json)$/.test(ext);
}

/** Pictures (shown in place, also when opened directly). */
export function isImageExt(ext: string): boolean {
  return /^(png|jpg|gif|webp|avif|svg|ico|heic)$/.test(ext);
}

/**
 * What a guest (no account) may upload: raster pictures only. Anything else
 * (documents, archives, PDFs, SVG, video) needs a signed-in account, so the
 * server is never anonymous file hosting.
 */
export function guestMayUpload(ext: string): boolean {
  return /^(png|jpg|gif|webp|avif|heic)$/.test(ext);
}

/** Do the bytes start like a picture of this type (guests' uploads: no archive renamed .png)? */
export function looksLikeImage(bytes: Uint8Array, ext: string): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const ascii = (from: number, to: number) => b.subarray(from, to).toString("latin1");
  if (ext === "png") return b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;
  if (ext === "jpg") return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === "gif") return /^GIF8[79]a$/.test(ascii(0, 6));
  if (ext === "webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (ext === "avif" || ext === "heic") return ascii(4, 8) === "ftyp" && /^(avif|avis|heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii(8, 12));
  return false;
}

export const NOTE_FILE_RE = /^[a-f0-9]{40}\.[a-z0-9]{1,5}$/;

/** The stored name of these bytes (content hash + extension). */
export function noteFileName(bytes: Uint8Array, ext: string): string {
  return `${createHash("sha256").update(bytes).digest("hex").slice(0, 40)}.${ext}`;
}

/** Keeps the disk from filling up: uploads stop below this much free space. */
function minFreeBytes(): number {
  const v = Number(process.env.ZVENA_MIN_FREE_BYTES);
  return Number.isFinite(v) && v >= 0 ? v : 5 * 1024 ** 3;
}

export async function saveNoteFile(bytes: Uint8Array, ext: string): Promise<{ name: string } | { error: "disk" }> {
  const dir = notesFilesDir();
  await mkdir(dir, { recursive: true, mode: 0o750 });
  try {
    const fs = await statfs(dir);
    if (Number(fs.bavail) * Number(fs.bsize) < minFreeBytes() + bytes.byteLength) return { error: "disk" };
  } catch {
    // statfs unsupported: write anyway.
  }
  const name = noteFileName(bytes, ext);
  const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}`);
  await writeFile(tmp, bytes, { mode: 0o640 });
  await rename(tmp, join(dir, name));
  return { name };
}

/** Deletes stored files by name (no owner left); returns how many were removed. */
export async function removeNoteFiles(names: readonly string[]): Promise<number> {
  let n = 0;
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{1,100}\.[a-z0-9]{1,8}$/.test(name)) continue;
    try {
      await unlink(join(notesFilesDir(), name));
      n += 1;
    } catch {
      // Already gone.
    }
  }
  return n;
}

