"use client";

// A page that failed to render: say so plainly and offer a retry. The error
// itself is in the server log (its digest ties the two together).
//
// This boundary is part of every page's first download, so it doesn't import
// lib/i18n.ts (the English and Russian dictionaries): it shows English at once
// (the same strings as pageError.* there) and loads the page's language only
// when an error actually happens.

import Link from "next/link";
import { useContext, useEffect, useState } from "react";
import type { MessageKey } from "@/lib/i18n";
import { I18nContext } from "@/lib/i18n-provider";

type Key = "pageError.title" | "pageError.body" | "pageError.retry" | "pageError.home" | "pageError.ref";
type T = (key: Key, vars?: Record<string, string>) => string;

const EN: Record<Key, string> = {
  "pageError.title": "Something went wrong",
  "pageError.body": "This page couldn’t load. Your work is saved; try again in a moment.",
  "pageError.retry": "Try again",
  "pageError.home": "Go to Home",
  "pageError.ref": "Reference: {id}",
};
const english: T = (key, vars) => EN[key].replace(/\{(\w+)\}/g, (m, k: string) => vars?.[k] ?? m);

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { locale } = useContext(I18nContext);
  const [t, setT] = useState<T>(() => english);
  useEffect(() => {
    console.error(error);
  }, [error]);
  useEffect(() => {
    if (locale === "en") return;
    let live = true;
    // Offline or a failed chunk: the English text stays.
    import("@/lib/i18n").then(
      (m) => live && setT(() => (key: Key, vars?: Record<string, string>) => m.translate(locale, key as MessageKey, vars)),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [locale]);
  return (
    <main className="zv-error-page" role="alert">
      <h1>{t("pageError.title")}</h1>
      <p>{t("pageError.body")}</p>
      <div className="zv-actions">
        <button type="button" className="zv-btn zv-btn-primary" onClick={() => reset()}>
          {t("pageError.retry")}
        </button>
        <Link className="zv-btn" href="/home">
          {t("pageError.home")}
        </Link>
      </div>
      {error.digest && <p className="zv-error-ref">{t("pageError.ref", { id: error.digest })}</p>}
    </main>
  );
}
