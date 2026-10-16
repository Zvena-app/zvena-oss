import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, langCookieDomain, languageHint, resolveLocale, translate } from "@/lib/i18n";
import { LOCALES, dirOf, enRu, isLocale, localeOfTag, pluralOf, weekdayNames, weekdaysMondayFirst, weekStartIn } from "@/i18n/locales";
import { msg, setMessages } from "@/i18n/runtime";
import { notesT } from "@/lib/notes/i18n";
import { pt } from "@/components/projects/i18n";
import { ecoText } from "@/lib/eco/strings";
import { dt } from "@/components/zvena/ds/i18n";

test("i18n: ten languages, English first and the default; Arabic reads right to left", () => {
  assert.deepEqual([...LOCALES], ["en", "zh", "hi", "es", "ar", "fr", "bn", "pt", "ru", "id"]);
  assert.equal(resolveLocale(undefined), "en");
  assert.equal(resolveLocale("xx"), "en");
  assert.equal(resolveLocale("zh"), "zh");
  assert.equal(dirOf("ar"), "rtl");
  assert.equal(dirOf("hi"), "ltr");
  assert.equal(localeOfTag("pt-BR"), "pt");
  assert.equal(localeOfTag("zh-Hans-CN"), "zh");
  assert.equal(languageHint(["de-DE", "es-419", "en"]), "es");
  assert.equal(languageHint(["en-US", "fr"]), null, "an English browser keeps English");
  assert.equal(isLocale("ar"), true);
  assert.equal(enRu("zh"), "en");
  assert.equal(pluralOf("ar", 3), "few");
});

test("i18n: every namespace takes a catalog's string, keeps English and Russian from the code, and falls back to English", () => {
  setMessages("web", "es", { "nav.home": "Inicio" });
  setMessages("docs", "es", { "side.search": "Buscar" });
  setMessages("projects", "es", { "nav.inbox": "Bandeja de entrada" });
  setMessages("eco", "es", { related: "Relacionado" });
  setMessages("ds", "es", { undo: "Deshacer", selected: "{n} seleccionados" });
  assert.equal(translate("es", "nav.home"), "Inicio");
  assert.equal(translate("es", "nav.docs"), translate("en", "nav.docs"), "a missing key shows English");
  assert.equal(translate("ru", "nav.home"), "Главная");
  assert.equal(notesT("es", "side.search"), "Buscar");
  assert.equal(pt("es", "nav.inbox"), "Bandeja de entrada");
  assert.equal(pt("ru", "nav.inbox"), "Входящие");
  assert.equal(ecoText("es", "related"), "Relacionado");
  assert.equal(dt("es", "selected", { n: 3 }), "3 seleccionados");
  assert.equal(dt("fr", "undo"), "Undo", "no catalog yet: English");
  assert.equal(msg("ds", "es", "nope"), undefined);
});

test("i18n: sizes read the way each language writes them", () => {
  assert.equal(formatBytes(2 * 1024 ** 3, "en"), "2 GB");
  assert.equal(formatBytes(1.5 * 1024 ** 2, "ru"), "1,5 МБ");
  assert.equal(formatBytes(2 * 1024 ** 3, "fr").replace(/[\u00a0\u202f]/g, " "), "2 Go");
});

test("i18n: the word typed to delete an account is the one each language's prompt asks for", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const l of LOCALES) {
    const cat: Record<string, string> =
      l === "en" || l === "ru"
        ? { "settings.deleteWord": translate(l, "settings.deleteWord"), "settings.deleteConfirm": translate(l, "settings.deleteConfirm") }
        : JSON.parse(readFileSync(join(process.cwd(), "src/i18n/catalogs/web", `${l}.json`), "utf8"));
    const word = cat["settings.deleteWord"];
    assert.ok(word, `${l}: settings.deleteWord`);
    assert.ok(cat["settings.deleteConfirm"].includes(word), `${l}: the prompt names "${word}"`);
    assert.equal(word, word.toUpperCase(), `${l}: compared upper-cased`);
  }
});

test("i18n: the language cookie is shared with Design across example.com and its subdomains, never on localhost or an IP", () => {
  assert.equal(langCookieDomain("example.com"), "example.com");
  assert.equal(langCookieDomain("design.example.com"), "example.com");
  assert.equal(langCookieDomain("test-design.example.com"), "example.com");
  assert.equal(langCookieDomain("localhost"), null);
  assert.equal(langCookieDomain("127.0.0.1"), null);
  assert.equal(langCookieDomain("localhost:3195"), null);
});

test("i18n: weekday names start on Monday in every language, and fit a day grid when compact", () => {
  assert.deepEqual(weekdaysMondayFirst("en"), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.deepEqual(weekdaysMondayFirst("ru"), ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);
  for (const l of LOCALES) {
    const w = weekdaysMondayFirst(l, "compact");
    assert.equal(w.length, 7, l);
    assert.equal(new Set(w).size >= 5, true, `${l}: days are told apart`);
    for (const d of w) assert.ok([...d].length <= 4, `${l}: ${d}`);
  }
});

test("i18n: weeks start on the language's own first day (Sunday in the US, Monday in Europe)", () => {
  assert.equal(weekStartIn("en"), 0);
  assert.equal(weekStartIn("fr"), 1);
  assert.equal(weekStartIn("ru"), 1);
  assert.deepEqual(weekdayNames("en"), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  assert.equal(weekdayNames("fr")[0], "Lun.");
});
