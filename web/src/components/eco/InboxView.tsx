"use client";

// The Inbox: what needs this person's attention, from every product, in one
// list — mentioned in a document, assigned an issue, a comment on a design.
// Opening an item marks it read; archiving clears it away.

import { useState } from "react";
import { Archive, ArchiveRestore, CheckCheck, Inbox as InboxIcon } from "lucide-react";
import type { InboxItem } from "@/lib/eco/types";
import { eco, useInbox } from "./client";
import { KindIcon } from "./CardView";
import { useEt, type EcoKey } from "./i18n";
import { useI18n } from "@/lib/i18n-react";
import { intlTag, type Locale } from "@/i18n/locales";
import "./eco.css";

const WHAT: Record<string, EcoKey> = {
  mention: "what_mention",
  mentioned: "what_mention",
  comment: "what_comment",
  reply: "what_reply",
  assigned: "what_assigned",
  unassigned: "what_unassigned",
  status: "what_status",
  priority: "what_priority",
  due_soon: "what_due_soon",
  overdue: "overdue",
  project_update: "what_project_update",
  goal_met: "what_goal_met",
  blocked: "what_blocked",
  unblocked: "what_unblocked",
  subscribed: "what_subscribed",
  reminder: "what_reminder",
  invite: "what_invite",
  automation: "what_automation",
  mail: "what_mail",
  suggestion: "what_suggestion",
  suggestion_accepted: "what_suggestion_accepted",
  suggestion_rejected: "what_suggestion_rejected",
  page_update: "what_page_update",
  proposal: "what_proposal",
};

/** Kinds that read as something a person did ("… assigned you"), not a state ("Overdue"). */
const ACTIONS = new Set(["mention", "mentioned", "comment", "reply", "assigned", "unassigned", "status", "priority", "project_update", "goal_met", "subscribed", "invite", "suggestion", "suggestion_accepted", "suggestion_rejected", "page_update"]);

function when(at: number, locale: Locale): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  const rtf = new Intl.RelativeTimeFormat(intlTag(locale), { numeric: "auto", style: "short" });
  if (s < 60) return rtf.format(0, "minute");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), "day");
  return new Date(at).toLocaleDateString(intlTag(locale), { month: "short", day: "numeric" });
}

function Row({ item, locale, archived, onOpen, onArchive }: { item: InboxItem; locale: Locale; archived: boolean; onOpen: () => void; onArchive: () => void }) {
  const t = useEt();
  const what = WHAT[item.kind] ? t(WHAT[item.kind]) : item.kind;
  const person = item.actor?.name;
  return (
    <a className="eco-inbox-item" href={item.url} data-read={item.read || undefined} onClick={onOpen}>
      <span className="eco-inbox-dot" aria-hidden />
      <span className="eco-inbox-what">
        <span className="eco-inbox-line eco-card">
          {item.card && (
            <span className="eco-kind">
              <KindIcon card={item.card} />
            </span>
          )}
          {item.card?.kind === "issue" && item.card.sub && <span className="eco-ident">{item.card.sub}</span>}
          <span className="eco-title">{item.card?.title ?? what}</span>
        </span>
        <span className="eco-inbox-who">
          {person ? `${person} ${what}` : ACTIONS.has(item.kind) ? `${t("someone")} ${what}` : what}
        </span>
        {item.text && <span className="eco-inbox-text">{item.text}</span>}
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {/* Relative to now (and in the browser's zone): the page's copy may read a minute apart. */}
        <span className="eco-inbox-when" suppressHydrationWarning>
          {when(item.at, locale)}
        </span>
        <button
          type="button"
          className="eco-icon-btn"
          title={archived ? t("inboxRestore") : t("inboxArchive")}
          aria-label={archived ? t("inboxRestore") : t("inboxArchive")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onArchive();
          }}
        >
          {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </button>
      </span>
    </a>
  );
}

export function InboxView({ ws, me, limit, initial }: { ws: string; me: string; limit?: number; initial?: { items: InboxItem[]; unread: number } | null }) {
  const [archived, setArchived] = useState(false);
  const { items, unread, reload, setItems } = useInbox(ws, me, archived, initial);
  const t = useEt();
  const { locale } = useI18n();
  const shown = items && limit ? items.slice(0, limit) : items;
  const mark = (ids: string[] | "all", action: "read" | "archive" | "unarchive") => {
    eco
      .markInbox(ws, ids, action)
      .then(reload)
      .catch(() => undefined);
  };
  return (
    <div className="eco-root eco-inbox-view">
      {!limit && (
        <div className="eco-related-head" style={{ marginBottom: 8 }}>
          <button type="button" className="eco-btn eco-btn-ghost" aria-pressed={!archived} onClick={() => setArchived(false)} style={{ fontWeight: archived ? 400 : 600 }}>
            <InboxIcon size={14} />
            {t("inboxTitle")}
            {unread > 0 && <span className="eco-badge">{unread}</span>}
          </button>
          <button type="button" className="eco-btn eco-btn-ghost" aria-pressed={archived} onClick={() => setArchived(true)} style={{ fontWeight: archived ? 600 : 400 }}>
            <Archive size={14} />
            {t("inboxArchived")}
          </button>
          <span className="eco-spacer" />
          {!archived && unread > 0 && (
            <button type="button" className="eco-btn" onClick={() => mark("all", "read")}>
              <CheckCheck size={14} />
              {t("inboxReadAll")}
            </button>
          )}
        </div>
      )}
      {shown === null ? (
        <div className="eco-related-empty">{t("loading")}</div>
      ) : shown.length === 0 ? (
        <div className="eco-related-empty">{archived ? t("inboxEmptyArchive") : t("inboxEmpty")}</div>
      ) : (
        <div className="eco-inbox">
          {shown.map((it) => (
            <Row
              key={it.id}
              item={it}
              locale={locale}
              archived={archived}
              onOpen={() => {
                if (!it.read) void eco.markInbox(ws, [it.id], "read").catch(() => undefined);
              }}
              onArchive={() => {
                setItems((v) => v.filter((x) => x.id !== it.id));
                mark([it.id], archived ? "unarchive" : "archive");
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
