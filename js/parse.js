"use strict";
// Parts translated from ppy/osu and ppy/osu-framework: stacking, slider paths and curves (MIT, Copyright (c) ppy Pty Ltd): see THIRD_PARTY_NOTICES.txt
// ============ .osu parser ============
const DEFAULT_COLS = [[255, 192, 0], [0, 202, 0], [18, 124, 255], [242, 24, 57]];
let lineSeq = 0;
function parseOsu(text) {
  const m = { general: {}, meta: {}, diff: {}, editor: {}, timing: [], lines: [], colours: [], colourMap: {}, colourKV: {}, eventsRaw: "", bg: null, video: null, videoOffset: 0, breaks: [], vars: {} };
  let sec = "";
  const fv = text.slice(0, 200).match(/osu file format v(\d+)/); m.version = fv ? +fv[1] : 14;
  for (const raw of text.split(/\r?\n/)) {
    const tr = raw.trim();
    if (!tr || tr.startsWith("//")) continue;
    const h = tr.match(/^\[(.+)\]$/);
    if (h) { sec = h[1]; continue; }
    if (sec === "Events") {
      m.eventsRaw += raw + "\n";
      const p = tr.split(",");
      if ((p[0] === "0" || p[0] === "Background") && p[2] && !m.bg) m.bg = p[2].replace(/"/g, "");
      else if ((p[0] === "1" || p[0] === "Video") && p[2] && !m.video) { m.video = p[2].replace(/"/g, ""); m.videoOffset = +p[1] || 0; }
      else if ((p[0] === "2" || p[0] === "Break") && p.length >= 3) m.breaks.push([+p[1], +p[2]]);
    } else if (sec === "General" || sec === "Metadata" || sec === "Difficulty" || sec === "Editor") {
      const i = tr.indexOf(":"); if (i < 0) continue;
      ({ General: m.general, Metadata: m.meta, Difficulty: m.diff, Editor: m.editor })[sec][tr.slice(0, i).trim()] = tr.slice(i + 1).trim();
    } else if (sec === "TimingPoints") {
      const tp = parseTimingLine(tr); if (tp) m.timing.push(tp);
    } else if (sec === "Colours") {
      const i = tr.indexOf(":"); if (i < 0) continue;
      m.colourKV[tr.slice(0, i).trim()] = tr.slice(i + 1).trim();
    } else if (sec === "Variables") {
      const i = tr.indexOf("="); if (i > 0) m.vars[tr.slice(0, i).trim()] = tr.slice(i + 1).trim();
    } else if (sec === "HitObjects") m.lines.push({ s: tr, id: ++lineSeq });
  }
  m.breaks.sort((a, b) => a[0] - b[0]); m.breaks0 = JSON.stringify(m.breaks); // (written back only when they change: editor.js editedText)
  coloursDerived(m);
  m.bookmarks = (m.editor.Bookmarks || "").split(",").filter(s => s.trim()).map(Number).filter(x => isFinite(x) && x >= 0);
  timingDerived(m); diffDerived(m);
  rebuildHits(m);
  return m;
}
// [TimingPoints] line <-> object; `raw` keeps the original text until the point is edited
function parseTimingLine(s) {
  const p = s.split(",").map(Number);
  if (p.length < 2 || isNaN(p[0]) || (isNaN(p[1]) && (p.length < 7 || p[6] === 1))) return null; // a NaN green line is kept: 1x, like osu! (Aspire maps)
  const fx = p[7] | 0;
  return { time: p[0], beat: p[1], meter: Math.max(1, (p[2] | 0) || 4), uninherited: p.length < 7 || p[6] === 1, kiai: (fx & 1) === 1, omit: (fx & 8) === 8, fx,
    sampleSet: p[3] | 0, sampleIndex: p[4] | 0, volume: p.length > 5 && isFinite(p[5]) ? p[5] : 100, raw: s.trim() };
}
const numStr = v => String(Math.round(v * 1e9) / 1e9);
function timingLine(tp) {
  if (tp.raw) return tp.raw;
  const fx = (tp.kiai ? 1 : 0) | (tp.omit && tp.uninherited ? 8 : 0) | ((tp.fx || 0) & ~9);
  return `${numStr(tp.time)},${numStr(tp.beat)},${tp.meter || 4},${tp.sampleSet | 0},${tp.sampleIndex | 0},${Math.round(tp.volume)},${tp.uninherited ? 1 : 0},${fx}`;
}
// [Colours] is kept as "Key": "r,g,b" strings (what the editor edits, syncs and writes back); the arrays come from it
function coloursDerived(m) {
  const rgb = v => { const c = String(v).split(",").map(x => Math.max(0, Math.min(255, +x || 0))).slice(0, 3); while (c.length < 3) c.push(0); return c; };
  const combos = [];
  m.colourMap = {};
  for (const k in m.colourKV) { const n = k.match(/^Combo(\d+)$/); if (n) combos.push([+n[1], rgb(m.colourKV[k])]); else m.colourMap[k] = rgb(m.colourKV[k]); }
  m.colours = combos.sort((a, b) => a[0] - b[0]).map(x => x[1]);
  m.hasColours = m.colours.length > 0;
}
// everything derived from the timing points / difficulty settings (the editor calls these after edits)
function timingDerived(m) {
  m.timing.sort((a, b) => a.time - b.time || (b.uninherited ? 1 : 0) - (a.uninherited ? 1 : 0));
  m.uni = m.timing.filter(x => x.uninherited && x.beat > 0);
  if (!m.uni.length) m.uni = [{ time: 0, beat: 500, meter: 4 }];
  m.kiai = []; let ks = null;
  for (const tp of m.timing) {
    if (tp.kiai && ks === null) ks = tp.time;
    else if (!tp.kiai && ks !== null) { m.kiai.push([ks, tp.time]); ks = null; }
  }
  if (ks !== null) m.kiai.push([ks, Infinity]);
}
function diffDerived(m, mod) { // mod: {cs, ar} instead of the map's own (a replay's EZ / HR)
  const cs = mod ? mod.cs : +(m.diff.CircleSize ?? 5), ar = mod ? mod.ar : +(m.diff.ApproachRate ?? m.diff.OverallDifficulty ?? 5);
  m.radius = 64 * (1 - .7 * (cs - 5) / 5) / 2 * 1.00041; // OsuHitObject.Scale (with stable's gamefield rounding allowance)
  m.preempt = Math.trunc(ar < 5 ? 1200 + 600 * (5 - ar) / 5 : 1200 - 750 * (ar - 5) / 5); // DifficultyRangeInt
  m.fadeIn = 400 * Math.min(1, m.preempt / 450); // same as osu!
}
// everything derived from the [HitObjects] lines; the editor calls this after each change
function rebuildHits(m) {
  m.mode = +(m.general.Mode || 0) || 0;
  m.hit = buildObjects(m);
  applyStacks(m);
  buildScore(m);
  buildSounds(m);
  m.first = m.hit.length ? m.hit[0].t : 0;
  let last = 0; for (const o of m.hit) if (o.end > last) last = o.end;
  m.last = last;
}

function timingAt(m, t) { // (binary search: the parser calls this for every object)
  const T = m.timing, i = lastBefore(T, t, "time");
  let beat = 500, sv = 1;
  for (let j = i; j >= 0; j--) if (T[j].uninherited && T[j].beat > 0) { beat = T[j].beat; break; }
  const tp = T[i]; if (tp && !tp.uninherited) sv = tp.beat < 0 ? Math.min(10, Math.max(0.1, -100 / tp.beat)) : 1;
  return { beat, sv };
}
function svAt(m, t) { // O(log n) version for per-frame use
  const i = lastBefore(m.timing, t, "time"), tp = m.timing[i];
  if (!tp || tp.uninherited) return 1;
  return tp.beat < 0 ? Math.min(10, Math.max(0.1, -100 / tp.beat)) : 1;
}
function beatInfo(t, m = map) {
  const U = m.uni, i = lastBefore(U, t, "time"), b = U[Math.max(0, i)];
  return { len: b.beat, off: b.time, meter: b.meter || 4 };
}
const kiaiAt = t => { for (const k of map.kiai) if (t >= k[0] && t < k[1]) return k; return null; };

const trimCache = new Map();
const T_MAX = 2147483647; // the latest time osu! reads (int.MaxValue ms): later objects are skipped, like lazer does
function buildObjects(m) {
  const out = []; let comboIdx = 0, withOff = 0, num = 0, prevSpin = false;
  const mult = +(m.diff.SliderMultiplier || 1.4), legacy = (m.version || 14) < 128, int = legacy ? Math.trunc : v => v;
  for (const L of m.lines) {
    const p = L.s.split(","); const type = +p[3];
    if (isNaN(type) || p.length < 4) continue;
    const o = { x: int(+p[0]), y: int(+p[1]), t: +p[2], idx: out.length, stack: 0, hs: +p[4] || 0, lid: L.id, type };
    if (!isFinite(o.t) || !isFinite(o.x) || !isFinite(o.y) || Math.abs(o.t) > T_MAX) continue; // osu! can't read these either (lazer: a time past int.MaxValue skips the line)
    const isSpin = (type & 8) !== 0, ncBit = (type & 4) !== 0;
    o.nc = isSpin ? ncBit || !out.length : !out.length || ncBit || prevSpin;
    if (o.nc) { comboIdx++; withOff += (ncBit && !isSpin ? (type >> 4) & 7 : 0) + 1; num = 0; }
    if (type & 2 && p[5]) {
      const huge = p[5].length > HUGE_CURVE;
      o.kind = "slider"; o.slides = Math.min(9000, Math.max(1, +p[6] || 1)); o.length = Math.max(0, +p[7] || 0); // (9000: osu!lazer's limit)
      if (!isFinite(o.length)) o.length = 0;
      let tp;
      if (huge) { // Aspire maps: hundreds of thousands of points, read straight into numbers (see hugeSlider)
        o.curve = p[5].slice(0, Math.max(0, p[5].indexOf("|"))); o.pkey = hugeKey(L) + "@" + o.x + ":" + o.y + "#" + o.length;
        const src = p[5], hx = o.x, hy = o.y;
        Object.defineProperty(o, "cps", { configurable: true, enumerable: true, get() { // the points as [x, y] only when something asks (the editor)
          const F = scanCurve(src, hx, hy, int), a = []; for (let i = 0; i < F.length; i += 2) a.push([F[i], F[i + 1]]);
          Object.defineProperty(o, "cps", { value: a, writable: true, configurable: true, enumerable: true }); return a;
        } });
        tp = trimCache.get(o.pkey);
        if (!tp) { tp = hugeSlider(o.curve, scanCurve(src, hx, hy, int), o.length); if (trimCache.size > 20000) trimCache.clear(); trimCache.set(o.pkey, tp); }
        o.nodes = tp.nodes;
      } else {
        const parts = p[5].split("|");
        const cps = [[o.x, o.y], ...parts.slice(1).map(s => s.split(":").map(Number)).filter(q => q.length >= 2 && isFinite(q[0]) && isFinite(q[1])).map(q => [int(q[0]), int(q[1])])];
        o.curve = parts[0]; o.cps = cps; o.nodes = cps.length;
        o.pkey = p[5] + "@" + o.x + ":" + o.y + "#" + o.length;
        tp = trimCache.get(o.pkey);
        if (!tp) {
          const path = sliderPath(parts[0], cps);
          tp = trimPath(path, o.length || (path.extra || 0) + pathLen(path));
          if (tp.some(q => !(q[0] >= FAR[0] && q[0] <= FAR[2] && q[1] >= FAR[1] && q[1] <= FAR[3]))) { const F = new Float64Array(tp.length * 2); tp.forEach((q, i) => { F[2 * i] = q[0]; F[2 * i + 1] = q[1]; }); tp = farPath(F, tp.dist); }
          if (trimCache.size > 20000) trimCache.clear();
          trimCache.set(o.pkey, tp);
        }
      }
      if (!o.length) o.length = tp.dist;
      o.path = tp; o.dist = tp.dist;
      const { beat, sv } = timingAt(m, o.t);
      o.span = o.dist / (mult * 100 * sv) * beat;
      o.span = o.span >= 1 || !(beat < 1) ? Math.max(1, o.span) : Math.max(1e-9, o.span); // under a red line of a tiny beat length (Aspire): instant, like osu!stable
      o.end = o.t + o.span * o.slides;
      o.edgeSounds = (p[8] || "").split("|").map(Number);
      o.edgeSets = (p[9] || "").split("|").map(x => x.split(":").map(Number));
      o.samp = parseSamp(p[10]); o.sv = sv; o.vel = o.dist / o.span; o.argc = p.length; // (argc: how many fields the line has; Verify reads edge hit sounds the way MapsetVerifier does)
      if (!isFinite(o.end) || !o.path.length) { o.kind = "circle"; o.end = o.t; delete o.path; }
    } else if (isSpin) { o.kind = "spinner"; o.x = 256; o.y = 192; o.end = Math.max(o.t + 1, Math.min(T_MAX, +p[5] || o.t + 1)); o.samp = parseSamp(p[6]); }
    else { o.kind = "circle"; o.end = o.t; o.samp = parseSamp(p[5]); }
    if (!isSpin) o.num = ++num;
    o.ci = m.hasColours ? withOff : comboIdx; // beatmap colours use the offsets (colour hax), skin colours don't
    o.combo = comboIdx;
    prevSpin = isSpin;
    out.push(o);
  }
  out.sort((a, b) => a.t - b.t);
  out.forEach((o, i) => o.idx = i);
  return out;
}

// osu! stacking (beatmap version >= 6): objects within 3px and close in time are shifted up-left,
// including circles stacked on slider ends
const geomCache = new Map();
let REAL_STACKS = false; // (Verify reads the open map with stacking even when the editor shows it off)
function applyStacks(m) {
  const H = m.hit, thr = Math.trunc(m.preempt) * +(m.general.StackLeniency ?? 0.7), off = m.radius / 10, D = 3;
  const endP = o => o.path && o.slides % 2 ? o.path[o.path.length - 1] : [o.x, o.y]; // a slider with an even number of slides ends on its head
  const near = (a, bx, by) => Math.hypot(a[0] - bx, a[1] - by) < D;
  for (const o of H) o.stack = 0;
  if ((m.version || 14) < 6) { // OsuBeatmapProcessor.applyStackingOld
    for (let i = 0; i < H.length; i++) {
      const cur = H[i]; if (cur.stack !== 0 && cur.kind !== "slider") continue;
      let start = cur.end, sliderStack = 0; const p2 = endP(cur);
      for (let j = i + 1; j < H.length; j++) {
        if (H[j].t - thr > start) break;
        if (near([cur.x, cur.y], H[j].x, H[j].y)) { cur.stack++; start = H[j].t; }
        else if (near(p2, H[j].x, H[j].y)) { sliderStack++; H[j].stack -= sliderStack; start = H[j].t; }
      }
    }
  } else for (let i = H.length - 1; i > 0; i--) {
    let n = i, oi = H[i];
    if (oi.stack !== 0 || oi.kind === "spinner") continue;
    if (oi.kind === "circle") {
      while (--n >= 0) {
        const on = H[n]; if (on.kind === "spinner") continue;
        if (Math.trunc(oi.t) - Math.trunc(on.end) > thr) break;
        if (on.kind === "slider" && near(endP(on), oi.x, oi.y)) {
          const d = oi.stack - on.stack + 1;
          for (let j = n + 1; j <= i; j++) if (near(endP(on), H[j].x, H[j].y)) H[j].stack -= d;
          break;
        }
        if (near([on.x, on.y], oi.x, oi.y)) { on.stack = oi.stack + 1; oi = on; }
      }
    } else if (oi.kind === "slider") {
      while (--n >= 0) {
        const on = H[n]; if (on.kind === "spinner") continue;
        if (oi.t - on.t > thr) break;
        if (near(endP(on), oi.x, oi.y)) { on.stack = oi.stack + 1; oi = on; }
      }
    }
  }
  if (typeof EDIT !== "undefined" && EDIT.on && S.edStack === false && !REAL_STACKS) for (const o of H) o.stack = 0; // Settings → Editor → Stacking off: where objects really are
  placeStacks(H, off, false);
}
// the stack offsets onto the objects' positions and paths (up-left). A replay with Hard Rock draws the map flipped: there the vertical offset is
// turned round (STACK_FLIPY) and the whole picture is flipped on screen, so it stacks up-left on screen as the game does. redo: place again from
// the unstacked positions and paths that the first placement kept (rx / ry, path0), with another offset
let STACK_FLIPY = false;
function placeStacks(H, off, redo) {
  for (const o of H) {
    if (redo) { if (o.rx !== undefined) { o.x = o.rx; o.y = o.ry; } if (o.path0) o.path = o.path0; }
    o.rx = o.x; o.ry = o.y; // unstacked position (what the editor moves)
    if (o.path) o.path0 = o.path; // (the unstacked path, kept for a redo)
    const d = o.stack ? -o.stack * off : 0, dy = STACK_FLIPY ? -d : d;
    if (d) { o.x += d; o.y += dy; }
    if (o.path) { // drawn geometry (stacked path, lengths, Path2D), cached: most sliders don't change between edits
      const key = o.pkey + "@" + d + (STACK_FLIPY ? "f" : ""), g = geomCache.get(key);
      if (g) { o.path = g.path; o.cum = g.cum; o.p2d = g.p2d; continue; }
      if (d) { const P0 = o.path; o.path = P0.map(p => [p[0] + d, p[1] + dy]); o.path.dist = P0.dist; if (P0.jumps) { o.path.jumps = P0.jumps; o.path.lens = P0.lens; } }
      o.cum = [0]; const Ls = o.path.lens;
      for (let i = 1; i < o.path.length; i++) o.cum.push(o.cum[i - 1] + (Ls ? Ls[i] : Math.hypot(o.path[i][0] - o.path[i - 1][0], o.path[i][1] - o.path[i - 1][1])));
      o.p2d = new Path2D(); tracePath(o.p2d, o.path);
      if (o.path.length === 1) o.p2d.lineTo(o.path[0][0] + .01, o.path[0][1]);
      if (geomCache.size > 20000) geomCache.clear();
      geomCache.set(key, { path: o.path, cum: o.cum, p2d: o.p2d });
    }
  }
}

function buildScore(m) {
  const ev = [];
  for (const o of m.hit) {
    if (o.kind === "circle") ev.push([o.t, 300]);
    else if (o.kind === "slider") { ev.push([o.t, 30]); for (let k = 1; k < o.slides; k++) ev.push([o.t + o.span * k, 30]); ev.push([o.end, 300]); }
    else ev.push([o.end, 300]);
  }
  ev.sort((a, b) => a[0] - b[0]);
  let combo = 0, score = 0;
  m.score = ev.map(([t, base]) => { combo++; score += base + Math.floor(base * Math.max(0, combo - 1) * 4 / 25); return { t, combo, score, v: base === 300 ? 1 : .7 }; });
}
function parseSamp(str) {
  const q = (str || "").split(":");
  return { n: +q[0] || 0, a: +q[1] || 0, i: +q[2] || 0, v: +q[3] || 0, f: (q[4] || "").trim() };
}
const SETS = { 1: "normal", 2: "soft", 3: "drum" };
function buildSounds(m) {
  const ev = [], none = { n: 0, a: 0, i: 0, v: 0, f: "" };
  m.defSet = { normal: 1, soft: 2, drum: 3 }[(m.general.SampleSet || "Normal").toLowerCase()] || 1;
  const tickRate = +(m.diff.SliderTickRate || 1), mult = +(m.diff.SliderMultiplier || 1.4);
  // oi = the object's index in m.hit, k = which edge of a slider (0 head, 1.. repeats, slides = tail): a replay's hitsounds (js/replayana.js rpSoundEvents) need them
  for (let oi = 0; oi < m.hit.length; oi++) {
    const o = m.hit[oi], sp = o.samp || none;
    if (o.kind === "circle") ev.push({ t: o.t, hs: o.hs, n: sp.n, a: sp.a, i: sp.i, v: sp.v, f: sp.f, oi });
    else if (o.kind === "spinner") ev.push({ t: o.end, hs: o.hs, n: sp.n, a: sp.a, i: sp.i, v: sp.v, f: sp.f, oi });
    else {
      const seen = o.span < 1 && o.slides > 1 ? new Set() : null; // an instant slider (Aspire): each distinct edge sound once, not thousands at the same moment
      for (let k = 0; k <= o.slides; k++) {
        const hs = isFinite(o.edgeSounds[k]) ? o.edgeSounds[k] : o.hs, es = o.edgeSets[k] || [];
        if (seen) { const key = hs + "|" + (es[0] || sp.n) + "|" + (es[1] || sp.a); if (seen.has(key)) continue; seen.add(key); }
        ev.push({ t: o.t + o.span * k, hs, n: es[0] || sp.n, a: es[1] || sp.a, i: sp.i, v: sp.v, f: "", oi, k });
      }
      // slider ticks: o.ticks = [[fraction along the path, time of its last hit]]
      const tickDist = 100 * mult * ((m.version || 14) < 8 ? 1 : o.sv || 1) / tickRate, len = o.dist || o.length, minD = len / o.span * 10;
      o.ticks = [];
      if (tickDist > 1 && len > 0) {
        const frs = [], cap = Math.min(500, Math.floor(20000 / o.slides)); // (bounded: a slider with thousands of repeats)
        for (let d = tickDist; d <= len - minD && frs.length < cap; d += tickDist) frs.push(d / len);
        for (const fr of frs) {
          let last = 0;
          for (let k = 0; k < o.slides; k++) {
            const tt = o.t + o.span * k + (k % 2 ? 1 - fr : fr) * o.span; if (tt > last) last = tt;
            ev.push({ t: tt, tick: true, hs: 0, n: sp.n, a: 0, i: sp.i, v: sp.v, f: "", oi });
          }
          o.ticks.push([fr, last]);
        }
      }
    }
  }
  ev.sort((a, b) => a.t - b.t);
  m.sounds = ev;
}
function lastBefore(arr, t, key) { // index of last item with item[key] <= t
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid][key] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; }
  return r;
}

function lowerIdx(arr, t, key) { // index of the first item >= t (item[key] when a key is given)
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((key ? arr[mid][key] : arr[mid]) < t) lo = mid + 1; else hi = mid; }
  return lo;
}

// ============ beat snapping, measured like MapsetVerifier (the editor, Verify and the rhythm view share it) ============
// osu! keeps object times as whole ms, cut off rather than rounded (that's why 1 ms unsnaps are everywhere in ranked
// maps). So an object is measured against the grid time cut to a whole ms: unsnap = time - trunc(nearest grid time),
// the smallest of 1/16, 1/12, 1/9, 1/7 and 1/5. Its divisor is the one with the smallest unsnap (the lower on a tie).
const SNAP_DIVS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 16], UNSNAP_DIVS = [16, 12, 9, 7, 5], UNSNAP_RANK = { 16: 1, 12: 2, 9: 3, 7: 4, 5: 5 };
const redLineAt = (m, t) => m.uni[Math.max(0, lastBefore(m.uni, t, "time"))];
function nextRedLine(m, t) { const i = lastBefore(m.uni, t, "time") + 1; return m.uni[i] || null; } // (strictly after t)
function gridTime(t, d, u) { // the nearest 1/d grid point, counted in whole divisions from the line so it stays exact
  const b = (t - u.time) / u.beat, w = Math.floor(b);
  return u.time + (w * d + Math.round((b - w) * d)) * u.beat / d;
}
const unsnapOn = (t, d, u) => t - Math.trunc(gridTime(t, d, u));
// both snap measures from one pass over the divisors; during a Verify run (SNAP_MEMO set) each time is worked out once
let SNAP_MEMO = null;
function snapCalc(t, u) {
  let memo = null;
  if (SNAP_MEMO) { memo = SNAP_MEMO.get(u); if (!memo) SNAP_MEMO.set(u, memo = new Map()); const hit = memo.get(t); if (hit) return hit; } // (per red line, then per time)
  const b = (t - u.time) / u.beat, w = Math.floor(b), f = b - w; // (gridTime / unsnapOn inlined: this runs for every object edge)
  let un = Infinity, unRank = 9, min = Infinity, div = 0;
  for (let k = 0; k < SNAP_DIVS.length; k++) {
    const d = SNAP_DIVS[k], e = t - Math.trunc(u.time + (w * d + Math.round(f * d)) * u.beat / d), a = Math.abs(e);
    if (a < min - 1e-9) { min = a; div = d; }
    const rk = UNSNAP_RANK[d]; // (a tie goes to the divisor first in UNSNAP_DIVS)
    if (rk && (a < Math.abs(un) || (a === Math.abs(un) && rk < unRank))) { un = e; unRank = rk; }
  }
  const r = { un, div: min > 2 ? 0 : div }; // div 0 = more than 2 ms from every divisor
  if (memo) memo.set(t, r);
  return r;
}
const practicalUnsnap = (t, m, u = redLineAt(m, t)) => snapCalc(t, u).un;
const lowestDivisor = (t, m, u = redLineAt(m, t)) => snapCalc(t, u).div;
// two red lines with the same BPM and meter whose bar lines line up (within 1 ms)
function beatOffset(a, b, mod) { const x = ((b.time - a.time) / a.beat) % mod; return Math.min(Math.abs(x), Math.abs(x - mod), Math.abs(x + mod)) * a.beat; }
const downbeatsAligned = (a, b) => Math.abs(a.beat - b.beat) < 1e-6 && (a.meter || 4) === (b.meter || 4) && beatOffset(b, a, b.meter || 4) <= 1;

// ============ slider curves ============
// Ported from osu!lazer's legacy path handling (ppy/osu ConvertHitObjectParser + SliderPath, ppy/osu-framework
// PathApproximator), which reproduces osu!stable: see docs/EDITOR_REFERENCE.md.
const eqPt = (a, b) => a[0] === b[0] && a[1] === b[1];
const nearZero = v => Math.abs(v) <= 1e-3; // osu-framework Precision.AlmostEquals (float)
const isLinear = (a, b, c) => nearZero((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]));
// bezier: adaptive subdivision until "flat enough" (tolerance 0.25 osu!px), like PathApproximator.BSplineToPiecewiseLinear
const BEZ_FLAT = 0.25 * 0.25 * 4;
function bezierFlat(c) {
  for (let i = 1; i < c.length - 1; i++) {
    const x = c[i - 1][0] - 2 * c[i][0] + c[i + 1][0], y = c[i - 1][1] - 2 * c[i][1] + c[i + 1][1];
    if (x * x + y * y > BEZ_FLAT) return false;
  }
  return true;
}
let bzX = new Float64Array(64), bzY = new Float64Array(64);
function bezierSubdivide(c, l, r) { // (in place in two scratch arrays: the same sums as halving pairs into new arrays)
  const n = c.length;
  if (bzX.length < n) { bzX = new Float64Array(n * 2); bzY = new Float64Array(n * 2); }
  const X = bzX, Y = bzY;
  for (let i = 0; i < n; i++) { X[i] = c[i][0]; Y[i] = c[i][1]; }
  for (let i = 0; i < n; i++) {
    l[i] = [X[0], Y[0]]; r[n - i - 1] = [X[n - i - 1], Y[n - i - 1]];
    for (let j = 0; j < n - i - 1; j++) { X[j] = (X[j] + X[j + 1]) / 2; Y[j] = (Y[j] + Y[j + 1]) / 2; }
  }
}
function bezierApprox(c, out) {
  const n = c.length, l = new Array(2 * n - 1), r = new Array(n);
  bezierSubdivide(c, l, r);
  for (let i = 0; i < n - 1; i++) l[n + i] = r[i + 1];
  out.push(c[0]);
  for (let i = 1; i < n - 1; i++) { const k = 2 * i; out.push([.25 * (l[k - 1][0] + 2 * l[k][0] + l[k + 1][0]), .25 * (l[k - 1][1] + 2 * l[k][1] + l[k + 1][1])]); }
}
function bezier(pts) {
  if (pts.length < 2) return pts.slice();
  const out = [], stack = [pts.slice()];
  // (a budget on the work, not the passes: each pass costs n² for n points, and control points far out never get
  // "flat"; past it, what's left goes in as straight lines between its pieces)
  for (let guard = 0, work = 0; stack.length && guard < 200000; guard++) {
    const par = stack.pop();
    if (bezierFlat(par)) { bezierApprox(par, out); continue; }
    if ((work += par.length * par.length) > 3e7) { for (const q of [par, ...stack.reverse()]) out.push(q[0]); break; }
    const l = new Array(par.length), r = new Array(par.length);
    bezierSubdivide(par, l, r);
    stack.push(r, l);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
// perfect curve: circle through 3 points, 0.1 osu!px tolerance (CircularArcProperties)
function arcProps(a, b, c) {
  if (isLinear(a, b, c)) return null;
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const aS = a[0] * a[0] + a[1] * a[1], bS = b[0] * b[0] + b[1] * b[1], cS = c[0] * c[0] + c[1] * c[1];
  const cx = (aS * (b[1] - c[1]) + bS * (c[1] - a[1]) + cS * (a[1] - b[1])) / d;
  const cy = (aS * (c[0] - b[0]) + bS * (a[0] - c[0]) + cS * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy), t0 = Math.atan2(a[1] - cy, a[0] - cx);
  let t1 = Math.atan2(c[1] - cy, c[0] - cx);
  while (t1 < t0) t1 += 2 * Math.PI;
  let dir = 1, range = t1 - t0;
  if ((c[1] - a[1]) * (b[0] - a[0]) - (c[0] - a[0]) * (b[1] - a[1]) < 0) { dir = -1; range = 2 * Math.PI - range; } // B on the other side of AC
  const n = 2 * r <= .1 ? 2 : Math.max(2, Math.ceil(range / (2 * Math.acos(1 - .1 / r))));
  return isFinite(n) ? { cx, cy, r, t0, range, dir, n } : null;
}
function arcPath(p) {
  const out = [];
  for (let i = 0; i < p.n; i++) { const th = p.t0 + p.dir * (i / (p.n - 1)) * p.range; out.push([p.cx + Math.cos(th) * p.r, p.cy + Math.sin(th) * p.r]); }
  return out;
}
// catmull: 50 steps per knot, extrapolated end knots; like osu!stable only vertices 6px apart are kept, and the removed
// length still counts toward the slider length (so it isn't stretched to the length written in the file)
function catmull(pts) {
  const raw = [], f = (a, b, c, d, t) => { const t2 = t * t, t3 = t2 * t; return [0, 1].map(j => .5 * (2 * b[j] + (-a[j] + c[j]) * t + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t2 + (-a[j] + 3 * b[j] - 3 * c[j] + d[j]) * t3)); };
  for (let i = 0; i < pts.length - 1; i++) {
    const v1 = i > 0 ? pts[i - 1] : pts[i], v2 = pts[i], v3 = pts[i + 1], v4 = i < pts.length - 2 ? pts[i + 2] : [v3[0] * 2 - v2[0], v3[1] * 2 - v2[1]];
    for (let c = 0; c < 50; c++) raw.push(f(v1, v2, v3, v4, c / 50), f(v1, v2, v3, v4, (c + 1) / 50));
  }
  const out = []; let start = null, removed = 0, extra = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!start) { out.push(raw[i]); start = raw[i]; continue; }
    const fromStart = Math.hypot(raw[i][0] - start[0], raw[i][1] - start[1]);
    removed += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
    if (fromStart > 6 || (i + 1) % 100 === 0 || i === raw.length - 1) { out.push(raw[i]); extra += removed - fromStart; start = null; removed = 0; }
  }
  out.extra = extra;
  return out;
}
// the whole path, before it is cut/extended to the slider's length. `type` is the letter from the file, cps includes the head.
// Cached: the editor rebuilds every object after each edit, most of them unchanged. Callers must not modify the result.
const pathCache = new Map();
function sliderPath(type, cps) {
  const key = type + cps.join("|"), hit = pathCache.get(key);
  if (hit) return hit;
  const out = sliderPathCalc(type, cps);
  if (pathCache.size > 20000) pathCache.clear();
  pathCache.set(key, out);
  return out;
}
function sliderPathCalc(type, cps) {
  if (cps.length < 2) return cps.slice();
  let T = type;
  if (T === "P") { if (cps.length !== 3) T = "B"; else if (isLinear(cps[0], cps[1], cps[2])) T = "L"; } // stable: straight "perfect" curves are lines
  // two identical points in a row start a new segment (red anchor); legacy catmull has no segments
  const segs = []; let start = 0, end = 0;
  while (++end < cps.length) {
    if (!eqPt(cps[end], cps[end - 1]) || (T === "C" && end > 1) || end === cps.length - 1) continue;
    segs.push(cps.slice(start, end)); start = end + 1;
  }
  if (start < end) segs.push(cps.slice(start, end));
  const out = []; let prev = null, extra = 0;
  for (const s of segs) {
    const v = prev ? [prev, ...s] : s; prev = s[s.length - 1];
    let sub;
    if (v.length === 1) sub = v;
    else if (T === "L") sub = v;
    else if (T === "C") { sub = catmull(v); extra += sub.extra; }
    else if (T === "P") { const a = v.length === 3 && arcProps(v[0], v[1], v[2]); sub = a && a.n < 1000 ? arcPath(a) : bezier(v); }
    else sub = bezier(v);
    for (let j = out.length && sub.length && eqPt(out[out.length - 1], sub[0]) ? 1 : 0; j < sub.length; j++) out.push(sub[j]);
  }
  out.extra = extra;
  return out;
}
const pathLen = pts => pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0);
// cut or extend the path to `length` (SliderPath.calculateLength). Returns the points; .dist = the resulting length
// (shorter than asked when stable wouldn't extend: the last two points are the same).
function trimPath(pts, length) {
  const extra = pts.extra || 0;
  if (!length || pts.length < 2) { const r = pts.slice(); r.dist = extra + pathLen(pts); return r; }
  const out = [pts[0]]; let acc = extra;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + d >= length) { const f = d ? (length - acc) / d : 0; out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]); out.dist = length; return out; }
    acc += d; out.push(pts[i]);
  }
  const a = pts[pts.length - 2], b = pts[pts.length - 1], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d > 0 && length > acc) { out.push([b[0] + (b[0] - a[0]) / d * (length - acc), b[1] + (b[1] - a[1]) / d * (length - acc)]); out.dist = length; }
  else out.dist = acc;
  return out;
}
// a path into a canvas context or Path2D; a jump (left-out stretch, see farPath) starts a new subpath
function tracePath(g, P, dx = 0, dy = 0) {
  const J = P.jumps;
  for (let i = 0; i < P.length; i++) { const q = P[i]; if (!i || (J && J.has(i))) g.moveTo(q[0] + dx, q[1] + dy); else g.lineTo(q[0] + dx, q[1] + dy); }
}

// ============ huge and far-reaching sliders (Aspire maps) ============
// Aspire maps push sliders to the extreme: hundreds of thousands of points, lengths in the billions, points millions
// of osu!px away (this map: 8.6 million points in 108 MB). A slider whose curve text is longer than HUGE_CURVE is read
// straight into numbers (no [x, y] per point), and any path that leaves FAR (well past the edges of any screen) is
// cut to the pieces inside it. The pieces are joined by jumps: P.jumps = indices i whose segment i-1 → i stands for a
// left-out stretch (not drawn; the ball doesn't travel along it), P.lens[i] = the real length of segment i-1 → i, so the
// slider's length, timing and ball position stay what osu! has.
const HUGE_CURVE = 40000;
const FAR = [-1000, -800, 1512, 1184];
const farC = v => v < -1e7 ? -1e7 : v > 1e7 ? 1e7 : v; // points out there stay out there, but within what a canvas path can hold
const hugeKeys = new Map(); let hugeVer = 0; // line id -> { s, k }: a cache key per line text (a new one when the text changes)
function hugeKey(L) {
  const e = hugeKeys.get(L.id); if (e && e.s === L.s) return e.k;
  const k = "~" + L.id + "." + ++hugeVer;
  hugeKeys.set(L.id, { s: L.s, k }); if (hugeKeys.size > 5000) hugeKeys.clear();
  return k;
}
function fastNum(s, a, b) { // Number(s.slice(a, b)), without the substring for plain integers
  let i = a, v = 0; const neg = s.charCodeAt(i) === 45; if (neg) i++;
  const i0 = i;
  for (; i < b; i++) { const d = s.charCodeAt(i) - 48; if (d < 0 || d > 9) break; v = v * 10 + d; }
  return i === b && i > i0 && b - i0 < 16 ? (neg ? -v : v) : Number(s.slice(a, b));
}
// "T|x:y|x:y…" -> Float64Array [x0, y0, x1, y1, …] with the head first; unreadable points are skipped like parseOsu does
function scanCurve(s, x0, y0, int) {
  let n = 1; for (let i = s.indexOf("|"); i >= 0; i = s.indexOf("|", i + 1)) n++;
  const out = new Float64Array(n * 2); out[0] = x0; out[1] = y0;
  let k = 2, i = s.indexOf("|") + 1;
  while (i > 0 && i <= s.length) {
    let j = s.indexOf("|", i); if (j < 0) j = s.length;
    const c = s.indexOf(":", i);
    if (c >= i && c < j) {
      let c2 = s.indexOf(":", c + 1); if (c2 < 0 || c2 > j) c2 = j;
      const x = fastNum(s, i, c), y = fastNum(s, c + 1, c2);
      if (isFinite(x) && isFinite(y)) { out[k++] = int(x); out[k++] = int(y); }
    }
    i = j + 1;
  }
  return out.subarray(0, k);
}
// the path of a huge slider: same rules as sliderPathCalc + trimPath, on flat numbers, then farPath
function hugeSlider(type, F, length) {
  const n = F.length / 2, T = type === "P" && n !== 3 ? "B" : type;
  let flat, m = 0, extra = 0;
  if (T === "L") { // a line through every point (red anchors change nothing), a repeated last point kept: osu! doesn't extend then
    flat = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) { const x = F[2 * i], y = F[2 * i + 1]; if (!m || x !== flat[2 * m - 2] || y !== flat[2 * m - 1] || i === n - 1) { flat[2 * m] = x; flat[2 * m + 1] = y; m++; } }
  } else {
    const pts = []; for (let i = 0; i < n; i++) pts.push([F[2 * i], F[2 * i + 1]]); // (bezier/catmull segments are small)
    const path = sliderPathCalc(T, pts); extra = path.extra || 0; m = path.length;
    flat = new Float64Array(2 * m); path.forEach((q, i) => { flat[2 * i] = q[0]; flat[2 * i + 1] = q[1]; });
  }
  // trimPath on the flat points (in place: the cut point replaces the point after it)
  const want = length || Infinity;
  let acc = extra, dist = -1, k = m;
  for (let i = 1; i < m; i++) {
    const ax = flat[2 * i - 2], ay = flat[2 * i - 1], bx = flat[2 * i], by = flat[2 * i + 1], d = Math.hypot(bx - ax, by - ay);
    if (acc + d >= want) { const f = d ? (want - acc) / d : 0; flat[2 * i] = ax + (bx - ax) * f; flat[2 * i + 1] = ay + (by - ay) * f; dist = want; k = i + 1; break; }
    acc += d;
  }
  let cut = flat.subarray(0, 2 * k);
  if (dist < 0) {
    if (length && m >= 2 && length > acc) {
      const ax = flat[2 * m - 4], ay = flat[2 * m - 3], bx = flat[2 * m - 2], by = flat[2 * m - 1], d = Math.hypot(bx - ax, by - ay);
      if (d > 0) { const c = new Float64Array(2 * m + 2); c.set(flat.subarray(0, 2 * m)); c[2 * m] = bx + (bx - ax) / d * (length - acc); c[2 * m + 1] = by + (by - ay) / d * (length - acc); cut = c; dist = length; }
    }
    if (dist < 0) dist = acc;
  }
  const P = farPath(cut, dist); P.nodes = n;
  return P;
}
// cut a flat path [x0, y0, x1, y1, …] to its pieces inside FAR (Liang–Barsky per segment); see the note above. Aspire
// sliders trace the same shapes over and over: a piece that repeats one already kept (same points to 1 osu!px, either
// direction) is left out too, since drawing it again into the same body changes nothing; kept pieces are simplified
// (Douglas–Peucker in chunks of 128 points, 0.35 osu!px)
let farBuf = new Float64Array(4096), farLen = new Float64Array(2048), farKeep = new Uint8Array(2048);
function farPath(F, dist) {
  const [X0, Y0, X1, Y1] = FAR, n = F.length / 2, out = [[farC(F[0]), farC(F[1])]], lens = [0], jumps = new Set(), seen = new Set();
  let run = 0, pn = 0, fromHead = false; // run: length left out since the last kept point; the piece being read: pn points in farBuf/farLen
  const add = (x, y, l) => {
    if (pn >= farLen.length) { const b = new Float64Array(farBuf.length * 2); b.set(farBuf); farBuf = b; const L2 = new Float64Array(farLen.length * 2); L2.set(farLen); farLen = L2; farKeep = new Uint8Array(farLen.length); }
    farBuf[2 * pn] = x; farBuf[2 * pn + 1] = y; farLen[pn++] = l;
  };
  const endPiece = () => {
    if (!pn) return;
    const P = farBuf, Ls = farLen, N = pn, head = fromHead; pn = 0; fromHead = false;
    if (N < 2) { run += Ls[0]; return; }
    let tot = 0; for (let i = 0; i < N; i++) tot += Ls[i];
    if (!head) {
      let h1 = 2166136261, h2 = 5381, r1 = 2166136261, r2 = 5381; // (forward and backward, so a piece traced the other way matches)
      for (let i = 0, j = N - 1; i < N; i++, j--) {
        const x = Math.round(P[2 * i]), y = Math.round(P[2 * i + 1]), xr = Math.round(P[2 * j]), yr = Math.round(P[2 * j + 1]);
        h1 = Math.imul(h1 ^ x, 16777619) ^ y; h2 = (Math.imul(h2, 33) + x * 7 + y) | 0;
        r1 = Math.imul(r1 ^ xr, 16777619) ^ yr; r2 = (Math.imul(r2, 33) + xr * 7 + yr) | 0;
      }
      const kf = (h1 >>> 0) + ":" + (h2 >>> 0) + ":" + N, kr = (r1 >>> 0) + ":" + (r2 >>> 0) + ":" + N, key = kf < kr ? kf : kr;
      if (seen.has(key)) { run += tot; return; }
      seen.add(key);
    }
    // simplify: drop points within .35 of the last kept one, then Douglas–Peucker per chunk of 128 candidates
    const keep = farKeep; keep.fill(0, 0, N); keep[0] = 1;
    let li = 0;
    for (let i = 1; i < N - 1; i++) if (Math.abs(P[2 * i] - P[2 * li]) > .35 || Math.abs(P[2 * i + 1] - P[2 * li + 1]) > .35) { keep[i] = 2; li = i; }
    keep[N - 1] = 1;
    const st = [];
    { let c0 = 0, cnt = 0; for (let i = 1; i < N; i++) if (keep[i]) { if (++cnt === 128 || i === N - 1) { keep[i] = 1; st.push(c0, i); c0 = i; cnt = 0; } } }
    while (st.length) {
      const i1 = st.pop(), i0 = st.pop(); if (i1 - i0 < 2) continue;
      const ax = P[2 * i0], ay = P[2 * i0 + 1], dx = P[2 * i1] - ax, dy = P[2 * i1 + 1] - ay, dd = Math.sqrt(dx * dx + dy * dy);
      let best = -1, bi = -1;
      for (let i = i0 + 1; i < i1; i++) {
        if (keep[i] !== 2) continue;
        const px = P[2 * i] - ax, py = P[2 * i + 1] - ay, e = dd ? Math.abs(px * dy - py * dx) / dd : Math.hypot(px, py);
        if (e > best) { best = e; bi = i; }
      }
      if (best > .35) { keep[bi] = 1; st.push(i0, bi, bi, i1); }
    }
    if (!head) { out.push([P[0], P[1]]); lens.push(run + Ls[0]); jumps.add(out.length - 1); } // the jump into this piece (none from the head)
    run = 0; let acc = 0;
    for (let i = 1; i < N; i++) { acc += Ls[i]; if (keep[i] === 1) { out.push([P[2 * i], P[2 * i + 1]]); lens.push(acc); acc = 0; } }
  };
  for (let i = 1; i < n; i++) {
    const ax = F[2 * i - 2], ay = F[2 * i - 1], dx = F[2 * i] - ax, dy = F[2 * i + 1] - ay, d = Math.hypot(dx, dy);
    if (!(d > 0)) continue;
    let t0 = 0, t1 = 1, vis = isFinite(d);
    if (vis) for (let k = 0; k < 4; k++) {
      const pp = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dy : dy, qq = k === 0 ? ax - X0 : k === 1 ? X1 - ax : k === 2 ? ay - Y0 : Y1 - ay;
      if (pp === 0) { if (qq < 0) { vis = false; break; } continue; }
      const r = qq / pp;
      if (pp < 0) { if (r > t1) { vis = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { vis = false; break; } if (r < t1) t1 = r; }
    }
    if (!vis) { endPiece(); run += d; continue; }
    if (t0 > 0) endPiece();
    if (!pn) { // a piece starts: at the head, or where the path enters FAR (its first length = the stretch before it)
      if (out.length === 1 && run === 0 && t0 === 0 && ax === out[0][0] && ay === out[0][1]) { fromHead = true; add(ax, ay, 0); }
      else add(ax + dx * t0, ay + dy * t0, d * t0);
    }
    add(ax + dx * t1, ay + dy * t1, d * (t1 - t0));
    if (t1 < 1) { endPiece(); run += d * (1 - t1); }
  }
  endPiece();
  if (run > 0 || out.length < 2 && n > 1) { // (ends off-screen: a last jump to where it really ends)
    const x = F[2 * n - 2], y = F[2 * n - 1];
    if (isFinite(x) && isFinite(y)) { out.push([farC(x), farC(y)]); lens.push(run); jumps.add(out.length - 1); }
  }
  out.lens = lens; out.jumps = jumps; out.dist = dist;
  return out;
}

function pointAt(o, f) { // -> [x, y, angle]
  const P = o.path, C = o.cum;
  if (!P || P.length < 2) return [o.x, o.y, 0];
  const target = C[C.length - 1] * clamp01(f);
  let lo = 1, hi = C.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (C[mid] < target) lo = mid + 1; else hi = mid; }
  const a = P[lo - 1], b = P[lo], d = C[lo] - C[lo - 1], k = d ? (target - C[lo - 1]) / d : 0;
  if (P.jumps && P.jumps.has(lo)) { const q = k < .5 ? a : b; return [q[0], q[1], 0]; } // a left-out stretch far off-screen: the ball stays out there
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[1] - a[1], b[0] - a[0])];
}
function ballF(o, t) {
  const prog = Math.max(0, Math.min((t - o.t) / o.span, o.slides));
  let rep = Math.floor(prog); if (rep >= o.slides) rep = o.slides - 1;
  const fr = prog - rep;
  return { f: rep % 2 ? 1 - fr : fr, back: rep % 2 === 1, rep };
}

// ============ storyboard ============
const ORIGINS = { TopLeft: [0, 0], Centre: [.5, .5], CentreLeft: [0, .5], TopRight: [1, 0], BottomCentre: [.5, 1], TopCentre: [.5, 0], Custom: [0, 0], CentreRight: [1, .5], BottomLeft: [0, 1], BottomRight: [1, 1] };
const ORIGIN_IDS = ["TopLeft", "Centre", "CentreLeft", "TopRight", "BottomCentre", "TopCentre", "Custom", "CentreRight", "BottomLeft", "BottomRight"];
const LAYERS = ["Background", "Fail", "Pass", "Foreground", "Overlay"];

const E = (() => {
  const out = f => t => 1 - f(1 - t), io = f => t => t < .5 ? f(2 * t) / 2 : 1 - f(2 - 2 * t) / 2;
  const quad = t => t * t, cub = t => t ** 3, quart = t => t ** 4, quint = t => t ** 5;
  const sine = t => 1 - Math.cos(t * Math.PI / 2), expo = t => t ? 2 ** (10 * t - 10) : 0, circ = t => 1 - Math.sqrt(Math.max(0, 1 - t * t));
  const back = t => t * t * (2.70158 * t - 1.70158);
  const bounceOut = t => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375; return n * (t -= 2.625 / d) * t + .984375; };
  const elOut = p => t => t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((p * t - .075) * (2 * Math.PI) / .3) + 1;
  const elIn = t => 1 - elOut(1)(1 - t);
  return [t => t, out(quad), quad, quad, out(quad), io(quad), cub, out(cub), io(cub), quart, out(quart), io(quart), quint, out(quint), io(quint),
    sine, out(sine), io(sine), expo, out(expo), io(expo), circ, out(circ), io(circ), elIn, elOut(1), elOut(.5), elOut(.25), io(elIn),
    back, out(back), io(back), out(bounceOut), bounceOut, io(out(bounceOut))];
})();

// ---- compact storyboards ----
// A storyboard can have tens of thousands of sprites and millions of commands (a 17 MB .osb), so it's kept as typed arrays,
// not objects: one chunk per script (the set's .osb, and the open difficulty's own events). A sprite is an index into the
// chunk's columns; its commands of one kind (F, S, V, M, MX, MY, R, C) sit together in that kind's columns (cs/ce start and
// end, ez easing, va/vb the values it goes from and to), found through cb (first) and cn (count). sbParseChunk is self-contained
// (it runs in a worker, see sbParse), the .osb is read once per set and kept across difficulties (sbLoad).
const SB_TYPES = ["F", "S", "V", "M", "MX", "MY", "R", "C"];
function sbParseChunk(text, extraVars = {}) {
  const TYPES = ["F", "S", "V", "M", "MX", "MY", "R", "C"], TI = { F: 0, S: 1, V: 2, M: 3, MX: 4, MY: 5, R: 6, C: 7 }, NA = [1, 1, 2, 2, 1, 1, 1, 3];
  const LORDER = { Background: 0, Fail: 1, Pass: 2, Foreground: 3, Overlay: 4 };
  const vars = { ...extraVars };
  // $variables, replaced in order like osu! does (a value may hold later variables), but a line that grows past 20 000
  // characters is dropped: chained values double each step and would take all the memory
  const expand = raw => { for (const k in vars) { if (raw.includes(k)) raw = raw.split(k).join(vars[k]); if (raw.length > 20000) return null; } return raw; };
  const col = TYPES.map((_, T) => ({ n: 0, cap: 1024, cs: new Float64Array(1024), ce: new Float64Array(1024), ez: new Uint8Array(1024), va: new Float32Array(1024 * NA[T]), vb: new Float32Array(1024 * NA[T]) }));
  const grow = (c, T) => { const cap = c.cap * 2, g = (A, k) => { const B = new A.constructor(cap * k); B.set(A); return B; }; c.cs = g(c.cs, 1); c.ce = g(c.ce, 1); c.ez = g(c.ez, 1); c.va = g(c.va, NA[T]); c.vb = g(c.vb, NA[T]); c.cap = cap; };
  const names = [], nameId = new Map(), frameIds = [];
  const id = n => { let k = nameId.get(n); if (k === undefined) { k = names.length; names.push(n); nameId.set(n, k); } return k; };
  const M = { layer: [], x: [], y: [], ox: [], oy: [], delay: [], flags: [], start: [], end: [], fo: [], nf: [], cb: TYPES.map(() => []), cn: TYPES.map(() => []), pOff: [0], pD: [] };
  let budget = 2e6; // (loops are copied out: a loop count of millions, or many of them, would take all the memory)
  let cur = null, loop = null, inTrigger = false, sec = "", made = 0, total = 0;
  const newCmds = () => ({ d: TYPES.map(() => []), p: [], len: 0, nc: 0 });
  const finish = s => {
    const loops = s.loops, fail = s.layer === "Fail";
    const copies = loops.map(L => { const count = Math.min(L.count, Math.floor(Math.min(1e5, budget) / Math.max(1, L.nc))); budget -= count * L.nc; return count; });
    if (fail) return;
    let st = Infinity, en = -Infinity, nc = s.nc;
    const note = (a, b) => { if (a < st) st = a; if (b > en) en = b; };
    const P = s.p.slice();
    for (let li = 0; li < loops.length; li++) { const L = loops[li], len = L.len; nc += copies[li] * L.nc;
      for (let i = 0; i < copies[li]; i++) for (let q = 0; q < L.p.length; q += 3) P.push(L.p[q] + L.start + i * len, L.p[q + 1] + L.start + i * len, L.p[q + 2]); }
    if (!nc) return;
    made++;
    M.layer.push(LORDER[s.layer] ?? 0); M.x.push(s.x); M.y.push(s.y); M.ox.push(s.origin[0]); M.oy.push(s.origin[1]); M.delay.push(s.delay); M.flags.push(s.loopOnce ? 1 : 0);
    M.fo.push(frameIds.length); M.nf.push(s.frames.length); for (const f of s.frames) frameIds.push(id(f));
    for (let q = 0; q < P.length; q += 3) { note(P[q], P[q + 1]); M.pD.push(P[q], P[q + 1], P[q + 2]); }
    M.pOff.push(M.pD.length / 3);
    for (let T = 0; T < 8; T++) {
      const n = NA[T], w = 3 + 2 * n, rec = s.d[T].slice();
      for (let li = 0; li < loops.length; li++) { const L = loops[li], len = L.len, src = L.d[T]; if (!src.length) continue;
        for (let i = 0; i < copies[li]; i++) { const sh = L.start + i * len; for (let q = 0; q < src.length; q += w) { rec.push(src[q] + sh, src[q + 1] + sh); for (let j = 2; j < w; j++) rec.push(src[q + j]); } } }
      const cnt = rec.length / w, c = col[T];
      M.cb[T].push(c.n); M.cn[T].push(cnt);
      let ord = null;
      for (let r = 1; r < cnt; r++) if (rec[r * w] < rec[(r - 1) * w]) { ord = Array.from({ length: cnt }, (_, k) => k).sort((a, b) => rec[a * w] - rec[b * w] || a - b); break; }
      while (c.n + cnt > c.cap) grow(c, T);
      for (let r = 0; r < cnt; r++) {
        const q = (ord ? ord[r] : r) * w, o = c.n + r;
        c.cs[o] = rec[q]; c.ce[o] = rec[q + 1]; c.ez[o] = rec[q + 2];
        for (let j = 0; j < n; j++) { c.va[o * n + j] = rec[q + 3 + j]; c.vb[o * n + j] = rec[q + 3 + n + j]; }
        note(rec[q], rec[q + 1]);
      }
      c.n += cnt;
    }
    total += nc;
    M.start.push(st); M.end.push(en);
  };
  for (let raw of text.split(/\r?\n/)) {
    if (raw.startsWith("//") || !raw.trim()) continue;
    const h = raw.trim().match(/^\[(.+)\]$/);
    if (h) { sec = h[1]; continue; }
    if (sec === "Variables") { const i = raw.indexOf("="); if (i > 0) { vars[raw.slice(0, i).trim()] = raw.slice(i + 1).trim(); } continue; }
    if (sec !== "Events") continue;
    if (raw.includes("$")) { raw = expand(raw); if (raw == null) continue; }
    const depth = raw.match(/^[ _]*/)[0].length;
    const p = raw.slice(depth).split(",");
    if (depth === 0) {
      if (cur) { finish(cur); cur = null; }
      loop = null; inTrigger = false;
      if (p[0] === "Sprite" || p[0] === "4" || p[0] === "Animation" || p[0] === "6") {
        const anim = p[0] === "Animation" || p[0] === "6";
        const layer = isNaN(p[1]) ? p[1] : LAYERS[+p[1]];
        const origin = ORIGINS[isNaN(p[2]) ? p[2] : ORIGIN_IDS[+p[2]]] || [.5, .5];
        const file = norm(p[3]);
        const frames = [];
        if (anim) { const dot = file.lastIndexOf("."); for (let i = 0, n = Math.min(1000, +p[6] || 1); i < n; i++) frames.push(file.slice(0, dot) + i + file.slice(dot)); }
        else frames.push(file);
        cur = Object.assign(newCmds(), { layer, origin, frames, x: +p[4] || 0, y: +p[5] || 0, delay: +p[7] || 0, loopOnce: /LoopOnce|^\s*1\s*$/.test(p[8] || ""), loops: [] });
      }
      continue;
    }
    if (!cur) continue;
    if (depth === 1) { loop = null; inTrigger = false; }
    if (inTrigger) continue;
    const type = p[0];
    if (type === "L") { loop = Object.assign(newCmds(), { start: +p[1], count: Math.max(1, +p[2] || 1) }); cur.loops.push(loop); continue; }
    if (type === "T") { inTrigger = true; continue; }
    const easing = +p[1] || 0, start = +p[2], end = p[3] === "" || p[3] === undefined ? start : +p[3];
    if (isNaN(start)) continue;
    const target = depth >= 2 && loop ? loop : cur;
    if (type === "P") { const v = (p[4] || "").trim(); target.p.push(start, end, v === "H" ? 1 : v === "V" ? 2 : v === "A" ? 3 : 0); target.nc++; if (end > target.len) target.len = end; continue; }
    const T = TI[type]; if (T === undefined) continue;
    const n = NA[T], ez = easing >= 0 && easing < 35 && Number.isInteger(easing) ? easing : 255;
    const vals = p.slice(4).map(Number);
    if (vals.length === n) vals.push(...vals.slice(0, n));
    const dur = end - start, d = target.d[T];
    for (let i = 0; i + n * 2 <= vals.length; i += n) {
      const s0 = start + dur * (i / n), e0 = s0 + dur;
      d.push(s0, e0, ez); for (let j = 0; j < n; j++) d.push(vals[i + j]); for (let j = 0; j < n; j++) d.push(vals[i + n + j]);
      target.nc++; if (e0 > target.len) target.len = e0;
    }
  }
  if (cur) finish(cur);
  // draw order: by layer, then as the script has them
  const n = made, cnt = [0, 0, 0, 0, 0, 0], ord = new Int32Array(n);
  for (let i = 0; i < n; i++) cnt[M.layer[i] + 1]++;
  for (let k = 1; k < 6; k++) cnt[k] += cnt[k - 1];
  for (let i = 0; i < n; i++) ord[cnt[M.layer[i]]++] = i;
  const pick = (A, Cls) => { const o = new Cls(n); for (let i = 0; i < n; i++) o[i] = A[ord[i]]; return o; };
  const pOff = new Int32Array(n + 1), pD = new Float64Array(M.pD.length);
  for (let i = 0, k = 0; i < n; i++) { const a = M.pOff[ord[i]], b = M.pOff[ord[i] + 1]; for (let q = a * 3; q < b * 3; q++) pD[k++] = M.pD[q]; pOff[i + 1] = pOff[i] + (b - a); }
  const start = pick(M.start, Float64Array), byStart = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => start[a] - start[b] || a - b);
  let minStart = Infinity; for (let i = 0; i < n; i++) if (start[i] < minStart) minStart = start[i];
  // the most sprites showing at once (a heavy storyboard: sbglSuggest)
  const end = pick(M.end, Float64Array), ss = start.slice().sort(), ee = end.slice().sort();
  let peak = 0; for (let i = 0, j = 0, cur = 0; i < n;) { if (ss[i] <= ee[j]) { if (++cur > peak) peak = cur; i++; } else { cur--; j++; } }
  return {
    n, total, minStart: n ? minStart : 0, peak, vars, names, frameIds: Int32Array.from(frameIds),
    layer: pick(M.layer, Uint8Array), x: pick(M.x, Float32Array), y: pick(M.y, Float32Array), ox: pick(M.ox, Float32Array), oy: pick(M.oy, Float32Array),
    delay: pick(M.delay, Float64Array), flags: pick(M.flags, Uint8Array), start, end, fo: pick(M.fo, Int32Array), nf: pick(M.nf, Int32Array),
    cb: M.cb.map(A => pick(A, Int32Array)), cn: M.cn.map(A => pick(A, Int32Array)), pOff, pD, byStart,
    cs: col.map(c => c.cs.slice(0, c.n)), ce: col.map(c => c.ce.slice(0, c.n)), ez: col.map(c => c.ez.slice(0, c.n)),
    va: col.map((c, T) => c.va.slice(0, c.n * NA[T])), vb: col.map((c, T) => c.vb.slice(0, c.n * NA[T])),
  };
}
function sbBufs(c) { const o = []; for (const k in c) { const v = c[k]; if (ArrayBuffer.isView(v)) o.push(v.buffer); else if (Array.isArray(v) && v.length && ArrayBuffer.isView(v[0])) for (const a of v) o.push(a.buffer); } return o; }
// what the page needs besides the columns: a cursor per sprite and kind (commands are asked for in time order, so the last one is
// nearly always still the right one), the sprites showing now, the picture of each name
function sbPrep(c) {
  c.cu = SB_TYPES.map(() => new Int32Array(c.n)); c.act = new Int32Array(c.n); c.tmp = new Int32Array(c.n); c.na = 0; c.sp = 0; c.lt = NaN; c.imgs = [];
  return c;
}
const sbSync = (text, vars) => sbPrep(sbParseChunk(text, vars));
const SBW = { off: typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined", url: null };
// big scripts are read in a worker (the page keeps running; a 17 MB .osb took two seconds on the page itself)
function sbParse(text, vars) {
  if (text.length < 60000 || SBW.off) return Promise.resolve(sbSync(text, vars));
  return new Promise(res => {
    let w = null, done = false, timer = 0;
    const fin = f => { if (done) return; done = true; clearTimeout(timer); try { w && w.terminate(); } catch {} res(f()); };
    try {
      if (!SBW.url) SBW.url = URL.createObjectURL(new Blob([`"use strict";const norm=${norm};const ORIGINS=${JSON.stringify(ORIGINS)},ORIGIN_IDS=${JSON.stringify(ORIGIN_IDS)},LAYERS=${JSON.stringify(LAYERS)};${sbParseChunk}\n${sbBufs}\nonmessage=e=>{const c=sbParseChunk(e.data.text,e.data.vars);postMessage(c,sbBufs(c));};`], { type: "text/javascript" }));
      w = new Worker(SBW.url);
      w.onmessage = e => fin(() => sbPrep(e.data));
      w.onerror = () => { SBW.off = true; fin(() => sbSync(text, vars)); };
      w.postMessage({ text, vars });
      timer = setTimeout(() => fin(() => sbSync(text, vars)), 90000); // (a worker that died without a word: read here after all)
    } catch { SBW.off = true; fin(() => sbSync(text, vars)); }
  });
}
// the open difficulty's storyboard: the set's .osb (read once, kept for the next difficulty) and the difficulty's own events
const SBC = { text: null, vkey: "", chunk: null, pend: null }; // (pend: a read under way, so a second asker waits for it)
async function sbLoad(osb, m) {
  const v0 = m.vars || {}, vkey = JSON.stringify(v0), chunks = [];
  let vars = { ...v0 };
  if (osb) {
    let A = SBC.chunk && SBC.text === osb && SBC.vkey === vkey ? SBC.chunk : null;
    if (!A) {
      let pend = SBC.pend; if (!(pend && pend.text === osb && pend.vkey === vkey)) pend = SBC.pend = { text: osb, vkey, p: sbParse(osb, v0) };
      A = await pend.p;
      if (SBC.pend === pend) { SBC.pend = null; SBC.chunk = A; SBC.text = osb; SBC.vkey = vkey; }
    }
    A.lt = NaN; A.imgs = []; vars = A.vars; if (A.n) chunks.push(A);
  }
  if (m.eventsRaw && /[A-Za-z0-9]/.test(m.eventsRaw)) { const B = await sbParse("[Events]\n" + m.eventsRaw, vars); if (B.n) chunks.push(B); }
  const names = new Set(); let length = 0, minStart = 0, peak = 0;
  for (const c of chunks) { length += c.n; peak += c.peak || 0; if (c.minStart < minStart) minStart = c.minStart; for (const nm of c.names) names.add(nm); }
  return { chunks, length, minStart, peak, names, uses(f) { return names.has(f); } }; // (peak: at most this many showing at once)
}
// the sprites showing at time t, in drawing order (c.act[0 .. c.na)): a playing storyboard asks for time moving on a little each frame, so
// only those that start and those that end are looked at; a jump back or far ahead goes through all of them once
function sbActive(c, t) {
  const n = c.n, st = c.start, en = c.end, act = c.act;
  if (!(t >= c.lt && t - c.lt < 5000)) {
    let k = 0; for (let i = 0; i < n; i++) if (st[i] <= t && t <= en[i]) act[k++] = i;
    c.na = k; const bs = c.byStart; let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (st[bs[mid]] <= t) lo = mid + 1; else hi = mid; } c.sp = lo;
  } else {
    let k = 0; const na = c.na; for (let i = 0; i < na; i++) { const j = act[i]; if (en[j] >= t) act[k++] = j; }
    const bs = c.byStart; let add = null;
    while (c.sp < n && st[bs[c.sp]] <= t) { const j = bs[c.sp++]; if (en[j] >= t) (add || (add = [])).push(j); }
    if (add) { // (new ones, in order, into the ones showing)
      add.sort((a, b) => a - b); const tmp = c.tmp; let i = 0, a = 0, o = 0;
      while (i < k || a < add.length) tmp[o++] = a >= add.length || (i < k && act[i] < add[a]) ? act[i++] : add[a++];
      act.set(tmp.subarray(0, o)); k = o;
    }
    c.na = k;
  }
  c.lt = t;
}
// value of a command list at time t into `out` (as many numbers as the kind has): before the first it's that one's start value, after
// it the last one's end value, in between eased
function sbEv(c, T, i, t, out) {
  const cnt = c.cn[T][i], base = c.cb[T][i], cs = c.cs[T], n = out.length, va = c.va[T], vb = c.vb[T];
  if (t < cs[base]) { const o = base * n; for (let j = 0; j < n; j++) out[j] = va[o + j]; return out; }
  let k = c.cu[T][i];
  if (k >= cnt || cs[base + k] > t) { let lo = 0, hi = cnt - 1; k = 0; while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[base + mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; } }
  while (k + 1 < cnt && cs[base + k + 1] <= t) k++;
  c.cu[T][i] = k;
  const q = base + k, e = c.ce[T][q], s = cs[q], o = q * n;
  if (t > e || e === s) { for (let j = 0; j < n; j++) out[j] = vb[o + j]; return out; }
  const f = (E[c.ez[T][q]] || E[0])((t - s) / (e - s));
  for (let j = 0; j < n; j++) out[j] = va[o + j] + (vb[o + j] - va[o + j]) * f;
  return out;
}
