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
  if (RP.on) return rpCursorAt(t);
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
function autoKeyAt(t) {
  if (RP.on) { const k = rpKeysAt(t); return k & 5 ? 1 : k & 10 ? 2 : 0; } // (a replay: M1/K1 left, M2/K2 right)
  const F = autoFrames(), i = autoFrameAt(F, t); return i >= 0 ? F[i].b : 0;
}
// the cursor's size while Auto clicks, like lazer's OsuCursor: up to 1.2× on a press (400 ms, elastic), back on release (400 ms)
const outElasticHalf = k => k >= 1 ? 1 : Math.pow(2, -10 * k) * Math.sin((.5 * k - .075) * (2 * Math.PI / .3)) + 1;
function autoCursorScale(t) {
  if (RP.on) return rpKeysAt(t) & 15 ? 1.15 : 1; // (a replay: like the test play cursor)
  const F = autoFrames(), i = autoFrameAt(F, t); if (i < 0) return 1;
  const f = F[i], grow = d => 1 + .2 * outElasticHalf(Math.min(1, Math.max(0, d) / 400));
  if (f.b > 0) return grow(t - f.since);
  if (f.press == null) return 1;
  const s = grow(f.since - f.press), k = Math.min(1, Math.max(0, t - f.since) / 400);
  return s + (1 - s) * easeOutQ(k);
}

// ============ replay playback (a .osr's frames instead of Auto's cursor; the player and the editor read them through cursorAt) ============
const RP = { on: false, data: null, mods: null, flipY: false, onEnd: null, onCancel: null, ended: false, mapKey: "", keep: null };
const _rp = [0, 0];
// opts: { mods: replayMods(...), mapKey?, onEnd?, onCancel? (Cancel on the loading cover while a DT / HT song copy is made: audio.js kpCancel; the replay is stopped first), from? }. Starts playing at max(map.first - 1800, 0) (or opts.from)
function rpStart(data, opts = {}) {
  if (!map || !data || !data.frames) return;
  if (typeof RPH !== "undefined") { // (the hit effects were off for this replay: try once more at every start; rpHitsPrepare, run just before this start, has tried already)
    if (RPH.failed && RPH.fresh !== data) { RPH.data = RPH.hit = null; RPH.failed = false; }
    RPH.fresh = null;
  }
  if (RP.on) rpStop(); // (a restart: put the map back first, so the originals below are the real ones)
  const mods = opts.mods || { rate: 1, hr: false, ez: false };
  RP.keep = { m: map, radius: map.radius, preempt: map.preempt, fadeIn: map.fadeIn, rate: A.rate };
  if ((mods.ez || mods.hr) && typeof replayDiff === "function") {
    const d = map.diff, d2 = replayDiff({ CircleSize: +(d.CircleSize ?? 5), ApproachRate: +(d.ApproachRate ?? d.OverallDifficulty ?? 5), OverallDifficulty: +(d.OverallDifficulty ?? 5), HPDrainRate: +(d.HPDrainRate ?? 5) }, mods);
    diffDerived(map, d2); // (radius, preempt and fadeIn from the mods' CS and AR; the stack heights are not redone)
    STACK_FLIPY = !!mods.hr; placeStacks(map.hit, map.radius / 10, true); RP.keep.restack = true; if (typeof bodyCache !== "undefined") bodyCache.clear(); // (the stack step is the modded radius / 10, like the game; Hard Rock stacks up-left on the flipped picture)
  }
  RP.data = data; RP.mods = mods; RP.flipY = !!mods.hr; RP.onEnd = opts.onEnd || null; RP.onCancel = opts.onCancel || null; RP.ended = false; RP.mapKey = opts.mapKey || ""; RP.on = true;
  document.body.classList.add("replay");
  setRate(mods.rate || 1); A.setRate(mods.rate || 1, { keepPitch: !mods.pitch }); // (the speed menu's rate, then the pitch: DT / HT keep the song's pitch, NC / DC follow the speed)
  const from = opts.from != null ? opts.from : Math.max(map.first - 1800, 0);
  UI.tapStart.hidden = true; needTapResume = false; clock.pre = false; ensureAudioCtx();
  A.seek(from); A.play().catch(onPlayBlocked);
  lastT = null; cardStart = performance.now(); keepAwake(true); showUI(); dirty = true;
}
function rpStop() {
  if (!RP.on) return;
  const k = RP.keep;
  RP.on = false; RP.data = RP.mods = RP.onEnd = RP.onCancel = RP.keep = null; RP.flipY = false; RP.ended = false; RP.mapKey = "";
  document.body.classList.remove("replay");
  if (typeof rpPopShow === "function") rpPopShow(false); // (the eye button's switches: closed with the replay)
  if (k && k.m === map) {
    map.radius = k.radius; map.preempt = k.preempt; map.fadeIn = k.fadeIn;
    if (k.restack) { STACK_FLIPY = false; placeStacks(map.hit, map.radius / 10, true); if (typeof bodyCache !== "undefined") bodyCache.clear(); } // (the stacks as the map has them)
  }
  A.want = false; // (a song waiting for its pitch-kept copy doesn't start)
  if (A.rate !== 1) setRate(1); // (rate 1 and the pitch as always: the song itself again)
  else if (A.keep !== null) { A.keep = null; try { audio.preservesPitch = true; } catch {} } // (already rate 1: only the pitch setting back, the song plays on untouched)
  dirty = true;
}
// the last frame + 500 ms
function rpEnd() { const F = RP.data && RP.data.frames; return F && F.n ? F.t[F.n - 1] + 500 : 500; }
// the last frame at or before t (-1: none yet)
function rpIndex(F, t) { let lo = 0, hi = F.n; while (lo < hi) { const k = (lo + hi) >> 1; if (F.t[k] <= t) lo = k + 1; else hi = k; } return lo - 1; }
function rpCursorAt(t) {
  const F = RP.data && RP.data.frames; if (!F || !F.n) { _rp[0] = 256; _rp[1] = 192; return _rp; }
  const i = rpIndex(F, t); let x, y;
  if (i < 0) { x = F.x[0]; y = F.y[0]; }
  else if (i >= F.n - 1) { x = F.x[i]; y = F.y[i]; }
  else { const t0 = F.t[i], t1 = F.t[i + 1], k = t1 > t0 ? (t - t0) / (t1 - t0) : 1; x = F.x[i] + (F.x[i + 1] - F.x[i]) * k; y = F.y[i] + (F.y[i + 1] - F.y[i]) * k; }
  _rp[0] = x; _rp[1] = RP.flipY ? 384 - y : y; return _rp;
}
function rpKeysAt(t) { const F = RP.data && RP.data.frames; if (!F || !F.n) return 0; const i = rpIndex(F, t); return i >= 0 ? F.k[i] : 0; }
// the health bar at t (0..1) from the replay's life graph [[ms, hp], ...] (full when it has none)
function rpHpAt(t) {
  const L = RP.data && RP.data.lifeBar; if (!L || !L.length) return 1;
  let lo = 0, hi = L.length; while (lo < hi) { const k = (lo + hi) >> 1; if (L[k][0] <= t) lo = k + 1; else hi = k; }
  const a = L[Math.max(0, lo - 1)], b = L[lo]; if (!b || t <= a[0]) return Math.max(0, Math.min(1, a[1]));
  return Math.max(0, Math.min(1, a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0] || 1)));
}
// ---- the replay's Flashlight (osu!lazer's OsuModFlashlight / ModFlashlight): where the light is and how big, both worked out
// from t alone, so a paused or seeked frame always looks the same. The light follows the cursor 120 ms behind: on each move of
// the cursor it goes outQuad(min(dt, 120) / 120) of the way to it (lazer: per frame, OnMouseMove; here in 1/60 s steps over the
// last 600 ms), and it stays where it is while the cursor doesn't move. Reduced motion: it sits on the cursor
const RP_FL = { delay: 120, step: 1000 / 60, back: 36, hit: null, br: null, pre: 0, ev: [] }, _rpfl = [0, 0];
function rpFlPos(t) {
  let p = rpCursorAt(t);
  if (RM) { _rpfl[0] = p[0]; _rpfl[1] = p[1]; return _rpfl; }
  const h = RP_FL.step, f = easeOutQ(h / RP_FL.delay), k1 = Math.floor(t / h);
  p = rpCursorAt((k1 - RP_FL.back) * h);
  let x = p[0], y = p[1], cx = x, cy = y;
  for (let k = k1 - RP_FL.back + 1; k <= k1; k++) { p = rpCursorAt(k * h); if (p[0] !== cx || p[1] !== cy) { cx = p[0]; cy = p[1]; x += (cx - x) * f; y += (cy - y) * f; } }
  const dt = t - k1 * h; p = rpCursorAt(t); // (the part of a step up to t)
  if (dt > 0 && (p[0] !== cx || p[1] !== cy)) { const g = easeOutQ(Math.min(dt, RP_FL.delay) / RP_FL.delay); x += (p[0] - x) * g; y += (p[1] - y) * g; }
  _rpfl[0] = x; _rpfl[1] = y; return _rpfl;
}
// its size (x 125 osu!px): 2.5 before the gameplay starts (first object - max(2000, preempt), shrinking 325 ms later), in breaks of
// 650 ms or more (growing at the start, shrinking at the end) and once the last object is over; otherwise by combo: 1, 0.8125 from
// 100, 0.625 from 200. A change runs linearly at 0.1875 per 100 ms (lazer, as stable). The combo is not in the replay: here it is
// the number of objects already reached (no misses, no slider ticks). Reduced motion: changes at once
const rpFlCombo = n => n >= 200 ? .625 : n >= 100 ? .8125 : 1;
function rpFlEvents() {
  const H = map.hit, B = map.breaks || [];
  if (RP_FL.hit === H && RP_FL.br === B && RP_FL.pre === map.preempt) return RP_FL.ev;
  const ev = [], n = t => lastBefore(H, t, "t") + 1;
  if (H.length) {
    const gs = H[0].t - Math.max(2000, map.preempt);
    ev.push({ t: gs + 325, to: 1 });
    if (H.length >= 100) ev.push({ t: H[99].t, to: rpFlCombo(100) });
    if (H.length >= 200) ev.push({ t: H[199].t, to: rpFlCombo(200) });
    for (const b of B) if (b[1] - b[0] >= 650) ev.push({ t: b[0], to: 2.5 }, { t: b[1], to: rpFlCombo(n(b[1])) });
    let end = -Infinity; for (const o of H) if (o.end > end) end = o.end;
    ev.push({ t: end, to: 2.5 });
  }
  ev.sort((a, b) => a.t - b.t);
  let v = 2.5, prev = null;
  for (const e of ev) { if (prev) v = rpFlLerp(prev, e.t); e.v = v; e.d = Math.abs(e.to - v) / .001875; prev = e; }
  RP_FL.hit = H; RP_FL.br = B; RP_FL.pre = map.preempt; RP_FL.ev = ev;
  return ev;
}
const rpFlLerp = (e, t) => RM || !(e.d > 0) ? e.to : e.v + (e.to - e.v) * clamp01((t - e.t) / e.d);
function rpFlScale(t) {
  const ev = rpFlEvents(); let e = null;
  for (let i = 0; i < ev.length && ev[i].t <= t; i++) e = ev[i];
  return e ? rpFlLerp(e, t) : 2.5;
}
// once, when the replay (or the song) is over: the last frame stays on screen
function rpFinish() {
  if (!RP.on || RP.ended) return;
  RP.ended = true; pausePlayback();
  const f = RP.onEnd; if (f) try { f(); } catch (e) { console.error(e); }
}
