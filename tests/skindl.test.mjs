// The skin-from-a-link route of the Worker (worker.js /dl/skin?u=; the checks themselves are in skinfetch.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

const worker = (await import("../worker.js")).default;
const withFetch = async (impl, fn) => { const o = globalThis.fetch, calls = []; globalThis.fetch = async (u, init) => { calls.push([String(u), init]); return impl(u, init); }; try { return await fn(calls); } finally { globalThis.fetch = o; } };
const zip = () => new Response(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]), { status: 200, headers: { "content-length": "8", "content-type": "application/zip" } });
const get = (path, init, host = "osu-beatmap-viewer.example.workers.dev") => worker.fetch(new Request("https://" + host + path, init), {}, { waitUntil() {} });

test("/dl/skin passes a link's zip through with no cache, refuses a bad link, a page and other methods; the rate limit answers 429", async () => {
  const pk = () => new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 200, headers: { "content-length": "4" } });
  await withFetch(pk, async calls => {
    const r = await get("/dl/skin?u=" + encodeURIComponent("https://files.example.com/skin.osk"), { headers: { "cf-connecting-ip": "198.51.100.1" } });
    assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/zip"); assert.equal(r.headers.get("cache-control"), "no-store"); assert.equal(r.headers.get("content-length"), "4");
    assert.equal(calls.length, 1); assert.equal(calls[0][0], "https://files.example.com/skin.osk");
    const bad = await get("/dl/skin?u=" + encodeURIComponent("http://127.0.0.1/x"), { headers: { "cf-connecting-ip": "198.51.100.2" } }); assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "bad_url"); assert.equal(calls.length, 1, "nothing fetched");
    assert.equal((await get("/dl/skin", { headers: { "cf-connecting-ip": "198.51.100.3" } })).status, 400);
    assert.equal((await get("/dl/skin?u=x", { method: "POST", body: "x" })).status, 405);
    const self = await get("/dl/skin?u=" + encodeURIComponent("https://osu-beatmap-viewer.example.workers.dev/dl/skin"), { headers: { "cf-connecting-ip": "198.51.100.4" } }); assert.equal(self.status, 400);
  });
  await withFetch(() => new Response("<html></html>", { status: 200 }), async () => { const r = await get("/dl/skin?u=" + encodeURIComponent("https://files.example.com/page"), { headers: { "cf-connecting-ip": "198.51.100.5" } }); assert.equal(r.status, 415); assert.equal((await r.json()).error, "not_a_zip"); });
  await withFetch(pk, async () => { let last; for (let i = 0; i < 12; i++) last = await get("/dl/skin?u=" + encodeURIComponent("https://files.example.com/s" + i), { headers: { "cf-connecting-ip": "198.51.100.77" } }); assert.equal(last.status, 429); assert.equal(last.headers.get("retry-after"), "600"); });
});
