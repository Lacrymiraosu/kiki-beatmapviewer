"use strict";
// ============ i18n ============
// Translations live in i18n/<lang>.json (one file per language, keyed by the English text; see i18n/README.md).
// Only the chosen language's file is downloaded; English needs none. Missing or empty entries fall back to English.
// osu! terms (circle, slider, spinner, BPM, SV, kiai, snap, stack, combo…) mostly stay in English, like the community uses them.
const LANG_SHORT = { ms: "Melayu", id: "Indonesia" };
const LANGS = [["en", "English"], ["th", "ไทย"], ["ms", "Bahasa Melayu"], ["id", "Bahasa Indonesia"], ["ko", "한국어"], ["ja", "日本語"]];
function detectLang() {
  for (const l of navigator.languages || [navigator.language || "en"]) {
    const c = String(l).toLowerCase().slice(0, 2);
    if (LANGS.some(x => x[0] === c)) return c;
    if (c === "in") return "id";
  }
  return "en";
}
let LANG = LANGS.some(l => l[0] === S.lang) ? S.lang : detectLang();
let I18N_DICT = {}, I18N_BOOTED = false;
// the files are cached like the scripts: same ?v= as this script's own URL
const I18N_V = (() => { try { return new URL(document.currentScript.src).searchParams.get("v") || ""; } catch { return ""; } })();
function loadLang(l) {
  if (l === "en") { I18N_DICT = {}; return Promise.resolve(); }
  return fetch(`i18n/${l}.json?v=${I18N_V}`).then(r => r.ok ? r.json() : null).catch(() => null).then(d => {
    if (LANG !== l || !d) return;
    I18N_DICT = d;
    if (I18N_BOOTED) i18nRefresh(); // arrived after the page was already shown in English
  });
}
// startup waits for the file (at most 2.5 s, then shows English and switches when it arrives)
const I18N_READY = Promise.race([loadLang(LANG), new Promise(r => setTimeout(r, 2500))]).then(() => { I18N_BOOTED = true; });
function tr(k, v) {
  let s = k;
  if (LANG !== "en") { const t = I18N_DICT[k]; if (t) s = t; }
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => v[n] != null ? v[n] : m);
  return s;
}
function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(e => e.textContent = tr(e.dataset.i18n));
  root.querySelectorAll("[data-i18n-ph]").forEach(e => { e.placeholder = kbdMod(tr(e.dataset.i18nPh)); if (e.dataset.i18nPhFit) phFit(e); });
  root.querySelectorAll("[data-i18n-aria]").forEach(e => e.setAttribute("aria-label", kbdMod(tr(e.dataset.i18nAria))));
  root.querySelectorAll("[data-i18n-title]").forEach(e => e.title = kbdMod(tr(e.dataset.i18nTitle))); // (kbdMod: "⌘S" on a Mac / iPad, device.js)
}
function fillLangSelects() {
  for (const id of ["langSel", "langSel2"]) {
    const s = $(id); if (!s) continue;
    s.innerHTML = ""; LANGS.forEach(([c, n]) => s.add(new Option(n, c))); s.value = LANG;
    s.onchange = () => setLang(s.value);
    // closed, the picker shows a short name (a narrow one cut both Bahasa names to "Bahasa"); open, the full names
    const names = full => [...s.options].forEach((o, k) => o.text = !full && o.selected && LANG_SHORT[o.value] || LANGS[k][1]);
    s.onpointerdown = s.onfocus = () => names(true); s.onblur = () => names(false); names(false);
  }
}
// data-i18n-ph-fit="shorter|shortest": the box shows the longest placeholder that fits its width (phones, long translations),
// checked again when the box is resized or shown and when the web font arrives
let PH_CTX = null;
const PH_RO = typeof ResizeObserver === "function" ? new ResizeObserver(es => es.forEach(x => phFit(x.target, true))) : null;
function phFit(e, resized) {
  if (!resized && PH_RO) PH_RO.observe(e);
  const opts = [e.dataset.i18nPh, ...e.dataset.i18nPhFit.split("|")].map(k => kbdMod(tr(k))), cs = getComputedStyle(e);
  const w = e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (!(w > 0)) return; // hidden: measured when it's shown
  PH_CTX = PH_CTX || document.createElement("canvas").getContext("2d");
  PH_CTX.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  e.placeholder = opts.find(s => PH_CTX.measureText(s).width <= w - 2) || opts[opts.length - 1];
}
if (document.fonts) { const refit = () => document.querySelectorAll("[data-i18n-ph-fit]").forEach(e => phFit(e, true)); document.fonts.ready.then(refit); document.fonts.addEventListener("loadingdone", refit); }
function i18nRefresh() { applyI18n(); fillLangSelects(); dispatchEvent(new Event("langchange")); }
async function setLang(l) {
  LANG = l; S.lang = l; save();
  document.documentElement.lang = l;
  await loadLang(l);
  if (LANG === l) i18nRefresh();
}

document.documentElement.lang = LANG;
applyI18n(); fillLangSelects();
