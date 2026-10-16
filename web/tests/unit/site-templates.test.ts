// Template previews: each public preview is validated by id, and the choice
// survives signing in (the e-mail link, a new account's /welcome).
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES } from "@/components/notes/templates";
import { templateSummary } from "@/app/templates/[id]/TemplatePreview";
import { signInWith } from "@/lib/auth";
import { consumeLink, createEmailSignIn } from "@/lib/email-signin";
import { safeNext } from "@/lib/safe-next";
import { PUBLIC_TEMPLATES, publicTemplate, templateId, templatePath, templateSignIn, templateUseHref } from "@/lib/public-templates";
import { finishSignIn } from "@/lib/signin";
import { isEnglishOnlyPath, isSitePath } from "@/lib/site";

test("public template ids: one per real template, unique, and nothing else is accepted", () => {
  const ids = PUBLIC_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.equal(PUBLIC_TEMPLATES.filter((t) => t.kind === "doc").length, TEMPLATES.length);
  assert.deepEqual(publicTemplate("task-tracker"), { id: "task-tracker", kind: "doc", key: "taskTracker" });
  assert.deepEqual(publicTemplate("ui-kit"), { id: "ui-kit", kind: "design", key: "uiKit" });
  assert.equal(templateId("doc", "productSpec"), "product-spec");
  for (const bad of ["", "taskTracker", "Task-tracker", "../roadmap", "roadmap/", "nope", "a".repeat(60), "roadmap?use=1", null, undefined]) assert.equal(publicTemplate(bad), null, String(bad));
});

test("“Use this template” keeps the choice through sign-in", () => {
  const back = templatePath("roadmap", true);
  assert.equal(back, "/templates/roadmap?use=1");
  assert.equal(templateSignIn("roadmap"), `/signin?next=${encodeURIComponent(back)}`);
  assert.equal(safeNext(back), back);
  // The e-mail link carries it too.
  const e = createEmailSignIn("templates@example.com", { next: back, guest: null });
  assert.ok(e.ok);
  if (e.ok) {
    const used = consumeLink(e.token);
    assert.ok(used.ok && used.next === back);
  }
  // A new account sets zvena up first and goes on to the template; a returning one goes straight there.
  const fresh = signInWith({ provider: "email", subject: "tia@example.com", name: "Tia Template", email: "tia@example.com", emailVerified: true }, "2026-10-13");
  assert.ok(fresh.ok);
  if (!fresh.ok) return;
  const first = new URL(finishSignIn(fresh.user, { next: back, guest: null, isNew: true, personalName: "Personal" }).headers.get("location") as string);
  assert.equal(first.pathname, "/welcome");
  assert.equal(first.searchParams.get("next"), "/templates/roadmap?use=1&welcome=1");
  const again = new URL(finishSignIn(fresh.user, { next: back, guest: null, isNew: false, personalName: "Personal" }).headers.get("location") as string);
  assert.equal(`${again.pathname}${again.search}`, back);
});

test("previews are public website pages in English; the gallery stays the app's", () => {
  for (const p of ["/templates/task-tracker", "/templates/landing"]) {
    assert.ok(isSitePath(p), p);
    assert.ok(isEnglishOnlyPath(p), p);
  }
  assert.equal(isSitePath("/templates"), false);
  assert.equal(isSitePath("/templates/a/b"), false);
});

test("a template's link for a signed-in person is the gallery's own", () => {
  assert.equal(templateUseHref(publicTemplate("roadmap")!, "ws 1", "es"), "/docs?ws=ws%201#tpl=roadmap/es");
  assert.equal(templateUseHref(publicTemplate("landing")!, "w1", "en"), "/api/design/template?ws=w1&key=landing");
});

test("the preview's summary is read from the template itself", () => {
  const tracker = TEMPLATES.find((t) => t.key === "taskTracker")!.build("en");
  assert.match(templateSummary(tracker), /^A database with .+ views?/);
  const wiki = TEMPLATES.find((t) => t.key === "teamWiki")!.build("en");
  assert.match(templateSummary(wiki), /^A page.* sub-pages?\.$/);
});
