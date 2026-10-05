// The site uses its own pop-ups (modal / ask / askText in js/core.js), never the browser's alert, confirm or prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("no browser alert / confirm / prompt in the site's scripts", () => {
  const found = [];
  for (const f of readdirSync(join(root, "js")).filter(f => f.endsWith(".js"))) {
    const src = readFileSync(join(root, "js", f), "utf8");
    // local helpers named `alert` (admin.js) are declared in the same file; the browser's are called bare or on window
    const local = new Set([...src.matchAll(/\b(?:const|let|function)\s+(alert|confirm|prompt)\b|[,{]\s*(alert|confirm|prompt)\s*=/g)].map(m => m[1] || m[2]));
    src.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\w.$])(window\.)?(alert|confirm|prompt)\(/g)) if (m[1] || !local.has(m[2])) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(found, []);
});
