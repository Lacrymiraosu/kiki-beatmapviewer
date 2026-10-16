// Skins (js/skins.js) and the Settings → Skin values (js/core.js): skin.ini parsing, animations, the settings-aware getters the
// renderer uses, the import report, the SHA-256 dedupe helper, and the validation of the new settings keys.
// js/skins.js runs in a Node vm with a no-op canvas and a fake createImageBitmap; core.js's validator is cut out of the source
// (the file itself needs a whole page).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadScripts, J } from "./lib/browser.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(join(root, p), "utf8");

// ---------- a page just big enough for skins.js ----------
const canvasStub = () => {
  const fn = new Proxy(function () {}, {
    get: (t, k) => k === "measureText" ? () => ({ width: 10 }) : /^create(Radial|Linear)Gradient$/.test(k) ? () => ({ addColorStop() {} }) : k === "canvas" ? el : t[k] !== undefined ? t[k] : () => undefined,
    set: () => true,
  });
  const el = { width: 0, height: 0, getContext: () => fn, isConnected: false, classList: { add() {} } };
  return el;
};
const fakeEl = () => ({ getContext: () => canvasStub().getContext(), style: {}, setAttribute() {}, classList: { add() {} } });
const EXTRA = `
const DEFAULT_COLS = [[255, 192, 0], [0, 202, 0], [18, 124, 255], [242, 24, 57]];
const DEF = { skin: "default", skinCombo: "map", curSize: 1, curTrail: true, curRotate: "skin", curExpand: "skin", ballTint: "skin", ballFlip: "skin", hcOverlay: "skin", hcNumbers: true, elBurst: true, elApproach: true, objOpacity: 1, homeSkin: false, skinAnim: true, skinSounds: true };
const S = { ...DEF };
let dirty = false, toasts = [];
const save = () => {};
const $ = () => T$.el(), h = (tag, cls, text) => ({ tag, cls, text }), tr = (s, o) => String(s).replace(/\\{(\\w+)\\}/g, (_, k) => o && k in o ? o[k] : "{" + k + "}");
const toast = t => toasts.push(t), fileAccept = i => i, fileIs = () => true, rgb = c => "rgb(" + c.join(",") + ")", mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const fmtBytes = b => b >= 1048576 ? (b / 1048576).toFixed(2) + " MB" : Math.round(b / 1024) + " KB", showLoading = () => {}, hideLoading = () => {}, downloadBlob = () => {}, ask = async () => true, loadJSZip = async () => T$.zip || null;
const document = { createElement: () => T$.el(), querySelectorAll: () => [], fonts: null };
const window = {}, addEventListener = () => {};
`;
const T$ = { el: fakeEl };
// ImageBitmap stand-in: { width, height } from the blob's tag, close() counted
const closed = [];
const createImageBitmap = async b => ({ width: b.w || 64, height: b.h || 64, tag: b.tag, close() { closed.push(this.tag); } });
const P = loadScripts(["js/skins.js"], EXTRA, { T$, createImageBitmap, indexedDB: undefined, setTimeout, clearTimeout, IntersectionObserver: undefined });
const run = code => P[code]; // evaluate in the page's scope
const E = (name, ...args) => { T$.args = args; return P[`${name}(...T$.args)`]; };

// a skin built from names -> images: idx["hitcircle"] = one image; "hit300-0".. = animation frames
const entry = (tag, hd = 1, w = 64) => ({ get: async () => ({ tag, w, h: w }), hd, depth: 0 });
const build = async (files, iniText = "", alias, prefix = "") => { // (prefix: put in front of the image tags, to tell skins apart)
  const idx = {}; for (const f of files) idx[f] = entry(prefix + f);
  T$.idx = idx; T$.ini = P["parseIni"](iniText); T$.alias = alias || {};
  const sk = await P["buildSkin('t', 'T', T$.idx, T$.ini, T$.alias)"];
  return sk;
};
const use = (sk, def = null) => { T$.sk = sk; T$.def = def; run("SK = T$.sk; DEFSK = T$.def"); };
const setS = o => { T$.o = o; run("Object.assign(S, T$.o)"); };
const resetS = () => run("Object.assign(S, DEF)");

// ---------- skin.ini ----------
test("parseIni: sections, comments, BOM, CRLF", () => {
  const o = J(P["parseIni"]("﻿[General]\r\nName: My Skin // note\r\nAuthor: Someone\r\n\r\n[Colours]\r\nCombo1: 1,2,3\r\n[Fonts]\r\nHitCircleOverlap:-3"));
  assert.deepEqual(o, { General: { Name: "My Skin", Author: "Someone" }, Colours: { Combo1: "1,2,3" }, Fonts: { HitCircleOverlap: "-3" } });
});

test("buildSkin: Name / Author / Version and the skin.ini values the renderer uses", async () => {
  const sk = await build(["hitcircle", "cursor"], "[General]\nName: Cool\nAuthor: Mei\nVersion: 2.5\nAnimationFramerate: 30\nSliderBallFlip: 0\nCursorTrailRotate: 1\nSpinnerNoBlink: 1\nSpinnerFadePlayfield: 1\nCursorRotate: 0\nCursorExpand: 0\nCursorCentre: 0\nAllowSliderBallTint: 1\nHitCircleOverlayAboveNumber: 0\n[Colours]\nCombo1: 255,128,0\nCombo2: 1, 2, 3\nCombo3: nope\nSpinnerBackground: 10,20,30\nSliderBorder: 5,6,7\n");
  assert.deepEqual(J(sk.meta), { name: "Cool", author: "Mei", version: "2.5" });
  assert.equal(sk.animFps, 30);
  assert.equal(sk.ballFlip, false);
  assert.equal(sk.cursorTrailRotate, true);
  assert.equal(sk.spinnerNoBlink, true);
  assert.equal(sk.spinnerFadePlayfield, true);
  assert.deepEqual(J(sk.spinnerBackground), [10, 20, 30]);
  assert.equal(sk.cursorRotate, false); assert.equal(sk.cursorExpand, false); assert.equal(sk.cursorCentre, false);
  assert.equal(sk.tintBall, true); assert.equal(sk.overlayAbove, false);
  assert.deepEqual(J(sk.colors), [[255, 128, 0], [1, 2, 3]], "a broken colour is left out");
  assert.deepEqual(J(sk.borderColor), [5, 6, 7]);
  assert.equal(sk.ini.animFps, 30, "the parsed values are also on sk.ini");
  assert.equal(sk.ini.General.Author, "Mei", "next to the raw sections");
});

test("buildSkin: osu!'s defaults when skin.ini is silent, absent, or in odd case", async () => {
  for (const ini of ["", "[General]\nName: x", "[Colours]\nCombo1: 1,2,3"]) {
    const sk = await build(["cursor"], ini);
    assert.equal(sk.animFps, -1); assert.equal(sk.ballFlip, true, "SliderBallFlip defaults to 1"); assert.equal(sk.cursorTrailRotate, false);
    assert.equal(sk.spinnerNoBlink, false); assert.equal(sk.spinnerFadePlayfield, false); assert.equal(sk.spinnerBackground, null);
    assert.equal(sk.cursorRotate, true); assert.equal(sk.cursorExpand, true); assert.equal(sk.overlayAbove, true); assert.equal(sk.tintBall, false);
  }
  const sk = await build([], "");
  assert.deepEqual(J(sk.meta), { name: "", author: "", version: "" });
  const lc = await build([], "[general]\nanimationframerate: 12\nsliderballflip: 0");
  assert.equal(lc.animFps, 12); assert.equal(lc.ballFlip, false, "section and key are matched without regard to case");
  for (const bad of ["0", "-5", "abc", ""]) assert.equal((await build([], "[General]\nAnimationFramerate: " + bad)).animFps, -1, "AnimationFramerate " + bad);
  assert.equal((await build([], "[General]\nAnimationFramerate: -1")).animFps, -1);
  assert.equal((await build([], "[General]\nSpinnerBackground: 1,2")).spinnerBackground, null);
  assert.deepEqual(J((await build([], "[Colours]\nSpinnerBackground: 300,-4,7.4")).spinnerBackground), [255, 0, 7]);
});

test("the drawn fallback skin has the same fields", () => {
  const f = J(P["FALLBACK"]);
  for (const k of ["meta", "animFps", "ballFlip", "cursorTrailRotate", "spinnerNoBlink", "spinnerFadePlayfield", "spinnerBackground", "cursorExpand", "tintBall"]) assert.ok(k in f, k);
  assert.equal(typeof P["FALLBACK.texFrame"], "function");
});

// ---------- animations ----------
test("new elements are loaded when present, an animation also gives texOf its first frame", async () => {
  const sk = await build(["hit100k", "hit300k", "hit300g", "cursor-ripple", "cursor-smoke", "inputoverlay-background", "inputoverlay-key", "sliderpoint30", "particle50", "particle100", "particle300", "hit0-0", "hit0-1", "hit0-2"]);
  for (const k of ["hit100k", "hit300k", "hit300g", "cursor-ripple", "cursor-smoke", "inputoverlay-background", "inputoverlay-key", "sliderpoint30", "particle50", "particle100", "particle300"]) assert.equal(sk.tex[k].img.tag, k, k);
  assert.equal(sk.tex.hit0.img.tag, "hit0-0", "only an animation: texOf is frame 0");
  assert.equal(sk.anim.hit0.length, 3);
  assert.equal(sk.anim.hit100k, undefined);
});

test("a plain image wins texOf over name-0, the frames stay available", async () => {
  const sk = await build(["approachcircle", "approachcircle-0", "approachcircle-1"]);
  assert.equal(sk.tex.approachcircle.img.tag, "approachcircle");
  assert.deepEqual(sk.texFrames("approachcircle").map(f => f.img.tag), ["approachcircle-0", "approachcircle-1"]);
  assert.deepEqual(J(sk.texFrames("hitcircle")), []);
});

test("frames stop at the first gap and are capped", async () => {
  const gap = await build(["hit50-0", "hit50-1", "hit50-3"]);
  assert.equal(gap.anim.hit50.length, 2);
  const many = await build(Array.from({ length: 300 }, (_, i) => "followpoint-" + i));
  assert.equal(many.anim.followpoint.length, 120);
});

test("texFrame loops at AnimationFramerate / the given fps, hit bursts play once at 60 fps", async () => {
  resetS();
  const sk = await build(["hitcircleoverlay-0", "hitcircleoverlay-1", "hitcircleoverlay-2", "hit300-0", "hit300-1", "hit300-2", "hit300-3", "approachcircle", "followpoint-0", "followpoint-1", "followpoint-2", "followpoint-3"], "[General]\nAnimationFramerate: 10");
  use(sk);
  const tag = (...a) => { T$.a = a; const f = P["texFrame(...T$.a)"]; return f && f.img.tag; };
  // the skin's AnimationFramerate (10 fps, 3 frames)
  assert.deepEqual([0, 99, 100, 199, 200, 299, 300, 400, 650].map(t => tag("hitcircleoverlay", t)), ["hitcircleoverlay-0", "hitcircleoverlay-0", "hitcircleoverlay-1", "hitcircleoverlay-1", "hitcircleoverlay-2", "hitcircleoverlay-2", "hitcircleoverlay-0", "hitcircleoverlay-1", "hitcircleoverlay-0"]);
  assert.equal(tag("hitcircleoverlay", -100), "hitcircleoverlay-2", "before 0 it still loops");
  // an explicit fps wins
  assert.equal(tag("hitcircleoverlay", 500, 2), "hitcircleoverlay-1");
  assert.equal(tag("hitcircleoverlay", 500, 4), "hitcircleoverlay-2");
  // hit bursts: 60 fps, once, the last frame stays
  assert.deepEqual([0, 16, 17, 34, 50, 51, 1000].map(t => tag("hit300", t)), ["hit300-0", "hit300-0", "hit300-1", "hit300-2", "hit300-3", "hit300-3", "hit300-3"]);
  assert.equal(tag("hit300", 5000, 60, false), "hit300-0", "once = false loops it (300 frames in, 4 frames)");
  assert.equal(tag("followpoint", 5000, 1000, true), "followpoint-3", "once = true holds the last frame");
  // no frames: the plain image; unknown name: null
  assert.equal(tag("approachcircle", 123), "approachcircle");
  assert.equal(P["texFrame('nothing-like-this', 5)"], null);
  assert.deepEqual(J(P["texFrames('approachcircle')"]), []);
  assert.equal(P["texFrames('hit300')"].length, 4);
  use(null);
});

test("AnimationFramerate -1 plays all the frames in one second; skinAnim off = the first frame", async () => {
  resetS();
  const sk = await build(["followpoint-0", "followpoint-1", "followpoint-2", "followpoint-3"]);
  use(sk);
  const tag = (t, fps) => { T$.a = ["followpoint", t, fps]; return P["texFrame(...T$.a)"].img.tag; };
  assert.deepEqual([0, 249, 250, 500, 750, 999, 1000].map(t => tag(t)), ["followpoint-0", "followpoint-0", "followpoint-1", "followpoint-2", "followpoint-3", "followpoint-3", "followpoint-0"]);
  setS({ skinAnim: false });
  assert.equal(tag(750), "followpoint-0");
  assert.equal(P["texFrames('followpoint')"].length, 4, "texFrames stays the raw list");
  resetS(); use(null);
});

test("texFrame falls back to osu! default's frames when the chosen skin lacks the element", async () => {
  resetS();
  const own = await build(["hitcircle"]), def = await build(["hit0-0", "hit0-1"], "[General]\nAnimationFramerate: 2");
  use(own, def);
  assert.equal(P["texFrame('hit0', 0)"].img.tag, "hit0-0");
  assert.equal(P["texFrames('hit0')"].length, 2);
  assert.equal(P["texFrame('hitcircle', 0)"].img.tag, "hitcircle");
  use(null);
});

// ---------- settings-aware getters ----------
test("skinOpt: on / off override, skin = the value of the skin that supplies the part", async () => {
  resetS();
  const own = await build(["cursor", "sliderb0"], "[General]\nAllowSliderBallTint: 1\nSliderBallFlip: 0\nCursorRotate: 0\nCursorExpand: 0\nHitCircleOverlayAboveNumber: 0");
  const def = await build(["cursor", "sliderb0"], "[General]\nSliderBallFlip: 1\nCursorRotate: 1\nCursorExpand: 1");
  use(own, def);
  const o = (k, sk) => { T$.a = [k]; return P["skinOpt(...T$.a)"]; };
  assert.equal(o("ballTint"), true); assert.equal(o("ballFlip"), false); assert.equal(o("curRotate"), false); assert.equal(o("curExpand"), false); assert.equal(o("hcOverlay"), false);
  setS({ ballTint: "off", ballFlip: "on", curRotate: "on", curExpand: "on", hcOverlay: "above" });
  assert.equal(o("ballTint"), false); assert.equal(o("ballFlip"), true); assert.equal(o("curRotate"), true); assert.equal(o("curExpand"), true); assert.equal(o("hcOverlay"), true);
  setS({ ballTint: "on", hcOverlay: "below" });
  assert.equal(o("ballTint"), true); assert.equal(o("hcOverlay"), false);
  resetS();
  // a skin with no cursor / no ball: osu! default's values, like the player picks them
  const bare = await build(["hitcircle"], "[General]\nCursorRotate: 0\nCursorExpand: 0\nSliderBallFlip: 0\nAllowSliderBallTint: 0");
  use(bare, def);
  assert.equal(o("curRotate"), true, "no cursor image: default's CursorRotate"); assert.equal(o("curExpand"), true); assert.equal(o("ballFlip"), true);
  assert.equal(o("ballTint"), !!def.tintBall);
  use(bare, null);
  assert.equal(o("curRotate"), false, "nothing loaded: the drawn fallback"); assert.equal(o("curExpand"), true); assert.equal(o("ballTint"), true); assert.equal(o("ballFlip"), true);
  // asking about one skin
  T$.a = ["ballFlip", own]; assert.equal(P["skinOpt(...T$.a)"], false);
  use(null);
});

test("comboColours: the map's unless Combo colours says skin", async () => {
  resetS();
  const sk = await build([], "[Colours]\nCombo1: 9,9,9\nCombo2: 8,8,8"), plain = await build([], "");
  const map = [[1, 1, 1], [2, 2, 2], [3, 3, 3]], cc = m => { T$.a = [m]; return J(P["comboColours(...T$.a)"]); };
  use(sk, plain);
  assert.deepEqual(cc(map), map);
  assert.deepEqual(cc([]), [[9, 9, 9], [8, 8, 8]], "no map colours: the skin's");
  assert.deepEqual(cc(null), [[9, 9, 9], [8, 8, 8]]);
  setS({ skinCombo: "skin" });
  assert.deepEqual(cc(map), [[9, 9, 9], [8, 8, 8]], "skin wins");
  use(plain, plain);
  assert.deepEqual(cc(map), J(P["DEFAULT_COLS"]), "a skin without colours: osu! default's");
  resetS(); assert.deepEqual(cc([]), J(P["DEFAULT_COLS"]));
  use(null);
});

test("palette follows comboColours", async () => {
  resetS();
  const sk = await build([], "[Colours]\nCombo1: 9,9,9\nCombo2: 8,8,8");
  use(sk, null);
  run("map = { hasColours: true, colours: [[1, 1, 1], [2, 2, 2]] }");
  assert.deepEqual(J(P["palette(3)"]), [2, 2, 2]);
  setS({ skinCombo: "skin" });
  assert.deepEqual(J(P["palette(3)"]), [8, 8, 8]);
  assert.deepEqual(J(P["palette(-1)"]), [8, 8, 8]);
  run("map = { hasColours: false, colours: [] }"); resetS();
  assert.deepEqual(J(P["palette(0)"]), [9, 9, 9]);
  run("map = null"); use(null);
});

// ---------- import report ----------
test("skinMissing lists what osu! default has to supply", async () => {
  const full = ["hitcircle", "hitcircleoverlay", "approachcircle", "sliderfollowcircle", "reversearrow", "sliderscorepoint", "followpoint", "cursor", "cursortrail", "lighting", "hit300", "hit100", "hit50", "hit0", "sliderb0", "spinner-circle", ...[...Array(10).keys()].map(i => "default-" + i)];
  assert.deepEqual(J(E("skinMissing", await build(full))), []);
  const some = await build(full.filter(f => f !== "approachcircle" && f !== "hit0" && f !== "default-3" && f !== "sliderb0" && f !== "spinner-circle"));
  assert.deepEqual(J(E("skinMissing", some)), ["approachcircle", "hit0", "sliderb", "default-0…9", "spinner"]);
  const empty = J(E("skinMissing", await build([])));
  assert.ok(empty.includes("hitcircle") && empty.includes("sliderb") && empty.includes("spinner") && empty.includes("sliderscorepoint"));
  // the optional parts and the old / new spinner choice are not reported
  assert.deepEqual(J(E("skinMissing", await build(full.filter(f => f !== "spinner-circle").concat(["spinner-top"])))), []);
  assert.deepEqual(J(E("skinMissing", await build(full.filter(f => f !== "sliderscorepoint").concat(["sliderpoint10"])))), []);
  assert.deepEqual(J(E("skinMissing", await build(full.filter(f => f !== "default-0").concat(["score-0"]), "[Fonts]\nHitCirclePrefix: score"))), ["score-0…9"], "numbers use the HitCirclePrefix");
  assert.deepEqual(J(E("skinMissing", await build(full, "", {}))), []);
  // the retro skin's alias for sliderscorepoint
  assert.deepEqual(J(E("skinMissing", await build(full.filter(f => f !== "sliderscorepoint").concat(["sliderpoint10"]), "", { sliderscorepoint: "sliderpoint10" }))), []);
});

test("skinMissingText is short", async () => {
  const t = E("skinMissingText", await build([]));
  assert.match(t, /^hitcircle, hitcircleoverlay, approachcircle, sliderfollowcircle, reversearrow, followpoint \+\d+$/);
  assert.equal(E("skinMissingText", await build(["hitcircle", "hitcircleoverlay", "approachcircle", "sliderfollowcircle", "reversearrow", "followpoint", "cursor", "cursortrail", "lighting", "hit300", "hit100", "hit50", "hit0", "sliderb0", "sliderscorepoint", "spinner-circle", ...[...Array(10).keys()].map(i => "default-" + i)])), "");
});

// ---------- dedupe by hash ----------
test("skinHash is the SHA-256 of the bytes (Blob, File, ArrayBuffer, typed array alike)", async () => {
  const bytes = randomBytes(5000), want = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await E("skinHash", new Blob([bytes])), want);
  assert.equal(await E("skinHash", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), want);
  assert.equal(await E("skinHash", bytes), want, "a Buffer is a view");
  assert.equal(await E("skinHash", new Uint8Array(bytes.buffer, bytes.byteOffset + 10, 100)), createHash("sha256").update(bytes.subarray(10, 110)).digest("hex"), "a view with an offset");
  assert.equal(await E("skinHash", new Blob([])), createHash("sha256").update("").digest("hex"));
  assert.equal(await E("skinHash", new Blob(["abc"])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  await assert.rejects(E("skinHash", 42));
});

test("skinDup finds a stored skin by hash, and hashes an old one only when the size matches", async () => {
  const a = randomBytes(300), b = randomBytes(300), c = randomBytes(301);
  const hex = x => createHash("sha256").update(x).digest("hex");
  let puts = 0; T$.put = () => puts++;
  run("idb.put = async () => T$.put()");
  const rec = (id, bytes, hash) => ({ id, name: id, blob: new Blob([bytes]), hash });
  const saved = [rec("one", c, hex(c)), rec("two", b), rec("three", a)];
  T$.saved = saved; T$.h = hex(a); T$.size = 300;
  const hit = await P["skinDup(T$.saved, T$.h, T$.size)"];
  assert.equal(hit.id, "three");
  assert.equal(saved[1].hash, hex(b), "the same-size record without a hash got one");
  assert.equal(saved[2].hash, hex(a));
  assert.equal(puts, 2, "and was stored again");
  assert.equal(await P["skinDup(T$.saved, 'x'.repeat(64), 300)"], null);
  // a record with a hash is trusted: its blob is not read
  const trap = { id: "t", name: "t", hash: "deadbeef", get blob() { throw new Error("blob read"); } };
  T$.saved = [trap]; assert.equal(await P["skinDup(T$.saved, 'x', 5)"], null);
  assert.equal((await P["skinDup(T$.saved, 'deadbeef', 5)"]).id, "t");
  // another size: not even hashed
  T$.saved = [{ id: "z", name: "z", blob: { size: 10, arrayBuffer() { throw new Error("read"); } } }]; assert.equal(await P["skinDup(T$.saved, 'q', 11)"], null);
});

test("limits: 64 MB per file, 12 skins", () => {
  assert.equal(run("SKIN_MAX_BYTES"), 64 * 1024 * 1024);
  assert.equal(run("SKIN_MAX_COUNT"), 12);
});

test("importOsk refuses a skin over 64 MB before reading it, and a 13th skin", async () => {
  run("toasts.length = 0");
  const big = { size: 80 * 1024 * 1024, name: "big.osk", arrayBuffer() { throw new Error("must not be read"); } };
  T$.f = big; await P["importOsk(T$.f)"];
  assert.match(P["toasts[0]"], /too big \(80 MB\)\. The limit is 64 MB/);
  run("toasts.length = 0");
  const saved = Array.from({ length: 12 }, (_, i) => ({ id: "s" + i, name: "s" + i, blob: new Blob([String(i)]), hash: "h" + i, added: i }));
  T$.saved = saved; run("idb.all = async () => T$.saved; renderSkinUI = async () => {}");
  T$.f = new Blob(["a new skin"]); T$.f.name = "x.osk";
  await P["importOsk(T$.f)"];
  assert.match(P["toasts[0]"], /up to 12 skins on this device/, P["toasts"].join("|"));
});

test("importOsk of a skin you already have selects the stored one", async () => {
  run("toasts.length = 0");
  const bytes = randomBytes(40), hash = createHash("sha256").update(bytes).digest("hex");
  T$.saved = [{ id: "old", name: "Old name", blob: new Blob([bytes]), hash, added: 1 }];
  run("idb.all = async () => T$.saved; renderSkinUI = async () => {}; T$.picked = []; selectSkin = async id => { T$.picked.push(id); }");
  T$.f = new Blob([bytes]); T$.f.name = "same.osk";
  await P["importOsk(T$.f)"];
  assert.deepEqual(J(T$.picked), ["osk:old"]);
  assert.match(P["toasts[0]"], /Already imported: using "Old name"/);
});

// ---------- cache release ----------
test("releasing a skin drops it from the cache and closes its images, never the chosen skin or osu! default", async () => {
  closed.length = 0;
  const mk = async name => { const s = await build(["hitcircle", "cursor"], "", {}, name + ":"); s.id = name; return s; };
  const sel = await mk("selected"), def = await mk("dflt"), other = await mk("other");
  use(sel, def);
  T$.c = { default: Promise.resolve(def), "osk:sel": Promise.resolve(sel), "osk:other": Promise.resolve(other) };
  run("for (const k of Object.keys(skinCache)) delete skinCache[k]; Object.assign(skinCache, T$.c); S.skin = 'osk:sel'; skinWant = ''");
  sel.id = "osk:sel"; other.id = "osk:other";
  run("releaseSkins()");
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(Object.keys(J(P["skinCache"])).sort(), ["default", "osk:sel"]);
  assert.ok(closed.some(t => t.startsWith("other")), "the other skin's images were closed");
  assert.ok(!closed.some(t => t.startsWith("selected") || t.startsWith("dflt")), "the chosen skin and the default are kept");
  run("S.skin = 'default'"); use(null);
});

// a card's preview loads its skin while a skin is picked or imported (releaseSkins): the skin must not be closed under it (a blank preview, kept)
test("a skin card's preview is drawn from a skin that releaseSkins could not close meanwhile, then the skin is let go", async () => {
  closed.length = 0;
  const mk = async name => { const s = await build(["hitcircle", "cursor"], "", {}, name + ":"); s.id = name; return s; };
  const sel = await mk("osk:sel"), def = await mk("default"), pv = await mk("osk:pv");
  use(sel, def);
  let release; T$.pend = new Promise(r => { release = r; });
  T$.c = { default: Promise.resolve(def), "osk:sel": Promise.resolve(sel), "osk:pv": T$.pend };
  run("for (const k of Object.keys(skinCache)) delete skinCache[k]; Object.assign(skinCache, T$.c); S.skin = 'osk:sel'; skinWant = ''; idb.all = async () => []; skinPv.clear()");
  T$.cls = []; T$.cv = { width: 0, height: 0, isConnected: true, getContext: () => canvasStub().getContext(), classList: { add: c => T$.cls.push(c) } };
  run("skinPreview('osk:pv', T$.cv)");
  await new Promise(r => setTimeout(r, 5));
  assert.equal(P["pvHold.has('osk:pv')"], true, "held while it loads");
  run("releaseSkins()"); // (what picking or importing another skin does)
  assert.ok("osk:pv" in J(P["skinCache"]), "not released while the preview needs it");
  release(pv); await new Promise(r => setTimeout(r, 20));
  assert.equal(P["skinPv.has('osk:pv')"], true, "the preview was drawn and kept");
  assert.deepEqual(T$.cls, ["ready"]);
  assert.equal(P["pvHold.size"], 0);
  assert.ok(!("osk:pv" in J(P["skinCache"])), "let go afterwards");
  assert.ok(closed.some(t => t.startsWith("osk:pv:")) && pv.sndDead === true, "its images are closed after the drawing");
  assert.ok(!closed.some(t => t.startsWith("osk:sel:") || t.startsWith("default:")), "the chosen skin and the default are kept");
  // a closed skin handed to the preview is not kept as a blank picture
  T$.dead = await mk("osk:dead"); T$.dead.sndDead = true; T$.cls = [];
  run("skinCache['osk:dead'] = Promise.resolve(T$.dead); skinPreview('osk:dead', T$.cv)"); await new Promise(r => setTimeout(r, 20));
  assert.equal(P["skinPv.has('osk:dead')"], false); assert.deepEqual(T$.cls, ["failed"]);
  run("S.skin = 'default'; skinPv.clear(); for (const k of Object.keys(skinCache)) delete skinCache[k]"); use(null);
});

// ---------- the settings in core.js ----------
const coreSrc = read("js/core.js");
const defText = coreSrc.slice(coreSrc.indexOf("const DEF = {"), coreSrc.indexOf("const FPS_OPTS"));
const optsText = coreSrc.slice(coreSrc.indexOf("//<skin-opts>"), coreSrc.indexOf("//</skin-opts>"));
const core = (() => { const c = vm.createContext({ Math, Number, Object, JSON }); vm.runInContext(defText + optsText + "\nthis.out = { DEF, SKIN_OPTS, cleanSkinOpts };", c); return c.out; })();
const KEYS = ["skinCombo", "curSize", "curTrail", "curRotate", "curExpand", "ballTint", "ballFlip", "hcOverlay", "hcNumbers", "elBurst", "elApproach", "objOpacity", "homeSkin", "skinAnim", "skinSounds"];

test("core.js: the contract's keys exist in DEF with the contract's defaults", () => {
  assert.deepEqual(Object.keys(core.SKIN_OPTS).sort(), [...KEYS].sort());
  const want = { skinCombo: "map", curSize: 1, curTrail: true, curRotate: "skin", curExpand: "skin", ballTint: "skin", ballFlip: "skin", hcOverlay: "skin", hcNumbers: true, elBurst: true, elApproach: true, objOpacity: 1, homeSkin: false, skinAnim: true, skinSounds: true };
  for (const k of KEYS) assert.deepEqual(core.DEF[k], want[k], k);
  const o = { ...core.DEF }; core.cleanSkinOpts(o); assert.deepEqual(J(o), J(core.DEF), "the defaults are valid");
});

test("core.js: cleanSkinOpts clamps numbers, fixes words and switches, and leaves other settings alone", () => {
  const c = o => J(core.cleanSkinOpts({ ...core.DEF, ...o }));
  assert.equal(c({ curSize: 0 }).curSize, .5); assert.equal(c({ curSize: 9 }).curSize, 2); assert.equal(c({ curSize: 1.37 }).curSize, 1.35); assert.equal(c({ curSize: "1.5" }).curSize, 1.5);
  assert.equal(c({ curSize: "abc" }).curSize, 1); assert.equal(c({ curSize: NaN }).curSize, 1); assert.equal(c({ curSize: null }).curSize, 1); assert.equal(c({ curSize: Infinity }).curSize, 1); assert.equal(c({ curSize: "" }).curSize, 1);
  assert.equal(c({ objOpacity: .1 }).objOpacity, .3); assert.equal(c({ objOpacity: 5 }).objOpacity, 1); assert.equal(c({ objOpacity: .55 }).objOpacity, .55); assert.equal(c({ objOpacity: -3 }).objOpacity, .3);
  assert.equal(c({ curRotate: "maybe" }).curRotate, "skin"); assert.equal(c({ curRotate: "on" }).curRotate, "on"); assert.equal(c({ curRotate: true }).curRotate, "skin");
  assert.equal(c({ hcOverlay: "on" }).hcOverlay, "skin", "hcOverlay takes above / below, not on / off"); assert.equal(c({ hcOverlay: "below" }).hcOverlay, "below");
  assert.equal(c({ skinCombo: "both" }).skinCombo, "map"); assert.equal(c({ skinCombo: "skin" }).skinCombo, "skin");
  assert.equal(c({ curTrail: "yes" }).curTrail, true); assert.equal(c({ curTrail: 0 }).curTrail, true); assert.equal(c({ curTrail: false }).curTrail, false);
  assert.equal(c({ homeSkin: "true" }).homeSkin, false); assert.equal(c({ homeSkin: true }).homeSkin, true);
  const o = core.cleanSkinOpts({ skin: "osk:x", fps: 60, curSize: 7 }); assert.equal(o.skin, "osk:x"); assert.equal(o.fps, 60); assert.equal(o.curSize, 2);
  const missing = core.cleanSkinOpts({}); for (const k of KEYS) assert.deepEqual(missing[k], core.DEF[k], "missing " + k);
});

test("core.js and account.js: validated on load and after the account's settings arrive, synced like the other display settings", () => {
  assert.match(coreSrc, /Object\.assign\(S, savedS\);\s*cleanSkinOpts\(S\);/);
  const acct = read("js/account.js");
  assert.match(acct, /S\[k\] = v;[^\n]*\n\s*cleanSkinOpts\(S\);/);
  const local = acct.match(/const PREFS_LOCAL = new Set\(\[([^\]]*)\]/)[1];
  for (const k of KEYS) assert.ok(!local.includes('"' + k + '"'), k + " is not device-local");
  assert.match(acct, /!\(k === "skin" && \/\^osk:\/\.test\(v\)\)/, "a skin from a file is not taken from the account");
});

test("index.html: every key has a control in the Skin pane", () => {
  const html = read("index.html"), pane = html.slice(html.indexOf('data-pane="skin"'), html.indexOf('data-pane="test"'));
  for (const k of KEYS) assert.ok(pane.includes(`data-sk="${k}"`) || pane.includes(`data-k="${k}"`), k);
  for (const g of ["Colours", "Cursor", "Slider", "Circles", "Objects", "Animations", "Home"]) assert.ok(pane.includes(`<div class="subh" data-i18n="${g}">`), g);
  assert.ok(pane.includes('id="skinOptReset"'));
  assert.ok(pane.includes('id="skinBox"'));
  // the on/off ones are the switches player.js handles (data-k), the rest are skins.js's (data-sk)
  for (const k of KEYS) { const sw = new RegExp(`type="checkbox" class="switch" data-k="${k}"`).test(pane), bool = typeof core.DEF[k] === "boolean"; assert.equal(sw, bool, k); }
});

// ---------- hitsounds in a skin (the loader keeps the bytes; js/audio.js decodes and plays them: skinsound.test.mjs) ----------
const sndList = paths => paths.map(p => typeof p === "string" ? { path: p, depth: p.split("/").length, get: async () => new Blob(["x".repeat(200)]), size: 200 } : p);
const sIdx = paths => { T$.l = sndList(paths); return P["indexSounds(T$.l)"]; };

test("indexSounds: the hitsound names the site plays, any case, wav / ogg / mp3, custom index 2+", () => {
  const idx = sIdx(["Normal-HitNormal.WAV", "soft-hitwhistle.ogg", "drum-hitclap2.mp3", "drum-hitfinish10.wav", "soft-slidertick.wav", "normal-hitclap3.Ogg"]);
  assert.deepEqual(Object.keys(J(idx)).sort(), ["drum-hitclap2", "drum-hitfinish10", "normal-hitclap3", "normal-hitnormal", "soft-hitwhistle", "soft-slidertick"]);
});

test("indexSounds: keeps the skin's combobreak (any case, wav / ogg / mp3, the shallowest folder, wav before ogg before mp3)", () => {
  const idx = sIdx(["Combobreak.WAV", "sounds/combobreak.ogg", "soft-hitclap.wav"]);
  assert.deepEqual(Object.keys(J(idx)).sort(), ["combobreak", "soft-hitclap"]);
  assert.equal(P["indexSounds(T$.l)"].combobreak.ext, 0);
  const deep = sIdx(["a/combobreak.wav", "combobreak.mp3"]);
  assert.equal(deep.combobreak.depth, 1); assert.equal(deep.combobreak.ext, 2, "the shallower folder wins over the better format");
});

test("soundOrder: combobreak after the plain hitsounds and before custom indexes (so a skin over the limits keeps it before index 2+)", () => {
  const o = P["soundOrder(['drum-hitclap2', 'combobreak', 'soft-slidertick', 'normal-hitnormal', 'normal-hitnormal3'])"];
  assert.deepEqual(J(o), ["normal-hitnormal", "soft-slidertick", "combobreak", "drum-hitclap2", "normal-hitnormal3"]);
});

test("indexSounds: leaves out what is never played or never asked for", () => {
  const idx = sIdx(["normal-sliderslide.wav", "soft-sliderwhistle.wav", "drum-slidertransition.wav", "combobreak2.wav", "taiko-combobreak.wav", "combobreak.png", "spinnerspin.wav", "spinnerbonus.wav", "applause.mp3",
    "normal-hitnormal1.wav", "normal-hitnormal02.wav", "normal-hitnormal.png", "normal-hitnormal.flac", "__MACOSX/._normal-hitnormal.wav", "taiko-normal-hitnormal.wav", "normal-hitnormalx.wav"]);
  assert.deepEqual(Object.keys(J(idx)), []);
});

test("indexSounds: found in a subfolder; the shallowest copy wins, then wav > ogg > mp3", () => {
  const idx = sIdx(["sounds/normal-hitnormal.wav", "a/b/soft-hitclap.wav", "soft-hitclap.mp3", "drum-hitnormal.mp3", "drum-hitnormal.ogg", "drum-hitnormal.wav", "x\\normal-hitwhistle.ogg"]);
  assert.equal(idx["normal-hitnormal"].depth, 2);
  assert.equal(idx["soft-hitclap"].depth, 1, "the root copy beats the one in a folder");
  assert.equal(idx["soft-hitclap"].ext, 2);
  assert.equal(idx["drum-hitnormal"].ext, 0, "wav first");
  assert.ok(idx["normal-hitwhistle"], "a Windows path separator");
});

test("limits: 2 MB a sound, 12 MB and 80 sounds a skin", () => {
  assert.equal(run("SKIN_SND_MAX"), 2 * 1024 * 1024);
  assert.equal(run("SKIN_SND_TOTAL"), 12 * 1024 * 1024);
  assert.equal(run("SKIN_SND_COUNT"), 80);
});

test("readSkinSounds: over-limit files are left out and counted, the plain sounds are kept before custom indices", async () => {
  const MB = 1024 * 1024, reads = [];
  const f = (name, size, real = size) => ({ path: name + ".wav", depth: 1, size, get: async () => { reads.push(name); return { size: real, tag: name }; } });
  // a 3 MB file (by the zip's word: never read), one that says 1 KB but is 3 MB, then 7 x 1.9 MB: 6 fit in 12 MB
  const list = [f("normal-hitnormal", 3 * MB), f("soft-hitnormal", 1024, 3 * MB)];
  for (const n of ["normal-hitclap2", "normal-hitwhistle", "normal-hitfinish", "normal-hitclap", "soft-hitclap", "drum-hitclap", "drum-hitnormal"]) list.push(f(n, 1.9 * MB));
  T$.l = list; const out = await P["readSkinSounds(indexSounds(T$.l))"];
  assert.ok(!reads.includes("normal-hitnormal"), "too big by its own size: not read");
  assert.equal(out.skipped, 3);
  assert.equal(out.n, 6);
  assert.ok(!out.sounds["normal-hitclap2"], "the custom index is the one left out");
  assert.ok(out.bytes <= 12 * MB);
  // 90 small files: 80 kept, the plain ones among them
  const many = []; for (let i = 2; i <= 31; i++) for (const s of ["normal", "soft", "drum"]) many.push(f(`${s}-hitclap${i}`, 10));
  many.push(f("soft-hitwhistle", 10));
  T$.l = many; const o2 = await P["readSkinSounds(indexSounds(T$.l))"];
  assert.equal(o2.n, 80); assert.equal(o2.skipped, 11); assert.ok(o2.sounds["soft-hitwhistle"]);
  assert.deepEqual(J(P["soundOrder(['soft-hitclap3', 'drum-hitnormal2', 'soft-hitclap', 'normal-slidertick', 'normal-hitnormal'])"]), ["normal-hitnormal", "normal-slidertick", "soft-hitclap", "drum-hitnormal2", "soft-hitclap3"]);
});

test("buildSkin keeps the sounds' bytes (not decoded); a skin without sounds has none", async () => {
  T$.idx = {}; T$.ini = {}; T$.sidx = P["indexSounds(T$.l = [{ path: 'normal-hitnormal.wav', depth: 1, size: 300, get: async () => ({ size: 300, tag: 'nh' }) }])"];
  const sk = await P["buildSkin('osk:s', 'S', T$.idx, T$.ini, {}, T$.sidx)"];
  assert.equal(sk.sndN, 1); assert.equal(sk.sounds["normal-hitnormal"].tag, "nh"); assert.deepEqual(J(sk.sbuf), {}); assert.equal(sk.sndSkip, 0);
  const plain = await build(["hitcircle"]);
  assert.equal(plain.sndN, 0); assert.deepEqual(J(plain.sounds), {});
  assert.equal(P["FALLBACK.sndN"], 0);
  assert.equal(plain.soundSet, "normal");
  assert.equal((await build(["hitcircle"], "[General]\nSampleSet: Soft")).soundSet, "soft");
  assert.equal((await build(["hitcircle"], "[General]\nSampleSet: Loud")).soundSet, "normal");
});

// a stand-in for JSZip: entries with name / dir / async(type) / _data.uncompressedSize
const fakeZip = files => ({ loadAsync: async () => ({ forEach: fn => { for (const [name, v] of Object.entries(files)) fn(name, { name, dir: false, _data: { uncompressedSize: v.size }, async: async t => t === "string" ? v.text : { size: v.size, tag: name, w: 64, h: 64 } }); } }) });

test("loadOskBlob finds the sounds of an .osk (zipped inside a folder too) and the stored record counts them", async () => {
  T$.zip = fakeZip({ "My Skin/skin.ini": { text: "[General]\nName: Loud", size: 20 }, "My Skin/hitcircle.png": { size: 100 }, "My Skin/Normal-HitNormal.wav": { size: 500 }, "My Skin/sounds/drum-hitclap2.ogg": { size: 500 }, "My Skin/combobreak.wav": { size: 500 }, "My Skin/spinnerspin.wav": { size: 500 } });
  const sk = await P["loadOskBlob('osk:z', 'z', {})"];
  assert.equal(sk.name, "Loud");
  assert.deepEqual(Object.keys(J(sk.sounds)).sort(), ["combobreak", "drum-hitclap2", "normal-hitnormal"]); // (the combo-break sound is kept now; the spinner's is not)
  assert.equal(sk.sndN, 3);
  T$.sk = sk; assert.deepEqual(J(P["skinMeta(T$.sk)"]), { name: "Loud", author: "", version: "", sounds: 3 });
});

test("importOsk takes a hitsound-only skin and reports the sounds left out", async () => {
  run("toasts.length = 0");
  const big = 3 * 1024 * 1024;
  T$.zip = fakeZip({ "soft-hitnormal.wav": { size: 900 }, "soft-hitclap.wav": { size: big } });
  T$.put = [];
  run("idb.all = async () => []; idb.put = async r => { T$.put.push(r); }; renderSkinUI = async () => {}; skinReport = ''");
  T$.f = new Blob(["hitsound pack bytes"]); T$.f.name = "pack.osk";
  await P["importOsk(T$.f)"];
  assert.equal(T$.put.length, 1, P["toasts"].join("|"));
  assert.equal(T$.put[0].meta.sounds, 1);
  assert.match(P["skinReport"], /Sound files left out \(over the limits\): 1/);
  assert.match(P["toasts"].join("|"), /left out \(over the limits\): 1/);
  assert.match(P["toasts"].join("|"), /Using skin "pack": its hitsounds, with the pictures of osu! default\./, "a hitsound pack is not reported as missing every picture");
  assert.equal(P["SK.sndN"], 1);
  run("SK = FALLBACK; S.skin = 'default'; for (const k of Object.keys(skinCache)) delete skinCache[k]");
});

test("letting a skin go drops its sounds' bytes and decoded sounds; a decode still running keeps nothing", async () => {
  const s = await build(["hitcircle"], "", {}, "rel:"); s.id = "osk:rel";
  Object.assign(s, { sounds: { "normal-hitnormal": { size: 300 } }, sndN: 1, sbuf: { "normal-hitnormal": { decoded: true } } });
  const keep = await build(["hitcircle"], "", {}, "keep:"); keep.id = "osk:keep";
  use(keep, null);
  T$.c = { "osk:rel": Promise.resolve(s), "osk:keep": Promise.resolve(keep) };
  run("for (const k of Object.keys(skinCache)) delete skinCache[k]; Object.assign(skinCache, T$.c); S.skin = 'osk:keep'; skinWant = ''");
  run("releaseSkins()"); await new Promise(r => setTimeout(r, 5));
  assert.equal(s.sndN, 0); assert.deepEqual(J(s.sounds), {}); assert.deepEqual(J(s.sbuf), {}); assert.equal(s.sndDead, true);
  run("S.skin = 'default'"); use(null);
});
