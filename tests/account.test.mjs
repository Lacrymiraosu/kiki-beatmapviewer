// Account settings, "Download my data" and Delete account end to end: real handlers (api/v1.js) + real SQL (PGlite) +
// the Storage stand-in.
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
const A = 1001, B = 4242, C = 1003, OWNER = 9999;
let emu, osuSrv, srv, base, auth;

before(async () => {
  emu = await startSupabaseEmu();
  osuSrv = await startOsuMock(54332);
  Object.assign(process.env, { SUPABASE_URL: emu.url, SUPABASE_SECRET_KEY: emu.key, OSU_CLIENT_ID: "1", OSU_CLIENT_SECRET: "test-only-secret", OSU_API_BASE: "http://127.0.0.1:54332", OWNER_OSU_ID: String(OWNER) });
  const v1 = require(join(root, "api/v1.js")); auth = require(join(root, "api/_lib/auth.js"));
  SRV = await startApi(root, emu); srv = SRV.srv; base = SRV.base;
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
});
after(async () => { srv.close(); osuSrv.close(); await emu.close(); });

const cookieFor = (id, iat) => "__Host-obv_s=" + encodeURIComponent(auth.sign({ id, username: "user" + id, avatar: "", country: "TH", kind: "session", iat, exp: Date.now() + 36e5 }, auth.cfg({ headers: { host: "x" } })));
async function api(method, route, { as, iat, body } = {}) {
  const h = {}; if (as) h.cookie = cookieFor(as, iat);
  if (body !== undefined) { h["content-type"] = "application/json"; h["sec-fetch-site"] = "same-origin"; }
  const r = await fetch(base + "/api/v1/" + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j, headers: r.headers };
}
const sha = async b => Buffer.from(await crypto.subtle.digest("SHA-256", b)).toString("hex");
async function projectWithFile(as) {
  const p = (await api("POST", "projects", { as, body: { clientKey: "k-" + Math.random().toString(36).slice(2, 12), title: "Mine", artist: "A", creator: "c" } })).body.project;
  const data = new TextEncoder().encode("osu file format v14\r\n");
  const b = await api("POST", `projects/${p.id}/saves`, { as, body: { baseRevision: 0, files: [{ path: "map.osu", size: data.length, sha256: await sha(data) }] } });
  const url = b.body.uploads[0].url, fd = new FormData(); fd.append("cacheControl", "3600"); fd.append("", new Blob([data]));
  if (url.startsWith("/")) await fetch(SRV.abs(url), { method: "PUT", body: new Blob([data]) }); // (R2: this site's own link, the file as it is)
  else await fetch(url, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
  assert.equal((await api("POST", `saves/${b.body.saveId}/commit`, { as, body: {} })).status, 200);
  return p;
}
const blobsOf = id => SRV.stored().filter(k => k.includes(id)).length;

test("settings: allow_add, sync with prefs; others can't add you when it's off", async () => {
  const g = await api("GET", "me/account", { as: A });
  assert.equal(g.status, 200); assert.equal(g.body.allow_add, true); assert.equal(g.body.sync, false);
  // prefs only kept while sync is on
  await api("POST", "me/account", { as: A, body: { prefs: { dim: 40 } } });
  assert.equal((await api("GET", "me/prefs", { as: A })).body.prefs, null);
  const on = await api("POST", "me/account", { as: A, body: { sync: true } });
  assert.equal(on.body.sync, true);
  await api("POST", "me/account", { as: A, body: { prefs: { dim: 40, lang: "th" } } });
  const p = await api("GET", "me/prefs", { as: A });
  assert.deepEqual(p.body.prefs, { dim: 40, lang: "th" }); assert.ok(p.body.prefs_at);
  assert.ok((await api("GET", "me", { as: A })).body.prefs_at, "/me tells the browser the account has settings");
  assert.equal((await api("POST", "me/account", { as: A, body: { prefs: "x" } })).status, 400);
  await api("POST", "me/account", { as: A, body: { sync: false } });
  assert.equal((await api("GET", "me/prefs", { as: A })).body.prefs, null, "turning sync off forgets them");
  // B (TestMapper on osu!) says nobody may add them
  await api("GET", "me", { as: B });
  await api("POST", "me/account", { as: B, body: { allow_add: false } });
  const proj = (await api("POST", "projects", { as: A, body: { clientKey: "addtest-123", title: "T" } })).body.project;
  const add = await api("POST", `projects/${proj.id}/members`, { as: A, body: { user: "TestMapper", role: "viewer" } });
  assert.equal(add.status, 403); assert.equal(add.body.detail.reason, "no_add");
  await api("POST", "me/account", { as: B, body: { allow_add: true } });
  assert.equal((await api("POST", `projects/${proj.id}/members`, { as: A, body: { user: "TestMapper", role: "viewer" } })).status, 200);
});

test("download my data: the account, projects, shares, logins and activity", async () => {
  const r = await api("GET", "me/export", { as: A });
  assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition"), /attachment; filename="kiki-beatmap-viewer-my-data-1001\.json"/);
  assert.equal(r.body.account.osu_id, A); assert.equal(r.body.account.admin_note, undefined);
  assert.ok(r.body.own_projects.length >= 1); assert.ok(Array.isArray(r.body.activity_log));
  assert.ok((await api("GET", "me/export", { as: B })).body.shared_with_you.some(x => x.title === "T"));
  assert.equal((await api("GET", "me/export")).status, 401);
});

test("delete account: needs \"Confirm\"; the owner can't", async () => {
  assert.equal((await api("POST", "me/delete", { as: C, body: {} })).status, 400);
  assert.equal((await api("POST", "me/delete", { as: C, body: { confirm: "confirm" } })).status, 400, "exactly Confirm");
  const o = await api("POST", "me/delete", { as: OWNER, body: { confirm: "Confirm" } });
  assert.equal(o.status, 403); assert.equal(o.body.detail.reason, "owner");
});

test("delete account: projects and files gone, shares and links removed, every older login logged out, a new login starts fresh", async () => {
  const before = Date.now() - 1000;
  const p = await projectWithFile(C);
  assert.ok(blobsOf(p.id) > 0);
  await api("POST", `projects/${p.id}/members`, { as: C, body: { user: "TestMapper", role: "editor" } });
  const shared = (await api("POST", "projects", { as: A, body: { clientKey: "share-for-c1", title: "S" } })).body.project;
  await emu.db.query("insert into obv.members (project_id, user_id, role, added_by) values ($1, $2, 'viewer', $3)", [shared.id, C, A]);
  await emu.db.query("insert into obv.user_logins (provider, subject, osu_id) values ('google', 'g-c', $1)", [C]);

  const d = await api("POST", "me/delete", { as: C, iat: before, body: { confirm: "Confirm" } });
  assert.equal(d.status, 200); assert.equal(d.body.deleted, true); assert.equal(d.body.projects, 1); assert.equal(d.body.pending, 0);
  assert.match(d.headers.get("set-cookie"), /__Host-obv_s=;.*Max-Age=0/);
  assert.equal(blobsOf(p.id), 0, "files deleted");
  const q = s => emu.db.query(s, [C]).then(r => r.rows);
  assert.equal((await q("select 1 from obv.users where osu_id = $1")).length, 0, "account row removed");
  assert.equal((await q("select 1 from obv.projects where owner_id = $1")).length, 0);
  assert.equal((await q("select 1 from obv.members where user_id = $1")).length, 0);
  assert.equal((await q("select 1 from obv.user_logins where osu_id = $1")).length, 0);
  assert.equal((await q("select 1 from obv.account_deletions where osu_id = $1")).length, 1);

  // an older login (another device) is logged out and doesn't bring the account back
  const old = await api("GET", "me", { as: C, iat: before });
  assert.equal(old.body.user, null); assert.equal(old.body.deleted, true); assert.match(old.headers.get("set-cookie") || "", /__Host-obv_s=;/);
  assert.equal((await api("GET", "projects", { as: C, iat: before })).status, 401);
  assert.equal((await q("select 1 from obv.users where osu_id = $1")).length, 0);
  // a login made after the deletion: a new, empty account
  const fresh = await api("GET", "me", { as: C, iat: Date.now() + 1000 });
  assert.equal(fresh.body.user.id, C);
  assert.deepEqual((await api("GET", "projects", { as: C, iat: Date.now() + 1000 })).body.projects, []);
  assert.equal((await q("select 1 from obv.account_deletions where osu_id = $1")).length, 0);
});

test("delete account while files can't be removed yet: emptied now, the row goes with the cleanup", async () => {
  const D = 1004, iat = Date.now() - 1000;
  await api("GET", "me", { as: D, iat });
  const p = await projectWithFile(D);
  emu.fail.remove = 5; if (SRV.r2) SRV.r2.fail.remove = 5; // Storage refuses deletions for a while
  const d = await api("POST", "me/delete", { as: D, iat, body: { confirm: "Confirm" } });
  assert.equal(d.status, 200); assert.equal(d.body.pending, 1);
  const u = (await emu.db.query("select username, avatar_url, prefs from obv.users where osu_id = $1", [D])).rows[0];
  assert.deepEqual(u, { username: "deleted", avatar_url: null, prefs: null });
  assert.equal((await emu.db.query("select status from obv.projects where id = $1", [p.id])).rows[0].status, "deleting");
  emu.fail.remove = 0; if (SRV.r2) SRV.r2.fail.remove = 0;
  const { runCleanup } = require(join(root, "api/_lib/cleanup.js"));
  const r = await runCleanup();
  assert.equal(r.accounts_removed, 1);
  assert.equal((await emu.db.query("select 1 from obv.users where osu_id = $1", [D])).rows.length, 0);
  assert.equal(blobsOf(p.id), 0);
});

// ---------- session keys (SESSION_SECRET) and ending logins (sessions_valid_after) ----------
const nodeCrypto = require("node:crypto");
const sess = (id, extra = {}) => ({ id, username: "user" + id, avatar: "", country: "TH", kind: "session", iat: Date.now(), exp: Date.now() + 36e5, ...extra });
const signed = o => auth.sign(o, auth.cfg({ headers: { host: "x" } }));
async function raw(method, route, sessionTok, body) { // like api(), with a given obv_s value (or none)
  const h = sessionTok ? { cookie: "__Host-obv_s=" + encodeURIComponent(sessionTok) } : {};
  if (body !== undefined) { h["content-type"] = "application/json"; h["sec-fetch-site"] = "same-origin"; }
  const r = await fetch(base + "/api/v1/" + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  const sc = r.headers.get("set-cookie") || "", m = /__Host-obv_s=([^;]*)/.exec(sc);
  return { status: r.status, body: j, setCookie: sc, newSession: m && m[1] ? decodeURIComponent(m[1]) : m ? "" : null };
}
const withEnv = async (vars, fn) => {
  const was = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const SS = "test-only-session-secret-0123456789abcdef";
const legacyKey = d => nodeCrypto.createHash("sha256").update((d === "files" ? "obv-files:" : "obv-session:") + "test-only-secret").digest();
const newKey = d => nodeCrypto.createHmac("sha256", SS).update("obv-" + d).digest();
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const linkWith = (key, o) => { const body = b64u(JSON.stringify(o)); return body + "." + b64u(nodeCrypto.createHmac("sha256", key).update(body).digest()); };

test("session keys: without SESSION_SECRET exactly as before; with it new logins use the new key, old ones work during the grace period and are signed again", async () => {
  const U = 2101;
  // unset: the OSU_CLIENT_SECRET-derived keys, as before
  const legacyTok = await withEnv({ SESSION_SECRET: null }, async () => {
    assert.deepEqual(auth.keys("session").key, legacyKey("session")); assert.deepEqual(auth.keys("files").key, legacyKey("files"));
    assert.deepEqual(auth.keys("live").key, legacyKey("session"), "live tokens used the session key");
    assert.equal(auth.cfg({ headers: {} }).oldKey, null);
    const t = signed(sess(U));
    const me = await raw("GET", "me", t); assert.equal(me.body.user.id, U); assert.equal(me.newSession, null, "nothing to sign again");
    return t;
  });
  await withEnv({ SESSION_SECRET: SS, SESSION_LEGACY_OK: null }, async () => {
    assert.deepEqual(auth.keys("session").key, newKey("session")); assert.deepEqual(auth.keys("files").key, newKey("files")); assert.deepEqual(auth.keys("live").key, newKey("live"));
    // new logins: signed with the new key only
    const fresh = signed(sess(U));
    assert.equal(auth.unsign(fresh, { key: legacyKey("session") }), null);
    assert.equal(auth.unsign(fresh, { key: newKey("session") }).id, U);
    assert.equal((await raw("GET", "me/account", fresh)).status, 200);
    // an old login still works during the grace period, and /me signs it again with the new key (same iat and exp)
    const me = await raw("GET", "me", legacyTok);
    assert.equal(me.body.user.id, U); assert.ok(me.newSession, "signed again");
    const again = auth.unsign(me.newSession, { key: newKey("session") }), orig = auth.unsign(legacyTok, { key: legacyKey("session") });
    assert.equal(again.id, U); assert.equal(again.iat, orig.iat); assert.equal(again.exp, orig.exp); assert.equal(again.legacyKey, undefined);
    assert.equal((await raw("GET", "me", me.newSession)).newSession, null);
    // grace period over: old logins stop working, new ones don't
    await withEnv({ SESSION_LEGACY_OK: "0" }, async () => {
      assert.equal((await raw("GET", "me", legacyTok)).body.user, null);
      assert.equal((await raw("GET", "me/account", legacyTok)).status, 401);
      assert.equal((await raw("GET", "me/account", fresh)).status, 200);
      assert.equal((await raw("GET", "me/account", me.newSession)).status, 200);
    });
  });
});

test("session keys: file links and live-session tokens work with and without SESSION_SECRET", async () => {
  const U = 2102, db = require(join(root, "api/_lib/db.js")), e = Date.now() + 6e4;
  for (const ss of [null, SS]) await withEnv({ SESSION_SECRET: ss }, async () => {
    const tok = signed(sess(U));
    // file links (R2): signed and checked with the "files" key
    assert.equal(db.readFileLink(linkWith(auth.keys("files").key, { t: "d", k: "p/x/y", e }), "d").k, "p/x/y");
    assert.equal(db.readFileLink(linkWith(auth.keys("session").key, { t: "d", k: "p/x/y", e }), "d"), null, "not with another key");
    if (ss) assert.equal(db.readFileLink(linkWith(legacyKey("files"), { t: "d", k: "p/x/y", e }), "d"), null, "old links just expire");
    // live sessions: the host's token gets anyone in the session relay settings; a wrong one doesn't
    const st = await raw("POST", "live/start", tok, { code: "abcdef12" });
    assert.equal(st.status, 200); assert.ok(st.body.token);
    assert.equal((await raw("POST", "live/ice", null, { code: "abcdef12", token: st.body.token })).status, 200);
    assert.equal((await raw("POST", "live/ice", null, { code: "zzzzzz12", token: st.body.token })).status, 403);
  });
  // a token from before SESSION_SECRET was set isn't accepted after (they last 3 hours at most)
  const old = await withEnv({ SESSION_SECRET: null }, async () => (await raw("POST", "live/start", signed(sess(U)), { code: "abcdef13" })).body.token);
  await withEnv({ SESSION_SECRET: SS }, async () => assert.equal((await raw("POST", "live/ice", null, { code: "abcdef13", token: old })).status, 403));
});

test("log out everywhere: older logins end (cookie cleared), newer ones don't", async () => {
  const U = 2103, older = signed(sess(U, { iat: Date.now() - 5000 })), here = signed(sess(U, { iat: Date.now() - 2000 }));
  assert.equal((await raw("GET", "me/account", older)).status, 200);
  assert.equal((await raw("POST", "me/logout-all", null, {})).status, 401, "needs a login");
  const r = await raw("POST", "me/logout-all", here, {});
  assert.equal(r.status, 200); assert.match(r.setCookie, /__Host-obv_s=;.*Max-Age=0/);
  assert.ok((await emu.db.query("select sessions_valid_after from obv.users where osu_id = $1", [U])).rows[0].sessions_valid_after);
  for (const t of [older, here]) {
    assert.equal((await raw("GET", "me/account", t)).status, 401);
    assert.equal((await raw("GET", "me", t)).body.user, null);
  }
  const newer = signed(sess(U, { iat: Date.now() + 1000 }));
  assert.equal((await raw("GET", "me/account", newer)).status, 200, "a login made after it works");
  assert.equal((await raw("GET", "me", newer)).body.user.id, U);
});

test("ended logins are found with the user row (as on another server instance): /me says so and clears the cookie", async () => {
  const U = 2104, older = signed(sess(U, { iat: Date.now() - 5000 }));
  assert.equal((await raw("GET", "me", older)).body.user.id, U);
  await emu.db.query("update obv.users set sessions_valid_after = now() where osu_id = $1", [U]); // (set elsewhere)
  const me = await raw("GET", "me", older);
  assert.equal(me.body.user, null); assert.equal(me.body.revoked, true); assert.equal(me.body.deleted, undefined); assert.match(me.setCookie, /__Host-obv_s=;.*Max-Age=0/);
  const a = await raw("GET", "me/account", older); assert.equal(a.status, 401); assert.equal(a.body.error, "login_required");
  assert.equal((await raw("GET", "me/account", signed(sess(U, { iat: Date.now() + 1000 })))).status, 200);
});

test("unlinking Google ends the logins made before (Google ones too); this osu! login stays, signed again", async () => {
  const U = 2105, cur = signed(sess(U, { iat: Date.now() - 4000 }));
  assert.equal((await raw("GET", "me", cur)).body.user.id, U);
  await emu.db.query("insert into obv.user_logins (provider, subject, osu_id) values ('google', 'g-2105', $1)", [U]);
  const viaGoogle = signed(sess(U, { iat: Date.now() - 3000, via: "google" })), otherDevice = signed(sess(U, { iat: Date.now() - 3000 }));
  assert.equal((await raw("GET", "me/account", viaGoogle)).status, 200);
  const r = await raw("DELETE", "me/logins/google", cur, {});
  assert.equal(r.status, 200); assert.equal(r.body.linked.google, null); assert.ok(r.newSession, "this login, signed again");
  assert.equal(auth.unsign(r.newSession, auth.cfg({ headers: {} })).via, undefined);
  for (const t of [viaGoogle, otherDevice, cur]) assert.equal((await raw("GET", "me/account", t)).status, 401);
  assert.equal((await raw("GET", "me/account", r.newSession)).status, 200);
  // unlinking from a Google login logs that one out
  await emu.db.query("insert into obv.user_logins (provider, subject, osu_id) values ('google', 'g-2105b', $1)", [U]);
  const g = signed(sess(U, { iat: Date.now() + 1000, via: "google" }));
  const r2 = await raw("DELETE", "me/logins/google", g, {});
  assert.equal(r2.status, 200); assert.equal(r2.body.logged_out, true); assert.match(r2.setCookie, /__Host-obv_s=;.*Max-Age=0/);
});

test("an admin suspending an account ends its logins", async () => {
  const U = 2106, older = signed(sess(U, { iat: Date.now() - 5000 }));
  assert.equal((await raw("GET", "me/account", older)).status, 200);
  assert.equal((await api("POST", `admin/users/${U}/status`, { as: OWNER, body: { status: "suspended", reason: "test" } })).status, 200);
  assert.equal((await raw("GET", "me/account", older)).status, 401);
  assert.equal((await raw("GET", "me", signed(sess(U, { iat: Date.now() + 1000 })))).body.status, "suspended", "a new login is still suspended");
  await api("POST", `admin/users/${U}/status`, { as: OWNER, body: { status: "active" } });
  assert.equal((await raw("GET", "me/account", older)).status, 401, "and stays ended after reactivation");
  assert.equal((await raw("GET", "me/account", signed(sess(U, { iat: Date.now() + 1000 })))).status, 200);
});
