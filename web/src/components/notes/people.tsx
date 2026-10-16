"use client";

// People in Documents (Notion's Person property, Created by / Last edited by,
// @mentions): the members of the open workspace as avatars and names, and
// the picker that chooses them.

import { useImperativeHandle, useMemo, useState, useSyncExternalStore, type Ref, type TextareaHTMLAttributes } from "react";
import { Check, X } from "lucide-react";
import { useNotes } from "./context";
import { Popover } from "./ui";
import { commentParts, initials, people, personById, personName, subscribePeople, type NotesPerson } from "@/lib/notes/people";

const NO_PEOPLE: readonly NotesPerson[] = [];

/** The workspace's members (re-renders when the list loads or changes). */
export function usePeople(): readonly NotesPerson[] {
  return useSyncExternalStore(subscribePeople, people, () => NO_PEOPLE);
}

/** A person's name for display: "form" and automations named as such; unknown ids never show. */
export function usePersonLabel(): (id: string) => string {
  const { t } = useNotes();
  usePeople();
  return (id: string) => personName(id, { unknown: t("people.unknown"), form: t("people.form"), automation: t("people.automation") });
}

/** A round avatar: the person's picture (https only) or their initials. */
export function Avatar({ name, avatar, size = 20 }: { name: string; avatar?: string; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.45)) };
  if (avatar && /^https:\/\//.test(avatar)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="nt-avatar" src={avatar} alt="" style={style} referrerPolicy="no-referrer" />;
  }
  return (
    <span className="nt-avatar" style={style} aria-hidden="true">
      {initials(name || "?")}
    </span>
  );
}

/** One person: avatar and name. */
export function PersonChip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const label = usePersonLabel();
  const p = personById(id);
  const name = label(id);
  return (
    <span className="nt-person">
      <Avatar name={name} avatar={p?.avatar} size={18} />
      <span className="nt-person-name">{name}</span>
      {onRemove && (
        <button
          type="button"
          className="nt-person-x nt-btn-reset"
          aria-label={name}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** A cell's people (compact: avatars only after the first name when space is short). */
export function PeopleValue({ ids }: { ids: readonly string[] }) {
  return (
    <span className="nt-people">
      {ids.map((id) => (
        <PersonChip key={id} id={id} />
      ))}
    </span>
  );
}

/** Comment text with "<@id>" mentions as @Name chips (text stays text: React escapes it). */
export function CommentText({ text }: { text: string }) {
  const label = usePersonLabel();
  return (
    <>
      {commentParts(text).map((p, i) =>
        "userId" in p ? (
          <span key={i} className="nt-mention nt-mention-person">
            @{label(p.userId)}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "@Name" of a member becomes a "<@id>" token (longest names first; a name inside a longer word stays text). */
export function mentionTokens(text: string, list: readonly NotesPerson[]): string {
  let out = text;
  for (const p of [...list].filter((x) => x.name.trim()).sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(`@${escapeRe(p.name)}(?![\\p{L}\\p{N}_])`, "gu"), `<@${p.id}>`);
  }
  return out;
}

/** The "@query" right before the caret, if the person is typing a mention. */
function mentionQuery(text: string, caret: number): { start: number; q: string } | null {
  const m = /(^|\s)@([^\s@<>]{0,30})$/u.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, q: m[2] } : null;
}

/**
 * A comment box with Notion's "@" menu: typing "@" lists members, a pick
 * writes "@Name " (sent as a mention token, see mentionTokens).
 */
export function MentionTextarea({
  value,
  onChange,
  onKeyDown,
  inputRef,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onChange: (v: string) => void; inputRef?: Ref<HTMLTextAreaElement> }) {
  const { user } = useNotes();
  const list = usePeople();
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  const [query, setQuery] = useState<{ start: number; q: string } | null>(null);
  const [active, setActive] = useState(0);
  const found = useMemo(() => (query ? matchPeople(list, query.q, user?.id).slice(0, 8) : []), [list, query, user?.id]);
  // The parent's ref (focus on "Add comment") reaches the textarea.
  useImperativeHandle(inputRef, () => el as HTMLTextAreaElement, [el]);
  const pick = (p: NotesPerson) => {
    if (!query || !el) return;
    const caret = el.selectionStart ?? value.length;
    const next = `${value.slice(0, query.start)}@${p.name} ${value.slice(caret)}`;
    onChange(next);
    setQuery(null);
    const at = query.start + p.name.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };
  return (
    <>
      <textarea
        {...rest}
        ref={setEl}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(mentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length));
          setActive(0);
          // The box grows with its text.
          e.target.style.height = "auto";
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (query && found.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (e.key === "ArrowDown" ? Math.min(found.length - 1, a + 1) : Math.max(0, a - 1)));
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
              e.preventDefault();
              pick(found[active] ?? found[0]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setQuery(null);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {query && found.length > 0 && el && (
        <Popover anchor={el} placement="bottom-start" onClose={() => setQuery(null)}>
          <div className="nt-selectpop" style={{ padding: "4px 0" }} onMouseDown={(e) => e.preventDefault()}>
            {found.map((p, i) => (
              <div key={p.id} className="nt-opt-row" data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => pick(p)}>
                <Avatar name={p.name} avatar={p.avatar} size={20} />
                <span className="nt-person-name">{p.name}</span>
              </div>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Members matching a query (by name), the signed-in person first. */
export function matchPeople(list: readonly NotesPerson[], q: string, me?: string): NotesPerson[] {
  const s = q.trim().toLowerCase();
  return list.filter((p) => !s || p.name.toLowerCase().includes(s)).sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : 0));
}

/** Notion's person picker: search, pick one or several members. */
export function PersonPicker({ value, single, anchor, onClose, onValue }: { value: readonly string[]; single?: boolean; anchor: HTMLElement | null; onClose: () => void; onValue: (ids: string[]) => void }) {
  const { t, user } = useNotes();
  const list = usePeople();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const found = useMemo(() => matchPeople(list, q, user?.id), [list, q, user?.id]);
  const pick = (id: string) => {
    if (single) {
      onValue(value[0] === id ? [] : [id]);
      onClose();
    } else onValue(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
    setQ("");
  };
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="nt-selectpop">
        <div className="nt-selectpop-input">
          {value.map((id) => (
            <PersonChip key={id} id={id} onRemove={() => onValue(value.filter((x) => x !== id))} />
          ))}
          <input
            autoFocus
            value={q}
            placeholder={value.length ? "" : t("people.search")}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(found.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const p = found[active];
                if (p) pick(p.id);
              } else if (e.key === "Backspace" && !q && value.length) {
                onValue(value.slice(0, -1));
              } else if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div style={{ maxHeight: 300, overflowY: "auto", padding: "4px 0 6px" }}>
          <div className="nt-selectpop-hint">{single ? t("people.pickOne") : t("people.pick")}</div>
          {found.length === 0 && <div className="nt-selectpop-hint">{t("people.noOne")}</div>}
          {found.map((p, i) => (
            <div key={p.id} className="nt-opt-row" data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => pick(p.id)}>
              <Avatar name={p.name} avatar={p.avatar} size={20} />
              <span className="nt-person-name">
                {p.name}
                {p.id === user?.id ? ` (${t("people.you")})` : ""}
              </span>
              {value.includes(p.id) && <Check size={14} style={{ marginInlineStart: "auto", color: "var(--nt-text-2)" }} />}
            </div>
          ))}
        </div>
      </div>
    </Popover>
  );
}
