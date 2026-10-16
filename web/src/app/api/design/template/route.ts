import { readFile } from "node:fs/promises";
import { enRu } from "@/i18n/locales";
import { translate, type MessageKey } from "@/lib/i18n";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { designContext } from "@/lib/design-api";
import { DESIGN_TEMPLATES, templateFile } from "@/lib/design-templates";
import { access, fail } from "@/lib/http";
import { parseAcceptLanguage, readLocale } from "@/lib/locale-server";
import { importTemplate } from "@/lib/penpot";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/design/template?ws=<id>&key=<template> — "Use" in the gallery: the
// template becomes a new design in the workspace's Design team (editors),
// then the editor opens on it.
export async function GET(req: Request) {
  const rl = rateLimited(req, "ws");
  if (rl) return rl;
  const c = await designContext(req);
  if (c instanceof Response) return c;
  if (!access(c.userId, c.ws, "edit")) return fail(403, "forbidden");
  // A link on another site, or a prefetch or image on a zvena page, must not make designs: only opening it as a page here.
  const site = req.headers.get("sec-fetch-site");
  const dest = req.headers.get("sec-fetch-dest");
  if ((site && site !== "same-origin" && site !== "none") || (dest && dest !== "document") || req.headers.has("next-router-prefetch") || req.headers.get("purpose") === "prefetch") return fail(403, "forbidden");
  const key = new URL(req.url).searchParams.get("key");
  const tpl = DESIGN_TEMPLATES.find((t) => t.key === key);
  if (!tpl) return fail(404, "unknown template");
  const locale = readLocale(req.headers.get("cookie"), parseAcceptLanguage(req.headers.get("accept-language")));
  // Design templates exist in English and Russian; other languages get the English one.
  const file = templateFile(tpl, enRu(locale));
  if (!file) return fail(404, "unknown template");
  try {
    const data = await readFile(file);
    const f = await importTemplate(c.userId, c.teamId, translate(locale, `dtpl.${tpl.key}.name` as MessageKey), data);
    const res = NextResponse.redirect(`${config.designUrl}/#/workspace?team-id=${c.teamId}&file-id=${f.fileId}`, 303);
    res.headers.set("cache-control", "no-store");
    return res;
  } catch {
    return fail(503, "design unavailable");
  }
}
