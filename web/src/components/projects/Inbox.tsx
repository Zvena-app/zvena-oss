"use client";

// Inbox: notifications about your issues (assignments, mentions, comments,
// status changes, due dates, project updates) next to the issue itself.
// Read / unread, archive, snooze; opening one marks it read.

import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, BellOff, CheckCheck, ChevronLeft, Clock, Inbox as InboxIcon, Mail, MailOpen } from "lucide-react";
import type { Notification } from "@/lib/projects/types";
import { typing } from "./app-state";
import { api, errorText, invalidateAll, loadBoot, toast, useLookups, useQuery } from "./data";
import { HEALTH_COLOR, PriorityIcon, ProjectGlyph, StatusIcon } from "./icons";
import { IssueDetailView } from "./IssueDetail";
import { useT } from "./i18n";
import { Link, setParams, useLoc } from "./router";
import { Tabs } from "./Screens";
import { Avatar, Empty, ErrorState, IconButton, LoadingRows, Menu, overlays, Popover, useFormat, usePopover } from "./ui";

type Item = Notification & { excerpt: string };

export function InboxScreen() {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const loc = useLoc();
  const archived = loc.path[1] === "archived";
  const { data, error, loading, reload } = useQuery<{ items: Item[]; more: boolean }>(`inbox:${archived ? 1 : 0}`, () => api("notifications", { query: { archived: archived ? "1" : undefined } }));
  const [extra, setExtra] = useState<Item[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  // A fresh first page replaces the pages loaded after it.
  const [seen, setSeen] = useState(data);
  if (seen !== data) {
    setSeen(data);
    setExtra([]);
    setMore(null);
  }
  const items = useMemo(() => [...(data?.items ?? []), ...extra], [data, extra]);
  const selId = loc.params.get("n");
  const sel = items.find((n) => n.id === selId) ?? null;
  const snooze = usePopover();

  const act = async (ids: string[] | "all", action: string, until?: number) => {
    try {
      await api("notifications", { method: "POST", body: { ids, action, until } });
      invalidateAll();
      void loadBoot();
    } catch (e) {
      toast(errorText(e, t), "error");
    }
  };
  const open = (n: Item) => {
    setParams({ n: n.id });
    if (!n.readAt) void act([n.id], "read");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || overlays.get().length || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = items.findIndex((n) => n.id === selId);
      if (e.key === "j" || e.key === "ArrowDown") {
        const n = items[Math.min(items.length - 1, i + 1)];
        if (n) {
          e.preventDefault();
          open(n);
        }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        const n = items[Math.max(0, i - 1)];
        if (n) {
          e.preventDefault();
          open(n);
        }
      } else if ((e.key === "Backspace" || e.key === "Delete") && sel) {
        e.preventDefault();
        const next = items[i + 1] ?? items[i - 1];
        void act([sel.id], archived ? "unarchive" : "archive");
        setParams({ n: next?.id ?? null });
      } else if (e.key === "u" && sel) {
        e.preventDefault();
        void act([sel.id], sel.readAt ? "unread" : "read");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    const r = await api<{ items: Item[]; more: boolean }>("notifications", { query: { archived: archived ? "1" : undefined, before: last.updatedAt } });
    setExtra((x) => [...x, ...r.items]);
    setMore(r.more);
  };

  const describe = (n: Item): string => {
    const d = n.data as Record<string, string>;
    const vars = { status: d.status ?? "", due: d.due ? f.day(d.due) : "", project: d.project ?? "", of: d.of ?? "—", p: String(d.confidence ?? ""), milestone: d.milestone ?? "" };
    if (n.kind === "goal_met" && d.milestone) return t("n.kind.goal_met_ms", vars);
    if (n.kind === "triaged") return t(d.result === "declined" ? "n.kind.triaged.declined" : d.result === "duplicate" ? "n.kind.triaged.duplicate" : "n.kind.triaged");
    return t(`n.kind.${n.kind}`, vars);
  };

  return (
    <div className="pj-screen pj-inbox">
      <header className="pj-head">
        <div className="pj-head-title">
          {/* Phones show the list or the picked item, not both: this goes back to the list (responsive/projects.css). */}
          {sel && (
            <IconButton className="pj-inbox-back" label={t("c.backTo")} onClick={() => setParams({ n: null })}>
              <ChevronLeft size={16} />
            </IconButton>
          )}
          <InboxIcon size={16} />
          <h1>{t("n.title")}</h1>
          {L.b.unread > 0 && <span className="pj-head-count">{L.b.unread}</span>}
        </div>
        <Tabs
          items={[
            { to: "/inbox", label: t("n.title"), active: !archived },
            { to: "/inbox/archived", label: t("n.archived"), active: archived },
          ]}
        />
        <div className="pj-head-actions">
          {sel && (
            <div className="pj-inbox-actions">
                <IconButton label={sel.readAt ? t("n.unread") : t("n.read")} kbd="U" onClick={() => void act([sel.id], sel.readAt ? "unread" : "read")}>
                  {sel.readAt ? <Mail size={15} /> : <MailOpen size={15} />}
                </IconButton>
                <IconButton label={archived ? t("n.unarchive") : t("n.archive")} kbd="⌫" onClick={() => void act([sel.id], archived ? "unarchive" : "archive")}>
                  {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                </IconButton>
                {!archived && (
                  <IconButton label={t("n.snooze")} onClick={(e) => snooze.toggle(e.currentTarget)}>
                    <Clock size={15} />
                  </IconButton>
                )}
            </div>
          )}
          {!archived && items.length > 0 && (
            <>
              <button type="button" className="pj-btn pj-btn-sm" onClick={() => void act("all", "read")}>
                <CheckCheck size={14} />
                <span className="pj-hide-sm">{t("n.readAll")}</span>
              </button>
              <button type="button" className="pj-btn pj-btn-sm" onClick={() => void act("all", "archive")}>
                <Archive size={14} />
                <span className="pj-hide-sm">{t("n.archiveAll")}</span>
              </button>
            </>
          )}
        </div>
      </header>
      <div className="pj-inbox-body" data-picked={sel ? "" : undefined}>
        <div className="pj-inbox-list" role={items.length ? "listbox" : undefined} aria-label={items.length ? t("n.title") : undefined}>
          {error ? (
            <ErrorState onRetry={reload} />
          ) : loading || !data ? (
            <LoadingRows />
          ) : items.length === 0 ? (
            <Empty icon={<BellOff size={22} />} title={t("n.empty")} hint={t("n.emptyHint")} />
          ) : (
            <>
              {items.map((n) => {
                const actor = n.actorId ? L.person.get(n.actorId) : null;
                const s = n.issue ? L.status.get(n.issue.statusId) : null;
                const project = n.projectId ? L.project.get(n.projectId) : null;
                return (
                  <button key={n.id} type="button" role="option" aria-selected={n.id === selId} className="pj-notif" data-unread={!n.readAt || undefined} data-on={n.id === selId || undefined} onClick={() => open(n)}>
                    <span className="pj-notif-avatar">{actor ? <Avatar name={actor.name} id={actor.id} size={26} src={actor.avatar} /> : <span className="pj-notif-sys"><Clock size={14} /></span>}</span>
                    <span className="pj-notif-main">
                      <span className="pj-notif-title">
                        {n.issue ? (
                          <>
                            <span className="pj-row-id">{n.issue.identifier}</span> {n.issue.title}
                          </>
                        ) : project ? (
                          project.name
                        ) : (
                          "—"
                        )}
                      </span>
                      <span className="pj-notif-text">
                        {actor && <b>{actor.name} </b>}
                        {describe(n)}
                      </span>
                      {n.excerpt && <span className="pj-notif-excerpt">{n.excerpt}</span>}
                    </span>
                    <span className="pj-notif-side">
                      <time className="pj-tl-time">{f.ago(n.updatedAt)}</time>
                      <span className="pj-notif-icons">
                        {n.issue && <PriorityIcon priority={n.issue.priority} size={13} />}
                        {s && <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} size={13} />}
                        {n.kind === "project_update" && typeof n.data.health === "string" && <span className="pj-dot" style={{ background: HEALTH_COLOR[n.data.health as keyof typeof HEALTH_COLOR] }} />}
                      </span>
                    </span>
                  </button>
                );
              })}
              {(more ?? data.more) && (
                <button type="button" className="pj-load-more" onClick={() => void loadMore()}>
                  {t("i.loadMore", { n: 50 })}
                </button>
              )}
            </>
          )}
        </div>
        <div className="pj-inbox-detail">
          {sel ? (
            <>
              {sel.issue ? (
                <IssueDetailView issueRef={sel.issue.identifier} mode="peek" onClose={() => setParams({ n: null })} />
              ) : sel.projectId ? (
                <div className="pj-pad">
                  <Link to={`/project/${sel.projectId}`} className="pj-btn">
                    <ProjectGlyph icon={L.project.get(sel.projectId)?.icon ?? null} color={L.project.get(sel.projectId)?.color ?? "#888"} />
                    {L.project.get(sel.projectId)?.name ?? "—"}
                  </Link>
                </div>
              ) : null}
            </>
          ) : (
            <Empty icon={<InboxIcon size={22} />} title={t("n.pick")} />
          )}
        </div>
      </div>
      {snooze.anchor && sel && (
        <Popover anchor={snooze.anchor} onClose={snooze.close} width={200} label={t("n.snooze")}>
          <Menu
            search={false}
            onClose={snooze.close}
            items={[
              { id: "h", label: t("n.snooze.hour"), onSelect: () => void act([sel.id], "snooze", Date.now() + 3_600_000) },
              {
                id: "t",
                label: t("n.snooze.tomorrow"),
                onSelect: () => {
                  const d = new Date();
                  d.setDate(d.getDate() + 1);
                  d.setHours(9, 0, 0, 0);
                  void act([sel.id], "snooze", d.getTime());
                },
              },
              { id: "w", label: t("n.snooze.week"), onSelect: () => void act([sel.id], "snooze", Date.now() + 7 * 86_400_000) },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}
