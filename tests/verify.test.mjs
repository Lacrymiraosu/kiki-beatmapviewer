// js/verify.js against MapsetVerifier's rules: the cases are the ones from MapsetVerifier's own check tests
// (github.com/Naxesss/MapsetVerifier, MapsetVerifier.Checks.Tests), rebuilt here with the same .osu input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/parse.js", "js/verify.js"], `
const fmtMs = ms => { const neg = ms < 0; ms = Math.abs(Math.round(ms)); return (neg ? "-" : "") + String(Math.floor(ms / 60000)).padStart(2, "0") + ":" + String(Math.floor(ms / 1000) % 60).padStart(2, "0") + ":" + String(ms % 1000).padStart(3, "0"); };
const fmt = s => (s = Math.max(0, s || 0), Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"));
`);

// OsuBuilder (MV's test helper): CS 4, HP/OD/AR 5, SV 1.4, tick rate 1, one red line 0,500 by default
function osu({ mode = 0, version = "Test", cs = 4, ar = 5, od = 5, hp = 5, sm = 1.4, tick = 1, timing = ["0,500,4,2,0,100,1,0"], objects = [], extra = "", tags = "" } = {}) {
  return ["osu file format v14", "[General]", "AudioFilename: audio.mp3", `Mode: ${mode}`, "PreviewTime: 0", extra, "[Metadata]", "Title:Test", "Artist:Test", "Creator:Test", `Version:${version}`, `Tags:${tags}`,
    "[Difficulty]", `CircleSize:${cs}`, `HPDrainRate:${hp}`, `OverallDifficulty:${od}`, `ApproachRate:${ar}`, `SliderMultiplier:${sm}`, `SliderTickRate:${tick}`,
    "[Events]", "[TimingPoints]", ...timing, "[HitObjects]", ...objects].join("\n");
}
const circle = (t, { x = 256, y = 192, hs = 0 } = {}) => `${x},${y},${t},1,${hs},0:0:0:0:`;
const slider = (t, { curve = "L", pts = "256:300", slides = 1, len = 100, x = 256, y = 192, hs = 0 } = {}) =>
  [x, y, t, 2, hs, `${curve}|${pts}`, slides, len, Array(slides + 1).fill(0).join("|"), Array(slides + 1).fill("0:0").join("|"), "0:0:0:0:"].join(",");

// run one difficulty check on a map -> [{ lvl, text }]
function diffCheck(title, opts, lvl = 3, ctx = {}) {
  const m = P.parseOsu(osu(opts)), c = P.DIFF_CHECKS.find(x => x.title === title);
  assert.ok(c, "no check " + title);
  const out = [];
  c.run(m, (l, msg, v = {}) => out.push({ lvl: l, text: msg.replace(/\{(\w+)\}/g, (_, k) => v[k]) }), lvl, ctx);
  return J(out);
}
function setCheck(title, maps) {
  const ctx = { maps: maps.map((o, i) => { const m = P.parseOsu(osu(o)); return { m, i, lvl: P.diffLevel(m, o.stars), stars: o.stars ?? null }; }) };
  const c = P.SET_CHECKS.find(x => x.title === title), out = [];
  c.run(ctx, (l, msg, v = {}) => out.push({ lvl: l, text: msg.replace(/\{(\w+)\}/g, (_, k) => v[k]) }));
  return J(out);
}
const one = list => { assert.equal(list.length, 1, JSON.stringify(list)); return list[0]; };

test("snapping helpers: measured against the grid time cut to a whole ms, smallest unsnap wins", () => {
  const m = P.parseOsu(osu({ timing: ["8900,300,4,2,1,60,1,0"] }));
  assert.equal(P.practicalUnsnap(47674, m), -1, "a whole ms before an exact grid point is a 1 ms unsnap");
  assert.ok(Math.abs(P.practicalUnsnap(47675.000000004, m)) < 1e-6, "float noise on an exact grid point is no unsnap");
  const m2 = P.parseOsu(osu({ timing: ["0,333.333333333333,4,2,0,100,1,0"] }));
  assert.equal(P.lowestDivisor(333, m2), 1, "1/1 at 180 BPM (333.33 ms, stored as 333)");
  assert.equal(P.lowestDivisor(83, m2), 4, "1/4 (83.33 ms, stored as 83)");
  assert.equal(P.lowestDivisor(111, m2), 3, "1/3 (111.11 ms)");
  assert.equal(P.lowestDivisor(150, m2), 9, "1/9 (148.15 -> 148) is within 2 ms");
  assert.equal(P.lowestDivisor(160, m2), 0, "nowhere near a tick");
});

test("Unsnapped hit objects (MV CheckUnsnapsTests)", () => {
  const two = ["0,500,4,2,0,100,1,0", "175,500,4,2,0,100,1,0"];
  assert.deepEqual(diffCheck("Unsnapped hit objects", { sm: 1.7, timing: two, objects: ["256,192,0,6,0,L|300:192,1,59.16,2|2,0:0:0:0:"] }), [], "a tail snapped to an upcoming misaligned red line");
  assert.ok(diffCheck("Unsnapped hit objects", { sm: 1.7, timing: two, objects: [circle(127)] }).length, "an unsnapped circle");
  assert.ok(diffCheck("Unsnapped hit objects", { sm: 1.7, timing: two, objects: ["256,192,0,6,0,L|300:192,1,50,2|2,0:0:0:0:"] }).some(i => i.text.includes("Slider tail")), "a tail well before the red line");
  assert.deepEqual(diffCheck("Unsnapped hit objects", { sm: 1.6, timing: ["8900,300,4,2,1,60,1,0", "47300,-133.333333333333,4,2,1,60,0,0"], objects: ["419,134,47600,2,0,P|434:128|447:125,1,30.0000011444092"] }), [], "a tail landing exactly on a whole ms");
  const i = one(diffCheck("Unsnapped hit objects", { sm: 1.6, timing: ["8900,300,4,2,1,60,1,0"], objects: [circle(47674)] }));
  assert.equal(i.lvl, "minor"); assert.match(i.text, /is -1 ms unsnapped/);
});

test("Hit objects potentially snapped to the wrong red line (MV CheckRedLineSnappingTests)", () => {
  const T = "Hit objects potentially snapped to the wrong red line";
  const i = one(diffCheck(T, { timing: ["0,500,4,2,0,100,1,0", "175,500,4,2,0,100,1,0"], objects: [circle(125)] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /next red line at 00:00:175/);
  assert.deepEqual(diffCheck(T, { timing: ["0,500,4,2,0,100,1,0", "2000,500,4,2,0,100,1,0"], objects: [circle(1875)] }), [], "the next red line keeps the grid");
  assert.deepEqual(diffCheck(T, { timing: ["0,500,4,2,0,100,1,0", "250,500,4,2,0,100,1,0"], objects: [circle(125)] }), [], "beyond the lookahead");
  assert.deepEqual(diffCheck(T, { timing: ["0,500,4,2,0,100,1,0", "175,500,4,2,0,100,1,0"], objects: [circle(127)] }), [], "already unsnapped");
});

test("Unused timing lines (MV CheckUnusedLinesTests)", () => {
  const T = "Unused timing lines", red = "0,500,4,2,0,100,1,0";
  let i = one(diffCheck(T, { timing: [red, "8000,500,4,2,0,100,1,0"], objects: [circle(9000)] }));
  assert.equal(i.lvl, "problem"); assert.match(i.text, /has no effect\.$/);
  i = one(diffCheck(T, { timing: [red, "8000,500,4,2,0,50,1,0"], objects: [circle(8500)] }));
  assert.equal(i.lvl, "problem"); assert.match(i.text, /could be done with a green line/);
  i = one(diffCheck(T, { timing: [red, "8000,500,4,2,0,100,1,8"], objects: [circle(9000)] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /only omits the first bar line/); assert.match(i.text, /or delete it/);
  i = one(diffCheck(T, { timing: [red, "8000,500,4,2,0,50,1,8"], objects: [circle(8500)] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /or use a green line instead/);
  i = one(diffCheck(T, { timing: [red, "2000,500,4,2,0,100,1,0"], objects: [circle(3000)] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /resets the nightcore mod cymbals/);
  assert.deepEqual(diffCheck(T, { timing: [red, "1000,400,4,2,0,100,1,0"], objects: [circle(2000)] }), [], "a different BPM");
  assert.deepEqual(diffCheck(T, { timing: [red, "1234,500,4,2,0,100,1,0"], objects: [circle(2000)] }), [], "not on a downbeat");
  assert.deepEqual(diffCheck(T, { timing: [red, "1000,-50,4,2,0,100,0,0"], objects: ["256,192,100,2,0,L|256:220,1,10,0|0,0:0|0:0,0:0:0:0:", "256,192,1500,2,0,L|256:300,1,100,0|0,0:0|0:0,0:0:0:0:"] }), [], "SV used by a slider");
  assert.deepEqual(diffCheck(T, { timing: [red, "2000,-100,4,2,0,50,0,0"], objects: ["256,192,1500,8,0,2500,0:0:0:0:"] }), [], "samples used by a spinner running into the section");
  i = one(diffCheck(T, { timing: [red, "1000,-50,4,2,0,100,0,0"], objects: [circle(500)] }));
  assert.equal(i.lvl, "minor"); assert.match(i.text, /green line changes the SV, but no object is affected/);
  i = one(diffCheck(T, { timing: [red, "5000,-100,4,2,0,30,0,0"], objects: [circle(1000)] }));
  assert.match(i.text, /green line changes the sample settings, but no object is affected/);
  i = one(diffCheck(T, { timing: [red, "5000,-50,4,2,0,30,0,0"], objects: [circle(1000)] }));
  assert.match(i.text, /green line changes the SV and sample settings, but no object is affected/);
  i = one(diffCheck(T, { timing: [red, "1000,-100,4,2,0,100,0,0"], objects: [circle(2000)] }));
  assert.match(i.text, /repeats the settings of the line before it/);
});

test("Offscreen hit objects (MV CheckOffscreenTests)", () => {
  const T = "Offscreen hit objects", o = objects => diffCheck(T, { cs: 5, objects });
  assert.deepEqual(o([circle(1000, { y: 340 })]), []);
  let i = one(o([circle(1000, { y: 397 })])); assert.equal(i.lvl, "problem"); assert.match(i.text, /Circle is offscreen/);
  i = one(o([circle(1000, { y: 396 })])); assert.equal(i.lvl, "warning"); assert.match(i.text, /Circle is 0 px from the edge of the screen/);
  assert.deepEqual(o([circle(1000, { y: 395 })]), []);
  i = one(o([slider(1000, { pts: "256:396", len: 95.5, y: 300 })])); assert.match(i.text, /Slider tail is 0.5 px from the edge/);
  i = one(o([slider(1000, { pts: "256:400", len: 100, y: 300 })])); assert.equal(i.lvl, "problem"); assert.match(i.text, /Slider tail is offscreen/);
  i = one(o([slider(1000, { pts: "256:396", len: 96, y: 300 })])); assert.match(i.text, /Slider tail is 0 px from the edge/);
  i = one(o([slider(1000, { pts: "547:192", len: 291, x: 256 })])); assert.match(i.text, /Slider tail is 0 px from the edge/);
  i = one(o([slider(1000, { pts: "256:396", slides: 2, len: 96, y: 300 })])); assert.match(i.text, /Slider body is 0 px from the edge/);
  i = one(diffCheck(T, { cs: 4, sm: 2.4, objects: ["150,39,1000,6,0,B|144:-23|144:-23|173:105,1,180,0|0,0:0|0:0,0:0:0:0:"] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /Slider body is 0\./);
  assert.deepEqual(o([slider(1000, { pts: "256:340", len: 100, y: 240 })]), []);
});

test("Slider only section, Easy and Normal (MV CheckSliderOnlySectionsTests)", () => {
  const T = "Slider only section", run = objects => diffCheck(T, { objects }, 0);
  const sl = (a, b, step = 1000) => { const r = []; for (let t = a; t <= b; t += step) r.push(slider(t)); return r; };
  assert.match(one(run([...sl(0, 7000), circle(9000)])).text, /8 objects/);
  one(run(sl(0, 7000)));
  assert.deepEqual(run([...sl(0, 4000), circle(6000)]), []);
  assert.deepEqual(run([...sl(0, 700, 100), circle(1000)]), []);
  assert.deepEqual(run([...sl(0, 3000), circle(4000), ...sl(5000, 8000), circle(9000)]), []);
  assert.ok(!P.DIFF_CHECKS.find(c => c.title === T).lv.includes(2), "not for Hard and above");
});

test("Hit sound consistency between difficulties (MV CheckHitSoundConsistencyTests)", () => {
  const T = "Inconsistent hit sounds between difficulties";
  let i = one(setCheck(T, [{ version: "A", objects: [circle(1000, { hs: 8 })] }, { version: "B", objects: [circle(1000)] }]));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /\[B\] is missing clap/);
  const list = setCheck(T, [{ version: "A", objects: [circle(1000, { hs: 8 })] }, { version: "B", objects: [circle(1000)] }, { version: "C", objects: [circle(1000)] }]);
  assert.equal(list.length, 2); assert.ok(list.every(x => x.lvl === "minor"));
  assert.deepEqual(setCheck(T, [{ version: "A", objects: [circle(1000, { hs: 8 })] }, { version: "B", objects: [circle(1000, { hs: 8 })] }]), []);
  i = one(setCheck(T, [{ version: "A", objects: ["256,192,1000,2,2,L|256:300,1,120,0|0,0:0|0:0,0:0:0:0:"] }, { version: "B", objects: [circle(1000)] }]));
  assert.equal(i.lvl, "minor"); assert.match(i.text, /\[A\] This slider body has additions/);
});

test("Spread checks use MV's thresholds and scope", () => {
  // objects close in time, only on the lowest difficulty and only after a circle
  const close = [circle(1000, { x: 100 }), circle(1100, { x: 400 })];
  assert.equal(one(diffCheck("Objects close in time not overlapping", { objects: close }, 0)).lvl, "problem");
  assert.deepEqual(diffCheck("Objects close in time not overlapping", { objects: close }, 1, { hasEasy: true }), [], "a Normal when there's an Easy");
  assert.deepEqual(diffCheck("Objects close in time not overlapping", { objects: [slider(1000, { x: 100, pts: "100:150", len: 42 }), circle(1100, { x: 400 })] }, 0), [], "after a slider");
  // spinner recovery: BPM scaling bpm²/14400 - bpm/80 + 1 (180 BPM = 1)
  const rec = diffCheck("Spinner length / recovery time", { timing: ["0,333.333333333333,4,2,0,100,1,0"], objects: ["256,192,0,8,0,2000,0:0:0:0:", circle(2900)] }, 0);
  assert.ok(rec.some(x => x.lvl === "problem" && /Only 900 ms to recover after the spinner; it should be at least 1334/.test(x.text)), JSON.stringify(rec));
  // multiple reverses: Easy 1/1 at 240 BPM (250 ms) / 180 BPM (333 ms)
  const rev = len => diffCheck("Multiple reverses on too short sliders", { objects: [slider(1000, { slides: 3, len })] }, 0);
  assert.equal(one(rev(20)).lvl, "problem"); assert.equal(one(rev(28)).lvl, "warning"); assert.deepEqual(rev(40), []); // (3 spans of len / 140 * 500 ms)
});

test("Settings: tick rate, difficulty ranges and level by name", () => {
  const tick = v => diffCheck("Slider tick rate", { tick: v });
  for (const ok of [1, 2, 3, 5, 7, 0.5, 1.333, 1.5]) assert.deepEqual(tick(ok), [], "tick rate " + ok);
  assert.equal(one(tick(0.7)).lvl, "problem");
  assert.equal(P.diffLevel(P.parseOsu(osu({ version: "Kensuke's Insane" })), 1.5), 3, "an exact name beats the star rating");
  assert.equal(P.diffLevel(P.parseOsu(osu({ version: "Extra Stage" })), 5.6), 4, "otherwise the star rating");
  assert.ok(!P.DIFF_CHECKS.find(c => c.title === "Difficulty settings outside of the guideline range").lv.includes(5), "no ranges for Ultra");
});

test("Breaks, drain time and concurrent objects", () => {
  // a break counts from the object before it to the object after it
  const m = P.parseOsu(osu({ objects: [circle(0), circle(10000), circle(40000)], extra: "" }).replace("[Events]", "[Events]\n2,12000,38000"));
  assert.equal(P.drainOf(m), 40000 - 30000);
  const b = diffCheck("Breaks", { objects: [circle(1000), circle(5000)] }); assert.deepEqual(b, []);
  const conc = diffCheck("Concurrent hit objects", { objects: [circle(1000), circle(1005), circle(1500)] });
  assert.equal(one(conc).lvl, "problem"); assert.match(conc[0].text, /only 5 ms apart/);
});

test("Perfect stacks with Hard Rock: HR's shorter stack time leaves objects on the same spot", () => {
  const sl = "StackLeniency: 0.2"; // stack time 240 ms at AR 5, 180 ms at AR 7 (HR)
  const hit = one(diffCheck("Perfect stacks too close in time with Hard Rock applied", { extra: sl, objects: [circle(1000), circle(1200)] }));
  assert.deepEqual(hit, { lvl: "minor", text: "With Hard Rock these objects stack perfectly; raise stack leniency to 0.3 or more." });
  assert.equal(diffCheck("Perfect stacks too close in time with Hard Rock applied", { extra: sl, objects: [circle(1000), circle(1150)] }).length, 0, "stacked with HR too");
  assert.equal(diffCheck("Perfect stacks too close in time with Hard Rock applied", { extra: sl, objects: [circle(1000), circle(1300)] }).length, 0, "not stacked without HR either: a perfect stack the normal check reports");
});

test("Stacking: a slider with an even number of slides ends on its head", () => {
  const m = P.parseOsu(osu({ objects: [slider(1000, { slides: 2 }), circle(1800)] })); // the slider ends at 1714, back on 256,192
  assert.equal(m.hit[1].stack, -1);
  const m2 = P.parseOsu(osu({ objects: [slider(1000, { slides: 1 }), circle(1400, { y: 292 })] })); // one slide: ends 100 px along, at 256,292
  assert.equal(m2.hit[1].stack, -1);
});

test("Missing genre/language in tags (MV CheckGenreLanguage)", () => {
  const texts = tags => setCheck("Missing genre/language in tags", [{ tags }]).map(x => x.text.split(" (")[0]);
  assert.deepEqual(texts(""), ["Missing genre tag", "Missing language tag"]);
  assert.deepEqual(texts("Electronic Japanese"), []);
  assert.deepEqual(texts("video game instrumental"), []);
  assert.deepEqual(texts("game english"), ["Missing genre tag"], "\"video game\" needs both words");
});
