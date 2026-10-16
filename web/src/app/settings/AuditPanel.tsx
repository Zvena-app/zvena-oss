"use client";

// Settings → Audit log (Notion's): the workspace's security events, newest
// first, each as a short sentence ("Shared a page with someone"), filtered by
// person, kind of event and period, and exported as CSV with the same filters
// (app/api/ws/audit).

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { intlTag } from "@/i18n/locales";
import type { AuditEntry } from "@/lib/enterprise/audit-log";
import { api } from "./parts";

/** Kinds of events, by the action's prefix (the filter's choices). */
const FAMILIES: { key: string; prefixes: string[] }[] = [
  { key: "workspace", prefixes: ["workspace."] },
  { key: "member", prefixes: ["member.", "guest."] },
  { key: "invite", prefixes: ["invite."] },
  { key: "page", prefixes: ["page."] },
  { key: "account", prefixes: ["signin", "signup", "identity-linked", "sessions.", "consent"] },
  { key: "security", prefixes: ["security."] },
  { key: "sso", prefixes: ["sso."] },
  { key: "scim", prefixes: ["scim."] },
  { key: "domain", prefixes: ["domain."] },
  { key: "site", prefixes: ["site."] },
  { key: "group", prefixes: ["group."] },
  { key: "teamspace", prefixes: ["teamspace."] },
  { key: "integration", prefixes: ["integration."] },
  { key: "projects", prefixes: ["projects."] },
  { key: "export", prefixes: ["data.export", "export.", "audit.export"] },
];

export function familyOf(action: string): string {
  return FAMILIES.find((f) => f.prefixes.some((p) => action === p || action.startsWith(p)))?.key ?? "other";
}

/** The filter sent to the server: the family's actions and prefixes. */
function filterOf(family: string): string | null {
  return FAMILIES.find((x) => x.key === family)?.prefixes.join(",") ?? null;
}

/** The periods offered (Notion's "Date" filter); "custom" shows two dates. */
const RANGES = [
  { key: "all", days: 0 },
  { key: "1d", days: 1 },
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
  { key: "custom", days: 0 },
] as const;
type Range = (typeof RANGES)[number]["key"];

const details = (e: AuditEntry): string => {
  const m = { ...(e.meta ?? {}) };
  delete m.user;
  const parts = Object.entries(m).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return [e.subjectName ? `→ ${e.subjectName}` : "", ...parts].filter(Boolean).join(" · ");
};

export function AuditPanel({ ws, people }: { ws: string; people: { id: string; name: string }[] }) {
  const { t, locale } = useI18n();
  const [actor, setActor] = useState("");
  const [family, setFamily] = useState("");
  const [range, setRange] = useState<Range>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const params = useCallback(
    (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({ ws });
      if (actor) p.set("actor", actor);
      const f = filterOf(family);
      if (f) p.set("action", f);
      const days = RANGES.find((x) => x.key === range)?.days ?? 0;
      if (days) p.set("from", String(Date.now() - days * 86_400_000));
      if (range === "custom" && from) p.set("from", String(new Date(`${from}T00:00:00`).getTime()));
      if (range === "custom" && to) p.set("to", String(new Date(`${to}T23:59:59.999`).getTime()));
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      return p.toString();
    },
    [ws, actor, family, range, from, to]
  );

  const load = useCallback(
    async (before?: number) => {
      setBusy(true);
      setFailed(false);
      const r = await api<{ entries: AuditEntry[]; more: boolean }>("GET", `/api/ws/audit?${params(before ? { before: String(before) } : {})}`);
      if (r.ok) {
        setRows((prev) => [...(before ? prev : []), ...r.data.entries]);
        setMore(r.data.more);
      } else setFailed(true);
      setBusy(false);
    },
    [params]
  );

  useEffect(() => {
    // The first page, and again whenever a filter changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const fmt = (ms: number) => new Date(ms).toLocaleString(intlTag(locale), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const last = rows[rows.length - 1];
  const tk = (k: string) => t(k as Parameters<typeof t>[0]);
  const category = (action: string) => tk(`settings.audit.cat.${familyOf(action)}`);
  /** The event as a sentence; one zvena has no words for yet shows its kind. */
  const sentence = (action: string) => {
    const k = `settings.audit.ev.${action}`;
    const s = tk(k);
    return s === k ? category(action) : s;
  };

  return (
    <>
      <div className="zst-filters">
        <label className="zst-field">
          <span className="zst-label">{t("settings.audit.person")}</span>
          <select className="zst-select" value={actor} onChange={(e) => setActor(e.target.value)} data-test="audit-person">
            <option value="">{t("settings.audit.anyone")}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="zst-field">
          <span className="zst-label">{t("settings.audit.action")}</span>
          <select className="zst-select" value={family} onChange={(e) => setFamily(e.target.value)} data-test="audit-family">
            <option value="">{t("settings.audit.anyAction")}</option>
            {FAMILIES.map((f) => (
              <option key={f.key} value={f.key}>
                {tk(`settings.audit.cat.${f.key}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="zst-field">
          <span className="zst-label">{t("settings.audit.range")}</span>
          <select className="zst-select" value={range} onChange={(e) => setRange(e.target.value as Range)} data-test="audit-range">
            {RANGES.map((x) => (
              <option key={x.key} value={x.key}>
                {tk(`settings.audit.range.${x.key}`)}
              </option>
            ))}
          </select>
        </label>
        {range === "custom" && (
          <>
            <label className="zst-field">
              <span className="zst-label">{t("settings.audit.from")}</span>
              <input className="zst-input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="zst-field">
              <span className="zst-label">{t("settings.audit.to")}</span>
              <input className="zst-input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        <a className="zst-btn" href={`/api/ws/audit?${params({ format: "csv" })}`} download data-test="audit-csv">
          <Download />
          {t("settings.audit.export")}
        </a>
      </div>
      {failed && <p className="zst-error" role="alert">{t("common.error")}</p>}
      <div className="zst-table-wrap">
        <table className="zst-table" data-test="audit-table">
          <thead>
            <tr>
              <th>{t("settings.audit.time")}</th>
              <th>{t("settings.audit.person")}</th>
              <th>{t("settings.audit.action")}</th>
              <th>{t("settings.audit.details")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="zst-nowrap">{fmt(e.at)}</td>
                <td>{e.actorName || (e.actor ? e.actor : t("settings.audit.system"))}</td>
                <td title={e.action} data-action={e.action}>
                  <div>{sentence(e.action)}</div>
                  <div className="zst-muted">{category(e.action)}</div>
                </td>
                <td style={{ overflowWrap: "anywhere" }}>{details(e)}</td>
              </tr>
            ))}
            {rows.length === 0 && !busy && (
              <tr>
                <td colSpan={4} className="zst-muted">
                  {t("settings.audit.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {more && last && (
        <div style={{ paddingTop: 12 }}>
          <button type="button" className="zst-btn" disabled={busy} onClick={() => void load(last.id)}>
            {t("settings.audit.more")}
          </button>
        </div>
      )}
    </>
  );
}
