// What a replay really did on sliders and spinners (js/replayana.js: a.sliders / a.spinners, rpSliderState, rpSpinState): small hand-made
// maps and replays with known answers, the state functions at several times (seeking back included), odd input, and the speed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js", "js/parse.js", "js/replayana.js"]);
const NOMOD = { rate: 1, hr: false, ez: false, list: [] }, HR = { rate: 1, hr: true, ez: false, list: [] }, DT = { rate: 1.5, hr: false, ez: false, list: [] };

// CS 4 (radius 36.49, follow area 87.6), OD 5 (windows 49.5 / 99.5 / 149.5), AR 5; 1.4 px per 100 px/beat at 500 ms/beat: a 350 px slider takes
// 1250 ms and has ticks every 140 px (at 1/3 and 2/3 of the path)
const osu = (objects, { cs = 4, od = 5, ar = 5 } = {}) => P.parseOsu(`osu file format v14\n\n[General]\nStackLeniency: 0.7\nMode: 0\n\n[Difficulty]\nCircleSize:${cs}\nOverallDifficulty:${od}\nApproachRate:${ar}\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`);
const slider = (x, y, t, len, slides = 1) => `${x},${y},${t},2,0,L|${x + len}:${y},${slides},${len},${Array(slides + 1).fill(0).join("|")},${Array(slides + 1).fill("0:0").join("|")},0:0:0:0:`;
const circle = (x, y, t) => `${x},${y},${t},1,0,0:0:0:0:`;
const spinner = (t, end) => `256,192,${t},12,0,${end},0:0:0:0:`;
function replay(rows, extra = {}) {
  const n = rows.length, f = { n, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), k: new Uint8Array(n) };
  rows.forEach(([t, x, y, k], i) => { f.t[i] = t; f.x[i] = x; f.y[i] = y; f.k[i] = k; });
  return { mode: 0, mapMd5: "0".repeat(32), player: "test", counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 }, mods: 0, lazerInfo: null, frames: f, ...extra };
}
// frames every `step` ms in [from, to]: the cursor at pos(t) -> [x, y] (or null: off at (500, 380)), keys at key(t) (default: down from `down` on)
function run(from, to, pos, { down = from, up = Infinity, step = 10, key = 5, on = null } = {}) {
  const rows = [[0, 256, 192, 0]];
  for (let t = from; t <= to; t += step) { const p = pos(t) || [500, 380]; rows.push([t, p[0], p[1], (on ? on(t) : t >= down && t < up) ? key : 0]); }
  return rows;
}
const ball = (m, i) => t => { const o = m.hit[i], p = P.pointAt(o, P.ballF(o, t).f); return [p[0], p[1]]; };
const SL = () => osu([slider(100, 200, 1000, 350)]); // ends at 2250; ticks 1500 and 2000; the tail is checked at 2214
const analyse = (m, rows, mods = NOMOD) => { const a = P.rpAnalyze(replay(rows), m, mods); assert.equal(a.ok, true); return a; };
const parts = s => s.parts.map(p => [p.kind, p.hit]);

test("a slider followed from start to end: head hit, every part hit, 300, one track interval, no break", () => {
  const m = SL(), a = analyse(m, run(900, 2400, ball(m, 0), { down: 1000 }));
  assert.equal(a.sliders.length, 1); assert.deepEqual(J(a.spinners), []);
  const s = J(a.sliders[0]);
  assert.equal(s.i, 0); assert.equal(s.t, 1000); assert.equal(s.end, 2250); assert.equal(s.head, true); assert.equal(s.judge, 300); assert.equal(s.brk, null);
  assert.deepEqual(s.track, [[1000, 2250]]);
  assert.deepEqual(parts(s), [["tick", true], ["tick", true], ["tail", true]]);
  assert.deepEqual(s.parts.map(p => Math.round(p.t)), [1500, 2000, 2214]); // (the tail 36 ms before the end)
  assert.equal(a.hits[0].judge, 300); assert.equal(a.hits[0].slider, true); // (a.hits is the same as before)
});

test("head hit, then the cursor leaves the follow circle: the break time, the parts after it missed, 100 for half", () => {
  const m = SL(), ball0 = ball(m, 0);
  const a = analyse(m, run(900, 2400, t => t < 1700 ? ball0(t) : [ball0(t)[0], ball0(t)[1] + 200], { down: 1000 }));
  const s = J(a.sliders[0]);
  assert.equal(s.head, true); assert.deepEqual(parts(s), [["tick", true], ["tick", false], ["tail", false]]);
  assert.equal(s.brk, 2000); assert.equal(s.judge, 100); // (head + one tick of four)
  assert.deepEqual(s.track, [[1000, 1700]]);
  // one hit of four is a 50
  const b = analyse(m, run(900, 2400, t => t < 1200 ? ball0(t) : [ball0(t)[0], ball0(t)[1] + 200], { down: 1000 }));
  assert.equal(b.sliders[0].judge, 50); assert.equal(b.sliders[0].brk, 1500);
  // never followed after the head: only the head hit, a 50 as well (osu!: at least one hit)
  assert.equal(b.sliders[0].parts.filter(p => p.hit).length, 0);
});

test("follow area: the circle's radius to start tracking, 2.4 x the radius to keep it", () => {
  const m = SL(), ball0 = ball(m, 0);
  // 60 px off the ball (more than the radius 36.5, less than 87.6) from the first frame: the head is missed by aim, tracking never starts
  const off = analyse(m, run(900, 2400, t => [ball0(t)[0], ball0(t)[1] + 60], { down: 1000 }));
  assert.equal(off.sliders[0].head, false); assert.deepEqual(J(off.sliders[0].track), []); assert.equal(off.sliders[0].judge, 0);
  // on the ball at the press, then 60 px off: still tracked all the way
  const drift = analyse(m, run(900, 2400, t => t < 1100 ? ball0(t) : [ball0(t)[0], ball0(t)[1] + 60], { down: 1000 }));
  assert.equal(drift.sliders[0].judge, 300); assert.deepEqual(J(drift.sliders[0].track), [[1000, 2250]]);
  // 100 px off (beyond 87.6) loses it, and coming back to within the radius picks it up again
  const lost = analyse(m, run(900, 2400, t => t >= 1400 && t < 1600 ? [ball0(t)[0], ball0(t)[1] + 100] : t >= 1600 && t < 1800 ? [ball0(t)[0], ball0(t)[1] + 60] : ball0(t), { down: 1000 }));
  const tr = J(lost.sliders[0].track); assert.equal(tr.length, 2); assert.equal(tr[0][1], 1400); assert.ok(tr[1][0] >= 1800 - 10 && tr[1][0] <= 1800 + 10, `second interval starts at ${tr[1][0]}`);
});

test("a key released mid-slider ends tracking at once: the later parts are missed", () => {
  const m = SL(), a = analyse(m, run(900, 2400, ball(m, 0), { down: 1000, up: 1600 }));
  const s = J(a.sliders[0]);
  assert.deepEqual(s.track, [[1000, 1600]]); assert.deepEqual(parts(s), [["tick", true], ["tick", false], ["tail", false]]);
  assert.equal(s.brk, 2000); assert.equal(s.judge, 100);
});

test("after a hit head only its key tracks until the other key was up (Z, Z+X, Z)", () => {
  const m = SL(), ball0 = ball(m, 0), keys = f => { const rows = [[0, 256, 192, 0]]; for (let t = 700; t <= 2400; t += 10) { const p = ball0(t); rows.push([t, p[0], p[1], f(t)]); } return rows; };
  // K2 is down from 500 on (its press is empty), K1 hits the head at 1000 and goes up at 1200: K2 was down in every frame before, so it is never accepted
  const z = J(analyse(m, keys(t => 10 | (t >= 1000 && t < 1200 ? 5 : 0))).sliders[0]);
  assert.equal(z.head, true); assert.deepEqual(z.track, [[1000, 1200]]);
  assert.deepEqual(parts(z), [["tick", false], ["tick", false], ["tail", false]]); assert.equal(z.brk, 1500); assert.equal(z.judge, 50);
  // K2 goes down at 1200 while K1 holds the head and K1 lets go at 1300: K2 was up in the frame the head was hit, so any key counts from then on
  const y = J(analyse(m, keys(t => (t >= 1000 && t < 1300 ? 5 : 0) | (t >= 1200 ? 10 : 0))).sliders[0]);
  assert.equal(y.judge, 300); assert.deepEqual(y.track, [[1000, 2250]]); // (K1 tracks to 1300, the frame K1 is up K2 is already accepted: no gap)
  // the head key released and the other pressed later: fine (a gap in between, nothing due in it)
  const x = J(analyse(m, keys(t => t >= 1000 && t < 1300 ? 5 : t >= 1400 ? 10 : 0)).sliders[0]);
  assert.deepEqual(x.track, [[1000, 1300], [1400, 2250]]); assert.equal(x.judge, 300); // (parts at 1500+ are hit, nothing was due in between)
});

test("head missed, then followed: the parts are hit, the head is not, the result follows the fraction (3 of 4: 100)", () => {
  const m = SL(), a = analyse(m, run(900, 2400, ball(m, 0), { down: 1300 }));
  const s = J(a.sliders[0]);
  assert.equal(s.head, false); assert.equal(a.hits[0].judge, 0);
  assert.deepEqual(parts(s), [["tick", true], ["tick", true], ["tail", true]]);
  assert.equal(s.judge, 100); assert.equal(s.brk, null); // (a missed head alone is no break)
  assert.deepEqual(s.track, [[1300, 2250]]);
  // a missed head and nothing else: 0, and no break either
  const none = analyse(m, run(900, 2400, ball(m, 0), { down: 5000 }));
  assert.equal(none.sliders[0].judge, 0); assert.equal(none.sliders[0].brk, null); assert.deepEqual(J(none.sliders[0].track), []);
});

test("a short slider whose head was missed by aim but followed to the end: its tail is judged at its own time (not after the head window): 100, never a miss", () => {
  // 70 px long at 500 ms/beat: it lasts ~250 ms, the head window (OD 5: 149.5 ms) ends after the tail is checked; the cursor is 45 px (> radius 36.5, < follow area) off the head, key down from just after the head time
  const m = osu([slider(300, 100, 1000, 70)]), ball0 = ball(m, 0);
  const a = analyse(m, run(900, 1400, t => t < 1030 ? [ball0(t)[0], ball0(t)[1] + 45] : ball0(t), { down: 1010 })); // (45 px off at the press, on the ball from 1030)
  const s = J(a.sliders[0]);
  assert.equal(s.head, false); assert.deepEqual(parts(s), [["tail", true]]);
  assert.equal(s.judge, 100); assert.equal(a.hits[0].judge, 0); // (a.hits: the head alone is still a miss, as before)
});

test("repeats and ticks in time order: slides 3 on a 200 px slider", () => {
  const m = osu([slider(100, 200, 1000, 200, 3)]), o = m.hit[0];
  const a = analyse(m, run(900, 3400, ball(m, 0), { down: 1000 }));
  const s = J(a.sliders[0]);
  assert.deepEqual(s.parts.map(p => p.kind), ["tick", "repeat", "tick", "repeat", "tick", "tail"]);
  assert.ok(s.parts.every(p => p.hit)); assert.equal(s.judge, 300);
  assert.deepEqual(s.parts.map(p => Math.round(p.t)), [1500, 1714, 1929, 2429, 2929, 3107]);
  assert.ok(Math.abs(s.parts[1].t - (o.t + o.span)) < 1e-6); assert.ok(Math.abs(s.parts[5].t - (o.end - 36)) < 1e-6);
  // leaving at the first reverse arrow loses it and everything after
  const b = analyse(m, run(900, 3400, t => t < 1700 ? ball(m, 0)(t) : null, { down: 1000 }));
  const sb = J(b.sliders[0]);
  assert.deepEqual(parts(sb), [["tick", true], ["repeat", false], ["tick", false], ["repeat", false], ["tick", false], ["tail", false]]);
  assert.equal(sb.brk, sb.parts[1].t); assert.equal(sb.judge, 50); // (head + 1 of 7: 2 of 7 hit)
});

test("the tail is hit on the first tracking frame from end - 36 on, missed only at the end", () => {
  const m = SL(), ball0 = ball(m, 0), gone = t => { const p = ball0(t); return [p[0], p[1] + 200]; };
  // away from 2100, back on the ball at 2230 (20 ms before the end): the tail is hit then
  const a = J(analyse(m, run(900, 2400, t => t >= 2100 && t < 2230 ? gone(t) : ball0(t), { down: 1000 })).sliders[0]);
  assert.deepEqual(parts(a), [["tick", true], ["tick", true], ["tail", true]]); assert.equal(a.parts[2].t, 2230); assert.equal(a.judge, 300); assert.equal(a.brk, null);
  // back only at 2260 (after the end): missed, at the end, a break there
  const b = J(analyse(m, run(900, 2400, t => t >= 2100 && t < 2260 ? gone(t) : ball0(t), { down: 1000 })).sliders[0]);
  assert.deepEqual(parts(b), [["tick", true], ["tick", true], ["tail", false]]); assert.equal(b.parts[2].t, 2250); assert.equal(b.brk, 2250); assert.equal(b.judge, 100);
  // away before the tail window and back inside it
  const c = J(analyse(m, run(900, 2400, t => t >= 2100 && t < 2220 ? gone(t) : ball0(t), { down: 1000 })).sliders[0]);
  assert.equal(c.parts[2].hit, true); assert.equal(c.parts[2].t, 2220);
});

test("a replay that ends mid-slider misses what is left", () => {
  const m = SL(), a = J(analyse(m, run(900, 1600, ball(m, 0), { down: 1000 })).sliders[0]);
  assert.deepEqual(parts(a), [["tick", true], ["tick", false], ["tail", false]]); assert.deepEqual(a.track, [[1000, 1600]]); assert.equal(a.judge, 100); assert.equal(a.brk, 2000);
  assert.equal(a.parts[2].t, 2250);
});

test("a late head press: the repeat passed before it is hit at the press when the cursor is in the follow area", () => {
  const m = osu([slider(100, 200, 1000, 30, 2)]); // 107 ms a slide: the repeat at 1107, the tail at 1178
  const a = J(analyse(m, run(900, 1400, ball(m, 0), { down: 1140 })).sliders[0]);
  assert.equal(a.head, true); // (140 ms late: inside the 149.5 window)
  assert.deepEqual(parts(a), [["repeat", true], ["tail", true]]); assert.equal(a.parts[0].t, 1140); assert.equal(a.judge, 300);
  // too late for the head: the same slider with the key from 1160 is a miss, and the repeat is judged at its own time (1107), not held back until the
  // head's window closes (1150): measured on a real replay, where a short slider missed by aim and then followed must not come out as a miss
  const b = J(analyse(m, run(900, 1400, ball(m, 0), { down: 1160 })).sliders[0]);
  assert.equal(b.head, false); assert.ok(Math.abs(b.parts[0].t - 1107.142857) < 1e-3); assert.equal(b.parts[0].hit, false); // (the key is not down at 1107)
  // a short slider: the tail is checked at end - 36, but not before the head is judged
  const c = J(analyse(m, run(900, 1400, ball(m, 0), { down: 1120 })).sliders[0]);
  assert.ok(Math.abs(c.parts[1].t - (m.hit[0].end - 36)) < 1e-6); assert.equal(c.judge, 300);
});

test("HR: the cursor is mirrored (y -> 384 - y), the slider keeps its drawn place", () => {
  const m = osu([slider(100, 60, 1000, 350)]), ball0 = ball(m, 0);
  const a = analyse(m, run(900, 2400, t => { const p = ball0(t); return [p[0], 384 - p[1]]; }, { down: 1000 }), HR);
  assert.equal(a.sliders[0].judge, 300); assert.equal(a.sliders[0].head, true); assert.deepEqual(J(a.sliders[0].track), [[1000, 2250]]);
  // the same frames without HR follow the mirrored ball: nothing
  const b = analyse(m, run(900, 2400, t => { const p = ball0(t); return [p[0], 384 - p[1]]; }, { down: 1000 }), NOMOD);
  assert.equal(b.sliders[0].judge, 0); assert.deepEqual(J(b.sliders[0].track), []);
});

test("DT: song-time frames judge the same; the rate does not change a slider", () => {
  const m = SL(), rows = run(900, 2400, ball(m, 0), { down: 1000 });
  assert.deepEqual(J(analyse(m, rows, DT).sliders), J(analyse(m, rows, NOMOD).sliders));
  assert.equal(analyse(m, rows, DT).sliders[0].judge, 300);
});

test("the ball position is parse.js pointAt(ballF): curved, repeated and stacked sliders", () => {
  const m = osu([`100,100,1000,2,0,B|200:250|300:100|400:300,3,420,0|0|0|0,0:0|0:0|0:0|0:0,0:0:0:0:`, `100,100,5000,2,0,P|150:200|250:150,2,300,0|0|0,0:0|0:0|0:0,0:0:0:0:`, circle(100, 100, 5200)]);
  const q = [0, 0];
  for (const o of m.hit) if (o.kind === "slider") for (let T = o.t - 100; T < o.end + 100; T += 17.3) {
    const p = P.pointAt(o, P.ballF(o, T).f); P.rpaBall(o, T, q);
    assert.ok(Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9, `t=${T}`);
  }
  // a slider stacked under the next one's head: parse.js moved the path up-left by the stack; the analysis undoes that and uses the head's
  // convention (offset = stack x radius / 10 of the analysed difficulty; HR: the object at (rx - s, ry + s), the cursor mirrored)
  const ms = osu([slider(100, 100, 1000, 100), slider(200, 100, 1500, 100)]), A = ms.hit[0], s1 = A.stack * ms.radius / 10;
  assert.ok(A.stack >= 1);
  const wanted = (hr, radius) => t => { const p = P.pointAt(A, P.ballF(A, t).f), s = A.stack * radius / 10, y = hr ? p[1] + s1 + s : p[1] + s1 - s; return [p[0] + s1 - s, hr ? 384 - y : y]; };
  assert.equal(analyse(ms, run(900, 1500, wanted(false, ms.radius), { down: 1000 })).sliders[0].judge, 300);
  const hrRadius = P.rpAnalyze(replay(run(900, 1500, wanted(false, 0))), ms, HR).radius;
  const h = analyse(ms, run(900, 1500, wanted(true, hrRadius), { down: 1000 }), HR);
  assert.equal(h.sliders[0].judge, 300); assert.deepEqual(J(h.sliders[0].track), [[1000, A.end]]);
});

// ---- spinners
const SP = () => osu([spinner(1000, 3000)]); // 2 s at OD 5: 150 rpm -> (int)(2.5 x 2 + 0.0001) = 5 rotations
const spin = (turns, { from = 1000, to = 3000, r = 100, dir = 1 } = {}) => t => { const u = Math.max(0, Math.min(1, (t - from) / (to - from))); const ang = dir * 2 * Math.PI * turns * u; return [256 + r * Math.cos(ang), 192 + r * Math.sin(ang)]; };

test("a spinner rotated enough: cleared, the clear time, 300; rot starts at 0 and grows", () => {
  const m = SP(), a = analyse(m, run(900, 3100, spin(6), { step: 8 }));
  assert.equal(a.spinners.length, 1); assert.deepEqual(J(a.sliders), []);
  const s = a.spinners[0];
  assert.equal(s.i, 0); assert.equal(s.t, 1000); assert.equal(s.end, 3000); assert.equal(s.need, 5); assert.equal(s.cleared, true); assert.equal(s.judge, 300);
  assert.ok(s.clearAt > 2600 && s.clearAt < 2700, `clearAt ${s.clearAt}`); // (5 of 6 turns at 5/6 of the time: 1000 + 1666)
  assert.equal(s.rot.t[0], 1000); assert.equal(s.rot.v[0], 0); assert.equal(s.rot.t.constructor.name, "Float64Array"); assert.equal(s.rot.v.constructor.name, "Float32Array");
  assert.equal(s.rot.t[s.rot.t.length - 1], 3000); assert.ok(Math.abs(s.rot.v[s.rot.v.length - 1] - 6) < .1);
  for (let k = 1; k < s.rot.t.length; k++) { assert.ok(s.rot.t[k] > s.rot.t[k - 1]); assert.ok(s.rot.v[k] >= s.rot.v[k - 1]); }
});

test("a spinner not rotated enough: prog below 1, judged by the fraction (.75 / .9)", () => {
  const m = SP();
  const s3 = analyse(m, run(900, 3100, spin(3), { step: 8 })).spinners[0];
  assert.equal(s3.cleared, false); assert.equal(s3.clearAt, null); assert.equal(s3.judge, 0); // 3 of 5 = .6
  assert.ok(Math.abs(P.rpSpinState(s3, 3500).prog - .6) < .02);
  assert.equal(analyse(m, run(900, 3100, spin(4), { step: 8 })).spinners[0].judge, 50); // .8
  assert.equal(analyse(m, run(900, 3100, spin(4.6), { step: 8 })).spinners[0].judge, 100); // .92
  assert.equal(analyse(m, run(900, 3100, spin(0), { step: 8 })).spinners[0].judge, 0);
  // no key: no rotation at all
  const nk = analyse(m, run(900, 3100, spin(6), { step: 8, down: 5000 })).spinners[0];
  assert.equal(nk.judge, 0); assert.equal(nk.rot.v[nk.rot.v.length - 1], 0);
});

test("spinner rotation: either direction counts, turning back does not add, DT counts more", () => {
  const m = SP();
  assert.equal(analyse(m, run(900, 3100, spin(6, { dir: -1 }), { step: 8 })).spinners[0].judge, 300);
  const wob = t => { const u = (t - 1000) / 2000; const ang = 1.2 * Math.sin(u * 60); return [256 + 100 * Math.cos(ang), 192 + 100 * Math.sin(ang)]; }; // (swinging ±69 degrees back and forth)
  const w = analyse(m, run(900, 3100, wob, { step: 8 })).spinners[0];
  assert.ok(w.rot.v[w.rot.v.length - 1] < .5, `wobble ${w.rot.v[w.rot.v.length - 1]}`);
  const rows = run(900, 3100, spin(4), { step: 8 });
  assert.equal(analyse(m, rows, NOMOD).spinners[0].cleared, false);
  assert.equal(analyse(m, rows, DT).spinners[0].cleared, true); // (4 x 1.5 = 6 >= 5)
  // HR mirrors y (the same count) and raises OD to 7: 6 rotations needed
  assert.equal(analyse(m, run(900, 3100, spin(6), { step: 8 }), HR).spinners[0].need, 6);
  assert.equal(analyse(m, run(900, 3100, spin(7), { step: 8 }), HR).spinners[0].judge, 300);
  assert.equal(analyse(m, run(900, 3100, spin(5), { step: 8 }), HR).spinners[0].judge, 50);
});

test("spinner need follows OD (lazer Spinner.cs: 90 / 150 / 225 rpm at OD 0 / 5 / 10)", () => {
  const need = od => analyse(osu([spinner(1000, 3000)], { od }), run(900, 3100, spin(1), { step: 8 })).spinners[0].need;
  assert.equal(need(5), 5); assert.equal(need(0), 3); assert.equal(need(10), 7); // 1.5 rps x 2 = 3, 3.75 rps x 2 = 7.5
  assert.equal(analyse(osu([spinner(1000, 1100)]), run(900, 1200, spin(0), { step: 8 })).spinners[0].need, 0); // 0.25 rotations: (int) 0
  const z = analyse(osu([spinner(1000, 1100)]), run(900, 1200, spin(0), { step: 8 })).spinners[0];
  assert.equal(z.cleared, true); assert.equal(z.clearAt, 1000); assert.equal(z.judge, 300);
});

// ---- state functions
test("rpSliderState: before, during, after; parts, tracking, break; seeking back gives the same answers", () => {
  const m = SL(), ball0 = ball(m, 0);
  const a = analyse(m, run(900, 2400, t => t < 1700 ? ball0(t) : [ball0(t)[0], ball0(t)[1] + 200], { down: 1000 })), e = a.sliders[0];
  const st = t => J(P.rpSliderState(e, t));
  assert.deepEqual(st(500), { phase: "pending", tracking: false, since: -1, brkAge: -1, parts: 0, partsHit: 0, lastPart: null });
  assert.deepEqual(st(1000), { phase: "active", tracking: true, since: 0, brkAge: -1, parts: 0, partsHit: 0, lastPart: null });
  assert.deepEqual(st(1250), { phase: "active", tracking: true, since: 250, brkAge: -1, parts: 0, partsHit: 0, lastPart: null });
  assert.deepEqual(st(1500), { phase: "active", tracking: true, since: 500, brkAge: -1, parts: 1, partsHit: 1, lastPart: { kind: "tick", hit: true, age: 0 } });
  assert.deepEqual(st(1800), { phase: "active", tracking: false, since: -1, brkAge: -1, parts: 1, partsHit: 1, lastPart: { kind: "tick", hit: true, age: 300 } });
  assert.deepEqual(st(2100), { phase: "active", tracking: false, since: -1, brkAge: 100, parts: 2, partsHit: 1, lastPart: { kind: "tick", hit: false, age: 100 } });
  const done = st(2300); assert.equal(done.phase, "done"); assert.equal(done.parts, 3); assert.equal(done.partsHit, 1); assert.equal(done.brkAge, 300);
  assert.deepEqual(st(1250), { phase: "active", tracking: true, since: 250, brkAge: -1, parts: 0, partsHit: 0, lastPart: null }); // (seek back)
  assert.deepEqual(st(500), { phase: "pending", tracking: false, since: -1, brkAge: -1, parts: 0, partsHit: 0, lastPart: null });
  assert.equal(J(P.rpSliderState(e, 2250)).phase, "done");
});

test("rpSpinState: pending, interpolated rotation, clear and its age, seeking back", () => {
  const m = SP(), e = analyse(m, run(900, 3100, spin(6), { step: 8 })).spinners[0], st = t => J(P.rpSpinState(e, t));
  assert.deepEqual(st(500), { phase: "pending", rot: 0, prog: 0, clear: false, clearAge: -1 });
  assert.equal(st(1000).phase, "active"); assert.equal(st(1000).rot, 0);
  const mid = st(2000); assert.equal(mid.phase, "active"); assert.ok(Math.abs(mid.rot - 3) < .1); assert.ok(Math.abs(mid.prog - .6) < .02); assert.equal(mid.clear, false);
  const c = st(e.clearAt + 100); assert.equal(c.clear, true); assert.equal(c.prog, 1); assert.ok(Math.abs(c.clearAge - 100) < 1e-9);
  const end = st(3500); assert.equal(end.phase, "done"); assert.ok(Math.abs(end.rot - 6) < .1);
  assert.deepEqual(st(2000), mid); assert.deepEqual(st(500), { phase: "pending", rot: 0, prog: 0, clear: false, clearAge: -1 });
  // between two samples the rotation is interpolated
  const k = 40, tm = (e.rot.t[k] + e.rot.t[k + 1]) / 2; assert.ok(Math.abs(st(tm).rot - (e.rot.v[k] + e.rot.v[k + 1]) / 2) < 1e-5);
});

test("odd input: no frames, no sliders, odd entries and times never throw", () => {
  const m = SL();
  assert.deepEqual(J(P.rpAnalyze(replay([]), m, NOMOD).warn), ["no_frames"]);
  const none = P.rpAnalyze(replay([[0, 256, 192, 0], [500, 256, 192, 0]]), osu([circle(100, 100, 1000)]), NOMOD);
  assert.equal(none.ok, true); assert.deepEqual(J(none.sliders), []); assert.deepEqual(J(none.spinners), []);
  const tiny = analyse(m, [[0, 256, 192, 0]]); // (one frame, the slider after it)
  assert.equal(tiny.sliders.length, 1); assert.equal(tiny.sliders[0].judge, 0); assert.ok(tiny.sliders[0].parts.every(p => !p.hit));
  const sp = analyse(SP(), [[0, 256, 192, 0]]); assert.equal(sp.spinners[0].judge, 0); assert.equal(sp.spinners[0].rot.t.length, 2);
  const bad = analyse(m, [[0, NaN, NaN, 5], [1000, NaN, 100, 5], [1500, 100, NaN, 5], [3000, 100, 200, 5]]);
  assert.equal(bad.sliders.length, 1);
  for (const e of [undefined, null, {}, 5, "x", { t: 1, end: 2 }, { t: NaN, end: 5, parts: [], track: [] }, { t: 1, end: 2, parts: [{}], track: [null] }]) {
    assert.doesNotThrow(() => P.rpSliderState(e, 1.5)); assert.doesNotThrow(() => P.rpSpinState(e, 1.5));
  }
  assert.equal(P.rpSliderState(undefined, 1), null); assert.equal(P.rpSliderState(bad.sliders[0], NaN), null); assert.equal(P.rpSliderState(bad.sliders[0], undefined), null);
  assert.equal(P.rpSpinState(null, 1), null); assert.equal(P.rpSpinState(sp.spinners[0], Infinity), null); assert.equal(P.rpSpinState({ t: 0, end: 5 }, 1), null);
});

test("a.hits, stats and the other outputs are untouched by the extra output", () => {
  const m = osu([circle(100, 100, 500), slider(100, 200, 1000, 350), spinner(3000, 4000)]);
  const rows = run(400, 4100, t => t < 900 ? [100, 100] : t < 2500 ? ball(m, 1)(t) : spin(3, { from: 3000, to: 4000 })(t), { on: t => t >= 500 && t < 560 || t >= 1000 && t < 2400 || t >= 3000, step: 10 });
  const a = analyse(m, rows);
  assert.deepEqual(a.hits.map(h => [h.i, h.slider, h.judge]), [[0, false, 300], [1, true, 300]]);
  assert.equal(a.stats.spinners, 1); assert.equal(a.sliders[0].i, 1); assert.equal(a.spinners[0].i, 2);
  assert.deepEqual(Object.keys(a).sort(), ["ar", "cs", "combo", "consistency", "cursor", "empty", "hits", "hr", "judge", "keys", "od", "ok", "preempt", "radius", "rate", "sliders", "spinners", "stats", "warn", "windows"].sort());
});

test("speed: 150k frames with 500 sliders and 50 spinners analysed under 200 ms", () => {
  const objs = [];
  for (let i = 0; i < 500; i++) objs.push(slider(60 + (i * 37) % 300, 60 + (i * 53) % 250, 2000 + i * 1200, 100, 1 + i % 3)); // (357 ms a slide: up to 1070 ms)
  for (let j = 0; j < 50; j++) objs.push(spinner(604000 + j * 1000, 604000 + j * 1000 + 600)); // (after the sliders, which end before 603100)
  const m = osu(objs), H = m.hit, rows = [[0, 256, 192, 0]];
  let k = 0;
  for (let t = 1; t < 655000; t += 4) {
    while (k < H.length - 1 && H[k].end + 100 < t) k++;
    const o = H[k]; let x = 256, y = 192, key = 0;
    if (t >= o.t - 50 && t <= o.end + 20) {
      if (o.kind === "slider") { const p = P.pointAt(o, P.ballF(o, t).f); x = p[0] + (t % 5); y = p[1]; } else { const a = (t - o.t) * .02; x = 256 + 100 * Math.cos(a); y = 192 + 100 * Math.sin(a); }
      key = t >= o.t - 10 ? (k % 2 ? 10 : 5) : 0;
    }
    rows.push([t, x, y, key]);
  }
  const d = replay(rows); assert.ok(d.frames.n > 150000);
  let a, ms = Infinity; // (the best of 4: the first run warms up)
  for (let r = 0; r < 4; r++) { const t0 = performance.now(); a = P.rpAnalyze(d, m, NOMOD); ms = Math.min(ms, performance.now() - t0); }
  console.log(`# ${d.frames.n} frames / 500 sliders / 50 spinners: ${ms.toFixed(1)} ms`);
  assert.equal(a.sliders.length, 500); assert.equal(a.spinners.length, 50);
  assert.ok(a.sliders.filter(s => s.judge === 300).length > 450, "the followed sliders are 300");
  assert.ok(a.spinners.every(s => s.rot.t.length > 100));
  assert.ok(ms < 200, `took ${ms} ms`);
});

// optional, files not in the repo: a real stable replay and the exact .osu of its map (OBV_REAL_OSR=/path/x.osr OBV_REAL_OSU=/path/map.osu); the
// objects judged by the slider / spinner results against the replay header's counts (a stable replay: a slider is judged by its parts)
test("a real stable replay on its own map: the totals of the new slider / spinner results are within 3 objects of the header (OBV_REAL_OSR + OBV_REAL_OSU, optional)", { skip: process.env.OBV_REAL_OSR && process.env.OBV_REAL_OSU && existsSync(process.env.OBV_REAL_OSR) && existsSync(process.env.OBV_REAL_OSU) ? false : "OBV_REAL_OSR / OBV_REAL_OSU not set" }, () => {
  const raw = readFileSync(process.env.OBV_REAL_OSU), m = P.parseOsu(raw.toString("utf8")), d = P.parseOsr(new Uint8Array(readFileSync(process.env.OBV_REAL_OSR)));
  const a = P.rpAnalyze(d, m, P.replayMods(d.mods, d.lazerInfo), { md5: createHash("md5").update(raw).digest("hex") });
  assert.equal(a.ok, true); assert.deepEqual(J(a.warn), []);
  const tot = { 300: 0, 100: 0, 50: 0, 0: 0 }, sl = new Map(a.sliders.map(s => [s.i, s]));
  for (const h of a.hits) tot[h.slider ? sl.get(h.i).judge : h.judge]++;
  for (const s of a.spinners) tot[s.judge]++;
  const hd = d.counts, diff = (Math.abs(tot[300] - hd.n300) + Math.abs(tot[100] - hd.n100) + Math.abs(tot[50] - hd.n50) + Math.abs(tot[0] - hd.miss)) / 2;
  console.log(`# header ${JSON.stringify(hd)} new ${JSON.stringify(tot)} diff ${diff}`);
  assert.ok(diff <= 3, "within 3 objects of the header");
  // consistency.est is exactly these totals (sliders and spinners by their real results), so its quality reads the same
  assert.deepEqual(J(a.consistency.est), { n300: tot[300], n100: tot[100], n50: tot[50], miss: tot[0] });
  assert.equal(a.consistency.diff, diff); assert.equal(a.consistency.quality, "good");
});
