// Generates Design's brand assets (the Penpot fork) from zvena's logo
// files in web/public/brand: the mark (two shapes in a 185-unit box), the
// "zvena." wordmark (logo-horizontal.svg), app icons (white mark on a black
// square, as logo-black-bg.svg), the e-mail logo, the link preview and the
// sign-up illustration — and writes them over the fork's logo files.
//
//   NODE_PATH=<dir with opentype.js and sharp> node tools/zvena-brand.cjs
const fs = require("fs");
const path = require("path");
const opentype = require("opentype.js");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const IMG = path.join(ROOT, "src/frontend/resources/images");
const BRAND = path.resolve(ROOT, "../web/public/brand");
const font = opentype.loadSync(path.join(ROOT, "brand/fonts/InterDisplay-SemiBold.ttf"));
const NAVY = "#000000"; // the brand is black and white
const BLUE = "#0D99FF";

// zvena's mark: two shapes in a 185x185 box.
const MARK = ["M46.5 54.3H156L98.4 94H86C64.2 94 46.5 76.2 46.5 54.3Z", "M98.4 94C126 94 149 111.9 149 134H39Z"];

/** The mark scaled into a box of `s` units at (x, y). */
function mark(x, y, s, fill = null) {
  const f = fill ? ` fill="${fill}"` : "";
  return `<g transform="translate(${x} ${y}) scale(${(s / 185).toFixed(5)})"${f}>${MARK.map((d) => `<path d="${d}"/>`).join("")}</g>`;
}

function svg(w, h, body, title = "zvena") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><title>${title}</title>${body}</svg>\n`;
}

function iconSvg({ size = 500, fill = null } = {}) {
  return svg(size, size, mark(0, 0, size, fill));
}

/** zvena's wordmark ("zvena." 1270x218), optionally recolored. */
function wordmarkSvg({ fill = null } = {}) {
  let src = fs.readFileSync(path.join(BRAND, "logo-horizontal.svg"), "utf8");
  if (fill) src = src.replace(/fill="#000000"/g, `fill="${fill}"`);
  return { svg: src, w: 1270, h: 218 };
}

const write = (rel, data) => {
  fs.writeFileSync(path.join(IMG, rel), data);
  console.log("wrote", rel);
};

(async () => {
  // Penpot's logo slots (they keep their file names: the code refers to them).
  write("assets/penpot-logo-icon.svg", iconSvg());
  write("icons/penpot-logo-icon.svg", iconSvg());
  write("icons/penpot-logo-icon-loader.svg", iconSvg());
  write("assets/penpot-logo-subtle.svg", svg(24, 24, mark(0, 0, 24, "currentColor")));
  const wm = wordmarkSvg();
  write("assets/penpot-logo.svg", wm.svg);
  write("icons/penpot-logo.svg", wm.svg);
  // The error screen's tall decoration: the mark, large.
  write("assets/logo-error-screen.svg", svg(320, 320, mark(0, 0, 320)));

  // Raster icons: the white mark on a black square (logo-black-bg.svg).
  const app = fs.readFileSync(path.join(BRAND, "logo-black-bg.svg"));
  await sharp(app).resize(72, 72).png().toFile(path.join(IMG, "favicon.png"));
  await sharp(app).resize(180, 180).png().toFile(path.join(IMG, "apple-touch-icon.png"));
  console.log("wrote favicon.png, apple-touch-icon.png");

  // E-mail logo (height 64): the black wordmark on transparent.
  await sharp(Buffer.from(wm.svg)).resize({ height: 64 }).png().toFile(path.join(IMG, "email/logo-zvena.png"));
  console.log("wrote email/logo-zvena.png");

  // Link preview 1200x630: the wordmark and the tagline on white.
  const tag = font.getPath("Design and docs for teams", 0, 0, 52);
  const tb = tag.getBoundingBox();
  const scale = 0.55;
  const preview = svg(
    1200,
    630,
    `<rect width="1200" height="630" fill="#FFFFFF"/>` +
      `<g transform="translate(${(1200 - wm.w * scale) / 2} 190) scale(${scale})">${wm.svg.replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, "").replace(/<title[\s\S]*?<\/title>|<desc[\s\S]*?<\/desc>/g, "")}</g>` +
      `<path fill="#6E6E6E" transform="translate(${(1200 - (tb.x2 - tb.x1)) / 2 - tb.x1} 440)" d="${tag.toPathData(2)}"/>`
  );
  await sharp(Buffer.from(preview)).jpeg({ quality: 88 }).toFile(path.join(IMG, "link-preview.jpg"));
  console.log("wrote link-preview.jpg");

  // Sign-up illustration (1733x1519): an editor window with a frame, and a
  // document card showing that frame — zvena's design ⇄ docs link. No AI.
  const label = font.getPath("zvena", 0, 0, 40);
  const lb = label.getBoundingBox();
  const docT = font.getPath("Spec", 0, 0, 34);
  const ill = svg(
    1733,
    1519,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1497F9"/><stop offset="1" stop-color="#6FBDF7"/></linearGradient>` +
      `<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="24" stdDeviation="40" flood-color="#1F2A44" flood-opacity="0.14"/></filter></defs>` +
      `<rect x="120" y="170" width="1490" height="1150" rx="40" fill="#fff" stroke="#E2E2E2" stroke-width="3" filter="url(#sh)"/>` +
      `<circle cx="171" cy="218" r="11" fill="#E5E5E5"/><circle cx="215" cy="218" r="11" fill="#E5E5E5"/><circle cx="259" cy="218" r="11" fill="#E5E5E5"/>` +
      `<path d="M120 268h1490M420 268v1052M1290 268v1052" stroke="#ECECEC" stroke-width="3"/><rect x="421" y="270" width="868" height="1048" fill="#F4F4F4"/>` +
      [306, 350, 394, 438, 482, 526].map((y, i) => `<rect x="154" y="${y}" width="${[230, 184, 138, 184, 138, 184][i]}" height="18" rx="9" fill="${i === 0 ? "#E7F2FD" : "#EDEDED"}"/>`).join("") +
      [306, 350, 394, 438, 482].map((y, i) => `<rect x="1326" y="${y}" width="${[150, 200, 250, 150, 200][i]}" height="18" rx="9" fill="${i === 2 ? "#E7F2FD" : "#EDEDED"}"/>`).join("") +
      `<rect x="510" y="385" width="330" height="642" rx="40" fill="#fff" stroke="#E5E5E5" stroke-width="3"/>` +
      `<rect x="540" y="426" width="270" height="230" rx="22" fill="url(#g)"/><rect x="540" y="696" width="264" height="18" rx="9" fill="#EDEDED"/><rect x="540" y="738" width="198" height="18" rx="9" fill="#EDEDED"/><rect x="540" y="792" width="270" height="64" rx="32" fill="#1497F9"/>` +
      `<rect x="918" y="484" width="334" height="424" rx="20" fill="#fff" stroke="#1497F9" stroke-width="4"/>` +
      `<rect x="920" y="436" width="106" height="44" rx="6" fill="#1497F9"/><text x="934" y="467" font-family="Arial, sans-serif" font-size="26" font-weight="600" fill="#fff">Frame</text>` +
      `<rect x="960" y="536" width="264" height="18" rx="9" fill="#EDEDED"/><rect x="960" y="578" width="198" height="18" rx="9" fill="#EDEDED"/><rect x="960" y="636" width="250" height="170" rx="22" fill="url(#g)"/>` +
      [[908, 474], [1238, 474], [908, 894], [1238, 894]].map(([x, y]) => `<rect x="${x}" y="${y}" width="24" height="24" rx="3" fill="#fff" stroke="#1497F9" stroke-width="4"/>`).join("") +
      // The document card that shows the frame (top right, over the window edge).
      `<g filter="url(#sh)"><rect x="1150" y="40" width="540" height="330" rx="28" fill="${NAVY}"/></g>` +
      `<path fill="#fff" transform="translate(${1192 - docT.getBoundingBox().x1} 104)" d="${docT.toPathData(2)}"/>` +
      `<rect x="1192" y="136" width="200" height="14" rx="7" fill="#6E6E6E"/>` +
      `<rect x="1192" y="172" width="456" height="160" rx="16" fill="#fff" opacity="0.95"/><rect x="1212" y="192" width="190" height="120" rx="12" fill="url(#g)"/><rect x="1424" y="204" width="200" height="14" rx="7" fill="#D7DEEA"/><rect x="1424" y="236" width="150" height="14" rx="7" fill="#D7DEEA"/>` +
      // A collaborator's cursor.
      `<path transform="translate(1246 878) scale(1.6)" d="M0 0V34l9-8 6 14 6-3-6-13h12z" fill="#1F2A44" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>` +
      `<rect x="1286" y="922" width="${Math.ceil(lb.x2 - lb.x1) + 60}" height="58" rx="10" fill="${NAVY}"/>` +
      `<path fill="#fff" transform="translate(${1316 - lb.x1} 963)" d="${label.toPathData(2)}"/>` +
      `<rect x="938" y="964" width="294" height="94" rx="20" fill="#fff" stroke="#9747FF" stroke-width="4"/><rect x="974" y="1002" width="232" height="18" rx="9" fill="#E7D7FF"/>`
  );
  await sharp(Buffer.from(ill)).png().toFile(path.join(IMG, "registration-illustration.png"));
  console.log("wrote registration-illustration.png");
})();
