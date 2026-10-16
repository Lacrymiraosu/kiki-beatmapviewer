// The map's own epilepsy warning (js/player.js epiWarn): from [General] EpilepsyWarning: 1, on every open, 5 s, no setting to turn it off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");

test("epilepsy warning: read from the map (not with the storyboard off), shown on every open (selectDiff), kept 5 s by timers, no setting", () => {
  const pl = read("js/player.js"), app = read("js/app.js"), core = read("js/core.js"), css = read("assets/app.css");
  assert.match(pl, /function epiWarn\(\)/);
  assert.match(pl, /if \(!map \|\| !S\.sb \|\| String\(map\.general\.EpilepsyWarning \|\| ""\)\.trim\(\) !== "1"\) return 0;/, "not with the storyboard off");
  assert.match(pl, /setTimeout\(\(\) => el\.classList\.add\("out"\), 4600\), setTimeout\(\(\) => \{ el\.remove\(\);[^}]*\}, 5000\)/);
  assert.match(pl, /el\.setAttribute\("role", "alert"\)/);
  assert.match(app, /const epi = epiWarn\(\);[\s\S]{0,200}setTimeout\(sbglSuggest, epi \? epi \+ 400 : 400\)/, "the WebGL offer waits for the warning");
  assert.doesNotMatch(core, /epi/i, "no setting for it");
  assert.match(css, /\.epiwarn\{[^}]*pointer-events:none/);
  assert.match(css, /\.epiwarn\.ed\{/);
  for (const l of ["en", "th", "ms", "id", "ko", "ja"]) assert.ok(JSON.parse(read(`i18n/${l}.json`))["This beatmap contains scenes with rapidly flashing colours. Please take caution if you are affected by epilepsy."], l);
});
