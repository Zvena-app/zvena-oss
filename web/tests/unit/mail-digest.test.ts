import { TEST_DIR } from "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { signInWith } from "@/lib/auth";
import { notify } from "@/lib/eco/inbox";
import { ecoDb } from "@/lib/eco/schema";
import { setDocsPrefs } from "@/lib/notes/follows";
import { DIGEST_DELAY, sendDigests } from "@/lib/notes/mail-digest";
import { blankNote } from "@/lib/notes/model";
import { pushNotes } from "@/lib/notes/server-store";
import { sql } from "@/lib/store";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

const outbox = join(TEST_DIR, "outbox");
const letters = () => (existsSync(outbox) ? readdirSync(outbox).map((f) => readFileSync(join(outbox, f), "utf8")) : []);

test("unread mentions come by e-mail once, after a while, only for pages still open, not when turned off", async () => {
  ecoDb();
  const a = signInWith({ provider: "dev", subject: "digest-anna", name: "Anna" }, "2026-10-15");
  const b = signInWith({ provider: "dev", subject: "digest-boris", name: "Boris http://evil.example" }, "2026-10-15");
  const c = signInWith({ provider: "dev", subject: "digest-cara", name: "Cara" }, "2026-10-15");
  assert.ok(a.ok && b.ok && c.ok);
  for (const [u, e] of [[a.user.id, "anna@example.test"], [c.user.id, "cara@example.test"]] as const) sql("UPDATE users SET email = ? WHERE id = ?").run(e, u);
  const ws = createWorkspace(b.user.id, "Digest").id;
  assert.ok(acceptInvite(a.user.id, createInvite(b.user.id, ws, "editor").token));
  assert.ok(acceptInvite(c.user.id, createInvite(b.user.id, ws, "editor").token));
  const p = blankNote({ kind: "page", title: "Launch plan" });
  pushNotes(ws, [{ id: p.id, note: p }], { by: b.user.id, quotaLeft: Infinity });
  notify(a.user.id, { ws, kind: "mention", ref: `note:${p.id}`, by: b.user.id, part: "m1", text: "please look at www.evil.example" });
  notify(c.user.id, { ws, kind: "mention", ref: `note:${p.id}`, by: b.user.id, part: "m1", text: "you too" });
  setDocsPrefs(c.user.id, { emailDigest: false });
  const before = letters().length;
  assert.equal(await sendDigests(Date.now()), 0, "not before the delay");
  const later = Date.now() + DIGEST_DELAY + 1000;
  assert.equal(await sendDigests(later), 1, "Anna only: Cara turned e-mails off");
  const mine = letters().slice(before).join("\n");
  assert.ok(mine.includes("To: anna@example.test") && mine.includes("Launch plan") && mine.includes(`#${p.id}`), mine.slice(0, 400));
  assert.ok(!mine.includes("http://evil.example") && !mine.includes("www.evil.example"), "what people typed carries no live links");
  assert.equal(await sendDigests(later + 60_000), 0, "never twice for the same items");
  // Two sweeps at once (a second timer, another process) send one letter, not two.
  notify(a.user.id, { ws, kind: "reply", ref: `note:${p.id}`, by: b.user.id, part: "r1", text: "and again" });
  const t2 = later + 2 * 3_600_000;
  const [x, y] = await Promise.all([sendDigests(t2), sendDigests(t2)]);
  assert.equal(x + y, 1);
  sql("UPDATE note_mail_digest SET last_at = 0 WHERE user_id = ?").run(a.user.id);
  notify(a.user.id, { ws, kind: "reply", ref: `note:${p.id}`, by: b.user.id, part: "r2", text: "third" });
  // A kind turned off since it happened is left out at send time.
  setDocsPrefs(a.user.id, { notify: { reply: false } });
  const t3 = t2 + 3_600_000;
  const n0 = letters().length;
  await sendDigests(t3);
  assert.equal(letters().length, n0, "a muted kind is not mailed");
});
