"use client";

import dynamic from "next/dynamic";
import { createContext, useContext, type ReactNode } from "react";
import type { NoteShareSnapshot } from "@/lib/notes/server-store";

// The server-rendered page (PublicStatic) stays on screen until the
// interactive view has loaded, then that view takes its place.
const Fallback = createContext<ReactNode>(null);

function Loading() {
  return <>{useContext(Fallback)}</>;
}

const PublicNote = dynamic(() => import("@/components/notes/PublicNote"), { ssr: false, loading: () => <Loading /> });

export function PublicNoteRoot({ children, ...props }: { snapshot: NoteShareSnapshot; updatedAt: number; shareId: string; app?: string; children?: ReactNode }) {
  return (
    <Fallback.Provider value={children}>
      <PublicNote {...props} />
    </Fallback.Provider>
  );
}
