// Where translations live at run time: one registry per process (server) or
// page (browser), keyed by namespace and language. English and Russian stay
// in each module's TypeScript dictionary; the other languages come from the
// JSON catalogs (src/i18n/catalogs/<ns>/<locale>.json):
//   - on the server, src/i18n/server-catalogs.ts registers all of them;
//   - in the browser, the root layout hands the page's language to
//     I18nProvider (web, eco, ds), and Docs, Projects, Calendar and Mail pages
//     hand theirs to <Messages>.
// A module's t() asks msg(ns, locale, key) and falls back to its English.

export type Namespace = "web" | "docs" | "projects" | "eco" | "ds" | "calendar" | "mail";
export type Dict = Readonly<Record<string, string>>;

const KEY = Symbol.for("zvena.i18n.messages");
const g = globalThis as unknown as Record<symbol, Map<string, Dict> | undefined>;
const reg: Map<string, Dict> = (g[KEY] ??= new Map());

/** Registers (or replaces) a namespace's strings in a language. */
export function setMessages(ns: Namespace, locale: string, dict: Dict): void {
  if (dict && Object.keys(dict).length) reg.set(`${ns}:${locale}`, dict);
}

export function hasMessages(ns: Namespace, locale: string): boolean {
  return reg.has(`${ns}:${locale}`);
}

/** The registered translation of `key`, or undefined (the caller shows English). */
export function msg(ns: Namespace, locale: string, key: string): string | undefined {
  return reg.get(`${ns}:${locale}`)?.[key];
}

/** All registered strings of a namespace in a language (what a page hands to the browser). */
export function messagesOf(ns: Namespace, locale: string): Dict {
  return reg.get(`${ns}:${locale}`) ?? {};
}

/** Fills {name} placeholders. */
export function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
