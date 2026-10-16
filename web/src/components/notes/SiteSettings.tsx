"use client";

// Notion Sites, in the Publish tab: the 28-day views chart, "Link expires",
// and the Site settings dialog (theme, breadcrumbs, outline, SEO title and
// description, social image). Saving republishes the page with them.

import { useMemo, useRef, useState } from "react";
import { ImageUp } from "lucide-react";
import { useNotes } from "./context";
import { Modal, toast } from "./ui";
import { firstImage } from "@/lib/notes/db";
import { SEO_DESCRIPTION_MAX, SEO_TITLE_MAX, SITE_IMAGE_RE, siteExpired, type SiteOptions } from "@/lib/notes/sites";
import type { Note } from "@/lib/notes/types";
import { intlOf } from "@/i18n/locales";

/** The site settings kept on a note's share (everything but its id, key and time). */
export function siteOptionsOf(share: Note["share"]): SiteOptions {
  if (!share) return {};
  const { id: _i, key: _k, at: _a, ...o } = share;
  void _i;
  void _k;
  void _a;
  return o;
}

/** Views per day as bars (Notion's page analytics in the Publish tab). */
export function ViewsSparkline({ days }: { days: { day: string; n: number }[] }) {
  const { t } = useNotes();
  const max = Math.max(1, ...days.map((d) => d.n));
  const total = days.reduce((s, d) => s + d.n, 0);
  if (!days.length) return null;
  return (
    <div className="nt-site-views" title={t("site.views28")}>
      <div className="nt-site-views-head">
        <span>{t("site.views28")}</span>
        <b>{total}</b>
      </div>
      <svg viewBox={`0 0 ${days.length * 6} 28`} preserveAspectRatio="none" role="img" aria-label={`${t("site.views28")}: ${total}`}>
        {days.map((d, i) => {
          const h = Math.max(d.n ? 2 : 0.5, (d.n / max) * 28);
          return (
            <rect key={d.day} x={i * 6 + 0.5} y={28 - h} width={5} height={h} rx={1}>
              <title>{`${d.day}: ${d.n}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

const EXPIRY_DAYS = [0, 1, 7, 30] as const;

/** "Link expires": never, or in 1 / 7 / 30 days (the current date is shown when set). */
export function ExpiryRow({ options, busy, onChange }: { options: SiteOptions; busy: boolean; onChange: (expiresAt: number | undefined) => void }) {
  const { t, locale } = useNotes();
  const at = options.expiresAt;
  const when = at ? new Date(at).toLocaleDateString(intlOf(locale), { dateStyle: "medium" }) : "";
  return (
    <label className="nt-share-opt">
      <span>
        <b>{t("site.expires")}</b>
        {at && <small>{siteExpired(options) ? t("site.expired", { when }) : t("site.expiresOn", { when })}</small>}
      </span>
      <select
        className="nt-input nt-site-select"
        disabled={busy}
        value=""
        onChange={(e) => {
          const d = Number(e.target.value);
          onChange(d ? Date.now() + d * 86_400_000 : undefined);
        }}
      >
        <option value="" disabled hidden>
          {at ? when : t("site.expiresNever")}
        </option>
        {EXPIRY_DAYS.map((d) => (
          <option key={d} value={d}>
            {d ? t(`site.expires${d}` as "site.expires1") : t("site.expiresNever")}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Images of the page that can be its social image (uploads only: no third-party host). */
function pageImages(note: Note): string[] {
  const out = new Set<string>();
  if (note.cover?.kind === "image" && SITE_IMAGE_RE.test(note.cover.value)) out.add(note.cover.value);
  const walk = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const raw of blocks) {
      const b = raw as { type?: string; props?: { url?: unknown }; children?: unknown };
      if (b?.type === "image" && typeof b.props?.url === "string" && SITE_IMAGE_RE.test(b.props.url)) out.add(b.props.url);
      walk(b?.children);
    }
  };
  walk(note.content);
  const first = firstImage(note.content);
  if (SITE_IMAGE_RE.test(first)) out.add(first);
  return [...out].slice(0, 12);
}

const THEMES = [undefined, "light", "dark"] as const;

export function SiteSettingsDialog({ note, options, onSave, onClose }: { note: Note; options: SiteOptions; onSave: (o: SiteOptions) => Promise<boolean>; onClose: () => void }) {
  const { t, upload } = useNotes();
  const [o, setO] = useState<SiteOptions>(options);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const images = useMemo(() => {
    const list = pageImages(note);
    return o.image && !list.includes(o.image) ? [o.image, ...list] : list;
  }, [note, o.image]);
  const set = (patch: Partial<SiteOptions>) => setO((cur) => ({ ...cur, ...patch }));
  const save = async () => {
    setBusy(true);
    const ok = await onSave({ ...o, seoTitle: o.seoTitle?.trim() || undefined, seoDescription: o.seoDescription?.trim() || undefined });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose} label={t("site.settings")} className="nt-site-dialog">
      <div className="nt-site">
        <h2 className="nt-site-title">{t("site.settings")}</h2>
        <section className="nt-site-section">
          <div className="nt-share-opt">
            <span>
              <b>{t("site.theme")}</b>
            </span>
            <div className="nt-seg" role="radiogroup" aria-label={t("site.theme")}>
              {THEMES.map((th) => (
                <button key={th ?? "auto"} type="button" role="radio" aria-checked={o.theme === th} className="nt-seg-btn nt-btn-reset" data-active={o.theme === th || undefined} onClick={() => set({ theme: th })}>
                  {th === "light" ? t("site.themeLight") : th === "dark" ? t("site.themeDark") : t("site.themeAuto")}
                </button>
              ))}
            </div>
          </div>
          <label className="nt-share-opt">
            <span>
              <b>{t("site.crumbs")}</b>
            </span>
            <button type="button" role="switch" aria-checked={!o.noCrumbs} className="nt-switch nt-btn-reset" onClick={() => set({ noCrumbs: o.noCrumbs ? undefined : true })}>
              <span />
            </button>
          </label>
          <label className="nt-share-opt">
            <span>
              <b>{t("site.outline")}</b>
            </span>
            <button type="button" role="switch" aria-checked={!!o.outline} className="nt-switch nt-btn-reset" onClick={() => set({ outline: o.outline ? undefined : true })}>
              <span />
            </button>
          </label>
        </section>
        <section className="nt-site-section">
          <div className="nt-menu-label">{t("site.seo")}</div>
          <label className="nt-site-field">
            <span>{t("site.seoTitle")}</span>
            <input className="nt-input" maxLength={SEO_TITLE_MAX} value={o.seoTitle ?? ""} placeholder={note.title} onChange={(e) => set({ seoTitle: e.target.value })} />
            <small>{t("site.seoTitleHint")}</small>
          </label>
          <label className="nt-site-field">
            <span>{t("site.seoDescription")}</span>
            <textarea className="nt-input" rows={3} maxLength={SEO_DESCRIPTION_MAX} value={o.seoDescription ?? ""} onChange={(e) => set({ seoDescription: e.target.value })} />
            <small>
              {(o.seoDescription ?? "").length}/{SEO_DESCRIPTION_MAX}
            </small>
          </label>
          <div className="nt-site-field">
            <span>{t("site.image")}</span>
            <div className="nt-site-images">
              <button type="button" className="nt-site-image nt-btn-reset" data-active={!o.image || undefined} onClick={() => set({ image: undefined })}>
                {t("site.imageNone")}
              </button>
              {images.map((src) => (
                <button key={src} type="button" className="nt-site-image nt-btn-reset" data-active={o.image === src || undefined} onClick={() => set({ image: src })}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" />
                </button>
              ))}
              <button type="button" className="nt-site-image nt-btn-reset" onClick={() => file.current?.click()}>
                <ImageUp size={16} />
                {t("site.imageUpload")}
              </button>
              <input
                ref={file}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    const url = await upload(f);
                    if (SITE_IMAGE_RE.test(url)) set({ image: url });
                    else toast(t("toast.uploadFailed"));
                  } catch {
                    toast(t("toast.uploadFailed"));
                  }
                }}
              />
            </div>
          </div>
        </section>
        <div className="nt-share-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="nt-btn nt-btn-plain nt-btn-sm nt-btn-reset" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="nt-btn nt-btn-primary nt-btn-sm nt-btn-reset" disabled={busy} onClick={() => void save()}>
            {t("site.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
