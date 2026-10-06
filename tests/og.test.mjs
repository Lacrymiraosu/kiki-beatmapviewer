// Link-preview cards (api/og.js) and what they may cost: osu! requests come out of a cache and a budget, are counted
// per IP, and anything over the limit gets the plain page (200, no card), never an error. The osu!api stand-in
// (tests/emu/osu-mock.mjs) records every request it gets in `calls`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startOsuMock, calls } from "./emu/osu-mock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let osuSrv, og, v1, osu;

before(async () => {
  osuSrv = await startOsuMock(54332);
  for (const k of ["SUPABASE_URL", "SUPABASE_SECRET_KEY"]) delete process.env[k]; // (no database: only the osu! cards)
  Object.assign(process.env, { OSU_CLIENT_ID: "1", OSU_CLIENT_SECRET: "test-only-secret", OSU_API_BASE: "http://127.0.0.1:54332" });
  og = require(join(root, "api/og.js")); v1 = require(join(root, "api/v1.js")); osu = require(join(root, "api/_lib/osu.js"));
  og.useTemplate(readFileSync(join(root, "index.html"), "utf8"));
});
after(() => osuSrv.close());

const fakeRes = out => ({ statusCode: 0, setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, getHeader: k => out.headers[k.toLowerCase()], end: b => { out.body = b; } });
async function page(path, ip = "10.0.0.1") {
  const out = { headers: {} }, res = fakeRes(out);
  await og({ url: path, headers: { host: "preview.example", "x-real-ip": ip } }, res);
  out.status = res.statusCode;
  out.title = (out.body.match(/<title>([^<]*)<\/title>/) || [])[1];
  out.ogTitle = (out.body.match(/<meta property="og:title" content="([^"]*)">/) || [])[1];
  return out;
}
async function api(route, ip = "10.0.0.1") {
  const out = { headers: {} }, res = fakeRes(out);
  await v1({ method: "GET", url: "/api/v1/" + route, headers: { host: "preview.example", "x-real-ip": ip } }, res);
  return { status: res.statusCode, headers: out.headers, body: JSON.parse(out.body) };
}
const osuCalls = () => calls.filter(c => c.startsWith("/api/v2/")).length;
const HOME = "KIKI BEATMAP VIEWER"; // (the page title without a card)
const fill = () => { const b = osu._buckets; b.main.t = osu.BUDGET.burst; b.og.t = osu.BUDGET.ogBurst; b.main.at = b.og.at = Date.now(); };

test("a map's card: the same id again comes from the cache, not osu!", async () => {
  fill(); const n = osuCalls();
  const a = await page("/?s=1001");
  assert.equal(a.status, 200); assert.match(a.title, /^Artist 1 - Song 1 · KIKI/); assert.match(a.ogTitle, /Artist 1 - Song 1/);
  assert.equal(osuCalls(), n + 1);
  for (let i = 0; i < 5; i++) assert.match((await page("/?s=1001&t=" + (i + 1) * 1000, "10.0.0." + (i + 2))).title, /^Artist 1 - Song 1/);
  assert.equal(osuCalls(), n + 1, "served from the cache");
  const d = await page("/?b=10012"); // a difficulty: which set (one request), the set itself is cached already
  assert.match(d.title, /\[Insane\]/); assert.equal(osuCalls(), n + 2);
  await page("/?b=10012"); await page("/?u=TestMapper"); await page("/?u=testmapper");
  assert.equal(osuCalls(), n + 3, "a mapper once too, whatever the case");
  await page("/?s=999999"); await page("/?s=999999");
  assert.equal(osuCalls(), n + 4, "a miss is kept for a while too");
});

test("ids that can't be one ask nobody", async () => {
  fill(); const n = calls.length;
  for (const q of ["s=abc", "s=12345678901", "s=-1", "b=1e5", "b=0x10", "u=" + encodeURIComponent("../../x"), "u=" + "a".repeat(40), "s=1%20OR%201"]) {
    const p = await page("/?" + q);
    assert.equal(p.status, 200, q); assert.equal(p.title, HOME, q);
  }
  assert.equal(calls.length, n);
});

test("over the per-IP limit the page is still there (200), just without the card", async () => {
  const B = osu.BUDGET, saved = { ...B };
  Object.assign(B, { perMin: 1e6, burst: 1e6, ogPerMin: 1e6, ogBurst: 1e6, ogReserve: 0 }); fill(); // (budget out of the way: only the per-IP limit)
  try {
    const ip = "10.7.7.7", n = osuCalls();
    for (let i = 0; i < 20; i++) assert.equal((await page("/?s=" + (500000 + i), ip)).status, 200);
    assert.equal(osuCalls(), n + 20);
    const p = await page("/?s=1003", ip);
    assert.equal(p.status, 200); assert.equal(p.title, HOME); assert.ok(!/Song 3/.test(p.body), "no card");
    assert.equal(osuCalls(), n + 20, "osu! wasn't asked");
    assert.match((await page("/?s=1001", ip)).title, /^Artist 1 - Song 1/, "a card already cached still shows");
    assert.match((await page("/?s=1003", "10.7.7.8")).title, /^Artist 3 - Song 3/, "other people still get theirs");
  } finally { Object.assign(B, saved); fill(); }
});

test("osu! budget: cards go without first, then the site's own requests get 429 + Retry-After", async () => {
  const b = osu._buckets; fill();
  let n = osuCalls();
  b.main.t = osu.BUDGET.ogReserve; // only the reserve left: cards don't touch it
  const p = await page("/?s=1002", "10.8.0.1");
  assert.equal(p.status, 200); assert.equal(p.title, HOME); assert.equal(osuCalls(), n);
  const s = await api("osu/set?id=1002", "10.8.0.1");
  assert.equal(s.status, 200); assert.equal(s.body.set.id, 1002); assert.equal(osuCalls(), n + 1, "the page's own request still goes through");
  fill(); b.og.t = 0; // cards' own bucket empty, the main one full
  assert.equal((await page("/?s=2001", "10.8.0.2")).title, HOME); assert.equal(osuCalls(), n + 1);
  b.main.t = 0; n = osuCalls(); // nothing left at all
  const busy = await api("osu/set?id=4001", "10.8.0.3");
  assert.equal(busy.status, 429); assert.equal(busy.body.error, "osu_busy"); assert.ok(+busy.headers["retry-after"] >= 1);
  assert.equal(osuCalls(), n, "osu! wasn't asked");
  assert.equal((await api("osu/set?id=1001", "10.8.0.3")).status, 200, "what's cached still answers");
  fill();
  assert.equal((await api("osu/set?id=4001", "10.8.0.3")).status, 200);
});

test("v1 osu! routes: 40 a minute per IP", async () => {
  fill();
  for (let i = 0; i < 40; i++) assert.equal((await api("osu/set?id=1001", "10.9.0.1")).status, 200, "request " + (i + 1));
  const r = await api("osu/set?id=1001", "10.9.0.1");
  assert.equal(r.status, 429); assert.equal(r.headers["retry-after"], "60");
  assert.equal((await api("osu/set?id=1001", "10.9.0.2")).status, 200);
});
