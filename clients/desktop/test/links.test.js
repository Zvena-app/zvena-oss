"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/links");

const APP = "https://zvena.example.com";

test("server origins: https anywhere, http only on this machine, nothing else", () => {
  assert.equal(L.serverOrigin("https://zvena.example.com/home?x=1"), "https://zvena.example.com");
  assert.equal(L.serverOrigin("http://127.0.0.1:3955"), "http://127.0.0.1:3955");
  assert.equal(L.serverOrigin("http://localhost:3100/"), "http://localhost:3100");
  assert.equal(L.serverOrigin("http://zvena.example.com"), null);
  assert.equal(L.serverOrigin("http://192.168.1.5"), null);
  assert.equal(L.serverOrigin("https://user:pw@zvena.example.com"), null);
  assert.equal(L.serverOrigin("file:///etc/passwd"), null);
  assert.equal(L.serverOrigin("javascript:alert(1)"), null);
  assert.equal(L.serverOrigin(""), null);
  // No built-in server: without APP_URL or a saved one there is no origin (the app asks for it).
  assert.equal(L.resolveAppOrigin(undefined, ""), null);
  assert.equal(L.resolveAppOrigin("", "http://evil.example"), null);
  assert.equal(L.resolveAppOrigin(undefined, "https://zvena.example.com/home"), APP);
  assert.equal("DEFAULT_APP_URL" in L, false);
  assert.equal(L.resolveAppOrigin("http://127.0.0.1:3955", "https://my.example"), "http://127.0.0.1:3955");
  assert.equal(L.resolveAppOrigin("bogus", "https://my.example/x"), "https://my.example");
});

test("zvena:// links map to the app origin and never leave it", () => {
  assert.equal(L.deepLinkTarget("zvena://docs?ws=abc#Title-0123456789abcdef0123456789abcdef", APP), "https://zvena.example.com/docs?ws=abc#Title-0123456789abcdef0123456789abcdef");
  assert.equal(L.deepLinkTarget("zvena://home", APP), "https://zvena.example.com/home");
  assert.equal(L.deepLinkTarget("zvena://projects/abc/issues", APP), "https://zvena.example.com/projects/abc/issues");
  assert.equal(L.deepLinkTarget("zvena:docs#x", APP), "https://zvena.example.com/docs#x");
  assert.equal(L.deepLinkTarget("zvena://open?url=" + encodeURIComponent("https://zvena.example.com/docs#Page-1"), APP), "https://zvena.example.com/docs#Page-1");
  // Another origin through open?url=, or through tricks in the path, is ignored.
  assert.equal(L.deepLinkTarget("zvena://open?url=" + encodeURIComponent("https://evil.example/docs"), APP), null);
  assert.equal(L.deepLinkTarget("zvena://open?url=" + encodeURIComponent("javascript:alert(1)"), APP), null);
  assert.equal(L.deepLinkTarget("zvena://open", APP), null);
  // Before a server is set, a link has nowhere to go.
  assert.equal(L.deepLinkTarget("zvena://docs#x", null), null);
  assert.equal(L.navigationVerdict("https://zvena.example.com/docs", null, null), "browser");
  assert.equal(L.deepLinkTarget("zvena:////evil.example/x", APP), "https://zvena.example.com/evil.example/x");
  assert.equal(L.deepLinkTarget("zvena://docs/../../x", APP), "https://zvena.example.com/docs/x");
  assert.equal(L.deepLinkTarget("zvena://u:p@evil.example/", APP), null);
  assert.equal(L.deepLinkTarget("zvena://evil.example:8080/x", APP), null);
  assert.equal(L.deepLinkTarget("https://zvena.example.com/docs", APP), null);
  assert.equal(L.deepLinkTarget("zvena://" + "a".repeat(5000), APP), null);
  for (const raw of ["zvena://evil.example", "zvena://docs%2F%2Fevil.example", "zvena://\\\\evil.example", "zvena://@evil.example/", "zvena://[::1]/x", "zvena:%2F%2Fevil.example"]) {
    const out = L.deepLinkTarget(raw, APP);
    assert.ok(out === null || new URL(out).origin === APP, raw);
  }
  assert.equal(L.deepLinkInArgv(["/opt/zvena/zvena", "--no-sandbox", "zvena://docs#a"]), "zvena://docs#a");
  assert.equal(L.deepLinkInArgv(["/opt/zvena/zvena"]), null);
});

test("navigation: the app and its own subdomains stay, the rest goes to the browser or nowhere", () => {
  assert.equal(L.navigationVerdict("https://zvena.example.com/docs#x", APP, null), "app");
  assert.equal(L.navigationVerdict("https://design.zvena.example.com/#/workspace", APP, null), "app");
  assert.equal(L.navigationVerdict("https://design.example.com/", APP, "https://design.example.com"), "app");
  assert.equal(L.navigationVerdict("https://zvena.example.com.evil.example/", APP, null), "browser");
  assert.equal(L.navigationVerdict("https://evilzvena.example.com/", APP, null), "browser");
  assert.equal(L.navigationVerdict("http://design.zvena.example.com/", APP, null), "browser");
  assert.equal(L.navigationVerdict("https://www.youtube.com/watch?v=1", APP, null), "browser");
  assert.equal(L.navigationVerdict("mailto:hello@zvena.example.com", APP, null), "browser");
  assert.equal(L.navigationVerdict("file:///etc/passwd", APP, null), "block");
  assert.equal(L.navigationVerdict("javascript:alert(1)", APP, null), "block");
  assert.equal(L.navigationVerdict("data:text/html,<b>x</b>", APP, null), "block");
  assert.equal(L.navigationVerdict("zvena-ui://ui/settings.html", APP, null), "block");
  // Other sites' pages, sign-in pages included, open in the browser.
  assert.equal(L.navigationVerdict("https://accounts.google.com/o/oauth2/v2/auth?x", APP, null), "browser");
  assert.equal(L.navigationVerdict("https://github.com/someone/repo", APP, null), "browser");
  // A local test stand never trusts "subdomains" of an IP or localhost.
  assert.equal(L.isInAppUrl("http://x.localhost:3955/", "http://localhost:3955", null), false);
  assert.equal(L.isAppUrl("http://127.0.0.1:3955/home", "http://127.0.0.1:3955"), true);
  assert.equal(L.isAppUrl("http://127.0.0.1:3956/home", "http://127.0.0.1:3955"), false);
});

test("the quick search window hands over results, not its own search", () => {
  assert.equal(L.quickSearchStays("https://zvena.example.com/docs#search", APP), true);
  assert.equal(L.quickSearchStays("https://zvena.example.com/docs", APP), true);
  assert.equal(L.quickSearchStays("https://zvena.example.com/docs#Plan-0123456789abcdef0123456789abcdef", APP), false);
  assert.equal(L.quickSearchStays("https://zvena.example.com/projects", APP), false);
  assert.equal(L.samePage("https://zvena.example.com/docs#a", "https://zvena.example.com/docs/#a"), true);
  assert.equal(L.samePage("https://zvena.example.com/docs#a", "https://zvena.example.com/docs#b"), false);
});

test("global shortcuts: one key with a real modifier", () => {
  assert.equal(L.normalizeAccelerator("Alt+Shift+Space"), "Alt+Shift+Space");
  assert.equal(L.normalizeAccelerator("option + shift + space"), "Alt+Shift+Space");
  assert.equal(L.normalizeAccelerator("Cmd+Shift+k"), "CommandOrControl+Shift+K");
  assert.equal(L.normalizeAccelerator("ctrl+alt+pageup"), "Control+Alt+PageUp");
  assert.equal(L.normalizeAccelerator("Ctrl+F12"), "Control+F12");
  assert.equal(L.normalizeAccelerator("Ctrl+esc"), "Control+Escape");
  assert.equal(L.normalizeAccelerator("Space"), null);
  assert.equal(L.normalizeAccelerator("Shift+A"), null);
  assert.equal(L.normalizeAccelerator("Ctrl+Ctrl+A"), null);
  assert.equal(L.normalizeAccelerator("Ctrl+A+B"), null);
  assert.equal(L.normalizeAccelerator("Ctrl+Hyper"), null);
  assert.equal(L.normalizeAccelerator("Ctrl+F25"), null);
  assert.equal(L.normalizeAccelerator(""), null);
  assert.equal(L.normalizeAccelerator(42), null);
});

test("window shortcuts: ⌘ on macOS, Ctrl elsewhere", () => {
  const key = (k, mods = {}, code) => ({ type: "keyDown", key: k, code: code ?? (k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : ""), meta: false, control: false, alt: false, shift: false, ...mods });
  assert.deepEqual(L.shortcutAction(key("t", { meta: true }), true), { type: "newTab" });
  assert.deepEqual(L.shortcutAction(key("t", { control: true }), false), { type: "newTab" });
  assert.equal(L.shortcutAction(key("t", { control: true }), true), null);
  assert.deepEqual(L.shortcutAction(key("w", { meta: true }), true), { type: "closeTab" });
  assert.deepEqual(L.shortcutAction(key("T", { meta: true, shift: true }), true), { type: "reopenTab" });
  assert.deepEqual(L.shortcutAction(key("[", { meta: true }, "BracketLeft"), true), { type: "back" });
  assert.deepEqual(L.shortcutAction(key("]", { meta: true }, "BracketRight"), true), { type: "forward" });
  assert.deepEqual(L.shortcutAction(key("ArrowLeft", { alt: true }), false), { type: "back" });
  assert.equal(L.shortcutAction(key("ArrowLeft", { alt: true }), true), null);
  assert.deepEqual(L.shortcutAction(key("3", { meta: true }, "Digit3"), true), { type: "selectTab", index: 3 });
  assert.deepEqual(L.shortcutAction(key("Tab", { control: true }), true), { type: "nextTab" });
  assert.deepEqual(L.shortcutAction(key("Tab", { control: true, shift: true }), false), { type: "prevTab" });
  assert.deepEqual(L.shortcutAction(key("r", { control: true }), false), { type: "reload" });
  // The editor keeps its own keys: Ctrl+Alt+1 (heading), plain letters, keyUp.
  assert.equal(L.shortcutAction(key("1", { control: true, alt: true }, "Digit1"), false), null);
  assert.equal(L.shortcutAction(key("t"), false), null);
  assert.equal(L.shortcutAction({ ...key("t", { meta: true }), type: "keyUp" }, true), null);
  assert.equal(L.tabIndexFor(9, 4), 3);
  assert.equal(L.tabIndexFor(2, 4), 1);
  assert.equal(L.tabIndexFor(6, 4), -1);
  assert.equal(L.tabIndexFor(1, 0), -1);
});

test("window state: sane bounds on a real screen, app tabs only", () => {
  assert.deepEqual(L.cleanBounds({ x: 10.4, y: 20, width: 1200, height: 800 }), { x: 10, y: 20, width: 1200, height: 800 });
  assert.equal(L.cleanBounds({ width: 100, height: 800 }), null);
  assert.equal(L.cleanBounds("x"), null);
  const screens = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  assert.equal(L.onSomeDisplay({ x: 100, y: 100, width: 1200, height: 800 }, screens), true);
  assert.equal(L.onSomeDisplay({ x: 5000, y: 100, width: 1200, height: 800 }, screens), false);
  assert.deepEqual(L.restorableTabs({ tabs: ["https://zvena.example.com/docs#a", "https://evil.example/", 3, "https://zvena.example.com/home"], active: 1 }, APP), { tabs: ["https://zvena.example.com/docs#a", "https://zvena.example.com/home"], active: 1 });
  assert.deepEqual(L.restorableTabs({ tabs: ["https://zvena.example.com/a"], active: 7 }, APP), { tabs: ["https://zvena.example.com/a"], active: 0 });
  assert.deepEqual(L.restorableTabs(null, APP), { tabs: [], active: 0 });
});
