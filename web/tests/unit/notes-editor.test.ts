import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addEmoji, emojiName, listEmoji, removeEmoji } from "@/lib/notes/custom-emoji";
import { docxToHtml } from "@/lib/notes/docx";
import { blocksToHtml, type HtmlContext } from "@/lib/notes/html-export";
import { inferType, parseCsv, titleColumn, toIsoDate, trelloPlan } from "@/lib/notes/import-formats";
import { blocksToMarkdown, mdToHtml } from "@/lib/notes/markdown";
import { outlineOf } from "@/lib/notes/model";
import { zipStore } from "@/lib/science/zip";

test("Heading 4: Markdown export, HTML preview and the outline", () => {
  const blocks = [
    { id: "a", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Top", styles: {} }] },
    { id: "b", type: "heading", props: { level: 4 }, content: [{ type: "text", text: "Fourth", styles: {} }] },
  ];
  const md = blocksToMarkdown(blocks);
  assert.match(md, /^# Top$/m);
  assert.match(md, /^#### Fourth$/m);
  assert.match(mdToHtml(md), /<h4>Fourth<\/h4>/);
  assert.deepEqual(
    outlineOf(blocks).map((h) => h.level),
    [1, 4]
  );
});

const ctx: HtmlContext = {
  lookup: (id) => (id === "p1" ? { id: "p1", title: "Child page", icon: "📄" } : undefined),
  pageHref: (id) => (id === "p1" ? "Parent/Child%20page.html" : null),
  fileUrl: (url) => (url.startsWith("/api/notes/file/") ? `files/${url.split("/").pop()}` : url),
  untitled: "Untitled",
};

test("HTML export: headings, callouts, to-dos, colors, page links and files", () => {
  const html = blocksToHtml(
    [
      { type: "heading", props: { level: 4 }, content: [{ type: "text", text: "Section", styles: {} }] },
      { type: "callout", props: { icon: "⚠️", backgroundColor: "yellow" }, content: [{ type: "text", text: "Careful", styles: { bold: true } }] },
      { type: "checkListItem", props: { checked: true }, content: "Done" },
      { type: "checkListItem", props: { checked: false }, content: "Todo" },
      { type: "paragraph", content: [{ type: "text", text: "red", styles: { textColor: "red" } }, { type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "bad", styles: {} }] }] },
      { type: "page", props: { noteId: "p1" } },
      { type: "image", props: { url: "/api/notes/file/abc.png", caption: "Pic" } },
      { type: "paragraph", content: [{ type: "text", text: "<script>", styles: {} }] },
    ],
    ctx
  );
  assert.match(html, /<h4>Section<\/h4>/);
  assert.match(html, /class="callout" style="background:#fbf3db"/);
  assert.match(html, /<strong>Careful<\/strong>/);
  assert.match(html, /<ul class="todos"><li class="todo"><input type="checkbox" disabled checked> Done<\/li><li class="todo"><input type="checkbox" disabled> Todo<\/li><\/ul>/);
  assert.match(html, /color:#d44c47/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="Parent\/Child%20page.html">📄 Child page<\/a>/);
  assert.match(html, /<img src="files\/abc.png" alt="Pic">/);
  assert.match(html, /&lt;script&gt;/);
});

test("link mentions and custom emoji export as links and :names:", () => {
  const blocks = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "See ", styles: {} },
        { type: "linkMention", props: { url: "https://example.com/a b", title: "Example page", icon: "" } },
        { type: "customEmoji", props: { name: "parrot", url: `/api/notes/file/${"b".repeat(40)}.png` } },
        { type: "linkMention", props: { url: "javascript:alert(1)", title: "x", icon: "" } },
      ],
    },
  ];
  assert.match(blocksToMarkdown(blocks), /\[Example page\]\(https:\/\/example\.com\/a%20b\):parrot:/);
  const html = blocksToHtml(blocks, ctx);
  assert.match(html, /<a class="mention" href="https:\/\/example.com\/a b">Example page<\/a>/);
  assert.match(html, /<img class="emoji" src="files\/b{40}\.png" alt=":parrot:">/);
  assert.doesNotMatch(html, /javascript:/);
});

test("CSV: Jira and Asana columns, dates and the title column", () => {
  assert.equal(toIsoDate("01/Oct/26 3:22 PM"), "2026-10-01");
  assert.equal(toIsoDate("31.12.2026"), "2026-12-31");
  assert.equal(toIsoDate("12/31/2026"), "2026-12-31");
  assert.equal(toIsoDate("2026-05-04T10:00:00Z"), "2026-05-04");
  assert.equal(toIsoDate("Bug fix"), null);
  assert.equal(inferType(["01/Oct/26 3:22 PM", "15/Sep/26 9:00 AM"], "Created"), "date");
  assert.equal(inferType(["Open", "Done", "Open"], "Status"), "select");
  assert.equal(inferType(["frontend, urgent", "backend"], "Labels"), "multi_select");
  assert.equal(inferType(["12", "7", "3,5"], "Estimate"), "number");
  assert.equal(inferType(["", ""], "Due Date"), "date");
  assert.equal(titleColumn(["Task ID", "Created At", "Name", "Section/Column"]), 2);
  assert.equal(titleColumn(["Summary", "Issue key", "Status"]), 0);
  assert.equal(titleColumn(["Foo", "Bar"]), 0);
  assert.deepEqual(parseCsv("Имя;Статус\nА;Готово\n"), [
    ["Имя", "Статус"],
    ["А", "Готово"],
  ]);
});

test("Trello: lists become statuses, labels tags, checklists and comments stay with the card", () => {
  let n = 0;
  const plan = trelloPlan(
    {
      name: "Sprint",
      lists: [
        { id: "l1", name: "To Do", pos: 1 },
        { id: "l2", name: "In Progress", pos: 2 },
        { id: "l3", name: "Done", pos: 3 },
        { id: "l4", name: "Old", pos: 4, closed: true },
      ],
      labels: [
        { id: "g", name: "Bug", color: "red" },
        { id: "s", name: "", color: "sky" },
      ],
      members: [{ id: "m1", fullName: "Anna" }],
      cards: [
        { id: "c2", name: "Second", idList: "l2", pos: 1, idLabels: ["s"], idMembers: ["m1"] },
        { id: "c1", name: "First", idList: "l1", pos: 2, idLabels: ["g"], due: "2026-10-20T09:00:00.000Z", desc: "**Hi**", shortUrl: "https://trello.com/c/x" },
        { id: "c3", name: "Archived", idList: "l1", closed: true },
        { id: "c4", name: "In closed list", idList: "l4" },
      ],
      checklists: [{ id: "k", idCard: "c1", name: "Steps", checkItems: [{ name: "b", state: "incomplete", pos: 2 }, { name: "a", state: "complete", pos: 1 }] }],
      actions: [
        { type: "commentCard", date: "2026-10-02T00:00:00Z", data: { text: "later", card: { id: "c1" } }, memberCreator: { fullName: "Boris" } },
        { type: "commentCard", date: "2026-10-01T00:00:00Z", data: { text: "first", card: { id: "c1" } }, memberCreator: { fullName: "Anna" } },
      ],
    },
    () => `id${++n}`
  );
  assert.equal(plan.title, "Sprint");
  assert.deepEqual(
    plan.statuses.map((s) => [s.name, s.group]),
    [
      ["To Do", "todo"],
      ["In Progress", "doing"],
      ["Done", "done"],
    ]
  );
  assert.deepEqual(
    plan.labels.map((l) => [l.name, l.color]),
    [
      ["Bug", "red"],
      ["sky", "blue"],
    ]
  );
  assert.deepEqual(
    plan.rows.map((r) => r.title),
    ["First", "Second"]
  );
  const first = plan.rows[0];
  assert.equal(first.status, "To Do");
  assert.equal(first.due, "2026-10-20");
  assert.deepEqual(first.checklists[0].items, [
    { text: "a", done: true },
    { text: "b", done: false },
  ]);
  assert.deepEqual(
    first.comments.map((c) => c.text),
    ["first", "later"]
  );
  assert.equal(plan.rows[1].members, "Anna");
});

function docxFixture(): ArrayBuffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const para = (style: string | null, runs: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${runs}</w:p>`;
  const run = (text: string, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const style = (id: string, name: string) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`;
  const bytes = zipStore([
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: "word/styles.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${style("Title", "Title")}${style("Heading1", "heading 1")}${style("Heading4", "heading 4")}</w:styles>` },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${para("Title", run("Квартальный отчёт"))}${para("Heading1", run("Итоги"))}${para(null, run("Жирный", true) + run(" и обычный"))}${para("Heading4", run("Детали"))}</w:body></w:document>`,
    },
  ]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

test("Word: title, headings 1 and 4, bold text", async () => {
  const r = await docxToHtml(docxFixture());
  assert.equal(r.title, "Квартальный отчёт");
  assert.match(r.html, /^<h1>Итоги<\/h1>/);
  assert.match(r.html, /<p><strong>Жирный<\/strong> и обычный<\/p>/);
  assert.match(r.html, /<h4>Детали<\/h4>/);
});

test("custom emoji: names, uploaded images only, one per name", () => {
  const ws = "ws-emoji";
  const url = `/api/notes/file/${"a".repeat(40)}.png`;
  assert.equal(emojiName(" :Party Parrot!: "), "party-parrot");
  assert.equal(addEmoji(ws, "party-parrot", url, "u1abcdef").ok, true);
  assert.deepEqual(addEmoji(ws, "party-parrot", url, "u1abcdef"), { ok: false, error: "taken" });
  assert.deepEqual(addEmoji(ws, "evil", "https://evil.example/x.png", "u1abcdef"), { ok: false, error: "bad file" });
  assert.deepEqual(addEmoji(ws, "Bad Name", url, "u1abcdef"), { ok: false, error: "bad name" });
  assert.deepEqual(
    listEmoji(ws).map((e) => [e.name, e.url]),
    [["party-parrot", url]]
  );
  assert.equal(removeEmoji(ws, "party-parrot"), true);
  assert.equal(listEmoji(ws).length, 0);
});

test("a Tabs block: each tab's title then its blocks, in Markdown, HTML, search text and the API", async () => {
  const { blocksText } = await import("@/lib/notes/model");
  const { toNotionTypeOf } = await import("@/lib/notes/api/blocks");
  const para = (id: string, text: string) => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
  const tabs = {
    id: "tb1",
    type: "tabs",
    props: {},
    children: [
      { id: "t1", type: "tab", props: { title: "Overview" }, children: [para("p1", "First tab text")] },
      { id: "t2", type: "tab", props: { title: "Notes <b>" }, children: [para("p2", "Second tab text")] },
    ],
  };
  const md = blocksToMarkdown([tabs] as never);
  assert.ok(md.indexOf("**Overview**") < md.indexOf("First tab text") && md.indexOf("First tab text") < md.indexOf("**Notes <b>**"), md);
  assert.ok(md.includes("Second tab text"));
  const html = blocksToHtml([tabs], ctx);
  assert.ok(html.includes('<div class="tabs">') && html.includes('<h4 class="tab-title">Overview</h4>') && html.includes("Notes &lt;b&gt;"), html);
  assert.ok(html.includes("First tab text") && html.includes("Second tab text"));
  const text = blocksText([tabs] as never);
  assert.ok(text.includes("First tab text") && text.includes("Second tab text"), text);
  assert.equal(toNotionTypeOf(tabs as never), "column_list");
  assert.equal(toNotionTypeOf(tabs.children[0] as never), "column");
});
