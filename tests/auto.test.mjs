// js/auto.js (Auto's cursor) checked against osu!lazer's OsuAutoGenerator rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "./lib/browser.mjs";

const osu = (objects, extra = "") => `osu file format v14\n\n[General]\nStackLeniency: 0.7\n\n[Difficulty]\nCircleSize:4\nApproachRate:9\nOverallDifficulty:5\nSliderMultiplier:1.4\nSliderTickRate:1\n${extra}\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`;
function open(objects) {
  const P = loadScripts(["js/parse.js", "js/auto.js"]);
  P[`(map = parseOsu(${JSON.stringify(osu(objects))}), 0)`];
  const at = t => { const p = P[`cursorAt(${t})`]; return [p[0], p[1]]; };
  return { P, at, key: t => P[`autoKeyAt(${t})`] };
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearP = (p, q, eps = 1e-6, msg) => assert.ok(near(p[0], q[0], eps) && near(p[1], q[1], eps), `${msg || ""} got ${p} want ${q}`);

test("starts below the playfield, waits for the reaction time, then eases out to the object (AR9: 600 ms preempt)", () => {
  const { at, key } = open(["100,100,1000,1,0", "400,300,2000,1,0"]);
  nearP(at(-800), [256, 500], 1e-9, "before the first frame (1.5 s early)");
  nearP(at(499), [256, 500], 1e-9, "still waiting: 100 ms after the object starts to fade in (1000 - 600 + 100)");
  nearP(at(750), [256 + (100 - 256) * .75, 500 + (100 - 500) * .75], 1e-9, "Easing.Out halfway: 3/4 of the way");
  nearP(at(1000), [100, 100], 1e-9, "on the object on time");
  assert.equal(key(1000), 1); assert.equal(key(1049), 1); assert.equal(key(1050), 0, "the button goes up after 50 ms");
  nearP(at(1499), [100, 100], 1e-9, "waits on the object until it can see the next one");
  nearP(at(2000), [400, 300], 1e-9);
});

test("close objects: the move starts as the button goes up, and the buttons alternate under 266 ms", () => {
  const { at, key } = open(["400,300,2000,1,0", "100,300,2100,1,0", "100,100,2600,1,0"]);
  // key up at 2050 (no wait: the next one shows at 1500); its position as if the move had started at 2000
  nearP(at(2050), [400 + (100 - 400) * .75, 300], 1e-9);
  nearP(at(2025), [(400 + 175) / 2, 300], 1e-9, "a straight line between frames");
  nearP(at(2100), [100, 300], 1e-9);
  assert.equal(key(2000), 1); assert.equal(key(2100), 2, "50 ms after the key-up: the other button"); assert.equal(key(2600), 1, "450 ms: back to the left one");
});

test("sliders: it follows the ball, then holds 50 ms past the end", () => {
  const { P, at, key } = open(["100,100,1000,2,0,L|300:100,1,140", "300,300,2000,1,0"]);
  const s = P["map.hit[0]"];
  for (const t of [1000, 1100, 1250, s.end]) { const p = P[`pointAt(map.hit[0], ballF(map.hit[0], ${t}).f)`]; nearP(at(t), [p[0], p[1]], 1e-9, "t=" + t); }
  assert.equal(key(s.end + 49), 1); assert.equal(key(s.end + 50), 0);
});

test("spinners: in at the tangent point, round a 50 px circle at 0.05 rad/ms; too short to need a turn: left alone", () => {
  const { P, at, key } = open(["256,392,1000,1,0", "256,192,2000,8,0,5000"]);
  for (const t of [2000, 2500, 3333, 4999]) { const p = at(t); assert.ok(near(Math.hypot(p[0] - 256, p[1] - 192), 50, 1e-6), "on the circle at " + t); }
  const a1 = at(3000), a2 = at(3010), d = Math.atan2(a2[1] - 192, a2[0] - 256) - Math.atan2(a1[1] - 192, a1[0] - 256);
  assert.ok(near(((d + 3 * Math.PI) % (2 * Math.PI)) - Math.PI, -.5, 1e-9), "−0.5 rad in 10 ms");
  // it arrives going the way it then turns: the last bit of the move points along the circle
  const p0 = at(1990), p1 = at(2000), q = at(2010), mv = [p1[0] - p0[0], p1[1] - p0[1]], sp = [q[0] - p1[0], q[1] - p1[1]];
  assert.ok((mv[0] * sp[0] + mv[1] * sp[1]) / Math.hypot(...mv) / Math.hypot(...sp) > .95, "no turn back on entry");
  assert.equal(key(3000), 1);
  const short = open(["100,100,1000,1,0", "256,192,1200,8,0,1300", "400,100,1700,1,0"]);
  const mid = short.at(1250); assert.ok(Math.hypot(mid[0] - 256, mid[1] - 192) > 60, "no detour to a 100 ms spinner");
});

test("an object that starts while a slider is held takes over, with the other button", () => {
  const { at, key } = open(["100,100,1000,2,0,L|400:100,1,300", "100,300,1200,1,0"]);
  assert.equal(key(1100), 1); assert.equal(key(1200), 2);
  nearP(at(1200), [100, 300], 1e-9);
});

test("rebuilt when the objects change, and an empty map has a resting cursor", () => {
  const { P, at } = open(["100,100,1000,1,0"]);
  nearP(at(1000), [100, 100]);
  P[`(map.hit[0].x = 200, map.hit = [...map.hit], 0)`];
  nearP(at(1000), [200, 100], 1e-9, "a new objects array: a new replay");
  const e = open([]); nearP(e.at(0), [256, 192]);
});
