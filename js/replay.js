"use strict";
// ============ Replay core: .osr parsing, LZMA, MD5, mods, accuracy, rank ============
// Pure functions, no DOM and no network (loaded lazily by loadLazy("replay")). Everything that comes from a file is
// untrusted: sizes are capped and every loop is bounded by the input or by a cap, so a hostile file throws, not hangs.
// The .osr layout and the frame rules follow osu!stable's format and ppy/osu LegacyScoreDecoder (MIT, Copyright (c)
// ppy Pty Ltd): see THIRD_PARTY_NOTICES.txt. The LZMA decoder is written from the public LZMA specification.

const OSR_MAX_FILE = 8 * 1024 * 1024, OSR_MAX_FRAMES_TEXT = 24 * 1024 * 1024, OSR_MAX_FRAMES = 1000000;
const OSR_MAX_STR = 4096, OSR_MAX_LIFE = 100000, OSR_MAX_JSON = 1024 * 1024;

function osrErr(code) { const e = new Error(code); e.code = code; return e; }
// (bytes view of whatever the caller has: works for typed arrays / ArrayBuffers from another realm too)
function osrBytes(x) {
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (Object.prototype.toString.call(x) === "[object ArrayBuffer]") return new Uint8Array(x);
  throw new TypeError("bytes expected");
}

// ============ LZMA ("LZMA alone": 13 byte header, then the range coded stream) ============
// props byte (lc + 9 * (lp + 5 * pb)), dictionary size (4 bytes, not needed: the output buffer is the dictionary),
// uncompressed size (8 bytes LE, all ones = unknown, then the stream ends with an end marker).
function lzmaDecode(input, maxOut) {
  const bad = () => osrErr("lzma_bad"), big = () => osrErr("lzma_too_big");
  const inp = osrBytes(input), n = inp.length;
  maxOut = typeof maxOut === "number" && maxOut >= 0 ? Math.floor(maxOut) : 64 * 1024 * 1024;
  if (n < 13) throw bad();
  let d = inp[0];
  if (d >= 225) throw bad();
  const lc = d % 9; d = (d / 9) | 0;
  const lp = d % 5, pb = (d / 5) | 0;
  const lo = (inp[5] | inp[6] << 8 | inp[7] << 16 | inp[8] << 24) >>> 0, hi = (inp[9] | inp[10] << 8 | inp[11] << 16 | inp[12] << 24) >>> 0;
  const unknown = lo === 0xFFFFFFFF && hi === 0xFFFFFFFF;
  const size = hi * 4294967296 + lo;
  if (!unknown && size > maxOut) throw big();
  const limit = unknown ? maxOut : size;
  if (n < 18 || inp[13] !== 0) throw bad();
  // (probabilities: one flat array, offsets below)
  const IS_MATCH = 0, IS_REP = 192, IS_G0 = 204, IS_G1 = 216, IS_G2 = 228, REP0LONG = 240, POSSLOT = 432, SPEC = 688, ALIGN = 803;
  const LEN = 819, REPLEN = LEN + 514, LIT = REPLEN + 514;
  const probs = new Uint16Array(LIT + (0x300 << (lc + lp))).fill(1024);
  let range = 0xFFFFFFFF, code = ((inp[14] << 24) | (inp[15] << 16) | (inp[16] << 8) | inp[17]) >>> 0, ip = 18;
  let cap = Math.min(limit, Math.max(65536, n * 8)), out = new Uint8Array(cap), pos = 0;
  const ensure = need => { // (grow the output; never beyond the limit)
    if (need > limit) throw unknown ? big() : bad();
    if (need <= cap) return;
    cap = Math.min(limit, Math.max(need, cap * 2));
    const o = new Uint8Array(cap); o.set(out.subarray(0, pos)); out = o;
  };
  const bit = i => {
    if (range < 0x1000000) { if (ip >= n) throw bad(); range = (range << 8) >>> 0; code = ((code << 8) | inp[ip++]) >>> 0; }
    const p = probs[i], bound = (range >>> 11) * p;
    if (code < bound) { range = bound; probs[i] = p + ((2048 - p) >> 5); return 0; }
    range -= bound; code -= bound; probs[i] = p - (p >> 5); return 1;
  };
  const tree = (base, bits) => { let m = 1; for (let k = 0; k < bits; k++) m = (m << 1) | bit(base + m); return m - (1 << bits); };
  const rtree = (base, bits) => { let m = 1, r = 0; for (let k = 0; k < bits; k++) { const b = bit(base + m); m = (m << 1) | b; r |= b << k; } return r; };
  const len = (base, ps) => {
    if (!bit(base)) return tree(base + 2 + (ps << 3), 3);
    if (!bit(base + 1)) return 8 + tree(base + 130 + (ps << 3), 3);
    return 16 + tree(base + 258, 8);
  };
  const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1;
  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  for (;;) {
    if (!unknown && pos >= size) break;
    const ps = pos & pbMask;
    if (!bit(IS_MATCH + (state << 4) + ps)) { // literal
      if (pos >= cap) ensure(pos + 1);
      const base = LIT + 0x300 * (((pos & lpMask) << lc) + (pos > 0 ? out[pos - 1] >> (8 - lc) : 0));
      let sym = 1;
      if (state >= 7) {
        let mb = out[pos - rep0 - 1];
        do {
          const m = (mb >> 7) & 1; mb <<= 1;
          const b = bit(base + ((1 + m) << 8) + sym);
          sym = (sym << 1) | b;
          if (m !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | bit(base + sym);
      out[pos++] = sym;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let l;
    if (!bit(IS_REP + state)) { // match with a new distance
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      l = len(LEN, ps);
      const slot = tree(POSSLOT + ((l < 3 ? l : 3) << 6), 6);
      let dist = slot;
      if (slot >= 4) {
        const nb = (slot >> 1) - 1;
        dist = ((2 | (slot & 1)) << nb) >>> 0;
        if (slot < 14) dist += rtree(SPEC + dist - slot - 1, nb);
        else {
          let r = 0;
          for (let k = nb - 4; k > 0; k--) {
            if (range < 0x1000000) { if (ip >= n) throw bad(); range = (range << 8) >>> 0; code = ((code << 8) | inp[ip++]) >>> 0; }
            range >>>= 1;
            if (code >= range) { code -= range; r = (r << 1) | 1; } else r <<= 1;
          }
          dist += r * 16 + rtree(ALIGN, 4);
        }
      }
      rep0 = dist;
      if (rep0 === 0xFFFFFFFF) { // end marker (only valid when the size is unknown, and the coder must be flushed)
        if (!unknown || code !== 0) throw bad();
        break;
      }
      state = state < 7 ? 7 : 10;
      l += 2;
    } else {
      if (!bit(IS_G0 + state)) {
        if (!bit(REP0LONG + (state << 4) + ps)) { // short rep: one byte from rep0
          if (rep0 >= pos) throw bad();
          if (pos >= cap) ensure(pos + 1);
          out[pos] = out[pos - rep0 - 1]; pos++;
          state = state < 7 ? 9 : 11;
          continue;
        }
      } else {
        let dist;
        if (!bit(IS_G1 + state)) dist = rep1;
        else {
          if (!bit(IS_G2 + state)) dist = rep2;
          else { dist = rep3; rep3 = rep2; }
          rep2 = rep1;
        }
        rep1 = rep0; rep0 = dist;
      }
      l = len(REPLEN, ps) + 2;
      state = state < 7 ? 8 : 11;
    }
    if (rep0 >= pos) throw bad();
    if (!unknown && pos + l > size) throw bad();
    if (pos + l > cap) ensure(pos + l);
    const dd = rep0 + 1;
    for (let k = 0; k < l; k++, pos++) out[pos] = out[pos - dd];
  }
  return out.slice(0, pos);
}

// ============ MD5 (for the map hash in a replay; the replay's own file hash uses crypto.subtle) ============
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
function md5Hex(data) {
  const b = osrBytes(data), n = b.length;
  const st = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]), M = new Int32Array(16);
  const block = (a, o) => {
    for (let i = 0; i < 16; i++, o += 4) M[i] = a[o] | a[o + 1] << 8 | a[o + 2] << 16 | a[o + 3] << 24;
    let A = st[0], B = st[1], C = st[2], D = st[3];
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      const s = MD5_S[((i >> 4) << 2) | (i & 3)];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    st[0] += A; st[1] += B; st[2] += C; st[3] += D;
  };
  const full = n - (n % 64);
  for (let o = 0; o < full; o += 64) block(b, o);
  const tailLen = n - full, tail = new Uint8Array(tailLen < 56 ? 64 : 128);
  tail.set(b.subarray(full));
  tail[tailLen] = 0x80;
  const bits = n * 8, e = tail.length - 8;
  tail[e] = bits & 255; tail[e + 1] = (bits >>> 8) & 255; tail[e + 2] = (bits >>> 16) & 255; tail[e + 3] = (bits >>> 24) & 255;
  const hiBits = Math.floor(n / 0x20000000);
  tail[e + 4] = hiBits & 255; tail[e + 5] = (hiBits >>> 8) & 255; tail[e + 6] = (hiBits >>> 16) & 255; tail[e + 7] = (hiBits >>> 24) & 255;
  for (let o = 0; o < tail.length; o += 64) block(tail, o);
  let s = "";
  for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) s += ((st[i] >>> (8 * k)) & 255).toString(16).padStart(2, "0");
  return s;
}

// ============ .osr ============
class OsrReader {
  constructor(u8) { this.b = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = 0; }
  need(k) { if (k < 0 || this.p + k > this.b.length) throw osrErr("osr_short"); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  i64() { this.need(8); const v = this.dv.getBigInt64(this.p, true); this.p += 8; return v; }
  bytes(k) { this.need(k); const v = this.b.subarray(this.p, this.p + k); this.p += k; return v; }
  str(maxBytes) { // (osu! string: 0x00 = null, or 0x0b + ULEB128 length + UTF-8)
    const t = this.u8();
    if (t === 0) return "";
    if (t !== 0x0b) throw osrErr("osr_bad_string");
    let len = 0, shift = 0, k = 0, c;
    do {
      if (++k > 5) throw osrErr("osr_bad_string");
      c = this.u8(); len += (c & 0x7f) * Math.pow(2, shift); shift += 7;
    } while (c & 0x80);
    if (len > maxBytes) throw osrErr("osr_bad_string");
    return new TextDecoder().decode(this.bytes(len));
  }
}

// "time|hp,time|hp,..." (invalid parts are skipped)
function osrLife(s) {
  const out = [];
  if (!s) return out;
  for (const part of s.split(",")) {
    const k = part.indexOf("|");
    if (k <= 0) continue;
    const t = Number(part.slice(0, k)), v = Number(part.slice(k + 1));
    if (part.slice(k + 1) !== "" && Number.isFinite(t) && Number.isFinite(v)) out.push([t, v]);
  }
  return out;
}

// the frames text "w|x|y|z,w|x|y|z,...": w = ms since the last frame (lazer's LegacyScoreDecoder rules)
function osrFrames(text) {
  const L = text.length;
  const cap = Math.min(Math.floor((L + 1) / 8) + 1, OSR_MAX_FRAMES + 1); // (the shortest frame "0|0|0|0," is 8 characters)
  const T = new Float64Array(cap), X = new Float32Array(cap), Y = new Float32Array(cap), K = new Uint8Array(cap);
  let n = 0, acc = 0, last = -Infinity, seed = null, idx = 0, s = 0;
  while (s <= L) { // (one pass over the text: the bars of an entry are found while looking for its comma, so no scan can run long)
    let e = s, nb = 0, b1 = -1, b2 = -1, b3 = -1, b4 = -1;
    for (; e < L; e++) {
      const c = text.charCodeAt(e);
      if (c === 44) break;
      if (c === 124) { nb++; if (nb === 1) b1 = e; else if (nb === 2) b2 = e; else if (nb === 3) b3 = e; else if (nb === 4) b4 = e; }
    }
    const i = idx++, s0 = s;
    s = e + 1;
    if (nb < 3 || b1 === s0 || b2 === b1 + 1 || b3 === b2 + 1) continue; // (short entry, or an empty w / x / y)
    const w = Number(text.slice(s0, b1));
    if (!Number.isFinite(w)) continue;
    const zEnd = nb > 3 ? b4 : e;
    if (w === -12345) { const z = Number(text.slice(b3 + 1, zEnd)); if (Number.isFinite(z)) seed = Math.trunc(z); continue; }
    const x = Number(text.slice(b1 + 1, b2)), y = Number(text.slice(b2 + 1, b3));
    acc += w;
    if (!Number.isFinite(acc)) { acc = last > -Infinity ? last : 0; continue; }
    if (i < 2 && x === 256 && y === -500) continue; // (stable puts two frames like this at the start)
    const fx = Math.fround(x), fy = Math.fround(y);
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) continue;
    if (n >= OSR_MAX_FRAMES) throw osrErr("osr_too_big");
    const t = acc < last ? last : acc; // (never goes back)
    last = t;
    T[n] = t; X[n] = fx; Y[n] = fy; K[n] = Number(text.slice(b3 + 1, zEnd)) & 31;
    n++;
  }
  return { n, t: T.slice(0, n), x: X.slice(0, n), y: Y.slice(0, n), k: K.slice(0, n), seed, lastTime: n ? T[n - 1] : 0 };
}

// lazer's score info (JSON, LZMA'd): never throws, null when anything is off
function osrLazerInfo(bytes) {
  try {
    const raw = JSON.parse(new TextDecoder().decode(lzmaDecode(bytes, OSR_MAX_JSON)));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const pick = (a, b) => raw[a] !== undefined ? raw[a] : raw[b];
    const stats = o => {
      if (!o || typeof o !== "object" || Array.isArray(o)) return null;
      const r = {};
      let k = 0;
      for (const key of Object.keys(o)) { if (key !== "__proto__" && Number.isFinite(o[key]) && ++k <= 64) r[key] = o[key]; }
      return r;
    };
    const mods = [];
    if (Array.isArray(raw.mods)) for (const m of raw.mods.slice(0, 64)) {
      if (!m || typeof m.acronym !== "string" || m.acronym.length > 8) continue;
      mods.push({ acronym: m.acronym, settings: m.settings && typeof m.settings === "object" && !Array.isArray(m.settings) ? m.settings : {} });
    }
    const id = Number(pick("online_id", "onlineId")), pauses = pick("pauses", "pauses");
    const tsm = Number(pick("total_score_without_mods", "totalScoreWithoutMods"));
    const cv = pick("client_version", "clientVersion");
    return {
      raw, statistics: stats(raw.statistics), maximumStatistics: stats(pick("maximum_statistics", "maximumStatistics")), mods,
      rank: typeof raw.rank === "string" && raw.rank.length <= 4 ? raw.rank : null,
      clientVersion: typeof cv === "string" && cv.length <= 64 ? cv : null,
      onlineId: Number.isSafeInteger(id) && id > 0 ? id : null,
      pauses: Array.isArray(pauses) ? pauses.slice(0, 10000).filter(Number.isFinite) : null,
      totalScoreWithoutMods: Number.isFinite(tsm) && pick("total_score_without_mods", "totalScoreWithoutMods") != null ? tsm : null,
    };
  } catch (e) { return null; }
}

function parseOsr(buf) {
  let u8;
  try { u8 = osrBytes(buf); } catch (e) { throw osrErr("osr_short"); }
  if (u8.length > OSR_MAX_FILE) throw osrErr("osr_too_big");
  const r = new OsrReader(u8);
  const mode = r.u8();
  if (mode > 3) throw osrErr("osr_bad_replay");
  const version = r.i32();
  const mapMd5 = r.str(OSR_MAX_STR), player = r.str(OSR_MAX_STR), replayMd5 = r.str(OSR_MAX_STR);
  const counts = { n300: r.u16(), n100: r.u16(), n50: r.u16(), geki: r.u16(), katu: r.u16(), miss: r.u16() };
  const score = r.i32(), maxCombo = r.u16(), perfect = r.u8() !== 0, mods = r.i32();
  const lifeBar = osrLife(r.str(OSR_MAX_LIFE));
  const ticks = r.i64();
  const ms = Number((ticks - 621355968000000000n) / 10000n);
  const date = ticks > 0n && ticks <= 3155378975999999999n && ms >= 0 ? ms : null; // (.NET ticks since 0001-01-01; up to 9999-12-31)
  const rlen = r.i32();
  if (rlen < 0) throw osrErr("osr_bad_replay");
  const packed = r.bytes(rlen); // (osr_short when the file ends before the declared length)
  let onlineId = null;
  if (version >= 20140721) onlineId = r.i64();
  else if (version >= 20121008) onlineId = BigInt(r.i32());
  onlineId = onlineId !== null && onlineId > 0n && onlineId <= 9007199254740992n ? Number(onlineId) : null;
  let text = "";
  if (rlen > 0) {
    try { text = new TextDecoder().decode(lzmaDecode(packed, OSR_MAX_FRAMES_TEXT)); }
    catch (e) { throw osrErr(e && e.message === "lzma_too_big" ? "osr_too_big" : "osr_bad_replay"); }
  }
  const f = osrFrames(text);
  let lazerInfo = null;
  if (version >= 30000001) {
    try {
      const len = r.i32();
      if (len > 0 && r.p + len <= u8.length) lazerInfo = osrLazerInfo(r.bytes(len));
    } catch (e) { lazerInfo = null; }
  }
  return {
    mode, version, lazer: version >= 30000000, mapMd5, player, replayMd5, counts, score, maxCombo, perfect, mods, date, lifeBar, onlineId,
    frames: { n: f.n, t: f.t, x: f.x, y: f.y, k: f.k }, seed: f.seed, lastTime: f.lastTime, lazerInfo,
  };
}

// ============ mods ============
// osu! mod bits (stable). NC (512) comes together with DT (64), PF (16384) with SD (32).
const OSR_MODBITS = [
  [1, "NF"], [2, "EZ"], [4, "TD"], [8, "HD"], [16, "HR"], [32, "SD"], [64, "DT"], [128, "RX"], [256, "HT"], [512, "NC"], [1024, "FL"],
  [2048, "AT"], [4096, "SO"], [8192, "AP"], [16384, "PF"], [32768, "K4"], [65536, "K5"], [131072, "K6"], [262144, "K7"], [524288, "K8"],
  [1048576, "FI"], [2097152, "RN"], [4194304, "CN"], [8388608, "TP"], [16777216, "K9"], [33554432, "KC"], [67108864, "K1"],
  [134217728, "K3"], [268435456, "K2"], [536870912, "SV2"], [1073741824, "MR"],
];
// display order (DT is left out when NC is set, SD when PF is set, HT when DC is set); the rest follows
const OSR_MODORDER = ["EZ", "NF", "HT", "DC", "HR", "SD", "DT", "RX", "NC", "HD", "FL", "AT", "SO", "AP", "PF", "TD", "FI", "RN", "CN", "TP", "SV2", "MR", "K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "KC"];
// no visible effect on the playback, so not "unsupported" (EZ HR DT NC HT DC HD FL are applied)
const OSR_MODOK = new Set(["EZ", "HR", "DT", "NC", "HT", "DC", "HD", "FL", "NF", "SD", "PF", "TD", "SO", "RX", "AP", "SV2", "V2"]);
const OSR_RATEMODS = new Set(["DT", "NC", "HT", "DC", "AS", "WU", "WD"]);

function replayMods(mods, lazerInfo) {
  const m = Number(mods) | 0, have = new Set();
  for (const [b, a] of OSR_MODBITS) if (m & b) have.add(a);
  const jm = lazerInfo && Array.isArray(lazerInfo.mods) ? lazerInfo.mods : [];
  for (const j of jm) if (j && typeof j.acronym === "string" && j.acronym) have.add(j.acronym);
  if (have.has("NC")) have.delete("DT");
  if (have.has("PF")) have.delete("SD");
  if (have.has("DC")) have.delete("HT");
  const list = OSR_MODORDER.filter(a => have.has(a)), done = new Set(list);
  for (const a of have) if (!done.has(a)) list.push(a);
  let rate = have.has("DT") || have.has("NC") ? 1.5 : have.has("HT") || have.has("DC") ? 0.75 : 1;
  for (const j of jm) {
    const sc = j && OSR_RATEMODS.has(j.acronym) && j.settings ? j.settings.speed_change : undefined;
    if (typeof sc === "number" && Number.isFinite(sc) && sc >= 0.25 && sc <= 4) { rate = sc; break; }
  }
  // pitch: the song's pitch follows the speed (NC, DC; lazer's adjust_pitch on DT / HT, which is on by default for AS / WU / WD); else it is kept
  const sm = ["NC", "DT", "DC", "HT", "AS", "WU", "WD"].find(a => have.has(a)), sj = jm.find(j => j && j.acronym === sm);
  const ap = sj && sj.settings ? sj.settings.adjust_pitch : undefined;
  const pitch = sm === "NC" || sm === "DC" || (typeof ap === "boolean" ? ap : sm === "AS" || sm === "WU" || sm === "WD");
  return {
    list, rate, pitch, hr: have.has("HR"), ez: have.has("EZ"), hd: have.has("HD"), fl: have.has("FL"), rx: have.has("RX"), ap: have.has("AP"),
    unsupported: list.filter(a => !OSR_MODOK.has(a)),
  };
}

// difficulty after EZ / HR (the rate doesn't change these numbers: AR and OD are in map time)
function replayDiff(diff, mods) {
  const num = (v, d) => { v = Number(v); return Number.isFinite(v) ? v : d; };
  let cs = num(diff && diff.CircleSize, 5), ar = num(diff && diff.ApproachRate, 5), od = num(diff && diff.OverallDifficulty, 5), hp = num(diff && diff.HPDrainRate, 5);
  if (mods && mods.ez) { cs *= 0.5; ar *= 0.5; od *= 0.5; hp *= 0.5; }
  if (mods && mods.hr) { cs = Math.min(10, cs * 1.3); ar = Math.min(10, ar * 1.4); od = Math.min(10, od * 1.4); hp = Math.min(10, hp * 1.4); }
  return { cs, ar, od, hp };
}

function replayAccuracy(c) {
  const n3 = +(c && c.n300) || 0, n1 = +(c && c.n100) || 0, n5 = +(c && c.n50) || 0, mi = +(c && c.miss) || 0;
  const total = n3 + n1 + n5 + mi;
  return total > 0 ? (300 * n3 + 100 * n1 + 50 * n5) / (300 * total) : 1;
}

// osu!stable's rank rules (standard mode)
function replayRank(c, modsInfo) {
  const n3 = +(c && c.n300) || 0, n1 = +(c && c.n100) || 0, n5 = +(c && c.n50) || 0, mi = +(c && c.miss) || 0;
  const total = n3 + n1 + n5 + mi;
  if (total <= 0) return "D";
  const r3 = n3 / total, r5 = n5 / total, sil = !!(modsInfo && (modsInfo.hd || modsInfo.fl));
  if (n1 === 0 && n5 === 0 && mi === 0) return sil ? "XH" : "X";
  if (r3 > 0.9 && r5 <= 0.01 && mi === 0) return sil ? "SH" : "S";
  if ((r3 > 0.8 && mi === 0) || r3 > 0.9) return "A";
  if ((r3 > 0.7 && mi === 0) || r3 > 0.8) return "B";
  if (r3 > 0.6) return "C";
  return "D";
}

// ============ sharing a saved replay by link (js/replayui.js; the server: api/v1.js replays/:id/share, replays/shared/:id) ============
// The link is <page>?replay=<the replay's uuid>&key=<the share key: 32 characters of base64url>. Pure helpers: the same checks as the server's.
const RP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, RP_SHARE_KEY = /^[A-Za-z0-9_-]{32}$/;
const rpShareOk = (id, key) => RP_UUID.test(String(id || "")) && RP_SHARE_KEY.test(String(key || ""));
const rpShareURL = (base, id, key) => rpShareOk(id, key) ? `${String(base).replace(/[?#].*$/, "")}?replay=${id}&key=${key}` : "";
function rpShareParse(search) { // "?replay=..&key=.." -> { id, key } (a link that is not a valid one: null)
  let p; try { p = new URLSearchParams(search); } catch { return null; }
  const id = String(p.get("replay") || "").toLowerCase(), key = String(p.get("key") || "");
  return rpShareOk(id, key) ? { id, key } : null;
}

// ============ the end of a replay (js/player.js frame(): the Skip button) ============
// A replay ends with the song (buffer end / audio ended) or when Skip is pressed, not with its last frame. Skip comes once nothing more is
// played: after the last object, or after the replay's last frame when that comes first (the player quit or failed); it waits 1 s, and it is not
// offered when the song has 3 s or less left. Times in song ms; F = the frames ({ n, t }) or null.
const RP_SKIP_WAIT = 1000, RP_SKIP_LEFT = 3000;
function rpSkipAt(last, F) { return Math.min(+last > 0 ? +last : 0, F && F.n > 0 ? F.t[F.n - 1] : Infinity); }
function rpShowEndSkip(t, skipAt, dur) { return t >= skipAt + RP_SKIP_WAIT && dur - t > RP_SKIP_LEFT; }

// ============ the live Top 50 board while a replay plays (drawn by drawRpBoard in js/player.js, the list from t5Load in js/replayui.js) ============
// The board's scores are classic: trimScore (api/_lib/osu.js) takes legacy_total_score / classic_total_score / score first. A stable replay's header
// score is that same scale. A lazer replay's header holds lazer's STANDARDISED total (LegacyScoreEncoder writes ScoreInfo.TotalScore; its JSON
// has no total_score), so it is turned into lazer's own classic display score (ScoreInfoExtensions.convertStandardisedToClassic, osu!:
// (N² · 32.57 + 100000) · standardised / 1e6, N = the basic judgements of a full play): one factor per replay, the same for every frame.
const RPB_BASIC = ["great", "ok", "meh", "miss", "good", "perfect"];
function rpBoardK(d) {
  if (!d || !d.lazer) return 1;
  const li = d.lazerInfo, mx = li && li.maximumStatistics, st = li && li.statistics, c = d.counts || {}, sum = (o, ks) => ks.reduce((a, k) => a + (+o[k] > 0 ? +o[k] : 0), 0);
  let n = mx ? sum(mx, RPB_BASIC) : 0;
  if (!(n > 0) && st) n = sum(st, RPB_BASIC); // (no maximum statistics: what was judged, a pass's count)
  if (!(n > 0)) n = sum(c, ["n300", "n100", "n50", "miss"]);
  return (n * n * 32.57 + 100000) / 1e6;
}
// the others' rows for the board (t5Clean's rows): highest first, without this very replay when it is one of them (the same player and the same
// final score; a lazer replay's converted score may differ from osu!'s by rounding: 0.1%). Rows without a score (0: osu! gave no classic number)
// can't be placed and are left out. fin = the replay's final score on its own scale (rpuStats(d).score). { rows, cut: the row taken out or null }
// is this row of the board (t5Clean's: name, score) this very replay? The same player (any case) with the same score: exact on the replay's own
// scale for stable, the converted (classic) score within 0.1% for lazer. One rule for the live board (rpBoardList) and the results panel (t5Draw)
function rpBoardMine(d, fin) {
  const k = rpBoardK(d), me = String((d && d.player) || "").toLowerCase(), f = Math.round(+fin || 0), hd = Math.round(+(d && d.score) || 0), cf = Math.round((+fin || 0) * k);
  return r => !!me && String((r && r.name) || "").toLowerCase() === me && (k === 1 ? r.score === f || r.score === hd : Math.abs(r.score - cf) <= Math.max(2, r.score * 1e-3));
}
function rpBoardList(list, d, fin) {
  const mine = rpBoardMine(d, fin);
  let cut = null; const rows = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || !(r.score > 0)) continue;
    if (!cut && mine(r)) { cut = r; continue; }
    rows.push(r);
  }
  rows.sort((a, b) => b.score - a.score); // (stable: equal scores keep osu!'s order)
  return { rows, cut };
}
// the replay's slot among rows (highest first) at score v: every row with as much or more stays ahead (osu!: the earlier score wins a tie)
function rpBoardIdx(rows, v) { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].score >= v) lo = m + 1; else hi = m; } return lo; }
// the first slot of n shown out of total (the others and the replay), the replay's slot p (may be fractional while it slides) near the middle
const rpBoardWin = (total, p, n) => Math.max(0, Math.min(total - n, p - (n >> 1)));
// a slot's label: below the 50th the replay is not on the list
const rpBoardRank = slot => slot >= 50 ? "50+" : "#" + (slot + 1);
