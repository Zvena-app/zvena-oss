"use client";

// Triage: a team's intake. Issues from people outside the team wait here until
// someone accepts them into the workflow, marks them duplicate, declines them
// or snoozes them. The screen is a two-pane list like the Inbox: J/K move,
// 1 accepts, 2 marks a duplicate, 3 declines, H snoozes.
// The same bar shows on the issue itself wherever it is opened.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, Clock, Copy, Inbox as InboxIcon, X } from "lucide-react";
import type { Issue, IssuePage } from "@/lib/projects/types";
import { typing } from "./app-state";
import { api, errorText, invalidateAll, loadBoot, toast, useLookups, useQuery } from "./data";
import { StatusIcon } from "./icons";
import { IssueDetailView, IssueSearch } from "./IssueDetail";
import { useT } from "./i18n";
import { setParams, useLoc } from "./router";
import { Avatar, Empty, ErrorState, IconButton, Kbd, LoadingRows, Menu, overlays, Popover, useFormat, usePopover } from "./ui";

type Action = "accept" | "duplicate" | "decline" | "snooze";

async function triage(issue: { id: string }, body: { action: Action; statusId?: string; duplicateOf?: string; comment?: string; until?: number }): Promise<boolean> {
  await api(`issues/${issue.id}/triage`, { method: "POST", body });
  invalidateAll();
  void loadBoot();
  return true;
}

/** Accept · Duplicate · Decline · Snooze for an issue in triage. `keys`: 1/2/3/H work while it is shown. */
export function TriageBar({ issue, keys = false, onDone }: { issue: Pick<Issue, "id" | "identifier" | "teamId" | "triageSnoozedUntil">; keys?: boolean; onDone?: () => void }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const accept = usePopover();
  const dup = usePopover();
  const decline = usePopover();
  const snooze = usePopover();
  const [why, setWhy] = useState("");
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const acceptBtn = useRef<HTMLButtonElement>(null);
  const dupBtn = useRef<HTMLButtonElement>(null);
  const declineBtn = useRef<HTMLButtonElement>(null);
  const snoozeBtn = useRef<HTMLButtonElement>(null);
  const statuses = L.b.statuses.filter((s) => s.teamId === issue.teamId && s.category !== "canceled");

  const run = async (body: Parameters<typeof triage>[1], done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await triage(issue, body);
      toast(done, "success");
      onDone?.();
    } catch (e) {
      toast(errorText(e, t), "error");
    } finally {
      setBusy(false);
    }
  };
  // The team decides (or the workspace owner): not the outsiders triage holds back.
  const team = L.team.get(issue.teamId);
  const canTriage = L.canEdit && (L.isOwner || team?.isMember === true);
  const doAccept = (statusId?: string) => void run({ action: "accept", ...(statusId ? { statusId } : {}) }, t("tr.accepted", { id: issue.identifier }));

  useEffect(() => {
    if (!keys || !canTriage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || overlays.get().length || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") {
        e.preventDefault();
        doAccept();
      } else if (e.key === "2" && dupBtn.current) {
        e.preventDefault();
        dup.open(dupBtn.current);
      } else if (e.key === "3" && declineBtn.current) {
        e.preventDefault();
        decline.open(declineBtn.current);
      } else if (e.key === "h" && snoozeBtn.current) {
        e.preventDefault();
        snooze.open(snoozeBtn.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const at = (ms: number) => void run({ action: "snooze", until: ms }, t("tr.snoozed"));
  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const snoozed = issue.triageSnoozedUntil && issue.triageSnoozedUntil > now;

  return (
    <div className="pj-banner pj-triage-bar" role="group" aria-label={t("tr.title")}>
      <InboxIcon size={14} />
      <span className="pj-triage-text">{snoozed ? t("tr.snoozedUntil", { date: f.dateTime(issue.triageSnoozedUntil as number) }) : t("tr.banner")}</span>
      {!canTriage && L.canEdit && <span className="pj-small pj-muted">{t("tr.membersOnly")}</span>}
      {canTriage && (
        <span className="pj-triage-actions">
          <span className="pj-split">
            <button type="button" className="pj-btn pj-btn-primary pj-btn-sm" disabled={busy} onClick={() => doAccept()}>
              <Check size={14} />
              {t("tr.accept")}
              {keys && <Kbd>1</Kbd>}
            </button>
            <button ref={acceptBtn} type="button" className="pj-btn pj-btn-primary pj-btn-sm pj-split-caret" aria-label={t("tr.acceptAs")} disabled={busy} onClick={(e) => accept.toggle(e.currentTarget)}>
              <ChevronDown size={14} />
            </button>
          </span>
          <button ref={dupBtn} type="button" className="pj-btn pj-btn-sm" disabled={busy} onClick={(e) => dup.toggle(e.currentTarget)}>
            <Copy size={14} />
            {t("tr.duplicate")}
            {keys && <Kbd>2</Kbd>}
          </button>
          <button ref={declineBtn} type="button" className="pj-btn pj-btn-sm" disabled={busy} onClick={(e) => decline.toggle(e.currentTarget)}>
            <X size={14} />
            {t("tr.decline")}
            {keys && <Kbd>3</Kbd>}
          </button>
          <button ref={snoozeBtn} type="button" className="pj-btn pj-btn-sm" disabled={busy} onClick={(e) => snooze.toggle(e.currentTarget)}>
            <Clock size={14} />
            {t("tr.snooze")}
            {keys && <Kbd>H</Kbd>}
          </button>
        </span>
      )}
      {accept.anchor && (
        <Popover anchor={accept.anchor} onClose={accept.close} width={240} label={t("tr.acceptAs")}>
          <Menu
            onClose={accept.close}
            placeholder={t("tr.acceptAs")}
            items={statuses.map((s) => ({ id: s.id, label: s.name, icon: <StatusIcon category={s.category} color={s.color} fraction={L.fraction(s.id)} size={14} />, onSelect: () => doAccept(s.id) }))}
          />
        </Popover>
      )}
      {dup.anchor && (
        <Popover anchor={dup.anchor} onClose={dup.close} width={320} label={t("tr.dupPick")}>
          <IssueSearch
            exclude={[issue.id]}
            onClose={dup.close}
            onPick={(o) => {
              dup.close();
              void run({ action: "duplicate", duplicateOf: o.id }, t("tr.markedDup", { id: issue.identifier, of: o.identifier }));
            }}
          />
        </Popover>
      )}
      {decline.anchor && (
        <Popover anchor={decline.anchor} onClose={decline.close} width={320} label={t("tr.decline")}>
          <form
            className="pj-pad pj-triage-decline"
            onSubmit={(e) => {
              e.preventDefault();
              decline.close();
              void run({ action: "decline", ...(why.trim() ? { comment: why.trim() } : {}) }, t("tr.declined", { id: issue.identifier }));
              setWhy("");
            }}
          >
            <textarea className="pj-input" rows={3} autoFocus value={why} maxLength={5000} placeholder={t("tr.declineWhy")} onChange={(e) => setWhy(e.target.value)} />
            <div className="pj-row-end">
              <button type="submit" className="pj-btn pj-btn-danger pj-btn-sm">
                {t("tr.decline")}
              </button>
            </div>
          </form>
        </Popover>
      )}
      {snooze.anchor && (
        <Popover anchor={snooze.anchor} onClose={snooze.close} width={200} label={t("tr.snooze")}>
          <Menu
            search={false}
            onClose={snooze.close}
            items={[
              { id: "h", label: t("n.snooze.hour"), onSelect: () => at(Date.now() + 3_600_000) },
              { id: "t", label: t("n.snooze.tomorrow"), onSelect: () => at(tomorrow()) },
              { id: "w", label: t("n.snooze.week"), onSelect: () => at(Date.now() + 7 * 86_400_000) },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

export function TriageScreen({ teamKey }: { teamKey: string }) {
  const { t } = useT();
  const L = useLookups();
  const f = useFormat();
  const loc = useLoc();
  const team = L.b.teams.find((x) => x.key === teamKey.toUpperCase());
  const snoozedTab = loc.params.get("snoozed") === "1";
  const [now] = useState(() => Date.now());
  const key = team ? `triage:${team.id}:${snoozedTab ? 1 : 0}` : null;
  const { data, error, loading, reload } = useQuery<IssuePage>(key, () =>
    api<IssuePage>("issues", {
      query: {
        filter: JSON.stringify({ team: [team?.id], triage: true, ...(snoozedTab ? { snoozed: true } : {}) }),
        display: JSON.stringify({ layout: "list", group: "none", order: "created", completed: "all", subIssues: true }),
        limit: "200",
      },
    })
  );
  const all = data?.groups[0]?.items ?? [];
  // The waiting tab hides snoozed issues (the server does); the snoozed tab shows only those.
  const items = snoozedTab ? all.filter((i) => i.triageSnoozedUntil && i.triageSnoozedUntil > now) : all;
  const selId = loc.params.get("t");
  const sel = items.find((i) => i.identifier === selId) ?? items[0] ?? null;
  const pick = (i: Issue | undefined) => i && setParams({ t: i.identifier });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || overlays.get().length || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = items.findIndex((x) => x.id === sel?.id);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        pick(items[Math.min(items.length - 1, i + 1)]);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        pick(items[Math.max(0, i - 1)]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!team) return <Empty title={t("i.notFound")} />;
  if (!team.triage) return <Empty title={t("tr.off")} hint={t("st.triageHint")} />;
  const next = () => {
    const i = items.findIndex((x) => x.id === sel?.id);
    const n = items[i + 1] ?? items[i - 1];
    setParams({ t: n && n.id !== sel?.id ? n.identifier : null });
  };

  return (
    <div className="pj-screen pj-inbox pj-triage">
      <header className="pj-head">
        <div className="pj-head-title">
          {/* Phones show the list or the picked issue, not both: this goes back to the list (responsive/projects.css). */}
          {selId && (
            <IconButton className="pj-inbox-back" label={t("c.backTo")} onClick={() => setParams({ t: null })}>
              <ChevronLeft size={16} />
            </IconButton>
          )}
          <InboxIcon size={16} />
          <h1>
            {t("tr.title")} · {team.name}
          </h1>
          {team.triageCount > 0 && <span className="pj-head-count">{team.triageCount}</span>}
        </div>
        <div className="pj-head-actions">
          <button type="button" className="pj-btn pj-btn-sm" aria-pressed={snoozedTab} onClick={() => setParams({ snoozed: snoozedTab ? null : "1", t: null })}>
            <Clock size={14} />
            <span className="pj-hide-sm">{t("tr.snoozedTab")}</span>
          </button>
        </div>
      </header>
      <div className="pj-inbox-body" data-picked={selId && sel ? "" : undefined}>
        <div className="pj-inbox-list" role={items.length ? "listbox" : undefined} aria-label={items.length ? t("tr.title") : undefined}>
          {error ? (
            <ErrorState onRetry={reload} />
          ) : loading || !data ? (
            <LoadingRows />
          ) : items.length === 0 ? (
            <Empty icon={<InboxIcon size={22} />} title={snoozedTab ? t("tr.noneSnoozed") : t("tr.empty")} hint={snoozedTab ? undefined : t("tr.emptyHint")} />
          ) : (
            items.map((i) => {
              const by = i.creatorId ? L.person.get(i.creatorId) : null;
              return (
                <button key={i.id} type="button" role="option" aria-selected={i.id === sel?.id} className="pj-notif" data-on={i.id === sel?.id || undefined} onClick={() => pick(i)}>
                  <span className="pj-notif-avatar">{by ? <Avatar name={by.name} id={by.id} size={26} src={by.avatar} /> : <span className="pj-notif-sys" />}</span>
                  <span className="pj-notif-main">
                    <span className="pj-notif-title">
                      <span className="pj-row-id">{i.identifier}</span> {i.title}
                    </span>
                    <span className="pj-notif-text">{by ? t("tr.from", { name: by.name }) : ""}</span>
                  </span>
                  <span className="pj-notif-side">
                    <time className="pj-tl-time">{f.ago(i.createdAt)}</time>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="pj-inbox-detail">
          {sel ? <IssueDetailView key={sel.id} issueRef={sel.identifier} mode="peek" triage={{ keys: true, onDone: next }} onClose={() => setParams({ t: null })} /> : <Empty icon={<InboxIcon size={22} />} title={t("tr.pick")} />}
        </div>
      </div>
    </div>
  );
}
