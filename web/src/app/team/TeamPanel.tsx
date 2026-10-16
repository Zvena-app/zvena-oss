"use client";

// Team: members and roles, invite links, and the workspace itself (rename,
// hand over, delete, leave). Roles are the same in Documents and Design.

import { useState } from "react";
import { Copy, Link2, Trash2, UserMinus } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { intlTag } from "@/i18n/locales";
import type { SessionWorkspace } from "@/lib/session";
import type { Invite, Member, Role } from "@/lib/workspaces";

const INVITE_ROLES = ["editor", "commenter", "viewer"] as const;

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

/** `canInvite`: an editor may make invite links too (Settings → Security → Allow members to invite). */
export function TeamPanel({ me, ws, members, invites, inviteDays, startNew, canInvite = false }: { me: string; ws: SessionWorkspace; members: Member[]; invites: Invite[]; inviteDays: number; startNew: boolean; canInvite?: boolean }) {
  const { t, locale } = useI18n();
  const q = `?ws=${encodeURIComponent(ws.id)}`;
  const owner = ws.role === "owner";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [inviteRole, setInviteRole] = useState<(typeof INVITE_ROLES)[number]>("editor");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(ws.name);
  const roleLabel = (r: Role) => t(`ws.role.${r}`);
  const fmt = (ts: number) => new Date(ts).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short", year: "numeric" });

  const run = async (fn: () => Promise<{ ok: boolean; data: Record<string, unknown> }>, after?: (d: Record<string, unknown>) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) {
        const e = String(r.data.error ?? "");
        setError(e.startsWith("limit:") ? t("ws.limit", { what: e.slice(6) }) : t("common.error"));
        return;
      }
      after?.(r.data);
    } catch {
      setError(t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && (
        <p className="zv-banner zv-banner-error" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </p>
      )}

      <div className="zv-card" id="new">
        <h2>{t("ws.create")}</h2>
        <form
          className="zv-actions"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            void run(() => call("POST", "/api/ws", { name: newName.trim() }), (d) => {
              const id = (d.workspace as { id: string }).id;
              location.href = `/team?ws=${encodeURIComponent(id)}`;
            });
          }}
        >
          <input className="zv-input" style={{ flex: 1, minWidth: 200 }} placeholder={t("ws.name")} value={newName} autoFocus={startNew} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
          <button type="submit" className="zv-btn zv-btn-primary" disabled={busy || !newName.trim()}>
            {t("ws.create")}
          </button>
        </form>
      </div>

      {ws.personal ? (
        <div className="zv-card">
          <p className="zv-muted" style={{ margin: 0 }}>
            {t("ws.personalNote")}
          </p>
        </div>
      ) : (
        <>
          <div className="zv-card">
            <h2>{t("ws.members")}</h2>
            <div className="zv-list">
              {members.map((m) => (
                <div className="zv-row" key={m.userId}>
                  <span className="zv-avatar">{(m.name.trim().charAt(0) || "?").toUpperCase()}</span>
                  <div className="zv-row-main">
                    <div className="zv-row-title">
                      {m.name} {m.userId === me && <span className="zv-muted">({t("ws.you")})</span>}
                    </div>
                    <div className="zv-row-sub">{fmt(m.since)}</div>
                  </div>
                  {owner && m.role !== "owner" ? (
                    <>
                      <select
                        className="zv-select"
                        style={{ width: "auto" }}
                        aria-label={t("ws.inviteRole")}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) => void run(() => call("PATCH", `/api/ws/members${q}`, { userId: m.userId, role: e.target.value }), () => location.reload())}
                      >
                        {INVITE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="zv-btn zv-btn-ghost zv-btn-sm"
                        title={t("ws.transfer")}
                        aria-label={t("ws.transfer")}
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`${t("ws.transfer")}: ${m.name}?`)) void run(() => call("POST", `/api/ws/transfer${q}`, { userId: m.userId }), () => location.reload());
                        }}
                      >
                        👑
                      </button>
                      <button
                        type="button"
                        className="zv-btn zv-btn-ghost zv-btn-sm"
                        title={t("ws.remove")}
                        aria-label={t("ws.remove")}
                        disabled={busy}
                        onClick={() => void run(() => call("DELETE", `/api/ws/members${q}`, { userId: m.userId }), () => location.reload())}
                      >
                        <UserMinus size={16} />
                      </button>
                    </>
                  ) : (
                    <span className="zv-badge">{roleLabel(m.role)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {(owner || canInvite) && (
            <div className="zv-card">
              <h2>{t("ws.invite")}</h2>
              <div className="zv-actions" style={{ marginBottom: 12 }}>
                <select className="zv-select" style={{ width: "auto" }} aria-label={t("ws.inviteRole")} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as (typeof INVITE_ROLES)[number])}>
                  {INVITE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)} — {t(`ws.role.${r}.hint`)}
                    </option>
                  ))}
                </select>
                <button type="button" className="zv-btn zv-btn-primary" disabled={busy} onClick={() => void run(() => call("POST", `/api/ws/invites${q}`, { role: inviteRole }), (d) => setLink(String(d.url)))}>
                  <Link2 />
                  {t("ws.inviteCreate")}
                </button>
              </div>
              {link && (
                <div className="zv-banner" style={{ display: "grid", gap: 8 }}>
                  <div className="zv-actions">
                    <input className="zv-input" readOnly value={link} style={{ flex: 1, minWidth: 220 }} onFocus={(e) => e.target.select()} />
                    <button
                      type="button"
                      className="zv-btn"
                      onClick={() => {
                        void navigator.clipboard?.writeText(link).then(() => setCopied(true));
                      }}
                    >
                      <Copy />
                      {copied ? t("ws.inviteCopied") : t("ws.inviteCopy")}
                    </button>
                  </div>
                  <span className="zv-small">{t("ws.inviteOnce", { days: inviteDays, uses: 50 })}</span>
                </div>
              )}
              {owner && <h3 style={{ fontFamily: "var(--zv-font)", fontSize: 14, fontWeight: 600, margin: "18px 0 6px" }}>{t("ws.invites")}</h3>}
              {!owner ? null : invites.length === 0 ? (
                <p className="zv-muted zv-small" style={{ margin: 0 }}>
                  {t("ws.noInvites")}
                </p>
              ) : (
                <div className="zv-list">
                  {invites.map((i) => (
                    <div className="zv-row" key={i.id}>
                      <div className="zv-row-main">
                        <div className="zv-row-title">{roleLabel(i.role)}</div>
                        <div className="zv-row-sub">
                          {fmt(i.createdAt)} → {fmt(i.expiresAt)} · {i.uses}/{i.maxUses}
                        </div>
                      </div>
                      <button type="button" className="zv-btn zv-btn-sm" disabled={busy} onClick={() => void run(() => call("DELETE", `/api/ws/invites${q}`, { id: i.id }), () => location.reload())}>
                        {t("ws.inviteRevoke")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="zv-card">
            {owner ? (
              <>
                <h2>{t("ws.rename")}</h2>
                <form
                  className="zv-actions"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => call("PATCH", `/api/ws${q}`, { name }), () => location.reload());
                  }}
                >
                  <input className="zv-input" style={{ flex: 1, minWidth: 200 }} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label={t("ws.name")} />
                  <button type="submit" className="zv-btn" disabled={busy || !name.trim() || name === ws.name}>
                    {t("common.save")}
                  </button>
                </form>
                <div style={{ marginTop: 18 }}>
                  <button
                    type="button"
                    className="zv-btn zv-btn-danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(t("ws.deleteConfirm", { name: ws.name }))) void run(() => call("DELETE", `/api/ws${q}`), () => (location.href = "/home"));
                    }}
                  >
                    <Trash2 />
                    {t("ws.delete")}
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="zv-btn zv-btn-danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t("ws.leaveConfirm", { name: ws.name }))) void run(() => call("DELETE", `/api/ws/members${q}`, { userId: me }), () => (location.href = "/home"));
                }}
              >
                {t("ws.leave")}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
