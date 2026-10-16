"use strict";
// ============ player controls ============
const UI = {
  player: $("player"), ui: $("ui"), sheet: $("sheet"), tools: $("tools"), tapStart: $("tapStart"), skip: $("skip"),
  seek: $("seek"), tCur: $("tCur"), tDur: $("tDur"), play: $("play"), playPath: $("playPath"), spd: $("spd"), tl: $("tl"), edTime: $("edTime"),
};
let needTapResume = false, startAt = 0, cardStart = -1e9, skipEnd = false; // (skipEnd: the Skip button is the replay's "to the results" one, not the intro's)
function onSongEnd() { keepAwake(false); if (RP.on) return rpFinish(); if (typeof PLAY !== "undefined" && PLAY.on) return playStop(true); showUI(); dirty = true; }
audio.onerror = () => {
  if (A.mode !== "el" || !A.src || audio.src !== A.src) return;
  const wasPlaying = isPlaying(); A.mode = "virt"; A.pos = 0; A.on = false;
  toast(tr("This browser can't play the song of this map, playing without sound"));
  if (wasPlaying && !clock.pre) A.play();
  dirty = true;
};
audio.onended = () => { keepAwake(false); showUI(); dirty = true; rpFinish(); };
audio.onloadedmetadata = () => drawTimeline();
function onPlayBlocked(e) {
  if (e && e.name === "AbortError") return;
  clock.pre = false; needTapResume = true;
  $("tapInfo").textContent = tr("The browser blocked autoplay, tap again to play");
  UI.tapStart.hidden = false; dirty = true;
}
function startFromTop() {
  if (!map) return;
  UI.tapStart.hidden = true; needTapResume = false;
  ensureAudioCtx();
  if (startAt > 0) { // opened from a link with ?t=
    A.seek(startAt); startAt = 0;
    A.play().catch(onPlayBlocked); lastT = null; keepAwake(true); showUI(); return;
  }
  cardStart = performance.now();
  A.seek(0);
  const sbStart = Math.min(0, sb.minStart || 0);
  const lead = Math.min(5000, Math.max(0, +(map.general.AudioLeadIn || 0), map.hit.length ? map.preempt + 400 - map.first : 0, -sbStart));
  if (lead > 0) {
    // unlock the audio element inside the tap (needed on iPhone), then wait out the lead-in
    if (A.mode === "el") { audio.muted = false; audio.play().catch(() => {}); audio.pause(); A.seek(0); }
    clock.pre = true; clock.preStart = performance.now(); clock.preLen = lead;
  } else A.play().catch(onPlayBlocked);
  lastT = null; dispScore = 0; keepAwake(true); showUI();
}
function resumeFromTap() {
  needTapResume = false; UI.tapStart.hidden = true;
  if (actx && actx.state !== "running") audioRestart(); // (the output stayed asleep: a new one made inside this tap)
  A.play().catch(e => { if (e.name !== "AbortError") toast(tr("Couldn't play audio: {err}", { err: e.message })); });
  keepAwake(true); showUI();
}
function pausePlayback() { clock.pre = false; A.pause(); keepAwake(false); dirty = true; }
function playNow() { ensureAudioCtx(); A.play().catch(e => { if (e.name !== "AbortError") toast(tr("Couldn't play audio: {err}", { err: e.message })); }); keepAwake(true); }
function togglePlay() {
  if (!map) return;
  if (!UI.tapStart.hidden) return needTapResume ? resumeFromTap() : startFromTop();
  if (isPlaying()) pausePlayback(); else playNow();
  showUI();
}
function seekTo(ms) { clock.pre = false; A.seek(ms); lastT = null; dirty = true; if (!UI.tapStart.hidden && !needTapResume) UI.tapStart.hidden = true; }
function setRate(r) {
  A.setRate(r); dirty = true;
  UI.spd.hidden = r === 1 || EDIT.on; UI.spd.textContent = r + "x";
  $("rateSel").value = String(r);
  document.querySelectorAll("#speed button").forEach(b => b.classList.toggle("on", +b.dataset.r === r));
}
UI.spd.onclick = () => setRate(1);
$("rateSel").onchange = e => setRate(+e.target.value);
UI.tapStart.onclick = () => needTapResume ? resumeFromTap() : startFromTop();
UI.play.onclick = togglePlay;
UI.skip.onclick = () => { if (!map) return; if (skipEnd && RP.on) return rpFinish(); /* (the end itself, no seek: the song's own end hook can not fire it twice) */ clock.pre = false; A.seek(map.first - 1800); if (!A.playing()) A.play().catch(onPlayBlocked); lastT = null; };
if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => pausePlayback());
  } catch {}
}

// ============ player UI ============
let uiTimer = null, dirty = true, VS = 1;
const anySheet = () => !UI.sheet.hidden || !UI.tools.hidden;
function showUI() {
  UI.ui.classList.remove("hide"); clearTimeout(uiTimer); dirty = true;
  if (isPlaying() && !anySheet() && !EDIT.on) uiTimer = setTimeout(() => { if (isPlaying() && !anySheet() && !EDIT.on) { UI.ui.classList.add("hide"); dirty = true; } }, 2800);
}
cv.addEventListener("pointerdown", () => {
  if (EDIT.on) return; // editor handles canvas input
  if (anySheet()) { closeSheet(); closeTools(); return; }
  if (UI.ui.classList.contains("hide")) showUI();
  else if (isPlaying()) { clearTimeout(uiTimer); UI.ui.classList.add("hide"); dirty = true; }
  else showUI();
});
let selectScroll = 0;
// the pages can be zoomed, the player and the editor can't: a pinch there is the map's (it would zoom the page under the
// playfield and the bars, which have no room to pan), and phones zoom into a small field when it gets the focus
// (maximum-scale=1 is what stops iOS doing that; the pages' fields are 16 px on touch screens instead, app.css)
const VIEWPORT = document.querySelector('meta[name="viewport"]'), VP_BASE = VIEWPORT.content;
const lockZoom = on => { VIEWPORT.content = VP_BASE + (on ? ", maximum-scale=1, user-scalable=no" : ""); };
// and if iOS did zoom into a field anyway, it leaves the page zoomed in after the typing: when the focus leaves the
// fields while the page is zoomed, a moment of maximum-scale=1 brings it back to its normal size (pinch zoom stays)
const VP_FIELD = /^(INPUT|TEXTAREA|SELECT)$/;
let vpReset = 0;
document.addEventListener("focusout", e => {
  if (!isIOS() || !VP_FIELD.test(e.target.tagName) || VIEWPORT.content !== VP_BASE) return;
  clearTimeout(vpReset);
  vpReset = setTimeout(() => {
    const a = document.activeElement, vv = window.visualViewport;
    if ((a && VP_FIELD.test(a.tagName)) || VIEWPORT.content !== VP_BASE || !(vv && vv.scale > 1.01)) return; // (on to another field, locked, or not zoomed)
    VIEWPORT.content = VP_BASE + ", maximum-scale=1";
    setTimeout(() => { if (VIEWPORT.content === VP_BASE + ", maximum-scale=1") VIEWPORT.content = VP_BASE; }, 400);
  }, 120);
});
function enterPlayer() {
  lockZoom(true);
  selectScroll = scrollY;
  $("shell").hidden = true; UI.player.hidden = false; resize(); demoStop();
  startLoop();
  if (!EDIT.on && innerHeight > innerWidth && innerWidth < 700 && !enterPlayer.hinted) { enterPlayer.hinted = true; setTimeout(() => toast(S.view === "rotate" ? tr("Rotated 16:9 is on: hold the phone upright and tilt its top to the left") : tr("The view is locked to 16:9. For a full portrait screen pick \"16:9 rotated\" in settings")), 600); }
}
function exitPlayerUI() {
  rpStop(); pausePlayback(); closeSheet(); closeTools();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  UI.player.hidden = true; $("shell").hidden = false; lockZoom(false); if (LIVE.on) liveLeftPlayer(); if (R.view === "home") demoStart();
  scrollTo(0, selectScroll);
}
const fsEl = document.documentElement;
if (!fsEl.requestFullscreen && !fsEl.webkitRequestFullscreen) $("fs").hidden = true; // iPhone: no fullscreen API
$("fs").onclick = () => {
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
  const req = fsEl.requestFullscreen || fsEl.webkitRequestFullscreen;
  Promise.resolve(req.call(fsEl, { navigationUI: "hide" })).then(() => { if (!EDIT.on) return screen.orientation?.lock?.("landscape"); }).catch(() => {});
};
// settings: tabs, remembered between visits (separately for Preview and Modding, which need different things)
const SET_TABS = [["editor", "Editor"], ["audio", "Audio"], ["display", "Display"], ["graphics", "Graphics"], ["replay", "Replay"], ["skin", "Skin"], ["test", "Test play"], ["keys", "Shortcuts"], ["general", "General"]];
const edOnNow = () => typeof EDIT !== "undefined" && EDIT.on; // (editor.js loads after this file)
const setTabsNow = () => SET_TABS.filter(t => t[0] === "editor" ? edOnNow() : t[0] === "replay" ? !edOnNow() && (typeof featOn !== "function" || featOn("replays")) : true); // (Replay: not while modding, nor when the replays are switched off for this visitor)
function buildSetTabs() {
  const box = $("setTabs"); box.innerHTML = "";
  for (const [k, l] of setTabsNow()) { const b = h("button", "tab", tr(l)); b.dataset.stab = k; b.setAttribute("role", "tab"); b.onclick = () => showSetTab(k); box.append(b); }
}
function showSetTab(k) {
  if (!setTabsNow().some(t => t[0] === k)) k = edOnNow() ? "editor" : "audio";
  if (edOnNow()) S.setTabEd = k; else S.setTab = k;
  save();
  document.querySelectorAll("#setTabs .tab").forEach(b => { const on = b.dataset.stab === k; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  document.querySelectorAll("#sheet .spane").forEach(s => s.hidden = s.dataset.pane !== k);
  if (k === "skin") renderSkinUI();
  if (k === "replay" && $("replayCache")) loadLazy("replayui").then(() => replayCacheUI($("replayCache")), () => {}); // (the replays kept on this device)
  if (k === "editor" && typeof renderEdSettings === "function") renderEdSettings();
  if (k === "keys") buildKeys();
  if (k === "test" && typeof renderTestSettings === "function") renderTestSettings(); // (play.js)
  if (k === "general" && typeof oszCacheUI === "function") oszCacheUI();
  $("setBody").scrollTop = 0;
}
// keyboard shortcuts, grouped like the osu! editor's menus
const KEY_GROUPS = [
  ["Playback", [["Space", "Play / pause"], ["← →", "Seek 5 s (Modding: one beat snap)"], ["Shift + ← →", "Seek one beat"], ["M", "Metronome on/off"], ["Tab", "Top 50 on/off (watching a replay)"], ["Esc", "Close / back"]]],
  ["Compose", [["1 2 3 4", "Select / Circle / Slider / Spinner"], ["F1 / F2 / F3 / F4", "Compose / Hitsounds / Timing / Setup"], ["G  T", "Grid snap / Distance snap"], ["Shift + G", "Mapping guides (distance and angle) on/off"], ["Alt + scroll", "Distance snap multiplier"], ["Enter / right-click", "Finish the slider you're placing"], ["?", "Editor tour"]]],
  ["Hitsounds", [["Q W E R", "New combo / Whistle / Finish / Clap"], ["Shift / Alt + Q W E R", "Sample set / addition bank: Auto, Normal, Soft, Drum"], ["H", "Hitsound panel (live session: highlight)"]]],
  ["Selection and editing", [["Ctrl + Z / Y", "Undo / redo"], ["Ctrl + A", "Select all"], ["Del", "Delete selected objects"], ["Ctrl + C / X / V", "Copy / cut / paste objects"], ["Ctrl + D", "Clone the selection"],
    ["↑ ↓", "Move the selection by the grid"], ["Alt + ← →", "Move the selection by one beat snap"], ["Right-click", "Menu for objects / empty space (long-press on touch)"], ["Shift + right-click", "Delete the object under the cursor"]]],
  ["Transform", [["Ctrl + H / J", "Flip horizontally / vertically"], ["Ctrl + < / >", "Rotate 90° counter-clockwise / clockwise"], ["Ctrl + G", "Reverse selection"], ["Ctrl + Shift + R", "Rotate / scale"], ["Ctrl + Shift + D", "Polygon circles"], ["Ctrl + Shift + F", "Slider → stream"]]],
  ["Sliders", [["Drag from the head", "Placing: draw the slider freehand"], ["Click the last point / S", "Placing: start a new segment (red anchor)"], ["Alt + 1 / 2 / 3", "Placing: this segment straight / bezier / perfect circle"], ["Tab / Shift + Tab", "Placing: next / previous curve type for this segment"], ["Ctrl + click", "Slider: add a control point on the body • red anchor on a point"], ["Right-click a point", "Slider: delete that control point"]]],
  ["Timeline and timing", [["Drag", "Timeline: select the objects in a stretch of time (Ctrl / Shift: add to the selection)"], ["Middle-drag / Alt + drag", "Timeline: scrub (on touch: drag)"], ["Shift + L", "Lock / unlock the timeline"], ["Ctrl + scroll", "Zoom the timeline"], ["Ctrl + B", "Bookmark"], ["Ctrl + P", "Add a timing point (Shift: green line)"], ["F6", "Timing and control points"]]],
  ["Mod notes", [["N", "Quick mod note"], ["[  ]", "Previous / next mod note"], ["Ctrl + S", "Export .osu"], ["Enter", "Open the chat (live session)"]]],
];
function buildKeys() {
  const box = $("keysList"); if (!box) return; box.innerHTML = "";
  const q = ($("keysFind").value || "").trim().toLowerCase();
  const tp = typeof tpOn === "function" && tpOn(); // (test play's keys can be changed: play.js; with it off, F5 switches Preview / Modding)
  const groups = tp ? [["Test play", tpKeyRows()], ...KEY_GROUPS] : KEY_GROUPS.map(([g, r]) => g === "Playback" ? [g, [...r.slice(0, -1), ["F5", "Switch Preview / Modding"], r[r.length - 1]]] : [g, r]);
  for (const [g, rows] of groups) {
    const list = rows.filter(([k, d]) => !q || k.toLowerCase().includes(q) || kbdMod(k).toLowerCase().includes(q) || tr(d).toLowerCase().includes(q) || d.toLowerCase().includes(q));
    if (!list.length) continue;
    const card = h("div", "card2 keys");
    for (const [k, d] of list) { const r = h("div", "krow"); r.append(h("kbd", null, kbdMod(k)), h("span", null, tr(d))); card.append(r); } // (kbdMod: ⌘ on a Mac / iPad)
    if (g === "Test play") { const ed = h("button", "mlink", tr("Change these keys →")); ed.onclick = () => showSetTab("test"); card.append(ed); }
    box.append(h("div", "subh", tr(g)), card);
  }
  if (!box.children.length) box.append(h("p", "hint", tr("No shortcut matches.")));
}
$("keysFind").addEventListener("input", buildKeys);
$("keysFind").addEventListener("keydown", e => e.stopPropagation());
buildSetTabs(); buildKeys();
addEventListener("langchange", () => { buildSetTabs(); buildKeys(); if (!UI.sheet.hidden) showSetTab(edOnNow() ? S.setTabEd : S.setTab); });
// keep every switch / chip in sync with the settings
function syncToggles() {
  document.querySelectorAll("[data-k]").forEach(i => i.checked = !!S[i.dataset.k]);
  $("metroChip").hidden = !S.metro;
  document.querySelectorAll(".t5size").forEach(i => { i.value = S.top50Size; const o = i.parentNode.querySelector("output"); if (o) o.textContent = S.top50Size + "%"; });
  document.querySelectorAll(".hbsize").forEach(i => { i.value = S.hitBarSize; const o = i.parentNode.querySelector("output"); if (o) o.textContent = S.hitBarSize + "%"; });
  $("edMetro").classList.toggle("lit", !!S.metro);
  $("edEnd").classList.toggle("lit", !!S.sliderEnd);
  if (typeof edTrayDot === "function") edTrayDot(); // (the dot on the closed Tools tray, editor.js)
}
$("edEnd").onclick = () => { setToggle("sliderEnd", !S.sliderEnd); toast(tr(S.sliderEnd ? "Slider end circles on" : "Slider end circles off"), 1200); };
function setToggle(k, v) {
  S[k] = v; save(); dirty = true;
  if (k === "sliderShadow") bodyCache.clear(); // (slider bodies are drawn once and kept)
  if (k === "sb" && !v && EPI.el) epiWarn(); // (the storyboard turned off: its epilepsy warning goes)
  if (k === "metro") { if (v) ensureAudioCtx(); toast(tr(v ? "Metronome on" : "Metronome off"), 1200); }
  if ((k === "liveTop50" || k === "hud") && v && S.liveTop50 && S.hud && RP.on && !RPB.rows && RPU.sess && RPU.sess.data === RP.data) t5Live(RPU.sess); // (the board switched on, or the score display it sits with, while watching: the scores load now, not only at the next start)
  syncToggles();
}
$("metroChip").onclick = () => setToggle("metro", false);
document.querySelectorAll(".t5size").forEach(i => i.addEventListener("input", () => { S.top50Size = Math.max(40, Math.min(150, Math.round(+i.value / 5) * 5)); save(); dirty = true; syncToggles(); }));
document.querySelectorAll(".hbsize").forEach(i => i.addEventListener("input", () => { S.hitBarSize = Math.max(20, Math.min(150, Math.round(+i.value / 5) * 5)); save(); dirty = true; syncToggles(); }));
// the eye button (replays, on the bottom bar: a touch screen has no Tab): Top 50, hit error bar, UR and early / late, switched while watching
function rpPopShow(on) { $("rpPop").hidden = !on; $("rpView").setAttribute("aria-expanded", on ? "true" : "false"); }
$("rpView").onclick = e => { e.stopPropagation(); rpPopShow($("rpPop").hidden); };
addEventListener("pointerdown", e => { if (!$("rpPop").hidden && !e.target.closest("#rpPop, #rpView")) rpPopShow(false); }, true);
addEventListener("keydown", e => { if (e.code === "Escape" && !$("rpPop").hidden) { rpPopShow(false); e.stopPropagation(); } }, true);
function openSheet() {
  closeTools(); closeLive();
  UI.sheet.hidden = false; $("sheetDim").hidden = false; clearTimeout(uiTimer);
  syncToggles(); buildSetTabs(); showSetTab(EDIT.on ? S.setTabEd || "editor" : S.setTab || "audio");
  $("dim").value = S.dim; $("hsSrc").value = S.hsSrc; $("quality").value = S.quality; $("sbRender").value = S.sbGL; $("sbRender").querySelector("option[value=on]").disabled = !SBGL_OK; $("view").value = S.view; $("fpsSel").value = S.fps;
  syncOffsetUI();
  if (typeof btSettings === "function") $("btSetBox").replaceChildren(...btSettings()); // in the current language and state
  syncVol();
}
function closeSheet() { if (UI.sheet.hidden) return; UI.sheet.hidden = true; $("sheetDim").hidden = true; showUI(); }
$("sheetDim").onclick = closeSheet; // (Settings floats in the middle: a click outside it closes it)
$("gear").onclick = () => UI.sheet.hidden ? openSheet() : closeSheet();
$("sheetClose").onclick = closeSheet;
$("sheetVol").append(volControl());
// the side sheets (Settings, Mapping tools, Live session, Collab) are dialogs: focus moves in when one opens, Tab stays
// inside, Esc closes it (wherever the focus is in it), and the focus goes back to what opened it
const SHEETS = ["sheet", "tools", "liveSheet", "collabSheet"], sheetBack = new Map();
const openSheetEl = () => SHEETS.map(id => $(id)).find(s => s && !s.hidden);
function closeAnySheet() {
  const s = openSheetEl(); if (!s) return false;
  if (s.id === "sheet") closeSheet(); else if (s.id === "tools") closeTools(); else if (s.id === "liveSheet") closeLive(); else s.hidden = true;
  return true;
}
const sheetObs = new MutationObserver(recs => { for (const { target: s } of recs) {
  const a = document.activeElement;
  if (!s.hidden) {
    if (!s.contains(a)) { sheetBack.set(s, a); s.focus({ preventScroll: true }); }
    const b = s.querySelector(".sheet-h b"); if (b) s.setAttribute("aria-label", b.textContent.trim());
  } else {
    const back = sheetBack.get(s); sheetBack.delete(s);
    if ((s.contains(a) || a === document.body) && back && back.isConnected && back.getClientRects().length && !openSheetEl()) try { back.focus({ preventScroll: true }); } catch {}
  }
} });
for (const id of SHEETS) { const s = $(id); s.setAttribute("role", "dialog"); s.setAttribute("aria-modal", "true"); s.tabIndex = -1; sheetObs.observe(s, { attributes: true, attributeFilter: ["hidden"] }); }
addEventListener("keydown", e => {
  const s = openSheetEl(); if (!s || document.querySelector(".mdl") || $("hssPop")) return; // (a pop-up over it keeps its own keys)
  const a = document.activeElement;
  if (e.key === "Escape" && s.contains(e.target)) { e.preventDefault(); e.stopPropagation(); closeAnySheet(); }
  else if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && (s.contains(a) || a === document.body && !EDIT.sliderPts)) {
    const f = [...s.querySelectorAll("button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && x.getClientRects().length);
    if (!f.length) { e.preventDefault(); s.focus(); return; }
    const z = f[f.length - 1];
    if (!s.contains(a) || a === s) { e.preventDefault(); (e.shiftKey ? z : f[0]).focus(); }
    else if (e.shiftKey && a === f[0]) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && a === z) { e.preventDefault(); f[0].focus(); }
  }
}, true);
document.querySelectorAll("[data-k]").forEach(i => i.onchange = () => setToggle(i.dataset.k, i.checked));
syncToggles();
$("dim").oninput = e => { S.dim = +e.target.value; save(); dirty = true; };
function setOffset(v) { S[S.btMode ? "offsetBt" : "offset"] = Math.max(-200, Math.min(500, Math.round(v))); syncOffsetUI(); save(); dirty = true; }
function syncOffsetUI() {
  const v = visOffset(); $("offset").value = v; $("offsetOut").textContent = v + " ms";
  $("offsetFor").textContent = tr(S.btMode ? "Saved for wireless / Bluetooth" : "Saved for wired / speakers");
  $("offsetLat").textContent = actx ? tr("The browser reports {ms} ms of output delay and already makes up for it.", { ms: Math.round(outLat()) }) : "";
}
$("offset").oninput = e => setOffset(+e.target.value);
$("offsetReset").onclick = () => setOffset(0);
$("calibBtn").onclick = () => openCalibration();

// ---------- audio calibration (Bluetooth and other laggy outputs) ----------
// Clicks are scheduled on the audio clock. You tap each click you hear; the median delay between a click and your tap,
// minus the output latency the browser already reports (and the player already compensates), is how much later the
// notes have to be drawn. Music and hitsounds share one output, so they stay in step with each other either way.
// Then a circle flashes on the beat with that offset, and the slider fine-tunes it while the clicks keep playing.
async function openCalibration() {
  ensureAudioCtx(); if (!actx) return toast(tr("Audio isn't available in this browser"), 2500);
  try { await actx.resume(); } catch {}
  const BEAT = 600, NEED = 16, WARM = 4;
  const st = { taps: [], clicks: [], next: 0, timer: 0, raf: 0, stage: "tap", off: visOffset(), hs: +S.hsDelay || 0, closed: false, loop: 0, from: 0 };
  const box = h("div", "mdlb calib"), info = h("p", null, ""), dot = h("div", "calibdot"), count = h("p", "calibcount"), res = h("p", "calibres");
  const tapB = h("button", "btn main calibtap", tr("Tap")), again = h("button", "btn ghost sm", tr("Measure again"));
  const rng = h("input"), out = h("output"); rng.type = "range"; rng.min = -200; rng.max = 500; rng.step = 1; rng.value = st.off; out.textContent = st.off + " ms";
  const fine = h("label", "row calibfine"); fine.append(h("span", null, tr("Fine-tune")), rng, out);
  rng.oninput = () => { st.off = +rng.value; out.textContent = st.off + " ms"; };
  // last step: the song with its hitsounds, looping a few seconds, while a slider moves the hitsounds earlier / later
  const canHs = !!(map && map.hit.length && A.mode !== "virt" && S.hsSrc !== "off" && hsGain() > 0);
  const toHs = h("button", "btn main sm", tr("Next: hitsounds")), hsRng = h("input"), hsOut = h("output"), hsRow = h("label", "row calibfine"), hsBox = h("div", "calibhs");
  hsRng.type = "range"; hsRng.min = -200; hsRng.max = 200; hsRng.step = 5; hsRng.value = st.hs;
  const hsShow = () => { hsOut.textContent = (st.hs > 0 ? "+" : "") + st.hs + " ms"; }; hsShow();
  hsRng.oninput = () => { st.hs = +hsRng.value; S.hsDelay = st.hs; hsShow(); resetSched(); stopPending(); };
  hsRow.append(h("span", null, tr("Hitsound timing")), hsRng, hsOut);
  hsBox.append(hsRow, h("p", "hint", tr("The song plays a few seconds with its hitsounds, over and over. Move the slider until the hitsounds sit exactly on the music: left = earlier, right = later.")));
  toHs.hidden = true; hsBox.hidden = true;
  toHs.onclick = () => {
    setStage("hs"); S.btMode || setBtMode(true); // the hitsound timing works with the Wireless / Bluetooth mode
    st.from = Math.max(map.first, A.cur()); seekTo(st.from); if (!isPlaying()) togglePlay();
    st.loop = setInterval(() => { if (A.cur() > st.from + 6000 || !isPlaying()) { seekTo(st.from); if (!isPlaying()) togglePlay(); } }, 100);
  };
  box.append(info, dot, count, tapB, res, fine, again, toHs, hsBox);
  const lat = outLat;
  // schedule clicks a little ahead, forever, until closed
  const pump = () => {
    if (st.closed) return;
    if (st.stage === "hs") { st.timer = setTimeout(pump, 60); return; } // the song plays instead of the clicks
    const now = actx.currentTime * 1000;
    if (!st.next) st.next = now + 400;
    while (st.next < now + 300) { playBuf(clickBuf(st.clicks.length % 4 === 0), Math.max(.3, hsGain() || .6), st.next / 1000); st.clicks.push(st.next); st.next += BEAT; }
    st.timer = setTimeout(pump, 60);
  };
  const setStage = s2 => {
    st.stage = s2;
    tapB.hidden = s2 !== "tap"; fine.hidden = again.hidden = s2 !== "check"; count.hidden = s2 !== "tap";
    toHs.hidden = !(s2 === "check" && canHs); hsBox.hidden = s2 !== "hs"; dot.hidden = res.hidden = s2 === "hs";
    info.textContent = s2 === "tap" ? tr("Put on the headphones you play with. Tap the button (or press Space) on every click you hear, not on what you see. Keep a steady rhythm.")
      : s2 === "hs" ? tr("Step 3: hitsounds. Listen to the song and its hitsounds together.")
      : tr("Check: the circle should flash exactly when you hear each click. If it flashes early, move the slider right; if late, move it left.");
    count.textContent = tr("{n} / {m} taps", { n: Math.max(0, st.taps.length - WARM), m: NEED });
  };
  const finish = () => {
    const ds = st.taps.slice(WARM).sort((a, b) => a - b), med = ds[ds.length >> 1];
    const spread = ds[Math.floor(ds.length * .75)] - ds[Math.floor(ds.length * .25)];
    const off = Math.round(med - lat());
    st.off = Math.max(-200, Math.min(500, off)); rng.value = st.off; out.textContent = st.off + " ms";
    res.textContent = tr("Measured delay: {d} ms (your taps varied by about {s} ms). Suggested offset: {o} ms.", { d: Math.round(med), s: Math.round(spread), o: st.off })
      + (spread > 70 ? " " + tr("Your taps were uneven: try again for a better result.") : "");
    setStage("check");
  };
  const tap = () => {
    if (st.stage !== "tap") return;
    const t = actx.currentTime * 1000;
    let best = null; for (const c of st.clicks) if (best == null || Math.abs(t - c) < Math.abs(t - best)) best = c;
    if (best == null) return;
    let d = t - best; if (d < -BEAT / 2) d += BEAT; // a tap well before a click belongs to the previous one
    st.taps.push(d); dot.classList.remove("hit"); void dot.offsetWidth; dot.classList.add("hit");
    count.textContent = tr("{n} / {m} taps", { n: Math.max(0, st.taps.length - WARM), m: NEED });
    if (st.taps.length >= WARM + NEED) finish();
  };
  tapB.onpointerdown = e => { e.preventDefault(); tap(); };
  again.onclick = () => { st.taps = []; res.textContent = ""; setStage("tap"); };
  const key = e => { if (e.code === "Space" || e.code === "Enter" && st.stage === "tap") { e.preventDefault(); e.stopPropagation(); tap(); } };
  addEventListener("keydown", key, true);
  // the flash, drawn with the offset being tested (same rule as the player: drawn time = audio time - reported latency - offset)
  const frame = () => {
    if (st.closed) return;
    if (st.stage === "check") {
      const seen = actx.currentTime * 1000 - lat() - st.off;
      let on = false; for (let i = st.clicks.length - 1; i >= 0 && i >= st.clicks.length - 4; i--) { const d = seen - st.clicks[i]; if (d >= 0 && d < 110) on = true; }
      dot.classList.toggle("flash", on);
    }
    st.raf = requestAnimationFrame(frame);
  };
  setStage("tap"); pump(); frame();
  const hs0 = +S.hsDelay || 0;
  const v = await modal({ title: tr("Audio calibration"), body: box, dismiss: false, buttons: [{ label: tr("Cancel"), value: false }, { label: tr("Use these settings"), value: true, cls: "main" }] });
  st.closed = true; clearTimeout(st.timer); clearInterval(st.loop); cancelAnimationFrame(st.raf); removeEventListener("keydown", key, true);
  if (st.stage === "hs") pausePlayback();
  if (v) { setOffset(st.off); S.hsDelay = st.hs; save(); toast(tr("Visual offset {o} ms · hitsound timing {h} ms", { o: visOffset(), h: S.hsDelay }), 2500); }
  else { S.hsDelay = hs0; save(); }
  resetSched(); if (!UI.sheet.hidden && typeof btSettings === "function") $("btSetBox").replaceChildren(...btSettings());
}
$("hsSrc").onchange = e => { S.hsSrc = e.target.value; save(); if (S.hsSrc !== "off") preloadDefaults(); previewHit(); };
$("quality").onchange = e => { S.quality = e.target.value; save(); resize(); };
$("sbRender").onchange = e => { S.sbGL = e.target.value === "on" ? "on" : "off"; save(); if (S.sbGL !== "on") sbglRelease(); dirty = true; };
for (const f of FPS_OPTS) $("fpsSel").add(new Option(f + " FPS", f));
$("fpsSel").onchange = e => { S.fps = +e.target.value; save(); dirty = true; };
$("view").onchange = e => { S.view = e.target.value; save(); dirty = true; };

let seeking = false;
UI.seek.addEventListener("input", e => {
  seeking = true; if (!map) return;
  seekTo(e.target.value / 1000 * A.dur());
  if (!UI.tapStart.hidden && !needTapResume) { UI.tapStart.hidden = true; ensureAudioCtx(); }
  showUI();
});
UI.seek.addEventListener("change", () => seeking = false);
// a tap right on a bookmark tick goes exactly there (the bar alone lands within 1/1000 of the song); a drag seeks as usual
const bmTap = { b: null, x: 0 };
UI.seek.addEventListener("pointerdown", e => {
  bmTap.b = null; if (!map || !map.bookmarks.length) return;
  const r = UI.tl.getBoundingClientRect(), dur = A.dur() || 1; let bd = e.pointerType === "mouse" ? 5 : 9;
  for (const b of map.bookmarks) { const d = Math.abs(r.left + b / dur * r.width - e.clientX); if (d <= bd) { bd = d; bmTap.b = b; } }
  bmTap.x = e.clientX;
});
UI.seek.addEventListener("pointermove", e => { if (bmTap.b != null && Math.abs(e.clientX - bmTap.x) > 4) bmTap.b = null; });
UI.seek.addEventListener("input", () => { if (bmTap.b != null) seekTo(bmTap.b); }); // (after the handler above: the bar's own seek, then the bookmark)
UI.seek.addEventListener("pointerup", () => { if (bmTap.b != null) { seekTo(bmTap.b); showUI(); } bmTap.b = null; }); // (iOS: a tap on the track doesn't move the thumb)
// the bars' seek bar and lists give the keyboard back once used with a pointer: kept in focus, the next shortcut drew the
// browser's focus ring round them (and a list kept the keys to itself, so arrow keys went on changing the difficulty)
UI.seek.addEventListener("pointerup", () => setTimeout(() => { if (document.activeElement === UI.seek) UI.seek.blur(); }, 0));
UI.player.addEventListener("change", e => { const el = e.target; if (el.tagName === "SELECT" && el.closest(".bar")) el.blur(); });
function stepBeat(dir) { // jump to the previous/next beat line
  const t = A.cur(), b = beatInfo(t), n = Math.round((t - b.off) / b.len) + dir;
  seekTo(b.off + n * b.len);
}
document.addEventListener("keydown", e => {
  if (!$("detail").hidden) { if (e.code === "Escape") { const dd = $("dDl"); if (dd && dd.open) { dd.open = false; dd.querySelector("summary").focus(); } else closeDetail(); } return; } // (an open Download menu closes first)
  if (UI.player.hidden) return;
  const tag = e.target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" && e.target.type !== "range" && e.target.type !== "checkbox" || tag === "SELECT") return;
  const tp = typeof tpOn === "function" && tpOn();
  if (e.code === (tp ? tpKey("start") : "F5")) { e.preventDefault(); if (RP.on) return; /* (watching a replay: no Modding, no test play) */ if (!tp) setMode(!EDIT.on); else if (EDIT.on) playStart(); else setMode(true); return; } // (Modding: test play, like osu!; the key: Settings → Test play; test play off: switch Preview / Modding)
  if (e.code === "KeyM" && !e.ctrlKey && !e.metaKey) { setToggle("metro", !S.metro); return; }
  if (e.code === "Tab" && RP.on && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && !RPU.res && !RPU.end && !(typeof RPAN !== "undefined" && RPAN.el) && !openSheetEl() && !document.querySelector(".mdl")) { // (watching a replay: Tab shows / hides the live Top 50; Shift+Tab still moves the focus)
    e.preventDefault(); setToggle("liveTop50", !S.liveTop50); toast(tr(!S.liveTop50 ? "Top 50 hidden" : S.hud ? "Top 50 shown" : "Turn on Score / combo to see the Top 50"), 1400); return;
  }
  if (e.code === "Escape" && closeAnySheet()) return; // (before the editor's own Esc: a sheet on top goes first)
  if (EDIT.on && edKey(e)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
    e.preventDefault(); const dir = e.code === "ArrowRight" ? 1 : -1;
    if (e.shiftKey) stepBeat(dir); else seekTo(A.cur() + dir * 5000);
    showUI();
  }
  else if (e.code === "Escape") $("back").click();
});

// ============ sizing (DPR capped, lowered automatically when frames run slow) ============
const SAFE = { t: 0, r: 0, b: 0, l: 0 }, INS = { t: 0, b: 0, l: 0, r: 0 };
let autoCap = Math.min(devicePixelRatio || 1, LOWEND ? 1.5 : 2), slowN = 0, sampN = 0, sampSkip = 0;
// Touch devices (auto quality only): the canvas also gets a pixel budget. Rasterising scales with the canvas's pixels, so a tablet (1024x768 at DPR 2 = 3.1 Mpx)
// is drawn at about DPR 1.67 and the biggest at 1.25 at the least, while a phone (390x844 at DPR 2 = 1.3 Mpx) keeps its DPR. "high" ignores it, "low" is 1, a mouse device is as before
const PX_BUDGET = 2200000, PX_FLOOR = 1.25, SAMP_STALL = 500;
const COARSE = (() => { try { return navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches; } catch { return false; } })();
const dprNow = () => {
  if (S.quality === "low") return 1;
  if (S.quality === "high") return Math.min(devicePixelRatio || 1, 3);
  let q = Math.min(devicePixelRatio || 1, autoCap);
  if (COARSE) { const w = UI.player.clientWidth || innerWidth, h = UI.player.clientHeight || innerHeight; if (w > 0 && h > 0) q = Math.min(q, Math.max(PX_FLOOR, Math.sqrt(PX_BUDGET / (w * h)))); }
  return q;
};
function resize() {
  if (UI.player.hidden) return;
  const q = dprNow();
  const w = UI.player.clientWidth || innerWidth, h = UI.player.clientHeight || innerHeight;
  const cw = Math.round(w * q), ch = Math.round(h * q);
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; bodyCache.clear(); sampN = slowN = 0; sampSkip = 6; } // (the frames right after a new canvas are slow once: not counted by the adaptive resolution)
  cv.dpr = q;
  const cs = getComputedStyle($("safe"));
  SAFE.t = parseFloat(cs.paddingTop) * q || 0; SAFE.r = parseFloat(cs.paddingRight) * q || 0; SAFE.b = parseFloat(cs.paddingBottom) * q || 0; SAFE.l = parseFloat(cs.paddingLeft) * q || 0;
  measureIns();
  drawTimeline();
  dirty = true;
}
function measureIns() { // editor: the playfield sits between the bars and the tool columns (layout sizes, bars may be mid-slide)
  const q = cv.dpr || 1, top = document.querySelector(".bar.top"), bot = document.querySelector(".bar.bottom");
  if (typeof EDIT === "undefined" || !EDIT.on) { INS.t = INS.b = INS.l = INS.r = 0; return; } // (resize observers can fire before editor.js has run)
  const t = top.offsetHeight, b = bot.offsetHeight, L = $("edLeft"), Rt = $("edRight");
  UI.player.style.setProperty("--insT", t + "px"); UI.player.style.setProperty("--insB", b + "px");
  INS.t = t * q; INS.b = b * q; INS.l = INS.r = 0;
  if (L.closest(".bar")) {} // upright phones: the tool rows are docked in the bottom bar (editor.js edDock), already in b
  else if (getComputedStyle(L).flexDirection === "row") { INS.t += L.offsetHeight * q; INS.b += Rt.offsetHeight * q; } // portrait: toolbars are rows
  else { INS.l = L.offsetParent ? (L.offsetLeft + L.offsetWidth) * q : 0; INS.r = Rt.offsetParent ? (UI.player.clientWidth - Rt.offsetLeft) * q : 0; } // (hidden while watching a live session)
}
addEventListener("resize", resize);
new ResizeObserver(resize).observe(UI.player);
new ResizeObserver(() => { measureIns(); dirty = true; }).observe(document.querySelector(".bar.top"));
new ResizeObserver(() => { measureIns(); dirty = true; }).observe(document.querySelector(".bar.bottom"));

// ============ seek bar timeline: density, kiai, breaks, red lines, bookmarks ============
function drawTimeline() {
  const c = UI.tl; if (!map || UI.player.hidden) return;
  const w = c.clientWidth, hh = c.clientHeight; if (!w) return;
  const d = Math.min(devicePixelRatio || 1, 2); c.width = Math.round(w * d); c.height = Math.round(hh * d);
  const g = c.getContext("2d"); g.scale(d, d);
  const dur = A.dur() || 1, X = ms => ms / dur * w;
  g.fillStyle = "rgba(102,204,255,.28)"; for (const [a, b] of map.breaks) g.fillRect(X(a), 0, X(b) - X(a), hh);
  g.fillStyle = "rgba(255,102,170,.45)"; for (const [a, b] of map.kiai) g.fillRect(X(a), 0, X(Math.min(b, dur)) - X(a), hh);
  const bins = Math.max(20, Math.floor(w / 3)), cnt = new Uint16Array(bins);
  for (const o of map.hit) cnt[Math.min(bins - 1, Math.max(0, Math.floor(o.t / dur * bins)))]++;
  let mx = 1; for (const v of cnt) if (v > mx) mx = v;
  g.fillStyle = "rgba(255,255,255,.55)";
  for (let i = 0; i < bins; i++) if (cnt[i]) { const bh = Math.max(1, cnt[i] / mx * hh); g.fillRect(i * w / bins, hh - bh, Math.max(1, w / bins - .6), bh); }
  const reds = map.timing.filter(x => x.uninherited);
  if (reds.length > 1 && reds.length < 300) { g.fillStyle = "#ff5a6e"; for (const r of reds) g.fillRect(X(r.time) - .5, 0, 1, hh); }
  const NC = { problem: "#ff5a6e", suggestion: "#ffcf6b", praise: "#57d68d", note: "#66ccff" };
  if (!EDIT.on || S.edAdv === true) for (const n of notesCached()) { g.fillStyle = NC[n.type] || "#66ccff"; g.fillRect(X(n.t) - 1, 0, 2, hh); } // (the editor's Simple tools leave mod notes out)
  const pv = +(map.general.PreviewTime ?? -1);
  if (pv > 0) { g.fillStyle = "#ffd84a"; g.fillRect(X(pv) - 1, 0, 2, hh); }
  // bookmarks on top, like osu!'s blue ticks: a dark edge and a cap so they read over the density bars (tap one: bmTap)
  for (const b of map.bookmarks) { const x = X(b); g.fillStyle = "rgba(10,14,30,.7)"; g.fillRect(x - 2.5, 0, 5, hh); g.fillStyle = "#4d9bff"; g.fillRect(x - 1.5, 0, 3, hh); g.beginPath(); g.moveTo(x - 4.5, 0); g.lineTo(x + 4.5, 0); g.lineTo(x, 5); g.fill(); }
}

// ============ gameplay rendering (follows osu!'s legacy skin behaviour) ============
function startPos(o) { return o.kind === "spinner" ? [316, 192] : [o.x, o.y]; }
function endPos(o) {
  if (o.kind === "slider") { const p = pointAt(o, o.slides % 2 ? 1 : 0); return [p[0], p[1]]; }
  if (o.kind === "spinner") { const a = (o.end - o.t) * .03; return [256 + Math.cos(a) * 60, 192 + Math.sin(a) * 60]; }
  return [o.x, o.y];
}
// Auto's cursor: cursorAt(t) and autoCursorScale(t) in auto.js (osu!lazer's autoplay)
// ---- Settings → Skin on top of what the skin says (skins.js has the skin's own values). Every key reads as today's look when it is
// missing or untouched ("skin"), so a setting nobody changed draws exactly what the code drew before it existed ----
const skOv = (k, v) => { const o = S[k]; return o === "on" || o === "above" ? true : o === "off" || o === "below" ? false : v; }; // ("skin" / unset: the skin's value v)
const objK = () => { const v = S.objOpacity == null ? 1 : Number(S.objOpacity); return v < 1 ? Math.max(.3, v) : 1; }; // (opacity of the hit objects; NaN: 1)
const curZ = () => { const v = S.curSize == null ? 1 : Number(S.curSize); return v >= .5 && v <= 2 ? v : v < .5 ? .5 : v > 2 ? 2 : 1; }; // (cursor size 0.5 .. 2)
// skin animations (name-0, name-1 ...): skins.js texFrames(name) lists the frames (none: a still image) and texFrame(name, ms, fps)
// picks the one to draw. Time is the song's (an object's age), so a paused or seeked frame is always the same. S.skinAnim off: first frame only
const NOFR = [], ANI = { sk: null, def: null, m: new Map() }, FTX = new WeakMap(), ATINT = new WeakMap();
let animT = 0; // (the time being drawn; set each frame)
function aFrames(name) {
  if (S.skinAnim === false || typeof texFrames !== "function") return NOFR;
  if (ANI.sk !== SK || ANI.def !== DEFSK) { ANI.sk = SK; ANI.def = DEFSK; ANI.m.clear(); }
  let f = ANI.m.get(name); if (!f) { const l = texFrames(name); ANI.m.set(name, f = l && l.length > 1 ? l : NOFR); }
  return f;
}
function frameTex(name, f) { // (a frame as T() gives it: { img, hd })
  if (!f) return null; if (f.img) return f;
  let t = FTX.get(f); if (!t) { const b = texOf(name); FTX.set(f, t = { img: f, hd: b ? b.hd : 1 }); }
  return t;
}
function tintOf(t, col) { // (a tinted copy of one frame, kept per image)
  let m = ATINT.get(t.img); if (!m) ATINT.set(t.img, m = new Map());
  const k = (col[0] | 0) + "," + (col[1] | 0) + "," + (col[2] | 0); let c = m.get(k);
  if (!c) { c = { img: tintCanvas(t.img, col), hd: t.hd }; m.set(k, c); if (m.size > 40) m.delete(m.keys().next().value); }
  return c;
}
function aT(name, ms, col, fps) { // T(name, col) for an element that may be animated (looping, ms = time into it)
  const fr = aFrames(name); if (!fr.length) return T(name, col);
  const t = frameTex(name, texFrame(name, Math.max(0, ms), fps)); if (!t) return T(name, col);
  return col && TINTED[name] ? tintOf(t, col) : t;
}
function hitImg(name, age) { // hit0 / 50 / 100 / 300 (and the k / g ones): an animation plays once at 60 FPS and its last frame stays (osu!)
  const fr = aFrames(name); if (!fr.length) return T(name);
  return frameTex(name, fr[Math.min(fr.length - 1, Math.max(0, Math.floor(age * .06)))]) || T(name);
}
function drawHead(o, x, y, col, s, a, sliderHead) {
  const c = sliderHead && hasTex("sliderstartcircle") ? "sliderstartcircle" : "hitcircle";
  const ov = sliderHead && hasTex("sliderstartcircleoverlay") ? "sliderstartcircleoverlay" : "hitcircleoverlay";
  const nums = S.hcNumbers !== false;
  blit(T(c, col), x, y, s, a);
  if (skOv("hcOverlay", SK.overlayAbove)) { if (nums) drawNumber(o.num, x, y, s, a); blit(aT(ov, animT), x, y, s, a); }
  else { blit(aT(ov, animT), x, y, s, a); if (nums) drawNumber(o.num, x, y, s, a); }
}
const approachAlpha = (o, t) => clamp01((t - (o.t - map.preempt)) / Math.min(map.preempt, map.fadeIn * 2)) * .9;
// the approach circle closing in on an object (Settings → Skin → Approach circles); an animated one (approachcircle-N) plays from when it shows
function drawApproach(o, x, y, col, s, t) {
  if (S.elApproach === false) return;
  blit(aT("approachcircle", t - (o.t - map.preempt), col), x, y, s * (1 + 3 * (o.t - t) / map.preempt), approachAlpha(o, t));
}
const followC = (o, t) => aT("sliderfollowcircle", t - o.t); // (the follow circle; an animation runs from the slider's start)
// ---- a replay's Hidden and Flashlight (set each frame: only while a replay that has the mod plays, never in the editor or test play) ----
// Hidden as osu!lazer's OsuModHidden: no approach circles (but on the first object: "increase first object visibility", on by
// default), a circle (a slider's head and tail too) fades in over 0.4 preempt then out over 0.3, gone 0.3 preempt before its time;
// a slider's body fades out (ease out) from the end of its fade-in to the slider's end; ticks fade out until they are reached;
// repeat arrows, the ball, the follow circle and follow points stay; a spinner loses its approach circle and fades out over 0.3
// preempt once it's over
const RPM = { hd: false, fl: false, first: null, firstOf: null };
function hdA(o, t) { const pre = map.preempt, a = t - (o.t - pre); return a < .4 * pre ? clamp01(a / (.4 * pre)) : clamp01(1 - (a - .4 * pre) / (.3 * pre)); }
function hdFirst() { // (the first object that isn't a spinner)
  if (RPM.firstOf !== map.hit) { RPM.firstOf = map.hit; RPM.first = null; for (const o of map.hit) if (o.kind !== "spinner") { RPM.first = o; break; } }
  return RPM.first;
}
// Flashlight as osu!lazer's: black everywhere but round the light (clear to r, fully black from 1.4 r, smoothstep between, like
// its CircularFlashlight shader); r = 125 osu!px x rpFlScale (auto.js). The cursor stays on top (as in osu!stable). The light is
// drawn once into a sprite whose corners are solid black; each frame it is placed at the light, with four black rectangles round it
const FLM = { c: null, n: 512, edge: 12 };
function flMask() {
  if (FLM.c) return FLM.c;
  const n = FLM.n, c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d"), im = g.createImageData(n, n), d = im.data, R = n / 2 - FLM.edge, r = R / 1.4;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const k = clamp01((Math.hypot(x + .5 - n / 2, y + .5 - n / 2) - r) / (R - r));
    d[(y * n + x) * 4 + 3] = Math.round(255 * k * k * (3 - 2 * k));
  }
  g.putImageData(im, 0, 0); return FLM.c = c;
}
function drawFlashlight(t) {
  const p = rpFlPos(t), x = p[0], y = p[1], D = 125 * 1.4 * rpFlScale(t) * FLM.n / (FLM.n / 2 - FLM.edge), h = D / 2, B = 1e4, e = Math.min(2 / VS, D * FLM.edge / FLM.n / 2);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "#000";
  ctx.drawImage(flMask(), x - h, y - h, D, D);
  ctx.fillRect(-B, -B, 2 * B, y - h + e + B); ctx.fillRect(-B, y + h - e, 2 * B, B); // (overlapping the sprite's solid edge by 2 canvas px: no seams)
  ctx.fillRect(-B, y - h, x - h + e + B, D); ctx.fillRect(x + h - e, y - h, B, D);
}
// hit burst (circle grows 1 -> 1.4 and fades in 240 ms), hit lighting and the 300 judgement
function hitBurst(o, x, y, col, s, age, sliderHead) {
  if (age < 0 || RP.on) return; // (a replay: never Auto's perfect hits at the object time; rpHead draws the player's real ones from the press, once known)
  burstFx(x, y, col, s, age, sliderHead);
}
function burstFx(x, y, col, s, age, sliderHead) {
  if (age < 240 && S.elBurst !== false) { // (Settings → Skin → Hit bursts)
    const k = age / 240, sc = s * (1 + .4 * easeOut(k)), a = 1 - k;
    const c = sliderHead && hasTex("sliderstartcircle") ? "sliderstartcircle" : "hitcircle";
    blit(T(c, col), x, y, sc, a); blit(T("hitcircleoverlay"), x, y, sc, a);
  }
  if (S.fx && age < 600) lighting(x, y, col, s, age);
}
function lighting(x, y, col, s, age) {
  const t = T("lighting", col); if (!t) return;
  ctx.globalCompositeOperation = "lighter";
  blit(t, x, y, s * (1 + .15 * age / 600), .6 * (1 - age / 600));
  ctx.globalCompositeOperation = "source-over";
}
function judgement(x, y, age) { // (osu!'s editor shows no judgements; a replay: never Auto's 300, rpHead shows the player's real 100 / 50 / miss)
  if (!S.judge || age < 0 || age > 450 || edOnNow() || RP.on || S.elBurst === false) return;
  judgeFx(300, x, y, age);
}
const JNAME = { 300: "hit300", 100: "hit100", 50: "hit50", 0: "hit0" }, JFB = { 100: "#b3d944", 50: "#ffcc22", 0: "#ed1121" }; // (JFB: lazer's Ok / Meh / Miss colours)
function judgeFx(j, x, y, age, err) { // (err: the press' error in a replay's 100 / 50, for the early / late word)
  if (!(S.judge || RP.on && j !== 300) || age < 0 || age > 450 || S.elBurst === false || !JNAME[j]) return;
  const sc = age < 96 ? .6 + .5 * (age / 96) : age < 120 ? 1.1 - .2 * ((age - 96) / 24) : .9 + .1 * Math.min(1, (age - 120) / 100), a = age < 250 ? 1 : 1 - (age - 250) / 200;
  if (!j) y += (VFLIP ? -10 : 10) * Math.min(1, age / 450); // (a miss sinks a little, as in osu!; on a flipped picture that is up in the field)
  const im = hitImg(JNAME[j], age);
  if (im) blit(im, x, y, sc * .6, a); else if (j !== 300) judgeFb(j, x, y, sc, a); // (never the 300 image for a 100 / 50 / miss)
  if (S.earlyLate && RP.on && (j === 100 || j === 50) && Number.isFinite(err) && err !== 0) { // early / late, small under the mark (upright and on the other side on a flipped picture, as the number is)
    const w = err < 0 ? tr("EARLY") : tr("LATE"), yy = y + (VFLIP ? -22 : 22) * sc;
    ctx.globalAlpha = a > 1 ? 1 : a; ctx.font = `700 ${Math.round(13 * sc)}px Inter,sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineWidth = 3 * sc; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineJoin = "round";
    if (VFLIP) { ctx.save(); ctx.translate(0, 2 * yy); ctx.scale(1, -1); }
    ctx.strokeText(w, x, yy); ctx.fillStyle = err < 0 ? "#7ed3ff" : "#ffb36b"; ctx.fillText(w, x, yy);
    if (VFLIP) ctx.restore();
    ctx.globalAlpha = 1;
  }
}
// a 100 / 50 / miss when neither the skin nor osu! default has the image (osu! default not loaded): the number in its colour, a red X for a miss
function judgeFb(j, x, y, sc, a) {
  ctx.globalAlpha = a > 1 ? 1 : a; ctx.lineJoin = ctx.lineCap = "round";
  if (j) {
    ctx.font = `800 ${Math.round(30 * sc)}px Inter,sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineWidth = 4 * sc; ctx.strokeStyle = "rgba(0,0,0,.55)";
    if (VFLIP) { ctx.save(); ctx.translate(0, 2 * y); ctx.scale(1, -1); } // (the number upright on a flipped picture)
    ctx.strokeText(String(j), x, y); ctx.fillStyle = JFB[j]; ctx.fillText(String(j), x, y);
    if (VFLIP) ctx.restore();
    return;
  }
  const r = 13 * sc, X = () => { ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); };
  ctx.lineWidth = 9 * sc; ctx.strokeStyle = "rgba(0,0,0,.55)"; X(); ctx.lineWidth = 5.5 * sc; ctx.strokeStyle = JFB[0]; X();
}
// ---- a replay's real hits (circles and slider heads), instead of Auto's: js/replayana.js judges the replay once per replay and map, off the frame
// loop (rpHits starts it); RPH.now is its table by index in map.hit while a replay plays (set each frame; null in the editor, test play, until it is
// ready, and when it can't be trusted: the engine failed or the loaded .osu is not the replay's version). null = no hit effects, as before:
// no effects is better than wrong ones. Hitsounds still follow the object times (audio.js schedule: Auto's)
// RPH.sl / RPH.sp (by index in map.hit, set in the same statement as byI: a frame sees all or nothing): a.sliders / a.spinners as the player
// draws them (rpSlFor / rpSpFor); a missing entry draws that object on Auto's schedule as before
const RPH = { data: null, hit: null, a: null, byI: null, sl: null, sp: null, job: null, now: null, failed: false, fresh: null }; // (failed: tried once and no effects; the next start of the replay tries again)
// Ready before the replay plays: rpuPlay (js/replayui.js) runs rpHitsPrepare under the loading cover, so rpHits below is a cache hit from the very first frame
// and no analysis (35-200 ms of the main thread) runs inside the playback. rpHits itself still starts the same job if a replay was started without it
const rpHitsReady = d => !!d && !!map && !!map.hit && RPH.data === d && RPH.hit === map.hit && !RPH.failed; // (a failed result is not one to keep: every start tries again)
function rpHits() {
  const d = RP.data, h = map && map.hit; if (!d || !h) return null;
  if (RPH.data === d && RPH.hit === h) return RPH.byI;
  if (RPH.job && RPH.job.d === d && RPH.job.h === h) return null; // (already running)
  rpHitsRun(d, RP.mods, false);
  return null;
}
// the analysis of the replay d with its mods for the open map: resolves when RPH holds it (never rejects; a failure is RPH.failed, as in rpHits). It
// runs the same job as rpHits, with or without RP.on. A job for this replay and map that is already running is waited for, not started twice. A failed
// result is tried again by every prepare (rpStart then keeps it: RPH.fresh), so a start that can't have effects does not run the analysis again in its frames
function rpHitsPrepare(d, mods) {
  const h = map && map.hit; if (!d || !h) return Promise.resolve();
  if (RPH.data === d && RPH.hit === h && !RPH.failed) return Promise.resolve();
  if (RPH.job && RPH.job.d === d && RPH.job.h === h) return RPH.job.p;
  return rpHitsRun(d, mods, true);
}
// waits for the next paint (so the loading cover is on screen before the long synchronous analysis)
const rpYield = () => new Promise(r => { let done = false; const go = () => { if (!done) { done = true; r(); } }; setTimeout(go, 120); if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(go, 0)); }); // (after the next paint; a hidden tab has no rAF: the timer)
function rpHitsRun(d, mods, paint) {
  const m = map, h = m.hit, cd = osuFiles[curDiff], f = cd ? files[norm(cd.path)] : null, job = RPH.job = { d, h, p: null }; // (the .osu taken with its map, before any wait)
  RPH.failed = false; RPH.data = RPH.hit = null;
  const sess = typeof RPU !== "undefined" && RPU.sess && RPU.sess.data === d ? RPU.sess : null, want = sess ? (sess.local ? sess.local.want : { bid: sess.info && sess.info.beatmapId, name: sess.info && sess.info.version }) : null;
  const pinned = !!(cd && want && (want.bid && String(cd.meta.bid) === String(want.bid) || want.name && String(cd.meta.version).trim().toLowerCase() === String(want.name).trim().toLowerCase())); // (this difficulty is the replay's by id or name, not a last-resort pick)
  return job.p = (async () => {
    let a = null, by = null, sl = null, sp = null;
    try {
      await loadLazy("replayana");
      if (paint) await rpYield();
      let md5 = ""; try { if (f && typeof md5Hex === "function") md5 = md5Hex(await f.async("uint8array")); } catch {} // ("": not readable, not checked, as replayui's rpuVerify)
      if (paint) await rpYield(); else await new Promise(r => setTimeout(r, 0)); // (not in the frame that asked; or the cover painted first)
      if (RPH.job !== job) return;
      // (the analysis reads map.radius, which a replay's EZ / HR changes in rpStart (diffDerived): the same here, before the start, for this one synchronous call)
      const r0 = m.radius;
      try {
        if (mods && (mods.ez || mods.hr) && typeof replayDiff === "function" && m.diff) {
          const df = m.diff, t = {}; diffDerived(t, replayDiff({ CircleSize: +(df.CircleSize ?? 5), ApproachRate: +(df.ApproachRate ?? df.OverallDifficulty ?? 5), OverallDifficulty: +(df.OverallDifficulty ?? 5), HPDrainRate: +(df.HPDrainRate ?? 5) }, mods));
          if (Number.isFinite(t.radius)) m.radius = t.radius;
        }
        // (run after the start (a retry), the stacks were moved for the flipped picture: the analysis wants the map's own, as before the start)
        const unflip = typeof STACK_FLIPY !== "undefined" && (STACK_FLIPY || (RP.keep && RP.keep.restack)) && RP.keep && RP.keep.m === m;
        if (unflip) { STACK_FLIPY = false; placeStacks(m.hit, RP.keep.radius / 10, true); }
        try { a = rpAnalyze(d, m, mods, { md5 }); }
        finally { if (unflip) { STACK_FLIPY = !!mods.hr; placeStacks(m.hit, r0 / 10, true); if (typeof bodyCache !== "undefined") bodyCache.clear(); } }
      } finally { m.radius = r0; }
      // (a .osu that is not the replay's exact version, md5_mismatch: the effects still show, as the Analysis layer does; Watch has already told the player in a toast)
      if (a && a.ok && a.warn.includes("md5_mismatch") && !pinned) { console.warn("replay hit effects off: another version of the map and not the replay's difficulty"); a = null; }
      else if (a && a.ok && typeof rpHitState === "function") {
        by = new Array(h.length); for (const e of a.hits) if (e && e.i >= 0) by[e.i] = e;
        try { // (sliders / spinners: an odd entry is left out and that object keeps Auto's look)
          if (typeof rpSpinState === "function") {
            sl = new Array(h.length); sp = new Array(h.length);
            for (const e of a.sliders || []) if (e && h[e.i] && h[e.i].kind === "slider") sl[e.i] = rpSlFor(h[e.i], e);
            for (const e of a.spinners || []) if (e && h[e.i] && h[e.i].kind === "spinner") sp[e.i] = rpSpFor(e, d.frames, !!(mods && mods.hr));
          }
        } catch (e) { sl = sp = null; console.warn("replay slider / spinner effects off:", e && e.message || e); }
      }
      else if (a) console.warn("replay hit effects off:", a.warn && a.warn.join(",") || "no result");
    } catch (e) { console.warn("replay hit effects off:", e && e.message || e); }
    if (RPH.job !== job) return; // (a newer replay or map took over)
    RPH.job = null; RPH.data = d; RPH.hit = h; RPH.a = a; RPH.byI = by; RPH.sl = by && sl; RPH.sp = by && sp; RPH.failed = !by; RPH.fresh = d; dirty = true;
  })();
}
// a circle or a slider head in a replay as rpHitState says: the head until the press (a late one stays past its time, the approach circle at full
// size), the burst and lighting from the press, a circle's 100 / 50 / 300 at the press; a miss fades (no lighting) and shows the miss mark
function rpHead(o, t, col, s, aIn, st, sliderHead, he) { // (he: the a.hits entry, for its error)
  const hd = RPM.hd;
  if (st.head > 0) drawHead(o, o.x, o.y, col, s, (hd ? hdA(o, t) : aIn) * st.head, sliderHead);
  if (st.appr && (!hd || o === hdFirst())) drawApproach(o, o.x, o.y, col, s, Math.min(t, o.t));
  if (st.burst >= 0 && !hd) burstFx(o.x, o.y, col, s, st.burst, sliderHead); // (Hidden: the object is gone before the hit, so no hit animation; the 100 / 50 / miss mark stays)
  if (st.jAge >= 0) judgeFx(st.judge, o.x, o.y, st.jAge, he && he.err);
}
// ---- a replay's real slider follow and spinner turning (js/replayana.js a.sliders / a.spinners; set up once per replay in rpHits, never per frame).
// A slider: { e: the a.sliders entry, tk: for each tick in sliderTicks' order (ticks outer, spans inner) its index in e.parts, rp: for repeat k
// (1 .. slides - 1) at rp[k - 1] its index in e.parts } (tk / rp null when the parts don't line up with the map: ticks then keep Auto's look).
// The order is rpaSliders' own: ticks pushed the same way, then repeats, stable-sorted by their nominal time, then the tail
function rpSlFor(o, e) {
  if (!Array.isArray(e.parts) || !Array.isArray(e.track) || !Number.isFinite(e.end)) return null;
  const nt = o.ticks ? o.ticks.length : 0, sl = o.slides | 0, nk = nt * sl, n = nk + Math.max(0, sl - 1), nom = new Float64Array(n), ord = new Array(n);
  let j = 0;
  for (let a = 0; a < nt; a++) for (let k = 0; k < sl; k++) { nom[j] = o.t + o.span * k + (k % 2 ? 1 - o.ticks[a][0] : o.ticks[a][0]) * o.span; ord[j] = j; j++; }
  for (let k = 1; k < sl; k++) { nom[j] = o.t + o.span * k; ord[j] = j; j++; }
  ord.sort((x, y) => nom[x] - nom[y]);
  const pos = new Int32Array(n); ord.forEach((src, p) => { pos[src] = p; });
  let ok = e.parts.length === n + 1 && !!e.parts[n] && e.parts[n].kind === "tail";
  for (let q = 0; ok && q < n; q++) { const p = e.parts[pos[q]]; ok = !!p && Number.isFinite(p.t) && p.kind === (q < nk ? "tick" : "repeat"); }
  return { e, tk: ok ? pos.subarray(0, nk) : null, rp: ok ? pos.subarray(nk) : null };
}
// a spinner: { e, dir: 1 clockwise on screen / -1 the other way, the way the replay mostly turned it (a.spinners counts turns, not their direction) }
function rpSpFor(e, F, hr) {
  if (!e.rot || !e.rot.t || !Number.isFinite(e.t) || !Number.isFinite(e.end)) return null;
  const n = F ? Math.min(F.n | 0, F.t.length) : 0; let sum = 0, last = NaN, f = 0;
  while (f < n && F.t[f] < e.t) f++;
  for (; f < n && F.t[f] < e.end; f++) {
    const a = Math.atan2((hr ? 384 - F.y[f] : F.y[f]) - 192, F.x[f] - 256); // (screen angle, y down: growing = clockwise, as canvas rotation; Hard Rock: drawn mirrored)
    if (last === last && a === a && rpAnaLit(F.k[f])) { let dl = a - last; if (dl > Math.PI) dl -= 2 * Math.PI; else if (dl < -Math.PI) dl += 2 * Math.PI; sum += dl; }
    last = a;
  }
  return { e, dir: sum < 0 ? -1 : 1 };
}
// the follow circle as the replay followed it (e.track): in as Auto's (from 0.5 to 1 and opaque in 180 ms) whenever following starts, out in 150 ms
// (shrinking back to 0.5) when it stops, and none while not followed; followed to the end: Auto's end (shrinks to 0.8, fades in 200 ms) at endPos
const RPFC_IN = 180, RPFC_OUT = 150;
function rpFollowC(o, t, s, e, p) { // p: where the ball is (t <= o.end)
  const T = e.track; let cur = null, last = null;
  for (let k = 0; k < T.length; k++) { const q = T[k]; if (t < q[0]) break; if (t < q[1]) { cur = q; break; } last = q; }
  if (cur) { const fin = easeOut(clamp01((t - cur[0]) / RPFC_IN)); blit(followC(o, t), p[0], p[1], s * (.5 + .5 * fin), fin); return; }
  if (!last) return;
  const fin = easeOut(clamp01((last[1] - last[0]) / RPFC_IN)), age = t - last[1], sc = .5 + .5 * fin;
  if (last[1] >= o.end) { if (age < 200) { const q = t > o.end ? endPos(o) : p; blit(followC(o, t), q[0], q[1], s * sc * (1 - .2 * age / 200), fin * (1 - age / 200)); } return; }
  if (age < RPFC_OUT) { const k = age / RPFC_OUT, q = t > o.end ? endPos(o) : p; blit(followC(o, t), q[0], q[1], s * (.5 + (sc - .5) * (1 - k * k)), fin * (1 - k)); }
}
// one tick once judged (q = 0..1 over its 150 ms): hit = Auto's pop (grows to 1.5x, fades out); missed = no pop, turns red and fades (osu!lazer DrawableSliderTick)
const RP_MISSCOL = [237, 17, 33];
function rpTick(tk, x, y, sc, a, q, hit) {
  if (!tk) return;
  if (hit) blit(tk, x, y, sc * (1 + .5 * easeOut(q)), a * (1 - outQuint(q)));
  else blit(tintOf(tk, RP_MISSCOL), x, y, sc, a * (1 - q));
}
// a repeat arrow once its repeat is judged (osu!lazer DrawableSliderRepeat, min(300, span) ms): hit = grows to 1.5x as it fades out, missed = only fades
function rpArrowPop(o, k, s, age, hit) {
  const dur = Math.min(300, o.span), q = age / dur; if (q < 0 || q >= 1) return;
  const atEnd = k % 2 === 1, p = pointAt(o, atEnd ? 1 : 0), d = pointAt(o, atEnd ? .97 : .03);
  blit(T("reversearrow"), p[0], p[1], s * (hit ? 1 + .5 * easeOut(q) : 1), hit ? 1 - easeOut(q) : 1 - q, Math.atan2(d[1] - p[1], d[0] - p[0]));
}
// the spinner as the replay turned it (rpSpinState): one object reused every frame, handed to drawSpinner as R
const RPSP = { rot: 0, prog: 0, clear: false, clearAge: -1, judge: 0 };
function rpSpin(w, t) {
  const st = w && rpSpinState(w.e, t); if (!st) return null;
  RPSP.rot = w.dir * st.rot * 2 * Math.PI; RPSP.prog = st.prog; RPSP.clear = st.clear; RPSP.clearAge = st.clearAge; RPSP.judge = w.e.judge;
  return RPSP;
}

function drawBody(o, col, a, frac, from = 0) {
  if (a <= 0.003 || frac <= 0 || frac - from <= 0.0005) return;
  const b = sliderBody(o, col, frac, from); if (!b) return; // (a huge body still being painted: skins.js)
  ctx.globalAlpha = a > 1 ? 1 : a;
  ctx.drawImage(b.c, 0, 0, b.sw, b.sh, b.x, b.y, b.w, b.h);
}
// slider end circle (like osu!lazer's tail): where the slider's path ends, a little see-through so the body still shows
// a skin that has a real sliderendcircle uses it (its own, not osu! default's; many skins ship a 1x1 blank one, which counts as none)
function drawEndCircle(o, col, s, a) {
  const p = pointAt(o, 1), k = a * .85, own = SK.tex.sliderendcircle;
  if (own && own.img.width > 8) { blit(T("sliderendcircle", col), p[0], p[1], s, k); blit(SK.tex.sliderendcircleoverlay, p[0], p[1], s, k); return; }
  blit(T("hitcircle", col), p[0], p[1], s, k); blit(T("hitcircleoverlay"), p[0], p[1], s, k);
}
function drawArrow(o, atEnd, s, a, beatK) {
  const p = pointAt(o, atEnd ? 1 : 0), q = pointAt(o, atEnd ? .97 : .03);
  blit(T("reversearrow"), p[0], p[1], s * (1 + .15 * beatK), a, Math.atan2(q[1] - p[1], q[0] - p[0]));
}
// OutElasticHalf (osu!framework), for the ticks
const elOutHalf = k => k >= 1 ? 1 : 2 ** (-10 * k) * Math.sin((.5 * k - .075) * 2 * Math.PI / .3) + 1;
function ballTint(col) { // the colour the ball is tinted (null: as drawn)
  const own = !!SK.frames.sliderb, tint = skOv("ballTint", own ? SK.tintBall : !DEFSK || DEFSK.tintBall) ? col : (own && SK.ballColor); // (Settings → Skin → Ball tint)
  return tint && (tint[0] < 250 || tint[1] < 250 || tint[2] < 250) ? tint : null;
}
// what an upcoming slider needs, made a little ahead so the frame it appears in doesn't have to: its whole body and the
// ball's frames in its colour. One thing a frame at most (a dense stretch of sliders made all at once was a hitch)
const ballWarm = new Map(); // (colour -> how many of the ball's frames are made)
function prepSliders(t, from, to) {
  const H = map.hit;
  for (let i = Math.max(0, from), n = 0; i < H.length && H[i].t < to && n < 8; i++) { // (the next few only: the bodies on screen stay in the cache)
    const o = H[i]; if (o.kind !== "slider" || o.t < t || heavyBody(o)) continue;
    n++;
    const col = palette(o.ci), tint = ballTint(col), wk = tint && SK.id + "|" + tint.join(), fr = ballFrames(), k = wk ? ballWarm.get(wk) || 0 : fr.length;
    if (k < fr.length) { if (ballWarm.size > 64) ballWarm.clear(); for (let j = k; j < Math.min(fr.length, k + 4); j++) tintFrame(fr[j], tint); ballWarm.set(wk, k + 4); return; } // (four a frame: a skin can have sixty)
    bodyPainted = false; sliderBody(o, col, 1); if (bodyPainted) return;
  }
}
function drawBall(o, t, col, s) {
  const b = ballF(o, t), p = pointAt(o, b.f), fr = ballFrames(), own = !!SK.frames.sliderb;
  const tint = ballTint(col);
  let f = fr[Math.floor((t - o.t) * (o.vel || .2) / 4) % fr.length];
  if (tint) f = tintFrame(f, tint);
  const flip = skOv("ballFlip", (own ? SK : DEFSK || FALLBACK).ballFlip !== false); // (SliderBallFlip: the ball turns round on a span back; off, it keeps facing the way the slider started)
  const rot = p[2] + (b.back && flip ? Math.PI : 0);
  // the shadow (nd) and shine (spec) belong to a ball: a skin's own ball gets only the skin's own (osu! default's would sit on top of it)
  const nd = own ? SK.tex["sliderb-nd"] : texOf("sliderb-nd"), spec = own ? SK.tex["sliderb-spec"] : texOf("sliderb-spec");
  blit(nd, p[0], p[1], s, 1, rot);
  blit(f, p[0], p[1], s, 1, rot);
  if (spec) { ctx.globalCompositeOperation = "lighter"; blit(spec, p[0], p[1], s, 1); ctx.globalCompositeOperation = "source-over"; }
  return p;
}

// the part of a slider's body that shows, like osu!'s snaking sliders: it grows in over the first third of the
// preempt (Snaking sliders), and on its last span it shrinks behind the ball (Snaking out, osu!lazer)
function bodyRange(o, t) {
  if (o.path.jumps || o.path.length > 1500) return [0, 1]; // a huge (Aspire) body is drawn once and kept: redrawing it every frame would stall
  let from = 0, to = S.snaking && t < o.t ? clamp01((t - (o.t - map.preempt)) / (map.preempt / 3)) : 1;
  if (S.snakingOut !== false && t >= o.t) { const b = ballF(o, t); if (b.rep >= o.slides - 1) { if (b.back) to = b.f; else from = b.f; } }
  return [from, to];
}
function drawSlider(o, t, col, s, aIn, beatK, st, sl) { // st: a replay's real hit on the head (rpHitState), sl: its real follow (rpSlFor), else none
  const pre = map.preempt, hd = RPM.hd;
  // after the end the slider fades in 240 ms; with snaking out the body itself goes in 40 ms (osu!lazer)
  const arrA = t <= o.end ? aIn : clamp01(1 - (t - o.end) / (S.snakingOut !== false ? 40 : 240));
  let bodyA = arrA, endA = arrA;
  if (hd) { const fs = o.t - pre + map.fadeIn; bodyA = t <= o.end ? aIn * (1 - easeOut(clamp01((t - fs) / Math.max(1, o.end - fs)))) : 0; endA = hdA(o, t); } // (Hidden: the arrows keep arrA)
  const [from, frac] = bodyRange(o, t);
  if (bodyA > 0) drawBody(o, col, bodyA, frac, from);
  sliderTicks(o, t, s, aIn, sl); // (above the body; each pops on its own once passed; a replay's: only the ones it hit)
  if (sl && sl.rp && !hd && t >= o.t) for (let k = 1; k < o.slides; k++) { const q = sl.e.parts[sl.rp[k - 1]]; if (t >= q.t) rpArrowPop(o, k, s, t - q.t, q.hit); } // (Hidden: no hit animation, as on the heads)
  if (arrA > 0) {
    if (t <= o.end) {
      if (S.sliderEnd) drawEndCircle(o, col, s, endA); // always visible when the setting is on (many skins leave sliderendcircle blank)
      else if (hasTex("sliderendcircle")) { const e = endPos(o); blit(T("sliderendcircle", col), e[0], e[1], s, endA); blit(T("sliderendcircleoverlay"), e[0], e[1], s, endA); }
      // repeat arrow i is at the end of span i, until the ball gets there (osu!lazer SliderRepeat / SliderEndCircle): the first comes with the
      // slider, each later one min(2 spans, preempt) before its time, fading in over min(300 ms, a span). So the one at the head shows only once
      // the head is hit (it was drawn from the start, under a see-through head circle)
      if (o.slides > 1 && frac >= 1) for (let i = 0; i < o.slides - 1; i++) {
        const at = o.t + (i + 1) * o.span; if (t >= at) continue;
        const from = at - Math.min(2 * o.span, pre); if (i > 0 && t < from) break;
        drawArrow(o, i % 2 === 0, s, i > 0 ? arrA * clamp01((t - from) / Math.min(300, o.span)) : arrA, beatK);
      }
    }
  }
  if (st) { rpHead(o, t, col, s, aIn, st, true); if (t < o.t) return; }
  else if (t < o.t) {
    drawHead(o, o.x, o.y, col, s, hd ? hdA(o, t) : aIn, true);
    if (!hd || o === hdFirst()) drawApproach(o, o.x, o.y, col, s, t);
    return;
  } else hitBurst(o, o.x, o.y, col, s, t - o.t, true);
  if (t <= o.end) {
    const p = drawBall(o, t, col, s); // (the slider's own ball: on its path by time, in a replay too)
    if (sl) rpFollowC(o, t, s, sl.e, p);
    else { const fin = easeOut(clamp01((t - o.t) / 180)); blit(followC(o, t), p[0], p[1], s * (.5 + .5 * fin), fin); }
  } else {
    const e = endPos(o), age = t - o.end;
    if (sl) rpFollowC(o, t, s, sl.e, e);
    else if (age < 200) blit(followC(o, t), e[0], e[1], s * (1 - .2 * age / 200), 1 - age / 200);
    if (S.fx && age < 600 && !RPH.now) lighting(e[0], e[1], col, s, age); // (a replay's real hits: nothing at the tail)
    if (sl) judgeFx(sl.e.judge, e[0], e[1], age); // (the replay's real result: 100 / 50 / miss always, 300 with Settings → judgements)
    else judgement(e[0], e[1], age);
  }
}

// spinners: osu! "new style" (glow/bottom/top/middle) or "old style" (background/circle/metre), whichever the skin has
function drawSpinner(o, t, P, R) { // P: test play's own turning { rot, prog } (play.js); R: a watched replay's (rpSpin: rot, prog, clear, clearAge, judge); otherwise it spins by itself
  if (t < o.t - 400 || t > o.end + 800) return;
  const a = t < o.t ? clamp01((t - (o.t - 400)) / 400) : t > o.end ? clamp01(1 - (t - o.end) / (RPM.hd ? .3 * map.preempt : 240)) : 1;
  const dur = Math.max(1, o.end - o.t), e = Math.max(0, Math.min(t, o.end) - o.t);
  const rot = P ? P.rot : R ? R.rot : e * .05 - 6 * (1 - Math.exp(-e / 400)), prog = P ? P.prog : R ? R.prog : clamp01(e / Math.min(dur, 1500)), SC = .625, cx = 256, cy = 192, fo = VFLIP ? -1 : 1; // (fo: the field's vertical direction: the spinner's parts that sit above / below its centre swap on a flipped picture)
  if (a > 0) {
    if (SK.newSpinner) {
      ctx.globalCompositeOperation = "lighter"; blit(T("spinner-glow", [3, 151, 255]) || T("spinner-glow"), cx, cy, SC, a * prog); ctx.globalCompositeOperation = "source-over";
      blit(aT("spinner-bottom", animT), cx, cy, SC, a, rot / 3);
      blit(aT("spinner-top", animT), cx, cy, SC, a, rot);
      const mid = T("spinner-middle"); if (mid) blit(prog > .02 ? { img: tintCanvasCached(mid, [255, 255 * (1 - prog), 255 * (1 - prog)]), hd: mid.hd } : mid, cx, cy, SC, a);
      blit(aT("spinner-middle2", animT), cx, cy, SC, a);
    } else {
      let bg = aT("spinner-background", animT); if (bg) { if (SK.spinnerBackground) bg = tintOf(bg, SK.spinnerBackground); blit(bg, cx, cy + 12 * fo, SC, a); } // (SpinnerBackground: the skin's colour on it, only when it names one)
      const met = T("spinner-metre");
      if (met && t >= o.t) { // metre fills from the bottom in 10 steps
        const w = met.img.width / met.hd * SC, hh = met.img.height / met.hd * SC, lit = Math.floor(prog * 10) / 10;
        const cm = cy + 12 * fo; // (the metre's centre; on a flipped picture it is mirrored and drawn upright, filling from the bottom of the screen)
        ctx.globalAlpha = a; if (VFLIP) { ctx.save(); ctx.translate(0, 2 * cm); ctx.scale(1, -1); }
        ctx.drawImage(met.img, 0, met.img.height * (1 - lit), met.img.width, met.img.height * lit, cx - w / 2, cm - hh / 2 + hh * (1 - lit), w, hh * lit);
        if (SK.spinnerNoBlink && lit < .9) ctx.drawImage(met.img, 0, 0, met.img.width, met.img.height * .1, cx - w / 2, cm - hh / 2, w, hh * .1); // (SpinnerNoBlink: the highest bar stays)
        if (VFLIP) ctx.restore();
      }
      blit(aT("spinner-circle", animT), cx, cy, SC, a, rot);
    }
    if (t >= o.t && t <= o.end && !RPM.hd) blit(aT("spinner-approachcircle", animT), cx, cy, SC * (1.86 - 1.76 * (e / dur)), a * .9);
  }
  if (t < o.t + 500) blit(aT("spinner-spin", animT), cx, cy + 110 * fo, SC, t < o.t ? a : 1 - (t - o.t) / 500);
  if ((R ? R.clear : prog >= 1) && t <= o.end + 400) { const age = R ? R.clearAge : Math.max(0, t - (o.t + Math.min(dur, 1500))); blit(aT("spinner-clear", animT), cx, cy - 90 * fo, SC * (1.1 - .1 * clamp01(age / 150)), clamp01(age / 100) * a); }
  if (t > o.end) { if (R) judgeFx(R.judge, cx, cy, t - o.end); else if (!P) judgement(cx, cy, t - o.end); if (S.fx && t - o.end < 300 && !RPH.now) { ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = .3 * (1 - (t - o.end) / 300); ctx.drawImage(GLOW, cx - 260, cy - 260, 520, 520); ctx.globalCompositeOperation = "source-over"; } } // (a replay: its real result when known (R), never the glow)
}
// SpinnerFadePlayfield: black bars over the top and the bottom of the playfield while a spinner is on, fading in and out with it
function spinBars(t, lo, hi) {
  if (!SK.spinnerFadePlayfield || EDIT.on) return;
  const H = map.hit; let a = 0;
  for (let i = hi; i >= lo; i--) {
    const o = H[i]; if (o.kind !== "spinner" || t < o.t - 400 || t > o.end + 800) continue;
    a = Math.max(a, t < o.t ? clamp01((t - (o.t - 400)) / 400) : t > o.end ? clamp01(1 - (t - o.end) / 240) : 1);
  }
  if (a <= 0) return;
  const k = ALPHA.k; ALPHA.k = 1; // (a playfield effect: Object opacity does not fade it)
  ctx.globalAlpha = a * .85; ctx.fillStyle = "#000";
  ctx.fillRect(-1e4, -1e4, 2e4, 1e4 + 30); ctx.fillRect(-1e4, 338, 2e4, 1e4); // (in the playfield's own space: 86 px of the 480 at each end)
  ctx.globalAlpha = 1; ALPHA.k = k;
}
const tintMid = new Map();
function tintCanvasCached(t, col) { // spinner middle turns red as the spinner fills (quantised so it's cached)
  const q = Math.round(col[1] / 16) * 16, key = t.img.width + "|" + q;
  let c = tintMid.get(key); if (!c) { c = tintCanvas(t.img, [255, q, q]); tintMid.set(key, c); if (tintMid.size > 20) tintMid.delete(tintMid.keys().next().value); }
  return c;
}

// ---------- the map's background video (mp4 / webm the browser can play; .avi / .flv are skipped) ----------
const VID = { el: null, f: null, ok: false, url: "" };
function vidFor() {
  const f = S.video !== false && map && map.video ? files[norm(map.video)] : null;
  if (!f) { if (VID.f) vidReset(); return null; }
  if (VID.f !== f) {
    vidReset(); VID.f = f;
    f.async("blob").then(b => {
      if (VID.f !== f) return;
      const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto";
      v.onloadeddata = () => { VID.ok = true; dirty = true; }; v.onseeked = () => { dirty = true; }; v.onerror = () => { VID.ok = false; };
      VID.url = URL.createObjectURL(b); v.src = VID.url; VID.el = v;
    }).catch(() => {});
  }
  return VID.ok ? VID.el : null;
}
function vidReset() { if (VID.el) { VID.el.pause(); VID.el.removeAttribute("src"); VID.el.load(); } if (VID.url) URL.revokeObjectURL(VID.url); VID.el = VID.f = null; VID.ok = false; VID.url = ""; }
// keep it at the song's time: playing along (re-seeked when it drifts), or showing the frame of a paused / scrubbed time
function vidSync(v, t) {
  const want = (t - (map.videoOffset || 0)) / 1000, playing = typeof isPlaying === "function" && isPlaying();
  if (want < 0 || !(want < v.duration)) { if (!v.paused) v.pause(); return false; }
  if (v.playbackRate !== (A.rate || 1)) v.playbackRate = A.rate || 1;
  if (playing) { if (v.paused) v.play().catch(() => {}); if (Math.abs(v.currentTime - want) > .25 && !v.seeking) v.currentTime = want; }
  else { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - want) > .03 && !v.seeking) v.currentTime = want; }
  return true;
}

// follow points between objects of the same combo
const FP_PRE = 800;
function drawFollowPoints(t, lo, hi) {
  if (S.followPts === false) return; // Settings → Display → Follow points
  const H = map.hit, tex = T("followpoint"); if (!tex) return;
  const fi = map.fadeIn, anim = aFrames("followpoint").length > 0; // (followpoint-N: each point plays its animation from when it shows)
  for (let i = Math.max(1, lo); i <= Math.min(H.length - 1, hi + 1); i++) {
    const b = H[i], a = H[i - 1];
    if (b.nc || a.kind === "spinner" || b.kind === "spinner") continue;
    if (t < a.end - FP_PRE - fi || t > b.t + fi) continue;
    const pa = endPos(a), dx = b.x - pa[0], dy = b.y - pa[1], dist = Math.hypot(dx, dy);
    if (dist < 48) continue;
    const ang = Math.atan2(dy, dx), dur = b.t - a.end;
    for (let d = 48; d < dist - 32; d += 32) {
      const f = d / dist, out = a.end + f * dur, inn = out - FP_PRE;
      if (t < inn || t > out + fi) continue;
      const k = clamp01((t - inn) / fi), al = t > out ? 1 - (t - out) / fi : k;
      blit(anim ? aT("followpoint", t - inn) : tex, pa[0] + dx * f, pa[1] + dy * f, 1.5 - .5 * easeOut(k), al, ang);
    }
  }
}

// editor view, like osu!'s editor (osu!lazer, which matches stable; it plays the map with autoplay underneath, so
// every object is hit exactly on time). With hit markers (the default; Settings → Editor) a circle, and a slider's
// head, repeats and tail, turns white once reached and fades out over 700 ms where it is, so recent objects stay
// visible for reference, and a ring in the combo colour marks the moment a circle or slider head is reached. The rest
// is as in gameplay with autoplay: the slider body fades 240 ms after the end, ticks pop as they're passed, the
// follow circle follows the ball, spinners spin. Without hit markers objects play their hit animations like in
// gameplay. No judgements either way.
const ED_FADE = 700, WHITE = [255, 255, 255];
const ED_PASS = { col: null }; // (the colour an object turns once passed: white, or Compare's ghost colour while the ghost is drawn)
const outQuint = k => 1 - (1 - k) ** 5;
const edMarkers = () => S.edHitMarkers !== false;
// osu!'s HitCircleOverlapMarker: a ring (4 px of a 128 px circle) that grows to 1.1x in 350 ms (OutQuint) while it
// fades from 0.9 over 700 ms (ease in)
function edHitMarker(x, y, col, t, at) {
  const age = t - at; if (age < 0 || age >= ED_FADE) return;
  const r = map.radius, ring = outQuint(clamp01(age / (ED_FADE / 2))), k = age / ED_FADE, lw = 4 * r / 64;
  ctx.globalAlpha = .9 * (1 - k * k); ctx.strokeStyle = `rgb(${col[0]},${col[1]},${col[2]})`; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.arc(x, y, r * (1 + .1 * ring) - lw / 2, 0, 7); ctx.stroke();
}
// a circle (or slider head) where it is: as it is before its time, white and fading (linear, 700 ms) after
function edCircle(o, x, y, col, s, aIn, t, at, sliderHead) {
  if (t < at) { drawHead(o, x, y, col, s, aIn, sliderHead); return; }
  const a = 1 - (t - at) / ED_FADE; if (a > 0) drawHead(o, x, y, ED_PASS.col || WHITE, s, a, sliderHead);
}
// slider ticks as osu! has them (gameplay with autoplay, and the editor): one per tick per span, each appearing (tick time - span start) / 2 + 0.66 preempt
// before it (200 ms on repeats) with a 150 ms fade and an elastic scale from 0.5, and popping when passed (autoplay
// hits it): 150 ms fade out (OutQuint) while growing to 1.5x
// A replay's (sl: rpSlFor): each tick stays until the replay's judgement of it (later than its time after a late head) and pops only when hit (rpTick)
function sliderTicks(o, t, s, aIn, sl) {
  if (!o.ticks || !o.ticks.length) return;
  const tk = T("sliderscorepoint"), P = sl && sl.tk ? sl.e.parts : null;
  let j = -1;
  for (const [fr] of o.ticks) for (let k = 0; k < o.slides; k++) {
    j++;
    const ss = o.t + o.span * k, tt = ss + (k % 2 ? 1 - fr : fr) * o.span, appear = tt - ((tt - ss) / 2 + (k ? 200 : map.preempt * .66)), q = P ? P[sl.tk[j]] : null, jt = q ? q.t : tt;
    if (t < appear || t >= jt + 150) continue;
    const p = pointAt(o, fr), sc = .5 + .5 * elOutHalf(clamp01((t - appear) / 600));
    if (t < jt) { const d = RPM.hd ? Math.min(tt - appear - 150, 1000) : 0; blit(tk, p[0], p[1], s * sc, aIn * clamp01((t - appear) / 150) * (RPM.hd ? (d > 0 ? clamp01((tt - t) / d) : 0) : 1)); } // (Hidden: fading out until reached)
    else if (RPM.hd) continue;
    else if (q) rpTick(tk, p[0], p[1], s * sc, aIn, (t - jt) / 150, q.hit);
    else { const q = (t - tt) / 150; blit(tk, p[0], p[1], s * sc * (1 + .5 * easeOut(q)), aIn * (1 - outQuint(q))); }
  }
}
function edSelection(o, s, a) {
  const r = map.radius, selT = texOf("hitcircleselect");
  if (o.kind === "spinner") { ctx.globalAlpha = a; ctx.strokeStyle = "#66ccff"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(256, 192, 190, 0, 7); ctx.stroke(); return; }
  if (o.kind === "slider") { const e = endPos(o); if (selT) blit(selT, e[0], e[1], s, a); }
  if (selT) blit(selT, o.x, o.y, s, a); else { ctx.globalAlpha = a; ctx.strokeStyle = "#66ccff"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(o.x, o.y, r * 1.05, 0, 7); ctx.stroke(); }
}
function drawEditObj(o, t, col, s, aIn, beatK) {
  const r = map.radius, sel = EDIT.sel.has(o.lid), mk = edMarkers();
  const objA = t <= o.end ? aIn : clamp01(1 - (t - o.end) / (mk && o.kind !== "spinner" ? ED_FADE : 240)); // (selection: while the object shows)
  if (objA <= 0) return;
  if (sel && o.p2d) { ctx.globalAlpha = .55 * objA; ctx.strokeStyle = "#66ccff"; ctx.lineJoin = ctx.lineCap = "round"; ctx.lineWidth = r * 2.3; ctx.stroke(o.p2d); }
  if (o.kind === "spinner" || !mk) { // as in gameplay (with autoplay)
    if (o.kind === "spinner") drawSpinner(o, t);
    else if (o.kind === "slider") drawSlider(o, t, col, s, aIn, beatK);
    else if (t < o.t) { drawHead(o, o.x, o.y, col, s, aIn); drawApproach(o, o.x, o.y, col, s, t); }
    else hitBurst(o, o.x, o.y, col, s, t - o.t);
    if (sel) edSelection(o, s, objA);
    return;
  }
  if (o.kind === "slider") {
    const bodyA = t <= o.end ? aIn : clamp01(1 - (t - o.end) / 240), [from, frac] = bodyRange(o, t); // (snaking in and out as in gameplay)
    if (bodyA > 0) drawBody(o, col, bodyA, frac, from);
    sliderTicks(o, t, s, aIn);
    // the tail: as it is until the slider ends, then white and fading
    if (S.sliderEnd) { if (t <= o.end) drawEndCircle(o, col, s, aIn); else { const ta = 1 - (t - o.end) / ED_FADE; if (ta > 0) drawEndCircle(o, ED_PASS.col || WHITE, s, ta); } }
    else if (bodyA > 0) { const e = endPos(o); ctx.globalAlpha = bodyA * .8; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(e[0], e[1], r * .25, 0, 7); ctx.stroke(); }
    // repeat arrows until their repeat is reached (repeat k is at the end of the path when k is odd)
    if (frac >= 1) for (let k = 1; k < o.slides; k++) if (t < o.t + o.span * k) drawArrow(o, k % 2 === 1, s, aIn, 0);
    if (t >= o.t && t <= o.end) { const fin = easeOut(clamp01((t - o.t) / 180)), p = drawBall(o, t, col, s); blit(followC(o, t), p[0], p[1], s * (.5 + .5 * fin), fin); }
    else if (t > o.end && t - o.end < 200) { const e = endPos(o), age = t - o.end; blit(followC(o, t), e[0], e[1], s * (1 - .2 * age / 200), 1 - age / 200); }
  }
  edCircle(o, o.x, o.y, col, s, aIn, t, o.t, o.kind === "slider");
  edHitMarker(o.x, o.y, col, t, o.t);
  if (sel) edSelection(o, s, objA);
  // the approach circle closes in, then fades out within 50 ms of the hit
  if (t < o.t) drawApproach(o, o.x, o.y, col, s, t);
  else if (t < o.t + 50 && S.elApproach !== false) blit(T("approachcircle", col), o.x, o.y, s, approachAlpha(o, o.t) * (1 - (t - o.t) / 50));
}

// a layer opacity for a whole group of drawing (Compare: the other version faint, this one at its own opacity): while
// ALPHA.k is under 1 every globalAlpha the drawing code sets is multiplied by it (save / restore inside stay balanced)
const ALPHA = { k: 1 };
{
  const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, "globalAlpha");
  if (d && d.get && d.set) Object.defineProperty(ctx, "globalAlpha", { configurable: true, get() { return d.get.call(this) / ALPHA.k; }, set(v) { d.set.call(this, v * ALPHA.k); } });
}
function withAlpha(k, fn) {
  const was = ALPHA.k; ALPHA.k = Math.max(.01, Math.min(1, k)); ctx.globalAlpha = 1;
  try { fn(); } finally { ALPHA.k = was; ctx.globalAlpha = 1; }
}
// the editor: every selected object stays on the playfield, faint with a blue outline, also outside the current time
// (osu!stable: Ctrl+A shows the whole selection). Drawn once into a layer, again only when the selection, the map or
// the view changes; it moves along while the selection is dragged.
const SELG = { c: null, b: null, key: "", sel: null, hit: null };
function drawSelGhosts() {
  const sel = EDIT.sel; if (!sel.size) return;
  const m = ctx.getTransform(), W = cv.width, Hh = cv.height, key = [sel.size, m.a, m.b, m.c, m.d, m.e, m.f, W, Hh].join();
  if (SELG.key !== key || SELG.sel !== sel || SELG.hit !== map.hit) {
    SELG.key = key; SELG.sel = sel; SELG.hit = map.hit;
    const layer = c => { c = c || document.createElement("canvas"); if (c.width !== W || c.height !== Hh) { c.width = W; c.height = Hh; }
      const g = c.getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, Hh); g.setTransform(m); g.lineJoin = g.lineCap = "round"; g.strokeStyle = "#66ccff"; return [c, g]; };
    const [b, gb] = layer(SELG.b), [c, gc] = layer(SELG.c), r = map.radius; SELG.b = b; SELG.c = c;
    gb.lineWidth = r * 2; gc.lineWidth = Math.max(2, r * .12);
    for (const o of map.hit) if (sel.has(o.lid) && o.kind !== "spinner") { // (bodies: one layer, faint as a whole; overlaps don't add up)
      if (o.p2d) gb.stroke(o.p2d);
      gc.beginPath(); gc.arc(o.x, o.y, r * .92, 0, 7); gc.stroke();
    }
  }
  const dx = EDIT.drag ? EDIT.dx : 0, dy = EDIT.drag ? EDIT.dy : 0;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, m.a * dx + m.c * dy, m.b * dx + m.d * dy);
  ctx.globalAlpha = .13; ctx.drawImage(SELG.b, 0, 0); ctx.globalAlpha = .6; ctx.drawImage(SELG.c, 0, 0); ctx.restore();
}
function drawObjects(t, beatK) {
  const H = map.hit, pre = map.preempt, s = map.radius / 64, ed = EDIT.on, keep = 800;
  if (ed) drawSelGhosts();
  const hi = lastBefore(H, t + pre, "t");
  if (hi < 0) return;
  let lo = hi; while (lo > 0 && H[lo - 1].t > t - 30000) lo--;
  drawFollowPoints(t, lo, hi);
  for (let i = hi + 1; i < H.length && H[i].t < t + pre + 4000; i++) if (H[i].kind === "slider" && heavyBody(H[i])) sliderBody(H[i], palette(H[i].ci), 1); // huge bodies: painted ahead (skins.js)
  prepSliders(t, hi - 16, t + pre + 1500);
  const drag = ed && EDIT.drag;
  spinBars(t, lo, hi);
  for (let i = hi; i >= lo; i--) {
    const o = H[i];
    if (o.end + keep < t) continue;
    const col = palette(o.ci), aIn = clamp01((t - (o.t - pre)) / map.fadeIn), st = RPH.now && o.kind !== "spinner" ? rpHitState(RPH.now[i], t, RPH.a.windows) : null;
    const moved = drag && EDIT.sel.has(o.lid) && o.kind !== "spinner";
    if (moved) { ctx.save(); ctx.translate(EDIT.dx, EDIT.dy); }
    if (ed) drawEditObj(o, t, col, s, aIn, beatK);
    else if (o.kind === "spinner") { const R = RPH.now && RPH.sp ? rpSpin(RPH.sp[i], t) : null; if (R) drawSpinner(o, t, null, R); else drawSpinner(o, t); } // (a replay's real turning, once known)
    else if (o.kind === "slider") drawSlider(o, t, col, s, aIn, beatK, st, RPH.now && RPH.sl ? RPH.sl[i] : null);
    else if (st) rpHead(o, t, col, s, aIn, st, false, RPH.now[i]);
    else if (t < o.t) {
      drawHead(o, o.x, o.y, col, s, RPM.hd ? hdA(o, t) : aIn);
      if (!RPM.hd || o === hdFirst()) drawApproach(o, o.x, o.y, col, s, t);
    } else { hitBurst(o, o.x, o.y, col, s, t - o.t); judgement(o.x, o.y, t - o.t); }
    if (moved) ctx.restore();
  }
}

// cursor-ripple (the skin's own, additive): a ring that spreads and fades where a key went down (Auto's presses, the replay's, test play's)
const RIP = { src: null, t: new Float64Array(0) };
function ripTimes() { // when a key went down (sorted; built once per map / replay)
  const src = RP.on ? rpPresses() : autoFrames();
  if (!src) return RIP.t;
  if (RIP.src !== src) {
    const a = [];
    if (RP.on) { for (const P of src) for (const x of P) a.push(x); }
    else { let prev = 0; for (const f of src) { if (f.b > 0 && f.b !== prev) a.push(f.t); prev = f.b; } }
    a.sort((x, y) => x - y); RIP.src = src; RIP.t = Float64Array.from(a);
  }
  return RIP.t;
}
function drawRipple(x, y, age, z) {
  const rip = SK.tex["cursor-ripple"]; if (!rip || age < 0 || age >= 500) return;
  const k = age / 500;
  ctx.globalCompositeOperation = "lighter"; blit(rip, x, y, (.6 + 1.0 * easeOut(k)) * z, .6 * (1 - k)); ctx.globalCompositeOperation = "source-over";
}
function drawRipples(t, z) {
  if (!SK.tex["cursor-ripple"]) return;
  const T0 = ripTimes(); let lo = 0, hi = T0.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (T0[m] <= t) lo = m + 1; else hi = m; }
  for (let i = lo - 1; i >= 0 && t - T0[i] < 500; i--) { const p = cursorAt(T0[i]); drawRipple(p[0], p[1], t - T0[i], z); }
}
// like osu!: a skin that has its own cursor uses only its own cursormiddle and cursortrail (none if it has none);
// the default skin's parts are never mixed in (that drew two cursors on top of each other). CursorRotate turns the
// cursor slowly; CursorCentre: 0 puts its top-left corner on the position. Settings → Skin: size, trail, rotate and expand
// (CursorExpand), each "as the skin says" unless changed; CursorTrailRotate turns the trail with the cursor
function drawCursor(t) {
  const own = !!SK.tex.cursor, cfg = own ? SK : DEFSK && DEFSK.tex.cursor ? DEFSK : FALLBACK;
  const tex = n => own ? SK.tex[n] || null : texOf(n);
  const cur = tex("cursor"), mid = tex("cursormiddle"), trail = tex("cursortrail"), z = curZ();
  const off = (tx, s = 1) => tx && cfg.cursorCentre === false ? [tx.img.width / tx.hd * s / 2, (VFLIP ? -1 : 1) * tx.img.height / tx.hd * s / 2] : [0, 0];
  const rot = skOv("curRotate", cfg.cursorRotate) ? (performance.now() / 10000 % 1) * Math.PI * 2 : 0;
  if (trail && S.curTrail !== false) {
    const n = mid ? 16 : 8, step = mid ? 4 : 8, o = off(trail, z), tRot = cfg.cursorTrailRotate === true ? rot : 0;
    for (let k = n; k >= 1; k--) { const p = cursorAt(t - k * step); blit(trail, p[0] + o[0], p[1] + o[1], z, (1 - k / n) * .8, tRot); }
  }
  drawRipples(t, z);
  const p = cursorAt(t), x = p[0], y = p[1];
  const ex = S.curExpand === "off" ? false : S.curExpand === "on" ? true : RP.on || cfg.cursorExpand !== false;
  const e = ex ? autoCursorScale(t) : 1, sc = e * z, ms = (RP.on ? e : 1) * z; // (expands while Auto holds a button, like osu!; a replay's keys always do)
  const oc = off(cur, sc); blit(cur, x + oc[0], y + oc[1], sc, 1, rot);
  const om = off(mid, ms); blit(mid, x + om[0], y + om[1], ms, 1);
}

function drawKiai(t) {
  const k = kiaiAt(t); if (!k) return;
  const b = beatInfo(t), len = b.len || 500;
  const phase = (((t - b.off) % len) + len) % len / len;
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = .06 * (1 - phase) ** 3; ctx.fillStyle = "#fff"; ctx.fillRect(-107, 0, 854, 480);
  if (S.quality !== "low") {
    const bi = Math.floor((t - b.off) / len);
    for (let back = 0; back < 5; back++) {
      const nb = bi - back, bt = b.off + nb * len, age = t - bt;
      if (bt < k[0] || age < 0 || age > 1500) continue;
      ctx.globalAlpha = Math.max(0, 1 - age / 1500) * .85;
      for (let j = 0; j < 5; j++) {
        const dot = fxTex(DOT, palette(nb + j));
        for (let side = 0; side < 2; side++) {
          const seed = nb * 97 + j * 13 + side * 7, pr = 2 + rand(seed + 3) * 3;
          const x = (side ? 747 - rand(seed) * 80 : -107 + rand(seed) * 80) + (side ? -1 : 1) * (.02 + rand(seed + 2) * .07) * age;
          const y = 490 - (.3 + rand(seed + 1) * .22) * age + .00013 * age * age;
          ctx.drawImage(dot, x - pr, y - pr, pr * 2, pr * 2);
        }
      }
    }
  }
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
}

// cheap text shadow: an offset dark copy instead of shadowBlur
function sText(txt, x, y, u, col) {
  ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillText(txt, x + 1.5 * u, y + 1.5 * u);
  ctx.fillStyle = col; ctx.fillText(txt, x, y);
}
let dispScore = 0, lastFrame = performance.now();
// box = visible 16:9 (or full) area in logical px: {l, t, r, b, u, top, bottom}
function hudBox(bx, by, bw, bh, LW, LH, SF, rotated) {
  const dpr = cv.dpr || 1, uiShown = !UI.ui.classList.contains("hide") && !rotated && !EDIT.on;
  const l = Math.max(bx, SF.l), r = Math.min(bx + bw, LW - SF.r), t = Math.max(by, SF.t), b = Math.min(by + bh, LH - SF.b);
  const u = Math.max(.45 * dpr, Math.min(bw, bh) / 520);
  const top = t + (uiShown ? Math.max(0, SF.t + 60 * dpr - t) : 0);
  const bottom = b - (uiShown ? Math.max(0, b - (LH - SF.b - 80 * dpr)) : 0);
  return { l, t, r, b, u, top, bottom };
}
let hbGrad = null, hbKey = "";
// the replay's real final numbers (lazer replays: the accuracy lazer wrote, as the results screen shows), cached per replay
let RPC = { d: null, score: 0, acc: 1, miss: 0, combo: 0, fc: false, end: 0, den: 1, cden: 1, key: null };
function rpFinals() {
  const d = RP.data; if (!d) return RPC;
  if (RPC.d === d && RPC.key === map.score) return RPC;
  const li = d.lazerInfo, raw = li && li.raw, st = li && li.statistics && typeof li.statistics === "object" ? li.statistics : null, c = d.counts || {};
  const ra = raw && Number(raw.accuracy);
  let counts = c; if (st && ["great", "ok", "meh", "miss"].some(k => Number.isFinite(+st[k]))) { const g = k => (Number.isFinite(+st[k]) ? +st[k] : 0); counts = { n300: g("great"), n100: g("ok"), n50: g("meh"), miss: g("miss") }; }
  RPC.d = d; RPC.key = map.score;
  RPC.score = +d.score || 0;
  RPC.acc = d.lazer && Number.isFinite(ra) && ra >= 0 && ra <= 1 ? ra : typeof replayAccuracy === "function" ? replayAccuracy(counts) : 1;
  RPC.miss = +counts.miss || 0; RPC.combo = Math.max(0, +d.maxCombo || 0); RPC.fc = !!d.perfect;
  // Auto's perfect play up to the replay's last frame is what the real totals are spread over (a replay that ends early, a fail, still ends on its own score)
  const ev = map.score, F = d.frames, j = ev.length ? lastBefore(ev, F && F.n ? F.t[F.n - 1] : 0, "t") : -1;
  RPC.den = j >= 0 ? ev[j].score || 1 : 1; RPC.cden = j >= 0 ? ev[j].combo || 1 : 1;
  return RPC;
}
// the replay's running score at t (an ESTIMATE, see drawHUD): the HUD's score and the live Top 50 board both come from it
function rpScoreAt(t) { const R = rpFinals(), ev = map.score, i = lastBefore(ev, t, "t"); return i >= 0 ? Math.round(R.score * Math.min(1, ev[i].score / R.den)) : 0; }
// the replay's analysis when it is ready for this very replay and map and agrees with the replay's own counts (the combo, the hit error bar and the UR are drawn from it); else null
function rpTrusted() {
  const a = RPH.a;
  return a && a.ok && RPH.data === RP.data && RPH.hit === map.hit && typeof rpAnaPoor === "function" && !rpAnaPoor(a) ? a : null;
}
// the hit error bar and the unstable rate (UR), like osu!: a bar with the 300 / 100 / 50 windows (in real ms: the song time over the rate), a tick for each hit in the last 3 s
// (left = early, right = late, in the colour of its judgement from |error|), an arrow at the average of the last 10, and "UR" over the hits so far. Settings: S.hitBar, S.urHud
const BAR_COL = { 300: "#66ccff", 100: "#b3d944", 50: "#ffcc22" }, BAR_FADE = 3000, BAR_AVG = 10;
function drawHitBar(t, B) {
  if (!(S.hitBar || S.urHud) || typeof rpHitBar !== "function") return;
  const a = rpTrusted(); if (!a || !RPH.byI || a.warn.includes("md5_mismatch")) return; // (another version of the map: its errors are not the player's)
  const bar = rpHitBar(a); if (!bar) return;
  const q = cv.dpr || 1, sz = S.hitBarSize / 100, u = Math.max(B.u, .8 * q) * sz; // (sizes in osu!px, but never smaller than readable on a phone: floors in device pixels, as the Top 50 board; Settings → On screen: the bar's size, 40 % by default)
  const rate = a.rate > 0 ? a.rate : 1, jw = a.judge || a.windows, span = (jw.w50 || 150) / rate, cx = (B.l + B.r) / 2, ay = B.bottom - 8 * q - 10 * u;
  const bw = Math.max(Math.min((B.r - B.l) * .34 * sz, 300 * u), Math.min(150 * q * sz, (B.r - B.l) * .5)), ppm = bw / 2 / span;
  const k = rpBarAt(bar, t, BAR_FADE, BAR_AVG), ur = S.urHud ? rpUrAt(bar, rate, t) : null;
  ctx.save(); ctx.globalAlpha = 1; ctx.textBaseline = "alphabetic";
  if (S.hitBar) {
    const bh = 6 * u, y = ay - bh / 2, band = (w, col, al) => { ctx.globalAlpha = al; ctx.fillStyle = col; ctx.fillRect(cx - w * ppm, y, 2 * w * ppm, bh); };
    ctx.globalAlpha = .45; ctx.fillStyle = "#000"; ctx.fillRect(cx - bw / 2 - 2 * u, y - 2 * u, bw + 4 * u, bh + 4 * u);
    band(span, BAR_COL[50], .55); band(jw.w100 / rate, BAR_COL[100], .7); band(jw.w300 / rate, BAR_COL[300], .8);
    for (let i = k.from; i < k.k; i++) { // (the oldest first: the newest tick on top)
      const age = t - bar.t[i], e = Math.max(-span, Math.min(span, bar.e[i] / rate)), col = BAR_COL[rpErrClass(bar.e[i], jw)];
      ctx.globalAlpha = Math.max(0, 1 - age / BAR_FADE) * .9; ctx.fillStyle = col; ctx.fillRect(cx + e * ppm - u, ay - 8 * u, 2 * u, 16 * u);
      ctx.globalAlpha *= .6; ctx.fillStyle = "#fff"; ctx.fillRect(cx + e * ppm - .5 * u, ay - 8 * u, u, 16 * u);
    }
    ctx.globalAlpha = .9; ctx.fillStyle = "#fff"; ctx.fillRect(cx - .75 * u, ay - 9 * u, 1.5 * u, 18 * u); // (the centre: a perfect hit)
    if (k.avg !== null) { const x = cx + Math.max(-span, Math.min(span, k.avg / rate)) * ppm; ctx.beginPath(); ctx.moveTo(x, ay - 11 * u); ctx.lineTo(x - 4.5 * u, ay - 18 * u); ctx.lineTo(x + 4.5 * u, ay - 18 * u); ctx.closePath(); ctx.fillStyle = "#fff"; ctx.globalAlpha = .95; ctx.fill(); }
    ctx.font = `600 ${Math.max(9 * u, 8 * q * sz)}px Inter,sans-serif`; ctx.globalAlpha = .6; ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle"; ctx.textAlign = "right"; ctx.fillText(tr("EARLY"), cx - bw / 2 - 8 * u, ay); ctx.textAlign = "left"; ctx.fillText(tr("LATE"), cx + bw / 2 + 8 * u, ay);
  }
  if (ur !== null) {
    ctx.globalAlpha = 1; ctx.font = `600 ${Math.max(15 * u, 12 * q * sz)}px Inter,sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    sText("UR " + ur.toFixed(ur < 100 ? 1 : 0), cx, S.hitBar ? ay - 24 * u : ay, u, "#fff");
  }
  ctx.restore();
}
// ---- the HUD in the skin's own numbers and health bar (score-0..9 / combo-0..9 by ScorePrefix / ComboPrefix, scorebar-*): a skin pixel is HUD_F osu!px (a 1366 x 768 screen shows
// skin pixels as they are: .625 of a 640 x 480 osu!px, as the input overlay's keys), the accuracy line is .6 of the score's. A line the skin can't draw (a missing glyph), or a skin
// without the font, stays text as before (osu! default has neither the digits nor the bar here); the current skin only (osu! default does not fill in for it)
const HUD_F = .625, HUDB = { bottom: 0 }; // (HUDB.bottom: where the health bar ends, the Top 50 board starts below it)
function hudScore(sc, acc, right, top, u) {
  const SF = SK.fonts && SK.fonts.score, L = hudLayout(SF, sc, HUD_F * u), A2 = hudLayout(SF, acc, HUD_F * u * .6);
  if (L) hudDraw(L, right - L.width, top); else { ctx.font = `600 ${34 * u}px Inter,sans-serif`; sText(sc, right, top, u, "#fff"); }
  if (A2) hudDraw(A2, right - A2.width, top + 40 * u); else { ctx.font = `600 ${18 * u}px Inter,sans-serif`; sText(acc, right, top + 40 * u, u, "#fff"); }
}
function hudCombo(combo, left, bottom, pop, u) {
  const CL = hudLayout(SK.fonts && SK.fonts.combo, combo + "x", HUD_F * u * 1.35);
  ctx.save(); ctx.translate(left, bottom); ctx.scale(pop, pop);
  if (CL) hudDraw(CL, 0, -CL.height);
  else { ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.globalAlpha = 1; ctx.font = `600 ${46 * u}px Inter,sans-serif`; sText(combo + "x", 0, 0, u, "#fff"); }
  ctx.restore();
}
// the skin's health bar: scorebar-bg at the corner, scorebar-colour cropped to the health and drawn inside it, the marker / ki at its end (lazer's legacy health display: the fill is
// offset (7.5, 7.8) skin px in a skin with scorebar-marker, (3, 10) with the old ki). A 1 px image is the skin hiding that part. -> where it ends, or -1 when the skin has no bar (the default one is drawn)
const hudReal = x => !!(x && x.img && x.img.width > 2 && x.img.height > 1);
function drawSkinHealth(x0, y0, hp, u, W) {
  const col = skTexFrame(SK, "scorebar-colour", performance.now(), SK.animFps, false); if (!hudReal(col)) return -1;
  const f = Math.min(HUD_F * u, W * .5 / (col.img.width / col.hd)), bg = SK.tex["scorebar-bg"], mk = SK.tex["scorebar-marker"], newStyle = hudReal(mk);
  const ox = (newStyle ? 7.5 : 3) * f, oy = (newStyle ? 7.8 : 10) * f, fw = col.img.width / col.hd * f, fh = col.img.height / col.hd * f, v = Math.max(0, Math.min(1, hp));
  ctx.globalAlpha = 1; let bottom = y0 + oy + fh;
  if (hudReal(bg)) { const bh = bg.img.height / bg.hd * f; ctx.drawImage(bg.img, x0, y0, bg.img.width / bg.hd * f, bh); bottom = Math.max(bottom, y0 + bh); }
  if (v > 0) ctx.drawImage(col.img, 0, 0, col.img.width * v, col.img.height, x0 + ox, y0 + oy, fw * v, fh);
  const m = newStyle ? mk : [SK.tex["scorebar-kidanger2"], SK.tex["scorebar-kidanger"], SK.tex["scorebar-ki"]][v < .25 ? 0 : v < .5 ? 1 : 2];
  const ms = hudReal(m) ? m : !newStyle && hudReal(SK.tex["scorebar-ki"]) ? SK.tex["scorebar-ki"] : null;
  if (ms) { const mw = ms.img.width / ms.hd * f, mh = ms.img.height / ms.hd * f; ctx.drawImage(ms.img, x0 + ox + fw * v - mw / 2, y0 + oy + fh / 2 - mh / 2, mw, mh); bottom = Math.max(bottom, y0 + oy + fh / 2 + mh / 2); }
  return bottom;
}
function drawHUD(t, B) {
  const u = B.u, ev = map.score, i = lastBefore(ev, t, "t");
  // a replay's score is an ESTIMATE: the perfect play's running score (map.score) scaled so it ends exactly on the replay's real score. The accuracy is the real final one, a constant.
  // Its combo: the REAL combo the analysis rebuilt from the replay's inputs (js/replayana.js rpComboAt) once that is ready for this very replay and map and trusted (rpTrusted:
  // it agrees with the replay's own counts), never above the replay's own max combo (the rebuild is an estimate: a sub-pixel slider follow can give it one more than the game had).
  // Not trusted: a full combo (the header's perfect flag, no miss) shows the perfect play's combo scaled to end on its real max combo; any other shows no combo at all (null): the
  // perfect play's combo never drops at a miss or a slider break and, capped at the real max combo, would stay pinned on it for the rest of the play, a number surely wrong, worse than none
  const rp = RP.on, R = rp ? rpFinals() : null;
  let target = i >= 0 ? ev[i].score : 0, combo = i >= 0 ? ev[i].combo : 0;
  let since = i >= 0 ? t - ev[i].t : 0; // (ms since the combo last rose: the pop)
  if (rp) {
    target = rpScoreAt(t);
    const a = rpTrusted(), rc = a && typeof rpComboAt === "function" ? rpComboAt(a, t) : null;
    if (rc) { combo = RPB.combo = R.combo > 0 ? Math.min(rc.combo, R.combo) : rc.combo; since = rc.since; }
    else combo = RPB.combo = R.miss > 0 || !R.fc ? null : i >= 0 ? Math.min(R.combo, Math.round(ev[i].combo * R.combo / R.cden)) : 0;
  }
  if (target < dispScore || (rp && !isPlaying())) dispScore = target; else dispScore += (target - dispScore) * Math.min(1, frameDt / 90); // (a paused / seeked replay shows its exact number)
  let rB = B.r; if (VIEW.rotated && !UI.ui.classList.contains("hide")) rB = Math.min(rB, cv.height - document.querySelector(".bar.bottom").offsetHeight * (cv.dpr || 1)); // (rotated: the score block ends over the bottom bar, as the keys do)
  const pad = 14 * u, top = B.top + pad, right = rB - pad, left = B.l + pad, W = B.r - B.l;
  ctx.textBaseline = "top"; ctx.globalAlpha = 1; ctx.textAlign = "right";
  hudScore(String(Math.round(dispScore)).padStart(8, "0"), rp ? (R.acc * 100).toFixed(2) + "%" : "100.00%", right, top, u);
  ctx.font = `600 ${14 * u}px Inter,sans-serif`;
  if (rp) { const nm = RP.data.player || ""; sText((nm.length > 22 ? nm.slice(0, 21) + "…" : nm) + (RP.mods && RP.mods.list.length ? " +" + RP.mods.list.join("") : "") + (A.rate !== 1 ? ` ${A.rate}x` : ""), right, top + 64 * u, u, "#ff99cc"); }
  else sText(A.rate !== 1 ? `Auto ${A.rate}x` : "Auto", right, top + 64 * u, u, "#ff99cc");
  const dur = A.dur() || 1, px = right - 96 * u, py = top + 50 * u, pr = 10 * u;
  ctx.globalAlpha = .9;
  ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.fillStyle = "rgba(255,255,255,.2)"; ctx.fill();
  if (t > 0) { ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, pr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(t / dur)); ctx.closePath(); ctx.fillStyle = t < map.first ? "#8ee6a0" : "#fff"; ctx.fill(); }
  ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5 * u; ctx.stroke();
  const hbW = Math.min(W * .34, 320 * u), hbY = top + 6 * u, hp = rp ? rpHpAt(t) : 1, sb = drawSkinHealth(left, top, hp, u, W);
  if (sb >= 0) HUDB.bottom = sb;
  else {
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillRect(left, hbY, hbW, 9 * u);
    const key = left + "|" + hbW;
    if (key !== hbKey) { hbGrad = ctx.createLinearGradient(left, 0, left + hbW, 0); hbGrad.addColorStop(0, "#ff66aa"); hbGrad.addColorStop(1, "#66ccff"); hbKey = key; }
    ctx.fillStyle = hbGrad; ctx.fillRect(left, hbY, hbW * hp, 9 * u); HUDB.bottom = 0;
  }
  if (combo > 0) hudCombo(combo, left, B.bottom - pad, since < 0 ? 1 : 1 + .28 * clamp01(1 - since / 140), u);
  ctx.globalAlpha = 1;
}

// ---- a replay's key overlay (like osu!stable's: K1 K2 M1 M2 in a column at the right edge, vertically centred, each with its press count)
// osu!stable stores K1 as 4|1 and K2 as 8|2 (the M bit rides along), so K1 / K2 are lit by bits 4 / 8 alone and M1 / M2 only by 1 / 2 pressed WITHOUT the K bit.
// Lit mask: bit 0 K1, 1 K2, 2 M1, 3 M2
const rpLit = k => (k & 4 ? 1 : 0) | (k & 8 ? 2 : 0) | (k & 5 && !(k & 4) ? 4 : 0) | (k & 10 && !(k & 8) ? 8 : 0);
const RP_KEYS = ["K1", "K2", "M1", "M2"], RPK = { x: 0, y: 0, s: 0, gap: 0, top: 0, mask: 0 };
let RPP = { d: null, t: null }; // (per replay: the time of each press of each key, a rising edge of its lit state; built once)
function rpPresses() {
  const d = RP.data; if (!d) return null;
  if (RPP.d === d) return RPP.t;
  const F = d.frames, P = [[], [], [], []]; let prev = 0;
  for (let i = 0; i < F.n; i++) { const s = rpLit(F.k[i]), up = s & ~prev; if (up) for (let b = 0; b < 4; b++) if (up >> b & 1) P[b].push(F.t[i]); prev = s; }
  RPP = { d, t: P.map(a => Float64Array.from(a)) };
  return RPP.t;
}
// what the first frames of a replay need, built when it starts (rpuPlay) and not inside a frame: the key presses and the replay's sound list
function rpPrime() { try { rpPresses(); if (typeof soundList === "function") soundList(); } catch (e) { console.warn("replay priming:", e && e.message || e); } }
const _rpn = new Int32Array(4);
// how many times each key (K1 K2 M1 M2) has been pressed up to t (a shared array, valid until the next call; a seek back gives the right count)
function rpKeyCounts(t) {
  const P = rpPresses(); _rpn.fill(0); if (!P) return _rpn;
  for (let b = 0; b < 4; b++) { const a = P[b]; let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= t) lo = m + 1; else hi = m; } _rpn[b] = lo; }
  return _rpn;
}
// a skin's own input overlay (inputoverlay-key / inputoverlay-background, the skin's own images; a 1x1 blank one counts as none):
// the keys keep the column below, their look is the skin's: white, yellow when K1 / K2 are down, purple when M1 / M2 are, a small shrink on
// a press; the text is the skin's InputOverlayText colour (osu!: black when it names none)
const OVK = [[255, 235, 60], [255, 235, 60], [190, 90, 255], [190, 90, 255]];
function skinKeys() { const k = SK.tex["inputoverlay-key"]; return k && k.img.width > 8 ? k : null; }
function drawRpKeys(t, B) {
  const u = B.u, lit = rpLit(rpKeysAt(t)), n = rpKeyCounts(t), pad = 14 * u, gap = 6 * u;
  // clear of the HUD's name line at the top and the bottom bar: shrink the column if the space between is short
  // (rotated 16:9: the game's right edge is the screen's bottom, under the bottom bar while it is shown)
  let rEdge = B.r; if (VIEW.rotated && !UI.ui.classList.contains("hide")) rEdge = Math.min(rEdge, cv.height - document.querySelector(".bar.bottom").offsetHeight * (cv.dpr || 1));
  const lo = B.top + pad + 84 * u, hi = B.bottom - pad, s = Math.min(Math.max(30 * u, 20 * (cv.dpr || 1)), (hi - lo - 3 * gap) / 4); // (30 osu!px, but readable in a small locked 16:9 view)
  if (!(s > 4 * u)) return;
  const H = 4 * s + 3 * gap, x = rEdge - pad / 2 - s, y0 = Math.min(hi - H, Math.max(lo, (B.t + B.b) / 2 - H / 2));
  RPK.x = x; RPK.y = y0; RPK.s = s; RPK.gap = gap; RPK.mask = lit;
  const sk = skinKeys(), P = sk ? rpPresses() : null;
  let txt = "#fff";
  if (sk) {
    const bg = SK.tex["inputoverlay-background"], ic = SK.ini && SK.ini.Colours && SK.ini.Colours.InputOverlayText, c = ic ? ic.split(",").map(Number) : null;
    txt = c && c.length >= 3 && c.slice(0, 3).every(Number.isFinite) ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : "#000";
    if (bg && bg.img.width > 8) {
      // The skin's own sizes, as in osu!: the key is drawn s wide, the background at the same scale (its own proportions, never stretched to the column). It is turned a
      // quarter turn clockwise, so the top of the picture (where skins put the bright edge, fading away from it) is the RIGHT edge of the screen: the strip sits ON
      // that edge, centred on the column of keys, which stand on it (not centred on the keys: the bright edge would then hang outside the picture)
      const f = s / (sk.img.width / sk.hd), L = bg.img.width / bg.hd * f, T = bg.img.height / bg.hd * f;
      ctx.save(); ctx.translate(rEdge - T / 2, y0 + H / 2); ctx.rotate(Math.PI / 2);
      ctx.globalAlpha = 1; ctx.drawImage(bg.img, -L / 2, -T / 2, L, T); ctx.restore();
    }
  }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < 4; i++) {
    const y = y0 + i * (s + gap), on = lit >> i & 1;
    if (sk) {
      const last = n[i] ? P[i][n[i] - 1] : -1e9, sh = 1 - .18 * clamp01(1 - (t - last) / 150); // (shrinks as the key goes down, back in 150 ms)
      const f = s / Math.max(sk.img.width, sk.img.height) * sk.hd * sh;
      blit(on ? tintOf(sk, OVK[i]) : sk, x + s / 2, y + s / 2, f, 1);
    } else {
      ctx.globalAlpha = on ? .95 : .55; ctx.fillStyle = on ? "#ff66aa" : "rgba(0,0,0,.55)"; ctx.fillRect(x, y, s, s);
      ctx.globalAlpha = 1; ctx.strokeStyle = on ? "#fff" : "rgba(255,255,255,.35)"; ctx.lineWidth = Math.max(1, u); ctx.strokeRect(x, y, s, s);
    }
    ctx.globalAlpha = 1; ctx.fillStyle = sk ? txt : on ? "#fff" : "rgba(255,255,255,.85)";
    ctx.font = `600 ${s * .36}px Inter,sans-serif`;
    ctx.fillText(RP_KEYS[i], x + s / 2, y + s * .33, s - 2);
    ctx.font = `600 ${s * .3}px Inter,sans-serif`;
    ctx.fillText(String(n[i]), x + s / 2, y + s * .7, s - 2);
  }
  ctx.globalAlpha = 1;
}
// ---- the live Top 50 board (osu!'s in-game scoreboard while a replay plays): the map's global top 50 at their final scores (static) and this
// replay's row, which climbs as its score grows. On the left under the health bar; it comes in as the title card goes (they would overlap).
// RPB.rows / RPB.k are set by t5Live (js/replayui.js) when the replay starts (RPB.d = its data); the pure parts are in js/replay.js.
// The replay's number is the HUD's own (dispScore, from rpScoreAt), times RPB.k: 1, or a lazer replay's standardised -> classic factor.
// A pass slides the rows (a per-frame ease of the replay's slot p); a seek, a pause, the first frame and reduced motion snap. No avatars (canvas).
const RPB = { d: null, rows: null, k: 1, p: -1, lt: 0, combo: 0 }, RPB_MQ = matchMedia("(prefers-reduced-motion: reduce)");
function drawRpBoard(t, B) {
  const rows = RPB.rows; if (!rows || RPB.d !== RP.data) return;
  const age = performance.now() - cardStart, rm = RM || RPB_MQ.matches, a = rm ? (age >= 3800 ? 1 : 0) : clamp01((age - 3500) / 300);
  if (!(a > 0)) { RPB.p = -1; return; }
  const v = Math.round(dispScore * RPB.k), idx = rpBoardIdx(rows, v), total = rows.length + 1;
  if (RPB.p < 0 || rm || !isPlaying() || t < RPB.lt - 50 || t - RPB.lt > 1500) RPB.p = idx; // (snap: a seek is a jump of the time)
  else { RPB.p += (idx - RPB.p) * Math.min(1, frameDt / 110); if (Math.abs(idx - RPB.p) < .005) RPB.p = idx; else dirty = true; }
  RPB.lt = t;
  const q = cv.dpr || 1, u = B.u, pad = 14 * u, p = RPB.p;
  // (rotated 16:9: the game's left edge is the screen's top, under the top bar while it is shown)
  let lEdge = B.l; if (VIEW.rotated && !UI.ui.classList.contains("hide")) lEdge = Math.max(lEdge, document.querySelector(".bar.top").offsetHeight * q);
  const sz = S.top50Size / 100, lh = Math.max(30 * u, 25 * q) * sz, f1 = Math.max(13.5 * u, 11 * q) * sz, f2 = Math.max(10.5 * u, 9 * q) * sz, w = Math.max(170 * u, 132 * q) * sz, x = lEdge + pad; // (Settings → Top 50 size)
  const y0 = Math.max(B.top + pad + 26 * u, HUDB.bottom ? HUDB.bottom + 8 * u : 0), yMax = B.bottom - pad - 62 * u; // (under the health bar, over the combo counter)
  const n = Math.min((B.bottom - B.top) / q < 500 ? 5 : 7, total, Math.floor((yMax - y0) / lh)); // (5 rows on a phone, 7 on a bigger screen, fewer if short)
  if (n < 2) return;
  const o = rpBoardWin(total, p, n), H = n * lh;
  ctx.save(); ctx.globalAlpha = a; ctx.beginPath(); ctx.rect(x - 2, y0, w + 4, H); ctx.clip();
  ctx.textBaseline = "alphabetic";
  const fitName = (s, maxW) => { // (a long name is cut with an ellipsis: squeezing it to the width made it unreadable)
    if (ctx.measureText(s).width <= maxW) return s;
    const cs = Array.from(s); let lo = 0, hi = cs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(cs.slice(0, m).join("") + "…").width <= maxW) lo = m; else hi = m - 1; }
    return cs.slice(0, lo).join("") + "…";
  };
  const row = (slot, label, name, score, combo, me) => {
    const y = y0 + (slot - o) * lh; if (y <= y0 - lh || y >= y0 + H) return;
    const g = Math.max(1, 2 * u), rh = lh - g;
    ctx.globalAlpha = a * (me ? .9 : .55); ctx.fillStyle = me ? "#ff66aa" : "#000"; ctx.fillRect(x, y, w, rh);
    if (me) { ctx.globalAlpha = a; ctx.fillStyle = "#fff"; ctx.fillRect(x, y, Math.max(2, 3 * u), rh); }
    ctx.globalAlpha = a; ctx.textAlign = "left";
    const lx = x + 8 * u, cw = Math.max(34 * u, 30 * q), tx = lx + cw;
    ctx.font = `700 ${f2}px Inter,sans-serif`; ctx.fillStyle = me ? "#fff" : "rgba(255,255,255,.75)"; ctx.fillText(label, lx, y + rh / 2 + f2 * .36, cw - 3 * u);
    ctx.font = `600 ${f1}px Inter,"IBM Plex Sans Thai",sans-serif`; ctx.fillStyle = "#fff"; ctx.fillText(fitName(name || "?", x + w - tx - 6 * u), tx, y + rh * .47);
    const by = y + rh * .47 + f2 * 1.15, ts = String(score).replace(/\B(?=(\d{3})+(?!\d))/g, ","), hs = f2 * 1.1, right = x + w - 6 * u;
    // (the skin's digits when it has them: the combo from its combo font, the score from its score font, shrunk to fit; a line it can't draw is text as before)
    const CL = combo == null ? null : hudFit(SK.fonts && SK.fonts.combo, combo + "x", hs); // (null: the replay's combo is not known, see drawHUD: none shown)
    let SL = hudFit(SK.fonts && SK.fonts.score, ts, hs);
    const room = right - (CL ? CL.width + 6 * u : 0) - tx - 4 * u;
    if (SL && SL.width > room) SL = room > 8 * u ? hudFit(SK.fonts.score, ts, hs * room / SL.width) : null;
    if (SL) hudDraw(SL, tx, by - hs * .5 - SL.height / 2, a);
    else { ctx.font = `500 ${f2}px Inter,sans-serif`; ctx.fillStyle = me ? "#fff" : "#ffd6ea"; ctx.fillText(ts, tx, by); }
    if (CL) hudDraw(CL, right - CL.width, by - hs * .5 - CL.height / 2, a * (me ? 1 : .8));
    else if (combo != null) { ctx.textAlign = "right"; ctx.font = `500 ${f2}px Inter,sans-serif`; ctx.fillStyle = me ? "#fff" : "rgba(255,255,255,.7)"; ctx.fillText(combo + "x", right, by); }
    ctx.globalAlpha = a;
  };
  const k0 = Math.max(0, Math.floor(o) - 2), k1 = Math.min(rows.length, Math.ceil(o + n) + 1);
  for (let k = k0; k < k1; k++) { const r = rows[k]; row(k + clamp01(k + 1 - p), rpBoardRank(k < idx ? k : k + 1), r.name, r.score, r.combo, false); } // (row k moves down one slot as the replay passes it)
  row(p, rpBoardRank(idx), RP.data.player || "?", v, RPB.combo, true);
  ctx.restore(); ctx.globalAlpha = 1;
  if (a < 1) dirty = true;
}
function drawTitleCard(B) {
  const age = performance.now() - cardStart; if (age < 0 || age > 3800) return false;
  const u = B.u, W = B.r - B.l;
  const a = age < 450 ? easeOut(age / 450) : age > 3200 ? 1 - (age - 3200) / 600 : 1;
  const dx = (1 - (age < 450 ? easeOut(age / 450) : 1)) * -60 * u;
  const x = B.l + 24 * u + dx, y = (B.t + B.b) / 2 - 43 * u;
  const title = map.meta.TitleUnicode || map.meta.Title || "", artist = map.meta.ArtistUnicode || map.meta.Artist || "";
  ctx.globalAlpha = a; ctx.fillStyle = "#ff66aa"; ctx.fillRect(x, y, 5 * u, 86 * u);
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.shadowColor = "rgba(0,0,0,.7)"; ctx.shadowBlur = 10 * u; ctx.fillStyle = "#fff";
  ctx.font = `600 ${30 * u}px Inter,"IBM Plex Sans Thai",sans-serif`; ctx.fillText(title, x + 16 * u, y, W * .85);
  ctx.font = `${19 * u}px Inter,"IBM Plex Sans Thai",sans-serif`; ctx.fillStyle = "#eee"; ctx.fillText(artist, x + 16 * u, y + 40 * u, W * .85);
  ctx.font = `${14 * u}px Inter,"IBM Plex Sans Thai",sans-serif`; ctx.fillStyle = "#ffb3d6"; ctx.fillText(`[${map.meta.Version || ""}]` + (map.meta.Creator ? `  mapped by ${map.meta.Creator}` : ""), x + 16 * u, y + 68 * u, W * .85);
  ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  return true;
}

// timing overlay pill: time, BPM, SV, measure:beat, kiai
function drawOverlay(t, B, atTop) {
  const u = atTop ? (cv.dpr || 1) : Math.max(B.u, (cv.dpr || 1) * .8), b = beatInfo(t), bpm = 60000 / b.len, sv = svAt(map, t);
  const n = Math.floor((t - b.off) / b.len + 1e-6), meter = b.meter, beat = ((n % meter) + meter) % meter;
  const txt = `${atTop ? "" : fmtMs(t) + "   "}${Math.round(bpm * 100) / 100} BPM   ${sv.toFixed(2)}x   ${Math.floor(n / meter) + 1}:${beat + 1}${kiaiAt(t) ? "   KIAI" : ""}`;
  ctx.font = `600 ${13 * u}px Inter,sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const tw = ctx.measureText(txt).width, dotsW = meter * 12 * u, w = tw + dotsW + 34 * u, hh = 26 * u;
  const cxm = atTop ? INS.l + (VIEW.W - INS.l - INS.r) / 2 : (B.l + B.r) / 2;
  // editor: the selection's info (time, combo, snap, position, spacing) on a line or two under it, in the same pill
  // (a short playfield, e.g. a phone with Advanced's tool rows: one line, so the pill doesn't cover the objects)
  const sel = atTop && typeof EDIT !== "undefined" && EDIT.sel.size && EDIT.selTxt ? pillLines(EDIT.selTxt, VIEW.W - INS.l - INS.r - 40 * u, u, cv.height - INS.t - INS.b < 300 * u ? 1 : 2) : [];
  const lh = 18 * u, pw = Math.max(w, ...sel.map(s => s.w + 28 * u)), ph = hh + (sel.length ? sel.length * lh + 6 * u : 0);
  const x = cxm - pw / 2, y = atTop ? INS.t + 4 * (cv.dpr || 1) : B.bottom - hh - 12 * u, x0 = cxm - w / 2;
  if (atTop) drawOverlay.box = { x, y, w: pw, h: ph }; // (canvas px: the editor tour lights it up with the playfield)
  ctx.globalAlpha = .78; ctx.fillStyle = "#120e19";
  ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, pw, ph, hh / 2); else ctx.rect(x, y, pw, ph); ctx.fill();
  ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.fillText(txt, x0 + 14 * u, y + hh / 2);
  for (let i = 0; i < meter; i++) {
    ctx.fillStyle = i === beat ? (i === 0 ? "#ff66aa" : "#66ccff") : "rgba(255,255,255,.3)";
    ctx.beginPath(); ctx.arc(x0 + tw + 26 * u + i * 12 * u, y + hh / 2, 4 * u, 0, 7); ctx.fill();
  }
  if (!sel.length) return;
  ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fillRect(x + 12 * u, y + hh - .5 * u, pw - 24 * u, Math.max(1, u)); // (a hairline between the timing and the selection)
  ctx.font = `500 ${12 * u}px Inter,"IBM Plex Sans Thai",sans-serif`; ctx.textAlign = "center"; ctx.fillStyle = "#ffd6ea";
  sel.forEach((s, i) => ctx.fillText(s.t, cxm, y + hh + 3 * u + lh * (i + .5)));
}
// the selection text in at most two lines of maxW (broken at " • ", so a phone keeps the spacing info on the 2nd line); the rest is cut with …
function pillLines(txt, maxW, u, maxLines = 2) {
  ctx.font = `500 ${12 * u}px Inter,"IBM Plex Sans Thai",sans-serif`;
  const key = [txt, maxW, u, maxLines, document.fonts && document.fonts.status].join("|"); if (pillLines.k === key) return pillLines.v; // (drawn every frame: measured once per text and size)
  const mw = s => ctx.measureText(s).width, parts = txt.replace(/ - $/, "").split(" • "), out = []; // (several objects: no dangling " - " after the timestamp)
  let cur = "";
  for (const p of parts) { const c = cur ? cur + " • " + p : p; if (!cur || mw(c) <= maxW || out.length >= maxLines - 1) cur = c; else { out.push(cur); cur = p; } }
  out.push(cur);
  pillLines.k = key; return pillLines.v = out.map(s => { if (mw(s) > maxW) { while (s.length > 1 && mw(s + "…") > maxW) s = s.slice(0, -1); s = s.trimEnd() + "…"; } return { t: s, w: mw(s) }; });
}

// pre-scaled copies of big background images, so they aren't resampled every frame
const scaled = [null, null];
function scaledImg(slot, img, w, hh) {
  w = Math.max(1, Math.round(w)); hh = Math.max(1, Math.round(hh));
  const c = scaled[slot];
  if (c && c.srcImg === img && c.width === w && c.height === hh) return c;
  if (w >= img.width) return img; // upscaling: draw the original
  const n = document.createElement("canvas"); n.width = w; n.height = hh;
  n.getContext("2d").drawImage(img, 0, 0, w, hh); n.srcImg = img;
  scaled[slot] = n; return n;
}

// base transform (for 90° rotated view)
let BASE = [1, 0, 0, 1, 0, 0];
function setT(a, b, c, d, e, f) {
  const [A0, B0, C0, D0, E0, F0] = BASE;
  ctx.setTransform(A0 * a + C0 * b, B0 * a + D0 * b, A0 * c + C0 * d, B0 * c + D0 * d, A0 * e + C0 * f + E0, B0 * e + D0 * f + F0);
}
const VIEW = { vs: 1, ox: 0, oy: 0, rotated: false, W: 0 }; // for editor hit-testing
function viewOsuRect(m = 0) { // the part of osu!px space the canvas shows, plus m on every side (huge sliders draw only this)
  const vs = VIEW.vs || 1, w = VIEW.rotated ? cv.height : cv.width, hh = VIEW.rotated ? cv.width : cv.height;
  const y0 = -VIEW.oy / vs - 56 - m, y1 = (hh - VIEW.oy) / vs - 56 + m;
  return [-VIEW.ox / vs - 64 - m, VFLIP ? 384 - y1 : y0, (w - VIEW.ox) / vs - 64 + m, VFLIP ? 384 - y0 : y1];
}
const plx = { x: 0, y: 0 };
let lastT = null, lastPlayIcon = null, loopOn = false, frameDt = 16, plxMoving = false, liveAt = 0, fpsLast = 0, rafPrev = 0, rafIv = 1000 / 60;
let domSeek = -1, domCur = "", domDur = "", domEd = "";
// the Skip button: 20 px over the bottom bar (its height changes: a second row for the seek bar on small screens, the safe area), and in the
// rotated view at the bottom-left of the screen, where the rotated score block (bottom-right) and the keys (bottom-centre) are not
let skipKey = "";
function skipPlace() {
  const bar = document.querySelector(".bar.bottom"), hide = UI.ui.classList.contains("hide"), h = bar && !hide ? bar.offsetHeight : 0, rot = !!VIEW.rotated, k = h + "|" + rot;
  if (k === skipKey) return; skipKey = k;
  UI.skip.style.bottom = h ? `${h + 20 + (rot ? 44 : 0)}px` : rot ? "140px" : ""; // ("": the CSS default; the bars hidden; rotated: also over the keys row, which a long label such as Malay's would touch)
  UI.skip.classList.toggle("rot", rot);
}
function startLoop() { if (!loopOn) { loopOn = true; lastFrame = performance.now(); requestAnimationFrame(frame); } }
function frame() {
  if (UI.player.hidden) { loopOn = false; return; }
  requestAnimationFrame(frame);
  if (!map) return;
  const testing = typeof PLAY !== "undefined" && PLAY.on, pnow = performance.now(), rd = pnow - rafPrev; rafPrev = pnow; // (test play: every frame the screen has, for the least delay)
  if (rd > 3 && rd < rafIv * 1.5) rafIv += (rd - rafIv) * .05; // the screen's refresh interval (a frame that took two of them isn't the screen)
  // frame-rate cap (Settings → Display) as every n-th frame of the screen, n the nearest whole number: 50 FPS on a 60 Hz screen
  // drawn on 5 frames out of 6 left a 33 ms gap ten times a second, a judder that showed most on moving slider balls
  const step = testing ? 1 : Math.max(1, Math.round(1000 / S.fps / rafIv - .05)), iv = step * rafIv;
  if (pnow - fpsLast < (step - .5) * rafIv) return; fpsLast = pnow;
  const raw = pnow - lastFrame, dt = Math.min(100, raw); lastFrame = pnow; frameDt = dt;
  const playing = isPlaying(), ed = EDIT.on;
  const card = !ed && pnow - cardStart < 3900;
  if (!playing && !dirty && !card && !seeking && !plxMoving) return;
  dirty = false;
  if (S.fpsHud) fpsTick(pnow, playing);
  const ta = nowMs(), t = ta - visOffset(); // ta = audio time (hitsounds), t = what is drawn

  if (playing) schedule(ta, btAhead()); else resetSched();
  if (testing && playing) playUpdate(t); // (play.js: misses, slider ticks, spinners as time passes)
  lastT = playing ? t : null;
  if (playing && S.quality === "auto") { // adaptive resolution
    if (sampSkip > 0) sampSkip--; // (a resize's first frames, a replay's or a map's first half second: a hiccup, not the speed of the page)
    else if (pnow - cardStart > 600) {
      sampN++; if (raw > Math.max(26, iv * 1.45) && raw < SAMP_STALL) slowN++;
      // (windows of 60 frames, more than 22 of them slow: one step down from the DPR in use, never back up. Slow frames only add up, so a window that is going to
      // step does it as soon as the 23rd is in, not after the last frame: on a very slow page that is seconds sooner)
      if (slowN > 22 || sampN >= 60) {
        const cur = Math.min(autoCap, cv.dpr || autoCap);
        // a big storyboard goes lighter first (sbLod, skins.js), the picture's resolution only once that is as light as it gets; when the
        // stretch of sprites is over (half as many showing) and the frames are fine again, the storyboard gets its detail back
        if (slowN > 22 && SBL.active > 1200 && SBL.lod < 4) { if (!SBL.lod) SBL.at = SBL.active; sbLod(SBL.lod + 1); }
        else if (slowN > 22 && cur > 1) { autoCap = Math.max(1, cur - .25); resize(); }
        else if (slowN === 0 && SBL.lod && SBL.active < SBL.at * .5 && ++SBL.clean >= 3) sbLod(SBL.lod - 1);
        if (slowN) SBL.clean = 0;
        sampN = slowN = 0;
      }
    }
  }
  // DOM updates (only when something changed)
  if (A.mode !== "el" && A.on && A.cur() >= A.dur()) { A.pause(); A.pos = A.dur(); onSongEnd(); }
  const dur = A.dur() / 1000;
  // the clocks and the seek bar are written once this frame is drawn (a microtask): written first, the page had to work out its
  // styles again in the middle of the drawing (a canvas font or the timeline's size wants them current), every frame in the
  // editor, whose clock shows milliseconds
  queueMicrotask(() => {
    if (!map) return;
    if (!seeking && dur) { const v = Math.round(Math.max(0, t) / 1000 / dur * 1000); if (v !== domSeek) { domSeek = v; UI.seek.value = v; UI.seek.style.setProperty("--p", v / 10 + "%"); } }
    const c = ed ? fmtMs(t) : fmt(t / 1000), d = fmt(dur);
    if (c !== domCur) UI.tCur.textContent = domCur = c;
    if (d !== domDur) UI.tDur.textContent = domDur = d;
    if (ed) { const s = fmtMs(t), k = s + "|" + map.bookmarks.length; if (k !== domEd) { UI.edTime.textContent = s; domEd = k; edBmSync(t); } } // (the bottom bar's bookmark button lights up on one)
  });
  skipEnd = RP.on && !RP.ended && !ed && playing && rpShowEndSkip(t, rpSkipAt(map.last, RP.data.frames), A.dur()); // (a replay waits for the song's end: this one ends it)
  const showSkip = !ed && playing && (map.first > 6000 && t < map.first - 2500 || skipEnd);
  if (UI.skip.hidden === showSkip) UI.skip.hidden = !showSkip;
  if (showSkip) skipPlace(); // (above the bottom bar, whatever height it has; bottom-left when the picture is rotated)
  if (lastPlayIcon !== playing) { lastPlayIcon = playing; UI.playPath.setAttribute("d", playing ? "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" : "M7 4l13 8-13 8z"); UI.play.setAttribute("aria-label", tr(playing ? "Pause" : "Play")); }
  if (!UI.tools.hidden && pnow - liveAt > 120) { liveAt = pnow; updateLive(t); }
  if (ed) edDrawTimeline(t);
  if (RHY.cv && RHY.cv.isConnected && (playing || RHY.moving)) drawRhythm(RHY.cv, dt);
  if (LIVE.on) liveFrame(t, playing);
  if (COLLAB.on) collabFrame(t, playing);
  if (ed && EDIT.tab !== "compose") return; // a panel covers the playfield

  const W = cv.width, H = cv.height, portrait = H > W;
  const rotated = !ed && S.view === "rotate" && portrait;
  BASE = rotated ? [0, 1, -1, 0, W, 0] : [1, 0, 0, 1, 0, 0];
  const LW = rotated ? H : W, LH = rotated ? W : H;
  const SF = rotated ? { t: SAFE.r, r: SAFE.b, b: SAFE.l, l: SAFE.t } : SAFE;
  let vs, ox, oy, box, lock;
  if (ed) { // fit the 512x384 field (+ margin for circles) between the bars and the tool columns, under the timing pill
    const q = cv.dpr || 1, top = INS.t + 32 * q, avail = Math.max(1, LH - top - INS.b), availW = Math.max(1, LW - INS.l - INS.r);
    if (edSizeNow() !== "fit") { // Settings → Editor → Playfield size: the scale gameplay uses on this screen, so objects are their in-game size
      vs = (S.view === "auto" && portrait) ? Math.min(LW / 640, LH / 480) : Math.min(LW / 854, LH / 480);
      // ...but where objects go never leaves the screen: smaller when the whole field (and a small margin) doesn't fit
      // between the tool columns and the bars (a taller timeline, a short window)
      const m = 8 * q; vs = Math.min(vs, Math.max(1, availW - 2 * m) / 512, Math.max(1, avail - 2 * m) / 384);
      ox = INS.l + (availW - 512 * vs) / 2 - 64 * vs; oy = top + (avail - 384 * vs) / 2 - 56 * vs;
    } else {
      vs = Math.min(availW / 560, avail / 420);
      ox = INS.l + (availW - 560 * vs) / 2 - 40 * vs; oy = top + (avail - 420 * vs) / 2 - 38 * vs;
    }
    lock = true; box = [0, INS.t, LW, LH - INS.t - INS.b];
  } else {
    lock = S.view !== "auto";
    vs = (!lock && portrait) ? Math.min(LW / 640, LH / 480) : Math.min(LW / 854, LH / 480);
    ox = (LW - 640 * vs) / 2; oy = (LH - 480 * vs) / 2;
    box = lock ? [ox - 107 * vs, oy, 854 * vs, 480 * vs] : [0, 0, LW, LH];
  }
  if (Math.abs(VS - vs) > 1e-6) bodyCache.clear();
  VS = vs; VIEW.vs = vs; VIEW.ox = ox; VIEW.oy = oy; VIEW.rotated = rotated; VIEW.W = W;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.shadowBlur = 0;
  ctx.fillStyle = ed ? "#1a1d2c" : "#000"; ctx.fillRect(0, 0, W, H); // (the editor: flat navy, and its dim fades toward it)

  const bg = map.bg ? images[norm(map.bg)] : null;
  const kiai = S.fx && !ed ? kiaiAt(t) : null;
  let beatK = 0;
  { const b = beatInfo(t), len = b.len || 500; beatK = (1 - ((((t - b.off) % len) + len) % len) / len) ** 2; }
  // letterbox fill (auto mode only; locked 16:9 keeps clean black bars)
  if (!lock && bg && !bgHidden) {
    const k = Math.max(W / bg.width, H / bg.height);
    ctx.globalAlpha = .28 * (1 - S.dim / 100); ctx.drawImage(scaledImg(1, bg, bg.width * k, bg.height * k), (W - bg.width * k) / 2, (H - bg.height * k) / 2, bg.width * k, bg.height * k); ctx.globalAlpha = 1;
  }
  setT(vs, 0, 0, vs, ox, oy);
  const vid = vidFor(), vidOn = !!vid && vidSync(vid, t);
  GLS.used = false; // (sbglFrame sets it when it draws: Info shows whether WebGL really did)
  const glOn = S.sb && sb.length && !vidOn && sbglOn(); // the storyboard by WebGL (sbgl.js; not over a video)
  let bgq = null;
  ctx.save(); ctx.beginPath(); ctx.rect(-107, 0, 854, 480); ctx.clip();
  if (bg && !bgHidden) {
    const base = Math.max(854 / bg.width, 480 / bg.height), zoom = 1.02 + (kiai ? .012 * beatK : 0), k = base * zoom;
    let tx = 0, ty = 0;
    if (S.parallax && !ed) { const cp = cursorAt(t); tx = (cp[0] - 256) * -.015; ty = (cp[1] - 192) * (RP.on && RP.flipY ? .015 : -.015); }
    const f = 1 - Math.exp(-dt / 140); plx.x += (tx - plx.x) * f; plx.y += (ty - plx.y) * f;
    plxMoving = Math.abs(tx - plx.x) + Math.abs(ty - plx.y) > .05;
    const w = bg.width * k, hh = bg.height * k;
    const draw2d = () => ctx.drawImage(scaledImg(0, bg, bg.width * base * 1.04 * vs, bg.height * base * 1.04 * vs), 320 - w / 2 + plx.x, 240 - hh / 2 + plx.y, w, hh);
    if (glOn) bgq = { img: bg, x: 320 + plx.x, y: 240 + plx.y, k, fallback: draw2d }; else draw2d();
  }
  if (vidOn) { // the map's video: above the background, under the storyboard (like osu!)
    const k = Math.max(854 / vid.videoWidth, 480 / vid.videoHeight), w = vid.videoWidth * k, hh = vid.videoHeight * k;
    try { ctx.drawImage(vid, 320 - w / 2, 240 - hh / 2, w, hh); } catch {}
    if (!vid.paused) dirty = true;
  }
  if (S.sb && sb.length) {
    const m = ctx.getTransform(); SBM[0] = m.a; SBM[1] = m.b; SBM[2] = m.c; SBM[3] = m.d; SBM[4] = m.e; SBM[5] = m.f;
    if (!(glOn && sbglFrame(t, bgq, ed ? [26 / 255, 29 / 255, 44 / 255] : [0, 0, 0]))) { if (bgq) bgq.fallback(); sbDraw(t); } // (WebGL's picture has the background in it; if it can't be had, the canvas does both)
    ctx.setTransform(m);
  } else SBL.active = 0;
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  const dim = ed ? Math.max(0, Math.min(100, S.edDim ?? 60)) : S.dim; // (the editor has its own: Settings → Editor)
  if (dim) { ctx.fillStyle = ed ? `rgba(26,29,44,${dim / 100})` : `rgba(0,0,0,${dim / 100})`; ctx.fillRect(-107, 0, 854, 480); }
  if (kiai) drawKiai(t);
  ctx.restore();

  animT = t;
  RPM.hd = RP.on && !ed && !testing && !!(RP.mods && RP.mods.hd); RPM.fl = RP.on && !ed && !testing && !!(RP.mods && RP.mods.fl);
  RPH.now = RP.on && !ed && !testing ? rpHits() : null; // (a replay's real hits, once judged)
  if (testing) { ctx.save(); ctx.translate(64, 56); playDraw(t, beatK); playCursor(); ctx.restore(); } // test play (play.js)
  else if (S.notes || S.cursor || ed) {
    ctx.save(); ctx.translate(64, 56);
    const vf = RP.on && RP.flipY && !ed && !testing; // (a replay with Hard Rock: the playfield drawn flipped upside down as the game shows it; the replay's own cursor is then drawn where it was, see rpCursorAt)
    if (vf) { VFLIP = true; ctx.translate(0, 384); ctx.scale(1, -1); }
    try {
    if (ed) edDrawUnder(t);
    if (S.notes || ed) { const ak = (ed && typeof cmpAfterAlpha === "function" ? cmpAfterAlpha() : 1) * objK(); if (ak < 1) withAlpha(ak, () => drawObjects(t, beatK)); else drawObjects(t, beatK); } // (Compare: this version's opacity; Settings → Skin → Object opacity)
    if (ed) edDrawOver(t);
    else { if (RPM.fl) drawFlashlight(t); if (S.cursor && map.hit.length) drawCursor(t); }
    } finally { VFLIP = false; }
    ctx.restore();
  }
  setT(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
  const B = hudBox(box[0], box[1], box[2], box[3], LW, LH, SF, rotated);
  if (!ed) {
    if (testing) playHUD(t, B); else if (S.hud && map.hit.length) { drawHUD(t, B); if (RP.on && S.liveTop50) drawRpBoard(t, B); }
    if (RP.on && !testing) { drawRpKeys(t, B); drawHitBar(t, B); }
    drawTitleCard(B);
  }
  if (S.overlay || ed) drawOverlay(t, B, ed);
  if (S.fpsHud) drawFps(B, ed);
  ctx.globalAlpha = 1;
}
// The map's own epilepsy warning ([General] EpilepsyWarning: 1): on every open of such a difficulty, for 5 s, in the middle of the screen (Preview,
// Replay) or as a smaller card at the playfield's top left (Modding). There is no setting for it; with the storyboard off it isn't shown. The time is kept by timers, not an animation: with
// reduced motion the fades are instant but the warning still stays its 5 s. Returns how long it shows (0: not flagged).
const EPI = { el: null, t: [] };
function epiWarn() {
  for (const id of EPI.t) clearTimeout(id); EPI.t = []; if (EPI.el) { EPI.el.remove(); EPI.el = null; }
  if (!map || !S.sb || String(map.general.EpilepsyWarning || "").trim() !== "1") return 0; // (storyboard off: nothing flashing to warn of)
  const ed = EDIT.on, el = h("div", "epiwarn" + (ed ? " ed" : ""));
  el.setAttribute("role", "alert");
  const ic = h("div", "epiic", "!"); ic.setAttribute("aria-hidden", "true");
  el.append(ic, h("b", "", tr("Epilepsy warning")), h("p", "", tr("This beatmap contains scenes with rapidly flashing colours. Please take caution if you are affected by epilepsy.")));
  if (ed) { const q = cv.dpr || 1; el.style.left = Math.round(INS.l / q + 12) + "px"; el.style.top = Math.round(INS.t / q + 12) + "px"; } // (clear of the tool column and the timeline)
  UI.player.append(el); EPI.el = el;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
  EPI.t.push(setTimeout(() => el.classList.add("out"), 4600), setTimeout(() => { el.remove(); if (EPI.el === el) EPI.el = null; }, 5000));
  return 5000;
}
// Settings → Graphics → FPS counter: frames drawn per second while playing, and the longest gap between two of them in the last second (a stutter
// shows as a big one even when the average looks fine); "WebGL" when the storyboard was drawn by it, "SB n" when a heavy one is drawn lighter
const FPSM = { t0: 0, last: 0, n: 0, worst: 0, fps: 0, gap: 0 };
function fpsTick(pnow, playing) {
  const F = FPSM;
  if (!playing) { F.last = 0; F.fps = 0; return; } // (paused: no rate; the first frame after it starts a new second)
  if (!F.last) { F.last = F.t0 = pnow; F.n = 0; F.worst = 0; return; }
  const gap = pnow - F.last; F.last = pnow; F.n++; if (gap > F.worst) F.worst = gap;
  if (pnow - F.t0 >= 1000) { F.fps = F.n * 1000 / (pnow - F.t0); F.gap = F.worst; F.t0 = pnow; F.n = 0; F.worst = 0; }
}
function drawFps(B, ed) {
  const u = cv.dpr || 1, F = FPSM;
  const txt = (F.fps ? `${Math.round(F.fps)} FPS · ${Math.round(F.gap)} ms` : "– FPS") + (GLS.used ? " · WebGL" : "") + (SBL.lod && S.quality === "auto" ? " · SB " + SBL.lod : "");
  ctx.font = `600 ${11 * u}px ui-monospace,Menlo,monospace`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  let R = ed ? B.r - INS.r : B.r; // (bottom right: the combo counter is bottom left)
  if (VIEW.rotated && !UI.ui.classList.contains("hide")) R = Math.min(R, cv.height - document.querySelector(".bar.bottom").offsetHeight * u); // (rotated: it ends over the bottom bar, as the score does)
  const w = ctx.measureText(txt).width + 14 * u, hh = 20 * u, x = R - 8 * u - w, y = (ed ? B.b : B.bottom) - 8 * u - hh;
  ctx.globalAlpha = 1; ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, hh, 6 * u); else ctx.rect(x, y, w, hh); ctx.fill();
  ctx.fillStyle = F.fps && F.gap > 40 ? "#ffb347" : "#d8f5e0"; ctx.fillText(txt, x + 7 * u, y + hh / 2);
}
