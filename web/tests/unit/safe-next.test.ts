// After sign-in, people return only to a path on zvena itself.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "@/lib/safe-next";

test("safeNext keeps same-origin paths and refuses everything that could leave zvena", () => {
  for (const ok of ["/home", "/docs?ws=abc#Page-1", "/eco/from-design?team=x&thread=y", "/projects/issue/ABC-1?ws=w"]) assert.equal(safeNext(ok), ok);
  const bad = [
    "//evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r\n/evil.com",
    "/%09/evil.com".replace("%09", "\t"),
    "/\\evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "/ /evil.com",
    "/\u0000/evil.com",
    "evil.com",
    "",
  ];
  for (const b of bad) assert.equal(safeNext(b), "/home", JSON.stringify(b));
  assert.equal(safeNext(null), "/home");
  assert.equal(safeNext("/" + "a".repeat(2100)), "/home");
});
