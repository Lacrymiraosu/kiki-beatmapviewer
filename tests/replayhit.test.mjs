// A replay's real hits on the playfield (js/replayana.js rpHitState, drawn by js/player.js rpHead): what one circle / slider head shows at a
// song time t, from its analysis entry alone (stateless: a seek either way gives the same answer). Hand-made entries for each case, then the
// engine's own entries on a small map so the fields line up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js", "js/parse.js", "js/replayana.js"]);
const W = { w300: 50, w100: 100, w50: 150 }; // (OD 5)
const at = (e, t, w = W) => J(P.rpHitState(e, t, w));
const hit = (t, press, judge, slider = false) => ({ i: 0, t, x: 100, y: 100, press, err: press - t, dx: 0, dy: 0, judge, key: "K1", slider });
const miss = (t, slider = false) => ({ i: 0, t, x: 100, y: 100, press: null, err: null, dx: null, dy: null, judge: 0, key: null, slider });
const PENDING = { head: 1, appr: true, burst: -1, judge: null, jAge: -1 };

test("pending: before the press (and before the object time) the head and the approach circle show, nothing else", () => {
  assert.deepEqual(at(hit(1000, 1010, 300), 400), { ...PENDING, judge: 300 });
  assert.deepEqual(at(miss(1000), 400), { ...PENDING, judge: 0 });
});

test("early hit: the head goes at the press (before the object time), the burst and the 300 start there", () => {
  const e = hit(1000, 970, 300);
  assert.deepEqual(at(e, 969), { ...PENDING, judge: 300 });
  assert.deepEqual(at(e, 970), { head: 0, appr: false, burst: 0, judge: 300, jAge: 0 });
  assert.deepEqual(at(e, 1000), { head: 0, appr: false, burst: 30, judge: 300, jAge: 30 }); // (at the object time: 30 ms into it, not 0)
});

test("late hit: the head and the approach circle stay past the object time until the press", () => {
  const e = hit(1000, 1080, 100);
  for (const t of [1000, 1040, 1079.9]) assert.deepEqual(at(e, t), { ...PENDING, judge: 100 });
  assert.deepEqual(at(e, 1080), { head: 0, appr: false, burst: 0, judge: 100, jAge: 0 });
  assert.deepEqual(at(e, 1300), { head: 0, appr: false, burst: 220, judge: 100, jAge: 220 });
});

test("100 and 50: the judgement is the entry's own, never 300", () => {
  assert.equal(at(hit(1000, 1070, 100), 1100).judge, 100);
  assert.equal(at(hit(1000, 880, 100), 900).judge, 100);
  assert.equal(at(hit(1000, 1130, 50), 1200).judge, 50);
  assert.equal(at(hit(1000, 860, 50), 900).judge, 50);
});

test("miss: the head stays to the end of the window (w50), then fades over 200 ms with the miss mark; no burst ever", () => {
  const e = miss(1000);
  assert.deepEqual(at(e, 1000), { ...PENDING, judge: 0 });
  assert.deepEqual(at(e, 1149), { ...PENDING, judge: 0 }); // (before the end of the window: still hittable, no mark)
  assert.deepEqual(at(e, 1150), { head: 1, appr: false, burst: -1, judge: 0, jAge: 0 });
  assert.deepEqual(at(e, 1250), { head: .5, appr: false, burst: -1, judge: 0, jAge: 100 });
  assert.deepEqual(at(e, 1400), { head: 0, appr: false, burst: -1, judge: 0, jAge: 250 });
  // another OD: the end of the window follows it
  assert.equal(at(e, 1119, { w300: 32, w100: 76, w50: 120 }).jAge, -1);
  assert.equal(at(e, 1120, { w300: 32, w100: 76, w50: 120 }).jAge, 0);
  // seeking back: the same t gives the same answer, whatever came before
  assert.deepEqual(at(e, 1250), at(e, 1250)); assert.deepEqual(at(e, 1000), { ...PENDING, judge: 0 });
});

test("slider head: a hit bursts at the press with no number; a miss has neither burst nor number", () => {
  const h = hit(2000, 2030, 300, true);
  assert.deepEqual(at(h, 2010), { ...PENDING, judge: null });
  assert.deepEqual(at(h, 2030), { head: 0, appr: false, burst: 0, judge: null, jAge: -1 });
  assert.deepEqual(at(h, 2500), { head: 0, appr: false, burst: 470, judge: null, jAge: -1 });
  const m = miss(2000, true);
  assert.deepEqual(at(m, 2100), { ...PENDING, judge: null });
  assert.deepEqual(at(m, 2200), { head: .75, appr: false, burst: -1, judge: null, jAge: -1 });
});

test("spinner / no entry / odd entries: null (no effect at all)", () => {
  assert.equal(P.rpHitState(undefined, 1000, W), null); // (spinners have no entry: the engine skips them)
  assert.equal(P.rpHitState(null, 1000, W), null);
  assert.equal(P.rpHitState({}, 1000, W), null);
  assert.equal(P.rpHitState(hit(1000, 1010, 300), NaN, W), null);
  assert.equal(P.rpHitState(hit(NaN, 1010, 300), 1000, W), null);
  assert.equal(P.rpHitState({ ...hit(1000, 1010, 300), press: null }, 1000, W), null); // (a hit without a press)
  assert.equal(P.rpHitState({ ...hit(1000, 1010, 300), judge: 200 }, 1000, W), null);
  assert.equal(P.rpHitState(miss(1000), 1000, null), null); // (a miss needs the windows)
  assert.equal(P.rpHitState(miss(1000), 1000, {}), null);
  assert.equal(P.rpHitState("x", 1000, W), null);
});

// the engine's own entries: a small map (CS 4, OD 5: judged at 49.5 / 99.5 / 149.5), taps from rows [t, x, y, key]
const osu = objects => P.parseOsu(`osu file format v14\n\n[General]\nStackLeniency: 0.7\nMode: 0\n\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`);
function replay(rows) {
  const n = rows.length, f = { n, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), k: new Uint8Array(n) };
  rows.forEach(([t, x, y, k], i) => { f.t[i] = t; f.x[i] = x; f.y[i] = y; f.k[i] = k; });
  return { mode: 0, mapMd5: "0".repeat(32), player: "test", counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 }, mods: 0, lazerInfo: null, frames: f };
}
const taps = list => [[0, 256, 192, 0], ...list.flatMap(([t, x, y, k = 5]) => [[t, x, y, k], [t + 30, x, y, 0]])].sort((a, b) => a[0] - b[0]);

test("with rpAnalyze's entries: on time, early, late 100, late 50, miss, slider head hit and miss, spinner skipped", () => {
  const m = osu(["100,100,1000,1,0,0:0:0:0:", "200,100,2000,1,0,0:0:0:0:", "300,100,3000,1,0,0:0:0:0:", "400,100,4000,1,0,0:0:0:0:", "100,300,5000,1,0,0:0:0:0:",
    "200,300,6000,2,0,L|300:300,1,100,0|0,0:0|0:0,0:0:0:0:", "256,192,7500,12,0,9000,0:0:0:0:", "100,200,10000,2,0,L|200:200,1,100,0|0,0:0|0:0,0:0:0:0:"]);
  const d = replay(taps([[1000, 100, 100], [1960, 200, 100], [3080, 300, 100], [4130, 400, 100], [6040, 200, 300]])); // (5000 and the 10000 slider: no press)
  const a = P.rpAnalyze(d, m, { rate: 1, hr: false, ez: false, list: [] });
  assert.equal(a.ok, true);
  const by = []; for (const e of a.hits) by[e.i] = e;
  assert.equal(by[6], undefined); // (the spinner: no entry)
  assert.equal(P.rpHitState(by[6], 8000, a.windows), null);
  const w = a.windows, s = (i, t) => J(P.rpHitState(by[i], t, w));
  assert.deepEqual(s(0, 1000), { head: 0, appr: false, burst: 0, judge: 300, jAge: 0 });
  assert.deepEqual(s(1, 1959), { ...PENDING, judge: 300 }); assert.equal(s(1, 2000).burst, 40);
  assert.deepEqual(s(2, 3050), { ...PENDING, judge: 100 }); assert.deepEqual(s(2, 3080), { head: 0, appr: false, burst: 0, judge: 100, jAge: 0 });
  assert.equal(s(3, 4130).judge, 50);
  assert.deepEqual(s(4, 5100), { ...PENDING, judge: 0 }); assert.deepEqual(s(4, 5000 + w.w50), { head: 1, appr: false, burst: -1, judge: 0, jAge: 0 });
  assert.deepEqual(s(5, 6040), { head: 0, appr: false, burst: 0, judge: null, jAge: -1 });
  assert.deepEqual(s(7, 10000 + w.w50 + 100), { head: .5, appr: false, burst: -1, judge: null, jAge: -1 });
  for (const e of a.hits) for (const t of [e.t - 500, e.t, e.t + 100, e.t + 300]) { const r = P.rpHitState(e, t, w); assert.ok(r); if (r.judge !== null) assert.equal(r.judge, e.judge); }
});
