"use client";

// Page comments (Notion's page discussion under the title) and inline
// discussions on selected text: add, reply, resolve, re-open, delete.
// Comments live in the note, so they sync with it.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Pencil, Plus, RotateCcw, SmilePlus, Trash2, X } from "lucide-react";
import { useNotes } from "./context";
import { Popover } from "./ui";
import { EmojiPicker } from "./EmojiPicker";
import { EmojiGlyph } from "./custom-emoji";
import { shortId } from "@/lib/notes/model";
import { relativeTime } from "@/lib/notes/i18n";
import { people, personById } from "@/lib/notes/people";
import type { Note, NoteComment } from "@/lib/notes/types";
import { Avatar as PersonAvatar, CommentText, MentionTextarea, mentionTokens } from "./people";

/** A commenter's avatar: their picture or initials (by id when the comment knows it). */
function Avatar({ name, id }: { name: string; id?: string }) {
  return <PersonAvatar name={name} avatar={id ? personById(id)?.avatar : undefined} size={24} />;
}

/** The author's current name (renamed since: the new one), else the name the comment was written with. */
const authorName = (c: NoteComment, you: string) => (c.authorId ? personById(c.authorId)?.name : undefined) || c.author || you;

/** Whether the signed-in person wrote it (by id; by name for comments older than ids). */
const isMine = (c: NoteComment, me: string | undefined, author: string) => (c.authorId && me ? c.authorId === me : c.author === author);

const QUICK = ["👍", "❤️", "😄", "🎉", "👀", "🙏", "✅", "🔥"];

/** A comment's text, or its author editing it (Notion's "Edit comment"): ↵ saves, Esc cancels. */
function CommentBody({ c, editing, onDone }: { c: NoteComment; editing: boolean; onDone: (text: string | null) => void }) {
  const { t } = useNotes();
  const [v, setV] = useState(c.text);
  if (!editing) {
    return (
      <div className="nt-cm-text">
        <CommentText text={c.text} />
        {c.editedAt ? <span className="nt-cm-edited"> {t("comments.edited")}</span> : null}
      </div>
    );
  }
  const save = () => {
    const next = mentionTokens(v.trim(), people());
    onDone(next && next !== c.text ? next : null);
  };
  return (
    <div className="nt-cm-edit">
      <MentionTextarea
        autoFocus
        rows={1}
        value={v}
        onChange={setV}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone(null);
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="nt-cm-edit-acts">
        <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={() => onDone(null)}>
          {t("common.cancel")}
        </button>
        <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" disabled={!v.trim()} onClick={save}>
          {t("comments.save")}
        </button>
      </div>
    </div>
  );
}

/** Emoji reactions under a comment (Notion): click a chip to join or leave it. */
function Reactions({ c, author, onChange }: { c: NoteComment; author: string; onChange: (r: NoteComment["reactions"]) => void }) {
  const { t } = useNotes();
  const [pick, setPick] = useState<HTMLElement | null>(null);
  const [more, setMore] = useState(false);
  const list = Object.entries(c.reactions ?? {});
  const toggle = (emoji: string) => {
    const next = { ...(c.reactions ?? {}) };
    const who = next[emoji] ?? [];
    next[emoji] = who.includes(author) ? who.filter((x) => x !== author) : [...who, author];
    if (!next[emoji].length) delete next[emoji];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="nt-cm-reacts">
      {list.map(([emoji, who]) => (
        <button type="button" key={emoji} className="nt-cm-react nt-btn-reset" data-mine={who.includes(author) || undefined} title={who.join(", ")} onClick={() => toggle(emoji)}>
          <span>
            <EmojiGlyph value={emoji} size={16} />
          </span>
          {who.length}
        </button>
      ))}
      <button type="button" className="nt-cm-react nt-cm-react-add nt-btn-reset" aria-label={t("comments.react")} title={t("comments.react")} onClick={(e) => setPick(e.currentTarget)}>
        <SmilePlus size={14} />
      </button>
      {pick && (
        <Popover
          anchor={pick}
          onClose={() => {
            setPick(null);
            setMore(false);
          }}
        >
          {more ? (
            <EmojiPicker
              customAs="name"
              onPick={(e) => {
                toggle(e);
                setPick(null);
                setMore(false);
              }}
            />
          ) : (
            <div className="nt-cm-quick">
              {QUICK.map((e) => (
                <button
                  type="button"
                  key={e}
                  className="nt-btn-reset"
                  onClick={() => {
                    toggle(e);
                    setPick(null);
                  }}
                >
                  {e}
                </button>
              ))}
              <button type="button" className="nt-btn-reset nt-cm-quick-more" aria-label={t("comments.moreEmoji")} title={t("comments.moreEmoji")} onClick={() => setMore(true)}>
                <Plus size={14} />
              </button>
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

export function Comments({ note, active, onActive }: { note: Note; active: boolean; onActive: (on: boolean) => void }) {
  const { t, locale, store, user, readOnly } = useNotes();
  const [text, setText] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const all = useMemo(() => note.comments ?? [], [note.comments]);
  // Inline discussions live on their text; this list is the page's own.
  const comments = useMemo(() => all.filter((c) => !c.thread), [all]);
  const open = useMemo(() => comments.filter((c) => !c.resolved), [comments]);
  const resolved = useMemo(() => comments.filter((c) => c.resolved), [comments]);
  const author = user?.name || t("comments.you");
  // Commenters delete only their own comments; editors tidy up any.
  const mayDelete = (c: NoteComment) => !readOnly || isMine(c, user?.id, author);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);
  if (!comments.length && !active && !text) return null;
  // Page edits keep the inline discussions as they are.
  const save = (list: NoteComment[]) => store.update(note.id, { comments: [...all.filter((c) => c.thread), ...list] }, { quiet: true });
  const add = () => {
    const v = mentionTokens(text.trim(), people());
    if (!v) return;
    save([...comments, { id: shortId(), text: v, at: Date.now(), author, ...(user?.id ? { authorId: user.id } : {}) }]);
    setText("");
  };
  const row = (c: NoteComment) => (
    <div key={c.id} className="nt-cm" data-resolved={c.resolved || undefined}>
      <Avatar name={authorName(c, t("comments.you"))} id={c.authorId} />
      <div className="nt-cm-main">
        <div className="nt-cm-head">
          <b>{authorName(c, t("comments.you"))}</b>
          <span>{relativeTime(t, locale, c.at)}</span>
          <span className="nt-cm-acts">
            <button type="button" className="nt-item-act nt-btn-reset" title={c.resolved ? t("comments.reopen") : t("comments.resolve")} aria-label={c.resolved ? t("comments.reopen") : t("comments.resolve")} onClick={() => save(comments.map((x) => (x.id === c.id ? { ...x, resolved: !x.resolved } : x)))}>
              {c.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
            </button>
            {isMine(c, user?.id, author) && (
              <button type="button" className="nt-item-act nt-btn-reset" title={t("comments.edit")} aria-label={t("comments.edit")} onClick={() => setEditing(c.id)}>
                <Pencil size={14} />
              </button>
            )}
            {mayDelete(c) && (
              <button type="button" className="nt-item-act nt-btn-reset" title={t("comments.delete")} aria-label={t("comments.delete")} onClick={() => save(comments.filter((x) => x.id !== c.id))}>
                <Trash2 size={14} />
              </button>
            )}
          </span>
        </div>
        <CommentBody
          c={c}
          editing={editing === c.id}
          onDone={(text) => {
            setEditing(null);
            if (text) save(comments.map((x) => (x.id === c.id ? { ...x, text, editedAt: Date.now() } : x)));
          }}
        />
        <Reactions c={c} author={author} onChange={(reactions) => save(comments.map((x) => (x.id === c.id ? { ...x, reactions } : x)))} />
      </div>
    </div>
  );
  return (
    <div className="nt-comments">
      {open.map(row)}
      <div className="nt-cm nt-cm-new">
        <Avatar name={author} id={user?.id} />
        <MentionTextarea
          inputRef={input}
          rows={1}
          value={text}
          placeholder={t("comments.placeholder")}
          onChange={setText}
          onBlur={() => !text.trim() && onActive(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="nt-send nt-btn-reset" disabled={!text.trim()} aria-label={t("comments.send")} onClick={add}>
          <ArrowUp strokeWidth={2.2} />
        </button>
      </div>
      {resolved.length > 0 && (
        <>
          <button type="button" className="nt-backlinks-btn nt-btn-reset" onClick={() => setShowResolved((v) => !v)}>
            <Check size={14} />
            {t("comments.resolved", { n: resolved.length })}
          </button>
          {showResolved && resolved.map(row)}
        </>
      )}
    </div>
  );
}

/** A suggested edit's card (Notion): who suggested what, Accept / Reject for editors, then its discussion. */
export interface SuggestionCard {
  ins: string;
  del: string;
  /** The person may accept or reject it (edit access). */
  canDecide: boolean;
  onDecide: (accept: boolean) => void;
}

function SuggestionHead({ record, card }: { record: NoteComment | undefined; card: SuggestionCard }) {
  const { t, locale } = useNotes();
  const name = record ? authorName(record, t("comments.you")) : "";
  return (
    <div className="nt-sug-card">
      <div className="nt-cm">
        <Avatar name={name || "?"} id={record?.authorId} />
        <div className="nt-cm-main">
          <div className="nt-cm-head">
            <b>{name || t("suggest.title")}</b>
            {record && <span>{relativeTime(t, locale, record.at)}</span>}
            {card.canDecide && (
              <span className="nt-cm-acts nt-sug-acts">
                <button type="button" className="nt-item-act nt-btn-reset nt-sug-accept" title={t("suggest.accept")} aria-label={t("suggest.accept")} onClick={() => card.onDecide(true)}>
                  <Check size={15} />
                </button>
                <button type="button" className="nt-item-act nt-btn-reset nt-sug-reject" title={t("suggest.reject")} aria-label={t("suggest.reject")} onClick={() => card.onDecide(false)}>
                  <X size={15} />
                </button>
              </span>
            )}
          </div>
          {card.ins.trim() && (
            <div className="nt-sug-line">
              <span className="nt-sug-what">{t("suggest.add")}</span> <ins className="nt-sins">{card.ins.trim().slice(0, 400)}</ins>
            </div>
          )}
          {card.del.trim() && (
            <div className="nt-sug-line">
              <span className="nt-sug-what">{t("suggest.delete")}</span> <del className="nt-sdel">{card.del.trim().slice(0, 400)}</del>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** An inline discussion on marked text (opens from the mark or the toolbar), or a suggested edit's card. */
export function ThreadPopover({ note, threadId, quote, anchor, onClose, onRemoveMark, suggestion }: { note: Note; threadId: string; quote?: string; anchor: HTMLElement | null; onClose: (empty: boolean) => void; onRemoveMark: () => void; suggestion?: SuggestionCard }) {
  const [empty, setEmpty] = useState(true);
  return (
    <Popover anchor={anchor} onClose={() => onClose(empty)} placement="bottom-start" className="nt-thread-pop">
      {/* A new discussion takes the caret to its first comment; opening one already under way leaves the caret in the text (Notion). */}
      <ThreadBody note={note} threadId={threadId} quote={quote} onClose={onClose} onRemoveMark={onRemoveMark} suggestion={suggestion} onEmpty={setEmpty} autoFocus={!(note.comments ?? []).some((c) => c.thread === threadId)} />
    </Popover>
  );
}

/** A discussion: its quote, comments, reactions and a reply box (in a popover on the text, or in the comments sidebar). */
function ThreadBody({ note, threadId, quote, onClose, onRemoveMark, suggestion, onEmpty, autoFocus, onQuote }: { note: Note; threadId: string; quote?: string; onClose: (empty: boolean) => void; onRemoveMark: () => void; suggestion?: SuggestionCard; onEmpty?: (empty: boolean) => void; autoFocus?: boolean; onQuote?: () => void }) {
  const { t, locale, store, user, readOnly } = useNotes();
  const [text, setText] = useState("");
  const all = note.comments ?? [];
  const thread = all.filter((c) => c.thread === threadId).sort((a, b) => a.at - b.at);
  // A suggestion's own entry heads its card; the rest is its discussion.
  const record = thread.find((c) => c.suggestion);
  const items = suggestion ? thread.filter((c) => !c.suggestion) : thread;
  const resolved = Boolean(items[0]?.resolved);
  const author = user?.name || t("comments.you");
  const shownQuote = suggestion ? "" : (items[0]?.quote ?? quote ?? "");
  // Commenters delete only their own comments (a whole thread when it is all theirs).
  const mayDelete = (c: NoteComment) => !readOnly || isMine(c, user?.id, author);
  const [editing, setEditing] = useState<string | null>(null);
  const save = (list: NoteComment[]) => store.update(note.id, { comments: list }, { quiet: true });
  const add = () => {
    const v = mentionTokens(text.trim(), people());
    if (!v) return;
    save([...all, { id: shortId(), text: v, at: Date.now(), author, ...(user?.id ? { authorId: user.id } : {}), thread: threadId, ...(items.length === 0 && shownQuote ? { quote: shownQuote.slice(0, 500) } : {}) }]);
    setText("");
  };
  const setResolved = (on: boolean) => {
    save(all.map((c) => (c.thread === threadId ? { ...c, resolved: on || undefined } : c)));
    if (on) onClose(false);
  };
  const removeThread = () => {
    save(all.filter((c) => c.thread !== threadId));
    onRemoveMark();
    onClose(false);
  };
  const empty = !suggestion && items.length === 0 && !text.trim();
  useEffect(() => onEmpty?.(empty), [empty, onEmpty]);
  return (
    <div className="nt-thread">
      {suggestion && <SuggestionHead record={record} card={suggestion} />}
      <div className="nt-thread-head">
        {shownQuote &&
          (onQuote ? (
            <button type="button" className="nt-thread-quote nt-btn-reset" title={t("comments.jump")} onClick={onQuote}>
              {shownQuote}
            </button>
          ) : (
            <div className="nt-thread-quote">{shownQuote}</div>
          ))}
        {items.length > 0 && !suggestion && (
          <span className="nt-cm-acts nt-thread-acts">
            <button type="button" className="nt-item-act nt-btn-reset" title={resolved ? t("comments.reopen") : t("comments.resolve")} aria-label={resolved ? t("comments.reopen") : t("comments.resolve")} onClick={() => setResolved(!resolved)}>
              {resolved ? <RotateCcw size={14} /> : <Check size={14} />}
            </button>
            {items.every(mayDelete) && (
              <button type="button" className="nt-item-act nt-btn-reset" title={t("comments.deleteThread")} aria-label={t("comments.deleteThread")} onClick={removeThread}>
                <Trash2 size={14} />
              </button>
            )}
          </span>
        )}
      </div>
      {items.map((c) => (
        <div key={c.id} className="nt-cm">
          <Avatar name={authorName(c, t("comments.you"))} id={c.authorId} />
          <div className="nt-cm-main">
            <div className="nt-cm-head">
              <b>{authorName(c, t("comments.you"))}</b>
              <span>{relativeTime(t, locale, c.at)}</span>
              <span className="nt-cm-acts">
                {isMine(c, user?.id, author) && (
                  <button type="button" className="nt-item-act nt-btn-reset" title={t("comments.edit")} aria-label={t("comments.edit")} onClick={() => setEditing(c.id)}>
                    <Pencil size={14} />
                  </button>
                )}
                {mayDelete(c) && (
                  <button
                    type="button"
                    className="nt-item-act nt-btn-reset"
                    title={t("comments.delete")}
                    aria-label={t("comments.delete")}
                    onClick={() => {
                      const rest = all.filter((x) => x.id !== c.id);
                      save(rest);
                      if (!suggestion && !rest.some((x) => x.thread === threadId)) {
                        onRemoveMark();
                        onClose(false);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </span>
            </div>
            <CommentBody
              c={c}
              editing={editing === c.id}
              onDone={(text) => {
                setEditing(null);
                if (text) save(all.map((x) => (x.id === c.id ? { ...x, text, editedAt: Date.now() } : x)));
              }}
            />
            <Reactions c={c} author={author} onChange={(reactions) => save(all.map((x) => (x.id === c.id ? { ...x, reactions } : x)))} />
          </div>
        </div>
      ))}
      <div className="nt-cm nt-cm-new">
        <Avatar name={author} id={user?.id} />
        <MentionTextarea
          autoFocus={autoFocus && !suggestion}
          rows={1}
          value={text}
          placeholder={items.length || suggestion ? t("comments.reply") : t("comments.placeholder")}
          onChange={setText}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="nt-send nt-btn-reset" disabled={!text.trim()} aria-label={t("comments.send")} onClick={add}>
          <ArrowUp strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ sidebar
// Notion's comments sidebar: the discussion list pinned to the right of the
// page, every thread in full (reply, resolve, re-open). It stays open from
// page to page until closed (remembered on this device).

const DOCK_KEY = "nt-comments-docked";

export function setCommentsDocked(on: boolean): void {
  try {
    if (on) localStorage.setItem(DOCK_KEY, "1");
    else localStorage.removeItem(DOCK_KEY);
  } catch {
    // Private windows: the sidebar still opens, it just is not remembered.
  }
  window.dispatchEvent(new CustomEvent("nt-comments-dock", { detail: on }));
}

export function useCommentsDocked(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOn(localStorage.getItem(DOCK_KEY) === "1");
    } catch {
      // As above.
    }
    const f = (e: Event) => setOn(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener("nt-comments-dock", f);
    return () => window.removeEventListener("nt-comments-dock", f);
  }, []);
  return on;
}

/** Scrolls to a discussion's text on the page and opens it there. */
export function jumpToThread(key: string): void {
  if (key.startsWith("page:")) {
    document.querySelector(".nt-scroller .nt-comments")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const el = document.querySelector<HTMLElement>(`.nt-scroller .nt-page .nt-cmark[data-thread="${CSS.escape(key)}"], .nt-scroller .nt-page [data-sid="${CSS.escape(key)}"]`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.dispatchEvent(new CustomEvent("nt-open-thread", { detail: key }));
}

export function CommentsSidebar({ note }: { note: Note }) {
  const { t, locale } = useNotes();
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const all = useMemo(() => note.comments ?? [], [note.comments]);
  const decided = new Set(all.filter((c) => c.suggestion?.state && c.thread).map((c) => c.thread as string));
  const shown = all.filter((c) => (tab === "open" ? !c.resolved : c.resolved && !(c.thread && decided.has(c.thread))));
  const threads = new Map<string, NoteComment[]>();
  for (const c of shown) {
    const key = c.thread ?? "page:";
    threads.set(key, [...(threads.get(key) ?? []), c]);
  }
  // In the order they appear on the page (Notion's); page comments first.
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    const ids = [...document.querySelectorAll<HTMLElement>(".nt-scroller .nt-page .nt-cmark[data-thread], .nt-scroller .nt-page [data-sid]")].map((el) => el.dataset.thread ?? el.dataset.sid ?? "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrder((prev) => (prev.join() === ids.join() ? prev : ids));
  }, [note.content, note.comments]);
  const pos = (k: string) => (k === "page:" ? -1 : order.indexOf(k) === -1 ? order.length : order.indexOf(k));
  const list = [...threads.entries()].sort((a, b) => pos(a[0]) - pos(b[0]) || a[1][0].at - b[1][0].at);
  const removeMark = (id: string) => window.dispatchEvent(new CustomEvent("nt-remove-thread-mark", { detail: id }));
  return (
    <aside className="nt-cside" aria-label={t("comments.title")} data-test="comments-sidebar">
      <div className="nt-cside-head">
        <span className="nt-cside-title">{t("comments.title")}</span>
        <button type="button" className="nt-icon-btn nt-btn-reset" aria-label={t("comments.undock")} title={t("comments.undock")} onClick={() => setCommentsDocked(false)}>
          <X size={16} />
        </button>
      </div>
      <div className="nt-discuss-tabs nt-cside-tabs" role="tablist" aria-label={t("comments.all")}>
        {(["open", "resolved"] as const).map((k) => (
          <button type="button" key={k} role="tab" aria-selected={tab === k} className="nt-discuss-tab nt-btn-reset" onClick={() => setTab(k)}>
            {t(k === "open" ? "comments.openTab" : "comments.resolvedTab")}
          </button>
        ))}
      </div>
      <div className="nt-cside-list">
        {list.length === 0 && <p className="nt-discuss-empty">{t(tab === "open" ? "comments.noneOpen" : "comments.noneResolved")}</p>}
        {list.map(([key, items]) =>
          key === "page:" || items[0].suggestion ? (
            <button type="button" key={key} className="nt-discuss-row nt-cside-card nt-btn-reset" onClick={() => jumpToThread(key === "page:" ? `page:${items[0].id}` : key)}>
              <span className={key === "page:" ? "nt-discuss-page" : "nt-thread-quote"}>{key === "page:" ? t("comments.onPage") : t("suggest.title")}</span>
              <span className="nt-discuss-text">
                <b>{items[0].author || t("comments.you")}</b> {items[0].suggestion ? "" : items[items.length - 1].text}
              </span>
              <span className="nt-discuss-meta">
                {relativeTime(t, locale, items[items.length - 1].at)}
                {items.length > 1 ? ` · ${t("comments.replies", { n: items.length - 1 })}` : ""}
              </span>
            </button>
          ) : (
            <div key={key} className="nt-cside-card" data-thread={key}>
              <ThreadBody note={note} threadId={key} onClose={() => undefined} onRemoveMark={() => removeMark(key)} onQuote={() => jumpToThread(key)} />
            </div>
          )
        )}
      </div>
    </aside>
  );
}

