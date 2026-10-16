// The beatmap detail panel opens out of the card that was clicked (js/app.js dFlyOpen / dFlyBack). flipGeo works out the start of that
// move: the panel is only MOVED (never scaled: its text and pictures keep their size) and a window clipped out of it lands exactly on the
// card. picDraw works out how the card's picture is drawn while it flies from the card's cover to the panel's: one scale for both axes
// (never stretched), as the card's own crop at the start and as the panel cover's crop at the end, always covering its box.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "js", "app.js"), "utf8");
const a = src.indexOf("// flipGeo:start"), b = src.indexOf("// flipGeo:end");
assert.ok(a > 0 && b > a, "the flipGeo markers are in js/app.js");
const cx = {}; vm.createContext(cx); vm.runInContext(src.slice(a, b) + "\nthis.flipGeo = flipGeo; this.picDraw = picDraw;", cx);
const { flipGeo, picDraw } = cx;
const R = (left, top, width, height) => ({ left, top, width, height });
const near = (x, y, m, eps = 1e-9) => assert.ok(Math.abs(x - y) < eps, `${m}: ${x} vs ${y}`);
// where the window ends up on screen: transform = translate(tx,ty) applied to the panel at p, the inset window cut out of it
const onScreen = (g, p) => { const [t, r, bt, l] = g.ins; return { left: p.left + g.tx + l, top: p.top + g.ty + t, width: p.width - l - r, height: p.height - t - bt, radius: g.r }; };

test("the window starts exactly on the card (card left/right/below of the panel), the panel only moves", () => {
  const cases = [
    [R(726, 225, 339, 199), R(120, 54, 1200, 792)], // a card in the 3rd column, the 1440x900 panel
    [R(24, 308, 370, 199), R(24, 45, 752, 810)], // the 800 px one-column dialog
    [R(900, 600, 100, 300), R(100, 50, 1200, 792)], // a narrow tall card
    [R(-40, 820, 339, 199), R(120, 54, 1200, 792)], // partly off-screen to the left, below the panel
  ];
  for (const [c, p] of cases) {
    const g = flipGeo(c, p, 5), w = onScreen(g, p);
    near(w.left, c.left, "left"); near(w.top, c.top, "top"); near(w.width, c.width, "width"); near(w.height, c.height, "height"); near(w.radius, 5, "corner radius");
    assert.equal(g.s, undefined, "no scale at all");
    assert.deepEqual([g.ins[0], g.ins[3]], [0, 0], "anchored at the panel's top-left (its cover)");
    for (const v of g.ins) assert.ok(v >= -1e-9, "the window lies inside the panel (no negative inset)");
  }
  near(flipGeo(R(0, 0, 339, 199), R(0, 0, 1200, 792)).r, 0, "no radius given: square corners");
});

test("a card larger than the panel: the window is the panel's size (never a negative inset)", () => {
  const p = R(100, 100, 300, 200), g = flipGeo(R(50, 60, 400, 260), p, 5);
  assert.deepEqual([...g.ins], [0, 0, 0, 0]); near(g.tx, -50, "tx"); near(g.ty, -40, "ty");
});

test("a card the size of the panel: no move at all", () => {
  const p = R(120, 54, 1200, 792), g = flipGeo(p, p, 6);
  near(g.tx, 0, "tx"); near(g.ty, 0, "ty"); assert.deepEqual([...g.ins], [0, 0, 0, 0]); near(g.r, 6, "radius");
});

const CARD = 400 / 140, COVER = 1800 / 500;
test("picDraw: the picture keeps its own shape (one scale) and covers its box", () => {
  for (const [w, hh] of [[337, 108], [319, 172], [758, 172], [360, 136], [100, 300], [1, 1]]) for (const at of [CARD, COVER]) {
    const [dw, dh] = picDraw(w, hh, at, CARD);
    near(dw / dh, CARD, `shape kept ${w}x${hh}`, 1e-9); assert.ok(dw >= w - 1e-9 && dh >= hh - 1e-9, `covers ${w}x${hh}`);
  }
});

test("picDraw: as its own crop it is CSS 'cover'; as the cover's crop it spans what cover@2x spans (same width, same centre)", () => {
  // the card's own crop in the card's 337x108 cover: the width decides
  const [aw, ah] = picDraw(337, 108, CARD, CARD); near(aw, 337, "card: cover width"); near(ah, 337 / CARD, "card: height");
  // the panel's 319x172 cover: cover@2x as 'cover' is 172*3.6 = 619.2 wide; the card picture drawn as that crop spans the same 619.2
  const [bw, bh] = picDraw(319, 172, COVER, CARD); near(bw, 172 * COVER, "same width as cover@2x drawn there", 1e-9); near(bh, bw / CARD, "its own height");
  // CSS cover of the card picture would be 172*2.857 = 491 wide: a 26% smaller picture, the zoom pop the old cross-fade made
  assert.ok(bw / picDraw(319, 172, CARD, CARD)[0] > 1.25);
  // a box wider than both shapes (the one-column dialog's 758x172 cover): both rules give the box's width
  near(picDraw(758, 172, COVER, CARD)[0], 758, "wide box"); near(picDraw(758, 172, CARD, CARD)[0], 758, "wide box, own crop");
});

test("picDraw in flight: drawn sizes eased between the two ends always cover the eased box (convexity), never stretched", () => {
  const A = [337, 108, ...picDraw(337 * 1.06, 108 * 1.06, CARD, CARD)], B = [319, 172, ...picDraw(319, 172, COVER, CARD)]; // (start: the hovered card's picture, zoomed 1.06)
  for (let e = 0; e <= 1.0000001; e += 0.01) {
    const L = (i) => A[i] + (B[i] - A[i]) * e, w = L(0), hh = L(1), dw = L(2), dh = L(3);
    assert.ok(dw >= w - 1e-9 && dh >= hh - 1e-9, `covers at ${e.toFixed(2)}`); near(dw / dh, CARD, `shape at ${e.toFixed(2)}`, 1e-9);
  }
});
