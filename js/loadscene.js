"use strict";
// ============ loading scene ============
// The loading cover (#loading) always shows one scene: three numbered notes whose approach circles close and which pop on their own beat, 1 then 2 then 3.
// Looping motion is CSS keyframes on transform/opacity only (assets/app.css "the loading scene"), so it keeps moving while the main thread is busy.
// Progress (p >= 0) is drawn from showLoading (ldsShow) and never goes back within one flow.

const LDS = { st: null, hidAt: 0, mode: "", q: -2 };

// ---------- progress state (pure) ----------
// One flow = one cover session; a new flow starts when the cover was hidden for more than 600 ms.
// prog is the most progress drawn so far in the flow (-1 = none yet). mode: "lp" loop (nothing drawn yet), "dt" determinate,
// "hd" holding what was drawn while the flow is indeterminate again.
const LDS_GAP = 600;
function ldsStep(st, p, now, hidAt) {
  const fresh = !st || (hidAt > 0 && now - hidAt > LDS_GAP);
  let prog = fresh ? -1 : st.prog;
  if (p >= 0) prog = Math.max(prog, Math.min(1, p));
  // 0% draws nothing yet, so it keeps the loop (several flows sit on "… 0%" for a while)
  return { prog, mode: !(prog > 0) ? "lp" : p >= 0 ? "dt" : "hd" };
}

// ---------- scene geometry (pure; must match the SVG in index.html) ----------
const LDS_NOTES = [[28, 86], [62, 52], [97, 80]];
// how many of the three notes are hit at progress q, and how far the next one's approach circle has closed
function ldsReplayAt(q) {
  const x = Math.max(0, Math.min(1, q)) * 3, hits = Math.min(3, Math.floor(x + 1e-9));
  return { hits, frac: hits < 3 ? x - hits : 1 };
}

// ---------- rendering (DOM) ----------
const ldsTr = (x, y) => `translate(${x.toFixed(2)}px,${y.toFixed(2)}px)`;
function ldsDraw(sc, q) { // q < 0: back to the CSS (loop, or the reduced-motion frame)
  const notes = sc.querySelectorAll(".rn"), aps = sc.querySelectorAll(".ra"), pulse = sc.querySelector(".rq");
  if (q < 0) { for (const e of [...notes, ...aps, pulse]) e.style.opacity = e.style.transform = ""; return; }
  const { hits, frac } = ldsReplayAt(q);
  notes.forEach((e, i) => { e.style.opacity = i < hits ? ".22" : "1"; e.style.transform = i < hits ? "scale(.9)" : "scale(1)"; });
  aps.forEach((e, i) => { const on = i === hits; e.style.opacity = on ? ".9" : "0"; e.style.transform = `scale(${on ? (1 + .9 * (1 - frac)).toFixed(3) : 1})`; });
  const at = LDS_NOTES[Math.min(hits, 2)]; // a ring pulses from the note that is waiting to be hit (the last one once all three are)
  pulse.style.transform = ldsTr(at[0], at[1]);
}
// called by showLoading
function ldsShow(p) {
  const now = Date.now();
  LDS.st = ldsStep(LDS.st, p, now, LDS.hidAt); LDS.hidAt = 0;
  const sc = typeof document !== "undefined" && document.getElementById("ldStage");
  if (!sc) return;
  const { mode, prog } = LDS.st;
  if (LDS.mode !== mode) { // only on a change: re-setting classes would restart the loop
    sc.classList.remove("lp", "dt", "hd"); sc.classList.add(mode);
    LDS.mode = mode;
  }
  const q = mode === "lp" ? -1 : prog;
  if (LDS.q !== q) { LDS.q = q; ldsDraw(sc, q); }
}
function ldsHidden() { LDS.hidAt = Date.now(); LDS.mode = ""; }
