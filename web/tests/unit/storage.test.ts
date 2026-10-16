import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signInWith } from "@/lib/auth";
import { runMaintenance } from "@/lib/maintenance";
import { parseTarget } from "@/lib/reports";
import { adoptGuestFiles, docsUsage, newGuestId, recordFile, touchGuest } from "@/lib/storage";
import { sql } from "@/lib/store";

const DAY = 86_400_000;

test("guest uploads are counted, adopted on sign-in, and removed after the TTL", async () => {
  const files = process.env.ZVENA_FILES_DIR as string;
  mkdirSync(files, { recursive: true });
  const kept = newGuestId();
  const stale = newGuestId();
  for (const [g, name] of [[kept, "kept.png"], [stale, "stale.png"]]) {
    writeFileSync(join(files, name), "x");
    recordFile({ kind: "guest", id: g }, name, 1);
    assert.equal(touchGuest(g).files, 1);
  }
  sql("UPDATE guests SET last_seen_at = ? WHERE id = ?").run(Date.now() - 31 * DAY, stale);
  const done = await runMaintenance();
  assert.equal(done.guests, 1);
  assert.equal(existsSync(join(files, "stale.png")), false);
  assert.equal(existsSync(join(files, "kept.png")), true);

  const r = signInWith({ provider: "dev", subject: "galya", name: "Галя" }, "2026-10-13");
  const id = r.ok ? r.user.id : "";
  adoptGuestFiles(kept, id);
  assert.equal(docsUsage(id).files, 1);
  assert.equal(sql("SELECT COUNT(*) AS n FROM guests WHERE id = ?").get(kept)?.n, 0);
});

test("the daily upkeep runs once a day and prunes old invites and journal lines", async () => {
  sql("DELETE FROM kv WHERE k = 'maint:daily'").run();
  sql("INSERT INTO audit (at, actor, action) VALUES (?, NULL, 'old')").run(Date.now() - 400 * DAY);
  const first = await runMaintenance();
  assert.equal(first.audit, 1);
  const second = await runMaintenance();
  assert.equal(second.audit, undefined, "not again within a day");
});

test("complaints accept only zvena's public pages, forms and design shares", () => {
  assert.deepEqual(parseTarget("http://localhost:3100/n/AbCdEfGh12345678"), { kind: "page", target: "AbCdEfGh12345678" });
  assert.deepEqual(parseTarget("/f/form_ID-123"), { kind: "form", target: "form_ID-123" });
  assert.deepEqual(parseTarget("http://localhost:3110/#/view?file-id=1&share-id=0F6E1C2A-1111-2222-3333-444455556666"), { kind: "design", target: "0f6e1c2a-1111-2222-3333-444455556666" });
  for (const bad of ["", "/home", "/n/short", "/n/../../admin", "javascript:alert(1)", "/f/bad id"]) assert.equal(parseTarget(bad), null, bad);
});
