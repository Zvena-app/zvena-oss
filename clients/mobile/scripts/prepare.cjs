// Before `cap sync`: the build learns which server it opens (APP_URL, the
// same value capacitor.config.js reads; required, there is no built-in
// server). Writes the local fallback pages' www/app-url.js, and the host
// into the iOS app-bound domains (Info.plist) and universal links
// (App.entitlements). Android takes the host in Gradle.
"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { buildAppUrl, withAppBoundDomain, withAppLinks } = require("../src/app-url.js");

let app;
try {
  app = buildAppUrl(process.env.APP_URL);
} catch (e) {
  console.error(`prepare: ${e.message}`);
  process.exit(1);
}

const root = join(__dirname, "..");
const rewrite = (rel, fn) => {
  const file = join(root, rel);
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after !== before) writeFileSync(file, after);
};

writeFileSync(join(root, "www", "app-url.js"), `// Written by scripts/prepare.cjs from APP_URL (the build's server).\nwindow.ZVENA_APP_URL = ${JSON.stringify(`${app.origin}/`)};\n`);
rewrite("ios/App/App/Info.plist", (s) => withAppBoundDomain(s, app.hostname));
rewrite("ios/App/App/App.entitlements", (s) => withAppLinks(s, app.hostname));
console.log(`app url: ${app.origin}`);
