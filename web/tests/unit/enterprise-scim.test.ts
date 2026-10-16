import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSession, readSession, sessionCookieName, signInWith } from "@/lib/auth";
import { setDnsForTests } from "@/lib/enterprise/dns";
import { addDomain, verifyDomain } from "@/lib/enterprise/domains";
import { createScimToken, parseFilter, revokeScimToken } from "@/lib/enterprise/scim";
import { sql } from "@/lib/store";
import { createWorkspace, personalWorkspace, roleIn } from "@/lib/workspaces";
import { groupsOf } from "@/lib/notes/groups";

const V = "2026-10-13";
const txt = new Map<string, string[]>();
setDnsForTests({ txt: async (n) => txt.get(n) ?? [], cname: async () => [] });

function person(name: string, email: string): string {
  const r = signInWith({ provider: "dev", subject: `scim-${name}`, name, email, emailVerified: true }, V);
  assert.ok(r.ok);
  return r.ok ? r.user.id : "";
}

async function setup(domain: string) {
  const owner = person(`owner-${domain}`, `owner@${domain}`);
  const ws = createWorkspace(owner, `SCIM ${domain}`).id;
  txt.set(domain, [addDomain(ws, owner, domain).record]);
  assert.ok((await verifyDomain(ws, owner, domain)).ok);
  const { token, info } = createScimToken(ws, owner, "Okta");
  return { owner, ws, token, tokenId: info.id };
}

type Json = Record<string, unknown> & { Resources?: Record<string, unknown>[]; totalResults?: number };

async function scim(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json; headers: Headers }> {
  const route = await import("@/app/scim/v2/[...path]/route");
  const url = new URL(`http://localhost:3100/scim/v2/${path}`);
  const req = new Request(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/scim+json", accept: "application/scim+json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const fn = route[method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE"];
  const res = await fn(req, { params: Promise.resolve({ path: url.pathname.replace(/^\/scim\/v2\//, "").split("/").map(decodeURIComponent) }) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {}, headers: res.headers };
}

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

test("SCIM: a bearer token is required, works for its own workspace only, and stops when revoked", async () => {
  const a = await setup("scim-auth.com");
  const b = await setup("scim-other.com");
  assert.equal((await scim(null, "GET", "Users")).status, 401);
  assert.equal((await scim("zvscim_nope", "GET", "Users")).status, 401);
  assert.equal((await scim("Bearer-less", "GET", "Users")).status, 401);
  const listA = await scim(a.token, "GET", "Users");
  assert.equal(listA.status, 200);
  assert.ok(listA.headers.get("content-type")?.startsWith("application/scim+json"));
  // B's token sees B's owner, never A's.
  const ids = ((await scim(b.token, "GET", "Users")).body.Resources ?? []).map((r) => r.id);
  assert.ok(ids.includes(b.owner) && !ids.includes(a.owner));
  assert.equal((await scim(b.token, "GET", `Users/${a.owner}`)).status, 404);
  // Only the HMAC of the token is stored.
  assert.equal(sql("SELECT 1 FROM ent_scim_tokens WHERE hash = ?").get(a.token), undefined);
  assert.ok(revokeScimToken(a.ws, a.owner, a.tokenId));
  assert.equal((await scim(a.token, "GET", "Users")).status, 401);
  // A personal workspace takes no SCIM token's requests.
  const p = personalWorkspace(a.owner, "Personal");
  const t = createScimToken(p.id, a.owner, "x").token;
  assert.equal((await scim(t, "GET", "Users")).status, 401);
});

test("SCIM: discovery endpoints (ServiceProviderConfig, ResourceTypes, Schemas)", async () => {
  const { token } = await setup("scim-disco.com");
  const spc = await scim(token, "GET", "ServiceProviderConfig");
  assert.equal(spc.status, 200);
  assert.deepEqual([(spc.body.patch as { supported: boolean }).supported, (spc.body.bulk as { supported: boolean }).supported, (spc.body.filter as { supported: boolean }).supported], [true, false, true]);
  const rt = await scim(token, "GET", "ResourceTypes");
  assert.deepEqual((rt.body.Resources ?? []).map((r) => r.id), ["User", "Group"]);
  assert.equal((await scim(token, "GET", "ResourceTypes/User")).body.endpoint, "/Users");
  const schemas = await scim(token, "GET", "Schemas");
  assert.equal(schemas.body.totalResults, 2);
  assert.equal((await scim(token, "GET", `Schemas/${USER}`)).body.name, "User");
});

test("SCIM Users (RFC 7644 §3.3): create → member, find by filter, page, get; duplicates are 409", async () => {
  const { ws, token } = await setup("example-scim.com");
  // RFC 7644 §3.3's example, with an address at the verified domain.
  const created = await scim(token, "POST", "Users", {
    schemas: [USER],
    userName: "bjensen@example-scim.com",
    externalId: "bjensen",
    name: { formatted: "Ms. Barbara J Jensen III", familyName: "Jensen", givenName: "Barbara" },
    emails: [{ value: "bjensen@example-scim.com", type: "work", primary: true }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id as string;
  assert.equal(created.headers.get("location"), `http://localhost:3100/scim/v2/Users/${id}`);
  assert.equal(created.body.userName, "bjensen@example-scim.com");
  assert.equal(created.body.externalId, "bjensen");
  assert.equal(created.body.active, true);
  assert.equal(roleIn(id, ws), "editor");
  assert.equal((sql("SELECT name FROM users WHERE id = ?").get(id) as { name: string }).name, "Ms. Barbara J Jensen III");
  // The same userName again: 409 uniqueness.
  const dup = await scim(token, "POST", "Users", { schemas: [USER], userName: "bjensen@example-scim.com" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.scimType, "uniqueness");
  // Not at a verified domain: refused (no accounts made up for other people's addresses).
  assert.equal((await scim(token, "POST", "Users", { schemas: [USER], userName: "someone@gmail.com" })).status, 400);
  // §3.4.2.2 filtering, as Okta and Entra ask.
  const f = await scim(token, "GET", `Users?filter=${encodeURIComponent('userName eq "BJensen@example-scim.com"')}`);
  assert.deepEqual([f.body.totalResults, (f.body.Resources ?? [])[0]?.id], [1, id]);
  assert.equal((await scim(token, "GET", `Users?filter=${encodeURIComponent('externalId eq "bjensen"')}`)).body.totalResults, 1);
  assert.equal((await scim(token, "GET", `Users?filter=${encodeURIComponent('userName eq "nobody@example-scim.com"')}`)).body.totalResults, 0);
  assert.equal((await scim(token, "GET", `Users?filter=${encodeURIComponent("userName regex x")}`)).status, 400);
  // §3.4.2.4 pagination.
  for (const n of ["a", "b", "c"]) assert.equal((await scim(token, "POST", "Users", { schemas: [USER], userName: `${n}@example-scim.com` })).status, 201);
  const p1 = await scim(token, "GET", "Users?startIndex=1&count=2");
  const p2 = await scim(token, "GET", "Users?startIndex=3&count=2");
  assert.deepEqual([p1.body.totalResults, p1.body.itemsPerPage, p1.body.startIndex, p2.body.itemsPerPage, p2.body.startIndex], [5, 2, 1, 2, 3]);
  const got = await scim(token, "GET", `Users/${id}`);
  assert.equal((got.body.name as { givenName: string }).givenName, "Barbara");
  assert.equal((got.body.meta as { resourceType: string }).resourceType, "User");
});

test("SCIM Users: deactivation (Okta's and Entra's PATCH, PUT, DELETE) removes the member and ends a managed account's sessions", async () => {
  const { ws, token, owner } = await setup("scim-life.com");
  const mk = async (u: string) => (await scim(token, "POST", "Users", { schemas: [USER], userName: `${u}@scim-life.com`, name: { givenName: u, familyName: "Test" } })).body.id as string;
  const okta = await mk("okta");
  const cookie = `${sessionCookieName()}=${issueSession(okta)}`;
  assert.ok(readSession(cookie));
  // Okta: no path, the value's attributes.
  const off = await scim(token, "PATCH", `Users/${okta}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, false);
  assert.equal(roleIn(okta, ws), null);
  assert.equal(readSession(cookie), null, "signed out");
  // Still known to the directory, and back with active=true.
  assert.equal((await scim(token, "GET", `Users/${okta}`)).body.active, false);
  const on = await scim(token, "PATCH", `Users/${okta}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: true }] });
  assert.deepEqual([on.body.active, roleIn(okta, ws)], [true, "editor"]);
  // Entra: capitalised op, a path, and "False" as a string; names by path.
  const entra = await mk("entra");
  const e = await scim(token, "PATCH", `Users/${entra}`, {
    schemas: [PATCH],
    Operations: [
      { op: "Replace", path: "name.givenName", value: "Erin" },
      { op: "Add", path: 'emails[type eq "work"].value', value: "entra@scim-life.com" },
      { op: "Replace", path: "active", value: "False" },
    ],
  });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal((e.body.name as { givenName: string }).givenName, "Erin");
  assert.equal(roleIn(entra, ws), null);
  // PUT replaces (active absent = active).
  const put = await scim(token, "PUT", `Users/${entra}`, { schemas: [USER], userName: "entra@scim-life.com", name: { givenName: "Erin", familyName: "Ent" }, active: true });
  assert.deepEqual([put.status, roleIn(entra, ws)], [200, "editor"]);
  // DELETE: gone from the workspace and from the directory's view.
  assert.equal((await scim(token, "DELETE", `Users/${entra}`)).status, 204);
  assert.equal(roleIn(entra, ws), null);
  assert.equal((await scim(token, "GET", `Users/${entra}`)).status, 404);
  // The owner can never be deprovisioned.
  const o = await scim(token, "PATCH", `Users/${owner}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
  assert.equal(o.status, 400);
  assert.equal(roleIn(owner, ws), "owner");
  assert.equal((await scim(token, "DELETE", `Users/${owner}`)).status, 400);
  // A PATCH that is not a PatchOp, or an unknown op, is a 400.
  assert.equal((await scim(token, "PATCH", `Users/${okta}`, { Operations: [{ op: "replace", value: { active: false } }] })).status, 400);
  assert.equal((await scim(token, "PATCH", `Users/${okta}`, { schemas: [PATCH], Operations: [{ op: "move", path: "active" }] })).status, 400);
  // Every change is in the audit log, by the token.
  assert.ok(sql("SELECT 1 FROM audit WHERE action = 'scim.user.deactivate' AND target = ? AND actor LIKE 'scim:%'").get(ws));
});

test("SCIM Users: a directory renames and re-addresses only the accounts it manages", async () => {
  const { ws, token } = await setup("scim-own.com");
  // An existing member with a personal address joins the directory's view by PATCH, but keeps their name.
  const outsider = person("Outsider", "outsider@personal.net");
  sql("INSERT INTO members (ws_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)").run(ws, outsider, Date.now());
  const r = await scim(token, "PATCH", `Users/${outsider}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "displayName", value: "Hacked Name" }] });
  assert.equal(r.status, 200);
  assert.equal((sql("SELECT name FROM users WHERE id = ?").get(outsider) as { name: string }).name, "Outsider");
  // A managed account follows the directory, but never to an address outside the verified domains.
  const id = (await scim(token, "POST", "Users", { schemas: [USER], userName: "moves@scim-own.com" })).body.id as string;
  await scim(token, "PATCH", `Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "userName", value: "moved@scim-own.com" }] });
  assert.equal((sql("SELECT email FROM users WHERE id = ?").get(id) as { email: string }).email, "moved@scim-own.com");
  await scim(token, "PATCH", `Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "userName", value: "victim@gmail.com" }] });
  assert.equal((sql("SELECT email FROM users WHERE id = ?").get(id) as { email: string }).email, "moved@scim-own.com");
});

test("SCIM Groups (RFC 7644 §3.5.2): create, add and remove members, rename, replace, delete", async () => {
  const { ws, token } = await setup("scim-groups.com");
  const mk = async (u: string) => (await scim(token, "POST", "Users", { schemas: [USER], userName: `${u}@scim-groups.com` })).body.id as string;
  const [u1, u2, u3] = [await mk("u1"), await mk("u2"), await mk("u3")];
  const g = await scim(token, "POST", "Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Tour Guides", externalId: "okta-1", members: [{ value: u1 }, { value: "not-a-member-id" }] });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gid = g.body.id as string;
  assert.deepEqual(((g.body.members as { value: string }[]) ?? []).map((m) => m.value), [u1]);
  assert.equal((await scim(token, "POST", "Groups", { displayName: "tour guides" })).status, 409);
  // §3.5.2.1 add members.
  const add = await scim(token, "PATCH", `Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ display: "u2", value: u2 }, { value: u3 }] }] });
  assert.equal(add.status, 200);
  assert.deepEqual(groupsOf(ws).find((x) => x.id === gid)?.members.sort(), [u1, u2, u3].sort());
  // §3.5.2.2 remove one member by filter path.
  await scim(token, "PATCH", `Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${u2}"]` }] });
  // Entra's remove with a value list, and a rename.
  await scim(token, "PATCH", `Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "Remove", path: "members", value: [{ value: u3 }] }, { op: "Replace", path: "displayName", value: "Guides" }] });
  let now = groupsOf(ws).find((x) => x.id === gid);
  assert.deepEqual([now?.name, now?.members], ["Guides", [u1]]);
  // §3.5.2.3 replace members; Okta's no-path replace of the name.
  await scim(token, "PATCH", `Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "members", value: [{ value: u2 }, { value: u3 }] }, { op: "replace", value: { id: gid, displayName: "Guides EU" } }] });
  now = groupsOf(ws).find((x) => x.id === gid);
  assert.deepEqual([now?.name, now?.members.sort()], ["Guides EU", [u2, u3].sort()]);
  // Filtering and excludedAttributes (Entra lists groups without members).
  const f = await scim(token, "GET", `Groups?filter=${encodeURIComponent('displayName eq "Guides EU"')}&excludedAttributes=members`);
  assert.deepEqual([f.body.totalResults, "members" in ((f.body.Resources ?? [])[0] ?? {})], [1, false]);
  // PUT replaces everything; a deactivated user leaves the groups with the workspace.
  const put = await scim(token, "PUT", `Groups/${gid}`, { displayName: "Guides", members: [{ value: u1 }, { value: u3 }] });
  assert.deepEqual(((put.body.members as { value: string }[]) ?? []).map((m) => m.value).sort(), [u1, u3].sort());
  await scim(token, "PATCH", `Users/${u3}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
  assert.deepEqual(groupsOf(ws).find((x) => x.id === gid)?.members, [u1]);
  assert.equal((await scim(token, "DELETE", `Groups/${gid}`)).status, 204);
  assert.equal(groupsOf(ws).length, 0);
  assert.equal((await scim(token, "GET", `Groups/${gid}`)).status, 404);
});

test("SCIM filters: the subset directories send parses; the rest is refused", () => {
  assert.deepEqual(parseFilter('userName eq "a@b.c"'), [{ attr: "username", op: "eq", value: "a@b.c" }]);
  assert.deepEqual(parseFilter('emails[type eq "work"].value eq "x@y.z" and active eq true')?.map((c) => [c.attr, c.value]), [
    ["emails.value", "x@y.z"],
    ["active", true],
  ]);
  assert.equal(parseFilter("userName eq unquoted"), null);
  assert.equal(parseFilter("(userName eq \"a\")"), null);
  assert.deepEqual(parseFilter(null), []);
});
