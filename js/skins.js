"use strict";
// The slider body border follows osu-framework's SmoothPath (MIT, Copyright (c) ppy Pty Ltd): see THIRD_PARTY_NOTICES.txt
const cv = $("cv"); let ctx = cv.getContext("2d"); // (let: a skin card's preview is drawn through the same blit() with ctx and SK swapped for a moment, drawSkinPreview)

const tintCanvas = (img, col) => {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; if (img.ow) { c.ow = img.ow; c.oh = img.oh; }
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0); g.globalCompositeOperation = "multiply"; g.fillStyle = rgb(col); g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "destination-in"; g.drawImage(img, 0, 0);
  return c;
};
function circleTex(size, draw) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"); g.translate(size / 2, size / 2); draw(g, size / 2); return c;
}
const ring = (g, r, lw, col) => { g.beginPath(); g.arc(0, 0, r, 0, 7); g.lineWidth = lw; g.strokeStyle = col; g.stroke(); };
const disc = (g, r, fill) => { g.beginPath(); g.arc(0, 0, r, 0, 7); g.fillStyle = fill; g.fill(); };

// ============ skins ============
// Built-in: osu! default + retro (ppy/osu-resources, CC BY-NC 4.0), served from /skins.
// Imported .osk files are kept in IndexedDB. Anything a skin lacks falls back to osu! default,
// and if even that can't load (offline) to a tiny drawn fallback.
const SKIN_FILES = {
  default: ["approachcircle@2x.png", "cursor@2x.png", "cursormiddle@2x.png", "cursortrail@2x.png", "default-0@2x.png", "default-1@2x.png", "default-2@2x.png", "default-3@2x.png", "default-4@2x.png", "default-5@2x.png", "default-6@2x.png", "default-7@2x.png", "default-8@2x.png", "default-9@2x.png", "followpoint@2x.png", "hit0@2x.png", "hit100@2x.png", "hit300@2x.png", "hit50@2x.png", "hitcircle@2x.png", "hitcircleoverlay@2x.webp", "hitcircleselect@2x.png", "lighting@2x.webp", "reversearrow@2x.png", "sliderb-nd@2x.png", "sliderb-spec@2x.png", "sliderb0@2x.png", "sliderb1@2x.png", "sliderb2@2x.png", "sliderb3@2x.png", "sliderb4@2x.png", "sliderb5@2x.png", "sliderb6@2x.png", "sliderb7@2x.png", "sliderb8@2x.png", "sliderb9@2x.png", "sliderfollowcircle@2x.webp", "sliderscorepoint@2x.png", "spinner-approachcircle@2x.webp", "spinner-bottom@2x.webp", "spinner-clear@2x.webp", "spinner-glow.webp", "spinner-middle2@2x.png", "spinner-middle@2x.webp", "spinner-spin@2x.webp", "spinner-top@2x.webp"],
  retro: ["approachcircle.png", "cursor.png", "cursortrail.png", "default-0.png", "default-1.png", "default-2.png", "default-3.png", "default-4.png", "default-5.png", "default-6.png", "default-7.png", "default-8.png", "default-9.png", "followpoint.png", "hit0.png", "hit100.png", "hit300.png", "hit50.png", "hitcircle.png", "hitcircleoverlay.png", "lighting.png", "reversearrow.png", "sliderb0.png", "sliderb1.png", "sliderb2.png", "sliderb3.png", "sliderb4.png", "sliderb5.png", "sliderb6.png", "sliderb7.png", "sliderb8.png", "sliderb9.png", "sliderfollowcircle.webp", "sliderpoint10.png", "spinner-approachcircle.png", "spinner-background.webp", "spinner-circle.webp", "spinner-clear.webp", "spinner-metre.png", "spinner-spin.png"],
};
const BUILTIN = {
  default: { name: "osu! default", ini: { General: { AllowSliderBallTint: "1" }, Fonts: { HitCircleOverlap: "-2" } } },
  retro: { name: "osu! retro (2008)", iniFile: "skin.ini", alias: { sliderscorepoint: "sliderpoint10" } },
};
// recommended for mapping (community skins are linked, not re-hosted)
const SKIN_RECS = [
  { name: "YUGEN [Legacy Edition]", url: "https://osu.ppy.sh/community/forums/topics/365036", note: "The original YUGEN many mappers and modders still use." },
];
const SKIN_MORE = [["osu! skins compendium", "https://compendium.skinship.xyz/"], ["osuskins.net", "https://osuskins.net/"]];

const ELEMS = ["hitcircle", "hitcircleoverlay", "approachcircle", "sliderstartcircle", "sliderstartcircleoverlay", "sliderendcircle", "sliderendcircleoverlay",
  "sliderfollowcircle", "sliderb-nd", "sliderb-spec", "reversearrow", "sliderscorepoint", "followpoint", "cursor", "cursortrail", "cursormiddle", "hitcircleselect",
  "lighting", "hit300", "hit100", "hit50", "hit0", "spinner-glow", "spinner-bottom", "spinner-top", "spinner-middle", "spinner-middle2", "spinner-background",
  "spinner-circle", "spinner-metre", "spinner-approachcircle", "spinner-spin", "spinner-clear",
  "hit100k", "hit300k", "hit300g", "cursor-ripple", "cursor-smoke", "inputoverlay-background", "inputoverlay-key", "sliderpoint10", "sliderpoint30", "particle50", "particle100", "particle300",
  "scorebar-bg", "scorebar-colour", "scorebar-marker", "scorebar-ki", "scorebar-kidanger", "scorebar-kidanger2"]; // (the last six: the HUD's health bar, player.js drawSkinHealth)
// the parts the import report checks (skinMissing): what a skin needs to look right in the osu!standard preview (the rest is optional or an alternative)
const CORE_ELEMS = ["hitcircle", "hitcircleoverlay", "approachcircle", "sliderfollowcircle", "reversearrow", "followpoint", "cursor", "cursortrail", "lighting", "hit300", "hit100", "hit50", "hit0"];
// animations (name-0, name-1 ...): a skin may have at most this many frames of one element; hit bursts play once at 60 fps whatever AnimationFramerate says (osu! wiki)
const ANIM_MAX = 120, ANIM_EL = { hit0: 60, hit50: 60, hit100: 60, hit100k: 60, hit300: 60, hit300g: 60, hit300k: 60 };
const HUD_GLYPHS = [..."0123456789", "comma", "dot", "percent", "x"];
const TINTED = { hitcircle: 1, approachcircle: 1, sliderstartcircle: 1, sliderendcircle: 1, lighting: 1, "spinner-glow": 1 };

// tiny IndexedDB wrapper for imported skins
// IndexedDB "obv": imported skins, unsaved drafts (js/drafts.js), downloaded maps (js/app.js, "osz") and watched replays (js/replayui.js, "replays")
// (another tab still running an older copy of the page holds the database open at the old version: it is asked to let go
// (onversionchange closes it), and a slow tab gets a few seconds before the upgrade is given up, not a hang)
let idbP = null;
function idbOpen() {
  return idbP || (idbP = new Promise((res, rej) => {
    let r, done = false, wait = 0; try { r = indexedDB.open("obv", 4); } catch (e) { idbP = null; return rej(e); }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("skins")) db.createObjectStore("skins", { keyPath: "id" });
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "key" });
      if (!db.objectStoreNames.contains("osz")) db.createObjectStore("osz", { keyPath: "id" });
      if (!db.objectStoreNames.contains("replays")) db.createObjectStore("replays", { keyPath: "id" });
    };
    r.onsuccess = () => {
      const db = r.result; clearTimeout(wait);
      if (done) { db.close(); return; } // (given up while it was blocked: nobody wants this connection any more)
      db.onversionchange = () => { db.close(); idbP = null; }; res(db);
    };
    r.onerror = () => { clearTimeout(wait); idbP = null; done = true; rej(r.error); };
    r.onblocked = () => { clearTimeout(wait); wait = setTimeout(() => { done = true; idbP = null; rej(new Error("storage blocked by another tab")); }, 4000); };
  }));
}
async function idbTx(store, mode, fn) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), rq = fn(t.objectStore(store));
    t.oncomplete = () => { res(rq && rq.result); if (store === "osz" && mode === "readwrite" && typeof oszIndexSoon === "function") oszIndexSoon(); }; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("aborted"));
  });
}
const idb = { all: () => idbTx("skins", "readonly", s => s.getAll()), put: v => idbTx("skins", "readwrite", s => s.put(v)), del: id => idbTx("skins", "readwrite", s => s.delete(id)) };

function parseIni(text) {
  const o = {}; let sec = "General";
  for (const raw of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const l = raw.replace(/\/\/.*$/, "").trim(); if (!l) continue;
    const h = l.match(/^\[(.+)\]$/); if (h) { sec = h[1]; continue; }
    const i = l.indexOf(":"); if (i < 0) continue;
    (o[sec] = o[sec] || {})[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return o;
}
// a value of the parsed ini; the section and key are matched without regard to case (skins in the wild have [general] and animationframerate)
function iniGet(ini, sec, key) {
  const a = sec.toLowerCase(), b = key.toLowerCase();
  if (ini[sec] && key in ini[sec]) return ini[sec][key];
  for (const s in ini) if (s.toLowerCase() === a) for (const k in ini[s]) if (k.toLowerCase() === b) return ini[s][k];
  return undefined;
}
// "r,g,b" -> [r,g,b] (0..255) or null when it isn't a colour
function iniColour(v) {
  if (v == null) return null;
  const c = String(v).split(",").slice(0, 3).map(x => parseFloat(x));
  return c.length === 3 && c.every(isFinite) ? c.map(x => Math.max(0, Math.min(255, Math.round(x)))) : null;
}
// index of image files: "folder/name" (lowercase, no extension, no @2x) -> { get: () => Promise<Blob>, hd }
function indexFiles(list) {
  const idx = {};
  for (const f of list) {
    const m = f.path.toLowerCase().replace(/\\/g, "/").match(/^(.*?)(@2x)?\.(png|jpe?g|webp)$/); if (!m) continue;
    const key = m[1], hd = m[2] ? 2 : 1, prev = idx[key];
    if (!prev || hd > prev.hd || (hd === prev.hd && f.depth < prev.depth)) idx[key] = { get: f.get, hd, depth: f.depth };
    const base = key.split("/").pop();
    if (base !== key && (!idx[base] || idx[base].depth > f.depth)) idx[base] = idx[key]; // also reachable by bare name
  }
  return idx;
}
// ---- hitsounds of a skin (Settings → Skin → "Use the skin's hitsounds"; played by js/audio.js sampleFor) ----
// Only the sounds the site plays: {normal|soft|drum}-{hitnormal|hitwhistle|hitfinish|hitclap|slidertick}[N].wav|ogg|mp3, N = a custom
// index 2+ (no number: index 0 / 1), and the skin's combo-break sound (combobreak.wav|ogg|mp3, played by a watched replay's combo break: audio.js
// comboBreakBuf). Slider slides and spinner sounds are never played here, so they aren't kept.
// Kept as the file's bytes (a Blob), decoded only when first played (audio.js skinSndWarm). Limits: 2 MB a file, 12 MB and 80 files a skin.
const SKIN_SND_RE = /^(normal|soft|drum)-(hitnormal|hitwhistle|hitfinish|hitclap|slidertick)([1-9]\d*)?$/;
const SKIN_SND_NAMED = /^combobreak$/; // (a single named sample, not part of the set / type / index grid)
const SKIN_SND_EXT = { wav: 0, ogg: 1, mp3: 2 }; // (the same name in two formats: this order, after the shallowest folder)
const SKIN_SND_MAX = 2 * 2 ** 20, SKIN_SND_TOTAL = 12 * 2 ** 20, SKIN_SND_COUNT = 80;
// index of sound files: name ("soft-hitclap2", lowercase, no extension) -> { get, size, depth, ext }. Found in any folder (shallowest wins).
function indexSounds(list) {
  const idx = {};
  for (const f of list) {
    const m = f.path.toLowerCase().replace(/\\/g, "/").match(/(?:^|\/)([^/]+)\.(wav|ogg|mp3)$/); if (!m) continue;
    const s = SKIN_SND_NAMED.test(m[1]) ? [m[1]] : m[1].match(SKIN_SND_RE); if (!s || s[3] === "1") continue; // (index 1 is the file without a number: "-hitnormal1" is never asked for)
    const prev = idx[m[1]], ext = SKIN_SND_EXT[m[2]];
    if (!prev || f.depth < prev.depth || (f.depth === prev.depth && ext < prev.ext)) idx[m[1]] = { get: f.get, size: f.size, depth: f.depth, ext };
  }
  return idx;
}
// the order sounds are kept in when a skin has more than the limits: the plain ones first (index 0 / 1), then custom index 2, 3 ...
const SND_TYPES = ["hitnormal", "hitwhistle", "hitfinish", "hitclap", "slidertick"], SND_SETS = ["normal", "soft", "drum"];
function soundOrder(names) {
  const rank = n => { const m = n.match(SKIN_SND_RE); if (!m) return 50; /* (combobreak: after the plain hitsounds, before custom indexes) */ return (m[3] ? +m[3] : 0) * 100 + SND_SETS.indexOf(m[1]) * 10 + SND_TYPES.indexOf(m[2]); };
  return names.slice().sort((a, b) => rank(a) - rank(b));
}
// reads the kept sounds' bytes (not decoded): { sounds: name -> Blob, n, bytes, skipped } (skipped: over a limit, or unreadable)
async function readSkinSounds(sidx) {
  const out = { sounds: {}, n: 0, bytes: 0, skipped: 0 };
  for (const name of soundOrder(Object.keys(sidx))) {
    const e = sidx[name];
    if (out.n >= SKIN_SND_COUNT || (e.size || 0) > SKIN_SND_MAX || out.bytes + (e.size || 0) > SKIN_SND_TOTAL) { out.skipped++; continue; }
    let b = null; try { b = await e.get(); } catch {}
    if (!b || typeof b.size !== "number" || b.size > SKIN_SND_MAX || out.bytes + b.size > SKIN_SND_TOTAL) { out.skipped++; continue; } // (the real size: a zip's own may be missing)
    out.sounds[name] = b; out.n++; out.bytes += b.size;
  }
  return out;
}
async function buildSkin(id, name, idx, ini, alias = {}, sidx = null) {
  const gi = k => iniGet(ini, "General", k), ci = k => iniGet(ini, "Colours", k), fi = k => iniGet(ini, "Fonts", k);
  const on = (v, def) => v == null || v === "" ? def : def ? v !== "0" : v === "1"; // (skin.ini switches: 1 / 0, a missing one keeps osu!'s default)
  const sk = { id, name, tex: {}, anim: {}, frames: {}, numbers: null, ini };
  const load = async key => {
    const e = idx[key] || (alias[key] && idx[alias[key]]); if (!e) return null;
    try { return { img: await createImageBitmap(await e.get()), hd: e.hd }; } catch { return null; }
  };
  const jobs = ELEMS.map(async k => {
    let n = 0; while (n < ANIM_MAX && idx[k + "-" + n]) n++;
    const [one, fr] = await Promise.all([load(k), Promise.all(Array.from({ length: n }, (_, i) => load(k + "-" + i)))]);
    const frames = fr.filter(Boolean), r = one || frames[0];
    if (r) sk.tex[k] = r; // (the plain image, else the first frame: texOf)
    if (frames.length) sk.anim[k] = frames; // (name-0, name-1 ...: texFrames)
  });
  jobs.push((async () => {
    const fr = []; for (let i = 0; i < 60; i++) { if (!idx["sliderb" + i]) break; fr.push(load("sliderb" + i)); }
    let arr = (await Promise.all(fr)).filter(Boolean);
    if (!arr.length) { const one = await load("sliderb"); if (one) arr = [one]; }
    if (arr.length) sk.frames.sliderb = arr;
  })());
  const prefix = String(fi("HitCirclePrefix") || "default").replace(/\\/g, "/").toLowerCase();
  jobs.push((async () => {
    const nums = await Promise.all([...Array(10).keys()].map(d => load(`${prefix}-${d}`)));
    if (nums.every(Boolean)) { sk.numbers = nums.map(n => n.img); sk.numHd = nums[0].hd; }
  })());
  // the HUD's number fonts (ScorePrefix / ComboPrefix, both "score" by default; a glyph a skin leaves out, or draws 1 px wide to hide it, is none): { g: { "0".."9", comma, dot, percent, x: { img, hd } }, overlap }
  // or null when a digit is missing (that part of the HUD stays text)
  const fontPrefix = k => String(fi(k) || "score").replace(/\\/g, "/").toLowerCase();
  const loadFont = async (k, ov) => {
    const prefix = fontPrefix(k), g = {};
    await Promise.all(HUD_GLYPHS.map(async c => { const r = await load(`${prefix}-${c}`); if (r && r.img.width > 1 && r.img.height > 1) g[c] = r; }));
    return "0123456789".split("").every(d => g[d]) ? { g, overlap: +(fi(ov) ?? 0) || 0, prefix } : null;
  };
  jobs.push((async () => {
    const score = await loadFont("ScorePrefix", "ScoreOverlap"), cp = fontPrefix("ComboPrefix");
    const combo = score && cp === score.prefix ? { g: score.g, overlap: +(fi("ComboOverlap") ?? 0) || 0, prefix: cp } : await loadFont("ComboPrefix", "ComboOverlap");
    sk.fonts = { score, combo };
  })());
  // hitsounds: bytes only (sbuf: what audio.js decodes from them, on first use)
  const snd = sidx && Object.keys(sidx).length ? await readSkinSounds(sidx) : { sounds: {}, n: 0, bytes: 0, skipped: 0 };
  Object.assign(sk, { sounds: snd.sounds, sndN: snd.n, sndBytes: snd.bytes, sndSkip: snd.skipped, sbuf: {}, sndP: null });
  await Promise.all(jobs);
  const combos = []; for (let i = 1; i <= 8; i++) { const c = iniColour(ci("Combo" + i)); if (c) combos.push(c); }
  const fps = parseInt(gi("AnimationFramerate"), 10);
  const parsed = {
    animFps: fps > 0 ? fps : -1, // (AnimationFramerate: frames per second, -1 = all frames in one second)
    ballFlip: on(gi("SliderBallFlip"), true), cursorTrailRotate: on(gi("CursorTrailRotate"), false),
    spinnerNoBlink: on(gi("SpinnerNoBlink"), false), spinnerFadePlayfield: on(gi("SpinnerFadePlayfield"), false), spinnerBackground: iniColour(ci("SpinnerBackground")),
    soundSet: SND_SETS.includes(String(gi("SampleSet") || "").trim().toLowerCase()) ? String(gi("SampleSet")).trim().toLowerCase() : "normal", // (not an osu! skin.ini key: read, but the map's sample set always decides)
  };
  Object.assign(sk, parsed, {
    meta: { name: String(gi("Name") || "").trim(), author: String(gi("Author") || "").trim(), version: String(gi("Version") || "").trim() },
    colors: combos.length ? combos : null, borderColor: iniColour(ci("SliderBorder")), trackColor: iniColour(ci("SliderTrackOverride")), ballColor: iniColour(ci("SliderBall")),
    tintBall: gi("AllowSliderBallTint") === "1", numOverlap: +(fi("HitCircleOverlap") ?? -2) || 0,
    overlayAbove: (gi("HitCircleOverlayAboveNumber") ?? gi("HitCircleOverlayAboveNumer") ?? "1") !== "0",
    cursorRotate: on(gi("CursorRotate"), true) && !!sk.tex.cursor, cursorCentre: on(gi("CursorCentre"), true), cursorExpand: on(gi("CursorExpand"), true),
  });
  sk.ini = Object.assign({}, ini, parsed); // (the parsed values next to the raw sections)
  sk.newSpinner = !!(sk.tex["spinner-top"] || sk.tex["spinner-bottom"]) || !(sk.tex["spinner-circle"] || sk.tex["spinner-background"]);
  sk.texFrames = n => skTexFrames(sk, n); sk.texFrame = (n, t, fps, once) => skTexFrame(sk, n, t, fps, once);
  return sk;
}
async function loadBuiltin(id) {
  const B = BUILTIN[id], base = `skins/${id}/`;
  const list = SKIN_FILES[id].map(f => ({ path: f, depth: 0, get: () => fetch(base + f).then(r => { if (!r.ok) throw 0; return r.blob(); }) }));
  let ini = B.ini || {};
  if (B.iniFile) { try { ini = parseIni(await (await fetch(base + B.iniFile)).text()); } catch {} }
  const sk = await buildSkin(id, B.name, indexFiles(list), ini, B.alias, indexSounds(list)); // (a .wav listed in SKIN_FILES is used, like a stored skin's)
  if (!Object.keys(sk.tex).length) throw new Error("offline");
  return sk;
}
// iniName: the skin.ini's Name wins over `name` (a skin just imported); a stored skin keeps the name it was given (it may have been renamed)
async function loadOskBlob(id, name, blob, iniName = true) {
  const zip = await (await loadJSZip()).loadAsync(blob), list = [];
  let iniEntry = null, iniDepth = 99;
  zip.forEach((p, e) => {
    if (e.dir) return;
    const n = p.replace(/\\/g, "/"), depth = n.split("/").length;
    if (/(^|\/)skin\.ini$/i.test(n) && depth < iniDepth) { iniEntry = e; iniDepth = depth; }
    list.push({ path: n, depth, get: () => e.async("blob"), size: e._data && e._data.uncompressedSize }); // (size: the zip's own, checked again once read)
  });
  // skins zipped inside a folder: strip that folder so "folder/hitcircle" is found as "hitcircle"
  const root = iniEntry ? iniEntry.name.replace(/\\/g, "/").replace(/skin\.ini$/i, "") : "";
  if (root) for (const f of list) if (f.path.startsWith(root)) { f.path = f.path.slice(root.length); f.depth -= root.split("/").length - 1; }
  const ini = iniEntry ? parseIni(await iniEntry.async("string")) : {};
  const sk = await buildSkin(id, name, indexFiles(list), ini, {}, indexSounds(list));
  if (iniName && sk.meta.name) sk.name = sk.meta.name;
  return sk;
}

// drawn fallback, only used when osu! default can't be fetched
function makeFallback() {
  const tex = {}, T2 = (k, size, draw) => tex[k] = { img: circleTex(size, draw), hd: 2 };
  T2("hitcircle", 256, (g, R) => { const gr = g.createRadialGradient(-R * .3, -R * .35, R * .05, 0, 0, R * .9); gr.addColorStop(0, "#fff"); gr.addColorStop(1, "#8d8d8d"); disc(g, R * .9, gr); });
  T2("hitcircleoverlay", 256, (g, R) => ring(g, R * .84, R * .11, "#fff"));
  T2("approachcircle", 256, (g, R) => ring(g, R * .88, R * .07, "#fff"));
  T2("sliderfollowcircle", 512, (g, R) => ring(g, R * .9, R * .035, "#fff"));
  T2("reversearrow", 256, (g, R) => { g.beginPath(); g.moveTo(-R * .32, -R * .42); g.lineTo(R * .22, 0); g.lineTo(-R * .32, R * .42); g.lineWidth = R * .16; g.lineCap = g.lineJoin = "round"; g.strokeStyle = "#fff"; g.stroke(); });
  T2("cursor", 128, (g, R) => { disc(g, R * .5, "#ffd84a"); ring(g, R * .5, R * .1, "#fff"); });
  T2("cursortrail", 64, (g, R) => disc(g, R * .5, "rgba(255,220,90,.8)"));
  T2("sliderscorepoint", 32, (g, R) => disc(g, R * .5, "#fff"));
  T2("followpoint", 64, (g, R) => { g.fillStyle = "#fff"; g.fillRect(-R * .5, -R * .12, R, R * .24); });
  T2("spinner-circle", 512, (g, R) => { ring(g, R * .94, R * .03, "#fff"); ring(g, R * .3, R * .02, "#fff"); });
  const ball = { img: circleTex(256, (g, R) => disc(g, R * .78, "#fff")), hd: 2 };
  const sk = { id: "fallback", name: "fallback", tex, anim: {}, frames: { sliderb: [ball] }, numbers: null, tintBall: true, numOverlap: -2, overlayAbove: true, newSpinner: false, ini: {},
    meta: { name: "", author: "", version: "" }, animFps: -1, ballFlip: true, cursorTrailRotate: false, cursorRotate: false, cursorCentre: true, cursorExpand: true,
    spinnerNoBlink: false, spinnerFadePlayfield: false, spinnerBackground: null, soundSet: "normal", sounds: {}, sndN: 0, sndBytes: 0, sndSkip: 0, sbuf: {}, sndP: null };
  sk.texFrames = n => skTexFrames(sk, n); sk.texFrame = (n, t, fps, once) => skTexFrame(sk, n, t, fps, once);
  return sk;
}
const FALLBACK = makeFallback();
let DEFSK = null, SK = FALLBACK;
const skinCache = {};
const SKIN_MAX_BYTES = 64 * 2 ** 20, SKIN_MAX_COUNT = 12; // (one .osk and how many are kept in this browser)
// skinWant: the skin being switched to right now (never released). skinGhost: text of the notice "that skin isn't on this device"
// (shown in the Skin pane until another one is picked). skinReport: the last import's "uses osu! default for" line
let skinWant = "", skinGhost = "", skinReport = "";
// a zip from a link into a Blob, with the loading cover's progress (Cancel: ctl, which is dlCtl). Throws an Error with .code: "http" / the proxy's own error code,
// "cut" (the download was cut off), "not_zip" (a page, not a skin), "too_big"; a TypeError (no answer, or the host blocks other sites: CORS) and an AbortError pass as they are
async function streamZip(url, ctl, label, expect, max) {
  const r = await fetch(url, { signal: ctl.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!r.ok || !r.body) { const j = await r.json().catch(() => null); throw Object.assign(new Error(j && j.error || "HTTP " + r.status), { code: j && j.error || "http" }); }
  const cl = +r.headers.get("content-length") || 0, total = cl || expect || 0, rd = r.body.getReader(), chunks = []; let got = 0, shown = 0;
  if (max && cl > max) { ctl.abort(); throw Object.assign(new Error("too_big"), { code: "too_big" }); }
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    chunks.push(value); got += value.length;
    if (max && got > max) { ctl.abort(); throw Object.assign(new Error("too_big"), { code: "too_big" }); }
    if (got - shown > 262144) { shown = got; showLoading(`${label} ${skinMB(got)}${total ? " / " + skinMB(total) : ""} MB`, total ? Math.min(1, got / total) : -1); }
  }
  if (cl ? got < cl : expect && got < expect * .9) throw Object.assign(new Error(tr("the download was cut off")), { code: "cut" });
  const blob = new Blob(chunks, { type: "application/zip" }), head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw Object.assign(new Error("not_zip"), { code: "not_zip" });
  return blob;
}
// Import from a link: a direct download link of an .osk / .zip (s-ul.eu, catbox, GitHub, Discord ...). The browser asks the host itself first; a host that blocks other sites
// (CORS) is asked through the site (worker.js /dl/skin, which only passes a zip through). The file then goes through importOsk as if it was picked.
const skinLinkErr = e => ({ not_zip: tr("This link isn't a direct download of an .osk file (it's a web page, or another kind of file). Use the file's own download link."),
  too_big: tr("This skin is too big ({size} MB). The limit is {max} MB.", { size: "64+", max: SKIN_MAX_BYTES / 2 ** 20 }), bad_url: tr("This link can't be used (it must be a public https link)."), bad_redirect: tr("This link can't be used (it must be a public https link)."),
  rate_limited: tr("Too many tries, wait a few minutes."), cut: tr("the download was cut off") })[e && e.code] || (e && e.message) || "";
async function importUrl(raw) {
  let u; try { u = new URL(String(raw || "").trim()); } catch { return toast(tr("That isn't a link"), 3000); }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") return toast(tr("This link can't be used (it must be a public https link)."), 4000);
  const ctl = dlCtl = new AbortController(), label = tr("Downloading skin…");
  let blob = null;
  try {
    showLoading(label, 0);
    try { blob = await streamZip(u.href, ctl, label, 0, SKIN_MAX_BYTES); }
    catch (e) { if (!(e instanceof TypeError)) throw e; blob = await streamZip("/dl/skin?u=" + encodeURIComponent(u.href), ctl, label, 0, SKIN_MAX_BYTES); } // (no answer / CORS: through the site)
  } catch (e) {
    hideLoading(); if (dlCtl === ctl) dlCtl = null;
    if (e && e.name === "AbortError") return; // (Cancel)
    const code = e && e.code === "not_a_zip" ? "not_zip" : e && e.code; return toast(tr("Couldn't load skin: {err}", { err: skinLinkErr({ code }) || tr("network error") }), 6000);
  }
  if (dlCtl === ctl) dlCtl = null;
  let seg = ""; try { seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || ""); } catch {}
  const name = (seg.replace(/\.(osk|zip)$/i, "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim() || u.hostname).slice(0, 60);
  await importOsk(new File([blob], name + ".osk", { type: "application/zip" })); // (the loading cover goes on there; the duplicate check and the skin count apply)
}
async function getSkin(id) {
  if (skinCache[id]) return skinCache[id];
  let p;
  if (BUILTIN[id]) p = loadBuiltin(id);
  else if (id.startsWith("osk:")) p = idb.all().then(list => { const r = list.find(x => "osk:" + x.id === id); if (!r) throw new Error("gone"); return loadOskBlob(id, r.name, r.blob, false); });
  else p = Promise.reject(new Error("unknown"));
  skinCache[id] = p; p.catch(() => delete skinCache[id]);
  return p;
}
// a skin that was picked (or came with the synced settings) but isn't stored in this browser: osu! default is selected, visibly, and the pane says so
function skinGone() { skinGhost = tr("This skin isn't on this device. Using osu! default."); S.skin = "default"; save(); toast(skinGhost, 4500); }
// make sure osu! default (the fallback) and the chosen skin are loaded
async function ensureSkins() {
  if (!DEFSK) { try { DEFSK = await getSkin("default"); } catch { DEFSK = FALLBACK; } }
  if (SK === FALLBACK || SK.id !== S.skin) {
    const want = S.skin;
    try { SK = await getSkin(want); }
    catch (e) { SK = DEFSK; if (/^osk:/.test(want) && e && e.message === "gone" && S.skin === want) skinGone(); } // (only a skin that is really gone: a busy database just keeps the choice)
    clearSkinCaches(); skinSndSoon();
  }
}
// the chosen skin's hitsounds start decoding (audio.js), once there is an audio output: no new one is made for it
const skinSndSoon = () => { if (typeof skinSndWarm === "function" && typeof actx !== "undefined" && actx) skinSndWarm(SK); };
function clearSkinCaches() { tintCache.clear(); numCache.clear(); fxCache.clear(); bodyCache.clear(); heavyClear(); dirty = true; }
// ---- memory: only the chosen skin and osu! default stay loaded ----
function closeSkin(sk) { // (frees the images of a skin nothing draws any more)
  if (!sk || sk === SK || sk === DEFSK || sk === FALLBACK) return;
  const close = t => { try { const i = t && t.img || t; if (i && i.close) i.close(); } catch {} };
  for (const k in sk.tex) close(sk.tex[k]);
  for (const k in sk.anim) sk.anim[k].forEach(close);
  (sk.frames.sliderb || []).forEach(close);
  (sk.numbers || []).forEach(close);
  for (const k of ["score", "combo"]) { const f = sk.fonts && sk.fonts[k]; if (f) for (const c in f.g) close(f.g[c]); } // (the HUD fonts are not in sk.tex)
  sk.sounds = {}; sk.sbuf = {}; sk.sndN = 0; sk.sndDead = true; // (its hitsounds' bytes and decoded sounds; a decode still running keeps nothing)
}
const dropTints = id => { for (const k of [...tintCache.keys()]) if (k.split("|").includes(id)) tintCache.delete(k); };
const pvHold = new Set(); // (skins a card preview is loading or drawing from: let go when it is done, not under it)
function releaseSkin(id) {
  if (id === "default" || id === S.skin || id === skinWant || id === SK.id || pvHold.has(id)) return;
  const p = skinCache[id]; if (!p) return; delete skinCache[id]; dropTints(id);
  p.then(sk => { if (sk !== SK && sk !== DEFSK) closeSkin(sk); }, () => {});
}
function releaseSkins() { for (const id of Object.keys(skinCache)) releaseSkin(id); }
async function selectSkin(id) {
  skinWant = id; skinGhost = "";
  showLoading(tr("Loading skin…"), -1);
  try { const sk = await getSkin(id); SK = sk; S.skin = id; save(); clearSkinCaches(); skinSndSoon(); }
  catch { toast(tr("Couldn't load this skin")); }
  skinWant = ""; releaseSkins();
  hideLoading(); renderSkinUI();
}
// SHA-256 of a file's bytes (hex), to tell a skin that is already imported. data: Blob / File / ArrayBuffer / typed array.
// (Without crypto.subtle, e.g. a page opened over plain http: two FNV-1a hashes, enough to tell skins apart.)
async function skinHash(data) {
  const tag = Object.prototype.toString.call(data);
  const buf = typeof data.arrayBuffer === "function" ? await data.arrayBuffer() : tag === "[object ArrayBuffer]" ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
  if (!buf) throw new Error("not bytes");
  if (typeof crypto !== "undefined" && crypto.subtle) return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join("");
  const u = new Uint8Array(buf); let a = 0x811c9dc5, b = 0x01000193 ^ 0xdeadbeef;
  for (let i = 0; i < u.length; i++) { a = Math.imul(a ^ u[i], 16777619); b = Math.imul(b ^ u[i], 0x85ebca6b) + i | 0; }
  return "f" + (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
// the stored skin with these bytes, if any (a skin stored before hashes existed is hashed now, but only when it has the same size)
async function skinDup(saved, hash, size) {
  for (const r of saved) {
    if (r.hash) { if (r.hash === hash) return r; continue; }
    if (!r.blob || r.blob.size !== size) continue;
    let x = ""; try { x = await skinHash(r.blob); } catch {}
    if (x) { r.hash = x; try { await idb.put(r); } catch {} }
    if (x === hash) return r;
  }
  return null;
}
const skinMB = n => (n / 2 ** 20).toFixed(n >= 1e7 ? 0 : 1);
// the parts a skin leaves out, for the import report: osu! default is used for those (the list stays short)
function skinMissing(sk) {
  const out = CORE_ELEMS.filter(k => !sk.tex[k]);
  if (!(sk.frames && sk.frames.sliderb && sk.frames.sliderb.length)) out.push("sliderb");
  if (!sk.numbers) out.push((iniGet(sk.ini || {}, "Fonts", "HitCirclePrefix") || "default") + "-0…9");
  if (!(sk.tex.sliderscorepoint || sk.tex.sliderpoint10 || sk.tex.sliderpoint30)) out.push("sliderscorepoint");
  if (!ELEMS.some(k => k.startsWith("spinner-") && sk.tex[k])) out.push("spinner");
  return out;
}
const skinMeta = sk => Object.assign({}, sk.meta, { sounds: sk.sndN || 0 }); // (kept with a stored skin, for its card: name, author, version, how many hitsounds)
const skinMissingText = sk => { const m = skinMissing(sk); return m.length ? m.slice(0, 6).join(", ") + (m.length > 6 ? " +" + (m.length - 6) : "") : ""; };
async function importOsk(file) {
  if (file.size > SKIN_MAX_BYTES) return toast(tr("This skin is too big ({size} MB). The limit is {max} MB.", { size: skinMB(file.size), max: SKIN_MAX_BYTES / 2 ** 20 }), 5000);
  showLoading(tr("Loading skin…"), -1);
  try {
    let saved = []; try { saved = await idb.all(); } catch {}
    const hash = await skinHash(file).catch(() => ""), dup = hash && await skinDup(saved, hash, file.size);
    if (dup) { hideLoading(); await selectSkin("osk:" + dup.id); toast(tr("Already imported: using \"{name}\"", { name: dup.name }), 4000); return; }
    if (saved.length >= SKIN_MAX_COUNT) { hideLoading(); return toast(tr("You can keep up to {n} skins on this device. Delete one first.", { n: SKIN_MAX_COUNT }), 5000); }
    const id = Date.now().toString(36), name = file.name.replace(/\.(osk|zip)$/i, "");
    const sk = await loadOskBlob("osk:" + id, name, file);
    if (!Object.keys(sk.tex).length && !sk.numbers && !sk.sndN) throw new Error(tr("No skin images found in this file")); // (a hitsound-only skin is fine)
    sk.name = sk.name.slice(0, 60) || name;
    try { await idb.put({ id, name: sk.name, blob: file, added: Date.now(), hash, size: file.size, meta: skinMeta(sk) }); } catch { toast(tr("Couldn't save the skin in this browser, it will be gone after reload")); }
    skinCache[sk.id] = Promise.resolve(sk); skinGhost = ""; SK = sk; S.skin = sk.id; save(); clearSkinCaches(); releaseSkins(); skinSndSoon();
    const sndOnly = !Object.keys(sk.tex).length && !sk.numbers, miss = sndOnly ? "" : skinMissingText(sk), skip = sk.sndSkip ? tr("Sound files left out (over the limits): {n}", { n: sk.sndSkip }) : "";
    skinReport = [miss ? tr("Uses osu! default for: {list}", { list: miss }) : "", skip].filter(Boolean).join(". ");
    toast((sndOnly ? tr('Using skin "{name}": its hitsounds, with the pictures of osu! default.', { name: sk.name }) : miss ? tr("Using skin \"{name}\". Uses osu! default for: {list}", { name: sk.name, list: miss }) : tr('Using skin "{name}". Missing parts use osu! default.', { name: sk.name })) + (skip ? (miss ? ". " : " ") + skip : ""), miss || skip ? 6000 : 3000);
  } catch (e) { toast(tr("Couldn't load skin: {err}", { err: e.message })); }
  hideLoading(); renderSkinUI();
}
async function renameSkin(id, name) {
  name = String(name || "").trim().slice(0, 60);
  if (!name || !id.startsWith("osk:")) return false;
  const r = (await idb.all()).find(x => "osk:" + x.id === id); if (!r) return false;
  r.name = name; await idb.put(r);
  const p = skinCache[id]; if (p) p.then(sk => { sk.name = name; }, () => {});
  return true;
}
async function exportSkin(id) {
  let r; try { r = (await idb.all()).find(x => "osk:" + x.id === id); } catch {}
  if (!r || !r.blob) return toast(tr("Couldn't export this skin"));
  downloadBlob(r.blob, (r.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim() || "skin") + ".osk");
}
async function deleteSkin(id) {
  if (!id.startsWith("osk:") || !(await ask(tr("Delete this skin from this browser?"), { ok: tr("Delete"), danger: true }))) return;
  try { await idb.del(id.slice(4)); } catch {}
  skinPv.delete(id);
  if (S.skin === id) return selectSkin("default");
  releaseSkin(id); renderSkinUI();
}

// ---------- skin cards in Settings → Skin ----------
// A card shows the skin drawn with its own images (a hit circle with its number and approach circle, a slider with ball and follow
// circle, the cursor and its trail, the spinner), through the same blit / T / drawNumber the player uses: for a moment
// SK and ctx are swapped for the card's skin and canvas (no await in between). Drawn once per skin, kept as a small canvas.
const skinPv = new Map();
function drawSkinPreview(cvs, sk) {
  const g = cvs.getContext("2d"), W = cvs.width, H = cvs.height, cy = H / 2, s = H / 240;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.clearRect(0, 0, W, H); // (transparent: the card's CSS has the dark backdrop, and a slider body is see-through)
  const oCtx = ctx, oSK = SK;
  ctx = g; SK = sk;
  try {
    const cols = sk.colors || DEFSK && DEFSK.colors || DEFAULT_SKIN_COLS, c1 = cols[0], c2 = cols[1 % cols.length], above = sk.overlayAbove !== false;
    const head = (num, x, col) => {
      blit(T("hitcircle", col), x, cy, s, 1);
      if (above) { drawNumber(num, x, cy, s, 1); blit(T("hitcircleoverlay"), x, cy, s, 1); } else { blit(T("hitcircleoverlay"), x, cy, s, 1); drawNumber(num, x, cy, s, 1); }
    };
    // hit circle + approach circle
    const x1 = W * .115; blit(T("approachcircle", c1), x1, cy, s * 1.7, .8); head(1, x1, c1);
    // slider: body, start circle, ball + follow circle
    const xa = W * .3, xb = W * .47, path = new Path2D(); path.moveTo(xa, cy); path.lineTo(xb, cy); path.lineTo(xb + .01, cy);
    { const rr = 64 * s * .95, bx0 = Math.floor(xa - rr - 2), by0 = Math.floor(cy - rr - 2), bc = document.createElement("canvas"); // (paintBody cuts into what's under it: a canvas of its own)
      bc.width = Math.ceil(xb - xa + 2 * rr + 6); bc.height = Math.ceil(2 * rr + 6); const bg = bc.getContext("2d"), bp = new Path2D(); bp.moveTo(xa - bx0, cy - by0); bp.lineTo(xb - bx0, cy - by0); bp.lineTo(xb - bx0 + .01, cy - by0);
      paintBody(bg, bp, rr, sliderColours(c2), 8); g.drawImage(bc, bx0, by0); }
    head(2, xa, c2);
    const fr = ballFrames(), bx = xb, own = !!sk.frames.sliderb, tint = (own ? sk.tintBall : !DEFSK || DEFSK.tintBall) ? c2 : (own && sk.ballColor);
    let f = fr[0]; if (tint && (tint[0] < 250 || tint[1] < 250 || tint[2] < 250)) f = tintFrame(f, tint);
    const nd = own ? sk.tex["sliderb-nd"] : texOf("sliderb-nd");
    blit(T("sliderfollowcircle"), bx, cy, s, .9); blit(nd, bx, cy, s); blit(f, bx, cy, s);
    // cursor + trail (a skin with its own cursor uses only its own trail and middle, like the player)
    const ownC = !!sk.tex.cursor, tex = n => ownC ? sk.tex[n] || null : texOf(n), cx = W * .66;
    const trail = tex("cursortrail"), cur = tex("cursor"), mid = tex("cursormiddle");
    if (trail) for (let k = 7; k >= 1; k--) blit(trail, cx - k * 12 * s * 1.2, cy + Math.sin(k * .55) * 10 * s, s * 1.3, (1 - k / 8) * .8);
    blit(cur, cx, cy, s * 1.3); blit(mid, cx, cy, s * 1.3);
    // spinner
    const sx = W * .87, names = sk.newSpinner ? ["spinner-bottom", "spinner-top", "spinner-middle2", "spinner-middle"] : ["spinner-circle", "spinner-approachcircle"];
    const ref = texOf(names[0]), ss = ref ? H * .86 / (ref.img.width / ref.hd) : 0; // (one scale for the layers, from the biggest)
    if (ss) for (const n of names) blit(texOf(n), sx, cy, ss, 1);
  } catch {} finally { ctx = oCtx; SK = oSK; g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; dropTints(sk.id); }
}
let pvChain = Promise.resolve();
// draws the card's preview (the skin is loaded for it if it isn't, and let go again unless it is the chosen one)
function skinPreview(id, cvs) {
  const done = () => { const c = skinPv.get(id); if (c && cvs.isConnected) { cvs.width = c.width; cvs.height = c.height; cvs.getContext("2d").drawImage(c, 0, 0); cvs.classList.add("ready"); } };
  if (skinPv.has(id)) return done();
  pvChain = pvChain.then(async () => {
    if (skinPv.has(id)) return done();
    await ensureSkins();
    pvHold.add(id); // (a skin picked or imported while this one loads would let it go, and its pictures close under the drawing: a blank card, kept)
    try {
      const sk = await getSkin(id), c = document.createElement("canvas"); c.width = 480; c.height = 120;
      drawSkinPreview(c, sk);
      if (sk.sndDead) throw new Error("closed"); // (closeSkin ran on it: the pictures are gone, a blank canvas is not kept)
      skinPv.set(id, c);
      if (skinPv.size > 40) skinPv.delete(skinPv.keys().next().value);
      const meta = skinMeta(sk);
      if (id.startsWith("osk:")) idb.all().then(l => { const r = l.find(x => "osk:" + x.id === id); if (r && (!r.meta || !("sounds" in r.meta))) { r.meta = meta; return idb.put(r).then(() => { if (meta.sounds) renderSkinUI(); }); } }).catch(() => {}); // (skins stored before the cards or the hitsounds: author, version and the sound count for the next time)
    } finally { pvHold.delete(id); releaseSkin(id); } // (a skin loaded only for its card is let go; the chosen one and osu! default stay)
    done();
  }).catch(() => { cvs.classList.add("failed"); });
}
let skinRenderTok = 0;
// skin section in the settings sheet
async function renderSkinUI() {
  const box = $("skinBox"); if (!box) return;
  const tok = ++skinRenderTok;
  let saved = [], dbOk = true;
  try { saved = await idb.all(); } catch { dbOk = false; }
  if (tok !== skinRenderTok) return;
  if (dbOk && /^osk:/.test(S.skin) && !saved.some(r => "osk:" + r.id === S.skin)) { skinGone(); ensureSkins(); } // (picked or synced, but not stored in this browser)
  syncSkinOpts();
  box.innerHTML = "";
  if (skinGhost) { const n = h("p", "sknote", skinGhost); n.setAttribute("role", "status"); box.append(n); }
  const grid = h("div", "skgrid"), io = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); skinPreview(e.target.dataset.id, e.target); } }), { rootMargin: "200px" }) : null;
  const card = (id, name, info, credit, stored) => {
    const on = S.skin === id, c = h("div", "skcard" + (on ? " on" : "")); c.dataset.id = id;
    const pv = h("canvas", "skpv"); pv.width = 480; pv.height = 120; pv.dataset.id = id; pv.setAttribute("aria-hidden", "true");
    if (io) io.observe(pv); else skinPreview(id, pv);
    pv.onclick = () => { if (!on) selectSkin(id); };
    const body = h("div", "skbody"), top = h("div", "sktop"), title = h("b", "skname", name);
    top.append(title); if (on) top.append(h("span", "skbadge", tr("In use")));
    body.append(top);
    if (info) body.append(h("small", "skinfo", info));
    if (credit) body.append(h("small", "skinfo", credit));
    const acts = h("div", "skacts");
    if (!on) { const b = h("button", "btn ghost sm", tr("Use")); b.onclick = () => selectSkin(id); acts.append(b); }
    if (stored) {
      const rn = h("button", "btn ghost sm", tr("Rename"));
      rn.onclick = () => {
        const inp = h("input", "skedit"); inp.type = "text"; inp.maxLength = 60; inp.value = name; inp.setAttribute("aria-label", tr("Skin name"));
        title.replaceWith(inp); inp.focus(); inp.select(); let fin = false;
        const end = async ok => {
          if (fin) return; fin = true;
          if (ok && inp.value.trim() && inp.value.trim() !== name) { try { if (!(await renameSkin(id, inp.value))) toast(tr("Couldn't rename this skin")); } catch (e) { toast(tr("Couldn't save: {err}", { err: e.message }), 3000); } }
          renderSkinUI();
        };
        inp.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") end(true); };
        inp.cancel = () => end(false); // (Esc: see the listener below)
        inp.onblur = () => end(true);
      };
      const ex = h("button", "btn ghost sm", tr("Export .osk")); ex.onclick = () => exportSkin(id);
      const del = h("button", "btn ghost sm", tr("Delete")); del.onclick = () => deleteSkin(id);
      acts.append(rn, ex, del);
    }
    body.append(acts); c.append(pv, body); grid.append(c);
  };
  const metaLine = (m, bytes) => [m && m.author ? tr("by {name}", { name: m.author }) : "", m && m.version ? "v" + m.version : "", bytes ? fmtBytes(bytes) : "", m && m.sounds > 0 ? "♪ " + tr("{n} hitsounds", { n: m.sounds }) : ""].filter(Boolean).join(" · ");
  for (const k in BUILTIN) card(k, BUILTIN[k].name + (k === "default" ? ` (${tr("recommended")})` : ""), tr("Built in"), BUILTIN[k].credit, false);
  for (const r of saved.sort((a, b) => a.added - b.added)) card("osk:" + r.id, r.name, metaLine(r.meta, r.size || (r.blob && r.blob.size)), "", true);
  box.append(grid);
  const acts = h("div", "btnrow");
  const imp = h("button", "btn ghost sm", tr("Import .osk")); imp.onclick = () => $("skinFile").click();
  acts.append(imp); box.append(acts);
  const lk = h("div", "sklink"), inp = h("input", "skedit"), go = h("button", "btn ghost sm", tr("Import from a link"));
  inp.type = "url"; inp.placeholder = tr("Direct link to an .osk file (https://…)"); inp.autocomplete = "off"; inp.spellcheck = false; inp.setAttribute("aria-label", tr("Direct link to an .osk file (https://…)"));
  go.onclick = () => { const v = inp.value.trim(); if (v) importUrl(v); };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") go.onclick(); };
  lk.append(inp, go); box.append(lk);
  box.append(h("p", "hint", tr("A direct download link of the file, for example from s-ul.eu, catbox.moe or GitHub. Pages such as Google Drive or MediaFire don't work. Up to {size} MB.", { size: SKIN_MAX_BYTES / 2 ** 20 })));
  box.append(h("p", "hint", tr("{n} of {max} skins on this device, up to {size} MB each.", { n: saved.length, max: SKIN_MAX_COUNT, size: SKIN_MAX_BYTES / 2 ** 20 })));
  if (skinReport && SK.id === S.skin && S.skin.startsWith("osk:")) box.append(h("p", "hint skreport", skinReport));
  const rec = h("details", "recs"); rec.append(h("summary", null, tr("Recommended skins for mapping")));
  const ul = h("div", "reclist");
  const item = (title, note, url, action) => {
    const d = h("div", "rec"); d.append(h("b", null, title), h("small", null, note));
    if (url) { const a = h("a", "btn ghost sm", tr("Download page")); a.href = url; a.target = "_blank"; a.rel = "noopener"; d.append(a); }
    if (action) d.append(action);
    ul.append(d);
  };
  const useDef = h("button", "btn ghost sm", tr("Use")); useDef.onclick = () => selectSkin("default");
  item("osu! default", tr("What players see by default: exact circle sizes and default hitsounds. The safest choice for mapping."), null, useDef);
  for (const r of SKIN_RECS) item(r.name, tr(r.note), r.url);
  const more = h("p", "hint"); more.append(tr("Download the .osk from the page, then press \"Import .osk\". More skins:") + " ");
  SKIN_MORE.forEach(([n, u], i) => { const a = h("a", null, n); a.href = u; a.target = "_blank"; a.rel = "noopener"; more.append(a, i < SKIN_MORE.length - 1 ? " • " : ""); });
  ul.append(more); rec.append(ul); box.append(rec);
}
// Esc in the rename field only cancels the rename (the Settings window closes on Esc anywhere in it: this listener is first)
addEventListener("keydown", e => { if (e.key === "Escape" && e.target && e.target.cancel && e.target.classList.contains("skedit")) { e.preventDefault(); e.stopImmediatePropagation(); e.target.cancel(); } }, true);
// the switches that are not on/off (a choice, a size) in the Skin pane: <select data-sk="key"> and <input type=range data-sk="key">
// (the on/off ones are data-k switches, handled with the other switches in player.js)
function syncSkinOpts() {
  document.querySelectorAll("[data-sk]").forEach(i => {
    i.value = S[i.dataset.sk];
    const o = i.parentNode.querySelector("output"); if (o) o.textContent = Math.round(S[i.dataset.sk] * 100) + "%";
  });
}
document.querySelectorAll("[data-sk]").forEach(i => i.addEventListener(i.tagName === "SELECT" ? "change" : "input", () => {
  S[i.dataset.sk] = i.type === "range" ? +i.value : i.value; cleanSkinOpts(S); save(); dirty = true; syncSkinOpts();
}));
function resetSkinOpts() {
  for (const k in SKIN_OPTS) S[k] = DEF[k];
  save(); dirty = true; syncSkinOpts(); if (typeof syncToggles === "function") syncToggles(); skinSndSoon();
  toast(tr("Skin settings reset"), 1500);
}
if ($("skinOptReset")) $("skinOptReset").onclick = resetSkinOpts;
// "Use the skin's hitsounds" (a data-k switch, set by player.js): turned on, the chosen skin's sounds start decoding (after player.js has set S)
document.querySelectorAll('[data-k="skinSounds"]').forEach(i => i.addEventListener("change", () => setTimeout(() => { if (S.skinSounds) skinSndSoon(); }, 0)));
fileAccept($("skinFile"), ".osk,.zip");
$("skinFile").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; if (!fileIs(f, ["osk", "zip"])) return toast(tr("Pick an .osk file (a skin)"), 3000); importOsk(f); };

// ---------- texture lookup ----------
const tintCache = new Map();
function texOf(name) { return SK.tex[name] || (DEFSK && DEFSK.tex[name]) || FALLBACK.tex[name] || null; }
const hasTex = name => !!SK.tex[name];
// animations: the images name-0, name-1 ... of a skin. A skin's own (sk.texFrames / sk.texFrame: only that skin's), or by name through the chosen skin,
// osu! default, the drawn fallback like texOf. They are textures like texOf's ({ img, hd }), so blit() takes them. texFrames is [] when the
// element has no frames; texFrame is the frame to draw at tMs (the plain texOf image when there are no frames, or Settings → Skin → animations is off).
// fps: given, else 60 for a hit burst (hit0 ... hit300k: fixed in osu!, and played once, the last frame stays), else AnimationFramerate,
// else all the frames in one second. once: stop on the last frame (default for hit bursts) instead of looping.
function skTexFrames(sk, name) { return sk.anim && sk.anim[name] || []; }
function skTexFrame(sk, name, tMs, fps, once) {
  const fr = sk.anim && sk.anim[name], n = fr ? fr.length : 0;
  if (n < 2 || S.skinAnim === false) return sk.tex[name] || (fr && fr[0]) || null;
  const el = ANIM_EL[name], f = fps > 0 ? fps : el || (sk.animFps > 0 ? sk.animFps : n), hold = once == null ? !!el : !!once;
  const i = Math.floor((isFinite(tMs) ? tMs : 0) * f / 1000);
  return fr[hold ? Math.max(0, Math.min(n - 1, i)) : ((i % n) + n) % n];
}
const texOwner = name => SK.tex[name] ? SK : DEFSK && DEFSK.tex[name] ? DEFSK : FALLBACK.tex[name] ? FALLBACK : null;
function texFrames(name) { if (name === "sliderb") return ballFrames(); const o = texOwner(name); return o ? skTexFrames(o, name) : []; }
function texFrame(name, tMs, fps, once) { const o = texOwner(name); return o ? skTexFrame(o, name, tMs, fps, once) : null; }
// Settings → Skin choices resolved against the skin: S.<key> "on" / "off" win, "skin" (the default) is the skin's own value. Always true / false.
// The skin's value is read from the one that supplies the part, the way the player picks them: the cursor settings from the skin that has
// a cursor image (else osu! default), the ball's from the skin that has a ball. hcOverlay: true = the overlay is drawn above the number.
// sk: ask about one skin (a card, the Home demo) instead of the chosen one.
function skinOpt(key, sk) {
  const v = S[key];
  if (v === "on") return true;
  if (v === "off") return false;
  if (key === "hcOverlay") { if (v === "above") return true; if (v === "below") return false; return (sk || SK).overlayAbove !== false; }
  const ball = sk || (SK.frames.sliderb ? SK : DEFSK || FALLBACK), cur = sk || (SK.tex.cursor ? SK : DEFSK && DEFSK.tex.cursor ? DEFSK : FALLBACK);
  if (key === "ballTint") return !!ball.tintBall;
  if (key === "ballFlip") return ball.ballFlip !== false;
  if (key === "curRotate") return !!cur.cursorRotate;
  if (key === "curExpand") return cur.cursorExpand !== false;
  return !!v;
}
// the combo colours to use: the beatmap's (mapColours, [] / null when it has none) unless Settings → Skin → Combo colours says "skin"; else the skin's, else osu! default's
function comboColours(mapColours) {
  const skin = SK.colors || (DEFSK && DEFSK.colors) || DEFAULT_SKIN_COLS;
  return S.skinCombo === "skin" || !(mapColours && mapColours.length) ? skin : mapColours;
}
function T(name, col) {
  const t = texOf(name); if (!t) return null;
  if (!col || !TINTED[name]) return t;
  const key = name + "|" + (col[0] | 0) + "," + (col[1] | 0) + "," + (col[2] | 0) + "|" + SK.id;
  let c = tintCache.get(key);
  if (!c) {
    c = { img: tintCanvas(t.img, col), hd: t.hd }; tintCache.set(key, c);
    if (tintCache.size > 200) for (const k of tintCache.keys()) if (!k.startsWith("ball|")) { tintCache.delete(k); break; } // (the ball's frames, made ahead for each colour, don't push out what's in use)
  }
  return c;
}
function ballFrames() { return SK.frames.sliderb || (DEFSK && DEFSK.frames.sliderb) || FALLBACK.frames.sliderb; }
function tintFrame(f, col) {
  const key = "ball|" + f.img.width + "|" + (col[0] | 0) + "," + (col[1] | 0) + "," + (col[2] | 0) + "|" + SK.id + "|" + ballFrames().indexOf(f);
  let c = tintCache.get(key); if (!c) { c = { img: tintCanvas(f.img, col), hd: f.hd }; tintCache.set(key, c); }
  return c;
}
let VFLIP = false; // the playfield is drawn flipped upside down (a replay with Hard Rock, player.js): a sprite stays upright at its flipped place and turns the other way
function blit(t, x, y, s = 1, a = 1, rot = 0) {
  if (!t || a <= 0.003) return;
  const w = t.img.width / t.hd * s, h = t.img.height / t.hd * s;
  ctx.globalAlpha = a > 1 ? 1 : a;
  if (VFLIP) { ctx.save(); ctx.translate(x, y); ctx.scale(1, -1); if (rot) ctx.rotate(-rot); ctx.drawImage(t.img, -w / 2, -h / 2, w, h); ctx.restore(); }
  else if (rot) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.drawImage(t.img, -w / 2, -h / 2, w, h); ctx.restore(); }
  else ctx.drawImage(t.img, x - w / 2, y - h / 2, w, h);
}
const DEFAULT_SKIN_COLS = DEFAULT_COLS;
function palette(ci) {
  const base = comboColours(map.hasColours ? map.colours : null);
  return base[((ci % base.length) + base.length) % base.length];
}

// combo numbers: skin digits, else a cached text render
const numCache = new Map();
if (document.fonts) document.fonts.ready.then(() => numCache.clear());
function numTex(n) {
  const key = n + "", hit = numCache.get(key); if (hit) return hit;
  const fs = 76, font = `600 ${fs}px Inter,sans-serif`, txt = String(n);
  const g0 = document.createElement("canvas").getContext("2d"); g0.font = font;
  const c = document.createElement("canvas"); c.width = Math.ceil(g0.measureText(txt).width) + 28; c.height = fs + 28;
  const g = c.getContext("2d"); g.font = font; g.textAlign = "center"; g.textBaseline = "middle";
  g.shadowColor = "rgba(0,0,0,.65)"; g.shadowBlur = 10; g.fillStyle = "#fff"; g.fillText(txt, c.width / 2, c.height / 2 + 4);
  numCache.set(key, c); return c;
}
function drawNumber(n, x, y, s, a) {
  if (a <= 0.003) return;
  ctx.globalAlpha = a > 1 ? 1 : a;
  if (VFLIP) { ctx.save(); ctx.translate(0, 2 * y); ctx.scale(1, -1); try { drawNumber1(n, x, y, s); } finally { ctx.restore(); } return; } // (a flipped picture: the digits upright)
  drawNumber1(n, x, y, s);
}
function drawNumber1(n, x, y, s) {
  const sk = SK.numbers ? SK : DEFSK && DEFSK.numbers ? DEFSK : null;
  if (sk) {
    const hd = sk.numHd, ov = sk.numOverlap * s * .8, digits = String(n);
    let total = 0; for (const d of digits) total += sk.numbers[+d].width / hd * s * .8;
    total -= ov * (digits.length - 1);
    let cx = x - total / 2;
    for (const d of digits) { const im = sk.numbers[+d], w = im.width / hd * s * .8, h = im.height / hd * s * .8; ctx.drawImage(im, cx, y - h / 2, w, h); cx += w - ov; }
    return;
  }
  const c = numTex(n), w = c.width / 2 * s, hh = c.height / 2 * s;
  ctx.drawImage(c, x - w / 2, y - hh / 2, w, hh);
}

// The HUD's own numbers (score, accuracy, combo): a string laid out in a skin's font (SK.fonts.score / combo) at scale f (a skin pixel is f canvas pixels, at 1x: each glyph
// uses its own hd), the overlap in 1x pixels (osu!'s ScoreOverlap / ComboOverlap). Digits and . , % x; null when a character has no glyph (that whole line is drawn as text instead)
const HUD_CH = { ",": "comma", ".": "dot", "%": "percent", "x": "x" };
function hudLayout(font, str, f) {
  if (!font || !font.g) return null;
  const items = []; let x = 0, h = 0;
  for (const ch of String(str)) {
    const g = font.g[/\d/.test(ch) ? ch : HUD_CH[ch]]; if (!g) return null;
    const w = g.img.width / g.hd * f, gh = g.img.height / g.hd * f;
    items.push({ g, x, w, h: gh }); if (gh > h) h = gh; x += w - font.overlap * f;
  }
  const last = items[items.length - 1];
  return { items, width: last ? last.x + last.w : 0, height: h };
}
function hudDraw(lay, x, y, a = 1) { // (left x, top y; the glyphs centred on the line's height)
  ctx.globalAlpha = a > 1 ? 1 : a;
  for (const it of lay.items) ctx.drawImage(it.g.img, x + it.x, y + (lay.height - it.h) / 2, it.w, it.h);
}

// A line in the skin's font fitted to a digit height of hpx pixels (the "0" glyph's height; the Top 50 board's rows) -> a hudLayout, or null (no font / a missing glyph)
function hudFit(font, str, hpx) {
  const g0 = font && font.g && font.g["0"]; if (!g0) return null;
  return hudLayout(font, str, hpx / (g0.img.height / g0.hd));
}

// soft glow + dot sprites (kiai effect, spinner flash)
const GLOW = circleTex(128, (g, R) => { const gr = g.createRadialGradient(0, 0, 0, 0, 0, R); gr.addColorStop(0, "#fff"); gr.addColorStop(1, "rgba(255,255,255,0)"); disc(g, R, gr); });
const DOT = circleTex(16, (g, R) => disc(g, R * .9, "#fff"));
const fxCache = new Map();
function fxTex(base, col) {
  const key = (base === GLOW ? "g" : "d") + (col[0] | 0) + "," + (col[1] | 0) + "," + (col[2] | 0);
  let c = fxCache.get(key);
  if (!c) { c = tintCanvas(base, col); fxCache.set(key, c); if (fxCache.size > 64) fxCache.delete(fxCache.keys().next().value); }
  return c;
}

// ---------- slider bodies (osu! legacy look: fading shadow, border, darker edge -> lighter centre, 70% opaque) ----------
// rendered once per slider into an offscreen canvas and reused while it's on screen
const bodyCache = new Map();
// snaking bodies: a few canvases taken in turn, so the next slider in the same frame isn't painted into the canvas just
// drawn from (WebKit has to copy or wait for a canvas that is changed right after it was drawn)
const bodyScratch = [null, null, null, null]; let bodyScratchI = 0, bodyPainted = false;
function sliderColours(col) {
  const bm = (map && map.colourMap) || {}; // the beatmap's own slider colours win over the skin's, like in osu!
  const acc = bm.SliderTrackOverride || SK.trackColor || col, border = bm.SliderBorder || SK.borderColor || [255, 255, 255];
  return { border, outer: acc.map(v => v / 1.1), inner: acc.map(v => Math.min(255, v * 1.125 + 63.75)) };
}
// osu!stable's look as osu!lazer draws it (LegacySliderBody.ColourAt, from stable's MmSliderRendererGL; McOsu's shader is the same), going in from
// the edge: a shadow 5/64 of the radius wide from nothing to 25% black, the border up to 0.1875, then the body from the darker colour at the
// border to the lighter one on the path, smoothly, 70% opaque. lazer puts that into a texture 2·floor(r) texels wide (osu-framework SmoothPath:
// texel i holds the colour at i / (W − 1), its alpha × min(p / 0.02, 1)) and the graphics card reads it with linear filtering at
// u = 1 − distance / r: so the border's edges fall on texel boundaries and are a texel soft, not exactly at 5/64 and 0.1875 (lazerColour).
// A canvas can't colour by the distance from a path, so it's rings of stroke, each narrower and the colour at its middle: about a device pixel
// each across the shadow and each texel-soft edge, one for the border, N for the body (bodyBands: as many as keep a ring a few pixels wide).
// Each ring lands on the ones under it, so going in: while the alpha rises (shadow, then the border) each ring is the colour that, laid over
// the last, gives lazer's (stacked like glass); from the border in, opaque colours, then cut-outs that take the alpha down to the body's 70%.
// (Cutting a ring out and drawing it again instead leaves a lighter seam along each edge: half-covered pixels lose alpha twice.)
function paintBody(g, path, r, cols, N = 14, fine = true) { // (fine false: fewer rings, for a body drawn again every frame)
  const W = Math.max(1, Math.floor(r)) * 2, sh = S.sliderShadow !== false, m = g.getTransform(), k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1; // (k: device px per unit)
  const i1 = Math.ceil((1 - 59 / 64) * (W - 1)), i2 = Math.max(i1 + 1, Math.ceil(.1875 * (W - 1))); // (the first border texel, the first body texel)
  const e1 = (i1 - .5) / W, b0 = (i1 + .5) / W, b1 = (i2 - .5) / W, uB = (i2 + .5) / W; // (where each soft edge starts and ends)
  const K = sh ? Math.max(3, Math.min(fine ? 12 : 4, Math.ceil(e1 * r * k))) : 0, T = fine ? Math.max(2, Math.min(8, Math.ceil(r * k / W))) : 1; // (rings: shadow, per soft edge)
  const up = [], down = []; // [u where the ring starts, u where it ends]: alpha rising, then falling
  for (let j = 0; j < K; j++) up.push([e1 * j / K, e1 * (j + 1) / K]);
  for (let j = 0; j < T; j++) up.push([e1 + (b0 - e1) * j / T, e1 + (b0 - e1) * (j + 1) / T]);
  if (b1 > b0) up.push([b0, b1]);
  for (let j = 0; j < T; j++) down.push([b1 + (uB - b1) * j / T, b1 + (uB - b1) * (j + 1) / T]);
  const width = u => Math.max(.5, 2 * r * (1 - u)), col = z => lazerColour((z[0] + z[1]) / 2, W, cols, sh), c255 = v => Math.max(0, Math.min(255, Math.round(v)));
  g.lineCap = g.lineJoin = "round";
  let pr = 0, pg = 0, pb = 0, pa = 0; // (what the rings so far give, premultiplied)
  for (const z of up) {
    const c = col(z), a = Math.max(c[3], pa), as = pa >= 1 ? 1 : (a - pa) / (1 - pa); // (the ring's alpha: over pa it makes a)
    const sr = c[0] * a - pr * (1 - as), sg = c[1] * a - pg * (1 - as), sb = c[2] * a - pb * (1 - as);
    if (as > 0) { g.lineWidth = width(z[0]); g.strokeStyle = "rgba(" + c255(sr / as) + "," + c255(sg / as) + "," + c255(sb / as) + "," + as.toFixed(4) + ")"; g.stroke(path); }
    pr = c[0] * a; pg = c[1] * a; pb = c[2] * a; pa = a;
  }
  const inner = [...down]; for (let j = 0; j < N; j++) inner.push([uB + (1 - uB) * j / N, uB + (1 - uB) * (j + 1) / N]);
  for (const z of inner) { g.lineWidth = width(z[0]); g.strokeStyle = rgb(col(z)); g.stroke(path); } // (opaque: their alpha below)
  g.globalCompositeOperation = "destination-out"; g.strokeStyle = "#000"; let qa = 1;
  for (const z of [...down, [uB, 1]]) { const a = Math.min(qa, col(z)[3]); if (a < qa) { g.globalAlpha = 1 - a / qa; g.lineWidth = width(z[0]); g.stroke(path); } qa = a; }
  g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
}
// the colour lazer's slider texture gives at u (0 the edge, 1 on the path), straight [r, g, b, a]: W texels of LegacySliderBody.ColourAt read with
// linear filtering (the shader in glbody.js does the same)
function lazerColour(u, W, cols, shadow) {
  const at = i => { const p = W > 1 ? i / (W - 1) : 1, sp = 1 - 59 / 64, bp = .1875;
    const c = p <= sp ? [0, 0, 0, shadow ? .25 * p / sp : 0] : p <= bp ? [cols.border[0], cols.border[1], cols.border[2], 1] : [...mix(cols.outer, cols.inner, (p - bp) / (1 - bp)), .7];
    c[3] *= Math.min(p / .02, 1); return c; };
  const x = Math.max(0, Math.min(W - 1, u * W - .5)), i0 = Math.floor(x), f = x - i0, a = at(i0), b = at(Math.min(W - 1, i0 + 1));
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}
const bodyBands = (rpx, px, lo, hi) => Math.max(lo, Math.min(hi, Math.ceil(rpx * (1 - .1875) / px))); // (body rings about px device pixels wide)
// ---------- huge bodies (Aspire maps) are painted in workers ----------
// Thousands of segments take the canvas seconds to stroke 20 times, so such a body (heavyBody) is painted on an
// OffscreenCanvas in a worker (paintBody's own code, sent as text) and comes back as an ImageBitmap; drawObjects asks
// a few seconds ahead, so it's usually ready when the slider appears, and the game never stalls while it's painted.
const heavyBody = o => !!(o.path && (o.path.jumps || o.path.length > 1500));
const HEAVY = { ws: null, rr: 0, seq: 0, cache: new Map(), wait: new Map(), off: typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined" || typeof createImageBitmap === "undefined" };
function heavyWorkers() {
  if (HEAVY.off) return null;
  if (HEAVY.ws) return HEAVY.ws;
  try {
    const src = `"use strict";const S={};const rgb=${rgb};const mix=${mix};${paintBody}${lazerColour}
onmessage=e=>{const d=e.data;try{S.sliderShadow=d.shadow;const c=new OffscreenCanvas(d.cw,d.ch),g=c.getContext("2d");g.setTransform(d.sc,0,0,d.sc,-d.x0*d.sc,-d.y0*d.sc);
const P=new Path2D(),p=d.pts,j=d.jumps,n=p.length/2;for(let i=0;i<n;i++){if(!i||j[i])P.moveTo(p[2*i],p[2*i+1]);else P.lineTo(p[2*i],p[2*i+1]);}if(n===1)P.lineTo(p[0]+.01,p[1]);
paintBody(g,P,d.r,d.cols,d.n);const b=c.transferToImageBitmap();postMessage({id:d.id,b},[b]);}catch(err){postMessage({id:d.id,err:String(err)});}};`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    HEAVY.ws = Array.from({ length: Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) }, () => {
      const w = new Worker(url);
      w.onmessage = e => {
        const d = e.data, key = HEAVY.wait.get(d.id); HEAVY.wait.delete(d.id);
        const it = key && HEAVY.cache.get(key);
        if (d.b) { if (it && it.id === d.id) { it.c = d.b; dirty = true; } else d.b.close(); }
        else if (it && it.id === d.id) it.failed = true; // (painted on the page instead)
      };
      w.onerror = () => { HEAVY.off = true; for (const it of HEAVY.cache.values()) if (!it.c) it.failed = true; dirty = true; }; // (no workers here: painted on the page)
      return w;
    });
  } catch { HEAVY.off = true; HEAVY.ws = null; }
  return HEAVY.ws;
}
function heavyClear() { for (const it of HEAVY.cache.values()) if (it.c && it.c.close) it.c.close(); HEAVY.cache.clear(); HEAVY.wait.clear(); }

// returns { c, x, y, w, h } in osu!px (null: a huge body still being painted); the part of the path from `from` to
// `frac` (fractions of its length). Anything less than the whole path (snaking in or out) is drawn every frame and not cached
function sliderBody(o, col, frac, from = 0) {
  const r = map.radius, pxs = Math.min(3, VIEW.vs), full = frac >= 1 && from <= 0;
  const key = full ? `${o.lid}|${o.x},${o.y}|${o.length}|${o.path.length}|${pxs.toFixed(3)}|${o.path.jumps ? viewOsuRect(0).map(Math.round).join(",") : ""}|${r}|${col}|${SK.id}|${map.colourMap.SliderTrackOverride || ""}|${map.colourMap.SliderBorder || ""}|${S.sliderShadow !== false}` : null;
  if (full) { const hit = bodyCache.get(key); if (hit) return hit; }
  const heavy = full && heavyBody(o) && heavyWorkers();
  if (heavy) { const it = HEAVY.cache.get(key); if (it && !it.failed) return it.c ? it : null; }
  let pts = o.path;
  const J = o.path.jumps; // (a path with left-out stretches far off-screen: parse.js farPath)
  if (!full) {
    const tot = o.cum[o.cum.length - 1], L0 = tot * Math.max(0, from), L1 = tot * Math.min(1, frac), pj = J && new Set();
    pts = []; if (L0 > 0) { const p = pointAt(o, from); pts.push([p[0], p[1]]); }
    for (let i = 0; i < o.path.length; i++) {
      if (o.cum[i] <= L0 && L0 > 0) continue;
      if (o.cum[i] <= L1) { if (pj && J.has(i) && pts.length) pj.add(pts.length); pts.push(o.path[i]); }
      else { if (!(J && J.has(i))) { const p = pointAt(o, frac); pts.push([p[0], p[1]]); } break; }
    }
    if (pj) pts.jumps = pj;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[0] > x1) x1 = q[0]; if (q[1] > y1) y1 = q[1]; }
  x0 -= r + 2; y0 -= r + 2; x1 += r + 2; y1 += r + 2;
  if (J) { // only what can be on screen (its far-off parts would make the canvas huge and blurry)
    const v = viewOsuRect(r + 2); x0 = Math.max(x0, v[0]); y0 = Math.max(y0, v[1]); x1 = Math.min(x1, v[2]); y1 = Math.min(y1, v[3]);
    if (x1 <= x0 || y1 <= y0) { x1 = x0 + 1; y1 = y0 + 1; }
  }
  let sc = pxs; const W = (x1 - x0) * sc, H = (y1 - y0) * sc, cap = heavy ? 2.5e6 : 5e6;
  if (W * H > cap) sc *= Math.sqrt(cap / (W * H));
  const cw = Math.max(1, Math.ceil((x1 - x0) * sc)), ch = Math.max(1, Math.ceil((y1 - y0) * sc));
  if (heavy && !(HEAVY.cache.get(key) || {}).failed) {
    const n = pts.length, flat = new Float64Array(2 * n), jf = new Uint8Array(n);
    for (let i = 0; i < n; i++) { flat[2 * i] = pts[i][0]; flat[2 * i + 1] = pts[i][1]; if (J && J.has(i)) jf[i] = 1; }
    const id = ++HEAVY.seq, w = HEAVY.ws[HEAVY.rr++ % HEAVY.ws.length];
    HEAVY.cache.set(key, { id, c: null, x: x0, y: y0, w: cw / sc, h: ch / sc, sw: cw, sh: ch }); HEAVY.wait.set(id, key);
    while (HEAVY.cache.size > 24) { const k0 = HEAVY.cache.keys().next().value, it = HEAVY.cache.get(k0); if (it.c && it.c.close) it.c.close(); HEAVY.cache.delete(k0); }
    w.postMessage({ id, pts: flat, jumps: jf, cw, ch, sc, x0, y0, r, cols: sliderColours(col), n: 10, shadow: S.sliderShadow !== false }, [flat.buffer, jf.buffer]);
    return null;
  }
  let c;
  if (full) { c = document.createElement("canvas"); c.width = cw; c.height = ch; }
  else {
    const i = bodyScratchI = (bodyScratchI + 1) % bodyScratch.length;
    c = bodyScratch[i] || (bodyScratch[i] = document.createElement("canvas")); if (c.width < cw || c.height < ch) { c.width = Math.max(c.width, cw); c.height = Math.max(c.height, ch); }
  }
  const g = c.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, full ? c.width : cw, full ? c.height : ch); // (a scratch canvas: only the part drawn from)
  g.setTransform(sc, 0, 0, sc, -x0 * sc, -y0 * sc);
  const path = full ? o.p2d : new Path2D(); if (!full) tracePath(path, pts);
  if (pts.length === 1) path.lineTo(pts[0][0] + .01, pts[0][1]);
  paintBody(g, path, r, sliderColours(col), full ? bodyBands(r * sc, 3, 12, 24) : bodyBands(r * sc, 8, 6, 10), full); // fewer rings while snaking (redrawn every frame)
  const res = { c, x: x0, y: y0, w: cw / sc, h: ch / sc, sw: cw, sh: ch };
  if (full) { bodyCache.set(key, res); bodyPainted = true; if (bodyCache.size > 48) bodyCache.delete(bodyCache.keys().next().value); }
  return res;
}

// ============ storyboard sprite drawing ============
const sbTint = new Map(); let sbTintBytes = 0; // tinted copies of storyboard images, least recently used dropped first
const SB_TINT_MAX = () => (DEV.coarse ? 64 : 256) * 2 ** 20;
function sbTintClear() { for (const c of sbTint.values()) c.width = c.height = 0; sbTint.clear(); sbTintBytes = 0; }
const _1 = [0], _2 = [0, 0], _3 = [0, 0, 0];
let SBM = [1, 0, 0, 1, 0, 0]; // playfield transform, set once per frame
// How much of a heavy storyboard is drawn (Settings → Quality: Auto): the slower the screen runs, the more of the sprites that add little are left
// out. lod 1..4: sprites of under 1.5, 3, 5, 7 device pixels of opacity x area go, and of the small ones
// (under 40) only 3, 2, 1 in 4 stay (which ones is fixed per sprite: no flicker). player.js raises it when frames run slow and the storyboard is
// big, before it lowers the picture's resolution, and lowers it again when that stretch is over.
const SBL = { lod: 0, res: 1, min: 0, q: 4, eMin: 0, eQ: 4, eRes: 1, k2: 1, active: 0, at: 0, clean: 0 };
const SBL_MIN = [0, 1.5, 3, 5, 7], SBL_Q = [4, 4, 3, 2, 1], SBL_RES = [1, 1, 1, 1, 1], SBL_SMALL = 40; // (res: the picture's resolution, kept: the background is in it, and the sprites' fill isn't what holds a phone back)
function sbLod(n) { SBL.lod = n; SBL.min = SBL_MIN[n]; SBL.q = SBL_Q[n]; SBL.res = SBL_RES[n]; SBL.clean = 0; }
// per frame: what the lightening comes to (Quality: Auto only, and while playing; Highest never lightens) and the device pixels one osu!pixel covers
function sbFrameState() { const auto = S.quality === "auto" && isPlaying(); // (paused: all of it)
  SBL.eMin = auto ? SBL.min : 0; SBL.eQ = auto ? SBL.q : 4; SBL.eRes = auto ? SBL.res : 1; SBL.k2 = Math.abs(SBM[0] * SBM[3] - SBM[1] * SBM[2]) || 1; }
let sbAdd = false; // (the blend mode of the last sprite: set again only when it changes)
// one sprite's look at time t (parse.js: sbActive, sbEv) into SBR; false: nothing to draw (not showing, or left out)
const SBR = { o: 0, x: 0, y: 0, sx: 1, sy: 1, cs: 1, sn: 0, ox: 0, oy: 0, add: false, nm: 0, img: null, tint: false, q0: 255, q1: 255, q2: 255, w: 0, h: 0 };
function sbCalc(c, i, t) {
  const cn = c.cn;
  const o = cn[0][i] ? sbEv(c, 0, i, t, _1)[0] : 1; if (o <= 0.003) return false;
  let x = c.x[i], y = c.y[i];
  if (cn[3][i]) { sbEv(c, 3, i, t, _2); x = _2[0]; y = _2[1]; }
  if (cn[4][i]) x = sbEv(c, 4, i, t, _1)[0];
  if (cn[5][i]) y = sbEv(c, 5, i, t, _1)[0];
  const sc = cn[1][i] ? sbEv(c, 1, i, t, _1)[0] : 1;
  let vx = 1, vy = 1; if (cn[2][i]) { sbEv(c, 2, i, t, _2); vx = _2[0]; vy = _2[1]; }
  if (!sc || !vx || !vy) return false;
  const rot = cn[6][i] ? sbEv(c, 6, i, t, _1)[0] : 0;
  let flipH = false, flipV = false, add = false;
  for (let q = c.pOff[i], e = c.pOff[i + 1]; q < e; q++) {
    const a = c.pD[3 * q], b = c.pD[3 * q + 1];
    if (a === b ? t >= a : t >= a && t <= b) { const v = c.pD[3 * q + 2]; if (v === 1) flipH = true; else if (v === 2) flipV = true; else if (v === 3) add = true; }
  }
  let fi = 0; const nf = c.nf[i], dl = c.delay[i];
  if (nf > 1 && dl > 0) {
    fi = Math.floor((t - c.start[i]) / dl);
    fi = c.flags[i] & 1 ? Math.min(Math.max(fi, 0), nf - 1) : ((fi % nf) + nf) % nf;
  }
  const nm = c.frameIds[c.fo[i] + fi], img = c.imgs[nm] || (c.imgs[nm] = images[c.names[nm]]); if (!img || !img.width) return false; // (a closed picture is 0 wide: drawing it would throw)
  const w = img.ow || img.width, h = img.oh || img.height, R = SBR, sx = sc * vx * (flipH ? -1 : 1), sy = sc * vy * (flipV ? -1 : 1);
  if (SBL.eMin) { // (little to see: left out, or thinned out, while the screen can't keep up)
    const eff = o * Math.abs(sx * sy) * w * h * SBL.k2;
    if (eff < SBL.eMin || eff < SBL_SMALL && (Math.imul(i, 2654435761) >>> 30) >= SBL.eQ) return false;
  }
  R.tint = false;
  if (cn[7][i]) {
    sbEv(c, 7, i, t, _3);
    if (_3[0] < 250 || _3[1] < 250 || _3[2] < 250) { R.tint = true; R.q0 = Math.round(_3[0] / 8) * 8; R.q1 = Math.round(_3[1] / 8) * 8; R.q2 = Math.round(_3[2] / 8) * 8; }
  }
  R.o = o > 1 ? 1 : o; R.x = x; R.y = y; R.sx = sx; R.sy = sy; R.cs = rot ? Math.cos(rot) : 1; R.sn = rot ? Math.sin(rot) : 0; R.ox = c.ox[i]; R.oy = c.oy[i];
  R.add = add; R.nm = nm; R.img = img; R.w = w; R.h = h;
  return true;
}
function sbSprite(c, i, t) { // drawn on the page's canvas
  if (!sbCalc(c, i, t)) return;
  const R = SBR; let img = R.img;
  if (R.tint) {
    const k = c.names[R.nm] + "|" + R.q0 + "," + R.q1 + "," + R.q2;
    let tc = sbTint.get(k);
    if (tc) { sbTint.delete(k); sbTint.set(k, tc); }
    else {
      tc = tintCanvas(img, [R.q0, R.q1, R.q2]); sbTint.set(k, tc); sbTintBytes += tc.width * tc.height * 4;
      for (const [k2, c2] of sbTint) { if (sbTintBytes <= SB_TINT_MAX() && sbTint.size <= 240 || k2 === k) break; sbTintBytes -= c2.width * c2.height * 4; c2.width = c2.height = 0; sbTint.delete(k2); }
    }
    img = tc;
  }
  // playfield transform, then translate(x, y), rotate(rot), scale(sx, sy) as one matrix
  const ra = R.cs * R.sx, rb = R.sn * R.sx, rc = -R.sn * R.sy, rd = R.cs * R.sy, M = SBM;
  ctx.setTransform(M[0] * ra + M[2] * rb, M[1] * ra + M[3] * rb, M[0] * rc + M[2] * rd, M[1] * rc + M[3] * rd, M[0] * R.x + M[2] * R.y + M[4], M[1] * R.x + M[3] * R.y + M[5]);
  ctx.globalAlpha = R.o;
  if (R.add !== sbAdd) { ctx.globalCompositeOperation = R.add ? "lighter" : "source-over"; sbAdd = R.add; }
  ctx.drawImage(img, -R.ox * R.w, -R.oy * R.h, R.w, R.h);
}
function sbDraw(t) { // the whole storyboard: the .osb's sprites and the difficulty's own, by layer
  const cs = sb.chunks; sbAdd = false; ctx.globalCompositeOperation = "source-over"; sbFrameState();
  let total = 0; for (const c of cs) { sbActive(c, t); total += c.na; } SBL.active = total;
  if (cs.length === 1) { const c = cs[0], act = c.act; for (let k = 0; k < c.na; k++) sbSprite(c, act[k], t); return; }
  const a = cs[0], b = cs[1]; let ia = 0, ib = 0;
  for (let L = 0; L < 5; L++) {
    while (ia < a.na && a.layer[a.act[ia]] === L) sbSprite(a, a.act[ia++], t);
    while (ib < b.na && b.layer[b.act[ib]] === L) sbSprite(b, b.act[ib++], t);
  }
}
