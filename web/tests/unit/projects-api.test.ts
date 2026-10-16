// The HTTP layer of Projects (src/lib/projects/api.ts) with real Request
// objects: sessions, CSRF, workspace membership, validation, uploads,
// access-checked downloads and signed links, and the change feed.
import "./env";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";
import { handle } from "@/lib/projects/api";

const BASE = "http://localhost:3100";

function person(name: string): { id: string; cookie: string } {
  const r = signInWith({ provider: "dev", subject: `api-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  const id = r.ok ? r.user.id : "";
  return { id, cookie: `${sessionCookieName()}=${issueSession(id)}` };
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function call(who: { cookie: string } | null, method: Method, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL(`${BASE}/api/projects/${path}`);
  const headers: Record<string, string> = { origin: BASE, host: "localhost:3100", ...extra };
  if (who) headers.cookie = who.cookie;
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) payload = body as unknown as BodyInit;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const req = new Request(url, { method, headers, body: payload });
  const res = await handle(req, method, url.pathname.replace("/api/projects/", "").split("/").filter(Boolean));
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const owner = person("Владелец");
const viewer = person("Наблюдатель");
const outsider = person("Посторонний");
const ws = createWorkspace(owner.id, "API-тест").id;
acceptInvite(viewer.id, createInvite(owner.id, ws, "viewer").token);
const q = (p: string) => `${p}${p.includes("?") ? "&" : "?"}ws=${ws}`;

test("no session → 401; foreign origin → 403; not a member → 403", async () => {
  assert.equal((await call(null, "GET", q("bootstrap"))).status, 401);
  assert.equal((await call(owner, "POST", q("teams"), { name: "X", key: "XX" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(outsider, "GET", q("bootstrap"))).status, 403);
  assert.equal((await call(owner, "GET", "bootstrap?ws=../../etc")).status, 403);
  assert.equal((await call(owner, "GET", q("no/such/route"))).status, 404);
});

test("create, read, change, delete an issue over HTTP", async () => {
  const team = await call(owner, "POST", q("teams"), { name: "API", key: "API" });
  assert.equal(team.status, 200);
  const teamId = team.json.id as string;
  const created = await call(owner, "POST", q("issues"), { teamId, title: "Через HTTP", priority: 3 });
  assert.equal(created.status, 200);
  assert.equal(created.json.identifier, "API-1");
  const got = await call(viewer, "GET", q("issues/API-1"));
  assert.equal(got.status, 200);
  assert.equal(got.json.title, "Через HTTP");
  assert.equal((await call(viewer, "PATCH", q("issues/API-1"), { title: "нельзя" })).status, 403);
  const patched = await call(owner, "PATCH", q("issues/API-1"), { title: "Изменено", priority: 1 });
  assert.equal(patched.json.title, "Изменено");
  const list = await call(viewer, "GET", q(`issues?priority=1&group=none`));
  assert.equal(list.json.total, 1);
  assert.equal((await call(owner, "DELETE", q("issues/API-1"))).json.deleted, 1);
  assert.equal((await call(owner, "GET", q("issues/API-1"))).status, 404);
});

test("bad input is refused with 400, never stored", async () => {
  const boot = await call(owner, "GET", q("bootstrap"));
  const teamId = (boot.json.teams as { id: string }[])[0].id;
  for (const bad of [{ teamId, title: "" }, { teamId, title: "x".repeat(301) }, { teamId, title: "ok", priority: "high" }, { teamId, title: "ok", dueDate: "tomorrow" }, { teamId, title: "ok", labelIds: "a" }]) {
    assert.equal((await call(owner, "POST", q("issues"), bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const raw = await handle(new Request(`${BASE}/api/projects/issues?ws=${ws}`, { method: "POST", headers: { origin: BASE, host: "localhost:3100", cookie: owner.cookie, "content-type": "application/json" }, body: "{not json" }), "POST", ["issues"]);
  assert.equal(raw.status, 400);
  assert.equal((await call(owner, "GET", q("issues?filter=%7Bbroken"))).status, 400);
});

test("attachments: upload, member download, outsider 404, signed link works without a session and expires", async () => {
  const boot = await call(owner, "GET", q("bootstrap"));
  const teamId = (boot.json.teams as { id: string }[])[0].id;
  const it = await call(owner, "POST", q("issues"), { teamId, title: "С файлом" });
  const ref = it.json.identifier as string;
  const up = await call(owner, "POST", q(`issues/${ref}/attachments`), new TextEncoder().encode("hello attachment"), { "content-type": "text/plain", "x-file-name": encodeURIComponent("заметка.txt") });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const url = up.json.url as string;
  const id = url.split("/").pop() as string;
  const get = (who: { cookie: string } | null, suffix = "") =>
    handle(new Request(`${BASE}${url}${suffix}`, { headers: who ? { cookie: who.cookie } : {} }), "GET", ["attachments", id]);
  const mine = await get(viewer);
  assert.equal(mine.status, 200);
  assert.equal(await mine.text(), "hello attachment");
  assert.match(mine.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal((await get(outsider)).status, 404);
  assert.equal((await get(null)).status, 401);
  const link = await call(viewer, "POST", q(`attachments/${id}/link`), {});
  const signed = new URL(link.json.url as string, BASE);
  const anon = await handle(new Request(signed), "GET", ["attachments", id]);
  assert.equal(anon.status, 200);
  signed.searchParams.set("sig", "x".repeat(43));
  assert.equal((await handle(new Request(signed), "GET", ["attachments", id])).status, 403);
  const before = readdirSync(process.env.ZVENA_FILES_DIR as string).length;
  assert.equal((await call(viewer, "POST", q(`issues/${ref}/attachments`), new TextEncoder().encode(`viewer ${Date.now()}`), { "x-file-name": "a.txt" })).status, 403);
  assert.equal((await call(owner, "POST", q(`issues/NOPE-1/attachments`), new TextEncoder().encode(`ghost ${Date.now()}`), { "x-file-name": "a.txt" })).status, 404);
  assert.equal(readdirSync(process.env.ZVENA_FILES_DIR as string).length, before, "a refused upload writes nothing to disk");
  assert.equal((await call(owner, "POST", q(`issues/${ref}/attachments`), new Uint8Array([1, 2]), { "x-file-name": "a.exe", "content-type": "application/x-msdownload" })).status, 415);
});

test("the change feed moves on every change; notifications are per person", async () => {
  const before = (await call(viewer, "GET", q("changes"))).json.seq as number;
  const boot = await call(owner, "GET", q("bootstrap"));
  const teamId = (boot.json.teams as { id: string }[])[0].id;
  await call(owner, "POST", q("issues"), { teamId, title: "Для ленты", assigneeId: viewer.id });
  const after = await call(viewer, "GET", q("changes"));
  assert.ok((after.json.seq as number) > before);
  assert.equal(after.json.unread, 1);
  const inbox = await call(viewer, "GET", q("notifications"));
  const items = inbox.json.items as { id: string; kind: string }[];
  assert.equal(items[0].kind, "assigned");
  assert.equal((await call(owner, "POST", q("notifications"), { ids: [items[0].id], action: "read" })).json.changed, 0, "someone else's notification is not touched");
  assert.equal((await call(viewer, "POST", q("notifications"), { ids: "all", action: "read" })).json.unread, 0);
});

test("assistant endpoints answer from data; unknown actions are refused", async () => {
  const parsed = await call(viewer, "POST", q("assist"), { action: "parseQuery", text: "мои срочные задачи в работе" });
  assert.equal(parsed.status, 200);
  assert.deepEqual((parsed.json.filter as { assignee: string[] }).assignee, ["me"]);
  assert.equal(typeof parsed.json.count, "number");
  assert.equal((await call(viewer, "POST", q("assist"), { action: "generate", text: "x" })).status, 400);
});
