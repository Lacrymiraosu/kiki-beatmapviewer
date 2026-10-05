"use strict";
// ============ mapping tools panel (preview mode) + shared panel renderers (editor tabs) ============
const TABS = [["overview", "Overview"], ["timing", "Timing"], ["audio", "Song file"], ["verify", "Verify"], ["notes", "Mod notes"], ["compare", "Compare"]];
let toolsTab = "overview";
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5];
for (const r of SPEEDS) { const b = h("button", r === 1 ? "on" : "", r + "x"); b.dataset.r = r; b.onclick = () => setRate(r); $("speed").append(b); }
const LIVE_FIELDS = [["time", "Time"], ["bpm", "BPM"], ["sv", "SV"], ["beat", "Bar:beat"], ["kiai", "Kiai"], ["next", "Next object"]];
for (const [k, label] of LIVE_FIELDS) { const d = h("div"), l = h("small", null, label); l.dataset.i18n = label; d.append(l, h("b", null, "–")); d.lastChild.id = "lv-" + k; $("live").append(d); }
// Verify is for members (and everyone while the site is open); guests browsing the preview don't get it
const vfyAllowed = () => !(typeof GATE !== "undefined" && GATE.guest);
function buildToolTabs() {
  $("tTabs").innerHTML = "";
  for (const [k, label] of TABS) { if (k === "verify" && !vfyAllowed()) continue; const b = h("button", "tab", tr(label)); b.dataset.tab = k; b.setAttribute("role", "tab"); b.onclick = () => { toolsTab = k; renderTools(); }; $("tTabs").append(b); }
}
buildToolTabs();

function openTools() {
  closeSheet(); closeLive();
  UI.tools.hidden = false; clearTimeout(uiTimer);
  document.querySelectorAll("#tools [data-k]").forEach(i => i.checked = !!S[i.dataset.k]);
  renderTools(); updateLive(A.cur());
}
function closeTools() { if (UI.tools.hidden) return; UI.tools.hidden = true; showUI(); }
$("toolsBtn").onclick = () => UI.tools.hidden ? openTools() : closeTools();
$("toolsClose").onclick = closeTools;
$("copyTs").onclick = async () => { const s = tsAt(A.cur()); toast(await copyText(s) ? tr("Copied {s}", { s }) : s); };
$("copyAt").onclick = () => { const u = shareURL(A.cur()); if (!u) return toast(tr("This file has no beatmap ID, so it can't be shared as a link")); copyText(u).then(ok => toast(ok ? tr("Link at this time copied") : u)); };

// fills a container with one of the panels (used by the tools sheet and the editor tabs)
function renderPanel(kind, box) {
  box.innerHTML = "";
  if (kind === "overview") box.innerHTML = overviewHTML();
  else if (kind === "timing") { if (EDIT.on) renderTimingEditor(box); else box.innerHTML = timingHTML(); }
  else if (kind === "audio") box.innerHTML = audioHTML();
  else if (kind === "setup") renderSetup(box);
  else if (kind === "verify") renderVerify(box);
  else if (kind === "notes") renderNotes(box);
  else if (kind === "compare") renderCompare(box);
  else if (kind === "hitsounds") renderHsStudio(box);
}
function exportRow() {
  const r = h("div", "btnrow"), a = h("button", "btn main sm", tr("Export .osu")), b = h("button", "btn ghost sm", tr("Export .osz"));
  a.onclick = exportOsu; b.onclick = exportOsz; r.append(a, b); return r;
}
function renderTools() {
  if (UI.tools.hidden || !map) return;
  if (!$("tTabs").querySelector('[data-tab="verify"]') !== !vfyAllowed()) buildToolTabs(); // (permissions changed)
  if (toolsTab === "verify" && !vfyAllowed()) toolsTab = "overview";
  $("tTabs").querySelectorAll(".tab").forEach(b => { const on = b.dataset.tab === toolsTab; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  renderPanel(toolsTab, $("tBody"));
  timingRow = -1;
}
// click on any row with data-t seeks there (and selects the object in modding mode)
function panelClick(e) {
  const r = e.target.closest("[data-t]"); if (!r) return;
  seekTo(+r.dataset.t); showUI();
  if (EDIT.on && r.dataset.lid) edSelectIds([+r.dataset.lid]);
  if (EDIT.on && r.dataset.go) edTab("compose");
}
$("tBody").addEventListener("click", panelClick);

let timingRow = -1;
function updateLive(t) {
  if (!map) return;
  const b = beatInfo(t), n = Math.floor((t - b.off) / b.len + 1e-6);
  const set = (k, v) => { const e = $("lv-" + k); if (e.textContent !== v) e.textContent = v; };
  set("time", fmtMs(t));
  set("bpm", String(Math.round(60000 / b.len * 100) / 100));
  set("sv", svAt(map, t).toFixed(2) + "x");
  set("beat", `${Math.floor(n / b.meter) + 1}:${((n % b.meter) + b.meter) % b.meter + 1}`);
  set("kiai", kiaiAt(t) ? tr("On") : "–");
  const i = lastBefore(map.hit, t - 1, "t") + 1, nx = map.hit[i];
  set("next", nx ? `${Math.round(nx.t - t)} ms` : "–");
  if (toolsTab === "timing") {
    const ti = lastBefore(map.timing, t, "time");
    if (ti !== timingRow) {
      const rows = $("tBody").querySelectorAll(".tp");
      rows[timingRow] && rows[timingRow].classList.remove("on");
      rows[ti] && rows[ti].classList.add("on");
      timingRow = ti;
    }
  }
}

const kv = pairs => `<dl class="kv">${pairs.filter(p => p && p[1] !== undefined && p[1] !== "").map(([k, v]) => `<dt>${esc(tr(k))}</dt><dd>${v}</dd>`).join("")}</dl>`;
const seekLink = (t, label) => `<button class="mlink" data-t="${Math.round(t)}" data-go="1">${esc(label ?? fmtMs(t))}</button>`;
const onOff = v => esc(tr(v ? "On" : "Off"));
function mapStats(m) {
  let c = 0, s = 0, sp = 0; for (const o of m.hit) o.kind === "circle" ? c++ : o.kind === "slider" ? s++ : sp++;
  let br = 0; for (const [a, b] of m.breaks) br += b - a;
  return { c, s, sp, combo: m.sounds.length, drain: Math.max(0, m.last - m.first - br) };
}
function curDiffInfo() {
  if (!curSet || !map) return null;
  const bid = String(map.meta.BeatmapID || "");
  return curSet.diffs.find(d => String(d.bid) === bid) || curSet.diffs.find(d => d.name === map.meta.Version) || null;
}
function overviewHTML() {
  const m = map, M = m.meta, D = m.diff, st = mapStats(m), di = curDiffInfo();
  const cs = +(D.CircleSize ?? 5), od = +(D.OverallDifficulty ?? 5), ar = +(D.ApproachRate ?? od);
  const bgImg = m.bg ? images[norm(m.bg)] : null;
  return `<h3>${esc(tr("Map info"))}</h3>` + kv([
    ["Title", esc(M.TitleUnicode || M.Title)], ["Artist", esc(M.ArtistUnicode || M.Artist)], ["Mapper", esc(M.Creator)], ["Difficulty", esc(M.Version)],
    ["Source", esc(M.Source)], ["Beatmap ID", esc(M.BeatmapID)], ["Set ID", esc(M.BeatmapSetID || setId)],
    di && di.stars ? ["Star rating", `★ ${di.stars.toFixed(2)}`] : null, curSet && curSet.status ? ["Status", esc(curSet.status)] : null,
    ["Tags", `<small>${esc((M.Tags || "").slice(0, 300))}</small>`],
  ]) + `<h3>Difficulty</h3>` + kv([
    ["CS", `${cs} <small>(${esc(tr("radius {r} osu!px", { r: m.radius.toFixed(1) }))})</small>`],
    ["AR", `${ar} <small>(preempt ${Math.round(m.preempt)} ms, fade ${Math.round(m.fadeIn)} ms)</small>`],
    ["OD", `${od} <small>(300 ±${(80 - 6 * od).toFixed(1)} / 100 ±${(140 - 8 * od).toFixed(1)} / 50 ±${(200 - 10 * od).toFixed(1)} ms)</small>`],
    ["HP", esc(D.HPDrainRate ?? "?")],
    ["Slider multiplier", esc(D.SliderMultiplier ?? "1.4")], ["Slider tick rate", esc(D.SliderTickRate ?? "1")],
    ["Stack leniency", esc(m.general.StackLeniency ?? "0.7")],
  ]) + `<h3>Objects</h3>` + kv([
    ["Circles", st.c], ["Sliders", st.s], ["Spinners", st.sp], ["Total", m.hit.length], ["Max combo", st.combo],
    ["Drain time", fmt(st.drain / 1000)], ["Total length", fmt(m.last / 1000)], ["First object", m.hit.length ? seekLink(m.first) : "–"],
    ["Breaks", m.breaks.length ? m.breaks.map(b => seekLink(b[0])).join(" ") : "–"], ["Kiai", m.kiai.length ? m.kiai.map(k => seekLink(k[0])).join(" ") : "–"],
    ["Bookmarks", m.bookmarks.length ? m.bookmarks.map(b => seekLink(b)).join(" ") : "–"],
  ]) + `<h3>${esc(tr("Other"))}</h3>` + kv([
    ["Storyboard", sb.length ? `${sb.length} sprite${osbText ? " (.osb)" : ""}` : "–"], ["Video", esc(m.video || "–")],
    ["Background", m.bg ? `${esc(m.bg)}${bgImg ? ` <small>(${bgImg.width}×${bgImg.height})</small>` : ""}` : "–"],
    ["Custom hitsounds", tr("{n} files", { n: Object.keys(mapBank).length })], ["Sample set", esc(m.general.SampleSet || "Normal")],
    ["Audio lead-in", esc(m.general.AudioLeadIn || 0) + " ms"], ["Preview time", +(m.general.PreviewTime ?? -1) > 0 ? seekLink(+m.general.PreviewTime) : esc(tr("Not set"))],
    ["Countdown", onOff(m.general.Countdown !== "0")], ["Epilepsy warning", onOff(m.general.EpilepsyWarning === "1")],
    ["Widescreen storyboard", onOff(m.general.WidescreenStoryboard === "1")], ["Letterbox in breaks", onOff(m.general.LetterboxInBreaks === "1")],
  ]);
}
function timingHTML() {
  const T = map.timing, reds = T.filter(x => x.uninherited && x.beat > 0);
  const dur = new Map(); // BPM -> total ms, to find the main BPM
  reds.forEach((r, i) => { const b = Math.round(60000 / r.beat * 100) / 100, end = i + 1 < reds.length ? reds[i + 1].time : Math.max(map.last, r.time); dur.set(b, (dur.get(b) || 0) + end - r.time); });
  let main = 0, best = -1; for (const [b, d] of dur) if (d > best) { best = d; main = b; }
  const bpms = [...dur.keys()];
  const sets = ["", "Normal", "Soft", "Drum"];
  const rows = T.slice(0, 4000).map(tp => {
    if (tp.uninherited) return `<button class="tp red" data-t="${Math.round(tp.time)}"><span>${fmtMs(tp.time)}</span><span><b>${Math.round(60000 / tp.beat * 100) / 100} BPM</b> ${tp.meter}/4</span><small>${sets[tp.sampleSet] || "Auto"} ${tp.volume}%${tp.kiai ? " • kiai" : ""}</small></button>`;
    const sv = tp.beat < 0 ? -100 / tp.beat : 1;
    return `<button class="tp green" data-t="${Math.round(tp.time)}"><span>${fmtMs(tp.time)}</span><span>SV ${sv.toFixed(2)}x</span><small>${sets[tp.sampleSet] || "Auto"} ${tp.volume}%${tp.kiai ? " • kiai" : ""}</small></button>`;
  }).join("");
  return kv([
    ["Main BPM", main || "?"], ["BPM range", bpms.length > 1 ? `${Math.min(...bpms)} – ${Math.max(...bpms)}` : main || "?"],
    ["Offset (first red line)", reds.length ? `${reds[0].time} ms` : "?"], ["Red lines", reds.length], ["Green lines", T.length - reds.length],
  ]) + `<p class="hint">${esc(tr("Red = uninherited (BPM) • Green = inherited (SV / sound) • Tap to jump there"))}</p><div class="tlist">${rows}</div>` + (T.length > 4000 ? `<p class="hint">${esc(tr("Showing the first 4000 lines"))}</p>` : "");
}
function audioHTML() {
  const a = songMeta, name = map.general.AudioFilename || "";
  if (!a) return kv([["File", esc(name) || "–"]]) + `<p class="hint">${esc(tr("No song file in this package"))}</p>`;
  const limit = /ogg/i.test(a.fmt || "") ? 208 : 192;
  const brOk = a.kbps ? (a.kbps >= 128 && a.kbps <= limit + 1 ? `<span class="ok">${esc(tr("OK (128–{max} kbps)", { max: limit }))}</span>` : `<span class="warnc">${esc(tr("Outside the ranked range 128–{max} kbps", { max: limit }))}</span>`) : "";
  const modes = ["Stereo", "Joint stereo", "Dual channel", "Mono"];
  return kv([
    ["File", esc(name)], ["Size", fmtBytes(a.size)], ["Format", esc(a.fmt || tr("Unknown"))],
    ["Bitrate", a.kbps ? `${a.vbr ? "VBR ~" : a.cbr === false ? "" : "CBR "}${Math.round(a.kbps)} kbps` : "?"], ["Ranked criteria", brOk],
    ["Sample rate", a.sr ? a.sr + " Hz" : "?"], ["Channels", a.chMode != null ? modes[a.chMode] : a.ch ? (a.ch === 1 ? "Mono" : a.ch + " ch") : "?"],
    ["Length", a.dur ? `${fmt(a.dur)} (${Math.round(a.dur * 1000)} ms)` : "?"], ["Encoder", esc(a.enc || "")],
    a.delay != null ? ["Encoder delay / padding", `${a.delay} / ${a.padding} samples`] : null,
    a.id3 && a.id3.title ? ["ID3 title", esc(a.id3.title)] : null, a.id3 && a.id3.artist ? ["ID3 artist", esc(a.id3.artist)] : null,
    ["Played with", A.mode === "buf" ? esc(tr("Web Audio (exact seeking)")) : A.mode === "el" ? esc(tr("<audio> (big file or couldn't decode)")) : esc(tr("No sound"))],
    actx ? ["Output latency", `${Math.round(outLat())} ms`] : null,
  ]);
}

// ---------- song file analysis (MP3 / OGG / WAV headers) ----------
function analyzeAudio(ab) {
  const u = new Uint8Array(ab), info = { size: u.length };
  const str = (o, l) => String.fromCharCode(...u.subarray(o, o + l));
  try {
    if (str(0, 4) === "OggS") return parseOgg(u, info);
    if (str(0, 4) === "RIFF" && str(8, 4) === "WAVE") return parseWav(u, info);
    return parseMp3(u, info);
  } catch { return info; }
}
const MP3_BR = { V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], V2L3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
function mp3Header(u, p) {
  if (p + 4 > u.length || u[p] !== 0xFF || (u[p + 1] & 0xE0) !== 0xE0) return null;
  const b1 = u[p + 1], b2 = u[p + 2], b3 = u[p + 3], ver = (b1 >> 3) & 3, layer = (b1 >> 1) & 3, bri = b2 >> 4, sri = (b2 >> 2) & 3;
  if (ver === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) return null;
  const v1 = ver === 3, L = 4 - layer;
  const br = (v1 ? (L === 1 ? MP3_BR.V1L1 : L === 2 ? MP3_BR.V1L2 : MP3_BR.V1L3) : (L === 1 ? MP3_BR.V2L1 : MP3_BR.V2L3))[bri];
  const sr = (v1 ? [44100, 48000, 32000] : ver === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000])[sri];
  const pad = (b2 >> 1) & 1, spf = L === 1 ? 384 : L === 3 && !v1 ? 576 : 1152;
  const len = L === 1 ? (Math.floor(12 * br * 1000 / sr) + pad) * 4 : Math.floor(spf / 8 * br * 1000 / sr) + pad;
  return { ver: v1 ? "1" : ver === 2 ? "2" : "2.5", L, br, sr, ch: b3 >> 6, spf, len, v1 };
}
function parseMp3(u, info) {
  let p = 0;
  if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) {
    const sz = (u[6] & 127) << 21 | (u[7] & 127) << 14 | (u[8] & 127) << 7 | (u[9] & 127);
    info.id3 = parseId3(u, u[3], sz); p = 10 + sz + (u[5] & 0x10 ? 10 : 0);
  }
  let hd = null;
  for (const lim = Math.min(u.length - 4, p + 262144); p < lim; p++) {
    const a = mp3Header(u, p); if (!a || !a.len) continue;
    const b = mp3Header(u, p + a.len);
    if (b && b.sr === a.sr && b.L === a.L) { hd = a; break; }
  }
  if (!hd) return info;
  info.fmt = `MP3 (MPEG-${hd.ver} Layer ${["", "I", "II", "III"][hd.L]})`; info.sr = hd.sr; info.chMode = hd.ch; info.ch = hd.ch === 3 ? 1 : 2;
  const side = hd.v1 ? (hd.ch === 3 ? 17 : 32) : (hd.ch === 3 ? 9 : 17);
  const x = p + 4 + side, tag = String.fromCharCode(...u.subarray(x, x + 4));
  let frames = 0;
  if (tag === "Xing" || tag === "Info") {
    const flags = u[x + 7]; let q = x + 8;
    if (flags & 1) { frames = (u[q] << 24 | u[q + 1] << 16 | u[q + 2] << 8 | u[q + 3]) >>> 0; q += 4; }
    if (flags & 2) q += 4; if (flags & 4) q += 100; if (flags & 8) q += 4;
    const enc = String.fromCharCode(...u.subarray(q, q + 9));
    if (/^[A-Za-z][\x20-\x7e]{3,}/.test(enc)) {
      info.enc = enc.replace(/[^\x20-\x7e]/g, "").trim();
      const d = q + 21; // LAME tag: 12-bit encoder delay + 12-bit padding
      if (/^LAME|^Lavc|^Lavf/.test(info.enc)) { info.delay = (u[d] << 4) | (u[d + 1] >> 4); info.padding = ((u[d + 1] & 15) << 8) | u[d + 2]; }
    }
    info.vbr = tag === "Xing"; info.cbr = tag === "Info";
  } else {
    const v = p + 36;
    if (String.fromCharCode(...u.subarray(v, v + 4)) === "VBRI") { frames = (u[v + 14] << 24 | u[v + 15] << 16 | u[v + 16] << 8 | u[v + 17]) >>> 0; info.vbr = true; }
  }
  const audioBytes = u.length - p;
  if (frames) { info.dur = frames * hd.spf / hd.sr; info.kbps = audioBytes * 8 / info.dur / 1000; }
  else { info.kbps = hd.br; info.dur = audioBytes * 8 / (hd.br * 1000); info.cbr = true; }
  if (info.id3 && info.id3.enc && !info.enc) info.enc = info.id3.enc;
  return info;
}
function parseId3(u, ver, size) {
  const out = {}; if (ver < 3) return out;
  const dec = (b) => {
    const e = b[0], d = b.subarray(1);
    try { return (e === 1 || e === 2 ? new TextDecoder(e === 2 ? "utf-16be" : "utf-16") : new TextDecoder(e === 3 ? "utf-8" : "latin1")).decode(d).replace(/\0/g, "").trim(); } catch { return ""; }
  };
  const want = { TIT2: "title", TPE1: "artist", TALB: "album", TSSE: "enc" };
  for (let p = 10, end = Math.min(u.length, 10 + size); p + 10 < end;) {
    const id = String.fromCharCode(u[p], u[p + 1], u[p + 2], u[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const sz = ver === 4 ? (u[p + 4] & 127) << 21 | (u[p + 5] & 127) << 14 | (u[p + 6] & 127) << 7 | (u[p + 7] & 127) : (u[p + 4] << 24 | u[p + 5] << 16 | u[p + 6] << 8 | u[p + 7]) >>> 0;
    if (!sz || p + 10 + sz > end) break;
    if (want[id]) out[want[id]] = dec(u.subarray(p + 10, p + 10 + sz));
    p += 10 + sz;
  }
  return out;
}
function parseOgg(u, info) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  for (let i = 0; i < Math.min(u.length - 30, 400); i++) {
    if (u[i] === 1 && String.fromCharCode(...u.subarray(i + 1, i + 7)) === "vorbis") {
      info.fmt = "OGG Vorbis"; info.ch = u[i + 11]; info.sr = dv.getUint32(i + 12, true);
      const nom = dv.getInt32(i + 20, true); if (nom > 0) info.nominal = nom / 1000;
      break;
    }
    if (String.fromCharCode(...u.subarray(i, i + 8)) === "OpusHead") { info.fmt = "OGG Opus"; info.ch = u[i + 9]; info.sr = 48000; break; }
  }
  for (let i = u.length - 14; i > Math.max(0, u.length - 65536); i--) { // last page granule position = total samples
    if (u[i] === 0x4f && u[i + 1] === 0x67 && u[i + 2] === 0x67 && u[i + 3] === 0x53) {
      const g = dv.getUint32(i + 6, true) + dv.getUint32(i + 10, true) * 4294967296;
      if (info.sr && g > 0) { info.dur = g / info.sr; info.kbps = u.length * 8 / info.dur / 1000; info.vbr = true; }
      break;
    }
  }
  if (!info.kbps && info.nominal) info.kbps = info.nominal;
  return info;
}
function parseWav(u, info) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); info.fmt = "WAV";
  for (let p = 12; p + 8 < u.length;) {
    const id = String.fromCharCode(...u.subarray(p, p + 4)), sz = dv.getUint32(p + 4, true);
    if (id === "fmt ") { info.ch = dv.getUint16(p + 10, true); info.sr = dv.getUint32(p + 12, true); info.kbps = dv.getUint32(p + 16, true) * 8 / 1000; info.cbr = true; }
    if (id === "data") { info.dur = sz / (info.kbps * 125 || 1); break; }
    p += 8 + sz + (sz & 1);
  }
  return info;
}

// ---------- beat snap helpers (shared with the editor) ----------
const DIVS = [1, 2, 3, 4, 6, 8, 12, 16];
function snapOf(t, m = map) { // the divisor this time sits on (0 = unsnapped) and its unsnap in ms, like MapsetVerifier (parse.js)
  const u = redLineAt(m, t);
  return { div: lowestDivisor(t, m, u), err: practicalUnsnap(t, m, u) };
}
function snapTime(t, div = S.snap) {
  const b = beatInfo(t), step = b.len / div;
  return Math.round(b.off + Math.round((t - b.off) / step) * step);
}

// ---------- timestamps (osu! modding format: 01:23:456 (1,2) - ) ----------
function tsFor(objs) {
  if (!objs.length) return "";
  if (map && map.mode === 3) { const L = objs.slice().sort((a, b) => a.t - b.t || a.col - b.col); return `${fmtMs(L[0].t)} (${L.map(o => Math.round(o.t) + "|" + o.col).join(",")}) - `; } // osu!mania: time|column (lazer)
  return `${fmtMs(objs[0].t)} (${objs.map(o => o.kind === "spinner" ? "spinner" : o.num).join(",")}) - `;
}
function tsAt(t) {
  const i = lastBefore(map.hit, t + 5, "t"), o = map.hit[i];
  if (o && Math.abs(o.t - t) <= 5) return tsFor([o]);
  const n = map.hit[i + 1];
  return n && n.t - t < 50 ? tsFor([n]) : `${fmtMs(t)} - `;
}

// ---------- mod notes (saved per difficulty in this browser) ----------
const NOTE_TYPES = [["problem", "Problem"], ["suggestion", "Suggestion"], ["praise", "Praise"], ["note", "Note"]];
const notesKey = () => "obv-notes:" + (+map.meta.BeatmapID > 0 ? map.meta.BeatmapID : `${map.meta.Title}|${map.meta.Creator}|${map.meta.Version}`);
const DEMO_NOTES = {}; // the tour's notes live in memory only
// categories the modder names (General, Visual, Hitsound…), the same list for every map (kept in the settings).
// A note's cat is a category id; an id that's gone (deleted category) reads as no category.
const NOTE_CATS_DEF = [["general", "General"], ["visual", "Visual"], ["hitsound", "Hitsound"]];
function noteCats() { if (!Array.isArray(S.noteCats)) S.noteCats = NOTE_CATS_DEF.map(([id]) => ({ id, name: "" })); return S.noteCats; }
const catName = c => c ? c.name || tr((NOTE_CATS_DEF.find(d => d[0] === c.id) || ["", c.id])[1]) : tr("No category");
const catOf = id => id ? noteCats().find(c => c.id === id) || null : null;
function noteCatAdd(name) {
  name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 40); if (!name) return null;
  const same = noteCats().find(c => catName(c).toLowerCase() === name.toLowerCase()); if (same) return same;
  const c = { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name }; noteCats().push(c); save(); return c;
}
// the category new notes go into: the one being looked at, else the last one used
const noteCatNew = () => catOf(S.noteCat) ? S.noteCat : catOf(S.noteCatNew) ? S.noteCatNew : "";
function noteCatSelect(val, onchange) {
  const sel = h("select", "ncsel"); sel.add(new Option(tr("No category"), ""));
  for (const c of noteCats()) sel.add(new Option(catName(c), c.id));
  sel.value = catOf(val) ? val : ""; sel.setAttribute("aria-label", tr("Category")); sel.onchange = () => onchange(sel.value); return sel;
}
function loadNotes() { if (DEMO_TOUR) return (DEMO_NOTES[notesKey()] || []).slice(); try { return JSON.parse(localStorage.getItem(notesKey()) || "[]"); } catch { return []; } }
function saveNotes(list) { notesMemo = null; setTimeout(() => typeof sideOpen === "function" && sideOpen() && sideRender(), 0); try { if (DEMO_TOUR) DEMO_NOTES[notesKey()] = list.slice(); else localStorage.setItem(notesKey(), JSON.stringify(list)); } catch { toast(tr("Couldn't save the note (storage is full)")); } drawTimeline(); dirty = true; }
let notesMemo = null; // sorted notes of the open diff, for per-frame drawing
function notesCached() { const k = map ? notesKey() : ""; if (!notesMemo || notesMemo.k !== k) notesMemo = { k, list: map ? loadNotes().sort((a, b) => a.t - b.t) : [] }; return notesMemo.list; }
function notesNear(t) { const L = notesCached(); for (let i = L.length - 1; i >= 0; i--) { const n = L[i]; if (n.t <= t + 120 && t - n.t < 1500) return n; if (n.t < t - 1500) break; } return null; }
// the user's own prefix/suffix around every copied note; {diff} and {type} are filled in
function noteLine(n) {
  const fill = s => s.replace(/\{diff\}/g, map.meta.Version || "").replace(/\{type\}/g, tr((NOTE_TYPES.find(x => x[0] === n.type) || ["", "Note"])[1])).replace(/\{cat\}/g, catOf(n.cat) ? catName(catOf(n.cat)) : "");
  return `${fill(S.notePrefix)}${n.ts} - ${n.text}${fill(S.noteSuffix)}`;
}
let notePrefill = null;
function addNoteFrom(t, objs) { // from the editor's "+ Note" button
  notePrefill = { t, ts: objs.length ? tsFor(objs) : `${fmtMs(t)} - ` };
  if (EDIT.on) edTab("notes"); else { toolsTab = "notes"; openTools(); }
  setTimeout(() => { const ta = document.querySelector(".nform textarea"); ta && ta.focus(); }, 50);
}
// ---------- mod notes import / export (JSON file, JSON/URL/text paste, link with the notes packed in) ----------
const NOTES_FMT = "osu-beatmap-viewer/mod-notes";
function notesPayload(list) {
  const M = map.meta;
  return { format: NOTES_FMT, version: 1, map: { artist: M.Artist || "", title: M.Title || "", creator: M.Creator || "", version: M.Version || "", beatmapId: +M.BeatmapID || null, beatmapSetId: +M.BeatmapSetID || (+setId || null) },
    exported: new Date().toISOString(), notes: list.map(n => Object.assign({ t: n.t, ts: n.ts, type: n.type }, catOf(n.cat) ? { cat: catName(catOf(n.cat)) } : {}, { text: n.text }, n.reply ? { reply: n.reply } : {})) };
}
// what: "notes" | "annotations" | "both" (one file format; import reads whichever parts it has)
function exportNotesFile(what = "notes") {
  const list = what === "annotations" ? [] : loadNotes().sort((a, b) => a.t - b.t), anns = what === "notes" ? [] : annPayload();
  if (!list.length && !anns.length) return toast(what === "annotations" ? tr("No annotations to export") : tr("No notes to export"));
  const M = map.meta, label = { notes: "mod notes", annotations: "annotations", both: "mod notes + annotations" }[what];
  const name = `${M.Artist} - ${M.Title} [${M.Version}] ${label}.json`.replace(/[\\/:*?"<>|]+/g, "_");
  const payload = notesPayload(list); if (what !== "notes") payload.annotations = anns;
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), name);
}
const tsToMs = s => { const m = String(s).match(/(\d+):(\d{2}):(\d{3})/); return m ? +m[1] * 60000 + +m[2] * 1000 + +m[3] : null; };
// accepts our JSON, a bare array of notes, or osu!-style lines "00:12:345 (1,2) - text"
function parseNotes(text) {
  text = String(text).trim();
  if (/^(\{|\[\s*[[{\]])/.test(text)) { // (not "[Visual]", a category heading in text)
    const j = JSON.parse(text), arr = Array.isArray(j) ? j : Array.isArray(j.notes) ? j.notes : null, anns = j && Array.isArray(j.annotations) ? j.annotations : [];
    if (!arr && !anns.length) throw new Error(tr("No notes found in this data"));
    return { map: j.map || null, notes: arr || [], annotations: anns };
  }
  const notes = []; let cat = "";
  for (const line of text.split(/\r?\n/)) {
    const hd = line.match(/^\s*(?:#+\s*)?\[([^\]]{1,40})\]\s*:?\s*$/); if (hd) { cat = hd[1].trim(); continue; } // "[Visual]" heads the notes under it
    const m = line.match(/^\s*(?:[-*•]\s*)?(?:\[(\w+)\]\s*)?(\d{2,}:\d{2}:\d{3})\s*(\([^)]*\))?\s*-?\s*(.*)$/);
    if (m) notes.push({ t: tsToMs(m[2]), ts: m[2] + (m[3] ? " " + m[3] : ""), type: (m[1] || "note").toLowerCase(), cat, text: m[4] });
  }
  if (!notes.length) throw new Error(tr("No notes found in this data"));
  return { map: null, notes };
}
const cleanNote = (n, i) => {
  const t = typeof n.t === "number" && isFinite(n.t) ? Math.max(0, Math.round(n.t)) : tsToMs(n.ts);
  if (t == null || typeof n.text !== "string" || !n.text.trim()) return null;
  const c = { id: Date.now() + i, t, ts: String(n.ts || fmtMs(t)).slice(0, 80), type: NOTE_TYPES.some(x => x[0] === n.type) ? n.type : "note", text: n.text.trim().slice(0, 2000) };
  const cat = typeof n.cat === "string" && n.cat.trim() ? noteCatAdd(n.cat) : null; if (cat) c.cat = cat.id; // by name (ids differ between people)
  const r = cleanReply(n.reply); if (r) c.reply = r;
  return c;
};
async function importNotes(data, from) {
  const src = data.map, M = map.meta;
  if (src && ((src.beatmapId && +M.BeatmapID > 0 && +src.beatmapId !== +M.BeatmapID) || (!src.beatmapId && src.version && src.version !== M.Version)))
    if (!(await ask(tr("These notes are for [{v}], but [{cur}] is open. Import them anyway?", { v: src.version || src.beatmapId, cur: M.Version }), { ok: tr("Import anyway") }))) return 0;
  const all = loadNotes(), seen = new Set(all.map(n => n.t + "|" + n.text));
  let added = 0;
  let replies = 0;
  data.notes.slice(0, 5000).forEach((n, i) => {
    const c = cleanNote(n, i); if (!c) return;
    if (!seen.has(c.t + "|" + c.text)) { all.push(c); seen.add(c.t + "|" + c.text); added++; return; }
    // the same note again with the mapper's answer (they sent their notes back): take the answer
    const x = all.find(y => y.t === c.t && y.text === c.text);
    if (c.reply && x && JSON.stringify(x.reply || null) !== JSON.stringify(c.reply)) { x.reply = c.reply; replies++; }
  });
  saveNotes(all);
  const nAnn = data.annotations && data.annotations.length ? annImportList(data.annotations) : 0;
  toast(tr("Imported {n} notes", { n: added }) + (replies ? " · " + tr("{n} answers", { n: replies }) : "") + (nAnn ? " · " + tr("{n} annotations", { n: nAnn }) : "") + (from ? " · " + from : ""), 2500);
  rerenderNotes();
  return added;
}
function rawURL(u) { // gist / pastebin page -> raw text
  let m;
  if ((m = u.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?$/i))) return `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`;
  if ((m = u.match(/^https?:\/\/pastebin\.com\/(?!raw\/)(\w+)\/?$/i))) return `https://pastebin.com/raw/${m[1]}`;
  return u;
}
async function importNotesFrom(input) {
  input = String(input || "").trim(); if (!input) return;
  try {
    if (!/^https?:\/\//i.test(input)) return await importNotes(parseNotes(input));
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 12000);
    let r; try { r = await fetch(rawURL(input), { signal: ctl.signal }); } finally { clearTimeout(tm); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await importNotes(parseNotes(await r.text()), new URL(input).hostname);
  } catch (e) { toast(tr("Couldn't import notes: {err}", { err: e.name === "AbortError" ? tr("timed out") : e.name === "TypeError" ? tr("the site doesn't allow loading from other websites (CORS); download the file and import it instead") : e.message }), 5000); }
}
// notes packed into the link itself (#n=...), deflated when the browser can
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function packNotes(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === "undefined") return "j." + b64u(raw);
  const buf = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
  return "z." + b64u(new Uint8Array(buf));
}
async function unpackNotes(s) {
  const [kind, data] = [s.slice(0, 2), s.slice(2)], bytes = unb64u(data);
  if (kind === "j.") return new TextDecoder().decode(bytes);
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
  return new TextDecoder().decode(buf);
}
async function copyNotesLink() {
  const list = loadNotes().sort((a, b) => a.t - b.t), anns = annPayload();
  if (!list.length && !anns.length) return toast(tr("No notes to export"));
  const base = shareURL(); if (!base) return toast(tr("This file has no beatmap ID, so it can't be shared as a link"));
  const p = notesPayload(list); delete p.exported; if (anns.length) p.annotations = anns;
  const url = base + "#n=" + await packNotes(p);
  toast(await copyText(url) ? tr("Link with {n} notes copied", { n: list.length }) : url, 2500);
}
// called once the map from a shared link is open
let pendingNotes = null;
async function applyPendingNotes() {
  const p = pendingNotes; pendingNotes = null; if (!p || !map) return;
  try {
    const text = p.hash ? await unpackNotes(p.hash) : null;
    if (text) { const d = parseNotes(text); if ((await ask(tr("This link has {n} mod notes. Import them?", { n: d.notes.length }), { ok: tr("Import") }))) importNotes(d, tr("link")); }
    else if (p.url && (await ask(tr("Import mod notes from {u}?", { u: p.url }), { ok: tr("Import") }))) await importNotesFrom(p.url);
  } catch (e) { toast(tr("Couldn't import notes: {err}", { err: e.message }), 4000); }
  if (p.hash) history.replaceState(history.state, "", location.pathname + location.search);
}
// ---------- answering a mod (the mapper): each note fixed / partly / not fixed, with an optional reason ----------
// Kept on the note ({ st, why }), exported with it (so the modder can import the answers back) and copied as a reply.
const REPLY_ST = [["fixed", "Fixed", "fixed", "✔"], ["partly", "Partly", "partially fixed", "◐"], ["no", "Not fixed", "not fixed", "✘"]];
function cleanReply(r) {
  if (!r || typeof r !== "object" || !REPLY_ST.some(x => x[0] === r.st)) return null;
  const why = typeof r.why === "string" ? r.why.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  return why ? { st: r.st, why } : { st: r.st };
}
function setReply(id, patch) {
  const L = loadNotes(), x = L.find(y => y.id === id); if (!x) return;
  const r = patch === null ? null : cleanReply(Object.assign({}, x.reply, patch));
  if (r) x.reply = r; else delete x.reply;
  saveNotes(L);
}
// one line per answered note (in English, like the discussion): "00:12:345 (1) - fixed", or with the mod's text quoted
function replyText(list) {
  const done = list.filter(n => n.reply); if (!done.length) return "";
  const line = n => { const [, , word] = REPLY_ST.find(x => x[0] === n.reply.st), ans = word + (n.reply.why ? ": " + n.reply.why : "");
    return S.replyQuote ? `${n.ts} - ${n.text}\n  → ${ans}` : `${n.ts} - ${ans}`; };
  if (!done.some(n => catOf(n.cat))) return done.map(line).join("\n");
  const groups = [["", done.filter(n => !catOf(n.cat))], ...noteCats().map(c => [catName(c), done.filter(n => n.cat === c.id)])].filter(g => g[1].length);
  return groups.map(([name, L]) => (name ? `[${name}]\n` : "") + L.map(line).join("\n")).join("\n\n");
}
function replyBox(n) {
  const box = h("div", "nreply" + (n.reply ? " " + n.reply.st : ""));
  for (const [st, label, , icon] of REPLY_ST) {
    const b = h("button", "rst " + st + (n.reply && n.reply.st === st ? " on" : ""), icon + " " + tr(label)); b.type = "button";
    b.onclick = () => { setReply(n.id, n.reply && n.reply.st === st ? null : { st }); rerenderNotes(); };
    box.append(b);
  }
  if (n.reply) {
    const why = h("input"); why.type = "text"; why.maxLength = 500; why.value = n.reply.why || "";
    why.placeholder = n.reply.st === "fixed" ? tr("What you changed (optional)") : tr("Why (optional)");
    why.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") why.blur(); });
    why.onchange = () => setReply(n.id, { why: why.value });
    box.append(why);
  }
  return box;
}

// notes as text for the discussion; with categories, grouped under "[Name]" lines in the categories' order
function notesText(list) {
  if (!list.some(n => catOf(n.cat))) return list.map(noteLine).join("\n");
  const groups = [["", list.filter(n => !catOf(n.cat))], ...noteCats().map(c => [catName(c), list.filter(n => n.cat === c.id)])].filter(g => g[1].length);
  return groups.map(([name, L]) => (name ? `[${name}]\n` : "") + L.map(noteLine).join("\n")).join("\n\n");
}
function rerenderNotes() { if (EDIT.on && EDIT.tab === "notes") edTab("notes"); else renderTools(); }
function renderNotes(body) {
  body.append(annPanel());
  const all0 = loadNotes().sort((a, b) => a.t - b.t);
  if (S.noteCat && S.noteCat !== "-" && !catOf(S.noteCat)) S.noteCat = "";
  const inCat = n => !S.noteCat || (S.noteCat === "-" ? !catOf(n.cat) : n.cat === S.noteCat);
  const list = all0.filter(inCat);
  // category chips: All, each category (with its count), + new; the open one can be renamed or deleted
  const cats = h("div", "ncats"), pick = id => { S.noteCat = id; save(); rerenderNotes(); };
  const chip = (id, label, n) => { const b = h("button", "ncat" + ((S.noteCat || "") === id ? " on" : ""), label); if (n) b.append(h("small", null, String(n))); b.type = "button"; b.onclick = () => pick(id); cats.append(b); };
  chip("", tr("All"), all0.length);
  for (const c of noteCats()) chip(c.id, catName(c), all0.filter(n => n.cat === c.id).length);
  const loose = all0.filter(n => !catOf(n.cat)).length;
  if (loose && all0.length > loose) chip("-", tr("No category"), loose);
  const addC = h("button", "ncat add", "+"); addC.type = "button"; addC.title = tr("New category"); addC.setAttribute("aria-label", tr("New category"));
  addC.onclick = async () => { const c = noteCatAdd((await askText(tr("Name of the new category (e.g. General, Visual, Hitsound)"))) || ""); if (c) { S.noteCatNew = c.id; pick(c.id); } };
  cats.append(addC);
  const cur = catOf(S.noteCat);
  if (cur) {
    const ren = h("button", "mlink", tr("Rename")), delc = h("button", "mlink", tr("Delete category"));
    ren.onclick = async () => { const v = ((await askText(tr("New name"), catName(cur))) || "").replace(/\s+/g, " ").trim().slice(0, 40); if (v) { cur.name = v; save(); rerenderNotes(); } };
    delc.onclick = async () => {
      if (!(await ask(tr("Delete the category \"{c}\"? Its notes are kept, without a category.", { c: catName(cur) }), { ok: tr("Delete"), danger: true }))) return;
      S.noteCats = noteCats().filter(c => c !== cur); if (S.noteCatNew === cur.id) S.noteCatNew = "";
      const L = loadNotes(); let ch = false; for (const n of L) if (n.cat === cur.id) { delete n.cat; ch = true; }
      if (ch) saveNotes(L); pick("");
    };
    const ed = h("span", "ncated"); ed.append(ren, delc); cats.append(ed);
  }
  body.append(cats);
  const form = h("div", "nform");
  const ts = h("input"); ts.type = "text"; ts.value = notePrefill ? notePrefill.ts.replace(/ - $/, "") : tsAt(A.cur()).replace(/ - $/, ""); ts.setAttribute("aria-label", "timestamp");
  const typ = h("select"); NOTE_TYPES.forEach(([k, l]) => typ.add(new Option(tr(l), k)));
  let newCat = noteCatNew(); const csel = noteCatSelect(newCat, v => { newCat = v; });
  const ta = h("textarea"); ta.placeholder = tr("Write your mod here, e.g. the jump here is much bigger than the music suggests"); ta.setAttribute("aria-label", ta.placeholder);
  const addB = h("button", "btn main sm", tr("Add note"));
  const noteT = notePrefill ? notePrefill.t : A.cur();
  addB.onclick = () => {
    if (!ta.value.trim()) { ta.focus(); return; }
    const all = loadNotes(), n = { id: Date.now(), t: Math.round(noteT), ts: ts.value.trim(), type: typ.value, text: ta.value.trim() };
    if (catOf(newCat)) n.cat = newCat; S.noteCatNew = newCat; save();
    all.push(n); saveNotes(all); notePrefill = null; rerenderNotes(); toast(tr("Note added"));
  };
  const r1 = h("div", "nrow"); r1.append(ts, typ, csel);
  form.append(r1, ta, addB);
  body.append(form);
  // copy format
  const fmtBox = h("div", "notefmt"), pre = h("input"), suf = h("input"), ex = h("div", "ex");
  pre.type = suf.type = "text"; pre.value = S.notePrefix; suf.value = S.noteSuffix; pre.placeholder = suf.placeholder = tr("(empty)");
  const showEx = () => { ex.textContent = tr("Example") + ": " + noteLine({ ts: "00:12:345 (1,2)", text: tr("text of the note"), type: "suggestion", cat: noteCats()[0] && noteCats()[0].id }); };
  pre.oninput = () => { S.notePrefix = pre.value; save(); showEx(); };
  suf.oninput = () => { S.noteSuffix = suf.value; save(); showEx(); };
  fmtBox.append(h("span", null, tr("Prefix")), pre, h("span", null, tr("Suffix")), suf, ex);
  showEx();
  const fmtD = h("details"); fmtD.append(h("summary", "mlink", tr("Copy format (prefix / suffix, may use {diff} {type} {cat})")), fmtBox);
  body.append(fmtD);
  // import / export
  const io = h("details", "notesio"); io.append(h("summary", "mlink", tr("Import / export notes (JSON, URL, link)")));
  const ioBox = h("div", "iobox"), ioR1 = h("div", "btnrow");
  const bx = (txt, fn) => { const b = h("button", "btn ghost sm", tr(txt)); b.onclick = fn; ioR1.append(b); return b; };
  bx("Export notes .json", () => exportNotesFile("notes"));
  bx("Export annotations .json", () => exportNotesFile("annotations"));
  bx("Export notes + annotations .json", () => exportNotesFile("both"));
  bx("Copy JSON", async () => { const L = loadNotes(); if (!L.length) return toast(tr("No notes to export")); toast(await copyText(JSON.stringify(notesPayload(L.sort((a, b) => a.t - b.t)), null, 2)) ? tr("Copied") : tr("Couldn't copy")); });
  bx("Copy link with notes", copyNotesLink);
  const file = h("input"); file.type = "file"; file.accept = ".json,.txt,application/json,text/plain"; file.hidden = true;
  file.onchange = async () => { const f = file.files[0]; file.value = ""; if (!f) return; try { await importNotes(parseNotes(await f.text()), f.name); } catch (e) { toast(tr("Couldn't import notes: {err}", { err: e.message }), 4000); } };
  bx("Import .json file", () => file.click());
  const ioR2 = h("div", "nrow"), inp = h("input"), go = h("button", "btn main sm", tr("Import"));
  inp.type = "text"; inp.placeholder = tr("Paste a URL (gist, pastebin, raw .json), JSON, or lines like 00:12:345 (1) - text"); inp.setAttribute("aria-label", inp.placeholder);
  go.onclick = () => importNotesFrom(inp.value).then(() => { inp.value = ""; });
  inp.addEventListener("keydown", e => { if (e.key === "Enter") go.click(); e.stopPropagation(); });
  ioR2.append(inp, go);
  ioBox.append(ioR1, file, ioR2, h("p", "hint", tr("Imported notes are merged with yours (duplicates are skipped). A link with notes opens this map and offers to import them. Map links also accept &notes=<url of a .json>.")));
  io.append(ioBox); body.append(io);
  const acts = h("div", "btnrow");
  const cp = h("button", "btn ghost sm", tr("Copy all (paste into the discussion)")), clr = h("button", "btn ghost sm", tr("Delete all"));
  cp.disabled = clr.disabled = !list.length;
  cp.onclick = async () => toast(await copyText(notesText(list)) ? tr("Copied {n} notes", { n: list.length }) : tr("Couldn't copy"));
  // the same, with the annotations that have text as extra lines (time order)
  const cpa = h("button", "btn ghost sm", tr("Copy notes + annotations"));
  const annLines = () => annPayload().filter(a => a.body).map(a => ({ t: a.time_ms, line: noteLine({ ts: a.ts, text: `${ANN_ICON[a.kind]} ${a.body}`, type: "note" }) }));
  cpa.disabled = !list.length && !annLines().length;
  cpa.onclick = async () => { const rows = [...list.map(n => ({ t: n.t, line: noteLine(n) })), ...annLines()].sort((a, b) => a.t - b.t); toast(await copyText(rows.map(r => r.line).join("\n")) ? tr("Copied {n} lines", { n: rows.length }) : tr("Couldn't copy")); };
  clr.onclick = async () => {
    if (!S.noteCat) { if ((await ask(tr("Delete all notes of this difficulty?"), { ok: tr("Delete"), danger: true }))) { saveNotes([]); rerenderNotes(); } return; }
    if ((await ask(tr("Delete the {n} notes in \"{c}\"?", { n: list.length, c: catName(cur) }), { ok: tr("Delete"), danger: true }))) { saveNotes(loadNotes().filter(n => !inCat(n))); rerenderNotes(); }
  };
  acts.append(cp, cpa, clr); body.append(acts);
  // answering the mod: how many are answered, and the reply to paste into the discussion
  if (list.length) {
    const nAns = list.filter(n => n.reply).length, rep = h("div", "nreplybar");
    const bar = h("span", "nprog"); bar.append(h("b", null, tr("Answered {a} of {n}", { a: nAns, n: list.length })));
    const meter = h("i"); meter.style.setProperty("--p", (nAns / list.length * 100).toFixed(1) + "%"); bar.append(meter);
    const cr = h("button", "btn ghost sm", tr("Copy reply")); cr.disabled = !nAns;
    cr.onclick = async () => toast(await copyText(replyText(list)) ? tr("Copied the reply ({n} answers)", { n: nAns }) : tr("Couldn't copy"));
    const q = h("label", "nquote"), qi = h("input"); qi.type = "checkbox"; qi.checked = !!S.replyQuote; qi.onchange = () => { S.replyQuote = qi.checked; save(); };
    q.append(qi, h("span", null, tr("Quote the mod in the reply")));
    rep.append(bar, cr, q); body.append(rep);
  }
  if (!all0.length) body.append(h("p", "hint", tr("No notes yet • In Modding mode tap an object and press \"+ Note\" to fill in the timestamp")));
  else if (!list.length) body.append(h("p", "hint", tr("No notes in this category yet")));
  const box = h("div", "tlist");
  for (const n of list) {
    const el = h("div", "note " + n.type), hd = h("div", "nh");
    const go = h("button", "mlink", n.ts); go.dataset.t = n.t; go.dataset.go = "1";
    const cp1 = h("button", "mlink", tr("Copy")); cp1.onclick = async () => toast(await copyText(noteLine(n)) ? tr("Copied") : tr("Couldn't copy"));
    const del = h("button", "mlink", tr("Delete")); del.onclick = () => { saveNotes(loadNotes().filter(x => x.id !== n.id)); rerenderNotes(); };
    const cs = noteCatSelect(n.cat, v => { const L = loadNotes(), x = L.find(y => y.id === n.id); if (!x) return; if (v) x.cat = v; else delete x.cat; saveNotes(L); rerenderNotes(); });
    hd.append(go, h("span", null, tr((NOTE_TYPES.find(x => x[0] === n.type) || ["", "Note"])[1])), cs, cp1, del);
    if (n.reply) el.classList.add("answered");
    el.append(hd, h("p", null, n.text), replyBox(n)); box.append(el);
  }
  body.append(box);
}
addEventListener("langchange", () => { buildToolTabs(); renderTools(); });
