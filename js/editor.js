"use strict";
// ============ modding mode (editor), laid out like the osu! editor ============
// Edits work on map.lines (the raw [HitObjects] lines) and then rebuild everything derived from them,
// so preview, hitsounds, checks and export always agree with what is on screen.
// Slider length snapping and distance snap follow osu!stable / osucad (MIT, github.com/minetoblend/osucad).
const EDIT = { on: false, tab: "compose", tool: "select", sel: new Set(), drag: false, dx: 0, dy: 0, undo: [], redo: [], changed: false,
  sliderPts: null, hoverPt: null, box: null, tlScale: Math.max(.03, Math.min(2, +S.tlZoom || .25)), tlScaleV: 0, tlDt: 0, tlDrag: false, clip: null, dlg: null, ghost: null };
EDIT.tlScaleV = EDIT.tlScale;
const GRIDS = [0, 4, 8, 16, 32];
const DS_STEPS = [.5, .6, .7, .8, .9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2, 2.5, 3];
for (const d of DIVS) $("snapSel").add(new Option("1/" + d, d));
$("snapSel").value = S.snap;
$("snapSel").onchange = e => { S.snap = +e.target.value; save(); dirty = true; };

const ED_ONLY = ["edTabs", "edTest", "edAuto", "edTop", "edLeft", "edRight", "edInfo", "rateSel", "edRowBtn"], PREVIEW_ONLY = ["modeSw", "toolsBtn", "playBtn"];
function setMode(on, force) {
  if (on === EDIT.on) return;
  const watching = typeof LIVE !== "undefined" && LIVE.watch && (LIVE.on || LIVE.opening); // a guest watching a live session: Compose only
  if (on && !can("editor") && !watching) return; // the editor is off for this visitor (Admin → Permissions)
  if (!on && watching && !force) return;
  EDIT.on = on;
  if (map && map.mode !== 3 && S.edStack === false) rebuildHits(map); // (stacking is only turned off in the editor)
  for (const [id, v] of [["modePrev", !on], ["modeEdit", on]]) { $(id).classList.toggle("on", v); $(id).setAttribute("aria-pressed", v); }
  UI.player.classList.toggle("editing", on);
  // (an element can be missing when an older copy of the page runs newer scripts, e.g. a saved home-screen app)
  ED_ONLY.forEach(id => { const e = $(id); if (e) e.hidden = !on; }); PREVIEW_ONLY.forEach(id => { const e = $(id); if (e) e.hidden = on; });
  if (typeof tpApply === "function") tpApply(); // (the test play buttons only show with Settings → Test play on)
  UI.spd.hidden = on || A.rate === 1;
  if (on) {
    pausePlayback(); closeTools(); UI.tapStart.hidden = true; needTapResume = false; if (!UI.player.hidden) startAt = 0; cardStart = -1e9; ensureAudioCtx(); // (a link's ?t= still applies while the map opens)
    edTab("compose");
    if (!setMode.hinted) { setMode.hinted = true; toast(tr("Modding: tap an object to select it and see its timing • drag to move • drag the timeline to scrub"), 4500); }
  } else { EDIT.sliderPts = null; EDIT.box = null; $("edPanel").hidden = true; closeDlg(); if (typeof sideRender === "function") sideRender(); }
  setModeParam(on);
  if (!UI.sheet.hidden) { buildSetTabs(); showSetTab(on ? S.setTabEd || "editor" : S.setTab || "audio"); }
  showUI(); measureIns(); updateEdUI(); dirty = true;
  requestAnimationFrame(() => { measureIns(); drawTimeline(); dirty = true; });
}
$("modePrev").onclick = () => setMode(false);
$("modeEdit").onclick = () => setMode(true);
$("edTest").onclick = () => playStart(); // play it yourself (play.js)
$("edAuto").onclick = () => setMode(false); // watch it on Auto (the preview)
function edTab(tab) {
  if (typeof hssPopClose === "function") hssPopClose(); // (Hitsound Studio's drop-down)
  if (tab !== "compose" && typeof LIVE !== "undefined" && LIVE.on && LIVE.watch) return; // watchers see Compose only
  if (tab === "verify" && EDIT.tab !== "verify" && typeof VFY_RUN !== "undefined") VFY_RUN.hold = false; // (opening Verify checks again)
  EDIT.tab = tab;
  $("edTabs").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.etab === tab));
  const p = $("edPanel");
  if (typeof sideRender === "function") sideRender(); // the notes / annotations lists belong to Compose
  if (tab === "compose") { p.hidden = true; dirty = true; return; }
  pausePlayback();
  p.hidden = false; p.innerHTML = "";
  const wrap = h("div", "wrap"); p.append(wrap);
  renderPanel(tab, wrap);
  p.scrollTop = 0;
}
$("edTabs").querySelectorAll("button").forEach(b => b.onclick = () => edTab(b.dataset.etab));
$("edPanel").addEventListener("click", panelClick);
$("edTime").onclick = async () => { const s = tsAt(A.cur()); toast(await copyText(s) ? tr("Copied {s}", { s }) : s); };
function edReset() { EDIT.sel.clear(); EDIT.undo = []; EDIT.redo = []; EDIT.changed = false; EDIT.sliderPts = null; EDIT.drag = false; EDIT.box = null; wave = null; updateEdUI(); }
const anyEdits = () => EDIT.changed || osuFiles.some(o => o.edited || o.created);
async function edConfirmDiscard() {
  if (!anyEdits() && !annHasLocal()) return true;
  if (draftAvailable()) { draftFlush(); return (await ask(tr("Your unsaved edits stay on this device as a draft: open this map again to restore them. Leave this map?"), { ok: tr("Leave") })); }
  return (await ask(tr("You have edits that aren't exported. Discard them?"), { ok: tr("Discard"), danger: true }));
}
addEventListener("beforeunload", e => { if (!DEMO_TOUR && anyEdits() && !(LIVE.on && !LIVE.host)) { e.preventDefault(); e.returnValue = ""; } });

// ---------- geometry ----------
function toOsu(e) {
  const r = cv.getBoundingClientRect(), d = cv.dpr || 1;
  return [((e.clientX - r.left) * d - VIEW.ox) / VIEW.vs - 64, ((e.clientY - r.top) * d - VIEW.oy) / VIEW.vs - 56];
}
function segDist(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
  const k = l2 ? clamp01(((px - a[0]) * vx + (py - a[1]) * vy) / l2) : 0;
  return Math.hypot(px - a[0] - vx * k, py - a[1] - vy * k);
}
function visibleRange(t) {
  const H = map.hit, hi = lastBefore(H, t + map.preempt, "t");
  let lo = hi; while (lo > 0 && H[lo - 1].t > t - 30000) lo--;
  return [Math.max(0, lo), hi];
}
function hitTest(x, y, t) {
  const H = map.hit, r = map.radius * 1.05, [lo, hi] = visibleRange(t);
  let spin = null;
  for (let i = lo; i <= hi; i++) { // earlier objects are drawn on top, so test them first
    const o = H[i]; if (o.end + (S.edHitMarkers !== false ? 700 : 240) < t) continue;
    if (o.kind === "spinner") { if (!spin && Math.hypot(x - 256, y - 192) < 190) spin = o; continue; }
    if (Math.hypot(x - o.x, y - o.y) <= r) return o;
    if (o.path) { const J = o.path.jumps; for (let j = 1; j < o.path.length; j++) if (!(J && J.has(j)) && segDist(x, y, o.path[j - 1], o.path[j]) <= r * .9) return o; } // (a jump isn't body: parse.js farPath)
  }
  return spin;
}
const gridSnap = v => S.grid ? Math.round(v / S.grid) * S.grid : Math.round(v);
const clampPF = (x, y) => [Math.max(0, Math.min(512, x)), Math.max(0, Math.min(384, y))];
const selObjs = () => map ? map.hit.filter(o => EDIT.sel.has(o.lid)) : [];
function edSelectIds(ids) { EDIT.sel = new Set(ids); updateEdUI(); dirty = true; if (EDIT.tab === "hitsounds" && typeof hssDockSync === "function") hssDockSync(); }

// ---------- distance snap ----------
function prevObjBefore(t, exclude) { // the last object that ends before time t
  const H = map.hit; for (let i = lastBefore(H, t - 1, "t"); i >= 0; i--) { const o = H[i]; if (o.lid !== exclude && o.end <= t && o.kind !== "spinner") return o; if (o.kind === "spinner" && o.end <= t) return null; }
  return null;
}
function dsDist(prev, t) { // expected distance to an object at time t: beats * SV * multiplier * DS
  const b = beatInfo(t).len, px = +(map.diff.SliderMultiplier || 1.4) * 100 * svAt(map, t);
  return (t - prev.end) / b * px * S.dsMul;
}
function dsSnap(x, y, t, exclude) {
  if (!S.ds) return [x, y];
  const p = prevObjBefore(t, exclude); if (!p) return [x, y];
  const pe = endPos(p), d = dsDist(p, t), vx = x - pe[0], vy = y - pe[1], l = Math.hypot(vx, vy) || 1;
  return [pe[0] + vx / l * d, pe[1] + vy / l * d];
}

// ---------- commits / undo ----------
// a full copy of everything the editor can change: objects, bookmarks, timing points, setup (general/metadata/difficulty)
const snapshot = () => ({ lines: map.lines.map(L => ({ s: L.s, id: L.id })), bm: map.bookmarks.slice(), timing: map.timing.map(tp => ({ ...tp })), br: map.breaks.map(b => b.slice()),
  kv: { g: { ...map.general }, m: { ...map.meta }, d: { ...map.diff }, c: { ...map.colourKV } } });
function restoreSnap(st) {
  map.lines = st.lines.map(L => ({ ...L })); map.bookmarks = st.bm.slice(); map.timing = st.timing.map(tp => ({ ...tp })); if (st.br) map.breaks = st.br.map(b => b.slice());
  map.general = { ...st.kv.g }; map.meta = { ...st.kv.m }; map.diff = { ...st.kv.d }; map.colourKV = { ...(st.kv.c || {}) };
}
const lineTime = L => +L.s.split(",")[2];
// new objects get a random id: unique across people and sessions (ids stay with the map in drafts, cloud saves and
// collab, so annotations keep pointing at the right object)
const newLineId = () => 2 ** 40 + Math.floor(Math.random() * (2 ** 52 - 2 ** 40));
function edCommit(label, mutate, opts = {}) {
  if (!liveCanEdit()) { liveNoEdit(); dirty = true; return false; }
  if (!collabCanEdit()) { collabNoEdit(); dirty = true; return false; }
  const before = snapshot();
  EDIT.undo.push({ snap: before, label }); if (EDIT.undo.length > 200) EDIT.undo.shift();
  EDIT.redo = [];
  mutate();
  rebuildEdit(opts.keepPanel);
  if (LIVE.on) liveSendPatch(before, label);
  if (COLLAB.on) collabLocalCommit(before, label);
  return true;
}
function rebuildEdit(keepPanel) {
  map.lines.sort((a, b) => lineTime(a) - lineTime(b));
  timingDerived(map); diffDerived(map); coloursDerived(map);
  rebuildHits(map);
  const ids = new Set(map.lines.map(L => L.id));
  for (const id of [...EDIT.sel]) if (!ids.has(id)) EDIT.sel.delete(id);
  if (!LIVE.on || LIVE.host) EDIT.changed = true;
  dirty = true;
  drawTimeline(); updateEdUI();
  annAfterRebuild(); draftSchedule(); cloudTouch();
  if (!keepPanel && (EDIT.tab === "setup" || EDIT.tab === "timing")) edTab(EDIT.tab);
  vfyEdited(); // (Verify: now, once editing pauses, or on ↻)
  if (EDIT.tab === "hitsounds") hsStudioRefresh();
  if (typeof sideOpen === "function" && sideOpen()) sideRender();
}
function undoRedo(fromUndo) {
  if (COLLAB.on) return collabUndoRedo(fromUndo); // only your own changes, never someone else's
  if (!liveCanEdit()) return liveNoEdit();
  const a = fromUndo ? EDIT.undo : EDIT.redo, b = fromUndo ? EDIT.redo : EDIT.undo;
  const st = a.pop(); if (!st) { toast(tr(fromUndo ? "Nothing to undo" : "Nothing to redo"), 1200); return; }
  const before = snapshot();
  b.push({ snap: before, label: st.label });
  restoreSnap(st.snap); rebuildEdit();
  if (LIVE.on) liveSendPatch(before, st.label);
  toast(tr(fromUndo ? "Undo: {what}" : "Redo: {what}", { what: tr(st.label) }), 1200);
}
const lineById = id => map.lines.find(L => L.id === id);
function editLines(fn) { for (const id of EDIT.sel) { const L = lineById(id); if (L) { const p = L.s.split(","); fn(p, +p[3]); L.s = p.join(","); } } }

const holdShift = (f, dt) => { const q = String(f || "").split(":"); q[0] = Math.round(+q[0] + dt); return q.join(":"); }; // mania hold note end
function moveSel(dx, dy) {
  if (!dx && !dy) return;
  edCommit("Move objects", () => editLines((p, type) => {
    if (type & 8) return; // spinners are always centred
    p[0] = Math.round(+p[0] + dx); p[1] = Math.round(+p[1] + dy);
    if (type & 2 && p[5]) {
      const parts = p[5].split("|");
      p[5] = [parts[0], ...parts.slice(1).map(q => { const [x, y] = q.split(":").map(Number); return Math.round(x + dx) + ":" + Math.round(y + dy); })].join("|");
    }
  }));
}
function shiftSel(dt) {
  if (!dt) return;
  edCommit("Move objects in time", () => editLines((p, type) => { p[2] = Math.round(+p[2] + dt); if (type & 8) p[5] = Math.round(+p[5] + dt); if (type & 128) p[5] = holdShift(p[5], dt); }));
}
function toggleNC() {
  const objs = selObjs().filter(o => o.kind !== "spinner"); if (!objs.length) return;
  const on = !objs.every(o => o.type & 4);
  edCommit(on ? "New combo on" : "New combo off", () => editLines((p, type) => { if (type & 8) return; p[3] = on ? type | 4 : type & ~4 & ~0x70; }));
}
// ---------- hitsounds ----------
// What the hitsound controls act on: the selected objects, or one part of a selected slider (head / repeat / tail),
// or, with nothing selected, the hitsounds that newly placed objects get (like osu!'s placement toggles).
EDIT.edge = null; EDIT.edgeFor = null; EDIT.place = { hs: 0, n: 0, a: 0 };
const HS_NAME = { 2: "Whistle", 4: "Finish", 8: "Clap" };
const edgeCount = o => o.kind === "slider" ? o.slides + 1 : 0;
function hsUnits() {
  const objs = selObjs();
  if (EDIT.edge != null && objs.length === 1 && objs[0].lid === EDIT.edgeFor && objs[0].kind === "slider" && EDIT.edge <= objs[0].slides) return [{ o: objs[0], k: EDIT.edge }];
  return objs.map(o => ({ o, k: null }));
}
const edgeHs = (o, k) => isFinite(o.edgeSounds[k]) ? o.edgeSounds[k] : o.hs;
function unitHs(u) { // whole slider = the sounds every edge has
  const o = u.o; if (u.k != null) return edgeHs(o, u.k);
  if (o.kind === "slider") { let v = 14; for (let k = 0; k < edgeCount(o); k++) v &= edgeHs(o, k); return v; }
  return o.hs;
}
function unitBank(u, which) { // which: 0 = sample set, 1 = addition bank (0 = auto)
  const s = u.o.samp || { n: 0, a: 0 }, base = which ? s.a : s.n;
  if (u.k == null) return base;
  const e = u.o.edgeSets[u.k] || []; return e[which] || base;
}
function ensureSliderFields(p) { // edgeSounds / edgeSets / hitSample present, one entry per edge
  const edges = (+p[6] || 1) + 1, pad = (str, def) => { const a = str ? str.split("|") : []; while (a.length < edges) a.push(def); return a.slice(0, edges).join("|"); };
  while (p.length < 11) p.push("");
  p[8] = pad(p[8], String(+p[4] || 0)); p[9] = pad(p[9], "0:0"); if (!p[10]) p[10] = "0:0:0:0:";
}
function sampField(p, type) {
  const i = type & 2 ? 10 : type & 8 ? 6 : 5;
  if (type & 2) ensureSliderFields(p);
  while (p.length <= i) p.push("");
  if (type & 128) { // osu!mania hold note: "end:normal:addition:index:volume:file", the end time stays in front
    const all = (p[i] || "0").split(":"), end = all.shift(), q = all.length ? all : ["0", "0", "0", "0", ""]; while (q.length < 5) q.push(q.length === 4 ? "" : "0");
    const j = q.join.bind(q); q.join = sep => end + sep + j(sep); return { i, q };
  }
  const q = (p[i] || "0:0:0:0:").split(":"); while (q.length < 5) q.push(q.length === 4 ? "" : "0");
  return { i, q };
}
function editUnits(label, units, fn) { // fn(p, type, k) on each unit's line, as one undo step
  if (!units.length) return false;
  return edCommit(label, () => { for (const u of units) { const L = lineById(u.o.lid); if (!L) continue; const p = L.s.split(","); fn(p, +p[3], u.k); L.s = p.join(","); } });
}
function setEdgeBits(p, k, fn) { ensureSliderFields(p); const a = p[8].split("|"); a[k] = String(fn(+a[k] || 0)); p[8] = a.join("|"); }
function setEdgeBank(p, k, which, val) { ensureSliderFields(p); const a = p[9].split("|"), s = (a[k] || "0:0").split(":"); while (s.length < 2) s.push("0"); s[which] = String(val); a[k] = s.slice(0, 2).join(":"); p[9] = a.join("|"); }
function toggleHS(bit) {
  if (!EDIT.sel.size) { // nothing selected: sounds for the next objects you place
    EDIT.place.hs ^= bit; updateEdUI(); previewPlace();
    toast(tr(EDIT.place.hs & bit ? "New objects: {s} on" : "New objects: {s} off", { s: tr(HS_NAME[bit]) }), 1200); return;
  }
  const units = hsUnits(), on = !units.every(u => unitHs(u) & bit);
  editUnits(HS_NAME[bit], units, (p, type, k) => {
    const set = v => on ? v | bit : v & ~bit;
    if (k != null) return setEdgeBits(p, k, set);
    p[4] = set(+p[4] || 0);
    if (type & 2) { ensureSliderFields(p); p[8] = p[8].split("|").map(v => set(+v || 0)).join("|"); }
  });
  previewSel();
}
function setBankOf(which, val) { // sample set (which 0) or addition bank (which 1): 0 auto, 1 normal, 2 soft, 3 drum
  const key = which ? "a" : "n";
  if (!EDIT.sel.size) { EDIT.place[key] = EDIT.place[key] === val ? 0 : val; updateEdUI(); previewPlace(); return; }
  const units = hsUnits(); if (val && units.every(u => unitBank(u, which) === val)) val = 0; // pressing the active one again = auto
  editUnits(which ? "Addition bank" : "Sample set", units, (p, type, k) => {
    if (k != null) return setEdgeBank(p, k, which, val);
    const f = sampField(p, type); f.q[which] = String(val); p[f.i] = f.q.join(":");
    if (type & 2) p[9] = p[9].split("|").map(e => { const s = e.split(":"); while (s.length < 2) s.push("0"); s[which] = "0"; return s.slice(0, 2).join(":"); }).join("|");
  });
  previewSel();
}
const setBank = n => setBankOf(0, n);
function setSampleProp(idx, val, label) { // custom sample index (2) or volume (3) of the selected objects
  const objs = selObjs(); if (!objs.length) return;
  edCommit(label, () => editLines((p, type) => { const f = sampField(p, type); f.q[idx] = String(Math.max(0, Math.round(val))); p[f.i] = f.q.join(":"); }));
  previewSel();
}
function unitTime(u) { return u.k != null ? u.o.t + u.o.span * u.k : u.o.kind === "spinner" ? u.o.end : u.o.t; }
function previewSel() {
  const u = hsUnits()[0]; if (!u || isPlaying()) return;
  const t = unitTime(u), e = map.sounds.find(s => !s.tick && Math.abs(s.t - t) < 1.5); if (e) playEvent(e, 0);
}
function previewPlace() { if (!isPlaying()) playEvent({ t: A.cur(), hs: EDIT.place.hs, n: EDIT.place.n, a: EDIT.place.a, i: 0, v: 0, f: "" }, 0); }
const placeHS = () => ({ hs: EDIT.place.hs, s: `${EDIT.place.n}:${EDIT.place.a}:0:0:` });
function pickEdge(o, k) { EDIT.edgeFor = o.lid; EDIT.edge = k; updateEdUI(); dirty = true; if (k != null) { seekTo(Math.round(o.t + o.span * k)); previewSel(); } }
// every hitsound-able point in a range: circles, slider edges, spinner ends -> { o, k, t }
function hsPoints(range) {
  const out = [], objs = range === "sel" ? selObjs() : map.hit;
  for (const o of objs) {
    if (o.kind === "slider") for (let k = 0; k <= o.slides; k++) out.push({ o, k, t: o.t + o.span * k });
    else out.push({ o, k: null, t: o.kind === "spinner" ? o.end : o.t });
  }
  return out;
}
function applyPoints(label, pts, fn) { // fn(p, type, k, pt) grouped per line
  const by = new Map(); for (const q of pts) { if (!by.has(q.o.lid)) by.set(q.o.lid, []); by.get(q.o.lid).push(q); }
  return edCommit(label, () => { for (const [lid, qs] of by) { const L = lineById(lid); if (!L) continue; const p = L.s.split(","); for (const q of qs) fn(p, +p[3], q.k, q); L.s = p.join(","); } });
}
// "hitsound by beat": put a sound on chosen positions of every bar (in half beats), e.g. clap on 2 and 4
function hsPattern(opt) {
  const pts = hsPoints(opt.range), bit = opt.bit; let n = 0;
  const hit = q => {
    const b = beatInfo(q.t), m = b.meter || 4, x = (q.t - b.off) / b.len * 2, h = Math.round(x);
    if (Math.abs(x - h) > .08) return false; // between half beats (1/4, 1/3…): never gets it, loses it with "remove"
    return !!opt.cells[((h % (m * 2)) + m * 2) % (m * 2)];
  };
  const target = pts.filter(q => hit(q) || opt.replace);
  if (!target.length) return toast(tr("No objects on those beats"));
  applyPoints("Hitsound by beat", target, (p, type, k, q) => {
    const on = hit(q) === true; if (on) n++;
    const set = v => on ? v | bit : v & ~bit;
    if (k != null) setEdgeBits(p, k, set); else p[4] = set(+p[4] || 0);
  });
  toast(tr("{s} on {n} notes", { s: tr(HS_NAME[bit]), n }), 1800);
}
// copy hitsounds (sounds + sample sets) from another difficulty, matching times within 5 ms
function hsCopyFrom(idx, opt) {
  const src = allMaps().find(x => x.i === idx); if (!src) return;
  const ev = src.m.sounds.filter(e => !e.tick), find = t => { const i = lastBefore(ev, t + 5, "t"); const e = ev[i]; return e && Math.abs(e.t - t) <= 5 ? e : null; };
  const pts = hsPoints(opt.range).filter(q => find(q.t)); let n = 0;
  if (!pts.length) return toast(tr("No objects at the same times in that difficulty"));
  applyPoints("Copy hitsounds", pts, (p, type, k, q) => {
    const e = find(q.t); n++;
    if (k != null) { setEdgeBits(p, k, () => e.hs); if (opt.sets) { setEdgeBank(p, k, 0, e.n || 0); setEdgeBank(p, k, 1, e.a || 0); } }
    else { p[4] = e.hs; if (opt.sets) { const f = sampField(p, type); f.q[0] = String(e.n || 0); f.q[1] = String(e.a || 0); p[f.i] = f.q.join(":"); } }
  });
  toast(tr("Copied hitsounds to {n} points from [{d}]", { n, d: src.m.meta.Version }), 2200);
}
function hsClear(range) {
  const pts = hsPoints(range); if (!pts.length) return;
  applyPoints("Clear hitsounds", pts, (p, type, k) => {
    if (k != null) { setEdgeBits(p, k, () => 0); setEdgeBank(p, k, 0, 0); setEdgeBank(p, k, 1, 0); }
    else { p[4] = 0; const f = sampField(p, type); f.q[0] = f.q[1] = "0"; p[f.i] = f.q.join(":"); }
  });
}
// ---------- hitsound dialog ----------
const HS_PRESETS = [["Clap on 2 and 4", 8, m => Array.from({ length: m * 2 }, (_, i) => i === 2 || i === 6)],
  ["Finish on the first beat of each bar", 4, m => Array.from({ length: m * 2 }, (_, i) => i === 0)],
  ["Whistle on the off-beats", 2, m => Array.from({ length: m * 2 }, (_, i) => i % 2 === 1)]];
const HSD = { bit: 8, cells: null, replace: false, range: "sel", src: -1, sets: true };
function hitsoundDialog(body, studio) { // studio: the Hitsound Studio toolbar already has the sounds / sets / volume / index of the selection
  const units = hsUnits(), sel = EDIT.sel.size, one = selObjs().length === 1 ? selObjs()[0] : null;
  const who = !sel ? tr("Nothing selected: these are the hitsounds new objects get")
    : units.length === 1 && units[0].k != null ? tr("Editing: slider {part} at {t}", { part: edgeName(units[0].o, units[0].k), t: fmtMs(unitTime(units[0])) })
    : tr("Editing: {n} objects", { n: units.length });
  body.append(h("p", "hint hswho", who));
  if (one && one.kind === "slider") body.append(edgeChips(one));
  const state = (fn) => { if (!sel) return fn(null) ? 2 : 0; const n = units.filter(fn).length; return n === units.length ? 2 : n ? 1 : 0; };
  const cls = s => s === 2 ? "on" : s === 1 ? "mixed" : "";
  const basic = !(studio && sel), row1 = h("div", "hsrow");
  if (basic) for (const bit of [2, 4, 8]) {
    const b = h("button", "hsbtn " + cls(state(u => (u ? unitHs(u) : EDIT.place.hs) & bit)), tr(HS_NAME[bit]));
    b.onclick = () => toggleHS(bit); row1.append(b);
  }
  if (basic) body.append(row1);
  if (basic) for (const [which, label] of [[0, "Sample set"], [1, "Addition bank"]]) {
    const r = h("div", "dlrow chk"), seg = h("div", "seg");
    for (const [v, l] of SAMPLE_SETS) { const b = h("button", cls(state(u => (u ? unitBank(u, which) : EDIT.place[which ? "a" : "n"]) === v)), tr(l)); b.onclick = () => setBankOf(which, v || (sel ? 0 : EDIT.place[which ? "a" : "n"])); seg.append(b); }
    r.append(h("span", null, tr(label)), seg); body.append(r);
  }
  if (sel && basic) {
    const objs = selObjs(), same = f => objs.every(o => f(o) === f(objs[0])) ? f(objs[0]) : "";
    const ix = h("input"); ix.type = "number"; ix.min = 0; ix.max = 999; ix.placeholder = tr("mixed"); ix.value = same(o => (o.samp || {}).i || 0);
    ix.onchange = () => setSampleProp(2, +ix.value || 0, "Sample index");
    const vr = h("input"), vo = h("output"); vr.type = "range"; vr.min = 0; vr.max = 100; vr.step = 5; const v0 = same(o => (o.samp || {}).v || 0); vr.value = v0 === "" ? 0 : v0;
    const vt = () => vo.textContent = +vr.value ? vr.value + "%" : tr("Auto"); vt();
    vr.oninput = vt; vr.onchange = () => setSampleProp(3, +vr.value, "Hitsound volume");
    const r1 = h("label", "dlrow"); r1.append(h("span", null, tr("Custom sample index")), ix, h("small", "cinfo", tr("0 = timing point")));
    const r2 = h("label", "dlrow"); r2.append(h("span", null, tr("Volume")), vr, vo);
    body.append(r1, r2);
  }
  // hitsound by beat
  const meter = beatInfo(A.cur()).meter || 4;
  if (!HSD.cells || HSD.cells.length !== meter * 2) HSD.cells = Array.from({ length: meter * 2 }, (_, i) => i === 2 || i === 6);
  const pat = h("details", "hsbox"); pat.open = !!HSD.open; pat.ontoggle = () => HSD.open = pat.open;
  pat.append(h("summary", "mlink", tr("Hitsound by beat")));
  const snd = h("div", "seg");
  for (const bit of [2, 4, 8]) { const b = h("button", HSD.bit === bit ? "on" : "", tr(HS_NAME[bit])); b.onclick = () => { HSD.bit = bit; renderHsDlg(); }; snd.append(b); }
  const grid = h("div", "hsgrid");
  HSD.cells.forEach((on, i) => { const b = h("button", on ? "on" : "", i % 2 ? "+" : String(i / 2 + 1)); b.title = i % 2 ? tr("off-beat after {b}", { b: (i - 1) / 2 + 1 }) : tr("beat {b}", { b: i / 2 + 1 }); b.onclick = () => { HSD.cells[i] = !HSD.cells[i]; renderHsDlg(); }; grid.append(b); });
  const pre = h("div", "btnrow");
  for (const [l, bit, f] of HS_PRESETS) { const b = h("button", "btn ghost sm", tr(l)); b.onclick = () => { HSD.bit = bit; HSD.cells = f(meter); renderHsDlg(); }; pre.append(b); }
  const opts = h("div", "hsopts"), rng = h("select"), rep = h("label", "hschk"), repI = h("input");
  rng.add(new Option(tr("Selected objects"), "sel")); rng.add(new Option(tr("Whole difficulty"), "all")); HSD.range = sel ? HSD.range : "all"; rng.value = HSD.range; rng.onchange = () => HSD.range = rng.value;
  repI.type = "checkbox"; repI.checked = HSD.replace; repI.onchange = () => HSD.replace = repI.checked; rep.append(repI, tr("Remove it from the other beats"));
  opts.append(rng, rep);
  const go = h("button", "btn main sm", tr("Apply")); go.onclick = () => hsPattern({ bit: HSD.bit, cells: HSD.cells, replace: HSD.replace, range: HSD.range });
  pat.append(h("p", "hint", tr("Pick a sound and the beats of each bar ({m}/4, + = half beat) where it should play.", { m: meter })), snd, grid, pre, opts, go);
  body.append(pat);
  // copy from another difficulty
  const others = osuFiles.map((f, i) => [i, f.meta.version]).filter(x => x[0] !== curDiff);
  if (others.length) {
    const cp = h("details", "hsbox"); cp.open = !!HSD.openCp; cp.ontoggle = () => HSD.openCp = cp.open;
    cp.append(h("summary", "mlink", tr("Copy hitsounds from another difficulty")));
    const s1 = h("select"); for (const [i, v] of others) s1.add(new Option(v, i)); if (HSD.src < 0 || HSD.src === curDiff) HSD.src = others[0][0]; s1.value = HSD.src; s1.onchange = () => HSD.src = +s1.value;
    const ck = h("label", "hschk"), ci = h("input"); ci.type = "checkbox"; ci.checked = HSD.sets; ci.onchange = () => HSD.sets = ci.checked; ck.append(ci, tr("Sample sets too"));
    const rg = h("select"); rg.add(new Option(tr("Selected objects"), "sel")); rg.add(new Option(tr("Whole difficulty"), "all")); rg.value = sel ? "sel" : "all";
    const b = h("button", "btn main sm", tr("Copy")); b.onclick = () => hsCopyFrom(HSD.src, { sets: HSD.sets, range: rg.value });
    const o2 = h("div", "hsopts"); o2.append(s1, rg, ck);
    cp.append(h("p", "hint", tr("Notes at the same time (±5 ms) get that difficulty's hitsounds, like a hitsound copier.")), o2, b);
    body.append(cp);
  }
  const clr = h("button", "btn ghost sm", tr(sel ? "Clear hitsounds of the selection" : "Clear all hitsounds"));
  clr.onclick = async () => { if (sel || (await ask(tr("Remove every hitsound in this difficulty?"), { ok: tr("Remove"), danger: true }))) hsClear(sel ? "sel" : "all"); };
  body.append(clr);
  body.append(h("p", "hint", tr("Shortcuts: W E R sounds • Shift+Q/W/E/R sample set Auto/Normal/Soft/Drum • Alt+Q/W/E/R addition bank")));
}
function renderHsDlg() {
  if (EDIT.tab === "hitsounds" && $("hssLanes")) return hssRenderSide(); // the studio shows the same tools (in its drop-down)
  if (EDIT.dlg !== "hitsound") return;
  const body = DLG.querySelector(".dlbody"); if (!body) return;
  const st = body.scrollTop; body.innerHTML = ""; hitsoundDialog(body); body.scrollTop = st;
}
function edgeName(o, k) { return k === 0 ? tr("head") : k === o.slides ? tr("tail") : tr("repeat {n}", { n: k }); }
function edgeChips(o) { // pick which part of a selected slider the hitsound controls edit
  const box = h("div", "edges"), cur = EDIT.edgeFor === o.lid ? EDIT.edge : null;
  const chip = (label, k) => { const b = h("button", cur === k ? "on" : "", label); b.onclick = () => pickEdge(o, k); box.append(b); };
  chip(tr("Whole slider"), null); for (let k = 0; k <= o.slides; k++) chip(edgeName(o, k), k);
  return box;
}
function deleteSel() {
  if (!EDIT.sel.size) return;
  edCommit("Delete objects", () => { map.lines = map.lines.filter(L => !EDIT.sel.has(L.id)); });
  EDIT.sel.clear(); updateEdUI();
}
function toggleBookmark() {
  const t = snapTime(A.cur()), i = map.bookmarks.findIndex(b => Math.abs(b - t) < 20);
  edCommit(i >= 0 ? "Remove bookmark" : "Add bookmark", () => { if (i >= 0) map.bookmarks.splice(i, 1); else { map.bookmarks.push(t); map.bookmarks.sort((a, b) => a - b); } });
  toast(tr(i >= 0 ? "Bookmark removed" : "Bookmark added at {t}", { t: fmtMs(t) }), 1500);
}
function freeAt(t, end = t) { return !map.hit.some(o => t <= o.end + 1 && end >= o.t - 1); }
function addLine(label, s) {
  const L = { s, id: newLineId() };
  if (edCommit(label, () => map.lines.push(L))) { EDIT.sel = new Set([L.id]); updateEdUI(); }
}
function placePoint(x, y, t) {
  const near = nearObjSnap(x, y); if (near) return near;
  [x, y] = dsSnap(x, y, t); return clampPF(S.ds ? Math.round(x) : gridSnap(x), S.ds ? Math.round(y) : gridSnap(y));
}
// osu!lazer (TrySnapToNearbyObjects): within 6.4 osu!px (a tenth of an object's radius) of a visible object's head or
// end, a new object goes exactly there (stacks); positions without the stack offset, like lazer
function nearObjSnap(x, y) {
  if (!map || !map.hit.length) return null;
  const t = A.cur(), [lo, hi] = visibleRange(t); let best = null, bd = 6.4;
  for (let i = lo; i <= hi; i++) {
    const o = map.hit[i]; if (o.kind === "spinner" || EDIT.sel.has(o.lid) || o.t - map.preempt > t || o.end + 700 < t) continue;
    for (const q of o.kind === "slider" ? [[o.x, o.y], endPos(o)] : [[o.x, o.y]]) { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = [Math.round(q[0]), Math.round(q[1])]; } }
  }
  return best;
}
function placeCircle(x, y) {
  const t = snapTime(A.cur());
  if (!freeAt(t)) return toast(tr("There's already an object at this time. Move the time first (← → or the timeline)"));
  [x, y] = placePoint(x, y, t);
  const ph = placeHS(); addLine("Place circle", `${x},${y},${t},1,${ph.hs},${ph.s}`);
}
function placeSpinner() {
  const t = snapTime(A.cur()), end = Math.round(t + beatInfo(t).len * 4);
  if (!freeAt(t, end)) return toast(tr("There's already an object in this time range"));
  const ph = placeHS(); addLine("Place spinner", `256,192,${t},12,${ph.hs},${end},${ph.s}`);
}
// the slider being placed: its length snapped down to the beat divisor, where (and when) it ends
// (also for reshaping a placed slider: opt = { curve, slides, except: its line id })
function sliderPlan(pts, opt = {}) {
  if (!pts || pts.length < 2) return null;
  let curve = opt.curve || (pts.length === 2 ? "L" : "B");
  if (curve === "P" && pts.length !== 3 || curve === "L" && pts.length > 2) curve = "B";
  const t = pts.t, path = sliderPath(curve, pts), slides = opt.slides || 1;
  const { beat, sv } = timingAt(map, t), pxBeat = +(map.diff.SliderMultiplier || 1.4) * 100 * sv, step = pxBeat / S.snap;
  const len = Math.floor(pathLen(path) / step + 1e-6) * step; // snap length to the beat divisor
  const span = len / pxBeat * beat, end = t + span * slides, tp = len >= step ? trimPath(path, len) : null;
  const free = len >= step && (opt.except != null ? freeExcept(t, end, opt.except) : freeAt(t, end));
  return { t, end, span, slides, len, step, beat, curve, ok: len >= step, free, endPt: tp ? tp[tp.length - 1] : null };
}
// ---------- placing a slider, like osu!lazer's SliderPlacementBlueprint ----------
// Points are placed one by one; a point marked .red starts a new segment (click the last point again, or S). Each
// segment's curve follows its number of points (2 = straight, 3 = perfect circle, more = bezier) unless chosen with
// Alt+1/2/3 or Tab. Right-click, Enter or Done ends it. Dragging from the head before placing more points draws it
// freehand. osu! files have one curve type per slider, so several segments are written like osu!'s stable export:
// one bezier with red anchors (straight pieces as 2-point beziers, circle arcs as cubic beziers).
const SEG_TYPES = ["L", "B", "P"];
function placeSegs(pts) {
  const segs = []; let cur = [pts[0]]; cur.type = pts[0].type;
  for (let i = 1; i < pts.length; i++) { cur.push(pts[i]); if (pts[i].red && i < pts.length - 1) { segs.push(cur); cur = [pts[i]]; cur.type = pts[i].type; } }
  segs.push(cur); return segs;
}
const segType = s => { const t = s.type || (s.length <= 2 ? "L" : s.length === 3 ? "P" : "B"); return t === "P" && (s.length !== 3 || !arcProps(s[0], s[1], s[2])) ? "B" : t; };
// a circle arc (3 points) as cubic beziers, at most 90° each: control points at 4/3·tan(θ/4) of the radius
function arcBeziers(s) {
  const a = arcProps(s[0], s[1], s[2]); if (!a) return null;
  const n = Math.max(1, Math.ceil(a.range / (Math.PI / 2))), step = a.range / n * a.dir, k = 4 / 3 * Math.tan(step / 4), out = [];
  const P = th => [a.cx + Math.cos(th) * a.r, a.cy + Math.sin(th) * a.r];
  for (let i = 0; i < n; i++) {
    const t0 = a.t0 + i * step, t1 = t0 + step, p0 = P(t0), p1 = P(t1);
    out.push([p0, [p0[0] - Math.sin(t0) * a.r * k, p0[1] + Math.cos(t0) * a.r * k], [p1[0] + Math.sin(t1) * a.r * k, p1[1] - Math.cos(t1) * a.r * k], p1]);
  }
  return out;
}
// -> { curve, cps } for the file (cps includes the head)
function placeCurve(pts) {
  const segs = placeSegs(pts), R = p => [Math.round(p[0]), Math.round(p[1])];
  if (segs.length === 1) { const t = segType(segs[0]); if (t !== "L" || segs[0].length === 2) return { curve: t, cps: segs[0].map(R) }; }
  const out = [R(pts[0])];
  for (const s of segs) {
    const t = segType(s), pieces = t === "L" ? s.slice(1).map((p, i) => [s[i], p]) : t === "P" ? arcBeziers(s) : [s];
    for (const pc of pieces) { for (const q of pc.slice(1)) out.push(R(q)); out.push(R(pc[pc.length - 1])); } // (the repeated point = red anchor)
  }
  out.pop(); return { curve: "B", cps: out };
}
// the points so far + the cursor (lazer: the cursor counts as the next point unless it sits on the last one)
const placingPts = () => {
  const P = EDIT.sliderPts, c = EDIT.hoverPt; if (!P || !c || (EDIT.drawing && EDIT.drawing.raw)) return P;
  const l = P[P.length - 1]; return Math.hypot(c[0] - l[0], c[1] - l[1]) < 1 ? P : Object.assign([...P, c], { t: P.t });
};
function placePlan(pts = placingPts()) {
  if (!pts || pts.length < 2) return null;
  const c = pts.curve ? pts : placeCurve(pts), plan = sliderPlan(Object.assign(c.cps.slice(), { t: pts.t }), { curve: c.curve });
  return plan && Object.assign(plan, { cps: c.cps, curve: c.curve });
}
function finishSlider(drawn) {
  const pts = drawn || EDIT.sliderPts; EDIT.sliderPts = null; EDIT.drawing = null; $("edSliderDone").hidden = true;
  if (!pts || (!pts.curve && pts.length < 2)) { dirty = true; return toast(tr("A slider needs at least 2 points")); }
  const plan = placePlan(pts);
  if (!plan || !plan.ok) { dirty = true; return toast(tr("The slider is too short for this beat snap")); }
  const { t, curve, len, end, cps } = plan;
  if (!freeAt(t, end)) { dirty = true; return toast(tr("This slider overlaps another object in time")); }
  const ph = placeHS(); addLine("Place slider", `${cps[0][0]},${cps[0][1]},${t},2,${ph.hs},${curve}|${cps.slice(1).map(p => p[0] + ":" + p[1]).join("|")},1,${Math.round(len * 1000) / 1000},${ph.hs}|${ph.hs},0:0|0:0,${ph.s}`);
}
// lazer: click on the last point (or S) = that point starts a new segment; Alt+1/2/3 or Tab = the current segment's type
function sliderNewSegment() {
  const P = EDIT.sliderPts; if (!P || P.length < 2) return;
  const last = P[P.length - 1]; if (last.red) return;
  last.red = true; dirty = true; toast(tr("New segment (red anchor)"), 1000);
}
function sliderSegType(dir, set) {
  const P = EDIT.sliderPts; if (!P) return;
  let i = P.length - 1; while (i > 0 && !P[i].red) i--;
  const seg = placeSegs(placingPts()).pop(), cur = SEG_TYPES.indexOf(P[i].type || segType(seg));
  P[i].type = set || SEG_TYPES[(cur + dir + SEG_TYPES.length) % SEG_TYPES.length];
  dirty = true; toast(tr("Segment: {t}", { t: tr({ L: "Linear", B: "Bezier", P: "Perfect curve" }[P[i].type]) }), 1000);
}
// freehand (lazer's drawing mode): the dragged path, simplified; a circle arc when it is one, else a smooth bezier through
// the kept points (Catmull-Rom turned into cubic beziers)
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; let md = 0, mi = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L; if (d > md) { md = d; mi = i; } }
  return md <= eps ? [a, b] : [...rdp(pts.slice(0, mi + 1), eps).slice(0, -1), ...rdp(pts.slice(mi), eps)];
}
function drawnCurve(raw, t) {
  // even spacing along the drawn path (a smooth curve through them), then points on straight stretches dropped
  const total = pathLen(raw), gap = Math.max(18, total / 30), even = [raw[0]]; let acc = 0;
  for (let i = 1; i < raw.length; i++) { acc += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]); if (acc >= gap) { even.push(raw[i]); acc = 0; } }
  if (even[even.length - 1] !== raw[raw.length - 1]) { if (acc < gap / 3 && even.length > 1) even.pop(); even.push(raw[raw.length - 1]); }
  const pts = rdp(even, 1.5);
  if (pts.length < 2 || pathLen(raw) < 8) return null;
  const R = p => [Math.round(p[0]), Math.round(p[1])];
  if (pts.length > 2) { // one circle arc?
    const mid = raw[Math.floor(raw.length / 2)], a = arcProps(raw[0], mid, raw[raw.length - 1]);
    if (a && a.range < 2 * Math.PI && a.r < 1000) {
      const err = raw.reduce((s, p) => s + Math.abs(Math.hypot(p[0] - a.cx, p[1] - a.cy) - a.r), 0) / raw.length;
      let mono = true, prev = null; for (const p of raw) { const th = Math.atan2(p[1] - a.cy, p[0] - a.cx); if (prev != null) { let d = (th - prev) * a.dir; while (d < -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI; if (d < -.05) { mono = false; break; } } prev = th; }
      if (mono && err < Math.max(2, a.r * .04)) return Object.assign({ curve: "P", cps: [raw[0], mid, raw[raw.length - 1]].map(R) }, { t });
    }
  }
  if (pts.length === 2) return { curve: "L", cps: pts.map(R), t };
  const cps = [R(pts[0])];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    cps.push(R([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]), R([p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]), R(p2));
    if (i < pts.length - 2) cps.push(R(p2));
  }
  return { curve: "B", cps, t };
}
$("edSliderDone").onclick = () => finishSlider(); // (not the click event as the drawn curve)

// ---------- playfield input ----------
let pdown = null, lastTap = { t: 0, id: null };
cv.addEventListener("pointerdown", e => {
  if (!EDIT.on || !map || e.button === 2) return; // right button = context menu
  if (anySheet()) { closeSheet(); closeTools(); return; }
  e.preventDefault();
  if (isMania()) return maniaDown(e); // (maniaed.js)
  const [x, y] = toOsu(e), t = A.cur();
  if (EDIT.tool === "circle") return placeCircle(x, y);
  if (EDIT.tool === "spinner") return placeSpinner();
  if (EDIT.tool === "slider") {
    if (!EDIT.sliderPts) {
      const st = snapTime(t); if (!freeAt(st)) return toast(tr("There's already an object at this time"));
      EDIT.sliderPts = [placePoint(x, y, st)]; EDIT.sliderPts.t = st; $("edSliderDone").hidden = false;
      EDIT.drawing = { id: e.pointerId, x, y, raw: null }; cv.setPointerCapture(e.pointerId); // (a drag from here draws it freehand)
    } else {
      const p = clampPF(gridSnap(x), gridSnap(y)), last = EDIT.sliderPts[EDIT.sliderPts.length - 1];
      const px = (cv.dpr || 1) / VIEW.vs; // the point's square is ~8 screen px: on it (or at the same place) = new segment
      if (Math.hypot(x - last[0], y - last[1]) < 10 * px || Math.hypot(p[0] - last[0], p[1] - last[1]) < 1) { sliderNewSegment(); return; }
      EDIT.sliderPts.push(p);
    }
    dirty = true; return;
  }
  const ss = selSlider();
  if (ss) { // the selected slider, osu!stable style: drag a point to move it, Ctrl/Shift+click a point for a red anchor,
    // right-click a point to delete it, Ctrl+click the body to add a point. Double-clicks never change the shape.
    const ai = anchorAt(ss, x, y), mod = e.ctrlKey || e.metaKey;
    if (ai > 0 && (mod || e.shiftKey)) return anchorRed(ss, ai);
    if (ai < 0 && mod && hitTest(x, y, t) === ss) return sliderAddPointAt(ss, x, y);
    if (ai > 0) {
      const pts = ss.cps.map(p => p.slice());
      const mates = [ai];
      for (let j = ai - 1; j > 0 && pts[j][0] === pts[ai][0] && pts[j][1] === pts[ai][1]; j--) mates.push(j);
      for (let j = ai + 1; j < pts.length && pts[j][0] === pts[ai][0] && pts[j][1] === pts[ai][1]; j++) mates.push(j);
      EDIT.anchor = { o: ss, pts, mates, moved: false };
      cv.setPointerCapture(e.pointerId); dirty = true; return;
    }
  }
  const o = hitTest(x, y, t), multi = e.shiftKey || e.ctrlKey || e.metaKey;
  if (o) {
    const now = performance.now(), dbl = !multi && lastTap.id === o.lid && now - lastTap.t < 350;
    lastTap = { t: now, id: o.lid };
    if (multi) { EDIT.sel.has(o.lid) ? EDIT.sel.delete(o.lid) : EDIT.sel.add(o.lid); }
    else if (!EDIT.sel.has(o.lid)) EDIT.sel = new Set([o.lid]);
    pdown = { x, y, anchor: o, moved: false, dbl };
    if (o.kind === "slider" && !multi) { const pe = pointAt(o, 1), nearEnd = Math.hypot(x - pe[0], y - pe[1]) <= map.radius && Math.hypot(x - o.x, y - o.y) > map.radius * .5;
      EDIT.edgeFor = o.lid; EDIT.edge = nearEnd ? (o.slides % 2 ? o.slides : o.slides - 1) : null; }
    if (o.kind === "slider" && EDIT.sel.size === 1 && !setTool.sliderHint) { setTool.sliderHint = true; toast(tr(TOUCH ? "Slider: drag the white points to reshape • long-press the body or a point for more (add / remove a point, red anchor)" : "Slider: drag the white points to reshape • Ctrl+click the body to add a point • right-click a point to remove it • Ctrl+click a point for a red anchor"), 5000); }
    if (!isPlaying()) { const u = hsUnits()[0], tt = u && u.o.lid === o.lid ? unitTime(u) : o.t; playEvent(map.sounds.find(s => !s.tick && Math.abs(s.t - tt) < 1.5) || { t: tt, hs: o.hs, n: 0, a: 0, i: 0, v: 0, f: "" }, 0); }
  } else {
    if (!multi) EDIT.sel.clear();
    pdown = { x, y, box: true, base: new Set(EDIT.sel) };
  }
  cv.setPointerCapture(e.pointerId);
  updateEdUI(); dirty = true;
});
cv.addEventListener("pointermove", e => {
  if (!EDIT.on || !map) return;
  if (isMania()) return maniaMove(e);
  const [x, y] = toOsu(e);
  const D = EDIT.drawing;
  if (D && e.buttons && EDIT.sliderPts && EDIT.sliderPts.length === 1) { // freehand: only while no other point was placed
    if (!D.raw && Math.hypot(x - D.x, y - D.y) * VIEW.vs / (cv.dpr || 1) > 6) D.raw = [EDIT.sliderPts[0].slice()];
    if (D.raw) { const q = clampPF(x, y), l = D.raw[D.raw.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= 1.5) D.raw.push(q); EDIT.hoverPt = null; dirty = true; return; }
  }
  if (EDIT.tool !== "select" && !pdown) { EDIT.hoverPt = EDIT.tool === "slider" && EDIT.sliderPts ? clampPF(gridSnap(x), gridSnap(y)) : placePoint(x, y, snapTime(A.cur())); dirty = true; }
  if (EDIT.anchor) {
    const A2 = EDIT.anchor, d = A2.o.x - A2.o.rx, p = clampPF(gridSnap(x - d), gridSnap(y - d));
    for (const j of A2.mates) A2.pts[j] = p.slice();
    A2.moved = true; dirty = true; return;
  }
  if (!pdown) return;
  const dist = Math.hypot(x - pdown.x, y - pdown.y) * VIEW.vs / (cv.dpr || 1);
  if (!pdown.moved && dist < 6) return;
  pdown.moved = true;
  if (pdown.box) {
    EDIT.box = [Math.min(pdown.x, x), Math.min(pdown.y, y), Math.max(pdown.x, x), Math.max(pdown.y, y)];
    const [lo, hi] = visibleRange(A.cur()), t = A.cur(), s = new Set(pdown.base);
    for (let i = lo; i <= hi; i++) { const o = map.hit[i]; if (o.end + 700 >= t && o.x >= EDIT.box[0] && o.x <= EDIT.box[2] && o.y >= EDIT.box[1] && o.y <= EDIT.box[3]) s.add(o.lid); }
    EDIT.sel = s; updateEdUI();
  } else if (pdown.anchor.kind !== "spinner") {
    const a = pdown.anchor;
    EDIT.drag = true;
    let nx = a.rx + x - pdown.x, ny = a.ry + y - pdown.y;
    if (S.ds && EDIT.sel.size === 1) { [nx, ny] = dsSnap(nx, ny, a.t, a.lid); nx = Math.round(nx); ny = Math.round(ny); }
    else { nx = gridSnap(nx); ny = gridSnap(ny); }
    EDIT.dx = nx - a.rx; EDIT.dy = ny - a.ry;
  }
  dirty = true;
});
cv.addEventListener("pointerleave", () => { if (EDIT.hoverPt && !EDIT.sliderPts) { EDIT.hoverPt = null; dirty = true; } });
function endPointer() {
  if (isMania() && maniaUp()) return;
  const D = EDIT.drawing;
  if (D) { EDIT.drawing = null; if (D.raw) { const c = drawnCurve(D.raw, EDIT.sliderPts && EDIT.sliderPts.t); if (c) finishSlider(c); else { EDIT.sliderPts = null; $("edSliderDone").hidden = true; } dirty = true; return; } }
  if (EDIT.anchor) { const A2 = EDIT.anchor; EDIT.anchor = null; if (A2.moved) sliderSetShape(A2.o, A2.pts, "Edit slider shape"); dirty = true; return; }
  if (!pdown) return;
  if (EDIT.drag) { const dx = Math.round(EDIT.dx), dy = Math.round(EDIT.dy); EDIT.drag = false; EDIT.dx = EDIT.dy = 0; moveSel(dx, dy); }
  else if (pdown.dbl && !pdown.moved) { const s = tsFor([pdown.anchor]); copyText(s).then(ok => ok && toast(tr("Copied {s}", { s }))); } // double-tap: copy timing
  EDIT.box = null; pdown = null; dirty = true;
}
cv.addEventListener("pointerup", endPointer);
cv.addEventListener("pointercancel", endPointer);
cv.addEventListener("wheel", e => { // osu!-style: scroll steps through the beat snap, Alt+scroll changes the distance snap multiplier
  if (!EDIT.on || !map) return;
  e.preventDefault();
  if (e.altKey) { const i = DS_STEPS.indexOf(S.dsMul), j = Math.max(0, Math.min(DS_STEPS.length - 1, (i < 0 ? 5 : i) + (e.deltaY < 0 ? 1 : -1))); S.dsMul = DS_STEPS[j]; save(); updateEdUI(); dirty = true; toast(`DS ${S.dsMul.toFixed(1)}x`, 900); return; }
  stepSnap(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
function stepSnap(dir, div = S.snap) {
  const t = A.cur(), b = beatInfo(t), step = b.len / div, n = Math.round((t - b.off) / step) + dir;
  seekTo(Math.round(b.off + n * step));
}

// ---------- slider shape editing ----------
// a new control point at (x, y) on the slider, between the two points it is closest to
function sliderAddPointAt(o, x, y) {
  const d = o.x - o.rx, px = x - d, py = y - d, pts = o.cps.map(p => p.slice());
  let best = 1, bd = Infinity; for (let i = 1; i < pts.length; i++) { const dd = segDist(px, py, pts[i - 1], pts[i]); if (dd < bd) { bd = dd; best = i; } }
  pts.splice(best, 0, clampPF(gridSnap(px), gridSnap(py)));
  sliderSetShape(o, pts, "Add slider point");
}
function selSlider() { if (EDIT.sel.size !== 1 || EDIT.tool !== "select") return null; const o = selObjs()[0]; return o && o.kind === "slider" ? o : null; }
function anchorAt(o, x, y) { // index of the control point under (x, y); points are drawn with the object's stack offset
  const d = o.x - o.rx, tol = 14 * (cv.dpr || 1) / VIEW.vs; let best = -1, bd = tol;
  o.cps.forEach((p, i) => { const dd = Math.hypot(p[0] + d - x, p[1] + d - y); if (dd <= bd) { bd = dd; best = i; } });
  return best;
}
const freeExcept = (t, end, lid) => !map.hit.some(o => o.lid !== lid && t <= o.end + 1 && end >= o.t - 1);
// new control points -> new line; the length is re-snapped to the beat snap, like osu! does
function sliderSetShape(o, pts, label, curve = o.curve) {
  const L = lineById(o.lid); if (!L || pts.length < 2) return false;
  if (curve === "P" && pts.length !== 3) curve = "B";
  if (curve === "L" && pts.length > 2) curve = "B";
  const { beat, sv } = timingAt(map, o.t), pxBeat = +(map.diff.SliderMultiplier || 1.4) * 100 * sv, step = pxBeat / S.snap;
  const len = Math.floor(pathLen(sliderPath(curve, pts)) / step + 1e-6) * step;
  if (len < step) { toast(tr("The slider is too short for this beat snap")); dirty = true; return false; }
  edCommit(label, () => {
    const p = L.s.split(",");
    p[0] = Math.round(pts[0][0]); p[1] = Math.round(pts[0][1]);
    p[5] = curve + "|" + pts.slice(1).map(q => Math.round(q[0]) + ":" + Math.round(q[1])).join("|");
    p[7] = Math.round(len * 1000) / 1000;
    L.s = p.join(",");
  });
  if (!freeExcept(o.t, o.t + len / pxBeat * beat * o.slides, o.lid)) toast(tr("This slider overlaps another object in time"));
  return true;
}
function sliderRepeats(delta) { const o = selSlider(); if (o) sliderSetRepeats(o, o.slides + delta); }
function sliderSetRepeats(o, n) { // n slides (1 = no reverse); the edge hitsounds follow: new edges copy the one before the tail
  n = Math.max(1, Math.round(n)); if (n === o.slides) return; const delta = n - o.slides;
  const fix = (str, def) => { if (!str) return str; const a = str.split("|"); while (a.length < n + 1) a.splice(a.length - 1, 0, a.length > 1 ? a[a.length - 2] : def); while (a.length > n + 1) a.splice(a.length - 2, 1); return a.join("|"); };
  edCommit(delta > 0 ? "Add repeat" : "Remove repeat", () => { const L = lineById(o.lid), p = L.s.split(","); p[6] = n; if (p[8]) p[8] = fix(p[8], "0"); if (p[9]) p[9] = fix(p[9], "0:0"); L.s = p.join(","); });
  if (!freeExcept(o.t, o.t + o.span * n, o.lid)) toast(tr("This slider overlaps another object in time"));
}
function sliderCurve() {
  const o = selSlider(); if (!o) return;
  const ok = ["B", "P", "C", "L"].filter(c => c === "B" || c === "C" || (c === "P" && o.cps.length === 3) || (c === "L" && o.cps.length === 2));
  const next = ok[(ok.indexOf(o.curve) + 1) % ok.length];
  if (next !== o.curve) sliderSetShape(o, o.cps.map(p => p.slice()), "Slider curve type", next);
}
// flash the hitsound buttons when a sound plays (sample set + additions)
const BANK_BTN = { normal: "edBankN", soft: "edBankS", drum: "edBankD" };
// each sound "hits" its button like a drum pad: a quick punch (bigger + bright) that decays back,
// restarted on every hit so fast streams still read as separate hits. Queued hits are dropped on pause/seek.
const HIT_COL = { edW: "#66ccff", edF: "#ffd84a", edC: "#6be38a", edBankN: "#ff66aa", edBankS: "#ff66aa", edBankD: "#ff66aa" };
const hsTimers = new Set();
// ms until the play line (drawn with the visual offset) is on song time t. Sounds are queued well ahead (more in
// wireless mode) and heard after the output's delay (large on Bluetooth), so flashes follow the line, not the queue.
const hsFlashDelay = t => Math.max(0, (t + visOffset() - A.cur()) / (A.rate || 1));
function hsFlash(hs, nSet, aSet, t) {
  if (S.hsFlash === false) return; // Settings → Editor → Flash hitsounds while playing
  const ids = [BANK_BTN[nSet]];
  if (hs & 2) ids.push("edW"); if (hs & 4) ids.push("edF"); if (hs & 8) ids.push("edC");
  if (hs & 14 && aSet !== nSet) ids.push(BANK_BTN[aSet]);
  const tm = setTimeout(() => { hsTimers.delete(tm); if (EDIT.on) for (const id of ids) drumHit($(id)); }, hsFlashDelay(t));
  hsTimers.add(tm);
}
// what is playing right now: the HS button shows the sample set and custom index (N, S2, D3…; ★ = the map's own file),
// Hitsound Studio flashes the column of the object that sounds and names the samples in its bar
const HS_ADD = { 2: "whistle", 4: "finish", 8: "clap" };
function hsNow(e, nSet, aSet, idx) {
  const tm = setTimeout(() => {
    hsTimers.delete(tm); if (!EDIT.on) return;
    const b = $("edHS"), lab = b && b.querySelector("small");
    if (lab && !e.tick) {
      lab.textContent = e.f ? "★" : nSet[0].toUpperCase() + (idx > 0 ? idx : "");
      b.classList.add("hsnow"); b.title = hsNowText(e, nSet, aSet, idx);
      clearTimeout(b.nowT); b.nowT = setTimeout(() => { lab.textContent = "HS"; b.classList.remove("hsnow"); b.title = tr(b.dataset.i18nTitle); }, 900);
    }
    if (EDIT.tab === "hitsounds" && typeof hssFlashAt === "function") hssFlashAt(e, hsNowText(e, nSet, aSet, idx));
    if (S.edSampleName && map.mode !== 3) { // osu!'s "Show sample name": the samples' names by the object that plays them
      const p = cursorAt(e.t); EDIT.sampNames = (EDIT.sampNames || []).filter(x => performance.now() - x.at < 900);
      EDIT.sampNames.push({ x: p[0], y: p[1], text: hsNowText(e, nSet, aSet, idx), at: performance.now() }); dirty = true;
    }
  }, hsFlashDelay(e.t));
  hsTimers.add(tm);
}
function hsNowText(e, nSet, aSet, idx) {
  if (e.f) return e.f;
  const n = i => i > 1 ? String(i) : "";
  if (e.tick) return `${nSet}-slidertick${n(idx)}`;
  const parts = [`${nSet}-hitnormal${n(idx)}`];
  for (const bit of [2, 4, 8]) if (e.hs & bit) parts.push(`${aSet}-hit${HS_ADD[bit]}${n(idx)}`);
  return parts.join(" + ");
}
function hsFlashCancel() { for (const t of hsTimers) clearTimeout(t); hsTimers.clear(); }
function drumHit(b) {
  if (!b) return;
  const col = HIT_COL[b.id] || "#fff";
  if (!b.animate || RM) { b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash"); clearTimeout(b.flashT); b.flashT = setTimeout(() => b.classList.remove("flash"), 90); return; }
  if (b._hit) b._hit.cancel();
  b._hit = b.animate([ // no end keyframe: it settles back to whatever state the button has (lit / mixed / off)
    { transform: "scale(1.2)", backgroundColor: col, borderColor: col, color: "#10131a", boxShadow: `0 0 0 3px ${col}55, 0 0 22px ${col}`, offset: 0 },
    { transform: "scale(.95)", backgroundColor: col, borderColor: col, color: "#10131a", boxShadow: `0 0 10px ${col}88`, offset: .28 },
  ], { duration: 230, easing: "cubic-bezier(.2,.9,.3,1)" });
}

// ---------- quick mod notes (add without leaving Compose, markers on the timeline) ----------
const NOTE_COL = { problem: "#ff5a6e", suggestion: "#ffcf6b", praise: "#57d68d", note: "#66ccff" };
let qn = null; // { id?, t, ts, type }
function buildQuickNote() {
  const box = h("div", "qnote"); box.id = "qnote"; box.hidden = true;
  const top = h("div", "qrow"), ts = h("input", "qts"), types = h("div", "qtypes");
  ts.type = "text"; ts.id = "qnTs"; ts.setAttribute("aria-label", "timestamp");
  for (const [k, l] of NOTE_TYPES) { const b = h("button", "qtype " + k); b.dataset.type = k; b.dataset.i18n = l; b.textContent = tr(l); b.onclick = () => { qn.type = k; syncQuick(); $("qnText").focus(); }; types.append(b); }
  const cat = h("span", "qcat"); cat.id = "qnCat";
  top.append(ts, types, cat);
  const bot = h("div", "qrow"), txt = h("input", "qtext"), saveB = h("button", "btn main sm", tr("Save")), delB = h("button", "btn ghost sm", tr("Delete")), closeB = h("button", "icon qclose");
  txt.type = "text"; txt.id = "qnText"; txt.dataset.i18nPh = "Write your mod here, e.g. the jump here is much bigger than the music suggests"; txt.placeholder = tr(txt.dataset.i18nPh); txt.enterKeyHint = "done";
  saveB.dataset.i18n = "Save"; delB.dataset.i18n = "Delete"; delB.id = "qnDel";
  closeB.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; closeB.dataset.i18nAria = "Close"; closeB.setAttribute("aria-label", tr("Close"));
  const prev = h("button", "btn ghost sm", "◀"), next = h("button", "btn ghost sm", "▶");
  prev.dataset.i18nTitle = "Previous note ([)"; next.dataset.i18nTitle = "Next note (])"; prev.title = tr("Previous note ([)"); next.title = tr("Next note (])"); prev.onclick = () => jumpNote(-1); next.onclick = () => jumpNote(1);
  saveB.onclick = saveQuick; delB.onclick = () => { if (qn && qn.id) { saveNotes(loadNotes().filter(n => n.id !== qn.id)); closeQuick(); toast(tr("Note deleted"), 1200); } };
  closeB.onclick = closeQuick;
  txt.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); saveQuick(); } else if (e.key === "Escape") closeQuick(); e.stopPropagation(); });
  ts.addEventListener("keydown", e => { if (e.key === "Escape") closeQuick(); e.stopPropagation(); });
  bot.append(prev, txt, next, saveB, delB, closeB);
  box.append(top, bot);
  $("ui").append(box);
}
function syncQuick() {
  document.querySelectorAll("#qnote .qtype").forEach(b => b.classList.toggle("on", b.dataset.type === qn.type));
  $("qnDel").hidden = !qn.id;
}
function openQuick(t, objs, existing) {
  if (!EDIT.on) return addNoteFrom(t, objs);
  const last = loadNotes().slice(-1)[0];
  qn = existing ? { ...existing } : { t: Math.round(t), ts: (objs.length ? tsFor(objs) : tsAt(t)).replace(/ - $/, ""), type: last ? last.type : "suggestion", text: "" };
  if (!existing) qn.cat = noteCatNew();
  $("qnCat").replaceChildren(noteCatSelect(qn.cat, v => { qn.cat = v; $("qnText").focus(); }));
  $("qnote").hidden = false; $("qnTs").value = qn.ts; $("qnText").value = qn.text || "";
  syncQuick(); setTimeout(() => $("qnText").focus(), 30);
}
function closeQuick() { $("qnote").hidden = true; qn = null; dirty = true; }
function saveQuick() {
  const text = $("qnText").value.trim(); if (!qn) return;
  if (!text) { $("qnText").focus(); return; }
  const all = loadNotes(), ts = $("qnTs").value.trim() || fmtMs(qn.t);
  const cat = catOf(qn.cat) ? qn.cat : "";
  if (qn.id) { const n = all.find(x => x.id === qn.id); if (n) { Object.assign(n, { ts, text, type: qn.type }); if (cat) n.cat = cat; else delete n.cat; } }
  else { all.push(cat ? { id: Date.now(), t: qn.t, ts, type: qn.type, cat, text } : { id: Date.now(), t: qn.t, ts, type: qn.type, text }); S.noteCatNew = cat; save(); }
  saveNotes(all); closeQuick(); toast(tr("Note added"), 1000);
  if (EDIT.tab === "notes") edTab("notes");
}
function jumpNote(dir) {
  const list = loadNotes().sort((a, b) => a.t - b.t); if (!list.length) return toast(tr("No notes yet • In Modding mode tap an object and press \"+ Note\" to fill in the timestamp"), 2500);
  const t = A.cur(), n = dir > 0 ? list.find(x => x.t > t + 5) || list[0] : [...list].reverse().find(x => x.t < t - 5) || list[list.length - 1];
  seekTo(n.t); if (!$("qnote").hidden) openQuick(n.t, [], n);
  const o = map.hit.find(h2 => Math.abs(h2.t - n.t) < 2); if (o) edSelectIds([o.lid]);
}
buildQuickNote();

// ---------- toolbars ----------
function setTool(tool) {
  if (typeof inkAway === "function") inkAway(); // a live-session drawing tool that is out would take the playfield's clicks (liveink.js)
  EDIT.tool = tool; EDIT.hoverPt = null; if (tool !== "slider") { EDIT.sliderPts = null; EDIT.drawing = null; $("edSliderDone").hidden = true; }
  document.querySelectorAll("#edLeft [data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === tool));
  updateEdUI(); dirty = true;
}
document.querySelectorAll("#edLeft [data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
$("edNC").onclick = toggleNC;
$("edW").onclick = () => toggleHS(2);
$("edF").onclick = () => toggleHS(4);
$("edC").onclick = () => toggleHS(8);
document.querySelectorAll("#edRight [data-bank]").forEach(b => b.onclick = e => setBankOf(e.altKey ? 1 : 0, +b.dataset.bank));
$("edHS").onclick = () => EDIT.dlg === "hitsound" ? closeDlg() : openDlg("hitsound");
$("edDel").onclick = deleteSel;
$("edUndo").onclick = () => undoRedo(true);
$("edRedo").onclick = () => undoRedo(false);
$("edGrid").onclick = () => { S.grid = GRIDS[(GRIDS.indexOf(S.grid) + 1) % GRIDS.length]; save(); updateEdUI(); dirty = true; toast(S.grid ? tr("Grid snap {px}px", { px: S.grid }) : tr("Grid snap off"), 1200); };
function setGuides(on) { S.guides = on; save(); updateEdUI(); dirty = true; toast(tr(on ? "Mapping guides on" : "Mapping guides off"), 1200); renderEdSettings(); }
$("edGuide").onclick = () => setGuides(!S.guides);
$("edDS").onclick = () => { S.ds = !S.ds; save(); updateEdUI(); dirty = true; toast(S.ds ? tr("Distance snap on ({x}x) • Alt+scroll changes it", { x: S.dsMul.toFixed(1) }) : tr("Distance snap off"), 1600); };
$("edBook").onclick = toggleBookmark;
$("edMetro").onclick = () => setToggle("metro", !S.metro);
$("edStream").onclick = () => openDlg("stream");
$("edPoly").onclick = () => openDlg("polygon");
$("edXform").onclick = () => EDIT.sel.size ? openDlg("transform") : toast(tr("Select objects first"));
$("edTimingQ").onclick = () => openTiming(null);
function zoomTl(f) { EDIT.tlScale = Math.max(.03, Math.min(2, EDIT.tlScale * f)); S.tlZoom = EDIT.tlScale; save(); dirty = true; }
$("tlIn").onclick = () => zoomTl(1.5);
$("tlOut").onclick = () => zoomTl(1 / 1.5);
$("edCopy").onclick = async () => { const s = tsFor(selObjs()); toast(await copyText(s) ? tr("Copied {s}", { s }) : s); };
$("edNote").onclick = () => { const objs = selObjs(); openQuick(objs.length ? objs[0].t : A.cur(), objs); };
(() => { // slider controls, shown when one slider is selected
  const g = h("span", "edslider"); g.id = "edSliderCtl"; g.hidden = true;
  const mk = (txt, title, fn) => { const b = h("button", "btn ghost sm", txt); b.dataset.i18nTitle = title; b.title = tr(title); b.onclick = fn; g.append(b); return b; };
  mk("↻−", "Remove a repeat", () => sliderRepeats(-1)); mk("↻+", "Add a repeat", () => sliderRepeats(1));
  mk("B", "Curve type (Bezier / Perfect circle / Catmull / Linear)", sliderCurve).id = "edCurve";
  $("edInfo").insertBefore(g, $("edCopy"));
})();

function beatFrac(ms, beat) { // 0.5 beat -> "1/2", 1.5 -> "3/2"
  const r = ms / beat;
  for (const d of DIVS) { const k = Math.round(r * d); if (k && Math.abs(r * d - k) < .03) { const g = gcd(k, d); return `${k / g}/${d / g}`; } }
  return r.toFixed(2);
}
const gcd = (a, b) => b ? gcd(b, a % b) : a;
function spacingInfo(o) { // distance / distance-snap to the previous object, and the angle at it
  const p = map.hit[o.idx - 1]; if (!p || o.kind === "spinner" || p.kind === "spinner") return "";
  const pe = endPos(p), d = Math.hypot(o.x - pe[0], o.y - pe[1]);
  const b = beatInfo(o.t).len, gap = o.t - p.end, sv = svAt(map, o.t), mult = +(map.diff.SliderMultiplier || 1.4);
  const ds = gap > 0 ? d / (gap / b * mult * 100 * sv) : 0, ang = guideAngle(prevOf(p, o.lid), p, [o.x, o.y]);
  return ` • ${Math.round(d)}px • ${tr("{f} beat", { f: beatFrac(gap, b) })}${ds ? ` • DS ${ds.toFixed(2)}x` : ""}${ang ? ` • ${Math.round(ang.deg)}°` : ""}`;
}
// ---------- mapping guides: the distance and the angle to the previous objects (each part can be switched off) ----------
function prevOf(p, exclude) { // the object before p (not a spinner), skipping `exclude`
  for (let j = p.idx - 1; j >= 0; j--) { const o = map.hit[j]; if (o.lid === exclude) continue; return o.kind === "spinner" ? null : o; }
  return null;
}
// angle at p between the way in (from q) and the way out (to pos): 180° = straight on, 0° = straight back
function guideAngle(q, p, pos) {
  if (!q || !p || p.kind === "spinner") return null;
  const qe = endPos(q), pe = endPos(p), v1 = [qe[0] - p.x, qe[1] - p.y], v2 = [pos[0] - pe[0], pos[1] - pe[1]];
  const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2); if (l1 < 2 || l2 < 2) return null;
  const c = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)));
  return { deg: Math.acos(c) * 180 / Math.PI, a1: Math.atan2(v1[1], v1[0]), a2: Math.atan2(v2[1], v2[0]), l1, l2, qe, pe };
}
function guideText(txt, x, y, col, px) { // readable on top of objects: dark outline, then the colour
  ctx.globalAlpha = 1; ctx.lineJoin = "round"; ctx.lineWidth = 4 * px; ctx.strokeStyle = "rgba(10,8,16,.9)"; ctx.strokeText(txt, x, y);
  ctx.fillStyle = col; ctx.fillText(txt, x, y);
}
function drawGuides(t, px) {
  if (!S.guides) return;
  let pos = null, at = 0, ex = null, live = false;
  const objs = EDIT.sel.size === 1 && EDIT.tool === "select" ? selObjs() : [];
  if (objs.length && objs[0].kind !== "spinner" && (S.gLine || S.gAngle)) { const o = objs[0]; pos = [o.x + (EDIT.drag ? EDIT.dx : 0), o.y + (EDIT.drag ? EDIT.dy : 0)]; at = o.t; ex = o.lid; }
  else if (S.gPlace && EDIT.hoverPt && (EDIT.tool === "circle" || EDIT.tool === "slider" && !EDIT.sliderPts)) { pos = EDIT.hoverPt; at = snapTime(A.cur()); live = true; }
  if (!pos) return;
  const p = live ? prevObjBefore(at) : map.hit[objs[0].idx - 1];
  if (!p || p.kind === "spinner" || (!live && p.end + 700 < t)) return;
  const pe = endPos(p), d = Math.hypot(pos[0] - pe[0], pos[1] - pe[1]);
  ctx.font = `600 ${13 * px}px "Varela Round",sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  if (live || S.gLine) {
    ctx.globalAlpha = .8; ctx.strokeStyle = "#ffd84a"; ctx.lineWidth = 2 * px; ctx.setLineDash([8 * px, 6 * px]);
    ctx.beginPath(); ctx.moveTo(pe[0], pe[1]); ctx.lineTo(pos[0], pos[1]); ctx.stroke(); ctx.setLineDash([]);
    const gap = at - p.end, b = beatInfo(at).len, want = gap > b / 48 ? (gap / b) * +(map.diff.SliderMultiplier || 1.4) * 100 * svAt(map, at) : 0;
    guideText(`${Math.round(d)}px${want ? ` · ${(d / want).toFixed(2)}x` : ""}`, (pe[0] + pos[0]) / 2, (pe[1] + pos[1]) / 2 - 4 * px, "#ffd84a", px);
  }
  const g = S.gAngle ? guideAngle(prevOf(p, ex), p, pos) : null;
  if (g) {
    const r = Math.max(10, Math.min(36, g.l1 / 2, g.l2 / 2));
    ctx.globalAlpha = .45; ctx.strokeStyle = "#66ccff"; ctx.lineWidth = 1.5 * px; ctx.setLineDash([4 * px, 5 * px]);
    ctx.beginPath(); ctx.moveTo(g.qe[0], g.qe[1]); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.setLineDash([]);
    let diff = g.a2 - g.a1; while (diff > Math.PI) diff -= 2 * Math.PI; while (diff <= -Math.PI) diff += 2 * Math.PI;
    ctx.globalAlpha = .95; ctx.lineWidth = 2.5 * px;
    ctx.beginPath(); ctx.arc(g.pe[0], g.pe[1], r, g.a1, g.a1 + diff, diff < 0); ctx.stroke();
    const mid = g.a1 + diff / 2, lx = g.pe[0] + Math.cos(mid) * (r + 14 * px), ly = g.pe[1] + Math.sin(mid) * (r + 14 * px);
    ctx.textBaseline = "middle"; guideText(`${Math.round(g.deg)}°`, lx, ly, "#66ccff", px);
  }
  ctx.globalAlpha = 1;
}
function updateEdUI() {
  if (!map) return;
  maniaEdUI();
  const objs = selObjs(), el = $("edSel"), ssel = selSlider();
  $("edSliderCtl").hidden = !ssel; if (ssel) $("edCurve").textContent = ssel.curve || "B";
  $("edCopy").disabled = !objs.length;
  $("edUndo").disabled = !(COLLAB.on ? COLLAB.undo : EDIT.undo).length; $("edRedo").disabled = !(COLLAB.on ? COLLAB.redo : EDIT.redo).length; $("edDel").disabled = !objs.length;
  const lit = (id, f) => $(id).classList.toggle("lit", !!objs.length && objs.every(f));
  const units = hsUnits(), hsState = (id, f, pf) => {
    const n = units.length ? units.filter(f).length : 0, all = units.length ? n === units.length : pf();
    const b = $(id); b.classList.toggle("lit", all); b.classList.toggle("mixed", !!units.length && n > 0 && !all); b.classList.toggle("place", !units.length && all);
  };
  lit("edNC", o => o.type & 4);
  for (const [id, bit] of [["edW", 2], ["edF", 4], ["edC", 8]]) hsState(id, u => unitHs(u) & bit, () => EDIT.place.hs & bit);
  for (const [id, v] of [["edBankN", 1], ["edBankS", 2], ["edBankD", 3]]) hsState(id, u => unitBank(u, 0) === v, () => EDIT.place.n === v);
  $("edHS").classList.toggle("lit", EDIT.dlg === "hitsound");
  renderHsDlg();
  $("edGrid").querySelector("small").textContent = S.grid ? `${S.grid}px` : "Grid";
  $("edGrid").classList.toggle("lit", !!S.grid);
  $("edDS").querySelector("small").textContent = S.dsMul.toFixed(1) + "x";
  $("edDS").classList.toggle("lit", S.ds);
  $("edGuide").classList.toggle("lit", S.guides);
  if (!objs.length) {
    el.textContent = tr({ select: "Tap an object to select • drag empty space to select several • double-tap to copy its timing", circle: "Tap to place a circle at the current time (snap 1/{d})", slider: "Tap to place slider points (or drag from the head to draw it) • tap the last point again for a red anchor • right-click or \"Finish\" to end", spinner: "Tap to place a 4-beat spinner" }[EDIT.tool], { d: S.snap });
    return;
  }
  if (objs.length === 1 && isMania()) {
    const o = objs[0], sn = snapOf(o.t);
    el.textContent = `${tsFor(objs)}${tr(o.kind === "hold" ? "hold note" : "note")} • ${tr("column {c}", { c: o.col + 1 })} • ${sn.div ? "1/" + sn.div : tr("unsnapped ({ms} ms)", { ms: Math.round(sn.err) })}${o.kind === "hold" ? " • " + Math.round(o.end - o.t) + " ms" : ""}`;
    return;
  }
  if (objs.length === 1) {
    const o = objs[0], sn = snapOf(o.t);
    el.textContent = `${tsFor(objs)}${o.kind} • ${sn.div ? "1/" + sn.div : tr("unsnapped ({ms} ms)", { ms: Math.round(sn.err) })} • (${Math.round(o.rx)}, ${Math.round(o.ry)})${spacingInfo(o)}`;
  } else el.textContent = `${tr("{n} objects", { n: objs.length })} • ${tsFor(objs)}`;
}
addEventListener("langchange", () => { if (EDIT.on) { updateEdUI(); if (EDIT.tab !== "compose") edTab(EDIT.tab); } });

// ---------- composition tools (osu!/lazer style): slider → stream, polygon circles, rotate, scale, flip, reverse, copy/paste ----------
// every tool shows a live preview (EDIT.ghost) on the playfield and applies as one undo step
const EASES = { linear: k => k, in: k => k * k, out: k => 1 - (1 - k) * (1 - k), inout: k => k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2 };
const unstack = o => o.x - o.rx; // stack offset of an object (drawn position - saved position)
function sliderForTool() { const s = selObjs().filter(o => o.kind === "slider"); return s.length === 1 ? s[0] : null; }
// positions + times of a stream that follows the slider (repeats included); spacing eases from `start` to `end` (0 = stacked)
function streamPlan(o, opt) {
  const step = timingAt(map, o.t).beat / opt.div, n = Math.round((o.end - o.t) / step) + 1;
  if (n < 2) return null;
  const d = unstack(o), total = o.length * o.slides * opt.len, w = [];
  let W = 0;
  for (let i = 0; i < n - 1; i++) { const k = n > 2 ? i / (n - 2) : 0, v = Math.max(0, opt.start + (opt.end - opt.start) * EASES[opt.ease](k)); w.push(v); W += v; }
  const out = []; let acc = 0;
  for (let i = 0; i < n; i++) {
    const u = W > 0 ? total * acc / W : 0, rep = Math.min(o.slides - 1, Math.floor(u / o.length)), fr = u / o.length - rep;
    const p = pointAt(o, rep % 2 ? 1 - fr : fr);
    out.push({ x: Math.round(p[0] - d), y: Math.round(p[1] - d), t: Math.round(o.t + i * step) });
    if (i < n - 1) acc += w[i];
  }
  return out;
}
function applyStream(o, plan) {
  const L = lineById(o.lid); if (!L || !plan) return;
  const nc = S.stNC || (o.type & 4), edges = o.edgeSounds, sets = o.edgeSets;
  const lines = plan.map((q, i) => {
    const hs = i === 0 ? (isFinite(edges[0]) ? edges[0] : o.hs) : i === plan.length - 1 ? (isFinite(edges[o.slides]) ? edges[o.slides] : 0) : 0;
    const es = i === 0 ? sets[0] : i === plan.length - 1 ? sets[o.slides] : null, n = es && es[0] || 0, a = es && es[1] || 0;
    return { s: `${q.x},${q.y},${q.t},${i === 0 && nc ? 5 : 1},${hs},${n}:${a}:0:0:`, id: newLineId() };
  });
  if (edCommit("Convert slider to stream", () => { map.lines = map.lines.filter(x => x.id !== o.lid).concat(lines); })) edSelectIds(lines.map(x => x.id));
}
function polygonPlan() {
  const t0 = snapTime(A.cur()), step = beatInfo(t0).len / S.snap, n = S.polyN, out = [];
  const sel = selObjs().filter(o => o.kind !== "spinner"), cx = sel.length === 1 ? sel[0].rx : 256, cy = sel.length === 1 ? sel[0].ry : 192;
  for (let r = 0, k = 0; r < S.polyRep; r++) for (let i = 0; i < n; i++, k++) {
    const a = (S.polyRot - 90 + i * 360 / n) * Math.PI / 180;
    const [x, y] = clampPF(Math.round(cx + Math.cos(a) * S.polyR), Math.round(cy + Math.sin(a) * S.polyR));
    out.push({ x, y, t: Math.round(t0 + (k + (sel.length === 1 ? 1 : 0)) * step) });
  }
  return out;
}
function applyPolygon(plan) {
  if (!plan.length) return;
  if (!freeAt(plan[0].t, plan[plan.length - 1].t)) return toast(tr("There's already an object in this time range"));
  const lines = plan.map((q, i) => ({ s: `${q.x},${q.y},${q.t},${i === 0 ? 5 : 1},0,0:0:0:0:`, id: newLineId() }));
  if (edCommit("Polygon circles", () => map.lines.push(...lines))) edSelectIds(lines.map(x => x.id));
}
// geometry transforms of the selection: fn maps [x, y] -> [x, y] in saved (unstacked) coordinates
function selBox() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of selObjs()) { if (o.kind === "spinner") continue; for (const q of o.cps || [[o.rx, o.ry]]) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); } }
  return isFinite(x0) ? { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } : null;
}
function transformSel(label, fn) {
  if (!selObjs().some(o => o.kind !== "spinner")) return toast(tr("Select objects first"));
  edCommit(label, () => editLines((p, type) => {
    if (type & 8) return;
    const q = fn([+p[0], +p[1]]); p[0] = Math.round(q[0]); p[1] = Math.round(q[1]);
    if (type & 2 && p[5]) { const parts = p[5].split("|"); p[5] = [parts[0], ...parts.slice(1).map(s => { const r = fn(s.split(":").map(Number)); return Math.round(r[0]) + ":" + Math.round(r[1]); })].join("|"); }
  }));
}
function pivot() { const b = selBox(); return S.pivot === "field" || !b ? [256, 192] : [b.cx, b.cy]; }
const rotFn = (deg, c) => { const a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a); return ([x, y]) => [c[0] + (x - c[0]) * cs - (y - c[1]) * sn, c[1] + (x - c[0]) * sn + (y - c[1]) * cs]; };
const scaleFn = (f, c) => ([x, y]) => [c[0] + (x - c[0]) * f, c[1] + (y - c[1]) * f];
function flipSel(horiz) { const c = pivot(); transformSel(horiz ? "Flip horizontally" : "Flip vertically", ([x, y]) => horiz ? [2 * c[0] - x, y] : [x, 2 * c[1] - y]); }
function rotateSel(deg) { transformSel("Rotate", rotFn(deg, pivot())); }
function scaleSel(f) { transformSel("Scale", scaleFn(f, pivot())); }
function reverseSel() { // mirror the selection in time (sliders run the other way)
  const objs = selObjs(); if (objs.length < 2) return toast(tr("Select at least 2 objects"));
  const T0 = Math.min(...objs.map(o => o.t)), T1 = Math.max(...objs.map(o => o.end));
  edCommit("Reverse selection", () => { for (const o of objs) {
    const L = lineById(o.lid); if (!L) continue; const p = L.s.split(",");
    p[2] = Math.round(T0 + T1 - o.end);
    if (o.type & 8) p[5] = Math.round(T0 + T1 - o.t);
    if (o.kind === "slider" && Math.abs(pathLen(sliderPath(o.curve, o.cps)) - o.length) < 3) {
      const cps = o.cps.slice().reverse(); p[0] = cps[0][0]; p[1] = cps[0][1];
      p[5] = o.curve + "|" + cps.slice(1).map(q => q[0] + ":" + q[1]).join("|");
      if (p[8]) p[8] = p[8].split("|").reverse().join("|"); if (p[9]) p[9] = p[9].split("|").reverse().join("|");
    }
    L.s = p.join(",");
  } });
}
function copySel() {
  const objs = selObjs(); if (!objs.length) return false;
  const lines = objs.map(o => lineById(o.lid)).filter(Boolean); if (!lines.length) return false;
  EDIT.clip = { t0: objs[0].t, lines: lines.map(L => L.s) };
  const s = tsFor(objs); copyText(s); toast(tr("Copied {n} objects • Ctrl+V pastes them at the current time", { n: objs.length }), 1800);
  return true;
}
function pasteClip() {
  const c = EDIT.clip; if (!c) return toast(tr("Nothing copied yet"));
  const at = snapTime(A.cur()), dt = at - c.t0;
  const lines = c.lines.map(s => { const p = s.split(","); p[2] = Math.round(+p[2] + dt); if (+p[3] & 8) p[5] = Math.round(+p[5] + dt); if (+p[3] & 128) p[5] = holdShift(p[5], dt); return { s: p.join(","), id: newLineId() }; });
  const ends = lines.map(L => { const p = L.s.split(","); return +p[3] & 8 ? +p[5] : +p[3] & 128 ? +p[5].split(":")[0] : +p[2]; });
  if (!freeAt(+lines[0].s.split(",")[2], Math.max(...ends))) toast(tr("Pasted objects overlap others in time"));
  if (edCommit("Paste", () => map.lines.push(...lines))) edSelectIds(lines.map(x => x.id));
}

// ---------- tool dialog (floating, like osu!'s small tool windows) ----------
const DLG = $("edDlg");
function field(label, key, min, max, step, fmtV = v => v) {
  const row = h("label", "dlrow"), inp = h("input"), out = h("output", null, fmtV(S[key]));
  inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = S[key];
  inp.oninput = () => { S[key] = +inp.value; out.textContent = fmtV(S[key]); save(); dlgPreview(); };
  row.append(h("span", null, tr(label)), inp, out); return row;
}
function choice(label, key, opts) {
  const row = h("label", "dlrow"), sel = h("select");
  for (const [v, l] of opts) sel.add(new Option(tr(l), v));
  sel.value = String(S[key]); sel.onchange = () => { S[key] = isNaN(+sel.value) ? sel.value : +sel.value; save(); dlgPreview(); };
  row.append(h("span", null, tr(label)), sel); return row;
}
function check(label, key) {
  const row = h("label", "dlrow chk"), inp = h("input"); inp.type = "checkbox"; inp.className = "switch"; inp.checked = !!S[key];
  inp.onchange = () => { S[key] = inp.checked; save(); dlgPreview(); };
  row.append(h("span", null, tr(label)), inp); return row;
}
function openDlg(kind) {
  if (kind === "stream" && !sliderForTool()) return toast(tr("Select one slider first"));
  if (kind === "transform" && EDIT.dlg !== "transform") { S.trRot = 0; S.trScale = 1; }
  if (kind !== "timing") tpEdit = null;
  EDIT.dlg = kind; DLG.hidden = false; DLG.innerHTML = "";
  const head = h("div", "dlhead"), x = h("button", "icon qclose"); x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; x.setAttribute("aria-label", tr("Close")); x.onclick = closeDlg;
  const body = h("div", "dlbody"), foot = h("div", "btnrow");
  const apply = (txt, fn) => { const b = h("button", "btn main sm", tr(txt)); b.onclick = fn; foot.append(b); return b; };
  const btn = (txt, fn) => { const b = h("button", "btn ghost sm", tr(txt)); b.onclick = fn; foot.append(b); return b; };
  const title = { stream: "Slider → stream", polygon: "Polygon circles", transform: "Transform selection", timing: "Timing point", hitsound: "Hitsounds" }[kind];
  head.append(h("b", null, tr(title)), x);
  if (kind === "stream") {
    body.append(choice("Beat snap", "stDiv", [[2, "1/2"], [3, "1/3"], [4, "1/4"], [6, "1/6"], [8, "1/8"], [12, "1/12"], [16, "1/16"]]),
      field("Start spacing", "stStart", 0, 2, .05, v => v.toFixed(2) + "x"), field("End spacing", "stEnd", 0, 2, .05, v => v.toFixed(2) + "x"),
      choice("Spacing curve", "stEase", [["linear", "Linear"], ["in", "Ease in (spreads out later)"], ["out", "Ease out (tightens later)"], ["inout", "Ease in-out"]]),
      field("Length used", "stLen", .1, 1, .05, v => Math.round(v * 100) + "%"), check("New combo on the first note", "stNC"),
      h("p", "hint", tr("End spacing 0 = the stream ends in a stack. Hitsounds of the slider head/tail go to the first/last note.")));
    apply("Convert", () => { const o = sliderForTool(); if (o) applyStream(o, streamPlan(o, streamOpt())); closeDlg(); });
  } else if (kind === "polygon") {
    body.append(field("Points", "polyN", 3, 16, 1), field("Distance", "polyR", 20, 190, 1, v => v + "px"), field("Rotation", "polyRot", -180, 180, 5, v => v + "°"), field("Repeats", "polyRep", 1, 8, 1),
      h("p", "hint", tr("Placed from the current time, one per beat snap (1/{d}), around the selected object or the playfield centre.", { d: S.snap })));
    apply("Place", () => { applyPolygon(polygonPlan()); closeDlg(); });
  } else if (kind === "transform") {
    body.append(choice("Pivot", "pivot", [["sel", "Selection centre"], ["field", "Playfield centre"]]), field("Rotate", "trRot", -180, 180, 1, v => v + "°"), field("Scale", "trScale", .5, 2, .01, v => v.toFixed(2) + "x"));
    const q = h("div", "btnrow");
    const qb = (txt, fn) => { const b = h("button", "btn ghost sm", txt); b.onclick = fn; q.append(b); };
    qb("⟲ 90°", () => rotateSel(-90)); qb("⟳ 90°", () => rotateSel(90)); qb("⇋ " + tr("Flip H"), () => flipSel(true)); qb("⇵ " + tr("Flip V"), () => flipSel(false)); qb("⇄ " + tr("Reverse"), reverseSel);
    body.append(q, h("p", "hint", tr("Shortcuts: Ctrl+H / Ctrl+J flip, Ctrl+G reverse, Ctrl+Shift+R rotate, Ctrl+Shift+S scale")));
    apply("Apply", () => { const r = S.trRot || 0, f = S.trScale || 1, c = pivot(); if (r || f !== 1) transformSel("Transform", p => scaleFn(f, c)(rotFn(r, c)(p))); S.trRot = 0; S.trScale = 1; save(); closeDlg(); });
  } else if (kind === "timing") { timingDialog(body, foot); }
  else if (kind === "hitsound") hitsoundDialog(body);
  btn(kind === "hitsound" ? "Close" : "Cancel", closeDlg);
  DLG.append(head, body, foot);
  applyI18n(DLG); dlgPreview();
  if (map) $("edHS").classList.toggle("lit", kind === "hitsound");
}
const streamOpt = () => ({ div: S.stDiv || 4, start: S.stStart, end: S.stEnd, ease: EASES[S.stEase] ? S.stEase : "linear", len: S.stLen || 1 });
function dlgPreview() {
  const k = EDIT.dlg; EDIT.ghost = null;
  if (k === "stream") { const o = sliderForTool(); const p = o && streamPlan(o, streamOpt()); if (p) EDIT.ghost = { pts: p, hide: o.lid }; }
  else if (k === "polygon") EDIT.ghost = { pts: polygonPlan() };
  else if (k === "transform") {
    const r = S.trRot || 0, f = S.trScale || 1, c = pivot(), fn = p => scaleFn(f, c)(rotFn(r, c)(p));
    if (r || f !== 1) EDIT.ghost = { pts: selObjs().filter(o => o.kind !== "spinner").map(o => { const q = fn([o.rx, o.ry]); return { x: q[0], y: q[1], path: o.cps && o.cps.map(fn) }; }) };
  }
  dirty = true;
}
function closeDlg() { const was = EDIT.dlg; EDIT.dlg = null; EDIT.ghost = null; DLG.hidden = true; DLG.innerHTML = ""; dirty = true; if (was === "hitsound" && map) updateEdUI(); }
function drawGhost() {
  const G = EDIT.ghost; if (!G) return;
  const s = map.radius / 64, col = palette(0), px = (cv.dpr || 1) / VIEW.vs;
  ctx.globalAlpha = .9; ctx.strokeStyle = "#66ccff"; ctx.lineWidth = 2 * px; ctx.setLineDash([5 * px, 4 * px]);
  ctx.beginPath(); G.pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.stroke(); ctx.setLineDash([]);
  for (let i = G.pts.length - 1; i >= 0; i--) {
    const q = G.pts[i];
    if (q.path) { ctx.globalAlpha = .5; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * px; ctx.beginPath(); q.path.forEach((p, j) => j ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); }
    blit(T("hitcircle", col), q.x, q.y, s, .5); blit(T("hitcircleoverlay"), q.x, q.y, s, .5);
    ctx.globalAlpha = .95; ctx.fillStyle = "#fff"; ctx.font = `600 ${Math.round(map.radius * .7)}px "Varela Round",sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(i + 1, q.x, q.y);
  }
  ctx.globalAlpha = 1;
}

// ---------- timing points: quick add/edit from Compose (Ctrl+P red, Ctrl+Shift+P green) and the Timing tab ----------
const SAMPLE_SETS = [[0, "Auto"], [1, "Normal"], [2, "Soft"], [3, "Drum"]];
let tpEdit = null; // { tp (copy being edited), orig (the real point or null = new) }
function activeTp(t, red) { let r = null; for (const tp of map.timing) { if (tp.time > t + 1) break; if (!red || tp.uninherited) r = tp; } return r; }
function newTpAt(t, red) { // prefilled from the lines active at t, like osu!
  const cur = activeTp(t) || {}, uni = activeTp(t, true) || { beat: 500, meter: 4 };
  return { time: Math.round(t), beat: red ? uni.beat : (cur.uninherited === false ? cur.beat : -100), meter: uni.meter || 4, uninherited: red, kiai: !!cur.kiai, omit: false, fx: 0,
    sampleSet: cur.sampleSet || 0, sampleIndex: cur.sampleIndex || 0, volume: cur.volume || 70 };
}
function openTiming(red, existing) {
  const t = snapTime(A.cur(), 16);
  const orig = existing || (red == null ? map.timing.find(tp => Math.abs(tp.time - A.cur()) < 2) : null);
  tpEdit = orig ? { tp: { ...orig }, orig } : { tp: newTpAt(t, red == null ? true : red), orig: null };
  if (EDIT.tab === "timing") return edTab("timing");
  openDlg("timing");
}
const msText = ms => String(Math.round(ms * 1000) / 1000); // an offset the way osu! writes it: 96930 (decimals only when it has them)
function tpFields(box, tp, onChange) { // the osu! timing point options
  const row = (label, el) => { const r = h("label", "dlrow"); r.append(h("span", null, tr(label)), el); box.append(r); return r; };
  const num = (v, step, fn, min, max) => { const i = h("input"); i.type = "number"; i.step = step; if (min != null) i.min = min; if (max != null) i.max = max; i.value = v; i.oninput = () => { if (i.value !== "" && isFinite(+i.value)) { fn(+i.value); onChange(); } }; return i; };
  const kind = h("div", "seg"), kr = h("button", tp.uninherited ? "on" : "", tr("Timing (red)")), kg = h("button", tp.uninherited ? "" : "on", tr("Inherited (green)"));
  kr.onclick = () => { if (tp.uninherited) return; const u = activeTp(tp.time, true) || { beat: 500 }; tp.uninherited = true; tp.beat = u.beat; onChange(true); };
  kg.onclick = () => { if (!tp.uninherited) return; tp.uninherited = false; tp.beat = -100; tp.omit = false; onChange(true); };
  kind.append(kr, kg); box.append(kind);
  // the offset in ms, like osu!'s timing panel (96930), with the time it is (01:36:930) beside it; a timestamp can be
  // typed or pasted too
  const tIn = h("input"), ts = h("small", "tpts"); tIn.type = "text"; tIn.inputMode = "decimal"; tIn.className = "tptime"; tIn.value = msText(tp.time); tIn.title = tr("Offset in ms, like osu! (96930). A time like 01:36:930 works too");
  const showTs = () => { ts.textContent = fmtMsExact(tp.time); };
  tIn.oninput = () => { const v = parseOsuTime(tIn.value), ok = isFinite(v); tIn.classList.toggle("bad", !ok); if (ok) { tp.time = v; showTs(); onChange(); } };
  tIn.onblur = () => { if (isFinite(parseOsuTime(tIn.value))) tIn.value = msText(tp.time); };
  const now = h("button", "btn ghost sm", tr("Now")); now.title = tr("Use where the song is now");
  now.onclick = e => { e.preventDefault(); tp.time = Math.round(A.cur()); tIn.value = msText(tp.time); showTs(); tIn.classList.remove("bad"); onChange(); };
  showTs();
  const tw = h("span", "dlin"); tw.append(tIn, ts, now); row("Offset", tw);
  if (tp.uninherited) {
    row("BPM", num(isFinite(60000 / tp.beat) ? Math.round(60000 / tp.beat * 1000) / 1000 : "", .001, v => { if (v > 0) tp.beat = 60000 / v; }, 1, 10000));
    const m = h("select"); for (let i = 1; i <= 8; i++) m.add(new Option(i + "/4", i)); m.value = tp.meter || 4; m.onchange = () => { tp.meter = +m.value; onChange(); };
    row("Time signature", m);
  } else row("Slider velocity", num(tp.beat < 0 ? Math.round(-100 / tp.beat * 1000) / 1000 : 1, .05, v => { if (v > 0) tp.beat = -100 / Math.max(.01, Math.min(10, v)); }, .01, 10));
  const ss = h("select"); for (const [v, l] of SAMPLE_SETS) ss.add(new Option(tr(l), v)); ss.value = tp.sampleSet | 0; ss.onchange = () => { tp.sampleSet = +ss.value; onChange(); };
  row("Sample set", ss);
  row("Custom sample index", num(tp.sampleIndex | 0, 1, v => tp.sampleIndex = Math.max(0, Math.round(v)), 0, 999));
  const vol = h("span", "rng"), vr = h("input"), vo = h("output", null, Math.round(tp.volume) + "%"); vr.type = "range"; vr.min = 5; vr.max = 100; vr.value = tp.volume;
  vr.oninput = () => { tp.volume = +vr.value; vo.textContent = vr.value + "%"; onChange(); }; vol.append(vr, vo); row("Volume", vol);
  const sw = (label, get, set) => { const i = h("input"); i.type = "checkbox"; i.className = "switch"; i.checked = get(); i.onchange = () => { set(i.checked); onChange(); }; const r = row(label, i); r.classList.add("chk"); };
  sw("Kiai time", () => tp.kiai, v => tp.kiai = v);
  if (tp.uninherited) sw("Omit first bar line", () => !!tp.omit, v => tp.omit = v);
}
function commitTp(del) {
  const E2 = tpEdit; if (!E2) return;
  const tp = { ...E2.tp }; delete tp.raw;
  if (!del && (!isFinite(tp.time) || !isFinite(tp.beat) || (tp.uninherited && tp.beat <= 0))) return toast(tr("Check the values"));
  const ok = edCommit(del ? "Delete timing point" : E2.orig ? "Edit timing point" : "Add timing point", () => {
    const i = E2.orig ? map.timing.indexOf(E2.orig) : -1;
    if (i >= 0) map.timing.splice(i, 1);
    if (!del) map.timing.push(tp);
  }, { keepPanel: true });
  if (!ok) return;
  tpEdit = del ? null : { tp: { ...tp }, orig: tp };
  toast(tr(del ? "Timing point deleted" : E2.orig ? "Timing point updated" : "Timing point added at {t}", { t: fmtMs(tp.time) }), 1400);
  if (EDIT.tab === "timing") edTab("timing");
  else if (del) closeDlg(); else openDlg("timing");
}
function timingDialog(body, foot) {
  if (!tpEdit) tpEdit = { tp: newTpAt(snapTime(A.cur(), 16), true), orig: null };
  const E2 = tpEdit, rer = () => openDlg("timing");
  body.append(h("p", "hint", E2.orig ? tr("Editing the point at {t}", { t: fmtMs(E2.orig.time) }) : tr("New point at the current time")));
  tpFields(body, E2.tp, full => { if (full) rer(); });
  const b = (txt, cls, fn) => { const x = h("button", "btn sm " + cls, tr(txt)); x.onclick = fn; foot.append(x); };
  b(E2.orig ? "Apply" : "Add", "main", () => commitTp(false));
  if (E2.orig) b("Delete", "ghost", () => commitTp(true));
}
// Timing tab (modding mode): list + the same editor
function renderTimingEditor(box) {
  const list = map.timing, t = A.cur();
  if (!tpEdit || (tpEdit.orig && !list.includes(tpEdit.orig))) { const a = activeTp(t); tpEdit = a ? { tp: { ...a }, orig: a } : { tp: newTpAt(snapTime(t, 16), true), orig: null }; }
  const top = h("div", "btnrow");
  const tb = (txt, fn, cls = "ghost") => { const b = h("button", "btn sm " + cls, tr(txt)); b.onclick = fn; top.append(b); };
  tb("+ Red line here", () => { tpEdit = { tp: newTpAt(snapTime(A.cur(), 16), true), orig: null }; edTab("timing"); }, "main");
  tb("+ Green line here", () => { tpEdit = { tp: newTpAt(snapTime(A.cur(), 16), false), orig: null }; edTab("timing"); });
  tb(S.metro ? "Metronome off" : "Metronome on", () => { setToggle("metro", !S.metro); edTab("timing"); });
  box.append(top);
  const cols = h("div", "tpcols"), lcol = h("div", "tlist tpl"), fcol = h("div", "tpform");
  const sets = ["Auto", "Normal", "Soft", "Drum"];
  for (const tp of list.slice(0, 3000)) {
    const r = h("button", "tp " + (tp.uninherited ? "red" : "green") + (tpEdit.orig === tp ? " on" : ""));
    const at = h("span", "tpat"); at.append(h("b", null, msText(tp.time)), h("small", null, fmtMsExact(tp.time))); // (the offset, and the time it is)
    r.append(at, h("span", null, tp.uninherited ? `${tpBpmText(tp)} BPM ${tp.meter}/4` : tpSvText(tp)), h("small", null, `${sets[tp.sampleSet] || "Auto"} ${Math.round(tp.volume)}%${tp.kiai ? " • kiai" : ""}`));
    r.onclick = () => { tpEdit = { tp: { ...tp }, orig: tp }; seekTo(tp.time); edTab("timing"); };
    lcol.append(r);
  }
  if (!list.length) lcol.append(h("p", "hint", tr("No timing points yet. Add a red line at the first beat of the song.")));
  const E2 = tpEdit;
  fcol.append(h("h3", null, E2.orig ? tr("Edit point at {t}", { t: fmtMs(E2.orig.time) }) : tr("New timing point")));
  tpFields(fcol, E2.tp, full => { if (full) edTab("timing"); });
  const fb = h("div", "btnrow"), ap = h("button", "btn main sm", tr(E2.orig ? "Apply" : "Add")); ap.onclick = () => commitTp(false); fb.append(ap);
  if (E2.orig) {
    const mv = h("button", "btn ghost sm", tr("Move to current time")); mv.title = tr("Move this line to where the song is now (seek there first)");
    mv.onclick = () => moveTpTo(E2.orig, Math.round(A.cur()));
    const dl = h("button", "btn ghost sm", tr("Delete")); dl.onclick = () => commitTp(true); const dup = h("button", "btn ghost sm", tr("Copy to current time")); dup.onclick = () => { tpEdit = { tp: { ...E2.tp, time: snapTime(A.cur(), 16), raw: undefined }, orig: null }; edTab("timing"); }; fb.append(mv, dup, dl);
  }
  fcol.append(fb, tapBpm(), moveAllBox());
  cols.append(fcol, lcol); box.append(cols);
  box.append(h("p", "hint", tr("Red = uninherited (BPM) • Green = inherited (SV / sound) • Tap to jump there") + " • " + tr("Ctrl+P adds a red line, Ctrl+Shift+P a green line in Compose.")));
  requestAnimationFrame(() => { const on = lcol.querySelector(".on"); on && on.scrollIntoView({ block: "nearest" }); });
}
const tpBpmText = tp => { const b = 60000 / tp.beat; return isFinite(b) ? String(Math.round(b * 100) / 100) : "∞"; }; // (Aspire maps: beat lengths of 5e-324 ms)
const tpSvText = tp => tp.beat < 0 ? `SV ${(-100 / tp.beat).toFixed(2)}x` : `SV 1.00x${isNaN(tp.beat) ? " (NaN)" : ""}`; // (a NaN green line counts as 1x, like osu!)
// move one timing point to another time (the "Move to current time" button), as one step you can undo
function moveTpTo(orig, t) {
  if (!orig || !isFinite(t) || Math.abs(orig.time - t) < 1e-6) return;
  const from = orig.time, tp = { ...orig, time: t }; delete tp.raw;
  const ok = edCommit(orig.uninherited ? "Move red line" : "Move green line", () => { const i = map.timing.indexOf(orig); if (i >= 0) map.timing.splice(i, 1, tp); }, { keepPanel: true });
  if (!ok) return;
  tpEdit = { tp: { ...tp }, orig: tp };
  toast(tr("Moved from {a} to {b}", { a: msText(from), b: msText(t) }), 1800);
  edTab("timing");
}
// ---------- move everything in time (osu!: offset the whole map, e.g. after changing the song's start) ----------
function moveAll(dt, what) {
  if (!dt || !isFinite(dt)) return;
  const ok = edCommit("Move everything in time", () => {
    if (what.timing) map.timing = map.timing.map(tp => { const q = { ...tp, time: tp.time + dt }; delete q.raw; return q; });
    if (what.objects) for (const L of map.lines) {
      const p = L.s.split(","), type = +p[3]; if (p.length < 4) continue;
      p[2] = Math.round(+p[2] + dt); if (type & 8) p[5] = Math.round(+p[5] + dt); if (type & 128) p[5] = holdShift(p[5], dt);
      L.s = p.join(",");
    }
    if (what.extras) {
      map.bookmarks = map.bookmarks.map(b => b + dt).filter(b => b >= 0);
      map.breaks = map.breaks.map(([a, b]) => [a + dt, b + dt]);
      const pv = +map.general.PreviewTime; if (map.general.PreviewTime != null && pv >= 0) map.general.PreviewTime = String(Math.max(0, Math.round(pv + dt)));
    }
  }, { keepPanel: true });
  if (ok) { toast(tr("Moved {ms} ms {dir}", { ms: msText(Math.abs(dt)), dir: tr(dt > 0 ? "later" : "earlier") }), 2000); if (EDIT.tab === "timing") edTab("timing"); }
}
function moveAllBox() {
  const box = h("div", "moveall"), what = S.moveAllWhat || { timing: true, objects: true, extras: true };
  box.append(h("h3", null, tr("Move everything in time")));
  // how far in ms, like an osu! offset (a time like 00:01:500 works too)
  const row = h("div", "dlin"), inp = h("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.className = "tptime"; inp.value = msText(S.moveAllMs ?? 10);
  inp.setAttribute("aria-label", tr("Milliseconds")); inp.placeholder = "10";
  inp.oninput = () => { const v = Math.abs(parseOsuTime(inp.value)); inp.classList.toggle("bad", !isFinite(v)); if (isFinite(v)) { S.moveAllMs = v; save(); } };
  inp.onblur = () => { if (!inp.classList.contains("bad")) inp.value = msText(S.moveAllMs ?? 10); };
  inp.addEventListener("keydown", e => e.stopPropagation());
  const go = sign => () => { const v = Math.abs(parseOsuTime(inp.value)); if (!v || !isFinite(v)) return toast(tr("Type how many ms to move")); moveAll(sign * v, what); };
  const minus = h("button", "btn ghost sm", tr("− Earlier")), plus = h("button", "btn ghost sm", tr("+ Later")); minus.onclick = go(-1); plus.onclick = go(1);
  row.append(inp, h("span", null, "ms"), minus, plus); box.append(row);
  for (const [k, label] of [["timing", "Timing points (red and green)"], ["objects", "Objects"], ["extras", "Bookmarks, breaks and preview point"]]) {
    const l = h("label", "chkrow"), c = h("input"); c.type = "checkbox"; c.checked = what[k] !== false;
    c.onchange = () => { what[k] = c.checked; S.moveAllWhat = what; save(); }; l.append(c, h("span", null, tr(label))); box.append(l);
  }
  box.append(h("small", "hint", tr("The storyboard and video stay where they are. One step: Ctrl+Z undoes it.")));
  return box;
}
function tapBpm() { // tap along to the song to find its BPM
  const box = h("div", "tapbpm"), b = h("button", "btn ghost", tr("Tap BPM")), out = h("span", null, "–"), taps = [];
  b.onclick = () => {
    const now = performance.now(); if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0; taps.push(now); if (taps.length > 24) taps.shift();
    if (taps.length > 3) { const bpm = 60000 * (taps.length - 1) / (taps[taps.length - 1] - taps[0]); out.textContent = (Math.round(bpm * 10) / 10) + " BPM"; out.dataset.v = bpm; }
    else out.textContent = tr("keep tapping…");
  };
  const use = h("button", "btn ghost sm", tr("Use")); use.onclick = () => { const v = +out.dataset.v; if (!v || !tpEdit || !tpEdit.tp.uninherited) return; tpEdit.tp.beat = 60000 / Math.round(v); edTab("timing"); };
  box.append(b, out, use); return box;
}

// ---------- keyboard (osu! editor shortcuts) ----------
function edKey(e) {
  const k = e.code, mod = e.ctrlKey || e.metaKey;
  if (mod && k === "KeyZ") { e.preventDefault(); undoRedo(!e.shiftKey); return true; }
  if (mod && k === "KeyY") { e.preventDefault(); undoRedo(false); return true; }
  if (mod && k === "KeyA") { e.preventDefault(); edSelectIds(map.hit.map(o => o.lid)); return true; }
  if (mod && k === "KeyB") { e.preventDefault(); toggleBookmark(); return true; }
  if (mod && e.shiftKey) { // tool dialogs, osu!/lazer shortcuts
    const dl = { KeyF: "stream", KeyD: "polygon", KeyR: "transform", KeyS: "transform" }[k];
    if (dl) { e.preventDefault(); if (dl === "transform" && !EDIT.sel.size) toast(tr("Select objects first")); else openDlg(dl); return true; }
    if (k === "KeyP") { e.preventDefault(); openTiming(false); return true; }
  }
  if (mod && k === "KeyS") { e.preventDefault(); exportOsu(); return true; }
  if (mod && k === "KeyC") { if (EDIT.sel.size) { e.preventDefault(); copySel(); return true; } return false; }
  if (mod && k === "KeyV") { e.preventDefault(); pasteClip(); return true; }
  if (mod && k === "KeyX") { if (EDIT.sel.size) { e.preventDefault(); cutSel(); return true; } return false; }
  if (mod && k === "KeyD") { e.preventDefault(); cloneSel(); return true; }
  if (isMania() && mod && /^Key[HJG]$|^Comma$|^Period$/.test(k) && !e.shiftKey) { e.preventDefault(); if (k === "KeyH" || k === "KeyJ") maniaFlip(); return true; } // mania: Ctrl+H / J mirror the columns
  if (isMania() && mod && e.shiftKey && /^Key[FDR]$/.test(k)) { e.preventDefault(); return true; } // (osu!standard tools)
  if (mod && k === "KeyH") { e.preventDefault(); flipSel(true); return true; }
  if (mod && k === "KeyJ") { e.preventDefault(); flipSel(false); return true; }
  if (mod && k === "KeyG") { e.preventDefault(); reverseSel(); return true; }
  if (mod && (k === "Comma" || k === "Period")) { e.preventDefault(); if (EDIT.sel.size) rotateSel(k === "Period" ? 90 : -90); return true; } // osu!stable: Ctrl+< / Ctrl+>
  if (mod && k === "KeyP") { e.preventDefault(); openTiming(true); return true; }
  if (mod) return false;
  const tabKey = { F1: "compose", F3: "timing", F4: "setup", F2: "hitsounds" }[k]; // osu!stable: F1 Compose, F3 Timing, F4 Song setup
  if (tabKey) { e.preventDefault(); edTab(tabKey); return true; }
  if (k === "KeyL" && e.shiftKey) { e.preventDefault(); tlLock(!S.tlLock); return true; }
  if (k === "KeyH" && LIVE.on) { liveHighlight(); return true; }
  if (k === "KeyG" && e.shiftKey) { e.preventDefault(); setGuides(!S.guides); return true; }
  if (e.altKey && EDIT.sliderPts && /^Digit[123]$/.test(k)) { e.preventDefault(); sliderSegType(0, SEG_TYPES[+k.slice(5) - 1]); return true; } // lazer: Alt+1 linear, 2 bezier, 3 perfect curve
  if (e.shiftKey || e.altKey) { const v = { KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3 }[k]; if (v != null) { e.preventDefault(); setBankOf(e.altKey ? 1 : 0, v); return true; } }
  if (k === "KeyH" && !LIVE.on && !e.shiftKey) { $("edHS").click(); return true; }
  const tools = { Digit1: "select", Digit2: "circle", Digit3: "slider", Digit4: "spinner" };
  if (tools[k] && !(isMania() && k === "Digit4")) { setTool(tools[k]); return true; }
  if (isMania() && (k === "KeyQ" || k === "KeyT" || k === "KeyG" || k === "ArrowUp" || k === "ArrowDown")) return true; // (no combos, distance snap, grid or y moves)
  if (k === "KeyQ") { toggleNC(); return true; }
  if (k === "KeyW") { toggleHS(2); return true; }
  if (k === "KeyE") { toggleHS(4); return true; }
  if (k === "KeyR") { toggleHS(8); return true; }
  if (k === "KeyT") { $("edDS").click(); return true; }
  if (k === "KeyG") { $("edGrid").click(); return true; }
  if (k === "KeyN") { $("edNote").click(); return true; }
  if (k === "BracketLeft" || k === "BracketRight") { jumpNote(k === "BracketRight" ? 1 : -1); return true; }
  if (k === "Delete" || k === "Backspace") { e.preventDefault(); deleteSel(); return true; }
  if (k === "Enter" && EDIT.sliderPts) { finishSlider(); return true; }
  if (EDIT.sliderPts && k === "KeyS") { if (EDIT.hoverPt) { const l = EDIT.sliderPts[EDIT.sliderPts.length - 1]; if (Math.hypot(EDIT.hoverPt[0] - l[0], EDIT.hoverPt[1] - l[1]) >= 1) EDIT.sliderPts.push(EDIT.hoverPt.slice()); } sliderNewSegment(); return true; }
  if (EDIT.sliderPts && k === "Tab") { e.preventDefault(); sliderSegType(e.shiftKey ? -1 : 1); return true; }
  if (k === "Escape") {
    if (EDIT.dlg) { closeDlg(); return true; }
    if (EDIT.tab !== "compose") { edTab("compose"); return true; }
    if (EDIT.sliderPts) { EDIT.sliderPts = null; $("edSliderDone").hidden = true; dirty = true; return true; }
    if (typeof MED !== "undefined" && MED.hold) { MED.hold = null; dirty = true; return true; }
    if (EDIT.sel.size) { edSelectIds([]); return true; }
    return false;
  }
  if (k === "ArrowLeft" || k === "ArrowRight") {
    e.preventDefault(); const dir = k === "ArrowRight" ? 1 : -1;
    if (EDIT.tab === "hitsounds" && !e.altKey) { hssStep(dir); return true; }
    if (e.altKey && EDIT.sel.size) { shiftSel(dir * Math.round(beatInfo(A.cur()).len / S.snap)); return true; } // Alt+arrow nudges selection in time
    stepSnap(dir, e.shiftKey ? 1 : S.snap); return true;
  }
  if (k === "ArrowUp" || k === "ArrowDown") { if (!EDIT.sel.size) return false; e.preventDefault(); moveSel(0, (k === "ArrowDown" ? 1 : -1) * (S.grid || 1)); return true; }
  return false;
}

// ---------- drawing on the playfield (osu!px space) ----------
function edDrawUnder(t) {
  const px = (cv.dpr || 1) / VIEW.vs;
  ctx.globalAlpha = 1; ctx.lineWidth = 1.5 * px;
  if (S.grid) {
    ctx.strokeStyle = "rgba(255,255,255,.1)"; ctx.beginPath();
    for (let x = 0; x <= 512; x += S.grid) { ctx.moveTo(x, 0); ctx.lineTo(x, 384); }
    for (let y = 0; y <= 384; y += S.grid) { ctx.moveTo(0, y); ctx.lineTo(512, y); }
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.strokeRect(0, 0, 512, 384);
  // distance snap rings around the previous object, like osu!
  if (S.ds && S.guides && S.gRings && (EDIT.tool !== "select" || EDIT.sel.size === 1)) {
    const sel = EDIT.sel.size === 1 && EDIT.tool === "select" ? selObjs()[0] : null;
    const at = sel ? sel.t : snapTime(A.cur()), p = prevObjBefore(at, sel && sel.lid);
    if (p) {
      const pe = endPos(p), b = beatInfo(at).len, step = b / S.snap, cur = Math.round((at - p.end) / step);
      for (let k = 1; k <= Math.max(8, cur + 2); k++) {
        const d = dsDist(p, p.end + k * step);
        ctx.globalAlpha = k === cur ? .9 : .22; ctx.strokeStyle = k === cur ? "#ffd84a" : "#fff"; ctx.lineWidth = (k === cur ? 2.5 : 1.2) * px;
        ctx.beginPath(); ctx.arc(pe[0], pe[1], d, 0, 7); ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
  if (typeof cmpDrawGhost === "function" && CMP.ghost && EDIT.tab === "compose") cmpDrawGhost(t, px); // (Compare: the other version)
}
// Settings → Editor → Compact top bar (off by default): the .edcompact styles in app.css
// phones held upright: the object tools and the hitsound buttons share one row that scrolls sideways, and the ⚒ button
// in the top bar hides that row (S.edRowHidden), so the playfield gets the room. The buttons keep their ids and handlers.
const ONE_ROW = matchMedia("(orientation: portrait) and (max-width: 760px)");
let edRowSep = null;
function edToolRow() {
  const L = $("edLeft"), R = $("edRight");
  if (ONE_ROW.matches && R.children.length) { edRowSep = edRowSep || h("span", "sep rowsep"); L.append(edRowSep, ...R.children); R.classList.add("merged"); }
  else if (!ONE_ROW.matches && edRowSep && edRowSep.parentNode === L) {
    const moved = []; for (let n = edRowSep.nextSibling; n; n = n.nextSibling) moved.push(n);
    R.append(...moved); edRowSep.remove(); R.classList.remove("merged");
  }
  UI.player.classList.toggle("edrowhid", S.edRowHidden === true);
  const b = $("edRowBtn"); if (b) b.setAttribute("aria-pressed", String(S.edRowHidden !== true));
  if (typeof measureIns === "function") requestAnimationFrame(() => { measureIns(); dirty = true; });
}
ONE_ROW.addEventListener("change", edToolRow);
if ($("edRowBtn")) $("edRowBtn").onclick = () => { S.edRowHidden = S.edRowHidden !== true; save(); edToolRow(); };
edToolRow();
function applyEdCompact() { UI.player.classList.toggle("edcompact", S.edCompact === true); if (typeof measureIns === "function") requestAnimationFrame(() => { measureIns(); dirty = true; }); }
applyEdCompact();
// Settings → Editor → Timeline height: the timeline bar at the top (CSS --tlh; the playfield fits itself under it)
const TLH = [44, 160];
function applyTlHeight() { document.documentElement.style.setProperty("--tlh", S.tlH ? Math.max(TLH[0], Math.min(TLH[1], S.tlH)) + "px" : ""); dirty = true; }
function tlHeightCtl() {
  const r = h("input"), o = h("output"), w = h("span", "edrange"), def = matchMedia("(max-width:520px)").matches ? 52 : 58;
  r.type = "range"; r.min = TLH[0]; r.max = TLH[1]; r.step = 2; r.value = S.tlH || def;
  const show = () => { o.textContent = (S.tlH || def) + " px"; };
  r.oninput = () => { S.tlH = +r.value === def ? 0 : +r.value; save(); applyTlHeight(); show(); }; show();
  w.append(r, o); return w;
}
applyTlHeight();
function edDimCtl() {
  const r = h("input"), o = h("output"), w = h("span", "edrange"); r.type = "range"; r.min = 0; r.max = 100; r.step = 5; r.value = S.edDim ?? 60;
  const show = () => o.textContent = r.value + "%"; show();
  r.oninput = () => { S.edDim = +r.value; save(); show(); dirty = true; }; w.append(r, o); return w;
}
function edDrawOver(t) {
  const px = (cv.dpr || 1) / VIEW.vs;
  if (EDIT.sampNames && EDIT.sampNames.length) { // Show sample name: each fades out above its object
    const now = performance.now(); EDIT.sampNames = EDIT.sampNames.filter(x => now - x.at < 900);
    ctx.save(); ctx.font = `600 ${12 * px}px ui-monospace,monospace`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (const x of EDIT.sampNames) {
      const k = (now - x.at) / 900, y = x.y - map.radius - 4 * px - k * 10 * px;
      ctx.globalAlpha = 1 - k * k; ctx.lineWidth = 3 * px; ctx.strokeStyle = "rgba(0,0,0,.8)"; ctx.strokeText(x.text, x.x, y); ctx.fillStyle = "#ffe08a"; ctx.fillText(x.text, x.x, y);
    }
    ctx.restore(); if (EDIT.sampNames.length) dirty = true;
  }
  if (EDIT.hoverPt && EDIT.tool === "circle") { // ghost of the circle about to be placed
    const [x, y] = EDIT.hoverPt, col = palette(0);
    blit(T("hitcircle", col), x, y, map.radius / 64, .45); blit(T("hitcircleoverlay"), x, y, map.radius / 64, .45);
  }
  if (EDIT.drawing && EDIT.drawing.raw) { // freehand: the trail so far
    const R = EDIT.drawing.raw; ctx.globalAlpha = .55; ctx.strokeStyle = "#fff"; ctx.lineCap = ctx.lineJoin = "round"; ctx.lineWidth = map.radius * 2;
    ctx.beginPath(); R.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.stroke(); ctx.globalAlpha = 1;
  } else if (EDIT.sliderPts) {
    const pts = placingPts();
    if (pts.length > 1) {
      const c = placeCurve(pts), path = sliderPath(c.curve, c.cps);
      ctx.globalAlpha = .55; ctx.strokeStyle = "#fff"; ctx.lineCap = ctx.lineJoin = "round"; ctx.lineWidth = map.radius * 2;
      ctx.beginPath(); path.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.strokeStyle = "#66ccff"; ctx.lineWidth = 2 * px; ctx.setLineDash([6 * px, 5 * px]);
    ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.stroke(); ctx.setLineDash([]);
    for (const q of EDIT.sliderPts) { ctx.fillStyle = q.red ? "#ff4d5e" : "#fff"; ctx.fillRect(q[0] - 4 * px, q[1] - 4 * px, 8 * px, 8 * px); }
    const plan = placePlan(pts);
    if (plan && plan.endPt) { // where it really ends (the length snaps down to the beat divisor) and how long it is
      const [ex, ey] = plan.endPt, col = plan.free ? "#6be38a" : "#ff4d5e";
      ctx.globalAlpha = .9; ctx.strokeStyle = col; ctx.lineWidth = 3 * px; ctx.beginPath(); ctx.arc(ex, ey, map.radius * .9, 0, 7); ctx.stroke();
      ctx.font = `600 ${13 * px}px "Varela Round",sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      guideText(tr("{f} beat", { f: beatFrac(plan.end - plan.t, plan.beat) }) + (plan.free ? "" : " • " + tr("overlaps")), ex, ey - map.radius - 4 * px, col, px);
    }
    ctx.globalAlpha = 1;
  }
  if (EDIT.box) {
    const [x0, y0, x1, y1] = EDIT.box;
    ctx.globalAlpha = .15; ctx.fillStyle = "#66ccff"; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.globalAlpha = .9; ctx.strokeStyle = "#66ccff"; ctx.lineWidth = 1.5 * px; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
  const ss = selSlider();
  if (ss && !EDIT.drag) {
    const A2 = EDIT.anchor, d = ss.x - ss.rx, pts = A2 ? A2.pts : ss.cps;
    if (A2) { // preview of the new shape
      const cur = ss.curve === "P" && pts.length !== 3 || ss.curve === "L" && pts.length > 2 ? "B" : ss.curve, path = sliderPath(cur, pts);
      ctx.globalAlpha = .45; ctx.strokeStyle = "#fff"; ctx.lineCap = ctx.lineJoin = "round"; ctx.lineWidth = map.radius * 2;
      ctx.beginPath(); path.forEach((q, i) => i ? ctx.lineTo(q[0] + d, q[1] + d) : ctx.moveTo(q[0] + d, q[1] + d)); ctx.stroke();
    }
    if (A2) { // where the reshaped slider will really end (length snaps down to the beat divisor) and how long it becomes
      const plan = sliderPlan(Object.assign(pts.slice(), { t: ss.t }), { curve: ss.curve, slides: ss.slides, except: ss.lid });
      if (plan && plan.endPt) {
        const ex = plan.endPt[0] + d, ey = plan.endPt[1] + d, col = plan.free ? "#6be38a" : "#ff4d5e";
        ctx.globalAlpha = .9; ctx.strokeStyle = col; ctx.lineWidth = 3 * px; ctx.beginPath(); ctx.arc(ex, ey, map.radius * .9, 0, 7); ctx.stroke();
        ctx.font = `600 ${13 * px}px "Varela Round",sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        guideText(tr("{f} beat", { f: beatFrac(plan.end - plan.t, plan.beat) }) + (plan.free ? "" : " • " + tr("overlaps")), ex, ey - map.radius - 4 * px, col, px);
      }
    }
    ctx.globalAlpha = .75; ctx.strokeStyle = "#ddd"; ctx.lineWidth = 1.5 * px; ctx.setLineDash([5 * px, 4 * px]);
    ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q[0] + d, q[1] + d) : ctx.moveTo(q[0] + d, q[1] + d)); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    pts.forEach((q, i) => {
      const red = (pts[i + 1] && pts[i + 1][0] === q[0] && pts[i + 1][1] === q[1]) || (i > 0 && pts[i - 1][0] === q[0] && pts[i - 1][1] === q[1]);
      const sz = (i ? 10 : 7) * px;
      ctx.fillStyle = i === 0 ? "#888" : red ? "#ff4d5e" : "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5 * px;
      ctx.fillRect(q[0] + d - sz / 2, q[1] + d - sz / 2, sz, sz); ctx.strokeRect(q[0] + d - sz / 2, q[1] + d - sz / 2, sz, sz);
    });
  }
  // the mod note at the current time, as a bubble on top of the playfield
  const nn = notesNear(t);
  if (nn) {
    const txt = `${nn.ts} - ${nn.text}`.slice(0, 90);
    ctx.font = `600 ${13 * px}px "Varela Round","IBM Plex Sans Thai",sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const w = Math.min(500, ctx.measureText(txt).width + 26 * px), hh = 26 * px, x0 = 256 - w / 2, y0 = -30 * px + 4;
    ctx.globalAlpha = .92; ctx.fillStyle = "#1c1726"; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y0, w, hh, 8 * px); else ctx.rect(x0, y0, w, hh); ctx.fill();
    ctx.fillStyle = NOTE_COL[nn.type] || "#66ccff"; ctx.fillRect(x0, y0, 4 * px, hh);
    ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.fillText(txt, x0 + 12 * px, y0 + hh / 2, w - 18 * px);
  }
  drawGhost();
  annDrawOver(t, px);
  if (COLLAB.on) collabDrawOver(t, px);
  if (LIVE.on) liveDrawOver(t, px);
  drawGuides(t, px);
  ctx.globalAlpha = 1;
}

// ---------- editor timeline (top): waveform, beat ticks coloured by divisor, objects, lines, bookmarks ----------
const TL = $("edTl"), tlg = TL.getContext("2d");
const TICK_COL = { 1: "#fff", 2: "#ff4d5e", 3: "#b35cff", 4: "#4d9bff", 6: "#d47bff", 8: "#ffd84a", 12: "#999", 16: "#777" };
function tickDiv(k, div) { const g = gcd(k, div); return div / g; }
let tlW = 0, tlH = 0, tlD = 1, wave = null;
function wavePeaks() { // one peak per 5 ms of the decoded song
  if (wave && wave.buf === A.buf) return wave;
  if (!A.buf) return null;
  const b = A.buf, sr = b.sampleRate, per = Math.max(1, Math.round(sr * .005)), n = Math.ceil(b.length / per), out = new Float32Array(n);
  const chs = []; for (let c = 0; c < Math.min(2, b.numberOfChannels); c++) chs.push(b.getChannelData(c));
  for (const d of chs) for (let i = 0, j = 0; i < n; i++) { let m = out[i]; for (const e = Math.min(d.length, j + per); j < e; j += 2) { const v = d[j] < 0 ? -d[j] : d[j]; if (v > m) m = v; } out[i] = m; }
  let mx = .01; for (const v of out) if (v > mx) mx = v;
  for (let i = 0; i < n; i++) out[i] /= mx;
  return wave = { buf: b, peaks: out, per: 5 };
}
function edDrawTimeline(t) {
  const d = Math.min(devicePixelRatio || 1, 2), w = TL.clientWidth, hh = TL.clientHeight; if (!w) return;
  if (w !== tlW || hh !== tlH || d !== tlD) { tlW = w; tlH = hh; tlD = d; TL.width = Math.round(w * d); TL.height = Math.round(hh * d); }
  const g = tlg; g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, hh);
  if (Math.abs(EDIT.tlScaleV - EDIT.tlScale) > EDIT.tlScale * .004) { EDIT.tlScaleV += (EDIT.tlScale - EDIT.tlScaleV) * .3; dirty = true; } else EDIT.tlScaleV = EDIT.tlScale;
  const sc = EDIT.tlScaleV, c = w / 2, X = ms => c + (ms - t) * sc, t0 = t - c / sc, t1 = t + c / sc;
  if (EDIT.tab === "hitsounds") hssSync(t, sc); // Hitsound Studio's lanes move with the timeline
  const W = wavePeaks();
  if (W) { // waveform behind everything
    g.fillStyle = "rgba(120,110,160,.35)";
    for (let x = 0; x < w; x++) {
      const a = Math.floor((t0 + x / sc) / W.per), b = Math.max(a + 1, Math.floor((t0 + (x + 1) / sc) / W.per));
      let m = 0; for (let i = Math.max(0, a); i < Math.min(W.peaks.length, b); i++) if (W.peaks[i] > m) m = W.peaks[i];
      if (m > .01) { const ht = m * hh * .9; g.fillRect(x, (hh - ht) / 2, 1, ht); }
    }
  }
  g.fillStyle = "rgba(255,102,170,.28)"; for (const [a, b] of map.kiai) if (b > t0 && a < t1) g.fillRect(X(a), 0, X(Math.min(b, t1 + 1)) - X(a), 5);
  g.fillStyle = "rgba(102,204,255,.16)"; for (const [a, b] of map.breaks) if (b > t0 && a < t1) g.fillRect(X(a), 0, X(b) - X(a), hh);
  // beat snap ticks
  const U = map.uni, div = S.snap;
  for (let i = Math.max(0, lastBefore(U, t0, "time")); i < U.length; i++) {
    const u = U[i], end = i + 1 < U.length ? U[i + 1].time : Infinity, step = u.beat / div;
    if (u.time > t1) break;
    if (step * sc < 2.5) continue; // too dense to draw
    let k = Math.max(0, Math.floor((t0 - u.time) / step));
    for (let tt = u.time + k * step; tt <= t1 && tt < end; k++, tt = u.time + k * step) {
      const dv = tickDiv(k % div, div), measure = k % (div * (u.meter || 4)) === 0;
      const th = measure ? hh * .5 : dv === 1 ? hh * .36 : dv <= 2 ? hh * .26 : hh * .18;
      g.fillStyle = TICK_COL[dv] || "#666"; g.globalAlpha = dv === 1 ? .9 : .65;
      g.fillRect(Math.round(X(tt)) - (measure ? 1 : .5), hh - th, measure ? 2 : 1, th);
    }
  }
  g.globalAlpha = 1;
  // timing lines on the top edge: red = uninherited, green = inherited; bookmarks in blue
  for (let i = Math.max(0, lastBefore(map.timing, t0, "time")); i < map.timing.length; i++) {
    const tp = map.timing[i]; if (tp.time > t1) break; if (tp.time < t0) continue;
    g.fillStyle = tp.uninherited ? "#ff4d5e" : "#57d68d"; g.fillRect(X(tp.time) - 1, 0, 2, tp.uninherited ? hh : 8);
  }
  g.fillStyle = "#4d9bff"; for (const b of map.bookmarks) if (b >= t0 && b <= t1) { g.fillRect(X(b) - 1, 0, 2, hh); g.beginPath(); g.moveTo(X(b) - 4, 0); g.lineTo(X(b) + 4, 0); g.lineTo(X(b), 6); g.fill(); }
  for (const n of notesCached()) if (n.t >= t0 && n.t <= t1) { // mod note flags
    const x = X(n.t); g.fillStyle = NOTE_COL[n.type] || "#66ccff";
    g.fillRect(x - 1, 0, 2, hh); g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 9, 4); g.lineTo(x, 8); g.fill();
  }
  // objects
  const tk = Math.max(1, hh / 58), H = map.hit, cy = hh * .45, r = Math.min(11 * tk, hh * .2); // (tk: a taller timeline, Settings → Editor, draws bigger)
  const hi = lastBefore(H, t1, "t"); let lo = hi; while (lo > 0 && H[lo - 1].t > t0 - 30000) lo--;
  g.textAlign = "center"; g.textBaseline = "middle"; g.font = `600 ${Math.round(r * 1.05)}px "Varela Round",sans-serif`;
  for (let i = hi; i >= Math.max(0, lo); i--) {
    const o = H[i]; if (o.end < t0) continue;
    const ns = o.kind === "slider" && EDIT.tlRep && EDIT.tlRep.lid === o.lid ? EDIT.tlRep.n : o.slides; // (its tail being dragged: the new repeat count)
    const sel = EDIT.sel.has(o.lid), off = sel && EDIT.tlDrag ? EDIT.tlDt : 0, x0 = X(o.t + off), x1 = X((ns !== o.slides ? o.t + o.span * ns : o.end) + off), mania = map.mode === 3;
    const col = rgb(mania ? MANIA_COLS[maniaColType(o.col, map.keys || 4)] : palette(o.ci)); // (mania: the column's note colour, no combo numbers)
    if (o.kind !== "circle") {
      g.fillStyle = o.kind === "spinner" ? "rgba(200,200,200,.45)" : col; g.globalAlpha = o.kind === "spinner" ? 1 : .6;
      g.beginPath(); if (g.roundRect) g.roundRect(x0, cy - r, Math.max(0, x1 - x0), r * 2, r); else g.rect(x0, cy - r, x1 - x0, r * 2); g.fill();
      g.globalAlpha = 1;
      if (o.kind === "slider") { let lx = -1e9; for (let k = 1; k <= ns; k++) { const xr = X(o.t + o.span * k + off); if (Math.abs(xr - lx) < 2) continue; lx = xr; g.strokeStyle = "#fff"; g.lineWidth = 1.5 * tk; g.beginPath(); g.arc(xr, cy, r * .6, 0, 7); g.stroke(); } } // (repeats on the same pixel once: an instant Aspire slider has 9000)
    }
    g.fillStyle = col; g.beginPath(); g.arc(x0, cy, r, 0, 7); g.fill();
    g.lineWidth = (sel ? 3 : 1.5) * tk; g.strokeStyle = sel ? "#66ccff" : "#fff"; g.stroke();
    if (o.num && !mania) { g.fillStyle = "#fff"; g.fillText(o.num, x0, cy + .5); }
    const marks = (x, hs, n) => { let yy = cy + r + 4 * tk; for (const [bit, c] of [[2, "#66ccff"], [4, "#ffd84a"], [8, "#6be38a"]]) if (hs & bit) { g.fillStyle = c; g.fillRect(x - 3 * tk, yy, 6 * tk, 3 * tk); yy += 4 * tk; }
      if (n) { g.fillStyle = "#cfc6de"; g.font = `600 ${Math.round(8 * tk)}px sans-serif`; g.fillText("NSD"[n - 1], x, cy - r - 5 * tk); g.font = `600 ${Math.round(r * 1.05)}px "Varela Round",sans-serif`; } };
    if (o.kind === "slider") { let lx = -1e9; for (let k = 0; k <= o.slides; k++) { const xe = X(o.t + o.span * k + off); if (Math.abs(xe - lx) < 2 && k < o.slides) continue; lx = xe; marks(xe, edgeHs(o, k), (o.edgeSets[k] || [])[0] || (o.samp || {}).n);
      if (sel && EDIT.edgeFor === o.lid && EDIT.edge === k) { g.strokeStyle = "#ffd84a"; g.lineWidth = 2; g.beginPath(); g.arc(xe, cy, r + 3, 0, 7); g.stroke(); } } }
    else marks(x0, o.hs, (o.samp || {}).n);
    if (ns !== o.slides || EDIT.tlRep && EDIT.tlRep.lid === o.lid) { // dragging the tail: how many times it goes back and forth
      g.fillStyle = "#ffd84a"; g.font = `700 ${Math.round(10 * tk)}px sans-serif`; g.fillText(ns - 1 ? tr("{n} reverse", { n: ns - 1 }) : tr("no reverse"), x1, cy - r - 6 * tk); g.font = `600 ${Math.round(r * 1.05)}px "Varela Round",sans-serif`;
    }
  }
  if (EDIT.anchor && EDIT.anchor.moved) { // a placed slider being reshaped: its new end, next to the old one
    const A2 = EDIT.anchor, ss = A2.o, plan = sliderPlan(Object.assign(A2.pts.slice(), { t: ss.t }), { curve: ss.curve, slides: ss.slides, except: ss.lid });
    if (plan && plan.ok) {
      const xs = X(ss.t), xe = X(plan.end), col = plan.free ? "#6be38a" : "#ff4d5e";
      g.globalAlpha = .45; g.fillStyle = col; g.beginPath(); if (g.roundRect) g.roundRect(xs, cy - r, Math.max(0, xe - xs), r * 2, r); else g.rect(xs, cy - r, xe - xs, r * 2); g.fill();
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 2; g.setLineDash([4, 3]); g.beginPath(); g.arc(xe, cy, r, 0, 7); g.stroke(); g.setLineDash([]);
      g.fillStyle = col; g.fillRect(xe - 1, 0, 2, hh);
      g.font = "600 10px sans-serif"; g.fillText(beatFrac(plan.end - plan.t, plan.beat), (xs + xe) / 2, cy - r - 6); g.font = `600 ${Math.round(r * 1.05)}px "Varela Round",sans-serif`;
    }
  }
  if (EDIT.sliderPts) { // the slider being placed: from its start to where it would end right now
    const plan = placePlan(), xs = X(EDIT.sliderPts.t);
    const col = !plan || plan.free ? "#6be38a" : "#ff4d5e";
    if (plan && plan.ok) {
      const xe = X(plan.end);
      g.globalAlpha = .45; g.fillStyle = col; g.beginPath(); if (g.roundRect) g.roundRect(xs, cy - r, Math.max(0, xe - xs), r * 2, r); else g.rect(xs, cy - r, xe - xs, r * 2); g.fill();
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 2; g.setLineDash([4, 3]); g.beginPath(); g.arc(xe, cy, r, 0, 7); g.stroke(); g.setLineDash([]);
      g.fillStyle = col; g.fillRect(xe - 1, 0, 2, hh);
      g.font = "600 10px sans-serif"; g.fillText(beatFrac(plan.end - plan.t, plan.beat), (xs + xe) / 2, cy - r - 6); g.font = `600 ${Math.round(r * 1.05)}px "Varela Round",sans-serif`;
    }
    g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.arc(xs, cy, r, 0, 7); g.stroke();
  }
  annDrawTimeline(g, X, t0, t1, hh);
  if (COLLAB.on) collabDrawTimeline(g, X, t0, t1, hh);
  if (LIVE.on) liveDrawTimeline(g, X, t0, t1, hh);
  // playhead
  g.fillStyle = "#ff66aa"; g.fillRect(c - 1, 0, 2, hh);
  g.beginPath(); g.moveTo(c - 6, 0); g.lineTo(c + 6, 0); g.lineTo(c, 7); g.fill();
}
// timeline input: drag empty space to scrub, drag a selected object to move it in time, pinch/ctrl+wheel to zoom
const tlPtrs = new Map();
let tlAct = null;
function tlHit(xCss) {
  const t = A.cur(), w = TL.clientWidth, sc = EDIT.tlScaleV, X = ms => w / 2 + (ms - t) * sc, r = 12;
  let best = null;
  for (const o of map.hit) {
    const x0 = X(o.t), x1 = X(o.end);
    if (x1 < -r) continue; if (x0 > w + r) break;
    if (Math.abs(xCss - x0) <= r || (o.kind !== "circle" && xCss >= x0 && xCss <= x1)) best = o;
  }
  return best;
}
// the timeline at the top can be locked so a stray touch or drag doesn't move the song or objects (scroll still works)
function tlLock(on) {
  S.tlLock = !!on; save();
  const b = $("tlLock"); if (b) { b.classList.toggle("on", S.tlLock); b.setAttribute("aria-pressed", S.tlLock); b.innerHTML = S.tlLock ? '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>'; }
  TL.classList.toggle("locked", S.tlLock);
}
$("tlLock").onclick = () => { tlLock(!S.tlLock); toast(S.tlLock ? tr("Timeline locked: dragging it does nothing (scroll still moves) • Shift+L") : tr("Timeline unlocked"), 1800); };
TL.addEventListener("pointerdown", e => {
  if (!map || e.button === 2) return;
  if (S.tlLock) { if (!tlLock.told) { tlLock.told = true; toast(tr("The timeline is locked. Press the lock button (or Shift+L) to unlock it."), 2500); } return; }
  TL.setPointerCapture(e.pointerId); tlPtrs.set(e.pointerId, e.clientX);
  if (tlPtrs.size === 2) { const [a, b] = [...tlPtrs.values()]; tlAct = { pinch: Math.abs(a - b) || 1, scale: EDIT.tlScale }; return; }
  const xr = e.clientX - TL.getBoundingClientRect().left, yr = e.clientY - TL.getBoundingClientRect().top, multi = e.shiftKey || e.ctrlKey || e.metaKey;
  if (yr < 14) { const t0 = A.cur(), w = TL.clientWidth, nt = notesCached().find(n => Math.abs(w / 2 + (n.t - t0) * EDIT.tlScaleV - xr) < 9); if (nt) { seekTo(nt.t); openQuick(nt.t, [], nt); tlPtrs.delete(e.pointerId); return; } }
  // a selected slider's tail comes first (the next object often starts right where it ends)
  const tailOf = !multi && can("editor") && map.hit.find(q => q.kind === "slider" && EDIT.sel.has(q.lid) && Math.abs(TL.clientWidth / 2 + (q.end - A.cur()) * EDIT.tlScaleV - xr) < 9);
  if (tailOf) { EDIT.edgeFor = tailOf.lid; EDIT.edge = tailOf.slides; tlAct = { tail: tailOf, x: e.clientX }; EDIT.tlRep = { lid: tailOf.lid, n: tailOf.slides }; updateEdUI(); dirty = true; return; }
  const o = tlHit(xr);
  if (o) {
    if (multi) { EDIT.sel.has(o.lid) ? EDIT.sel.delete(o.lid) : EDIT.sel.add(o.lid); }
    else if (!EDIT.sel.has(o.lid)) EDIT.sel = new Set([o.lid]);
    if (o.kind === "slider" && !multi) { const t0 = A.cur(), w = TL.clientWidth, sc = EDIT.tlScaleV; let k = null;
      let bd = 9; for (let j = 0; j <= o.slides; j++) { const d = Math.abs(w / 2 + (o.t + o.span * j - t0) * sc - xr); if (d < bd) { bd = d; k = j; } } // (the nearest edge)
      EDIT.edgeFor = o.lid; EDIT.edge = k;
      if (k === o.slides && can("editor")) { tlAct = { tail: o, x: e.clientX }; EDIT.tlRep = { lid: o.lid, n: o.slides }; updateEdUI(); dirty = true; return; } } // (the tail: drag it to add or remove reverses, like osu!)
    tlAct = { obj: o, x: e.clientX }; updateEdUI();
  } else {
    if (isPlaying()) pausePlayback();
    tlAct = { scrub: true, x: e.clientX, t: A.cur(), moved: false };
  }
  dirty = true;
});
TL.addEventListener("pointermove", e => {
  if (!tlAct && e.pointerType === "mouse" && map && !S.tlLock) { // over a slider's tail: it can be dragged (reverses)
    const xr = e.clientX - TL.getBoundingClientRect().left, o = tlHit(xr);
    TL.style.cursor = o && o.kind === "slider" && Math.abs(TL.clientWidth / 2 + (o.end - A.cur()) * EDIT.tlScaleV - xr) < 7 ? "ew-resize" : "";
  }
  if (!tlAct || !tlPtrs.has(e.pointerId)) return;
  tlPtrs.set(e.pointerId, e.clientX);
  if (tlAct.pinch) { if (tlPtrs.size === 2) { const [a, b] = [...tlPtrs.values()]; EDIT.tlScale = EDIT.tlScaleV = Math.max(.03, Math.min(2, tlAct.scale * (Math.abs(a - b) || 1) / tlAct.pinch)); S.tlZoom = EDIT.tlScale; save(); dirty = true; } return; }
  const dx = e.clientX - tlAct.x;
  if (tlAct.scrub) { if (Math.abs(dx) > 2) tlAct.moved = true; seekTo(tlAct.t - dx / EDIT.tlScaleV); return; }
  if (tlAct.tail) { // the slider's tail: the nearest whole number of slides to where it's dragged
    const o = tlAct.tail, xr = e.clientX - TL.getBoundingClientRect().left, t = A.cur() + (xr - TL.clientWidth / 2) / EDIT.tlScaleV;
    if (Math.abs(dx) > 3) tlAct.moved = true;
    const n = Math.max(1, Math.min(500, Math.round((t - o.t) / o.span))); if (n !== EDIT.tlRep.n) { EDIT.tlRep.n = n; dirty = true; }
    return;
  }
  if (tlAct.obj && Math.abs(dx) > 4) {
    const o = tlAct.obj, nt = snapTime(o.t + dx / EDIT.tlScaleV);
    EDIT.tlDrag = true; EDIT.tlDt = nt - o.t; dirty = true;
  }
});
function tlEnd(e) {
  tlPtrs.delete(e.pointerId);
  if (!tlAct) return;
  if (tlAct.tail) { const o = tlAct.tail, n = EDIT.tlRep ? EDIT.tlRep.n : o.slides; EDIT.tlRep = null; if (n !== o.slides) sliderSetRepeats(o, n); else if (!tlAct.moved) seekTo(o.end); }
  else if (tlAct.obj && EDIT.tlDrag) { const dt = EDIT.tlDt; EDIT.tlDrag = false; EDIT.tlDt = 0; shiftSel(dt); }
  else if (tlAct.obj) seekTo(tlAct.obj.t);
  else if (tlAct.scrub && !tlAct.moved) { // tap on the timeline: jump there (snapped)
    const xr = e.clientX - TL.getBoundingClientRect().left;
    seekTo(snapTime(A.cur() + (xr - TL.clientWidth / 2) / EDIT.tlScaleV));
  }
  if (!tlPtrs.size) tlAct = null;
  dirty = true;
}
TL.addEventListener("pointerup", tlEnd);
TL.addEventListener("pointercancel", tlEnd);
TL.addEventListener("wheel", e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey || e.altKey) zoomTl(e.deltaY > 0 ? .85 : 1.18);
  else stepSnap(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
}, { passive: false });

// ---------- export ----------
// the open diff as .osu text: the original file with [HitObjects], [TimingPoints], bookmarks and the setup keys replaced
function sectionRange(lines, name) {
  const i = lines.findIndex(l => l.trim() === "[" + name + "]"); if (i < 0) return null;
  let end = lines.length; for (let j = i + 1; j < lines.length; j++) if (/^\[.+\]$/.test(lines[j].trim())) { end = j; break; }
  while (end > i + 1 && !lines[end - 1].trim()) end--;
  return [i, end];
}
function putSection(lines, name, body, before) { // replace the body of a section (or add the section)
  const r = sectionRange(lines, name);
  if (r) { lines.splice(r[0] + 1, r[1] - r[0] - 1, ...body); return; }
  let at = lines.length; const b = before && sectionRange(lines, before); if (b) at = b[0];
  lines.splice(at, 0, "[" + name + "]", ...body, "");
}
function putKeys(lines, name, obj, sep) { // Key: value lines, keeping the original spacing and order
  const r = sectionRange(lines, name); if (!r) { putSection(lines, name, Object.keys(obj).map(k => k + sep + obj[k])); return; }
  const seen = new Set();
  for (let j = r[0] + 1; j < r[1]; j++) {
    const m = lines[j].match(/^([^:\/][^:]*?)(\s*:\s*)(.*)$/); if (!m) continue;
    const k = m[1].trim(); seen.add(k);
    if (k in obj && String(obj[k]) !== m[3].trim()) lines[j] = m[1] + m[2] + obj[k];
  }
  const add = Object.keys(obj).filter(k => !seen.has(k)).map(k => k + sep + obj[k]);
  if (add.length) lines.splice(r[1], 0, ...add);
}
function editedText() {
  const src = osuFiles[curDiff].text;
  const lines = src.split(/\r?\n/);
  putKeys(lines, "General", map.general, ": ");
  const ed = { ...map.editor }; if (map.bookmarks.length) ed.Bookmarks = map.bookmarks.map(Math.round).join(","); else delete ed.Bookmarks;
  const er = sectionRange(lines, "Editor");
  if (er) for (let j = er[1] - 1; j > er[0]; j--) if (/^Bookmarks\s*:/.test(lines[j]) && !map.bookmarks.length) lines.splice(j, 1);
  if (er || map.bookmarks.length) { if (!er) putSection(lines, "Editor", [], "Metadata"); putKeys(lines, "Editor", ed, ": "); }
  putKeys(lines, "Metadata", map.meta, ":");
  putKeys(lines, "Difficulty", map.diff, ":");
  putSection(lines, "TimingPoints", map.timing.map(timingLine), "HitObjects");
  const cols = Object.keys(map.colourKV || {}).map(k => k + " : " + map.colourKV[k]), cr = sectionRange(lines, "Colours");
  if (cols.length) putSection(lines, "Colours", cols, "HitObjects");
  else if (cr) { let e = cr[1]; while (e < lines.length && !lines[e].trim()) e++; lines.splice(cr[0], e - cr[0]); }
  putSection(lines, "HitObjects", map.lines.map(L => L.s));
  if (map.breaks0 != null && JSON.stringify(map.breaks) !== map.breaks0) putBreaks(lines);
  return lines.join("\r\n").trimEnd() + "\r\n";
}
function putBreaks(lines) { // [Events] break lines from map.breaks (only after they were moved: the rest of [Events] stays as it was)
  const er = sectionRange(lines, "Events"); if (!er) return;
  let at = -1;
  for (let j = er[1] - 1; j > er[0]; j--) { const p = lines[j].trim().split(","); if ((p[0] === "2" || p[0] === "Break") && p.length >= 3) { lines.splice(j, 1); at = j; } }
  if (at < 0) { at = er[0] + 1; for (let j = er[0] + 1; j < lines.length && !/^\[/.test(lines[j].trim()); j++) if (/^\/\/\s*Break Periods/i.test(lines[j].trim())) { at = j + 1; break; } }
  lines.splice(at, 0, ...map.breaks.map(([a, b]) => `2,${Math.round(a)},${Math.round(b)}`));
}
const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 150);
function exportOsu() {
  if (!map) return;
  const M = map.meta, name = safeName(`${M.Artist} - ${M.Title} (${M.Creator}) [${M.Version}].osu`);
  downloadBlob(new Blob([editedText()], { type: "text/plain" }), name);
  toast(tr("Downloaded the .osu (you can replace the old file in your Songs folder)"));
  draftSchedule();
}
// the package as an .osz (every diff with the edits kept in memory); also used to export it to Google Drive
async function buildOsz() {
  const Z = await loadJSZip(), zip = new Z(), own = new Set(osuFiles.map(o => o.path));
  for (const k in files) { const f = files[k]; if (!own.has(f.name)) zip.file(f.name, f.async("uint8array")); }
  osuFiles.forEach((o, i) => zip.file(o.path, i === curDiff ? editedText() : o.text));
  const M = map.meta;
  return { blob: await zip.generateAsync({ type: "blob", compression: "STORE" }), name: safeName(`${+setId > 0 ? setId : ""} ${M.Artist} - ${M.Title}`.trim() + ".osz") };
}
async function exportOsz() {
  if (!map) return;
  showLoading(tr("Building the .osz…"), -1);
  try {
    const { blob, name } = await buildOsz();
    downloadBlob(blob, name);
    toast(tr("Downloaded the .osz"));
    EDIT.changed = false; osuFiles.forEach(o => { o.created = false; if (o.edited) o.edited = false; });
    draftSchedule();
  } catch (e) { toast(tr("Couldn't build the .osz: {err}", { err: e.message })); }
  hideLoading();
}

// ---------- right-click menus (like osu!lazer's editor) ----------
// Right-click an object: it gets selected and a menu offers everything for the selection (new combo, sounds, banks,
// slider options, transform, clipboard, delete). Right-click a slider's control point: point options.
// Right-click empty space: paste / select all / timing / bookmark / note. Shift+right-click an object deletes it (lazer).
// Right-click while placing a slider finishes it. Long-press does the same on touch screens.
const CTX = { el: null, stack: [] };
function ctxClose() { for (const m of CTX.stack) m.remove(); CTX.stack = []; }
function ctxMenu(x, y, items, level = 0, anchor = null) {
  while (CTX.stack.length > level) CTX.stack.pop().remove();
  const m = h("div", "ctxmenu"); m.setAttribute("role", "menu");
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.append(h("div", "ctxsep")); continue; }
    if (it.head) { m.append(h("div", "ctxhead", it.head)); continue; }
    const b = h("button", "ctxitem" + (it.danger ? " danger" : "")); b.setAttribute("role", "menuitem"); b.disabled = !!it.disabled;
    const mark = h("span", "ctxmark", it.checked === true ? "✓" : it.checked === "mixed" ? "–" : "");
    b.append(mark, h("span", "ctxlabel", it.label), h("span", "ctxkey", it.sub ? "▸" : it.key || ""));
    if (it.sub) {
      const open = () => { const r = b.getBoundingClientRect(); ctxMenu(r.right - 4, r.top - 5, it.sub(), level + 1, r); b.classList.add("open"); m.querySelectorAll(".ctxitem.open").forEach(x => x !== b && x.classList.remove("open")); };
      b.onmouseenter = () => { clearTimeout(m.hov); m.hov = setTimeout(open, 120); };
      b.onclick = e => { e.stopPropagation(); open(); };
    } else {
      b.onmouseenter = () => { clearTimeout(m.hov); m.hov = setTimeout(() => { while (CTX.stack.length > level + 1) CTX.stack.pop().remove(); m.querySelectorAll(".ctxitem.open").forEach(x => x.classList.remove("open")); }, 120); };
      b.onclick = e => { e.stopPropagation(); ctxClose(); it.action(); };
    }
    m.append(b);
  }
  document.body.append(m); CTX.stack.push(m);
  const w = m.offsetWidth, hh = m.offsetHeight, vw = innerWidth, vh = innerHeight;
  let left = x, top = y;
  if (left + w > vw - 6) left = anchor ? anchor.left - w + 4 : vw - w - 6;
  if (top + hh > vh - 6) top = Math.max(6, vh - hh - 6);
  m.style.left = Math.max(6, left) + "px"; m.style.top = Math.max(6, top) + "px";
  if (!level) { const f = m.querySelector(".ctxitem:not(:disabled)"); f && f.focus({ preventScroll: true }); }
  return m;
}
document.addEventListener("pointerdown", e => { if (CTX.stack.length && !e.target.closest(".ctxmenu")) ctxClose(); }, true);
addEventListener("keydown", e => {
  if (!CTX.stack.length) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ctxClose(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); e.stopPropagation();
    const m = CTX.stack[CTX.stack.length - 1], its = [...m.querySelectorAll(".ctxitem:not(:disabled)")], i = its.indexOf(document.activeElement);
    its[(i + (e.key === "ArrowDown" ? 1 : -1) + its.length) % its.length].focus();
  } else if (e.key === "ArrowRight" && document.activeElement.closest(".ctxmenu")) { e.preventDefault(); e.stopPropagation(); document.activeElement.click(); const s = CTX.stack[CTX.stack.length - 1].querySelector(".ctxitem:not(:disabled)"); s && s.focus(); }
  else if (e.key === "ArrowLeft" && CTX.stack.length > 1) { e.preventDefault(); e.stopPropagation(); CTX.stack.pop().remove(); const m = CTX.stack[CTX.stack.length - 1], o = m.querySelector(".ctxitem.open"); o && (o.classList.remove("open"), o.focus()); }
  else if (e.key === "Enter" || e.key === " ") { if (document.activeElement.closest(".ctxmenu")) { e.preventDefault(); e.stopPropagation(); document.activeElement.click(); } }
  else e.stopPropagation(); // the menu has the keyboard while it's open
}, true);
addEventListener("resize", ctxClose);
addEventListener("blur", ctxClose);

const tri = (objs, f) => { const n = objs.filter(f).length; return n === objs.length && n ? true : n ? "mixed" : false; };
function selectionMenu() { // everything the current selection can do
  const objs = selObjs(), units = hsUnits(), n = objs.length, one = n === 1 ? objs[0] : null, notSpin = objs.filter(o => o.kind !== "spinner");
  const bankSub = which => () => SAMPLE_SETS.map(([v, l]) => ({ label: tr(l), checked: tri(units, u => unitBank(u, which) === v), action: () => { if (units.every(u => unitBank(u, which) === v)) return; setBankOf(which, v); } }));
  const items = [
    { head: n === 1 ? `${tsFor(objs).replace(/ - $/, "")} · ${tr(one.kind)}` : tr("{n} objects", { n }) },
    notSpin.length ? { label: tr("New combo"), key: "Q", checked: tri(notSpin, o => o.type & 4), action: toggleNC } : null,
    { label: tr("Sound"), sub: () => [2, 4, 8].map(bit => ({ label: tr(HS_NAME[bit]), key: { 2: "W", 4: "E", 8: "R" }[bit], checked: tri(units, u => unitHs(u) & bit), action: () => toggleHS(bit) })) },
    { label: tr("Sample set"), sub: bankSub(0) },
    { label: tr("Addition bank"), sub: bankSub(1) },
    { label: tr("Hitsounds…"), key: "H", action: () => openDlg("hitsound") },
  ];
  if (one && one.kind === "slider") {
    items.push({ sep: 1 }, { label: tr("Slider"), sub: () => [
      { label: tr("Curve type"), sub: () => [["B", "Bezier"], ["P", "Perfect circle"], ["C", "Catmull"], ["L", "Linear"]].map(([c, l]) => ({ label: tr(l), checked: one.curve === c, disabled: (c === "P" && one.cps.length !== 3) || (c === "L" && one.cps.length !== 2), action: () => { if (one.curve !== c) sliderSetShape(one, one.cps.map(p => p.slice()), "Slider curve type", c); } })) },
      { label: tr("Add a control point here"), key: "Ctrl+click", disabled: !EDIT.ctxPt || EDIT.sel.size !== 1, action: () => sliderAddPointAt(one, EDIT.ctxPt[0], EDIT.ctxPt[1]) },
      { label: tr("Add a repeat"), action: () => sliderRepeats(1) },
      { label: tr("Remove a repeat"), disabled: one.slides < 2, action: () => sliderRepeats(-1) },
      { label: tr("Convert to stream…"), key: "Ctrl+Shift+F", action: () => openDlg("stream") },
      { label: tr("Edit hitsounds of…"), sub: () => [{ label: tr("Whole slider"), checked: EDIT.edgeFor !== one.lid || EDIT.edge == null, action: () => { pickEdge(one, null); openDlg("hitsound"); } },
        ...Array.from({ length: one.slides + 1 }, (_, k) => ({ label: edgeName(one, k), checked: EDIT.edgeFor === one.lid && EDIT.edge === k, action: () => { pickEdge(one, k); openDlg("hitsound"); } }))] },
    ] });
  }
  if (notSpin.length) items.push({ sep: 1 }, { label: tr("Transform"), sub: () => [
    { label: tr("Flip horizontally"), key: "Ctrl+H", action: () => flipSel(true) },
    { label: tr("Flip vertically"), key: "Ctrl+J", action: () => flipSel(false) },
    { label: tr("Rotate 90° clockwise"), action: () => rotateSel(90) },
    { label: tr("Rotate 90° counter-clockwise"), action: () => rotateSel(-90) },
    { label: tr("Rotate / scale…"), key: "Ctrl+Shift+R", action: () => openDlg("transform") },
    { label: tr("Reverse"), key: "Ctrl+G", disabled: n < 2, action: reverseSel },
  ] });
  items.push({ sep: 1 },
    { label: tr("Cut"), key: "Ctrl+X", action: cutSel },
    { label: tr("Copy"), key: "Ctrl+C", action: copySel },
    { label: tr("Paste"), key: "Ctrl+V", disabled: !EDIT.clip, action: pasteClip },
    { label: tr("Clone"), key: "Ctrl+D", action: cloneSel },
    { sep: 1 },
    { label: tr("Copy timestamp"), action: async () => { const s = tsFor(objs).replace(/ - $/, ""); toast(await copyText(s) ? tr("Copied {s}", { s }) : s); } },
    { label: tr("+ Note"), key: "N", action: () => $("edNote").click() },
    LIVE.on ? { label: tr("Highlight"), key: "H", action: liveHighlight } : null,
    one && annCanCreate() ? { label: tr("Annotate…"), sub: () => [
      { label: "💬 " + tr("Comment"), action: () => annCreate("comment", one, {}) },
      { label: "◎ " + tr("Highlight"), action: () => annCreate("highlight", one, {}) },
      { label: "➚ " + tr("Arrow (drag it)"), action: () => annSetTool("arrow") }] } : null,
    { sep: 1 },
    { label: tr("Delete"), key: "Del", danger: true, action: deleteSel });
  return items;
}
function pointMenu(ss, ai) {
  const pts = ss.cps, red = (pts[ai + 1] && pts[ai + 1][0] === pts[ai][0] && pts[ai + 1][1] === pts[ai][1]) || (pts[ai - 1] && pts[ai - 1][0] === pts[ai][0] && pts[ai - 1][1] === pts[ai][1]);
  return [{ head: tr("Control point {n}", { n: ai + 1 }) },
    { label: tr("Red anchor (sharp corner)"), key: "Ctrl+click", checked: !!red, action: () => anchorRed(ss, ai) },
    { label: tr("Curve type"), sub: () => [["B", "Bezier"], ["P", "Perfect circle"], ["C", "Catmull"], ["L", "Linear"]].map(([c, l]) => ({ label: tr(l), checked: ss.curve === c, disabled: (c === "P" && pts.length !== 3) || (c === "L" && pts.length !== 2), action: () => sliderSetShape(ss, pts.map(p => p.slice()), "Slider curve type", c) })) },
    { sep: 1 },
    { label: tr("Delete control point"), key: tr("right-click"), danger: true, disabled: pts.length <= 2, action: () => anchorRemove(ss, ai) }];
}
function emptyMenu() {
  const t = snapTime(A.cur());
  return [{ head: fmtMs(t) },
    { label: tr("Paste"), key: "Ctrl+V", disabled: !EDIT.clip, action: pasteClip },
    { label: tr("Select all"), key: "Ctrl+A", disabled: !map.hit.length, action: () => edSelectIds(map.hit.map(o => o.lid)) },
    EDIT.sel.size ? { label: tr("Deselect"), key: "Esc", action: () => edSelectIds([]) } : null,
    { sep: 1 },
    { label: tr("Add a red line here"), key: "Ctrl+P", action: () => openTiming(true) },
    { label: tr("Add a green line here"), key: "Ctrl+Shift+P", action: () => openTiming(false) },
    { label: tr(map.bookmarks.some(b => Math.abs(b - t) < 20) ? "Remove bookmark" : "Add bookmark"), key: "Ctrl+B", action: toggleBookmark },
    { label: tr("+ Note"), key: "N", action: () => $("edNote").click() },
    annCanCreate() ? { label: tr("Annotate…"), sub: () => ["comment", "arrow", "highlight"].map(k => ({ label: `${ANN_ICON[k]} ${tr({ comment: "Comment", arrow: "Arrow", highlight: "Highlight" }[k])}`, action: () => annSetTool(k) })) } : null,
    { sep: 1 },
    { label: tr("Hitsounds for new objects…"), key: "H", action: () => openDlg("hitsound") },
    { label: tr("Polygon circles…"), key: "Ctrl+Shift+D", action: () => openDlg("polygon") }];
}
function cutSel() { if (!copySel()) return; edCommit("Cut", () => { map.lines = map.lines.filter(L => !EDIT.sel.has(L.id)); }); EDIT.sel.clear(); updateEdUI(); }
function cloneSel() { // lazer's Clone: a copy of the selection right after it (one beat snap later)
  const objs = selObjs(); if (!objs.length) return toast(tr("Select objects first"));
  const t0 = objs[0].t, t1 = Math.max(...objs.map(o => o.end)), dt = Math.round(snapTime(t1 + beatInfo(t1).len / S.snap) - t0);
  const lines = objs.filter(o => lineById(o.lid)).map(o => { const p = lineById(o.lid).s.split(","); p[2] = Math.round(+p[2] + dt); if (+p[3] & 8) p[5] = Math.round(+p[5] + dt); if (+p[3] & 128) p[5] = holdShift(p[5], dt); return { s: p.join(","), id: newLineId() }; });
  if (!freeAt(t0 + dt, t1 + dt)) toast(tr("Pasted objects overlap others in time"));
  if (edCommit("Clone", () => map.lines.push(...lines))) { edSelectIds(lines.map(x => x.id)); seekTo(t0 + dt); }
}
function anchorRemove(ss, ai) { const pts = ss.cps.map(p => p.slice()); if (pts.length <= 2) return toast(tr("A slider needs at least 2 points")); pts.splice(ai, 1); sliderSetShape(ss, pts, "Remove slider point"); }
function anchorRed(ss, ai) {
  const pts = ss.cps.map(p => p.slice()), same = (a, b) => b && a[0] === b[0] && a[1] === b[1];
  if (same(pts[ai], pts[ai + 1])) pts.splice(ai + 1, 1); else if (same(pts[ai], pts[ai - 1])) pts.splice(ai, 1); else pts.splice(ai, 0, pts[ai].slice());
  sliderSetShape(ss, pts, "Red anchor", ss.curve === "L" || ss.curve === "P" ? "B" : ss.curve);
}
// touch: our own long-press (iPhone/iPad never send contextmenu; Android's is ignored so it doesn't open twice)
const LP = { timer: 0, x: 0, y: 0, tl: false, last: "mouse", fired: 0 };
function lpStart(e, fromTimeline) {
  LP.last = e.pointerType; clearTimeout(LP.timer);
  if (e.pointerType === "mouse" || e.button === 2 || !EDIT.on || !map) return; // (a pen's barrel button is a right-click, not a long-press)
  LP.x = e.clientX; LP.y = e.clientY; LP.tl = fromTimeline;
  LP.timer = setTimeout(() => {
    LP.timer = 0; LP.fired = performance.now(); if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
    edContext({ clientX: LP.x, clientY: LP.y, shiftKey: false, preventDefault() {}, touch: true }, LP.tl);
  }, 480);
}
function lpMove(e) { if (LP.timer && Math.hypot(e.clientX - LP.x, e.clientY - LP.y) > 10) { clearTimeout(LP.timer); LP.timer = 0; } }
function lpEnd() { clearTimeout(LP.timer); LP.timer = 0; }
for (const [el, tl] of [[cv, false], [TL, true]]) {
  el.addEventListener("pointerdown", e => lpStart(e, tl), true);
  el.addEventListener("pointermove", lpMove, true);
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, lpEnd, true);
}
// "⋯" button in the bottom bar: the same menu, for when there's no right button
$("edMenu").onclick = () => { const r = $("edMenu").getBoundingClientRect(); ctxClose(); ctxMenu(r.left, r.top - 8, EDIT.sel.size ? selectionMenu() : emptyMenu()); const m = CTX.stack[0]; if (m) m.style.top = Math.max(6, r.top - m.offsetHeight - 6) + "px"; };
function edContext(e, fromTimeline) {
  if (!EDIT.on || !map) return;
  e.preventDefault();
  if (!e.touch && LP.last !== "mouse" && LP.last) { // the browser's long-press menu on touch: ours already handles it
    if (LP.last === "touch" || performance.now() - LP.fired < 1000) return;
    lpEnd(); // a pen's barrel button (or right-click) is a real right-click
  }
  pdown = null; EDIT.box = null; EDIT.drag = false; EDIT.anchor = null; tlAct = null; // a long-press started a normal press too
  if (EDIT.sliderPts) { // lazer: right-click ends slider placement, the point under the cursor being the slider's end
    const [x, y] = toOsu(e); EDIT.hoverPt = clampPF(gridSnap(x), gridSnap(y)); finishSlider(placingPts()); return;
  }
  let o = null;
  if (fromTimeline) o = tlHit(e.clientX - TL.getBoundingClientRect().left);
  else {
    const [x, y] = toOsu(e), ss = selSlider();
    if (ss) {
      const ai = anchorAt(ss, x, y);
      if (ai > 0) { if (e.touch) ctxMenu(e.clientX, e.clientY, pointMenu(ss, ai)); else anchorRemove(ss, ai); return; } // osu!stable: right-click removes a point
    }
    o = hitTest(x, y, A.cur());
    EDIT.ctxPt = o && o.kind === "slider" ? [x, y] : null;
    if (o && o.kind === "slider") { const pe = pointAt(o, 1); EDIT.edgeFor = o.lid; EDIT.edge = Math.hypot(x - pe[0], y - pe[1]) <= map.radius && Math.hypot(x - o.x, y - o.y) > map.radius * .5 ? (o.slides % 2 ? o.slides : o.slides - 1) : null; }
  }
  if (o && e.shiftKey) { // lazer: shift+right-click deletes the object under the cursor
    edCommit("Delete objects", () => { map.lines = map.lines.filter(L => L.id !== o.lid); }); EDIT.sel.delete(o.lid); updateEdUI(); return;
  }
  if (o) { if (!EDIT.sel.has(o.lid)) edSelectIds([o.lid]); if (EDIT.tool !== "select") setTool("select"); ctxMenu(e.clientX, e.clientY, selectionMenu()); }
  else if (EDIT.tool !== "select") setTool("select"); // lazer: right-click on nothing leaves the placement tool
  else ctxMenu(e.clientX, e.clientY, emptyMenu());
  dirty = true;
}
cv.addEventListener("contextmenu", e => edContext(e, false));
TL.addEventListener("contextmenu", e => edContext(e, true));

tlLock(!!S.tlLock);

// ---------- the Editor tab of the settings sheet: everything about placing and checking objects in one place ----------
function renderEdSettings() {
  const box = $("edSetBox"); if (!box) return; box.innerHTML = "";
  const card = () => h("div", "card2"), sub = t => h("div", "subh", tr(t));
  const row = (label, el, hint) => { const l = h("label", "row"); l.append(h("span", null, tr(label)), el); return hint ? [l, h("p", "hint", tr(hint))] : [l]; };
  const sel = (opts, v, on) => { const s2 = h("select"); for (const [val, lab] of opts) s2.add(new Option(lab, val)); s2.value = String(v); s2.onchange = () => on(s2.value); return s2; };
  const sw = (label, small, get, set) => {
    const l = h("label", "sw"), t = h("span", "swt"), i = h("input"); i.type = "checkbox"; i.className = "switch"; i.checked = !!get(); i.onchange = () => set(i.checked);
    t.append(h("b", null, tr(label))); if (small) t.append(h("small", null, tr(small))); l.append(t, i); return l;
  };
  const c1 = card();
  c1.append(...row("Beat snap", sel(DIVS.map(d => [d, "1/" + d]), S.snap, v => { S.snap = +v; $("snapSel").value = v; save(); dirty = true; }), "Scroll on the playfield steps through the song by this divisor."),
    ...row("Grid snap", sel(GRIDS.map(g => [g, g ? g + " px" : tr("Off")]), S.grid, v => { S.grid = +v; save(); updateEdUI(); dirty = true; })),
    sw("Distance snap", "New and moved objects keep the spacing that matches the time between them • T", () => S.ds, v => { S.ds = v; save(); updateEdUI(); dirty = true; }),
    ...row("Distance snap multiplier", sel(DS_STEPS.map(x => [x, x.toFixed(1) + "x"]), S.dsMul, v => { S.dsMul = +v; save(); updateEdUI(); dirty = true; }), "Alt+scroll changes it on the playfield."));
  const c2 = card();
  c2.append(sw("Lock the timeline", "Dragging the timeline at the top does nothing, so a stray touch can't move the song or objects. Scrolling still works • Shift+L", () => S.tlLock, v => tlLock(v)),
    ...row("Timeline height", tlHeightCtl(), "Taller = bigger objects, hitsound marks and beat ticks on the timeline, easier to see and grab."));
  const cg = card(), gs = (label, small, k) => sw(label, small, () => S[k], v => { S[k] = v; save(); updateEdUI(); dirty = true; });
  cg.append(sw("Mapping guides", "Everything below at once • Shift+G", () => S.guides, v => setGuides(v)),
    gs("Distance to the previous object", "A line with the spacing in osu!px and the distance snap (e.g. 1.20x) of the selected object", "gLine"),
    gs("Angle", "The angle at the previous object (180° = straight on, 90° = square, 0° = straight back)", "gAngle"),
    gs("While placing", "Distance and angle from the previous object follow the cursor with the Circle and Slider tools", "gPlace"),
    gs("Distance snap rings", "Circles around the previous object while distance snap is on", "gRings"));
  const c3 = card();
  c3.append(sw("Hit markers", "Like osu!'s editor: objects you've passed turn white and fade out where they are, with a ring when each is reached. Off: they play their hit animations like in gameplay", () => S.edHitMarkers !== false, v => { S.edHitMarkers = v; save(); dirty = true; }),
    sw("Flash hitsounds while playing", "The hitsound buttons and the columns in Hitsound Studio light up with each hitsound", () => S.hsFlash !== false, v => { S.hsFlash = v; save(); }),
    sw("Show sample names", "Like osu!'s editor: the name of each sample that plays shows above its object (e.g. soft-hitclap)", () => !!S.edSampleName, v => { S.edSampleName = v; save(); }),
    sw("Stacking", "Objects at the same place are drawn stacked, like in gameplay. Off: each one shows where it really is", () => S.edStack !== false, v => { S.edStack = v; save(); if (map && map.mode !== 3) rebuildHits(map); dirty = true; }),
    sw("Compact top bar", "Modding's menu bar as one thin row (small buttons and tabs), so the timeline and the playfield get more room. Off: the bigger bar", () => S.edCompact === true, v => { S.edCompact = v; save(); applyEdCompact(); }),
    ...row("Playfield size", sel([["game", tr("Same as gameplay")], ["fit", tr("Fit between the bars")]], S.edSize === "fit" ? "fit" : "game", v => { S.edSize = v; save(); bodyCache.clear(); dirty = true; }), "Same as gameplay: objects are the size they are when you play the map on this screen, smaller only when the whole field wouldn't fit between the bars (it never goes off the screen). Fit: the whole field with a margin for circles between the bars."),
    ...row("Background dim", edDimCtl(), "How dark the background is while editing (the preview has its own, under Display)."),
    ...row("Compare ghost opacity", cmpGhostOpacity(), "How strong the other version's outlines are in Compose when Compare's ghost is on."));
  const cv = card(), wait = sw("Wait until I stop editing", "Checks again a moment after your last change instead of after every one, so dragging objects stays smooth", () => S.vfyWait !== false, v => { S.vfyWait = v; save(); });
  const setWait = () => { const i = wait.querySelector("input"); i.disabled = S.vfyAuto === false; wait.classList.toggle("off", i.disabled); };
  cv.append(sw("Check again after edits", "While Verify or the quick verify list is open, the checks run again when you change the map. Off: they only run again when you press ↻ (saves battery on big mapsets)", () => S.vfyAuto !== false, v => { S.vfyAuto = v; save(); setWait(); }), wait);
  setWait();
  const c4 = card(), pre = h("input"), suf = h("input"), ex = h("p", "hint");
  pre.type = suf.type = "text"; pre.value = S.notePrefix; suf.value = S.noteSuffix; pre.placeholder = suf.placeholder = tr("(empty)");
  const showEx = () => { ex.textContent = tr("Example") + ": " + noteLine({ ts: "00:12:345 (1,2)", text: tr("text of the note"), type: "suggestion" }); };
  for (const [i, k] of [[pre, "notePrefix"], [suf, "noteSuffix"]]) { i.oninput = () => { S[k] = i.value; save(); showEx(); }; i.addEventListener("keydown", e => e.stopPropagation()); }
  c4.append(...row("Prefix", pre), ...row("Suffix", suf), ex, h("p", "hint", tr("Copy format (prefix / suffix, may use {diff} {type} {cat})")));
  showEx();
  const more = h("button", "mlink", tr("All keyboard shortcuts →")); more.onclick = () => showSetTab("keys");
  const go = (t, l) => { const b = h("button", "mlink", tr(l)); b.onclick = () => showSetTab(t); return b; };
  const elsewhere = h("p", "hint setwhere"); elsewhere.append(tr("Also:") + " ", go("audio", "Audio"), " " + tr("(volume, hitsounds, speed, metronome, sync)") + " · ", go("display", "Display"),
    " " + tr("(snaking sliders, slider ends, timing overlay, storyboard)") + " · ", go("skin", "Skin"), " · ", go("general", "General"), " " + tr("(language)"));
  box.append(sub("Placing objects"), c1, sub("Timeline"), c2, sub("Mapping guides"), cg, sub("While editing"), c3, sub("Verify"), cv, sub("Mod notes"), c4, more, elsewhere);
}

// Wireless / Bluetooth headphones (Settings → Audio → Sync): hitsounds and the song stay together (audio.js); a nudge if
// they still don't line up
function btSettings() {
  const wrap = h("div", "btset"), nud = h("div", "btnud"), rng = h("input"), out = h("output"), test = h("button", "btn ghost sm", tr("Test with the song"));
  rng.type = "range"; rng.min = -200; rng.max = 200; rng.step = 5; rng.value = +S.hsDelay || 0;
  const show = () => { const v = +rng.value; out.textContent = (v > 0 ? "+" : "") + v + " ms"; };
  rng.oninput = () => { S.hsDelay = +rng.value; show(); save(); resetSched(); stopPending(); };
  test.onclick = () => { closeSheet(); if (map && !isPlaying()) togglePlay(); };
  const lab = h("label", "row"); lab.append(h("span", null, tr("Hitsound timing")), rng, out); show();
  nud.append(lab, h("p", "hint", tr("Only if hitsounds still sound early or late against the song: − plays them earlier, + later.")), test);
  nud.hidden = !S.btMode;
  const l = h("label", "sw"), t = h("span", "swt"), i = h("input"); i.type = "checkbox"; i.className = "switch"; i.checked = !!S.btMode;
  t.append(h("b", null, tr("Wireless / Bluetooth mode")), h("small", null, tr("Hear hitsounds together with the song on wireless headphones or speakers: a steadier sound output, hitsounds queued ahead on the song's own clock, and big songs played the same way as the hitsounds")));
  l.append(t, i);
  i.onchange = () => { setBtMode(i.checked); nud.hidden = !i.checked; toast(i.checked ? tr("Wireless mode on") : tr("Wireless mode off"), 1500); };
  wrap.append(l, nud);
  return [wrap];
}

// double-clicks in the editor are for the app: stop the browser from selecting words (or everything) around them
const edTextOK = el => !!(el && el.closest && el.closest("input,textarea,select,[contenteditable],.md,pre,code,.selectable"));
$("player").addEventListener("mousedown", e => { if (e.detail > 1 && !edTextOK(e.target)) e.preventDefault(); });
document.addEventListener("selectstart", e => {
  const el = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
  if (!UI.player.hidden && el && el.closest && el.closest("#player, .sheet, .ctxmenu") && !edTextOK(el)) e.preventDefault();
});
