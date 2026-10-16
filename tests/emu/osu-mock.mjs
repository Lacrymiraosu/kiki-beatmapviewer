// A stand-in for osu!api v2 (token, users, their maps and activity, beatmap search, tags, one beatmapset), with made-up data, for local tests only.
//   node tests/emu/osu-mock.mjs [port]     (default 54330)
import http from "node:http";

const USERS = {
  4242: { id: 4242, username: "TestMapper", avatar_url: "https://a.ppy.sh/4242", country_code: "TH", country: { name: "Thailand" }, join_date: "2015-06-01T00:00:00+00:00",
    title: null, is_supporter: true, playmode: "osu", previous_usernames: ["OldName"], follower_count: 1234, mapping_follower_count: 321, kudosu: { total: 99 },
    ranked_beatmapset_count: 3, loved_beatmapset_count: 1, pending_beatmapset_count: 0, graveyard_beatmapset_count: 45, guest_beatmapset_count: 2, nominated_beatmapset_count: 0,
    statistics: { global_rank: 12345, country_rank: 100, pp: 4567.8, play_count: 9999, hit_accuracy: 98.12, level: { current: 101 }, play_time: 360000, maximum_combo: 2345 },
    rank_highest: { rank: 9876, updated_at: "2021-03-04T00:00:00+00:00" }, favourite_beatmapset_count: 77, beatmap_playcounts_count: 5000,
    groups: [{ id: 28, identifier: "bng", name: "Beatmap Nominators", short_name: "BN", colour: "#A347EB", playmodes: ["osu"], is_probationary: false }],
    badges: [{ awarded_at: "2022-01-01T00:00:00+00:00", description: "Mapping contest winner", image_url: "https://assets.ppy.sh/profile-badges/test.png", "image@2x_url": "https://assets.ppy.sh/profile-badges/test@2x.png", url: "" }],
    user_achievements: [{ achievement_id: 1 }, { achievement_id: 2 }], location: "Bangkok", interests: "streams", occupation: "", website: "https://example.com", twitter: "", discord: "tm#1",
    last_visit: "2026-09-29T10:00:00+00:00", is_online: false, support_level: 1, cover: { url: "" } },
  5151: { id: 5151, username: "NewMapper", avatar_url: "https://a.ppy.sh/5151", country_code: "JP", country: { name: "Japan" }, join_date: "2024-01-01T00:00:00+00:00" }, // (nobody on the site yet)
};
const set = (id, uid, i, status) => ({ id, title: `Song ${i}`, artist: `Artist ${i}`, creator: "TestMapper", user_id: uid, status, play_count: 100 * i, favourite_count: i,
  submitted_date: "2020-01-01T00:00:00Z", ranked_date: status === "ranked" ? "2020-03-01T00:00:00Z" : null, last_updated: "2020-02-01T00:00:00Z", title_unicode: `Song ${i} \u30bd\u30f3\u30b0`, artist_unicode: `Artist ${i}`, hype: null, spotlight: false, video: false, storyboard: false, bpm: 180, source: "", genre_id: i % 2 ? 3 : 10, language_id: i % 2 ? 3 : 2, tags: `album${i} vocaloid`,
  beatmaps: [{ id: id * 10 + 1, version: "Normal", mode: "osu", mode_int: 0, difficulty_rating: 2.1, total_length: 120, hit_length: 110, bpm: 180, cs: 4, ar: 6, accuracy: 5, drain: 4, count_circles: 120, count_sliders: 40, count_spinners: 0, max_combo: 245, status, last_updated: "2020-02-01T00:00:00Z", playcount: 50, passcount: 20, url: `https://osu.ppy.sh/beatmaps/${id * 10 + 1}`, ranked: 1 },
             { id: id * 10 + 2, version: "Insane", mode: "osu", mode_int: 0, difficulty_rating: 5.3, total_length: 120, hit_length: 110, bpm: 180, cs: 4, ar: 9, accuracy: 8, drain: 6, count_circles: 400, count_sliders: 150, count_spinners: 2, max_combo: 1050, status, last_updated: "2020-02-01T00:00:00Z", playcount: 90, passcount: 10, url: `https://osu.ppy.sh/beatmaps/${id * 10 + 2}`, ranked: 1 }] });
// an older/leaner answer: none of the per-difficulty counts (the page must show no such columns, not zeros)
const lean = x => ({ ...x, beatmaps: x.beatmaps.map(({ count_circles, count_sliders, count_spinners, max_combo, playcount, passcount, url, ranked, ...b }) => b) });
const LISTS = { ranked: [1, 2, 3].map(i => set(1000 + i, 4242, i, "ranked")), loved: [set(2001, 4242, 4, "loved")], guest: [set(3001, 99, 5, "ranked"), lean(set(3002, 98, 6, "ranked"))],
  graveyard: Array.from({ length: 45 }, (_, i) => set(4000 + i, 4242, 10 + i, "graveyard")), pending: [], nominated: [] };
const TAGS = [{ id: 1, name: "skillset/tech", ruleset_id: 0, description: "Tests uncommon skills." }, { id: 2, name: "tech/slider tech", ruleset_id: 0, description: "Tests uncommon skills involving sliders." },
  { id: 3, name: "style/clean", ruleset_id: 0, description: "Visually uncluttered and organised patterns." }, { id: 4, name: "skillset/streams", ruleset_id: null, description: "Continuous note hits." }];
const SET_TAGS = { 1001: [2, 3], 1002: [1], 1003: [3] }; // user tags voted on the first beatmap of these sets
const allSets = () => [...LISTS.ranked, ...LISTS.loved, ...LISTS.graveyard];
export const calls = [];
export const hits = {}; // calls per path (pathname), e.g. hits["/api/v2/beatmaps/7001/scores"]
export const apiVersions = {}; // the x-api-version header of the last call per path ("" without it), e.g. apiVersions["/api/v2/beatmaps/7006/scores"]
// top scores of a difficulty (/beatmaps/<id>/scores): 7001 legacy shape (mods as strings, count_300...), 7002 lazer shape (mods as { acronym }, great/ok/meh, ended_at),
// 7003 sixty scores (only 50 may come out), 7005 a map nobody has played (empty list), 7004 answers 403 (osu! refusing the app token), 7100-7999 one score each
// (slowly: for requests in flight at once), any other id 404. Only mode=osu&type=global is answered.
// 7006 answers like osu! itself, by the x-api-version header: below 20220705 (or without it) the legacy shape, where a score set on lazer has
// score = legacy_total_score = 0; from 20220705 the lazer shape (classic_total_score, legacy_total_score, standardised total_score, mods as
// { acronym, settings }, statistics without the zero counts, ended_at; a stable score has legacy_score_id and the CL mod).
export const SCORES_LEGACY = 7001, SCORES_LAZER = 7002, SCORES_MANY = 7003, SCORES_DENIED = 7004, SCORES_EMPTY = 7005, SCORES_VERSIONED = 7006;
const VUSER = (id, name, cc) => ({ id, username: name, country_code: cc, avatar_url: "https://a.ppy.sh/" + id, default_group: "default", is_active: true, country: { code: cc, name: "x" }, cover: { url: "https://assets.ppy.sh/c.jpg" }, team: null });
const VERSIONED = { // the same three plays in both shapes: [new shape, legacy shape]
  stable: [{ classic_total_score: 11800000, preserve: true, processed: true, ranked: true, maximum_statistics: { great: 700, legacy_combo_increase: 300 }, mods: [{ acronym: "HD" }, { acronym: "CL" }],
      statistics: { great: 690, ok: 8, meh: 1, miss: 1 }, beatmap_id: 7006, best_id: null, id: 3000000001, rank: "S", type: "solo_score", user_id: 301, accuracy: 0.9876, build_id: null,
      ended_at: "2024-05-01T10:00:00Z", has_replay: true, is_perfect_combo: false, legacy_perfect: false, legacy_score_id: 4500000001, legacy_total_score: 12500000, max_combo: 980, passed: true,
      pp: 250.5, ruleset_id: 0, started_at: null, total_score: 912345, replay: true, current_user_attributes: { pin: null }, user: VUSER(301, "StableOne", "DE") },
    { accuracy: 0.9876, best_id: 4500000001, created_at: "2024-05-01T10:00:00Z", id: 4500000001, max_combo: 980, mode: "osu", mode_int: 0, mods: ["HD"], passed: true, perfect: false, pp: 250.5,
      rank: "S", replay: true, score: 12500000, statistics: { count_100: 8, count_300: 690, count_50: 1, count_geki: 0, count_katu: 0, count_miss: 1 }, type: "score_best_osu", user_id: 301, current_user_attributes: { pin: null }, user: VUSER(301, "StableOne", "DE") }],
  lazer: [{ classic_total_score: 11650000, preserve: true, processed: true, ranked: true, maximum_statistics: { great: 700, large_tick_hit: 40 }, mods: [{ acronym: "HD", settings: {} }, { acronym: "DT", settings: { speed_change: 1.4 } }],
      statistics: { great: 695, ok: 5, large_tick_hit: 40 }, beatmap_id: 7006, best_id: null, id: 3000000002, rank: "SH", type: "solo_score", user_id: 302, accuracy: 0.9952, build_id: 7000,
      ended_at: "2025-02-03T04:05:06Z", has_replay: true, is_perfect_combo: true, legacy_perfect: true, legacy_score_id: null, legacy_total_score: 0, max_combo: 1000, passed: true,
      pp: 260.25, ruleset_id: 0, started_at: "2025-02-03T04:01:00Z", total_score: 987654, replay: true, current_user_attributes: { pin: null }, user: VUSER(302, "LazerOne", "KR") },
    { accuracy: 0.9952, best_id: null, created_at: "2025-02-03T04:05:06Z", id: 3000000002, max_combo: 1000, mode: "osu", mode_int: 0, mods: ["HD", "DT"], passed: true, perfect: true, pp: 260.25,
      rank: "SH", replay: true, score: 0, statistics: { count_100: 5, count_300: 695, count_50: 0, count_geki: 0, count_katu: 0, count_miss: 0 }, type: "solo_score", user_id: 302, current_user_attributes: { pin: null }, user: VUSER(302, "LazerOne", "KR") }],
  lazerCl: [{ classic_total_score: 9000000, preserve: true, processed: true, ranked: true, maximum_statistics: { great: 700 }, mods: [{ acronym: "CL" }, { acronym: "NF" }],
      statistics: { great: 600, ok: 80, meh: 10, miss: 10 }, beatmap_id: 7006, best_id: null, id: 3000000003, rank: "B", type: "solo_score", user_id: 303, accuracy: 0.9, build_id: 7000,
      ended_at: "2025-03-01T00:00:00Z", has_replay: false, is_perfect_combo: false, legacy_perfect: false, legacy_score_id: null, legacy_total_score: 0, max_combo: 300, passed: true,
      pp: null, ruleset_id: 0, started_at: null, total_score: 700000, replay: false, current_user_attributes: { pin: null }, user: VUSER(303, "ClassicFan", "FR") },
    { accuracy: 0.9, best_id: null, created_at: "2025-03-01T00:00:00Z", id: 3000000003, max_combo: 300, mode: "osu", mode_int: 0, mods: ["CL", "NF"], passed: true, perfect: false, pp: null,
      rank: "B", replay: false, score: 0, statistics: { count_100: 80, count_300: 600, count_50: 10, count_geki: 0, count_katu: 0, count_miss: 10 }, type: "solo_score", user_id: 303, current_user_attributes: { pin: null }, user: VUSER(303, "ClassicFan", "FR") }],
};
const versioned = ver => ["stable", "lazer", "lazerCl"].map(k => VERSIONED[k][ver >= 20220705 ? 0 : 1]);
const legacyScore = (i, o = {}) => ({ id: 9000 + i, user_id: 100 + i, accuracy: (9876 - i * 10) / 10000, max_combo: 1234 - i, mods: ["HD", "DT"], passed: true, perfect: false, pp: 321.456, rank: "S",
  replay: true, score: 12345678 - i, created_at: "2026-09-01T10:00:00+00:00", mode: "osu", statistics: { count_300: 900, count_100: 10, count_50: 2, count_miss: 1, count_geki: 5, count_katu: 4 },
  beatmap: { id: 7001, big: "x".repeat(2000) }, weight: { percentage: 100, pp: 1 },
  user: { id: 100 + i, username: "Player" + i, country_code: "TH", avatar_url: "https://a.ppy.sh/" + (100 + i), cover: { url: "https://assets.ppy.sh/x.jpg" }, country: { code: "TH", name: "Thailand" } }, ...o });
const SCORES = {
  [SCORES_LEGACY]: [legacyScore(1), legacyScore(2, { mods: [], rank: "A", pp: null, accuracy: 0.95, user: { id: 102, username: "A".repeat(40), country_code: "jp", avatar_url: "http://a.ppy.sh/102" } }),
    legacyScore(3, { mods: ["HDHR", "NC", "bad mod!"], rank: "weird", created_at: "not a date", score: undefined, total_score: 777, accuracy: 7, max_combo: -5, statistics: {} })],
  [SCORES_LAZER]: [{ id: 9101, total_score: 987654, accuracy: 1, max_combo: 500, mods: [{ acronym: "HD", settings: {} }, { acronym: "DT", settings: { speed_change: 1.3 } }], pp: null, rank: "XH", ended_at: "2026-09-02T11:00:00Z",
      statistics: { great: 500, ok: 0, meh: 0, miss: 0, ignore_hit: 3 }, user: { id: 201, username: "Lazer1", country_code: "KR", avatar_url: "https://a.ppy.sh/201" } },
    { id: 9102, total_score: 900000, accuracy: 0.97, max_combo: 450, mods: [], pp: 12.3456, rank: "S", ended_at: "2026-09-03T11:00:00Z",
      statistics: { great: 480, ok: 18, meh: 2, miss: 0 }, user: { id: 202, username: "Lazer2", country_code: "JP", avatar_url: "https://a.ppy.sh/202" } }],
  [SCORES_MANY]: Array.from({ length: 60 }, (_, i) => legacyScore(i + 1)),
  [SCORES_EMPTY]: [],
};
export const LOOKUP_MD5 = "da8aae79c8f3306b5d65ec951874a7fb"; // (osu/lookup finds this one: Song 1 [Insane])

export function startOsuMock(port = 54330) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); calls.push(u.pathname); hits[u.pathname] = (hits[u.pathname] || 0) + 1; apiVersions[u.pathname] = String(req.headers["x-api-version"] || "");
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/oauth/token" && req.method === "POST") return json(200, { access_token: "mock-token", expires_in: 86400, token_type: "Bearer" });
    if ((req.headers.authorization || "") !== "Bearer mock-token") return json(401, { error: "unauthorized" });
    let m;
    if ((m = u.pathname.match(/^\/api\/v2\/users\/([^/]+)\/osu$/))) {
      const key = decodeURIComponent(m[1]), user = key.startsWith("@") ? Object.values(USERS).find(x => x.username.toLowerCase() === key.slice(1).toLowerCase()) : USERS[key];
      return user ? json(200, user) : json(404, { error: null });
    }
    if ((m = u.pathname.match(/^\/api\/v2\/users\/(\d+)\/beatmapsets\/(\w+)$/))) {
      const list = +m[1] === 4242 ? LISTS[m[2]] || [] : [], off = +(u.searchParams.get("offset") || 0), lim = +(u.searchParams.get("limit") || 5);
      return json(200, list.slice(off, off + lim));
    }
    if ((m = u.pathname.match(/^\/api\/v2\/users\/(\d+)\/recent_activity$/))) return json(200, +m[1] !== 4242 ? [] : [
      { id: 1, type: "beatmapsetApprove", created_at: "2026-09-20T00:00:00+00:00", approval: "ranked", beatmapset: { title: "Artist 1 - Song 1", url: "/s/1001" }, user: { username: "TestMapper", url: "/u/4242" } },
      { id: 2, type: "rank", created_at: "2026-09-19T00:00:00+00:00", rank: 5, beatmap: { title: "x", url: "/b/1" } },
      { id: 3, type: "beatmapsetUpload", created_at: "2026-09-10T00:00:00+00:00", beatmapset: { title: "Artist 2 - Song 2", url: "/s/1002" }, user: { username: "TestMapper", url: "/u/4242" } },
      { id: 4, type: "beatmapPlaycount", created_at: "2026-09-05T00:00:00+00:00", count: 1000, beatmap: { title: "Artist 1 - Song 1 [Insane]", url: "/b/10012?m=0" } }]);
    if ((m = u.pathname.match(/^\/api\/v2\/users\/(\d+)\/kudosu$/))) return json(200, +m[1] !== 4242 ? [] : [
      { id: 9, action: "vote.give", amount: 1, model: "beatmap_discussion", created_at: "2026-09-18T00:00:00+00:00", giver: { username: "Someone", url: "/u/1" }, post: { title: "Other - Map", url: "https://osu.ppy.sh/beatmapsets/555/discussion#/123" }, details: { event: "vote" } }]);
    if ((m = u.pathname.match(/^\/api\/v2\/beatmaps\/(\d+)$/))) { const x = allSets().find(z => z.beatmaps.some(b => b.id === +m[1])); return x ? json(200, { id: +m[1], beatmapset_id: x.id }) : json(404, { error: null }); }
    if (u.pathname === "/api/v2/beatmaps/lookup") { // by the MD5 of the .osu: one known hash, any other is unknown (the real answer: a Beatmap with a nested beatmapset)
      if (u.searchParams.get("checksum") !== LOOKUP_MD5) return json(404, { error: null });
      const x = LISTS.ranked[0], b = x.beatmaps[1];
      return json(200, { ...b, beatmapset_id: x.id, status: "ranked", checksum: LOOKUP_MD5, beatmapset: { id: x.id, title: x.title, artist: x.artist, creator: x.creator, status: "ranked" } });
    }
    if ((m = u.pathname.match(/^\/api\/v2\/beatmaps\/(\d+)\/scores$/))) {
      const id = +m[1];
      if (u.searchParams.get("mode") !== "osu" || u.searchParams.get("type") !== "global") return json(400, { error: "bad query" });
      if (id === SCORES_DENIED) return json(403, { error: "forbidden" });
      if (id === SCORES_VERSIONED) return json(200, { scores: versioned(parseInt(req.headers["x-api-version"] || "0", 10) || 0), userScore: null });
      const list = SCORES[id] || (id >= 7100 && id <= 7999 ? [legacyScore(id % 50)] : null);
      if (!list) return json(404, { error: null });
      const send = () => json(200, { scores: list, userScore: null });
      return id >= 7100 && id <= 7999 ? setTimeout(send, 150) : send();
    }
    if ((m = u.pathname.match(/^\/api\/v2\/scores\/(\d+)\/download$/))) { // a score's replay (.osr): 8001 a file, 8003 refused for the app token (403), 8004 too big, any other id 404
      const id = +m[1];
      if (id === 8003) return json(403, { error: "forbidden" });
      if (id === 8004) { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(Buffer.alloc(9 * 1024 * 1024)); }
      if (id !== 8001) return json(404, { error: null });
      res.writeHead(200, { "content-type": "application/x-osu-replay" }); return res.end(Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) & 255)));
    }
    if (u.pathname === "/api/v2/tags") return json(200, { tags: TAGS });
    if (u.pathname === "/api/v2/beatmapsets/search") {
      let q = u.searchParams.get("q") || ""; const tags = []; q = q.replace(/\btag=("(?:[^"\\]|\\.)*"|\S+)/g, (_, v) => { tags.push(v.replace(/^"|"$/g, "")); return ""; }).trim();
      const rng = []; q = q.replace(/\b(stars|bpm|length|ar|cs|od|hp)(>=|<=|>|<|=)(\d+(?:\.\d+)?)/g, (_, k, op, v) => { rng.push([k, op, +v]); return ""; }).trim().toLowerCase();
      const val = (x, k) => k === "bpm" ? x.bpm : k === "length" ? x.beatmaps[0].total_length : Math.max(...x.beatmaps.map(b => ({ stars: b.difficulty_rating, ar: b.ar, cs: b.cs, od: b.accuracy, hp: b.drain })[k]));
      const okR = x => rng.every(([k, op, v]) => { const a = val(x, k); return op === ">=" ? a >= v : op === "<=" ? a <= v : op === ">" ? a > v : op === "<" ? a < v : a === v; });
      const g = +(u.searchParams.get("g") || 0), l = +(u.searchParams.get("l") || 0), st = u.searchParams.get("s") || "leaderboard";
      let list = allSets().filter(x => (!q || (x.title + " " + x.artist + " " + x.tags).toLowerCase().includes(q)) && (!g || x.genre_id === g) && (!l || x.language_id === l)
        && (st === "any" || (st === "leaderboard" ? ["ranked", "loved", "approved", "qualified"].includes(x.status) : x.status === st))
        && okR(x) && tags.every(t => (SET_TAGS[x.id] || []).some(id => TAGS.find(z => z.id === id).name === t)));
      const off = +(u.searchParams.get("cursor_string") || 0), page = list.slice(off, off + 50);
      return json(200, { beatmapsets: page, cursor_string: off + 50 < list.length ? String(off + 50) : null, total: list.length });
    }
    if ((m = u.pathname.match(/^\/api\/v2\/beatmapsets\/(\d+)$/))) {
      const x = allSets().find(z => z.id === +m[1]); if (!x) return json(404, { error: null });
      const ids = SET_TAGS[x.id] || [];
      return json(200, { ...x, genre: { id: x.genre_id, name: x.genre_id === 3 ? "Anime" : "Electronic" }, language: { id: x.language_id, name: x.language_id === 3 ? "Japanese" : "English" },
        beatmaps: x.beatmaps.map((b, i) => ({ ...b, top_tag_ids: i ? [] : ids.map((id, k) => ({ tag_id: id, count: 10 - k })) })), related_tags: TAGS.filter(t => ids.includes(t.id)),
        current_nominations: x.status === "ranked" ? [{ user_id: 7001, rulesets: ["osu"] }, { user_id: 7002, rulesets: ["osu"] }] : [],
        related_users: [{ id: 7001, username: "NomA", groups: [{ short_name: "BN" }] }, { id: 7002, username: "NomB", groups: [{ short_name: "NAT" }] }],
        ratings: [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 7], user: { id: 4242, username: "TestMapper", groups: [{ short_name: "BN" }] } });
    }
    json(404, { error: "not found" });
  });
  return new Promise(r => srv.listen(port, () => r(srv)));
}
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("osu-mock.mjs")) startOsuMock(+(process.argv[2] || 54330)).then(() => console.log("osu mock on :" + (process.argv[2] || 54330)));
