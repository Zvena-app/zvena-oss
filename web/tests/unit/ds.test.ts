import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ToastStore } from "@/components/zvena/ds/toast-store";
import { formatKeys, isApple, isTyping } from "@/components/zvena/ds/keys";
import { relativeTime } from "@/components/zvena/ds/time";

test("toasts: one at a time, undo runs once, ⌘Z-style undo needs an undo, time runs out, hover pauses", async () => {
  let now = 1_000_000;
  const store = new ToastStore(() => now);
  const seen: (string | null)[] = [];
  store.subscribe((t) => seen.push(t ? t.text : null));

  const first = store.show("Saved", { kind: "success" });
  let undone = 0;
  const second = store.show("Issue deleted", { undo: () => void undone++ });
  assert.equal(store.get()?.id, second, "a new toast replaces the old one");
  assert.equal(store.get()?.until, now + 6000, "a toast with undo lives 6 s");
  assert.equal(store.undo(first), false, "the replaced toast cannot be undone");
  assert.equal(store.undo(), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(undone, 1);
  assert.equal(store.get(), null, "undo closes it");
  assert.equal(store.undo(), false, "nothing left to undo");

  store.show("Moved to Done");
  assert.equal(store.get()?.until, now + 3500, "a plain toast lives 3.5 s");
  store.pause();
  now += 10_000;
  store.tick();
  assert.equal(store.get()?.text, "Moved to Done", "a hovered toast stays");
  store.resume();
  assert.ok((store.get()?.until ?? 0) >= now + 1500, "it gets at least 1.5 s after hover ends");
  now += 4000;
  store.tick();
  assert.equal(store.get(), null);
  assert.deepEqual(seen.filter((x) => x !== null), ["Saved", "Issue deleted", "Moved to Done", "Moved to Done", "Moved to Done"]);
});

test("keys: ⌘ reads Ctrl off Apple; typing is detected in fields and editors, not on checkboxes", () => {
  assert.equal(isApple("MacIntel"), true);
  assert.equal(isApple("Win32"), false);
  assert.deepEqual(formatKeys(["⌘", "K"], true), ["⌘", "K"]);
  assert.deepEqual(formatKeys(["⌘", "⇧", "Z"], false), ["Ctrl", "Shift", "Z"]);
  assert.equal(isTyping({ tagName: "INPUT", type: "text", isContentEditable: false } as unknown as EventTarget), true);
  assert.equal(isTyping({ tagName: "INPUT", type: "checkbox", isContentEditable: false } as unknown as EventTarget), false);
  assert.equal(isTyping({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget), true);
  assert.equal(isTyping({ tagName: "BUTTON", isContentEditable: false } as unknown as EventTarget), false);
  assert.equal(isTyping(null), false);
});

test("relative time: minutes, hours, days, then a date — in both languages", () => {
  const now = Date.UTC(2026, 9, 14, 12, 0, 0);
  assert.match(relativeTime(now - 5 * 60_000, "en", now), /5 minutes ago/);
  assert.match(relativeTime(now - 5 * 60_000, "ru", now), /5 минут назад/);
  assert.match(relativeTime(now - 26 * 3600_000, "en", now), /yesterday/);
  assert.match(relativeTime(now - 30 * 86400_000, "en", now), /Sep/);
});
