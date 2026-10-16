import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { setRestricted } from "@/lib/notes/access";
import { connectPage, createIntegration, getIntegration } from "@/lib/notes/api/integrations";
import { Space } from "@/lib/notes/api/space";
import { pendingWebhooks } from "@/lib/notes/automations-server";
import { stampOwners, type Automation } from "@/lib/notes/automations";
import { blankNote, defaultView } from "@/lib/notes/model";
import { pullNotes, pushNotes } from "@/lib/notes/server-store";
import type { DbProperty, Note } from "@/lib/notes/types";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

const user = (name: string) => {
  const r = signInWith({ provider: "dev", subject: `audit-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.user.id;
};

test("an integration never sees or changes more than the person who connected the page", () => {
  const owner = user("Owner");
  const editor = user("Editor");
  const ws = createWorkspace(owner, "Team").id;
  assert.ok(acceptInvite(editor, createInvite(owner, ws, "editor").token));
  const p = blankNote({ kind: "page", title: "Project" });
  const r = blankNote({ kind: "page", title: "Salaries", parentId: p.id });
  const open = blankNote({ kind: "page", title: "Notes", parentId: p.id });
  pushNotes(ws, [p, r, open].map((n) => ({ id: n.id, note: n })), { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  // The sub-page is for the owner only.
  setRestricted(ws, r.id, true, owner);
  const { integration } = createIntegration(editor, ws, { name: "Bot", caps: { update: true, insert: true } });
  assert.ok(connectPage(editor, ws, integration.id, p.id));
  const space = Space.load(getIntegration(integration.id)!);
  assert.equal(space.canSee(p.id), true);
  assert.equal(space.canSee(open.id), true);
  assert.equal(space.canSee(r.id), false, "a restricted sub-page the connector cannot open");
  assert.equal(space.canWrite(r.id), false);
  assert.equal(space.visible().some((n) => n.id === r.id), false);
});

test("automations act for their author: no writes past their access or column permissions, no hidden values in webhooks", () => {
  const owner = user("AutoOwner");
  const editor = user("AutoEditor");
  const ws = createWorkspace(owner, "Pay").id;
  assert.ok(acceptInvite(editor, createInvite(owner, ws, "editor").token));
  const as = (by: string, notes: Note[]) => pushNotes(ws, notes.map((n) => ({ id: n.id, note: n })), { by, quotaLeft: Infinity, access: { userId: by } });
  const salary: DbProperty = { id: "pay", name: "Salary", type: "text", perms: { view: [owner], edit: [owner] } };
  const people = blankNote({ kind: "database", title: "People" });
  people.db = { properties: [{ id: "title", name: "Name", type: "title" }, salary], views: [defaultView("table", "Table")] };
  const vault = blankNote({ kind: "database", title: "Vault" });
  vault.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [defaultView("table", "Table")] };
  as(owner, [people, vault]);
  setRestricted(ws, vault.id, true, owner);
  // The editor sets up an automation that would write the protected column and into the owner's database.
  const sneaky: Automation = {
    id: "sneak",
    name: "Sneak",
    on: true,
    trigger: { type: "added" },
    actions: [
      { type: "set", prop: "pay", value: "1000000" },
      { type: "addPage", dbId: vault.id, title: "Planted" },
      { type: "webhook", url: "https://example.com/hook" },
    ],
  };
  const withAuto = { ...people, db: { ...people.db, automations: [{ ...sneaky, by: owner }] }, updatedAt: people.updatedAt + 1 };
  assert.deepEqual(as(editor, [withAuto]).rejected, []);
  const stored = pullNotes(ws, 0).notes.find((n) => n.id === people.id) as Note;
  assert.equal(stored.db?.automations?.[0].by, editor, "the server, not the device, says who set it up");
  const hooks = pendingWebhooks().length;
  // The owner adds a row (with a salary): the automation still acts for the editor.
  const row = blankNote({ kind: "page", parentId: people.id, title: "Ann", props: { pay: "50" } });
  as(owner, [row]);
  const after = pullNotes(ws, 0).notes;
  assert.equal(after.find((n) => n.id === row.id)?.props?.pay, "50", "a column the author may not edit stays as it was");
  assert.equal(after.some((n) => n.parentId === vault.id), false, "no page in a database the author cannot edit");
  const sent = pendingWebhooks().slice(hooks) as { body: { page?: { properties: Record<string, string> } } }[];
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.page?.properties.Salary, undefined, "a value the author may not see is not sent out");
  assert.equal(sent[0].body.page?.properties.Name, "Ann");
});

test("an integration cannot change what automations and buttons do", () => {
  const db = blankNote({ kind: "database", title: "D" });
  const auto: Automation = { id: "a", name: "A", on: true, trigger: { type: "added" }, actions: [{ type: "set", prop: "st", value: "x" }], by: "person01" };
  const btn: DbProperty = { id: "b", name: "B", type: "button", button: { label: "Go", actions: [{ type: "set", prop: "st", value: "y" }], by: "person01" } };
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }, btn], views: [defaultView("table", "Table")], automations: [auto] };
  const evil: Automation = { ...auto, actions: [{ type: "webhook", url: "https://evil.example" }] };
  const pushed = { ...db, db: { ...db.db, properties: [db.db.properties[0], { ...btn, button: { label: "Go!", actions: [{ type: "webhook" as const, url: "https://evil.example" }] } }], automations: [evil, { ...auto, id: "new" }] } };
  const out = stampOwners(db, pushed, "integration:0123456789abcdef0123456789abcdef");
  assert.deepEqual(out.db?.automations, [auto], "changed: as stored; new: dropped");
  assert.deepEqual(out.db?.properties[1].button, { label: "Go!", actions: btn.button!.actions, by: "person01" });
  // A person who changes one is its author; renaming or switching it off is no change of what it does.
  const byPerson = stampOwners(db, { ...pushed, db: { ...pushed.db, automations: [{ ...auto, name: "Renamed", on: false, by: "someone9" }, evil] } }, "editor01");
  assert.equal(byPerson.db?.automations?.[0].by, "person01");
  assert.equal(byPerson.db?.automations?.[1].by, "editor01");
});

test("an API request reads only the integration's part of the workspace (connected pages, what is above and under them)", () => {
  const owner = user("ScopeOwner");
  const ws = createWorkspace(owner, "Big").id;
  const db = blankNote({ kind: "database", title: "Tasks" });
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }], views: [defaultView("table", "Table")] };
  const row = blankNote({ kind: "page", title: "Row", parentId: db.id });
  const sub = blankNote({ kind: "page", title: "Under the row", parentId: row.id });
  const others = Array.from({ length: 30 }, (_, i) => blankNote({ kind: "page", title: `Other ${i}` }));
  pushNotes(ws, [db, row, sub, ...others].map((n) => ({ id: n.id, note: n })), { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  const { integration } = createIntegration(owner, ws, { name: "Row bot", caps: { read: true } });
  assert.ok(connectPage(owner, ws, integration.id, row.id));
  const space = Space.load(getIntegration(integration.id)!);
  assert.deepEqual(new Set(space.notes.keys()), new Set([db.id, row.id, sub.id]), "the row, what is under it, and its database (for the schema)");
  assert.equal(space.canSee(db.id), false, "the database itself stays closed");
  assert.equal(space.canSee(sub.id), true);
});

test("an editor can't take over someone else's integration: no rotate, no webhook, no caps, no revoke — only its maker or the owner", async () => {
  const route = await import("@/app/api/notes/integrations/route");
  const { issueSession, sessionCookieName } = await import("@/lib/auth");
  const owner = user("IntOwner");
  const maker = user("IntMaker");
  const other = user("IntOther");
  const ws = createWorkspace(owner, "Integrations").id;
  assert.ok(acceptInvite(maker, createInvite(owner, ws, "editor").token));
  assert.ok(acceptInvite(other, createInvite(owner, ws, "editor").token));
  const { integration } = createIntegration(maker, ws, { name: "Maker's bot", caps: { read: true } });
  const call = (who: string, method: string, body?: unknown) =>
    (route as unknown as Record<string, (r: Request) => Promise<Response>>)[method](
      new Request(`http://localhost:3100/api/notes/integrations?ws=${ws}`, { method, headers: { cookie: `${sessionCookieName()}=${issueSession(who)}`, origin: "http://localhost:3100", host: "localhost:3100", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    );
  for (const body of [{ id: integration.id, rotate: true }, { id: integration.id, webhook: { url: "https://evil.example/hook" } }, { id: integration.id, caps: { read: true, update: true, insert: true } }]) assert.equal((await call(other, "PATCH", body)).status, 403, JSON.stringify(body));
  assert.equal((await call(other, "DELETE", { id: integration.id })).status, 403);
  // The list shows another editor its name only.
  const seen = (await (await call(other, "GET")).json()) as { integrations: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(seen.integrations[0]).sort(), ["icon", "id", "name"]);
  // Its maker and the owner manage it.
  const rotated = (await (await call(maker, "PATCH", { id: integration.id, rotate: true })).json()) as { secret?: string };
  assert.match(String(rotated.secret), /^zv_secret_/);
  assert.equal((await call(owner, "PATCH", { id: integration.id, name: "Renamed" })).status, 200);
  assert.equal((await call(owner, "DELETE", { id: integration.id })).status, 200);
});

test("a sub-page can't be moved out of a restricted page (or into another) without full access; within it, it can", async () => {
  const { grant } = await import("@/lib/notes/access");
  const owner = user("MoveOwner");
  const editor = user("MoveEditor");
  const ws = createWorkspace(owner, "Moves").id;
  assert.ok(acceptInvite(editor, createInvite(owner, ws, "editor").token));
  const as = (by: string, notes: Note[]) => pushNotes(ws, notes.map((n) => ({ id: n.id, note: n })), { by, quotaLeft: Infinity, access: { userId: by } });
  const secret = blankNote({ kind: "page", title: "HR" });
  const child = blankNote({ kind: "page", title: "Salaries", parentId: secret.id });
  const sibling = blankNote({ kind: "page", title: "Policies", parentId: secret.id });
  const open = blankNote({ kind: "page", title: "Wiki" });
  as(owner, [secret, child, sibling, open]);
  setRestricted(ws, secret.id, true, owner);
  grant(ws, secret.id, editor, "edit", owner);
  const stored = () => pullNotes(ws, 0).notes.find((n) => n.id === child.id)!;
  // Out to a page everyone reads: refused (it would show the salaries to the whole workspace).
  const out = as(editor, [{ ...stored(), parentId: open.id, updatedAt: Date.now() + 1 }]);
  assert.deepEqual(out.rejected.map((r) => r.reason), ["forbidden"]);
  assert.equal(stored().parentId, secret.id);
  // Under a sibling in the same restricted page: fine.
  assert.deepEqual(as(editor, [{ ...stored(), parentId: sibling.id, updatedAt: Date.now() + 2 }]).rejected, []);
  // The owner (full access) may move it anywhere.
  assert.deepEqual(as(owner, [{ ...stored(), parentId: open.id, updatedAt: Date.now() + 3 }]).rejected, []);
});

test("a live session drops a reader the moment their access goes, and lowers an editor to read-only", async () => {
  const { openRoom, join, closeRooms } = await import("@/lib/notes/collab");
  const { grant, revoke } = await import("@/lib/notes/access");
  const { setRole } = await import("@/lib/workspaces");
  const owner = user("LiveOwner");
  const reader = user("LiveReader");
  const editor = user("LiveEditor");
  const ws = createWorkspace(owner, "Live").id;
  assert.ok(acceptInvite(reader, createInvite(owner, ws, "editor").token));
  assert.ok(acceptInvite(editor, createInvite(owner, ws, "editor").token));
  const page = blankNote({ kind: "page", title: "Plan" });
  pushNotes(ws, [{ id: page.id, note: page }], { by: owner, quotaLeft: Infinity, access: { userId: owner } });
  setRestricted(ws, page.id, true, owner);
  grant(ws, page.id, reader, "view", owner);
  grant(ws, page.id, editor, "edit", owner);
  const room = openRoom(ws, page.id);
  let readerClosed = false;
  const r = join(room, { id: "readerRRRRR", userId: reader, mayEdit: false, send: () => undefined, close: () => (readerClosed = true) });
  const e = join(room, { id: "editorEEEEE", userId: editor, mayEdit: true, send: () => undefined, close: () => undefined });
  assert.ok(r.conn && e.conn.canEdit);
  revoke(ws, page.id, reader);
  await new Promise((done) => setImmediate(done));
  assert.equal(readerClosed, true, "the reader is out at once");
  setRole(owner, ws, editor, "viewer");
  grant(ws, page.id, editor, "view", owner);
  await new Promise((done) => setImmediate(done));
  assert.equal(room.conns.get("editorEEEEE")?.canEdit, false, "the editor's edits are refused from now on");
  closeRooms();
});

test("someone without full access can't put a protected column into a form; a form keeps the questions it had", async () => {
  const { guardSchema } = await import("@/lib/notes/column-perms");
  const db = blankNote({ kind: "database", title: "HR" });
  const form = { ...defaultView("form", "Form"), form: { questions: [{ prop: "title" }] } };
  db.db = { properties: [{ id: "title", name: "Name", type: "title" }, { id: "pay", name: "Salary", type: "text", perms: { view: ["owner01"], edit: ["owner01"] } }], views: [form] };
  const pushed = { ...db, db: { ...db.db, views: [{ ...form, form: { questions: [{ prop: "title" }, { prop: "pay" }] } }] } };
  const out = guardSchema(db, pushed);
  assert.deepEqual(out.db?.views[0].form?.questions.map((q) => q.prop), ["title"]);
  // Already in the form (the owner put it there): it stays.
  const withPay = { ...db, db: { ...db.db, views: [{ ...form, form: { questions: [{ prop: "title" }, { prop: "pay" }] } }] } };
  assert.deepEqual(guardSchema(withPay, withPay).db?.views[0].form?.questions.map((q) => q.prop), ["title", "pay"]);
});

test("HTML export: a crafted alignment can't break out of the style attribute", async () => {
  const hx = (await import("@/lib/notes/html-export")) as unknown as Record<string, unknown>;
  const fn = (hx.blocksToHtml ?? hx.noteHtml) as ((b: unknown, ...rest: unknown[]) => string) | undefined;
  assert.ok(typeof fn === "function");
  const html = (fn as (b: unknown, ctx: unknown, depth: number, all: unknown) => string)([{ id: "x", type: "paragraph", props: { textAlignment: 'center" onmouseover="alert(1)' }, content: [{ type: "text", text: "hi", styles: {} }], children: [] }], { notes: new Map(), assets: new Map() }, 0, []);
  assert.ok(!html.includes("onmouseover"), html);
});

test("workspace invitation letters relay no live links from what people typed", async () => {
  const { inviteLetter } = await import("@/lib/share");
  const l = inviteLetter({ from: "Mallory https://evil.example", workspace: "Pay at evil.example", role: "viewer", link: "https://zvena.app/join/x", what: "Invoice www.evil.example", locale: "en" });
  assert.ok(!/evil\.example/.test(l.subject + l.text), l.subject + l.text);
});
