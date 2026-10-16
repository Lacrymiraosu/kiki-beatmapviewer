"use strict";
// ============ feature switches (Admin → Features) ============
// The admin can turn a function or a menu off for everyone at once (when something has a serious bug). The server tells every
// visitor which are off (GET /api/v1/me → features.off); an element with data-feat="key" is hidden while its key is off
// (a <style> built from the off keys, so menus built later are hidden too), and every entry point checks featOn(key) as well,
// because a hidden button alone is not "off". This is bug containment, not security: the server only refuses the
// server-backed ones (online projects, live, collab, osu! lookups; api/_lib/features.js).
// Keys must stay the same as FEATURE_KEYS in api/_lib/features.js (tests/features.test.mjs checks it). Labels are shown with tr().
const FEATS = [ // key, label, group
  ["songs", "Beatmap list", "site"], ["preview", "Preview player", "site"], ["mappers", "Mapper pages", "site"], ["editor", "Editor and modding", "site"],
  ["create", "New beatmap", "site"], ["projects", "Online projects", "site"], ["live", "Live sessions", "site"], ["collab", "Collab editing", "site"], ["drive", "Google Drive", "site"], ["replays", "Replays", "site"],
  ["ed_timing", "Timing tab", "editor"], ["ed_hitsounds", "Hitsounds tab", "editor"], ["ed_verify", "Verify tab", "editor"], ["ed_setup", "Setup tab", "editor"],
  ["ed_notes", "Mod notes tab", "editor"], ["ed_compare", "Compare tab", "editor"], ["ed_test", "Test play", "editor"], ["ed_auto", "Auto button", "editor"],
  ["ed_adv", "Advanced tools switch", "editor"], ["ed_tools", "Mapping tools sheet", "editor"], ["ed_share", "Share link button", "editor"], ["ed_annot", "Annotations", "editor"],
];
let FEAT_OFF = new Set(), featChanged = false, featFresh = false; // (featFresh: the server has answered on this page load; until then the remembered switches only hide things)
try { FEAT_OFF = new Set(JSON.parse(localStorage.getItem("obv-feat-off") || "[]").filter(k => FEATS.some(f => f[0] === k))); } catch {}
const featOn = k => !FEAT_OFF.has(k);
const featLabel = k => { const f = FEATS.find(x => x[0] === k); return f ? tr(f[1]) : k; };
// an entry point: false (with a note) while its feature is off
function featGuard(k) {
  if (featOn(k)) return true;
  toast(tr("{name} is switched off for now.", { name: featLabel(k) }), 2500);
  return false;
}
function featCss() {
  let st = document.getElementById("featCss");
  if (!st) { st = document.createElement("style"); st.id = "featCss"; document.head.append(st); }
  st.textContent = [...FEAT_OFF].map(k => `[data-feat~="${k}"]{display:none!important}`).join("\n");
}
featCss();

// me.features.off, from GET /api/v1/me. No answer (a preview, a site without its backend, offline) leaves things as they were.
function featSet(me) {
  if (!me || !me.features || !Array.isArray(me.features.off)) return;
  const off = new Set(me.features.off.filter(k => FEATS.some(f => f[0] === k)));
  featFresh = true;
  try { localStorage.setItem("obv-feat-off", JSON.stringify([...off])); } catch {}
  const changed = off.size !== FEAT_OFF.size || [...off].some(k => !FEAT_OFF.has(k));
  FEAT_OFF = off; featCss(); if (changed) featChanged = true;
  if (changed && typeof featRefresh === "function") featRefresh();
}
// did the answer change the switches since the page opened, or does the URL need one that is off (gate.js then shows the right page)
function featTake() { const c = featChanged || routeFeats(new URLSearchParams(location.search)).some(k => !featOn(k)); featChanged = false; return c; }
// parts built from code that need to follow a change (the tools sheet's tabs, the editor's tab strip)
function featRefresh() {
  if (typeof buildToolTabs === "function") { try { buildToolTabs(); } catch {} } // (cheap; built from the switches as they are now, open or not)
  if (typeof applyEdAdv === "function") { try { applyEdAdv(); } catch {} }
  if (typeof EDIT !== "undefined" && EDIT.on && EDIT.tab !== "compose" && !featOn("ed_" + EDIT.tab) && typeof edTab === "function") edTab("compose");
}
