// Hitsounds from the skin (js/audio.js sampleFor / playEvent / skinSndWarm): which sound plays for a hit.
// Order: the map's own file (Hitsound source "From the map", for its custom index) > the skin's (Settings → Skin → "Use the skin's
// hitsounds") > osu! default > the drawn one. js/audio.js runs as it is in a Node vm, with a fake Web Audio context that records
// what is started; a skin is a plain object shaped like skins.js builds it (sounds: name -> bytes, sbuf: decoded).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const W = { started: [], decodes: [] }; // (what the page did: buffers started, files decoded)

// a fake "file": its bytes say which sound it is ("tone|<tag>|"), or "bad" (can't be decoded)
const file = (tag, size = 400) => new Blob([("tone|" + tag + "|").padEnd(size, ".")]);
class FakeCtx {
  constructor() { this.currentTime = 0; this.sampleRate = 44100; this.state = "running"; this.destination = {}; }
  createBuffer(ch, n) { return { tag: "synth", length: n, duration: n / 44100, getChannelData: () => new Float32Array(n) }; }
  createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect: x => x }; }
  createBufferSource() { const s = { buffer: null, playbackRate: { value: 1 }, connect: x => x, start() { W.started.push(s.buffer); }, stop() {} }; return s; }
  decodeAudioData(ab, res, rej) {
    const t = new TextDecoder().decode(new Uint8Array(ab)), m = t.match(/^tone\|([^|]*)\|/); W.decodes.push(m ? m[1] : t.slice(0, 8));
    setTimeout(() => m ? res({ tag: m[1], length: m[1] === "empty" ? 0 : 100, duration: .01 }) : rej(new Error("EncodingError")), 1);
  }
  resume() { return Promise.resolve(); }
}
const PAGE = `
let S = { hsSrc: "beatmap", skinSounds: true, btMode: false, metro: false }, dirty = false;
const SETS = { 1: "normal", 2: "soft", 3: "drum" }, EDIT = { on: false }, norm = p => String(p).toLowerCase();
const hsGain = () => 1, hsNow = () => {}, hsFlash = () => {}, tr = s => s, musGain = () => 1, outLatency = 0, onSongEnd = () => {};
function lastBefore(a, t, k) { let i = -1; for (let j = 0; j < a.length; j++) if (a[j][k] <= t) i = j; return i; }
let SK = { sndN: 0, sounds: {}, sbuf: {} };
let ensured = 0; async function ensureSkins() { ensured++; }
`;
const ctx = vm.createContext({
  console, Math, JSON, Date, Map, Set, Array, Object, Number, String, Promise, TextDecoder, Blob, Float32Array, Uint8Array, setTimeout, clearTimeout,
  setInterval: () => 0, performance, navigator: {}, MessageChannel,
  window: { AudioContext: FakeCtx, addEventListener() {} }, document: { getElementById: () => null, addEventListener() {}, hidden: false },
  W,
});
vm.runInContext(PAGE, ctx, { filename: "page.js" });
vm.runInContext(readFileSync(join(root, "js/audio.js"), "utf8"), ctx, { filename: "js/audio.js" });
const run = code => vm.runInContext(code, ctx);
const T = {}; ctx.T = T;
const set = (code, v) => { T.v = v; run(code + " = T.v"); };

// the bank of osu! default sounds and the map's own files, by tag
const buf = tag => ({ tag, length: 100, duration: .01 });
const reset = () => {
  run(`getCtx(); S.hsSrc = "beatmap"; S.skinSounds = true; for (const k in defBank) delete defBank[k]; mapBank = {}; for (const k in synthCache) delete synthCache[k]`);
  for (const s of ["normal", "soft", "drum"]) for (const t of ["hitnormal", "hitwhistle", "hitfinish", "hitclap", "slidertick"]) { T.k = `${s}-${t}`; T.b = buf("def:" + T.k); run("defBank[T.k] = T.b"); }
  set("SK", { sndN: 0, sounds: {}, sbuf: {} });
  W.started.length = 0; W.decodes.length = 0;
};
// a skin with these sound files (name -> tag), already decoded unless raw
const skin = async (names, raw = false) => {
  const sounds = {}; for (const [n, tag] of Object.entries(names)) sounds[n] = tag === "blank" ? new Blob(["RIFF"]) : tag === "bad" ? new Blob(["x".repeat(400)]) : file(tag);
  const sk = { id: "osk:t", sndN: Object.keys(sounds).length, sounds, sbuf: {}, sndP: null };
  set("SK", sk);
  if (!raw) { await run("skinSndWarm(SK)"); }
  return sk;
};
const pick = (s, t, i) => { const b = run(`sampleFor(${JSON.stringify(s)}, ${JSON.stringify(t)}, ${i})`); return b ? b.tag : b; };

test("no skin sounds: the map's file for its index, else osu! default (as before)", async () => {
  reset(); T.b = buf("map:normal-hitnormal"); run("mapBank['normal-hitnormal'] = T.b"); T.b = buf("map:soft-hitclap2"); run("mapBank['soft-hitclap2'] = T.b");
  assert.equal(pick("normal", "hitnormal", 1), "map:normal-hitnormal");
  assert.equal(pick("normal", "hitnormal", 0), "def:normal-hitnormal", "index 0: never the map's file");
  assert.equal(pick("soft", "hitclap", 2), "map:soft-hitclap2");
  assert.equal(pick("soft", "hitclap", 3), "def:soft-hitclap");
  run("delete defBank['drum-hitfinish']"); assert.equal(pick("drum", "hitfinish", 1), "synth", "nothing at all: the drawn sound");
});

test("map > skin > default, for every index", async () => {
  reset(); T.b = buf("map:normal-hitnormal"); run("mapBank['normal-hitnormal'] = T.b");
  await skin({ "normal-hitnormal": "skin:nh", "soft-hitwhistle": "skin:sw", "drum-hitclap2": "skin:dc2", "drum-hitclap": "skin:dc" });
  assert.equal(pick("normal", "hitnormal", 1), "map:normal-hitnormal", "the map's own file wins");
  assert.equal(pick("normal", "hitnormal", 0), "skin:nh", "index 0: the skin's");
  assert.equal(pick("normal", "hitnormal", 2), "skin:nh", "index 2 without a map file: the skin's plain one");
  assert.equal(pick("soft", "hitwhistle", 1), "skin:sw");
  assert.equal(pick("drum", "hitclap", 2), "skin:dc2", "the skin's own custom index");
  assert.equal(pick("drum", "hitclap", 1), "skin:dc", "index 1: the file without a number");
  assert.equal(pick("drum", "hitclap", 0), "skin:dc");
  assert.equal(pick("drum", "hitclap", 5), "skin:dc", "an index the skin lacks: its plain one");
  assert.equal(pick("soft", "hitnormal", 1), "def:soft-hitnormal", "what the skin lacks: osu! default (never another set)");
});

test("the setting off: exactly the old lookup", async () => {
  reset(); T.b = buf("map:soft-hitclap2"); run("mapBank['soft-hitclap2'] = T.b");
  await skin({ "normal-hitnormal": "skin:nh", "soft-hitclap": "skin:sc" });
  run("S.skinSounds = false");
  assert.equal(pick("normal", "hitnormal", 0), "def:normal-hitnormal");
  assert.equal(pick("soft", "hitclap", 1), "def:soft-hitclap");
  assert.equal(pick("soft", "hitclap", 2), "map:soft-hitclap2");
});

test("Hitsound source Default: the map's files are ignored, the skin's still play; Off: nothing", async () => {
  reset(); T.b = buf("map:normal-hitnormal"); run("mapBank['normal-hitnormal'] = T.b");
  await skin({ "soft-hitnormal": "skin:sn" });
  run("S.hsSrc = 'default'");
  assert.equal(pick("normal", "hitnormal", 1), "def:normal-hitnormal");
  assert.equal(pick("soft", "hitnormal", 1), "skin:sn");
  run("S.hsSrc = 'off'; map = { timing: [{ time: 0, sampleSet: 2, sampleIndex: 1, volume: 100 }], defSet: 1 }");
  run("playEvent({ t: 100, hs: 15, n: 0, a: 0, i: 0, v: 0, f: '' }, 0)");
  assert.equal(W.started.length, 0);
  run("map = null");
});

test("playEvent: a hit's sounds (set from the timing point, additions, custom index, the map's named file) through the same lookup", async () => {
  reset(); await skin({ "soft-hitnormal": "skin:sn", "soft-hitclap": "skin:sc", "soft-slidertick": "skin:st", "drum-hitwhistle2": "skin:dw2" });
  T.b = buf("map:custom"); run("mapBank['custom'] = T.b");
  run("map = { timing: [{ time: 0, sampleSet: 2, sampleIndex: 0, volume: 80 }], defSet: 1 }");
  const play = e => { W.started.length = 0; T.e = e; run("playEvent(T.e, 0)"); return W.started.map(b => b.tag); };
  assert.deepEqual(play({ t: 100, hs: 8, n: 0, a: 0, i: 0, v: 0, f: "" }), ["skin:sn", "skin:sc"], "soft set from the timing point, clap addition");
  assert.deepEqual(play({ t: 100, hs: 2, n: 0, a: 3, i: 2, v: 0, f: "" }), ["skin:sn", "skin:dw2"], "drum additions, index 2");
  assert.deepEqual(play({ t: 100, hs: 4, n: 0, a: 0, i: 0, v: 0, f: "" }), ["skin:sn", "def:soft-hitfinish"]);
  assert.deepEqual(play({ t: 100, tick: true, hs: 0, n: 0, a: 0, i: 0, v: 0, f: "" }), ["skin:st"], "slider tick");
  assert.deepEqual(play({ t: 100, hs: 0, n: 0, a: 0, i: 0, v: 0, f: "Custom.wav" }), ["map:custom"], "the map's named sample file wins");
  run("map = null");
});

test("decoded on first use, once for the whole skin; until then osu! default plays", async () => {
  reset(); const sk = await skin({ "normal-hitnormal": "skin:nh", "normal-hitclap": "skin:nc", "soft-hitclap3": "skin:sc3", "drum-slidertick": "skin:dt" }, true);
  assert.equal(W.decodes.length, 0, "nothing decoded at import");
  for (let i = 0; i < 20; i++) assert.equal(pick("normal", "hitnormal", 0), "def:normal-hitnormal");
  assert.ok(sk.sndP, "the first hit started the decode");
  await sk.sndP;
  assert.deepEqual(W.decodes.slice().sort(), ["skin:dt", "skin:nc", "skin:nh", "skin:sc3"], "each file decoded once");
  assert.equal(pick("normal", "hitnormal", 0), "skin:nh");
  assert.equal(pick("soft", "hitclap", 3), "skin:sc3");
  assert.equal(W.decodes.length, 4, "no decode per hit");
  run("S.skinSounds = false; SK.sndP = null; SK.sbuf = {}; skinSndWarm(SK)"); assert.equal(sk.sndP, null, "the setting off: no decode");
});

test("a blank file mutes that sound (as in osu!); a file this browser can't decode falls back to osu! default", async () => {
  reset(); await skin({ "normal-hitclap": "blank", "normal-hitwhistle": "bad", "normal-hitfinish": "empty", "normal-hitnormal": "skin:nh" });
  assert.equal(pick("normal", "hitclap", 0), null);
  assert.equal(pick("normal", "hitfinish", 0), null, "decodes to no samples: muted too");
  assert.equal(pick("normal", "hitwhistle", 0), "def:normal-hitwhistle");
  run("map = { timing: [{ time: 0, sampleSet: 1, sampleIndex: 0, volume: 100 }], defSet: 1 }");
  W.started.length = 0; run("playEvent({ t: 50, hs: 10, n: 0, a: 0, i: 0, v: 0, f: '' }, 0)");
  assert.deepEqual(W.started.map(b => b.tag), ["skin:nh", "def:normal-hitwhistle"], "the muted clap plays nothing");
  run("map = null");
});

test("a skin switch is heard at the next hit; a released skin plays osu! default", async () => {
  reset(); const a = await skin({ "normal-hitnormal": "skin:A" });
  assert.equal(pick("normal", "hitnormal", 0), "skin:A");
  const b = await skin({ "normal-hitnormal": "skin:B" });
  assert.equal(pick("normal", "hitnormal", 0), "skin:B");
  // what skins.js closeSkin does to a skin it lets go
  Object.assign(b, { sounds: {}, sbuf: {}, sndN: 0, sndDead: true });
  assert.equal(pick("normal", "hitnormal", 0), "def:normal-hitnormal");
  // a decode still running when the skin is let go keeps nothing
  const c = await skin({ "normal-hitnormal": "skin:C" }, true); run("skinSndWarm(SK)");
  Object.assign(c, { sounds: {}, sbuf: {}, sndN: 0, sndDead: true }); await c.sndP;
  assert.deepEqual(Object.keys(c.sbuf), []);
  assert.ok(a.sbuf["normal-hitnormal"], "the other skin's sounds untouched");
});

test("previewHit and the timing window's preview use the same lookup", async () => {
  reset(); await skin({ "normal-hitnormal": "skin:nh" });
  run("ensureAudioCtx = () => {}; preloadDefaults = () => {}");
  W.started.length = 0; run("previewHit()");
  assert.deepEqual(W.started.map(b => b.tag), ["skin:nh"]);
});

test("loading a map's samples also gets the chosen skin's sounds ready", async () => {
  reset(); const sk = await skin({ "soft-hitnormal": "skin:sn" }, true);
  run("files = {}; osuFiles = []"); const before = run("ensured");
  await run("loadMapSamples()");
  assert.equal(run("ensured"), before + 1);
  assert.ok(sk.sbuf["soft-hitnormal"], "decoded before the map plays");
  run("S.hsSrc = 'off'"); const sk2 = await skin({ "soft-hitnormal": "skin:x" }, true); await run("loadMapSamples()");
  assert.equal(sk2.sndP, null, "hitsounds off: nothing decoded");
});

test("a skin slow to decode doesn't hold the map up for more than 1.5 s", async () => {
  reset(); await skin({ "soft-hitnormal": "skin:sn" }, true);
  run("S.hsSrc = 'beatmap'; files = {}; osuFiles = []; SK.sndP = new Promise(() => {})"); // (a decode that never ends)
  const t0 = Date.now(); await run("loadMapSamples()");
  const dt = Date.now() - t0;
  assert.ok(dt >= 1400 && dt < 3000, "waited " + dt + " ms");
});

test("playEvent looks the timing point up at the event's nominal time (nt) when it has one", () => {
  reset(); run("map = { timing: [{ time: 0, sampleSet: 2, sampleIndex: 0, volume: 100 }, { time: 5500, sampleSet: 3, sampleIndex: 0, volume: 100 }], defSet: 1, sounds: [], hit: [] }");
  const play = e => { W.started.length = 0; T.e = e; run("playEvent(T.e, 0)"); return W.started.map(b => b.tag); };
  assert.deepEqual(play({ t: 5600, hs: 0, n: 0, a: 0, i: 0, v: 0, f: "" }), ["def:drum-hitnormal"], "no nt: its own time");
  assert.deepEqual(play({ t: 5600, nt: 5400, hs: 0, n: 0, a: 0, i: 0, v: 0, f: "" }), ["def:soft-hitnormal"], "a late press: the object's own time decides");
});

// ---- a watched replay's combo break (js/replayana.js rpSoundEvents -> js/audio.js playEvent): the skin's combobreak > osu! default's, never a drawn tone
const cbPlay = () => { run("map = { timing: [{ time: 0, sampleSet: 1, sampleIndex: 0, volume: 50 }], defSet: 1 }"); W.started.length = 0; run("playEvent({ t: 900, nt: 900, combobreak: true, hs: 0, tick: false }, 0)"); run("map = null"); return W.started.map(b => b.tag); };
const seedCb = () => { T.b = buf("def:combobreak"); run("defBank.combobreak = T.b"); };

test("combobreak: the skin's own file (decoded like the hitsounds) plays before osu! default's, with the setting on", async () => {
  reset(); seedCb();
  assert.deepEqual(cbPlay(), ["def:combobreak"], "no skin sounds: the default sample");
  const sk = await skin({ "combobreak": "skin:cb", "normal-hitnormal": "skin:nh" }, true);
  assert.deepEqual(cbPlay(), ["def:combobreak"], "not decoded yet: the default, and the decode starts");
  await sk.sndP;
  assert.deepEqual(cbPlay(), ["skin:cb"]);
  run("S.skinSounds = false"); assert.deepEqual(cbPlay(), ["def:combobreak"], "the setting off: only the default");
});

test("combobreak: a blank skin file mutes it (as in osu!); a file this browser can't decode, or a skin without one, falls back to the default", async () => {
  reset(); seedCb(); await skin({ "combobreak": "blank" }); assert.deepEqual(cbPlay(), [], "blank: the skin mutes it");
  await skin({ "combobreak": "empty" }); assert.deepEqual(cbPlay(), [], "decodes to no samples: muted too");
  await skin({ "combobreak": "bad" }); assert.deepEqual(cbPlay(), ["def:combobreak"], "undecodable");
  await skin({ "normal-hitnormal": "skin:nh" }); assert.deepEqual(cbPlay(), ["def:combobreak"], "none in the skin");
});

test("combobreak: no skin sample and no default sample (not fetched, or failed): silent, never the drawn tone; Hitsound source Off: silent", async () => {
  reset(); assert.equal(run("defBank.combobreak"), undefined);
  assert.deepEqual(cbPlay(), [], "not loaded");
  run("defBank.combobreak = null"); assert.deepEqual(cbPlay(), [], "failed");
  assert.equal(run("comboBreakBuf()"), null);
  seedCb(); run("S.hsSrc = 'off'"); assert.deepEqual(cbPlay(), [], "Off");
  run("S.hsSrc = 'default'"); assert.deepEqual(cbPlay(), ["def:combobreak"], "Default / From the map: plays");
  run("S.hsSrc = 'beatmap'"); assert.deepEqual(cbPlay(), ["def:combobreak"]);
});

test("combobreak: the skin keeps/decodes combobreak and the plain hitsounds are unaffected", async () => {
  reset(); seedCb(); await skin({ "combobreak": "skin:cb", "soft-hitclap": "skin:sc" });
  assert.equal(pick("soft", "hitclap", 1), "skin:sc");
  assert.equal(pick("normal", "hitnormal", 1), "def:normal-hitnormal");
  assert.deepEqual(cbPlay(), ["skin:cb"]);
});
