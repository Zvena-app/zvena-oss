// What pages now send along with themselves (so the first paint needs no
// round trip) is read with the same access as the API it replaces, and the
// live stream outlives a client-side section switch.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInWith } from "@/lib/auth";
import { CalAccess } from "@/lib/calendar/access";
import { initialCalendar } from "@/lib/calendar/api";
import { savePrefs } from "@/lib/calendar/calendars";
import { createEvent } from "@/lib/calendar/events";
import { initialInbox } from "@/lib/eco/inbox-page";
import { inboxOf, notify } from "@/lib/eco/inbox";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

function person(name: string): { id: string; name: string } {
  const r = signInWith({ provider: "dev", subject: `perf-boot-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return { id: r.ok ? r.user.id : "", name };
}

const owner = person("Owen Boot");
const mate = person("Mia Boot");
const outsider = person("Oscar Boot");
const ws = createWorkspace(owner.id, "Boot team").id;
acceptInvite(mate.id, createInvite(owner.id, ws, "editor").token);
createWorkspace(outsider.id, "Elsewhere");

const DAY = 86_400_000;
const range = () => ({ from: Date.UTC(2026, 9, 11), to: Date.UTC(2026, 9, 20), upcomingFrom: Date.UTC(2026, 9, 15), upcomingTo: Date.UTC(2026, 9, 15) + 8 * DAY });

test("the calendar page's copy: members only, once their zone is saved, with what GET bootstrap and GET events say", async () => {
  // A first visit (no saved zone) waits for the browser's zone: nothing is sent along.
  assert.equal(await initialCalendar(owner, ws, "en", range), null);
  savePrefs(owner.id, { tz: "UTC" });
  const first = await initialCalendar(owner, ws, "en", range);
  assert.ok(first?.boot && first.events && first.upcoming);
  const cal = first.boot.calendars.find((c) => c.isDefault) ?? first.boot.calendars[0];
  assert.ok(cal, "the default calendar exists");
  createEvent(new CalAccess(owner.id, ws), { calId: cal.id, title: "Standup", start: Date.UTC(2026, 9, 16, 9), end: Date.UTC(2026, 9, 16, 9, 30), tz: "UTC" });
  const again = await initialCalendar(owner, ws, "en", range);
  assert.deepEqual(
    again?.events?.items.map((e) => e.title),
    ["Standup"]
  );
  assert.equal(again?.events?.tz, "UTC");
  assert.deepEqual(
    again?.upcoming?.items.map((e) => e.title),
    ["Standup"]
  );
  // Not a member: nothing, whatever the zone.
  savePrefs(outsider.id, { tz: "UTC" });
  assert.equal(await initialCalendar(outsider, ws, "en", range), null);
});

test("the Inbox page's copy is the person's own Inbox, and nothing for someone outside the workspace", async () => {
  notify(mate.id, { ws, kind: "mention", ref: "issue:abcdefgh12", by: owner.id, text: "look" });
  const mine = await initialInbox(mate.id, ws, "en");
  assert.deepEqual(mine, await inboxOf({ userId: mate.id, wsId: ws, locale: "en" }, { archived: false }));
  assert.equal(await initialInbox(outsider.id, ws, "en"), null);
});

test("the live stream stays open across a section switch, and closes once nobody listens", async () => {
  const opened: { url: string; closed: boolean }[] = [];
  class FakeSource {
    static CLOSED = 2;
    readyState = 0;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    rec: { url: string; closed: boolean };
    constructor(url: string) {
      this.rec = { url, closed: false };
      opened.push(this.rec);
    }
    addEventListener(): void {}
    close(): void {
      this.rec.closed = true;
    }
  }
  const g = globalThis as Record<string, unknown>;
  g.window = { addEventListener: () => {} };
  g.document = { addEventListener: () => {}, visibilityState: "visible" };
  g.EventSource = FakeSource;
  const timers: { fn: () => void; ms: number }[] = [];
  const realSet = globalThis.setTimeout;
  g.setTimeout = ((fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  try {
    const { pulse } = await import("@/lib/pulse/client");
    const leaveA = pulse().join("ws-boot-1");
    assert.equal(opened.length, 1);
    leaveA();
    // The next section joins before the stream would close: the same connection.
    const leaveB = pulse().join("ws-boot-1");
    assert.equal(opened.length, 1);
    // The first section's wait running out now changes nothing: someone listens.
    for (const t of timers.splice(0)) t.fn();
    assert.equal(opened[0].closed, false);
    leaveB();
    assert.equal(opened[0].closed, false, "still open for a while");
    for (const t of timers.splice(0)) t.fn();
    assert.equal(opened[0].closed, true, "closed once the wait is over and nobody joined");
  } finally {
    g.setTimeout = realSet;
    delete g.window;
    delete g.document;
    delete g.EventSource;
  }
});
