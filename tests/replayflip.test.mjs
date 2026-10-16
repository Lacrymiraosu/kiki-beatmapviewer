// A replay with Hard Rock is drawn with the playfield flipped upside down (js/player.js), so the stacks (js/parse.js placeStacks) must point
// up-left on that flipped picture: the vertical offset is turned round for the replay (STACK_FLIPY) and put back after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/parse.js"], "function setFlip(v) { STACK_FLIPY = v; }"); // (the script's own let is set through a function in its scope)
const osu = objects => P.parseOsu(`osu file format v14\n\n[General]\nStackLeniency: 0.7\nMode: 0\n\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`);
const circle = (x, y, t) => `${x},${y},${t},1,0,0:0:0:0:`;
const slider = (x, y, t, len) => `${x},${y},${t},2,0,L|${x + len}:${y},1,${len},0|0,0:0|0:0,0:0:0:0:`;
const rows = m => m.hit.map(o => ({ x: o.x, y: o.y, rx: o.rx, ry: o.ry, stack: o.stack, p0: o.path ? [o.path[0][0], o.path[0][1]] : null }));

test("stacks point up-left; for a Hard Rock replay the vertical offset is turned round, and leaving puts it back", () => {
  // three circles on one spot a beat apart, and a slider that starts there: a stack of four
  const m = osu([circle(200, 150, 1000), circle(200, 150, 1250), circle(200, 150, 1500), slider(200, 150, 1750, 100)]);
  const off = m.radius / 10, base = J(rows(m));
  assert.ok(base.some(r => r.stack !== 0), "there is a stack");
  for (const r of base) { const s = r.stack * off; assert.ok(Math.abs(r.x - (r.rx - s)) < 1e-9 && Math.abs(r.y - (r.ry - s)) < 1e-9, "up-left"); }
  // the replay with Hard Rock: the radius is the modded one, the vertical offset turned round
  const r2 = m.radius * 31.12 / 36.49, off2 = r2 / 10;
  P.setFlip(true); P.placeStacks(m.hit, off2, true);
  for (const o of m.hit) { const s = o.stack * off2; assert.ok(Math.abs(o.x - (o.rx - s)) < 1e-9, "x still to the left"); assert.ok(Math.abs(o.y - (o.ry + s)) < 1e-9, "y turned round: down in the map's frame = up on the flipped picture"); }
  const sl = m.hit[3]; assert.ok(Math.abs(sl.path[0][1] - (sl.ry + sl.stack * off2)) < 1e-9, "the slider's path too");
  // back: exactly what the map had
  P.setFlip(false); P.placeStacks(m.hit, off, true);
  assert.deepEqual(J(rows(m)), base);
});

test("placing the stacks again does not drift: twice with the same offset gives the same positions", () => {
  const m = osu([circle(100, 100, 1000), circle(100, 100, 1250), slider(100, 100, 1500, 80)]);
  const off = m.radius / 10;
  P.setFlip(true); P.placeStacks(m.hit, off, true); const a = J(rows(m)); P.placeStacks(m.hit, off, true); const b = J(rows(m));
  P.setFlip(false); P.placeStacks(m.hit, off, true);
  assert.deepEqual(a, b);
});
