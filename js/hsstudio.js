"use strict";
// ============ Hitsound Studio (editor tab "Hitsounds") ============
// Every hit point of the difficulty (circles, each head / repeat / tail of a slider, spinner ends) is a column; the rows
// are what osu! lets you set on it: whistle / finish / clap, the sample set and addition bank, the slider body's
// whistle (sliderwhistle), and the object's own volume and custom sample index. The lanes sit right under the timeline at
// the top and move with it (same centre = the current time, same zoom), so each cell is below its object there. Click a
// cell to change it, drag along a lane to paint several at once (one undo step), drag empty space to scrub. Below: the
// usual hitsound tools for the selected point (by beat, copy from another difficulty, clear) and the map's own samples.
const HSS = { paint: null, focus: null, base: 0, scale: 0, span: 0, w: 0, drag: null };
const HSS_ROWS = [
  { key: 2, label: "Whistle", cls: "w" }, { key: 4, label: "Finish", cls: "f" }, { key: 8, label: "Clap", cls: "c" },
  { key: "n", label: "Sample set", cls: "set" }, { key: "a", label: "Addition bank", cls: "set" },
  { key: "body", label: "Slider body whistle", cls: "w" }, { key: "v", label: "Volume", cls: "num" }, { key: "i", label: "Custom index", cls: "num" }];
const hssLH = () => HSS.fullLH || Math.max(22, Math.min(90, +S.hssLH || 30)); // lane height in px (full screen: fits the screen)
const hssK = () => hssLH() / 30;
function hssApplySize() {
  const k = hssK(), l = $("hssLanes"); if (!l) return;
  l.style.setProperty("--lh", Math.round(hssLH()) + "px"); l.style.setProperty("--cf", (11 * Math.min(k, 1.5)).toFixed(1) + "px");
  l.style.setProperty("--lf", (11 * Math.min(k, 1.1)).toFixed(1) + "px"); // row names stay readable in the space left of the timeline
}
const HSS_SET = ["A", "N", "S", "D"], HSS_SET_NAME = ["Auto", "Normal", "Soft", "Drum"];
const hssPoints = () => hsPoints("all").sort((a, b) => a.t - b.t || (a.o.lid - b.o.lid));
const hssKey = q => q.o.lid + ":" + (q.k == null ? "" : q.k);
const hssGlyph = q => q.o.kind === "spinner" ? "◎" : q.k == null ? "●" : q.k === 0 ? "◖" : q.k === q.o.slides ? "◗" : "↺";
function hssValue(q, key) {
  const u = { o: q.o, k: q.k };
  if (typeof key === "number") return !!(unitHs(u) & key);
  if (key === "n") return unitBank(u, 0);
  if (key === "a") return unitBank(u, 1);
  if (key === "body") return q.o.kind === "slider" ? !!(q.o.hs & 2) : null;
  const s = q.o.samp || {};
  return key === "v" ? s.v || 0 : s.i || 0;
}
// write one row's value on several points, as one undo step
function hssApply(key, pts, val) {
  if (!pts.length) return;
  const label = typeof key === "number" ? HS_NAME[key] : { n: "Sample set", a: "Addition bank", body: "Slider body whistle", v: "Hitsound volume", i: "Sample index" }[key];
  applyPoints(label, pts, (p, type, k) => {
    if (typeof key === "number") { const set = v => val ? v | key : v & ~key; if (k != null) setEdgeBits(p, k, set); else p[4] = set(+p[4] || 0); return; }
    if (key === "n" || key === "a") { const w = key === "a" ? 1 : 0; if (k != null) setEdgeBank(p, k, w, val); else { const f = sampField(p, type); f.q[w] = String(val); p[f.i] = f.q.join(":"); } return; }
    if (key === "body") { if (!(type & 2)) return; ensureSliderFields(p); p[4] = val ? (+p[4] || 0) | 2 : (+p[4] || 0) & ~2; return; } // edges keep their own sounds
    const f = sampField(p, type); f.q[key === "v" ? 3 : 2] = String(Math.max(0, Math.min(key === "v" ? 100 : 999, Math.round(val)))); p[f.i] = f.q.join(":");
  });
}
function hssPreview(q) {
  if (isPlaying() || !q) return;
  ensureAudioCtx(); preloadDefaults();
  const e = map.sounds.find(s => !!s.tick === !!q.tick && Math.abs(s.t - q.t) < 1.5); if (e) playEvent(e, 0);
}
// ---------- slider ticks: osu! gives them no hitsounds of their own; their sample set, volume and custom index come
// from the timing point in effect, so changing a tick adds a green line on it (and one on the next point that puts the
// old values back, so nothing after it changes) ----------
const HSS_TICK_ROWS = new Set(["n", "v", "i"]);
function hssTicks() {
  const out = [];
  for (const o of map.hit) {
    if (o.kind !== "slider" || !o.ticks) continue;
    for (const [fr] of o.ticks) for (let k = 0; k < o.slides; k++) { const t = o.t + o.span * k + (k % 2 ? 1 - fr : fr) * o.span; out.push({ o, k: null, tick: true, t }); }
  }
  return out.sort((a, b) => a.t - b.t);
}
const hssTickKey = q => q.o.lid + ":t" + Math.round(q.t);
const tpAt = t => map.timing[lastBefore(map.timing, t + 2, "time")] || null;
function hssTickValue(q, key) {
  const tp = tpAt(q.t) || { sampleSet: 0, volume: 100, sampleIndex: 0 };
  return key === "n" ? tp.sampleSet | 0 : key === "v" ? Math.round(tp.volume) : tp.sampleIndex | 0;
}
const hssGreenAt = t => map.timing.find(tp => !tp.uninherited && Math.abs(tp.time - t) < 1);
// a green line at time t (a copy of what's in effect there, so SV and kiai stay the same)
function hssEnsureGreen(t) {
  let g = hssGreenAt(t); if (g) return g;
  const cur = tpAt(t) || { sampleSet: 0, sampleIndex: 0, volume: 100, kiai: false };
  const { sv } = timingAt(map, t), red = [...map.timing].reverse().find(tp => tp.uninherited && tp.time <= t);
  g = { time: t, beat: -100 / sv, meter: red ? red.meter : 4, uninherited: false, kiai: !!cur.kiai, omit: false, fx: cur.kiai ? 1 : 0,
    sampleSet: cur.sampleSet | 0, sampleIndex: cur.sampleIndex | 0, volume: cur.volume ?? 100 };
  map.timing.push(g); timingDerived(map); return g;
}
function hssApplyTicks(key, pts, val) {
  if (hssApplyGreen(key, pts, val, { label: { n: "Tick sample set", v: "Tick volume", i: "Tick sample index" }[key] }))
    toast(tr("Slider ticks take their sound from green lines: {n} green line(s) set", { n: pts.length }), 2200);
}
// sample set / volume / custom index through green lines on any points (ticks, circles, slider parts): one green line on
// each point, and one on the point after it that puts back what was there. val can be a function (point, n) -> value.
function hssApplyGreen(key, pts, val, opt = {}) {
  if (!pts.length) return false;
  pts = [...pts].sort((a, b) => a.t - b.t);
  const fix = v => key === "v" ? Math.max(5, Math.min(100, Math.round(v))) : key === "i" ? Math.max(0, Math.min(999, Math.round(v))) : Math.max(0, Math.min(3, v | 0));
  const all = [...hssPoints(), ...hssTicks()].sort((a, b) => a.t - b.t), times = new Set(pts.map(q => Math.floor(q.t)));
  // what the points right after each changed tick have now (put back there)
  const restore = [];
  for (const q of pts) {
    const nx = all.find(x => x.t > q.t + 1); if (!nx || times.has(Math.floor(nx.t))) continue;
    const tp = tpAt(nx.t) || {}; restore.push({ t: Math.floor(nx.t), n: tp.sampleSet | 0, v: tp.volume ?? 100, i: tp.sampleIndex | 0 });
  }
  return edCommit(opt.label || { n: "Green line sample set", v: "Green line volume", i: "Green line sample index" }[key], () => {
    for (const r of restore) if (!map.timing.some(tp => Math.abs(tp.time - r.t) < 1)) { const g = hssEnsureGreen(r.t); g.sampleSet = r.n; g.volume = r.v; g.sampleIndex = r.i; delete g.raw; }
    pts.forEach((q, n) => { const g = hssEnsureGreen(Math.floor(q.t)), v = fix(typeof val === "function" ? val(q, n) : val); if (key === "n") g.sampleSet = v; else if (key === "v") g.volume = v; else g.sampleIndex = v; delete g.raw; });
    timingDerived(map);
  });
}
// ---------- keysounds (piano hitsounding): custom index 1, 2, 3… in time order, one per object ----------
// on the objects themselves (their own custom index) or with a green line on each (index on the green line)
async function hssNumber(pts, via) {
  const heads = []; const seen = new Set();
  for (const q of [...pts].sort((a, b) => a.t - b.t)) { if (q.tick || seen.has(q.o.lid)) continue; seen.add(q.o.lid); heads.push({ o: q.o, k: q.o.kind === "slider" ? 0 : null, t: q.o.kind === "spinner" ? q.o.end : q.o.t }); }
  if (!heads.length) return toast(tr("Select objects first"));
  const used = new Set(map.hit.map(o => (o.samp || {}).i || 0).concat(map.timing.map(tp => tp.sampleIndex | 0)));
  let free = 1; while (used.has(free)) free++;
  const ans = await askText(tr("Number {n} objects in time order for keysounds. Start from which custom index? (files like soft-hitnormal{i}.wav)", { n: heads.length, i: free }), String(free), { type: "number", min: 1 });
  if (ans == null) return; const start = Math.max(1, Math.round(+ans) || 1);
  if (via === "green") hssApplyGreen("i", heads, (q, n) => start + n, { label: "Keysound numbering" });
  else applyPoints("Keysound numbering", heads, (p, type, k, q) => { const f = sampField(p, type); f.q[2] = String(start + heads.indexOf(q)); p[f.i] = f.q.join(":"); });
  toast(tr("Custom index {a}–{b} set on {n} objects", { a: start, b: start + heads.length - 1, n: heads.length }), 2500);
}
// ---------- right-click on a cell or a marker ----------
function hssMenu(e, q) {
  e.preventDefault(); e.stopPropagation();
  const inSel = EDIT.sel.has(q.o.lid) && EDIT.sel.size > 1;
  hssMenuFor(e.clientX, e.clientY, q, q.tick ? [q] : inSel ? hssPoints().filter(p2 => EDIT.sel.has(p2.o.lid)) : [q]);
}
function hssMenuFor(x, y, q, pts) {
  const nObj = new Set(pts.map(p2 => p2.o.lid)).size, many = nObj > 1 ? " · " + tr("{n} objects", { n: nObj }) : "";
  const setSub = key => () => HSS_SET_NAME.map((l, v) => ({ label: tr(l), action: () => hssApply(key, pts, v) }));
  const numSub = (key, green) => () => {
    const vals = key === "v" ? [100, 80, 60, 40, 20, 5] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const apply = v => green ? hssApplyGreen(key, pts, v) : hssApply(key, pts, v);
    return [...vals.map(v => ({ label: key === "v" ? v + "%" : v === 0 && !green ? tr("0 (the timing point's)") : String(v), action: () => apply(v) })),
      { label: tr("Other…"), action: async () => { const a = (await askText(key === "v" ? tr("Volume (5–100 %)") : tr("Custom index"), "1", { type: "number", min: key === "v" ? 5 : 0, max: key === "v" ? 100 : undefined })); if (a != null && isFinite(+a)) apply(+a); } }];
  };
  const greenSub = () => [{ label: tr("Sample set"), sub: () => HSS_SET_NAME.map((l, v) => ({ label: v ? tr(l) : tr("The map's default"), action: () => hssApplyGreen("n", pts, v) })) },
    { label: tr("Volume"), sub: numSub("v", true) }, { label: tr("Custom index"), sub: numSub("i", true) }];
  const items = q.tick ? [{ label: tr("Green line here") + many, sub: greenSub }] : [
    ...[2, 4, 8].map(bit => ({ label: tr(HS_NAME[bit]) + many, key: { 2: "W", 4: "E", 8: "R" }[bit], checked: pts.every(p2 => hssValue(p2, bit)), action: () => hssApply(bit, pts, !pts.every(p2 => hssValue(p2, bit))) })),
    { label: tr("Sample set"), sub: setSub("n") }, { label: tr("Addition bank"), sub: setSub("a") },
    { label: tr("Volume"), sub: numSub("v", false) }, { label: tr("Custom index"), sub: numSub("i", false) },
    { label: tr("Green line here") + many, sub: greenSub },
    { label: tr("Keysounds: number 1, 2, 3…"), sub: () => [{ label: tr("On the objects (their own custom index)"), action: () => hssNumber(pts, "object") }, { label: tr("With a green line on each"), action: () => hssNumber(pts, "green") }] }];
  items.push({ label: tr("Listen"), action: () => hssPreview(q) });
  ctxMenu(x, y, items);
}
// ---------- the selected points (one slider part when one is picked, else every part of the selected objects) ----------
function hssTargets() {
  const pts = hssPoints().filter(q => EDIT.sel.has(q.o.lid));
  if (EDIT.sel.size === 1 && EDIT.edge != null) { const one = pts.filter(q => q.k === EDIT.edge); if (one.length) return one; }
  return pts;
}
// ---------- size: lane height (buttons, or drag the bar under the lanes) ----------
function hssSetLH(v) { S.hssLH = Math.round(Math.max(22, Math.min(90, v))); save(); hssApplySize(); HSS.base = NaN; dirty = true; document.querySelectorAll(".hsslhout").forEach(o => o.textContent = S.hssLH + "px"); }
function hssSizeCtl() {
  const sz = h("span", "hsssize"), sm = h("button", "btn ghost sm", "−"), sp = h("button", "btn ghost sm", "+"), so = h("output", "hsslhout", Math.round(hssLH()) + "px");
  sm.title = tr("Shorter lanes"); sp.title = tr("Taller lanes");
  sm.onclick = () => { HSS.fullLH = 0; hssSetLH(hssLH() - 6); }; sp.onclick = () => { HSS.fullLH = 0; hssSetLH(hssLH() + 6); };
  const zm = h("button", "btn ghost sm", "+"), zo = h("button", "btn ghost sm", "−");
  zm.title = tr("Wider cells (zoom in)"); zo.title = tr("Narrower cells (zoom out)"); zm.onclick = () => hssZoom(1.4); zo.onclick = () => hssZoom(1 / 1.4);
  const fit = h("button", "btn ghost sm", "⟷"); fit.title = tr("The whole song (Page mode)"); fit.setAttribute("aria-label", tr("The whole song (Page mode)")); fit.onclick = hssFitSong;
  sz.append(h("small", null, tr("Size")), sm, so, sp, h("small", "hszl", tr("Zoom")), zo, zm, fit);
  return sz;
}
function hssBindGrip(grip, lanes) {
  grip.addEventListener("pointerdown", e => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const y0 = e.clientY, lh0 = hssLH();
    const mv = ev => { HSS.fullLH = 0; hssSetLH(lh0 + (ev.clientY - y0) / 9); };
    const up = () => { grip.removeEventListener("pointermove", mv); grip.removeEventListener("pointerup", up); };
    grip.addEventListener("pointermove", mv); grip.addEventListener("pointerup", up);
  });
}
// ---------- full screen: the lanes fill the panel, the tools sit in a dock at the bottom (pinned, or shown when the
// pointer comes near the bottom edge) ----------
function hssFull(on, quiet) {
  const p = $("edPanel"); if (!p) return;
  S.hssFull = !!on; if (!quiet) save();
  p.classList.toggle("hssfull", !!on);
  hssFitFull(); hssDockState();
  if (!quiet) { HSS.base = NaN; dirty = true; }
}
function hssFitFull() {
  const p = $("edPanel"), lanes = $("hssLanes"); if (!p || !lanes) return;
  if (!S.hssFull) { HSS.fullLH = 0; hssApplySize(); return; }
  const d = $("hssDock"), dock = S.hssPin && d ? d.offsetHeight : 0, avail = p.clientHeight - dock - 36;
  HSS.fullLH = Math.max(26, Math.min(110, Math.floor(avail / 9)));
  hssApplySize(); HSS.base = NaN;
}
addEventListener("resize", () => { if (S.hssFull && $("hssLanes")) hssFitFull(); });
function hssDockState() {
  const d = $("hssDock"); if (!d) return;
  d.classList.toggle("pinned", !!S.hssPin); d.classList.toggle("show", !!S.hssPin);
  const pin = d.querySelector(".hsspin"); if (pin) { pin.classList.toggle("on", !!S.hssPin); pin.setAttribute("aria-pressed", !!S.hssPin); }
  hssDockSync();
}
// ---------- controls for the selection. Next to the lanes (a column on their right, one control per row, so it's a
// short move from the cells) when there's room; otherwise in the bar under the lanes. Both show the selection's values. ----------
const hssNeed = fn => () => { const pts = hssTargets(); if (!pts.length) return toast(tr("Select objects first (click their markers)"), 1800); fn(pts); };
function hssBtn(txt, title, fn, cls = "") { const x = h("button", "hdb " + cls, txt); x.type = "button"; x.title = tr(title); x.setAttribute("aria-label", tr(title)); x.onclick = fn; return x; }
const hssSnd = bit => { const x = hssBtn(tr(HS_NAME[bit]), HS_NAME[bit] + " (" + { 2: "W", 4: "E", 8: "R" }[bit] + ")", hssNeed(pts => hssApply(bit, pts, !pts.every(q => hssValue(q, bit)))), "snd"); x.dataset.bit = bit; return x; };
const hssSets = key => HSS_SET.map((l, v) => { const x = hssBtn(l, HSS_SET_NAME[v], hssNeed(pts => hssApply(key, pts, v))); x.dataset.set = key + v; return x; });
function hssNum(key, max) {
  const i = h("input"); i.type = "number"; i.min = 0; i.max = max; i.placeholder = "–"; i.className = "hdnum"; i.dataset.key = key;
  i.title = key === "v" ? tr("0 / – = the timing point's volume") : tr("0 / – = the timing point's index");
  i.onchange = hssNeed(pts => hssApply(key, pts, +i.value || 0)); i.addEventListener("keydown", e => e.stopPropagation()); return i;
}
const hssMoveBtns = () => { const move = dir => () => { if (!EDIT.sel.size) return toast(tr("Select an object first (click its column)"), 1800); shiftSel(dir * Math.round(beatInfo(A.cur()).len / S.snap)); };
  return [hssBtn("⟵", "Move the selected object by one beat snap (Alt+← →)", move(-1)), hssBtn("⟶", "Move the selected object by one beat snap (Alt+← →)", move(1))]; };
// the column on the right of the lanes: row by row, the control for that row
function hssRightCol() {
  const rc = h("div", "hssrc"); rc.id = "hssRc";
  const top = h("div", "hsrrow"); top.append(h("span", "hdinfo hrinfo"), ...hssMoveBtns()); rc.append(top);
  for (const row of HSS_ROWS) {
    const r = h("div", "hsrrow");
    if (typeof row.key === "number") r.append(hssSnd(row.key));
    else if (row.key === "n" || row.key === "a") r.append(...hssSets(row.key));
    else if (row.key === "body") { const x = hssBtn(tr("Slider body whistle"), "Slider body whistle", hssNeed(pts => { const sl = pts.filter(q => q.o.kind === "slider"); if (!sl.length) return toast(tr("Select a slider first"), 1800); hssApply("body", sl, !sl.every(q => hssValue(q, "body"))); }), "snd"); x.dataset.body = 1; x.dataset.bit = "2b"; r.append(x); }
    else r.append(hssNum(row.key, row.key === "v" ? 100 : 999), h("small", null, row.key === "v" ? "%" : "#"));
    rc.append(r);
  }
  return rc;
}
// the bar under the lanes (a dock at the bottom in full screen: pinned, or shown when the pointer comes near the bottom edge)
function hssDock() {
  const d = h("div", "hssdock"); d.id = "hssDock";
  const b = hssBtn, grp = (cls, ...kids) => { const g = h("span", "hdgrp " + cls); g.append(...kids); return g; };
  const seg = (label, key) => { const g = h("span", "hdseg"); g.append(h("small", null, tr(label)), ...hssSets(key)); return g; };
  const num = (label, key, max) => { const g = h("label", "hdseg"); g.append(h("small", null, tr(label)), hssNum(key, max)); return g; };
  const green = b("┃ " + tr("Green line"), "Green line here: sample set, volume or custom index", e => { const pts = hssTargets(); if (!pts.length) return toast(tr("Select objects first (click their markers)"), 1800); const r = e.currentTarget.getBoundingClientRect(); hssMenuFor(r.left, r.top - 8, pts[0], pts); });
  const keys = b("1·2·3", "Keysounds: number 1, 2, 3…", e => { const pts = hssTargets(); if (!pts.length) return toast(tr("Select objects first (click their markers)"), 1800);
    const r = e.currentTarget.getBoundingClientRect(); ctxMenu(r.left, r.top - 8, [{ label: tr("On the objects (their own custom index)"), action: () => hssNumber(pts, "object") }, { label: tr("With a green line on each"), action: () => hssNumber(pts, "green") }]); });
  const play = b("▶", "Play / pause (Space)", () => togglePlay ? togglePlay() : null, "fsonly");
  const full = b("⛶", "Full screen", () => hssFull(true), "nofs");
  const help = b("?", "How it works", () => { S.hssHelp = !S.hssHelp; save(); hssHelpState(); }, "hsshelpb");
  const pin = b("📌", "Keep the tools shown (pin)", () => { S.hssPin = !S.hssPin; save(); hssFitFull(); hssDockState(); }, "hsspin fsonly");
  const exit = b("⤢", "Leave full screen", () => hssFull(false), "fsonly");
  const now = h("div", "hdnow"); now.id = "hssNow"; now.setAttribute("aria-live", "off"); // its own row on top of the bar, always there (nothing jumps)
  now.append(h("span", "hdnowl", "♪"), h("span", "hdnowe", tr("The samples that play show here")));
  d.append(grp("hdsel", h("span", "hdinfo")), grp("hdsnd", ...[2, 4, 8].map(hssSnd)), grp("hdsets", seg("Sample set", "n"), seg("Addition", "a")), grp("hdnums", num("Volume", "v", 100), num("Index", "i", 999)),
    grp("hdmove", ...hssMoveBtns()), grp("hdmore", green, keys), grp("hdpanels", ...hssPanelBtns()), now, grp("hdview", hssModeCtl(), hssSizeCtl(), play, full, help, pin, exit));
  return d;
}
// while playing (editor.js hsNow): flash the marker of the hit point that sounds and only the cells of what it plays
// (its sample set; whistle / finish / clap and their addition set when on), and name its samples in the bar
function hssFlashAt(e, text) {
  const lanes = $("hssLanes"); if (!lanes) return;
  const now = $("hssNow"); if (now) { now.replaceChildren(h("span", "hdnowl", "♪"), ...String(text).split(" + ").map(t => h("span", "hdnowc", t))); now.title = text; now.classList.add("on"); } // one chip per file, stays until the next sound
  if (S.hsFlash === false) return;
  if (lanes.classList.contains("hssdotmode")) return hssDotFlash(e); // zoomed far out: the dots flash
  const t = Math.round(e.t), mk = [...lanes.querySelectorAll(".hssmark[data-t]")].find(m => Math.abs(+m.dataset.t - t) <= 2 && m.classList.contains("tick") === !!e.tick); if (!mk) return;
  const plays = el => { const r = el.dataset.row; if (r == null) return true; if (r === "n") return true; if (r === "a") return !e.tick && !!(e.hs & 14); return /^\d+$/.test(r) && !e.tick && !!(e.hs & +r); };
  const hit = { key: mk.dataset.key, plays, at: performance.now() };
  HSS.hits = (HSS.hits || []).filter(x => hit.at - x.at < 260); HSS.hits.push(hit);
  hssLight(lanes, hit, 0);
}
// light the boxes of one sound; after the lanes are rebuilt (Follow mode does it while scrolling) the flashes still
// running go on from where they were in the new boxes instead of being cut
function hssLight(lanes, hit, into) {
  for (const el of lanes.querySelectorAll(`[data-key="${hit.key}"]`)) {
    if (!hit.plays(el)) continue;
    el.classList.remove("hshit"); void el.offsetWidth; el.style.animationDelay = into ? -into + "ms" : ""; el.classList.add("hshit");
    clearTimeout(el.hitT); el.hitT = setTimeout(() => el.classList.remove("hshit"), 260 - into);
  }
}
function hssRelight(lanes) {
  const now = performance.now(); HSS.hits = (HSS.hits || []).filter(x => now - x.at < 250);
  for (const x of HSS.hits) hssLight(lanes, x, now - x.at);
}
function hssHelpState() {
  const x = $("hssHelp"); if (x) x.hidden = !S.hssHelp;
  const b = document.querySelector(".hsshelpb"); if (b) { b.classList.toggle("on", !!S.hssHelp); b.setAttribute("aria-expanded", !!S.hssHelp); }
}
// the controls show the selection's values
function hssDockSync() {
  const box = $("hssLanes") && $("hssLanes").parentNode; if (!box) return;
  const pts = hssTargets(), objs = new Set(pts.map(q => q.o.lid)).size, q$ = sel => box.querySelectorAll("#hssDock " + sel + ",#hssRc " + sel);
  box.querySelectorAll(".hdinfo").forEach(inf => { inf.textContent = objs ? tr("{n} objects", { n: objs }) : inf.classList.contains("hrinfo") ? tr("Nothing selected") : tr("Nothing selected: click a marker in the Time row"); inf.classList.toggle("none", !objs); });
  const rc = $("hssRc"); if (rc) rc.classList.toggle("idle", !objs);
  q$("[data-bit]").forEach(x => { const sl = pts.filter(q => q.o.kind === "slider"); x.classList.toggle("on", x.dataset.body ? !!sl.length && sl.every(q => hssValue(q, "body")) : !!pts.length && pts.every(q => hssValue(q, +x.dataset.bit))); });
  q$("[data-set]").forEach(x => { const key = x.dataset.set[0], v = +x.dataset.set.slice(1); x.classList.toggle("on", !!pts.length && pts.every(q => (hssValue(q, key) || 0) === v)); });
  q$(".hdnum").forEach(i => { if (document.activeElement === i) return; const vals = new Set(pts.map(q => hssValue(q, i.dataset.key) || 0)); i.value = vals.size === 1 ? [...vals][0] || "" : ""; });
}
// unpinned: the dock slides in when the pointer is near the bottom of the panel, and out again after it leaves
$("edPanel").addEventListener("pointermove", e => {
  const d = $("hssDock"); if (!d || !S.hssFull || S.hssPin) return;
  const r = $("edPanel").getBoundingClientRect(), near = e.clientY > r.bottom - 70 || d.contains(e.target);
  if (near) { clearTimeout(HSS.dockT); d.classList.add("show"); }
  else if (d.classList.contains("show") && !HSS.dockT) HSS.dockT = setTimeout(() => { HSS.dockT = 0; if (!S.hssPin) d.classList.remove("show"); }, 900);
});
function hssSelect(q, add) {
  if (add) { const s2 = new Set(EDIT.sel); s2.add(q.o.lid); edSelectIds([...s2]); } else edSelectIds([q.o.lid]);
  if (q.o.kind === "slider" && q.k != null) { EDIT.edgeFor = q.o.lid; EDIT.edge = q.k; } else EDIT.edge = null;
  HSS.focus = hssKey(q); seekTo(Math.round(q.t)); hssPreview(q); hssRender(true); hssRenderSide();
}
const hssSnapCls = q => { const b = beatInfo(q.t), f = beatFrac(((q.t - b.off) % b.len + b.len) % b.len, b.len); return !f.includes("/") || /\/1$/.test(f) ? "b1" : /\/2$/.test(f) ? "b2" : /\/4$/.test(f) ? "b4" : /\/(3|6)$/.test(f) ? "b3" : "bx"; };

function renderHsStudio(box) {
  box.classList.add("hsswrap");
  if (!map.hit.length) { box.append(h("h3", null, tr("Hitsound Studio")), h("p", "hint", tr("Place some objects first: every circle and every part of a slider gets a column here."))); return; }
  const help = h("div", "hsshelp"), ul = h("ul"); help.id = "hssHelp";
  for (const t of ["The lanes follow the timeline above: drag it, scroll or play and they move along; + − zooms both. Click a cell to switch it, drag along a lane to paint, drag empty space to scrub. Click an object's marker to select it and hear it (W E R work on it).",
    "Right-click (or long-press) a cell or a marker for more: sound, sample set, volume, custom index, a green line on that point, and keysound numbering (1, 2, 3…) for piano-style hitsounds. With several objects selected it works on all of them.",
    "Follow / Page (in the bar): Follow scrolls the lanes along with the timeline. Page keeps the columns still and moves the play line across them, like a music program, so they're easier to click while the song plays.",
    "Small dots are slider ticks. osu! can't put whistle/finish/clap on them, but their sample set, volume and custom index can change: that adds a green line on the tick (and one on the next point to put the old sound back)."]) ul.append(h("li", null, tr(t)));
  help.append(ul);
  // lanes: labels on the left (under the time display), the track exactly under the timeline
  const lanes = h("div", "hsslanes"); lanes.id = "hssLanes";
  const labels = h("div", "hsslabels"), track = h("div", "hsstrack"), inner = h("div", "hssinner"), head = h("div", "hsslane hsshead");
  labels.append(h("span", "hsslab head", tr("Time")));
  inner.append(head);
  for (const row of HSS_ROWS) { labels.append(h("span", "hsslab", tr(row.label))); const ln = h("div", "hsslane"); ln.dataset.row = String(row.key); inner.append(ln); }
  track.append(inner, h("i", "hssplay"));
  lanes.append(labels, track, hssRightCol());
  hssPopClose();
  const grip = h("div", "hssgrip"); grip.title = tr("Drag to make the lanes taller or shorter"); hssBindGrip(grip, lanes);
  box.append(lanes, hssMini(), grip, hssDock(), help);
  hssFull(!!S.hssFull, true); hssHelpState();
  hssApplySize();
  hssBindTrack(track);
  HSS.base = NaN; HSS.left = HSS.w = HSS.lw = 0;
  requestAnimationFrame(() => { hssSync(A.cur() - visOffset(), EDIT.tlScaleV || EDIT.tlScale); hssDockSync(); dirty = true; });
  hssRenderSide();
}
// called by the timeline every time it is drawn (editor.js): keep the lanes under it
function hssSync(t, sc) {
  const lanes = $("hssLanes"); if (!lanes || !map) return;
  const track = lanes.querySelector(".hsstrack"), inner = track.firstChild, r = TL.getBoundingClientRect(), lr = lanes.getBoundingClientRect();
  if (!r.width) return;
  // narrow screens (phones): the lanes take the whole width (the timeline above is too small to line up with), and
  // the selection's controls go to the bar below
  const narrow = lr.width < 720, left = narrow ? Math.min(96, Math.round(lr.width * .24)) : Math.max(70, Math.round(r.left - lr.left)),
    w = narrow ? Math.round(lr.width - left - 6) : Math.min(Math.round(r.width), Math.round(lr.width - left));
  if (left !== HSS.left || w !== HSS.w || lr.width !== HSS.lw) {
    HSS.left = left; HSS.w = w; HSS.lw = lr.width; track.style.left = left + "px"; track.style.width = w + "px"; lanes.style.setProperty("--lab", left + "px"); HSS.base = NaN;
    const room = Math.round(lr.width - left - w) - 14, on = !narrow && room >= 120; // the controls go right of the lanes when there's room
    lanes.style.setProperty("--rcw", Math.min(room, 220) + "px"); lanes.classList.toggle("rc", on); lanes.parentNode.classList.toggle("hssrcon", on);
  }
  if (S.hssPage) sc = hssPageScale(w); // Page mode has its own zoom, out to the whole song
  const half = w / 2 / sc, play = track.querySelector(".hssplay");
  if (S.hssPage) { // like a music program: the columns stay put, the play line moves; at the end the next page comes
    const span = w / sc, start = HSS.base - half;
    if (!HSS.paged || !(t >= start && t <= start + span * .96) || Math.abs(sc - HSS.scale) > sc * .002) {
      // a new page starts at the left edge: on the bar line just before the play line when it's close, else the beat,
      // else just before the play line (never further back, or the play line would start in the middle)
      const b = beatInfo(t), bar = b.len * (b.meter || 4), barStart = b.off + Math.floor((t - b.off) / bar) * bar, beatStart = b.off + Math.floor((t - b.off) / b.len) * b.len;
      const lead = span * .08, s0 = span >= hssSongLen() ? -span * .01 : (t - barStart <= lead ? barStart : t - beatStart <= lead ? beatStart : t - span * .02) - Math.min(span * .01, 40);
      HSS.base = s0 + half; HSS.scale = sc; HSS.span = half * 1.1; HSS.paged = true; hssRender();
    }
    inner.style.transform = `translateX(${(w / 2).toFixed(1)}px)`;
    play.style.left = (w / 2 + (t - HSS.base) * sc).toFixed(1) + "px";
    hssMiniSync(t, HSS.base - half, span);
    return;
  }
  if (HSS.paged) { HSS.paged = false; HSS.base = NaN; }
  if (play.style.left) play.style.left = ""; // (back from page mode: the play line is in the middle again)
  if (!(Math.abs(t - HSS.base) < half * .6) || Math.abs(sc - HSS.scale) > sc * .002) { HSS.base = t; HSS.scale = sc; HSS.span = half * 2.2; hssRender(); }
  inner.style.transform = `translateX(${(w / 2 + (HSS.base - t) * sc).toFixed(1)}px)`;
  hssMiniSync(t, t - half, half * 2);
}
// Page mode's zoom (px per ms): its own, so zooming out to the whole song leaves the timeline above alone
function hssPageScale(w) {
  const fit = w / (hssSongLen() * 1.02);
  return S.hssPageFit ? fit : Math.max(fit, hssBoxMin(), Math.min(2, +S.hssPageZoom || EDIT.tlScaleV || EDIT.tlScale || .25));
}
// the furthest Page mode zooms out with boxes (they'd overlap beyond it); one step further is the whole song, as dots
const hssBoxMin = () => Math.min(2, 12 / hssGap());
function hssZoom(f) {
  if (!S.hssPage) return zoomTl(f);
  const cur = hssPageScale(HSS.w || 800), min = hssBoxMin(), fit = (HSS.w || 800) / (hssSongLen() * 1.02);
  if (S.hssPageFit && f < 1) return; // (already the whole song)
  S.hssPageFit = false; S.hssPageZoom = Math.max(min, Math.min(2, cur * f)); // zooming in from the whole song: straight to boxes
  if (f < 1 && (cur <= min * 1.001 || S.hssPageZoom <= fit)) S.hssPageFit = true; // out past the smallest boxes: the whole song
  save(); HSS.paged = false; dirty = true; hssSync(A.cur() - visOffset(), EDIT.tlScaleV || EDIT.tlScale);
}
function hssFitSong() { if (!S.hssPage) hssSetPage(true); S.hssPageFit = true; save(); HSS.paged = false; dirty = true; hssSync(A.cur() - visOffset(), EDIT.tlScaleV || EDIT.tlScale); }
// the two ways the lanes move: follow (they scroll under a fixed play line, with the timeline above) or page (they stay
// put and the play line moves across, the next page comes at the end, like a music program)
function hssSetPage(on) {
  S.hssPage = !!on; if (on && !S.hssPageZoom) S.hssPageZoom = EDIT.tlScaleV || EDIT.tlScale; save(); HSS.paged = false; HSS.base = NaN;
  document.querySelectorAll(".hssmode button").forEach(x => x.classList.toggle("on", (x.dataset.mode === "page") === S.hssPage));
  hssSync(A.cur() - visOffset(), EDIT.tlScaleV || EDIT.tlScale); dirty = true;
}
function hssModeCtl() {
  const g = h("span", "hssmode"); g.setAttribute("role", "group"); g.setAttribute("aria-label", tr("How the lanes move"));
  for (const [m, icon, label, title] of [["follow", "⇆", "Follow", "The lanes scroll along with the timeline; the play line stays in the middle"], ["page", "▤", "Page", "The columns stay put and the play line moves across, like a music program; the next page comes at the end"]]) {
    const x = hssBtn(icon + " " + tr(label), title, () => hssSetPage(m === "page")); x.dataset.mode = m; x.classList.toggle("on", (m === "page") === !!S.hssPage); g.append(x);
  }
  return g;
}
const hssGapMemo = new WeakMap(); // per map.hit (a new array after every edit)
function hssGap() {
  const memo = hssGapMemo.get(map.hit); if (memo) return memo;
  const all = hssPoints(), gaps = []; for (let i = 1; i < all.length; i++) { const g2 = all[i].t - all[i - 1].t; if (g2 > 0.5) gaps.push(g2); }
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length * .3)] : 200; hssGapMemo.set(map.hit, gap); return gap;
}
function hssRender(keep) {
  const lanes = $("hssLanes"); if (!lanes || !map) return;
  if (keep && !isFinite(HSS.base)) return;
  const inner = lanes.querySelector(".hssinner"), sc = HSS.scale || EDIT.tlScaleV || .25, base = isFinite(HSS.base) ? HSS.base : A.cur();
  const pts = hssPoints().filter(q => Math.abs(q.t - base) <= (HSS.span || 4000));
  const ticks = hssTicks().filter(q => Math.abs(q.t - base) <= (HSS.span || 4000));
  // cell width from a typical gap (30th percentile); where points are closer than that (short sliders at a high SV,
  // kick sliders, ticks next to an edge) a column gets narrower so that it never covers its neighbours (zoom in to widen)
  // The typical gap is the whole map's (the same box size everywhere: it doesn't change where the SV or density does)
  const k = hssK(), gap = hssGap(), cw = Math.max(14 * k, Math.min(34 * k, gap * sc - 3)), tcw = Math.max(18, Math.round(cw * .8));
  lanes.style.setProperty("--cw", cw + "px");
  const dots = !!(S.hssPage && S.hssPageFit && gap * sc < 12); // the whole song (Page mode, zoomed all the way out): small dots on one canvas, no boxes
  lanes.classList.toggle("hssdotmode", dots);
  if (dots) { for (const el of inner.children) el.innerHTML = ""; hssDots(pts, ticks, base, sc); hssMiniDraw(); return; }
  const cvd = lanes.querySelector(".hssdots"); if (cvd) cvd.hidden = true;
  const all = [...pts.map(q => ({ q, w: cw })), ...ticks.map(q => ({ q, w: tcw }))].sort((a, b) => a.q.t - b.q.t), width = new Map();
  all.forEach((it, i) => {
    const gl = i ? it.q.t - all[i - 1].q.t : Infinity, gr = i < all.length - 1 ? all[i + 1].q.t - it.q.t : Infinity;
    width.set(it.q, Math.max(6, Math.min(it.w, Math.min(gl, gr) * sc - 2)));
  });
  const place = (el, q) => { const w = width.get(q); el.style.width = w.toFixed(1) + "px"; el.style.left = ((q.t - base) * sc - w / 2).toFixed(1) + "px"; if (w < 15) el.classList.add("slim"); };
  const rows = inner.children, head = rows[0];
  for (const el of rows) el.innerHTML = "";
  for (const q of pts) {
    const key = hssKey(q);
    const mk = h("button", "hssmark " + hssSnapCls(q)); place(mk, q); mk.textContent = hssGlyph(q); mk.dataset.key = key; mk.dataset.t = Math.round(q.t);
    if (EDIT.sel.has(q.o.lid) && (q.k == null || EDIT.edge == null || EDIT.edge === q.k)) mk.classList.add("sel");
    mk.title = `${fmtMs(q.t)} · ${q.o.kind === "slider" ? tr("slider {part}", { part: edgeName(q.o, q.k) }) : tr(q.o.kind)}`;
    mk.onclick = e => hssSelect(q, e.shiftKey || e.ctrlKey || e.metaKey);
    mk.oncontextmenu = e => hssMenu(e, q);
    head.append(mk);
    HSS_ROWS.forEach((row, ri) => {
      const lane = rows[ri + 1], objLevel = row.key === "v" || row.key === "i", first = q.k == null || q.k === 0;
      if (row.key === "body" && (q.o.kind !== "slider" || q.k !== 0)) return;
      if (objLevel && !first) return; // one value per object
      const v = hssValue(q, row.key), cell = h("button", "hsscell " + row.cls); place(cell, q); cell.dataset.key = key; cell.dataset.row = row.key;
      if (typeof row.key === "number" || row.key === "body") { cell.classList.toggle("on", !!v); }
      else if (row.key === "n" || row.key === "a") { cell.textContent = HSS_SET[v] || "A"; cell.classList.add("s" + (v || 0)); cell.title = tr(HSS_SET_NAME[v] || "Auto"); }
      else { cell.textContent = v ? String(v) : "·"; cell.title = (v ? v + (row.key === "v" ? "%" : "") : "") + " " + (row.key === "v" ? tr("0 / – = the timing point's volume") : tr("0 / – = the timing point's index")); }
      cell.onpointerdown = e => { if (e.button === 2) return; hssPaintStart(e, row, q, cell); };
      cell.oncontextmenu = e => hssMenu(e, q);
      lane.append(cell);
    });
  }
  for (const q of ticks) {
    const key = hssTickKey(q), gl = !!hssGreenAt(Math.floor(q.t));
    const mk = h("button", "hssmark tick" + (gl ? " gl" : "")); place(mk, q); mk.textContent = "•"; mk.dataset.key = key; mk.dataset.t = Math.round(q.t);
    mk.title = `${fmtMs(q.t)} · ${tr("slider tick")}${gl ? " · " + tr("green line here") : ""}`;
    mk.onclick = () => { seekTo(Math.round(q.t)); hssPreview(q); };
    mk.oncontextmenu = e => hssMenu(e, q);
    head.append(mk);
    HSS_ROWS.forEach((row, ri) => {
      if (!HSS_TICK_ROWS.has(row.key)) return;
      const v = hssTickValue(q, row.key), cell = h("button", "hsscell tick " + row.cls + (gl ? " gl" : "")); place(cell, q); cell.dataset.key = key; cell.dataset.row = row.key;
      if (row.key === "n") { cell.textContent = HSS_SET[v] || "A"; cell.classList.add("s" + v); cell.title = tr("Slider tick: sample set from the green line ({s})", { s: tr(HSS_SET_NAME[v] || "Auto") }); }
      else { cell.textContent = String(v); cell.title = row.key === "v" ? tr("Slider tick: volume from the green line ({v}%)", { v }) : tr("Slider tick: custom index from the green line ({v})", { v }); }
      cell.onpointerdown = e => { if (e.button === 2) return; hssPaintStart(e, row, q, cell); };
      cell.oncontextmenu = e => hssMenu(e, q);
      rows[ri + 1].append(cell);
    });
  }
  if (HSS.hits && HSS.hits.length) hssRelight(lanes);
  hssMiniDraw();
}
// ---------- zoomed far out: every column as small dots on one canvas (thousands of boxes would make it stutter) ----------
const HSS_DOT = { 2: "#3b82f6", 4: "#f59e0b", 8: "#ec4899", body: "#3b82f6" }, HSS_SETCOL = ["#5c5470", "#d8d2e6", "#57d68d", "#ff7850"];
const HSS_SNAPCOL = { b1: "#ffffff", b2: "#ff5a6e", b4: "#4f8cff", b3: "#b48cff", bx: "#ffcf6b" };
function hssDots(pts, ticks, base, sc) {
  const lanes = $("hssLanes"), track = lanes.querySelector(".hsstrack"), inner = track.firstChild;
  let cv2 = track.querySelector(".hssdots");
  if (!cv2) { cv2 = h("canvas", "hssdots"); track.insertBefore(cv2, track.querySelector(".hssplay")); hssBindDots(cv2); }
  cv2.hidden = false;
  const dpr = devicePixelRatio || 1, W = track.clientWidth, H = track.clientHeight;
  if (cv2.width !== Math.round(W * dpr) || cv2.height !== Math.round(H * dpr)) { cv2.width = Math.round(W * dpr); cv2.height = Math.round(H * dpr); cv2.style.width = W + "px"; cv2.style.height = H + "px"; }
  const g = cv2.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const rowY = [...inner.children].map(el => el.offsetTop + el.offsetHeight / 2), X = t => W / 2 + (t - base) * sc;
  const dot = (x, y, r, col, a = 1) => { g.globalAlpha = a; g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
  HSS.dotItems = [];
  for (const q of pts) {
    const x = X(q.t); if (x < -4 || x > W + 4) continue;
    HSS.dotItems.push({ q, x });
    dot(x, rowY[0], EDIT.sel.has(q.o.lid) ? 4 : 3, EDIT.sel.has(q.o.lid) ? "#66ccff" : HSS_SNAPCOL[hssSnapCls(q)] || "#fff");
    HSS_ROWS.forEach((row, ri) => {
      const y = rowY[ri + 1], first = q.k == null || q.k === 0;
      if (row.key === "body" && (q.o.kind !== "slider" || q.k !== 0)) return;
      if ((row.key === "v" || row.key === "i") && !first) return;
      const v = hssValue(q, row.key);
      if (typeof row.key === "number" || row.key === "body") { if (v) dot(x, y, 3, HSS_DOT[row.key]); else dot(x, y, 1.2, "#fff", .18); }
      else if (row.key === "n" || row.key === "a") dot(x, y, v ? 2.6 : 1.6, HSS_SETCOL[v || 0], v ? 1 : .6);
      else if (v) dot(x, y, 2, "#fff", .8);
    });
  }
  for (const q of ticks) {
    const x = X(q.t); if (x < -4 || x > W + 4) continue;
    HSS.dotItems.push({ q, x, tick: true });
    dot(x, rowY[0], 1.4, "#9e93b5", .8);
    const v = hssTickValue(q, "n"); if (v) dot(x, rowY[HSS_ROWS.findIndex(r => r.key === "n") + 1], 1.8, HSS_SETCOL[v]);
  }
  g.globalAlpha = 1;
}
// the dots of what sounds light up (the same rows as the boxes: marker, sample set, the sounds that are on and their
// addition set), on a canvas of their own so the dots aren't redrawn for every hit
function hssDotFlash(e) {
  const lanes = $("hssLanes"), track = lanes.querySelector(".hsstrack"), dots = track.querySelector(".hssdots"); if (!dots) return;
  const it = (HSS.dotItems || []).find(i => !!i.tick === !!e.tick && Math.abs(i.q.t - e.t) <= 2); if (!it) return;
  const ri = k => HSS_ROWS.findIndex(r => r.key === k) + 1, rows = [0, ri("n")];
  if (!e.tick) { if (e.hs & 14) rows.push(ri("a")); for (const b of [2, 4, 8]) if (e.hs & b) rows.push(ri(b)); }
  let fx = track.querySelector(".hssdotfx");
  if (!fx) { fx = h("canvas", "hssdotfx"); track.insertBefore(fx, track.querySelector(".hssplay")); }
  const dpr = devicePixelRatio || 1;
  if (fx.width !== dots.width || fx.height !== dots.height) { fx.width = dots.width; fx.height = dots.height; fx.style.width = dots.style.width; fx.style.height = dots.style.height; }
  (HSS.fx = HSS.fx || []).push({ x: it.x, rows, at: performance.now() });
  if (HSS.fxRun) return;
  HSS.fxRun = true;
  const inner = track.firstChild, rowY = [...inner.children].map(el => el.offsetTop + el.offsetHeight / 2);
  const step = () => {
    const g = fx.getContext("2d"), now = performance.now(); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, fx.width, fx.height);
    HSS.fx = HSS.fx.filter(f => now - f.at < 320);
    for (const f of HSS.fx) {
      const k = (now - f.at) / 320;
      for (const r of f.rows) {
        const y = rowY[r]; g.globalAlpha = 1 - k;
        g.fillStyle = "#fff"; g.beginPath(); g.arc(f.x, y, 4.5 * (1 - k * .4), 0, 7); g.fill();
        g.strokeStyle = r === 0 ? "#ff66aa" : "#fff"; g.lineWidth = 2; g.beginPath(); g.arc(f.x, y, 5 + 9 * k, 0, 7); g.stroke();
      }
    }
    g.globalAlpha = 1;
    if (HSS.fx.length && fx.isConnected && lanes.classList.contains("hssdotmode")) requestAnimationFrame(step); else { HSS.fxRun = false; g.clearRect(0, 0, fx.width, fx.height); }
  };
  requestAnimationFrame(step);
}
// a click on a dot: the Time row selects (and plays) it, a sound row switches it, a set row goes to the next set,
// volume / index open the menu. Anything else is the track (seek).
function hssBindDots(cv2) {
  cv2.addEventListener("pointerdown", e => {
    const r = cv2.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, inner = cv2.parentNode.firstChild;
    let best = null; for (const it of HSS.dotItems || []) { const d = Math.abs(it.x - x); if (d <= 6 && (!best || d < best.d)) best = { ...it, d }; }
    if (!best) return; // the track's own handler: seek
    const ri = [...inner.children].findIndex(el => y >= el.offsetTop && y < el.offsetTop + el.offsetHeight); if (ri < 0) return;
    e.preventDefault(); e.stopPropagation();
    const q = best.q;
    if (e.button === 2) return hssMenu(e, q);
    if (ri === 0) { if (best.tick) { seekTo(Math.round(q.t)); hssPreview(q); } else hssSelect(q, e.shiftKey || e.ctrlKey || e.metaKey); return; }
    const row = HSS_ROWS[ri - 1];
    if (best.tick) { if (row.key === "n") hssApplyTicks("n", [q], (hssTickValue(q, "n") + 1) % 4); return; }
    if (typeof row.key === "number") hssApply(row.key, [q], !hssValue(q, row.key));
    else if (row.key === "body") { if (q.o.kind === "slider" && q.k === 0) hssApply("body", [q], !hssValue(q, "body")); }
    else if (row.key === "n" || row.key === "a") hssApply(row.key, [q], ((hssValue(q, row.key) || 0) + 1) % 4);
    else hssMenu(e, q);
  });
  cv2.addEventListener("contextmenu", e => e.preventDefault());
}
// ---------- the whole song in one strip under the lanes: where the sounds are, what the lanes show now; click or drag to go ----------
function hssMiniDraw() {
  const mini = $("hssMini"); if (!mini || !map) return;
  const cvm = mini.querySelector("canvas"), dpr = devicePixelRatio || 1, W = mini.clientWidth, H = mini.clientHeight; if (!W) return;
  if (cvm.width !== Math.round(W * dpr) || cvm.height !== Math.round(H * dpr)) { cvm.width = Math.round(W * dpr); cvm.height = Math.round(H * dpr); }
  const g = cvm.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const len = hssSongLen(), X = t => t / len * W, band = (H - 8) / 4;
  g.globalAlpha = .5; g.fillStyle = "#9e93b5"; for (const o of map.hit) g.fillRect(X(o.t), 2, 1, band); // objects
  g.globalAlpha = 1;
  for (const q of hssPoints()) {
    const x = X(q.t);
    [2, 4, 8].forEach((bit, i) => { if (q.o.hs != null && hssValue(q, bit)) { g.fillStyle = HSS_DOT[bit]; g.fillRect(x, 4 + band * (i + 1), 1.5, band - 1); } });
  }
}
const hssSongLen = () => Math.max(1000, (A.dur && A.dur()) || 0, (map && map.last || 0) + 1000);
function hssMiniSync(t, start, span) { // the window (what the lanes show) and the play line, without redrawing
  const mini = $("hssMini"); if (!mini) return;
  const len = hssSongLen(), W = mini.clientWidth, win = mini.querySelector(".hssminiwin"), pl = mini.querySelector(".hssminiplay");
  win.style.left = Math.max(0, start / len * W).toFixed(1) + "px"; win.style.width = Math.max(4, Math.min(W, span / len * W)).toFixed(1) + "px";
  pl.style.left = (t / len * W).toFixed(1) + "px";
}
function hssMini() {
  const m = h("div", "hssmini"); m.id = "hssMini"; m.title = tr("The whole song: coloured marks are whistle / finish / clap, the box is what the lanes show. Click or drag to go there.");
  m.append(h("canvas"), h("i", "hssminiwin"), h("i", "hssminiplay"));
  let on = false; const go = e => { const r = m.getBoundingClientRect(); seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * hssSongLen()); };
  m.addEventListener("pointerdown", e => { e.preventDefault(); on = true; m.setPointerCapture(e.pointerId); if (isPlaying()) pausePlayback(); go(e); });
  m.addEventListener("pointermove", e => { if (on) go(e); });
  m.addEventListener("pointerup", () => { on = false; }); m.addEventListener("pointercancel", () => { on = false; });
  return m;
}
// painting along a lane: the first cell decides the value (toggle / next set), every cell dragged over gets it
async function hssPaintStart(e, row, q, cell) {
  e.preventDefault(); e.stopPropagation();
  if (q.tick) { // green lines
    if (row.key === "v" || row.key === "i") {
      const ans = await askText(row.key === "v" ? tr("Volume at this slider tick (5–100 %): sets a green line here") : tr("Custom sample index at this slider tick: sets a green line here"), String(hssTickValue(q, row.key)), { type: "number", min: row.key === "v" ? 5 : 0, max: row.key === "v" ? 100 : undefined });
      if (ans == null || !isFinite(+ans)) return; hssApplyTicks(row.key, [q], +ans); hssPreview(q); return;
    }
  }
  if (row.key === "v" || row.key === "i") {
    const cur = hssValue(q, row.key), ans = await askText(row.key === "v" ? tr("Volume of this object (0–100 %, 0 = the timing point's)") : tr("Custom sample index of this object (0 = the timing point's)"), String(cur || 0), { type: "number", min: 0, max: row.key === "v" ? 100 : undefined });
    if (ans == null) return; const n = +ans; if (!isFinite(n)) return;
    hssApply(row.key, [q], n); return;
  }
  const cur = q.tick ? hssTickValue(q, row.key) : hssValue(q, row.key), val = typeof row.key === "number" || row.key === "body" ? !cur : ((cur || 0) + 1) % 4;
  const byKey = new Map([...hssPoints().map(p2 => [hssKey(p2), p2]), ...hssTicks().map(p2 => [hssTickKey(p2), p2])]);
  HSS.paint = { row, val, pts: new Map([[hssKey(q), q]]) };
  hssShowPaint(cell, row, val);
  const move = ev => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY), c = el && el.closest(".hsscell");
    if (!c || c.parentNode !== cell.parentNode || HSS.paint.pts.has(c.dataset.key)) return;
    const q2 = byKey.get(c.dataset.key); if (!q2) return;
    HSS.paint.pts.set(c.dataset.key, q2); hssShowPaint(c, row, val);
  };
  const up = () => {
    removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
    const P = HSS.paint; HSS.paint = null; if (!P) return;
    const list = [...P.pts.values()], ticks = list.filter(x => x.tick), objs = list.filter(x => !x.tick);
    if (objs.length) hssApply(P.row.key, objs, P.val);
    if (ticks.length && HSS_TICK_ROWS.has(P.row.key)) hssApplyTicks(P.row.key, ticks, P.val);
    if (list.length === 1) hssPreview(list[0]);
  };
  addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
}
function hssShowPaint(c, row, val) {
  if (typeof row.key === "number" || row.key === "body") c.classList.toggle("on", !!val);
  else { c.textContent = HSS_SET[val]; c.className = c.className.replace(/\bs\d\b/g, "") + " s" + val; }
  c.classList.add("painting");
}
// the track behaves like the timeline: drag empty space to scrub (unless the timeline is locked), scroll steps through
// the beat snap, Ctrl/Alt+scroll zooms (both zoom together)
function hssBindTrack(track) {
  track.addEventListener("pointerdown", e => {
    if (e.target.closest(".hsscell,.hssmark") || e.button === 2) return;
    if (S.tlLock) return toast(tr("The timeline is locked. Press the lock button (or Shift+L) to unlock it."), 2000);
    e.preventDefault(); if (isPlaying()) pausePlayback();
    HSS.drag = { x: e.clientX, t: A.cur(), moved: false }; track.setPointerCapture(e.pointerId);
  });
  const under = e => { const r = track.getBoundingClientRect(); return HSS.base + (e.clientX - r.left - r.width / 2) / (HSS.scale || EDIT.tlScaleV || .25); }; // page mode: the time under the pointer
  track.addEventListener("pointermove", e => {
    const d = HSS.drag; if (!d) return;
    const dx = e.clientX - d.x; if (Math.abs(dx) > 2) d.moved = true;
    if (S.hssPage) { if (d.moved) seekTo(under(e)); return; } // the play line follows the pointer, the page stays
    seekTo(d.t - dx / (EDIT.tlScaleV || .25));
  });
  const end = e => {
    const d = HSS.drag; HSS.drag = null; if (!d) return;
    if (!d.moved) { const r = track.getBoundingClientRect(); seekTo(snapTime(S.hssPage ? under(e) : A.cur() + (e.clientX - r.left - r.width / 2) / (EDIT.tlScaleV || .25))); }
  };
  track.addEventListener("pointerup", end); track.addEventListener("pointercancel", end);
  track.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) hssZoom(e.deltaY > 0 ? .85 : 1.18);
    else stepSnap(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
  }, { passive: false });
}
// called after every edit while the tab is open
function hsStudioRefresh() { if (EDIT.on && EDIT.tab === "hitsounds" && $("hssLanes")) { hssRender(true); hssRenderSide(); hssDockSync(); } }

// ---------- the tools for the selection (hitsound by beat, copy from another difficulty, clear…) and the map's own
// samples: drop-downs from the bar under the lanes, so they're one click away and don't push the page down ----------
function hssPanelBtns() {
  const mk = tab => { const x = hssBtn("", tab === "tools" ? "Hitsound by beat, copy from another difficulty, clear…" : "This map's own sample files", () => hssPop(tab, x), "hdpan"); x.dataset.tab = tab; x.setAttribute("aria-haspopup", "dialog"); return x; };
  const btns = [mk("tools"), mk("samples")]; hssPanelLabels(btns); return btns;
}
function hssPanelLabels(btns = document.querySelectorAll(".hdpan")) {
  const open = $("hssPop") && S.hssTab;
  for (const x of btns) {
    const on = open === x.dataset.tab; x.classList.toggle("on", !!on); x.setAttribute("aria-expanded", !!on);
    x.textContent = (x.dataset.tab === "tools" ? tr("Hitsound tools") : tr("Samples ({n})", { n: hssSampleFiles().length })) + (on ? " ▴" : " ▾");
  }
}
function hssPop(tab, btn) {
  if ($("hssPop") && S.hssTab === tab) return hssPopClose();
  S.hssTab = tab; save(); HSS.popBtn = btn;
  if (!$("hssPop")) {
    const pop = h("div", "hsspop"); pop.id = "hssPop"; pop.setAttribute("role", "dialog");
    const head = h("div", "hsspophead"), body = h("div", "hsspopbody"), x = h("button", "hdb hsspopx", "✕");
    x.type = "button"; x.title = tr("Close"); x.setAttribute("aria-label", x.title); x.onclick = hssPopClose;
    head.append(h("div", "seg hsstabs"), x); pop.append(head, body); document.body.append(pop);
  }
  hssRenderSide(); hssPopPlace();
}
function hssPopClose() { const p = $("hssPop"); if (p) p.remove(); HSS.popBtn = null; hssPanelLabels(); }
// under its button, or above it when there's more room there (full screen: the bar is at the bottom)
function hssPopPlace() {
  const pop = $("hssPop"), b = HSS.popBtn; if (!pop) return;
  if (!b || !b.isConnected || !$("hssLanes")) return hssPopClose();
  const r = b.getBoundingClientRect(), vw = document.documentElement.clientWidth, w = Math.min(560, vw - 24);
  const ctl = [$("edInfo"), $("play")].filter(x => x && x.offsetParent).map(x => x.getBoundingClientRect().top), vh = Math.min(innerHeight, ...ctl.filter(y => y > r.bottom)); // (not over the play controls)
  const below = vh - r.bottom - 20, above = r.top - 20, down = below >= 200 || below >= above; // (down unless that leaves too little room: the lanes stay visible)
  pop.style.width = w + "px"; pop.style.left = Math.max(12, Math.min(vw - w - 12, r.left)) + "px";
  pop.style.maxHeight = Math.max(220, down ? below : above) + "px";
  pop.style.top = down ? r.bottom + 8 + "px" : "auto"; pop.style.bottom = down ? "auto" : innerHeight - r.top + 8 + "px";
  pop.classList.toggle("up", !down);
}
addEventListener("resize", hssPopPlace);
addEventListener("scroll", hssPopPlace, true);
document.addEventListener("pointerdown", e => { const p = $("hssPop"); if (p && !p.contains(e.target) && !e.target.closest(".hdpan") && !e.target.closest(".ctxmenu")) hssPopClose(); }, true);
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("hssPop")) { e.preventDefault(); e.stopPropagation(); hssPopClose(); } }, true);
function hssRenderSide() {
  hssPanelLabels();
  const pop = $("hssPop"); if (!pop) return;
  const body = pop.querySelector(".hsspopbody"), tabs = pop.querySelector(".hsstabs"), st = body.scrollTop;
  const tab = S.hssTab === "samples" ? "samples" : "tools", n = hssSampleFiles().length;
  tabs.innerHTML = ""; body.innerHTML = "";
  for (const [k, l] of [["tools", tr("Hitsound tools")], ["samples", tr("This map's own samples ({n})", { n })]]) {
    const x = h("button", tab === k ? "on" : "", l); x.type = "button"; x.onclick = () => { S.hssTab = k; save(); hssRenderSide(); }; tabs.append(x);
  }
  if (tab === "tools") { const box = h("section", "hssbox"), dlg = h("div", "hsdlg"); hitsoundDialog(dlg, true); box.append(dlg); body.append(box); }
  else body.append(hssSamples());
  body.scrollTop = st;
}
const SAMPLE_RE = /^(normal|soft|drum)-(hitnormal|hitwhistle|hitfinish|hitclap|slidertick|sliderslide|sliderwhistle)(\d*)\.(wav|ogg|mp3)$/i;
const HSS_SOUNDS = ["hitnormal", "hitwhistle", "hitfinish", "hitclap", "slidertick", "sliderslide", "sliderwhistle"];
function hssSampleFiles() {
  const out = [];
  for (const k in files) { const f = files[k]; if (!f || f.dir) continue; const name = f.name.split("/").pop(), m = name.match(SAMPLE_RE); if (m && !f.name.includes("/")) out.push({ key: k, name, set: m[1].toLowerCase(), sound: m[2].toLowerCase(), idx: +m[3] || 1 }); }
  return out.sort((a, b) => a.idx - b.idx || a.set.localeCompare(b.set) || HSS_SOUNDS.indexOf(a.sound) - HSS_SOUNDS.indexOf(b.sound));
}
function hssSamples() {
  const box = h("section", "hssbox"), list = hssSampleFiles();
  box.append(h("p", "hint", tr("Files named like soft-hitclap2.wav. An object (or timing point) with custom index 2 plays soft-hitclap2; index 1 plays soft-hitclap. With no file, the default sound plays.")));
  const ul = h("div", "hsslist");
  for (const f of list) {
    const row = h("div", "hssfile"), play = h("button", "btn ghost sm", "▶"), del = h("button", "btn ghost sm danger", "✕");
    play.title = tr("Listen"); del.title = tr("Delete");
    play.onclick = async () => { ensureAudioCtx(); try { const b = await decodeAB(await files[f.key].async("arraybuffer")); playBuf(b, hsGain() || .6, 0); } catch { toast(tr("Couldn't play this file"), 2000); } };
    del.onclick = async () => { if (!(await ask(tr("Remove {f} from this map?", { f: f.name }), { ok: tr("Remove"), danger: true }))) return; delete files[f.key]; await hssSamplesChanged(); };
    row.append(h("code", null, f.name), play, del); ul.append(row);
  }
  if (!list.length) ul.append(h("p", "hint", tr("None yet: the default hitsounds are used.")));
  box.append(ul);
  // add your own
  const add = h("div", "hssadd"), inp = h("input"), set = h("select"), snd = h("select"), idx = h("input"), go = h("button", "btn main sm", tr("Add sample"));
  inp.type = "file"; inp.accept = ".wav,.ogg,.mp3,audio/*";
  for (const s of ["normal", "soft", "drum"]) set.add(new Option(s, s));
  for (const s of HSS_SOUNDS) snd.add(new Option(s, s));
  idx.type = "number"; idx.min = 1; idx.max = 999; idx.value = 1; idx.title = tr("Custom index");
  idx.addEventListener("keydown", e => e.stopPropagation());
  const nameOut = h("code", "hssname");
  const ext = () => { const f = inp.files[0]; return f ? (f.name.match(/\.(wav|ogg|mp3)$/i) || [".wav"])[0].toLowerCase() : ".wav"; };
  const showName = () => { nameOut.textContent = `${set.value}-${snd.value}${+idx.value > 1 ? +idx.value : ""}${ext()}`; };
  inp.onchange = () => { const f = inp.files[0], m = f && f.name.match(SAMPLE_RE); if (m) { set.value = m[1].toLowerCase(); snd.value = m[2].toLowerCase(); idx.value = +m[3] || 1; } showName(); };
  set.onchange = snd.onchange = idx.oninput = showName;
  go.onclick = async () => {
    const f = inp.files[0]; if (!f) return toast(tr("Choose an audio file first"), 1800);
    if (f.size > 2e6) return toast(tr("Hitsound files should be small (under 2 MB)"), 2500);
    const name = nameOut.textContent, key = norm(name);
    if (files[key] && !(await ask(tr("{f} already exists. Replace it?", { f: name }), { ok: tr("Replace") }))) return;
    try { await decodeAB(await f.arrayBuffer()); } catch { return toast(tr("This file isn't audio the browser can play"), 2500); }
    files[key] = blobEntry(name, f); inp.value = "";
    await hssSamplesChanged(); toast(tr("Added {f}", { f: name }), 1800);
  };
  const r1 = h("div", "hssaddrow"); r1.append(inp);
  const r2 = h("div", "hssaddrow"); r2.append(set, snd, idx);
  showName();
  add.append(h("b", null, tr("Add your own sample")), r1, r2, nameOut, go, h("p", "hint", tr("It becomes part of the map: it's included when you export the .osz or save online.")));
  box.append(add);
  return box;
}
async function hssSamplesChanged() {
  if (!LIVE.on || LIVE.host) EDIT.changed = true;
  await loadMapSamples(); cloudTouch(); draftSchedule(); hssRenderSide();
}

// ← → in the studio: the previous / next hit point (Alt+← → still moves the selected object in time)
function hssStep(dir) {
  const pts = hssPoints(); if (!pts.length) return;
  let i = HSS.focus ? pts.findIndex(q => hssKey(q) === HSS.focus) : -1;
  if (i < 0) { const t = A.cur(); i = dir > 0 ? pts.findIndex(q => q.t > t + 2) - 1 : pts.findIndex(q => q.t >= t - 2); if (i < -1) i = pts.length - 1; }
  hssSelect(pts[Math.max(0, Math.min(pts.length - 1, i + dir))], false);
}
