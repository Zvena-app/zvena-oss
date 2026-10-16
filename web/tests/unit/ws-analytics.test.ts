import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, sessionCookieName, signInWith } from "@/lib/auth";
import { setDocsPrefs } from "@/lib/notes/follows";
import { blankNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import type { Note } from "@/lib/notes/types";
import { recordView } from "@/lib/notes/versions";
import { workspaceAnalytics } from "@/lib/notes/ws-analytics";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";
import { GET } from "@/app/api/ws/analytics/route";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `wsa-${name}-${++n}`, name }, "2026-10-15");
  assert.ok(r.ok);
  return r.user.id;
}
const get = (url: string, uid: string) => new Request(`http://localhost${url}`, { headers: { cookie: `${sessionCookieName()}=${issueSession(uid)}` } });
const page = (title: string, extra: Partial<Note> = {}) => blankNote({ kind: "page", title, content: [], ...extra });

test("workspace analytics: views, edits, new pages and active members; another's Private page counts without its title", () => {
  const anna = person("Anna");
  const boris = person("Boris");
  const vera = person("Vera");
  const ws = createWorkspace(anna, `Analytics ${n}`).id;
  assert.ok(acceptInvite(boris, createInvite(anna, ws, "editor").token));
  assert.ok(acceptInvite(vera, createInvite(anna, ws, "editor").token));
  const shared = page("Roadmap");
  const secret = page("Boris's diary", { space: `private:${boris}` });
  pushNotes(ws, [{ id: shared.id, note: shared }], { by: anna, quotaLeft: Infinity });
  pushNotes(ws, [{ id: secret.id, note: secret }], { by: boris, quotaLeft: Infinity });
  const now = Date.now();
  assert.ok(recordView(ws, shared.id, boris, now - 3_600_000));
  assert.ok(recordView(ws, shared.id, anna, now - 3_600_000));
  assert.ok(recordView(ws, secret.id, boris, now - 3_600_000));
  // Vera's page view history is off: her view is not kept, and she shows no views.
  setDocsPrefs(vera, { viewHistory: false });
  assert.equal(recordView(ws, shared.id, vera, now), false);

  const a = workspaceAnalytics(ws, anna, 7, now);
  assert.equal(a.members, 3);
  assert.equal(a.views, 3);
  assert.ok(a.edits >= 2, `edits ${a.edits}`);
  assert.equal(a.created, 2);
  assert.equal(a.active, 2);
  assert.equal(a.days.views.length, 7);
  assert.equal(a.days.views[6], 3);
  const top = a.pages.find((p) => p.id === shared.id);
  assert.equal(top?.title, "Roadmap");
  assert.equal(top?.views, 2);
  assert.equal(top?.viewers, 2);
  const hidden = a.pages.find((p) => p.id === secret.id);
  assert.ok(hidden, "the Private page is counted");
  assert.equal(hidden.title, null, "but its title is not shown to the owner");
  assert.equal(a.people.find((p) => p.id === vera)?.views, null);
  assert.equal(a.people.find((p) => p.id === boris)?.views, 2);
  // Boris sees his own page's title (were he to ask).
  assert.equal(workspaceAnalytics(ws, boris, 7, now).pages.find((p) => p.id === secret.id)?.title, "Boris's diary");
});

test("workspace analytics API: owners only, the periods offered only", async () => {
  const anna = person("Anna");
  const boris = person("Boris");
  const ws = createWorkspace(anna, `Analytics API ${n}`).id;
  assert.ok(acceptInvite(boris, createInvite(anna, ws, "editor").token));
  assert.equal((await GET(get(`/api/ws/analytics?ws=${ws}&span=28`, anna))).status, 200);
  assert.equal((await GET(get(`/api/ws/analytics?ws=${ws}&span=28`, boris))).status, 403);
  assert.equal((await GET(get(`/api/ws/analytics?ws=${ws}&span=365`, anna))).status, 400);
});
