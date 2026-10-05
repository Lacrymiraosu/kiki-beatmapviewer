// Public osu! data through osu!api v2 with the app's own client-credentials token (scope "public").
// Env: OSU_CLIENT_ID, OSU_CLIENT_SECRET (the same app as the login). Only public profile/beatmap data is read.
// osu! asks for at most ~60 requests per minute: results are cached here (per server instance) and by the CDN
// (Cache-Control on the responses), so the same user page doesn't hit osu! again for 10 minutes.
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
const checkCool = () => { if (Date.now() < cool.until) throw new OsuError(cool.why === "rate_limited" ? "osu_rate_limited" : "osu_unavailable", 503); };
const cache = new Map();

class OsuError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }

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
async function osuGet(path, ttlMs = 600000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  checkCool();
  let r = await fetchT(BASE() + "/api/v2" + path, { headers: { Authorization: "Bearer " + await token(), Accept: "application/json" } });
  if (r.status === 401) { tok.value = ""; r = await fetchT(BASE() + "/api/v2" + path, { headers: { Authorization: "Bearer " + await token(), Accept: "application/json" } }); }
  if (r.status === 404) { cache.set(path, { at: Date.now(), data: null }); return null; }
  if (r.status === 429) { coolDown(r, "rate_limited", 60000); throw new OsuError("osu_rate_limited", 503); }
  if (!r.ok) throw new OsuError("osu_error", 502);
  const data = await r.json();
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
function publicSet(s) {
  return {
    id: s.id, title: s.title, artist: s.artist, creator: s.creator, user_id: s.user_id, status: s.status, play_count: s.play_count, favourite_count: s.favourite_count,
    submitted_date: s.submitted_date, ranked_date: s.ranked_date, video: !!s.video, storyboard: !!s.storyboard, bpm: s.bpm, source: s.source,
    genre_id: s.genre_id ?? null, language_id: s.language_id ?? null, tags: str(s.tags, 1000), nsfw: !!s.nsfw, last_updated: s.last_updated || null,
    beatmaps: (s.beatmaps || []).map(b => ({ id: b.id, version: b.version, mode: b.mode, mode_int: b.mode_int, difficulty_rating: b.difficulty_rating,
      total_length: b.total_length, hit_length: b.hit_length, bpm: b.bpm, cs: b.cs, ar: b.ar, accuracy: b.accuracy, drain: b.drain, user_id: b.user_id,
      owners: b.owners })),
  };
}
async function getUser(u) {
  const key = /^\d{1,10}$/.test(u) ? u : "@" + u;
  return publicUser(await osuGet(`/users/${encodeURIComponent(key)}/osu`));
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
  const p = new URLSearchParams({ m: o.m === "3" ? "3" : "0" }); // osu! or osu!mania
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
async function getSet(id) {
  const s = await osuGet(`/beatmapsets/${id}`, 600000); if (!s) return null;
  const users = new Map((s.related_users || []).map(u => [u.id, u]));
  const tagName = new Map((s.related_tags || []).map(t => [t.id, t]));
  const out = publicSet(s);
  out.genre = s.genre ? { id: s.genre.id, name: str(s.genre.name, 40) } : null;
  out.language = s.language ? { id: s.language.id, name: str(s.language.name, 40) } : null;
  out.related_tags = (s.related_tags || []).map(t => ({ id: t.id, name: str(t.name, 80), description: str(t.description, 400), ruleset_id: t.ruleset_id ?? null }));
  out.map_tags = (s.beatmaps || []).map(b => ({ id: b.id, tags: (b.top_tag_ids || []).map(x => ({ name: (tagName.get(x.tag_id) || {}).name || "", count: x.count || 0 })).filter(x => x.name) }));
  out.nominators = (s.current_nominations || []).map(n => { const u = users.get(n.user_id) || {}; return { id: n.user_id, username: str(u.username, 40), groups: (u.groups || []).map(g => str(g.short_name, 12)) }; });
  out.rating = Array.isArray(s.ratings) && s.ratings.length > 1 ? (() => { let n = 0, sum = 0; s.ratings.forEach((c, i) => { if (i) { n += c; sum += c * i; } }); return n ? { avg: Math.round(sum / n * 100) / 100, n } : null; })() : null;
  out.hype = s.hype || null; out.spotlight = !!s.spotlight;
  out.creator_info = s.user ? { id: s.user.id, username: str(s.user.username, 40), groups: (s.user.groups || []).map(g => str(g.short_name, 12)) } : null;
  return out;
}

// which set a difficulty belongs to
async function getBeatmapSetId(id) { const b = await osuGet(`/beatmaps/${id}`, 86400000); return b && b.beatmapset_id ? b.beatmapset_id : null; }

module.exports = { OsuError, getBeatmapSetId, getUser, getUserSets, getUserActivity, search, getTags, getSet, USER_TYPES, configured: () => !!(process.env.OSU_CLIENT_ID && process.env.OSU_CLIENT_SECRET) };
