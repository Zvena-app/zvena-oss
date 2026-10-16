import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_DIR } from "./env";
import { filesState, health, mailState, overallOf, readyOf, type Parts } from "@/lib/health";
import { mailCheck, noteMailCheck, refreshSmtpCheck, resetMailCheck } from "@/lib/mail";
import { translate } from "@/lib/i18n";

const FILES = process.env.ZVENA_FILES_DIR as string;
const all = (over: Partial<Parts>): Parts => ({ web: "ok", database: "ok", files: "ok", design: "off", mail: "off", ...over });

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  const restore = () => {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore) as T;
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

test("health: a missing files directory is down — never the root filesystem's free space instead", async () => {
  rmSync(FILES, { recursive: true, force: true });
  assert.equal(await filesState(FILES, 0), "down");
  const h = await health();
  assert.equal(h.parts.files, "down");
  assert.equal(h.ok, false, "not ready: files cannot be served or stored");
  assert.equal(h.status, "major_outage");
  // A file where the directory should be is no better.
  const notDir = join(TEST_DIR, "files-as-file");
  writeFileSync(notDir, "x");
  assert.equal(await filesState(notDir, 0), "down");
});

test("health: low disk on the files volume is degraded — the status page does not say operational, readiness stays up", async () => {
  mkdirSync(FILES, { recursive: true });
  assert.equal(await filesState(FILES, 0), "ok");
  assert.equal(await filesState(FILES, Number.MAX_SAFE_INTEGER), "degraded");
  const h = await withEnv({ ZVENA_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) }, () => health());
  assert.equal(h.parts.files, "degraded");
  assert.equal(h.ok, true, "a full disk must not fail the healthcheck (no restart or rollback over it)");
  assert.equal(h.status, "degraded");
  assert.notEqual(h.status, "operational");
  assert.doesNotMatch(translate("en", "status.degraded"), /operational/i);
  assert.equal(translate("en", "status.state.degraded"), "Degraded performance");
  // With room to spare, every part answers: operational.
  const fine = await withEnv({ ZVENA_MIN_FREE_BYTES: "0" }, () => health());
  assert.deepEqual([fine.ok, fine.status, fine.parts.files, fine.parts.mail, fine.parts.design], [true, "operational", "ok", "off", "off"]);
});

test("health: the overall status — core part down is a major outage, Design down partial, anything degraded shows", () => {
  assert.equal(overallOf(all({})), "operational");
  assert.equal(overallOf(all({ mail: "unverified" })), "operational", "not yet verified is not a known problem");
  assert.equal(overallOf(all({ mail: "degraded" })), "degraded");
  assert.equal(overallOf(all({ design: "down" })), "partial_outage");
  assert.equal(overallOf(all({ database: "down", design: "down" })), "major_outage");
  assert.equal(readyOf(all({ mail: "degraded", files: "degraded" })), true);
  assert.equal(readyOf(all({ design: "down" })), false, "release and monitor scripts still see Design down");
  assert.equal(readyOf(all({ database: "down" })), false);
});

test("health: configured mail is 'unverified' until a letter or an SMTP login shows it works", () => {
  resetMailCheck();
  withEnv({ SMTP_HOST: "smtp.example.invalid", SMTP_FROM: "zvena <noreply@example.invalid>" }, () => {
    const now = Date.now();
    assert.equal(mailState(now), "unverified");
    noteMailCheck(true, "delivery", now - 1000);
    assert.equal(mailState(now), "ok");
    noteMailCheck(false, "delivery", now);
    assert.equal(mailState(now), "degraded", "the last letter did not go");
    assert.equal(overallOf(all({ mail: mailState(now) })), "degraded");
    // Old evidence says nothing any more.
    noteMailCheck(true, "login", now - 25 * 3600_000);
    assert.equal(mailState(now), "unverified");
  });
  resetMailCheck();
  assert.equal(mailState(), "off", "no mail service: not configured");
});

test("health: the SMTP check logs in (never sends), at most once per window; a dead server shows as degraded", async () => {
  resetMailCheck();
  await withEnv({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_FROM: "noreply@example.invalid" }, async () => {
    const run = refreshSmtpCheck();
    assert.ok(run, "a check starts when nothing tells");
    assert.equal(refreshSmtpCheck(), null, "one at a time");
    await run;
    assert.deepEqual([mailCheck()?.ok, mailCheck()?.how], [false, "login"]);
    assert.equal(mailState(), "degraded");
    assert.equal(refreshSmtpCheck(), null, "fresh evidence: no new check");
  });
  resetMailCheck();
  assert.equal(refreshSmtpCheck(), null, "no SMTP: no check");
});
