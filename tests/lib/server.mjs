// The API for the tests: Vercel-style (api/v1.js called directly), or through the Cloudflare Worker entry (worker.js)
// with OBV_VIA_WORKER=1. OBV_R2=1 adds an R2 bucket stand-in (project files), OBV_D1=1 a D1 stand-in (the database,
// with R2): the same tests then run against the Cloudflare setup. With D1, emu.db (the tests' SQL) points at it.
import http from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fakeR2 } from "../emu/r2-fake.mjs";
import { fakeD1 } from "../emu/d1-fake.mjs";

export async function startApi(root, emu) {
  const require = createRequire(import.meta.url);
  const d1 = process.env.OBV_D1 ? fakeD1(root) : null, r2 = process.env.OBV_R2 || d1 ? fakeR2() : null;
  const v1 = require(join(root, "api/v1.js")), cron = require(join(root, "api/cron.js"));
  const worker = process.env.OBV_VIA_WORKER || r2 ? (await import(join(root, "worker.js"))).default : null;
  if (d1 && emu) emu.db = d1.pg;
  const db = require(join(root, "api/_lib/db.js")); // (handlers the tests call directly, outside the Worker, use them too)
  if (r2) db.useR2(r2); if (d1) db.useD1(d1);
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (worker) {
      const chunks = []; for await (const ch of req) chunks.push(ch);
      const raw = Buffer.concat(chunks), waits = [];
      const env = { ...process.env, ASSETS: { fetch: () => new Response("") }, ...(r2 ? { FILES: r2 } : {}), ...(d1 ? { DB: d1, DB_BACKEND: "d1" } : {}) };
      const r = await worker.fetch(new Request("http://" + req.headers.host + req.url, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : raw }), env, { waitUntil: p => waits.push(p) });
      await Promise.all(waits);
      res.statusCode = r.status; r.headers.forEach((v, k) => { if (k !== "set-cookie") res.setHeader(k, v); });
      const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (cookies.length) res.setHeader("set-cookie", cookies); return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (u.pathname === "/api/cron") return cron(req, res);
    if (!u.searchParams.has("route")) { u.searchParams.set("route", u.pathname.replace(/^\/api\/v1\/?/, "")); req.url = u.pathname + "?" + u.searchParams; }
    v1(req, res);
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base, r2, d1, stored: () => r2 ? [...r2.m.keys()] : [...emu.blobs.keys()], abs: url => url && url.startsWith("/") ? base + url : url };
}
