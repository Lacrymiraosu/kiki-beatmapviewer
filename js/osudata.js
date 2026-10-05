"use strict";
// ============ osu! listing data: genres, languages, user tags, advanced search filters ============
// The beatmap listing on osu.ppy.sh can filter by genre, language, the tags players vote on (e.g. "tech/slider tech"),
// stars/BPM/length/AR/CS/OD/HP and more. Through our server (osu!api v2) the same search works here; without the server
// (static hosting) the mirrors are searched and the filters they can't do are applied to their results in the page.
const GENRES = [[3, "Anime"], [2, "Video Game"], [4, "Rock"], [5, "Pop"], [10, "Electronic"], [9, "Hip Hop"], [11, "Metal"], [12, "Classical"], [13, "Folk"], [14, "Jazz"], [7, "Novelty"], [6, "Other"], [1, "Unspecified"]];
const LANGUAGES = [[3, "Japanese"], [2, "English"], [4, "Chinese"], [6, "Korean"], [7, "French"], [8, "German"], [11, "Italian"], [10, "Spanish"], [9, "Swedish"], [12, "Russian"], [13, "Polish"], [5, "Instrumental"], [14, "Other"], [1, "Unspecified"]];
const genreName = id => (GENRES.find(g => g[0] === +id) || [])[1] || "";
const langName = id => (LANGUAGES.find(g => g[0] === +id) || [])[1] || "";
// user tag categories, in the order of the osu! wiki (Gameplay, Map design, Meta information)
const TAG_CATS = [["skillset", "Skillset", "Gameplay"], ["jumps", "Jumps", "Gameplay"], ["streams", "Streams", "Gameplay"], ["tech", "Tech", "Gameplay"], ["reading", "Reading", "Gameplay"],
  ["gimmick", "Gimmick", "Gameplay"], ["style", "Style", "Map design"], ["expression", "Expression", "Map design"], ["sliders", "Sliders", "Map design"], ["additions", "Additions", "Map design"],
  ["meta", "Meta", "Meta information"], ["context", "Context", "Meta information"]];
const tagCat = name => String(name).split("/")[0];
const tagShort = name => { const i = String(name).indexOf("/"); return i < 0 ? name : name.slice(i + 1); };
const catLabel = c => { const x = TAG_CATS.find(k => k[0] === c); return x ? tr(x[1]) : c; };
const SORTS = [["relevance", "Relevance"], ["ranked", "Date ranked"], ["updated", "Last updated"], ["plays", "Play count"], ["favourites", "Favourites"], ["difficulty", "Star rating"],
  ["rating", "Rating"], ["title", "Title"], ["artist", "Artist"]];
// number ranges: URL key, osu! search key, label, step
const RANGES = [["sr", "stars", "Stars", .1], ["bpm", "bpm", "BPM", 1], ["len", "length", "Length (s)", 1], ["ar", "ar", "AR", .1], ["cs", "cs", "CS", .1], ["od", "od", "OD", .1], ["hp", "hp", "HP", .1]];

// ---------- filter state <-> URL ----------
// the order a list starts in, like osu!'s listing: searches with words the best matches first; maps with a leaderboard
// (Has leaderboard, Ranked, Qualified, Loved) newest ranked first, so a map ranked today is at the top; the rest the
// latest updated first
const RANKED_STS = ["leaderboard", "ranked", "qualified", "loved"];
const defSort = (q, st) => String(q || "").trim() ? "relevance_desc" : RANKED_STS.includes(st) ? "ranked_desc" : "updated_desc";
const fEmpty = () => ({ g: 0, l: 0, k: 0, video: false, sb: false, nsfw: false, sort: "", tags: [], r: {} });
// osu!mania key counts offered as quick filters (osu!'s search: keys=7)
const KEY_COUNTS = [4, 5, 6, 7, 8, 9, 10];
function fFromParams(p) {
  const f = fEmpty();
  f.g = GENRES.some(x => x[0] === +p.get("g")) ? +p.get("g") : 0;
  f.l = LANGUAGES.some(x => x[0] === +p.get("l")) ? +p.get("l") : 0;
  const e = (p.get("e") || "").split("."); f.video = e.includes("video"); f.sb = e.includes("storyboard");
  f.nsfw = p.get("nsfw") === "1";
  const k = +p.get("keys"); f.k = p.get("m") === "3" && k >= 1 && k <= 18 ? Math.round(k) : 0; // (osu!mania lists only)
  const so = p.get("sort") || ""; if (/^[a-z]+_(asc|desc)$/.test(so) && SORTS.some(s => so.startsWith(s[0] + "_"))) f.sort = so;
  f.tags = [...new Set(p.getAll("tag").map(t => t.trim()).filter(t => t && t.length <= 80 && !/"/.test(t)))].slice(0, 8);
  for (const [k] of RANGES) { const m = (p.get(k) || "").match(/^(\d+(?:\.\d+)?)?-(\d+(?:\.\d+)?)?$/); if (m && (m[1] || m[2])) f.r[k] = [m[1] != null ? +m[1] : null, m[2] != null ? +m[2] : null]; }
  return f;
}
function fToParams(f, p) {
  if (!f) return p;
  if (f.g) p.set("g", f.g); if (f.l) p.set("l", f.l);
  const e = [f.video && "video", f.sb && "storyboard"].filter(Boolean).join("."); if (e) p.set("e", e);
  if (f.nsfw) p.set("nsfw", "1"); if (f.sort) p.set("sort", f.sort);
  if (f.k) p.set("keys", f.k);
  for (const t of f.tags) p.append("tag", t);
  for (const [k] of RANGES) { const v = f.r[k]; if (v) p.set(k, `${v[0] ?? ""}-${v[1] ?? ""}`); }
  return p;
}
const fKey = f => f ? fToParams(f, new URLSearchParams()).toString() : "";
const fCount = f => !f ? 0 : (f.g ? 1 : 0) + (f.l ? 1 : 0) + (f.k ? 1 : 0) + (f.video ? 1 : 0) + (f.sb ? 1 : 0) + (f.nsfw ? 1 : 0) + (f.sort ? 1 : 0) + f.tags.length + Object.keys(f.r).length;
// filters only the osu! search can do (the mirrors' results are filtered in the page for the rest)
const fNeedsOsu = f => !!f && (f.tags.length > 0 || !!f.sort);
// the osu! search text: keywords + stars>=5 bpm<=200 length<=120 tag="tech/slider tech" ...
function fQuery(q, f) {
  const parts = [q.trim()];
  if (f) {
    for (const [k, key] of RANGES) { const v = f.r[k]; if (!v) continue; if (v[0] != null) parts.push(`${key}>=${v[0]}`); if (v[1] != null) parts.push(`${key}<=${v[1]}`); }
    for (const t of f.tags) parts.push(`tag="${t}"`);
    if (f.k && gameMode() === 3) parts.push(`keys=${f.k}`);
  }
  return parts.filter(Boolean).join(" ");
}
// the same filters applied to normalised sets (mirror results)
function fMatch(s, f) {
  if (!f) return true;
  if (f.g && s.genre != null && s.genre !== f.g) return false;
  if (f.l && s.language != null && s.language !== f.l) return false;
  if (f.video && !s.video) return false;
  if (f.sb && !s.storyboard) return false;
  if (!f.nsfw && s.nsfw) return false;
  if (f.k && gameMode() === 3 && s.diffs.length && !s.diffs.some(d => Math.round(+d.cs) === f.k)) return false;
  const inR = (v, r) => v != null && !isNaN(v) && (r[0] == null || v >= r[0] - 1e-6) && (r[1] == null || v <= r[1] + 1e-6);
  const diffKey = { sr: "stars", ar: "ar", cs: "cs", od: "od", hp: "hp", len: "len", bpm: "bpm" };
  for (const [k] of RANGES) {
    const r = f.r[k]; if (!r) continue;
    if (!s.diffs.length) { if (k === "bpm" && !inR(s.bpm, r)) return false; if (k === "len" && !inR(s.len, r)) return false; continue; }
    if (!s.diffs.some(d => inR(+d[diffKey[k]] || (k === "bpm" ? s.bpm : NaN), r))) return false;
  }
  return true;
}

// ---------- osu! data through our server ----------
const osuTagsP = { p: null };
function osuTags() { // [{ name, description, ruleset_id }] for the chosen game mode, or [] without the server
  if (!osuTagsP.p) osuTagsP.p = fetchJSON("/api/v1/osu/tags", null, 12000).then(j => j.tags || []).catch(() => { osuTagsP.p = null; return []; });
  const m = gameMode(); return osuTagsP.p.then(a => a.filter(t => t.ruleset_id == null || t.ruleset_id === m));
}
async function osuSearch(o, signal) { // o: { q, st, f, cursor }
  const p = new URLSearchParams({ s: o.st ? o.st : "any" });
  const q = fQuery(o.q, o.f); if (q) p.set("q", q);
  const f = o.f || fEmpty();
  if (f.g) p.set("g", f.g); if (f.l) p.set("l", f.l);
  const e = [f.video && "video", f.sb && "storyboard"].filter(Boolean).join("."); if (e) p.set("e", e);
  if (f.nsfw) p.set("nsfw", "1"); p.set("sort", f.sort || defSort(o.q, o.st));
  if (o.cursor) p.set("cursor", o.cursor);
  if (gameMode() === 3) p.set("m", "3");
  const r = await fetch("/api/v1/osu/search?" + p, { signal, cache: fetchFresh ? "reload" : "default" });
  if (!(r.headers.get("content-type") || "").includes("json")) { osuApi.ok = false; throw new Error("no server"); }
  const j = await r.json();
  if (!r.ok) { if (r.status === 503 || r.status === 404) osuApi.ok = false; throw new Error(j.error || "HTTP " + r.status); }
  osuApi.ok = true;
  return { list: (j.sets || []).map(normSet).filter(Boolean), cursor: j.cursor || null, total: j.total };
}
const osuSetCache = new Map();
function osuSet(id) {
  if (osuApi.ok === false) return Promise.resolve(null);
  if (!osuSetCache.has(id)) osuSetCache.set(id, fetchJSON("/api/v1/osu/set?id=" + id, null, 12000).then(j => j.set || null).catch(() => { osuSetCache.delete(id); return null; }));
  return osuSetCache.get(id);
}
const osuActCache = new Map();
function osuActivity(uid) {
  if (!osuActCache.has(uid)) osuActCache.set(uid, fetchJSON("/api/v1/osu/activity?id=" + uid, null, 12000).catch(() => { osuActCache.delete(uid); return null; }));
  return osuActCache.get(uid);
}
