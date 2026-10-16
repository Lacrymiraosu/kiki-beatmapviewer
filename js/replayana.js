"use strict";
// Parts follow ppy/osu (lazer's judgement and tracking rules; MIT, Copyright (c) ppy Pty Ltd): see THIRD_PARTY_NOTICES.txt
// ============ Replay analysis: timing, aim, cursor and keys of one replay on its own difficulty ============
// Pure functions, no DOM and no network (loaded lazily by loadLazy("replayana"); needs nothing else at load time, uses
// replayMods / replayDiff from js/replay.js when they are there). Everything here is an ESTIMATE made from the replay's inputs
// and the map: the site does not run the game's judgement, and the replay's own counts stay the truth for the score.
//
// Surface (everything else in this file is internal):
//   rpAnalyze(data, map, mods?, opts?) -> Analysis   data = parseOsr(...) result, map = parseOsu(...) result (not changed),
//        mods = replayMods(...) result (null: made from data.mods), opts = { md5?: md5Hex of the .osu file's raw bytes (a
//        different one than data.mapMd5 adds the warning "md5_mismatch"; map.md5 is used when opts has none) }.
//        Never throws: anything odd gives { ok: false, warn: [code] } (or ok: true with warnings when the rest still makes sense).
//   rpAnalyzeAt(a, t) -> index in a.hits of the object nearest to song time t (-1 when there is none)
//   rpAnaWindows(od) -> { w300, w100, w50 }: osu!'s half-windows in ms (80 - 6 OD, 140 - 8 OD, 200 - 10 OD)
//   rpAnaLit(k) -> lit mask of a frame's key bits (bit 0 K1, 1 K2, 2 M1, 3 M2), the same rule as the key overlay (player.js rpLit)
//   rpHitState(e, t, windows) -> the hit effects of one a.hits entry at song time t (player.js: the replay's real hits; see the end of the file)
//   rpSliderState(e, t) / rpSpinState(e, t) -> what one a.sliders / a.spinners entry shows at song time t (see SLIDERS AND SPINNERS)
//
// Analysis = {
//   ok, warn: string[]   ("no_data", "no_frames", "no_map", "no_objects", "few_objects" (< 10), "mode" (not osu!standard),
//                         "md5_mismatch", "short_replay" (objects after the replay's last frame, counted as misses), "error")
//   windows: { w300, w100, w50 } (ms, the formula's values), judge: { w300, w100, w50 } (what is really compared: floor(w) - 0.5),
//   od, cs, ar, radius (osu!px), preempt (ms), rate, hr,
//   hits: [{ i (index in map.hit), t, x, y (object centre as drawn, see HR below), press (ms | null), err (press - t, + = late | null),
//            dx, dy (cursor - centre at the press, osu!px, + = right / down | null), judge (300 | 100 | 50 | 0 = miss),
//            key ("K1" | "K2" | "M1" | "M2" | null), slider (bool), jt (song ms the judgement happened: the press for a hit, t + w50 for a miss, or, lazer, the press that
//            judged the miss: its own press too early, or a later object's hit, see JUDGEMENT: LAZER) }]   one per circle and slider head, in map order
//   empty: [{ t, x, y, why }]   presses that hit nothing (why: "aim" = in the window of the next object but off it,
//            "lock" = on a later object while an earlier one could still be hit (notelock), "early" = on the next object but before
//            its window, "none" = nothing to hit). Presses while a slider or spinner is going on are not here (stats.body).
//   stats: { n (judged objects), hit, est: {n300, n100, n50, miss} (circles by their a.hits judge, sliders by their real a.sliders result: 300 / 100 / 50 / 0
//            counted as n300 / n100 / n50 / miss; a slider with no a.sliders entry counts by its head only, 300 when hit, else a miss), mean, median, sd (song ms), ur (10 sd / rate, like lazer),
//            urSong (10 sd), early, late (hits before / after the object time), meanDx, meanDy, meanDist, maxDist, sdDist,
//            presses, empty, body, lock, aim, earlyNear (presses on the next object 400 ms .. the 50 window early: lazer would
//            count those as misses, stable ignores them; see JUDGEMENT), spinners }   (null where there is nothing to average)
//   keys: { counts: {K1, K2, M1, M2}, presses, intervals: Float32Array (ms between consecutive presses of any key, song time,
//           0 < interval <= 1000), maxBpm (fastest 8 presses in a row), avgBpm (median interval) as 1/4 notes in REAL time
//           (rate applied: DT 1.5 makes it faster), altRatio (share of presses on another key than the press before) }
//   cursor: { grid: { w: 64, h: 48, cell: 8, data: Float32Array (time per cell / max, 0..1), max (ms in the hottest cell),
//             total (ms in the grid: the mass) }, speed: [{ t, v }] (osu!px per song ms, <= 600 points), vMax,
//             distance (osu!px), jumpMax (osu!px between the cursor at two hits in a row), jumpAt (ms), span: [from, to] }
//   sliders, spinners: what the replay really did on sliders and spinners, extra to the above (see SLIDERS AND SPINNERS; [] when there are none)
//   combo: { max (the longest run), breaks: [{ t (song ms the break is judged), combo (the combo just before it, 0 for a break right after another) }],
//            at: { t: Float64Array, v: Int32Array } (the combo over time: one entry per combo event, i.e. every judged event that adds a point or breaks, in the same order as the
//            breaks (judged time, ties in map order); v = the combo AFTER that event, 0 at a break; a missed slider tail has no entry) } (see COMBO and rpComboAt;
//            { max: 0, breaks: [] }, no at, when it cannot be made)
//   consistency: { header: {n300, n100, n50, miss}, est: {...} (stats.est + every spinner by its a.spinners result, a spinner with none as 300), d300 (est - header), diff
//                  (half the sum of |est - header| over the four counts: objects judged differently, at least), quality:
//                  "good" (diff <= max(2, 0.5 % of the objects)) | "fair" (<= max(5, 3 %)) | "poor", rules: "stable" | "lazer" (the judgement used, see JUDGEMENT),
//                  parts?: { header: {tickHit, tickMiss, tailHit} (lazer's statistics large_tick_hit / large_tick_miss / slider_tail_hit), est: {...} (the same from a.sliders) }
//                  (only when the replay has lazer statistics: a second check, not part of the quality) }
//   (est for lazer rules: circles and slider HEADS by their timing (|err| against judge: lazer's great / ok / meh / miss count heads, the slider itself is
//    IgnoreHit / IgnoreMiss), spinners by their result; for stable rules sliders by their whole result as above)
// }
//
// SLIDERS AND SPINNERS (extra output, a.sliders / a.spinners; [] whenever ok is true and there are none; a.hits stays as it is):
//   a.sliders: [{ i (index in map.hit), t, end (song ms), track: [[from, to], ...] (song-ms intervals, merged, sorted, clipped to [t, end],
//                 where the follow circle is really followed: a key held and the cursor in the follow area), parts: [{ t, kind: "tick" |
//                 "repeat" | "tail", hit }] (every tick, repeat and the tail, in time order; t = when osu! judges it: the part's own time,
//                 the tail's when it is hit (first tracking frame from end - 36 on) or at the end when missed, or later when the head is judged later), head (the head was hit: the a.hits entry), brk (time of
//                 the first break: the first missed part after the player was following (head hit or an earlier part hit); a missed head
//                 alone is no break; null when none), judge (300 | 100 | 50 | 0) }]
//   a.spinners: [{ i, t, end, need (full rotations to clear), rot: { t: Float64Array, v: Float32Array } (rotations so far at t, at every
//                 frame inside (t, end) and at end; the first sample is v = 0 at t), cleared, clearAt (ms | null), judge }]
//   rpSliderState(e, t) -> { phase: "pending" | "active" | "done", tracking, since (ms since tracking last started, -1 when not tracking),
//        brkAge (ms since e.brk, -1: none / not yet), parts (parts with time <= t), partsHit (of those, hit), lastPart: { kind, hit, age } | null }
//   rpSpinState(e, t) -> { phase, rot (rotations so far, interpolated), prog (rot / need, 0..1), clear (need reached at or before t), clearAge (-1: not yet) }
//   Both are stateless (a seek either way is right), null for no entry / an odd one / a non finite t, and never throw.
//   Rules, all from osu!lazer (github.com/ppy/osu, read on 2026-10-11) except where it says unverified; the replay's frames are sampled
//   as they come (the state of a frame holds until the next frame, the ball is taken at the frame's time):
//   - Tracking (osu.Game.Rulesets.Osu/Objects/Drawables/SliderInputManager.cs): on a frame, tracking needs a key (K1 / M1 = left, K2 / M2 =
//     right: osu.Game/Replays/Legacy/LegacyReplayFrame.cs MouseLeft = Left1 || Left2, OsuReplayFrame.cs FromLegacy) and the cursor inside the ball's
//     area: the circle radius while not tracking yet, 2.4 x radius while tracking (DrawableSliderBall.FOLLOW_AREA). After a hit
//     head only the head's key counts until the other key was up in the frame before (timeToAcceptAnyKeyAfter). A head hit late or early
//     inside 2.4 x radius of the ball starts tracking at the press (PostProcessHeadJudgement), and the parts already passed are all hit when
//     the cursor is inside 2.4 x radius of each of them, else all missed.
//   - Parts: judged only once the head is judged (a hit's press, a miss's end of the w50 window: same as rpHitState), ticks and repeats at their
//     time (SliderInputManager.TryJudgeNestedObject: offset >= 0), the tail from end - 36 on (SliderEventGenerator.TAIL_LENIENCY = -36, the lazer
//     rule; stable's differs and is not used): hit on the first tracking frame from there, missed (at the end) when there is none; never before
//     the part before it. A tick or repeat is hit when tracking at its time, else missed. Tick times are
//     parse.js's o.ticks (same spacing as SliderEventGenerator), repeats at t + k x span.
//   - A replay that ends before a part is judged misses it.
//   - Result (DrawableSlider.CheckForResult, ClassicSliderBehaviour = the stable scoring): over head + ticks + repeats + tail: all hit 300,
//     none 0, else 100 when at least half were hit, 50 below.
//   - Spinner (Spinner.cs, DrawableSpinner.cs, SpinnerRotationTracker.cs, SpinnerSpinHistory.cs): need = (int)(rps x seconds + 0.0001) with
//     rps = DifficultyRange(OD, 90, 150, 225) / 60 (clear RPM); rotation counts while a key is down inside [t, end): the cursor's angle
//     around (256, 192), the frame to frame change normalised to -180..180 (that is the per-frame cap) times the rate (|rate|, DT counts
//     more), kept as lazer's SpinnerSpinHistory does (a spin counts once its max rotation reaches 360 in one direction; turning back
//     does not add). Result: progress >= 1 300, > 0.9 100, > 0.75 50, else 0 (progress = rotation / 360 / need; need 0 clears at once).
//
// COMBO (a.combo; the rules and their osu!lazer sources are next to rpaCombo): a function of the judged events sorted by the time they are judged. A circle, slider head, tick, repeat or
//   spinner (cleared at least 3/4) that is hit is +1, a circle / head / tick / repeat / spinner that is missed breaks; the slider tail is +1 when hit and, when MISSED, gives no point and does not
//   break. Heads and circles that are missed are judged at their jt (t + w50, or the press that judged them, lazer), a hit at its press, a part at its a.sliders time (never before its
//   head), a spinner at its end. a.combo.max is the longest run.
//   rpComboAt(a, t) -> { combo, since } | null: the combo at song time t, stateless (a seek gives the same numbers), from a.combo.at by binary search. combo = the value after the last event with
//     time <= t (0 before the first); since = ms from the last event that INCREASED the combo (time <= t) to t, -1 when there is none yet. null for an odd input (no a, no a.combo.at, a
//     non-finite t), never throws. The object is SHARED and rewritten by the next call (no allocation per frame): read it at once.
//   rpAnaPoor(a) -> true when a.consistency.quality is "poor" AND the header counts (n300 + n100 + n50 + miss) are above 0: the analysis disagrees with the replay's own counts, so
//     what it says (combo, sounds) is not trusted (js/audio.js soundList uses the same guard). All-zero counts (a header without them) are no evidence, so not poor.
//
// JUDGEMENT (osu!stable's rules as far as the inputs show them):
// - Difficulty: CS / AR / OD of the map after EZ (x0.5) / HR (x1.3 CS, x1.4 AR and OD, capped at 10) via replayDiff. The rate
//   (DT / HT) does not change them: all times here are song (map) ms. Radius = parse.js diffDerived's formula on that CS.
// - Presses: a rising edge of a key's lit state (rpAnaLit: osu!stable stores K1 as 4|1 and K2 as 8|2, so K1 / K2 are bits 4 / 8
//   and M1 / M2 count only without their K bit). Two keys going down in the same frame are two presses at the same time
//   (handled K1, K2, M1, M2). The cursor of a press is that frame's own position.
// - Windows: a press at err = press - t can hit the object when |err| <= floor(w50) - 0.5 (stable's integer windows; the
//   same as lazer's legacy-matching floor(w) - 0.5); 300 when |err| <= floor(w300) - 0.5, 100 the same with w100, else 50.
// - Notelock (stable): objects are hit in order. A press only ever looks at the EARLIEST object not judged yet (plus objects at
//   exactly the same time, which stable lets you hit in any order). Objects whose window has passed are misses first.
//   In that object's window with the cursor within the radius: hit. In the window but off it: the press is used up and hits
//   nothing ("lock" when the cursor is on a later object, which shakes in the game, else "aim"); it NEVER falls through to a
//   later object while the earlier one can still be hit. Before the window: nothing ("early" when on the object). This is the
//   classic stable note lock (lazer's LegacyHitPolicy). Lazer replays have their own rule (LAZER below) unless their Classic mod keeps this one.
// - Sliders: the head is judged like a circle for timing and aim (err / dx / dy), but is 300 in a.hits when it is hit (stable's slider
//   result comes from the head, ticks and end, not the head's timing) and 0 when not: a.hits does not check ticks and the follow circle
//   (the hit effects and sounds read it). The estimate (stats.est, consistency.est) counts each slider by its real a.sliders result
//   instead (head, ticks, repeats and tail: 300 / 100 / 50 / 0; e.g. a missed head that is then followed is a 100), and each spinner
//   by its a.spinners result; only an object with no such entry (an analysis without them) keeps the old rule: a slider by its head (300
//   hit, else a miss), a spinner as 300 (assumed cleared). Spinners are skipped for timing and aim.
// - Positions: the stacked position of each object. HR: the game flips the map, then stacks (up-left on screen); the map here
//   is drawn unflipped with the cursor mirrored (rpCursorAt: y -> 384 - y), so a stacked object sits at (rx - s, ry + s) in
//   this frame (s = stack height x radius / 10), not at parse.js's (rx - s, ry - s). Stack heights are parse.js's (map's own
//   AR / CS; not redone for HR / EZ).
// - LAZER (a lazer replay, data.lazer, without the Classic mod's classic_note_lock: rpaRules; osu!lazer master read on 2026-10-14, osu.Game.Rulesets.Osu/UI/
//   StartTimeOrderedHitPolicy.cs, Objects/Drawables/DrawableHitCircle.cs (HitReceptor, CheckForResult), Scoring/OsuHitWindows.cs (MISS_WINDOW 400)). Checked on a real
//   lazer replay (1279 circles, 610 sliders, 119 misses): with this rule its great / ok / meh / miss come out exactly as lazer's own counts; with the stable rule above
//   they were 316 misses for 119 (227 presses "locked" that lazer let through):
//   - a press goes to the EARLIEST circle / head not judged yet that is on screen (from t - preempt) and under the cursor; nothing under it: the press does nothing
//     (an empty press "aim" when the earliest object left is in its window, else "none"; during a slider or spinner "body").
//   - blocked ("lock", it shakes, the press is used up) while the circle / head just before it in time (start time earlier) is not judged yet and the press is
//     before that one's time; more than 400 ms early: nothing ("early", HitResult.None, used up too).
//   - else judged by |err| (300 / 100 / 50 as above, up to 400 ms early a miss: stats.earlyNear counts those), and every earlier circle / head not judged yet is
//     missed at that press (HandleHit). Objects whose window has passed are misses at t + w50 as before.
//   - slider heads are judged by timing (est, see consistency); the first press that reached a head, even one that only shook it, sets the key tracking takes at
//     first (HitReceptor HitAction); the slider's parts wait for the head's judgement, a miss too (TryJudgeNestedObject: HeadCircle.Judged), and are sampled at
//     their own time with the cursor interpolated between the two frames around it (lazer moves it so between replay frames: OsuFramedReplayInputHandler).
//   Remaining gap on that replay: tails hit 559 for lazer's 558, ticks 161 / 4 for 162 / 3, combo breaks 123 for 122, max combo 223 for 222: follow-circle
//   cases within a pixel of the edge, which a ~60 fps recording cannot settle (the game judged them live, between the recorded frames).
// - Cursor heat: each frame's time (up to the next frame, capped at 500 ms per frame for pauses and gaps) goes to the cell under
//   it (off the playfield: the nearest edge cell), during the play span (first object - preempt .. last object end + 200 ms; the
//   whole replay when the map has no objects).

const RPA_W = 64, RPA_H = 48, RPA_CELL = 8, RPA_GAP = 500, RPA_SPEED_N = 600, RPA_EARLY = 400, RPA_IV_MAX = 1000, RPA_BPM_RUN = 8;
const RPA_KEYS = ["K1", "K2", "M1", "M2"];

const rpAnaLit = k => (k & 4 ? 1 : 0) | (k & 8 ? 2 : 0) | (k & 5 && !(k & 4) ? 4 : 0) | (k & 10 && !(k & 8) ? 8 : 0);
function rpAnaWindows(od) { od = Number.isFinite(+od) ? +od : 5; return { w300: 80 - 6 * od, w100: 140 - 8 * od, w50: 200 - 10 * od }; }

function rpaFail(code, warn) { warn.push(code); return { ok: false, warn }; }
function rpaNum(v, d) { v = Number(v); return Number.isFinite(v) ? v : d; }
// difficulty after EZ / HR (replayDiff when replay.js is loaded; the same rule otherwise)
function rpaDiff(map, mods) {
  const d = map.diff || {}, raw = { CircleSize: rpaNum(d.CircleSize, 5), ApproachRate: rpaNum(d.ApproachRate ?? d.OverallDifficulty, 5), OverallDifficulty: rpaNum(d.OverallDifficulty, 5), HPDrainRate: rpaNum(d.HPDrainRate, 5) };
  if (typeof replayDiff === "function") return replayDiff(raw, mods);
  let cs = raw.CircleSize, ar = raw.ApproachRate, od = raw.OverallDifficulty, hp = raw.HPDrainRate;
  if (mods.ez) { cs *= .5; ar *= .5; od *= .5; hp *= .5; }
  if (mods.hr) { cs = Math.min(10, cs * 1.3); ar = Math.min(10, ar * 1.4); od = Math.min(10, od * 1.4); hp = Math.min(10, hp * 1.4); }
  return { cs, ar, od, hp };
}
// header counts (lazer: its statistics when present, like the results screen)
function rpaHeader(data) {
  const c = data.counts || {}, s = data.lazerInfo && data.lazerInfo.statistics;
  if (s && typeof s === "object" && ["great", "ok", "meh", "miss"].some(k => typeof s[k] === "number"))
    return { n300: s.great | 0, n100: s.ok | 0, n50: s.meh | 0, miss: s.miss | 0 };
  return { n300: c.n300 | 0, n100: c.n100 | 0, n50: c.n50 | 0, miss: c.miss | 0 };
}
// the judgement rules the replay was played with (see JUDGEMENT): osu!lazer's own for a lazer replay (data.lazer: format 30000000 on), unless its Classic mod (CL)
// turns them back (its settings classic_note_lock / no_slider_head_accuracy, both on by default: osu.Game.Rulesets.Osu/Mods/OsuModClassic.cs). lock: lazer's note lock
// (StartTimeOrderedHitPolicy); headAcc: slider heads judged by their timing (great / ok / meh / miss, as lazer's counts have them)
function rpaRules(data) {
  if (!data || !data.lazer) return { lazer: false, lock: false, headAcc: false };
  const jm = data.lazerInfo && Array.isArray(data.lazerInfo.mods) ? data.lazerInfo.mods : [], cl = jm.find(j => j && j.acronym === "CL"), st = (cl && cl.settings) || {};
  return { lazer: true, lock: !(cl && st.classic_note_lock !== false), headAcc: !(cl && st.no_slider_head_accuracy !== false) };
}
function rpaMedian(a, n) { if (!n) return null; const s = Float64Array.prototype.slice.call(a, 0, n).sort(); return n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; }

function rpAnalyze(data, map, mods, opts) {
  const warn = [];
  try {
    if (!data || typeof data !== "object") return rpaFail("no_data", warn);
    const F = data.frames;
    if (!F || !(F.n > 0) || !F.t || !F.x || !F.y || !F.k || !(Math.min(F.t.length, F.x.length, F.y.length, F.k.length) > 0)) return rpaFail("no_frames", warn);
    if (!map || !Array.isArray(map.hit)) return rpaFail("no_map", warn);
    if (!mods) mods = typeof replayMods === "function" ? replayMods(data.mods, data.lazerInfo) : { rate: 1, hr: false, ez: false };
    const md5 = (opts && opts.md5) || map.md5;
    if (md5 && data.mapMd5 && String(md5).toLowerCase() !== String(data.mapMd5).toLowerCase()) warn.push("md5_mismatch");
    if ((data.mode | 0) !== 0 || (map.mode | 0) !== 0) warn.push("mode");
    return rpaRun(data, F, map, mods, warn, rpaRules(data));
  } catch (e) {
    return rpaFail("error", warn);
  }
}

function rpaRun(data, F, map, mods, warn, rules) {
  rules = rules || { lazer: false, lock: false, headAcc: false };
  const rate = rpaNum(mods.rate, 1) > 0 ? rpaNum(mods.rate, 1) : 1, hr = !!mods.hr, nF = Math.min(F.n | 0, F.t.length, F.x.length, F.y.length, F.k.length);
  const dif = rpaDiff(map, mods), od = dif.od, cs = dif.cs, ar = dif.ar;
  const radius = 64 * (1 - .7 * (cs - 5) / 5) / 2 * 1.00041, off = radius / 10; // (parse.js diffDerived; stack step = radius / 10 as parse.js applyStacks)
  const preempt = Math.trunc(ar < 5 ? 1200 + 600 * (5 - ar) / 5 : 1200 - 750 * (ar - 5) / 5);
  const windows = rpAnaWindows(od), h300 = Math.floor(windows.w300) - .5, h100 = Math.floor(windows.w100) - .5, h50 = Math.floor(windows.w50) - .5, r2 = radius * radius;

  // ---- objects: circles and slider heads (judged), spinners (counted), slider / spinner spans (presses inside are "body")
  const H = map.hit; let N = 0, spinners = 0, nBody = 0;
  for (const o of H) { if (!o || !Number.isFinite(o.t)) continue; if (o.kind === "spinner") spinners++; else N++; if (o.kind !== "circle" && Number.isFinite(o.end) && o.end > o.t) nBody++; }
  const oi = new Int32Array(N), ot = new Float64Array(N), ox = new Float64Array(N), oy = new Float64Array(N), osl = new Uint8Array(N);
  const bs = new Float64Array(nBody), be = new Float64Array(nBody);
  for (let i = 0, j = 0, b = 0; i < H.length; i++) {
    const o = H[i]; if (!o || !Number.isFinite(o.t)) continue;
    if (o.kind !== "circle" && Number.isFinite(o.end) && o.end > o.t) { bs[b] = o.t; be[b] = o.end; b++; }
    if (o.kind === "spinner") continue;
    const rx = rpaNum(o.rx ?? o.x, 256), ry = rpaNum(o.ry ?? o.y, 192), s = rpaNum(o.stack, 0) * off;
    oi[j] = i; ot[j] = o.t; ox[j] = rx - s; oy[j] = hr ? ry + s : ry - s; osl[j] = o.kind === "slider" ? 1 : 0; j++;
  }
  if (!N) warn.push("no_objects"); else if (N < 10) warn.push("few_objects");

  // ---- presses (rising edges of the lit mask); counted first so the arrays are sized once
  let nP = 0;
  for (let i = 0, prev = 0; i < nF; i++) { const s = rpAnaLit(F.k[i]), up = s & ~prev; if (up) nP += (up & 1) + (up >> 1 & 1) + (up >> 2 & 1) + (up >> 3 & 1); prev = s; }
  const pt = new Float64Array(nP), px = new Float64Array(nP), py = new Float64Array(nP), pk = new Uint8Array(nP);
  const kc = [0, 0, 0, 0];
  for (let i = 0, j = 0, prev = 0; i < nF; i++) {
    const s = rpAnaLit(F.k[i]), up = s & ~prev; prev = s; if (!up) continue;
    const y = hr ? 384 - F.y[i] : F.y[i];
    for (let b = 0; b < 4; b++) if (up >> b & 1) { pt[j] = F.t[i]; px[j] = F.x[i]; py[j] = y; pk[j] = b; kc[b]++; j++; }
  }

  // ---- judging (see JUDGEMENT in the header)
  const jud = new Int16Array(N).fill(-1), hp = new Int32Array(N).fill(-1); // (judgement, -1 = not yet; the press that hit it)
  const mt = new Float64Array(N).fill(NaN); // (lazer: when a miss was judged by a press, the object's own early press or a later object's hit; NaN: at t + w50)
  const fkT = new Float64Array(N), fkS = new Uint8Array(N); // (lazer: the first press that reached each circle / head, even one that only shook it: time, side 1 = left, 2 = right)
  const empty = []; let ptr = 0, nLock = 0, nAim = 0, nEarlyNear = 0, nBodyP = 0, bp = 0, bMax = -Infinity;
  const on = (j, x, y) => { const dx = x - ox[j], dy = y - oy[j]; return dx * dx + dy * dy <= r2; };
  if (rules.lock) { // osu!lazer (see JUDGEMENT: LAZER)
    const prev = new Int32Array(N); // (the circle / head that can block j: the last one with an earlier start time, -1 none)
    for (let j = 0; j < N; j++) prev[j] = j > 0 && ot[j - 1] === ot[j] ? prev[j - 1] : j - 1;
    for (let q = 0; q < nP; q++) {
      const p = pt[q], x = px[q], y = py[q];
      while (ptr < N && (jud[ptr] >= 0 || p - ot[ptr] > h50)) { if (jud[ptr] < 0) jud[ptr] = 0; ptr++; } // (passed: miss)
      while (bp < nBody && bs[bp] < p) { if (be[bp] > bMax) bMax = be[bp]; bp++; }
      let tg = -1; // (the press goes to the earliest circle / head not judged yet that is on screen and under the cursor)
      for (let j = ptr; j < N && ot[j] - preempt <= p; j++) if (jud[j] < 0 && on(j, x, y)) { tg = j; break; }
      if (tg < 0) {
        if (ptr < N && p - ot[ptr] >= -h50) { nAim++; empty.push({ t: p, x, y, why: "aim" }); }
        else if (bMax >= p) nBodyP++;
        else empty.push({ t: p, x, y, why: "none" });
        continue;
      }
      const e = p - ot[tg], a = Math.abs(e), k = prev[tg];
      if (!fkS[tg]) { fkS[tg] = pk[q] & 1 ? 2 : 1; fkT[tg] = p; } // (HitReceptor: HitAction ??= the key, whatever the press then does)
      if (k >= 0 && jud[k] < 0 && p < ot[k]) { nLock++; empty.push({ t: p, x, y, why: "lock" }); continue; } // (blocked: it shakes, the press is used up)
      if (a > RPA_EARLY) { empty.push({ t: p, x, y, why: "early" }); continue; } // (HitResult.None: it shakes)
      const r = a <= h300 ? 300 : a <= h100 ? 100 : a <= h50 ? 50 : 0;
      if (r) { jud[tg] = osl[tg] ? 300 : r; hp[tg] = q; } else { jud[tg] = 0; mt[tg] = p; nEarlyNear++; } // (too early but within 400 ms: a miss)
      for (let j = ptr; j < N && ot[j] < ot[tg]; j++) if (jud[j] < 0) { jud[j] = 0; mt[j] = p; } // (HandleHit: the earlier ones not judged yet are missed now)
    }
  } else for (let q = 0; q < nP; q++) {
    const p = pt[q], x = px[q], y = py[q];
    while (ptr < N && (jud[ptr] >= 0 || p - ot[ptr] > h50)) { if (jud[ptr] < 0) jud[ptr] = 0; ptr++; } // (passed: miss)
    while (bp < nBody && bs[bp] < p) { if (be[bp] > bMax) bMax = be[bp]; bp++; } // (latest end of the spans begun before p)
    const inBody = bMax >= p;
    if (ptr < N && p - ot[ptr] >= -h50) { // (in the window of the earliest object left)
      let hit = -1;
      for (let j = ptr; j < N && ot[j] === ot[ptr]; j++) if (jud[j] < 0 && on(j, x, y)) { hit = j; break; } // (same time: any order)
      if (hit >= 0) {
        const e = p - ot[hit], a = Math.abs(e);
        jud[hit] = osl[hit] ? 300 : a <= h300 ? 300 : a <= h100 ? 100 : 50; hp[hit] = q;
        continue;
      }
      let lock = false;
      for (let j = ptr + 1; j < N && ot[j] - preempt <= p; j++) if (jud[j] < 0 && on(j, x, y)) { lock = true; break; }
      if (lock) nLock++; else nAim++;
      empty.push({ t: p, x, y, why: lock ? "lock" : "aim" });
      continue;
    }
    if (inBody) { nBodyP++; continue; } // (re-pressing during a slider or a spinner: not an empty press)
    const near = ptr < N && on(ptr, x, y) && ot[ptr] - p <= RPA_EARLY && ot[ptr] - preempt <= p;
    if (near) nEarlyNear++;
    empty.push({ t: p, x, y, why: near ? "early" : "none" });
  }
  const tEnd = nF ? F.t[nF - 1] : -Infinity; let short = 0;
  for (let j = ptr; j < N; j++) if (jud[j] < 0) { jud[j] = 0; if (ot[j] > tEnd) short++; }
  if (short) warn.push("short_replay");

  // ---- hits and stats
  const hits = new Array(N), err = new Float64Array(N), dist = new Float64Array(N);
  let nh = 0, sum = 0, sdx = 0, sdy = 0, sd = 0, dmax = 0, early = 0, late = 0, jumpMax = 0, jumpAt = null, lx = NaN, ly = NaN, lj = -2;
  for (let j = 0; j < N; j++) {
    const q = hp[j], o = { i: oi[j], t: ot[j], x: ox[j], y: oy[j], press: null, err: null, dx: null, dy: null, judge: jud[j], key: null, slider: !!osl[j], jt: mt[j] === mt[j] ? mt[j] : ot[j] + windows.w50 };
    if (q >= 0) {
      o.press = o.jt = pt[q]; o.err = pt[q] - ot[j]; o.dx = px[q] - ox[j]; o.dy = py[q] - oy[j]; o.key = RPA_KEYS[pk[q]];
      const d = Math.hypot(o.dx, o.dy);
      err[nh] = o.err; dist[nh] = d; nh++; sum += o.err; sdx += o.dx; sdy += o.dy; sd += d; if (d > dmax) dmax = d;
      if (o.err < 0) early++; else if (o.err > 0) late++;
      if (lj === j - 1) { const jd = Math.hypot(px[q] - lx, py[q] - ly); if (jd > jumpMax) { jumpMax = jd; jumpAt = pt[q]; } }
      lx = px[q]; ly = py[q]; lj = j;
    }
    hits[j] = o;
  }
  // the slider and spinner passes run here, before the estimate: it counts sliders and spinners by their real results (see consistency below)
  let sliders = [], spinnersOut = [];
  try { sliders = rpaSliders(H, hits, F, nF, { hr, radius, off, w50: windows.w50, mr: rpaNum(map.radius, 0) / 10, lazer: rules.lock, fk: rules.lock ? Array.from(oi, (i, j) => fkS[j] ? [fkT[j], fkS[j]] : null) : null }); } catch (e) { sliders = []; }
  try { spinnersOut = rpaSpinners(H, F, nF, { hr, od, rate }); } catch (e) { spinnersOut = []; }
  const slJ = new Map(), spJ = new Map(); // (index in map.hit -> judge)
  for (const e of sliders) slJ.set(e.i, e.judge);
  for (const e of spinnersOut) spJ.set(e.i, e.judge);
  const est = { n300: 0, n100: 0, n50: 0, miss: 0 }, tally = (e, j) => { if (j === 300) e.n300++; else if (j === 100) e.n100++; else if (j === 50) e.n50++; else e.miss++; };
  const headCls = j => { const h = hits[j]; if (!(jud[j] > 0) || !Number.isFinite(h.err)) return 0; const a = Math.abs(h.err); return a <= h300 ? 300 : a <= h100 ? 100 : 50; }; // (lazer: a head by its timing)
  for (let j = 0; j < N; j++) tally(est, osl[j] && rules.headAcc ? headCls(j) : osl[j] && slJ.has(oi[j]) ? slJ.get(oi[j]) : jud[j]); // (a slider without a result of its own: its head, 300 when hit, else a miss, as jud has it)
  const mean = nh ? sum / nh : null;
  let v2 = 0, d2 = 0; for (let i = 0; i < nh; i++) { v2 += (err[i] - mean) ** 2; d2 += (dist[i] - sd / nh) ** 2; }
  const sdev = nh ? Math.sqrt(v2 / nh) : null;
  const stats = {
    n: N, hit: nh, est, mean, median: rpaMedian(err, nh), sd: sdev, ur: nh ? 10 * sdev / rate : null, urSong: nh ? 10 * sdev : null, early, late,
    meanDx: nh ? sdx / nh : null, meanDy: nh ? sdy / nh : null, meanDist: nh ? sd / nh : null, maxDist: nh ? dmax : null, sdDist: nh ? Math.sqrt(d2 / nh) : null,
    presses: nP, empty: empty.length, body: nBodyP, lock: nLock, aim: nAim, earlyNear: nEarlyNear, spinners,
  };

  // ---- keys
  const ivs = new Float32Array(Math.max(0, nP - 1)); let nIv = 0, alt = 0, best = Infinity;
  for (let q = 1; q < nP; q++) {
    const d = pt[q] - pt[q - 1]; if (pk[q] !== pk[q - 1]) alt++;
    if (d > 0 && d <= RPA_IV_MAX) ivs[nIv++] = d;
    if (q >= RPA_BPM_RUN - 1) { const w = (pt[q] - pt[q - RPA_BPM_RUN + 1]) / (RPA_BPM_RUN - 1); if (w > 0 && w < best) best = w; }
  }
  const intervals = ivs.slice(0, nIv), medIv = rpaMedian(intervals, nIv);
  const keys = { counts: { K1: kc[0], K2: kc[1], M1: kc[2], M2: kc[3] }, presses: nP, intervals, maxBpm: best < Infinity ? 15000 / best * rate : 0, avgBpm: medIv ? 15000 / medIv * rate : 0, altRatio: nP > 1 ? alt / (nP - 1) : 0 };

  // ---- cursor: heat, distance, speed over the play span
  let s0 = F.t[0], s1 = tEnd;
  if (N || spinners) {
    let first = Infinity, last = -Infinity;
    for (const o of H) if (o && Number.isFinite(o.t)) { if (o.t < first) first = o.t; const e = Number.isFinite(o.end) ? Math.max(o.end, o.t) : o.t; if (e > last) last = e; }
    s0 = first - preempt; s1 = last + 200;
  }
  const grid = new Float32Array(RPA_W * RPA_H), span = s1 - s0;
  const nS = span > 0 ? Math.max(1, Math.min(RPA_SPEED_N, Math.ceil(span / 50))) : 0, bw = nS ? span / nS : 1, sb = new Float64Array(nS);
  let total = 0, distance = 0;
  const sqrt = Math.sqrt, gx = RPA_W * RPA_CELL, gy = RPA_H * RPA_CELL; // (no Math / global lookups per frame in this loop: plain compares and | 0 on clamped values)
  for (let i = 0; i < nF; i++) {
    const ta = F.t[i], tb = i + 1 < nF ? F.t[i + 1] : ta;
    if (tb <= s0 || ta >= s1) continue;
    let dt = (tb < s1 ? tb : s1) - (ta > s0 ? ta : s0); if (dt > RPA_GAP) dt = RPA_GAP;
    const x = F.x[i], y = hr ? 384 - F.y[i] : F.y[i];
    if (dt > 0 && x - x === 0 && y - y === 0) { // (finite)
      const cx = x < 0 ? 0 : x >= gx ? RPA_W - 1 : (x / RPA_CELL) | 0, cy = y < 0 ? 0 : y >= gy ? RPA_H - 1 : (y / RPA_CELL) | 0;
      grid[cy * RPA_W + cx] += dt; total += dt;
    }
    if (i + 1 < nF) {
      const ddx = F.x[i + 1] - F.x[i], ddy = F.y[i + 1] - F.y[i], d = sqrt(ddx * ddx + ddy * ddy); if (d - d !== 0) continue; // (NaN or infinite)
      distance += d;
      if (nS) { const u = ((ta + tb) / 2 - s0) / bw, k = u < 0 ? 0 : u >= nS ? nS - 1 : u | 0; sb[k] += d; }
    }
  }
  let gmax = 0; for (let c = 0; c < grid.length; c++) if (grid[c] > gmax) gmax = grid[c];
  if (gmax > 0) for (let c = 0; c < grid.length; c++) grid[c] /= gmax;
  const speed = new Array(nS); let vMax = 0;
  for (let k = 0; k < nS; k++) { // (bucket average, then a light 1-2-1 smoothing)
    const a = sb[k > 0 ? k - 1 : k], b = sb[k], c = sb[k < nS - 1 ? k + 1 : k], v = (a + 2 * b + c) / 4 / bw;
    speed[k] = { t: s0 + (k + .5) * bw, v }; if (v > vMax) vMax = v;
  }
  const cursor = { grid: { w: RPA_W, h: RPA_H, cell: RPA_CELL, data: grid, max: gmax, total }, speed, vMax, distance, jumpMax, jumpAt, span: [s0, s1] };

  // ---- consistency with the replay's own counts
  const header = rpaHeader(data), cest = { n300: est.n300, n100: est.n100, n50: est.n50, miss: est.miss };
  for (let i = 0; i < H.length; i++) { const o = H[i]; if (o && o.kind === "spinner" && Number.isFinite(o.t)) tally(cest, spJ.has(i) ? spJ.get(i) : 300); } // (a spinner without a result of its own: assumed cleared)
  const diff = (Math.abs(cest.n300 - header.n300) + Math.abs(cest.n100 - header.n100) + Math.abs(cest.n50 - header.n50) + Math.abs(cest.miss - header.miss)) / 2;
  const tot = Math.max(1, header.n300 + header.n100 + header.n50 + header.miss);
  const quality = diff <= Math.max(2, tot * .005) ? "good" : diff <= Math.max(5, tot * .03) ? "fair" : "poor";
  const consistency = { header, est: cest, d300: cest.n300 - header.n300, diff, quality, rules: rules.lazer ? "lazer" : "stable" };
  const ls = data.lazerInfo && data.lazerInfo.statistics;
  if (ls && typeof ls === "object") { // (lazer's own counts of the slider parts: a second check of the reconstruction, not part of the quality)
    const pe = { tickHit: 0, tickMiss: 0, tailHit: 0 };
    for (const s of sliders) for (const p of s.parts) if (p.kind === "tail") { if (p.hit) pe.tailHit++; } else if (p.hit) pe.tickHit++; else pe.tickMiss++;
    consistency.parts = { header: { tickHit: ls.large_tick_hit | 0, tickMiss: ls.large_tick_miss | 0, tailHit: ls.slider_tail_hit | 0 }, est: pe };
  }
  let combo = { max: 0, breaks: [] };
  try { combo = rpaCombo(H, hits, sliders, spinnersOut, windows.w50); } catch (e) { combo = { max: 0, breaks: [] }; }
  return {
    ok: true, warn, windows, judge: { w300: h300, w100: h100, w50: h50 }, od, cs, ar, radius, preempt, rate, hr,
    hits, empty, stats, keys, cursor, consistency,
    sliders, spinners: spinnersOut, combo,
  };
}

// ---- what a replay really did on sliders and spinners (see SLIDERS AND SPINNERS in the header)
const RPA_FOLLOW = 2.4;        // follow area = 2.4 x radius while tracking: osu.Game.Rulesets.Osu/Objects/Drawables/DrawableSliderBall.cs FOLLOW_AREA
const RPA_TAIL = -36;          // the tail is checked 36 ms early: osu.Game/Rulesets/Objects/SliderEventGenerator.cs TAIL_LENIENCY
const RPA_SPIN_RPM = [90, 150, 225]; // clear RPM at OD 0 / 5 / 10: osu.Game.Rulesets.Osu/Objects/Spinner.cs CLEAR_RPM_RANGE
const RPA_SPIN_EPS = 0.0001;   // osu.Game.Rulesets.Osu/Objects/Spinner.cs duration_error (SpinsRequired)
const RPA_SPIN_100 = 0.9, RPA_SPIN_50 = 0.75; // progress > .9 100, > .75 50: osu.Game.Rulesets.Osu/Objects/Drawables/DrawableSpinner.cs CheckForResult

function rpaLower(a, n, x) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; } // first index with a[i] >= x

// the slider ball at song time T into q = [x, y] on the path as parse.js drew it (the same as parse.js pointAt(o, ballF(o, T).f), without
// allocating: it runs once per frame of every slider)
function rpaBall(o, T, q) {
  const P = o.path, C = o.cum, n = C.length;
  let prog = (T - o.t) / o.span; prog = prog < 0 ? 0 : prog > o.slides ? o.slides : prog;
  let rep = Math.floor(prog); if (rep >= o.slides) rep = o.slides - 1;
  const fr = prog - rep, f = rep % 2 ? 1 - fr : fr, target = C[n - 1] * (f < 0 ? 0 : f > 1 ? 1 : f);
  if (n < 2 || P.length < 2) { q[0] = o.x; q[1] = o.y; return; }
  let lo = 1, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (C[mid] < target) lo = mid + 1; else hi = mid; }
  const a = P[lo - 1], b = P[lo], d = C[lo] - C[lo - 1], k = d ? (target - C[lo - 1]) / d : 0;
  if (P.jumps && P.jumps.has(lo)) { const j = k < .5 ? a : b; q[0] = j[0]; q[1] = j[1]; return; } // (a left-out stretch far off-screen: the ball stays out there)
  q[0] = a[0] + (b[0] - a[0]) * k; q[1] = a[1] + (b[1] - a[1]) * k;
}

function rpaSliders(H, hits, F, nF, c) {
  const out = [], q = [0, 0];
  const by = []; for (const h of hits) by[h.i] = h;
  const fk = []; if (c.fk) hits.forEach((h, j) => { if (c.fk[j]) fk[h.i] = c.fk[j]; }); // (lazer: the key the head was first pressed with, by index in map.hit)
  const r2 = c.radius * c.radius, R2 = r2 * RPA_FOLLOW * RPA_FOLLOW;
  for (let i = 0; i < H.length; i++) {
    const o = H[i]; if (!o || o.kind !== "slider" || !Number.isFinite(o.t) || !(o.end > o.t) || !o.path || !o.cum || !(o.span > 0)) continue;
    const e = by[i], t0 = o.t, t1 = o.end, st = rpaNum(o.stack, 0), sh = st * c.mr, so = st * c.off;
    const ballAt = T => { rpaBall(o, T, q); q[0] += sh - so; q[1] += c.hr ? sh + so : sh - so; }; // (into q; the head's stacking / HR convention)
    const headHit = !!e && e.judge === 300 && Number.isFinite(e.press), tp = headHit ? e.press : NaN, lk = c.lazer ? fk[i] : null;
    // tracking takes only the head's key from kt on, until the other key was up in the frame before (stable: the key that hit it, from the hit; lazer: the first key that reached it, from that press, hit or not)
    const kt = lk ? lk[0] : tp, act = lk ? lk[1] : headHit && (e.key === "K2" || e.key === "M2") ? 2 : 1;
    const headJ = headHit ? tp : c.lazer && e && Number.isFinite(e.jt) ? e.jt : t0; // (a missed head does not hold the later parts back until its window ends: a short slider is over by then. Measured on a real replay: with the window the one slider that was missed by aim and followed came out a miss, the game's header says no misses)
    // parts in time order: nominal time (nom), the time the position is taken at (pt)
    const parts = [];
    if (o.ticks) for (const tk of o.ticks) for (let k = 0; k < o.slides; k++) { const tt = t0 + o.span * k + (k % 2 ? 1 - tk[0] : tk[0]) * o.span; parts.push({ nom: tt, pt: tt, kind: "tick" }); }
    for (let k = 1; k < o.slides; k++) { const tt = t0 + o.span * k; parts.push({ nom: tt, pt: tt, kind: "repeat" }); }
    parts.sort((a, b) => a.nom - b.nom);
    parts.push({ nom: t1 + RPA_TAIL, pt: t1, kind: "tail" });
    const nP = parts.length, hitA = new Uint8Array(nP), jt = new Float64Array(nP);
    for (let k = 0, prev = headJ; k < nP; k++) { prev = jt[k] = Math.max(parts[k].nom, prev); } // (never before the head is judged, nor before the part before)
    const track = []; let done = 0, tracking = false, tta = null, headDone = false, lastL = false, lastR = false;
    for (let f = Math.max(0, rpaLower(F.t, nF, Number.isFinite(kt) ? Math.min(t0, kt) : t0) - 1); f < nF; f++) { // (from the frame before: which keys were down then)
      const ti = F.t[f], nt = f + 1 < nF ? F.t[f + 1] : ti; // (the last frame covers no time after it: a replay that ends mid-slider misses the rest)
      if (done >= nP && ti >= t1) break;
      const lit = rpAnaLit(F.k[f]), L = (lit & 5) !== 0, Rr = (lit & 10) !== 0, x = F.x[f], y = c.hr ? 384 - F.y[f] : F.y[f];
      ballAt(ti); const dx = x - q[0], dy = y - q[1], d2 = dx * dx + dy * dy, ok = d2 === d2;
      const headNow = headHit && ti >= tp, keyNow = ti >= kt; // (kt NaN: never)
      if (!keyNow) tta = null;
      else if (tta === null && !(act === 2 ? lastL : lastR)) tta = ti; // (any key counts once the other one was up in the frame before)
      const valid = keyNow && (tta === null || ti <= tta) ? (act === 2 ? Rr : L) : (L || Rr);
      if (headNow && !headDone) { // the head was just hit: SliderInputManager.PostProcessHeadJudgement
        headDone = true;
        if (ok && d2 <= R2) {
          let m = done, all = true;
          while (m < nP && parts[m].nom <= ti && (parts[m].kind !== "tail" || t1 <= ti)) {
            if (all) { ballAt(parts[m].pt); const qx = x - q[0], qy = y - q[1]; if (qx * qx + qy * qy > R2) all = false; }
            m++;
          }
          for (let k = done; k < m; k++) { hitA[k] = all ? 1 : 0; jt[k] = Math.max(jt[k], ti); }
          done = m; tracking = (all || d2 <= r2) && valid;
        } else tracking = ok && d2 <= (tracking ? R2 : r2) && valid;
      } else tracking = ok && d2 <= (tracking ? R2 : r2) && valid;
      lastL = L; lastR = Rr;
      if (tracking) { const a = ti > t0 ? ti : t0, z = nt < t1 ? nt : t1; if (z > a) { const l = track[track.length - 1]; if (l && l[1] >= a) l[1] = z; else track.push([a, z]); } }
      // lazer: the state AT time T between this frame and the next (the game judges at its own updates, far finer than the recorded frames: the cursor interpolated
      // between the two frames, as lazer's replay playback moves it, with this frame's keys); it carries on as the tracking state. Stable: the frame's own state
      const at = c.lazer ? T => {
        if (!(T > ti) || f + 1 >= nF) return tracking;
        const u = (T - ti) / (nt - ti), yn = c.hr ? 384 - F.y[f + 1] : F.y[f + 1], x2 = x + (F.x[f + 1] - x) * u, y2 = y + (yn - y) * u;
        ballAt(T); const ex = x2 - q[0], ey = y2 - q[1], e2 = ex * ex + ey * ey;
        return tracking = e2 === e2 && e2 <= (tracking ? R2 : r2) && valid;
      } : null; // (lazer only: no closure per frame on the stable path)
      while (done < nP && jt[done] < nt) {
        if (parts[done].kind !== "tail") { hitA[done] = (c.lazer ? at(jt[done]) : tracking) ? 1 : 0; done++; continue; }
        // the tail: hit on the first tracking frame from end - 36 on, missed only once the end has passed without (TryJudgeNestedObject)
        if (c.lazer) { // (sampled at end - 36 (or when it may first be judged), at each frame after it, and at the end)
          if (at(jt[done])) { hitA[done] = 1; jt[done] = Math.max(jt[done], ti); done++; }
          else if (t1 < nt) { const h = t1 <= ti ? false : at(t1); hitA[done] = h ? 1 : 0; jt[done] = Math.max(jt[done], t1); done++; }
          else break;
          continue;
        }
        if (tracking) { hitA[done] = 1; jt[done] = Math.max(jt[done], ti); done++; }
        else if (nt > Math.max(t1, jt[done])) { hitA[done] = 0; jt[done] = Math.max(jt[done], t1); done++; }
        else break;
      }
    }
    if (done < nP) for (let k = done; k < nP; k++) if (parts[k].kind === "tail") jt[k] = Math.max(jt[k], t1); // (frames ran out first: missed)
    const outParts = new Array(nP); let nHit = headHit ? 1 : 0, brk = null, engaged = headHit;
    for (let k = 0; k < nP; k++) {
      outParts[k] = { t: jt[k], kind: parts[k].kind, hit: !!hitA[k] };
      if (hitA[k]) { nHit++; engaged = true; } else if (engaged && brk === null) brk = jt[k];
    }
    const tot = nP + 1;
    out.push({ i, t: t0, end: t1, track, parts: outParts, head: headHit, brk, judge: nHit === tot ? 300 : nHit === 0 ? 0 : nHit / tot >= .5 ? 100 : 50 });
  }
  return out;
}

function rpaSpinners(H, F, nF, c) {
  const out = [];
  const range = (d, [lo, mid, hi]) => d > 5 ? mid + (hi - mid) * (d - 5) / 5 : d < 5 ? mid + (mid - lo) * (d - 5) / 5 : mid; // (IBeatmapDifficultyInfo.DifficultyRange)
  const rps = range(c.od, RPA_SPIN_RPM) / 60, rate = Math.abs(c.rate);
  for (let i = 0; i < H.length; i++) {
    const o = H[i]; if (!o || o.kind !== "spinner" || !Number.isFinite(o.t) || !(o.end > o.t)) continue;
    const t0 = o.t, t1 = o.end, need = Math.max(0, Math.trunc(rps * (t1 - t0) / 1000 + RPA_SPIN_EPS));
    const f0 = rpaLower(F.t, nF, t0), f1 = rpaLower(F.t, nF, t1), tt = new Float64Array(f1 - f0 + 2), vv = new Float32Array(f1 - f0 + 2);
    const ang = f => { const y = c.hr ? 384 - F.y[f] : F.y[f]; return -Math.atan2(F.x[f] - 256, y - 192) * 180 / Math.PI; };
    let last = f0 > 0 ? ang(f0 - 1) : NaN, n = 1, acc = 0, lastC = 0, curMax = 0, spins = 0, clearAt = need === 0 ? t0 : null;
    tt[0] = t0; vv[0] = 0;
    for (let f = f0; f < f1; f++) {
      const a = ang(f); let d = last === last && a === a ? a - last : 0; last = a;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      if (d !== 0 && rpAnaLit(F.k[f])) { // (a key down: SpinnerRotationTracker.AddRotation, SpinnerSpinHistory.ReportDelta)
        acc += d * rate; let cur = acc - lastC; curMax = Math.max(curMax, Math.abs(cur));
        while (curMax >= 360) { const dir = Math.sign(cur); spins++; lastC += dir * 360; cur = acc - lastC; curMax = Math.abs(cur); }
      }
      const rot = (360 * spins + curMax) / 360;
      if (clearAt === null && rot >= need) clearAt = F.t[f];
      if (F.t[f] > t0) { tt[n] = F.t[f]; vv[n] = rot; n++; }
    }
    const rotEnd = (360 * spins + curMax) / 360;
    if (tt[n - 1] < t1) { tt[n] = t1; vv[n] = rotEnd; n++; }
    const prog = need ? Math.min(1, rotEnd / need) : 1;
    out.push({ i, t: t0, end: t1, need, rot: { t: tt.slice(0, n), v: vv.slice(0, n) }, cleared: clearAt !== null, clearAt, judge: prog >= 1 ? 300 : prog > RPA_SPIN_100 ? 100 : prog > RPA_SPIN_50 ? 50 : 0 });
  }
  return out;
}

// ---- the combo a replay really had (see COMBO in the header). H = map.hit, hits = a.hits, sl = a.sliders, sp = a.spinners, w50 = the half-window (ms) a miss is judged at
// Rules, osu!lazer (github.com/ppy/osu master, read on 2026-10-12), the default (not Classic mod) slider scoring:
//  - HitResult.cs: IncreasesCombo = AffectsCombo && IsHit; BreaksCombo = AffectsCombo && !IsHit. AffectsCombo is true for Miss / Meh / Ok / Good / Great / Perfect, LargeTickHit / LargeTickMiss,
//    SliderTailHit, LegacyComboIncrease, ComboBreak; false for IgnoreMiss, SmallTickHit / SmallTickMiss and the bonuses (SmallBonus, LargeBonus). IsHit is false for None, IgnoreMiss, Miss,
//    SmallTickMiss, LargeTickMiss, ComboBreak.
//  - circle (OsuJudgement, MaxResult Great, Judgement.MinResult Miss): a 300 / 100 / 50 is +1, a miss breaks.
//  - slider head (SliderHeadCircle: a HitCircle, OsuJudgement): the same, +1 on a hit, a miss breaks. (With the Classic mod's ClassicSliderBehaviour the head is a LargeTick: also +1 / break.)
//  - tick (SliderTick, SliderTickJudgement MaxResult LargeTickHit -> MinResult LargeTickMiss) and repeat (SliderRepeat : SliderEndCircle, SliderEndJudgement LargeTickHit): +1 when hit, a miss breaks.
//  - tail (SliderTailCircle.TailJudgement, MaxResult SliderTailHit -> Judgement.MinResult IgnoreMiss): +1 when hit; a MISSED tail is IgnoreMiss, which neither increases nor breaks.
//    (With ClassicSliderBehaviour the tail is a SmallTick, no combo at all, and the slider itself, Slider.CreateJudgement / DrawableSlider.CheckForResult, gives the +1 as Great / Ok / Meh, a Miss
//    only when every nested object was missed: a missed tail then still gets its point. Not used here; stable replays are scored by the default rule above.)
//  - spinner (Spinner.CreateJudgement = OsuJudgement; DrawableSpinner.CheckForResult at EndTime): Great / Ok / Meh (progress > .75) is +1, 0 is a Miss and breaks. Its ticks and bonus ticks
//    (SpinnerTick SmallBonus, SpinnerBonusTick LargeBonus: AffectsCombo false) do nothing for the combo.
// The events are sorted by the time they are judged (ties in map order; a slider's own parts never before its head): a hit's press, a circle's / head's miss at t + w50, a part at its a.sliders time,
// a spinner at its end.
function rpaCombo(H, hits, sl, sp, w50) {
  const ev = []; let seq = 0; // [time, order, ok]
  const by = []; for (const h of hits) by[h.i] = h;
  const sls = []; for (const s of sl) sls[s.i] = s;
  const sps = []; for (const s of sp) sps[s.i] = s;
  for (let i = 0; i < H.length; i++) {
    const o = H[i]; if (!o || !Number.isFinite(o.t)) continue;
    if (o.kind === "spinner") { const s = sps[i]; if (s) ev.push([s.end, seq++, s.judge > 0]); continue; }
    const h = by[i]; if (!h) continue;
    const ok = h.judge > 0 && Number.isFinite(h.press), th = ok ? h.press : Number.isFinite(h.jt) ? h.jt : h.t + w50; // (a lazer miss judged by a press: at that press)
    ev.push([th, seq++, ok]);
    const s = o.kind === "slider" ? sls[i] : null;
    if (s) for (const p of s.parts) { // (a missed tail is IgnoreMiss: no point, no break)
      if (p.hit) ev.push([Math.max(p.t, th), seq++, true]); else if (p.kind !== "tail") ev.push([Math.max(p.t, th), seq++, false]);
    }
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const breaks = [], n = ev.length, at = { t: new Float64Array(n), v: new Int32Array(n) }; let c = 0, max = 0;
  for (let k = 0; k < n; k++) {
    const e = ev[k];
    if (e[2]) { if (++c > max) max = c; } else { breaks.push({ t: e[0], combo: c }); c = 0; }
    at.t[k] = e[0]; at.v[k] = c;
  }
  return { max, breaks, at };
}

// the combo at song time t (see COMBO in the header). Shared result object: no allocation per frame
const _rpCA = { combo: 0, since: -1 };
function rpComboAt(a, t) {
  try {
    const at = a && a.combo && a.combo.at, T = at && at.t, V = at && at.v;
    if (!T || !V || typeof t !== "number" || !Number.isFinite(t)) return null;
    const n = T.length; if (!(n >= 0) || V.length !== n) return null;
    let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m + 1; else hi = m; } // (lo = the events with time <= t)
    let j = lo - 1; // the last event; the last one that increased the combo is it when the combo is above 0 (a break is 0), else the last hit before the break(s)
    _rpCA.combo = j >= 0 ? V[j] : 0;
    while (j >= 0 && V[j] === 0) j--;
    _rpCA.since = j >= 0 ? t - T[j] : -1;
    return _rpCA;
  } catch (e) { return null; }
}

// an analysis that disagrees with the replay's own counts (see the header)
function rpAnaPoor(a) {
  const q = a && a.consistency, h = q && q.header;
  return !!(q && q.quality === "poor" && h && (+h.n300 || 0) + (+h.n100 || 0) + (+h.n50 || 0) + (+h.miss || 0) > 0);
}

// ---- the hit error bar and the unstable rate while a replay plays (drawn by js/player.js drawHitBar). Everything is a function of the song time t (no state:
// a seek or a pause shows the same numbers), from rpHitBar(a): the hits that have a press, in press order, with prefix sums of the errors.
//   rpHitBar(a) -> { n, t: Float64Array (press, song ms), e: Float32Array (press - object time, song ms, + = late), s1, s2: Float64Array(n + 1) (sums of e and e * e) } | null (no a / no hits
//     array); made once per analysis (a._bar). Misses have no press, so no entry; a slider head is one (its press and error as a circle's).
//   rpUrAt(bar, rate, t) -> the unstable rate over the hits pressed at or before t: 10 * the population standard deviation of their errors / rate, like a.stats.ur at the end
//     (null before two hits).
//   rpBarAt(bar, t, ms, last) -> { k (hits pressed at or before t), from (the first hit pressed after t - ms), avg (the mean error of the last `last` hits, song ms; null when
//     none) }: the ticks to draw are the entries from .. k - 1. Shared result object: read it at once.
//   rpErrClass(err, judge) -> 300 | 100 | 50: by |err| against a.judge (the windows really compared), NOT by a.hits[].judge (a slider head counts 300 whenever it is hit).
function rpHitBar(a) {
  if (!a || !Array.isArray(a.hits)) return null;
  if (a._bar) return a._bar;
  const h = a.hits.filter(o => o && Number.isFinite(o.press) && Number.isFinite(o.err)).sort((p, q) => p.press - q.press), n = h.length;
  const bar = { n, t: new Float64Array(n), e: new Float32Array(n), s1: new Float64Array(n + 1), s2: new Float64Array(n + 1) };
  for (let i = 0; i < n; i++) { const e = h[i].err; bar.t[i] = h[i].press; bar.e[i] = e; bar.s1[i + 1] = bar.s1[i] + e; bar.s2[i + 1] = bar.s2[i] + e * e; }
  return a._bar = bar;
}
function rpBarCount(bar, t) { let lo = 0, hi = bar.n; while (lo < hi) { const m = (lo + hi) >> 1; if (bar.t[m] <= t) lo = m + 1; else hi = m; } return lo; } // (entries with press <= t)
function rpUrAt(bar, rate, t) {
  if (!bar || !Number.isFinite(t) || !(rate > 0)) return null;
  const k = rpBarCount(bar, t); if (k < 2) return null;
  const mean = bar.s1[k] / k, v = bar.s2[k] / k - mean * mean;
  return 10 * Math.sqrt(v > 0 ? v : 0) / rate;
}
const _rpBA = { k: 0, from: 0, avg: null };
function rpBarAt(bar, t, ms, last) {
  if (!bar || !Number.isFinite(t)) return null;
  const k = rpBarCount(bar, t); let lo = 0, hi = k; while (lo < hi) { const m = (lo + hi) >> 1; if (bar.t[m] > t - ms) hi = m; else lo = m + 1; }
  const f = Math.max(0, k - Math.max(1, last | 0));
  _rpBA.k = k; _rpBA.from = lo; _rpBA.avg = k ? (bar.s1[k] - bar.s1[f]) / (k - f) : null;
  return _rpBA;
}
function rpErrClass(err, j) { const e = Math.abs(err); return !j || e <= j.w300 ? 300 : e <= j.w100 ? 100 : 50; }

// the object (index in a.hits) nearest to song time t; -1 when there is none
function rpAnalyzeAt(a, t) {
  const H = a && a.hits; if (!H || !H.length || !Number.isFinite(t)) return -1;
  let lo = 0, hi = H.length; while (lo < hi) { const m = (lo + hi) >> 1; if (H[m].t < t) lo = m + 1; else hi = m; }
  if (lo >= H.length) return H.length - 1;
  return lo > 0 && t - H[lo - 1].t <= H[lo].t - t ? lo - 1 : lo;
}

// ---- a replay's real hits on the playfield (drawn by js/player.js; here so it can be unit tested without a canvas) ----
// rpHitState(e, t, w) -> what one circle / slider head shows at song time t, from its a.hits entry e and a.windows w alone (stateless:
// a seek either way is right). null = no effect at all (no entry, an odd one): the player then keeps the head-only look.
//   head: alpha factor of the head (1 as before its time; 0 gone: at the press, or a miss fading RPH_FADE ms from the end of its window)
//   appr: the approach circle shows (until the press / the end of the window; past the object time it stays at full size)
//   burst: ms since the press (-1: none; hits only)   judge: 300 | 100 | 50 | 0 (miss) | null (a slider head: its real result needs
//   the ticks and the tail, not known here)   jAge: ms since the judgement shows (-1: not yet / none): a hit's at its press, a miss's
//   at t + w50 (the end of the window, when the game judges it), or at e.jt when the entry has one (a lazer miss judged by a press)
const RPH_FADE = 200;
function rpHitState(e, t, w) {
  if (!e || typeof e !== "object" || !Number.isFinite(e.t) || !Number.isFinite(t)) return null;
  const j = e.judge, sl = !!e.slider;
  if (j === 300 || j === 100 || j === 50) {
    if (!Number.isFinite(e.press)) return null;
    const age = t - e.press;
    return { head: age < 0 ? 1 : 0, appr: age < 0, burst: age < 0 ? -1 : age, judge: sl ? null : j, jAge: sl || age < 0 ? -1 : age };
  }
  if (j !== 0 || !w || !Number.isFinite(w.w50)) return null;
  const age = t - (Number.isFinite(e.jt) ? e.jt : e.t + w.w50); // (jt: when the miss was judged; t + w50 unless a lazer press judged it sooner)
  return { head: age < 0 ? 1 : Math.max(0, 1 - age / RPH_FADE), appr: age < 0, burst: -1, judge: sl ? null : 0, jAge: sl || age < 0 ? -1 : age };
}

// ---- a replay's real slider follow and spinner rotation at song time t (drawn by js/player.js; pure, so it can be unit tested) ----
// rpSliderState(e, t) from an a.sliders entry, rpSpinState(e, t) from an a.spinners entry (see SLIDERS AND SPINNERS in the header).
// null for no entry / an odd one / a non finite t. Stateless: a seek either way is right.
function rpSliderState(e, t) {
  try {
    if (!e || typeof e !== "object" || !Number.isFinite(e.t) || !Number.isFinite(e.end) || !Number.isFinite(t) || !Array.isArray(e.parts) || !Array.isArray(e.track)) return null;
    let tracking = false, since = -1;
    for (const q of e.track) if (q && t >= q[0] && t < q[1]) { tracking = true; since = t - q[0]; break; }
    let lo = 0, hi = e.parts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (e.parts[m].t <= t) lo = m + 1; else hi = m; } // (parts with time <= t)
    let hit = 0; for (let k = 0; k < lo; k++) if (e.parts[k].hit) hit++;
    const lp = lo ? e.parts[lo - 1] : null;
    return {
      phase: t < e.t ? "pending" : t < e.end ? "active" : "done", tracking, since,
      brkAge: Number.isFinite(e.brk) && t >= e.brk ? t - e.brk : -1, parts: lo, partsHit: hit,
      lastPart: lp ? { kind: lp.kind, hit: !!lp.hit, age: t - lp.t } : null,
    };
  } catch (err) { return null; }
}
function rpSpinState(e, t) {
  try {
    if (!e || typeof e !== "object" || !Number.isFinite(e.t) || !Number.isFinite(e.end) || !Number.isFinite(t) || !e.rot || !e.rot.t || !e.rot.v) return null;
    const T = e.rot.t, V = e.rot.v, n = Math.min(T.length, V.length); let rot = 0;
    if (n && t >= T[0]) {
      let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m + 1; else hi = m; } // (samples with time <= t)
      const a = lo - 1; rot = lo >= n ? V[n - 1] : V[a] + (V[lo] - V[a]) * (T[lo] > T[a] ? (t - T[a]) / (T[lo] - T[a]) : 0);
    }
    const need = Number.isFinite(e.need) ? e.need : 0, clear = !!e.cleared && Number.isFinite(e.clearAt) && t >= e.clearAt;
    return {
      phase: t < e.t ? "pending" : t < e.end ? "active" : "done", rot, prog: need > 0 ? Math.max(0, Math.min(1, rot / need)) : clear ? 1 : 0,
      clear, clearAge: clear ? t - e.clearAt : -1,
    };
  } catch (err) { return null; }
}

// ---- the hitsounds a replay really played (js/audio.js schedule uses it while a replay is watched, instead of Auto's map.sounds)
// rpSoundEvents(map, a) -> a copy of map.sounds (sorted by t, ties in map.sounds order) with only what happened, each entry { ...the map.sounds entry, t: when to
// play it, nt: its nominal time (the timing point, so sample set / volume, belongs to the object's own time, not to a late press) }:
//   - circle: only when its a.hits entry was hit (judge > 0 and a press), at the press
//   - slider head (edge k 0): the same, at the press. Repeats (edge 1..slides-1), ticks and the tail (edge slides): only when the matching a.sliders[].parts entry
//     was hit, at the part's nominal time (where the ball is then), never before the head's press when the head was hit late. Parts are matched by the
//     order rpaSliders builds them in (ticks and repeats by time, then the tail), not by their judged time
//   - spinner (its end sound): only when it was cleared
//   - no analysis, or no a.hits: everything at its nominal time. No a.sliders / a.spinners entry for an object: its circles / heads by press, the rest nominal
//   - the combo-break sound: for each a.combo.breaks entry whose combo before the break is above 20 (see below), an event { t: break.t, nt: break.t, combobreak: true,
//     hs: 0, tick: false } (audio.js plays the combobreak sample for it). No a.combo, or a malformed one: no such events, the rest unaffected
// Pure, null-safe, never throws (on anything odd: the map's own list, copied).
// (the combo-break rule, osu!lazer, ppy/osu osu.Game/Screens/Play/ComboEffects.cs onComboChange: the combo-break sample (Gameplay/combobreak) plays when
//   combo.NewValue == 0 && (combo.OldValue > 20 || (alwaysPlayFirst.Value && firstBreakTime == null))
// i.e. when the combo drops to 0 from a value above 20. The second clause (the option AlwaysPlayFirstComboBreak, default on, also sounds the first break of a
// play whatever its combo) is deliberately not followed: only a combo above 20 sounds here)
function rpSoundEvents(map, a) {
  const src = map && Array.isArray(map.sounds) ? map.sounds : [];
  const nominal = () => src.map(e => ({ ...e, nt: e.t }));
  const CB_MIN = 20, byTime = list => list.map((e, n) => [e, n]).sort((x, y) => x[0].t - y[0].t || x[1] - y[1]).map(x => x[0]); // (a stable sort: equal times keep their order)
  const breaks = () => { // (own try: a malformed a.combo gives no break events, it must not cost the hit list)
    const out = [];
    try {
      const br = a && a.combo && a.combo.breaks;
      if (Array.isArray(br)) for (const b of br) if (b && Number.isFinite(b.t) && b.combo > CB_MIN) out.push({ t: b.t, nt: b.t, combobreak: true, hs: 0, tick: false });
    } catch (err) { return []; }
    return out;
  };
  try {
    if (!a || !Array.isArray(a.hits)) { const nom = nominal(), cb = breaks(); return cb.length ? byTime(nom.concat(cb)) : nom; }
    const H = Array.isArray(map.hit) ? map.hit : [], hits = [], sl = [], sp = [];
    for (const h of a.hits) if (h && h.i >= 0) hits[h.i] = h;
    if (Array.isArray(a.sliders)) for (const s of a.sliders) if (s && s.i >= 0 && Array.isArray(s.parts)) sl[s.i] = s;
    if (Array.isArray(a.spinners)) for (const s of a.spinners) if (s && s.i >= 0) sp[s.i] = s;
    const pressOf = h => h && h.judge > 0 && Number.isFinite(h.press) ? h.press : null; // (null: not hit)
    const slot = []; // per slider: part key -> queue of part indices, in the order rpaSliders builds the parts
    const slotOf = i => {
      if (slot[i] !== undefined) return slot[i];
      const o = H[i], s = sl[i]; let r = null;
      if (o && s && o.kind === "slider" && o.span > 0 && o.slides >= 1) {
        const ps = [];
        if (o.ticks) for (const tk of o.ticks) for (let k = 0; k < o.slides; k++) ps.push({ nom: o.t + o.span * k + (k % 2 ? 1 - tk[0] : tk[0]) * o.span, key: "t" });
        for (let k = 1; k < o.slides; k++) ps.push({ nom: o.t + o.span * k, key: "r" + k });
        ps.sort((x, y) => x.nom - y.nom);
        ps.push({ nom: o.end, key: "tail" });
        if (ps.length === s.parts.length) { // (not the same count: another build of the map; its parts are not trusted)
          r = new Map();
          ps.forEach((p, n) => { const key = p.key === "t" ? "t" + p.nom : p.key; (r.get(key) || r.set(key, []).get(key)).push(n); });
        }
      }
      return slot[i] = r;
    };
    const out = [];
    for (const e of src) {
      const oi = e.oi, o = Number.isInteger(oi) ? H[oi] : null, nt = e.t;
      let t = nt, play = true;
      if (o && o.kind === "circle") {
        if (hits[oi]) { const p = pressOf(hits[oi]); if (p === null) play = false; else t = p; }
      } else if (o && o.kind === "slider") {
        const hd = hits[oi], hp = hd ? pressOf(hd) : undefined;
        if (e.k === 0) { if (hd) { if (hp === null) play = false; else t = hp; } }
        else if (e.tick || Number.isInteger(e.k)) {
          const sm = slotOf(oi);
          if (sm) {
            const key = e.tick ? "t" + nt : e.k === o.slides ? "tail" : "r" + e.k, q = sm.get(key), n = q && q.shift();
            if (n === undefined) play = false; // (a sound with no part of its own)
            else {
              if (!sl[oi].parts[n].hit) play = false;
              else if (hp !== undefined && hp !== null && hp > t) t = hp; // (the head was hit late: its parts passed by then count from the press)
            }
          } // (no parts to go by: nominal)
        }
      } else if (o && o.kind === "spinner") {
        if (sp[oi] && !sp[oi].cleared) play = false;
      }
      if (play) out.push({ ...e, t, nt });
    }
    return byTime(out.concat(breaks())); // (equal times stay in map.sounds order, a break after the sounds at its time)
  } catch (err) { return nominal(); }
}
