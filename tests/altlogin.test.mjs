// Backup login (Google) end to end: the real handlers (api/_lib/alt.js, api/v1.js) + real SQL (PGlite), with Google's
// token endpoint stood in for.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startSupabaseEmu } from "./emu/supabase-emu.mjs";
import { startApi } from "./lib/server.mjs";
let SRV;
import { startOsuMock } from "./emu/osu-mock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const HOST = "viewer.test", A = 1001, B = 1003;
let emu, osuSrv, auth, alt, v1, srv, base, realFetch;
const b64u = s => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = claims => b64u(JSON.stringify({ alg: "none" })) + "." + b64u(JSON.stringify(claims)) + ".sig";
const answer = { google: null }; // what the stand-in token endpoint returns next
const OSU_ME = { id: 4242, username: "TestMapper", avatar_url: "https://a.ppy.sh/4242", country_code: "TH" };
let osuMe = OSU_ME; // who osu! says logged in (the stand-in /me)

before(async () => {
  emu = await startSupabaseEmu(); osuSrv = await startOsuMock(54333);
  Object.assign(process.env, { SUPABASE_URL: emu.url, SUPABASE_SECRET_KEY: emu.key, OSU_CLIENT_ID: "1", OSU_CLIENT_SECRET: "test-only-secret", OSU_API_BASE: "http://127.0.0.1:54333",
    GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret",
    ALLOWED_HOSTS: "other.example, " + HOST }); // (the hosts the OAuth redirect URIs may be built from: auth.js siteUrl)
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === "https://osu.ppy.sh/oauth/token") return new Response(JSON.stringify({ access_token: "osu-user-token" }), { headers: { "content-type": "application/json" } });
    if (u === "https://osu.ppy.sh/api/v2/me") return new Response(JSON.stringify(osuMe), { headers: { "content-type": "application/json" } });
    if (u === "https://oauth2.googleapis.com/token") {
      const a = answer.google; return new Response(JSON.stringify(a.body), { status: a.status || 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, opts);
  };
  auth = require(join(root, "api/_lib/auth.js")); alt = require(join(root, "api/_lib/alt.js")); v1 = require(join(root, "api/v1.js"));
  SRV = await startApi(root, emu); srv = SRV.srv; base = SRV.base;
  for (const id of [A, B]) await emu.db.query("insert into obv.users (osu_id, username, avatar_url, country) values ($1, $2, null, 'TH') on conflict do nothing", [id, "user" + id]);
});
after(async () => { globalThis.fetch = realFetch; srv.close(); osuSrv.close(); await emu.close(); });

const c = () => auth.cfg({ headers: { host: HOST } });
// Set-Cookie values -> out.cookies by short name, from the __Host- cookies only (what the server must write: auth.js
// cookie), and out.raw by the full name (the old names are only ever cleared)
function takeCookies(out, list) {
  for (const x of [].concat(list)) { const [nv] = x.split(";"), i = nv.indexOf("="), k = nv.slice(0, i), v = decodeURIComponent(nv.slice(i + 1)); (out.raw ||= {})[k] = v; if (k.startsWith("__Host-")) out.cookies[k.slice(7)] = v; }
}
const sessionCookie = id => "__Host-obv_s=" + encodeURIComponent(auth.sign({ id, username: "user" + id, avatar: "", country: "TH", kind: "session", exp: Date.now() + 36e5 }, c()));
// call a handler like the server does; -> { status, location, cookies: { name: value } }
async function call(p, qs, cookie) {
  const out = { status: 0, location: "", cookies: {} };
  const req = { method: "GET", url: `/api/auth/${p}?${qs}`, headers: { host: HOST, cookie: cookie || "" } };
  const res = { set statusCode(v) { out.status = v; }, get statusCode() { return out.status; }, setHeader(k, v) {
    if (k.toLowerCase() === "location") out.location = v;
    if (k.toLowerCase() === "set-cookie") takeCookies(out, v);
  }, end() {} };
  await alt.handler(p)(req, res); return out;
}
// GET /api/auth/me with a session cookie -> its JSON
async function authMe(sess) {
  let body = ""; const req = { method: "GET", url: "/api/auth/me", headers: { host: HOST, cookie: "__Host-obv_s=" + encodeURIComponent(sess) } };
  await require(join(root, "api/auth/me.js"))(req, { statusCode: 0, setHeader() {}, end(b) { body = b; } }); return JSON.parse(body);
}
// start, then come back with a code: the stand-in endpoint returns an id_token for `sub` (made with `tweak`)
async function roundTrip(p, { mode = "login", as, sub, tweak = x => x, status } = {}) {
  const start = await call(p, `mode=${mode}&next=%2Fdone`, as ? sessionCookie(as) : "");
  const st = auth.unsign(start.cookies.obv_alt, c());
  const claims = tweak({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, sub, nonce: st && st.nonce, exp: Math.floor(Date.now() / 1000) + 600 });
  answer[p] = { status, body: status ? { error: "invalid_grant" } : { id_token: idToken(claims) } };
  const ck = "__Host-obv_alt=" + encodeURIComponent(start.cookies.obv_alt) + (as ? "; " + sessionCookie(as) : "");
  return { start, back: await call(p, `code=abc&state=${st && st.state}`, ck) };
}
const why = r => new URL(r.back.location, "http://x").searchParams.get("login");
// the signed note of the removed flow (a Google account that typed its osu! name): must be ignored
const gpFor = sub => auth.sign({ kind: "gpend", p: "google", sub, exp: Date.now() + 18e5 }, c());

test("start: goes to the provider with our client ID, callback URL, state and nonce, no scopes beyond openid", async () => {
  const g = await call("google", "mode=login&next=%2Fx");
  const u = new URL(g.location);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("client_id"), process.env.GOOGLE_CLIENT_ID);
  assert.equal(u.searchParams.get("redirect_uri"), `https://${HOST}/api/auth/google`);
  assert.equal(u.searchParams.get("scope"), "openid");
  const st = auth.unsign(g.cookies.obv_alt, c());
  assert.equal(u.searchParams.get("state"), st.state); assert.equal(u.searchParams.get("nonce"), st.nonce);
  assert.deepEqual(alt.configured(), { google: true });
});

test("redirect URIs only use an allowed host: SITE_URL first, else ALLOWED_HOSTS / localhost / this project's deployments", async () => {
  const uri = async headers => {
    const res = { headers: {}, set statusCode(v) {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end() {} };
    await alt.handler("google")({ method: "GET", url: "/api/auth/google?mode=login", headers }, res);
    return new URL(res.headers.location).searchParams.get("redirect_uri");
  };
  const DEF = "https://osu-beatmap-viewer.lacrymira.workers.dev";
  assert.equal(await uri({ host: "evil.example" }), DEF + "/api/auth/google", "an unknown host: the default address");
  assert.equal(await uri({ host: HOST, "x-forwarded-host": "evil.example" }), `https://${HOST}/api/auth/google`, "a forged X-Forwarded-Host is skipped");
  assert.equal(await uri({ host: "localhost:5174" }), "https://localhost:5174/api/auth/google");
  assert.equal(await uri({ host: "abc123-osu-beatmap-viewer.someone.workers.dev" }), "https://abc123-osu-beatmap-viewer.someone.workers.dev/api/auth/google", "a preview");
  assert.equal(await uri({ host: "osu-beatmap-viewer.evil.example" }), DEF + "/api/auth/google");
  assert.equal(await uri({ host: "OTHER.example" }), "https://other.example/api/auth/google");
  assert.equal(auth.cfg({ headers: { host: "evil.example" } }).redirect, DEF + "/api/auth/callback", "the osu! login too");
  const keep = process.env.SITE_URL; process.env.SITE_URL = "https://viewer.example.org/";
  try {
    assert.equal(await uri({ host: HOST }), "https://viewer.example.org/api/auth/google", "SITE_URL wins");
    assert.equal(auth.cfg({ headers: { host: HOST } }).redirect, "https://viewer.example.org/api/auth/callback");
  } finally { if (keep === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = keep; }
});

test("an account nobody linked gets its own account without osu! (Google only); linking needs an osu! login", async () => {
  const r0 = await roundTrip("google", { sub: "g-0" });
  assert.equal(why(r0), "ok");
  const s0 = auth.unsign(r0.back.cookies.obv_s, c()); assert.equal(s0.gonly, true); assert.ok(s0.id >= 1e12); assert.equal(s0.username, "Google user"); assert.equal(s0.avatar, "");
  assert.equal(auth.unsign((await roundTrip("google", { sub: "g-0" })).back.cookies.obv_s, c()).id, s0.id, "the same account next time");
  const r = await call("google", "mode=link&next=%2Fdone"); // not logged in
  assert.equal(new URL(r.location, "http://x").searchParams.get("login"), "link_login");
});

test("link Google, then log in with it as the same osu! account; the list and unlink work", async () => {
  assert.equal(why(await roundTrip("google", { mode: "link", as: A, sub: "g-1" })), "linked_google");
  const r = await roundTrip("google", { sub: "g-1" });
  assert.equal(why(r), "ok");
  const s = auth.unsign(r.back.cookies.obv_s, c());
  assert.equal(s.id, A); assert.equal(s.username, "user" + A); assert.equal(s.via, "google"); assert.equal(s.kind, "session");
  assert.equal(r.back.cookies.obv_alt, "", "the state cookie is cleared");
  const list = await (await realFetch(base + "/api/v1/me/logins", { headers: { cookie: sessionCookie(A) } })).json();
  assert.ok(list.linked.google && list.linked.google.last_used_at); assert.deepEqual(Object.keys(list.linked), ["google"]);
  // someone else can't take the same Google account
  assert.equal(why(await roundTrip("google", { mode: "link", as: B, sub: "g-1" })), "linked_elsewhere");
  // linking another Google account replaces the first
  assert.equal(why(await roundTrip("google", { mode: "link", as: A, sub: "g-2" })), "linked_google");
  assert.equal(auth.unsign((await roundTrip("google", { sub: "g-1" })).back.cookies.obv_s, c()).gonly, true, "g-1 isn't A's any more: its own account");
  const del = await realFetch(base + "/api/v1/me/logins/google", { method: "DELETE", headers: { cookie: sessionCookie(A), "content-type": "application/json" } });
  assert.equal(del.status, 200); assert.equal((await del.json()).linked.google, null);
  assert.equal(auth.unsign((await roundTrip("google", { sub: "g-2" })).back.cookies.obv_s, c()).gonly, true);
});

test("refused: wrong audience, wrong nonce, expired token, provider error, a state that doesn't match", async () => {
  assert.equal(why(await roundTrip("google", { mode: "link", as: A, sub: "g-3" })), "linked_google");
  assert.equal(why(await roundTrip("google", { sub: "g-3", tweak: x => ({ ...x, aud: "someone-else" }) })), "alt_error");
  assert.equal(why(await roundTrip("google", { sub: "g-3", tweak: x => ({ ...x, nonce: "nope" }) })), "alt_error");
  assert.equal(why(await roundTrip("google", { sub: "g-3", tweak: x => ({ ...x, exp: 1000 }) })), "alt_error");
  assert.equal(why(await roundTrip("google", { sub: "g-3", status: 400 })), "alt_error");
  const start = await call("google", "mode=login");
  const r = await call("google", "code=abc&state=forged", "__Host-obv_alt=" + encodeURIComponent(start.cookies.obv_alt));
  assert.equal(new URL(r.location, "http://x").searchParams.get("login"), "expired");
  assert.equal(new URL((await call("google", "error=access_denied&state=x")).location, "http://x").searchParams.get("login"), "cancelled");
});

test("not set up: the buttons' start says so instead of going to the provider", async () => {
  const keep = process.env.GOOGLE_CLIENT_SECRET; delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    const r = await call("google", "mode=login&next=%2Fdone");
    assert.equal(new URL(r.location, "http://x").searchParams.get("login"), "alt_off");
    assert.equal(alt.configured().google, false);
  } finally { process.env.GOOGLE_CLIENT_SECRET = keep; }
});

// the API as the browser calls it; cookies: "a=b; c=d" -> { status, body, cookies }
async function v1call(method, route, cookie, body) {
  const r = await realFetch(base + "/api/v1/" + route, { method, headers: { cookie, ...(body ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const o = { cookies: {} }; takeCookies(o, r.headers.getSetCookie());
  return { status: r.status, body: await r.json(), cookies: o.cookies, raw: o.raw || {} };
}
const ck = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => (/^obv_/.test(k) ? "__Host-" : "") + k + "=" + encodeURIComponent(v)).join("; "); // (legacy: the old names as they are)
const legacyCk = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("; ");
async function osuLogin(cookieStr) { // the osu! login callback (osu! itself stood in for)
  const cb = require(join(root, "api/auth/callback.js")), st = auth.sign({ state: "s9", next: "/", exp: Date.now() + 6e5 }, c());
  const out = { cookies: {} };
  await cb({ method: "GET", url: "/api/auth/callback?code=x&state=s9", headers: { host: HOST, cookie: ck({ obv_st: st }) + (cookieStr ? "; " + cookieStr : "") } },
    { set statusCode(v) {}, setHeader(k, v) { if (k.toLowerCase() === "location") out.location = v; if (k.toLowerCase() === "set-cookie") takeCookies(out, v); }, end() {} });
  return out;
}

// The older "signed in with Google, type your osu! name" routes (access/request-google, invite/accept-google) were never
// reachable (nothing set their obv_gp cookie) and would have given a session for any name typed: removed.
test("the removed Google 'type your osu! name' routes stay gone; an obv_gp cookie means nothing", async () => {
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  const gp = gpFor("g-new");
  assert.equal((await v1call("GET", "me", ck({ obv_gp: gp }))).body.google_pending, undefined);
  for (const [route, body] of [["access/request-google", { osu: "TestMapper" }], ["invite/accept-google", { code: "GoogleInv1", osu: "TestMapper" }]]) {
    const r = await v1call("POST", route, ck({ obv_gp: gp }), body);
    assert.equal(r.status, 404, route); assert.equal(r.cookies.obv_s, undefined, route + ": no session");
  }
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
});

test("a Google link not confirmed by the osu! account (older data): its sessions end once that osu! account logs in", async () => {
  await emu.db.query("insert into obv.users (osu_id, username) values (4242, 'TestMapper') on conflict do nothing");
  await emu.db.query("insert into obv.user_logins (provider, subject, osu_id, verified) values ('google', $1, 4242, $2)", ["g-old", false]);
  const r = await roundTrip("google", { sub: "g-old" }), sc = r.back.cookies.obv_s, s = auth.unsign(sc, c());
  assert.equal(why(r), "ok"); assert.equal(s.id, 4242); assert.equal(s.unverified, true);
  // not confirmed by the osu! account: no ticket (it would prove "I'm TestMapper" to people in live sessions)
  const meRes = await authMe(sc); assert.equal(meRes.user.id, 4242); assert.equal(meRes.user.unverified, true); assert.equal(meRes.ticket, null);
  assert.equal((await v1call("GET", "me", ck({ obv_s: sc }))).body.user.id, 4242);
  // an osu! login by the real owner removes the unconfirmed link, and every session it gave is logged out (checked on use)
  await osuLogin("");
  assert.equal((await emu.db.query("select 1 from obv.user_logins where osu_id = 4242")).rows.length, 0);
  const gone = await v1call("GET", "me", ck({ obv_s: sc }));
  assert.equal(gone.body.user, null); assert.equal(gone.cookies.obv_s, "");
  assert.equal((await v1call("GET", "projects", ck({ obv_s: sc }))).status, 401);
  assert.equal(auth.unsign((await roundTrip("google", { sub: "g-old" })).back.cookies.obv_s, c()).gonly, true);
  await emu.db.query("delete from obv.user_logins where subject = 'g-old'");
});

test("Google only: in without osu!, follows invite-only, no live sessions; an osu! login offers to take it over, only from that login", async () => {
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  await emu.db.query("delete from obv.user_logins where osu_id = 4242");
  const r = await roundTrip("google", { sub: "g-only" }), sc = r.back.cookies.obv_s, s = auth.unsign(sc, c());
  assert.equal(why(r), "ok"); assert.equal(s.gonly, true);
  let me = null; // (the handler as the server runs it)
  await require(join(root, "api/auth/me.js"))({ method: "GET", url: "/api/auth/me", headers: { host: HOST, cookie: ck({ obv_s: sc }) } },
    { statusCode: 0, setHeader() {}, end(t) { me = JSON.parse(t); } });
  assert.equal(me.user.google_only, true); assert.equal(me.ticket, null, "no live-session ticket");
  assert.equal((await v1call("GET", "me", ck({ obv_s: sc }))).body.access, "none", "invite-only: not in yet");
  // an invite (from an admin) lets it in
  await emu.db.query("update obv.users set access = 'approved', role = 'admin' where osu_id = $1", [A]);
  await emu.db.query("insert into obv.invite_links (code, created_by, max_uses, uses, created_at) values ('GoogleOnly', $1, 5, 0, now())", [A]);
  const acc = await v1call("POST", "invite/accept", ck({ obv_s: sc }), { code: "GoogleOnly" });
  assert.equal(acc.status, 200, JSON.stringify(acc.body)); assert.equal(acc.body.access, "approved");
  const proj = await v1call("POST", "projects", ck({ obv_s: sc }), { clientKey: "gonly-proj-1", title: "Mine" });
  assert.equal(proj.status, 201, JSON.stringify(proj.body));
  // live sessions need osu!
  const live = await v1call("POST", "live/start", ck({ obv_s: sc }), { code: "abc123" });
  assert.equal(live.status, 403); assert.equal(live.body.error, "osu_required");
  // logging in with osu! (TestMapper, 4242) in this browser moves nothing by itself: a note (obv_gm, 10 minutes) bound to
  // that new login, and the page asks
  const done = await osuLogin(ck({ obv_s: sc }));
  assert.equal(new URL(done.location, "http://x").searchParams.get("login"), "ok");
  const os = done.cookies.obv_s, osess = auth.unsign(os, c()), gmTok = done.cookies.obv_gm, gm = auth.unsign(gmTok, c());
  assert.equal(osess.id, 4242); assert.match(osess.sid, /^[0-9a-f]{24}$/);
  assert.deepEqual([gm.kind, gm.from, gm.to, gm.sid], ["gmerge", s.id, 4242, osess.sid]);
  assert.ok(gm.exp - Date.now() <= 6e5 && gm.exp - Date.now() > 5e5, "10 minutes");
  assert.equal(done.raw.obv_s, "", "the old cookie name is cleared"); assert.equal(done.raw.obv_gm, "");
  assert.equal((await emu.db.query("select owner_id from obv.projects where id = $1", [proj.body.project.id])).rows[0].owner_id, s.id, "nothing moved yet");
  assert.equal((await emu.db.query("select 1 from obv.user_logins where osu_id = 4242")).rows.length, 0, "the Google login isn't the osu! account's");
  assert.notEqual(((await emu.db.query("select access from obv.users where osu_id = 4242")).rows[0] || {}).access, "approved");
  assert.equal(auth.unsign((await roundTrip("google", { sub: "g-only" })).back.cookies.obv_s, c()).gonly, true, "Google still opens the Google-only account");
  // GET me tells that login (only) what would move
  const both = ck({ obv_s: os, obv_gm: gmTok });
  const mp = (await v1call("GET", "me", both)).body.merge_pending;
  assert.equal(mp.projects, 1); assert.ok(mp.since);
  const other = auth.sign({ id: 4242, username: "TestMapper", avatar: "", country: "TH", kind: "session", sid: "f".repeat(24), iat: Date.now(), exp: Date.now() + 36e5 }, c());
  assert.equal((await v1call("GET", "me", ck({ obv_s: other, obv_gm: gmTok }))).body.merge_pending, undefined, "another login of the same account");
  assert.equal((await v1call("GET", "me", ck({ obv_s: os }))).body.merge_pending, undefined, "no note");
  // refused: no note; the note with another login (same account, or another account); a cross-site request
  const none = await v1call("POST", "me/merge-google", ck({ obv_s: os }), {});
  assert.equal(none.status, 400); assert.equal(none.body.detail.reason, "no_merge_pending");
  for (const who of [ck({ obv_s: other, obv_gm: gmTok }), sessionCookie(B) + "; " + ck({ obv_gm: gmTok })]) {
    const x = await v1call("POST", "me/merge-google", who, {});
    assert.equal(x.status, 403, JSON.stringify(x.body)); assert.equal(x.body.error, "forbidden");
  }
  for (const h of [{ "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }]) {
    const x = await realFetch(base + "/api/v1/me/merge-google", { method: "POST", headers: { cookie: both, "content-type": "application/json", ...h }, body: "{}" });
    assert.equal(x.status, 403); assert.equal((await x.json()).error, "bad_origin");
  }
  assert.equal((await emu.db.query("select owner_id from obv.projects where id = $1", [proj.body.project.id])).rows[0].owner_id, s.id, "still nothing moved");
  // confirmed by that login: access, the project and the Google login move there
  const ok = await v1call("POST", "me/merge-google", both, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.deepEqual(ok.body, { merged: true, projects: 1 }); assert.equal(ok.cookies.obv_gm, "", "the note is cleared");
  const u = (await emu.db.query("select access from obv.users where osu_id = 4242")).rows[0]; assert.equal(u.access, "approved");
  assert.equal((await emu.db.query("select owner_id from obv.projects where id = $1", [proj.body.project.id])).rows[0].owner_id, 4242);
  assert.equal((await emu.db.query("select 1 from obv.users where osu_id = $1", [s.id])).rows.length, 0, "the Google-only account is gone");
  const g = await roundTrip("google", { sub: "g-only" }), gs = auth.unsign(g.back.cookies.obv_s, c());
  assert.equal(gs.id, 4242); assert.equal(gs.gonly, undefined, "Google now opens the osu! account");
  assert.ok([401, 403].includes((await v1call("GET", "projects", ck({ obv_s: sc }))).status), "the old Google-only session has no access any more");
  assert.equal((await v1call("POST", "me/merge-google", both, {})).body.merged, false, "the same note again: nothing left to move");
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
});

// a Google-only login (new, approved, with a project) and an osu! login in the same browser -> { gs: its session, gid, pid, os, gmTok }
async function gonlyThenOsu(sub, osu = OSU_ME, before) {
  const gs = (await roundTrip("google", { sub })).back.cookies.obv_s, gid = auth.unsign(gs, c()).id;
  await emu.db.query("update obv.users set access = 'approved' where osu_id = $1", [gid]); // (let in: an invite or an admin)
  const pr = await v1call("POST", "projects", ck({ obv_s: gs }), { clientKey: "gonly-proj-" + sub, title: "Mine" }); assert.equal(pr.status, 201, JSON.stringify(pr.body)); const pid = pr.body.project.id;
  if (before) await before(gid);
  osuMe = osu; const done = await osuLogin(ck({ obv_s: gs })); osuMe = OSU_ME;
  return { gs, gid, pid, os: done.cookies.obv_s, gmTok: done.cookies.obv_gm };
}
const ownerOf = async pid => (await emu.db.query("select owner_id from obv.projects where id = $1", [pid])).rows[0].owner_id;

test("Google-only merge: 'Keep separate' moves nothing and the note is gone", async () => {
  const x = await gonlyThenOsu("g-skip");
  const sk = await v1call("POST", "me/merge-google/skip", ck({ obv_s: x.os, obv_gm: x.gmTok }), {});
  assert.equal(sk.status, 200); assert.equal(sk.cookies.obv_gm, "");
  assert.equal((await v1call("POST", "me/merge-google", ck({ obv_s: x.os }), {})).status, 400, "(the browser no longer sends the note)");
  assert.equal(await ownerOf(x.pid), x.gid);
  assert.equal(auth.unsign((await roundTrip("google", { sub: "g-skip" })).back.cookies.obv_s, c()).id, x.gid, "Google still opens its own account");
});

test("Google-only merge never lifts a denial: a denied osu! account stays denied; a denied Google-only account can't move", async () => {
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  // the osu! account was denied; the Google-only account got in (an invite, an approval): after the merge, still denied
  const D = { id: 5151, username: "Denied", avatar_url: "", country_code: "TH" };
  await emu.db.query("insert into obv.users (osu_id, username, access) values (5151, 'Denied', 'denied') on conflict do nothing");
  const x = await gonlyThenOsu("g-den", D);
  const m = await v1call("POST", "me/merge-google", ck({ obv_s: x.os, obv_gm: x.gmTok }), {});
  assert.equal(m.status, 200, JSON.stringify(m.body)); assert.equal(m.body.merged, true);
  assert.equal((await emu.db.query("select access from obv.users where osu_id = 5151")).rows[0].access, "denied", "still denied");
  assert.equal((await v1call("GET", "me", ck({ obv_s: x.os }))).body.access, "denied");
  assert.equal((await v1call("GET", "projects", ck({ obv_s: x.os }))).status, 403, "and still kept out");
  // a denied Google-only account can't escape into a fresh osu! account
  const F = { id: 5252, username: "Fresh", avatar_url: "", country_code: "TH" };
  const y = await gonlyThenOsu("g-bad", F, gid => emu.db.query("update obv.users set access = 'denied' where osu_id = $1", [gid]));
  assert.equal((await v1call("GET", "me", ck({ obv_s: y.os, obv_gm: y.gmTok }))).body.merge_pending, undefined, "not even offered");
  const r = await v1call("POST", "me/merge-google", ck({ obv_s: y.os, obv_gm: y.gmTok }), {});
  assert.equal(r.status, 403); assert.equal(r.body.detail.reason, "source_denied"); assert.equal(r.cookies.obv_gm, "", "asked once");
  assert.equal(await ownerOf(y.pid), y.gid); assert.equal((await emu.db.query("select access from obv.users where osu_id = $1", [y.gid])).rows[0].access, "denied");
  assert.notEqual(((await emu.db.query("select access from obv.users where osu_id = 5252")).rows[0] || {}).access, "denied");
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
});

test("cookies: __Host- names are written; the __Host- one and the first of a name win; a legacy obv_s still works and is written again", async () => {
  const t = id => auth.sign({ id, username: "user" + id, avatar: "", country: "TH", kind: "session", iat: Date.now(), exp: Date.now() + 36e5 }, c());
  const parse = h => auth.cookies({ headers: { cookie: h } });
  let p = parse("obv_s=legacy; __Host-obv_s=new; __Host-obv_s=later");
  assert.equal(p.obv_s, "new"); assert.equal(p.legacy.has("obv_s"), false);
  p = parse("obv_s=first; obv_s=second; other=x"); assert.equal(p.obv_s, "first"); assert.equal(p.legacy.has("obv_s"), true); assert.equal(p.other, undefined);
  assert.equal(parse("obv_gm=tossed").obv_gm, undefined, "a new cookie has no old name");
  assert.equal(parse("__Host-obv_s=%E0%A4%A; x=1").obv_s, "%E0%A4%A", "a bad escape doesn't throw");
  const lines = auth.cookie("obv_s", "v", 60);
  assert.deepEqual(lines, ["__Host-obv_s=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60", "obv_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"]);
  // the request: a tossed cookie (another site's, sent first) doesn't replace the __Host- one
  const tossed = await v1call("GET", "me", "obv_s=" + encodeURIComponent(t(B)) + "; " + ck({ obv_s: t(A) }));
  assert.equal(tossed.body.user.id, A);
  // a login from before the rename: still logged in, and moved to the new name (the old one cleared)
  const old = await v1call("GET", "me", legacyCk({ obv_s: t(A) }));
  assert.equal(old.body.user.id, A); assert.ok(auth.unsign(old.cookies.obv_s, c()).id === A, "re-issued as __Host-obv_s"); assert.equal(old.raw.obv_s, "");
  // logging out clears both names
  let sc = [];
  await require(join(root, "api/auth/logout.js"))({ method: "POST", url: "/api/auth/logout", headers: { host: HOST, "content-type": "application/json", cookie: legacyCk({ obv_s: t(A) }) } },
    { statusCode: 0, setHeader(k, v) { if (k.toLowerCase() === "set-cookie") sc = [].concat(v); }, end() {} });
  assert.ok(sc.some(x => /^__Host-obv_s=;.*Max-Age=0/.test(x)) && sc.some(x => /^obv_s=;.*Max-Age=0/.test(x)), sc.join(" | "));
});

// ---------- return-to values (?next=, and what comes back in the obv_st / obv_alt login cookies) ----------
// Browsers drop tabs / line breaks from a Location and read "\" as "/": none of these may ever leave this site.
const EVIL_NEXT = ["/%09/evil.com", "/%0a/evil.com", "/%0d%0a/evil.com", "/\t/evil.com", "/\n/evil.com", "/\r\n/evil.com", "//evil.com", "/\\evil.com",
  "/%5cevil.com", "https://evil.com", "javascript:alert(1)", "/ /evil.com", "/　/evil.com", "/..//evil.com", "/.//evil.com", "/%2e%2e//evil.com",
  "/a/..//evil.com", "%2F%2Fevil.com", "/%2F%2Fevil.com", "/\x00/evil.com", "/\x7f/evil.com", "/" + "a".repeat(5000), "/?x=" + "%E3%80%80".repeat(400)];
const GOOD_NEXT = [["/", "/"], ["/?view=editor&s=1#x", "/?view=editor&s=1#x"], ["/?invite=abc", "/?invite=abc"], ["/p/abc?x=1", "/p/abc?x=1"]];
const onSite = v => typeof v === "string" && v[0] === "/" && v[1] !== "/" && !/[\x00-\x20\x7f\\]/.test(v) && new URL(v, "https://site.example").origin === "https://site.example";
// run a handler; -> { status, location, cookies }
async function runAuth(file, url, cookie) {
  const out = { status: 0, location: "", cookies: {} };
  await require(join(root, file))({ method: "GET", url, headers: { host: HOST, cookie: cookie || "" } }, {
    set statusCode(v) { out.status = v; }, get statusCode() { return out.status; }, end() {},
    setHeader(k, v) { if (k.toLowerCase() === "location") out.location = v; if (k.toLowerCase() === "set-cookie") takeCookies(out, v); } });
  return out;
}

test("safeNext: only a path on this site comes out, whatever goes in", () => {
  for (const v of [...EVIL_NEXT, null, undefined, "", 42, ["/x"], { toString: () => "//evil.com" }]) {
    const r = auth.safeNext(v);
    assert.ok(onSite(r), `${JSON.stringify(v)} -> ${JSON.stringify(r)}`);
    assert.ok(!/evil\.com$/.test(new URL(r, "https://site.example").host), JSON.stringify(v));
  }
  for (const v of ["/\t/evil.com", "/\n/evil.com", "//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/ /evil.com", "/..//evil.com", "/.//evil.com",
    "/%2e%2e//evil.com", "%2F%2Fevil.com", "/" + "a".repeat(5000), null, 42]) assert.equal(auth.safeNext(v), "/", JSON.stringify(v));
  assert.equal(auth.safeNext("/　/evil.com"), "/%E3%80%80/evil.com", "non-ASCII is percent-encoded (a path, never a host)");
  for (const [v, want] of GOOD_NEXT) assert.equal(auth.safeNext(v), want);
  // ?login= goes before the #fragment (location.search), on a checked path
  assert.equal(auth.withParam("/?view=editor&s=1#x", "login", "ok"), "/?view=editor&s=1&login=ok#x");
  assert.equal(auth.withParam("/", "login", "ok"), "/?login=ok");
  assert.equal(auth.withParam("/\t/evil.com", "login", "ok"), "/?login=ok");
});

test("redirect(): no CR/LF or foreign scheme in a Location; paths go through safeNext; provider URLs pass", () => {
  const loc = url => { let l = null; auth.redirect({ setHeader(k, v) { if (k === "Location") l = v; }, end() {} }, url); return l; };
  assert.equal(loc("/x\r\nSet-Cookie: a=b"), "/");
  assert.equal(loc("https://osu.ppy.sh/x\nSet-Cookie: a=b"), "/");
  assert.equal(loc("javascript:alert(1)"), "/");
  assert.equal(loc("//evil.com"), "/");
  assert.equal(loc("/..//evil.com"), "/");
  assert.equal(loc(undefined), "/");
  assert.equal(loc("/?view=editor&s=1&login=ok#x"), "/?view=editor&s=1&login=ok#x");
  const prov = "https://osu.ppy.sh/oauth/authorize?client_id=1&state=abc";
  assert.equal(loc(prov), prov);
});

test("osu! login -> callback: a hostile ?next= comes back as a path on this site (and a forged state cookie's next too)", async () => {
  for (const v of [...EVIL_NEXT, ...GOOD_NEXT.map(g => g[0])]) {
    for (const qs of [encodeURIComponent(v), v]) {
      const start = await runAuth("api/auth/login.js", "/api/auth/login?next=" + qs);
      assert.equal(start.status, 302); assert.equal(new URL(start.location).origin, "https://osu.ppy.sh");
      const st = auth.unsign(start.cookies.obv_st, c());
      assert.ok(st && onSite(st.next), `${JSON.stringify(qs)}: state next ${JSON.stringify(st && st.next)}`);
      const back = await runAuth("api/auth/callback.js", "/api/auth/callback?code=x&state=" + st.state, "obv_st=" + encodeURIComponent(start.cookies.obv_st));
      assert.equal(back.status, 302);
      assert.ok(onSite(back.location), `${JSON.stringify(qs)} -> ${JSON.stringify(back.location)}`);
      assert.equal(new URL(back.location, "https://site.example").searchParams.get("login"), "ok", back.location);
    }
  }
  for (const [v, want] of GOOD_NEXT) { // legit values survive the round trip
    const start = await runAuth("api/auth/login.js", "/api/auth/login?next=" + encodeURIComponent(v)), st = auth.unsign(start.cookies.obv_st, c());
    const back = await runAuth("api/auth/callback.js", "/api/auth/callback?error=access_denied&state=" + st.state, "obv_st=" + encodeURIComponent(start.cookies.obv_st));
    assert.equal(back.location, auth.withParam(want, "login", "cancelled"));
  }
  // a state cookie carrying a bad next (signed before this check existed): checked again on the way back
  for (const v of EVIL_NEXT) {
    const forged = auth.sign({ state: "s1", next: v, exp: Date.now() + 6e5 }, c());
    for (const qs of ["code=x&state=s1", "error=access_denied&state=s1", "code=x&state=wrong"]) {
      const back = await runAuth("api/auth/callback.js", "/api/auth/callback?" + qs, "obv_st=" + encodeURIComponent(forged));
      assert.ok(onSite(back.location), `${JSON.stringify(v)} ${qs} -> ${JSON.stringify(back.location)}`);
    }
  }
});

test("Google login: a hostile ?next= (start) or one in the obv_alt cookie (back) stays on this site", async () => {
  for (const v of [...EVIL_NEXT, ...GOOD_NEXT.map(g => g[0])]) {
    for (const qs of [encodeURIComponent(v), v]) {
      for (const mode of ["login", "link"]) { // (link without a session: straight back to next)
        const g = await call("google", `mode=${mode}&next=${qs}`);
        if (mode === "link") assert.ok(onSite(g.location), `${JSON.stringify(qs)} -> ${JSON.stringify(g.location)}`);
        else { const st = auth.unsign(g.cookies.obv_alt, c()); assert.ok(st && onSite(st.next), `${JSON.stringify(qs)}: ${JSON.stringify(st && st.next)}`); }
      }
    }
    const forged = auth.sign({ p: "google", mode: "login", next: v, state: "s2", nonce: "n", exp: Date.now() + 6e5 }, c());
    for (const qs of ["error=access_denied&state=s2", "code=x&state=wrong"]) {
      const back = await call("google", qs, "obv_alt=" + encodeURIComponent(forged));
      assert.ok(onSite(back.location), `${JSON.stringify(v)} ${qs} -> ${JSON.stringify(back.location)}`);
    }
  }
});
