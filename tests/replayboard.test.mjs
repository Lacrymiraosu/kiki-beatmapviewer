// rpBoardMine (js/replay.js): "is this row of the board this very replay?", one rule for the live board and the results panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js"]);
const row = (name, score) => ({ rank: 1, name, country: "", avatar: "", score, acc: 1, combo: 1, mods: [], pp: null, date: "" });
const stable = (o = {}) => ({ lazer: false, player: "Me", score: 7000000, counts: { n300: 900, n100: 10, n50: 0, miss: 0 }, lazerInfo: null, ...o });
const lazer = (o = {}) => ({ lazer: true, player: "Me", score: 950000, counts: { n300: 990, n100: 10, n50: 0, miss: 0 }, lazerInfo: { maximumStatistics: { great: 1000 }, statistics: { great: 990, ok: 10 } }, ...o });

test("rpBoardMine: stable is the same name (any case) and exactly the same score", () => {
  const m = P.rpBoardMine(stable(), 7000000);
  assert.equal(m(row("me", 7000000)), true);
  assert.equal(m(row("ME", 7000001)), false);
  assert.equal(m(row("Other", 7000000)), false);
});
test("rpBoardMine: a lazer replay is matched on its converted score within 0.1%, never on the standardised one", () => {
  const d = lazer(), cf = Math.round(950000 * P.rpBoardK(d)), m = P.rpBoardMine(d, 950000);
  assert.equal(m(row("Me", cf)), true);
  assert.equal(m(row("me", cf + 20000)), true); // (0.1% of 31,036,500 is 31,036)
  assert.equal(m(row("Me", Math.round(cf * 1.01))), false);
  assert.equal(m(row("Me", 950000)), false);
  assert.equal(m(row("Other", cf)), false);
});
test("rpBoardMine: no player name matches nothing", () => {
  assert.equal(P.rpBoardMine(stable({ player: "" }), 7000000)(row("", 7000000)), false);
  assert.equal(P.rpBoardMine(null, 1)(row("x", 1)), false);
});
