"use strict";
// ============ osu!mania editor: place, select and move notes and hold notes (like osu!lazer's mania composer) ============
// Note tool (2): click a column, a note at the snapped time under the pointer (lazer NotePlacementBlueprint).
// Hold tool (3): press and drag up or down, the hold note spans both snapped times (HoldNotePlacementBlueprint; a hold
// note needs a length). Select tool: click / Shift+click, drag empty space for a box, drag selected notes to move them
// between columns and in time (snapped). Notes are written like lazer's encoder: x = floor((column + 0.5) × 512 / keys).
const isMania = () => !!(map && map.mode === 3);
const MED = { hover: null, hold: null, drag: null, box: null };
function maniaPos(e) { const [x, y] = toOsu(e); return [x + 64, y + 56]; } // the 640×480 screen (drawMania)
function maniaAt(fx, fy) {
  const L = maniaLayout(map.keys || 4), col = Math.floor((fx - L.x0) / L.colW);
  // lazer: the time is taken at the middle of a note's box, snapped to the beat divisor
  const t = snapTime(maniaTimeAtY(fy + L.noteH / 2, A.cur(), L));
  return { L, col, t, inside: col >= 0 && col < (map.keys || 4) };
}
function maniaFree(col, t, end = t, except) {
  return !map.hit.some(o => o.col === col && o.lid !== except && t <= o.end + 1 && end >= o.t - 1);
}
function maniaHitObj(fx, fy) {
  const { L, col } = maniaAt(fx, fy), pts = maniaScrollPoints(map), now = A.cur();
  for (let i = map.hit.length - 1; i >= 0; i--) {
    const o = map.hit[i]; if (o.col !== col) continue;
    const y0 = maniaY(o.t, now, L, pts), y1 = o.kind === "hold" ? maniaY(o.end, now, L, pts) : y0;
    if (fy <= y0 + 3 && fy >= y1 - L.noteH - 3) return o;
  }
  return null;
}
function maniaLine(col, t, end) {
  const ph = placeHS(), x = maniaX(col, map.keys || 4);
  return end > t ? `${x},192,${t},128,${ph.hs},${end}:${ph.s}` : `${x},192,${t},1,${ph.hs},${ph.s}`;
}
function maniaDown(e) {
  const [fx, fy] = maniaPos(e), a = maniaAt(fx, fy);
  if (EDIT.tool === "circle" || EDIT.tool === "slider") {
    if (!a.inside) return;
    if (EDIT.tool === "circle") {
      if (!maniaFree(a.col, a.t)) return toast(tr("There's already a note here"));
      addLine("Place note", maniaLine(a.col, a.t)); return;
    }
    MED.hold = { col: a.col, t0: a.t, t1: a.t }; cv.setPointerCapture(e.pointerId); dirty = true; return;
  }
  // select
  const o = maniaHitObj(fx, fy);
  if (o) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) { const s = new Set(EDIT.sel); s.has(o.lid) ? s.delete(o.lid) : s.add(o.lid); EDIT.sel = s; }
    else if (!EDIT.sel.has(o.lid)) EDIT.sel = new Set([o.lid]);
    MED.drag = { col: a.col, t: a.t, dc: 0, dt: 0, moved: false };
  } else {
    MED.box = { x0: fx, y0: fy, x1: fx, y1: fy, base: e.shiftKey ? new Set(EDIT.sel) : new Set() };
    if (!e.shiftKey) EDIT.sel = new Set();
  }
  cv.setPointerCapture(e.pointerId); updateEdUI(); dirty = true;
}
function maniaMove(e) {
  const [fx, fy] = maniaPos(e), a = maniaAt(fx, fy);
  if (MED.hold) { MED.hold.t1 = a.t; dirty = true; return; }
  if (MED.drag && e.buttons) {
    const D = MED.drag; D.dc = a.col - D.col; D.dt = a.t - D.t;
    if (D.dc || D.dt) { D.moved = true; EDIT.drag = true; EDIT.mdrag = { dc: D.dc, dt: D.dt }; }
    dirty = true; return;
  }
  if (MED.box && e.buttons) {
    const B = MED.box; B.x1 = fx; B.y1 = fy;
    const L = maniaLayout(map.keys || 4), c0 = Math.floor((Math.min(B.x0, B.x1) - L.x0) / L.colW), c1 = Math.floor((Math.max(B.x0, B.x1) - L.x0) / L.colW);
    const now = A.cur(), ta = maniaTimeAtY(Math.max(B.y0, B.y1), now, L), tb = maniaTimeAtY(Math.min(B.y0, B.y1), now, L), s = new Set(B.base);
    for (const o of map.hit) if (o.col >= c0 && o.col <= c1 && o.end >= ta && o.t <= tb) s.add(o.lid);
    EDIT.sel = s; updateEdUI(); dirty = true; return;
  }
  MED.hover = (EDIT.tool === "circle" || EDIT.tool === "slider") && a.inside ? { col: a.col, t: a.t } : null; dirty = true;
}
function maniaUp() {
  if (MED.hold) {
    const H = MED.hold; MED.hold = null; dirty = true;
    const t = Math.min(H.t0, H.t1), end = Math.max(H.t0, H.t1);
    if (end <= t) { toast(tr("Drag up or down to give the hold note a length")); return true; }
    if (!maniaFree(H.col, t, end)) { toast(tr("This hold note overlaps another note in its column")); return true; }
    addLine("Place hold note", maniaLine(H.col, t, end)); return true;
  }
  if (MED.drag) {
    const D = MED.drag; MED.drag = null; EDIT.drag = false; EDIT.mdrag = null; dirty = true;
    if (D.moved) maniaMoveSel(D.dc, D.dt);
    return true;
  }
  if (MED.box) { MED.box = null; dirty = true; return true; }
  return false;
}
// move the selection by whole columns and a (snapped) time, as one undo step; refused if notes would overlap
function maniaMoveSel(dc, dt) {
  const keys = map.keys || 4, objs = selObjs();
  if (!objs.length || (!dc && !dt)) return;
  if (objs.some(o => o.col + dc < 0 || o.col + dc >= keys)) return toast(tr("That would move notes off the stage"));
  const ids = new Set(objs.map(o => o.lid));
  for (const o of objs) if (map.hit.some(x => !ids.has(x.lid) && x.col === o.col + dc && o.t + dt <= x.end + 1 && o.end + dt >= x.t - 1)) return toast(tr("Notes would overlap there"));
  edCommit("Move notes", () => editLines((p, type) => {
    const col = maniaCol(+p[0], keys) + dc; p[0] = maniaX(col, keys); p[2] = Math.round(+p[2] + dt);
    if (type & 128) p[5] = holdShift(p[5], dt);
  }));
}
// lazer's Ctrl+H for mania: mirror the selected notes across the stage
function maniaFlip() {
  const keys = map.keys || 4; if (!EDIT.sel.size) return;
  edCommit("Flip notes", () => editLines(p => { p[0] = maniaX(keys - 1 - maniaCol(+p[0], keys), keys); }));
}
// drawn by drawMania (editor): the note about to be placed, the hold being dragged, the selection box
function edDrawMania(t, L) {
  const pts = maniaScrollPoints(map), keys = map.keys || 4;
  const ghost = (col, t0, t1) => {
    const x = L.x0 + col * L.colW, y0 = maniaY(t0, t, L, pts), c = MANIA_COLS[maniaColType(col, keys)];
    ctx.globalAlpha = .5;
    if (t1 != null && t1 !== t0) { const y1 = maniaY(Math.max(t0, t1), t, L, pts), yh = maniaY(Math.min(t0, t1), t, L, pts); ctx.fillStyle = rgba(c, .5); ctx.fillRect(x + L.colW * .11, y1, L.colW * .78, yh - y1); maniaNote(x, yh, L.colW, L.noteH, c); maniaNote(x, y1, L.colW, L.noteH, c); }
    else maniaNote(x, y0, L.colW, L.noteH, c);
    ctx.globalAlpha = 1;
  };
  if (MED.hold) ghost(MED.hold.col, MED.hold.t0, MED.hold.t1);
  else if (MED.hover && !EDIT.drag && (EDIT.tool === "circle" || EDIT.tool === "slider")) ghost(MED.hover.col, MED.hover.t);
  if (MED.box) { const B = MED.box; ctx.strokeStyle = "#66ccff"; ctx.fillStyle = "rgba(102,204,255,.12)"; ctx.lineWidth = 1.5; const x = Math.min(B.x0, B.x1), y = Math.min(B.y0, B.y1), w = Math.abs(B.x1 - B.x0), hh = Math.abs(B.y1 - B.y0); ctx.fillRect(x, y, w, hh); ctx.strokeRect(x, y, w, hh); }
}
// the toolbars: only what mania uses, and the tools named after its objects
function maniaEdUI() {
  const on = isMania(); document.body.classList.toggle("ed-mania", on);
  const lab = (tool, std, mn) => { const b = document.querySelector(`#edLeft [data-tool=${tool}] small`); if (b) b.textContent = tr(on ? mn : std); };
  lab("circle", "Circle", "Note"); lab("slider", "Slider", "Hold");
  if (on && EDIT.tool === "spinner") setTool("select");
}
