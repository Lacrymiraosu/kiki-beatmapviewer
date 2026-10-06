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
const defSort = (q, st) => kwText(q) ? "relevance_desc" : RANKED_STS.includes(st) ? "ranked_desc" : "updated_desc";
const fEmpty = () => ({ g: 0, l: 0, video: false, sb: false, nsfw: false, sort: "", tags: [], r: {} });
function fFromParams(p) {
  const f = fEmpty();
  f.g = GENRES.some(x => x[0] === +p.get("g")) ? +p.get("g") : 0;
  f.l = LANGUAGES.some(x => x[0] === +p.get("l")) ? +p.get("l") : 0;
  const e = (p.get("e") || "").split("."); f.video = e.includes("video"); f.sb = e.includes("storyboard");
  f.nsfw = p.get("nsfw") === "1";
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
  for (const t of f.tags) p.append("tag", t);
  for (const [k] of RANGES) { const v = f.r[k]; if (v) p.set(k, `${v[0] ?? ""}-${v[1] ?? ""}`); }
  return p;
}
const fKey = f => f ? fToParams(f, new URLSearchParams()).toString() : "";
const fCount = f => !f ? 0 : (f.g ? 1 : 0) + (f.l ? 1 : 0) + (f.video ? 1 : 0) + (f.sb ? 1 : 0) + (f.nsfw ? 1 : 0) + (f.sort ? 1 : 0) + f.tags.length + Object.keys(f.r).length;
// filters only the osu! search can do (the mirrors' results are filtered in the page for the rest)
const fNeedsOsu = f => !!f && (f.tags.length > 0 || !!f.sort);
// the osu! search text: keywords + stars>=5 bpm<=200 length<=120 tag="tech/slider tech" ...
function fQuery(q, f) {
  const parts = [q.trim()];
  if (f) {
    for (const [k, key] of RANGES) { const v = f.r[k]; if (!v) continue; if (v[0] != null) parts.push(`${key}>=${v[0]}`); if (v[1] != null) parts.push(`${key}<=${v[1]}`); }
    for (const t of f.tags) parts.push(`tag="${t}"`);
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
  const inR = (v, r) => v != null && !isNaN(v) && (r[0] == null || v >= r[0] - 1e-6) && (r[1] == null || v <= r[1] + 1e-6);
  const diffKey = { sr: "stars", ar: "ar", cs: "cs", od: "od", hp: "hp", len: "len", bpm: "bpm" };
  for (const [k] of RANGES) {
    const r = f.r[k]; if (!r) continue;
    if (!s.diffs.length) { if (k === "bpm" && !inR(s.bpm, r)) return false; if (k === "len" && !inR(s.len, r)) return false; continue; }
    if (!s.diffs.some(d => inR(+d[diffKey[k]] || (k === "bpm" ? s.bpm : NaN), r))) return false;
  }
  return true;
}

// ---------- osu!-style search keywords: source="touhou" stars>5 bpm>=180 length<2:30 status=loved ranked>2024 ----------
// One parser for the search box (key=value and the site's key:value, "quotes" for spaces, > >= < <=, aliases such as
// mapper/sr). osu! gets the text as typed (aliases renamed to its own keys), each mirror the keys it understands
// (MIRRORS[].kw) plus the words of the rest, and kwMatch() filters any source's results here for everything else,
// so the list is right whichever source answered.
const KW_KEYS = { artist: "text", title: "text", source: "text", creator: "text", tag: "text", difficulty: "text",
  stars: "num", ar: "num", cs: "num", od: "num", hp: "num", bpm: "num", length: "len", drain: "len", status: "status", ranked: "date", created: "date", updated: "date" };
const KW_ALIAS = { mapper: "creator", author: "creator", star: "stars", sr: "stars", diff: "difficulty", version: "difficulty", tags: "tag", dr: "hp", accuracy: "od", submitted: "created" };
// the names osu!'s own search knows (drain time is osu!stable's song select only: it's filtered here)
const KW_OSU = new Set([...Object.keys(KW_KEYS).filter(k => k !== "drain"), "star", "dr"]);
const KW_STATUS = { r: "ranked", a: "approved", q: "qualified", l: "loved", p: "pending", w: "wip", g: "graveyard" };
const KW_TOL = { stars: .005, bpm: .005, ar: .05, cs: .05, od: .05, hp: .05 }; // osu!'s rounding: stars=5.2 is 5.195–5.205
// own keys only: "__proto__" / "constructor" typed as a key or a status are not keywords
const kwOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
const KW_RE = /(^|\s)([a-z_]+)(==|>=|<=|>:|<:|[:=<>])("[^"]*(?:"!?|$)|[^\s"]\S*)/gi;
// "150", "150s", "2m30s", "1h", "2:30" -> seconds, ± half the smallest unit typed (osu!: length=2m is 1:30–2:30)
function kwLen(v) {
  let m = v.match(/^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return { n: (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3], tol: .5 };
  m = v.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/i);
  if (m && m[0]) return { n: (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) + (+m[4] || 0) / 1000, tol: m[4] ? .0005 : m[3] ? .5 : m[2] ? 30 : 1800 };
  return /^\d+(\.\d+)?$/.test(v) ? { n: +v, tol: .5 } : null;
}
function kwTerm(rawKey, op, v, exact) {
  const key = kwOwn(KW_ALIAS, rawKey) || rawKey, kind = kwOwn(KW_KEYS, key); if (!kind || !v) return null;
  const t = { key, rawKey, kind, op, v, exact };
  if (kind === "text") return op === "=" ? t : null;
  if (kind === "status") { const s = kwOwn(KW_STATUS, v.toLowerCase()) || Object.values(KW_STATUS).find(x => x === v.toLowerCase()); return op === "=" && s ? { ...t, v: s } : null; }
  if (kind === "num") return /^\d*\.?\d+$/.test(v) ? { ...t, n: +v, tol: kwOwn(KW_TOL, key) } : null;
  if (kind === "len") { const l = kwLen(v); return l ? { ...t, ...l } : null; }
  const m = v.match(/^(\d{4})(?:[-./](\d{1,2})(?:[-./](\d{1,2}))?)?$/); if (!m) return null; // dates: a year, a month or a day
  const y = +m[1], mo = m[2] ? +m[2] - 1 : 0, d = m[3] ? +m[3] : 1;
  return { ...t, from: Date.UTC(y, mo, d), to: m[3] ? Date.UTC(y, mo, d + 1) : m[2] ? Date.UTC(y, mo + 1, 1) : Date.UTC(y + 1, 0, 1) };
}
// -> { text: the free words, terms: [{ key, rawKey, kind, op, v, ... start, end }] } (start/end: where the term is in raw)
function kwParse(raw) {
  const s = String(raw || ""), terms = []; let text = "", at = 0;
  for (const m of s.matchAll(KW_RE)) {
    let v = m[4], exact = false;
    if (v[0] === '"') { exact = v.endsWith('"!'); v = v.slice(1).replace(/"!?$/, ""); }
    const op = { ":": "=", "==": "=", ">:": ">=", "<:": "<=" }[m[3]] || m[3];
    const t = kwTerm(m[2].toLowerCase(), op, v.trim(), exact); if (!t) continue;
    const start = m.index + m[1].length, end = m.index + m[0].length;
    text += s.slice(at, start); at = end; terms.push({ ...t, start, end });
  }
  return { text: (text + s.slice(at)).replace(/\s+/g, " ").trim(), terms };
}
const kwQuote = v => (v = String(v ?? ""), /[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);
const kwLabel = (t, key = t.key) => `${key}${t.op}${kwQuote(t.v)}${t.exact ? "!" : ""}`;
const kwStatus = kw => { const t = kw.terms.filter(t => t.kind === "status").pop(); return t ? t.v : ""; };
const kwText = q => kwParse(q).text;
// raw without some of its terms (removing a pill, or a status chip replacing status=)
function kwStrip(raw, drop = () => true) {
  const s = String(raw || ""); let out = "", at = 0;
  for (const t of kwParse(s).terms) if (drop(t)) { out += s.slice(at, t.start); at = t.end; }
  return (out + s.slice(at)).replace(/\s+/g, " ").trim();
}
// the osu! search text: as typed, with aliases renamed (mapper= -> creator=), drain= left out (kwOsuLocal filters it)
// and lengths as seconds (osu! reads plain numbers; length=2m becomes the range it means)
function kwOsuQuery(raw) {
  const s = String(raw || ""); let out = "", at = 0;
  for (const t of kwParse(s).terms) {
    out += s.slice(at, t.start); at = t.end;
    if (!KW_OSU.has(t.key)) continue;
    const key = KW_OSU.has(t.rawKey) ? t.rawKey : t.key, n = x => +x.toFixed(3);
    out += t.kind !== "len" ? kwLabel(t, key) : t.op === "=" && t.tol > .5 ? `${key}>=${n(t.n - t.tol)} ${key}<${n(t.n + t.tol)}` : `${key}${t.op}${n(t.n)}`;
  }
  return (out + s.slice(at)).replace(/\s+/g, " ").trim();
}
const kwOsuLocal = kw => kw.terms.filter(t => !KW_OSU.has(t.key));
// what a mirror gets in its text search: the free words, the words of text keys it doesn't know (artist=xi -> xi),
// and the keys it does know written osu!-style. Numbers, dates and status are left to its params / kwMatch.
function kwMirrorQ(kw, native = []) {
  const w = [kw.text];
  for (const t of kw.terms) {
    if (native.includes(t.key)) w.push(t.kind === "len" ? `${t.key}${t.op}${+t.n.toFixed(3)}` : kwLabel(t));
    else if (t.kind === "text" && !(t.key === "tag" && t.v.includes("/"))) w.push(t.v);
  }
  return w.filter(Boolean).join(" ");
}
// does a normalised set (normSet) pass every term? One difficulty has to pass all the difficulty terms, like on osu!.
function kwMatch(s, terms) {
  const low = x => String(x ?? "").toLowerCase();
  const txt = (fields, t) => { const v = low(t.v); return fields.some(f => t.exact ? low(f) === v : low(f).includes(v)); };
  const num = (x, t) => { if (x == null || x === "" || isNaN(x)) return false; x = +x; const tol = t.tol || 0;
    return t.op === "=" ? x >= t.n - tol && x <= t.n + tol : t.op === ">" ? x > t.n + tol - 1e-9 : t.op === ">=" ? x >= t.n - tol : t.op === "<" ? x < t.n - tol + 1e-9 : x <= t.n + tol; };
  const date = (x, t) => { const d = Date.parse(x || ""); if (isNaN(d)) return false;
    return t.op === "=" ? d >= t.from && d < t.to : t.op === ">" ? d >= t.to : t.op === ">=" ? d >= t.from : t.op === "<" ? d < t.from : d < t.to; };
  const DIFF = { stars: "stars", ar: "ar", cs: "cs", od: "od", hp: "hp", bpm: "bpm", length: "len", drain: "drain" }, per = [];
  for (const t of terms) {
    const k = t.key;
    if (k === "artist" && !txt([s.artist, s.artistU], t)) return false;
    if (k === "title" && !txt([s.title, s.titleU], t)) return false;
    if (k === "source" && !txt([s.source], t)) return false;
    if (k === "creator" && !txt([s.creator, ...(s.diffs || []).map(d => d.guest).filter(Boolean)], t)) return false;
    if (k === "tag" && !t.v.includes("/") && !txt([s.tags], t)) return false; // (player tags like "tech/slider tech": osu! only)
    if (t.kind === "status" && !stMatch(s.status, t.v)) return false;
    if (t.kind === "date" && !date(k === "ranked" ? s.ranked : k === "created" ? s.submitted : s.updated, t)) return false;
    if (DIFF[k] || k === "difficulty") per.push(t);
  }
  if (!per.length) return true;
  if (!s.diffs || !s.diffs.length) return per.every(t => t.key === "bpm" ? num(s.bpm, t) : t.key === "length" ? num(s.len, t) : true); // (no difficulty list: what the set says)
  return s.diffs.some(d => per.every(t => t.key === "difficulty" ? txt([d.name], t) : num(t.key === "bpm" ? (+d.bpm || s.bpm) : d[DIFF[t.key]], t)));
}

// ---------- osu! data through our server ----------
const osuTagsP = { p: null };
function osuTags() { // [{ name, description, ruleset_id }] for osu!standard, or [] without the server
  if (!osuTagsP.p) osuTagsP.p = fetchJSON("/api/v1/osu/tags", null, 12000).then(j => j.tags || []).catch(() => { osuTagsP.p = null; return []; });
  return osuTagsP.p.then(a => a.filter(t => t.ruleset_id == null || t.ruleset_id === 0));
}
async function osuSearch(o, signal) { // o: { q, st, f, cursor }
  const kw = kwParse(o.q), local = kwOsuLocal(kw); // (status=… in the text: osu! filters by it, so all statuses here)
  const p = new URLSearchParams({ s: kwStatus(kw) ? "any" : o.st ? o.st : "any" });
  const q = fQuery(kwOsuQuery(o.q), o.f); if (q) p.set("q", q);
  const f = o.f || fEmpty();
  if (f.g) p.set("g", f.g); if (f.l) p.set("l", f.l);
  const e = [f.video && "video", f.sb && "storyboard"].filter(Boolean).join("."); if (e) p.set("e", e);
  if (f.nsfw) p.set("nsfw", "1"); p.set("sort", f.sort || defSort(o.q, kwStatus(kw) || o.st));
  if (o.cursor) p.set("cursor", o.cursor);
  const r = await fetch("/api/v1/osu/search?" + p, { signal, cache: fetchFresh ? "reload" : "default" });
  if (!(r.headers.get("content-type") || "").includes("json")) { osuApi.ok = false; throw new Error("no server"); }
  const j = await r.json();
  if (!r.ok) { if (r.status === 503 || r.status === 404) osuApi.ok = false; throw new Error(j.error || "HTTP " + r.status); }
  osuApi.ok = true;
  const list = (j.sets || []).map(normSet).filter(Boolean);
  return { list: local.length ? list.filter(s => kwMatch(s, local)) : list, cursor: j.cursor || null, total: local.length ? null : j.total };
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
