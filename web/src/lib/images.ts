// Upload compression: photos are scaled down to ZVENA_IMAGE_MAX_SIDE and
// re-encoded, and their metadata (EXIF: camera, time, GPS position) is
// dropped. Animated GIFs, SVGs and icons are kept as they are. A file that
// sharp cannot read is stored unchanged.

import { config } from "./config";

const COMPRESSIBLE = new Set(["jpg", "png", "webp", "avif", "heic"]);

export async function compressImage(bytes: Uint8Array, ext: string): Promise<{ bytes: Uint8Array; ext: string }> {
  if (!COMPRESSIBLE.has(ext)) return { bytes, ext };
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(bytes, { failOn: "error", limitInputPixels: 120_000_000 }).rotate();
    const meta = await img.metadata();
    const max = config.imageMaxSide;
    const resize = (meta.width ?? 0) > max || (meta.height ?? 0) > max;
    const pipeline = resize ? img.resize({ width: max, height: max, fit: "inside", withoutEnlargement: true }) : img;
    let out: Buffer;
    let outExt = ext;
    if (ext === "png") {
      out = await pipeline.png({ compressionLevel: 9, effort: 7 }).toBuffer();
    } else if (ext === "webp") {
      out = await pipeline.webp({ quality: 82 }).toBuffer();
    } else if (ext === "avif") {
      out = await pipeline.avif({ quality: 60 }).toBuffer();
    } else {
      // JPEG and HEIC (browsers outside Safari cannot show HEIC) become JPEG.
      out = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      outExt = "jpg";
    }
    // Keep the original when re-encoding did not help — unless it carries
    // metadata (EXIF can hold the GPS position): privacy beats bytes.
    const hasMeta = Boolean(meta.exif || meta.xmp || meta.iptc);
    if (!resize && !hasMeta && ext !== "heic" && out.byteLength >= bytes.byteLength) return { bytes, ext };
    return { bytes: new Uint8Array(out), ext: outExt };
  } catch {
    return { bytes, ext };
  }
}
