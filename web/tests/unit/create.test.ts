import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { CREATE_ITEMS, CREATE_TEMPLATES, createHref, DESIGN_PRESETS, matchCreate, templateHref } from "@/lib/create";
import { sql } from "@/lib/store";
import { personalWorkspace, createWorkspace, createInvite, acceptInvite } from "@/lib/workspaces";
import { existsSync } from "node:fs";
import { join } from "node:path";

test("create: every format has a tile, presets have their file, search finds both languages", () => {
  for (const p of DESIGN_PRESETS) {
    assert.ok(CREATE_ITEMS.some((x) => x.preset === p), `tile for ${p}`);
    assert.ok(existsSync(join(process.cwd(), "templates/design-presets", `${p}.penpot`)), `templates/design-presets/${p}.penpot`);
  }
  assert.deepEqual(matchCreate(CREATE_ITEMS, "презентация").map((x) => x.id), ["presentation"]);
  assert.deepEqual(matchCreate(CREATE_ITEMS, "slides").map((x) => x.id), ["presentation"]);
  assert.ok(matchCreate(CREATE_ITEMS, "задача").some((x) => x.id === "issue"));
  assert.equal(matchCreate(CREATE_ITEMS, "").length, CREATE_ITEMS.length);
  assert.equal(matchCreate(CREATE_ITEMS, "zzzz").length, 0);
  assert.equal(createHref(CREATE_ITEMS.find((x) => x.id === "story")!, "ws123456", { forRef: "issue:abc" }), "/new?ws=ws123456&kind=design&preset=story&for=issue%3Aabc");
  assert.equal(templateHref(CREATE_TEMPLATES[0], "ws123456", "ru"), "/docs?ws=ws123456#tpl=meeting/ru");
});

test("/new: makes a table in one click, never from another site, never for a viewer", async () => {
  const { GET } = await import("@/app/new/route");
  const r = signInWith({ provider: "dev", subject: "create-anna", name: "Anna" }, "2026-10-13");
  assert.ok(r.ok);
  const user = r.ok ? r.user : null!;
  const ws = personalWorkspace(user.id, "Personal").id;
  const cookie = `${sessionCookieName()}=${issueSession(user.id)}`;
  const call = (q: string, site = "same-origin", c = cookie) => GET(new Request(`http://localhost:3100/new?${q}`, { headers: { cookie: c, "sec-fetch-site": site } }));
  const dbs = () => Number((sql("SELECT COUNT(*) AS n FROM notes WHERE ws = ? AND json LIKE '%\"kind\":\"database\"%'").get(ws) as { n: number }).n);

  const doc = await call(`ws=${ws}&kind=doc`);
  assert.equal(doc.status, 303);
  assert.match(doc.headers.get("location") ?? "", /\/docs\?ws=.*#new$/);

  const table = await call(`ws=${ws}&kind=table&name=Budget`);
  assert.equal(table.status, 303);
  assert.match(table.headers.get("location") ?? "", /#Budget-[0-9a-f]{32}$/);
  assert.equal(dbs(), 1);

  const cross = await call(`ws=${ws}&kind=table`, "cross-site");
  assert.match(cross.headers.get("location") ?? "", /\/home\?ws=/);
  assert.equal(dbs(), 1, "a link on another site makes nothing");
  // Nor an image or a fetch on a zvena page (someone's text in a document): only opening it as a page.
  const img = await GET(new Request(`http://localhost:3100/new?ws=${ws}&kind=table`, { headers: { cookie, "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" } }));
  assert.match(img.headers.get("location") ?? "", /\/home\?ws=/);
  assert.equal(dbs(), 1, "an <img src=/new…> makes nothing");

  const tableId = /#Budget-([0-9a-f]{32})$/.exec(table.headers.get("location") ?? "")?.[1];
  const issue = await call(`ws=${ws}&kind=issue&for=note:${tableId}&name=Fix`);
  assert.match(issue.headers.get("location") ?? "", new RegExp(`/projects\\?ws=.*&create=issue&for=note%3A${tableId}&title=Fix$`), "a visible object passes on");
  const ghost = await call(`ws=${ws}&kind=issue&for=note:abcdef12&name=Fix`);
  assert.doesNotMatch(ghost.headers.get("location") ?? "", /for=/, "an object that does not exist is dropped");

  // A viewer of a team workspace is sent home without anything made.
  const owner = signInWith({ provider: "dev", subject: "create-boris", name: "Boris" }, "2026-10-13");
  assert.ok(owner.ok);
  const team = createWorkspace(owner.ok ? owner.user.id : "", "Team");
  acceptInvite(user.id, createInvite(owner.ok ? owner.user.id : "", team.id, "viewer").token);
  const before = Number((sql("SELECT COUNT(*) AS n FROM notes WHERE ws = ?").get(team.id) as { n: number }).n);
  const viewer = await call(`ws=${team.id}&kind=table`);
  assert.match(viewer.headers.get("location") ?? "", /\/home\?ws=/);
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM notes WHERE ws = ?").get(team.id) as { n: number }).n), before);

  // `for` links only to something this person can see: a doc of another workspace is ignored.
  const other = signInWith({ provider: "dev", subject: "create-vera", name: "Vera" }, "2026-10-13");
  assert.ok(other.ok);
  const otherWs = personalWorkspace(other.ok ? other.user.id : "", "Personal").id;
  sql("INSERT INTO notes (ws, id, stamp, client_at, deleted, bytes, json) VALUES (?, 'secretnote01', 1, 1, 0, 2, '{}')").run(otherWs);
  const linkedBefore = Number((sql("SELECT COUNT(*) AS n FROM eco_links WHERE ws_id = ?").get(ws) as { n: number } | undefined)?.n ?? 0);
  const sneaky = await call(`ws=${ws}&kind=table&for=note:secretnote01`);
  assert.equal(sneaky.status, 303);
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM eco_links WHERE ws_id = ?").get(ws) as { n: number } | undefined)?.n ?? 0), linkedBefore, "no link to what this person cannot see");

  const out = await GET(new Request(`http://localhost:3100/new?ws=${ws}&kind=doc`));
  assert.match(out.headers.get("location") ?? "", /\/signin\?next=/);
});
