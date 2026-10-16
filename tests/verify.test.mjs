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
  assert.deepEqual(diffCheck("Unsnapped hit objects.", { sm: 1.7, timing: two, objects: ["256,192,0,6,0,L|300:192,1,59.16,2|2,0:0:0:0:"] }), [], "a tail snapped to an upcoming misaligned red line");
  assert.ok(diffCheck("Unsnapped hit objects.", { sm: 1.7, timing: two, objects: [circle(127)] }).length, "an unsnapped circle");
  assert.ok(diffCheck("Unsnapped hit objects.", { sm: 1.7, timing: two, objects: ["256,192,0,6,0,L|300:192,1,50,2|2,0:0:0:0:"] }).some(i => i.text.includes("Slider tail")), "a tail well before the red line");
  assert.deepEqual(diffCheck("Unsnapped hit objects.", { sm: 1.6, timing: ["8900,300,4,2,1,60,1,0", "47300,-133.333333333333,4,2,1,60,0,0"], objects: ["419,134,47600,2,0,P|434:128|447:125,1,30.0000011444092"] }), [], "a tail landing exactly on a whole ms");
  const i = one(diffCheck("Unsnapped hit objects.", { sm: 1.6, timing: ["8900,300,4,2,1,60,1,0"], objects: [circle(47674)] }));
  assert.equal(i.lvl, "minor"); assert.match(i.text, /unsnapped by -1 ms/);
});

test("Hit objects potentially snapped to the wrong red line (MV CheckRedLineSnappingTests)", () => {
  const T = "Hit objects potentially snapped to the wrong red line.";
  const i = one(diffCheck(T, { timing: ["0,500,4,2,0,100,1,0", "175,500,4,2,0,100,1,0"], objects: [circle(125)] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /upcoming red line at 00:00:175/);
  assert.deepEqual(diffCheck(T, { timing: ["0,500,4,2,0,100,1,0", "2000,500,4,2,0,100,1,0"], objects: [circle(1875)] }), [], "the next red line keeps the grid");
  assert.deepEqual(diffCheck(T, { timing: ["0,500,4,2,0,100,1,0", "250,500,4,2,0,100,1,0"], objects: [circle(125)] }), [], "beyond the lookahead");
  assert.deepEqual(diffCheck(T, { timing: ["0,500,4,2,0,100,1,0", "175,500,4,2,0,100,1,0"], objects: [circle(127)] }), [], "already unsnapped");
});

test("Unused timing lines (MV CheckUnusedLinesTests)", () => {
  const T = "Unused timing lines.", red = "0,500,4,2,0,100,1,0";
  let i = one(diffCheck(T, { timing: [red, "8000,500,4,2,0,100,1,0"], objects: [circle(9000)] }));
  assert.equal(i.lvl, "problem"); assert.match(i.text, /changes nothing\.$/);
  i = one(diffCheck(T, { timing: [red, "8000,500,4,2,0,50,1,0"], objects: [circle(8500)] }));
  assert.equal(i.lvl, "problem"); assert.match(i.text, /can.t be changed with an inherited line/);
  i = one(diffCheck(T, { timing: [red, "8000,500,4,2,0,100,1,8"], objects: [circle(9000)] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /only omits the first barline/); assert.match(i.text, /otherwise remove the line/);
  i = one(diffCheck(T, { timing: [red, "8000,500,4,2,0,50,1,8"], objects: [circle(8500)] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /otherwise replace with an inherited line/);
  i = one(diffCheck(T, { timing: [red, "2000,500,4,2,0,100,1,0"], objects: [circle(3000)] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /resets nightcore mod cymbals/);
  assert.deepEqual(diffCheck(T, { timing: [red, "1000,400,4,2,0,100,1,0"], objects: [circle(2000)] }), [], "a different BPM");
  assert.deepEqual(diffCheck(T, { timing: [red, "1234,500,4,2,0,100,1,0"], objects: [circle(2000)] }), [], "not on a downbeat");
  assert.deepEqual(diffCheck(T, { timing: [red, "1000,-50,4,2,0,100,0,0"], objects: ["256,192,100,2,0,L|256:220,1,10,0|0,0:0|0:0,0:0:0:0:", "256,192,1500,2,0,L|256:300,1,100,0|0,0:0|0:0,0:0:0:0:"] }), [], "SV used by a slider");
  assert.deepEqual(diffCheck(T, { timing: [red, "2000,-100,4,2,0,50,0,0"], objects: ["256,192,1500,8,0,2500,0:0:0:0:"] }), [], "samples used by a spinner running into the section");
  i = one(diffCheck(T, { timing: [red, "1000,-50,4,2,0,100,0,0"], objects: [circle(500)] }));
  assert.equal(i.lvl, "minor"); assert.match(i.text, /Inherited line changes SV, but affects nothing/);
  i = one(diffCheck(T, { timing: [red, "5000,-100,4,2,0,30,0,0"], objects: [circle(1000)] }));
  assert.match(i.text, /Inherited line changes sample settings, but affects nothing/);
  i = one(diffCheck(T, { timing: [red, "5000,-50,4,2,0,30,0,0"], objects: [circle(1000)] }));
  assert.match(i.text, /Inherited line changes SV and sample settings, but affects nothing/);
  i = one(diffCheck(T, { timing: [red, "1000,-100,4,2,0,100,0,0"], objects: [circle(2000)] }));
  assert.match(i.text, /uses the same values as the previous timing line/);
});

test("Offscreen hit objects (MV CheckOffscreenTests)", () => {
  const T = "Offscreen hit objects.", o = objects => diffCheck(T, { cs: 5, objects });
  assert.deepEqual(o([circle(1000, { y: 340 })]), []);
  let i = one(o([circle(1000, { y: 397 })])); assert.equal(i.lvl, "problem"); assert.match(i.text, /Circle is offscreen/);
  i = one(o([circle(1000, { y: 396 })])); assert.equal(i.lvl, "warning"); assert.match(i.text, /Circle is only 0 px away from being offscreen, ensure the entire white border is visible on a 4:3 aspect ratio\./);
  assert.deepEqual(o([circle(1000, { y: 395 })]), []);
  i = one(o([slider(1000, { pts: "256:396", len: 95.5, y: 300 })])); assert.match(i.text, /Slider tail is only 0.5 px away from being offscreen/);
  i = one(o([slider(1000, { pts: "256:400", len: 100, y: 300 })])); assert.equal(i.lvl, "problem"); assert.match(i.text, /Slider tail is offscreen/);
  i = one(o([slider(1000, { pts: "256:396", len: 96, y: 300 })])); assert.match(i.text, /Slider tail is only 0 px away from being offscreen/);
  i = one(o([slider(1000, { pts: "547:192", len: 291, x: 256 })])); assert.match(i.text, /Slider tail is only 0 px away from being offscreen/);
  i = one(o([slider(1000, { pts: "256:396", slides: 2, len: 96, y: 300 })])); assert.match(i.text, /Slider body is only 0 px away from being offscreen/);
  i = one(diffCheck(T, { cs: 4, sm: 2.4, objects: ["150,39,1000,6,0,B|144:-23|144:-23|173:105,1,180,0|0,0:0|0:0,0:0:0:0:"] }));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /Slider body is only 0\./);
  assert.deepEqual(o([slider(1000, { pts: "256:340", len: 100, y: 240 })]), []);
});

test("Slider only section, Easy and Normal (MV CheckSliderOnlySectionsTests)", () => {
  const T = "Slider only section.", run = objects => diffCheck(T, { objects }, 0);
  const sl = (a, b, step = 1000) => { const r = []; for (let t = a; t <= b; t += step) r.push(slider(t)); return r; };
  assert.match(one(run([...sl(0, 7000), circle(9000)])).text, /8 objects/);
  one(run(sl(0, 7000)));
  assert.deepEqual(run([...sl(0, 4000), circle(6000)]), []);
  assert.deepEqual(run([...sl(0, 700, 100), circle(1000)]), []);
  assert.deepEqual(run([...sl(0, 3000), circle(4000), ...sl(5000, 8000), circle(9000)]), []);
  assert.ok(!P.DIFF_CHECKS.find(c => c.title === T).lv.includes(2), "not for Hard and above");
});

test("Hit sound consistency between difficulties (MV CheckHitSoundConsistencyTests)", () => {
  const T = "Inconsistent hit sounds between difficulties.";
  let i = one(setCheck(T, [{ version: "A", objects: [circle(1000, { hs: 8 })] }, { version: "B", objects: [circle(1000)] }]));
  assert.equal(i.lvl, "warning"); assert.match(i.text, /^\[B\] is missing \(Clap\) which exists in A\.$/);
  const list = setCheck(T, [{ version: "A", objects: [circle(1000, { hs: 8 })] }, { version: "B", objects: [circle(1000)] }, { version: "C", objects: [circle(1000)] }]);
  assert.equal(list.length, 2); assert.ok(list.every(x => x.lvl === "minor"));
  assert.deepEqual(setCheck(T, [{ version: "A", objects: [circle(1000, { hs: 8 })] }, { version: "B", objects: [circle(1000, { hs: 8 })] }]), []);
  i = one(setCheck(T, [{ version: "A", objects: ["256,192,1000,2,2,L|256:300,1,120,0|0,0:0|0:0,0:0:0:0:"] }, { version: "B", objects: [circle(1000)] }]));
  assert.equal(i.lvl, "minor"); assert.match(i.text, /^\[A\] This sliderbody has additions, ensure this is intentional\.$/);
});

test("Spread checks use MV's thresholds and scope", () => {
  // objects close in time, only on the lowest difficulty and only after a circle
  const close = [circle(1000, { x: 100 }), circle(1100, { x: 400 })];
  assert.equal(one(diffCheck("Objects close in time not overlapping.", { objects: close }, 0)).lvl, "problem");
  assert.deepEqual(diffCheck("Objects close in time not overlapping.", { objects: close }, 1, { hasEasy: true }), [], "a Normal when there's an Easy");
  assert.deepEqual(diffCheck("Objects close in time not overlapping.", { objects: [slider(1000, { x: 100, pts: "100:150", len: 42 }), circle(1100, { x: 400 })] }, 0), [], "after a slider");
  // spinner recovery: BPM scaling bpm²/14400 - bpm/80 + 1 (180 BPM = 1)
  const rec = diffCheck("Too short spinner time or spinner recovery time.", { timing: ["0,333.333333333333,4,2,0,100,1,0"], objects: ["256,192,0,8,0,2000,0:0:0:0:", circle(2900)] }, 0);
  assert.ok(rec.some(x => x.lvl === "problem" && /^Spinner recovery time is too short \(900 ms, expected 1334\)\.$/.test(x.text)), JSON.stringify(rec));
  // multiple reverses: Easy 1/1 at 240 BPM (250 ms) / 180 BPM (333 ms)
  const rev = len => diffCheck("Multiple reverses on too short sliders.", { objects: [slider(1000, { slides: 3, len })] }, 0);
  assert.equal(one(rev(20)).lvl, "problem"); assert.equal(one(rev(28)).lvl, "warning"); assert.deepEqual(rev(40), []); // (3 spans of len / 140 * 500 ms)
});

test("Settings: tick rate, difficulty ranges and level by name", () => {
  const tick = v => diffCheck("Slider tick rates not aligning with any common beat snap divisor.", { tick: v });
  for (const ok of [1, 2, 3, 5, 7, 0.5, 1.333, 1.5, 0.3, 10]) assert.deepEqual(tick(ok), [], "tick rate " + ok + " (clamped to 0.5–8 first)");
  assert.deepEqual(one(tick(0.7)), { lvl: "problem", text: "0.7 slider tick rate." });
  assert.equal(P.diffLevel(P.parseOsu(osu({ version: "Kensuke's Insane" })), 1.5), 3, "an exact name beats the star rating");
  assert.equal(P.diffLevel(P.parseOsu(osu({ version: "Extra Stage" })), 5.6), 4, "otherwise the star rating");
  assert.ok(!P.DIFF_CHECKS.find(c => c.title === "Difficulty settings outside of the guideline range.").lv.includes(5), "no ranges for Ultra");
});

test("Breaks, drain time and concurrent objects", () => {
  // a break counts from the object before it to the object after it
  const m = P.parseOsu(osu({ objects: [circle(0), circle(10000), circle(40000)], extra: "" }).replace("[Events]", "[Events]\n2,12000,38000"));
  assert.equal(P.drainOf(m), 40000 - 30000);
  const b = diffCheck("Breaks only achievable through .osu editing.", { objects: [circle(1000), circle(5000)] }); assert.deepEqual(b, []);
  const conc = diffCheck("Concurrent hit objects.", { objects: [circle(1000), circle(1005), circle(1500)] });
  assert.equal(one(conc).lvl, "problem"); assert.match(conc[0].text, /Within 5 ms of one another/);
});

test("Perfect stacks with Hard Rock: HR's shorter stack time leaves objects on the same spot", () => {
  const sl = "StackLeniency: 0.2"; // stack time 240 ms at AR 5, 180 ms at AR 7 (HR)
  const hit = one(diffCheck("Perfect stacks too close in time with Hard Rock applied.", { extra: sl, objects: [circle(1000), circle(1200)] }));
  assert.deepEqual(hit, { lvl: "minor", text: "Perfect stack with Hard Rock applied, stack leniency should be at least 3." });
  assert.equal(diffCheck("Perfect stacks too close in time with Hard Rock applied.", { extra: sl, objects: [circle(1000), circle(1150)] }).length, 0, "stacked with HR too");
  assert.equal(diffCheck("Perfect stacks too close in time with Hard Rock applied.", { extra: sl, objects: [circle(1000), circle(1300)] }).length, 0, "not stacked without HR either: a perfect stack the normal check reports");
});

test("Stacking: a slider with an even number of slides ends on its head", () => {
  const m = P.parseOsu(osu({ objects: [slider(1000, { slides: 2 }), circle(1800)] })); // the slider ends at 1714, back on 256,192
  assert.equal(m.hit[1].stack, -1);
  const m2 = P.parseOsu(osu({ objects: [slider(1000, { slides: 1 }), circle(1400, { y: 292 })] })); // one slide: ends 100 px along, at 256,292
  assert.equal(m2.hit[1].stack, -1);
});

test("Missing genre/language in tags (MV CheckGenreLanguage)", () => {
  const texts = tags => setCheck("Missing genre/language in tags.", [{ tags }]).map(x => x.text.split(" (")[0]);
  assert.deepEqual(texts(""), ["Missing genre tag", "Missing language tag"]);
  assert.deepEqual(texts("Electronic Japanese"), []);
  assert.deepEqual(texts("video game instrumental"), []);
  assert.deepEqual(texts("game english"), ["Missing genre tag"], "\"video game\" needs both words");
});

// ---- MV parity: settings, events, spread and difficulty names (MapsetVerifier's parser quirks included) ----
// text-level helpers: extra [Metadata] / [Events] lines and whole sections ([Colours]) on top of osu()
const osuX = (o = {}) => osu(o).replace("[Metadata]", "[Metadata]\n" + (o.meta || "")).replace("[Events]", "[Events]\n" + (o.events || []).join("\n")) + (o.tail ? "\n" + o.tail : "");
function mvDiffCheck(title, o, lvl = 3) {
  const m = P.parseOsu(osuX(o)), c = P.DIFF_CHECKS.find(x => x.title === title), out = [];
  assert.ok(c, "no check " + title);
  c.run(m, (l, msg, v = {}, objs, t) => out.push({ lvl: l, text: msg.replace(/\{(\w+)\}/g, (_, k) => v[k]), ...(t != null ? { t } : {}) }), lvl, {});
  return J(out);
}
function mvSetCheck(title, maps, extra = {}) {
  const ctx = { maps: maps.map((o, i) => { const m = P.parseOsu(osuX(o)); return { m, i, lvl: P.diffLevel(m, o.stars), stars: o.stars ?? null }; }), osb: null, ...extra };
  const c = P.SET_CHECKS.find(x => x.title === title), out = [];
  assert.ok(c, "no check " + title);
  c.run(ctx, (l, msg, v = {}, objs, t) => out.push({ lvl: l, text: msg.replace(/\{(\w+)\}/g, (_, k) => v[k]), ...(t != null ? { t } : {}) }));
  return J(out);
}

test("MV parity: difficulty names use .NET's Unicode \\w, \\b and \\s", () => {
  const lvl = (version, stars) => P.diffLevel(P.parseOsu(osu({ version })), stars);
  assert.equal(lvl("Ëlement's Hard", 6), 2, "a non-ASCII owner name is still an owner prefix");
  assert.equal(lvl("Kensuke's Insane", 1.5), 3);
  assert.equal(lvl("Easy Collab", 6), 0, "\"collab\" is dropped");
  assert.equal(lvl("Ëcollab Normal", 6), 4, "…but not inside a word (Unicode word boundary)");
  assert.equal(lvl("Extra Stage", 5.6), 4, "otherwise the star rating");
});

test("MV parity: CheckDiffSettingsStandard rounds to 2 decimals and uses MV's range wording", () => {
  const T = "Difficulty settings outside of the guideline range.";
  assert.deepEqual(mvDiffCheck(T, { ar: 9.301, od: 8, hp: 6, cs: 4 }, 3), [], "AR 9.301 rounds to 9.3");
  assert.deepEqual(mvDiffCheck(T, { ar: 9.31, od: 8, hp: 6, cs: 4 }, 3), [{ lvl: "minor", text: "AR is recommended to be between 7 and 9.3 for Insane difficulties, currently 9.31." }]);
  assert.deepEqual(mvDiffCheck(T, { ar: 3, od: 2, hp: 2, cs: 4.5 }, 0), [{ lvl: "minor", text: "CS is recommended to be 4 or lower for Easy difficulties, currently 4.5." }]);
  assert.deepEqual(mvDiffCheck(T, { ar: 9, od: 7, hp: 6, cs: 4 }, 4), [{ lvl: "minor", text: "OD is recommended to be 8 or higher for Expert difficulties, currently 7." }]);
});

test("MV parity: CheckDiffSettingsAllModes (more than one decimal, CS above 10)", () => {
  const T = "Abnormal difficulty settings.";
  assert.deepEqual(mvDiffCheck(T, { ar: 9.3, cs: 4.2, od: 8.5, hp: 6 }), []);
  assert.deepEqual(mvDiffCheck(T, { cs: 4.25 }), [{ lvl: "problem", text: "4.25 Circle Size has more than 1 decimal place." }]);
  assert.deepEqual(mvDiffCheck(T, { cs: 12, hp: 11 }), [{ lvl: "warning", text: "12 Circle Size, although is capped between 0 to 10 in-game." }], "HP is clamped to 10 by MV's parser, CS only to 18");
});

test("MV parity: default combo colours and luminosity numbering", () => {
  const D = "Default combo colours without forced skin.";
  assert.deepEqual(mvDiffCheck(D, {}), [{ lvl: "problem", text: "Default combo colours without preferred skin." }], "no colours, no skin");
  assert.equal(mvDiffCheck(D, { extra: "SkinPreference: MySkin" }).length, 1, "a skin other than Default doesn't help");
  assert.deepEqual(mvDiffCheck(D, { extra: "SkinPreference: Default" }), []);
  assert.deepEqual(mvDiffCheck(D, { tail: "[Colours]\nCombo1 : 255,128,0" }), []);
  const L = "Too dark or bright combo colours or slider borders.";
  const dark = mvDiffCheck(L, { tail: "[Colours]\nCombo1 : 0,0,0\nCombo2 : 40,40,40\nCombo3 : 200,100,100\nSliderBorder : 35,35,35" });
  assert.deepEqual(dark, [{ lvl: "warning", text: "Slider border is really dark." }, { lvl: "problem", text: "Combo colour 3 is way too dark." }, { lvl: "warning", text: "Combo colour 1 is really dark." }], "the first colour shows as the last number, like MV");
  const bright = mvDiffCheck(L, { timing: ["0,500,4,2,0,100,1,1"], objects: ["256,192,1000,5,0,0:0:0:0:", "256,192,2000,5,0,0:0:0:0:"], tail: "[Colours]\nCombo1 : 255,255,255\nCombo2 : 100,100,100" });
  assert.deepEqual(bright, [{ lvl: "warning", text: "Combo colour 2 is really bright in kiai sections, see 00:02:000 - ." }], "the first new combo already moves to the next colour (MV)");
});

test("MV parity: CheckBreaks uses the preempt without cutting it to a whole ms", () => {
  const T = "Breaks only achievable through .osu editing.";
  // AR 9.3: preempt 554.99997 ms (osu! cuts it to 554)
  assert.deepEqual(mvDiffCheck(T, { ar: 9.3, objects: [circle(0), circle(9554)], events: ["2,1000,9000"] }), []);
  assert.deepEqual(mvDiffCheck(T, { ar: 9.3, objects: [circle(0), circle(9553)], events: ["2,1000,9000"] }), [{ lvl: "problem", text: "to 00:09:000 - ends 2 ms too late. Saving the beatmap should fix this.", t: 1000 }]);
  assert.deepEqual(mvDiffCheck(T, { objects: [circle(0), circle(3000)], events: ["2,100,1500"] }), [{ lvl: "problem", text: "to 00:01:500 - starts 100 ms too early. Saving the beatmap should fix this.", t: 100 }]);
  assert.deepEqual(mvDiffCheck(T, { objects: [circle(0), circle(3000)], events: ["2,1000,1500"] }), [{ lvl: "warning", text: "to 00:01:500 - is non-functional due to being less than 650 ms.", t: 1000 }]);
});

test("MV parity: CheckScoreOverflow (osu!lazer's legacy score simulator)", () => {
  const T = "Score/Combo overflow.";
  // 3 circles, 2 s of drain: difficulty multiplier round((5 + 5 + 4 + 3 / 2 * 8) / 38 * 5) = 3; combo score (3 - 2) * 12 * 3 = 36
  let r = P.mvScoreV1(P.parseOsu(osu({ objects: [circle(0), circle(1000), circle(2000)] })));
  assert.deepEqual(J(r), { combo: 3, score: 900 + Math.round(36 * 1.06 * 1.06 * 1.12 * 1.12) });
  // 300 px slider, SV 1.4, tick rate 2: a tick every 70 px -> 4 per span; 2 spans = head + 8 ticks + repeat + tail
  r = P.mvScoreV1(P.parseOsu(osu({ tick: 2, objects: [slider(0, { pts: "556:192", len: 300, slides: 2 })] })));
  assert.equal(r.combo, 11);
  assert.equal(P.mvPeppyStars(5, 5, 4, 5, 8), 2, "19 / 38 * 5 = 2.5 rounds to even");
  assert.deepEqual(mvDiffCheck(T, { objects: [circle(0), circle(1000)] }), []);
  // a 10000 px slider at SV 0.4, tick rate 8: a tick every 5 px, 1999 per span, 40 spans
  const long = mvDiffCheck(T, { sm: 0.4, tick: 8, objects: [slider(0, { pts: "256:10192", len: 10000, slides: 40 })] });
  assert.deepEqual(long, [{ lvl: "problem", text: "Combo overflows in osu!(stable) (80,001). Ensure the map has the 'lazer-only' flag." }]);
  // 10000 circles 100 ms apart: multiplier 4, combo score 48 * 9998 * 9999 / 2
  const many = Array.from({ length: 10000 }, (_, i) => circle(i * 100));
  const exp = 3000000 + Math.round(48 * 9998 * 9999 / 2 * 1.06 * 1.06 * 1.12 * 1.12);
  assert.deepEqual(mvDiffCheck(T, { objects: many }), [{ lvl: "problem", text: `Score overflows in osu!(stable) (${exp.toLocaleString("en-US")}). Ensure the map has the 'lazer-only' flag.` }]);
});

test("MV parity: CheckLowestDiff picks the lowest by level, then star rating", () => {
  const T = "Lowest difficulty too difficult for the given drain time(s).", obj = [circle(0), circle(130000)];
  assert.deepEqual(mvSetCheck(T, [{ version: "Hard", stars: 2.6, objects: obj }, { version: "Normal", stars: 2.65, objects: obj }]), [], "the Normal is the lowest");
  assert.deepEqual(mvSetCheck(T, [{ version: "Hard", stars: 3, objects: obj }]), [{ lvl: "problem", text: "[Hard] With a lowest difficulty Hard, the drain time of [Hard] must be at least 02:30:000 -, currently 02:10:000 -." }]);
  const ins = mvSetCheck(T, [{ version: "Insane", objects: obj }, { version: "Expert", objects: [circle(0), circle(200000)] }]);
  assert.deepEqual(ins.map(i => i.text), ["[Insane] With a lowest difficulty Insane, the drain time of [Insane] must be at least 03:15:000 -, currently 02:10:000 -."], "every difficulty's drain counts, against the lowest's level");
});

test("MV parity: CheckInconsistentSettings, per setting", () => {
  const T = "Inconsistent mapset id, countdown, epilepsy warning, etc.", texts = list => list.map(i => i.lvl + " " + i.text);
  assert.deepEqual(mvSetCheck(T, [{ version: "A" }, { version: "B", meta: "BeatmapSetID:-1" }]), [], "a missing set id counts as -1");
  assert.deepEqual(texts(mvSetCheck(T, [{ version: "A" }, { version: "B", meta: "BeatmapSetID:123" }])),
    ["problem [A] Inconsistent beatmapset id \"-1\", see [B] \"123\".", "problem [B] Inconsistent beatmapset id \"123\", see [A] \"-1\"."]);
  // countdown: only when it can show (first object far enough in)
  assert.deepEqual(mvSetCheck(T, [{ version: "A", extra: "Countdown: 1", objects: [circle(0)] }, { version: "B", extra: "Countdown: 2", objects: [circle(0)] }]), []);
  assert.deepEqual(texts(mvSetCheck(T, [{ version: "A", extra: "Countdown: 1", objects: [circle(10000)] }, { version: "B", extra: "Countdown: 2", objects: [circle(10000)] }])),
    ["warning [A] Inconsistent countdown speed \"Normal\", see [B] \"Half\".", "warning [B] Inconsistent countdown speed \"Half\", see [A] \"Normal\"."]);
  // letterbox: only when both have breaks
  assert.deepEqual(mvSetCheck(T, [{ version: "A", extra: "LetterboxInBreaks: 1" }, { version: "B" }]), []);
  assert.equal(mvSetCheck(T, [{ version: "A", extra: "LetterboxInBreaks: 1", events: ["2,1000,5000"] }, { version: "B", events: ["2,1000,5000"] }]).length, 2);
  // slider tick rate: minor; preview time isn't compared here
  assert.deepEqual(texts(mvSetCheck(T, [{ version: "A", tick: 1 }, { version: "B", tick: 2, extra: "PreviewTime: 5000" }])),
    ["minor [A] Inconsistent slider tick rate \"1\", see [B] \"2\".", "minor [B] Inconsistent slider tick rate \"2\", see [A] \"1\"."]);
  // storyboard settings: only with storyboards in both, or an .osb
  const sb = ["Sprite,Foreground,Centre,\"a.png\",320,240"];
  assert.deepEqual(texts(mvSetCheck(T, [{ version: "A", extra: "WidescreenStoryboard: 1", events: sb }, { version: "B" }])),
    ["warning [A] Inconsistent difficulty-specific storyboard presence \"True\", see [B] \"False\".", "warning [B] Inconsistent difficulty-specific storyboard presence \"False\", see [A] \"True\"."]);
  const withOsb = texts(mvSetCheck(T, [{ version: "A", extra: "WidescreenStoryboard: 1\nEpilepsyWarning: 1" }, { version: "B" }], { osb: "[Events]" }));
  assert.ok(withOsb.includes("warning [A] Inconsistent widescreen support \"True\", see [B] \"False\".") && withOsb.includes("warning [B] Inconsistent epilepsy warning \"False\", see [A] \"True\"."), JSON.stringify(withOsb));
});

test("MV parity: CheckStoryHitSounds, every Sample event in each .osu and in the .osb", () => {
  const T = "Storyboarded hit sounds.";
  const osb = "[Variables]\n$f=\"drum-hitnormal.wav\"\n[Events]\nSample,2000,0,$f";
  const list = mvSetCheck(T, [{ version: "A", events: ["Sample,1500.7,0,\"soft-hitclap.wav\",60"] }, { version: "B" }], { osb });
  assert.deepEqual(list, [
    { lvl: "warning", text: "[A] Storyboarded hit sound (soft-hitclap.wav, 60%) from .osu file.", t: 1500 },
    { lvl: "warning", text: "[A] Storyboarded hit sound (drum-hitnormal.wav, 100%) from .osb file.", t: 2000 },
    { lvl: "warning", text: "[B] Storyboarded hit sound (drum-hitnormal.wav, 100%) from .osb file.", t: 2000 },
  ]);
});

// ---------- metadata, resources and skinning (MV's CheckMetadata / Resources / Skinning checks) ----------
// a second copy of the scripts with a package of files: setFiles({ path: bytes or text }), setOsb(text)
const Q = loadScripts(["js/parse.js", "js/verify.js"], `
const fmtMs = ms => String(ms);
let files = {}, osbText = "";
function setFiles(o) { files = {}; for (const k in o) files[norm(k)] = o[k]; }
function setOsb(t) { osbText = t; }
`);
const entry = (name, data) => ({ name, async: () => Promise.resolve(data) });
function osuM({ title = "Test", titleU, artist = "Test", artistU, creator = "Test", version = "Test", tags = "", colours = [], events = [], objects = [circle(1000)] } = {}) {
  return ["osu file format v14", "[General]", "AudioFilename: audio.mp3", "Mode: 0", "[Metadata]", `Title:${title}`, ...(titleU != null ? [`TitleUnicode:${titleU}`] : []), `Artist:${artist}`,
    ...(artistU != null ? [`ArtistUnicode:${artistU}`] : []), `Creator:${creator}`, `Version:${version}`, `Tags:${tags}`, "[Difficulty]", "CircleSize:4", "OverallDifficulty:5", "ApproachRate:5",
    "SliderMultiplier:1.4", "SliderTickRate:1", "[Events]", ...events, "[TimingPoints]", "0,500,4,2,0,100,1,0", "[Colours]", ...colours, "[HitObjects]", ...objects].join("\n");
}
function mvSet(title, maps, files) { // -> [{ lvl, text }]
  if (files) Q.setFiles(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, entry(k, v)])));
  const ctx = { maps: maps.map((o, i) => { const m = Q.parseOsu(osuM(o)); return { m, i, lvl: o.lvl ?? 3, stars: o.stars ?? null }; }) };
  const c = Q.SET_CHECKS.find(x => x.title === title), out = [];
  assert.ok(c, "no check " + title);
  c.run(ctx, (l, msg, v = {}) => out.push({ lvl: l, text: msg.replace(/\{(\w+)\}/g, (_, k) => v[k]) }));
  return J(out);
}
const settle = () => new Promise(r => setTimeout(r, 20));
const TM = "Incorrect format of title version markers such as (TV Size), (Game Ver.), etc.";
const tm = (title, o = {}) => mvSet(TM, [{ title, artist: "Tests", creator: "Tests", ...o }]);
const lv = (list, l) => list.filter(i => i.lvl === l);

test("Title markers (MV CheckTitleMarkersTests)", () => {
  for (const t of ["Song (TV Size)", "Song (Game Ver.)", "Song (Short Ver.)", "Song (Movie Ver.)", "Song (Cut Ver.)", "Song (Extended Edit)", "Song (Sped Up Ver.)", "Song (Nightcore Mix)", "Song (Nightcore & Cut Ver.)", "Song (Sped Up & Cut Ver.)",
    "song name (tv size)", "SONG NAME (TV SIZE)", "song name (TV Size)", "erase u (sped up & cut ver.)", "SLYOZY (ANTVN BOOTLEG) (SPED UP & CUT VER.)"])
    assert.deepEqual(lv(tm(t), "problem"), [], t);
  for (const [t, canon] of [["Song -TV version-", "(TV Size)"], ["Song (Game Size)", "(Game Ver.)"], ["Song (Movie Version)", "(Movie Ver.)"], ["Song -extended edit-", "(Extended Edit)"], ["SONG NAME (tv size)", "(TV Size)"], ["Song Name (tv size)", "(TV Size)"]]) {
    const p = one(lv(tm(t), "problem"));
    assert.equal(p.text, `Romanized title field; "${t}" incorrect format of "${canon}".`);
  }
  assert.deepEqual(tm("Song (2020 Tour Live Ver.)"), [], "live parenthetical");
  assert.ok(tm("Song (TV Size) (Full Ver.)").some(i => i.lvl === "warning" && i.text === "Romanized title field; \"Song (TV Size) (Full Ver.)\" — (TV Size) should be at the end of the title."));
  assert.equal(one(tm("Song (Extended Version)")).text, "Romanized title field; \"Song (Extended Version)\" should use guideline format \"(Extended Ver.)\".");
  assert.match(one(tm("Song (Long)")).text, /"\(Long Ver\.\)"\.$/);
  for (const [t, s] of [["Song (Arrange ver.)", "(Arrange Ver.)"], ["Song (vocaloid ver.)", "(Vocaloid Ver.)"], ["Song Title vocaloid ver.", "(Vocaloid Ver.)"]]) assert.ok(one(lv(tm(t), "warning")).text.includes(`"${s}"`), t);
  for (const t of ["song name (arrange ver.)", "SONG NAME (ARRANGE VER.)", "clarity rmx (hayakou boutleg) (cut ver.)", "Pippiquest (Pippi x Mocha Romantic Movie Remix Edition)", "You Make My Life 1UP (x127 Long Ver.)"]) assert.deepEqual(tm(t), [], t);
  for (const t of ["Song (Arrange Ver.)", "TERABYTE (\"XETTABYTE\" Long Ver.)", "#1f1e33 (Another long \"#ant1p01e\" Ver.)"]) assert.ok(!tm(t).some(i => i.text.includes("guideline format")), t);
  assert.ok(tm("Song (feat. \"artist\" arrange ver.)").some(i => i.text.includes("should use guideline format") && i.text.includes("Arrange Ver.)")));
  assert.ok(tm("Song OP Version", { tags: "anime game ost" }).some(i => i.lvl === "warning" && i.text.includes("consider \"(Game Ver.)\" instead of \"OP Version\"")));
  assert.equal(one(lv(tm("Song (Sped Up Ver.)", { tags: "nightcore sped up" }), "warning")).text, "\"nightcore\" in tags, consider \"(Nightcore Mix)\" instead of \"(Sped Up Ver.)\" in romanized title.");
  assert.ok(!tm("Song (Sped Up & Cut Ver.)").some(i => i.text.includes("(Sped Up Ver.)")), "a combined marker isn't also a separate sped up one");
  assert.equal(one(tm("Song (TV Size)", { titleU: "歌曲" })).text, "Romanized title field includes \"(TV Size)\" but Unicode title field does not.");
  assert.equal(one(tm("Song", { titleU: "歌曲 (TV Size)" })).text, "Unicode title field includes \"(TV Size)\" but Romanized title field does not.");
  assert.deepEqual(tm("Song (TV Size)", { titleU: "歌曲 (TV Size)" }), []);
  assert.deepEqual(lv(tm("SLYOZY (ANTVN BOOTLEG) (SPED UP & CUT VER.)", { titleU: "СЛЁЗЫ (ANTVN BOOTLEG) (SPED UP & CUT VER.)" }), "problem"), []);
  assert.equal(one(tm("Shortcake")).text, "Romanized title field; \"Shortcake\" incorrect format of \"(Short Ver.)\".", "MV's bare \"short\" pattern");
});

test("Marker format and spacing (MV CheckMarkerFormat, CheckMarkerSpacing)", () => {
  const mf = o => mvSet("Incorrect marker format.", [o]).map(i => i.text);
  assert.deepEqual(mf({ artist: "A feat. B", title: "X (feat. Y)" }), []);
  assert.deepEqual(mf({ artist: "A ft. B" }), ["Incorrect formatting of \"feat.\" marker in Romanized artist field, \"A ft. B\".", "Incorrect formatting of \"feat.\" marker in Unicode artist field, \"A ft. B\"."]);
  assert.equal(mf({ artist: "A", title: "X (ft. Y)" }).length, 2, "title and unicode title");
  assert.equal(mf({ artist: "A FEAT. B", artistU: "A feat. B" }).length, 1);
  assert.deepEqual(mf({ artist: "A featuring B" }), [], "MV doesn't flag \"featuring\"");
  assert.deepEqual(mf({ artist: "Char (cv: Someone)", artistU: "Char (CV: Someone)" }), ["Incorrect formatting of \"CV:\" marker in Romanized artist field, \"Char (cv: Someone)\"."]);
  assert.equal(mf({ artist: "A vs B", artistU: "A vs. B" }).length, 1);
  const ms = o => mvSet("Incorrect marker spacing.", [o]);
  assert.deepEqual(ms({ artist: "Char (CV: Someone)", artistU: "キャラ（CV：誰か）" }), []);
  const s = ms({ artist: "Char(CV:Someone)", artistU: "Char (CV: Someone)" });
  assert.deepEqual(s.map(i => [i.lvl, i.text]), [["problem", "Missing whitespace after \"CV:\" in artist; \"Char(CV:Someone)\"."], ["problem", "Missing whitespace before \"(CV:\" or full-width bracket \"（\" in artist; \"Char(CV:Someone)\"."],
    ["warning", "Missing whitespace after \"CV:\" or full-width colon \"：\" in artist; \"Char(CV:Someone)\"."]]);
  assert.deepEqual(ms({ artist: "A &B", artistU: "A & B" }).map(i => [i.lvl, i.text]), [["warning", "Missing whitespace after \"&\" in artist; \"A &B\"."]]);
  assert.deepEqual(ms({ artist: "A,B", artistU: "A, B" }).map(i => i.lvl), ["problem", "warning"], "two differently worded messages, both kept as in MV");
});

test("GDers in tags, unicode and inconsistent metadata (MV CheckGuestTags, CheckUnicode, CheckInconsistentMetadata)", () => {
  const gt = (version, tags = "") => mvSet("Missing GDers in tags.", [{ title: "Song", creator: "Host", version, tags }]);
  for (const [v, tag] of [["Take's Hard", "take"], ["(Take's Hard)", "take"], ["lu^3's Extra", "lu^3"], ["[[[[[['s Easy feat. jjen", "[[[[[["], ["Naxess' Insane", "naxess"], ["Someone else's Normal", "someone else"]]) {
    assert.equal(one(gt(v)).text, `"${v}" is possessive but "${tag}" isn't in the tags, ignore if not a user.`);
    if (!v.startsWith("Naxess") && !v.startsWith("Someone")) assert.deepEqual(gt(v, tag), [], v + " with the tag");
  }
  assert.deepEqual(gt("A & Bob's Insane", "bob").length, 0, "split on &: only the last part is a possessor");
  assert.deepEqual(gt("Host's Extra"), [], "the creator");
  assert.deepEqual(gt("Skull Kid's Insane", "skullkid"), [], "each word inside some tag");
  assert.equal(gt("abcdef's Insane", "abc").length, 1);
  assert.equal(gt("Naxess' & Greaper's Nor'mal").length, 2);
  const uni = mvSet("Unicode in romanized fields.", [{ title: "Sóng", version: "Ünsane" }]);
  assert.deepEqual(uni.map(i => [i.lvl, i.text]), [["warning", "Difficulty name field contains unicode characters,\"Ünsane\", those being \"Ü\". If the map can still be downloaded this is probably ok."],
    ["problem", "Romanized title field contains unicode characters,\"Sóng\", those being \"ó\"."]]);
  const inc = mvSet("Inconsistent metadata.", [{ version: "Easy", lvl: 0, tags: "rock pop" }, { version: "Hard", lvl: 2, tags: "Rock pop", title: "Other" }]);
  assert.deepEqual(inc.map(i => i.text), ["Inconsistent title fields between [Hard] and [Easy]; \"Other\" and \"Test\" respectively.", "Inconsistent unicode title fields between [Hard] and [Easy]; \"Other\" and \"Test\" respectively.",
    "Inconsistent tags between Hard and Easy, difference being \"rock Rock\"."], "tags compare case-sensitively; the lowest difficulty is the reference");
});

test("Mappers' Guild tag (MV CheckMappersGuildBackgroundTests)", () => {
  const T = "Mappers' Guild tag present.";
  for (const tags of ["mpg", "mappers guild", "mappers' guild", "mappersguild", "MPG", "something mappers' guild mpg fa featured artist"]) assert.match(one(mvSet(T, [{ tags }])).text, /free to use/);
  for (const tags of ["", "electronic instrumental greaper very cool song tags"]) assert.deepEqual(mvSet(T, [{ tags }]), []);
});

// minimal image and video headers
const png = (w, h, size = 24) => { const u = new Uint8Array(size); u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]); const d = new DataView(u.buffer); d.setUint32(16, w); d.setUint32(20, h); return u; };
const cat = (...parts) => { const n = parts.reduce((s, p) => s + p.length, 0), u = new Uint8Array(n); let o = 0; for (const p of parts) { u.set(p, o); o += p.length; } return u; };
const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
const box = (type, ...kids) => { const body = cat(...kids), u = cat(new Uint8Array(4), ascii(type), body); new DataView(u.buffer).setUint32(0, u.length); return u; };
const bytes = (n, set = {}) => { const u = new Uint8Array(n), d = new DataView(u.buffer); for (const k in set) { const [v, w] = set[k]; if (w === 2) d.setUint16(+k, v); else d.setUint32(+k, v); } return u; };
function mp4(w, h, channels) {
  const trak = (handler, entry) => box("trak", box("tkhd", bytes(84, { 76: [w * 65536], 80: [h * 65536] })),
    box("mdia", box("hdlr", bytes(8), ascii(handler), bytes(13)), box("minf", box("stbl", box("stsd", bytes(4), bytes(4, { 0: [1] }), entry)))));
  const vide = cat(bytes(8, { 0: [86] }), bytes(78, { 24: [w, 2], 26: [h, 2] })), soun = cat(bytes(8, { 0: [36] }), bytes(28, { 16: [channels, 2] }));
  vide.set(ascii("avc1"), 4); soun.set(ascii("mp4a"), 4);
  return cat(box("ftyp", ascii("isom")), box("moov", trak("vide", vide), ...(channels != null ? [trak("soun", soun)] : [])));
}
function avi(w, h, channels) {
  const le = (n, set = {}) => { const u = new Uint8Array(n), d = new DataView(u.buffer); for (const k in set) { const [v, s] = set[k]; if (s === 2) d.setUint16(+k, v, true); else d.setUint32(+k, v, true); } return u; };
  const chunk = (id, body) => cat(ascii(id), le(4, { 0: [body.length] }), body), list = (t, ...kids) => chunk("LIST", cat(ascii(t), ...kids));
  const strl = (type, strf) => list("strl", chunk("strh", cat(ascii(type), new Uint8Array(52))), chunk("strf", strf));
  const hdrl = list("hdrl", chunk("avih", le(56, { 32: [w], 36: [h] })), strl("vids", le(40, { 4: [w], 8: [h] })), ...(channels != null ? [strl("auds", le(16, { 0: [1, 2], 2: [channels, 2] }))] : []));
  const body = cat(ascii("AVI "), hdrl);
  return cat(ascii("RIFF"), le(4, { 0: [body.length] }), body);
}

test("Backgrounds: every difficulty's, read in the background (MV CheckBgPresence, CheckBgResolution)", async () => {
  const bg = f => [`0,0,"${f}",0,0`];
  assert.deepEqual(mvSet("Missing background.", [{ version: "A" }, { version: "B" }], {}).map(i => i.text), ["All difficulties are missing backgrounds."]);
  assert.deepEqual(mvSet("Missing background.", [{ version: "A", events: bg("a.jpg") }, { version: "B" }], { "a.jpg": png(1, 1) }).map(i => i.text), ["B has no background."]);
  assert.deepEqual(mvSet("Missing background.", [{ version: "A", events: bg("x.jpg") }], {}).map(i => i.text), ["A is missing its background file, \"x.jpg\"."]);
  const T = "Too high or low background resolution.", maps = [{ events: bg("big.png") }, { events: bg("small.png") }, { events: bg("ok.png") }, { events: bg("gone.png") }, { events: bg("wrong.jpg") }];
  const files = { "big.png": png(3000, 1500), "small.png": png(800, 600), "ok.png": png(1920, 1080, 3 * 1048576), "wrong.jpg": png(1920, 1080) };
  assert.deepEqual(mvSet(T, maps, files).map(i => i.text), ["\"gone.png\" couldn't be checked, so you'll need to do that manually."], "the files are still being read");
  await settle();
  assert.deepEqual(mvSet(T, maps).map(i => [i.lvl, i.text]), [["problem", "\"big.png\" greater than 2560 x 1440 (3000 x 1500)"], ["warning", "\"small.png\" lower than 1024 x 640 (800 x 600)"],
    ["problem", "\"ok.png\" has a file size exceeding 2.5 MB (3 MB)"], ["minor", "\"gone.png\" couldn't be checked, so you'll need to do that manually."],
    ["minor", "\"wrong.jpg\" couldn't be checked, so you'll need to do that manually."]], "a PNG named .jpg is opened as a JPEG, like TagLib does");
});

test("Videos: resolution, audio track, usage and offset (MV CheckVideoResolution, CheckAudioInVideo, CheckMultipleVideo, CheckVideoOffset)", async () => {
  const vid = (f, off = 0) => [`Video,${off},"${f}"`];
  const maps = [{ version: "A", events: vid("hd.mp4") }, { version: "B", events: vid("sd.avi", 100) }, { version: "C", events: vid("old.flv") }];
  const files = { "hd.mp4": mp4(1920, 1080, 2), "sd.avi": avi(640, 480, null), "old.flv": ascii("FLV") };
  mvSet("Too high video resolution.", maps, files); await settle();
  assert.deepEqual(mvSet("Too high video resolution.", maps).map(i => i.text), ["\"hd.mp4\" greater than 1280 x 720 (1920 x 1080)", "\"old.flv\" couldn't be checked, so you'll need to do that manually."]);
  assert.deepEqual(mvSet("Audio channels in video.", maps).map(i => [i.lvl, i.text]), [["problem", "\"hd.mp4\""], ["minor", "\"old.flv\" couldn't be checked, so you'll need to do that manually."]]);
  const f2 = { "a.avi": avi(1280, 720, 2), "b.mp4": mp4(1280, 720, null) };
  mvSet("Audio channels in video.", [{ events: vid("a.avi") }, { events: vid("b.mp4") }], f2); await settle();
  assert.deepEqual(mvSet("Audio channels in video.", [{ events: vid("a.avi") }, { events: vid("b.mp4") }]).map(i => i.text), ["\"a.avi\""]);
  assert.deepEqual(mvSet("Inconsistent video offset.", maps).map(i => i.text), ["0 : [A] [C]", "100 : [B]"]);
  assert.deepEqual(mvSet("Inconsistent video usage.", [{ version: "A", events: vid("v.mp4") }, { version: "B" }], {}).map(i => i.text), ["v.mp4 : [A].", "None : [B]."]);
  Q.setOsb("[Events]\nVideo,0,\"v.mp4\"\n");
  assert.deepEqual(mvSet("Inconsistent video usage.", [{ version: "A", events: vid("v.mp4") }, { version: "B" }], { "Test - Test (Test).osb": "" }), [], "the .osb's video plays in the difficulty without one");
  Q.setOsb("");
});

test("Storyboard: overlay layer and sprite resolution (MV CheckOverlayLayer, CheckSpriteResolution)", async () => {
  const ev = ["Sprite,Overlay,Centre,\"sb/a.png\",320,240", " F,0,0,1000,1", "Sprite,4,Centre,\"sb/b.png\",320,240", "Animation,Overlay,Centre,\"sb/f.png\",320,240,2,100,LoopForever"];
  assert.deepEqual(mvSet("Overlay layer usage.", [{ events: ev }], {}).map(i => i.text), ["\"sb/a.png\" Check the .osu to see where it appears.", "\"sb/f.png\" Check the .osu to see where it appears."], "a numeric layer is read as Background, as MV does");
  const T = "Too high sprite resolution.", files = { "sb/a.png": png(5000, 4000), "sb/b.png": png(100, 100), "sb/f0.png": png(10, 10), "sb/f1.png": png(4200, 4200) };
  mvSet(T, [{ events: ev }], files); await settle();
  assert.deepEqual(mvSet(T, [{ events: ev }]).map(i => i.text), ["\"sb/a.png\"", "\"sb/f1.png\" (Animation Frame)"]);
  Q.setOsb("[Variables]\n$l=Overlay\n[Events]\nSprite,$l,Centre,\"sb/c.png\",320,240\n");
  assert.deepEqual(mvSet(T, [{}], { "Test - Test (Test).osb": "" }).map(i => [i.lvl, i.text]), [["warning", "\"sb/c.png\" is missing, so you'll need to check that manually."]]);
  assert.deepEqual(mvSet("Overlay layer usage.", [{}]).map(i => i.text), ["\"sb/c.png\" Check the .osb to see where it appears."], "variables filled in");
  Q.setOsb("");
});

test("Skin element sets (MV CheckSkinningStandardTests)", async () => {
  const T = "Incomplete or incorrect skin element sets.", sl = "256,192,1000,2,0,B|300:200,1,50";
  const run = (files, o = {}) => mvSet(T, [{ objects: [o.slider ? sl : circle(1000), ...(o.spinner ? ["256,192,3000,8,0,4000"] : [])], colours: o.colours || [] }], Object.fromEntries(files.map(f => [f, new Uint8Array(4)])));
  assert.deepEqual(run(["cursor.png", "cursortrail.png"]), []);
  assert.deepEqual(run(["cursor.png"]).map(i => [i.lvl, i.text]), [["problem", "The \"Cursor\" skin set is only partially skinned, missing: cursortrail.png."]]);
  assert.deepEqual(run(["cursor.jpg", "cursortrail.png"]).map(i => [i.lvl, i.text]), [["warning", "\"cursor.jpg\" should be a .png file if it uses transparency."]]);
  assert.deepEqual(run(["sliderb0.png"]), [], "no sliders: the slider track set isn't used");
  assert.ok(run(["sliderb0.png"], { slider: true, colours: ["SliderBorder : 255,255,255"] }).some(i => i.lvl === "problem" && i.text.includes("\"Slidertrack\"")));
  assert.deepEqual(run(["hit0-0.png", "hit0-1.png", "hit50.png", "hit100.png", "hit100k.png", "hit300.png", "hit300g.png", "hit300k.png"]), [], "animated frames count");
  assert.ok(run(["spinner-circle.png", "spinner-bottom.png"], { spinner: true }).some(i => i.lvl === "problem" && i.text === "Both old (\"spinner-circle.png\") and new (\"spinner-bottom.png\") spinner style elements are present; the old style will take priority."));
  const nw = run(["spinner-bottom.png"], { spinner: true });
  assert.ok(nw.some(i => i.lvl === "warning" && i.text.includes("\"spinner-bottom.png\": usage of the new style spinner")) && !nw.some(i => i.text.includes("old and new")));
  assert.ok(run(["spinner-osu.png"], { spinner: true }).some(i => i.lvl === "warning" && i.text.startsWith("\"spinner-osu.png\" only displays")));
  const hc = ["hitcircle.png", "hitcircleoverlay.png", "approachcircle.png", "followpoint.png"];
  assert.deepEqual(run(hc).map(i => i.text), ["Test skins hitcircle or slider elements but does not define a custom slider border colour (SliderBorder under [Colours])."]);
  assert.deepEqual(run(hc, { colours: ["SliderBorder : 255,255,255"] }), []);
  assert.deepEqual(run(hc, { colours: ["SliderBorder : 200,200,200", "SliderTrackOverride : 205,205,205"] }).map(i => i.text), ["Test's slider body colour (SliderTrackOverride) is too similar to its slider border colour (SliderBorder)."]);
  assert.deepEqual(run(hc, { colours: ["SliderBorder : 255,255,255", "SliderTrackOverride : 0,0,0"] }), []);
  const burst = ["hit0.png", "hit50.png", "hit100.png", "hit100k.png", "hit300.png", "hit300g.png", "hit300k.png"];
  run(burst); await settle();
  assert.deepEqual(mvSet(T, [{}]).map(i => i.text).filter(t => t.includes("identical")), ["\"hit100.png\" and \"hit100k.png\" are identical; hit100/hit300 hitbursts must be visually distinguishable from their geki/katu counterparts.",
    "\"hit300.png\" and \"hit300g.png\" are identical; hit100/hit300 hitbursts must be visually distinguishable from their geki/katu counterparts.", "\"hit300.png\" and \"hit300k.png\" are identical; hit100/hit300 hitbursts must be visually distinguishable from their geki/katu counterparts."]);
});

test("MV parity: Burai and negative length sliders (MV CheckBurai, CheckInvisibleSlider)", () => {
  const burai = pts => diffCheck("Burai slider.", { objects: [slider(1000, { curve: "B", pts, len: 300 })] });
  assert.deepEqual(one(burai("356:192|256:194")), { lvl: "warning", text: "Potentially burai." }, "a Bézier that folds back onto itself");
  assert.deepEqual(burai("356:192|356:292"), [], "a plain corner");
  assert.deepEqual(one(diffCheck("Invisible sliders.", { objects: [slider(1000, { len: -10 })] })), { lvl: "problem", text: "Slider has negative pixel length." });
});

test("MV parity: inconsistent uninherited lines, hit sound difficulty, empty .osu", () => {
  const inc = setCheck("Inconsistent uninherited lines, meter signatures, or BPM.", [{ version: "A" }, { version: "B", timing: ["0,500,4,2,0,100,1,0", "1000,400,3,2,0,100,1,0"] }]);
  assert.deepEqual(one(inc), { lvl: "problem", text: "[A] Missing uninherited line, see [B] (150, 3/4)." });
  assert.deepEqual(setCheck("Inconsistent uninherited lines, meter signatures, or BPM.", [{ version: "A" }, { version: "B" }]), []);
  const hs = setCheck("Hitsound difficulty present.", [{ version: "Hard" }, { version: "hitsounds" }, { version: "_HS_" }]);
  assert.deepEqual(hs.map(x => x.lvl + " " + x.text.split(" ")[0]), ["problem hitsounds", "problem _HS_"]);
  const c = P.SET_CHECKS.find(x => x.title === "Empty difficulty file."), out = [];
  c.run({ maps: [], emptyOsu: ["a [b].osu"] }, (l, msg, v) => out.push(l + " " + msg.replace(/\{(\w+)\}/g, (_, k) => v[k])));
  assert.deepEqual(out, ["problem \"a [b].osu\" is empty."]);
});
