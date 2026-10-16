// The HUD in a skin's own numbers (js/skins.js hudLayout; drawn by js/player.js hudScore / hudCombo / drawSkinHealth): the layout of a string in a skin's font:
// each glyph at its own hd, the overlap in 1x pixels, a missing glyph = null (that line is drawn as text instead).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../js/skins.js", import.meta.url), "utf8");
const a = src.indexOf("const HUD_CH = {"), b = src.indexOf("function hudDraw("), e = src.indexOf("// soft glow");
assert.ok(a > 0 && b > a, "skins.js: hudLayout moved");
const cx = { console }; vm.createContext(cx); vm.runInContext(src.slice(a, b) + src.slice(src.indexOf("function hudFit("), e) + "\nthis.hudLayout = hudLayout; this.hudFit = hudFit;", cx);
const glyph = (w, h, hd = 2) => ({ img: { width: w, height: h }, hd });
const font = (over = {}, hd = 2) => { const g = {}; for (const c of "0123456789") g[c] = glyph(66, 92, hd); Object.assign(g, { comma: glyph(28, 92, hd), dot: glyph(28, 92, hd), percent: glyph(66, 92, hd), x: glyph(66, 92, hd) }); return { g: { ...g, ...over }, overlap: 0 }; };

test("a string is laid out glyph by glyph at the skin's scale: logical (1x) size x f", () => {
  const L = cx.hudLayout(font(), "704", .5);
  assert.equal(L.items.length, 3); assert.equal(L.width, 3 * 33 * .5); assert.equal(L.height, 46 * .5); assert.deepEqual(Array.from(L.items, i => i.x), [0, 16.5, 33]);
});
test("the overlap is in 1x skin pixels (x f), a negative one is a gap", () => {
  const f = font(); f.overlap = 8; const L = cx.hudLayout(f, "12", 1);
  assert.equal(L.items[1].x, 33 - 8); assert.equal(L.width, 33 - 8 + 33);
  f.overlap = -4; assert.equal(cx.hudLayout(f, "12", 1).width, 33 + 4 + 33);
});
test("every glyph uses its own hd: digits @2x with a @1x dot and percent", () => {
  const f = font({ dot: glyph(14, 46, 1), percent: glyph(33, 46, 1) }); const L = cx.hudLayout(f, "9.5%", 1);
  assert.deepEqual(Array.from(L.items, i => i.w), [33, 14, 33, 33]); assert.ok(L.items.every(i => i.h === 46)); assert.equal(L.width, 33 + 14 + 33 + 33);
});
test("the score line, the accuracy and the combo's x: , . % x are glyphs", () => {
  const f = font(); for (const s of ["00001234", "99.59%", "100.00%", "704x", "1,234"]) assert.ok(cx.hudLayout(f, s, 1), s);
});
test("a missing glyph (or no font): null, so the whole line is text", () => {
  const f = font(); delete f.g.x; delete f.g.percent;
  assert.equal(cx.hudLayout(f, "704x", 1), null); assert.equal(cx.hudLayout(f, "99.59%", 1), null); assert.ok(cx.hudLayout(f, "99.59", 1) !== null);
  assert.equal(cx.hudLayout(null, "1", 1), null); assert.equal(cx.hudLayout({}, "1", 1), null); assert.equal(cx.hudLayout(font(), "a", 1), null);
  assert.equal(cx.hudLayout(font(), "", 1).width, 0);
});

test("hudFit: a line fitted to a digit height (the Top 50 rows, the results numbers): the 0 glyph is that tall, the width follows", () => {
  const L = cx.hudFit(font(), "1,234", 10);
  assert.equal(L.height, 10); assert.equal(L.items[0].h, 10); assert.equal(L.items[0].w, 33 * 10 / 46);
  assert.equal(cx.hudFit(font(), "99", 20).width, 2 * 33 * 20 / 46);
});
test("hudFit: no font, no 0 glyph or a missing glyph: null (the row stays text)", () => {
  assert.equal(cx.hudFit(null, "1", 10), null); assert.equal(cx.hudFit({}, "1", 10), null);
  const f = font(); delete f.g["0"]; assert.equal(cx.hudFit(f, "1", 10), null);
  const g = font(); delete g.g.comma; assert.equal(cx.hudFit(g, "1,234", 10), null); assert.ok(cx.hudFit(g, "1234", 10));
});
