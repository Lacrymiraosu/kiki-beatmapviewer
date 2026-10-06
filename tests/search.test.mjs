// The osu!-style search keywords (js/osudata.js kwParse & co.) and how js/api.js sends them to each mirror and filters
// the results here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts, J } from "./lib/browser.mjs";

// api.js fills the Mirror select when it loads: a tiny DOM stub; fetch answers from FAKE (url -> json) and logs the URLs
const seen = [], FAKE = new Map();
const fetch = async url => { seen.push(url); const hit = [...FAKE].find(([k]) => url.includes(k)); return { ok: true, json: async () => hit ? hit[1] : [] }; };
const STUB = `const S = { mirror: "osudirect" }; const tr = s => s; const save = () => {}; const toast = () => {};
const $ = () => ({ add() {}, set innerHTML(v) {}, set value(v) {}, set onchange(v) {} }); function Option() {} function addEventListener() {}`;
const P = loadScripts(["js/api.js", "js/osudata.js"], STUB, { fetch, AbortController, setTimeout, clearTimeout, URLSearchParams });
const parse = q => J(P.kwParse(q));
const terms = q => parse(q).terms.map(t => `${t.key}${t.op}${t.v}`);

test("key=value and key:value, quotes, operators, aliases; the rest is free text", () => {
  assert.deepEqual(terms('source="touhou" stars>5 night'), ["source=touhou", "stars>5"]);
  assert.equal(parse('source="touhou" stars>5 night').text, "night");
  assert.deepEqual(terms("mapper:kiki sr<=6.5 star>=4 drain>90 dr<5 accuracy=8 diff=insane tags:jazz"),
    ["creator=kiki", "stars<=6.5", "stars>=4", "drain>90", "hp<5", "od=8", "difficulty=insane", "tag=jazz"]);
  assert.deepEqual(terms('title="night of nights" artist==xi bpm>:180 cs<:4'), ["title=night of nights", "artist=xi", "bpm>=180", "cs<=4"]);
  assert.deepEqual(terms("ARTIST=Xi"), ["artist=Xi"], "keys in any case");
  const p = parse('"freedom dive" ar=9.3');
  assert.equal(p.text, '"freedom dive"'); assert.deepEqual(terms('"freedom dive" ar=9.3'), ["ar=9.3"]);
});

test("things that only look like keywords stay text", () => {
  for (const q of ["foo=bar", "stars>abc", "artist>xi", "status=nope", "ranked>yesterday", "artist=", "https://osu.ppy.sh/beatmapsets/1", "length<forever", "re:zero"])
    assert.deepEqual(parse(q).terms, [], q);
  assert.equal(parse("re:zero  starts").text, "re:zero starts");
});

test("Object.prototype names are not keys, aliases or statuses (status=__proto__ in a link can't break the list)", () => {
  for (const q of ["status=__proto__", "status=constructor", "status=toString", "status=hasOwnProperty", "__proto__=2024", "constructor=x",
    "toString=5", "stars=__proto__", "__proto__:ranked", 'status="__proto__"']) {
    assert.doesNotThrow(() => { P.kwParse(q); P.kwOsuQuery(q); P.kwStrip(q); P.kwMirrorQ(P.kwParse(q)); P.kwStatus(P.kwParse(q)); }, q);
    assert.deepEqual(parse(q).terms, [], q);
    assert.equal(P.kwStatus(P.kwParse(q)), "", q);
  }
  assert.deepEqual(terms("status=__proto__ status=l"), ["status=loved"]);
  assert.equal(P.kwLabel({ key: "stars", op: ">", v: 5 }), "stars>5", "kwLabel copes with a non-string value");
  for (const m of P.MIRRORS.filter(m => m.search))
    for (const st of ["__proto__", "constructor", "a&b=c"]) {
      const u = m.search({ q: "x", st, page: 0 });
      if (u) assert.ok(!/\[object|function|&b=c/.test(u), `${m.id}: ${u}`);
    }
});

test("unterminated quotes run to the end; \"…\"! is an exact match", () => {
  assert.deepEqual(terms('artist="ryu hayabusa'), ["artist=ryu hayabusa"]);
  const t = parse('creator="kiki"! x').terms[0];
  assert.equal(t.exact, true); assert.equal(t.v, "kiki");
});

test("length: seconds, units and m:ss, with osu!'s rounding", () => {
  const len = q => { const t = parse(q).terms[0]; return [t.n, t.tol]; };
  assert.deepEqual(len("length<120"), [120, .5]);
  assert.deepEqual(len("length<2:30"), [150, .5]);
  assert.deepEqual(len("length<1:02:03"), [3723, .5]);
  assert.deepEqual(len("length=2m"), [120, 30]);
  assert.deepEqual(len("length>2m30s"), [150, .5]);
  assert.deepEqual(len("length<1h"), [3600, 1800]);
});

test("status values and their osu! letters; dates by year, month or day", () => {
  assert.deepEqual(terms("status=l status:Ranked status=g"), ["status=loved", "status=ranked", "status=graveyard"]);
  assert.equal(P.kwStatus(P.kwParse("status=q x")), "qualified");
  const d = q => { const t = parse(q).terms[0]; return [new Date(t.from).toISOString().slice(0, 10), new Date(t.to).toISOString().slice(0, 10)]; };
  assert.deepEqual(d("ranked>2024"), ["2024-01-01", "2025-01-01"]);
  assert.deepEqual(d("created<2020-02"), ["2020-02-01", "2020-03-01"]);
  assert.deepEqual(d("updated=2025.6.30"), ["2025-06-30", "2025-07-01"]);
});

test("osu! gets the text as typed, aliases renamed, drain left out (filtered here), lengths in seconds", () => {
  assert.equal(P.kwOsuQuery('source="touhou" stars>5'), 'source=touhou stars>5');
  assert.equal(P.kwOsuQuery('title="night of nights" night'), 'title="night of nights" night');
  assert.equal(P.kwOsuQuery("mapper:kiki sr<=6.5 star>4 dr<5 hp>2 accuracy=8"), "creator=kiki stars<=6.5 star>4 dr<5 hp>2 od=8");
  assert.equal(P.kwOsuQuery("freedom dive drain>90"), "freedom dive");
  assert.equal(P.kwOsuQuery("length<2:30 length=2m"), "length<150 length>=90 length<150");
  assert.equal(P.kwOsuQuery("status=l ranked>2024 foo=bar"), "status=loved ranked>2024 foo=bar");
  assert.deepEqual(J(P.kwOsuLocal(P.kwParse("drain>90 stars>5"))).map(t => t.key), ["drain"]);
});

test("mirrors: the words of the text keys, the keys they know osu!-style, the rest left to the filter", () => {
  const kw = P.kwParse('night source="touhou" artist=xi stars>5 creator="some one" tag="tech/slider tech" status=loved');
  assert.equal(P.kwMirrorQ(kw), "night touhou xi some one");
  assert.equal(P.kwMirrorQ(kw, ["creator", "stars"]), 'night touhou xi stars>5 creator="some one"');
  assert.equal(P.kwStrip('night stars>5 status=loved', t => t.kind === "status"), "night stars>5");
  assert.equal(P.kwStrip('night  stars>5 artist=xi'), "night");
  assert.equal(P.kwText("stars>5"), ""); assert.equal(P.defSort("stars>5", ""), "updated_desc"); assert.equal(P.defSort("night stars>5", ""), "relevance_desc");
});

const set = (o = {}) => ({ id: 1, title: "Night of Nights", title_unicode: "ナイト・オブ・ナイツ", artist: "COOL&CREATE", artist_unicode: "", creator: "kiki", source: "Touhou Project", tags: "jazz beat",
  status: "ranked", bpm: 180, submitted_date: "2019-05-01T00:00:00Z", ranked_date: "2024-03-02T00:00:00Z", last_updated: "2024-02-20T00:00:00Z",
  beatmaps: [
    { id: 11, mode: "osu", mode_int: 0, version: "Normal", difficulty_rating: 2.3, cs: 3, ar: 5, accuracy: 4, drain: 3, total_length: 150, hit_length: 140, bpm: 180 },
    { id: 12, mode: "osu", mode_int: 0, version: "Rin's Insane", difficulty_rating: 5.4, cs: 4, ar: 9.3, accuracy: 8.5, drain: 6, total_length: 150, hit_length: 140, bpm: 180, owners: [{ id: 9, username: "Rin" }] },
  ], ...o });
const match = (q, s = set()) => P.kwMatch(P.normSet(s), P.kwParse(q).terms);

test("filtering a set: text keys, numbers on one difficulty, status, dates", () => {
  for (const q of ['source="touhou"', "source=project", "artist=cool", "title=ナイト", "title=nights", "creator=kiki", "mapper=rin", "tag=jazz", "difficulty=insane",
    "stars>5", "stars=5.4", "sr<=2.3", "ar>9", "ar=9.3", "cs=4", "od>=8.5", "hp<4", "bpm>=180", "length<2:31", "length=2m", "drain>=140", "status=ranked", "status=r",
    "ranked>=2024", "ranked=2024-03", "created<2020", "updated<2024-03", "stars>5 ar>9 cs=4", 'creator="kiki"!'])
    assert.ok(match(q), q);
  for (const q of ['source="umineko"', "artist=xi", "creator=sotarks", "tag=rock", "difficulty=extra", "stars>6", "stars=5.3", "ar>9.3", "cs<3", "hp>6", "bpm>180", "length<2:30",
    "length>3m", "drain>140", "status=loved", "ranked<2024", "created>2019-05", "updated>=2024-03", 'creator="kik"!',
    "stars>5 ar<9"]) // (the 5.4★ difficulty has AR 9.3, the AR 5 one is 2.3★: no single difficulty passes both)
    assert.ok(!match(q), q);
  assert.ok(match('tag="tech/slider tech"'), "player tags: only osu! knows them, not filtered here");
  assert.ok(!match("ranked>2000", set({ ranked_date: null, status: "graveyard" })), "no ranked date: not ranked");
  assert.ok(match("status=ranked", set({ status: "approved" })), "approved counts as ranked, like the status chips");
});

test("each mirror gets its own query; results are filtered here whichever answers", async () => {
  const hit = [set(), set({ id: 2, title: "Other", source: "", beatmaps: [{ id: 21, mode_int: 0, version: "Hard", difficulty_rating: 6.1, cs: 4, ar: 9.5, accuracy: 9, drain: 5, total_length: 100, hit_length: 90, bpm: 200 }] })];
  FAKE.clear(); FAKE.set("osu.direct", hit); FAKE.set("nerinyan", hit); FAKE.set("catboy", hit);
  const kw = P.kwParse('source="touhou" stars>5 status=loved');
  for (const id of ["osudirect", "nerinyan", "catboy"]) {
    seen.length = 0;
    const r = J(await P.searchSets({ q: 'source="touhou" stars>5 status=loved', creator: "", st: "leaderboard", page: 0, kw }, null, id));
    assert.equal(r.list.length, 0, id + ": the ranked set isn't loved"); // (status=loved replaces the chip's Has leaderboard)
    const u = new URL(seen[0]);
    if (id === "osudirect") { assert.equal(u.searchParams.get("q"), "touhou"); assert.equal(u.searchParams.get("status"), "4"); }
    if (id === "nerinyan") { assert.equal(u.searchParams.get("q"), "touhou"); assert.equal(u.searchParams.get("s"), "loved"); }
    if (id === "catboy") { assert.equal(u.searchParams.get("q"), "touhou stars>5"); assert.equal(u.searchParams.get("status"), "4"); }
  }
  P.jsonCache.clear();
  const kw2 = P.kwParse('source="touhou" stars>5');
  const r2 = J(await P.searchSets({ q: 'source="touhou" stars>5', creator: "", st: "", page: 0, kw: kw2 }, null, "osudirect"));
  assert.deepEqual(r2.list.map(s => s.id), [1], "set 2 has no source, set 1 passes");
  // creator plus numbers on Nerinyan: its creator search, the numbers filtered here
  seen.length = 0; P.jsonCache.clear();
  await P.searchSets({ q: "creator=kiki stars>5", creator: "", st: "", page: 0, kw: P.kwParse("creator=kiki stars>5") }, null, "nerinyan");
  const n = new URL(seen[0]); assert.equal(n.searchParams.get("q"), "kiki"); assert.equal(n.searchParams.get("option"), "creator");
  // catboy answering nothing to the keywords (e.g. it didn't read them): asked again with words only, filtered here
  seen.length = 0; P.jsonCache.clear(); FAKE.clear(); FAKE.set("stars%3E5", []); FAKE.set("catboy", hit);
  const r3 = J(await P.searchSets({ q: 'source="touhou" stars>5', creator: "", st: "", page: 0, kw: kw2 }, null, "catboy"));
  assert.equal(seen.length, 2); assert.equal(new URL(seen[1]).searchParams.get("q"), "touhou"); assert.deepEqual(r3.list.map(s => s.id), [1]);
});
