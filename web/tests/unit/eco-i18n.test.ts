// The ecosystem's words in every interface language: placeholders filled,
// unknown languages fall back to English, Russian and English from the
// module's own dictionaries.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES } from "@/i18n/locales";
import { ecoText, en, ru, type EcoKey } from "@/lib/eco/strings";

test("ecoText fills placeholders in every language and falls back to English", () => {
  for (const l of LOCALES) {
    const s = ecoText(l, "paletteGoto", { place: "PLACE" });
    assert.ok(s.includes("PLACE"), `${l}: ${s}`);
    assert.ok(!s.includes("{place}"), `${l}: ${s}`);
    assert.ok(ecoText(l, "inboxEmpty").trim().length > 0, l);
  }
  assert.equal(ecoText("xx", "untitled"), en.untitled);
  assert.equal(ecoText("ru", "untitled"), ru.untitled);
  assert.equal(ecoText("en", "paletteNew", { item: "Doc" }), "New: Doc");
  // An unknown placeholder stays as written; a missing value never prints "undefined".
  assert.equal(ecoText("en", "paletteNew"), "New: {item}");
});

test("Russian covers every English key", () => {
  for (const k of Object.keys(en) as EcoKey[]) assert.ok(typeof ru[k] === "string" && ru[k].length > 0, k);
});
