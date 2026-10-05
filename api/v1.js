// /api/v1/<route>: one function for the app's API (vercel.json rewrites /api/v1/* here with ?route=).
//
// Who you are comes only from the signed osu! session cookie (obv_s, set by /api/auth/callback). Every database call
// passes that verified osu! id to a database function that checks it again (account status, project role, expiry),
// so hiding buttons in the page is never what protects data. The browser never gets database or storage keys: only
// short-lived signed URLs for the files of projects it may read (10 min) or write (one object each, 2 h).
// The site owner is the osu! account whose numeric id is in OWNER_OSU_ID (names are never used for that). The owner can
// make other accounts admins (a role in the database, checked again on every admin request); only the owner changes
// site-wide settings and who is an admin.
const crypto = require("crypto");
const { cfg, unsign, sign, cookies, cookie, query } = require("./_lib/auth");
const osu = require("./_lib/osu");
const alt = require("./_lib/alt");
const db = require("./_lib/db");
const turn = require("./_lib/turn");
const { purgeProject, runCleanup } = require("./_lib/cleanup");
const { ApiError } = db;

function send(res, code, obj, cache) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", res.privateOnly && cache ? cache.replace("public", "private").replace(/, s-maxage=\d+|, stale-while-revalidate=\d+/g, "") : cache || "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(obj));
}
const PUBLIC_CACHE = "public, max-age=60, s-maxage=600, stale-while-revalidate=3600";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- request helpers ----------
async function body(req, max = 1.5e6) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === "string" ? req.body : "";
  if (raw.length > max) throw new ApiError("too_large", 413); // (the Worker hands the whole body over as text)
  if (!raw) for await (const ch of req) { raw += ch; if (raw.length > max) throw new ApiError("too_large", 413); }
  try { const j = JSON.parse(raw || "{}"); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch {}
  throw new ApiError("bad_request", 400);
}
// state-changing requests must come from this site (cookies are SameSite=Lax; this is a second check)
function sameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin, host = req.headers["x-forwarded-host"] || req.headers.host;
  if (origin) { try { if (new URL(origin).host !== host) return false; } catch { return false; } }
  return /application\/json/.test(req.headers["content-type"] || "");
}
function session(req) {
  const c = cfg(req); if (!c.secret) return null;
  const s = unsign(cookies(req).obv_s, c);
  return s && s.kind === "session" && s.id > 0 ? s : null;
}
const ownerId = () => { const o = String(process.env.OWNER_OSU_ID || "").trim(); return /^\d{1,12}$/.test(o) ? +o : null; };
const isOwner = s => !!s && ownerId() !== null && +s.id === ownerId();
const touched = new Map(); // osu id -> time the user row was last refreshed (per server instance)
function googlePending(req) { const g = unsign(cookies(req).obv_gp, cfg(req)); return g && g.kind === "gpend" && g.sub ? g : null; }
// refresh the user row; a deleted account (Account settings → Delete account) isn't brought back: a login made after
// the deletion starts a new, empty account, an older one (another device…) is logged out -> null
async function touch(s, res) {
  const args = { p_id: s.id, p_username: String(s.username || "").slice(0, 64), p_avatar: s.avatar || null, p_country: s.country || null };
  let u = await db.rpc("obv_user_touch", args);
  if (u && u.status === "deleted") {
    if (s.iat && s.iat > Date.parse(u.deleted_at)) { await db.rpc("obv_account_restart", { p_id: s.id, p_since: new Date(s.iat).toISOString() }); u = await db.rpc("obv_user_touch", args); }
    else { touched.delete(s.id); if (res) res.setHeader("Set-Cookie", cookie("obv_s", "", 0)); return null; }
  }
  touched.set(s.id, Date.now()); if (touched.size > 5000) touched.clear();
  return u;
}
// A session asked for with Google for an osu! name (unverified: never confirmed by that osu! account) only lasts as
// long as its Google link does: an osu! login by the real owner removes unconfirmed links, and with it every such
// session (they're stateless, so it's checked on every use: one small query, only for these few sessions).
async function unverifiedOk(s) {
  if (!s || !s.unverified) return true;
  try { const l = await db.rpc("obv_login_list", { p_user: s.id }); return !!(l && l.google && l.google.verified === false); } // (once a link is confirmed, it may be someone else's Google account: an osu! login gave the confirmed person a fresh session anyway)
  catch (e) { if (e.code !== "db_error") throw e; return true; } // (before the migration)
}
async function actor(req, res) {
  const s = session(req);
  if (!s) throw new ApiError("login_required", 401);
  if (!db.configured()) throw new ApiError("not_configured", 503);
  if (!(await unverifiedOk(s))) { if (res) res.setHeader("Set-Cookie", cookie("obv_s", "", 0)); throw new ApiError("login_required", 401, { reason: "unverified_link_gone" }); }
  const t = touched.get(s.id);
  if ((!t || Date.now() - t > 300000) && !(await touch(s))) throw new ApiError("account_deleted", 401);
  return s;
}
// "owner" | "admin" | null, never cached: removing an admin takes effect on their next request
async function adminRole(s) {
  if (isOwner(s)) return "owner";
  const r = await db.rpc("obv_admin_role", { p_id: s.id });
  return r && r.role === "admin" && r.status === "active" ? "admin" : null;
}
async function admin(req, ownerOnly) {
  const s = await actor(req), role = await adminRole(s);
  if (!role || (ownerOnly && role !== "owner")) throw new ApiError("forbidden", 403);
  s.role = role; return s;
}
// ---------- access (invite-only site) ----------
// When access_required is on (Settings), everything the app asks this server for needs an approved account: the owner,
// admins, and people an admin approved. Others can only log in, ask for access and see where their request is.
// Until the access migration has run the function doesn't exist and the site stays open. Cached a minute per instance.
let gate = { at: 0, on: false };
async function gateOn() {
  if (!db.configured()) return false;
  if (Date.now() - gate.at < 60000) return gate.on;
  try { gate = { at: Date.now(), on: (await db.rpc("obv_access_required", {})) !== false }; } catch { gate.at = Date.now() - 45000; } // retry soon, keep the last answer
  return gate.on;
}
const accessSeen = new Map(); // osu id -> { at, who }
// "admin" (owner and admins: everything), "member" (approved) or "guest"
async function accessOf(s) {
  if (!s) return "guest";
  if (isOwner(s)) return "admin";
  const c = accessSeen.get(s.id); if (c && Date.now() - c.at < 60000) return c.who;
  const a = await db.rpc("obv_access_of", { p_id: s.id });
  const who = a.status !== "active" ? "guest" : a.role === "admin" ? "admin" : a.access === "approved" ? "member" : "guest";
  accessSeen.set(s.id, { at: Date.now(), who }); if (accessSeen.size > 5000) accessSeen.clear();
  return who;
}
// what guests and members may use (Admin → Settings → Permissions), cached a minute. Until the permissions migration
// has run, guests get nothing and members everything (as before).
const PERM_AREAS = ["listing", "player", "mappers", "editor", "online", "live"]; // live: watch live sessions (guests; members have it)
const PERM_ALL = Object.fromEntries(PERM_AREAS.map(a => [a, true])), PERM_NONE = Object.fromEntries(PERM_AREAS.map(a => [a, false]));
let perms = { at: 0, v: { guest: PERM_NONE, member: PERM_ALL } };
async function sitePerms() {
  if (!db.configured() || Date.now() - perms.at < 60000) return perms.v;
  try { const v = await db.rpc("obv_site_perms", {}); perms = { at: Date.now(), v: { guest: { ...PERM_NONE, ...v.guest, online: false }, member: { ...PERM_ALL, ...v.member } } }; }
  catch { perms.at = Date.now() - 45000; }
  return perms.v;
}
// the part of the site a route serves (any one of them being allowed is enough)
function routeAreas(key) {
  if (/^osu\/(search|beatmap|set|tags)$/.test(key)) return ["listing", "player"];
  if (/^osu\/(user|beatmaps|activity)$/.test(key)) return ["mappers", "listing"];
  if (key === "link/:id") return ["player"];
  return ["online"]; // projects, saves, collab, live sessions, invites
}
async function requireAccess(req, key) {
  if (!(await gateOn())) return false;
  let s = session(req); if (s && !(await unverifiedOk(s))) s = null;
  const who = await accessOf(s);
  if (who === "admin") return true;
  const P = (await sitePerms())[who];
  if (routeAreas(key).some(a => P[a])) return true;
  if (who === "guest") throw s ? new ApiError("no_access", 403) : new ApiError("login_required", 401);
  throw new ApiError("forbidden", 403, { reason: "permission" });
}
// routes anyone may call on an invite-only site (the rest need access; admin routes check the admin role themselves)
const OPEN = new Set(["GET me", "POST access/request", "GET changelog", "GET invite", "POST invite/accept", "POST invite/accept-google", "POST live/ice", "POST live/ticket", "GET me/logins", "DELETE me/logins/google", "POST access/request-google",
  "GET me/account", "POST me/account", "GET me/prefs", "GET me/export", "POST me/delete", "POST errors", "POST feedback"]); // (your own account: always, whatever the site's permissions)
const userUpdate = (s, uid, patch) => db.rpc("obv_admin_user_update", { p_actor: s.id, p_actor_is_owner: s.role === "owner", p_owner_id: ownerId(), p_user: uid, p_patch: patch });
async function lookupOsu(who) { // "<osu name or id>" -> osu! user (the server asks osu!)
  who = String(who || "").trim();
  if (!/^[\w\-\[\] ]{1,32}$/.test(who)) throw new ApiError("bad_request", 400);
  let u; try { u = await osu.getUser(who); } catch { throw new ApiError("osu_lookup_failed", 502); }
  if (!u) throw new ApiError("user_not_found", 404);
  return u;
}
const int = (v, lo, hi, d) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };

// signed download links for a revision's files (never longer than the time left before the project expires)
async function withFiles(p) {
  const left = Math.floor((new Date(p.expires_at).getTime() - Date.now()) / 1000);
  const urls = await db.signDownloads((p.manifest || []).map(f => f.key), Math.max(30, Math.min(600, left)));
  p.files = (p.manifest || []).map(f => ({ path: f.path, size: f.size, sha256: f.sha256, url: urls[f.key] || null }));
  delete p.manifest;
  return p;
}
// ---------- TURN relay for live sessions ----------
// The host's browser asks for a token when it starts a session (an approved account); the token is the session code
// signed by this server with its end time. Anyone in that session (guests too) can then get relay credentials with it,
// until the session ends. Nobody gets the relay without a started session.
const LIVE_MS = 3 * 3600 * 1000;
const liveSig = (req, code, exp) => crypto.createHmac("sha256", cfg(req).key).update(`live:${code}:${exp}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").slice(0, 22);
function liveToken(req, code, exp) { return exp.toString(36) + "." + liveSig(req, code, exp); }
function liveTokenExp(req, code, tok) { // -> end time, or 0 when the token isn't valid (any more)
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})$/.exec(String(tok || "")); if (!m || !cfg(req).secret) return 0;
  const exp = parseInt(m[1], 36), want = Buffer.from(liveSig(req, code, exp)), got = Buffer.from(m[2]);
  return exp > Date.now() && exp < Date.now() + LIVE_MS + 600000 && got.length === want.length && crypto.timingSafeEqual(got, want) ? exp : 0;
}
// { on, ping_ms, relay, month_gb, capped } (Admin → Settings → TURN relay, and the person's own "always use the relay").
// Over the monthly limit (Cloudflare's usage numbers, when the analytics token is set) nobody gets the relay until the
// next month: live sessions stay peer-to-peer.
const GB = 1e9;
async function turnConf(uid) {
  const out = { on: turn.configured(), ping_ms: 150, relay: false, month_gb: 0, capped: false };
  if (!out.on || !db.configured()) return out;
  try { const c = await db.rpc("obv_turn_conf", { p_user: uid || null }); out.on = c.on !== false; out.ping_ms = +c.ping_ms || 150; out.relay = c.relay === true; out.month_gb = +c.month_gb || 0; }
  catch {} // before the TURN migration: on, 150 ms, nobody forced
  if (out.on && out.month_gb > 0 && turn.analyticsConfigured()) {
    try { const u = await turn.usageCached(); if (u && u.bytes >= out.month_gb * GB) { out.on = false; out.capped = true; } }
    catch {} // usage unknown: keep the relay
  }
  return out;
}
const turnIdent = s => s && s.id > 0 ? "u" + s.id : "guest";
const liveCode = c => /^[a-z0-9]{6,12}$/.test(String(c || "")) ? String(c) : null;

// who you are, for one audience only: "live:<code>" (a guest showing the host), "live:<code>:<peer>" (the host showing
// that one guest), the same with "collab:". 10 minutes: long enough to join, useless anywhere else.
const TICKET_AUD = /^(live|collab):[a-z0-9]{6,12}(:[\w-]{1,80})?$/;
function sessionTicket(req, s, extra) { return sign({ id: s.id, username: s.username, avatar: s.avatar, country: s.country, exp: Date.now() + 4 * 3600 * 1000, ...extra }, cfg(req)); }

// Google Drive (js/gdrive.js): the browser saves maps in the user's own Drive with Google's sign-in; only these public
// IDs come from here. GOOGLE_DRIVE=on (and the Drive API turned on in the same Google Cloud project as the login);
// GOOGLE_API_KEY + GOOGLE_PROJECT_NUMBER add Google's file picker (to open any .osz from Drive).
function driveConf() {
  const e = k => String(process.env[k] || "").trim(), id = e("GOOGLE_CLIENT_ID");
  if (!id || !/^(on|1|true|yes)$/i.test(e("GOOGLE_DRIVE"))) return null;
  const key = e("GOOGLE_API_KEY"), app = e("GOOGLE_PROJECT_NUMBER");
  return { client_id: id, ...(key && /^\d{6,20}$/.test(app) ? { api_key: key, app_id: app } : {}) };
}

// ---------- routes ----------
const routes = {
  // who am I (+ owner flag for the admin link; the server checks the id again on every admin request)
  "GET me": async (req, res) => {
    const s = session(req);
    const out = { user: s ? { id: s.id, username: s.username, avatar: s.avatar, country: s.country } : null, owner: isOwner(s), admin: isOwner(s) ? "owner" : null,
      cloud: db.configured(), osu: osu.configured(), alt: alt.configured(), drive: driveConf(), status: null, limits: null, gate: null, access: isOwner(s) ? "approved" : null };
    // one database call when logged in (obv_user_touch also says whether access is required); the switch alone otherwise
    if (s && db.configured()) {
      try {
        if (!(await unverifiedOk(s))) { res.setHeader("Set-Cookie", cookie("obv_s", "", 0)); send(res, 200, { ...out, user: null, owner: false, admin: null, access: null, gate: await gateOn() }); return; } // (asked for with Google; the osu! owner has since logged in)
        const u = await touch(s, res);
        if (!u) { send(res, 200, { ...out, user: null, owner: false, admin: null, access: null, deleted: true, gate: await gateOn() }); return; } // (logged out: the account was deleted)
        out.status = u.status; out.limits = u.limits || null; out.prefs_at = u.prefs_at || null;
        if (!out.admin && u.role === "admin" && u.status === "active") out.admin = "admin";
        if (!out.access) out.access = out.admin ? "approved" : u.access || "none";
        out.access_requested_at = u.access_requested_at || null;
        if (u.access_required !== undefined) { out.gate = u.access_required !== false; gate = { at: Date.now(), on: out.gate }; }
      } catch { out.cloud = false; }
    }
    if (out.gate === null) out.gate = await gateOn();
    if (out.gate) out.perms = await sitePerms(); // what guests and members can use (the client hides the rest)
    if (out.admin && db.configured()) try { out.badges = await db.rpc("obv_admin_badges", {}); } catch {} // (people waiting for an answer, new errors)
    if (!s && googlePending(req)) out.google_pending = true; // signed in with a Google account that isn't linked yet (gate page: type the osu! name)
    send(res, 200, out);
  },

  // ----- access: ask for it (after logging in with osu!) -----
  // Request access with Google (gate page): signed in with a Google account that isn't linked to anyone, they type
  // their osu! name; the server looks it up on osu! and the request is marked "via Google, not verified" for the admins
  "POST access/request-google": async (req, res) => {
    const gp = googlePending(req); if (!gp) throw new ApiError("google_expired", 401);
    if (!db.configured()) throw new ApiError("not_configured", 503);
    if (!(await gateOn())) throw new ApiError("bad_request", 400, { reason: "open" });
    const b = await body(req, 4000), u = await lookupOsu(String(b.osu || "").replace(/^(?:https?:\/\/)?(?:www\.)?osu\.ppy\.sh\/(?:users|u)\//i, "").replace(/[/?#].*$/, ""));
    const r = await db.rpc("obv_google_request", { p_sub: gp.sub, p_id: u.id, p_username: String(u.username || "").slice(0, 64), p_avatar: u.avatar_url || null, p_country: u.country_code || null, p_message: String(b.message || "").slice(0, 300) });
    accessSeen.delete(u.id); touched.delete(u.id);
    const c = cfg(req);
    res.setHeader("Set-Cookie", [cookie("obv_s", alt.altSession(c, "google", { id: u.id, username: u.username, avatar: u.avatar_url, country: u.country_code, verified: r.verified }), 30 * 86400),
      cookie("obv_gl", sign({ kind: "glink", sub: gp.sub, osu: u.id, exp: Date.now() + 400 * 864e5 }, c), 400 * 86400), cookie("obv_gp", "", 0)]);
    send(res, 200, { ...r, user: { id: u.id, username: u.username } });
  },
  "POST access/request": async (req, res) => {
    const s = session(req); if (!s) throw new ApiError("login_required", 401);
    if (!db.configured()) throw new ApiError("not_configured", 503);
    if (!(await touch(s, res))) throw new ApiError("account_deleted", 401);
    const b = await body(req, 4000);
    const r = await db.rpc("obv_access_request", { p_id: s.id, p_username: String(s.username || "").slice(0, 64), p_avatar: s.avatar || null, p_country: s.country || null, p_message: String(b.message || "").slice(0, 300) });
    accessSeen.delete(s.id);
    send(res, 200, r);
  },

  // ----- invites: everyone with access has a link that lets a few people in without waiting (limits set by admins) -----
  "GET invites": async (req, res) => {
    const s = await actor(req);
    send(res, 200, await db.rpc("obv_invite_mine", { p_actor: s.id, p_owner_id: ownerId() }));
  },
  // { on: boolean }: does my link open with the animated invitation or the plain invite page
  "POST invites/fx": async (req, res) => {
    const s = await actor(req), b = await body(req);
    if (typeof b.on !== "boolean") throw new ApiError("bad_request", 400);
    let r;
    try { r = await db.rpc("obv_invite_fx_set", { p_actor: s.id, p_on: b.on, p_owner_id: ownerId() }); } // only people an admin allowed may turn it on
    catch (e) { if (e.code !== "db_error") throw e; r = await db.rpc("obv_invite_fx_set", { p_actor: s.id, p_on: b.on }); } // (before the permission migration)
    send(res, 200, r);
  },
  "POST invites/reset": async (req, res) => { const s = await actor(req); send(res, 200, await db.rpc("obv_invite_reset", { p_actor: s.id, p_owner_id: ownerId() })); },
  // an invite link before logging in: whose it is and whether it still works (?code=)
  "GET invite": async (req, res, q) => {
    const code = String(q.get("code") || "");
    if (!/^[A-Za-z0-9]{10}$/.test(code)) throw new ApiError("not_found", 404);
    if (!db.configured()) throw new ApiError("not_configured", 503);
    send(res, 200, await db.rpc("obv_invite_info", { p_code: code, p_owner_id: ownerId() }));
  },
  "POST invite/accept": async (req, res) => {
    const s = session(req); if (!s) throw new ApiError("login_required", 401);
    if (!db.configured()) throw new ApiError("not_configured", 503);
    if (!(await touch(s, res))) throw new ApiError("account_deleted", 401);
    const b = await body(req), code = String(b.code || "");
    if (!/^[A-Za-z0-9]{10}$/.test(code)) throw new ApiError("not_found", 404);
    const r = await db.rpc("obv_invite_accept", { p_id: s.id, p_username: String(s.username || "").slice(0, 64), p_avatar: s.avatar || null, p_country: s.country || null, p_code: code, p_owner_id: ownerId() });
    accessSeen.delete(s.id); send(res, 200, r);
  },

  // accept an invite with a Google account that isn't linked yet: they type their osu! name, like access/request-google
  // (the link stays "not verified" until that osu! account logs in once; an osu! login removes links it didn't confirm)
  "POST invite/accept-google": async (req, res) => {
    const gp = googlePending(req); if (!gp) throw new ApiError("google_expired", 401);
    if (!db.configured()) throw new ApiError("not_configured", 503);
    const b = await body(req, 4000), code = String(b.code || "");
    if (!/^[A-Za-z0-9]{10}$/.test(code)) throw new ApiError("not_found", 404);
    const info = await db.rpc("obv_invite_info", { p_code: code, p_owner_id: ownerId() });
    if (!info || !info.ok) throw new ApiError(info && info.reason === "full" ? "invite_full" : "invite_inactive", info && info.reason === "full" ? 409 : 403);
    const u = await lookupOsu(String(b.osu || "").replace(/^(?:https?:\/\/)?(?:www\.)?osu\.ppy\.sh\/(?:users|u)\//i, "").replace(/[/?#].*$/, ""));
    const prof = { p_id: u.id, p_username: String(u.username || "").slice(0, 64), p_avatar: u.avatar_url || null, p_country: u.country_code || null };
    const g = await db.rpc("obv_google_request", { p_sub: gp.sub, ...prof, p_message: "" });
    const r = await db.rpc("obv_invite_accept", { ...prof, p_code: code, p_owner_id: ownerId() });
    accessSeen.delete(u.id); touched.delete(u.id);
    const c = cfg(req);
    res.setHeader("Set-Cookie", [cookie("obv_s", alt.altSession(c, "google", { id: u.id, username: u.username, avatar: u.avatar_url, country: u.country_code, verified: g.verified }), 30 * 86400),
      cookie("obv_gl", sign({ kind: "glink", sub: gp.sub, osu: u.id, exp: Date.now() + 400 * 864e5 }, c), 400 * 86400), cookie("obv_gp", "", 0)]);
    send(res, 200, { ...r, user: { id: u.id, username: u.username } });
  },

  // ----- projects -----
  "GET projects": async (req, res) => { const s = await actor(req); send(res, 200, { projects: await db.rpc("obv_projects_list", { p_actor: s.id }) }); },
  "POST projects": async (req, res) => {
    const s = await actor(req), b = await body(req);
    const p = await db.rpc("obv_project_create", { p_actor: s.id, p_client_key: String(b.clientKey || ""), p_title: String(b.title || "").slice(0, 300),
      p_artist: String(b.artist || "").slice(0, 300), p_creator: String(b.creator || "").slice(0, 64), p_set_id: int(b.setId, 1, 1e10, null) });
    send(res, p.existing ? 200 : 201, { project: p });
  },
  "GET projects/:id": async (req, res, q, P) => {
    const s = await actor(req), p = await db.rpc("obv_project_get", { p_actor: s.id, p_project: P.id });
    if (q.get("files") !== "0") await withFiles(p); else delete p.manifest;
    send(res, 200, { project: p });
  },
  "DELETE projects/:id": async (req, res, q, P) => {
    const s = await actor(req);
    await db.rpc("obv_project_delete", { p_actor: s.id, p_project: P.id });
    let r = null; try { r = await purgeProject(P.id); } catch {}
    send(res, 200, { deleted: true, files_removed: !!(r && r.done) }); // access is gone either way; leftovers are retried daily
  },
  // share: { user: "<osu name or id>", role: "viewer" | "editor" | "none" }
  "POST projects/:id/members": async (req, res, q, P) => {
    const s = await actor(req), b = await body(req), role = String(b.role || ""), who = String(b.user || "").trim();
    if (!["viewer", "editor", "none"].includes(role) || !/^[\w\-\[\] ]{1,32}$/.test(who)) throw new ApiError("bad_request", 400);
    const u = /^\d+$/.test(who) && role === "none" ? { id: +who, username: "", avatar_url: null } : await lookupOsu(who);
    const members = await db.rpc("obv_member_set", { p_actor: s.id, p_project: P.id, p_user: u.id, p_username: u.username || String(u.id), p_avatar: u.avatar_url || null, p_role: role });
    send(res, 200, { members });
  },
  // "anyone with the link can view": { mode: "on" | "reset" | "off" } (the owner only)
  "POST projects/:id/link": async (req, res, q, P) => {
    const s = await actor(req), b = await body(req);
    send(res, 200, await db.rpc("obv_project_link", { p_actor: s.id, p_project: P.id, p_mode: String(b.mode || "") }));
  },
  // opening a shared link: no login needed; the key is checked in the database
  "GET link/:id": async (req, res, q, P) => {
    const key = String(q.get("key") || "");
    if (!/^[A-Za-z0-9_-]{32}$/.test(key)) throw new ApiError("not_found", 404);
    if (!db.configured()) throw new ApiError("not_configured", 503);
    const p = await db.rpc("obv_project_by_link", { p_project: P.id, p_key: key });
    send(res, 200, { project: await withFiles(p) });
  },
  // save step 1: { baseRevision, files: [{ path, size, sha256 }] } -> which files to upload, with one signed URL each
  "POST projects/:id/saves": async (req, res, q, P) => {
    const s = await actor(req), b = await body(req);
    const r = await db.rpc("obv_save_begin", { p_actor: s.id, p_project: P.id, p_base_revision: int(b.baseRevision, 0, 1e9, -1), p_files: Array.isArray(b.files) ? b.files : null });
    const uploads = [];
    if (db.r2on() && r.uploads.length) { // R2: each upload is one Class A operation (counted, refused above the month's limit)
      if (r.uploads.some(u => u.size > db.UPLOAD_MAX)) throw new ApiError("too_large", 413, { limit: db.UPLOAD_MAX });
      await db.r2Use(r.uploads.length, 0);
    }
    for (let i = 0; i < r.uploads.length; i += 8) uploads.push(...await Promise.all(r.uploads.slice(i, i + 8).map(async u => ({ path: u.path, size: u.size, url: await db.signUpload(u.key, u.size) }))));
    send(res, 200, { saveId: r.save_id, uploads, reused: r.reused, size: r.size, limit: r.limit });
  },
  // save step 2: the uploads are done -> verified and switched to the new revision in one transaction
  "POST saves/:id/commit": async (req, res, q, P) => {
    const s = await actor(req), b = await body(req);
    const ann = b.annotations && typeof b.annotations === "object" ? { upsert: Array.isArray(b.annotations.upsert) ? b.annotations.upsert.slice(0, 2000) : [], delete: Array.isArray(b.annotations.delete) ? b.annotations.delete.slice(0, 2000) : [] } : null;
    const args = { p_actor: s.id, p_save: P.id, p_annotations: ann };
    if (db.r2on()) { // R2: the database can't see the bucket, so the uploads are checked here
      const pend = await db.rpc("obv_save_pending", { p_actor: s.id, p_save: P.id }) || [];
      args.p_stored = await db.storedSizes(pend.map(x => x.key));
    }
    const r = await db.rpc("obv_save_commit", args);
    delete r.manifest;
    send(res, 200, r);
  },

  // ----- collab: a host checks a joiner's login and their role in the host's online project -----
  "POST collab/verify": async (req, res) => {
    const s = await actor(req), b = await body(req);
    const t = unsign(b.ticket, cfg(req));
    if (!t || t.kind !== "ticket" || !(t.id > 0) || typeof b.aud !== "string" || !/^collab:/.test(b.aud) || t.aud !== b.aud) return send(res, 200, { ok: false }); // (made for this collab only)
    let role = null;
    if (b.project) {
      if (!UUID.test(String(b.project))) throw new ApiError("bad_request", 400);
      await db.rpc("obv_project_role", { p_actor: s.id, p_project: b.project }); // the host must have access too
      try { role = (await db.rpc("obv_project_role", { p_actor: t.id, p_project: b.project })).role; } catch (e) { if (e.code !== "not_found" && e.code !== "no_user" && e.code !== "suspended") throw e; }
    }
    send(res, 200, { ok: true, user: { id: t.id, username: t.username, avatar: t.avatar }, role });
  },

  // ----- public osu! data -----
  "GET osu/user": async (req, res, q) => {
    const u = String(q.get("u") || "").trim();
    if (!/^[\w\-\[\] ]{1,32}$/.test(u)) throw new ApiError("bad_request", 400);
    const user = await osu.getUser(u);
    if (!user) return send(res, 404, { error: "not_found" }, "public, max-age=60, s-maxage=300");
    send(res, 200, { user }, PUBLIC_CACHE);
  },
  "GET osu/beatmaps": async (req, res, q) => {
    const id = String(q.get("id") || ""), type = String(q.get("type") || ""), offset = int(q.get("offset") || 0, 0, 99, -1), limit = int(q.get("limit") || 20, 1, 50, -1);
    if (!/^\d{1,10}$/.test(id) || !osu.USER_TYPES.includes(type) || offset < 0 || limit < 0) throw new ApiError("bad_request", 400);
    const sets = await osu.getUserSets(id, type, offset, Math.min(limit, 100 - offset));
    send(res, 200, { sets, offset, limit, max: 100 }, PUBLIC_CACHE);
  },
  "GET osu/activity": async (req, res, q) => {
    const id = String(q.get("id") || ""); if (!/^\d{1,10}$/.test(id)) throw new ApiError("bad_request", 400);
    send(res, 200, await osu.getUserActivity(id), PUBLIC_CACHE);
  },
  "GET osu/search": async (req, res, q) => {
    const g = int(q.get("g") || 0, 0, 20, -1), l = int(q.get("l") || 0, 0, 20, -1), e = String(q.get("e") || ""), cursor = String(q.get("cursor") || "");
    const o = { q: String(q.get("q") || "").slice(0, 300), s: String(q.get("s") || ""), g, l, e, nsfw: q.get("nsfw") === "1", sort: String(q.get("sort") || ""), cursor, m: q.get("m") === "3" ? "3" : "0" };
    if (g < 0 || l < 0 || !/^((video|storyboard)(\.(video|storyboard))?)?$/.test(e) || cursor.length > 400 || /[\r\n]/.test(o.q)) throw new ApiError("bad_request", 400);
    send(res, 200, await osu.search(o), "public, max-age=60, s-maxage=60, stale-while-revalidate=120");
  },
  "GET osu/beatmap": async (req, res, q) => {
    const id = String(q.get("id") || ""); if (!/^\d{1,10}$/.test(id)) throw new ApiError("bad_request", 400);
    const sid = await osu.getBeatmapSetId(id);
    if (!sid) return send(res, 404, { error: "not_found" }, "public, max-age=60, s-maxage=300");
    send(res, 200, { set_id: sid }, "public, max-age=3600, s-maxage=86400");
  },
  "GET osu/tags": async (req, res) => { send(res, 200, { tags: await osu.getTags() }, "public, max-age=3600, s-maxage=86400"); },
  "GET osu/set": async (req, res, q) => {
    const id = String(q.get("id") || ""); if (!/^\d{1,10}$/.test(id)) throw new ApiError("bad_request", 400);
    const set = await osu.getSet(id);
    if (!set) return send(res, 404, { error: "not_found" }, "public, max-age=60, s-maxage=300");
    send(res, 200, { set }, PUBLIC_CACHE);
  },
  // ----- live sessions: the relay token (host) and relay credentials (anyone in the session) -----
  "POST live/start": async (req, res) => {
    const s = await actor(req), b = await body(req), code = liveCode(b.code);
    if (s.gonly || s.unverified) throw new ApiError("osu_required", 403); // (hosting a live session needs an osu! login, confirmed)
    if (!code) throw new ApiError("bad_request", 400);
    const exp = Date.now() + LIVE_MS + 60000, c = await turnConf(s.id);
    const iceServers = c.on ? await turn.iceServers((exp - Date.now()) / 1000, turnIdent(s)) : [];
    send(res, 200, { token: liveToken(req, code, exp), exp, on: c.on && iceServers.length > 0, ping_ms: c.ping_ms, relay: c.relay && iceServers.length > 0, iceServers });
  },
  "POST live/ticket": async (req, res) => {
    const s = session(req), b = await body(req, 2000), aud = String(b.aud || "");
    if (!s) throw new ApiError("login_required", 401);
    if (s.gonly || s.unverified || (db.configured() && !(await unverifiedOk(s)))) throw new ApiError("osu_required", 403);
    if (!TICKET_AUD.test(aud)) throw new ApiError("bad_request", 400);
    send(res, 200, { ticket: sessionTicket(req, s, { kind: "ticket", aud, exp: Date.now() + 10 * 60 * 1000 }) });
  },
  "POST live/ice": async (req, res) => {
    const b = await body(req), code = liveCode(b.code), exp = code ? liveTokenExp(req, code, b.token) : 0;
    if (!exp) throw new ApiError("forbidden", 403, { reason: "no_session" });
    const s = session(req), c = await turnConf(s && s.id);
    const iceServers = c.on ? await turn.iceServers((exp - Date.now()) / 1000, turnIdent(s)) : [];
    send(res, 200, { on: c.on && iceServers.length > 0, ping_ms: c.ping_ms, relay: c.relay && iceServers.length > 0, iceServers });
  },
  // TURN servers for collab: Cloudflare's relay when set up (Admin → Settings → TURN relay: also { on, ping_ms, relay }),
  // else TURN_URLS (a fallback only), else none
  "GET ice": async (req, res) => {
    if (turn.configured()) {
      const s = session(req), c = await turnConf(s && s.id), list = c.on ? await turn.iceServers(4 * 3600, turnIdent(s)) : [];
      // with the same switches as live sessions: the ping limit, and whether this person always uses the relay
      if (list.length) return send(res, 200, { iceServers: list, on: true, ping_ms: c.ping_ms, relay: c.relay });
    }
    const urls = String(process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(s => /^turns?:/.test(s));
    if (!urls.length) return send(res, 200, { iceServers: [] });
    let username = process.env.TURN_USERNAME || "", credential = process.env.TURN_CREDENTIAL || "";
    if (process.env.TURN_SECRET) { // TURN REST API (coturn use-auth-secret): credentials that expire after 2 hours
      username = `${Math.floor(Date.now() / 1000) + 7200}:obv`;
      credential = crypto.createHmac("sha1", process.env.TURN_SECRET).update(username).digest("base64");
    }
    send(res, 200, { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }, { urls, username, credential }] });
  },

  // ----- changelog (public: published entries only; no CDN cache, so edits show at once) -----
  // backup login (Google) linked to your osu! account; linking itself goes through /api/auth/<provider>?mode=link
  "GET me/logins": async (req, res) => {
    const s = await actor(req); let linked = null;
    try { linked = await db.rpc("obv_login_list", { p_user: s.id }); } catch (e) { if (e.code !== "db_error") throw e; } // (before the migration)
    send(res, 200, { configured: alt.configured(), linked, via: s.via || "osu" });
  },
  "DELETE me/logins/google": async (req, res) => { const s = await actor(req); send(res, 200, { linked: await db.rpc("obv_login_unlink", { p_user: s.id, p_provider: "google" }) }); },
  // ---------- your account (Account settings) ----------
  "GET me/account": async (req, res) => { const s = await actor(req); send(res, 200, { ...await db.rpc("obv_account_get", { p_user: s.id }), owner: isOwner(s), via: s.via || "osu" }); },
  "POST me/account": async (req, res) => { // { allow_add?, sync?, prefs? }
    const s = await actor(req), b = await body(req, 20000), patch = {};
    for (const k of ["allow_add", "sync", "prefs"]) if (k in b) patch[k] = b[k];
    send(res, 200, await db.rpc("obv_account_set", { p_user: s.id, p_patch: patch }));
  },
  "GET me/prefs": async (req, res) => { const s = await actor(req); send(res, 200, await db.rpc("obv_account_prefs", { p_user: s.id })); },
  "GET me/export": async (req, res) => { // everything kept about you, as a file
    const s = await actor(req), d = await db.rpc("obv_account_export", { p_user: s.id });
    res.setHeader("Content-Disposition", `attachment; filename="kiki-beatmap-viewer-my-data-${s.id}.json"`);
    send(res, 200, d);
  },
  // Delete account: the page asks to type "Confirm", and so does the server
  "POST me/delete": async (req, res) => {
    const s = await actor(req), b = await body(req, 1000);
    if (b.confirm !== "Confirm") throw new ApiError("bad_request", 400, { field: "confirm" });
    if (isOwner(s)) throw new ApiError("forbidden", 403, { reason: "owner" });
    const r = await db.rpc("obv_account_delete", { p_user: s.id, p_owner_id: ownerId() });
    touched.delete(s.id); accessSeen.delete(s.id);
    let left = 0; const t0 = Date.now(); // the projects' files now (what's left goes with the daily cleanup)
    for (const id of r.projects || []) { if (Date.now() - t0 > 20000) { left++; continue; } try { const x = await purgeProject(id); if (!(x && x.done)) left++; } catch { left++; } }
    if (!left) { try { await db.rpc("obv_account_finish", { p_user: s.id }); } catch {} }
    res.setHeader("Set-Cookie", [cookie("obv_s", "", 0), cookie("obv_alt", "", 0)]);
    send(res, 200, { deleted: true, projects: (r.projects || []).length, pending: left });
  },
  "GET changelog": async (req, res) => { send(res, 200, { entries: await db.rpc("obv_changelog_public", {}) }); },

  // ----- admin (the owner and the admins they added; settings and admins: the owner only) -----
  "GET admin/me": async (req, res) => { const s = await admin(req); send(res, 200, { role: s.role, id: s.id, owner_id: ownerId() }); },
  "GET admin/overview": async (req, res) => {
    await admin(req);
    const o = await db.rpc("obv_admin_overview", {});
    o.backend = db.r2on() ? "r2" : "supabase";
    if (db.r2on()) { // the files are on R2: what the database tracks is what's there (Supabase Storage is empty)
      const t = o.tracked_bytes || {}; o.storage = { objects: null, bytes: (+t.committed || 0) + (+t.pending || 0) + (+t.orphaned || 0) }; o.untracked = { objects: 0, bytes: 0 };
    }
    try { o.r2 = await db.rpc("obv_r2_usage", {}); } catch {} // (before the R2 migration: none)
    send(res, 200, o);
  },
  "GET admin/users": async (req, res, q) => {
    await admin(req);
    send(res, 200, await db.rpc("obv_admin_users", { p_q: String(q.get("q") || "").slice(0, 40), p_limit: int(q.get("limit") || 30, 1, 100, 30), p_offset: int(q.get("offset") || 0, 0, 1e6, 0),
      p_status: ["active", "suspended"].includes(q.get("status")) ? q.get("status") : "", p_role: ["admin", "user", "custom"].includes(q.get("role")) ? q.get("role") : "",
      p_sort: ["bytes", "projects", "created", "name"].includes(q.get("sort")) ? q.get("sort") : "" }));
  },
  "GET admin/users/:uid": async (req, res, q, P) => {
    await admin(req); const user = await db.rpc("obv_admin_user_get", { p_user: +P.uid });
    try { user.access = await db.rpc("obv_admin_user_access", { p_user: +P.uid }); } catch {} // before the access migration: no access info
    try { user.invites = await db.rpc("obv_admin_user_invites", { p_user: +P.uid, p_owner_id: ownerId() }); } catch {} // (and before the invites one)
    try { user.turn_relay = (await db.rpc("obv_turn_conf", { p_user: +P.uid })).relay === true; } catch {} // (and the TURN one)
    send(res, 200, { user });
  },
  // access requests: ?status=pending|approved|denied|none
  "GET admin/access": async (req, res, q) => {
    await admin(req);
    send(res, 200, await db.rpc("obv_admin_access", { p_status: ["pending", "approved", "denied", "none", "invited"].includes(q.get("status")) ? q.get("status") : "",
      p_q: String(q.get("q") || "").slice(0, 40), p_limit: int(q.get("limit") || 50, 1, 100, 50), p_offset: int(q.get("offset") || 0, 0, 1e6, 0) }));
  },
  // { can_invite?: boolean, invite_limit?: number | null (null = the site-wide number) }
  "POST admin/users/:uid/invites": async (req, res, q, P) => {
    const s = await admin(req), b = await body(req), patch = {};
    for (const k of ["can_invite", "invite_limit"]) if (k in b) patch[k] = b[k];
    send(res, 200, await db.rpc("obv_admin_invites_set", { p_actor: s.id, p_owner_id: ownerId(), p_user: +P.uid, p_patch: patch }));
  },
  // admins' invite links, each with its own number of people: list / { max_uses, note } / { code, revoke?, max_uses? }
  "GET admin/invite-links": async (req, res) => { await admin(req); send(res, 200, { links: await db.rpc("obv_admin_invite_links", { p_owner_id: ownerId() }) }); },
  "POST admin/invite-links": async (req, res) => {
    const s = await admin(req), b = await body(req);
    send(res, 200, { link: await db.rpc("obv_admin_invite_link_create", { p_actor: s.id, p_owner_id: ownerId(), p_max: int(b.max_uses, 1, 1000, 0), p_note: String(b.note || "").slice(0, 80) }) });
  },
  "POST admin/invite-links/update": async (req, res) => {
    const s = await admin(req), b = await body(req), code = String(b.code || ""), patch = {};
    if (!/^[A-Za-z0-9]{10}$/.test(code)) throw new ApiError("bad_request", 400);
    if (b.revoke === true) patch.revoke = true;
    if ("max_uses" in b) patch.max_uses = int(b.max_uses, 1, 1000, 0);
    send(res, 200, { link: await db.rpc("obv_admin_invite_link_update", { p_actor: s.id, p_owner_id: ownerId(), p_code: code, p_patch: patch }) });
  },
  // everyone back to the site-wide invite settings (the owner only, like the settings)
  "POST admin/invites/reset-all": async (req, res) => { const s = await admin(req, true); send(res, 200, await db.rpc("obv_admin_invites_reset_all", { p_actor: s.id })); },
  // { on: boolean }: may this person use the animated invitation for their links
  "POST admin/users/:uid/invite-fx": async (req, res, q, P) => {
    const s = await admin(req), b = await body(req);
    if (typeof b.on !== "boolean") throw new ApiError("bad_request", 400);
    send(res, 200, await db.rpc("obv_admin_invite_fx_allow", { p_actor: s.id, p_user: +P.uid, p_on: b.on }));
  },
  // TURN relay: set up?, this month's usage from Cloudflare (total, per day, biggest users) and the limit. ?fresh=1 asks again.
  "GET admin/turn": async (req, res, q) => {
    await admin(req);
    const c = await turnConf(null), out = { key: turn.configured(), analytics: turn.analyticsConfigured(), on: c.on || c.capped, capped: c.capped, ping_ms: c.ping_ms, month_gb: c.month_gb, usage: null, error: null };
    if (out.analytics) {
      try {
        out.usage = await turn.usageCached(q.get("fresh") === "1");
        const ids = (out.usage && out.usage.people || []).map(p => +String(p.ident).slice(1)).filter(n => n > 0);
        if (ids.length) { try { const names = new Map((await db.rpc("obv_usernames", { p_ids: ids })).map(u => [u.id, u])); for (const p of out.usage.people) { const u = names.get(+p.ident.slice(1)); if (u) Object.assign(p, { id: u.id, username: u.username, avatar: u.avatar }); } } catch {} }
      } catch (e) { out.error = String(e.message || e).slice(0, 200); }
    }
    send(res, 200, out);
  },
  // { on: boolean }: this person always uses the TURN relay in live sessions (skips peer-to-peer)
  "POST admin/users/:uid/turn": async (req, res, q, P) => {
    const s = await admin(req), b = await body(req);
    if (typeof b.on !== "boolean") throw new ApiError("bad_request", 400);
    send(res, 200, await db.rpc("obv_admin_turn_relay", { p_actor: s.id, p_user: +P.uid, p_on: b.on }));
  },
  // { access: "approved" | "denied" | "none" }
  "POST admin/access/:uid": async (req, res, q, P) => {
    const s = await admin(req), b = await body(req);
    const r = await db.rpc("obv_admin_access_set", { p_actor: s.id, p_owner_id: ownerId(), p_user: +P.uid, p_access: String(b.access || "") });
    accessSeen.delete(+P.uid); send(res, 200, r);
  },
  // { user: "<osu name or id>" }: let someone in before they ask (looked up on osu!)
  "POST admin/access": async (req, res) => {
    const s = await admin(req), b = await body(req), u = await lookupOsu(b.user);
    await db.rpc("obv_admin_user_ensure", { p_id: u.id, p_username: u.username || String(u.id), p_avatar: u.avatar_url || null });
    const r = await db.rpc("obv_admin_access_set", { p_actor: s.id, p_owner_id: ownerId(), p_user: u.id, p_access: "approved" });
    accessSeen.delete(u.id); send(res, 200, { ...r, username: u.username });
  },
  // { status?, reason?, role?, max_projects?, max_project_bytes?, retention_days?, note? } (null limit = site default)
  "POST admin/users/:uid": async (req, res, q, P) => {
    const s = await admin(req), b = await body(req, 20000), patch = {};
    for (const k of ["status", "reason", "role", "max_projects", "max_project_bytes", "retention_days", "note"]) if (k in b) patch[k] = b[k];
    send(res, 200, { user: await userUpdate(s, +P.uid, patch) });
  },
  "POST admin/users/:uid/status": async (req, res, q, P) => {
    const s = await admin(req), b = await body(req);
    const u = await userUpdate(s, +P.uid, { status: String(b.status || ""), reason: b.reason ? String(b.reason).slice(0, 300) : null });
    send(res, 200, { id: u.id, status: u.status });
  },
  "GET admin/projects": async (req, res, q) => {
    await admin(req);
    send(res, 200, await db.rpc("obv_admin_projects", { p_q: String(q.get("q") || "").slice(0, 60), p_status: String(q.get("status") || ""), p_limit: int(q.get("limit") || 30, 1, 100, 30),
      p_offset: int(q.get("offset") || 0, 0, 1e6, 0), p_sort: ["size", "expires", "updated"].includes(q.get("sort")) ? q.get("sort") : "", p_owner: int(q.get("owner"), 1, 1e12, null) }));
  },
  "GET admin/projects/:id": async (req, res, q, P) => { await admin(req); send(res, 200, { project: await db.rpc("obv_admin_project_get", { p_project: P.id }) }); },
  "POST admin/projects/:id/expiry": async (req, res, q, P) => {
    const s = await admin(req), b = await body(req), d = new Date(b.expiresAt);
    if (isNaN(d)) throw new ApiError("bad_request", 400, { field: "expiresAt" });
    send(res, 200, await db.rpc("obv_admin_project_expiry", { p_actor: s.id, p_project: P.id, p_expires_at: d.toISOString() }));
  },
  "DELETE admin/projects/:id": async (req, res, q, P) => {
    const s = await admin(req);
    await db.rpc("obv_admin_project_delete", { p_actor: s.id, p_project: P.id });
    let r = null, err = null; try { r = await purgeProject(P.id); } catch (e) { err = e.code || "error"; }
    await db.rpc("obv_audit_add", { p_actor: s.id, p_action: r && r.done ? "project.purged_by_admin" : "project.purge_pending", p_type: "project", p_id: P.id, p_detail: { error: err, remaining: r && r.remaining } });
    send(res, 200, { deleted: true, files_removed: !!(r && r.done), remaining: r && r.remaining || 0, error: err });
  },
  // moving the database to Cloudflare D1 (api/_lib/d1copy.js): where it is now, and the one-time copy (site owner only)
  "GET admin/database": async (req, res) => {
    await admin(req, true);
    const d1 = db.D1.target, { d1Counts } = require("./_lib/d1copy");
    send(res, 200, { backend: db.d1on() ? "d1" : "supabase", d1_bound: !!d1, r2: db.r2on(), d1_rows: d1 ? await d1Counts(d1) : null });
  },
  "POST admin/database/copy": async (req, res) => {
    const s = await admin(req, true);
    if (db.d1on()) throw new ApiError("already_on_d1", 409); // (the copy would replace newer data with Supabase's)
    if (!db.D1.target) throw new ApiError("d1_not_bound", 409);
    const r = await require("./_lib/d1copy").copyToD1(db.pgRpc, db.D1.target, s.id);
    perms.at = 0; gate.at = 0;
    send(res, 200, r);
  },
  "GET admin/settings": async (req, res) => { await admin(req); send(res, 200, { ...await db.rpc("obv_admin_settings", {}), turn_configured: turn.configured() }); },
  "POST admin/settings": async (req, res) => { const s = await admin(req, true), b = await body(req); perms.at = 0; gate.at = 0; send(res, 200, await db.rpc("obv_admin_settings_set", { p_actor: s.id, p_values: b.values || {} })); },
  "GET admin/admins": async (req, res) => { await admin(req); send(res, 200, { admins: await db.rpc("obv_admin_admins", { p_owner_id: ownerId() }), owner_id: ownerId() }); },
  // { user: "<osu name or id>" }: looked up on osu!, gets an account row if they never logged in, then made an admin
  "POST admin/admins": async (req, res) => {
    const s = await admin(req, true), b = await body(req), u = await lookupOsu(b.user);
    await db.rpc("obv_admin_user_ensure", { p_id: u.id, p_username: u.username || String(u.id), p_avatar: u.avatar_url || null });
    await userUpdate(s, u.id, { role: "admin" });
    send(res, 200, { admins: await db.rpc("obv_admin_admins", { p_owner_id: ownerId() }) });
  },
  "DELETE admin/admins/:uid": async (req, res, q, P) => {
    const s = await admin(req, true); await userUpdate(s, +P.uid, { role: "user" });
    send(res, 200, { admins: await db.rpc("obv_admin_admins", { p_owner_id: ownerId() }) });
  },
  "GET admin/cleanup": async (req, res) => { await admin(req); send(res, 200, await db.rpc("obv_admin_cleanup_status", {})); },
  "POST admin/cleanup": async (req, res) => {
    const s = await admin(req), out = await runCleanup(40000);
    await db.rpc("obv_audit_add", { p_actor: s.id, p_action: "cleanup.run", p_type: "job", p_id: "cleanup", p_detail: out });
    send(res, 200, out);
  },
  // ----- error reports: the site broke in someone's browser (no login needed; nothing about the person is kept) -----
  "POST errors": async (req, res) => {
    if (!db.configured()) return send(res, 200, { ok: false });
    const b = await body(req, 8000), str = (v, n) => typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
    const message = str(b.message, 300); if (!message) throw new ApiError("bad_request", 400);
    try { await db.rpc("obv_error_report", { p_message: message, p_source: str(b.source, 300), p_stack: str(b.stack, 2000), p_page: str(b.page, 60), p_version: str(b.version, 20), p_browser: str(b.browser, 60) }); }
    catch { return send(res, 200, { ok: false }); } // (before the migration has run)
    send(res, 200, { ok: true });
  },
  // "Report a problem": what the person wrote, and their osu! name only if they asked to add it
  "POST feedback": async (req, res) => {
    if (!db.configured()) throw new ApiError("not_configured", 503);
    const b = await body(req, 8000), str = (v, n) => typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
    const message = str(b.message, 1000); if (!message || message.length < 3) throw new ApiError("bad_request", 400, { field: "message" });
    const s = b.with_name ? session(req) : null;
    await db.rpc("obv_feedback", { p_message: message, p_page: str(b.page, 60), p_version: str(b.version, 20), p_browser: str(b.browser, 60), p_reporter: s ? `${String(s.username || "").slice(0, 40)} (#${s.id})` : null });
    send(res, 200, { ok: true });
  },
  "GET admin/errors": async (req, res, q) => {
    await admin(req);
    send(res, 200, await db.rpc("obv_admin_errors", { p_resolved: q.get("resolved") === "1", p_limit: int(q.get("limit") || 50, 1, 100, 50), p_offset: int(q.get("offset") || 0, 0, 1e6, 0), p_kind: q.get("kind") === "report" ? "report" : "error" }));
  },
  "POST admin/errors": async (req, res) => {
    const s = await admin(req), b = await body(req, 2000);
    if (!b.clear && !/^[0-9a-f]{32}$/.test(String(b.sig || ""))) throw new ApiError("bad_request", 400);
    send(res, 200, await db.rpc("obv_admin_error_set", { p_actor: s.id, p_sig: b.sig || null, p_resolved: !!b.resolved, p_clear: !!b.clear }));
  },
  "GET admin/audit": async (req, res, q) => {
    await admin(req);
    send(res, 200, await db.rpc("obv_admin_audit", { p_limit: int(q.get("limit") || 50, 1, 200, 50), p_offset: int(q.get("offset") || 0, 0, 1e7, 0),
      p_action: /^[a-z._]{0,40}$/.test(q.get("action") || "") ? q.get("action") || "" : "", p_q: String(q.get("q") || "").slice(0, 60) }));
  },
  "GET admin/changelog": async (req, res) => { await admin(req); send(res, 200, { entries: await db.rpc("obv_changelog_admin", {}) }); },
  "POST admin/changelog": async (req, res) => {
    const s = await admin(req), b = await body(req, 60000);
    if (b.id != null && !UUID.test(String(b.id))) throw new ApiError("bad_request", 400);
    const pub = b.publishedAt ? new Date(b.publishedAt) : null;
    if (pub && isNaN(pub)) throw new ApiError("bad_request", 400, { field: "publishedAt" });
    send(res, 200, { entry: await db.rpc("obv_changelog_save", { p_actor: s.id, p_id: b.id || null, p_title: String(b.title || ""), p_version: String(b.versionLabel || ""),
      p_content: String(b.content || ""), p_status: String(b.status || "draft"), p_published_at: pub ? pub.toISOString() : null, p_base_updated_at: b.baseUpdatedAt || null }) });
  },
  "DELETE admin/changelog/:id": async (req, res, q, P) => { const s = await admin(req); send(res, 200, await db.rpc("obv_changelog_delete", { p_actor: s.id, p_id: P.id })); },
  "POST admin/changelog/:id/move": async (req, res, q, P) => { const s = await admin(req), b = await body(req); send(res, 200, { entry: await db.rpc("obv_changelog_move", { p_actor: s.id, p_id: P.id, p_dir: b.dir > 0 ? 1 : -1 }) }); },
};

// "GET projects/:id" -> matcher
const table = Object.entries(routes).map(([k, fn]) => { const [method, path] = k.split(" "); return { method, parts: path.split("/"), fn }; });
function match(method, route) {
  const segs = route.split("/"); let methodMiss = false;
  for (const r of table) {
    if (r.parts.length !== segs.length) continue;
    const P = {}; let ok = true;
    for (let i = 0; i < segs.length && ok; i++) {
      const p = r.parts[i];
      if (p === ":id") { ok = UUID.test(segs[i]); P.id = segs[i]; }
      else if (p === ":uid") { ok = /^\d{1,12}$/.test(segs[i]); P.uid = segs[i]; }
      else ok = p === segs[i];
    }
    if (!ok) continue;
    if (r.method !== method) { methodMiss = true; continue; }
    return { fn: r.fn, P, key: r.parts.join("/") };
  }
  return { miss: methodMiss ? 405 : 404 };
}
function routeOf(req) {
  const q = query(req);
  let r = q.get("route");
  if (r == null) r = new URL(req.url, "http://x").pathname.replace(/^\/api\/v1\/?/, "");
  return String(r).replace(/^\/+|\/+$/g, "");
}
// requests that anyone can make without logging in (osu! data, share links): a per-IP budget per minute, so nobody can
// use this site to flood osu! (and get its app key blocked) or guess share links. Per server instance, best effort.
const RATE = { osu: 90, link: 30, live: 60, err: 20, fb: 5 }, hits = new Map();
function limited(req, route) {
  const kind = route.startsWith("osu/") ? "osu" : route.startsWith("link/") || route === "invite" || route === "invite/accept" || route === "invite/accept-google" || route === "access/request-google" ? "link" : route.startsWith("live/") ? "live" : route === "errors" ? "err" : route === "feedback" ? "fb" : null; if (!kind) return false;
  const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
  const key = kind + ":" + ip, now = Date.now(), e = hits.get(key);
  if (!e || now - e.at > 60000) { hits.set(key, { at: now, n: 1 }); if (hits.size > 20000) hits.clear(); return false; }
  return ++e.n > RATE[kind];
}
async function handler(req, res) {
  const route = routeOf(req), q = query(req), m = match(req.method, route);
  if (!m.fn) return send(res, m.miss, { error: m.miss === 405 ? "method_not_allowed" : "not_found" });
  if (limited(req, route)) { res.setHeader("Retry-After", "60"); return send(res, 429, { error: "too_many_requests" }); }
  if (req.method !== "GET" && !sameOrigin(req)) return send(res, 403, { error: "bad_origin" });
  try {
    // invite-only: gated routes need an approved account, and their answers must not sit in a shared (CDN) cache
    if (!OPEN.has(req.method + " " + m.key) && !m.key.startsWith("admin/") && await requireAccess(req, m.key)) res.privateOnly = true;
    await m.fn(req, res, q, m.P);
  }
  catch (e) {
    if (e instanceof ApiError || (e && e.status && e.code)) return send(res, e.status, { error: e.code, detail: e.detail || undefined });
    console.error("api", route.replace(/[0-9a-f-]{36}/g, ":id"), e && e.message);
    send(res, 500, { error: "server_error" });
  }
}
module.exports = handler;
