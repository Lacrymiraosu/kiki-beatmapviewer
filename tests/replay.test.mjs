// The replay core (js/replay.js): LZMA decoder (against Python's lzma), MD5 (against node:crypto), .osr parsing (two small
// synthetic fixtures, hostile files), mods / difficulty / accuracy / rank.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadScripts, J } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js"]);
const fx = name => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name));
const md5 = b => createHash("md5").update(b).digest("hex");
const codeOf = f => { try { f(); } catch (e) { return e.message; } return null; };
let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

// ---- test data from Python's lzma (FORMAT_ALONE), made once; the LZMA tests are skipped when python3 is missing ----
const PY = `
import sys, json, lzma, random, base64
spec = json.load(sys.stdin)
def gen(kind, size, seed):
    r = random.Random(seed)
    if kind == "rand": return r.randbytes(size)
    if kind == "text": return bytes(r.choices(b"abcdefgh \\n", k=size))
    if kind == "zeros": return bytes(size)
    if kind == "rep":
        pat = r.randbytes(37); d = bytearray((pat * (size // 37 + 1))[:size])
        for _ in range(size // 1000):
            d[r.randrange(size)] = r.randrange(256)
        return bytes(d)
    if kind == "mix":
        d = bytearray()
        while len(d) < size:
            c = r.random()
            if c < 0.3 or len(d) < 10: d += r.randbytes(r.randrange(1, 20))
            else:
                n = r.choice([2, 3, 4, 8, 20, 100, 300]); dist = r.choice([1, 2, 3, r.randrange(1, len(d) + 1), r.randrange(1, min(len(d), 70000) + 1)])
                dist = min(dist, len(d)); piece = bytearray()
                for i in range(n):
                    src = len(d) + i - dist
                    piece.append(d[src] if src < len(d) else piece[src - len(d)])
                if c > 0.8: piece[r.randrange(len(piece))] ^= 1
                d += piece
        return bytes(d[:size])
out = []
for s in spec:
    data = gen(s["kind"], s["size"], s.get("seed", 1))
    f = {"id": lzma.FILTER_LZMA1, "preset": s.get("preset", 6)}
    for k in ("lc", "lp", "pb", "mode", "mf", "nice_len", "depth"):
        if k in s: f[k] = s[k]
    lz = lzma.compress(data, format=lzma.FORMAT_ALONE, filters=[f])
    out.append({"name": s["name"], "raw": base64.b64encode(data).decode(), "lz": base64.b64encode(lz).decode()})
json.dump(out, sys.stdout)
`;
const SPEC = [
  { name: "empty", kind: "rand", size: 0 }, { name: "1 byte", kind: "rand", size: 1 }, { name: "2 bytes", kind: "text", size: 2 },
  { name: "3 bytes zeros", kind: "zeros", size: 3 }, { name: "100 random", kind: "rand", size: 100 }, { name: "100 text", kind: "text", size: 100 },
  { name: "10k random", kind: "rand", size: 10000 }, { name: "10k text", kind: "text", size: 10000, seed: 2 }, { name: "10k repetitive", kind: "rep", size: 10000 },
  { name: "10k mix", kind: "mix", size: 10000, seed: 3 }, { name: "300k mix", kind: "mix", size: 300000, seed: 4 },
  { name: "100k zeros (long matches)", kind: "zeros", size: 100000 },
  { name: "1M random", kind: "rand", size: 1000000, seed: 5, preset: 1 }, { name: "1M repetitive", kind: "rep", size: 1000000, seed: 6 },
  { name: "1M text", kind: "text", size: 1000000, seed: 7 }, { name: "1M mix", kind: "mix", size: 1000000, seed: 8, preset: 3 },
  // (every lc / lp / pb the encoder allows, fast / normal mode, different match finders)
  ...[[0, 0, 0], [1, 0, 0], [0, 2, 0], [4, 0, 4], [2, 2, 1], [0, 4, 2], [3, 0, 2], [4, 0, 0]].map(([lc, lp, pb], i) => ({ name: `lc${lc} lp${lp} pb${pb}`, kind: "mix", size: 20000, seed: 20 + i, lc, lp, pb })),
  { name: "mode fast", kind: "mix", size: 30000, seed: 31, mode: 1, nice_len: 8, mf: 4 }, { name: "mf bt2 preset 9", kind: "mix", size: 30000, seed: 32, preset: 9, mf: 18 },
  { name: "preset 0", kind: "mix", size: 30000, seed: 33, preset: 0 }, { name: "preset 9e", kind: "text", size: 30000, seed: 34, preset: 9 + 2 ** 31 },
];
let CASES = null;
{
  const r = spawnSync("python3", ["-I", "-c", PY], { input: JSON.stringify(SPEC), maxBuffer: 1 << 30 });
  if (r.status === 0) CASES = JSON.parse(r.stdout.toString()).map(c => ({ name: c.name, raw: Buffer.from(c.raw, "base64"), lz: Buffer.from(c.lz, "base64") }));
  else console.log("python3 lzma not available: LZMA comparisons skipped");
}
const needPy = { skip: CASES ? false : "python3 with lzma not available" };
const find = name => CASES.find(c => c.name === name);
const withSize = (lz, size) => { const b = Buffer.from(lz); b.writeBigUInt64LE(BigInt(size), 5); return b; }; // (known size in the header)

// ---- small committed vectors (Python lzma FORMAT_ALONE output), so the decoder is tested without Python too ----
test("LZMA: committed vectors (empty, text, repeats + zeros)", () => {
  const dec = b64 => Buffer.from(P.lzmaDecode(Buffer.from(b64, "base64"), 10000));
  assert.equal(dec("XQAAgAD//////////wCD//v//8AAAAA=").length, 0);
  assert.equal(dec("XQAAgAD//////////wA0GUnujekXiTozX/32R0B0IQPdLZ//9i2AAA==").toString(), "hello world, hello world, hello world!");
  const want = Buffer.concat([Buffer.from("abcabcabc".repeat(20)), Buffer.from(Array.from({ length: 50 }, (_, i) => i)), Buffer.alloc(300)]);
  assert.ok(dec("XQAAgAD//////////wAwmIisZHypgmmIeMWYvNid4Cm09EDRBRyvDIG4sj8/xtZFm+G+JtZEWpq1CKH4BUCIT6Na57V4dj+BOEBm///9YZAA").equals(want));
});

for (const c of CASES || []) {
  test(`LZMA matches Python: ${c.name} (${c.raw.length} bytes -> ${c.lz.length})`, needPy, () => {
    const out = P.lzmaDecode(c.lz, c.raw.length);
    assert.equal(out.length, c.raw.length);
    assert.ok(Buffer.from(out).equals(c.raw), "content differs");
    assert.equal(P.lzmaDecode(c.lz, c.raw.length + 1000).length, c.raw.length);
  });
}

test("LZMA: a known size in the header (the way osu! writes it) gives the same data", needPy, () => {
  for (const name of ["10k mix", "100 random", "1M repetitive", "empty", "lc0 lp2 pb0"]) {
    const c = find(name), out = P.lzmaDecode(withSize(c.lz, c.raw.length), c.raw.length);
    assert.ok(Buffer.from(out).equals(c.raw), name);
  }
  // a known size larger than the stream is corrupt; one smaller stops there (or is corrupt if a match crosses the end)
  const c = find("10k mix");
  assert.equal(codeOf(() => P.lzmaDecode(withSize(c.lz, c.raw.length + 50), 1e6)), "lzma_bad");
  for (const k of [1, 100, 5000, 9999]) {
    let o = null; try { o = P.lzmaDecode(withSize(c.lz, k), 1e6); } catch (e) { assert.equal(e.message, "lzma_bad"); }
    if (o) assert.ok(Buffer.from(o).equals(c.raw.subarray(0, k)), `size ${k}`);
  }
  // no end marker at all (osu! writes the size and no marker): cut the stream as short as the decoder allows
  let cut = 0;
  while (cut < 12 && codeOf(() => P.lzmaDecode(withSize(c.lz, c.raw.length).subarray(0, c.lz.length - cut - 1), 1e6)) === null) cut++;
  assert.ok(cut >= 3, `only ${cut} trailing bytes were not needed`);
  assert.ok(Buffer.from(P.lzmaDecode(withSize(c.lz, c.raw.length).subarray(0, c.lz.length - cut), 1e6)).equals(c.raw));
});

test("LZMA: output limit (lzma_too_big), whether the size is known or not", needPy, () => {
  const c = find("10k mix"), n = c.raw.length;
  assert.equal(P.lzmaDecode(c.lz, n).length, n);
  assert.equal(codeOf(() => P.lzmaDecode(c.lz, n - 1)), "lzma_too_big");
  assert.equal(codeOf(() => P.lzmaDecode(c.lz, 0)), "lzma_too_big");
  assert.equal(codeOf(() => P.lzmaDecode(withSize(c.lz, n), n - 1)), "lzma_too_big");
  assert.equal(codeOf(() => P.lzmaDecode(withSize(c.lz, 2 ** 40), 1e9)), "lzma_too_big");
  // an unknown size with 0xFFFFFFFF in only one half is a (huge) known size
  const b = Buffer.from(c.lz); b.writeUInt32LE(5, 9);
  assert.equal(codeOf(() => P.lzmaDecode(b, 1e6)), "lzma_too_big");
  // a bomb: 100 MB of zeros in a tiny stream stops at the limit without allocating it
  const z = find("100k zeros (long matches)");
  assert.ok(z.lz.length < 200);
  assert.equal(codeOf(() => P.lzmaDecode(z.lz, 1000)), "lzma_too_big");
  assert.equal(P.lzmaDecode(z.lz, 100000).length, 100000);
});

test("LZMA: truncated streams throw lzma_bad at every length", needPy, () => {
  for (const name of ["100 random", "10k mix", "lc4 lp0 pb4"]) {
    const c = find(name), step = c.lz.length > 3000 ? 7 : 1;
    for (let n = 0; n < c.lz.length; n += step) {
      const e = codeOf(() => P.lzmaDecode(c.lz.subarray(0, n), 1e6));
      assert.equal(e, "lzma_bad", `${name} cut at ${n}/${c.lz.length}`);
    }
  }
});

test("LZMA: bit-flipped streams never hang and only throw lzma_bad / lzma_too_big", needPy, () => {
  const t0 = Date.now();
  let thrown = 0, ok = 0;
  for (const name of ["10k mix", "100 text", "10k random", "100k zeros (long matches)"]) {
    const c = find(name);
    for (let k = 0; k < 150; k++) {
      const b = Buffer.from(c.lz);
      const flips = 1 + rnd(3);
      for (let f = 0; f < flips; f++) b[k < 30 ? rnd(Math.min(b.length, 40)) : rnd(b.length)] ^= 1 << rnd(8);
      try { const o = P.lzmaDecode(b, 200000); assert.ok(o.length <= 200000); ok++; }
      catch (e) { assert.ok(e.message === "lzma_bad" || e.message === "lzma_too_big", e.message); thrown++; }
    }
  }
  assert.ok(thrown > 100, `only ${thrown} of ${thrown + ok} corrupted streams were rejected`);
  assert.ok(Date.now() - t0 < 20000, "took too long");
});

test("LZMA: random garbage and bad headers", () => {
  for (let k = 0; k < 300; k++) {
    const b = Buffer.alloc(13 + rnd(300));
    for (let i = 0; i < b.length; i++) b[i] = rnd(256);
    b[0] = rnd(225); if (k % 2) { b.fill(0xff, 5, 13); } if (k % 3 === 0) b[13] = 0;
    const e = codeOf(() => P.lzmaDecode(b, 100000));
    assert.ok(e === null || e === "lzma_bad" || e === "lzma_too_big", e);
  }
  const hdr = (props, tail = 0) => { const b = Buffer.alloc(18 + tail); b[0] = props; b.fill(0xff, 5, 13); return b; };
  assert.equal(codeOf(() => P.lzmaDecode(new Uint8Array(0), 10)), "lzma_bad");
  assert.equal(codeOf(() => P.lzmaDecode(new Uint8Array(12), 10)), "lzma_bad");
  assert.equal(codeOf(() => P.lzmaDecode(hdr(225, 100), 10)), "lzma_bad"); // props byte out of range
  assert.equal(codeOf(() => P.lzmaDecode(hdr(0x5d, 0).subarray(0, 17), 10)), "lzma_bad"); // not even the 5 coder bytes
  const b = hdr(0x5d, 10); b[13] = 1;
  assert.equal(codeOf(() => P.lzmaDecode(b, 10)), "lzma_bad"); // the first coder byte must be 0
  // lc=8 lp=4 (the biggest literal tables) must not blow up either
  const big = hdr(8 + 9 * (4 + 5 * 4), 50);
  assert.ok(["lzma_bad", null, "lzma_too_big"].includes(codeOf(() => P.lzmaDecode(big, 1000))));
});

test("LZMA: accepts a Buffer, an ArrayBuffer view with an offset, and rejects non-bytes", needPy, () => {
  const c = find("100 text"), pad = Buffer.concat([Buffer.from([9, 9, 9]), c.lz, Buffer.from([7, 7])]);
  assert.ok(Buffer.from(P.lzmaDecode(pad.subarray(3, 3 + c.lz.length), 1000)).equals(c.raw));
  assert.throws(() => P.lzmaDecode("nope", 10));
});

// ---- MD5 ----
test("md5Hex matches node:crypto for lengths 0..300 and some big ones", () => {
  const data = Buffer.alloc(1_000_003);
  for (let i = 0; i < data.length; i++) data[i] = rnd(256);
  for (let n = 0; n <= 300; n++) assert.equal(P.md5Hex(data.subarray(0, n)), md5(data.subarray(0, n)), `len ${n}`);
  for (const n of [511, 512, 513, 1023, 1024, 4096, 65535, 65536, 100001, 1_000_003]) assert.equal(P.md5Hex(data.subarray(0, n)), md5(data.subarray(0, n)), `len ${n}`);
  assert.equal(P.md5Hex(new Uint8Array(0)), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(P.md5Hex(Buffer.from("abc")), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(P.md5Hex(data.buffer.slice(data.byteOffset, data.byteOffset + 77)), md5(data.subarray(0, 77))); // (ArrayBuffer)
  assert.equal(P.md5Hex(data.subarray(10, 90)), md5(data.subarray(10, 90))); // (view with an offset)
});

// ---- .osr ----
const MAP_MD5 = "0123456789abcdef0123456789abcdef";
test("parseOsr: the stable fixture (version 20230101, HR+HD)", () => {
  const d = J(P.parseOsr(fx("stable-small.osr")));
  assert.equal(d.mode, 0); assert.equal(d.version, 20230101); assert.equal(d.lazer, false);
  assert.equal(d.mapMd5, MAP_MD5); assert.equal(d.player, "TestPlayer"); assert.equal(d.replayMd5, "fedcba9876543210fedcba9876543210");
  assert.deepEqual(d.counts, { n300: 10, n100: 2, n50: 1, geki: 3, katu: 1, miss: 1 });
  assert.equal(d.score, 123456); assert.equal(d.maxCombo, 9); assert.equal(d.perfect, false); assert.equal(d.mods, 24);
  assert.equal(d.date, Date.UTC(2023, 0, 1)); assert.equal(d.onlineId, 123456789);
  assert.deepEqual(d.lifeBar, [[0, 1], [500, 0.9], [1000, 0.5]]);
  assert.equal(d.seed, 31337); assert.equal(d.lastTime, 63); assert.equal(d.lazerInfo, null);
  // the two stable start frames (256,-500) are dropped but their time counts; the short "5|1|" entry is skipped
  assert.equal(d.frames.n, 4);
  assert.deepEqual(Object.values(d.frames.t), [15, 31, 47, 63]);
  assert.deepEqual(Object.values(d.frames.x), [100, 110.5, 120, 130]);
  assert.deepEqual(Object.values(d.frames.y), [100, 120, 130, 140.25]);
  assert.deepEqual(Object.values(d.frames.k), [0, 1, 5, 0]);
  const raw = P.parseOsr(fx("stable-small.osr"));
  assert.ok(raw.frames.t instanceof P.Float64Array && raw.frames.x instanceof P.Float32Array && raw.frames.k instanceof P.Uint8Array);
});

test("parseOsr: the lazer fixture (version 30000019, JSON score info)", () => {
  const raw = P.parseOsr(fx("lazer-small.osr")), d = J(raw);
  assert.equal(d.lazer, true); assert.equal(d.version, 30000019); assert.equal(d.player, "LazerPlayer"); assert.equal(d.mods, 88);
  assert.equal(d.onlineId, 987654321); assert.equal(d.frames.n, 4);
  const li = d.lazerInfo;
  assert.ok(li);
  assert.deepEqual(li.statistics, { great: 10, ok: 2, meh: 1, miss: 1, large_tick_hit: 3 });
  assert.deepEqual(li.maximumStatistics, { great: 14, large_tick_hit: 3 });
  assert.deepEqual(li.mods.map(m => m.acronym), ["HR", "HD", "DT"]);
  assert.equal(li.mods[2].settings.speed_change, 1.3);
  assert.equal(li.rank, "A"); assert.equal(li.clientVersion, "2025.1011.0"); assert.equal(li.onlineId, 987654321);
  assert.deepEqual(li.pauses, [1200, 3400]); assert.equal(li.totalScoreWithoutMods, 654321);
  assert.equal(li.raw.user_id, 42);
  // mods: the 1.3x speed_change of the JSON wins over DT's 1.5
  const m = P.replayMods(d.mods, raw.lazerInfo);
  assert.deepEqual(J(m.list), ["HR", "DT", "HD"]); assert.equal(m.rate, 1.3); assert.deepEqual(J(m.unsupported), []);
});

test("parseOsr: accepts ArrayBuffer, Uint8Array and Buffer views with an offset", () => {
  const b = fx("stable-small.osr"), ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  assert.equal(P.parseOsr(ab).player, "TestPlayer");
  assert.equal(P.parseOsr(new Uint8Array(ab)).player, "TestPlayer");
  const padded = Buffer.concat([Buffer.from([1, 2, 3]), b, Buffer.from([4])]);
  assert.equal(P.parseOsr(padded.subarray(3, 3 + b.length)).frames.n, 4);
});

// where the lazer JSON block starts in a lazer fixture: [int32 length][LZMA, props 0x5d] up to the end of the file
const blockStart = f => { for (let i = f.length - 20; i > 0; i--) if (f.readInt32LE(i) === f.length - i - 4 && f[i + 4] === 0x5d) return i; throw new Error("no block"); };
// a minimal .osr around a given compressed-frames blob
function osr({ mode = 0, version = 20230101, lz = Buffer.alloc(0), lzLen = lz.length, life = "" } = {}) {
  const s = v => { const b = Buffer.from(v), n = b.length, u = []; let x = n; do { let c = x & 0x7f; x >>= 7; u.push(c | (x ? 0x80 : 0)); } while (x); return Buffer.concat([Buffer.from([0x0b]), Buffer.from(u), b]); };
  const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; }, u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  return Buffer.concat([Buffer.from([mode]), i32(version), s("a".repeat(32)), s("P"), s("b".repeat(32)), ...[1, 2, 3, 4, 5, 6].map(u16), i32(1000), u16(5), Buffer.from([0]), i32(0), s(life), Buffer.alloc(8, 0), i32(lzLen), lz, Buffer.alloc(8)]); // (the 8 bytes at the end: online id)
}

test("parseOsr: hostile and truncated files throw the right code", needPy, () => {
  const err = (b) => codeOf(() => P.parseOsr(b));
  const stable = fx("stable-small.osr"), lazer = fx("lazer-small.osr");
  assert.equal(err(new Uint8Array(0)), "osr_short");
  assert.equal(err(Buffer.from([0, 1, 2])), "osr_short");
  assert.equal(err("not bytes"), "osr_short");
  assert.equal(err(Buffer.alloc(8 * 1024 * 1024 + 1)), "osr_too_big");
  // every cut of the file is a clean error, never a hang: osr_short while the header / frames / online id are incomplete;
  // a lazer file cut inside the JSON block still parses (lazerInfo null)
  for (let n = 0; n < stable.length; n++) assert.equal(err(stable.subarray(0, n)), "osr_short", `stable cut at ${n}`);
  const start = blockStart(lazer);
  for (let n = 0; n < lazer.length; n++) {
    if (n < start) assert.equal(err(lazer.subarray(0, n)), "osr_short", `lazer cut at ${n}`);
    else { assert.equal(err(lazer.subarray(0, n)), null, `lazer cut at ${n}`); assert.equal(P.parseOsr(lazer.subarray(0, n)).lazerInfo === null, n < lazer.length, `lazer cut at ${n}`); }
  }
  // (a bad mode, a bad string marker, an enormous string length, a negative / too long data length)
  const ok = osr({});
  assert.equal(err(ok), null);
  assert.equal(err(osr({ mode: 4 })), "osr_bad_replay");
  const bm = Buffer.from(ok); bm[5] = 0x0c; assert.equal(err(bm), "osr_bad_string");
  const bl = Buffer.from(ok); bl[6] = 0xff; bl[7] = 0xff; bl[8] = 0xff; bl[9] = 0xff; bl[10] = 0x7f; assert.equal(err(bl), "osr_bad_string");
  const bl2 = Buffer.from(ok); bl2[6] = 0x81; bl2[7] = 0x40; assert.equal(err(bl2), "osr_bad_string"); // 8193 bytes > 4096
  const bl3 = Buffer.from(ok); bl3[6] = 0x80; bl3[7] = 0x80; bl3[8] = 0x80; bl3[9] = 0x80; bl3[10] = 0x80; bl3[11] = 0; assert.equal(err(bl3), "osr_bad_string"); // ULEB longer than 5 bytes
  assert.equal(err(osr({ lzLen: -1 })), "osr_bad_replay");
  assert.equal(err(osr({ lzLen: 2 ** 31 - 1 })), "osr_short");
  assert.equal(err(osr({ lz: Buffer.concat([Buffer.from([0x5d, 0, 0, 0x80, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0]), Buffer.from("garbage that is no lzma stream at all")]) })), "osr_bad_replay");
  assert.equal(err(osr({ lz: Buffer.from("garbage that is no lzma stream at all") })), "osr_too_big"); // (its "size" field is huge)
  const c = find("10k mix");
  assert.equal(err(osr({ lz: c.lz.subarray(0, c.lz.length - 5) })), "osr_bad_replay"); // truncated LZMA
  assert.equal(err(osr({ lz: c.lz })), null); // (10k of random-ish bytes: no frames at all, but a valid file)
  // a life graph string: 100000 bytes is fine (nothing usable in it), 100001 is not
  assert.deepEqual(J(P.parseOsr(osr({ life: "x".repeat(100000) })).lifeBar), []);
  assert.equal(err(osr({ life: "x".repeat(100001) })), "osr_bad_string");
});

test("parseOsr: size caps (decompressed text 24 MB, 1,000,000 frames)", needPy, () => {
  const r = spawnSync("python3", ["-I", "-c", `
import sys, lzma, base64, json
a = lzma.compress(b"0|1|1|0," * 1000001, format=lzma.FORMAT_ALONE)   # one frame too many (8 MB of text)
b = lzma.compress(b"0|1|1|0," * 1000000, format=lzma.FORMAT_ALONE)   # exactly the cap
c = lzma.compress(bytes(25 * 1024 * 1024), format=lzma.FORMAT_ALONE) # 25 MB of text
d = lzma.compress(b"," * (24 * 1024 * 1024), format=lzma.FORMAT_ALONE) # 24 MB of empty entries: allowed, no frames
json.dump([base64.b64encode(x).decode() for x in (a, b, c, d)], sys.stdout)
`], { maxBuffer: 1 << 28 });
  assert.equal(r.status, 0);
  const [a, b, c, d] = JSON.parse(r.stdout.toString()).map(x => Buffer.from(x, "base64"));
  assert.equal(codeOf(() => P.parseOsr(osr({ lz: a }))), "osr_too_big");
  const ok = P.parseOsr(osr({ lz: b }));
  assert.equal(ok.frames.n, 1000000); assert.equal(ok.frames.t[999999], 0);
  assert.equal(codeOf(() => P.parseOsr(osr({ lz: c }))), "osr_too_big");
  assert.equal(P.parseOsr(osr({ lz: d })).frames.n, 0);
});

test("parseOsr: lazer block problems never throw (lazerInfo is null)", needPy, () => {
  const base = fx("lazer-small.osr");
  const start = blockStart(base);
  assert.ok(start > 0);
  const cut = (f) => P.parseOsr(f);
  assert.equal(cut(base.subarray(0, start)).lazerInfo, null); // no block at all
  assert.equal(cut(base.subarray(0, start + 4)).lazerInfo, null); // length but no data
  assert.equal(cut(base.subarray(0, base.length - 3)).lazerInfo, null); // block shorter than declared
  const bad = Buffer.from(base); bad[start + 10] ^= 0xff; bad[start + 20] ^= 0x55;
  assert.equal(cut(bad).lazerInfo, null);
  const neg = Buffer.from(base); neg.writeInt32LE(-5, start); assert.equal(cut(neg).lazerInfo, null);
  assert.equal(cut(neg).frames.n, 4);
  // JSON that is not an object
  const r = spawnSync("python3", ["-I", "-c", `
import sys, lzma, base64, json
print(json.dumps([base64.b64encode(lzma.compress(x, format=lzma.FORMAT_ALONE)).decode() for x in (b"[1,2]", b"null", b"not json", b'{"mods": 5, "statistics": [1], "rank": 3, "pauses": "x"}', b'{"__proto__": {"x": 1}, "statistics": {"__proto__": 5, "great": "7", "ok": 3}}')]))
`]);
  const [arr, nul, junk, weird, proto] = JSON.parse(r.stdout.toString()).map(x => Buffer.from(x, "base64"));
  const head = base.subarray(0, start);
  const withBlock = z => { const l = Buffer.alloc(4); l.writeInt32LE(z.length); return P.parseOsr(Buffer.concat([head, l, z])).lazerInfo; };
  assert.equal(withBlock(arr), null); assert.equal(withBlock(nul), null); assert.equal(withBlock(junk), null);
  const w = J(withBlock(weird));
  assert.deepEqual([w.mods, w.statistics, w.rank, w.pauses], [[], null, null, null]);
  const p = J(withBlock(proto));
  assert.deepEqual(p.statistics, { ok: 3 });
});

test("frames: osu!lazer's decoding rules", () => {
  const f = t => { const r = P.osrFrames(t); return J({ n: r.n, t: Array.from(r.t), x: Array.from(r.x), y: Array.from(r.y), k: Array.from(r.k), seed: r.seed, last: r.lastTime }); };
  // start frames dropped (time still counts), seed taken out, empty and short entries skipped
  let r = f("0|256|-500|0,-1|256|-500|0,10|1|2|1,,5|3|4,5|3|4|9,-12345|0|0|42,");
  assert.deepEqual(r, { n: 2, t: [9, 14], x: [1, 3], y: [2, 4], k: [1, 9], seed: 42, last: 14 });
  // (256,-500) is only skipped in the first two entries
  assert.deepEqual(f("1|0|0|0,1|0|0|0,1|256|-500|0").n, 3);
  // a delta that goes back keeps the time where it was (no going backwards), later frames carry on from the true sum
  r = f("100|1|1|0,-30|2|2|0,10|3|3|0,50|4|4|0");
  assert.deepEqual(r.t, [100, 100, 100, 130]);
  // non-finite numbers and empty fields: skipped
  r = f("1|NaN|2|0,1|3|Infinity|0,1||5|0,1|5||0,|5|5|0,1|7|7|0");
  assert.equal(r.n, 1); assert.deepEqual(r.x, [7]);
  assert.equal(f("1|1e300|2|0").n, 0); // (not representable in a float32)
  // key state keeps the low 5 bits, extra fields are ignored, text without frames
  assert.deepEqual(f("1|1|1|255|junk").k, [31]);
  assert.equal(f("").n, 0); assert.equal(f(",,,").n, 0); assert.equal(f("|||").n, 0);
  assert.deepEqual(f("0|1|1|0").t, [0]);
});

test("parseOsr: .NET ticks to ms, online id, life graph", () => {
  const tweak = (fn) => { const b = Buffer.from(fx("stable-small.osr")); fn(b); return b; };
  const find8 = (b) => { const t = 621355968000000000n + 1672531200000n * 10000n, k = Buffer.alloc(8); k.writeBigInt64LE(t); return b.indexOf(k); };
  const p = find8(fx("stable-small.osr")); assert.ok(p > 0);
  const setTicks = v => tweak(b => b.writeBigInt64LE(v, p));
  assert.equal(P.parseOsr(setTicks(0n)).date, null);
  assert.equal(P.parseOsr(setTicks(-5n)).date, null);
  assert.equal(P.parseOsr(setTicks(0x7fffffffffffffffn)).date, null);
  assert.equal(P.parseOsr(setTicks(621355968000000000n + 10000n)).date, 1);
  // online id: the last 8 bytes; 0 / -1 / over 2^53 are null
  const setId = v => tweak(b => b.writeBigInt64LE(v, b.length - 8));
  assert.equal(P.parseOsr(setId(0n)).onlineId, null); assert.equal(P.parseOsr(setId(-1n)).onlineId, null);
  assert.equal(P.parseOsr(setId(2n ** 53n)).onlineId, 2 ** 53); assert.equal(P.parseOsr(setId(2n ** 53n + 1n)).onlineId, null);
  assert.equal(P.parseOsr(setId(0x7fffffffffffffffn)).onlineId, null);
});

test("replayMods: lists, rate, flags, unsupported", () => {
  const m = (bits, li = null) => J(P.replayMods(bits, li));
  assert.deepEqual(m(0), { list: [], rate: 1, pitch: false, hr: false, ez: false, hd: false, fl: false, rx: false, ap: false, unsupported: [] });
  let r = m(24);
  assert.deepEqual([r.list, r.rate, r.hr, r.hd, r.unsupported], [["HR", "HD"], 1, true, true, []]);
  r = m(2 | 1 | 256 | 16 | 32 | 64 | 128 | 512 | 8 | 1024 | 2048 | 4096 | 8192 | 16384);
  assert.deepEqual(r.list, ["EZ", "NF", "HT", "HR", "RX", "NC", "HD", "FL", "AT", "SO", "AP", "PF"]);
  assert.equal(r.rate, 1.5, "DT/NC beats HT"); assert.deepEqual(r.unsupported, ["AT"]);
  // HD and FL are applied to the playback now (the sample replays patched to 8 / 1024 / 8|1024, and HD+HR = 24)
  r = m(8); assert.deepEqual([r.list, r.hd, r.fl, r.unsupported], [["HD"], true, false, []]);
  r = m(1024); assert.deepEqual([r.list, r.hd, r.fl, r.unsupported], [["FL"], false, true, []]);
  r = m(8 | 1024); assert.deepEqual([r.list, r.hd, r.fl, r.unsupported], [["HD", "FL"], true, true, []]);
  r = m(0, { mods: [{ acronym: "HD", settings: {} }, { acronym: "FL", settings: {} }] }); assert.deepEqual([r.list, r.hd, r.fl, r.unsupported], [["HD", "FL"], true, true, []]);
  assert.deepEqual(m(64).list, ["DT"]); assert.deepEqual(m(64 | 512).list, ["NC"]); assert.equal(m(64 | 512).rate, 1.5);
  assert.deepEqual(m(32).list, ["SD"]); assert.deepEqual(m(32 | 16384).list, ["PF"]);
  assert.deepEqual([m(256).rate, m(256).list], [0.75, ["HT"]]);
  assert.deepEqual([m(2).ez, m(2).hr, m(128).rx, m(8192).ap, m(1024).fl], [true, false, true, true, true]);
  assert.deepEqual(m(536870912).list, ["SV2"]); assert.deepEqual(m(536870912).unsupported, []); assert.deepEqual(m(4).list, ["TD"]); assert.deepEqual(m(4).unsupported, []);
  assert.deepEqual(m(4194304).unsupported, ["CN"]);
  // (signed 32-bit: the top bit is Mirror)
  assert.deepEqual(m(-1).list.includes("MR"), true);
  // lazer: mods bitmask 0 -> the acronyms of the JSON; speed_change picks the rate
  const lz = mods => ({ mods });
  r = m(0, lz([{ acronym: "DT", settings: { speed_change: 1.3 } }, { acronym: "CL", settings: {} }]));
  assert.deepEqual([r.list, r.rate, r.unsupported], [["DT", "CL"], 1.3, ["CL"]]);
  r = m(0, lz([{ acronym: "DC", settings: { speed_change: 0.6 } }, { acronym: "DA", settings: { circle_size: 7 } }]));
  assert.deepEqual([r.list, r.rate, r.unsupported], [["DC", "DA"], 0.6, ["DA"]]);
  r = m(256, lz([{ acronym: "DC", settings: {} }]));
  assert.deepEqual([r.list, r.rate], [["DC"], 0.75]);
  r = m(64 | 512, lz([{ acronym: "NC", settings: { speed_change: 1.25 } }]));
  assert.deepEqual([r.list, r.rate], [["NC"], 1.25]);
  assert.equal(m(64, lz([{ acronym: "DT", settings: { speed_change: "fast" } }])).rate, 1.5); // (not a number: ignored)
  assert.equal(m(64, lz([{ acronym: "DT", settings: { speed_change: 1e9 } }])).rate, 1.5); // (absurd: ignored)
  assert.equal(m(0, lz([{ acronym: "HR", settings: { speed_change: 2 } }])).rate, 1); // (only the speed mods)
  assert.deepEqual(m(0, { mods: [] }).list, []); assert.deepEqual(m(0, { mods: null }).list, []);
});

test("replayMods: pitch follows the speed for NC / DC (and lazer adjust_pitch), kept for DT / HT", () => {
  const m = (bits, li = null) => J(P.replayMods(bits, li)), lz = mods => ({ mods });
  // stable bits
  assert.deepEqual([m(0).pitch, m(8 | 16).pitch], [false, false]);
  assert.deepEqual([m(64).pitch, m(64).rate], [false, 1.5], "DT keeps the pitch");
  assert.deepEqual([m(64 | 512).pitch, m(64 | 512).rate], [true, 1.5], "NC follows the speed");
  assert.deepEqual([m(256).pitch, m(256).rate], [false, 0.75], "HT keeps the pitch");
  assert.equal(m(64 | 512 | 256).pitch, true, "NC beats HT (the rate is NC's)");
  assert.equal(m(64 | 256).pitch, false);
  assert.equal(m(64 | 8 | 16).pitch, false, "other mods change nothing");
  // lazer JSON (mods bitmask 0, or with the stable bits a lazer replay also writes)
  assert.equal(m(0, lz([{ acronym: "DT", settings: {} }])).pitch, false);
  assert.equal(m(0, lz([{ acronym: "DT", settings: { speed_change: 1.3 } }])).pitch, false);
  assert.deepEqual([m(0, lz([{ acronym: "DT", settings: { speed_change: 1.3, adjust_pitch: true } }])).pitch, m(0, lz([{ acronym: "DT", settings: { speed_change: 1.3, adjust_pitch: true } }])).rate], [true, 1.3]);
  assert.equal(m(64, lz([{ acronym: "DT", settings: { adjust_pitch: false } }])).pitch, false);
  assert.equal(m(64, lz([{ acronym: "DT", settings: { adjust_pitch: "yes" } }])).pitch, false, "(not a boolean: the default)");
  assert.equal(m(0, lz([{ acronym: "HT", settings: { adjust_pitch: true } }])).pitch, true);
  assert.equal(m(256, lz([{ acronym: "HT", settings: { speed_change: 0.6 } }])).pitch, false);
  assert.equal(m(0, lz([{ acronym: "NC", settings: { speed_change: 1.25 } }])).pitch, true);
  assert.equal(m(0, lz([{ acronym: "NC", settings: { adjust_pitch: false } }])).pitch, true, "NC always follows the speed");
  assert.deepEqual([m(0, lz([{ acronym: "DC", settings: {} }])).pitch, m(0, lz([{ acronym: "DC", settings: {} }])).rate], [true, 0.75]);
  assert.equal(m(256, lz([{ acronym: "DC", settings: { speed_change: 0.6 } }])).pitch, true);
  assert.equal(m(0, lz([{ acronym: "WU", settings: {} }])).pitch, true, "lazer default for Wind Up");
  assert.equal(m(0, lz([{ acronym: "AS", settings: { adjust_pitch: false } }])).pitch, false);
  assert.equal(m(0, lz([{ acronym: "HD", settings: { adjust_pitch: true } }])).pitch, false, "(only the speed mods)");
  assert.equal(m(0, lz([null, { acronym: "DT", settings: null }])).pitch, false);
});

test("replayDiff: EZ halves, HR scales with caps, the rate changes nothing", () => {
  const d = { CircleSize: 4, ApproachRate: 9, OverallDifficulty: 8, HPDrainRate: 6 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  let r = J(P.replayDiff(d, P.replayMods(0, null)));
  assert.deepEqual(r, { cs: 4, ar: 9, od: 8, hp: 6 });
  r = J(P.replayDiff(d, P.replayMods(16, null)));
  near(r.cs, 5.2); assert.equal(r.ar, 10); assert.equal(r.od, 10); near(r.hp, 8.4);
  r = J(P.replayDiff(d, P.replayMods(2, null)));
  assert.deepEqual(r, { cs: 2, ar: 4.5, od: 4, hp: 3 });
  r = J(P.replayDiff({ CircleSize: 9, ApproachRate: 2, OverallDifficulty: 5, HPDrainRate: 5 }, P.replayMods(16, null)));
  assert.equal(r.cs, 10); near(r.ar, 2.8); near(r.od, 7);
  assert.deepEqual(J(P.replayDiff(d, P.replayMods(64 | 8, null))), { cs: 4, ar: 9, od: 8, hp: 6 });
});

test("replayAccuracy", () => {
  assert.equal(P.replayAccuracy({ n300: 0, n100: 0, n50: 0, miss: 0 }), 1);
  assert.equal(P.replayAccuracy({ n300: 10, n100: 0, n50: 0, miss: 0 }), 1);
  assert.equal(P.replayAccuracy({ n300: 0, n100: 0, n50: 0, miss: 5 }), 0);
  assert.equal(P.replayAccuracy({ n300: 1, n100: 1, n50: 1, miss: 1 }), 450 / 1200);
  assert.ok(Math.abs(P.replayAccuracy({ n300: 1982, n100: 1, n50: 0, miss: 0 }) - (300 * 1982 + 100) / (300 * 1983)) < 1e-12);
});

test("replayRank: stable's rules, silver with HD / FL", () => {
  const rk = (c, m = 0) => P.replayRank({ n300: 0, n100: 0, n50: 0, miss: 0, ...c }, P.replayMods(m, null));
  assert.equal(rk({}), "D");
  assert.equal(rk({ n300: 100 }), "X"); assert.equal(rk({ n300: 100 }, 8), "XH"); assert.equal(rk({ n300: 100 }, 1024), "XH"); assert.equal(rk({ n300: 100 }, 16), "X");
  assert.equal(rk({ n300: 95, n100: 5 }), "S"); assert.equal(rk({ n300: 95, n100: 5 }, 8), "SH");
  assert.equal(rk({ n300: 99, n50: 1 }), "S"); assert.equal(rk({ n300: 98, n50: 2 }), "A"); // 2% 50s: not S
  assert.equal(rk({ n300: 95, n100: 4, miss: 1 }), "A"); assert.equal(rk({ n300: 95, n100: 4, miss: 1 }, 1024), "A"); // (miss: no S, 95% 300s: A)
  assert.equal(rk({ n300: 85, n100: 15 }), "A"); assert.equal(rk({ n300: 85, n100: 14, miss: 1 }), "B");
  assert.equal(rk({ n300: 75, n100: 25 }), "B"); assert.equal(rk({ n300: 75, n100: 24, miss: 1 }), "C");
  assert.equal(rk({ n300: 85, n100: 15 }, 8), "A"); // (only X and S get the silver variant)
  assert.equal(rk({ n300: 65, n100: 35 }), "C"); assert.equal(rk({ n300: 60, n100: 40 }), "D"); assert.equal(rk({ miss: 4 }), "D");
  assert.equal(rk({ n300: 90, n100: 10 }), "A"); // (exactly 90% is not above 90%)
  assert.equal(P.replayRank({ n300: 3, n100: 0, n50: 0, miss: 0 }, null), "X"); // (no mods info)
});

// ---- a real replay, only when one is pointed at (third-party data, not in the repo) ----
const SAMPLE = process.env.OBV_OSR_SAMPLE;
test("a real stable replay (OBV_OSR_SAMPLE=/path/to/std-replay.osr, optional)", { skip: SAMPLE && existsSync(SAMPLE) ? false : "OBV_OSR_SAMPLE not set" }, () => {
  const b = readFileSync(SAMPLE), d = P.parseOsr(b);
  assert.equal(d.mode, 0); assert.equal(d.mapMd5.length, 32); assert.ok(d.frames.n > 1000);
  for (let i = 1; i < d.frames.n; i++) assert.ok(d.frames.t[i] >= d.frames.t[i - 1]);
});
