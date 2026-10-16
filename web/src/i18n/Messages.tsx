"use client";

// Hands a namespace's translations for the page's language to the browser's
// registry before anything under it renders (src/i18n/runtime.ts). A server
// page renders it with what it read from the server registry:
//
//   <Messages ns="docs" locale={locale} dict={messagesOf("docs", locale)}>…</Messages>
//
// English and Russian live in the modules themselves, so `dict` is empty for
// them and nothing is sent.

import { useState, type ReactNode } from "react";
import { setMessages, type Dict, type Namespace } from "./runtime";

export function Messages({ ns, locale, dict, children }: { ns: Namespace; locale: string; dict: Dict; children?: ReactNode }) {
  // Registered during the first render (not in an effect): children read it right away.
  useState(() => {
    setMessages(ns, locale, dict);
    return null;
  });
  return <>{children}</>;
}

/** Several namespaces at once (the root layout: web, eco, ds). */
export function registerAll(locale: string, all: Partial<Record<Namespace, Dict>>): void {
  for (const [ns, dict] of Object.entries(all) as [Namespace, Dict][]) if (dict) setMessages(ns, locale, dict);
}
