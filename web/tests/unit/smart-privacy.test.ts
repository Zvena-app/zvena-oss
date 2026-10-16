import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { signInWith } from "@/lib/auth";
import { ask, noul, resetSmart, setWorkspaceGate } from "@/lib/decide/smart";
import { judge, smartDefault, newIngestToken, setSmart, settingsOf } from "@/lib/decide/engine";
import { personalColumns } from "@/lib/decide/adapters";
import type { Reaction } from "@/lib/decide/model";
import type { DbProperty } from "@/lib/notes/types";
import { createWorkspace } from "@/lib/workspaces";

// What leaves the server for the decision model, and when nothing does.

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `smartp-${name}`, name }, "2026-10-13");
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

async function modelMock(): Promise<Mock> {
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
  res.end(JSON.stringify({ model: "model-1.13.0", answers: { yes: { type: "noul", noul: 0.95 } }, usage: {} }));
}

async function withModel(fn: (m: Mock) => Promise<void>) {
  resetSmart();
  const m = await modelMock();
  Object.assign(process.env, { ZVENA_AI_KEY: "test-key", ZVENA_AI_URL: m.url, ZVENA_AI_TIMEOUT_MS: "800" });
  try {
    await fn(m);
  } finally {
    resetSmart();
    delete process.env.ZVENA_AI_KEY;
    delete process.env.ZVENA_AI_DEFAULT;
    await m.close();
  }
}

const q = { yes: noul("Is it done?") };

test("smart: the workspace switch is checked inside ask() itself — off, unknown or missing workspace sends nothing", async () => {
  await withModel(async (m) => {
    const ws = createWorkspace(owner, "Gate").id;
    assert.ok(await ask(ws, { t: "on by default" }, q), "a workspace nobody switched follows the default (on)");
    assert.equal(m.bodies.length, 1);

    setSmart(ws, false, owner);
    assert.equal(await ask(ws, { t: "after the owner turned it off" }, q), null);
    assert.equal(await ask("", { t: "no workspace" }, q), null);
    assert.equal(m.bodies.length, 1, "nothing was sent while off or without a workspace");

    // Without the registered switch (a module that forgot it), it is off everywhere.
    setWorkspaceGate(null);
    try {
      setSmart(ws, true, owner);
      assert.equal(await ask(ws, { t: "no gate" }, q), null);
      assert.equal(m.bodies.length, 1, "fails closed");
    } finally {
      setWorkspaceGate((w) => settingsOf(w).smart);
    }
  });
});

test("smart: an answer that arrives after the owner turned it off is thrown away and not cached", async () => {
  await withModel(async (m) => {
    const ws = createWorkspace(owner, "In flight").id;
    m.reply = (res) => {
      setSmart(ws, false, owner); // the owner flips the switch while the question is out
      answer(res);
    };
    assert.equal(await ask(ws, { t: "in flight" }, q), null);
    setSmart(ws, true, owner);
    m.reply = (res) => answer(res);
    const again = await ask(ws, { t: "in flight" }, q);
    assert.ok(again);
    assert.equal(again.cached, false, "the discarded answer was not cached");
    assert.equal(m.bodies.length, 2);
  });
});

test("smart: ZVENA_AI_DEFAULT=off makes it opt-in; a live-numbers secret does not turn it on; the owner can", async () => {
  await withModel(async (m) => {
    process.env.ZVENA_AI_DEFAULT = "off";
    assert.equal(smartDefault(), false);
    const ws = createWorkspace(owner, "Opt-in").id;
    assert.equal(settingsOf(ws).smart, false);
    newIngestToken(ws, owner);
    assert.equal(settingsOf(ws).smart, false, "creating the settings row keeps the default");
    assert.equal(await ask(ws, { t: "opt-in" }, q), null);
    assert.equal(m.bodies.length, 0);
    setSmart(ws, true, owner);
    assert.ok(await ask(ws, { t: "opted in" }, q));
    assert.equal(m.bodies.length, 1);
    delete process.env.ZVENA_AI_DEFAULT;
    assert.equal(smartDefault(), true, "unset: on (the current default)");
  });
});

test("smart in a reaction: fields that name a person never leave the server", async () => {
  await withModel(async (m) => {
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
    assert.equal(v?.source, "model");
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
