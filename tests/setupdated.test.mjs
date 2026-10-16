// Which version is "newest": the set's last update as osu! has it (js/app.js setUpdated / oszOutdated), not the date a mirror (Nerinyan: its own refreshes) puts on its copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const a = src.indexOf("// upd: the set's last update as osu! has it"), b = src.indexOf("async function oszOpen(");
assert.ok(a > 0 && b > a, "app.js: oszOutdated / setUpdated moved");
const make = (osu, cur) => {
  const cx = { console, setTimeout, osuSet: async id => osu, curSet: cur, Promise, md5Hex: u => Buffer.from(u).toString() }; // (the "md5" of a file here is its text)
  vm.createContext(cx); vm.runInContext(src.slice(a, b) + "\nthis.oszOutdated = oszOutdated; this.setUpdated = setUpdated; this.osuStale = osuStale; this.sumsOlder = sumsOlder;", cx); return cx;
};
const T = s => Date.parse(s);

test("oszOutdated: a copy kept with osu!'s date is outdated only when osu! has a newer one", () => {
  const cx = make(null, null), rec = { v: 2, updated: "2024-05-01T00:00:00Z", savedAt: T("2025-01-01") };
  assert.equal(cx.oszOutdated(rec, "2024-05-02T00:00:00Z"), true);
  assert.equal(cx.oszOutdated(rec, "2024-05-01T00:00:00Z"), false);
  assert.equal(cx.oszOutdated(rec, "2024-04-01T00:00:00Z"), false);
  assert.equal(cx.oszOutdated(rec, ""), false); // (osu!'s date unknown: nothing to compare)
});
test("oszOutdated: an older record's own date (a mirror's) is not trusted: the day it was kept counts", () => {
  const cx = make(null, null), rec = { updated: "2030-01-01T00:00:00Z", savedAt: T("2025-01-01") }; // (a date in the future: what a mirror's refresh could have said)
  assert.equal(cx.oszOutdated(rec, "2025-06-01T00:00:00Z"), true);
  assert.equal(cx.oszOutdated(rec, "2024-06-01T00:00:00Z"), false);
});
test("setUpdated: osu!'s date wins, and the open set takes it", async () => {
  const cur = { id: 5, updated: "2026-10-14T00:00:00Z", src: "nerinyan" }, cx = make({ last_updated: "2015-04-04T17:46:42Z" }, cur);
  assert.equal(await cx.setUpdated(5), "2015-04-04T17:46:42Z"); assert.equal(cur.updated, "2015-04-04T17:46:42Z");
});
test("setUpdated: osu! can't be asked: another mirror's date is used, Nerinyan's is not", async () => {
  assert.equal(await make(null, { id: 5, updated: "2020-01-01T00:00:00Z", src: "osudirect" }).setUpdated(5), "2020-01-01T00:00:00Z");
  assert.equal(await make(null, { id: 5, updated: "2020-01-01T00:00:00Z", src: "nerinyan" }).setUpdated(5), "");
  assert.equal(await make(null, { id: 6, updated: "2020-01-01T00:00:00Z", src: "osudirect" }).setUpdated(5), ""); // (another set open)
  assert.equal(await make(null, null).setUpdated(5), "");
});

// a copy checked against the checksums osu! lists for the set's osu!standard difficulties
const zipOf = names => ({ files: Object.fromEntries(names.map(n => [n, { dir: false, name: n, async: async () => new TextEncoder().encode(n.replace(/\.osu$/, "")) }])) });
const setOf = (...sums) => ({ beatmaps: sums.map(c => ({ mode_int: 0, checksum: c })) });
test("osuStale: a difficulty osu! has that the copy lacks, while the others match: older copy", async () => {
  const cx = make(null, null), c = "a".repeat(31), n = x => c + x;
  assert.equal(await cx.osuStale(zipOf([n("1") + ".osu", n("2") + ".osu"]), setOf(n("1"), n("2"))), false); // all there
  assert.equal(await cx.osuStale(zipOf([n("1") + ".osu", n("9") + ".osu"]), setOf(n("1"), n("2"))), true); // one changed
  assert.equal(await cx.osuStale(zipOf([n("8") + ".osu", n("9") + ".osu"]), setOf(n("1"), n("2"))), true); // none match: every difficulty was updated (osu.direct's download of a set whose every difficulty got a hitsound pass)
  assert.equal(await cx.osuStale(zipOf([n("1") + ".osu"]), null), false); // osu! can't be asked
  assert.equal(await cx.osuStale(zipOf([n("1") + ".osu"]), { beatmaps: [{ mode_int: 0, checksum: null }] }), false);
  assert.equal(await cx.osuStale(zipOf([n("1") + ".osu"]), { beatmaps: [{ mode_int: 3, checksum: n("2") }, { mode_int: 0, checksum: n("1") }] }), false); // (other modes don't count)
});

// what a mirror itself lists for the set against osu!'s, before downloading from it
test("sumsOlder: a mirror that lists osu!'s checksums has the same version, one that lacks one is older, no list: can't tell", () => {
  const cx = make(null, null), c = x => "b".repeat(31) + x, set = { beatmaps: [{ mode_int: 0, checksum: c("1") }, { mode_int: 0, checksum: c("2") }, { mode_int: 3, checksum: c("9") }] };
  assert.equal(cx.sumsOlder([{ checksum: c("1") }, { checksum: c("2") }], set), false);
  assert.equal(cx.sumsOlder([{ checksum: c("1") }, { checksum: c("2") }, { checksum: c("3") }], set), false); // (extra ones don't matter)
  assert.equal(cx.sumsOlder([{ checksum: c("1") }, { checksum: c("8") }], set), true); // one changed
  assert.equal(cx.sumsOlder([{ checksum: c("8") }], { beatmaps: [{ mode_int: 0, checksum: c("1") }] }), true); // a single difficulty, updated: told apart here (not by the files)
  assert.equal(cx.sumsOlder([], set), null); assert.equal(cx.sumsOlder(undefined, set), null);
  assert.equal(cx.sumsOlder([{ checksum: null }, {}], set), null); // (no checksums in the list)
  assert.equal(cx.sumsOlder([{ checksum: c("1") }], null), null); assert.equal(cx.sumsOlder([{ checksum: c("1") }], { beatmaps: [] }), null);
});
