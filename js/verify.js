"use strict";
// ============ Verify: map checks for the osu! Ranking Criteria ============
// Which checks to run, their thresholds and how they measure follow MapsetVerifier (Naxess, GPL-3.0,
// github.com/Naxesss/MapsetVerifier), and so does this project's licence: GPL-3.0 (LICENSE, THIRD_PARTY_NOTICES.txt).
// This file is a JavaScript rewrite of those rules, not a copy of MapsetVerifier's C# code, and it has been changed a lot
// from the original (modified 2026 for the web): GPL-3.0 section 5(a) notice. Keep it under GPL-3.0 if you reuse it.
// Times are measured the way osu! stores them (whole ms, cut off), a slider's position is its unstacked one and a
// circle's its stacked one, a break lasts from the object before it to the object after it, and so on.
// Issue levels: "problem" (unrankable), "warning" (check it), "minor" (probably fine).
const LEVELS = ["Easy", "Normal", "Hard", "Insane", "Expert", "Ultra"];
const LV = { problem: 0, warning: 1, minor: 2 };
const DIFF_NAMES = [["beginner", "easy", "novice"], ["basic", "normal", "medium", "intermediate"], ["advanced", "hard"], ["hyper", "insane"], ["expert", "extra", "extreme"]];
function diffLevel(m, stars) { // an exact difficulty name first ("Hard", "Kensuke's Insane"), else the star rating (MV Beatmap.GetDifficulty)
  const [owner, collab, other, space] = MV_NAME_RE; // (.NET's Unicode \w, \b and \s, like MV's regexes)
  const n = String(m.meta.Version || "").toLowerCase().replace(owner, "").replace(collab, "").replace(other, " ").replace(space, " ").replace(/^ | $/g, "");
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
const drainOf = m => mvDrain(m); // (drain time as MapsetVerifier measures it: see mvDrain)
const tsOf = (...objs) => fmtMs(objs[0].t) + " (" + objs.map(o => o.kind === "spinner" ? "spinner" : o.num).join(",") + ")";
// a slider tail that the pixel-length maths puts a hair before an upcoming red line that moves the bar lines
function tailOnNextRed(m, t) {
  const cur = redLineAt(m, t), next = nextRedLine(m, t);
  return !!next && next.time - t <= 2 && !downbeatsAligned(cur, next);
}
// the normal sample set an edge plays with, read the way MapsetVerifier does: a slider edge's own set, else the timing
// line's (5 ms early), never the slider's; a circle's or spinner's own set, else the line's (k: 0 head, 1… reverses, slides tail)
function setAt(m, o, t, k) {
  if (o.kind !== "slider") return mvObjSet(m, o, false, t);
  const E = mvSl(o), own = k === 0 ? E.ss : k >= o.slides ? E.es : E.rs[k - 1] | 0;
  return own || mvLineSet(m, t);
}
// an edge's hit sound (MV): a slider line without edge hit sounds gives every edge the slider's own (mvSl)
const vEdgeHs = (o, k) => { if (o.kind !== "slider") return o.hs; const E = mvSl(o); return k === 0 ? E.sh : k >= o.slides ? E.eh : E.rh[k - 1] | 0; };

// ---- MV parity: settings & difficulty helpers ----
// The settings, events and score checks read the .osu the way MapsetVerifier's parser does, quirks included, so
// their results are the same: a setting is a single-precision float clamped to MV's range (0 when missing), a key
// is the first line that starts with it, a time is cut to a whole ms, and so on.
const f32 = Math.fround;
const MV_W = "[\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}]", MV_S = "\\f\\n\\r\\t\\v\\x85\\p{Z}"; // .NET's \w and \s
const MV_NAME_RE = [new RegExp(`^[${MV_S}]*${MV_W}+'s[${MV_S}]+`, "u"), new RegExp(`(?<!${MV_W})collab(?!${MV_W})`, "gu"), new RegExp(`[^a-z0-9${MV_S}]`, "gu"), new RegExp(`[${MV_S}]+`, "gu")];
const mvKey = (o, key) => { for (const k in o) if (k.startsWith(key)) return o[k]; return null; }; // (the first line starting with the key)
const mvGen = (m, key) => mvKey(m.general, key);
const MV_CLAMP = { HPDrainRate: [0, 10], CircleSize: [0, 18], OverallDifficulty: [0, 10], ApproachRate: [0, 10], SliderMultiplier: [.4, 3.6], SliderTickRate: [.5, 8] };
function mvDiff(m, key) { // DifficultySettings: a float, clamped, 0 when the line is missing (so no AR = AR 0)
  const s = mvKey(m.diff, key); if (s == null) return 0;
  const v = f32(parseFloat(s)), lo = f32(MV_CLAMP[key][0]), hi = f32(MV_CLAMP[key][1]);
  return isNaN(v) ? 0 : v < lo ? lo : v > hi ? hi : v;
}
function fstr(v) { // a float printed like .NET does (the fewest digits that read back as the same float)
  v = f32(v); if (!isFinite(v)) return String(v);
  for (let p = 1; p < 10; p++) { const s = +v.toPrecision(p); if (f32(s) === v) return String(s); }
  return String(v);
}
function roundEven(x, d = 0) { // Math.Round (MidpointRounding.ToEven)
  const k = 10 ** d, y = x * k, r = Math.round(y);
  return (Math.abs(y % 1) === .5 ? (r % 2 ? r - 1 : r) : r) / k;
}
const mvDp2 = v => String(+(+v).toFixed(2)); // C# "0.##"
const mvInt = s => { const v = parseInt(s, 10); return isNaN(v) ? 0 : v; };
const mvGroup = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); // C# "N0"
function mvTime(t) { // Timestamp.Get without its " - ": cut to a whole ms
  const ms = Math.trunc(t); if (!isFinite(ms)) return String(ms);
  if (ms < 0) return String(ms);
  const mi = Math.floor(ms / 60000);
  return (mi >= 10 ? mi : "0" + mi) + ":" + String(Math.floor(ms / 1000) % 60).padStart(2, "0") + ":" + String(ms % 1000).padStart(3, "0");
}
// [Events] lines of a type, read like MV (only lines that start with "Type," count, untrimmed)
const mvEvents = (raw, types) => String(raw || "").split("\n").map(l => l.replace(/\r/g, "")).filter(l => types.some(t => l.startsWith(t + ",")));
const mvDiffSb = m => mvEvents(m.eventsRaw, ["Sprite", "4", "Animation", "6"]).length > 0; // Beatmap.HasDifficultySpecificStoryboard
function mvSection(lines, sec) { // ParserStatic.ParseSection: from a line containing [sec] until a line starting with "["
  const out = []; let read = false;
  for (const l of lines) { if (l.startsWith("[")) read = false; if (read && l.trim()) out.push(l.replace(/\r/g, "")); if (l.includes("[" + sec + "]")) read = true; }
  return out;
}
function mvOsbEvents(text) { // Osb: the [Variables] substituted into the whole script, then its [Events] lines
  let code = String(text);
  for (const l of mvSection(code.split("\n"), "Variables")) if (l.startsWith("$")) { const p = l.split("="); code = code.split(p[0].trim()).join((p[1] || "").trim()); }
  return mvSection(code.split("\n"), "Events");
}
const mvSamples = lines => mvEvents(lines.join("\n"), ["Sample", "5"]).map(l => { const a = l.split(","); return { time: parseFloat(a[1]), path: String(a[3] ?? "").replace(/"/g, "").replace(/\\/g, "/").trim(), volume: a.length > 4 ? fstr(parseFloat(a[4])) : "100" }; });
const mvOsb = ctx => ctx.osb !== undefined ? ctx.osb : typeof osbText === "string" && osbText ? osbText : null; // the set's .osb, if any
function mvCountdownStart(m) { // Beatmap.GetCountdownStartBeat: below 0 = no countdown shows
  const first = m.hit[0]; if (!first) return 0;
  const reds = m.timing.filter(x => x.uninherited); if (!reds.length) return 0;
  const line = reds[Math.max(0, lastBefore(reds, 0, "time"))], beat = line.beat;
  let fb = line.time;
  if (beat > 0) { const n = (fb - beat) / beat; if (n > 1e6) fb -= beat * Math.floor(n - 1); while (fb - beat > 0) fb -= beat; }
  const cd = mvInt(mvGen(m, "Countdown") ?? "0"), mult = cd === 0 ? 1 : cd === 2 ? 2 : .45;
  return Math.trunc((first.t - fb) / beat) - ((fb > 5 ? 5 : 6) + mvInt(mvGen(m, "CountdownOffset") ?? "0")) * mult;
}
// the order MV sorts difficulties in: mode, interpreted level, star rating, object density
const mvSorted = maps => maps.map(x => ({ x, dens: x.m.hit.length / mvDrain(x.m) })).sort((a, b) => (a.x.m.mode - b.x.m.mode) || (a.x.lvl - b.x.lvl) || ((a.x.stars ?? 0) - (b.x.stars ?? 0)) || (a.dens - b.dens) || 0).map(s => s.x);
// ScoreV1 the way MV gets it: osu!lazer's OsuLegacyScoreSimulator (ppy/osu, MIT) with HD HR DT FL, on lazer's reading of the map
function mvLazerTicks(m, o, reds, sm, rate) { // ticks per span: Slider.ApplyDefaultsToSelf + SliderEventGenerator
  const red = reds[Math.max(0, lastBefore(reds, o.t, "time"))], beat = red ? Math.min(60000, Math.max(6, red.beat)) : 1000;
  const k = lastBefore(m.timing, o.t, "time"), tp = k >= 0 ? m.timing[k] : null;
  const sv = tp && !tp.uninherited && tp.beat < 0 ? Math.min(10, Math.max(.1, 100 / -tp.beat)) : 1, ticksOn = !(tp && isNaN(tp.beat));
  const asBeat = -100 / sv, bpmMult = asBeat < 0 ? Math.min(1000, Math.max(10, f32(-asBeat))) / 100 : 1; // GetPrecisionAdjustedBeatLength
  const vel = 100 * sm / (beat * bpmMult), length = Math.min(100000, o.dist || 0);
  let td = ticksOn ? vel * beat / rate * ((m.version || 14) < 8 ? 1 / sv : 1) : Infinity;
  td = Math.min(length, Math.max(0, td));
  if (!td) return 0;
  let n = 0; for (let d = td; d <= length; d += td) { if (d >= length - vel * 10) break; n++; }
  return n;
}
function mvPeppyStars(hp, od, cs, objects, drain) { // LegacyRulesetExtensions.CalculateDifficultyPeppyStars, in exact decimals
  const big = v => { // (decimal)(double)float: 15 significant digits, scaled by 1e20
    let [mant, exp = "0"] = v.toPrecision(15).toLowerCase().split("e"); const neg = mant[0] === "-"; if (neg) mant = mant.slice(1);
    const [ip, fp = ""] = mant.split("."), pos = ip.length + +exp + 20; if (pos <= 0) return 0n;
    const r = BigInt((ip + fp).padEnd(pos, "0").slice(0, pos) || "0"); return neg ? -r : r;
  };
  const S = big(hp) + big(od) + big(cs), E = 10n ** 20n;
  let rn = 16n, rd = 1n; // objects / drain * 8, clamped to 0..16 (16 with no drain)
  if (drain !== 0) { rn = BigInt(objects * 8); rd = BigInt(drain); if (rd < 0n) { rn = -rn; rd = -rd; } if (rn < 0n) rn = 0n; if (rn > 16n * rd) { rn = 16n; rd = 1n; } }
  const num = (S * rd + rn * E) * 5n, den = 38n * rd * E, q = num / den, rem = num - q * den;
  return Number(2n * rem > den || (2n * rem === den && q % 2n) ? q + 1n : q);
}
function mvScoreV1(m) { // -> { combo, score }: max combo and the HDHRDTFL SS ScoreV1 (accuracy + combo × mod multiplier + bonus)
  const H = m.hit, num = (k, d, lo, hi) => { const v = parseFloat(m.diff[k]); return Math.min(hi, Math.max(lo, isNaN(v) ? d : v)); };
  const hp = f32(num("HPDrainRate", 5, 0, 10)), cs = f32(num("CircleSize", 5, 0, 10)), od = f32(num("OverallDifficulty", 5, 0, 10));
  const sm = num("SliderMultiplier", 1.4, .4, 3.6), rate = num("SliderTickRate", 1, .5, 8), reds = m.timing.filter(x => x.uninherited);
  let drain = 0;
  if (H.length) { let brk = 0; for (const [a, b] of m.breaks) brk += roundEven(Math.max(a, b)) - roundEven(a); drain = Math.trunc((roundEven(H[H.length - 1].t) - roundEven(H[0].t) - brk) / 1000); }
  const mult = mvPeppyStars(hp, od, cs, H.length, drain);
  let combo = 0, comboScore = 0, acc = 0, bonus = 0;
  const end300 = () => { comboScore += Math.trunc(Math.max(0, combo - 1) * (12 * mult)); acc += 300; }; // (300 / 25: integer maths)
  for (const o of H) {
    if (o.kind === "slider") { const n = mvLazerTicks(m, o, reds, sm, rate); combo += 2 + n * o.slides + o.slides - 1; acc += 30 * (o.slides + 1) + 10 * n * o.slides; end300(); }
    else if (o.kind === "spinner") {
      const sec = Math.max(0, o.end - o.t) / 1000, total = Math.trunc(sec * (477 / 60) * 2), before = Math.trunc(sec * 3) + 3;
      const B = total > before ? Math.floor((total - before) / 2) : 0, T = (total >= 2 ? Math.floor(total / 2) : 0) - (before % 2 ? 0 : B);
      bonus += 1100 * B + 100 * T; end300(); combo++;
    } else { end300(); combo++; }
  }
  return { combo, score: acc + roundEven(comboScore * (1.06 * 1.06 * 1.12 * 1.12)) + bonus };
}

// ---- MV parity: stacking & timing helpers ----
// Users compare these results with MapsetVerifier, so the checks that use the helpers below read a map the way it does,
// quirks included: 32-bit floats where it uses them, its own stacking (start to start, and sliders get stack indices too,
// shifted by stack index × whole radius × 0.1), its own slider paths (sampled along time), its slider end time (the exact
// end plus that end's practical unsnap), unclamped slider velocity, values read straight from the file (AR 0 when it's
// missing) and C#'s Math.Round. Only Verify uses this: drawing, playback and the editor keep the game's own values.
const csRound = x => { const f = Math.floor(x), d = x - f; return d < .5 ? f : d > .5 ? f + 1 : f % 2 === 0 ? f : f + 1; }; // (a half goes to the even number)
const mvEq = (a, b) => !isFinite(a) || !isFinite(b) ? a === b : Math.abs(a - b) < 10 * 2 ** -53; // MathNet AlmostEqual (absolute)
const mvEqF = (a, b) => !isFinite(a) || !isFinite(b) ? a === b : Math.abs(f32(a - b)) < f32(10 * 2 ** -24); // (its float version)
const fmt2 = v => String(+(+v).toFixed(2)); // C# "0.##"
const mvVD = (a, b) => { const x = f32(a[0] - b[0]), y = f32(a[1] - b[1]); return f32(Math.sqrt(f32(f32(x * x) + f32(y * y)))); }; // Vector2.Distance / Length (float)
const mvD = (a, b) => { const x = f32(a[0] - b[0]), y = f32(a[1] - b[1]); return Math.sqrt(x * x + y * y); }; // Slider.GetDistance (float differences, double sum)
function mvLine(tp, i) { // a timing line as MapsetVerifier reads its text
  const a = timingLine(tp).split(","), beat = +a[1], uni = a.length > 6 ? a[6].trim() === "1" : true, fx = a.length > 7 ? parseInt(a[7], 10) | 0 : 0;
  return { tp, time: +a[0], beat, bpm: 60000 / beat, meter: a.length > 2 ? parseInt(a[2], 10) : 4, set: parseInt(a[3], 10) | 0, idx: parseInt(a[4], 10) | 0, vol: f32(+a[5]),
    uni, kiai: (fx & 1) === 1, omit: (fx & 8) === 8, sv: uni ? 1 : beat < 0 ? 100 / -beat : 1, i };
}
const MV_CACHE = new WeakMap();
function mvMap(m) { // MapsetVerifier's reading of a difficulty, built once per version of the map
  const sig = m.timing.map(timingLine).join(";") + "|" + ["CircleSize", "ApproachRate", "SliderMultiplier", "SliderTickRate"].map(k => m.diff[k]).join() + "|" + m.general.StackLeniency;
  const old = MV_CACHE.get(m.hit); if (old && old.sig === sig) return old;
  const lines = m.timing.map(mvLine).sort((a, b) => a.time - b.time || (a.uni ? 0 : 1) - (b.uni ? 0 : 1));
  lines.forEach((l, i) => l.i = i);
  const U = lines.filter(l => l.uni), dv = (k, lo, hi) => { const r = m.diff[k]; if (r == null) return 0; let v = f32(+r); if (v < lo) v = lo; if (v > hi) v = hi; return v; };
  const range = (d, mn, av, mx) => d < 5 ? av + (mx - av) * (5 - d) / 5 : av - (av - mn) * (d - 5) / 5; // DifficultyRange
  const cs = dv("CircleSize", 0, 18), ar = dv("ApproachRate", 0, 10), r = f32(32 * f32(1 - f32(f32(f32(.7) * f32(cs - 5)) / 5)));
  const M = { sig, m, lines, U: U.length ? U : [{ time: 0, beat: 500, bpm: 120, meter: 4, uni: true, sv: 1, i: -1 }], cs, ar, r, ri: Math.trunc(r),
    sm: dv("SliderMultiplier", f32(.4), f32(3.6)), tick: dv("SliderTickRate", f32(.5), 8), sl: f32(f32(+(m.general.StackLeniency ?? "0.7")) * 10),
    fadeIn: range(ar, 450, 1200, 1800), preempt: range(ar, 300, 800, 1200), stacked: false };
  const text = new Map(m.lines.map(L => [L.id, L.s]));
  M.objs = m.hit.map((o, i) => mvObj(M, o, text.get(o.lid) || "", i));
  MV_CACHE.set(m.hit, M);
  return M;
}
const mvLineAt = (M, t) => M.lines.length ? M.lines[Math.max(0, lastBefore(M.lines, t, "time"))] : null; // GetTimingLine (either colour; the first before them all)
const mvUniAt = (M, t) => M.U[Math.max(0, lastBefore(M.U, t, "time"))];
const mvNextUni = (M, t) => M.U[Math.max(0, lastBefore(M.U, t, "time")) + 1] || null; // GetNextTimingLine<UninheritedLine> (before the first red line: the second one)
function mvNext(M, l) { let n = null; for (let i = l.i + 1; i < M.lines.length; i++) { n = M.lines[i]; if (!mvEq(n.time, l.time)) break; } return n; } // TimingLine.Next(skipConcurrent)
function mvObj(M, o, s, i) {
  const p = s.split(","), mo = { o, i, kind: o.kind, t: o.t, ux: f32(+p[0]), uy: f32(+p[1]), stack: 0, onSlider: false };
  if (!isFinite(mo.ux) || !isFinite(mo.uy)) { mo.ux = f32(o.rx ?? o.x); mo.uy = f32(o.ry ?? o.y); }
  if (o.kind === "spinner") { mo.endTime = p.length > 5 && isFinite(+p[5]) ? +p[5] : o.end; return mo; }
  if (o.kind !== "slider") { mo.endTime = mo.t; return mo; }
  const path = p[5] || "", ty = path.slice(0, path.indexOf("|") < 0 ? path.length : path.indexOf("|"));
  mo.curve = ty.length > 1 && ty[0] === "B" && /^\d+$/.test(ty.slice(1)) && +ty.slice(1) >= 1 ? "S" : ({ L: "L", P: "P", B: "B" })[ty] || "C"; // S: lazer's B-spline
  mo.huge = path.length > HUGE_CURVE;
  if (mo.huge) { mo.nodes = null; mo.nodeCount = o.nodes; }
  else {
    mo.nodes = [[mo.ux, mo.uy]];
    for (const part of path.split("|").slice(1)) { const q = part.split(":"); if (q.length >= 2) mo.nodes.push([f32(+q[0]), f32(+q[1])]); }
    mo.nodeCount = mo.nodes.length;
  }
  mo.edges = Math.min(9000, +p[6] | 0); mo.len = f32(+p[7]);
  const u = mvUniAt(M, mo.t), at = mvLineAt(M, mo.t);
  mo.ppm = 100 * (at ? at.sv : 1) * M.sm / u.beat; // px per ms (GetSliderSpeed: unclamped SV)
  mo.dur = mo.len / mo.ppm; // one span
  const exact = mo.t + mo.dur * mo.edges;
  mo.endTime = exact + mvUnsnap(M, exact); // (MapsetVerifier's slider end: the exact end moved by its own unsnap)
  const work = mo.nodes ? mo.nodeCount * Math.max(1, mo.ppm * mo.dur) : Infinity;
  mo.approx = !mo.nodes || mo.curve === "S" || !(mo.ppm * mo.dur < 2e5) || work > 5e7; // (paths too big to sample its way: the game's path instead)
  if (!mo.approx && mo.curve === "B") { let w = 0, n = 1; for (let k = 1; k < mo.nodes.length; k++) { if (mo.nodes[k][0] === mo.nodes[k - 1][0] && mo.nodes[k][1] === mo.nodes[k - 1][1]) { w += n * n; n = 1; } else n++; } if (w + n * n > 4e4) mo.approx = true; }
  return mo;
}
const mvEdgeTimes = mo => { // GetEdgeTimes: the exact times (not the moved slider end)
  if (mo.kind === "spinner") return [mo.t, mo.endTime];
  if (mo.kind !== "slider") return [mo.t];
  const e = [mo.t]; for (let k = 0; k < mo.edges; k++) e.push(mo.t + mo.dur * (k + 1)); return e;
};
function mvPartName(mo, t) {
  if (mo.kind === "circle") return "Circle";
  const close = e => e <= t + 2 && e >= t - 2, E = mvEdgeTimes(mo);
  return (mo.kind === "slider" ? "Slider " : "Spinner ") + (close(mo.t) ? "head" : close(mo.endTime) || close(E[E.length - 1]) ? "tail" : E.some(close) ? "reverse" : "body");
}
// snapping as Beatmap.GetPracticalUnsnap / GetTheoreticalUnsnap / GetLowestDivisor do it, on MapsetVerifier's own red lines
function mvSnapParts(t, u) { const div = (t - u.time) / u.beat, frac = div - f32(Math.floor(div)); return [frac * u.beat / u.beat, f32(Math.floor((t - u.time) / u.beat))]; }
const mvPU = (t, d, u) => { const [cf, beat] = mvSnapParts(t, u); return t - Math.trunc(u.time + (f32(beat * d) + csRound(cf * d)) * u.beat / d); };
function mvPick(c) { let mn = Infinity; for (const x of c) mn = isNaN(x) ? NaN : Math.min(mn, Math.abs(x)); const r = c.find(x => mvEq(Math.abs(x), mn)); return r === undefined ? NaN : r; }
const mvUnsnap = (M, t, u = mvUniAt(M, t)) => mvPick([16, 12, 9, 7, 5].map(d => mvPU(t, d, u)));
const mvTheo = (M, t, u = mvUniAt(M, t)) => mvPick([16, 12, 9, 7, 5].map(d => { const cf = mvSnapParts(t, u)[0]; return (cf - csRound(cf * d) / d) * u.beat; }));
// TimingUtils.AreDownbeatsAligned: same BPM and meter and the line on a downbeat of the other, measured one way only
function mvBeatOffset(a, b, mod) { const x = ((b.time - a.time) / a.beat) % mod; return Math.min(Math.abs(x), Math.abs(x - mod)) * a.beat; }
const mvAligned = (line, other) => mvEq(other.bpm, line.bpm) && other.meter === line.meter && mvBeatOffset(other, line, other.meter) <= 1;
function mvTailOnNextRed(M, t) { // a slider tail a hair before an upcoming red line that moves the bar lines
  const cur = mvUniAt(M, t), next = mvNextUni(M, t);
  return !!next && next.time > t && next.time - t <= 2 && !mvAligned(cur, next);
}
function mvDrain(m) { // Beatmap.GetDrainTime: breaks from the end of the object before to the start of the one after, unclamped
  const H = mvMap(m).objs; if (!H.length) return 0;
  const start = H[0].t, end = H[H.length - 1].endTime, at = t => Math.max(0, lastBefore(H, t, "t"));
  let br = 0;
  for (const [a, b] of m.breaks) {
    const k = at(a), from = H[k].endTime < a ? H[k].endTime : k > 0 ? H[k - 1].endTime : 0, j = at(b) + 1;
    br += (j < H.length ? H[j].t : end - start) - from;
  }
  return end - start - br;
}
// MapsetVerifier's stacking (Beatmap.ApplyStacking): repeated passes, stack time measured start to start
function mvStack(M) {
  M.stacked = true;
  const S = M.objs.filter(x => x.kind !== "spinner"), thr = M.fadeIn * M.sl * .1, inTime = (a, b) => b.t - a.t <= thr;
  const d2 = (ax, ay, bx, by) => { const x = f32(ax - bx), y = f32(ay - by); return f32(f32(x * x) + f32(y * y)); };
  const can = (a, b) => inTime(a, b) && d2(a.ux, a.uy, b.ux, b.uy) < 9, is = (a, b) => can(a, b) && a.stack === b.stack + 1;
  const canTail = (s, b) => { const e = s.edges % 2 === 0 ? [s.ux, s.uy] : mvUEnd(M, s); return inTime(s, b) && d2(b.ux, b.uy, e[0], e[1]) < 9 && s.t < b.t; };
  const isTail = (s, b) => canTail(s, b) && s.stack === b.stack + 1;
  let changed, work = 0;
  do {
    changed = false;
    for (let i = 0; i < S.length - 1; i++) for (let j = i + 1; j < S.length; j++) {
      const a = S[i], b = S[j]; work++;
      if (!inTime(a, b)) break;
      if (a.kind === "circle" || b.kind === "circle") {
        if (can(a, b) && !is(a, b)) {
          if (b.kind === "slider" || b.onSlider) a.onSlider = true;
          if (a.stack < 0 && !a.onSlider) b.stack = a.stack - 1; else a.stack = b.stack + 1;
          changed = true; break;
        }
        if (is(a, b)) break;
      }
      if (a.kind !== "slider") continue;
      if (canTail(a, b) && !isTail(a, b)) {
        if (b.kind === "slider" || b.onSlider) { a.onSlider = true; a.stack = b.stack + 1; } else b.stack = a.stack - 1;
        changed = true; break;
      }
      if (isTail(a, b)) break;
    }
  } while (changed && work < 5e7); // (a bound for pathological maps)
}
function mvPos(M, mo) { // stacked Position (a spinner: where the file puts it)
  if (!M.stacked) mvStack(M);
  if (!mo.pos) { const off = mo.kind === "spinner" ? 0 : f32(mo.stack * M.ri * f32(-.1)); mo.pos = [f32(mo.ux + off), f32(mo.uy + off)]; }
  return mo.pos;
}
const mvStackVec = (M, mo) => { const p = mvPos(M, mo); return [f32(p[0] - mo.ux), f32(p[1] - mo.uy)]; };
const mvUEnd = (M, mo) => mo.edges % 2 === 1 ? mvPathPx(M, mo).at(-1) : [mo.ux, mo.uy]; // UnstackedEndPosition
function mvEndPos(M, mo) { // EndPosition: stacked like the head
  if (mo.kind !== "slider") return mvPos(M, mo);
  const e = mvUEnd(M, mo), p = mvPos(M, mo);
  return [f32(f32(e[0] + p[0]) - mo.ux), f32(f32(e[1] + p[1]) - mo.uy)];
}
const mvPrevDist = (M, o, p) => mvVD(mvPos(M, o), p.kind === "slider" ? mvEndPos(M, p) : mvPos(M, p)); // HitObject.GetPrevDistance
// slider paths as Slider.cs follows them (unstacked; `head` is the head Position at the time of the call, which only the
// linear path's first leg reads)
const MV_STEP = .0005;
function mvFrac(mo, time) { const d = (time - mo.t) / mo.dur, fl = Math.floor(d); let f = d - fl; if (mvEq(fl % 2, 1)) f = 1 - f; return f; }
function mvLinear(mo, time, head) {
  const N = mo.nodes, fr = mvFrac(mo, time), lens = []; let prev = head, sum = 0;
  for (let i = 1; i < N.length; i++) {
    let d; if (i < N.length - 1) { d = mvD(N[i], prev); prev = N[i]; } else d = mo.dur * mo.ppm - sum;
    lens.push(d); sum += d;
  }
  let fd = sum * fr, k = 0;
  for (const pl of lens) { ++k; if (fd > pl) fd -= pl; else break; }
  if (k >= N.length) k = N.length - 1;
  const a = N[k <= 0 ? 0 : k - 1], b = N[k], mf = f32(fd / mvD(a, b));
  return [f32(a[0] + f32(f32(b[0] - a[0]) * mf)), f32(a[1] + f32(f32(b[1] - a[1]) * mf))];
}
function mvPassthrough(mo, time, head) {
  const N = mo.nodes; if (N.length < 3) return mvLinear(mo, time, head); if (N.length > 3) return mvBezier(mo, time);
  const ux = mo.ux, uy = mo.uy, [sx, sy] = N[1], [tx, ty] = N[2];
  const div = f32(2 * f32(f32(f32(ux * f32(sy - ty)) + f32(sx * f32(ty - uy))) + f32(tx * f32(uy - sy))));
  if (div === 0) return mvLinear(mo, time, head);
  const q = (x, y) => f32(f32(x * x) + f32(y * y)), A = q(ux, uy), B = q(sx, sy), C = q(tx, ty);
  const cx = f32(f32(f32(A * f32(sy - ty)) + f32(B * f32(ty - uy))) + f32(C * f32(uy - sy))) / div;
  const cy = f32(f32(f32(A * f32(tx - sx)) + f32(B * f32(ux - tx))) + f32(C * f32(sx - ux))) / div;
  let rad = mo.dur * mo.ppm / Math.sqrt((cx - ux) * (cx - ux) + (cy - uy) * (cy - uy));
  if (f32(f32(f32(sx - ux) * f32(ty - uy)) - f32(f32(sy - uy) * f32(tx - ux))) < 0) rad *= -1;
  const fr = mvFrac(mo, time), rx = Math.cos(fr * rad), ry = Math.sin(fr * rad);
  return [f32(rx * (ux - cx) - ry * (uy - cy) + cx), f32(ry * (ux - cx) + rx * (uy - cy) + cy)];
}
function mvBezPt(P, fr) {
  const x = P.map(q => q[0]), y = P.map(q => q[1]), f = f32(fr);
  for (let n = P.length - 1; n > 0; n--) for (let i = 0; i < n; i++) { x[i] = f32(x[i] + f32(f * f32(x[i + 1] - x[i]))); y[i] = f32(y[i] + f32(f * f32(y[i + 1] - y[i]))); }
  return [x[0], y[0]];
}
function mvBezPoints(mo) { // GetBezierPoints: a point every 2 × px-per-ms of curve, each segment's last one moved onto its anchor
  if (mo.bez) return mo.bez;
  const sp = mo.nodes, ppm = mo.ppm, full = mo.dur * ppm, out = [[mo.ux, mo.uy]];
  let it = 0, total = 0;
  while (it < sp.length) {
    const pts = [], c0 = it;
    for (let i = c0; i < sp.length; i++) { if (i > c0 && sp[i - 1][0] === sp[i][0] && sp[i - 1][1] === sp[i][1]) break; pts.push(sp[i]); ++it; }
    let prev = pts[0], cpl = 0, sampled = false;
    for (let k = 0; k < 1 + MV_STEP; k += MV_STEP) {
      if (!(total <= full)) break;
      const cur = mvBezPt(pts, k); cpl += mvD(prev, cur); prev = cur;
      if (cpl >= ppm * 2) { total += cpl; cpl = 0; out.push(cur); sampled = true; }
    }
    total += cpl;
    if (total > full) continue;
    const an = pts[pts.length - 1];
    if (sampled) out[out.length - 1] = an; else if (mvD(out[out.length - 1], an) >= ppm) out.push(an);
  }
  return mo.bez = out;
}
function mvBezier(mo, time) {
  const B = mvBezPoints(mo), fr = mvFrac(mo, time), n = B.length, ip = Math.floor(n * fr), dc = f32(n * fr - ip);
  if (!(ip >= 0)) return [NaN, NaN];
  return ip >= n - 1 ? B[n - 1] : [f32(B[ip][0] + f32(f32(B[ip + 1][0] - B[ip][0]) * dc)), f32(B[ip][1] + f32(f32(B[ip + 1][1] - B[ip][1]) * dc))];
}
function mvCatPt(p0, p1, p2, p3, x) {
  const xf = f32(x), x2 = f32(x * x), x3 = f32(x2 * xf);
  const c = k => f32(.5 * f32(f32(f32(f32(2 * p1[k]) + f32(f32(-p0[k] + p2[k]) * xf)) + f32(f32(f32(f32(f32(2 * p0[k]) - f32(5 * p1[k])) + f32(4 * p2[k])) - p3[k]) * x2))
    + f32(f32(f32(f32(-p0[k] + f32(3 * p1[k])) - f32(3 * p2[k])) + p3[k]) * x3)));
  return [c(0), c(1)];
}
function mvCatmull(mo, time) { // GetCatmullPathPosition, with its walk along the curve recorded once per slider
  const P = mo.nodes; if (P.length < 3) return mvLinear(mo, time, [mo.ux, mo.uy]);
  if (!mo.cat) {
    const seg = (i, x) => i === 0 ? mvCatPt(P[0], P[0], P[1], P[2], x) : i < P.length - 2 ? mvCatPt(P[i - 1], P[i], P[i + 1], P[i + 2], x) : mvCatPt(P[i - 1], P[i], P[i + 1], P[i + 1], x);
    const cum = [], pts = [], full = mo.dur * mo.ppm; let total = 0, prev = P[0], steps = 0;
    for (let i = 0; i < P.length - 1; i++) {
      let cpl = 0, pc = P[i];
      for (let k = 0; k < 1 + MV_STEP; k += MV_STEP) { const c = seg(i, k); cpl += mvD(pc, c); pc = c; }
      let v = 0, len = 0;
      for (;;) {
        const c = seg(i, v); len += mvD(prev, c); cum.push(total + len); pts.push(c); prev = c;
        if (len > cpl && i < P.length - 2) { total += len; break; }
        if (i === P.length - 2 && (total + len >= full || !(total + len >= 0))) break;
        if (++steps > 2e6) break;
        v += MV_STEP;
      }
    }
    mo.cat = { cum, pts };
  }
  const want = mo.dur * mo.ppm * mvFrac(mo, time), { cum, pts } = mo.cat;
  let lo = 0, hi = cum.length - 1; if (!(cum[hi] >= want)) return pts[hi] || [0, 0];
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] >= want) hi = mid; else lo = mid + 1; }
  return pts[lo];
}
function mvPathPos(M, mo, time, head = mvPos(M, mo)) { // Slider.GetPathPosition (unstacked)
  if (mo.approx) return vUnstack(mo.o, pathPoint(mo.o, Math.min(1, Math.max(0, mvFrac(mo, time)))));
  return mo.curve === "L" ? mvLinear(mo, time, head) : mo.curve === "P" ? mvPassthrough(mo, time, head) : mo.curve === "B" ? mvBezier(mo, time) : mvCatmull(mo, time);
}
function mvPathPx(M, mo) { // PathPxPositions: the path stepped every 1 px of travel, repeats left out, the end added
  if (mo.px) return mo.px;
  if (mo.approx) return mo.px = mo.o.path.map(q => vUnstack(mo.o, q));
  const head = [mo.ux, mo.uy], lim = mo.ppm * mo.dur, out = [head]; let cur = head;
  for (let i = 0; i < lim; ++i) { const prev = cur; cur = mvPathPos(M, mo, mo.t + i / mo.ppm, head); if (cur[0] !== prev[0] || cur[1] !== prev[1]) out.push(cur); }
  out.push(mvPathPos(M, mo, mo.t + lim / mo.ppm, head));
  return mo.px = out;
}
function mvTicks(M, mo) { // GetSliderTickTimes (whole ms, along time, ignoring SV)
  const u = mvUniAt(M, mo.t), theo = mo.t - mvTheo(M, mo.t, u), n = Math.trunc((mo.endTime - mo.t - 1) / u.beat * M.tick), out = [];
  for (let i = 1; i <= n && i <= 1e4; i++) out.push(Math.trunc(i * u.beat / M.tick + theo));
  return out;
}

// ---------- per-difficulty checks (osu!standard) ----------
// run(m, add, lvl, ctx): lvl = the difficulty level (0 Easy … 5 Ultra), ctx.hasEasy = the mapset has an Easy
const DIFF_CHECKS = [
  // ----- Timing -----
  { cat: "Timing", title: "Unsnapped hit objects.", run(m, add) {
    const M = mvMap(m);
    for (const mo of M.objs) for (const t of mvEdgeTimes(mo)) {
      const what = mvPartName(mo, t);
      if (what === "Slider tail" && mvTailOnNextRed(M, t)) continue;
      const u = mvUnsnap(M, t), a = Math.abs(u);
      if (a >= 2) add("problem", "{what} unsnapped by {ms} ms.", { what, ms: ms3(u) }, mo.o, t);
      else if (a >= 1) add("minor", "{what} unsnapped by {ms} ms.", { what, ms: ms3(u) }, mo.o, t);
    }
  } },
  { cat: "Timing", title: "Hit objects potentially snapped to the wrong red line.", run(m, add) {
    const M = mvMap(m);
    for (const mo of M.objs) for (const t of mvEdgeTimes(mo)) {
      if (Math.abs(mvUnsnap(M, t)) >= 2) continue;
      const cur = mvUniAt(M, t), next = mvNextUni(M, t);
      if (!next || next.time <= t || next.time - t > Math.max(50, cur.beat / 8) || mvAligned(cur, next)) continue;
      const here = Math.abs(mvUnsnap(M, t)), there = Math.abs(mvUnsnap(M, t, next));
      if (here < 2 && there >= 2) add("warning", "{what} appears snapped to the current timing but would be unsnapped by {ms} ms relative to the upcoming red line at {at}.", { what: mvPartName(mo, t), ms: ms3(there), at: fmtMs(next.time) }, mo.o, t);
    }
  } },
  { cat: "Timing", title: "First line toggles kiai or is inherited.", run(m, add) {
    const f = m.timing[0];
    if (!f) add("problem", "There are no timing lines.");
    else if (!f.uninherited) add("problem", "First timing line is inherited.", {}, null, f.time);
    else if (f.kiai) add("problem", "First timing line toggles kiai.", {}, null, f.time);
  } },
  { cat: "Timing", title: "Unused timing lines.", run(m, add) {
    // as MapsetVerifier: its own red lines and slider ends, unclamped SV, and a slider still running at the next line
    // doesn't count for the SV (only the latest slider starting before that line that has ended by then, or the one before it)
    const M = mvMap(m), L = M.lines, H = M.objs, S = H.filter(x => x.kind === "slider"), maxEnd = [];
    let mx = -Number.MAX_VALUE; for (const x of H) maxEnd.push(mx = Math.max(mx, x.endTime));
    const overlaps = l => { // TimingUtils.SectionOverlapsObject: an object (or its tail) in the section
      const n = mvNext(M, l), e = n ? n.time : Number.MAX_VALUE; let k = Math.max(0, lastBefore(H, e, "t"));
      while (k >= 0 && H.length && H[k].t >= e) k--;
      return k >= 0 && H.length > 0 && maxEnd[k] >= l.time;
    };
    const hasSlider = l => { // TimingUtils.SectionContainsObject<Slider>
      const n = mvNext(M, l);
      if (!n) return S.length > 0 && Math.max(0, lastBefore(S, l.time, "t")) + 1 < S.length;
      let at = 0;
      if (S.length) { const k = Math.max(0, lastBefore(S, n.time, "t")); at = S[k].endTime < n.time ? S[k].t : k > 0 ? S[k - 1].t : 0; }
      return at >= l.time;
    };
    const samplesDiffer = (a, b) => a.set !== b.set || a.idx !== b.idx || !mvEqF(a.vol, b.vol);
    const used = (l, prev) => (overlaps(l) && samplesDiffer(l, prev)) || (hasSlider(l) && !mvEq(l.sv, prev.sv)) || l.kiai !== prev.kiai;
    for (let i = 1; i < L.length; i++) {
      const cur = L[i]; if (!cur.uni) continue;
      const prev = mvLineAt(M, cur.time - 1), pu = mvUniAt(M, cur.time - 1);
      if (!mvAligned(cur, pu)) continue; // (a red line that moves the bar lines or changes the BPM is used)
      const odd = [];
      if (cur.omit) odd.push(trv("omits the first barline"));
      if (pu.omit && mvBeatOffset(pu, cur, pu.meter) !== 0) odd.push(trv("corrects the omitted barline at") + " " + fmtMs(pu.time));
      if (!(mvAligned(cur, pu) && mvBeatOffset(pu, cur, 4 * pu.meter) <= 1)) odd.push(trv("resets nightcore mod cymbals"));
      const what = odd.join(" " + trv("and") + " ");
      if (!used(cur, prev)) add(odd.length ? "warning" : "problem", odd.length ? "Uninherited line only {what}, ensure this makes sense, otherwise remove the line." : "Uninherited line changes nothing.", { what }, null, cur.time);
      else add(odd.length ? "warning" : "problem", odd.length ? "Uninherited line only {what}, ensure this makes sense, otherwise replace with an inherited line" : "Uninherited line changes nothing that can't be changed with an inherited line.", { what }, null, cur.time);
    }
    for (let i = 1; i < L.length; i++) {
      const cur = L[i], prev = L[i - 1]; if (cur.uni || used(cur, prev)) continue;
      const sv = !mvEq(cur.sv, prev.sv), smp = samplesDiffer(cur, prev);
      add("minor", !sv && !smp ? "Inherited line uses the same values as the previous timing line." : sv && smp ? "Inherited line changes SV and sample settings, but affects nothing." : sv ? "Inherited line changes SV, but affects nothing." : "Inherited line changes sample settings, but affects nothing.", {}, null, cur.time);
    }
  } },
  { cat: "Timing", title: "Concurrent or conflicting timing lines.", run(m, add) {
    const L = m.timing;
    for (let i = 1; i < L.length; i++) {
      const a = L[i - 1], b = L[i]; if (Math.abs(a.time - b.time) > 1e-9) continue;
      if (a.uninherited === b.uninherited) { add("problem", "Concurrent {kind} lines.", { kind: trv(b.uninherited ? "uninherited" : "inherited") }, null, a.time); continue; }
      const g = a.uninherited ? b : a, r = a.uninherited ? a : b, gs = [], rs = [];
      if (g.kiai !== r.kiai) { gs.push(g.kiai ? "kiai" : "no kiai"); rs.push(r.kiai ? "kiai" : "no kiai"); }
      if (Math.abs(g.volume - r.volume) > 1e-6) { gs.push(g.volume + "% volume"); rs.push(r.volume + "% volume"); }
      const setName = n => ["Auto", "Normal", "Soft", "Drum"][n] || String(n); // (MV's Sampleset enum names)
      if (g.sampleSet !== r.sampleSet) { gs.push(setName(g.sampleSet) + " sampleset"); rs.push(setName(r.sampleSet) + " sampleset"); }
      if (g.sampleIndex !== r.sampleIndex) { gs.push("custom " + g.sampleIndex); rs.push("custom " + r.sampleIndex); }
      if (gs.length) add("minor", "Conflicting line settings. Green: {g}. Red: {r}. {p}.", { g: gs.join(", "), r: rs.join(", "), p: trv(a.uninherited ? "Green overrides red" : "Red overrides green") }, null, a.time);
    }
  } },
  { cat: "Timing", title: "Invalid timing line volume.", run(m, add) {
    for (const tp of m.timing) if (tp.volume < 5 || tp.volume > 100) add("problem", "Invalid timing line volume of {v}%.", { v: tp.volume }, null, tp.time);
  } },
  { cat: "Timing", title: "Unsnapped kiai.", run(m, add) {
    const L = m.timing;
    L.forEach((tp, i) => {
      if (!tp.kiai || lineAt(m, tp.time - 1).kiai) return; // (only where kiai starts)
      const u = practicalUnsnap(tp.time, m);
      if (Math.abs(u) >= 10) add("warning", "Kiai is unsnapped by {ms} ms.", { ms: String(u) }, null, tp.time);
      else if (Math.abs(u) >= 1) add("minor", "Kiai is unsnapped by {ms} ms.", { ms: String(u) }, null, tp.time);
      if (tp.uninherited && L.some(o => !o.uninherited && Math.abs(o.time - tp.time) < 1e-9)) return;
      const n = lineAfter(m, i); if (!n || n.kiai) return;
      const v = practicalUnsnap(n.time, m);
      if (Math.abs(v) >= 1) add("minor", "Kiai end is unsnapped by {ms} ms.", { ms: String(v) }, null, n.time);
    });
  } },
  { cat: "Timing", title: "Hit object is unaffected by a line very close to it.", run(m, add) {
    const M = mvMap(m), eff = (l, t) => l.sv * mvUniAt(M, t).bpm; // effective BPM: slider velocity (unclamped) × BPM
    for (const mo of M.objs) {
      if (mo.kind !== "slider") continue;
      const cur = mvLineAt(M, mo.t), n = cur && mvNext(M, cur); if (!n) continue;
      const dt = n.time - mo.t;
      if (dt > 0 && dt <= 5 && Math.abs(mvUnsnap(M, mo.t)) <= 1 && Math.abs(eff(cur, mo.t) - eff(n, n.time)) > 1)
        add("warning", "{what} is snapped {ms} ms before a line which would modify its slider velocity.", { what: "Slider head", ms: fmt2(dt) }, mo.o);
    }
  } },
  { cat: "Events", title: "Breaks only achievable through .osu editing.", run(m, add) { // MV CheckBreaks
    // from the start of the object at or before the break, and to the object after that one; the preempt isn't cut to a whole ms
    const H = m.hit, ar = mvDiff(m, "ApproachRate"), minEnd = ar < 5 ? 1200 + 600 * (5 - ar) / 5 : 1200 - 750 * (ar - 5) / 5;
    for (const [a, b] of m.breaks) {
      const k = Math.max(0, lastBefore(H, a, "t")), p = H[k], n = H[k + 1];
      const early = p && a - p.t < 200 ? 200 - (a - p.t) : 0, late = n && n.t - b < minEnd ? minEnd - (n.t - b) : 0;
      const v = { end: mvTime(b), early: mvDp2(early), late: mvDp2(late) }, t = Math.trunc(a);
      if (early > 1 && late > 1) add("problem", "to {end} - starts {early} ms too early and ends {late} ms too late. Saving the beatmap should fix this.", v, null, t);
      else if (early > 1) add("problem", "to {end} - starts {early} ms too early. Saving the beatmap should fix this.", v, null, t);
      else if (late > 1) add("problem", "to {end} - ends {late} ms too late. Saving the beatmap should fix this.", v, null, t);
      if (b - a < 650) add("warning", "to {end} - is non-functional due to being less than 650 ms.", v, null, t);
    }
  } },
  { cat: "Timing", title: "Inconsistent or unset preview time.", run(m, add, lvl, ctx) {
    // as MapsetVerifier: read as a float (missing is -1), exactly -1 is unset, else compared with the first difficulty
    // of the set sorted by mode, level and star rating
    const pv = x => { const s = x.general.PreviewTime; return s == null || s === "" ? -1 : f32(+s); }, p = pv(m);
    if (p === -1) { add("problem", "Preview time is not set."); return; }
    const maps = ctx && ctx.maps || []; if (!maps.length) return;
    const ref = [...maps].sort((a, b) => (a.m.mode - b.m.mode) || (a.lvl - b.lvl) || ((a.stars ?? 0) - (b.stars ?? 0)))[0];
    if (pv(ref.m) !== p) add("problem", "Preview time is inconsistent, see [{d}].", { d: ref.m.meta.Version });
  } },
  { cat: "Timing", title: "Rarely used snapping", run(m, add) {
    const ent = [], cnt = {};
    for (const o of m.hit) for (const [t] of edgesOf(o)) {
      const d = lowestDivisor(t, m); ent.push({ t, d, o, un: Math.abs(practicalUnsnap(t, m)) >= 2 });
      if (d) cnt[d] = (cnt[d] || 0) + 1;
    }
    // as MapsetVerifier (CheckWrongSnapping): each edge goes to the first list its divisor is in (3 or fewer, under 0.5 %,
    // 7 or fewer, under 5 %), then one issue per divisor and list with every timestamp of it
    const total = Object.values(cnt).reduce((a, b) => a + b, 0), cat = {};
    for (const d in cnt) { const c = cnt[d], p = c / total; cat[d] = [c <= 3, p < .005, c > 3 && c <= 7, p >= .005 && p < .05]; }
    const T = [["warning", "{times} 1/{d} is used 3 times or less, ensure this makes sense."], ["warning", "{times} 1/{d} makes out 0.5% or less of snappings, ensure this makes sense."],
      ["minor", "{times} 1/{d} is used 7 times or less, ensure this makes sense."], ["minor", "{times} 1/{d} makes out 5% or less of snappings, ensure this makes sense."]];
    const lists = [[], [], [], []];
    for (const e of ent) { if (e.un || !e.d) continue; const k = cat[e.d].findIndex(Boolean); if (k >= 0) lists[k].push(e); }
    lists.forEach((L, k) => {
      for (const d of [...new Set(L.map(e => e.d))]) {
        const at = L.filter(e => e.d === d), stamps = [...new Set(at.map(e => mvTime(e.t) + " - "))];
        add(T[k][0], T[k][1], { d, times: stamps.join(" ").trim() }, at[0].o, at[0].t);
      }
    });
  } },
  // ----- Compose -----
  { cat: "Compose", title: "Concurrent hit objects.", run(m, add) {
    const H = mvMap(m).objs; // (MapsetVerifier's slider end times)
    for (let i = 0; i < H.length - 1; i++) for (let j = i + 1; j < H.length; j++) {
      const a = H[i], b = H[j], gap = b.t - a.endTime;
      if (gap > 30) break;
      if (gap <= 0) {
        add("problem", "Concurrent {a}.", { a: a.kind === b.kind ? kindName(a.o) + "s" : kindName(a.o) + " and " + kindName(b.o) }, [a.o, b.o]); // (ObjectsAsString)
      } else if (gap <= 10 && b.kind !== "spinner") add("problem", "Within {ms} ms of one another.", { ms: String(gap) }, [a.o, b.o]);
      else break;
    }
  } },
  { cat: "Compose", title: "Too short drain time.", run(m, add) {
    const d = mvDrain(m); if (d < 30000) add("problem", "Less than 30 seconds of drain time, currently {s} seconds.", { s: Math.trunc(d / 1000) }); // (MV's drain: 0 with no objects)
  } },
  { cat: "Compose", title: "Offscreen hit objects.", run(m, add) {
    // MapsetVerifier's stacked positions and sampled slider paths, in 32-bit floats like it
    const M = mvMap(m), r = M.r, { top: U, bottom: D, left: Lf, right: R } = REF.screen;
    const amount = p => Math.max(Math.max(f32(f32(p[0] + r) - R), f32(f32(r - p[0]) + Lf)), Math.max(f32(f32(p[1] + r) - D), f32(f32(r - p[1]) + U)));
    const by = (p, len = 0) => { let b = f32(amount(p) + len); if (b < 0) b = 0; return f32(Math.ceil(f32(b * 100)) / 100); };
    const margin = a => String(Math.floor(f32(Math.max(-a, 0) * 100)) / 100);
    const near = (q, msg, o, t) => { add("warning", "{what} is only {px} px away from being offscreen, ensure the entire white border is visible on a 4:3 aspect ratio.", { what: msg, px: margin(amount(q)) }, o, t); };
    for (const mo of M.objs) {
      if (mo.kind !== "circle" && mo.kind !== "slider") continue;
      const o = mo.o, type = mo.kind === "circle" ? "Circle" : "Slider head", p = mvPos(M, mo); let border = false;
      if (f32(p[1] + r) > D) add("problem", "{what} is offscreen.", { what: type }, o);
      else if (by(p) > 0) { // the game keeps heads inside the playfield, but not when stacking moves them out
        const prevented = !(((f32(p[1] - r) < U || f32(p[0] - r) < Lf) && mo.stack > 0) || (f32(p[0] + r) > R && mo.stack < 0));
        add(prevented ? "warning" : "problem", prevented ? "{what} would be offscreen, but the game prevents it." : "{what} is offscreen.", { what: type }, o);
      } else if (f32(p[1] + r) > D - 1) { near(p, type, o); border = true; }
      if (mo.kind !== "slider") continue;
      const e = mvEndPos(M, mo), ov = mvStackVec(M, mo);
      if (by(e) > 0) { add("problem", "{what} is offscreen.", { what: "Slider tail" }, o, mo.endTime); continue; }
      if (amount(e) > -1) { near(e, "Slider tail", o, mo.endTime); border = true; }
      const body = mvPathPx(M, mo).map(q => [f32(q[0] + ov[0]), f32(q[1] + ov[1])]);
      if (body.some(q => by(q) > 0)) { add("problem", "{what} is offscreen.", { what: "Slider body" }, o); continue; }
      if (mo.curve !== "L" && body.some(q => by(q, 2) > 0)) { // close to the edge: the curve walked in 1/50 ms steps
        let worst = -Infinity; const head = mvPos(M, mo), n = Math.min(mo.dur * 50, 2e6);
        for (let j = 0; j < n; ++j) { const q = mvPathPos(M, mo, mo.t + j / 50, head); worst = Math.max(worst, amount([f32(q[0] + ov[0]), f32(q[1] + ov[1])])); }
        if (worst > 0) add("problem", "{what} is offscreen.", { what: "Slider body" }, o);
        else if (!border) {
          if (worst > -1) add("warning", "{what} is only {px} px away from being offscreen, ensure the entire white border is visible on a 4:3 aspect ratio.", { what: "Slider body", px: margin(worst) }, o);
          else add("warning", "Slider body is possibly offscreen, ensure the entire white border is visible on a 4:3 aspect ratio.", {}, o);
        }
        continue;
      }
      if (border) continue;
      let close = null; // the sampled point closest to the edge, if it's within 1 px
      for (const q of body) if (by(q) <= 0 && amount(q) > -1 && (!close || amount(q) > amount(close))) close = q;
      if (close) near(close, "Slider body", o);
    }
  } },
  { cat: "Compose", title: "Too short spinner.", run(m, add) {
    const od = +(m.diff.OverallDifficulty ?? 5);
    const warn = odLine(od, REF.spinnerWarn), prob = odLine(od, REF.spinnerProblem);
    for (const o of m.hit) if (o.kind === "spinner") { const d = o.end - o.t;
      if (d < prob) add("problem", "Spinner is too short, auto cannot achieve 1000 points on this.", {}, o);
      else if (d < warn) add("warning", "Spinner may be too short, ensure auto can achieve 1000 points on this.", {}, o); }
  } },
  { cat: "Compose", title: "Invisible sliders.", run(m, add) {
    for (const mo of mvMap(m).objs) {
      if (mo.kind !== "slider") continue;
      if (mo.nodeCount === 1) add("problem", "Slider has no curve points, only its start node, and so has no visible path.", {}, mo.o);
      else if (mo.len < 0) add("problem", "Slider has negative pixel length.", {}, mo.o);
    }
  } },
  { cat: "Compose", title: "Abnormal amount of slider nodes.", run(m, add) { // (against the pixel length as written, even 0)
    for (const mo of mvMap(m).objs) if (mo.kind === "slider" && mo.nodeCount > 10 * Math.sqrt(mo.len)) add("warning", "Slider contains {n} nodes.", { n: mo.nodeCount }, mo.o);
  } },
  { cat: "Compose", title: "Ambiguous slider intersection.", run(m, add) {
    // as MapsetVerifier: the stacked head against the unstacked end of the curve and the ticks along time
    const M = mvMap(m), r = M.r;
    for (const mo of M.objs) {
      if (mo.kind !== "slider") continue;
      const head = mvPos(M, mo), tail = mvPathPos(M, mo, mo.t + mo.dur, head);
      if (mvVD(head, tail) <= 5) { // a slider long enough that the follow circle leaves the head
        let far = 0; for (const t of mvTicks(M, mo)) { const d = mvVD(mvPathPos(M, mo, t, head), head); if (far < d) far = d; }
        if (f32(far - f32(r * 2)) > 0) add("warning", "Slider edges are almost perfectly overlapping.", {}, mo.o);
      }
      if ((mo.curve !== "B" && mo.curve !== "L") || !mo.nodes) continue;
      const N = mo.nodes, anchors = mo.curve === "L" ? N : N.filter((q, i) => i && q[0] === N[i - 1][0] && q[1] === N[i - 1][1]);
      if (!anchors.length) continue;
      let total = 0; for (let i = 1; i < anchors.length; i++) total += mvVD(anchors[i - 1], anchors[i]);
      let cur = 0, prev = anchors[0];
      for (const a of anchors) {
        cur += mvVD(a, prev);
        if (cur > 60 && mvVD(head, a) <= 5) { add("warning", "Head and red anchor overlap is possibly ambiguous.", {}, mo.o); break; }
        if (total - cur > 60 && mvVD(a, tail) <= 5) { add("warning", "Tail and red anchor overlap is possibly ambiguous.", {}, mo.o); break; }
        prev = a;
      }
    }
  } },
  { cat: "Compose", title: "Burai slider.", run(m, add) {
    // MapsetVerifier's burai score: bezier path points under 3 px apart score by how close they are and how alike their
    // directions are (a path going back over itself), the scores sorted and summed with each worth 90% of the one before
    const M = mvMap(m), ang = (a, b) => { let x = Math.atan2(f32(a[1] - b[1]), f32(a[0] - b[0])); if (x > Math.PI) x = Math.PI * 2 - x; return (x >= 0 ? x : Math.PI * 2 + x) % Math.PI; };
    for (const mo of M.objs) {
      if (mo.kind !== "slider" || mo.curve !== "B") continue;
      const P = mvPathPx(M, mo), n = P.length, grid = new Map(), cell = q => [Math.floor(q[0] / 3), Math.floor(q[1] / 3)], scores = [];
      for (let i = 0; i < n; i++) { const k = cell(P[i]).join(); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
      for (let i = 1; i < n; i++) {
        const [cx, cy] = cell(P[i]);
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (const j of grid.get((cx + ox) + "," + (cy + oy)) || []) {
          if (j <= i || j >= n - 1) continue;
          const d = mvD(P[i], P[j]); if (d >= 3) continue;
          let da = ang(P[i - 1], P[i]) - ang(P[j], P[j + 1]); if (da > Math.PI * .5) da = Math.PI - da; da = Math.abs(da);
          scores.push(1 / (Math.pow(da / Math.PI * 20, 3) + .01) / 250 * (100 * Math.sqrt(10) / Math.pow(10, 2 * d) / 125));
        }
      }
      scores.sort((a, b) => b - a);
      let total = 0; for (let k = 0; k < scores.length; k++) total += scores[k] * Math.pow(.9, k);
      if (total > 5) add("warning", "Burai.", {}, mo.o);
      else if (total > 2) add("warning", "Potentially burai.", {}, mo.o);
    }
  } },
  { cat: "Compose", title: "Obscured reverse arrows.", lv: [0, 1, 2, 3], run(m, add) {
    // the first reverse arrow (where the unstacked curve ends) against every object ending in the time before it during
    // which it is fully visible (MapsetVerifier's preempt by AR)
    const M = mvMap(m), H = M.objs, r = M.r, close = r / REF.reverseClose, tooClose = f32(r / 3), opaque = M.preempt;
    for (const mo of H) {
      if (mo.kind !== "slider" || mo.edges <= 1) continue;
      const rt = mo.t + mo.dur, rp = mvPathPos(M, mo, rt);
      let hit = null, serious = false;
      for (const p of H) {
        if (!(p.endTime > rt - opaque && p.endTime < rt) || p.kind === "spinner") continue;
        const q = p.kind === "slider" ? mvEndPos(M, p) : mvPos(M, p), d = f32(mvD(q, rp));
        if (d < tooClose) serious = true;
        if (d >= close) continue;
        hit = mo.t > p.t ? [p.o, mo.o] : [mo.o, p.o]; break;
      }
      if (hit) add("warning", serious ? "Reverse arrow obscured." : "Reverse arrow potentially obscured.", {}, hit);
    }
  } },
  { cat: "Compose", title: "Abnormally large spacing.", run(m, add) {
    // each jump against the earlier jumps of about the same gap (±5 ms, sliders apart), weighted towards the recent ones
    const M = mvMap(m), H = M.objs, r = M.r, buckets = new Map(), B = dt => Math.floor(dt / 5);
    for (let i = 0; i + 1 < H.length; i++) {
      const p = H[i], o = H[i + 1]; if (p.kind === "spinner" || o.kind === "spinner") continue;
      const dt = o.t - p.endTime; if (dt > 180) continue;
      let d = mvPrevDist(M, o, p); if (d < 20) d = 20;
      const sl = p.kind === "slider", same = [];
      for (let b = B(dt - 5); b <= B(dt + 5); b++) for (const q of buckets.get(b + ":" + sl) || []) if (dt <= q.dt + 5 && dt >= q.dt - 5) same.push(q);
      const key = B(dt) + ":" + sl; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push({ dt, d, p, o });
      if (!same.length) continue;
      let top = -Infinity, sD = 0, sT = 0; // (one pass: the fastest earlier jump and the decayed averages)
      for (const q of same) { const k = Math.min(1 / (p.t - q.p.t) * 4000, 1); top = Math.max(top, q.d / q.dt * k); sD += q.d * k; sT += q.dt * k; }
      if (d / dt < top || d <= f32(r * 4) || same.length < 3) continue;
      const eD = sD / same.length, eT = sT / same.length;
      if (sl) d -= Math.min(f32(r * 3), d);
      const ratio = d / dt / (eD / eT); if (ratio <= 2) continue;
      add(ratio > 15 ? "problem" : ratio > 4 ? "warning" : "minor", "Space/time ratio is {x} times the expected, see e.g. {ex}.", { x: String(csRound(ratio * 10) / 10), ex: same.slice(-3).map(q => tsOf(q.p.o, q.o.o) + " -").join(" ") }, [p.o, o.o]);
    }
  } },
  { cat: "Compose", title: "Slider only section.", lv: [0, 1], run(m, add) {
    let n = 0, lastEnd = 0, dur = 0, first = null;
    const flush = () => { if (n > 6 && dur > 5000 && first) add("minor", "Section is slider only ({n} objects, spanning {s} s). Ensure this includes plenty of time between objects.", { n, s: Math.trunc(Math.trunc(dur) / 1000) }, first.o); n = 0; lastEnd = 0; dur = 0; first = null; };
    for (const mo of mvMap(m).objs) { // (MapsetVerifier's slider end times)
      if (mo.kind !== "slider") { flush(); continue; }
      first = first || mo; if (lastEnd !== 0) dur += mo.t - lastEnd;
      lastEnd = mo.endTime; dur += lastEnd - mo.t; n++;
    }
    flush();
  } },
  // ----- Spread -----
  { cat: "Spread", title: "Too short sliders.", lv: [0], run(m, add) {
    for (const mo of mvMap(m).objs) if (mo.kind === "slider" && mo.endTime - mo.t < 125) add("warning", "{ms} ms, expected at least {exp}.", { ms: mvDp2(mo.endTime - mo.t), exp: 125 }, mo.o); // (MV's slider end time)
  } },
  { cat: "Spread", title: "Multiple reverses on too short sliders.", lv: [0, 1], run(m, add, lvl) {
    const k = lvl === 0 ? 1 : .5, p = 60000 / 240 * k, w = 60000 / 180 * k; // 1/1 (Easy) or 1/2 (Normal) at 240 and 180 BPM
    for (const o of m.hit) if (o.kind === "slider" && o.slides >= 3) { const d = o.end - o.t;
      if (d < p) add("problem", "This slider is way too short to have multiple reverses.", {}, o); else if (d < w) add("warning", "This slider is very short to have multiple reverses.", {}, o); }
  } },
  { cat: "Spread", title: "Objects close in time not overlapping.", lv: [0, 1], run(m, add, lvl, ctx) {
    if (lvl === 1 && ctx && ctx.hasEasy) return; // (only the lowest difficulty: the Easy, or the Normal when there's no Easy)
    const M = mvMap(m), H = M.objs, r = M.r; // (MapsetVerifier's stacked positions)
    for (let i = 0; i + 1 < H.length; i++) {
      const p = H[i], o = H[i + 1]; if (p.kind !== "circle" || o.kind === "spinner") continue; // (slider ends don't need to overlap)
      const gap = o.t - p.t; if (gap >= 188 || mvVD(mvPos(M, o), mvPos(M, p)) < f32(r * 2)) continue;
      if (gap < 125) add("problem", "{ms} ms apart, should either be overlapped or at least {exp} ms apart.", { ms: fmt2(gap), exp: 125 }, [p.o, o.o]);
      else add("warning", "{ms} ms apart.", { ms: fmt2(gap) }, [p.o, o.o]);
    }
  } },
  { cat: "Spread", title: "Too short spinner time or spinner recovery time.", lv: [0, 1, 2], run(m, add, lvl) {
    const len = [1000, 750, 500][lvl], rec = [1000, 500, 250][lvl];
    for (const o of m.hit) {
      if (o.kind !== "spinner") continue;
      const d = o.end - o.t;
      if (d < len) add("problem", "Spinner length is too short ({ms} ms, expected {exp}).", { ms: String(d), exp: Math.ceil(len * 4 / 3) }, o);
      else if (d < len * 1.2) add("warning", "Spinner length is probably too short ({ms} ms, expected {exp}).", { ms: String(d), exp: Math.ceil(len * 4 / 3) }, o);
      const n = m.hit[o.idx + 1]; if (!n || n.kind === "spinner") continue;
      const bpm = 60000 / redLineAt(m, n.t).beat, sc = bpm * bpm / 14400 - bpm / 80 + 1; // 180 BPM = 1, 120 = 0.5, 240 = 2
      const gap = n.t - o.end, scaled = gap / sc, exp = Math.ceil(rec * Math.min(1, sc) * 4 / 3);
      if (scaled < rec && gap < rec) add("problem", "Spinner recovery time is too short ({ms} ms, expected {exp}).", { ms: String(gap), exp }, [o, n]);
      else if (scaled < rec * 1.2 && gap < rec * 1.2) add("warning", "Spinner recovery time is probably too short ({ms} ms, expected {exp}).", { ms: String(gap), exp }, [o, n]);
    }
  } },
  { cat: "Spread", title: "Perfect stacks too close in time.", lv: [0, 1, 2, 3], run(m, add, lvl) {
    // MapsetVerifier's stacked positions; the stack leniency it asks for is the editor's whole-number one (0.7 = 7)
    const M = mvMap(m), H = M.objs, lim = [1, 1, .5, .25][lvl] * 60000 / 160, r = M.r;
    for (let i = 0; i < H.length - 1; i++) for (let j = i + 1; j < H.length; j++) {
      const a = H[i], b = H[j];
      if (a.kind === "spinner" || b.kind === "spinner" || b.t - a.t >= lim) break;
      const pa = mvPos(M, a), pb = mvPos(M, b);
      if (pa[0] === pb[0] && pa[1] === pb[1]) add(lvl >= 3 ? "warning" : "problem", "Stack leniency should be at least {v}.", { v: Math.trunc(Math.ceil((b.t - a.t) / (M.fadeIn * .1))) }, [a.o, b.o]);
      else { const d = mvVD(pa, pb); if (d <= f32(r / 14)) add("problem", "Failed stack, objects are {px} px apart, which is basically a perfect stack.", { px: fmt2(d) }, [a.o, b.o]); }
    }
  } },
  { cat: "Spread", title: "Perfect stacks too close in time with Hard Rock applied.", run(m, add) {
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
      if (best.perfect) add("minor", "Perfect stack with Hard Rock applied, stack leniency should be at least {v}.", { v: best.sl }, objs); // (the editor's whole-number leniency, 0.7 = 7)
      else add("minor", "Failed stack with Hard Rock applied, objects are {px} px apart, which is basically a perfect stack.", { px: fmt2(best.d) }, objs);
    }
  } },
  { cat: "Spread", title: "Object too close or far away from previous.", lv: [0, 1], run(m, add) {
    // the distance against the last one of about the same gap in the 4 seconds before, else against the recent average speed
    const M = mvMap(m), H = M.objs, obs = []; let issue = null; // (MapsetVerifier's stacked positions and slider end times)
    for (let i = 0; i + 1 < H.length; i++) {
      const p = H[i], o = H[i + 1]; if (p.kind === "spinner" || o.kind === "spinner") continue;
      const dt = o.t - p.endTime; if (dt > 600) continue;
      const d = mvPrevDist(M, o, p); if (d < 8) continue;
      const near = obs.filter(q => q.p.t > p.t - 4000), avr = near.length ? near.reduce((s, q) => s + q.d / q.dt, 0) / near.length : -1;
      let k = -1; for (let j = obs.length - 1; j >= 0; j--) { const q = obs[j]; if (dt <= q.dt * (1 + .1) && dt >= q.dt * (1 - .1) && q.p.t > p.t - 4000) { k = j; break; } }
      if (k !== -1) {
        const exp = obs[k].d;
        if ((Math.abs(exp - d) - 10) / d > .15) {
          if (issue && Math.abs(issue.d - d) / d <= .15) { obs[k] = { dt, d, p }; issue = null; }
          else { const q = obs[k].p; add("warning", "Distance is {d} px, expected {e}, see {ref}.", { d: csRound(d), e: csRound(exp), ref: tsOf(q.o, H[q.i + 1].o) }, [p.o, o.o]); issue = { dt, d, p }; }
        } else { obs[k] = { dt, d, p }; issue = null; }
      } else if (near.length && (d / dt - .1 > avr * (1 + .2) || d / dt + .1 < avr * (1 - .2))) add("warning", "Distance/time ratio is {r}, expected {e}.", { r: fmt2(d / dt), e: fmt2(avr) }, [p.o, o.o]);
      else { obs.push({ dt, d, p }); issue = null; }
    }
  } },
  // ----- Settings -----
  { cat: "Settings", title: "Difficulty settings outside of the guideline range.", lv: [0, 1, 2, 3, 4], run(m, add, lvl) { // MV CheckDiffSettingsStandard
    const rng = { AR: [[null, 5], [4, 6], [6, 8], [7, 9.3], [8, null]], OD: [[1, 3], [3, 5], [5, 7], [7, 9], [8, null]], HP: [[1, 3], [3, 5], [4, 6], [5, 8], [5, null]], CS: [[null, 4], [null, 5], [null, 6], [null, 7], [null, 7]] };
    const key = { AR: "ApproachRate", OD: "OverallDifficulty", HP: "HPDrainRate", CS: "CircleSize" };
    for (const k in rng) {
      const [lo, hi] = rng[k][lvl], cur = roundEven(mvDiff(m, key[k]), 2); // (rounded to 2 decimals first)
      if (!((lo != null && cur < lo) || (hi != null && cur > hi))) continue;
      const v = { setting: k, min: lo, max: hi, difficulty: trv(LEVELS[lvl]), current: String(cur) };
      if (lo != null && hi != null) add("minor", "{setting} is recommended to be between {min} and {max} for {difficulty} difficulties, currently {current}.", v);
      else if (lo != null) add("minor", "{setting} is recommended to be {min} or higher for {difficulty} difficulties, currently {current}.", v);
      else add("minor", "{setting} is recommended to be {max} or lower for {difficulty} difficulties, currently {current}.", v);
    }
  } },
  { cat: "Settings", title: "Abnormal difficulty settings.", run(m, add) { // MV CheckDiffSettingsAllModes
    for (const [key, name] of [["HPDrainRate", "HP Drain Rate"], ["CircleSize", "Circle Size"], ["ApproachRate", "Approach Rate"], ["OverallDifficulty", "Overall Difficulty"]]) {
      const v = mvDiff(m, key), w = { value: String(+v.toFixed(4)), setting: trv(name) };
      if (v < 0 || v > 10) add("warning", "{value} {setting}, although is capped between 0 to 10 in-game.", w); // (only CS can be, up to 18)
      else if (f32(v - f32(f32(Math.floor(f32(v * 10))) / 10)) > 0) add("problem", "{value} {setting} has more than 1 decimal place.", w);
    }
  } },
  { cat: "Settings", title: "Slider tick rates not aligning with any common beat snap divisor.", run(m, add) { // MV CheckTickRate
    const r = mvDiff(m, "SliderTickRate"), a = roundEven(f32(r * 1000)) / 1000; // (clamped to 0.5–8 first; whole numbers, 1/2, 4/3 and 3/2 line up with the beat snaps)
    if (r - Math.floor(r) !== 0 && ![.5, 1.333, 1.5].some(x => Math.abs(x - a) <= 1e-12)) add("problem", "{value} slider tick rate.", { value: String(a) });
  } },
  { cat: "Settings", title: "Too dark or bright combo colours or slider borders.", run(m, add) { // MV CheckLuminosity
    const rgb = s => String(s).split(",").slice(0, 3).map(x => f32(parseFloat(x) || 0)), f = (c, k) => f32(f32(c * c) * f32(k));
    const lum = c => f32(Math.sqrt(f32(f32(f(c[0], .299) + f(c[1], .587)) + f(c[2], .114)))); // HSP, in floats
    const border = mvKey(m.colourKV, "SliderBorder");
    if (border != null) { const l = lum(rgb(border)); if (l < 30) add("problem", "Slider border is way too dark."); else if (l < 43) add("warning", "Slider border is really dark."); }
    const combos = Object.keys(m.colourKV).filter(k => k.startsWith("Combo")).map(k => rgb(m.colourKV[k])), N = combos.length; // (file order)
    // Beatmap.GetComboColourIndex: new combos and colour skips counted from the first object, spinners left out entirely
    const H = m.hit, cum = []; let c = 0;
    for (const o of H) { if (!(o.type & 8)) for (let r = ((o.type & 4) ? 1 : 0) + ((o.type >> 4) & 7); r > 0; r--) { c++; if (c >= N) c = 0; } cum.push(c); }
    const kiai = [], kiaiT = [];
    if (m.timing.length) for (const o of H) {
      const ci = cum[lastBefore(H, o.t, "t")];
      if (o.kind === "spinner" || !lineAt(m, o.t).kiai || kiai.includes(ci)) continue;
      kiai.push(ci); kiaiT.push(o.t);
    }
    combos.forEach((col, i) => {
      const l = lum(col), v = { number: i === 0 ? N : i }; // (AsDisplayedComboColourIndex: the first colour shows as the last number, like the editor)
      if (l < 30) add("problem", "Combo colour {number} is way too dark.", v); else if (l < 43) add("warning", "Combo colour {number} is really dark.", v);
      kiai.forEach((k, j) => { if (l > 250 && k === i) add("warning", "Combo colour {number} is really bright in kiai sections, see {time} - .", { ...v, time: mvTime(kiaiT[j]) }); });
    });
  } },
  { cat: "Settings", title: "Default combo colours without forced skin.", run(m, add) { // MV CheckDefaultColours
    if ((mvGen(m, "SkinPreference") ?? "") !== "Default" && !Object.keys(m.colourKV).some(k => k.startsWith("Combo"))) add("problem", "Default combo colours without preferred skin.");
  } },
  { cat: "Settings", title: "Score/Combo overflow.", run(m, add) { // MV CheckScoreOverflow
    if (!m.hit.length) return;
    const { combo, score } = mvScoreV1(m);
    if (combo > 65535) add("problem", "Combo overflows in osu!(stable) ({combo}). Ensure the map has the 'lazer-only' flag.", { combo: mvGroup(combo) });
    if (score > 2147483647) add("problem", "Score overflows in osu!(stable) ({score}). Ensure the map has the 'lazer-only' flag.", { score: mvGroup(score) });
  } },
  // ----- Hit sounds -----
  { cat: "Hit sounds", title: "Low volume hit sounding.", run(m, add) {
    // MV's CheckMuted: volumes under 5% count as 5%; the line from 5 ms before is found walking forward only, so a
    // slider's ticks read the line its tail reads; each reverse, tail and tick on its own
    const L = m.timing; if (!L.length) return;
    let li = 0;
    const vol = t => { for (; li < L.length; li++) if (li > 0 && L[li].time >= t + 5) return L[li - 1].volume; return L[L.length - 1].volume; };
    const check = (o, t, v, active) => {
      v = v < 5 ? 5 : v; if (v > 20) return;
      const head = Math.abs(t - o.t) < 1e-9, what = mvPart(m, o, t), at = head ? [o, null] : [null, Math.trunc(t)];
      if (active && head) add(v <= 10 ? "warning" : "minor", "{v}% volume {what}, this may be hard to hear over the song.", { v, what }, ...at);
      else if (v <= 10) add(active ? "warning" : "minor", "{v}% volume {what}, ensure there is no distinct sound here in the song.", { v, what }, ...at);
    };
    for (const o of m.hit) {
      if (o.kind === "spinner") continue;
      check(o, o.t, o.kind !== "slider" && o.samp && o.samp.v > 0 ? o.samp.v : vol(o.t), true);
      if (o.kind !== "slider") continue;
      const c = mvCurve(m, o);
      for (let e = 1; e <= o.slides; e++) { const rev = e < o.slides, t = rev ? Math.trunc(o.t + c * e) : mvEnd(m, o); check(o, t, vol(t), rev); }
      for (const t of hsTicks(m, o)) check(o, t, vol(t), false);
    }
  } },
  { cat: "Hit sounds", title: "Long periods without hit sounding.", run(m, add) {
    // MV's CheckHitSounds: a gap counts by its length and the objects in it; breaks and spinners don't count
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
        const before = H[Math.max(0, lastBefore(H, xs - 1, "t"))]; if (!before) break;
        update(mvEnd(m, before));
        const after = H[lastBefore(H, xe, "t") + 1]; if (!after) break;
        prevTime = after.t;
      }
      if (o.kind === "circle") feed(o.hs, mvObjSet(m, o, false), o.t);
      else if (o.kind === "slider") {
        const E = mvSl(o), c = mvCurve(m, o);
        feed(E.sh, mvStartSet(m, o, false), o.t);
        if (E.rh.length) for (let i = 0; i < o.slides - 1; i++) feed(E.rh[i] | 0, mvRevSet(m, o, i, false), Math.floor(o.t + c * (i + 1)));
        feed(E.eh, mvEndSet(m, o, false), mvEnd(m, o));
      }
    }
    if (!total) { add("problem", "This beatmap contains no hit sounds or sampleset changes."); return; }
    for (const [lvl, a, b] of found) add(lvl, "No hit sounds or sampleset changes from here to {to}, ({s} s).", { to: fmtMs(Math.trunc(b)) + " -", s: mvNum((b - a) / 1000) }, null, Math.trunc(a));
  } },
];

// ---- MV parity: metadata & resources helpers ----
// MapsetVerifier's own way of reading the mapset (MetadataSettings, Beatmap/Osb events, TagLib for file headers), quirks included
const mrFiles = () => typeof files === "undefined" ? {} : files;
// its mapset order (mode, difficulty, star rating): its first difficulty is the reference for the set-wide checks
const mrMaps = ctx => ctx.maps.map((x, k) => ({ x, k })).sort((a, b) => (a.x.m.mode | 0) - (b.x.m.mode | 0) || a.x.lvl - b.x.lvl || (a.x.stars ?? 0) - (b.x.stars ?? 0) || a.k - b.k).map(p => p.x);
// [Metadata]: the first line starting with the key (so "Title" takes a "TitleUnicode:" line written before it), trimmed;
// a missing unicode field is the romanised one
function mrMeta(m) {
  const meta = m.meta || {}, keys = Object.keys(meta), get = k => { const f = keys.find(x => x.startsWith(k)); return f == null ? null : String(meta[f] ?? "").trim(); };
  const title = get("Title") ?? "", artist = get("Artist") ?? "";
  return { title, titleUnicode: get("TitleUnicode") ?? title, artist, artistUnicode: get("ArtistUnicode") ?? artist, creator: get("Creator") ?? "", version: get("Version") ?? "", source: get("Source") ?? "", tags: get("Tags") ?? "" };
}
const mrCovering = (tags, w) => tags.toLowerCase().split(" ").find(t => t.includes(w.toLowerCase())) ?? null; // (the tag containing the word)
const mrIeq = (a, b) => a.length === b.length && a.toUpperCase() === b.toUpperCase(); // (ordinal, ignoring case)
function mrIdx(s, sub) { for (let i = 0; i + sub.length <= s.length; i++) if (mrIeq(s.slice(i, i + sub.length), sub)) return i; return -1; }
// a .NET regex with (?i): its \b counts letters of every script as word characters
const MR_W = String.raw`[\p{L}\p{Mn}\p{Nd}\p{Pc}]`;
const mrRx = src => new RegExp(src.replace(/\\b/g, `(?:(?<=${MR_W})(?!${MR_W})|(?<!${MR_W})(?=${MR_W}))`), "iu");
const mrAll = (rx, s) => [...s.matchAll(new RegExp(rx.source, rx.flags + "g"))];
const mrBlank = s => !s || !s.trim();
// [Events] lines (each must start with its type and a comma); a sprite's layer is read by name only, anything else is Background
const MR_LAYERS = ["Background", "Fail", "Pass", "Foreground", "Overlay"];
const mrPath = p => p == null ? null : String(p).replace(/"/g, "").replace(/\\/g, "/").trim();
function mrEvents(code) {
  const ev = { backgrounds: [], videos: [], sprites: [], animations: [] }, is = (l, t) => t.some(x => l.startsWith(x + ","));
  let read = false;
  for (let line of String(code || "").split("\n")) {
    line = line.replace(/\r/g, "");
    if (line.startsWith("[")) read = false;
    if (read && line.trim()) {
      const a = line.split(","), layer = MR_LAYERS.includes(a[1]) ? a[1] : "Background";
      if (is(line, ["Background", "0"])) ev.backgrounds.push(mrPath(a[2]));
      else if (is(line, ["Video", "1"])) ev.videos.push({ path: mrPath(a[2]), offset: parseInt(a[1], 10) });
      else if (is(line, ["Sprite", "4"])) ev.sprites.push({ layer, path: mrPath(a[3]) });
      else if (is(line, ["Animation", "6"])) {
        const path = mrPath(a[3]), n = parseInt(a[6], 10) || 0, d = path ? path.lastIndexOf(".") : -1;
        ev.animations.push({ layer, path, frames: d >= 0 ? Array.from({ length: n }, (_, i) => path.slice(0, d) + i + path.slice(d)) : [] });
      }
    }
    if (line.includes("[Events]")) read = true;
  }
  return ev;
}
const MR_EV = new WeakMap();
function mrMapEvents(m) { const c = MR_EV.get(m), raw = m.eventsRaw || ""; if (c && c.raw === raw) return c.ev; const ev = mrEvents("[Events]\n" + raw); MR_EV.set(m, { raw, ev }); return ev; }
// the .osb it reads: only "Artist - Title (Creator).osb" of the reference difficulty, with its [Variables] filled in
// (null: none; undefined: still being read)
function mrOsb(ctx) {
  const ref = mrMaps(ctx)[0]; if (!ref) return null;
  const M = mrMeta(ref.m), fn = s => s.replace(/[\/\\?*:|"<>]/g, ""), F = mrFiles();
  const k = (fn(M.artist) + " - " + fn(M.title) + " (" + fn(M.creator) + ").osb").toLowerCase(), e = F[k];
  if (!e || !String(e.name || k).endsWith(".osb")) return null;
  const only = Object.keys(F).filter(x => x.endsWith(".osb")).length === 1 && typeof osbText === "string" && osbText;
  const code = only ? osbText : mrFile(e, "text", x => x.async("string"));
  if (code == null) return code;
  const subs = []; let read = false;
  for (let l of code.split("\n")) {
    l = l.replace(/\r/g, "");
    if (l.startsWith("[")) read = false;
    if (read && l.trim() && l.startsWith("$")) { const p = l.split("="); subs.push([p[0].trim(), (p[1] ?? "").trim()]); }
    if (l.includes("[Variables]")) read = true;
  }
  let s = code; for (const [a, b] of subs) if (a) s = s.split(a).join(b);
  return mrEvents(s);
}
// files read in the background, once per file: the checks skip what's still being read, and run again when it's in
const MR = { cache: new WeakMap(), queue: [], busy: 0 };
function mrFile(entry, kind, fn) {
  if (!entry || typeof entry !== "object") return null;
  let c = MR.cache.get(entry); if (!c) MR.cache.set(entry, c = {});
  if (kind in c) return c[kind];
  c[kind] = undefined;
  MR.queue.push(async () => { let v = null; try { v = await fn(entry); } catch { v = null; } c[kind] = v ?? null; });
  mrPump();
  return undefined;
}
function mrPump() {
  while (MR.busy < 2 && MR.queue.length) {
    const job = MR.queue.shift(); MR.busy++;
    job().finally(() => { MR.busy--; if (MR.queue.length) mrPump(); else if (!MR.busy) mrRerun(); });
  }
}
function mrRerun() {
  try { if (typeof VFY_RUN === "undefined") return; VFY_RUN.res = null; if (typeof vfyShow === "function") vfyShow(); } catch {}
}
// Directory.GetFiles(song folder, path, plus ".*" when it has no dot): the first file that matches
function mrFind(name) {
  const F = mrFiles(), k = norm(name);
  if (name.includes(".")) return F[k] ? k : null;
  return Object.keys(F).find(f => f.startsWith(k + ".") && !f.slice(k.length + 1).includes("/")) ?? null;
}
// Common.GetTagOsuIssues / GetTagOsbIssues: each distinct path once, read with read(entry, key) ->
// { name, v } (v: what was read, null if it couldn't be, undefined while reading; why: "leaves" / "missing")
function mrTagFiles(paths, read) {
  const out = [], seen = new Set();
  for (const p of paths) {
    if (p == null || seen.has(p)) continue; seen.add(p);
    if (p.startsWith("..")) { out.push({ name: p, v: null, why: "leaves" }); continue; }
    const k = mrFind(p);
    out.push(k ? { name: p, v: read(mrFiles()[k], k), why: null } : { name: p, v: null, why: "missing" });
  }
  return out;
}
// TagLib's photo size: picked by the file extension, read from the header
function mrImageSize(u, name) {
  const ext = String(name).toLowerCase().split(".").pop(), be16 = i => u[i] << 8 | u[i + 1], le16 = i => u[i] | u[i + 1] << 8;
  const be32 = i => ((u[i] << 24) >>> 0) + (u[i + 1] << 16 | u[i + 2] << 8 | u[i + 3]), le32 = i => u[i] | u[i + 1] << 8 | u[i + 2] << 16 | u[i + 3] << 24;
  if (ext === "png") return u.length >= 24 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47 ? { w: be32(16), h: be32(20) } : null;
  if (ext === "gif") return u.length >= 10 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 ? { w: le16(6), h: le16(8) } : null;
  if (ext === "bmp") return u.length >= 26 && u[0] === 0x42 && u[1] === 0x4d ? { w: Math.abs(le32(18)), h: Math.abs(le32(22)) } : null;
  if (ext !== "jpg" && ext !== "jpeg") return null;
  if (u[0] !== 0xff || u[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < u.length;) {
    if (u[i] !== 0xff) { i++; continue; }
    const mk = u[i + 1];
    if (mk === 0xff) { i++; continue; }
    if (mk === 0x01 || (mk >= 0xd0 && mk <= 0xd8)) { i += 2; continue; }
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { h: be16(i + 5), w: be16(i + 7) };
    if (mk === 0xd9 || mk === 0xda) return null;
    i += 2 + be16(i + 2);
  }
  return null;
}
const mrImage = (e, k) => mrFile(e, "img", async x => { const u = await x.async("uint8array"); return { size: mrImageSize(u, k), bytes: u.length }; });
const mrBytes = e => mrFile(e, "bytes", x => x.async("uint8array"));
// video headers (MapsetVerifier's container parsers for MP4 and AVI, the files TagLib opens by their extension):
// { w, h, video: has a video track, ch: audio channels }
const mrStr4 = (u, i) => String.fromCharCode(u[i], u[i + 1], u[i + 2], u[i + 3]);
function mrMp4(u) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const boxes = (s, e) => {
    const out = [];
    for (let p = s; p + 8 <= e && out.length < 4096;) {
      let size = dv.getUint32(p), hs = 8; const type = mrStr4(u, p + 4);
      if (size === 1) { if (p + 16 > e) break; size = Number(dv.getBigUint64(p + 8)); hs = 16; } else if (size === 0) size = e - p;
      if (size < hs || p + size > e) break;
      out.push({ type, s: p + hs, e: p + size }); p += size;
    }
    return out;
  };
  const find = (L, t) => L.find(b => b.type === t), u16 = (b, i) => b.s + i + 2 <= b.e ? dv.getUint16(b.s + i) : 0, u32 = (b, i) => b.s + i + 4 <= b.e ? dv.getUint32(b.s + i) : 0;
  const moov = find(boxes(0, u.length), "moov"); if (!moov) return null;
  let video = null, audio = null;
  for (const trak of boxes(moov.s, moov.e).filter(b => b.type === "trak")) {
    const t = { handler: "", w: 0, h: 0, ch: 0 }, tb = boxes(trak.s, trak.e), tkhd = find(tb, "tkhd");
    if (tkhd) { const v1 = u[tkhd.s] === 1, o = 4 + (v1 ? 16 : 8) + 8 + (v1 ? 8 : 4) + 8 + 8 + 36; t.w = Math.round(u32(tkhd, o) / 65536); t.h = Math.round(u32(tkhd, o + 4) / 65536); }
    const mdia = find(tb, "mdia"), mb = mdia ? boxes(mdia.s, mdia.e) : [], hdlr = find(mb, "hdlr");
    if (hdlr && hdlr.s + 12 <= hdlr.e) t.handler = mrStr4(u, hdlr.s + 8);
    const minf = find(mb, "minf"), stbl = minf && find(boxes(minf.s, minf.e), "stbl"), stsd = stbl && find(boxes(stbl.s, stbl.e), "stsd");
    if (stsd && u32(stsd, 4) > 0) {
      if (t.handler === "soun") t.ch = u16(stsd, 32);
      else { const w = u16(stsd, 40), h = u16(stsd, 42); if (w > 0) t.w = w; if (h > 0) t.h = h; }
    }
    if (t.handler === "vide" && !video) video = t; else if (t.handler === "soun" && !audio) audio = t;
  }
  return video ? { w: video.w, h: video.h, video: true, ch: audio ? audio.ch : 0 } : null;
}
function mrAvi(u) {
  if (u.length < 12 || mrStr4(u, 0) !== "RIFF" || mrStr4(u, 8) !== "AVI ") return null;
  const end = Math.min(u.length, 12 + 1048576), le32 = i => (u[i] | u[i + 1] << 8 | u[i + 2] << 16 | u[i + 3] << 24) >>> 0, le16 = i => u[i] | u[i + 1] << 8;
  const r = { w: 0, h: 0, video: false, ch: 0 }; let type = "";
  for (let p = 12; end - p >= 8;) {
    const id = mrStr4(u, p), size = le32(p + 4), s = p + 8;
    if (size > end - s) break;
    if (id === "LIST") { if (["hdrl", "strl", "odml"].includes(mrStr4(u, s))) { p = s + 4; continue; } }
    else if (id === "avih" && s + 40 <= end) { r.w = le32(s + 32); r.h = le32(s + 36); }
    else if (id === "strh") { type = mrStr4(u, s); if (type === "vids") r.video = true; }
    else if (id === "strf" && type === "vids") { const w = le32(s + 4), h = le32(s + 8); if (w > 0) r.w = w; if (h > 0) r.h = h; }
    else if (id === "strf" && type === "auds" && s + 4 <= end) r.ch = le16(s + 2);
    p = s + size + size % 2;
  }
  return r.w || r.h ? r : null;
}
// other containers TagLib opens (Matroska, WebM, ASF, MPEG): the size from the browser, which can't tell whether there's an audio track
async function mrVideoEl(e) {
  if (typeof document === "undefined" || typeof URL === "undefined") return null;
  const url = URL.createObjectURL(await e.async("blob")), v = document.createElement("video");
  try {
    return await new Promise(res => {
      const t = setTimeout(() => res(null), 15000);
      v.onloadedmetadata = () => { clearTimeout(t); res(v.videoWidth || v.videoHeight ? { w: v.videoWidth, h: v.videoHeight, video: true, ch: null } : null); };
      v.onerror = () => { clearTimeout(t); res(null); };
      v.preload = "metadata"; v.muted = true; v.src = url;
    });
  } finally { v.removeAttribute("src"); URL.revokeObjectURL(url); }
}
const mrVideo = (e, k) => mrFile(e, "video", async x => {
  const ext = String(k).toLowerCase().split(".").pop();
  if (ext === "flv") return null; // (TagLib can't open FLV)
  if (ext === "mp4" || ext === "m4v") return mrMp4(await x.async("uint8array"));
  if (ext === "avi" || ext === "divx") return mrAvi(await x.async("uint8array"));
  return mrVideoEl(x);
});
// title version markers (CheckTitleMarkers), most specific first
const MR_MK = { SPED_CUT: "(Sped Up & Cut Ver.)", NC_CUT: "(Nightcore & Cut Ver.)", TV: "(TV Size)", EXT: "(Extended Edit)", MOVIE: "(Movie Ver.)", GAME: "(Game Ver.)", SHORT: "(Short Ver.)", CUT: "(Cut Ver.)", SPED: "(Sped Up Ver.)", NC: "(Nightcore Mix)" };
const MR_MARKERS = [
  [MR_MK.SPED_CUT, String.raw`(sped|speed)\s*up(\s+ver\.?)?\s*&\s*cut(\s+(size|ver(sion)?))?`],
  [MR_MK.NC_CUT, String.raw`(nightcore|night\s+core)(\s+(ver\.?|mix))?\s*&\s*cut(\s+(size|ver(sion)?))?`],
  [MR_MK.TV, String.raw`\btv\s+(size|ver(sion)?)\b`],
  [MR_MK.EXT, String.raw`\bextended\s+edit\b`],
  [MR_MK.MOVIE, String.raw`\b(movie\s+(size|ver(sion)?|edit|cut)|movie\s+version)\b`],
  [MR_MK.GAME, String.raw`\b(game\s+(size|ver(sion)?)|game\s+op\s+edit|~game\s+size~)\b`],
  [MR_MK.SHORT, String.raw`(~?\s*-?\s*short(\s+(size|ver(sion)?))?~?|\(short\)|-short\s*ver-)`], // (any "short" at all, as in MapsetVerifier)
  [MR_MK.CUT, String.raw`(?<!&\s)\bcut\s+(size|ver(sion)?)\b`],
  [MR_MK.SPED, String.raw`(?<!&\s)\b(sped|speed)\s*up(\s+ver(sion)?)?\b`],
  [MR_MK.NC, String.raw`(?<!&\s)\b(nightcore|night\s+core)\s+(ver\.?|mix)\b`],
].map(([marker, src]) => ({ marker, rx: mrRx(src) }));
const MR_TMRX = { generic: mrRx(String.raw`\(([^)]+)\s+Version\)`), nonCanon: mrRx(String.raw`\(([^)]+)\s+ver\.?\)`), trailing: mrRx(String.raw`\s([^\s(]+)\s+ver\.?\s*$`),
  long: mrRx(String.raw`\(Long\)`), op: mrRx(String.raw`\bOP\s+Version\b`), live: mrRx(String.raw`\([^)]*\blive\b[^)]*\)`) };
function mrParenAt(t, i) { const o = t.lastIndexOf("(", i); if (o < 0) return null; const c = t.indexOf(")", o); return c < 0 || c < i ? null : t.slice(o, c + 1); }
const mrAllCase = (s, re) => { const L = [...s].filter(c => /\p{L}/u.test(c)); return L.length > 0 && L.every(c => re.test(c)); };
function mrUniform(t, slice) { // the title is written all in lower or all in upper case, marker included
  let i = t.indexOf(slice); if (i < 0) i = mrIdx(t, slice); if (i < 0) return false;
  const rest = t.slice(0, i) + t.slice(i + slice.length);
  return (mrAllCase(rest, /\p{Ll}/u) && mrAllCase(slice, /\p{Ll}/u)) || (mrAllCase(rest, /\p{Lu}/u) && mrAllCase(slice, /\p{Lu}/u));
}
function mrCasingOk(t, canon, text = null) { // the exact marker, or it in the title's uniform casing
  let slice = text;
  if (slice != null) { if (!mrIeq(slice, canon)) return false; }
  else { const i = mrIdx(t, canon); if (i < 0) return false; slice = mrParenAt(t, i) ?? t.slice(i, i + canon.length); if (!mrIeq(slice, canon)) return false; }
  return slice === canon || mrUniform(t, slice);
}
function mrApproxOk(t, f) { // matched, and written correctly somewhere
  if (!f.rx.test(t)) return false;
  if (t.includes(f.marker)) return true;
  return mrAll(f.rx, t).some(m => { const s = mrParenAt(t, m.index); return s != null && mrCasingOk(t, f.marker, s); });
}
const mrSkipTempo = (f, t) => [MR_MK.SPED, MR_MK.CUT, MR_MK.NC].includes(f.marker) && (mrApproxOk(t, MR_MARKERS[0]) || mrApproxOk(t, MR_MARKERS[1]));
function mrInLive(t, rx) { // every match sits inside a "(... live ...)" parenthetical
  const ms = mrAll(rx, t); if (!ms.length) return false;
  return ms.every(m => { const o = t.lastIndexOf("(", m.index), c = t.indexOf(")", m.index); return o >= 0 && c >= 0 && MR_TMRX.live.test(t.slice(o, c + 1)); });
}
function mrTitleCase(w) { // .NET TextInfo.ToTitleCase of a lowercase word
  let out = "", inWord = false;
  for (const ch of w) {
    if (/\p{L}/u.test(ch)) { out += inWord ? ch : ch.toUpperCase(); inWord = true; }
    else if ((ch === "'" || /[\p{M}\p{N}]/u.test(ch)) && inWord) out += ch;
    else { out += ch; inWord = false; }
  }
  return out;
}
const mrTitleWords = s => s.split(" ").filter(Boolean).map(w => /\p{L}/u.test(w) && /\p{Nd}/u.test(w) ? w : mrTitleCase(w.toLowerCase())).join(" ");
const mrQuoted = s => /["“”'‘’]/.test(s);
function mrSuggestVer(inner) {
  if (mrIeq(inner, "extended")) return "(Extended Ver.)";
  const sp = inner.lastIndexOf(" ");
  if (sp > 0 && mrQuoted(inner.slice(0, sp))) return `(${inner.slice(0, sp)} ${mrTitleWords(inner.slice(sp + 1))} Ver.)`;
  return `(${mrTitleWords(inner)} Ver.)`;
}
function mrGuideline(t, inner, matched) { // -> the "(#### Ver.)" to suggest, or null
  const sug = mrSuggestVer(inner);
  if (inner.length > 40 || (/(remix|edition)/i.test(inner) && !/^\([^)]+\s+Version\)$/i.test(matched))) return null; // (stylised)
  if (mrQuoted(inner) && matched.includes(" Ver.")) return null;
  if (MR_MARKERS.some(f => f.rx.test(inner) || f.rx.test(matched))) return null;
  return mrCasingOk(t, sug, matched) ? null : sug;
}
function mrHasMarker(t, f) {
  if (!f.rx.test(t) || mrSkipTempo(f, t) || mrInLive(t, f.rx)) return false;
  return mrCasingOk(t, f.marker) || mrApproxOk(t, f);
}
// CheckTitleMarkers on the reference difficulty -> [level, message, values]
function mrTitleMarkers(M) {
  const out = [], types = [["romanized", M.title], ["unicode", M.titleUnicode]].filter(([ty, t]) => !mrBlank(t) && !(ty === "unicode" && t === M.title));
  const Cap = ty => trv(ty === "romanized" ? "Romanized" : "Unicode");
  for (const f of MR_MARKERS) for (const [ty, t] of types) {
    if (!f.rx.test(t) || mrSkipTempo(f, t) || mrCasingOk(t, f.marker)) continue;
    if ((f.marker === MR_MK.SPED_CUT || f.marker === MR_MK.NC_CUT) && mrApproxOk(t, f)) continue;
    if (mrInLive(t, f.rx)) continue;
    out.push(["problem", "{type} title field; \"{field}\" incorrect format of \"{marker}\".", { type: Cap(ty), field: t, marker: f.marker }]);
  }
  const tv = MR_MARKERS[2].rx;
  for (const [ty, t] of types) {
    if (!tv.test(t)) continue;
    const c = t.lastIndexOf(")"), o = c < 0 ? -1 : t.lastIndexOf("(", c), last = o >= 0 && o < c ? t.slice(o, c + 1) : null;
    if (last != null && tv.test(last) && mrCasingOk(t, MR_MK.TV, last)) continue;
    out.push(["warning", "{type} title field; \"{field}\" — (TV Size) should be at the end of the title.", { type: Cap(ty), field: t }]);
  }
  if (mrCovering(M.tags, "game") != null || mrCovering(M.tags, "videogame") != null) for (const [ty, t] of types)
    if (MR_TMRX.op.test(t) && !t.includes(MR_MK.GAME)) out.push(["warning", "{type} title field; \"{field}\" — consider \"(Game Ver.)\" instead of \"OP Version\" (game-related tags detected).", { type: Cap(ty), field: t }]);
  for (const [ty, t] of types) {
    const g = (inner, matched) => { const s = mrGuideline(t, inner, matched); if (s) out.push(["warning", "{type} title field; \"{field}\" should use guideline format \"{marker}\".", { type: Cap(ty), field: t, marker: s }]); };
    for (const m of mrAll(MR_TMRX.generic, t)) g(m[1].trim(), m[0]);
    for (const m of mrAll(MR_TMRX.nonCanon, t)) g(m[1].trim(), m[0]);
    for (const m of mrAll(MR_TMRX.trailing, t)) g(m[1].trim(), m[0].trim());
    if (MR_TMRX.long.test(t) && mrIdx(t, "(Long Ver.)") < 0) out.push(["warning", "{type} title field; \"{field}\" should use guideline format \"{marker}\".", { type: Cap(ty), field: t, marker: "(Long Ver.)" }]);
  }
  const nc = mrCovering(M.tags, "nightcore");
  if (nc != null) for (const [ty, t] of types) for (const [a, b] of [[MR_MK.SPED, MR_MK.NC], [MR_MK.SPED_CUT, MR_MK.NC_CUT]])
    if (mrIdx(t, a) >= 0) out.push(["warning", "\"{tag}\" in tags, consider \"{sub}\" instead of \"{orig}\" in {type} title.", { tag: nc, sub: b, orig: a, type: trv(ty) }]);
  if (!mrBlank(M.title) && !mrBlank(M.titleUnicode) && M.title !== M.titleUnicode) for (const f of MR_MARKERS) {
    const r = mrHasMarker(M.title, f), u = mrHasMarker(M.titleUnicode, f);
    if (r !== u) out.push(["problem", "{a} title field includes \"{marker}\" but {b} title field does not.", { a: trv(r ? "Romanized" : "Unicode"), marker: f.marker, b: trv(r ? "Unicode" : "Romanized") }]);
  }
  return out;
}
// CheckMarkerSpacing on the artist fields: tests returning what's missing; the first group are problems, the second warnings
const MR_SPACING = (() => {
  const J = "[一-龠]+|[ぁ-ゔ]+|[ァ-ヴー]", r = (rx, msg) => f => rx.test(f) ? msg : null;
  const both = (t, lit) => f => new RegExp(t + "[a-zA-Z0-9]").test(f) ? `whitespace after "${lit}"` : new RegExp("[a-zA-Z0-9]" + t).test(f) ? `whitespace before "${lit}"` : null;
  return [[both("CV:", "CV:"), both("vs\\.", "vs."), both("feat\\.", "feat."), r(/[a-zA-Z0-9]\(CV:/, "whitespace before \"(CV:\" or full-width bracket \"（\""),
    r(/(?<!(\(|（))CV:/, "\"(\" before \"CV:\""), r(/,[a-zA-Z0-9]/, "whitespace after \",\"")],
  [both("&", "&"), r(/(?<! |\(|（)feat\./, "whitespace before \"feat.\""), r(/(?<! )(\(|（)feat\./, "whitespace before \"(feat.\""), r(new RegExp(`(?<! |${J})vs\\.`), "whitespace before \"vs.\""),
    r(new RegExp(`(?<! |${J})&`), "whitespace before \"&\""), r(/CV(?!:[ 一-龠]+|[ぁ-ゔ]+|[ァ-ヴー]|：)/, "whitespace after \"CV:\" or full-width colon \"：\""),
    r(/,(?![ 一-龠]+|[ぁ-ゔ]+|[ァ-ヴー])/, "whitespace after \",\" or full-width comma \"、\""), r(new RegExp(`feat\\.(?! |${J})`), "whitespace after \"feat.\""),
    r(new RegExp(`vs\\.(?! |${J})`), "whitespace after \"vs.\""), r(new RegExp(`&(?! |${J})`), "whitespace after \"&\"")]];
})();
// CheckSkinningStandard's skin sets: [file pattern ({n}: an optional frame number), required, only when the mapset has ("slider" / "repeat"ing sliders)]
const MR_SKIN = [
  ["Cursor", [["cursor.png", 1], ["cursortrail.png", 1], ["cursormiddle.png", 0], ["cursor-smoke.png", 0]]],
  ["Hitburst", [["hit0-{n}.png", 1], ["hit50-{n}.png", 1], ["hit100-{n}.png", 1], ["hit100k-{n}.png", 1], ["hit300-{n}.png", 1], ["hit300g-{n}.png", 1], ["hit300k-{n}.png", 1],
    ["particle50.png", 0], ["particle100.png", 0], ["particle300.png", 0], ["sliderpoint10.png", 0], ["sliderpoint30.png", 0]]],
  ["Hitcircle", [["approachcircle.png", 1], ["followpoint-{n}.png", 1], ["hitcircle.png", 1], ["hitcircleoverlay-{n}.png", 1], ["reversearrow.png", 1, "repeat"], ["sliderendcircle.png", 1, "slider"],
    ["sliderendcircleoverlay-{n}.png", 1, "slider"], ["sliderstartcircle.png", 1, "slider"], ["sliderstartcircleoverlay-{n}.png", 1, "slider"], ["hitcircleselect.png", 0]]],
  ["Slidertrack", [["sliderb{n}.png", 1, "slider"], ["sliderfollowcircle-{n}.png", 1, "slider"], ["sliderscorepoint.png", 1, "slider"], ["sliderb-nd.png", 0, "slider"], ["sliderb-spec.png", 0, "slider"]]],
  ["Hitcircle numbers", Array.from({ length: 10 }, (_, i) => ["default-" + i + ".png", 1])],
];
function mrSkinMatch(file, pattern) { // (the extension doesn't matter)
  const strip = n => { const d = n.lastIndexOf("."); return d >= 0 ? n.slice(0, d) : n; }, fb = strip(file), pb = strip(pattern), lo = s => s.toLowerCase();
  if (mrIeq(fb, pb)) return true;
  const tok = pb.includes("-{n}") ? "-{n}" : pb.includes("{n}") ? "{n}" : null; if (!tok) return false;
  const ti = pb.indexOf(tok), pre = pb.slice(0, ti), suf = pb.slice(ti + tok.length), np = tok === "-{n}" ? pre + "-" : pre;
  if (mrIeq(fb, pre + suf)) return true;
  if (!lo(fb).startsWith(lo(np)) || !lo(fb).endsWith(lo(suf)) || fb.length <= np.length + suf.length) return false;
  return /^\p{Nd}+$/u.test(fb.slice(np.length, fb.length - suf.length));
}
// ---- MV parity: hit sound & file helpers ----
// How MapsetVerifier reads hit sounding and the files in the folder, its quirks included (users compare against it):
// Parser/Objects/HitObject.cs, HitSample.cs, HitObjects/Slider.cs, BeatmapSet.cs, Osb.cs, Statics/SkinStatic.cs.
const MV_SET = ["auto", "normal", "soft", "drum"], MV_HS = { 1: "normal", 2: "whistle", 4: "finish", 8: "clap" };
const mvNum = v => String(+(+v).toFixed(2)); // C#'s "0.##"
const mvRound = x => Math.abs(x % 1) === .5 ? 2 * Math.round(x / 2) : Math.round(x); // C#'s Math.Round (halves to even)
const mvTs = o => fmtMs(Math.trunc(o.t)) + " (" + (o.kind === "spinner" ? "spinner" : o.num) + ") -"; // (Timestamp.Get(hitObject))
const mvBase = p => String(p).split(/[\\/]/).pop();
const mvParse = p => String(p ?? "").replace(/"/g, "").replace(/\\/g, "/").trim(); // PathStatic.ParsePath, case kept
const mvStrip = p => p.lastIndexOf(".") >= 0 ? p.slice(0, p.lastIndexOf(".")) : p;
// the timing line in effect at t (len = MV's hit sound leniency: 5 ms, 2 for slider ticks); before the first line, the first
function hsLine(m, t, len = 0) { const L = m.timing; return L.length ? L[Math.max(0, lastBefore(L, t + len, "time"))] : null; }
const mvLineSet = (m, t, len = 5) => { const l = hsLine(m, t, len); return l ? l.sampleSet : 0; };
// the object's own sample set (the addition first when asked), else the timing line's (HitObject.GetSampleset)
function mvObjSet(m, o, add, t = o.t, len = 5) { const sp = o.samp || {}; return add && sp.a ? sp.a : sp.n ? sp.n : mvLineSet(m, t, len); }
function hsTheo(m, t) { // Beatmap.GetTheoreticalUnsnap: the smallest unsnap from 1/16, 1/12, 1/9, 1/7, 1/5, ignoring the game's rounding
  const u = redLineAt(m, t), d = (t - u.time) / u.beat, cf = d - Math.floor(d);
  let best = null;
  for (const k of [16, 12, 9, 7, 5]) { const v = (cf - mvRound(cf * k) / k) * u.beat; if (best === null || Math.abs(v) < Math.abs(best) - 1e-9) best = v; }
  return best;
}
function mvCurve(m, o) { // Slider.GetCurveDuration: pixel length / (100 × SV × slider multiplier / beat), SV unclamped
  const u = redLineAt(m, o.t), l = hsLine(m, o.t), sv = !l || l.uninherited || !(l.beat < 0) ? 1 : 100 / -l.beat;
  return o.length / (100 * sv * +(m.diff.SliderMultiplier ?? 1.4) / u.beat);
}
function mvEnd(m, o) { // Slider.EndTime: the exact end moved by its practical unsnap
  if (o.kind === "spinner") return o.end;
  if (o.kind !== "slider") return o.t;
  const x = o.t + mvCurve(m, o) * o.slides; return x + practicalUnsnap(x, m);
}
function hsTicks(m, o) { // Slider.GetSliderTickTimes: every beat / tick rate from the start, over the whole slider
  const u = redLineAt(m, o.t), rate = +(m.diff.SliderTickRate ?? 1), th = o.t - hsTheo(m, o.t), out = [];
  const n = Math.min(20000, Math.trunc((mvEnd(m, o) - o.t - 1) / u.beat * rate));
  for (let i = 1; i <= n; i++) out.push(Math.trunc(i * u.beat / rate + th));
  return out;
}
// a slider's edge hit sounds and sample sets as MV reads them: a missing field gives every edge the object's own,
// a field without "|" gives every edge none (and no reverses at all)
function mvSl(o) {
  const n = o.argc ?? 11, sp = o.samp || {}, S = o.slides, r = { sh: 0, eh: 0, rh: [], ss: 0, sa: 0, es: 0, ea: 0, rs: [], ra: [] };
  if (n > 8) { const L = o.edgeSounds || []; if (L.length > 1) { r.sh = L[0] | 0; r.eh = L[L.length - 1] | 0; r.rh = L.slice(1, -1).map(v => v | 0); } }
  else { r.sh = r.eh = o.hs; r.rh = Array(S).fill(o.hs); }
  if (n > 9) { const L = o.edgeSets || []; if (L.length > 1) { const e = L.map(x => [x[0] | 0, x[1] | 0]); [r.ss, r.sa] = e[0]; [r.es, r.ea] = e[e.length - 1]; r.rs = e.slice(1, -1).map(x => x[0]); r.ra = e.slice(1, -1).map(x => x[1]); } }
  else { r.ss = r.es = sp.n | 0; r.sa = r.ea = sp.a | 0; r.rs = Array(S).fill(sp.n | 0); r.ra = Array(S).fill(sp.a | 0); }
  return r;
}
function mvPart(m, o, t) { // HitObject.GetPartName, lower case, with "body" read as "tick"
  if (o.kind === "circle") return "circle";
  const near = a => a <= t + 2 && a >= t - 2, c = o.kind === "slider" ? mvCurve(m, o) : 0, edges = o.kind === "slider" ? Array.from({ length: o.slides }, (_, i) => o.t + c * (i + 1)) : [o.end];
  return (o.kind === "slider" ? "slider " : "spinner ") + (near(o.t) ? "head" : near(mvEnd(m, o)) || near(edges[edges.length - 1]) ? "tail" : edges.some(near) ? "reverse" : "tick");
}
const mvRevTime = (m, o, i) => Math.trunc(o.t - hsTheo(m, o.t) + mvCurve(m, o) * (i + 1)); // (Timestamp.Round: cut off)
function mvStartSet(m, o, add) { if (o.kind === "spinner") return null; if (o.kind !== "slider") return mvObjSet(m, o, add); const E = mvSl(o); return add && E.sa ? E.sa : E.ss || mvLineSet(m, o.t); }
function mvEndSet(m, o, add) { if (o.kind === "spinner") return mvObjSet(m, o, add); if (o.kind !== "slider") return null; const E = mvSl(o); return add && E.ea ? E.ea : E.es || mvLineSet(m, mvEnd(m, o)); }
function mvRevSet(m, o, i, add) { const E = mvSl(o); if (add && E.ra[i]) return E.ra[i]; return E.rs[i] || mvLineSet(m, mvRevTime(m, o, i)); }
function mvBeats(m, a, b) { // HitObject.GetBeatTimesAfter
  const off = (t, u) => { const d = (t - u.time) / u.beat; return (d - Math.floor(d)) * u.beat; }, out = [];
  let u = redLineAt(m, a), bt = a - off(a, u) + u.beat;
  for (let i = 0; i < 512 && bt <= b + 1; i++) {
    if (bt > a + 1) out.push(bt);
    const from = bt; u = redLineAt(m, from); const nb = from - off(from, u) + u.beat;
    bt = Math.abs(nb - from) < 1e-9 ? from + u.beat : nb;
  }
  return out;
}
// every sample an object can play: { f: file name without extension (null: none), edge, t } (HitObject.GetUsedHitSamples).
// osu!standard also counts the taiko samples (a conversion could use them); a custom index of 0 or 1 adds no number
function hsSamples(m, o) {
  const out = [], sp = o.samp || {}; if (!m.timing.length) return out;
  const push = (idx, set, hs, src, t, taiko) => {
    const s = MV_SET[set] ?? String(set);
    const what = src === "tick" ? "slidertick" : hs == null ? null : src === "edge" ? (hs ? "hit" + MV_HS[hs] : null) : "slider" + (hs === 2 ? "whistle" : "slide");
    out.push({ f: what ? (taiko ? "taiko-" : "") + s + "-" + what + (idx > 1 ? idx : "") : null, edge: src === "edge", t });
  };
  const edge = (t, set, hs) => { const l = hsLine(m, t, 5); push(l.sampleIndex, set ?? l.sampleSet, hs, "edge", t); };
  const split = hs => [1, 2, 4, 8].filter(b => hs & b);
  const l0 = hsLine(m, o.t, 5), kat = o.hs & 10, big = o.hs & 4; // taiko: hitclap and hitnormal always play, the object as don/kat, big or not
  push(l0.sampleIndex, l0.sampleSet, 8, "edge", l0.time, true); push(l0.sampleIndex, l0.sampleSet, 1, "edge", l0.time, true);
  push(sp.i || l0.sampleIndex, mvObjSet(m, o, true), big ? (kat ? 2 : 4) : kat ? 8 : 1, "edge", o.t, true);
  const E = o.kind === "slider" ? mvSl(o) : null, end = mvEnd(m, o);
  if (o.kind !== "spinner") { for (const b of split(E ? E.sh : o.hs)) edge(o.t, mvStartSet(m, o, true), b); edge(o.t, mvStartSet(m, o, false), 1); }
  for (const b of split(E ? E.eh : o.kind === "spinner" ? o.hs : 0)) edge(end, mvEndSet(m, o, true), b);
  edge(end, mvEndSet(m, o, false), 1); // (a circle too: the timing line's hitnormal)
  if (!E) return out;
  for (let i = 0; i < E.rh.length; i++) { const t = mvRevTime(m, o, i); for (const b of split(E.rh[i])) edge(t, mvRevSet(m, o, i, true), b); edge(t, mvRevSet(m, o, i, false), 1); }
  const body = new Set([o.t]); for (const l of m.timing) if (l.time > o.t && l.time <= end) body.add(l.time); for (const t of mvBeats(m, o.t, end)) body.add(t);
  for (const t of [...body].sort((a, b) => a - b)) {
    const l = hsLine(m, t, 5), eff = sp.n || l.sampleSet;
    push(l.sampleIndex, eff, 0, "body", t);
    if (o.hs & 2) push(l.sampleIndex, sp.a || eff, 2, "body", t);
  }
  for (const tt of hsTicks(m, o)) {
    const pt = tt + hsTheo(m, tt), l = hsLine(m, pt, 2);
    push(l ? l.sampleIndex : 1, mvObjSet(m, o, false, pt, 2) || 1, null, "tick", tt);
  }
  return out;
}
// the file names an object may use: a circle's own sample file replaces everything (cut at its first ".")
function mvFileNames(m, o, samples) {
  const f = (o.type & 1) && o.samp && o.samp.f ? mvParse(o.samp.f) : "";
  if (f) return [f.includes(".") ? f.slice(0, f.indexOf(".")) : f];
  return [...new Set(samples.filter(s => s.f).map(s => s.f))];
}
const mvSame = (f, path) => f != null && String(path).toLowerCase().startsWith(f.toLowerCase() + "."); // HitSample.SameFileName
// the files in the package, in the order MV meets them (folder by folder, names sorted): { k, name, size }
function mvPkg() {
  if (typeof files === "undefined" || !files) return [];
  const out = [];
  for (const k in files) { const f = files[k]; out.push({ k, name: String(f.name || k).replace(/\\/g, "/"), size: f._data ? f._data.uncompressedSize : f.size ?? null }); }
  return mvSortPkg(out);
}
function mvSortPkg(list) {
  const key = x => [x.name.split("/").length, x.name.toUpperCase()];
  return list.sort((a, b) => { const p = key(a), q = key(b); return p[0] - q[0] || (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0); });
}
// the last file matching "*{name}.*" (Directory.EnumerateFiles, every folder, any case)
function mvFind(pkg, name) {
  const x = name.toLowerCase() + ".", inPath = name.includes("/");
  let hit = null; for (const p of pkg) if ((inPath ? p.name : mvBase(p.name)).toLowerCase().includes(x)) hit = p;
  return hit;
}
// the storyboard events of a .osu ([Events] lines) or .osb (with its $variables), read the way MV does
function hsEvents(text, osb) {
  let code = String(text || "");
  const lines0 = code.split("\n"), sec = (lines, name) => { const out = []; let read = false; for (const l of lines) { if (l.startsWith("[")) read = false; if (read && l.trim()) out.push(l.replace(/\r/g, "")); if (l.includes("[" + name + "]")) read = true; } return out; };
  if (osb) for (const l of sec(lines0, "Variables")) if (l.startsWith("$")) { const kv = l.split("="); code = code.split(kv[0].trim()).join((kv[1] ?? "").trim()); }
  const ev = { bg: [], video: [], sprite: [], sample: [], anim: [], breaks: 0 };
  const lines = osb ? sec(code.split("\n"), "Events") : code.split("\n").filter(l => l.trim()).map(l => l.replace(/\r/g, "")); // (a .osu: its [Events] lines, m.eventsRaw)
  for (const l of lines) {
    const a = l.split(","), is = (...t) => t.some(x => l.startsWith(x + ","));
    if (is("Background", "0")) ev.bg.push(mvParse(a[2]));
    else if (is("Video", "1")) ev.video.push(mvParse(a[2]));
    else if (is("Break", "2")) ev.breaks++;
    else if (is("Sprite", "4")) ev.sprite.push(mvParse(a[3]));
    else if (is("Sample", "5")) ev.sample.push(mvParse(a[3]));
    else if (is("Animation", "6")) { const p = mvParse(a[3]), n = Math.min(10000, a[6] | 0), d = p.lastIndexOf("."); ev.anim.push({ p, frames: d < 0 ? [] : Array.from({ length: Math.max(0, n) }, (_, i) => p.slice(0, d) + i + p.slice(d)) }); }
  }
  return ev;
}
const mvEventsUsed = ev => !!(ev.bg.length || ev.video.length || ev.breaks || ev.sprite.length || ev.sample.length || ev.anim.length); // Osb.IsUsed
const mvFileName = s => String(s).replace(/[/\\?*:|"<>]/g, ""); // MetadataSettings.GetFileNameFiltered
const mvOsbName = m => mvFileName(m.meta.Artist || "") + " - " + mvFileName(m.meta.Title || "") + " (" + mvFileName(m.meta.Creator || "") + ").osb";
const mvOsuName = m => mvOsbName(m).slice(0, -4) + " [" + mvFileName(m.meta.Version || "") + "].osu"; // (the .osb name without ".osb")
// SkinStatic: the beatmap-skinnable files and when each one is used (first matching list wins)
const MV_SKIN = (() => {
  const A = s => s.split(" "), au = n => [n + ".wav", n + ".mp3", n + ".ogg"];
  const num = (p, n = 9) => Array.from({ length: n + 1 }, (_, i) => p + i + ".png");
  const general = [...A("cursor.png cursormiddle.png cursor-smoke.png cursortrail.png play-skip-{n}.png play-unranked.png multi-skipped.png pause-overlay.png pause-overlay.jpg fail-background.png fail-background.jpg pause-back.png pause-continue.png pause-replay.png pause-retry.png scorebar-bg.png scorebar-colour.png scorebar-colour-{n}.png"),
    ...num("score-"), ...A("score-comma.png score-dot.png score-percent.png score-x.png ranking-XH-small.png ranking-X-small.png ranking-SH-small.png ranking-S-small.png ranking-A-small.png ranking-B-small.png ranking-C-small.png ranking-D-small.png"),
    ...num("scoreentry-"), ...A("scoreentry-comma.png scoreentry-dot.png scoreentry-percent.png scoreentry-x.png menu-button-background.png selection-tab.png star2.png"),
    ...A("autoplay cinema doubletime easy flashlight halftime hardrock hidden nightcore nofail perfect suddendeath scorev2").map(x => "selection-mod-" + x + ".png"),
    ...au("applause"), ...au("comboburst"), ...au("comboburst-{n}"), ...au("combobreak"), ...au("failsound"), ...au("pause-loop")];
  const standard = [...A("hit0-{n}.png hit50-{n}.png hit100-{n}.png hit100k-{n}.png hit300-{n}.png hit300g-{n}.png hit300k-{n}.png selection-mod-relax2.png selection-mod-spunout.png selection-mod-target.png comboburst.png comboburst-{n}.png"),
    ...num("default-"), ...A("approachcircle.png hitcircle.png hitcircleoverlay.png hitcircleoverlay-{n}.png hitcircleselect.png followpoint.png followpoint-{n}.png lighting.png")];
  const mania = [...A("fadein key1 key2 key3 key4 key5 key6 key7 key8 key9 keycoop random").map(x => "selection-mod-" + x + ".png"),
    ...A("mania-hit0.png mania-hit50.png mania-hit100.png mania-hit200.png mania-hit300.png mania-hit300g.png mania-hit0-{n}.png mania-hit50-{n}.png mania-hit100-{n}.png mania-hit200-{n}.png mania-hit300-{n}.png mania-hit300g-{n}.png comboburst-mania.png comboburst-mania-{n}.png mania-stage-left.png mania-stage-right.png")];
  const taiko = A("pippidonclear.png pippidonfail.png pippidonidle.png pippidonkiai.png pippidonclear{n}.png pippidonfail{n}.png pippidonidle{n}.png pippidonkiai{n}.png taiko-hit0.png taiko-hit100.png taiko-hit100k.png taiko-hit300.png taiko-hit300k.png taiko-hit0-{n}.png taiko-hit100-{n}.png taiko-hit100k-{n}.png taiko-hit300-{n}.png taiko-hit300k-{n}.png taikobigcircle.png taikobigcircleoverlay.png taikohitcircle.png taikohitcircleoverlay.png approachcircle.png lighting.png taikobigcircleoverlay-{n}.png taikohitcircleoverlay-{n}.png taiko-slider.png taiko-flower-group.png taiko-flower-group-{n}.png");
  const ctch = A("inputoverlay-background.png inputoverlay-key.png fruit-catcher-idle.png fruit-catcher-fail.png fruit-catcher-kiai.png fruit-ryuuta.png fruit-catcher-idle-{n}.png fruit-catcher-fail-{n}.png fruit-catcher-kiai-{n}.png fruit-ryuuta-{n}.png comboburst-fruits.png comboburst-fruits-{n}.png lighting.png fruit-pear.png fruit-pear-overlay.png fruit-grapes.png fruit-grapes-overlay.png fruit-apple.png fruit-apple-overlay.png fruit-orange.png fruit-orange-overlay.png fruit-orange-0.png fruit-orange-overlay-0.png");
  const countdown = [...A("count1.png count2.png count3.png go.png ready.png"), ...au("count"), ...au("count1s"), ...au("count2s"), ...au("count3s"), ...au("gos"), ...au("readys")];
  const stdSlider = A("sliderstartcircle.png sliderstartcircleoverlay.png sliderstartcircleoverlay-{n}.png sliderendcircle.png sliderendcircleoverlay.png sliderendcircleoverlay-{n}.png sliderfollowcircle.png sliderfollowcircle-{n}.png sliderb.png sliderb{n}.png sliderb-nd.png sliderb-spec.png sliderscorepoint.png sliderpoint10.png sliderpoint30.png");
  const stdSpinner = [...A("spinner-approachcircle.png spinner-rpm.png spinner-clear.png spinner-spin.png spinner-glow.png spinner-bottom.png spinner-top.png spinner-middle2.png spinner-middle.png spinner-background.png spinner-circle.png spinner-metre.png spinner-osu.png"), ...au("spinnerspin"), ...au("spinnerbonus")];
  const brk = [...A("section-fail.png section-pass.png"), ...au("sectionpass"), ...au("sectionfail")];
  const C = [[general, "all"], [standard, "std"], [ctch, "std"], [mania, "std"], [taiko, "std"], [A("scorebar-marker.png scorebar-ki.png scorebar-kidanger.png scorebar-kidanger2.png selection-mod-relax.png"), "std"],
    [countdown, "countdown"], [["reversearrow.png"], "reverse"], [brk, "breaks"], [stdSlider, "slider"], [A("taiko-roll-middle.png taiko-roll-end.png sliderscorepoint.png"), "slider"], [A("fruit-drop.png fruit-drop-overlay.png"), "slider"],
    [stdSpinner, "spinner"], [["spinner-warning.png"], "spinner"], [A("fruit-bananas.png fruit-bananas-overlay.png"), "spinner"], [A("sliderb-nd.png sliderb-spec.png"), "nosliderb"],
    [["particle50.png"], "hit50"], [["particle100.png"], "hit100"], [["particle300.png"], "hit300"]];
  for (const [names] of C.slice()) for (const n of names) if (n.includes("-{n}")) { // still frames: used when there's no animation of them
    const still = n.split("-{n}").join(""), anim = still.slice(0, still.indexOf(".")) + "-{n}" + still.slice(still.indexOf("."));
    if (C.some(c => c[0].includes(anim))) C.push([[still], "still:" + anim]);
  }
  const lazer = [[[...au("fountain-shoot"), ...au("rank-up"), ...au("rank-down"), ...au("applause-s"), ...au("applause-a"), ...au("applause-b"), ...au("applause-c"), ...au("applause-d")], "all"],
    [au("spinnerbonus-max"), "spinner"], [A("sliderendmiss.png sliderendmiss-{n}.png slidertickmiss.png slidertickmiss-{n}.png"), "std"], [["score-pp.png"], "all"]];
  return { C, lazer };
})();
function mvAnimFrameOf(el, anim) { // SkinStatic.IsAnimationFrameOf (the file name as it is, case included)
  const i = anim.indexOf("{n}"); if (i < 0 || el.length <= i) return false;
  return anim.replace("{n}", (/^\d+/.exec(el.slice(i)) || [""])[0]).toLowerCase() === el;
}
function mvSkinCond(list, el) { // SkinStatic.TryGetSkinCondition
  for (const [names, cond] of list) for (const n of names) {
    if (n.toLowerCase() === el) return cond;
    const i = n.indexOf("{n}"); if (i < 0 || el.length <= i) continue;
    const d = el.indexOf(".", i); if (d < 0) continue;
    const fr = el.slice(i, d); if (/^\d*$/.test(fr) && n.replace("{n}", fr).toLowerCase() === el) return cond;
  }
  return null;
}
// what MV thinks of every file in the folder: used (and as what), unused, lazer-only, or overridden by a hit sound file
function mvUsage(ctx) {
  if (ctx._mvUsage) return ctx._mvUsage;
  const maps = ctx.maps, pkg = ctx.pkg || [], hs = mvHsFiles(ctx), first = maps[0] && maps[0].m;
  const osbName = first ? mvOsbName(first).toLowerCase() : null, osbF = osbName && pkg.find(p => p.name.toLowerCase() === osbName);
  const osbText = osbF && ctx.osbs ? ctx.osbs.get(osbF.k) : null, osb = osbText != null ? hsEvents(osbText, true) : null, osbUsed = !!osb && mvEventsUsed(osb);
  const all = new Map(), noAnim = new Set(), frames = new Set(), add = (p, kind) => { const q = p.toLowerCase(); if (q && !all.has(q)) all.set(q, kind); };
  for (const ev of [...maps.map(x => hsEvents(x.m.eventsRaw, false)), ...(osb ? [osb] : [])]) {
    for (const p of ev.bg) { add(p, "Background"); noAnim.add(p.toLowerCase()); }
    for (const p of ev.video) { add(p, "Video"); noAnim.add(p.toLowerCase()); }
    for (const p of [...ev.sprite, ...ev.sample]) { add(p, "Storyboard"); noAnim.add(p.toLowerCase()); }
    for (const a of ev.anim) { add(a.p, "Storyboard"); for (const f of a.frames) frames.add(f.toLowerCase()); }
  }
  const audio = new Set(maps.map(x => String(x.m.general.AudioFilename ?? "audio.mp3").toLowerCase()));
  const objStripped = new Set(), hsParsed = new Set(hs.map(p => p.toLowerCase()));
  for (const x of maps) for (const o of x.m.hit) if ((o.type & 1) && o.samp && o.samp.f) objStripped.add(mvStrip(mvParse(o.samp.f).toLowerCase()));
  const lastByStripped = new Map(); for (const p of pkg) lastByStripped.set(mvStrip(p.name.toLowerCase()), p.name.toLowerCase());
  const bases = pkg.map(p => mvBase(p.name)), H = maps.flatMap(x => x.m.hit);
  const st = { all: true, std: maps.length > 0, countdown: maps.some(x => (parseInt(x.m.general.Countdown, 10) || 0) > 0), reverse: H.some(o => o.kind === "slider" && o.slides > 1),
    breaks: maps.some(x => x.m.breaks.length), slider: H.some(o => o.kind === "slider"), spinner: H.some(o => o.kind === "spinner"), nosliderb: !bases.includes("sliderb.png"),
    hit50: bases.includes("hit50.png"), hit100: bases.includes("hit100.png"), hit300: bases.includes("hit300.png") };
  const ok = c => c == null ? false : c.startsWith("still:") ? !bases.some(b => mvAnimFrameOf(b, c.slice(6))) : !!st[c];
  const out = pkg.map(p => {
    const fn = mvBase(p.name).toLowerCase(), parsed = mvParse(p.name).toLowerCase(), stripped = mvStrip(parsed);
    let kind = fn.endsWith(".osu") ? "Difficulty" : audio.has(parsed) ? "Song" : all.get(parsed)
      || (lastByStripped.get(stripped) === parsed && noAnim.has(stripped) ? "Storyboard" : null)
      || (objStripped.has(stripped) || hsParsed.has(parsed) ? "Hit sound" : null)
      || (ok(mvSkinCond(MV_SKIN.C, fn)) ? "Skin element" : null)
      || (osbUsed && fn === osbName ? "Storyboard script" : null) || (frames.has(parsed) ? "Storyboard" : null);
    let lazer = false, over = null;
    if (!kind && fn === "thumbs.db") kind = "System file";
    else if (!kind) { lazer = ok(mvSkinCond(MV_SKIN.lazer, fn)); if (!lazer) over = hs.find(h2 => h2.startsWith(mvStrip(fn) + ".")) || null; }
    return { ...p, kind, lazer, over };
  });
  return ctx._mvUsage = out;
}
// the set's .osb is in use (MV: only "Artist - Title (Creator).osb" counts, and only if it has events)
function mvOsbUsed(ctx) {
  const first = ctx.maps[0] && ctx.maps[0].m, name = first ? mvOsbName(first).toLowerCase() : null, f = name && (ctx.pkg || []).find(p => p.name.toLowerCase() === name);
  const text = f && ctx.osbs ? ctx.osbs.get(f.k) : null; return text != null && mvEventsUsed(hsEvents(text, true));
}
// per difficulty: every object's samples (worked out once per run)
function mvObjSamples(ctx, x) {
  const c = ctx._mvSamples || (ctx._mvSamples = new Map());
  if (!c.has(x)) c.set(x, x.m.hit.map(o => hsSamples(x.m, o)));
  return c.get(x);
}
// BeatmapSet.HitSoundFiles: for each file name the difficulties may use, the last file in the folder matching it
function mvHsFiles(ctx) {
  if (ctx._mvHs) return ctx._mvHs;
  const names = new Set();
  for (const x of ctx.maps) { const S = mvObjSamples(ctx, x); x.m.hit.forEach((o, i) => { for (const f of mvFileNames(x.m, o, S[i])) names.add(f); }); }
  const out = []; for (const n of names) { const p = mvFind(ctx.pkg || [], n); if (p) out.push(p.name); }
  return ctx._mvHs = out;
}
const usedHsFiles = ctx => mvHsFiles(ctx);
// difficulties in MV's order (by difficulty level, then star rating)
const mvOrder = maps => maps.slice().sort((a, b) => (a.lvl - b.lvl) || ((a.stars ?? 0) - (b.stars ?? 0)));
// Common.CollectHitSoundFrequency + GetBeatmapCommonlyUsedIn
function mvFrequency(ctx, path, thr, common) {
  let best = 0, most = null; const uses = new Map(), maps = mvOrder(ctx.maps);
  for (const x of maps) {
    const S = mvObjSamples(ctx, x), H = x.m.hit; let score = 0, prev = H.length ? H[0].t : 0, n = 0;
    H.forEach((o, i) => {
      if (!S[i].some(s => mvSame(s.f, path))) return;
      n++; score = (score + 1) * Math.pow(.8, (o.t - prev) / 1000); prev = o.t;
      if (!(best < score)) return;
      if (score >= thr) most = { ts: mvTs(o), d: x.m.meta.Version || "" };
      best = score;
    });
    uses.set(x, n);
  }
  if (most) return { most };
  let top = 0, inMap = null;
  for (const x of maps) { const n = uses.get(x); if (!n || mvDrain(x.m) / n > common || !(top < n)) continue; inMap = x; top = n; }
  return { inMap };
}
// the first object (any difficulty) that plays this file on the edge it's clicked on
function mvActiveAt(ctx, path) {
  for (const x of mvOrder(ctx.maps)) { const S = mvObjSamples(ctx, x); for (let i = 0; i < x.m.hit.length; i++) { const o = x.m.hit[i]; if (o.kind !== "spinner" && S[i].some(s => s.edge && Math.abs(s.t - o.t) < 1e-9 && mvSame(s.f, path))) return { o, x }; } }
  return null;
}
// BASS's name for an audio format (MP3, OGG, WavePCM…), from the header; null = BASS couldn't open it either
function mvFmt(u) {
  const s = (o, l) => String.fromCharCode(...u.subarray(o, o + l)), r = {};
  if (u.length >= 12 && s(0, 4) === "RIFF" && s(8, 4) === "WAVE") {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let code = -1, data = null;
    for (let p = 12; p + 8 <= u.length;) { const id = s(p, 4), sz = dv.getUint32(p + 4, true);
      if (id === "fmt " && p + 16 <= u.length) { code = dv.getUint16(p + 8, true); r.ch = dv.getUint16(p + 10, true); r.sr = dv.getUint32(p + 12, true); if (code === 0xFFFE && p + 34 <= u.length) code = dv.getUint16(p + 32, true); }
      if (id === "data") { data = Math.min(sz, u.length - p - 8); r.at = p + 8; break; } p += 8 + sz + (sz & 1); }
    // Ogg Vorbis packed in a WAV ("Og" codecs 0x674F-0x6751, 0x676F-0x6771): BASS plays it; the browser decodes the Ogg stream inside
    if (data && [0x674F, 0x6750, 0x6751, 0x676F, 0x6770, 0x6771].includes(code) && s(r.at, 4) === "OggS") r.inner = [r.at, r.at + data];
    return { ...r, fmt: "wav", name: code === 1 ? "WavePCM" : code === 3 ? "WaveFloat" : "Wave", empty: !data };
  }
  if (u.length >= 12 && s(0, 4) === "FORM" && /^AIF[FC]$/.test(s(8, 4))) return { fmt: "aiff", name: "AIFF" };
  const a = typeof analyzeAudio === "function" ? analyzeAudio(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)) : {};
  return mvSongFmt(a) ? { ch: a.ch, sr: a.sr, ...mvSongFmt(a) } : r;
}
function mvSongFmt(a) { // the same from analyzeAudio's result (tools.js)
  if (!a || !a.fmt) return null;
  const L = /Layer (I+)\)/.exec(a.fmt); if (L) return { fmt: L[1].length === 3 ? "mp3" : "mp" + L[1].length, name: "MP" + L[1].length };
  if (/^OGG Vorbis/.test(a.fmt)) return { fmt: "ogg", name: "OGG" };
  if (/^WAV/.test(a.fmt)) return { fmt: "wav", name: a.wfmt === 1 ? "WavePCM" : a.wfmt === 3 ? "WaveFloat" : "Wave" };
  return null; // (Opus and the rest need BASS plug-ins MV doesn't load)
}
// hit sound files read in the background: header, duration and MV's per-ms per-channel peaks (AudioBASS.GetPeaks), decoded
// at the file's own sample rate; the checks run again when they're ready
const VFY_HS = { files: null, data: new Map(), osbs: null };
function mvDecode(ab, sr) {
  const viaPage = () => decodeAB(ab.slice(0));
  let c = null;
  try { const OAC = typeof OfflineAudioContext !== "undefined" ? OfflineAudioContext : typeof webkitOfflineAudioContext !== "undefined" ? webkitOfflineAudioContext : null; if (OAC && sr >= 3000 && sr <= 768000) c = new OAC(1, 1, sr); } catch { c = null; }
  if (!c) return viaPage();
  return new Promise((res, rej) => { const p = c.decodeAudioData(ab.slice(0), res, rej); if (p && p.catch) p.catch(() => {}); }).catch(viaPage);
}
function mvPeaks(buf) {
  const ch = buf.numberOfChannels, n = buf.length, spm = buf.sampleRate / 1000, ms = Math.floor(n / spm), d = [], pk = [];
  for (let c = 0; c < ch; c++) { d.push(buf.getChannelData(c)); pk.push(new Float32Array(Math.max(0, ms))); }
  let fr = 0;
  for (let i = 0; i < ms; i++) { const end = Math.min(Math.floor((i + 1) * spm), n); for (; fr < end; fr++) for (let c = 0; c < ch; c++) { const a = Math.abs(d[c][fr]); if (a > pk[c][i]) pk[c][i] = a; } }
  return { pk, ms, ch };
}
async function mvAnalyse(f) {
  let size = null;
  try {
    const ab = await f.async("arraybuffer"); size = ab.byteLength;
    const r = { size, ...mvFmt(new Uint8Array(ab)) };
    if (!size || !r.fmt) return { size, err: true };
    if (r.empty) return { ...r, ch: r.ch || 1, dur: 0, pk: [], ms: 0 };
    const buf = await mvDecode(r.inner ? ab.slice(r.inner[0], r.inner[1]) : ab, r.sr), p = mvPeaks(buf);
    return { ...r, ch: p.ch, dur: buf.duration * 1000, pk: p.pk, ms: p.ms };
  } catch { return { size, err: true }; }
}
function vfyHsPrep(paths) {
  if (typeof files === "undefined" || !files) return;
  if (VFY_HS.files !== files) { VFY_HS.files = files; VFY_HS.data = new Map(); VFY_HS.osbs = null; }
  const own = files, jobs = [];
  if (!VFY_HS.osbs) { const o = VFY_HS.osbs = new Map(); for (const k in files) if (/\.osb$/.test(k)) jobs.push(files[k].async("string").then(t => o.set(k, t), () => o.set(k, ""))); }
  for (const p of paths) { const k = norm(p); if (VFY_HS.data.has(k) || !files[k]) continue; VFY_HS.data.set(k, null); jobs.push(mvAnalyse(files[k]).then(r => { if (VFY_HS.files === own) VFY_HS.data.set(k, r); })); }
  if (jobs.length) Promise.all(jobs).then(() => { if (VFY_HS.files === own) vfyHsDone(); });
}
function vfyHsDone() { // show the results again with the hit sound files read
  if (typeof VFY_RUN === "undefined") return;
  VFY_RUN.res = null;
  if (typeof VFY !== "undefined" && VFY.box && VFY.box.isConnected && typeof renderVerify === "function") { const p = VFY.box.closest(".edpanel") || VFY.box.parentElement, top = p ? p.scrollTop : 0; renderVerify(VFY.box); if (p) p.scrollTop = top; }
  if (typeof S !== "undefined" && S.sideVfy && typeof sideOpen === "function" && sideOpen() && typeof sideRender === "function") sideRender();
}
// what the mapset-wide checks get to read about the package (verifyRun); the tests pass their own
function vfyMvCtx(maps) {
  const pkg = mvPkg(), ctx = { maps, pkg, osbs: null, hs: null, emptyOsu: [] };
  if (typeof VFY_HS !== "undefined" && VFY_HS.files === (typeof files === "undefined" ? null : files)) ctx.osbs = VFY_HS.osbs;
  if (!ctx.osbs && typeof osbText !== "undefined" && osbText) { const o = pkg.filter(p => /\.osb$/i.test(p.name)); if (o.length === 1) ctx.osbs = new Map([[o[0].k, osbText]]); } // (until they're read: the one the page loaded)
  if (typeof osuFiles !== "undefined") osuFiles.forEach((f, i) => { if (vfyEmptyOsu(f, i)) ctx.emptyOsu.push(String(f.path || "").replace(/\\/g, "/")); });
  try { vfyHsPrep(mvHsFiles(ctx)); } catch {}
  ctx.hs = p => typeof files !== "undefined" && VFY_HS.files === files ? VFY_HS.data.get(norm(p)) : undefined;
  return { pkg, osbs: ctx.osbs, emptyOsu: ctx.emptyOsu, hs: ctx.hs, _mvSamples: ctx._mvSamples, _mvHs: ctx._mvHs };
}
// a whitespace-only .osu: MV leaves it out of the mapset (unless it's the difficulty being edited)
const vfyEmptyOsu = (f, i) => !String(f.text || "").trim() && !(i === curDiff && map && map.hit && map.hit.length);
const mvErr = (add, f) => add("minor", "\"{f}\" couldn't be checked, so you'll need to do that manually.", { f });

// ---------- mapset-wide checks (every difficulty in the .osz) ----------
const SET_CHECKS = [
  { cat: "Audio", title: "Too high or low audio bitrate.", run(ctx, add) { // (MV: rounded, then outside 128 to 192, or 208 for OGG)
    const a = ctx.audio; if (!a || !a.kbps) return;
    const lim = /ogg/i.test(a.fmt || "") ? 208 : 192, k = roundEven(a.kbps);
    if (k < 128 || k > lim) add("problem", k < 128 ? "Average audio bitrate for \"{f}\", {k} kbps, is too low." : "Average audio bitrate for \"{f}\", {k} kbps, is too high.", { f: ctx.audioName, k: mvDp2(k) });
  } },
  { cat: "Audio", title: "More than 20% unused audio at the end.", run(ctx, add) { // MV CheckAudioUsage: the latest object end against the song's length
    const a = ctx.audio, dur = a && a.dur ? a.dur * 1000 : 0; if (!dur) return;
    let max = 0, sb = false; const osbUsed = mvOsbUsed(ctx);
    for (const x of ctx.maps) {
      if (norm(x.m.general.AudioFilename || "") !== norm(ctx.audioName || "")) continue; // (only the song that was read)
      const H = mvMap(x.m).objs, end = H.length ? H[H.length - 1].endTime : 0;
      max = Math.max(max, end / dur);
      if (hsEvents(x.m.eventsRaw, false).video.length || mvDiffSb(x.m) || osbUsed) sb = true;
    }
    if (max > .8) return;
    add("warning", sb ? "Currently {p}% unused audio. Ensure the outro either significantly contributes to the song, or is being occupied by the video or storyboard, otherwise cut the outro."
      : "Currently {p}% unused audio. Ensure the outro significantly contributes to the song, otherwise cut the outro.", { p: mvDp2((1 - max) * 100) });
  } },
  { cat: "Audio", title: "Incorrect audio format.", run(ctx, add) { // MV CheckAudioFormat: the format from the file's header, then its extension
    const a = ctx.audio, name = ctx.audioName; if (!a || !name) return;
    const f = mvSongFmt(a); if (!f) { mvErr(add, name); return; }
    if (f.fmt !== "mp3" && f.fmt !== "ogg") add("problem", "\"{f}\" is using the {fmt} format. Song audio files must be in either MP3 or OGG format. (Note: extension ≠ format.)", { f: name, fmt: f.name });
    else if (!new RegExp("\\." + f.fmt + "$", "i").test(name)) add("warning", "\"{f}\" is using the {fmt} format, but doesn't use the {ext} extension.", { f: name, fmt: f.name, ext: "." + f.fmt });
  } },
  { cat: "Audio", title: "Multiple or missing audio files.", run(ctx, add) { // MV CheckMultipleAudio (Common.GetInconsistencies)
    const maps = mrMaps(ctx), path = x => { const n = x.m.general.AudioFilename || ""; return n && mrFiles()[norm(n)] ? n : null; };
    if (!maps.length) return;
    if (maps.every(x => !path(x))) { for (const x of maps) add("problem", "[{d}] No audio file could be found.", { d: x.m.meta.Version || "" }); return; }
    const groups = new Map(); for (const x of maps) { const k = path(x) ?? "None"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push("[" + (x.m.meta.Version || "") + "]"); }
    if (groups.size > 1) for (const [k, d] of groups) add("problem", "{f} : {d}", { f: k, d: d.join(" ") });
  } },
  { cat: "Audio", title: "Too short hit sounds.", run(ctx, add) { // MV CheckHitSoundLength: the hit sound files the difficulties use
    for (const p of mvHsFiles(ctx)) { const d = ctx.hs(p); if (d === undefined || d === null) continue; if (d.err) { mvErr(add, p); continue; }
      if (d.dur < 25 && d.dur > 0) add("problem", "\"{f}\" is shorter than 25 ms ({ms} ms).", { f: p, ms: mvDp2(d.dur) }); }
  } },
  { cat: "Audio", title: "Incorrect hit sound format.", run(ctx, add) { // MV CheckHitSoundFormat
    for (const p of mvHsFiles(ctx)) {
      const d = ctx.hs(p); if (d === undefined || d === null) continue; if (d.err) { mvErr(add, p); continue; }
      if (d.fmt === "mp3") { const a = mvActiveAt(ctx, p); if (a) add("problem", "\"{f}\" is using the MP3 format and is used for active hit sounding, see {ts} in {d} for example.", { f: p, ts: mvTs(a.o), d: "[" + (a.x.m.meta.Version || "") + "]" }, a.o); }
      else if (d.fmt !== "wav" && d.fmt !== "ogg") add("warning", "\"{f}\" is using an unexpected format: \"{fmt}\".", { f: p, fmt: d.name });
      else if (!/\.(wav|ogg)$/i.test(p)) add("warning", "\"{f}\" is using the {fmt} format, but doesn't use the .wav or .ogg extension.", { f: p, fmt: d.name });
    }
  } },
  { cat: "Audio", title: "Frequent finish hit sounds.", run(ctx, add) { // MV CheckCommonFinish: normal / soft finishes used a lot without custom samples
    for (const p of mvHsFiles(ctx)) {
      const m = /^(taiko-)?(soft|normal|drum)-hit(finish)(\d+)?/i.exec(mvBase(p)); if (!m || /drum/i.test(m[2])) continue;
      const r = mvFrequency(ctx, p, 9, 3000);
      if (r.most) add("warning", "\"{f}\" may be obnoxious without custom samples. Used most frequently leading up to {ts}.", { f: p, ts: r.most.ts + " in [" + r.most.d + "]" });
      else if (r.inMap) add("warning", "\"{f}\" may be obnoxious without custom samples. Used most commonly in {d}.", { f: p, d: "[" + (r.inMap.m.meta.Version || "") + "]" });
    }
  } },
  { cat: "Audio", title: "Delayed hit sounds.", run(ctx, add) { // MV CheckHitSoundDelay: silence and a slow start before the sound gets loud
    const active = new Map(); // (the first object playing each file on its head)
    for (const x of mvOrder(ctx.maps)) { const S = mvObjSamples(ctx, x); x.m.hit.forEach((o, i) => { if (o.kind === "spinner") return; for (const s of S[i]) if (s.edge && s.f && Math.abs(s.t - o.t) < 1e-9 && !active.has(s.f.toLowerCase())) active.set(s.f.toLowerCase(), { o, x }); }); }
    for (const p of mvHsFiles(ctx)) {
      const at = active.get(mvBase(p).toLowerCase().split(".")[0]); if (!at) continue;
      const d = ctx.hs(p); if (d === undefined || d === null) continue; if (d.err) { mvErr(add, p); continue; }
      const sum = i => { let v = 0; for (const c of d.pk) v = f32(v + c[i]); return v; }, n = d.ms;
      let total = 0, max = 0; for (let i = 0; i < n; i++) { const v = sum(i); total += v; max = Math.max(max, Math.abs(v)); }
      if (!(n > 0) || !(total > 0)) continue;
      let delay = 0, pure = 0, str = 0;
      while (delay + pure < n) { str += Math.abs(sum(delay)); if (str >= max / 2) break; str *= .95; if (str < .001) { str = 0; ++pure; } ++delay; }
      if (pure >= 5) add("problem", "\"{f}\" has a {p} ms period of complete silence at the start.", { f: p, p: pure });
      else if (delay + pure >= 5) add("warning", "\"{f}\" has a delay of ~{d} ms, of which {p} ms is complete silence. (Active at e.g. {ts} in {diff}.)", { f: p, p: pure, d: delay, ts: mvTs(at.o), diff: "[" + (at.x.m.meta.Version || "") + "]" });
      else if (delay + pure >= 1) add("minor", "\"{f}\" has a delay of ~{d} ms, of which {p} ms is complete silence.", { f: p, p: pure, d: delay });
    }
  } },
  { cat: "Audio", title: "Imbalanced hit sounds.", run(ctx, add) { // MV CheckHitSoundImbalance: one channel much louder than the other
    for (const p of mvHsFiles(ctx)) {
      const d = ctx.hs(p); if (d === undefined || d === null) continue; if (d.err) { mvErr(add, p); continue; }
      if (d.ch < 2 || !d.ms) continue;
      let L = 0, R = 0; for (let i = 0; i < d.ms; i++) { L = f32(L + d.pk[0][i]); R = f32(R + (d.pk[1] ? d.pk[1][i] : 0)); }
      if (L === 0 || R === 0) { add("warning", "\"{f}\" is completely silent in the {lr} channel.", { f: p, lr: trv(L - R < 0 ? "left" : "right") }); continue; }
      const rel = L > R ? L / R : R / L; if (rel < 2) continue;
      const lr = trv(L - R > 0 ? "left" : "right"), r = mvFrequency(ctx, p, 14 / rel, 10000);
      if (r.most) add("warning", "\"{f}\" has a notably louder {lr} channel. Used most frequently leading up to {ts}.", { f: p, lr, ts: r.most.ts + " in [" + r.most.d + "]" });
      else if (r.inMap) add("warning", "\"{f}\" has a notably louder {lr} channel. Used most commonly in {d}.", { f: p, lr, d: "[" + (r.inMap.m.meta.Version || "") + "]" });
      else add("minor", "\"{f}\" has a notably louder {lr} channel, not a huge deal in this case though.", { f: p, lr });
    }
  } },
  { cat: "Hit sounds", title: "Silent hit sounds not using the 44-byte blank.wav.", run(ctx, add) { // MV CheckSilentHitSounds
    for (const p of mvHsFiles(ctx)) {
      const f = (ctx.pkg || []).find(q => q.name === p); if (!f || f.size === 0 || f.size === 44) continue;
      const d = ctx.hs(p); if (d === undefined || d === null) continue; if (d.err) { mvErr(add, p); continue; }
      let mx = 0; for (const c of d.pk) for (const v of c) if (Math.abs(v) > mx) mx = Math.abs(v);
      if (mx < .01) add("problem", "\"{f}\" is a silent hit sound but is not the required 44-byte blank.wav.", { f: p });
    }
  } },
  { cat: "Resources", title: "Missing background.", run(ctx, add) {
    const maps = mrMaps(ctx), ev = maps.map(x => mrMapEvents(x.m)); if (!maps.length) return;
    if (ev.every(e => !e.backgrounds.length)) { add("problem", "All difficulties are missing backgrounds."); return; }
    maps.forEach((x, i) => {
      const d = mrMeta(x.m).version;
      if (!ev[i].backgrounds.length) { add("problem", "{d} has no background.", { d }); return; }
      for (const f of ev[i].backgrounds) if (!mrFiles()[norm(f ?? "")]) add("problem", "{d} is missing its background file, \"{f}\".", { d, f: f ?? "" });
    });
  } },
  { cat: "Resources", title: "Too high or low background resolution.", run(ctx, add) {
    // (files still being read are skipped: the checks run again once they're in)
    for (const { name: f, v } of mrTagFiles(mrMaps(ctx).flatMap(x => mrMapEvents(x.m).backgrounds), mrImage)) {
      if (v === undefined) continue;
      if (!v || !v.size) { add("minor", "\"{f}\" couldn't be checked, so you'll need to do that manually.", { f }); continue; }
      const { w, h } = v.size, mb = v.bytes / 1048576;
      if (w > 2560 || h > 1440) add("problem", "\"{f}\" greater than 2560 x 1440 ({w} x {h})", { f, w, h });
      else if (w < 1024 || h < 640) add("warning", "\"{f}\" lower than 1024 x 640 ({w} x {h})", { f, w, h });
      if (mb > 2.5) add("problem", "\"{f}\" has a file size exceeding 2.5 MB ({mb} MB)", { f, mb: String(+mb.toFixed(2)) });
    }
  } },
  { cat: "Resources", title: "Inconsistent video offset.", run(ctx, add) {
    const groups = new Map();
    for (const x of mrMaps(ctx)) { const v = mrMapEvents(x.m).videos[0]; if (!v) continue; const k = String(v.offset); if (!groups.has(k)) groups.set(k, []); groups.get(k).push("[" + mrMeta(x.m).version + "]"); }
    if (groups.size > 1) for (const [offset, l] of groups) add("problem", "{offset} : {diffs}", { offset, diffs: l.join(" ") });
  } },
  { cat: "Resources", title: "Inconsistent video usage.", run(ctx, add) {
    const maps = mrMaps(ctx), osb = mrOsb(ctx), first = x => (mrMapEvents(x.m).videos[0] || {}).path ?? "None";
    if (osb === undefined) return; // (the .osb is still being read)
    const osbVideo = osb && osb.videos[0] ? osb.videos[0].path : null, pairs = [];
    for (const mode of [...new Set(maps.map(x => x.m.mode | 0))]) {
      let names = [...new Set(maps.filter(x => (x.m.mode | 0) === mode).map(first))];
      if (osbVideo != null) { names = names.filter(n => n !== "None"); if (!names.includes(osbVideo)) names.push(osbVideo); } // (difficulties without one show the .osb's)
      if (names.length > 1) for (const f of names) add("warning", "{f} : {diffs}.", { f, diffs: maps.filter(x => first(x) === f || osbVideo === f).map(x => "[" + mrMeta(x.m).version + "]").join(", ") });
      pairs.push(...names.map(n => [mode, n]));
    }
    const MODES = ["standard", "taiko", "catch", "mania"], seen = [];
    for (let i = 0; i < pairs.length - 1; i++) for (let j = i; j < pairs.length; j++) {
      const [a, va] = pairs[i], [b, vb] = pairs[j];
      if (a === b || va === vb || a === 1 || b === 1 || seen.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) continue; // (taiko is left out)
      seen.push([a, b]);
      add("warning", "Inconsistent video between the {a} and {b} beatmaps.", { a: MODES[a], b: MODES[b] });
    }
  } },
  { cat: "Resources", title: "Too high video resolution.", run(ctx, add) {
    for (const { name: f, v } of mrTagFiles(mrMaps(ctx).flatMap(x => mrMapEvents(x.m).videos.map(y => y.path)), mrVideo)) {
      if (v === undefined) continue;
      if (!v) add("minor", "\"{f}\" couldn't be checked, so you'll need to do that manually.", { f });
      else if (v.w > 1280 || v.h > 720) add("problem", "\"{f}\" greater than 1280 x 720 ({w} x {h})", { f, w: v.w, h: v.h });
    }
  } },
  { cat: "Audio", title: "Audio channels in video.", run(ctx, add) {
    for (const { name: f, v } of mrTagFiles(mrMaps(ctx).flatMap(x => mrMapEvents(x.m).videos.map(y => y.path)), mrVideo)) {
      if (v === undefined) continue;
      if (!v || v.ch == null) add("minor", "\"{f}\" couldn't be checked, so you'll need to do that manually.", { f });
      else if (v.video && v.ch > 0) add("problem", "\"{f}\"", { f });
    }
  } },
  { cat: "Resources", title: "Overlay layer usage.", run(ctx, add) {
    const ev = mrMaps(ctx).map(x => mrMapEvents(x.m)), osb = mrOsb(ctx);
    for (const e of ev) for (const s of e.sprites) if (s.layer === "Overlay") add("warning", "\"{f}\" Check the {where} to see where it appears.", { f: s.path, where: ".osu" });
    for (const e of ev) for (const s of e.animations) if (s.layer === "Overlay") add("warning", "\"{f}\" Check the {where} to see where it appears.", { f: s.path, where: ".osu" });
    if (!osb) return;
    for (const s of osb.sprites) if (s.layer === "Overlay") add("warning", "\"{f}\" Check the {where} to see where it appears.", { f: s.path, where: ".osb" });
    for (const s of osb.animations) if (s.layer === "Overlay") add("warning", "\"{f}\" Check the {where} to see where it appears.", { f: s.path, where: ".osb" });
  } },
  { cat: "Resources", title: "Too high sprite resolution.", run(ctx, add) {
    // storyboard images over 17 million pixels; a file the .osu points at that isn't there "couldn't be checked", one the .osb points at is "missing"
    const ev = mrMaps(ctx).map(x => mrMapEvents(x.m)), osb = mrOsb(ctx), big = v => v.size.w * v.size.h > 17000000;
    const scan = (paths, frame, fromOsb) => {
      for (const { name: f, v, why } of mrTagFiles(paths, mrImage)) {
        if (fromOsb && why === "leaves") add("problem", "\"{f}\" leaves the current song folder, which shouldn't ever happen.", { f });
        else if (fromOsb && why === "missing") add("warning", "\"{f}\" is missing, so you'll need to check that manually.", { f });
        else if (v === undefined) continue;
        else if (!v || !v.size) add("minor", "\"{f}\" couldn't be checked, so you'll need to do that manually.", { f });
        else if (big(v)) { if (frame) add("problem", "\"{f}\" (Animation Frame)", { f }); else add("problem", "\"{f}\"", { f }); }
      }
    };
    scan(ev.flatMap(e => e.sprites.map(s => s.path)), false, false);
    scan(ev.flatMap(e => e.animations.flatMap(a => a.frames)), true, false);
    if (!osb) return;
    scan(osb.sprites.map(s => s.path), false, true);
    scan(osb.animations.flatMap(a => a.frames), true, true);
  } },
  { cat: "Resources", title: "Mappers' Guild tag present.", run(ctx, add) {
    const ref = mrMaps(ctx)[0]; if (!ref) return;
    const tags = mrMeta(ref.m).tags.toLowerCase(); // (an Info in MapsetVerifier, the lowest level here)
    if (["mpg", "mappers guild", "mappers' guild", "mappersguild"].some(t => tags.includes(t))) add("minor", "Make sure this background is free to use, or that you have permission from the artist.");
  } },
  { cat: "Files", title: "0-byte files.", run(ctx, add) { // MV CheckZeroBytes (.osu files are left to "Empty difficulty file")
    for (const p of ctx.pkg || []) if (!p.name.endsWith(".osu") && p.size === 0) add("problem", "\"{f}\"", { f: p.name });
  } },
  { cat: "Files", title: "Empty difficulty file.", run(ctx, add) { // MV CheckEmptyDifficultyFile
    for (const f of ctx.emptyOsu || []) add("problem", "\"{f}\" is empty.", { f });
  } },
  { cat: "Files", title: "Hitsound difficulty present.", run(ctx, add) { // MV CheckHitsoundDiff
    for (const x of ctx.maps) { const v = x.m.meta.Version || ""; if (/^.*hit.*sound.*$/i.test(v) || /^_hs_$/i.test(v)) add("problem", "{d} may be a hitsound difficulty. If it were the case, ensure it is deleted before nominating this beatmap.", { d: v }); }
  } },
  { cat: "Files", title: "Issues with updating or downloading.", run(ctx, add) { // MV CheckUpdateValidity
    for (const p of ctx.pkg || []) {
      const name = mvBase(p.name);
      if (name.length > 130) add("warning", "\"{f}\" has a file name longer than 130 characters ({n}), which causes the .osz to fail to unzip for some users. Consider truncating the artist, title, and/or difficulty name fields where it makes sense to do so.", { f: p.name, n: name.length });
      if (!name.endsWith(".osu")) continue;
      const x = ctx.maps.find(y => typeof osuFiles !== "undefined" && osuFiles[y.i] && String(osuFiles[y.i].path || "").replace(/\\/g, "/") === p.name); if (!x) continue;
      const want = mvOsuName(x.m); if (want.toLowerCase() !== name.toLowerCase()) add("warning", "\"{f}\" should be named \"{e}\" to receive updates.", { f: name, e: want });
    }
  } },
  { cat: "Files", title: "Unused files.", run(ctx, add) { // MV CheckUnusedFiles: what no .osu or the .osb uses (thumbs.db aside)
    for (const p of mvUsage(ctx)) {
      if (p.kind) continue;
      if (p.lazer) add("minor", "\"{f}\" is not used in osu!(stable), but may be used in osu!(lazer).", { f: p.name });
      else if (p.over) add("problem", "\"{f}\", likely due to \"{o}\" being used instead.", { f: p.name, o: p.over });
      else add("problem", "\"{f}\"", { f: p.name });
    }
  } },
  { cat: "Metadata", title: "Inconsistent metadata.", run(ctx, add) {
    const maps = mrMaps(ctx), ref = maps[0]; if (!ref) return;
    const R = mrMeta(ref.m), fields = [["artist", "artist"], ["unicode artist", "artistUnicode"], ["title", "title"], ["unicode title", "titleUnicode"], ["source", "source"], ["creator", "creator"]];
    for (const x of maps) { // (tags are compared as written: "Rock" and "rock" are different tags)
      const M = mrMeta(x.m);
      for (const [k, f] of fields) if (M[f] !== R[f]) add("problem", "Inconsistent {k} fields between {a} and {b}; \"{va}\" and \"{vb}\" respectively.", { k: trv(k), a: "[" + M.version + "]", b: "[" + R.version + "]", va: M[f], vb: R[f] });
      if (M.tags === R.tags) continue;
      const rt = R.tags.split(" "), ct = M.tags.split(" "), d = [...new Set([...rt.filter(t => !ct.includes(t)), ...ct.filter(t => !rt.includes(t))])].join(" ");
      if (d !== "") add("problem", "Inconsistent tags between {a} and {b}, difference being \"{d}\".", { a: M.version, b: R.version, d });
    }
  } },
  { cat: "Metadata", title: "Unicode in romanized fields.", run(ctx, add) {
    const uni = s => s.split("").filter(c => c.charCodeAt(0) > 127).join("");
    for (const x of mrMaps(ctx)) {
      const M = mrMeta(x.m);
      if (uni(M.version)) add("warning", "{k} field contains unicode characters,\"{v}\", those being \"{c}\". If the map can still be downloaded this is probably ok.", { k: trv("Difficulty name"), v: M.version, c: uni(M.version) });
      for (const [k, v] of [["Romanized title", M.title], ["Romanized artist", M.artist], ["Creator", M.creator]]) if (uni(v)) add("problem", "{k} field contains unicode characters,\"{v}\", those being \"{c}\".", { k: trv(k), v, c: uni(v) });
    }
  } },
  { cat: "Metadata", title: "Incorrect marker format.", run(ctx, add) {
    const ref = mrMaps(ctx)[0]; if (!ref) return;
    const M = mrMeta(ref.m), markers = [["vs.", /( vs\.?[^A-Za-z0-9])/i, /vs\./], ["CV:", /((\(| |（)cv(:|：)?[^A-Za-z0-9])/i, /CV(:|：)/], ["feat.", /((\(| |（)(ft|feat)\.?[^A-Za-z0-9])/i, /feat\./]];
    for (const [marker, approx, exact] of markers) for (const [type, field, v] of [["Romanized", "artist", M.artist], ["Unicode", "artist", M.artistUnicode], ["Romanized", "title", M.title], ["Unicode", "title", M.titleUnicode]])
      if (approx.test(v) && !exact.test(v)) add("problem", "Incorrect formatting of \"{marker}\" marker in {type} {field} field, \"{v}\".", { marker, type: trv(type), field: trv(field), v });
  } },
  { cat: "Metadata", title: "Incorrect marker spacing.", run(ctx, add) {
    const ref = mrMaps(ctx)[0]; if (!ref) return;
    const M = mrMeta(ref.m);
    for (const [field, v] of [["artist", M.artist], ["artist unicode", M.artistUnicode]]) {
      const seen = new Set();
      MR_SPACING.forEach((tests, i) => { for (const t of tests) { const what = t(v); if (what == null || seen.has(what)) continue; seen.add(what);
        if (i === 0) add("problem", "Missing {what} in {field}; \"{v}\".", { what: trv(what), field: trv(field), v }); else add("warning", "Missing {what} in {field}; \"{v}\".", { what: trv(what), field: trv(field), v }); } });
    }
  } },
  { cat: "Metadata", title: "Incorrect format of title version markers such as (TV Size), (Game Ver.), etc.", run(ctx, add) {
    const ref = mrMaps(ctx)[0]; if (!ref) return;
    for (const [lvl, msg, v] of mrTitleMarkers(mrMeta(ref.m))) add(lvl, msg, v);
  } },
  { cat: "Metadata", title: "Missing GDers in tags.", run(ctx, add) {
    // each "x's" / "xs'" in the difficulty name, split on , & | /: every word of it inside some tag of that difficulty, unless it's the creator
    const wrap = { "(": ")", "[": "]", "{": "}" }, count = (s, c) => s.split(c).length - 1;
    for (const x of mrMaps(ctx)) {
      const M = mrMeta(x.m), tags = M.tags.toLowerCase().split(" ");
      for (const part of M.version.split(/[,&|/]/)) {
        const mm = part.match(/(.+)(?:'s|(s)')/i); if (!mm) continue;
        let p = mm[1] + (mm[2] || "");
        while (p.length && wrap[p[0]] && count(M.version, p[0]) === count(M.version, wrap[p[0]])) p = p.slice(1); // (brackets around the whole name)
        p = p.trim(); if (!p) continue;
        const words = p.split(" "), tag = words.some(w => w.length === 1) ? words.join("_").toLowerCase() : p.toLowerCase();
        if (tag.split(" ").every(w => tags.some(t => t.includes(w.toLowerCase()))) || M.creator.toLowerCase() === p.toLowerCase()) continue;
        add("warning", "\"{d}\" is possessive but \"{u}\" isn't in the tags, ignore if not a user.", { d: M.version, u: tag });
      }
    }
  } },
  { cat: "Metadata", title: "Missing genre/language in tags.", run(ctx, add) {
    const ref = mrMaps(ctx)[0], tags = ref ? mrMeta(ref.m).tags.toLowerCase().split(" ") : [], has = w => tags.some(t => t.includes(w));
    const genres = [["video", "game"], ["anime"], ["rock"], ["pop"], ["novelty"], ["hip", "hop"], ["electronic"], ["metal"], ["classical"], ["folk"], ["jazz"]];
    // the website's languages, plus ones it files under "Other" (no point asking for a tag then)
    const langs = "english chinese french german italian japanese korean spanish swedish russian polish instrumental conlang hindi arabic portuguese turkish vietnamese persian indonesian ukrainian romanian dutch thai greek somali malay hungarian czech norwegian finnish danish latvia lithuanian estonian punjabi bengali".split(" ");
    if (!ctx.maps.length) return;
    if (!genres.some(g => g.every(has))) add("warning", "Missing genre tag (\"rock\", \"pop\", \"electronic\", etc), ignore if none fit.");
    if (!langs.some(has)) add("warning", "Missing language tag (\"english\", \"japanese\", \"instrumental\", etc), ignore if none fit.");
  } },
  { cat: "Skinning", title: "Incomplete or incorrect skin element sets.", run(ctx, add) {
    const F = mrFiles(), paths = Object.keys(F).map(k => ({ k, n: String(F[k].name || k).split(/[\\/]/).pop() })), std = ctx.maps.filter(x => !(x.m.mode | 0));
    const has = { slider: std.some(x => x.m.hit.some(o => o.kind === "slider")), repeat: std.some(x => x.m.hit.some(o => o.kind === "slider" && o.slides > 1)) };
    const used = e => !e[2] || has[e[2]], present = p => paths.find(f => mrSkinMatch(f.n, p)), exact = n => paths.find(f => mrIeq(f.n, n));
    const relevant = els => els.some(e => used(e) && present(e[0]));
    for (const [set, els] of MR_SKIN) { // (anywhere in the folder: only the file name counts)
      if (!relevant(els)) continue;
      const miss = els.filter(e => e[1] && used(e) && !present(e[0]));
      if (miss.length) add("problem", "The \"{set}\" skin set is only partially skinned, missing: {list}.", { set, list: miss.map(e => e[0]).join(", ") });
      for (const e of els) { const f = present(e[0]); if (f && !/\.png$/i.test(f.n)) add("warning", "\"{f}\" should be a .png file if it uses transparency.", { f: f.n }); }
    }
    if (std.some(x => x.m.hit.some(o => o.kind === "spinner"))) {
      const so = exact("spinner-osu.png"); if (so) add("warning", "\"{f}\" only displays for players using skin version 1.0, which is extremely rare; consider removing it.", { f: so.n });
      const OLD = ["spinner-background.png", "spinner-circle.png", "spinner-metre.png"], NEW = ["spinner-bottom.png", "spinner-glow.png", "spinner-middle.png", "spinner-middle2.png", "spinner-top.png"];
      const o = OLD.map(exact).find(Boolean), nw = NEW.map(exact).find(Boolean);
      if (o && nw) add("problem", "Both old (\"{a}\") and new (\"{b}\") spinner style elements are present; the old style will take priority.", { a: o.n, b: nw.n });
      else {
        if (nw) add("warning", "\"{f}\": usage of the new style spinner is discouraged; it only displays correctly if the player's \"Preferred Skin\" is set to Default.", { f: nw.n });
        const miss = o || nw ? [...(o ? OLD : NEW), "spinner-approachcircle.png", "spinner-clear.png", "spinner-spin.png"].filter(n => !exact(n)) : [];
        if (miss.length) add("problem", "The \"{set}\" skin set is only partially skinned, missing: {list}.", { set: "Spinner", list: miss.join(", ") });
      }
    }
    for (const [a, b] of [["hit100-{n}.png", "hit100k-{n}.png"], ["hit300-{n}.png", "hit300g-{n}.png"], ["hit300-{n}.png", "hit300k-{n}.png"]]) { // (byte for byte the same file)
      const fa = present(a), fb = present(b); if (!fa || !fb) continue;
      const sz = f => F[f.k]._data && F[f.k]._data.uncompressedSize; if (sz(fa) != null && sz(fb) != null && sz(fa) !== sz(fb)) continue;
      const ba = mrBytes(F[fa.k]), bb = mrBytes(F[fb.k]); if (!ba || !bb) continue; // (still being read)
      if (ba.length === bb.length && ba.every((v, i) => v === bb[i])) add("problem", "\"{a}\" and \"{b}\" are identical; hit100/hit300 hitbursts must be visually distinguishable from their geki/katu counterparts.", { a: fa.n, b: fb.n });
    }
    if (!relevant(MR_SKIN[2][1]) && !relevant(MR_SKIN[3][1])) return;
    for (const x of mrMaps(ctx).filter(x => !(x.m.mode | 0))) {
      const kv = x.m.colourKV || {}, col = k => { const f = Object.keys(kv).find(c => c.startsWith(k)); if (f == null) return null; const p = String(kv[f]).split(","); return [0, 1, 2].map(i => parseFloat(p[i])); };
      const d = mrMeta(x.m).version, br = col("SliderBorder"), tk = col("SliderTrackOverride");
      if (!br) { add("problem", "{d} skins hitcircle or slider elements but does not define a custom slider border colour (SliderBorder under [Colours]).", { d }); continue; }
      if (tk && Math.hypot(tk[0] - br[0], tk[1] - br[1], tk[2] - br[2]) < 30) add("problem", "{d}'s slider body colour (SliderTrackOverride) is too similar to its slider border colour (SliderBorder).", { d });
    }
  } },
  { cat: "Settings", title: "Inconsistent mapset id, countdown, epilepsy warning, etc.", run(ctx, add) { // MV CheckInconsistentSettings
    // every ordered pair of difficulties, so each difference shows once from either side, like MV
    const maps = mvSorted(ctx.maps), osb = mvOsb(ctx) != null, cdMemo = new Map(), tf = b => b ? "True" : "False", flag = (m, k) => tf(mvGen(m, k) === "1");
    const cd = m => { if (!cdMemo.has(m)) cdMemo.set(m, mvCountdownStart(m)); return cdMemo.get(m); };
    const cdName = m => { const v = mvInt(mvGen(m, "Countdown") ?? "0"); return ["None", "Normal", "Half", "Double"][v] ?? String(v); };
    const setId = m => { const s = String(mvKey(m.meta, "BeatmapSetID") ?? "").trim(); if (!/^[+-]?\d+$/.test(s)) return "-1"; const n = BigInt(s); return n <= 0n || n > 9223372036854775807n ? "-1" : n.toString(); }; // (unsubmitted: -1)
    const same = (a, b) => a.mode === b.mode, cdMode = (a, b) => same(a, b) && a.mode !== 1 && a.mode !== 3; // (countdown does nothing in taiko and mania)
    const ev = new Map(maps.map(({ m }) => [m, { sb: mvDiffSb(m), Break: mvEvents(m.eventsRaw, ["Break", "2"]).length, Video: mvEvents(m.eventsRaw, ["Video", "1"]).length }])); // (read once per difficulty)
    const sb = (a, b) => (ev.get(a).sb && ev.get(b).sb) || osb, n = (m, t) => ev.get(m)[t[0]];
    const rows = [
      ["problem", "beatmapset id", setId],
      ["warning", "countdown speed", cdName, (a, b) => cdMode(a, b) && cd(a) >= 0 && cd(b) >= 0],
      ["warning", "countdown offset", m => String(mvInt(mvGen(m, "CountdownOffset") ?? "0")), (a, b) => cdMode(a, b) && cd(a) >= 0 && cd(b) >= 0],
      ["warning", "countdown", cdName, (a, b) => cdMode(a, b) && (cd(a) >= 0) !== (cd(b) >= 0)],
      ["warning", "letterbox", m => flag(m, "LetterboxInBreaks"), (a, b) => same(a, b) && n(a, ["Break", "2"]) > 0 && n(b, ["Break", "2"]) > 0],
      ["warning", "widescreen support", m => flag(m, "WidescreenStoryboard"), sb],
      ["warning", "storyboard in front of combo fire", m => flag(m, "StoryFireInFront"), sb],
      ["warning", "usage of skin sprites in storyboard", m => flag(m, "UseSkinSprites"), sb],
      ["warning", "difficulty-specific storyboard presence", m => tf(ev.get(m).sb)],
      ["warning", "epilepsy warning", m => flag(m, "EpilepsyWarning"), (a, b) => sb(a, b) || (n(a, ["Video", "1"]) > 0 && n(b, ["Video", "1"]) > 0)],
      ["warning", "audio lead-in", m => fstr(parseFloat(mvGen(m, "AudioLeadIn") ?? "0") || 0)],
      ["warning", "skin preference", m => mvGen(m, "SkinPreference") ?? ""],
      ["minor", "slider tick rate", m => fstr(mvDiff(m, "SliderTickRate")), same],
    ];
    for (const x of maps) for (const y of maps) for (const [lvl, setting, val, cond] of rows) {
      if (cond && !cond(x.m, y.m)) continue;
      const a = val(x.m), b = val(y.m);
      if (a !== b) add(lvl, "[{d}] Inconsistent {setting} \"{value}\", see [{other}] \"{otherValue}\".", { d: x.m.meta.Version || "", setting: trv(setting), value: a, other: y.m.meta.Version || "", otherValue: b });
    }
  } },
  { cat: "Timing", title: "Inconsistent uninherited lines, meter signatures, or BPM.", run(ctx, add) {
    // as MapsetVerifier (CheckInconsistentLines): every difficulty against the set's first, and the first against each
    const maps = mrMaps(ctx), ref = maps[0]; if (!ref) return;
    const reds = m => m.timing.filter(x => x.uninherited), at = (L, t) => L.find(q => Math.abs(q.time - t) < .001);
    const bpm = l => String(60000 / l.beat), meter = l => (l.meter || 4) + "/4", nm = x => "[" + (x.m.meta.Version || "") + "]", R = reds(ref.m);
    for (const x of maps) {
      const X = reds(x.m), d = x.m.meta.Version || "";
      for (const l of R) {
        const o = at(X, l.time);
        if (!o) { add("problem", "[{d}] Missing uninherited line, see {r} ({bpm}, {meter}).", { d, r: nm(ref), bpm: bpm(l), meter: meter(l) }, null, l.time); continue; }
        if ((o.meter || 4) !== (l.meter || 4)) add("problem", "[{d}] Inconsistent meter signature ({m}), see {r} ({rm}).", { d, m: meter(o), r: nm(ref), rm: meter(l) }, null, l.time);
        if (Math.abs(l.beat - o.beat) > .001) add("problem", "[{d}] Inconsistent BPM ({b}), see {r} ({rb}).", { d, b: bpm(o), r: nm(ref), rb: bpm(l) }, null, l.time);
      }
      for (const l of X) if (!at(R, l.time)) add("problem", "[{d}] Missing uninherited line, see {r} ({bpm}, {meter}).", { d: ref.m.meta.Version || "", r: nm(x), bpm: bpm(l), meter: meter(l) }, null, l.time);
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
        add("minor", "[{a}] {ta} (1/{da}) Different snapping, {tb} (1/{db}), is used in {b}. Ensure this makes sense.", { a: x.m.meta.Version, da, ta: mvTime(t) + " -", b: "[" + (y.m.meta.Version || "") + "]", db, tb: mvTime(ot) + " -" }, null, t);
      }
    }
  } },
  { cat: "Hit sounds", title: "Inconsistent hit sounds between difficulties.", run(ctx, add) {
    const std = mrMaps(ctx).filter(x => !x.m.mode); if (std.length < 2) return; // (MapsetVerifier's order of the difficulties)
    const names = { 2: "Whistle", 4: "Finish", 8: "Clap" }; // (MV's HitSounds names)
    // as MapsetVerifier: a slider's end at its EndTime (the exact end moved by its unsnap), and the event found in the
    // other difficulty is the first one in object order within 2 ms
    const events = x => { const end = new Map(mvMap(x.m).objs.map(mo => [mo.o, mo.endTime]));
      return x.m.hit.flatMap(o => o.kind === "circle" ? [{ t: o.t, hs: o.hs }] : o.kind === "slider" ? [{ t: o.t, hs: vEdgeHs(o, 0) }, { t: end.get(o) ?? o.end, hs: vEdgeHs(o, o.slides) }] : [{ t: end.get(o) ?? o.end, hs: o.hs }]); };
    const ev = new Map(std.map(x => [x, events(x)])), idx = new Map();
    for (const [x, L] of ev) { const B = new Map(); L.forEach((e, i) => { e.i = i; const k = Math.floor(e.t / 2); if (!B.has(k)) B.set(k, []); B.get(k).push(e); }); idx.set(L, B); }
    const find = (L, t) => { const B = idx.get(L); let best = null; for (let k = Math.floor((t - 2) / 2); k <= Math.floor((t + 2) / 2); k++) for (const e of B.get(k) || []) if (Math.abs(e.t - t) < 2 && (!best || e.i < best.i)) best = e; return best; };
    // a difficulty with its own hit sounding (e.g. a guest difficulty) is left out of the comparison
    const incons = new Map(std.map(x => { let c = 0; for (const e of ev.get(x)) for (const y of std) if (y !== x) { const f = find(ev.get(y), e.t); (e.at || (e.at = new Map())).set(y, f); if (f && f.hs !== e.hs) c++; } return [x, std.length > 1 ? Math.floor(c / (std.length - 1)) : c]; }));
    const vals = [...incons.values()], minI = Math.min(...vals), avgI = vals.reduce((a, b) => a + b, 0) / vals.length;
    const unique = std.filter(x => ev.get(x).length >= 8 && Math.max(incons.get(x) - minI, 0) > avgI && incons.get(x) - minI > ev.get(x).length / 4), comp = std.filter(x => !unique.includes(x));
    for (const x of unique) add("warning", "[{d}] This difficulty appears to have its own hit sounding, so it was excluded from the consistency comparison. Make sure this makes sense.", { d: x.m.meta.Version });
    for (const x of comp) {
      const others = comp.filter(y => y !== x);
      for (const e of ev.get(x)) {
        const miss = new Set(), with_ = [];
        for (const y of others) { const f = e.at.get(y); if (!f) continue; /* (looked up in the pass above) */ const m2 = [2, 4, 8].filter(b => !(e.hs & b) && (f.hs & b)); if (!m2.length) continue; m2.forEach(b => miss.add(names[b])); with_.push(y.m.meta.Version || ""); }
        if (!miss.size) continue;
        add(with_.length * 2 > others.length ? "warning" : "minor", "[{d}] is missing ({hs}) which exists in {others}.", { d: x.m.meta.Version, hs: [...miss].join(", "), others: [...new Set(with_)].join(", ") }, null, e.t);
      }
    }
    for (const x of std) for (const o of x.m.hit) if (o.kind === "slider" && o.hs > 1) add("minor", "[{d}] This sliderbody has additions, ensure this is intentional.", { d: x.m.meta.Version }, o);
  } },
  { cat: "Spread", title: "Lowest difficulty too difficult for the given drain time(s).", run(ctx, add) { // MV CheckLowestDiff (osu!standard)
    // the lowest is the first in MV's order (level, then star rating); every difficulty's drain time is held against it
    const std = mvSorted(ctx.maps.filter(x => !x.m.mode)); if (!std.length) return;
    const low = std[0], TH = [150000, 195000, 240000], BAN = [[2], [3], [4, 5]]; // Hard 2:30, Insane 3:15, Expert/Ultra 4:00
    for (const x of std) {
      const d = mvDrain(x.m), band = TH.findIndex(t => d < t); if (band < 0) continue;
      for (let i = band; i < TH.length; i++) if (BAN[i].includes(low.lvl))
        add("problem", "[{d}] With a lowest difficulty {lowest}, the drain time of [{map}] must be at least {need} -, currently {current} -.", { d: low.m.meta.Version || "", lowest: trv(LEVELS[BAN[i][0]]), map: x.m.meta.Version || "", need: mvTime(TH[i]), current: mvTime(d) });
    }
  } },
  { cat: "Events", title: "Storyboarded hit sounds.", run(ctx, add) { // MV CheckStoryHitSounds: each Sample event in each .osu, and the .osb's for every difficulty
    const osb = mvOsb(ctx), fromOsb = osb != null ? mvSamples(mvOsbEvents(osb)) : [];
    for (const x of mvSorted(ctx.maps)) {
      const one = (s, origin) => add("warning", "[{d}] Storyboarded hit sound ({path}, {volume}%) from {origin} file.", { d: x.m.meta.Version || "", path: s.path, volume: s.volume, origin }, null, isFinite(s.time) ? Math.trunc(s.time) : null);
      for (const s of mvSamples(String(x.m.eventsRaw || "").split("\n"))) one(s, ".osu");
      for (const s of fromOsb) one(s, ".osb");
    }
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
  const maps = allMaps(), ctx = { hasEasy: maps.some(x => !x.m.mode && x.lvl === 0), maps };
  const run = (checks, arg, lvl) => checks.filter(c => !c.lv || c.lv.includes(lvl)).map(c => {
    const issues = [];
    const add = (lvl, msg, v = {}, objs = null, t = null) => { objs = objs && [].concat(objs); issues.push({ lvl, msg, v, objs, t: t ?? (objs ? objs[0].t : null) }); };
    try { c.run(arg, add, lvl, ctx); } catch (e) { issues.push({ lvl: "minor", msg: "This check failed to run: {err}", v: { err: e.message } }); }
    return { c, issues };
  });
  const sprites = sb.length ? sb : [];
  const general = run(SET_CHECKS, { maps, audio: songMeta, audioName: map ? map.general.AudioFilename : "", sprites, ...vfyMvCtx(maps) }); // (vfyMvCtx: the package as MapsetVerifier reads it)
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
