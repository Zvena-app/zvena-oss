// Writes zvena's icon files from the owner's logo files in public/brand/
// (favicon.svg: the white mark on a black square; logo-horizontal.svg: the
// long logo "zvena."):
//   src/app/icon.svg, src/app/apple-icon.png, src/app/favicon.ico — favicons;
//   public/brand/icon-192.png, icon-512.png, icon-maskable-512.png — the web
//     app manifest (app/manifest.ts) and the logo in structured data;
//   public/brand/zvena-logo-email.png — the long logo in e-mails (no SVG there).
// Re-run after the owner's files change:  node scripts/brand-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const brand = (name) => readFileSync(join(ROOT, "public/brand", name), "utf8");

// The square icon as drawn by the owner (185 × 185, full bleed).
const square = brand("favicon.svg").replace(/ width="\d+" height="\d+"/, "");
/** The same icon with the mark scaled about the center (for maskable icons). */
const scaled = (k) => square.replace('<g fill="#fff">', `<g fill="#fff" transform="translate(${(92.5 * (1 - k)).toFixed(2)} ${(92.5 * (1 - k)).toFixed(2)}) scale(${k})">`);
const png = (svg, size) => sharp(Buffer.from(svg), { density: Math.max(72, Math.ceil((72 * size) / 185) * 2) }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** An .ico holding PNG images (every current browser reads these). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const write = (rel, data) => {
  const file = join(ROOT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log("wrote", rel, `(${data.length} bytes)`);
};

write("src/app/icon.svg", square);
// iOS rounds the corners itself: the square stays full bleed.
write("src/app/apple-icon.png", await png(square, 180));
write("src/app/favicon.ico", ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(square, size) })))));
write("public/brand/icon-192.png", await png(square, 192));
write("public/brand/icon-512.png", await png(square, 512));
// Maskable: the mark kept inside the 80% safe circle.
write("public/brand/icon-maskable-512.png", await png(scaled(0.82), 512));
// E-mail: the black long logo, 2x for sharp screens (shown 20px high).
write("public/brand/zvena-logo-email.png", await sharp(Buffer.from(brand("logo-horizontal.svg")), { density: 72 }).resize({ height: 40 }).png({ compressionLevel: 9 }).toBuffer());
