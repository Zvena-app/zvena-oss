// Toolbar and store icons from the owner's mark (clients/brand/favicon.svg:
// the white mark on a black square). The PNGs are kept in src/icons, so a
// build (and AMO's review build) needs no image tools; run this only when
// the brand file changes:
//   SHARP=/path/to/node_modules/sharp node scripts/icons.mjs
// (default: the web app's copy of sharp).

import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP || join(root, "../../web/node_modules/sharp"));

const svg = readFileSync(join(root, "../brand/favicon.svg"));
const out = join(root, "src/icons");
mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  // Rendered large, then scaled down: crisper small sizes than rasterizing at 16 px.
  await sharp(svg, { density: 1200 }).resize(size, size).png({ compressionLevel: 9 }).toFile(join(out, `${size}.png`));
  console.log(`icons/${size}.png`);
}
