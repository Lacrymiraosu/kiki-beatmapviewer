// The page under an overlay stays put (js/core.js pageLock): while any owner holds the lock (the beatmap detail panel, a pop-up over it,
// the live-session prompt) <html> has .plock (overflow hidden), and .plockg keeps a classic scrollbar's room so nothing moves. Owners are a
// set, not a counter: the detail panel's state is synced again and again, which must not drift, and a pop-up over the panel must not
// unlock the panel's hold (nor the other way round).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "js", "core.js"), "utf8");
const a = src.indexOf("// pageLock:start"), b = src.indexOf("// pageLock:end");
assert.ok(a > 0 && b > a, "the pageLock markers are in js/core.js");
function load(scrollbar = 0) {
  const cls = new Set(), props = new Map();
  const root = { clientWidth: 1440 - scrollbar, classList: { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)), toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); return on; } },
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) } };
  const cx = { Set, Math, innerWidth: 1440, document: { documentElement: root } }; vm.createContext(cx);
  vm.runInContext(src.slice(a, b) + "\nthis.pageLock = pageLock; this.lockOwners = lockOwners; this.PLOCK = PLOCK;", cx);
  return { ...cx, cls, props };
}

test("lockOwners: a set of owners; the same thing said twice changes nothing", () => {
  const { lockOwners } = load(), s = new Set();
  assert.equal(lockOwners(s, "detail", true), true); assert.equal(lockOwners(s, "detail", true), true); assert.equal(s.size, 1);
  assert.equal(lockOwners(s, "detail", false), false); assert.equal(lockOwners(s, "detail", false), false); assert.equal(s.size, 0);
});

test("pageLock: locks with the first owner, unlocks with the last; a pop-up over the panel doesn't unlock it", () => {
  const L = load(), mdl = {};
  L.pageLock("detail", true); assert.ok(L.cls.has("plock"));
  L.pageLock("detail", true); L.pageLock("detail", true); // (synced again and again)
  L.pageLock(mdl, true); L.pageLock(mdl, false); assert.ok(L.cls.has("plock"), "the pop-up closed: the panel still holds the page");
  L.pageLock("detail", false); assert.ok(!L.cls.has("plock"), "the panel closed: free");
  L.pageLock("detail", false); assert.ok(!L.cls.has("plock")); assert.equal(L.PLOCK.size, 0, "no owner left behind");
  // the other order: the panel goes while a pop-up is still open
  L.pageLock("detail", true); L.pageLock(mdl, true); L.pageLock("detail", false); assert.ok(L.cls.has("plock")); L.pageLock(mdl, false); assert.ok(!L.cls.has("plock"));
});

test("pageLock: a classic scrollbar's room is kept (.plockg + --plg), none with overlay scrollbars; all of it goes on unlock", () => {
  const L = load(15); L.pageLock("detail", true);
  assert.ok(L.cls.has("plockg")); assert.equal(L.props.get("--plg"), "15px");
  L.pageLock("detail", false); assert.ok(!L.cls.has("plockg") && !L.cls.has("plock")); assert.equal(L.props.has("--plg"), false);
  const O = load(0); O.pageLock("x", true); assert.ok(O.cls.has("plock") && !O.cls.has("plockg"), "overlay scrollbars: no gutter added (it would move the page)");
});
