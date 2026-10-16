"use client";

// The list: views as tabs (Notion Mail), the search box, then one row per
// conversation — who, subject and the start of the newest message, labels,
// when — with its quick actions on hover. Drafts show zvena's own drafts and
// what waits in the outbox (scheduled, failed) first.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Archive, ArchiveRestore, Clock, Inbox as InboxIcon, Mail, MailOpen, Paperclip, Plus, RefreshCw, Search, Star, Tag, Trash2, Undo2, X, FolderInput } from "lucide-react";
import { Kbd, SelectionAction, SelectionBar } from "@/components/zvena/ds";
import type { Draft, OutboxItem, ThreadSummary } from "@/lib/mail-client/types";
import { isSystemView, type SystemView } from "@/lib/mail-client/views";
import { act, api, go, listKey, loadBoot, loadList, openComposer, refreshAll, setState, urlOf, useMail, type ActionName } from "./data";
import { listDate } from "./format";
import { useMt } from "./i18n";
import { ViewDialog } from "./Dialogs";
import { Dot, IconBtn, type Anchor } from "./ui";
import { toast } from "@/components/zvena/ds";

type PickerFn = (kind: "snooze" | "label" | "move", threads: string[], anchor: Anchor) => void;

export function MailList({ onPicker }: { onPicker: PickerFn }) {
  const { t, locale } = useMt();
  const boot = useMail((s) => s.boot);
  const route = useMail((s) => s.route);
  const ws = useMail((s) => s.ws);
  const key = listKey(route.list);
  const list = useMail((s) => s.lists[key]);
  const selected = useMail((s) => s.selected);
  const focused = useMail((s) => s.focused);
  const sentinel = useRef<HTMLDivElement>(null);
  const [editView, setEditView] = useState<string | null>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting) && list?.more && !list.loading) void loadList(route.list, { more: true });
    });
    io.observe(el);
    return () => io.disconnect();
  }, [list?.more, list?.loading, route.list]);

  const labels = useMemo(() => new Map((boot?.labels ?? []).map((l) => [l.id, l])), [boot?.labels]);
  if (!boot) return null;
  const view = route.list.view && !route.list.q && !route.list.label ? boot.views.find((v) => v.id === route.list.view) : undefined;
  const viewId = view?.id ?? "";
  const threads = list?.threads ?? [];
  const tabs = boot.prefs.tabs.map((id) => boot.views.find((v) => v.id === id)).filter((v): v is NonNullable<typeof v> => Boolean(v));
  const tabName = (id: string) => {
    const v = boot.views.find((x) => x.id === id);
    return v ? (v.system ? t(`view.${v.id as SystemView}`) : v.name) : id;
  };
  const current = route.list.q !== undefined ? t("search.results", { q: route.list.q }) : route.list.label ? (labels.get(route.list.label)?.name ?? "") : tabName(route.list.view ?? "inbox");
  const inTabs = Boolean(view && tabs.some((x) => x.id === view.id));
  const allSelected = threads.length > 0 && threads.every((x) => selected.includes(x.id));
  const toggle = (id: string) => setState((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] }));
  const inTrash = viewId === "trash" || viewId === "spam";

  const bulk = (a: ActionName) => () => void act(a, selected);
  return (
    <section className="zm-list" aria-label={current}>
      <header className="zm-list-head">
        <nav className="zm-tabs" aria-label={t("nav.views")}>
          {tabs.map((v) => (
            <a
              key={v.id}
              href={urlOf({ list: { view: v.id } }, ws)}
              className="zm-tab"
              aria-current={viewId === v.id && !route.list.q && !route.list.label ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go({ list: { view: v.id } });
              }}
              onDoubleClick={() => !v.system && setEditView(v.id)}
            >
              {v.system ? tabName(v.id) : v.name}
              {v.id === "inbox" && boot.counts.inbox > 0 && <span className="zm-tab-count">{boot.counts.inbox}</span>}
            </a>
          ))}
          {!inTabs && (
            <span className="zm-tab" aria-current="page">
              {current}
              {route.list.q !== undefined && (
                <button type="button" className="zm-tab-x" aria-label={t("search.clear")} onClick={() => go({ list: { view: "inbox" } })}>
                  <X size={12} />
                </button>
              )}
            </span>
          )}
          <button type="button" className="zm-tab zm-tab-add" onClick={() => setEditView("new")} aria-label={t("view.new")} title={t("view.new")}>
            <Plus size={14} />
          </button>
        </nav>
        <div className="zm-list-tools">
          <SearchBox initial={route.list.q ?? ""} />
          <IconBtn icon={<RefreshCw size={16} />} label={t("refresh")} keys="⇧R" onClick={() => refreshAll()} />
        </div>
      </header>
      {view && !view.system && (
        <div className="zm-view-bar">
          <span>{view.name}</span>
          <button type="button" className="zv-btn zv-btn-ghost zv-btn-sm" onClick={() => setEditView(view.id)}>
            {t("view.edit")}
          </button>
        </div>
      )}
      <div className="zm-rows" role="list" aria-busy={list?.loading || undefined}>
        {viewId === "drafts" && <LocalDrafts drafts={boot.drafts} outbox={boot.outbox} />}
        {threads.map((th) => (
          <Row
            key={th.id}
            th={th}
            selected={selected.includes(th.id)}
            focused={focused === th.id}
            open={route.thread === th.id}
            selecting={selected.length > 0}
            labels={labels}
            locale={locale}
            view={viewId}
            onToggle={() => toggle(th.id)}
            onPicker={onPicker}
          />
        ))}
        {!threads.length && !list?.loading && !(viewId === "drafts" && (boot.drafts.length || boot.outbox.length)) && <EmptyList view={viewId} search={route.list.q !== undefined} error={list?.error} />}
        {list?.loading && !threads.length && <div className="zm-rows-loading" />}
        <div ref={sentinel} className="zm-sentinel" />
      </div>
      <SelectionBar count={selected.length} onClear={() => setState({ selected: [] })}>
        <SelectionAction icon={<input type="checkbox" checked={allSelected} readOnly aria-label={t("select.all")} />} onClick={() => setState({ selected: allSelected ? [] : threads.map((x) => x.id) })}>
          {t("select.all")}
        </SelectionAction>
        {inTrash ? (
          <>
            <SelectionAction icon={<ArchiveRestore size={14} />} onClick={bulk(viewId === "trash" ? "restore" : "notspam")}>
              {viewId === "trash" ? t("act.restore") : t("act.notSpam")}
            </SelectionAction>
            <SelectionAction icon={<Trash2 size={14} />} tone="danger" onClick={bulk("delete")}>
              {t("act.deleteForever")}
            </SelectionAction>
          </>
        ) : (
          <>
            <SelectionAction icon={<Archive size={14} />} keys={["E"]} onClick={bulk(viewId === "archive" ? "inbox" : "archive")}>
              {viewId === "archive" ? t("act.toInbox") : t("act.archive")}
            </SelectionAction>
            <SelectionAction icon={<Trash2 size={14} />} keys={["#"]} onClick={bulk("trash")}>
              {t("act.trash")}
            </SelectionAction>
          </>
        )}
        <SelectionAction icon={<MailOpen size={14} />} onClick={bulk("read")}>
          {t("act.markRead")}
        </SelectionAction>
        <SelectionAction icon={<Mail size={14} />} onClick={bulk("unread")}>
          {t("act.markUnread")}
        </SelectionAction>
        <SelectionAction icon={<Star size={14} />} keys={["S"]} onClick={bulk("star")}>
          {t("act.star")}
        </SelectionAction>
        <SelectionAction icon={<Clock size={14} />} keys={["H"]} onClick={(e) => onPicker("snooze", selected, e.currentTarget)}>
          {t("act.snooze")}
        </SelectionAction>
        <SelectionAction icon={<Tag size={14} />} keys={["L"]} onClick={(e) => onPicker("label", selected, e.currentTarget)}>
          {t("act.label")}
        </SelectionAction>
        <SelectionAction icon={<FolderInput size={14} />} keys={["V"]} onClick={(e) => onPicker("move", selected, e.currentTarget)}>
          {t("act.move")}
        </SelectionAction>
      </SelectionBar>
      {editView && <ViewDialog id={editView === "new" ? undefined : editView} onClose={() => setEditView(null)} />}
    </section>
  );
}

function SearchBox({ initial }: { initial: string }) {
  const { t } = useMt();
  const [q, setQ] = useState(initial);
  const [prev, setPrev] = useState(initial);
  if (prev !== initial) {
    setPrev(initial);
    setQ(initial);
  }
  return (
    <form
      className="zm-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const v = q.trim();
        go(v ? { list: { q: v } } : { list: { view: "inbox" } });
        (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      <Search size={14} aria-hidden />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("search.placeholder")}
        aria-label={t("search.label")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQ("");
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <Kbd keys={["/"]} />
    </form>
  );
}

function Row({
  th,
  selected,
  focused,
  open,
  selecting,
  labels,
  locale,
  view,
  onToggle,
  onPicker,
}: {
  th: ThreadSummary;
  selected: boolean;
  focused: boolean;
  open: boolean;
  selecting: boolean;
  labels: Map<string, { id: string; name: string; color: string; kind: string }>;
  locale: string;
  view: string;
  onToggle: () => void;
  onPicker: PickerFn;
}) {
  const { t } = useMt();
  const route = useMail((s) => s.route);
  const ws = useMail((s) => s.ws);
  const who = th.people.map((p) => (p.me ? t("me") : p.name || p.address.split("@")[0]));
  const shownWho = who.length > 3 ? [who[0], "…", ...who.slice(-2)] : who;
  const click = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || selecting) {
      e.preventDefault();
      onToggle();
      return;
    }
    e.preventDefault();
    go({ list: route.list, thread: th.id });
  };
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  const own = th.labels.map((id) => labels.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l) && !(l?.kind === "folder" && route.list.label === l?.id));
  return (
    <a
      href={urlOf({ list: route.list, thread: th.id }, ws)}
      className="zm-row"
      role="listitem"
      data-thread-row={th.id}
      data-unread={th.unread || undefined}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      data-open={open || undefined}
      onClick={click}
      onMouseEnter={() => setState({ focused: th.id })}
    >
      <span className="zm-row-check" onClick={stop(onToggle)}>
        <input type="checkbox" checked={selected} readOnly tabIndex={-1} aria-label={t("select.one")} />
      </span>
      <button type="button" className="zm-row-star" data-on={th.starred || undefined} aria-label={th.starred ? t("act.unstar") : t("act.star")} onClick={stop(() => void act(th.starred ? "unstar" : "star", [th.id], {}, { quiet: true }))}>
        <Star size={14} />
      </button>
      <span className="zm-row-who">
        {view === "sent" ? `${t("to")}: ` : ""}
        {th.draft && !th.unread ? <span className="zm-draft-mark">{t("draft")}</span> : null}
        {shownWho.join(", ")}
        {th.count > 1 && <span className="zm-row-count">{th.count}</span>}
      </span>
      <span className="zm-row-text">
        {own.slice(0, 3).map((l) => (
          <span key={l.id} className="zm-chip">
            {l.kind === "manual" && <Dot color={l.color} />}
            {l.name}
          </span>
        ))}
        <span className="zm-row-subject">{th.subject || t("noSubject")}</span>
        {th.snippet && <span className="zm-row-snippet"> — {th.snippet}</span>}
      </span>
      {th.attachment && <Paperclip size={14} className="zm-row-clip" aria-label={t("attachment")} />}
      <span className="zm-row-date">{th.snoozedUntil ? <span className="zm-snoozed"><Clock size={12} /> {listDate(th.snoozedUntil, locale)}</span> : listDate(th.at, locale)}</span>
      <span className="zm-row-actions">
        {view === "trash" || view === "spam" ? (
          <IconBtn icon={<Undo2 size={15} />} label={view === "trash" ? t("act.restore") : t("act.notSpam")} onClick={() => void act(view === "trash" ? "restore" : "notspam", [th.id])} />
        ) : th.inbox ? (
          <IconBtn icon={<Archive size={15} />} label={t("act.archive")} keys="E" onClick={() => void act("archive", [th.id])} />
        ) : (
          <IconBtn icon={<InboxIcon size={15} />} label={t("act.toInbox")} onClick={() => void act("inbox", [th.id])} />
        )}
        {view !== "trash" && <IconBtn icon={<Trash2 size={15} />} label={t("act.trash")} keys="#" onClick={() => void act("trash", [th.id])} />}
        <IconBtn icon={th.unread ? <MailOpen size={15} /> : <Mail size={15} />} label={th.unread ? t("act.markRead") : t("act.markUnread")} keys="U" onClick={() => void act(th.unread ? "read" : "unread", [th.id], {}, { quiet: true })} />
        <IconBtn icon={<Clock size={15} />} label={t("act.snooze")} keys="H" onClick={(e) => onPicker("snooze", [th.id], e.currentTarget)} />
      </span>
    </a>
  );
}

function LocalDrafts({ drafts, outbox }: { drafts: Draft[]; outbox: OutboxItem[] }) {
  const { t, locale } = useMt();
  const cancel = async (o: OutboxItem) => {
    try {
      const r = await api<{ draft: Draft }>(`outbox/${o.id}`, { method: "DELETE" });
      openComposer({ draft: r.draft, inline: false });
      void loadBoot();
    } catch {
      toast(t("err.alreadySent"), { kind: "error" });
    }
  };
  const retry = async (o: OutboxItem) => {
    await api(`outbox/${o.id}/retry`, { method: "POST", json: {} }).catch(() => undefined);
    void loadBoot();
  };
  return (
    <>
      {outbox.map((o) => (
        <div key={o.id} className="zm-row zm-row-static" data-failed={o.state === "failed" || undefined}>
          <span className="zm-row-who">{o.state === "failed" ? <span className="zm-failed">{t("outbox.failed")}</span> : <span className="zm-draft-mark">{t("outbox.scheduled", { when: listDate(o.sendAt, locale) })}</span>}</span>
          <span className="zm-row-text">
            <span className="zm-row-subject">{o.subject || t("noSubject")}</span>
            <span className="zm-row-snippet"> — {o.to.join(", ")}</span>
          </span>
          <span className="zm-row-tools">
            {o.state === "failed" && (
              <button type="button" className="zv-btn zv-btn-sm" onClick={() => void retry(o)}>
                {t("outbox.retry")}
              </button>
            )}
            <button type="button" className="zv-btn zv-btn-ghost zv-btn-sm" onClick={() => void cancel(o)}>
              {t("outbox.edit")}
            </button>
          </span>
        </div>
      ))}
      {drafts.map((d) => (
        <button key={d.id} type="button" className="zm-row zm-row-static" onClick={() => openComposer({ draft: d, inline: false })}>
          <span className="zm-row-who">
            <span className="zm-draft-mark">{t("draft")}</span>
            {[...d.to, ...d.cc].map((a) => a.name || a.address).join(", ") || t("compose.noRecipients")}
          </span>
          <span className="zm-row-text">
            <span className="zm-row-subject">{d.subject || t("noSubject")}</span>
          </span>
          <span className="zm-row-date">{listDate(d.updatedAt, locale)}</span>
        </button>
      ))}
    </>
  );
}

function EmptyList({ view, search, error }: { view: string; search: boolean; error?: number }) {
  const { t } = useMt();
  if (error !== undefined) {
    return (
      <div className="zm-empty">
        <p>{t("err.load")}</p>
        <button type="button" className="zv-btn" onClick={() => refreshAll()}>
          {t("retry")}
        </button>
      </div>
    );
  }
  const text = search ? t("empty.search") : view === "inbox" ? t("empty.inbox") : isSystemView(view) ? t("empty.view") : t("empty.custom");
  return (
    <div className="zm-empty">
      {view === "inbox" && !search && <div className="zm-empty-art" aria-hidden>✓</div>}
      <p>{text}</p>
    </div>
  );
}
