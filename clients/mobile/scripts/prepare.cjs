// Before `cap sync`: the local fallback pages learn which server this build
// opens (APP_URL, the same value capacitor.config.js reads).
"use strict";

const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { originOf } = require("../src/links.js");

const origin = originOf(process.env.APP_URL || "https://zvena.app");
writeFileSync(join(__dirname, "..", "www", "app-url.js"), `// Written by scripts/prepare.cjs from APP_URL (the build's server).\nwindow.ZVENA_APP_URL = ${JSON.stringify(`${origin}/`)};\n`);
console.log(`app url: ${origin}`);
