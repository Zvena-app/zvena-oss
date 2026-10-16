"use client";

// Share (design system: one Share button in every doc, project and design).
// One dialog: invite by e-mail with a role, copy an invite link, see who is
// here. In a personal workspace it offers to start a team in one click
// instead, since a personal workspace cannot be shared.
//
//   <ShareButton ws={ws.id} what="Launch plan" />

import { useEffect, useId, useRef, useState } from "react";
import { Check, Link2, Share2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { dt, type DsKey } from "./i18n";
import { toast } from "./toast-store";
import "./ds.css";

type Role = "owner" | "editor" | "commenter" | "viewer";
type ShareRole = Exclude<Role, "owner">;
interface Member {
  userId: string;
  name: string;
  role: Role;
}
interface Info {
  workspace: { id: string; name: string; personal: boolean };
  role: Role;
  /** An editor allowed to invite (the server's word: lib/enterprise/security.ts canInvite). */
  canInvite?: boolean;
  members: Member[];
  /** Letters can leave this server; off: invitations are links the inviter passes on. */
  mailOn?: boolean;
}
type Result = { email: string; status: "sent" | "queued" | "failed" | "member" | "link"; link?: string };

const ROLE_KEY: Record<Role, DsKey> = { owner: "roleOwner", editor: "roleEditor", commenter: "roleCommenter", viewer: "roleViewer" };
// The role picker names the role (short, so the address field keeps its width).
const CAN_KEY: Record<ShareRole, DsKey> = { editor: "roleEditor", commenter: "roleCommenter", viewer: "roleViewer" };
const RESULT_KEY: Record<Result["status"], DsKey> = { sent: "shareSent", queued: "shareQueued", failed: "shareFailed", member: "shareMember", link: "shareByLink" };

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });

export function ShareButton({ ws, what, me, label }: { ws: string; what?: string; me?: string; label?: string }) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="zv-btn zv-btn-primary zv-btn-sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Share2 size={14} aria-hidden />
        {label ?? dt(locale, "share")}
      </button>
      {open && <ShareDialog ws={ws} what={what} me={me} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ShareDialog({ ws, what, me, onClose }: { ws: string; what?: string; me?: string; onClose: () => void }) {
  const { locale } = useI18n();
  const t = (k: DsKey, v?: Record<string, string | number>) => dt(locale, k, v);
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState(false);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<ShareRole>("editor");
  const [linkRole, setLinkRole] = useState<ShareRole>("editor");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [bad, setBad] = useState<string[]>([]);
  const [team, setTeam] = useState(() => dt(locale, "shareTeamDefault", { name: (me ?? "").trim().split(/\s+/)[0] || "zvena" }));

  useEffect(() => {
    let live = true;
    fetch(`/api/ws/share?ws=${encodeURIComponent(ws)}`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Info>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => live && setInfo(j))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [ws]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const invite = async () => {
    if (!emails.trim() || busy) return;
    setBusy(true);
    try {
      const r = await post(`/api/ws/share?ws=${encodeURIComponent(ws)}`, { emails, role, what });
      const j = (await r.json()) as { results?: Result[]; bad?: string[]; error?: string };
      setResults(j.results ?? []);
      setBad(j.bad ?? []);
      if (r.ok && (j.results ?? []).every((x) => x.status !== "failed")) setEmails("");
      if (!r.ok && !(j.bad ?? []).length) setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      const r = await post(`/api/ws/invites?ws=${encodeURIComponent(ws)}`, { role: linkRole });
      if (!r.ok) throw new Error(String(r.status));
      const { url } = (await r.json()) as { url: string };
      await navigator.clipboard.writeText(url).catch(() => {
        window.prompt(t("shareLink"), url);
      });
      toast(t("shareCopied"), { kind: "success" });
    } catch {
      toast(t("failed"), { kind: "error" });
    }
  };

  const startTeam = async () => {
    if (!team.trim() || busy) return;
    setBusy(true);
    try {
      const r = await post("/api/ws", { name: team.trim() });
      if (!r.ok) throw new Error(String(r.status));
      const { workspace } = (await r.json()) as { workspace: { id: string } };
      // Open the same section in the new team workspace, with Share open there.
      const u = new URL(location.href);
      u.searchParams.set("ws", workspace.id);
      u.searchParams.set("share", "1");
      location.href = u.toString();
    } catch {
      setBusy(false);
      setError(true);
    }
  };

  // Owners invite; editors too when the owner allows members to invite (Settings → Security).
  const owner = info?.role === "owner" || info?.canInvite === true;
  return (
    <div className="ds-share-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="ds-share" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="ds-share-head">
          <div>
            <h2 id={titleId} className="ds-share-title">
              {what ? `${t("shareTitle")} «${what}»` : t("shareTitle")}
            </h2>
            {info && <p className="ds-share-sub">{t("shareIn", { ws: info.workspace.name })}</p>}
          </div>
          <button type="button" className="ds-icon-btn" aria-label={t("close")} onClick={onClose}>
            <X aria-hidden />
          </button>
        </div>

        {error && <p className="ds-share-error">{t("failed")}</p>}
        {!info && !error && <div className="ds-share-skeleton" aria-hidden />}

        {info?.workspace.personal && (
          <div className="ds-share-block">
            <p className="ds-share-text">{t("sharePersonal")}</p>
            <form
              className="ds-share-row"
              onSubmit={(e) => {
                e.preventDefault();
                void startTeam();
              }}
            >
              <input className="zv-input" aria-label={t("shareTeamName")} value={team} onChange={(e) => setTeam(e.target.value)} maxLength={80} autoFocus />
              <button type="submit" className="zv-btn zv-btn-primary" disabled={busy || !team.trim()}>
                {t("shareStartTeam")}
              </button>
            </form>
          </div>
        )}

        {info && !info.workspace.personal && owner && (
          <>
            {info.mailOn === false && <p className="ds-share-text" role="note">{t("shareNoMail")}</p>}
            <form
              className="ds-share-row"
              onSubmit={(e) => {
                e.preventDefault();
                void invite();
              }}
            >
              <input
                className="zv-input"
                type="text"
                inputMode="email"
                autoComplete="email"
                placeholder={t("shareEmails")}
                aria-label={t("shareEmails")}
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                autoFocus
              />
              <select className="zv-select" aria-label={t("roleEditor")} value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
                {(Object.keys(CAN_KEY) as ShareRole[]).map((r) => (
                  <option key={r} value={r}>
                    {t(CAN_KEY[r])}
                  </option>
                ))}
              </select>
              <button type="submit" className="zv-btn zv-btn-primary" disabled={busy || !emails.trim()}>
                {info.mailOn === false ? t("shareMakeLinks") : t("shareInvite")}
              </button>
            </form>
            {(results.length > 0 || bad.length > 0) && (
              <ul className="ds-share-results" aria-live="polite">
                {results.map((r) => (
                  <li key={r.email} data-status={r.status}>
                    {r.status === "sent" || r.status === "member" ? <Check size={14} aria-hidden /> : null}
                    {t(RESULT_KEY[r.status], { email: r.email })}
                    {r.status === "link" && r.link && (
                      <button
                        type="button"
                        className="zv-btn zv-btn-sm"
                        onClick={() =>
                          void navigator.clipboard.writeText(r.link as string).then(
                            () => toast(t("shareCopied"), { kind: "success" }),
                            () => window.prompt(t("shareLink"), r.link)
                          )
                        }
                      >
                        {t("shareCopy")}
                      </button>
                    )}
                  </li>
                ))}
                {bad.length > 0 && <li data-status="failed">{t("shareBad", { list: bad.join(", ") })}</li>}
              </ul>
            )}
            <div className="ds-share-row ds-share-link">
              <Link2 size={16} aria-hidden />
              <span className="ds-share-link-label">{t("shareLink")}</span>
              <select className="zv-select" aria-label={t("shareLink")} value={linkRole} onChange={(e) => setLinkRole(e.target.value as ShareRole)}>
                {(Object.keys(CAN_KEY) as ShareRole[]).map((r) => (
                  <option key={r} value={r}>
                    {t(CAN_KEY[r])}
                  </option>
                ))}
              </select>
              <button type="button" className="zv-btn" onClick={() => void copyLink()}>
                {t("shareCopy")}
              </button>
            </div>
          </>
        )}

        {info && !info.workspace.personal && !owner && <p className="ds-share-text">{t("shareOwnerOnly")}</p>}

        {info && info.members.length > 0 && !info.workspace.personal && (
          <div className="ds-share-block">
            <div className="ds-share-label">{t("sharePeople")}</div>
            <ul className="ds-share-people">
              {info.members.map((m) => (
                <li key={m.userId}>
                  <span className="zv-avatar">{(m.name.trim().charAt(0) || "?").toUpperCase()}</span>
                  <span className="ds-share-name">{m.name}</span>
                  <span className="ds-share-role">{t(ROLE_KEY[m.role])}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
