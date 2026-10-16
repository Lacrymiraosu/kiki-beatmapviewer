// What the results screen shows beyond the header (js/replayui.js rpuReplayFacts / rpuClock): the replay's length, the presses of each key (rising edges of the lit state:
// K1 / K2 are bits 4 / 8, M1 / M2 count only without their K bit), and the health curve (needs 3 points).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../js/replayui.js", import.meta.url), "utf8");
const a = src.indexOf("const rpuClock ="), b = src.indexOf("function rpuHealthGraph(");
assert.ok(a > 0 && b > a, "replayui.js: rpuReplayFacts moved");
const cx = {}; vm.createContext(cx); vm.runInContext(src.slice(a, b) + "\nthis.f = rpuReplayFacts; this.c = rpuClock;", cx);
const frames = (t, k) => ({ n: t.length, t: Float64Array.from(t), k: Int32Array.from(k) });

test("clock: m:ss", () => { assert.equal(cx.c(0), "0:00"); assert.equal(cx.c(308000), "5:08"); assert.equal(cx.c(59600), "1:00"); assert.equal(cx.c(-5), "0:00"); });
test("key presses are the rising edges of each key; a held key counts once; K bits carry the M bit along", () => {
  // K1 (4|1) down, up, down(held 2 frames); K2 (8|2) down; M1 alone (1) down; M2 alone (2) down
  const r = cx.f({ frames: frames([0, 10, 20, 30, 40, 50, 60, 70, 80], [0, 5, 0, 5, 5, 10, 1, 2, 0]), lifeBar: [] });
  assert.deepEqual(Array.from(r.keys), [2, 1, 1, 1]); assert.equal(r.len, 80); assert.equal(r.hp, null);
});
test("a replay with no frames: zeros, no length", () => { const r = cx.f({ frames: { n: 0, t: [], k: [] } }); assert.deepEqual(Array.from(r.keys), [0, 0, 0, 0]); assert.equal(r.len, 0); assert.equal(r.hp, null); });
test("the health curve needs 3 good points; its lowest value is clamped to 0..1", () => {
  assert.equal(cx.f({ frames: frames([0], [0]), lifeBar: [[0, 1], [1000, .5]] }).hp, null);
  const r = cx.f({ frames: frames([0], [0]), lifeBar: [[0, 1], [1000, .3], ["x", 2], [2000, 1.4], [3000, -.2]] });
  assert.equal(r.hp.length, 4); assert.equal(r.hpMin, 0);
  assert.equal(cx.f({ frames: frames([0], [0]), lifeBar: [[0, 1], [1, .8], [2, .6]] }).hpMin, .6);
  assert.equal(cx.f({ frames: frames([0], [0]) }).hp, null);
});
