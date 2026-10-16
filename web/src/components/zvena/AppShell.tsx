"use client";

// zvena's own pages (Home, Inbox, Team, Templates, Settings, Moderation) in
// the one shared frame. The frame itself — the rail every section shares —
// is components/zvena/ds/Shell.tsx; Docs and Projects mount it too, with
// their own block in the rail. With `title`, the page gets Linear's thin
// header (the section's icon and name) instead of a big page title.

import type { ReactNode } from "react";
import { Inbox, LayoutTemplate, ShieldCheck, Users } from "lucide-react";
import type { ProductId } from "@/lib/products";
import type { SessionUser } from "@/lib/session";
import { PageHead, Shell } from "@/components/zvena/ds/Shell";

export type Section = ProductId | "inbox" | "settings" | "admin";

const ICONS: Partial<Record<Section, ReactNode>> = {
  inbox: <Inbox />,
  team: <Users />,
  templates: <LayoutTemplate />,
  admin: <ShieldCheck />,
};

export function AppShell({ user, section, title, aside, children }: { user: SessionUser; section: Section; title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Shell user={user} section={section}>
      {title && (
        <PageHead icon={ICONS[section]} title={title}>
          {aside}
        </PageHead>
      )}
      {children}
    </Shell>
  );
}
