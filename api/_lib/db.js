// Supabase access for the server functions: database functions (PostgREST RPC) and the private Storage bucket.
// Env: SUPABASE_URL (https://<ref>.supabase.co) and SUPABASE_SECRET_KEY (a secret key "sb_secret_…", or the legacy
// service_role key). Server only: the key never reaches the browser, which only ever gets short-lived signed URLs.
const crypto = require("crypto");
const BUCKET = "obv-projects";

function conf() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return { url, key, ok: /^https?:\/\//.test(url) && key.length > 20 };
}
const configured = () => !!D1.db || conf().ok;

// new secret keys go in the apikey header only (they aren't JWTs); legacy service_role JWTs also as a bearer token
function hdrs(c, extra) {
  const h = { apikey: c.key, ...extra };
  if (c.key.startsWith("eyJ")) h.Authorization = "Bearer " + c.key;
  return h;
}

const { ApiError, STATUS } = require("./errors");

async function fetchT(url, opts, ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 15000);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch (e) { throw new ApiError(e.name === "AbortError" ? "db_timeout" : "db_unreachable", 503); }
  finally { clearTimeout(t); }
}
async function readJson(r) { const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return null; } }

// the database: Cloudflare D1 when the Worker runs with DB_BACKEND=d1 (and the DB binding; worker.js), else Supabase
const D1 = { db: null, target: null };
const useD1 = (d, target) => { D1.db = d || null; D1.target = target || d || null; }; // (target: the D1 binding, for the copy from Supabase)
const d1on = () => !!D1.db;
// (PostgREST turned numbers sent as text into bigint / int; the D1 functions compare numbers)
const NUM_ARGS = new Set(["p_actor", "p_user", "p_id", "p_owner_id", "p_owner", "p_limit", "p_offset", "p_base_revision", "p_max", "p_dir", "p_a", "p_b", "p_set_id"]);
async function rpc(name, args) {
  if (D1.db) {
    const { F, Q } = require("./d1"), f = F[name];
    if (!f) { console.error("d1: no function", name); throw new ApiError("db_error", 502); }
    const a = { ...(args || {}) };
    for (const k of Object.keys(a)) if (NUM_ARGS.has(k) && typeof a[k] === "string" && /^-?\d{1,16}$/.test(a[k])) a[k] = Number(a[k]); // (p_id: an osu! id, or a changelog uuid that stays text)
    try { return await f(new Q(D1.db), a); }
    catch (e) { if (e instanceof ApiError) throw e; console.error("d1", name, e && e.message); throw new ApiError("db_error", 502); }
  }
  return pgRpc(name, args);
}
// always Supabase (the copy to D1 reads it while the site still runs there)
async function pgRpc(name, args) {
  const c = conf(); if (!c.ok) throw new ApiError("not_configured", 503);
  const r = await fetchT(`${c.url}/rest/v1/rpc/${name}`, { method: "POST", headers: hdrs(c, { "Content-Type": "application/json", Accept: "application/json" }), body: JSON.stringify(args || {}) });
  const j = await readJson(r);
  if (!r.ok) {
    const m = String(j && j.message || ""), code = (m.match(/^OBV:(\w+)/) || [])[1];
    let detail = null; try { detail = j && j.details ? JSON.parse(j.details) : null; } catch {}
    if (code) throw new ApiError(code, STATUS[code] || 400, detail);
    console.error("rpc", name, r.status, (j && j.code) || "", m.slice(0, 200)); // no arguments: they may contain user data
    throw new ApiError("db_error", 502);
  }
  return j;
}

// ---------- Storage: Cloudflare R2 when the Worker has the binding FILES (worker.js), else Supabase Storage ----------
// R2: the browser uploads to and downloads from this Worker (/api/v1/files) with links signed here (HMAC, short-lived);
// only the Worker touches the bucket. Every R2 operation is counted per month in the database (obv_r2_use) and refused
// above the limits (Admin → Settings; never above R2's free tier), so the site can't run up a bill.
const R2 = { bucket: null, blockedB: 0 };
const useR2 = b => { R2.bucket = b || null; };
const r2on = () => !!R2.bucket;
const R2_FREE = { a: 1000000, b: 10000000 }; // R2 free tier per month (Class A: writes and lists, Class B: reads)
const UPLOAD_MAX = 95e6; // the Worker accepts request bodies up to 100 MB (free plan)
const linkKey = () => crypto.createHash("sha256").update("obv-files:" + String(process.env.OSU_CLIENT_SECRET || "").trim()).digest();
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fileLink(o) { const body = b64u(JSON.stringify(o)); return body + "." + b64u(crypto.createHmac("sha256", linkKey()).update(body).digest()); }
function readFileLink(tok, kind) {
  const [body, sig] = String(tok || "").split("."); if (!body || !sig || tok.length > 2048) return null;
  const want = b64u(crypto.createHmac("sha256", linkKey()).update(body).digest());
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const o = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); return o && o.t === kind && o.e > Date.now() ? o : null; } catch { return null; }
}
// count operations before doing them; over the month's limit -> refused (503 storage_limit)
async function r2Use(a, b) {
  const r = await rpc("obv_r2_use", { p_a: a, p_b: b });
  if (!r || !r.ok) { if (b) R2.blockedB = Date.now(); throw new ApiError("storage_limit", 503, r && { a: r.a, b: r.b, max_a: r.max_a, max_b: r.max_b }); }
  if (b) R2.blockedB = 0;
  return r;
}

const objPath = key => key.split("/").map(encodeURIComponent).join("/");
async function storage(method, path, body, extra) {
  const c = conf(); if (!c.ok) throw new ApiError("not_configured", 503);
  const r = await fetchT(`${c.url}/storage/v1${path}`, { method, headers: hdrs(c, { "Content-Type": "application/json", ...extra }), body: body == null ? undefined : JSON.stringify(body) });
  const j = await readJson(r);
  if (!r.ok) { console.error("storage", method, path.split("?")[0].replace(/[0-9a-f-]{36}/g, "…"), r.status, j && (j.message || j.error)); throw new ApiError("storage_error", 502, { status: r.status }); }
  return j;
}
// one upload link per key (valid 2 hours; Supabase: can't overwrite an existing object)
async function signUpload(key, size) {
  if (r2on()) return "/api/v1/files?u=" + fileLink({ t: "u", k: key, s: size, e: Date.now() + 2 * 3600e3 });
  const c = conf();
  const j = await storage("POST", `/object/upload/sign/${BUCKET}/${objPath(key)}`, {}, { "x-upsert": "false" });
  return `${c.url}/storage/v1${j.url}`;
}
// short-lived download links for the files of a revision
async function signDownloads(keys, expiresIn) {
  if (!keys.length) return {};
  if (r2on()) { const e = Date.now() + expiresIn * 1000, out = {}; for (const k of keys) out[k] = "/api/v1/files?d=" + fileLink({ t: "d", k, e }); return out; }
  const c = conf(), out = {};
  for (let i = 0; i < keys.length; i += 100) {
    const j = await storage("POST", `/object/sign/${BUCKET}`, { expiresIn, paths: keys.slice(i, i + 100) });
    for (const d of j || []) if (d && d.signedURL && !d.error) out[d.path] = `${c.url}/storage/v1${d.signedURL}`;
  }
  return out;
}
async function removeKeys(keys) {
  let n = 0;
  if (r2on()) { for (let i = 0; i < keys.length; i += 1000) { await R2.bucket.delete(keys.slice(i, i + 1000)); n += keys.slice(i, i + 1000).length; } return n; } // (deletes are free)
  for (let i = 0; i < keys.length; i += 500) { const j = await storage("DELETE", `/object/${BUCKET}`, { prefixes: keys.slice(i, i + 500) }); n += Array.isArray(j) ? j.length : 0; }
  return n;
}
// objects directly inside a "folder" (our keys are p/<project>/<file>)
async function listFolder(prefix) {
  const out = [];
  if (r2on()) {
    let cursor;
    for (let i = 0; i < 10; i++) {
      await r2Use(1, 0);
      const r = await R2.bucket.list({ prefix: prefix.replace(/\/?$/, "/"), limit: 1000, cursor });
      out.push(...r.objects.map(o => o.key)); if (!r.truncated) break; cursor = r.cursor;
    }
    return out;
  }
  for (let off = 0; off < 10000; off += 1000) {
    const j = await storage("POST", `/object/list/${BUCKET}`, { prefix, limit: 1000, offset: off, sortBy: { column: "name", order: "asc" } });
    const rows = (j || []).filter(x => x && x.id); // folders have no id
    out.push(...rows.map(x => prefix.replace(/\/?$/, "/") + x.name));
    if ((j || []).length < 1000) break;
  }
  return out;
}
// R2: the sizes of the uploads of a save, as stored ({ key: size }; missing keys aren't there)
async function storedSizes(keys) {
  const out = {}; if (!keys.length) return out;
  await r2Use(0, keys.length);
  for (let i = 0; i < keys.length; i += 8) await Promise.all(keys.slice(i, i + 8).map(async k => { const h = await R2.bucket.head(k); if (h) out[k] = h.size; }));
  return out;
}

module.exports = { BUCKET, configured, rpc, pgRpc, D1, useD1, d1on, STATUS, signUpload, signDownloads, removeKeys, listFolder, storedSizes, ApiError, fetchT, R2, R2_FREE, UPLOAD_MAX, useR2, r2on, r2Use, readFileLink };
