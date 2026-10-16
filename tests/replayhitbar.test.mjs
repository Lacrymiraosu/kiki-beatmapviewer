// The hit error bar and the unstable rate of a watched replay (js/replayana.js rpHitBar / rpUrAt / rpBarAt / rpErrClass; drawn by js/player.js drawHitBar):
// pure functions of the song time from the analysis' hits, so a seek or a pause shows the same numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js", "js/parse.js", "js/replayana.js"]);
const hit = (press, err, o = {}) => ({ press, err, judge: 300, slider: false, ...o });
const an = (hits, rate = 1) => ({ hits, rate });

test("the bar keeps hits with a press in press order; misses have none", () => {
  const a = an([hit(300, 5), hit(100, -5), { press: null, err: null, judge: 0 }, hit(200, 0)]), b = P.rpHitBar(a);
  assert.equal(b.n, 3); assert.deepEqual([...b.t], [100, 200, 300]); assert.deepEqual([...b.e], [-5, 0, 5]);
  assert.equal(P.rpHitBar(a), b, "made once per analysis");
  assert.equal(P.rpHitBar(null), null); assert.equal(P.rpHitBar({}), null);
});
test("UR: 10 x the population standard deviation of the errors so far / rate; none before two hits; the same at any time (a seek back gives the same)", () => {
  const b = P.rpHitBar(an([hit(100, -10), hit(200, 10), hit(300, -10), hit(400, 10)]));
  assert.equal(P.rpUrAt(b, 1, 100), null); assert.equal(P.rpUrAt(b, 1, 99), null);
  assert.ok(Math.abs(P.rpUrAt(b, 1, 200) - 100) < 1e-9); assert.ok(Math.abs(P.rpUrAt(b, 1, 1e9) - 100) < 1e-9);
  assert.ok(Math.abs(P.rpUrAt(b, 2, 1e9) - 50) < 1e-9, "DT: the real-time spread");
  const x = P.rpUrAt(b, 1, 300), y = P.rpUrAt(b, 1, 1e9); assert.equal(P.rpUrAt(b, 1, 300), x); assert.ok(y !== undefined);
  const c = P.rpHitBar(an([hit(10, 7), hit(20, 7), hit(30, 7)])); assert.equal(P.rpUrAt(c, 1, 100), 0, "all alike: 0, never NaN");
  assert.equal(P.rpUrAt(b, 1, NaN), null); assert.equal(P.rpUrAt(null, 1, 5), null); assert.equal(P.rpUrAt(b, 0, 500), null);
});
test("UR at the end is the analysis' own a.stats.ur formula (population sd, 10 x, / rate)", () => {
  const errs = [-23, 4, 17, -8, 0, 31, -12, 9, 2, -40], hits = errs.map((e, i) => hit(100 * (i + 1), e)), n = errs.length;
  const mean = errs.reduce((s, v) => s + v, 0) / n, sd = Math.sqrt(errs.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  for (const rate of [1, 1.5, .75]) assert.ok(Math.abs(P.rpUrAt(P.rpHitBar(an(hits.map(h => ({ ...h })), rate)), rate, 1e9) - 10 * sd / rate) < 1e-9);
});
test("the ticks: the hits pressed in the last ms; the average is over the last N", () => {
  const b = P.rpHitBar(an([hit(1000, -20), hit(2000, 10), hit(3500, 30), hit(4000, 0)]));
  let q = P.rpBarAt(b, 4100, 3000, 2); assert.equal(q.k, 4); assert.equal(q.from, 1, "1000 is older than 4100 - 3000"); assert.equal(q.avg, 15);
  q = P.rpBarAt(b, 3600, 3000, 10); assert.equal(q.k, 3); assert.equal(q.from, 0); assert.equal(q.avg, 20 / 3);
  q = P.rpBarAt(b, 500, 3000, 10); assert.equal(q.k, 0); assert.equal(q.avg, null);
  q = P.rpBarAt(b, 1e9, 3000, 10); assert.equal(q.k, 4); assert.equal(q.from, 4, "all faded"); assert.equal(q.avg, 5);
  assert.equal(P.rpBarAt(b, NaN, 3000, 10), null); assert.equal(P.rpBarAt(null, 5, 3000, 10), null);
});
test("a tick's colour is from |error| against the compared windows, not from the judge (a slider head counts 300 whenever it is hit)", () => {
  const j = { w300: 19.5, w100: 59.5, w50: 99.5 };
  assert.equal(P.rpErrClass(-19.5, j), 300); assert.equal(P.rpErrClass(19.6, j), 100); assert.equal(P.rpErrClass(-59.5, j), 100); assert.equal(P.rpErrClass(80, j), 50); assert.equal(P.rpErrClass(5, null), 300);
});
