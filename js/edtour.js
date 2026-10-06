"use strict";
// ============ the editor tour (coach marks over the real editor) ============
// A short, passive walk-through: the screen dims around one part of the editor (the "hole", lit with an outline) and
// a small card beside it says what it is; Back / Next / × (and ← → Enter Esc) move through it. Nothing under the dim
// layer can be clicked or typed into meanwhile, so the map and the editor stay as they were. Two chapters: Simple
// (osu!'s own tools) and Advanced (what the Advanced switch adds). It starts by itself the first time the editor opens
// on a device (S.edTourSeen) and the first time Advanced is turned on (S.edTourAdvSeen), both per device
// (PREFS_LOCAL in account.js) and stored as a version, so a big layout change can show it once more (ETOUR_VER).
// Settings → Editor → Show the tour (S.edTour) turns the auto-start off; ⋯ → Editor tour, "?" and Settings replay it.
// Never for live-session guests (body.live-watch), during a live session or collab, or in the invite page's
// ?demo=tour frame; ?demo=try shows it once per page load. (demo.js already declares TOUR, tourStart, pfClient…:
// a second top-level name would be a SyntaxError, so everything here is ETOUR / etour / edTour.)
const ETOUR_VER = 1;
// the steps, in English (tr() when shown, so a language change applies at once). sel: every visible match is lit
// together; selPhone: instead, on upright phones (ONE_ROW); area "field": the playfield and the timing pill (drawn on
// the canvas); layout "phone": upright phones only; place: the card's first-choice side; bodyTouch: touch-only
// screens; bodyNarrow: without the desktop layout (no Additions row there); cta "advanced": the last Simple step offers
// the Advanced chapter. A step whose target isn't on screen (this layout, Simple / Advanced) is left out of the count.
const ETOUR_STEPS = {
  simple: [
    { id: "tabs", sel: "#edTabs", place: "bottom", title: "The editor tabs", body: "Compose is where you place objects. Timing, Hitsounds, Verify and Setup work like osu!'s own screens.", keys: ["F1", "F2", "F3", "F4"] },
    { id: "compare", sel: "#edTabs [data-etab=compare]", place: "bottom", title: "Compare versions", body: "Compare shows what changed against another version, and can show the old one faint on the playfield while you edit." },
    { id: "ghost", sel: "#cmpDock", title: "Compare ghost", body: "The other version shows faint on the playfield. Fold this panel, or set how strong each version looks." },
    { id: "timeline", sel: "#edTop", place: "bottom", title: "Timeline and beat snap", body: "Drag the timeline to move through the song, and use + and − to zoom. Beat snap sets where new objects land: 1/4 suits most songs.", keys: ["← →", "Ctrl+scroll"] },
    { id: "tools", sel: "#edLeft [data-tool]", title: "Pick a tool", body: "Select, Circle, Slider and Spinner, just like in osu!. With a placing tool, click the playfield to add an object at the current time.", bodyTouch: "Select, Circle, Slider and Spinner, just like in osu!. With a placing tool, tap the playfield to add an object at the current time.", keys: ["1", "2", "3", "4"] },
    { id: "field", area: "field", title: "The playfield", body: "With Select, click an object to select it and drag to move it. Its time, snap and spacing show at the top; right-click for more options.", bodyTouch: "With Select, tap an object to select it and drag to move it. Its time, snap and spacing show at the top; long-press for more options." },
    { id: "hitsounds", sel: "#edNC, #edW, #edF, #edC", title: "Combos and hitsounds", body: "NC starts a new combo on the selected objects. W, F and C add a whistle, finish or clap.", keys: ["Q", "W", "E", "R"] },
    { id: "samples", sel: "#edBanks [data-bank], #edBanks [data-add]", title: "Sample set", body: "N, S and D pick Normal, Soft or Drum sounds for the selected objects. Additions picks them for the whistle, finish and clap only.", bodyNarrow: "N, S and D pick Normal, Soft or Drum sounds for the selected objects." },
    { id: "snaps", sel: "#edGrid, #edDS", title: "Grid and distance snap", body: "Grid snaps objects to a grid. Distance snap (DS) keeps the spacing in step with the time between objects.", keys: ["G", "T"] },
    { id: "history", sel: "#edUndo, #edRedo, #edDel", title: "Undo, redo, delete", body: "Made a mistake? Undo it. Delete removes the selected objects.", keys: ["Ctrl+Z", "Ctrl+Y", "Del"] },
    { id: "rows", sel: "#edMenu", layout: "phone", title: "Need more room?", body: "Need more room? ⋯ → Hide tool rows gives the playfield more of the screen. Use ⋯ again to bring them back." }, // (upright phones: the item is in the ⋯ menu)
    { id: "play", sel: "#play, #edTime", title: "Play and timestamps", body: "Play the map with its hitsounds. Click the time to copy a timestamp; right-click it to paste one and jump there.", bodyTouch: "Play the map with its hitsounds. Tap the time to copy a timestamp; hold it to paste one and jump there.", keys: ["Space"] },
    { id: "save", sel: "#cloudBtn, #edSave", title: "Save your work", body: "Save your edits here, and save often. You can download the .osu or the whole .osz for osu!.", keys: ["Ctrl+S"] },
    { id: "more", sel: "#edAdv", cta: "advanced", title: "Want more tools?", body: "Advanced adds mod notes, annotations and more mapping tools. Replay this tour anytime from ⋯ or Settings → Editor." },
  ],
  advanced: [
    { id: "adv-on", sel: "#edAdv", title: "Advanced tools are on", body: "The new tools sit under osu!'s own, so nothing you know moves. Here's a quick look." },
    { id: "adv-tabs", sel: "#edTabs [data-etab=notes]", place: "bottom", title: "Mod notes", body: "Mod notes collects your notes with timestamps, ready to post." },
    { id: "adv-tray", sel: "#edTrayBtn", layout: "phone", title: "Advanced tools", body: "Tools opens a tray with the mapping and modding tools. It stays open until you close it." },
    { id: "adv-pattern", sel: "#edStream, #edPoly, #edXform", title: "Pattern tools", body: "Turn a slider into a stream, make polygon circles, or rotate, scale and flip the selection.", keys: ["Ctrl+Shift+F", "Ctrl+Shift+D", "Ctrl+Shift+R"] },
    { id: "adv-hs", sel: "#edHS, #edGuide", title: "Hitsounds and guides", body: "HS sets hitsounds for slider parts, the volume and the addition bank. Guides show the distance and angle to the previous object.", keys: ["H", "Shift+G"] },
    { id: "adv-helpers", sel: "#edMetro, #edTimingQ, #edEnd, #edBook", title: "Metronome, timing, bookmarks", body: "Metro clicks on every beat and Timing adds a timing point here. End shows slider ends; Bookmark marks this moment.", keys: ["M", "Ctrl+P", "Ctrl+B"] },
    { id: "adv-notes", sel: "#edNote, .annbtns [data-ann]", title: "Notes and annotations", body: "+ Note writes a mod with the timestamp filled in. Comment, arrow and highlight mark spots right on the playfield.", keys: ["N"] },
    { id: "adv-lists", sel: "#edSideNotes, #edSideAnns, #edSideVfy", title: "Lists beside the playfield", body: "Open your notes, annotations or a quick Verify check next to the playfield. Click a row to jump there.", bodyTouch: "Open your notes, annotations or a quick Verify check next to the playfield. Tap a row to jump there." },
  ],
};
const ETOUR_TOUCH = matchMedia("(hover: none) and (pointer: coarse)"); // (a phone without a keyboard: no hotkey chips, "tap" wording)
const ETOUR = { on: false, ch: "", id: "", welcome: false, offer: false, dont: false, sig: "", back: null, root: null, card: null, hole: null,
  wait: false, raf: 0, ro: null, mo: null, rowHid: false, scrolled: new Map(), want: "", wantAt: 0, since: 0, poll: 0, advPend: false };
const ETOUR_SEEN = { simple: "edTourSeen", advanced: "edTourAdvSeen" }, ETOUR_SNOOZE = { simple: "edTourSnooze", advanced: "edTourAdvSnooze" };

// ---------- seen / snoozed (per device; the playable demo saves nothing, so it keeps them for the tab's session) ----------
function etourSeen(ch) {
  if ((+S[ETOUR_SEEN[ch]] || 0) >= ETOUR_VER) return true;
  if (DEMO_TRY) try { return sessionStorage.getItem("obv-etour-" + ch) === "1"; } catch {}
  return false;
}
function etourMark(ch) { S[ETOUR_SEEN[ch]] = ETOUR_VER; save(); if (DEMO_TRY) try { sessionStorage.setItem("obv-etour-" + ch, "1"); } catch {} }
// no auto-start at all: switched off, the invite page's auto-playing frame, a guest watching a live session, or any live session / collab running
const etourBlocked = () => S.edTour === false || DEMO_TOUR && !DEMO_TRY || document.body.classList.contains("live-watch") || typeof LIVE !== "undefined" && (LIVE.on || LIVE.watch && LIVE.opening);
// will the Simple chapter start by itself? (setMode's first-time toast then stays away, it would sit under the dim layer)
function edTourWill() { return !etourBlocked() && !etourSeen("simple"); }
// the editor is settled: map open, nothing loading, no pop-up / sheet / menu / dialog / slider in progress, not test playing
const etourReady = () => EDIT.on && EDIT.tab === "compose" && !!map && $("loading").hidden && !UI.player.hidden && !document.querySelector(".mdl") &&
  !(typeof openSheetEl === "function" && openSheetEl()) && $("playStop").hidden && !EDIT.sliderPts && !EDIT.dlg && !CTX.stack.length && !etourBlocked();

// ---------- auto-start: setMode(true) calls edTourMaybe, setEdAdv(true) edTourAdvMaybe; a light poll waits until the editor is settled ----------
function edTourMaybe() {
  if (ETOUR.on || etourBlocked()) return;
  if (!etourSeen("simple")) etourWant("simple");
  else if (ETOUR.advPend && edAdv() && !etourSeen("advanced")) etourWant("advanced"); // (Advanced came on outside Compose last time)
}
function edTourAdvMaybe() {
  if (ETOUR.on || etourBlocked() || etourSeen("advanced") || ETOUR.want === "simple") return; // (the Simple chapter's last step offers it)
  ETOUR.advPend = true; if (EDIT.on) etourWant("advanced");
}
function etourWant(ch) { ETOUR.want = ch; ETOUR.wantAt = performance.now(); ETOUR.since = 0; clearInterval(ETOUR.poll); ETOUR.poll = setInterval(etourTick, 250); }
function etourTick() {
  const ch = ETOUR.want, now = performance.now(), stop = () => { clearInterval(ETOUR.poll); ETOUR.poll = 0; ETOUR.want = ""; };
  if (!ch || ETOUR.on || !EDIT.on || etourBlocked() || etourSeen(ch) || ch === "advanced" && !edAdv()) return stop();
  if (ch === "simple" && now - ETOUR.wantAt > 60000) return stop(); // (straight to work, or a long dialog: next time the editor opens)
  if (!etourReady()) { ETOUR.since = 0; return; }
  if (!ETOUR.since) ETOUR.since = now;
  if (now - ETOUR.since < 600) return; // (the bars and columns have their final size)
  stop(); edTourStart(ch, ch === "advanced" ? { offer: true } : {});
}

// ---------- which steps apply here (layout, Simple / Advanced, what's on screen) ----------
const etourSel = s => ONE_ROW.matches && s.selPhone || s.sel;
const etourShown = el => el.getClientRects().length > 0 && !el.closest("[hidden]");
function etourOk(s) {
  if (s.layout === "phone" && !ONE_ROW.matches) return false;
  if (s.area === "field") return !!etourField();
  return [...document.querySelectorAll(etourSel(s))].some(etourShown);
}
const etourList = () => (ETOUR_STEPS[ETOUR.ch] || []).filter(etourOk);
const etourSig = list => list.map(s => s.id).join() + "|" + ED_DESK.matches + ETOUR_TOUCH.matches; // (bodyNarrow / bodyTouch follow these)
const etourBody = s => ETOUR_TOUCH.matches && s.bodyTouch || !ED_DESK.matches && s.bodyNarrow || s.body;
// the current step, or (it no longer applies, e.g. "rows" after turning the phone) the next one that does
function etourCur(list) {
  const all = ETOUR_STEPS[ETOUR.ch] || [], at = Math.max(0, all.findIndex(s => s.id === ETOUR.id));
  return all.slice(at).find(s => list.includes(s)) || list[list.length - 1] || null;
}

// ---------- geometry (client px) ----------
// the playfield (512x384 osu!px plus a circle's radius, like demo.js's formula) and the timing pill over it
// (drawOverlay.box, canvas px), kept between the bars and the tool columns
function etourField() {
  if (!map || !EDIT.on || !cv.getClientRects().length) return null;
  const r = cv.getBoundingClientRect(), d = cv.dpr || 1, P = (x, y) => [r.left + ((x + 64) * VIEW.vs + VIEW.ox) / d, r.top + ((y + 56) * VIEW.vs + VIEW.oy) / d];
  const pad = (map.radius || 30) * VIEW.vs / d, [x0, y0] = P(0, 0), [x1, y1] = P(512, 384), B = drawOverlay.box;
  let left = x0 - pad, top = y0 - pad, right = x1 + pad, bottom = y1 + pad;
  if (B) { left = Math.min(left, r.left + B.x / d); top = Math.min(top, r.top + B.y / d); right = Math.max(right, r.left + (B.x + B.w) / d); bottom = Math.max(bottom, r.top + (B.y + B.h) / d); }
  left = Math.max(left, r.left + INS.l / d); top = Math.max(top, r.top + INS.t / d); right = Math.min(right, r.right - INS.r / d); bottom = Math.min(bottom, r.bottom - INS.b / d);
  return right - left > 20 && bottom - top > 20 ? { left, top, right, bottom } : null;
}
// el's rect, after scrolling the rows / columns around it so it shows (never scrollIntoView: iOS would scroll the page),
// clipped to them; the first scroll position of each is kept for the close
function etourVis(el) {
  let r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null;
  r = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p), sx = /auto|scroll/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1, sy = /auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
    if (!sx && !sy) continue;
    if (!ETOUR.scrolled.has(p)) { ETOUR.scrolled.set(p, [p.scrollLeft, p.scrollTop]); p.addEventListener("scroll", etourQueue, { passive: true }); }
    let pr = p.getBoundingClientRect();
    const dx = !sx ? 0 : r.left < pr.left ? r.left - pr.left - 8 : r.right > pr.right ? r.right - pr.right + 8 : 0;
    const dy = !sy ? 0 : r.top < pr.top ? r.top - pr.top - 8 : r.bottom > pr.bottom ? r.bottom - pr.bottom + 8 : 0;
    if (dx || dy) { p.scrollBy({ left: dx, top: dy, behavior: "instant" }); const n = el.getBoundingClientRect(); r = { left: n.left, top: n.top, right: n.right, bottom: n.bottom }; pr = p.getBoundingClientRect(); }
    r = { left: Math.max(r.left, pr.left), top: Math.max(r.top, pr.top), right: Math.min(r.right, pr.right), bottom: Math.min(r.bottom, pr.bottom) };
  }
  return r.right - r.left > 0 && r.bottom - r.top > 0 ? r : null;
}
// the spotlight: the union of every visible target, inside the viewport
function etourTarget(s, V) {
  const rs = s.area === "field" ? [etourField()].filter(Boolean) : [...document.querySelectorAll(etourSel(s))].filter(etourShown).map(etourVis).filter(Boolean);
  if (!rs.length) return null;
  const l = Math.max(V.l, Math.min(...rs.map(r => r.left))), t = Math.max(V.t, Math.min(...rs.map(r => r.top))), r = Math.min(V.r, Math.max(...rs.map(r => r.right))), b = Math.min(V.b, Math.max(...rs.map(r => r.bottom)));
  return r - l < 1 || b - t < 1 ? null : { l, t, r, b, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
}
// the visible viewport (the iOS address bar, pinch zoom) and, inside it, where a card may go: safe areas plus a 16 px gutter
function etourView() {
  const vv = window.visualViewport, cs = getComputedStyle($("safe")), px = k => parseFloat(cs[k]) || 0;
  const l = vv ? vv.offsetLeft : 0, t = vv ? vv.offsetTop : 0, w = vv ? vv.width : innerWidth, hh = vv ? vv.height : innerHeight;
  return { l, t, r: l + w, b: t + hh, w, h: hh, L: l + px("paddingLeft") + 16, T: t + px("paddingTop") + 16, R: l + w - px("paddingRight") - 16, B: t + hh - px("paddingBottom") - 16 };
}
// the card's sides in order: beside a tool column, else under a target in the top half and over one in the bottom half;
// never left / right on a narrow screen
function etourSides(s, T, V) {
  const inCol = id => { const c = $(id); if (!c || !c.getClientRects().length || getComputedStyle(c).flexDirection === "row") return false; const r = c.getBoundingClientRect(); return T.cx >= r.left && T.cx <= r.right && T.cy >= r.top && T.cy <= r.bottom; };
  let o = inCol("edLeft") ? ["right", "bottom", "top"] : inCol("edRight") ? ["left", "bottom", "top"] : T.cy < V.t + V.h / 2 ? ["bottom", "top", "right", "left"] : ["top", "bottom", "right", "left"];
  if (s.place && s.place !== "auto") o = [s.place, ...o.filter(k => k !== s.place)];
  return V.w <= 520 ? o.filter(k => k === "top" || k === "bottom") : o;
}

// ---------- start / close ----------
function edTourStart(ch, o = {}) {
  if (ETOUR.on || !ETOUR_STEPS[ch] || !EDIT.on || !map || UI.player.hidden || document.body.classList.contains("live-watch") || DEMO_TOUR && !DEMO_TRY || typeof PLAY !== "undefined" && PLAY.on) return false;
  clearInterval(ETOUR.poll); ETOUR.poll = 0; ETOUR.want = ""; if (ch === "advanced") ETOUR.advPend = false;
  etourTidy();
  if (ch === "advanced" && !edAdv()) setEdAdv(true, true); // (Settings → Tour of the Advanced tools: shown first, the layout settles in the 2 frames below)
  if (ch === "advanced") applyEdTray(true); // (upright phones: its steps show the tools in the tray; closing the tour puts the tray back as it was)
  Object.assign(ETOUR, { on: true, ch, id: o.from || "", welcome: ch === "simple" && !o.skipWelcome, offer: !!o.offer, dont: false, sig: "", back: document.activeElement, scrolled: new Map() });
  etourBuild();
  if (UI.player.classList.contains("edrowhid")) { UI.player.classList.remove("edrowhid"); ETOUR.rowHid = true; } // (phones: the hidden tool rows show for the tour; the "rows" step says how to hide them)
  measureIns(); dirty = true;
  etourSoon();
  return true;
}
// a clean editor under the tour: paused, no sheet / menu / dialog / pop-up / tool in progress, on Compose (the map, the selection and the tool stay)
function etourTidy() {
  pausePlayback();
  for (let k = 0; k < 6 && typeof closeAnySheet === "function" && closeAnySheet(); k++);
  ctxClose(); if (EDIT.dlg) closeDlg(); if ($("qnote") && !$("qnote").hidden) closeQuick(); edHint(true);
  if (typeof hssPopClose === "function") hssPopClose();
  if (typeof ANN !== "undefined" && ANN.tool) annSetTool("");
  if (typeof inkAway === "function") inkAway();
  if (EDIT.sliderPts) { EDIT.sliderPts = null; $("edSliderDone").hidden = true; } // (as Esc does)
  if (EDIT.tab !== "compose") edTab("compose");
  clearTimeout(toast.h); $("toast").classList.remove("on"); // ("Advanced tools on…" would sit under the dim layer)
  const a = document.activeElement; if (a && a !== document.body && a.matches && a.matches("input,textarea,select")) a.blur(); // (e.g. the timestamp field)
}
function etourBuild() {
  const root = h("div", "etour init"), hole = h("div", "etour-hole none"), card = h("div", "etour-card"), live = h("div", "etour-live");
  root.id = "edTour"; live.setAttribute("aria-live", "polite");
  card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "etourT"); card.setAttribute("aria-describedby", "etourB");
  const head = h("div", "etour-head"), x = h("button", "etour-x"), title = h("h3", "etour-title"), body = h("p", "etour-body"), opt = h("label", "nquote etour-opt"), cb = h("input");
  x.type = "button"; x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'; x.onclick = () => edTourClose(true);
  title.id = "etourT"; body.id = "etourB"; cb.type = "checkbox"; cb.onchange = () => ETOUR.dont = cb.checked;
  opt.append(cb, h("span")); head.append(h("span", "etour-count"), x);
  card.append(h("i", "etour-bar"), head, title, body, h("div", "etour-keys"), opt, h("div", "etour-foot"), h("i", "etour-arrow"));
  root.append(hole, card, live);
  // every press, tap, right-click and wheel outside the card stops here: the editor under it can't be used (or scrolled, or long-pressed)
  const stop = e => { if (!card.contains(e.target) && e.cancelable) e.preventDefault(); e.stopPropagation(); };
  for (const ev of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "touchstart", "touchmove", "wheel"]) root.addEventListener(ev, stop, { passive: false });
  Object.assign(ETOUR, { root, hole, card });
  document.body.append(root);
  addEventListener("keydown", etourKey, true);
  addEventListener("resize", etourQueue); addEventListener("orientationchange", etourQueue); addEventListener("langchange", etourLang);
  if (window.visualViewport) { visualViewport.addEventListener("resize", etourQueue); visualViewport.addEventListener("scroll", etourQueue); }
  ONE_ROW.addEventListener("change", etourLater); ED_DESK.addEventListener("change", etourLater);
  ETOUR.ro = new ResizeObserver(etourQueue);
  for (const q of [".bar.top", ".bar.bottom", "#edLeft", "#edRight"]) { const el = document.querySelector(q); if (el) ETOUR.ro.observe(el); }
  ETOUR.mo = new MutationObserver(etourQueue); // (a pop-up opening, live-watch turning on, the player closing)
  ETOUR.mo.observe(document.body, { childList: true, attributes: true, attributeFilter: ["class"] });
  ETOUR.mo.observe(UI.player, { attributes: true, attributeFilter: ["hidden", "class"] });
}
// seen: ×, Esc, Done (it can be replayed); not seen: leaving the editor, live-watch, Not now (until snoozed twice)
function edTourClose(seen) {
  if (!ETOUR.on) return;
  ETOUR.on = false; cancelAnimationFrame(ETOUR.raf); ETOUR.raf = 0;
  if (seen) etourMark(ETOUR.ch);
  if (ETOUR.dont) { S.edTour = false; save(); }
  removeEventListener("keydown", etourKey, true);
  removeEventListener("resize", etourQueue); removeEventListener("orientationchange", etourQueue); removeEventListener("langchange", etourLang);
  if (window.visualViewport) { visualViewport.removeEventListener("resize", etourQueue); visualViewport.removeEventListener("scroll", etourQueue); }
  ONE_ROW.removeEventListener("change", etourLater); ED_DESK.removeEventListener("change", etourLater);
  ETOUR.ro.disconnect(); ETOUR.mo.disconnect();
  for (const [p, [x, y]] of ETOUR.scrolled) { p.removeEventListener("scroll", etourQueue); p.scrollTo({ left: x, top: y, behavior: "instant" }); }
  ETOUR.scrolled = new Map();
  if (ETOUR.rowHid) { ETOUR.rowHid = false; UI.player.classList.toggle("edrowhid", S.edRowHidden === true); }
  if (ETOUR.ch === "advanced") applyEdTray(); // (the tray as the user left it)
  const root = ETOUR.root; ETOUR.root = ETOUR.card = ETOUR.hole = null;
  root.classList.add("out"); setTimeout(() => root.remove(), 130);
  const b = ETOUR.back; ETOUR.back = null;
  if (b && b !== document.body && b.isConnected && b.getClientRects().length && b.focus) try { b.focus({ preventScroll: true }); } catch {}
  if (EDIT.on) { measureIns(); dirty = true; }
}
function etourSnooze() { const k = ETOUR_SNOOZE[ETOUR.ch]; S[k] = (+S[k] || 0) + 1; save(); edTourClose(S[k] >= 2); } // (Not now: asks again next time, twice at most)

// ---------- moving through it ----------
function etourMain() {
  if (ETOUR.welcome) { ETOUR.welcome = false; ETOUR.id = ""; return etourShow(true); }
  const list = etourList(), i = list.indexOf(etourCur(list));
  if (i < 0 || i >= list.length - 1) return edTourClose(true);
  ETOUR.id = list[i + 1].id; etourShow(true);
}
function etourBack() {
  if (ETOUR.welcome) return;
  const list = etourList(), i = list.indexOf(etourCur(list));
  if (i > 0) { ETOUR.id = list[i - 1].id; etourShow(true); }
}
// the last Simple step: on to the Advanced chapter (Advanced turned on quietly, 2 frames for its layout)
function etourAdvanced() {
  etourMark("simple"); ETOUR.advPend = false;
  Object.assign(ETOUR, { ch: "advanced", id: "", offer: false, welcome: false });
  if (!edAdv()) setEdAdv(true, true);
  applyEdTray(true);
  etourSoon();
}
// the card shows 2 frames later, once the layout has settled (measureIns runs in a frame); hidden meanwhile
function etourSoon() { ETOUR.wait = true; ETOUR.card.style.visibility = "hidden"; requestAnimationFrame(() => requestAnimationFrame(() => { if (ETOUR.on) { ETOUR.wait = false; etourShow(true); } })); }
function etourKey(e) {
  if (!ETOUR.on || document.querySelector(".mdl")) return; // (a pop-up on top keeps its keys)
  const k = e.key, a = document.activeElement, ctl = ETOUR.card.contains(a) && a.matches("button,input");
  if ((e.ctrlKey || e.metaKey) && /^[rltw+=0-]$/i.test(k) || k === "F11" || k === "F12") return; // reload, address bar, tabs, zoom
  e.stopImmediatePropagation(); // everything else stops here: Space doesn't play, Q doesn't toggle NC, Ctrl+Z doesn't undo, F5 doesn't leave
  if (k === "Tab") { // (focus stays in the card)
    e.preventDefault();
    const f = [...ETOUR.card.querySelectorAll("button,input")].filter(x => !x.disabled && x.getClientRects().length), i = f.indexOf(a);
    if (f.length) f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1)].focus();
    return;
  }
  if ((k === "Enter" || k === " ") && ctl) return; // (the focused button or checkbox presses itself)
  e.preventDefault();
  if (k === "Escape") edTourClose(true);
  else if (k === "ArrowRight" || k === "Enter") etourMain();
  else if (k === "ArrowLeft") etourBack();
}
const etourQueue = () => { if (ETOUR.on && !ETOUR.raf) ETOUR.raf = requestAnimationFrame(() => { ETOUR.raf = 0; etourPlace(false); }); };
const etourLater = () => requestAnimationFrame(etourQueue); // (ONE_ROW / ED_DESK: after edToolRow has moved the buttons)
const etourLang = () => { if (ETOUR.on) etourShow(false); };

// ---------- the card ----------
function etourShow(anim) {
  if (!ETOUR.on || ETOUR.wait) return;
  const list = etourList(), s = ETOUR.welcome ? null : etourCur(list);
  if (!ETOUR.welcome && !s) return edTourClose(false); // (nothing of this chapter is on screen)
  if (s) ETOUR.id = s.id;
  ETOUR.sig = etourSig(list);
  const C = ETOUR.card, i = s ? list.indexOf(s) : -1, n = list.length, last = !!s && i === n - 1, q = sel => C.querySelector(sel);
  const cnt = q(".etour-count"), keys = q(".etour-keys"), opt = q(".etour-opt"), foot = q(".etour-foot");
  cnt.textContent = s ? tr("{i} / {n}", { i: i + 1, n }) : ""; cnt.setAttribute("aria-label", s ? tr("Step {i} of {n}", { i: i + 1, n }) : "");
  q(".etour-bar").style.setProperty("--k", s ? (i + 1) / n : 0);
  q(".etour-title").textContent = tr(s ? s.title : "Welcome to the editor");
  q(".etour-body").textContent = tr(s ? etourBody(s) : "It's laid out like osu!'s editor. Want a quick tour? It takes about a minute.");
  keys.replaceChildren(...(s && s.keys && !ETOUR_TOUCH.matches ? s.keys.map(k => h("kbd", null, kbdMod(k))) : [])); keys.hidden = !keys.children.length;
  opt.hidden = !(ETOUR.welcome || ETOUR.offer && i === 0 || last); opt.querySelector("input").checked = ETOUR.dont; opt.querySelector("span").textContent = tr("Don't show this again");
  q(".etour-x").setAttribute("aria-label", tr("Close the tour")); q(".etour-x").title = tr("Close the tour");
  const btn = (label, cls, fn) => { const b = h("button", "btn sm " + cls, tr(label)); b.type = "button"; b.onclick = fn; return b; };
  const bs = [];
  if (ETOUR.welcome) bs.push(btn("Not now", "ghost grow", etourSnooze), btn("Start the tour", "main", etourMain));
  else {
    if (i > 0) bs.push(btn("Back", "ghost grow", etourBack));
    else if (ETOUR.offer) bs.push(btn("Not now", "ghost grow", etourSnooze));
    if (last && s.cta === "advanced") bs.push(btn(edAdv() ? "Tour of the Advanced tools" : "Show Advanced tools", "ghost", etourAdvanced));
    bs.push(btn(last ? "Done" : "Next", "main", last ? () => edTourClose(true) : etourMain));
  }
  foot.replaceChildren(...bs);
  ETOUR.root.querySelector(".etour-live").textContent = (s ? tr("Step {i} of {n}", { i: i + 1, n }) + ". " : "") + q(".etour-title").textContent;
  etourPlace(anim, list);
  const main = foot.querySelector(".btn.main"); if (main && C.style.visibility !== "hidden") main.focus({ preventScroll: true });
}
// hole and card on the target, the card on the first side with room, else inside the spotlight; never off the screen
function etourPlace(anim, list) {
  if (!ETOUR.on) return;
  if (!EDIT.on || UI.player.hidden || document.body.classList.contains("live-watch")) return edTourClose(false);
  if (UI.player.classList.contains("edrowhid")) { UI.player.classList.remove("edrowhid"); ETOUR.rowHid = true; measureIns(); } // (edToolRow puts it back on a layout change)
  if (!list && !ETOUR.welcome && etourSig(etourList()) !== ETOUR.sig) return etourShow(false); // (the layout changed: steps came or went)
  const C = ETOUR.card, H0 = ETOUR.hole, V = etourView(), s = ETOUR.welcome ? null : (ETOUR_STEPS[ETOUR.ch] || []).find(x => x.id === ETOUR.id);
  if (ETOUR.wait) return; // (not shown yet: etourSoon)
  C.style.visibility = document.querySelector(".mdl") ? "hidden" : ""; // (a pop-up that opens anyway is on top; the card waits)
  const T = s ? etourTarget(s, V) : null;
  if (T) {
    const p = T.l <= V.l + 1 || T.t <= V.t + 1 || T.r >= V.r - 1 || T.b >= V.b - 1 ? 4 : 6;
    const l = Math.max(V.l, T.l - p), t = Math.max(V.t, T.t - p), r = Math.min(V.r, T.r + p), b = Math.min(V.b, T.b + p);
    Object.assign(H0.style, { left: l + "px", top: t + "px", width: r - l + "px", height: b - t + "px" }); H0.classList.remove("none");
  } else { Object.assign(H0.style, { left: V.l + V.w / 2 + "px", top: V.t + V.h / 2 + "px", width: "0px", height: "0px" }); H0.classList.add("none"); }
  C.style.width = Math.max(200, Math.min(320, V.R - V.L)) + "px"; C.style.maxHeight = Math.max(160, V.B - V.T) + "px";
  const W = C.offsetWidth, H = C.offsetHeight, G = 12, arrow = C.querySelector(".etour-arrow");
  let x, y, side = null;
  if (!T) { x = (V.L + V.R - W) / 2; y = (V.T + V.B - H) / 2; }
  else {
    const fits = { bottom: T.b + G + H <= V.B, top: T.t - G - H >= V.T, right: T.r + G + W <= V.R, left: T.l - G - W >= V.L };
    side = s.area === "field" && T.h > V.h * .7 ? null : etourSides(s, T, V).find(k => fits[k]) || null;
    if (side === "bottom" || side === "top") { x = T.cx - W / 2; y = side === "bottom" ? T.b + G : T.t - G - H; }
    else if (side) { y = T.cy - H / 2; x = side === "right" ? T.r + G : T.l - G - W; }
    else { x = T.cx - W / 2; y = s.area === "field" || T.cy < V.t + V.h / 2 ? T.b - G - H : T.t + G; } // inset: over the bottom of the field (the pill is at the top)
  }
  x = Math.max(V.L, Math.min(V.R - W, x)); y = Math.max(V.T, Math.min(V.B - H, y));
  C.style.left = Math.round(x) + "px"; C.style.top = Math.round(y) + "px";
  arrow.className = "etour-arrow" + (side ? " " + { bottom: "up", top: "down", right: "lt", left: "rt" }[side] : ""); arrow.hidden = !side;
  if (side === "bottom" || side === "top") { arrow.style.left = Math.max(14, Math.min(W - 14, T.cx - x)) - 5 + "px"; arrow.style.top = ""; }
  else if (side) { arrow.style.top = Math.max(14, Math.min(H - 14, T.cy - y)) - 5 + "px"; arrow.style.left = ""; }
  if (anim) { // (the card fades in and slides 6 px away from its target)
    const d = { bottom: [0, -6], top: [0, 6], right: [-6, 0], left: [6, 0] }[side] || [0, 6];
    C.style.setProperty("--ex", d[0] + "px"); C.style.setProperty("--ey", d[1] + "px");
    C.classList.remove("in"); void C.offsetWidth; C.classList.add("in");
  }
  if (ETOUR.root.classList.contains("init")) requestAnimationFrame(() => ETOUR.root && ETOUR.root.classList.remove("init")); // (the hole moves with a transition from the 2nd placement on)
}

// ---------- Settings → Editor: the switch and the replays (renderEdSettings passes its helpers) ----------
function edTourSettings(sub, card, sw) {
  const c = card(), row = h("div", "btnrow etour-setbtns"), b1 = h("button", "btn ghost sm", tr("Replay the tour")), b2 = h("button", "btn ghost sm", tr("Tour of the Advanced tools"));
  b1.type = b2.type = "button";
  b1.onclick = () => { closeSheet(); edTourStart("simple", { skipWelcome: true }); };
  b2.onclick = () => { closeSheet(); edTourStart("advanced"); };
  row.append(b1, b2); row.hidden = document.body.classList.contains("live-watch");
  c.append(sw("Show the tour", "A short guided tour the first time you open the editor on this device, and a look at the Advanced tools the first time you turn them on", () => S.edTour !== false, v => { S.edTour = v; save(); }), row);
  return [sub("Editor tour"), c];
}
