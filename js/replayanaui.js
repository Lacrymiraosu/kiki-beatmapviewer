"use strict";
// ============ replay analysis (the Analysis layer of the results screen and the end menu) ============
// Loaded on first use (loadLazy("replayanaui"), js/replayui.js rpuAnalysis) together with js/replayana.js (rpAnalyze, pure functions).
// A full-screen layer over the results / end menu with four tabs, drawn on <canvas>: Timing (hit error bar, histogram, hit time against
// error), Aim (where on the circle the cursor was), Cursor (heat map, speed over time) and Keys (presses per key, press intervals).
// Everything is an ESTIMATE from the replay's inputs and the map: the layer says so and shows how close it is to the replay's own counts.
// The analysis runs once per session and map (cached on the session as s.ana); switching tabs never recomputes. Only transform and
// opacity move; the entrance and the tab fade are skipped under reduced motion (rpuRM, js/replayui.js).
const RPAN = { el: null, inn: null, s: null, opener: null, tok: 0, state: "", msg: "", ana: null, tab: 0, panels: [], tabs: [], charts: [], ro: null, ff: "Inter,system-ui,sans-serif", fade: 0, dens: false, objs: false };
const RPAN_TABS = ["timing", "aim", "cursor", "keys"];
const RPAN_C = { ink: "#e9ebf7", dim: "#9ba1bd", mute: "#8b91ad", grid: "rgba(255,255,255,.09)", j: { 300: "#32bce7", 100: "#57e313", 50: "#ffcc22", 0: "#ff4d5e" }, vio: "#c26bff", ice: "#9fb8f5", teal: "#8fdad3" };
const rpanN = v => (v != null && v !== "" && Number.isFinite(+v) ? +v : null);
const rpanMs = (v, d) => (v < 0 ? "−" : v > 0 ? "+" : "") + Math.abs(v).toFixed(d == null ? 1 : d) + " ms";
const rpanTime = t => { const a = Math.max(0, t) / 1000, m = Math.floor(a / 60), s = a - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(3); };
const rpanTick = t => { const a = Math.max(0, Math.round(t / 1000)), m = Math.floor(a / 60); return m + ":" + String(a % 60).padStart(2, "0"); };
const rpanFont = (px, w) => `${w || 600} ${px}px ${RPAN.ff}`;
const rpanQ = () => ({ good: tr("good"), fair: tr("fair"), poor: tr("poor") });
function rpanRadius(s, map) { // (the circle's radius in osu!px for the replay's own EZ / HR: map.radius is the plain one on the results screen, the changed one in the end menu)
  try {
    const d = map.diff || {}, m = replayMods(s.data.mods, s.data.lazerInfo);
    const cs = replayDiff({ CircleSize: +(d.CircleSize ?? 5), ApproachRate: +(d.ApproachRate ?? d.OverallDifficulty ?? 5), OverallDifficulty: +(d.OverallDifficulty ?? 5), HPDrainRate: +(d.HPDrainRate ?? 5) }, m).cs;
    return 64 * (1 - .7 * (cs - 5) / 5) / 2 * 1.00041;
  } catch { return map && map.radius > 0 ? map.radius : 36; }
}

// ---------- opening and closing ----------
async function rpanOpen(s, opener) {
  if (RPAN.el || !s) return;
  RPAN.s = s; RPAN.opener = opener || document.activeElement; RPAN.state = "busy"; RPAN.msg = tr("Loading the beatmap…"); RPAN.ana = null; RPAN.tab = 0; RPAN.dens = RPAN.objs = false;
  try { RPAN.ff = getComputedStyle(document.body).fontFamily || RPAN.ff; } catch {}
  const el = RPAN.el = h("div", "rpan" + (rpuRM() ? "" : " rpanin0")); RPAN.inn = h("div", "rpanin");
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "rpanTitle");
  const bg = h("div", "rpbg"), cov = s.bgURL || rpuCover(s, "cover"); if (cov) bg.style.backgroundImage = `url("${cov}")`;
  el.append(bg, RPAN.inn); document.body.append(el);
  rpanInert(true); rpanPaint();
  const b = el.querySelector(".rpanback"); b && b.focus({ preventScroll: true });
  el.addEventListener("pointerdown", e => { if (!(e.target.closest && e.target.closest("canvas"))) rpanUnhoverAll(); });
  RPAN.ro = typeof ResizeObserver === "function" ? new ResizeObserver(es => { for (const e of es) { const ch = e.target.__ch; if (ch && ch.panel === RPAN.tab) rpanDraw(ch); } }) : null;
  rpanRun(s, ++RPAN.tok);
}
function rpanInert(on) { for (const e of [RPU.res, RPU.end]) if (e) e.inert = on; }
function rpanClose(quiet) { // (quiet: another layer takes the focus)
  const el = RPAN.el; if (!el) return;
  RPAN.el = RPAN.inn = null; RPAN.tok++; if (RPAN.ro) { RPAN.ro.disconnect(); RPAN.ro = null; } RPAN.charts = []; RPAN.panels = []; RPAN.tabs = [];
  rpanInert(false);
  if (!quiet && !rpuRM() && el.animate) { el.inert = true; el.style.pointerEvents = "none"; el.animate({ opacity: [1, 0] }, { duration: 140, easing: "ease-in", fill: "forwards" }).finished.then(() => el.remove(), () => el.remove()); } else el.remove();
  if (!quiet) { // (back to the button that opened it, else the layer's own main button)
    const o = RPAN.opener, t = o && o.isConnected && !o.closest("[inert]") ? o : (RPU.res && RPU.res.querySelector(".rpanbtn")) || (RPU.end && RPU.end.querySelector(".rpanbtn"));
    if (t) t.focus({ preventScroll: true });
  }
  RPAN.opener = null;
}
const rpanYield = () => new Promise(res => { let d = false; const go = () => { if (!d) { d = true; res(); } }; requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 160); }); // (the "Analysing…" state is on screen before the compute)
async function rpanRun(s, tok) {
  const stale = () => RPAN.tok !== tok || !RPAN.el;
  if (RPU.busy) { RPAN.state = "fail"; RPAN.msg = tr("Something is loading, try again in a moment"); return rpanPaint(); }
  let ok = false;
  RPU.busy = true;
  try {
    const had = rpuLoaded(s);
    ok = await rpuEnsureMap(s);
    if (ok && !had && !s.watched && !s.preLeave) { try { R.leaving = s.preLeave = true; } catch {} } // (the map opened behind the results: Back from them is not leaving a map the person opened)
  } catch { ok = false; } finally { RPU.busy = false; }
  if (stale()) return;
  if (!ok) { RPAN.state = "nomap"; return rpanPaint(); }
  let ana = s.ana && s.ana.map === map ? s.ana : null;
  if (!ana) {
    RPAN.state = "busy"; RPAN.msg = tr("Analysing…"); rpanPaint();
    await rpanYield(); if (stale()) return;
    const md5 = await rpuMd5(s); if (stale()) return; // (of the raw .osu bytes: the engine adds the warning md5_mismatch)
    const exact = !md5 || !rpuHex32(s.data.mapMd5) || md5 === s.data.mapMd5;
    try {
      const mods = replayMods(s.data.mods, s.data.lazerInfo), a = rpAnalyze(s.data, map, mods, { md5 });
      ana = s.ana = { a, map, exact, mods, radius: rpanN(a.radius) > 0 ? +a.radius : rpanRadius(s, map) };
    } catch { RPAN.state = "fail"; RPAN.msg = tr("The analysis couldn't be made from this replay"); return rpanPaint(); }
  }
  if (stale()) return;
  RPAN.ana = ana; RPAN.state = !ana.a || ana.a.ok === false || !Array.isArray(ana.a.hits) ? "fail" : "ready";
  if (RPAN.state === "fail") RPAN.msg = rpanWhy(ana.a && ana.a.warn) || tr("The analysis couldn't be made from this replay and map");
  rpanPaint(RPAN.state === "ready" && !rpuRM());
}
// the engine's warning codes as sentences (an unknown code is shown as it is)
function rpanWhy(codes) {
  const T = { no_data: tr("This replay has no data to analyse"), no_frames: tr("This replay has no cursor movement recorded"), no_map: tr("The beatmap isn't loaded"), no_objects: tr("The beatmap has no objects to hit"),
    mode: tr("Only osu!standard replays can be analysed"), error: tr("Something went wrong while analysing this replay"), few_objects: tr("There are very few hits to measure, so the numbers are rough"),
    short_replay: tr("The replay ends before the end of the map, so the last objects count as misses"), md5_mismatch: tr("This map was updated since the replay was made; the analysis may be off") };
  return (Array.isArray(codes) ? codes : []).map(c => T[c] || tr("Notes from the analysis: {w}", { w: c })).join(". ");
}
addEventListener("langchange", () => { if (RPAN.el) { rpanInert(true); rpanPaint(); } });

// ---------- the layer ----------
function rpanPaint(fade) {
  const inn = RPAN.inn, s = RPAN.s; if (!inn) return;
  if (RPAN.ro) RPAN.ro.disconnect();
  RPAN.charts = []; RPAN.panels = []; RPAN.tabs = [];
  const keep = inn.contains(document.activeElement) ? document.activeElement.className : "";
  inn.replaceChildren();
  const i = s.info, d = s.data, mods = replayMods(d.mods, d.lazerInfo);
  const head = h("div", "rpanhd"), back = h("button", "btn ghost rpanback", "← " + tr("Back")); back.type = "button"; back.onclick = () => rpanClose();
  const tt = h("div", "rpanttl"), h2 = h("h2", null, tr("Replay analysis")); h2.id = "rpanTitle";
  const sub = h("p", "rpansub", [i.title ? (i.artist ? i.artist + " - " : "") + i.title : "", i.version ? "[" + i.version + "]" : "", d.player || ""].filter(Boolean).join(" · "));
  tt.append(h2, sub); if (mods.list.length) tt.append(rpuChips(mods.list, mods.unsupported));
  head.append(back, tt); inn.append(head);
  const st = RPAN.state;
  if (st !== "ready") {
    const box = h("div", "rpanstate " + st); box.setAttribute("role", "status");
    box.append(h("p", null, st === "nomap" ? tr("The analysis needs the replay's beatmap. It isn't loaded.") : RPAN.msg));
    if (st === "busy") { const bar = h("div", "rpanbar"); bar.setAttribute("aria-hidden", "true"); box.append(bar); }
    else {
      const row = h("div", "rpanrow"), again = h("button", "btn main", tr("Try again")); again.type = "button"; again.onclick = () => { RPAN.state = "busy"; RPAN.msg = tr("Loading the beatmap…"); rpanPaint(); rpanRun(RPAN.s, ++RPAN.tok); };
      row.append(again); box.append(row);
    }
    inn.append(box); return;
  }
  const A = RPAN.ana, a = A.a;
  const warns = [], ws = a.warn || [];
  if (!A.exact || ws.includes("md5_mismatch")) warns.push(rpanWhy(["md5_mismatch"]));
  for (const c of ws) if (c !== "md5_mismatch") warns.push(rpanWhy([c]));
  for (const w of warns) { const p = h("p", "rpanwarn", w); p.setAttribute("role", "status"); inn.append(p); }
  const tabs = h("div", "rpantabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", tr("Analysis"));
  const names = [tr("Timing"), tr("Aim"), tr("Cursor"), tr("Keys")], body = h("div", "rpanbody");
  const builders = [rpanTiming, rpanAim, rpanCursor, rpanKeys];
  RPAN_TABS.forEach((k, n) => {
    const t = h("button", "rpantab", names[n]); t.type = "button"; t.id = "rpanTab" + n; t.setAttribute("role", "tab"); t.setAttribute("aria-controls", "rpanPanel" + n);
    t.onclick = () => rpanTab(n, true); tabs.append(t); RPAN.tabs.push(t);
    const p = h("section", "rpanpanel"); p.id = "rpanPanel" + n; p.setAttribute("role", "tabpanel"); p.setAttribute("aria-labelledby", t.id); p.hidden = true;
    try { builders[n](p, A, n); } catch (e) { p.append(h("p", "rpanwarn", tr("This part couldn't be drawn"))); }
    body.append(p); RPAN.panels.push(p);
  });
  const q = a.consistency && a.consistency.quality, foot = h("div", "rpanfoot");
  foot.append(h("p", "rpannote", tr("Estimated from the replay's inputs and the map. The score itself comes from the replay.")));
  if (q) { const c = h("p", "rpancons q-" + q, tr("Matches the replay's counts: {q}", { q: rpanQ()[q] || q })); foot.append(c); }
  inn.append(tabs, body, foot);
  rpanTab(RPAN.tab, false, true);
  if (fade && body.animate) body.animate({ opacity: [0, 1], transform: ["translateY(10px)", "none"] }, { duration: 320, easing: "cubic-bezier(.2,.7,.2,1)" });
  if (keep) { const k = RPAN.el.querySelector("." + keep.split(" ").join(".")); k && k.focus({ preventScroll: true }); }
}
// the panels are REUSED: an animation that fills "forwards" (the fade-out) outlives its run and would pin the panel at opacity 0 the next time it is shown
// (the newer rise has no fill, so the old fill came back after 220 ms and the data "disappeared"). So every animation is cancelled once a panel is hidden or shown.
const rpanStill = p => { try { for (const a of p.getAnimations()) a.cancel(); } catch {} };
function rpanTab(n, focus, still) {
  n = (n + 4) % 4; const old = RPAN.panels[RPAN.tab], neu = RPAN.panels[n]; if (!neu) return;
  const same = old === neu && !neu.hidden;
  RPAN.tab = n; const tok = ++RPAN.fade;
  RPAN.tabs.forEach((t, k) => { t.setAttribute("aria-selected", k === n); t.tabIndex = k === n ? 0 : -1; t.classList.toggle("on", k === n); });
  if (focus) RPAN.tabs[n].focus({ preventScroll: true });
  rpanUnhoverAll();
  const fade = !still && old && old !== neu && !old.hidden && !rpuRM() && old.animate; // (a fade-out leaves the old tab at opacity 0 until show() hides it)
  const from = fade ? parseFloat(getComputedStyle(old).opacity) : 1; // (a tab that was still rising fades from where it is)
  RPAN.panels.forEach(rpanStill); // (nothing left over from an earlier switch)
  const show = () => {
    if (RPAN.fade !== tok) return;
    RPAN.panels.forEach(p => { p.hidden = p !== neu; rpanStill(p); }); // (hidden first, then the fill is dropped: no flash of the old tab)
    for (const ch of RPAN.charts) if (ch.panel === n) rpanDraw(ch, true);
    if (!still && !same && !rpuRM() && neu.animate) neu.animate({ opacity: [0, 1], transform: ["translateY(8px)", "none"] }, { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)" }); // (no fill: it ends on the panel's own style)
  };
  if (fade) { old.animate({ opacity: [Number.isFinite(from) ? from : 1, 0] }, { duration: 90, easing: "ease-in", fill: "forwards" }).finished.then(show, show); } // (the old tab fades out, the new one rises in)
  else show();
}
// keys while the layer is up (js/replayui.js hands them over): Esc closes, Left / Right / Home / End switch the tabs, Tab stays inside
function rpanKey(e) {
  if (!RPAN.el) return false;
  const k = e.key;
  if (k === "Escape") { e.preventDefault(); rpanClose(); return true; }
  if (RPAN.state !== "ready") { if (k === "Tab") return rpanTrap(e); return false; }
  if (k === "ArrowRight" || k === "ArrowLeft") { e.preventDefault(); rpanTab(RPAN.tab + (k === "ArrowRight" ? 1 : -1), true); return true; }
  if (k === "Home" || k === "End") { e.preventDefault(); rpanTab(k === "Home" ? 0 : 3, true); return true; }
  if (k === "Tab") return rpanTrap(e);
  return false;
}
function rpanTrap(e) { // (aria-modal: Tab goes round inside the layer)
  const f = [...RPAN.el.querySelectorAll("button:not([disabled]),[tabindex='0']")].filter(x => x.getClientRects().length && x.tabIndex >= 0);
  if (!f.length) { e.preventDefault(); return true; }
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); return true; }
  if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); return true; }
  return false;
}

// ---------- charts ----------
function rpanChart(parent, panel, o) { // o: { title, label, height(W), draw(ch, c, W, H), hover(ch, x, y), hint }
  const fig = h("figure", "rpanfig"), wrap = h("div", "rpanwrap"), cv = h("canvas"), tip = h("div", "rpantip");
  if (o.title) { const cap = h("figcaption"); cap.append(h("b", null, o.title)); if (o.hint) cap.append(h("small", null, o.hint)); fig.append(cap); }
  cv.setAttribute("role", "img"); cv.setAttribute("aria-label", o.label || o.title || ""); tip.hidden = true; tip.setAttribute("aria-hidden", "true");
  wrap.append(cv, tip); fig.append(wrap); parent.append(fig);
  const ch = { cv, wrap, tip, o, panel, W: 0, H: 0, dpr: 0, hv: null, key: "" };
  wrap.__ch = ch; RPAN.charts.push(ch); if (RPAN.ro) RPAN.ro.observe(wrap);
  if (o.hover) {
    const move = e => { const r = cv.getBoundingClientRect(); o.hover(ch, e.clientX - r.left, e.clientY - r.top); };
    cv.addEventListener("pointermove", move); cv.addEventListener("pointerdown", move);
    cv.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") rpanUnhover(ch); });
    cv.addEventListener("pointercancel", () => rpanUnhover(ch));
  }
  return ch;
}
function rpanDraw(ch, force) {
  const r = ch.wrap.getBoundingClientRect(), W = r.width; if (W < 40) return;
  const H = Math.round(ch.o.height(W)), dpr = Math.min(3, window.devicePixelRatio || 1), key = W.toFixed(1) + "x" + H + "@" + dpr + (ch.hv != null ? "h" + ch.hv : "");
  if (!force && key === ch.key && ch.hv == null) return;
  ch.key = key;
  if (W !== ch.W || H !== ch.H || dpr !== ch.dpr) { ch.W = W; ch.H = H; ch.dpr = dpr; ch.cv.style.height = H + "px"; ch.cv.width = Math.round(W * dpr); ch.cv.height = Math.round(H * dpr); }
  const c = ch.cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H); c.lineWidth = 1; c.textBaseline = "alphabetic";
  ch.o.draw(ch, c, W, H);
}
function rpanUnhover(ch) { if (ch.hv == null && ch.tip.hidden) return; ch.hv = null; ch.tip.hidden = true; ch.key = ""; rpanDraw(ch, true); }
function rpanUnhoverAll() { for (const ch of RPAN.charts) rpanUnhover(ch); }
function rpanTip(ch, x, y, lines) { // (inside the chart's box: never wider than it)
  const t = ch.tip; t.replaceChildren(); lines.forEach((l, k) => t.append(h(k ? "span" : "b", null, l))); t.hidden = false;
  const w = t.offsetWidth, hh = t.offsetHeight;
  t.style.left = Math.round(Math.max(0, Math.min(ch.W - w, x + 12))) + "px"; t.style.top = Math.round(y - hh - 12 < 0 ? Math.min(ch.H - hh, y + 16) : y - hh - 12) + "px";
}
function rpanText(c, txt, x, y, col, px, align, w) { c.font = rpanFont(px || 11, w); c.fillStyle = col || RPAN_C.dim; c.textAlign = align || "left"; c.fillText(txt, x, y); }
function rpanBands(c, x0, x1, y0, y1, win, fx) { // (the 50 / 100 / 300 windows as bands around zero; fx maps ms to x, horizontal bands when y0..y1 are the ms)
  for (const [w, col] of [[win.w50, "rgba(255,204,34,.16)"], [win.w100, "rgba(87,227,19,.15)"], [win.w300, "rgba(50,188,231,.2)"]]) { c.fillStyle = col; c.fillRect(fx(-w), y0, fx(w) - fx(-w), y1 - y0); }
}
const rpanOkHits = a => (a.hits || []).filter(h => h.err != null);
const rpanWin = a => { const w = a.windows || {}; return { w300: rpanN(w.w300) || 30, w100: rpanN(w.w100) || 70, w50: rpanN(w.w50) || 110 }; };
const rpanJudge = j => (j === 300 || j === 100 || j === 50 ? j : 0);
function rpanTile(label, value, sub, cls) { const t = h("div", "rpanst" + (cls ? " " + cls : "")); t.append(h("small", null, label), h("b", null, value)); if (sub) t.append(h("em", null, sub)); return t; }
function rpanSum(parent, text) { parent.append(h("p", "rpansum", text)); }
function rpanCard(parent, cls) { const c = h("div", "rpancard" + (cls ? " " + cls : "")); parent.append(c); return c; }
const rpanBpm = ms => (ms > 0 ? Math.round(15000 / ms) : 0); // (a gap in real ms as BPM of 1/4 notes)

// ---------- Timing ----------
function rpanTiming(p, A) {
  const a = A.a, S = a.stats || {}, win = rpanWin(a), hits = rpanOkHits(a), rate = rpanN(a.rate) || 1, mean = rpanN(S.mean), ur = rpanN(S.ur), sd = rpanN(S.sd);
  const early = rpanN(S.early) || 0, late = rpanN(S.late) || 0;
  rpanSum(p, mean == null ? tr("There are no timed hits to show.") : tr("On average your hits were {ms} ms {dir}. Unstable Rate {ur}. {e} early, {l} late.", { ms: Math.abs(mean).toFixed(1), dir: mean < 0 ? tr("early") : tr("late"), ur: ur == null ? "-" : ur.toFixed(1), e: early, l: late }));
  const tiles = h("div", "rpantiles");
  tiles.append(rpanTile(tr("Mean error"), mean == null ? "-" : rpanMs(mean), mean == null ? "" : mean < 0 ? tr("early") : tr("late")));
  tiles.append(rpanTile(tr("Unstable Rate"), ur == null ? "-" : ur.toFixed(1), rate !== 1 ? tr("Adjusted for the {rate}x speed", { rate }) : tr("Lower is steadier")));
  tiles.append(rpanTile(tr("Early / Late"), early + " / " + late, early + late ? tr("{p}% early", { p: Math.round(100 * early / (early + late)) }) : ""));
  tiles.append(rpanTile(tr("Spread (SD)"), sd == null ? "-" : "±" + sd.toFixed(1) + " ms", S.median != null ? tr("Median {ms}", { ms: rpanMs(S.median) }) : ""));
  p.append(tiles);
  const R = win.w50 + 6, md = mean;
  const bar = rpanChart(rpanCard(p), 0, { title: tr("Hit error bar"), hint: tr("Each line is one hit. Left is early, right is late."), label: tr("Hit error bar: where each hit fell between early and late"), height: () => 92,
    draw(ch, c, W, H) {
      const L = 16, T = 12, fx = ms => L + (ms + R) / (2 * R) * (W - 2 * L), y0 = 22, bh = 34;
      rpanBands(c, 0, W, y0, y0 + bh, win, fx);
      for (const h of hits) { c.strokeStyle = RPAN_C.j[rpanJudge(h.judge)]; c.globalAlpha = .5; const x = Math.round(fx(Math.max(-R, Math.min(R, h.err)))) + .5; c.beginPath(); c.moveTo(x, y0 + 3); c.lineTo(x, y0 + bh - 3); c.stroke(); }
      c.globalAlpha = 1; c.strokeStyle = "rgba(255,255,255,.55)"; c.beginPath(); c.moveTo(Math.round(fx(0)) + .5, y0 - 4); c.lineTo(Math.round(fx(0)) + .5, y0 + bh + 4); c.stroke();
      if (md != null) { const mx = fx(Math.max(-R, Math.min(R, md))); c.fillStyle = "#fff"; c.beginPath(); c.moveTo(mx, y0 + bh + 3); c.lineTo(mx - 5, y0 + bh + 11); c.lineTo(mx + 5, y0 + bh + 11); c.closePath(); c.fill(); c.fillRect(Math.round(mx) - .5, y0 - 2, 1.5, bh + 4); }
      rpanText(c, tr("Early"), L, T - 1, RPAN_C.ice, 11, "left", 700); rpanText(c, tr("Late"), W - L, T - 1, "#e0b3ff", 11, "right", 700);
      let right = -1e9; for (const v of [-win.w50, -win.w100, -win.w300, 0, win.w300, win.w100, win.w50]) { const x = fx(v), lab = (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) + (v === 0 ? " ms" : ""); c.font = rpanFont(10.5, 600); const wd = c.measureText(lab).width; if (x - wd / 2 < right + 6 || x - wd / 2 < 0 || x + wd / 2 > W) continue; right = x + wd / 2; rpanText(c, lab, x, H - 4, RPAN_C.mute, 10.5, "center"); }
    } });
  const row = h("div", "rpan2"); p.append(row);
  // histogram
  const ae = hits.map(h => Math.abs(h.err)).sort((x, y) => x - y), RH = Math.min(R, Math.max(win.w300 + 6, Math.ceil(((ae[Math.floor(ae.length * .995)] || 0) + 8) / 4) * 4)); // (the histogram zooms to where the hits are, up to the 50 window)
  const hist = rpanChart(rpanCard(row), 0, { title: tr("Error histogram"), label: tr("Histogram of the hit errors"), height: W => (W < 480 ? 150 : 180),
    draw(ch, c, W, H) {
      const R = RH, L = 8, B = H - 22, T = 14, bw = Math.max(1, Math.round(2 * R / Math.floor(Math.max(8, (W - 2 * L) / 6)))), n = Math.ceil(2 * R / bw), cnt = new Float32Array(n);
      for (const h of hits) { const k = Math.floor((Math.max(-R, Math.min(R - 1e-6, h.err)) + R) / bw); cnt[k]++; }
      let mx = 1; for (const v of cnt) mx = Math.max(mx, v);
      const fx = ms => L + (ms + R) / (2 * R) * (W - 2 * L), px = (W - 2 * L) / n;
      for (let k = 0; k < n; k++) { if (!cnt[k]) continue; const mid = -R + (k + .5) * bw, a_ = Math.abs(mid), col = a_ <= win.w300 ? RPAN_C.j[300] : a_ <= win.w100 ? RPAN_C.j[100] : RPAN_C.j[50], hh = (B - T) * cnt[k] / mx; c.fillStyle = col; c.globalAlpha = .88; c.fillRect(L + k * px + .5, B - hh, Math.max(1, px - 1), hh); }
      c.globalAlpha = 1; c.strokeStyle = RPAN_C.grid; c.beginPath(); c.moveTo(L, B + .5); c.lineTo(W - L, B + .5); c.stroke();
      if (md != null && sd) { c.strokeStyle = "rgba(255,255,255,.55)"; c.lineWidth = 1.4; c.beginPath(); for (let x = L; x <= W - L; x += 3) { const ms = (x - L) / (W - 2 * L) * 2 * R - R, g = Math.exp(-0.5 * ((ms - md) / sd) ** 2), y = B - (B - T) * g * (hits.length * bw / (sd * 2.5066)) / mx; x === L ? c.moveTo(x, y) : c.lineTo(x, y); } c.stroke(); c.lineWidth = 1; }
      c.strokeStyle = "rgba(255,255,255,.4)"; c.beginPath(); c.moveTo(Math.round(fx(0)) + .5, T - 4); c.lineTo(Math.round(fx(0)) + .5, B); c.stroke();
      if (md != null) { c.strokeStyle = "#fff"; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(Math.round(fx(md)) + .5, T - 4); c.lineTo(Math.round(fx(md)) + .5, B); c.stroke(); c.setLineDash([]); }
      rpanText(c, "−" + Math.round(R) + " ms", L, H - 5, RPAN_C.mute, 10.5, "left"); rpanText(c, "0", fx(0), H - 5, RPAN_C.mute, 10.5, "center"); rpanText(c, "+" + Math.round(R) + " ms", W - L, H - 5, RPAN_C.mute, 10.5, "right");
    } });
  // estimated against the replay's counts
  const cons = a.consistency || {}, est = cons.est || S.est || {}, hd = cons.header || {}, card = rpanCard(row, "rpancounts");
  card.append(h("h3", null, tr("Estimated and replay counts")));
  const tb = h("div", "rpantbl"); tb.setAttribute("role", "table");
  const rowOf = (cells, hd_) => { const r = h("div", "rpanr" + (hd_ ? " hd" : "")); r.setAttribute("role", "row"); cells.forEach((t, k) => { const c = h("span", k ? "num" : "", t); c.setAttribute("role", hd_ ? "columnheader" : "cell"); r.append(c); }); return r; };
  tb.append(rowOf(["", tr("Estimated"), tr("Replay")], true));
  for (const [lab, k, col] of [[tr("Great") + " · 300", "n300", 300], [tr("Ok") + " · 100", "n100", 100], [tr("Meh") + " · 50", "n50", 50], [tr("Miss"), "miss", 0]]) {
    const r = rowOf([lab, est[k] != null ? String(est[k]) : "-", hd[k] != null ? String(hd[k]) : "-"]); r.style.setProperty("--jc", RPAN_C.j[col]); tb.append(r);
  }
  card.append(tb);
  if (cons.quality) card.append(h("p", "rpancq q-" + cons.quality, tr("Matches the replay's counts: {q}", { q: rpanQ()[cons.quality] || cons.quality })));
  // timeline scatter
  const first = a.hits.length ? a.hits[0].t : 0, last = a.hits.length ? a.hits[a.hits.length - 1].t : 1, span = Math.max(1, last - first);
  const misses = (a.hits || []).filter(h => h.err == null);
  rpanChart(rpanCard(p), 0, { title: tr("Error over time"), hint: tr("Each dot is one hit. Hover for details."), label: tr("Scatter plot of the hit error against the time in the map"), height: W => (W < 480 ? 220 : 270),
    draw(ch, c, W, H) {
      const L = 40, Rr = 10, T = 10, B = H - 24, fx = t => L + (t - first) / span * (W - L - Rr), fy = ms => T + (R - ms) / (2 * R) * (B - T);
      for (const [w, col] of [[win.w50, "rgba(255,204,34,.12)"], [win.w100, "rgba(87,227,19,.12)"], [win.w300, "rgba(50,188,231,.16)"]]) { c.fillStyle = col; c.fillRect(L, fy(w), W - L - Rr, fy(-w) - fy(w)); }
      c.strokeStyle = "rgba(255,255,255,.35)"; c.beginPath(); c.moveTo(L, Math.round(fy(0)) + .5); c.lineTo(W - Rr, Math.round(fy(0)) + .5); c.stroke();
      for (const v of [-win.w50, -win.w300, 0, win.w300, win.w50]) rpanText(c, (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v), L - 6, fy(v) + 3.5, RPAN_C.mute, 10.5, "right");
      const step = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000].find(s => span / s <= Math.max(3, (W - L) / 70)) || 300000; let lastX = -1e9;
      for (let t = Math.ceil(first / step) * step; t <= last; t += step) { const x = fx(t); c.strokeStyle = RPAN_C.grid; c.beginPath(); c.moveTo(Math.round(x) + .5, T); c.lineTo(Math.round(x) + .5, B); c.stroke(); if (x - lastX > 44) { rpanText(c, rpanTick(t), x, H - 6, RPAN_C.mute, 10.5, "center"); lastX = x; } }
      const rad = W < 480 ? 1.8 : 2.2;
      for (const h of hits) { c.fillStyle = RPAN_C.j[rpanJudge(h.judge)]; c.globalAlpha = .78; c.beginPath(); c.arc(fx(h.t), fy(Math.max(-R, Math.min(R, h.err))), rad, 0, 6.2832); c.fill(); }
      c.globalAlpha = 1; c.fillStyle = RPAN_C.j[0]; for (const h of misses) c.fillRect(Math.round(fx(h.t)) - .5, B - 5, 1.5, 5);
      if (ch.hv != null) { const h = a.hits[ch.hv]; if (h && h.err != null) { c.strokeStyle = "#fff"; c.lineWidth = 1.6; c.beginPath(); c.arc(fx(h.t), fy(Math.max(-R, Math.min(R, h.err))), rad + 3.5, 0, 6.2832); c.stroke(); c.lineWidth = 1; } }
      ch.fx = fx; ch.fy = fy;
    },
    hover(ch, x, y) {
      if (!ch.fx) return; let best = -1, bd = 15 * 15;
      for (let k = 0; k < a.hits.length; k++) { const h = a.hits[k]; if (h.err == null) continue; const dx = ch.fx(h.t) - x; if (dx * dx > bd) continue; const dy = ch.fy(Math.max(-R, Math.min(R, h.err))) - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = k; } }
      if (best < 0) return rpanUnhover(ch);
      const h = a.hits[best]; if (ch.hv !== best) { ch.hv = best; rpanDraw(ch, true); }
      rpanTip(ch, ch.fx(h.t), ch.fy(Math.max(-R, Math.min(R, h.err))), [tr("Object #{n}", { n: (h.i != null ? h.i : best) + 1 }) + " · " + rpanTime(h.t), (h.err < 0 ? tr("{ms} ms early", { ms: Math.abs(h.err).toFixed(0) }) : h.err > 0 ? tr("{ms} ms late", { ms: Math.abs(h.err).toFixed(0) }) : tr("On time")) + " · " + (h.judge ? h.judge : tr("Miss")) + (h.key ? " · " + h.key : "")]);
    } });
}

// ---------- Aim ----------
function rpanAim(p, A) {
  const a = A.a, S = a.stats || {}, hits = (a.hits || []).filter(h => h.dx != null && h.dy != null), r = A.radius || 36;
  const mx = rpanN(S.meanDx) != null ? +S.meanDx : hits.reduce((q, h) => q + h.dx, 0) / (hits.length || 1), my = rpanN(S.meanDy) != null ? +S.meanDy : hits.reduce((q, h) => q + h.dy, 0) / (hits.length || 1);
  const md = rpanN(S.meanDist), xd = rpanN(S.maxDist), inner = hits.length ? hits.filter(h => Math.hypot(h.dx, h.dy) <= r / 2).length / hits.length : 0;
  const pos = [];
  if (Math.abs(mx) >= .3) pos.push(mx > 0 ? tr("{n} px right", { n: Math.abs(mx).toFixed(1) }) : tr("{n} px left", { n: Math.abs(mx).toFixed(1) }));
  if (Math.abs(my) >= .3) pos.push(my < 0 ? tr("{n} px up", { n: Math.abs(my).toFixed(1) }) : tr("{n} px down", { n: Math.abs(my).toFixed(1) }));
  const line = !hits.length ? tr("There are no hits with a cursor position to show.") : pos.length ? tr("On average you hit {pos} of the centre of the circle.", { pos: pos.join(" / ") }) : tr("On average you hit the centre of the circle.");
  rpanSum(p, line);
  const row = h("div", "rpan2 aim"); p.append(row);
  const card = rpanCard(row, "rpanaimc");
  const ctl = h("div", "rpanctl"), dens = h("button", "btn ghost sm rpantog", tr("Show density")); dens.type = "button"; dens.setAttribute("aria-pressed", "false");
  ctl.append(dens);
  const ch = rpanChart(card, 1, { title: tr("Where the cursor was"), hint: tr("The circle is the size of a hit circle. Each dot is one hit."), label: tr("Diagram of the cursor position inside the hit circle for each hit"), height: W => Math.min(W, 400),
    draw(ch, c, W, H) {
      const S_ = Math.min(W, H), cx = W / 2, cy = H / 2, R = S_ * .42, k = R / r, lim = 1.55;
      c.fillStyle = "rgba(255,255,255,.05)"; c.beginPath(); c.arc(cx, cy, R, 0, 6.2832); c.fill(); c.strokeStyle = "rgba(255,255,255,.55)"; c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, R, 0, 6.2832); c.stroke(); c.lineWidth = 1;
      c.strokeStyle = RPAN_C.grid; c.setLineDash([3, 4]); c.beginPath(); c.arc(cx, cy, R / 2, 0, 6.2832); c.stroke(); c.setLineDash([]);
      c.beginPath(); c.moveTo(cx - R * 1.2, Math.round(cy) + .5); c.lineTo(cx + R * 1.2, Math.round(cy) + .5); c.moveTo(Math.round(cx) + .5, cy - R * 1.2); c.lineTo(Math.round(cx) + .5, cy + R * 1.2); c.stroke();
      const P = h => { let x = h.dx * k, y = h.dy * k; const d = Math.hypot(x, y); if (d > R * lim) { x *= R * lim / d; y *= R * lim / d; } return [cx + x, cy + y]; };
      if (RPAN.dens) {
        c.globalCompositeOperation = "lighter";
        for (const h of hits) { const [x, y] = P(h), g = c.createRadialGradient(x, y, 0, x, y, R * .26); g.addColorStop(0, "rgba(255,140,60,.1)"); g.addColorStop(1, "rgba(255,140,60,0)"); c.fillStyle = g; c.fillRect(x - R * .26, y - R * .26, R * .52, R * .52); }
        c.globalCompositeOperation = "source-over";
      } else {
        for (const h of hits) { const [x, y] = P(h); c.fillStyle = RPAN_C.j[rpanJudge(h.judge)]; c.globalAlpha = .72; c.beginPath(); c.arc(x, y, W < 480 ? 2 : 2.4, 0, 6.2832); c.fill(); }
        c.globalAlpha = 1;
      }
      const ax = cx + mx * k, ay = cy + my * k; c.strokeStyle = "#fff"; c.fillStyle = "#fff"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(ax, ay); c.stroke(); c.lineWidth = 1; c.beginPath(); c.arc(ax, ay, 4, 0, 6.2832); c.fill(); c.strokeStyle = "#151825"; c.lineWidth = 1.5; c.beginPath(); c.arc(ax, ay, 4, 0, 6.2832); c.stroke(); c.lineWidth = 1;
      rpanText(c, "r = " + r.toFixed(1) + " px", cx + R * .72, cy - R * .82, RPAN_C.mute, 10.5, "left");
    } });
  dens.onclick = () => { RPAN.dens = !RPAN.dens; dens.setAttribute("aria-pressed", RPAN.dens); dens.classList.toggle("on", RPAN.dens); rpanDraw(ch, true); };
  card.append(ctl);
  const side = h("div", "rpantiles col"); row.append(side);
  side.append(rpanTile(tr("Average offset"), pos.length ? pos.join(" / ") : tr("Centred"), tr("from the centre of the circle")));
  side.append(rpanTile(tr("Average distance"), md == null ? "-" : md.toFixed(1) + " px", md == null ? "" : tr("{p}% of the circle's radius", { p: Math.round(100 * md / r) })));
  side.append(rpanTile(tr("Furthest hit"), xd == null ? "-" : xd.toFixed(1) + " px", xd == null ? "" : tr("{p}% of the circle's radius", { p: Math.round(100 * xd / r) })));
  side.append(rpanTile(tr("Inside the inner half"), Math.round(inner * 100) + "%", tr("of the hits landed within half the radius")));
  const lg = h("div", "rpanlegend"); for (const [j, t] of [[300, tr("Great")], [100, tr("Ok")], [50, tr("Meh")], [-1, tr("Average")]]) { const s_ = h("span", null, t); s_.style.setProperty("--jc", j < 0 ? "#fff" : RPAN_C.j[j]); lg.append(s_); } side.append(lg);
}

// ---------- Cursor ----------
const RPAN_RAMP = [[0, [10, 8, 28]], [.2, [68, 12, 104]], [.4, [150, 38, 100]], [.62, [226, 86, 52]], [.82, [252, 166, 12]], [1, [252, 252, 166]]]; // (a dark-to-light ramp, one lightness direction, in the inferno family)
function rpanRamp(v) { v = Math.max(0, Math.min(1, v)); for (let k = 1; k < RPAN_RAMP.length; k++) if (v <= RPAN_RAMP[k][0]) { const [a0, c0] = RPAN_RAMP[k - 1], [a1, c1] = RPAN_RAMP[k], f = (v - a0) / (a1 - a0 || 1); return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]; } return RPAN_RAMP[RPAN_RAMP.length - 1][1]; }
function rpanCursor(p, A) {
  const a = A.a, cu = a.cursor || {}, g = cu.grid, sp = Array.isArray(cu.speed) ? cu.speed : [], dist = rpanN(cu.distance), jm = rpanN(cu.jumpMax);
  let top = 0, avg = 0; for (const q of sp) { top = Math.max(top, q.v); avg += q.v; } avg = sp.length ? avg / sp.length : 0;
  rpanSum(p, dist == null ? tr("There is no cursor data to show.") : tr("The cursor travelled {d} px in total. The longest jump was {j} px.", { d: Math.round(dist).toLocaleString(), j: jm == null ? "-" : Math.round(jm).toLocaleString() }));
  const row = h("div", "rpan2 heat"); p.append(row);
  const card = rpanCard(row, "rpanheatc");
  if (g && g.data && g.w && g.h) {
    const ctl = h("div", "rpanctl"), tog = h("button", "btn ghost sm rpantog", tr("Show the map's circles")); tog.type = "button"; tog.setAttribute("aria-pressed", "false"); ctl.append(tog);
    const ch = rpanChart(card, 2, { title: tr("Where the cursor spent its time"), hint: tr("The playfield. Brighter means more time."), label: tr("Heat map of the cursor over the playfield"), height: W => W * .75,
      draw(ch, c, W, H) {
        if (!ch.off) { const o = ch.off = document.createElement("canvas"); o.width = g.w; o.height = g.h; const x = o.getContext("2d"), im = x.createImageData(g.w, g.h);
          for (let k = 0; k < g.w * g.h; k++) { const v = Math.sqrt(Math.max(0, g.data[k] || 0)), [r_, g_, b_] = rpanRamp(v); im.data[k * 4] = r_; im.data[k * 4 + 1] = g_; im.data[k * 4 + 2] = b_; im.data[k * 4 + 3] = 255; }
          x.putImageData(im, 0, 0); }
        c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high"; try { c.filter = "blur(" + (W / 64 * .4).toFixed(1) + "px)"; } catch {} c.drawImage(ch.off, 0, 0, W, H); c.filter = "none"; // (a little blur where the browser can: the cells are 8 px)
        if (RPAN.objs) { const k = W / 512, r = A.radius * k; c.strokeStyle = "rgba(255,255,255,.2)"; c.lineWidth = 1; c.beginPath(); for (const o of a.hits) { c.moveTo(o.x * k + r, o.y * k); c.arc(o.x * k, o.y * k, r, 0, 6.2832); } c.stroke(); }
        c.strokeStyle = "rgba(255,255,255,.3)"; c.strokeRect(.5, .5, W - 1, H - 1);
      } });
    tog.onclick = () => { RPAN.objs = !RPAN.objs; tog.setAttribute("aria-pressed", RPAN.objs); tog.classList.toggle("on", RPAN.objs); rpanDraw(ch, true); };
    card.append(ctl);
    const lg = h("div", "rpanramp"); lg.setAttribute("aria-hidden", "true"); lg.style.background = "linear-gradient(90deg," + RPAN_RAMP.map(([o, c]) => `rgb(${c.map(Math.round)}) ${o * 100}%`).join(",") + ")"; card.append(lg, h("div", "rpanrl", tr("less time")), h("div", "rpanrl r", tr("more time")));
  }
  const side = h("div", "rpantiles col"); row.append(side);
  side.append(rpanTile(tr("Total distance"), dist == null ? "-" : Math.round(dist).toLocaleString() + " px", tr("of cursor travel")));
  side.append(rpanTile(tr("Longest jump"), jm == null ? "-" : Math.round(jm).toLocaleString() + " px", ""));
  side.append(rpanTile(tr("Average speed"), sp.length ? avg.toFixed(2) + " px/ms" : "-", sp.length ? tr("Top {v} px/ms", { v: top.toFixed(2) }) : ""));
  if (sp.length > 1) {
    const t0 = sp[0].t, t1 = sp[sp.length - 1].t, spn = Math.max(1, t1 - t0), ymax = Math.max(.5, top * 1.08);
    rpanChart(rpanCard(p), 2, { title: tr("Cursor speed over time"), hint: tr("Hover to read a moment."), label: tr("Line graph of the cursor speed over the time in the map"), height: W => (W < 480 ? 170 : 200),
      draw(ch, c, W, H) {
        const L = 40, Rr = 10, T = 20, B = H - 24, fx = t => L + (t - t0) / spn * (W - L - Rr), fy = v => B - v / ymax * (B - T);
        for (const f of [0, .5, 1]) { const y = Math.round(fy(ymax * f)) + .5; c.strokeStyle = RPAN_C.grid; c.beginPath(); c.moveTo(L, y); c.lineTo(W - Rr, y); c.stroke(); rpanText(c, (ymax * f).toFixed(1), L - 6, y + 3.5, RPAN_C.mute, 10.5, "right"); }
        const step = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000].find(s => spn / s <= Math.max(3, (W - L) / 70)) || 300000; let lastX = -1e9;
        for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) { const x = fx(t); if (x - lastX > 44) { rpanText(c, rpanTick(t), x, H - 6, RPAN_C.mute, 10.5, "center"); lastX = x; } }
        const gr = c.createLinearGradient(0, T, 0, B); gr.addColorStop(0, "rgba(194,107,255,.38)"); gr.addColorStop(1, "rgba(194,107,255,0)");
        c.beginPath(); sp.forEach((q, k) => { k ? c.lineTo(fx(q.t), fy(q.v)) : c.moveTo(fx(q.t), fy(q.v)); }); c.strokeStyle = RPAN_C.vio; c.lineWidth = 1.6; c.stroke(); c.lineWidth = 1;
        c.lineTo(fx(t1), B); c.lineTo(fx(t0), B); c.closePath(); c.fillStyle = gr; c.fill();
        rpanText(c, "px/ms", L - 6, T - 9, RPAN_C.mute, 10, "right");
        if (ch.hv != null) { const q = sp[ch.hv], x = fx(q.t); c.strokeStyle = "rgba(255,255,255,.6)"; c.beginPath(); c.moveTo(Math.round(x) + .5, T); c.lineTo(Math.round(x) + .5, B); c.stroke(); c.fillStyle = "#fff"; c.beginPath(); c.arc(x, fy(q.v), 4, 0, 6.2832); c.fill(); }
        ch.fx = fx; ch.fy = fy;
      },
      hover(ch, x) {
        if (!ch.fx) return; let lo = 0, hi = sp.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (ch.fx(sp[m].t) < x) lo = m + 1; else hi = m; }
        if (lo > 0 && Math.abs(ch.fx(sp[lo - 1].t) - x) < Math.abs(ch.fx(sp[lo].t) - x)) lo--;
        if (ch.hv !== lo) { ch.hv = lo; rpanDraw(ch, true); }
        rpanTip(ch, ch.fx(sp[lo].t), ch.fy(sp[lo].v), [rpanTime(sp[lo].t), sp[lo].v.toFixed(2) + " px/ms"]);
      } });
  }
}

// ---------- Keys ----------
function rpanKeys(p, A) {
  const a = A.a, K = a.keys || {}, cnt = K.counts || {}, names = ["K1", "K2", "M1", "M2"], tot = names.reduce((q, k) => q + (cnt[k] || 0), 0), rate = rpanN(a.rate) || 1;
  const alt = rpanN(K.altRatio), mb = rpanN(K.maxBpm), ab = rpanN(K.avgBpm), ints = Array.from(K.intervals || [], v => v / rate); // (the gaps in real time, like the BPM numbers)
  rpanSum(p, tot ? tr("{n} key presses: {k1} K1, {k2} K2, {m1} M1, {m2} M2. {a}% of the presses alternated between keys. Fastest tapping about {b} BPM.", { n: tot, k1: cnt.K1 || 0, k2: cnt.K2 || 0, m1: cnt.M1 || 0, m2: cnt.M2 || 0, a: alt == null ? "-" : Math.round(alt * 100), b: mb == null ? "-" : Math.round(mb) }) : tr("There are no key presses to show."));
  const tiles = h("div", "rpantiles");
  tiles.append(rpanTile(tr("Key presses"), tot.toLocaleString(), ""));
  tiles.append(rpanTile(tr("Alternation"), alt == null ? "-" : Math.round(alt * 100) + "%", tr("of the presses switch keys")));
  tiles.append(rpanTile(tr("Fastest tapping"), mb == null ? "-" : Math.round(mb) + " BPM", tr("as 1/4 notes")));
  tiles.append(rpanTile(tr("Usual tapping"), ab == null ? "-" : Math.round(ab) + " BPM", tr("as 1/4 notes")));
  p.append(tiles);
  const row = h("div", "rpan2"); p.append(row);
  rpanChart(rpanCard(row), 3, { title: tr("Presses per key"), label: tr("Bar chart of the presses per key"), height: () => 168,
    draw(ch, c, W, H) {
      const L = 40, Rr = 56, mx = Math.max(1, ...names.map(k => cnt[k] || 0)), rh = 30, y0 = 8;
      names.forEach((k, n) => { const y = y0 + n * (rh + 8), v = cnt[k] || 0, w = Math.max(v ? 3 : 0, (W - L - Rr) * v / mx); const col = k[0] === "K" ? RPAN_C.vio : RPAN_C.ice;
        rpanText(c, k, 4, y + rh / 2 + 4, RPAN_C.ink, 13, "left", 800); c.fillStyle = "rgba(255,255,255,.06)"; c.fillRect(L, y, W - L - Rr, rh); c.fillStyle = col; c.globalAlpha = .9; c.fillRect(L, y, w, rh); c.globalAlpha = 1;
        rpanText(c, v.toLocaleString(), L + w + 8, y + rh / 2 + 4, RPAN_C.ink, 12.5, "left", 700); });
    } });
  if (ints.length) {
    const cap = Math.min(320, Math.max(100, Math.ceil(Math.max(...ints.slice(0, 5000)) / 10) * 10)), srt = ints.slice().sort((x, y) => x - y), med = srt[srt.length >> 1];
    rpanChart(rpanCard(row), 3, { title: tr("Time between presses"), hint: med ? tr("Typical gap {ms} ms, about {b} BPM as 1/4 notes", { ms: Math.round(med), b: rpanBpm(med) }) : "", label: tr("Histogram of the time between key presses"), height: W => (W < 480 ? 150 : 168),
      draw(ch, c, W, H) {
        const L = 8, B = H - 22, T = 16, bw = 10, n = Math.ceil(cap / bw), bins = new Float32Array(n);
        for (const v of ints) bins[Math.min(n - 1, Math.max(0, Math.floor(v / bw)))]++;
        let mx = 1; for (const v of bins) mx = Math.max(mx, v); const px = (W - 2 * L) / n, fx = ms => L + ms / cap * (W - 2 * L);
        for (let k = 0; k < n; k++) { if (!bins[k]) continue; const hh = (B - T) * bins[k] / mx; c.fillStyle = RPAN_C.vio; c.globalAlpha = .88; c.fillRect(L + k * px + .5, B - hh, Math.max(1, px - 1), hh); }
        c.globalAlpha = 1; c.strokeStyle = RPAN_C.grid; c.beginPath(); c.moveTo(L, B + .5); c.lineTo(W - L, B + .5); c.stroke();
        let right = -1e9; for (const bpm of [250, 200, 150, 100]) { const ms = 15000 / bpm; if (ms > cap) continue; const x = Math.round(fx(ms)) + .5; c.strokeStyle = "rgba(255,255,255,.28)"; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(x, T - 2); c.lineTo(x, B); c.stroke(); c.setLineDash([]); const lab = bpm + " BPM"; c.font = rpanFont(10, 600); const wd = c.measureText(lab).width; if (x - wd / 2 > right + 4 && x + wd / 2 < W) { rpanText(c, lab, x, T - 5, RPAN_C.mute, 10, "center"); right = x + wd / 2; } }
        if (med) { c.strokeStyle = "#fff"; c.beginPath(); c.moveTo(Math.round(fx(Math.min(cap, med))) + .5, T); c.lineTo(Math.round(fx(Math.min(cap, med))) + .5, B); c.stroke(); }
        for (let v = 0; v <= cap; v += cap > 200 ? 100 : 50) rpanText(c, v + (v === 0 ? " ms" : ""), Math.min(W - 14, Math.max(14, fx(v))), H - 5, RPAN_C.mute, 10.5, "center");
      } });
  }
}
