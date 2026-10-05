"use strict";
// ============ Verify → Audio: spectrogram of the song (like Spek), where its frequencies stop, loudness ============
// Everything comes from the decoded song (A.buf). The whole-song picture is worked out in small slices so the page
// stays responsive; the close-up around the current time is redone when the time moves out of it.
const SPEC = { buf: null, ov: null, job: 0, log: false, lo: -120, hi: -10 };
const SPEC_N = 2048, SPEC_DN = 1024, SPEC_COLS = 1000, SPEC_ROWS = 256, SPEC_WIN = 8000; // FFT sizes, whole-song columns, picture rows, close-up width (ms)
const specHann = n => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = .5 - .5 * Math.cos(2 * Math.PI * i / (n - 1)); return w; };
const SPEC_W = { [SPEC_N]: specHann(SPEC_N), [SPEC_DN]: specHann(SPEC_DN) };
// radix-2 FFT in place
function specFFT(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
// power spectrum of n samples (both channels mixed) starting at sample s, added into acc
function specFrame(chs, s, n, re, im, acc) {
  const win = SPEC_W[n], len = chs[0].length, nc = chs.length;
  for (let i = 0; i < n; i++) { const p = s + i; let v = 0; if (p >= 0 && p < len) { for (let c = 0; c < nc; c++) v += chs[c][p]; v /= nc; } re[i] = v * win[i]; im[i] = 0; }
  specFFT(re, im);
  for (let k = 0; k < n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
}
// power → dBFS (a full-scale sine reads 0 dB)
const specDB = (p, n) => 10 * Math.log10(p + 1e-24) - 20 * Math.log10(n / 4);
// 256-step colour scale: black → blue → purple → red → orange → yellow → white
const SPEC_LUT = (() => {
  const st = [[0, 0, 0, 0], [.13, 6, 6, 50], [.3, 60, 10, 120], [.46, 160, 30, 120], [.62, 230, 70, 60], [.77, 255, 150, 20], [.9, 255, 230, 80], [1, 255, 255, 255]], o = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) { const v = i / 255; let k = 0; while (k < st.length - 2 && v > st[k + 1][0]) k++; const a = st[k], b = st[k + 1], f = (v - a[0]) / (b[0] - a[0]); for (let c = 0; c < 3; c++) o[i * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * f); }
  return o;
})();
// which frequency bin a picture row shows (linear 0 → Nyquist, or log 40 Hz → Nyquist)
function specRowBins(bins, nyq, rows) {
  const out = new Int32Array(rows);
  for (let r = 0; r < rows; r++) { const f = 1 - (r + .5) / rows, hz = SPEC.log ? 40 * Math.pow(nyq / 40, f) : f * nyq; out[r] = Math.min(bins - 1, Math.max(0, Math.round(hz / nyq * bins))); }
  return out;
}
const specY = (hz, nyq, H) => SPEC.log ? H * (1 - Math.log(Math.max(40, hz) / 40) / Math.log(nyq / 40)) : H * (1 - hz / nyq);
// spectrogram data (cols × bins of dB as bytes) → picture (cols × SPEC_ROWS)
function specImage(data, cols, bins, nyq) {
  const cv = document.createElement("canvas"); cv.width = cols; cv.height = SPEC_ROWS;
  const g = cv.getContext("2d"), img = g.createImageData(cols, SPEC_ROWS), px = img.data, rb = specRowBins(bins, nyq, SPEC_ROWS);
  const lo = SPEC.lo, span = SPEC.hi - SPEC.lo;
  for (let x = 0; x < cols; x++) for (let r = 0; r < SPEC_ROWS; r++) {
    const db = data[x * bins + rb[r]] / 255 * 140 - 140, v = Math.max(0, Math.min(255, Math.round((db - lo) / span * 255))), o = (r * cols + x) * 4;
    px[o] = SPEC_LUT[v * 3]; px[o + 1] = SPEC_LUT[v * 3 + 1]; px[o + 2] = SPEC_LUT[v * 3 + 2]; px[o + 3] = 255;
  }
  g.putImageData(img, 0, 0); return cv;
}
const specByte = db => Math.max(0, Math.min(255, Math.round((db + 140) / 140 * 255)));

// ---------- whole song: spectrogram + long-term spectrum + loudness, in slices ----------
function specAnalyze(buf, onStep) {
  const job = ++SPEC.job, chs = [], sr = buf.sampleRate, len = buf.length, nyq = sr / 2, bins = SPEC_N / 2;
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  const cols = SPEC_COLS, per = 3, data = new Uint8Array(cols * bins), sum = new Float64Array(bins), re = new Float32Array(SPEC_N), im = new Float32Array(SPEC_N), acc = new Float64Array(bins);
  const ov = { buf, sr, nyq, bins, cols, data, done: 0, len, dur: len / sr * 1000 };
  let x = 0;
  const step = () => {
    if (job !== SPEC.job) return;
    const t0 = performance.now();
    while (x < cols && performance.now() - t0 < 24) {
      acc.fill(0);
      for (let f = 0; f < per; f++) specFrame(chs, Math.round((x + (f + .5) / per) / cols * len) - SPEC_N / 2, SPEC_N, re, im, acc);
      for (let k = 0; k < bins; k++) { sum[k] += acc[k]; data[x * bins + k] = specByte(specDB(acc[k] / per, SPEC_N)); }
      x++;
    }
    ov.done = x / cols;
    if (x < cols) { onStep(ov); setTimeout(step, 0); return; }
    // loudness and silence at the ends
    let peak = 0, sq = 0, clip = 0, first = -1, last = -1;
    for (let c = 0; c < chs.length; c++) { const d = chs[c]; for (let i = 0; i < len; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; sq += a * a; if (a >= .999) clip++; if (a > .001) { if (first < 0 || i < first) first = i; if (i > last) last = i; } } }
    ov.peak = 20 * Math.log10(peak + 1e-12); ov.rms = 10 * Math.log10(sq / (len * chs.length) + 1e-24); ov.clip = clip;
    ov.silStart = first < 0 ? ov.dur : first / sr * 1000; ov.silEnd = last < 0 ? 0 : (len - 1 - last) / sr * 1000;
    // where the frequencies stop: the long-term spectrum (smoothed) falls far below the mid band and stays there
    const db = new Float64Array(bins); for (let k = 0; k < bins; k++) db[k] = specDB(sum[k] / (cols * per), SPEC_N);
    const sm = new Float64Array(bins); for (let k = 0; k < bins; k++) { let s = 0, n = 0; for (let j = Math.max(0, k - 4); j <= Math.min(bins - 1, k + 4); j++) { s += db[j]; n++; } sm[k] = s / n; }
    const bin = hz => Math.min(bins - 1, Math.round(hz / nyq * bins)), mid = [...sm.slice(bin(1000), bin(6000))].sort((a, b) => a - b)[Math.floor((bin(6000) - bin(1000)) / 2)];
    const floor = Math.min(...sm.slice(bin(Math.min(nyq * .97, 21000)))), thr = Math.max(floor + 20, mid - 75);
    let k = bins - 1; while (k > 0 && sm[k] < thr) k--;
    ov.cutoff = (k + 1) / bins * nyq; ov.full = ov.cutoff > nyq * .96 || floor > mid - 60; ov.ltas = sm;
    onStep(ov);
  };
  setTimeout(step, 0);
  return ov;
}
// ---------- close-up: SPEC_WIN ms around a time, worked out at once ----------
function specDetail(buf, center, cols) {
  const chs = [], sr = buf.sampleRate, bins = SPEC_DN / 2, data = new Uint8Array(cols * bins), re = new Float32Array(SPEC_DN), im = new Float32Array(SPEC_DN), acc = new Float64Array(bins);
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  const t0 = center - SPEC_WIN / 2;
  for (let x = 0; x < cols; x++) {
    acc.fill(0); specFrame(chs, Math.round((t0 + (x + .5) / cols * SPEC_WIN) / 1000 * sr) - SPEC_DN / 2, SPEC_DN, re, im, acc);
    for (let k = 0; k < bins; k++) data[x * bins + k] = specByte(specDB(acc[k], SPEC_DN));
  }
  return { t0, center, cols, bins, nyq: sr / 2, img: specImage(data, cols, bins, sr / 2), data };
}

// ---------- the view ----------
function vfyAudio(main) {
  const info = h("section", "vfybox"); info.append(h("h4", null, tr("Song file")));
  const kvb = h("div"); kvb.innerHTML = audioHTML(); info.append(kvb);
  const buf = A.buf;
  if (!buf) { main.append(info, h("p", "aalert", songMeta ? tr("The song couldn't be decoded in this browser (or it's very large), so there's no spectrum.") : tr("No song file in this package"))); return; }
  const stats = h("div", "vfystats"), head = h("div", "vfyhead"), lg = h("button", "btn ghost sm" + (SPEC.log ? " on" : ""), tr("Log frequency scale"));
  lg.onclick = () => { SPEC.log = !SPEC.log; lg.classList.toggle("on", SPEC.log); if (SPEC.ov && SPEC.ov.img) SPEC.ov.img = specImage(SPEC.ov.data, SPEC.ov.cols, SPEC.ov.bins, SPEC.ov.nyq); detail.key = ""; specKick(); };
  head.append(h("h4", null, tr("Spectrum of the whole song")), lg);
  const ovBox = h("section", "vfybox"), ovC = h("canvas", "speccv"), ovTip = h("div", "rtip"); ovTip.hidden = true;
  const ovW = h("div", "rcw"); ovW.append(ovC, ovTip);
  ovBox.append(head, ovW, h("p", "hint", tr("Brighter = louder. A sharp dark band across the top means the frequencies stop there: a 128 kbps MP3 stops near 16 kHz, a good 192 kbps one near 19–20 kHz. Click to jump there.")));
  const dBox = h("section", "vfybox"), dC = h("canvas", "speccv det"), dTip = h("div", "rtip"); dTip.hidden = true;
  const dW = h("div", "rcw"); dW.append(dC, dTip);
  dBox.append(h("h4", null, tr("Close-up around the current time")), dW, h("p", "hint", tr("Lines are this difficulty's objects, coloured by beat snap: they should sit on the sounds they follow. Scroll to move by the beat snap, click to jump.")));
  main.append(stats, ovBox, dBox, info);
  SPEC.statsBox = stats;
  if (!SPEC.ov || SPEC.ov.buf !== buf) SPEC.ov = specAnalyze(buf, ov => { ov.img = specImage(ov.data, ov.cols, ov.bins, ov.nyq); if (SPEC.statsBox && SPEC.statsBox.isConnected) specStats(SPEC.statsBox, ov); specKick(); });
  else specStats(stats, SPEC.ov);
  const detail = { key: "" };
  // drawing (one loop while the view is open: playhead, hover, and the close-up following the song)
  const hover = { ov: null, d: null };
  const axisW = 46, botH = 16;
  const size = c => { const w = c.clientWidth || 600, hh = c.classList.contains("det") ? 200 : 220, d = Math.min(devicePixelRatio || 1, 2); if (c.width !== Math.round(w * d) || c.height !== Math.round(hh * d)) { c.width = Math.round(w * d); c.height = Math.round(hh * d); c.style.height = hh + "px"; } const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); return { g, w, hh }; };
  const axis = (g, nyq, H) => {
    g.fillStyle = "#16111f"; g.fillRect(0, 0, axisW, H + botH); g.font = "10px sans-serif"; g.textBaseline = "middle"; g.textAlign = "right"; g.fillStyle = "#a99fbd";
    const marks = SPEC.log ? [100, 250, 500, 1000, 2000, 4000, 8000, 16000, 20000] : [0, 2500, 5000, 7500, 10000, 12500, 15000, 17500, 20000];
    for (const hz of marks) { if (hz > nyq) continue; const y = specY(hz, nyq, H); if (y < 5 || y > H - 2 && hz) continue; g.fillText(hz >= 1000 ? (hz / 1000) + "k" : String(hz), axisW - 5, Math.min(H - 5, y)); g.fillRect(axisW - 3, y, 3, 1); }
    g.textAlign = "left";
  };
  const drawOv = () => {
    const ov = SPEC.ov, { g, w, hh } = size(ovC), H = hh - botH, pw = w - axisW;
    g.fillStyle = "#000"; g.fillRect(0, 0, w, hh);
    if (ov.img) g.drawImage(ov.img, axisW, 0, pw, H);
    if (ov.done < 1) { g.fillStyle = "#a99fbd"; g.font = "12px sans-serif"; g.textBaseline = "middle"; g.fillText(tr("Working out the spectrum… {p}%", { p: Math.round(ov.done * 100) }), axisW + ov.done * pw + 12, H / 2); }
    axis(g, ov.nyq, H);
    const X = ms => axisW + ms / ov.dur * pw;
    g.fillStyle = "#a99fbd"; g.font = "10px sans-serif"; g.textBaseline = "alphabetic";
    const stepS = ov.dur > 300000 ? 60000 : ov.dur > 120000 ? 30000 : 15000;
    for (let t = 0; t <= ov.dur; t += stepS) { g.fillRect(X(t), H, 1, 3); g.fillText(fmt(t / 1000), X(t) + 2, hh - 3); }
    if (ov.cutoff && !ov.full && ov.img) { const y = specY(ov.cutoff, ov.nyq, H); g.setLineDash([5, 4]); g.strokeStyle = "rgba(124,200,255,.9)"; g.beginPath(); g.moveTo(axisW, y); g.lineTo(w, y); g.stroke(); g.setLineDash([]); g.fillStyle = "#7cc8ff"; g.fillText("~" + (ov.cutoff / 1000).toFixed(1) + " kHz", w - 70, y - 4); }
    // detail window + playhead
    const cur = A.cur(); g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(X(cur - SPEC_WIN / 2), 0, SPEC_WIN / ov.dur * pw, H);
    g.fillStyle = "#ff66aa"; g.fillRect(X(cur) - 1, 0, 2, H);
    if (hover.ov) { g.fillStyle = "rgba(255,255,255,.6)"; g.fillRect(hover.ov[0], 0, 1, H); g.fillRect(axisW, hover.ov[1], pw, 1); }
    ovC.geom = { axisW, pw, H, dur: ov.dur, nyq: ov.nyq };
  };
  const drawDet = () => {
    const { g, w, hh } = size(dC), H = hh - botH, pw = w - axisW, cur = A.cur(), cols = Math.min(900, Math.max(200, Math.round(pw)));
    if (!detail.d || Math.abs(cur - detail.d.center) > SPEC_WIN * .3 || detail.key !== cols + "|" + SPEC.log) { detail.d = specDetail(buf, isPlaying() ? cur + SPEC_WIN * .25 : cur, cols); detail.key = cols + "|" + SPEC.log; }
    const d = detail.d, X = ms => axisW + (ms - d.t0) / SPEC_WIN * pw;
    g.fillStyle = "#000"; g.fillRect(0, 0, w, hh); g.drawImage(d.img, axisW, 0, pw, H); axis(g, d.nyq, H);
    // beat ticks along the bottom, objects as lines
    const t1 = d.t0 + SPEC_WIN;
    g.font = "10px sans-serif"; g.textBaseline = "alphabetic";
    for (const o of map.hit) {
      if (o.end < d.t0) continue; if (o.t > t1) break;
      const pts = o.kind === "slider" ? Array.from({ length: o.slides + 1 }, (_, k) => o.t + o.span * k) : o.kind === "spinner" ? [o.t, o.end] : [o.t];
      for (const t of pts) { if (t < d.t0 || t > t1) continue; const sn = snapOf(t), x = X(t), head = t === o.t; g.fillStyle = RHY_COL[sn.div] ?? RHY_COL[0]; g.globalAlpha = head ? .45 : .2; g.fillRect(x - .5, 12, 1, H - 12); g.globalAlpha = 1; if (head) { g.beginPath(); g.arc(x, 6, 3.5, 0, 7); g.fill(); } else g.fillRect(x - 1, 3, 2, 6); }
    }
    g.globalAlpha = 1; g.fillStyle = "#a99fbd";
    for (let s = Math.ceil(d.t0 / 1000) * 1000; s <= t1; s += 1000) { g.fillRect(X(s), H, 1, 3); g.fillText(fmtMs(s).slice(0, 5), X(s) + 2, hh - 3); }
    g.fillStyle = "#ff66aa"; g.fillRect(X(cur) - 1, 0, 2, H);
    if (hover.d) { g.fillStyle = "rgba(255,255,255,.6)"; g.fillRect(hover.d[0], 0, 1, H); g.fillRect(axisW, hover.d[1], pw, 1); }
    dC.geom = { axisW, pw, H, t0: d.t0, nyq: d.nyq };
  };
  let last = -1, raf = 0;
  const loop = () => {
    raf = 0; if (!ovC.isConnected) return;
    const cur = A.cur();
    if (SPEC.dirty || cur !== last) { SPEC.dirty = false; last = cur; drawOv(); drawDet(); }
    raf = requestAnimationFrame(loop); // keeps following the song while the view is open (draws only when the time changes)
  };
  SPEC.kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  specKick();
  // hover / click / wheel
  const at = (c, e) => { const r = c.getBoundingClientRect(), g2 = c.geom; if (!g2) return null; const x = e.clientX - r.left, y = e.clientY - r.top; if (x < g2.axisW || y > g2.H) return null; const fr = 1 - y / g2.H; return { x, y, hz: SPEC.log ? 40 * Math.pow(g2.nyq / 40, fr) : fr * g2.nyq, t: c === ovC ? (x - g2.axisW) / g2.pw * g2.dur : g2.t0 + (x - g2.axisW) / g2.pw * SPEC_WIN }; };
  const bind = (c, tip, key) => {
    c.addEventListener("pointermove", e => { const p = at(c, e); if (!p) { tip.hidden = true; hover[key] = null; SPEC.dirty = true; specKick(); return; }
      hover[key] = [p.x, p.y]; tip.textContent = `${fmtMs(p.t)} · ${p.hz >= 1000 ? (p.hz / 1000).toFixed(1) + " kHz" : Math.round(p.hz) + " Hz"}`; tip.hidden = false;
      const r = c.getBoundingClientRect(); tip.style.transform = `translate(${Math.min(Math.max(4, p.x + 12), r.width - tip.offsetWidth - 4)}px,${Math.max(0, p.y - 34)}px)`; SPEC.dirty = true; specKick(); });
    c.addEventListener("pointerleave", () => { tip.hidden = true; hover[key] = null; SPEC.dirty = true; specKick(); });
    c.addEventListener("click", e => { const p = at(c, e); if (p) { seekTo(Math.max(0, p.t)); specKick(); } });
  };
  bind(ovC, ovTip, "ov"); bind(dC, dTip, "d");
  dC.addEventListener("wheel", e => { e.preventDefault(); stepSnap(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1); specKick(); }, { passive: false });
}
function specKick() { SPEC.dirty = true; if (SPEC.kick) SPEC.kick(); }
// the numbers above the pictures
function specStats(box, ov) {
  box.innerHTML = "";
  const card = (label, val, note, cls = "") => { const c = h("div", "vfystat " + cls); c.append(h("small", null, label), h("b", null, val)); if (note) c.append(h("p", null, note)); box.append(c); };
  if (ov.done < 1) { card(tr("Frequencies up to"), "…", tr("Working out the spectrum… {p}%", { p: Math.round(ov.done * 100) })); return; }
  const k = ov.cutoff / 1000, kbps = songMeta && songMeta.kbps ? Math.round(songMeta.kbps) : 0;
  let note, cls = "";
  if (ov.full) note = tr("Full range: no cut-off before the top of the file's range.");
  else if (k < 15) { note = tr("Very low: the song is probably from a low-quality source."); cls = "warning"; }
  else if (k < 17.2) { note = kbps >= 180 ? tr("Where a 128 kbps file stops, but this one is {k} kbps: it was probably re-encoded from a lower-quality file.", { k: kbps }) : tr("Typical of a 128 kbps MP3."); if (kbps >= 180) cls = "warning"; }
  else if (k < 19.2) note = tr("Typical of a 160–192 kbps MP3.");
  else note = tr("High-quality source.");
  card(tr("Frequencies up to"), ov.full ? (ov.nyq / 1000).toFixed(1) + " kHz" : "~" + k.toFixed(1) + " kHz", note, cls);
  card(tr("Peak"), ov.peak.toFixed(1) + " dBFS", ov.clip > 50 ? tr("{n} samples at full scale: it may be clipping.", { n: ov.clip }) : tr("No clipping"), ov.clip > 50 ? "warning" : "");
  card(tr("Average loudness"), ov.rms.toFixed(1) + " dBFS", tr("RMS of the whole song"));
  const early = map && map.hit.length && ov.silStart > map.first + 20;
  card(tr("Silence at the start"), (ov.silStart / 1000).toFixed(2) + " s", early ? tr("The first object is at {t}, before any sound.", { t: fmtMs(map.first) }) : "", early ? "warning" : "");
  card(tr("Silence at the end"), (ov.silEnd / 1000).toFixed(1) + " s", "");
}
