import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { sql } from "@/lib/store";
import { acceptInvite, can, createInvite, createWorkspace, LimitError, membersOf, personalWorkspace, previewInvite, removeMember, revokeInvite, roleIn, setRole, transferOwnership, workspacesOf } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: name, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

const anna = person("anna");
const boris = person("boris");
const vera = person("vera");

test("roles: what each one may do", () => {
  assert.deepEqual(
    (["owner", "editor", "commenter", "viewer", null] as const).map((r) => [can.read(r), can.comment(r), can.edit(r), can.manage(r)]),
    [
      [true, true, true, true],
      [true, true, true, false],
      [true, true, false, false],
      [true, false, false, false],
      [false, false, false, false],
    ]
  );
});

test("the personal workspace is created once and owned", () => {
  const a = personalWorkspace(anna, "Личное");
  const b = personalWorkspace(anna, "Личное");
  assert.equal(a.id, b.id);
  assert.equal(a.personal, true);
  assert.equal(roleIn(anna, a.id), "owner");
  assert.equal(transferOwnership(anna, a.id, boris), false);
});

test("an invite link gives its role; a member keeps the higher role", () => {
  const ws = createWorkspace(anna, "Команда");
  const viewer = createInvite(anna, ws.id, "viewer");
  assert.equal(previewInvite(viewer.token)?.role, "viewer");
  assert.equal(acceptInvite(boris, viewer.token)?.role, "viewer");
  assert.equal(roleIn(boris, ws.id), "viewer");
  const editor = createInvite(anna, ws.id, "editor");
  assert.equal(acceptInvite(boris, editor.token)?.role, "editor");
  assert.equal(acceptInvite(boris, viewer.token)?.role, "editor");
  assert.equal(roleIn(boris, ws.id), "editor");
  assert.equal(acceptInvite(anna, viewer.token)?.role, "owner");
  assert.equal(sql("SELECT COUNT(*) AS n FROM invites WHERE id = ?").get(viewer.token)?.n, 0, "the token itself is never stored");
});

test("revoked, expired, used-up and malformed links do nothing", () => {
  const ws = createWorkspace(anna, "Закрытая");
  const revoked = createInvite(anna, ws.id, "editor");
  assert.ok(revokeInvite(anna, ws.id, revoked.invite.id));
  assert.equal(acceptInvite(vera, revoked.token), null);
  const expired = createInvite(anna, ws.id, "editor");
  sql("UPDATE invites SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expired.invite.id);
  assert.equal(previewInvite(expired.token), null);
  assert.equal(acceptInvite(vera, expired.token), null);
  const once = createInvite(anna, ws.id, "commenter", { maxUses: 1 });
  assert.equal(acceptInvite(vera, once.token)?.role, "commenter");
  assert.equal(acceptInvite(boris, once.token), null);
  for (const bad of ["", "short", "x".repeat(41), "a/b/c/d/e/f/g/h/i/j/k/l"]) assert.equal(acceptInvite(boris, bad), null);
  assert.equal(roleIn(boris, ws.id), null);
});

test("the owner cannot be demoted or removed; ownership moves only to a member", () => {
  const ws = createWorkspace(anna, "Передача");
  assert.equal(setRole(anna, ws.id, anna, "viewer"), false);
  assert.equal(removeMember(anna, ws.id, anna), false);
  assert.equal(transferOwnership(anna, ws.id, vera), false, "vera is not a member");
  acceptInvite(vera, createInvite(anna, ws.id, "viewer").token);
  assert.equal(transferOwnership(boris, ws.id, vera), false, "only the owner hands it over");
  assert.equal(transferOwnership(anna, ws.id, vera), true);
  assert.equal(roleIn(vera, ws.id), "owner");
  assert.equal(roleIn(anna, ws.id), "editor");
  assert.equal(membersOf(ws.id).filter((m) => m.role === "owner").length, 1);
});

test("the number of team workspaces is limited (personal ones are not)", () => {
  const owned = () => workspacesOf(boris).filter((w) => !w.personal && w.role === "owner").length;
  personalWorkspace(boris, "Личное");
  while (owned() < 3) createWorkspace(boris, `Пространство ${owned()}`);
  assert.throws(() => createWorkspace(boris, "Лишнее"), LimitError);
});
