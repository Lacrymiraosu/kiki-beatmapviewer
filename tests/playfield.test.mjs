// js/editor.js: the playfield limits (512 x 384 osu!px). The pure helpers between the PLAYFIELD-HELPERS markers, the nearby-object snap of
// placePoint and the transform plan (trPlan) are the real code from the file (the rest of editor.js needs the page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadScripts, J } from "./lib/browser.mjs";

const ed = readFileSync(new URL("../js/editor.js", import.meta.url), "utf8");
const grab = (from, to) => { const a = ed.indexOf(from), b = ed.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return ed.slice(a, b); };
const stubs = `
const A = { cur: () => 0 }, EDIT = { sel: new Set() }, S = { ds: false, grid: 0 };
const visibleRange = () => [0, map.hit.length - 1], endPos = o => [o.ex, o.ey], dsSnap = (x, y) => [x, y], lineById = id => map.lines.find(L => L.id === id);
const selObjs = () => map.hit.filter(o => EDIT.sel.has(o.lid)), tr = s => s;
`;
const P = loadScripts([], grab("const pfLimited = ", "const selObjs") + stubs + grab("const gridSnap", "const pfLimited") + grab("function placePoint(", "function placeCircle(") + grab("function lineGeom(", "// -> true (done)"));
const fit = (pts, dx, dy) => J(P.pfDeltaFit(pts, dx, dy));
const Q = P;
const grp = (after, before) => J(P.pfFitGroup(after, before));

test("a group move is cut by the group, not point by point: heads and slider control points keep their spacing", () => {
  // a circle at (100,100) and a slider with points (400,300) (500,380): moving by +50,+50 is limited by the slider's (500,380) -> +12,+4
  const pts = [[100, 100], [400, 300], [500, 380]];
  assert.deepEqual(fit(pts, 50, 50), { dx: 12, dy: 4 });
  assert.deepEqual(fit(pts, -300, -300), { dx: -100, dy: -100 }, "the circle (100,100) is the limit going up-left");
  assert.deepEqual(fit(pts, 5, -5), { dx: 5, dy: -5 }, "inside the limits: unchanged");
  assert.deepEqual(fit([], 7, 9), { dx: 7, dy: 9 }, "no points: nothing to limit");
});

test("boundary values exactly 0 / 512 / 384 are allowed; one past is not", () => {
  assert.deepEqual(fit([[0, 0], [512, 384]], 0, 0), { dx: 0, dy: 0 });
  assert.deepEqual(fit([[10, 10]], -10, -10), { dx: -10, dy: -10 }, "lands exactly on 0");
  assert.deepEqual(fit([[10, 10]], -11, -11), { dx: -10, dy: -10 });
  assert.deepEqual(fit([[500, 370]], 12, 14), { dx: 12, dy: 14 }, "lands exactly on 512 / 384");
  assert.deepEqual(fit([[500, 370]], 13, 15), { dx: 12, dy: 14 });
  assert.equal(J(P.pfOut([0, 0])), false); assert.equal(J(P.pfOut([512, 384])), false);
  assert.equal(J(P.pfOut([-1, 0])), true); assert.equal(J(P.pfOut([513, 0])), true); assert.equal(J(P.pfOut([0, 385])), true); assert.equal(J(P.pfOut([0, -1])), true);
});

test("a point that is already outside may move inward but never further out (per axis)", () => {
  assert.deepEqual(fit([[-20, 100]], -5, 0), { dx: 0, dy: 0 }, "further out: stopped");
  assert.deepEqual(fit([[-20, 100]], 15, 0), { dx: 15, dy: 0 }, "inward: allowed (even while it is still outside afterwards)");
  assert.deepEqual(fit([[-20, 100]], 60, 0), { dx: 60, dy: 0 }, "inward past the border: allowed");
  assert.deepEqual(fit([[530, 100]], 5, 0), { dx: 0, dy: 0 }); assert.deepEqual(fit([[530, 100]], -40, 0), { dx: -40, dy: 0 });
  assert.deepEqual(fit([[100, -3]], 0, -9), { dx: 0, dy: 0 }); assert.deepEqual(fit([[100, 400]], 0, 20), { dx: 0, dy: 0 }); assert.deepEqual(fit([[100, 400]], 0, -30), { dx: 0, dy: -30 });
  // the other axis is independent: a point outside in x does not stop the y movement
  assert.deepEqual(fit([[-20, 100]], -5, 30), { dx: 0, dy: 30 });
  // an outside point and an inside one together: the inside one limits inward-for-the-other
  assert.deepEqual(fit([[-20, 50], [300, 50]], 40, 0), { dx: 40, dy: 0 });
  assert.deepEqual(fit([[-20, 50], [500, 50]], 40, 0), { dx: 12, dy: 0 }, "the group stops when the right-hand point reaches 512");
});

test("a group wider than the field: the free side moves, an empty range means no move", () => {
  assert.deepEqual(fit([[-5, 10], [520, 10]], 30, 0), { dx: 0, dy: 0 }, "outside on both sides: cannot move along x");
  assert.deepEqual(fit([[10, 10], [520, 10]], -30, 0), { dx: -10, dy: 0 }, "outside on the right: may only go left");
  assert.equal(J(P.pfPick(5, 3, 1)), 0, "lo > hi -> 0");
  assert.equal(Object.is(P.pfPick(-0, 0, 0), 0), true, "never -0");
  assert.equal(Object.is(P.pfDeltaFit([[0, 0]], -4, -4).dx, 0), true);
});

test("fit-group: only points that need it trigger a shift, by the least movement", () => {
  const ok = [[10, 10], [20, 20]];
  assert.deepEqual(grp(ok, ok), { dx: 0, dy: 0 }, "all inside: nothing");
  assert.deepEqual(grp([[-30, 50], [100, 60]], [[10, 50], [140, 60]]), { dx: 30, dy: 0 }, "pushed in from the left by exactly 30");
  assert.deepEqual(grp([[500, 400], [520, 380]], [[100, 100], [120, 80]]), { dx: -8, dy: -16 }, "bottom-right overflow");
  assert.deepEqual(grp([[-5, 300], [20, 395]], null), { dx: 5, dy: -11 }, "no 'before': all points must be inside");
  assert.deepEqual(grp([[0, 0], [512, 384]], [[5, 5], [500, 300]]), { dx: 0, dy: 0 }, "exactly on the border is inside");
});

test("fit-group: a group bigger than the field can't fit (null)", () => {
  assert.equal(P.pfFitGroup([[-10, 0], [530, 0]], [[0, 0], [500, 0]]), null);
  assert.equal(P.pfFitGroup([[0, -10], [0, 400]], [[0, 0], [0, 300]]), null);
  assert.deepEqual(grp([[-10, 0], [502, 0]], [[0, 0], [500, 0]]), { dx: 10, dy: 0 }, "exactly 512 wide still fits");
});

test("fit-group: a point that was already outside may not end further out than it was (per coordinate)", () => {
  assert.deepEqual(grp([[-40, 10], [100, 10]], [[-40, 10], [100, 10]]), { dx: 0, dy: 0 }, "left where it was: nothing to do");
  assert.deepEqual(grp([[-30, 10], [100, 10]], [[-40, 10], [100, 10]]), { dx: 0, dy: 0 }, "moved inward by the transform: fine, still outside is allowed");
  assert.deepEqual(grp([[-80, 10], [100, 10]], [[-40, 10], [140, 10]]), { dx: 40, dy: 0 }, "the transform pushed it from -40 to -80: the group is brought back to -40, not further");
  assert.deepEqual(grp([[-40, 10], [-3, 10], [100, 10]], [[-40, 10], [30, 10], [140, 10]]), { dx: 3, dy: 0 }, "a newly outside point shifts the group; the old point at -40 moves to -37 (inward)");
  assert.deepEqual(grp([[-45, 10], [-3, 10]], [[-40, 10], [30, 10]]), { dx: 5, dy: 0 }, "both constraints: the old point back to -40 (+5), the new one inside (+3): +5 satisfies both");
  // the old point (-20) can't go further left, the new one (530) must come back by 18: no single shift does both
  assert.equal(P.pfFitGroup([[-20, 10], [530, 10]], [[-20, 10], [500, 10]]), null);
  // the other axis of a legacy point must stay inside: x is outside before, y is inside before
  assert.deepEqual(grp([[-20, 395]], [[-20, 100]]), { dx: 0, dy: -11 }, "x stays as it was, y must end inside");
  assert.deepEqual(grp([[-35, 100]], [[-20, 100]]), { dx: 15, dy: 0 }, "x pulled back to -20");
  assert.equal(P.pfFitGroup([[-35, 100], [600, 100]], [[-20, 100], [-100, 100]]), null, "bigger than the field");
});

test("clamping generated handles never makes a new equal consecutive point (osu! reads it as a red anchor)", () => {
  const dups = c => c.filter((q, i) => i && q[0] === c[i - 1][0] && q[1] === c[i - 1][1]).length;
  const cl = raw => J(P.pfClampList(raw));
  // the (0,0) corner: the anchor sits on it, the handle is beyond it
  assert.deepEqual(cl([[0, 0], [-5, -3], [20, 10], [60, 40]]), [[0, 0], [20, 10], [60, 40]], "handle -5,-3 -> (0,0) would equal the head: dropped");
  assert.deepEqual(cl([[0, 0], [-5, 3], [20, 10], [60, 40]]), [[0, 0], [0, 3], [20, 10], [60, 40]], "(0,3) is not the same as the head: kept");
  // the (512,384) corner
  assert.deepEqual(cl([[100, 100], [20, 10], [300, 300], [512, 384], [520, 390], [400, 200]]), [[100, 100], [20, 10], [300, 300], [512, 384], [400, 200]], "handle beyond the corner after the anchor");
  assert.deepEqual(cl([[300, 300], [530, 400], [520, 390], [512, 384], [512, 384], [400, 200]]), [[300, 300], [512, 384], [512, 384], [400, 200]], "two handles beyond the corner land on the anchor pair: they go, the pair stays");
  // a deliberate anchor (equal before the cut) stays, even when the cut moves both
  assert.deepEqual(cl([[100, 100], [50, 50], [-9, 4], [-9, 4], [20, 20], [60, 60]]), [[100, 100], [50, 50], [0, 4], [0, 4], [20, 20], [60, 60]], "an anchor pair outside is still a pair");
  assert.equal(dups(cl([[0, 0], [-5, -3], [-8, -9], [10, 10], [10, 10], [30, 30]])), 1, "only the deliberate anchor is left");
  // never the head or the last point
  assert.deepEqual(cl([[0, 0], [20, 20], [-4, -4]]), [[0, 0], [20, 20], [0, 0]], "the end stays (it is not a handle)");
});

test("an arc slider with a red anchor at a corner: the saved control points have no new consecutive duplicate", () => {
  // the real placeCurve (js/editor.js) and arcBeziers / arcProps (js/parse.js) on many random arcs near the (0,0) and (512,384) corners
  const Q = loadScripts(["js/parse.js"], "const S = {};" + grab("const pfLimited = ", "const selObjs") + grab("const SEG_TYPES", "// the points so far + the cursor") + `
function rounded(pts) { const segs = placeSegs(pts), R = p => [Math.round(p[0]), Math.round(p[1])], out = [R(pts[0])];
  for (const s of segs) { const t = segType(s), pieces = t === "L" ? s.slice(1).map((p, i) => [s[i], p]) : t === "P" ? arcBeziers(s) : [s]; for (const pc of pieces) { for (const q of pc.slice(1)) out.push(R(q)); out.push(R(pc[pc.length - 1])); } }
  out.pop(); return out; }`);
  const dups = c => c.filter((q, i) => i && q[0] === c[i - 1][0] && q[1] === c[i - 1][1]).length;
  let seed = 7; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  let n = 0, collided = 0;
  for (const [ox, oy, sx, sy] of [[0, 0, 1, 1], [512, 384, -1, -1]]) for (let k = 0; k < 1500; k++) {
    const pt = () => [Math.round(ox + sx * rnd() * 30), Math.round(oy + sy * rnd() * 30)];
    const a = pt(), m = pt(), c = pt(); if (rnd() < .5) { a[0] = ox; a[1] = oy; }
    const pts = [a, m, c, [Math.round(256 + rnd() * 50), Math.round(192 + rnd() * 50)]]; pts[2].red = true; pts.t = 0;
    const out = J(Q.placeCurve(pts)).cps, raw = J(Q.rounded(pts)), clampedRaw = raw.map(q => [Math.max(0, Math.min(512, q[0])), Math.max(0, Math.min(384, q[1]))]);
    n++; if (dups(clampedRaw) > dups(raw)) collided++;
    assert.ok(dups(out) <= dups(raw), "no consecutive duplicate that the unclamped points did not have: " + JSON.stringify(pts));
    assert.ok(out.every(([x, y]) => x >= 0 && x <= 512 && y >= 0 && y <= 384), "inside");
    assert.deepEqual(out[0], clampedRaw[0], "the head stays"); assert.deepEqual(out[out.length - 1], clampedRaw[clampedRaw.length - 1], "the end stays");
  }
  assert.ok(n === 3000 && collided > 100, "the scan does hit the corner collision (" + collided + " of " + n + " would have had a new duplicate)");
});

test("nearby-object snap: a new object snapped onto an object outside the field is placed inside", () => {
  const hit = [{ kind: "circle", lid: 1, t: 0, end: 0, x: -20, y: 100, ex: -20, ey: 100 }, { kind: "slider", lid: 2, t: 0, end: 0, x: 100, y: 100, ex: 530, ey: 400 }];
  const run = (x, y) => J(loadScripts([], grab("const pfLimited = ", "const selObjs") + stubs + grab("const gridSnap", "const pfLimited") + grab("function placePoint(", "function placeCircle(") + `
map = { hit: ${JSON.stringify(hit)}, preempt: 1000 }; var r = placePoint(${x}, ${y}, 0);`).r);
  assert.deepEqual(run(-18, 101), [0, 100], "snapped onto the object at x=-20 -> x clamped to 0");
  assert.deepEqual(run(528, 398), [512, 384], "snapped onto the slider end outside -> clamped to the corner");
  assert.deepEqual(run(101, 101), [100, 100], "a snap onto an inside object is exact, as before");
  assert.deepEqual(run(300, 200), [300, 200], "no object near: plain placement");
  assert.deepEqual(run(-50, 900), [0, 384], "plain placement outside is clamped too");
});

test("transform plan: rotate / scale near the border is shifted back in, refused when it can't fit, legacy points are left alone", () => {
  const lines = [{ id: 1, s: "480,100,1000,1,0,0:0:0:0:" }, { id: 2, s: "300,300,2000,2,0,B|400:300|460:340,1,200" }, { id: 3, s: "256,192,3000,12,0,4000,0:0:0:0:" }];
  const hit = [{ kind: "circle", lid: 1 }, { kind: "slider", lid: 2 }, { kind: "spinner", lid: 3 }];
  const T = (ids, code) => loadScripts([], grab("const pfLimited = ", "const selObjs") + stubs + grab("function lineGeom(", "// -> true (done)") + `
map = { hit: ${JSON.stringify(hit)}, lines: ${JSON.stringify(lines)} }; for (const i of ${JSON.stringify(ids)}) EDIT.sel.add(i);` + code);
  // scale 1.2 about (256,192): the circle (480,100) -> (525,82): newly outside; the whole group is shifted by the least amount
  let t = T([1, 2], `var plan = trPlan(([x, y]) => [256 + (x - 256) * 1.2, 192 + (y - 192) * 1.2]);`);
  const plan = J(t.plan);
  const xs = plan.items.flatMap(i => i.pts.map(q => q[0])), ys = plan.items.flatMap(i => i.pts.map(q => q[1]));
  assert.ok(plan.dx < 0 || plan.dy < 0, "shifted");
  assert.ok(xs.every(x => x + plan.dx >= 0 && x + plan.dx <= 512) && ys.every(y => y + plan.dy >= 0 && y + plan.dy <= 384), "all inside after the shift");
  assert.equal(Math.max(...xs) + plan.dx, 512, "least movement: the extreme point lands exactly on the border");
  assert.equal(plan.items.length, 2, "the spinner is not part of it");
  assert.equal(plan.items[1].pts.length, 3, "slider: head + 2 control points");
  // a scale of 3 about the centre can't fit
  t = T([1, 2], `var plan = trPlan(([x, y]) => [256 + (x - 256) * 3, 192 + (y - 192) * 3]);`); assert.equal(t.plan, null);
  // already outside before: a transform that would push it further out (-30 -> -40) is brought back by the shift: it stays at -30, never further out
  const L2 = [{ id: 1, s: "-30,100,1000,1,0,0:0:0:0:" }];
  const t2 = loadScripts([], grab("const pfLimited = ", "const selObjs") + stubs + grab("function lineGeom(", "// -> true (done)") + `
map = { hit: [{ kind: "circle", lid: 1 }], lines: ${JSON.stringify(L2)} }; EDIT.sel.add(1); var plan = trPlan(([x, y]) => [x - 10, y]);`);
  assert.equal(J(t2.plan).dx, 10); assert.deepEqual(J(t2.plan).items[0].pts, [[-40, 100]], "the plan's points are the unshifted result; with the shift it lands on -30");
});

// ---------- Settings -> Editor -> "Allow objects outside the playfield" (S.edOutside) ----------
const withOutside = v => { P.S.edOutside = v; };
const outsideOn = fn => { withOutside(true); try { fn(); } finally { withOutside(undefined); } };

test("edOutside: default (unset / false / anything but true) behaves exactly as before", () => {
  for (const v of [undefined, false, null, 0, "true", 1]) {
    withOutside(v);
    assert.equal(J(P.pfLimited()), true, String(v));
    assert.deepEqual(fit([[500, 370]], 50, 50), { dx: 12, dy: 14 });
    assert.deepEqual(J(P.clampPF(-50, 900)), [0, 384]);
    assert.equal(J(P.pfOut([513, 0])), true);
    assert.equal(P.pfFitGroup([[-10, 0], [530, 0]], [[0, 0], [500, 0]]), null);
    assert.deepEqual(J(P.pfClampList([[0, 0], [-5, 3], [20, 10], [60, 40]])), [[0, 0], [0, 3], [20, 10], [60, 40]]);
  }
  withOutside(undefined);
});

test("edOutside on: the helpers let objects go outside the field, up to the sanity range", () => {
  outsideOn(() => {
    assert.equal(J(P.pfLimited()), false);
    assert.deepEqual(J(P.clampPF(-50, 700)), [-50, 700], "placed where clicked");
    assert.deepEqual(J(P.clampPF(2000, -2000)), [1024, -384], "stray huge values stop at the sanity range");
    assert.deepEqual(J(P.clampPF(-2000, 2000)), [-512, 768]);
    assert.equal(J(P.pfOut([513, 0])), false); assert.equal(J(P.pfOut([-512, 768])), false); assert.equal(J(P.pfOut([-513, 0])), true); assert.equal(J(P.pfOut([0, 769])), true);
    // a group move is no longer stopped at the border...
    assert.deepEqual(fit([[500, 370]], 50, 50), { dx: 50, dy: 50 });
    assert.deepEqual(fit([[10, 10]], -300, -300), { dx: -300, dy: -300 });
    // ...only at the sanity range, and a point already past it may only come back
    assert.deepEqual(fit([[1000, 700]], 100, 100), { dx: 24, dy: 68 });
    assert.deepEqual(fit([[-600, 100]], -5, 0), { dx: 0, dy: 0 }); assert.deepEqual(fit([[-600, 100]], 50, 0), { dx: 50, dy: 0 });
    // a transform's result is kept as it is (nothing to fit), and the "bigger than the field" case fits
    assert.deepEqual(grp([[-30, 50], [100, 60]], [[10, 50], [140, 60]]), { dx: 0, dy: 0 });
    assert.deepEqual(grp([[-10, 0], [530, 0]], [[0, 0], [500, 0]]), { dx: 0, dy: 0 });
    assert.deepEqual(grp([[-600, 0], [100, 0]], [[0, 0], [100, 0]]), { dx: 88, dy: 0 }, "past the sanity range: pulled back to it");
    // generated slider handles: no cut at the border, none at all inside the range
    assert.deepEqual(J(P.pfClampList([[0, 0], [-5, -3], [20, 10], [60, 40]])), [[0, 0], [-5, -3], [20, 10], [60, 40]]);
    assert.deepEqual(J(P.pfClampList([[100, 100], [2000, 100], [300, 300]])), [[100, 100], [1024, 100], [300, 300]], "sanity range only");
  });
});

test("edOutside is read at the moment of use: toggling takes effect at once", () => {
  withOutside(false); assert.deepEqual(J(P.clampPF(-5, -5)), [0, 0]);
  withOutside(true); assert.deepEqual(J(P.clampPF(-5, -5)), [-5, -5]);
  withOutside(false); assert.deepEqual(J(P.clampPF(-5, -5)), [0, 0]); withOutside(undefined);
});

test("edOutside on: placePoint (with and without a nearby object to snap to) places where clicked", () => {
  const hit = [{ kind: "circle", lid: 1, t: 0, end: 0, x: -20, y: 100, ex: -20, ey: 100 }, { kind: "slider", lid: 2, t: 0, end: 0, x: 100, y: 100, ex: 530, ey: 400 }];
  const Q = loadScripts([], grab("const pfLimited = ", "const selObjs") + stubs + grab("const gridSnap", "const pfLimited") + grab("function placePoint(", "function placeCircle(") + `map = { hit: ${JSON.stringify(hit)}, preempt: 1000 };`);
  const run = (x, y) => J(Q.placePoint(x, y, 0));
  Q.S.edOutside = true;
  assert.deepEqual(run(-18, 101), [-20, 100], "snaps onto the object at x=-20 and stays there");
  assert.deepEqual(run(528, 398), [530, 400], "snapped onto the slider end outside");
  assert.deepEqual(run(-50, 900), [-50, 768], "plain placement outside; y at the sanity range");
  assert.deepEqual(run(700, -100), [700, -100]);
  assert.deepEqual(run(101, 101), [100, 100], "a snap onto an inside object is exact, as before");
  Q.S.edOutside = false;
  assert.deepEqual(run(-18, 101), [0, 100]); assert.deepEqual(run(-50, 900), [0, 384]);
});

test("edOutside on: trPlan does not shift or refuse; off, it does as before", () => {
  const lines = [{ id: 1, s: "480,100,1000,1,0,0:0:0:0:" }, { id: 2, s: "300,300,2000,2,0,B|400:300|460:340,1,200" }];
  const hit = [{ kind: "circle", lid: 1 }, { kind: "slider", lid: 2 }];
  const T = ids => loadScripts([], grab("const pfLimited = ", "const selObjs") + stubs + grab("function lineGeom(", "// -> true (done)") + `
map = { hit: ${JSON.stringify(hit)}, lines: ${JSON.stringify(lines)} }; for (const i of ${JSON.stringify(ids)}) EDIT.sel.add(i);`);
  const t = T([1, 2]), scale = k => `([x, y]) => [256 + (x - 256) * ${k}, 192 + (y - 192) * ${k}]`;
  t.S.edOutside = true;
  let plan = J(t.trPlan(eval(scale(1.2))));
  assert.deepEqual([plan.dx, plan.dy], [0, 0], "scale 1.2: left outside where it lands");
  assert.deepEqual(plan.items[0].pts, [[525, 82]]);
  plan = J(t.trPlan(eval(scale(3))));
  assert.ok(plan && plan.dx === 0 && plan.dy === 0, "scale 3 is applied, not refused");
  assert.deepEqual(plan.items[0].pts, [[928, -84]]);
  assert.equal(t.trPlan(eval(scale(30))), null, "a group bigger than the sanity range itself is refused");
  plan = J(t.trPlan(eval(scale(4))));
  assert.deepEqual([plan.dx, plan.dy], [-128, -16], "pulled back to the sanity range (x 1152 -> 1024, y 784 -> 768)");
  const xs = plan.items.flatMap(i => i.pts.map(q => q[0] + plan.dx)), ys = plan.items.flatMap(i => i.pts.map(q => q[1] + plan.dy));
  assert.ok(xs.every(x => x >= -512 && x <= 1024) && ys.every(y => y >= -384 && y <= 768), "inside the sanity range after the shift");
  t.S.edOutside = false;
  assert.equal(t.trPlan(eval(scale(3))), null, "off: refused, as before");
  assert.ok(J(t.trPlan(eval(scale(1.2)))).dx < 0, "off: shifted back in, as before");
});

test("pfCut: a drag counts as cut only by more than 1 osu!px, in the direction still being pulled", () => {
  const R = (dx, dy) => ({ dx, dy }), cut = (a, b) => P.pfCut(a, b);
  assert.equal(cut(R(10, 10), R(10, 10)), false, "not clamped");
  assert.equal(cut(R(0, 0), R(0, 0)), false, "no movement");
  assert.equal(cut(R(50, 0), R(12, 0)), true, "x cut");
  assert.equal(cut(R(0, -40), R(0, -3)), true, "y cut");
  assert.equal(cut(R(-30, 5), R(-10, 5)), true, "negative direction");
  assert.equal(cut(R(10, 10), R(9, 9)), false, "exactly 1 px short on both axes: rounding wobble");
  assert.equal(cut(R(10, 10), R(8.9, 10)), true, "just over 1 px");
  assert.equal(cut(R(-10, 0), R(-9, 0)), false); assert.equal(cut(R(-10, 0), R(-8, 0)), true);
  assert.equal(cut(R(20, 0), R(0, 0)), true, "fully blocked");
  assert.equal(cut(R(20, -20), R(20, 0)), true, "only y blocked, x free");
  assert.equal(cut(R(5, 5), R(8, 5)), false, "got longer than req (never from the clamp): no hint");
  assert.equal(cut(R(-5, 0), R(3, 0)), false, "opposite direction: not 'still pulling'");
  // with the real fit: a circle at (500,370) dragged 30 right / 4 down is cut in x only; dragged 12 / 14 it lands exactly on the border: no hint
  assert.equal(cut(R(30, 4), Q.pfDeltaFit([[500, 370]], 30, 4)), true);
  assert.equal(cut(R(12, 14), Q.pfDeltaFit([[500, 370]], 12, 14)), false);
  assert.equal(cut(R(13, 14), Q.pfDeltaFit([[500, 370]], 13, 14)), false, "1 px past: still under the threshold");
  assert.equal(cut(R(14, 14), Q.pfDeltaFit([[500, 370]], 14, 14)), true);
});

test("pfNote: the long hint once per session, the arrow-key short toast at most every 1.5 s", () => {
  const mk = () => ({ long: false, short: -Infinity }), note = (st, t, key, lim) => P.pfNote(st, t, key, lim);
  let st = mk();
  assert.equal(note(st, 1000, false), "long", "first cut drag: the hint");
  for (let t = 1010; t < 3000; t += 30) assert.equal(note(st, t, false), "", "the drag goes on: nothing");
  assert.equal(note(st, 90000, false), "", "a later drag in the same session: nothing");
  // arrow keys after the hint: short toast, throttled
  assert.equal(note(st, 100000, true), "short", "first blocked key after the hint");
  assert.equal(note(st, 100200, true), "", "key repeat: throttled"); assert.equal(note(st, 101499, true), "");
  assert.equal(note(st, 101500, true), "short", "1.5 s later again");
  assert.equal(note(st, 101600, true), "");
  // the arrow key first: the long hint, then the short one only after 1.5 s
  st = mk();
  assert.equal(note(st, 5000, true), "long");
  assert.equal(note(st, 5300, true), "", "right after the long hint: nothing"); assert.equal(note(st, 6499, true), "");
  assert.equal(note(st, 6500, true), "short");
  assert.equal(note(st, 7000, false), "", "a drag after the key hint: nothing (once per session)");
  // the setting on (not limited): never the long hint; the short toast stays throttled
  st = mk();
  assert.equal(note(st, 1000, false, false), ""); assert.equal(st.long, false, "and the session flag stays unused");
  assert.equal(note(st, 1000, true, false), "short"); assert.equal(note(st, 1500, true, false), ""); assert.equal(note(st, 2500, true, false), "short");
  assert.equal(note(st, 3000, false), "long", "after the setting is turned off again, the hint is still available");
  // the module state starts fresh with each page load
  assert.deepEqual(J(P.PF_HINT), { long: false, short: null }, "(-Infinity as JSON)");
});
