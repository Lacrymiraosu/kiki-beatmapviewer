// Translation helper (not deployed). Files: i18n/<lang>.json, keyed by the English text.
//   node scripts/i18n.mjs status              untranslated entries per language, and UI strings missing from en.json
//   node scripts/i18n.mjs add rows.json       add/replace entries; rows.json = [["English", "ไทย", "Melayu", "Indonesia", "한국어", "日本語"], …]
//   node scripts/i18n.mjs todo th             print the English keys still untranslated in th.json
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."), dir = join(root, "i18n");
const ORDER = ["en", "th", "ms", "id", "ko", "ja"]; // column order of rows for "add"
const read = l => JSON.parse(readFileSync(join(dir, l + ".json"), "utf8"));
const write = (l, d) => writeFileSync(join(dir, l + ".json"), JSON.stringify(d, null, 2) + "\n");
const langs = ["en", ...readdirSync(dir).filter(f => /^[a-z]{2}\.json$/.test(f) && f !== "en.json").map(f => f.slice(0, 2))];

const [cmd, arg] = process.argv.slice(2);
if (cmd === "add") {
  const rows = JSON.parse(readFileSync(arg, "utf8")), files = Object.fromEntries(langs.map(l => [l, read(l)]));
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== "string" || !r[0]) throw new Error("bad row " + JSON.stringify(r));
    for (const l of langs) { const i = ORDER.indexOf(l); files[l][r[0]] = l === "en" ? r[0] : (i > 0 && typeof r[i] === "string" ? r[i] : files[l][r[0]] || ""); }
  }
  for (const l of langs) write(l, files[l]);
  console.log(`added/updated ${rows.length} entries in ${langs.join(", ")}`);
} else if (cmd === "todo") {
  const d = read(arg); for (const k of Object.keys(read("en"))) if (!d[k]) console.log(k);
} else {
  const en = read("en");
  for (const l of langs.slice(1)) { const d = read(l); console.log(`${l}: ${Object.keys(en).filter(k => !d[k]).length} untranslated of ${Object.keys(en).length}`); }
  const used = new Set(), html = readFileSync(join(root, "index.html"), "utf8");
  for (const m of html.matchAll(/data-i18n(?:-ph|-aria|-title)?="([^"]+)"/g)) used.add(m[1].replace(/&amp;/g, "&"));
  for (const f of readdirSync(join(root, "js"))) for (const m of readFileSync(join(root, "js", f), "utf8").matchAll(/\btr\("((?:[^"\\]|\\.)*)"/g)) used.add(JSON.parse('"' + m[1] + '"'));
  const missing = [...used].filter(k => !(k in en));
  console.log(missing.length ? "missing from en.json:\n" + missing.join("\n") : "every UI string has an entry");
}
