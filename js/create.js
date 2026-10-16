"use strict";
// ============ new beatmap (like osu!'s "new beatmap" song setup) + the editor's Setup tab ============
// Everything is built in the browser: the song/background files and a fresh .osu become an in-memory package
// (blobEntry) that opens straight in Modding mode. Nothing is uploaded.
const SETUP_META = [["Artist", "Artist (romanised)"], ["ArtistUnicode", "Artist (original language)"], ["Title", "Title (romanised)"], ["TitleUnicode", "Title (original language)"],
  ["Creator", "Creator"], ["Version", "Difficulty name"], ["Source", "Source"], ["Tags", "Tags"]];
const SETUP_DIFF = [["HPDrainRate", "HP drain rate", 0, 10, .1, 5], ["CircleSize", "Circle size", 0, 10, .1, 4], ["ApproachRate", "Approach rate", 0, 10, .1, 9], ["OverallDifficulty", "Overall difficulty", 0, 10, .1, 8],
  ["SliderMultiplier", "Slider velocity", .4, 3.6, .01, 1.4]];
const TICK_RATES = [.5, 1, 2, 3, 4];
const SETS3 = [["Normal", "Normal"], ["Soft", "Soft"], ["Drum", "Drum"]];
const isAscii = s => /^[\x20-\x7e]*$/.test(s);
// helpers that build labelled inputs bound to a plain object
function tIn(obj, k, label, opts = {}) {
  const r = h("label", "cf"), i = h(opts.area ? "textarea" : "input");
  if (!opts.area) i.type = opts.type || "text";
  i.value = obj[k] ?? ""; if (opts.ph) i.placeholder = tr(opts.ph); if (opts.max) i.maxLength = opts.max;
  const warn = h("small", "cwarn");
  const chk = () => { warn.textContent = opts.ascii && !isAscii(i.value) ? tr("Only latin letters, numbers and symbols here (osu! rule); put the original in the next field") : ""; };
  i.oninput = () => { obj[k] = opts.type === "number" ? +i.value : i.value; chk(); opts.on && opts.on(); };
  chk(); r.append(h("span", null, tr(label)), i, warn); return r;
}
function rIn(obj, k, label, min, max, step, info) {
  const r = h("label", "cf rng2"), i = h("input"), o = h("output"), sm = h("small", "cinfo");
  i.type = "range"; i.min = min; i.max = max; i.step = step; i.value = obj[k];
  const show = () => { o.textContent = (+obj[k]).toFixed(step < .1 ? 2 : 1).replace(/\.0+$/, ""); sm.textContent = info ? info(+obj[k]) : ""; };
  i.oninput = () => { obj[k] = +i.value; show(); };
  show(); const top = h("span", "cft"); top.append(h("span", null, tr(label)), o); r.append(top, i, sm); return r;
}
function sIn(obj, k, label, opts) {
  const r = h("label", "cf"), s = h("select");
  for (const [v, l] of opts) s.add(new Option(tr(l), v));
  s.value = String(obj[k]); s.onchange = () => { obj[k] = isNaN(+s.value) || s.value === "" ? s.value : +s.value; };
  r.append(h("span", null, tr(label)), s); return r;
}
function bIn(obj, k, label, hint) {
  const r = h("label", "sw"), t = h("span", "swt"), i = h("input");
  t.append(h("b", null, tr(label))); if (hint) t.append(h("small", null, tr(hint)));
  i.type = "checkbox"; i.className = "switch"; i.checked = !!+obj[k]; i.onchange = () => { obj[k] = i.checked ? 1 : 0; };
  r.append(t, i); return r;
}
const arInfo = v => { const p = v < 5 ? 1200 + 600 * (5 - v) / 5 : 1200 - 750 * (v - 5) / 5; return tr("objects appear {ms} ms early", { ms: Math.round(p) }); };
const csInfo = v => tr("circle radius {r} osu!px", { r: (54.4 - 4.48 * v).toFixed(1) });
const odInfo = v => `300: ±${(80 - 6 * v).toFixed(1)} ms`;
const DIFF_INFO = { ApproachRate: arInfo, CircleSize: csInfo, OverallDifficulty: odInfo };

// ---------- create page ----------
const CR = { audio: null, bg: null, meta: { Artist: "", ArtistUnicode: "", Title: "", TitleUnicode: "", Creator: "", Version: "Normal", Source: "", Tags: "" },
  diff: { HPDrainRate: 5, CircleSize: 4, ApproachRate: 9, OverallDifficulty: 8, SliderMultiplier: 1.4, SliderTickRate: 1 },
  gen: { AudioLeadIn: 0, SampleSet: "Soft", StackLeniency: .7, Countdown: 0, EpilepsyWarning: 0, WidescreenStoryboard: 1, LetterboxInBreaks: 0 },
  tm: { bpm: 120, offset: 0, meter: 4, volume: 70 }, info: null, url: "", el: null };
function crPlayer() { if (!CR.el) { CR.el = new Audio(); CR.el.preload = "auto"; } return CR.el; }
function renderCreate() {
  const box = $("create"); box.innerHTML = "";
  if (!CR.meta.Creator && AUTH.user) CR.meta.Creator = AUTH.user.username;
  const head = h("div", "vhead"), back = h("a", "btn ghost sm", "← " + tr("Editor")); back.href = "?view=editor"; back.dataset.go = "editor";
  head.append(back, h("h2", null, tr("Create a new beatmap")), h("p", null, tr("Like osu!'s new beatmap setup. Everything stays in your browser until you export the .osz.")));
  box.append(head);
  const form = h("form", "cform"); form.onsubmit = e => { e.preventDefault(); createNow(); };
  const step = (n, title, ...kids) => { const s2 = h("section", "cstep"); s2.style.setProperty("--i", n); s2.append(h("h3", null, `${n}. ${tr(title)}`), ...kids); form.append(s2); return s2; };
  // 1. song
  const drop = h("div", "cdrop"), pick = h("input"); pick.type = "file"; pick.accept = "audio/mpeg,audio/ogg,.mp3,.ogg"; pick.hidden = true;
  const dTxt = h("div", "cdt"), play = h("button", "btn ghost sm"), tm = h("span", "ctime");
  play.type = "button"; play.textContent = tr("▶ Play"); play.hidden = !CR.audio;
  const showAudio = () => {
    dTxt.innerHTML = "";
    if (!CR.audio) { dTxt.append(h("b", null, tr("Drop the song here or tap to choose")), h("small", null, tr("MP3 or OGG • ranked maps need 128–192 kbps (MP3) or up to 208 kbps (OGG)"))); return; }
    const a = CR.info || {}, br = a.kbps ? Math.round(a.kbps) + " kbps" : "";
    dTxt.append(h("b", null, CR.audio.name), h("small", null, [fmtBytes(CR.audio.size), a.fmt, br, a.dur ? fmt(a.dur) : ""].filter(Boolean).join(" • ")));
    if (a.kbps && (a.kbps < 128 || a.kbps > (/ogg/i.test(a.fmt || "") ? 208 : 192) + 1)) dTxt.append(h("small", "cwarn", tr("Outside the ranked range 128–{max} kbps", { max: /ogg/i.test(a.fmt || "") ? 208 : 192 })));
  };
  const setAudio = async f => {
    if (!f) return; if (!/\.(mp3|ogg)$/i.test(f.name) && !/^audio\//.test(f.type)) return toast(tr("Pick an MP3 or OGG file"));
    CR.audio = f; CR.info = analyzeAudio(await f.arrayBuffer());
    const el = crPlayer(); if (CR.url) URL.revokeObjectURL(CR.url); CR.url = URL.createObjectURL(f); el.src = CR.url;
    const id3 = CR.info.id3 || {};
    if (id3.title && !CR.meta.TitleUnicode) { CR.meta.TitleUnicode = id3.title; if (!CR.meta.Title && isAscii(id3.title)) CR.meta.Title = id3.title; }
    if (id3.artist && !CR.meta.ArtistUnicode) { CR.meta.ArtistUnicode = id3.artist; if (!CR.meta.Artist && isAscii(id3.artist)) CR.meta.Artist = id3.artist; }
    renderCreate();
  };
  drop.onclick = e => { if (!e.target.closest("button")) pick.click(); };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove("over"); dragN = 0; $("drop").hidden = true; setAudio(e.dataTransfer.files[0]); };
  pick.onchange = () => setAudio(pick.files[0]);
  const el = crPlayer();
  play.onclick = () => { if (el.paused) { el.volume = musGain(); el.play().catch(() => {}); } else el.pause(); };
  el.onplay = () => { play.textContent = tr("❚❚ Pause"); tick(); };
  el.onpause = () => { play.textContent = tr("▶ Play"); };
  const tick = () => { tm.textContent = fmtMs(el.currentTime * 1000); if (!el.paused && tm.isConnected) requestAnimationFrame(tick); };
  const pr = h("div", "crow"); pr.append(play, tm);
  showAudio(); drop.append(dTxt, pick); step(1, "Song", drop, pr);
  // 2. metadata
  const mg = h("div", "cgrid");
  for (const [k, l] of SETUP_META) mg.append(tIn(CR.meta, k, l, { ascii: k === "Artist" || k === "Title", max: k === "Tags" ? 1000 : 200, area: k === "Tags" }));
  step(2, "Metadata", mg);
  // 3. difficulty
  const dg = h("div", "cgrid");
  for (const [k, l, mn, mx, st] of SETUP_DIFF) dg.append(rIn(CR.diff, k, l, mn, mx, st, DIFF_INFO[k]));
  dg.append(sIn(CR.diff, "SliderTickRate", "Slider tick rate", TICK_RATES.map(v => [v, String(v)])));
  step(3, "Difficulty", dg);
  // 4. timing
  const tg = h("div", "cgrid");
  tg.append(tIn(CR.tm, "bpm", "BPM", { type: "number" }), tIn(CR.tm, "offset", "Offset (ms, first beat)", { type: "number" }),
    sIn(CR.tm, "meter", "Time signature", [[4, "4/4"], [3, "3/4"], [5, "5/4"], [6, "6/4"], [7, "7/4"]]), sIn(CR.gen, "SampleSet", "Sample set", SETS3),
    rIn(CR.tm, "volume", "Hitsound volume", 5, 100, 1, v => v + "%"));
  const tapRow = h("div", "crow"), tap = h("button", "btn ghost"), tapOut = h("span", "ctime", "–"), useOff = h("button", "btn ghost sm", tr("Offset = current song time"));
  tap.type = useOff.type = "button"; tap.textContent = tr("Tap BPM"); const taps = [];
  tap.onclick = () => {
    const now = performance.now(); if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0; taps.push(now); if (taps.length > 24) taps.shift();
    if (taps.length > 3) { const bpm = Math.round(60000 * (taps.length - 1) / (taps[taps.length - 1] - taps[0])); tapOut.textContent = bpm + " BPM"; CR.tm.bpm = bpm; const inp = tg.querySelector("input[type=number]"); if (inp) inp.value = bpm; }
    else tapOut.textContent = tr("keep tapping…");
  };
  useOff.onclick = () => { CR.tm.offset = Math.round(el.currentTime * 1000); tg.querySelectorAll("input[type=number]")[1].value = CR.tm.offset; };
  tapRow.append(tap, tapOut, useOff);
  step(4, "Timing", tg, tapRow, h("p", "hint", tr("Play the song and tap along to find the BPM. You can fine-tune the timing later in the Timing tab (with the metronome).")));
  // 5. design
  const bgRow = h("div", "cbg"), bgPick = h("input"), bgBtn = h("button", "btn ghost sm", tr(CR.bg ? "Change background" : "Choose a background image")), bgImg = h("div", "cbgimg");
  bgPick.type = "file"; bgPick.accept = "image/jpeg,image/png,.jpg,.jpeg,.png"; bgPick.hidden = true; bgBtn.type = "button";
  bgBtn.onclick = () => bgPick.click(); bgPick.onchange = () => { const f = bgPick.files[0]; if (f) { CR.bg = f; renderCreate(); } };
  if (CR.bg) { const u = URL.createObjectURL(CR.bg); bgImg.style.backgroundImage = `url("${u}")`; setTimeout(() => URL.revokeObjectURL(u), 60000); }
  bgRow.append(bgImg, bgBtn, bgPick);
  const sg = h("div", "card2");
  sg.append(bIn(CR.gen, "WidescreenStoryboard", "Widescreen support"), bIn(CR.gen, "Countdown", "Countdown"), bIn(CR.gen, "EpilepsyWarning", "Epilepsy warning", "For flashing storyboards/videos"), bIn(CR.gen, "LetterboxInBreaks", "Letterbox during breaks"));
  const dg2 = h("div", "cgrid");
  dg2.append(rIn(CR.gen, "StackLeniency", "Stack leniency", .2, 1, .1), tIn(CR.gen, "AudioLeadIn", "Audio lead-in (ms)", { type: "number" }));
  step(5, "Design", bgRow, sg, dg2);
  const go = h("div", "cgo"), sub = h("button", "btn main", tr("Create and open in the editor")); sub.type = "submit";
  go.append(sub); form.append(go); box.append(form);
}
function osuTemplate(o) { // a fresh osu file format v14 difficulty
  const g = o.gen, m = o.meta, d = o.diff;
  const sset = { Normal: 1, Soft: 2, Drum: 3 }[g.SampleSet] || 2;
  const L = ["osu file format v14", "", "[General]", `AudioFilename: ${o.audioName}`, `AudioLeadIn: ${Math.round(+g.AudioLeadIn || 0)}`, "PreviewTime: -1", `Countdown: ${+g.Countdown ? 1 : 0}`, `SampleSet: ${g.SampleSet}`,
    `StackLeniency: ${g.StackLeniency}`, "Mode: 0", `LetterboxInBreaks: ${+g.LetterboxInBreaks ? 1 : 0}`, ...(+g.EpilepsyWarning ? ["EpilepsyWarning: 1"] : []), `WidescreenStoryboard: ${+g.WidescreenStoryboard ? 1 : 0}`, "",
    "[Editor]", "DistanceSpacing: 1", "BeatDivisor: 4", "GridSize: 32", "TimelineZoom: 1", "",
    "[Metadata]", `Title:${m.Title}`, `TitleUnicode:${m.TitleUnicode || m.Title}`, `Artist:${m.Artist}`, `ArtistUnicode:${m.ArtistUnicode || m.Artist}`, `Creator:${m.Creator}`, `Version:${m.Version}`,
    `Source:${m.Source}`, `Tags:${String(m.Tags).replace(/\s+/g, " ").trim()}`, "BeatmapID:0", "BeatmapSetID:-1", "",
    "[Difficulty]", `HPDrainRate:${d.HPDrainRate}`, `CircleSize:${d.CircleSize}`, `OverallDifficulty:${d.OverallDifficulty}`, `ApproachRate:${d.ApproachRate}`, `SliderMultiplier:${d.SliderMultiplier}`, `SliderTickRate:${d.SliderTickRate}`, "",
    "[Events]", "//Background and Video events", ...(o.bgName ? [`0,0,"${o.bgName}",0,0`] : []), "//Break Periods", "//Storyboard Layer 0 (Background)", "//Storyboard Layer 1 (Fail)", "//Storyboard Layer 2 (Pass)", "//Storyboard Layer 3 (Foreground)", "//Storyboard Layer 4 (Overlay)", "//Storyboard Sound Samples", "",
    "[TimingPoints]", `${Math.round(o.offset)},${60000 / o.bpm},${o.meter},${sset},0,${Math.round(o.volume)},1,0`, "", "",
    "[HitObjects]", ""];
  return L.join("\r\n");
}
async function createNow() {
  const m = CR.meta, need = [];
  if (!CR.audio) need.push(tr("a song file"));
  for (const k of ["Artist", "Title", "Creator", "Version"]) if (!String(m[k] || "").trim()) need.push(tr(SETUP_META.find(x => x[0] === k)[1]));
  if (!(CR.tm.bpm > 0)) need.push("BPM");
  if (need.length) return toast(tr("Please fill in: {list}", { list: need.join(", ") }), 4000);
  if (!isAscii(m.Artist) || !isAscii(m.Title)) return toast(tr("Romanised artist/title may only use latin characters"), 4000);
  if (CR.el) CR.el.pause();
  const audioName = "audio" + (/ogg/i.test((CR.info && CR.info.fmt) || "") ? ".ogg" : (CR.audio.name.match(/\.(mp3|ogg)$/i) || [".mp3"])[0].toLowerCase());
  const bgName = CR.bg ? "bg" + ((CR.bg.name.match(/\.(jpe?g|png)$/i) || [".jpg"])[0].toLowerCase()) : "";
  const text = osuTemplate({ gen: CR.gen, meta: m, diff: CR.diff, audioName, bgName, bpm: +CR.tm.bpm, offset: +CR.tm.offset || 0, meter: +CR.tm.meter || 4, volume: +CR.tm.volume || 70 });
  const osuName = safeName(`${m.Artist} - ${m.Title} (${m.Creator}) [${m.Version}].osu`);
  const entries = { [audioName]: blobEntry(audioName, CR.audio), [osuName]: blobEntry(osuName, new Blob([text], { type: "text/plain" })) };
  if (CR.bg) entries[bgName] = blobEntry(bgName, CR.bg);
  R.intent = "edit";
  await openEntries(entries, null, { name: m.Version }, "mod", { created: true });
  if (map) toast(tr("Beatmap created • add objects with 2 3 4, export from the Setup tab"), 4000);
}

// ---------- editor Setup tab: edit the open difficulty's settings (undoable) ----------
function renderSetup(box) {
  const st = { meta: { ...map.meta }, diff: { ...map.diff }, gen: { ...map.general } };
  for (const [k, , , , , def] of SETUP_DIFF) if (st.diff[k] == null) st.diff[k] = k === "ApproachRate" ? +(st.diff.OverallDifficulty ?? def) : def;
  if (st.diff.SliderTickRate == null) st.diff.SliderTickRate = 1;
  box.append(exportRow());
  const more = h("div", "btnrow"), nd = h("button", "btn ghost sm", tr("New difficulty (copies timing)")); nd.onclick = newDifficulty; more.append(nd);
  const af = fileAccept(h("input"), ".osu,text/plain"), ab = h("button", "btn ghost sm", tr("Add .osu file…")); // a difficulty from a file, into this set (also: drop .osu files on the page)
  af.type = "file"; af.multiple = true; af.hidden = true; ab.type = "button";
  af.onchange = () => { const fs = [...af.files]; af.value = ""; if (fs.length) addOsuFiles(fs); };
  ab.onclick = () => { if (addOsuAllowed()) af.click(); };
  more.append(ab, af);
  box.append(more);
  const mg = h("div", "cgrid"); for (const [k, l] of SETUP_META) mg.append(tIn(st.meta, k, l, { ascii: k === "Artist" || k === "Title", area: k === "Tags" }));
  const dg = h("div", "cgrid"); for (const [k, l, mn, mx, s2] of SETUP_DIFF) dg.append(rIn(st.diff, k, l, mn, mx, s2, DIFF_INFO[k]));
  dg.append(sIn(st.diff, "SliderTickRate", "Slider tick rate", TICK_RATES.map(v => [v, String(v)])));
  const gg = h("div", "cgrid");
  if (st.gen.StackLeniency == null) st.gen.StackLeniency = .7;
  gg.append(sIn(st.gen, "SampleSet", "Sample set", SETS3), rIn(st.gen, "StackLeniency", "Stack leniency", .2, 1, .1), tIn(st.gen, "AudioLeadIn", "Audio lead-in (ms)", { type: "number" }));
  const pv = tIn(st.gen, "PreviewTime", "Preview time (ms)", { type: "number" }), pvb = h("button", "btn ghost sm", tr("Use current time"));
  pvb.type = "button"; pvb.onclick = () => { st.gen.PreviewTime = Math.round(A.cur()); pv.querySelector("input").value = st.gen.PreviewTime; };
  pv.append(pvb); gg.append(pv);
  const sw = h("div", "card2");
  for (const [k, l] of [["WidescreenStoryboard", "Widescreen support"], ["Countdown", "Countdown"], ["EpilepsyWarning", "Epilepsy warning"], ["LetterboxInBreaks", "Letterbox during breaks"]]) { if (st.gen[k] == null) st.gen[k] = k === "Countdown" ? 1 : 0; sw.append(bIn(st.gen, k, l)); }
  const apply = h("button", "btn main", tr("Apply setup changes"));
  apply.onclick = () => {
    const fix = (o, src) => { const out = { ...src }; for (const k in o) out[k] = String(o[k]); return out; };
    const g = fix(st.gen, map.general), mm = fix(st.meta, map.meta), dd = fix(st.diff, map.diff);
    if (JSON.stringify([g, mm, dd]) === JSON.stringify([map.general, map.meta, map.diff])) return toast(tr("Nothing changed"), 1200);
    if (edCommit("Setup", () => { map.general = g; map.meta = mm; map.diff = dd; }, { keepPanel: true })) {
      bodyCache.clear(); $("mSub").textContent = `[${map.meta.Version || "?"}] · mapped by ${map.meta.Creator || "?"}`; edSongSync();
      const lab = diffLabel({ ...osuFiles[curDiff], meta: { ...osuFiles[curDiff].meta, version: map.meta.Version } }); const o = $("diffQuick").options[curDiff]; if (o) o.text = lab; const o2 = $("diff").options[curDiff]; if (o2) o2.text = lab;
      toast(tr("Setup applied (undo with Ctrl+Z)"), 1600); edTab("setup");
    }
  };
  const sec = (t, ...k) => { box.append(h("h3", null, tr(t)), ...k); };
  const cb = h("div", "setcols"); cb.id = "setCols"; renderColours(cb);
  sec("Metadata", mg); sec("Difficulty", dg); sec("General", gg, sw); sec("Colours", cb);
  const ar = h("div", "btnrow sticky"); ar.append(apply); box.append(ar);
  const info = h("div"); info.innerHTML = overviewHTML() + `<h3>${esc(tr("Song file"))}</h3>` + audioHTML(); box.append(info);
}
// ---------- Setup -> Colours: combo colours and the slider track/border, like osu!'s Song Setup -> Colours ----------
// applied right away (one undo step each, sent to live/collab like any edit); dragging a picker only previews
const hexOf = c => "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
const rgbOf = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
const COL_KEYS = /^(Combo\d+|SliderTrackOverride|SliderBorder)$/;
function coloursKV(combos, track, border) { // the new [Colours], keeping any keys this page doesn't edit
  const out = {};
  combos.forEach((c, i) => out["Combo" + (i + 1)] = c.join(","));
  if (track) out.SliderTrackOverride = track.join(",");
  if (border) out.SliderBorder = border.join(",");
  for (const k in map.colourKV) if (!COL_KEYS.test(k)) out[k] = map.colourKV[k];
  return out;
}
function renderColours(box = $("setCols")) {
  if (!box || !map) return;
  box.innerHTML = "";
  const combos = map.colours.map(c => c.slice()), mc = map.colourMap;
  let track = mc.SliderTrackOverride ? mc.SliderTrackOverride.slice() : null, border = mc.SliderBorder ? mc.SliderBorder.slice() : null;
  const commit = label => {
    const kv = coloursKV(combos, track, border);
    if (JSON.stringify(kv) === JSON.stringify(map.colourKV)) return renderColours(box);
    if (edCommit(label, () => { map.colourKV = kv; }, { keepPanel: true })) bodyCache.clear();
    renderColours(box);
  };
  const dark = c => { const l = hsp(c); return l < 30 ? tr("Way too dark: hard to see") : l < 43 ? tr("Really dark: may be hard to see") : ""; };
  const picker = (c, onPreview, onPick) => {
    const i = h("input"); i.type = "color"; i.value = hexOf(c);
    i.oninput = () => { onPreview(rgbOf(i.value)); dirty = true; };
    i.onchange = () => onPick(rgbOf(i.value));
    return i;
  };
  box.append(h("p", "hint", tr("Changes here apply right away (undo with Ctrl+Z).")));
  // combo colours
  const cc = h("div", "card2 colcard"), head = h("div", "colhead");
  head.append(h("b", null, tr("Combo colours")));
  const skinCols = () => (SK.colors || (DEFSK && DEFSK.colors) || DEFAULT_SKIN_COLS).map(c => c.slice());
  if (!combos.length) {
    const use = h("button", "btn ghost sm", tr("Use custom colours")); use.type = "button";
    use.onclick = () => { combos.push(...skinCols().slice(0, 8)); commit("Combo colours"); };
    head.append(use); cc.append(head, h("p", "hint", tr("This map uses the skin's combo colours.")));
  } else {
    const off = h("button", "btn ghost sm", tr("Use the skin's colours")); off.type = "button";
    off.onclick = () => { combos.length = 0; commit("Combo colours"); };
    head.append(off); cc.append(head);
    const row = h("div", "colrow");
    combos.forEach((c, i) => {
      const it = h("div", "colit"), top = h("div", "colsw");
      const pk = picker(c, v => { map.colours[i] = v; }, v => { combos[i] = v; commit("Combo colours"); });
      pk.title = tr("Combo {n}", { n: i + 1 }); pk.setAttribute("aria-label", pk.title);
      const num = h("span", "colnum", String(i + 1));
      top.append(pk, num);
      const tools = h("div", "coltools");
      const left = h("button", "iconbtn", "‹"); left.type = "button"; left.title = tr("Move left"); left.disabled = i === 0;
      left.onclick = () => { [combos[i - 1], combos[i]] = [combos[i], combos[i - 1]]; commit("Combo colours"); };
      const del = h("button", "iconbtn", "×"); del.type = "button"; del.title = tr("Remove");
      del.onclick = () => { combos.splice(i, 1); commit("Combo colours"); };
      tools.append(left, del);
      it.append(top, h("small", null, tr("Combo {n}", { n: i + 1 })), tools);
      const w = dark(c); if (w) { it.classList.add("warn"); it.title = w; }
      row.append(it);
    });
    if (combos.length < 8) {
      const add = h("button", "coladd", "+"); add.type = "button"; add.title = tr("Add colour");
      add.onclick = () => { const s = skinCols(); combos.push(s[combos.length % s.length]); commit("Combo colours"); };
      row.append(add);
    }
    cc.append(row);
    const warns = combos.map((c, i) => dark(c) && tr("Combo {n}", { n: i + 1 }) + ": " + dark(c)).filter(Boolean);
    if (warns.length) cc.append(h("p", "hint cwarn", warns.join(" • ")));
  }
  // slider colours
  const sc = h("div", "card2 colcard");
  const slider = (label, hint, cur, def, set, previewKey) => {
    const r = h("div", "sw colsl"), t = h("span", "swt"), right = h("span", "colright"), on = h("input");
    t.append(h("b", null, tr(label)), h("small", null, tr(hint)));
    on.type = "checkbox"; on.className = "switch"; on.checked = !!cur; on.setAttribute("aria-label", tr(label));
    on.onchange = () => { set(on.checked ? (cur || def()) : null); commit("Slider colours"); };
    if (cur) { const pk = picker(cur, v => { map.colourMap[previewKey] = v; }, v => { set(v); commit("Slider colours"); }); pk.setAttribute("aria-label", tr(label)); right.append(pk); }
    right.append(on); r.append(t, right);
    return r;
  };
  sc.append(
    slider("Slider track colour", "One colour for every slider body instead of the combo colour", track, () => (combos[0] || [0, 0, 0]).slice(), v => track = v, "SliderTrackOverride"),
    slider("Slider border colour", "Instead of the skin's (usually white)", border, () => [255, 255, 255], v => border = v, "SliderBorder"));
  if (border && dark(border)) sc.append(h("p", "hint cwarn", dark(border)));
  box.append(cc, sc);
}
async function newDifficulty() {
  const name = ((await askText(tr("Name of the new difficulty"), (map.meta.Version || "Normal") + " 2")) || "").trim(); if (!name) return;
  if (osuFiles.some(o => o.meta.version.toLowerCase() === name.toLowerCase())) return toast(tr("A difficulty with this name already exists"));
  const L = editedText().split(/\r?\n/);
  putKeys(L, "Metadata", { Version: name, BeatmapID: 0 }, ":"); putSection(L, "HitObjects", []);
  const E0 = L.findIndex(l => /^Bookmarks\s*:/.test(l)); if (E0 >= 0) L.splice(E0, 1);
  const text = L.join("\r\n"), M = map.meta, path = safeName(`${M.Artist} - ${M.Title} (${M.Creator}) [${name}].osu`);
  files[norm(path)] = blobEntry(path, new Blob([text]));
  osuFiles.push({ text, meta: quickMeta(text), path, created: true });
  for (const sel of [$("diff"), $("diffQuick")]) sel.add(new Option(name, osuFiles.length - 1));
  $("diffQuick").hidden = osuFiles.length < 2;
  switchDiff(osuFiles.length - 1);
  if (LIVE.on && LIVE.host) setTimeout(liveSendState, 800);
}

// ---------- add difficulties from .osu files into the open set (Setup tab button, or .osu files dropped on the page) ----------
// planOsuAdd is the whole decision, no DOM: it takes the file's text and what the open set looks like and returns the text to store
// (BOM gone, BeatmapID and AudioFilename fixed so it fits this set), the difficulty name and the file name in the package, or why not.
//   ctx = { versions: [names in the set], paths: [norm()ed file names of everything in the package], setId, usedBids: [BeatmapIDs of the set's difficulties],
//           audioName: "the set's song file" ("" = none), hasAudio(name) -> bool, meta: { Artist, Title, Creator } of the set, version: "a name picked by the user", fallbackVersion }
// -> { ok: true, text, version, path, notes: ["meta" | "audio" | "bid"], audio }  or  { ok: false, error: "empty" | "big" | "notosu" | "mania" | "mode" | "parse" | "dupversion", version?, suggest? }
const ADD_MAX_BYTES = 4 * 1024 * 1024, ADD_MAX_FILES = 20;
function planOsuAdd(text, ctx) {
  text = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  if (!text.trim()) return { ok: false, error: "empty" };
  if (text.length > ADD_MAX_BYTES) return { ok: false, error: "big" };
  if (text.includes("\u0000") || !/^\[HitObjects\]/m.test(text) || !(/osu file format v\d+/.test(text.slice(0, 300)) || /^\[General\]/m.test(text))) return { ok: false, error: "notosu" };
  let P; try { P = parseOsu(text); } catch { return { ok: false, error: "parse" }; }
  const mode = String(P.general.Mode == null || P.general.Mode === "" ? "0" : P.general.Mode).trim();
  if (mode === "3") return { ok: false, error: "mania" };
  if (mode !== "0") return { ok: false, error: "mode" };
  const clean = s => String(s == null ? "" : s).replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const taken = new Set((ctx.versions || []).map(v => String(v).trim().toLowerCase()));
  const version = clean(ctx.version != null ? ctx.version : P.meta.Version) || clean(ctx.fallbackVersion) || "Imported";
  if (taken.has(version.toLowerCase())) {
    let n = 2; while (taken.has(`${version} (${n})`.toLowerCase())) n++;
    return { ok: false, error: "dupversion", version, suggest: `${version} (${n})` };
  }
  const M = ctx.meta || {}, used = new Set((ctx.paths || []).map(String));
  const stem = safeName(`${M.Artist || ""} - ${M.Title || ""} (${M.Creator || ""}) [${version}]`).replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 140).trim();
  let path = stem + ".osu"; for (let n = 2; used.has(norm(path)); n++) path = `${stem} (${n}).osu`; // (the server refuses two names that differ only in case)
  const notes = [], eol = /\r\n/.test(text) ? "\r\n" : "\n", L = text.split(/\r?\n/);
  const bid = +P.meta.BeatmapID, sid = +P.meta.BeatmapSetID, keep = +ctx.setId > 0 && sid === +ctx.setId && bid > 0 && !(ctx.usedBids || []).some(b => +b === bid);
  if (!keep && bid) notes.push("bid"); // (a link to another set's difficulty, or to one this set already has: dropped)
  putKeys(L, "Metadata", { Version: version, BeatmapID: keep ? bid : 0 }, ":");
  let audio = "";
  if (ctx.audioName && !(ctx.hasAudio && ctx.hasAudio(P.general.AudioFilename || ""))) { audio = ctx.audioName; putKeys(L, "General", { AudioFilename: audio }, ": "); notes.push("audio"); }
  const same = (a, b) => !a || !b || String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  if (!same(P.meta.Title, M.Title) || !same(P.meta.Artist, M.Artist)) notes.push("meta");
  return { ok: true, text: L.join(eol), version, path, notes, audio };
}
// may a difficulty be added right now? (says why not)
function addOsuAllowed() {
  if (!EDIT.on || !map || !osuFiles.length || rpLocked()) { toast(tr("Open a map in the Editor first to add a .osu file"), 3500); return false; }
  if (LIVE.on && !LIVE.host) { toast(LIVE.watch ? tr("You're watching: only the host can do this") : tr("In a live session the host picks the difficulty"), 3000); return false; }
  if (COLLAB.on) { toast(tr("Leave the collab session first to add a difficulty from a file"), 3500); return false; }
  return can("editor") && featGuard("editor") && featGuard("ed_setup");
}
const ADD_ERR = { empty: () => tr("empty file"), big: () => tr("bigger than {n} MB", { n: ADD_MAX_BYTES / 1048576 }), notosu: () => tr("not an osu! beatmap file"), parse: () => tr("not an osu! beatmap file"),
  mania: () => tr("osu!mania isn't supported: this site opens osu!standard difficulties only"), mode: () => tr("only osu!standard difficulties can be added"), read: () => tr("couldn't be read"), skip: () => tr("not added") };
let addBusy = false;
async function addOsuFiles(list) {
  if (addBusy || !addOsuAllowed()) return;
  let fs = [...list].filter(f => fileIs(f, ["osu"]));
  if (!fs.length) return toast(tr("Pick an .osu file (one difficulty)"), 3000);
  const extra = fs.length - ADD_MAX_FILES; if (extra > 0) fs = fs.slice(0, ADD_MAX_FILES);
  addBusy = true;
  const added = [], notes = new Set(), skipped = [];
  try {
    for (const f of fs) {
      const bad = k => skipped.push(`${f.name}: ${ADD_ERR[k]()}`);
      if (f.size > ADD_MAX_BYTES) { bad("big"); continue; }
      let text; try { text = await f.text(); } catch { bad("read"); continue; }
      const ctx = () => { // (the set's own metadata and song come from a difficulty that wasn't added from a file: those may be another song's)
        const ri = Math.max(0, osuFiles.findIndex(o => !o.created)), live = ri === curDiff && map, tx = osuFiles[ri].text, rg = k => ((tx.match(new RegExp("^" + k + "[ \\t]*:[ \\t]*(.*)$", "m")) || [])[1] || "").trim();
        const meta = live ? map.meta : { Artist: rg("Artist"), Title: rg("Title"), Creator: rg("Creator") }, song = live ? map.general.AudioFilename || "" : rg("AudioFilename");
        return { versions: osuFiles.map((o, i) => i === curDiff && map ? map.meta.Version || "" : o.meta.version), paths: Object.keys(files).map(norm), setId: setId || onlineSet || 0,
          usedBids: osuFiles.map((o, i) => +(i === curDiff && map ? map.meta.BeatmapID : o.meta.bid) || 0).filter(b => b > 0), meta,
          audioName: files[norm(song)] ? song : "", hasAudio: n => !!n && !!files[norm(n)], fallbackVersion: f.name.replace(/\.osu$/i, "") };
      };
      let c = ctx(), plan = planOsuAdd(text, c);
      while (!plan.ok && plan.error === "dupversion") { // the name is taken (any case): ask for another, cancel skips this file
        const name = await askText(tr("A difficulty named [{v}] is already in this set. Name for the new one:", { v: plan.version }), plan.suggest, { title: tr("Name of the new difficulty") });
        if (name == null) { bad("skip"); plan = null; break; }
        c = ctx(); c.version = name.trim(); const again = c.version ? planOsuAdd(text, c) : plan;
        if (!again.ok && again.error === "dupversion" && c.version) toast(tr("A difficulty with this name already exists"), 2500);
        plan = again;
      }
      if (!plan) continue;
      if (!plan.ok) { bad(plan.error); continue; }
      if (quickMeta(plan.text).mode !== "0") { bad("mode"); continue; }
      if (/aspire/i.test(((plan.text.match(/^Tags[ \t]*:(.*)$/m) || [])[1] || "") + " " + ((plan.text.match(/^Source[ \t]*:(.*)$/m) || [])[1] || "")) && typeof aspireAsk === "function") {
        if (!(await aspireAsk({ [plan.path]: { dir: false } }, async () => plan.text, c.setId))) { bad("skip"); continue; } // (same warning as opening an Aspire set)
      }
      if (!addOsuAllowed()) break; // (a session started while the name was asked for)
      files[norm(plan.path)] = blobEntry(plan.path, new Blob([plan.text], { type: "text/plain" }));
      osuFiles.push({ text: plan.text, meta: quickMeta(plan.text), path: plan.path, created: true, stars: estimateStars(plan.text), estStars: true });
      added.push(plan); plan.notes.forEach(n => notes.add(n)); if (plan.audio) notes.add("audio:" + plan.audio);
    }
  } finally { addBusy = false; }
  if (added.length) {
    const first = osuFiles.length - added.length;
    fillDiffSelects();
    switchDiff(first); // (before the note: switching may toast "kept in this browser")
    if (typeof draftSchedule === "function") draftSchedule();
    if (typeof cloudTouch === "function") cloudTouch();
    if (LIVE.on && LIVE.host) setTimeout(liveSendState, 800);
  }
  const msg = [];
  if (added.length) {
    msg.push(added.length === 1 ? tr("Added [{v}] to this set.", { v: added[0].version }) : tr("Added {n} difficulties to this set.", { n: added.length }));
    if (notes.has("meta")) msg.push(tr("Its title or artist differs from this set."));
    const au = [...notes].find(n => n.startsWith("audio:")); if (au) msg.push(tr("Its audio file isn't in this set: it now uses {a}.", { a: au.slice(6) }));
  }
  if (extra > 0) msg.push(tr("Only the first {n} files were used.", { n: ADD_MAX_FILES }));
  msg.push(...skipped);
  if (msg.length) toast(msg.join(" "), msg.length > 1 ? 7000 : 3500);
}
// .osu files dropped on the page: into the open set while the Editor is open. Capture phase, so this runs before the page-wide drop handler in
// js/app.js (it would try to open them as a package). Anything with a package or a replay in it (.osz .zip .osr .osk) is left to the old handlers.
addEventListener("drop", e => {
  const fs = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!fs.some(f => fileIs(f, ["osu"])) || fs.some(f => fileIs(f, ["osz", "zip", "osr", "osk"]))) return;
  if (e.target && e.target.closest && e.target.closest(".cdrop")) return; // (the new-beatmap song box)
  if (!EDIT.on && typeof replayPending === "function" && replayPending()) return; // (a replay waits for its map: js/replayui.js)
  e.preventDefault(); e.stopImmediatePropagation(); dragN = 0; $("drop").hidden = true;
  if (!EDIT.on) return toast(tr("Open a map in the Editor first to add a .osu file"), 3500);
  addOsuFiles(fs);
}, true);
