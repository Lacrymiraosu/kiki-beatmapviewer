"use strict";
// ============ mirrors & API ============
// search(o) gets { q, creator, st, page } and returns a URL (or null when the mirror can't do that query)
const PS = 30;
// which game mode the lists show: 0 osu!, 3 osu!mania (Beatmap → mode picker)
const gameMode = () => +S.gameMode === 3 ? 3 : 0;
// the game modes the site plays and edits (taiko and catch aren't supported yet)
const GAME_MODES = [[0, "osu!"], [3, "osu!mania"]];
const modeName = (m = gameMode()) => m === 3 ? "osu!mania" : "osu!";
const MODE_OF = b => { const m = b.mode_int ?? b.Mode ?? b.mode; return m === "osu" ? 0 : m === "mania" ? 3 : m === "taiko" ? 1 : m === "fruits" ? 2 : +m; };
const enc = encodeURIComponent;
const CB_ST = { ranked: 1, qualified: 3, loved: 4, pending: 0, graveyard: -2 };
const cbCreator = n => "creator=" + (/\s/.test(n) ? `"${n}"` : n);
const MIRRORS = [
  { id: "osudirect", name: "osu.direct",
    search: o => o.creator ? null : `https://osu.direct/api/v2/search?q=${enc(o.q)}&query=${enc(o.q)}&amount=${PS}&offset=${o.page * PS}&mode=${gameMode()}${o.st in CB_ST ? "&status=" + CB_ST[o.st] : ""}`,
    set: id => `https://osu.direct/api/v2/s/${id}`, bm: id => `https://osu.direct/api/v2/b/${id}`,
    dl: id => `https://osu.direct/api/d/${id}?noVideo=1` },
  { id: "nerinyan", name: "Nerinyan",
    search: o => `https://api.nerinyan.moe/search?q=${enc(o.creator || o.q)}&ps=${PS}&p=${o.page}&m=${gameMode()}${o.creator ? "&option=creator" : ""}${o.st && o.st !== "leaderboard" ? "&s=" + o.st : o.creator || o.st ? "&s=all" : ""}`,
    dl: id => `https://api.nerinyan.moe/d/${id}?noVideo=true` },
  { id: "catboy", name: "catboy.best",
    search: o => `https://catboy.best/api/v2/search?q=${enc(o.creator ? cbCreator(o.creator) : o.q)}&limit=${PS}&offset=${o.page * PS}&mode=${gameMode()}${o.st in CB_ST ? "&status=" + CB_ST[o.st] : ""}`,
    set: id => `https://catboy.best/api/v2/s/${id}`, bm: id => `https://catboy.best/api/v2/b/${id}`,
    dl: id => `https://catboy.best/d/${id}n` },
  { id: "sayobot", name: "Sayobot", search: null, dl: id => `https://dl.sayobot.cn/beatmaps/download/novideo/${id}` },
];
const mirrorById = id => MIRRORS.find(m => m.id === id);
function orderedMirrors(prefer) {
  const a = mirrorById(prefer) || mirrorById(S.mirror) || MIRRORS[0];
  return [a, ...MIRRORS.filter(m => m !== a)];
}
const dlURL = id => (mirrorById(S.mirror) || MIRRORS[0]).dl(id);
const osuDlURL = sid => `https://osu.ppy.sh/beatmapsets/${sid}/download`;
const osuSetURL = (sid, bid) => `https://osu.ppy.sh/beatmapsets/${sid}${bid ? "#osu/" + bid : ""}`;
function fillMirrors() { const sel = $("mirrorSel"); sel.innerHTML = ""; MIRRORS.forEach(m => sel.add(new Option(m.name + (m.search ? "" : " (" + tr("download only") + ")"), m.id))); sel.value = S.mirror; }
fillMirrors();
addEventListener("langchange", fillMirrors);
$("mirrorSel").onchange = e => {
  S.mirror = e.target.value; save(); toast(tr("Using {name} first; if it's down another mirror is tried automatically", { name: e.target.selectedOptions[0].text }));
  if (typeof refreshList === "function") refreshList(); // show that mirror's list right away
};

const STATUS = { "-2": "graveyard", "-1": "wip", "0": "pending", "1": "ranked", "2": "approved", "3": "qualified", "4": "loved" };
const ST_MATCH = { ranked: ["ranked", "approved"], pending: ["pending", "wip"], leaderboard: ["ranked", "approved", "qualified", "loved"] };
const stMatch = (status, st) => (ST_MATCH[st] || [st]).includes(status);
function normSet(s) {
  if (!s || typeof s !== "object") return null;
  const id = s.id ?? s.SetID ?? s.beatmapset_id ?? s.sid;
  if (!id) return null;
  const maps = s.beatmaps || s.ChildrenBeatmaps || [];
  const std = maps.filter(b => MODE_OF(b) === gameMode());
  if (maps.length && !std.length) return null; // no difficulty in the chosen mode
  const creator = s.creator ?? s.Creator ?? "";
  const stars = std.map(b => +(b.difficulty_rating ?? b.DifficultyRating ?? 0)).filter(x => x > 0);
  const diffs = std.map(b => {
    const owner = (b.owners && b.owners[0] && b.owners[0].username) || "";
    return {
      bid: b.id ?? b.BeatmapID, mode: MODE_OF(b), name: b.version ?? b.DiffName ?? "?", stars: +(b.difficulty_rating ?? b.DifficultyRating ?? 0),
      cs: b.cs ?? b.CS, ar: b.ar ?? b.AR, od: b.accuracy ?? b.OD, hp: b.drain ?? b.HP,
      len: +(b.total_length ?? b.TotalLength ?? 0), drain: +(b.hit_length ?? b.HitLength ?? 0), bpm: +(b.bpm ?? b.BPM ?? 0),
      circles: b.count_circles, sliders: b.count_sliders, spinners: b.count_spinners, combo: b.max_combo,
      guest: owner && owner.toLowerCase() !== creator.toLowerCase() ? owner : "",
    };
  }).sort((a, b) => a.stars - b.stars);
  let st = s.status ?? s.RankedStatus ?? s.ranked ?? "";
  if (STATUS[st] !== undefined) st = STATUS[st];
  return { id, title: s.title ?? s.Title ?? "", artist: s.artist ?? s.Artist ?? "", creator, uid: s.user_id ?? (s.user && s.user.id) ?? null,
    status: String(st).toLowerCase(), stars, diffs, source: s.source || "", tags: s.tags || "", video: !!s.video, storyboard: !!s.storyboard,
    bpm: +(s.bpm ?? s.BPM ?? diffs[0]?.bpm ?? 0), len: Math.max(0, ...diffs.map(d => d.len)), plays: s.play_count ?? s.playcount, favs: s.favourite_count,
    submitted: s.submitted_date || "", ranked: s.ranked_date || "", updated: s.last_updated || s.LastUpdate || "",
    genre: +(s.genre_id ?? (s.genre && s.genre.id) ?? 0) || null, language: +(s.language_id ?? (s.language && s.language.id) ?? 0) || null, nsfw: !!s.nsfw };
}

// fetch JSON with a timeout, the caller's abort signal, and a short in-memory cache
const jsonCache = new Map();
let fetchFresh = false; // set by the Refresh button: skip this cache and the browser's for the next list load
async function fetchJSON(url, signal, ms = 9000) {
  const hit = jsonCache.get(url);
  if (hit && !fetchFresh && Date.now() - hit.at < 300000) return hit.data;
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
  const onAbort = () => ctl.abort();
  signal && signal.addEventListener("abort", onAbort);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: fetchFresh ? "reload" : "default" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    jsonCache.set(url, { at: Date.now(), data });
    if (jsonCache.size > 60) jsonCache.delete(jsonCache.keys().next().value);
    return data;
  } catch (e) {
    if (signal && signal.aborted) throw e;
    throw ctl.signal.aborted ? new Error(tr("timed out")) : e;
  } finally { clearTimeout(tm); signal && signal.removeEventListener("abort", onAbort); }
}

// ---------- osu! profiles and beatmap lists through our server (osu!api v2, cached) ----------
// Unavailable when the site runs without the server (plain static hosting / localhost): then mapper pages use the mirrors.
const USER_TYPES = [["ranked", "Ranked"], ["loved", "Loved"], ["pending", "Pending"], ["graveyard", "Graveyard"], ["guest", "Guest"], ["nominated", "Nominated"]];
const osuApi = { ok: null, users: new Map() };
async function osuUser(name, signal) {
  const k = String(name).toLowerCase();
  if (osuApi.users.has(k)) return osuApi.users.get(k);
  if (osuApi.ok === false) return null;
  try {
    const r = await fetch("/api/v1/osu/user?u=" + enc(name), { signal });
    if (!(r.headers.get("content-type") || "").includes("json")) { osuApi.ok = false; return null; }
    const j = await r.json();
    if (r.status === 404 && j.error === "not_found") { osuApi.ok = true; osuApi.users.set(k, false); return false; }
    if (!r.ok) { if (r.status === 503 || r.status === 404) osuApi.ok = false; return null; }
    osuApi.ok = true; osuApi.users.set(k, j.user); return j.user;
  } catch (e) { if (signal && signal.aborted) throw e; return null; }
}
async function osuUserSets(id, type, offset, signal) {
  const j = await fetchJSON(`/api/v1/osu/beatmaps?id=${id}&type=${type}&offset=${offset}&limit=20`, signal, 12000);
  return (j.sets || []).map(normSet).filter(Boolean);
}
// an avatar that falls back to the first letter of the name when there's no picture (or it can't load)
function avatarEl(uid, name, cls = "cav") {
  const el = h("span", cls, String(name || "?").trim().slice(0, 1).toUpperCase());
  el.setAttribute("aria-hidden", "true");
  if (uid > 0 && uid < 1e12) { const img = h("img"); img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer"; img.src = `https://a.ppy.sh/${uid}`; img.onerror = () => img.remove(); img.onload = () => el.classList.add("pic"); el.append(img); }
  return el;
}

async function searchSets(o, signal, prefer) {
  let lastErr = null;
  for (const mi of orderedMirrors(prefer)) {
    const url = mi.search && mi.search(o); if (!url) continue;
    try {
      const data = await fetchJSON(url, signal);
      const arr = Array.isArray(data) ? data : (data.beatmapsets || data.data || data.results || []);
      let list = arr.map(normSet).filter(Boolean);
      if (o.creator) { const c = o.creator.toLowerCase(); list = list.filter(s => s.creator.toLowerCase() === c); }
      if (o.st) list = list.filter(s => stMatch(s.status, o.st));
      return { list, src: mi, more: arr.length >= PS };
    } catch (e) { if (signal && signal.aborted) throw e; lastErr = e; }
  }
  throw lastErr || new Error(tr("no mirror supports this search"));
}
// map info: the mirrors first, then osu! itself through our server (new / pending maps often aren't on the mirrors yet)
async function lookupSet(id, signal) {
  for (const mi of orderedMirrors().filter(m => m.set)) {
    try { const s = normSet(await fetchJSON(mi.set(id), signal)); if (s) return s; }
    catch (e) { if (signal && signal.aborted) throw e; }
  }
  if (typeof osuSet === "function") { const s = await osuSet(id); if (s) return normSet(s); }
  return null;
}
async function lookupBeatmap(bid, signal) {
  for (const mi of orderedMirrors().filter(m => m.bm)) {
    try { const j = await fetchJSON(mi.bm(bid), signal); const sid = j.beatmapset_id ?? (j.beatmapset && j.beatmapset.id) ?? j.set_id; if (sid) return sid; }
    catch (e) { if (signal && signal.aborted) throw e; }
  }
  if (osuApi.ok !== false) { try { const j = await fetchJSON("/api/v1/osu/beatmap?id=" + enc(bid), signal); if (j.set_id) return j.set_id; } catch (e) { if (signal && signal.aborted) throw e; } }
  return null;
}
