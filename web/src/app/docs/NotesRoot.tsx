"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import NotesApp from "@/components/notes/NotesApp";
import { NotesShell, type ShellLabels } from "@/components/notes/NotesShell";
import type { NotesUser } from "@/components/notes/context";
import { DocsFrameLoading } from "@/components/notes/docs-frame";

// The workspace runs in the browser only: it lives in IndexedDB and the
// editor needs the DOM. Until it runs, the server-rendered shell shows the
// real layout (sidebar, brand, menu, the user) so nothing jumps. Its code is
// part of the page (not a chunk fetched once the page's own code has run), so
// the browser downloads it alongside everything else.

const Shell = createContext<{ user: NotesUser | null; labels: ShellLabels } | null>(null);

function Loading() {
  const s = useContext(Shell);
  if (!s) return null;
  // Signed in: zvena's shared frame; a guest: Documents' own sidebar.
  return s.user ? <DocsFrameLoading user={s.user} /> : <NotesShell user={s.user} labels={s.labels} />;
}

const noSubscribe = () => () => {};
/** False on the server and while hydrating, then true: the app mounts in the browser only. */
const useInBrowser = () => useSyncExternalStore(noSubscribe, () => true, () => false);

// The editor (the heaviest part) starts downloading alongside the workspace
// instead of after it has run: the page shows as static text first either
// way, and typing becomes possible sooner.
if (typeof window !== "undefined") import("@/components/notes/parts/editor").catch(() => {});

export function NotesRoot({ user, labels }: { user: NotesUser | null; labels: ShellLabels }) {
  const inBrowser = useInBrowser();
  return (
    <Shell.Provider value={{ user, labels }}>
      {inBrowser ? <NotesApp initialUser={user} /> : <Loading />}
    </Shell.Provider>
  );
}
