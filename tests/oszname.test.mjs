// The file a card's download button saves (js/api.js oszFileName): "<set id> <Artist> - <Title>.osz" like osu! names its downloads,
// without the characters a file name can't have (dropped, not replaced), tidy spaces, no trailing dots, never empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "./lib/browser.mjs";

const STUB = `const S = { mirror: "osudirect" }; const tr = s => s; const save = () => {}; const toast = () => {};
const $ = () => ({ add() {}, set innerHTML(v) {}, set value(v) {}, set onchange(v) {} }); function Option() {} function addEventListener() {}`;
const P = loadScripts(["js/api.js"], STUB);

test("id, artist - title, .osz", () => {
  assert.equal(P.oszFileName(39804, "xi", "FREEDOM DiVE"), "39804 xi - FREEDOM DiVE.osz");
  assert.equal(P.oszFileName("158899", "Nekomata Master feat. Shimotsuki Haruka", "Element of SPADA"), "158899 Nekomata Master feat. Shimotsuki Haruka - Element of SPADA.osz");
});
test("characters a file name can't have are dropped; Unicode stays", () => {
  assert.equal(P.oszFileName(1, "A/B\\C", 'Re:Zero? "OP" <1> |*|'), "1 ABC - ReZero OP 1.osz");
  assert.equal(P.oszFileName(2, "米津玄師", "Lemon"), "2 米津玄師 - Lemon.osz");
  assert.equal(P.oszFileName(3, "a\u0000b\u001fc\u007f", "t\ne\tst"), "3 a b c - t e st.osz");
});
test("spaces collapse, no trailing dots or spaces before .osz, length is capped", () => {
  assert.equal(P.oszFileName(4, "  A   B ", "C...  "), "4 A B - C.osz");
  const n = P.oszFileName(5, "x".repeat(400), "y");
  assert.ok(n.endsWith(".osz") && n.length <= 154 && !/ \.osz$/.test(n), String(n.length));
});
test("a missing artist or title, or all of it illegal, still gives a usable name", () => {
  assert.equal(P.oszFileName(6, "", "T"), "6 T.osz");
  assert.equal(P.oszFileName(7, "A", ""), "7 A.osz");
  assert.equal(P.oszFileName(8, "", ""), "8.osz");
  assert.equal(P.oszFileName(9, "///", ":::"), "9.osz");
  assert.equal(P.oszFileName(undefined, null, undefined), "beatmapset.osz");
});
