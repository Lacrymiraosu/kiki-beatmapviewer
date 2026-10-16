// js/create.js planOsuAdd: the decisions behind "add a .osu file into the open set" (Setup tab button, .osu dropped on the Editor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadScripts, J } from "./lib/browser.mjs";

// the real putKeys / putSection / sectionRange / safeName from js/editor.js (the rest of that file needs the page)
const ed = readFileSync(new URL("../js/editor.js", import.meta.url), "utf8");
const grab = (from, to) => { const a = ed.indexOf(from), b = ed.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return ed.slice(a, b); };
const helpers = grab("function sectionRange(", "function editedText()") + grab("const safeName = ", "\nfunction exportOsu()");
const P = loadScripts(["js/parse.js", "js/create.js"], helpers + "\nfunction addEventListener() {}\n");

const osu = ({ mode = 0, version = "Hard", bid = 111, sid = 50, audio = "audio.mp3", title = "Song", artist = "Band", extra = "", eol = "\n", objs = ["256,192,1000,1,0,0:0:0:0:", "100,100,2000,1,0,0:0:0:0:"] } = {}) => [
  "osu file format v14", "", "[General]", `AudioFilename: ${audio}`, "AudioLeadIn: 0", `Mode: ${mode}`, "", "[Metadata]", `Title:${title}`, `Artist:${artist}`, "Creator:Me", `Version:${version}`,
  `BeatmapID:${bid}`, `BeatmapSetID:${sid}`, "Tags:a b", "", "[Difficulty]", "HPDrainRate:5", "CircleSize:4", "OverallDifficulty:8", "ApproachRate:9", "SliderMultiplier:1.4", "SliderTickRate:1", "",
  "[TimingPoints]", "0,500,4,2,0,100,1,0", "", extra, "[HitObjects]", ...objs, ""].join(eol);
const ctx = (o = {}) => ({ versions: ["Normal", "Hard"], paths: ["audio.mp3", "band - song (me) [normal].osu", "band - song (me) [hard].osu"], setId: 50, usedBids: [111, 112], audioName: "audio.mp3", hasAudio: n => n.toLowerCase() === "audio.mp3",
  meta: { Artist: "Band", Title: "Song", Creator: "Me" }, ...o });
const plan = (text, o) => J(P.planOsuAdd(text, ctx(o)));
const get = (text, k) => (text.match(new RegExp("^" + k + "\\s*:\\s*(.*)$", "m")) || [])[1];

test("a plain osu!standard difficulty with a new name is accepted; the file name is built from the set", () => {
  const r = plan(osu({ version: "Insane" }));
  assert.equal(r.ok, true); assert.equal(r.version, "Insane"); assert.equal(r.path, "Band - Song (Me) [Insane].osu");
  assert.equal(get(r.text, "Version"), "Insane");
  assert.equal(P.parseOsu(r.text).lines.length, 2, "objects untouched");
});

test("osu!mania, other modes, garbage, empty, binary and oversized files are refused", () => {
  assert.equal(plan(osu({ mode: 3, version: "4K" })).error, "mania");
  assert.equal(plan(osu({ mode: 1, version: "Taiko" })).error, "mode");
  assert.equal(plan(osu({ mode: 2, version: "Catch" })).error, "mode");
  assert.equal(plan("hello world, not a map").error, "notosu");
  assert.equal(plan("[HitObjects]\n1,2,3").error, "notosu", "no header or [General]");
  assert.equal(plan("   \n").error, "empty");
  assert.equal(plan("").error, "empty");
  assert.equal(plan("osu file format v14\n[General]\n[HitObjects]\n\u0000\u0001").error, "notosu");
  assert.equal(plan(osu({ version: "Big", extra: "// " + "x".repeat(4 * 1024 * 1024) })).error, "big");
});

test("a missing Mode line means osu!standard", () => {
  assert.equal(plan(osu({ version: "NoMode" }).replace(/^Mode: 0\n/m, "")).ok, true);
});

test("the UTF-8 BOM is stripped and line endings are kept", () => {
  const r = plan("﻿" + osu({ version: "Bom", eol: "\r\n" }));
  assert.equal(r.ok, true); assert.ok(!r.text.startsWith("﻿"), "no BOM"); assert.ok(r.text.startsWith("osu file format v14\r\n"));
  assert.ok(!/[^\r]\n/.test(r.text), "still CRLF only");
  assert.equal(plan("﻿" + osu({ version: "Bom2" })).text.includes("\r"), false, "LF stays LF");
});

test("a version that is already in the set (any case) needs another name", () => {
  const r = plan(osu({ version: "hArD" }));
  assert.equal(r.ok, false); assert.equal(r.error, "dupversion"); assert.equal(r.version, "hArD"); assert.equal(r.suggest, "hArD (2)");
  assert.equal(plan(osu({ version: "Hard" }), { versions: ["Hard", "Hard (2)", "HARD (3)"] }).suggest, "Hard (4)");
  const ok = plan(osu({ version: "Hard" }), { version: "Hard (2)" });
  assert.equal(ok.ok, true); assert.equal(ok.version, "Hard (2)"); assert.equal(get(ok.text, "Version"), "Hard (2)"); assert.equal(ok.path, "Band - Song (Me) [Hard (2)].osu");
  assert.equal(plan(osu({ version: "x" }), { version: " NORMAL " }).error, "dupversion", "a chosen name is checked too");
});

test("a missing Version gets the file's name; control characters and path characters are cleaned", () => {
  const t = osu({}).replace(/^Version:.*\n/m, "");
  const r = plan(t, { fallbackVersion: "my diff" }); assert.equal(r.ok, true); assert.equal(r.version, "my diff"); assert.equal(get(r.text, "Version"), "my diff");
  const w = plan(osu({ version: "a/b:c\tx" })); assert.equal(w.version, "a/b:c x"); assert.equal(w.path, "Band - Song (Me) [a_b_c x].osu");
});

test("the file name never collides (case-insensitive) with anything in the package, and keeps its .osu ending", () => {
  const r = plan(osu({ version: "Extra" }), { paths: ["band - song (me) [extra].osu", "BAND - SONG (ME) [EXTRA] (2).OSU".toLowerCase()] });
  assert.equal(r.path, "Band - Song (Me) [Extra] (3).osu");
  const long = plan(osu({ version: "V" }), { meta: { Artist: "A".repeat(300), Title: "T", Creator: "C" } });
  assert.ok(long.path.endsWith(".osu") && long.path.length <= 150, long.path.length);
  assert.ok(!/[\\/]/.test(plan(osu({ version: "../x" })).path), "no slash or backslash (the server also refuses a .. segment)");
});

test("BeatmapID: kept only for this set's id, when positive and unused; otherwise 0", () => {
  assert.equal(get(plan(osu({ version: "A", bid: 999, sid: 50 })).text, "BeatmapID"), "999", "this set, new id");
  assert.equal(get(plan(osu({ version: "A", bid: 111, sid: 50 })).text, "BeatmapID"), "0", "used by another diff");
  assert.equal(get(plan(osu({ version: "A", bid: 999, sid: 77 })).text, "BeatmapID"), "0", "another set");
  assert.equal(get(plan(osu({ version: "A", bid: 999, sid: 0 })).text, "BeatmapID"), "0", "unknown set");
  assert.equal(get(plan(osu({ version: "A", bid: 999, sid: 50 }), { setId: 0 }).text, "BeatmapID"), "0", "this set has no id");
  assert.equal(get(plan(osu({ version: "A", bid: 999, sid: 50 }), { setId: null }).text, "BeatmapID"), "0");
  assert.equal(get(plan(osu({ version: "A", bid: -5, sid: 50 })).text, "BeatmapID"), "0");
  assert.ok(plan(osu({ version: "A", bid: 999, sid: 77 })).notes.includes("bid"));
  assert.ok(!plan(osu({ version: "A", bid: 999, sid: 50 })).notes.includes("bid"));
  assert.equal(get(plan(osu({ version: "A", bid: 999, sid: 77 })).text, "BeatmapSetID"), "77", "the rest of the metadata is as the file has it");
});

test("AudioFilename: rewritten to the set's song when the file's isn't in the package, kept when it is", () => {
  const r = plan(osu({ version: "A", audio: "other song.mp3" }));
  assert.equal(get(r.text, "AudioFilename"), "audio.mp3"); assert.ok(r.notes.includes("audio")); assert.equal(r.audio, "audio.mp3");
  const k = plan(osu({ version: "A", audio: "AUDIO.MP3" })); assert.equal(get(k.text, "AudioFilename"), "AUDIO.MP3"); assert.ok(!k.notes.includes("audio"));
  assert.equal(get(plan(osu({ version: "A", audio: "x.mp3" }), { audioName: "" }).text, "AudioFilename"), "x.mp3", "the set has no song: left alone");
  const none = plan(osu({ version: "A" }).replace(/^AudioFilename:.*\n/m, "")); assert.equal(get(none.text, "AudioFilename"), "audio.mp3", "a missing line is added");
});

test("other metadata is not touched; a different title or artist is reported", () => {
  const r = plan(osu({ version: "A", title: "Other", artist: "Someone", sid: 50 }));
  assert.equal(get(r.text, "Title"), "Other"); assert.equal(get(r.text, "Artist"), "Someone"); assert.equal(get(r.text, "Tags"), "a b"); assert.ok(r.notes.includes("meta"));
  assert.ok(!plan(osu({ version: "B", title: "song", artist: " BAND " })).notes.includes("meta"), "case and spaces don't count");
  assert.equal(r.path, "Band - Song (Me) [A].osu", "the name follows the set, not the file");
});

test("the result parses with the same objects as the source", () => {
  const src = osu({ version: "Z", objs: ["64,64,500,1,0", "128,128,900,1,0", "192,192,1300,5,0"] });
  const r = plan(src), a = P.parseOsu(src), b = P.parseOsu(r.text);
  assert.equal(b.lines.length, a.lines.length); assert.equal(b.hit.length, a.hit.length);
  assert.deepEqual(J(b.lines.map(l => l.s)), J(a.lines.map(l => l.s)));
});
