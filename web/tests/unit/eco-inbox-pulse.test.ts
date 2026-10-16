// An Inbox poke on the live stream reaches only the person it is about.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleTo } from "@/lib/pulse/bus";
import { registerEcoFilters } from "@/lib/eco/visibility";

test("an Inbox poke is heard by its owner only (it used to tell every member, now even about new mail)", () => {
  registerEcoFilters();
  const e = { type: "inbox", ws: "w1", ref: "alice", by: "bob" } as Parameters<typeof visibleTo>[1];
  assert.equal(visibleTo("alice", e), true);
  assert.equal(visibleTo("carol", e), false);
});
