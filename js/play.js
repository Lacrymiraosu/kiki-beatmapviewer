"use strict";
// ============ Test play (editor: ▶ Test or F5): play the map yourself, like osu!'s test mode ============
// Judged the osu!stable way: hit windows from OD (300: 80 - 6·OD, 100: 140 - 8·OD, 50: 200 - 10·OD ms), a click up to
// 400 ms early on the next object is a miss (osu!lazer's miss window), objects are hit in order (notelock: clicking a
// later one shakes it). Sliders: the head, then every tick, repeat and the tail count while a key is held and the cursor
// is on the ball (within the follow circle, 2.4× the radius, once following); the slider's judgement is the share of
// those it got. Spinners count turns of the cursor around the centre (capped at 477 rpm like osu!). ScoreV1 score,
// combo, accuracy, HP (no fail) and a hit error bar; Esc stops and shows the results, then back to the editor.
// No delay: frames aren't capped while playing (player.js), a key or click is judged at the moment it happened (its
// event time, not the next frame), the cursor follows the pointer's raw updates, and a hit plays its hitsound at once
// instead of on the map's schedule (audio.js skips the scheduled ones).
// Settings → Test play (S.testPlay, defaults in TP_DEF): the keys (rebindable), mouse / touch / notelock, lead-in,
// where it starts, hitsounds, and which parts of the HUD show.
const PLAY = { on: false, back: 0, from: 0, st: new Map(), idx: 0, held: new Set(), x: 256, y: 192, seen: false, spinA: null, spinAt: 0,
  combo: 0, max: 0, score: 0, n: { 300: 0, 100: 0, 50: 0, 0: 0 }, errs: [], hp: 1, fx: [], shake: null, dm: 4, w: null, end: 0 };
// ---------- settings ----------
const TP_DEF = { on: false, k1: "KeyZ", k2: "KeyX", stop: "Escape", retry: "Backquote", start: "F5", mouse: true, touch: true, notelock: true, hsOnHit: true,
  lead: 1.5, from: "here", score: true, combo: true, hp: true, errBar: true, show300: true };
const TP_KEYS = [["k1", "Hit (key 1)"], ["k2", "Hit (key 2)"], ["stop", "Stop"], ["retry", "Restart from the same place"], ["start", "Start test play (Modding)"]];
const tpOpt = k => { const v = (S.testPlay || {})[k]; return v === undefined ? TP_DEF[k] : v; };
const tpKey = k => tpOpt(k);
function tpSet(k, v) { S.testPlay = { ...(S.testPlay || {}), [k]: v }; save(); }
// the master switch (off by default): off, the 🎮 Test play / ▶ Test buttons are hidden and F5 switches Preview / Modding
function tpOn() { return !!tpOpt("on"); }
function tpApply() {
  const on = tpOn();
  $("playBtn").hidden = !on || EDIT.on; $("edTest").hidden = !on || !EDIT.on; $("tapPlay").hidden = !on;
}
const KEY_NAMES = { Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: "Space", Escape: "Esc",
  Enter: "Enter", Tab: "Tab", Backspace: "Backspace", ShiftLeft: "Left Shift", ShiftRight: "Right Shift", ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl", AltLeft: "Left Alt", AltRight: "Right Alt",
  MetaLeft: "Left ⌘", MetaRight: "Right ⌘", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", CapsLock: "Caps Lock", Insert: "Insert", Delete: "Del", Home: "Home", End: "End", PageUp: "Page Up", PageDown: "Page Down" };
function keyName(code) { // e.code -> what's printed on the key ("KeyZ" -> "Z")
  if (!code) return "–";
  const m = code.match(/^Key([A-Z])$/) || code.match(/^Digit(\d)$/); if (m) return m[1];
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Numpad/.test(code)) return "Num " + code.slice(6);
  return code;
}
const hitKeys = () => [tpKey("k1"), tpKey("k2")];
function playWindows() {
  const od = +(map.diff.OverallDifficulty ?? 5);
  return { 300: 80 - 6 * od, 100: 140 - 8 * od, 50: 200 - 10 * od, miss: 400 };
}
function playDiffMult() { // ScoreV1 difficulty multiplier (HP + CS + OD + object density)
  const d = map.diff, br = map.breaks.reduce((s, b) => s + Math.max(0, b[1] - b[0]), 0);
  const drain = Math.max(1, (map.last - map.first - br) / 1000), dens = Math.max(0, Math.min(16, map.hit.length / drain * 8));
  return Math.round((+(d.HPDrainRate ?? 5) + +(d.CircleSize ?? 5) + +(d.OverallDifficulty ?? 5) + dens) / 38 * 5);
}
// the time on the song when an input happened (what was on screen then), not when the next frame runs
function playTimeOf(e) {
  const now = nowMs() - visOffset(), late = e && e.timeStamp ? Math.max(0, Math.min(100, performance.now() - e.timeStamp)) : 0;
  return now - late * A.rate;
}

// ---------- start / stop ----------
function playStart(from) {
  if (!map || !tpOn()) return;
  if (!map.hit.length) return toast(tr("Place some objects first"));
  ensureAudioCtx();
  PLAY.ed = EDIT.on; PLAY.back = A.cur(); // (back to where it started from: the editor or the preview)
  setMode(false); // (first: leaving the editor can rebuild the objects)
  let f = from ?? (tpOpt("from") === "start" ? 0 : !PLAY.ed && startAt > 0 ? startAt : A.cur()); if (f >= map.last) f = 0; // (at the end: from the start; a shared link's time in the preview)
  PLAY.from = f; PLAY.w = playWindows(); PLAY.dm = playDiffMult();
  Object.assign(PLAY, { st: new Map(), idx: 0, held: new Set(), spinA: null, combo: 0, max: 0, score: 0, n: { 300: 0, 100: 0, 50: 0, 0: 0 }, errs: [], hp: 1, fx: [], shake: null, disp: 0 });
  for (const o of map.hit) {
    const st = { skip: o.t < f, res: null, at: 0, head: null, headAt: 0, track: false, trackK: 0, ci: 0, got: 0, tot: 0, rot: 0, ang: 0 };
    if (o.kind === "slider" && !st.skip) {
      const cps = [];
      for (let k = 0; k < o.slides; k++) {
        for (const [fr] of o.ticks || []) cps.push({ t: o.t + o.span * k + (k % 2 ? 1 - fr : fr) * o.span, kind: "tick" });
        if (k < o.slides - 1) cps.push({ t: o.t + o.span * (k + 1), kind: "repeat" });
      }
      cps.sort((a, b) => a.t - b.t);
      cps.push({ t: Math.max(o.t, o.end - 36), kind: "tail" }); // (osu!: the end is checked a little before it, so a quick slider is fair)
      st.cps = cps;
    }
    if (o.kind === "spinner") { const sec = Math.max(0, o.end - o.t) / 1000, od = +(map.diff.OverallDifficulty ?? 5); st.need = Math.floor(sec * (od < 5 ? 1.5 + od / 5 : 2.5 + 1.25 * (od - 5) / 5)); } // (turns needed: osu!lazer)
    PLAY.st.set(o.lid, st);
  }
  PLAY.on = true;
  UI.player.classList.add("testplay"); cardStart = -1e9; $("playStop").hidden = false;
  seekTo(Math.max(0, f - Math.max(0, +tpOpt("lead") || 0) * 1000)); // (lead-in: Settings → Test play)
  closeSheet(); closeTools(); UI.tapStart.hidden = true; needTapResume = false;
  playNow(); UI.ui.classList.add("hide");
  if (!playStart.hinted) { playStart.hinted = true; toast(TOUCH ? tr("Test play: tap the circles, hold on sliders, spin spinners • ✕ in the corner stops") : tr("Test play: {k1} / {k2} or the mouse buttons • {stop} stops • keys in Settings → Test play", { k1: keyName(tpKey("k1")), k2: keyName(tpKey("k2")), stop: keyName(tpKey("stop")) }), 4500); }
  dirty = true;
}
function playStop(results) {
  if (!PLAY.on) return;
  PLAY.on = false; PLAY.held.clear();
  pausePlayback(); UI.player.classList.remove("testplay"); $("playStop").hidden = true;
  const sum = playSummary();
  if (PLAY.ed) setMode(true); seekTo(PLAY.back); showUI(); dirty = true;
  if (results && sum.total) playResults(sum);
}
function playRetry() { // the restart key: again from the same place, no results
  if (!PLAY.on) return;
  const f = PLAY.from; playStop(false); playStart(f);
}
function playSummary() {
  const n = PLAY.n, total = n[300] + n[100] + n[50] + n[0], E = PLAY.errs.map(x => x.e);
  const mean = E.length ? E.reduce((a, b) => a + b, 0) / E.length : 0, sd = E.length > 1 ? Math.sqrt(E.reduce((a, b) => a + (b - mean) ** 2, 0) / (E.length - 1)) : 0;
  return { total, acc: total ? (300 * n[300] + 100 * n[100] + 50 * n[50]) / (300 * total) : 1, n: { ...n }, max: PLAY.max, score: PLAY.score, ur: sd * 10, mean, hits: E.length, from: PLAY.from };
}
async function playResults(r) {
  const box = h("div", "playres"), cell = (label, value, cls) => { const c = h("div", "prc" + (cls ? " " + cls : "")); c.append(h("small", null, label), h("b", null, value)); box.append(c); };
  cell(tr("Accuracy"), (r.acc * 100).toFixed(2) + "%", "big"); cell(tr("Max combo"), r.max + "x", "big");
  cell("300", r.n[300], "j300"); cell("100", r.n[100], "j100"); cell("50", r.n[50], "j50"); cell(tr("Miss"), r.n[0], "j0");
  cell(tr("Score"), String(Math.round(r.score)).padStart(8, "0"));
  cell(tr("Unstable rate"), r.hits > 1 ? r.ur.toFixed(1) : "–");
  cell(tr("Average"), r.hits ? (Math.abs(r.mean) < .5 ? tr("on time") : tr(r.mean < 0 ? "{ms} ms early" : "{ms} ms late", { ms: Math.abs(r.mean).toFixed(1) })) : "–");
  const again = await modal({ title: tr("Test play"), body: box, dismiss: false, buttons: [{ label: tr(PLAY.ed ? "Back to the editor" : "Back to the preview"), value: false, cls: "ghost" }, { label: tr("Play again"), value: true, cls: "main" }] });
  if (again) { if (PLAY.ed) setMode(true); playStart(r.from); }
}

// ---------- the game: what happens as time passes ----------
function playAward(o, res, x, y, t, err) {
  PLAY.n[res]++;
  if (res) { PLAY.combo++; PLAY.max = Math.max(PLAY.max, PLAY.combo); PLAY.score += res + Math.floor(res * Math.max(0, PLAY.combo - 1) * PLAY.dm / 25); }
  else PLAY.combo = 0;
  PLAY.hp = Math.max(0, Math.min(1, PLAY.hp + ({ 300: .04, 100: .015, 50: -.01, 0: -.1 })[res]));
  if (err != null) { PLAY.errs.push({ e: err, at: t, res }); if (PLAY.errs.length > 2000) PLAY.errs.shift(); }
  PLAY.fx.push({ x, y, res, at: t }); if (PLAY.fx.length > 40) PLAY.fx.shift();
}
function playSound(tt, tick) { // the hitsound of that part of an object, now (unless they play on the map's time: Settings → Test play)
  if (!tpOpt("hsOnHit")) return;
  const ev = map.sounds;
  for (let i = lastBefore(ev, tt + 1.5, "t"); i >= 0 && ev[i].t >= tt - 1.5; i--) if (!!ev[i].tick === !!tick) { playEvent(ev[i], 0); return; }
}
function playUpdate(t) {
  const H = map.hit, w = PLAY.w, r = map.radius;
  while (PLAY.idx < H.length) { const st = PLAY.st.get(H[PLAY.idx].lid); if (st && (st.skip || st.res != null)) PLAY.idx++; else break; }
  for (let i = PLAY.idx; i < H.length && H[i].t - map.preempt <= t; i++) {
    const o = H[i], st = PLAY.st.get(o.lid); if (!st || st.skip || st.res != null) continue;
    if (o.kind === "circle") { if (t > o.t + w[50]) { st.res = 0; st.at = t; playAward(o, 0, o.x, o.y, t); } continue; }
    if (o.kind === "spinner") {
      if (t >= o.end) {
        const k = st.need ? st.rot / (2 * Math.PI) / st.need : 1, res = k >= 1 ? 300 : k >= .9 ? 100 : k >= .75 ? 50 : 0;
        st.res = res; st.at = t; playAward(o, res, 256, 192, t);
        if (res) playSound(o.end, false);
      }
      continue;
    }
    // slider: the head, then following the ball
    if (st.head == null && t > o.t + w[50]) { st.head = 0; st.headAt = t; PLAY.combo = 0; PLAY.fx.push({ x: o.x, y: o.y, res: 0, at: t, small: true }); }
    if (t >= o.t) {
      const b = ballF(o, Math.min(t, o.end)), p = pointAt(o, b.f), d = Math.hypot(PLAY.x - p[0], PLAY.y - p[1]);
      st.track = PLAY.held.size > 0 && t <= o.end + 50 && d <= (st.track ? 2.4 : 1) * r;
    }
    while (st.ci < st.cps.length && st.cps[st.ci].t <= t) {
      const c = st.cps[st.ci++]; st.tot++;
      if (st.track) {
        st.got++; PLAY.combo++; PLAY.max = Math.max(PLAY.max, PLAY.combo); PLAY.score += c.kind === "tick" ? 10 : 30;
        playSound(c.kind === "tail" ? o.end : c.t, c.kind === "tick");
      } else if (c.kind !== "tail") PLAY.combo = 0; // (a missed end doesn't break the combo, like osu!)
    }
    if (t >= o.end && st.ci >= st.cps.length) {
      const got = st.got + (st.head > 0 ? 1 : 0), all = st.tot + 1, k = got / all, res = k >= 1 ? 300 : k >= .5 ? 100 : k > 0 ? 50 : 0;
      st.res = res; st.at = t; const e = endPos(o);
      PLAY.n[res]++; if (res) PLAY.score += res + Math.floor(res * Math.max(0, PLAY.combo - 1) * PLAY.dm / 25);
      PLAY.hp = Math.max(0, Math.min(1, PLAY.hp + ({ 300: .04, 100: .015, 50: -.01, 0: -.1 })[res]));
      PLAY.fx.push({ x: e[0], y: e[1], res, at: t }); if (PLAY.fx.length > 40) PLAY.fx.shift();
    }
  }
  if (t > map.last + 1500 && PLAY.idx >= H.length) playStop(true);
}

// ---------- input ----------
function playPress(id, e) {
  if (PLAY.held.has(id)) return;
  PLAY.held.add(id);
  const t = playTimeOf(e), H = map.hit, w = PLAY.w, r = map.radius;
  let cand = null;
  for (let i = PLAY.idx; i < H.length; i++) { // the first object still waiting for its click (notelock: nothing later counts first)
    const o = H[i], st = PLAY.st.get(o.lid);
    if (!st || st.skip || o.kind === "spinner") continue;
    if (o.kind === "circle" ? st.res != null : st.head != null) continue;
    if (o.t + w[50] < t) continue;
    cand = o; break;
  }
  if (cand && !tpOpt("notelock")) { // notelock off: the earliest waiting object under the cursor, whatever came before it
    let pick = null;
    for (let i = H.indexOf(cand); i < H.length && H[i].t - t <= w.miss; i++) {
      const o = H[i], s2 = PLAY.st.get(o.lid);
      if (!s2 || s2.skip || o.kind === "spinner" || (o.kind === "circle" ? s2.res != null : s2.head != null) || o.t + w[50] < t) continue;
      if (Math.hypot(PLAY.x - o.x, PLAY.y - o.y) <= r) { pick = o; break; }
    }
    if (pick) cand = pick;
  }
  if (!cand || cand.t - t > w.miss) return; // too early for anything
  const st = PLAY.st.get(cand.lid);
  if (Math.hypot(PLAY.x - cand.x, PLAY.y - cand.y) > r) { // not on it: a later object under the cursor shakes
    for (let i = H.indexOf(cand) + 1; i < H.length && H[i].t - t <= w.miss; i++) if (H[i].kind !== "spinner" && Math.hypot(PLAY.x - H[i].x, PLAY.y - H[i].y) <= r) { PLAY.shake = { lid: H[i].lid, at: t }; break; }
    return;
  }
  const err = t - cand.t, a = Math.abs(err), res = a <= w[300] ? 300 : a <= w[100] ? 100 : a <= w[50] ? 50 : 0;
  if (cand.kind === "circle") { st.res = res; st.at = t; playAward(cand, res, cand.x, cand.y, t, res ? err : null); }
  else { // a slider's head: 30 points and combo; its own judgement comes at the end
    st.head = res; st.headAt = t;
    if (res) { PLAY.combo++; PLAY.max = Math.max(PLAY.max, PLAY.combo); PLAY.score += 30; PLAY.errs.push({ e: err, at: t, res }); }
    else { PLAY.combo = 0; PLAY.fx.push({ x: cand.x, y: cand.y, res: 0, at: t, small: true }); }
    st.track = !!res;
  }
  if (res) playSound(cand.t, false);
  dirty = true;
}
function playRelease(id) { PLAY.held.delete(id); if (!PLAY.held.size) PLAY.spinA = null; }
function playMove(e) {
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null, list = evs && evs.length ? evs : [e];
  for (const q of list) {
    const p = toOsu(q); PLAY.x = p[0]; PLAY.y = p[1]; PLAY.seen = true;
    if (PLAY.held.size) playSpin(q);
  }
  dirty = true;
}
function playSpin(e) { // turning the cursor around the centre during a spinner
  const t = playTimeOf(e), H = map.hit; let o = null;
  for (let i = Math.max(0, PLAY.idx - 1); i < H.length && H[i].t <= t; i++) if (H[i].kind === "spinner" && t <= H[i].end) { o = H[i]; break; }
  if (!o) { PLAY.spinA = null; return; }
  const st = PLAY.st.get(o.lid); if (!st || st.skip || st.res != null) return;
  const a = Math.atan2(PLAY.y - 192, PLAY.x - 256), now = e.timeStamp || performance.now();
  if (PLAY.spinA != null) {
    let d = a - PLAY.spinA; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const cap = Math.max(1, now - PLAY.spinAt) * 0.05 * A.rate; // 477 rpm
    if (Math.abs(d) > cap) d = Math.sign(d) * cap;
    const before = Math.floor(st.rot / (2 * Math.PI));
    st.rot += Math.abs(d); st.ang += d;
    if (Math.floor(st.rot / (2 * Math.PI)) > before && st.rot / (2 * Math.PI) > st.need) PLAY.score += 1000; // (bonus spins)
  }
  PLAY.spinA = a; PLAY.spinAt = now;
}
// pointer: the cursor follows raw updates where the browser has them; a button or a touch is a key
let rawAt = -1e9; // (when raw updates last came: pointermove only stands in when they don't, so no turn of a spinner counts twice)
if (typeof onpointerrawupdate !== "undefined") UI.player.addEventListener("pointerrawupdate", e => { if (PLAY.on) { rawAt = performance.now(); playMove(e); } }, true);
UI.player.addEventListener("pointermove", e => { if (PLAY.on && (e.pointerType !== "mouse" || performance.now() - rawAt > 100)) playMove(e); }, true);
UI.player.addEventListener("pointerdown", e => {
  if (!PLAY.on || e.target !== cv) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const p = toOsu(e); PLAY.x = p[0]; PLAY.y = p[1]; PLAY.seen = true;
  if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2) return;
  if (e.pointerType === "touch" ? !tpOpt("touch") : !tpOpt("mouse")) return; // (Settings → Test play: only aiming)
  playPress("p" + e.pointerId + ":" + e.button, e);
}, true);
for (const ev of ["pointerup", "pointercancel"]) addEventListener(ev, e => { if (!PLAY.on) return; for (const id of [...PLAY.held]) if (id.startsWith("p" + e.pointerId + ":")) playRelease(id); }, true);
cv.addEventListener("contextmenu", e => { if (PLAY.on) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
addEventListener("keydown", e => {
  if (!PLAY.on || TPB.wait) return;
  if (hitKeys().includes(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) playPress("k" + e.code, e); return; }
  if (e.code === "Escape" || e.code === tpKey("stop") || e.code === tpKey("start")) { e.preventDefault(); e.stopImmediatePropagation(); playStop(true); return; } // (Esc always stops)
  if (e.code === tpKey("retry")) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) playRetry(); return; }
  if (e.code === "Space") { e.preventDefault(); e.stopImmediatePropagation(); } // (no pausing by accident)
}, true);
addEventListener("keyup", e => { if (PLAY.on && hitKeys().includes(e.code)) { e.preventDefault(); playRelease("k" + e.code); } }, true);
addEventListener("blur", () => { if (PLAY.on) { PLAY.held.clear(); PLAY.spinA = null; } });
// the buttons: Modding's ▶ Test is in editor.js; the preview has 🎮 Play (top bar) and one on the tap-to-start card;
// ✕ in the corner stops (a touch screen has no Esc, and the bars stay hidden while playing)
$("playBtn").onclick = () => playStart();
$("tapPlay").onclick = e => { e.stopPropagation(); playStart(); };
$("playStop").onclick = e => { e.stopPropagation(); playStop(true); };
tpApply();

// ---------- drawing ----------
function playDraw(t, beatK) {
  const H = map.hit, pre = map.preempt, s = map.radius / 64;
  const hi = lastBefore(H, t + pre, "t");
  if (hi >= 0) {
    let lo = hi; while (lo > 0 && H[lo - 1].t > t - 30000) lo--;
    drawFollowPoints(t, lo, hi);
    for (let i = hi + 1; i < H.length && H[i].t < t + pre + 4000; i++) if (H[i].kind === "slider" && heavyBody(H[i])) sliderBody(H[i], palette(H[i].ci), 1);
    for (let i = hi; i >= lo; i--) {
      const o = H[i], st = PLAY.st.get(o.lid); if (!st || st.skip) continue;
      if (Math.max(o.end, st.at || 0) + 800 < t) continue;
      const col = palette(o.ci), aIn = clamp01((t - (o.t - pre)) / map.fadeIn);
      if (o.kind === "spinner") drawSpinner(o, t, { rot: st.ang, prog: st.need ? clamp01(st.rot / (2 * Math.PI) / st.need) : 1, done: st.res != null });
      else if (o.kind === "slider") playSlider(o, st, t, col, s, aIn, beatK);
      else playCircle(o, st, t, col, s, aIn);
    }
  }
  for (const f of PLAY.fx) playJudge(f, t);
}
function shakeX(o, t) { const S2 = PLAY.shake; if (!S2 || S2.lid !== o.lid) return 0; const k = (t - S2.at) / 200; return k < 0 || k > 1 ? 0 : Math.sin(k * Math.PI * 6) * 8 * (1 - k); }
function playCircle(o, st, t, col, s, aIn) {
  if (st.res == null) {
    const x = o.x + shakeX(o, t);
    drawHead(o, x, o.y, col, s, aIn);
    if (t < o.t) blit(T("approachcircle", col), x, o.y, s * (1 + 3 * (o.t - t) / map.preempt), approachAlpha(o, t));
  } else if (st.res) hitBurst(o, o.x, o.y, col, s, t - st.at);
  else { const k = (t - st.at) / 160; if (k < 1) drawHead(o, o.x, o.y + 6 * k, col, s, aIn * (1 - k)); }
}
function playSlider(o, st, t, col, s, aIn, beatK) {
  const bodyA = t <= o.end ? aIn : clamp01(1 - (t - o.end) / 240);
  const [from, frac] = bodyRange(o, t);
  if (bodyA > 0) drawBody(o, col, bodyA, frac, from);
  sliderTicks(o, t, s, aIn);
  if (bodyA > 0 && t <= o.end) {
    if (S.sliderEnd) drawEndCircle(o, col, s, bodyA);
    if (o.slides > 1 && frac >= 1) { const cur = t < o.t ? 0 : ballF(o, t).rep; if (cur < o.slides - 1) drawArrow(o, cur % 2 === 0, s, bodyA, beatK); if (cur + 1 < o.slides - 1) drawArrow(o, cur % 2 === 1, s, bodyA, beatK); }
  }
  if (st.head == null) {
    const x = o.x + shakeX(o, t);
    drawHead(o, x, o.y, col, s, aIn, true);
    if (t < o.t) blit(T("approachcircle", col), x, o.y, s * (1 + 3 * (o.t - t) / map.preempt), approachAlpha(o, t));
  } else if (st.head) hitBurst(o, o.x, o.y, col, s, t - st.headAt, true);
  if (t >= o.t && t <= o.end) {
    st.trackK += ((st.track ? 1 : 0) - st.trackK) * Math.min(1, frameDt / 60);
    const p = drawBall(o, t, col, s);
    if (st.trackK > .02) blit(T("sliderfollowcircle"), p[0], p[1], s * (.5 + .5 * st.trackK), st.trackK);
  }
}
function playJudge(f, t) {
  const age = t - f.at; if (age < 0 || age > 600 || (f.res === 300 && !tpOpt("show300"))) return;
  const tex = T(f.res === 300 ? "hit300" : f.res === 100 ? "hit100" : f.res === 50 ? "hit50" : "hit0"); if (!tex) return;
  if (f.res === 0) { const k = age / 600; blit(tex, f.x, f.y + 20 * k * k, (f.small ? .45 : .6) * (1.3 - .3 * Math.min(1, age / 80)), 1 - k * k, .2 * k); return; }
  const sc = age < 96 ? .6 + .5 * (age / 96) : age < 120 ? 1.1 - .2 * ((age - 96) / 24) : .9 + .1 * Math.min(1, (age - 120) / 100);
  blit(tex, f.x, f.y, sc * .6, age < 350 ? 1 : 1 - (age - 350) / 250);
}
function playCursor() {
  if (!PLAY.seen) return;
  const own = !!SK.tex.cursor, cfg = own ? SK : DEFSK && DEFSK.tex.cursor ? DEFSK : FALLBACK, tex = n => own ? SK.tex[n] || null : texOf(n);
  const cur = tex("cursor"), mid = tex("cursormiddle"), off = tx => tx && cfg.cursorCentre === false ? [tx.img.width / tx.hd / 2, tx.img.height / tx.hd / 2] : [0, 0];
  const sc = PLAY.held.size ? 1.15 : 1, oc = off(cur), om = off(mid);
  blit(cur, PLAY.x + oc[0], PLAY.y + oc[1], sc, 1); blit(mid, PLAY.x + om[0], PLAY.y + om[1], sc, 1);
}
function playHUD(t, B) {
  const u = B.u, pad = 14 * u, top = B.top + pad, right = B.r - pad, left = B.l + pad, W = B.r - B.l;
  PLAY.disp = PLAY.disp == null || PLAY.score < PLAY.disp ? PLAY.score : PLAY.disp + (PLAY.score - PLAY.disp) * Math.min(1, frameDt / 90);
  const sum = playSummary();
  ctx.textBaseline = "top"; ctx.globalAlpha = 1; ctx.textAlign = "right";
  if (tpOpt("score")) {
    ctx.font = `600 ${34 * u}px Inter,sans-serif`; sText(String(Math.round(PLAY.disp)).padStart(8, "0"), right, top, u, "#fff");
    ctx.font = `600 ${18 * u}px Inter,sans-serif`; sText((sum.acc * 100).toFixed(2) + "%", right, top + 40 * u, u, "#fff");
  }
  ctx.font = `600 ${14 * u}px Inter,sans-serif`; sText(tr("Test") + (A.rate !== 1 ? ` ${A.rate}x` : "") + " · " + keyName(tpKey("stop")), right, top + (tpOpt("score") ? 64 : 0) * u, u, "#66ccff");
  const hbW = Math.min(W * .34, 320 * u), hbY = top + 6 * u; // HP
  if (tpOpt("hp")) {
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.fillRect(left, hbY, hbW, 9 * u);
    ctx.fillStyle = PLAY.hp > .3 ? "#ff66aa" : "#ff4d5e"; ctx.fillRect(left, hbY, hbW * PLAY.hp, 9 * u);
  }
  if (PLAY.combo > 0 && tpOpt("combo")) {
    ctx.save(); ctx.translate(left, B.bottom - pad); ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.font = `600 ${46 * u}px Inter,sans-serif`; sText(PLAY.combo + "x", 0, 0, u, "#fff"); ctx.restore();
  }
  // hit error bar: 300 / 100 / 50 zones, a tick per hit (fading), the average as an arrow
  if (!tpOpt("errBar")) return;
  const w = PLAY.w, k = Math.min(W * .3, 260 * u) / (2 * w[50]), cx = (B.l + B.r) / 2, y = B.bottom - pad - 6 * u;
  ctx.globalAlpha = .55;
  for (const [win, c] of [[w[50], "#ffcc22"], [w[100], "#57e313"], [w[300], "#32bce7"]]) { ctx.fillStyle = c; ctx.fillRect(cx - win * k, y - 2 * u, 2 * win * k, 4 * u); }
  ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.fillRect(cx - 1 * u, y - 9 * u, 2 * u, 18 * u);
  let sumE = 0, nE = 0;
  for (const e of PLAY.errs) {
    const age = t - e.at; if (age > 8000 || age < 0) continue;
    sumE += e.e; nE++;
    ctx.globalAlpha = Math.max(0, 1 - age / 8000) * .9; ctx.fillStyle = e.res === 300 ? "#32bce7" : e.res === 100 ? "#57e313" : "#ffcc22";
    ctx.fillRect(cx + Math.max(-w[50], Math.min(w[50], e.e)) * k - 1 * u, y - 7 * u, 2 * u, 14 * u);
  }
  if (nE) { const ax = cx + Math.max(-w[50], Math.min(w[50], sumE / nE)) * k; ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(ax, y - 10 * u); ctx.lineTo(ax - 5 * u, y - 17 * u); ctx.lineTo(ax + 5 * u, y - 17 * u); ctx.fill(); }
  ctx.globalAlpha = 1;
}

// ---------- Settings → Test play ----------
// Keys: click one, then press the new key (Esc cancels; binding a key another action has swaps the two). Esc always
// stops a test play as well, whatever the Stop key is.
const TPB = { wait: null };
function tpBindKey(k, btn) {
  if (TPB.wait) TPB.wait.cancel();
  btn.textContent = tr("Press a key…"); btn.classList.add("wait");
  const done = () => { removeEventListener("keydown", on, true); removeEventListener("pointerdown", away, true); TPB.wait = null; btn.classList.remove("wait"); btn.textContent = keyName(tpKey(k)); };
  const on = e => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.code === "Escape" && k !== "stop") return done();
    if (!e.code) return;
    const old = tpKey(k), other = TP_KEYS.find(([q]) => q !== k && tpKey(q) === e.code);
    if (other) tpSet(other[0], old);
    tpSet(k, e.code); done();
    renderTestSettings(); if (typeof buildKeys === "function") buildKeys();
  };
  const away = e => { if (e.target !== btn) done(); };
  TPB.wait = { cancel: done };
  addEventListener("keydown", on, true); setTimeout(() => addEventListener("pointerdown", away, true), 0);
}
function renderTestSettings() {
  const box = $("tpSetBox"); if (!box) return; box.innerHTML = "";
  const card = () => h("div", "card2"), sub = t => h("div", "subh", tr(t));
  const row = (label, el, hint) => { const l = h("label", "row"); l.append(h("span", null, tr(label)), el); return hint ? [l, h("p", "hint", tr(hint))] : [l]; };
  const sel = (opts, v, on) => { const s2 = h("select"); for (const [val, lab] of opts) s2.add(new Option(lab, val)); s2.value = String(v); s2.onchange = () => on(s2.value); return s2; };
  const sw = (label, small, k, after) => {
    const l = h("label", "sw"), t = h("span", "swt"), i = h("input"); i.type = "checkbox"; i.className = "switch"; i.checked = !!tpOpt(k); i.onchange = () => { tpSet(k, i.checked); dirty = true; if (after) after(); };
    t.append(h("b", null, tr(label))); if (small) t.append(h("small", null, tr(small))); l.append(t, i); return l;
  };
  const cm = card();
  cm.append(sw("Test play", "Play the map yourself, like osu!'s test mode: 🎮 Test play in the preview, ▶ Test or F5 in Modding. Off: those buttons are hidden and F5 switches Preview / Modding", "on",
    () => { tpApply(); renderTestSettings(); if (typeof buildKeys === "function") buildKeys(); }));
  if (!tpOn()) { box.append(cm); return; }
  const go = h("button", "btn main sm wide tpgo", "🎮 " + tr("Test play")); go.onclick = () => playStart();
  const ck = card();
  for (const [k, label] of TP_KEYS) {
    const r = h("div", "row kbrow"), b = h("button", "btn ghost sm kbind", keyName(tpKey(k))); b.type = "button"; b.onclick = () => tpBindKey(k, b);
    if (tpKey(k) !== TP_DEF[k]) b.classList.add("changed");
    r.append(h("span", null, tr(label)), b); ck.append(r);
  }
  ck.append(h("p", "hint", tr("Click a key, then press the new one (Esc cancels). Esc always stops too.")));
  const ci = card();
  ci.append(sw("Mouse buttons hit", "Left and right click count as hits. Off: the mouse only aims, the keys hit", "mouse"),
    sw("Tap to hit on touch screens", "Off: a touch only moves the cursor", "touch"),
    sw("Notelock", "Objects have to be hit in order, like osu!stable (a click on a later one shakes it). Off: any object under the cursor can be hit", "notelock"));
  const cg = card();
  cg.append(...row("Lead-in", sel([0, .5, 1, 1.5, 2, 3, 5].map(v => [v, v ? tr("{s} s", { s: v }) : tr("None")]), tpOpt("lead"), v => tpSet("lead", +v)), "How long before the start time the song begins."),
    ...row("Start from", sel([["here", tr("Where the song is")], ["start", tr("The beginning of the map")]], tpOpt("from"), v => tpSet("from", v))),
    sw("Hitsounds when I hit", "Like osu!: each hitsound plays when you hit it. Off: the map's hitsounds play on time, like Auto", "hsOnHit"));
  const cd = card();
  cd.append(sw("Score and accuracy", "", "score"), sw("Combo", "", "combo"), sw("HP bar", "", "hp"), sw("Hit error bar", "Where each hit landed: early on the left, late on the right", "errBar"), sw("300 judgements", "Off: only 100, 50 and misses show", "show300"));
  const reset = h("button", "btn ghost sm", tr("Reset Test play settings to the defaults"));
  reset.onclick = async () => { if (!(await ask(tr("Put every Test play setting and key back to the default?"), { ok: tr("Reset") }))) return; S.testPlay = { on: true }; save(); renderTestSettings(); if (typeof buildKeys === "function") buildKeys(); toast(tr("Test play settings are back to the defaults"), 1800); };
  box.append(cm, go, sub("Keys"), ck, sub("Input"), ci, sub("Gameplay"), cg, sub("Display"), cd, reset);
}
// the Shortcuts tab lists these with whatever keys are set
function tpKeyRows() { return [[keyName(tpKey("k1")) + " / " + keyName(tpKey("k2")), "Test play: hit (or the mouse buttons)"], [keyName(tpKey("stop")) + " / Esc", "Test play: stop"], [keyName(tpKey("retry")), "Test play: restart from the same place"], [keyName(tpKey("start")), "Modding: start test play • Preview: back to Modding"]]; }
