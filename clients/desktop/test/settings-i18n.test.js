"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Settings, clean, DEFAULTS } = require("../src/settings");
const { DICTS, LOCALES, localeOf, translator } = require("../src/i18n");

test("settings: bad values fall back, a saved file round-trips", () => {
  assert.deepEqual(clean(null), { ...DEFAULTS });
  const c = clean({ serverUrl: "http://evil.example", designUrl: "https://design.example.com/x", quickSearchShortcut: "Space", launchAtLogin: "yes", openLinksInApp: false, windows: [{ tabs: ["https://zvena.app/home", 5], bounds: { width: 900, height: 700 }, maximized: true, active: 0 }, "junk"] });
  assert.equal(c.serverUrl, DEFAULTS.serverUrl);
  assert.equal(c.designUrl, "https://design.example.com");
  assert.equal(c.quickSearchShortcut, DEFAULTS.quickSearchShortcut);
  assert.equal(c.launchAtLogin, false);
  assert.equal(c.openLinksInApp, false);
  assert.deepEqual(c.windows, [{ bounds: { width: 900, height: 700 }, maximized: true, tabs: ["https://zvena.app/home"], active: 0 }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zvena-desktop-"));
  try {
    const s = new Settings(dir);
    s.set({ serverUrl: "https://my.zvena.example/", quickSearchShortcut: "ctrl+shift+k" });
    const again = new Settings(dir);
    assert.equal(again.get("serverUrl"), "https://my.zvena.example");
    assert.equal(again.get("quickSearchShortcut"), "Control+Shift+K");
    fs.writeFileSync(path.join(dir, "zvena-settings.json"), "{broken");
    assert.deepEqual(new Settings(dir).data, { ...DEFAULTS });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("i18n: ten languages, every key everywhere, placeholders kept", () => {
  assert.deepEqual(LOCALES, ["en", "zh", "hi", "es", "ar", "fr", "bn", "pt", "ru", "id"]);
  const keys = Object.keys(DICTS.en).sort();
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(DICTS[l]).sort(), keys, l);
    for (const k of keys) {
      assert.ok(DICTS[l][k].trim(), `${l}.${k}`);
      assert.equal((DICTS[l][k].match(/\{\w+\}/g) || []).join(), (DICTS.en[k].match(/\{\w+\}/g) || []).join(), `${l}.${k}`);
    }
  }
  assert.equal(localeOf("pt-BR"), "pt");
  assert.equal(localeOf("zh_CN"), "zh");
  assert.equal(localeOf("in"), "id");
  assert.equal(localeOf("de-DE"), "en");
  assert.equal(translator("fr")("lookUp", { word: "zvena" }), "Rechercher « zvena »");
  assert.equal(translator("xx")("newTab"), "New tab");
});

test("no word of the app mentions a country", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");
  assert.equal(/russia|росси/i.test(text), false);
});
