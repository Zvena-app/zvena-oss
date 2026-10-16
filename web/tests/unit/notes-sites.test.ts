import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicStatic } from "@/components/notes/PublicStatic";
import { blankNote } from "@/lib/notes/model";
import { searchNotes, matchRanges, queryWords } from "@/lib/notes/search";
import { indexedNoteShares, noteShareExpired, noteShareViewsByDay, readNoteShare, saveNoteShare, validShareSnapshot } from "@/lib/notes/server-store";
import { SEO_DESCRIPTION_MAX, SEO_TITLE_MAX, cleanSiteOptions, siteExpired } from "@/lib/notes/sites";
import { sitemapEntries } from "@/lib/notes/sitemap";
import type { Note } from "@/lib/notes/types";

const DAY = 86_400_000;
const IMG = `/api/notes/file/${"a".repeat(40)}.png`;

test("site settings: lengths, images, expiry and theme are checked", () => {
  const now = Date.UTC(2026, 9, 14);
  const o = cleanSiteOptions(
    {
      noDup: true,
      index: "yes",
      seoTitle: `  ${"T".repeat(500)}\n`,
      seoDescription: "Описание\u0000 страницы  ",
      image: "https://tracker.example/pixel.png",
      expiresAt: now + 7 * DAY,
      outline: true,
      noCrumbs: true,
      theme: "neon",
      extra: 1,
    },
    now
  );
  assert.equal(o.noDup, true);
  assert.equal(o.index, undefined);
  assert.equal(o.seoTitle?.length, SEO_TITLE_MAX);
  assert.equal(o.seoDescription, "Описание страницы");
  assert.equal(o.image, undefined);
  assert.equal(o.expiresAt, now + 7 * DAY);
  assert.equal(o.theme, undefined);
  assert.equal((o as Record<string, unknown>).extra, undefined);
  assert.equal(cleanSiteOptions({ image: IMG }).image, IMG);
  assert.equal(cleanSiteOptions({ seoDescription: "x".repeat(1000) }).seoDescription?.length, SEO_DESCRIPTION_MAX);
  // Far-future expiry is refused; a past one is kept (that is how a link expires).
  assert.equal(cleanSiteOptions({ expiresAt: now + 100 * 366 * DAY }, now).expiresAt, undefined);
  assert.equal(cleanSiteOptions({ expiresAt: now - DAY }, now).expiresAt, now - DAY);
  assert.equal(siteExpired({ expiresAt: now - 1 }, now), true);
  assert.equal(siteExpired({}, now), false);
});

function published(ws: string, options: Record<string, unknown>, title = "Опубликовано"): { id: string; root: Note } {
  const root = blankNote({ kind: "page", title, content: [{ type: "paragraph", content: [{ type: "text", text: "Hello", styles: {} }] }] });
  const snap = validShareSnapshot({ notes: [root], rootId: root.id, options });
  assert.ok(snap);
  return { id: saveNoteShare(ws, "u1abcdef", root.id, snap), root };
}

test("published pages: expired links read as gone, views are counted by day, the sitemap lists indexed pages", () => {
  const ws = "ws-sites";
  const live = published(ws, { index: true, seoTitle: "SEO" });
  const hidden = published(ws, {});
  const gone = published(ws, { index: true, expiresAt: Date.now() - 1000 });
  assert.equal(readNoteShare(live.id)?.snapshot.options?.seoTitle, "SEO");
  assert.equal(readNoteShare(gone.id), null);
  assert.equal(noteShareExpired(gone.id), true);
  assert.equal(noteShareExpired(live.id), false);
  readNoteShare(live.id, true);
  readNoteShare(live.id, true);
  const days = noteShareViewsByDay(live.id, ws);
  assert.equal(days?.length, 28);
  assert.equal(days?.[27].n, 2);
  assert.equal(noteShareViewsByDay(live.id, "another-ws"), null);
  const ids = indexedNoteShares().map((s) => s.id);
  assert.ok(ids.includes(live.id));
  assert.ok(!ids.includes(hidden.id));
  assert.ok(!ids.includes(gone.id));
  const urls = sitemapEntries("https://zvena.example").map((e) => e.url);
  assert.ok(urls.includes("https://zvena.example/help"));
  assert.ok(urls.includes(`https://zvena.example/n/${live.id}`));
  assert.ok(!urls.includes(`https://zvena.example/n/${hidden.id}`));
});

test("the server-rendered public page: escaped text, safe links only, no comment marks or names", () => {
  const sub = blankNote({ kind: "page", title: "Подстраница" });
  const root = blankNote({
    kind: "page",
    title: "<script>alert(1)</script>",
    content: [
      { id: "h1", type: "heading", props: { level: 4 }, content: [{ type: "text", text: "Раздел", styles: {} }] },
      {
        id: "p1",
        type: "paragraph",
        content: [
          { type: "text", text: "<img src=x onerror=alert(1)>", styles: { bold: true } },
          { type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "плохая", styles: {} }] },
          { type: "link", href: "https://example.com/a", content: [{ type: "text", text: "хорошая", styles: {} }] },
          { type: "link", href: `/docs#Sub-${sub.id}`, content: [{ type: "text", text: "внутренняя", styles: {} }] },
          { type: "text", text: "обсуждаемый", styles: { comment: "thread1" } },
          { type: "mention", props: { userId: "secretuser1" } },
        ],
      },
      { id: "i1", type: "image", props: { url: "javascript:alert(1)", caption: "" } },
      { id: "d1", type: "design", props: { fileId: "f", frameId: "fr", name: "Главный экран" } },
      { id: "pg", type: "page", props: { noteId: sub.id } },
    ],
  });
  const snap = validShareSnapshot({ notes: [root, { ...sub, parentId: root.id }], rootId: root.id });
  assert.ok(snap);
  const html = renderToStaticMarkup(createElement(PublicStatic, { notes: snap.notes, rootId: snap.rootId, options: snap.options, updatedAt: Date.now(), locale: "ru", base: "https://zvena.example.com", shareId: "s".repeat(20) }));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes('href="https://example.com/a"'));
  assert.ok(html.includes(`href="#${sub.id}"`));
  assert.ok(html.includes("<h4"));
  assert.ok(html.includes("Главный экран"));
  assert.ok(html.includes("Сообщить о нарушении"), "the footer links Report abuse");
  assert.ok(!html.includes("thread1"));
  assert.ok(!html.includes("secretuser1"));
  assert.ok(html.includes("Подстраница"));
});

test("quick find: all words must match, titles rank first, filters narrow", () => {
  const now = Date.UTC(2026, 9, 14);
  const a = blankNote({ kind: "page", title: "План запуска", updatedAt: now - DAY, createdBy: "u1abcdef" });
  const b = blankNote({ kind: "page", title: "Заметки", content: [{ type: "paragraph", content: [{ type: "text", text: "план запуска продукта", styles: {} }] }], updatedAt: now, createdBy: "u2abcdef" });
  const c = blankNote({ kind: "page", title: "Запуск", updatedAt: now - 40 * DAY });
  const list = [a, b, c];
  const none = () => false;
  assert.deepEqual(searchNotes(list, "план запуска", none, {}, now).map((r) => r.note.id), [a.id, b.id]);
  assert.deepEqual(searchNotes(list, "план запуска", none, { titleOnly: true }, now).map((r) => r.note.id), [a.id]);
  assert.deepEqual(searchNotes(list, "запуск", none, { createdBy: new Set(["u2abcdef"]) }, now).map((r) => r.note.id), [b.id]);
  assert.deepEqual(searchNotes(list, "запуск", none, { since: now - 7 * DAY }, now).map((r) => r.note.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(searchNotes(list, "запуск", none, { since: now - 60 * DAY, until: now - 30 * DAY }, now).map((r) => r.note.id), [c.id]);
  assert.equal(searchNotes(list, "запуск", none, {}, now)[0].note.id, c.id);
  const snippet = searchNotes(list, "продукта", none, {}, now)[0].snippet;
  assert.ok(snippet.includes("продукта"));
  assert.deepEqual(matchRanges("План запуска плана", queryWords("план ЗАПУСКА")), [
    [0, 4],
    [5, 12],
    [13, 17],
  ]);
});
