// The right to erasure, table by table: a person with a row in every table keyed by a
// person (user_id / owner_id columns, wherever a module creates them) leaves none behind.
import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteAccount } from "@/lib/account";
import { signInWith } from "@/lib/auth";
import { calDb } from "@/lib/calendar/db";
import { revokeAllClippers } from "@/lib/clipper";
import { ensureSchema } from "@/lib/decide/engine";
import { trackEvent } from "@/lib/decide/flows";
import { saveSource } from "@/lib/decide/sources";
import { ecoDb } from "@/lib/eco/schema";
import { ensureTables as enterpriseTables } from "@/lib/enterprise/tables";
import { mailDb } from "@/lib/mail-client/schema";
import { apiTables } from "@/lib/notes/api/schema";
import { favoritesOf } from "@/lib/notes/favorites";
import { dropUserDocsPrefs } from "@/lib/notes/follows";
import { sendDigests } from "@/lib/notes/mail-digest";
import { ctxFor } from "@/lib/projects/core";
import { listTeams } from "@/lib/projects/teams";
import { sql, store } from "@/lib/store";
import { rememberUserLocale } from "@/lib/user-locale";
import { acceptInvite, createInvite, createWorkspace } from "@/lib/workspaces";

function person(name: string): string {
  const r = signInWith({ provider: "dev", subject: `erase-${name}`, name }, "2026-10-13");
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

/** Columns that say whose a row is. */
const PERSON_COLS = new Set(["user_id", "owner_id"]);
/** Handled through membership (owned workspaces pass on or go; tests in workspaces/notes-server). */
const SKIP = new Set(["users", "workspaces", "members"]);

test("account deletion leaves no row of the person in any table keyed by a person", async () => {
  const gone = person("Gone");
  const stays = person("Stays");
  const ws = createWorkspace(gone, "Shared").id;
  assert.ok(acceptInvite(stays, createInvite(gone, ws, "editor").token));
  // Every module's tables, as the server creates them on first use.
  ensureSchema();
  calDb();
  mailDb();
  ecoDb();
  enterpriseTables();
  apiTables();
  listTeams(ctxFor(gone, ws, "read"));
  revokeAllClippers("-");
  dropUserDocsPrefs("-");
  await sendDigests();
  rememberUserLocale(gone, "fr");
  // What the server writes for them along the way.
  favoritesOf(ws, gone, true);
  const mail = saveSource(ws, { kind: "mail", view: "inbox", measure: "unread" }, gone);
  assert.ok(!("error" in mail));
  trackEvent(ws, "event-1", "issue-1", "2026-10-20", gone);

  // One row of theirs in every other table with a person's column (other columns: placeholders).
  const d = store();
  const tables = (sql("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[]).filter((t) => !SKIP.has(t.name));
  const covered: { table: string; col: string }[] = [];
  const rows = (table: string, col: string) => Number((sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(gone) as { n: number }).n);
  d.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const t of tables) {
      const cols = sql(`PRAGMA table_info(${t.name})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
      const mine = cols.filter((c) => PERSON_COLS.has(c.name));
      if (!mine.length) continue;
      const values = cols.map((c) => {
        if (PERSON_COLS.has(c.name)) return gone;
        if (c.name === "ws" || c.name === "ws_id") return ws;
        const check = new RegExp(`\\b${c.name}\\b[^,]*CHECK \\(${c.name} IN \\('([^']+)'`).exec(t.sql);
        if (check) return check[1];
        if (/INT|REAL/i.test(c.type)) return c.pk ? Math.floor(Math.random() * 1e9) : 0;
        if (/BLOB/i.test(c.type)) return new Uint8Array([1]);
        return `${t.name}-${c.name}-${Math.random().toString(36).slice(2)}`;
      });
      // OR IGNORE: a row the steps above already wrote for them (their language) is theirs as well.
      sql(`INSERT OR IGNORE INTO ${t.name} (${cols.map((c) => c.name).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...values);
      for (const c of mine) {
        assert.ok(rows(t.name, c.name) > 0, `a row of theirs in ${t.name}`);
        covered.push({ table: t.name, col: c.name });
      }
    }
  } finally {
    d.exec("PRAGMA foreign_keys = ON");
  }
  // The ones the audit found left behind are among them.
  for (const name of ["user_tz", "note_mail_digest", "note_reminders", "clipper_codes", "cal_prefs", "mail_prefs", "user_locale"]) assert.ok(covered.some((c) => c.table === name), `${name} is checked`);

  await deleteAccount(gone);

  const left = covered.filter((c) => rows(c.table, c.col) > 0);
  assert.deepEqual(left, [], "no row of the person is left");
  // Kept elsewhere under their id: their mail number, a meeting they followed, a migration marker.
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM dz_sources WHERE created_by = ?").get(gone) as { n: number }).n), 0);
  assert.equal(sql("SELECT 1 FROM dz_metrics WHERE ws = ? AND key = ?").get(ws, mail.key), undefined);
  assert.equal(Number((sql("SELECT COUNT(*) AS n FROM dz_flows WHERE by = ?").get(gone) as { n: number }).n), 0);
  assert.equal(sql("SELECT 1 FROM kv WHERE k LIKE ?").get(`%${gone}%`), undefined);
  // The workspace and its other member stay.
  assert.ok(sql("SELECT 1 FROM members WHERE ws_id = ? AND user_id = ?").get(ws, stays));
});
