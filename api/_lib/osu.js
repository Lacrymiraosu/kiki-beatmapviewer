// Public osu! data through osu!api v2 with the app's own client-credentials token (scope "public").
// Env: OSU_CLIENT_ID, OSU_CLIENT_SECRET (the same app as the login). Only public profile/beatmap data is read.
// osu! asks for at most ~60 requests per minute: results are cached here (per server instance) and by the CDN
// (Cache-Control on the responses), so the same user page doesn't hit osu! again for 10 minutes, and what isn't cached
// comes out of a budget (BUDGET below) that keeps us under that.
const BASE = () => (process.env.OSU_API_BASE || "https://osu.ppy.sh").replace(/\/+$/, ""); // override only for local tests
const tok = { value: "", exp: 0, pending: null };
// After osu! refuses the app token (wrong key) or says "too many requests", don't ask again for a while: every page
// that reads osu! data would otherwise retry at once, and that flood gets the app (and the login, same app) rate
// limited (429). The site falls back to the mirrors meanwhile.
const cool = { until: 0, why: "" };
function coolDown(r, why, defMs) {
  const ra = +(r.headers && r.headers.get && r.headers.get("retry-after")) || 0;
  cool.until = Date.now() + Math.min(15 * 60000, Math.max(ra * 1000, defMs)); cool.why = why;
  console.error("osu! " + why + ": pausing osu! requests for " + Math.round((cool.until - Date.now()) / 1000) + " s");
}
const checkCool = () => { if (Date.now() < cool.until) throw new OsuError(cool.why === "rate_limited" ? "osu_rate_limited" : "osu_unavailable", 503, Math.ceil((cool.until - Date.now()) / 1000)); };
const cache = new Map();

class OsuError extends Error { constructor(code, status, retryAfter) { super(code); this.code = code; this.status = status; if (retryAfter) this.retryAfter = retryAfter; } }

// Our own budget for requests to osu!, so we stay under osu!'s ~60 a minute for the app (and the login, the same app,
// keeps some room) whoever is asking: token buckets per server instance. The site's own pages ("v1": the listing,
// mapper pages, the map panel) draw from the main one; link-preview cards ("og", api/og.js, anyone can make up links)
// also need one from their own smaller bucket and only get one while the main bucket keeps a reserve, so cards are
// the first to go without, and they can't use up what the pages need (nor push osu! into answering 429).
// Out of budget: a v1 request gets 429 + Retry-After (osu_busy) instead of asking osu!; a card shows the plain page.
// "scores" (a replay's top 50, api/v1.js osu/scores) is the same kind of extra: its own tiny bucket (6 a minute, 3 at once),
// and only while the main bucket still has 12 left.
const BUDGET = { perMin: 50, burst: 20, ogPerMin: 12, ogBurst: 5, ogReserve: 10, scoresPerMin: 6, scoresBurst: 3, scoresReserve: 12 };
const buckets = { main: { t: BUDGET.burst, at: Date.now() }, og: { t: BUDGET.ogBurst, at: Date.now() }, scores: { t: BUDGET.scoresBurst, at: Date.now() } };
function refill(b, perMin, burst) { const now = Date.now(); b.t = Math.min(burst, b.t + (now - b.at) * perMin / 60000); b.at = now; }
function take(cls) {
  const m = buckets.main, o = buckets.og, sc = buckets.scores;
  refill(m, BUDGET.perMin, BUDGET.burst); refill(o, BUDGET.ogPerMin, BUDGET.ogBurst); refill(sc, BUDGET.scoresPerMin, BUDGET.scoresBurst);
  const wait = (t, perMin) => Math.max(1, Math.ceil((1 - t) * 60 / perMin));
  if (cls === "scores") {
    if (sc.t < 1 || m.t < BUDGET.scoresReserve) throw new OsuError("osu_busy", 429, sc.t < 1 ? wait(sc.t, BUDGET.scoresPerMin) : wait(m.t - BUDGET.scoresReserve + 1, BUDGET.perMin));
    sc.t--; m.t--; return;
  }
  if (cls === "og") {
    if (o.t < 1 || m.t < 1 + BUDGET.ogReserve) throw new OsuError("osu_busy", 429, o.t < 1 ? wait(o.t, BUDGET.ogPerMin) : wait(m.t - BUDGET.ogReserve, BUDGET.perMin));
    o.t--; m.t--; return;
  }
  if (m.t < 1) throw new OsuError("osu_busy", 429, wait(m.t, BUDGET.perMin));
  m.t--;
}

async function fetchT(url, opts, ms = 8000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) { throw new OsuError(e.name === "AbortError" ? "osu_timeout" : "osu_unreachable", 504); }
  finally { clearTimeout(t); }
}
async function token() {
  if (tok.value && Date.now() < tok.exp - 60000) return tok.value;
  if (tok.pending) return tok.pending;
  const id = String(process.env.OSU_CLIENT_ID || "").trim(), secret = String(process.env.OSU_CLIENT_SECRET || "").trim(); // (see auth.js cfg)
  if (!id || !secret) throw new OsuError("osu_not_configured", 503);
  checkCool();
  tok.pending = (async () => {
    const r = await fetchT(BASE() + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: +id, client_secret: secret, grant_type: "client_credentials", scope: "public" }) });
    if (!r.ok) {
      const j = await r.json().catch(() => null); console.error("osu! app token", r.status, j && j.error || "");
      if (r.status === 429) coolDown(r, "rate_limited", 60000); else coolDown(r, "token_refused", 5 * 60000);
      throw new OsuError("osu_token", 503);
    }
    const j = await r.json();
    tok.value = j.access_token; tok.exp = Date.now() + (+j.expires_in || 3600) * 1000;
    return tok.value;
  })().finally(() => { tok.pending = null; });
  return tok.pending;
}
// cls: whose request it is ("v1" the site's pages, "og" link-preview cards): which budget it comes out of (above)
// negMs: how long a 404 (null) stays cached when that is shorter than ttlMs
// o (only the callers that need it): refused = the OsuError code for osu! still refusing us (401 after the token refresh, or 403) instead of osu_error;
// trim = what to keep of the answer (it is cached trimmed, not the whole answer); headers = extra request headers (the scores call's x-api-version)
async function osuGet(path, ttlMs = 600000, cls = "v1", negMs = ttlMs, o = {}) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < (hit.data === null ? Math.min(ttlMs, negMs) : ttlMs)) return hit.data;
  checkCool();
  take(cls);
  const hdr = async () => ({ ...(o.headers || {}), Authorization: "Bearer " + await token(), Accept: "application/json" });
  let r = await fetchT(BASE() + "/api/v2" + path, { headers: await hdr() });
  if (r.status === 401) { tok.value = ""; r = await fetchT(BASE() + "/api/v2" + path, { headers: await hdr() }); }
  if (r.status === 404) { cache.set(path, { at: Date.now(), data: null }); return null; }
  if (r.status === 429) { coolDown(r, "rate_limited", 60000); throw new OsuError("osu_rate_limited", 503); }
  if ((r.status === 401 || r.status === 403) && o.refused) throw new OsuError(o.refused, 503);
  if (!r.ok) throw new OsuError("osu_error", 502);
  const data = o.trim ? o.trim(await r.json()) : await r.json();
  cache.set(path, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

// ---------- what we pass on (public fields only) ----------
const str = (v, n = 200) => typeof v === "string" ? v.slice(0, n) : "";
const USER_TYPES = ["ranked", "loved", "pending", "graveyard", "guest", "nominated"];
function publicUser(u) {
  if (!u) return null;
  const st = u.statistics || {};
  return {
    id: u.id, username: u.username, avatar_url: u.avatar_url || `https://a.ppy.sh/${u.id}`, cover_url: (u.cover && u.cover.url) || u.cover_url || "",
    country_code: u.country_code || "", country: (u.country && u.country.name) || "", join_date: u.join_date || null, title: u.title || "",
    is_supporter: !!u.is_supporter, playmode: u.playmode || "osu", previous_usernames: (u.previous_usernames || []).slice(0, 10),
    followers: u.follower_count ?? null, mapping_followers: u.mapping_follower_count ?? null, kudosu: (u.kudosu && u.kudosu.total) ?? null,
    counts: { ranked: u.ranked_beatmapset_count ?? u.ranked_and_approved_beatmapset_count ?? 0, loved: u.loved_beatmapset_count ?? 0,
      pending: u.pending_beatmapset_count ?? 0, graveyard: u.graveyard_beatmapset_count ?? 0, guest: u.guest_beatmapset_count ?? 0,
      nominated: u.nominated_beatmapset_count ?? 0 },
    stats: { global_rank: st.global_rank ?? null, country_rank: st.country_rank ?? null, pp: st.pp ?? null, play_count: st.play_count ?? null,
      accuracy: st.hit_accuracy ?? null, level: (st.level && st.level.current) ?? null, play_time: st.play_time ?? null, max_combo: st.maximum_combo ?? null,
      rank_highest: u.rank_highest ? { rank: u.rank_highest.rank, at: u.rank_highest.updated_at || null } : null },
    groups: (u.groups || []).map(g => ({ id: g.id, identifier: str(g.identifier, 40), name: str(g.name, 80), short: str(g.short_name, 12), colour: g.colour || null,
      playmodes: Array.isArray(g.playmodes) ? g.playmodes.filter(m => typeof m === "string").slice(0, 4) : [], probationary: !!g.is_probationary })).slice(0, 8),
    badges: (u.badges || []).map(b => ({ at: b.awarded_at || null, description: str(b.description, 300), image: str(b["image@2x_url"] || b.image_url, 300), url: str(b.url, 300) })).slice(0, 40),
    favourites: u.favourite_beatmapset_count ?? null, beatmap_plays: u.beatmap_playcounts_count ?? null,
    kudosu_available: (u.kudosu && u.kudosu.available) ?? null, medals: Array.isArray(u.user_achievements) ? u.user_achievements.length : null,
    location: str(u.location, 100), interests: str(u.interests, 100), occupation: str(u.occupation, 100), website: str(u.website, 200), twitter: str(u.twitter, 60), discord: str(u.discord, 60),
    last_visit: u.last_visit || null, is_online: u.is_online ?? null, support_level: u.support_level ?? 0, profile_hue: u.profile_hue ?? null,
  };
}
// a count osu! sent, or null when it didn't (0 is a real count: a map without spinners; "absent" must stay absent so the page can drop the column)
const optNum = (v, max = 1e9) => typeof v === "number" && isFinite(v) ? Math.min(max, Math.max(0, v)) : null;
const optDate = v => typeof v === "string" && v.length <= 40 ? v : null;
function publicSet(s) {
  return {
    id: s.id, title: s.title, artist: s.artist, title_unicode: str(s.title_unicode) || null, artist_unicode: str(s.artist_unicode) || null,
    creator: s.creator, user_id: s.user_id, status: s.status, play_count: s.play_count, favourite_count: s.favourite_count,
    submitted_date: s.submitted_date, ranked_date: s.ranked_date, video: !!s.video, storyboard: !!s.storyboard, bpm: s.bpm, source: s.source,
    genre_id: s.genre_id ?? null, language_id: s.language_id ?? null, tags: str(s.tags, 1000), nsfw: !!s.nsfw, last_updated: s.last_updated || null,
    hype: s.hype && typeof s.hype === "object" ? { current: optNum(s.hype.current, 1e4), required: optNum(s.hype.required, 1e4) } : null, spotlight: !!s.spotlight,
    beatmaps: (s.beatmaps || []).map(b => ({ id: b.id, version: b.version, mode: b.mode, mode_int: b.mode_int, difficulty_rating: b.difficulty_rating,
      total_length: b.total_length, hit_length: b.hit_length, bpm: b.bpm, checksum: str(b.checksum, 32) || null, cs: b.cs, ar: b.ar, accuracy: b.accuracy, drain: b.drain, user_id: b.user_id,
      owners: b.owners,
      // object counts and the rest of what the website shows per difficulty (search results carry them too; absent -> null, never 0)
      count_circles: optNum(b.count_circles), count_sliders: optNum(b.count_sliders), count_spinners: optNum(b.count_spinners), max_combo: optNum(b.max_combo),
      status: str(b.status, 20) || null, last_updated: optDate(b.last_updated), playcount: optNum(b.playcount), passcount: optNum(b.passcount),
      url: typeof b.url === "string" && /^https:\/\/osu\.ppy\.sh\//.test(b.url) ? b.url.slice(0, 200) : null, ranked: optNum(b.ranked, 10) })),
  };
}
async function getUser(u, cls) {
  const key = /^\d{1,10}$/.test(u) ? u : "@" + u;
  return publicUser(await osuGet(`/users/${encodeURIComponent(key)}/osu`, undefined, cls));
}
// osu! only lists the first 100 of each type
async function getUserSets(id, type, offset, limit) {
  const data = await osuGet(`/users/${id}/beatmapsets/${type}?limit=${limit}&offset=${offset}`);
  return (Array.isArray(data) ? data : []).map(s => s.beatmapset || s).filter(s => s && s.id).map(publicSet);
}

// what someone did recently as a mapper (osu! keeps about a month): uploads, updates, ranked/loved, map playcount milestones
const ACTIVITY = new Set(["beatmapsetApprove", "beatmapsetUpload", "beatmapsetUpdate", "beatmapsetRevive", "beatmapsetDelete", "beatmapPlaycount"]);
const setIdOf = url => { const m = String(url || "").match(/\/(?:s|beatmapsets)\/(\d+)/); return m ? +m[1] : null; };
async function getUserActivity(id) {
  const [ev, ku] = await Promise.all([osuGet(`/users/${id}/recent_activity?limit=50`), osuGet(`/users/${id}/kudosu?limit=20`)]);
  const events = (Array.isArray(ev) ? ev : []).filter(e => e && ACTIVITY.has(e.type)).slice(0, 30).map(e => {
    const bs = e.beatmapset || e.beatmap || {};
    return { type: e.type, at: e.created_at || null, approval: str(e.approval, 20), count: e.count ?? null, title: str(bs.title, 200), sid: e.beatmapset ? setIdOf(bs.url) : null,
      bid: e.beatmap ? +((String(bs.url || "").match(/\/b(?:eatmaps)?\/(\d+)/) || [])[1] || 0) || null : null };
  });
  const kudosu = (Array.isArray(ku) ? ku : []).slice(0, 20).map(k => ({ action: str(k.action, 60), amount: k.amount ?? 0, at: k.created_at || null,
    title: str(k.post && k.post.title, 200), sid: setIdOf(k.post && k.post.url), giver: str(k.giver && k.giver.username, 40) }));
  return { events, kudosu };
}
// beatmap listing search (the osu! website's search): keywords + filters like stars>5, tag="tech/slider tech", genre, language, sort
const SEARCH_ST = ["any", "leaderboard", "ranked", "qualified", "loved", "pending", "wip", "graveyard"];
const SEARCH_SORT = /^(title|artist|difficulty|ranked|rating|plays|favourites|relevance|updated|nominations)_(asc|desc)$/;
async function search(o) {
  const p = new URLSearchParams({ m: "0" }); // osu!standard only
  if (o.q) p.set("q", o.q);
  if (o.s && SEARCH_ST.includes(o.s)) p.set("s", o.s);
  if (o.g) p.set("g", String(o.g)); if (o.l) p.set("l", String(o.l));
  if (o.e) p.set("e", o.e); if (o.nsfw) p.set("nsfw", "true");
  if (o.sort && SEARCH_SORT.test(o.sort)) p.set("sort", o.sort);
  if (o.cursor) p.set("cursor_string", o.cursor);
  const data = await osuGet("/beatmapsets/search?" + p, 60000); // (a minute: newly ranked maps show up soon)
  const sets = (data && Array.isArray(data.beatmapsets) ? data.beatmapsets : []).map(publicSet);
  return { sets, cursor: (data && data.cursor_string) || null, total: (data && data.total) ?? null };
}
// the user tags osu! players vote on (e.g. "tech/slider tech"): name = "category/tag"
async function getTags() {
  const data = await osuGet("/tags", 86400000);
  return (data && Array.isArray(data.tags) ? data.tags : []).map(t => ({ id: t.id, name: str(t.name, 80), ruleset_id: t.ruleset_id ?? null, description: str(t.description, 400) }));
}
// one beatmapset with what search results don't have: genre, language, user tags (with votes), nominators, description
async function getSet(id, cls) {
  const s = await osuGet(`/beatmapsets/${id}`, 600000, cls); if (!s) return null;
  const users = new Map((s.related_users || []).map(u => [u.id, u]));
  const tagName = new Map((s.related_tags || []).map(t => [t.id, t]));
  const out = publicSet(s);
  out.genre = s.genre ? { id: s.genre.id, name: str(s.genre.name, 40) } : null;
  out.language = s.language ? { id: s.language.id, name: str(s.language.name, 40) } : null;
  out.related_tags = (s.related_tags || []).map(t => ({ id: t.id, name: str(t.name, 80), description: str(t.description, 400), ruleset_id: t.ruleset_id ?? null }));
  out.map_tags = (s.beatmaps || []).map(b => ({ id: b.id, tags: (b.top_tag_ids || []).map(x => ({ name: (tagName.get(x.tag_id) || {}).name || "", count: x.count || 0 })).filter(x => x.name) }));
  out.nominators = (s.current_nominations || []).map(n => { const u = users.get(n.user_id) || {}; return { id: n.user_id, username: str(u.username, 40), groups: (u.groups || []).map(g => str(g.short_name, 12)) }; });
  out.rating = Array.isArray(s.ratings) && s.ratings.length > 1 ? (() => { let n = 0, sum = 0; s.ratings.forEach((c, i) => { if (i) { n += c; sum += c * i; } }); return n ? { avg: Math.round(sum / n * 100) / 100, n } : null; })() : null;
  out.creator_info = s.user ? { id: s.user.id, username: str(s.user.username, 40), groups: (s.user.groups || []).map(g => str(g.short_name, 12)) } : null;
  return out;
}

// which set a difficulty belongs to
async function getBeatmapSetId(id, cls) { const b = await osuGet(`/beatmaps/${id}`, 86400000, cls); return b && b.beatmapset_id ? b.beatmapset_id : null; }
// a difficulty by the MD5 of its .osu file (a replay names its map that way); null when osu! doesn't know the hash.
// A hash never changes what it names: found for 24 h, unknown for 10 minutes (it may be uploaded meanwhile).
// osu!'s answer is a Beatmap with a nested beatmapset (title, artist, creator live there).
const num = (v, d = 0) => typeof v === "number" && isFinite(v) ? v : d;
async function lookupByChecksum(md5, cls) {
  if (!/^[0-9a-f]{32}$/.test(md5)) return null; // (never build the URL from anything else)
  const b = await osuGet(`/beatmaps/lookup?checksum=${md5}`, 86400000, cls, 600000);
  if (!b || !b.id) return null;
  const bs = b.beatmapset || {};
  return { beatmap_id: num(b.id), beatmapset_id: num(b.beatmapset_id, num(bs.id)), version: str(b.version), mode: num(b.mode_int), status: str(b.status, 20),
    title: str(bs.title), artist: str(bs.artist), creator: str(bs.creator), cs: num(b.cs), ar: num(b.ar), od: num(b.accuracy), hp: num(b.drain),
    stars: num(b.difficulty_rating), length: num(b.total_length), checksum: str(b.checksum, 32) || md5 };
}


// the top 50 global scores of a difficulty (osu!standard), trimmed to what the results screen lists. The answer is { scores: [...] } with either
// the legacy shape (mods as strings, statistics count_300...) or the lazer one (mods as { acronym, settings }, statistics great/ok/meh/miss): both are read.
// osu! answers in the lazer shape only when asked with the header x-api-version: 20220705 or higher (osu! API docs, "API Response Version":
// "20220705 Score object with different set of fields", https://osu.ppy.sh/docs/index.html#api-response-version; osu-web ScoreTransformer:
// legacyFormat = api_version() < 20220705). Without it a score set on lazer comes in the legacy shape with score = legacy_total_score = 0.
// null when osu! doesn't know the map. Cached 10 minutes (an empty list and a 404 too); requests for the same map that are in flight at once share one
// request to osu!. If osu! refuses the scores path for our app token (401/403): scores_unavailable, and we don't ask again for an hour.
const SCORES_API_VERSION = "20220705", SCORES_MS = 600000, SCORES_OFF_MS = 3600000, GRADES = new Set(["XH", "X", "SH", "S", "A", "B", "C", "D"]);
const scoresOff = { until: 0 }, scoresPending = new Map();
const cnt = (v, max = 1e9) => Math.min(max, Math.max(0, Math.round(num(v))));
// The score: one number per row on the CLASSIC scale the replay board compares with (js/replay.js rpBoardK / rpBoardList):
// a score set on stable keeps its stable score (legacy_total_score, "score V1": the same number as a stable .osr's header and as before),
// a score set on lazer (legacy_total_score 0) gets classic_total_score (lazer's classic display score; a lazer replay is converted to that).
// Then the legacy shape's score, and last total_score: in the lazer shape that is lazer's STANDARDISED score (another scale, at most
// 1 000 000 for osu!standard without mods); osu! sends classic_total_score with every solo score, so it is only reached for an answer
// without it, where a standardised number is still better than a row left out. The order is the one the client already expects.
const SCORE_ORDER = s => [s.legacy_total_score, s.classic_total_score, s.score, s.total_score];
function trimScore(s, i) {
  const u = s.user || {}, st = s.statistics || {};
  const legacy = typeof s.legacy_score_id === "number" && s.legacy_score_id > 0; // (lazer shape: a score set on stable)
  const mods = (Array.isArray(s.mods) ? s.mods : []).map(m => typeof m === "string" ? m : m && m.acronym).filter(m => typeof m === "string" && /^[A-Za-z0-9]{1,3}$/.test(m)).map(m => m.toUpperCase())
    .filter(m => !(legacy && m === "CL")).slice(0, 10); // (osu! marks stable scores with the Classic mod in the lazer shape; osu-web hides it for them too)
  const dt = s.created_at ?? s.ended_at, t = typeof dt === "string" ? Date.parse(dt) : NaN; // (lazer-style scores say ended_at)
  const av = str(u.avatar_url, 300), cc = str(u.country_code, 8);
  return { rank: i + 1, user: { id: cnt(u.id), name: str(u.username, 32), country: /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : "", avatar: /^https:\/\/[^\s"'<>]+$/.test(av) ? av : "" },
    score: cnt(SCORE_ORDER(s).find(v => typeof v === "number" && v > 0), 1e13), acc: Math.min(1, Math.max(0, num(s.accuracy))), combo: cnt(s.max_combo, 1e6), mods,
    grade: GRADES.has(s.rank) ? s.rank : "", pp: typeof s.pp === "number" && isFinite(s.pp) ? Math.round(Math.min(1e5, Math.max(0, s.pp)) * 100) / 100 : null,
    date: isNaN(t) ? "" : new Date(t).toISOString(), n300: cnt(st.count_300 ?? st.great), n100: cnt(st.count_100 ?? st.ok), n50: cnt(st.count_50 ?? st.meh), miss: cnt(st.count_miss ?? st.miss) };
}
const trimScores = d => (d && Array.isArray(d.scores) ? d.scores : []).filter(s => s && typeof s === "object").slice(0, 50).map(trimScore);
async function getScores(id, cls = "scores") {
  id = String(id);
  if (!/^\d{1,10}$/.test(id)) return null; // (never build the URL from anything else)
  if (Date.now() < scoresOff.until) throw new OsuError("scores_unavailable", 503);
  let p = scoresPending.get(id);
  if (!p) {
    p = osuGet(`/beatmaps/${id}/scores?mode=osu&type=global`, SCORES_MS, cls, SCORES_MS, { refused: "scores_unavailable", trim: trimScores, headers: { "x-api-version": SCORES_API_VERSION } })
      .catch(e => { if (e && e.code === "scores_unavailable") { scoresOff.until = Date.now() + SCORES_OFF_MS; console.error("osu! refuses the scores path: not asking for an hour"); } throw e; })
      .finally(() => { scoresPending.delete(id); });
    scoresPending.set(id, p);
  }
  const list = await p;
  return list ? { beatmap_id: +id, scores: list } : null;
}

// The replay file (.osr) of a score by its id, for a pasted osu! score link (js/replayui.js rpuPasteScore). osu!'s docs list this route (undocumented there) with scope
// "public", but whether our app token (no player signed in) may use it is osu!'s to say: a 401 / 403 is replay_needs_login, and we don't ask again for an hour. null when
// there is no such score or it has no replay (404). At most MAX_REPLAY bytes.
const MAX_REPLAY = 8 * 1024 * 1024, replayOff = { until: 0 };
async function getReplay(id, cls = "scores") {
  id = String(id);
  if (!/^\d{1,12}$/.test(id)) return null; // (never build the URL from anything else)
  if (Date.now() < replayOff.until) throw new OsuError("replay_needs_login", 403);
  checkCool(); take(cls);
  const get = async () => fetchT(BASE() + `/api/v2/scores/${id}/download`, { headers: { Authorization: "Bearer " + await token(), Accept: "application/octet-stream", "x-api-version": SCORES_API_VERSION } }, 20000);
  let r = await get();
  if (r.status === 401) { tok.value = ""; r = await get(); }
  if (r.status === 404) return null;
  if (r.status === 429) { coolDown(r, "rate_limited", 60000); throw new OsuError("osu_rate_limited", 503); }
  if (r.status === 401 || r.status === 403) { replayOff.until = Date.now() + SCORES_OFF_MS; console.error("osu! refuses the replay download for our app token: not asking for an hour"); throw new OsuError("replay_needs_login", 403); }
  if (!r.ok) throw new OsuError("osu_error", 502);
  if ((+r.headers.get("content-length") || 0) > MAX_REPLAY) throw new OsuError("replay_too_big", 413);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_REPLAY) throw new OsuError("replay_too_big", 413);
  return buf;
}

module.exports = { OsuError, getReplay, getBeatmapSetId, lookupByChecksum, getScores, getUser, getUserSets, getUserActivity, search, getTags, getSet, USER_TYPES, BUDGET, _buckets: buckets, _replay: { off: replayOff, MAX: MAX_REPLAY }, _scores: { off: scoresOff, pending: scoresPending, apiVersion: SCORES_API_VERSION, trim: trimScores }, configured: () => !!(process.env.OSU_CLIENT_ID && process.env.OSU_CLIENT_SECRET) };
