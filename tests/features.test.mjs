// Feature switches: the same keys everywhere (server list, SQL migration, D1 settings, client registry), every key hidden by
// data-feat or guarded in code, every label translated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = p => readFileSync(join(root, p), "utf8");
const { FEATURE_KEYS, FEAT_RE, routeFeature } = require(join(root, "api/_lib/features.js"));
const clientSrc = read("js/features.js");
const client = [...clientSrc.slice(clientSrc.indexOf("const FEATS = ["), clientSrc.indexOf("let FEAT_OFF")).matchAll(/\["([a-z0-9_]+)",\s*"([^"]+)",\s*"(site|editor)"\]/g)].map(m => ({ key: m[1], label: m[2], group: m[3] }));
const en = JSON.parse(read("i18n/en.json"));

// the newest migration that defines obv.setting_spec() (each one that changes the settings has the full list again)
const specMigration = () => {
  const dir = join(root, "supabase/migrations"), files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort().filter(f => /create or replace function obv\.setting_spec\(\)/.test(readFileSync(join(dir, f), "utf8")));
  return { file: files[files.length - 1], sql: readFileSync(join(dir, files[files.length - 1]), "utf8") };
};
test("the keys are the same on the server, in the newest settings migration and in D1's settings", () => {
  const sorted = a => [...a].sort();
  assert.ok(FEATURE_KEYS.length >= 20 && FEATURE_KEYS.every(k => FEAT_RE.test(k)) && new Set(FEATURE_KEYS).size === FEATURE_KEYS.length);
  assert.ok(FEATURE_KEYS.includes("replays"), "the replay watcher has its switch");
  const { file, sql: mig } = specMigration();
  assert.ok(mig.includes("unnest(array["), file);
  const list = [...mig.slice(mig.indexOf("unnest(array[")).matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]).filter(k => FEATURE_KEYS.includes(k) || /^[a-z0-9_]+$/.test(k));
  assert.deepEqual(sorted(list.slice(0, FEATURE_KEYS.length)), sorted(FEATURE_KEYS), "the SQL migration's list (" + file + ")");
  assert.equal(mig.slice(mig.indexOf("unnest(array[")).match(/unnest\(array\[([^\]]*)\]/)[1].match(/'[^']+'/g).length, FEATURE_KEYS.length, "no extra keys in the SQL list");
  const d1 = require(join(root, "api/_lib/d1.js"));
  assert.ok(d1, "d1 loads");
  assert.ok(read("api/_lib/d1.js").includes('require("./features").FEATURE_KEYS.map(k => ["feat_" + k'), "D1 builds its settings from the same list");
  // the other settings: the same rows (key, kind, min, max, default) in the migration and in D1's SPEC
  const rows = [...mig.slice(mig.indexOf("from (values"), mig.indexOf(") as v(key")).matchAll(/\('([a-z0-9_]+)', '(int|bool)', (null|\d+)(?:::numeric)?, (null|\d+)(?:::numeric)?, '([^']+)'(?:::jsonb)?\)/g)]
    .map(m => [m[1], m[2], m[3] === "null" ? null : +m[3], m[4] === "null" ? null : +m[4], JSON.parse(m[5])]);
  const own = d1.SPEC.filter(r => !r[0].startsWith("feat_"));
  assert.deepEqual(rows, own, "setting_spec in " + file + " vs SPEC in api/_lib/d1.js");
  for (const k of ["replay_budget_bytes", "replays_per_user"]) assert.ok(rows.some(r => r[0] === k), k);
  assert.deepEqual(d1.SPEC.filter(r => r[0].startsWith("feat_")).map(r => r[0].slice(5)), FEATURE_KEYS);
});

test("the keys are the same in the page's switch list (js/features.js)", () => {
  const sorted = a => [...a].sort();
  assert.deepEqual(sorted(client.map(f => f.key)), sorted(FEATURE_KEYS), "js/features.js FEATS vs api/_lib/features.js");
});

test("every switch hides something (data-feat) or is checked where it is used, and there are no strays", () => {
  const html = read("index.html"), used = new Set();
  for (const m of html.matchAll(/data-feat="([^"]+)"/g)) for (const k of m[1].split(/\s+/)) used.add(k);
  assert.deepEqual([...used].filter(k => !FEATURE_KEYS.includes(k)), [], "data-feat names a key that doesn't exist");
  const code = readdirSync(join(root, "js")).filter(f => f !== "features.js").map(f => read("js/" + f)).join("\n");
  for (const k of FEATURE_KEYS) {
    const guarded = new RegExp(`(featOn|featGuard)\\("${k}"\\)|"${k}"\\]|\\["${k}"|"${k}",`).test(code) || (/^ed_(timing|hitsounds|verify|setup|notes|compare)$/.test(k) && code.includes('featOn("ed_" + '));
    assert.ok(used.has(k) || guarded, `${k} neither hides an element nor is checked in code`);
    assert.ok(guarded || used.has(k), k);
  }
  // a hidden button alone is not "off": the ones that open something are checked in code too
  for (const k of ["editor", "projects", "live", "collab", "drive", "ed_test", "ed_tools", "ed_share"]) assert.ok(new RegExp(`featGuard\\("${k}"\\)|featOn\\("${k}"\\)`).test(code), `${k} has no guard in code`);
});

test("every label (and the switch texts) are in en.json", () => {
  assert.deepEqual(client.filter(f => !(f.label in en)).map(f => f.label), []);
  for (const t of ["{name} is switched off for now.", "This part of the site is switched off for now."]) assert.ok(t in en, t);
  assert.ok(client.every(f => f.key !== "compose"), "the editor's fallback tab can't be switched off");
});

test("server routes that need a feature", () => {
  assert.deepEqual(routeFeature("projects"), ["projects"]); assert.deepEqual(routeFeature("projects/:id/saves"), ["projects"]); assert.deepEqual(routeFeature("saves/:id/commit"), ["projects"]);
  assert.deepEqual(routeFeature("link/:id"), ["projects"]); assert.deepEqual(routeFeature("live/ticket"), ["live", "collab"]); assert.deepEqual(routeFeature("live/start"), ["live"]); assert.deepEqual(routeFeature("collab/verify"), ["collab"]);
  assert.deepEqual(routeFeature("osu/search"), ["songs"]); assert.deepEqual(routeFeature("osu/user"), ["mappers", "songs"]);
  assert.deepEqual(routeFeature("osu/set"), ["songs", "preview"], "map lookups also serve the player: refused only when both are off");
  assert.deepEqual(routeFeature("osu/scores"), ["replays"], "the top 50 scores of a replay's map follow the Replays switch only");
  assert.deepEqual(routeFeature("replays"), ["replays"]); assert.deepEqual(routeFeature("replays/:id"), ["replays"]);
  for (const k of ["me", "changelog", "errors", "feedback", "admin/features", "admin/settings", "access/request", "invite", "me/account"]) assert.equal(routeFeature(k), null, k);
});
