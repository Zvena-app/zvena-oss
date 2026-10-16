import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import appUrl from "../src/app-url.js";

const { buildAppUrl, withAppBoundDomain, withAppLinks } = appUrl;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** Runs a node snippet in the app's folder with APP_URL removed from the environment. */
function withoutAppUrl(args) {
  const env = { ...process.env };
  delete env.APP_URL;
  return spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
}

test("APP_URL is required and must be https (http only for local dev servers)", () => {
  assert.throws(() => buildAppUrl(undefined), /APP_URL is not set/);
  assert.throws(() => buildAppUrl("  "), /APP_URL is not set/);
  assert.throws(() => buildAppUrl("not a url"), /not a valid address/);
  assert.throws(() => buildAppUrl("http://zvena.example.com"), /must be https/);
  assert.throws(() => buildAppUrl("ftp://localhost"), /must be https/);
  assert.throws(() => buildAppUrl("https://u:p@zvena.example.com"), /user name or password/);
  assert.equal(buildAppUrl("https://zvena.example.com/home").origin, "https://zvena.example.com");
  assert.equal(buildAppUrl("http://10.0.2.2:3955").origin, "http://10.0.2.2:3955");
});

test("the build fails without APP_URL: prepare.cjs and capacitor.config.js", () => {
  const prep = withoutAppUrl(["scripts/prepare.cjs"]);
  assert.equal(prep.status, 1);
  assert.match(prep.stderr, /APP_URL is not set/);
  const conf = withoutAppUrl(["-e", "require('./capacitor.config.js')"]);
  assert.notEqual(conf.status, 0);
  assert.match(conf.stderr, /APP_URL is not set/);
  assert.match(read("android/app/build.gradle"), /throw new GradleException\("APP_URL is not set/);
});

test("no built-in server in the committed files", () => {
  for (const rel of ["capacitor.config.js", "scripts/prepare.cjs", "www/app-url.js", "www/start.js", "www/error.js", "android/app/build.gradle", "ios/App/App/Info.plist", "ios/App/App/App.entitlements"]) {
    assert.equal(/zvena\.app/.test(read(rel)), false, rel);
  }
  assert.match(read("www/app-url.js"), /window\.ZVENA_APP_URL = "";/);
});

test("prepare writes the host of APP_URL into the iOS files", () => {
  const plist = withAppBoundDomain(read("ios/App/App/Info.plist"), "work.example.org");
  assert.match(plist, /<key>WKAppBoundDomains<\/key>\s*<array>\s*<string>work\.example\.org<\/string>/);
  const ent = withAppLinks(read("ios/App/App/App.entitlements"), "work.example.org");
  assert.match(ent, /<string>applinks:work\.example\.org<\/string>/);
  // Idempotent: a second run with another server replaces the host again.
  assert.match(withAppLinks(ent, "zvena.example.com"), /<string>applinks:zvena\.example\.com<\/string>/);
  assert.throws(() => withAppLinks("<plist/>", "x"), /applinks/);
  assert.throws(() => withAppBoundDomain("<plist/>", "x"), /WKAppBoundDomains/);
});
