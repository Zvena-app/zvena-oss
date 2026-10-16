"use client";
/* eslint-disable @next/next/no-img-element -- custom emoji are the workspace's own uploaded images, shown as they are */

// zvena Documents: a workspace's custom emoji (Notion's :name: images) — the
// "Custom" section of the emoji picker with "Add emoji", and the hook that
// keeps them in step (lib/notes/emoji.ts). The inline emoji in text is the
// editor's (custom-emoji-inline.tsx), so the editor stays out of what the
// sidebar, comments and pickers load.

import { useRef, useState, useSyncExternalStore } from "react";
import { Plus, X } from "lucide-react";
import { useNotesMaybe } from "./context";
import { toast } from "./ui";
import { EMOJI_FILE_RE, addCustomEmoji, customEmoji, emojiName, removeCustomEmoji, subscribeCustomEmoji, type WorkspaceEmoji } from "@/lib/notes/emoji";
import { notesT, type NotesKey } from "@/lib/notes/i18n";

const NONE: WorkspaceEmoji[] = [];

export function useCustomEmoji(): WorkspaceEmoji[] {
  return useSyncExternalStore(subscribeCustomEmoji, customEmoji, () => NONE);
}

/** A reaction or a picked value that names a custom emoji (":party-parrot:"). */
export const CUSTOM_KEY_RE = /^:([a-z0-9_-]{1,32}):$/;

/** An emoji as shown: a custom one as its image (by ":name:" or by its file), anything else as text. */
export function EmojiGlyph({ value, size = 18 }: { value: string; size?: number }) {
  const list = useCustomEmoji();
  const m = CUSTOM_KEY_RE.exec(value);
  const hit = m ? list.find((e) => e.name === m[1]) : EMOJI_FILE_RE.test(value) ? { name: "", url: value } : undefined;
  if (!hit) return <>{value}</>;
  return <img className="nt-cemoji" src={hit.url} alt={m ? value : ""} title={m ? value : undefined} width={size} height={size} draggable={false} />;
}

/**
 * The picker's "Custom" section: the workspace's emoji and, for editors,
 * "Add emoji" (an image and a name). `as`: what a pick gives — the image
 * (page and callout icons) or ":name:" (reactions).
 */
export function CustomEmojiSection({ query, onPick, as = "url" }: { query: string; onPick: (v: string) => void; as?: "url" | "name" }) {
  const ctx = useNotesMaybe();
  const locale = ctx?.locale ?? "en";
  const t = (k: NotesKey, vars?: Record<string, string | number>) => notesT(locale, k, vars);
  const list = useCustomEmoji();
  const [adding, setAdding] = useState(false);
  const canAdd = Boolean(ctx?.user) && !ctx?.readOnly;
  const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
  const shown = q ? list.filter((e) => e.name.includes(q)) : list;
  if (!shown.length && !canAdd) return null;
  if (q && !shown.length) return null;
  return (
    <>
      <div className="nt-emoji-cat nt-emoji-cat-custom">
        <span>{t("cemoji.title")}</span>
        {canAdd && !q && (
          <button type="button" className="nt-cemoji-add nt-btn-reset" onClick={() => setAdding((v) => !v)}>
            <Plus size={14} />
            {t("cemoji.add")}
          </button>
        )}
      </div>
      {adding && <AddEmojiForm onDone={() => setAdding(false)} />}
      {shown.length > 0 && (
        <div className="nt-emoji-cells">
          {shown.map((e) => (
            <span key={e.name} className="nt-cemoji-cellwrap">
              <button type="button" className="nt-emoji-cell nt-btn-reset" title={`:${e.name}:`} onClick={() => onPick(as === "name" ? `:${e.name}:` : e.url)}>
                <img className="nt-cemoji" src={e.url} alt={`:${e.name}:`} draggable={false} />
              </button>
              {canAdd && (
                <button
                  type="button"
                  className="nt-cemoji-del nt-btn-reset"
                  aria-label={t("cemoji.remove", { name: e.name })}
                  title={t("cemoji.remove", { name: e.name })}
                  onClick={() => void removeCustomEmoji(e.name).then((ok) => !ok && toast(t("cemoji.failed")))}
                >
                  <X size={10} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function AddEmojiForm({ onDone }: { onDone: () => void }) {
  const ctx = useNotesMaybe();
  const locale = ctx?.locale ?? "en";
  const t = (k: NotesKey, vars?: Record<string, string | number>) => notesT(locale, k, vars);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = emojiName(name);
  const save = async () => {
    if (!file || !clean || !ctx) return;
    setBusy(true);
    try {
      const url = await ctx.upload(file);
      const res = await addCustomEmoji(clean, url);
      if (res.ok) onDone();
      else toast(t(res.error === "taken" ? "cemoji.taken" : res.error === "limit" ? "cemoji.limit" : "cemoji.failed", { name: clean }));
    } catch {
      // upload() reported the problem
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nt-cemoji-form">
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = "";
          setFile(f);
          if (f && !name) setName(emojiName(f.name.replace(/\.[a-z0-9]+$/i, "")));
        }}
      />
      <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={() => input.current?.click()}>
        {file ? file.name : t("cemoji.choose")}
      </button>
      <input className="nt-input" value={name} placeholder={t("cemoji.name")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" disabled={!file || !clean || busy} onClick={() => void save()}>
        {busy ? t("file.uploading") : t("cemoji.save")}
      </button>
      {clean && <div className="nt-filepanel-hint">{t("cemoji.hint", { name: clean })}</div>}
    </div>
  );
}
