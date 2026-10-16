// js/parse.js storyboard reader (typed arrays, read in a worker, kept per set) against the reader it replaced (lib/sbref.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/parse.js", "tests/lib/sbref.js"]);
const TY = ["F", "S", "V", "M", "MX", "MY", "R", "C"], NA = [1, 1, 2, 2, 1, 1, 1, 3];
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[ri(0, a.length - 1)];
const num = (lo, hi) => (lo + rnd() * (hi - lo)).toFixed(ri(0, 3));

function cmdLine(depth, type) {
  const pad = " ".repeat(depth), ez = pick([0, 0, 1, 2, 3, 5, 9, 14, 17, 21, 24, 25, 28, 31, 33, 34, 35, 99, -1, 1.5]);
  const st = ri(-2000, 90000), dur = pick([0, 0, ri(1, 3000), ri(1, 40000)]), end = rnd() < .15 ? "" : st + dur;
  if (type === "P") return `${pad}P,${ez},${st},${end},${pick(["H", "V", "A", "X"])}`;
  const n = { F: 1, S: 1, V: 2, M: 2, MX: 1, MY: 1, R: 1, C: 3 }[type];
  const one = () => Array.from({ length: n }, () => type === "C" ? ri(0, 255) : type === "F" ? num(0, 1) : type === "R" ? num(-7, 7) : num(-100, 760)).join(",");
  const k = pick([1, 1, 1, 2, 3]); // (k = 1: from == to; 2: from, to; 3+: a chain of segments)
  const vals = k === 1 ? [one()] : Array.from({ length: k }, one);
  return `${pad}${type},${ez},${st},${end},${vals.join(",")}`;
}
function storyboard(nSprites, { vars = false } = {}) {
  const L = ["[Variables]", "$f=sb/", "$n=12", "[Events]", "//Storyboard Layer 0 (Background)"];
  for (let s = 0; s < nSprites; s++) {
    const layer = pick(["Background", "Background", "Foreground", "Pass", "Fail", "Overlay", 0, 2, 3, "Bogus"]);
    const kind = rnd() < .15 ? "Animation" : "Sprite", origin = pick(["Centre", "TopLeft", "BottomRight", "Custom", 1, 5, 9, "Nope"]);
    const file = `"${vars ? "$f" : "sb/"}img${ri(0, 9)}.png"`;
    L.push(kind === "Animation" ? `Animation,${layer},${origin},${file},${ri(0, 640)},${ri(0, 480)},${ri(1, 6)},${pick([0, 40, 100])},${pick(["LoopForever", "LoopOnce", "1"])}` : `${kind},${layer},${origin},${file},${ri(0, 640)},${ri(0, 480)}`);
    for (let c = ri(0, 14); c > 0; c--) L.push(cmdLine(1, pick([...TY, "P", "F", "S", "MX", "V"])));
    if (rnd() < .3) { L.push(` L,${ri(-500, 5000)},${pick([1, 2, 5, 30, 1000, 10000000])}`); for (let c = ri(0, 6); c > 0; c--) L.push(cmdLine(2, pick([...TY, "P"]))); }
    if (rnd() < .1) { L.push(" T,HitSound,0,1000"); L.push(cmdLine(2, "F")); }
    if (rnd() < .05) L.push("  F,0,0,100,0,1"); // (a stray deep line outside a loop)
    if (rnd() < .05) L.push(cmdLine(1, "F").replace(/,\d+$/, ",abc"));
  }
  L.push("0,0,\"bg.jpg\",0,0", "Sample,100,0,\"x.wav\",100");
  return L.join(rnd() < .5 ? "\n" : "\r\n");
}
const rel = (a, b) => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(a), Math.abs(b)) || (Number.isNaN(a) && Number.isNaN(b));
const frames = (c, i) => Array.from({ length: c.nf[i] }, (_, k) => c.names[c.frameIds[c.fo[i] + k]]);

function same(old, c, times) {
  assert.equal(c.n, old.length, "same sprites");
  const out = TY.map((_, T) => new Array(NA[T]).fill(0));
  for (let i = 0; i < old.length; i++) {
    const s = old[i];
    assert.deepEqual(frames(c, i), J(s.frames), "frames");
    assert.ok(rel(s.x, c.x[i]) && rel(s.y, c.y[i]), "position");
    assert.deepEqual([c.ox[i], c.oy[i]], J(s.origin), "origin"); assert.equal(c.delay[i], s.delay); assert.equal(c.flags[i] & 1, s.loopOnce ? 1 : 0);
    assert.ok(Object.is(c.start[i], s.start) && Object.is(c.end[i], s.end), `start/end ${s.start} ${c.start[i]} ${s.end} ${c.end[i]}`);
    const P2 = s.byType.P || []; assert.equal(c.pOff[i + 1] - c.pOff[i], P2.length, "P count");
    const want = Array.from(P2, q => [q.start, q.end, { H: 1, V: 2, A: 3 }[q.v] || 0]), got = []; // (any order: they only switch things on)
    for (let k = c.pOff[i]; k < c.pOff[i + 1]; k++) got.push([c.pD[3 * k], c.pD[3 * k + 1], c.pD[3 * k + 2]]);
    const key = a => a.map(String).join(); assert.deepEqual(got.map(key).sort(), want.map(key).sort(), "P commands"); // (host arrays both)
    for (let T = 0; T < 8; T++) assert.equal(c.cn[T][i], (s.byType[TY[T]] || []).length, "command count " + TY[T]);
  }
  for (const t of times) for (let i = 0; i < old.length; i++) for (let T = 0; T < 8; T++) {
    const list = old[i].byType[TY[T]]; if (!list) continue;
    const a = P.refSbVal(list, t, new Array(NA[T]).fill(0)), b = P.sbEv(c, T, i, t, out[T]);
    for (let j = 0; j < NA[T]; j++) assert.ok(rel(a[j], b[j]), `value ${TY[T]} sprite ${i} t=${t}: ${a[j]} vs ${b[j]}`);
  }
}
const edges = (c, k) => { const t = []; for (let n = 0; n < k; n++) { const i = ri(0, c.n - 1); t.push(c.start[i], c.end[i]); for (const T of [0, 1, 3]) if (c.cn[T][i]) { const q = c.cb[T][i] + ri(0, c.cn[T][i] - 1); t.push(c.cs[T][q], c.ce[T][q]); } } return t.filter(Number.isFinite); }; // (exactly on a start or an end: the borders are where it goes wrong)
const sweep = c => { const t = []; for (let x = -3000; x < 100000; x += 1300) t.push(x); for (let k = 0; k < 150; k++) t.push(rnd() * 100000 - 3000); return t.concat(edges(c, 60)); }; // (time forward, then jumping about: the cursors must follow both)

test("storyboard: easings table has the 35 entries the typed reader stores", () => assert.equal(P.E.length, 35));
test("storyboard: typed reader agrees with the old one (sprites, order, commands, values at any time)", () => {
  for (const vars of [false, true]) for (let r = 0; r < 4; r++) {
    const text = storyboard(120, { vars }), old = P.refParseStoryboard(text, { $n: "3" }), c = P.sbParseChunk(text, { $n: "3" });
    same(old, P.sbPrep(c), sweep(c));
  }
});
test("storyboard: a loop budget shared by all sprites runs out the same way (Fail layer ones count too)", () => {
  const L = ["[Events]"];
  for (let s = 0; s < 40; s++) L.push(`Sprite,${s % 3 ? "Fail" : "Foreground"},Centre,"a${s}.png",0,0`, ` L,0,100000`, `  F,0,0,100,0,1`, `  M,0,0,100,0,0,10,10`, `  P,0,0,0,A`);
  const text = L.join("\n"), old = P.refParseStoryboard(text), c = P.sbParseChunk(text);
  assert.equal(c.total, old.reduce((a, s) => a + s.cmds.length, 0));
  same(old, P.sbPrep(c), [0, 50, 5000, 99999, 150000, 2e6]);
});
test("storyboard: caps hold (loops, frames, chained variables)", () => {
  const sb = P.sbParseChunk("[Events]\nSprite,Foreground,Centre,\"a.png\",320,240\n L,0,10000000\n  F,0,0,100,0,1\n  M,0,0,100,0,0,10,10\nAnimation,Foreground,Centre,\"b.png\",320,240,10000000,10\n F,0,0,100,0,1\n");
  assert.ok(sb.total <= 2e6 + 10 && sb.cn[0][0] + sb.cn[3][0] <= 1e5 + 10); assert.ok(sb.nf[1] <= 1000);
  const vars = Array.from({ length: 30 }, (_, i) => `$v${String.fromCharCode(97 + i)}=$v${String.fromCharCode(98 + i)}$v${String.fromCharCode(98 + i)}`).join("\n");
  const c = P.sbParseChunk(`[Variables]\n${vars}\n[Events]\nSprite,Foreground,Centre,"$va.png",320,240\n F,0,0,100,0,1\nSprite,Foreground,Centre,"$x.png",320,240\n F,0,0,100,0,1\n`, { $x: "ok" });
  assert.equal(c.n, 1); assert.match(frames(c, 0)[0], /ok\.png/);
});
test("storyboard: the .osb and the difficulty's events, parsed apart, give what one pass over both gave", () => {
  for (let r = 0; r < 4; r++) {
    const osb = storyboard(80, { vars: r % 2 === 1 }), ev = storyboard(25).replace("[Variables]\n$f=sb/\n$n=12\n", "").replace("[Events]\n", "").replace("//Storyboard Layer 0 (Background)\n", ""), v0 = { $n: "7" };
    const whole = P.refParseStoryboard(osb + "\n[Events]\n" + ev, v0);
    const A = P.sbPrep(P.sbParseChunk(osb, v0)), B = P.sbPrep(P.sbParseChunk("[Events]\n" + ev, A.vars));
    // (the order the page draws in: by layer, the .osb's sprites before the difficulty's in each)
    const got = []; for (let L = 0; L < 5; L++) { for (const c of [A, B]) for (let i = 0; i < c.n; i++) if (c.layer[i] === L) got.push(frames(c, i).join("|") + "@" + c.start[i] + "/" + c.end[i]); }
    assert.deepEqual(got, J(whole.map(s => s.frames.join("|") + "@" + s.start + "/" + s.end)));
  }
});
test("storyboard: the showing sprites follow time forward, back and across jumps (sbActive)", () => {
  const c = P.sbPrep(P.sbParseChunk(storyboard(400)));
  const times = [...Array.from({ length: 300 }, (_, k) => -3000 + k * 400), ...Array.from({ length: 200 }, () => rnd() * 100000 - 3000), 0, 0, 12345, 12345.5, ...edges(c, 150).sort((a, b) => a - b), ...edges(c, 100)];
  for (const t of times) {
    P.sbActive(c, t);
    const want = []; for (let i = 0; i < c.n; i++) if (t >= c.start[i] && t <= c.end[i]) want.push(i);
    assert.deepEqual(Array.from(c.act.subarray(0, c.na)), want, "t=" + t);
  }
});
test("storyboard: the most sprites showing at once (peak) is what a sweep over every moment gives", () => {
  for (let r = 0; r < 3; r++) {
    const c = P.sbParseChunk(storyboard(300)), pts = new Set();
    for (let i = 0; i < c.n; i++) pts.add(c.start[i]).add(c.end[i]);
    let want = 0; for (const t of pts) { let k = 0; for (let i = 0; i < c.n; i++) if (c.start[i] <= t && t <= c.end[i]) k++; if (k > want) want = k; }
    assert.equal(c.peak, want);
  }
  assert.equal(P.sbParseChunk("[Events]\n").peak, 0);
});
test("storyboard: an empty or command-less script gives no sprites", () => {
  for (const t of ["", "[Events]\n", "[Events]\nSprite,Foreground,Centre,\"a.png\",0,0\n", "garbage"]) { const c = P.sbPrep(P.sbParseChunk(t)); assert.equal(c.n, 0); P.sbActive(c, 100); assert.equal(c.na, 0); }
});

// ---- the storyboard drawn by WebGL (js/sbgl.js): the setting
import { readFileSync } from "node:fs";
const read = f => readFileSync(new URL("../" + f, import.meta.url), "utf8");
test("WebGL storyboard setting: off by default, checked on load, per device (not synced), in Settings with its words in every language", () => {
  assert.match(read("js/core.js"), /sbGL: "off"/);
  assert.match(read("js/core.js"), /S\.sbGL = S\.sbGL === "on" \? "on" : "off"/);
  assert.match(read("js/account.js"), /PREFS_LOCAL = new Set\(\[[^\]]*"sbGL"/);
  const html = read("index.html");
  assert.match(html, /<select id="sbRender"><option value="off"[^>]*>Canvas \(standard\)<\/option><option value="on"[^>]*>WebGL \(faster for big storyboards\)<\/option><\/select>/);
  assert.match(html, /<script src="js\/sbgl\.js\?v=\d+" defer><\/script>/);
  const pane = k => html.slice(html.indexOf(`data-pane="${k}"`), html.indexOf("</section>", html.indexOf(`data-pane="${k}"`)));
  for (const id of ["sbRender", "fpsSel", "quality"]) assert.ok(pane("graphics").includes(`id="${id}"`), id + " in Graphics");
  assert.ok(pane("graphics").includes('data-k="fpsHud"') && pane("display").includes('id="view"') && !pane("display").includes('id="sbRender"'));
  assert.match(read("js/player.js"), /\["display", "Display"\], \["graphics", "Graphics"\]/);
  for (const l of ["en", "th", "ms", "id", "ko", "ja"]) {
    const d = JSON.parse(read(`i18n/${l}.json`));
    for (const k of ["Storyboard drawing", "Canvas (standard)", "WebGL (faster for big storyboards)", "Graphics", "Performance", "Screen", "FPS counter", "This storyboard is heavy", "Use WebGL", "Keep Canvas"]) assert.ok(d[k], `${l}: ${k}`);
  }
});
