// The live Top 50 board's pure parts (js/replay.js): the lazer standardised -> classic factor, taking the replay itself out of the list,
// the replay's slot by binary search, the window of rows around it and the labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js"]);
const row = (name, score, combo = 100) => ({ rank: 0, name, country: "", avatar: "", score, acc: 1, combo, mods: [], pp: null, date: "" });
const fifty = () => Array.from({ length: 50 }, (_, i) => row("P" + (i + 1), 10000000 - i * 100000)); // (osu!'s order: #1 = 10,000,000 ... #50 = 5,100,000)
const stable = (o = {}) => ({ lazer: false, player: "Me", score: 7000000, counts: { n300: 900, n100: 10, n50: 0, miss: 0 }, lazerInfo: null, ...o });
const lazer = (o = {}) => ({ lazer: true, player: "Me", score: 950000, counts: { n300: 990, n100: 10, n50: 0, miss: 0 }, lazerInfo: { maximumStatistics: { great: 1000, large_tick_hit: 300, slider_tail_hit: 200 }, statistics: { great: 990, ok: 10 } }, ...o });

test("rpBoardK: 1 for stable, lazer's osu! classic formula for lazer (N = the basic judgements of maximum_statistics)", () => {
  assert.equal(P.rpBoardK(stable()), 1);
  assert.equal(P.rpBoardK(null), 1);
  const k = P.rpBoardK(lazer()); // N = 1000 (great only: ticks and tails are not basic)
  assert.ok(Math.abs(k - (1000 * 1000 * 32.57 + 100000) / 1e6) < 1e-9);
  assert.equal(Math.round(1000000 * k), 32670000); // (a full SS: lazer shows 32,670,000 in classic)
  // no maximum statistics: the judged counts (lazer's statistics, then the header)
  assert.ok(Math.abs(P.rpBoardK(lazer({ lazerInfo: { statistics: { great: 400, ok: 90, meh: 5, miss: 5, large_tick_hit: 9 } } })) - (500 * 500 * 32.57 + 100000) / 1e6) < 1e-9);
  assert.ok(Math.abs(P.rpBoardK(lazer({ lazerInfo: null, counts: { n300: 200, n100: 0, n50: 0, miss: 0 } })) - (200 * 200 * 32.57 + 100000) / 1e6) < 1e-9);
  // nothing at all: still a positive factor (never NaN)
  assert.ok(P.rpBoardK(lazer({ lazerInfo: null, counts: {} })) > 0);
});

test("rpBoardList: sorted high to low, entries without a score left out, nothing taken out for a stranger", () => {
  const L = P.rpBoardList([row("B", 500), row("A", 900), row("Z", 0), row("C", 700)], stable({ player: "Nobody" }), 7000000);
  assert.deepEqual(J(L.rows).map(r => r.name), ["A", "C", "B"]);
  assert.equal(L.cut, null);
  assert.deepEqual(J(P.rpBoardList(null, stable(), 1).rows), []);
});

test("rpBoardList dedupe: a stable replay that is on the list (same name, any case, same score) is taken out once", () => {
  const list = fifty(); list[11] = row("me", 8900000); // (#12)
  const L = P.rpBoardList(list, stable({ player: "Me", score: 8900000 }), 8900000);
  assert.equal(L.rows.length, 49); assert.equal(L.cut.name, "me");
  assert.ok(!L.rows.some(r => r.name === "me"));
  // at its final score the replay is #12 again, where osu! has it, and it does not pass itself
  const idx = P.rpBoardIdx(L.rows, 8900000); assert.equal(idx, 11); assert.equal(P.rpBoardRank(idx), "#12");
  // the same player with another score (a worse play): stays
  assert.equal(P.rpBoardList(list, stable({ player: "Me", score: 6000000 }), 6000000).cut, null);
  // another player with the same score: stays
  assert.equal(P.rpBoardList(list, stable({ player: "Other", score: 8900000 }), 8900000).cut, null);
});

test("rpBoardList dedupe: a lazer replay is matched on its converted (classic) score, within 0.1%", () => {
  const d = lazer({ score: 950000 }), cf = Math.round(950000 * P.rpBoardK(d)); // 31,036,500
  const list = [row("X", 40000000), row("Me", cf + 3000), row("Y", 20000000)];
  const L = P.rpBoardList(list, d, 950000);
  assert.equal(L.cut && L.cut.score, cf + 3000); assert.deepEqual(J(L.rows).map(r => r.name), ["X", "Y"]);
  // the standardised number itself would never match a classic list (the scale trap)
  assert.equal(P.rpBoardList([row("Me", 950000)], d, 950000).cut, null);
  // too far off: not this replay
  assert.equal(P.rpBoardList([row("Me", Math.round(cf * 1.01))], d, 950000).cut, null);
});

test("rpBoardIdx: the replay's slot by binary search; a tie stays behind (the earlier score wins)", () => {
  const rows = fifty();
  assert.equal(P.rpBoardIdx(rows, 0), 50);
  assert.equal(P.rpBoardIdx(rows, 5100000), 50); // (ties #50: not past it)
  assert.equal(P.rpBoardIdx(rows, 5100001), 49);
  assert.equal(P.rpBoardIdx(rows, 10000001), 0);
  assert.equal(P.rpBoardIdx(rows, 10000000), 1);
  assert.equal(P.rpBoardIdx([], 5), 0);
  // the same as a linear count for every score in a sweep
  for (let v = 0; v <= 10200000; v += 37777) assert.equal(P.rpBoardIdx(rows, v), rows.filter(r => r.score >= v).length);
  // the slot only improves as the score grows
  let last = 99; for (let v = 0; v <= 10200000; v += 50000) { const i = P.rpBoardIdx(rows, v); assert.ok(i <= last); last = i; }
});

test("rpBoardRank: #1..#50, then 50+ (not on the list)", () => {
  assert.equal(P.rpBoardRank(0), "#1"); assert.equal(P.rpBoardRank(49), "#50"); assert.equal(P.rpBoardRank(50), "50+");
  // a full list and a replay below it: unranked
  assert.equal(P.rpBoardRank(P.rpBoardIdx(fifty(), 1000)), "50+");
  // a short list (a new map): the last place is a real rank
  assert.equal(P.rpBoardRank(P.rpBoardIdx(fifty().slice(0, 10), 1000)), "#11");
});

test("rpBoardWin: n rows around the replay's slot, kept inside the list", () => {
  assert.equal(P.rpBoardWin(51, 50, 7), 44); // (unranked: the last six and the replay)
  assert.equal(P.rpBoardWin(51, 0, 7), 0); // (#1: the top seven)
  assert.equal(P.rpBoardWin(51, 20, 7), 17); // (the middle: three above, three below)
  assert.equal(P.rpBoardWin(51, 20, 5), 18);
  assert.equal(P.rpBoardWin(4, 2, 7), 0); // (fewer rows than the window)
  assert.equal(P.rpBoardWin(51, 20.5, 7), 17.5); // (a slide: the window follows smoothly)
  for (let p = 0; p <= 50; p++) { const s = P.rpBoardWin(51, p, 5); assert.ok(s >= 0 && s <= 46 && p >= s && p < s + 5); } // (the replay's row is always shown)
});
