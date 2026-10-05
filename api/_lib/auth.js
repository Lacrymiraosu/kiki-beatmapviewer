// Shared helpers for the osu! OAuth functions (Vercel Node.js runtime).
// Env: OSU_CLIENT_SECRET and OSU_CLIENT_ID (both required), OSU_REDIRECT_URI (optional, defaults to <host>/api/auth/callback)
// Sessions are stateless: a cookie with { id, username, avatar } signed with HMAC-SHA256. No database, the osu! token isn't kept.
const crypto = require("crypto");

function cfg(req) {
  // (trimmed: a space or line break pasted along with a dashboard secret makes osu! refuse it as a wrong key)
  const env = k => String(process.env[k] || "").trim();
  const secret = env("OSU_CLIENT_SECRET");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return {
    id: env("OSU_CLIENT_ID"),
    secret,
    redirect: env("OSU_REDIRECT_URI") || `https://${host}/api/auth/callback`,
    key: crypto.createHash("sha256").update("obv-session:" + secret).digest(),
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
  const want = crypto.createHmac("sha256", c.key).update(body).digest(), got = unb64u(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { const o = JSON.parse(unb64u(body).toString("utf8")); return o && o.exp > Date.now() ? o : null; } catch { return null; }
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
const query = req => new URL(req.url, "http://x").searchParams;
function safeNext(n) { // only same-site paths
  n = String(n || "/");
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") && n.length < 1000 ? n : "/";
}
function redirect(res, url, setCookies) {
  if (setCookies) res.setHeader("Set-Cookie", setCookies);
  res.statusCode = 302; res.setHeader("Location", url); res.setHeader("Cache-Control", "no-store"); res.end();
}
function json(res, code, obj) {
  res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
const withParam = (path, k, v) => path + (path.includes("?") ? "&" : "?") + k + "=" + encodeURIComponent(v);
module.exports = { cfg, sign, unsign, cookies, cookie, query, safeNext, redirect, json, withParam };
