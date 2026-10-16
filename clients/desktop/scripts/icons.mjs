// The app's icons from zvena's logo files (clients/brand): the white
// mark on a black square, as the website's favicon. Writes build/icon.png
// (macOS, Windows), build/icons/<n>x<n>.png (Linux), assets/icon.png (the
// Linux window) and assets/tray.png. Needs sharp: the web app's copy is used
// (SHARP=/path/to/sharp to point elsewhere).
//   node scripts/icons.mjs

import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP || join(root, "..", "..", "web", "node_modules", "sharp"));

const square = readFileSync(join(root, "..", "brand", "favicon.svg"));
const png = (size) => sharp(square, { density: Math.ceil((72 * size) / 32) }).resize(size, size).png({ compressionLevel: 9 });

mkdirSync(join(root, "build", "icons"), { recursive: true });
await png(1024).toFile(join(root, "build", "icon.png"));
for (const n of [16, 24, 32, 48, 64, 128, 256, 512]) await png(n).toFile(join(root, "build", "icons", `${n}x${n}.png`));
await png(512).toFile(join(root, "assets", "icon.png"));
await png(32).toFile(join(root, "assets", "tray.png"));
await png(64).toFile(join(root, "assets", "tray@2x.png"));
console.log("icons written");
