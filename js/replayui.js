"use strict";
// ============ replays (.osr): the results screen, watching, the Replays page and the copies kept on this device ============
// Loaded on first use (loadLazy("replayui"), js/app.js); needs js/replay.js (parseOsr, replayMods, ...) and RP / rpStart in js/auto.js.
// Flow: file -> parseOsr -> sha256 -> kept in IndexedDB ("obv" -> "replays") -> results screen (the beatmap is looked up
// meanwhile) -> Watch replay (the map is opened without the detail panel, its .osu bytes checked against the replay's
// map MD5) -> rpStart -> when it ends the end menu: Home / Replay / Results.
// Logged in, a replay can also be saved online for 60 days (GET/POST/DELETE /api/v1/replays, the "Saved online" part below).
const RPU_MAX = 100 * 1048576, RPU_COUNT = 30; // (the copies kept: the least recently used go first, like the downloaded maps)
const RPU_MAPKEY = "obv-replay-map"; // localStorage: { <map md5>: { setId, beatmapId } }
const RPU = { sess: null, res: null, end: null, card: null, ask: false, busy: false, intro: null };
const rpuAsk = self.ask;
const rpuHex32 = s => /^[0-9a-f]{32}$/.test(String(s || ""));
const rpuId = v => { v = +v; return Number.isSafeInteger(v) && v > 0 ? v : null; };

// ---------- what the replay says (lazer replays: the statistics and rank lazer wrote, else the header) ----------
function rpuStats(d) {
  const li = d.lazerInfo, st = li && li.statistics && typeof li.statistics === "object" ? li.statistics : null, c = d.counts;
  let counts = { n300: c.n300, n100: c.n100, n50: c.n50, miss: c.miss, geki: c.geki, katu: c.katu };
  if (st && ["great", "ok", "meh", "miss"].some(k => Number.isFinite(+st[k]))) {
    const g = k => (Number.isFinite(+st[k]) ? +st[k] : 0);
    counts = { n300: g("great"), n100: g("ok"), n50: g("meh"), miss: g("miss"), geki: 0, katu: 0 };
  }
  const mods = replayMods(d.mods, li);
  let rank = li && typeof li.rank === "string" ? li.rank.toUpperCase() : "";
  if (rank === "F") rank = "D";
  if (!/^(XH|X|SH|S|A|B|C|D)$/.test(rank)) rank = replayRank(counts, mods);
  const ra = li && li.raw && Number(li.raw.accuracy);
  const acc = d.lazer && Number.isFinite(ra) && ra >= 0 && ra <= 1 ? ra : replayAccuracy(counts);
  return { counts, mods, rank, acc, score: d.score }; // (lazer's JSON has no total_score: the header's standardised score is the one)
}
const RPU_RANK = { X: ["SS", ""], XH: ["SS", " h"], S: ["S", ""], SH: ["S", " h"], A: ["A", ""], B: ["B", ""], C: ["C", ""], D: ["D", ""] };
function rpuRankEl(rank, cls) { const r = RPU_RANK[rank] || RPU_RANK.D; return h("span", (cls || "rprk") + " r-" + r[0] + r[1], r[0]); }
function rpuChips(list, off) {
  const box = h("span", "rpmods");
  for (const a of list || []) { const c = h("span", "rpmod" + (off && off.includes(a) ? " off" : ""), a); if (off && off.includes(a)) c.title = tr("Shown, not applied"); box.append(c); }
  return box;
}
const rpuMetaOf = s => {
  const d = s.data, st = rpuStats(d), i = s.info;
  return { mode: d.mode, player: d.player, mapMd5: d.mapMd5, title: i.title || "", artist: i.artist || "", version: i.version || "", creator: i.creator || "", setId: i.setId || null, beatmapId: i.beatmapId || null,
    score: st.score, combo: d.maxCombo, acc: st.acc, rank: st.rank, mods: d.mods, modNames: st.mods.list, modsOff: st.mods.unsupported, counts: st.counts, date: d.date, lazer: d.lazer };
};

// ---------- the copies kept on this device (IndexedDB "obv" -> "replays", db version 4 in js/skins.js) ----------
async function replayCacheList() { try { return ((await idbTx("replays", "readonly", s => s.getAll())) || []).sort((a, b) => b.usedAt - a.usedAt); } catch { return []; } } // (the blobs stay on disk until read)
async function rpuTrim() {
  const all = await replayCacheList(); let total = 0;
  const drop = all.filter((r, i) => (total += r.size) > RPU_MAX || i >= RPU_COUNT).map(r => r.id);
  if (drop.length) await idbTx("replays", "readwrite", s => { for (const id of drop) s.delete(id); });
}
const rpuFull = e => { if (e && e.name === "QuotaExceededError") toast(tr("Couldn't keep this replay on this device (storage is full)"), 4000); };
const rpuClean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null)); // (a lookup that found nothing must not blank what is known)
// kept once per file (the sha256 is the key); a second time only touches usedAt and adds what is new
const RPU_PUTS = new Map(); // id -> the save still running (a patch of the same copy waits for it)
function rpuPut(id, bytes, meta) {
  const p = rpuPutNow(id, bytes, meta).finally(() => { if (RPU_PUTS.get(id) === p) RPU_PUTS.delete(id); });
  RPU_PUTS.set(id, p); return p;
}
async function rpuPutNow(id, bytes, meta) {
  const now = Date.now();
  try {
    const old = await idbTx("replays", "readonly", s => s.get(id));
    const rec = old ? { ...old, usedAt: now, meta: { ...old.meta, ...rpuClean(meta) } } : { id, savedAt: now, usedAt: now, size: bytes.length, blob: new Blob([bytes]), meta };
    await idbTx("replays", "readwrite", s => s.put(rec));
    await rpuTrim();
    rpuRefreshViews();
    return rec;
  } catch (e) { rpuFull(e); return { id, savedAt: now, usedAt: now, size: bytes.length, blob: new Blob([bytes]), meta, volatile: true }; }
}
async function rpuPatch(id, patch) {
  try {
    await RPU_PUTS.get(id);
    const old = await idbTx("replays", "readonly", s => s.get(id)); if (!old) return;
    await idbTx("replays", "readwrite", s => s.put({ ...old, usedAt: Date.now(), meta: { ...old.meta, ...rpuClean(patch) } }));
    rpuRefreshViews();
  } catch {}
}
async function replayCacheClear() { try { await idbTx("replays", "readwrite", s => s.clear()); } catch {} rpuRefreshViews(); }
async function rpuDelete(id) { try { await idbTx("replays", "readwrite", s => s.delete(id)); } catch {} rpuRefreshViews(); }
function rpuRefreshViews() {
  if (typeof R !== "undefined" && R.view === "replays" && $("replays") && !$("replays").hidden) renderReplays();
  const box = $("replayCache"); if (box && box.getClientRects().length) replayCacheUI(box);
}
const rpuSize = list => list.reduce((n, r) => n + r.size, 0) / 1048576;
// Settings → General, next to the downloaded maps
async function replayCacheUI(box) {
  if (!box) return;
  const all = await replayCacheList(), mb = rpuSize(all);
  box.innerHTML = "";
  const t = h("span"); t.append(h("b", null, tr("Replays")), h("small", null, tr("{n} replays kept on this device · {mb} MB (up to {max} replays / {maxmb} MB).", { n: all.length, mb: mb.toFixed(1), max: RPU_COUNT, maxmb: RPU_MAX / 1048576 })));
  const b = h("button", "btn ghost sm", tr("Delete all")); b.disabled = !all.length;
  b.onclick = () => rpuDeleteAll(all.length);
  box.append(t, b);
}
async function rpuDeleteAll(n) {
  if (!(await rpuAsk(tr("Delete the {n} replays kept on this device?", { n }), { ok: tr("Delete"), danger: true }))) return;
  await replayCacheClear(); toast(tr("Replays deleted"), 1500);
}

// the beatmap of a replay once found: ids in localStorage by the map's MD5, so the next time needs no lookup
function rpuMapGet(md5) {
  if (!rpuHex32(md5)) return null;
  try { const v = (JSON.parse(localStorage.getItem(RPU_MAPKEY) || "{}") || {})[md5]; return v && rpuId(v.setId) ? { setId: rpuId(v.setId), beatmapId: rpuId(v.beatmapId) } : null; } catch { return null; }
}
function rpuMapSet(md5, setId, beatmapId) {
  if (!rpuHex32(md5) || !rpuId(setId)) return;
  try {
    const m = JSON.parse(localStorage.getItem(RPU_MAPKEY) || "{}") || {}; delete m[md5]; m[md5] = { setId: rpuId(setId), beatmapId: rpuId(beatmapId) };
    for (const k of Object.keys(m).slice(0, Math.max(0, Object.keys(m).length - 200))) delete m[k];
    localStorage.setItem(RPU_MAPKEY, JSON.stringify(m));
  } catch {}
}

// ---------- reading a file ----------
async function rpuSha(bytes) {
  try { if (self.crypto && crypto.subtle) return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join(""); } catch {}
  return "m" + md5Hex(bytes) + bytes.length.toString(16); // (no secure context: the MD5 and the size are as good a key)
}
async function rpuRead(f) {
  if (f.size > 8 * 1048576) throw Object.assign(new Error("osr_too_big"), { code: "osr_too_big" });
  const bytes = new Uint8Array(await f.arrayBuffer()), data = parseOsr(bytes); // (throws Error(code))
  return { bytes, data, id: await rpuSha(bytes) };
}
function rpuError(e) {
  const code = e && e.code, big = code === "osr_too_big";
  return modal({ title: tr("Can't open this replay"), icon: "warn", dismiss: true,
    body: code === "mode" ? tr("Only osu!standard replays can be watched yet") : big ? tr("This replay file is too big") : tr("This isn't a valid .osr replay file, it may be broken"),
    buttons: [{ label: tr("OK"), value: true, cls: "main" }] });
}

// ---------- a pasted osu! score link (https://osu.ppy.sh/scores/4558339434, also .../scores/osu/4558339434) ----------
// The site asks osu! for the replay file itself (GET /api/v1/osu/replay: the app's own token); if osu! won't give it to us (it may want a signed-in player), or the site can't
// reach it, osu!'s own download page is offered and the .osr is dropped here, as before. Never fetches anything but that one score's file.
const rpuScoreId = s => { const m = String(s || "").match(/osu\.ppy\.sh\/scores\/(?:[a-z]+\/)?(\d{1,12})(?!\d)/i); return m ? m[1] : ""; };
async function rpuPasteScore(raw) {
  const id = rpuScoreId(raw) || (/^\d{1,12}$/.test(String(raw)) ? String(raw) : ""); if (!id) return toast(tr("That isn't an osu! score link"), 3500); // (a link, or the id the search box already took out of one)
  if (!featGuard("replays")) return;
  const ctl = dlCtl = new AbortController(); let bytes = null, err = "";
  showLoading(tr("Getting the replay from osu!…"), -1);
  try {
    const r = await fetch("/api/v1/osu/replay?score=" + id, { signal: ctl.signal, credentials: "same-origin" });
    if (r.ok) bytes = new Uint8Array(await r.arrayBuffer()); else { const j = await r.json().catch(() => null); err = j && j.error || "http_" + r.status; }
  } catch (e) { if (e && e.name === "AbortError") { hideLoading(); return; } err = "network"; }
  finally { if (dlCtl === ctl) dlCtl = null; }
  hideLoading();
  if (bytes && bytes.length > 100) { toast(tr("Opened from osu!: it isn't saved on this site. Share gives a link that gets it from osu! again."), 6000); return replayOpenFiles([new File([bytes], "score-" + id + ".osr")], { osuScore: id }); }
  if (err === "not_found") return toast(tr("osu! has no replay for this score (it may be too old, or deleted)"), 6000);
  const go = await modal({ title: tr("Get the replay from osu!"), icon: "info", dismiss: false,
    body: tr("This site couldn't get the replay from osu! itself.\n\nOpen the score on osu!, press Download replay (you need to be logged in to osu!), then drop the .osr file on this page."),
    buttons: [{ label: tr("Cancel"), value: false }, { label: tr("Open on osu!"), cls: "main", value: () => { try { open("https://osu.ppy.sh/scores/" + id + "/download", "_blank", "noopener"); } catch {} return true; } }] });
  if (go) toast(tr("When the download finishes, drop the .osr file on this page or press \"Choose file\""), 7000);
}

// ---------- entry: files from the file picker or a drop (js/app.js openPicked) ----------
async function replayOpenFiles(files, opts) { // (opts.info: what an online copy already says of the map; opts.shared: someone's shared replay: view only, kept nowhere; opts.osuScore: the score id of a replay fetched from osu!: kept nowhere either, and shared as a link that fetches it again)
  if (!featGuard("replays")) return;
  try { await loadLazy("replay"); } catch (e) { toast(e.message, 4000); return; }
  const osr = files.filter(f => fileIs(f, ["osr"])), maps = files.filter(f => fileIs(f, ["osz", "zip", "osu"]));
  if (!osr.length) { // a map while a replay waits for its map
    const s = RPU.sess; if (!s || !RPU.res) return;
    if (await rpuUseMap(s, maps)) { rpuCloseAsk(); rpuRefresh(s); }
    return;
  }
  showLoading(tr("Reading the replay…"), -1);
  let first = null, err = null; const rest = [];
  try {
    for (const f of osr.slice(0, 30)) {
      let r; try { r = await rpuRead(f); } catch (e) { err = err || e; continue; }
      if (r.data.mode !== 0) { err = err || Object.assign(new Error("mode"), { code: "mode" }); continue; }
      if (!first) first = r; else rest.push(r);
    }
  } finally { hideLoading(); }
  if (!first) { await rpuError(err); return; }
  // (the results don't wait for the storage: it may be slow, or blocked by an old tab for a few seconds)
  const meta = rpuMetaOf({ data: first.data, info: (opts && opts.info) || {} }), s = rpuNewSession(first.data, { rec: { id: first.id, savedAt: Date.now(), usedAt: Date.now(), size: first.bytes.length, blob: new Blob([first.bytes]), meta } });
  if (opts && opts.shared) s.shared = true;
  if (opts && /^\d{1,12}$/.test(String(opts.osuScore || ""))) { s.shared = true; s.osuScore = String(opts.osuScore); } // (from osu!: no copy here, no Save online; Share is the link ?score=)
  rpuShowRes(s);
  if (!s.shared) rpuPut(first.id, first.bytes, meta).then(rec => { // (what the copy kept before knew of the map)
    const m = rec.meta || {}; if (RPU.sess !== s) return; if (!rec.volatile) s.rec = rec;
    if (!s.info.title && m.title) { Object.assign(s.info, rpuClean({ title: m.title, artist: m.artist, version: m.version, creator: m.creator, setId: rpuId(m.setId), beatmapId: rpuId(m.beatmapId) })); rpuRefresh(s); }
  });
  if (rest.length) { toast(tr("{n} more replays were saved in Replays", { n: rest.length }), 3500); (async () => { for (const r of rest) await rpuPut(r.id, r.bytes, rpuMetaOf({ data: r.data, info: {} })); })(); }
  s.finding = (maps.length ? rpuUseMap(s, maps) : Promise.resolve(false)).then(ok => ok || rpuFind(s)).catch(() => {}).then(() => { s.found = true; rpuRefresh(s); });
}
// a kept replay (the Replays page): its results first
async function replayShowResults(rec, watch) { // (watch: the person pressed Watch on the list)
  if (!featGuard("replays")) return;
  try { await loadLazy("replay"); } catch (e) { toast(e.message, 4000); return; }
  let s = RPU.sess && RPU.sess.rec.id === rec.id && !RPU.sess.shared ? RPU.sess : null;
  if (!s) {
    let data; try { data = parseOsr(await rec.blob.arrayBuffer()); } catch (e) { await rpuError(e); return; }
    rpuPatch(rec.id, {}); // (used now)
    s = rpuNewSession(data, { rec }); s.watched = !!watch;
    s.finding = (s.info.title ? Promise.resolve(true) : rpuFind(s)).catch(() => {}).then(() => { s.found = true; rpuRefresh(s); });
  } else if (watch) s.watched = true;
  rpuShowRes(s);
}
async function replayWatch(rec) { await replayShowResults(rec, true); if (RPU.sess && RPU.sess.rec.id === rec.id) return rpuWatch(RPU.sess); }
function rpuNewSession(data, o) {
  const old = RPU.sess; if (old && old.bgURL) URL.revokeObjectURL(old.bgURL);
  const m = (o.rec && o.rec.meta) || {}; // (what is known from the copy kept: a replay opened again needs no lookup)
  return RPU.sess = { data, rec: o.rec, info: { setId: rpuId(m.setId), beatmapId: rpuId(m.beatmapId), title: m.title || "", artist: m.artist || "", version: m.version || "", creator: m.creator || "" }, local: null, loaded: null, finding: null, found: false, bgURL: "", ctl: new AbortController() };
}
const replayPending = () => !!(RPU.res && RPU.sess); // (js/app.js: a map dropped now goes to the replay waiting for it)

// ---------- finding the beatmap: what was found before, our server, osu.direct, catboy, nerinyan ----------
async function rpuJSON(url, sig, ms = 6000) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms), stop = () => ctl.abort();
  sig && sig.addEventListener("abort", stop);
  try { const r = await fetch(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(tm); sig && sig.removeEventListener("abort", stop); }
}
const RPU_LOOKUPS = ["https://osu.direct/api/v2", "https://catboy.best/api/v2", "https://api.nerinyan.moe/v2"]; // (md5 and set lookups after our server, in order; sayobot has none)
async function rpuFind(s) {
  const md5 = s.data.mapMd5; if (!rpuHex32(md5)) return false;
  const i = s.info, known = rpuMapGet(md5);
  if (i.title && rpuId(i.setId)) return true; // (the copy kept already says)
  if (known) { i.setId = i.setId || known.setId; i.beatmapId = i.beatmapId || known.beatmapId; if (i.title) return true; } // (1) found before
  const take = (bid, sid, ver, title, artist, creator, check) => { // (a lookup answer: only for this very map)
    if (check && String(check).toLowerCase() !== md5) return false;
    if (!rpuId(bid) || !rpuId(sid)) return false;
    Object.assign(i, rpuClean({ beatmapId: rpuId(bid), setId: rpuId(sid), version: String(ver || "").slice(0, 200), title: String(title || "").slice(0, 300), artist: String(artist || "").slice(0, 300), creator: String(creator || "").slice(0, 100) }));
    return true;
  };
  let ok = false;
  if (!(typeof osuApi !== "undefined" && osuApi.ok === false)) { // (2) our server (the official API, cached): 404, 503 or no server at all is fine
    const j = await rpuJSON("/api/v1/osu/lookup?checksum=" + md5, s.ctl.signal);
    if (j && !j.error) { ok = take(j.beatmap_id, j.beatmapset_id, j.version, j.title, j.artist, j.creator, j.checksum); if (ok) { s.current = true; const n = v => typeof v === "number" && isFinite(v) ? v : 0; s.facts = { stars: n(j.stars), length: n(j.length), status: String(j.status || "").slice(0, 20) }; } } // (osu! knows this very file: the replay is on the map's current version; the mirrors keep old hashes, so only this answer says so)
  }
  for (const host of ok ? [] : RPU_LOOKUPS) { // (3..) the mirrors in order, the first valid answer stops it (each asked once, no retries; a failing or slow one only costs its timeout)
    const j = await rpuJSON(host + "/md5/" + md5, s.ctl.signal);
    if (j && !j.error) { // (the md5 answer is flat or has the set inside: ids and the difficulty; the title, artist and mapper come from the set)
      const bs = j.beatmapset && typeof j.beatmapset === "object" ? j.beatmapset : null, sid = j.beatmapset_id || (bs && bs.id);
      const set = (bs && bs.title ? bs : null) || (rpuId(sid) ? await rpuJSON(host + "/s/" + sid, s.ctl.signal) : null) || bs || {};
      if (ok = take(j.id || j.beatmap_id, sid, j.version, set.title, set.artist, set.creator, j.checksum)) break;
    }
    if (s.ctl.signal.aborted) break;
  }
  if (!ok) return !!i.setId;
  rpuMapSet(md5, i.setId, i.beatmapId); rpuPatch(s.rec.id, rpuMetaOf(s));
  return true;
}

// ---------- a map given by hand (a .osz or .osu dropped with the replay, or while it waits) ----------
async function rpuUseMap(s, maps) {
  let entries = {}, zip = null;
  const osz = maps.find(f => fileIs(f, ["osz", "zip"]));
  try {
    if (osz) { zip = await (await loadJSZip()).loadAsync(osz); zip.forEach((p, f) => { if (!f.dir) entries[p] = f; }); }
    else for (const f of maps.filter(f => fileIs(f, ["osu"])).slice(0, 40)) entries[f.name] = blobEntry(f.name, f);
  } catch (e) { toast(/JSZip/.test(e.message) ? e.message : tr("Couldn't open the file, it may be broken")); return false; }
  const diffs = [];
  for (const p in entries) {
    if (!/\.osu$/i.test(p)) continue;
    let bytes; try { bytes = await entries[p].async("uint8array"); } catch { continue; }
    if (bytes.length > 32e6) continue;
    const meta = quickMeta(new TextDecoder().decode(bytes));
    if (meta.mode === "0") diffs.push({ p, md5: md5Hex(bytes), meta });
  }
  if (!diffs.length) { toast(tr("This package has no osu!standard difficulty"), 4000); return false; }
  diffs.sort((a, b) => a.meta.rank - b.meta.rank);
  let pick = diffs.find(d => d.md5 === s.data.mapMd5) || (s.info.beatmapId && diffs.find(d => +d.meta.bid === +s.info.beatmapId)) || (diffs.length === 1 ? diffs[0] : null);
  if (!pick) pick = await rpuPickDiff(diffs);
  if (!pick) return false;
  const m = pick.meta, i = s.info;
  Object.assign(i, rpuClean({ title: m.title, artist: m.artist, version: m.version, creator: m.creator, setId: +m.sid > 0 ? +m.sid : i.setId, beatmapId: +m.bid > 0 ? +m.bid : i.beatmapId }));
  s.loaded = null; s.mismatchOk = false; s.refetched = false; s.current = false; // (a map given by hand is the one to open, whatever was open for this replay before)
  s.local = { zip, entries, want: { bid: +m.bid > 0 ? m.bid : null, name: m.version, md5: s.data.mapMd5 } };
  if (s.bgURL) { URL.revokeObjectURL(s.bgURL); s.bgURL = ""; }
  const bg = m.bg && Object.keys(entries).find(p => norm(p) === norm(m.bg));
  if (bg) try { const b = await entries[bg].async("blob"); if (b && b.size) s.bgURL = URL.createObjectURL(b); } catch {}
  if (pick.md5 === s.data.mapMd5 && rpuId(i.setId)) rpuMapSet(s.data.mapMd5, i.setId, i.beatmapId);
  if (!s.shared) rpuPatch(s.rec.id, rpuMetaOf(s));
  return true;
}
function rpuPickDiff(diffs) {
  return modal({ title: tr("Which difficulty is this replay from?"), icon: "ask", dismiss: null,
    body: tr("None of the difficulties in this file matches the replay exactly. Pick the one it was played on."),
    buttons: [{ label: tr("Cancel"), value: null }, ...diffs.slice(-12).reverse().map(d => ({ label: d.meta.version, value: d, cls: "ghost" }))] });
}
// the replay's map is nowhere to be found: say so and wait for the .osz (dropping it, or choosing it here)
async function rpuAskMap(s) {
  RPU.ask = true;
  try {
    await modal({ title: tr("Beatmap not found"), icon: "info", dismiss: false,
      body: tr("This replay's beatmap couldn't be found automatically.\n\nDrop its .osz file on this page, or choose it here, and the replay will play with it."),
      buttons: [{ label: tr("Cancel"), value: false }, { label: tr("Choose the .osz file"), value: () => { $("file").click(); }, cls: "main" }] });
  } finally { RPU.ask = false; }
  return !!s.local;
}
const rpuCloseAsk = () => { if (RPU.ask) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); };

// ---------- opening the map and playing the replay ----------
const rpuLoaded = s => !UI.player.hidden && !!s.loaded && s.loaded.pack === osuFiles && s.loaded.file === osuFiles[curDiff] && !EDIT.on;
// a downloaded set has the replay's difficulty (an .osu with its MD5)
function rpuAccept(s) {
  return async zip => {
    const names = []; zip.forEach((p, f) => { if (!f.dir && /\.osu$/i.test(p)) names.push(f); });
    for (const f of names.slice(0, 60)) { try { if (md5Hex(await f.async("uint8array")) === s.data.mapMd5) return true; } catch {} }
    return false;
  };
}
async function rpuLoadMap(s) {
  const before = osuFiles, want = s.local ? s.local.want : { bid: s.info.beatmapId, name: s.info.version, md5: s.data.mapMd5 };
  if (!s.local && !s.info.setId && !(await rpuAskMap(s))) return false;
  if (typeof hideDetail === "function") hideDetail(); // (no detail panel: the difficulty is picked here, by MD5 first)
  if (s.local) await (s.local.zip ? openZip(s.local.zip, null, s.local.want, "preview") : openEntries(s.local.entries, null, s.local.want, "preview"));
  else await download(s.info.setId, want, "preview", rpuHex32(s.data.mapMd5) ? { accept: rpuAccept(s), out: s.dlOut = {} } : undefined); // (every mirror is tried until one has the replay's very file)
  if (UI.player.hidden || osuFiles === before || !map) return false; // (cancelled, declined, or it did not load)
  s.loaded = { pack: osuFiles, file: osuFiles[curDiff] };
  return true;
}
// the .osu bytes of the open difficulty against the replay's map MD5
async function rpuMd5(s) { try { const e = files[norm(osuFiles[curDiff].path)]; return e ? md5Hex(await e.async("uint8array")) : ""; } catch { return ""; } } // ("" when it can't be read)
async function rpuVerify(s) {
  if (!rpuHex32(s.data.mapMd5)) return true;
  const m = await rpuMd5(s); return !m || m === s.data.mapMd5;
}
// The open difficulty is not the one the replay was made on (its MD5 differs): what osu! says about the map's set (status, last update, ranked day)
// against the day the replay was played. The text says whether the map was changed after the replay, or the replay is older than the map's ranking.
const RPU_STATUS = { ranked: "Ranked", approved: "Approved", loved: "Loved", qualified: "Qualified", pending: "Pending", wip: "WIP", graveyard: "Graveyard" };
function rpuMismatchText(set, played, current) {
  const day = v => { const x = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  const key = set ? String(set.status || "").toLowerCase() : "", st = RPU_STATUS[key] ? tr(RPU_STATUS[key]) : "", upd = set ? day(set.last_updated) : 0, rk = set ? day(set.ranked_date) : 0, pl = day(played);
  let why;
  if (current) why = tr("osu! says this replay was made on the map's current version, so the copy that was downloaded is an older one (the download sites may not have the update yet), and the notes and the cursor may not line up.");
  else if (upd && pl && upd > pl) why = tr("The map was updated after this replay was played, so the notes and the cursor may not line up.");
  else if (st && rk && pl && rk > pl && ["ranked", "approved", "loved"].includes(key)) why = tr("This replay was played before the map became {status}, so it was probably made on an earlier version, and the notes and the cursor may not line up.", { status: st });
  else why = tr("This beatmap file isn't the one the replay was made on (it may be a local or unsubmitted version), so the notes and the cursor may not line up.");
  const L = [why, ""];
  if (st) L.push(tr("Status: {status}", { status: st }));
  if (upd) L.push(tr("Last updated: {date}", { date: fmtDate(upd) }));
  if (pl) L.push(tr("Replay played: {date}", { date: fmtDate(pl) }));
  if (!set) L.push(tr("Couldn't check the map's status on osu!"));
  if (current) L.push("", tr("You can download the current version from osu! (login needed) and drop the .osz on this page."));
  L.push("", tr("Watch it anyway?"));
  return L.join("\n");
}
// A kept copy of the set (an earlier download, js/app.js oszGet) may be an older version: the replay flow doesn't know when the map was updated, so
// it opened it as it was. It is dropped and the set downloaded again, once, and the replay's MD5 checked again: "exact", "mismatch" or "cancel"
async function rpuRefetch(s) {
  const sid = rpuId(s.info.setId);
  if (s.refetched || s.local || !sid || typeof oszGet !== "function" || (s.dlOut && s.dlOut.fallback) || !(await oszGet(sid))) return "mismatch"; // (nothing kept, or every mirror was tried already: nothing new to get)
  s.refetched = true; await oszDrop(sid); s.loaded = null;
  if (!(await rpuLoadMap(s))) return "cancel";
  return (await rpuVerify(s)) ? "exact" : "mismatch";
}
async function rpuMismatch(s) { // true: watch it anyway (asked once per replay and map)
  if (s.mismatchOk) return true;
  const sid = rpuId(s.info.setId) || (map && map.meta ? rpuId(map.meta.BeatmapSetID) : 0);
  showLoading(tr("Checking the beatmap…"), -1);
  let set = null;
  try { if (sid && typeof osuSet === "function") set = await Promise.race([osuSet(sid), new Promise(r => setTimeout(r, 5000, null))]); } catch {} // (no answer in 5 s: asked without it)
  hideLoading();
  const osu = !!s.current && sid && typeof osuDlURL === "function"; // (osu! says the replay is on the current version and no mirror had it: osu! itself has it)
  const ok = await modal({ title: tr("This beatmap doesn't match the replay"), icon: "warn", dismiss: false, body: rpuMismatchText(set, s.data.date, !!s.current),
    buttons: [{ label: tr("Cancel"), value: false }, ...(osu ? [{ label: tr("Download from osu!"), value: () => { try { open(osuDlURL(sid), "_blank", "noopener"); } catch {} return "osu"; } }] : []),
      { label: tr("Watch anyway"), value: true, cls: "main" }] });
  if (ok === "osu") { toast(tr("When the download finishes, drop the .osz on this page or press \"Open .osz file\""), 7000); return false; } // (a dropped map is the replay's: js/replayui.js replayOpenFiles)
  s.mismatchOk = ok === true; return s.mismatchOk;
}
// the replay's beatmap found and open (Watch and Analysis): waits for the lookups, then loads it (nothing is downloaded before one of these
// is pressed); the loading cover and its Cancel work as ever. False when it was cancelled, declined or did not load
async function rpuEnsureMap(s) {
  if (s.finding && !s.found) { // (the lookups are still running: wait, Cancel stops them)
    showLoading(tr("Finding the beatmap…"), -1); dlCtl = s.ctl; await s.finding; hideLoading();
    if (s.ctl.signal.aborted) { s.ctl = new AbortController(); return false; }
  }
  return rpuLoaded(s) || (await rpuLoadMap(s));
}
// the Analysis layer (js/replayanaui.js): over the results or the end menu, on this replay's own map
async function rpuAnalysis(s, btn) {
  if (RPU.busy || !featGuard("replays") || (typeof RPAN !== "undefined" && RPAN.el)) return;
  if (btn) btn.disabled = true;
  try { await Promise.all([loadLazy("replayana"), loadLazy("replayanaui")]); } catch (e) { toast(e.message, 4000); return; } finally { if (btn) btn.disabled = false; }
  if (RPU.sess === s && (RPU.res || RPU.end)) rpanOpen(s, btn);
}
async function rpuWatch(s) {
  if (RPU.busy || !featGuard("replays")) return; RPU.busy = true; s.watched = true;
  ensureAudioCtx(); // (inside the tap, before the waits below: Safari starts the sound output only from a tap)
  try {
    rpuCloseEnd();
    if (s.preLeave) { s.preLeave = false; R.leaving = false; }
    if (!(await rpuEnsureMap(s))) return;
    if (!(await rpuVerify(s))) { // (not the replay's version: a kept older copy is replaced first, then its status and last update are shown)
      const r = await rpuRefetch(s);
      if (r === "cancel" || (r === "mismatch" && !(await rpuMismatch(s)))) return;
    }
    rpuCloseRes();
    await rpuPlay(s);
  } finally { RPU.busy = false; }
}
function rpuEnded(s) { if (RPU.sess === s && RP.on) rpuShowRes(s); } // (the end of the replay is the results screen; the end card, rpuShowEnd, is no longer opened)
// every start of this replay (Watch, Replay on the end menu): the live Top 50 board is asked for here, once per start (never on a seek)
// The analysis of the replay (what its hits, slider follows and spinner turns were) is made BEFORE it plays, under the loading cover (rpHitsPrepare, js/player.js),
// so the first frame has it and no analysis hitches the start; already made for this replay and map (Replay on the end menu): started at once, no cover
function rpuPlay(s) {
  const mods = replayMods(s.data.mods, s.data.lazerInfo), go = () => { rpStart(s.data, { mods, mapKey: s.data.mapMd5, onEnd: () => rpuEnded(s), onCancel: () => rpuShowRes(s) }); if (RP.on) rpPrime(); t5Live(s); };
  if (typeof rpHitsPrepare !== "function" || !map || rpHitsReady(s.data)) { go(); return; }
  if (s.starting) return; s.starting = true;
  const m = map;
  showLoading(tr("Preparing the map…"), -1);
  return rpHitsPrepare(s.data, mods).catch(() => {}).then(() => { hideLoading(); s.starting = false; if (map === m && RPU.sess === s) go(); }); // (the map or the replay changed meanwhile: no start)
}
// out of the player and to a page: Home from the end menu, Back from the results over a played map
async function rpuLeave(toHome) {
  rpuCloseEnd(); rpuCloseRes();
  if (typeof rpStop === "function") rpStop();
  if (!UI.player.hidden) { await $("back").onclick(); if (!UI.player.hidden) return; }
  if (toHome) goView("home");
}
function replayClose() { RPO.seen = 0; rpuAnaClose(); rpuCloseEnd(); rpuCloseRes(); } // (js/app.js route(): another page)

// ---------- motion (keyframes in assets/app.css, "Replays motion"; JS only for the count-ups and the collapse) ----------
// The results screen plays its entrance on every show (not on a refresh); the class rpgo holds the keyframes, any key or click ends it at once
// (the base styles are the final state, so removing the class IS the end state). The real numbers are in the DOM from the first frame:
// the count-up is a visual copy (the ::after of the number, content from data-v, marked decorative) over transparent real text.
const rpuRM = () => RM || matchMedia("(prefers-reduced-motion:reduce)").matches;
const RPU_CU = (() => { try { return CSS.supports("content", '"x" / ""'); } catch { return false; } })(); // (no decorative-content syntax: the numbers just fade in)
const rpuEase = k => 1 - Math.pow(1 - k, 4);
const RPU_SEEN = new Set(); // (the pictures that have loaded once: drawn again later they are there at once, only the first load fades in)
function rpuFade(im, url) { if (!RPU_SEEN.has(url)) { im.classList.add("lz"); im.onload = () => { RPU_SEEN.add(url); im.classList.remove("lz"); }; } }
function rpuIntroEnd(skip) { // (skip: a key or a click: whatever still runs ends too; the timer and a close only drop the class, an animation that started late runs on)
  const t = RPU.intro; if (!t) return; RPU.intro = null;
  cancelAnimationFrame(t.raf); clearTimeout(t.tm); t.el.removeEventListener("click", t.skip, true);
  for (const c of t.cu) { c.b.classList.remove("rpcnt"); c.b.removeAttribute("data-v"); }
  t.el.classList.remove("rpgo"); const t5 = t.el.querySelector("#replayTop50"); if (t5) t5.style.animationDelay = "";
  if (skip) for (const a of t.el.getAnimations({ subtree: true })) { try { if (a.effect.getComputedTiming().iterations !== Infinity) a.finish(); } catch {} } // (e.g. the Top 50 panel; the skeleton sweeps run on)
}
function rpuIntro(el, cu) {
  const t = RPU.intro = { el, cu, raf: 0, tm: 0, skip: () => rpuIntroEnd(true) };
  for (const c of cu) { c.b.dataset.v = c.at(0); c.b.classList.add("rpcnt"); }
  el.addEventListener("click", t.skip, true); // (a click: the target is settled by then; a press on a moving button would miss it)
  t.tm = setTimeout(rpuIntroEnd, 1500); // (the longest keyframe ends at about 1.3 s)
  let t0 = 0;
  const step = now => {
    if (RPU.intro !== t) return;
    if (!t0) t0 = now;
    let live = 0;
    for (const c of cu) {
      if (c.done) continue;
      const k = (now - t0 - c.delay) / c.dur;
      if (k >= 1) { c.done = true; c.b.dataset.v = c.fin; continue; }
      live++; c.b.dataset.v = c.at(rpuEase(Math.max(0, k)));
    }
    if (live) t.raf = requestAnimationFrame(step);
  };
  t.raf = requestAnimationFrame(step);
}
// a row leaves the list: it fades, the ones after it move up (transform only), then the page is drawn again without it
function rpuCollapse(el) {
  if (!el || !el.isConnected || rpuRM() || !el.animate) return Promise.resolve();
  el.style.pointerEvents = "none";
  const list = el.parentNode, gap = parseFloat(getComputedStyle(list).rowGap) || 0, dy = el.offsetHeight + gap, box = [];
  if (list.children.length > 1) for (let x = el; x && x !== list.parentNode; x = x.parentNode) for (let n = x.nextElementSibling; n; n = n.nextElementSibling) box.push(n);
  const run = (e, kf, ms) => e.animate(kf, { duration: ms, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }).finished.catch(() => {});
  return Promise.all([run(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.97)" }], 180), ...box.map(n => run(n, [{ transform: "none" }, { transform: `translateY(${-dy}px)` }], 240))]);
}

// ---------- the results screen ----------
function rpuCover(s, kind) { const id = rpuId(s.info.setId); return id ? `https://assets.ppy.sh/beatmaps/${id}/covers/${kind}.jpg` : ""; }
const rpuAnaClose = () => { if (typeof RPAN !== "undefined" && RPAN.el) rpanClose(true); }; // (the Analysis layer goes with the screen under it)
function rpuShowRes(s, still) { // (still: drawn again in place, e.g. another language, no entrance)
  if (!still) rpuAnaClose();
  rpuCloseRes(); rpuCloseEnd(!still); RPB.rows = null; RPB.p = -1; // (the live board is not drawn behind the results, nor after the end; the next start asks for it again)
  RPU.sess = s; s.cardKey = null; s.swapT0 = 0; RPU.res = rpuBuildRes(s, still); document.body.append(RPU.res);
  if (RPU.res.cu) rpuIntro(RPU.res, RPU.res.cu);
  const w = RPU.res.querySelector(".rpwatch"); w && w.focus({ preventScroll: true });
}
function rpuCloseRes() { rpuIntroEnd(); if (RPU.res) { RPU.res.remove(); RPU.res = null; RPU.card = null; } }
// the map card fills in once the beatmap has been found (or not)
function rpuCardRefresh(s) { if (RPU.sess === s && RPU.res && RPU.card) RPU.card.replaceWith(RPU.card = rpuMapCard(s)); }
function rpuRefresh(s) {
  if (RPU.sess !== s || !RPU.res) return;
  const bg = RPU.res.querySelector(".rpbg"), c = s.bgURL || rpuCover(s, "cover");
  if (bg && c) { const was = bg.style.backgroundImage; bg.style.backgroundImage = `url("${c}")`; if (!was && !RPU.intro && !rpuRM() && bg.animate) bg.animate({ opacity: [.55, 1] }, { duration: 500, easing: "ease-out" }); } // (the cover arrives: it fades up)
  if (RPU.card) RPU.card.replaceWith(RPU.card = rpuMapCard(s));
  replayTop50(s, RPU.res.querySelector("#replayTop50")); // (the map may just have become known)
}
const rpuClock = ms => { const t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
// what the replay file says beyond the header's numbers: how long it ran, the presses of each key, and the health over time
function rpuReplayFacts(d) {
  const F = d.frames, out = { len: 0, keys: [0, 0, 0, 0], hp: null, hpMin: null };
  if (F && F.n) {
    out.len = F.t[F.n - 1] > 0 ? F.t[F.n - 1] : 0; let prev = 0;
    for (let i = 0; i < F.n; i++) { const k = F.k[i], s = (k & 4 ? 1 : 0) | (k & 8 ? 2 : 0) | (k & 5 && !(k & 4) ? 4 : 0) | (k & 10 && !(k & 8) ? 8 : 0), up = s & ~prev; if (up) for (let b = 0; b < 4; b++) if (up >> b & 1) out.keys[b]++; prev = s; }
  }
  const L = Array.isArray(d.lifeBar) ? d.lifeBar.filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) : [];
  if (L.length >= 3) { out.hp = L; out.hpMin = Math.max(0, Math.min(1, Math.min(...L.map(p => p[1])))); }
  return out;
}
function rpuHealthGraph(L) { // the health over time as a small area graph (one polyline, no library)
  const NS = "http://www.w3.org/2000/svg", tMax = Math.max(1, L[L.length - 1][0] - L[0][0]), t0 = L[0][0], W = 200, H = 40;
  const pts = L.map(p => `${((p[0] - t0) / tMax * W).toFixed(1)},${((1 - Math.max(0, Math.min(1, p[1]))) * (H - 2) + 1).toFixed(1)}`);
  const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", "rphp"); svg.setAttribute("aria-hidden", "true");
  const area = document.createElementNS(NS, "polygon"); area.setAttribute("points", `0,${H} ${pts.join(" ")} ${W},${H}`); area.setAttribute("class", "rphpa");
  const line = document.createElementNS(NS, "polyline"); line.setAttribute("points", pts.join(" ")); line.setAttribute("class", "rphpl"); line.setAttribute("fill", "none");
  svg.append(area, line); return svg;
}
function rpuDetails(s, st) {
  const d = s.data, f = rpuReplayFacts(d), box = h("div", "rpdet"), c = st.counts, tot = c.n300 + c.n100 + c.n50 + c.miss;
  const kv = (label, val, cls) => { const e = h("div", "rpkv" + (cls ? " " + cls : "")); e.append(h("small", null, label)); const v = h("div", "rpkvv"); v.append(val); e.append(v); return e; };
  const txt = x => document.createTextNode(String(x));
  box.append(h("h3", "rpdeth", tr("Details")));
  const g = h("div", "rpkvs");
  g.append(kv(tr("Player"), txt(d.player || "?")));
  const pv = h("span", "rpplayed"); pv.append(txt(d.date ? fmtDate(d.date) : "–")); if (d.date && typeof relTime === "function") pv.append(h("small", "rprel", relTime(d.date)));
  g.append(kv(tr("Played"), pv));
  const mv = h("span", "rpmv"); if (st.mods.list.length) mv.append(rpuChips(st.mods.list, st.mods.unsupported)); else mv.append(txt(tr("No mods")));
  if (st.mods.rate && st.mods.rate !== 1) mv.append(h("small", "rpmrate", st.mods.rate + "x"));
  g.append(kv(tr("Mods"), mv));
  g.append(kv(tr("Client"), txt((d.lazer ? tr("Lazer") : tr("Stable")) + (d.version ? " · " + d.version : ""))));
  if (d.perfect) g.append(kv(tr("Combo"), txt(d.maxCombo + "x · " + tr("Full combo"))));
  if (f.len > 0) g.append(kv(tr("Replay length"), txt(rpuClock(f.len))));
  const kt = f.keys.reduce((a, b) => a + b, 0);
  if (kt > 0) { const kk = h("span", "rpkeys"); ["K1", "K2", "M1", "M2"].forEach((n, i) => { if (f.keys[i] || i < 2) { const e = h("span", "rpkey"); e.append(h("i", null, n), txt(f.keys[i])); kk.append(e); } }); g.append(kv(tr("Key presses"), kk)); }
  if (d.onlineId > 0) { const a = h("a", "rplink2", tr("View on osu!")); a.href = "https://osu.ppy.sh/scores/osu/" + d.onlineId; a.target = "_blank"; a.rel = "noopener"; g.append(kv(tr("Score"), a)); }
  box.append(g);
  if (f.hp) {
    const hp = h("div", "rphpbox"); hp.append(h("small", null, tr("Health")), rpuHealthGraph(f.hp), h("span", "rphpmin", tr("Lowest health {n}%", { n: Math.round(f.hpMin * 100) })));
    box.append(hp);
  }
  return box;
}
function rpuMapCard(s) {
  const i = s.info, card = h("div", "rpmap");
  const key = i.title || i.artist ? "f" : !s.found ? "w" : i.beatmapId ? "i" : "n"; // (found / waiting / only an id / not found: a change of this fades the new text in, once)
  if (s.cardKey && s.cardKey !== key && !rpuRM()) s.swapT0 = performance.now(); // (the text fades in; a card drawn again within that time carries on from where it was, --sw)
  s.cardKey = key;
  const sw = s.swapT0 ? performance.now() - s.swapT0 : 1e9;
  if (sw < 600) { card.classList.add("swap"); card.style.setProperty("--sw", Math.round(sw) + "ms"); }
  const thumb = s.bgURL || rpuCover(s, "card");
  if (thumb) { const im = h("img", "rpthumb"); im.alt = ""; rpuFade(im, thumb); im.onerror = () => im.remove(); im.src = thumb; card.append(im); } // (fades in once loaded)
  else if (key === "w") { const sk = h("div", "rpthumb rpsk"); sk.setAttribute("aria-hidden", "true"); card.append(sk); }
  const tx = h("div", "rpmt");
  if (i.title || i.artist) {
    tx.append(h("b", "rptitle", i.title || "?"), h("span", "rpartist", i.artist || ""));
    tx.append(h("span", "rpdiff", `[${i.version || "?"}]` + (i.creator ? " · " + tr("mapped by {u}", { u: i.creator }) : "")));
  } else if (!s.found) { // (a shimmer where the artist and the difficulty will be)
    tx.append(h("b", "rptitle", tr("Finding the beatmap…")));
    for (let k = 0; k < 3; k++) { const b = h("span", "rpskb"); b.setAttribute("aria-hidden", "true"); tx.append(b); }
  } else if (i.beatmapId) tx.append(h("b", "rptitle", tr("Beatmap #{id}", { id: i.beatmapId })));
  else {
    tx.append(h("b", "rptitle", tr("Beatmap not found yet")), h("span", "rpartist", tr("Drop its .osz file on this page to watch the replay")));
    const pick = h("button", "btn ghost sm", tr("Choose the .osz file")); pick.type = "button"; pick.onclick = () => $("file").click(); tx.append(pick);
  }
  const fa = s.facts, ft = [];
  if (fa && fa.stars > 0) ft.push("★ " + fa.stars.toFixed(2));
  if (fa && RPU_STATUS[String(fa.status).toLowerCase()]) ft.push(tr(RPU_STATUS[String(fa.status).toLowerCase()]));
  if (fa && fa.length > 0) ft.push(rpuClock(fa.length * 1000));
  if (ft.length) { const r = h("div", "rpfacts"); for (const x of ft) r.append(h("span", null, x)); tx.append(r); }
  if (rpuId(i.setId) || rpuId(i.beatmapId)) tx.append(h("small", "rpids", tr("Set {s} · Beatmap {b}", { s: i.setId || "?", b: i.beatmapId || "?" })));
  card.append(tx);
  return card;
}
// the site's top bar over the results (this screen covers the page, so its own copy of the bar: logo and the pages, Replays lit; a link leaves as any other link does)
function rpuNav() {
  const src = $("topnav"), home = $("home"); if (!src || !home) return null;
  const hd = h("header", "top apptop rpnav"), br = home.cloneNode(true), nv = src.cloneNode(true); br.removeAttribute("id"); nv.removeAttribute("id");
  nv.querySelectorAll("a").forEach(a => { const on = a.dataset.go === "replays"; a.classList.toggle("on", on); on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); });
  hd.append(br, nv); return hd;
}
function rpuBuildRes(s, still) {
  const d = s.data, st = rpuStats(d), c = st.counts, el = h("div", "rpres");
  const go = !still && !rpuRM(), cu = []; // (go: the entrance plays; cu: the numbers that count up, in rpuIntro)
  const num = (b, fin, at, delay, dur) => { if (go && RPU_CU) cu.push({ b, fin, at, delay, dur }); return b; };
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", tr("Replay results"));
  const bg = h("div", "rpbg"), cov = s.bgURL || rpuCover(s, "cover"); if (cov) bg.style.backgroundImage = `url("${cov}")`;
  const inn = h("div", "rpin");
  const card = RPU.card = rpuMapCard(s), cw = h("div", "rpcw"); cw.append(card); // (cw stays when the card is drawn again: only it has the entrance)
  const tags = h("div", "rptags");
  tags.append(h("span", "rptag " + (d.lazer ? "lazer" : "stable"), d.lazer ? tr("Lazer") : tr("Stable")));
  if (d.perfect) tags.append(h("span", "rptag fc", tr("Full combo")));
  const main = h("div", "rpmain");
  const rk = rpuRankEl(st.rank);
  const right = h("div", "rpright");
  const scoreT = String(Math.round(st.score)).padStart(8, "0");
  const sc = h("div", "rpscorebox"); sc.append(h("small", null, tr("Score")), num(h("b", "rpscore", scoreT), scoreT, f => String(Math.round(st.score * f)).padStart(8, "0"), 260, 900));
  const row = h("div", "rpstrow");
  for (const [lab, val, at, dl] of [[tr("Accuracy"), (st.acc * 100).toFixed(2) + "%", f => (st.acc * 100 * f).toFixed(2) + "%", 400], [tr("Max combo"), d.maxCombo + "x", f => Math.round(d.maxCombo * f) + "x", 460]]) { const b = h("div", "rpstat"); b.append(h("small", null, lab), num(h("b", null, val), val, at, dl, 650)); row.append(b); }
  const js = h("div", "rpjs"), total = c.n300 + c.n100 + c.n50 + c.miss;
  let jk = 0;
  for (const [cls, lab, n, num_, sub] of [["j300", tr("Great"), c.n300, "300", c.geki ? tr("Geki {n}", { n: c.geki }) : ""], ["j100", tr("Ok"), c.n100, "100", c.katu ? tr("Katu {n}", { n: c.katu }) : ""], ["j50", tr("Meh"), c.n50, "50", ""], ["j0", tr("Miss"), c.miss, "0", ""]]) {
    const t = h("div", "rpj " + cls); t.append(h("small", null, lab + " · " + num_), num(h("b", null, String(n)), String(n), f => String(Math.round(n * f)), 500 + 60 * jk++, 450));
    if (sub) t.append(h("em", null, sub));
    if (total > 0) t.append(h("i", "rpjp", (n / total * 100).toFixed(n && n / total < .1 ? 2 : 1) + "%"));
    js.append(t);
  }
  const dist = h("div", "rpdist"); dist.setAttribute("aria-hidden", "true");
  if (total > 0) for (const [cls, n] of [["j300", c.n300], ["j100", c.n100], ["j50", c.n50], ["j0", c.miss]]) if (n > 0) { const sg = h("i", cls); sg.style.flexGrow = String(n); dist.append(sg); }
  right.append(sc, row, dist, js);
  main.append(rk, right);
  const top50 = h("div"); top50.id = "replayTop50"; top50.hidden = true; // (the top 50 scores of the map: replayTop50 shows it once the map is known)
  const btns = h("div", "rpbtns");
  const back = h("button", "btn ghost", "← " + tr("Back")); back.type = "button"; back.onclick = () => rpuLeave(false);
  const save = h("button", "btn ghost replaySaveOnline", tr("Save online")); save.type = "button"; save.hidden = true; // (shown by rpoApplyRes once the server has said this person can save online)
  save.onclick = () => { if (typeof replaySaveOnline === "function") replaySaveOnline(s.rec); };
  const watch = h("button", "btn main rpwatch", "▶ " + tr("Watch replay")); watch.type = "button"; watch.onclick = () => rpuWatch(s);
  const share = h("button", "btn ghost rpshare", tr("Share")), copy = h("button", "btn ghost rpcopy", tr("Copy link")), stop = h("button", "btn ghost rpstop", tr("Stop sharing")); // (shown by rpoApplyRes: Share while it isn't shared, Copy link and Stop sharing while it is)
  for (const b of [share, copy, stop]) { b.type = "button"; b.hidden = true; }
  share.onclick = () => replayShareRes(s); copy.onclick = () => replayShareRes(s, "copy"); stop.onclick = () => replayShareRes(s, "off");
  const saved = h("span", "rpsaved"), note = h("p", "rpnote", tr("Replays saved online are deleted automatically after 60 days.")); saved.hidden = note.hidden = true;
  const ana = h("button", "btn ghost rpanbtn", tr("Analysis")); ana.type = "button"; ana.onclick = () => rpuAnalysis(s, ana); // (shown first in the row (order:-1): it takes the free room on the left, so Back, Save and Watch stay where they were; Back stays the first child)
  btns.append(back);
  if (!UI.player.hidden) { const home = h("button", "btn ghost", tr("Home")); home.type = "button"; home.onclick = () => rpuLeave(true); btns.append(home); } // (a map is open behind: the results after a replay offer what the end card did, Home too; Replay is Watch replay)
  btns.append(ana, share, copy, stop, save, saved, watch);
  inn.append(cw, tags, main, rpuDetails(s, st), top50, note, h("p", "rpfoot", tr("Everything here is read from the replay file.")), btns); // (the buttons last: on a phone they are a bar stuck to the bottom)
  const nav = rpuNav(); el.append(...(nav ? [bg, nav, inn] : [bg, inn]));
  replayTop50(s, top50);
  if (go) { el.classList.add("rpgo"); if (!top50.hidden) top50.style.animationDelay = ".8s"; el.cu = cu; }
  rpoApplyRes(s, RPO.st, el); rpoLoad().then(st => { if (RPU.res === el) rpoApplyRes(s, st, el); }); // (the online part fills in when the answer is there)
  return el;
}
// ---------- the top 50 global scores of the replay's map (GET /api/v1/osu/scores?id=): on a click, or once when a replay starts, and every layer limits ----------
// Here: nothing is fetched before the button is pressed or a replay starts with the live board on (Settings → On screen, S.liveTop50); both go
// through t5Load: one request at a time (one in flight is shared); the answer is kept in sessionStorage for 10 minutes per beatmap (20 maps at
// most); after an error the button waits 10 s (a 429 waits what the server asks), and so does the next replay start; "scores_unavailable"
// (osu! refuses the list) hides the panel for the rest of the session. The server limits again (per IP, osu! budget, cache). Names and texts only via textContent.
const T5_KEY = "obv-top50", T5_OFF = "obv-top50-off", T5_TTL = 600000, T5_MAPS = 20, T5_WAIT = 10000;
const T5 = { busy: false, until: 0, off: false, bad: new Set(), uis: new Set(), p: null, pid: null };
try { T5.off = sessionStorage.getItem(T5_OFF) === "1"; } catch {}
function t5Store() {
  let o = null; try { o = JSON.parse(sessionStorage.getItem(T5_KEY) || "{}"); } catch {}
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  for (const k of Object.keys(o)) if (!o[k] || !Number.isFinite(o[k].t) || !Array.isArray(o[k].scores)) delete o[k];
  return o;
}
function t5Get(id) { const e = t5Store()[id], age = e ? Date.now() - e.t : -1; return age >= 0 && age < T5_TTL ? t5Clean(e.scores) : null; }
function t5Put(id, scores) {
  const o = t5Store(); delete o[id]; o[id] = { t: Date.now(), scores };
  const ids = Object.keys(o).sort((a, b) => o[a].t - o[b].t);
  while (ids.length > T5_MAPS || (ids.length && Date.now() - o[ids[0]].t >= T5_TTL)) delete o[ids.shift()]; // (the oldest go first)
  for (;;) { try { sessionStorage.setItem(T5_KEY, JSON.stringify(o)); return; } catch { if (ids.length < 2) return; delete o[ids.shift()]; } } // (storage full: drop the oldest and try again)
}
// whatever came (the server, or the storage that anyone can edit) is coerced here before it is drawn
function t5Clean(a) {
  const num = v => (Number.isFinite(+v) && v !== null && v !== "" ? +v : 0), out = [];
  for (const x of (Array.isArray(a) ? a : []).slice(0, 50)) {
    if (!x || typeof x !== "object") continue;
    const u = x.user && typeof x.user === "object" ? x.user : x, av = String(u.avatar || ""); // (x itself: a row kept by t5Put is already clean, its name at the top)
    out.push({ rank: Math.max(1, Math.round(num(x.rank)) || out.length + 1), name: String(u.name == null ? "" : u.name).slice(0, 32), country: /^[A-Za-z]{2}$/.test(u.country) ? u.country.toUpperCase() : "",
      avatar: /^https:\/\//i.test(av) && av.length <= 300 ? av : "", score: Math.max(0, Math.round(num(x.score))), acc: Math.min(1, Math.max(0, num(x.acc))), combo: Math.max(0, Math.round(num(x.combo))),
      mods: (Array.isArray(x.mods) ? x.mods : []).map(String).filter(m => /^[A-Za-z0-9]{1,3}$/.test(m)).slice(0, 10), pp: x.pp != null && Number.isFinite(+x.pp) ? +x.pp : null, date: String(x.date || "").slice(0, 40) });
  }
  return out;
}
const t5Locked = () => T5.busy || Date.now() < T5.until;
function t5Sync() { // (every button on the page follows the one request in flight and the wait after an error)
  for (const u of T5.uis) { if (!u.btn.isConnected) { T5.uis.delete(u); continue; } u.btn.disabled = t5Locked(); }
  clearTimeout(T5.tm); if (!T5.busy && Date.now() < T5.until) T5.tm = setTimeout(t5Sync, T5.until - Date.now() + 30);
}
function t5HideAll() { for (const e of document.querySelectorAll("#replayTop50")) e.hidden = true; }
const t5Id = s => s && s.data.mode === 0 ? rpuId(s.info.beatmapId) : null; // (osu!standard and a known difficulty only)
// the panel (hidden until the map is known); s = the session, el = #replayTop50
function replayTop50(s, el) {
  if (!el) return;
  const id = t5Id(s);
  if (!id || T5.off || T5.bad.has(id) || !featOn("replays")) { el.hidden = true; return; }
  el.hidden = false;
  if (el.dataset.map === String(id)) return;
  el.dataset.map = id; el.className = "t5"; el.replaceChildren();
  const btn = h("button", "btn ghost", tr("Show top 50 scores of this map")), ui = { btn, body: h("div", "t5body"), msg: h("p", "t5msg") };
  btn.type = "button"; ui.msg.hidden = true; ui.msg.setAttribute("role", "status");
  const bar = ui.bar = h("div", "t5bar"); bar.append(btn, h("p", "t5hint", tr("Loads when you press the button, or once when a replay starts if Live top 50 is on. Scores come from osu! and are kept for 10 minutes.")));
  el.append(h("h3", "t5h", tr("Top 50 scores")), bar, ui.msg, ui.body);
  btn.onclick = () => t5Click(id, s, ui);
  btn.disabled = t5Locked(); T5.uis.add(ui); queueMicrotask(t5Sync); // (the button shows a wait that is on now; the element is not on the page yet: t5Sync drops what is not, so it runs after the attach)
}
// the list of a map: from the cache, or the one request (a request in flight for it is shared). Resolves to { rows }, or { hide } (osu! refuses
// the list / the map is unknown: the flags are set), or { sec } (the wait after an error, already set: 0 when it is the usual 10 s), or
// { locked } (waiting after an error, or off: nothing was asked). The button's texts are t5Click's; the live board says nothing (t5Live)
function t5Load(id) {
  const hit = t5Get(id); // (kept for 10 minutes: no request)
  if (hit) return Promise.resolve({ rows: hit });
  if (T5.p) return T5.pid === id ? T5.p : Promise.resolve({ locked: true });
  if (Date.now() < T5.until || T5.off || T5.bad.has(id) || !featOn("replays")) return Promise.resolve({ locked: true });
  T5.busy = true; T5.pid = id; t5Sync();
  return T5.p = (async () => {
    let rows = null, fail = null;
    try { const r = await capi("GET", "osu/scores?id=" + id); if (r && Array.isArray(r.scores)) { rows = t5Clean(r.scores); t5Put(id, rows); } else fail = {}; }
    catch (e) { fail = e || {}; }
    T5.busy = false; T5.p = T5.pid = null;
    if (rows) { t5Sync(); return { rows }; }
    const c = fail.code, st = fail.status;
    if (c === "scores_unavailable" || c === "feature_disabled") { // (nothing to show for the rest of the session / page load)
      T5.off = true; if (c === "scores_unavailable") try { sessionStorage.setItem(T5_OFF, "1"); } catch {}
      t5Sync(); return { hide: true };
    }
    if (c === "bad_request" || c === "not_found" || st === 400 || st === 404) { T5.bad.add(id); t5Sync(); return { hide: true }; }
    let wait = T5_WAIT, sec = 0;
    if (c === "osu_busy" || c === "too_many_requests" || st === 429) { // (the server's Retry-After is not exposed by capi: the body may carry it, else a minute)
      const d = fail.detail || {}, ra = Math.ceil(+(d.retry_after || d.retryAfter) || 60); sec = Math.min(600, Math.max(T5_WAIT / 1000, ra));
      wait = sec * 1000;
    }
    T5.until = Date.now() + wait; t5Sync();
    return { sec };
  })();
}
async function t5Click(id, s, ui) {
  if (t5Locked() || T5.off || !featOn("replays")) return;
  const hit = t5Get(id); // (kept for 10 minutes: no request, no skeleton)
  if (hit) return t5Draw(s, ui, hit);
  ui.msg.hidden = true; t5Skeleton(ui);
  const r = await t5Load(id);
  if (r.rows) return t5Draw(s, ui, r.rows);
  ui.body.replaceChildren(); ui.body.removeAttribute("aria-busy");
  if (r.hide) return t5HideAll();
  ui.bar.hidden = false;
  ui.msg.textContent = r.sec ? tr("Too many requests right now. Try again in {s} seconds.", { s: r.sec }) : tr("Couldn't load the scores right now. Try again later.");
  ui.msg.hidden = false;
}
// the live board for this start of the replay (js/player.js drawRpBoard): nothing at all is asked when its switch (or the score display it sits
// with) is off, or the replay did not start; a failure shows nothing while the replay plays (the wait after it still holds for the button)
async function t5Live(s) {
  RPB.d = s.data; RPB.rows = null; RPB.p = -1;
  const id = t5Id(s);
  if (!RP.on || RP.data !== s.data || !id || !S.liveTop50 || !S.hud || T5.off || T5.bad.has(id) || !featOn("replays")) return;
  let r = null; try { r = await t5Load(id); } catch {}
  if (!r || !r.rows || !RP.on || RP.data !== s.data || RPB.d !== s.data) return; // (stopped or another replay meanwhile)
  const L = rpBoardList(r.rows, s.data, rpuStats(s.data).score);
  RPB.rows = L.rows; RPB.k = rpBoardK(s.data); RPB.p = -1; dirty = true;
}
function t5Skeleton(ui) {
  ui.bar.hidden = true;
  const box = h("div", "t5sks"); box.append(h("p", "t5ld", tr("Loading…")));
  for (let i = 0; i < 6; i++) { const sk = h("div", "t5sk"); sk.style.setProperty("--i", i); box.append(sk); }
  ui.body.replaceChildren(box); ui.body.setAttribute("aria-busy", "true");
}
function t5Draw(s, ui, rows) {
  ui.bar.hidden = true; ui.msg.hidden = true; ui.body.removeAttribute("aria-busy");
  if (!rows.length) { ui.body.replaceChildren(h("div", "t5empty", tr("No scores for this map yet."))); return; }
  const st = rpuStats(s.data), mine = rpBoardMine(s.data, st.score); // (probably this replay: same player and score, a lazer one on the converted scale; nothing else is guessed)
  const head = h("div", "t5hd"); head.setAttribute("aria-hidden", "true");
  for (const t of ["#", "", tr("Player"), tr("Score"), tr("Accuracy"), tr("Combo"), tr("Mods"), tr("pp"), tr("Date")]) head.append(h("span", null, t));
  const ol = h("ol", "t5list"); let mark = null;
  for (const r of rows) {
    const li = h("li", "t5i" + (ol.children.length < 12 && !rpuRM() ? " rpi" : "")), who = h("span", "t5who"), av = h("span", "t5av"), sub = h("span", "t5sub");
    if (r.avatar) { const im = h("img"); im.alt = ""; im.loading = "lazy"; im.referrerPolicy = "no-referrer"; im.src = r.avatar; im.onerror = () => im.remove(); av.append(im); }
    if (r.country && typeof flagEl === "function") who.append(flagEl(r.country, r.country), " ");
    const nm = h("span", "t5nm", r.name || "?"); nm.title = r.name; who.append(nm);
    const md = h("span", "t5md"); if (r.mods.length) md.append(rpuChips(r.mods));
    const dt = h("span", "t5dt", r.date ? (typeof relTime === "function" ? relTime(r.date) : fmtDate(r.date, false)) : ""); if (r.date) dt.title = fmtDate(r.date);
    sub.append(h("span", "t5ac", (r.acc * 100).toFixed(2) + "%"), h("span", "t5cb", r.combo + "x"), md, h("span", "t5pp", r.pp == null ? "–" : Math.round(r.pp) + "pp"), dt);
    li.append(h("span", "t5n", String(r.rank)), av, who, h("span", "t5sc", r.score.toLocaleString()), sub);
    if (!mark && mine(r)) { mark = li; li.classList.add("me"); li.setAttribute("aria-current", "true"); }
    li.style.setProperty("--i", ol.children.length); ol.append(li); // (the first 12 rows come in one after another)
  }
  ui.body.replaceChildren(head, ol, h("p", "t5foot", tr("Showing {n} scores. Updated at most every 10 minutes.", { n: rows.length })));
  if (mark) requestAnimationFrame(() => mark.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "auto" : "smooth" }));
}

// keys while the results or the end menu are up: Esc goes back, nothing reaches the player behind them
addEventListener("keydown", e => {
  if (!RPU.res && !RPU.end) return;
  if (RPU.intro) rpuIntroEnd(true); // (any key ends the entrance: the final state at once)
  if (typeof RPAN !== "undefined" && RPAN.el && !document.querySelector(".mdl") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.stopPropagation(); rpanKey(e); return; } // (the Analysis layer: its own Esc, arrows and Tab)
  if (document.querySelector(".mdl") || e.ctrlKey || e.metaKey || e.altKey || e.key === "Tab" || e.key === "Shift") return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (RPU.end) rpuShowRes(RPU.sess); else rpuLeave(false); return; }
  if (e.target && /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && (e.key === "Enter" || e.key === " ")) { e.stopPropagation(); return; }
  e.stopPropagation();
}, true);

// ---------- the end menu: Home / Replay / Results ----------
function rpuShowEnd(s) {
  rpuCloseEnd();
  const st = rpuStats(s.data), el = h("div", "rpend"), p = h("div", "rpendp");
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", tr("Replay finished"));
  const head = h("div", "rpendh"); head.append(rpuRankEl(st.rank, "rprk sm"), h("div", "rpendt"));
  head.lastChild.append(h("b", null, tr("Replay finished")), h("span", null, s.data.player || "?"));
  const home = h("button", "btn ghost", tr("Home")), again = h("button", "btn main", "↻ " + tr("Replay")), res = h("button", "btn ghost", tr("Results"));
  for (const b of [home, again, res]) b.type = "button";
  home.onclick = () => { rpuCloseEnd(true); rpuLeave(true); };
  again.onclick = () => { rpuCloseEnd(true); rpuPlay(s); };
  res.onclick = () => rpuShowRes(s);
  const row = h("div", "rpendbtns"); row.append(home, again, res);
  const ana = h("button", "btn ghost rpanbtn", tr("Analysis")); ana.type = "button"; ana.onclick = () => rpuAnalysis(s, ana);
  p.append(head, row, ana); el.append(p); document.body.append(el); RPU.end = el;
  if (!rpuRM() && home.animate) [home, again, res, ana].forEach((b, k) => b.animate({ opacity: [0, 1], transform: ["translateY(10px)", "none"] }, { duration: 300, delay: 200 + k * 60, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" })); // (WAAPI, not a CSS animation: a press would restart that one)
  again.focus({ preventScroll: true });
}
function rpuCloseEnd(soft) { // (soft: fades out in 160 ms; it cannot be reached meanwhile)
  const e = RPU.end; if (!e) return; RPU.end = null;
  if (!soft || rpuRM()) return e.remove();
  e.className = "rpendx"; e.inert = true; setTimeout(() => e.remove(), 170); // (another class: only the live menu matches .rpend)
}

// ---------- the Replays page ----------
async function renderReplays() {
  if (!featGuard("replays")) return;
  const box = $("replays"); if (!box) return;
  const tok = ++RPO.rtok, all = await replayCacheList(); if (R.view !== "replays" || tok !== RPO.rtok) return;
  let drawn = RPO.last; rpoDrawPage(box, all, drawn); // (what is known of the online side now, then what the server says)
  const st = await rpoLoad(Date.now() - RPO.at > 30000); if (R.view !== "replays" || tok !== RPO.rtok || st === drawn) return;
  if (st.ok) { try { await loadLazy("replay"); } catch {} if (R.view !== "replays" || tok !== RPO.rtok) return; } // (replayMods: the dimmed mod chips)
  rpoDrawPage(box, all, st);
}
function rpoDrawPage(box, all, st) {
  const on = !!(st && st.ok);
  // (motion: the cards come in with a stagger on the page's first draw; a later draw of the same visit, e.g. the online answer or a delete,
  // continues the clock instead of starting again: --sk is how long the visit has been on, the keyframes' delays subtract it)
  const now = performance.now(); if (!RPO.seen) { RPO.seen = now; box.style.removeProperty("--sk"); } else box.style.setProperty("--sk", Math.round(now - RPO.seen) + "ms");
  box.innerHTML = "";
  const head = h("div", "vhead"), back = h("a", "btn ghost sm", "← " + tr("Home")); back.href = "./"; back.dataset.go = "home";
  head.append(back, h("h2", null, tr("Replays")), h("p", null, tr("Kept on this device: {n} replays, {mb} MB (up to {max} / {maxmb} MB). You can delete them here or in Settings → General.", { n: all.length, mb: rpuSize(all).toFixed(1), max: RPU_COUNT, maxmb: RPU_MAX / 1048576 })));
  const dz = h("div", "rpdrop"), pick = h("button", "btn main sm", tr("Choose file")), clr = h("button", "btn ghost sm danger", tr("Delete all"));
  pick.type = clr.type = "button"; pick.onclick = () => $("file").click(); clr.disabled = !all.length; clr.onclick = () => rpuDeleteAll(all.length);
  dz.append(h("span", null, tr("Drop a .osr file here or choose one")), pick, clr);
  const lk = h("form", "rplink"), li = h("input", "skedit"), lb = h("button", "btn ghost sm", tr("Open score"));
  li.type = "url"; li.placeholder = tr("Paste an osu! score link"); li.autocomplete = "off"; li.spellcheck = false; li.setAttribute("aria-label", tr("Paste an osu! score link")); lb.type = "submit";
  lk.onsubmit = e => { e.preventDefault(); const v = li.value.trim(); if (v) rpuPasteScore(v); };
  lk.append(li, lb);
  const hint = h("p", "rphint", tr("To watch a replay from a pasted osu! score link, log in to osu! first: if this site can't fetch it for you, osu! opens in a new tab, you download the .osr there (osu! login needed) and drop it here."));
  box.append(head, dz, lk, hint);
  if (st && st.why === "login") box.append(h("p", "rpoff", tr("Log in with osu! to save replays online")));
  if (on) box.append(h("h3", "rpsech", tr("On this device")));
  if (!all.length) box.append(h("div", "empty", tr("No replays yet. Drop an .osr file on this page to watch it.")));
  else {
    const list = h("div", "plistbox");
    all.forEach((rec, k) => { const r = rpuRow(rec, on && rpoHex64(rec.id) && !rpoFind(rec.id) ? { save: true } : null); r.style.setProperty("--i", Math.min(k, 10)); list.append(r); });
    box.append(list);
  }
  if (!on) return;
  const lim = st.limits || {}, rs = st.replays;
  box.append(h("h3", "rpsech", tr("Saved online")), h("p", "rpsecn", tr("Saved online: {n} of {max}. Replays are deleted automatically 60 days after saving.", { n: rs.length, max: lim.per_user || 20 })));
  if (!rs.length) { box.append(h("div", "empty", tr("Nothing saved online yet. Open a replay and press Save online."))); return; }
  const list = h("div", "plistbox rponl");
  rs.forEach((r, k) => { const e = rpuRow({ id: r.id, size: r.size, meta: { ...r.meta, modsOff: typeof replayMods === "function" ? replayMods(+r.meta.mods || 0, null).unsupported : [] } }, { online: r }); e.style.setProperty("--i", Math.min(k, 10)); list.append(e); });
  box.append(list);
}
// o: { save: true } a local copy that can be saved online, { online: <the server's row> } a replay saved online
function rpuRow(rec, o) {
  const m = rec.meta || {}, el = h("article", "rprow" + (o && o.online ? " online" : "")), sid = rpuId(m.setId);
  const th = h("div", "rprthumb");
  if (sid) { const url = `https://assets.ppy.sh/beatmaps/${sid}/covers/card.jpg`, im = h("img"); im.alt = ""; im.loading = "lazy"; rpuFade(im, url); im.onerror = () => im.remove(); im.src = url; th.append(im); }
  const tx = h("div", "rprtx");
  tx.append(h("b", null, m.title ? (m.artist ? m.artist + " - " : "") + m.title : tr("Beatmap not identified yet")));
  tx.append(h("span", "rprsub", [m.version ? "[" + m.version + "]" : "", m.player || "?"].filter(Boolean).join(" · ")));
  const meta = h("div", "rprmeta");
  const off = (m.modsOff || []).filter(x => x !== "HD" && x !== "FL"); // (applied since: copies kept from before still list them as not applied)
  meta.append(rpuRankEl(m.rank || "D", "rprk xs"), h("span", null, ((m.acc || 0) * 100).toFixed(2) + "%"), rpuChips(m.modNames, off));
  tx.append(meta, h("small", "rprdate", [m.date ? fmtDate(m.date) : "", fmtBytes(rec.size), m.lazer ? tr("Lazer") : tr("Stable")].filter(Boolean).join(" · ")));
  if (o && o.online) { tx.append(rpoExpiryEl(o.online.expires_at)); if (o.online.share_key) tx.append(h("small", "rprshared", tr("Shared"))); }
  const acts = h("div", "rpracts"), w = h("button", "btn main sm", "▶ " + tr("Watch")), del = h("button", "btn ghost sm danger", tr("Delete"));
  w.type = del.type = "button";
  if (o && o.online) { w.onclick = () => rpoWatch(o.online, w); del.onclick = () => rpoDelete(o.online, el); }
  else {
    w.onclick = () => replayShowResults(rec);
    del.onclick = async () => { if (await rpuAsk(tr("Delete this replay from this device?"), { ok: tr("Delete"), danger: true })) { await rpuCollapse(el); await rpuDelete(rec.id); toast(tr("Replay deleted"), 1500); } };
  }
  acts.append(w);
  if (o && o.save) { const sv = h("button", "btn ghost sm", tr("Save online")); sv.type = "button"; sv.onclick = () => replaySaveOnline(rec); acts.append(sv); }
  if (o && o.online && featOn("replays")) { // (share it by link: Share while it isn't shared, Copy link and Stop sharing while it is)
    const r = o.online, ttl = rpoShareTitle(r.meta), mk = (txt, mode) => { const b = h("button", "btn ghost sm", txt); b.type = "button"; b.disabled = RPS.busy; b.onclick = () => rpoShareRow(r, mode, ttl); return b; };
    if (r.share_key) acts.append(mk(tr("Copy link"), "on"), mk(tr("Stop sharing"), "off")); else acts.append(mk(tr("Share"), "on"));
  }
  acts.append(del);
  el.append(th, tx, acts);
  return el;
}

// ---------- saved online: 60 days on the server (GET / POST / DELETE /api/v1/replays), for a logged-in osu! user ----------
const RPO_MAX = 1048576, RPO_DAYS = 60;
const RPS = { busy: false }; // (a Share / Copy link / Stop sharing request is running)
const RPO = { key: "", p: null, st: null, last: null, at: 0, rtok: 0, saving: false, opening: false, seen: 0, popNext: false };
const RPO_NO = { ok: false, why: "" }, RPO_LOGIN = { ok: false, why: "login" }; // (nothing to show / the quiet "log in" line on the Replays page)
const rpoHex64 = s => /^[0-9a-f]{64}$/.test(String(s || ""));
const rpoFind = sha => (RPO.st && RPO.st.ok && RPO.st.replays.find(r => r.sha256 === sha)) || null;
// who may save online: the server has its backend, a real login (not the local dev login), and GET replays says saving: true.
// One answer is kept per page load (and per login); force asks again. Any error means "no online part", never a broken page.
async function rpoLoad(force) { return RPO.last = await rpoLoad0(force); } // (last: what the Replays page drew)
async function rpoLoad0(force) {
  if (!featOn("replays")) return RPO_NO;
  try { if (typeof cloudMe === "function") await cloudMe(); if (!AUTH.checked) await authCheck(); } catch {}
  if (!(typeof cloudEnabled === "function" && cloudEnabled())) return RPO_NO;
  if (!AUTH.user) return RPO_LOGIN;
  if (AUTH.user.dev || !(self.crypto && crypto.subtle)) return RPO_NO;
  const key = String(AUTH.user.id);
  if (RPO.key !== key) { RPO.key = key; RPO.p = null; RPO.st = null; }
  if (force || !RPO.p) {
    const p = RPO.p = rpoFetch(); p.then(st => { if (RPO.p === p && !st.ok) RPO.p = null; }); // (a failed answer is asked again next time)
  }
  return RPO.p;
}
async function rpoFetch() {
  let j; try { j = await capi("GET", "replays"); } catch { return (RPO.st = null), RPO_NO; }
  RPO.at = Date.now();
  if (!j || j.saving !== true || !Array.isArray(j.replays)) return (RPO.st = null), RPO_NO;
  return RPO.st = { ok: true, replays: j.replays.filter(r => r && rpoHex64(r.sha256) && r.id), limits: j.limits || {} };
}
const rpoDaysLeft = ex => Math.max(0, Math.ceil((new Date(ex) - Date.now()) / 86400000));
function rpoExpiryEl(ex) {
  const n = rpoDaysLeft(ex), date = fmtDate(ex, false);
  return h("small", "rprexp" + (n <= 7 ? " soon" : ""), n <= 0 ? tr("Deleted on {date} (any moment now)", { date }) : n === 1 ? tr("Deleted on {date} (1 day left)", { date }) : tr("Deleted on {date} ({n} days left)", { date, n }));
}
// the results screen: Save online while it isn't online, "Saved online · deleted on …" when it is, and the one-line notice; nothing when the person can't save
function rpoApplyRes(s, st, el) {
  el = el || RPU.res; if (!el || RPU.sess !== s) return;
  const save = el.querySelector(".replaySaveOnline"), saved = el.querySelector(".rpsaved"), note = el.querySelector(".rpnote");
  const sh = [".rpshare", ".rpcopy", ".rpstop"].map(c => el.querySelector(c));
  if (s.osuScore) { for (const e of [save, saved, note, sh[1], sh[2]]) e.hidden = true; sh[0].hidden = false; sh[0].disabled = false; sh[0].classList.remove("busy"); return; } // (fetched from osu!: only Share, which is a link to that score on this site)
  if (s.shared) { for (const e of [save, saved, note, ...sh]) e.hidden = true; return; } // (someone else's shared replay: view only, nothing to save, share or delete)
  const on = !!(st && st.ok && rpoHex64(s.rec.id)), rec = on ? rpoFind(s.rec.id) : null, key = rec && RP_SHARE_KEY.test(rec.share_key || "");
  const busy = RPO.saving || RPS.busy, can = !!(st && (st.ok || st.why === "login")) && typeof replayShareRes === "function"; // (guests see Share too: it asks them to log in)
  sh[0].hidden = !can || !!key; sh[1].hidden = sh[2].hidden = !key;
  for (const b of sh) { b.disabled = busy; b.classList.toggle("busy", RPS.busy); }
  save.hidden = !on || !!rec || typeof replaySaveOnline !== "function"; save.disabled = RPO.saving; save.classList.toggle("busy", RPO.saving); note.hidden = !on;
  if (rec && saved.hidden && RPO.popNext && !rpuRM()) saved.classList.add("pop"); // (the "Saved online" line pops in when the save has just gone through)
  saved.hidden = !rec;
  if (rec) saved.textContent = tr("Saved online · deleted on {date}", { date: fmtDate(rec.expires_at, false) }) + (key ? " · " + tr("Shared") : "");
}
function rpoRefreshAll() {
  rpuRefreshViews();
  if (RPU.sess && RPU.res) rpoApplyRes(RPU.sess, RPO.st);
}
function rpoErr(e, save, share) { // (share: a share request or opening a link: some codes mean something else then)
  const d = (e && e.detail) || {}, code = e && e.code;
  if (code === "login_required") RPO.p = null;
  if (share) { const t = ({ not_configured: tr("Sharing isn't set up yet"), not_found: tr("This replay is no longer online") })[code]; if (t) return t; if (e.status === 429 || code === "too_many_requests") return tr("Too many requests right now. Try again soon."); }
  return ({
    no_access: tr("You don't have access to this part of the site."),
    login_required: tr("Log in with osu! to save replays online"),
    too_large: tr("This replay is bigger than 1 MB, so it can't be saved online"),
    replay_limit: tr("You already have {n} replays saved online. Delete one on the Replays page first.", { n: d.limit || (RPO.st && RPO.st.limits && RPO.st.limits.per_user) || 20 }),
    storage_full: tr("The server's storage for replays is full right now. Try again later."),
    feature_disabled: tr("This part of the site is switched off for now."),
    not_configured: tr("Saving replays online isn't set up on this site yet"),
    saving_disabled: tr("Online saving is paused by the site's admins right now. Your work stays on this device; try again later."),
    network: tr("Couldn't reach the server"),
    bad_request: tr("The server didn't accept this replay"),
    not_found: tr("This replay is no longer saved online"),
    suspended: tr("Your account can't save replays online right now"),
    account_deleted: tr("This account was deleted. Log in again to start a new one."),
  })[code] || (save ? tr("Couldn't save online ({err})", { err: code || (e && e.message) }) : tr("Something went wrong ({err})", { err: code || (e && e.message) }));
}
// bytes <-> base64 in chunks (a spread of a megabyte would overflow the stack)
function rpoB64(bytes) { const out = []; for (let i = 0; i < bytes.length; i += 24576) out.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 24576)))); return out.join(""); } // (24576 = a multiple of 3: no padding in the middle)
function rpoUnb64(t) { const bin = atob(t), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
// the score info that goes with the file: only what the server accepts (it drops the rest), in its types
function rpoMetaOf(rec) {
  let m = rec.meta || {};
  if (RPU.sess && RPU.sess.rec.id === rec.id) m = { ...m, ...rpuClean(rpuMetaOf(RPU.sess)) }; // (what the open results screen knows by now)
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : ""), int = (v, lo) => (typeof v === "number" && Number.isSafeInteger(v) && v >= lo ? v : null), o = {};
  const make = n => {
    o.mode = int(m.mode, 0) !== null && m.mode <= 3 ? m.mode : 0; o.player = str(m.player, 64);
    if (rpuHex32(m.mapMd5)) o.mapMd5 = m.mapMd5;
    o.title = str(m.title, n); o.artist = str(m.artist, n); o.version = str(m.version, n); o.creator = str(m.creator, n);
    o.setId = int(m.setId, 1); o.beatmapId = int(m.beatmapId, 1); o.score = int(Math.round(+m.score), 0) || 0; o.combo = int(m.combo, 0) || 0;
    o.acc = Number.isFinite(+m.acc) ? Math.min(1, Math.max(0, +m.acc)) : 0; o.rank = str(m.rank, 3); o.mods = int(m.mods, -2147483648) ?? 0;
    o.modNames = (Array.isArray(m.modNames) ? m.modNames : []).filter(x => typeof x === "string" && x.length <= 8).slice(0, 20);
    const c = m.counts || {}; o.counts = {}; for (const k of ["n300", "n100", "n50", "geki", "katu", "miss"]) o.counts[k] = int(c[k], 0) || 0;
    o.date = int(m.date, 0); o.lazer = !!m.lazer;
  };
  make(300); if (new TextEncoder().encode(JSON.stringify(o)).length > 3900) make(80); // (4096 bytes at most)
  return o;
}
// the Save online button (results screen, Replays page): confirm with the exact date, then POST. Gives the online row, or null when nothing was saved
// (share: it is the first step of Share: its own question, and no "Saved online" toast, the link is what the person gets)
async function replaySaveOnline(rec, share) {
  if (!featGuard("replays") || !rec || RPO.saving) return null;
  const st = await rpoLoad();
  if (!st.ok) { toast(st.why === "login" ? tr("Log in with osu! to save replays online") : tr("Saving replays online isn't set up on this site yet"), 3500); return null; }
  if (!rec.blob || rec.blob.size < 1 || rec.blob.size > RPO_MAX) { toast(tr("This replay is bigger than 1 MB, so it can't be saved online"), 5000); return null; }
  if (rpoFind(rec.id)) { rpoRefreshAll(); return rpoFind(rec.id); } // (already there)
  const max = (st.limits && st.limits.per_user) || 20;
  if (st.replays.length >= max) { toast(rpoErr({ code: "replay_limit", detail: { limit: max } }), 5000); return null; }
  const date = fmtDate(Date.now() + RPO_DAYS * 86400000, false);
  if (!(await rpuAsk(share ? tr("Sharing keeps this replay online for 60 days, until {date}, so others can watch it. Continue?", { date }) : tr("Save this replay online? It is kept for 60 days, until {date}, and then deleted automatically. You can delete it earlier on the Replays page.", { date }), share ? { title: tr("Share this replay?"), ok: tr("Share") } : { title: tr("Save online?"), ok: tr("Save") }))) return null;
  RPO.saving = true; rpoRefreshAll(); showLoading(tr("Saving online…"), -1);
  let done = null;
  try {
    const bytes = new Uint8Array(await rec.blob.arrayBuffer()), sha = await rpuSha(bytes);
    if (bytes.length > RPO_MAX) throw Object.assign(new Error("too_large"), { code: "too_large" });
    if (!rpoHex64(sha)) throw Object.assign(new Error("bad_request"), { code: "bad_request" });
    const j = await capi("POST", "replays", { sha256: sha, size: bytes.length, data_b64: rpoB64(bytes), meta: rpoMetaOf(rec) });
    RPO.popNext = true; await rpoLoad(true);
    hideLoading(); done = rpoFind(rec.id);
    if (!share) toast(tr("Saved online. It will be deleted on {date}.", { date: fmtDate(j.replay.expires_at, false) }), 6000); // (the server's date: a replay saved before keeps its old one)
  } catch (e) { hideLoading(); toast(rpoErr(e, true), 5000); }
  finally { hideLoading(); RPO.saving = false; rpoRefreshAll(); RPO.popNext = false; }
  return done;
}
// ---------- sharing a saved replay by link: ?replay=<id>&key=<key>, for logged-in members, view only (the server: replays/:id/share, replays/shared/:id) ----------
const rpoShareTitle = m => `${(m && m.title) || ""} ${tr("Replay")}`.trim();
// mode "on" (also what Copy link does: the same key comes back), "off" (the link stops working). Updates the row r; false when it failed (a toast says why)
async function rpoShareCall(r, mode) {
  try {
    const j = await capi("POST", `replays/${encodeURIComponent(r.id)}/share`, { mode });
    r.share_key = mode !== "off" && j && RP_SHARE_KEY.test(j.share_key || "") ? j.share_key : null;
    if (mode !== "off" && !r.share_key) throw Object.assign(new Error("bad_response"), { code: "bad_response" });
    return true;
  } catch (e) { toast(rpoErr(e, false, true), 5000); if (e.code === "not_found") { await rpoLoad(true); rpoRefreshAll(); } return false; }
}
// Share (on: upload if needed, then the link) / Copy link / Stop sharing for an online row r; title: what the link is called when it is handed on
async function rpoShareRow(r, mode, title) {
  if (RPS.busy) return false;
  try { await loadLazy("replay"); } catch (e) { toast(e.message, 4000); return false; }
  RPS.busy = true; rpoRefreshAll();
  try {
    if (mode === "off") {
      if (!(await rpuAsk(tr("Stop sharing? The link will stop working for everyone who has it."), { title: tr("Stop sharing"), ok: tr("Stop sharing"), danger: true }))) return false;
      if (!(await rpoShareCall(r, "off"))) return false;
      toast(tr("Sharing stopped"), 2500); return true;
    }
    if (!(await rpoShareCall(r, "on"))) return false;
    await shareLink(rpShareURL(location.origin + location.pathname, r.id, r.share_key), title);
    return true;
  } finally { RPS.busy = false; rpoRefreshAll(); }
}
// the results screen: one click does it all (a saved replay: the link; else one question, the upload, then the link); mode "copy" / "off" for a replay that is shared
async function replayShareRes(s, mode) {
  if (s && s.osuScore) return shareLink(location.origin + location.pathname + "?score=" + s.osuScore, rpoShareTitle(s.info)); // (nothing is stored for it: the link names the osu! score, and opening it gets the replay from osu! again)
  if (!featGuard("replays") || RPS.busy || RPO.saving || s.shared) return;
  const st = await rpoLoad();
  if (!st.ok) return toast(st.why === "login" ? tr("Log in with osu! to save replays online") : tr("Sharing isn't set up yet"), 3500);
  let r = rpoFind(s.rec.id);
  if (!r) { if (mode) return; r = await replaySaveOnline(s.rec, true); if (!r) return; }
  await rpoShareRow(r, mode === "off" ? "off" : "on", rpoShareTitle(s.info));
}
// Watch an online copy: download, check it is the file that was saved, then the same flow as a dropped file (it is kept on this device too)
async function rpoWatch(r, btn) {
  if (!featGuard("replays") || RPO.opening) return; RPO.opening = true; if (btn) btn.disabled = true;
  let bytes;
  try {
    showLoading(tr("Reading the replay…"), -1);
    const j = await capi("GET", "replays/" + encodeURIComponent(r.id));
    bytes = rpoUnb64(String(j.data_b64 || ""));
    if (bytes.length !== r.size || (await rpuSha(bytes)) !== r.sha256) throw Object.assign(new Error("bad_replay"), { code: "bad_replay" });
  } catch (e) { hideLoading(); RPO.opening = false; if (btn) btn.disabled = false; toast(e.code === "bad_replay" || e.name === "InvalidCharacterError" ? tr("This isn't a valid .osr replay file, it may be broken") : rpoErr(e), 5000); if (e.code === "not_found") { await rpoLoad(true); rpoRefreshAll(); } return; }
  hideLoading(); RPO.opening = false; if (btn) btn.disabled = false;
  const m = r.meta || {};
  await replayOpenFiles([new File([bytes], "online.osr")], { info: rpuClean({ title: m.title, artist: m.artist, version: m.version, creator: m.creator, setId: rpuId(m.setId), beatmapId: rpuId(m.beatmapId) }) });
}
// a link ?replay=<id>&key=<key> (js/app.js route(): members only, the address is cleaned there): the replay's file, then the results screen as for any
// dropped file, but view only: not saved on this device (no list entry, no cache), no Save online, Share or Delete. The map is fetched on Watch / Analysis only
async function replayOpenShared(id, key) {
  if (!featGuard("replays")) return;
  const bad = t => toast(t, 6000);
  try { await loadLazy("replay"); } catch (e) { return toast(e.message, 4000); }
  if (!rpShareOk(id, key)) return bad(tr("This link doesn't work any more (stopped by the owner, or expired)"));
  let bytes, info;
  showLoading(tr("Reading the replay…"), -1);
  try {
    const j = await capi("GET", `replays/shared/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`);
    bytes = rpoUnb64(String(j.data_b64 || ""));
    if (!j.replay || bytes.length !== j.replay.size) throw Object.assign(new Error("bad_replay"), { code: "bad_replay" });
    const m = j.replay.meta || {};
    info = rpuClean({ title: m.title, artist: m.artist, version: m.version, creator: m.creator, setId: rpuId(m.setId), beatmapId: rpuId(m.beatmapId) });
  } catch (e) {
    hideLoading();
    return bad(e.code === "not_found" ? tr("This link doesn't work any more (stopped by the owner, or expired)") : e.code === "bad_replay" || e.name === "InvalidCharacterError" ? tr("This isn't a valid .osr replay file, it may be broken") : rpoErr(e, false, true));
  }
  hideLoading();
  await replayOpenFiles([new File([bytes], "shared.osr")], { info, shared: true });
}
async function rpoDelete(r, row) {
  if (!(await rpuAsk(tr("Delete this replay from the server? A copy kept on this device is not deleted."), { ok: tr("Delete"), danger: true }))) return;
  try { await capi("DELETE", "replays/" + encodeURIComponent(r.id), {}); } catch (e) { if (e.code !== "not_found") return toast(rpoErr(e), 5000); }
  await rpuCollapse(row); toast(tr("Replay deleted"), 1500); await rpoLoad(true); rpoRefreshAll();
}
addEventListener("langchange", () => { if (RPU.res && RPU.sess) rpuShowRes(RPU.sess, true); });
