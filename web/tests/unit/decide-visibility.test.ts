// Rules and decisions on a number counted from what a member cannot read (a colleague's
// mail) stay hidden from that member: the rule list, the decision log, the hub's activity
// and the live "decision" update. Typed numbers stay visible to every member.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { decisionsOf, decisionVisible, onEvent, putMetric, reactionsOf, saveReaction, visibleRules } from "@/lib/decide/engine";
import { activityOf } from "@/lib/decide/journal";
import { forgetSeen, saveSource } from "@/lib/decide/sources";
import { keyVisible } from "@/lib/eco/visibility";
import { visibleTo } from "@/lib/pulse/bus";
import { ctxFor } from "@/lib/projects/core";
import { createIssue } from "@/lib/projects/issues";
import { createTeam } from "@/lib/projects/teams";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

let n = 0;
function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `dvis-${name}-${++n}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("decide: Ann's rule on her own mail number, and what it did, are not shown to Ben", async () => {
  const ann = person("Ann");
  const ben = person("Ben");
  const ws = createWorkspace(ann, `Visibility ${n}`).id;
  assert.ok(acceptInvite(ben, createInvite(ann, ws, "editor").token));
  const team = createTeam(ctxFor(ann, ws, "edit"), { name: "Ops", key: `DV${n}` }, "en");
  const mail = saveSource(ws, { kind: "mail", view: "inbox", measure: "unread" }, ann);
  assert.ok(!("error" in mail), JSON.stringify(mail));
  const issue = createIssue(ctxFor(ann, ws, "edit"), { teamId: team.id, title: "Inbox is big" });
  const mailRule = `dvis-mail-${n}`;
  const typedRule = `dvis-typed-${n}`;
  const typed = `typed${n}`;
  for (const [id, key] of [
    [mailRule, mail.key],
    [typedRule, typed],
  ]) {
    const r = saveReaction(ws, { id, name: "Alarm", on: true, when: { type: "metric", key }, if: { kind: "compare", field: "value", op: ">=", value: 50 }, then: [{ do: "issue.done", issue: issue.id }] }, ann);
    assert.ok(!("error" in r), JSON.stringify(r));
  }

  // Both rules fire.
  putMetric(ws, mail.key, 60, null, "source");
  putMetric(ws, typed, 70, null, "typed");
  forgetSeen();
  onEvent({ id: 0, ws, type: "metric", ref: mail.key, at: Date.now(), data: { value: 60 } });
  onEvent({ id: 0, ws, type: "metric", ref: typed, at: Date.now(), data: { value: 70 } });
  await tick();
  const all = decisionsOf(ws, 50);
  const ofMail = all.find((d) => d.subject === `metric:${mail.key}`);
  const ofTyped = all.find((d) => d.subject === `metric:${typed}`);
  assert.ok(ofMail && ofTyped, JSON.stringify(all));

  // Ann (the mail is hers) sees both rules and both decisions.
  const forAnn = visibleRules(ws, ann, reactionsOf(ws), all);
  assert.deepEqual(new Set(forAnn.reactions.map((r) => r.id)), new Set([mailRule, typedRule]));
  assert.equal(forAnn.decisions.length, 2);
  assert.ok(activityOf(ws, ann).some((a) => a.subject === `metric:${mail.key}`));
  assert.ok(decisionVisible(ws, ann, ofMail.reaction_id, ofMail.subject));

  // Ben: the typed number's rule and decision only (GET /api/decide, the hub, the live update).
  const forBen = visibleRules(ws, ben, reactionsOf(ws), all);
  assert.deepEqual(
    forBen.reactions.map((r) => r.id),
    [typedRule]
  );
  assert.deepEqual(
    forBen.decisions.map((d) => d.subject),
    [`metric:${typed}`]
  );
  const benActivity = activityOf(ws, ben).map((a) => a.subject);
  assert.ok(benActivity.includes(`metric:${typed}`), JSON.stringify(benActivity));
  assert.ok(!benActivity.some((s) => s.includes(mail.key)), JSON.stringify(benActivity));
  assert.equal(decisionVisible(ws, ben, ofMail.reaction_id, ofMail.subject), false);
  assert.equal(decisionVisible(ws, ben, null, ofMail.subject), false, "a decision whose rule is gone goes by its subject");
  assert.ok(decisionVisible(ws, ben, ofTyped.reaction_id, ofTyped.subject));
  const pulse = (ref: string) => ({ id: 1, ws, type: "decision" as const, ref, at: Date.now(), data: { mode: "applied" } });
  assert.equal(visibleTo(ben, pulse(ofMail.id)), false);
  assert.ok(visibleTo(ann, pulse(ofMail.id)));
  assert.ok(visibleTo(ben, pulse(ofTyped.id)));

  // The key itself: a counted number follows its source, a typed one is everyone's.
  assert.equal(keyVisible(ben, ws, `metric:${mail.key}`), false);
  assert.ok(keyVisible(ann, ws, `metric:${mail.key}`));
  assert.ok(keyVisible(ben, ws, `metric:${typed}`));
});
