// Markdown of Documents: page export (blocks → Markdown) and the small
// renderer behind HTML export and previews. Pure code, no storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksToMarkdown, mdToHtml } from "@/lib/notes/markdown";

const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: t, styles });

test("mdToHtml escapes everything and keeps only safe links", () => {
  const html = mdToHtml('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://x.com/"onmouseover=1)');
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("javascript:"));
  assert.ok(!/href="[^"]*"[^>]*onmouseover/.test(html));
});

test("mdToHtml: underscores and stars in a URL stay in the URL", () => {
  const html = mdToHtml("[docs](https://ex.com/__init__/_a_/*b*)");
  assert.match(html, /<a href="https:\/\/ex\.com\/__init__\/_a_\/\*b\*" target="_blank"/);
  assert.ok(!html.includes("<strong>init"));
  assert.ok(!html.includes("<em>"));
});

test("mdToHtml: emphasis still works in link text and around links", () => {
  const html = mdToHtml("**bold** [*it*](https://ex.com) _x_");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/ex\.com"[^>]*><em>it<\/em><\/a>/);
  assert.match(html, /<em>x<\/em>/);
});

test("blocksToMarkdown: markers hug the text, edge spaces stay outside", () => {
  const md = blocksToMarkdown([para(text("Hello ", { bold: true }), text("world"), text(" it ", { italic: true }))]);
  assert.equal(md, "**Hello** world *it* ");
});

test("blocksToMarkdown: code with backticks gets a longer fence", () => {
  assert.equal(blocksToMarkdown([para(text("a`b", { code: true }))]), "`` a`b ``");
  assert.equal(blocksToMarkdown([para(text("plain", { code: true }))]), "`plain`");
  const block = blocksToMarkdown([{ type: "codeBlock", props: { language: "md" }, content: [text("```js\nx\n```")] }]);
  assert.equal(block, "````md\n```js\nx\n```\n````");
});

test("blocksToMarkdown: link and image targets with spaces or parentheses survive", () => {
  const md = blocksToMarkdown([
    para({ type: "link", href: "https://ex.com/a b_(c)", content: [text("x")] }),
    { type: "image", props: { url: "/api/notes/file/x y.png", caption: "pic" } },
  ]);
  assert.equal(md, "[x](https://ex.com/a%20b_%28c%29)\n![pic](/api/notes/file/x%20y.png)");
});

test("blocksToMarkdown: table cells stay on one row", () => {
  const md = blocksToMarkdown([{ type: "table", content: { type: "tableContent", rows: [{ cells: [[text("a\nb")], [text("c|d")]] }, { cells: [[text("1")], [text("2")]] }] } }]);
  assert.equal(md, "| a b | c\\|d |\n| --- | --- |\n| 1 | 2 |");
});
