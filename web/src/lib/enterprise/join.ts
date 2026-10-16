// Server-only: "Allowed e-mail domains" (Notion): someone who signs in with a
// verified address at a domain a workspace verified and opened sees that
// workspace right after signing in (/join/domain) and may join it with the
// role its owner chose (Settings → Security → joinRole).

import { config } from "../config";
import { audit, sql, tx } from "../store";
import { LimitError, roleIn } from "../workspaces";
import { emailDomain } from "./domains";
import { securityOf } from "./security";
import { ensureTables } from "./tables";

export interface Joinable {
  id: string;
  name: string;
  members: number;
  domain: string;
}

function accountEmail(userId: string): string | null {
  return (sql("SELECT email FROM users WHERE id = ? AND blocked_at IS NULL").get(userId) as { email: string | null } | undefined)?.email ?? null;
}

/** Workspaces the person may join by their address (not those they are in). */
export function joinableWorkspaces(userId: string): Joinable[] {
  const domain = emailDomain(accountEmail(userId));
  if (!domain) return [];
  ensureTables();
  const rows = sql(
    `SELECT w.id, w.name, d.domain, (SELECT COUNT(*) FROM members x WHERE x.ws_id = w.id) AS n
     FROM ent_domains d JOIN workspaces w ON w.id = d.ws
     WHERE d.domain = ? AND d.verified_at IS NOT NULL AND d.allow_join = 1 AND w.personal = 0
       AND NOT EXISTS (SELECT 1 FROM members m WHERE m.ws_id = w.id AND m.user_id = ?)`
  ).all(domain, userId) as { id: string; name: string; domain: string; n: number }[];
  return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain, members: Number(r.n) }));
}

/** Joins `ws` by the person's address; null when it is not open to them. */
export function joinByDomain(userId: string, ws: string): { wsId: string; role: string } | null {
  return tx(() => {
    if (!joinableWorkspaces(userId).some((j) => j.id === ws)) {
      const cur = roleIn(userId, ws);
      return cur ? { wsId: ws, role: cur } : null;
    }
    if (config.maxMembers > 0) {
      const n = sql("SELECT COUNT(*) AS n FROM members WHERE ws_id = ?").get(ws) as { n: number };
      if (Number(n.n) >= config.maxMembers) throw new LimitError("members");
    }
    const role = securityOf(ws).joinRole;
    sql("INSERT INTO members (ws_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(ws, userId, role, Date.now());
    audit(userId, "member.join.domain", ws, { role });
    return { wsId: ws, role };
  });
}

/** After a sign-in: the page that offers the workspaces of the person's domain, when there are any. */
export function domainJoinUrl(userId: string, target: URL): URL | null {
  try {
    if (joinableWorkspaces(userId).length === 0) return null;
  } catch {
    return null;
  }
  const u = new URL("/join/domain", config.appUrl);
  u.searchParams.set("next", `${target.pathname}${target.search}${target.hash}`);
  return u;
}
