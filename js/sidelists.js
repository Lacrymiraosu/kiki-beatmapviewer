"use strict";
// ============ Compose: side lists of the mod notes and the annotations ============
// Two separate panels (each with its own button in the bottom bar), so they never cover each other: open one, or both
// stacked. Tap a row to go to its time (and select its object); the row at the current time is marked while you play or
// scrub, so it's easy to follow the notes through the map. The annotations list can delete all of them at once.
const SIDE = { timer: 0, key: "" };
function sideBox() {
  let box = $("edSide");
  if (!box) { box = h("div", "edside"); box.id = "edSide"; $("ui").append(box); }
  return box;
}
function sideOpen() { return !!(EDIT.on && EDIT.tab === "compose" && S.edAdv === true && (S.sideNotes || S.sideAnns || S.sideVfy)); } // (the lists are Advanced tools, editor.js edAdv)
function sideToggle(k) { S[k] = !S[k]; save(); sideRender(); sideButtons(); }
function sideButtons() {
  for (const [id, k] of [["edSideNotes", "sideNotes"], ["edSideAnns", "sideAnns"], ["edSideVfy", "sideVfy"]]) { const b = $(id); if (b) { b.classList.toggle("lit", !!S[k]); b.setAttribute("aria-pressed", !!S[k]); } }
  if (typeof edTrayDot === "function") edTrayDot(); // (the dot on the closed Tools tray, editor.js)
}
function sideRow(t, color, label, text, onGo, extra) {
  const r = h("div", "siderow"); r.style.setProperty("--c", color); r.dataset.t = String(Math.round(t));
  const go = h("button", "sidego"); go.append(h("b", null, label)); if (text) go.append(h("span", null, text));
  go.onclick = onGo; r.append(go); if (extra) r.append(extra);
  return r;
}
function sidePanel(title, n, acts, rows, empty, close) {
  const p = h("section", "sidepanel"), hd = h("div", "sidehead"), x = h("button", "icon qclose");
  x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; x.setAttribute("aria-label", tr("Close")); x.onclick = close;
  hd.append(h("b", null, `${tr(title)} (${n})`), ...acts, x);
  const list = h("div", "sidelist"); rows.forEach(r => list.append(r)); if (!rows.length) list.append(h("p", "hint", tr(empty)));
  p.append(hd, list); return p;
}
function sideRender() {
  const box = sideBox(), keep = [...box.querySelectorAll(".sidelist")].map(l => l.scrollTop); box.innerHTML = ""; box.hidden = !sideOpen();
  clearInterval(SIDE.timer); SIDE.key = "";
  if (box.hidden || !map) return;
  if (S.sideNotes) {
    const notes = loadNotes().sort((a, b) => a.t - b.t);
    const add = h("button", "btn ghost sm", tr("+ Note")); add.onclick = () => $("edNote").click();
    const rows = notes.map(n => sideRow(n.t, NOTE_COL[n.type] || "#66ccff", (n.ts || tsAt(n.t)).replace(/ - $/, ""), n.text, () => {
      seekTo(n.t); const o = map.hit.find(x => Math.abs(x.t - n.t) < 2); if (o) edSelectIds([o.lid]); dirty = true;
    }));
    box.append(sidePanel("Mod notes", notes.length, [add], rows, "No notes yet. Select objects and press \"+ Note\".", () => sideToggle("sideNotes")));
  }
  if (S.sideAnns) {
    const list = annActive().sort((a, b) => annTime(a) - annTime(b)), mine = list.filter(annCanEdit);
    const all = h("button", "btn ghost sm danger", tr("Delete all")); all.disabled = !mine.length;
    all.onclick = () => annDeleteAll();
    const rows = list.map(a => {
      const del = annCanEdit(a) ? h("button", "sidedel", "×") : null;
      if (del) { del.title = tr("Delete"); del.onclick = () => annDelete(a); }
      const r = sideRow(annTime(a), ANN_COL[a.kind], `${ANN_ICON[a.kind]} ${tsAt(annTime(a)).replace(/ - $/, "")}`, a.body || (a.object_missing ? tr("object deleted") : ""), () => annGo(a), del);
      if (ANN.sel === a.id) r.classList.add("sel");
      return r;
    });
    box.append(sidePanel("Annotations", list.length, [all], rows, "No annotations yet. Use 💬 ➚ ◎ in the bottom bar.", () => sideToggle("sideAnns")));
  }
  if (S.sideVfy) box.append(sideVerify());
  box.querySelectorAll(".sidelist").forEach((l, k) => { if (keep[k]) l.scrollTop = keep[k]; });
  // mark the row at the current time (and keep it in view while playing)
  SIDE.timer = setInterval(() => {
    if (!sideOpen()) return;
    const t = A.cur(), key = Math.round(t / 50);
    if (key === SIDE.key) return; SIDE.key = key;
    for (const list of box.querySelectorAll(".sidelist")) {
      let cur = null; for (const r of list.children) { if (!r.dataset.t) continue; r.classList.remove("now"); if (+r.dataset.t <= t + 30) cur = r; }
      if (cur) { cur.classList.add("now"); if (isPlaying()) cur.scrollIntoView({ block: "nearest" }); }
    }
  }, 200);
}
// quick verify: this difficulty's issues in time order; tap one to go there and select its objects, ◀ ▶ step through them
function sideVerify() {
  const res = vfyResults(), cur = res.diffs.find(d => d.x.i === curDiff), lv = VFY.lv;
  const all = cur ? cur.res.flatMap(r => r.issues.map(i => ({ i, r }))) : [], cnt = vfyCount(cur ? cur.res : []);
  const shown = all.filter(x => lv[x.i.lvl] && x.i.t != null).sort((a, b) => a.i.t - b.i.t);
  const gen = vfyCount(res.general);
  SIDE.vfy = shown;
  const chips = h("div", "sidechips");
  for (const k of ["problem", "warning", "minor"]) { const b = h("button", "vfychip sm" + (lv[k] ? " on" : "")); b.type = "button"; b.append(vfyIcon(k), " " + cnt[k]); b.title = tr(VFY_LVN[k]); b.onclick = () => { lv[k] = !lv[k]; sideRender(); }; chips.append(b); }
  const prev = h("button", "btn ghost sm", "◀"), next = h("button", "btn ghost sm", "▶"), re = h("button", "btn ghost sm", "↻"), full = h("button", "btn ghost sm", tr("Verify"));
  prev.title = tr("Previous issue"); next.title = tr("Next issue"); re.title = tr("Check again"); full.title = tr("Open the full Verify page");
  prev.onclick = () => sideVfyStep(-1); next.onclick = () => sideVfyStep(1); re.onclick = vfyRecheck; full.onclick = () => edTab("verify");
  const rows = shown.map(({ i, r }) => sideRow(i.t, { problem: "#ff5a6e", warning: "#ffcf6b", minor: "#8fa3c9" }[i.lvl], `${VFY_SYM[i.lvl]} ${vfyTs(i)}`, tr(i.msg, i.v), () => vfyJump(i, curDiff)));
  const p = sidePanel("Verify", shown.length, [prev, next, re, full], rows, "No issues here with these filters.", () => sideToggle("sideVfy"));
  p.querySelector(".sidehead").after(chips);
  if (vfyHeld()) chips.after(h("p", "hint vfystale", tr(S.vfyAuto !== false ? "Checking again when you stop editing…" : "These results are from before your latest edits.")));
  if (gen.problem + gen.warning) { const g = h("button", "sidegen", tr("+ {n} for the whole mapset (metadata, files…)", { n: gen.problem + gen.warning })); g.onclick = () => { VFY.tab = S.vfyTab = "checks"; VFY.scope = "general"; save(); edTab("verify"); }; p.querySelector(".sidelist").before(g); }
  const b = $("edSideVfy"); if (b) b.dataset.n = cnt.problem || "";
  return p;
}
function sideVfyStep(dir) {
  const L = SIDE.vfy || []; if (!L.length) return toast(tr("No issues here with these filters."), 1500);
  const t = A.cur(), x = dir > 0 ? L.find(x => x.i.t > t + 2) || L[0] : [...L].reverse().find(x => x.i.t < t - 2) || L[L.length - 1];
  vfyJump(x.i, curDiff);
}
async function annDeleteAll() {
  const mine = annActive().filter(annCanEdit); if (!mine.length) return;
  const others = annActive().length - mine.length;
  if (!(await ask(tr("Delete all {n} annotations of this difficulty?", { n: mine.length }) + (others ? "\n" + tr("({n} made by other people stay.)", { n: others }) : ""), { ok: tr("Delete"), danger: true }))) return;
  for (const a of mine) { if (!a.version) ANN.list = ANN.list.filter(x => x !== a); else { a.local = "deleted"; a.updated_at = new Date().toISOString(); } if (COLLAB.on) collabAnnChanged(a); }
  ANN.sel = ""; dirty = true; drawTimeline(); annRerender(); draftSchedule(); cloudTouch();
  toast(tr("Deleted {n} annotations (undo isn't possible)", { n: mine.length }), 2500);
}
// the three list buttons in the bottom bar, before the annotation tools: an icon and a name (the name hides on phones)
(() => {
  const ICON = {
    sideNotes: '<path d="M5 4h14v10l-6 6H5z"/><path d="M13 20v-6h6M8.5 9h7M8.5 12.5h3"/>',
    sideAnns: '<path d="M10 6h10M10 12h10M10 18h10"/><circle cx="5" cy="6" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="5" cy="18" r="1.2"/>',
    sideVfy: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.4l2.8 2.8L16.2 9.8"/>',
  };
  const mk = (id, label, title, k) => {
    const b = h("button", "btn ghost sm sidebtn adv"); b.id = id; b.dataset.i18nTitle = title; b.title = tr(title); b.setAttribute("aria-pressed", "false"); b.onclick = () => sideToggle(k);
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
    const n = h("span", "sbname", tr(label)); n.dataset.i18n = label; b.append(n); return b;
  };
  const a0 = document.querySelector(".annbtns"), a = typeof dockHome === "function" ? dockHome(a0) : a0; // (its home in #edInfo, also when an upright phone docked it in the tray: editor.js)
  a.parentNode.insertBefore(mk("edSideNotes", "Notes", "List of mod notes (follow them through the map)", "sideNotes"), a);
  a.parentNode.insertBefore(mk("edSideAnns", "Annotations", "List of annotations (delete all is here)", "sideAnns"), a);
  a.parentNode.insertBefore(mk("edSideVfy", "Verify", "Quick verify: this difficulty's issues, tap one to go there", "sideVfy"), a);
  sideButtons();
})();
