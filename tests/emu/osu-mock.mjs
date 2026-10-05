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
  submitted_date: "2020-01-01T00:00:00Z", ranked_date: null, video: false, storyboard: false, bpm: 180, source: "", genre_id: i % 2 ? 3 : 10, language_id: i % 2 ? 3 : 2, tags: `album${i} vocaloid`,
  beatmaps: [{ id: id * 10 + 1, version: "Normal", mode: "osu", mode_int: 0, difficulty_rating: 2.1, total_length: 120, hit_length: 110, bpm: 180, cs: 4, ar: 6, accuracy: 5, drain: 4 },
             { id: id * 10 + 2, version: "Insane", mode: "osu", mode_int: 0, difficulty_rating: 5.3, total_length: 120, hit_length: 110, bpm: 180, cs: 4, ar: 9, accuracy: 8, drain: 6 }] });
const LISTS = { ranked: [1, 2, 3].map(i => set(1000 + i, 4242, i, "ranked")), loved: [set(2001, 4242, 4, "loved")], guest: [set(3001, 99, 5, "ranked"), set(3002, 98, 6, "ranked")],
  graveyard: Array.from({ length: 45 }, (_, i) => set(4000 + i, 4242, 10 + i, "graveyard")), pending: [], nominated: [] };
const TAGS = [{ id: 1, name: "skillset/tech", ruleset_id: 0, description: "Tests uncommon skills." }, { id: 2, name: "tech/slider tech", ruleset_id: 0, description: "Tests uncommon skills involving sliders." },
  { id: 3, name: "style/clean", ruleset_id: 0, description: "Visually uncluttered and organised patterns." }, { id: 4, name: "skillset/streams", ruleset_id: null, description: "Continuous note hits." }];
const SET_TAGS = { 1001: [2, 3], 1002: [1], 1003: [3] }; // user tags voted on the first beatmap of these sets
const allSets = () => [...LISTS.ranked, ...LISTS.loved, ...LISTS.graveyard];
export const calls = [];

export function startOsuMock(port = 54330) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); calls.push(u.pathname);
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
