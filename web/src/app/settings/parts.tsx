"use client";

// The pieces every workspace settings section is built from (settings.css):
// a section with its heading, a row with a title, hint and control, a
// switch, a value to copy, and the JSON calls to the settings API.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n-react";

export async function api<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  try {
    const res = await fetch(url, { method, credentials: "same-origin", cache: "no-store", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } as T & { error?: string } };
  }
}

export function Section({ title, hint, action, children }: { title: string; hint?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="zst-section">
      <div className="zst-section-head">
        <h2 className="zst-section-title">{title}</h2>
        {action}
      </div>
      {hint && <p className="zst-section-hint">{hint}</p>}
      {children}
    </section>
  );
}

export function Row({ title, hint, children, id }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div className="zst-row">
      <div className="zst-row-text">
        <div className="zst-row-title" id={id}>
          {title}
        </div>
        {hint && <div className="zst-row-hint">{hint}</div>}
      </div>
      {children && <div className="zst-row-ctl">{children}</div>}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="zst-switch" disabled={disabled} data-test={testId} onClick={() => onChange(!on)} />;
}

/** A value shown whole, with a Copy button. */
export function CopyValue({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <div className="zst-code" aria-label={label}>
      <span className="zst-code-text">{value}</span>
      <button
        type="button"
        className="zst-btn zst-btn-sm"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? <Check /> : <Copy />}
        {done ? t("settings.copied") : t("settings.copy")}
      </button>
    </div>
  );
}

/** Phones: the sections are a tab bar that scrolls sideways (responsive/workspace.css); the open one is brought into view. */
export function ScrollToCurrent() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const nav = ref.current?.parentElement;
    const cur = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !cur || nav.scrollWidth <= nav.clientWidth) return;
    const r = cur.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    if (r.left < n.left || r.right > n.right) nav.scrollLeft += r.left - n.left - (n.width - r.width) / 2;
  }, []);
  return <span ref={ref} hidden />;
}
