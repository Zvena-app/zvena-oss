import { test } from "node:test";
import assert from "node:assert/strict";
import { intlOf, mondayFirstIn, nearDay } from "@/i18n/locales";
import "@/i18n/server-catalogs";
import { notesT } from "@/lib/notes/i18n";

test("dates and weeks follow the interface language, not just English and Russian", () => {
  assert.equal(intlOf("pt"), "pt-BR");
  assert.equal(intlOf("xx"), "en-US");
  assert.equal(nearDay("en", 0), "Today");
  assert.equal(nearDay("es", 1), "Mañana");
  assert.equal(nearDay("fr", -1), "Hier");
  assert.equal(mondayFirstIn("fr"), true);
  assert.equal(mondayFirstIn("en"), false);
  assert.equal(mondayFirstIn("pt"), false);
  // A Docs string in a catalog language (not English as a fallback).
  assert.equal(notesT("es", "noaccess.request"), "Solicitar acceso");
});

test("i18n: the assistant's issue templates are written in the interface language", async () => {
  await import("@/i18n/server-catalogs");
  const { describe } = await import("@/lib/projects/assist");
  const en = describe("The export button crashes the page", "en").description;
  assert.ok(en.startsWith("## What happens\n\nThe export button crashes the page\n\n## Steps to reproduce"), en);
  assert.ok(en.includes("- Browser / device: ") && en.includes("- [ ] A test covers it"), en);
  assert.ok(describe("Кнопка экспорта падает", "ru").description.startsWith("## Что происходит"));
  assert.ok(describe("El botón de exportar falla: crash", "es").description.startsWith("## Qué pasa"));
  assert.ok(describe("Add a pricing page", "zh").description.startsWith("## 背景"));
});

test("i18n: Docs time cells use the language's clock (12-hour en/hi/bn/ar, 24-hour elsewhere)", async () => {
  const { formatTimeLabel } = await import("@/lib/notes/dates");
  assert.equal(formatTimeLabel("19:05", "en"), "7:05 PM");
  assert.equal(formatTimeLabel("19:05", "hi"), "7:05 PM");
  for (const l of ["ru", "es", "fr", "pt", "zh", "id"]) assert.equal(formatTimeLabel("19:05", l), "19:05", l);
});

test("i18n: Docs templates are written in every language, and every row's option exists in its column", async () => {
  const { TEMPLATES } = await import("@/components/notes/templates");
  type N = { title: string; props?: { key: string; options?: { name: string }[] }[]; rows?: { values: Record<string, unknown> }[]; children?: N[] };
  const check = (n: N, lang: string) => {
    const names = new Map((n.props ?? []).map((p) => [p.key, new Set((p.options ?? []).map((o) => o.name))]));
    for (const r of n.rows ?? [])
      for (const [k, v] of Object.entries(r.values)) {
        if (v && typeof v === "object" && "option" in v) assert.ok(names.get(k)?.has((v as { option: string }).option), `${lang} ${n.title} ${k}`);
        if (v && typeof v === "object" && "options" in v) for (const o of (v as { options: string[] }).options) assert.ok(names.get(k)?.has(o), `${lang} ${n.title} ${k} ${o}`);
      }
    for (const c of n.children ?? []) check(c, lang);
  };
  for (const lang of ["en", "ru", "zh", "hi", "es", "ar", "fr", "bn", "pt", "id"])
    for (const t of TEMPLATES) {
      const n = t.build(lang) as N;
      check(n, lang);
      if (lang !== "en") assert.notEqual(JSON.stringify(n), JSON.stringify(t.build("en")), `${lang} ${t.key} translated`);
    }
});
