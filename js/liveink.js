"use strict";
// ============ live session: drawing on the playfield (pen, highlighter, eraser, ping) ============
// A brush button floats over the playfield (top right, can be dragged anywhere). Strokes are in osu! pixels, so they
// stay on the same spot of the map; they're sent to everyone in the session as they're drawn, disappear after the
// chosen time (default 5 s, or stay until cleared) and are all gone when the session ends. Watchers only see them.
// The button only shows once "Drawing tools" is switched on (live sheet → People, saved in S.inkTools), and a tool that
// is out is put away by tapping the button again, picking an editor tool, or Esc: while one is out the editor can't
// select or move objects.
const INK = { tool: null, open: false, strokes: [], cur: null, lastSend: 0, erasing: false };
const INK_TTLS = [[3, "3 s"], [5, "5 s"], [10, "10 s"], [30, "30 s"], [60, "1 min"], [0, "Until cleared"]];
const inkTtl = () => (S.inkTtl === undefined ? 5 : S.inkTtl);
const inkOn = () => LIVE.on && EDIT.on && !LIVE.watch;
const inkShown = () => inkOn() && !!S.inkTools;
const inkUid = () => LIVE.me.id + ":" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const inkSend = msg => liveSendAll(LIVE.host ? { ...msg, by: LIVE.me.id, ...(msg.s ? { s: { ...msg.s, by: LIVE.me.id } } : {}) } : msg); // (the host's own: with its id)

// ---------- the floating button and its tool panel ----------
const inkFab = h("div", "inkfab"); inkFab.id = "inkFab"; inkFab.hidden = true;
const inkBtn = h("button", "inkbtn"); inkBtn.type = "button"; inkBtn.setAttribute("aria-label", tr("Drawing tools"));
inkBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L11 15.8 8.2 13z"/><path d="M7.2 14.2c-2 0-3.4 1.5-3.4 3.4 0 1.2-.6 2.2-1.8 2.6 1 .9 2.4 1.3 3.8 1.3 2.6 0 4.6-2 4.6-4.5z"/></svg>`;
const inkPanel = h("div", "inkpanel"); inkPanel.hidden = true;
inkFab.append(inkBtn, inkPanel); UI.player.append(inkFab);
function inkPlace() { // keep the saved spot (distance from the top right corner), inside the window
  const p = S.inkPos || { r: 74, t: 140 }, w = UI.player.clientWidth, hgt = UI.player.clientHeight;
  inkFab.style.right = Math.max(4, Math.min(w - 52, p.r)) + "px"; inkFab.style.top = Math.max(4, Math.min(hgt - 52, p.t)) + "px";
}
function inkRenderPanel() {
  inkPanel.innerHTML = "";
  const tools = h("div", "inktools");
  for (const [k, label, icon] of [["pen", "Pen", "✎"], ["hl", "Highlighter", "▍"], ["ping", "Point", "◎"], ["eraser", "Eraser", "⌫"]]) {
    const b = h("button", "inktool" + (INK.tool === k ? " on" : "")); b.type = "button"; b.title = tr(label); b.setAttribute("aria-pressed", INK.tool === k);
    b.append(h("span", "inkic", icon), h("small", null, tr(label)));
    b.onclick = () => { inkSetTool(INK.tool === k ? null : k); };
    tools.append(b);
  }
  const ttl = h("label", "inkttl"); ttl.append(h("small", null, tr("Disappears after")));
  const sel = h("select"); for (const [v, l] of INK_TTLS) sel.add(new Option(tr(l), v)); sel.value = String(inkTtl());
  sel.onchange = () => { S.inkTtl = +sel.value; save(); }; ttl.append(sel);
  const clr = h("button", "btn ghost sm", tr(LIVE.host ? "Clear all drawings" : "Clear my drawings"));
  clr.onclick = () => { inkClear(LIVE.host ? null : LIVE.me.id); inkSend({ t: "inkclr", all: LIVE.host }); };
  const col = h("span", "inkcol"); col.style.background = (LIVE.me && LIVE.me.color) || "#fff"; col.title = tr("Your colour in this session");
  const hide = h("button", "btn ghost sm", tr("Hide drawing tools")); hide.onclick = () => inkShow(false);
  const foot = h("div", "inkfoot"); foot.append(col, clr);
  inkPanel.append(tools, ttl, foot, hide, h("small", "hint", tr("Drawings show for everyone in the session and are deleted when it ends. Tap the brush or press Esc to put the tool away.")));
}
function inkSetTool(k) {
  INK.tool = k; inkFab.classList.toggle("active", !!k); UI.player.classList.toggle("inking", !!k);
  if (k) inkPanel.hidden = true; // out of the way of the playfield; the pink button shows a tool is out
  else if (inkPanel.hidden === false) inkRenderPanel();
}
function inkAway() { if (INK.tool) inkSetTool(null); }
function inkShow(on) { S.inkTools = on; save(); inkUpdate(); if (typeof renderLive === "function") renderLive(); }
function inkUpdate() { // shown in a live session while editing (not for watchers), once switched on
  const on = inkShown(); inkFab.hidden = !on;
  if (!on) { if (INK.tool) inkSetTool(null); inkPanel.hidden = true; }
  else inkPlace();
}
// drag the button to move it; a click (no drag) opens the tools
(() => {
  let d = null;
  inkBtn.addEventListener("pointerdown", e => { d = { x: e.clientX, y: e.clientY, p: { ...(S.inkPos || { r: 74, t: 140 }) }, moved: false }; inkBtn.setPointerCapture(e.pointerId); e.stopPropagation(); });
  inkBtn.addEventListener("pointermove", e => {
    if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true; S.inkPos = { r: d.p.r - dx, t: d.p.t + dy }; inkPlace();
  });
  inkBtn.addEventListener("pointerup", () => {
    if (!d) return; const moved = d.moved; d = null;
    if (moved) { const r = inkFab.getBoundingClientRect(), pr = UI.player.getBoundingClientRect(); S.inkPos = { r: Math.round(pr.right - r.right), t: Math.round(r.top - pr.top) }; save(); return; }
    if (INK.tool) { inkSetTool(null); inkPanel.hidden = true; return; } // a tool is out: put it away
    inkPanel.hidden = !inkPanel.hidden; if (!inkPanel.hidden) inkRenderPanel();
  });
  inkBtn.addEventListener("pointercancel", () => { d = null; });
  addEventListener("resize", () => { if (!inkFab.hidden) inkPlace(); });
  addEventListener("keydown", e => { if (e.key === "Escape" && INK.tool) { e.preventDefault(); e.stopPropagation(); inkSetTool(null); } }, true);
})();

// ---------- drawing on the playfield (the editor doesn't see these pointer events while a tool is out) ----------
function inkPoint(e) { const p = toOsu(e); return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]; }
function inkStroke(kind, pts) { return { id: inkUid(), by: LIVE.me.id, color: LIVE.me.color, name: LIVE.me.name, kind, pts, ttl: inkTtl(), at: performance.now(), done: false }; }
const inkWire = s => ({ id: s.id, kind: s.kind, pts: s.pts, ttl: s.ttl, done: s.done });
UI.player.addEventListener("pointerdown", e => {
  if (!INK.tool || e.target !== cv || !inkOn() || e.button === 2) return;
  e.preventDefault(); e.stopPropagation();
  const p = inkPoint(e);
  if (INK.tool === "ping") { const s = inkStroke("ping", [p]); s.done = true; inkAdd(s); inkSend({ t: "ink", s: inkWire(s) }); return; }
  if (INK.tool === "eraser") { INK.erasing = true; inkErase(p); return; }
  INK.cur = inkStroke(INK.tool, [p]); inkAdd(INK.cur); INK.lastSend = 0;
}, true);
addEventListener("pointermove", e => {
  if (!INK.tool || !inkOn()) return;
  if (INK.erasing) { inkErase(inkPoint(e)); return; }
  const s = INK.cur; if (!s) return;
  const p = inkPoint(e), q = s.pts[s.pts.length - 1];
  if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5 || s.pts.length >= 1500) return;
  s.pts.push(p); dirty = true;
  const now = performance.now(); if (now - INK.lastSend > 50) { INK.lastSend = now; inkSend({ t: "ink", s: inkWire(s) }); } // others see it being drawn
}, true);
addEventListener("pointerup", () => {
  INK.erasing = false;
  const s = INK.cur; if (!s) return; INK.cur = null;
  s.done = true; s.at = performance.now(); inkSend({ t: "ink", s: inkWire(s) }); dirty = true;
}, true);
function inkErase(p) { // strokes under the eraser: your own (the host: anyone's)
  const hit = INK.strokes.filter(s => (LIVE.host || s.by === LIVE.me.id) && s.pts.some((q, i) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 14 || (i && segDist(p[0], p[1], s.pts[i - 1], q) < 10)));
  if (!hit.length) return;
  const ids = hit.map(s => s.id); INK.strokes = INK.strokes.filter(s => !ids.includes(s.id)); dirty = true;
  inkSend({ t: "inkdel", ids });
}

// ---------- shared state ----------
function inkAdd(s) {
  const i = INK.strokes.findIndex(x => x.id === s.id);
  if (i >= 0) { const o = INK.strokes[i]; o.pts = s.pts; if (s.done && !o.done) { o.done = true; o.at = performance.now(); } }
  else { INK.strokes.push(s); if (INK.strokes.length > 400) INK.strokes.shift(); }
  dirty = true;
}
function inkClean(s0, m) { // a stroke from someone else: checked, and in their colour
  if (!s0 || typeof s0.id !== "string" || !Array.isArray(s0.pts) || !["pen", "hl", "ping"].includes(s0.kind)) return null;
  const pts = s0.pts.slice(0, 1500).map(p => [+p[0], +p[1]]).filter(p => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) < 2000 && Math.abs(p[1]) < 2000);
  if (!pts.length) return null;
  return { id: s0.id.slice(0, 80), by: m.id, color: m.color, name: m.name, kind: s0.kind, pts, ttl: Math.max(0, Math.min(600, +s0.ttl || 0)), at: performance.now(), done: !!s0.done };
}
function inkRemove(ids, by) { INK.strokes = INK.strokes.filter(s => !(ids.includes(s.id) && (by == null || s.by === by))); dirty = true; }
function inkClear(by) { INK.strokes = by == null ? [] : INK.strokes.filter(s => s.by !== by); dirty = true; }
function inkReset() { INK.strokes = []; INK.cur = null; inkSetTool(null); inkPanel.hidden = true; inkFab.hidden = true; }
// what a newcomer gets: the strokes still showing, with the time they have left
function inkSnapshot() { const now = performance.now(); return INK.strokes.filter(s => s.done && s.kind !== "ping").map(s => ({ ...inkWire(s), by: s.by, ttl: s.ttl ? Math.max(1, s.ttl - (now - s.at) / 1000) : 0 })); }

// ---------- drawing ----------
function inkDraw(px) {
  const now = performance.now();
  INK.strokes = INK.strokes.filter(s => s.kind === "ping" ? now - s.at < 2600 : !s.done || !s.ttl || now - s.at < s.ttl * 1000);
  if (!INK.strokes.length) return;
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const s of INK.strokes) {
    const left = s.kind === "ping" ? 1 : s.done && s.ttl ? s.ttl * 1000 - (now - s.at) : 1e9, fade = Math.min(1, left / 600);
    if (s.kind === "ping") {
      const k = (now - s.at) / 2600, [x, y] = s.pts[0];
      for (const off of [0, .33]) { const kk = (k + off) % 1; ctx.globalAlpha = (1 - kk) * .9; ctx.strokeStyle = s.color; ctx.lineWidth = 3 * px; ctx.beginPath(); ctx.arc(x, y, (8 + kk * 46) * px, 0, 7); ctx.stroke(); }
      ctx.globalAlpha = 1 - k; ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, y, 5 * px, 0, 7); ctx.fill();
      ctx.font = `600 ${11 * px}px "Varela Round",sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText(s.name || "", x + 10 * px, y - 8 * px);
      dirty = true; continue;
    }
    ctx.globalAlpha = (s.kind === "hl" ? .38 : .95) * fade; ctx.strokeStyle = s.color; ctx.lineWidth = (s.kind === "hl" ? 18 : 3.2) * px;
    ctx.beginPath(); s.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + .01, s.pts[0][1]);
    ctx.stroke();
    if (fade < 1) dirty = true;
  }
  ctx.restore(); ctx.globalAlpha = 1;
  if (INK.strokes.some(s => s.done && s.ttl)) dirty = true; // keep counting down
}
