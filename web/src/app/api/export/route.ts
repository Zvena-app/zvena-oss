import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { identitiesOf } from "@/lib/auth";
import { exportAllowed } from "@/lib/enterprise/security";
import { currentUser, fail } from "@/lib/http";
import { AccessResolver } from "@/lib/notes/access";
import { readableFor } from "@/lib/notes/server-store";
import { noteToMarkdown } from "@/lib/notes/markdown";
import { notesFilesDir } from "@/lib/notes/files";
import type { Note } from "@/lib/notes/types";
import { exportFile, exportList } from "@/lib/penpot";
import { exportProjects } from "@/lib/projects/export";
import { rateLimited } from "@/lib/rate-limit";
import { audit, sql } from "@/lib/store";
import { membersOf, workspacesOf } from "@/lib/workspaces";
import { setPeople } from "@/lib/notes/people";
import { zipStream, type ZipSource } from "@/lib/zip-stream";
import { translate } from "@/lib/i18n";
import { parseAcceptLanguage, readLocale } from "@/lib/locale-server";

export const dynamic = "force-dynamic";

// GET /api/export — everything the account holds, as one ZIP (streamed):
//   README.txt                    what is inside
//   account.json                  profile, sign-in methods, consent, workspaces and roles
//   security-log.json             the account's own security journal (sign-ins, exports…)
//   documents/<workspace>/…       documents.json (Documents' own format, importable)
//                                 and every page as Markdown
//   projects/<workspace>/…        Projects: projects.json (teams, projects, cycles,
//                                 issues with comments and history) and issues.csv
//   files/…                       files the account uploaded or pays for
//   design/<team>/<file>.penpot   designs (Penpot's format, importable into Design)
// Workspaces where the person is owner or editor are included, but not the
// documents and issues of a workspace whose owner disabled export
// (Settings → Security; its owners still get them).

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";


export async function GET(req: Request) {
  const rl = rateLimited(req, "export");
  if (rl) return rl;
  const me = currentUser(req);
  if (!me) return fail(401, "unauthorized");
  const user = me.user;
  // The README in Russian for Russian, else English.
  const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
  const workspaces = workspacesOf(user.id);
  const row = sql("SELECT created_at, consent_version, consent_at, email FROM users WHERE id = ?").get(user.id) as { created_at: number; consent_version: string | null; consent_at: number | null; email: string | null };
  const closed = workspaces.filter((w) => !exportAllowed(w.id, user.id));
  // An account event shows in every workspace's audit log: how many withheld, never which (each one logs its own below).
  audit(user.id, "data.export", null, closed.length ? { withheld: closed.length } : null);
  // Each workspace that withheld its content hears of the export too (its audit log).
  for (const w of closed) audit(user.id, "export.blocked", w.id);

  async function* entries(): AsyncGenerator<{ name: string; data: ZipSource }> {
    yield { name: "README.txt", data: translate(locale, "export.readme") };
    yield {
      name: "account.json",
      data: JSON.stringify(
        {
          id: user.id,
          name: user.name,
          email: row.email,
          createdAt: new Date(row.created_at).toISOString(),
          consent: row.consent_version ? { version: row.consent_version, at: row.consent_at ? new Date(row.consent_at).toISOString() : null } : null,
          signIn: identitiesOf(user.id).map((i) => ({ provider: i.provider, since: new Date(i.createdAt).toISOString() })),
          workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role, personal: w.personal })),
        },
        null,
        2
      ),
    };
    const log = sql("SELECT at, action, target FROM audit WHERE actor = ? ORDER BY at").all(user.id) as { at: number; action: string; target: string | null }[];
    yield { name: "security-log.json", data: JSON.stringify(log.map((l) => ({ at: new Date(l.at).toISOString(), action: l.action, target: l.target })), null, 2) };

    for (const w of closed) {
      yield { name: `documents/${safe(w.name)}-${w.id.slice(0, 6)}/EXPORT-DISABLED.txt`, data: translate(locale, "export.disabled") };
    }
    for (const w of workspaces.filter((x) => (x.role === "owner" || x.role === "editor") && !closed.includes(x))) {
      const dir = `documents/${safe(w.name)}-${w.id.slice(0, 6)}`;
      const notes: Note[] = [];
      // What the person may read there (not other members' Private or restricted pages).
      const acc = new AccessResolver(w.id, user.id);
      for (const r of sql("SELECT json FROM notes WHERE ws = ? AND deleted = 0").iterate(w.id) as Iterable<{ json: string | null }>) {
        try {
          const n = JSON.parse(r.json ?? "null") as Note | null;
          // Column permissions apply to the export too.
          if (n && acc.level(n.id) !== null) notes.push(readableFor(w.id, user.id, n));
        } catch {
          // skip a broken row
        }
      }
      yield { name: `${dir}/documents.json`, data: JSON.stringify({ format: "zvena-docs/1", workspace: w.name, notes }, null, 1) };
      const byId = new Map(notes.map((n) => [n.id, n]));
      const people = membersOf(w.id).map((m) => ({ id: m.userId, name: m.name }));
      for (const n of notes) {
        if (n.kind !== "page" || n.synced || n.trashedAt !== null) continue;
        let md = "";
        try {
          // People are named, not shown as ids (set right before the synchronous render: requests interleave).
          setPeople(people);
          md = noteToMarkdown(n, (id) => byId.get(id));
        } catch {
          continue;
        }
        yield { name: `${dir}/markdown/${safe(n.title || "untitled")}-${n.id.slice(0, 8)}.md`, data: md };
      }
    }

    for (const w of workspaces.filter((x) => !closed.includes(x))) {
      const p = exportProjects(user.id, w.id);
      if (!p) continue;
      const dir = `projects/${safe(w.name)}-${w.id.slice(0, 6)}`;
      yield { name: `${dir}/projects.json`, data: p.json };
      yield { name: `${dir}/issues.csv`, data: p.csv };
    }

    for (const f of sql("SELECT name FROM files WHERE owner_kind = 'user' AND owner_id = ?").all(user.id) as { name: string }[]) {
      const path = join(notesFilesDir(), f.name);
      try {
        await stat(path);
      } catch {
        continue;
      }
      yield {
        name: `files/${f.name}`,
        data: async function* () {
          for await (const chunk of createReadStream(path)) yield chunk as Uint8Array;
        },
      };
    }

    // Design files can't be told apart by workspace here (Design names its teams only): while any
    // workspace of the person turns export off, none leaves, and the export says why.
    if (closed.length) {
      yield { name: "design/EXPORT-DISABLED.txt", data: locale === "ru" ? "Дизайн-файлы не выгружены: в одном из ваших пространств владелец запретил экспорт." : "Design files are left out: the owner of one of your workspaces has disabled exporting." };
    } else try {
      const { files } = await exportList(user.id);
      for (const f of files) {
        const bytes = await exportFile(user.id, f.id);
        if (bytes) yield { name: `design/${safe(f.team)}/${safe(f.name)}-${f.id.slice(0, 8)}.penpot`, data: new Uint8Array(bytes) };
      }
    } catch {
      yield { name: "design/NOT-INCLUDED.txt", data: translate(locale, "export.designMissing") };
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(zipStream(entries()), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="zvena-export-${stamp}.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
