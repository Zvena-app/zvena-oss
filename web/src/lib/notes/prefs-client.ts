// Browser: following a page and the person's Documents settings
// (lib/notes/follows.ts on the server).

export type NotifySetting = "mention" | "reply" | "comment" | "assigned" | "suggestion" | "reminder" | "follow";
export const NOTIFY_SETTINGS: readonly NotifySetting[] = ["mention", "reply", "comment", "assigned", "suggestion", "reminder", "follow"];

export interface DocsPrefs {
  muted: NotifySetting[];
  viewHistory: boolean;
  emailDigest: boolean;
}

const q = (ws: string, id: string) => `ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}`;

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
}

export async function following(ws: string, id: string): Promise<boolean> {
  return (await call<{ following: boolean }>(`/api/notes/follow?${q(ws, id)}`)).following;
}

export async function setFollowing(ws: string, id: string, on: boolean): Promise<boolean> {
  return (await call<{ following: boolean }>(`/api/notes/follow?${q(ws, id)}`, { on })).following;
}

export function fetchDocsPrefs(): Promise<DocsPrefs> {
  return call<DocsPrefs>("/api/notes/prefs");
}

export function saveDocsPrefs(patch: { notify?: Partial<Record<NotifySetting, boolean>>; viewHistory?: boolean; emailDigest?: boolean }): Promise<DocsPrefs> {
  return call<DocsPrefs>("/api/notes/prefs", patch);
}
