"use strict";
// ============ an old copy of the page running today's scripts ============
// The service worker keeps the last copy of the page for opening offline, and iOS Safari sometimes fails a page load
// for a moment (then that copy is shown). The copy's scripts (?v= of its version) may no longer be cached, and the
// server only has today's files whatever ?v= is asked for, so an old page ran new scripts and broke (e.g. "Can't find
// variable: kbdMod": pages before v221 don't load device.js). Seen here as: no device.js, or a page older than the
// newest version this browser has run. Then the copy is dropped and the page loaded again, once per session (a page
// that is still that version after the reload is the real one, e.g. after a rollback: it becomes the newest seen).
const STALE_PAGE = (() => {
  try {
    const s = document.querySelector('script[src*="js/core.js"]'), v = +((s && /[?&]v=(\d+)/.exec(s.getAttribute("src")) || [])[1] || 0);
    let seen = 0; try { seen = +localStorage.getItem("obv-ver") || 0; } catch {}
    const ver = n => { try { localStorage.setItem("obv-ver", String(n)); } catch {} };
    if (!(typeof DEV === "undefined" || (v && seen && v < seen))) { if (v > seen) ver(v); return false; }
    let tried = false; try { tried = sessionStorage.getItem("obv-stale") === String(v); sessionStorage.setItem("obv-stale", String(v)); } catch { tried = true; }
    if (tried) { if (v) ver(v); return false; } // (and no reload loop when the network really is gone)
    const go = () => location.reload();
    (self.caches ? caches.open("obv-v1").then(c => c.delete("/")) : Promise.resolve()).then(go, go);
    return true;
  } catch { return false; }
})();
// ============ utils ============
const $ = id => document.getElementById(id);
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const easeOut = k => 1 - (1 - k) * (1 - k);
const easeIO = k => k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
const rand = s => { const x = Math.sin(s * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const rgb = c => `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`;
const rgba = (c, a) => `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const fmt = s => (s = Math.max(0, s || 0), `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
// osu! editor timestamp: 01:23:456
// osu!'s time format with the fraction of a ms kept when there is one (timing points can sit between whole ms)
const fmtMsExact = ms => { const a = Math.abs(Math.round(ms * 1000) / 1000), i = Math.floor(a), f = Math.round((a - i) * 1000) / 1000; return (ms < 0 && a ? "-" : "") + fmtMs(i) + (f ? String(f).slice(1) : ""); };
// a time typed the way osu! shows it: "01:23:456" (also "1:23.456" in seconds, a modding timestamp "01:23:456 (1,2) -",
// or plain ms like "83456"); NaN when it isn't one
function parseOsuTime(str) {
  let s = String(str || "").trim(); const neg = s.startsWith("-"); if (neg) s = s.slice(1).trim();
  let m = s.match(/^(\d+):(\d{1,2}):(\d+(?:\.\d+)?)/), v = NaN;
  if (m) v = +m[1] * 60000 + +m[2] * 1000 + +m[3];
  else if ((m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/))) v = +m[1] * 60000 + +m[2] * 1000;
  else if (/^\d+(\.\d+)?$/.test(s)) v = +s;
  return neg ? -v : v;
}
const fmtMs = ms => { const neg = ms < 0; ms = Math.abs(Math.round(ms)); return (neg ? "-" : "") + String(Math.floor(ms / 60000)).padStart(2, "0") + ":" + String(Math.floor(ms / 1000) % 60).padStart(2, "0") + ":" + String(ms % 1000).padStart(3, "0"); };
const fmtBytes = b => b >= 1048576 ? (b / 1048576).toFixed(2) + " MB" : Math.round(b / 1024) + " KB";
const fmtNum = v => v === undefined || v === null || v === "" ? "?" : String(Math.round(+v * 10) / 10);
const fmtInt = n => n == null || isNaN(n) ? "?" : Number(n).toLocaleString("en-US");
const norm = p => String(p).replace(/\\/g, "/").replace(/^"|"$/g, "").trim().toLowerCase();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

// ============ device ============ (what kind of device: DEV and kbdMod, js/device.js)
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LOWEND = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3;
const TOUCH = DEV.coarse; // (at load: the wording of one-off hints)
const isIOS = () => DEV.webkitOnly; // iPhone / iPad (iPadOS included)
// iPhone / iPad grey out files of a type they don't know (.osz, .osk, .osu) when the picker is limited to them, so
// there the picker takes any file and the name is checked after it's picked (fileIs)
function fileAccept(input, accept) { if (DEV.webkitOnly) input.removeAttribute("accept"); else input.accept = accept; return input; }
const fileIs = (f, exts) => new RegExp("\\.(" + exts.join("|") + ")$", "i").test(f && f.name || "");

// ============ settings ============
const DEF = { lang: "", mirror: "nerinyan", skin: "default", sb: true, notes: true, cursor: true, hsSrc: "beatmap", hud: true, liveTop50: true, hitBar: true, hitBarSize: 40, top50Size: 70, urHud: true, earlyLate: true, fx: false, parallax: false, video: true, followPts: true,
  judge: false, snaking: true, snakingOut: true, sliderEnd: true, offset: 0, dim: 25, masterVol: 10, hsVol: 60, musVol: 80, quality: "auto", sbGL: "off", sbGLAsked: false, fpsHud: false, view: "lock16", overlay: false, metro: false, btMode: false, hsDelay: 0, offsetBt: null,
  snap: 4, grid: 0, ds: false, dsMul: 1, guides: true, sideNotes: false, sideAnns: false, gLine: true, gAngle: true, gPlace: true, gRings: true, notePrefix: "", noteSuffix: "", replyQuote: false, sliderShadow: true, edStack: true, edOutside: false, edDim: 60, edSampleName: false, gameMode: 0, edHitMarkers: true, gdAuto: true, fps: 50, tlZoom: .25, tlLock: false,
  vfyAuto: true, vfyWait: true, cmpBefore: 40, cmpBeforeCol: "#ff4d5e", cmpAfter: 100, edAdv: false, stDiv: 4, stStart: 1, stEnd: 1, stEase: "linear", stNC: true, stLen: 1, pivot: "sel", trRot: 0, trScale: 1, polyN: 5, polyR: 100, polyRot: 0, polyRep: 1,
  edTour: true, edTourSeen: 0, edTourAdvSeen: 0, edTourSnooze: 0, edTourAdvSnooze: 0, // (the editor tour, edtour.js: the switch syncs, the rest is per device)
  skinCombo: "map", curSize: 1, curTrail: true, curRotate: "skin", curExpand: "skin", ballTint: "skin", ballFlip: "skin", hcOverlay: "skin", hcNumbers: true, elBurst: true, elApproach: true, objOpacity: 1, homeSkin: false, skinAnim: true, skinSounds: true }; // (Settings → Skin: validated by cleanSkinOpts below)
const FPS_OPTS = [30, 50, 60, 120, 240];
// Settings → Skin: kind "b" = switch, "e" = one of the listed words, "n" = number clamped to min..max (and rounded to `step`).
// Anything else (a hand-edited setting, a value synced from an account on another version) falls back to the default.
//<skin-opts>
const SKIN_OPTS = {
  skinCombo: ["e", ["map", "skin"]], curSize: ["n", .5, 2, .05], curTrail: ["b"], curRotate: ["e", ["skin", "on", "off"]], curExpand: ["e", ["skin", "on", "off"]],
  ballTint: ["e", ["skin", "on", "off"]], ballFlip: ["e", ["skin", "on", "off"]], hcOverlay: ["e", ["skin", "above", "below"]], hcNumbers: ["b"],
  elBurst: ["b"], elApproach: ["b"], objOpacity: ["n", .3, 1, .05], homeSkin: ["b"], skinAnim: ["b"], skinSounds: ["b"],
};
function cleanSkinOpts(o) {
  for (const k in SKIN_OPTS) {
    const [kind, a, b, step] = SKIN_OPTS[k], v = o[k];
    if (kind === "b") { if (typeof v !== "boolean") o[k] = DEF[k]; }
    else if (kind === "e") { if (!a.includes(v)) o[k] = DEF[k]; }
    else { const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? +v : NaN; o[k] = isFinite(x) ? Math.round(Math.max(a, Math.min(b, x)) / step) * step : DEF[k]; o[k] = +o[k].toFixed(2); }
  }
  return o;
}
//</skin-opts>
const S = { ...DEF };
let savedS = {};
try { savedS = JSON.parse(localStorage.getItem("obv-settings") || "{}") || {}; } catch {}
Object.assign(S, savedS);
cleanSkinOpts(S);
S.sbGL = S.sbGL === "on" ? "on" : "off"; // (Settings → Screen and performance: the storyboard drawn by WebGL, off until it's picked)
S.top50Size = (x => isFinite(x) ? Math.max(40, Math.min(150, Math.round(x / 5) * 5)) : DEF.top50Size)(typeof S.top50Size === "number" ? S.top50Size : NaN); // (the replay's live Top 50 board's size in %)
S.hitBarSize = (x => isFinite(x) ? Math.max(20, Math.min(150, Math.round(x / 5) * 5)) : DEF.hitBarSize)(typeof S.hitBarSize === "number" ? S.hitBarSize : NaN); // (the replay hit error bar's size in %)
if (S.hitsound === false) S.hsSrc = "off";
delete S.hitsound;
delete S.gameMode; delete S.maniaSpeed; delete S.maniaEdSV; // (osu!mania is gone: the site is osu!standard only)
if (!("parallax" in savedS) && savedS.fx === false) S.parallax = false; // the old single "effects" toggle covered both
if (!/^(default|retro|osk:.+)$/.test(S.skin)) S.skin = "default";  // the old hand-drawn skins are gone
if ((savedS.mirrorDefV || 0) < 2) { if (S.mirror === "osudirect") S.mirror = "nerinyan"; S.mirrorDefV = 2; } // Nerinyan is the default mirror (always the newest copy): who still had the old default moves with it; a mirror picked since stays
if ((savedS.skinDefV || 0) < 3) S.skinDefV = 3; // osu! default is the site default
if ((savedS.fxDefV || 0) < 1) { S.fx = false; S.parallax = false; S.fxDefV = 1; } // kiai effects and background parallax are off by default now (Settings → Display)
if (!FPS_OPTS.includes(+S.fps)) S.fps = 50;
if (!savedS.volV) { S.masterVol = 10; S.volV = 1; } // master volume added (10% by default)
// the live tour on the invite page runs the app in a frame (demo.js): it never saves anything there
// and the playable demo editor (demo=try) the same way
const DEMO_TRY = new URLSearchParams(location.search).get("demo") === "try";
const DEMO_TOUR = DEMO_TRY || new URLSearchParams(location.search).get("demo") === "tour";
const writeS = () => { if (DEMO_TOUR) return; try { localStorage.setItem("obv-settings", JSON.stringify(S)); } catch {} if (typeof prefsQueue === "function") prefsQueue(); }; // (account.js: settings sync)
let saveTimer = 0;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeS, 250); };
addEventListener("pagehide", writeS);

// header popovers (volume, account) open right under their button, right edges lined up, kept on screen
function placePop(pop, btn) {
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, vw = document.documentElement.clientWidth;
  const left = Math.max(12, Math.min(vw - w - 12, r.right - w));
  pop.style.left = left + "px"; pop.style.right = "auto"; pop.style.top = (r.bottom + 8) + "px";
  pop.style.setProperty("--ax", Math.max(16, Math.min(w - 16, r.left + r.width / 2 - left)) + "px");
}
addEventListener("resize", () => { for (const [p, b] of [["volPop", "volBtn"], ["acctPop", "acctBtn"]]) { const el = $(p); if (el && !el.hidden) placePop(el, $(b)); } });
// in the player the toast sits above the bottom bar (and the editor's tool row over it on phones), not over the controls
function toastLift() {
  const p = $("player"); if (!p || p.hidden) return "";
  let top = innerHeight;
  for (const e of [document.querySelector(".bar.bottom"), $("edRight")]) {
    if (!e || !e.getClientRects().length || e.closest(".hide") || e === $("edRight") && getComputedStyle(e).flexDirection !== "row") continue;
    top = Math.min(top, e.getBoundingClientRect().top);
  }
  return top < innerHeight ? Math.round(innerHeight - top + 10) + "px" : "";
}
function toast(t, ms = 3000) {
  const el = $("toast"); el.textContent = t; el.style.bottom = toastLift(); el.classList.add("on");
  requestAnimationFrame(() => el.style.bottom = toastLift()); // (again once a bar that was just shown, e.g. entering Modding, is laid out)
  clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.remove("on"), ms);
}
// rows that scroll sideways (tabs, chips, the editor's tool rows) fade out at an end with more behind it, so it shows
// that they scroll (checked on scroll, on resize and once a second for rows whose content changed)
const SFADE = ".chips,.moderow,.edtabs,.edcol,.tabs,.qtypes,.edinfo,.vfynav,.anav,.gchaps", sfadeSeen = new WeakSet();
const sfadeRO = new ResizeObserver(es => es.forEach(e => sfadeSet(e.target)));
function sfadeSet(el) {
  const max = el.scrollWidth - el.clientWidth, x = Math.abs(el.scrollLeft); // (scrollLeft is negative right-to-left)
  el.classList.toggle("sfl", max > 1 && x > 1); el.classList.toggle("sfr", max > 1 && x < max - 1);
}
function sfadeScan() {
  if (document.hidden) return;
  for (const el of document.querySelectorAll(SFADE)) { if (!sfadeSeen.has(el)) { sfadeSeen.add(el); sfadeRO.observe(el); } if (el.offsetParent) sfadeSet(el); }
}
document.addEventListener("scroll", e => { const el = e.target; if (el.nodeType === 1 && el.matches(SFADE)) sfadeSet(el); }, { capture: true, passive: true });
setInterval(sfadeScan, 1000); requestAnimationFrame(sfadeScan);
const setStatus = t => $("status").textContent = t || "";
const setTitle = t => document.title = t ? `${t} · KIKI Beatmap Viewer` : "KIKI Beatmap Viewer: " + tr("preview and edit osu! beatmaps online"); // (the home page; api/og.js gives the same titles)

// ============ volume (music + hitsound), shared by home, detail and player ============
const audio = $("audio");
const prevAudio = new Audio(); prevAudio.preload = "none";
// iPhone / iPad ignore an <audio>'s volume (it always plays at full volume, reading it gives 1): there the previews
// play through Web Audio instead, where a gain node follows the site volume (app.js, song previews)
const VOL_FIXED = DEV.webkitOnly || (() => { try { const a = new Audio(); a.volume = .5; return Math.abs(a.volume - .5) > .01; } catch { return false; } })();
let pvGain = null;
// master scales music and hitsounds (and previews / metronome)
const musGain = () => S.musVol / 100 * S.masterVol / 100;
const hsGain = () => S.hsVol / 100 * S.masterVol / 100;
function applyVolumes() {
  const mv = musGain();
  if (A.gain) A.gain.gain.value = mv;
  if (pvGain) pvGain.gain.value = mv;
  audio.volume = mv; prevAudio.volume = mv;
}
const VOL_KEYS = [["masterVol", "Master"], ["musVol", "Music"], ["hsVol", "Hitsound"]];
function volControl(only) { // only: one key ("masterVol") to draw just that slider (the beatmap detail keeps Master only); none: all three
  const box = h("div", "volc");
  for (const [k, label] of VOL_KEYS) {
    if (only && k !== only) continue;
    const row = h("label", "vrow"), inp = h("input"), out = h("output", null, S[k] + "%"), lab = h("span", null, tr(label));
    lab.dataset.i18n = label;
    inp.type = "range"; inp.min = 0; inp.max = 100; inp.value = S[k]; inp.dataset.vol = k;
    inp.setAttribute("aria-label", tr(label)); inp.dataset.i18nAria = label;
    inp.addEventListener("input", () => { S[k] = +inp.value; save(); syncVol(inp); applyVolumes(); });
    if (k !== "musVol") inp.addEventListener("change", () => previewHit());
    row.append(lab, inp, out);
    box.append(row);
  }
  return box;
}
function syncVol(except) {
  document.querySelectorAll("input[data-vol]").forEach(i => {
    if (i !== except) i.value = S[i.dataset.vol];
    i.nextElementSibling.textContent = S[i.dataset.vol] + "%";
  });
}
// the volume changed in another tab of the site (the player in one, the beatmaps in another): follow it here too
addEventListener("storage", e => {
  if (e.key !== "obv-settings" || !e.newValue) return;
  let n; try { n = JSON.parse(e.newValue) || {}; } catch { return; }
  let ch = false;
  for (const [k] of VOL_KEYS) if (typeof n[k] === "number" && n[k] !== S[k]) { S[k] = n[k]; ch = true; }
  if (ch) { syncVol(); applyVolumes(); }
});

// ============ lazy scripts (parts of the site few visitors use load on first need, e.g. the admin dashboard) ============
// One promise per file (a second <script> would redeclare its top-level consts). The link carries the same ?v= as core.js,
// so a new version is a new link and the service worker's copy stays in step. A failed load can be tried again.
const LAZY = {};
let ADM_HINT = null; // the admin tab to open first (set by the account menu, used when admin.js has loaded)
function loadLazy(name) {
  return LAZY[name] || (LAZY[name] = new Promise((res, rej) => {
    const c = document.querySelector('script[src*="js/core.js"]'), v = (c && /[?&]v=(\d+)/.exec(c.getAttribute("src")) || [])[1];
    const s = document.createElement("script");
    s.src = `js/${name}.js` + (v ? `?v=${v}` : "");
    s.onload = () => res();
    s.onerror = () => { s.remove(); delete LAZY[name]; rej(new Error(tr("Couldn't load this part of the site, check your connection"))); };
    document.head.append(s);
  }));
}

// ============ lazy JSZip (only needed once a .osz/.osk is opened) ============
let jszipP = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return jszipP || (jszipP = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    // SRI: cdnjs's published hash for this exact file (the CSP also only allows this library's path)
    s.integrity = "sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==";
    s.crossOrigin = "anonymous";
    s.onload = () => res(window.JSZip);
    s.onerror = () => { jszipP = null; rej(new Error(tr("Couldn't load JSZip, check your internet connection"))); };
    document.head.append(s);
  }));
}

// ============ clipboard / share ============
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  const ta = h("textarea"); ta.value = t; ta.style.cssText = "position:fixed;opacity:0;top:0";
  document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  ta.remove(); return ok;
}
async function shareLink(url, title) {
  if (!url) { toast(tr("This file has no beatmap ID, so it can't be shared as a link")); return; }
  if (navigator.share && TOUCH) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  toast(await copyText(url) ? tr("Link copied") : url);
}
function downloadBlob(blob, name) {
  const u = URL.createObjectURL(blob), a = h("a");
  a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}

// ---------- the page under an overlay stays put ----------
// pageLock(owner, on): while any owner holds it (the beatmap detail panel, a pop-up, ...) the page (the window) doesn't scroll by wheel,
// keys or touch. A set of owners, not a counter: saying the same thing twice changes nothing, so a state that is synced again and again
// can't drift, and two overlays can't unlock each other. The scrollbar that goes away leaves its room (as padding: the cards don't move); scrollY,
// the sticky search bar and the list's observers are untouched (the layout doesn't change). Touch: see the touchmove guard below.
// pageLock:start
function lockOwners(set, owner, on) { if (on) set.add(owner); else set.delete(owner); return set.size > 0; }
const PLOCK = new Set();
function pageLock(owner, on) {
  const was = PLOCK.size > 0, now = lockOwners(PLOCK, owner, on), r = document.documentElement;
  if (was === now) return now;
  if (now) { const g = Math.max(0, innerWidth - r.clientWidth); r.style.setProperty("--plg", g + "px"); r.classList.toggle("plockg", g > 0); r.classList.add("plock"); } // (plockg: a classic scrollbar was there, its room is kept)
  else { r.classList.remove("plock", "plockg"); r.style.removeProperty("--plg"); }
  return now;
}
// pageLock:end
// touch (iOS Safari can still pan a page whose overflow is hidden, and a scroller at its end hands the pan on to the page): while the page is
// locked, a move that no scroller under the finger can take (on that axis, in that direction) is cancelled. Fields keep their own drags
// (the volume slider), two fingers keep zooming.
{
  let lx = 0, ly = 0;
  const canTake = (t, dx, dy) => {
    const v = Math.abs(dy) >= Math.abs(dx);
    for (let e = t && t.nodeType === 1 ? t : t && t.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e), o = v ? cs.overflowY : cs.overflowX; if (o !== "auto" && o !== "scroll") continue;
      if (v ? (dy > 0 ? e.scrollTop > 0 : e.scrollTop + e.clientHeight < e.scrollHeight - 1) : (dx > 0 ? e.scrollLeft > 0 : e.scrollLeft + e.clientWidth < e.scrollWidth - 1)) return true;
    }
    return false;
  };
  addEventListener("touchstart", e => { if (e.touches.length) { lx = e.touches[0].clientX; ly = e.touches[0].clientY; } }, { passive: true, capture: true });
  addEventListener("touchmove", e => {
    if (!PLOCK.size || e.touches.length !== 1) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY, dx = x - lx, dy = y - ly; lx = x; ly = y;
    if (!e.cancelable || (!dx && !dy) || (e.target.closest && e.target.closest("input,select,textarea"))) return;
    if (!canTake(e.target, dx, dy)) e.preventDefault();
  }, { passive: false, capture: true });
}
// the site's own pop-up (never the browser's alert / confirm / prompt):
// modal({ title, body: Node | text, buttons: [{ label, value, cls }], dismiss, icon, wide }) -> Promise<value>
// Esc / tapping outside answers `dismiss` (not allowed when dismiss is undefined). A button whose value is a function
// answers what it returns, or keeps the pop-up open when it returns undefined (e.g. a field that isn't valid yet).
// icon: "ask" | "danger" | "edit" | "info" (a badge above the title). Enter in askText's field presses the main button.
const MDL_ICONS = { ask: "?", danger: "!", warn: "!", edit: "✎", info: "i" };
function modal({ title, body, buttons, dismiss, wide, icon, focus, variant }) {
  return new Promise(res => {
    const back = document.activeElement, wrap = h("div", "mdl" + (variant ? " v-" + variant : "")), panel = h("div", "mdlp" + (wide ? " wide" : "") + (icon ? " has-ic ic-" + icon : ""));
    panel.setAttribute("role", icon === "danger" || icon === "warn" ? "alertdialog" : "dialog"); panel.setAttribute("aria-modal", "true");
    if (icon && MDL_ICONS[icon]) { const b = h("div", "mdlic", MDL_ICONS[icon]); b.setAttribute("aria-hidden", "true"); panel.append(b); }
    const uid = "mdl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (title) { const t = h("h3", "mdlt", title); t.id = uid + "t"; panel.setAttribute("aria-labelledby", t.id); panel.append(t); }
    if (body != null) { const b = typeof body === "string" ? mdlText(body) : body; if (!b.id) b.id = uid + "b"; panel.setAttribute("aria-describedby", b.id); panel.append(b); }
    const row = h("div", "btnrow mdlbtns" + ((buttons || []).length > 2 ? " many" : ""));
    let closed = false; const lk = {}; pageLock(lk, true); // (the page under it doesn't scroll; its own owner: a pop-up over the detail panel doesn't unlock the panel's hold)
    const done = v => {
      if (closed) return; closed = true; removeEventListener("keydown", key, true); pageLock(lk, false);
      wrap.classList.add("out"); setTimeout(() => wrap.remove(), variant ? 300 : 160); // (a variant has its own way out, assets/app.css)
      if (back && back.focus && back.isConnected) try { back.focus({ preventScroll: true }); } catch {}
      res(v);
    };
    const press = b => { const v = typeof b.value === "function" ? b.value() : b.value; if (v !== undefined) done(v); };
    let main = null;
    for (const b of buttons || [{ label: tr("OK"), value: true, cls: "main" }]) {
      const el = h("button", "btn " + (b.cls || "ghost"), b.label); el.type = "button"; el.onclick = () => press(b); row.append(el);
      if (/\b(main|danger)\b/.test(b.cls || "")) main = { el, b };
    }
    const key = e => {
      if (e.key === "Escape" && dismiss !== undefined) { e.preventDefault(); e.stopPropagation(); done(dismiss); }
      else if (e.key === "Enter" && main && e.target && e.target.classList && e.target.classList.contains("mdlin") && panel.contains(e.target)) { e.preventDefault(); e.stopPropagation(); press(main.b); }
      else if (e.key === "Tab") { // (focus stays inside the pop-up)
        const f = [...panel.querySelectorAll("button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return; const a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    wrap.addEventListener("keydown", e => e.stopPropagation()); // (keys typed in the pop-up don't reach the editor's shortcuts)
    wrap.onclick = e => { if (e.target === wrap && dismiss !== undefined) done(dismiss); };
    addEventListener("keydown", key, true);
    panel.append(row); wrap.append(panel); document.body.append(wrap);
    const f = focus || row.querySelector(".btn.main") || row.querySelector(".btn:not(.danger)") || row.querySelector(".btn");
    f && f.focus({ preventScroll: true }); if (f && f.select) f.select();
  });
}
// a message as paragraphs (blank lines split them)
function mdlText(text) { const d = h("div", "mdlb"); for (const para of String(text).split(/\n{2,}/)) { const p = h("p"); para.split("\n").forEach((l, k) => { if (k) p.append(h("br")); p.append(l); }); d.append(p); } return d; }
// yes / no: ask(message, { title, ok, cancel, danger }) -> Promise<boolean>. danger: a red button, and Cancel has the focus
function ask(message, { title, ok, cancel, danger } = {}) {
  return modal({ title, body: message, icon: danger ? "danger" : "ask", dismiss: false,
    buttons: [{ label: cancel || tr("Cancel"), value: false, cls: "ghost" + (danger ? " mdlsafe" : "") }, { label: ok || tr("OK"), value: true, cls: danger ? "danger solid" : "main" }],
  }).then(v => !!v);
}
// a short answer: askText(message, value, { title, ok, type: "text" | "number", min, max, placeholder }) -> Promise<string | null>
function askText(message, value = "", { title, ok, type = "text", min, max, placeholder } = {}) {
  const box = h("div", "mdlb"), inp = h("input", "mdlin"), err = h("p", "mdlerr");
  if (message) box.append(...mdlText(message).childNodes);
  inp.type = "text"; inp.autocomplete = "off"; if (type === "number") inp.inputMode = "decimal";
  inp.value = value == null ? "" : String(value); if (placeholder) inp.placeholder = placeholder; inp.spellcheck = false;
  inp.setAttribute("aria-label", title || String(message || "").split("\n")[0].slice(0, 80));
  err.hidden = true; err.setAttribute("role", "alert"); box.append(inp, err);
  const bad = t => { err.textContent = t; err.hidden = false; inp.classList.add("bad"); inp.focus(); return undefined; };
  inp.oninput = () => { err.hidden = true; inp.classList.remove("bad"); };
  const check = () => {
    const v = inp.value.trim();
    if (type !== "number") return inp.value;
    if (!v || !isFinite(+v)) return bad(tr("Enter a number"));
    if (min != null && +v < min) return bad(tr("At least {n}", { n: min }));
    if (max != null && +v > max) return bad(tr("At most {n}", { n: max }));
    return v;
  };
  return modal({ title, body: box, icon: "edit", dismiss: null, focus: inp,
    buttons: [{ label: tr("Cancel"), value: null }, { label: ok || tr("OK"), value: check, cls: "main" }] });
}
const fmtDate = (d, withTime = true) => { const x = new Date(d); return isNaN(x) ? "" : x.toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }); };

// ============ error reports ============
// When the site breaks in this browser (an error in the site's own code), send a short report so the admins see it in
// Admin → Errors. Only the error, where it happened in our code, the kind of page (not its link), the site's version and
// the browser family; nothing about the person. Each error at most once a day per browser, at most 5 per page load.
const ERR_SENT = new Set();
function errReport(message, stack, source) {
  if (STALE_PAGE) return; // (an old copy of the page being replaced: its errors aren't the site's)
  try {
    message = String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const here = location.origin, clean = t => String(t || "").split(here).join("").replace(/\?v=\d+/g, "").replace(/blob:[^\s)]+/g, "blob:…").slice(0, 2000);
    stack = clean(stack); source = clean(source);
    if (!message || /^Script error\.?$|ResizeObserver loop|AbortError|The operation was aborted|Failed to fetch|NetworkError|Load failed|Network request failed|play\(\) request was interrupted|NotAllowedError/i.test(message)) return;
    if (!/\/js\/[\w-]+\.js/.test(stack + " " + source)) return; // (only errors in the site's own scripts, not extensions or other sites)
    const key = message + "|" + source; if (ERR_SENT.has(key) || ERR_SENT.size >= 5) return; ERR_SENT.add(key);
    let sent = {}; try { sent = JSON.parse(localStorage.getItem("obv-errsent") || "{}") || {}; } catch {}
    const day = new Date().toISOString().slice(0, 10), h = [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7).toString(36);
    if (sent[h] === day) return;
    for (const k of Object.keys(sent)) if (sent[k] !== day) delete sent[k];
    sent[h] = day; try { localStorage.setItem("obv-errsent", JSON.stringify(sent)); } catch {}
    fetch("/api/v1/errors", { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true, body: JSON.stringify({ message, stack, source, ...siteContext() }) }).catch(() => {});
  } catch {}
}
// the kind of page (not its link), the site's version and the browser family: sent with error reports and "Report a problem"
function siteContext() {
  const q = new URLSearchParams(location.search), kind = ["s", "b", "u", "live", "collab", "project", "invite"].find(k => q.has(k));
  const page = (document.body && document.body.classList.contains("gated") ? "gate:" : "") + (q.get("view") || (kind ? "?" + kind : "home"));
  // (the browser family, system, touch screen and installed app only: never the full user agent; see the Privacy page)
  const browser = ({ edge: "Edge", firefox: "Firefox", opera: "Opera", chrome: "Chrome", safari: "Safari", samsung: "Samsung Internet" }[DEV.browser] || "Other")
    + ({ ios: " · iOS", ipados: " · iOS", android: " · Android", windows: " · Windows", mac: " · macOS", linux: " · Linux", chromeos: " · ChromeOS" }[DEV.os] || "")
    + (DEV.coarse ? " · touch" : "") + (DEV.standalone ? " · app" : "");
  const s = document.querySelector('script[src*="js/core.js"]'), version = (s && /[?&]v=(\d+)/.exec(s.getAttribute("src")) || [])[1] || "";
  return { page, version, browser };
}
addEventListener("error", e => { if (e.error || e.message) errReport(e.message || (e.error && e.error.message), e.error && e.error.stack, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ""); });
addEventListener("unhandledrejection", e => { const r = e.reason; if (r instanceof Error) errReport(r.name && r.name !== "Error" ? `${r.name}: ${r.message}` : r.message, r.stack, ""); });

// a preview build (Cloudflare's preview URL of a branch or version, e.g. feature-x-osu-beatmap-viewer.….workers.dev)
// says so in a corner, so it isn't mistaken for the live site
if (/\.workers\.dev$/.test(location.hostname) && !/^osu-beatmap-viewer\./.test(location.hostname)) {
  const b = document.createElement("div"); b.className = "previewbadge"; b.textContent = "Preview";
  b.title = location.hostname.replace(/-osu-beatmap-viewer\..*$/, ""); document.body.append(b);
}
