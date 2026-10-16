// zvena's translations: English (and Russian) live in each module's TypeScript
// dictionary; the other languages are JSON catalogs, one per namespace and
// language, at src/i18n/catalogs/<ns>/<locale>.json.
//
//   node scripts/i18n.mjs extract   writes src/i18n/source/<ns>.json: the English
//                                   strings to translate (keys in source order)
//   node scripts/i18n.mjs check     every catalog against English: placeholders ({name})
//                                   that differ, empty strings (errors); missing keys,
//                                   keys the code doesn't have (yet), and English that
//                                   changed since the last extract (warnings)
//   node scripts/i18n.mjs check --strict   the same, warnings fail too (CI): all ten
//                                   languages have exactly the keys the code has
//   node scripts/i18n.mjs missing <locale>   the English strings a catalog lacks or
//                                   whose English changed, as JSON (what to translate next)
//
// After translating, run extract: src/i18n/source/ is the English the catalogs
// were translated from, so a later edit of an English string shows up as stale.
//
// The dictionaries are read with the TypeScript parser, never executed.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_LOCALES = ["zh", "hi", "es", "ar", "fr", "bn", "pt", "id"];

/** The text of a string-ish initializer ("…", '…', `…` without ${}, "a" + "b"), or null. */
function text(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return text(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = text(node.left);
    const b = text(node.right);
    return a !== null && b !== null ? a + b : null;
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) return text(node.expression);
  return null;
}

function propName(p) {
  const n = p.name;
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return null;
}

function parse(file) {
  const src = readFileSync(join(root, file), "utf8");
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The object literal initializing `const <name>` (or export const). */
function objectOf(sf, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      let init = node.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(init))) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) found = init;
      if (ts.isArrayLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`${sf.fileName}: no literal for ${name}`);
  return found;
}

/** A flat key → string dictionary (values that are not plain strings are reported). */
function dict(file, name, pick = (v) => text(v)) {
  const sf = parse(file);
  const obj = objectOf(sf, name);
  const out = {};
  const skipped = [];
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const k = propName(p);
    const v = pick(p.initializer);
    if (k === null) continue;
    if (v === null) skipped.push(k);
    else out[k] = v;
  }
  if (skipped.length) console.warn(`${file} ${name}: ${skipped.length} non-literal values kept in English: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
  return out;
}

/** lib/create.ts: what can be made, as item.<id>.label / .hint and tpl.<id>. */
function createItems() {
  const sf = parse("src/lib/create.ts");
  const out = {};
  for (const [arr, prefix] of [["CREATE_ITEMS", "item"], ["CREATE_TEMPLATES", "tpl"]]) {
    const list = objectOf(sf, arr);
    for (const el of list.elements) {
      if (!ts.isObjectLiteralExpression(el)) continue;
      const get = (n) => el.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === n);
      const id = text(get("id")?.initializer);
      if (!id) continue;
      for (const field of ["label", "hint"]) {
        const f = get(field);
        if (!f || !ts.isObjectLiteralExpression(f.initializer)) continue;
        const en = f.initializer.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === "en");
        const v = text(en?.initializer);
        if (v !== null) out[prefix === "tpl" ? `tpl.${id}` : `item.${id}.${field}`] = v;
      }
    }
  }
  return out;
}

/** lib/notes/formula.ts: what each formula function does, as fn.<name>. */
function formulaDocs() {
  const list = objectOf(parse("src/lib/notes/formula.ts"), "FORMULA_DOCS");
  const out = {};
  for (const el of list.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    const get = (n) => text(el.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === n)?.initializer);
    const name = get("name");
    const en = get("en");
    if (name && en !== null) out[`fn.${name}`] = en;
  }
  return out;
}

/** components/notes/templates.ts: the templates' words, as tplc:<English> (tx(lang, "English", "Русский")). */
function templateTexts() {
  const sf = parse("src/components/notes/templates.ts");
  const out = {};
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "tx" && n.arguments.length === 3) {
      const en = text(n.arguments[1]);
      if (en !== null && en.trim()) out[`tplc:${en}`] = en;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every namespace's English strings. */
export function english() {
  return {
    web: dict("src/lib/i18n.ts", "en"),
    docs: { ...dict("src/lib/notes/i18n.ts", "en"), ...formulaDocs(), ...templateTexts() },
    projects: {
      ...dict("src/components/projects/i18n.ts", "M", (v) => (ts.isArrayLiteralExpression(v) ? text(v.elements[1]) : null)),
      ...dict("src/lib/projects/strings.ts", "en"),
    },
    eco: dict("src/lib/eco/strings.ts", "en"),
    calendar: dict("src/lib/calendar/strings.ts", "en"),
    mail: dict("src/lib/mail-client/strings.ts", "en"),
    ds: {
      ...dict("src/components/zvena/ds/i18n.ts", "en"),
      ...Object.fromEntries(Object.entries(dict("src/components/zvena/create/i18n.ts", "en")).map(([k, v]) => [`create.${k}`, v])),
      ...createItems(),
    },
  };
}

/** The English the catalogs were translated from (src/i18n/source/<ns>.json), or {}. */
function sourceOf(ns) {
  const file = join(root, "src/i18n/source", `${ns}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

/** Keys whose English changed since the last extract. */
function staleKeys(ns, strings) {
  const src = sourceOf(ns);
  return Object.keys(strings).filter((k) => k in src && src[k] !== strings[k]);
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

function check(strict) {
  const en = english();
  let errors = 0;
  let warnings = 0;
  const report = [];
  for (const [ns, strings] of Object.entries(en)) {
    const stale = staleKeys(ns, strings);
    if (stale.length) {
      report.push(`${ns}: English changed since the last extract (re-translate, then extract): ${stale.slice(0, 8).join(", ")}`);
      warnings += 1;
    }
    for (const loc of CATALOG_LOCALES) {
      const file = join(root, "src/i18n/catalogs", ns, `${loc}.json`);
      if (!existsSync(file)) {
        report.push(`${ns}/${loc}: no catalog (English shows)`);
        warnings++;
        continue;
      }
      let cat;
      try {
        cat = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        report.push(`${ns}/${loc}: not valid JSON (${e.message})`);
        errors++;
        continue;
      }
      const unknown = Object.keys(cat).filter((k) => !(k in strings));
      const empty = Object.entries(cat).filter(([, v]) => typeof v !== "string" || !v.trim()).map(([k]) => k);
      const ph = Object.entries(cat).filter(([k, v]) => k in strings && typeof v === "string" && placeholders(v) !== placeholders(strings[k])).map(([k]) => k);
      const missing = Object.keys(strings).filter((k) => !(k in cat));
      if (unknown.length) {
        report.push(`${ns}/${loc}: ${unknown.length} keys the code doesn't have (unused until it does): ${unknown.slice(0, 5).join(", ")}`);
        warnings += 1;
      }
      if (empty.length) {
        report.push(`${ns}/${loc}: ${empty.length} empty: ${empty.slice(0, 5).join(", ")}`);
        errors += empty.length;
      }
      if (ph.length) {
        report.push(`${ns}/${loc}: ${ph.length} placeholder mismatches: ${ph.slice(0, 5).join(", ")}`);
        errors += ph.length;
      }
      if (missing.length) {
        report.push(`${ns}/${loc}: ${missing.length} of ${Object.keys(strings).length} missing (English shows)`);
        warnings += 1;
      }
    }
  }
  console.log(report.join("\n") || "all catalogs complete");
  console.log(`\n${errors} errors, ${warnings} warnings`);
  if (errors || (strict && warnings)) process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "extract") {
  const en = english();
  const dir = join(root, "src/i18n/source");
  mkdirSync(dir, { recursive: true });
  for (const [ns, strings] of Object.entries(en)) {
    writeFileSync(join(dir, `${ns}.json`), JSON.stringify(strings, null, 2) + "\n");
    console.log(`${ns}: ${Object.keys(strings).length} strings`);
  }
} else if (cmd === "check") {
  check(arg === "--strict");
} else if (cmd === "missing") {
  const en = english();
  const out = {};
  for (const [ns, strings] of Object.entries(en)) {
    const file = join(root, "src/i18n/catalogs", ns, `${arg}.json`);
    const cat = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const stale = new Set(staleKeys(ns, strings));
    out[ns] = Object.fromEntries(Object.entries(strings).filter(([k]) => !(k in cat) || stale.has(k)));
  }
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log("usage: node scripts/i18n.mjs extract | check [--strict] | missing <locale>");
  process.exit(2);
}
