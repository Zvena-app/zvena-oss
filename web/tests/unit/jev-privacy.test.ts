import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { ask, noul, resetJev, setWorkspaceGate } from "@/lib/decide/jev";
import { judge, jevDefault, newIngestToken, setJev, settingsOf } from "@/lib/decide/engine";
import { personalColumns } from "@/lib/decide/adapters";
import type { Reaction } from "@/lib/decide/model";
import type { DbProperty } from "@/lib/notes/types";
import { createWorkspace } from "@/lib/workspaces";

// What leaves the server for TypeSafe AI, and when nothing does.

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `jevp-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}
const owner = person("Grace");

interface Mock {
  url: string;
  bodies: Record<string, unknown>[];
  reply: (res: ServerResponse) => void;
  close: () => Promise<void>;
}

async function jevMock(): Promise<Mock> {
  const m: Mock = { url: "", bodies: [], reply: (res) => answer(res), close: async () => {} };
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      m.bodies.push(JSON.parse(raw) as Record<string, unknown>);
      m.reply(res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  m.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/systemone`;
  m.close = () => new Promise((r) => srv.close(() => r()));
  return m;
}

function answer(res: ServerResponse) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "jev-1.13.0", answers: { yes: { type: "noul", noul: 0.95 } }, usage: {} }));
}

async function withJev(fn: (m: Mock) => Promise<void>) {
  resetJev();
  const m = await jevMock();
  Object.assign(process.env, { TYPESAFE_API_KEY: "test-key", ZVENA_JEV_URL: m.url, ZVENA_JEV_TIMEOUT_MS: "800" });
  try {
    await fn(m);
  } finally {
    resetJev();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.ZVENA_JEV_DEFAULT;
    await m.close();
  }
}

const q = { yes: noul("Is it done?") };

test("jev: the workspace switch is checked inside ask() itself — off, unknown or missing workspace sends nothing", async () => {
  await withJev(async (m) => {
    const ws = createWorkspace(owner, "Gate").id;
    assert.ok(await ask(ws, { t: "on by default" }, q), "a workspace nobody switched follows the default (on)");
    assert.equal(m.bodies.length, 1);

    setJev(ws, false, owner);
    assert.equal(await ask(ws, { t: "after the owner turned it off" }, q), null);
    assert.equal(await ask("", { t: "no workspace" }, q), null);
    assert.equal(m.bodies.length, 1, "nothing was sent while off or without a workspace");

    // Without the registered switch (a module that forgot it), Jev is off everywhere.
    setWorkspaceGate(null);
    try {
      setJev(ws, true, owner);
      assert.equal(await ask(ws, { t: "no gate" }, q), null);
      assert.equal(m.bodies.length, 1, "fails closed");
    } finally {
      setWorkspaceGate((w) => settingsOf(w).jev);
    }
  });
});

test("jev: an answer that arrives after the owner turned Jev off is thrown away and not cached", async () => {
  await withJev(async (m) => {
    const ws = createWorkspace(owner, "In flight").id;
    m.reply = (res) => {
      setJev(ws, false, owner); // the owner flips the switch while the question is out
      answer(res);
    };
    assert.equal(await ask(ws, { t: "in flight" }, q), null);
    setJev(ws, true, owner);
    m.reply = (res) => answer(res);
    const again = await ask(ws, { t: "in flight" }, q);
    assert.ok(again);
    assert.equal(again.cached, false, "the discarded answer was not cached");
    assert.equal(m.bodies.length, 2);
  });
});

test("jev: ZVENA_JEV_DEFAULT=off makes Jev opt-in; a live-numbers secret does not turn it on; the owner can", async () => {
  await withJev(async (m) => {
    process.env.ZVENA_JEV_DEFAULT = "off";
    assert.equal(jevDefault(), false);
    const ws = createWorkspace(owner, "Opt-in").id;
    assert.equal(settingsOf(ws).jev, false);
    newIngestToken(ws, owner);
    assert.equal(settingsOf(ws).jev, false, "creating the settings row keeps the default");
    assert.equal(await ask(ws, { t: "opt-in" }, q), null);
    assert.equal(m.bodies.length, 0);
    setJev(ws, true, owner);
    assert.ok(await ask(ws, { t: "opted in" }, q));
    assert.equal(m.bodies.length, 1);
    delete process.env.ZVENA_JEV_DEFAULT;
    assert.equal(jevDefault(), true, "unset: on (the current default)");
  });
});

test("jev in a reaction: fields that name a person never leave the server", async () => {
  await withJev(async (m) => {
    const ws = createWorkspace(person("Ada"), "People").id;
    const reaction = (fields: string[]): Reaction => ({
      id: "r-people",
      name: "",
      on: true,
      when: { type: "projects" },
      if: { kind: "ask", question: "Is it done?", fields, auto: 0.9, suggest: 0.6 },
      then: [],
    }) as unknown as Reaction;
    const subject = { key: "issue:x", facts: { Title: "Ship the export", Assignee: "Grace Hopper", Status: "Done" }, personal: ["Assignee"] };

    const v = await judge(ws, reaction(["Title", "Assignee"]), subject);
    assert.equal(v?.source, "jev");
    assert.deepEqual(m.bodies[0].state, { Title: "Ship the export" }, "the assignee's name was dropped");

    assert.equal(await judge(ws, reaction(["Assignee"]), subject), null, "a question only about a person is not asked");
    assert.equal(m.bodies.length, 1);
  });
});

test("personal columns: person, created/edited by, e-mail and phone are marked; others are not", () => {
  const props = [
    { id: "a", name: "Name", type: "title" },
    { id: "b", name: "Owner", type: "person" },
    { id: "c", name: "Author", type: "created_by" },
    { id: "d", name: "Editor", type: "last_edited_by" },
    { id: "e", name: "Contact", type: "email" },
    { id: "f", name: "Phone", type: "phone" },
    { id: "g", name: "Notes", type: "text" },
  ] as DbProperty[];
  assert.deepEqual(personalColumns(props), ["Owner", "Author", "Editor", "Contact", "Phone"]);
});
