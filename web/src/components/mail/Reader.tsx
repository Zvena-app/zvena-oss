"use client";

// The reading pane: a conversation, its messages folded the way Notion Mail
// folds them (read ones closed, the newest and the unread open), each body in
// a sandboxed frame of its own (scripts can never run; remote images wait
// for "Show images" and then come through zvena's proxy), attachments, the
// actions, and the reply docked at the bottom. What the conversation is
// linked with across zvena (a page it was saved to, an issue made of it)
// shows under it.

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Archive, ArchiveRestore, ChevronDown, ChevronUp, Clock, Download, FileText, Forward, Inbox as InboxIcon, ListTodo, Mail, MoreHorizontal, Paperclip, Reply, ReplyAll, ShieldAlert, Star, Tag, Trash2, X, FolderInput, Pencil } from "lucide-react";
import { Related } from "@/components/eco/Related";
import { Kbd, toast } from "@/components/zvena/ds";
import type { MailMessage, MailThread } from "@/lib/mail-client/types";
import { act, api, getState, go, loadThread, openComposer, setState, useMail, type ComposerState } from "./data";
import { addrText, fullDate, listDate, sizeText } from "./format";
import { useMt } from "./i18n";
import { replyTo } from "./MailApp";
import { InlineComposer } from "./Compose";
import { DocsDialog, IssueDialog } from "./Dialogs";
import { Avatar, Dot, IconBtn, Menu, Popover, type Anchor } from "./ui";

/** The bar hides its secondary actions where it is too narrow for them (responsive/mail.css: .zm-bar-extra). */
function extrasHidden(from: HTMLElement): boolean {
  const el = from.closest(".zm-reader-bar")?.querySelector(".zm-bar-extra");
  return Boolean(el) && getComputedStyle(el as Element).display === "none";
}

type PickerFn = (kind: "snooze" | "label" | "move", threads: string[], anchor: Anchor) => void;

export function Reader({ onPicker }: { onPicker: PickerFn }) {
  const { t } = useMt();
  const route = useMail((s) => s.route);
  const id = route.thread;
  const thread = useMail((s) => (id ? s.threads[id] : undefined));
  const inline = useMail((s) => s.composers.find((c) => c.inline && c.draft.threadId === id));
  const readSent = useRef<string | null>(null);

  // Opening a conversation reads it (once per opening).
  useEffect(() => {
    if (!thread || readSent.current === thread.id) return;
    readSent.current = thread.id;
    if (thread.messages.some((m) => !m.seen)) void act("read", [thread.id], {}, { quiet: true });
  }, [thread]);

  if (!id) {
    return (
      <section className="zm-reader zm-reader-empty" aria-hidden>
        <Mail size={28} />
        <p>{t("reader.pick")}</p>
      </section>
    );
  }
  if (thread === undefined) return <section className="zm-reader" aria-busy="true"><div className="zm-skeleton" /></section>;
  if (thread === null)
    return (
      <section className="zm-reader zm-reader-empty">
        <p>{t("reader.gone")}</p>
        <button type="button" className="zv-btn" onClick={() => go({ list: route.list })}>
          {t("back")}
        </button>
      </section>
    );
  // A pane per conversation: which messages are open starts over with each one.
  return <ThreadPane key={thread.id} thread={thread} inline={inline} onPicker={onPicker} />;
}

function ThreadPane({ thread, inline, onPicker }: { thread: MailThread; inline?: ComposerState; onPicker: PickerFn }) {
  const { t, locale } = useMt();
  const boot = useMail((s) => s.boot);
  const route = useMail((s) => s.route);
  const ws = useMail((s) => s.ws);
  // What was unread when the conversation opened stays open while it is read (it is marked read at once).
  const [open, setOpen] = useState<Set<string>>(() => new Set(thread.messages.filter((m) => !m.seen).map((m) => m.id)));
  const [more, setMore] = useState<HTMLElement | null>(null);
  const dialog = useMail((s) => s.dialog);
  const setDialog = (d: "docs" | "issue" | null) => setState({ dialog: d });
  const bottom = useRef<HTMLDivElement>(null);
  const msgs = thread.messages;
  const last = msgs[msgs.length - 1];
  const inTrash = msgs.every((m) => m.trash);
  const inInbox = useMail((s) => Object.values(s.lists).some((l) => l.threads.some((x) => x.id === thread.id && x.inbox)));
  const starred = msgs.some((m) => m.flagged);
  const labels = (boot?.labels ?? []).filter((l) => thread.labels.includes(l.id));
  const isOpen = (m: MailMessage) => open.has(m.id) || m === last || m.draft;
  const ids = [thread.id];
  useEffect(() => {
    if (inline) bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [inline]);
  return (
    <section className="zm-reader" aria-label={thread.subject}>
      <div className="zm-reader-bar" data-zm-anchor="">
        <IconBtn icon={<ArrowLeft size={16} />} label={t("back")} keys="Esc" onClick={() => go({ list: route.list })} className="zm-back" />
        {inTrash ? (
          <>
            <IconBtn icon={<ArchiveRestore size={16} />} label={t("act.restore")} onClick={() => void act("restore", ids)} />
            <IconBtn icon={<Trash2 size={16} />} label={t("act.deleteForever")} danger onClick={() => void act("delete", ids)} />
          </>
        ) : (
          <>
            {inInbox || route.list.view === "inbox" ? (
              <IconBtn icon={<Archive size={16} />} label={t("act.archive")} keys="E" onClick={() => void act("archive", ids)} />
            ) : (
              <IconBtn icon={<InboxIcon size={16} />} label={t("act.toInbox")} keys="E" onClick={() => void act("inbox", ids)} />
            )}
            <IconBtn icon={<Trash2 size={16} />} label={t("act.trash")} keys="#" onClick={() => void act("trash", ids)} />
            <IconBtn icon={<ShieldAlert size={16} />} label={t("act.spam")} keys="!" onClick={() => void act("spam", ids)} className="zm-bar-extra" />
          </>
        )}
        <span className="zm-bar-sep" />
        <IconBtn icon={<Mail size={16} />} label={t("act.markUnread")} keys="U" onClick={() => void act("unread", ids).then(() => go({ list: route.list }))} />
        <IconBtn icon={<Clock size={16} />} label={t("act.snooze")} keys="H" onClick={(e) => onPicker("snooze", ids, e.currentTarget)} />
        <IconBtn icon={<Tag size={16} />} label={t("act.label")} keys="L" onClick={(e) => onPicker("label", ids, e.currentTarget)} className="zm-bar-extra" />
        <IconBtn icon={<FolderInput size={16} />} label={t("act.move")} keys="V" onClick={(e) => onPicker("move", ids, e.currentTarget)} className="zm-bar-extra" />
        <IconBtn icon={<Star size={16} />} label={starred ? t("act.unstar") : t("act.star")} keys="S" active={starred} onClick={() => void act(starred ? "unstar" : "star", ids, {}, { quiet: true })} className="zm-bar-extra" />
        <span className="zm-bar-sep" />
        <IconBtn icon={<FileText size={16} />} label={t("docs.save")} onClick={() => setDialog("docs")} className="zm-bar-extra" />
        <IconBtn icon={<MoreHorizontal size={16} />} label={t("more")} onClick={(e) => setMore(e.currentTarget)} />
        <span className="zm-bar-fill" />
        <NavArrows id={thread.id} />
      </div>
      <div className="zm-reader-scroll">
        <header className="zm-thread-head">
          <h1 className="zm-thread-subject">{thread.subject || t("noSubject")}</h1>
          <div className="zm-thread-labels">
            {labels.map((l) => (
              <span key={l.id} className="zm-chip">
                {l.kind === "manual" && <Dot color={l.color} />}
                {l.name}
                {l.kind === "manual" && (
                  <button type="button" className="zm-chip-x" aria-label={t("label.remove", { name: l.name })} onClick={() => void act("unlabel", ids, { label: l.id }, { quiet: true })}>
                    <X size={10} />
                  </button>
                )}
              </span>
            ))}
            {thread.snoozedUntil && (
              <span className="zm-chip zm-chip-snooze">
                <Clock size={12} /> {t("snoozed.until", { when: fullDate(thread.snoozedUntil, locale) })}
              </span>
            )}
          </div>
        </header>
        <div className="zm-messages">
          {msgs.map((m) =>
            isOpen(m) ? (
              <MessageCard key={m.id} m={m} locale={locale} onCollapse={m === last ? undefined : () => setOpen((s) => new Set([...s].filter((x) => x !== m.id)))} />
            ) : (
              <button key={m.id} type="button" className="zm-msg-folded" onClick={() => setOpen((s) => new Set([...s, m.id]))}>
                <Avatar name={m.from.name} address={m.from.address} size={24} />
                <span className="zm-msg-folded-who">{m.mine ? t("me") : m.from.name || m.from.address}</span>
                <span className="zm-msg-folded-snippet">{m.snippet}</span>
                <span className="zm-msg-folded-date">{listDate(m.date, locale)}</span>
              </button>
            )
          )}
        </div>
        <div ref={bottom} className="zm-reply-zone">
          {inline ? (
            <InlineComposer c={inline} />
          ) : (
            <div className="zm-reply-buttons">
              <button type="button" className="zv-btn" onClick={() => replyTo("reply")}>
                <Reply size={14} /> {t("act.reply")}
                <Kbd keys={["R"]} />
              </button>
              <button type="button" className="zv-btn" onClick={() => replyTo("replyAll")}>
                <ReplyAll size={14} /> {t("act.replyAll")}
                <Kbd keys={["A"]} />
              </button>
              <button type="button" className="zv-btn" onClick={() => replyTo("forward")}>
                <Forward size={14} /> {t("act.forward")}
                <Kbd keys={["F"]} />
              </button>
            </div>
          )}
        </div>
        <div className="zm-related">
          <Related ws={ws} refKey={`mail:${thread.id}`} collapsible defaultOpen={false} hideWhenEmpty kinds={["note", "issue", "project", "design"]} />
        </div>
      </div>
      {more && (
        <Popover anchor={more} onClose={() => setMore(null)} align="end" width={240}>
          <Menu
            onClose={() => setMore(null)}
            items={[
              // Where the bar is too narrow (a phone, a tablet's split pane) it keeps the main actions; the rest come here.
              ...(extrasHidden(more)
                ? [
                    ...(!inTrash ? [{ id: "spam", label: t("act.spam"), icon: <ShieldAlert size={15} />, keys: ["!"], run: () => void act("spam", ids) }] : []),
                    { id: "star", label: starred ? t("act.unstar") : t("act.star"), icon: <Star size={15} />, keys: ["S"], run: () => void act(starred ? "unstar" : "star", ids, {}, { quiet: true }) },
                    { id: "label", label: t("act.label"), icon: <Tag size={15} />, keys: ["L"], run: () => onPicker("label", ids, more) },
                    { id: "move", label: t("act.move"), icon: <FolderInput size={15} />, keys: ["V"], run: () => onPicker("move", ids, more) },
                  ]
                : []),
              { id: "docs", label: t("docs.save"), icon: <FileText size={15} />, run: () => setDialog("docs") },
              { id: "issue", label: t("issue.make"), icon: <ListTodo size={15} />, run: () => setDialog("issue") },
              ...(last?.unsubscribe?.match(/https:\/\/\S+/)
                ? [{ id: "unsub", label: t("act.unsubscribe"), icon: <X size={15} />, run: () => window.open(last.unsubscribe?.match(/https:\/\/\S+/)?.[0], "_blank", "noopener,noreferrer") }]
                : []),
              ...(!inTrash ? [] : [{ id: "delete", label: t("act.deleteForever"), icon: <Trash2 size={15} />, danger: true, run: () => void act("delete", ids) }]),
            ]}
          />
        </Popover>
      )}
      {dialog === "docs" && <DocsDialog thread={thread} onClose={() => setDialog(null)} />}
      {dialog === "issue" && <IssueDialog thread={thread} onClose={() => setDialog(null)} />}
    </section>
  );
}

function NavArrows({ id }: { id: string }) {
  const { t } = useMt();
  const route = useMail((s) => s.route);
  const list = useMail((s) => s.lists[route.list.q ? `q:${route.list.q}` : route.list.label ? `label:${route.list.label}` : `view:${route.list.view ?? "inbox"}`]?.threads ?? []);
  const i = list.findIndex((x) => x.id === id);
  return (
    <>
      <IconBtn icon={<ChevronUp size={16} />} label={t("prev")} keys="K" disabled={i <= 0} onClick={() => i > 0 && go({ list: route.list, thread: list[i - 1].id }, true)} />
      <IconBtn icon={<ChevronDown size={16} />} label={t("next")} keys="J" disabled={i < 0 || i >= list.length - 1} onClick={() => i >= 0 && i < list.length - 1 && go({ list: route.list, thread: list[i + 1].id }, true)} />
    </>
  );
}

function MessageCard({ m, locale, onCollapse }: { m: MailMessage; locale: string; onCollapse?: () => void }) {
  const { t } = useMt();
  const boot = useMail((s) => s.boot);
  const [details, setDetails] = useState(false);
  const [images, setImages] = useState(m.imagesAllowed);
  const [blocked, setBlocked] = useState(0);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const to = [...m.to, ...m.cc];
  const mine = new Set((boot?.accounts ?? []).map((a) => a.email.toLowerCase()));
  const toText = to.map((a) => (mine.has(a.address.toLowerCase()) ? t("me") : a.name || a.address)).join(", ");
  const editDraft = async () => {
    try {
      const r = await api<{ draft: import("@/lib/mail-client/types").Draft }>("drafts/from-message", { method: "POST", json: { message: m.id } });
      openComposer({ draft: r.draft, inline: false });
    } catch {
      toast(t("err.generic"), { kind: "error" });
    }
  };
  return (
    <article className="zm-msg" data-mine={m.mine || undefined}>
      <header className="zm-msg-head" onClick={onCollapse}>
        <Avatar name={m.from.name} address={m.from.address} size={32} />
        <div className="zm-msg-who">
          <div>
            <span className="zm-msg-name">{m.from.name || m.from.address}</span>
            {m.from.name && <span className="zm-msg-addr">&lt;{m.from.address}&gt;</span>}
          </div>
          <button
            type="button"
            className="zm-msg-to"
            onClick={(e) => {
              e.stopPropagation();
              setDetails((v) => !v);
            }}
          >
            {t("to")} {toText || t("compose.noRecipients")} <ChevronDown size={12} />
          </button>
        </div>
        <span className="zm-msg-date" title={fullDate(m.date, locale)}>
          {listDate(m.date, locale)}
        </span>
        <span className="zm-msg-tools" onClick={(e) => e.stopPropagation()}>
          {m.draft ? (
            <IconBtn icon={<Pencil size={15} />} label={t("draft.edit")} onClick={() => void editDraft()} />
          ) : (
            <IconBtn icon={<Reply size={15} />} label={t("act.reply")} onClick={() => replyTo("reply", m.id)} />
          )}
          <IconBtn icon={<MoreHorizontal size={15} />} label={t("more")} onClick={(e) => setMenu(e.currentTarget)} />
        </span>
      </header>
      {details && (
        <dl className="zm-msg-details">
          <dt>{t("from")}</dt>
          <dd>{addrText(m.from)}</dd>
          {m.to.length > 0 && (
            <>
              <dt>{t("to")}</dt>
              <dd>{m.to.map(addrText).join(", ")}</dd>
            </>
          )}
          {m.cc.length > 0 && (
            <>
              <dt>{t("cc")}</dt>
              <dd>{m.cc.map(addrText).join(", ")}</dd>
            </>
          )}
          {m.bcc.length > 0 && (
            <>
              <dt>{t("bcc")}</dt>
              <dd>{m.bcc.map(addrText).join(", ")}</dd>
            </>
          )}
          <dt>{t("date")}</dt>
          <dd>{fullDate(m.date, locale)}</dd>
        </dl>
      )}
      {blocked > 0 && !images && (
        <div className="zm-images-bar">
          <span>{t("images.hidden")}</span>
          <button type="button" className="zv-btn zv-btn-sm" onClick={() => setImages(true)}>
            {t("images.show")}
          </button>
          <button
            type="button"
            className="zv-btn zv-btn-ghost zv-btn-sm"
            onClick={() => {
              setImages(true);
              void api("senders", { method: "POST", json: { message: m.id } }).catch(() => undefined);
            }}
          >
            {t("images.always", { sender: m.from.address })}
          </button>
        </div>
      )}
      <MessageFrame id={m.id} images={images} onBlocked={setBlocked} />
      {m.attachments.length > 0 && (
        <div className="zm-atts">
          {m.attachments.map((a) => (
            <a key={a.id} className="zm-att" href={`/api/mail/att/${encodeURIComponent(a.id)}`} download={a.filename}>
              <Paperclip size={14} />
              <span className="zm-att-name">{a.filename}</span>
              <span className="zm-att-size">{sizeText(a.size, locale)}</span>
              <Download size={14} />
            </a>
          ))}
        </div>
      )}
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} align="end" width={220}>
          <Menu
            onClose={() => setMenu(null)}
            items={[
              { id: "reply", label: t("act.reply"), icon: <Reply size={15} />, keys: ["R"], run: () => replyTo("reply", m.id) },
              { id: "all", label: t("act.replyAll"), icon: <ReplyAll size={15} />, keys: ["A"], run: () => replyTo("replyAll", m.id) },
              { id: "fwd", label: t("act.forward"), icon: <Forward size={15} />, keys: ["F"], run: () => replyTo("forward", m.id) },
              { id: "trash", label: t("act.trashMessage"), icon: <Trash2 size={15} />, run: () => void api("actions", { method: "POST", json: { messages: [m.id], action: "trash" } }).then(() => loadThread(getState().route.thread ?? "")) },
            ]}
          />
        </Popover>
      )}
    </article>
  );
}

/**
 * One message's body: a frame of its own, sandboxed (no scripts, ever), the
 * height of its content. The frame's document says how many remote images
 * it held back (<meta name="zv-blocked">).
 */
function MessageFrame({ id, images, onBlocked }: { id: string; images: boolean; onBlocked: (n: number) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const src = `/api/mail/body/${encodeURIComponent(id)}?${images ? "images=1&" : ""}${dark ? "dark=1" : ""}`;
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const doc = f.contentDocument;
      if (!doc?.documentElement) return;
      setHeight(Math.min(Math.max(doc.documentElement.scrollHeight, 40), 20000));
    };
    const onLoad = () => {
      const doc = f.contentDocument;
      if (!doc) return;
      onBlocked(Number(doc.querySelector('meta[name="zv-blocked"]')?.getAttribute("content")) || 0);
      measure();
      ro?.disconnect();
      ro = new ResizeObserver(measure);
      if (doc.body) ro.observe(doc.body);
      // Images arrive after load and change the height.
      for (const img of Array.from(doc.images)) img.addEventListener("load", measure, { once: true });
    };
    f.addEventListener("load", onLoad);
    return () => {
      f.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [src, onBlocked]);
  return <iframe ref={ref} className="zm-frame" src={src} title={id} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" style={{ height }} />;
}
