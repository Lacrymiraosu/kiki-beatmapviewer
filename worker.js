// Cloudflare Workers entry (wrangler.jsonc). The same API functions as on Vercel (api/**), run through a small
// adapter: a Fetch Request becomes the { method, url, headers, body } the handlers read, and what they write with
// res.statusCode / setHeader / end becomes the Response. Static files (index.html, js/, assets/…) are served by Workers
// static assets without running this code, except "/" (shared links get their preview card from api/og.js) and /api/*.
// Their headers come from _headers; responses made here get the same site-wide headers (from vercel.json).
import v1 from "./api/v1.js";
import og from "./api/og.js";
import login from "./api/auth/login.js";
import callback from "./api/auth/callback.js";
import logout from "./api/auth/logout.js";
import me from "./api/auth/me.js";
import verify from "./api/auth/verify.js";
import google from "./api/auth/google.js";
import cron from "./api/cron.js";
import { runCleanup } from "./api/_lib/cleanup.js";
import db from "./api/_lib/db.js";
import rate from "./api/_lib/rate.js";
import preview from "./api/_lib/preview.js";
import vercel from "./vercel.json" with { type: "json" };

const SITE_HEADERS = (vercel.routes.find(r => r.src === "/(.*)" && r.headers) || {}).headers || {};
const AUTH = { login, callback, logout, me, verify, google };
const SHARE_KEYS = ["s", "b", "u", "live", "collab", "project", "invite"];

// secrets and vars → process.env, where the handlers read them; the R2 bucket (binding FILES) → db.js
function useEnv(env) {
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") process.env[k] = v;
  db.useR2(env.FILES);
  // the database: D1 (binding DB) once DB_BACKEND=d1 is set, else Supabase. D1 needs the files on R2 (it can't see
  // Supabase Storage), so without the FILES binding it stays on Supabase.
  db.useD1(env.DB_BACKEND === "d1" && env.DB && env.FILES ? env.DB : null, env.DB);
}
// ---------- project files on R2: uploads and downloads stream through here with the links db.js signs ----------
const FILE_RATE = { up: 120, down: 600 }, fileOver = rate.limiter(); // per IP per minute (per Worker instance, best effort: api/_lib/rate.js)
function fileLimited(kind, ip) { return fileOver(kind + ":" + ip, FILE_RATE[kind]); }
async function files(request, url, ctx) {
  const q = url.searchParams, ip = request.headers.get("cf-connecting-ip") || "?";
  const err = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!db.r2on()) return err(404, "not_found");
  if (request.method === "PUT" && q.has("u")) {
    const o = db.readFileLink(q.get("u"), "u"); if (!o) return err(403, "expired");
    if (fileLimited("up", ip)) return err(429, "too_many_requests");
    const len = Number(request.headers.get("content-length"));
    if (!(len === o.s) || len > db.UPLOAD_MAX || !request.body) return err(400, "size_mismatch"); // exactly the size given when saving began
    // the link lives 2 hours: only while the file is still wanted (pending, its save open, the project active)
    const g = await db.rpc("obv_r2_put_guard", { p_key: o.k });
    if (!g || !g.ok) return err(g && g.reason === "not_pending" ? 409 : 410, g && g.reason === "not_pending" ? "already_uploaded" : "upload_closed");
    if (g.size !== o.s || !/^[0-9a-f]{64}$/.test(g.sha256 || "")) return err(409, "size_mismatch");
    // every accepted PUT is counted (one write, one check), refused above the month's limit
    try { await db.r2Use(1, 1); } catch (e) { if (e && e.code === "storage_limit") return err(503, "storage_limit"); throw e; }
    if (await db.R2.bucket.head(o.k)) return err(409, "already_uploaded"); // never overwrite (also refused by onlyIf below)
    let put;
    try { // R2 checks the bytes against the sha256 declared when saving began, and writes only if nothing is there yet
      put = await db.R2.bucket.put(o.k, request.body, { httpMetadata: { contentType: "application/octet-stream" }, sha256: g.sha256, onlyIf: { etagDoesNotMatch: "*" } });
    } catch (e) {
      if (/sha-?256|checksum|digest|10037/i.test(String(e && e.message))) return err(400, "hash_mismatch");
      throw e;
    }
    if (!put) return err(409, "already_uploaded"); // (the condition failed: someone else's write landed first)
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
  if ((request.method === "GET" || request.method === "HEAD") && q.has("d")) {
    const o = db.readFileLink(q.get("d"), "d"); if (!o) return err(403, "expired");
    if (db.R2.blockedB && Date.now() - db.R2.blockedB < 600000) return err(503, "storage_limit"); // this month's free reads are used up
    if (fileLimited("down", ip)) return err(429, "too_many_requests");
    ctx.waitUntil(db.r2Use(0, 1).catch(() => {})); // one Class B read; above the limit the following ones are refused
    const obj = await db.R2.bucket.get(o.k); if (!obj) return err(404, "not_found");
    return new Response(request.method === "HEAD" ? null : obj.body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(obj.size), "Cache-Control": "private, max-age=600", ETag: obj.httpEtag } });
  }
  return err(405, "method_not_allowed");
}
// run a Node-style handler (req, res) and collect what it writes
async function run(fn, request, url) {
  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  headers["x-real-ip"] = request.headers.get("cf-connecting-ip") || headers["x-real-ip"] || ""; // (Cloudflare always sets cf-connecting-ip; the fallback is for local tests)
  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  const req = { method: request.method, url: url.pathname + url.search, headers, body };
  const out = { status: 200, headers: new Headers(), body: null };
  const res = {
    get statusCode() { return out.status; }, set statusCode(v) { out.status = v; },
    setHeader(k, v) { out.headers.delete(k); for (const x of [].concat(v)) out.headers.append(k, String(x)); },
    getHeader(k) { return out.headers.get(k); },
    end(b) { out.body = b == null ? null : b; },
  };
  await fn(req, res);
  return new Response(out.body, { status: out.status, headers: out.headers });
}
function withSiteHeaders(resp) {
  const r = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(SITE_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  return r;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), p = url.pathname;
    // a Worker Preview (any workers.dev host but production's, or OBV_PREVIEW from wrangler.jsonc "previews"): no backend
    // unless PREVIEW_BACKEND=1. Decided before any env handling: a locked request runs no api/** code and leaves
    // process.env and db.js alone (shared by the whole instance, which may also serve production: a version's URL), so it
    // can't disturb other requests. See api/_lib/preview.js
    if (preview.isPreview(url.hostname, env) && !preview.backendAllowed(env)) {
      try {
        if (p.startsWith("/api/")) { const r = withSiteHeaders(new Response(JSON.stringify({ error: preview.ERROR }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })); r.headers.set("X-Robots-Tag", "noindex"); return r; }
        if (p === "/") { // the plain page (no api/og.js), never indexed
          const r = withSiteHeaders(new Response((await env.ASSETS.fetch(new Request(new URL("/index.html", url)))).body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } }));
          r.headers.set("X-Robots-Tag", "noindex"); return r;
        }
        return withSiteHeaders(await env.ASSETS.fetch(request)); // static files, as below
      } catch (e) { console.error("worker", p, e && e.message); return new Response("server error", { status: 500 }); }
    }
    useEnv(env);
    try {
      if (p === "/api/v1/files") return withSiteHeaders(await files(request, url, ctx));
      if (p === "/api/v1" || p.startsWith("/api/v1/")) return withSiteHeaders(await run(v1, request, url));
      const a = p.match(/^\/api\/auth\/(login|callback|logout|me|verify|google)$/);
      if (a) return withSiteHeaders(await run(AUTH[a[1]], request, url));
      if (p === "/api/cron") return withSiteHeaders(await run(cron, request, url));
      if (p.startsWith("/api/")) return withSiteHeaders(new Response('{"error":"not_found"}', { status: 404, headers: { "Content-Type": "application/json" } }));
      // a shared link: the page with its preview card (api/og.js reads index.html from the static files)
      if (p === "/" && SHARE_KEYS.some(k => url.searchParams.has(k))) {
        if (!og.hasTemplate()) og.useTemplate(await (await env.ASSETS.fetch(new Request(new URL("/index.html", url)))).text());
        return withSiteHeaders(await run(og, request, url));
      }
      // "/" without a share link, or anything else that reached the Worker: the static file
      return withSiteHeaders(await env.ASSETS.fetch(request));
    } catch (e) {
      console.error("worker", p, e && e.message);
      return withSiteHeaders(new Response('{"error":"server_error"}', { status: 500, headers: { "Content-Type": "application/json" } }));
    }
  },
  // the daily cleanup (Cron Trigger in wrangler.jsonc). The free plan allows 50 outgoing requests per run, so it takes
  // a few projects at a time; anything left is picked up the next day.
  async scheduled(event, env, ctx) {
    if (preview.isPreview("", env) && !preview.backendAllowed(env)) return; // (previews get no cron trigger; just in case)
    useEnv(env);
    ctx.waitUntil(runCleanup(25000, 8).catch(e => console.error("cron", e && e.code)));
  },
};
