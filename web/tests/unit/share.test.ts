import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { inviteLetter, parseEmails } from "@/lib/share";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace, personalWorkspace } from "@/lib/workspaces";
import { TEST_DIR } from "./env";

function person(name: string, email?: string): { id: string; cookie: string } {
  const r = signInWith({ provider: "dev", subject: `share-${name}`, name, ...(email ? { email } : {}) }, "2026-10-13");
  assert.ok(r.ok);
  const id = r.ok ? r.user.id : "";
  if (email) sql("UPDATE users SET email = ? WHERE id = ?").run(email, id);
  return { id, cookie: `${sessionCookieName()}=${issueSession(id)}` };
}

test("share: addresses are cleaned, deduplicated, and the bad ones reported", () => {
  const { ok, bad } = parseEmails("Anna@Example.com, anna@example.com; <boris@x.io>\n not-an-email, @x.com");
  assert.deepEqual(ok, ["anna@example.com", "boris@x.io"]);
  assert.deepEqual(bad, ["not-an-email", "@x.com"]);
  assert.deepEqual(parseEmails(["a@b.co", 5, "c@d.co"]).ok, ["a@b.co", "c@d.co"]);
});

test("share: the letter is in the inviter's language, names the role and escapes what people typed", () => {
  const l = inviteLetter({ from: "Мария <b>", workspace: "Команда", role: "commenter", link: "https://zvena.example.com/join/abc", what: "План", locale: "ru" });
  assert.match(l.subject, /Мария <b> приглашает вас в «Команда»/);
  assert.match(l.text, /комментировать/);
  assert.ok(l.html.includes("Мария &lt;b&gt;") && !l.html.includes("<b>"), "HTML is escaped");
  assert.match(inviteLetter({ from: "Ann", workspace: "Team", role: "viewer", link: "x", locale: "en" }).text, /You can view/);
});

test("share: the owner invites by e-mail (one single-use link each), members are skipped, others may not invite, a personal workspace cannot", async () => {
  const { GET, POST } = await import("@/app/api/ws/share/route");
  const owner = person("owner", "owner@zvena.test");
  const editor = person("editor", "editor@zvena.test");
  const team = createWorkspace(owner.id, "Product Lab");
  acceptInvite(editor.id, createInvite(owner.id, team.id, "editor").token);
  const call = (cookie: string, q: string, body?: unknown) =>
    (body === undefined ? GET : POST)(
      new Request(`http://localhost:3100/api/ws/share?${q}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: "http://localhost:3100", host: "localhost:3100", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );

  const info = (await (await call(owner.cookie, `ws=${team.id}`)).json()) as { workspace: { personal: boolean }; role: string; members: unknown[] };
  assert.deepEqual([info.workspace.personal, info.role, info.members.length], [false, "owner", 2]);

  const before = Number((sql("SELECT COUNT(*) AS n FROM invites WHERE ws_id = ?").get(team.id) as { n: number }).n);
  const r = await call(owner.cookie, `ws=${team.id}`, { emails: "new@zvena.test, editor@zvena.test, broken", role: "viewer", what: "Launch plan" });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { results: { email: string; status: string }[]; bad: string[] };
  assert.deepEqual(
    j.results.map((x) => `${x.email}:${x.status}`),
    ["new@zvena.test:queued", "editor@zvena.test:member"]
  );
  assert.deepEqual(j.bad, ["broken"]);
  const inv = sql("SELECT role, max_uses FROM invites WHERE ws_id = ? ORDER BY created_at DESC LIMIT 1").get(team.id) as { role: string; max_uses: number };
  assert.deepEqual([inv.role, inv.max_uses], ["viewer", 1], "one single-use viewer link");
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM invites WHERE ws_id = ?").get(team.id) as { n: number }).n), before + 1);
  const outbox = readdirSync(join(TEST_DIR, "outbox")).map((f) => readFileSync(join(TEST_DIR, "outbox", f), "utf8"));
  assert.ok(outbox.some((m) => m.includes("new@zvena.test") && m.includes("/join/") && m.includes("Launch plan")), "the letter with the link is in the outbox");

  assert.equal((await call(editor.cookie, `ws=${team.id}`, { emails: "x@zvena.test", role: "editor" })).status, 403, "only the owner invites");
  const personal = personalWorkspace(owner.id, "Personal");
  assert.equal((await call(owner.cookie, `ws=${personal.id}`, { emails: "x@zvena.test", role: "editor" })).status, 400);
  assert.equal((await call(owner.cookie, `ws=${team.id}`, { emails: "x@zvena.test", role: "owner" })).status, 400, "nobody is invited as owner");
});
