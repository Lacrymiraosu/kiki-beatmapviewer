// The replay's analysis is made before it plays (js/player.js rpHitsPrepare): the first frame's rpHits() is a cache hit, nothing runs in the playback,
// a failed analysis is kept (not run again), a job already running is waited for, and the analysis sees the radius a replay's EZ / HR gives. The
// functions are cut out of js/player.js and run in a vm with stubs for the page's globals.
import { test } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import vm from "node:vm";
const src = readFileSync(new URL("../js/player.js", import.meta.url), "utf8");
const a = src.indexOf("const RPH = {"), b = src.indexOf("// a circle or a slider head in a replay as rpHitState says");
assert.ok(a > 0 && b > a, "player.js: the RPH block moved");
function make(over = {}) {
  const calls = [], hit = [{ kind: "circle", t: 100 }, { kind: "circle", t: 200 }];
  const cx = { console, setTimeout, map: { hit, radius: 40, diff: { CircleSize: 4, ApproachRate: 8, OverallDifficulty: 8 } }, RP: { on: false, data: null, mods: null }, osuFiles: [], curDiff: 0, files: {}, norm: x => x, dirty: false,
    loadLazy: async () => {}, md5Hex: () => "", rpHitState: () => {}, rpSpinState: () => {}, rpSlFor: () => null, rpSpFor: () => null,
    replayDiff: (d, m) => ({ cs: m.hr ? 6 : +d.CircleSize, ar: +d.ApproachRate }), diffDerived: (m, mod) => { m.radius = 10 * mod.cs; },
    rpAnalyze(d, m, mods) { calls.push({ radius: m.radius, on: cx.RP.on }); return { ok: true, warn: [], hits: [{ i: 0 }, { i: 1 }], sliders: [], spinners: [] }; }, ...over };
  vm.createContext(cx); vm.runInContext(src.slice(a, b) + "\nthis.api = { RPH, rpHits, rpHitsPrepare, rpHitsReady };", cx);
  return { cx, calls, api: cx.api, d: { frames: { n: 0 } } };
}
test("prepare before the start: rpHits is a cache hit at once, no second analysis", async () => {
  const { cx, calls, api, d } = make();
  assert.equal(api.rpHitsReady(d), false);
  await api.rpHitsPrepare(d, { rate: 1 });
  assert.equal(calls.length, 1); assert.equal(calls[0].on, false); assert.equal(api.rpHitsReady(d), true);
  cx.RP.on = true; cx.RP.data = d; cx.RP.mods = { rate: 1 };
  const by = api.rpHits(); assert.ok(by && by[1]); assert.equal(api.RPH.job, null);
  await new Promise(r => setTimeout(r, 20)); assert.equal(calls.length, 1);
  await api.rpHitsPrepare(d, { rate: 1 }); assert.equal(calls.length, 1, "already made: no new job");
});
test("a job that is running is waited for, not started twice", async () => {
  const { calls, api, d } = make();
  const p1 = api.rpHitsPrepare(d, { rate: 1 }), p2 = api.rpHitsPrepare(d, { rate: 1 });
  assert.equal(p1, p2); await p1; assert.equal(calls.length, 1);
});
test("HR / EZ: the analysis sees the mods' radius, the map's own is back after", async () => {
  const { cx, calls, api, d } = make();
  await api.rpHitsPrepare(d, { rate: 1, hr: true });
  assert.equal(calls[0].radius, 60); assert.equal(cx.map.radius, 40);
});
test("a failed analysis resolves (never rejects), is kept, and is tried again by the next prepare only", async () => {
  let n = 0; const { cx, api, d } = make({ rpAnalyze: () => { n++; return { ok: false, warn: ["x"] }; } });
  await api.rpHitsPrepare(d, {}); assert.equal(api.RPH.failed, true); assert.equal(api.RPH.byI, null);
  cx.RP.on = true; cx.RP.data = d; cx.RP.mods = {}; assert.equal(api.rpHits(), null); assert.equal(api.RPH.job, null, "no job in the frames"); assert.equal(n, 1);
  assert.equal(api.rpHitsReady(d), false); await api.rpHitsPrepare(d, {}); assert.equal(n, 2);
  const t = make({ rpAnalyze: () => { throw new Error("boom"); } }); await t.api.rpHitsPrepare(t.d, {}); assert.equal(t.api.RPH.failed, true);
});
