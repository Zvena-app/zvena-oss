"use client";

// Mail's block in zvena's rail (design system: Shell): the built-in views
// with their counts, the person's own views, labels (zvena's, and each
// mailbox's folders or Gmail labels), the mailboxes, and Settings.

import { useState, type ReactNode } from "react";
import { AlertCircle, Archive, Clock, FilePen, Inbox, Layers, MailOpen, Plus, Send, Settings, ShieldAlert, SquarePen, Star, Tag, Trash2 } from "lucide-react";
import { ShellNavItem, ShellNavList } from "@/components/zvena/ds";
import type { MailLabel } from "@/lib/mail-client/types";
import type { SystemView } from "@/lib/mail-client/views";
import { getState, go, useMail, type Route } from "./data";
import { useMt } from "./i18n";
import { composeNew } from "./MailApp";
import { ViewDialog } from "./Dialogs";
import { Dot } from "./ui";

export const SYSTEM_ICON: Record<SystemView, ReactNode> = {
  inbox: <Inbox />,
  unread: <MailOpen />,
  starred: <Star />,
  snoozed: <Clock />,
  sent: <Send />,
  drafts: <FilePen />,
  archive: <Archive />,
  spam: <ShieldAlert />,
  trash: <Trash2 />,
};

export function ComposeButton() {
  const { t } = useMt();
  return (
    <button type="button" className="zm-rail-compose" onClick={composeNew} aria-label={t("compose.new")} title={`${t("compose.new")} · C`}>
      <SquarePen size={14} />
    </button>
  );
}

function href(r: Route): string {
  const s = getState();
  const q = new URLSearchParams({ ws: s.ws });
  if (r.settings) return `/mail/settings?${q}`;
  if (r.list.label) return `/mail/label/${encodeURIComponent(r.list.label)}?${q}`;
  if (r.list.view && r.list.view !== "inbox") return `/mail/view/${encodeURIComponent(r.list.view)}?${q}`;
  return `/mail?${q}`;
}

/** Labels by mailbox: zvena's own first, then each mailbox's (folders or Gmail labels). */
export function groupLabels(labels: MailLabel[]): { accountId: string | null; labels: MailLabel[] }[] {
  const groups = new Map<string | null, MailLabel[]>();
  for (const l of labels) {
    const list = groups.get(l.accountId) ?? [];
    list.push(l);
    groups.set(l.accountId, list);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0)).map(([accountId, labels]) => ({ accountId, labels }));
}

export function MailNav() {
  const { t } = useMt();
  const boot = useMail((s) => s.boot);
  const route = useMail((s) => s.route);
  const [newView, setNewView] = useState(false);
  if (!boot) return null;
  const nav = (r: Route) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    go(r);
    // The rail is a drawer on a phone: it closes once a place is picked.
    document.querySelector<HTMLElement>(".zv-scrim")?.click();
  };
  const at = (v: string) => !route.settings && !route.list.label && !route.list.q && (route.list.view ?? "inbox") === v;
  const sys = boot.views.filter((v) => v.system);
  const own = boot.views.filter((v) => !v.system);
  const accounts = boot.accounts;
  const many = accounts.length > 1;
  const broken = accounts.filter((a) => a.state === "auth" || a.state === "error");
  return (
    <>
      <ShellNavList label={t("app.name")}>
        {sys
          .filter((v) => v.id !== "spam" && v.id !== "unread")
          .map((v) => (
            <ShellNavItem
              key={v.id}
              href={href({ list: { view: v.id } })}
              label={t(`view.${v.id as SystemView}`)}
              icon={SYSTEM_ICON[v.id as SystemView]}
              active={at(v.id)}
              badge={v.id === "inbox" ? boot.counts.inbox : v.id === "drafts" ? boot.counts.drafts + boot.outbox.length : undefined}
              onClick={nav({ list: { view: v.id } })}
            />
          ))}
        <ShellNavItem href={href({ list: { view: "spam" } })} label={t("view.spam")} icon={SYSTEM_ICON.spam} active={at("spam")} badge={boot.counts.spam || undefined} onClick={nav({ list: { view: "spam" } })} />
      </ShellNavList>
      <div className="ds-nav-title zm-nav-title">
        <span>{t("nav.views")}</span>
        <button type="button" className="zm-rail-add" onClick={() => setNewView(true)} aria-label={t("view.new")} title={t("view.new")}>
          <Plus size={14} />
        </button>
      </div>
      <ShellNavList label={t("nav.views")}>
        {own.map((v) => (
          <ShellNavItem key={v.id} href={href({ list: { view: v.id } })} label={v.name} icon={v.icon ? <span className="zm-emoji">{v.icon}</span> : <Layers />} active={at(v.id)} onClick={nav({ list: { view: v.id } })} />
        ))}
        {!own.length && (
          <button type="button" className="zm-rail-hint" onClick={() => setNewView(true)}>
            <Plus size={14} />
            {t("view.new")}
          </button>
        )}
      </ShellNavList>
      {groupLabels(boot.labels).map((g) => {
        const acct = accounts.find((a) => a.id === g.accountId);
        return (
          <div key={g.accountId ?? "zvena"}>
            <div className="ds-nav-title zm-nav-title">
              <span>{g.accountId === null ? t("nav.labels") : many ? acct?.email : t("nav.folders")}</span>
            </div>
            <ShellNavList label={t("nav.labels")}>
              {g.labels.slice(0, 40).map((l) => (
                <ShellNavItem
                  key={l.id}
                  href={href({ list: { label: l.id } })}
                  label={l.name}
                  icon={l.kind === "manual" ? <Dot color={l.color} /> : <Tag />}
                  active={!route.settings && route.list.label === l.id}
                  onClick={nav({ list: { label: l.id } })}
                />
              ))}
            </ShellNavList>
          </div>
        );
      })}
      <ShellNavList label={t("nav.settings")}>
        {broken.map((a) => (
          <ShellNavItem key={a.id} href={href({ list: route.list, settings: true })} label={t("account.needsAttention", { email: a.email })} icon={<AlertCircle color="var(--ui-danger-text)" />} onClick={nav({ list: route.list, settings: true })} />
        ))}
        <ShellNavItem href={href({ list: route.list, settings: true })} label={t("nav.settings")} icon={<Settings />} active={route.settings} onClick={nav({ list: route.list, settings: true })} />
      </ShellNavList>
      {newView && <ViewDialog onClose={() => setNewView(false)} />}
    </>
  );
}
