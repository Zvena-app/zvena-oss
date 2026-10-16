"use client";

// Where toasts appear (design system: UndoToast): bottom center, dark in
// both themes, one at a time. ⌘Z (Ctrl Z) undoes while a toast with undo is
// up and nobody is typing; hovering pauses it. Mount once per page — the
// Shell does it for every section.

import { useEffect, useSyncExternalStore } from "react";
import { AlertCircle, Check, Undo2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";
import { dt } from "./i18n";
import { Kbd } from "./Kbd";
import { isTyping } from "./keys";
import { toasts } from "./toast-store";
import "./ds.css";

export function Toaster() {
  const { locale } = useI18n();
  const store = toasts();
  const t = useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => store.get(),
    () => null
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== "z" || e.shiftKey || e.altKey || !(e.metaKey || e.ctrlKey)) return;
      if (isTyping(e.target)) return;
      if (store.undo()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  return (
    <div className="ds-toasts" role="status" aria-live="polite">
      {t && (
        <div key={t.id} className="ds-toast" data-kind={t.kind} onMouseEnter={() => store.pause()} onMouseLeave={() => store.resume()}>
          {t.kind === "success" && <Check aria-hidden />}
          {t.kind === "error" && <AlertCircle aria-hidden />}
          <span className="ds-toast-text">{t.text}</span>
          {t.undo && (
            <button type="button" className="ds-toast-btn" onClick={() => store.undo(t.id)}>
              <Undo2 aria-hidden />
              {dt(locale, "undo")}
              <Kbd keys={["⌘", "Z"]} />
            </button>
          )}
          {t.action && (
            <button
              type="button"
              className="ds-toast-btn"
              onClick={() => {
                t.action?.run();
                store.dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          {t.kind === "error" && (
            <button type="button" className="ds-toast-btn" aria-label={dt(locale, "dismiss")} onClick={() => store.dismiss(t.id)}>
              <X aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
