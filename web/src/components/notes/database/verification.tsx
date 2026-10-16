"use client";

// Wiki verification (Notion): the Verified / Expired chip in cells, the
// Verify menu (indefinitely, 7 / 30 / 90 days, a custom day; remove), and
// the bar under a wiki page's title. Owners of the page and people with
// full access verify; the server checks the same (verification-server.ts).

import { useState } from "react";
import { BadgeCheck, CalendarDays, CircleSlash, Clock, InfinityIcon as Forever, RotateCw } from "lucide-react";
import { useNotes } from "../context";
import { Menu, Popover } from "../ui";
import { fmtDate } from "@/lib/notes/db";
import { personName } from "@/lib/notes/people";
import { UNVERIFIED, VERIFY_DAYS, canVerify, isVerification, todayYmd, untilAfter, verificationState, verifiedBy, wikiProps } from "@/lib/notes/verification";
import type { DbProperty, DbSchema, Note, PropValue } from "@/lib/notes/types";
import { useDatabase } from "./useDatabase";

/** The chip a verified or expired page shows (nothing while unverified). */
export function VerificationChip({ value, full }: { value: PropValue; /** With who and until (the page header). */ full?: boolean }) {
  const { t, locale } = useNotes();
  const state = verificationState(value);
  if (state === "unverified" && !full) return null;
  const v = isVerification(value) ? value : null;
  const label = state === "verified" ? t("verify.verified") : state === "expired" ? t("verify.expired") : t("verify.verify");
  const detail = (() => {
    if (!v || state === "unverified") return "";
    const who = personName(v.by, { unknown: t("people.unknown") });
    if (state === "expired") return t("verify.expiredOn", { date: fmtDate(v.until ?? "", locale) });
    return v.until ? t("verify.byUntil", { name: who, date: fmtDate(v.until, locale) }) : t("verify.byForever", { name: who });
  })();
  return (
    <span className="nt-verify" data-state={state} title={full ? undefined : detail || undefined}>
      {state === "unverified" ? <BadgeCheck /> : state === "expired" ? <Clock /> : <BadgeCheck />}
      <span>{label}</span>
      {full && detail && <span className="nt-verify-detail">{detail}</span>}
    </span>
  );
}

/** Notion's Verify menu for one page. */
export function VerificationEditor({ row, prop, schema, anchor, onClose, onValue }: { row: Note; prop: DbProperty; schema: DbSchema | undefined; anchor: HTMLElement | null; onClose: () => void; onValue: (v: PropValue) => void }) {
  const api = useNotes();
  const { t, locale } = api;
  const [custom, setCustom] = useState(false);
  const me = api.user?.id ?? "";
  const value = row.props?.[prop.id] ?? null;
  const state = verificationState(value);
  const allowed = Boolean(me) && canVerify(me, api.levelOf(row.id) === "full", row, schema);
  const set = (until: number | string | null) => {
    onValue(verifiedBy(me, until));
    onClose();
  };
  if (!anchor) return null;
  const verb = state === "unverified" ? "" : t("verify.reverify");
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <Menu
        width={280}
        header={
          <div className="nt-verify-head">
            <VerificationChip value={value} full />
            {!allowed && <p className="nt-settings-hint">{t("verify.who")}</p>}
          </div>
        }
        groups={
          allowed
            ? [
                {
                  key: "for",
                  label: verb || t("verify.header"),
                  items: [
                    { key: "forever", label: t("verify.indefinitely"), icon: <Forever />, onSelect: () => set(null) },
                    ...VERIFY_DAYS.map((n) => ({ key: `d${n}`, label: t("verify.forDays", { n }), icon: <RotateCw />, hint: fmtDate(untilAfter(n), locale), onSelect: () => set(n) })),
                    { key: "custom", label: t("verify.custom"), icon: <CalendarDays />, onSelect: () => setCustom(true) },
                  ],
                },
                ...(state !== "unverified" || isVerification(value)
                  ? [{ key: "remove", items: [{ key: "remove", label: t("verify.remove"), icon: <CircleSlash />, danger: true, onSelect: () => (onValue(UNVERIFIED), onClose()) }] }]
                  : []),
              ]
            : []
        }
        footer={
          allowed && custom ? (
            <div className="nt-verify-custom">
              <input className="nt-input" type="date" autoFocus aria-label={t("verify.custom")} min={todayYmd()} onChange={(e) => e.target.value && e.target.value >= todayYmd() && set(e.target.value)} />
            </div>
          ) : undefined
        }
      />
    </Popover>
  );
}

/** Under a wiki page's title: its verification, and the Verify menu (Notion's page header). */
export function VerifyBar({ row, readOnly }: { row: Note; readOnly?: boolean }) {
  const ctl = useDatabase(row.parentId as string);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const w = wikiProps(ctl.schema);
  if (!w?.verification) return null;
  const prop = w.verification;
  const shown = ctl.allRows.find((r) => r.id === row.id) ?? row;
  const value = shown.props?.[prop.id] ?? null;
  const frozen = readOnly || row.trashedAt !== null || !ctl.api.canEdit(row.id) || prop.denied !== undefined;
  return (
    <div className="nt-page-verify">
      <button type="button" className="nt-btn-reset nt-verify-btn" aria-haspopup="menu" disabled={frozen && verificationState(value) === "unverified"} onClick={(e) => !frozen && setMenu(e.currentTarget)}>
        <VerificationChip value={value} full />
      </button>
      {menu && <VerificationEditor row={shown} prop={prop} schema={ctl.schema} anchor={menu} onClose={() => setMenu(null)} onValue={(v) => ctl.setValue(ctl.api.store.get(row.id) ?? row, prop, v)} />}
    </div>
  );
}
