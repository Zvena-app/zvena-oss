// App icons and splash screens from the owner's logo (clients/brand/): the
// white two-shape mark on black. Run after changing the brand files:
//   npm run icons   (SHARP=/path/to/sharp to use another sharp install)
//
// The mark is taken from logo-tight.svg (its paths, cropped to the artwork)
// and placed on black at each target's size, so nothing is redrawn by hand.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP || "sharp");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tight = readFileSync(join(root, "..", "brand", "logo-tight.svg"), "utf8");
const viewBox = /viewBox="([^"]+)"/.exec(tight)[1].split(/\s+/).map(Number);
const paths = [...tight.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
if (paths.length === 0) throw new Error("no paths in logo-tight.svg");

/**
 * An SVG of `w`×`h`: background `bg` (null: transparent; "circle": a black
 * disc), the mark `markW` wide in the middle.
 */
function art(w, h, markW, bg = "#000") {
  const [vx, vy, vw, vh] = viewBox;
  const s = markW / vw;
  const x = (w - vw * s) / 2 - vx * s;
  const y = (h - vh * s) / 2 - vy * s;
  const back = bg === "circle" ? `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}" fill="#000"/>` : bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : "";
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${back}<g transform="translate(${x} ${y}) scale(${s})" fill="#fff">${paths.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`
  );
}

async function png(file, svg, { flatten = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  // Drawn at 4× and scaled down to the exact size (smoother edges than drawing at 1×).
  const [w, h] = /width="(\d+)" height="(\d+)"/.exec(svg.toString()).slice(1).map(Number);
  let img = sharp(svg, { density: 288 }).resize(w, h);
  // App Store icons must not have an alpha channel.
  if (flatten) img = img.flatten({ background: "#000" }).removeAlpha();
  writeFileSync(file, await img.png({ compressionLevel: 9 }).toBuffer());
}

const res = join(root, "android/app/src/main/res");
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [d, k] of Object.entries(densities)) {
  const legacy = Math.round(48 * k);
  await png(join(res, `mipmap-${d}/ic_launcher.png`), art(legacy, legacy, legacy * 0.62));
  await png(join(res, `mipmap-${d}/ic_launcher_round.png`), art(legacy, legacy, legacy * 0.58, "circle"));
  // Adaptive icons: 108 dp, the launcher shows the middle 72 dp (the mark keeps inside the 66 dp safe zone).
  const fg = Math.round(108 * k);
  await png(join(res, `mipmap-${d}/ic_launcher_foreground.png`), art(fg, fg, 50 * k, null));
  // Android 12+ splash icon: 240 dp canvas, shown inside a 160 dp circle.
  const sp = Math.round(240 * k);
  await png(join(res, `drawable-${d}/splash_icon.png`), art(sp, sp, 110 * k, null));
}

// Pre-12 splash (a full picture) and the plain drawable fallback.
const splash = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
for (const [d, [w, h]] of Object.entries(splash)) {
  await png(join(res, `drawable-port-${d}/splash.png`), art(w, h, w * 0.3));
  await png(join(res, `drawable-land-${d}/splash.png`), art(h, w, w * 0.3));
}
await png(join(res, "drawable/splash.png"), art(480, 320, 110));

const ios = join(root, "ios/App/App/Assets.xcassets");
await png(join(ios, "AppIcon.appiconset/AppIcon-512@2x.png"), art(1024, 1024, 640), { flatten: true });
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  await png(join(ios, "Splash.imageset", name), art(2732, 2732, 520), { flatten: true });
}
console.log("icons and splash screens written");
