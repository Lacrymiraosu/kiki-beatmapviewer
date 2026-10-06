"use strict";
// ============ Verify: map checks for the osu! Ranking Criteria ============
// Which checks to run, their thresholds and how they measure follow MapsetVerifier (Naxess, GPL-3.0,
// github.com/Naxesss/MapsetVerifier), and so does this project's licence: GPL-3.0 (LICENSE, THIRD_PARTY_NOTICES.txt).
// Times are measured the way osu! stores them (whole ms, cut off), a slider's position is its unstacked one and a
// circle's its stacked one, a break lasts from the object before it to the object after it, and so on.
// Issue levels: "problem" (unrankable), "warning" (check it), "minor" (probably fine).
const LEVELS = ["Easy", "Normal", "Hard", "Insane", "Expert", "Ultra"];
const LV = { problem: 0, warning: 1, minor: 2 };
const DIFF_NAMES = [["beginner", "easy", "novice"], ["basic", "normal", "medium", "intermediate"], ["advanced", "hard"], ["hyper", "insane"], ["expert", "extra", "extreme"]];
function diffLevel(m, stars) { // an exact difficulty name first ("Hard", "Kensuke's Insane"), else the star rating
  const n = String(m.meta.Version || "").toLowerCase().replace(/^\s*\w+'s\s+/, "").replace(/\bcollab\b/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const byName = DIFF_NAMES.findIndex(l => l.includes(n));
  if (byName >= 0) return byName;
  if (stars > 0) return stars < 2 ? 0 : stars < 2.7 ? 1 : stars < 4 ? 2 : stars < 5.3 ? 3 : stars < 6.5 ? 4 : 5;
  const ar = +(m.diff.ApproachRate ?? m.diff.OverallDifficulty ?? 5);
  return ar < 5 ? 0 : ar < 7 ? 1 : ar < 8.5 ? 2 : ar < 9.3 ? 3 : 4;
}
const hsp = c => Math.sqrt(.299 * c[0] ** 2 + .587 * c[1] ** 2 + .114 * c[2] ** 2);
const kindName = o => o.kind === "circle" ? "Circle" : o.kind === "slider" ? "Slider" : "Spinner";
const trv = s => typeof tr === "function" ? tr(s) : s; // (text put inside a message)
const ms3 = v => String(+(+v).toFixed(3)); // (up to 3 decimals, no trailing zeros)
const rad = m => 32 * (1 - .7 * (+(m.diff.CircleSize ?? 5) - 5) / 5); // circle radius in osu!px (without stable's rounding allowance)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// reference values measured or chosen by MapsetVerifier (credited on the Credits page), kept as data in one place
const REF = {
  screen: { top: -60, bottom: 428, left: -67, right: 579 }, // osu!px where an object's edge leaves the 4:3 screen
  spinnerWarn: [500, 21.8, 20], spinnerProblem: [450, 17, 17], // ms at OD 5, change per OD below / above 5
  reverseClose: 1.75, // a reverse arrow within radius / this of an object is hard to see
};
const odLine = (od, [at5, below, above]) => at5 + (od - 5) * (od < 5 ? below : above);
const arOf = m => +(m.diff.ApproachRate ?? m.diff.OverallDifficulty ?? 5);
// positions the checks use: circles stacked, sliders (head, body, tail) unstacked
const posOf = o => o.kind === "slider" ? [o.rx, o.ry] : [o.x, o.y];
const vUnstack = (o, q) => [q[0] - (o.x - o.rx), q[1] - (o.y - o.ry)];
function endPosOf(o) {
  if (o.kind !== "slider") return posOf(o);
  return o.slides % 2 ? vUnstack(o, o.path[o.path.length - 1]) : [o.rx, o.ry];
}
function pathPoint(o, fr) { // a point fr of the way along the drawn (stacked) path
  const c = o.cum, L = c[c.length - 1] * fr; let i = 1;
  while (i < c.length - 1 && c[i] < L) i++;
  const a = o.path[i - 1], b = o.path[i] || a, k = c[i] > c[i - 1] ? (L - c[i - 1]) / (c[i] - c[i - 1]) : 0;
  if (o.path.jumps && o.path.jumps.has(i)) return (k < .5 ? a : b).slice(0, 2); // (a left-out stretch far off-screen: parse.js farPath)
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
// hit edges: [time, part] (head, reverses, tail; a spinner's start and end)
function edgesOf(o) {
  if (o.kind === "slider") { const e = [[o.t, "head"]]; for (let k = 1; k <= o.slides; k++) e.push([o.t + o.span * k, k === o.slides ? "tail" : "reverse"]); return e; }
  if (o.kind === "spinner") return [[o.t, "head"], [o.end, "tail"]];
  return [[o.t, "head"]];
}
const PART = { circle: { head: "Circle" }, slider: { head: "Slider head", reverse: "Slider reverse", tail: "Slider tail" }, spinner: { head: "Spinner head", tail: "Spinner tail" } };
const lineAt = (m, t) => m.timing[Math.max(0, lastBefore(m.timing, t, "time"))]; // the timing line active at t (either colour)
function lineAfter(m, i) { let n = null; for (let j = i + 1; j < m.timing.length; j++) { n = m.timing[j]; if (Math.abs(n.time - m.timing[i].time) > 1e-9) break; } return n; } // (skips lines on the same ms)
const svOf = tp => !tp || tp.uninherited ? 1 : tp.beat < 0 ? Math.min(10, Math.max(.1, -100 / tp.beat)) : 1;
function realBreaks(m) { // from the end of the object before each break to the start of the object after it
  const H = m.hit;
  return m.breaks.map(([a, b]) => { const p = H[lastBefore(H, a - 1e-6, "t")], n = H[lastBefore(H, b, "t") + 1]; return [p ? p.end : 0, n ? n.t : m.last]; });
}
function drainOf(m) {
  const H = m.hit; if (!H.length) return 0;
  let br = 0; for (const [a, b] of realBreaks(m)) br += Math.max(0, b - a);
  return H[H.length - 1].end - H[0].t - br;
}
const tsOf = (...objs) => fmtMs(objs[0].t) + " (" + objs.map(o => o.kind === "spinner" ? "spinner" : o.num).join(",") + ")";
// a slider tail that the pixel-length maths puts a hair before an upcoming red line that moves the bar lines
function tailOnNextRed(m, t) {
  const cur = redLineAt(m, t), next = nextRedLine(m, t);
  return !!next && next.time - t <= 2 && !downbeatsAligned(cur, next);
}
// the normal sample set an edge plays with (its own, the object's, else the timing line's, else the map's)
function setAt(m, o, t, k) {
  const es = o.edgeSets && o.edgeSets[k], own = es && es[0] || (o.samp && o.samp.n);
  if (own) return own;
  const tp = m.timing[Math.max(0, lastBefore(m.timing, t + 5, "time"))];
  return (tp && tp.sampleSet) || ({ normal: 1, soft: 2, drum: 3 }[(m.general.SampleSet || "Normal").toLowerCase()] || 1);
}
const vEdgeHs = (o, k) => o.edgeSounds && isFinite(o.edgeSounds[k]) ? o.edgeSounds[k] : o.hs;

// ---------- per-difficulty checks (osu!standard) ----------
// run(m, add, lvl, ctx): lvl = the difficulty level (0 Easy … 5 Ultra), ctx.hasEasy = the mapset has an Easy
const DIFF_CHECKS = [
  // ----- Timing -----
  { cat: "Timing", title: "Unsnapped hit objects", run(m, add) {
    for (const o of m.hit) for (const [t, part] of edgesOf(o)) {
      if (o.kind === "slider" && part === "tail" && tailOnNextRed(m, t)) continue;
      const u = practicalUnsnap(t, m), a = Math.abs(u), what = PART[o.kind][part];
      if (a >= 2) add("problem", "{what} is {ms} ms unsnapped.", { what, ms: ms3(u) }, o, t);
      else if (a >= 1) add("minor", "{what} is {ms} ms unsnapped.", { what, ms: ms3(u) }, o, t);
    }
  } },
  { cat: "Timing", title: "Hit objects potentially snapped to the wrong red line", run(m, add) {
    for (const o of m.hit) for (const [t, part] of edgesOf(o)) {
      const cur = redLineAt(m, t), next = nextRedLine(m, t);
      if (!next || next.time - t > Math.max(50, cur.beat / 8) || downbeatsAligned(cur, next)) continue;
      const here = Math.abs(practicalUnsnap(t, m, cur)), there = Math.abs(practicalUnsnap(t, m, next));
      if (here < 2 && there >= 2) add("warning", "{what} is snapped to this red line but {ms} ms off the grid of the next red line at {at}.", { what: PART[o.kind][part], ms: ms3(there), at: fmtMs(next.time) }, o, t);
    }
  } },
  { cat: "Timing", title: "First line toggles kiai or is inherited", run(m, add) {
    const f = m.timing[0];
    if (!f) add("problem", "There are no timing lines.");
    else if (!f.uninherited) add("problem", "The map starts with a green line instead of a red line.", {}, null, f.time);
    else if (f.kiai) add("problem", "Kiai starts on the map's very first timing point.", {}, null, f.time);
  } },
  { cat: "Timing", title: "Unused timing lines", run(m, add) {
    const L = m.timing, H = m.hit, S = H.filter(o => o.kind === "slider"), maxEnd = [];
    let mx = -Infinity; for (const o of H) maxEnd.push(mx = Math.max(mx, o.end));
    const range = i => { const n = lineAfter(m, i); return [L[i].time, n ? n.time : Infinity]; };
    const overlaps = i => { const [s, e] = range(i), k = lastBefore(H, e - 1e-6, "t"); return k >= 0 && maxEnd[k] >= s; }; // an object (or its tail) in the section
    const hasSlider = i => { const [s, e] = range(i), k = lastBefore(S, e - 1e-6, "t"); return k >= 0 && S[k].t >= s; }; // a slider starting in it
    const samplesDiffer = (a, b) => a.sampleSet !== b.sampleSet || a.sampleIndex !== b.sampleIndex || Math.abs(a.volume - b.volume) > 1e-6;
    const used = (i, prev) => (overlaps(i) && samplesDiffer(L[i], prev)) || (hasSlider(i) && Math.abs(svOf(L[i]) - svOf(prev)) > 1e-6) || L[i].kiai !== prev.kiai;
    for (let i = 1; i < L.length; i++) {
      const cur = L[i];
      if (cur.uninherited) {
        const prev = lineAt(m, cur.time - 1), pr = m.uni[lastBefore(m.uni, cur.time - 1, "time")];
        if (!pr || cur.beat <= 0 || !downbeatsAligned(cur, pr)) continue; // (a red line that moves the bar lines or changes the BPM is used)
        const odd = [];
        if (cur.omit) odd.push(trv("omits the first bar line"));
        if (pr.omit && beatOffset(pr, cur, pr.meter || 4) !== 0) odd.push(trv("corrects the omitted bar line"));
        if (beatOffset(pr, cur, 4 * (pr.meter || 4)) > 1) odd.push(trv("resets the nightcore mod cymbals"));
        const what = odd.join(", ");
        if (!used(i, prev)) add(odd.length ? "warning" : "problem", odd.length ? "This red line only {what}: check it's intended, or delete it." : "This red line has no effect.", { what }, null, cur.time);
        else add(odd.length ? "warning" : "problem", odd.length ? "This red line only {what}: check it's intended, or use a green line instead." : "Everything this red line changes could be done with a green line.", { what }, null, cur.time);
      } else {
        const prev = L[i - 1]; if (used(i, prev)) continue;
        const sv = Math.abs(svOf(cur) - svOf(prev)) > 1e-6, smp = samplesDiffer(cur, prev);
        add("minor", !sv && !smp ? "This green line repeats the settings of the line before it." : sv && smp ? "This green line changes the SV and sample settings, but no object is affected." : sv ? "This green line changes the SV, but no object is affected." : "This green line changes the sample settings, but no object is affected.", {}, null, cur.time);
      }
    }
  } },
  { cat: "Timing", title: "Concurrent or conflicting timing lines", run(m, add) {
    const L = m.timing;
    for (let i = 1; i < L.length; i++) {
      const a = L[i - 1], b = L[i]; if (Math.abs(a.time - b.time) > 1e-9) continue;
      if (a.uninherited === b.uninherited) { add("problem", "Two {kind} lines at the same time.", { kind: a.uninherited ? "red" : "green" }, null, a.time); continue; }
      const g = a.uninherited ? b : a, r = a.uninherited ? a : b, gs = [], rs = [];
      if (g.kiai !== r.kiai) { gs.push(g.kiai ? "kiai" : "no kiai"); rs.push(r.kiai ? "kiai" : "no kiai"); }
      if (Math.abs(g.volume - r.volume) > 1e-6) { gs.push(g.volume + "%"); rs.push(r.volume + "%"); }
      if (g.sampleSet !== r.sampleSet) { gs.push((SETS[g.sampleSet] || "auto") + " set"); rs.push((SETS[r.sampleSet] || "auto") + " set"); }
      if (g.sampleIndex !== r.sampleIndex) { gs.push("custom " + g.sampleIndex); rs.push("custom " + r.sampleIndex); }
      if (gs.length) add("minor", a.uninherited ? "A red and a green line here disagree (green: {g}, red: {r}); the green one is used." : "A red and a green line here disagree (green: {g}, red: {r}); the red one is used.", { g: gs.join(", "), r: rs.join(", ") }, null, a.time);
    }
  } },
  { cat: "Timing", title: "Timing point volume out of range", run(m, add) {
    for (const tp of m.timing) if (tp.volume < 5 || tp.volume > 100) add("problem", "Timing point volume {v}% is out of range.", { v: tp.volume }, null, tp.time);
  } },
  { cat: "Timing", title: "Unsnapped kiai", run(m, add) {
    const L = m.timing;
    L.forEach((tp, i) => {
      if (!tp.kiai || lineAt(m, tp.time - 1).kiai) return; // (only where kiai starts)
      const u = practicalUnsnap(tp.time, m);
      if (Math.abs(u) >= 10) add("warning", "The kiai start is {ms} ms unsnapped.", { ms: ms3(u) }, null, tp.time);
      else if (Math.abs(u) >= 1) add("minor", "The kiai start is {ms} ms unsnapped.", { ms: ms3(u) }, null, tp.time);
      if (tp.uninherited && L.some(o => !o.uninherited && Math.abs(o.time - tp.time) < 1e-9)) return;
      const n = lineAfter(m, i); if (!n || n.kiai) return;
      const v = practicalUnsnap(n.time, m);
      if (Math.abs(v) >= 1) add("minor", "The kiai end is {ms} ms unsnapped.", { ms: ms3(v) }, null, n.time);
    });
  } },
  { cat: "Timing", title: "Hit object unaffected by a line very close to it", run(m, add) {
    const eff = (tp, t) => svOf(tp) * 60000 / redLineAt(m, t).beat; // effective BPM: slider velocity × BPM
    for (const o of m.hit) {
      if (o.kind !== "slider") continue;
      const ci = lastBefore(m.timing, o.t, "time"); if (ci < 0) continue;
      const n = lineAfter(m, ci); if (!n) continue;
      const dt = n.time - o.t;
      if (dt > 0 && dt <= 5 && Math.abs(practicalUnsnap(o.t, m)) <= 1 && Math.abs(eff(m.timing[ci], o.t) - eff(n, n.time)) > 1)
        add("warning", "{what} sits {ms} ms before a timing point that changes its slider velocity.", { what: "Slider head", ms: ms3(dt) }, o);
    }
  } },
  { cat: "Timing", title: "Breaks", run(m, add) {
    const H = m.hit;
    for (const [a, b] of m.breaks) {
      const k = lastBefore(H, a, "t"), p = H[k], n = H[k + 1];
      const early = p && a - p.t < 200 ? 200 - (a - p.t) : 0, late = n && n.t - b < m.preempt ? m.preempt - (n.t - b) : 0;
      const v = { a: fmtMs(a), b: fmtMs(b), s: ms3(early), e: ms3(late) };
      if (early > 1 && late > 1) add("problem", "Break {a}–{b} starts {s} ms early and ends {e} ms late; re-saving the map in osu! fixes it.", v, null, a);
      else if (early > 1) add("problem", "Break {a}–{b} starts {s} ms early; re-saving the map in osu! fixes it.", v, null, a);
      else if (late > 1) add("problem", "Break {a}–{b} ends {e} ms late; re-saving the map in osu! fixes it.", v, null, a);
      if (b - a < 650) add("warning", "Break from {a} to {b} does nothing because it's shorter than 650 ms.", v, null, a);
    }
  } },
  { cat: "Timing", title: "Inconsistent or unset preview time", run(m, add) { const p = m.general.PreviewTime; if (p == null || p === "" || +p === -1) add("problem", "Preview time is not set."); } },
  { cat: "Timing", title: "Rarely used snapping", run(m, add) {
    const ent = [], cnt = {};
    for (const o of m.hit) for (const [t] of edgesOf(o)) {
      const d = lowestDivisor(t, m); ent.push({ t, d, o, un: Math.abs(practicalUnsnap(t, m)) >= 2 });
      if (d) cnt[d] = (cnt[d] || 0) + 1;
    }
    const total = Object.values(cnt).reduce((a, b) => a + b, 0);
    for (const d in cnt) {
      const c = cnt[d], p = c / total;
      const r = c <= 3 ? ["warning", "Only a few notes (3 or fewer) use 1/{d}: is that intended? ({times})"] : p < .005 ? ["warning", "1/{d} makes up less than 0.5% of the snapping, make sure this makes sense ({times})."]
        : c <= 7 ? ["minor", "Only a few notes (7 or fewer) use 1/{d}: is that intended? ({times})"] : p < .05 ? ["minor", "1/{d} makes up less than 5% of the snapping, make sure this makes sense ({times})."] : null;
      if (!r) continue;
      const at = ent.filter(e => e.d === +d && !e.un), times = [...new Set(at.map(e => fmtMs(e.t)))];
      if (at.length) add(r[0], r[1], { d, times: times.slice(0, 8).join(", ") + (times.length > 8 ? ", …" : "") }, at[0].o, at[0].t);
    }
  } },
  // ----- Compose -----
  { cat: "Compose", title: "Concurrent hit objects", run(m, add) {
    const H = m.hit;
    for (let i = 0; i < H.length - 1; i++) for (let j = i + 1; j < H.length; j++) {
      const a = H[i], b = H[j], gap = b.t - a.end;
      if (gap > 30) break;
      if (gap <= 0) add("problem", "Concurrent {a} and {b}.", { a: kindName(a), b: kindName(b) }, [a, b]);
      else if (gap <= 10 && b.kind !== "spinner") add("problem", "These two objects are only {ms} ms apart.", { ms: ms3(gap) }, [a, b]);
      else break;
    }
  } },
  { cat: "Compose", title: "Too short drain time", run(m, add) {
    const d = drainOf(m); if (m.hit.length && d < 30000) add("problem", "Less than 30 seconds of drain time, currently {s} seconds.", { s: Math.floor(d / 1000) });
  } },
  { cat: "Compose", title: "Offscreen hit objects", run(m, add) {
    const r = rad(m), { top: U, bottom: D, left: Lf, right: R } = REF.screen;
    const amount = p => Math.max(p[0] + r - R, r - p[0] + Lf, p[1] + r - D, r - p[1] + U);
    const by = (p, len = 0) => Math.ceil(Math.max(0, amount(p) + len) * 100) / 100;
    const margin = a => String(Math.floor(Math.max(-a, 0) * 100) / 100);
    for (const o of m.hit) {
      if (o.kind === "spinner") continue;
      const type = o.kind === "circle" ? "Circle" : "Slider head", p = posOf(o); let border = false;
      if (p[1] + r > D) add("problem", "{what} is offscreen.", { what: type }, o);
      else if (by(p) > 0) {
        const pushedBack = !(((p[1] - r < U || p[0] - r < Lf) && o.stack > 0) || (p[0] + r > R && o.stack < 0));
        add(pushedBack ? "warning" : "problem", pushedBack ? "{what} would go off screen, but the game pulls it back in." : "{what} is offscreen.", { what: type }, o);
      } else if (p[1] + r > D - 1) { add("warning", "{what} is {px} px from the edge of the screen.", { what: type, px: margin(amount(p)) }, o); border = true; }
      if (o.kind !== "slider") continue;
      const e = endPosOf(o);
      if (by(e) > 0) { add("problem", "{what} is offscreen.", { what: "Slider tail" }, o, o.end); continue; }
      if (amount(e) > -1) { add("warning", "{what} is {px} px from the edge of the screen.", { what: "Slider tail", px: margin(amount(e)) }, o, o.end); border = true; }
      const body = o.path.map(q => vUnstack(o, q));
      if (body.some(q => by(q) > 0)) { add("problem", "{what} is offscreen.", { what: "Slider body" }, o); continue; }
      if (o.curve !== "L" && body.some(q => by(q, 2) > 0)) {
        const worst = Math.max(...body.map(amount));
        if (worst > 0) add("problem", "{what} is offscreen.", { what: "Slider body" }, o);
        else if (!border) {
          if (worst > -1) add("warning", "{what} is {px} px from the edge of the screen.", { what: "Slider body", px: margin(worst) }, o);
          else add("warning", "Slider body is possibly offscreen, make sure the whole border is visible in 4:3.", {}, o);
        }
        continue;
      }
      if (border) continue;
      let near = null; // the point of the body closest to the edge, if it's within 1 px
      for (const q of body) { const a = amount(q); if (by(q) <= 0 && a > -1 && (!near || a > near)) near = a; }
      if (near != null) add("warning", "{what} is {px} px from the edge of the screen.", { what: "Slider body", px: margin(near) }, o);
    }
  } },
  { cat: "Compose", title: "Too short spinner", run(m, add) {
    const od = +(m.diff.OverallDifficulty ?? 5);
    const warn = odLine(od, REF.spinnerWarn), prob = odLine(od, REF.spinnerProblem);
    for (const o of m.hit) if (o.kind === "spinner") { const d = o.end - o.t;
      if (d < prob) add("problem", "Spinner is so short that even Auto can't score 1000 points on it.", {}, o);
      else if (d < warn) add("warning", "Spinner may be too short: check that Auto still scores 1000 points on it.", {}, o); }
  } },
  { cat: "Compose", title: "Invisible sliders", run(m, add) {
    for (const o of m.hit) if (o.kind === "slider" && o.nodes < 2) add("problem", "Slider has no visible path.", {}, o);
  } },
  { cat: "Compose", title: "Abnormal amount of slider nodes", run(m, add) {
    for (const o of m.hit) if (o.kind === "slider" && o.nodes > 10 * Math.sqrt(Math.max(0, o.length))) add("warning", "Slider has {n} nodes.", { n: o.nodes }, o);
  } },
  { cat: "Compose", title: "Ambiguous slider shape", run(m, add) {
    const r = rad(m);
    for (const o of m.hit) {
      if (o.kind !== "slider") continue;
      const head = [o.rx, o.ry], tail = vUnstack(o, o.path[o.path.length - 1]);
      // head and tail on top of each other, on a slider long enough that the follow circle leaves the head
      if (dist(head, tail) <= 5 && (o.ticks || []).some(([fr]) => dist(vUnstack(o, pathPoint(o, fr)), head) > 2 * r)) add("warning", "The slider's head and tail almost overlap.", {}, o);
      if (o.curve !== "B" && o.curve !== "L") continue;
      const N = o.cps, anchors = o.curve === "L" ? N : N.filter((q, i) => i && q[0] === N[i - 1][0] && q[1] === N[i - 1][1]);
      if (!anchors.length) continue;
      let total = 0; for (let i = 1; i < anchors.length; i++) total += dist(anchors[i - 1], anchors[i]);
      let cur = 0, prev = anchors[0];
      for (const a of anchors) {
        cur += dist(a, prev);
        if (cur > 60 && dist(head, a) <= 5) { add("warning", "The slider head sits on a red anchor, so its shape may be hard to read.", {}, o); break; }
        if (total - cur > 60 && dist(a, tail) <= 5) { add("warning", "The slider tail sits on a red anchor, so its shape may be hard to read.", {}, o); break; }
        prev = a;
      }
    }
  } },
  { cat: "Compose", title: "Obscured reverse arrows", lv: [0, 1, 2, 3], run(m, add) {
    const H = m.hit, r = rad(m), close = r / REF.reverseClose, tooClose = r / 3, ar = arOf(m);
    const opaque = ar < 5 ? 800 + 400 * (5 - ar) / 5 : 800 - 500 * (ar - 5) / 5; // time an object is fully visible before it's hit
    for (const o of H) {
      if (o.kind !== "slider" || o.slides < 2) continue;
      const rt = o.t + o.span, rp = vUnstack(o, o.path[o.path.length - 1]);
      const near = [];
      for (let j = lastBefore(H, rt, "t"); j >= 0 && H[j].t > rt - opaque - 20000; j--) { const p = H[j]; if (p.end > rt - opaque && p.end < rt && p.kind !== "spinner") near.push(p); }
      near.reverse();
      let hit = null, serious = false;
      for (const p of near) {
        const d = dist(p.kind === "slider" ? endPosOf(p) : posOf(p), rp);
        if (d < tooClose) serious = true;
        if (d >= close) continue;
        hit = p.t > o.t ? [o, p] : [p, o]; break;
      }
      if (hit) add("warning", serious ? "Reverse arrow is obscured." : "Reverse arrow is potentially obscured.", {}, hit);
    }
  } },
  { cat: "Compose", title: "Abnormally large spacing", run(m, add) {
    // each jump against the earlier jumps of about the same gap (±5 ms, sliders apart), weighted towards the recent ones
    const H = m.hit, r = rad(m), buckets = new Map(), B = dt => Math.floor(dt / 5);
    for (let i = 0; i + 1 < H.length; i++) {
      const p = H[i], o = H[i + 1]; if (p.kind === "spinner" || o.kind === "spinner") continue;
      const dt = o.t - p.end; if (dt > 180 || dt <= 0) continue;
      let d = Math.max(20, dist(posOf(o), endPosOf(p)));
      const sl = p.kind === "slider", same = [];
      for (let b = B(dt - 5); b <= B(dt + 5); b++) for (const q of buckets.get(b + ":" + sl) || []) if (dt <= q.dt + 5 && dt >= q.dt - 5) same.push(q);
      const key = B(dt) + ":" + sl; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push({ dt, d, p, o });
      if (same.length < 3 || d <= r * 4) continue;
      let top = -Infinity, sD = 0, sT = 0; // (one pass: the fastest earlier jump and the decayed averages)
      for (const q of same) { const k = Math.min(4000 / (p.t - q.p.t), 1); top = Math.max(top, q.d / q.dt * k); sD += q.d * k; sT += q.dt * k; }
      if (d / dt < top) continue;
      const eD = sD / same.length, eT = sT / same.length;
      if (sl) d -= Math.min(r * 3, d);
      const ratio = d / dt / (eD / eT); if (ratio <= 2) continue;
      add(ratio > 15 ? "problem" : ratio > 4 ? "warning" : "minor", "This jump is {x}× bigger than earlier jumps with the same time gap (e.g. {ex}).", { x: (Math.round(ratio * 10) / 10).toString(), ex: same.slice(-3).map(q => tsOf(q.p, q.o)).join(" ") }, [p, o]);
    }
  } },
  { cat: "Compose", title: "Slider only section", lv: [0, 1], run(m, add) {
    let n = 0, lastEnd = 0, dur = 0, first = null;
    const flush = () => { if (n > 6 && dur > 5000 && first) add("minor", "Section is slider only ({n} objects, {s} s). Make sure there is time between objects to rest.", { n, s: Math.floor(dur / 1000) }, first); n = 0; lastEnd = 0; dur = 0; first = null; };
    for (const o of m.hit) {
      if (o.kind !== "slider") { flush(); continue; }
      first = first || o; if (lastEnd) dur += o.t - lastEnd;
      lastEnd = o.end; dur += o.end - o.t; n++;
    }
    flush();
  } },
  // ----- Spread -----
  { cat: "Spread", title: "Too short sliders", lv: [0], run(m, add) {
    for (const o of m.hit) if (o.kind === "slider" && o.end - o.t < 125) add("warning", "Slider is {ms} ms, expected at least 125.", { ms: ms3(o.end - o.t) }, o);
  } },
  { cat: "Spread", title: "Multiple reverses on too short sliders", lv: [0, 1], run(m, add, lvl) {
    const k = lvl === 0 ? 1 : .5, p = 60000 / 240 * k, w = 60000 / 180 * k; // 1/1 (Easy) or 1/2 (Normal) at 240 and 180 BPM
    for (const o of m.hit) if (o.kind === "slider" && o.slides >= 3) { const d = o.end - o.t;
      if (d < p) add("problem", "Multiple reverses on a slider this short can't be read.", {}, o); else if (d < w) add("warning", "Multiple reverses on a slider this short may be hard to read.", {}, o); }
  } },
  { cat: "Spread", title: "Objects close in time not overlapping", lv: [0, 1], run(m, add, lvl, ctx) {
    if (lvl === 1 && ctx && ctx.hasEasy) return; // (only the lowest difficulty: the Easy, or the Normal when there's no Easy)
    const H = m.hit, r = rad(m);
    for (let i = 0; i + 1 < H.length; i++) {
      const p = H[i], o = H[i + 1]; if (p.kind !== "circle" || o.kind === "spinner") continue; // (slider ends don't need to overlap)
      const gap = o.t - p.t; if (gap >= 188 || dist(posOf(o), posOf(p)) < r * 2) continue;
      if (gap < 125) add("problem", "{ms} ms apart, should either overlap or be at least 125 ms apart.", { ms: ms3(gap) }, [p, o]);
      else add("warning", "{ms} ms apart.", { ms: ms3(gap) }, [p, o]);
    }
  } },
  { cat: "Spread", title: "Spinner length / recovery time", lv: [0, 1, 2], run(m, add, lvl) {
    const len = [1000, 750, 500][lvl], rec = [1000, 500, 250][lvl];
    for (const o of m.hit) {
      if (o.kind !== "spinner") continue;
      const d = o.end - o.t;
      if (d < len) add("problem", "Spinner lasts {ms} ms; it should be at least {exp}.", { ms: ms3(d), exp: Math.ceil(len * 4 / 3) }, o);
      else if (d < len * 1.2) add("warning", "Spinner lasts {ms} ms, likely too short (aim for {exp}).", { ms: ms3(d), exp: Math.ceil(len * 4 / 3) }, o);
      const n = m.hit[o.idx + 1]; if (!n || n.kind === "spinner") continue;
      const bpm = 60000 / redLineAt(m, n.t).beat, sc = bpm * bpm / 14400 - bpm / 80 + 1; // 180 BPM = 1, 120 = 0.5, 240 = 2
      const gap = n.t - o.end, scaled = gap / sc, exp = Math.ceil(rec * Math.min(1, sc) * 4 / 3);
      if (scaled < rec && gap < rec) add("problem", "Only {ms} ms to recover after the spinner; it should be at least {exp}.", { ms: ms3(gap), exp }, [o, n]);
      else if (scaled < rec * 1.2 && gap < rec * 1.2) add("warning", "Only {ms} ms to recover after the spinner, likely too little (aim for {exp}).", { ms: ms3(gap), exp }, [o, n]);
    }
  } },
  { cat: "Spread", title: "Perfect stacks too close in time", lv: [0, 1, 2, 3], run(m, add, lvl) {
    const H = m.hit, lim = [1, 1, .5, .25][lvl] * 60000 / 160, r = rad(m);
    for (let i = 0; i < H.length - 1; i++) for (let j = i + 1; j < H.length; j++) {
      const a = H[i], b = H[j];
      if (a.kind === "spinner" || b.kind === "spinner" || b.t - a.t >= lim) break;
      const pa = posOf(a), pb = posOf(b), d = dist(pa, pb);
      if (d === 0) add(lvl >= 3 ? "warning" : "problem", "Raise stack leniency to {v} or more.", { v: (Math.ceil((b.t - a.t) / (m.preempt * .1)) / 10).toFixed(1) }, [a, b]);
      else if (d <= r / 14) add("problem", "These objects are {px} px apart: they look stacked but don't stack.", { px: d.toFixed(2) }, [a, b]);
    }
  } },
  { cat: "Spread", title: "Perfect stacks too close in time with Hard Rock applied", run(m, add) {
    // stable's stacking redone with HR's AR and CS: objects that end up on the exact same spot (or nearly) too close in time
    const H = m.hit, st = H.filter(o => o.kind !== "spinner"); if (!st.length) return;
    const ar = Math.min(10, arOf(m) * 1.4), cs = Math.min(10, +(m.diff.CircleSize ?? 5) * 1.3), r = 32 * (1 - .7 * (cs - 5) / 5);
    const pre = ar < 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5), thr = pre * +(m.general.StackLeniency ?? 0.7);
    const idx = new Map(st.map(o => [o, 0])), onSl = new Set(), near = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < 9;
    const U = o => [o.rx, o.ry], tailPos = o => o.slides % 2 ? endPosOf(o) : U(o);
    for (let changed = true, guard = 0; changed && guard++ < 1000;) {
      changed = false;
      for (let i = 0; i < st.length - 1; i++) for (let j = i + 1; j < st.length; j++) {
        const a = st[i], b = st[j]; if (b.t - a.t > thr) break;
        if (a.kind === "circle" || b.kind === "circle") {
          const can = near(U(a), U(b)), stacked = can && idx.get(a) === idx.get(b) + 1;
          if (can && !stacked) {
            if (b.kind === "slider" || onSl.has(b)) onSl.add(a);
            if (idx.get(a) < 0 && !onSl.has(a)) idx.set(b, idx.get(a) - 1); else idx.set(a, idx.get(b) + 1);
            changed = true; break;
          }
          if (stacked) break;
        }
        if (a.kind !== "slider") continue;
        const can = a.t < b.t && near(U(b), tailPos(a)), stacked = can && idx.get(a) === idx.get(b) + 1;
        if (can && !stacked) {
          if (b.kind === "slider" || onSl.has(b)) { onSl.add(a); idx.set(a, idx.get(b) + 1); } else idx.set(b, idx.get(a) - 1);
          changed = true; break;
        }
        if (stacked) break;
      }
    }
    const hrPos = o => { const p = U(o), k = o.kind === "spinner" ? 0 : idx.get(o) * r * -.1; return [p[0] + k, p[1] + k]; };
    const lim = [1, 1, .5, .25].map(x => x * 60000 / 160), found = [];
    for (let i = 0; i < H.length - 1; i++) for (let j = i + 1; j < H.length; j++) {
      const a = H[i], b = H[j], td = b.t - a.t;
      if (a.kind === "spinner" || b.kind === "spinner" || td >= lim[0]) break;
      if (a.x === b.x && a.y === b.y) continue; // already a perfect stack without HR
      let di = 3; while (di >= 0 && td >= lim[di]) di--;
      const d = dist(hrPos(a), hrPos(b));
      if (d === 0) found.push({ a, b, di, perfect: true, sl: Math.ceil(td / (pre * .1)) });
      else if (d <= r / 14) found.push({ a, b, di, perfect: false, d });
    }
    const seen = new Set();
    for (const f of found) { // pairs sharing an object are reported once, by their worst pair
      if (seen.has(f)) continue;
      const group = [], queue = [f]; seen.add(f);
      while (queue.length) { const c = queue.shift(); group.push(c); for (const g of found) if (!seen.has(g) && (g.a === c.a || g.a === c.b || g.b === c.a || g.b === c.b)) { seen.add(g); queue.push(g); } }
      const best = group.sort((x, y) => (y.perfect - x.perfect) || (y.di - x.di) || ((y.sl ?? -1e9) - (x.sl ?? -1e9)) || ((x.d ?? 1e9) - (y.d ?? 1e9)))[0];
      const objs = [...new Set(group.flatMap(g => [g.a, g.b]))].sort((x, y) => x.t - y.t);
      if (best.perfect) add("minor", "With Hard Rock these objects stack perfectly; raise stack leniency to {v} or more.", { v: (best.sl / 10).toFixed(1) }, objs);
      else add("minor", "With Hard Rock these objects are {px} px apart: they look stacked but don't stack.", { px: best.d.toFixed(2) }, objs);
    }
  } },
  { cat: "Spread", title: "Object too close or far away from previous", lv: [0, 1], run(m, add) {
    // the distance against the last one of about the same gap in the 4 seconds before, else against the recent average speed
    const H = m.hit, obs = []; let issue = null;
    for (let i = 0; i + 1 < H.length; i++) {
      const p = H[i], o = H[i + 1]; if (p.kind === "spinner" || o.kind === "spinner") continue;
      const dt = o.t - p.end; if (dt > 600 || dt <= 0) continue;
      const d = dist(posOf(o), endPosOf(p)); if (d < 8) continue;
      const near = obs.filter(q => q.p.t > p.t - 4000), avr = near.length ? near.reduce((s, q) => s + q.d / q.dt, 0) / near.length : -1;
      let k = -1; for (let j = obs.length - 1; j >= 0; j--) { const q = obs[j]; if (dt <= q.dt * 1.1 && dt >= q.dt * .9 && q.p.t > p.t - 4000) { k = j; break; } }
      if (k !== -1) {
        const exp = obs[k].d;
        if ((Math.abs(exp - d) - 10) / d > .15) {
          if (issue && Math.abs(issue.d - d) / d <= .15) { obs[k] = { dt, d, p }; issue = null; }
          else { const q = obs[k].p; add("warning", "Spacing is {d} px, but a gap of the same length at {ref} has {e} px.", { d: Math.round(d), e: Math.round(exp), ref: tsOf(q, H[q.idx + 1]) }, [p, o]); issue = { dt, d, p }; }
        } else { obs[k] = { dt, d, p }; issue = null; }
      } else if (near.length && (d / dt - .1 > avr * 1.2 || d / dt + .1 < avr * .8)) add("warning", "Spacing is {r} px/ms here; the last few seconds average {e} px/ms.", { r: (d / dt).toFixed(2), e: avr.toFixed(2) }, [p, o]);
      else { obs.push({ dt, d, p }); issue = null; }
    }
  } },
  // ----- Settings -----
  { cat: "Settings", title: "Difficulty settings outside of the guideline range", lv: [0, 1, 2, 3, 4], run(m, add, lvl) {
    const rng = { AR: [[null, 5], [4, 6], [6, 8], [7, 9.3], [8, null]], OD: [[1, 3], [3, 5], [5, 7], [7, 9], [8, null]], HP: [[1, 3], [3, 5], [4, 6], [5, 8], [5, null]], CS: [[null, 4], [null, 5], [null, 6], [null, 7], [null, 7]] };
    const val = { AR: arOf(m), OD: +(m.diff.OverallDifficulty ?? 5), HP: +(m.diff.HPDrainRate ?? 5), CS: +(m.diff.CircleSize ?? 5) };
    for (const k in rng) { const [lo, hi] = rng[k][lvl]; if ((lo != null && val[k] < lo) || (hi != null && val[k] > hi)) add("minor", "{k} {v} is outside the usual {lvl} range ({range}).", { k, v: val[k], lvl: LEVELS[lvl], range: `${lo ?? "…"}–${hi ?? "…"}` }); }
  } },
  { cat: "Settings", title: "Slider tick rate", run(m, add) {
    const r = +(m.diff.SliderTickRate ?? 1), a = Math.round(r * 1000) / 1000; // whole numbers, 1/2, 4/3 and 3/2 line up with the beat snaps
    if (r !== Math.floor(r) && ![.5, 1.333, 1.5].some(x => Math.abs(x - a) < 1e-6)) add("problem", "Slider tick rate {v} doesn't line up with a common beat snap divisor.", { v: a });
  } },
  { cat: "Settings", title: "Too dark or bright combo colours", run(m, add) {
    const b = m.colourMap.SliderBorder; if (b) { const l = hsp(b); if (l < 30) add("problem", "The slider border is far too dark to see."); else if (l < 43) add("warning", "The slider border is very dark."); }
    const n = m.colours.length, inKiai = new Map(); // colour index -> first object in kiai using it
    if (n) for (const o of m.hit) if (o.kind !== "spinner" && lineAt(m, o.t).kiai) { const c = ((o.ci % n) + n) % n; if (!inKiai.has(c)) inKiai.set(c, o); }
    m.colours.forEach((c, i) => {
      const l = hsp(c);
      if (l < 30) add("problem", "Combo colour {n} is far too dark to see.", { n: i + 1 }); else if (l < 43) add("warning", "Combo colour {n} is very dark.", { n: i + 1 });
      if (l > 250 && inKiai.has(i)) add("warning", "Combo colour {n} gets very bright during kiai.", { n: i + 1 }, inKiai.get(i));
    });
  } },
  { cat: "Settings", title: "Default combo colours without a forced skin", run(m, add) { if (!m.colours.length && !m.general.SkinPreference) add("minor", "Default combo colours without a preferred skin."); } },
  // ----- Hit sounds -----
  { cat: "Hit sounds", title: "Low volume hit sounding", run(m, add) {
    const vol = t => m.timing[Math.max(0, lastBefore(m.timing, t + 5 - 1e-6, "time"))].volume; // (the line from 5 ms before)
    if (!m.timing.length) return;
    const v5 = v => Math.max(5, v);
    for (const o of m.hit) {
      if (o.kind === "spinner") continue;
      const v = v5(o.kind === "circle" && o.samp && o.samp.v > 0 ? o.samp.v : vol(o.t)), what = o.kind === "slider" ? "slider head" : "circle";
      if (v <= 10) add("warning", "The {what} is at {v}% volume and may get lost in the music.", { v, what }, o);
      else if (v <= 20) add("minor", "The {what} is at {v}% volume and may get lost in the music.", { v, what }, o);
      if (o.kind !== "slider") continue;
      for (let k = 1; k < o.slides; k++) { const t = Math.trunc(o.t + o.span * k), rv = v5(vol(t)); if (rv <= 10) add("warning", "The {what} is at {v}% volume: fine only if the song has no clear sound here.", { v: rv, what: "slider reverse" }, o, t); }
      const tv = v5(vol(o.end)); if (tv <= 10) add("minor", "The {what} is at {v}% volume: fine only if the song has no clear sound here.", { v: tv, what: "slider tail" }, o, o.end);
      let tick = null; // (the ticks of one slider together)
      for (const [fr] of o.ticks || []) for (let k = 0; k < o.slides; k++) { const t = o.t + o.span * k + (k % 2 ? 1 - fr : fr) * o.span, kv = v5(vol(t)); if (kv <= 10 && (!tick || t < tick.t)) tick = { t, v: kv }; }
      if (tick) add("minor", "The {what} is at {v}% volume: fine only if the song has no clear sound here.", { v: tick.v, what: "slider ticks" }, o, tick.t);
    }
  } },
  { cat: "Hit sounds", title: "Long periods without hit sounding", run(m, add) {
    // a gap counts by its length and the objects in it; breaks and spinners don't count
    const H = m.hit, spinners = H.filter(o => o.kind === "spinner"), found = [];
    let prevTime = H.length ? H[0].t : 0, passed = 0, total = 0, prevSet = null;
    const update = t => {
      const dt = t - prevTime, os = passed * 200; passed = 0; prevTime = t;
      if (dt + os > 30000 && dt > 36000 && os > 1600) found.push(["problem", t - dt, t]);
      else if (dt + os > 10000 && dt > 12000 && os > 400) found.push(["warning", t - dt, t]);
    };
    const feed = (hs, set, t) => { if (prevSet == null) prevSet = set; if (hs > 0 || set !== prevSet) { prevSet = set; total++; update(t); } else passed++; };
    for (const o of H) {
      for (let guard = 0; guard < 1000; guard++) { // jump over breaks and spinners between the last update and this object
        const br = m.breaks.find(([, b]) => b > prevTime && b < o.t), sp = spinners.find(s => s.end > prevTime && s.end < o.t);
        if (!br && !sp) break;
        let xs = br ? br[0] : sp.t, xe = br ? br[1] : sp.end;
        if (br && sp) { xs = Math.max(br[0], sp.t); xe = Math.max(br[1], sp.end); }
        const before = H[lastBefore(H, xs - 1, "t")]; if (!before) break;
        update(before.end);
        const after = H[lastBefore(H, xe, "t") + 1]; if (!after) break;
        prevTime = after.t;
      }
      if (o.kind === "circle") feed(o.hs, setAt(m, o, o.t, 0), o.t);
      else if (o.kind === "slider") {
        feed(vEdgeHs(o, 0), setAt(m, o, o.t, 0), o.t);
        for (let k = 1; k < o.slides; k++) { const t = Math.floor(o.t + o.span * k); feed(vEdgeHs(o, k), setAt(m, o, t, k), t); }
        feed(vEdgeHs(o, o.slides), setAt(m, o, o.end, o.slides), o.end);
      }
    }
    if (H.length && !total) { add("problem", "This map has no hit sounds or sample set changes."); return; }
    for (const [lvl, a, b] of found) add(lvl, "No hit sounds or sample set changes from here to {to} ({s} s).", { to: fmtMs(b), s: ((b - a) / 1000).toFixed(1) }, null, a);
  } },
];

// ---------- mapset-wide checks (every difficulty in the .osz) ----------
const SET_CHECKS = [
  { cat: "Audio", title: "Too high or low audio bitrate", run(ctx, add) {
    const a = ctx.audio; if (!a || !a.kbps) return;
    const lim = /ogg/i.test(a.fmt || "") ? 208 : 192, k = Math.round(a.kbps);
    if (k < 128 || k > lim + 1) add("problem", k < 128 ? "Average audio bitrate for \"{f}\", {k} kbps, is too low." : "Average audio bitrate for \"{f}\", {k} kbps, is too high.", { f: ctx.audioName, k });
  } },
  { cat: "Audio", title: "Incorrect audio format", run(ctx, add) {
    const a = ctx.audio; if (!a) return;
    if (!/mp3|ogg/i.test(a.fmt || "")) add("problem", "\"{f}\" is {fmt}, expected MP3 or OGG.", { f: ctx.audioName, fmt: a.fmt || "?" });
  } },
  { cat: "Audio", title: "Multiple or missing audio files", run(ctx, add) {
    const names = [...new Set(ctx.maps.map(x => norm(x.m.general.AudioFilename || "")))];
    if (names.length > 1) add("problem", "The difficulties use more than one audio file: {list}.", { list: names.join(", ") });
    if (!names.some(n => files[n])) add("problem", "No audio file could be found.");
  } },
  { cat: "Audio", title: "Too short hit sounds", run(ctx, add) {
    for (const k in mapBank) { const b = mapBank[k]; if (b && b.duration < .025 && b.duration > 0) add("problem", "\"{f}\" lasts only {ms} ms (under 25 ms).", { f: k, ms: (b.duration * 1000).toFixed(1) }); }
  } },
  { cat: "Resources", title: "Background", run(ctx, add) {
    const seen = new Set();
    for (const x of ctx.maps) {
      if (!x.m.bg) { add("problem", "[{d}] has no background.", { d: x.m.meta.Version }); continue; }
      const k = norm(x.m.bg); if (seen.has(k)) continue; seen.add(k);
      const f = files[k], im = images[k];
      if (!f) { add("problem", "\"{f}\" is missing.", { f: x.m.bg }); continue; }
      if (im && (im.width > 2560 || im.height > 1440)) add("problem", "\"{f}\" is bigger than 2560 x 1440 ({w} x {h}).", { f: x.m.bg, w: im.width, h: im.height });
      else if (im && (im.width < 1024 || im.height < 640)) add("warning", "\"{f}\" is smaller than 1024 x 640 ({w} x {h}).", { f: x.m.bg, w: im.width, h: im.height });
      const sz = f._data && f._data.uncompressedSize; if (sz > 2.5 * 1048576) add("problem", "\"{f}\" is larger than 2.5 MB ({mb} MB).", { f: x.m.bg, mb: (sz / 1048576).toFixed(2) });
    }
  } },
  { cat: "Resources", title: "Video offset differs between difficulties", run(ctx, add) {
    const offs = [...new Set(ctx.maps.filter(x => x.m.video).map(x => x.m.videoOffset))];
    if (offs.length > 1) add("problem", "Different video offsets between difficulties: {list}.", { list: offs.join(", ") });
  } },
  { cat: "Files", title: "0-byte files", run(ctx, add) {
    for (const k in files) { const f = files[k], sz = f._data && f._data.uncompressedSize; if (sz === 0) add("problem", "\"{f}\" is 0 bytes.", { f: f.name }); }
  } },
  { cat: "Files", title: "Unused files", run(ctx, add) {
    for (const [k, kind] of fileKinds(ctx.maps, ctx.sprites)) if (!kind) add("problem", "\"{f}\" isn't used by any difficulty or storyboard.", { f: files[k].name });
  } },
  { cat: "Metadata", title: "Inconsistent metadata", run(ctx, add) {
    const ref = ctx.maps[0]; if (!ref) return;
    for (const x of ctx.maps.slice(1)) {
      for (const k of ["Title", "TitleUnicode", "Artist", "ArtistUnicode", "Creator", "Source"]) if ((x.m.meta[k] || "") !== (ref.m.meta[k] || "")) add("problem", "Inconsistent {k} between [{a}] and [{b}]: \"{va}\" vs \"{vb}\".", { k, a: ref.m.meta.Version, b: x.m.meta.Version, va: ref.m.meta[k] || "", vb: x.m.meta[k] || "" });
      const ta = new Set((ref.m.meta.Tags || "").toLowerCase().split(/\s+/).filter(Boolean)), tb = new Set((x.m.meta.Tags || "").toLowerCase().split(/\s+/).filter(Boolean));
      const diff = [...ta].filter(t => !tb.has(t)).concat([...tb].filter(t => !ta.has(t)));
      if (diff.length) add("problem", "Inconsistent tags between [{a}] and [{b}], difference: \"{d}\".", { a: ref.m.meta.Version, b: x.m.meta.Version, d: diff.slice(0, 8).join(" ") });
    }
  } },
  { cat: "Metadata", title: "Unicode in romanized fields", run(ctx, add) {
    const M = ctx.maps[0] && ctx.maps[0].m.meta; if (!M) return;
    for (const k of ["Title", "Artist", "Creator"]) { const bad = [...(M[k] || "")].filter(c => c.charCodeAt(0) > 127); if (bad.length) add("problem", "Romanized {k} contains unicode characters: \"{c}\".", { k, c: [...new Set(bad)].join("") }); }
    for (const x of ctx.maps) if ([...(x.m.meta.Version || "")].some(c => c.charCodeAt(0) > 127)) add("minor", "Difficulty name [{d}] contains unicode characters.", { d: x.m.meta.Version });
  } },
  { cat: "Metadata", title: "Incorrect marker format", run(ctx, add) {
    const M = ctx.maps[0] && ctx.maps[0].m.meta; if (!M) return;
    const markers = [[/\(\s*tv\s*(size|ver(sion)?\.?)\s*\)/i, "(TV Size)"], [/\(\s*game\s*(size|ver(sion)?\.?)\s*\)/i, "(Game Ver.)"], [/\(\s*short\s*(size|ver(sion)?\.?)\s*\)/i, "(Short Ver.)"],
      [/\(\s*cut\s*(size|ver(sion)?\.?)\s*\)/i, "(Cut Ver.)"], [/\(\s*sped\s*up\s*(ver(sion)?\.?)?\s*\)/i, "(Sped Up Ver.)"], [/\(\s*night\s*core\s*(ver\.?|mix)\s*\)/i, "(Nightcore Mix)"],
      [/\(\s*extended\s*edit\s*\)/i, "(Extended Edit)"], [/\(\s*movie\s*(size|ver(sion)?\.?|edit|cut)\s*\)/i, "(Movie Ver.)"]];
    for (const k of ["Title", "TitleUnicode"]) for (const [rx, good] of markers) { const mm = (M[k] || "").match(rx); if (mm && mm[0] !== good) add("problem", "{k}: \"{bad}\" should be written \"{good}\".", { k, bad: mm[0], good }); }
    for (const k of ["Artist", "ArtistUnicode", "Title"]) {
      const v = M[k] || "";
      if (/\s(ft\.?|feat|featuring|Feat\.?)\s/.test(v) && !/\sfeat\.\s/.test(v)) add("problem", "{k}: use \"feat.\" for featured artists.", { k });
      if (/\s(vs|VS\.?|Vs\.?)\s/.test(v)) add("problem", "{k}: use \"vs.\".", { k });
      if (/\((cv|Cv|cV)[:：\s]/.test(v)) add("problem", "{k}: use \"CV:\".", { k });
    }
  } },
  { cat: "Metadata", title: "Missing guest mappers in tags", run(ctx, add) {
    const tags = (ctx.maps[0] ? ctx.maps[0].m.meta.Tags || "" : "").toLowerCase().split(/\s+/);
    for (const x of ctx.maps) { // lenient: "riot" matches the tag "riot1133"; very short possessors ("IT'S ...") are skipped
      const mm = (x.m.meta.Version || "").match(/^(.+?)(?:'s|s')\s/i), u = mm && mm[1].toLowerCase().replace(/\s+/g, "_");
      if (u && u.length >= 3 && !tags.some(t => t === u || t.includes(u) || (t.length >= 3 && u.includes(t)))) add("warning", "\"{d}\" looks like a guest difficulty but \"{u}\" isn't in the tags.", { d: x.m.meta.Version, u: mm[1] }); }
  } },
  { cat: "Metadata", title: "Missing genre/language in tags", run(ctx, add) {
    const tags = (ctx.maps[0] ? ctx.maps[0].m.meta.Tags || "" : "").toLowerCase().split(/\s+/), has = w => tags.some(t => t.includes(w));
    const genres = [["video", "game"], ["anime"], ["rock"], ["pop"], ["novelty"], ["hip", "hop"], ["electronic"], ["metal"], ["classical"], ["folk"], ["jazz"]];
    // the website's languages, plus ones it files under "Other" (no point asking for a tag then)
    const langs = "english chinese french german italian japanese korean spanish swedish russian polish instrumental conlang hindi arabic portuguese turkish vietnamese persian indonesian ukrainian romanian dutch thai greek somali malay hungarian czech norwegian finnish danish latvia lithuanian estonian punjabi bengali".split(" ");
    if (!ctx.maps.length) return;
    if (!genres.some(g => g.every(has))) add("warning", "Missing genre tag (\"rock\", \"pop\", \"electronic\", etc.), ignore if none fit.");
    if (!langs.some(has)) add("warning", "Missing language tag (\"english\", \"japanese\", \"instrumental\", etc.), ignore if none fit.");
  } },
  { cat: "Settings", title: "Inconsistent settings", run(ctx, add) {
    const ref = ctx.maps[0]; if (!ref) return;
    const keys = [["problem", "BeatmapSetID", "Metadata"], ["problem", "Countdown", "General"], ["problem", "LetterboxInBreaks", "General"], ["problem", "WidescreenStoryboard", "General"], ["problem", "EpilepsyWarning", "General"], ["problem", "PreviewTime", "General"], ["warning", "AudioLeadIn", "General"], ["warning", "SkinPreference", "General"], ["warning", "SliderTickRate", "Difficulty"]];
    const get = (m, k, s) => ((s === "Metadata" ? m.meta : s === "Difficulty" ? m.diff : m.general)[k] ?? "");
    for (const x of ctx.maps.slice(1)) for (const [lvl, k, s] of keys) { const a = get(ref.m, k, s), b = get(x.m, k, s); if (String(a) !== String(b)) add(lvl, "Inconsistent {k}: [{a}] has \"{va}\", [{b}] has \"{vb}\".", { k, a: ref.m.meta.Version, b: x.m.meta.Version, va: a, vb: b }); }
  } },
  { cat: "Timing", title: "Inconsistent uninherited lines", run(ctx, add) {
    const ref = ctx.maps[0]; if (!ref) return;
    const reds = m => m.timing.filter(x => x.uninherited), same = (a, b) => Math.abs(a.time - b.time) < .001;
    const R = reds(ref.m);
    for (const x of ctx.maps.slice(1)) {
      const X = reds(x.m);
      for (const r of R) {
        const o = X.find(q => same(q, r)), v = { d: x.m.meta.Version, t: fmtMs(r.time), r: ref.m.meta.Version };
        if (!o) add("problem", "[{d}] is missing the red line at {t} that [{r}] has.", v);
        else { if (Math.abs(o.beat - r.beat) > .001) add("problem", "Inconsistent BPM at {t} between [{r}] and [{d}].", v); if ((o.meter || 4) !== (r.meter || 4)) add("problem", "Inconsistent meter at {t} between [{r}] and [{d}].", v); }
      }
      for (const q of X) if (!R.some(r => same(q, r))) add("problem", "[{d}] has an extra red line at {t} that [{r}] doesn't.", { d: x.m.meta.Version, t: fmtMs(q.time), r: ref.m.meta.Version });
    }
  } },
  { cat: "Timing", title: "Inconsistent snapping between difficulties", run(ctx, add) {
    // an edge (head, reverse, tail) with nothing in a harder difficulty within 3 ms, where that difficulty has an edge
    // of its own near it (within the snapping's reach) that this one doesn't: the same sound mapped on different snaps
    const std = ctx.maps.filter(x => !x.m.mode), edges = x => x.m.hit.flatMap(o => edgesOf(o).map(e => e[0]));
    const E = new Map(std.map(x => [x, edges(x).sort((a, b) => a - b)]));
    const has = (L, t) => { let i = lowerIdx(L, t - 3); for (; i < L.length && L[i] < t + 3; i++) if (Math.abs(L[i] - t) < 3) return true; for (i = lowerIdx(L, t - 3) - 1; i >= 0 && L[i] > t - 3; i--) if (Math.abs(L[i] - t) < 3) return true; return false; };
    const reach = (om, t, mpb, ot) => { // how far apart the two may be and still be one sound
      const d = Math.max(lowestDivisor(t, om), 2);
      const one = tt => { const dd = Math.max(lowestDivisor(tt, om), 2), i = SNAP_DIVS.indexOf(dd); return mpb / SNAP_DIVS[Math.min(i + 2, SNAP_DIVS.length - 1)] - 2; };
      if (ot == null) return one(t);
      const hd = Math.max(lowestDivisor(ot, om), 2);
      return d < hd || (d % 3 !== 0 && hd % 3 === 0) ? Math.max(one(t), one(ot)) : 2;
    };
    for (const x of std) {
      let count = 0; // (at most 500 per difficulty)
      const found = new Map(); // edge time here -> [time there, that difficulty]
      for (const y of std) {
        if (!((y.stars ?? 0) > (x.stars ?? 0))) continue;
        const mine = E.get(x), theirs = E.get(y), miss = mine.filter(t => !has(theirs, t)), theirMiss = theirs.filter(t => !has(mine, t));
        for (const t of miss) {
          if (found.has(t)) continue;
          const mpb = redLineAt(y.m, t).beat;
          for (let i = lowerIdx(theirMiss, t - mpb); i < theirMiss.length && theirMiss[i] < t + mpb; i++) {
            const ot = theirMiss[i], gap = Math.abs(t - ot); if (gap <= 3 || gap >= mpb) continue;
            const rg = reach(y.m, t, mpb, ot);
            if (t + rg > ot && t - rg < ot) { found.set(t, [ot, y]); break; }
          }
        }
      }
      for (const [t, [ot, y]] of [...found].sort((a, b) => a[0] - b[0])) {
        const da = lowestDivisor(t, x.m), db = lowestDivisor(ot, y.m); if (!da || !db) continue;
        add("minor", "[{a}] 1/{da} at {ta} vs [{b}] 1/{db} at {tb}: different snapping, make sure it fits the music.", { a: x.m.meta.Version, da, ta: fmtMs(t), b: y.m.meta.Version, db, tb: fmtMs(ot) }, null, t);
        if (++count >= 500) break;
      }
    }
  } },
  { cat: "Hit sounds", title: "Inconsistent hit sounds between difficulties", run(ctx, add) {
    const std = ctx.maps.filter(x => !x.m.mode); if (std.length < 2) return;
    const names = { 2: "whistle", 4: "finish", 8: "clap" };
    const events = x => x.m.hit.flatMap(o => o.kind === "circle" ? [{ t: o.t, hs: o.hs }] : o.kind === "slider" ? [{ t: o.t, hs: vEdgeHs(o, 0) }, { t: o.end, hs: vEdgeHs(o, o.slides) }] : [{ t: o.end, hs: o.hs }]);
    const ev = new Map(std.map(x => [x, events(x)]));
    const find = (L, t) => { let best = null; for (let i = lowerIdx(L, t - 2, "t"); i < L.length && L[i].t < t + 2; i++) if (Math.abs(L[i].t - t) < 2) { best = L[i]; break; } return best; };
    for (const L of ev.values()) L.sort((a, b) => a.t - b.t);
    // a difficulty with its own hit sounding (e.g. a guest difficulty) is left out of the comparison
    const incons = new Map(std.map(x => { let c = 0; for (const e of ev.get(x)) for (const y of std) if (y !== x) { const f = find(ev.get(y), e.t); (e.at || (e.at = new Map())).set(y, f); if (f && f.hs !== e.hs) c++; } return [x, std.length > 1 ? Math.floor(c / (std.length - 1)) : c]; }));
    const vals = [...incons.values()], minI = Math.min(...vals), avgI = vals.reduce((a, b) => a + b, 0) / vals.length;
    const unique = std.filter(x => ev.get(x).length >= 8 && Math.max(incons.get(x) - minI, 0) > avgI && incons.get(x) - minI > ev.get(x).length / 4), comp = std.filter(x => !unique.includes(x));
    for (const x of unique) add("warning", "[{d}] seems to have its own hit sounding, so it was left out of the comparison. Make sure this makes sense.", { d: x.m.meta.Version });
    for (const x of comp) {
      const others = comp.filter(y => y !== x); let count = 0; // (at most 500 per difficulty)
      for (const e of ev.get(x)) {
        const miss = new Set(), with_ = new Set();
        for (const y of others) { const f = e.at.get(y); if (!f) continue; /* (looked up in the pass above) */ const m2 = [2, 4, 8].filter(b => !(e.hs & b) && (f.hs & b)); if (!m2.length) continue; m2.forEach(b => miss.add(names[b])); with_.add(y.m.meta.Version); }
        if (!miss.size) continue;
        add(with_.size * 2 > others.length ? "warning" : "minor", "[{d}] is missing {hs}, which [{others}] has.", { d: x.m.meta.Version, hs: [...miss].join(", "), others: [...with_].join("], [") }, null, e.t);
        if (++count >= 500) break;
      }
    }
    let body = 0;
    for (const x of std) for (const o of x.m.hit) if (o.kind === "slider" && o.hs > 1) { add("minor", "[{d}] This slider body has additions: check they're on purpose.", { d: x.m.meta.Version }, null, o.t); if (++body >= 300) return; }
  } },
  { cat: "Timing", title: "Inconsistent kiai", run(ctx, add) {
    const ref = ctx.maps[0]; if (!ref) return;
    const key = m => m.kiai.map(k => Math.round(k[0]) + "-" + (k[1] === Infinity ? "end" : Math.round(k[1]))).join(",");
    for (const x of ctx.maps.slice(1)) if (key(x.m) !== key(ref.m)) add("minor", "Kiai sections differ between [{a}] and [{b}].", { a: ref.m.meta.Version, b: x.m.meta.Version });
  } },
  { cat: "Settings", title: "Inconsistent combo colours", run(ctx, add) {
    const ref = ctx.maps[0]; if (!ref) return;
    const key = m => m.colours.map(c => c.join(",")).join(" ");
    for (const x of ctx.maps.slice(1)) if (key(x.m) !== key(ref.m)) add("minor", "Combo colours differ between [{a}] and [{b}].", { a: ref.m.meta.Version, b: x.m.meta.Version });
  } },
  { cat: "Spread", title: "Lowest difficulty too hard for the drain time", run(ctx, add) {
    const std = ctx.maps.filter(x => !x.m.mode); if (!std.length) return;
    const low = std.reduce((a, b) => ((a.stars ?? a.lvl) <= (b.stars ?? b.lvl) ? a : b)), d = Math.min(...std.map(x => drainOf(x.m)));
    const need = low.lvl >= 4 ? 240000 : low.lvl === 3 ? 195000 : low.lvl === 2 ? 150000 : 0; // Hard 2:30, Insane 3:15, Expert 4:00
    if (d < need) add("problem", "Drain time is {cur}; with {lvl} as the easiest difficulty it needs at least {need}.", { lvl: LEVELS[low.lvl], need: fmt(need / 1000), cur: fmt(d / 1000) });
  } },
];

// what each file in the package is for (null = nothing uses it)
const HS_FILE_RE = /^(normal|soft|drum)-(hit(normal|whistle|finish|clap)|slider(slide|tick|whistle))\d*\.(wav|ogg|mp3)$/;
const SKIN_FILE_RE = /^(hitcircle|approachcircle|slider|reversearrow|followpoint|spinner|cursor|default-|hit\d|lighting|particle|comboburst|count|go|ready|section|scorebar|score-|pause|fail|applause)/;
function fileKinds(maps, sprites) {
  const kind = new Map(), set = (k, v) => { if (k && !kind.has(k)) kind.set(k, v); };
  for (const x of maps) {
    set(norm(x.m.general.AudioFilename || ""), "Song"); if (x.m.bg) set(norm(x.m.bg), "Background"); if (x.m.video) set(norm(x.m.video), "Video");
    for (const o of x.m.hit) if (o.samp && o.samp.f) set(norm(o.samp.f), "Hit sound");
  }
  for (const s2 of sprites) for (const f of s2.frames) set(f, "Storyboard");
  const out = new Map();
  for (const k in files) {
    const name = k.split("/").pop();
    out.set(k, kind.get(k) || (/\.osu$/.test(k) ? "Difficulty" : /\.osb$/.test(k) ? "Storyboard script" : name === "thumbs.db" ? "System file" : HS_FILE_RE.test(name) ? "Hit sound"
      : /\.(png|jpe?g|wav|ogg|mp3)$/.test(name) && !k.includes("/") && SKIN_FILE_RE.test(name) ? "Skin element" : null));
  }
  return out;
}

// ---------- run + UI ----------
const parsedCache = new Map();
function allMaps() { // every diff in the package, parsed once (the open one uses its live, edited copy)
  return osuFiles.map((f, i) => {
    let m = i === curDiff ? verifyCopy(map) : parsedCache.get(f.text);
    if (!m) { try { m = parseOsu(f.text); } catch { m = null; } if (m) parsedCache.set(f.text, m); }
    if (!m) return null;
    const di = curSet && curSet.diffs.find(d => String(d.bid) === String(m.meta.BeatmapID)), stars = f.stars > 0 ? f.stars : di && di.stars > 0 ? di.stars : null;
    return { m, i, lvl: diffLevel(m, stars), stars };
  }).filter(Boolean);
}
// with the editor's stacking turned off, the open difficulty is read again with stacking, the way the game plays it
function verifyCopy(m) {
  if (!m || typeof EDIT === "undefined" || !EDIT.on || S.edStack !== false) return m;
  const text = editedText(), hit = parsedCache.get("stk:" + text); if (hit) return hit;
  let c = null; REAL_STACKS = true; try { c = parseOsu(text); } catch { c = null; } finally { REAL_STACKS = false; }
  if (c) parsedCache.set("stk:" + text, c);
  return c || m;
}
function verifyAll() {
  SNAP_MEMO = new Map();
  try { return verifyRun(); } finally { SNAP_MEMO = null; }
}
function verifyRun() {
  const maps = allMaps(), ctx = { hasEasy: maps.some(x => !x.m.mode && x.lvl === 0) };
  const run = (checks, arg, lvl) => checks.filter(c => !c.lv || c.lv.includes(lvl)).map(c => {
    const issues = [];
    const add = (lvl, msg, v = {}, objs = null, t = null) => { objs = objs && [].concat(objs); issues.push({ lvl, msg, v, objs, t: t ?? (objs ? objs[0].t : null) }); };
    try { c.run(arg, add, lvl, ctx); } catch (e) { issues.push({ lvl: "minor", msg: "This check failed to run: {err}", v: { err: e.message } }); }
    return { c, issues };
  });
  const sprites = sb.length ? sb : [];
  const general = run(SET_CHECKS, { maps, audio: songMeta, audioName: map ? map.general.AudioFilename : "", sprites });
  const diffs = maps.filter(x => !x.m.mode).map(x => ({ x, res: run(DIFF_CHECKS, x.m, x.lvl) })); // (the difficulty checks are written for osu!standard)
  return { general, diffs };
}
// the last run is reused until something it reads changes, so filters, tabs and the side list don't run the checks again.
// hold: after an edit the shown results stay until editing pauses (Settings → Editor → Verify) or until ↻
const VFY_RUN = { key: null, res: null, hold: false, timer: 0 };
const vfyKey = () => [map, map && map.hit, osuFiles, curDiff, typeof songMeta === "undefined" ? null : songMeta, typeof sb === "undefined" ? null : sb,
  typeof files === "undefined" ? null : files, osuFiles.map(f => f.stars + ":" + f.text.length).join()];
function vfyStale() { const k = VFY_RUN.key, n = vfyKey(); return !VFY_RUN.res || !k || k.some((v, i) => v !== n[i]); }
function vfyResults() {
  const k = VFY_RUN.key, sameDiff = k && k[0] === map && k[2] === osuFiles && k[3] === curDiff; // (holding never shows another difficulty's results)
  if (VFY_RUN.res && ((VFY_RUN.hold && sameDiff) || !vfyStale())) return VFY_RUN.res;
  VFY_RUN.key = vfyKey(); VFY_RUN.res = verifyAll(); VFY_RUN.hold = false;
  return VFY_RUN.res;
}
const vfyHeld = () => VFY_RUN.hold && !!VFY_RUN.key && VFY_RUN.key[0] === map && vfyStale(); // showing results from before the latest edits
function vfyRecheck() { clearTimeout(VFY_RUN.timer); VFY_RUN.hold = false; vfyShow(); }
function vfyShow() {
  if (EDIT.tab === "verify" && VFY.box && VFY.box.isConnected) { const p = VFY.box.closest(".edpanel") || VFY.box.parentElement, top = p ? p.scrollTop : 0; renderVerify(VFY.box); if (p) p.scrollTop = top; }
  if (S.sideVfy && typeof sideOpen === "function" && sideOpen()) sideRender();
}
// after each edit (editor.js): check again now, once editing pauses, or only on ↻
function vfyEdited() {
  clearTimeout(VFY_RUN.timer);
  const shown = EDIT.tab === "verify" || (S.sideVfy && typeof sideOpen === "function" && sideOpen());
  if (!shown) { VFY_RUN.hold = false; return; } // (worked out when Verify is opened next)
  if (S.vfyAuto !== false && S.vfyWait === false) { VFY_RUN.hold = false; vfyShow(); return; }
  VFY_RUN.hold = true;
  if (EDIT.tab === "verify" && VFY.box && VFY.box.isConnected) vfyStaleBar(VFY.box);
  if (S.vfyAuto !== false) VFY_RUN.timer = setTimeout(vfyRecheck, 800);
}
// ---------- rhythm comparison: every difficulty on its own lane, notes coloured by beat snap ----------
const RHY = { beats: 8, vb: 8, vt: null, cv: null, hover: null, moving: false, key: null, maps: null, w: 0, h: 0, d: 0 };
const RHY_COL = { 1: "#fff", 2: "#ff4d5e", 3: "#b35cff", 4: "#4d9bff", 5: "#7fd18b", 6: "#d47bff", 7: "#4fc3c8", 8: "#ffd84a", 9: "#c9a36b", 12: "#aaa", 16: "#888", 0: "#ff00c8" };
// the view glides to the song time / zoom instead of jumping; the frame loop keeps drawing while it moves
function rhyKick() { RHY.moving = true; dirty = true; }
function rhythmView() {
  const wrap = h("div", "rhythm"), head = h("div", "rhead"), c = h("canvas", "rcv");
  head.append(h("b", null, tr("Rhythm comparison")));
  const btn = (txt, title, fn) => { const b = h("button", "btn ghost sm", txt); b.title = tr(title); b.onclick = () => { fn(); rhyKick(); }; head.append(b); };
  btn("◀", "Previous bar", () => seekTo(A.cur() - beatInfo(A.cur()).len * (beatInfo(A.cur()).meter || 4)));
  btn("▶", "Next bar", () => seekTo(A.cur() + beatInfo(A.cur()).len * (beatInfo(A.cur()).meter || 4)));
  btn("−", "Zoom out", () => RHY.beats = Math.min(32, RHY.beats * 2));
  btn("+", "Zoom in", () => RHY.beats = Math.max(2, RHY.beats / 2));
  const leg = h("div", "rleg");
  for (const d of [1, 2, 3, 4, 6, 8, 12, 16]) { const sp = h("span"); const dot = h("i"); dot.style.background = RHY_COL[d]; sp.append(dot, "1/" + d); leg.append(sp); }
  const un = h("span"); const ud = h("i"); ud.style.background = RHY_COL[0]; un.append(ud, tr("unsnapped")); leg.append(un);
  const tip = h("div", "rtip"); tip.hidden = true;
  const cw = h("div", "rcw"); cw.append(c, tip);
  wrap.append(head, cw, leg, h("p", "hint", tr("Each row is one difficulty. Orange columns = 1/3-type and 1/4-type snaps close together in different difficulties. Tap to jump there.") + " " + tr("Mouse: hover for details, scroll to move, Ctrl+scroll to zoom, drag to scrub.")));
  RHY.cv = c; RHY.vt = null; RHY.w = 0;
  // hover: guide line + tooltip for the object under the pointer
  const hitAt = (x, y) => {
    const g = c.geom; if (!g || x < g.labelW) return null;
    const li = Math.floor((y - g.top) / g.laneH), lane = g.maps[li]; if (!lane) return null;
    const tm = g.t0 + (x - g.labelW) / g.pw * g.span, tol = 8 / g.pw * g.span, H = lane.m.hit;
    let best = null, bd = tol;
    for (let i = Math.max(0, lastBefore(H, tm - 30000, "t")); i < H.length; i++) { const o = H[i]; if (o.t > tm + tol) break; const d = tm >= o.t && tm <= o.end && o.kind !== "circle" ? 0 : Math.abs(o.t - tm); if (d <= bd) { bd = d; best = o; } }
    return { lane, tm, o: best };
  };
  let drag = null, tipAt = null;
  const showTip = (x, y) => {
    const r = c.getBoundingClientRect(), hit = hitAt(x, y);
    if (!hit) { tip.hidden = true; return; }
    const o = hit.o, sn = o ? snapOf(o.t, hit.lane.m) : snapOf(Math.round(hit.tm), hit.lane.m);
    tip.textContent = o
      ? `[${hit.lane.m.meta.Version}] ${fmtMs(o.t)} (${o.kind === "spinner" ? "spinner" : o.num}) · ${o.kind}${o.kind === "slider" ? " ×" + o.slides : ""} · ${sn.div ? "1/" + sn.div : tr("unsnapped ({ms} ms)", { ms: Math.round(sn.err) })}`
      : `[${hit.lane.m.meta.Version}] ${fmtMs(hit.tm)}`;
    tip.hidden = false;
    const tw = tip.offsetWidth; tip.style.transform = `translate(${Math.min(Math.max(4, x + 12), r.width - tw - 4)}px,${Math.max(0, y - 34)}px)`;
  };
  c.addEventListener("pointermove", e => {
    const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, g = c.geom; if (!g) return;
    if (drag) { // drag to scrub: the view sticks to the finger
      if (Math.abs(e.clientX - drag.x) > 4) drag.moved = true;
      if (drag.moved) { const nt = drag.t - (e.clientX - drag.x) / g.pw * g.span; seekTo(nt); RHY.vt = A.cur(); drawRhythm(c, 0); }
      tip.hidden = true; return;
    }
    RHY.hover = x >= g.labelW ? x : null; tipAt = [x, y];
    if (!RHY.moving && !isPlaying()) drawRhythm(c, 0);
    showTip(x, y);
  });
  c.addEventListener("pointerleave", () => { tip.hidden = true; RHY.hover = null; tipAt = null; if (!drag) drawRhythm(c, 0); });
  c.addEventListener("pointerdown", e => { drag = { x: e.clientX, t: A.cur(), moved: false }; try { c.setPointerCapture(e.pointerId); } catch {} });
  const endDrag = () => { if (drag && drag.moved) c.dragged = true; drag = null; };
  c.addEventListener("pointerup", endDrag); c.addEventListener("pointercancel", endDrag);
  // wheel: step through the beat snap (Shift / horizontal = a whole bar), Ctrl+wheel = zoom; a trackpad's small deltas are summed up
  let acc = 0;
  c.addEventListener("wheel", e => {
    e.preventDefault();
    const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY), dl = (horiz ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 33 : 1);
    if (e.ctrlKey || e.metaKey) { RHY.beats = Math.max(2, Math.min(32, RHY.beats * Math.exp(dl * .0022))); rhyKick(); return; }
    acc += dl; if (Math.abs(acc) < 40) return;
    const dir = acc > 0 ? 1 : -1; acc = 0;
    if (e.shiftKey || horiz) { const b = beatInfo(A.cur()); seekTo(A.cur() + dir * b.len * (b.meter || 4)); }
    else stepSnap(dir);
    rhyKick();
    if (tipAt) setTimeout(() => tipAt && showTip(tipAt[0], tipAt[1]), 160);
  }, { passive: false });
  c.onclick = e => { if (c.dragged) { c.dragged = false; return; } const r = c.getBoundingClientRect(), g = c.geom; if (!g) return; const x = e.clientX - r.left;
    if (x < g.labelW) { const li = Math.floor((e.clientY - r.top - g.top) / g.laneH), m = g.maps[li]; if (m && m.i !== curDiff) switchDiff(m.i); return; } /* tap a name: switch diff */ seekTo(snapTime(g.t0 + (x - g.labelW) / g.pw * g.span)); rhyKick(); };
  requestAnimationFrame(() => drawRhythm(c, 0));
  return wrap;
}
function rhythmMaps() { // sorted diffs, rebuilt only when the open map changes
  const key = [curDiff, osuFiles.length, map && map.hit].join("|");
  if (RHY.key !== key || RHY.mapHit !== (map && map.hit)) { RHY.maps = allMaps().sort((a, b) => (a.stars ?? a.lvl) - (b.stars ?? b.lvl) || a.i - b.i); RHY.key = key; RHY.mapHit = map && map.hit; }
  return RHY.maps;
}
function drawRhythm(c, dt = 0) {
  if (!map || !c.isConnected) return;
  const maps = rhythmMaps();
  const w = c.clientWidth || 600, laneH = 30, top = 16, hh = top + maps.length * laneH + 6, d = Math.min(devicePixelRatio || 1, 2);
  if (RHY.w !== w || RHY.h !== hh || RHY.d !== d) { RHY.w = w; RHY.h = hh; RHY.d = d; c.style.height = hh + "px"; c.width = Math.round(w * d); c.height = Math.round(hh * d); }
  // ease the view towards the song position and zoom (exact while playing, so it scrolls with the music)
  const target = A.cur(), k = 1 - Math.exp(-dt / 55);
  if (RHY.vt == null || isPlaying() || Math.abs(target - RHY.vt) > 60000) RHY.vt = target; else RHY.vt += (target - RHY.vt) * k;
  RHY.vb += (RHY.beats - RHY.vb) * (dt ? 1 - Math.exp(-dt / 70) : 0);
  if (Math.abs(target - RHY.vt) < .3) RHY.vt = target;
  if (Math.abs(RHY.beats - RHY.vb) < .005) RHY.vb = RHY.beats;
  RHY.moving = RHY.vt !== target || RHY.vb !== RHY.beats;
  if (RHY.moving) dirty = true;
  const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, hh);
  const t = RHY.vt, b0 = beatInfo(t), span = b0.len * RHY.vb, t0 = t - span / 2, t1 = t + span / 2;
  const labelW = Math.min(130, w * .28), pw = w - labelW - 8, X = ms => labelW + (ms - t0) / span * pw;
  c.geom = { t0, span, labelW, pw, top, laneH, maps };
  const range = (H, a) => Math.max(0, lastBefore(H, a - 30000, "t"));
  // conflict columns: 1/3-type and 1/4-type snaps within half a beat of each other in different diffs
  const fam = dv => !dv || dv === 1 ? 0 : dv % 3 === 0 ? 3 : 2, pts = [];
  maps.forEach((x, li) => {
    const H = x.m.hit;
    for (let i = range(H, t0 - b0.len); i < H.length; i++) { const o = H[i]; if (o.t > t1 + b0.len) break; if (o.t < t0 - b0.len) continue; if (o._dv === undefined) o._dv = snapOf(o.t, x.m).div; if (fam(o._dv)) pts.push({ t: o.t, f: fam(o._dv), li }); }
  });
  g.fillStyle = "rgba(255,150,40,.22)";
  for (const p of pts) if (pts.some(q => q.li !== p.li && q.f !== p.f && Math.abs(q.t - p.t) <= b0.len / 2)) g.fillRect(X(p.t) - 4, top, 8, hh - top);
  // beat grid from the open diff
  const U = map.uni, div = S.snap;
  g.font = "10px sans-serif"; g.textBaseline = "alphabetic";
  for (let i = Math.max(0, lastBefore(U, t0, "time")); i < U.length; i++) {
    const u = U[i], end = i + 1 < U.length ? U[i + 1].time : Infinity, step = u.beat / div;
    if (u.time > t1) break;
    if (step / span * pw < 3) continue;
    let k2 = Math.max(0, Math.floor((t0 - u.time) / step));
    for (let tt = u.time + k2 * step; tt <= t1 && tt < end; k2++, tt = u.time + k2 * step) {
      const dv = div / gcd(k2 % div, div), measure = k2 % (div * (u.meter || 4)) === 0, x = X(tt);
      g.globalAlpha = measure ? .5 : dv === 1 ? .28 : .12; g.fillStyle = measure ? "#fff" : RHY_COL[dv] || "#666";
      g.fillRect(x - (measure ? 1 : .5), top, measure ? 2 : 1, hh - top);
      if (measure) { g.globalAlpha = .7; g.fillStyle = "#fff"; g.fillText(fmtMs(tt).slice(0, 5), x + 3, 11); }
    }
  }
  g.globalAlpha = 1;
  // lanes
  maps.forEach((x, li) => {
    const y = top + li * laneH, cy = y + laneH / 2, cur = x.i === curDiff, H = x.m.hit;
    g.fillStyle = cur ? "rgba(255,102,170,.12)" : li % 2 ? "rgba(255,255,255,.03)" : "rgba(255,255,255,.06)"; g.fillRect(0, y, w, laneH - 2);
    g.fillStyle = x.stars != null ? starColor(x.stars) : "#8a7fa3"; g.fillRect(0, y, 4, laneH - 2);
    g.fillStyle = cur ? "#fff" : "#cfc6de"; g.font = (cur ? "600 " : "") + "12px Inter,sans-serif"; g.textBaseline = "middle";
    g.fillText((x.m.meta.Version || "?").slice(0, 18), 9, cy, labelW - 14);
    g.save(); g.beginPath(); g.rect(labelW, y, pw, laneH); g.clip();
    for (let i = range(H, t0); i < H.length; i++) {
      const o = H[i]; if (o.t > t1) break; if (o.end < t0) continue;
      if (o._dv === undefined) o._dv = snapOf(o.t, x.m).div;
      const col = RHY_COL[o._dv] ?? RHY_COL[0];
      if (o.kind === "slider" || o.kind === "spinner") {
        g.globalAlpha = .45; g.fillStyle = o.kind === "spinner" ? "#999" : col; g.fillRect(X(o.t), cy - 4, X(o.end) - X(o.t), 8); g.globalAlpha = 1;
        if (o.kind === "slider") {
          if (!o._de) o._de = Array.from({ length: o.slides }, (_, k) => snapOf(o.t + o.span * (k + 1), x.m).div);
          for (let k = 1; k <= o.slides; k++) { g.fillStyle = RHY_COL[o._de[k - 1]] ?? RHY_COL[0]; g.beginPath(); g.arc(X(o.t + o.span * k), cy, 3.5, 0, 7); g.fill(); }
        }
      }
      g.fillStyle = col; g.beginPath(); g.arc(X(o.t), cy, 6, 0, 7); g.fill();
      g.lineWidth = 1.5; g.strokeStyle = o.type & 4 ? "#fff" : "rgba(0,0,0,.6)"; g.stroke();
    }
    g.restore();
  });
  g.fillStyle = "#ff66aa"; g.fillRect(X(A.cur()) - 1, top - 4, 2, hh - top + 4);
  if (RHY.hover != null && c === RHY.cv) { g.fillStyle = "rgba(255,255,255,.55)"; g.fillRect(Math.round(RHY.hover), top, 1, hh - top); }
}
