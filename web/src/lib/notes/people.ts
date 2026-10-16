// zvena Documents: the people pages can name — the members of the open
// workspace (Person properties, @mentions, "Created by", comments). The app
// loads them once per workspace (NotesApp) and keeps them here, so the
// compute engine, cells and the editor read one list.

export interface NotesPerson {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
}

type Listener = () => void;

interface Directory {
  list: NotesPerson[];
  byId: Map<string, NotesPerson>;
  listeners: Set<Listener>;
  /** The signed-in person (filters' "Me"). */
  me?: string;
}

const KEY = Symbol.for("zvena.notes.people");
const g = globalThis as unknown as Record<symbol, Directory | undefined>;
const dir: Directory = (g[KEY] ??= { list: [], byId: new Map(), listeners: new Set() });

export function setPeople(list: readonly NotesPerson[]): void {
  dir.list = [...list];
  dir.byId = new Map(list.map((p) => [p.id, p]));
  dir.listeners.forEach((fn) => fn());
}

/** A filter value meaning "the person looking" (Notion's "Me"). */
export const ME = "@me";

export function setMe(id: string | null | undefined): void {
  dir.me = id ?? undefined;
}

export function meId(): string | undefined {
  return dir.me;
}

/** A person filter value as a user id ("@me" → the person looking). */
export function resolvePerson(v: string): string {
  return v === ME ? (dir.me ?? "") : v;
}

export function people(): readonly NotesPerson[] {
  return dir.list;
}

export function personById(id: string): NotesPerson | undefined {
  return dir.byId.get(id);
}

// Integrations ("integration:<id>") are named like people in "Created by" /
// "Last edited by", but never offered as people to pick.
const BOTS_KEY = Symbol.for("zvena.notes.bots");
const gb = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
const bots: Map<string, string> = (gb[BOTS_KEY] ??= new Map());

export function setBots(list: readonly { id: string; name: string }[]): void {
  bots.clear();
  for (const b of list) bots.set(b.id.startsWith("integration:") ? b.id : `integration:${b.id}`, b.name);
  dir.listeners.forEach((fn) => fn());
}

/** A person's name; who wrote through a form, an automation or an integration reads as such. */
export function personName(id: string | undefined | null, labels: { unknown: string; form?: string; automation?: string } = { unknown: "" }): string {
  if (!id) return "";
  if (id === "form") return labels.form ?? labels.unknown;
  if (id.startsWith("automation:")) return labels.automation ?? labels.unknown;
  if (id.startsWith("integration:")) return bots.get(id) ?? labels.unknown;
  return dir.byId.get(id)?.name ?? labels.unknown;
}

export function subscribePeople(fn: Listener): () => void {
  dir.listeners.add(fn);
  return () => dir.listeners.delete(fn);
}

// Mentions inside comment text are tokens "<@userId>" (comments are plain text).
const TOKEN_RE = /<@([A-Za-z0-9_-]{6,64})>/g;

/** The user ids a comment mentions, once each. */
export function commentMentions(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]))];
}

/** A comment's text in parts: plain strings and mentions (rendering never shows an id). */
export function commentParts(text: string): ({ text: string } | { userId: string })[] {
  const out: ({ text: string } | { userId: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ userId: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** A comment as plain text, mentions as "@Name" (excerpts, exports). */
export function commentPlain(text: string, nameOf: (id: string) => string): string {
  return text.replace(TOKEN_RE, (_, id: string) => `@${nameOf(id) || "?"}`);
}

/** Initials for an avatar circle ("Анна Петрова" → "АП"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Browser: loads the members of a workspace into the directory (keeps the last list when offline). */
export async function loadPeople(ws: string | null): Promise<void> {
  if (!ws) return setPeople([]);
  try {
    const r = await fetch(`/api/ws/members?ws=${encodeURIComponent(ws)}`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as { members?: { userId: string; name: string; role?: string; avatar?: string }[] };
    setPeople((j.members ?? []).map((m) => ({ id: m.userId, name: m.name, ...(m.role ? { role: m.role } : {}), ...(m.avatar ? { avatar: m.avatar } : {}) })));
    void loadBots(ws);
  } catch {
    // Offline: the names already loaded stay.
  }
}

/** Browser: names of the workspace's integrations (what they edited reads "Last edited by <integration>"). */
async function loadBots(ws: string): Promise<void> {
  try {
    const r = await fetch(`/api/notes/integrations?ws=${encodeURIComponent(ws)}`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as { integrations?: { id: string; name: string }[] };
    setBots(j.integrations ?? []);
  } catch {
    // Offline: the names already loaded stay.
  }
}

/** Browser: tells the server this person's time zone (once per tab). */
export function reportTimeZone(): void {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || sessionStorage.getItem("zv-tz") === tz) return;
    void fetch("/api/notes/tz", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz }), credentials: "same-origin" })
      .then((r) => r.ok && sessionStorage.setItem("zv-tz", tz))
      .catch(() => {});
  } catch {
    // No storage or Intl: the server's default zone applies.
  }
}
