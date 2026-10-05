"use strict";
// ============ beatmap package state ============
let files = {}, images = {}, osuFiles = [], osbText = "", map = null, sb = [], bgHidden = false, setId = null, curDiff = -1;
let songMeta = null; // header info of the song file (tools.js)
let objURLs = [];
const mkURL = b => { const u = URL.createObjectURL(b); objURLs.push(u); return u; };

async function blobToImage(blob) {
  try { return await createImageBitmap(blob); }
  catch { const img = new Image(); img.src = mkURL(blob); await img.decode(); return img; }
}
async function loadImage(path) {
  const k = norm(path);
  if (k in images) return images[k];
  images[k] = null;
  const f = files[k]; if (!f) return null;
  try { images[k] = await blobToImage(await f.async("blob")); } catch { images[k] = null; }
  return images[k];
}

// ============ clock & audio ============
// A = song transport. "buf": decoded into Web Audio (sample-accurate seek, shares the hitsound clock)
// "el": <audio> element fallback, "virt": silent clock when the song can't be played at all
// rate = playback speed (mapping tools); song time advances rate ms per real ms
const A = {
  mode: "virt", buf: null, bufKey: "", node: null, gain: null, startCtx: 0, pos: 0, on: false, vStart: 0, src: "", rate: 1,
  playing() { return this.mode === "el" ? !audio.paused : this.on; },
  raw() { return this.mode === "buf" ? this.pos + (actx.currentTime - this.startCtx) * 1000 * this.rate : this.pos + (performance.now() - this.vStart) * this.rate; },
  cur() {
    if (this.mode === "el") return audio.currentTime * 1000;
    if (!this.on) return this.pos;
    return this.mode === "buf" ? this.raw() - outLat() * this.rate : this.raw();
  },
  play() {
    resetSched();
    if (this.mode === "el") { audio.playbackRate = this.rate; return audio.play(); }
    if (this.on) return Promise.resolve();
    if (this.mode === "buf") {
      if (audioStuck()) audioRestart(); // Safari after a freeze / lock screen: a new output instead of the stuck one
      ensureAudioCtx();
      if (this.pos >= this.buf.duration * 1000) return Promise.resolve();
      if (!this.gain) { this.gain = actx.createGain(); this.gain.connect(actx.destination); }
      this.gain.gain.value = musGain();
      const n = actx.createBufferSource(); n.buffer = this.buf; n.playbackRate.value = this.rate; n.connect(this.gain);
      n.start(0, Math.max(0, this.pos / 1000));
      this.node = n; this.startCtx = actx.currentTime; this.on = true;
      n.onended = () => { if (this.node === n && this.on) { this.on = false; this.node = null; this.pos = this.dur(); onSongEnd(); } };
      return actx.state === "running" ? Promise.resolve() : actx.resume();
    }
    this.vStart = performance.now(); this.on = true; return Promise.resolve();
  },
  pause() {
    resetSched(); stopPending();
    if (this.mode === "el") { if (!audio.paused) audio.pause(); return; }
    if (!this.on) return;
    this.pos = this.raw(); this.on = false;
    if (this.node) { try { this.node.onended = null; this.node.stop(); } catch {} this.node = null; }
  },
  seek(ms) {
    ms = Math.max(0, ms); resetSched(); stopPending();
    if (this.mode === "el") { try { audio.currentTime = ms / 1000; } catch {} clock.lastA = -1; return; }
    const was = this.on; if (was) this.pause();
    this.pos = Math.min(ms, this.dur()); if (was) this.play();
  },
  setRate(r) {
    const was = this.on && this.mode !== "el";
    if (was) this.pause();
    this.rate = r;
    try { audio.preservesPitch = true; audio.playbackRate = r; } catch {}
    if (was) this.play();
    resetSched();
  },
  dur() {
    const fb = map ? map.last + 2000 : 0;
    if (this.mode === "buf" && this.buf) return this.buf.duration * 1000;
    if (this.mode === "el") return audio.duration * 1000 || fb;
    return fb;
  },
};
try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {} // iPhone: play even on silent switch
const clock = { pre: false, preStart: 0, preLen: 0, lastA: -1, at: 0 };
const isPlaying = () => clock.pre || A.playing();
function nowMs() {
  if (clock.pre) {
    const t = -clock.preLen + (performance.now() - clock.preStart) * A.rate;
    if (t >= 0) { clock.pre = false; A.seek(0); A.play().catch(onPlayBlocked); return 0; }
    return t;
  }
  if (A.mode !== "el") return A.cur();
  const a = audio.currentTime * 1000;
  if (audio.paused || audio.seeking || audio.readyState < 3) { clock.lastA = -1; return a; }
  const p = performance.now();
  if (a !== clock.lastA) { clock.lastA = a; clock.at = p; return a; }
  return a + Math.min(120, p - clock.at) * (audio.playbackRate || 1);
}

// ---------- hitsounds (Web Audio) ----------
let actx = null;
function getCtx() {
  if (!actx) {
    const c = actx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: S.btMode ? "playback" : "interactive" });
    // Safari stops the output when the page freezes, the screen locks or another app takes the sound ("interrupted",
    // or "suspended" after it had run): pause there, so the song keeps its place and the next play starts it again
    c.onstatechange = () => {
      if (c !== actx) return;
      if (c.state === "running") { c.ran = true; return; }
      if (A.on && A.mode === "buf") { A.pause(); if (typeof keepAwake === "function") keepAwake(false); dirty = true; }
    };
  }
  return actx;
}
// the output can't play any more and needs replacing (it won't come back by itself in Safari)
const audioStuck = () => !!actx && (actx.state === "interrupted" || actx.state === "closed" || (actx.state === "suspended" && actx.ran));
// a new audio output (best inside a tap: Safari only starts sound from one); decoded sounds keep working
function audioRestart() {
  if (A.on) A.pause();
  const old = actx; actx = null; A.gain = null; for (const k in clickCache) delete clickCache[k];
  try { old && old.close(); } catch {}
  ensureAudioCtx();
}
// back to the page (unlocked, tab shown again, restored from the back/forward cache): an output stuck while playing
// has paused the song (above); try to wake the output so the next play is instant
for (const [t, el] of [["visibilitychange", document], ["pageshow", window], ["focus", window]]) el.addEventListener(t, () => {
  if (document.hidden || !actx || actx.state === "running") return;
  if (A.on && A.mode === "buf") { A.pause(); dirty = true; }
  try { const p = actx.resume(); if (p && p.catch) p.catch(() => {}); } catch {}
});
// Wireless / Bluetooth mode: a steadier audio output (bigger buffer), hitsounds queued further ahead on the song's own
// clock (so they stay with the music however late the headphones are), the song always played through Web Audio
// (never the <audio> fallback, whose delay differs from the hitsounds'), and a hitsound timing nudge (S.hsDelay)
// how long the browser says sound takes from the audio clock to the speakers (processing + device, e.g. Bluetooth)
const outLat = () => actx ? ((actx.outputLatency || 0) + (actx.baseLatency || 0)) * 1000 : 0;
// the visual offset is kept separately for wireless and wired listening, so switching headphones doesn't need recalibrating
const visOffset = () => S.btMode ? (S.offsetBt ?? S.offset) : S.offset;
const btAhead = () => S.btMode ? 260 : 70;
const hsNudge = () => S.btMode ? Math.max(-200, Math.min(200, +S.hsDelay || 0)) / 1000 : 0;
function setBtMode(on) {
  S.btMode = !!on; if (S.btMode && S.offsetBt == null) S.offsetBt = S.offset; save(); dirty = true;
  if (typeof syncOffsetUI === "function") syncOffsetUI();
  if (actx) { if (isPlaying()) pausePlayback(); audioRestart(); } // a new audio output with the other latency setting
}
function ensureAudioCtx() { try { if (audioStuck()) return audioRestart(); getCtx(); if (actx.state === "suspended") actx.resume(); } catch {} }
const decodeAB = ab => new Promise((res, rej) => { const p = getCtx().decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(() => {}); }); // newer browsers also return a promise; keep its rejection handled
const HS_TYPES = ["hitnormal", "hitwhistle", "hitfinish", "hitclap", "slidertick"];
const DEF_URL = "https://raw.githubusercontent.com/ppy/osu-resources/master/osu.Game.Resources/Samples/Gameplay/";
const defBank = {}, defLoading = {};
function preloadDefaults() {
  try { getCtx(); } catch { return; }
  for (const set of ["normal", "soft", "drum"]) for (const type of HS_TYPES) {
    const name = `${set}-${type}`;
    if (defLoading[name]) continue;
    defLoading[name] = fetch(DEF_URL + name + ".wav").then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); })
      .then(decodeAB).then(b => defBank[name] = b).catch(() => defBank[name] = null);
  }
}
const synthCache = {};
function synthBuf(set, type) {
  const key = set + type; if (synthCache[key]) return synthCache[key];
  const c = getCtx(), sr = c.sampleRate;
  let dur = .08, f = 880, noise = .45, decay = 32;
  if (type === "hitwhistle") { dur = .25; f = 1600; noise = .05; decay = 11; }
  else if (type === "hitfinish") { dur = .6; f = 320; noise = .6; decay = 5; }
  else if (type === "hitclap") { dur = .12; f = 0; noise = 1; decay = 26; }
  else if (type === "slidertick") { dur = .05; f = 2400; noise = .2; decay = 60; }
  if (set === "soft") { f *= .7; noise *= .6; } else if (set === "drum") { f *= .5; noise = Math.min(1, noise * 1.3); }
  const n = Math.floor(sr * dur), b = c.createBuffer(1, n, sr), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) { const t = i / sr, env = Math.exp(-t * decay); d[i] = ((f ? Math.sin(2 * Math.PI * f * t * (1 - t)) * (1 - noise) : 0) + (Math.random() * 2 - 1) * noise) * env * .55; }
  return synthCache[key] = b;
}
let mapBank = {};
async function loadMapSamples() {
  mapBank = {};
  const songs = new Set(osuFiles.map(o => norm((o.text.match(/^AudioFilename\s*:\s*(.+)$/m) || [])[1] || "")));
  const jobs = [];
  for (const p in files) {
    const m = p.match(/([^/]+)\.(wav|ogg|mp3)$/); if (!m || songs.has(p)) continue;
    const f = files[p]; if ((f._data && f._data.uncompressedSize || 0) > 2e6) continue;
    jobs.push(f.async("arraybuffer").then(decodeAB).then(b => { mapBank[m[1]] = b; }).catch(() => {}));
  }
  try { getCtx(); } catch { return; }
  await Promise.all(jobs);
}
// scheduled sources, so a pause/seek can cancel sounds that were queued ahead of time
const pending = new Set();
function playBuf(b, vol, when) {
  if (!b || vol <= 0) return;
  const s = actx.createBufferSource(); s.buffer = b;
  const g = actx.createGain(); g.gain.value = Math.min(1.5, vol);
  s.connect(g).connect(actx.destination);
  const at = Math.max(actx.currentTime, when || 0);
  s.start(at);
  if (at > actx.currentTime + .03) { s.at = at; pending.add(s); s.onended = () => pending.delete(s); }
}
function stopPending() {
  if (typeof hsFlashCancel === "function") hsFlashCancel(); // editor button hits queued for sounds that won't play
  if (!actx) return;
  const now = actx.currentTime;
  for (const s of pending) { if (s.at > now + .005) { try { s.stop(); } catch {} } }
  pending.clear();
}
function sampleFor(set, type, idx) {
  let b = null;
  if (S.hsSrc === "beatmap" && idx !== 0) b = mapBank[`${set}-${type}${idx > 1 ? idx : ""}`];
  if (!b) b = defBank[`${set}-${type}`];
  if (!b) b = synthBuf(set, type);
  return b;
}
function playEvent(e, when) {
  if (S.hsSrc === "off" || !actx || !map || !hsGain()) return;
  const ti = lastBefore(map.timing, e.t + 2, "time"), tp = map.timing[ti] || { sampleSet: 0, sampleIndex: 0, volume: 100 };
  const base = tp.sampleSet || map.defSet;
  const nSet = SETS[e.n || base] || "normal", aSet = SETS[e.a || e.n || base] || "normal";
  const idx = e.i || tp.sampleIndex, vol = (e.v || tp.volume || 100) / 100 * hsGain();
  if (EDIT.on) hsNow(e, nSet, aSet, idx); // the HS button says what plays, Hitsound Studio flashes its column
  if (e.tick) { playBuf(sampleFor(nSet, "slidertick", idx), vol * .8, when); return; }
  if (EDIT.on) hsFlash(e.hs, nSet, aSet, e.t); // light up the editor's hitsound buttons when this plays
  if (e.f && S.hsSrc === "beatmap") { const b = mapBank[e.f.toLowerCase().replace(/\.(wav|ogg|mp3)$/, "")]; if (b) { playBuf(b, vol, when); return; } }
  playBuf(sampleFor(nSet, "hitnormal", idx), vol, when);
  if (e.hs & 2) playBuf(sampleFor(aSet, "hitwhistle", idx), vol * .85, when);
  if (e.hs & 4) playBuf(sampleFor(aSet, "hitfinish", idx), vol, when);
  if (e.hs & 8) playBuf(sampleFor(aSet, "hitclap", idx), vol * .85, when);
}
function previewHit() { // lets the user hear the hitsound volume they just picked
  if (S.hsSrc === "off" || !hsGain()) return;
  ensureAudioCtx(); preloadDefaults();
  if (actx) playBuf(sampleFor("normal", "hitnormal", 0), hsGain(), 0);
}

// metronome clicks (accent on the first beat of each measure)
const clickCache = {};
function clickBuf(accent) {
  const k = accent ? "a" : "b"; if (clickCache[k]) return clickCache[k];
  const c = getCtx(), sr = c.sampleRate, n = Math.floor(sr * .04), b = c.createBuffer(1, n, sr), d = b.getChannelData(0), f = accent ? 1760 : 1175;
  for (let i = 0; i < n; i++) { const t = i / sr; d[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 90) * .7; }
  return clickCache[k] = b;
}
function metroRange(from, to, whenOf, now) {
  const U = map.uni; let i = Math.max(0, lastBefore(U, from, "time"));
  for (; i < U.length; i++) {
    const u = U[i], end = i + 1 < U.length ? U[i + 1].time : Infinity, len = u.beat, meter = u.meter || 4;
    if (u.time > to) break;
    if (!(len > 5)) continue;
    let n = Math.max(0, Math.floor((from - u.time) / len) + 1);
    for (let bt = u.time + n * len; bt <= to && bt < end - 1; n++, bt = u.time + n * len) playBuf(clickBuf(n % meter === 0), hsGain() * .9, Math.max(now, whenOf(bt)));
  }
}

// queue hitsounds + metronome for song time (schedTo, t + ahead*rate]; ahead is in real ms
let schedTo = null;
function resetSched() { schedTo = null; }
function schedule(t, ahead) {
  if (!actx || !map || clock.pre || !A.playing()) { schedTo = null; return; }
  const hs = S.hsSrc !== "off" && hsGain() > 0, mt = S.metro && hsGain() > 0;
  if (!hs && !mt) { schedTo = null; return; }
  const r = A.rate, to = t + ahead * r;
  if (schedTo === null || t - schedTo > 300 * r) schedTo = t - 5;
  if (to <= schedTo) return;
  const now = actx.currentTime;
  const whenOf = A.mode === "buf" ? ms => A.startCtx + (ms - A.pos) / 1000 / r : ms => now + (ms - t) / 1000 / r;
  const nd = hsNudge();
  if (hs && !(typeof PLAY !== "undefined" && PLAY.on && tpOpt("hsOnHit"))) { const ev = map.sounds; for (let i = lastBefore(ev, schedTo, "t") + 1; i < ev.length && ev[i].t <= to; i++) playEvent(ev[i], Math.max(now, whenOf(ev[i].t) + nd)); } // (test play plays each hitsound when you hit: play.js)
  if (mt) metroRange(schedTo, to, ms => whenOf(ms) + nd, now);
  schedTo = to;
}
// rAF stops in background tabs, so keep hitsounds going from a timer with a bigger lookahead
setInterval(() => { if (document.hidden && map && isPlaying()) schedule(nowMs(), 1500); }, 250);

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => wakeLock = null); }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && isPlaying()) keepAwake(true); });
