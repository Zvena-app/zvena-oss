"use client";

// Documents inside zvena's shared frame (components/zvena/ds/Shell.tsx): the
// signed-in person's frame user, and the frame shown while the workspace
// loads, so the first paint already has the rail and nothing jumps.

import { Shell, type ShellUser } from "@/components/zvena/ds";
import type { NotesUser } from "./context";

export function toShellUser(user: NotesUser): ShellUser {
  return { id: user.id, name: user.name, isAdmin: user.isAdmin, ws: { id: user.ws.id, name: user.ws.name, role: user.ws.role }, workspaces: user.workspaces.map((w) => ({ id: w.id, name: w.name })) };
}

/** The frame with Documents' block as quiet placeholder rows. */
export function DocsFrameLoading({ user }: { user: NotesUser }) {
  return (
    <Shell
      user={toShellUser(user)}
      section="docs"
      fill
      palette={false}
      sectionNav={
        <div className="nt-rail nt-rail-loading" aria-hidden="true">
          {[72, 54, 64, 46].map((w, i) => (
            <span key={i} className="nt-rail-skel" style={{ width: `${w}%` }} />
          ))}
        </div>
      }
    >
      <div className="nt-root nt-in-shell" />
    </Shell>
  );
}
