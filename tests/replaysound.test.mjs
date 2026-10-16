// The hitsounds of a watched replay (js/replayana.js rpSoundEvents + js/audio.js schedule): what the replay really did instead of Auto's schedule from the
// object times. rpSoundEvents is tested pure (parse.js + replayana.js in a vm, hand-made analyses and one real one); schedule() runs js/audio.js in a
// Node vm with a fake Web Audio context that records every source started (which sound, when, how loud), like tests/skinsound.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadScripts, J } from "./lib/browser.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const P = loadScripts(["js/replay.js", "js/parse.js", "js/replayana.js"]);
const NOMOD = { rate: 1, hr: false, ez: false, list: [] };

// ---- maps: CS 4, OD 5, 500 ms/beat soft (set 2, 100 %); from 5500 on drum (set 3, 40 %). A 350 px slider takes 1250 ms (ticks at 1/3 and 2/3 of each slide)
const osu = objects => P.parseOsu(`osu file format v14\n\n[General]\nStackLeniency: 0.7\nMode: 0\n\n[Difficulty]\nCircleSize:4\nOverallDifficulty:5\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n5500,500,4,3,0,40,1,0\n\n[HitObjects]\n${objects.join("\n")}\n`);
const circle = (x, y, t, hs = 0) => `${x},${y},${t},1,${hs},0:0:0:0:`;
const slider = (x, y, t, len, slides = 1) => `${x},${y},${t},2,0,L|${x + len}:${y},${slides},${len},${Array(slides + 1).fill(0).join("|")},${Array(slides + 1).fill("0:0").join("|")},0:0:0:0:`;
const spinner = (t, end) => `256,192,${t},12,0,${end},0:0:0:0:`;

// a hand-made analysis for map m: press[i] = press time | null (a miss) for every circle / slider head (default: on time), parts[i] = [hit, ...] in the order
// of the slider's ticks / repeats by time, then the tail; spin[i] = cleared. Slider and spinner lists can be left out (an old analysis)
function ana(m, { press = {}, parts = {}, spin = {}, noSliders = false, noSpinners = false } = {}) {
  const a = { ok: true, warn: [], hits: [], sliders: noSliders ? undefined : [], spinners: noSpinners ? undefined : [] };
  m.hit.forEach((o, i) => {
    if (o.kind === "spinner") { if (a.spinners) a.spinners.push({ i, t: o.t, end: o.end, need: 3, cleared: spin[i] !== false, clearAt: spin[i] !== false ? o.end - 100 : null, judge: spin[i] !== false ? 300 : 0 }); return; }
    const p = i in press ? press[i] : o.t, hit = p !== null;
    a.hits.push({ i, t: o.t, press: p, err: hit ? p - o.t : null, judge: hit ? 300 : 0, slider: o.kind === "slider" });
    if (o.kind === "slider" && a.sliders) {
      const es = m.sounds.filter(e => e.oi === i && (e.tick || e.k >= 1)).sort((x, y) => x.t - y.t);
      const ps = es.map(e => ({ t: e.t, kind: e.tick ? "tick" : e.k === o.slides ? "tail" : "repeat", hit: true }));
      const want = parts[i]; if (want) { assert.equal(want.length, ps.length, "parts given for slider " + i); want.forEach((h, n) => ps[n].hit = h); }
      a.sliders.push({ i, t: o.t, end: o.end, track: [], parts: ps, head: hit, brk: null, judge: 300 });
    }
  });
  return a;
}
const sounds = (m, a) => J(P.rpSoundEvents(m, a)).map(e => ({ t: e.t, nt: e.nt, oi: e.oi, k: e.k, tick: !!e.tick }));
const times = (m, a) => sounds(m, a).map(e => e.t);

test("parse.js: every sound knows its object (oi) and a slider's edge (k)", () => {
  const m = osu([circle(100, 100, 1000), slider(100, 200, 2000, 350, 2), spinner(6000, 7000)]);
  const s = J(m.sounds);
  assert.deepEqual(s.filter(e => e.oi === 0).map(e => [e.t, e.k]), [[1000, undefined]]);
  assert.deepEqual(s.filter(e => e.oi === 1 && !e.tick).map(e => [e.t, e.k]), [[2000, 0], [3250, 1], [4500, 2]]);
  assert.equal(s.filter(e => e.oi === 1 && e.tick).length, 4); assert.ok(s.filter(e => e.tick).every(e => e.k === undefined));
  assert.deepEqual(s.filter(e => e.oi === 2).map(e => e.t), [7000]);
  assert.deepEqual(s.map(e => e.t), [...s.map(e => e.t)].sort((x, y) => x - y), "still sorted");
});

test("rpSoundEvents: a miss is silent, a hit sounds at its press, nt keeps the object time", () => {
  const m = osu([circle(100, 100, 1000), circle(200, 100, 1500), circle(300, 100, 2000), circle(400, 100, 2500)]);
  const e = sounds(m, ana(m, { press: { 0: 1030, 1: null, 2: 1985 } }));
  assert.deepEqual(e.map(x => [x.oi, x.t, x.nt]), [[2, 1985, 2000], [0, 1030, 1000], [3, 2500, 2500]].sort((x, y) => x[1] - y[1]), "sorted by the time to play");
  assert.ok(!e.some(x => x.oi === 1));
});

test("rpSoundEvents: slider head by its press, parts only when hit at their nominal time, the tail at the end", () => {
  const m = osu([slider(100, 200, 2000, 350, 2)]);
  const all = sounds(m, ana(m));
  assert.equal(all.length, 7); // head, 2 ticks, repeat, 2 ticks, tail
  assert.deepEqual(all.map(x => x.t), all.map(x => x.nt), "all on time: the nominal times");
  assert.equal(all[all.length - 1].t, 4500); assert.equal(all[0].t, 2000);
  // parts (by time): tick, tick, repeat, tick, tick, tail
  const some = sounds(m, ana(m, { parts: { 0: [true, false, true, false, true, false] } }));
  // (hit: tick 1, repeat, tick 4; missed: tick 2, tick 3, the tail)
  assert.deepEqual(some.map(x => x.tick ? "tick" : "edge" + x.k), ["edge0", "tick", "edge1", "tick"]);
  assert.equal(some.some(x => x.k === 2), false, "tail missed: no sound");
  // a missed head: no head sound, the parts still follow their own hits
  const nh = sounds(m, ana(m, { press: { 0: null }, parts: { 0: [false, false, false, true, true, true] } }));
  assert.deepEqual(nh.map(x => x.tick ? "tick" : "edge" + x.k), ["tick", "tick", "edge2"]);
  // a late head: parts that passed by then are heard from the press on
  const late = sounds(m, ana(m, { press: { 0: 2500 } }));
  assert.equal(late[0].t, 2500); assert.ok(late.every(x => x.t >= 2500), JSON.stringify(late.map(x => x.t)));
  assert.equal(late.find(x => x.k === 0).nt, 2000);
});

test("rpSoundEvents: a spinner sounds only when it was cleared", () => {
  const m = osu([circle(100, 100, 1000), spinner(3000, 4000)]);
  assert.deepEqual(times(m, ana(m)), [1000, 4000]);
  assert.deepEqual(times(m, ana(m, { spin: { 1: false } })), [1000]);
});

test("rpSoundEvents: an old analysis (no sliders / spinners) falls back to the map's schedule for those; odd input never throws", () => {
  const m = osu([circle(100, 100, 1000), slider(100, 200, 2000, 350, 2), spinner(6000, 7000)]);
  const e = sounds(m, ana(m, { press: { 0: 1040, 1: 2060 }, noSliders: true, noSpinners: true }));
  assert.equal(e.length, m.sounds.length);
  assert.equal(e[0].t, 1040); assert.equal(e.find(x => x.oi === 1 && x.k === 0).t, 2060); // (heads by press)
  assert.deepEqual(e.filter(x => x.oi === 1 && x.k !== 0).map(x => x.t === x.nt), Array(6).fill(true), "the rest nominal");
  assert.equal(e[e.length - 1].t, 7000);
  const nominal = sounds(m, null); assert.deepEqual(nominal.map(x => x.t), J(m.sounds).map(x => x.t));
  for (const bad of [undefined, 0, {}, { hits: 5 }, { hits: [null, 3, { i: -1 }] }, { hits: [], sliders: [null, { i: 1, parts: 7 }, { i: 1, parts: [] }], spinners: [null, 4] }]) {
    assert.doesNotThrow(() => P.rpSoundEvents(m, bad));
    assert.equal(J(P.rpSoundEvents(m, bad)).length > 0, true);
  }
  for (const bad of [null, undefined, {}, { sounds: 3 }, { sounds: [{ t: 1 }], hit: 4 }]) assert.doesNotThrow(() => P.rpSoundEvents(bad, ana(m)));
  assert.deepEqual(J(P.rpSoundEvents(null, null)), []);
  // a slider whose parts are not those of this map (another count): the head by press, the rest as the map has it
  const a = ana(m); a.sliders[0].parts.pop();
  const odd = sounds(m, a).filter(x => x.oi === 1);
  assert.equal(odd.length, 7, "all of the slider's sounds"); assert.ok(odd.every(x => x.t === x.nt));
});

test("rpSoundEvents on a real analysis: a missed circle and a late hit, a slider followed", () => {
  const m = osu([circle(100, 100, 1000), circle(300, 100, 1500), slider(100, 200, 3000, 350)]);
  const rows = [[0, 256, 192, 0]];
  const ball = t => { const o = m.hit[2], p = P.pointAt(o, P.ballF(o, t).f); return [p[0], p[1]]; };
  for (let t = 900; t <= 4400; t += 10) {
    let pos, key = 0;
    if (t < 1300) { pos = [100, 100]; key = t >= 1050 && t < 1100 ? 5 : 0; } // circle 0 hit at 1050 (50 late)
    else if (t < 2900) pos = [450, 350]; // circle 1 missed
    else { pos = t < 3000 ? [100, 200] : ball(t); key = t >= 3000 ? 5 : 0; }
    rows.push([t, pos[0], pos[1], key]);
  }
  const n = rows.length, f = { n, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), k: new Uint8Array(n) };
  rows.forEach(([t, x, y, k], i) => { f.t[i] = t; f.x[i] = x; f.y[i] = y; f.k[i] = k; });
  const a = P.rpAnalyze({ mode: 0, mapMd5: "0".repeat(32), player: "t", counts: { n300: 0, n100: 0, n50: 0, geki: 0, katu: 0, miss: 0 }, mods: 0, lazerInfo: null, frames: f }, m, NOMOD);
  assert.equal(a.ok, true);
  const e = sounds(m, a);
  assert.equal(e.some(x => x.oi === 1), false, "the missed circle is silent");
  assert.ok(Math.abs(e[0].t - 1050) < 1 && e[0].nt === 1000 && e[0].oi === 0, JSON.stringify(e[0]));
  assert.equal(e.filter(x => x.oi === 2).length, m.sounds.filter(x => x.oi === 2).length, "the followed slider has all its sounds");
});

// ---- audio.js schedule() with a fake RP / RPH
const W = { started: [], fetched: [], fetch: null, decodeFail: false };
class FakeCtx {
  constructor() { this.currentTime = 0; this.sampleRate = 44100; this.state = "running"; this.destination = {}; }
  createBuffer(ch, n) { return { tag: "synth", length: n }; }
  createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect: x => x }; }
  createBufferSource() { const s = { buffer: null, playbackRate: { value: 1 }, connect: g => { s.g = g; return g; }, start(at) { W.started.push({ tag: s.buffer.tag, at, vol: s.g ? s.g.gain.value : 1 }); }, stop() {} }; return s; }
  decodeAudioData(ab, res, rej) { setTimeout(() => W.decodeFail ? rej(new Error("EncodingError")) : res({ tag: "net:combobreak", length: 100 }), 1); }
  resume() { return Promise.resolve(); }
}
const PAGE = `
let S = { hsSrc: "beatmap", skinSounds: false, btMode: false, metro: false }, dirty = false;
const SETS = { 1: "normal", 2: "soft", 3: "drum" }, EDIT = { on: false }, norm = p => String(p).toLowerCase();
const hsGain = () => 1, hsNow = () => {}, hsFlash = () => {}, tr = s => s, musGain = () => 1, outLatency = 0, onSongEnd = () => {};
function lastBefore(a, t, k) { let lo = 0, hi = a.length - 1, r = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid][k] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; } return r; }
let SK = { sndN: 0, sounds: {}, sbuf: {} };
let RP = { on: false, data: null }, RPH = { data: null, hit: null, a: null, byI: null };
`;
const ctx = vm.createContext({
  console, Math, JSON, Date, Map, Set, Array, Object, Number, String, Promise, Float32Array, Float64Array, Uint8Array, setTimeout, clearTimeout,
  setInterval: () => 0, performance, navigator: {}, MessageChannel,
  window: { AudioContext: FakeCtx, addEventListener() {} }, document: { getElementById: () => null, addEventListener() {}, hidden: false },
  W, T: {}, fetch: url => { W.fetched.push(url); return W.fetch(url); },
});
vm.runInContext(PAGE, ctx, { filename: "page.js" });
vm.runInContext(readFileSync(join(root, "js/audio.js"), "utf8"), ctx, { filename: "js/audio.js" });
vm.runInContext(readFileSync(join(root, "js/replayana.js"), "utf8"), ctx, { filename: "js/replayana.js" });
const run = code => vm.runInContext(code, ctx);
const set = (code, v) => { ctx.T.v = v; run(code + " = T.v"); };

// a new map in the page; its sounds / hit / timing come from parse.js; the replay off
function load(m) {
  run(`getCtx(); S.hsSrc = "beatmap"; for (const k in defBank) delete defBank[k]; mapBank = {}`);
  for (const s of ["normal", "soft", "drum"]) for (const t of ["hitnormal", "hitwhistle", "hitfinish", "hitclap", "slidertick"]) { ctx.T.k = `${s}-${t}`; ctx.T.b = { tag: ctx.T.k, length: 100 }; run("defBank[T.k] = T.b"); }
  set("map", { sounds: J(m.sounds), hit: J(m.hit), timing: J(m.timing), defSet: m.defSet, uni: [] });
  run("RP.on = false; RP.data = null; RPH.data = null; RPH.hit = null; RPH.a = null");
  run("A.mode = 'buf'; A.on = true; A.startCtx = 0; A.pos = 0; A.rate = 1; A.nudge = 1; clock.pre = false; resetSched()");
  W.started.length = 0; W.fetched.length = 0; W.decodeFail = false; W.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  run("S.skinSounds = false; SK = { sndN: 0, sounds: {}, sbuf: {} }; for (const k in defLoading) delete defLoading[k]");
}
// the analysis ready for the replay (RPH as js/player.js leaves it)
function ready(a) { set("RP.data", { id: "r" }); run("RP.on = true; RPH.data = RP.data; RPH.hit = map.hit"); set("RPH.a", a); }
// song time from..to in steps of `step` ms with `ahead` ms lookahead (what the frame loop does); returns [tag@ms] of what started
function play(from, to, step = 50, ahead = 400) {
  W.started.length = 0;
  for (let t = from; t <= to; t += step) run(`schedule(${t}, ${ahead})`);
  return W.started.map(s => ({ tag: s.tag, ms: Math.round(s.at * 1000), vol: s.vol }));
}
const nt = list => list.map(x => x.ms);

test("schedule: Auto (no replay) plays map.sounds at the object times, as before", () => {
  const m = osu([circle(100, 100, 1000), circle(200, 100, 1500), slider(100, 200, 2000, 350)]);
  load(m);
  const got = play(0, 4000);
  assert.deepEqual(nt(got).filter(x => x < 2000), [1000, 1500]);
  assert.equal(got.length, m.sounds.length);
  // a ready analysis that says "missed" changes nothing while no replay is on
  set("RPH.a", ana(m, { press: { 0: null } })); run("RPH.data = {}; RPH.hit = map.hit; resetSched()");
  assert.equal(play(0, 4000).length, m.sounds.length, "RP.on false: Auto's");
});

test("schedule: with a replay a missed circle is silent, a late hit sounds at its press, a hit on time at its time", () => {
  const m = osu([circle(100, 100, 1000), circle(200, 100, 1500), circle(300, 100, 2000)]);
  load(m); ready(ana(m, { press: { 0: 1070, 1: null, 2: 2000 } }));
  assert.deepEqual(nt(play(0, 3000)), [1070, 2000]);
});

test("schedule: slider parts and spinners follow the replay", () => {
  const m = osu([slider(100, 200, 2000, 350, 2), spinner(6000, 7000), spinner(8000, 9000)]);
  load(m);
  // parts by time: tick, tick, repeat, tick, tick, tail
  ready(ana(m, { parts: { 0: [true, false, true, false, true, false] }, spin: { 1: true, 2: false } }));
  const got = play(0, 10000, 100, 600), es = J(m.sounds).filter(e => e.oi === 0);
  const edge = es.filter(e => !e.tick).map(e => e.t), ticks = es.filter(e => e.tick).map(e => e.t).sort((x, y) => x - y);
  // (hit: the head, tick 1, the repeat, tick 4 and the first spinner's end; not ticks 2 and 3, the tail, nor the second spinner)
  assert.deepEqual(nt(got), [edge[0], ticks[0], edge[1], ticks[3], 7000].map(Math.round).sort((x, y) => x - y));
});

test("schedule: sample set, volume and slider tick sound come from the nominal time's timing point, not from the press", () => {
  const m = osu([circle(100, 100, 5400), circle(200, 100, 5600)]);
  load(m); ready(ana(m, { press: { 0: 5560, 1: 5620 } })); // (the drum point starts at 5500)
  const got = play(5000, 6200);
  assert.deepEqual(got.map(x => [x.ms, x.tag, x.vol]), [[5560, "soft-hitnormal", 1], [5620, "drum-hitnormal", .4]]);
});

test("schedule: the replay's list takes over in the middle of playback without playing anything twice or skipping what is still to come", () => {
  const m = osu([circle(100, 100, 1000), circle(200, 100, 1380), circle(300, 100, 1500), circle(350, 100, 1540), circle(400, 100, 1700), circle(100, 300, 2000)]);
  load(m);
  const a = ana(m, { press: { 0: 1020, 1: 1450, 2: 1560, 3: 1590, 4: null, 5: 2010 } });
  const first = play(900, 1000, 50, 500); // Auto's: queued up to 1500 (the window is 500 ms)
  assert.deepEqual(nt(first), [1000, 1380, 1500], "Auto already queued these");
  ready(a);
  const rest = play(1050, 3000, 50, 500);
  // the late hits of objects Auto already played (1020, 1450 and 1560 for the one at 1500) are not played again; the one at 1540 was not queued yet: at its
  // press 1590; the missed 1700 is silent
  assert.deepEqual(nt(rest), [1590, 2010]);
});

test("schedule: the same analysis object is not rebuilt, a new one is, and a seek back plays it all again", () => {
  const m = osu([circle(100, 100, 1000), circle(200, 100, 1500)]);
  load(m); const a = ana(m, { press: { 0: 1040, 1: null } }); ready(a);
  assert.deepEqual(nt(play(0, 2000)), [1040]);
  assert.equal(run("rsA") !== null, true);
  const list = run("rsList"); play(0, 100); assert.equal(run("rsList"), list, "cached");
  run("resetSched()"); assert.deepEqual(nt(play(900, 2000)), [1040], "seek back: again");
  run("resetSched()"); assert.deepEqual(nt(play(0, 500)), [], "seek to before: nothing yet");
  ready(ana(m, { press: { 0: null, 1: 1520 } }));
  run("resetSched()"); assert.deepEqual(nt(play(900, 2000)), [1520], "another analysis: its events");
});

test("schedule: Auto's schedule while the analysis is computing, for another map or replay, or when it failed", () => {
  const m = osu([circle(100, 100, 1000), circle(200, 100, 1500)]);
  load(m); const a = ana(m, { press: { 0: null, 1: null } });
  run("RP.on = true"); set("RP.data", { id: "r" }); // computing: RPH.a is null
  assert.deepEqual(nt(play(0, 2000)), [1000, 1500]);
  set("RPH.a", a); run("RPH.data = {}; RPH.hit = map.hit; resetSched()"); // an analysis of another replay
  assert.deepEqual(nt(play(0, 2000)), [1000, 1500]);
  run("RPH.data = RP.data; RPH.hit = []; resetSched()"); // of another map
  assert.deepEqual(nt(play(0, 2000)), [1000, 1500]);
  run("RPH.hit = map.hit; resetSched()"); a.ok = false; // an analysis that failed
  assert.deepEqual(nt(play(0, 2000)), [1000, 1500]);
  a.ok = true; run("resetSched()");
  assert.deepEqual(nt(play(0, 2000)), [], "and then the replay's: both missed");
});

test("schedule: the lookahead and a late hit near the end of a window play exactly once", () => {
  const m = osu([circle(100, 100, 1000)]);
  load(m); ready(ana(m, { press: { 0: 1090 } }));
  assert.deepEqual(nt(play(0, 3000, 33, 150)), [1090]);
});

// ---- the combo-break sound (osu!lazer ComboEffects.cs: the combo drops to 0 from above 20)
// a.combo as the analysis leaves it: every break { t, combo (just before) }; a.consistency { header, quality }
const withCombo = (a, breaks, quality, header = { n300: 50, n100: 0, n50: 0, miss: 1 }) => Object.assign(a, { combo: { max: 100, breaks }, consistency: { header, est: {}, d300: 0, diff: 0, quality } });
const CBM = osu([circle(100, 100, 1000), circle(200, 100, 1500), circle(300, 100, 2000), circle(400, 100, 2500)]);
const seedCb = () => { ctx.T.b = { tag: "def:combobreak", length: 100 }; run("defBank.combobreak = T.b"); };
const cbEv = (m, a) => J(P.rpSoundEvents(m, a)).filter(e => e.combobreak);

test("rpSoundEvents: a break from a combo above 20 is an event at its time; 20 and below, and a combo of 0, are not", () => {
  const m = CBM;
  const a = withCombo(ana(m, { press: { 1: null } }), [{ t: 1700, combo: 21 }, { t: 1800, combo: 0 }, { t: 1900, combo: 20 }, { t: 2200, combo: 5 }, { t: 2300, combo: 150 }], "good");
  assert.deepEqual(cbEv(m, a), [{ t: 1700, nt: 1700, combobreak: true, hs: 0, tick: false }, { t: 2300, nt: 2300, combobreak: true, hs: 0, tick: false }]);
  const all = J(P.rpSoundEvents(m, a));
  assert.deepEqual(all.map(e => e.t), [...all.map(e => e.t)].sort((x, y) => x - y), "sorted by t");
  assert.deepEqual(all.map(e => e.t), [1000, 1700, 2000, 2300, 2500], "(circle 1 missed: silent) the breaks between the hits");
  assert.equal(all.filter(e => !e.combobreak).length, 3);
});

test("rpSoundEvents: no a.combo, an empty or odd one: no break events and the hit list is untouched", () => {
  const m = CBM, base = sounds(m, ana(m));
  for (const c of [undefined, null, {}, { breaks: null }, { breaks: [] }, { breaks: 5 }, { breaks: [null, 3, {}, { t: NaN, combo: 99 }, { t: 100 }, { combo: 99 }, { t: "x", combo: 99 }] }]) {
    const a = ana(m); if (c !== undefined) a.combo = c;
    assert.deepEqual(cbEv(m, a), []); assert.deepEqual(sounds(m, a), base);
  }
  const a = ana(m); Object.defineProperty(a, "combo", { get() { throw new Error("odd"); } }); // (a getter that throws costs only the breaks)
  assert.deepEqual(sounds(m, a), base);
  // an analysis without a.hits: Auto's list as it is, plus the breaks
  const nh = withCombo({ ok: true }, [{ t: 1250, combo: 40 }], "good");
  assert.deepEqual(J(P.rpSoundEvents(m, nh)).map(e => e.t), [1000, 1250, 1500, 2000, 2500]);
  assert.deepEqual(J(P.rpSoundEvents(m, { ok: true })).map(e => e.t), [1000, 1500, 2000, 2500]);
});

test("schedule: a break above the threshold plays the combobreak sample once, at its time, as loud as a hitsound", () => {
  const m = CBM; load(m); seedCb();
  ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good"));
  const got = play(0, 3000);
  assert.deepEqual(got.map(x => [x.ms, x.tag, x.vol]), [[1000, "soft-hitnormal", 1], [1500, "soft-hitnormal", 1], [1750, "def:combobreak", 1], [2000, "soft-hitnormal", 1], [2500, "soft-hitnormal", 1]]);
});

test("schedule: a break from a combo of 20 or less is silent; so is a missed slider tail (no break in a.combo)", () => {
  const m = osu([circle(100, 100, 1000), slider(100, 200, 2000, 350, 1)]); load(m); seedCb();
  const parts = m.sounds.filter(e => e.oi === 1 && (e.tick || e.k >= 1)).length;
  ready(withCombo(ana(m, { parts: { 1: Array(parts).fill(true).map((v, i) => i < parts - 1) } }), [{ t: 1500, combo: 20 }, { t: 1600, combo: 3 }], "good")); // (tail missed, no break: the combo was under 20... or the tail broke nothing)
  assert.equal(play(0, 4000).some(x => x.tag === "def:combobreak"), false);
  assert.equal(run("rsList").some(e => e.combobreak), false);
  assert.deepEqual(W.fetched, [], "no break sound in the list: the default sample is not fetched");
});

test("schedule: poor consistency (the header has counts): Auto's schedule, no breaks, nothing fetched", () => {
  const m = CBM; load(m); seedCb();
  ready(withCombo(ana(m, { press: { 0: null, 1: null } }), [{ t: 1750, combo: 30 }], "poor"));
  const got = play(0, 3000);
  assert.deepEqual(nt(got), [1000, 1500, 2000, 2500], "Auto's, not the replay's (which missed two)");
  assert.equal(got.some(x => x.tag === "def:combobreak"), false);
  assert.deepEqual(W.fetched, []);
  // fair / good keep the replay's list
  run("resetSched()"); ready(withCombo(ana(m, { press: { 0: null, 1: null } }), [{ t: 1750, combo: 30 }], "fair"));
  assert.deepEqual(nt(play(0, 3000)), [1750, 2000, 2500]);
});

test("schedule: poor with an all-zero header is no evidence: the replay's list stays, breaks included", () => {
  const m = CBM; load(m); seedCb();
  ready(withCombo(ana(m, { press: { 0: null } }), [{ t: 1750, combo: 30 }], "poor", { n300: 0, n100: 0, n50: 0, miss: 0 }));
  assert.deepEqual(nt(play(0, 3000)), [1500, 1750, 2000, 2500]);
  // a header that is missing altogether
  run("resetSched()"); ready(Object.assign(withCombo(ana(m, { press: { 0: null } }), [{ t: 1750, combo: 30 }], "poor"), { consistency: { quality: "poor" } }));
  assert.deepEqual(nt(play(0, 3000)), [1500, 1750, 2000, 2500]);
});

test("schedule: a seek back plays the break again, once; playing on past it does not repeat it", () => {
  const m = CBM; load(m); seedCb();
  ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good"));
  const n = got => got.filter(x => x.tag === "def:combobreak").length;
  assert.equal(n(play(0, 3000)), 1);
  assert.equal(n(play(3000, 3500)), 0);
  run("resetSched()"); assert.equal(n(play(1600, 3000)), 1, "seek back");
  run("resetSched()"); assert.equal(n(play(1800, 3000)), 0, "seek to after it");
  run("resetSched()"); assert.equal(n(play(0, 1000)), 0, "before it");
  assert.equal(n(play(1000, 2000)), 1, "and then on");
});

test("schedule: the replay's list taking over in the middle of playback plays a break that is still ahead once, not one already passed", () => {
  const m = CBM; load(m); seedCb();
  const a = withCombo(ana(m), [{ t: 1200, combo: 50 }, { t: 2300, combo: 50 }], "good");
  const first = play(900, 1000, 50, 500); // Auto's: queued up to 1500
  assert.deepEqual(nt(first), [1000, 1500]);
  ready(a);
  const rest = play(1050, 3000, 50, 500);
  assert.deepEqual(rest.map(x => [x.ms, x.tag === "def:combobreak"]), [[2000, false], [2300, true], [2500, false]], "the break at 1200 was before the switch (queued up to 1500)");
  // Auto's list again (another replay's analysis that is poor): nothing of the old list's breaks
  ready(withCombo(ana(m), [{ t: 2300, combo: 50 }], "poor"));
  assert.equal(play(2000, 3000, 50, 500).some(x => x.tag === "def:combobreak"), false);
});

test("schedule: the default sample is fetched lazily, at the first replay start with a break, once, and then plays", async () => {
  const m = CBM; load(m);
  assert.deepEqual(W.fetched, [], "not at load");
  play(0, 3000); assert.deepEqual(W.fetched, [], "Auto: not fetched");
  ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good"));
  assert.deepEqual(W.fetched, [], "not before a list with a break is built");
  run("resetSched()"); const early = play(0, 3000);
  assert.equal(early.some(x => x.tag === "net:combobreak"), false, "not decoded yet: silent, not a drawn tone");
  assert.equal(early.some(x => x.tag === "synth"), false);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(W.fetched, ["https://raw.githubusercontent.com/ppy/osu-resources/master/osu.Game.Resources/Samples/Gameplay/combobreak.mp3"]);
  run("resetSched()");
  assert.deepEqual(play(1000, 3000).filter(x => x.tag === "net:combobreak").map(x => x.ms), [1750]);
  run("resetSched()"); play(0, 3000); assert.equal(W.fetched.length, 1, "fetched once");
});

test("schedule: a failed fetch or decode of the default sample is silent (no drawn tone), and the next replay tries again", async () => {
  const m = CBM; load(m);
  W.fetch = async () => ({ ok: false });
  ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good")); run("resetSched()"); play(0, 3000);
  await new Promise(r => setTimeout(r, 20));
  run("resetSched()"); const got = play(1000, 3000);
  assert.deepEqual(got.map(x => x.ms), [1000, 1500, 2000, 2500], "only the circles");
  assert.equal(got.some(x => x.tag === "synth" || /combobreak/.test(x.tag)), false);
  W.fetch = async () => { throw new Error("offline"); }; ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good")); run("resetSched()"); play(0, 3000);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(W.fetched.length, 2, "tried again for the next analysis");
  run("resetSched()"); assert.equal(play(1000, 3000).some(x => x.tag === "synth" || /combobreak/.test(x.tag)), false);
  W.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }); W.decodeFail = true; ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good")); run("resetSched()"); play(0, 3000);
  await new Promise(r => setTimeout(r, 20));
  run("resetSched()"); assert.equal(play(1000, 3000).some(x => x.tag === "synth" || /combobreak/.test(x.tag)), false, "undecodable: silent");
  W.decodeFail = false; ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good")); run("resetSched()"); play(0, 3000);
  await new Promise(r => setTimeout(r, 20));
  run("resetSched()"); assert.deepEqual(play(1000, 3000).filter(x => x.tag === "net:combobreak").map(x => x.ms), [1750], "and it works once the network does");
});

test("schedule: Hitsound source Off silences the break too", () => {
  const m = CBM; load(m); seedCb(); run('S.hsSrc = "off"');
  ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good"));
  assert.deepEqual(play(0, 3000), []);
  run("S.hsSrc = 'beatmap'; resetSched()"); assert.equal(play(0, 3000).filter(x => x.tag === "def:combobreak").length, 1);
});

test("schedule: the skin's combobreak comes before the default one when the skin's hitsounds are on; a blank one mutes it; off: the default", () => {
  const m = CBM; load(m); seedCb();
  ready(withCombo(ana(m), [{ t: 1750, combo: 30 }], "good"));
  const cb = () => { run("resetSched()"); return play(0, 3000).filter(x => x.tag.includes("combobreak")).map(x => x.tag); };
  ctx.T.sk = { sndN: 1, sounds: {}, sbuf: { combobreak: { tag: "skin:combobreak", length: 100 } }, sndP: Promise.resolve() }; run("SK = T.sk; S.skinSounds = true");
  assert.deepEqual(cb(), ["skin:combobreak"]);
  run("S.skinSounds = false"); assert.deepEqual(cb(), ["def:combobreak"], "skin hitsounds off: only the default sample");
  run("S.skinSounds = true; SK.sbuf.combobreak = false"); assert.deepEqual(cb(), [], "a blank file: the skin mutes it");
  run("delete SK.sbuf.combobreak"); assert.deepEqual(cb(), ["def:combobreak"], "a skin without one (or not decoded yet): the default");
});
