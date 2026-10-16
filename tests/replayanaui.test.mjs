// The Analysis layer's tab switch (js/replayanaui.js rpanTab): the panels are reused, so a fade-out that fills "forwards" must not
// outlive the switch (it pinned the panel at opacity 0 the next time it was shown: "the data disappears" on Timing / Aim).
// A tiny fake of the Web Animations API stands in for the browser: an animation has a start and an end value, ends on demand,
// and a finished one with fill "forwards" keeps its end value, a finished one without a fill stops having any effect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "./lib/browser.mjs";

function fakeDom() {
  const mk = id => {
    const p = { id, hidden: true, anims: [] };
    p.getAnimations = () => p.anims.filter(a => !a.dead);
    p.animate = (kf, o) => {
      let done, fail; const a = { kf, fill: o.fill || "none", dead: false, ended: false };
      a.finished = new Promise((res, rej) => { done = res; fail = rej; }); a.finished.catch(() => {}); // (the spec marks a cancelled animation's promise as handled)
      a.cancel = () => { if (a.dead) return; a.dead = true; fail(new Error("AbortError")); };
      a.end = () => { a.ended = true; done(); };
      p.anims.push(a); return a;
    };
    // what a person sees: the last live animation that is running (its start value at t = 0) or has ended with fill forwards (its end value)
    p.opacity = () => { let v = 1; for (const a of p.anims) { if (a.dead || !a.kf.opacity) continue; if (!a.ended) v = a.kf.opacity[0]; else if (a.fill === "forwards") v = a.kf.opacity[a.kf.opacity.length - 1]; } return v; };
    return p;
  };
  return [0, 1, 2, 3].map(i => mk("p" + i));
}
const flush = () => new Promise(r => setTimeout(r, 0));
async function setup({ rm = false } = {}) {
  const P = loadScripts(["js/replayanaui.js"], `
    const addEventListener = () => {}; const getComputedStyle = p => ({ opacity: String(p.opacity ? p.opacity() : 1) });
    const rpuRM = () => globalThis.__rm; const tr = s => s; const h = () => ({});
  `, { __rm: rm });
  const panels = fakeDom(), tabs = [0, 1, 2, 3].map(() => ({ setAttribute() {}, classList: { toggle() {} }, focus() {} }));
  P.RPAN.panels = panels; P.RPAN.tabs = tabs; P.RPAN.charts = []; P.RPAN.tab = 0; panels[0].hidden = false;
  const tab = n => P.rpanTab(n, false, false);
  // let every running animation end (oldest first), then let the promises run, until nothing is left running
  const settle = async () => { for (let i = 0; i < 6; i++) { for (const p of panels) for (const a of p.anims) if (!a.dead && !a.ended) a.end(); await flush(); } };
  return { P, panels, tab, settle, visible: () => panels.filter(p => !p.hidden) };
}

test("Timing -> Aim -> Timing: the panel is shown at opacity 1 once the animations are over", async () => {
  const { panels, tab, settle, visible } = await setup();
  tab(1); await settle(); assert.equal(visible()[0], panels[1]); assert.equal(panels[1].opacity(), 1);
  tab(0); await settle(); assert.equal(visible().length, 1); assert.equal(visible()[0], panels[0]);
  assert.equal(panels[0].opacity(), 1, "Timing came back faded out");
  tab(1); await settle(); assert.equal(panels[1].opacity(), 1, "Aim came back faded out");
});

test("every tab, many switches, in any order: the visible panel always ends at opacity 1 with no animation left", async () => {
  const { panels, tab, settle, visible } = await setup();
  for (const n of [1, 2, 3, 0, 2, 0, 1, 0, 3, 1, 0, 1, 2, 3, 2, 1, 0]) { tab(n); await settle(); assert.equal(visible().length, 1); assert.equal(visible()[0], panels[n]); assert.equal(panels[n].opacity(), 1, "tab " + n); assert.equal(panels[n].getAnimations().filter(a => a.fill === "forwards").length, 0); }
});

test("switching again in the middle of a fade (before it ends): still ends at opacity 1", async () => {
  const { panels, tab, settle, visible } = await setup();
  for (const seq of [[1, 0], [1, 2, 0], [1, 0, 1, 0, 3], [2, 1, 2, 1, 0]]) {
    for (const n of seq) tab(n); // (no settle between: each call lands while the last fade is still running)
    await settle(); const n = seq[seq.length - 1];
    assert.equal(visible().length, 1, JSON.stringify(seq)); assert.equal(visible()[0], panels[n]); assert.equal(panels[n].opacity(), 1, JSON.stringify(seq));
  }
});

test("the fade is kept: the old tab fades out first, the new one rises from 0", async () => {
  const { panels, tab, settle } = await setup();
  tab(1);
  assert.equal(panels[0].hidden, false, "the old tab stays until its fade is over");
  assert.deepEqual([...panels[0].anims[0].kf.opacity], [1, 0]); assert.equal(panels[0].anims[0].fill, "forwards");
  await settle();
  assert.equal(panels[0].hidden, true); assert.equal(panels[0].getAnimations().length, 0, "the fill is dropped once the panel is hidden");
  assert.equal(panels[1].hidden, false);
});

test("reduced motion: no animation at all, the panel is simply shown", async () => {
  const { panels, tab, settle } = await setup({ rm: true });
  for (const n of [1, 0, 1, 0, 2, 3, 0]) { tab(n); await settle(); assert.equal(panels[n].hidden, false); assert.equal(panels[n].opacity(), 1); }
  assert.equal(panels.reduce((s, p) => s + p.anims.length, 0), 0);
});
