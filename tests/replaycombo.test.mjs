// The combo a replay really had (js/replayana.js: a.combo = { max, breaks: [{ t, combo }] }, rpaCombo): small hand-made maps and replays with known answers.
// The rules (osu!lazer: HitResult.IncreasesCombo / BreaksCombo, the judgements of circle, slider head, tick, repeat, tail and spinner) are in the comment above rpaCombo.
// Optional, files not in the repo: a real stable replay on its own map (OBV_REAL_OSR=/path/x.osr OBV_REAL_OSU=/path/map.osu), a real lazer one (OBV_REAL_LAZER_OSR / OBV_REAL_LAZER_OSU).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js", "js/parse.js", "js/replayana.js"]);
const NOMOD = { rate: 1, hr: false, ez: false, list: [] }, HR = { rate: 1, hr: true, ez: false, list: [] }, DT = { rate: 1.5, hr: false, ez: false, list: [] };

// CS 4, OD 5 (miss window end: 150 ms after the object time), AR 5; a 350 px slider takes 1250 ms with ticks at 1/3 and 2/3 of the path
const osu = (objects) => P.parseOsu(`osu file format v14\n\n[General]\nStackLeniency: 0.7\nMode: 0\n\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`);
const slider = (x, y, t, len, slides = 1) => `${x},${y},${t},2,0,L|${x + len}:${y},${slides},${len},${Array(slides + 1).fill(0).join("|")},${Array(slides + 1).fill("0:0").join("|")},0:0:0:0:`;
const circle = (x, y, t) => `${x},${y},${t},1,0,0:0:0:0:`;
const spinner = (t, end) => `256,192,${t},12,0,${end},0:0:0:0:`;
function replay(rows, extra = {}) {
  const n = rows.length, f = { n, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), k: new Uint8Array(n) };
  rows.forEach(([t, x, y, k], i) => { f.t[i] = t; f.x[i] = x; f.y[i] = y; f.k[i] = k; });
  return { mode: 0, mapMd5: "0".repeat(32), player: "test", counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 }, mods: 0, lazerInfo: null, frames: f, ...extra };
}
// frames every `step` ms in [from, to]: the cursor at pos(t), a key down in [down, up)
function run(from, to, pos, { down = from, up = Infinity, step = 10, key = 5 } = {}) {
  const rows = []; for (let t = from; t <= to; t += step) { const p = pos(t) || [500, 380]; rows.push([t, p[0], p[1], t >= down && t < up ? key : 0]); }
  return rows;
}
const tapAt = (t, x, y) => [[t - 10, x, y, 0], [t, x, y, 5], [t + 30, x, y, 0]];
const build = (...chunks) => [[0, 256, 192, 0], ...chunks.flat()].sort((a, b) => a[0] - b[0]);
const ball = (m, i) => t => { const o = m.hit[i], p = P.pointAt(o, P.ballF(o, t).f); return [p[0], p[1]]; };
const spin = (turns, from, to) => t => { const u = Math.max(0, Math.min(1, (t - from) / (to - from))), g = 2 * Math.PI * turns * u; return [256 + 100 * Math.cos(g), 192 + 100 * Math.sin(g)]; };
// (a.combo also holds the time series `at` (typed arrays): the older checks compare the max and the breaks alone)
const C = c => J({ max: c.max, breaks: c.breaks });
const analyse = (m, rows, mods = NOMOD) => { const a = P.rpAnalyze(replay(rows), m, mods); assert.equal(a.ok, true); return a; };

// circle 500, slider 1000..2250 (head, ticks 1500 / 2000, tail judged from 2214), circle 3000, spinner 4000..5000 (OD 5: 2 rotations): 7 combo points
const M = () => osu([circle(100, 100, 500), slider(100, 200, 1000, 350), circle(400, 300, 3000), spinner(4000, 5000)]);
const scene = (m, { slide = run(900, 2400, ball(m, 1), { down: 1000 }), turns = 4 } = {}) =>
  build(tapAt(500, 100, 100), slide, tapAt(3000, 400, 300), run(3900, 5100, spin(turns, 4000, 5000), { down: 4000, up: 5000 }));
const parts = s => s.parts.map(p => [p.kind, p.hit]);

test("a full combo: every object hit, no break, the max is every combo point (spinner included)", () => {
  const m = M(), a = analyse(m, scene(m));
  assert.deepEqual(J(a.hits).map(h => h.judge), [300, 300, 300]);
  assert.equal(a.sliders[0].judge, 300); assert.equal(a.spinners[0].judge, 300);
  assert.deepEqual(C(a.combo), { max: 7, breaks: [] }); // (circle, head, 2 ticks, tail, circle, spinner)
  assert.deepEqual(Object.keys(a.combo).sort(), ["at", "breaks", "max"]);
});

test("a missed circle in the middle: one break at t + the miss window end, with the combo before it", () => {
  const m = osu([0, 1, 2, 3, 4, 5].map(i => circle(60 + 60 * i, 100, 500 + 400 * i)));
  const a = analyse(m, build([0, 1, 3, 4, 5].flatMap(i => tapAt(500 + 400 * i, 60 + 60 * i, 100))));
  assert.deepEqual(J(a.hits).map(h => h.judge), [300, 300, 0, 300, 300, 300]);
  assert.equal(a.windows.w50, 150);
  assert.deepEqual(C(a.combo), { max: 3, breaks: [{ t: 500 + 800 + 150, combo: 2 }] }); // (the longest run is the one after the miss)
});

test("consecutive misses: each one breaks, the later ones with combo 0", () => {
  const m = osu([0, 1, 2, 3, 4].map(i => circle(60 + 60 * i, 100, 500 + 400 * i)));
  const b = analyse(m, build(tapAt(500, 60, 100), tapAt(2100, 300, 100)));
  assert.deepEqual(J(b.hits).map(h => h.judge), [300, 0, 0, 0, 300]);
  assert.deepEqual(C(b.combo), { max: 1, breaks: [{ t: 900 + 150, combo: 1 }, { t: 1300 + 150, combo: 0 }, { t: 1700 + 150, combo: 0 }] });
});

test("a missed tick breaks (at the tick's time), the tail after it gives no point and does not break again", () => {
  const m = M(), b0 = ball(m, 1);
  const a = analyse(m, scene(m, { slide: run(900, 2400, t => t < 1700 ? b0(t) : [b0(t)[0], b0(t)[1] + 200], { down: 1000 }) }));
  const s = J(a.sliders[0]);
  assert.equal(s.head, true); assert.deepEqual(parts(s), [["tick", true], ["tick", false], ["tail", false]]);
  // circle, head, tick = 3; the tick at 2000 is missed; the missed tail is nothing; then circle and spinner = 2
  assert.deepEqual(C(a.combo), { max: 3, breaks: [{ t: 2000, combo: 3 }] });
});

test("a missed tail alone: no point, no break (IgnoreMiss); the same slider with the tail hit has one more", () => {
  const m = M();
  const a = analyse(m, scene(m, { slide: run(900, 2400, ball(m, 1), { down: 1000, up: 2100 }) })); // (the key is let go before the tail: 2214 on)
  assert.deepEqual(parts(J(a.sliders[0])), [["tick", true], ["tick", true], ["tail", false]]);
  assert.equal(a.sliders[0].judge, 100); // (3 of 4: the game's result is a 100, the combo is not broken by it)
  assert.deepEqual(C(a.combo), { max: 6, breaks: [] });
  assert.equal(analyse(m, scene(m)).combo.max, 7);
});

test("a slider head miss breaks at t + the window end; the parts followed after it still count", () => {
  const m = M(), a = analyse(m, scene(m, { slide: run(900, 2400, ball(m, 1), { down: 1300 }) })); // (the head is missed, then the slider is followed)
  assert.equal(a.sliders[0].head, false); assert.equal(a.hits[1].judge, 0);
  assert.deepEqual(parts(J(a.sliders[0])), [["tick", true], ["tick", true], ["tail", true]]);
  assert.deepEqual(C(a.combo), { max: 5, breaks: [{ t: 1000 + 150, combo: 1 }] }); // (the circle before it; then 2 ticks, tail, circle, spinner)
});

test("a slider that is never touched: head break, then the missed ticks break too (combo 0), the tail is nothing", () => {
  const m = M(), a = analyse(m, scene(m, { slide: [] }));
  assert.equal(a.sliders[0].judge, 0);
  assert.deepEqual(J(a.combo.breaks), [{ t: 1150, combo: 1 }, { t: 1500, combo: 0 }, { t: 2000, combo: 0 }]);
  assert.equal(a.combo.max, 2); // (the runs: circle 500 = 1, then circle 3000 + spinner = 2)
});

test("repeats count like ticks: a slider with a missed repeat breaks there", () => {
  const m = osu([slider(100, 200, 1000, 200, 3)]); // 3 slides of 200 px: repeats at 1714 and 2429, tail at the end
  const o = m.hit[0], full = analyse(m, run(900, o.end + 200, ball(m, 0), { down: 1000 }));
  const kinds = full.sliders[0].parts.map(p => p.kind);
  assert.ok(kinds.includes("repeat"));
  const nPts = 1 + full.sliders[0].parts.length; // (head + every part, the tail counts when hit)
  assert.deepEqual(C(full.combo), { max: nPts, breaks: [] });
  const b0 = ball(m, 0), lost = analyse(m, run(900, o.end + 200, t => t >= 1600 && t < 1800 ? [b0(t)[0], b0(t)[1] + 200] : b0(t), { down: 1000 }));
  const rep = lost.sliders[0].parts.find(p => p.kind === "repeat");
  assert.equal(rep.hit, false);
  assert.ok(lost.combo.breaks.some(x => x.t === rep.t), "a break at the repeat's judged time");
  assert.ok(lost.combo.max < nPts);
});

test("spinners: +1 for 300 / 100 / 50, a break for a miss; their ticks do not count", () => {
  const m = osu([circle(100, 100, 500), spinner(1000, 2000), circle(400, 300, 3000), spinner(4000, 5000)]); // (OD 5: 2 rotations per second)
  const go = (t1, t2) => build(tapAt(500, 100, 100), run(900, 2100, spin(t1, 1000, 2000), { down: 1000, up: 2000 }), tapAt(3000, 400, 300), run(3900, 5100, spin(t2, 4000, 5000), { down: 4000, up: 5000 }));
  const all = analyse(m, go(4, 4));
  assert.deepEqual(J(all.spinners.map(s => s.judge)), [300, 300]); assert.deepEqual(C(all.combo), { max: 4, breaks: [] });
  const part = analyse(m, go(4, 1.7)); // (1.7 of 2 rotations = .85: a 50, still a hit)
  assert.equal(part.spinners[1].judge, 50); assert.deepEqual(C(part.combo), { max: 4, breaks: [] });
  const miss2 = analyse(m, go(4, 0));
  assert.equal(miss2.spinners[1].judge, 0); assert.deepEqual(C(miss2.combo), { max: 3, breaks: [{ t: 5000, combo: 3 }] }); // (judged at the spinner's end)
  const miss1 = analyse(m, go(0, 4));
  assert.equal(miss1.spinners[0].judge, 0); assert.deepEqual(C(miss1.combo), { max: 2, breaks: [{ t: 2000, combo: 1 }] });
  // without spinners in the list the same replay would have a shorter combo: the spinners are part of it
  assert.equal(P.rpaCombo(m.hit, all.hits, all.sliders, [], all.windows.w50).max, 2);
});

test("DT and HR do not change the combo (judgement is in song time, the mirrored cursor follows the mirrored map)", () => {
  const m = M(), b0 = ball(m, 1);
  const rows = scene(m, { slide: run(900, 2400, t => t < 1700 ? b0(t) : [b0(t)[0], b0(t)[1] + 200], { down: 1000 }) });
  const base = analyse(m, rows).combo;
  assert.deepEqual(C(base), { max: 3, breaks: [{ t: 2000, combo: 3 }] });
  assert.deepEqual(C(analyse(m, rows, DT).combo), C(base));
  assert.deepEqual(C(analyse(m, rows.map(([t, x, y, k]) => [t, x, 384 - y, k]), HR).combo), C(base));
  assert.deepEqual(J({ t: Array.from(analyse(m, rows, DT).combo.at.t), v: Array.from(analyse(m, rows, DT).combo.at.v) }), J({ t: Array.from(base.at.t), v: Array.from(base.at.v) })); // (the series too)
});

test("odd input: no frames / no objects / junk never throw; the combo is absent or empty", () => {
  const m = M();
  const nf = P.rpAnalyze(replay([]), m, NOMOD); assert.equal(nf.ok, false); assert.equal(nf.combo, undefined);
  assert.equal(P.rpAnalyze(null, m, NOMOD).combo, undefined);
  const none = P.rpAnalyze(replay(build(tapAt(1000, 1, 1))), osu([]), NOMOD);
  assert.deepEqual(C(none.combo), { max: 0, breaks: [] });
  const junk = replay([[0, NaN, NaN, 255], [10, 1e9, -1e9, 5], [20, 3, 3, 0]]);
  const jm = { mode: 0, diff: { CircleSize: "x", OverallDifficulty: null }, hit: [null, { t: NaN }, { t: 5, kind: "circle" }, { t: 6, kind: "slider", end: "z" }] };
  assert.doesNotThrow(() => JSON.stringify(P.rpAnalyze(junk, jm, { rate: -3, hr: true }).combo));
  // (the circle and the slider head of the junk map are both missed; OD "null" reads as 0 there: the window ends 200 ms after)
  assert.deepEqual(C(P.rpAnalyze(junk, jm, { rate: -3, hr: true }).combo), { max: 0, breaks: [{ t: 205, combo: 0 }, { t: 206, combo: 0 }] });
  // the helper itself: empty lists, a slider with no entry of its own (head only), spinners with none
  assert.deepEqual(C(P.rpaCombo([], [], [], [], 150)), { max: 0, breaks: [] });
  const H = [{ t: 100, kind: "slider" }, { t: 200, kind: "circle" }, { t: 300, kind: "spinner" }];
  const hits = [{ i: 0, t: 100, judge: 300, press: 110 }, { i: 1, t: 200, judge: 0, press: null }];
  assert.deepEqual(C(P.rpaCombo(H, hits, [], [], 150)), { max: 1, breaks: [{ t: 350, combo: 1 }] });
});

// ---- the combo over time: a.combo.at, rpComboAt(a, t), rpAnaPoor(a)
const at = (a, t) => { const r = P.rpComboAt(a, t); return r && { combo: r.combo, since: r.since }; }; // (the result object is shared: copy it at once)

test("a.combo.at: one entry per combo event, v after the event, 0 at a break, no entry for a missed tail", () => {
  const m = M(), a = analyse(m, scene(m)), T = a.combo.at.t, V = a.combo.at.v;
  assert.ok(T instanceof Float64Array || T.constructor.name === "Float64Array"); assert.equal(V.constructor.name, "Int32Array");
  assert.deepEqual(J(Array.from(V)), [1, 2, 3, 4, 5, 6, 7]); // (circle, head, 2 ticks, tail, circle, spinner)
  assert.equal(Math.max(...V), a.combo.max); assert.equal(V[V.length - 1], 7);
  assert.ok(T.every((x, k) => k === 0 || T[k - 1] <= x), "in judged-time order");
  // the slider's tail missed (the cursor leaves the ball at 1700): head, tick 1500 hit, tick 2000 missed -> break; the tail has no entry
  const b0 = ball(m, 1), rows = scene(m, { slide: run(900, 2400, t => t < 1700 ? b0(t) : [b0(t)[0], b0(t)[1] + 200], { down: 1000 }) });
  const x = analyse(m, rows);
  assert.deepEqual(J(Array.from(x.combo.at.v)), [1, 2, 3, 0, 1, 2]); // (circle, head, tick, [tick missed = break], circle, spinner; the missed tail: nothing)
  assert.equal(x.combo.at.t.length, x.combo.breaks.length + 5);
  const y = analyse(m, scene(m, { slide: run(900, 2400, ball(m, 1), { down: 1000, up: 2150 }) })); // the key released before the tail
  assert.equal(y.combo.at.t.length, y.combo.at.v.length);
});

test("rpComboAt: the max, the break values, the last run, since, before the first event, seeking", () => {
  const m = osu([0, 1, 2, 3, 4, 5].map(i => circle(60 + 60 * i, 100, 500 + 400 * i)));
  const a = analyse(m, build([0, 1, 3, 4, 5].flatMap(i => tapAt(500 + 400 * i, 60 + 60 * i, 100))));
  const br = a.combo.breaks; assert.deepEqual(C(a.combo).breaks, [{ t: 1450, combo: 2 }]);
  // events: 500 -> 1, 900 -> 2, break 1450 -> 0, 1700 -> 1, 2100 -> 2, 2500 -> 3
  assert.deepEqual(at(a, 499.9), { combo: 0, since: -1 });
  assert.deepEqual(at(a, -1e9), { combo: 0, since: -1 });
  assert.deepEqual(at(a, 500), { combo: 1, since: 0 });
  assert.deepEqual(at(a, 650), { combo: 1, since: 150 });
  assert.deepEqual(at(a, 900), { combo: 2, since: 0 });
  assert.deepEqual(at(a, 1449.9).combo, br[0].combo); // (just before the break: the combo it breaks)
  assert.deepEqual(at(a, 1449.9), { combo: 2, since: 1449.9 - 900 });
  assert.deepEqual(at(a, 1450), { combo: 0, since: 550 }); // (since = from the last event that RAISED it)
  assert.deepEqual(at(a, 1699), { combo: 0, since: 799 });
  assert.deepEqual(at(a, 1700), { combo: 1, since: 0 });
  assert.deepEqual(at(a, 2500), { combo: 3, since: 0 });
  assert.deepEqual(at(a, 1e9), { combo: 3, since: 1e9 - 2500 });
  assert.equal(at(a, 1e9).combo, a.combo.max);
  assert.equal(Math.max(...a.combo.at.v), a.combo.max);
  // seeking: the same numbers in any order, and against a fresh walk forward
  const ts = [2600, 100, 1450, 1449, 900, 1e9, 500, 1700, -5, 1450, 2100, 1449, 0];
  const fwd = ts.slice().sort((x, y) => x - y).map(t => [t, at(a, t)]), seek = ts.map(t => [t, at(a, t)]);
  for (const [t, v] of seek) assert.deepEqual(v, fwd.find(f => f[0] === t)[1], "t=" + t);
  // consecutive breaks: 0 each, since still counts from the last rise
  const b = analyse(osu([0, 1, 2, 3, 4].map(i => circle(60 + 60 * i, 100, 500 + 400 * i))), build(tapAt(500, 60, 100), tapAt(2100, 300, 100)));
  assert.deepEqual(C(b.combo).breaks.map(x => x.t), [1050, 1450, 1850]);
  assert.deepEqual(at(b, 1100), { combo: 0, since: 600 }); assert.deepEqual(at(b, 1900), { combo: 0, since: 1400 }); assert.deepEqual(at(b, 2100), { combo: 1, since: 0 });
  // a break at the same time as a hit: events keep their order, the value is the one after the last of them
  assert.deepEqual(at({ combo: { at: { t: Float64Array.of(10, 10, 10), v: Int32Array.of(1, 0, 1) } } }, 10), { combo: 1, since: 0 });
  assert.deepEqual(at({ combo: { at: { t: Float64Array.of(10, 10), v: Int32Array.of(1, 0) } } }, 10), { combo: 0, since: 0 });
});

test("rpComboAt: every break of a real-size play is 0 at its time and was break.combo just before; the last value is the last run", () => {
  const objs = []; for (let i = 0; i < 400; i++) objs.push(circle(50 + (i * 37) % 400, 50 + (i * 53) % 280, 1000 + i * 200));
  const m = osu(objs), rows = [[0, 256, 192, 0]];
  m.hit.forEach((o, i) => { if (i % 37 !== 5 && i % 101 !== 7) rows.push(...tapAt(o.t, o.x, o.y)); }); // (a few misses, some in a row of nothing)
  const a = analyse(m, rows.sort((p, q) => p[0] - q[0])), br = a.combo.breaks;
  assert.ok(br.length >= 10);
  for (const k of br) {
    assert.equal(at(a, k.t).combo, 0);
    // (the value just before the break: the combo it broke; with two breaks at the same ms the earlier one's 0 is what precedes the later)
    if (!br.some(o => o !== k && o.t === k.t)) assert.equal(at(a, k.t - 1e-6).combo, k.combo);
  }
  const V = a.combo.at.v; let run = 0; for (let i = V.length - 1; i >= 0 && V[i] > 0; i--) run++;
  assert.equal(at(a, 1e9).combo, V[V.length - 1]); assert.equal(at(a, 1e9).combo, run);
  assert.equal(Math.max(...V), a.combo.max);
});

test("rpComboAt: odd input is null and never throws", () => {
  for (const a of [undefined, null, 0, "x", [], {}, { combo: null }, { combo: {} }, { combo: { at: null } }, { combo: { at: {} } }, { combo: { at: { t: [1], v: [] } } }, { combo: { at: { t: 5, v: 5 } } }, { combo: { max: 0, breaks: [] } }])
    assert.equal(P.rpComboAt(a, 100), null, JSON.stringify(a));
  const ok = { combo: { at: { t: Float64Array.of(10), v: Int32Array.of(1) } } };
  for (const t of [NaN, Infinity, -Infinity, undefined, null, "10", {}, []]) assert.equal(P.rpComboAt(ok, t), null);
  assert.doesNotThrow(() => P.rpComboAt({ get combo() { throw new Error("boom"); } }, 1));
  assert.equal(P.rpComboAt({ combo: { at: { get t() { throw new Error("boom"); }, v: [] } } }, 1), null);
  assert.deepEqual(at({ combo: { at: { t: new Float64Array(0), v: new Int32Array(0) } } }, 5), { combo: 0, since: -1 }); // (a play with no combo event: 0, not null)
  assert.deepEqual(at({ combo: { at: { t: [10, 20], v: [1, 2] } } }, 25), { combo: 2, since: 5 }); // (plain arrays work as well)
  // a hand-made or failed combo ({ max: 0, breaks: [] } with no series) falls back to null, as the HUD expects
  assert.equal(P.rpComboAt(P.rpAnalyze(replay([]), M(), NOMOD), 5), null);
});

test("rpAnaPoor: poor with counts is true; poor with all-zero counts, good, fair and missing are false", () => {
  const q = (quality, h) => ({ consistency: { quality, header: h } });
  const c = { n300: 90, n100: 5, n50: 1, miss: 4 }, z = { n300: 0, n100: 0, n50: 0, miss: 0 };
  assert.equal(P.rpAnaPoor(q("poor", c)), true);
  assert.equal(P.rpAnaPoor(q("poor", { n300: 0, n100: 0, n50: 0, miss: 1 })), true);
  assert.equal(P.rpAnaPoor(q("poor", z)), false);
  assert.equal(P.rpAnaPoor(q("poor", {})), false);
  assert.equal(P.rpAnaPoor(q("poor", null)), false);
  assert.equal(P.rpAnaPoor(q("good", c)), false);
  assert.equal(P.rpAnaPoor(q("fair", c)), false);
  for (const a of [undefined, null, 0, "x", {}, { consistency: null }, { consistency: {} }]) assert.equal(P.rpAnaPoor(a), false);
  // the real analysis of a play whose header counts disagree with it
  const m = M(), a = analyse(m, scene(m)); a.consistency = { ...a.consistency, quality: "poor", header: c }; assert.equal(P.rpAnaPoor(a), true);
});

test("speed: the combo adds next to nothing (3000 objects)", () => {
  const objs = []; for (let i = 0; i < 3000; i++) objs.push(circle(50 + (i * 37) % 400, 50 + (i * 53) % 280, 2000 + i * 100));
  const m = osu(objs), H = m.hit, rows = [[0, 256, 192, 0]];
  for (const o of H) rows.push([o.t - 5, o.x, o.y, 0], [o.t, o.x, o.y, 5], [o.t + 20, o.x, o.y, 0]);
  const d = replay(rows);
  let a, ms = Infinity;
  for (let r = 0; r < 4; r++) { const t0 = performance.now(); a = P.rpAnalyze(d, m, NOMOD); ms = Math.min(ms, performance.now() - t0); }
  assert.deepEqual(C(a.combo), { max: 3000, breaks: [] });
  const t1 = performance.now(); for (let r = 0; r < 20; r++) P.rpaCombo(m.hit, a.hits, a.sliders, a.spinners, a.windows.w50);
  const per = (performance.now() - t1) / 20;
  console.log(`# 3000 objects: rpAnalyze ${ms.toFixed(1)} ms, rpaCombo ${per.toFixed(2)} ms`);
  assert.ok(per < 10, `combo took ${per} ms`);
});

const REAL = process.env.OBV_REAL_OSR && process.env.OBV_REAL_OSU && existsSync(process.env.OBV_REAL_OSR) && existsSync(process.env.OBV_REAL_OSU);
test("a real stable replay on its own map: the combo against the header's max combo (OBV_REAL_OSR + OBV_REAL_OSU, optional)", { skip: REAL ? false : "OBV_REAL_OSR / OBV_REAL_OSU not set" }, () => {
  const raw = readFileSync(process.env.OBV_REAL_OSU), m = P.parseOsu(raw.toString("utf8")), d = P.parseOsr(new Uint8Array(readFileSync(process.env.OBV_REAL_OSR)));
  const a = P.rpAnalyze(d, m, P.replayMods(d.mods, d.lazerInfo), { md5: createHash("md5").update(raw).digest("hex") });
  const noSp = P.rpaCombo(m.hit, a.hits, a.sliders, [], a.windows.w50);
  console.log(`# header max combo ${d.maxCombo}, a.combo.max ${a.combo.max}, without spinners ${noSp.max}, breaks ${JSON.stringify(a.combo.breaks)}`);
  assert.ok(a.combo.max > 0 && a.combo.max <= a.hits.length * 4 + a.spinners.length);
  assert.ok(Math.abs(a.combo.max - d.maxCombo) <= 10, "near the header's max combo");
});

// ---- lazer replays (data.lazer): lazer's own judgement (js/replayana.js JUDGEMENT: LAZER) and its combo
const LZ = (rows, mods = [], statistics = null) => replay(rows, { lazer: true, version: 30000016, lazerInfo: { mods, statistics } });
const lazerA = (m, rows, mods, statistics) => { const a = P.rpAnalyze(LZ(rows, mods, statistics), m, NOMOD); assert.equal(a.ok, true); return a; };
const AB = () => osu([circle(100, 100, 1000), circle(300, 100, 1100)]); // (OD 5: windows 49.5 / 99.5 / 149.5 ms as compared)

test("lazer note lock: a press on the next circle before the earlier one's time shakes; at or after it, it hits and the earlier one is missed at that press", () => {
  const m = AB(), rows = build(tapAt(950, 300, 100), tapAt(1050, 300, 100)); // (both presses on the second circle, none on the first)
  const lz = lazerA(m, rows);
  assert.equal(lz.consistency.rules, "lazer");
  assert.deepEqual(J(lz.hits).map(h => [h.judge, h.press, h.jt]), [[0, null, 1050], [100, 1050, 1050]]); // (err -50: a 100; the first circle missed by that hit)
  assert.equal(lz.stats.lock, 1); assert.deepEqual(J(lz.empty).map(e => [e.t, e.why]), [[950, "lock"]]);
  assert.deepEqual(C(lz.combo), { max: 1, breaks: [{ t: 1050, combo: 0 }] });
  assert.deepEqual(Array.from(lz.combo.at.v), [0, 1]); // (the break first, then the hit at the same ms: the HUD shows 1, not 0)
  // the same frames as a stable replay: the earlier circle's window holds the lock for both presses, both circles are missed
  const st = analyse(m, rows);
  assert.equal(st.consistency.rules, "stable");
  assert.deepEqual(J(st.hits).map(h => [h.judge, h.jt]), [[0, 1150], [0, 1250]]);
  assert.deepEqual(C(st.combo), { max: 0, breaks: [{ t: 1150, combo: 0 }, { t: 1250, combo: 0 }] });
});

test("lazer: a press up to 400 ms early is a miss judged at that press; more than 400 ms early does nothing; stable ignores both", () => {
  const m = osu([circle(100, 100, 500), circle(200, 200, 1000)]);
  const early = build(tapAt(500, 100, 100), tapAt(700, 200, 200), tapAt(1000, 200, 200)); // (300 ms early, then on time)
  const lz = lazerA(m, early);
  assert.deepEqual(J(lz.hits).map(h => [h.judge, h.jt]), [[300, 500], [0, 700]]);
  assert.equal(lz.stats.earlyNear, 1);
  assert.deepEqual(C(lz.combo), { max: 1, breaks: [{ t: 700, combo: 1 }] });
  assert.equal(lz.empty.some(e => e.t === 1000), true, "the on-time press after the miss hits nothing");
  const st = analyse(m, early);
  assert.deepEqual(J(st.hits).map(h => h.judge), [300, 300]); assert.deepEqual(C(st.combo), { max: 2, breaks: [] });
  const far = lazerA(m, build(tapAt(500, 100, 100), tapAt(550, 200, 200), tapAt(1000, 200, 200))); // (450 ms early: HitResult.None, it only shakes)
  assert.deepEqual(J(far.hits).map(h => h.judge), [300, 300]);
  assert.deepEqual(J(far.empty).map(e => [e.t, e.why]), [[550, "early"]]);
  assert.deepEqual(C(far.combo), { max: 2, breaks: [] });
});

test("lazer with the Classic mod: its classic note lock keeps the stable rule (unless that setting is off)", () => {
  const m = AB(), rows = build(tapAt(950, 300, 100), tapAt(1050, 300, 100));
  const cl = lazerA(m, rows, [{ acronym: "CL" }]);
  assert.deepEqual(J(cl.hits).map(h => h.judge), [0, 0]); assert.equal(cl.consistency.rules, "lazer");
  const off = lazerA(m, rows, [{ acronym: "CL", settings: { classic_note_lock: false } }]);
  assert.deepEqual(J(off.hits).map(h => h.judge), [0, 100]);
  assert.deepEqual(J(P.rpaRules({ lazer: true, lazerInfo: { mods: [{ acronym: "CL", settings: { no_slider_head_accuracy: false } }] } })), { lazer: true, lock: false, headAcc: true });
  assert.deepEqual(J(P.rpaRules({ lazer: false, lazerInfo: { mods: [] } })), { lazer: false, lock: false, headAcc: false });
  assert.deepEqual(J(P.rpaRules(null)), { lazer: false, lock: false, headAcc: false });
});

test("lazer: the estimate counts a slider HEAD by its timing (great / ok / meh / miss as lazer's counts), checked against lazer's statistics", () => {
  const m = M(), rows = scene(m, { slide: run(900, 2400, ball(m, 1), { down: 1070 }) }); // (the head pressed 70 ms late: an ok in lazer, the whole slider is still followed)
  const stats = { great: 3, ok: 1, meh: 0, miss: 0, large_tick_hit: 2, slider_tail_hit: 1 };
  const lz = lazerA(m, rows, [], stats);
  assert.equal(lz.sliders[0].judge, 300); assert.equal(lz.hits[1].judge, 300); // (a.hits and a.sliders keep their meaning)
  assert.deepEqual(J(lz.consistency.est), { n300: 3, n100: 1, n50: 0, miss: 0 });
  assert.equal(lz.consistency.quality, "good"); assert.equal(lz.consistency.diff, 0);
  assert.deepEqual(J(lz.consistency.parts), { header: { tickHit: 2, tickMiss: 0, tailHit: 1 }, est: { tickHit: 2, tickMiss: 0, tailHit: 1 } });
  assert.equal(lz.combo.max, 7);
  const st = analyse(m, rows); // (stable: the slider by its whole result)
  assert.deepEqual(J(st.consistency.est), { n300: 4, n100: 0, n50: 0, miss: 0 }); assert.equal(st.consistency.parts, undefined);
});

test("lazer: a slider part is judged at its own time with the cursor between the two frames around it; stable takes the frame before", () => {
  const m = M(), b0 = ball(m, 1), base = analyse(m, scene(m)), T = base.sliders[0].parts.find(p => p.kind === "tick").t;
  // frames every 10 ms on the ball, except: one at T - 8 still on it, the next at T + 8 200 px off (half way, at T, 100 px off: past the 2.4 x radius follow area)
  const slide = run(900, 2400, b0, { down: 1000 }).filter(r => r[0] <= T - 8 || r[0] >= T + 8.5);
  slide.push([T - 8, ...b0(T - 8), 5], [T + 8, b0(T + 8)[0], b0(T + 8)[1] + 200, 5]);
  const rows = scene(m, { slide });
  const st = analyse(m, rows), lz = lazerA(m, rows);
  assert.deepEqual(parts(J(st.sliders[0])), [["tick", true], ["tick", true], ["tail", true]]);
  assert.deepEqual(C(st.combo), { max: 7, breaks: [] });
  assert.deepEqual(parts(J(lz.sliders[0])), [["tick", false], ["tick", true], ["tail", true]]);
  assert.deepEqual(C(lz.combo), { max: 4, breaks: [{ t: T, combo: 2 }] }); // (circle, head | the tick: break | tick, tail, circle, spinner)
});

test("lazer: a slider's parts wait for its head's judgement, a miss too (at t + the window end): a short slider followed only until then misses its tail", () => {
  const m = osu([circle(100, 100, 500), slider(100, 200, 1000, 30), circle(400, 300, 1500)]); // (30 px: 1000 .. 1107 ms, no ticks, the tail from 1071)
  const o = m.hit[1], b0 = ball(m, 1);
  const follow = run(900, 1300, t => t < 1000 ? [100 + 60, 200] : t <= 1110 ? b0(t) : [b0(t)[0], b0(t)[1] + 200], { down: 900, up: 1300 }); // (the press at 900 off the head: used up, the key held on)
  const rows = build(tapAt(500, 100, 100), follow, tapAt(1500, 400, 300));
  const st = analyse(m, rows), lz = lazerA(m, rows);
  assert.ok(o.end > 1100 && o.end < 1115 && !o.ticks.length, "the slider as planned: " + o.end);
  for (const a of [st, lz]) { assert.equal(a.hits[1].judge, 0); assert.equal(a.hits[1].jt, 1150); assert.equal(a.empty.filter(e => e.t === 900 && e.why === "aim").length, 1); }
  assert.deepEqual(parts(J(st.sliders[0])), [["tail", true]]); // (stable: the tail is checked from 1071 while the slider is still followed)
  assert.deepEqual(C(st.combo), { max: 2, breaks: [{ t: 1150, combo: 1 }] }); // (circle | head miss | tail (its point after the head's judgement), circle)
  assert.deepEqual(parts(J(lz.sliders[0])), [["tail", false]]); // (lazer: judged once the head is, at 1150; the cursor has left by then)
  assert.deepEqual(C(lz.combo), { max: 1, breaks: [{ t: 1150, combo: 1 }] });
});

const REAL_LZ = process.env.OBV_REAL_LAZER_OSR && process.env.OBV_REAL_LAZER_OSU && existsSync(process.env.OBV_REAL_LAZER_OSR) && existsSync(process.env.OBV_REAL_LAZER_OSU);
test("a real lazer replay on its own map: counts, combo breaks and max combo against lazer's own (OBV_REAL_LAZER_OSR + OBV_REAL_LAZER_OSU, optional)", { skip: REAL_LZ ? false : "OBV_REAL_LAZER_OSR / OBV_REAL_LAZER_OSU not set" }, () => {
  const raw = readFileSync(process.env.OBV_REAL_LAZER_OSU), m = P.parseOsu(raw.toString("utf8")), d = P.parseOsr(new Uint8Array(readFileSync(process.env.OBV_REAL_LAZER_OSR)));
  assert.equal(d.lazer, true);
  const a = P.rpAnalyze(d, m, P.replayMods(d.mods, d.lazerInfo), { md5: createHash("md5").update(raw).digest("hex") }), s = d.lazerInfo.statistics || {}, c = a.consistency;
  console.log(`# header max combo ${d.maxCombo}, a.combo.max ${a.combo.max}; breaks ${a.combo.breaks.length}, lazer miss + large_tick_miss ${(s.miss | 0) + (s.large_tick_miss | 0)}; est ${JSON.stringify(c.est)} header ${JSON.stringify(c.header)}; parts ${JSON.stringify(c.parts)}`);
  assert.equal(c.rules, "lazer");
  assert.equal(c.quality, "good"); assert.ok(c.diff <= 2, "great / ok / meh / miss as lazer's");
  assert.equal(P.rpAnaPoor(a), false, "trusted: the HUD shows the real combo");
  assert.ok(Math.abs(a.combo.max - d.maxCombo) <= 2, "near the header's max combo");
  assert.ok(Math.abs(a.combo.breaks.length - ((s.miss | 0) + (s.large_tick_miss | 0))) <= 3, "a break for each miss and large tick miss (a missed tail breaks nothing)");
  assert.ok(Math.abs(c.parts.est.tickHit - c.parts.header.tickHit) <= 3 && Math.abs(c.parts.est.tailHit - c.parts.header.tailHit) <= Math.max(3, c.parts.header.tailHit * .01), "slider ticks and tails near lazer's");
});
