"use strict";
// ============ player controls ============
const UI = {
  player: $("player"), ui: $("ui"), sheet: $("sheet"), tools: $("tools"), tapStart: $("tapStart"), skip: $("skip"),
  seek: $("seek"), tCur: $("tCur"), tDur: $("tDur"), play: $("play"), playPath: $("playPath"), spd: $("spd"), tl: $("tl"), edTime: $("edTime"),
};
let needTapResume = false, startAt = 0, cardStart = -1e9;
function onSongEnd() { keepAwake(false); if (typeof PLAY !== "undefined" && PLAY.on) return playStop(true); showUI(); dirty = true; }
audio.onerror = () => {
  if (A.mode !== "el" || !A.src || audio.src !== A.src) return;
  const wasPlaying = isPlaying(); A.mode = "virt"; A.pos = 0; A.on = false;
  toast(tr("This browser can't play the song of this map, playing without sound"));
  if (wasPlaying && !clock.pre) A.play();
  dirty = true;
};
audio.onended = () => { keepAwake(false); showUI(); dirty = true; };
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
  let sbStart = 0; for (const s of sb) if (s.start < sbStart) sbStart = s.start;
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
UI.skip.onclick = () => { if (!map) return; clock.pre = false; A.seek(map.first - 1800); if (!A.playing()) A.play().catch(onPlayBlocked); lastT = null; };
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
const VIEWPORT = document.querySelector('meta[name="viewport"]'), VP_BASE = VIEWPORT.content;
const lockZoom = on => { VIEWPORT.content = VP_BASE + (on ? ", user-scalable=no" : ""); };
function enterPlayer() {
  lockZoom(true);
  selectScroll = scrollY;
  $("shell").hidden = true; UI.player.hidden = false; resize(); demoStop();
  startLoop();
  if (!EDIT.on && innerHeight > innerWidth && innerWidth < 700 && !enterPlayer.hinted) { enterPlayer.hinted = true; setTimeout(() => toast(S.view === "rotate" ? tr("Rotated 16:9 is on: hold the phone upright and tilt its top to the left") : tr("The view is locked to 16:9. For a full portrait screen pick \"16:9 rotated\" in settings")), 600); }
}
function exitPlayerUI() {
  pausePlayback(); closeSheet(); closeTools();
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
const SET_TABS = [["editor", "Editor"], ["audio", "Audio"], ["display", "Display"], ["skin", "Skin"], ["test", "Test play"], ["keys", "Shortcuts"], ["general", "General"]];
const edOnNow = () => typeof EDIT !== "undefined" && EDIT.on; // (editor.js loads after this file)
const setTabsNow = () => SET_TABS.filter(t => t[0] !== "editor" || edOnNow());
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
  if (k === "editor" && typeof renderEdSettings === "function") renderEdSettings();
  if (k === "keys") buildKeys();
  if (k === "test" && typeof renderTestSettings === "function") renderTestSettings(); // (play.js)
  if (k === "general" && typeof oszCacheUI === "function") oszCacheUI();
  UI.sheet.scrollTop = 0;
}
// keyboard shortcuts, grouped like the osu! editor's menus
const KEY_GROUPS = [
  ["Playback", [["Space", "Play / pause"], ["← →", "Seek 5 s (Modding: one beat snap)"], ["Shift + ← →", "Seek one beat"], ["M", "Metronome on/off"], ["Esc", "Close / back"]]],
  ["Compose", [["1 2 3 4", "Select / Circle / Slider / Spinner"], ["F1 / F2 / F3 / F4", "Compose / Hitsounds / Timing / Setup"], ["G  T", "Grid snap / Distance snap"], ["Shift + G", "Mapping guides (distance and angle) on/off"], ["Alt + scroll", "Distance snap multiplier"], ["Enter / right-click", "Finish the slider you're placing"], ["?", "Editor tour"]]],
  ["Hitsounds", [["Q W E R", "New combo / Whistle / Finish / Clap"], ["Shift / Alt + Q W E R", "Sample set / addition bank: Auto, Normal, Soft, Drum"], ["H", "Hitsound panel (live session: highlight)"]]],
  ["Selection and editing", [["Ctrl + Z / Y", "Undo / redo"], ["Ctrl + A", "Select all"], ["Del", "Delete selected objects"], ["Ctrl + C / X / V", "Copy / cut / paste objects"], ["Ctrl + D", "Clone the selection"],
    ["↑ ↓", "Move the selection by the grid"], ["Alt + ← →", "Move the selection by one beat snap"], ["Right-click", "Menu for objects / empty space (long-press on touch)"], ["Shift + right-click", "Delete the object under the cursor"]]],
  ["Transform", [["Ctrl + H / J", "Flip horizontally / vertically"], ["Ctrl + < / >", "Rotate 90° counter-clockwise / clockwise"], ["Ctrl + G", "Reverse selection"], ["Ctrl + Shift + R", "Rotate / scale"], ["Ctrl + Shift + D", "Polygon circles"], ["Ctrl + Shift + F", "Slider → stream"]]],
  ["Sliders", [["Drag from the head", "Placing: draw the slider freehand"], ["Click the last point / S", "Placing: start a new segment (red anchor)"], ["Alt + 1 / 2 / 3", "Placing: this segment straight / bezier / perfect circle"], ["Tab / Shift + Tab", "Placing: next / previous curve type for this segment"], ["Ctrl + click", "Slider: add a control point on the body • red anchor on a point"], ["Right-click a point", "Slider: delete that control point"]]],
  ["Timeline and timing", [["Shift + L", "Lock / unlock the timeline"], ["Ctrl + scroll", "Zoom the timeline"], ["Ctrl + B", "Bookmark"], ["Ctrl + P", "Add a timing point (Shift: green line)"]]],
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
  $("edMetro").classList.toggle("lit", !!S.metro);
  $("edEnd").classList.toggle("lit", !!S.sliderEnd);
  if (typeof edTrayDot === "function") edTrayDot(); // (the dot on the closed Tools tray, editor.js)
}
$("edEnd").onclick = () => { setToggle("sliderEnd", !S.sliderEnd); toast(tr(S.sliderEnd ? "Slider end circles on" : "Slider end circles off"), 1200); };
function setToggle(k, v) {
  S[k] = v; save(); dirty = true;
  if (k === "sliderShadow") bodyCache.clear(); // (slider bodies are drawn once and kept)
  if (k === "metro") { if (v) ensureAudioCtx(); toast(tr(v ? "Metronome on" : "Metronome off"), 1200); }
  syncToggles();
}
$("metroChip").onclick = () => setToggle("metro", false);
function openSheet() {
  closeTools(); closeLive();
  UI.sheet.hidden = false; clearTimeout(uiTimer);
  syncToggles(); buildSetTabs(); showSetTab(EDIT.on ? S.setTabEd || "editor" : S.setTab || "audio");
  $("dim").value = S.dim; $("hsSrc").value = S.hsSrc; $("quality").value = S.quality; $("view").value = S.view; $("fpsSel").value = S.fps;
  syncOffsetUI();
  if (typeof btSettings === "function") $("btSetBox").replaceChildren(...btSettings()); // in the current language and state
  syncVol();
}
function closeSheet() { if (UI.sheet.hidden) return; UI.sheet.hidden = true; showUI(); }
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
function stepBeat(dir) { // jump to the previous/next beat line
  const t = A.cur(), b = beatInfo(t), n = Math.round((t - b.off) / b.len) + dir;
  seekTo(b.off + n * b.len);
}
document.addEventListener("keydown", e => {
  if (!$("detail").hidden) { if (e.code === "Escape") closeDetail(); return; }
  if (UI.player.hidden) return;
  const tag = e.target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" && e.target.type !== "range" && e.target.type !== "checkbox" || tag === "SELECT") return;
  const tp = typeof tpOn === "function" && tpOn();
  if (e.code === (tp ? tpKey("start") : "F5")) { e.preventDefault(); if (!tp) setMode(!EDIT.on); else if (EDIT.on) playStart(); else setMode(true); return; } // (Modding: test play, like osu!; the key: Settings → Test play; test play off: switch Preview / Modding)
  if (e.code === "KeyM" && !e.ctrlKey && !e.metaKey) { setToggle("metro", !S.metro); return; }
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
let autoCap = Math.min(devicePixelRatio || 1, LOWEND ? 1.5 : 2), slowN = 0, sampN = 0;
const dprNow = () => S.quality === "low" ? 1 : S.quality === "high" ? Math.min(devicePixelRatio || 1, 3) : Math.min(devicePixelRatio || 1, autoCap);
function resize() {
  if (UI.player.hidden) return;
  const q = dprNow();
  const w = UI.player.clientWidth || innerWidth, h = UI.player.clientHeight || innerHeight;
  const cw = Math.round(w * q), ch = Math.round(h * q);
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; bodyCache.clear(); }
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
function drawHead(o, x, y, col, s, a, sliderHead) {
  const c = sliderHead && hasTex("sliderstartcircle") ? "sliderstartcircle" : "hitcircle";
  const ov = sliderHead && hasTex("sliderstartcircleoverlay") ? "sliderstartcircleoverlay" : "hitcircleoverlay";
  blit(T(c, col), x, y, s, a);
  if (SK.overlayAbove) { drawNumber(o.num, x, y, s, a); blit(T(ov), x, y, s, a); }
  else { blit(T(ov), x, y, s, a); drawNumber(o.num, x, y, s, a); }
}
const approachAlpha = (o, t) => clamp01((t - (o.t - map.preempt)) / Math.min(map.preempt, map.fadeIn * 2)) * .9;
// hit burst (circle grows 1 -> 1.4 and fades in 240 ms), hit lighting and the 300 judgement
function hitBurst(o, x, y, col, s, age, sliderHead) {
  if (age < 0) return;
  if (age < 240) {
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
function judgement(x, y, age) {
  if (!S.judge || age < 0 || age > 450 || edOnNow()) return; // (osu!'s editor shows no judgements)
  const sc = age < 96 ? .6 + .5 * (age / 96) : age < 120 ? 1.1 - .2 * ((age - 96) / 24) : .9 + .1 * Math.min(1, (age - 120) / 100);
  blit(T("hit300"), x, y, sc * .6, age < 250 ? 1 : 1 - (age - 250) / 200);
}

function drawBody(o, col, a, frac, from = 0) {
  if (a <= 0.003 || frac <= 0 || frac - from <= 0.0005) return;
  const b = sliderBody(o, col, frac, from); if (!b) return; // (a huge body still being painted: skins.js)
  ctx.globalAlpha = a > 1 ? 1 : a;
  ctx.drawImage(b.c, 0, 0, b.sw, b.sh, b.x, b.y, b.w, b.h);
}
// slider end circle (like osu!lazer's tail): where the slider's path ends, a little see-through so the body still shows
function drawEndCircle(o, col, s, a) {
  const p = pointAt(o, 1), k = a * .85;
  blit(T("hitcircle", col), p[0], p[1], s, k); blit(T("hitcircleoverlay"), p[0], p[1], s, k);
}
function drawArrow(o, atEnd, s, a, beatK) {
  const p = pointAt(o, atEnd ? 1 : 0), q = pointAt(o, atEnd ? .97 : .03);
  blit(T("reversearrow"), p[0], p[1], s * (1 + .15 * beatK), a, Math.atan2(q[1] - p[1], q[0] - p[0]));
}
// OutElasticHalf (osu!framework), for the ticks
const elOutHalf = k => k >= 1 ? 1 : 2 ** (-10 * k) * Math.sin((.5 * k - .075) * 2 * Math.PI / .3) + 1;
function drawBall(o, t, col, s) {
  const b = ballF(o, t), p = pointAt(o, b.f), fr = ballFrames(), own = !!SK.frames.sliderb;
  const tint = (own ? SK.tintBall : !DEFSK || DEFSK.tintBall) ? col : (own && SK.ballColor);
  let f = fr[Math.floor((t - o.t) * (o.vel || .2) / 4) % fr.length];
  if (tint && (tint[0] < 250 || tint[1] < 250 || tint[2] < 250)) f = tintFrame(f, tint);
  const rot = p[2] + (b.back ? Math.PI : 0);
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
function drawSlider(o, t, col, s, aIn, beatK) {
  const pre = map.preempt;
  // after the end the slider fades in 240 ms; with snaking out the body itself goes in 40 ms (osu!lazer)
  const bodyA = t <= o.end ? aIn : clamp01(1 - (t - o.end) / (S.snakingOut !== false ? 40 : 240));
  const [from, frac] = bodyRange(o, t);
  if (bodyA > 0) drawBody(o, col, bodyA, frac, from);
  sliderTicks(o, t, s, aIn); // (above the body; each pops on its own once passed)
  if (bodyA > 0) {
    if (t <= o.end) {
      if (S.sliderEnd) drawEndCircle(o, col, s, bodyA); // always visible when the setting is on (many skins leave sliderendcircle blank)
      else if (hasTex("sliderendcircle")) { const e = endPos(o); blit(T("sliderendcircle", col), e[0], e[1], s, bodyA); blit(T("sliderendcircleoverlay"), e[0], e[1], s, bodyA); }
      if (o.slides > 1 && frac >= 1) {
        const cur = t < o.t ? 0 : ballF(o, t).rep;
        if (cur < o.slides - 1) drawArrow(o, cur % 2 === 0, s, bodyA, beatK);
        if (cur + 1 < o.slides - 1) drawArrow(o, cur % 2 === 1, s, bodyA, beatK);
      }
    }
  }
  if (t < o.t) {
    drawHead(o, o.x, o.y, col, s, aIn, true);
    blit(T("approachcircle", col), o.x, o.y, s * (1 + 3 * (o.t - t) / pre), approachAlpha(o, t));
    return;
  }
  hitBurst(o, o.x, o.y, col, s, t - o.t, true);
  if (t <= o.end) {
    const fin = easeOut(clamp01((t - o.t) / 180));
    const p = drawBall(o, t, col, s);
    blit(T("sliderfollowcircle"), p[0], p[1], s * (.5 + .5 * fin), fin);
  } else {
    const e = endPos(o), age = t - o.end;
    if (age < 200) blit(T("sliderfollowcircle"), e[0], e[1], s * (1 - .2 * age / 200), 1 - age / 200);
    if (S.fx && age < 600) lighting(e[0], e[1], col, s, age);
    judgement(e[0], e[1], age);
  }
}

// spinners: osu! "new style" (glow/bottom/top/middle) or "old style" (background/circle/metre), whichever the skin has
function drawSpinner(o, t, P) { // P: test play's own turning { rot, prog } (play.js); otherwise it spins by itself
  if (t < o.t - 400 || t > o.end + 800) return;
  const a = t < o.t ? clamp01((t - (o.t - 400)) / 400) : t > o.end ? clamp01(1 - (t - o.end) / 240) : 1;
  const dur = Math.max(1, o.end - o.t), e = Math.max(0, Math.min(t, o.end) - o.t);
  const rot = P ? P.rot : e * .05 - 6 * (1 - Math.exp(-e / 400)), prog = P ? P.prog : clamp01(e / Math.min(dur, 1500)), SC = .625, cx = 256, cy = 192;
  if (a > 0) {
    if (SK.newSpinner) {
      ctx.globalCompositeOperation = "lighter"; blit(T("spinner-glow", [3, 151, 255]) || T("spinner-glow"), cx, cy, SC, a * prog); ctx.globalCompositeOperation = "source-over";
      blit(T("spinner-bottom"), cx, cy, SC, a, rot / 3);
      blit(T("spinner-top"), cx, cy, SC, a, rot);
      const mid = T("spinner-middle"); if (mid) blit(prog > .02 ? { img: tintCanvasCached(mid, [255, 255 * (1 - prog), 255 * (1 - prog)]), hd: mid.hd } : mid, cx, cy, SC, a);
      blit(T("spinner-middle2"), cx, cy, SC, a);
    } else {
      const bg = T("spinner-background"); if (bg) blit(bg, cx, cy + 12, SC, a);
      const met = T("spinner-metre");
      if (met && t >= o.t) { // metre fills from the bottom in 10 steps
        const w = met.img.width / met.hd * SC, hh = met.img.height / met.hd * SC, lit = Math.floor(prog * 10) / 10;
        ctx.globalAlpha = a; ctx.drawImage(met.img, 0, met.img.height * (1 - lit), met.img.width, met.img.height * lit, cx - w / 2, cy + 12 - hh / 2 + hh * (1 - lit), w, hh * lit);
      }
      blit(T("spinner-circle"), cx, cy, SC, a, rot);
    }
    if (t >= o.t && t <= o.end) blit(T("spinner-approachcircle"), cx, cy, SC * (1.86 - 1.76 * (e / dur)), a * .9);
  }
  if (t < o.t + 500) blit(T("spinner-spin"), cx, cy + 110, SC, t < o.t ? a : 1 - (t - o.t) / 500);
  if (prog >= 1 && t <= o.end + 400) { const age = Math.max(0, t - (o.t + Math.min(dur, 1500))); blit(T("spinner-clear"), cx, cy - 90, SC * (1.1 - .1 * clamp01(age / 150)), clamp01(age / 100) * a); }
  if (t > o.end) { if (!P) judgement(cx, cy, t - o.end); if (S.fx && t - o.end < 300) { ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = .3 * (1 - (t - o.end) / 300); ctx.drawImage(GLOW, cx - 260, cy - 260, 520, 520); ctx.globalCompositeOperation = "source-over"; } }
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
  const fi = map.fadeIn;
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
      blit(tex, pa[0] + dx * f, pa[1] + dy * f, 1.5 - .5 * easeOut(k), al, ang);
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
function sliderTicks(o, t, s, aIn) {
  if (!o.ticks || !o.ticks.length) return;
  const tk = T("sliderscorepoint");
  for (const [fr] of o.ticks) for (let k = 0; k < o.slides; k++) {
    const ss = o.t + o.span * k, tt = ss + (k % 2 ? 1 - fr : fr) * o.span, appear = tt - ((tt - ss) / 2 + (k ? 200 : map.preempt * .66));
    if (t < appear || t >= tt + 150) continue;
    const p = pointAt(o, fr), sc = .5 + .5 * elOutHalf(clamp01((t - appear) / 600));
    if (t < tt) blit(tk, p[0], p[1], s * sc, aIn * clamp01((t - appear) / 150));
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
    else if (t < o.t) { drawHead(o, o.x, o.y, col, s, aIn); blit(T("approachcircle", col), o.x, o.y, s * (1 + 3 * (o.t - t) / map.preempt), approachAlpha(o, t)); }
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
    if (t >= o.t && t <= o.end) { const fin = easeOut(clamp01((t - o.t) / 180)), p = drawBall(o, t, col, s); blit(T("sliderfollowcircle"), p[0], p[1], s * (.5 + .5 * fin), fin); }
    else if (t > o.end && t - o.end < 200) { const e = endPos(o), age = t - o.end; blit(T("sliderfollowcircle"), e[0], e[1], s * (1 - .2 * age / 200), 1 - age / 200); }
  }
  edCircle(o, o.x, o.y, col, s, aIn, t, o.t, o.kind === "slider");
  edHitMarker(o.x, o.y, col, t, o.t);
  if (sel) edSelection(o, s, objA);
  // the approach circle closes in, then fades out within 50 ms of the hit
  if (t < o.t) blit(T("approachcircle", col), o.x, o.y, s * (1 + 3 * (o.t - t) / map.preempt), approachAlpha(o, t));
  else if (t < o.t + 50) blit(T("approachcircle", col), o.x, o.y, s, approachAlpha(o, o.t) * (1 - (t - o.t) / 50));
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
function drawObjects(t, beatK) {
  const H = map.hit, pre = map.preempt, s = map.radius / 64, ed = EDIT.on, keep = 800;
  const hi = lastBefore(H, t + pre, "t");
  if (hi < 0) return;
  let lo = hi; while (lo > 0 && H[lo - 1].t > t - 30000) lo--;
  drawFollowPoints(t, lo, hi);
  for (let i = hi + 1; i < H.length && H[i].t < t + pre + 4000; i++) if (H[i].kind === "slider" && heavyBody(H[i])) sliderBody(H[i], palette(H[i].ci), 1); // huge bodies: painted ahead (skins.js)
  const drag = ed && EDIT.drag;
  for (let i = hi; i >= lo; i--) {
    const o = H[i];
    if (o.end + keep < t) continue;
    const col = palette(o.ci), aIn = clamp01((t - (o.t - pre)) / map.fadeIn);
    const moved = drag && EDIT.sel.has(o.lid) && o.kind !== "spinner";
    if (moved) { ctx.save(); ctx.translate(EDIT.dx, EDIT.dy); }
    if (ed) drawEditObj(o, t, col, s, aIn, beatK);
    else if (o.kind === "spinner") drawSpinner(o, t);
    else if (o.kind === "slider") drawSlider(o, t, col, s, aIn, beatK);
    else if (t < o.t) {
      drawHead(o, o.x, o.y, col, s, aIn);
      blit(T("approachcircle", col), o.x, o.y, s * (1 + 3 * (o.t - t) / pre), approachAlpha(o, t));
    } else { hitBurst(o, o.x, o.y, col, s, t - o.t); judgement(o.x, o.y, t - o.t); }
    if (moved) ctx.restore();
  }
}

// like osu!: a skin that has its own cursor uses only its own cursormiddle and cursortrail (none if it has none);
// the default skin's parts are never mixed in (that drew two cursors on top of each other). CursorRotate turns the
// cursor slowly; CursorCentre: 0 puts its top-left corner on the position.
function drawCursor(t) {
  const own = !!SK.tex.cursor, cfg = own ? SK : DEFSK && DEFSK.tex.cursor ? DEFSK : FALLBACK;
  const tex = n => own ? SK.tex[n] || null : texOf(n);
  const cur = tex("cursor"), mid = tex("cursormiddle"), trail = tex("cursortrail");
  const off = (tx, s = 1) => tx && cfg.cursorCentre === false ? [tx.img.width / tx.hd * s / 2, tx.img.height / tx.hd * s / 2] : [0, 0];
  if (trail) {
    const n = mid ? 16 : 8, step = mid ? 4 : 8, o = off(trail);
    for (let k = n; k >= 1; k--) { const p = cursorAt(t - k * step); blit(trail, p[0] + o[0], p[1] + o[1], 1, (1 - k / n) * .8); }
  }
  const p = cursorAt(t), x = p[0], y = p[1], rot = cfg.cursorRotate ? (performance.now() / 10000 % 1) * Math.PI * 2 : 0;
  const sc = cfg.cursorExpand !== false ? autoCursorScale(t) : 1; // (expands while Auto holds a button, like osu!)
  const oc = off(cur, sc); blit(cur, x + oc[0], y + oc[1], sc, 1, rot);
  const om = off(mid); blit(mid, x + om[0], y + om[1], 1, 1);
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
function drawHUD(t, B) {
  const u = B.u, ev = map.score, i = lastBefore(ev, t, "t");
  const target = i >= 0 ? ev[i].score : 0, combo = i >= 0 ? ev[i].combo : 0;
  if (target < dispScore) dispScore = target; else dispScore += (target - dispScore) * Math.min(1, frameDt / 90);
  const pad = 14 * u, top = B.top + pad, right = B.r - pad, left = B.l + pad, W = B.r - B.l;
  ctx.textBaseline = "top"; ctx.globalAlpha = 1; ctx.textAlign = "right";
  ctx.font = `600 ${34 * u}px Inter,sans-serif`;
  sText(String(Math.round(dispScore)).padStart(8, "0"), right, top, u, "#fff");
  ctx.font = `600 ${18 * u}px Inter,sans-serif`;
  sText("100.00%", right, top + 40 * u, u, "#fff");
  ctx.font = `600 ${14 * u}px Inter,sans-serif`; sText(A.rate !== 1 ? `Auto ${A.rate}x` : "Auto", right, top + 64 * u, u, "#ff99cc");
  const dur = A.dur() || 1, px = right - 96 * u, py = top + 50 * u, pr = 10 * u;
  ctx.globalAlpha = .9;
  ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.fillStyle = "rgba(255,255,255,.2)"; ctx.fill();
  if (t > 0) { ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, pr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp01(t / dur)); ctx.closePath(); ctx.fillStyle = t < map.first ? "#8ee6a0" : "#fff"; ctx.fill(); }
  ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5 * u; ctx.stroke();
  const hbW = Math.min(W * .34, 320 * u), hbY = top + 6 * u;
  ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillRect(left, hbY, hbW, 9 * u);
  const key = left + "|" + hbW;
  if (key !== hbKey) { hbGrad = ctx.createLinearGradient(left, 0, left + hbW, 0); hbGrad.addColorStop(0, "#ff66aa"); hbGrad.addColorStop(1, "#66ccff"); hbKey = key; }
  ctx.fillStyle = hbGrad; ctx.fillRect(left, hbY, hbW, 9 * u);
  if (combo > 0) {
    const since = t - ev[i].t, pop = 1 + .28 * clamp01(1 - since / 140);
    ctx.save(); ctx.translate(left, B.bottom - pad); ctx.scale(pop, pop);
    ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.globalAlpha = 1;
    ctx.font = `600 ${46 * u}px Inter,sans-serif`; sText(combo + "x", 0, 0, u, "#fff");
    ctx.restore();
  }
  ctx.globalAlpha = 1;
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
  return [-VIEW.ox / vs - 64 - m, -VIEW.oy / vs - 56 - m, (w - VIEW.ox) / vs - 64 + m, (hh - VIEW.oy) / vs - 56 + m];
}
const plx = { x: 0, y: 0 };
let lastT = null, lastPlayIcon = null, loopOn = false, frameDt = 16, plxMoving = false, liveAt = 0, fpsLast = 0;
let domSeek = -1, domCur = "", domDur = "", domEd = "";
function startLoop() { if (!loopOn) { loopOn = true; lastFrame = performance.now(); requestAnimationFrame(frame); } }
function frame() {
  if (UI.player.hidden) { loopOn = false; return; }
  requestAnimationFrame(frame);
  if (!map) return;
  const testing = typeof PLAY !== "undefined" && PLAY.on, pnow = performance.now(), iv = testing ? 0 : 1000 / S.fps, since = pnow - fpsLast; // (test play: every frame the screen has, for the least delay)
  if (since < iv - 1) return; // frame-rate cap (Settings → Display); rAF still runs at the screen's rate
  fpsLast += iv; if (pnow - fpsLast > iv) fpsLast = pnow; // keep a steady schedule; resync after a stall
  const dt = Math.min(100, pnow - lastFrame); lastFrame = pnow; frameDt = dt;
  const playing = isPlaying(), ed = EDIT.on;
  const card = !ed && pnow - cardStart < 3900;
  if (!playing && !dirty && !card && !seeking && !plxMoving) return;
  dirty = false;
  const ta = nowMs(), t = ta - visOffset(); // ta = audio time (hitsounds), t = what is drawn

  if (playing) schedule(ta, btAhead()); else resetSched();
  if (testing && playing) playUpdate(t); // (play.js: misses, slider ticks, spinners as time passes)
  lastT = playing ? t : null;
  if (playing && S.quality === "auto") { // adaptive resolution
    sampN++; if (dt > Math.max(26, iv * 1.45) && dt < 100) slowN++;
    if (sampN >= 120) { if (slowN > 45 && autoCap > 1) { autoCap = Math.max(1, autoCap - .25); resize(); } sampN = slowN = 0; }
  }
  // DOM updates (only when something changed)
  if (A.mode !== "el" && A.on && A.cur() >= A.dur()) { A.pause(); A.pos = A.dur(); onSongEnd(); }
  const dur = A.dur() / 1000;
  if (!seeking && dur) { const v = Math.round(Math.max(0, t) / 1000 / dur * 1000); if (v !== domSeek) { domSeek = v; UI.seek.value = v; UI.seek.style.setProperty("--p", v / 10 + "%"); } }
  const c = ed ? fmtMs(t) : fmt(t / 1000), d = fmt(dur);
  if (c !== domCur) UI.tCur.textContent = domCur = c;
  if (d !== domDur) UI.tDur.textContent = domDur = d;
  if (ed) { const s = fmtMs(t), k = s + "|" + map.bookmarks.length; if (k !== domEd) { UI.edTime.textContent = s; domEd = k; edBmSync(t); } } // (the bottom bar's bookmark button lights up on one)
  const showSkip = !ed && playing && map.first > 6000 && t < map.first - 2500;
  if (UI.skip.hidden === showSkip) UI.skip.hidden = !showSkip;
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
  ctx.save(); ctx.beginPath(); ctx.rect(-107, 0, 854, 480); ctx.clip();
  if (bg && !bgHidden) {
    const base = Math.max(854 / bg.width, 480 / bg.height), zoom = 1.02 + (kiai ? .012 * beatK : 0), k = base * zoom;
    let tx = 0, ty = 0;
    if (S.parallax && !ed) { const cp = cursorAt(t); tx = (cp[0] - 256) * -.015; ty = (cp[1] - 192) * -.015; }
    const f = 1 - Math.exp(-dt / 140); plx.x += (tx - plx.x) * f; plx.y += (ty - plx.y) * f;
    plxMoving = Math.abs(tx - plx.x) + Math.abs(ty - plx.y) > .05;
    const w = bg.width * k, hh = bg.height * k;
    ctx.drawImage(scaledImg(0, bg, bg.width * base * 1.04 * vs, bg.height * base * 1.04 * vs), 320 - w / 2 + plx.x, 240 - hh / 2 + plx.y, w, hh);
  }
  const vid = vidFor();
  if (vid && vidSync(vid, t)) { // the map's video: above the background, under the storyboard (like osu!)
    const k = Math.max(854 / vid.videoWidth, 480 / vid.videoHeight), w = vid.videoWidth * k, hh = vid.videoHeight * k;
    try { ctx.drawImage(vid, 320 - w / 2, 240 - hh / 2, w, hh); } catch {}
    if (!vid.paused) dirty = true;
  }
  if (S.sb && sb.length) {
    const m = ctx.getTransform(); SBM[0] = m.a; SBM[1] = m.b; SBM[2] = m.c; SBM[3] = m.d; SBM[4] = m.e; SBM[5] = m.f;
    for (const s of sb) if (t >= s.start && t <= s.end) drawSprite(s, t);
    ctx.setTransform(m);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  const dim = ed ? Math.max(0, Math.min(100, S.edDim ?? 60)) : S.dim; // (the editor has its own: Settings → Editor)
  if (dim) { ctx.fillStyle = ed ? `rgba(26,29,44,${dim / 100})` : `rgba(0,0,0,${dim / 100})`; ctx.fillRect(-107, 0, 854, 480); }
  if (kiai) drawKiai(t);
  ctx.restore();

  if (testing) { ctx.save(); ctx.translate(64, 56); playDraw(t, beatK); playCursor(); ctx.restore(); } // test play (play.js)
  else if (S.notes || S.cursor || ed) {
    ctx.save(); ctx.translate(64, 56);
    if (ed) edDrawUnder(t);
    if (S.notes || ed) { const ak = ed && typeof cmpAfterAlpha === "function" ? cmpAfterAlpha() : 1; if (ak < 1) withAlpha(ak, () => drawObjects(t, beatK)); else drawObjects(t, beatK); } // (Compare: this version's opacity)
    if (ed) edDrawOver(t);
    else if (S.cursor && map.hit.length) drawCursor(t);
    ctx.restore();
  }
  setT(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
  const B = hudBox(box[0], box[1], box[2], box[3], LW, LH, SF, rotated);
  if (!ed) {
    if (testing) playHUD(t, B); else if (S.hud && map.hit.length) drawHUD(t, B);
    drawTitleCard(B);
  }
  if (S.overlay || ed) drawOverlay(t, B, ed);
  ctx.globalAlpha = 1;
}
