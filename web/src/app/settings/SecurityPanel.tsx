"use client";

// Settings → Security (Notion's Security tab): what may leave the workspace
// and who may come in. Each switch saves at once; the server enforces them
// (lib/enterprise/security.ts).

import { useState } from "react";
import { useI18n } from "@/lib/i18n-react";
import type { SecuritySettings } from "@/lib/enterprise/security";
import { api, Row, Section, Switch } from "./parts";

type Flag = "disablePublish" | "disableGuests" | "disableExport" | "disableMoveOut" | "membersCanInvite";

export function SecurityPanel({ ws, initial, personal }: { ws: string; initial: SecuritySettings; personal: boolean }) {
  const { t } = useI18n();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const q = `/api/ws/security?ws=${encodeURIComponent(ws)}`;

  const save = async (patch: Partial<SecuritySettings>) => {
    setBusy(true);
    setError(false);
    const prev = s;
    setS({ ...s, ...patch });
    const r = await api<{ settings: SecuritySettings }>("PATCH", q, patch);
    if (r.ok) setS(r.data.settings);
    else {
      setS(prev);
      setError(true);
    }
    setBusy(false);
  };

  const flag = (key: Flag, title: string, hint: string) => (
    <Row title={title} hint={hint}>
      <Switch on={s[key]} label={title} disabled={busy} testId={`sec-${key}`} onChange={(v) => void save({ [key]: v })} />
    </Row>
  );

  return (
    <>
      {error && <p className="zst-error" role="alert">{t("common.error")}</p>}
      <Section title={t("settings.security.content")}>
        {flag("disablePublish", t("settings.security.publish"), t("settings.security.publishHint"))}
        {flag("disableGuests", t("settings.security.guests"), t("settings.security.guestsHint"))}
        {flag("disableExport", t("settings.security.export"), t("settings.security.exportHint"))}
        {flag("disableMoveOut", t("settings.security.move"), t("settings.security.moveHint"))}
      </Section>
      {!personal && (
        <Section title={t("settings.security.access")}>
          {flag("membersCanInvite", t("settings.security.invite"), t("settings.security.inviteHint"))}
          <Row title={t("settings.security.joinRole")} hint={t("settings.security.joinRoleHint")}>
            <select className="zst-select" aria-label={t("settings.security.joinRole")} value={s.joinRole} disabled={busy} onChange={(e) => void save({ joinRole: e.target.value as SecuritySettings["joinRole"] })}>
              {(["editor", "commenter", "viewer"] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`ws.role.${r}`)}
                </option>
              ))}
            </select>
          </Row>
        </Section>
      )}
    </>
  );
}
