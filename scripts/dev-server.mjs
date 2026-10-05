// Local development server: the static site plus the same API functions Vercel runs (api/**), with the same
// /api/v1/* rewrite as vercel.json. Reads environment variables from .env.local (never printed).
//   node scripts/dev-server.mjs [port]            -> http://localhost:5174
// Dev only: /api/dev/login?name=<name>&id=<id> signs you in with a fake session (needs OSU_CLIENT_SECRET set to any
// local value in .env.local). It exists only here, not on the deployed site.
import http from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const port = +(process.argv[2] || process.env.PORT || 5174);
const envFile = join(root, process.argv[3] || ".env.local"); // e.g. tests/emu/dev.env for the local stand-ins

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg", ".osu": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };

function apiFile(p) {
  if (p === "/api/v1" || p.startsWith("/api/v1/")) return { file: "api/v1.js", route: p.replace(/^\/api\/v1\/?/, "") };
  const m = p.match(/^\/api\/([\w/-]+)$/);
  if (m && !m[1].startsWith("_") && existsSync(join(root, "api", m[1] + ".js"))) return { file: "api/" + m[1] + ".js" };
  return null;
}
// the site-wide headers from vercel.json (CSP, framing...), so problems show up locally too; the CSP also allows the
// local stand-ins (http) that production never uses
const SITE_HEADERS = (() => {
  try {
    const all = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).routes || [], g = all.find(x => x.src === "/(.*)" && x.headers);
    const local = [process.env.SUPABASE_URL].filter(u => /^http:/.test(u || "")).map(u => new URL(u).origin).join(" ");
    return Object.entries(g ? g.headers : {}).map(([key, value]) => ({ key, value })).filter(x => x.key !== "Strict-Transport-Security").map(x => x.key === "Content-Security-Policy" && local
      ? { key: x.key, value: x.value.replace(/(connect-src|img-src|media-src) /g, `$1 ${local} `) } : x);
  } catch { return []; }
})();
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"), p = decodeURIComponent(url.pathname);
  for (const x of SITE_HEADERS) res.setHeader(x.key, x.value);
  try {
    if (p === "/api/dev/login") return devLogin(req, res, url);
    // like vercel.json (its routes run before the static files): shared links get their preview card from api/og.js
    const api = p === "/" && ["s", "b", "u", "live", "collab", "project", "invite"].some(k => url.searchParams.has(k)) ? { file: "api/og.js" } : apiFile(p);
    if (api) {
      if (api.route != null && !url.searchParams.has("route")) { url.searchParams.set("route", api.route); req.url = url.pathname + "?" + url.searchParams; }
      delete require.cache[require.resolve(join(root, api.file))]; // pick up edits without a restart
      const fn = require(join(root, api.file));
      return await (fn.default || fn)(req, res);
    }
    let file = normalize(join(root, p === "/" ? "index.html" : p));
    if (!file.startsWith(root) || /[\\/]\.|[\\/](api|tests|scripts|supabase|node_modules)[\\/]/.test(file.slice(root.length))) { res.statusCode = 404; return res.end("not found"); }
    if (!existsSync(file) || statSync(file).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("Content-Type", TYPES[extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e); if (!res.headersSent) { res.statusCode = 500; res.end("server error"); }
  }
}).listen(port, () => console.log(`dev server on http://localhost:${port}`));

function devLogin(req, res, url) {
  const { cfg, sign, cookie } = require(join(root, "api/_lib/auth.js"));
  const c = cfg(req);
  if (!c.secret) { res.statusCode = 400; return res.end("set OSU_CLIENT_SECRET (any local value) in .env.local"); }
  const id = +(url.searchParams.get("id") || 0), name = String(url.searchParams.get("name") || "").slice(0, 32);
  if (!(id > 0) || !name) { res.statusCode = 400; return res.end("?name=&id="); }
  const s = sign({ id, username: name, avatar: `https://a.ppy.sh/${id}`, country: "TH", kind: "session", exp: Date.now() + 864e5 }, c);
  res.statusCode = 302; res.setHeader("Set-Cookie", cookie("obv_s", s, 86400)); res.setHeader("Location", url.searchParams.get("next") || "/"); res.end();
}
