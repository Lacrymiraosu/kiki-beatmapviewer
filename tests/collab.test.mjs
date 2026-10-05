// The collab merge (js/collab.js): field split of .osu lines, convergence of concurrent edits, duplicate / out-of-order
// delivery, validation of what peers send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "./lib/browser.mjs";

const STUBS = `
const $ = () => ({ addEventListener() {}, set onclick(v) {}, hidden: true, append() {} });
const cv = { addEventListener() {} };
const tr = s => s, toast = () => {};
let EDIT = { undo: [], redo: [] }, ANN = { list: [] }, osuFiles = [], curDiff = 0, dirty = false;
function updateEdUI() {}
`;
const P = loadScripts(["js/collab.js"], STUBS);

const LINES = [
  "100,100,0,5,0,0:0:0:0:", "256,192,500,12,4,1000,1:2:0:0:", "256,192,500,12,4,1000", "50,60,1500,2,2,B|60:70|80:90|80:90|100:50,2,120.5,2|0|8,1:0|0:0|2:3,0:0:0:0:",
  "50,60,1500,6,0,L|100:60,1,50", "1,2,3,1,0,0:0:0:0:hit.wav", "1,2,3,1,0,", "10,10,10,38,0,P|20:30|40:10,1,70.0000001,4|0,0:0|0:0,0:0:0:0:",
];

test("a .osu line survives the split into fields and back unchanged", () => {
  for (const s of LINES) assert.equal(P.fieldsLine(P.lineFields(s)), s, s);
});

// three peers editing the same objects at the same time, receiving each other's changes late, twice, out of order
test("concurrent edits converge to the same state everywhere", () => {
  const C = P.COLLAB;
  const base = P.docNew(), c0 = [0, "", "init"];
  const ids = [];
  LINES.forEach((s, i) => { const id = String(1000 + i); ids.push(id); const e = P.docEntry(base.o, id), f = P.lineFields(s); for (const k in f) { e.f[k] = f[k]; e.c[k] = c0; } e.f.x = 1; e.c.x = c0; });
  const snap = JSON.stringify(P.docJSON(base));
  const peers = ["peerA", "peerB", "peerC"].map((name, n) => ({ doc: P.docLoad(JSON.parse(snap)), clock: 0, seq: 0, vv: {}, seen: new Set(), log: [], me: { peer: name, uid: n + 1 } }));
  const use = p => Object.assign(C, p), save = p => Object.assign(p, { doc: C.doc, clock: C.clock, seq: C.seq, vv: C.vv, seen: C.seen, log: C.log });
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const sent = [];
  for (let round = 0; round < 60; round++) {
    const p = peers[rnd(3)]; use(p);
    const id = ids[rnd(ids.length)], what = rnd(5), ch = [];
    if (what === 0) ch.push(["o", id, "g", [String(rnd(512)), String(rnd(384))]]);
    else if (what === 1) ch.push(["o", id, "h", [String(rnd(15))]]);
    else if (what === 2) ch.push(["o", id, "x", rnd(2)]);
    else if (what === 3) { const nid = String(5000 + round); ids.push(nid); ch.push(["o", nid, "k", "1"], ["o", nid, "t", [String(round * 100)]], ["o", nid, "g", ["1", "2"]], ["o", nid, "h", ["0"]], ["o", nid, "x", 1]); }
    else ch.push(["k", "d.ApproachRate", "v", String(rnd(10))]);
    const op = P.makeOp(ch, "test"); P.applyOp(op, null); save(p);
    assert.equal(P.validOp(op), true);
    sent.push(op);
    // deliver some pending ops to a random other peer, in random order
    if (rnd(3) === 0) { const q = peers[rnd(3)]; use(q); for (const o of sent.slice().sort(() => rnd(3) - 1)) if (!P.haveOp(o)) P.applyOp(o, null); save(q); }
  }
  // final delivery: everything, shuffled, with duplicates
  for (const q of peers) { use(q); const all = [...sent, ...sent].sort(() => rnd(3) - 1); for (const o of all) if (!P.haveOp(o)) P.applyOp(o, null); save(q); }
  const hashes = peers.map(q => { use(q); return P.docHash(); });
  assert.equal(new Set(hashes).size, 1, "all copies identical: " + hashes);
  for (const q of peers) assert.deepEqual({ ...q.vv }, { peerA: sent.filter(o => o.peer === "peerA").length, peerB: sent.filter(o => o.peer === "peerB").length, peerC: sent.filter(o => o.peer === "peerC").length });
});

test("a field keeps the change with the latest stamp; ties go to the higher peer id", () => {
  const C = P.COLLAB;
  Object.assign(C, { doc: P.docNew(), clock: 0, seq: 0, vv: {}, seen: new Set(), log: [], me: { peer: "a", uid: 1 } });
  P.applyOp({ id: "b:1", peer: "b", seq: 1, by: 2, l: 5, ch: [["o", "1", "g", ["10", "10"]]] }, null);
  P.applyOp({ id: "a:1", peer: "a", seq: 1, by: 1, l: 5, ch: [["o", "1", "g", ["20", "20"]]] }, null);
  P.applyOp({ id: "c:1", peer: "c", seq: 1, by: 3, l: 4, ch: [["o", "1", "g", ["30", "30"]]] }, null);
  assert.deepEqual([...C.doc.o.get("1").f.g], ["10", "10"]);
});

test("operations with bad structure or values are refused", () => {
  const ok = { id: "p:1", peer: "p", seq: 1, by: 1, l: 1, ch: [["o", "12", "g", ["1", "2"]]] };
  assert.equal(P.validOp(ok), true);
  const bad = [
    { ...ok, id: "q:1" },                                   // id doesn't match peer:seq
    { ...ok, ch: [["o", "12", "g", ["1,2,3,4", "2"]]] },    // a comma would inject extra fields into the .osu line
    { ...ok, ch: [["o", "12", "k", "abc"]] },
    { ...ok, ch: [["o", "12", "t", ["1\n2"]]] },
    { ...ok, ch: [["o", "x1", "g", ["1", "2"]]] },           // object ids are numbers
    { ...ok, ch: [["q", "12", "g", ["1", "2"]]] },
    { ...ok, ch: [["k", "../x", "v", "1"]] },
    { ...ok, ch: [["p", "tp1", "v", "0,500\n[Events]"]] },
    { ...ok, ch: [] },
  ];
  for (const b of bad) assert.equal(P.validOp(b), false, JSON.stringify(b.ch));
});

test("a clock far ahead of ours is refused (it would push everyone's next changes past the cap); so are prototype peer ids", () => {
  const C = P.COLLAB, was = C.clock; C.clock = 50;
  const op = l => ({ id: "p:1", peer: "p", seq: 1, by: 1, l, ch: [["o", "12", "g", ["1", "2"]]] });
  assert.equal(P.validOp(op(50 + 1e6)), true); assert.equal(P.validOp(op(1e12)), false);
  assert.equal(P.validOp({ ...op(1), id: "constructor:1", peer: "constructor" }), false);
  C.clock = was;
});

test("duplicates are ignored and the version vector only counts gapless sequences", () => {
  const C = P.COLLAB;
  Object.assign(C, { doc: P.docNew(), clock: 0, seq: 0, vv: {}, seen: new Set(), log: [], me: { peer: "me", uid: 1 } });
  const op = n => ({ id: "x:" + n, peer: "x", seq: n, by: 2, l: n, ch: [["o", "1", "h", [String(n)]]] });
  P.applyOp(op(1), null); P.applyOp(op(3), null);
  assert.equal(C.vv.x, 1, "3 arrived before 2");
  assert.equal(P.haveOp(op(3)), true);
  P.applyOp(op(2), null);
  assert.equal(C.vv.x, 3);
  assert.deepEqual([...C.doc.o.get("1").f.h], ["3"]);
});
