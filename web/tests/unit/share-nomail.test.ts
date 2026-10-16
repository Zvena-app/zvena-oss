import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { inviteByEmail } from "@/lib/share";
import { createWorkspace } from "@/lib/workspaces";

test("workspace invitations without a mail service: each address gets its own link for the inviter, never a silent failure", async () => {
  const r = signInWith({ provider: "dev", subject: "share-nomail-owner", name: "Owner" }, "2026-10-13");
  assert.ok(r.ok);
  const owner = r.ok ? r.user.id : "";
  const ws = createWorkspace(owner, "No mail").id;
  const outbox = process.env.ZVENA_MAIL_OUTBOX;
  delete process.env.ZVENA_MAIL_OUTBOX;
  try {
    const out = await inviteByEmail({ actor: owner, actorName: "Owner", wsId: ws, wsName: "No mail", role: "editor", emails: ["a@example.org", "b@example.org"], locale: "en" });
    assert.deepEqual(out.map((x) => x.status), ["link", "link"]);
    assert.ok(out.every((x) => /\/join\/[A-Za-z0-9_-]+$/.test(x.link ?? "")));
    assert.notEqual(out[0].link, out[1].link, "one single-use link per address");
  } finally {
    process.env.ZVENA_MAIL_OUTBOX = outbox;
  }
  // With an outbox (a stand), letters are kept: "queued", no link handed out.
  const kept = await inviteByEmail({ actor: owner, actorName: "Owner", wsId: ws, wsName: "No mail", role: "viewer", emails: ["c@example.org"], locale: "en" });
  assert.deepEqual(kept.map((x) => [x.status, x.link]), [["queued", undefined]]);
});
