"use strict";
// ============ home page: a beatmap playing on loop behind the hero (notes only: no background, no song, no sound) ============
// The map is the site owner's own (assets/home/demo.osu); no caption or credit is shown for it, on purpose.
// It has its own canvas + small renderer (the player's renderer draws on the player canvas) and always uses the osu! default skin.
const DEMO = { url: "assets/home/demo.osu?v=4", sid: null, bid: null, start: 0, map: null, cv: null, g: null, raf: 0, t0: 0, on: false, bodies: new Map(), last: 0, scale: 0 };
async function demoLoad() {
  if (DEMO.map) return DEMO.map;
  try {
    const [text] = await Promise.all([fetch(DEMO.url).then(r => r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))), DEFSK ? null : getSkin("default").then(k => { DEFSK = DEFSK || k; }, () => {})]); // (no skin files: the drawn fallback)
    DEMO.map = parseOsu(text);
    const m = DEMO.map; // from the start (the first object) to the last one, then again
    DEMO.from = Math.max(0, DEMO.start - m.preempt); DEMO.to = m.last + 900;
  } catch { DEMO.map = null; }
  return DEMO.map;
}
async function demoStart() {
  const box = $("heroDemo"); if (!box || DEMO.on || !box.getClientRects().length) return; // (only where it shows: the access page)
  DEMO.on = true;
  if (!await demoLoad() || !DEMO.on) return;
  if (!DEMO.cv) { DEMO.cv = h("canvas"); DEMO.cv.setAttribute("aria-hidden", "true"); box.append(DEMO.cv); DEMO.g = DEMO.cv.getContext("2d"); }
  const m = DEMO.map;
  DEMO.t0 = performance.now() - (DEMO.pausedAt || 0);
  cancelAnimationFrame(DEMO.raf); DEMO.raf = requestAnimationFrame(demoFrame);
}
function demoStop() {
  if (!DEMO.on) return; DEMO.on = false; cancelAnimationFrame(DEMO.raf);
  DEMO.pausedAt = performance.now() - DEMO.t0;
}
document.addEventListener("visibilitychange", () => { if (document.hidden) demoStop(); else if (R.view === "home" && UI.player.hidden) demoStart(); });
const DSK = () => DEFSK || FALLBACK;
const dPalette = ci => { const b = DEMO.map.hasColours ? DEMO.map.colours : (DSK().colors || DEFAULT_COLS); return b[((ci % b.length) + b.length) % b.length]; };
const demoTint = new Map();
function DT(name, col) {
  const t = DSK().tex[name] || FALLBACK.tex[name]; if (!t) return null;
  if (!col || !TINTED[name]) return t;
  const key = name + "|" + col.join(",");
  let c = demoTint.get(key); if (!c) { c = { img: tintCanvas(t.img, col), hd: t.hd }; demoTint.set(key, c); }
  return c;
}
function dBall(f, col) { const key = "ball|" + col.join(",") + "|" + f.img.width; let c = demoTint.get(key); if (!c) { c = { img: tintCanvas(f.img, col), hd: f.hd }; demoTint.set(key, c); } return c; }
function dBlit(g, t, x, y, s, a, rot) {
  if (!t || a <= .003) return;
  const w = t.img.width / t.hd * s, hh = t.img.height / t.hd * s; g.globalAlpha = a > 1 ? 1 : a;
  if (rot) { g.save(); g.translate(x, y); g.rotate(rot); g.drawImage(t.img, -w / 2, -hh / 2, w, hh); g.restore(); }
  else g.drawImage(t.img, x - w / 2, y - hh / 2, w, hh);
}
function dNumber(g, n, x, y, s, a) {
  const sk = DSK().numbers ? DSK() : null; if (!sk || a <= .003) return;
  g.globalAlpha = a > 1 ? 1 : a;
  const hd = sk.numHd, ov = sk.numOverlap * s * .8, digits = String(n);
  let total = 0; for (const d of digits) total += sk.numbers[+d].width / hd * s * .8;
  let cx = x - (total - ov * (digits.length - 1)) / 2;
  for (const d of digits) { const im = sk.numbers[+d], w = im.width / hd * s * .8, hh = im.height / hd * s * .8; g.drawImage(im, cx, y - hh / 2, w, hh); cx += w - ov; }
}
function dBody(o, col, px) { // legacy slider body, rendered once per slider at the current size
  const key = o.lid + "|" + px.toFixed(3);
  let b = DEMO.bodies.get(key); if (b) return b;
  const r = DEMO.map.radius; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of o.path) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  x0 -= r + 2; y0 -= r + 2; x1 += r + 2; y1 += r + 2;
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.ceil((x1 - x0) * px)); c.height = Math.max(1, Math.ceil((y1 - y0) * px));
  const g = c.getContext("2d"); g.setTransform(px, 0, 0, px, -x0 * px, -y0 * px);
  paintBody(g, o.p2d, r, { border: [255, 255, 255], outer: col.map(v => v / 1.1), inner: col.map(v => Math.min(255, v * 1.125 + 63.75)) }, 10);
  b = { c, x: x0, y: y0, w: c.width / px, h: c.height / px };
  DEMO.bodies.set(key, b); if (DEMO.bodies.size > 40) DEMO.bodies.delete(DEMO.bodies.keys().next().value);
  return b;
}
let dScratch = null;
function dBodyPart(o, col, px, from, to) { // the body from `from` to `to` (fractions of the path), not cached
  const r = DEMO.map.radius, tot = o.cum[o.cum.length - 1], L0 = tot * from, L1 = tot * to, pts = [];
  if (L0 > 0) { const p = pointAt(o, from); pts.push([p[0], p[1]]); }
  for (let i = 0; i < o.path.length; i++) { if (L0 > 0 && o.cum[i] <= L0) continue; if (o.cum[i] <= L1) pts.push(o.path[i]); else { const p = pointAt(o, to); pts.push([p[0], p[1]]); break; } }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  x0 -= r + 2; y0 -= r + 2; x1 += r + 2; y1 += r + 2;
  const cw = Math.max(1, Math.ceil((x1 - x0) * px)), ch = Math.max(1, Math.ceil((y1 - y0) * px));
  const c = dScratch || (dScratch = document.createElement("canvas")); if (c.width < cw || c.height < ch) { c.width = Math.max(c.width, cw); c.height = Math.max(c.height, ch); }
  const g = c.getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); g.setTransform(px, 0, 0, px, -x0 * px, -y0 * px);
  const path = new Path2D(); pts.forEach((q, i) => i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1])); if (pts.length === 1) path.lineTo(pts[0][0] + .01, pts[0][1]);
  paintBody(g, path, r, { border: [255, 255, 255], outer: col.map(v => v / 1.1), inner: col.map(v => Math.min(255, v * 1.125 + 63.75)) }, 8);
  return { c, x: x0, y: y0, w: cw / px, h: ch / px, sw: cw, sh: ch };
}
// the same as the player (player.js): snaking in and out, osu!'s ticks, end circles, repeat arrows, hit lighting
function dLighting(g, x, y, col, s, age) {
  if (!S.fx || age < 0 || age >= 600) return; const t = DT("lighting", col); if (!t) return;
  g.globalCompositeOperation = "lighter"; dBlit(g, t, x, y, s * (1 + .15 * age / 600), .6 * (1 - age / 600)); g.globalCompositeOperation = "source-over";
}
function dSlider(g, o, t, col, s, aIn, px) {
  const m = DEMO.map, pre = m.preempt, out = S.snakingOut !== false;
  const bodyA = t <= o.end ? aIn : clamp01(1 - (t - o.end) / (out ? 40 : 240));
  let from = 0, to = S.snaking && t < o.t ? clamp01((t - (o.t - pre)) / (pre / 3)) : 1;
  if (out && t >= o.t) { const b = ballF(o, t); if (b.rep >= o.slides - 1) { if (b.back) to = b.f; else from = b.f; } }
  if (bodyA > .003 && to - from > .0005) {
    if (from <= 0 && to >= 1) { const b = dBody(o, col, px); g.globalAlpha = bodyA; g.drawImage(b.c, b.x, b.y, b.w, b.h); }
    else { const b = dBodyPart(o, col, px, from, to); g.globalAlpha = bodyA; g.drawImage(b.c, 0, 0, b.sw, b.sh, b.x, b.y, b.w, b.h); }
  }
  // ticks: per span, appearing (tick - span start) / 2 + 0.66 preempt before (200 ms on repeats), popping when passed
  if (o.ticks && o.ticks.length) { const tk = DT("sliderscorepoint"); for (const [fr] of o.ticks) for (let k = 0; k < o.slides; k++) {
    const ss = o.t + o.span * k, tt = ss + (k % 2 ? 1 - fr : fr) * o.span, ap = tt - ((tt - ss) / 2 + (k ? 200 : pre * .66));
    if (t < ap || t >= tt + 150) continue;
    const p = pointAt(o, fr), sc = .5 + .5 * elOutHalf(clamp01((t - ap) / 600));
    if (t < tt) dBlit(g, tk, p[0], p[1], s * sc, aIn * clamp01((t - ap) / 150));
    else { const q = (t - tt) / 150; dBlit(g, tk, p[0], p[1], s * sc * (1 + .5 * easeOut(q)), aIn * (1 - (1 - (1 - q) ** 5))); }
  } }
  if (bodyA > .003 && t <= o.end) {
    if (S.sliderEnd) { const p = pointAt(o, 1); dBlit(g, DT("hitcircle", col), p[0], p[1], s, bodyA * .85); dBlit(g, DT("hitcircleoverlay"), p[0], p[1], s, bodyA * .85); }
    if (o.slides > 1 && to >= 1) {
      const cur = t < o.t ? 0 : ballF(o, t).rep, arrow = atEnd => { const p = pointAt(o, atEnd ? 1 : 0), q = pointAt(o, atEnd ? .97 : .03); dBlit(g, DT("reversearrow"), p[0], p[1], s, bodyA, Math.atan2(q[1] - p[1], q[0] - p[0])); };
      if (cur < o.slides - 1) arrow(cur % 2 === 0);
      if (cur + 1 < o.slides - 1) arrow(cur % 2 === 1);
    }
  }
  if (t >= o.t && t <= o.end) {
    const bf = ballF(o, t), p = pointAt(o, bf.f), fin = easeOut(clamp01((t - o.t) / 180));
    const fr = DSK().frames.sliderb || FALLBACK.frames.sliderb, f0 = fr[Math.floor((t - o.t) * (o.vel || .2) / 4) % fr.length];
    dBlit(g, DT("sliderb-nd"), p[0], p[1], s, 1); dBlit(g, DSK().tintBall ? dBall(f0, col) : f0, p[0], p[1], s, 1, p[2] + (bf.back ? Math.PI : 0));
    dBlit(g, DT("sliderfollowcircle"), p[0], p[1], s * (.5 + .5 * fin), fin);
  } else if (t > o.end) {
    const e = pointAt(o, o.slides % 2 ? 1 : 0), age = t - o.end;
    if (age < 200) dBlit(g, DT("sliderfollowcircle"), e[0], e[1], s * (1 - .2 * age / 200), 1 - age / 200);
    dLighting(g, e[0], e[1], col, s, age);
  }
}
// spinners as in the player (player.js drawSpinner): spinning like autoplay, the glow and the middle reddening as it
// fills, "spin" at the start and "clear" once full
function dSpinner(g, o, t) {
  if (t < o.t - 400 || t > o.end + 800) return;
  const a = t < o.t ? clamp01((t - (o.t - 400)) / 400) : t > o.end ? clamp01(1 - (t - o.end) / 240) : 1;
  const dur = Math.max(1, o.end - o.t), e = Math.max(0, Math.min(t, o.end) - o.t);
  const rot = e * .05 - 6 * (1 - Math.exp(-e / 400)), prog = clamp01(e / Math.min(dur, 1500)), SC = .625, cx = 256, cy = 192, K = DSK();
  if (a > 0) {
    if (K.newSpinner) {
      g.globalCompositeOperation = "lighter"; dBlit(g, DT("spinner-glow", [3, 151, 255]), cx, cy, SC, a * prog); g.globalCompositeOperation = "source-over";
      dBlit(g, DT("spinner-bottom"), cx, cy, SC, a, rot / 3);
      dBlit(g, DT("spinner-top"), cx, cy, SC, a, rot);
      const mid = DT("spinner-middle"); if (mid) { const q = Math.round(255 * (1 - prog) / 16) * 16; let c = demoTint.get("mid|" + q); if (!c) { c = { img: tintCanvas(mid.img, [255, q, q]), hd: mid.hd }; demoTint.set("mid|" + q, c); } dBlit(g, prog > .02 ? c : mid, cx, cy, SC, a); }
      dBlit(g, DT("spinner-middle2"), cx, cy, SC, a);
    } else {
      dBlit(g, DT("spinner-background"), cx, cy + 12, SC, a);
      dBlit(g, DT("spinner-circle"), cx, cy, SC, a, rot);
    }
    if (t >= o.t && t <= o.end) dBlit(g, DT("spinner-approachcircle"), cx, cy, SC * (1.86 - 1.76 * (e / dur)), a * .9);
  }
  if (t < o.t + 500) dBlit(g, DT("spinner-spin"), cx, cy + 110, SC, t < o.t ? a : 1 - (t - o.t) / 500);
  if (prog >= 1 && t <= o.end + 400) { const age = Math.max(0, t - (o.t + Math.min(dur, 1500))); dBlit(g, DT("spinner-clear"), cx, cy - 90, SC * (1.1 - .1 * clamp01(age / 150)), clamp01(age / 100) * a); }
}
function demoFrame(now) {
  if (!DEMO.on) return;
  DEMO.raf = requestAnimationFrame(demoFrame);
  if (now - DEMO.last < 1000 / Math.min(S.fps, 60) - 1) return; // the home page never needs more than 60 FPS
  DEMO.last = now;
  const cv = DEMO.cv, box = cv.parentElement, dpr = Math.min(devicePixelRatio || 1, 1.5);
  const W = Math.round(box.clientWidth * dpr), H = Math.round(box.clientHeight * dpr); if (!W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const m = DEMO.map, g = DEMO.g, span = DEMO.to - DEMO.from;
  const t = DEMO.from + (RM ? m.preempt : ((now - DEMO.t0) % span + span) % span);
  const sc = Math.min(W / 600, H / 440), px = sc, ox = (W - 512 * sc) / 2, oy = (H - 384 * sc) / 2;
  if (Math.abs(px - DEMO.scale) > .001) { DEMO.scale = px; DEMO.bodies.clear(); }
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
  g.setTransform(sc, 0, 0, sc, ox, oy);
  const Hs = m.hit, pre = m.preempt, s = m.radius / 64, hi = lastBefore(Hs, t + pre, "t");
  let lo = hi; while (lo > 0 && Hs[lo - 1].t > t - 20000) lo--;
  // follow points
  const fp = DT("followpoint");
  if (fp) for (let i = Math.max(1, lo); i <= hi; i++) {
    const b = Hs[i], a = Hs[i - 1]; if (b.nc || a.kind === "spinner" || b.kind === "spinner" || t > b.t || t < a.end - 800) continue;
    const pa = a.kind === "slider" ? pointAt(a, a.slides % 2 ? 1 : 0) : [a.x, a.y], dx = b.x - pa[0], dy = b.y - pa[1], dist = Math.hypot(dx, dy); if (dist < 48) continue;
    const ang = Math.atan2(dy, dx);
    for (let d = 48; d < dist - 32; d += 32) { const f = d / dist, out = a.end + f * (b.t - a.end); if (t < out - 800 || t > out + 200) continue; dBlit(g, fp, pa[0] + dx * f, pa[1] + dy * f, 1, t > out ? 1 - (t - out) / 200 : clamp01((t - out + 800) / 300), ang); }
  }
  for (let i = hi; i >= lo; i--) {
    const o = Hs[i]; if (o.end + 600 < t) continue;
    const col = dPalette(o.ci), aIn = clamp01((t - (o.t - pre)) / m.fadeIn);
    if (o.kind === "spinner") { dSpinner(g, o, t); continue; }
    if (o.kind === "slider") dSlider(g, o, t, col, s, aIn, px);
    if (t < o.t) { // head + approach circle
      const head = o.kind === "slider" && !!DSK().tex.sliderstartcircle ? "sliderstartcircle" : "hitcircle";
      dBlit(g, DT(head, col), o.x, o.y, s, aIn); dBlit(g, DT("hitcircleoverlay"), o.x, o.y, s, aIn); dNumber(g, o.num, o.x, o.y, s, aIn);
      dBlit(g, DT("approachcircle", col), o.x, o.y, s * (1 + 3 * (o.t - t) / pre), clamp01((t - (o.t - pre)) / Math.min(pre, m.fadeIn * 2)) * .9);
    } else { // hit burst (circle grows 1 -> 1.4 and fades in 240 ms) and hit lighting
      if (t - o.t < 240) { const k = (t - o.t) / 240, bs = s * (1 + .4 * easeOut(k)), head = o.kind === "slider" && !!DSK().tex.sliderstartcircle ? "sliderstartcircle" : "hitcircle";
        dBlit(g, DT(head, col), o.x, o.y, bs, 1 - k); dBlit(g, DT("hitcircleoverlay"), o.x, o.y, bs, 1 - k); }
      dLighting(g, o.x, o.y, col, s, t - o.t);
    }
  }
  g.globalAlpha = 1;
  if (RM) { cancelAnimationFrame(DEMO.raf); DEMO.on = false; } // reduced motion: one still frame
}

// home page keys, as the tiles show them: B Beatmaps, E Editor, N new beatmap, O open a .osz, / the search box (also on Beatmaps)
addEventListener("keydown", e => {
  if (!/^(home|songs)$/.test(R.view) || !UI.player.hidden || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const vis = el => el && !el.closest("[hidden]") && el.getClientRects().length;
  if (R.view === "songs") { if (e.key === "/" && vis($("q"))) { e.preventDefault(); $("q").focus(); } return; } // (Beatmaps: / is the search box)
  if (document.querySelector(".mdl:not([hidden]),#detail:not([hidden])")) return;
  const go = { KeyB: ".htile.songs", KeyE: ".htile.editor", KeyN: ".hcard.new", KeyO: "#homeOpen" }[e.code];
  if (go) { const el = document.querySelector(go); if (vis(el)) { e.preventDefault(); el.click(); } return; }
  if (e.key === "/" && vis($("homeQ"))) { e.preventDefault(); $("homeQ").focus(); }
});

// the home tiles' big numbers drift a little with the pointer (CSS reads --mx / --my, from -1 to 1)
document.querySelectorAll(".htile").forEach(t => {
  t.addEventListener("pointermove", e => { if (e.pointerType !== "mouse") return; const r = t.getBoundingClientRect(); t.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 2 - 1).toFixed(3)); t.style.setProperty("--my", ((e.clientY - r.top) / r.height * 2 - 1).toFixed(3)); });
  t.addEventListener("pointerleave", () => { t.style.removeProperty("--mx"); t.style.removeProperty("--my"); });
});
