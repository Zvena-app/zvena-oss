"use client";

// Notion's icon picker: Emoji tab with filter, Random and Remove, recent
// emojis first, categories below. Emoji data loads on first open.

import { useEffect, useMemo, useRef, useState } from "react";
import { Shuffle } from "lucide-react";
import { useNotes } from "./context";
import { ICON_COLORS, NoteIcon } from "./NoteIcon";
import { iconsPart } from "./lazy";
import { CustomEmojiSection } from "./custom-emoji";
import type { NotesKey } from "@/lib/notes/i18n";

interface EmojiData {
  categories: { id: string; emojis: string[] }[];
  emojis: Record<string, { id: string; name: string; keywords: string[]; skins: { native: string }[] }>;
}

let dataPromise: Promise<EmojiData> | null = null;
function loadData(): Promise<EmojiData> {
  dataPromise ??= import("@emoji-mart/data").then((m) => (m.default ?? m) as unknown as EmojiData);
  return dataPromise;
}

const RECENT_KEY = "nt-emoji-recent";

function recentList(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 24) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(e: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentList().filter((x) => x !== e)].slice(0, 24)));
  } catch {
    // Private mode: no recents.
  }
}

const CAT_KEYS: Record<string, NotesKey> = {
  people: "emoji.people",
  nature: "emoji.nature",
  foods: "emoji.foods",
  activity: "emoji.activity",
  places: "emoji.places",
  objects: "emoji.objects",
  symbols: "emoji.symbols",
  flags: "emoji.flags",
};

/** A few Russian search words for the most used emojis (emoji-mart is English-only). */
const RU_WORDS: Record<string, string> = {
  "😀": "улыбка смех радость",
  "😂": "смех слёзы",
  "❤️": "сердце любовь",
  "👍": "лайк класс да",
  "🔥": "огонь",
  "✅": "галочка готово сделано",
  "📝": "заметка запись",
  "📚": "книги учёба",
  "📅": "календарь дата",
  "💡": "идея лампа",
  "🚀": "ракета запуск",
  "⭐": "звезда",
  "🎯": "цель",
  "📌": "булавка закреп",
  "🏠": "дом главная",
  "💼": "работа портфель",
  "📊": "график статистика",
  "🗂️": "папки разделители",
  "✏️": "карандаш",
  "🧠": "мозг",
  "🎉": "праздник",
  "⚠️": "внимание предупреждение",
  "❗": "важно",
  "❓": "вопрос",
  "💰": "деньги",
  "🛒": "покупки корзина",
  "🍎": "яблоко еда",
  "☕": "кофе",
  "🏃": "бег спорт",
  "✈️": "самолёт путешествие",
  "🎵": "музыка",
  "📷": "фото камера",
  "💻": "компьютер ноутбук",
  "📱": "телефон",
  "🔒": "замок закрыто",
  "🔑": "ключ",
  "📖": "книга чтение",
  "🗓️": "календарь",
  "🧾": "чек",
  "📈": "рост",
  "📉": "падение",
  "🤝": "сделка встреча",
  "👋": "привет",
  "🌍": "мир земля",
  "☀️": "солнце",
  "🌙": "луна ночь",
  "🎓": "выпуск учёба",
  "🧪": "химия опыт",
  "🧩": "пазл",
  "🛠️": "инструменты",
  "⚙️": "настройки шестерёнка",
  "🐞": "баг ошибка",
  "🏆": "кубок победа",
  "💪": "сила",
  "🙏": "спасибо",
};

const ICON_POOL = ["📝", "📄", "📘", "📗", "📕", "📒", "💡", "🚀", "🎯", "📌", "🗂️", "📊", "🧠", "✨", "🌱", "🔥", "⭐", "🎨", "🧩", "📚", "🏠", "💼", "🗓️", "✅", "🔖", "🌈", "🍀", "🪴", "🧭", "🛠️"];

export function randomIcon(): string {
  return ICON_POOL[Math.floor(Math.random() * ICON_POOL.length)];
}

/** Notion's Icons tab: monochrome icons in a colour. */
function IconsTab({ onPick }: { onPick: (icon: string) => void }) {
  const { t } = useNotes();
  const [q, setQ] = useState("");
  const [color, setColor] = useState<string>(() => {
    try {
      return localStorage.getItem("nt-icon-color") || "default";
    } catch {
      return "default";
    }
  });
  // The icon set loads with this tab (an empty grid for that moment).
  const set = iconsPart.use();
  const names = set ? Object.keys(set.ICONS).filter((n) => !q.trim() || n.includes(q.trim().toLowerCase())) : [];
  return (
    <>
      <div className="nt-emoji-bar">
        <input className="nt-input" autoFocus placeholder={t("emoji.searchIcons")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="nt-icon-colors" role="radiogroup" aria-label={t("button.color")}>
        {ICON_COLORS.map((c) => (
          <button
            type="button"
            key={c}
            role="radio"
            aria-checked={color === c}
            className="nt-icon-color nt-btn-reset"
            style={{ background: c === "default" ? "var(--nt-text-2)" : `var(--nt-c-${c})` }}
            title={t(`color.${c}` as never)}
            onClick={() => {
              setColor(c);
              try {
                localStorage.setItem("nt-icon-color", c);
              } catch {
                // Private mode: the colour is not remembered.
              }
            }}
          />
        ))}
      </div>
      <div className="nt-emoji-grid">
        <div className="nt-emoji-cells">
          {names.map((n) => (
            <button type="button" key={n} className="nt-emoji-cell nt-icon-cell nt-btn-reset" title={n} onClick={() => onPick(`icon:${n}:${color}`)}>
              <NoteIcon icon={`icon:${n}:${color}`} />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** Notion's Upload tab: an image as the icon. */
function UploadTab({ onPick }: { onPick: (icon: string) => void }) {
  const { t, upload } = useNotes();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="nt-icon-upload">
      <button type="button" className="nt-btn nt-btn-reset" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "…" : t("emoji.uploadBtn")}
      </button>
      <p>{t("emoji.uploadHint")}</p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setBusy(true);
          try {
            const url = await upload(f);
            if (url.startsWith("/api/notes/file/")) onPick(url);
          } catch {
            // The upload toast already said why.
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

/** `customAs`: a custom emoji picks as its image (icons) or as ":name:" (reactions). */
export function EmojiPicker({ onPick, onRemove, customAs = "url" }: { onPick: (emoji: string) => void; onRemove?: () => void; customAs?: "url" | "name" }) {
  const { t } = useNotes();
  const [tab, setTab] = useState<"emoji" | "icons" | "upload">("emoji");
  const [data, setData] = useState<EmojiData | null>(null);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void loadData().then(
      (d) => {
        if (live) setData(d);
      },
      () => {
        // Offline: the next open tries again (Icons and Upload still work).
        dataPromise = null;
      }
    );
    input.current?.focus();
    return () => {
      live = false;
    };
  }, []);
  const recent = useMemo(() => recentList(), []);
  const pick = (e: string) => {
    rememberEmoji(e);
    onPick(e);
  };
  const filtered = useMemo(() => {
    if (!data || !q.trim()) return null;
    const needle = q.trim().toLowerCase();
    const out: string[] = [];
    for (const [native, words] of Object.entries(RU_WORDS)) if (words.includes(needle)) out.push(native);
    for (const e of Object.values(data.emojis)) {
      if (out.length > 300) break;
      if (e.id.includes(needle) || e.name.toLowerCase().includes(needle) || e.keywords.some((k) => k.includes(needle))) {
        const n = e.skins[0]?.native;
        if (n && !out.includes(n)) out.push(n);
      }
    }
    return out;
  }, [data, q]);

  return (
    <div className="nt-emoji">
      <div className="nt-emoji-tabs">
        <button type="button" className="nt-emoji-tab nt-btn-reset" data-active={tab === "emoji" || undefined} onClick={() => setTab("emoji")}>
          {t("emoji.tabEmoji")}
        </button>
        <button type="button" className="nt-emoji-tab nt-btn-reset" data-active={tab === "icons" || undefined} onClick={() => setTab("icons")}>
          {t("emoji.tabIcons")}
        </button>
        <button type="button" className="nt-emoji-tab nt-btn-reset" data-active={tab === "upload" || undefined} onClick={() => setTab("upload")}>
          {t("emoji.tabUpload")}
        </button>
        <span className="nt-emoji-tab-spacer" />
        {onRemove && (
          <button type="button" className="nt-emoji-tab nt-btn-reset" onClick={onRemove}>
            {t("emoji.remove")}
          </button>
        )}
      </div>
      {tab === "icons" && <IconsTab onPick={onPick} />}
      {tab === "upload" && <UploadTab onPick={onPick} />}
      {tab === "emoji" && (
      <>
      <div className="nt-emoji-bar">
        <input ref={input} className="nt-input" placeholder={t("emoji.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" title={t("emoji.random")} aria-label={t("emoji.random")} onClick={() => pick(randomIcon())}>
          <Shuffle size={16} />
        </button>
      </div>
      <div className="nt-emoji-grid">
        <CustomEmojiSection query={q} onPick={onPick} as={customAs} />
        {!data && <div className="nt-emoji-cat">…</div>}
        {filtered ? (
          <div className="nt-emoji-cells">
            {filtered.map((e) => (
              <button type="button" key={e} className="nt-emoji-cell nt-btn-reset" onClick={() => pick(e)}>
                {e}
              </button>
            ))}
          </div>
        ) : (
          data && (
            <>
              {recent.length > 0 && (
                <>
                  <div className="nt-emoji-cat">{t("emoji.recent")}</div>
                  <div className="nt-emoji-cells">
                    {recent.map((e) => (
                      <button type="button" key={`r${e}`} className="nt-emoji-cell nt-btn-reset" onClick={() => pick(e)}>
                        {e}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {data.categories.map((c) => (
                <div key={c.id}>
                  <div className="nt-emoji-cat">{CAT_KEYS[c.id] ? t(CAT_KEYS[c.id]) : c.id}</div>
                  <div className="nt-emoji-cells">
                    {c.emojis.map((id) => {
                      const n = data.emojis[id]?.skins[0]?.native;
                      if (!n) return null;
                      return (
                        <button type="button" key={id} className="nt-emoji-cell nt-btn-reset" title={data.emojis[id].name} onClick={() => pick(n)}>
                          {n}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )
        )}
      </div>
      </>
      )}
    </div>
  );
}
