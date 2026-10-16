// Builds the extension for each browser and packs the store uploads:
//   node build.mjs                      dist/chrome, dist/firefox + the zips (Chrome Web Store / Edge Add-ons, AMO)
//                                       and the source zip AMO asks for
//   node build.mjs --server <origin> --out dist/chrome-test [--browser chrome]
//                                       one unpacked build for another server (a test stand); never for a store
// Bundled with esbuild (readable output, no minification: store reviewers read it).

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER, makeManifest } from "./src/lib/manifest.js";
import { serverOrigin } from "./src/lib/urls.js";
import { zip } from "./scripts/zip.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const customServer = arg("server");
const server = customServer ? serverOrigin(customServer) : DEFAULT_SERVER;
if (!server) throw new Error(`not a server origin: ${customServer}`);
const customOut = arg("out");

const ENTRIES = ["background.js", "popup.js", "extract.js", "connect.js"];
const STATIC = ["popup.html", "popup.css", "_locales", "icons", "fonts"];

async function buildFor(browser, out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: ENTRIES.map((e) => join(root, "src", e)),
    outdir: out,
    bundle: true,
    format: "iife",
    target: browser === "firefox" ? "firefox140" : "chrome116",
    charset: "utf8",
    legalComments: "inline",
    define: { __ZV_SERVER__: JSON.stringify(server), __ZV_BROWSER__: JSON.stringify(browser) },
    logLevel: "warning",
  });
  for (const s of STATIC) cpSync(join(root, "src", s), join(out, s), { recursive: true });
  mkdirSync(join(out, "brand"), { recursive: true });
  cpSync(join(root, "../brand/logo-horizontal.svg"), join(out, "brand/logo-horizontal.svg"));
  mkdirSync(join(out, "licenses"), { recursive: true });
  cpSync(join(root, "node_modules/@mozilla/readability/LICENSE.md"), join(out, "licenses/Readability-LICENSE.md"));
  cpSync(join(root, "src/fonts/LICENSE-Inter.txt"), join(out, "licenses/Inter-LICENSE.txt"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(makeManifest({ browser, version, server }), null, 2) + "\n");
  return out;
}

function filesOf(dir, base = dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesOf(p, base, prefix));
    else out.push({ name: prefix + relative(base, p), data: readFileSync(p) });
  }
  return out;
}

function pack(name, files) {
  const file = join(root, "dist", name);
  writeFileSync(file, zip(files));
  console.log(`${relative(root, file)}  ${(statSync(file).size / 1024).toFixed(1)} KB`);
}

if (customOut) {
  const browser = arg("browser") ?? "chrome";
  const out = await buildFor(browser, join(root, customOut));
  console.log(`${relative(root, out)} (${browser}, server ${server}; unpacked, not for a store)`);
} else {
  for (const browser of ["chrome", "firefox"]) {
    const out = await buildFor(browser, join(root, "dist", browser));
    pack(`zvena-web-clipper-${browser}-${version}.zip`, filesOf(out));
  }
  // AMO reviews bundled code against its sources: everything needed to rebuild, nothing generated.
  const src = [
    ...["package.json", "package-lock.json", "build.mjs", "README.md", ".gitignore"].filter((f) => existsSync(join(root, f))).map((f) => ({ name: `clients/web-clipper/${f}`, data: readFileSync(join(root, f)) })),
    ...["src", "scripts", "test"].flatMap((d) => filesOf(join(root, d), root, "clients/web-clipper/")),
    ...["favicon.svg", "logo-horizontal.svg"].map((f) => ({ name: `clients/brand/${f}`, data: readFileSync(join(root, "../brand", f)) })),
  ];
  pack(`zvena-web-clipper-source-${version}.zip`, src);
}
