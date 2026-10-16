import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renameLegacyValues } from "@/lib/legacy-migrate";
import { LEGACY_ONLY_IF_FIELD } from "@/lib/legacy-names";
import { cleanAutomations } from "@/lib/notes/automations";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// The former name, as earlier releases stored it (never spelled in tests either).
const OLD = LEGACY_ONLY_IF_FIELD;

test("legacy names: values stored by earlier releases are rewritten in place, idempotently", () => {
  const d = new DatabaseSync(":memory:");
  d.exec(`
    CREATE TABLE dz_settings (ws TEXT PRIMARY KEY, ${OLD} INTEGER NOT NULL DEFAULT 0, ingest_hash TEXT, updated_by TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE dz_decisions (id TEXT PRIMARY KEY, source TEXT NOT NULL, actions TEXT);
    CREATE TABLE pj_activity (id INTEGER PRIMARY KEY, via TEXT);
    CREATE TABLE eco_inbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE audit (at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, meta TEXT);
    CREATE TABLE note_automation_runs (ws TEXT NOT NULL, db_id TEXT NOT NULL, automation_id TEXT NOT NULL, at INTEGER NOT NULL, runs INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1, error TEXT, PRIMARY KEY (ws, db_id, automation_id));
  `);
  const cap = OLD[0].toUpperCase() + OLD.slice(1);
  d.prepare(`INSERT INTO dz_settings (ws, ${OLD}, updated_at) VALUES ('on', 1, 0), ('off', 0, 0)`).run();
  d.prepare("INSERT INTO dz_decisions (id, source, actions) VALUES ('a', ?, ?), ('b', 'rule', NULL)").run(OLD, JSON.stringify({ kind: "automation", db: "x", row: "y", automation: "z", [OLD]: '{"question":"Bug?"}' }));
  d.prepare("INSERT INTO pj_activity (via) VALUES (?), (NULL)").run(OLD);
  d.prepare("INSERT INTO eco_inbox (id, kind) VALUES ('i', ?), ('j', 'mention')").run(OLD);
  d.prepare("INSERT INTO audit (at, action) VALUES (1, ?), (2, ?)").run(`decide.${OLD}.on`, `decide.${OLD}.off`);
  d.prepare("INSERT INTO note_automation_runs (ws, db_id, automation_id, at, error) VALUES ('w', 'd', '1', 0, ?), ('w', 'd', '2', 0, ?), ('w', 'd', '3', 0, ?), ('w', 'd', '4', 0, 'webhook failed')").run(
    `${cap} said no (42%)`,
    `${cap} is off`,
    `${cap} did not answer`
  );

  for (let i = 0; i < 2; i++) renameLegacyValues(d);

  const all = (q: string) => (d.prepare(q).all() as Record<string, unknown>[]).map((r) => ({ ...r }));
  assert.deepEqual(all("SELECT ws, smart FROM dz_settings ORDER BY ws"), [
    { ws: "off", smart: 0 },
    { ws: "on", smart: 1 },
  ]);
  assert.deepEqual(all("SELECT source FROM dz_decisions ORDER BY id").map((r) => r.source), ["model", "rule"]);
  const actions = JSON.parse(String(all("SELECT actions FROM dz_decisions WHERE id = 'a'")[0].actions)) as Record<string, unknown>;
  assert.equal(actions.onlyIf, '{"question":"Bug?"}');
  assert.ok(!(OLD in actions));
  assert.deepEqual(all("SELECT via FROM pj_activity ORDER BY id").map((r) => r.via), ["auto", null]);
  assert.deepEqual(all("SELECT kind FROM eco_inbox ORDER BY id").map((r) => r.kind), ["proposal", "mention"]);
  assert.deepEqual(all("SELECT action FROM audit ORDER BY at").map((r) => r.action), ["decide.smart.on", "decide.smart.off"]);
  assert.deepEqual(all("SELECT error FROM note_automation_runs ORDER BY automation_id").map((r) => r.error), [
    "condition not met (42%)",
    "smart suggestions and automations are off",
    "the condition could not be checked in time",
    "webhook failed",
  ]);
  // Nothing anywhere still holds the former name.
  for (const t of ["dz_decisions", "pj_activity", "eco_inbox", "audit", "note_automation_runs"]) {
    assert.ok(!JSON.stringify(all(`SELECT * FROM ${t}`)).toLowerCase().includes(OLD), t);
  }
  d.close();
});

test("legacy names: a fresh database (or one without these tables) is left alone", () => {
  const d = new DatabaseSync(":memory:");
  renameLegacyValues(d);
  d.exec("CREATE TABLE dz_settings (ws TEXT PRIMARY KEY, smart INTEGER NOT NULL DEFAULT 0, ingest_hash TEXT, updated_by TEXT, updated_at INTEGER NOT NULL)");
  renameLegacyValues(d);
  assert.deepEqual((d.prepare("PRAGMA table_info(dz_settings)").all() as { name: string }[]).map((c) => c.name), ["ws", "smart", "ingest_hash", "updated_by", "updated_at"]);
  d.close();
});

test("legacy names: a Documents automation saved with the legacy condition key reads as “run only if”", () => {
  const [a] =
    cleanAutomations([{ id: "a1", name: "Mark bugs", on: true, trigger: { type: "added" }, [OLD]: { question: "Is this a bug?", fields: ["title"] }, actions: [{ type: "set", prop: "kind", value: "bug" }] }]) ?? [];
  assert.deepEqual(a.onlyIf, { question: "Is this a bug?", fields: ["title"] });
  assert.ok(!(OLD in a), "saved back under the current key only");
});
