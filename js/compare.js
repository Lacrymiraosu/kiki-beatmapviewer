"use strict";
// ============ Compare: what changed between two versions of this difficulty ============
// The other version: the map as it was when you opened it, an .osu file, a whole set (.osz: every difficulty and the
// other files at once), or an older copy in Google Drive (gdrive.js).
// Objects are matched by time; an object that moved a little in time (resnapped) is shown as one change, not as
// removed + added. Click a row to jump there.
const CMP = { src: "opened", label: "", text: null, res: null, filter: "", set: null, ghost: false };
const CMP_KINDS = [["added", "Added"], ["removed", "Removed"], ["retimed", "Moved in time"], ["moved", "Moved"], ["shape", "Shape / length"], ["nc", "New combo"], ["hitsound", "Hitsounds"], ["timing", "Timing / SV"], ["settings", "Settings"]];

function cmpObjects(text) {
  const out = []; let sec = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const s = raw.trim(); if (!s || s.startsWith("//")) continue;
    const m = s.match(/^\[(.+)\]$/); if (m) { sec = m[1]; continue; }
    if (sec !== "HitObjects") continue;
    const p = s.split(","); if (p.length < 4) continue;
    const type = +p[3] | 0, kind = type & 2 ? "slider" : type & 8 ? "spinner" : type & 128 ? "hold" : "circle";
    let shape = "", hs = (p[4] || "0") + "|";
    if (kind === "slider") { shape = [p[5], p[6], Math.round(+p[7] * 100) / 100].join("|"); hs += [p[8] || "", p[9] || "", p[10] || ""].join("|"); }
    else if (kind === "spinner") { shape = p[5] || ""; hs += p[6] || ""; }
    else if (kind === "hold") { shape = (p[5] || "").split(":")[0]; hs += (p[5] || "").split(":").slice(1).join(":"); }
    else hs += p[5] || "";
    out.push({ t: +p[2], x: +p[0], y: +p[1], kind, nc: !!(type & 4), skip: (type >> 4) & 7, shape, hs, slides: kind === "slider" ? +p[6] || 1 : 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}
function cmpSections(text) { // key: value sections, timing lines, colours, breaks, bookmarks
  const r = { kv: {}, timing: [], colours: {}, breaks: [] }; let sec = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const s = raw.trim(); if (!s || s.startsWith("//")) continue;
    const m = s.match(/^\[(.+)\]$/); if (m) { sec = m[1]; continue; }
    if (sec === "TimingPoints") { const tp = parseTimingLine(s); if (tp) r.timing.push(tp); }
    else if (sec === "Colours") { const i = s.indexOf(":"); if (i > 0) r.colours[s.slice(0, i).trim()] = s.slice(i + 1).replace(/\s/g, ""); }
    else if (sec === "Events") { const p = s.split(","); if ((p[0] === "2" || p[0] === "Break") && p.length >= 3) r.breaks.push(`${Math.round(+p[1])}-${Math.round(+p[2])}`); }
    else if (["General", "Metadata", "Difficulty", "Editor"].includes(sec)) { const i = s.indexOf(":"); if (i > 0) r.kv[sec + "." + s.slice(0, i).trim()] = s.slice(i + 1).trim(); }
  }
  return r;
}
const cmpPos = o => `${Math.round(o.x)},${Math.round(o.y)}`;
const cmpKindName = k => tr({ circle: "Circle", slider: "Slider", spinner: "Spinner", hold: "Hold note" }[k] || k);

// a = the other (older) version, b = this one -> [{ t, kind, text }] sorted by time
function mapDiff(aText, bText) {
  if (aText === bText) { // nothing changed (and no need to read a 100 MB Aspire map line by line)
    const i = String(aText || "").indexOf("[HitObjects]"); let n = 0;
    if (i >= 0) for (const raw of aText.slice(i + 12).split(/\r?\n/)) { const l = raw.trim(); if (l.startsWith("[")) break; if (l && !l.startsWith("//") && l.split(",", 4).length >= 4) n++; }
    return { rows: [], objects: [n, n] };
  }
  const A = cmpObjects(aText), B = cmpObjects(bText), rows = [];
  const byT = new Map(); for (const o of A) { const k = Math.round(o.t); (byT.get(k) || byT.set(k, []).get(k)).push(o); }
  const restB = [];
  for (const o of B) {
    const L = byT.get(Math.round(o.t)), i = L ? L.findIndex(x => x.kind === o.kind) : -1;
    if (i < 0) { restB.push(o); continue; }
    const a = L.splice(i, 1)[0]; cmpPair(a, o, rows);
  }
  const restA = [...byT.values()].flat().sort((x, y) => x.t - y.t);
  // resnapped: same kind and place, a little earlier or later (closest first)
  for (const o of restB) {
    let best = -1, bd = 61;
    for (let i = 0; i < restA.length; i++) { const a = restA[i], d = Math.abs(a.t - o.t); if (a.kind === o.kind && d < bd && Math.hypot(a.x - o.x, a.y - o.y) < 2) { bd = d; best = i; } }
    if (best < 0) { rows.push({ t: o.t, kind: "added", text: tr("{obj} added at {pos}", { obj: cmpKindName(o.kind), pos: cmpPos(o) }) }); continue; }
    const a = restA.splice(best, 1)[0];
    rows.push({ t: o.t, kind: "retimed", text: tr("{obj} moved {ms} ms {dir} (from {from})", { obj: cmpKindName(o.kind), ms: Math.round(Math.abs(o.t - a.t)), dir: o.t > a.t ? tr("later") : tr("earlier"), from: fmtMs(a.t) }) });
    cmpPair(a, o, rows, true);
  }
  for (const a of restA) rows.push({ t: a.t, kind: "removed", text: tr("{obj} removed (was at {pos})", { obj: cmpKindName(a.kind), pos: cmpPos(a) }) });
  // timing points: by time and kind (red / green)
  const SA = cmpSections(aText), SB = cmpSections(bText), tk = tp => Math.round(tp.time) + (tp.uninherited ? "r" : "g");
  const tA = new Map(SA.timing.map(tp => [tk(tp), tp])), tB = new Map(SB.timing.map(tp => [tk(tp), tp]));
  const tpDesc = tp => tp.uninherited ? tr("BPM {bpm}, {m}/4", { bpm: +(60000 / tp.beat).toFixed(2), m: tp.meter }) : tr("SV {sv}x", { sv: +(-100 / tp.beat).toFixed(2) });
  const tpMore = tp => `${tr("volume")} ${Math.round(tp.volume)}%, ${["auto", "normal", "soft", "drum"][tp.sampleSet] || tp.sampleSet}${tp.sampleIndex ? ":" + tp.sampleIndex : ""}${tp.kiai ? ", kiai" : ""}`;
  for (const [k, b] of tB) {
    const a = tA.get(k), what = b.uninherited ? tr("Timing point") : tr("Green line");
    if (!a) { rows.push({ t: b.time, kind: "timing", text: tr("{what} added: {desc}", { what, desc: tpDesc(b) + ", " + tpMore(b) }) }); continue; }
    tA.delete(k);
    const d = [];
    if (Math.abs(a.beat - b.beat) > 1e-6) d.push(`${tpDesc(a)} → ${tpDesc(b)}`);
    if (a.meter !== b.meter && b.uninherited) d.push(`${a.meter}/4 → ${b.meter}/4`);
    if (Math.round(a.volume) !== Math.round(b.volume) || a.sampleSet !== b.sampleSet || a.sampleIndex !== b.sampleIndex || a.kiai !== b.kiai) d.push(`${tpMore(a)} → ${tpMore(b)}`);
    if (d.length) rows.push({ t: b.time, kind: "timing", text: `${what}: ${d.join("; ")}` });
  }
  for (const a of tA.values()) rows.push({ t: a.time, kind: "timing", text: tr("{what} removed: {desc}", { what: a.uninherited ? tr("Timing point") : tr("Green line"), desc: tpDesc(a) }) });
  // settings, metadata, colours, breaks (no time: shown first)
  const SKIP = new Set(["Editor.Bookmarks", "Editor.DistanceSpacing", "Editor.BeatDivisor", "Editor.GridSize", "Editor.TimelineZoom"]);
  const keys = new Set([...Object.keys(SA.kv), ...Object.keys(SB.kv)]);
  for (const k of keys) { if (SKIP.has(k)) continue; const a = SA.kv[k] ?? "", b = SB.kv[k] ?? ""; if (a !== b) rows.push({ t: null, kind: "settings", text: `${k.split(".")[1]}: ${a || "—"} → ${b || "—"}` }); }
  const ck = new Set([...Object.keys(SA.colours), ...Object.keys(SB.colours)]);
  for (const k of ck) if (SA.colours[k] !== SB.colours[k]) rows.push({ t: null, kind: "settings", text: `${k}: ${SA.colours[k] || "—"} → ${SB.colours[k] || "—"}` });
  if (SA.breaks.join() !== SB.breaks.join()) rows.push({ t: null, kind: "settings", text: tr("Breaks: {a} → {b}", { a: SA.breaks.length, b: SB.breaks.length }) });
  rows.sort((x, y) => (x.t ?? -1e9) - (y.t ?? -1e9));
  return { rows, objects: [A.length, B.length] };
}
function cmpPair(a, b, rows, retimed) {
  const name = cmpKindName(b.kind);
  if (!retimed && (Math.round(a.x) !== Math.round(b.x) || Math.round(a.y) !== Math.round(b.y))) {
    const d = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
    rows.push({ t: b.t, kind: "moved", text: tr("{obj} moved {px} px ({from} → {to})", { obj: name, px: d, from: cmpPos(a), to: cmpPos(b) }) });
  }
  if (a.shape !== b.shape) rows.push({ t: b.t, kind: "shape", text: b.kind === "slider" && a.slides !== b.slides ? tr("Slider repeats {a} → {b}", { a: a.slides - 1, b: b.slides - 1 }) : b.kind === "slider" ? tr("Slider shape or length changed") : tr("{obj} end changed", { obj: name }) });
  if (a.nc !== b.nc || a.skip !== b.skip) rows.push({ t: b.t, kind: "nc", text: b.nc && !a.nc ? tr("New combo added") : !b.nc && a.nc ? tr("New combo removed") : tr("Colour skip changed") });
  if (a.hs !== b.hs) rows.push({ t: b.t, kind: "hitsound", text: tr("Hitsounds changed on this {obj}", { obj: name.toLowerCase() }) });
}

// ---------- a whole set (.osz) to compare with ----------
// its difficulties are matched to the open ones by beatmap ID, else by difficulty name; the other files by their
// checksum in the zip (or size when one side has none, e.g. a file replaced in the browser)
const cmpEntrySig = e => !e ? null : { size: e._data ? e._data.uncompressedSize : e.size ?? null, crc: e._data && e._data.crc32 != null ? e._data.crc32 : null };
async function cmpLoadSet(f) {
  showLoading(tr("Unpacking…"), -1);
  try {
    const zip = await (await loadJSZip()).loadAsync(f), diffs = [], other = new Map(), jobs = [];
    zip.forEach((path, e) => {
      if (e.dir) return;
      if (/\.osu$/i.test(path)) jobs.push(e.async("string").then(text => diffs.push({ path, text, meta: quickMeta(text) })));
      else other.set(norm(path), cmpEntrySig(e));
    });
    await Promise.all(jobs);
    if (!diffs.length) return toast(tr("There's no difficulty (.osu) in this file"), 3000);
    diffs.sort((a, b) => a.meta.version.localeCompare(b.meta.version));
    CMP.set = { label: f.name, diffs, files: other, forFiles: osuFiles };
    cmpUse("set", f.name, null);
  } catch (e) { toast(tr("Couldn't open the file, it may be broken"), 3000); }
  finally { hideLoading(); }
}
function cmpSetMatch() { // -> { mine: [{ i, d }], only: [uploaded difficulties nobody here matches] }
  const left = [...CMP.set.diffs], key = v => String(v || "").trim().toLowerCase();
  const take = pred => { const k = left.findIndex(pred); return k < 0 ? null : left.splice(k, 1)[0]; };
  const mine = osuFiles.map((o, i) => ({ i, o })).map(({ i, o }) => ({ i, d: (+o.meta.bid > 0 && take(d => +d.meta.bid === +o.meta.bid)) || null }));
  for (const m of mine) if (!m.d) m.d = take(d => key(d.meta.version) === key(osuFiles[m.i].meta.version));
  return { mine, only: left };
}
const cmpDiffText = i => i === curDiff ? cmpCurrentText() : osuFiles[i].text;
function cmpSetFiles() { // other files: added here / removed here / changed
  const here = new Map(); for (const k in files) if (!/\.osu$/i.test(k)) here.set(k, cmpEntrySig(files[k]));
  const rows = [];
  for (const [k, b] of here) {
    const a = CMP.set.files.get(k);
    if (!a) rows.push({ kind: "added", name: k });
    else if (a.crc != null && b.crc != null ? a.crc !== b.crc || a.size !== b.size : a.size != null && b.size != null && a.size !== b.size) rows.push({ kind: "changed", name: k, a, b });
  }
  for (const k of CMP.set.files.keys()) if (!here.has(k)) rows.push({ kind: "removed", name: k });
  return rows.sort((x, y) => x.name.localeCompare(y.name));
}
const cmpSize = n => n == null ? "?" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB";
function cmpSetSummary(body) {
  const { mine, only } = cmpSetMatch(), box = h("div", "cmpset");
  box.append(h("h4", null, tr("Whole set: {f}", { f: CMP.set.label })));
  const list = h("div", "cmpdiffs");
  for (const { i, d } of mine) {
    const o = osuFiles[i], row = h("button", "cmpdiff" + (i === curDiff ? " on" : "")); row.type = "button";
    let state, cls;
    if (!d) { state = tr("New difficulty (not in the uploaded set)"); cls = "added"; }
    else { const n = mapDiff(d.text, cmpDiffText(i)).rows.length; state = n ? tr("{n} changes", { n }) : tr("No differences"); cls = n ? "changed" : "same"; }
    row.append(h("b", null, "[" + (o.meta.version || "?") + "]"), h("span", "cmpst " + cls, state));
    row.onclick = () => { if (i !== curDiff) Promise.resolve(switchDiff(i)).then(() => setTimeout(rerenderCompare, 0)); };
    list.append(row);
  }
  for (const d of only) { const row = h("div", "cmpdiff"); row.append(h("b", null, "[" + d.meta.version + "]"), h("span", "cmpst removed", tr("Only in the uploaded set (removed here)"))); list.append(row); }
  box.append(list);
  const fr = cmpSetFiles();
  if (!fr.length) box.append(h("p", "hint", tr("Other files (song, background, hitsounds, storyboard): no differences")));
  else {
    const det = h("details", "cmpfiles"), c = k => fr.filter(r => r.kind === k).length;
    det.append(h("summary", null, tr("Other files: {a} added, {r} removed, {c} changed", { a: c("added"), r: c("removed"), c: c("changed") })));
    for (const r of fr) {
      const el = h("div", "cmprow cmpfile " + (r.kind === "changed" ? "moved" : r.kind));
      el.append(h("span", "cmpk", tr({ added: "Added", removed: "Removed", changed: "Changed" }[r.kind])), h("span", "cmpt", r.name + (r.kind === "changed" ? ` (${cmpSize(r.a.size)} → ${cmpSize(r.b.size)})` : "")));
      det.append(el);
    }
    box.append(det);
  }
  body.append(box);
  return mine.find(m => m.i === curDiff);
}

// the other version's text for the open difficulty (null: none picked, or not in the uploaded set)
function cmpOther() {
  if (CMP.src === "opened") return osuFiles[curDiff] ? cmpOpenedText() : null;
  if (CMP.src === "set") {
    if (!CMP.set || CMP.set.forFiles !== osuFiles) return null;
    const c = CMPG.pick; if (c && c.set === CMP.set && c.i === curDiff && c.n === osuFiles.length) return c.text; // (the ghost asks every frame)
    const m = cmpSetMatch().mine.find(x => x.i === curDiff), text = m && m.d ? m.d.text : null;
    CMPG.pick = { set: CMP.set, i: curDiff, n: osuFiles.length, text }; return text;
  }
  return CMP.key === mapKey() ? CMP.text : null;
}

// ---------- ghost: the other version on the playfield in Compose ----------
// Its objects that aren't exactly the same here (moved, reshaped, retimed, removed) are drawn see-through and dashed
// in orange under the map's own objects, at their own time, so before and after show together while you scrub.
// "Only moved objects" (on by default, S.cmpGhostMoved) leaves out objects whose only change is their hitsounds or new
// combo, and an object that moved gets an arrow from where it was to where it is now.
const CMPG = { text: null, m: null, list: null, lines: null, pick: null, moved: null };
const cmpGhostMovedOnly = () => S.cmpGhostMoved !== false;
function cmpGeomKey(s) { // where an object is and its shape, without hitsounds or new combo
  const p = s.trim().split(","), type = +p[3] | 0;
  if (type & 8) return "s|" + Math.round(+p[2]) + "|" + Math.round(+p[5]);
  if (type & 128) return "h|" + Math.round(+p[0]) + "|" + Math.round(+p[2]) + "|" + String(p[5] || "").split(":")[0];
  if (type & 2) return "l|" + Math.round(+p[0]) + "|" + Math.round(+p[1]) + "|" + Math.round(+p[2]) + "|" + p[5] + "|" + (+p[6] || 1) + "|" + Math.round(+p[7] * 100) / 100;
  return "c|" + Math.round(+p[0]) + "|" + Math.round(+p[1]) + "|" + Math.round(+p[2]);
}
function cmpGhostObjs() {
  if (!CMP.ghost || !map || map.mode === 3) return null;
  const other = cmpOther(); if (other == null) return null;
  if (CMPG.text !== other) { CMPG.text = other; try { CMPG.m = parseOsu(other); } catch { CMPG.m = null; } CMPG.lines = null; }
  if (!CMPG.m) return null;
  const mo = cmpGhostMovedOnly();
  if (CMPG.lines !== map.lines || CMPG.moved !== mo || CMPG.hit !== map.hit) { // which of its objects still exist unchanged here (by their .osu line, or only where they are)
    CMPG.lines = map.lines; CMPG.moved = mo; CMPG.hit = map.hit;
    const key = mo ? cmpGeomKey : s => s.trim(), here = new Set(map.lines.map(L => key(L.s))), line = new Map(CMPG.m.lines.map(L => [L.id, key(L.s)]));
    const now = new Map(); for (const o of map.hit) { const k = o.kind + "|" + Math.round(o.t); if (!now.has(k)) now.set(k, o); } // (the same object here: same kind at the same time)
    CMPG.list = CMPG.m.hit.filter(o => !here.has(line.get(o.lid)));
    for (const o of CMPG.list) { const q = now.get(o.kind + "|" + Math.round(o.t)); o.to = q && o.kind !== "spinner" && Math.hypot(q.x - o.x, q.y - o.y) > 2 ? q : null; }
  }
  return CMPG.list;
}
function cmpDrawGhost(t, px) {
  const G = cmpGhostObjs(); if (!G || !G.length) return;
  const pre = map.preempt, r = map.radius, i0 = Math.max(0, lowerIdx(G, t - 3000, "t")), k = Math.min(100, Math.max(10, +S.cmpGhostA || 70)) / 100; // (opacity, Compare panel / Settings → Editor)
  ctx.save(); ctx.strokeStyle = "#ffb35c"; ctx.fillStyle = `rgba(255,179,92,${(.08 + .12 * k).toFixed(3)})`; ctx.setLineDash([6 * px, 5 * px]);
  for (let i = i0; i < G.length && G[i].t <= t + pre; i++) {
    const o = G[i], end = o.kind === "slider" || o.kind === "spinner" ? o.end : o.t;
    if (t > end + 300) continue;
    const a = t < o.t ? clamp01(1 - (o.t - t) / pre) : clamp01(1 - (t - end) / 300);
    ctx.globalAlpha = (.3 + .7 * a) * k; ctx.lineWidth = 2.5 * px;
    if (o.kind === "spinner") { ctx.beginPath(); ctx.arc(256, 192, 120, 0, 7); ctx.stroke(); continue; }
    if (o.kind === "slider" && o.path && o.path.length > 1) {
      ctx.beginPath(); tracePath(ctx, o.path); ctx.lineWidth = 2 * px; ctx.stroke();
      const e = o.path[o.path.length - 1]; ctx.beginPath(); ctx.arc(e[0], e[1], r * .92, 0, 7); ctx.lineWidth = 1.5 * px; ctx.stroke();
    }
    ctx.lineWidth = 2.5 * px; ctx.beginPath(); ctx.arc(o.x, o.y, r * .92, 0, 7); ctx.fill(); ctx.stroke();
    if (o.to) { // where it went: an arrow from the old spot to the object here
      const q = o.to, dx = q.x - o.x, dy = q.y - o.y, d = Math.hypot(dx, dy), ux = dx / d, uy = dy / d, a0 = Math.min(r * .92, d / 3), a1 = Math.max(a0, d - Math.min(r * .92, d / 3));
      const x1 = o.x + ux * a1, y1 = o.y + uy * a1, hd = Math.min(10 * px, d / 3);
      ctx.save(); ctx.setLineDash([]); ctx.lineWidth = 2 * px; ctx.beginPath(); ctx.moveTo(o.x + ux * a0, o.y + uy * a0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - ux * hd - uy * hd * .6, y1 - uy * hd + ux * hd * .6); ctx.lineTo(x1 - ux * hd + uy * hd * .6, y1 - uy * hd - ux * hd * .6); ctx.closePath(); ctx.fillStyle = "#ffb35c"; ctx.fill(); ctx.restore();
    }
  }
  ctx.restore();
}

function cmpGhostOpacity() { // a slider 10–100 %
  const r = h("input"), o = h("output"), w = h("span", "edrange"); r.type = "range"; r.min = 10; r.max = 100; r.step = 5; r.value = S.cmpGhostA ?? 70;
  const show = () => o.textContent = r.value + "%"; show();
  r.oninput = () => { S.cmpGhostA = +r.value; save(); show(); dirty = true; }; w.append(r, o); return w;
}

// ---------- the panel (Tools → Compare, editor tab Compare) ----------
function cmpCurrentText() { return typeof editedText === "function" ? editedText() : osuFiles[curDiff].text; }
function cmpOpenedText() { const o = osuFiles[curDiff]; return (typeof DRAFT !== "undefined" && DRAFT.origText && DRAFT.origText[o.path]) || o.text; }
function cmpUse(src, label, text) { CMP.src = src; CMP.label = label; CMP.text = text; CMP.filter = ""; CMP.key = mapKey(); rerenderCompare(); }
const mapKey = () => osuFiles[curDiff] ? osuFiles[curDiff].path : "";
function rerenderCompare() { if (EDIT.on && EDIT.tab === "compare") edTab("compare"); else if (toolsTab === "compare") renderTools(); }
function renderCompare(body) {
  if (CMP.set && CMP.set.forFiles !== osuFiles) { CMP.set = null; if (CMP.src === "set") CMP.src = "opened"; } // (another mapset was opened)
  if (CMP.key !== mapKey()) { if (CMP.src !== "set") { CMP.src = "opened"; CMP.text = null; } CMP.filter = ""; CMP.key = mapKey(); }
  let other = CMP.src === "opened" ? cmpOpenedText() : CMP.text;
  body.append(h("p", "hint", tr("What changed in [{v}] compared with another version. Click a row to jump there.", { v: map.meta.Version || "" })));
  const pick = h("div", "btnrow cmpsrc");
  const b1 = h("button", "chip" + (CMP.src === "opened" ? " on" : ""), tr("When you opened it")); b1.onclick = () => cmpUse("opened", "", null);
  const file = fileAccept(h("input"), ".osu,text/plain"); file.type = "file"; file.hidden = true;
  file.onchange = async () => { const f = file.files[0]; file.value = ""; if (!f) return; if (!fileIs(f, ["osu", "txt"])) return toast(tr("Pick an .osu file (one difficulty)"), 3000); cmpUse("file", f.name, await f.text()); };
  const b2 = h("button", "chip" + (CMP.src === "file" ? " on" : ""), CMP.src === "file" ? "📄 " + CMP.label : tr("An .osu file…")); b2.onclick = () => file.click();
  pick.append(b1, b2, file);
  if (typeof gdCompareButton === "function") { const b3 = gdCompareButton(); if (b3) pick.append(b3); }
  const zf = fileAccept(h("input"), ".osz,.zip"); zf.type = "file"; zf.hidden = true;
  zf.onchange = () => { const f = zf.files[0]; zf.value = ""; if (!f) return; if (!fileIs(f, ["osz", "zip"])) return toast(tr("Pick an .osz file (a beatmap package)"), 3000); cmpLoadSet(f); };
  const b4 = h("button", "chip" + (CMP.src === "set" ? " on" : ""), CMP.src === "set" ? "📦 " + CMP.label : tr("A whole set (.osz)…")); b4.onclick = () => zf.click();
  pick.insertBefore(b4, file); pick.append(zf);
  if (CMP.src === "drive") pick.append(h("button", "chip on", "☁ " + CMP.label));
  body.append(pick);
  if (CMP.src === "set" && CMP.set) {
    const m = cmpSetSummary(body);
    if (!m || !m.d) { body.append(h("p", "hint", tr("[{v}] isn't in the uploaded set.", { v: map.meta.Version || "" }))); return; }
    other = m.d.text;
    body.append(h("h4", "cmpdh", tr("[{v}] in detail", { v: map.meta.Version || "" })));
  }
  if (other == null) { body.append(h("p", "hint", tr("Pick the version to compare with."))); return; }
  if (map.mode !== 3) { // ghost in Compose
    const g = h("div", "cmpghost"), lab = h("label", "sw"), t2 = h("span", "swt"), i2 = h("input"); i2.type = "checkbox"; i2.className = "switch"; i2.checked = CMP.ghost;
    t2.append(h("b", null, tr("Ghost in Compose")), h("small", null, tr("The other version's objects that differ show as orange dashed outlines under yours, so you see before and after together")));
    i2.onchange = () => { CMP.ghost = i2.checked; dirty = true; go.hidden = !CMP.ghost || !EDIT.on; };
    lab.append(t2, i2);
    const go = h("button", "btn ghost sm", tr("Show in Compose")); go.type = "button"; go.hidden = !CMP.ghost || !EDIT.on; go.onclick = () => edTab("compose");
    const op = h("label", "row cmpghosta"); op.append(h("span", null, tr("Ghost opacity")), cmpGhostOpacity()); op.hidden = !CMP.ghost;
    const mv = h("label", "sw cmpghostmv"), t3 = h("span", "swt"), i3 = h("input"); i3.type = "checkbox"; i3.className = "switch"; i3.checked = cmpGhostMovedOnly(); mv.hidden = !CMP.ghost;
    t3.append(h("b", null, tr("Only moved objects")), h("small", null, tr("Hide objects whose only change is their hitsounds or new combo; an arrow shows where each moved object went")));
    i3.onchange = () => { S.cmpGhostMoved = i3.checked; save(); dirty = true; }; mv.append(t3, i3);
    i2.addEventListener("change", () => { op.hidden = mv.hidden = !CMP.ghost; });
    g.append(lab, mv, op, go); body.append(g);
  }
  const res = mapDiff(other, cmpCurrentText()), rows = res.rows;
  const counts = {}; for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const sum = h("div", "cmpsum");
  sum.append(h("b", null, rows.length ? tr("{n} changes", { n: rows.length }) : tr("No differences")), h("small", null, tr("{a} → {b} objects", { a: res.objects[0], b: res.objects[1] })));
  body.append(sum);
  if (!rows.length) return;
  const chips = h("div", "achips cmpchips");
  const chip = (k, l, n) => { const b = h("button", "chip" + (CMP.filter === k ? " on" : ""), l); if (n != null) b.append(h("small", null, " " + n)); b.type = "button"; b.onclick = () => { CMP.filter = CMP.filter === k ? "" : k; rerenderCompare(); }; chips.append(b); };
  chip("", tr("All"), rows.length);
  for (const [k, l] of CMP_KINDS) if (counts[k]) chip(k, tr(l), counts[k]);
  const cp = h("button", "btn ghost sm", tr("Copy as text"));
  const shown = rows.filter(r => !CMP.filter || r.kind === CMP.filter);
  cp.onclick = async () => toast(await copyText(shown.map(r => (r.t != null ? fmtMs(r.t) + " - " : "") + r.text).join("\n")) ? tr("Copied") : tr("Couldn't copy"));
  const rs = h("button", "btn ghost sm", tr("Go back to that version")); rs.onclick = () => cmpRestore(other);
  const acts = h("div", "btnrow"); acts.append(cp, rs);
  body.append(chips, acts);
  const list = h("div", "tlist cmplist");
  for (const r of shown.slice(0, 1500)) {
    const row = h(r.t != null ? "button" : "div", "cmprow " + r.kind); if (r.t != null) { row.type = "button"; row.dataset.t = Math.max(0, r.t - 300); row.dataset.go = "1"; }
    row.append(h("span", "cmpts", r.t != null ? fmtMs(r.t) : "—"), h("span", "cmpk", tr((CMP_KINDS.find(k => k[0] === r.kind) || ["", r.kind])[1])), h("span", "cmpt", r.text));
    list.append(row);
  }
  if (shown.length > 1500) list.append(h("p", "hint", tr("…and {n} more", { n: shown.length - 1500 })));
  body.append(list);
}

// put the other version's objects, timing and settings back into this difficulty, as one step you can undo (Ctrl+Z);
// objects that didn't change keep their identity (annotations stay attached to them)
async function cmpRestore(text) {
  if (!(await ask(tr("Replace this difficulty with the other version? You can undo it (Ctrl+Z)."), { ok: tr("Replace") }))) return;
  if (!EDIT.on) setMode(true);
  const m2 = parseOsu(text), keep = new Map();
  for (const L of map.lines) (keep.get(L.s) || keep.set(L.s, []).get(L.s)).push(L.id);
  const ok = edCommit(tr("Go back to another version"), () => {
    map.lines = m2.lines.map(L => { const q = keep.get(L.s); return { s: L.s, id: q && q.length ? q.shift() : newLineId() }; });
    map.timing = m2.timing; map.bookmarks = m2.bookmarks; map.general = m2.general; map.meta = m2.meta; map.diff = m2.diff; map.colourKV = m2.colourKV;
  });
  if (ok) { toast(tr("Done: this difficulty is back to that version (Ctrl+Z to undo)"), 3500); rerenderCompare(); }
}
