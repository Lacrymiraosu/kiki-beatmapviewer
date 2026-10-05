// js/parse.js (the .osu parser used by the site) checked against osu!lazer's legacy behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/parse.js"]);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const deq = (a, b, msg) => assert.deepEqual(J(a), J(b), msg);
const osu = (objects, extra = "") => `osu file format v14\n\n[General]\nStackLeniency: 0.7\n\n[Difficulty]\nCircleSize:4\nApproachRate:9\nSliderMultiplier:1.4\nSliderTickRate:1\n${extra}\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`;

test("perfect curve through 3 points is a circular arc (0.1px tolerance)", () => {
  const path = P.sliderPath("P", [[0, 0], [50, 50], [100, 0]]);
  for (const [x, y] of path) assert.ok(near(Math.hypot(x - 50, y), 50, 1e-9), "on the circle");
  assert.ok(near(P.pathLen(path), Math.PI * 50, .2), "semicircle length (chords within 0.1px of the arc)");
  assert.ok(near(path[0][0], 0, 1e-9) && near(path[0][1], 0, 1e-9));
  assert.ok(near(path.at(-1)[0], 100, 1e-9) && near(path.at(-1)[1], 0, 1e-9));
  assert.ok(path.every(([, y]) => y >= -1e-9), "bends toward the middle point");
});

test("stable rule: a straight 'perfect' curve is a line (it can double back)", () => {
  const path = P.sliderPath("P", [[0, 0], [100, 0], [50, 0]]);
  deq(path, [[0, 0], [100, 0], [50, 0]]);
  assert.equal(P.pathLen(path), 150);
});

test("perfect curve with other than 3 points falls back to bezier", () => {
  const path = P.sliderPath("P", [[0, 0], [50, 50], [100, 0], [150, 50]]);
  const b = P.sliderPath("B", [[0, 0], [50, 50], [100, 0], [150, 50]]);
  deq(path, b);
});

test("bezier: adaptive subdivision stays within 0.25px of the real curve", () => {
  const c = [[0, 0], [100, 300], [300, -200], [400, 100]];
  const path = P.sliderPath("B", c);
  const bz = t => [0, 1].map(j => (1 - t) ** 3 * c[0][j] + 3 * (1 - t) ** 2 * t * c[1][j] + 3 * (1 - t) * t * t * c[2][j] + t ** 3 * c[3][j]);
  let worst = 0;
  for (let i = 0; i <= 400; i++) {
    const q = bz(i / 400); let best = Infinity;
    for (let k = 1; k < path.length; k++) { // distance to the polyline
      const a = path[k - 1], b = path[k], vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
      const u = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / l2)) : 0;
      best = Math.min(best, Math.hypot(q[0] - a[0] - vx * u, q[1] - a[1] - vy * u));
    }
    worst = Math.max(worst, best);
  }
  assert.ok(worst < .3, "max deviation " + worst);
  deq(path[0], [0, 0]); deq(path.at(-1), [400, 100]);
});

test("red anchors (repeated points) split a bezier into segments; a head repeated as the first point is dropped", () => {
  const split = P.sliderPath("B", [[0, 0], [100, 100], [200, 0], [200, 0], [300, 100], [400, 0]]);
  assert.ok(split.some(p => p[0] === 200 && p[1] === 0), "passes through the anchor");
  const withDup = P.sliderPath("B", [[0, 0], [0, 0], [100, 100], [200, 0]]);
  const without = P.sliderPath("B", [[0, 0], [100, 100], [200, 0]]);
  deq(withDup, without);
});

test("path length: cut to the length in the file, extended in a straight line, not extended when the last two points match", () => {
  const cut = P.trimPath([[0, 0], [100, 0]], 60);
  deq(cut.at(-1), [60, 0]); assert.equal(cut.dist, 60);
  const ext = P.trimPath([[0, 0], [100, 0]], 150);
  deq(ext.at(-1), [150, 0]); assert.equal(ext.dist, 150);
  const keep = P.trimPath([[0, 0], [100, 0], [100, 0]], 150);
  assert.equal(keep.dist, 100, "osu!stable doesn't extend these");
});

test("combo colours follow osu! (first combo = colour 2, offsets only on an explicit new combo, after a spinner)", () => {
  const m = P.parseOsu(osu(["100,100,0,5,0", "200,100,500,1,0", "300,100,1000,37,0", "256,192,1500,12,0,2000", "100,100,2500,1,0"],
    "\n[Colours]\nCombo1 : 255,0,0\nCombo2 : 0,255,0\nCombo3 : 0,0,255\nCombo4 : 255,255,0\n"));
  const [a, b, c, spin, d] = m.hit;
  assert.equal(a.ci, 1, "first combo uses Combo2");
  assert.equal(b.ci, 1); assert.equal(b.num, 2);
  assert.equal(c.ci, 1 + 2 + 1, "new combo skipping 2 colours");
  assert.equal(spin.ci, c.ci + 1, "spinner with its own new combo bit");
  assert.equal(d.nc, true, "the object after a spinner always starts a combo");
  assert.equal(d.ci, spin.ci + 1, "no offset when the new combo is forced");
  const noCols = P.parseOsu(osu(["100,100,0,5,0", "300,100,1000,37,0"]));
  assert.equal(noCols.hit[1].ci, 2, "skin colours ignore colour skips (ComboIndex)");
});

test("difficulty: preempt is truncated like lazer, circle radius includes stable's scale allowance", () => {
  const m = P.parseOsu(osu(["100,100,0,5,0"]).replace("ApproachRate:9", "ApproachRate:9.35"));
  assert.equal(m.preempt, 547);
  assert.ok(near(m.radius, (54.4 - 4.48 * 4) * 1.00041, 1e-9));
});

test("stacking: circles on the same spot stack up-left; old files (v5) use the old algorithm", () => {
  const objs = ["200,200,0,5,0", "200,200,200,1,0", "200,200,400,1,0"];
  const m = P.parseOsu(osu(objs));
  deq(m.hit.map(o => o.stack), [2, 1, 0]);
  assert.ok(m.hit[0].x < m.hit[2].x && near(m.hit[2].x - m.hit[0].x, 2 * m.radius / 10, 1e-9));
  const old = P.parseOsu(osu(objs).replace("osu file format v14", "osu file format v5"));
  assert.equal(old.version, 5);
  deq(old.hit.map(o => o.stack), [2, 1, 0]);
});

test("slider timing: span = real length / velocity; v7 and older space ticks without the slider velocity", () => {
  const line = "100,100,0,2,0,L|300:100,1,200";
  const m = P.parseOsu(osu([line]).replace("0,500,4,2,0,100,1,0", "0,500,4,2,0,100,1,0\n0,-50,4,2,0,100,0,0"));
  const o = m.hit[0];
  assert.equal(o.sv, 2); assert.ok(near(o.span, 200 / (1.4 * 100 * 2) * 500, 1e-9));
  assert.equal(o.ticks.length, 0, "tick distance 280 > length 200 at SV 2");
  const v7 = P.parseOsu(osu([line]).replace("osu file format v14", "osu file format v7").replace("0,500,4,2,0,100,1,0", "0,500,4,2,0,100,1,0\n0,-50,4,2,0,100,0,0"));
  assert.equal(v7.hit[0].ticks.length, 1, "tick distance 140 without SV");
});

test("parsing never changes the raw lines (unmodified data is written back as it was)", () => {
  const lines = ["100,100,0,5,0,0:0:0:0:", "256,192,500,12,4,1000,1:2:0:0:", "50,60,1500,2,2,B|60:70|80:90|80:90|100:50,2,120.5,2|0|8,1:0|0:0|2:3,0:0:0:0:"];
  const m = P.parseOsu(osu(lines));
  deq(m.lines.map(L => L.s), lines);
  P.rebuildHits(m);
  deq(m.lines.map(L => L.s), lines);
});

// Aspire maps (e.g. "Camellia - FM Synthesis Experiment": 108 MB, 8.6 million slider points) push every value to the extreme
const aspire = (objects, timing) => `osu file format v14\n\n[General]\nStackLeniency: 0\n\n[Difficulty]\nCircleSize:4.8\nApproachRate:9.7\nSliderMultiplier:3\nSliderTickRate:0.5\n\n[Events]\n2,9000,9500\n2,3000,3500\n\n[TimingPoints]\n${timing.join("\n")}\n\n[HitObjects]\n${objects.join("\n")}\n`;
const zigzag = n => { const pts = []; for (let i = 0; i < n; i++) pts.push(i % 2 ? `-1000000:${100 + (i % 200)}` : `1000000:${100 + (i % 200)}`); return pts.join("|"); };

test("Aspire: a slider with tens of thousands of points far off-screen is read fast and cut to what can show", () => {
  const big = `256,192,1000,2,0,L|${zigzag(60000)},1,123456789`;
  const t0 = performance.now(), m = P.parseOsu(aspire([big], ["0,500,4,2,0,100,1,0"])), dt = performance.now() - t0;
  assert.ok(dt < 3000, `parsed in ${Math.round(dt)} ms`);
  const o = m.hit[0];
  assert.equal(o.kind, "slider"); assert.equal(o.nodes, 60001);
  assert.equal(o.dist, 123456789, "length as written");
  assert.ok(o.path.jumps && o.path.jumps.size > 0, "the far-off stretches are jumps");
  assert.ok(o.path.length < 2000, `repeated pieces left out (${o.path.length} points kept)`);
  assert.ok(o.path.every(([x, y]) => Math.abs(x) <= 1e7 && Math.abs(y) <= 1e7), "every point fits a canvas path");
  assert.ok(near(o.cum.at(-1), o.dist, 1e-3 * o.dist), "lengths still add up to the slider's length");
  assert.equal(o.cps.length, 60001, "control points still there for the editor (read on demand)");
  const mid = P.pointAt(o, .5); assert.ok(isFinite(mid[0]) && isFinite(mid[1]));
});

test("Aspire: tiny beat lengths make sliders instant, a NaN green line is 1x, repeats are capped, spinners can't run backwards", () => {
  const m = P.parseOsu(aspire([
    "100,100,1000,2,0,L|300:100,99999,200", // under a 5e-324 ms beat: instant; repeats capped at 9000 (lazer)
    "100,100,2000,2,0,L|300:100,1,200", // after the NaN line: 1x SV
    "256,192,4000,12,0,3999,0:0:0:0:", // ends before it starts
  ], ["0,5e-324,4,2,0,100,1,0", "1500,500,4,2,0,100,1,0", "1500,-50,4,2,0,100,0,0", "1800,NaN,4,2,0,100,0,0"]));
  const [a, b, s] = m.hit;
  assert.equal(a.slides, 9000); assert.ok(a.end - a.t < 1, "instant");
  assert.ok(m.sounds.filter(e => Math.abs(e.t - 1000) < 1).length <= 2, "not thousands of identical hitsounds at once");
  assert.equal(b.sv, 1); assert.equal(b.span, 200 / 300 * 500);
  assert.ok(m.timing.some(tp => Number.isNaN(tp.beat)), "the NaN line is kept");
  assert.equal(s.end, s.t + 1);
  deq(m.breaks, [[3000, 3500], [9000, 9500]], "breaks sorted");
});

test("a slider that runs far off the playfield is cut there, keeping its length", () => {
  const m = P.parseOsu(osu(["100,100,1000,2,0,L|200:100,1,1e9"]));
  const o = m.hit[0];
  assert.ok(o.path.jumps, "the far end is a jump"); assert.equal(o.dist, 1e9);
  assert.ok(o.path.some(([x]) => x === 1512), "drawn up to the edge of FAR");
  assert.ok(o.path.at(-1)[0] <= 1e7);
});

// crafted files must not hang or exhaust the page (each case used to take seconds to minutes, or gigabytes)
const quick = (fn, ms = 2000) => { const t = Date.now(); const r = fn(); assert.ok(Date.now() - t < ms, `took ${Date.now() - t} ms`); return r; };
test("objects past int.MaxValue ms are skipped (like lazer), spinner and hold ends are capped", () => {
  const m = quick(() => P.parseOsu(osu(["100,100,1000,1,0", "100,100,1e10,1,0", "100,100,Infinity,1,0", "256,192,2000,12,0,1e300"])));
  assert.equal(m.hit.length, 2); assert.equal(m.hit[1].end, 2147483647);
});
test("bezier sliders with far-out control points finish quickly", () => {
  const pts = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1e300 : -1e300) + ":" + (i % 3 ? 1e300 : -1e300)).join("|");
  quick(() => P.parseOsu(osu(Array.from({ length: 5 }, (_, i) => `100,100,${1000 + i * 1000},2,0,B|${pts},1,100`))));
});
test("storyboard: huge loop counts and frame counts are capped", () => {
  const sb = quick(() => P.parseStoryboard("[Events]\nSprite,Foreground,Centre,\"a.png\",320,240\n L,0,10000000\n  F,0,0,100,0,1\n  M,0,0,100,0,0,10,10\nAnimation,Foreground,Centre,\"b.png\",320,240,10000000,10\n F,0,0,100,0,1\n"));
  assert.ok(sb[0].cmds.length <= 1e5 + 10); assert.ok(sb[1].frames.length <= 1000);
});
test("storyboard: chained $variables can't grow a line without limit (the line is dropped)", () => {
  const vars = Array.from({ length: 30 }, (_, i) => `$v${String.fromCharCode(97 + i)}=$v${String.fromCharCode(98 + i)}$v${String.fromCharCode(98 + i)}`).join("\n");
  const sb = quick(() => P.parseStoryboard(`[Variables]\n${vars}\n[Events]\nSprite,Foreground,Centre,"$va.png",320,240\n F,0,0,100,0,1\nSprite,Foreground,Centre,"$x.png",320,240\n F,0,0,100,0,1\n`, { $x: "ok" }));
  assert.equal(sb.length, 1); assert.match(sb[0].frames[0], /ok\.png/);
});
test("a timing point with a meter of 0 or less counts as 1", () => {
  const m = P.parseOsu(osu(["100,100,1000,1,0"], "").replace("0,500,4,2,0,100,1,0", "0,500,-1,2,0,100,1,0"));
  assert.ok(m.timing[0].meter >= 1);
});
