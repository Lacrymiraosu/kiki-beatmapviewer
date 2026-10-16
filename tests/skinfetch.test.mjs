// A skin from a direct link, passed through the Worker (api/_lib/skinfetch.js, worker.js /dl/skin?u=): not an open proxy. Every address, redirect hop, size and body is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const S = createRequire(import.meta.url)("../api/_lib/skinfetch.js");
const ok = u => assert.ok(S.checkUrl(u, ["me.example.workers.dev"]), "should be allowed: " + u), no = u => assert.equal(S.checkUrl(u, ["me.example.workers.dev"]), null, "should be refused: " + u);
const zip = (n = 8, extra = {}) => new Response(new Uint8Array(n).fill(7).map((v, i) => i === 0 ? 0x50 : i === 1 ? 0x4b : v), { status: 200, headers: { "content-length": String(n), ...extra } });
const redirect = loc => new Response(null, { status: 302, headers: { location: loc } });
const bytes = async b => { const out = []; const rd = b.getReader(); for (;;) { const c = await rd.read(); if (c.done) break; out.push(...c.value); } return out; };

test("the addresses that may be fetched: https, a public DNS name, port 443, no credentials", () => {
  ok("https://tetsui.s-ul.eu/t3yyAk3g2QugMs9O"); ok("https://files.catbox.moe/abc.osk"); ok("https://cdn.discordapp.com/attachments/1/2/skin.osk?ex=1&hm=2"); ok("https://example-host.co.uk:443/a.zip"); ok("https://xn--bcher-kva.example.de/a.osk");
});
test("everything else is refused: other schemes, IPs (any spelling), internal names, other ports, credentials, this site, long addresses", () => {
  for (const u of ["http://a.example.com/x.osk", "ftp://a.example.com/x", "file:///etc/passwd", "javascript:alert(1)", "https://127.0.0.1/x", "https://10.0.0.1/x", "https://192.168.1.2/x", "https://169.254.169.254/latest", "https://2130706433/x", "https://0x7f.1/x", "https://017700000001/x",
    "https://[::1]/x", "https://[fe80::1]/x", "https://localhost/x", "https://localhost./x", "https://printer.local/x", "https://db.internal/x", "https://router.lan/x", "https://intranet/x", "https://nodots/x",
    "https://a.example.com:8443/x", "https://user:pw@a.example.com/x", "https://me.example.workers.dev/dl/skin?u=x", "https://osu-beatmap-viewer.acct.workers.dev/dl/yugen.osk", "https://branch-x-osu-beatmap-viewer.acct.workers.dev/", "https://" + "a".repeat(990) + ".com/x", "", "not a url", "https://"]) no(u);
  assert.equal(S.checkUrl(undefined, []), null); assert.equal(S.checkUrl(42, []), null);
});
test("a zip is passed through whole, with its length", async () => {
  const r = await S.fetchSkin("https://a.example.com/s.osk", [], async () => zip(20));
  assert.equal(r.ok, true); assert.equal(r.length, 20); const b = await bytes(r.body); assert.equal(b.length, 20); assert.deepEqual(b.slice(0, 2), [0x50, 0x4b]);
});
test("the request is clean: GET, our own User-Agent, no cookies / referer / credentials, redirects handled here", async () => {
  let init; await S.fetchSkin("https://a.example.com/s.osk", [], async (u, i) => { init = i; return zip(); });
  assert.equal(init.method, "GET"); assert.equal(init.redirect, "manual"); assert.match(init.headers["User-Agent"], /KIKI/); assert.ok(!Object.keys(init.headers).some(k => /cookie|referer|authorization/i.test(k)));
});
test("a redirect is followed (up to 4 hops) and every hop is checked again", async () => {
  const seen = []; const chain = { "https://a.example.com/1": "https://b.example.com/2", "https://b.example.com/2": "/3", "https://b.example.com/3": "https://c.example.net/4" };
  const r = await S.fetchSkin("https://a.example.com/1", [], async u => { seen.push(u); return chain[u] ? redirect(chain[u]) : zip(); });
  assert.equal(r.ok, true); assert.deepEqual(seen, ["https://a.example.com/1", "https://b.example.com/2", "https://b.example.com/3", "https://c.example.net/4"]);
  for (const loc of ["http://a.example.com/x", "https://127.0.0.1/x", "https://169.254.169.254/", "https://me.example.workers.dev/dl/skin?u=https://a.example.com/x", "https://localhost/x", "file:///etc/passwd"]) {
    const bad = await S.fetchSkin("https://a.example.com/1", ["me.example.workers.dev"], async () => redirect(loc)); assert.deepEqual([bad.ok, bad.status, bad.error], [false, 400, "bad_redirect"], loc);
  }
  let n = 0; const loop = await S.fetchSkin("https://a.example.com/1", [], async () => { n++; return redirect("https://a.example.com/1"); });
  assert.deepEqual([loop.ok, loop.error], [false, "too_many_redirects"]); assert.equal(n, 5, "the first fetch and 4 hops");
});
test("a page (not a zip) is refused before any 200; so are errors, a wrong address and an unreachable host", async () => {
  const html = await S.fetchSkin("https://a.example.com/s", [], async () => new Response("<html>login</html>", { status: 200 })); assert.deepEqual([html.ok, html.status, html.error], [false, 415, "not_a_zip"]);
  const empty = await S.fetchSkin("https://a.example.com/s", [], async () => new Response(new Uint8Array(0), { status: 200 })); assert.equal(empty.error, "not_a_zip");
  const one = await S.fetchSkin("https://a.example.com/s", [], async () => new Response(new Uint8Array([0x50]), { status: 200 })); assert.equal(one.error, "not_a_zip");
  const nf = await S.fetchSkin("https://a.example.com/s", [], async () => new Response("no", { status: 404 })); assert.deepEqual([nf.ok, nf.status, nf.error], [false, 502, "upstream_404"]);
  assert.equal((await S.fetchSkin("http://a.example.com/s", [], async () => zip())).error, "bad_url");
  assert.equal((await S.fetchSkin("https://a.example.com/s", [], async () => { throw new TypeError("net"); })).error, "unreachable");
});
test("a zip whose signature arrives in two small chunks is accepted", async () => {
  const mk = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0x50])); c.enqueue(new Uint8Array([0x4b, 3, 4])); c.close(); } }), { status: 200 });
  const r = await S.fetchSkin("https://a.example.com/s", [], async () => mk()); assert.equal(r.ok, true); assert.deepEqual(await bytes(r.body), [0x50, 0x4b, 3, 4]);
});
test("the size cap: a content-length over it is refused; a body that grows past it errors mid-stream", async () => {
  const big = await S.fetchSkin("https://a.example.com/s", [], async () => new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { "content-length": String(S.MAX + 1) } })); assert.deepEqual([big.ok, big.status, big.error], [false, 413, "too_big"]);
  const chunk = new Uint8Array(1024 * 1024); chunk[0] = 0x50; chunk[1] = 0x4b; let sent = 0;
  const liar = () => new Response(new ReadableStream({ pull(c) { if (sent > 70) return c.close(); sent++; c.enqueue(chunk); } }), { status: 200 });
  const r = await S.fetchSkin("https://a.example.com/s", [], async () => liar()); assert.equal(r.ok, true);
  await assert.rejects((async () => { const rd = r.body.getReader(); for (;;) { const c = await rd.read(); if (c.done) return; } })(), /too_big/);
});
test("the rate limit: 10 in 10 minutes per address, then free again; addresses do not share", () => {
  const ip = "203.0.113.9", t0 = 1e9; let hit = 0;
  for (let i = 0; i < 10; i++) if (S.limited(ip, t0 + i)) hit++; assert.equal(hit, 0);
  assert.equal(S.limited(ip, t0 + 100), true); assert.equal(S.limited("203.0.113.10", t0 + 100), false);
  assert.equal(S.limited(ip, t0 + 600001 + 9), false, "the window passed");
});
