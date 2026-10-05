"use strict";
// Parts translated from ppy/osu: OsuAutoGenerator (MIT, Copyright (c) ppy Pty Ltd): see THIRD_PARTY_NOTICES.txt
// ============ Auto: osu!lazer's autoplay (ppy/osu OsuAutoGenerator), ported ============
// Like lazer, Auto is a replay made from the map: frames of { time, cursor position, button } that the cursor plays
// back (in a straight line between two frames). How it's made, same as lazer:
// - the cursor starts below the playfield (256, 500) 1.5 s before the first object
// - it doesn't move to an object until 100 ms after the object starts to fade in (its "reaction time"), then eases
//   out to it (fast at first, slowing down on the way in) and gets there exactly on time
// - a click holds the button 50 ms (or to the end of a slider or spinner, + 50 ms); the move to the next object
//   starts at once when the button goes up, as if it had started when the object ended
// - sliders: it follows the ball; spinners: it goes to the point on a 50 px circle round the centre whose tangent
//   points at where it comes from (easing in, so it arrives at full speed) and spins at 0.05 rad/ms (~477 rpm, as
//   osu!stable caps it); a spinner too short to need a turn is left alone
// - left button, alternating with the right one when objects come less than 266 ms apart (faster than ~225 BPM) or
//   while a button is still down; an object that starts while a slider or spinner is held takes over from it
// Different from lazer: between the frames of a move, a slider or a spinner the cursor is worked out exactly (not
// in 60 fps steps), so it's smooth at any frame rate. Built once per map and rebuilt when the objects change.
const AUTO = { hit: null, pre: 0, od: 0, F: [] };
const AUTO_FD = 1000 / 60, AUTO_KEYUP = 50, AUTO_REACT = 100, AUTO_ALT = 266, SPIN_R = 50, SPIN_V = .05;
const easeOutQ = k => k * (2 - k), easeInQ = k => k * k;
function autoSpinsNeeded(o, od) { // lazer: Spinner.SpinsRequired (the clear RPM: 90 / 150 / 225 at OD 0 / 5 / 10)
  const rpm = od < 5 ? 90 + 60 * od / 5 : 150 + 75 * (od - 5) / 5;
  return Math.floor(rpm / 60 * Math.max(0, o.end - o.t) / 1000 + .0001);
}
function autoBuild(m) {
  const H = m.hit, F = [], pre = m.preempt, od = +(m.diff.OverallDifficulty ?? 5);
  if (!H.length) return F;
  const after = t => { let lo = 0, hi = F.length; while (lo < hi) { const k = (lo + hi) >> 1; if (F[k].t <= t) lo = k + 1; else hi = k; } return lo; }; // (first frame later than t)
  const add = f => { if (!F.length || F[F.length - 1].t <= f.t) F.push(f); else F.splice(after(f.t), 0, f); return f; };
  let btnIdx = 0;
  add({ t: H[0].t - 1500, x: 256, y: 500, b: 0 });
  for (const h of H) {
    let sx = h.x, sy = h.y, ease = easeOutQ, dir = -1;
    if (h.kind === "spinner") {
      if (!autoSpinsNeeded(h, od)) continue; // (it completes by itself)
      const last = F[F.length - 1], ox = 256 - last.x, oy = 192 - last.y, d = Math.hypot(ox, oy);
      if (d > SPIN_R) { // from outside: the tangent point, turning the way it comes in (lazer has a typo in this rotation; done right here)
        const a = Math.asin(SPIN_R / d), c = Math.cos(a), s = Math.sin(a), l = Math.sqrt(d * d - SPIN_R * SPIN_R) / d;
        sx = last.x + (ox * c - oy * s) * l; sy = last.y + (ox * s + oy * c) * l; dir = -1; ease = easeInQ;
      } else if (d > 0) { sx = 256 - ox * SPIN_R / d; sy = 192 - oy * SPIN_R / d; dir = 1; } // from inside: the nearest point on the circle
      else { sx = 256; sy = 192 - SPIN_R; dir = 1; }
    }
    // ---- move to it (lazer: moveToHitObject) ----
    let last = F[F.length - 1], waited = false;
    const wait = h.t - Math.max(0, pre - AUTO_REACT);
    if (wait > last.t) { last = add({ t: wait, x: last.x, y: last.y, b: last.b }); waited = true; }
    const dt = h.t - last.t, ll = F.length >= 2 ? F[F.length - 2] : null;
    if (dt >= 0) {
      if (ll && last.up && !waited && h.t > ll.t) { // (the move counts from when the last object ended)
        const k = ease(Math.min(1, (last.t - ll.t) / (h.t - ll.t)));
        last.x += (sx - last.x) * k; last.y += (sy - last.y) * k;
      }
      last.mv = { t1: h.t, x1: sx, y1: sy, e: ease };
    }
    btnIdx = dt >= 0 && dt < AUTO_ALT ? btnIdx + 1 : 0;
    // ---- click it (lazer: addHitObjectClickFrames) ----
    let b = btnIdx % 2 ? 2 : 1;
    const start = { t: h.t, x: sx, y: sy, b };
    const ep = h.kind === "slider" ? pointAt(h, h.slides % 2 ? 1 : 0) : [h.x, h.y];
    const up = { t: h.end + AUTO_KEYUP + (h.kind === "spinner" ? 1 : 0), x: ep[0], y: ep[1], b: 0, up: true };
    const idx = after(h.t) - 1;
    if (idx >= 0 && F[idx].b) { // a button is still down (a slider, a spinner, or a click < 50 ms ago): use the other one
      const pb = F[idx].b;
      if (pb === b) { b = 3 - b; start.b = b; }
      if (idx < F.length - 1) F.splice(idx + 1, Math.max(0, after(up.t) - (idx + 1))); // (follow this object, not the one before, while it lasts)
      for (let j = idx + 1; j < F.length; j++) if (j < F.length - 1 || F[j].b === pb) F[j].b = b;
    }
    add(start);
    const step = Math.max(AUTO_FD, (h.end - h.t) / 600); // (a very long slider or spinner: fewer frames; it's worked out exactly between them anyway)
    if (h.kind === "spinner") {
      const a0 = Math.atan2(sy - 192, sx - 256);
      start.fo = h; start.a0 = a0; start.dir = dir;
      for (let t = h.t + step; t < h.end && t + step > t; t += step) { const a = a0 + (t - h.t) * SPIN_V * dir; add({ t, x: 256 + Math.cos(a) * SPIN_R, y: 192 + Math.sin(a) * SPIN_R, b, fo: h, a0, dir }); }
      const a = a0 + (h.end - h.t) * SPIN_V * dir;
      add({ t: h.end, x: up.x = 256 + Math.cos(a) * SPIN_R, y: up.y = 192 + Math.sin(a) * SPIN_R, b, fe: h });
    } else if (h.kind === "slider") {
      start.fo = h;
      for (let t = h.t + step; t < h.end && t + step > t; t += step) { const p = pointAt(h, ballF(h, t).f); add({ t, x: p[0], y: p[1], b, fo: h }); }
      add({ t: h.end, x: ep[0], y: ep[1], b, fe: h });
    }
    if (F[F.length - 1].t <= up.t) add(up); // (only let go when nothing later still holds the button)
  }
  // for the cursor's expand: when the button state last changed, and (let go) when it was pressed before that
  let since = -Infinity, press = null, on = false;
  for (const f of F) { const now = f.b > 0; if (now !== on) { if (now) press = f.t; since = f.t; on = now; } f.since = since; f.press = now ? null : press; }
  return F;
}
function autoFrames() {
  const od = map ? +(map.diff.OverallDifficulty ?? 5) : 0;
  if (!map) return [];
  if (AUTO.hit !== map.hit || AUTO.pre !== map.preempt || AUTO.od !== od) { AUTO.F = autoBuild(map); AUTO.hit = map.hit; AUTO.pre = map.preempt; AUTO.od = od; }
  return AUTO.F;
}
function autoFrameAt(F, t) { let lo = 0, hi = F.length; while (lo < hi) { const k = (lo + hi) >> 1; if (F[k].t <= t) lo = k + 1; else hi = k; } return lo - 1; }
const _cp = [0, 0];
function cursorAt(t) {
  const F = autoFrames(); if (!F.length) { _cp[0] = 256; _cp[1] = 192; return _cp; }
  const i = autoFrameAt(F, t), a = F[Math.max(0, i)], b = i >= 0 ? F[i + 1] : null;
  if (!b) { _cp[0] = a.x; _cp[1] = a.y; return _cp; }
  if (a.mv && t <= a.mv.t1) { const m = a.mv, k = m.t1 > a.t ? m.e(Math.min(1, (t - a.t) / (m.t1 - a.t))) : 1; _cp[0] = a.x + (m.x1 - a.x) * k; _cp[1] = a.y + (m.y1 - a.y) * k; return _cp; }
  const o = a.fo;
  if (o && (b.fo === o || b.fe === o)) {
    if (o.kind === "slider") { const p = pointAt(o, ballF(o, t).f); _cp[0] = p[0]; _cp[1] = p[1]; return _cp; }
    const ang = a.a0 + (t - o.t) * SPIN_V * a.dir; _cp[0] = 256 + Math.cos(ang) * SPIN_R; _cp[1] = 192 + Math.sin(ang) * SPIN_R; return _cp;
  }
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  _cp[0] = a.x + (b.x - a.x) * k; _cp[1] = a.y + (b.y - a.y) * k; return _cp;
}
// the button Auto holds at t (0 none, 1 left, 2 right)
function autoKeyAt(t) { const F = autoFrames(), i = autoFrameAt(F, t); return i >= 0 ? F[i].b : 0; }
// the cursor's size while Auto clicks, like lazer's OsuCursor: up to 1.2× on a press (400 ms, elastic), back on release (400 ms)
const outElasticHalf = k => k >= 1 ? 1 : Math.pow(2, -10 * k) * Math.sin((.5 * k - .075) * (2 * Math.PI / .3)) + 1;
function autoCursorScale(t) {
  const F = autoFrames(), i = autoFrameAt(F, t); if (i < 0) return 1;
  const f = F[i], grow = d => 1 + .2 * outElasticHalf(Math.min(1, Math.max(0, d) / 400));
  if (f.b > 0) return grow(t - f.since);
  if (f.press == null) return 1;
  const s = grow(f.since - f.press), k = Math.min(1, Math.max(0, t - f.since) / 400);
  return s + (1 - s) * easeOutQ(k);
}
