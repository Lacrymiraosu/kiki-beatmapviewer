// Picking a difficulty in the beatmap detail panel (js/app.js pickDiff). Clicking the row that is already picked used to run the whole pick
// again: its strip was taken down and built anew, so it folded and opened again (the "box blinks" report), and the footer button was rebuilt.
// A repeated pick of the same difficulty is now nothing at all; a new pick, the silent first pick of a panel and a language redraw still do everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "js", "app.js"), "utf8");
const a = src.indexOf("// pickDiff:start"), b = src.indexOf("// pickDiff:end");
assert.ok(a > 0 && b > a, "the pickDiff markers are in js/app.js");

function make({ rm = false } = {}) {
  const log = [];
  const cls = () => { const s = new Set(); return { add: c => s.add(c), remove: c => s.delete(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)), contains: c => s.has(c) }; };
  const row = () => ({ classList: cls(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, scrollIntoView() { log.push("scroll"); } });
  const rows = [row(), row(), row()];
  const el = { dList: { classList: cls(), querySelectorAll: () => rows }, dGo: { replaceChildren: () => log.push("go"), title: "" } };
  const cx = {
    $: id => el[id], RM: rm, R: { inMap: true }, detailPick: null,
    detailInfo: { sid: 7, diffs: [{ bid: 1, name: "A" }, { bid: 2, name: "B" }, { bid: 3, name: "C" }], osuLink: null },
    dStripTo: (r, i, silent) => log.push("strip" + i + (silent ? "s" : "")), dRailPick: i => log.push("rail" + i),
    starEl: () => ({ removeAttribute() {}, setAttribute() {} }), h: () => ({}), tr: (k, o) => k.replace("{d}", o.d),
    osuSetURL: () => "", setMapURL: (s, bid) => log.push("url" + bid), setTimeout: () => 1, clearTimeout: () => {},
  };
  vm.createContext(cx); vm.runInContext(src.slice(a, b), cx);
  return { cx, log, rows, el };
}

test("clicking the picked row again changes nothing (no strip rebuilt, no footer rebuilt, no scroll, no URL write)", () => {
  const { cx, log, rows } = make();
  vm.runInContext("pickDiff(2, true)", cx); // (the panel opens: the hardest one is picked, silently)
  vm.runInContext("pickDiff(1)", cx); // (a click on another row)
  assert.ok(rows[1].classList.contains("on") && !rows[2].classList.contains("on"));
  log.length = 0;
  vm.runInContext("pickDiff(1)", cx); vm.runInContext("pickDiff(1)", cx); // (the same row clicked again, twice: the two clicks before a dblclick, Enter on its button)
  assert.deepEqual(log, [], "nothing ran");
  assert.ok(rows[1].classList.contains("on") && rows[1].attrs["aria-current"] === "true", "the row stays picked");
});

test("a new pick still does the whole job; the first silent pick and a redraw (detailPick reset) are not swallowed", () => {
  const { cx, log, el } = make();
  vm.runInContext("pickDiff(2, true)", cx);
  assert.deepEqual(log, ["strip2s", "rail2", "go"], "first pick (silent): strip, pills, footer");
  log.length = 0;
  vm.runInContext("pickDiff(0)", cx);
  assert.deepEqual(log, ["strip0", "rail0", "go", "scroll", "url1"], "a new pick: strip, pills, footer, scroll, ?b=");
  assert.ok(el.dList.classList.contains("dpk"), "the list is marked while the pick settles (css: no fades, no hover)");
  log.length = 0;
  vm.runInContext("detailPick = null; pickDiff(0, true)", cx); // (showDetail redraws the same panel: a language change)
  assert.deepEqual(log, ["strip0s", "rail0", "go"]);
});

test("reduced motion: no settle mark (nothing animates)", () => {
  const { cx, el } = make({ rm: true });
  vm.runInContext("pickDiff(2, true); pickDiff(0)", cx);
  assert.ok(!el.dList.classList.contains("dpk"));
});
