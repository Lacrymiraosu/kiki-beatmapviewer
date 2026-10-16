"use strict";
// ============ beatmap package state ============
let files = {}, images = {}, osuFiles = [], osbText = "", map = null, sb = { chunks: [], length: 0, minStart: 0, names: new Set(), uses: () => false }, bgHidden = false, setId = null, curDiff = -1;
let songMeta = null; // header info of the song file (tools.js)
let objURLs = [];
const mkURL = b => { const u = URL.createObjectURL(b); objURLs.push(u); return u; };

async function blobToImage(blob, k = 1) { // k < 1: decoded smaller (the image keeps its own size in .ow / .oh)
  let img;
  try { img = await createImageBitmap(blob); }
  catch { img = new Image(); img.src = mkURL(blob); await img.decode(); }
  if (k >= 1) return img;
  const ow = img.width, oh = img.height, w = Math.max(1, Math.round(ow * k)), h = Math.max(1, Math.round(oh * k));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, w, h); img.close?.();
  let out = c; try { out = await createImageBitmap(c); c.width = c.height = 0; } catch {}
  out.ow = ow; out.oh = oh; return out;
}
async function loadImage(path, k = 1) {
  const key = norm(path);
  if (key in images) return images[key];
  images[key] = null;
  const f = files[key]; if (!f) return null;
  try { images[key] = await blobToImage(await f.async("blob"), k); } catch { images[key] = null; }
  return images[key];
}
function imagesFree() { sbglFree(); for (const c of sb.chunks || []) c.imgs = []; for (const v of Object.values(images)) v && v.close?.(); images = {}; } // (the storyboard's own look-ups and WebGL's pictures of them go too: a closed picture can't be drawn)
// Size of a PNG / JPEG / GIF / WebP from its first bytes, without decoding it ([w, h], or null)
function imgDims(b) {
  const u = (i, n) => { let v = 0; for (let j = 0; j < n; j++) v = v * 256 + b[i + j]; return v; }, le = (i, n) => { let v = 0; for (let j = n - 1; j >= 0; j--) v = v * 256 + b[i + j]; return v; };
  if (b[0] === 0x89 && b[1] === 0x50) return [u(16, 4), u(20, 4)];
  if (b[0] === 0x47 && b[1] === 0x49) return [le(6, 2), le(8, 2)];
  if (b[0] === 0x52 && b[8] === 0x57) { const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (t === "VP8X") return [le(24, 3) + 1, le(27, 3) + 1]; if (t === "VP8 ") return [le(26, 2) & 0x3fff, le(28, 2) & 0x3fff];
    if (t === "VP8L") { const v = le(21, 4); return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; } return null; }
  if (b[0] === 0xff && b[1] === 0xd8) for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [u(i + 7, 2), u(i + 5, 2)];
    i += 2 + u(i + 2, 2);
  }
  return null;
}
// A storyboard can hold more decoded images than a phone tab is allowed (8400 px wide layers are 36 MB each), and the
// browser then closes the page. Past this budget the storyboard's images are decoded smaller (drawn at their own size).
const IMG_BUDGET = () => (DEV.coarse ? 384 : 1024) * 2 ** 20;
async function loadImages(paths, keep, onDone) { // keep: decoded at full size whatever the budget (the background)
  paths = paths.filter(p => !(norm(p) in images));
  const dims = await Promise.all(paths.map(async p => { const f = files[norm(p)]; if (!f) return null;
    try { const blob = await f.async("blob"); return imgDims(new Uint8Array(await blob.slice(0, 1 << 18).arrayBuffer())); } catch { return null; } }));
  let fixed = 0, flex = 0;
  paths.forEach((p, i) => { const d = dims[i], n = d ? d[0] * d[1] * 4 : 0; if (keep.has(norm(p))) fixed += n; else flex += n; });
  const k = flex ? Math.max(.25, Math.min(1, Math.sqrt(Math.max(0, IMG_BUDGET() - fixed) / flex))) : 1;
  let next = 0; // a few at a time: a full-size decode in flight costs memory too
  const one = async () => { while (next < paths.length) { const p = paths[next++]; await loadImage(p, keep.has(norm(p)) ? 1 : k); onDone(); } };
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, one));
}

// ============ clock & audio ============
// A = song transport. "buf": decoded into Web Audio (sample-accurate seek, shares the hitsound clock)
// "el": <audio> element fallback, "virt": silent clock when the song can't be played at all
// rate = playback speed (mapping tools); song time advances rate ms per real ms
// keep = the pitch at rate != 1: null as always (the <audio> keeps it, the decoded song follows the speed), true / false asked for
// (a replay's DT / HT keep it: kpPrep below makes a pitch-kept copy of the song; NC / DC follow the speed); want = play once that copy is ready
const A = {
  mode: "virt", buf: null, bufKey: "", node: null, gain: null, startCtx: 0, pos: 0, on: false, vStart: 0, src: "", rate: 1, nudge: 1, keep: null, want: false, ng: null,
  playing() { return this.mode === "el" ? !audio.paused : this.on; },
  raw() { const r = this.rate * this.nudge; return this.mode === "buf" ? this.pos + (actx.currentTime - this.startCtx) * 1000 * r : this.pos + (performance.now() - this.vStart) * r; },
  cur() {
    if (this.mode === "el") return audio.currentTime * 1000;
    if (!this.on) return this.pos;
    return this.mode === "buf" ? this.raw() - outLat() * this.rate : this.raw();
  },
  play() {
    resetSched();
    if (this.mode === "el") { audio.playbackRate = this.rate * this.nudge; return audio.play(); }
    if (this.on) return Promise.resolve();
    if (this.mode === "buf") {
      if (audioStuck()) audioRestart(); // Safari after a freeze / lock screen: a new output instead of the stuck one
      ensureAudioCtx();
      if (this.pos >= this.buf.duration * 1000) return Promise.resolve();
      if (kpWaiting()) { this.want = true; return Promise.resolve(); } // (the pitch-kept copy is being made: plays when it is ready)
      if (!this.gain) { this.gain = actx.createGain(); this.gain.connect(actx.destination); }
      this.gain.gain.value = musGain();
      const kb = kpReady(), n = actx.createBufferSource(); n.buffer = kb || this.buf; n.playbackRate.value = this.rate * this.nudge;
      if (kb) { // (the same length and rate as the song, sample n = song time n; a 5 ms fade in, no click at a start or a seek)
        const g = this.ng = actx.createGain(), t = actx.currentTime; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + .005); n.connect(g).connect(this.gain);
      } else { this.ng = null; n.connect(this.gain); }
      n.start(0, Math.max(0, this.pos / 1000));
      this.node = n; this.startCtx = actx.currentTime; this.on = true;
      n.onended = () => { if (this.node === n && this.on) { this.on = false; this.node = null; this.pos = this.dur(); onSongEnd(); } };
      if (actx.state === "running") return Promise.resolve();
      // the output isn't running (Safari starts it only inside a tap): if it still isn't a moment later, the clock would stand
      // still with the song "playing" and nothing to tap, so stop here and ask for a tap (the same "tap again to play")
      const c = actx; setTimeout(() => {
        if (this.node !== n || !this.on || actx !== c || c.state === "running" || document.hidden) return;
        this.pause(); if (typeof onPlayBlocked === "function") onPlayBlocked({}); if (typeof keepAwake === "function") keepAwake(false);
      }, 1500);
      return actx.resume();
    }
    this.vStart = performance.now(); this.on = true; return Promise.resolve();
  },
  pause() {
    resetSched(); stopPending(); this.want = false;
    if (this.mode === "el") { if (!audio.paused) audio.pause(); this.untrim(); return; }
    if (!this.on) return;
    this.pos = this.raw(); this.on = false; this.nudge = 1;
    if (this.node) {
      const g = this.ng; this.ng = null;
      try { this.node.onended = null;
        if (g) { const t = actx.currentTime; g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + .005); this.node.stop(t + .006); } // (the pitch-kept copy: a 5 ms fade out)
        else this.node.stop();
      } catch {}
      this.node = null;
    }
  },
  seek(ms) {
    ms = Math.max(0, ms); resetSched(); stopPending();
    if (this.mode === "el") { this.untrim(); try { audio.currentTime = ms / 1000; } catch {} clock.lastA = -1; return; }
    const was = this.on; if (was) this.pause();
    this.pos = Math.min(ms, this.dur()); if (was) this.play();
  },
  // o.keepPitch (a replay: true for DT / HT, false for NC / DC); without o the pitch is as it always was (see keep above)
  setRate(r, o) {
    const was = this.on && this.mode !== "el", want = this.want;
    if (was) this.pause();
    this.rate = r; this.nudge = 1; this.keep = o && typeof o.keepPitch === "boolean" ? o.keepPitch : null;
    try {
      const k = this.keep !== false; audio.preservesPitch = k;
      if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = k; // (older Safari)
      audio.playbackRate = r;
    } catch {}
    kpPrep();
    if (was || want) this.play();
    resetSched();
  },
  // a small speed trim, 1 = none (a live session's guest catching up with the host without an audible seek): the clock is
  // re-anchored first, so the song time doesn't jump; play / pause / seek / setRate clear it
  trim(k) {
    k = Math.max(.95, Math.min(1.05, k)); if (Math.abs(k - this.nudge) < .0005) return;
    if (this.mode === "el") { this.nudge = k; try { audio.playbackRate = this.rate * k; } catch {} return; }
    if (this.on) { this.pos = this.raw(); if (this.mode === "buf") { this.startCtx = actx.currentTime; if (this.node) this.node.playbackRate.value = this.rate * k; } else this.vStart = performance.now(); }
    this.nudge = k;
  },
  untrim() { if (this.nudge !== 1) this.trim(1); },
  dur() {
    const fb = map ? map.last + 2000 : 0;
    if (this.mode === "buf" && this.buf) return this.buf.duration * 1000;
    if (this.mode === "el") return audio.duration * 1000 || fb;
    return fb;
  },
};
// ---------- a replay's DT / HT with the song's own pitch ----------
// A copy of the decoded song, pitched down by 1 / rate with the same length (a WSOLA tempo change to length / rate, then resampled back to
// the length), played at the rate through the same "buf" path: sample n is still song time n, so the clock, seeks, pause and the
// hitsound scheduler are the same as for the song, and played at the rate it has the song's pitch (a SoundTouch-style tempo change, like the BASS FX one osu! uses).
// One copy is kept (song + rate); made in slices of ~25 ms before the replay plays (a 4.5 minute song in headless Chromium: ~2 s for DT, ~4-6 s for HT), dropped once the replay is left
const KP = { src: null, rate: 0, buf: null, job: 0, busy: false, failed: null, shown: false, gc: 0 };
const kpWanted = () => A.mode === "buf" && !!A.buf && A.keep === true && A.rate !== 1;
const kpReady = () => kpWanted() && KP.buf && KP.src === A.buf && KP.rate === A.rate ? KP.buf : null;
const kpWaiting = () => kpWanted() && KP.busy && KP.src === A.buf && KP.rate === A.rate;
function kpLoading(on, p) {
  if (on) { KP.shown = true; if (typeof showLoading === "function") showLoading(tr("Preparing the song…"), p); }
  else if (KP.shown) { KP.shown = false; if (typeof hideLoading === "function") hideLoading(); }
}
// Cancel on the loading cover while the copy is made (js/app.js hides the cover itself): the job stops, nothing is kept, the song doesn't start later,
// and the replay is left like a rpStop before it started (RP.onCancel, if rpStart was given one, runs last: e.g. the results screen again)
function kpCancel() {
  if (!KP.shown || !KP.busy) return; // (a map download's Cancel: not ours)
  KP.job++; KP.busy = false; KP.buf = KP.src = null; KP.rate = 0; clearTimeout(KP.gc); kpLoading(false);
  A.want = false; if (typeof keepAwake === "function") keepAwake(false);
  const rp = typeof RP !== "undefined" && RP.on ? RP : null, cb = rp && rp.onCancel;
  if (rp) rpStop(); else if (A.rate !== 1 && typeof setRate === "function") setRate(1);
  if (cb) cb();
}
if (typeof document !== "undefined") { const b = document.getElementById("cancelLoad"); if (b) b.addEventListener("click", kpCancel); }
function kpPrep() {
  clearTimeout(KP.gc);
  if (!kpWanted()) { // (back to the song: stop a copy being made; drop the copy a moment later unless a replay restart asks for it again)
    if (KP.busy) { KP.job++; KP.busy = false; kpLoading(false); }
    KP.gc = setTimeout(() => { if (!kpReady()) { KP.buf = KP.src = KP.failed = null; KP.rate = 0; } }, 0);
    return;
  }
  if (KP.src === A.buf && KP.rate === A.rate && (KP.buf || KP.busy)) return;
  if (KP.failed && KP.failed.src === A.buf && KP.failed.rate === A.rate) return; // (couldn't: the speed changes the pitch, as before)
  const id = ++KP.job, src = A.buf, r = A.rate, C = src.numberOfChannels, X = [], Y = [];
  KP.src = src; KP.rate = r; KP.buf = null; KP.busy = true;
  let out = null;
  try { out = getCtx().createBuffer(C, src.length, src.sampleRate); for (let c = 0; c < C; c++) { X.push(src.getChannelData(c)); Y.push(out.getChannelData(c)); } }
  catch { KP.busy = false; KP.src = null; KP.failed = { src, rate: r }; return; } // (no memory for it)
  const t0 = performance.now();
  kpRender(X, Y, src.sampleRate, r, () => KP.job === id, p => { if (performance.now() - t0 > 150) kpLoading(true, p); }).then(done => {
    if (!done || KP.job !== id) return;
    KP.busy = false; KP.buf = out; kpLoading(false);
    if (A.want && kpReady()) { A.want = false; A.play().catch(e => typeof onPlayBlocked === "function" && onPlayBlocked(e)); }
    else if (A.on && kpReady()) { A.pause(); A.play(); } // (it was played meanwhile, with the speed's pitch: now the copy)
  }).catch(e => {
    if (KP.job !== id) return;
    console.error(e); KP.busy = false; KP.src = null; KP.failed = { src, rate: r }; kpLoading(false);
    if (A.want) { A.want = false; A.play().catch(() => {}); }
  });
}
const kpYield = () => new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); }); // (not slowed down in a background tab, unlike a timer)
// windowed sinc (Kaiser, beta 6) for the HT resampling, which shrinks: low-passed at the new Nyquist (fc of the source's): what would fold back is cut by ~20 dB or more (32 taps).
// P + 1 phases of 2K taps; tap j of phase ph sits at t = j - K + 1 - ph / P
function kpKernel(fc, K, P) {
  const I0 = x => { let s = 1, t = 1; for (let k = 1; k < 32; k++) { t *= (x / 2 / k) ** 2; s += t; } return s; }, ib = 1 / I0(6), tab = new Float32Array((P + 1) * 2 * K);
  for (let ph = 0; ph <= P; ph++) {
    const o = ph * 2 * K; let sum = 0;
    for (let j = 0; j < 2 * K; j++) {
      const t = j - K + 1 - ph / P, u = t / K, w = Math.abs(u) >= 1 ? 0 : I0(6 * Math.sqrt(1 - u * u)) * ib, a = Math.PI * fc * t;
      sum += tab[o + j] = (t === 0 ? 1 : Math.sin(a) / a) * w;
    }
    for (let j = 0; j < 2 * K; j++) tab[o + j] /= sum; // (gain 1 at every phase)
  }
  return tab;
}
// X: the song's channels, Y: the same number of arrays of the same length (filled). r: the rate it will be played at.
// Stage 1, a WSOLA tempo change laid out like SoundTouch's (the family of BASS FX's tempo, which osu! uses; its automatic settings for the rate): segments of
// 57 ms (1.5x) to 82 ms (0.75x) copied whole, joined by 8 ms cross-fades; stretched sample m reads the song around m * r. Each segment is
// moved by up to ±8-10 ms (song time) so that its start matches what the last one plays over the cross-fade (found on a mono mix at
// ~5.5 kHz, then to the sample on all channels; the same move for every channel, so the stereo image holds). Its place is worked out from
// its own index, never from the last one's move: the error stays inside the segment and never adds up. Stage 2, streamed behind it:
// Y[n] = stretched(n / r) (cubic for DT; for HT, which shrinks, the windowed sinc above). alive() false: stops (resolves false); prog(0..1)
async function kpRender(X, Y, sr, r, alive, prog) {
  const C = X.length, L = X[0].length, ir = 1 / r, tp = Math.max(.5, Math.min(2, r));
  const S = Math.round(sr * (90 - 50 / 1.5 * (tp - .5)) / 1000), O = Math.max(8, Math.round(sr * .008)), Hs = S - O; // (segment, cross-fade, hop)
  const T = Math.max(1, Math.round(sr * (20 - 5 / 1.5 * (tp - .5)) / 2000)), D = Math.max(1, Math.round(sr / 5512.5)), OD = Math.max(1, Math.floor(O / D));
  const win = new Float32Array(S).fill(1); for (let i = 0; i < O; i++) { const u = .5 - .5 * Math.cos(Math.PI * (i + .5) / O); win[i] = u; win[S - O + i] = 1 - u; }
  const PAD = Math.ceil((T + 4 * S * Math.max(1, r)) / D) + 4, md = new Float32Array(Math.ceil(L / D) + 2 * PAD); // (the mono mix / D, zeros around)
  for (let c = 0; c < C; c++) { const x = X[c]; for (let i = 0; i < L; i++) md[PAD + ((i / D) | 0)] += x[i]; }
  const sinc = r < 1, K = sinc ? 16 : 2, P = 512, tab = sinc ? kpKernel(r, K, P) : null, K2 = 2 * K;
  const acc = X.map(() => new Float32Array(S)), sb = X.map(() => new Float32Array(K2 + Hs)); // (sb: stretched [kHs - 2K, kHs + Hs))
  let prev = 0, n = 0, t0 = performance.now();
  for (let k = -1; ; k++) {
    const p0 = Math.round((k * Hs + S / 2) * r - S / 2); // (the segment's middle lands on its own place in the song)
    let p = p0;
    if (k >= 0) { // ---- the move: the start that best matches what the last segment plays over the cross-fade (x[prev + Hs ...])
      const q = prev + Hs, qd = PAD + Math.floor(q / D);
      let re = 0; for (let j = 0; j < OD; j++) re += md[qd + j] * md[qd + j];
      if (re > 1e-9) {
        const c0 = Math.floor((p0 - T) / D), c1 = Math.floor((p0 + T) / D);
        let best = -Infinity, bc = c0, e = 0;
        for (let j = 0; j < OD; j++) e += md[PAD + c0 + j] * md[PAD + c0 + j];
        for (let cc = c0; cc <= c1; cc++) {
          const b = PAD + cc;
          if (cc > c0) e += md[b + OD - 1] * md[b + OD - 1] - md[b - 1] * md[b - 1];
          let d = 0; for (let j = 0; j < OD; j++) d += md[qd + j] * md[b + j];
          const s = d / Math.sqrt(Math.max(e, 0) + 1e-9); if (s > best) { best = s; bc = cc; }
        }
        const hw = D, lo = Math.max(p0 - T, bc * D - hw), hi = Math.min(p0 + T, bc * D + hw);
        let fb = -Infinity; p = Math.max(lo, Math.min(hi, bc * D));
        for (let pc = lo; pc <= hi; pc++) { // (to the sample, on every channel)
          const i0 = Math.max(0, -q, -pc), i1 = Math.min(O, L - q, L - pc);
          let d = 0, en = 0;
          for (let c = 0; c < C; c++) { const x = X[c]; for (let i = i0; i < i1; i++) { const v = x[pc + i]; d += x[q + i] * v; en += v * v; } }
          const s = d / Math.sqrt(en + 1e-9); if (s > fb) { fb = s; p = pc; }
        }
      }
    }
    prev = p;
    const i0 = Math.max(0, -p), i1 = Math.min(S, L - p);
    for (let c = 0; c < C; c++) { // ---- add the segment; then [kHs, kHs + Hs) is done: into the resampler's window
      const a = acc[c], x = X[c], s = sb[c];
      for (let i = i0; i < i1; i++) a[i] += win[i] * x[p + i];
      s.copyWithin(0, Hs); s.set(a.subarray(0, Hs), K2); a.copyWithin(0, Hs); a.fill(0, S - Hs);
    }
    const top = k * Hs + Hs - 1, base = k * Hs - K2; // ---- every Y[n] whose taps are in by now
    for (; n < L; n++) {
      const s = n * ir, j = Math.floor(s); if (j + K > top) break;
      const f = s - j, o = j - K + 1 - base;
      if (sinc) {
        const to = Math.round(f * P) * K2;
        if (C === 2) { const w0 = sb[0], w1 = sb[1]; let v0 = 0, v1 = 0; for (let t = 0; t < K2; t++) { const h = tab[to + t]; v0 += h * w0[o + t]; v1 += h * w1[o + t]; } Y[0][n] = v0; Y[1][n] = v1; }
        else for (let c = 0; c < C; c++) { const w = sb[c]; let v = 0; for (let t = 0; t < K2; t++) v += tab[to + t] * w[o + t]; Y[c][n] = v; }
      }
      else for (let c = 0; c < C; c++) { const w = sb[c], a0 = w[o], a1 = w[o + 1], a2 = w[o + 2], a3 = w[o + 3]; Y[c][n] = a1 + .5 * f * (a2 - a0 + f * (2 * a0 - 5 * a1 + 4 * a2 - a3 + f * (3 * (a1 - a2) + a3 - a0))); }
    }
    if (n >= L) return true;
    if ((k & 3) === 3 && performance.now() - t0 > 25) { prog(n / L); await kpYield(); if (!alive()) return false; t0 = performance.now(); }
  }
}
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
// the osu! default combo-break sample (Gameplay/combobreak.mp3): not fetched at load, but the first time a watched replay's sound list has a combo break (soundList).
// A failed fetch / decode leaves nothing (the break is then silent, never a drawn tone) and is tried again at the next such replay
function loadComboBreak() {
  if (defLoading.combobreak || defBank.combobreak) return;
  try { getCtx(); } catch { return; }
  const p = defLoading.combobreak = Promise.resolve().then(() => fetch(DEF_URL + "combobreak.mp3")).then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); })
    .then(decodeAB).then(b => { defBank.combobreak = b; }).catch(() => { defBank.combobreak = null; if (defLoading.combobreak === p) delete defLoading.combobreak; });
}
// the sound of a combo break: the skin's own combobreak (S.skinSounds; a blank file = the skin mutes it) > osu! default's. null: nothing plays
function comboBreakBuf() {
  if (S.skinSounds) { const v = skinNamedBuf("combobreak"); if (v === false) return null; if (v) return v; }
  return defBank.combobreak || null;
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
  // the chosen skin's hitsounds too, so the first hit of the map is already the skin's (js/app.js loads the skin at the same time)
  if (S.hsSrc !== "off" && S.skinSounds && typeof ensureSkins === "function") { try { await ensureSkins(); await Promise.race([skinSndWarm(SK), new Promise(r => setTimeout(r, 1500))]); } catch {} } // (a huge skin doesn't hold the map up: its first hits are osu! default's)
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
// ---------- hitsounds from the skin (Settings → Skin → "Use the skin's hitsounds", S.skinSounds) ----------
// sk.sounds (skins.js): name -> the file's bytes, not decoded. The first time the skin's sounds are wanted they are all decoded, a few
// at a time and off the page's thread (decodeAudioData), into sk.sbuf: name -> AudioBuffer, or false for a blank file (a skin's way to
// mute a sound, as in osu!: nothing plays). A sound not decoded yet, or that can't be (a format this browser lacks), is osu! default's.
// They live on the skin object: a skin let go (skins.js closeSkin) drops them, and a skin switch is seen at the next hit (SK).
const SND_BLANK = 128; // (bytes: a wav this small is a header with no sound after it)
function skinSndWarm(sk) {
  if (!sk || !sk.sndN || !S.skinSounds) return Promise.resolve();
  if (sk.sndP) return sk.sndP;
  try { getCtx(); } catch { return Promise.resolve(); }
  const names = Object.keys(sk.sounds), B = sk.sbuf; let i = 0;
  const one = async () => {
    while (i < names.length) {
      const n = names[i++], blob = sk.sounds[n]; if (!blob || sk.sndDead) continue;
      if (blob.size <= SND_BLANK) { B[n] = false; continue; }
      try { const b = await decodeAB(await (blob.arrayBuffer ? blob.arrayBuffer() : new Response(blob).arrayBuffer())); if (!sk.sndDead) B[n] = b && b.length ? b : false; } catch {} // (older Safari: no Blob.arrayBuffer)
    }
  };
  return sk.sndP = Promise.all([one(), one(), one()]);
}
// the skin's sound for set / type / custom index: an AudioBuffer, false = the skin mutes it, null = the skin has none (or not ready)
// (custom index 2+: "soft-hitclap2", else "soft-hitclap"; index 0 / 1: "soft-hitclap", the way the map's own files are looked up)
function skinBuf(set, type, idx) {
  const sk = SK; if (!sk.sndN) return null;
  if (!sk.sndP) skinSndWarm(sk);
  const B = sk.sbuf;
  if (idx > 1) { const v = B[`${set}-${type}${idx}`]; if (v != null) return v; }
  const v = B[`${set}-${type}`]; return v == null ? null : v;
}
// a skin's named sound (combobreak): an AudioBuffer, false = the skin mutes it, null = none (or not ready)
function skinNamedBuf(name) {
  const sk = SK; if (!sk.sndN) return null;
  if (!sk.sndP) skinSndWarm(sk);
  const v = sk.sbuf[name]; return v == null ? null : v;
}
// the sound to play: the map's own file (for this custom index; Hitsound source "From the map") > the skin's (S.skinSounds) > osu! default > a drawn one.
// null: nothing plays (the skin's blank file)
function sampleFor(set, type, idx) {
  let b = null;
  if (S.hsSrc === "beatmap" && idx !== 0) b = mapBank[`${set}-${type}${idx > 1 ? idx : ""}`];
  if (!b && S.skinSounds) { b = skinBuf(set, type, idx); if (b === false) return null; }
  if (!b) b = defBank[`${set}-${type}`];
  if (!b) b = synthBuf(set, type);
  return b;
}
function playEvent(e, when) {
  if (S.hsSrc === "off" || !actx || !map || !hsGain()) return;
  if (e.combobreak) { playBuf(comboBreakBuf(), hsGain(), when); return; } // (a watched replay's combo break: js/replayana.js rpSoundEvents; its own sample, never a drawn one)
  const ti = lastBefore(map.timing, (e.nt ?? e.t) + 2, "time"), tp = map.timing[ti] || { sampleSet: 0, sampleIndex: 0, volume: 100 };
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
let schedTo = null, swFrom = null; // (swFrom: schedTo when the replay's hitsounds took over from Auto's in the middle of playback)
function resetSched() { schedTo = null; swFrom = null; }
// the hitsounds to play: map.sounds (Auto's, from the object times), or while a replay is watched and js/player.js has its analysis for this very replay and
// map (RPH), what the replay really did (js/replayana.js rpSoundEvents: missed objects are silent, a late hit sounds at its press). Until then, Auto's
let rsA = null, rsSrc = null, rsList = null, schedList = null;
function soundList() {
  const base = map.sounds;
  if (typeof RP !== "undefined" && RP.on && typeof RPH !== "undefined" && typeof rpSoundEvents === "function" && RPH.a && RPH.a.ok && RPH.data === RP.data && RPH.hit === map.hit) {
    // a replay whose header counts disagree with what the analysis found ("poor" consistency) is not trusted: Auto's schedule and no combo breaks. Counts all
    // zero (a header without them) would make every replay "poor", so that is no evidence
    const q = RPH.a.consistency, h = q && q.header;
    if (q && q.quality === "poor" && h && (+h.n300 || 0) + (+h.n100 || 0) + (+h.n50 || 0) + (+h.miss || 0) > 0) return base;
    if (rsA !== RPH.a || rsSrc !== base) { rsA = RPH.a; rsSrc = base; rsList = rpSoundEvents(map, RPH.a); if (rsList.some(e => e.combobreak)) loadComboBreak(); }
    return rsList;
  }
  return base;
}
function schedule(t, ahead) {
  if (!actx || !map || clock.pre || !A.playing()) { schedTo = null; return; }
  const hs = S.hsSrc !== "off" && hsGain() > 0, mt = S.metro && hsGain() > 0;
  if (!hs && !mt) { schedTo = null; return; }
  const r = A.rate * A.nudge, to = t + ahead * r;
  if (schedTo === null || t - schedTo > 300 * r) { schedTo = t - 5; swFrom = null; }
  if (to <= schedTo) return;
  const now = actx.currentTime;
  const whenOf = A.mode === "buf" ? ms => A.startCtx + (ms - A.pos) / 1000 / r : ms => now + (ms - t) / 1000 / r;
  const nd = hsNudge();
  if (hs && !(typeof PLAY !== "undefined" && PLAY.on && tpOpt("hsOnHit"))) {
    // (the cursor is a song time, so it works on either list; at a change from Auto's list to the replay's, what Auto's already queued up to schedTo is not
    // queued again: a late hit whose object time was inside that is not played a second time at its press)
    const ev = soundList(); if (schedList !== ev) { if (schedList === map.sounds) swFrom = schedTo; schedList = ev; }
    for (let i = lastBefore(ev, schedTo, "t") + 1; i < ev.length && ev[i].t <= to; i++) { if (swFrom !== null && ev[i].nt <= swFrom) continue; playEvent(ev[i], Math.max(now, whenOf(ev[i].t) + nd)); }
  } // (test play plays each hitsound when you hit: play.js)
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
