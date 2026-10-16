import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signInWith } from "@/lib/auth";
import { connectPage, createIntegration, integrationBySecret, revokeIntegration, rotateSecret, updateIntegration, webhookSecretOf } from "@/lib/notes/api/integrations";
import { fromNotionBlocks, readableBlocks, toNotionBlock } from "@/lib/notes/api/blocks";
import { contexts, Directory } from "@/lib/notes/api/objects";
import { propertyValue, valuesFromRequest } from "@/lib/notes/api/properties";
import { matches, paginate, sortRows } from "@/lib/notes/api/query";
import { resetRate, takeToken } from "@/lib/notes/api/respond";
import { fromRichText, toRichText } from "@/lib/notes/api/richtext";
import { Space, toUuid } from "@/lib/notes/api/space";
import { eventsOf, flushWebhooks, httpsSender, setSender, signature, webhookReaction } from "@/lib/notes/api/webhooks";
import { blankNote, defaultView } from "@/lib/notes/model";
import { pullNotes, pushNotes } from "@/lib/notes/server-store";
import type { DbSchema, Note } from "@/lib/notes/types";
import { createWorkspace } from "@/lib/workspaces";
import * as pagesRoute from "@/app/api/v1/pages/route";
import * as pageRoute from "@/app/api/v1/pages/[id]/route";
import * as queryRoute from "@/app/api/v1/databases/[id]/query/route";
import * as childrenRoute from "@/app/api/v1/blocks/[id]/children/route";
import * as searchRoute from "@/app/api/v1/search/route";
import * as commentsRoute from "@/app/api/v1/comments/route";
import * as meRoute from "@/app/api/v1/users/me/route";

const user = (name: string) => {
  const r = signInWith({ provider: "dev", subject: `api-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
};

const owner = user("Владелец API");
const ws = createWorkspace(owner, "API").id;
const push = (notes: Note[]) => pushNotes(ws, notes.map((n) => ({ id: n.id, note: n })), { by: owner, quotaLeft: Infinity, author: "Владелец API" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx?: { params: Promise<any> }) => Promise<Response>;

function call(handler: Handler, secret: string, opts: { method?: string; body?: unknown; params?: Record<string, string>; url?: string } = {}) {
  const req = new Request(opts.url ?? "http://localhost/api/v1/x", {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "zvena-version": "2022-06-28" },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  // The rate limit has its own test; here every call gets a fresh bucket.
  resetRate();
  return handler(req, { params: Promise.resolve(opts.params ?? {}) });
}

test("integrations: the secret is shown once, works until rotated or revoked", () => {
  const { integration, secret } = createIntegration(owner, ws, { name: "Sync bot", caps: { insert: false } });
  assert.match(secret, /^zv_secret_[A-Za-z0-9_-]{43}$/);
  assert.equal(integrationBySecret(secret)?.id, integration.id);
  assert.equal(integrationBySecret(secret)?.caps.insert, false);
  assert.equal(integrationBySecret(`${secret.slice(0, -1)}x`), null);
  const fresh = rotateSecret(owner, ws, integration.id) as string;
  assert.equal(integrationBySecret(secret), null);
  assert.equal(integrationBySecret(fresh)?.id, integration.id);
  assert.ok(revokeIntegration(owner, ws, integration.id));
  assert.equal(integrationBySecret(fresh), null);
});

test("connections: an integration sees connected pages and what is under them, nothing else", () => {
  const { integration } = createIntegration(owner, ws, { name: "Reader" });
  const a = blankNote({ kind: "page", title: "Shared root" });
  const b = blankNote({ kind: "page", title: "Child", parentId: a.id });
  const c = blankNote({ kind: "page", title: "Private" });
  push([a, b, c]);
  assert.ok(connectPage(owner, ws, integration.id, a.id));
  assert.equal(connectPage(owner, "other-ws-id", integration.id, a.id), false);
  const space = Space.load(integration);
  assert.equal(space.note(b.id)?.title, "Child");
  assert.equal(space.note(toUuid(b.id))?.title, "Child");
  assert.equal(space.note(c.id), null);
});

test("blocks: Notion block objects ↔ BlockNote blocks", () => {
  const ok = () => true;
  const blocks = fromNotionBlocks(
    [
      { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "План" }, annotations: { bold: true, color: "red" } }] } },
      { type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "сайт", link: { url: "https://zvena.app" } } }], color: "blue_background" } },
      { type: "to_do", to_do: { rich_text: [{ text: { content: "Сделать" } }], checked: true } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: "Пункт" } }], children: [{ type: "paragraph", paragraph: { rich_text: [{ text: { content: "вложено" } }] } }] } },
      { type: "code", code: { language: "javascript", rich_text: [{ text: { content: "let a = 1;" } }] } },
      { type: "callout", callout: { icon: { type: "emoji", emoji: "🔥" }, color: "gray_background", rich_text: [{ text: { content: "Важно" } }] } },
      { type: "divider", divider: {} },
      { type: "equation", equation: { expression: "e=mc^2" } },
      { type: "image", image: { type: "external", external: { url: "https://example.com/a.png" } } },
      { type: "table", table: { table_width: 2, has_column_header: true, children: [{ type: "table_row", table_row: { cells: [[{ text: { content: "A" } }], [{ text: { content: "B" } }]] } }] } },
      { type: "column_list", column_list: { children: [{ type: "column", column: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } }, { type: "column", column: { children: [] } }] } },
      { type: "toggle", toggle: { rich_text: [{ text: { content: "Скрыто" } }] } },
      { type: "quote", quote: { rich_text: [{ text: { content: "Цитата" } }] } },
      { type: "bookmark", bookmark: { url: "https://zvena.app" } },
    ],
    ok
  );
  assert.equal(blocks.length, 14);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "checkListItem", "bulletListItem", "codeBlock", "callout", "divider", "equation", "image", "table", "columnList", "toggleListItem", "quote", "bookmark"]);
  assert.throws(() => fromNotionBlocks([{ type: "image", image: { type: "external", external: { url: "javascript:alert(1)" } } }], ok));
  assert.throws(() => fromNotionBlocks([{ type: "child_page", child_page: { title: "x" } }], ok));
  const page = blankNote({ kind: "page", title: "P", content: blocks });
  const space = new Space({ id: "x".repeat(32), ws, name: "t", icon: "", caps: { read: true, update: true, insert: true, readComments: true, insertComments: true, users: "names" }, createdBy: owner, createdAt: 0, updatedAt: 0, webhook: null }, [page], [page.id]);
  const ctx = contexts(space, new Directory(space.integration), page.id);
  const out = blocks.map((b) => toNotionBlock(b, page, null, ctx));
  assert.deepEqual(out.map((b) => b.type), ["heading_2", "paragraph", "to_do", "bulleted_list_item", "code", "callout", "divider", "equation", "image", "table", "column_list", "toggle", "quote", "bookmark"]);
  const h = out[0].heading_2 as { rich_text: { plain_text: string; annotations: { bold: boolean; color: string } }[] };
  assert.equal(h.rich_text[0].plain_text, "План");
  assert.equal(h.rich_text[0].annotations.bold, true);
  assert.equal(h.rich_text[0].annotations.color, "red");
  assert.equal((out[1].paragraph as { color: string }).color, "blue_background");
  assert.equal((out[1].paragraph as { rich_text: { href: string }[] }).rich_text[0].href, "https://zvena.app");
  assert.equal((out[2].to_do as { checked: boolean }).checked, true);
  assert.equal(out[3].has_children, true);
  assert.equal((out[4].code as { language: string }).language, "javascript");
  assert.equal((out[9].table as { has_column_header: boolean; table_width: number }).table_width, 2);
  // Rich text round trip with mentions and an equation.
  const rich = fromRichText([{ type: "mention", mention: { type: "date", date: { start: "2026-10-14T09:30:00.000+03:00" } } }, { type: "equation", equation: { expression: "x^2" } }]);
  assert.deepEqual(toRichText(rich, ctx).map((r) => r.type), ["mention", "equation"]);
  assert.equal(toRichText(rich, ctx)[0].plain_text, "2026-10-14T09:30");
});

const schema: DbSchema = {
  properties: [
    { id: "title", name: "Name", type: "title" },
    { id: "st", name: "Status", type: "status", options: [{ id: "todo", name: "Not started", color: "default", group: "todo" }, { id: "done", name: "Done", color: "green", group: "done" }] },
    { id: "tags", name: "Tags", type: "multi_select", options: [{ id: "a", name: "Alpha", color: "blue" }] },
    { id: "n", name: "Points", type: "number" },
    { id: "d", name: "Due", type: "date" },
    { id: "ok", name: "Done?", type: "checkbox" },
    { id: "who", name: "Owner", type: "person" },
    { id: "f", name: "Double", type: "formula", formula: { expr: 'prop("Points") * 2' } },
  ],
  views: [],
};

test("properties: request values ↔ Notion property values", () => {
  const w = valuesFromRequest(
    schema,
    {
      Name: { title: [{ text: { content: "Задача" } }] },
      Status: { status: { name: "Done" } },
      Tags: { multi_select: [{ name: "Alpha" }, { name: "Beta" }] },
      Points: { number: 3 },
      Due: { date: { start: "2026-10-20" } },
      "Done?": { checkbox: true },
      Owner: { people: [{ id: owner }] },
    },
    { related: () => false, member: (id) => id === owner }
  );
  assert.equal(w.title, "Задача");
  assert.equal(w.props.st, "done");
  assert.equal((w.props.tags as string[]).length, 2);
  assert.equal(w.newOptions.length, 1);
  assert.throws(() => valuesFromRequest(schema, { Double: { formula: {} } }, { related: () => false, member: () => false }));
  assert.throws(() => valuesFromRequest(schema, { Owner: { people: [{ id: "stranger1" }] } }, { related: () => false, member: () => false }));
  const row = blankNote({ kind: "page", title: "Задача", props: w.props, computed: { f: 6 } });
  const space = new Space({ id: "y".repeat(32), ws, name: "t", icon: "", caps: { read: true, update: true, insert: true, readComments: true, insertComments: true, users: "names" }, createdBy: owner, createdAt: 0, updatedAt: 0, webhook: null }, [row], [row.id]);
  const ctx = contexts(space, new Directory(space.integration), row.id);
  const val = (id: string) => propertyValue(row, schema.properties.find((p) => p.id === id) as DbSchema["properties"][number], schema, ctx);
  assert.equal((val("st").status as { name: string }).name, "Done");
  assert.deepEqual((val("d").date as { start: string }).start, "2026-10-20");
  assert.deepEqual(val("f").formula, { type: "number", number: 6 });
  assert.equal((val("who").people as { id: string; name?: string }[])[0].name, "Владелец API");
});

test("query: Notion filters and sorts over rows, with cursors", () => {
  const rows = [
    blankNote({ kind: "page", title: "B", props: { n: 5, st: "done", tags: ["a"], d: { start: "2026-10-01" } } }),
    blankNote({ kind: "page", title: "A", props: { n: 1, st: "todo", tags: [] } }),
    blankNote({ kind: "page", title: "C", props: { n: 9, st: "done", tags: ["a"], d: { start: "2026-12-01" } } }),
  ];
  const names = () => "";
  const now = Date.parse("2026-10-14T12:00:00Z");
  const f = { and: [{ property: "Status", status: { equals: "Done" } }, { or: [{ property: "Points", number: { greater_than: 6 } }, { property: "Due", date: { before: "2026-10-10" } }] }] };
  assert.deepEqual(rows.filter((r) => matches(r, schema, f, now, names)).map((r) => r.title), ["B", "C"]);
  assert.deepEqual(rows.filter((r) => matches(r, schema, { property: "Tags", multi_select: { is_empty: true } }, now, names)).map((r) => r.title), ["A"]);
  assert.throws(() => matches(rows[0], schema, { property: "Nope", rich_text: { equals: "x" } }, now, names));
  assert.deepEqual(sortRows(rows, schema, [{ property: "Points", direction: "descending" }], names).map((r) => r.title), ["C", "B", "A"]);
  assert.deepEqual(sortRows(rows, schema, [{ property: "Name", direction: "ascending" }], names).map((r) => r.title), ["A", "B", "C"]);
  const p1 = paginate([1, 2, 3], undefined, 2, "page_or_database");
  assert.equal(p1.has_more, true);
  const p2 = paginate([1, 2, 3], p1.next_cursor, 2, "page_or_database");
  assert.deepEqual(p2.results, [3]);
  assert.equal(p2.has_more, false);
  assert.throws(() => paginate([1], "bogus", 2, "x"));
  assert.throws(() => paginate([1], undefined, 101, "x"));
});

test("rate limit: bursts of 10, then about 3 a second", () => {
  resetRate("rl");
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) assert.equal(takeToken("rl", t0), 0);
  assert.ok(takeToken("rl", t0) > 0);
  assert.equal(takeToken("rl", t0 + 400), 0);
});

test("REST: create, read, append, query, search and comment through the routes", async () => {
  resetRate();
  const { integration, secret } = createIntegration(owner, ws, { name: "Writer" });
  const root = blankNote({ kind: "page", title: "Integration root" });
  const db = blankNote({ kind: "database", title: "Tasks", parentId: root.id });
  db.db = { ...schema, views: [defaultView("table", "Table")] };
  push([root, db]);
  connectPage(owner, ws, integration.id, root.id);

  const me = await (await call(meRoute.GET, secret)).json();
  assert.equal(me.type, "bot");
  assert.equal(me.name, "Writer");
  assert.equal((await call(meRoute.GET, "zv_secret_" + "x".repeat(43))).status, 401);

  const created = await call(pagesRoute.POST, secret, { body: { parent: { page_id: toUuid(root.id) }, properties: { title: { title: [{ text: { content: "Из API" } }] } }, children: [{ type: "paragraph", paragraph: { rich_text: [{ text: { content: "Привет" } }] } }] } });
  assert.equal(created.status, 200);
  const page = await created.json();
  assert.equal(page.object, "page");
  assert.equal(page.properties.title.title[0].plain_text, "Из API");
  assert.equal(page.created_by.id, toUuid(integration.id));

  const stored = pullNotes(ws, 0).notes.find((n) => n.id === page.id.replace(/-/g, "")) as Note;
  assert.equal(stored.createdBy, `integration:${integration.id}`);
  const parent = pullNotes(ws, 0).notes.find((n) => n.id === root.id) as Note;
  assert.ok(JSON.stringify(parent.content).includes(stored.id), "the sub-page appears in its parent's body");

  const appended = await call(childrenRoute.PATCH, secret, { method: "PATCH", params: { id: page.id }, body: { children: [{ type: "to_do", to_do: { rich_text: [{ text: { content: "Шаг" } }] } }] } });
  assert.equal(appended.status, 200);
  const kids = await (await call(childrenRoute.GET, secret, { params: { id: page.id } })).json();
  assert.deepEqual(kids.results.map((b: { type: string }) => b.type), ["paragraph", "to_do"]);

  for (const [title, points] of [["Первая", 2], ["Вторая", 8]] as const) {
    const r = await call(pagesRoute.POST, secret, { body: { parent: { database_id: toUuid(db.id) }, properties: { Name: { title: [{ text: { content: title } }] }, Points: { number: points }, Status: { status: { name: "Done" } } } } });
    assert.equal(r.status, 200, await r.clone().text());
  }
  const q = await (await call(queryRoute.POST, secret, { params: { id: db.id }, body: { filter: { property: "Points", number: { greater_than: 5 } } } })).json();
  assert.deepEqual(q.results.map((p: { properties: { Name: { title: { plain_text: string }[] } } }) => p.properties.Name.title[0].plain_text), ["Вторая"]);
  assert.deepEqual(q.results[0].properties.Double.formula, { type: "number", number: 16 });

  const s = await (await call(searchRoute.POST, secret, { body: { query: "из api" } })).json();
  assert.equal(s.results[0].id, page.id);

  const patched = await (await call(pageRoute.PATCH, secret, { method: "PATCH", params: { id: page.id }, body: { in_trash: true } })).json();
  assert.equal(patched.in_trash, true);

  const cm = await call(commentsRoute.POST, secret, { body: { parent: { page_id: toUuid(root.id) }, rich_text: [{ text: { content: "Готово" } }] } });
  assert.equal(cm.status, 200);
  const list = await (await call(commentsRoute.GET, secret, { url: `http://localhost/api/v1/comments?block_id=${toUuid(root.id)}` })).json();
  assert.equal(list.results[0].rich_text[0].plain_text, "Готово");
  assert.equal(list.results[0].display_name.resolved_name, "Writer");

  // Pages that were not connected stay invisible.
  const other = blankNote({ kind: "page", title: "Не для бота" });
  push([other]);
  assert.equal((await call(pageRoute.GET, secret, { params: { id: other.id } })).status, 404);
  // A capability the integration lacks.
  const ro = createIntegration(owner, ws, { name: "Read only", caps: { insert: false } });
  connectPage(owner, ws, ro.integration.id, root.id);
  const denied = await call(pagesRoute.POST, ro.secret, { body: { parent: { page_id: root.id }, properties: {} } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "restricted_resource");
  const bad = await call(pagesRoute.POST, secret, { body: { parent: { page_id: root.id }, children: [{ type: "image", image: { external: { url: "http://insecure" } } }] } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "validation_error");
});

test("webhooks: signed, only subscribed events of visible pages, never private addresses", async () => {
  const { integration } = createIntegration(owner, ws, { name: "Hook" });
  const upd = updateIntegration(owner, ws, integration.id, { webhook: { url: "https://hooks.example.com/zvena", events: ["page.created", "comment.created"] } });
  assert.ok(upd?.webhookSecret?.startsWith("zv_whsec_"));
  assert.equal(webhookSecretOf(integration.id), upd?.webhookSecret);
  const root = blankNote({ kind: "page", title: "Hooked" });
  push([root]);
  connectPage(owner, ws, integration.id, root.id);
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  setSender(async (url, body, headers) => {
    sent.push({ url, body, headers });
    return 200;
  });
  const child = blankNote({ kind: "page", title: "New", parentId: root.id });
  const hidden = blankNote({ kind: "page", title: "Elsewhere" });
  push([child, hidden]);
  await flushWebhooks();
  const types = sent.map((s) => JSON.parse(s.body).type);
  assert.deepEqual(types, ["page.created"]);
  const body = sent[0].body;
  assert.equal(sent[0].headers["x-zvena-signature"], `sha256=${createHmac("sha256", upd?.webhookSecret as string).update(body).digest("hex")}`);
  assert.equal(signature("k", "b"), `sha256=${createHmac("sha256", "k").update("b").digest("hex")}`);
  // Its own writes are not echoed back.
  assert.equal(webhookReaction([{ id: child.id, before: null, after: child }], { ws, by: `integration:${integration.id}` }), 0);
  assert.deepEqual(eventsOf({ id: child.id, before: child, after: { ...child, content: [{ type: "paragraph" }] } }).map((e) => e.type), ["page.content_updated"]);
  // Private and loopback addresses are refused before any connection.
  assert.equal(await httpsSender("https://127.0.0.1/hook", "{}", {}), 0);
  assert.equal(await httpsSender("https://10.0.0.5/hook", "{}", {}), 0);
  assert.equal(await httpsSender("http://hooks.example.com/", "{}", {}), 0);
});

test("the API reads a page without its open suggestions: no inserted text, no suggested blocks, text marked for removal as written", () => {
  const block = { id: "b1", type: "paragraph", props: {}, content: [{ type: "text", text: "Keep ", styles: {} }, { type: "text", text: "INSERTED ", styles: { suggestIns: "s1" } }, { type: "text", text: "and this", styles: { suggestDel: "s1" } }], children: [] };
  const suggested = { id: "sg~s1~n1", type: "paragraph", props: {}, content: [{ type: "text", text: "A suggested line", styles: { suggestIns: "s1" } }], children: [] };
  const page = blankNote({ kind: "page", title: "P", content: [block, suggested] as never });
  const space = new Space({ id: "y".repeat(32), ws, name: "t", icon: "", caps: { read: true, update: true, insert: true, readComments: true, insertComments: true, users: "names" }, createdBy: owner, createdAt: 0, updatedAt: 0, webhook: null }, [page], [page.id]);
  const ctx = contexts(space, new Directory(space.integration), page.id);
  const listed = readableBlocks(page.content).map((b) => toNotionBlock(b, page, null, ctx));
  assert.equal(listed.length, 1, "the suggested block is not listed");
  const rich = (listed[0].paragraph as { rich_text: { plain_text: string }[] }).rich_text.map((r) => r.plain_text).join("");
  assert.equal(rich, "Keep and this");
  assert.equal(space.findBlock("sg~s1~n1"), null, "nor found by its id");
});
