// Documents keep the last edits on this device: the page going away with an
// IndexedDB write unfinished, IndexedDB refusing writes, held-back typing.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NotesStore } from "@/lib/notes/store";

// ---------------------------------------------------------------------------
// A small in-memory IndexedDB (what store.ts uses of it) whose writes can be
// made to fail or to never finish (a page that closed mid-write).

type Rows = Map<unknown, unknown>;
const disk = new Map<string, Rows>();
const mode = { fail: false, hang: false };

function fakeIndexedDb() {
  const db = {
    objectStoreNames: { contains: (n: string) => disk.has(n) },
    createObjectStore: (n: string) => {
      disk.set(n, new Map());
      return { createIndex: () => undefined };
    },
    transaction: (names: string | string[], txMode: string) => {
      const staged: (() => void)[] = [];
      let aborted = false;
      let pending = 0;
      const t = {
        error: null as unknown,
        oncomplete: null as null | (() => void),
        onerror: null as null | (() => void),
        onabort: null as null | (() => void),
        abort: () => {
          aborted = true;
        },
        objectStore: (n: string) => {
          const rows = disk.get(n)!;
          const keyOf = (v: unknown, k?: unknown) => k ?? (v as { id?: string; key?: string }).id ?? (v as { key?: string }).key;
          // Every request answers in a microtask; the transaction ends once none is left.
          const op = <T>(run: () => T, write = false) => {
            pending++;
            const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
            queueMicrotask(() => {
              try {
                if (write) staged.push(run as () => void);
                else r.result = run();
                r.onsuccess?.();
              } catch (e) {
                r.error = e;
                r.onerror?.();
              }
              if (--pending === 0) queueMicrotask(finish);
            });
            return r;
          };
          return {
            get: (k: unknown) => op(() => rows.get(k)),
            getAll: () => op(() => [...rows.values()]),
            put: (v: unknown, k?: unknown) => op(() => rows.set(keyOf(v, k), structuredClone(v)), true),
            delete: (k: unknown) => op(() => rows.delete(k), true),
            clear: () => op(() => rows.clear(), true),
            index: () => ({ getAll: () => op(() => []), getAllKeys: () => op(() => []) }),
          };
        },
      };
      const finish = () => {
        if (pending > 0) return;
        if (aborted) return t.onabort?.();
        if (txMode === "readwrite" && mode.hang) return; // the page closed: never completes
        if (txMode === "readwrite" && mode.fail) {
          t.error = new Error("QuotaExceededError");
          return t.onerror?.();
        }
        staged.forEach((w) => w());
        t.oncomplete?.();
      };
      void names;
      return t;
    },
  };
  return {
    open: () => {
      const req: { result: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: db };
      queueMicrotask(() => {
        if (!disk.has("notes")) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const local = new Map<string, string>();
Object.assign(globalThis, {
  indexedDB: fakeIndexedDb(),
  // Node's BroadcastChannel keeps the process alive; tabs are not what this tests.
  BroadcastChannel: class {
    onmessage: unknown = null;
    postMessage(): void {}
    close(): void {}
  },
  localStorage: {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
  },
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const bodyOf = (s: NotesStore, id: string) => JSON.stringify(s.get(id)?.content ?? []);

function fresh(): void {
  disk.clear();
  local.clear();
  mode.fail = false;
  mode.hang = false;
}

test("typing held back by the editor is in the next load after the page goes away mid-write", async () => {
  fresh();
  const a = new NotesStore();
  await a.load();
  const n = a.create({ kind: "page", title: "Plan" });
  // The server confirmed the new page (sync clears pending).
  a.saveMeta({ pending: [] });
  await a.flush();
  // The editor's 350 ms wait: the store has not seen this text yet.
  let held: unknown[] | null = [{ type: "paragraph", content: "typed then reloaded" }];
  a.holdEdits(() => {
    if (held) a.update(n.id, { content: held });
    held = null;
  });
  // The page goes away; its IndexedDB write never finishes.
  mode.hang = true;
  a.persistNow();
  await tick();
  mode.hang = false;

  const b = new NotesStore();
  await b.load();
  assert.match(bodyOf(b, n.id), /typed then reloaded/);
  assert.equal(b.get(n.id)?.title, "Plan");
  // …and it goes out to the server like the edit it was.
  assert.ok(b.meta.pending.includes(n.id));
  assert.deepEqual(b.meta.fields?.[n.id], ["content"]);
  // Once IndexedDB has it, the journal lets it go.
  await b.flush();
  assert.equal(local.size, 0);
});

test("an older journal never replaces a newer copy in IndexedDB", async () => {
  fresh();
  const a = new NotesStore();
  await a.load();
  const n = a.create({ kind: "page", title: "Old" });
  mode.hang = true;
  a.persistNow();
  await tick();
  mode.hang = false;
  // Another tab wrote a newer version meanwhile.
  const other = new NotesStore();
  await other.load();
  other.update(n.id, { title: "Newer" });
  await other.flush();
  local.set("zvena-docs-unsaved", JSON.stringify({ owner: "", notes: [{ ...a.get(n.id), title: "Old", updatedAt: 1 }] }));
  const b = new NotesStore();
  await b.load();
  assert.equal(b.get(n.id)?.title, "Newer");
});

test("another account's journal is not taken into this store", async () => {
  fresh();
  const a = new NotesStore();
  await a.load();
  const n = a.create({ kind: "page", title: "Mine" });
  await a.flush();
  local.set("zvena-docs-unsaved", JSON.stringify({ owner: "someone@else", notes: [{ ...a.get(n.id), title: "Theirs", updatedAt: Date.now() + 1000 }] }));
  const b = new NotesStore();
  await b.load();
  assert.equal(b.get(n.id)?.title, "Mine");
});

test("IndexedDB refusing writes: the state says so, the edit stays, Retry saves it", async () => {
  fresh();
  const s = new NotesStore();
  await s.load();
  const states: string[] = [];
  s.subscribeSave(() => states.push(s.getSaveState()));
  const n = s.create({ kind: "page", title: "Quota" });
  mode.fail = true;
  await s.flush();
  assert.equal(s.getSaveState(), "failed");
  assert.equal(s.get(n.id)?.title, "Quota");
  // Kept in the journal meanwhile.
  assert.match(local.get("zvena-docs-unsaved") ?? "", /Quota/);
  mode.fail = false;
  await s.retrySave();
  assert.equal(s.getSaveState(), "saved");
  assert.ok(states.includes("failed") && states.at(-1) === "saved");
  const again = new NotesStore();
  await again.load();
  assert.equal(again.get(n.id)?.title, "Quota");
  assert.equal(local.size, 0);
});

test("notes sync brought in are never journaled as this device's edits", async () => {
  fresh();
  const s = new NotesStore();
  await s.load();
  const n = s.create({ kind: "page", title: "Local" });
  await s.flush();
  s.applyRemote([{ ...s.get(n.id)!, id: "remote-1", title: "From server", updatedAt: Date.now() }], []);
  mode.hang = true;
  s.persistNow();
  await tick();
  mode.hang = false;
  assert.doesNotMatch(local.get("zvena-docs-unsaved") ?? "", /From server/);
});

test("without IndexedDB the store says it keeps nothing", async () => {
  fresh();
  const saved = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
  try {
    const s = new NotesStore();
    await s.load();
    assert.equal(s.getSaveState(), "memory");
  } finally {
    (globalThis as { indexedDB?: unknown }).indexedDB = saved;
  }
});
