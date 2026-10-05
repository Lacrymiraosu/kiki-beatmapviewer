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

before(async () => {
  emu = await startSupabaseEmu(); osuSrv = await startOsuMock(54333);
  Object.assign(process.env, { SUPABASE_URL: emu.url, SUPABASE_SECRET_KEY: emu.key, OSU_CLIENT_ID: "1", OSU_CLIENT_SECRET: "test-only-secret", OSU_API_BASE: "http://127.0.0.1:54333",
    GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret" });
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === "https://osu.ppy.sh/oauth/token") return new Response(JSON.stringify({ access_token: "osu-user-token" }), { headers: { "content-type": "application/json" } });
    if (u === "https://osu.ppy.sh/api/v2/me") return new Response(JSON.stringify({ id: 4242, username: "TestMapper", avatar_url: "https://a.ppy.sh/4242", country_code: "TH" }), { headers: { "content-type": "application/json" } });
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
const sessionCookie = id => "obv_s=" + encodeURIComponent(auth.sign({ id, username: "user" + id, avatar: "", country: "TH", kind: "session", exp: Date.now() + 36e5 }, c()));
// call a handler like the server does; -> { status, location, cookies: { name: value } }
async function call(p, qs, cookie) {
  const out = { status: 0, location: "", cookies: {} };
  const req = { method: "GET", url: `/api/auth/${p}?${qs}`, headers: { host: HOST, cookie: cookie || "" } };
  const res = { set statusCode(v) { out.status = v; }, get statusCode() { return out.status; }, setHeader(k, v) {
    if (k.toLowerCase() === "location") out.location = v;
    if (k.toLowerCase() === "set-cookie") for (const x of [].concat(v)) { const [nv] = x.split(";"), i = nv.indexOf("="); out.cookies[nv.slice(0, i)] = decodeURIComponent(nv.slice(i + 1)); }
  }, end() {} };
  await alt.handler(p)(req, res); return out;
}
// GET /api/auth/me with a session cookie -> its JSON
async function authMe(sess) {
  let body = ""; const req = { method: "GET", url: "/api/auth/me", headers: { host: HOST, cookie: "obv_s=" + encodeURIComponent(sess) } };
  await require(join(root, "api/auth/me.js"))(req, { statusCode: 0, setHeader() {}, end(b) { body = b; } }); return JSON.parse(body);
}
// start, then come back with a code: the stand-in endpoint returns an id_token for `sub` (made with `tweak`)
async function roundTrip(p, { mode = "login", as, sub, tweak = x => x, status } = {}) {
  const start = await call(p, `mode=${mode}&next=%2Fdone`, as ? sessionCookie(as) : "");
  const st = auth.unsign(start.cookies.obv_alt, c());
  const claims = tweak({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, sub, nonce: st && st.nonce, exp: Math.floor(Date.now() / 1000) + 600 });
  answer[p] = { status, body: status ? { error: "invalid_grant" } : { id_token: idToken(claims) } };
  const ck = "obv_alt=" + encodeURIComponent(start.cookies.obv_alt) + (as ? "; " + sessionCookie(as) : "");
  return { start, back: await call(p, `code=abc&state=${st && st.state}`, ck) };
}
const why = r => new URL(r.back.location, "http://x").searchParams.get("login");
// the signed note of the older flow (a Google account that typed its osu! name; still served for a while)
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
  const r = await call("google", "code=abc&state=forged", "obv_alt=" + encodeURIComponent(start.cookies.obv_alt));
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
  const cookies = {}; for (const x of r.headers.getSetCookie()) { const [nv] = x.split(";"), i = nv.indexOf("="); cookies[nv.slice(0, i)] = decodeURIComponent(nv.slice(i + 1)); }
  return { status: r.status, body: await r.json(), cookies };
}
const ck = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("; ");
async function osuLogin(cookieStr) { // the osu! login callback (osu! itself stood in for)
  const cb = require(join(root, "api/auth/callback.js")), st = auth.sign({ state: "s9", next: "/", exp: Date.now() + 6e5 }, c());
  const out = { cookies: {} };
  await cb({ method: "GET", url: "/api/auth/callback?code=x&state=s9", headers: { host: HOST, cookie: ck({ obv_st: st }) + (cookieStr ? "; " + cookieStr : "") } },
    { set statusCode(v) {}, setHeader(k, v) { if (k.toLowerCase() === "location") out.location = v; if (k.toLowerCase() === "set-cookie") for (const x of [].concat(v)) { const [nv] = x.split(";"), i = nv.indexOf("="); out.cookies[nv.slice(0, i)] = decodeURIComponent(nv.slice(i + 1)); } }, end() {} });
  return out;
}

test("request access with Google: type the osu! name; only for names nobody uses here; confirmed by a later osu! login in the same browser", async () => {
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  const gp = gpFor("g-new");
  assert.equal((await v1call("GET", "me", ck({ obv_gp: gp }))).body.google_pending, true);
  // TestMapper (4242) already uses the site -> refused (nobody can take over a member by typing their name)
  await emu.db.query("insert into obv.users (osu_id, username, last_seen_at) values (4242, 'TestMapper', now())");
  const taken = await v1call("POST", "access/request-google", ck({ obv_gp: gp }), { osu: "TestMapper" });
  assert.equal(taken.status, 409); assert.equal(taken.body.detail.reason, "osu_in_use");
  await emu.db.query("delete from obv.users where osu_id = 4242");
  assert.equal((await v1call("POST", "access/request-google", "", { osu: "TestMapper" })).status, 401, "needs the Google sign-in");
  assert.equal((await v1call("POST", "access/request-google", ck({ obv_gp: gp }), { osu: "NoSuchUser" })).status, 404);
  // a clean name: the request goes in, marked as not verified, and they're logged in (pending) with Google
  const ok = await v1call("POST", "access/request-google", ck({ obv_gp: gp }), { osu: "https://osu.ppy.sh/users/TestMapper", message: "hi" });
  assert.equal(ok.status, 200); assert.equal(ok.body.access, "pending"); assert.equal(ok.body.verified, false);
  const s = auth.unsign(ok.cookies.obv_s, c()); assert.equal(s.id, 4242); assert.equal(s.via, "google"); assert.equal(s.unverified, true);
  assert.equal(ok.cookies.obv_gp, "", "the Google note is used up");
  const gl = ok.cookies.obv_gl; assert.equal(auth.unsign(gl, c()).sub, "g-new");
  const me = await v1call("GET", "me", ck({ obv_s: ok.cookies.obv_s }));
  assert.equal(me.body.user.id, 4242); assert.equal(me.body.access, "pending");
  // the admins see it
  const list = (await emu.db.query("select public.obv_admin_access('pending', '', 50, 0) as r")).rows[0].r;
  const row = list.rows.find(x => x.id === 4242); assert.deepEqual(row.google, { verified: false }); assert.equal(row.message, "hi");
  // later, logging in with Google again works (as the same, still unverified account)
  const again = await roundTrip("google", { sub: "g-new" });
  assert.equal(why(again), "ok"); assert.equal(auth.unsign(again.back.cookies.obv_s, c()).unverified, true);
  // not confirmed by the osu! account: no ticket (it would prove "I'm TestMapper" to people in live sessions), no hosting
  const meRes = await authMe(ok.cookies.obv_s);
  assert.equal(meRes.user.id, 4242); assert.equal(meRes.user.unverified, true); assert.equal(meRes.ticket, null);
  // an osu! login in another browser (no obv_gl): the unconfirmed Google link is removed
  await osuLogin("");
  assert.equal((await emu.db.query("select 1 from obv.user_logins where osu_id = 4242")).rows.length, 0);
  // ...and every session it gave is logged out (they're stateless: checked on use)
  const gone = await v1call("GET", "me", ck({ obv_s: ok.cookies.obv_s }));
  assert.equal(gone.body.user, null); assert.equal(gone.cookies.obv_s, "");
  assert.equal((await v1call("GET", "projects", ck({ obv_s: ok.cookies.obv_s }))).status, 401);
  assert.equal(auth.unsign((await roundTrip("google", { sub: "g-new" })).back.cookies.obv_s, c()).gonly, true);
  await emu.db.query("delete from obv.user_logins where subject = 'g-new'");
  // the real owner asking again with Google, then logging in with osu! in the same browser: confirmed
  await emu.db.query("update obv.users set last_seen_at = null, access = 'none' where osu_id = 4242");
  const gp2 = gpFor("g-new");
  const ok2 = await v1call("POST", "access/request-google", ck({ obv_gp: gp2 }), { osu: "TestMapper" });
  assert.equal(ok2.status, 200);
  const done = await osuLogin(ck({ obv_gl: ok2.cookies.obv_gl }));
  assert.equal(new URL(done.location, "http://x").searchParams.get("login"), "ok");
  assert.equal(done.cookies.obv_gl, "", "the browser note is used up");
  assert.deepEqual((await emu.db.query("select verified from obv.user_logins where osu_id = 4242")).rows, [{ verified: true }]);
  const fin = await roundTrip("google", { sub: "g-new" }); assert.equal(auth.unsign(fin.back.cookies.obv_s, c()).unverified, undefined);
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
});

test("accept an invite with Google: type the osu! name; in at once, the Google link not verified yet", async () => {
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  await emu.db.query("update obv.users set access = 'approved', role = 'admin' where osu_id = $1", [A]);
  await emu.db.query("insert into obv.invite_links (code, created_by, max_uses, uses, created_at) values ('GoogleInv1', $1, 1, 0, now())", [A]);
  const gp = gpFor("g-inv");
  assert.equal((await v1call("POST", "invite/accept-google", "", { code: "GoogleInv1", osu: "NewMapper" })).status, 401, "needs the Google sign-in");
  assert.equal((await v1call("POST", "invite/accept-google", ck({ obv_gp: gp }), { code: "Nope000000", osu: "NewMapper" })).status, 404);
  assert.equal((await v1call("POST", "invite/accept-google", ck({ obv_gp: gp }), { code: "GoogleInv1", osu: "NoSuchUser" })).status, 404);
  const ok = await v1call("POST", "invite/accept-google", ck({ obv_gp: gp }), { code: "GoogleInv1", osu: "NewMapper" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.access, "approved"); assert.equal(ok.body.user.id, 5151);
  const s = auth.unsign(ok.cookies.obv_s, c()); assert.equal(s.id, 5151); assert.equal(s.via, "google"); assert.equal(s.unverified, true);
  assert.equal(ok.cookies.obv_gp, "");
  const me = await v1call("GET", "me", ck({ obv_s: ok.cookies.obv_s })); assert.equal(me.body.access, "approved");
  // the link is used up now; and logging in with Google later works
  const gp2 = gpFor("g-inv2");
  const full = await v1call("POST", "invite/accept-google", ck({ obv_gp: gp2 }), { code: "GoogleInv1", osu: "TestMapper" });
  assert.equal(full.status, 409); assert.equal(full.body.error, "invite_full");
  assert.equal(why(await roundTrip("google", { sub: "g-inv" })), "ok");
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
});

test("Google only: in without osu!, follows invite-only, no live sessions; an osu! login takes everything over", async () => {
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  await emu.db.query("delete from obv.user_logins where osu_id = 4242");
  const r = await roundTrip("google", { sub: "g-only" }), sc = r.back.cookies.obv_s, s = auth.unsign(sc, c());
  assert.equal(why(r), "ok"); assert.equal(s.gonly, true);
  let me = null; // (the handler as the server runs it)
  await require(join(root, "api/auth/me.js"))({ method: "GET", url: "/api/auth/me", headers: { host: HOST, cookie: ck({ obv_s: sc }) } },
    { statusCode: 0, setHeader() {}, end(t) { me = JSON.parse(t); } });
  assert.equal(me.user.google_only, true); assert.equal(me.ticket, null, "no live-session ticket");
  assert.equal((await v1call("GET", "me", ck({ obv_s: sc }))).body.access, "none", "invite-only: not in yet");
  // an invite lets it in
  await emu.db.query("insert into obv.invite_links (code, created_by, max_uses, uses, created_at) values ('GoogleOnly', $1, 5, 0, now())", [A]);
  const acc = await v1call("POST", "invite/accept", ck({ obv_s: sc }), { code: "GoogleOnly" });
  assert.equal(acc.status, 200, JSON.stringify(acc.body)); assert.equal(acc.body.access, "approved");
  const proj = await v1call("POST", "projects", ck({ obv_s: sc }), { clientKey: "gonly-proj-1", title: "Mine" });
  assert.equal(proj.status, 201, JSON.stringify(proj.body));
  // live sessions need osu!
  const live = await v1call("POST", "live/start", ck({ obv_s: sc }), { code: "abc123" });
  assert.equal(live.status, 403); assert.equal(live.body.error, "osu_required");
  // logging in with osu! (TestMapper, 4242) in this browser: access, the project and the Google login move there
  const done = await osuLogin(ck({ obv_s: sc }));
  assert.equal(new URL(done.location, "http://x").searchParams.get("login"), "ok");
  const u = (await emu.db.query("select access from obv.users where osu_id = 4242")).rows[0]; assert.equal(u.access, "approved");
  assert.equal((await emu.db.query("select owner_id from obv.projects where id = $1", [proj.body.project.id])).rows[0].owner_id, 4242);
  assert.equal((await emu.db.query("select 1 from obv.users where osu_id = $1", [s.id])).rows.length, 0, "the Google-only account is gone");
  const g = await roundTrip("google", { sub: "g-only" }), gs = auth.unsign(g.back.cookies.obv_s, c());
  assert.equal(gs.id, 4242); assert.equal(gs.gonly, undefined, "Google now opens the osu! account");
  assert.ok([401, 403].includes((await v1call("GET", "projects", ck({ obv_s: sc }))).status), "the old Google-only session has no access any more");
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
});
