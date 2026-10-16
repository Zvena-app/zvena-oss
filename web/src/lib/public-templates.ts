// The templates shown before sign-in (/templates/<id>): each id names one real
// template — a Docs one (components/notes/templates.ts) or a Design one
// (lib/design-templates.ts) — in kebab case ("task-tracker", "ui-kit").
// "Use this template" goes through sign-in as /templates/<id>?use=1 (a plain
// path, so it survives `next` in the e-mail link, single sign-on, /welcome
// and /consent alike) and
// lands on the gallery's own link for it (app/templates/page.tsx).

import { TEMPLATES } from "@/components/notes/templates";
import { DESIGN_TEMPLATES } from "./design-templates";

export interface PublicTemplate {
  id: string;
  kind: "doc" | "design";
  /** The template's key in its own list. */
  key: string;
}

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const ID = /^[a-z][a-z0-9-]{1,40}$/;

export const PUBLIC_TEMPLATES: readonly PublicTemplate[] = [
  ...DESIGN_TEMPLATES.map((d) => ({ id: kebab(d.key), kind: "design" as const, key: d.key })),
  ...TEMPLATES.map((t) => ({ id: kebab(t.key), kind: "doc" as const, key: t.key })),
];

/** The template an id names, or null for anything else (unknown, malformed, too long). */
export function publicTemplate(id: string | null | undefined): PublicTemplate | null {
  if (typeof id !== "string" || !ID.test(id)) return null;
  return PUBLIC_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The public id of a template key ("taskTracker" → "task-tracker"), or null. */
export function templateId(kind: PublicTemplate["kind"], key: string): string | null {
  return PUBLIC_TEMPLATES.find((t) => t.kind === kind && t.key === key)?.id ?? null;
}

/** The preview's address; `use`: open it to add the template (after sign-in). */
export function templatePath(id: string, use = false): string {
  return `/templates/${id}${use ? "?use=1" : ""}`;
}

/** Sign in, then come back to add the template. */
export function templateSignIn(id: string): string {
  return `/signin?next=${encodeURIComponent(templatePath(id, true))}`;
}

/** Where "Use this template" goes for a signed-in person: the gallery's own link (a Docs copy, or a new design). */
export function templateUseHref(t: PublicTemplate, ws: string, locale: string): string {
  const w = encodeURIComponent(ws);
  return t.kind === "doc" ? `/docs?ws=${w}#tpl=${t.key}/${/^[a-z]{2}$/.test(locale) ? locale : "en"}` : `/api/design/template?ws=${w}&key=${encodeURIComponent(t.key)}`;
}
