import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedPreview, parsePreview } from "@/lib/notes/unfurl";
import { evalFormula, parseFormula, type FValue } from "@/lib/notes/formula";
import { checkPattern, MAX_INPUT, withPattern } from "@/lib/notes/safe-regex";
import { sanitizeHtml } from "@/lib/mail-client/sanitize";

const ms = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

// --- Link previews --------------------------------------------------------------

test("link previews: hostile markup (600 KB of unclosed <meta / <link) parses in well under 100 ms", () => {
  for (const html of ["<meta ".repeat(100_000), "<link ".repeat(100_000), "<head>" + "<meta name=x ".repeat(50_000), '<meta content="'.repeat(40_000), "<title>" + "x".repeat(600_000)]) {
    assert.ok(html.length >= 500_000);
    const took = ms(() => parsePreview(html, "https://example.com/"));
    assert.ok(took < 100, `took ${took.toFixed(1)} ms`);
  }
});

test("link previews: Open Graph, Twitter, <title> and the icon are read from the head", () => {
  const p = parsePreview(
    `<!doctype html><html><head><title>Plain &amp; title</title>
     <meta property="og:title" content="OG &quot;title&quot;"><meta name="twitter:description" content="Tw desc">
     <META NAME="description" CONTENT="Meta desc"><meta property="og:image" content="/img/cover.png">
     <link rel="apple-touch-icon" href="/apple.png"><link rel="shortcut icon" href="/fav.png"></head>
     <body><meta property="og:title" content="from the body"></body></html>`,
    "https://example.com/a/b"
  );
  assert.deepEqual(p, { url: "https://example.com/a/b", title: 'OG "title"', description: "Tw desc", image: "https://example.com/img/cover.png", icon: "https://example.com/fav.png" });
  const plain = parsePreview("<html><head><title> Just\n a  title </title></head><body><meta name=description content=late></body>", "https://x.example/");
  assert.equal(plain.title, "Just a title");
  assert.equal(plain.description, "", "nothing is read after <body> starts");
  assert.equal(plain.icon, "https://x.example/favicon.ico");
  assert.equal(parsePreview('<meta property="og:image" content="javascript:alert(1)">', "https://x.example/").image, "");
  // Past the first 64 KB nothing counts.
  assert.equal(parsePreview(`<head>${" ".repeat(70_000)}<title>late</title>`, "https://x.example/").title, "");
});

test("link previews: one fetch per URL for a while, shared by concurrent requests", async () => {
  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 20));
    return { url: "https://c.example/", title: "T", description: "", image: "", icon: "" };
  };
  const [a, b] = await Promise.all([cachedPreview("https://c.example/", load), cachedPreview("https://c.example/", load)]);
  assert.equal(a?.title, "T");
  assert.equal(b?.title, "T");
  assert.equal((await cachedPreview("https://c.example/", load))?.title, "T");
  assert.equal(loads, 1);
  let dead = 0;
  assert.equal(await cachedPreview("https://dead.example/", async () => (dead++, null)), null);
  assert.equal(await cachedPreview("https://dead.example/", async () => (dead++, null)), null);
  assert.equal(dead, 1, "a failed page is not retried on every request");
});

// --- Formula patterns ------------------------------------------------------------

const run = (src: string, props: Record<string, FValue> = {}): FValue =>
  evalFormula(parseFormula(src), { now: Date.now(), locale: "en", prop: (n) => props[n] ?? null });

test("formula patterns: the exponential families are refused, including the ones the old guard let through", () => {
  const hostile = "a".repeat(40) + "!";
  const started = performance.now();
  for (const p of ["(a|a)+$", "(a|aa)+$", "(\\w|\\d)+$", "(a+)+$", "(.*)*", "(a+a)+$", "(.+,)*$", "((ab)+c)*", "(a?)*$", "(a{1,3}){2,}$", "(a)\\1", "(?<x>a)\\k<x>"]) {
    assert.throws(() => checkPattern(p), `refused: ${p}`);
    assert.throws(() => run(`test(prop("t"), prop("p"))`, { t: hostile, p }), `formula refuses: ${p}`);
  }
  assert.throws(() => checkPattern("a".repeat(301)), /too long/);
  assert.ok(performance.now() - started < 100);
});

test("formula patterns: ordinary patterns still work", () => {
  assert.equal(run(`test("1,2,3", "^(\\\\d+,)*\\\\d+$")`), true);
  assert.equal(run(`test("ann@example.com", "\\\\w+@\\\\w+\\\\.com")`), true);
  assert.deepEqual(run(`match("a1b22c333", "\\\\d+")`), ["1", "22", "333"]);
  assert.equal(run(`replace("  hi  ", "^\\\\s+|\\\\s+$", "")`), "hi  ");
  assert.equal(run(`replaceAll("a-b-c", "-", "+")`), "a+b+c");
  assert.equal(run(`replaceAll("x-y z", "(?:[a-z]+-)+[a-z]+", "W")`), "W z");
  assert.equal(run(`replace("2026-10-16", "(\\\\d+)-(\\\\d+)-(\\\\d+)", "$3.$2.$1")`), "16.10.2026");
  assert.equal(run(`test("ab", "a(?=b)")`), true, "lookarounds with one repetition at most still run");
});

test("formula patterns: polynomial shapes run in linear time on the server, and text is capped", () => {
  // \w*\w*\w*! backtracks O(n^4) in the default engine (about 90 s at 1,000 characters).
  const took = ms(() => assert.equal(withPattern("\\w*\\w*\\w*!", "", "a".repeat(MAX_INPUT), (re, t) => re.test(t)), false));
  assert.ok(took < 100, `took ${took.toFixed(1)} ms`);
  const took2 = ms(() => run(`test(prop("t"), "\\\\w*\\\\w*\\\\w*\\\\w*!")`, { t: "a".repeat(5000) }));
  assert.ok(took2 < 100, `took ${took2.toFixed(1)} ms`);
  assert.throws(() => run(`test(prop("t"), "a")`, { t: "a".repeat(MAX_INPUT + 1) }), /too long/);
  assert.throws(() => run(`test(prop("t"), "(?=a)\\\\w*\\\\w*!")`, { t: "aaa" }), /too complex/);
});

// --- Mail CSS ----------------------------------------------------------------------

test("mail sanitizer: hostile CSS (unclosed image-set( / comments) is linear and capped", () => {
  for (const css of ["image-set(".repeat(10_000), "/*".repeat(50_000), "cross-fade(".repeat(9_000), "@import".repeat(14_000)]) {
    const took = ms(() => sanitizeHtml(`<style>${css}</style><p style="${css.slice(0, 7_900)}">x</p>`, { images: false }));
    assert.ok(took < 100, `took ${took.toFixed(1)} ms`);
  }
  const big = "a{color:red}".repeat(20_000);
  const took = ms(() => sanitizeHtml(`<style>${big}</style><p style="${"color:red;".repeat(50_000)}">x</p>`, { images: false }));
  assert.ok(took < 200, `took ${took.toFixed(1)} ms`);
  const out = sanitizeHtml(`<p style="color:red">a</p><p style="background-image:image-set('https://t.example/y' 1x)">b</p><p style="background:image-set(">c</p>`, { images: false }).html;
  assert.match(out, /color:red/);
  assert.ok(!out.includes("t.example") && !out.includes("image-set"), out);
});
