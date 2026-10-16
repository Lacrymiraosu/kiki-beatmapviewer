"use strict";
// ============ the Timing and Control Points window (F6), like osu!stable's ============
// A floating window over the editor: the points on the right (All / Timing points / Inherited points), the selected
// one's Timing / Audio / Style on the left. It works on a copy of map.timing (each copy keeps its original in _o);
// OK applies everything, with the options under "When applying timing changes…", as one undo step; Cancel, Esc and F6
// drop it. A changed map underneath (undo, collab) is picked up the next time it opens.
const TW = { el: null, list: [], sel: null, tab: "timing", ltab: "all", ro: false, map: null, changed: false, armed: 0, rows: new Map() };
const TW_KEYS = ["time", "beat", "meter", "uninherited", "kiai", "omit", "sampleSet", "sampleIndex", "volume"];
const TW_FULL = matchMedia("(max-width:760px), (max-height:520px)"); // (phones: a full-screen panel, not dragged)
const twOpts = () => S.tw = { scale: true, snap: false, slen: false, extras: true, div: S.snap || 4, ...(S.tw || {}) };
const twSort = () => TW.list.sort((a, b) => a.time - b.time || (b.uninherited ? 1 : 0) - (a.uninherited ? 1 : 0)); // (the order timingDerived keeps)
const twRedBefore = (t, not) => { let r = null; for (const c of TW.list) { if (c.time > t + 1) break; if (c !== not && c.uninherited && c.beat > 0) r = c; } return r; };
const twSame = c => !!c._o && TW_KEYS.every(k => Object.is(c[k], c._o[k])); // (Object.is: a NaN green line stays as it was)
const twSampText = c => { const l = "ANSD"[c.sampleSet | 0] || "A"; return c.sampleIndex ? `${l}:C${c.sampleIndex}` : l; };
const twSvText = c => "x" + (c.beat < 0 ? Math.round(-100 / c.beat * 100) / 100 : 1);
function twToggle() { if (TW.el) twClose(true); else twShow(); }
function twShow() {
  if (!EDIT.on || !map || TW.el) return;
  if (EDIT.dlg === "timing") closeDlg(); // (one timing editor at a time)
  TW.ro = !can("editor") || !liveCanEdit() || !collabCanEdit();
  TW.map = map; TW.changed = false; TW.armed = 0;
  TW.list = map.timing.map(tp => ({ ...tp, _o: tp }));
  const t = A.cur(); TW.sel = null; for (const c of TW.list) { if (c.time > t + 1) break; TW.sel = c; }
  if (!TW.sel) TW.sel = TW.list[0] || null;
  twBuild();
  if (TW.ro) toast(tr(LIVE.on ? "View only: ask the host for edit permission" : COLLAB.on ? "View only: the host of this collab session made you a viewer" : "view only"));
}
function twClose(ask) {
  if (!TW.el) return;
  if (ask && TW.changed && !TW.ro && performance.now() - TW.armed > 2500) { TW.armed = performance.now(); toast(tr("Press again to discard the changes"), 2500); return; } // (Esc / F6 twice: nothing typed is lost to a stray key)
  TW.el.remove(); TW.el = null; TW.list = []; TW.sel = null; TW.rows.clear(); dirty = true;
}
function twBuild() {
  const el = h("div", "twin"); TW.el = el; el.tabIndex = -1; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", tr("Timing and Control Points"));
  const head = h("div", "twhead"), x = h("button", "icon qclose"); x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; x.setAttribute("aria-label", tr("Close")); x.onclick = () => twClose(true);
  head.append(h("b", null, tr("Timing and Control Points"))); if (TW.ro) head.append(h("small", "twro", tr("view only"))); head.append(x);
  const tabs = (items, key, fn) => { const r = h("div", "tabs twtabs"); r.setAttribute("role", "tablist"); for (const [k, l] of items) { const b = h("button", "tab", tr(l)); b.type = "button"; b.dataset.k = k; b.onclick = () => { TW[key] = k; fn(); }; r.append(b); } return r; };
  const body = h("div", "twbody"), left = h("div", "twleft"), right = h("div", "twright");
  TW.tabsL = tabs([["timing", "Timing"], ["audio", "Audio"], ["style", "Style"]], "tab", twLeft); TW.pane = h("div", "twpane");
  left.append(TW.tabsL, TW.pane);
  TW.tabsR = tabs([["all", "All"], ["red", "Timing points"], ["green", "Inherited points"]], "ltab", twTable);
  const tbl = h("div", "twtbl"), table = h("table"), thead = h("thead"), hr = h("tr");
  for (const c of ["Offset", "BPM", "Meter", "Sample", "Vol.", "Kiai"]) hr.append(h("th", null, tr(c)));
  thead.append(hr); TW.tbody = h("tbody"); table.append(thead, TW.tbody); tbl.append(table); TW.tbl = tbl;
  // under the list: the selected point red or green ("inherit"), add one at the song's time, delete it
  const lf = h("div", "twlfoot"), il = h("label", "chkrow"), inh = h("input"); inh.type = "checkbox"; TW.inh = inh;
  inh.onchange = () => twInherit(inh.checked); il.append(inh, h("span", null, tr("Inherit previous timing settings")));
  const add = h("button", "btn ghost sm", "+"), del = h("button", "btn ghost sm", "✕"); add.type = del.type = "button";
  add.title = tr("Add a point at the current time"); add.setAttribute("aria-label", add.title); add.onclick = twAdd;
  del.title = tr("Delete the selected point"); del.setAttribute("aria-label", del.title); del.onclick = twDelete; TW.del = del;
  if (TW.ro) add.disabled = del.disabled = true;
  lf.append(il, add, del); right.append(TW.tabsR, tbl, lf);
  body.append(left, right);
  // what else follows the timing on OK (kept in the settings)
  const O = twOpts(), ap = h("div", "twapply"), ops = h("div", "twopts");
  ap.append(h("h4", null, tr("When applying timing changes…")));
  for (const [k, l] of [["scale", "Scale objects to new timing"], ["snap", "Snap objects to new timing"], ["slen", "Resnap slider lengths"], ["extras", "Adjust bookmarks and audio preview"]]) {
    const r = h("label", "chkrow"), c = h("input"); c.type = "checkbox"; c.checked = !!O[k]; c.disabled = TW.ro;
    c.onchange = () => { twOpts()[k] = c.checked; save(); }; r.append(c, h("span", null, tr(l))); ops.append(r);
  }
  const dr = h("label", "chkrow twdiv"), ds = h("select"); for (const d of DIVS) ds.add(new Option("1/" + d, d)); ds.value = O.div; ds.disabled = TW.ro;
  ds.onchange = () => { twOpts().div = +ds.value; save(); }; dr.append(h("span", null, tr("Use beat snap divisor of")), ds); ops.append(dr);
  ap.append(ops);
  const foot = h("div", "twfoot"), cancel = h("button", "btn ghost", tr(TW.ro ? "Close" : "Cancel")), ok = h("button", "btn main", tr("OK"));
  cancel.type = ok.type = "button"; cancel.onclick = () => twClose(false); ok.onclick = twApply; foot.append(cancel); if (!TW.ro) foot.append(ok);
  el.append(head, body, ap, foot);
  // keys: Esc / F6 close; ↑ ↓ walk the list; the editor's own keys (Q, Ctrl+Z…) don't reach the map behind it
  el.addEventListener("keydown", e => {
    const field = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== "checkbox" && e.target.type !== "radio";
    if (e.code === "F6" || e.code === "Escape") { e.preventDefault(); e.stopPropagation(); twClose(true); return; }
    if (!field && (e.code === "ArrowUp" || e.code === "ArrowDown")) { e.preventDefault(); e.stopPropagation(); twStep(e.code === "ArrowDown" ? 1 : -1); return; }
    if (e.code === "Space" && !field && e.target.tagName !== "BUTTON") return; // (play / pause still works)
    e.stopPropagation();
  });
  head.addEventListener("pointerdown", e => { // drag it by the title bar
    if (e.target.closest("button") || TW_FULL.matches || e.button) return;
    const r = el.getBoundingClientRect(), P = UI.player.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId); e.preventDefault();
    const mv = ev => { el.style.left = Math.max(0, Math.min(P.width - r.width, ev.clientX - dx - P.left)) + "px"; el.style.top = Math.max(0, Math.min(P.height - 48, ev.clientY - dy - P.top)) + "px"; };
    const up = () => { head.removeEventListener("pointermove", mv); head.removeEventListener("pointerup", up); head.removeEventListener("pointercancel", up); };
    head.addEventListener("pointermove", mv); head.addEventListener("pointerup", up); head.addEventListener("pointercancel", up);
  });
  UI.player.append(el);
  twLeft(); twTable();
  const P = UI.player.getBoundingClientRect(); // centred on open
  el.style.left = Math.max(0, (P.width - el.offsetWidth) / 2) + "px"; el.style.top = Math.max(0, (P.height - el.offsetHeight) / 2) + "px";
  el.focus({ preventScroll: true });
}
addEventListener("resize", () => { const el = TW.el; if (!el || TW_FULL.matches) return; const P = UI.player.getBoundingClientRect();
  el.style.left = Math.max(0, Math.min(P.width - el.offsetWidth, parseFloat(el.style.left) || 0)) + "px"; el.style.top = Math.max(0, Math.min(P.height - 48, parseFloat(el.style.top) || 0)) + "px"; });
// ---------- the list ----------
function twTable() {
  TW.tabsR.querySelectorAll(".tab").forEach(b => { b.classList.toggle("on", b.dataset.k === TW.ltab); b.setAttribute("aria-selected", b.dataset.k === TW.ltab); });
  const tb = TW.tbody; tb.innerHTML = ""; TW.rows.clear();
  const L = TW.list.filter(c => TW.ltab === "all" || (TW.ltab === "red") === !!c.uninherited);
  for (const c of L.slice(0, 5000)) { const r = h("tr"); twRowFill(r, c); r.onclick = () => twSelect(c, true); tb.append(r); TW.rows.set(c, r); }
  if (!L.length) { const r = h("tr", "twempty"), d = h("td", "hint", tr("No timing points yet. Add a red line at the first beat of the song.")); d.colSpan = 6; r.append(d); tb.append(r); }
  twInhSync(); twScroll();
}
function twRowFill(r, c) {
  r.className = (c.uninherited ? "red" : "green") + (c === TW.sel ? " on" : ""); r.innerHTML = "";
  const at = h("td", "twat"); at.append(h("i", "twdot"), fmtMsExact(c.time)); r.append(at);
  r.append(h("td", null, c.uninherited ? tpBpmText(c) : twSvText(c)), h("td", null, c.uninherited ? (c.meter || 4) + "/4" : ""), h("td", null, twSampText(c)), h("td", null, String(Math.round(c.volume))), h("td", "twk", c.kiai ? "☆" : ""));
}
const twRow = c => { const r = TW.rows.get(c); if (r) twRowFill(r, c); };
const twScroll = () => requestAnimationFrame(() => { const r = TW.rows.get(TW.sel); if (r && TW.tbl) { const T = TW.tbl, top = r.offsetTop - T.querySelector("thead").offsetHeight; if (top < T.scrollTop || r.offsetTop + r.offsetHeight > T.scrollTop + T.clientHeight) T.scrollTop = top - T.clientHeight / 3; } });
function twSelect(c, seek) {
  const was = TW.sel; TW.sel = c; if (was) twRow(was); if (c) twRow(c);
  twLeft(); twInhSync(); twScroll();
  if (seek && c && isFinite(c.time)) { seekTo(c.time); showUI(); } // (like stable: a row takes the song there)
}
function twStep(d) { const L = [...TW.rows.keys()]; if (!L.length) return; const i = L.indexOf(TW.sel); twSelect(L[Math.max(0, Math.min(L.length - 1, i < 0 ? 0 : i + d))], true); }
function twInhSync() {
  const c = TW.sel, i = TW.inh; if (!i) return;
  i.checked = !!c && !c.uninherited;
  i.disabled = TW.ro || !c || (c.uninherited && !twRedBefore(c.time, c)); // (the first red line has nothing to inherit from)
  if (TW.del) TW.del.disabled = TW.ro || !c;
}
// changed: the row (and the order, when the offset moved)
function twChanged(c, order) {
  TW.changed = true;
  if (order) { const before = TW.list.indexOf(c); twSort(); if (TW.list.indexOf(c) !== before) return twTable(); }
  twRow(c);
}
function twInherit(green) {
  const c = TW.sel; if (!c || TW.ro || green === !c.uninherited) return;
  if (green) { c.uninherited = false; c.beat = -100; c.omit = false; } // (1x, like stable)
  else { const u = twRedBefore(c.time, c) || { beat: 500, meter: 4 }; c.uninherited = true; c.beat = u.beat; c.meter = u.meter || 4; }
  TW.changed = true; twSort(); twTable(); twLeft();
}
function twAdd() {
  if (TW.ro) return;
  const t = Math.round(A.cur()), red = TW.ltab === "red" || TW.ltab === "all" && !twRedBefore(t); // (green after the first red line, like stable)
  const dup = TW.list.find(c => !!c.uninherited === red && Math.abs(c.time - t) < 1);
  if (dup) { toast(tr("There's already a point here")); return twSelect(dup); }
  const c = { ...newTpAt(t, red, TW.list), _o: null }; TW.list.push(c); twSort();
  TW.sel = c; TW.changed = true; twTable(); twLeft();
}
function twDelete() {
  const c = TW.sel; if (!c || TW.ro) return;
  const L = [...TW.rows.keys()], i = L.indexOf(c); TW.list.splice(TW.list.indexOf(c), 1);
  TW.sel = L[i + 1] || L[i - 1] || TW.list[0] || null; TW.changed = true; twTable(); twLeft();
}
// ---------- the selected point ----------
// a number field with − / + (Shift: ×10); parse reads what is typed, fmt writes it back
function twSpin(get, set, step, o = {}) {
  const w = h("span", "twspin"), m = h("button", "btn ghost sm", "−"), i = h("input"), p = h("button", "btn ghost sm", "+"), fmt = o.fmt || (v => String(Math.round(v * 1000) / 1000)), parse = o.parse || (s => +String(s).replace(",", "."));
  m.type = p.type = "button"; i.type = "text"; i.inputMode = "decimal"; i.value = isFinite(get()) ? fmt(get()) : ""; if (o.label) i.setAttribute("aria-label", tr(o.label)); if (o.title) i.title = tr(o.title);
  const okv = v => isFinite(v) && (o.min == null || v >= o.min) && (o.max == null || v <= o.max);
  i.oninput = () => { const v = parse(i.value), ok = i.value.trim() !== "" && okv(v); i.classList.toggle("bad", !ok); if (ok) set(v); };
  i.onblur = () => { if (!i.classList.contains("bad") && isFinite(get())) i.value = fmt(get()); };
  const by = d => e => { let v = Math.round(((isFinite(get()) ? get() : 0) + d * step * (e.shiftKey ? 10 : 1)) * 1e6) / 1e6; if (o.min != null) v = Math.max(o.min, v); if (o.max != null) v = Math.min(o.max, v); set(v); i.value = fmt(v); i.classList.remove("bad"); };
  m.onclick = by(-1); p.onclick = by(1); m.setAttribute("aria-label", "−"); p.setAttribute("aria-label", "+");
  w.append(m, i, p); w.inp = i; return w;
}
function twLeft() {
  const P = TW.pane, c = TW.sel; P.innerHTML = "";
  TW.tabsL.querySelectorAll(".tab").forEach(b => { b.classList.toggle("on", b.dataset.k === TW.tab); b.setAttribute("aria-selected", b.dataset.k === TW.tab); });
  if (!c) { P.append(h("p", "hint", tr("No timing points yet. Add a red line at the first beat of the song."))); return; }
  const row = (label, ...els) => { const r = h("div", "twrow"); r.append(h("span", "twlbl", tr(label)), ...els); P.append(r); return r; };
  const radio = (name, label, on, fn, extra) => { const l = h("label", "twradio"), i = h("input"); i.type = "radio"; i.name = name; i.checked = on; i.onchange = () => i.checked && fn(); l.append(i, h("span", null, tr(label))); if (extra) l.append(extra); return l; };
  if (TW.tab === "timing") {
    if (c.uninherited) row("BPM", twSpin(() => 60000 / c.beat, v => { c.beat = 60000 / v; twChanged(c); }, 1, { min: .001, max: 100000, label: "BPM" }));
    else { // a green line: the BPM it inherits (greyed), and its slider velocity
      const u = twRedBefore(c.time, c), b = h("input"); b.type = "text"; b.disabled = true; b.value = u ? tpBpmText(u) : "–"; b.title = tr("Inherited points keep the BPM of the red line before them"); b.setAttribute("aria-label", tr("BPM"));
      row("BPM", b);
      row("Slider velocity", twSpin(() => c.beat < 0 ? -100 / c.beat : 1, v => { c.beat = -100 / v; twChanged(c); }, .05, { min: .01, max: 10, label: "Slider velocity" }));
    }
    // the offset the way osu! writes it (96930); 01:36:930 typed or pasted works too
    const ts = h("small", "twts", fmtMsExact(c.time)), off = twSpin(() => c.time, v => { c.time = v; ts.textContent = fmtMsExact(v); twChanged(c, true); }, 1, { parse: parseOsuTime, fmt: msText, label: "Offset", title: "Offset in ms, like osu! (96930). A time like 01:36:930 works too" });
    const ow = h("div", "twoff"); ow.append(off, ts); row("Offset", ow);
    const now = h("button", "btn ghost sm twnow", tr("Use current time")); now.type = "button";
    now.onclick = () => { c.time = Math.round(A.cur()); off.inp.value = msText(c.time); off.inp.classList.remove("bad"); ts.textContent = fmtMsExact(c.time); twChanged(c, true); };
    row("", now);
    // time signature (red lines): 3/4, 4/4 or any n/4
    const m = c.meter || 4, oth = h("input"); oth.type = "text"; oth.inputMode = "numeric"; oth.value = m === 3 || m === 4 ? "" : m; oth.setAttribute("aria-label", tr("Time signature"));
    const setM = v => { c.meter = v; twChanged(c); };
    oth.oninput = () => { const v = Math.round(+oth.value); oth.classList.toggle("bad", !(v >= 1 && v <= 99)); if (v >= 1 && v <= 99) { setM(v); ro.querySelector(".twoth input[type=radio]").checked = true; } };
    const ro = h("div", "twsig");
    ro.append(radio("twm", "3/4 (waltz)", m === 3, () => setM(3)), radio("twm", "4/4 (common)", m === 4, () => setM(4)));
    const ol = radio("twm", "Other:", m !== 3 && m !== 4, () => { const v = Math.round(+oth.value); setM(v >= 1 && v <= 99 ? v : 4); }, oth); ol.classList.add("twoth"); ol.append(h("span", null, "/4")); ro.append(ol);
    row("Time signature", ro);
    if (!c.uninherited) ro.querySelectorAll("input").forEach(x => x.disabled = true);
  } else if (TW.tab === "audio") {
    const ss = h("div", "twsig"); // (a list, like stable's; Auto = the map's own sample set)
    for (const [v, l] of SAMPLE_SETS) ss.append(radio("tws", l, (c.sampleSet | 0) === v, () => { c.sampleSet = v; twChanged(c); }));
    row("Sample set", ss);
    const ix = c.sampleIndex | 0, num = h("input"); num.type = "text"; num.inputMode = "numeric"; num.value = ix > 1 ? ix : ""; num.setAttribute("aria-label", tr("Custom index"));
    const setI = v => { c.sampleIndex = v; twChanged(c); }, ci = h("div", "twsig");
    num.oninput = () => { const v = Math.round(+num.value); num.classList.toggle("bad", !(v >= 0 && v <= 999 && num.value.trim() !== "")); if (v >= 0 && v <= 999 && num.value.trim() !== "") { setI(v); ci.querySelector(".twoth input[type=radio]").checked = true; } };
    ci.append(radio("twi", "Default", ix === 0, () => setI(0)), radio("twi", "Custom 1", ix === 1, () => setI(1)));
    const cl = radio("twi", "Custom:", ix > 1, () => { const v = Math.round(+num.value); setI(v >= 2 && v <= 999 ? v : 2); if (!num.value) num.value = 2; }, num); cl.classList.add("twoth"); ci.append(cl);
    row("Custom index", ci);
    const vw = h("div", "twvol"), vr = h("input"), vn = h("input"); vr.type = "range"; vr.min = 5; vr.max = 100; vr.value = c.volume; vn.type = "number"; vn.min = 5; vn.max = 100; vn.value = Math.round(c.volume);
    vr.setAttribute("aria-label", tr("Volume")); vn.setAttribute("aria-label", tr("Volume"));
    vr.oninput = () => { c.volume = +vr.value; vn.value = vr.value; twChanged(c); };
    vn.oninput = () => { const v = Math.round(+vn.value); const ok = vn.value !== "" && v >= 5 && v <= 100; vn.classList.toggle("bad", !ok); if (ok) { c.volume = v; vr.value = v; twChanged(c); } };
    vw.append(vr, vn); row("Volume", vw);
    // hear the sample set at this volume
    const pl = h("div", "twplays");
    for (const [k, l] of [["normal", "Hit"], ["finish", "Finish"], ["whistle", "Whistle"], ["clap", "Clap"]]) { const b = h("button", "btn ghost sm twplay", tr(l)); b.type = "button"; b.onclick = () => twPlay(k); pl.append(b); }
    P.append(pl);
  } else {
    const sw = (label, hint, get, set, off) => { const l = h("label", "twsw"), i = h("input"); i.type = "checkbox"; i.className = "switch"; i.checked = get(); i.disabled = !!off; i.onchange = () => { set(i.checked); twChanged(c); }; l.append(h("span", null, tr(label)), i); P.append(l, h("p", "hint", tr(hint))); };
    sw("Kiai time", "Brighter lights and effects from here on: for the chorus or the most intense part of the song.", () => !!c.kiai, v => c.kiai = v);
    sw("Omit first bar line", "Red lines only: the bar line at this point isn't drawn (osu!taiko and osu!mania).", () => !!c.omit && !!c.uninherited, v => c.omit = v, !c.uninherited);
  }
  if (TW.ro) P.querySelectorAll("input,select,button:not(.twplay)").forEach(x => x.disabled = true);
}
function twPlay(kind) {
  const c = TW.sel; if (!c || !map) return;
  ensureAudioCtx(); preloadDefaults(); if (!actx) return;
  playBuf(sampleFor(SETS[c.sampleSet || map.defSet] || "normal", "hit" + kind, c.sampleIndex | 0), (c.volume || 100) / 100 * hsGain(), 0);
}
// ---------- OK: everything as one undo step ----------
function twApply() {
  if (TW.ro) return twClose();
  if (TW.map !== map) { twClose(); return; } // (another difficulty is open now)
  twSort();
  const bad = TW.list.find(c => !twSame(c) && (!isFinite(c.time) || c.uninherited && !(c.beat > 0 && isFinite(c.beat)) || !c.uninherited && c.beat >= 0)); // (a NaN green line is 1x, like osu!)
  if (bad) { if (!TW.rows.has(bad)) { TW.ltab = "all"; twTable(); } twSelect(bad); return toast(tr("Check the values")); }
  const out = TW.list.map(c => { if (twSame(c)) return c._o; const q = { ...c }; delete q._o; delete q.raw; if (!q.uninherited) q.omit = false; return q; });
  const old = map.timing, redSig = L => L.filter(tp => tp.uninherited && tp.beat > 0).map(tp => tp.time + "/" + tp.beat).join(), redChanged = redSig(old) !== redSig(out);
  if (out.length === old.length && out.every((tp, i) => tp === old[i])) return twClose();
  // where a time goes: it keeps its beat position under the red line it was under (its offset and BPM as they are now)
  const newOf = new Map(); TW.list.forEach((c, i) => { if (c._o) newOf.set(c._o, out[i]); });
  const segs = old.filter(tp => tp.uninherited && tp.beat > 0).map(R => { const n = newOf.get(R); return { t: R.time, b: R.beat, n: n && n.uninherited && n.beat > 0 ? n : null }; });
  const mapT = t => { if (!segs.length || !isFinite(t)) return t; const s = segs[Math.max(0, lastBefore(segs, t + 1, "t"))]; return s.n ? s.n.time + (t - s.t) * s.n.beat / s.b : t; };
  const O = twOpts(), div = +O.div || S.snap || 4;
  const moved = new Set(); // (the objects whose time changed)
  const ok = edCommit("Timing and Control Points", () => {
    if (redChanged && O.scale) {
      out.forEach((tp, i) => { if (!tp.uninherited && twSame(TW.list[i])) { const t2 = Math.round(mapT(tp.time)); if (t2 !== tp.time) { out[i] = { ...tp, time: t2 }; delete out[i].raw; } } }); // (green lines you didn't touch stay with their objects)
      for (const L of map.lines) {
        const p = L.s.split(","), type = +p[3]; if (p.length < 4) continue;
        const t0 = +p[2]; p[2] = Math.round(mapT(t0)); if (p[2] !== t0) moved.add(L.id);
        if (type & 8) p[5] = Math.round(mapT(+p[5]));
        else if (type & 128 && p[5]) { const q = p[5].split(":"); q[0] = Math.round(mapT(+q[0])); p[5] = q.join(":"); } // (an osu!mania hold's end)
        L.s = p.join(",");
      }
      map.breaks = map.breaks.map(([a, b]) => [Math.round(mapT(a)), Math.round(mapT(b))]);
    }
    if (redChanged && O.extras) {
      map.bookmarks = map.bookmarks.map(b => Math.round(mapT(b))).filter(b => b >= 0);
      const pv = +map.general.PreviewTime; if (map.general.PreviewTime != null && pv >= 0) map.general.PreviewTime = String(Math.max(0, Math.round(mapT(pv))));
    }
    map.timing = out; timingDerived(map); // (the snapping below follows the new timing)
    if (redChanged && (O.snap || O.slen)) for (const L of map.lines) {
      const p = L.s.split(","), type = +p[3]; if (p.length < 4) continue;
      if (O.snap) {
        const t0 = +p[2]; p[2] = snapTime(t0, div); if (p[2] !== t0) moved.add(L.id);
        if (type & 8) p[5] = Math.max(p[2], snapTime(+p[5], div));
        else if (type & 128 && p[5]) { const q = p[5].split(":"); q[0] = Math.max(p[2], snapTime(+q[0], div)); p[5] = q.join(":"); }
      }
      if (O.slen && type & 2 && +p[7] > 0) { // the length a whole number of 1/div beats, like osu!'s placement
        const { sv } = timingAt(map, +p[2]), step = +(map.diff.SliderMultiplier || 1.4) * 100 * sv / div;
        p[7] = Math.round(Math.max(1, Math.round(+p[7] / step)) * step * 1000) / 1000;
      }
      L.s = p.join(",");
    }
  }, { keepPanel: true });
  if (!ok) return;
  TW.changed = false; twClose();
  if (EDIT.tab === "timing") edTab("timing");
  toast(moved.size ? tr("Timing changes applied ({n} objects moved)", { n: moved.size }) : tr("Timing changes applied"), 2000);
}
