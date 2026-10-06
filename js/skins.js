"use strict";
const cv = $("cv"), ctx = cv.getContext("2d");

const tintCanvas = (img, col) => {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
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
  "spinner-circle", "spinner-metre", "spinner-approachcircle", "spinner-spin", "spinner-clear"];
const TINTED = { hitcircle: 1, approachcircle: 1, sliderstartcircle: 1, sliderendcircle: 1, lighting: 1, "spinner-glow": 1 };

// tiny IndexedDB wrapper for imported skins
// IndexedDB "obv": imported skins, unsaved drafts (js/drafts.js) and downloaded maps (js/app.js, "osz")
let idbP = null;
function idbOpen() {
  return idbP || (idbP = new Promise((res, rej) => {
    let r; try { r = indexedDB.open("obv", 3); } catch (e) { idbP = null; return rej(e); }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("skins")) db.createObjectStore("skins", { keyPath: "id" });
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "key" });
      if (!db.objectStoreNames.contains("osz")) db.createObjectStore("osz", { keyPath: "id" });
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); idbP = null; }; res(db); };
    r.onerror = () => { idbP = null; rej(r.error); };
    r.onblocked = () => { idbP = null; rej(new Error("storage blocked by another tab")); };
  }));
}
async function idbTx(store, mode, fn) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), rq = fn(t.objectStore(store));
    t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("aborted"));
  });
}
const idb = { all: () => idbTx("skins", "readonly", s => s.getAll()), put: v => idbTx("skins", "readwrite", s => s.put(v)), del: id => idbTx("skins", "readwrite", s => s.delete(id)) };

function parseIni(text) {
  const o = {}; let sec = "General";
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\/\/.*$/, "").trim(); if (!l) continue;
    const h = l.match(/^\[(.+)\]$/); if (h) { sec = h[1]; continue; }
    const i = l.indexOf(":"); if (i < 0) continue;
    (o[sec] = o[sec] || {})[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return o;
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
async function buildSkin(id, name, idx, ini, alias = {}) {
  const G = ini.General || {}, C = ini.Colours || {}, F = ini.Fonts || {};
  const sk = { id, name, tex: {}, frames: {}, numbers: null, ini };
  const load = async key => {
    const e = idx[key] || (alias[key] && idx[alias[key]]); if (!e) return null;
    try { return { img: await createImageBitmap(await e.get()), hd: e.hd }; } catch { return null; }
  };
  const jobs = ELEMS.map(async k => { const r = (await load(k)) || (await load(k + "-0")); if (r) sk.tex[k] = r; });
  jobs.push((async () => {
    const fr = []; for (let i = 0; i < 60; i++) { if (!idx["sliderb" + i]) break; fr.push(load("sliderb" + i)); }
    let arr = (await Promise.all(fr)).filter(Boolean);
    if (!arr.length) { const one = await load("sliderb"); if (one) arr = [one]; }
    if (arr.length) sk.frames.sliderb = arr;
  })());
  const prefix = (F.HitCirclePrefix || "default").replace(/\\/g, "/").toLowerCase();
  jobs.push((async () => {
    const nums = await Promise.all([...Array(10).keys()].map(d => load(`${prefix}-${d}`)));
    if (nums.every(Boolean)) { sk.numbers = nums.map(n => n.img); sk.numHd = nums[0].hd; }
  })());
  await Promise.all(jobs);
  const col = s => s ? s.split(",").map(Number).slice(0, 3) : null;
  const combos = []; for (let i = 1; i <= 8; i++) if (C["Combo" + i]) combos.push(col(C["Combo" + i]));
  Object.assign(sk, {
    colors: combos.length ? combos : null, borderColor: col(C.SliderBorder), trackColor: col(C.SliderTrackOverride), ballColor: col(C.SliderBall),
    tintBall: G.AllowSliderBallTint === "1", numOverlap: +(F.HitCircleOverlap ?? -2) || 0,
    overlayAbove: (G.HitCircleOverlayAboveNumber ?? G.HitCircleOverlayAboveNumer ?? "1") !== "0",
    ballFlip: G.SliderBallFlip === "1", cursorRotate: G.CursorRotate !== "0" && !!sk.tex.cursor, cursorCentre: G.CursorCentre !== "0", cursorExpand: G.CursorExpand !== "0",
  });
  sk.newSpinner = !!(sk.tex["spinner-top"] || sk.tex["spinner-bottom"]) || !(sk.tex["spinner-circle"] || sk.tex["spinner-background"]);
  return sk;
}
async function loadBuiltin(id) {
  const B = BUILTIN[id], base = `skins/${id}/`;
  const idx = indexFiles(SKIN_FILES[id].map(f => ({ path: f, depth: 0, get: () => fetch(base + f).then(r => { if (!r.ok) throw 0; return r.blob(); }) })));
  let ini = B.ini || {};
  if (B.iniFile) { try { ini = parseIni(await (await fetch(base + B.iniFile)).text()); } catch {} }
  const sk = await buildSkin(id, B.name, idx, ini, B.alias);
  if (!Object.keys(sk.tex).length) throw new Error("offline");
  return sk;
}
async function loadOskBlob(id, name, blob) {
  const zip = await (await loadJSZip()).loadAsync(blob), list = [];
  let iniEntry = null, iniDepth = 99;
  zip.forEach((p, e) => {
    if (e.dir) return;
    const n = p.replace(/\\/g, "/"), depth = n.split("/").length;
    if (/(^|\/)skin\.ini$/i.test(n) && depth < iniDepth) { iniEntry = e; iniDepth = depth; }
    list.push({ path: n, depth, get: () => e.async("blob") });
  });
  // skins zipped inside a folder: strip that folder so "folder/hitcircle" is found as "hitcircle"
  const root = iniEntry ? iniEntry.name.replace(/\\/g, "/").replace(/skin\.ini$/i, "") : "";
  if (root) for (const f of list) if (f.path.startsWith(root)) { f.path = f.path.slice(root.length); f.depth -= root.split("/").length - 1; }
  const ini = iniEntry ? parseIni(await iniEntry.async("string")) : {};
  return buildSkin(id, (ini.General && ini.General.Name) || name, indexFiles(list), ini);
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
  return { id: "fallback", name: "fallback", tex, frames: { sliderb: [ball] }, numbers: null, tintBall: true, numOverlap: -2, overlayAbove: true, newSpinner: false, ini: {} };
}
const FALLBACK = makeFallback();
let DEFSK = null, SK = FALLBACK;
const skinCache = {};
async function getSkin(id) {
  if (skinCache[id]) return skinCache[id];
  let p;
  if (BUILTIN[id]) p = loadBuiltin(id);
  else if (id.startsWith("osk:")) p = idb.all().then(list => { const r = list.find(x => "osk:" + x.id === id); if (!r) throw new Error("gone"); return loadOskBlob(id, r.name, r.blob); });
  else p = Promise.reject(new Error("unknown"));
  skinCache[id] = p; p.catch(() => delete skinCache[id]);
  return p;
}
// make sure osu! default (the fallback) and the chosen skin are loaded
async function ensureSkins() {
  if (!DEFSK) { try { DEFSK = await getSkin("default"); } catch { DEFSK = FALLBACK; } }
  if (SK === FALLBACK || SK.id !== S.skin) {
    try { SK = await getSkin(S.skin); } catch { SK = DEFSK; }
    clearSkinCaches();
  }
}
function clearSkinCaches() { tintCache.clear(); numCache.clear(); fxCache.clear(); bodyCache.clear(); heavyClear(); dirty = true; }
async function selectSkin(id) {
  showLoading(tr("Loading skin…"), -1);
  try { const sk = await getSkin(id); SK = sk; S.skin = id; save(); clearSkinCaches(); }
  catch { toast(tr("Couldn't load this skin")); }
  hideLoading(); renderSkinUI();
}
async function importOsk(file) {
  showLoading(tr("Loading skin…"), -1);
  try {
    const id = Date.now().toString(36), name = file.name.replace(/\.(osk|zip)$/i, "");
    const sk = await loadOskBlob("osk:" + id, name, file);
    if (!Object.keys(sk.tex).length && !sk.numbers) throw new Error(tr("No skin images found in this file"));
    try { await idb.put({ id, name: sk.name, blob: file, added: Date.now() }); } catch { toast(tr("Couldn't save the skin in this browser, it will be gone after reload")); }
    skinCache[sk.id] = Promise.resolve(sk); SK = sk; S.skin = sk.id; save(); clearSkinCaches();
    toast(tr('Using skin "{name}". Missing parts use osu! default.', { name: sk.name }));
  } catch (e) { toast(tr("Couldn't load skin: {err}", { err: e.message })); }
  hideLoading(); renderSkinUI();
}
async function deleteSkin(id) {
  if (!id.startsWith("osk:") || !(await ask(tr("Delete this skin from this browser?"), { ok: tr("Delete"), danger: true }))) return;
  try { await idb.del(id.slice(4)); } catch {}
  delete skinCache[id];
  if (S.skin === id) await selectSkin("default"); else renderSkinUI();
}
// skin section in the settings sheet
async function renderSkinUI() {
  const box = $("skinBox"); if (!box) return;
  let saved = [];
  try { saved = await idb.all(); } catch {}
  box.innerHTML = "";
  const sel = h("select"); sel.id = "skinSel"; sel.setAttribute("aria-label", tr("Skin"));
  for (const k in BUILTIN) sel.add(new Option(BUILTIN[k].name + (k === "default" ? ` (${tr("recommended")})` : ""), k));
  for (const r of saved.sort((a, b) => a.added - b.added)) sel.add(new Option(r.name, "osk:" + r.id));
  sel.value = S.skin; if (sel.value !== S.skin) sel.value = "default";
  sel.onchange = () => selectSkin(sel.value);
  const row = h("label", "row"); row.append(h("span", null, tr("Skin")), sel); box.append(row);
  const cur = BUILTIN[S.skin]; if (cur && cur.credit) box.append(h("p", "hint", cur.credit));
  const acts = h("div", "btnrow");
  const imp = h("button", "btn ghost sm", tr("Import .osk")); imp.onclick = () => $("skinFile").click();
  acts.append(imp);
  if (S.skin.startsWith("osk:")) { const del = h("button", "btn ghost sm", tr("Delete this skin")); del.onclick = () => deleteSkin(S.skin); acts.append(del); }
  box.append(acts);
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
  item("YUGEN Remastered (by Garin)", tr("Clean, dark and minimal. Stacks and slider bodies are easy to read."), "https://osu.ppy.sh/community/forums/topics/1999325");
  for (const r of SKIN_RECS) item(r.name, tr(r.note), r.url);
  const more = h("p", "hint"); more.append(tr("Download the .osk from the page, then press \"Import .osk\". More skins:") + " ");
  SKIN_MORE.forEach(([n, u], i) => { const a = h("a", null, n); a.href = u; a.target = "_blank"; a.rel = "noopener"; more.append(a, i < SKIN_MORE.length - 1 ? " • " : ""); });
  ul.append(more); rec.append(ul); box.append(rec);
}
fileAccept($("skinFile"), ".osk,.zip");
$("skinFile").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; if (!fileIs(f, ["osk", "zip"])) return toast(tr("Pick an .osk file (a skin)"), 3000); importOsk(f); };

// ---------- texture lookup ----------
const tintCache = new Map();
function texOf(name) { return SK.tex[name] || (DEFSK && DEFSK.tex[name]) || FALLBACK.tex[name] || null; }
const hasTex = name => !!SK.tex[name];
function T(name, col) {
  const t = texOf(name); if (!t) return null;
  if (!col || !TINTED[name]) return t;
  const key = name + "|" + (col[0] | 0) + "," + (col[1] | 0) + "," + (col[2] | 0) + "|" + SK.id;
  let c = tintCache.get(key);
  if (!c) { c = { img: tintCanvas(t.img, col), hd: t.hd }; tintCache.set(key, c); if (tintCache.size > 200) tintCache.delete(tintCache.keys().next().value); }
  return c;
}
function ballFrames() { return SK.frames.sliderb || (DEFSK && DEFSK.frames.sliderb) || FALLBACK.frames.sliderb; }
function tintFrame(f, col) {
  const key = "ball|" + f.img.width + "|" + (col[0] | 0) + "," + (col[1] | 0) + "," + (col[2] | 0) + "|" + SK.id + "|" + ballFrames().indexOf(f);
  let c = tintCache.get(key); if (!c) { c = { img: tintCanvas(f.img, col), hd: f.hd }; tintCache.set(key, c); }
  return c;
}
function blit(t, x, y, s = 1, a = 1, rot = 0) {
  if (!t || a <= 0.003) return;
  const w = t.img.width / t.hd * s, h = t.img.height / t.hd * s;
  ctx.globalAlpha = a > 1 ? 1 : a;
  if (rot) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.drawImage(t.img, -w / 2, -h / 2, w, h); ctx.restore(); }
  else ctx.drawImage(t.img, x - w / 2, y - h / 2, w, h);
}
const DEFAULT_SKIN_COLS = DEFAULT_COLS;
function palette(ci) {
  const base = map.hasColours ? map.colours : (SK.colors || (DEFSK && DEFSK.colors) || DEFAULT_SKIN_COLS);
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
let bodyScratch = null;
function sliderColours(col) {
  const bm = (map && map.colourMap) || {}; // the beatmap's own slider colours win over the skin's, like in osu!
  const acc = bm.SliderTrackOverride || SK.trackColor || col, border = bm.SliderBorder || SK.borderColor || [255, 255, 255];
  return { border, outer: acc.map(v => v / 1.1), inner: acc.map(v => Math.min(255, v * 1.125 + 63.75)) };
}
function paintBody(g, path, r, cols, N = 14) {
  const sh = 5 / 64, bp = .128, start = sh + bp;
  g.lineCap = g.lineJoin = "round";
  // the shadow outside the border (osu!stable / lazer LegacySliderBody): black from 25% at the border fading to 0 at the
  // edge, as rings that stack up towards the border
  const K = 6, a = 1 - Math.pow(.75, 1 / K); g.strokeStyle = "rgba(0,0,0," + a + ")";
  if (S.sliderShadow !== false) for (let i = 0; i < K; i++) { g.lineWidth = 2 * r * (1 - sh * i / K); g.stroke(path); }
  g.strokeStyle = rgb(cols.border); g.lineWidth = 2 * r * (1 - sh); g.stroke(path);
  for (let i = 0; i < N; i++) {
    const k = i / (N - 1), p = start + (1 - start) * k;
    g.strokeStyle = rgb(mix(cols.outer, cols.inner, k)); g.lineWidth = Math.max(.5, 2 * r * (1 - p)); g.stroke(path);
  }
  g.globalCompositeOperation = "destination-out"; g.globalAlpha = .3; g.strokeStyle = "#000"; g.lineWidth = 2 * r * (1 - start); g.stroke(path);
  g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
}
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
    const src = `"use strict";const S={};const rgb=${rgb};const mix=${mix};${paintBody}
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
  else { c = bodyScratch || (bodyScratch = document.createElement("canvas")); if (c.width < cw || c.height < ch) { c.width = Math.max(c.width, cw); c.height = Math.max(c.height, ch); } }
  const g = c.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
  g.setTransform(sc, 0, 0, sc, -x0 * sc, -y0 * sc);
  const path = full ? o.p2d : new Path2D(); if (!full) tracePath(path, pts);
  if (pts.length === 1) path.lineTo(pts[0][0] + .01, pts[0][1]);
  paintBody(g, path, r, sliderColours(col), full ? 14 : 8); // fewer gradient steps while snaking (redrawn every frame)
  const res = { c, x: x0, y: y0, w: cw / sc, h: ch / sc, sw: cw, sh: ch };
  if (full) { bodyCache.set(key, res); if (bodyCache.size > 48) bodyCache.delete(bodyCache.keys().next().value); }
  return res;
}

// ============ storyboard sprite drawing ============
const sbTint = new Map();
const _1 = [0], _2 = [0, 0], _3 = [0, 0, 0];
let SBM = [1, 0, 0, 1, 0, 0]; // playfield transform, set once per frame
function drawSprite(s, t) {
  const B = s.byType;
  const o = B.F ? sbVal(B.F, t, _1)[0] : 1; if (o <= 0.003) return;
  let x = s.x, y = s.y;
  if (B.M) { sbVal(B.M, t, _2); x = _2[0]; y = _2[1]; }
  if (B.MX) x = sbVal(B.MX, t, _1)[0];
  if (B.MY) y = sbVal(B.MY, t, _1)[0];
  const sc = B.S ? sbVal(B.S, t, _1)[0] : 1;
  let vx = 1, vy = 1; if (B.V) { sbVal(B.V, t, _2); vx = _2[0]; vy = _2[1]; }
  if (!sc || !vx || !vy) return;
  const rot = B.R ? sbVal(B.R, t, _1)[0] : 0;
  let flipH = false, flipV = false, add = false;
  if (B.P) for (const c of B.P) {
    if (c.start === c.end ? t >= c.start : t >= c.start && t <= c.end) { if (c.v === "H") flipH = true; else if (c.v === "V") flipV = true; else if (c.v === "A") add = true; }
  }
  let fi = 0;
  if (s.frames.length > 1 && s.delay > 0) {
    fi = Math.floor((t - s.start) / s.delay);
    fi = s.loopOnce ? Math.min(Math.max(fi, 0), s.frames.length - 1) : ((fi % s.frames.length) + s.frames.length) % s.frames.length;
  }
  const key = s.frames[fi]; let img = images[key]; if (!img) return;
  if (B.C) {
    sbVal(B.C, t, _3);
    if (_3[0] < 250 || _3[1] < 250 || _3[2] < 250) {
      const q0 = Math.round(_3[0] / 8) * 8, q1 = Math.round(_3[1] / 8) * 8, q2 = Math.round(_3[2] / 8) * 8, k = key + "|" + q0 + "," + q1 + "," + q2;
      let c = sbTint.get(k);
      if (!c) { c = tintCanvas(img, [q0, q1, q2]); sbTint.set(k, c); if (sbTint.size > 240) sbTint.delete(sbTint.keys().next().value); }
      img = c;
    }
  }
  const w = img.width, h = img.height;
  ctx.setTransform(SBM[0], SBM[1], SBM[2], SBM[3], SBM[4], SBM[5]);
  ctx.globalAlpha = o > 1 ? 1 : o;
  ctx.globalCompositeOperation = add ? "lighter" : "source-over";
  ctx.translate(x, y); if (rot) ctx.rotate(rot);
  ctx.scale(sc * vx * (flipH ? -1 : 1), sc * vy * (flipV ? -1 : 1));
  ctx.drawImage(img, -s.origin[0] * w, -s.origin[1] * h);
}
