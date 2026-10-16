// Server-only: the DNS lookups behind domain verification (a TXT record for
// a workspace's domain, a CNAME or TXT record for a site's custom domain).
// Answers come from the system resolver with a short timeout. Tests swap the
// resolver; a test stand (ZVENA_STAND=test with the test sign-in on) also
// answers from records set through /api/enterprise/test-dns, so browser
// checks can verify a domain nobody owns.

import { Resolver } from "node:dns/promises";
import { config } from "../config";
import { sql } from "../store";

export interface DnsResolver {
  txt(name: string): Promise<string[]>;
  cname(name: string): Promise<string[]>;
}

const NO_ANSWER = new Set(["ENODATA", "ENOTFOUND", "ENONAME", "NXDOMAIN", "ESERVFAIL", "EREFUSED", "ETIMEOUT", "ECONNREFUSED", "ECANCELLED"]);

function systemResolver(): DnsResolver {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  const quiet = async <T>(p: Promise<T>, empty: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (NO_ANSWER.has(String((e as { code?: string }).code))) return empty;
      throw e;
    }
  };
  return {
    // A TXT record may come in several strings; they form one value.
    txt: async (name) => (await quiet(r.resolveTxt(name), [] as string[][])).map((chunks) => chunks.join("")),
    cname: async (name) => (await quiet(r.resolveCname(name), [] as string[])).map((h) => h.toLowerCase().replace(/\.+$/, "")),
  };
}

let override: DnsResolver | null = null;
/** Tests answer DNS themselves. */
export function setDnsForTests(r: DnsResolver | null): void {
  override = r;
}

const TEST_KEY = (type: "txt" | "cname", name: string) => `ent-test-dns:${type}:${name.toLowerCase()}`;

/** Test stand only: records answered instead of the real DNS. */
export function setTestRecords(type: "txt" | "cname", name: string, values: string[]): void {
  if (!config.devLogin) throw new Error("test DNS is for test stands only");
  if (values.length === 0) sql("DELETE FROM kv WHERE k = ?").run(TEST_KEY(type, name));
  else sql("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(TEST_KEY(type, name), JSON.stringify(values.slice(0, 20).map((v) => String(v).slice(0, 500))));
}

function testRecords(type: "txt" | "cname", name: string): string[] | null {
  if (!config.devLogin) return null;
  const row = sql("SELECT v FROM kv WHERE k = ?").get(TEST_KEY(type, name)) as { v: string } | undefined;
  if (!row) return null;
  try {
    const v = JSON.parse(row.v) as unknown;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

export function dns(): DnsResolver {
  if (override) return override;
  const sys = systemResolver();
  return {
    txt: async (name) => testRecords("txt", name) ?? sys.txt(name),
    cname: async (name) => (testRecords("cname", name) ?? (await sys.cname(name))).map((h) => h.toLowerCase().replace(/\.+$/, "")),
  };
}
