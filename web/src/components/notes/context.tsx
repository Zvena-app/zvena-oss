"use client";

// The workspace context: the store snapshot, navigation and app-level UI
// actions every Notes component (and every custom block inside the editor)
// reaches through useNotes().

import { createContext, useContext } from "react";
import type { NotesStore, NotesSnapshot } from "@/lib/notes/store";
import type { NotesT } from "@/lib/notes/i18n";
import type { AccessLevel, DbView, Note } from "@/lib/notes/types";
import type { Anchor } from "./ui";
import type { Locale } from "@/i18n/locales";

/** "guest": not a member of the workspace; sees only pages shared with them. */
export type NotesRole = "owner" | "editor" | "commenter" | "viewer" | "guest";

export interface NotesWorkspace {
  id: string;
  name: string;
  role: NotesRole;
  personal: boolean;
  /** Page export is off in this workspace for this person (Settings → Security). */
  noExport?: true;
}

export interface NotesTeamspace {
  id: string;
  name: string;
  icon: string;
  privacy: "open" | "closed" | "private";
  role: "owner" | "member" | null;
  members: number;
  /** Archived: out of the sidebar (its managers may restore it). */
  archived?: boolean;
}

/** The signed-in person and the workspace whose documents are open. */
export interface NotesUser {
  id: string;
  name: string;
  email?: string;
  picture?: string;
  isAdmin?: boolean;
  ws: NotesWorkspace;
  workspaces: NotesWorkspace[];
}

/** The local store's owner key: one per account and workspace ("" = a guest). */
export function storeKey(user: Pick<NotesUser, "id" | "ws"> | null | undefined): string {
  return user ? `${user.id}:${user.ws.id}` : "";
}

export interface OpenOpts {
  /** Open a database row in the side peek ("center": the center peek) instead of navigating. */
  peek?: boolean | "center";
  /** Replace the history entry. */
  replace?: boolean;
  /** Scroll to this block after opening. */
  block?: string;
}

export interface NotesApi {
  t: NotesT;
  locale: Locale;
  store: NotesStore;
  snap: NotesSnapshot;
  user: NotesUser | null | undefined;
  currentId: string | null;
  open: (id: string, opts?: OpenOpts) => void;
  goHome: () => void;
  /** A new page (top level, or inside a page); opens it unless `stay`. */
  /** At the top level `space` picks the sidebar section: "private" (the default, as in Notion), "ts:<id>", or "" for the workspace's pages. */
  newPage: (parentId?: string | null, opts?: { stay?: boolean; title?: string; icon?: string; inline?: boolean; content?: unknown[]; space?: string }) => Note;
  /** A new database (full page or inline in a page). */
  newDatabase: (parentId: string | null, opts?: { inline?: boolean; view?: DbView["type"]; stay?: boolean; title?: string; space?: string }) => Note;
  /** A new row in a database with preset values; opens it in peek unless `stay`. */
  newRow: (dbId: string, opts?: { props?: Note["props"]; title?: string; stay?: boolean; first?: boolean }) => Note;
  trash: (id: string) => void;
  /** Moves a page under another (or to the top level); keeps the parents' sub-page blocks in step. */
  relocate: (id: string, parentId: string | null, beforeId?: string | null, space?: string) => void;
  duplicate: (id: string) => void;
  copyLink: (id: string) => void;
  openSearch: () => void;
  openTemplates: () => void;
  openImport: () => void;
  /** Settings, at a tab ("keys": the keyboard shortcuts). */
  openSettings: (tab?: "keys") => void;
  openTrash: (anchor: Anchor) => void;
  openMove: (id: string, anchor: Anchor) => void;
  /** Uploads a file placed in a page; resolves to its URL. */
  upload: (file: File) => Promise<string>;
  signIn: () => void;
  /** Viewers, commenters and guests cannot change the workspace's pages or add top-level ones (a share may still let them edit one page: levelOf). */
  readOnly: boolean;
  canComment: boolean;
  /** The person's level on a page (Notion's Full access / Can edit / Can comment / Can view; null: no access). */
  levelOf: (id: string) => AccessLevel | null;
  canEdit: (id: string) => boolean;
  /** Teamspaces of the workspace the person sees (members first). */
  teamspaces: NotesTeamspace[];
  reloadTeamspaces: () => void;
  /** Pulls from the server now (after an access change the levels come back with the notes). */
  syncNow: () => void;
  /** Sends the device's pending changes now (before a server-side operation reads the pages). */
  flush: () => Promise<void>;
  /** Row open in the side peek. */
  peekId: string | null;
  closePeek: () => void;
}

export const NotesContext = createContext<NotesApi | null>(null);

export function useNotes(): NotesApi {
  const ctx = useContext(NotesContext);
  if (!ctx) throw new Error("useNotes outside NotesContext");
  return ctx;
}

/** For components that may render outside the workspace (public pages). */
export function useNotesMaybe(): NotesApi | null {
  return useContext(NotesContext);
}

/** The page an editor shows (blocks such as Breadcrumb need it; peeks differ from the open page). */
export const PageIdContext = createContext<string | null>(null);

/** Read-only rendering (public pages): blocks hide editing affordances. */
export const ReadOnlyContext = createContext<{ readOnly: boolean; notes?: ReadonlyMap<string, Note>; openPublic?: (id: string) => void }>({ readOnly: false });
