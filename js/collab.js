"use strict";
// ============ Collab: map one difficulty together, everyone editing at once ============
// Not the same as a Live session. Live = the host's browser holds the map and lends a pen (host decides every edit).
// Collab = every browser holds its own full copy and edits it directly; changes are exchanged peer-to-peer (WebRTC data
// channels through PeerJS) and merged so that all copies end up identical, whatever order they arrive in.
//
// How the merge works (a CRDT, "last writer wins" per field):
// * Objects are keyed by their stable id (adoptIds). Each [HitObjects] line is split into fields: k = type (kind, new
//   combo, colour skip), t = time (+ spinner end), g = position (+ slider path and length), r = slider repeats,
//   h = hitsounds (+ slider edge sounds/sets and sample), x = exists (0 = deleted, so deleting and undoing a delete merge).
//   Timing points (by a collab id), General/Metadata/Difficulty keys, bookmarks and annotations are fields too.
// * Every change is an operation stamped with a Lamport clock + peer id. For each field the change with the biggest
//   stamp wins, everywhere. Moving an object while someone changes its hitsounds keeps both; two people moving the same
//   object at the same time end with the same (latest) position for both.
// * Operations have ids (peer:seq); duplicates are ignored, late or out-of-order ones still merge to the same result.
//   Reconnecting peers exchange what the other is missing (version vectors); a state hash every few seconds catches
//   anything else and triggers a full resync.
// * Undo/redo only touch your own changes, and only fields nobody has changed since (it never undoes someone else's work).
// Topology: everyone connects to the session host, who relays. The host checks each sender: verified osu! login
// (server-signed ticket) and role (editor/viewer) set by the host; a viewer's or forged operation is refused and that
// peer is resynced. Signalling uses the public PeerJS server; if two browsers can't connect directly a TURN relay is
// needed (PeerJS's public one by default, or your own via /api/v1/ice).
const COLLAB = { on: false, host: false, code: "", peer: null, conns: new Map(), hostConn: null, me: null, members: new Map(), roles: new Map(),
  status: "", doc: null, clock: 0, seq: 0, vv: {}, seen: new Set(), log: [], undo: [], redo: [], diff: "", opening: false, snapWait: null, early: [],
  defaultRole: "editor", lastPres: 0, presKey: "", sumBad: 0, pkg: null, pkgBlob: null, pkgKey: "", sumTimer: 0, retry: 0, hostPeer: "", mx: -999, my: -999, draftChecked: false,
  turn: null, relay: false, noTurn: false, ping: null, autoDone: false, directPing: null, switching: false, pingTimer: 0, tick: 0 };
const COLLAB_PROTO = 1, COLLAB_MAX = 8, COLLAB_LOG_MAX = 50000;
const COLLAB_COLS = ["#66ccff", "#ffd84a", "#57d68d", "#b35cff", "#ff8a4d", "#4dffd2", "#ff5a6e", "#ff66aa"];
const collabCanEdit = () => !COLLAB.on || COLLAB.host || !!COLLAB.me && COLLAB.me.role === "editor";
function collabNoEdit() { toast(tr("View only: the host of this collab session made you a viewer"), 2500); }
const cpeerId = code => "obv-collab-" + code;
const collabURL = () => location.origin + location.pathname + "?collab=" + COLLAB.code + (COLLAB.noTurn ? "&nt=1" : "");
const csend = (c, msg) => { try { if (c && c.open) c.send(msg); } catch {} };
const cbroadcast = (msg, except) => { for (const [id, e] of COLLAB.conns) if (id !== except && e.m) csend(e.c, msg); };

// ---------- the shared document ----------
const newer = (a, b) => !b || a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const docNew = () => ({ o: new Map(), p: new Map(), k: new Map(), a: new Map() });
function docEntry(store, id) { let e = store.get(id); if (!e) { e = { f: {}, c: {} }; store.set(id, e); } return e; }
// a [HitObjects] line <-> fields (fieldsLine(lineFields(s)) === s for every line)
function lineFields(s) {
  const p = s.split(","), type = +p[3];
  if (p.length < 5 || !isFinite(type)) return { k: "", t: [p[2] || "0"], g: [], r: null, h: [], z: s };
  if (type & 2) return { k: p[3], t: [p[2]], g: [p[0], p[1], p[5] ?? null, p[7] ?? null], r: p[6] ?? null, h: [p[4], ...p.slice(8)] };
  if (type & 8) return { k: p[3], t: [p[2], p[5] ?? null], g: [p[0], p[1]], r: null, h: [p[4], ...p.slice(6)] };
  return { k: p[3], t: [p[2]], g: [p[0], p[1]], r: null, h: [p[4], ...p.slice(5)] };
}
function fieldsLine(f) {
  if (!f.k && f.z != null) return f.z;
  const type = +f.k, g = f.g || [], t = f.t || ["0"], hs = f.h || ["0"];
  const out = a => { while (a.length && a[a.length - 1] == null) a.pop(); return a.map(v => v ?? "").join(","); };
  if (type & 2 && g[2] != null) return out([g[0], g[1], t[0], f.k, hs[0], g[2], f.r ?? "1", g[3], ...hs.slice(1)]);
  if (type & 8) return out([g[0] ?? "256", g[1] ?? "192", t[0], f.k, hs[0], t[1] ?? String(+t[0] + 1), ...hs.slice(1)]);
  return out([g[0], g[1], t[0], type & 2 ? String((type & ~2) | 1) : f.k, hs[0], ...hs.slice(1)]); // a slider without a path stays a valid circle
}
const OBJ_FIELDS = ["k", "t", "g", "r", "h", "z"];
const cid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
// annotations in the shared document; time/"object deleted" of an attached one are worked out by each browser from the objects
// (no undefined values: PeerJS's encoding turns them into null, and the copies must compare equal)
function annPlain(a) {
  if (!a || a.local === "deleted") return null;
  const v = { id: a.id, diff: a.diff, kind: a.kind, object_id: a.object_id || null, body: a.body || "", data: a.data || {}, author: a.author || null, created_at: a.created_at || null };
  if (!a.object_id) v.time_ms = a.time_ms;
  return v;
}
const annEq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const vvEq = (a, b) => { a = a || {}; b = b || {}; const ks = new Set([...Object.keys(a), ...Object.keys(b)]); for (const k of ks) if ((a[k] || 0) !== (b[k] || 0)) return false; return true; };
// what the map looks like right now, as field values
function mapState() {
  const o = new Map(), p = new Map(), k = new Map(), a = new Map();
  for (const L of map.lines) o.set(String(L.id), lineFields(L.s));
  for (const tp of map.timing) { if (!tp.cid) tp.cid = cid(); p.set(tp.cid, timingLine(tp)); }
  for (const [pre, obj] of [["g", map.general], ["m", map.meta], ["d", map.diff], ["c", map.colourKV]]) for (const key in obj) k.set(pre + "." + key, String(obj[key]));
  k.set("bm", JSON.stringify(map.bookmarks.map(Math.round)));
  for (const x of ANN.list) if (x.diff === COLLAB.diff) a.set(x.id, annPlain(x));
  return { o, p, k, a };
}
function docFromMap() {
  const d = docNew(), c0 = [0, "", "init"], st = mapState();
  for (const [id, f] of st.o) { const e = docEntry(d.o, id); for (const fld of OBJ_FIELDS) if (f[fld] !== undefined) { e.f[fld] = f[fld]; e.c[fld] = c0; } e.f.x = 1; e.c.x = c0; }
  for (const ty of ["p", "k", "a"]) for (const [id, v] of st[ty]) { if (v == null) continue; const e = docEntry(d[ty], id); e.f.v = v; e.c.v = c0; }
  return d;
}
function docJSON(d) { const ser = s => [...s].map(([id, e]) => [id, e.f, e.c]); return { o: ser(d.o), p: ser(d.p), k: ser(d.k), a: ser(d.a) }; }
function docLoad(j) {
  const d = docNew();
  for (const ty of ["o", "p", "k", "a"]) for (const [id, f, c] of j[ty] || []) if (typeof id === "string" && f && c) d[ty].set(id, { f, c });
  return d;
}
function docHash() {
  let x = 2166136261; const add = s => { for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } };
  const d = COLLAB.doc;
  for (const id of [...d.o.keys()].sort()) { const e = d.o.get(id); if (e.f.x) add(id + "=" + fieldsLine(e.f) + ";"); }
  for (const ty of ["p", "k", "a"]) for (const id of [...d[ty].keys()].sort()) { const v = d[ty].get(id).f.v; if (v != null) add(ty + id + "=" + (typeof v === "string" ? v : JSON.stringify(v)) + ";"); }
  return (x >>> 0).toString(36);
}

// ---------- operations ----------
const FIELDS = { o: new Set(["x", ...OBJ_FIELDS]), p: new Set(["v"]), k: new Set(["v"]), a: new Set(["v"]) };
const okStr = (s, n) => s === null || (typeof s === "string" && s.length <= n && !/[,\r\n]/.test(s));
function validOp(op) {
  if (!op || typeof op !== "object" || typeof op.id !== "string" || op.id.length > 120 || typeof op.peer !== "string" || op.peer.length > 80 || op.id !== op.peer + ":" + op.seq) return false;
  if (!Number.isInteger(op.seq) || op.seq < 1 || !Number.isFinite(op.l) || op.l < 0 || op.l > 1e12 || !Array.isArray(op.ch) || !op.ch.length || op.ch.length > 20000) return false;
  // a clock far ahead of ours would push everyone's next changes past the cap (and win every field): a real one only
  // runs ahead by the number of changes made elsewhere; no peer id that's a property of every object (vv is a plain object)
  if (op.l > COLLAB.clock + 1e6 || op.peer in Object.prototype) return false;
  for (const c of op.ch) {
    if (!Array.isArray(c) || c.length !== 4) return false;
    const [ty, id, fld, v] = c;
    if (!FIELDS[ty] || !FIELDS[ty].has(fld) || typeof id !== "string") return false;
    if (ty === "o") {
      if (!/^\d{1,16}$/.test(id)) return false;
      if (fld === "x") { if (v !== 0 && v !== 1) return false; }
      else if (fld === "k") { if (typeof v !== "string" || !/^\d{1,4}$/.test(v)) return false; }
      else if (fld === "r") { if (v !== null && (typeof v !== "string" || !/^\d{1,5}$/.test(v))) return false; }
      else if (fld === "t") { if (!Array.isArray(v) || v.length > 2 || !v.every(x => x === null || (typeof x === "string" && /^-?\d{1,9}(\.\d+)?$/.test(x)))) return false; }
      else if (fld === "z") { if (v !== null && (typeof v !== "string" || v.length > 5000 || /[\r\n]/.test(v))) return false; }
      else if (!Array.isArray(v) || v.length > 40 || !v.every(s => okStr(s, 8000))) return false;
    } else if (ty === "a") {
      if (!/^[0-9a-f-]{36}$/.test(id) || (v !== null && (typeof v !== "object" || Array.isArray(v) || v.id !== id || JSON.stringify(v).length > 8000))) return false;
    } else {
      if (id.length > 64 || (v !== null && (typeof v !== "string" || v.length > 4000 || /[\r\n]/.test(v)))) return false;
      if (ty === "k" && !/^(bm|[gmdc]\.[A-Za-z][\w ]{0,40})$/.test(id)) return false;
    }
  }
  return true;
}
function markSeen(op) {
  COLLAB.seen.add(op.id);
  let n = Object.prototype.hasOwnProperty.call(COLLAB.vv, op.peer) ? COLLAB.vv[op.peer] : 0;
  while (COLLAB.seen.has(op.peer + ":" + (n + 1))) n++;
  COLLAB.vv[op.peer] = n;
  COLLAB.log.push(op);
  if (COLLAB.log.length > COLLAB_LOG_MAX) COLLAB.log.splice(0, COLLAB.log.length - COLLAB_LOG_MAX);
}
const haveOp = op => COLLAB.seen.has(op.id);
// apply to the document; returns the set of changed items (for materialize)
function applyOp(op, changed) {
  COLLAB.clock = Math.max(COLLAB.clock, op.l);
  const stamp = [op.l, op.peer, op.id];
  for (const [ty, id, fld, v] of op.ch) {
    const e = docEntry(COLLAB.doc[ty], id);
    if (newer(stamp, e.c[fld])) { e.f[fld] = v; e.c[fld] = stamp; changed && changed.add(ty + "\u0000" + id); }
  }
  markSeen(op);
}
function makeOp(ch, label) {
  COLLAB.clock++; COLLAB.seq++;
  return { id: COLLAB.me.peer + ":" + COLLAB.seq, peer: COLLAB.me.peer, seq: COLLAB.seq, by: COLLAB.me.uid, l: COLLAB.clock, ch, label: String(label || "").slice(0, 60), at: Date.now() };
}
// document -> the open map (only what changed)
function materialize(changed, all) {
  if (!map || !COLLAB.doc) return;
  const d = COLLAB.doc; let lines = all, timing = all, kv = all, anns = all;
  if (!all) for (const key of changed) { const ty = key[0]; if (ty === "o") lines = true; else if (ty === "p") timing = true; else if (ty === "k") kv = true; else if (ty === "a") anns = true; }
  if (lines) {
    const byId = new Map(map.lines.map(L => [String(L.id), L]));
    const ids = all ? [...new Set([...byId.keys(), ...d.o.keys()])] : [...changed].filter(k => k[0] === "o").map(k => k.slice(2));
    for (const id of ids) {
      const e = d.o.get(id);
      if (!e || !e.f.x) { byId.delete(id); continue; }
      const s = fieldsLine(e.f), L = byId.get(id);
      if (L) L.s = s; else byId.set(id, { id: Number(id), s });
    }
    map.lines = [...byId.values()];
  }
  if (timing) {
    map.timing = [];
    for (const [id, e] of d.p) { if (e.f.v == null) continue; const tp = parseTimingLine(e.f.v); if (tp) { tp.cid = id; map.timing.push(tp); } }
  }
  if (kv) {
    const g = {}, m = {}, df = {}, c = {};
    for (const [id, e] of d.k) {
      if (e.f.v == null) continue;
      if (id === "bm") { try { map.bookmarks = JSON.parse(e.f.v).filter(Number.isFinite); } catch {} continue; }
      const obj = ({ g, m, d: df, c })[id[0]]; if (obj) obj[id.slice(2)] = e.f.v;
    }
    map.general = g; map.meta = m; map.diff = df; map.colourKV = c;
  }
  if (anns) {
    const others = ANN.list.filter(a => a.diff !== COLLAB.diff), mine = new Map(ANN.list.filter(a => a.diff === COLLAB.diff).map(a => [a.id, a]));
    const list = [];
    for (const [id, e] of d.a) { const v = e.f.v; if (!v) continue; const old = mine.get(id); list.push(old && annEq(annPlain(old), v) ? old : { ...v, time_ms: v.time_ms ?? (old ? old.time_ms : 0), object_missing: old ? !!old.object_missing : false, version: old ? old.version || 0 : 0, local: old ? old.local || "edited" : "new" }); }
    ANN.list = others.concat(list);
  }
  if (lines || timing || kv) rebuildEdit(true);
  else { drawTimeline(); annRerender(); }
  dirty = true;
}

// ---------- local edits -> operations ----------
function diffChanges(before) {
  const ch = [], now = mapState();
  const prevO = new Map(before.lines.map(L => [String(L.id), L.s]));
  for (const [id, f] of now.o) {
    const ps = prevO.get(id);
    if (ps === undefined) { for (const fld of OBJ_FIELDS) if (f[fld] !== undefined) ch.push(["o", id, fld, f[fld]]); ch.push(["o", id, "x", 1]); continue; }
    const s = fieldsLine(f); if (ps === s) continue;
    const pf = lineFields(ps);
    for (const fld of OBJ_FIELDS) if (JSON.stringify(pf[fld] ?? null) !== JSON.stringify(f[fld] ?? null)) ch.push(["o", id, fld, f[fld] ?? null]);
  }
  for (const id of prevO.keys()) if (!now.o.has(id)) ch.push(["o", id, "x", 0]);
  // timing points, keys, bookmarks, annotations: compared with the shared document
  const d = COLLAB.doc;
  for (const ty of ["p", "k", "a"]) {
    const cur = now[ty];
    for (const [id, v] of cur) { const e = d[ty].get(id), old = e ? e.f.v : undefined; if (!annEq(old, v)) ch.push([ty, id, "v", v]); }
    for (const [id, e] of d[ty]) if (!cur.has(id) && e.f.v != null) ch.push([ty, id, "v", null]);
  }
  return ch;
}
function commitChanges(ch, label, undoable = true) {
  if (!ch.length) return null;
  const d = COLLAB.doc, prev = ch.map(([ty, id, fld]) => { const e = d[ty].get(id); return e ? [e.f[fld], e.c[fld]] : [undefined, null]; });
  const op = makeOp(ch, label);
  applyOp(op, null);
  if (undoable) { COLLAB.undo.push({ op, prev }); if (COLLAB.undo.length > 200) COLLAB.undo.shift(); COLLAB.redo = []; }
  if (COLLAB.host) cbroadcast({ t: "op", op }); else csend(COLLAB.hostConn, { t: "op", op });
  updateEdUI(); collabLogSoon();
  return op;
}
function collabLocalCommit(before, label) {
  if (!COLLAB.doc || COLLAB.opening || osuFiles[curDiff].path !== COLLAB.diff) return;
  commitChanges(diffChanges(before), label);
}
// after replacing the map wholesale (a restored draft): send the difference from the shared state
function collabPushLocal(label) {
  if (!COLLAB.on || !COLLAB.doc || osuFiles[curDiff].path !== COLLAB.diff) return;
  const lines = []; for (const [id, e] of COLLAB.doc.o) if (e.f.x) lines.push({ id, s: fieldsLine(e.f) });
  commitChanges(diffChanges({ lines }), label);
}
function collabAnnChanged(a) {
  if (!COLLAB.on || !COLLAB.doc || a.diff !== COLLAB.diff) return;
  if (!collabCanEdit()) return;
  const v = annPlain(ANN.list.includes(a) ? a : null), e = COLLAB.doc.a.get(a.id);
  if (annEq(e ? e.f.v : null, v)) return;
  commitChanges([["a", a.id, "v", v]], "Annotation", false);
}
// undo / redo: revert only the fields that still hold your change
function collabUndoRedo(fromUndo) {
  if (!collabCanEdit()) return collabNoEdit();
  const from = fromUndo ? COLLAB.undo : COLLAB.redo, to = fromUndo ? COLLAB.redo : COLLAB.undo;
  const ent = from.pop(); if (!ent) { toast(tr(fromUndo ? "Nothing to undo" : "Nothing to redo"), 1200); return; }
  const d = COLLAB.doc, ch = [], skipped = [];
  ent.op.ch.forEach(([ty, id, fld, v], i) => {
    const e = d[ty].get(id);
    if (!e || !e.c[fld] || e.c[fld][2] !== ent.op.id) { skipped.push(id); return; } // someone changed it since: leave theirs
    let back = ent.prev[i][0];
    if (back === undefined) { if (ty === "o" && fld !== "x") return; back = ty === "o" ? 0 : null; } // a new object: undo = delete it
    ch.push([ty, id, fld, back]);
  });
  if (!ch.length) { toast(tr("Nothing to undo: others have changed these objects since"), 2200); updateEdUI(); return; }
  const prev = ch.map(([ty, id, fld]) => { const e = d[ty].get(id); return [e.f[fld], e.c[fld]]; });
  const op = makeOp(ch, fromUndo ? "Undo" : "Redo"), changed = new Set();
  applyOp(op, changed);
  to.push({ op, prev });
  if (COLLAB.host) cbroadcast({ t: "op", op }); else csend(COLLAB.hostConn, { t: "op", op });
  materialize(changed);
  if (skipped.length) toast(tr("Part of it was left alone: someone else changed those objects since"), 2200);
}

// ---------- receiving ----------
function receiveOps(ops, from) {
  if (COLLAB.opening || !COLLAB.doc) { COLLAB.early.push(...ops); return; }
  const changed = new Set();
  for (const op of ops) { if (!validOp(op) || haveOp(op)) continue; applyOp(op, changed); }
  if (changed.size) { collabLogSoon(); materialize(changed); if (from) COLLAB.flash = { ids: new Set([...changed].filter(k => k[0] === "o").map(k => k.slice(2))), color: from.color || "#fff", at: performance.now() }; }
}
function opsSince(vv) { return COLLAB.log.filter(op => op.seq > ((vv && vv[op.peer]) || 0)); }

// ---------- host ----------
async function collabStart() {
  if (!map) return;
  if (COLLAB.on) return collabOpen();
  if (LIVE.on) return toast(tr("End the live session first: a map can be in a live session or a collab session, not both"), 3500);
  if (!AUTH.user) { toast(tr("Log in with osu! to start a collab session"), 3000); openAcct(); return; }
  const ok = await modal({ title: tr("Start a collab session?"), body: collabExplain(true), dismiss: false, buttons: [{ label: tr("Cancel"), value: false }, { label: tr("Start"), value: true, cls: "main" }] });
  if (!ok) return;
  let Peer; try { Peer = await loadPeerJS(); } catch (e) { return toast(e.message); }
  if (!EDIT.on) setMode(true);
  collabSetStatus("connecting"); showLoading(tr("Starting the collab session…"), -1);
  const noTurn = !liveTurnPref(), t = noTurn ? null : await collabIce(); // the host's choice (the same switch as live sessions)
  const tryOpen = n => new Promise((res, rej) => {
    const code = randCode(), peer = new Peer(cpeerId(code), peerOpts(t, t && t.relay));
    const to = setTimeout(() => { peer.destroy(); rej(new Error(tr("timed out"))); }, 15000);
    peer.on("open", () => { clearTimeout(to); res({ peer, code }); });
    peer.on("error", e => { clearTimeout(to); peer.destroy(); if (e.type === "unavailable-id" && n < 3) tryOpen(n + 1).then(res, rej); else rej(e); });
  });
  try {
    const { peer, code } = await tryOpen(0);
    stashDiff();
    Object.assign(COLLAB, { on: true, host: true, code, peer, hostPeer: peer.id, clock: 0, seq: 0, vv: {}, seen: new Set(), log: [], undo: [], redo: [], diff: osuFiles[curDiff].path, early: [], pkgBlob: null, draftChecked: true,
      turn: t, noTurn, relay: !!(turnOk(t) && t.relay), tick: 0 });
    COLLAB.pkgKey = code + ":" + (onlineSet || PKG && PKG.hash || "local");
    COLLAB.members.clear(); COLLAB.roles.clear();
    COLLAB.me = { peer: peer.id, uid: AUTH.user.id, name: AUTH.user.username, avatar: AUTH.user.avatar || "", role: "editor", host: true, color: "#ff66aa", verified: !AUTH.user.dev, relay: COLLAB.relay };
    COLLAB.members.set(peer.id, COLLAB.me);
    LIVE.chat = []; LIVE.unread = 0;
    COLLAB.doc = docFromMap();
    EDIT.undo = []; EDIT.redo = [];
    peer.on("connection", collabAccept);
    peer.on("disconnected", () => { if (COLLAB.on) { collabSetStatus("reconnecting"); try { peer.reconnect(); } catch {} } });
    peer.on("open", () => { if (COLLAB.on) collabSetStatus("connected"); });
    peer.on("error", e => { if (COLLAB.on && e.type !== "peer-unavailable") toast(tr("Collab connection problem: {err}", { err: e.type || e.message }), 3000); });
    COLLAB.sumTimer = setInterval(collabSum, 4000);
    COLLAB.pingTimer = setInterval(collabPingTick, 1000);
    hideLoading(); collabSetStatus("connected"); collabOpen();
    copyText(collabURL()).then(okc => toast(okc ? tr("Collab session started • invite link copied") : tr("Collab session started"), 3000));
  } catch (e) { hideLoading(); collabSetStatus(""); toast(tr("Couldn't start the collab session: {err}", { err: e.type || e.message }), 4000); }
}
function collabAccept(c) {
  c.on("open", () => {
    if (!COLLAB.on) return c.close();
    if (COLLAB.conns.size >= COLLAB_MAX - 1) { csend(c, { t: "denied", why: "full" }); setTimeout(() => c.close(), 400); return; }
    COLLAB.conns.set(c.peer, { c, m: null });
  });
  c.on("data", d => collabHostData(c, d).catch(e => console.warn("collab", e)));
  c.on("close", () => collabLeft(c.peer));
  c.on("error", () => collabLeft(c.peer));
}
function collabRoster() { return [...COLLAB.members.values()].map(m => ({ peer: m.peer, uid: m.uid, name: m.name, avatar: m.avatar, role: m.role, host: !!m.host, color: m.color, verified: !!m.verified, relay: !!m.relay, ping: m.ping ?? null })); }
function collabSendRoster() { cbroadcast({ t: "roster", members: collabRoster() }); collabRender(); }
function collabPkgInfo() { const f = osuFiles[curDiff]; return { sid: onlineSet ? +onlineSet : 0, bid: +map.meta.BeatmapID || 0, version: map.meta.Version, path: f.path, key: COLLAB.pkgKey, title: `${map.meta.Artist} - ${map.meta.Title}`, project: CLOUD.project ? CLOUD.project.id : null }; }
// someone saved the shared state online: everyone's copy now matches that revision
function collabNotifySaved(revision) { const msg = { t: "saved", revision, project: CLOUD.project && CLOUD.project.id }; if (COLLAB.host) cbroadcast(msg); else csend(COLLAB.hostConn, msg); }
function collabOnSaved(d) { if (CLOUD.project && d.project === CLOUD.project.id && d.revision > CLOUD.project.revision) { CLOUD.project.revision = d.revision; setCloud("saved"); } }
async function collabHostData(c, d) {
  const ent = COLLAB.conns.get(c.peer); if (!ent || !d || typeof d !== "object") return;
  if (d.t === "hello") {
    if (ent.m) return;
    if (d.proto !== COLLAB_PROTO) { csend(c, { t: "denied", why: "version" }); setTimeout(() => c.close(), 400); return; }
    let who = null, verified = false, projRole = null;
    if (CLOUD.project) { // an online project: the server checks the login AND their role in the project
      let v = null; try { v = await capi("POST", "collab/verify", { ticket: d.ticket, aud: "collab:" + COLLAB.code, project: CLOUD.project.id }); } catch {}
      if (!v || !v.ok) { csend(c, { t: "denied", why: "login" }); setTimeout(() => c.close(), 500); return; }
      if (!v.role) { csend(c, { t: "denied", why: "member" }); setTimeout(() => c.close(), 500); return; }
      who = v.user; verified = true; projRole = v.role === "viewer" ? "viewer" : "editor";
    } else { who = await verifyTicket(d.ticket, "collab:" + COLLAB.code); verified = !!who; }
    if (!who && AUTH.dev && d.dev && !CLOUD.project) who = { id: "dev:" + String(d.dev).slice(0, 32), username: String(d.dev).slice(0, 32) + " (dev)", avatar: "" }; // localhost testing only
    if (!who) { csend(c, { t: "denied", why: "login" }); setTimeout(() => c.close(), 500); return; }
    const quiet = !!d.sw; // moving to / from the relay: the same person, no "left" / "joined"
    for (const [pid, e2] of COLLAB.conns) if (pid !== c.peer && e2.m && e2.m.uid === who.id) { try { e2.c.close(); } catch {} collabLeft(pid, quiet); } // reconnecting: drop the old link
    const role = projRole === "viewer" ? "viewer" : COLLAB.roles.get(who.id) || (projRole || COLLAB.defaultRole), num = COLLAB.members.size;
    const m = { peer: c.peer, uid: who.id, name: who.username, avatar: who.avatar || "", role, verified, color: COLLAB_COLS[num % COLLAB_COLS.length], pres: null, relay: !!d.relay, rtt: [], ping: null };
    ent.m = m; COLLAB.members.set(c.peer, m); COLLAB.roles.set(who.id, role);
    if (!COLLAB.uidPeers) COLLAB.uidPeers = new Map(); // (the connections each person has had: their changes carry one of these)
    if (!COLLAB.uidPeers.has(who.id)) COLLAB.uidPeers.set(who.id, new Set()); COLLAB.uidPeers.get(who.id).add(c.peer);
    const myTicket = await ticketFor("collab:" + COLLAB.code + ":" + c.peer); // (for this person only)
    if (!COLLAB.conns.has(c.peer)) return;
    csend(c, { t: "welcome", proto: COLLAB_PROTO, you: m, host: { peer: COLLAB.me.peer, name: COLLAB.me.name, uid: COLLAB.me.uid }, ticket: myTicket, roster: collabRoster(), pkg: collabPkgInfo(), vv: COLLAB.vv, chat: LIVE.chat.filter(x => !x.sys).slice(-100), noTurn: COLLAB.noTurn });
    const resume = d.pkgKey === COLLAB.pkgKey && d.vv && typeof d.vv === "object";
    if (resume) csend(c, { t: "ops", ops: opsSince(d.vv) }); else csend(c, { t: "snap", snap: docJSON(COLLAB.doc), vv: COLLAB.vv, clock: COLLAB.clock, log: COLLAB.log.slice(-5000) });
    collabSendRoster();
    if (quiet) return;
    cbroadcast({ t: "sys", m: chatSys("join", m.name) }, c.peer);
    toast(tr("{n} joined the collab session", { n: m.name }), 2000);
    return;
  }
  const m = ent.m; if (!m) return;
  if (d.t === "pong") { const ms = performance.now() - d.s; if (ms >= 0 && ms < 60000) { m.rtt.push(ms); if (m.rtt.length > 5) m.rtt.shift(); m.ping = median(m.rtt); } return; }
  if (d.t === "op" || d.t === "ops") {
    const ops = d.t === "op" ? [d.op] : Array.isArray(d.ops) ? d.ops : [];
    const good = [];
    for (const op of ops) {
      if (!validOp(op)) { csend(c, { t: "reject", id: op && op.id, why: "invalid" }); continue; }
      // only under a connection this person has had (now, or before a reconnect): someone else's op ids can't be taken
      // ahead of time, which would make that person's real changes look like copies and be dropped
      const mine = COLLAB.uidPeers && COLLAB.uidPeers.get(m.uid);
      if (!mine || !mine.has(op.peer)) { csend(c, { t: "reject", id: op.id, why: "author" }); collabResync(c); continue; }
      if (haveOp(op)) continue;
      if (op.by !== m.uid || m.role !== "editor") { csend(c, { t: "reject", id: op.id, why: m.role !== "editor" ? "viewer" : "author" }); collabResync(c); continue; }
      // annotations: only the author (or the host) may change or delete one
      const own = au => !au || au.id === m.uid || (!m.verified && !au.id);
      const badAnn = op.ch.some(([ty, id, , v]) => { if (ty !== "a") return false; const e = COLLAB.doc.a.get(id), cur = e && e.f.v; return cur ? !own(cur.author) : v && !own(v.author); });
      if (badAnn) { csend(c, { t: "reject", id: op.id, why: "author" }); collabResync(c); continue; }
      good.push(op);
    }
    if (good.length) { receiveOps(good, m); for (const op of good) cbroadcast({ t: "op", op }, c.peer); }
  } else if (d.t === "pres") { m.pres = { x: +d.x, y: +d.y, sel: Array.isArray(d.sel) ? d.sel.slice(0, 60).map(String) : [], time: +d.time || 0, playing: !!d.playing, at: performance.now() }; cbroadcast({ ...d, peer: c.peer }, c.peer); dirty = true; }
  else if (d.t === "chat") { const cm = cleanChat(d.m, { id: m.uid, name: m.name, color: m.color }); if (cm) { chatAdd(cm); cbroadcast({ t: "chat", m: cm }, c.peer); } }
  else if (d.t === "need") csend(c, { t: "ops", ops: opsSince(d.vv) });
  else if (d.t === "saved" && m.role === "editor") { collabOnSaved(d); cbroadcast(d, c.peer); }
  else if (d.t === "resync") collabResync(c);
  else if (d.t === "needpkg") collabSendPackage(c);
}
function collabResync(c) { csend(c, { t: "snap", snap: docJSON(COLLAB.doc), vv: COLLAB.vv, clock: COLLAB.clock, log: COLLAB.log.slice(-5000), resync: true }); }
function collabLeft(pid, quiet) {
  const e = COLLAB.conns.get(pid); COLLAB.conns.delete(pid);
  if (e && e.m) { COLLAB.members.delete(pid); if (!quiet) { cbroadcast({ t: "sys", m: chatSys("left", e.m.name) }); toast(tr("{n} left the collab session", { n: e.m.name }), 1800); } collabSendRoster(); dirty = true; }
}
// ---------- ping and the TURN relay (as in live sessions) ----------
// The host pings everyone every 2 s and sends the list every 4 s. Someone whose ping to the host stays above the limit
// (Admin → Settings → TURN relay) moves to the relay by reconnecting through it (and back if it's slower); people an
// admin picked use only the relay. The host's switch before starting can keep the session peer-to-peer only.
function collabPingTick() {
  if (!COLLAB.on || !COLLAB.host) return;
  const tick = ++COLLAB.tick;
  if (tick % 2 === 0) for (const e of COLLAB.conns.values()) if (e.m) csend(e.c, { t: "ping", s: performance.now() });
  if (tick % 4 === 0 && COLLAB.conns.size) { cbroadcast({ t: "pings", p: [...COLLAB.members.values()].filter(m => !m.host).map(m => [m.peer, m.ping ?? null, !!m.relay, (m.rtt || []).length]) }); collabRender(); }
}
function collabAutoRelay(ping, n) {
  COLLAB.ping = ping;
  const t = COLLAB.turn; if (COLLAB.noTurn || !turnOk(t) || COLLAB.switching || ping == null || n < 3) return;
  if (!COLLAB.relay && !COLLAB.autoDone && ping > t.ping_ms) { COLLAB.autoDone = true; COLLAB.directPing = ping; collabSwitch(true, "auto", ping); }
  else if (COLLAB.relay && !t.relay && COLLAB.directPing != null && ping > COLLAB.directPing + 20) { COLLAB.directPing = null; collabSwitch(false, "back"); }
}
// a new connection (relay only, or direct again): the host takes it as the same person reconnecting, quietly
async function collabSwitch(relay, why, ping) {
  if (COLLAB.switching || !COLLAB.on || COLLAB.host || !turnOk(COLLAB.turn) || COLLAB.relay === relay) return;
  COLLAB.switching = true;
  let peer = null;
  try {
    const Peer = await loadPeerJS(), code = COLLAB.code;
    peer = new Peer(peerOpts(COLLAB.turn, relay));
    await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error(tr("timed out"))), 15000); peer.on("open", () => { clearTimeout(to); res(); }); peer.on("error", e => { clearTimeout(to); rej(e); }); });
    if (!COLLAB.on || COLLAB.code !== code) { peer.destroy(); return; }
    const old = COLLAB.peer;
    COLLAB.me.peer = peer.id; COLLAB.seq = 0; // my changes from now on count under the new connection
    COLLAB.relay = relay; COLLAB.peer = peer;
    peer.on("disconnected", () => { if (COLLAB.on && !COLLAB.host && COLLAB.peer === peer) try { peer.reconnect(); } catch {} });
    peer.on("error", e => { if (COLLAB.peer === peer && e.type === "peer-unavailable") collabReconnectLater(); });
    const ok = await new Promise(res => { const to = setTimeout(() => res(false), 15000); collabConnect(peer, code, () => { clearTimeout(to); res(true); }, { sw: true, relay }); });
    if (!ok) throw new Error(tr("timed out"));
    setTimeout(() => { try { old && old.destroy(); } catch {} }, 500);
    const msg = why === "auto" ? tr("Your ping to the host is {ms} ms: switched to the TURN relay", { ms: ping }) : why === "back" ? tr("The relay was slower: connected directly again") : tr("Connected through the TURN relay");
    toast(msg, 3500); collabRender();
  } catch (e) {
    try { peer && peer.destroy(); } catch {}
    if (relay) toast(tr("Couldn't switch to the TURN relay ({err}), staying connected directly", { err: e.type || e.message }), 3500);
  } finally { COLLAB.switching = false; }
}
function collabSetRole(peerId, role) {
  const m = COLLAB.members.get(peerId); if (!m || m.host) return;
  m.role = role; COLLAB.roles.set(m.uid, role); collabSendRoster();
}
function collabSum() { if (COLLAB.on && COLLAB.host) cbroadcast({ t: "sum", h: docHash(), vv: COLLAB.vv, path: COLLAB.diff }); }
async function collabSendPackage(c) { // maps that aren't on the mirrors: the .osz, in chunks
  try {
    if (!COLLAB.pkgBlob) {
      const Z = await loadJSZip(), zip = new Z(), own = new Set(osuFiles.map(o => o.path));
      for (const k in files) { const f = files[k]; if (!own.has(f.name)) zip.file(f.name, f.async("uint8array")); }
      osuFiles.forEach((o, i) => zip.file(o.path, i === curDiff ? editedText() : o.text));
      COLLAB.pkgBlob = await zip.generateAsync({ type: "arraybuffer", compression: "STORE" });
    }
    const buf = COLLAB.pkgBlob, CH = 64000, n = Math.ceil(buf.byteLength / CH);
    csend(c, { t: "pkg0", n, size: buf.byteLength });
    for (let i = 0; i < n; i++) {
      while (c.dataChannel && c.dataChannel.bufferedAmount > 1.5e6) await sleep(25);
      if (!c.open) return;
      csend(c, { t: "pkg", i, b: buf.slice(i * CH, (i + 1) * CH) });
      if (i % 16 === 15) await sleep(0);
    }
  } catch (e) { toast(tr("Couldn't send the map: {err}", { err: e.message }), 3000); }
}

// ---------- joining ----------
function collabJoinPrompt(code, noTurn) {
  code = String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (!code) return;
  if (COLLAB.on) { if (COLLAB.code === code) return collabOpen(); return toast(tr("You're already in a collab session")); }
  const run = async () => {
    if (!AUTH.checked) await authCheck();
    const box = collabExplain(false);
    if (!AUTH.user) box.prepend(h("p", "warnline", tr("Log in with osu! first: the host checks who you are before you can edit.")));
    const v = await modal({ title: tr("Join collab session {c}?", { c: code.toUpperCase() }), body: box, dismiss: false,
      buttons: AUTH.user ? [{ label: tr("Cancel"), value: false }, { label: tr("Join"), value: true, cls: "main" }] : [{ label: tr("Cancel"), value: false }, { label: tr("Log in with osu!"), value: "login", cls: "main" }] });
    const p = new URLSearchParams(location.search); if (p.has("collab") && v !== "login") { p.delete("collab"); p.delete("nt"); history.replaceState(history.state, "", location.pathname + (p.toString() ? "?" + p : "")); }
    if (v === "login") return authLogin();
    if (v) collabJoin(code, noTurn);
  };
  run();
}
async function collabJoin(code, noTurn) {
  let Peer; try { Peer = await loadPeerJS(); } catch (e) { return toast(e.message); }
  if (LIVE.on) return toast(tr("Leave the live session first"));
  if (!(await edConfirmDiscard())) return;
  collabSetStatus("connecting"); showLoading(tr("Connecting to the collab session…"), -1);
  const t = noTurn ? null : await collabIce(), relay = !!(turnOk(t) && t.relay), peer = new Peer(peerOpts(t, relay));
  Object.assign(COLLAB, { turn: t, relay, noTurn: !!noTurn, ping: null, autoDone: false, directPing: null, switching: false });
  let welcomed = false;
  const fail = msg => { hideLoading(); if (!welcomed) { try { peer.destroy(); } catch {} collabSetStatus(""); toast(msg, 4500); } };
  const to = setTimeout(() => { if (!welcomed) fail(tr("Couldn't reach the host (timed out). Check the link, or the host may be offline.")); }, 20000);
  peer.on("error", e => { clearTimeout(to); if (e.type === "peer-unavailable") { if (!welcomed) fail(tr("No collab session with this code (it may have ended).")); else collabReconnectLater(); } else if (!welcomed) fail(tr("Couldn't connect: {err}", { err: e.type || e.message })); });
  peer.on("open", () => collabConnect(peer, code, () => { welcomed = true; clearTimeout(to); }));
  peer.on("disconnected", () => { if (COLLAB.on && !COLLAB.host) try { peer.reconnect(); } catch {} });
}
async function collabHello(code, extra) {
  const u = AUTH.user || {};
  return { t: "hello", proto: COLLAB_PROTO, ticket: u.dev ? null : await ticketFor("collab:" + code), dev: u.dev ? u.username : null, pkgKey: COLLAB.pkgKey || null, vv: COLLAB.doc ? COLLAB.vv : null, relay: COLLAB.relay, ...extra };
}
function collabConnect(peer, code, onWelcome, extra) {
  const c = peer.connect(cpeerId(code), { reliable: true });
  c.on("open", async () => csend(c, await collabHello(code, extra)));
  c.on("data", d => {
    if (d && d.t === "denied") { hideLoading(); toast(d.why === "full" ? tr("This collab session is full") : d.why === "member" ? tr("This collab session is for an online project you don't have access to. Ask its owner to share it with you.") : d.why === "version" ? tr("The host uses a different version of this site: reload the page (both of you)") : tr("The host couldn't verify your osu! login"), 4500); if (!COLLAB.on) { collabSetStatus(""); setTimeout(() => { try { peer.destroy(); } catch {} }, 200); } return; }
    if (d && d.t === "welcome") onWelcome && onWelcome();
    collabVisitorData(c, peer, code, d).catch(e => { console.warn("collab", e); collabSetStatus("error"); });
  });
  c.on("close", () => { if (COLLAB.on && !COLLAB.host && COLLAB.hostConn === c) { COLLAB.hostConn = null; collabSetStatus("disconnected"); collabReconnectLater(); } });
}
function collabReconnectLater() {
  if (!COLLAB.on || COLLAB.host) return;
  clearTimeout(COLLAB.retryT);
  if (++COLLAB.retry > 20) { collabEnd(false, tr("Lost the connection to the collab session. Your copy is kept: export it or reopen the invite link.")); return; }
  COLLAB.retryT = setTimeout(() => { if (COLLAB.on && !COLLAB.hostConn && COLLAB.peer && !COLLAB.peer.destroyed) { collabSetStatus("reconnecting"); collabConnect(COLLAB.peer, COLLAB.code); } }, Math.min(10000, 1500 * COLLAB.retry));
}
async function collabVisitorData(c, peer, code, d) {
  if (!d || typeof d !== "object") return;
  switch (d.t) {
    case "welcome": {
      if (d.proto !== COLLAB_PROTO) return;
      const resumed = COLLAB.on && COLLAB.code === code && COLLAB.pkgKey === (d.pkg && d.pkg.key);
      COLLAB.hostConn = c; COLLAB.retry = 0;
      if (d.noTurn) COLLAB.noTurn = true; // the host keeps this session peer-to-peer only
      if (!resumed) {
        Object.assign(COLLAB, { on: true, host: false, code, peer, hostPeer: d.host.peer, clock: 0, seq: 0, vv: {}, seen: new Set(), log: [], undo: [], redo: [], doc: null, early: [], snapWait: null, pkgKey: d.pkg.key, diff: d.pkg.path, draftChecked: false });
        COLLAB.me = { ...d.you }; COLLAB.members = new Map(d.roster.map(m => [m.peer, m]));
        LIVE.chat = (Array.isArray(d.chat) ? d.chat : []).slice(-100); LIVE.unread = 0;
        verifyTicket(d.ticket, "collab:" + code + ":" + peer.id).then(u => { const hm = COLLAB.members.get(d.host.peer); if (hm) { hm.verified = !!u; collabRender(); } });
        await collabOpenPackage(d.pkg);
      } else {
        COLLAB.me = { ...COLLAB.me, ...d.you, peer: COLLAB.me.peer }; COLLAB.members = new Map(d.roster.map(m => [m.peer, m]));
        csend(c, { t: "ops", ops: opsSince(d.vv).filter(op => op.by === COLLAB.me.uid) }); // what I did while disconnected
        collabSetStatus("connected"); if (!COLLAB.switching) toast(tr("Reconnected to the collab session"), 2000);
      }
      collabRender(); break;
    }
    case "snap": {
      if (COLLAB.opening || !map) { COLLAB.snapWait = d; break; }
      collabApplySnap(d); break;
    }
    case "ops": receiveOps(Array.isArray(d.ops) ? d.ops : [], null); break;
    case "op": receiveOps([d.op], COLLAB.members.get(d.op && d.op.peer) || null); break;
    case "reject": toast(d.why === "viewer" ? tr("Your change wasn't accepted: you're a viewer in this session") : tr("Your change wasn't accepted by the host"), 2500); break;
    case "roster": {
      const meBefore = COLLAB.me && COLLAB.me.role;
      COLLAB.members = new Map((d.members || []).map(m => [m.peer, { ...(COLLAB.members.get(m.peer) || {}), ...m }]));
      const me = COLLAB.members.get(COLLAB.me.peer);
      if (me && me.role !== meBefore) { COLLAB.me.role = me.role; toast(me.role === "editor" ? tr("You can edit now") : tr("You're a viewer now"), 2500); }
      collabRender(); break;
    }
    case "ping": csend(c, { t: "pong", s: d.s }); break;
    case "pings": {
      for (const [peerId, ping, relay, n] of Array.isArray(d.p) ? d.p : []) {
        const m = COLLAB.members.get(peerId); if (m) { m.ping = ping; m.relay = relay; }
        if (peerId === COLLAB.me.peer) collabAutoRelay(ping, n);
      }
      collabRender(); break;
    }
    case "pres": { const m = COLLAB.members.get(d.peer); if (m) { m.pres = { x: +d.x, y: +d.y, sel: (d.sel || []).map(String), time: +d.time || 0, playing: !!d.playing, at: performance.now() }; dirty = true; } break; }
    case "sum":
      if (!COLLAB.doc || COLLAB.opening || d.path !== COLLAB.diff) break;
      if (vvEq(d.vv, COLLAB.vv)) { if (d.h !== docHash()) { if (++COLLAB.sumBad >= 2) { COLLAB.sumBad = 0; collabSetStatus("syncing"); csend(c, { t: "resync" }); } } else { COLLAB.sumBad = 0; if (COLLAB.status !== "connected") collabSetStatus("connected"); } }
      else if (Object.keys(d.vv || {}).some(p => (d.vv[p] || 0) > (COLLAB.vv[p] || 0))) csend(c, { t: "need", vv: COLLAB.vv }); // I'm missing something
      break;
    case "pkg0": COLLAB.pkg = { n: d.n, got: 0, parts: new Array(d.n), done: COLLAB.pkg && COLLAB.pkg.done }; showLoading(tr("Receiving the map from the host… {p}%", { p: 0 }), 0); break;
    case "pkg": {
      const P = COLLAB.pkg; if (!P || P.parts[d.i]) break;
      P.parts[d.i] = d.b; P.got++;
      if (P.got % 8 === 0 || P.got === P.n) showLoading(tr("Receiving the map from the host… {p}%", { p: Math.round(P.got / P.n * 100) }), P.got / P.n);
      if (P.got === P.n) { const blob = new Blob(P.parts); COLLAB.pkg = null; P.done && P.done(blob); }
      break;
    }
    case "saved": collabOnSaved(d); break;
    case "chat": if (d.m && typeof d.m.text === "string") chatAdd(d.m); break;
    case "sys": if (d.m && d.m.sys) chatAdd({ ...d.m }); break;
    case "end": collabEnd(false, tr("The host ended the collab session")); break;
    case "kick": collabEnd(false, tr("The host removed you from the collab session")); break;
  }
}
async function collabOpenPackage(pkg) {
  COLLAB.opening = true; collabSetStatus("syncing");
  try {
    if (pkg.sid) await download(pkg.sid, { bid: pkg.bid || null, name: pkg.version }, "mod");
    else {
      const blob = await new Promise(res => { COLLAB.pkg = { done: res, parts: [], got: 0, n: Infinity }; csend(COLLAB.hostConn, { t: "needpkg" }); });
      await openZip(blob, null, { name: pkg.version }, "mod");
    }
    if (!COLLAB.on) return; // (left while it opened: said no to an Aspire map)
    if (!map) throw new Error(tr("Couldn't open the host's map"));
    let i = osuFiles.findIndex(o => o.path === pkg.path);
    if (i < 0) i = osuFiles.findIndex(o => o.meta.version === pkg.version);
    if (i >= 0 && i !== curDiff) await selectDiff(i);
    COLLAB.diff = osuFiles[curDiff].path;
    if (pkg.project && typeof capi === "function") { try { const g = await capi("GET", `projects/${pkg.project}?files=0`); cloudDetach(g.project); } catch {} }
  } finally { COLLAB.opening = false; }
  if (!EDIT.on) setMode(true);
  if (COLLAB.snapWait) { const s = COLLAB.snapWait; COLLAB.snapWait = null; collabApplySnap(s); }
}
function collabApplySnap(d) {
  COLLAB.doc = docLoad(d.snap);
  COLLAB.clock = Math.max(COLLAB.clock, +d.clock || 0);
  const mine = COLLAB.log.filter(op => op.by === COLLAB.me.uid); // keep my own history (for undo) and anything not yet acknowledged
  COLLAB.seen = new Set(); COLLAB.vv = {}; COLLAB.log = [];
  for (const op of Array.isArray(d.log) ? d.log : []) if (op && op.id) markSeen(op);
  for (const p in d.vv || {}) COLLAB.vv[p] = Math.max(COLLAB.vv[p] || 0, d.vv[p]);
  materialize(null, true);
  EDIT.undo = []; EDIT.redo = [];
  if (d.resync) { for (const op of mine) if (!haveOp(op)) csend(COLLAB.hostConn, { t: "op", op }); if (mine.length === 0) COLLAB.undo = []; }
  if (COLLAB.early.length) { const e = COLLAB.early; COLLAB.early = []; receiveOps(e, null); }
  collabSetStatus("connected");
  hideLoading();
  if (!d.resync) { toast(tr("Joined the collab session: edits are shared live"), 2500); collabDraftCheck(); }
}
// a draft of this map on this device: nothing is sent unless you choose to
async function collabDraftCheck() {
  if (COLLAB.draftChecked || typeof indexedDB === "undefined") return;
  COLLAB.draftChecked = true;
  const uid = draftUid(), keys = [];
  if (onlineSet) keys.push(draftKey(uid, "set:" + onlineSet));
  let rec = null; for (const k of keys) { try { rec = await idbTx("drafts", "readonly", s => s.get(k)); } catch {} if (rec) break; }
  if (!rec || !rec.diffs || !rec.diffs[COLLAB.diff]) return;
  const v = await modal({ title: tr("You have a draft of this difficulty"), body: tr("Saved on this device on {t}. It isn't sent to anyone unless you choose to.", { t: fmtDate(rec.savedAt) }), buttons: [
    { label: tr("Keep it for later"), value: "keep" }, { label: tr("Discard draft"), value: "del", cls: "ghost danger" }, { label: tr("Send it to the session"), value: "send", cls: "main" }] });
  if (v === "del") draftDelete(rec);
  if (v === "send") {
    const d = rec.diffs[COLLAB.diff], f = osuFiles[curDiff];
    f.text = d.text; f.ids = d.ids; f.edited = true;
    const keep = COLLAB.diff; await selectDiff(curDiff); COLLAB.diff = keep;
    annImport([...ANN.list.filter(a => a.diff !== COLLAB.diff), ...(rec.annotations || []).filter(a => a.diff === COLLAB.diff)]);
    collabPushLocal("Restored draft");
    for (const a of ANN.list) if (a.diff === COLLAB.diff) collabAnnChanged(a);
  }
}

// ---------- presence ----------
cv.addEventListener("pointermove", e => { if (COLLAB.on && EDIT.on) { const p = toOsu(e); COLLAB.mx = Math.round(p[0]); COLLAB.my = Math.round(p[1]); } });
function collabFrame(t, playing) {
  const now = performance.now(); if (now - COLLAB.lastPres < 120) return;
  const sel = [...EDIT.sel].slice(0, 60).map(String), key = `${COLLAB.mx},${COLLAB.my},${sel.join()},${Math.round(t / 40)},${playing}`;
  if (key === COLLAB.presKey && now - COLLAB.lastPres < 5000) return;
  COLLAB.presKey = key; COLLAB.lastPres = now;
  const msg = { t: "pres", x: COLLAB.mx, y: COLLAB.my, sel, time: Math.round(t), playing: !!playing };
  if (COLLAB.host) cbroadcast({ ...msg, peer: COLLAB.me.peer }); else csend(COLLAB.hostConn, msg);
}
function collabDrawOver(t, px) {
  const now = performance.now(), r = map.radius;
  if (COLLAB.lidHit !== map.hit) { COLLAB.lidHit = map.hit; COLLAB.lidMap = new Map(map.hit.map(o => [String(o.lid), o])); }
  const vis = o => o && t >= o.t - map.preempt && t <= o.end + 700;
  const ring = (o, col, w, a, grow = 1) => { ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = w * px; ctx.beginPath(); ctx.arc(o.x, o.y, r * 1.12 * grow, 0, 7); ctx.stroke(); };
  if (COLLAB.flash) { const k = (now - COLLAB.flash.at) / 900; if (k >= 1) COLLAB.flash = null; else for (const id of COLLAB.flash.ids) { const o = COLLAB.lidMap.get(id); if (vis(o)) ring(o, COLLAB.flash.color, 4, 1 - k, 1 + .3 * k); } }
  for (const m of COLLAB.members.values()) {
    if (m.peer === COLLAB.me.peer || !m.pres || now - m.pres.at > 15000) continue;
    const p = m.pres;
    ctx.setLineDash([6 * px, 5 * px]);
    for (const id of p.sel) { const o = COLLAB.lidMap.get(id); if (vis(o)) ring(o, m.color, 2.5, .95); }
    ctx.setLineDash([]);
    if (p.x > -100 && p.x < 612 && p.y > -100 && p.y < 484) {
      ctx.globalAlpha = 1; ctx.fillStyle = m.color; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.2 * px;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 11 * px, p.y + 12 * px); ctx.lineTo(p.x + 4.5 * px, p.y + 12 * px); ctx.lineTo(p.x, p.y + 17 * px); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.font = `600 ${11 * px}px Inter,sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "top";
      const w = ctx.measureText(m.name).width + 10 * px;
      ctx.fillRect(p.x + 12 * px, p.y + 14 * px, w, 16 * px); ctx.fillStyle = "#1c1726"; ctx.fillText(m.name, p.x + 17 * px, p.y + 16 * px);
    }
  }
  ctx.globalAlpha = 1;
}
function collabDrawTimeline(g, X, t0, t1, hh) {
  for (const m of COLLAB.members.values()) {
    if (m.peer === COLLAB.me.peer || !m.pres || performance.now() - m.pres.at > 15000) continue;
    const x = X(m.pres.time); if (x < 0 || x > g.canvas.width) continue;
    g.fillStyle = m.color; g.globalAlpha = .9; g.fillRect(x - .5, 0, 1, hh); g.beginPath(); g.moveTo(x - 5, hh); g.lineTo(x + 5, hh); g.lineTo(x, hh - 7); g.fill(); g.globalAlpha = 1;
  }
}

// ---------- ending ----------
function collabEnd(byMe, why) {
  if (!COLLAB.on) return;
  if (COLLAB.host) { cbroadcast({ t: "end" }); }
  const peer = COLLAB.peer;
  clearInterval(COLLAB.sumTimer); clearInterval(COLLAB.pingTimer); clearTimeout(COLLAB.retryT);
  setTimeout(() => { try { peer && peer.destroy(); } catch {} }, 300);
  Object.assign(COLLAB, { uidPeers: null, on: false, host: false, peer: null, hostConn: null, doc: null, opening: false, snapWait: null, early: [], pkg: null, pkgBlob: null, flash: null, undo: [], redo: [],
    turn: null, relay: false, noTurn: false, ping: null, autoDone: false, directPing: null, switching: false });
  COLLAB.conns.clear(); COLLAB.members.clear();
  EDIT.undo = []; EDIT.redo = []; // snapshots from the session would undo other people's work
  collabSetStatus(""); $("collabSheet").hidden = true; updateEdUI(); dirty = true;
  if (why) toast(why, 4000); else if (byMe) toast(tr("Collab session closed. Your copy of the map stays open."), 2500);
}
async function collabLeaveForDiff() {
  if (!COLLAB.on) return true;
  if (!(await ask(COLLAB.host ? tr("The collab session is for this difficulty. Switching ends the session for everyone. Continue?") : tr("The collab session is for this difficulty. Switching leaves the session. Continue?"), { ok: tr("Switch"), danger: true }))) return false;
  collabEnd(true); return true;
}

// ---------- UI ----------
function collabSetStatus(s) {
  COLLAB.status = s;
  const pill = $("collabPill"); if (!pill) return;
  pill.hidden = !COLLAB.on && !s;
  const label = { connecting: tr("Connecting…"), syncing: tr("Syncing…"), connected: tr("Connected"), reconnecting: tr("Reconnecting…"), disconnected: tr("Disconnected"), error: tr("Sync error") }[s] || "";
  pill.className = "livepill collabpill " + (s || "");
  pill.textContent = `${tr("Collab")} · ${Math.max(1, COLLAB.members.size)} · ${label}`;
  if (typeof updateLivePill === "function") updateLivePill(); // the chat button comes and goes with the session
  if (!$("collabSheet").hidden) collabRender();
}
function collabExplain(host) {
  const box = h("div", "mdlb"), ul = h("ul", "plist");
  box.append(h("p", null, host ? tr("Everyone you invite edits this difficulty at the same time as you; changes merge automatically and everyone ends with the same map.") : tr("You'll edit this difficulty together with the host and the others, at the same time.")));
  for (const t of [tr("Sent to the other people in the session: the map (difficulty, song and images if it isn't on osu!), every edit, your osu! name, your pointer and selection."),
    tr("Browsers connect directly (peer-to-peer, WebRTC), so participants can see each other's IP address. If a direct connection isn't possible, a relay server passes the data along."),
    tr("Anyone in the session can keep a copy of the map. Nothing of the session is stored on our server."),
    host ? tr("You decide who may edit (everyone who joins can edit unless you make them a viewer). The session ends when you leave.") : tr("The host decides whether you may edit. If you lose the connection your copy stays open and reconnects by itself.")]) ul.append(h("li", null, t));
  box.append(ul);
  return box;
}
function collabOpen() { const s = $("collabSheet"); closeSheet(); closeTools(); s.hidden = false; collabRender(); }
function collabRender() {
  const body = $("csBody"); if (!body || $("collabSheet").hidden) return;
  body.innerHTML = "";
  if (!COLLAB.on) {
    body.append(collabExplain(true));
    if (AUTH.user) { // the same switch as live sessions
      const ts = h("label", "sw"), tt = h("span", "swt"), ti = h("input"); ti.type = "checkbox"; ti.className = "switch"; ti.checked = liveTurnPref();
      tt.append(h("b", null, tr("TURN relay")), h("small", null, tr("On: people who can't connect directly, or whose ping is high, go through Cloudflare's TURN relay. Off: peer-to-peer only.")));
      ti.onchange = () => liveTurnPref(ti.checked); ts.append(tt, ti); body.append(ts);
    }
    const b = h("button", "btn main wide", tr("Start a collab session")); b.onclick = collabStart; body.append(b);
    body.append(h("p", "hint", tr("Not the same as a Live session: in Live, the host holds the map and lets people edit it; in Collab everyone edits their own copy and the copies merge.")));
    return;
  }
  const st = h("div", "csstat " + COLLAB.status);
  st.append(h("b", null, { connecting: tr("Connecting…"), syncing: tr("Syncing…"), connected: tr("Connected"), reconnecting: tr("Reconnecting…"), disconnected: tr("Disconnected"), error: tr("Sync error") }[COLLAB.status] || ""), h("small", null, tr("Code {c} · [{d}]", { c: COLLAB.code.toUpperCase(), d: map ? map.meta.Version : "" })));
  body.append(st);
  if (COLLAB.status === "disconnected" || COLLAB.status === "reconnecting") body.append(h("p", "warnline", tr("Your edits are kept and will be sent when the connection is back.")));
  const inv = h("div", "btnrow"), cp = h("button", "btn ghost sm", tr("Copy invite link")); cp.onclick = async () => toast(await copyText(collabURL()) ? tr("Invite link copied") : collabURL(), 2500);
  inv.append(cp); body.append(inv);
  if (COLLAB.host) {
    const dr = h("label", "row"), sel = h("select");
    for (const [v, l] of [["editor", tr("can edit")], ["viewer", tr("view only")]]) sel.add(new Option(l, v));
    sel.value = COLLAB.defaultRole; sel.onchange = () => { COLLAB.defaultRole = sel.value; };
    dr.append(h("span", null, tr("People who join")), sel); body.append(dr);
  }
  const list = h("div", "cslist");
  for (const m of COLLAB.members.values()) {
    const row = h("div", "csm"), dot = h("i", "csdot"); dot.style.background = m.color;
    const nm = h("span", "csname", m.name + (m.peer === COLLAB.me.peer ? " (" + tr("you") + ")" : "")); if (m.host) nm.append(h("em", "badge", tr("host")));
    if (!m.verified) nm.append(h("em", "badge dim", tr("not verified")));
    const net = h("span", "csnet"); // ping to the host and the relay badge, outside the name (long names get cut)
    if (!m.host && m.ping != null) net.append(h("span", "lsping " + (m.ping > ((COLLAB.turn && COLLAB.turn.ping_ms) || 150) ? "bad" : m.ping > 80 ? "mid" : "ok"), tr("{ms} ms", { ms: m.ping })));
    if (m.relay || (m.peer === COLLAB.me.peer && COLLAB.relay)) net.append(h("span", "lsrelay", "TURN"));
    row.append(dot, nm, net, collabPosEl(m));
    if (COLLAB.host && !m.host) {
      const sel = h("select"); for (const [v, l] of [["editor", tr("can edit")], ["viewer", tr("view only")]]) sel.add(new Option(l, v));
      sel.value = m.role; sel.onchange = () => collabSetRole(m.peer, sel.value);
      const kick = h("button", "mlink", tr("Remove")); kick.onclick = () => { const e = COLLAB.conns.get(m.peer); if (e) { csend(e.c, { t: "kick" }); setTimeout(() => { try { e.c.close(); } catch {} collabLeft(m.peer); }, 300); } };
      row.append(sel, kick);
    } else row.append(h("small", null, m.host ? tr("can edit") : m.role === "editor" ? tr("can edit") : tr("view only")));
    list.append(row);
  }
  body.append(list); collabPosTick();
  body.append(h("p", "hint", COLLAB.noTurn || !turnOk(COLLAB.turn) ? tr("Connection: peer-to-peer. Ping is each person's round trip to the host.")
    : COLLAB.relay ? tr("Your connection goes through the TURN relay (Cloudflare). Ping is each person's round trip to the host.")
    : tr("Connection: peer-to-peer. Ping is each person's round trip to the host; above {ms} ms they switch to the TURN relay (Cloudflare) by themselves.", { ms: COLLAB.turn.ping_ms })));
  const logBox = h("div", "cslog"); logBox.id = "csLog"; body.append(h("div", "subh", tr("Recent changes")), logBox); collabLogRender();
  const end = h("button", "btn ghost wide danger", COLLAB.host ? tr("End the session for everyone") : tr("Leave the session"));
  end.onclick = async () => { if ((await ask(COLLAB.host ? tr("End the collab session for everyone?") : tr("Leave the collab session?"), { ok: COLLAB.host ? tr("End session") : tr("Leave"), danger: true }))) collabEnd(true); };
  body.append(end, h("p", "hint", tr("Undo (Ctrl+Z) only undoes your own changes. Everyone keeps their own copy: export or save it when you're done.")));
}
// ---------- where everyone is + recent changes (in the collab sheet) ----------
// Each person's place in the song (from their pointer updates, tap to go there) and the latest edits: who, what, where.
const collabWho = uid => { for (const m of COLLAB.members.values()) if (m.uid === uid) return m; return null; };
function collabOpTime(op) {
  const d = COLLAB.doc; if (!d) return null;
  for (const [ty, id, , v] of op.ch) {
    if (ty === "o") { const e = d.o.get(id), t = e && e.f.t; if (t && t[0] != null && isFinite(+t[0])) return +t[0]; }
    else if (ty === "p" && typeof v === "string") { const n = parseFloat(v); if (isFinite(n)) return n; }
    else if (ty === "a" && v) { if (isFinite(+v.time_ms) && v.time_ms != null) return +v.time_ms; const e = v.object_id != null && d.o.get(String(v.object_id)), t = e && e.f.t; if (t && isFinite(+t[0])) return +t[0]; }
  }
  return null;
}
function collabGo(t) { if (!map || !isFinite(t)) return; seekTo(t); const o = map.hit.find(x => Math.abs(x.t - t) < 2); if (o && EDIT.on) edSelectIds([o.lid]); }
function collabPosText(m) {
  if (m.peer === COLLAB.me.peer) return tsAt(A.cur()).replace(/ - $/, "");
  if (!m.pres || performance.now() - m.pres.at > 15000) return "";
  return (m.pres.playing ? "▶ " : "") + tsAt(m.pres.time).replace(/ - $/, "");
}
function collabPosEl(m) {
  const b = h("button", "mlink cspos", collabPosText(m)); b.dataset.peer = m.peer;
  b.title = tr("Where they are in the song (tap to go there)");
  b.onclick = () => { const x = COLLAB.members.get(m.peer); if (x === COLLAB.me || !x || !x.pres) return; collabGo(x.pres.time); };
  return b;
}
function collabAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? tr("just now") : s < 3600 ? tr("{n} min ago", { n: Math.floor(s / 60) }) : tr("{n} h ago", { n: Math.floor(s / 3600) });
}
function collabLogRender() {
  const box = $("csLog"); if (!box) return;
  box.innerHTML = "";
  const ops = COLLAB.log.filter(op => op.ch && op.ch.length).slice(-40).reverse();
  if (!ops.length) { box.append(h("p", "hint", tr("No changes yet. Every edit shows here: who, what and where."))); return; }
  for (const op of ops) {
    const m = collabWho(op.by), row = h("div", "cslrow"), t = collabOpTime(op);
    row.style.setProperty("--c", m ? m.color : "#888");
    row.append(h("b", null, m ? m.name : tr("someone")), h("span", null, tr(String(op.label || "Edit"))));
    if (t != null) { const go = h("button", "mlink lcts", tsAt(t).replace(/ - $/, "")); go.onclick = () => collabGo(t); row.append(go); }
    if (typeof op.at === "number") row.append(h("small", null, collabAgo(op.at)));
    box.append(row);
  }
}
let collabLogT = 0;
function collabLogSoon() { if (collabLogT || $("collabSheet").hidden) return; collabLogT = setTimeout(() => { collabLogT = 0; collabLogRender(); }, 400); }
function collabChatSend(m) { if (!COLLAB.on) return; if (COLLAB.host) cbroadcast({ t: "chat", m }); else csend(COLLAB.hostConn, { t: "chat", m }); }
let collabPosT = 0;
const collabPosTick = () => collabPosT || (collabPosT = setInterval(() => { // keep the positions current while the sheet is open
  if (!COLLAB.on || $("collabSheet").hidden) { clearInterval(collabPosT); collabPosT = 0; return; }
  for (const b of document.querySelectorAll("#csBody .cspos")) { const m = COLLAB.members.get(b.dataset.peer); if (m) b.textContent = collabPosText(m); }
}, 500));
async function collabIce() { // TURN servers from the site's server -> { on, ping_ms, relay, iceServers } or null
  try {
    const r = await fetch("/api/v1/ice", { cache: "no-store" }); if (!r.ok) return null;
    const j = await r.json(); if (!j || !Array.isArray(j.iceServers) || !j.iceServers.length) return null;
    return { on: j.on !== false, ping_ms: +j.ping_ms || 150, relay: j.relay === true, iceServers: j.iceServers };
  } catch { return null; }
}
$("collabPill").onclick = collabOpen;
$("hubCollab").onsubmit = e => { e.preventDefault(); const c = $("hubCollabCode").value.replace(/.*[?&]collab=/, ""); if (c.trim()) collabJoinPrompt(c); };
$("csClose").onclick = () => $("collabSheet").hidden = true;
