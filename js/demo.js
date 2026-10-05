"use strict";
// ============ the live tour on the invite page ============
// The invite page (gate.js) shows the real app in a frame (?demo=tour). This script opens the home page's map in the
// editor there and drives it with a pretend mouse: every click, drag and tap is a real event on the real UI, so what
// people see is exactly how the site works. The frame can't be clicked or focused, and nothing is saved in it
// (settings, drafts and mod notes stay untouched: core.js, drafts.js and tools.js check DEMO_TOUR).
// Both pages use TOUR_TEXT: the frame says which chapter is playing, the invite page shows its caption.
const TOUR_TEXT = [
  ["Laid out like osu!'s editor", "Compose, Timing, Hitsounds, Verify, Setup and Mod notes tabs on top, the timeline with beat snap and zoom, and your tools on both sides."],
  ["Play and zoom the timeline", "Play the map with its hitsounds and scrub along the timeline. Zoom in to see every beat and tick."],
  ["Select and see the spacing", "Click an object: the mapping guides show the distance, the spacing and the angle to the objects before it."],
  ["Drag with distance snap", "Drag objects around; distance snap and grid snap keep your spacing consistent."],
  ["Place circles", "With the Circle tool a preview shows where and when the circle lands before you click."],
  ["Draw sliders", "With the Slider tool, click the points of the path. The timeline shows where the slider will end while you draw."],
  ["Hitsounds on every object", "Whistle, finish and clap plus the sample set, for circles, slider ends and ticks."],
  ["Hitsound Studio", "Every hitsound in lanes under the timeline: drag across cells to paint sounds, or set the selected objects with the controls beside each lane."],
  ["Mod notes with timestamps", "Write a mod on the selected objects: the osu! timestamp is filled in for you, ready to copy to the discussion."],
  ["Verify before you submit", "Checks with a map of where every issue is, the song's spectrum, and a quick list beside the playfield: tap an issue to jump to it."],
  ["Timing and Setup", "Red and green lines with BPM and offset, then metadata, difficulty settings and combo colours."],
  ["Test it like in the game", "Switch to Preview to watch it with the skin, storyboard and hitsounds, as it will play."],
];
const TOUR = { run: 0, i: 0, on: false, cur: null, x: 640, y: 360, map: null, visible: true };
// ---------- the pretend mouse ----------
function tourCursor() {
  if (TOUR.cur) return TOUR.cur;
  const c = h("div", "tourcur"); c.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l15 11.5-6.6 1.2 3.9 7-2.8 1.5-3.9-7L4 21z"/></svg>';
  document.body.append(c); TOUR.cur = c; tourPlace(TOUR.x, TOUR.y); return c;
}
function tourPlace(x, y) { TOUR.x = x; TOUR.y = y; TOUR.cur.style.transform = `translate(${x}px,${y}px)`; }
function tourRipple() { const r = h("i", "tourrip"); r.style.left = TOUR.x + "px"; r.style.top = TOUR.y + "px"; document.body.append(r); setTimeout(() => r.remove(), 600); }
const tourStop = () => Object.assign(new Error("tour"), { tour: true });
function tWait(ms) { const run = TOUR.run; return new Promise((res, rej) => setTimeout(() => run === TOUR.run ? res() : rej(tourStop()), ms)); }
// glide to (x, y); over the playfield the editor gets pointer moves too (hover previews)
async function tGlide(x, y, ms = 650, buttons = 0) {
  const run = TOUR.run, x0 = TOUR.x, y0 = TOUR.y, t0 = performance.now();
  await new Promise((res, rej) => {
    const step = () => {
      if (run !== TOUR.run) return rej(tourStop());
      const k = Math.min(1, (performance.now() - t0) / ms), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      tourPlace(x0 + (x - x0) * e, y0 + (y - y0) * e);
      const el = document.elementFromPoint(TOUR.x, TOUR.y);
      if (el === cv) tPtr(cv, "pointermove", TOUR.x, TOUR.y, buttons);
      else if (buttons) window.dispatchEvent(new PointerEvent("pointermove", { clientX: TOUR.x, clientY: TOUR.y, pointerId: 1, pointerType: "mouse", buttons }));
      k < 1 ? setTimeout(step, 16) : res(); // (timers, not animation frames: those can be paused in a frame)
    };
    step();
  });
}
function tPtr(el, type, x, y, buttons) {
  el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: buttons ?? (type === "pointerup" ? 0 : 1) }));
}
const tEl = sel => typeof sel === "string" ? document.querySelector(sel) : sel;
async function tHover(sel, ms) {
  const el = tEl(sel); if (!el) return null;
  const r = el.getBoundingClientRect(); await tGlide(r.left + r.width / 2, r.top + r.height / 2, ms); return el;
}
async function tClick(sel, ms) { const el = await tHover(sel, ms); if (!el) return; tourRipple(); el.click(); await tWait(380); }
const pfClient = (x, y) => { const r = cv.getBoundingClientRect(), d = cv.dpr || 1; return [r.left + ((x + 64) * VIEW.vs + VIEW.ox) / d, r.top + ((y + 56) * VIEW.vs + VIEW.oy) / d]; };
async function tTap(x, y, ms) { const [cx, cy] = pfClient(x, y); await tGlide(cx, cy, ms); tourRipple(); tPtr(cv, "pointerdown", cx, cy); tPtr(cv, "pointerup", cx, cy); await tWait(350); }
async function tDragPF(x0, y0, x1, y1) {
  const [a, b] = pfClient(x0, y0), [c, d] = pfClient(x1, y1);
  await tGlide(a, b); tourRipple(); tPtr(cv, "pointerdown", a, b);
  await tGlide(c, d, 900, 1); tPtr(cv, "pointerup", c, d); await tWait(300);
}
async function tType(el, text) { el.focus && el.focus(); for (const ch of text) { el.value += ch; el.dispatchEvent(new Event("input", { bubbles: true })); await tWait(35); } }

// ---------- the map and a clean editor for every chapter ----------
async function tourOpen() {
  if (!TOUR.text) TOUR.text = await fetch(DEMO.url).then(r => r.text());
  const entries = { "demo.osu": blobEntry("demo.osu", new Blob([TOUR.text])) };
  await openEntries(entries, null, { name: "" }, "mod", { force: true });
  TOUR.map = map;
}
async function tourReset() {
  if (!map || TOUR.map !== map || TOUR.edits > 40) { TOUR.edits = 0; await tourOpen(); }
  if (!UI.sheet.hidden) closeSheet(); closeTools(); if (!$("qnote").hidden) closeQuick(); closeDlg && closeDlg();
  if (typeof ctxClose === "function") ctxClose();
  setMode(true); pausePlayback(); edTab("compose"); setTool("select"); EDIT.sel.clear(); EDIT.sliderPts = null; updateEdUI(); dirty = true;
}
const tourObj = (from, kind) => map.hit.find(o => o.t > from && (!kind || o.kind === kind)) || map.hit[Math.floor(map.hit.length / 3)];
// an empty stretch of time after the last object, on the beat
const tourFree = () => snapTime(map.hit[map.hit.length - 1].end + beatInfo(map.hit[map.hit.length - 1].end).len * 2);

const TOUR_RUN = [
  async () => { // the layout
    seekTo(tourObj(20000).t - 200);
    await tHover("#edTabs button[data-etab=compose]"); await tWait(250);
    for (const t of ["timing", "hitsounds", "verify", "setup", "notes"]) await tHover(`#edTabs button[data-etab=${t}]`, 280);
    await tHover("#edTl", 700); await tWait(300);
    await tHover("#snapSel"); await tWait(300);
    await tHover("#edLeft [data-tool=circle]"); await tHover("#edLeft [data-tool=slider]", 300);
    await tHover("#edNC"); await tHover("#edW", 300); await tHover("#edDS", 400); await tWait(500);
  },
  async () => { // play + zoom
    seekTo(tourObj(20000).t - 800);
    await tClick("#play"); await tWait(3200); await tClick("#play");
    await tClick("#tlIn"); await tWait(500); await tClick("#tlIn"); await tWait(900); await tClick("#tlOut"); await tClick("#tlOut", 300);
  },
  async () => { // select + guides
    if (!S.guides) { S.guides = true; updateEdUI(); }
    const o = tourObj(24000, "circle"); seekTo(o.t);
    await tWait(300); await tTap(o.x, o.y); await tWait(1600);
    const o2 = map.hit[map.hit.indexOf(o) + 1]; if (o2) { seekTo(o2.t); await tTap(o2.x, o2.y); await tWait(1600); }
  },
  async () => { // drag
    const o = tourObj(30000, "circle"); seekTo(o.t); await tWait(200);
    await tTap(o.x, o.y); await tWait(500);
    await tDragPF(o.x, o.y, Math.min(480, o.x + 70), Math.max(30, o.y - 40)); TOUR.edits++; await tWait(1200);
  },
  async () => { // circles
    const t = tourFree(); seekTo(t); await tWait(200);
    await tClick("#edLeft [data-tool=circle]");
    await tGlide(...pfClient(200, 180), 700); await tGlide(...pfClient(260, 200), 700); await tWait(400);
    await tTap(256, 192, 300); TOUR.edits++; await tWait(500);
    seekTo(snapTime(t + beatInfo(t).len)); await tWait(200);
    await tGlide(...pfClient(330, 160), 700); await tTap(356, 150, 300); TOUR.edits++; await tWait(1100);
  },
  async () => { // sliders
    const b = beatInfo(tourFree()).len, t = snapTime(tourFree() + b * 3); seekTo(t); await tWait(200);
    await tClick("#edLeft [data-tool=slider]");
    await tTap(150, 250); await tTap(240, 140, 500); await tTap(340, 230, 500); await tWait(700);
    await tClick("#edSliderDone"); TOUR.edits++; await tWait(1400);
  },
  async () => { // hitsounds on an object
    const o = tourObj(26000, "circle"); seekTo(o.t); await tWait(200); await tTap(o.x, o.y);
    await tClick("#edW"); await tWait(300); await tClick("#edF"); await tWait(300); await tClick("#edBankS"); await tWait(600);
    await tClick("#edBankN"); await tClick("#edF", 300); await tClick("#edW", 300); TOUR.edits += 4; await tWait(500);
  },
  async () => { // Hitsound Studio
    seekTo(tourObj(22000).t); await tClick("#edTabs button[data-etab=hitsounds]"); await tWait(900);
    const lane = () => [...document.querySelectorAll("#edPanel .hsscell")].filter(c => { const r = c.getBoundingClientRect(); return r.width && r.left > 60 && r.right < innerWidth - 60 && r.top > 0 && r.bottom < innerHeight; });
    const cells = lane(); if (!cells.length) { await tWait(1500); return; }
    const row = cells.filter(c => c.parentNode === cells[0].parentNode).slice(0, 4);
    const first = await tHover(row[0]); tourRipple(); tPtr(first, "pointerdown", TOUR.x, TOUR.y);
    for (const c of row.slice(1)) { const r = c.getBoundingClientRect(); await tGlide(r.left + r.width / 2, r.top + r.height / 2, 300, 1); }
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: TOUR.x, clientY: TOUR.y, pointerId: 1 })); TOUR.edits++; await tWait(900);
    // select one object by its marker, then set it with the controls beside the lanes (when they fit)
    const mk = [...document.querySelectorAll("#edPanel .hssmark:not(.tick)")].find(m => { const r = m.getBoundingClientRect(); return r.left > 120 && r.right < innerWidth - 200; });
    if (mk) { await tClick(mk); await tWait(400); const rc = document.querySelector("#hssRc [data-bit='8']"); if (rc && rc.offsetParent) { await tClick(rc); TOUR.edits++; await tWait(400); const s2 = document.querySelector("#hssRc [data-set='n2']"); if (s2) { await tClick(s2); TOUR.edits++; } } }
    await tWait(1200);
  },
  async () => { // mod note
    const o = tourObj(28000, "circle"); seekTo(o.t); await tWait(200); await tTap(o.x, o.y);
    await tClick("#edNote"); await tWait(300);
    await tHover("#qnText"); await tType($("qnText"), tr("the jump here is much bigger than the music suggests")); await tWait(900);
    await tHover("#qnote .qtype:nth-child(2)"); await tWait(700);
    await tClick("#qnote [data-i18n=Save]"); await tWait(900);
    await tClick("#edSideNotes"); await tWait(1800); await tClick("#edSideNotes", 400);
  },
  async () => { // Verify: the overview with its issue map, the checks, then the quick list on the playfield
    await tClick("#edTabs button[data-etab=verify]"); await tWait(800);
    if (typeof vfyGo === "function") { vfyGo("overview"); await tWait(300); }
    await tHover("#edPanel .vfymap", 900); await tWait(1200);
    await tClick("#edPanel .vfynav .vfyt:nth-child(2)"); await tWait(1400);
    await tClick("#edTabs button[data-etab=compose]"); await tWait(300);
    await tClick("#edSideVfy"); await tWait(700);
    const row = document.querySelector("#edSide .sidepanel .siderow .sidego"); if (row) { await tClick(row); await tWait(1400); }
    await tClick("#edSideVfy", 400);
  },
  async () => {
    await tClick("#edTabs button[data-etab=timing]"); await tWait(1500); await tHover("#edPanel .wrap", 700);
    await tClick("#edTabs button[data-etab=setup]"); await tWait(1400); await tGlide(TOUR.x, TOUR.y + 120, 800); await tWait(1000);
  },
  async () => { // preview
    seekTo(tourObj(20000).t - 1500); await tClick("#modePrev"); await tWait(300);
    await tClick("#play"); await tWait(4500); pausePlayback();
  },
];
async function tourLoop(from = 0) {
  const run = ++TOUR.run; TOUR.i = from;
  tourCursor();
  while (run === TOUR.run) {
    if (!TOUR.visible) { await new Promise(r => setTimeout(r, 400)); continue; }
    const i = TOUR.i;
    parent.postMessage({ obv: "tour", i }, location.origin);
    try { await tourReset(); await TOUR_RUN[i](); await tWait(500); }
    catch (e) { if (e.tour) return; console.warn("tour", i, e); }
    if (run !== TOUR.run) return;
    TOUR.i = (i + 1) % TOUR_RUN.length;
  }
}
function tourStart() {
  document.documentElement.classList.add("demotour");
  cv.setPointerCapture = cv.releasePointerCapture = () => {}; // the pretend mouse has no real pointer to capture
  S.masterVol = 0; S.guides = true; S.snap = S.snap || 4; S.fps = 30; S.quality = "low"; resize(); // light on the page (not saved: see DEMO_TOUR)
  addEventListener("message", e => {
    if (e.origin !== location.origin || !e.data || e.data.obv !== "tour") return;
    if (e.data.cmd === "goto") tourLoop(Math.max(0, Math.min(TOUR_RUN.length - 1, e.data.i | 0)));
    if (e.data.cmd === "visible") TOUR.visible = !!e.data.on;
    if (e.data.cmd === "lang" && e.data.lang !== LANG) setLang(e.data.lang);
  });
  tourLoop(0);
}

// ---------- the playable demo editor (?demo=try, full screen on the invite page) ----------
// The same editor on the same map, for people to try themselves. Nothing is saved (see DEMO_TOUR), there is nothing
// online to reach (the server needs access for that), and other maps can't be opened here: the back button closes it.
async function tryStart() {
  document.documentElement.classList.add("demotry");
  for (const t of ["dragenter", "dragover", "drop"]) addEventListener(t, e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  $("back").onclick = () => parent.postMessage({ obv: "try", close: true }, location.origin);
  addEventListener("message", async e => { // "Start over" lives in the invite page's bar above the frame
    if (e.origin !== location.origin || !e.data || e.data.obv !== "try" || !e.data.reset) return;
    if (!(await ask(tr("Start over with the original map?"), { ok: tr("Start over"), danger: true }))) return;
    await tourOpen(); setMode(true); toast(tr("Back to the original map"), 1500);
  });
  await tourOpen();
  setMode(true);
  parent.postMessage({ obv: "try", ready: true }, location.origin);
}
