// The storyboard reader as it was before the typed-array version (js/parse.js: sbParseChunk), kept as the reference the new one is
// checked against (storyboard.test.mjs). Needs parse.js's ORIGINS, ORIGIN_IDS, LAYERS, E, lastBefore and norm in the same scope.
const REF_ARITY = { F: 1, S: 1, V: 2, M: 2, MX: 1, MY: 1, R: 1, C: 3 };
function refParseStoryboard(text, extraVars = {}) {
  const vars = { ...extraVars }; const sprites = []; let sec = "", cur = null, loop = null, inTrigger = false;
  // $variables, replaced in order like osu! does (a value may hold later variables), but a line that grows past 20 000
  // characters is dropped: chained values double each step and would take all the memory
  const expand = raw => { for (const k in vars) { if (raw.includes(k)) raw = raw.split(k).join(vars[k]); if (raw.length > 20000) return null; } return raw; };
  for (let raw of text.split(/\r?\n/)) {
    if (raw.startsWith("//") || !raw.trim()) continue;
    const h = raw.trim().match(/^\[(.+)\]$/);
    if (h) { sec = h[1]; continue; }
    if (sec === "Variables") { const i = raw.indexOf("="); if (i > 0) { vars[raw.slice(0, i).trim()] = raw.slice(i + 1).trim(); } continue; }
    if (sec !== "Events") continue;
    if (raw.includes("$")) { raw = expand(raw); if (raw == null) continue; }
    const depth = raw.match(/^[ _]*/)[0].length;
    const p = raw.slice(depth).split(",");
    if (depth === 0) {
      loop = null; inTrigger = false; cur = null;
      if (p[0] === "Sprite" || p[0] === "4" || p[0] === "Animation" || p[0] === "6") {
        const anim = p[0] === "Animation" || p[0] === "6";
        const layer = isNaN(p[1]) ? p[1] : LAYERS[+p[1]];
        const origin = ORIGINS[isNaN(p[2]) ? p[2] : ORIGIN_IDS[+p[2]]] || [.5, .5];
        const file = norm(p[3]);
        const frames = [];
        if (anim) { const dot = file.lastIndexOf("."); for (let i = 0, n = Math.min(1000, +p[6] || 1); i < n; i++) frames.push(file.slice(0, dot) + i + file.slice(dot)); }
        else frames.push(file);
        cur = { layer, origin, frames, x: +p[4] || 0, y: +p[5] || 0, delay: +p[7] || 0, loopOnce: /LoopOnce|^\s*1\s*$/.test(p[8] || ""), cmds: [], idx: sprites.length };
        sprites.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    if (depth === 1) { loop = null; inTrigger = false; }
    if (inTrigger) continue;
    const type = p[0];
    if (type === "L") { loop = { start: +p[1], count: Math.max(1, +p[2] || 1), cmds: [] }; (cur.loops = cur.loops || []).push(loop); continue; }
    if (type === "T") { inTrigger = true; continue; }
    const easing = +p[1] || 0, start = +p[2], end = p[3] === "" || p[3] === undefined ? start : +p[3];
    if (isNaN(start)) continue;
    const target = depth >= 2 && loop ? loop.cmds : cur.cmds;
    if (type === "P") { target.push({ type, easing, start, end, v: (p[4] || "").trim() }); continue; }
    const n = REF_ARITY[type]; if (!n) continue;
    const vals = p.slice(4).map(Number);
    if (vals.length === n) vals.push(...vals.slice(0, n));
    const dur = end - start;
    for (let i = 0; i + n * 2 <= vals.length; i += n) {
      const s = start + dur * (i / n);
      target.push({ type, easing, start: s, end: s + dur, a: vals.slice(i, i + n), b: vals.slice(i + n, i + 2 * n) });
    }
  }
  let budget = 2e6; // (loops are copied out: a loop count of millions, or many of them, would take all the memory)
  for (const s of sprites) {
    for (const L of s.loops || []) {
      let len = 0; for (const c of L.cmds) if (c.end > len) len = c.end;
      const count = Math.min(L.count, Math.floor(Math.min(1e5, budget) / Math.max(1, L.cmds.length))); budget -= count * L.cmds.length;
      for (let i = 0; i < count; i++) for (const c of L.cmds) s.cmds.push({ ...c, start: c.start + L.start + i * len, end: c.end + L.start + i * len });
    }
    delete s.loops;
    s.byType = {};
    for (const c of s.cmds) (s.byType[c.type] = s.byType[c.type] || []).push(c);
    for (const k in s.byType) s.byType[k].sort((a, b) => a.start - b.start);
    let st = Infinity, en = -Infinity;
    for (const c of s.cmds) { if (c.start < st) st = c.start; if (c.end > en) en = c.end; }
    s.start = st; s.end = en;
  }
  const order = { Background: 0, Fail: 1, Pass: 2, Foreground: 3, Overlay: 4 };
  return sprites.filter(s => s.cmds.length && s.layer !== "Fail").sort((a, b) => (order[a.layer] ?? 0) - (order[b.layer] ?? 0) || a.idx - b.idx);
}


// value of a storyboard command list at time t, written into `out` (no per-frame allocations)
function refSbVal(list, t, out) {
  const n = out.length;
  if (t < list[0].start) { const a = list[0].a; for (let j = 0; j < n; j++) out[j] = a[j]; return out; }
  const c = list[lastBefore(list, t, "start")];
  if (t > c.end || c.end === c.start) { for (let j = 0; j < n; j++) out[j] = c.b[j]; return out; }
  const k = (E[c.easing] || E[0])((t - c.start) / (c.end - c.start));
  for (let j = 0; j < n; j++) out[j] = c.a[j] + (c.b[j] - c.a[j]) * k;
  return out;
}
