import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Branches append their styles at the end of the same sheets; a merge that
// drops one closing brace nests everything after it inside the previous rule
// and silently unstyles whole features. No rule may open inside another
// plain rule (at-rules such as @media nest on purpose).
function nestedRules(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const stack: { at: boolean; line: number; head: string }[] = [];
  const problems: string[] = [];
  let line = 1;
  let buf = "";
  for (const ch of src) {
    if (ch === "\n") line += 1;
    if (ch === "{") {
      const head = buf.split(";").pop()?.trim() ?? "";
      const top = stack[stack.length - 1];
      if (top && !top.at) problems.push(`line ${line}: "${head.slice(0, 60)}" inside the rule of line ${top.line} ("${top.head.slice(0, 40)}")`);
      stack.push({ at: head.startsWith("@"), line, head });
      buf = "";
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else buf += ch;
  }
  if (stack.length) problems.push(`unclosed at the end: ${stack.map((s) => `line ${s.line}`).join(", ")}`);
  return problems;
}

test("the stylesheets have no rule left open (a brace lost in a merge)", () => {
  const roots = [join(process.cwd(), "src/components/notes"), join(process.cwd(), "src/components/notes/database"), join(process.cwd(), "src/components/mail"), join(process.cwd(), "src/app"), join(process.cwd(), "src/app/clipper"), join(process.cwd(), "src/components/calendar"), join(process.cwd(), "src/components/calendar/booking")];
  let checked = 0;
  for (const dir of roots) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".css"))) {
      assert.deepEqual(nestedRules(readFileSync(join(dir, f), "utf8")), [], f);
      checked += 1;
    }
  }
  assert.ok(checked >= 6);
});
