"use client";

// A Button property's cell (Notion): clicking runs its actions. A
// confirmation asks first; editing properties, adding pages, notifications
// and webhooks run on the server (/api/notes/button) as the person who
// clicked; "open" steps run here afterwards. A guest's local workspace runs
// "set" and "add a page" in the browser.

import { useState } from "react";
import { useNotesMaybe } from "../context";
import { toast } from "../ui";
import { runLocalActions } from "../automations-run";
import type { DbProperty, Note } from "@/lib/notes/types";

const SERVER_STEPS = new Set(["set", "addPage", "notify", "webhook"]);

export function ButtonCell({ prop, row }: { prop: DbProperty; row: Note }) {
  const api = useNotesMaybe();
  const [busy, setBusy] = useState(false);
  const label = prop.button?.label || prop.name;
  const actions = prop.button?.actions ?? [];
  const disabled = !api || api.readOnly || busy || row.trashedAt !== null;
  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!api || disabled) return;
    const { t } = api;
    if (actions.length === 0) {
      toast(t("auto.buttonEmpty"));
      return;
    }
    for (const a of actions) if (a.type === "confirm" && !window.confirm(a.text.trim() || t("button.confirmDefault"))) return;
    const dbId = row.parentId;
    if (!dbId) return;
    if (actions.some((a) => SERVER_STEPS.has(a.type))) {
      if (!api.user) runLocalActions(api.store, row.id, dbId, actions);
      else {
        setBusy(true);
        try {
          const r = await fetch(`/api/notes/button?ws=${encodeURIComponent(api.user.ws.id)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dbId, rowId: row.id, propId: prop.id }),
            credentials: "same-origin",
          });
          if (!r.ok) throw new Error(String(r.status));
          const j = (await r.json()) as { saved?: Note[] };
          // The server's copies at once (sync would bring them shortly anyway).
          if (j.saved?.length) api.store.applyRemote(j.saved, []);
        } catch {
          toast(t("auto.buttonFailed"));
          return;
        } finally {
          setBusy(false);
        }
      }
    }
    for (const a of actions) {
      if (a.type === "openPage" && a.noteId) api.open(a.noteId);
      else if (a.type === "openUrl" && /^(https?:|mailto:)/i.test(a.url)) window.open(a.url, "_blank", "noopener,noreferrer");
    }
  };
  return (
    <button type="button" className="nt-prop-button nt-btn-reset" disabled={disabled} title={label} onClick={(e) => void run(e)}>
      {label}
    </button>
  );
}
