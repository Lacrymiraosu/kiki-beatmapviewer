// The replay analysis (js/replayana.js): judgement rules on small hand-made maps and replays with known answers (windows,
// notelock, sliders, spinners, HR mirroring and stacking, key attribution), the keys / cursor summaries, odd input, and
// (optional, files not in the repo) two real replays against their own maps:
//   OBV_OSR_SAMPLE=/path/std-replay.osr OBV_OSZ_SAMPLE=/path/set39804.osz   (stable, nomod)
//   OBV_OSR_SAMPLE2=/path/user-replay.osr OBV_OSZ_SAMPLE2=/path/set158899.osz (stable, HD HR)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js", "js/parse.js", "js/replayana.js"]);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const NOMOD = { rate: 1, hr: false, ez: false, list: [] };

// a small map: CS 4 (radius 36.49), OD 5 (windows 50 / 100 / 150 -> judged at 49.5 / 99.5 / 149.5), AR 5 (preempt 1200)
const osu = (objects, { cs = 4, od = 5, ar = 5 } = {}) => P.parseOsu(`osu file format v14\n\n[General]\nStackLeniency: 0.7\nMode: 0\n\n[Difficulty]\nCircleSize:${cs}\nOverallDifficulty:${od}\nApproachRate:${ar}\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`);
const circle = (x, y, t) => `${x},${y},${t},1,0,0:0:0:0:`;
// a replay from [t, x, y, keys] rows (keys as stored: K1 = 5, K2 = 10, M1 = 1, M2 = 2)
function replay(rows, extra = {}) {
  const n = rows.length, f = { n, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), k: new Uint8Array(n) };
  rows.forEach(([t, x, y, k], i) => { f.t[i] = t; f.x[i] = x; f.y[i] = y; f.k[i] = k; });
  return { mode: 0, mapMd5: "0".repeat(32), player: "test", counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 }, mods: 0, lazerInfo: null, frames: f, ...extra };
}
// a tap: key down at t (cursor at x, y), up 30 ms later
const tap = (t, x, y, k = 5) => [[t, x, y, k], [t + 30, x, y, 0]];
const taps = list => [[0, 256, 192, 0], ...list.flatMap(a => tap(...a))].sort((a, b) => a[0] - b[0]);

test("windows: osu!'s formula, judged at floor(w) - 0.5", () => {
  assert.deepEqual(J(P.rpAnaWindows(5)), { w300: 50, w100: 100, w50: 150 });
  assert.deepEqual(J(P.rpAnaWindows(8)), { w300: 32, w100: 76, w50: 120 });
  const a = P.rpAnalyze(replay(taps([[1000, 100, 100]])), osu([circle(100, 100, 1000)]), NOMOD);
  assert.deepEqual(J(a.judge), { w300: 49.5, w100: 99.5, w50: 149.5 });
  assert.equal(a.od, 5); assert.ok(near(a.radius, 64 * (1 - .7 * (4 - 5) / 5) / 2 * 1.00041)); assert.equal(a.preempt, 1200);
});

test("timing: early / late / 300 / 100 / 50 / miss on cursor-on-target presses", () => {
  const m = osu([circle(100, 100, 1000), circle(200, 100, 2000), circle(300, 100, 3000), circle(400, 100, 4000), circle(100, 300, 5000), circle(200, 300, 6000)]);
  const d = replay(taps([[1010, 100, 100], [1940, 200, 100, 10], [3120, 300, 100], [5049, 102, 300, 10], [6050, 200, 300]]));
  d.counts = { n300: 2, n100: 2, n50: 1, geki: 0, katu: 0, miss: 1 };
  const a = P.rpAnalyze(d, m, NOMOD), h = J(a.hits);
  assert.equal(a.ok, true); assert.deepEqual(J(a.warn), ["few_objects"]);
  assert.deepEqual(h.map(x => x.judge), [300, 100, 50, 0, 300, 100]);
  assert.deepEqual(h.map(x => x.err), [10, -60, 120, null, 49, 50]);
  assert.deepEqual(h.map(x => x.key), ["K1", "K2", "K1", null, "K2", "K1"]);
  assert.equal(h[4].dx, 2); assert.equal(h[4].dy, 0); assert.equal(h[3].press, null);
  const s = a.stats;
  assert.deepEqual(J(s.est), { n300: 2, n100: 2, n50: 1, miss: 1 });
  assert.equal(s.n, 6); assert.equal(s.hit, 5); assert.equal(s.early, 1); assert.equal(s.late, 4);
  const errs = [10, -60, 120, 49, 50], mean = errs.reduce((x, y) => x + y) / 5, sd = Math.sqrt(errs.reduce((x, e) => x + (e - mean) ** 2, 0) / 5);
  assert.ok(near(s.mean, mean)); assert.ok(near(s.sd, sd)); assert.ok(near(s.ur, 10 * sd)); assert.equal(s.median, 49);
  assert.equal(a.consistency.diff, 0); assert.equal(a.consistency.quality, "good"); assert.equal(a.consistency.d300, 0);
});

test("window edges: 150 ms late is past the 50 window (miss, and the press is empty)", () => {
  const m = osu([circle(100, 100, 1000), circle(300, 100, 2000)]);
  const a = P.rpAnalyze(replay(taps([[1150, 100, 100], [2149, 300, 100]])), m, NOMOD);
  assert.deepEqual(J(a.hits).map(x => x.judge), [0, 50]);
  assert.deepEqual(J(a.empty), [{ t: 1150, x: 100, y: 100, why: "none" }]);
});

test("empty presses: nothing to hit, off the circle in its window (aim), then the object is still hittable", () => {
  const m = osu([circle(100, 100, 1000)]);
  const a = P.rpAnalyze(replay(taps([[300, 400, 300], [990, 200, 100], [1020, 110, 110]])), m, NOMOD);
  assert.deepEqual(J(a.empty).map(e => e.why), ["none", "aim"]);
  assert.equal(a.hits[0].judge, 300); assert.equal(a.hits[0].err, 20); assert.equal(a.hits[0].dx, 10); assert.equal(a.hits[0].dy, 10);
  assert.equal(a.stats.aim, 1); assert.equal(a.stats.empty, 2);
});

test("radius: a press just inside / just outside the circle", () => {
  const m = osu([circle(100, 100, 1000), circle(300, 100, 2000)]), r = 64 * (1 - .7 * (4 - 5) / 5) / 2 * 1.00041;
  const a = P.rpAnalyze(replay(taps([[1000, 100 + r - .01, 100], [2000, 300 + r + .01, 100]])), m, NOMOD);
  assert.deepEqual(J(a.hits).map(x => x.judge), [300, 0]);
});

test("notelock (stable): a later object cannot be hit while an earlier one is still in its window", () => {
  const m = osu([circle(100, 100, 1000), circle(300, 100, 1100)]);
  // presses on B at 1050 and 1110 (A can still be hit until 1149.5): both used up; at 1160 A is a miss and B takes the press
  const a = P.rpAnalyze(replay(taps([[1050, 300, 100], [1110, 300, 100], [1160, 300, 100]])), m, NOMOD), h = J(a.hits);
  assert.deepEqual(J(a.empty).map(e => [e.t, e.why]), [[1050, "lock"], [1110, "lock"]]);
  assert.equal(h[0].judge, 0); assert.equal(h[1].judge, 100); assert.equal(h[1].err, 60);
  assert.equal(a.stats.lock, 2);
  // once A is hit, B is free
  const b = P.rpAnalyze(replay(taps([[1000, 100, 100], [1050, 300, 100]])), m, NOMOD);
  assert.deepEqual(J(b.hits).map(x => [x.judge, x.err]), [[300, 0], [100, -50]]);
});

test("objects at the same time can be hit in any order; the press never skips to a later time", () => {
  const m = osu([circle(100, 100, 1000), circle(300, 100, 1000), circle(400, 300, 1050)]);
  const a = P.rpAnalyze(replay(taps([[995, 300, 100, 5], [1000, 100, 100, 10], [1040, 400, 300, 5]])), m, NOMOD);
  assert.deepEqual(J(a.hits).map(x => [x.judge, x.press, x.key]), [[300, 1000, "K2"], [300, 995, "K1"], [300, 1040, "K1"]]);
});

test("early presses on the next object do nothing (stable) and are counted", () => {
  const m = osu([circle(100, 100, 1000)]);
  const a = P.rpAnalyze(replay(taps([[700, 100, 100], [200, 100, 100], [1005, 100, 100]])), m, NOMOD);
  assert.deepEqual(J(a.empty).map(e => [e.t, e.why]), [[200, "none"], [700, "early"]]); // (200: before the circle appears, 1200 ms preempt)
  assert.equal(a.stats.earlyNear, 1); assert.equal(a.hits[0].judge, 300);
});

test("sliders: a.hits head is timed and 300; the estimate counts the slider's real result; presses during sliders and spinners are not empty", () => {
  const m = osu([circle(100, 100, 500), "100,200,1000,2,0,L|300:200,1,200", "256,192,3000,12,0,4000", circle(400, 300, 5000)]);
  assert.deepEqual(J(m.hit.map(o => o.kind)), ["circle", "slider", "spinner", "circle"]);
  const rows = taps([[500, 100, 100], [1110, 100, 200], [3200, 256, 192], [3300, 256, 192], [3400, 256, 192], [5000, 400, 300]]);
  rows.push([1150, 120, 200, 0], [1180, 140, 200, 10], [1220, 160, 200, 0]); rows.sort((a, b) => a[0] - b[0]); // (a re-press inside the slider)
  // the cursor stays at the head and never follows the slider, and the spinner is never turned: the replay's counts say what the game would have counted
  const d = replay(rows); d.counts = { n300: 2, n100: 0, n50: 1, geki: 0, katu: 0, miss: 1 };
  const a = P.rpAnalyze(d, m, NOMOD), h = J(a.hits);
  assert.equal(h.length, 3); assert.deepEqual(h.map(x => x.i), [0, 1, 3]); assert.deepEqual(h.map(x => x.slider), [false, true, false]);
  assert.equal(h[1].judge, 300); assert.equal(h[1].err, 110); // (110 ms late would be a 50 on a circle; a.hits keeps the head as 300 whatever the slider did: the hit effects read it)
  assert.equal(a.stats.body, 4); assert.equal(a.stats.empty, 0); assert.equal(a.stats.spinners, 1);
  // the estimate follows the real results (a.sliders / a.spinners), no longer "head hit = 300, spinner = 300":
  assert.equal(a.sliders[0].judge, 50); assert.equal(a.spinners[0].judge, 0); // (head hit only: 1 of 3 nested; no rotation: a spinner miss)
  assert.deepEqual(J(a.stats.est), { n300: 2, n100: 0, n50: 1, miss: 0 }); // (the two circles, and the slider as the 50 it really was)
  assert.deepEqual(J(a.consistency.est), { n300: 2, n100: 0, n50: 1, miss: 1 }); // (+ the spinner as the miss it really was)
  assert.equal(a.consistency.diff, 0); assert.equal(a.consistency.quality, "good");
  // the same map with the slider followed and the spinner turned: everything is 300, in the estimate too
  const rows2 = taps([[500, 100, 100], [5000, 400, 300]]);
  for (let t = 1000; t <= 1760; t += 20) rows2.push([t, 100 + Math.min(200, (t - 1000) * .28), 200, t >= 1000 && t <= 1740 ? 5 : 0]);
  for (let t = 3000; t <= 4020; t += 20) { const g = (t - 3000) / 1000 * 2 * Math.PI * 4; rows2.push([t, 256 + 100 * Math.cos(g), 192 + 100 * Math.sin(g), t < 4000 ? 5 : 0]); }
  rows2.sort((x, y) => x[0] - y[0]);
  const f = replay(rows2); f.counts = { n300: 4, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 };
  const c = P.rpAnalyze(f, m, NOMOD);
  assert.equal(c.sliders[0].judge, 300); assert.equal(c.spinners[0].judge, 300);
  assert.deepEqual(J(c.stats.est), { n300: 3, n100: 0, n50: 0, miss: 0 }); assert.deepEqual(J(c.consistency.est), { n300: 4, n100: 0, n50: 0, miss: 0 });
  assert.equal(c.consistency.diff, 0); assert.equal(c.consistency.quality, "good");
  // a missed head is a miss in a.hits; here the slider was never followed either, so it is a miss in the estimate as well
  const b = P.rpAnalyze(replay(taps([[500, 100, 100], [5000, 400, 300]])), m, NOMOD);
  assert.deepEqual(J(b.hits).map(x => x.judge), [300, 0, 300]);
  assert.deepEqual(J(b.stats.est), { n300: 2, n100: 0, n50: 0, miss: 1 });
  // an analysis without a.sliders / a.spinners entries keeps the old rule: a slider counts by its head (300 when hit), a spinner as 300
  const legacy = JSON.parse(JSON.stringify(m)); legacy.hit[1].path = null; // (no path: rpaSliders skips it); the spinner has no end
  legacy.hit[2].end = legacy.hit[2].t;
  const old = P.rpAnalyze(d, legacy, NOMOD);
  assert.deepEqual(J(old.sliders), []); assert.deepEqual(J(old.spinners), []);
  assert.deepEqual(J(old.stats.est), { n300: 3, n100: 0, n50: 0, miss: 0 }); assert.deepEqual(J(old.consistency.est), { n300: 4, n100: 0, n50: 0, miss: 0 });
});

test("HR: the cursor is mirrored (y -> 384 - y), OD x1.4 and CS x1.3 apply, stacks sit at (rx - s, ry + s)", () => {
  const m = osu([circle(100, 100, 1000), circle(300, 100, 2000), circle(200, 50, 3000), circle(200, 50, 3100)], { cs: 4, od: 5 });
  const HR = P.replayMods(16, null); assert.equal(HR.hr, true);
  // in the replay the map is flipped: the first circle is at (100, 284); a press at (300, 100) is off the flipped second circle
  const a = P.rpAnalyze(replay(taps([[1000, 100, 284], [2000, 300, 100]])), m, HR), h = J(a.hits);
  assert.equal(a.od, 7); assert.ok(near(a.cs, 5.2)); assert.ok(near(a.radius, 64 * (1 - .7 * (5.2 - 5) / 5) / 2 * 1.00041));
  assert.deepEqual(J(a.windows), { w300: 38, w100: 84, w50: 130 });
  assert.equal(h[0].judge, 300); assert.equal(h[0].dy, 0); assert.equal(h[1].judge, 0);
  assert.equal(J(a.empty)[0].why, "aim"); assert.equal(J(a.empty)[0].y, 284); // (empty presses in the drawn frame too)
  // the stacked pair: parse.js stacks the earlier one up-left (stack 1); with HR it is up-left in the flipped game = down-left here
  assert.equal(m.hit[2].stack, 1); const s = a.radius / 10;
  assert.ok(near(h[2].x, 200 - s) && near(h[2].y, 50 + s)); assert.ok(near(h[3].x, 200) && near(h[3].y, 50));
  const n = P.rpAnalyze(replay([[0, 0, 0, 0]]), m, NOMOD), hn = J(n.hits);
  assert.ok(near(hn[2].y, 50 - n.radius / 10)); // (no HR: up-left, as drawn by parse.js)
  // mods omitted: made from data.mods
  const d = replay(taps([[1000, 100, 284]])); d.mods = 16;
  assert.equal(P.rpAnalyze(d, m).hr, true);
});

test("EZ halves OD and CS; DT / HT keep song ms and divide only the UR by the rate", () => {
  const m = osu([circle(100, 100, 1000), circle(300, 100, 2000), circle(100, 300, 3000)], { od: 8, cs: 4 });
  const rows = taps([[1010, 100, 100], [1980, 300, 100], [3030, 100, 300]]);
  const ez = P.rpAnalyze(replay(rows), m, P.replayMods(2, null));
  assert.equal(ez.od, 4); assert.equal(ez.cs, 2);
  const base = P.rpAnalyze(replay(rows), m, NOMOD), dt = P.rpAnalyze(replay(rows), m, P.replayMods(64, null)), ht = P.rpAnalyze(replay(rows), m, P.replayMods(256, null));
  assert.equal(dt.rate, 1.5); assert.equal(ht.rate, .75);
  assert.deepEqual(J(dt.hits), J(base.hits)); assert.deepEqual(J(ht.stats.est), J(base.stats.est));
  assert.ok(near(dt.stats.ur, base.stats.ur / 1.5)); assert.ok(near(ht.stats.ur, base.stats.ur / .75)); assert.equal(dt.stats.urSong, base.stats.urSong);
  assert.equal(dt.stats.mean, base.stats.mean);
});

test("keys: K / M attribution follows the key overlay's lit rule, two keys in one frame are two presses", () => {
  // K1 (5), up, M1 (1), up, K2 (10), up, M2 (2), K2 joins over M2 (10: M2's bit already down, K2 goes up), up, K1 + K2 in one frame (15)
  const rows = [[0, 0, 0, 0], [100, 0, 0, 5], [130, 0, 0, 0], [200, 0, 0, 1], [230, 0, 0, 0], [300, 0, 0, 10], [330, 0, 0, 0], [400, 0, 0, 2], [450, 0, 0, 10], [480, 0, 0, 0], [600, 0, 0, 15], [630, 0, 0, 0],
    [700, 0, 0, 5], [720, 0, 0, 1]]; // (K1 lets go while M1 stays: M1 lights up, a press)
  const a = P.rpAnalyze(replay(rows), osu([]), NOMOD);
  assert.deepEqual(J(a.keys.counts), { K1: 3, K2: 3, M1: 2, M2: 1 });
  assert.equal(a.keys.presses, 9); assert.equal(a.stats.presses, 9);
  // check against the player's own rpLit (js/player.js) for every k value
  const src = readFileSync(new URL("../js/player.js", import.meta.url), "utf8"), line = src.split("\n").find(l => l.startsWith("const rpLit ="));
  const rpLit = new Function(line + "; return rpLit;")();
  for (let k = 0; k < 32; k++) assert.equal(P.rpAnaLit(k), rpLit(k), "k=" + k);
});

test("keys: alternation, intervals (song ms, capped), tapping speed in real time", () => {
  const list = []; for (let i = 0; i < 16; i++) list.push([1000 + i * 100, 0, 0, i % 2 ? 10 : 5]);
  list.push([5000, 0, 0, 5], [5050, 0, 0, 5]); // (a long gap: no interval over 1000 ms; then a single-key double)
  const a = P.rpAnalyze(replay(taps(list)), osu([]), NOMOD), k = a.keys;
  assert.equal(k.presses, 18); assert.equal(Object.prototype.toString.call(k.intervals), "[object Float32Array]");
  assert.deepEqual(Array.from(k.intervals), [...Array(15).fill(100), 50]);
  assert.ok(near(k.altRatio, 16 / 17)); assert.ok(near(k.avgBpm, 150)); assert.ok(near(k.maxBpm, 150));
  const dt = P.rpAnalyze(replay(taps(list)), osu([]), P.replayMods(64, null)).keys;
  assert.ok(near(dt.avgBpm, 225)); assert.ok(near(dt.maxBpm, 225)); assert.deepEqual(Array.from(dt.intervals), Array.from(k.intervals));
  const few = P.rpAnalyze(replay(taps([[100, 0, 0], [200, 0, 0, 10]])), osu([]), NOMOD).keys;
  assert.equal(few.maxBpm, 0); assert.ok(near(few.avgBpm, 150)); assert.equal(few.altRatio, 1);
});

test("cursor heat grid: time per cell, mass kept, edges clamped, gaps capped at 500 ms", () => {
  const rows = [[0, 4, 4, 0], [100, 20, 4, 0], [300, 600, -50, 0], [400, 511, 383, 0], [2400, 4, 4, 0], [2500, 4, 4, 0]];
  const a = P.rpAnalyze(replay(rows), osu([]), NOMOD), g = a.cursor.grid; // (no objects: the whole replay is the span)
  assert.equal(g.w, 64); assert.equal(g.h, 48); assert.equal(g.cell, 8); assert.equal(g.data.length, 64 * 48);
  assert.equal(g.total, 100 + 200 + 100 + 500 + 100); // (the 2000 ms gap is capped)
  assert.equal(g.max, 500);
  const raw = Array.from(g.data, v => v * g.max), sum = raw.reduce((x, y) => x + y);
  assert.ok(near(sum, g.total, 1e-3));
  assert.ok(near(raw[0], 200, 1e-3)); assert.ok(near(raw[2], 200, 1e-3)); assert.ok(near(raw[63], 100, 1e-3)); assert.ok(near(raw[47 * 64 + 63], 500, 1e-3));
  assert.ok(near(a.cursor.distance, 16 + Math.hypot(580, 54) + Math.hypot(89, 433) + Math.hypot(507, 379), 1e-3));
  // HR mirrors the heat too; with objects the span is first - preempt .. last end + 200
  const m = osu([circle(100, 100, 2000)]);
  const h = P.rpAnalyze(replay([[0, 4, 4, 0], [5000, 4, 4, 0]]), m, P.replayMods(16, null));
  assert.deepEqual(J(h.cursor.span), [2000 - 900, 2200]); // (HR: AR 5 x1.4 = 7, preempt 900) assert.equal(h.cursor.grid.total, 500);
  assert.ok(near(h.cursor.grid.data[47 * 64], 1));
});

test("cursor speed: at most 600 points, bucket averages; jumps between hits", () => {
  const rows = []; for (let t = 0; t <= 1.2e6; t += 100) rows.push([t, (t / 100) % 2 ? 100 : 0, 0, 0]);
  const a = P.rpAnalyze(replay(rows), osu([]), NOMOD);
  assert.equal(a.cursor.speed.length, 600); assert.ok(a.cursor.speed.every(p => near(p.v, 1, 1e-6)));
  const short = P.rpAnalyze(replay([[0, 0, 0, 0], [1000, 100, 0, 0]]), osu([]), NOMOD);
  assert.equal(short.cursor.speed.length, 20); assert.ok(near(short.cursor.speed.reduce((s, p) => s + p.v, 0) * 50, 100, 1e-6));
  const m = osu([circle(100, 100, 1000), circle(400, 100, 1500), circle(400, 300, 2000)]);
  const b = P.rpAnalyze(replay(taps([[1000, 100, 100], [1500, 400, 100], [2000, 400, 300]])), m, NOMOD);
  assert.equal(b.cursor.jumpMax, 300); assert.equal(b.cursor.jumpAt, 1500);
});

test("rpAnalyzeAt: nearest object to a time", () => {
  const m = osu([circle(100, 100, 1000), circle(200, 100, 2000), circle(300, 100, 3000)]);
  const a = P.rpAnalyze(replay(taps([[1000, 100, 100]])), m, NOMOD);
  assert.deepEqual([0, 1400, 1600, 2500, 9999].map(t => P.rpAnalyzeAt(a, t)), [0, 0, 1, 1, 2]);
  assert.equal(P.rpAnalyzeAt(null, 5), -1); assert.equal(P.rpAnalyzeAt({ hits: [] }, 5), -1); assert.equal(P.rpAnalyzeAt(a, NaN), -1);
});

test("odd input never throws: no data, no frames, no map, no objects, spinners only, md5, mode, short replay, junk", () => {
  const m = osu([circle(100, 100, 1000)]);
  assert.deepEqual(J(P.rpAnalyze(null, m, NOMOD)), { ok: false, warn: ["no_data"] });
  assert.deepEqual(J(P.rpAnalyze(replay([]), m, NOMOD)), { ok: false, warn: ["no_frames"] });
  assert.deepEqual(J(P.rpAnalyze({ frames: null }, m, NOMOD)), { ok: false, warn: ["no_frames"] });
  assert.deepEqual(J(P.rpAnalyze(replay(taps([[1000, 1, 1]])), null, NOMOD)), { ok: false, warn: ["no_map"] });
  const z = P.rpAnalyze(replay(taps([[1000, 1, 1]])), osu([]), NOMOD);
  assert.equal(z.ok, true); assert.deepEqual(J(z.warn), ["no_objects"]); assert.equal(z.hits.length, 0); assert.equal(z.stats.mean, null); assert.equal(z.stats.ur, null);
  assert.equal(z.empty.length, 1);
  const sp = osu(["256,192,1000,12,0,3000", "256,192,4000,12,0,5000"]), d = replay(taps([[1500, 256, 192], [4500, 256, 192]]));
  d.counts.miss = 2; const s = P.rpAnalyze(d, sp, NOMOD);
  assert.equal(s.ok, true); assert.deepEqual(J(s.warn), ["no_objects"]); assert.equal(s.stats.spinners, 2); assert.equal(s.stats.body, 2);
  // the spinners are only tapped, never turned: each is a miss by its real result (a.spinners), no longer an assumed 300; the header here says the same
  assert.deepEqual(J(s.spinners.map(x => x.judge)), [0, 0]);
  assert.deepEqual(J(s.consistency.est), { n300: 0, n100: 0, n50: 0, miss: 2 }); assert.equal(s.consistency.quality, "good");
  // against a header that calls them cleared, the estimate is now 2 objects off ("good" is up to max(2, .5 %): the tolerance is unchanged, the estimate is not)
  const cl = replay(taps([[1500, 256, 192], [4500, 256, 192]])); cl.counts.n300 = 2;
  assert.equal(P.rpAnalyze(cl, sp, NOMOD).consistency.diff, 2);
  assert.deepEqual(J(P.rpAnalyze(replay(taps([[1000, 100, 100]]), { mapMd5: "a".repeat(32) }), m, NOMOD, { md5: "B".repeat(32) }).warn), ["md5_mismatch", "few_objects"]);
  assert.deepEqual(J(P.rpAnalyze(replay(taps([[1000, 100, 100]]), { mapMd5: "a".repeat(32) }), m, NOMOD, { md5: "A".repeat(32) }).warn), ["few_objects"]);
  assert.ok(P.rpAnalyze(replay(taps([[1000, 100, 100]]), { mode: 1 }), m, NOMOD).warn.includes("mode"));
  const sh = P.rpAnalyze(replay(taps([[1000, 100, 100]])), osu([circle(100, 100, 1000), circle(100, 100, 90000)]), NOMOD);
  assert.ok(sh.warn.includes("short_replay")); assert.equal(sh.hits[1].judge, 0);
  // junk: NaN frames, odd map objects, a bogus rate
  const junk = replay([[0, NaN, NaN, 255], [10, 1e9, -1e9, 5], [20, 3, 3, 0]]);
  const jm = { mode: 0, diff: { CircleSize: "x", OverallDifficulty: null }, hit: [null, { t: NaN }, { t: 5, kind: "circle" }, { t: 6, kind: "slider", end: "z" }] };
  const r = P.rpAnalyze(junk, jm, { rate: -3, hr: true });
  assert.equal(r.ok, true); assert.equal(r.rate, 1); assert.equal(r.hits.length, 2);
  assert.doesNotThrow(() => JSON.stringify(P.rpAnalyze({ frames: { n: 5, t: [], x: [], y: [], k: [] } }, jm, NOMOD)));
  assert.equal(P.rpAnalyze(replay(taps([[1, 1, 1]])), { hit: "nope" }, NOMOD).ok, false);
});

test("lazer replays: the header counts come from lazer's statistics when present", () => {
  const d = replay(taps([[1000, 100, 100]]), { lazerInfo: { statistics: { great: 1, ok: 0, meh: 0, miss: 0 } } });
  const a = P.rpAnalyze(d, osu([circle(100, 100, 1000)]), NOMOD);
  assert.deepEqual(J(a.consistency.header), { n300: 1, n100: 0, n50: 0, miss: 0 }); assert.equal(a.consistency.quality, "good");
});

test("speed: 150k frames and 3000 objects well under 150 ms", () => {
  const objs = [], rows = [[0, 256, 192, 0]];
  for (let i = 0; i < 3000; i++) objs.push(circle(50 + (i * 37) % 400, 50 + (i * 53) % 280, 2000 + i * 100));
  const m = osu(objs);
  for (let t = 1; t < 302000; t += 2) { const i = Math.round((t - 2000) / 100), o = m.hit[Math.max(0, Math.min(2999, i))]; const ph = ((t - 2000) % 100 + 100) % 100; rows.push([t, o.x + (t % 7), o.y, t > 1990 && ph < 20 ? (i % 2 ? 10 : 5) : 0]); }
  const d = replay(rows); assert.ok(d.frames.n > 150000);
  let a, ms = Infinity; // (the best of 4: the first run warms up)
  for (let r = 0; r < 4; r++) { const t0 = performance.now(); a = P.rpAnalyze(d, m, NOMOD); ms = Math.min(ms, performance.now() - t0); }
  console.log(`# 150k frames / 3000 objects: ${ms.toFixed(1)} ms`);
  assert.equal(a.stats.est.n300 + a.stats.est.n100 + a.stats.est.n50, 3000);
  assert.ok(ms < 150, `took ${ms} ms`);
});

// ---- real replays (local files only; skipped otherwise)
function unzip(buf) { // (the .osz's central directory: stored and deflated entries)
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10), out = []; let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const meth = buf.readUInt16LE(p + 10), csz = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString("utf8"); p += 46 + nl + xl + cl;
    const s = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), d = buf.subarray(s, s + csz);
    out.push({ name, bytes: () => meth === 0 ? d : inflateRawSync(d) });
  }
  return out;
}
function realCase(osrPath, oszPath, patchMods) {
  let b = readFileSync(osrPath);
  if (patchMods != null) { b = Buffer.from(b); const off = 1 + 4 + 34 + 2 + Buffer.byteLength(P.parseOsr(b).player) + 34 + 12 + 4 + 2 + 1; b.writeInt32LE(patchMods, off); }
  const d = P.parseOsr(b), e = unzip(readFileSync(oszPath)).filter(x => x.name.endsWith(".osu")).map(x => x.bytes()).find(x => createHash("md5").update(x).digest("hex") === d.mapMd5);
  assert.ok(e, "the .osz has the replay's difficulty");
  const m = P.parseOsu(e.toString("utf8")), mods = P.replayMods(d.mods, d.lazerInfo), md5 = createHash("md5").update(e).digest("hex");
  const a = P.rpAnalyze(d, m, mods, { md5 });
  let best = Infinity; for (let i = 0; i < 5; i++) { const t0 = performance.now(); P.rpAnalyze(d, m, mods, { md5 }); best = Math.min(best, performance.now() - t0); }
  return { d, m, a, ms: best };
}
const errsOf = a => J(a.hits).filter(h => h.err !== null).map(h => h.err);
const R1 = [process.env.OBV_OSR_SAMPLE, process.env.OBV_OSZ_SAMPLE], R2 = [process.env.OBV_OSR_SAMPLE2, process.env.OBV_OSZ_SAMPLE2];
const have = R => R[0] && R[1] && existsSync(R[0]) && existsSync(R[1]);

test("a real stable replay on its map (OBV_OSR_SAMPLE + OBV_OSZ_SAMPLE, optional)", { skip: have(R1) ? false : "OBV_OSR_SAMPLE / OBV_OSZ_SAMPLE not set" }, () => {
  const { a, ms } = realCase(...R1), s = a.stats, c = a.consistency;
  console.log(`# ${JSON.stringify(c.header)} est ${JSON.stringify(c.est)} UR ${s.ur.toFixed(2)} mean ${s.mean.toFixed(2)} offset ${s.meanDx.toFixed(2)},${s.meanDy.toFixed(2)} dist ${s.meanDist.toFixed(2)} ${ms.toFixed(1)} ms`);
  assert.equal(a.ok, true); assert.deepEqual(J(a.warn), []);
  assert.ok(c.diff <= 3, "estimate within 3 objects of the header"); assert.equal(c.quality, "good");
  assert.ok(Math.abs(s.mean) < 5 && Math.abs(s.median) <= 5, "centred near 0");
  assert.ok(s.ur > 40 && s.ur < 200, "a plausible UR");
  const e = errsOf(a); assert.ok(e.every(x => Math.abs(x) <= a.judge.w50));
  assert.ok(e.filter(x => Math.abs(x) <= a.judge.w300).length / e.length > .98, "nearly all inside the 300 window");
  assert.ok(Math.abs(s.meanDx) < 4 && Math.abs(s.meanDy) < 4 && s.meanDist < a.radius * .6, "the cursor sits on the circles");
  assert.ok(a.keys.counts.K1 + a.keys.counts.K2 > 1500); assert.ok(a.keys.altRatio > .5);
  assert.ok(ms < 150, `took ${ms} ms`);
  // DT (mods patched to 64) and HT (256): the same judgement in song ms, the UR divided by the rate
  const dt = realCase(...R1, 64).a, ht = realCase(...R1, 256).a;
  assert.equal(dt.rate, 1.5); assert.equal(ht.rate, .75);
  assert.deepEqual(J(dt.stats.est), J(s.est)); assert.deepEqual(J(ht.stats.est), J(s.est));
  assert.ok(near(dt.stats.ur, s.ur / 1.5, 1e-9)); assert.ok(near(ht.stats.ur, s.ur / .75, 1e-9));
  assert.ok(near(dt.keys.avgBpm, a.keys.avgBpm * 1.5, 1e-9));
});

test("a real HD HR replay on its map (OBV_OSR_SAMPLE2 + OBV_OSZ_SAMPLE2, optional): mirroring and HR scaling", { skip: have(R2) ? false : "OBV_OSR_SAMPLE2 / OBV_OSZ_SAMPLE2 not set" }, () => {
  const { a, m, ms } = realCase(...R2), s = a.stats, c = a.consistency;
  console.log(`# ${JSON.stringify(c.header)} est ${JSON.stringify(c.est)} UR ${s.ur.toFixed(2)} mean ${s.mean.toFixed(2)} offset ${s.meanDx.toFixed(2)},${s.meanDy.toFixed(2)} dist ${s.meanDist.toFixed(2)} ${ms.toFixed(1)} ms`);
  assert.equal(a.hr, true); assert.equal(a.od, Math.min(10, +m.diff.OverallDifficulty * 1.4)); assert.ok(near(a.cs, +m.diff.CircleSize * 1.3));
  assert.ok(c.diff <= 3, "estimate within 3 objects of the header"); assert.equal(c.quality, "good");
  assert.ok(Math.abs(s.meanDx) < 4 && Math.abs(s.meanDy) < 4 && s.meanDist < a.radius * .6, "mirrored: the cursor sits on the circles");
  assert.ok(Math.abs(s.mean) < 10 && s.ur > 40 && s.ur < 250);
  assert.ok(ms < 150, `took ${ms} ms`);
  // without the mirror nearly everything would be off its circle
  const flat = P.rpAnalyze(P.parseOsr(readFileSync(R2[0])), m, { ...P.replayMods(0, null), hr: false });
  assert.ok(flat.stats.est.miss > c.est.n300 / 2);
});
