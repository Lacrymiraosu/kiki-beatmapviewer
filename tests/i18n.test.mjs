// The translation files (i18n/*.json): every language has the same keys as en.json, placeholders match, and every
// literal tr("…") / data-i18n="…" string in the site has an entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "i18n");
const load = f => JSON.parse(readFileSync(join(dir, f), "utf8"));
const en = load("en.json");
const langs = readdirSync(dir).filter(f => /^[a-z]{2}\.json$/.test(f) && f !== "en.json");
const holes = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");

test("en.json maps every key to itself", () => {
  for (const [k, v] of Object.entries(en)) assert.equal(v, k);
});

for (const f of langs) test(`${f}: same keys as en.json, same {placeholders}`, () => {
  const d = load(f);
  assert.deepEqual(Object.keys(d).filter(k => !(k in en)), [], "keys that aren't in en.json");
  assert.deepEqual(Object.keys(en).filter(k => !(k in d)), [], "keys missing (add them, \"\" = not translated yet)");
  for (const [k, v] of Object.entries(d)) if (v) assert.equal(holes(v), holes(k), `${f} "${k}"`);
});

test("every literal UI string in the code has an entry in en.json", () => {
  const used = new Set();
  const html = readFileSync(join(root, "index.html"), "utf8");
  for (const m of html.matchAll(/data-i18n(?:-ph|-aria|-title)?="([^"]+)"/g)) used.add(m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
  for (const f of readdirSync(join(root, "js"))) {
    const src = readFileSync(join(root, "js", f), "utf8");
    for (const m of src.matchAll(/\btr\("((?:[^"\\]|\\.)*)"/g)) used.add(JSON.parse('"' + m[1] + '"'));
  }
  const missing = [...used].filter(k => !(k in en));
  assert.deepEqual(missing, [], "add these to i18n/en.json and every language file");
});
