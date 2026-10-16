// The loading scene (js/loadscene.js): the progress rule (drawn progress never goes back within a flow; a new flow = the cover hidden for more than
// 600 ms) and the geometry of the three notes. loadscene.js runs alone in its own vm (no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const load = () => {
  const ctx = vm.createContext({ Math, Date, JSON });
  vm.runInContext(readFileSync(new URL("../js/loadscene.js", import.meta.url), "utf8"), ctx, { filename: "js/loadscene.js" });
  return new Proxy({}, { get: (_, k) => vm.runInContext(k, ctx) });
};
const plain = v => JSON.parse(JSON.stringify(v));

test("ldsStep: progress is monotonic within a flow, -1 keeps what was drawn", () => {
  const L = load(), seq = [];
  let st = null, t = 1000;
  for (const p of [-1, .2, .5, .3, -1, .9, -1]) { st = L.ldsStep(st, p, t += 50, 0); seq.push([st.mode, st.prog]); }
  assert.deepEqual(plain(seq), [["lp", -1], ["dt", .2], ["dt", .5], ["dt", .5], ["hd", .5], ["dt", .9], ["hd", .9]]);
  assert.equal(L.ldsStep(st, 7, t, 0).prog, 1, "progress is capped at 1");
  const z = L.ldsStep(null, 0, t, 0);
  assert.equal(z.mode, "lp", "0% has drawn nothing: keep the loop");
  assert.equal(L.ldsStep(z, -1, t, 0).mode, "lp", "and a -1 after 0% still loops");
  assert.equal(L.ldsStep(z, .05, t, 0).mode, "dt");
  assert.equal(L.ldsStep(null, NaN, t, 0).mode, "lp", "NaN counts as indeterminate");
});

test("ldsStep: a new flow (cover hidden for more than 600 ms) starts from nothing", () => {
  const L = load();
  const st = L.ldsStep(L.ldsStep(null, -1, 0, 0), .6, 10, 0);
  assert.equal(L.ldsStep(st, -1, 2000, 2000 - 500).prog, .6, "hidden 500 ms: same flow");
  assert.equal(L.ldsStep(st, -1, 2000, 2000 - 700).prog, -1, "hidden 700 ms: new flow");
  assert.equal(L.ldsStep(st, -1, 2000, 0).mode, "hd", "never hidden: same flow");
});

test("scene geometry: the notes hit count steps by thirds, the next approach circle closes with the rest", () => {
  const L = load();
  const hits = [0, .2, 1 / 3, .5, 2 / 3, .99, 1, 5, -2].map(q => L.ldsReplayAt(q).hits);
  assert.deepEqual(plain(hits), [0, 0, 1, 1, 2, 2, 3, 3, 0]);
  assert.ok(Math.abs(L.ldsReplayAt(.5).frac - .5) < 1e-9);
  assert.equal(L.ldsReplayAt(1).frac, 1);
  assert.equal(L.LDS_NOTES.length, 3);
});

test("loadscene.js loads without a DOM and ldsShow/ldsHidden do not throw there", () => {
  const L = load();
  L.ldsShow(.3); L.ldsHidden(); L.ldsShow(-1);
});
