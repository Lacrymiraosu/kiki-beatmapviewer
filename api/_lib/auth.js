// Shared helpers for the osu! OAuth functions (Vercel Node.js runtime).
// Env: OSU_CLIENT_SECRET and OSU_CLIENT_ID (both required), OSU_REDIRECT_URI (optional, defaults to
// <SITE_URL or the request's allowed host>/api/auth/callback; see siteUrl), SITE_URL and ALLOWED_HOSTS (optional)
// Sessions are stateless: a cookie with { id, username, avatar } signed with HMAC-SHA256. No database, the osu! token isn't kept.
require("./preview"); // (first: on a Vercel preview deployment it removes the secrets from process.env, see preview.js)
const crypto = require("crypto");

// (trimmed: a space or line break pasted along with a dashboard secret makes osu! refuse it as a wrong key)
const env = k => String(process.env[k] || "").trim();

// ---------- the site's own address, for URLs built from a request (OAuth redirect URIs, og:url / og:image) ----------
// Host and X-Forwarded-Host are sent by the client, so a request's host is only used when it's one this site is served
// on. SITE_URL always wins when it's set. Otherwise the host must be in ALLOWED_HOSTS (comma list, e.g.
// "viewer.example.com,www.viewer.example.com"), localhost / 127.0.0.1 (dev, tests), or a workers.dev / vercel.app
// deployment of this project (previews: "<x>-kiki-beatmap-viewer.<account>.workers.dev", "kiki-beatmap-viewer-<x>.vercel.app"; "osu-beatmap-viewer" too);
// anything else gets DEFAULT_SITE.
const DEFAULT_SITE = "https://osu-beatmap-viewer.lacrymira.workers.dev";
const DEPLOY_HOST = /^(?:[a-z0-9-]+-)?(?:kiki|osu)-beatmap-viewer(?:-[a-z0-9-]+)?\.(?:[a-z0-9-]+\.workers\.dev|vercel\.app)$/;
function hostOk(h) {
  if (!/^(?:[a-z0-9.-]{1,253}|\[[0-9a-f:]{2,39}\])(?::\d{1,5})?$/.test(h)) return false;
  const name = h.replace(/:\d+$/, "");
  if (name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === new URL(DEFAULT_SITE).hostname) return true;
  const allowed = env("ALLOWED_HOSTS").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
  return allowed.includes(h) || allowed.includes(name) || DEPLOY_HOST.test(name);
}
// On Cloudflare the Host header is what routed the request to this Worker, while X-Forwarded-Host is whatever the client
// sent: only Host counts there. On Vercel, its proxy sets X-Forwarded-Host to the host it served.
const ON_WORKERS = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
function requestHost(req) { // -> an allowed "host[:port]" (lower case), or null
  const h = req.headers || {};
  for (const x of ON_WORKERS ? [h.host] : [h["x-forwarded-host"], h.host]) { const v = String(x || "").trim().toLowerCase(); if (v && hostOk(v)) return v; }
  return null;
}
// "https://host" (no trailing slash). proto: "http" only for a request's own (allowed) host, e.g. og.js on localhost
function siteUrl(req, proto = "https") {
  const s = env("SITE_URL").replace(/\/+$/, "");
  if (/^https?:\/\/[^/\s]+$/i.test(s)) return s;
  const h = requestHost(req);
  return h ? (proto === "http" ? "http" : "https") + "://" + h : DEFAULT_SITE;
}

// ---------- signing keys ----------
// domain: "session" (the __Host-obv_s cookie, tickets and the short-lived login cookies), "files" (R2 links, db.js) or "live"
// (live-session TURN tokens, v1.js). Without SESSION_SECRET: derived from OSU_CLIENT_SECRET exactly as before (so
// nothing changes and existing cookies stay valid). With SESSION_SECRET (a `wrangler secret`, not shared with osu!):
// HMAC(SESSION_SECRET, "obv-<domain>"), one key per use. `old` is the OSU_CLIENT_SECRET key, still accepted for
// session cookies and tickets while SESSION_LEGACY_OK isn't "0" (the grace period after setting SESSION_SECRET; such a
// cookie is signed again with the new key on its next /api/v1/me). File links and live tokens just expire (≤ 3 h).
function keys(domain) {
  const ss = env("SESSION_SECRET"), osu = env("OSU_CLIENT_SECRET");
  const legacy = crypto.createHash("sha256").update((domain === "files" ? "obv-files:" : "obv-session:") + osu).digest(); // ("live" used the session key)
  if (!ss) return { key: legacy, old: null };
  return { key: crypto.createHmac("sha256", ss).update("obv-" + domain).digest(), old: osu && env("SESSION_LEGACY_OK") !== "0" ? legacy : null };
}
function cfg(req) {
  const secret = env("OSU_CLIENT_SECRET"), k = keys("session");
  return {
    id: env("OSU_CLIENT_ID"),
    secret,
    redirect: env("OSU_REDIRECT_URI") || siteUrl(req) + "/api/auth/callback",
    key: k.key,
    oldKey: k.old,
  };
}
const b64u = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
function sign(obj, c) {
  const body = b64u(JSON.stringify(obj));
  return body + "." + b64u(crypto.createHmac("sha256", c.key).update(body).digest());
}
function unsign(tok, c) {
  if (typeof tok !== "string" || tok.length > 4096) return null;
  const [body, sig] = tok.split(".");
  if (!body || !sig) return null;
  const got = unb64u(sig), ok = k => { const want = crypto.createHmac("sha256", k).update(body).digest(); return got.length === want.length && crypto.timingSafeEqual(got, want); };
  const legacy = !ok(c.key);
  if (legacy && !(c.oldKey && ok(c.oldKey))) return null;
  try {
    const o = JSON.parse(unb64u(body).toString("utf8")); if (!(o && o.exp > Date.now())) return null;
    if (legacy) Object.defineProperty(o, "legacyKey", { value: true }); // (not enumerable: never copied into a new token)
    return o;
  } catch { return null; }
}
// ---------- cookies ----------
// Every login cookie is written as "__Host-<name>" (obv_s: the session; obv_st / obv_alt: an osu! / Google login under
// way; obv_gm: a Google-only account waiting for the "move it into this osu! account?" answer). The browser only keeps
// a __Host- cookie that is Secure, Path=/ and without Domain, so another site under the same parent domain (another
// *.workers.dev Worker, a preview) can't set or overwrite one; a cookie it sets for the parent domain can't use the name.
// cookies(req) -> { <name>: value } by the short name: the __Host- one when it's there, else (LEGACY only: logins made
// before the rename keep working) the old name; out.legacy is the set of names read from an old name. A name sent twice
// keeps its first value (browsers send the cookie with the most specific path first; an extra one set later doesn't win).
// cookie(name, value, maxAge) -> the two Set-Cookie values to send: the __Host- cookie, and the old name cleared.
const HOST_PREFIX = "__Host-", LEGACY = new Set(["obv_s", "obv_st", "obv_alt", "obv_gl"]);
function cookies(req) {
  const raw = new Map(), out = Object.create(null), legacy = new Set();
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i <= 0) continue;
    const k = part.slice(0, i).trim(); if (raw.has(k)) continue;
    let v = part.slice(i + 1).trim(); try { v = decodeURIComponent(v); } catch {}
    raw.set(k, v);
  }
  for (const [k, v] of raw) if (k.startsWith(HOST_PREFIX) && k.length > HOST_PREFIX.length) out[k.slice(HOST_PREFIX.length)] = v;
  for (const k of LEGACY) if (!(k in out) && raw.has(k)) { out[k] = raw.get(k); legacy.add(k); }
  Object.defineProperty(out, "legacy", { value: legacy });
  return out;
}
const cookieLine = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
function cookie(name, value, maxAge) { return [cookieLine(HOST_PREFIX + name, value, maxAge), cookieLine(name, "", 0)]; }
const query = req => new URL(req.url, "http://x").searchParams;
// A return-to value (?next=, and what comes back in the login state cookies): a path on this site, or "/". Browsers drop
// tabs / line breaks from a Location and read "\" as "/", so "/\t/evil.com" or "/\evil.com" would mean //evil.com: any
// control character, space, DEL or "\" is refused outright. What's left is parsed against a placeholder origin and
// rebuilt (encoding normalized, non-ASCII percent-encoded); the result must still be one path starting with a single "/"
// ("/..//evil.com" normalizes to "//evil.com", which is refused).
const NEXT_BASE = "https://x.invalid", NEXT_MAX = 1000, NEXT_BAD = /[\x00-\x20\x7f\\]/;
function safeNext(n) {
  if (typeof n !== "string" || n.length > NEXT_MAX || NEXT_BAD.test(n) || n[0] !== "/" || n[1] === "/") return "/";
  let u; try { u = new URL(n, NEXT_BASE); } catch { return "/"; }
  if (u.origin !== NEXT_BASE) return "/";
  const out = u.pathname + u.search + u.hash;
  return out[0] === "/" && out[1] !== "/" && !NEXT_BAD.test(out) && out.length <= NEXT_MAX ? out : "/";
}
// 302 to an absolute http(s) URL (the OAuth providers) or a path on this site (always through safeNext); anything else,
// or a value with a control character (CR/LF would split the header), goes to "/" instead
function redirect(res, url, setCookies) {
  let to = typeof url === "string" ? url : "/";
  if (/[\x00-\x1f\x7f]/.test(to)) to = "/";
  else if (to[0] === "/") to = safeNext(to);
  else { try { if (!/^https?:$/.test(new URL(to).protocol)) to = "/"; } catch { to = "/"; } }
  if (setCookies) res.setHeader("Set-Cookie", setCookies);
  res.statusCode = 302; res.setHeader("Location", to); res.setHeader("Cache-Control", "no-store"); res.end();
}
function json(res, code, obj) {
  res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
// state-changing requests must come from this site (cookies are SameSite=Lax; this is a second check): no cross-site
// Sec-Fetch-Site, an Origin (when sent) on the same host, and a JSON body (a plain form or <img> can't send that type)
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin, host = req.headers["x-forwarded-host"] || req.headers.host;
  if (origin) { try { if (new URL(origin).host !== host) return false; } catch { return false; } }
  // the media type itself (before any ";" parameters), not a substring: "text/plain; x=application/json" is refused
  return String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() === "application/json";
}
// path (a safeNext value) + "?k=v" or "&k=v", before any "#fragment" so the page still sees it in location.search
const withParam = (path, k, v) => {
  const p = safeNext(path), i = p.indexOf("#"), head = i < 0 ? p : p.slice(0, i), hash = i < 0 ? "" : p.slice(i);
  return head + (head.includes("?") ? "&" : "?") + k + "=" + encodeURIComponent(v) + hash;
};
module.exports = { cfg, keys, sign, unsign, cookies, cookie, query, safeNext, redirect, json, withParam, sameOrigin, siteUrl, requestHost };
