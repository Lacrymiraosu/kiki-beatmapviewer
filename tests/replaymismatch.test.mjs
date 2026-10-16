// A replay watched on a beatmap whose file is not the one it was made on (the MD5 differs; js/replayui.js rpuMismatch): before it plays, a
// dialog says what osu! knows about the map's set, its status and last update, against the day the replay was played, and asks to watch anyway.
// The functions are cut out of js/replayui.js and run in a vm with stubs for the page's globals.
import { test } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import vm from "node:vm";
const src = readFileSync(new URL("../js/replayui.js", import.meta.url), "utf8");
const a = src.indexOf("const RPU_STATUS = {"), b = src.indexOf("// the replay's beatmap found and open (Watch and Analysis)"), c = src.indexOf("// a downloaded set has the replay's difficulty"), e = src.indexOf("async function rpuLoadMap(s) {");
assert.ok(c > 0 && e > c, "replayui.js: rpuAccept moved");
assert.ok(a > 0 && b > a, "replayui.js: the mismatch block moved");
function make(over = {}) {
  const dialogs = [], loads = [], calls = [];
  const cx = { md5Hex: x => String.fromCharCode(...x), console, Date, Promise, setTimeout, Number, String, Math, map: { meta: { BeatmapSetID: "55" } },
    tr: (k, o) => o ? k.replace(/\{(\w+)\}/g, (_, n) => o[n]) : k, fmtDate: v => "D" + new Date(v).toISOString().slice(0, 10), rpuId: v => +v > 0 ? +v : 0,
    showLoading: t => loads.push(t), open: (u, ...r) => calls.push("open " + u), osuDlURL: sid => "https://osu/" + sid, toast: m => calls.push("toast " + m), hideLoading: () => loads.push("hide"),
    rpuLoadMap: async () => { calls.push("load"); return cx.loadOk; }, rpuVerify: async () => cx.exact, loadOk: true, exact: true, oszDrop: async id => calls.push("drop" + id), kept: true, oszGet: async () => cx.kept ? { blob: 1 } : null,
    modal: async o => { dialogs.push(o); return cx.answer; }, answer: true, osuSet: async id => cx.set, set: null, ...over };
  vm.createContext(cx); vm.runInContext(src.slice(a, b) + src.slice(c, e) + "\nthis.api = { rpuMismatchText, rpuMismatch, rpuRefetch, rpuAccept };", cx);
  return { cx, dialogs, loads, calls, api: cx.api };
}
const D = s => Date.parse(s);
test("the map was updated after the replay: it says so, with the status and both days", () => {
  const { api } = make();
  const t = api.rpuMismatchText({ status: "graveyard", last_updated: "2024-05-02T10:00:00Z", ranked_date: null }, D("2024-01-10T00:00:00Z"));
  assert.match(t, /updated after this replay was played/); assert.match(t, /Status: Graveyard/); assert.match(t, /Last updated: D2024-05-02/); assert.match(t, /Replay played: D2024-01-10/); assert.match(t, /Watch it anyway\?$/);
});
test("a replay older than the map's ranking: it names the status", () => {
  const { api } = make();
  const t = api.rpuMismatchText({ status: "ranked", last_updated: "2023-01-01T00:00:00Z", ranked_date: "2023-06-01T00:00:00Z" }, D("2023-03-01T00:00:00Z"));
  assert.match(t, /before the map became Ranked/); assert.doesNotMatch(t, /updated after/);
});
test("nothing explains it (not updated after, not ranked after): the file just is not the replay's", () => {
  const { api } = make();
  const t = api.rpuMismatchText({ status: "ranked", last_updated: "2022-01-01T00:00:00Z", ranked_date: "2022-02-01T00:00:00Z" }, D("2023-03-01T00:00:00Z"));
  assert.match(t, /isn't the one the replay was made on/); assert.match(t, /Status: Ranked/);
});
test("osu! gave no answer: still a dialog, saying the status couldn't be checked; a replay without a date has no day line", () => {
  const { api } = make();
  const t = api.rpuMismatchText(null, null);
  assert.match(t, /Couldn't check/); assert.doesNotMatch(t, /Replay played|Status:|Last updated/);
});
test("the dialog asks once per replay and map; Cancel stops the Watch; the set id comes from the replay or the open map", async () => {
  const { cx, api, dialogs } = make({ set: { status: "loved", last_updated: "2025-01-01T00:00:00Z", ranked_date: "2024-01-01T00:00:00Z" } });
  const s = { info: { setId: 0 }, data: { date: D("2024-06-01T00:00:00Z") } }; let asked = null; cx.osuSet = async id => { asked = id; return cx.set; };
  cx.answer = false; assert.equal(await api.rpuMismatch(s), false); assert.equal(asked, 55); assert.equal(dialogs.length, 1); assert.equal(dialogs[0].buttons.length, 2);
  assert.equal(s.mismatchOk, false); cx.answer = true; assert.equal(await api.rpuMismatch(s), true); assert.equal(dialogs.length, 2);
  assert.equal(await api.rpuMismatch(s), true); assert.equal(dialogs.length, 2, "already accepted: not asked again");
});
test("osu! slow or failing: the dialog still comes (without the facts), the cover is hidden after", async () => {
  const { cx, api, dialogs, loads } = make();
  cx.osuSet = () => Promise.reject(new Error("x")); const s = { info: { setId: 9 }, data: {} };
  assert.equal(await api.rpuMismatch(s), true); assert.equal(dialogs.length, 1); assert.match(dialogs[0].body, /Couldn't check/); assert.equal(loads.at(-1), "hide");
});
test("a mismatch with a kept copy: the copy is dropped and the set downloaded again, once; the replay's version then plays with no dialog", async () => {
  const { cx, api, calls } = make(); const s = { info: { setId: 55 }, data: {}, loaded: { x: 1 } };
  assert.equal(await api.rpuRefetch(s), "exact"); assert.deepEqual(calls, ["drop55", "load"]); assert.equal(s.loaded, null); assert.equal(s.refetched, true);
  cx.exact = false; assert.equal(await api.rpuRefetch(s), "mismatch"); assert.equal(calls.length, 2, "once only");
});
test("still different after the new download: mismatch (the dialog); a cancelled download: cancel; no kept copy or a map given by hand: no download", async () => {
  const a = make({ exact: false }); assert.equal(await a.api.rpuRefetch({ info: { setId: 55 }, data: {} }), "mismatch"); assert.deepEqual(a.calls, ["drop55", "load"]);
  const b = make({ loadOk: false }); assert.equal(await b.api.rpuRefetch({ info: { setId: 55 }, data: {} }), "cancel");
  const c = make({ kept: false }); assert.equal(await c.api.rpuRefetch({ info: { setId: 55 }, data: {} }), "mismatch"); assert.deepEqual(c.calls, []);
  const d = make(); assert.equal(await d.api.rpuRefetch({ info: { setId: 55 }, data: {}, local: {} }), "mismatch"); assert.deepEqual(d.calls, []);
});
test("osu! confirms the replay is on the current version: the dialog says the copy is the older one", () => {
  const { api } = make(); const t = api.rpuMismatchText({ status: "pending", last_updated: "2020-01-01T00:00:00Z" }, D("2024-01-01T00:00:00Z"), true);
  assert.match(t, /current version, so the copy that was downloaded is an older one/); assert.match(t, /Status: Pending/);
});
test("a downloaded set is the replay's when one of its .osu files has the replay's MD5", async () => {
  const { api } = make(); const file = txt => ({ dir: false, async: async () => new TextEncoder().encode(txt) });
  const zip = files => ({ forEach: f => { for (const [p, x] of Object.entries(files)) f(p, x); } });
  const s = { data: { mapMd5: "ab" } };
  assert.equal(await api.rpuAccept(s)(zip({ "a.osu": file("xx"), "b.osu": file("ab"), "song.mp3": file("ab") })), true);
  assert.equal(await api.rpuAccept(s)(zip({ "a.osu": file("xx"), "song.mp3": file("ab") })), false, "only .osu files count");
  assert.equal(await api.rpuAccept(s)(zip({})), false);
});
test("osu! says the replay is current and no mirror had it: a Download from osu! button opens osu!'s page, tells to drop the .osz, and stops the Watch", async () => {
  const { cx, api, dialogs, calls } = make(); const s = { info: { setId: 55 }, data: {}, current: true };
  cx.modal = async o => { dialogs.push(o); const b = o.buttons.find(x => /Download from osu/.test(x.label)); return b.value(); };
  assert.equal(await api.rpuMismatch(s), false); assert.equal(dialogs[0].buttons.length, 3); assert.match(dialogs[0].body, /drop the \.osz/);
  assert.ok(calls.includes("open https://osu/55"), calls.join()); assert.ok(calls.some(c => /^toast When the download finishes/.test(c))); assert.notEqual(s.mismatchOk, true);
});
test("without osu!'s confirmation there is no such button", async () => {
  const { api, dialogs } = make(); await api.rpuMismatch({ info: { setId: 55 }, data: {} });
  assert.equal(dialogs[0].buttons.length, 2); assert.doesNotMatch(dialogs[0].body, /drop the \.osz/);
});
