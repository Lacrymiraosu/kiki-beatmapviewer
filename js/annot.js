"use strict";
// ============ modding annotations: comments, arrows, highlights ============
// Explain an issue right on the playfield. Each annotation belongs to one difficulty (its .osu file) and points at an
// object by its stable id (see adoptIds), with the time as a fallback: when the object moves, the annotation moves with
// it; when the object is deleted the annotation says so and keeps its last time. It is never re-attached to another
// object. Annotations are kept apart from the .osu data: in drafts on this device, and with Save online in the project.
const ANN = { list: [], tool: "", drag: null, sel: "", role: "" };
const ANN_COL = { comment: "#ffd84a", arrow: "#ff66aa", highlight: "#66ccff" };
const ANN_ICON = { comment: "💬", arrow: "➚", highlight: "◎" };
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
const annMe = () => AUTH.user ? { id: AUTH.user.id > 0 && !AUTH.user.dev ? AUTH.user.id : 0, username: AUTH.user.username } : { id: 0, username: "" };
const curPath = () => osuFiles[curDiff] ? osuFiles[curDiff].path : "";

// ---------- state ----------
function annReset(list) { ANN.list = (list || []).map(a => ({ ...a })); ANN.sel = ""; ANN.drag = null; annSetTool(""); annRerender(); }
function annImport(list) { ANN.list = (list || []).map(a => ({ ...a })); annAfterRebuild(); annRerender(); dirty = true; }
const annExport = () => ANN.list.map(a => ({ ...a }));
// "local" = changed here and not saved online yet (for maps that aren't online projects, every annotation is local)
const annIsLocal = a => !a.version || !!a.local;
const annHasLocal = () => ANN.list.some(annIsLocal);
const annActive = () => ANN.list.filter(a => a.diff === curPath() && a.local !== "deleted");
// who may change what: in an online project only the author (or the project owner) edits the text; elsewhere it's yours
function annCanEdit(a) {
  if (COLLAB.on && !collabCanEdit()) return false;
  if (!ANN.role) return true;
  const me = annMe();
  return ANN.role === "owner" || !!me.id && a.author && a.author.id === me.id;
}
const annCanCreate = () => (!COLLAB.on || collabCanEdit()) && (!ANN.role || ANN.role === "owner" || ANN.role === "editor");
function annTouch(a, how) { if (a.version) a.local = a.local === "new" ? "new" : how; else a.local = "new"; a.updated_at = new Date().toISOString(); }

// keep anchors in step with the objects (called after every rebuild of the open diff)
function annAfterRebuild() {
  if (!map || !ANN.list.length) return;
  const byId = new Map(map.hit.map(o => [String(o.lid), o])), path = curPath();
  for (const a of ANN.list) {
    if (a.diff !== path || !a.object_id || a.local === "deleted") continue;
    const o = byId.get(String(a.object_id));
    if (o) {
      if (a.object_missing || a.time_ms !== Math.round(o.t)) { a.object_missing = false; a.time_ms = Math.round(o.t); if (!a.local) a.local = "anchor"; }
    } else if (!a.object_missing) { a.object_missing = true; if (!a.local) a.local = "anchor"; }
  }
  if (EDIT.tab === "notes" && EDIT.on) annRerender();
}
function annObj(a) {
  if (!a.object_id || !map) return null;
  if (ANN.lidHit !== map.hit) { ANN.lidHit = map.hit; ANN.lidMap = new Map(map.hit.map(o => [String(o.lid), o])); }
  return ANN.lidMap.get(String(a.object_id)) || null;
}
const annTime = a => { const o = annObj(a); return o ? o.t : a.time_ms; };

// ---------- creating ----------
// Quick flow: a highlight or an arrow is added at once (its note is optional, typed in the bar that opens); a comment
// opens the same bar for its text. Enter saves, Esc closes. The old dialog stays for opening an annotation from the list.
function annCreate(kind, o, data, quiet) {
  if (!annCanCreate()) return toast(tr("View only: you can't add annotations to this project"), 2500);
  const t = o ? Math.round(o.t) : Math.round(A.cur()), me = annMe();
  const a = { id: uuid(), diff: curPath(), kind, object_id: o ? String(o.lid) : null, time_ms: t, body: "", data: data || {}, object_missing: false,
    author: me, version: 0, local: "new", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (kind === "comment") return annQuick(a, true);
  ANN.list.push(a); ANN.sel = a.id; annChanged("add", a);
  if (!quiet) annQuick(a, false);
  return a;
}
function annBar() {
  let b = $("qann"); if (b) return b;
  b = h("div", "qnote qann"); b.id = "qann"; b.hidden = true;
  const lab = h("span", "qannlab"), txt = h("input", "qtext"), save = h("button", "btn main sm", tr("Save")), del = h("button", "btn ghost sm", tr("Delete")), close = h("button", "icon qclose");
  txt.type = "text"; txt.maxLength = 2000; txt.enterKeyHint = "done";
  save.dataset.i18n = "Save"; del.dataset.i18n = "Delete";
  close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; close.dataset.i18nAria = "Close"; close.setAttribute("aria-label", tr("Close"));
  const row = h("div", "qrow"); row.append(lab, txt, save, del, close); b.append(row);
  save.onclick = () => annQuickSave(); close.onclick = () => annQuickClose(); del.onclick = () => { const a = ANN.quick && ANN.quick.a; annQuickClose(); if (a) annDelete(a); };
  txt.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); annQuickSave(); } else if (e.key === "Escape") annQuickClose(); e.stopPropagation(); });
  $("ui").append(b); return b;
}
function annQuick(a, isNew) {
  const b = annBar(), txt = b.querySelector(".qtext"), can = annCanEdit(a);
  ANN.quick = { a, isNew };
  b.style.setProperty("--ac", ANN_COL[a.kind]);
  b.querySelector(".qannlab").textContent = `${ANN_ICON[a.kind]} ${tsAt(annTime(a)).replace(/ - $/, "")}`;
  txt.value = a.body || ""; txt.readOnly = !can;
  txt.placeholder = a.kind === "comment" ? tr("What's the issue? e.g. this jump is much bigger than the music suggests") : tr("Add a note to it (optional) • Enter");
  b.querySelector(".btn.ghost").hidden = isNew || !can;
  b.hidden = false; if (!$("qnote").hidden) closeQuick();
  setTimeout(() => txt.focus(), 30);
}
function annQuickSave() {
  const q = ANN.quick; if (!q) return;
  const body = $("qann").querySelector(".qtext").value.trim(), a = q.a;
  if (a.kind === "comment" && !body) { $("qann").querySelector(".qtext").focus(); return; }
  if (!annCanEdit(a)) return annQuickClose();
  if (q.isNew) { a.body = body; ANN.list.push(a); ANN.sel = a.id; annChanged("add", a); toast(tr("Comment added"), 900); }
  else if (body !== (a.body || "")) { a.body = body; annTouch(a, "edited"); annChanged("edit", a); }
  annQuickClose();
}
function annQuickClose() { const b = $("qann"); if (b) { b.hidden = true; const i = b.querySelector(".qtext"); if (document.activeElement === i) i.blur(); } ANN.quick = null; dirty = true; }
async function annEdit(a, isNew) {
  const box = h("div", "mdlb annform"), o = annObj(a);
  box.append(h("p", "hint", `${ANN_ICON[a.kind]} ${tr({ comment: "Comment", arrow: "Arrow", highlight: "Highlight" }[a.kind])} · ${tsAt(annTime(a)).replace(/ - $/, "")}${o ? "" : a.object_id ? " · " + tr("object deleted") : " · " + tr("not attached to an object")}`));
  const ta = h("textarea"); ta.maxLength = 2000; ta.value = a.body || ""; ta.rows = 4;
  ta.placeholder = a.kind === "comment" ? tr("What's the issue? e.g. this jump is much bigger than the music suggests") : tr("Note (optional)");
  const lab = h("label", "cf"); lab.append(h("span", null, a.kind === "comment" ? tr("Comment") : tr("Note (optional)")), ta);
  box.append(lab);
  ta.addEventListener("keydown", e => e.stopPropagation());
  const btns = [{ label: tr("Cancel"), value: null, cls: "ghost" }];
  if (!isNew && annCanEdit(a)) btns.unshift({ label: tr("Delete"), value: "del", cls: "ghost danger" });
  btns.push({ label: isNew ? tr("Add") : tr("Save"), value: "ok", cls: "main" });
  const p = modal({ title: isNew ? tr("New annotation") : tr("Annotation"), body: box, buttons: annCanEdit(a) ? btns : [{ label: tr("Close"), value: null, cls: "main" }], dismiss: null });
  setTimeout(() => ta.focus(), 50);
  if (!annCanEdit(a)) ta.readOnly = true;
  const v = await p;
  if (v === "del") return annDelete(a);
  if (v !== "ok") return;
  const body = ta.value.trim();
  if (a.kind === "comment" && !body) return toast(tr("Write something first"), 1800);
  a.body = body;
  if (isNew) ANN.list.push(a); else annTouch(a, "edited");
  ANN.sel = a.id; annChanged(isNew ? "add" : "edit", a);
}
function annDelete(a) {
  if (!annCanEdit(a)) return toast(tr("Only the author or the project owner can delete this"), 2500);
  if (!a.version) ANN.list = ANN.list.filter(x => x !== a); else { a.local = "deleted"; a.updated_at = new Date().toISOString(); }
  if (ANN.sel === a.id) ANN.sel = "";
  annChanged("delete", a);
}
function annChanged(how, a) {
  dirty = true; drawTimeline(); annRerender(); draftSchedule(); cloudTouch();
  if (COLLAB.on) collabAnnChanged(a);
}
function annRerender() { if (EDIT.on && EDIT.tab === "notes") edTab("notes"); else if (typeof sideOpen === "function" && sideOpen()) sideRender(); }

// ---------- tools on the playfield ----------
function annSetTool(k) {
  ANN.tool = k || ""; ANN.drag = null;
  document.querySelectorAll("#edInfo [data-ann]").forEach(b => { b.classList.toggle("on", b.dataset.ann === ANN.tool); b.setAttribute("aria-pressed", b.dataset.ann === ANN.tool); });
  if (ANN.tool) { if (EDIT.tool !== "select") setTool("select"); toast(tr({ comment: "Tap an object (or empty space) to comment on it • Esc to stop", arrow: "Drag an arrow toward the object it's about • Esc to stop", highlight: "Tap an object to highlight it • Esc to stop" }[ANN.tool]), 3000); }
  dirty = true;
}
// the three buttons next to "+ Note": with objects selected, 💬 and ◎ act on the selection at once;
// otherwise (and for ➚, which is drawn) they switch the tool on until Esc
function annButton(k) {
  if (!annCanCreate()) return toast(tr("View only: you can't add annotations to this project"), 2500);
  if (ANN.tool === k) return annSetTool("");
  const objs = selObjs();
  if (k === "comment" && objs.length) return annCreate("comment", objs[0], {});
  if (k === "highlight" && objs.length) { objs.slice(0, 40).forEach((o, i) => annCreate("highlight", o, {}, i < objs.length - 1)); return; }
  annSetTool(k);
}
// the icon of a comment/highlight (where it can be tapped to open it)
function annArrow(a) { // arrow ends, moved along with its object
  const o = annObj(a), d = a.data || {}, sx = o && d.ax != null ? o.x - d.ax : 0, sy = o && d.ax != null ? o.y - d.ay : 0;
  return [(d.x1 ?? 256) + sx, (d.y1 ?? 192) + sy, (d.x2 ?? 256) + sx, (d.y2 ?? 192) + sy];
}
function annIconPos(a) {
  if (a.kind === "arrow") { const p = annArrow(a); return [p[0], p[1]]; }
  const o = annObj(a), r = map.radius, d = a.data || {};
  return o ? [o.x + r * .8, o.y - r * .8] : [d.x ?? 256, d.y ?? 192];
}
// follows its object's timing: appears as the object fades in and fades out with it (same curve the editor draws
// objects with); one without an object uses its own time the same way. A selected one stays visible.
function annVisible(a, t) {
  const o = annObj(a), start = o ? o.t : a.time_ms, end = o ? o.end : a.time_ms;
  if (t < start - map.preempt || t > end + 700) return 0; // gone once its object has faded, even while selected
  if (ANN.sel === a.id && !isPlaying()) return 1; // the one being edited is fully visible while paused near it
  return t <= end ? clamp01((t - (start - map.preempt)) / map.fadeIn) : clamp01(1 - (t - end) / 700);
}
function annAt(x, y, t) { // an annotation icon under the pointer
  const tol = 14 * (cv.dpr || 1) / VIEW.vs;
  for (const a of annActive()) { if (!annVisible(a, t)) continue; const [ix, iy] = annIconPos(a); if (Math.hypot(ix - x, iy - y) <= tol) return a; }
  return null;
}
$("player").addEventListener("pointerdown", e => {
  if (e.target !== cv || !EDIT.on || !map || e.button === 2) return;
  const [x, y] = toOsu(e), t = A.cur();
  if (!ANN.tool) { // tapping an annotation icon opens it (before the editor treats it as a click on the object)
    const a = annAt(x, y, t); if (!a) return;
    e.stopPropagation(); e.preventDefault(); ANN.sel = a.id; dirty = true; annQuick(a, false); return;
  }
  e.stopPropagation(); e.preventDefault();
  const o = hitTest(x, y, t);
  if (ANN.tool === "arrow") { ANN.drag = { x1: x, y1: y, x2: x, y2: y, id: e.pointerId }; cv.setPointerCapture(e.pointerId); dirty = true; return; }
  if (ANN.tool === "comment") annCreate("comment", o, o ? {} : { x: Math.round(x), y: Math.round(y) });
  else if (ANN.tool === "highlight") { if (!o) return toast(tr("Tap an object to highlight it"), 1800); annCreate("highlight", o, {}); }
}, true);
$("player").addEventListener("pointermove", e => {
  if (!ANN.drag || e.target !== cv) return;
  const [x, y] = toOsu(e); ANN.drag.x2 = x; ANN.drag.y2 = y; dirty = true; e.stopPropagation();
}, true);
function annEndDrag(e) {
  const d = ANN.drag; if (!d) return;
  ANN.drag = null; dirty = true; e.stopPropagation();
  if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * VIEW.vs / (cv.dpr || 1) < 12) return toast(tr("Drag to draw the arrow"), 1500);
  const t = A.cur(), o = hitTest(d.x2, d.y2, t) || hitTest(d.x1, d.y1, t); // it points at the object at its tip
  const data = { x1: Math.round(d.x1), y1: Math.round(d.y1), x2: Math.round(d.x2), y2: Math.round(d.y2) };
  if (o) { data.ax = o.x; data.ay = o.y; } // where its object was drawn: the arrow moves with it
  annCreate("arrow", o, data);
}
$("player").addEventListener("pointerup", annEndDrag, true);
$("player").addEventListener("pointercancel", annEndDrag, true);
document.querySelectorAll("#edInfo [data-ann]").forEach(b => b.onclick = e => { e.stopPropagation(); annButton(b.dataset.ann); });
addEventListener("keydown", e => { if (e.key === "Escape" && ANN.tool && EDIT.on && !e.target.closest("input,textarea,select")) { e.preventDefault(); e.stopPropagation(); annSetTool(""); } }, true);

// ---------- drawing ----------
function arrowShape(x1, y1, x2, y2, px) {
  const a = Math.atan2(y2 - y1, x2 - x1), hl = 14 * px;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - Math.cos(a) * hl * .6, y2 - Math.sin(a) * hl * .6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - Math.cos(a - .45) * hl, y2 - Math.sin(a - .45) * hl); ctx.lineTo(x2 - Math.cos(a + .45) * hl, y2 - Math.sin(a + .45) * hl); ctx.closePath(); ctx.fill();
}
function annDrawOver(t, px) {
  if (!map || !EDIT.on) return;
  const r = map.radius, now = performance.now();
  for (const a of annActive()) {
    const vis = annVisible(a, t); if (!vis) continue;
    const o = annObj(a), col = a.object_missing ? "#9a8fb0" : ANN_COL[a.kind], sel = ANN.sel === a.id, d = a.data || {};
    ctx.globalAlpha = vis; ctx.strokeStyle = col; ctx.fillStyle = col;
    if (a.kind === "highlight") {
      const pulse = .5 + .5 * Math.sin(now / 180), x = o ? o.x : d.x ?? 256, y = o ? o.y : d.y ?? 192;
      ctx.lineWidth = (sel ? 5 : 4) * px; ctx.globalAlpha = vis * (.6 + .4 * pulse);
      ctx.beginPath(); ctx.arc(x, y, r * (1.18 + .06 * pulse), 0, 7); ctx.stroke(); ctx.globalAlpha = vis;
    } else if (a.kind === "arrow") {
      const [x1, y1, x2, y2] = annArrow(a);
      ctx.lineWidth = (sel ? 7.5 : 6.5) * px; ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.fillStyle = "rgba(0,0,0,.55)"; arrowShape(x1, y1, x2, y2, px);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = (sel ? 4.5 : 3.5) * px; arrowShape(x1, y1, x2, y2, px);
    }
    // icon + text
    const [ix, iy] = annIconPos(a);
    {
      ctx.fillStyle = "#1c1726"; ctx.strokeStyle = col; ctx.lineWidth = 2 * px;
      ctx.beginPath(); ctx.arc(ix, iy, 9 * px, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = col; ctx.font = `600 ${10 * px}px "Varela Round",sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(a.kind === "comment" ? "…" : a.kind === "arrow" ? "!" : "✦", ix, iy + .5 * px);
    }
    const near = sel || Math.abs(t - annTime(a)) < 450;
    if (near && (a.body || a.object_missing)) {
      const txt = ((a.object_missing ? "⚠ " + tr("object deleted") + (a.body ? " · " : "") : "") + (a.body || "")).slice(0, 80) + ((a.body || "").length > 80 ? "…" : "");
      ctx.font = `600 ${12 * px}px "Varela Round","IBM Plex Sans Thai",sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const w = Math.min(320 * px, ctx.measureText(txt).width + 16 * px), hh = 22 * px, x0 = Math.min(ix + 12 * px, 512 + 60 * px - w), y0 = iy - hh / 2;
      ctx.globalAlpha = vis * .94; ctx.fillStyle = "#1c1726"; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y0, w, hh, 7 * px); else ctx.rect(x0, y0, w, hh); ctx.fill();
      ctx.fillStyle = col; ctx.fillRect(x0, y0, 3 * px, hh);
      ctx.globalAlpha = vis; ctx.fillStyle = "#fff"; ctx.fillText(txt, x0 + 9 * px, y0 + hh / 2, w - 13 * px);
    }
  }
  if (ANN.drag) { const d = ANN.drag; ctx.globalAlpha = .9; ctx.strokeStyle = ctx.fillStyle = ANN_COL.arrow; ctx.lineWidth = 3.5 * px; ctx.lineCap = "round"; arrowShape(d.x1, d.y1, d.x2, d.y2, px); }
  ctx.globalAlpha = 1;
}
function annDrawTimeline(g, X, t0, t1, hh) {
  for (const a of annActive()) {
    const t = annTime(a); if (t < t0 || t > t1) continue;
    const x = X(t); g.fillStyle = a.object_missing ? "#9a8fb0" : ANN_COL[a.kind];
    g.beginPath(); g.moveTo(x, hh); g.lineTo(x - 5, hh - 8); g.lineTo(x + 5, hh - 8); g.closePath(); g.fill();
    if (ANN.sel === a.id) { g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke(); }
  }
}

// ---------- the list (Mod notes tab) ----------
function annGo(a) { // seek to it and select its object
  ANN.sel = a.id; const o = annObj(a);
  seekTo(Math.round(o ? o.t : a.time_ms));
  if (o) edSelectIds([o.lid]); else EDIT.sel.clear();
  if (EDIT.tab !== "compose") edTab("compose");
  dirty = true; showUI();
  if (!o && a.object_id) toast(tr("The object this annotation was about has been deleted"), 2500);
}
function annPanel() {
  const box = h("section", "annbox"), list = annActive().sort((a, b) => annTime(a) - annTime(b));
  const head = h("div", "annhead");
  head.append(h("b", null, tr("Annotations ({n})", { n: list.length })));
  if (EDIT.on && annCanCreate()) for (const k of ["comment", "arrow", "highlight"]) {
    const b = h("button", "btn ghost sm", `${ANN_ICON[k]} ${tr({ comment: "Comment", arrow: "Arrow", highlight: "Highlight" }[k])}`);
    b.onclick = () => { edTab("compose"); annSetTool(k); }; head.append(b);
  }
  if (list.some(annCanEdit)) { const all = h("button", "btn ghost sm danger", tr("Delete all")); all.onclick = () => annDeleteAll(); head.append(all); }
  box.append(head);
  if (!list.length) box.append(h("p", "hint", tr("Comments, arrows and highlights drawn on the playfield. They appear and fade with their object and stay attached to it when it moves. Use 💬 ➚ ◎ next to \"+ Note\" in Compose.")));
  for (const a of list) {
    const row = h("div", "annrow" + (a.object_missing ? " gone" : "") + (ANN.sel === a.id ? " sel" : "")), top = h("div", "annrt");
    const go = h("button", "mlink", `${ANN_ICON[a.kind]} ${tsAt(annTime(a)).replace(/ - $/, "")}`); go.onclick = () => annGo(a);
    top.append(go);
    if (a.author && a.author.username) top.append(h("small", null, a.author.username));
    if (a.object_missing) top.append(h("em", "badge", tr("object deleted")));
    if (annIsLocal(a) && ANN.role) top.append(h("em", "badge dim", tr("not saved online")));
    if (annCanEdit(a)) { const ed2 = h("button", "mlink", tr("Edit")); ed2.onclick = () => annEdit(a, false); const del = h("button", "mlink", tr("Delete")); del.onclick = async () => { if ((await ask(tr("Delete this annotation?"), { ok: tr("Delete"), danger: true }))) annDelete(a); }; top.append(ed2, del); }
    row.style.setProperty("--ac", ANN_COL[a.kind]);
    row.append(top); if (a.body) row.append(h("p", null, a.body));
    box.append(row);
  }
  return box;
}

// ---------- export / import (alone, or together with the mod notes; see tools.js) ----------
function annPayload() { // the open difficulty's annotations, in time order
  return annActive().sort((a, b) => annTime(a) - annTime(b)).map(a => ({ kind: a.kind, time_ms: Math.round(annTime(a)), ts: tsAt(annTime(a)).replace(/ - $/, ""),
    body: a.body || "", data: a.data || {}, object_missing: !!a.object_missing, author: a.author && a.author.username || "" }));
}
// imported ones are attached to the object at their time (object ids differ between copies of a map)
function annImportList(list) {
  if (!Array.isArray(list) || !map) return 0;
  if (!annCanCreate()) { toast(tr("View only: you can't add annotations to this project"), 2500); return 0; }
  const seen = new Set(annActive().map(a => a.kind + "|" + Math.round(annTime(a)) + "|" + (a.body || ""))), me = annMe(), path = curPath();
  let n = 0;
  for (const x of list.slice(0, 2000)) {
    if (!x || !["comment", "arrow", "highlight"].includes(x.kind) || !isFinite(+x.time_ms)) continue;
    const t = Math.max(0, Math.round(+x.time_ms)), body = String(x.body || "").slice(0, 2000), key = x.kind + "|" + t + "|" + body;
    if (seen.has(key) || (x.kind === "comment" && !body)) continue;
    const o = map.hit.find(h2 => Math.abs(h2.t - t) <= 2), data = x.data && typeof x.data === "object" ? { ...x.data } : {};
    if (x.kind === "arrow" && o && data.ax != null) { data.ax = o.x; data.ay = o.y; }
    ANN.list.push({ id: uuid(), diff: path, kind: x.kind, object_id: o ? String(o.lid) : null, time_ms: t, body, data, object_missing: false,
      author: me, version: 0, local: "new", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    seen.add(key); n++;
  }
  if (n) { dirty = true; drawTimeline(); annRerender(); draftSchedule(); cloudTouch(); }
  return n;
}
