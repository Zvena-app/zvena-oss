"use client";

// Mail before a mailbox is connected: what it does, and the services to
// connect with (Notion Mail's first screen).

import { useState } from "react";
import { Lock, Mail } from "lucide-react";
import { PRESETS, type PresetId } from "@/lib/mail-client/providers";
import { ConnectDialog } from "./Dialogs";
import { useMt } from "./i18n";

export function Welcome() {
  const { t } = useMt();
  const [preset, setPreset] = useState<PresetId | null>(null);
  return (
    <div className="zm-welcome">
      <div className="zm-welcome-art" aria-hidden>
        <Mail size={30} />
      </div>
      <h1>{t("welcome.title")}</h1>
      <p className="zm-hint">{t("welcome.lead")}</p>
      <div className="zm-providers">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="zm-provider" onClick={() => setPreset(p.id)}>
            <span className="zm-provider-mark" data-provider={p.id} aria-hidden>
              {p.id === "custom" ? "@" : p.name.charAt(0)}
            </span>
            <span>{p.id === "custom" ? t("connect.other") : p.name}</span>
          </button>
        ))}
      </div>
      <p className="zm-hint zm-hint-small">
        <Lock size={12} /> {t("connect.privacy")}
      </p>
      {preset && <ConnectDialog initial={preset} onClose={() => setPreset(null)} />}
    </div>
  );
}
