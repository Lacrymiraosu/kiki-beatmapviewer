"use strict";
// ============ osu!mania: the stage, notes and hold notes (preview and editor) ============
// Scrolling follows osu!lazer (DrawableScrollingRuleset + SequentialScrollAlgorithm): time range = 11485 ms / scroll
// speed (lazer's default speed 8); each timing / green line sets a speed multiplier of SV × the map's most common beat
// length ÷ the current beat length, and a note's distance from the judgement line is the integral of that multiplier
// between now and the note. The editor scrolls at a constant speed unless "Show speed changes" is on (like lazer).
// Layout in the 640×480 osu! screen: the judgement line at y 402 (stable's default HitPosition), the stage centred.
const MANIA_TIME_RANGE = 11485, MANIA_HIT_Y = 402;
const MANIA_COLS = { "1": [242, 242, 242], "2": [91, 184, 255], S: [255, 216, 74] };
// osu!stable default note types per column: outer columns 1, alternating 1/2 inwards, the middle of odd keys "S"
function maniaColType(col, keys) {
  if (keys % 2 && col === (keys - 1) / 2) return "S";
  const fromEdge = Math.min(col, keys - 1 - col);
  return fromEdge % 2 ? "2" : "1";
}
function maniaLayout(keys) {
  const colW = Math.min(40, 420 / keys), w = colW * keys;
  return { colW, w, x0: 320 - w / 2, hitY: MANIA_HIT_Y, noteH: Math.max(8, Math.min(14, colW * .34)) };
}
// lazer Beatmap.GetMostCommonBeatLength: the beat length that lasts longest (until the last object)
function maniaCommonBeat(m) {
  const U = m.timing.filter(tp => tp.uninherited && tp.beat > 0), last = m.last || 0;
  if (!U.length) return 500;
  const dur = new Map();
  U.forEach((tp, i) => { if (tp.time > last) return; const end = i < U.length - 1 ? U[i + 1].time : last; const k = Math.round(tp.beat * 1000) / 1000; dur.set(k, (dur.get(k) || 0) + Math.max(0, end - (i ? tp.time : 0))); });
  let best = U[0].beat, bd = -1; for (const [k, d] of dur) if (d > bd) { bd = d; best = k; }
  return best;
}
// [{ time, pos, mult }] where pos = the scroll distance (in ms at 1x) from the first point
function maniaScrollPoints(m) {
  const key = m.timing.length + ":" + m.timing.map(tp => tp.time + "/" + tp.beat).join(",").length + ":" + (m.last | 0);
  if (m._ms && m._ms.key === key && m._ms.ref === m.timing) return m._ms.pts;
  const base = maniaCommonBeat(m), last = m.last || Infinity, byTime = new Map();
  let beat = m.uni && m.uni[0] ? m.uni[0].beat : 500;
  for (const tp of m.timing) {
    if (tp.time > last && byTime.size) continue;
    let sv = 1;
    if (tp.uninherited) { if (tp.beat > 0) beat = tp.beat; }
    else sv = tp.beat < 0 ? Math.max(.01, Math.min(10, -100 / tp.beat)) : 1;
    byTime.set(tp.time, base / beat * sv); // (same time: the last line wins)
  }
  const pts = []; let pos = 0, prev = null;
  for (const [time, mult] of [...byTime].sort((a, b) => a[0] - b[0])) { if (prev) pos += (time - prev.time) * prev.mult; prev = { time, pos, mult }; pts.push(prev); }
  if (!pts.length) pts.push({ time: 0, pos: 0, mult: 1 });
  m._ms = { key, ref: m.timing, pts };
  return pts;
}
function maniaRel(t, pts) {
  const i = Math.max(0, lastBefore(pts, t, "time")), p = pts[i];
  return p.pos + (t - p.time) * p.mult;
}
const maniaSpeed = () => Math.max(1, Math.min(40, +S.maniaSpeed || 8));
const maniaSequential = () => !EDIT.on || !!S.maniaEdSV;
// y of a time on the stage (the judgement line at `now`)
function maniaY(time, now, L, pts) {
  const range = MANIA_TIME_RANGE / maniaSpeed(), d = maniaSequential() ? maniaRel(time, pts) - maniaRel(now, pts) : time - now;
  return L.hitY - d / range * L.hitY;
}
// the time at a y (editor placement): the inverse, at constant speed in the editor
function maniaTimeAtY(y, now, L) {
  const range = MANIA_TIME_RANGE / maniaSpeed();
  if (!maniaSequential()) return now + (L.hitY - y) / L.hitY * range;
  const pts = maniaScrollPoints(map), target = maniaRel(now, pts) + (L.hitY - y) / L.hitY * range;
  let i = pts.length - 1; while (i > 0 && pts[i].pos > target) i--;
  return pts[i].time + (target - pts[i].pos) / (pts[i].mult || 1);
}
const maniaLit = []; // key area light per column (preview)
function drawMania(t, ed) {
  const m = map, keys = m.keys || 4, L = maniaLayout(keys), pts = maniaScrollPoints(m), H = m.hit;
  const { colW, w, x0, hitY, noteH } = L;
  ctx.save();
  // stage
  ctx.globalAlpha = .88; ctx.fillStyle = "#0b0b10"; ctx.fillRect(x0, 0, w, 480);
  ctx.globalAlpha = 1; ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.lineWidth = 1;
  for (let c = 1; c < keys; c++) { ctx.beginPath(); ctx.moveTo(x0 + c * colW, 0); ctx.lineTo(x0 + c * colW, hitY); ctx.stroke(); }
  ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1.5; ctx.strokeRect(x0, -2, w, 484);
  // bar lines (lazer BarLineGenerator: every measure of every timing point; major = first beat of a measure)
  const tTop = ed ? maniaTimeAtY(0, t, L) : t + MANIA_TIME_RANGE / maniaSpeed() * 3;
  const U = m.uni || [];
  for (let i = 0; i < U.length; i++) {
    const tp = U[i], end = i < U.length - 1 ? U[i + 1].time : Math.max(m.last || 0, t) + 1, len = tp.beat * (tp.meter || 4);
    if (end < t - 2000 || tp.time > tTop) continue;
    const sub = ed ? tp.beat / S.snap : len;
    if (!(sub > .5)) continue; // (a tiny or broken beat length: no lines rather than millions)
    let k = Math.max(0, Math.floor((t - 2000 - tp.time) / sub));
    for (let bt = tp.time + k * sub; bt < end && bt <= tTop; bt = tp.time + ++k * sub) {
      const y = maniaY(bt, t, L, pts); if (y < -4 || y > (ed ? 480 : hitY)) continue;
      const major = Math.abs(((bt - tp.time) % len + len) % len) < 1 || Math.abs(((bt - tp.time) % len) - len) < 1;
      ctx.fillStyle = ed ? snapColor(bt) : "rgba(255,255,255,.28)"; ctx.globalAlpha = ed ? (major ? .9 : .45) : 1;
      ctx.fillRect(x0, y - (major ? 1 : .5), w, major ? 2 : 1);
    }
  }
  ctx.globalAlpha = 1;
  // judgement line + key area
  ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fillRect(x0, hitY - 1, w, 2);
  if (!ed) {
    ctx.fillStyle = "#15151d"; ctx.fillRect(x0, hitY + 2, w, 480 - hitY);
    for (let c = 0; c < keys; c++) {
      const lit = Math.max(0, 1 - (performance.now() - (maniaLit[c] || 0)) / 180), col = MANIA_COLS[maniaColType(c, keys)];
      ctx.fillStyle = rgba(col, .18 + .55 * lit); ctx.fillRect(x0 + c * colW + 3, hitY + 10, colW - 6, 480 - hitY - 20);
      if (lit > 0) { const g = ctx.createLinearGradient(0, hitY, 0, hitY - 120); g.addColorStop(0, rgba(col, .45 * lit)); g.addColorStop(1, rgba(col, 0)); ctx.fillStyle = g; ctx.fillRect(x0 + c * colW, hitY - 120, colW, 120); }
    }
  }
  // notes: from the far end of the view down to the judgement line (preview: hit notes vanish; editor: they keep going)
  ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, w, ed ? 480 : hitY + noteH / 2); ctx.clip();
  const back = ed ? MANIA_TIME_RANGE / maniaSpeed() : 0;
  const hi = lastBefore(H, tTop + 50, "t");
  const playing = !ed && typeof isPlaying === "function" && isPlaying();
  for (let i = hi; i >= 0; i--) {
    const o = H[i]; if (o.end < t - back - 200) { if (o.t < t - 60000) break; continue; }
    const col = MANIA_COLS[maniaColType(o.col, keys)], x = x0 + o.col * colW, sel = ed && EDIT.sel.has(o.lid);
    const drag = ed && EDIT.drag && sel ? EDIT.mdrag : null, dc = drag ? drag.dc : 0, dtm = drag ? drag.dt : 0;
    const ox = x + dc * colW, ot = o.t + dtm, oe = o.end + dtm;
    let yHead = maniaY(ot, t, L, pts);
    if (!ed && ot <= t) { if (o.kind === "note") { if (playing && t - ot < 40) maniaLit[o.col] = performance.now(); continue; } yHead = hitY; if (playing && oe > t) maniaLit[o.col] = performance.now(); }
    if (o.kind === "hold") {
      if (!ed && oe <= t) continue;
      const yTail = maniaY(oe, t, L, pts), bw = colW * .78;
      ctx.fillStyle = rgba(col, .42); ctx.fillRect(ox + (colW - bw) / 2, yTail, bw, Math.max(0, yHead - yTail));
      ctx.fillStyle = rgba(col, .85); ctx.fillRect(ox + (colW - bw) / 2, yTail - 2, bw, 4); // tail
      if (sel) { ctx.strokeStyle = "#66ccff"; ctx.lineWidth = 2; ctx.strokeRect(ox + 2, yTail - 3, colW - 4, yHead - yTail + 3); }
    }
    maniaNote(ox, yHead, colW, noteH, col, sel);
  }
  ctx.restore();
  if (ed && typeof edDrawMania === "function") edDrawMania(t, L);
  ctx.restore();
}
function maniaNote(x, y, colW, noteH, col, sel) {
  const r = Math.min(4, noteH / 2);
  ctx.fillStyle = rgb(col); ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x + 2, y - noteH, colW - 4, noteH, r); else ctx.rect(x + 2, y - noteH, colW - 4, noteH);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fillRect(x + 4, y - noteH + 2, colW - 8, Math.max(1, noteH * .18));
  if (sel) { ctx.strokeStyle = "#66ccff"; ctx.lineWidth = 2.5; ctx.strokeRect(x + 1, y - noteH - 1, colW - 2, noteH + 2); }
}
// beat snap colours (like the timeline): white 1/1, red 1/2, blue 1/4, yellow 1/8, purple 1/3 & 1/6, grey otherwise
function snapColor(bt) {
  const b = beatInfo(bt), f = ((bt - b.off) / b.len % 1 + 1) % 1, near = d => Math.abs(f * d - Math.round(f * d)) < .02;
  return near(1) ? "#ffffff" : near(2) ? "#ff4d5e" : near(4) ? "#3d8bff" : near(3) ? "#c050ff" : near(8) ? "#ffd84a" : near(6) ? "#c050ff" : "#888";
}

// Settings → Display → osu!mania: scroll speed like lazer (1–40; the time a note takes from the top = 11485 ms / speed)
{
  const r = $("maniaSpeed"), out = $("maniaSpeedOut");
  const show = () => { r.value = maniaSpeed(); out.textContent = `${maniaSpeed()} (${Math.round(MANIA_TIME_RANGE / maniaSpeed())} ms)`; };
  r.oninput = () => { S.maniaSpeed = +r.value; save(); show(); dirty = true; };
  show();
}
