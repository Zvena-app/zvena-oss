"use client";

import dynamic from "next/dynamic";
import { createContext, useContext } from "react";
import { NotesShell, type ShellLabels } from "@/components/notes/NotesShell";
import type { NotesUser } from "@/components/notes/context";
import { DocsFrameLoading } from "@/components/notes/docs-frame";

// The workspace loads in the browser only: it lives in IndexedDB and the
// editor needs the DOM. Until it arrives the server-rendered shell shows
// the real layout (sidebar, brand, menu, the user) so nothing jumps.

const Shell = createContext<{ user: NotesUser | null; labels: ShellLabels } | null>(null);

function Loading() {
  const s = useContext(Shell);
  if (!s) return null;
  // Signed in: zvena's shared frame; a guest: Documents' own sidebar.
  return s.user ? <DocsFrameLoading user={s.user} /> : <NotesShell user={s.user} labels={s.labels} />;
}

const NotesApp = dynamic(() => import("@/components/notes/NotesApp"), { ssr: false, loading: () => <Loading /> });

// The editor (the heaviest part) starts downloading alongside the workspace
// instead of after it has run: the page shows as static text first either
// way, and typing becomes possible sooner.
if (typeof window !== "undefined") import("@/components/notes/parts/editor").catch(() => {});

export function NotesRoot({ user, labels }: { user: NotesUser | null; labels: ShellLabels }) {
  return (
    <Shell.Provider value={{ user, labels }}>
      <NotesApp initialUser={user} />
    </Shell.Provider>
  );
}
