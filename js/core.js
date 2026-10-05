"use strict";
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

// ============ device ============
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LOWEND = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3;
const TOUCH = matchMedia("(pointer: coarse)").matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
// iPhone / iPad grey out files of a type they don't know (.osz, .osk, .osu) when the picker is limited to them, so
// there the picker takes any file and the name is checked after it's picked (fileIs)
function fileAccept(input, accept) { if (isIOS()) input.removeAttribute("accept"); else input.accept = accept; return input; }
const fileIs = (f, exts) => new RegExp("\\.(" + exts.join("|") + ")$", "i").test(f && f.name || "");

// ============ settings ============
const DEF = { lang: "", mirror: "osudirect", skin: "default", sb: true, notes: true, cursor: true, hsSrc: "beatmap", hud: true, fx: false, parallax: false, video: true, followPts: true,
  judge: false, snaking: true, snakingOut: true, sliderEnd: true, offset: 0, dim: 25, masterVol: 10, hsVol: 60, musVol: 80, quality: "auto", view: "lock16", overlay: false, metro: false, btMode: false, hsDelay: 0, offsetBt: null,
  snap: 4, grid: 0, ds: false, dsMul: 1, guides: true, sideNotes: false, sideAnns: false, gLine: true, gAngle: true, gPlace: true, gRings: true, notePrefix: "", noteSuffix: "", replyQuote: false, maniaSpeed: 8, maniaEdSV: false, sliderShadow: true, edStack: true, edDim: 60, edSampleName: false, gameMode: 0, edHitMarkers: true, gdAuto: true, fps: 50, tlZoom: .25, tlLock: false,
  vfyAuto: true, vfyWait: true, cmpGhostA: 70, stDiv: 4, stStart: 1, stEnd: 1, stEase: "linear", stNC: true, stLen: 1, pivot: "sel", trRot: 0, trScale: 1, polyN: 5, polyR: 100, polyRot: 0, polyRep: 1 };
const FPS_OPTS = [30, 50, 60, 120, 240];
const S = { ...DEF };
let savedS = {};
try { savedS = JSON.parse(localStorage.getItem("obv-settings") || "{}") || {}; } catch {}
Object.assign(S, savedS);
if (S.hitsound === false) S.hsSrc = "off";
delete S.hitsound;
if (!("parallax" in savedS) && savedS.fx === false) S.parallax = false; // the old single "effects" toggle covered both
if (!/^(default|retro|osk:.+)$/.test(S.skin)) S.skin = "default";  // the old hand-drawn skins are gone
if ((savedS.mirrorDefV || 0) < 1) { if (S.mirror === "nerinyan") S.mirror = "osudirect"; S.mirrorDefV = 1; } // osu.direct is the default mirror now
if ((savedS.skinDefV || 0) < 3) { S.skinDefV = 3; } // osu! default is the site default
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
const setTitle = t => document.title = t ? `${t} · KIKI BEATMAP VIEWER` : "KIKI BEATMAP VIEWER";

// ============ volume (music + hitsound), shared by home, detail and player ============
const audio = $("audio");
const prevAudio = new Audio(); prevAudio.preload = "none";
// master scales music and hitsounds (and previews / metronome)
const musGain = () => S.musVol / 100 * S.masterVol / 100;
const hsGain = () => S.hsVol / 100 * S.masterVol / 100;
function applyVolumes() {
  const mv = musGain();
  if (A.gain) A.gain.gain.value = mv;
  audio.volume = mv; prevAudio.volume = mv;
}
const VOL_KEYS = [["masterVol", "Master"], ["musVol", "Music"], ["hsVol", "Hitsound"]];
function volControl() {
  const box = h("div", "volc");
  for (const [k, label] of VOL_KEYS) {
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

// ============ lazy JSZip (only needed once a .osz/.osk is opened) ============
let jszipP = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return jszipP || (jszipP = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
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

// the site's own pop-up (never the browser's alert / confirm / prompt):
// modal({ title, body: Node | text, buttons: [{ label, value, cls }], dismiss, icon, wide }) -> Promise<value>
// Esc / tapping outside answers `dismiss` (not allowed when dismiss is undefined). A button whose value is a function
// answers what it returns, or keeps the pop-up open when it returns undefined (e.g. a field that isn't valid yet).
// icon: "ask" | "danger" | "edit" | "info" (a badge above the title). Enter in askText's field presses the main button.
const MDL_ICONS = { ask: "?", danger: "!", warn: "!", edit: "✎", info: "i" };
function modal({ title, body, buttons, dismiss, wide, icon, focus }) {
  return new Promise(res => {
    const back = document.activeElement, wrap = h("div", "mdl"), panel = h("div", "mdlp" + (wide ? " wide" : "") + (icon ? " has-ic ic-" + icon : ""));
    panel.setAttribute("role", icon === "danger" || icon === "warn" ? "alertdialog" : "dialog"); panel.setAttribute("aria-modal", "true");
    if (icon && MDL_ICONS[icon]) { const b = h("div", "mdlic", MDL_ICONS[icon]); b.setAttribute("aria-hidden", "true"); panel.append(b); }
    const uid = "mdl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (title) { const t = h("h3", "mdlt", title); t.id = uid + "t"; panel.setAttribute("aria-labelledby", t.id); panel.append(t); }
    if (body != null) { const b = typeof body === "string" ? mdlText(body) : body; if (!b.id) b.id = uid + "b"; panel.setAttribute("aria-describedby", b.id); panel.append(b); }
    const row = h("div", "btnrow mdlbtns" + ((buttons || []).length > 2 ? " many" : ""));
    let closed = false;
    const done = v => {
      if (closed) return; closed = true; removeEventListener("keydown", key, true);
      wrap.classList.add("out"); setTimeout(() => wrap.remove(), 160);
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
  const ua = navigator.userAgent, browser = (/Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Other")
    + (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? " · iOS" : /Android/.test(ua) ? " · Android" : /Windows/.test(ua) ? " · Windows" : /Mac OS X/.test(ua) ? " · macOS" : /Linux/.test(ua) ? " · Linux" : "")
    + (matchMedia("(pointer:coarse)").matches ? " · touch" : "") + (matchMedia("(display-mode: standalone)").matches ? " · app" : "");
  const s = document.querySelector('script[src*="js/core.js"]'), version = (s && /[?&]v=(\d+)/.exec(s.getAttribute("src")) || [])[1] || "";
  return { page, version, browser };
}
addEventListener("error", e => { if (e.error || e.message) errReport(e.message || (e.error && e.error.message), e.error && e.error.stack, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ""); });
addEventListener("unhandledrejection", e => { const r = e.reason; if (r instanceof Error) errReport(r.name && r.name !== "Error" ? `${r.name}: ${r.message}` : r.message, r.stack, ""); });
