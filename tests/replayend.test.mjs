// The end of a replay (js/replay.js rpSkipAt / rpShowEndSkip): Skip after the last object, or the last frame when that is first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js"]);
const frames = (...ts) => ({ n: ts.length, t: Float64Array.from(ts) });

test("rpSkipAt: a normal replay (frames run past the last object) is the last object", () => {
  assert.equal(P.rpSkipAt(60000, frames(0, 30000, 62000)), 60000);
});
test("rpSkipAt: a truncated replay (the player quit) is its last frame", () => {
  assert.equal(P.rpSkipAt(60000, frames(0, 20000, 41000)), 41000);
});
test("rpSkipAt: no frames, or junk, falls back to the last object (or 0)", () => {
  assert.equal(P.rpSkipAt(60000, null), 60000);
  assert.equal(P.rpSkipAt(60000, { n: 0, t: new Float64Array(0) }), 60000);
  assert.equal(P.rpSkipAt(NaN, null), 0);
  assert.equal(P.rpSkipAt(undefined, frames(5)), 0);
});
test("rpShowEndSkip: nothing before the point, shown 1 s after it", () => {
  assert.equal(P.rpShowEndSkip(59999, 60000, 120000), false);
  assert.equal(P.rpShowEndSkip(60000, 60000, 120000), false);
  assert.equal(P.rpShowEndSkip(60999, 60000, 120000), false);
  assert.equal(P.rpShowEndSkip(61000, 60000, 120000), true);
  assert.equal(P.rpShowEndSkip(100000, 60000, 120000), true);
});
test("rpShowEndSkip: not with 3 s or less of the song left", () => {
  assert.equal(P.rpShowEndSkip(116999, 60000, 120000), true);
  assert.equal(P.rpShowEndSkip(117000, 60000, 120000), false);
  assert.equal(P.rpShowEndSkip(119000, 60000, 120000), false);
  assert.equal(P.rpShowEndSkip(61000, 60000, 62000), false); // (a song that ends 2 s after the last object, e.g. no audio: never)
});
test("a truncated replay: Skip from 1 s after its last frame, while the song goes on", () => {
  const at = P.rpSkipAt(60000, frames(0, 20000, 41000));
  assert.equal(P.rpShowEndSkip(41500, at, 120000), false);
  assert.equal(P.rpShowEndSkip(42000, at, 120000), true);
});
