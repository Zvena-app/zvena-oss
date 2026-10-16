// Every catalog, registered at server start (instrumentation.ts) and read by
// the root layout to hand the page's language to the browser. Server-only:
// importing it in a client component would ship every language.

import { setMessages, type Dict, type Namespace } from "./runtime";
import web_zh from "./catalogs/web/zh.json";
import web_hi from "./catalogs/web/hi.json";
import web_es from "./catalogs/web/es.json";
import web_ar from "./catalogs/web/ar.json";
import web_fr from "./catalogs/web/fr.json";
import web_bn from "./catalogs/web/bn.json";
import web_pt from "./catalogs/web/pt.json";
import web_id from "./catalogs/web/id.json";
import docs_zh from "./catalogs/docs/zh.json";
import docs_hi from "./catalogs/docs/hi.json";
import docs_es from "./catalogs/docs/es.json";
import docs_ar from "./catalogs/docs/ar.json";
import docs_fr from "./catalogs/docs/fr.json";
import docs_bn from "./catalogs/docs/bn.json";
import docs_pt from "./catalogs/docs/pt.json";
import docs_id from "./catalogs/docs/id.json";
import projects_zh from "./catalogs/projects/zh.json";
import projects_hi from "./catalogs/projects/hi.json";
import projects_es from "./catalogs/projects/es.json";
import projects_ar from "./catalogs/projects/ar.json";
import projects_fr from "./catalogs/projects/fr.json";
import projects_bn from "./catalogs/projects/bn.json";
import projects_pt from "./catalogs/projects/pt.json";
import projects_id from "./catalogs/projects/id.json";
import eco_zh from "./catalogs/eco/zh.json";
import eco_hi from "./catalogs/eco/hi.json";
import eco_es from "./catalogs/eco/es.json";
import eco_ar from "./catalogs/eco/ar.json";
import eco_fr from "./catalogs/eco/fr.json";
import eco_bn from "./catalogs/eco/bn.json";
import eco_pt from "./catalogs/eco/pt.json";
import eco_id from "./catalogs/eco/id.json";
import ds_zh from "./catalogs/ds/zh.json";
import ds_hi from "./catalogs/ds/hi.json";
import ds_es from "./catalogs/ds/es.json";
import ds_ar from "./catalogs/ds/ar.json";
import ds_fr from "./catalogs/ds/fr.json";
import ds_bn from "./catalogs/ds/bn.json";
import ds_pt from "./catalogs/ds/pt.json";
import ds_id from "./catalogs/ds/id.json";
import calendar_zh from "./catalogs/calendar/zh.json";
import calendar_hi from "./catalogs/calendar/hi.json";
import calendar_es from "./catalogs/calendar/es.json";
import calendar_ar from "./catalogs/calendar/ar.json";
import calendar_fr from "./catalogs/calendar/fr.json";
import calendar_bn from "./catalogs/calendar/bn.json";
import calendar_pt from "./catalogs/calendar/pt.json";
import calendar_id from "./catalogs/calendar/id.json";
import mail_zh from "./catalogs/mail/zh.json";
import mail_hi from "./catalogs/mail/hi.json";
import mail_es from "./catalogs/mail/es.json";
import mail_ar from "./catalogs/mail/ar.json";
import mail_fr from "./catalogs/mail/fr.json";
import mail_bn from "./catalogs/mail/bn.json";
import mail_pt from "./catalogs/mail/pt.json";
import mail_id from "./catalogs/mail/id.json";

const ALL: Record<Namespace, Record<string, Dict>> = {
  web: { zh: web_zh, hi: web_hi, es: web_es, ar: web_ar, fr: web_fr, bn: web_bn, pt: web_pt, id: web_id },
  docs: { zh: docs_zh, hi: docs_hi, es: docs_es, ar: docs_ar, fr: docs_fr, bn: docs_bn, pt: docs_pt, id: docs_id },
  projects: { zh: projects_zh, hi: projects_hi, es: projects_es, ar: projects_ar, fr: projects_fr, bn: projects_bn, pt: projects_pt, id: projects_id },
  eco: { zh: eco_zh, hi: eco_hi, es: eco_es, ar: eco_ar, fr: eco_fr, bn: eco_bn, pt: eco_pt, id: eco_id },
  ds: { zh: ds_zh, hi: ds_hi, es: ds_es, ar: ds_ar, fr: ds_fr, bn: ds_bn, pt: ds_pt, id: ds_id },
  calendar: { zh: calendar_zh, hi: calendar_hi, es: calendar_es, ar: calendar_ar, fr: calendar_fr, bn: calendar_bn, pt: calendar_pt, id: calendar_id },
  mail: { zh: mail_zh, hi: mail_hi, es: mail_es, ar: mail_ar, fr: mail_fr, bn: mail_bn, pt: mail_pt, id: mail_id },
};

let done = false;

/** Registers every catalog once per process. */
export function registerCatalogs(): void {
  if (done) return;
  done = true;
  for (const [ns, byLocale] of Object.entries(ALL) as [Namespace, Record<string, Dict>][]) for (const [l, d] of Object.entries(byLocale)) setMessages(ns, l, d);
}

registerCatalogs();
