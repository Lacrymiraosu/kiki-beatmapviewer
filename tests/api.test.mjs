// The server API (api/v1.js, api/cron.js) end to end: real handlers + real SQL (PGlite) + a Storage stand-in.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startSupabaseEmu } from "./emu/supabase-emu.mjs";
import { startOsuMock, calls as osuCalls, hits as osuHits, apiVersions as osuApiVersions, LOOKUP_MD5, SCORES_LEGACY, SCORES_LAZER, SCORES_MANY, SCORES_DENIED, SCORES_EMPTY, SCORES_VERSIONED } from "./emu/osu-mock.mjs";
import { startApi } from "./lib/server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const A = 1001, B = 4242, C = 1003, OWNER = 9999, LIMIT = 30000000;
let emu, osuSrv, srv, base, auth;
// OBV_R2=1 / OBV_D1=1: the project files on an R2 stand-in, the database on a D1 stand-in (tests/lib/server.mjs)
let r2 = null, stored = null, d1 = null;
const abs = u => u && u.startsWith("/") ? base + u : u;

before(async () => {
  emu = await startSupabaseEmu();
  osuSrv = await startOsuMock(54331);
  Object.assign(process.env, { SUPABASE_URL: emu.url, SUPABASE_SECRET_KEY: emu.key, OSU_CLIENT_ID: "1", OSU_CLIENT_SECRET: "test-only-secret", OSU_API_BASE: "http://127.0.0.1:54331",
    OWNER_OSU_ID: String(OWNER), CRON_SECRET: "cron-secret-for-tests" });
  auth = require(join(root, "api/_lib/auth.js"));
  const A2 = await startApi(root, emu); srv = A2.srv; r2 = A2.r2; stored = A2.stored; d1 = A2.d1;
  base = A2.base;
  await emu.db.query("update obv.settings set value = '100' where key = 'max_projects_per_user'");
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'"); // the access test turns it on
});
after(async () => { srv.close(); osuSrv.close(); await emu.close(); });

const cookieFor = (id, username = "user" + id) => "__Host-obv_s=" + encodeURIComponent(auth.sign({ id, username, avatar: "", country: "TH", kind: "session", iat: Date.now(), exp: Date.now() + 36e5 }, auth.cfg({ headers: { host: "x" } }))); // (a fresh login: iat = now)
async function api(method, route, { as, body, headers = {} } = {}) {
  const h = { ...headers };
  if (as) h.cookie = cookieFor(as);
  if (body !== undefined) { h["content-type"] = "application/json"; h["sec-fetch-site"] = h["sec-fetch-site"] || "same-origin"; }
  const r = await fetch(base + "/api/v1/" + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j, headers: r.headers };
}
const sha = async bytes => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
const bytes = (n, fill) => new Uint8Array(n).fill(fill);
async function uploadTo(url, data) { // what the browser does (same body format as supabase-js uploadToSignedUrl)
  if (url.startsWith("/")) return fetch(base + url, { method: "PUT", body: new Blob([data]) }); // R2: this site's own link, the file as it is
  const fd = new FormData(); fd.append("cacheControl", "3600"); fd.append("", new Blob([data]));
  return fetch(url, { method: "PUT", body: fd, headers: { "x-upsert": "false" } });
}
async function newProject(as, key = "key-" + Math.random().toString(36).slice(2, 12)) { return (await api("POST", "projects", { as, body: { clientKey: key, title: "T", artist: "A", creator: "c" } })).body.project; }
async function save(as, id, baseRevision, files, { annotations, lie = {} } = {}) {
  const list = await Promise.all(files.map(async ([path, data]) => ({ path, size: data.length, sha256: await sha(data) })));
  const b = await api("POST", `projects/${id}/saves`, { as, body: { baseRevision, files: list } });
  if (b.status !== 200) return { begin: b };
  for (const u of b.body.uploads) { const data = lie[u.path] || files.find(f => f[0] === u.path)[1]; const r = await uploadTo(u.url, data); assert.equal(r.status, r2 && lie[u.path] ? 400 : 200, "upload " + u.path); } // (R2: a body that isn't the declared size is refused right away)
  return { begin: b, commit: await api("POST", `saves/${b.body.saveId}/commit`, { as, body: { annotations } }) };
}

test("logged out: no project access; requests from other sites are refused", async () => {
  assert.equal((await api("GET", "projects")).status, 401);
  assert.equal((await api("POST", "projects", { as: A, body: { clientKey: "abcdefgh12" }, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await api("POST", "projects", { as: A, body: { clientKey: "abcdefgh12" }, headers: { origin: "https://evil.example" } })).status, 403);
  const me = await api("GET", "me");
  assert.equal(me.body.user, null); assert.equal(me.body.owner, false);
});

test("the JSON check reads the media type itself: a type that only mentions application/json is refused", async () => {
  const post = ct => fetch(base + "/api/v1/projects", { method: "POST", headers: { cookie: cookieFor(A), "content-type": ct, "sec-fetch-site": "same-origin" }, body: "{}" });
  assert.equal((await post("text/plain; x=application/json")).status, 403);
  assert.equal((await post("text/plain;application/json")).status, 403);
  assert.equal((await post("application/jsonx")).status, 403);
  assert.notEqual((await post("Application/JSON; charset=utf-8")).status, 403, "parameters and case are fine");
});

// POST only (with the same checks as the API's other POSTs); a GET changes nothing, so another site can't log you out.
// Through the Worker (test:worker) when it runs, else the handler as Vercel runs it.
test("logout: POST from this site clears the session; a GET or a cross-site POST doesn't", async () => {
  const viaWorker = !!process.env.OBV_VIA_WORKER || !!process.env.OBV_R2 || !!process.env.OBV_D1;
  const logout = require(join(root, "api/auth/logout.js"));
  async function call(method, headers = {}) {
    const h = { cookie: cookieFor(A), ...headers }, body = method === "POST" ? "{}" : undefined;
    if (viaWorker) {
      const r = await fetch(base + "/api/auth/logout", { method, headers: h, body, redirect: "manual" });
      return { status: r.status, location: r.headers.get("location"), cookies: r.headers.getSetCookie() };
    }
    const out = { status: 0, location: null, cookies: [] };
    await logout({ method, url: "/api/auth/logout?next=/x", headers: { host: "127.0.0.1", ...h }, body }, {
      set statusCode(v) { out.status = v; }, get statusCode() { return out.status; },
      setHeader(k, v) { if (k.toLowerCase() === "location") out.location = v; if (k.toLowerCase() === "set-cookie") out.cookies.push(...[].concat(v)); }, end() {} });
    return out;
  }
  const g = await call("GET");
  assert.equal(g.status, 302); assert.equal(g.location, "/"); assert.deepEqual(g.cookies, [], "a GET doesn't log out");
  for (const bad of [{ "content-type": "application/json", "sec-fetch-site": "cross-site" }, { "content-type": "application/json", origin: "https://evil.example" }, { "content-type": "text/plain" }]) {
    const r = await call("POST", bad); assert.equal(r.status, 403, JSON.stringify(bad)); assert.deepEqual(r.cookies, []);
  }
  const ok = await call("POST", { "content-type": "application/json", "sec-fetch-site": "same-origin" });
  assert.equal(ok.status, 200); assert.ok(ok.cookies.some(x => /^__Host-obv_s=;.*Max-Age=0/.test(x)) && ok.cookies.some(x => /^obv_s=;.*Max-Age=0/.test(x)), "the session cookie is cleared (and its old name)");
  assert.equal((await call("PUT", { "content-type": "application/json" })).status, 405);
});

test("save online, reopen and download: the files come back exactly", async () => {
  const p = await newProject(A, "same-key-9999");
  assert.equal((await api("POST", "projects", { as: A, body: { clientKey: "same-key-9999" } })).status, 200, "retry returns the same project");
  const osu = new TextEncoder().encode("osu file format v14\r\n[HitObjects]\r\n1,2,3,1,0\r\n"), song = bytes(5000, 7);
  const r = await save(A, p.id, 0, [["map.osu", osu], ["song.mp3", song]]);
  assert.equal(r.commit.status, 200); assert.equal(r.commit.body.revision, 1);
  const g = await api("GET", `projects/${p.id}`, { as: A });
  assert.equal(g.status, 200); assert.equal(g.body.project.role, "owner"); assert.equal(g.body.project.files.length, 2);
  for (const f of g.body.project.files) {
    const d = new Uint8Array(await (await fetch(abs(f.url))).arrayBuffer());
    assert.deepEqual(Buffer.from(d), Buffer.from(f.path === "map.osu" ? osu : song));
  }
  // editing only the .osu uploads only the .osu
  const osu2 = new TextEncoder().encode("osu file format v14\r\n[HitObjects]\r\n5,6,7,1,0\r\n");
  const r2 = await save(A, p.id, 1, [["map.osu", osu2], ["song.mp3", song]]);
  assert.deepEqual(r2.begin.body.uploads.map(u => u.path), ["map.osu"]);
  assert.equal(r2.begin.body.reused, 1);
  assert.equal(r2.commit.body.revision, 2);
  assert.equal(r2.commit.body.expires_at, r.commit.body.expires_at, "saving doesn't move the expiry");
});

test("user B can't read, save, share or delete user A's project", async () => {
  const p = await newProject(A);
  await save(A, p.id, 0, [["map.osu", bytes(10, 1)]]);
  assert.equal((await api("GET", `projects/${p.id}`, { as: B })).status, 404);
  assert.equal((await api("POST", `projects/${p.id}/saves`, { as: B, body: { baseRevision: 1, files: [] } })).status, 404);
  assert.equal((await api("POST", `projects/${p.id}/members`, { as: B, body: { user: "TestMapper", role: "editor" } })).status, 404);
  assert.equal((await api("DELETE", `projects/${p.id}`, { as: B, body: {} })).status, 404);
  assert.ok(!(await api("GET", "projects", { as: B })).body.projects.some(x => x.id === p.id));
  assert.equal((await api("GET", `projects/${p.id}`, { as: A })).status, 200, "still there for A");
});

test("sharing by osu! name: viewer reads, can't save; editor saves; revoke removes access", async () => {
  const p = await newProject(A);
  await save(A, p.id, 0, [["map.osu", bytes(10, 2)]]);
  const s = await api("POST", `projects/${p.id}/members`, { as: A, body: { user: "TestMapper", role: "viewer" } });
  assert.equal(s.status, 200); assert.deepEqual(s.body.members.map(m => [m.id, m.role]), [[B, "viewer"]]);
  assert.equal((await api("GET", `projects/${p.id}`, { as: B })).body.project.role, "viewer");
  assert.equal((await save(B, p.id, 1, [["map.osu", bytes(11, 3)]])).begin.status, 403);
  await api("POST", `projects/${p.id}/members`, { as: A, body: { user: "TestMapper", role: "editor" } });
  assert.equal((await save(B, p.id, 1, [["map.osu", bytes(11, 3)]])).commit.body.revision, 2);
  assert.equal((await api("POST", `projects/${p.id}/members`, { as: A, body: { user: "NoSuchUser", role: "viewer" } })).status, 404);
  await api("POST", `projects/${p.id}/members`, { as: A, body: { user: "TestMapper", role: "none" } });
  assert.equal((await api("GET", `projects/${p.id}`, { as: B })).status, 404);
});

test("30,000,000 bytes: declared too big is refused; a bigger upload than declared fails the commit and keeps the last revision", async () => {
  const p = await newProject(A);
  const small = bytes(100, 4);
  await save(A, p.id, 0, [["map.osu", small]]);
  const tooBig = await api("POST", `projects/${p.id}/saves`, { as: A, body: { baseRevision: 1, files: [{ path: "a.mp3", size: LIMIT, sha256: "a".repeat(64) }, { path: "map.osu", size: 1, sha256: "b".repeat(64) }] } });
  assert.equal(tooBig.status, 413); assert.equal(tooBig.body.error, "too_large");
  // declare 100 bytes, upload 200000: Storage keeps what was sent, the commit compares and refuses (R2: refused at upload)
  const r = await save(A, p.id, 1, [["map.osu", small], ["bg.jpg", bytes(100, 5)]], { lie: { "bg.jpg": bytes(200000, 5) } });
  assert.equal(r.commit.status, 400); assert.equal(r.commit.body.error, r2 ? "missing_upload" : "size_mismatch"); // (R2: the upload never landed)
  const g = await api("GET", `projects/${p.id}`, { as: A });
  assert.equal(g.body.project.revision, 1); assert.deepEqual(g.body.project.files.map(f => f.path), ["map.osu"]);
  assert.deepEqual(Buffer.from(await (await fetch(abs(g.body.project.files[0].url))).arrayBuffer()), Buffer.from(small));
  // one file bigger than the bucket limit is refused by Storage itself
  const b = await api("POST", `projects/${p.id}/saves`, { as: A, body: { baseRevision: 1, files: [{ path: "x.mp3", size: 10, sha256: "c".repeat(64) }] } });
  const up = await uploadTo(b.body.uploads[0].url, new Uint8Array(LIMIT + 1));
  assert.equal(up.status, r2 ? 400 : 413); // (R2: anything but the declared size is refused by this site's upload link)
});

test("a stale save gets 409 instead of overwriting newer work", async () => {
  const p = await newProject(A);
  await api("POST", `projects/${p.id}/members`, { as: A, body: { user: "TestMapper", role: "editor" } });
  await save(A, p.id, 0, [["map.osu", bytes(10, 6)]]);
  const a = await api("POST", `projects/${p.id}/saves`, { as: A, body: { baseRevision: 1, files: [{ path: "map.osu", size: 3, sha256: await sha(bytes(3, 1)) }] } });
  const b = await api("POST", `projects/${p.id}/saves`, { as: B, body: { baseRevision: 1, files: [{ path: "map.osu", size: 4, sha256: await sha(bytes(4, 1)) }] } });
  await uploadTo(a.body.uploads[0].url, bytes(3, 1)); await uploadTo(b.body.uploads[0].url, bytes(4, 1));
  assert.equal((await api("POST", `saves/${a.body.saveId}/commit`, { as: A, body: {} })).status, 200);
  const late = await api("POST", `saves/${b.body.saveId}/commit`, { as: B, body: {} });
  assert.equal(late.status, 409); assert.equal(late.body.detail.revision, 2);
});

test("annotations are saved with the project, apart from the .osu files", async () => {
  const p = await newProject(A), id = "55555555-5555-4555-8555-555555555555";
  await save(A, p.id, 0, [["map.osu", bytes(10, 8)]], { annotations: { upsert: [{ id, diff: "map.osu", kind: "comment", object_id: "12", time_ms: 1234, body: "too close" }] } });
  const g = await api("GET", `projects/${p.id}?files=0`, { as: A });
  assert.equal(g.body.project.annotations.length, 1);
  assert.equal(g.body.project.annotations[0].body, "too close"); assert.equal(g.body.project.files, undefined);
});

test("expired projects are refused, and the daily cleanup deletes their files (not the changelog)", async () => {
  const p = await newProject(A);
  await save(A, p.id, 0, [["map.osu", bytes(10, 9)], ["song.mp3", bytes(20, 9)]]);
  const keys = stored().filter(k => k.includes(p.id));
  assert.equal(keys.length, 2);
  await emu.db.exec("alter table obv.projects disable trigger projects_fix_expiry");
  await emu.db.query("update obv.projects set expires_at = now() - interval '1 second' where id = $1", [p.id]);
  await emu.db.exec("alter table obv.projects enable trigger projects_fix_expiry");
  const g = await api("GET", `projects/${p.id}`, { as: A });
  assert.equal(g.status, 410); assert.equal(g.body.error, "expired");
  const clBefore = (await emu.db.query("select count(*)::int n from obv.changelog")).rows[0].n;
  assert.equal((await fetch(base + "/api/cron")).status, 401, "cron needs the secret");
  // same length in characters as the secret, not in bytes (latin-1 "é" is 2 bytes in UTF-8): refused, not a 500
  assert.equal((await fetch(base + "/api/cron", { headers: { authorization: "Bearer " + "\u00e9".repeat("cron-secret-for-tests".length) } })).status, 401);
  assert.equal((await fetch(base + "/api/cron", { headers: { authorization: "Bearer cron-secret-for-tests\u00e9" } })).status, 401);
  const keep = process.env.CRON_SECRET; delete process.env.CRON_SECRET; // no secret set: always refused (never "Bearer " alone)
  try { assert.equal((await fetch(base + "/api/cron", { headers: { authorization: "Bearer " } })).status, 401); } finally { process.env.CRON_SECRET = keep; }
  const c = await fetch(base + "/api/cron", { headers: { authorization: "Bearer cron-secret-for-tests" } });
  assert.equal(c.status, 200);
  assert.equal(stored().filter(k => k.includes(p.id)).length, 0, "files deleted from storage");
  assert.equal((await emu.db.query("select count(*)::int n from obv.projects where id = $1", [p.id])).rows[0].n, 0);
  assert.equal((await emu.db.query("select count(*)::int n from obv.changelog")).rows[0].n, clBefore);
});

test("owner delete while Storage fails: access stops now, files are removed on the next cleanup", async () => {
  const p = await newProject(A);
  await save(A, p.id, 0, [["map.osu", bytes(10, 10)]]);
  emu.fail.remove = 5; if (r2) r2.fail.remove = 5;
  const d = await api("DELETE", `projects/${p.id}`, { as: A, body: {} });
  assert.equal(d.status, 200); assert.equal(d.body.files_removed, false);
  assert.equal((await api("GET", `projects/${p.id}`, { as: A })).status, 404);
  assert.equal(stored().filter(k => k.includes(p.id)).length, 1, "file still there");
  assert.equal((await emu.db.query("select status from obv.projects where id = $1", [p.id])).rows[0].status, "deleting");
  emu.fail.remove = 0; if (r2) r2.fail.remove = 0;
  await fetch(base + "/api/cron", { headers: { authorization: "Bearer cron-secret-for-tests" } });
  assert.equal(stored().filter(k => k.includes(p.id)).length, 0);
  assert.equal((await emu.db.query("select count(*)::int n from obv.projects where id = $1", [p.id])).rows[0].n, 0);
});

test("admin: only the owner's osu! id gets in; changelog drafts stay private; actions are audited", async () => {
  for (const as of [undefined, A, B]) assert.ok([401, 403].includes((await api("GET", "admin/overview", { as })).status));
  assert.equal((await api("POST", "admin/changelog", { as: A, body: { title: "x", status: "published" } })).status, 403);
  assert.equal((await api("GET", "admin/changelog", { as: A })).status, 403);
  const me = await api("GET", "me", { as: OWNER });
  assert.equal(me.body.owner, true);
  const o = await api("GET", "admin/overview", { as: OWNER });
  assert.equal(o.status, 200); assert.equal(o.body.limit_bytes, LIMIT); assert.equal(typeof o.body.storage.bytes, "number");
  const d = await api("POST", "admin/changelog", { as: OWNER, body: { title: "Secret draft", versionLabel: "v12", content: "- soon", status: "draft" } });
  assert.equal(d.status, 200);
  assert.ok(!(await api("GET", "changelog")).body.entries.some(e => e.id === d.body.entry.id), "drafts aren't public");
  const p = await api("POST", "admin/changelog", { as: OWNER, body: { id: d.body.entry.id, title: "Now out", versionLabel: "v12", content: "- **new**", status: "published", baseUpdatedAt: d.body.entry.updated_at } });
  assert.equal(p.status, 200);
  const pub = (await api("GET", "changelog")).body.entries;
  assert.equal(pub[0].id, d.body.entry.id, "the newest published entry is on top");
  const stale = await api("POST", "admin/changelog", { as: OWNER, body: { id: d.body.entry.id, title: "old tab", status: "published", baseUpdatedAt: d.body.entry.updated_at } });
  assert.equal(stale.status, 409);
  assert.equal((await api("DELETE", `admin/changelog/${d.body.entry.id}`, { as: A, body: {} })).status, 403);
  assert.equal((await api("DELETE", `admin/changelog/${d.body.entry.id}`, { as: OWNER, body: {} })).status, 200);
  const audit = (await api("GET", "admin/audit", { as: OWNER })).body.rows.map(r => r.action);
  for (const a of ["changelog.create", "changelog.publish", "changelog.delete"]) assert.ok(audit.includes(a), a);
  // a Google-only account (id from 10^12, 13 digits) is managed like any other: the dashboard can read, limit and suspend it
  const G = 1000000000007;
  await emu.db.query("insert into obv.users (osu_id, username, avatar_url, country) values ($1, 'Google user', null, '') on conflict do nothing", [G]);
  assert.equal((await api("GET", `admin/users/${G}`, { as: OWNER })).status, 200, "13-digit ids are found");
  assert.equal((await api("POST", `admin/users/${G}/status`, { as: OWNER, body: { status: "suspended", reason: "test" } })).status, 200);
  assert.equal((await api("POST", `admin/users/${G}/status`, { as: OWNER, body: { status: "active" } })).status, 200);
  assert.equal((await api("GET", "admin/users/10000000000000", { as: OWNER })).status, 404, "14 digits is no id");
  // suspend a user: their project requests stop
  const q = await newProject(C);
  assert.equal((await api("POST", `admin/users/${C}/status`, { as: OWNER, body: { status: "suspended", reason: "test" } })).status, 200);
  assert.equal((await api("GET", `projects/${q.id}`, { as: C })).status, 403);
  await api("POST", `admin/users/${C}/status`, { as: OWNER, body: { status: "active" } });
  assert.equal((await api("GET", `projects/${q.id}`, { as: C })).status, 200);
});

test("admins: the owner adds one by osu! name; they manage users and projects but not settings or admins; removal is immediate", async () => {
  const add = await api("POST", "admin/admins", { as: OWNER, body: { user: "TestMapper" } });
  assert.equal(add.status, 200); assert.ok(add.body.admins.some(a => a.id === B && a.role === "admin"));
  assert.equal((await api("POST", "admin/admins", { as: A, body: { user: "TestMapper" } })).status, 403, "only the owner adds admins");
  assert.equal((await api("GET", "me", { as: B })).body.admin, "admin");
  assert.equal((await api("GET", "admin/overview", { as: B })).status, 200);
  assert.equal((await api("GET", "admin/settings", { as: B })).status, 200, "admins can read settings");
  assert.equal((await api("POST", "admin/settings", { as: B, body: { values: { retention_days: 20 } } })).status, 403, "but not change them");
  // feature switches (Admin → Features): any admin may change them, nothing else goes through that route
  const featOff = async () => (await api("GET", "me")).body.features.off;
  assert.deepEqual(await featOff(), [], "a logged-out visitor is told which are off (none)");
  assert.equal((await api("POST", "admin/features", { as: A, body: { values: { feat_ed_test: false } } })).status, 403, "a member can't");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { retention_days: 20 } } })).status, 400, "only feat_ keys");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_ed_test: false, saving_enabled: false } } })).status, 400, "not mixed with others");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_nope: false } } })).status, 400, "an unknown switch");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_ed_test: "no" } } })).status, 400, "a switch is true or false");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_ed_test: false, feat_projects: false } } })).status, 200);
  assert.deepEqual(await featOff(), ["ed_test", "projects"], "the change is visible to everyone at once (this instance)");
  assert.equal((await api("GET", "projects", { as: A })).status, 503, "a server-backed feature that is off is refused");
  assert.equal((await api("GET", "projects", { as: A })).body.error, "feature_disabled");
  assert.equal((await api("GET", "projects", { as: OWNER })).status, 503, "for the owner too");
  assert.equal((await api("GET", "admin/overview", { as: B })).status, 200, "the admin area stays reachable");
  assert.equal((await api("GET", "me", { as: A })).status, 200);
  assert.ok((await api("GET", "admin/audit", { as: OWNER })).body.rows.some(r => r.action === "settings.change" && JSON.stringify(r.detail).includes("feat_projects")), "audited");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_ed_test: true, feat_projects: true } } })).status, 200);
  assert.deepEqual(await featOff(), []);
  assert.equal((await api("GET", "projects", { as: A })).status, 200);
  // collab gets its identity tickets from live/ticket: switching Live sessions off alone must not stop collab joiners
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_live: false } } })).status, 200);
  assert.equal((await api("POST", "live/ticket", { as: A, body: { aud: "collab:abc123" } })).status, 200, "ticket still issued while Collab is on");
  assert.equal((await api("POST", "live/start", { as: A, body: { code: "abc123" } })).status, 503, "but live itself is off");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_collab: false } } })).status, 200);
  assert.equal((await api("POST", "live/ticket", { as: A, body: { aud: "collab:abc123" } })).status, 503, "both off: refused");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_live: true, feat_collab: true } } })).status, 200);
  // map lookups serve the list AND the player: refused only when both are off
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_songs: false } } })).status, 200);
  assert.equal((await api("GET", "osu/search?q=a", { as: A })).status, 503, "the list's search is off with Beatmap list");
  assert.notEqual((await api("GET", "osu/set?id=1", { as: A })).status, 503, "opening a map still works (the player is on)");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_preview: false } } })).status, 200);
  assert.equal((await api("GET", "osu/set?id=1", { as: A })).status, 503, "both off: refused");
  assert.equal((await api("POST", "admin/features", { as: B, body: { values: { feat_songs: true, feat_preview: true } } })).status, 200);
  assert.deepEqual(await featOff(), []);
  const lim = await api("POST", `admin/users/${A}`, { as: B, body: { max_project_bytes: 45000000, note: "ok" } });
  assert.equal(lim.status, 200); assert.equal(lim.body.user.limits.max_project_bytes, 45000000);
  assert.equal((await api("GET", "me", { as: A })).body.limits.max_project_bytes, 45000000, "the user sees their own limit");
  assert.equal((await api("POST", `admin/users/${C}`, { as: B, body: { role: "admin" } })).status, 403);
  assert.equal((await api("POST", `admin/users/${OWNER}/status`, { as: B, body: { status: "suspended" } })).status, 403);
  const p = await newProject(A);
  const detail = await api("GET", `admin/projects/${p.id}`, { as: B });
  assert.equal(detail.status, 200); assert.equal(detail.body.project.limit_bytes, 45000000);
  const to = new Date(Date.now() + 20 * 864e5).toISOString();
  assert.equal((await api("POST", `admin/projects/${p.id}/expiry`, { as: B, body: { expiresAt: to } })).status, 200);
  assert.equal(new Date((await api("GET", `projects/${p.id}`, { as: A })).body.project.expires_at).getTime(), new Date(to).getTime());
  await api("POST", `admin/users/${A}`, { as: OWNER, body: { max_project_bytes: null } });
  const set = await api("POST", "admin/settings", { as: OWNER, body: { values: { retention_days: 20 } } });
  assert.equal(set.status, 200); assert.deepEqual(Object.keys(set.body.changed), ["retention_days"]);
  assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: { retention_days: 9999 } } })).status, 400);
  await api("POST", "admin/settings", { as: OWNER, body: { values: { retention_days: 15 } } });
  assert.equal((await api("DELETE", `admin/admins/${B}`, { as: OWNER, body: {} })).status, 200);
  assert.equal((await api("GET", "admin/overview", { as: B })).status, 403, "removed at once");
  assert.equal((await api("POST", "admin/admins", { as: OWNER, body: { user: "nobody-here" } })).status, 404);
  const audit = (await api("GET", "admin/audit?action=admin.", { as: OWNER })).body.rows.map(r => r.action);
  assert.ok(audit.includes("admin.add") && audit.includes("admin.remove"));
});

test("share link: anyone with the link opens the project read-only without logging in; off/reset stop old links", async () => {
  const p = await newProject(A), osuf = new TextEncoder().encode("osu file format v14\r\n"), song = bytes(3000, 3);
  assert.equal((await save(A, p.id, 0, [["map.osu", osuf], ["song.mp3", song]])).commit.status, 200);
  assert.equal((await api("POST", `projects/${p.id}/link`, { as: B, body: { mode: "on" } })).status, 404, "strangers can't make links");
  const on = await api("POST", `projects/${p.id}/link`, { as: A, body: { mode: "on" } });
  assert.equal(on.status, 200); const key = on.body.link_key; assert.match(key, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await api("POST", `projects/${p.id}/link`, { as: A, body: { mode: "on" } })).body.link_key, key, "turning it on again keeps the link");
  assert.equal((await api("GET", `projects/${p.id}`, { as: A })).body.project.link_key, key);
  const open = await api("GET", `link/${p.id}?key=${key}`);
  assert.equal(open.status, 200); assert.equal(open.body.project.role, "link"); assert.deepEqual(open.body.project.members, []);
  const f = open.body.project.files.find(x => x.path === "song.mp3");
  assert.equal(Buffer.compare(Buffer.from(await (await fetch(abs(f.url))).arrayBuffer()), Buffer.from(song)), 0, "the files download");
  assert.equal((await api("GET", `link/${p.id}?key=${"x".repeat(32)}`)).status, 404, "a wrong key gets nothing");
  assert.equal((await api("POST", `projects/${p.id}/saves`, { as: B, body: { baseRevision: 1, files: [] } })).status, 404, "the link never gives edit access");
  const reset = await api("POST", `projects/${p.id}/link`, { as: A, body: { mode: "reset" } });
  assert.notEqual(reset.body.link_key, key);
  assert.equal((await api("GET", `link/${p.id}?key=${key}`)).status, 404, "old link stops working");
  await api("POST", `projects/${p.id}/link`, { as: A, body: { mode: "off" } });
  assert.equal((await api("GET", `link/${p.id}?key=${reset.body.link_key}`)).status, 404);
});

test("collab: a host can check a joiner's login and role in the host's project", async () => {
  const p = await newProject(A);
  await api("POST", `projects/${p.id}/members`, { as: A, body: { user: "TestMapper", role: "viewer" } });
  const aud = "collab:abcdef", tk = (id, a) => auth.sign({ id, username: "u" + id, kind: "ticket", aud: a, exp: Date.now() + 36e5 }, auth.cfg({ headers: { host: "x" } }));
  const ticket = tk(B, aud);
  const v = await api("POST", "collab/verify", { as: A, body: { ticket, aud, project: p.id } });
  assert.equal(v.body.ok, true); assert.equal(v.body.role, "viewer");
  assert.equal((await api("POST", "collab/verify", { as: A, body: { ticket: tk(C, aud), aud, project: p.id } })).body.role, null);
  assert.equal((await api("POST", "collab/verify", { as: A, body: { ticket: "forged.ticket", aud, project: p.id } })).body.ok, false);
  // made for another session, or for nobody in particular (passed on by someone): refused
  assert.equal((await api("POST", "collab/verify", { as: A, body: { ticket: tk(B, "collab:zzzzzz"), aud, project: p.id } })).body.ok, false);
  assert.equal((await api("POST", "collab/verify", { as: A, body: { ticket: tk(B, undefined), aud, project: p.id } })).body.ok, false);
  assert.equal((await api("POST", "collab/verify", { as: A, body: { ticket: tk(B, "live:abcdef"), aud: "live:abcdef", project: p.id } })).body.ok, false, "collab tickets only");
  assert.equal((await api("POST", "collab/verify", { as: C, body: { ticket, aud, project: p.id } })).status, 404, "only people in the project can ask");
});

test("live tickets: made for one audience, refused anywhere else; none for Google-only logins", async () => {
  const verify = require(join(root, "api/auth/verify.js"));
  const check = async (ticket, aud) => { let out = ""; await verify({ method: "POST", headers: {}, body: { ticket, aud } }, { statusCode: 200, setHeader() {}, end(b) { out = b; } }); return JSON.parse(out).ok; };
  const r = await api("POST", "live/ticket", { as: A, body: { aud: "live:abcdef" } });
  assert.equal(r.status, 200);
  assert.equal(await check(r.body.ticket, "live:abcdef"), true);
  assert.equal(await check(r.body.ticket, "live:ghjkmn"), false, "another session");
  assert.equal(await check(r.body.ticket, "live:abcdef:somepeer"), false, "the host's check of a guest isn't a guest's check of the host");
  assert.equal(await check(r.body.ticket, undefined), false);
  assert.equal((await api("POST", "live/ticket", { as: A, body: { aud: "anything" } })).status, 400);
  assert.equal((await api("POST", "live/ticket", { body: { aud: "live:abcdef" } })).status, 401);
});

test("osu! user pages: profile and paged beatmaps through the server, cached", async () => {
  const u = await api("GET", "osu/user?u=TestMapper");
  assert.equal(u.status, 200); assert.equal(u.body.user.id, B); assert.equal(u.body.user.counts.graveyard, 45);
  const s = await api("GET", `osu/beatmaps?id=${B}&type=graveyard&offset=40&limit=20`);
  assert.equal(s.body.sets.length, 5);
  assert.equal((await api("GET", "osu/beatmaps?id=1&type=hacked")).status, 400);
  assert.equal((await api("GET", "osu/user?u=" + encodeURIComponent("../../x"))).status, 400);
  // profile details: groups with modes, badges, highest rank
  assert.deepEqual(u.body.user.groups.map(g => [g.short, g.playmodes.join()]), [["BN", "osu"]]);
  assert.equal(u.body.user.badges.length, 1); assert.equal(u.body.user.stats.rank_highest.rank, 9876); assert.equal(u.body.user.medals, 2);
});

test("osu! data: mapping activity, beatmap search with genre/language/tags, tags, one beatmapset", async () => {
  const a = await api("GET", `osu/activity?id=${B}`);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.events.map(e => e.type), ["beatmapsetApprove", "beatmapsetUpload", "beatmapPlaycount"]); // "rank" (a score) is left out
  assert.equal(a.body.events[0].sid, 1001); assert.equal(a.body.events[0].approval, "ranked"); assert.equal(a.body.events[2].bid, 10012);
  assert.equal(a.body.kudosu[0].sid, 555);
  const all = await api("GET", "osu/search?s=any");
  assert.equal(all.status, 200); assert.equal(all.body.total, 49); assert.equal(all.body.sets.length, 49); assert.ok("genre_id" in all.body.sets[0]);
  const anime = await api("GET", "osu/search?s=ranked&g=3&l=3");
  assert.deepEqual(anime.body.sets.map(x => x.id).sort(), [1001, 1003]);
  const tagged = await api("GET", "osu/search?s=any&q=" + encodeURIComponent('tag="style/clean"'));
  assert.deepEqual(tagged.body.sets.map(x => x.id).sort(), [1001, 1003]);
  const page2 = await api("GET", "osu/search?s=any&cursor=" + encodeURIComponent(String(20)));
  assert.equal(page2.body.sets[0].id, all.body.sets[20].id);
  assert.equal((await api("GET", "osu/search?e=" + encodeURIComponent("<x>"))).status, 400);
  assert.equal((await api("GET", "osu/search?g=abc")).status, 400);
  const t = await api("GET", "osu/tags");
  assert.equal(t.body.tags.length, 4); assert.equal(t.body.tags[1].name, "tech/slider tech");
  const s = await api("GET", "osu/set?id=1001");
  assert.equal(s.status, 200); assert.equal(s.body.set.genre.name, "Anime"); assert.equal(s.body.set.language.name, "Japanese");
  assert.deepEqual(s.body.set.map_tags[0].tags.map(x => x.name + ":" + x.count), ["tech/slider tech:10", "style/clean:9"]);
  assert.deepEqual(s.body.set.nominators.map(n => n.username + ":" + n.groups.join()), ["NomA:BN", "NomB:NAT"]);
  assert.equal(s.body.set.rating.avg, 9.6);
  // what the detail panel shows per difficulty and per set (public fields only; the object counts come through, a missing one stays null)
  const bm = s.body.set.beatmaps[1];
  assert.deepEqual([bm.count_circles, bm.count_sliders, bm.count_spinners, bm.max_combo, bm.hit_length, bm.status, bm.playcount, bm.passcount], [400, 150, 2, 1050, 110, "ranked", 90, 10]);
  assert.equal(s.body.set.beatmaps[0].count_spinners, 0, "0 spinners is a count, not a missing value");
  assert.equal(bm.url, "https://osu.ppy.sh/beatmaps/" + bm.id); assert.equal(bm.last_updated, "2020-02-01T00:00:00Z");
  assert.deepEqual([s.body.set.ranked_date, s.body.set.last_updated, s.body.set.submitted_date, s.body.set.artist_unicode], ["2020-03-01T00:00:00Z", "2020-02-01T00:00:00Z", "2020-01-01T00:00:00Z", "Artist 1"]);
  assert.match(s.body.set.title_unicode, /^Song 1 /);
  assert.ok(!("access_token" in s.body.set) && !("token" in s.body.set));
  const lean = (await api("GET", `osu/beatmaps?id=${B}&type=guest&offset=0&limit=20`)).body.sets.find(x => x.id === 3002);
  assert.deepEqual(lean.beatmaps.map(b => [b.count_circles, b.count_sliders, b.count_spinners, b.max_combo, b.url]), [[null, null, null, null, null], [null, null, null, null, null]], "absent stays null (never 0)");
  assert.equal((await api("GET", "osu/set?id=999999")).status, 404);
  assert.equal((await api("GET", "osu/beatmap?id=10012")).body.set_id, 1001);
  assert.equal((await api("GET", "osu/beatmap?id=5")).status, 404);
});

test("osu! lookup by checksum (finds the map of a replay): validated, found, unknown, cached", async () => {
  const hits = () => osuCalls.filter(p => p === "/api/v2/beatmaps/lookup").length, h0 = hits(); // (bad checksums below must not reach osu!)
  const ip = { "x-real-ip": "10.79.0.1" }; // (its own address: the other osu! tests use up the per-IP minute of 127.0.0.1)
  const get = (route, o = {}) => api("GET", route, { headers: ip, ...o });
  for (const bad of ["", "abc", "z".repeat(32), "a".repeat(31), "a".repeat(33), LOOKUP_MD5 + "&x=1", "../" + "a".repeat(29)])
    assert.equal((await get("osu/lookup?checksum=" + encodeURIComponent(bad))).status, 400, "bad checksum: " + bad);
  assert.equal((await get("osu/lookup")).status, 400);
  const r = await get("osu/lookup?checksum=" + LOOKUP_MD5.toUpperCase()); // (upper case is accepted)
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { beatmap_id: 10012, beatmapset_id: 1001, version: "Insane", mode: 0, status: "ranked", title: "Song 1", artist: "Artist 1", creator: "TestMapper",
    cs: 4, ar: 9, od: 8, hp: 6, stars: 5.3, length: 120, checksum: LOOKUP_MD5 });
  assert.equal(hits(), h0 + 1);
  assert.equal((await get("osu/lookup?checksum=" + LOOKUP_MD5)).status, 200);
  assert.equal(hits(), h0 + 1, "the second answer came from the cache");
  const unknown = "0".repeat(32);
  assert.deepEqual((await get("osu/lookup?checksum=" + unknown)).body, { error: "not_found" });
  assert.equal((await get("osu/lookup?checksum=" + unknown)).status, 404);
  assert.equal(hits(), h0 + 2, "an unknown hash is cached too");
});

test("osu! lookup follows the Beatmap list / Preview switches", async () => {
  const ip = { "x-real-ip": "10.79.0.2" }, url = "osu/lookup?checksum=" + LOOKUP_MD5;
  const set = async v => assert.equal((await api("POST", "admin/features", { as: OWNER, body: { values: v } })).status, 200);
  try {
    await set({ feat_songs: false });
    assert.equal((await api("GET", url, { as: A, headers: ip })).status, 200, "the player is on: a replay can still find its map");
    await set({ feat_preview: false });
    const off = await api("GET", url, { as: A, headers: ip });
    assert.equal(off.status, 503); assert.equal(off.body.error, "feature_disabled");
    await set({ feat_songs: true });
    assert.equal((await api("GET", url, { as: A, headers: ip })).status, 200, "Beatmap list on again");
    await set({ feat_songs: false, feat_preview: true });
    assert.equal((await api("GET", url, { as: A, headers: ip })).status, 200);
  } finally { await set({ feat_songs: true, feat_preview: true }); }
  assert.deepEqual((await api("GET", "me")).body.features.off, []);
});

// ---- the top 50 scores of a replay's map: GET osu/scores?id= (every layer limits: per IP, osu! budget, cache, one request for the same map at once) ----
const osuLib = () => require(join(root, "api/_lib/osu.js")); // (the server runs in this process: its buckets and memory can be set)
const scoresHits = id => osuHits["/api/v2/beatmaps/" + id + "/scores"] || 0;
const fillBuckets = () => { const o = osuLib(), b = o._buckets; b.scores.t = o.BUDGET.scoresBurst; b.scores.at = Date.now(); b.main.t = o.BUDGET.burst; b.main.at = Date.now(); };
let ipN = 0; const freshIp = () => { ipN++; return { "x-real-ip": "10.78." + (ipN >> 8) + "." + (ipN & 255) }; }; // (each call its own address: the per-IP minute is tested on its own)
const scoresGet = (id, o = {}) => api("GET", "osu/scores?id=" + id, { headers: freshIp(), ...o });
const SC_KEYS = ["acc", "combo", "date", "grade", "miss", "mods", "n100", "n300", "n50", "pp", "rank", "score", "user"];

test("osu! scores: trimmed list for the legacy and the lazer shape, 50 at most, cached", async () => {
  fillBuckets();
  const r = await scoresGet(SCORES_LEGACY);
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "public, max-age=300, s-maxage=600");
  assert.deepEqual(Object.keys(r.body).sort(), ["beatmap_id", "scores"]); assert.equal(r.body.beatmap_id, SCORES_LEGACY);
  const [a, b, c] = r.body.scores;
  assert.deepEqual(r.body.scores.map(x => x.rank), [1, 2, 3]);
  assert.deepEqual(a, { rank: 1, user: { id: 101, name: "Player1", country: "TH", avatar: "https://a.ppy.sh/101" }, score: 12345677, acc: 0.9866, combo: 1233, mods: ["HD", "DT"], grade: "S", pp: 321.46,
    date: "2026-09-01T10:00:00.000Z", n300: 900, n100: 10, n50: 2, miss: 1 });
  assert.deepEqual(b.user, { id: 102, name: "A".repeat(32), country: "JP", avatar: "" }, "name capped, country upper case, http avatar dropped");
  assert.deepEqual([b.mods, b.grade, b.pp], [[], "A", null]);
  assert.deepEqual(c, { rank: 3, user: { id: 103, name: "Player3", country: "TH", avatar: "https://a.ppy.sh/103" }, score: 777, acc: 1, combo: 0, mods: ["NC"], grade: "", pp: 321.46,
    date: "", n300: 0, n100: 0, n50: 0, miss: 0 }); // (total_score fallback, accuracy clamped, junk mods and grade and date dropped)
  assert.ok(r.body.scores.every(x => Object.keys(x).sort().join() === SC_KEYS.join() && Object.keys(x.user).sort().join() === "avatar,country,id,name"), "nothing else is passed on");
  assert.ok(JSON.stringify(r.body).length < 2000, "no raw osu! data");
  const l = await scoresGet(SCORES_LAZER);
  assert.deepEqual(l.body.scores, [
    { rank: 1, user: { id: 201, name: "Lazer1", country: "KR", avatar: "https://a.ppy.sh/201" }, score: 987654, acc: 1, combo: 500, mods: ["HD", "DT"], grade: "XH", pp: null, date: "2026-09-02T11:00:00.000Z", n300: 500, n100: 0, n50: 0, miss: 0 },
    { rank: 2, user: { id: 202, name: "Lazer2", country: "JP", avatar: "https://a.ppy.sh/202" }, score: 900000, acc: 0.97, combo: 450, mods: [], grade: "S", pp: 12.35, date: "2026-09-03T11:00:00.000Z", n300: 480, n100: 18, n50: 2, miss: 0 }]);
  const many = await scoresGet(SCORES_MANY);
  assert.equal(many.body.scores.length, 50, "sixty from osu!, fifty out"); assert.equal(many.body.scores[49].rank, 50);
  assert.deepEqual([SCORES_LEGACY, SCORES_LAZER, SCORES_MANY].map(scoresHits), [1, 1, 1]);
  const again = await scoresGet(SCORES_LEGACY);
  assert.deepEqual(again.body, r.body); assert.equal(scoresHits(SCORES_LEGACY), 1, "the second answer came from the cache");
});

test("osu! scores: asked with x-api-version 20220705 (the lazer shape): a score set on lazer is no longer 0, nothing else changes", async () => {
  fillBuckets();
  const path = "/api/v2/beatmaps/" + SCORES_VERSIONED + "/scores";
  const r = await scoresGet(SCORES_VERSIONED);
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "public, max-age=300, s-maxage=600");
  assert.equal(osuApiVersions[path], "20220705", "the scores call carries the header"); assert.equal(osuLib()._scores.apiVersion, "20220705");
  assert.equal((await api("GET", "osu/lookup?checksum=" + "6".repeat(32), { headers: freshIp() })).status, 404);
  assert.equal(osuApiVersions["/api/v2/beatmaps/lookup"], "", "other osu! calls don't send it");
  assert.deepEqual(r.body, { beatmap_id: SCORES_VERSIONED, scores: [
    { rank: 1, user: { id: 301, name: "StableOne", country: "DE", avatar: "https://a.ppy.sh/301" }, score: 12500000, acc: 0.9876, combo: 980, mods: ["HD"], grade: "S", pp: 250.5,
      date: "2024-05-01T10:00:00.000Z", n300: 690, n100: 8, n50: 1, miss: 1 }, // (set on stable: its stable score, as before; the CL osu! adds to stable scores is not a mod the player chose)
    { rank: 2, user: { id: 302, name: "LazerOne", country: "KR", avatar: "https://a.ppy.sh/302" }, score: 11650000, acc: 0.9952, combo: 1000, mods: ["HD", "DT"], grade: "SH", pp: 260.25,
      date: "2025-02-03T04:05:06.000Z", n300: 695, n100: 5, n50: 0, miss: 0 }, // (set on lazer: classic_total_score, not the standardised total_score)
    { rank: 3, user: { id: 303, name: "ClassicFan", country: "FR", avatar: "https://a.ppy.sh/303" }, score: 9000000, acc: 0.9, combo: 300, mods: ["CL", "NF"], grade: "B", pp: null,
      date: "2025-03-01T00:00:00.000Z", n300: 600, n100: 80, n50: 10, miss: 10 }] }); // (a lazer player who chose Classic keeps it)
  assert.ok(r.body.scores.every(x => Object.keys(x).sort().join() === SC_KEYS.join() && Object.keys(x.user).sort().join() === "avatar,country,id,name" && x.mods.every(m => typeof m === "string")));
  // the same plays in the legacy shape (what osu! answered before, without the header): the same rows, except that the lazer scores were 0
  const old = await fetch("http://127.0.0.1:54331" + path + "?mode=osu&type=global", { headers: { authorization: "Bearer mock-token" } }).then(x => x.json());
  assert.equal(osuApiVersions[path], "");
  const before = osuLib()._scores.trim(old);
  assert.deepEqual(before.map(x => x.score), [12500000, 0, 0], "before: lazer scores came as 0");
  assert.deepEqual(r.body.scores.map(x => ({ ...x, score: 0 })), before.map(x => ({ ...x, score: 0 })), "everything but the lazer scores is the same as before");
  assert.equal(r.body.scores[0].score, before[0].score);
  // a lazer-shape score without classic_total_score: the legacy score, else the standardised total (the last resort), never a mix within a row
  const t = osuLib()._scores.trim({ scores: [{ legacy_total_score: 0, total_score: 654321, mods: [{ acronym: "HR", settings: {} }, { acronym: "CL" }], legacy_score_id: null, statistics: { great: 3 } },
    { legacy_total_score: 5000, classic_total_score: 7000, total_score: 900000, mods: [{ acronym: "CL" }], legacy_score_id: 77 }] });
  assert.deepEqual(t.map(x => [x.score, x.mods, x.n300]), [[654321, ["HR", "CL"], 3], [5000, [], 0]]);
});

test("osu! scores: bad id, unknown map and a map without scores", async () => {
  fillBuckets();
  const h0 = osuCalls.length;
  for (const bad of ["", "abc", "12x", "-1", "12345678901", "1/2", "7001%2F..", "1.5"]) {
    const r = await api("GET", "osu/scores?id=" + bad, { headers: freshIp() });
    assert.equal(r.status, 400, "id: " + bad); assert.equal(r.body.error, "bad_request"); assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal((await api("GET", "osu/scores", { headers: freshIp() })).status, 400);
  assert.equal(osuCalls.length, h0, "bad ids never reach osu!");
  const u = await scoresGet(6990); // (unknown to the mock: osu! answers 404)
  assert.equal(u.status, 200); assert.deepEqual(u.body, { beatmap_id: 6990, scores: [] }); assert.equal(u.headers.get("cache-control"), "public, max-age=300, s-maxage=600");
  assert.equal(scoresHits(6990), 1);
  assert.deepEqual((await scoresGet(6990)).body, { beatmap_id: 6990, scores: [] }); assert.equal(scoresHits(6990), 1, "a 404 is cached too");
  const e = await scoresGet(SCORES_EMPTY);
  assert.deepEqual(e.body, { beatmap_id: SCORES_EMPTY, scores: [] }); await scoresGet(SCORES_EMPTY); assert.equal(scoresHits(SCORES_EMPTY), 1, "an empty list is cached too");
});

test("osu! scores: requests for the same map at once share one request to osu!", async () => {
  fillBuckets();
  const id = 7100, before = osuLib()._buckets.scores.t;
  const rs = await Promise.all(Array.from({ length: 6 }, () => scoresGet(id)));
  assert.ok(rs.every(r => r.status === 200 && r.body.scores.length === 1 && r.body.beatmap_id === id));
  assert.equal(scoresHits(id), 1, "six at once, one request to osu!");
  assert.ok(before - osuLib()._buckets.scores.t < 1.5, "and one token");
  assert.equal(osuLib()._scores.pending.size, 0, "nothing left pending");
  await scoresGet(id); assert.equal(scoresHits(id), 1);
  // a failure is shared too and then forgotten: the pending entry doesn't stick
  fillBuckets(); osuLib()._buckets.scores.t = 0;
  const bad = await Promise.all([scoresGet(7101), scoresGet(7101)]);
  assert.deepEqual(bad.map(r => r.status), [429, 429]); assert.equal(osuLib()._scores.pending.size, 0);
  assert.equal(scoresHits(7101), 0);
});

test("osu! scores: 6 a minute per IP (its own limit, not the 40 of the other osu! routes)", async () => {
  fillBuckets();
  const ip = { "x-real-ip": "10.77.0.1" };
  for (let i = 0; i < 6; i++) assert.equal((await api("GET", "osu/scores?id=" + SCORES_LEGACY, { headers: ip })).status, 200, "call " + (i + 1));
  const seventh = await api("GET", "osu/scores?id=" + SCORES_LEGACY, { headers: ip });
  assert.equal(seventh.status, 429); assert.equal(seventh.body.error, "too_many_requests"); assert.equal(seventh.headers.get("retry-after"), "60"); assert.equal(seventh.headers.get("cache-control"), "no-store");
  assert.equal((await api("GET", "osu/scores?id=bad", { headers: ip })).status, 429, "bad ids count too");
  // the scores calls do not use up the IP's 40 a minute for the rest of osu!, and the lookups do not count for the scores
  const ip2 = { "x-real-ip": "10.77.0.2" }, unknown = "1".repeat(32);
  for (let i = 0; i < 6; i++) assert.equal((await api("GET", "osu/scores?id=" + SCORES_LEGACY, { headers: ip2 })).status, 200);
  for (let i = 0; i < 40; i++) assert.equal((await api("GET", "osu/lookup?checksum=" + unknown, { headers: ip2 })).status, 404, "lookup " + (i + 1));
  assert.equal((await api("GET", "osu/lookup?checksum=" + unknown, { headers: ip2 })).status, 429, "the 41st lookup");
  const ip3 = { "x-real-ip": "10.77.0.3" };
  for (let i = 0; i < 40; i++) await api("GET", "osu/lookup?checksum=" + unknown, { headers: ip3 });
  assert.equal((await api("GET", "osu/scores?id=" + SCORES_LEGACY, { headers: ip3 })).status, 200, "the scores have their own count");
});

test("osu! scores: osu! budget of their own (3 at once, 6 a minute); the pages keep working", async () => {
  fillBuckets();
  const o = osuLib(), b = o._buckets;
  assert.deepEqual([o.BUDGET.scoresPerMin, o.BUDGET.scoresBurst, o.BUDGET.scoresReserve], [6, 3, 12]);
  const mainBefore = b.main.t;
  for (const id of [7102, 7103, 7104]) assert.equal((await scoresGet(id)).status, 200);
  assert.ok(mainBefore - b.main.t >= 2 && mainBefore - b.main.t < 4, "each also takes one from the main bucket: " + (mainBefore - b.main.t));
  const busy = await scoresGet(7105);
  assert.equal(busy.status, 429); assert.equal(busy.body.error, "osu_busy"); assert.ok(+busy.headers.get("retry-after") >= 1 && +busy.headers.get("retry-after") <= 10, "Retry-After: " + busy.headers.get("retry-after"));
  assert.equal(busy.headers.get("cache-control"), "no-store"); assert.equal(scoresHits(7105), 0, "osu! was not asked");
  assert.equal((await scoresGet(7102)).status, 200, "what is cached is still served");
  assert.equal((await api("GET", "osu/lookup?checksum=" + "2".repeat(32), { headers: freshIp() })).status, 404, "the site's pages draw from the main bucket and still work");
  assert.equal((await api("GET", "osu/set?id=1001", { headers: freshIp() })).status, 200);
  b.scores.t = 1; b.scores.at = Date.now(); assert.equal((await scoresGet(7105)).status, 200, "a token comes back with time");
  assert.equal((await scoresGet(7106)).status, 429, "and is spent");
});

test("osu! scores: only while the main bucket keeps a reserve (12 left)", async () => {
  fillBuckets();
  const b = osuLib()._buckets;
  b.main.t = 11; b.main.at = Date.now();
  const busy = await scoresGet(7107);
  assert.equal(busy.status, 429); assert.equal(busy.body.error, "osu_busy"); assert.ok(+busy.headers.get("retry-after") >= 1);
  assert.equal(scoresHits(7107), 0); assert.ok(b.scores.t >= 2.9, "no scores token was spent");
  assert.equal((await api("GET", "osu/lookup?checksum=" + "3".repeat(32), { headers: freshIp() })).status, 404, "the pages still work below the reserve");
  b.main.t = 12.5; b.main.at = Date.now();
  assert.equal((await scoresGet(7107)).status, 200, "with the reserve in place they are served");
  b.main.t = 0; b.main.at = Date.now();
  assert.equal((await scoresGet(7108)).status, 429); assert.equal(scoresHits(7108), 0);
  fillBuckets();
});

test("osu! scores follow the Replays switch only", async () => {
  fillBuckets();
  const set = async v => assert.equal((await api("POST", "admin/features", { as: OWNER, body: { values: v } })).status, 200);
  try {
    await set({ feat_songs: false, feat_preview: false, feat_mappers: false });
    assert.equal((await scoresGet(SCORES_LEGACY, { as: A })).status, 200, "the map lists being off does not matter");
    await set({ feat_songs: true, feat_preview: true, feat_mappers: true, feat_replays: false });
    const off = await scoresGet(SCORES_LEGACY, { as: A });
    assert.equal(off.status, 503); assert.equal(off.body.error, "feature_disabled"); assert.equal(off.headers.get("cache-control"), "no-store");
    assert.equal((await api("GET", "osu/lookup?checksum=" + "4".repeat(32), { headers: freshIp() })).status, 404, "the rest of osu! is not affected");
    await set({ feat_replays: true });
    assert.equal((await scoresGet(SCORES_LEGACY, { as: A })).status, 200);
  } finally { await set({ feat_songs: true, feat_preview: true, feat_mappers: true, feat_replays: true }); }
  assert.deepEqual((await api("GET", "me")).body.features.off, []);
});

test("osu! scores are a guest area like the map lookup on an invite-only site", async () => {
  fillBuckets();
  const P = 5511;
  try {
    await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
    await api("GET", "me", { as: P }); // (refreshes the server's cached switch)
    const g = await scoresGet(SCORES_LEGACY);
    assert.equal(g.status, 200); assert.equal(g.body.scores.length, 3);
    assert.equal(g.headers.get("cache-control"), "private, max-age=300", "behind the gate the answer stays out of the shared cache");
    assert.equal((await scoresGet(SCORES_LEGACY, { as: P })).status, 200);
    assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: { perm_guest_listing: false, perm_guest_player: false } } })).status, 200);
    assert.equal((await scoresGet(SCORES_LEGACY)).status, 401, "guest areas off: a guest gets nothing");
    assert.equal((await scoresGet(SCORES_LEGACY, { as: P })).status, 403, "a member without access neither");
    assert.equal((await scoresGet(SCORES_LEGACY, { as: OWNER })).status, 200, "admins always");
    assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: { perm_guest_listing: false, perm_guest_player: true } } })).status, 200);
    assert.equal((await scoresGet(SCORES_LEGACY)).status, 200, "the player area alone is enough (like the lookup)");
  } finally {
    await api("POST", "admin/settings", { as: OWNER, body: { values: { perm_guest_listing: true, perm_guest_player: true, perm_guest_mappers: true } } });
    await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
    await api("GET", "me", { as: P });
  }
});

test("osu! scores: osu! refusing the path (403) -> scores_unavailable, and osu! is left alone for an hour", async () => {
  fillBuckets();
  const lib = osuLib(), mem = lib._scores.off;
  try {
    const r = await scoresGet(SCORES_DENIED);
    assert.equal(r.status, 503); assert.equal(r.body.error, "scores_unavailable"); assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(scoresHits(SCORES_DENIED), 1);
    const left = mem.until - Date.now();
    assert.ok(left > 3590000 && left <= 3600000, "remembered for an hour: " + left);
    const h = osuCalls.length;
    const other = await scoresGet(7109);
    assert.equal(other.status, 503); assert.equal(other.body.error, "scores_unavailable"); assert.equal(scoresHits(7109), 0, "another map does not reach osu! either");
    assert.equal((await scoresGet(SCORES_DENIED)).status, 503); assert.equal(scoresHits(SCORES_DENIED), 1);
    assert.equal(osuCalls.length, h, "no call at all (not even for a token)");
    assert.equal((await api("GET", "osu/lookup?checksum=" + "5".repeat(32), { headers: freshIp() })).status, 404, "the rest of osu! is not affected");
    assert.ok(lib._buckets.scores.t > 1.5, "refused calls spend nothing more");
    mem.until = Date.now() - 1; // (an hour later)
    assert.equal((await scoresGet(7109)).status, 200, "asks again after the hour");
    assert.equal(scoresHits(7109), 1);
  } finally { mem.until = 0; }
});

test("invite-only: without an approved account only me, the request and the changelog answer; admins approve", async () => {
  const P = 5501, Q = 5502;
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  const me0 = await api("GET", "me", { as: P }); // also refreshes the server's cached switch
  assert.equal(me0.body.gate, true); assert.equal(me0.body.access, "none");
  // guests: the Beatmap page, the player and mapper pages by default, nothing online
  assert.equal((await api("GET", "osu/tags")).status, 200);
  assert.equal((await api("GET", "osu/lookup?checksum=" + LOOKUP_MD5, { headers: { "x-real-ip": "10.79.0.3" } })).status, 200, "a replay's map lookup is a guest area (listing/player) too");
  assert.equal((await api("GET", "osu/user?u=1")).status !== 401, true);
  assert.equal((await api("GET", "projects")).status, 401);
  assert.equal((await api("GET", "projects", { as: P })).status, 403);
  assert.deepEqual(me0.body.perms.guest, { listing: true, player: true, mappers: true, editor: false, online: false, live: false });
  // an admin turns the guest areas off: guests get nothing again
  const off = { perm_guest_listing: false, perm_guest_player: false, perm_guest_mappers: false };
  assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: off } })).status, 200);
  assert.equal((await api("GET", "osu/tags")).status, 401);
  assert.equal((await api("GET", "osu/lookup?checksum=" + LOOKUP_MD5, { headers: { "x-real-ip": "10.79.0.3" } })).status, 401, "guest areas off: no lookup either");
  assert.equal((await api("GET", "osu/tags", { as: P })).status, 403);
  assert.equal((await api("GET", "changelog")).status, 200);
  // ask (twice: the second only updates the message)
  const r1 = await api("POST", "access/request", { as: P, body: { message: "hi, I mod for my friends" } });
  assert.equal(r1.status, 200); assert.equal(r1.body.access, "pending");
  assert.equal((await api("POST", "access/request", { as: P, body: {} })).body.access, "pending");
  assert.equal((await api("GET", "me", { as: P })).body.access, "pending");
  assert.equal((await api("GET", "osu/tags", { as: P })).status, 403);
  // not an admin: can't see or decide
  assert.equal((await api("GET", "admin/access", { as: Q })).status, 403);
  assert.equal((await api("POST", `admin/access/${P}`, { as: Q, body: { access: "approved" } })).status, 403);
  // the owner sees the request and approves
  const list = await api("GET", "admin/access?status=pending", { as: OWNER });
  assert.equal(list.status, 200); const row = list.body.rows.find(x => x.id === P);
  assert.ok(row); assert.equal(row.message, "hi, I mod for my friends"); assert.ok(list.body.counts.pending >= 1);
  assert.equal((await api("POST", `admin/access/${P}`, { as: OWNER, body: { access: "approved" } })).status, 200);
  const ok = await api("GET", "osu/tags", { as: P });
  assert.equal(ok.status, 200);
  assert.equal((await api("GET", "me", { as: P })).body.access, "approved");
  // deny: blocked again, and asking again is refused for a day
  await api("POST", "access/request", { as: Q, body: {} });
  assert.equal((await api("POST", `admin/access/${Q}`, { as: OWNER, body: { access: "denied" } })).status, 200);
  assert.equal((await api("POST", "access/request", { as: Q, body: {} })).status, 429);
  assert.equal((await api("POST", `admin/access/${OWNER}`, { as: OWNER, body: { access: "denied" } })).status, 403); // never the owner
  assert.equal((await api("POST", `admin/access/${P}`, { as: OWNER, body: { access: "bogus" } })).status, 400);
  // approve by osu! name before they ask
  const pre = await api("POST", "admin/access", { as: OWNER, body: { user: "TestMapper" } });
  assert.equal(pre.status, 200); assert.equal(pre.body.access, "approved");
  // the owner always gets in; audit has the decisions
  assert.equal((await api("GET", "osu/tags", { as: OWNER })).status, 200);
  const audit = (await emu.db.query("select action from obv.audit_log where action like 'access.%'")).rows.map(r => r.action);
  for (const a of ["access.request", "access.approved", "access.denied"]) assert.ok(audit.includes(a), a);
  // members can be limited too (admins never are)
  assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: { perm_member_online: false } } })).status, 200);
  assert.equal((await api("GET", "projects", { as: P })).status, 403);
  assert.equal((await api("GET", "projects", { as: OWNER })).status, 200);
  await api("POST", "admin/settings", { as: OWNER, body: { values: { perm_member_online: true, perm_guest_listing: true, perm_guest_player: true, perm_guest_mappers: true } } });
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
  await api("GET", "me", { as: P });
});

test("invites: a link lets people in at once up to the limit; invited people can't invite until an admin allows it", async () => {
  const INV = 6601, N1 = 6602, N2 = 6603, N3 = 6604, DEN = 6605;
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  await emu.db.query("update obv.settings set value = '2' where key = 'invites_per_user'");
  await api("GET", "me", { as: INV }); // refreshes the cached switch
  assert.equal((await api("GET", "invites", { as: INV })).status, 403); // no access yet: no invite page
  await api("POST", "access/request", { as: INV, body: {} });
  assert.equal((await api("POST", `admin/access/${INV}`, { as: OWNER, body: { access: "approved" } })).status, 200);
  const mine = await api("GET", "invites", { as: INV });
  assert.equal(mine.status, 200); assert.match(mine.body.code, /^[A-Za-z0-9]{10}$/);
  assert.equal(mine.body.limit, 2); assert.equal(mine.body.used, 0); assert.equal(mine.body.can_invite, true);
  const code = mine.body.code;
  // before logging in: whose link it is
  const info = await api("GET", "invite?code=" + code);
  assert.equal(info.status, 200); assert.equal(info.body.inviter.username, "user" + INV); assert.equal(info.body.ok, true);
  assert.equal((await api("GET", "invite?code=AAAAAAAAAA")).status, 404);
  assert.equal((await api("POST", "invite/accept", { body: { code } })).status, 401); // must log in
  // accepting lets them in right away
  const a1 = await api("POST", "invite/accept", { as: N1, body: { code } });
  assert.equal(a1.status, 200); assert.equal(a1.body.access, "approved");
  assert.equal((await api("GET", "osu/tags", { as: N1 })).status, 200);
  assert.equal((await api("GET", "me", { as: N1 })).body.access, "approved");
  assert.equal((await api("POST", "invite/accept", { as: N1, body: { code } })).body.already, true); // twice: not counted again
  // the invited person has a link, but it doesn't work until an admin allows it
  const m1 = await api("GET", "invites", { as: N1 });
  assert.equal(m1.status, 200); assert.equal(m1.body.can_invite, false);
  assert.equal((await api("GET", "invite?code=" + m1.body.code)).body.reason, "not_allowed");
  assert.equal((await api("POST", "invite/accept", { as: N3, body: { code: m1.body.code } })).status, 403);
  // someone an admin denied can't get around it with an invite
  await api("POST", "access/request", { as: DEN, body: {} });
  await api("POST", `admin/access/${DEN}`, { as: OWNER, body: { access: "denied" } });
  assert.equal((await api("POST", "invite/accept", { as: DEN, body: { code } })).status, 403);
  // second person fills the link (limit 2); a third is refused
  assert.equal((await api("POST", "invite/accept", { as: N2, body: { code } })).status, 200);
  assert.equal((await api("GET", "invite?code=" + code)).body.reason, "full");
  assert.equal((await api("POST", "invite/accept", { as: N3, body: { code } })).status, 409);
  // the admin raises this person's limit and lets the invited one invite
  assert.equal((await api("POST", `admin/users/${INV}/invites`, { as: N1, body: { invite_limit: 5 } })).status, 403); // not an admin
  const up = await api("POST", `admin/users/${INV}/invites`, { as: OWNER, body: { invite_limit: 3 } });
  assert.equal(up.status, 200); assert.equal(up.body.limit, 3); assert.equal(up.body.used, 2);
  assert.equal((await api("POST", `admin/users/${N1}/invites`, { as: OWNER, body: { can_invite: true } })).body.can_invite, true);
  assert.equal((await api("POST", `admin/users/${N1}/invites`, { as: OWNER, body: { invite_limit: -1 } })).status, 400);
  assert.equal((await api("POST", "invite/accept", { as: N3, body: { code: m1.body.code } })).status, 200);
  const panel = await api("GET", `admin/users/${N3}`, { as: OWNER });
  assert.equal(panel.body.user.invites.invited_by.id, N1);
  // a new link: the old one stops working
  const r = await api("POST", "invites/reset", { as: INV, body: {} });
  assert.notEqual(r.body.code, code); assert.equal((await api("GET", "invite?code=" + code)).status, 404);
  const mineAfter = await api("GET", "invites", { as: INV });
  assert.equal(mineAfter.body.invited.length, 2);
  // the Access tab shows who came in with an invite
  const acc = await api("GET", "admin/access?status=invited", { as: OWNER });
  assert.ok(acc.body.rows.some(x => x.id === N1 && x.invited_by === "user" + INV));
  const audit = (await emu.db.query("select action from obv.audit_log where action like 'invite.%' or action = 'access.invite'")).rows.map(x => x.action);
  for (const x of ["access.invite", "invite.limit", "invite.allow", "invite.reset"]) assert.ok(audit.includes(x), x);
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
  await api("GET", "me", { as: INV });
});

test("invites, site-wide: one switch for invited people, reset everyone; admin links with their own number of people", async () => {
  const A1 = 7701, B1 = 7702, B2 = 7703, B3 = 7704, C1 = 7705;
  const post = (as, route, body) => api("POST", route, { as, body });
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  await emu.db.query("update obv.settings set value = '3' where key = 'invites_per_user'");
  await api("GET", "me", { as: A1 });
  // an admin link for 2 people
  assert.equal((await post(A1, "admin/invite-links", { max_uses: 2 })).status, 403); // not an admin
  assert.equal((await post(OWNER, "admin/invite-links", { max_uses: 0 })).status, 400);
  const mk = await post(OWNER, "admin/invite-links", { max_uses: 2, note: "discord" });
  assert.equal(mk.status, 200); const L = mk.body.link; assert.equal(L.max_uses, 2); assert.equal(L.note, "discord"); assert.equal(L.state, "ok");
  assert.equal((await api("GET", "invite?code=" + L.code)).body.ok, true);
  assert.equal((await post(B1, "invite/accept", { code: L.code })).body.access, "approved");
  assert.equal((await post(B2, "invite/accept", { code: L.code })).body.access, "approved");
  assert.equal((await post(B3, "invite/accept", { code: L.code })).status, 409); // full
  let links = (await api("GET", "admin/invite-links", { as: OWNER })).body.links, l = links.find(x => x.code === L.code);
  assert.equal(l.uses, 2); assert.equal(l.state, "full"); assert.equal(l.joined.length, 2);
  // more room, then turn it off
  assert.equal((await post(OWNER, "admin/invite-links/update", { code: L.code, max_uses: 1 })).status, 400); // below the people already in
  assert.equal((await post(OWNER, "admin/invite-links/update", { code: L.code, max_uses: 3 })).body.link.state, "ok");
  assert.equal((await post(OWNER, "admin/invite-links/update", { code: L.code, revoke: true })).body.link.state, "inactive");
  assert.equal((await post(B3, "invite/accept", { code: L.code })).status, 403);
  // people from an admin link follow the site-wide switch: off by default, one switch turns everyone on
  const b1 = (await api("GET", "invites", { as: B1 })).body;
  assert.equal(b1.can_invite, false); assert.equal((await api("GET", "invite?code=" + b1.code)).body.reason, "not_allowed");
  const set = await post(OWNER, "admin/settings", { values: { invitees_can_invite: true } });
  assert.equal(set.status, 200);
  assert.equal((await api("GET", "invites", { as: B1 })).body.can_invite, true);
  assert.equal((await api("GET", "invites", { as: B2 })).body.can_invite, true);
  // a person's own choice wins over the switch; reset-all clears it (and own numbers)
  await post(OWNER, `admin/users/${B2}/invites`, { can_invite: false, invite_limit: 7 });
  assert.equal((await api("GET", "invites", { as: B2 })).body.can_invite, false);
  assert.equal((await post(A1, "admin/invites/reset-all", {})).status, 403);
  const rs = await post(OWNER, "admin/invites/reset-all", {});
  assert.equal(rs.status, 200); assert.ok(rs.body.switches >= 1 && rs.body.limits >= 1);
  const b2 = (await api("GET", "invites", { as: B2 })).body;
  assert.equal(b2.can_invite, true); assert.equal(b2.limit, 3);
  assert.equal((await post(C1, "invite/accept", { code: b1.code })).status, 200); // B1's own link works now
  const audit = (await emu.db.query("select action from obv.audit_log where action like 'invite.%'")).rows.map(x => x.action);
  for (const x of ["invite.link_create", "invite.link_limit", "invite.link_revoke", "invite.block", "invite.reset_all"]) assert.ok(audit.includes(x), x);
  await post(OWNER, "admin/settings", { values: { invitees_can_invite: false } });
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
  await api("GET", "me", { as: A1 });
});

test("invites: the animated invitation is only for people an admin allowed (and admins)", async () => {
  const P = 8801;
  await emu.db.query("select public.obv_user_touch(8801, 'fxuser', null, null)");
  await emu.db.query("update obv.users set access = 'approved' where osu_id = 8801");
  const mine = await api("GET", "invites", { as: P });
  assert.equal(mine.body.fx, false); assert.equal(mine.body.fx_allowed, false); // off, and not theirs to turn on yet
  assert.equal((await api("GET", "invite?code=" + mine.body.code)).body.fx, false);
  assert.equal((await api("POST", "invites/fx", { as: P, body: { on: "no" } })).status, 400);
  assert.equal((await api("POST", "invites/fx", { as: P, body: { on: true } })).status, 403);
  assert.equal((await api("POST", `admin/users/${P}/invite-fx`, { as: P, body: { on: true } })).status, 403); // not an admin
  assert.equal((await api("POST", `admin/users/${P}/invite-fx`, { as: OWNER, body: { on: true } })).body.fx_allowed, true);
  assert.equal((await api("POST", "invites/fx", { as: P, body: { on: true } })).body.fx, true);
  assert.equal((await api("GET", "invite?code=" + mine.body.code)).body.fx, true);
  assert.equal((await api("GET", `admin/users/${P}`, { as: OWNER })).body.user.invites.fx_allowed, true);
  // taken away: the link is back to the normal page at once
  await api("POST", `admin/users/${P}/invite-fx`, { as: OWNER, body: { on: false } });
  assert.equal((await api("GET", "invite?code=" + mine.body.code)).body.fx, false);
  assert.equal((await api("GET", "invites", { as: P })).body.fx, false);
  assert.equal((await api("POST", "invites/fx", { body: { on: true } })).status, 401);
  // the owner can always
  assert.equal((await api("POST", "invites/fx", { as: OWNER, body: { on: true } })).body.fx, true);
  const audit = (await emu.db.query("select action from obv.audit_log where action like 'invite.fx%'")).rows.map(x => x.action);
  for (const x of ["invite.fx_allow", "invite.fx_block"]) assert.ok(audit.includes(x), x);
});

test("live sessions: TURN relay only for a started session, per-person relay and the ping limit", async () => {
  const P = 8811, real = globalThis.fetch, asked = [];
  // Cloudflare's TURN API stand-in
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith("https://rtc.live.cloudflare.com/")) {
      asked.push({ url: String(url), auth: opts.headers.Authorization, ttl: JSON.parse(opts.body).ttl });
      return new Response(JSON.stringify({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" }] }), { status: 201 });
    }
    return real(url, opts);
  };
  try {
    await emu.db.query("select public.obv_user_touch(8811, 'turnuser', null, null)");
    // not set up on the server: a token, but no relay
    let st = await api("POST", "live/start", { as: P, body: { code: "abcdef" } });
    assert.equal(st.status, 200); assert.equal(st.body.on, false); assert.deepEqual(st.body.iceServers, []);
    // (no analytics token here: the relay runs without a monthly limit only because TURN_CAP_DISABLED says so; see the limit test)
    Object.assign(process.env, { TURN_KEY_ID: "abcdef0123456789", TURN_KEY_API_TOKEN: "turn-token-for-tests", TURN_CAP_DISABLED: "1" });
    assert.equal((await api("POST", "live/start", { body: { code: "abcdef" } })).status, 401); // hosting needs a login
    assert.equal((await api("POST", "live/start", { as: P, body: { code: "AB" } })).status, 400);
    st = await api("POST", "live/start", { as: P, body: { code: "abcdef" } });
    assert.equal(st.body.on, true); assert.equal(st.body.relay, false); assert.equal(st.body.ping_ms, 150);
    assert.equal(asked.at(-1).auth, "Bearer turn-token-for-tests"); assert.ok(asked.at(-1).url.includes("/keys/abcdef0123456789/"));
    assert.ok(asked.at(-1).ttl > 3 * 3600 - 60 && asked.at(-1).ttl < 3 * 3600 + 120);
    assert.ok(!JSON.stringify(st.body.iceServers).includes(":53?"), "port 53 is left out");
    // anyone in the session (a guest too) gets the relay with the session's token; nobody without it
    const ice = await api("POST", "live/ice", { body: { code: "abcdef", token: st.body.token } });
    assert.equal(ice.status, 200); assert.equal(ice.body.on, true); assert.equal(ice.body.iceServers.length, 2);
    assert.equal((await api("POST", "live/ice", { body: { code: "abcdeg", token: st.body.token } })).status, 403); // another session's code
    assert.equal((await api("POST", "live/ice", { body: { code: "abcdef", token: st.body.token.replace(/.$/, c => c === "A" ? "B" : "A") } })).status, 403);
    assert.equal((await api("POST", "live/ice", { body: { code: "abcdef" } })).status, 403);
    const old = (Date.now() - 1000).toString(36);
    assert.equal((await api("POST", "live/ice", { body: { code: "abcdef", token: old + st.body.token.slice(st.body.token.indexOf(".")) } })).status, 403);
    // an admin makes this person always use the relay
    assert.equal((await api("POST", `admin/users/${P}/turn`, { as: P, body: { on: true } })).status, 403);
    assert.equal((await api("POST", `admin/users/${P}/turn`, { as: OWNER, body: { on: "yes" } })).status, 400);
    assert.equal((await api("POST", `admin/users/${P}/turn`, { as: OWNER, body: { on: true } })).body.turn_relay, true);
    assert.equal((await api("GET", `admin/users/${P}`, { as: OWNER })).body.user.turn_relay, true);
    assert.equal((await api("POST", "live/ice", { as: P, body: { code: "abcdef", token: st.body.token } })).body.relay, true);
    assert.equal((await api("POST", "live/ice", { body: { code: "abcdef", token: st.body.token } })).body.relay, false); // a guest
    assert.equal((await api("POST", "live/start", { as: P, body: { code: "ghijkl" } })).body.relay, true);
    // collab asks GET ice: the same relay, the ping limit and the person's own "always use the relay"
    const ci = await api("GET", "ice", { as: P });
    assert.equal(ci.status, 200); assert.equal(ci.body.iceServers.length, 2); assert.equal(ci.body.relay, true); assert.equal(ci.body.ping_ms, 150); assert.equal(ci.body.on, true);
    assert.ok(asked.at(-1).ttl <= 3 * 3600, "collab credentials last 3 hours at most");
    const anon = await api("GET", "ice"); // logged in only: nothing for anyone who asks
    assert.equal(anon.status, 401); assert.equal(anon.body.iceServers, undefined);
    // settings: the ping limit, and the switch for everyone
    assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: { turn_ping_ms: 20 } } })).status, 400);
    await api("POST", "admin/settings", { as: OWNER, body: { values: { turn_ping_ms: 220 } } });
    assert.equal((await api("POST", "live/ice", { body: { code: "abcdef", token: st.body.token } })).body.ping_ms, 220);
    const set = await api("GET", "admin/settings", { as: OWNER });
    assert.equal(set.body.turn_configured, true); assert.ok(set.body.settings.some(s => s.key === "turn_enabled"));
    await api("POST", "admin/settings", { as: OWNER, body: { values: { turn_enabled: false } } });
    const off = await api("POST", "live/ice", { as: P, body: { code: "abcdef", token: st.body.token } });
    assert.equal(off.body.on, false); assert.equal(off.body.relay, false); assert.deepEqual(off.body.iceServers, []);
    await api("POST", "admin/settings", { as: OWNER, body: { values: { turn_enabled: true, turn_ping_ms: 150 } } });
    await api("POST", `admin/users/${P}/turn`, { as: OWNER, body: { on: false } });
    const audit = (await emu.db.query("select action from obv.audit_log where action like 'turn.%'")).rows.map(x => x.action);
    for (const x of ["turn.relay_on", "turn.relay_off"]) assert.ok(audit.includes(x), x);
  } finally {
    globalThis.fetch = real; delete process.env.TURN_KEY_ID; delete process.env.TURN_KEY_API_TOKEN; delete process.env.TURN_CAP_DISABLED;
  }
});

test("live sessions: guests may be allowed to watch; the host learns who is a member from the ticket check", async () => {
  const verify = require(join(root, "api/auth/verify.js"));
  const check = async id => {
    const ticket = auth.sign({ id, username: "u" + id, avatar: "", country: "TH", kind: "ticket", aud: "live:abcdef", exp: Date.now() + 36e5 }, auth.cfg({ headers: { host: "x" } }));
    let out = ""; const res = { statusCode: 200, setHeader() {}, end(b) { out = b; } };
    await verify({ method: "POST", headers: {}, body: { ticket, aud: "live:abcdef" } }, res); return JSON.parse(out);
  };
  await emu.db.query("select public.obv_user_touch(8821, 'livemember', null, null)");
  await emu.db.query("update obv.users set access = 'approved' where osu_id = 8821");
  await emu.db.query("select public.obv_user_touch(8822, 'liveguest', null, null)");
  assert.equal((await check(8821)).user.access, "member");
  assert.equal((await check(8822)).user.access, "guest");
  assert.equal((await check(8823)).user.access, "guest"); // never logged in here
  assert.equal((await check(OWNER)).user.access, "admin");
  // the Guest column switch (off by default) reaches everyone's permissions
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  assert.equal((await api("GET", "me", { as: 8822 })).body.perms.guest.live, false);
  await api("POST", "admin/settings", { as: OWNER, body: { values: { perm_guest_live: true } } });
  await new Promise(r => setTimeout(r, 10));
  const st = await api("GET", "admin/settings", { as: OWNER });
  assert.equal(st.body.settings.find(x => x.key === "perm_guest_live").value, true);
  await api("POST", "admin/settings", { as: OWNER, body: { values: { perm_guest_live: false } } });
  await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
});

test("TURN relay: usage from Cloudflare's analytics, per person, and the monthly limit", async () => {
  const P = 8831, real = globalThis.fetch, seen = { ice: [], gql: [] };
  let bytes = 2e9, gqlDown = false;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://rtc.live.cloudflare.com/")) { seen.ice.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }] }), { status: 201 }); }
    if (u === "https://api.cloudflare.com/client/v4/graphql") {
      if (gqlDown) return new Response(JSON.stringify({ errors: [{ message: "analytics down" }] }), { status: 500 });
      const b = JSON.parse(opts.body); seen.gql.push({ auth: opts.headers.Authorization, vars: b.variables });
      const g = b.query.includes("datetimeHour") ? [{ dimensions: { datetimeHour: "2026-10-01T03:00:00Z" }, sum: { egressBytes: bytes / 2 } }, { dimensions: { datetimeHour: "2026-10-01T09:00:00Z" }, sum: { egressBytes: bytes / 4 } }, { dimensions: { datetimeHour: "2026-10-02T01:00:00Z" }, sum: { egressBytes: bytes / 4 } }]
        : b.query.includes("customIdentifier") ? [{ dimensions: { customIdentifier: "u8831" }, sum: { egressBytes: bytes * .7 } }, { dimensions: { customIdentifier: "guest" }, sum: { egressBytes: bytes * .3 } }]
        : [{ sum: { egressBytes: bytes } }];
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ g }] } }, errors: null }), { status: 200 });
    }
    return real(url, opts);
  };
  Object.assign(process.env, { TURN_KEY_ID: "abcdef0123456789", TURN_KEY_API_TOKEN: "turn-token-for-tests" });
  try {
    await emu.db.query("select public.obv_user_touch(8831, 'turnheavy', null, null)");
    // no analytics token yet: the limit can't be checked, so no relay (fails closed); the session still gets its token
    let t = await api("GET", "admin/turn", { as: OWNER });
    assert.equal(t.body.key, true); assert.equal(t.body.analytics, false); assert.equal(t.body.usage, null); assert.equal(t.body.month_gb, 1000);
    assert.equal(t.body.on, true); assert.equal(t.body.blocked, "no_analytics"); assert.equal(t.body.cap_disabled, false);
    assert.equal((await api("GET", "admin/turn", { as: P })).status, 403);
    const asked0 = seen.ice.length;
    let st = await api("POST", "live/start", { as: P, body: { code: "lmnopq" } });
    assert.equal(st.status, 200); assert.ok(st.body.token); assert.equal(st.body.on, false); assert.deepEqual(st.body.iceServers, []);
    assert.deepEqual((await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } })).body.iceServers, []);
    assert.deepEqual((await api("GET", "ice", { as: P, headers: { "x-real-ip": "10.77.0.1" } })).body.iceServers, []);
    assert.equal(seen.ice.length, asked0, "no credentials were even made");
    // TURN_CAP_DISABLED=1: the operator lets it run without a limit
    process.env.TURN_CAP_DISABLED = "1";
    st = await api("POST", "live/start", { as: P, body: { code: "lmnopq" } });
    assert.equal(st.body.on, true); assert.equal(seen.ice.at(-1).customIdentifier, "u8831");
    await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } });
    assert.equal(seen.ice.at(-1).customIdentifier, "guest");
    delete process.env.TURN_CAP_DISABLED;
    Object.assign(process.env, { CF_ANALYTICS_TOKEN: "analytics-token-for-tests", CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" });
    t = await api("GET", "admin/turn?fresh=1", { as: OWNER });
    assert.equal(t.body.analytics, true); assert.equal(t.body.usage.bytes, 2e9);
    assert.deepEqual(t.body.usage.days, [{ day: "2026-10-01", bytes: 1.5e9 }, { day: "2026-10-02", bytes: 0.5e9 }]);
    assert.equal(t.body.usage.people[0].username, "user8831"); assert.equal(t.body.usage.people[0].id, 8831); assert.equal(t.body.usage.people[1].ident, "guest");
    assert.equal(seen.gql.at(-1).auth, "Bearer analytics-token-for-tests"); assert.equal(seen.gql.at(-1).vars.account, "0123456789abcdef0123456789abcdef");
    assert.ok(seen.gql.at(-1).vars.from.endsWith("-01T00:00:00.000Z"));
    assert.equal(t.body.blocked, null);
    assert.equal((await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } })).body.on, true); // 2 of 1000 GB
    // limit 1 GB: 2 GB used, so nobody gets the relay
    assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: { turn_month_gb: -1 } } })).status, 400);
    await api("POST", "admin/settings", { as: OWNER, body: { values: { turn_month_gb: 1 } } });
    const capped = await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } });
    assert.equal(capped.body.on, false); assert.deepEqual(capped.body.iceServers, []);
    t = await api("GET", "admin/turn", { as: OWNER }); assert.equal(t.body.capped, true);
    // 0 = no relay; no limit only with TURN_CAP_DISABLED=1
    await api("POST", "admin/settings", { as: OWNER, body: { values: { turn_month_gb: 0 } } });
    const zero = await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } });
    assert.equal(zero.body.on, false); assert.deepEqual(zero.body.iceServers, []);
    t = await api("GET", "admin/turn", { as: OWNER }); assert.equal(t.body.blocked, "no_limit"); assert.equal(t.body.capped, false);
    process.env.TURN_CAP_DISABLED = "1";
    assert.equal((await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } })).body.on, true);
    delete process.env.TURN_CAP_DISABLED;
    await api("POST", "admin/settings", { as: OWNER, body: { values: { turn_month_gb: 1000 } } });
    assert.equal((await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } })).body.on, true);
    // the usage can't be read: no relay (even with TURN_CAP_DISABLED), until it can again
    gqlDown = true; process.env.TURN_CAP_DISABLED = "1";
    t = await api("GET", "admin/turn?fresh=1", { as: OWNER }); assert.ok(t.body.error);
    const down = await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } });
    assert.equal(down.body.on, false); assert.deepEqual(down.body.iceServers, []);
    assert.deepEqual((await api("GET", "ice", { as: P, headers: { "x-real-ip": "10.77.0.2" } })).body.iceServers, []);
    assert.equal((await api("GET", "admin/turn", { as: OWNER })).body.blocked, "usage_error");
    gqlDown = false; delete process.env.TURN_CAP_DISABLED;
    await api("GET", "admin/turn?fresh=1", { as: OWNER });
    assert.equal((await api("POST", "live/ice", { body: { code: "lmnopq", token: st.body.token } })).body.on, true);
  } finally {
    globalThis.fetch = real;
    for (const k of ["TURN_KEY_ID", "TURN_KEY_API_TOKEN", "CF_ANALYTICS_TOKEN", "CF_ACCOUNT_ID", "TURN_CAP_DISABLED"]) delete process.env[k];
  }
});

test("TURN credentials: GET ice needs a login (the fixed TURN login too), 10 a minute per IP; live guests use the session's token", async () => {
  const P = 8841, ip = { "x-real-ip": "10.78.0.1" };
  await emu.db.query("select public.obv_user_touch(8841, 'iceuser', null, null)");
  Object.assign(process.env, { TURN_URLS: "turn:turn.example.test:3478,turns:turn.example.test:5349", TURN_USERNAME: "fixed-user", TURN_CREDENTIAL: "fixed-credential-not-for-anyone" });
  try {
    const anon = await api("GET", "ice", { headers: ip });
    assert.equal(anon.status, 401); assert.ok(!JSON.stringify(anon.body).includes("fixed-credential"), "the fixed TURN login isn't handed out");
    const bad = await api("GET", "ice", { headers: { ...ip, cookie: "__Host-obv_s=forged.cookie" } });
    assert.equal(bad.status, 401);
    const ok = await api("GET", "ice", { as: P, headers: ip });
    assert.equal(ok.status, 200); assert.equal(ok.body.iceServers[1].credential, "fixed-credential-not-for-anyone");
    // a live session's token (anonymous guests): POST live/ice, which hands out the Cloudflare relay only (no fixed login)
    const st = await api("POST", "live/start", { as: P, body: { code: "icetst" }, headers: ip });
    assert.equal(st.status, 200);
    const g = await api("POST", "live/ice", { body: { code: "icetst", token: st.body.token }, headers: ip });
    assert.equal(g.status, 200); assert.ok(Array.isArray(g.body.iceServers));
    // the per-IP limit: 10 a minute (3 used above), then 429; another IP still gets in
    for (let i = 0; i < 7; i++) assert.equal((await api("GET", "ice", { as: P, headers: ip })).status, 200, "request " + (i + 4));
    const over = await api("GET", "ice", { as: P, headers: ip });
    assert.equal(over.status, 429); assert.ok(!JSON.stringify(over.body).includes("fixed-credential"));
    assert.equal((await api("GET", "ice", { as: P, headers: { "x-real-ip": "10.78.0.2" } })).status, 200);
  } finally {
    for (const k of ["TURN_URLS", "TURN_USERNAME", "TURN_CREDENTIAL"]) delete process.env[k];
  }
});

test("R2: operations are counted per month, and above the limit saving is refused instead of billed", { skip: !(process.env.OBV_R2 || process.env.OBV_D1) }, async () => {
  const before = (await emu.db.query("select class_a::int a, class_b::int b from obv.r2_usage")).rows[0];
  assert.ok(before && before.a > 0 && before.b > 0, "uploads and downloads so far were counted");
  const p = await newProject(A);
  await emu.db.query("insert into obv.settings (key, value) values ('r2_class_a_month', $1::jsonb) on conflict (key) do update set value = excluded.value", [String(before.a)]);
  const r = await save(A, p.id, 0, [["map.osu", bytes(10, 1)]]);
  assert.equal(r.begin.status, 503); assert.equal(r.begin.body.error, "storage_limit");
  const after = (await emu.db.query("select class_a::int a, refused_a::int ra from obv.r2_usage")).rows[0];
  assert.equal(after.a, before.a, "nothing counted when refused");
  await emu.db.query("delete from obv.settings where key = 'r2_class_a_month'");
  assert.equal((await save(A, p.id, 0, [["map.osu", bytes(10, 1)]])).commit.status, 200, "under the limit again: saves");
  // each PUT is counted when it happens: a link made under the limit is refused once the limit is reached (fail closed)
  const data = bytes(30, 2), b = await api("POST", `projects/${p.id}/saves`, { as: A, body: { baseRevision: 1, files: [{ path: "map.osu", size: 30, sha256: await sha(data) }] } });
  assert.equal(b.status, 200);
  const now = (await emu.db.query("select class_a::int a, refused_a::int ra from obv.r2_usage")).rows[0];
  await emu.db.query("insert into obv.settings (key, value) values ('r2_class_a_month', $1::jsonb) on conflict (key) do update set value = excluded.value", [String(now.a)]);
  const over = await uploadTo(b.body.uploads[0].url, data);
  assert.equal(over.status, 503); assert.equal((await over.json()).error, "storage_limit");
  const after2 = (await emu.db.query("select class_a::int a, refused_a::int ra from obv.r2_usage")).rows[0];
  assert.equal(after2.a, now.a, "the refused PUT isn't counted"); assert.ok(after2.ra > now.ra, "and is recorded as refused");
  assert.equal(stored().filter(k => k.includes(p.id)).length, 1, "nothing written above the limit");
  await emu.db.query("delete from obv.settings where key = 'r2_class_a_month'");
  assert.equal((await uploadTo(b.body.uploads[0].url, data)).status, 200, "under the limit again: the same link works");
  assert.equal((await emu.db.query("select class_a::int a from obv.r2_usage")).rows[0].a, now.a + 1, "one write counted");
  assert.equal((await api("POST", `saves/${b.body.saveId}/commit`, { as: A, body: {} })).status, 200);
  const o = await api("GET", "admin/overview", { as: OWNER });
  assert.equal(o.body.backend, "r2"); assert.ok(o.body.r2.months[0].a > 0); assert.equal(o.body.r2.max_a, 900000);
});

test("R2 upload links: one write per file, only while its save is open and the project exists; R2 checks the sha256", { skip: !(process.env.OBV_R2 || process.env.OBV_D1) }, async () => {
  const p = await newProject(A), data = bytes(50, 3), other = bytes(50, 4);
  const begin = async (path, d) => (await api("POST", `projects/${p.id}/saves`, { as: A, body: { baseRevision: (await api("GET", `projects/${p.id}`, { as: A })).body.project.revision, files: [{ path, size: d.length, sha256: await sha(d) }] } })).body;
  const keysNow = () => stored().filter(k => k.includes(p.id));
  const b = await begin("map.osu", data), url = b.uploads[0].url;
  // same size, other bytes: R2 compares them with the sha256 declared when saving began
  const bad = await uploadTo(url, other);
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "hash_mismatch"); assert.equal(keysNow().length, 0);
  assert.equal((await uploadTo(url, data)).status, 200);
  const key = keysNow()[0];
  // a second PUT with the same link is refused (same bytes or not), and the file stays as it was
  const again = await uploadTo(url, data); assert.equal(again.status, 409); assert.equal((await again.json()).error, "already_uploaded");
  assert.equal((await uploadTo(url, other)).status, 409);
  assert.deepEqual(Buffer.from(r2.m.get(key)), Buffer.from(data));
  assert.equal((await api("POST", `saves/${b.saveId}/commit`, { as: A, body: {} })).status, 200);
  // after the commit the database refuses it too, even if the object were gone
  r2.m.delete(key);
  assert.equal((await uploadTo(url, data)).status, 409, "committed: refused"); assert.ok(!r2.m.has(key));
  r2.m.set(key, data);
  // after the project is deleted: a link from a save that was still open can't put a file back
  const b2 = await begin("song.mp3", bytes(40, 5));
  assert.equal((await api("DELETE", `projects/${p.id}`, { as: A, body: {} })).status, 200);
  assert.equal(keysNow().length, 0, "files removed");
  const late = await uploadTo(b2.uploads[0].url, bytes(40, 5));
  assert.equal(late.status, 410); assert.equal((await late.json()).error, "upload_closed");
  assert.equal(keysNow().length, 0, "nothing re-created after the delete");
});

// Worker Previews (api/_lib/preview.js): a branch's preview gets no backend unless PREVIEW_BACKEND=1. Calls worker.js
// directly (every mode), with static files read from the repo, then puts process.env back (the Worker scrubs it).
test("previews fail closed: 503 preview_backend_disabled on /api/*, the static site still works, no API code runs", async () => {
  const { readFileSync } = await import("node:fs");
  const worker = (await import(join(root, "worker.js"))).default, db = require(join(root, "api/_lib/db.js"));
  const assets = { fetch: req => { const p = new URL(req.url).pathname; try { return new Response(readFileSync(join(root, p === "/" ? "index.html" : p.slice(1)))); } catch { return new Response("not found", { status: 404 }); } } };
  const snap = { ...process.env };
  const envFor = extra => ({ ...snap, ASSETS: assets, ...(r2 ? { FILES: r2 } : {}), ...(d1 ? { DB: d1, DB_BACKEND: "d1" } : {}), ...extra });
  const call = async (host, path, extra = {}) => {
    const r = await worker.fetch(new Request("https://" + host + path, { redirect: "manual" }), envFor(extra), { waitUntil: () => {} });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j, text: t, headers: r.headers };
  };
  const SECRETS = ["SUPABASE_SECRET_KEY", "SUPABASE_URL", "OSU_CLIENT_SECRET", "CRON_SECRET", "OWNER_OSU_ID", "SESSION_SECRET", "TURN_KEY_ID", "TURN_KEY_API_TOKEN", "TURN_SECRET", "CF_ANALYTICS_TOKEN", "CF_ACCOUNT_ID", "GOOGLE_CLIENT_SECRET", "DB_BACKEND"];
  const extraSecrets = { SESSION_SECRET: "s".repeat(40), TURN_KEY_ID: "tk", TURN_KEY_API_TOKEN: "tt", TURN_SECRET: "ts", CF_ANALYTICS_TOKEN: "at", CF_ACCOUNT_ID: "acc", GOOGLE_CLIENT_SECRET: "gs" };
  const locked = async (host, extra = {}) => {
    // a locked request runs no api/** code and touches nothing the instance shares: process.env (still holding production's
    // secrets, even though this request's env carries other values), db.js's database and bucket, the database itself
    const envBefore = { ...process.env }, dbBefore = [db.D1.db, db.D1.target, db.R2.bucket], callsBefore = emu.calls.length;
    for (const path of ["/api/v1/me", "/api/auth/login", "/api/auth/me", "/api/auth/callback?code=x&state=y", "/api/auth/google", "/api/cron", "/api/v1/files?d=x", "/api/v1/admin/settings", "/api/nope"]) {
      const r = await call(host, path, { ...extraSecrets, ...extra });
      assert.equal(r.status, 503, host + path); assert.equal(r.body && r.body.error, "preview_backend_disabled", host + path);
      assert.equal(r.headers.get("x-robots-tag"), "noindex");
    }
    // the static site: the plain page (not indexed) and the files
    const home = await call(host, "/?s=1");
    assert.equal(home.status, 200); assert.match(home.text, /<html/i); assert.match(home.headers.get("content-type"), /text\/html/);
    assert.equal(home.headers.get("x-robots-tag"), "noindex"); assert.ok(home.headers.get("content-security-policy"), "site headers");
    const js = await call(host, "/js/core.js"); assert.equal(js.status, 200); assert.match(js.text, /use strict/);
    assert.deepEqual({ ...process.env }, envBefore, "process.env unchanged"); assert.equal(process.env.SUPABASE_SECRET_KEY, snap.SUPABASE_SECRET_KEY);
    assert.deepEqual([db.D1.db, db.D1.target, db.R2.bucket], dbBefore, "db.js untouched"); assert.equal(emu.calls.length, callsBefore, "no database calls");
  };
  const normal = async (host, extra = {}) => {
    const me = await call(host, "/api/v1/me", extra);
    assert.equal(me.status, 200, host); assert.equal(me.body.cloud, true); assert.equal(me.body.osu, true);
    const login = await call(host, "/api/auth/login", extra);
    assert.equal(login.status, 302, host); assert.match(login.headers.get("location"), /^https:\/\/osu\.ppy\.sh\/oauth\/authorize/);
    assert.equal((await call(host, "/api/cron", extra)).status, 401, "cron: the secret is still checked");
    assert.equal(process.env.SUPABASE_SECRET_KEY, snap.SUPABASE_SECRET_KEY); assert.equal(db.configured(), true);
    assert.equal(db.r2on(), !!r2); assert.equal(db.d1on(), !!d1);
    assert.equal((await call(host, "/js/core.js", extra)).status, 200);
  };
  try {
    await locked("feature-x-osu-beatmap-viewer.lacrymira.workers.dev");
    await locked("0a1b2c3d-osu-beatmap-viewer.lacrymira.workers.dev"); // (a version's preview URL)
    await locked("evil-osu-beatmap-viewer.attacker.workers.dev"); // look-alikes fail closed too
    await locked("something-else.lacrymira.workers.dev");
    await locked("feature-x-osu-beatmap-viewer.lacrymira.workers.dev", { PREVIEW_BACKEND: "true" }); // only exactly "1" opts in
    await locked("viewer.example.com", { OBV_PREVIEW: "1" }); // the variable wrangler.jsonc gives previews, on any host
    await normal("osu-beatmap-viewer.lacrymira.workers.dev"); // production (after a preview request in the same instance)
    await normal("viewer.example.com"); // a custom domain
    await normal("feature-x-osu-beatmap-viewer.lacrymira.workers.dev", { PREVIEW_BACKEND: "1" }); // opted in
    await normal("viewer.example.com", { OBV_PREVIEW: "1", PREVIEW_BACKEND: "1" });
    // the same rules as a function (Vercel: VERCEL_ENV=preview)
    const pv = require(join(root, "api/_lib/preview.js"));
    assert.equal(pv.isPreview("x.vercel.app", { VERCEL_ENV: "preview" }), true);
    assert.equal(pv.isPreview("x.vercel.app", { VERCEL_ENV: "production" }), false);
    assert.equal(pv.isPreview("osu-beatmap-viewer.lacrymira.workers.dev.", {}), false);
    assert.equal(pv.isPreview("OSU-BEATMAP-VIEWER.lacrymira.workers.dev:443", {}), false);
    assert.equal(pv.isPreview("osu-beatmap-viewer-x.lacrymira.workers.dev", {}), true);
    // what the Vercel scrub (VERCEL_ENV=preview only) removes
    const red = pv.scrub({ ...snap, ...extraSecrets, SITE_URL: "https://x.example", PREVIEW_BACKEND: "0" });
    for (const k of SECRETS) assert.ok(!(k in red), k); assert.equal(red.SITE_URL, "https://x.example"); assert.equal(red.PREVIEW_BACKEND, "0");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in snap)) delete process.env[k];
    Object.assign(process.env, snap);
    db.useR2(r2); db.useD1(d1); // (as tests/lib/server.mjs left them)
  }
});

// ---------- saved replays: POST/GET/DELETE /api/v1/replays (supabase/migrations/20261010090000_obv_replays.sql, d1/migrations/0005) ----------
// (each test has its own address: the replay routes are limited to 30 a minute per IP)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const RPF = readFileSync(join(root, "tests/fixtures/stable-small.osr"));
const rpSha = b => createHash("sha256").update(b).digest("hex");
const rpFile = (tag, { n = 64, mode = 0 } = {}) => { const b = Buffer.alloc(n, 9); b[0] = mode; if (n > 4) b.writeUInt32LE(tag, 1); return b; };
const rpBody = (b, meta = {}, over = {}) => ({ sha256: rpSha(b), size: b.length, data_b64: b.toString("base64"), meta, ...over });
const rpIp = n => ({ "x-real-ip": "10.80.0." + n });
const rpRows = async owner => (await emu.db.query("select * from obv.replays where owner_id = $1", [owner])).rows;
const rpSetting = (key, value) => value === null ? emu.db.query("delete from obv.settings where key = $1", [key])
  : emu.db.query("insert into obv.settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value", [key, String(value)]);

test("replays: a login is needed for every route, and a POST / DELETE must come from this site", async () => {
  const ip = rpIp(1), id = "11111111-1111-4111-8111-111111111111";
  for (const [m, route, body] of [["GET", "replays"], ["POST", "replays", rpBody(RPF)], ["GET", "replays/" + id], ["DELETE", "replays/" + id, {}]]) {
    const r = await api(m, route, { body, headers: ip }); assert.equal(r.status, 401, m + " " + route); assert.equal(r.body.error, "login_required");
  }
  assert.equal((await api("POST", "replays", { as: A, body: rpBody(RPF), headers: { ...ip, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await api("DELETE", "replays/" + id, { as: A, body: {}, headers: { ...ip, origin: "https://evil.example" } })).status, 403);
  assert.equal((await api("DELETE", "replays/" + id, { as: A, headers: ip })).status, 403, "a DELETE without the JSON body is refused like every state-changing request");
  assert.equal((await api("PUT", "replays", { as: A, body: {}, headers: ip })).status, 405);
  assert.equal((await api("GET", "replays/not-an-id", { as: A, headers: ip })).status, 404);
  assert.equal((await rpRows(A)).length, 0);
});

test("replays: save a real replay file, list it, open it (the bytes are identical), delete it", async () => {
  const ip = rpIp(2), U = 7101;
  const empty = await api("GET", "replays", { as: U, headers: ip });
  assert.equal(empty.status, 200); assert.deepEqual(empty.body.replays, []); assert.equal(empty.body.saving, true);
  assert.deepEqual([empty.body.limits.max_bytes, empty.body.limits.per_user, empty.body.limits.days, empty.body.limits.budget_bytes], [1048576, 20, 60, 100000000]);
  const meta = { mode: 3, player: "Tester", mapMd5: "ABCDEF0123456789abcdef0123456789", title: "Song", artist: "Artist", version: "Insane", creator: "mapper", setId: 123, beatmapId: 456,
    score: 1234567, combo: 321, acc: 0.9876, rank: "SH", mods: 24, modNames: ["HD", "HR"], counts: { n300: 300, n100: 2, n50: 1, geki: 40, katu: 5, miss: 0 }, date: 1700000000000, lazer: false,
    extra: "dropped", __proto__x: 1 };
  const s = await api("POST", "replays", { as: U, body: rpBody(RPF, meta), headers: ip });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.existed, false);
  const rep = s.body.replay;
  assert.equal(rep.sha256, rpSha(RPF)); assert.equal(rep.size, RPF.length); assert.ok(/^[0-9a-f-]{36}$/.test(rep.id));
  assert.deepEqual(rep.meta, { mode: RPF[0], player: "Tester", mapMd5: "abcdef0123456789abcdef0123456789", title: "Song", artist: "Artist", version: "Insane", creator: "mapper", setId: 123, beatmapId: 456,
    score: 1234567, combo: 321, acc: 0.9876, rank: "SH", mods: 24, modNames: ["HD", "HR"], counts: { n300: 300, n100: 2, n50: 1, geki: 40, katu: 5, miss: 0 }, date: 1700000000000, lazer: false }, "known keys only, and the mode is the file's own first byte");
  assert.ok(Math.abs(Date.parse(rep.expires_at) - Date.parse(rep.created_at) - 60 * 864e5) < 1000, "kept 60 days");
  const l = await api("GET", "replays", { as: U, headers: ip });
  assert.deepEqual(l.body.replays.map(r => r.id), [rep.id]); assert.equal(l.body.saving, true); assert.equal(l.body.limits.used_bytes >= RPF.length, true);
  assert.ok(!JSON.stringify(l.body).includes("data_b64") && !JSON.stringify(l.body).includes(RPF.toString("base64").slice(0, 30)), "the list has no file");
  assert.match(l.headers.get("cache-control") || "", /no-store/);
  const g = await api("GET", "replays/" + rep.id, { as: U, headers: ip });
  assert.equal(g.status, 200); assert.deepEqual(Buffer.from(g.body.data_b64, "base64"), RPF, "the same bytes"); assert.deepEqual(g.body.replay, rep);
  assert.match(g.headers.get("cache-control") || "", /no-store/); assert.match(g.headers.get("cache-control") || "", /private/);
  assert.equal((await api("GET", "replays/" + rep.id.toUpperCase(), { as: U, headers: ip })).status, 404, "ids are lower case");
  assert.equal((await api("DELETE", "replays/" + rep.id, { as: U, body: {}, headers: ip })).body.ok, true);
  assert.equal((await api("GET", "replays/" + rep.id, { as: U, headers: ip })).status, 404);
  assert.equal((await api("DELETE", "replays/" + rep.id, { as: U, body: {}, headers: ip })).status, 404);
  assert.deepEqual((await api("GET", "replays", { as: U, headers: ip })).body.replays, []);
});

test("replays: the same file again answers existed and keeps the first deletion date; a different person can save it too", async () => {
  const ip = rpIp(3), U = 7102, V = 7103, b = rpFile(1);
  const a = await api("POST", "replays", { as: U, body: rpBody(b, { player: "a" }), headers: ip });
  const sooner = new Date(Date.parse(a.body.replay.expires_at) - 20 * 864e5).toISOString();
  await emu.db.query("update obv.replays set expires_at = $2 where id = $1", [a.body.replay.id, sooner]);
  const again = await api("POST", "replays", { as: U, body: rpBody(b, { player: "b" }), headers: ip });
  assert.equal(again.status, 200); assert.equal(again.body.existed, true); assert.equal(again.body.replay.id, a.body.replay.id);
  assert.equal(Date.parse(again.body.replay.expires_at), Date.parse(sooner), "not extended"); assert.equal(again.body.replay.meta.player, "a");
  assert.equal((await rpRows(U)).length, 1);
  const other = await api("POST", "replays", { as: V, body: rpBody(b), headers: ip });
  assert.equal(other.body.existed, false); assert.notEqual(other.body.replay.id, a.body.replay.id);
});

test("replays: what is refused (size, encoding, hash, game mode, score info, body size)", async () => {
  const ip = rpIp(4), U = 7104, b = rpFile(2), ok = rpBody(b);
  const post = (body, o = {}) => api("POST", "replays", { as: U, body, headers: ip, ...o });
  const expect = async (body, status, error, why) => { const r = await post(body); assert.equal(r.status, status, why + " " + JSON.stringify(r.body)); assert.equal(r.body.error, error, why); };
  await expect({ ...ok, sha256: "XYZ" }, 400, "bad_request", "sha256 format"); await expect({ ...ok, sha256: rpSha(b).toUpperCase() }, 400, "bad_request", "upper case sha256");
  await expect({ ...ok, sha256: rpSha("nope") }, 400, "bad_request", "sha256 isn't the file's");
  for (const size of [0, -1, 1.5, "64", null, undefined]) await expect({ ...ok, size }, 400, "bad_request", "size " + size);
  await expect({ ...ok, size: 1048577 }, 413, "too_large", "size over 1 MiB");
  await expect({ ...ok, size: b.length - 1 }, 400, "bad_request", "size doesn't match the data"); await expect({ ...ok, size: b.length + 1 }, 400, "bad_request", "size doesn't match the data (longer)");
  await expect({ ...ok, data_b64: undefined }, 400, "bad_request", "no data"); await expect({ ...ok, data_b64: 5 }, 400, "bad_request", "data not text"); await expect({ ...ok, data_b64: "" }, 400, "bad_request", "empty data");
  await expect({ ...ok, data_b64: "!" + ok.data_b64.slice(1) }, 400, "bad_request", "not base64"); await expect({ ...ok, data_b64: ok.data_b64.replace(/\+/g, "-").replace(/\//g, "_") + "*" }, 400, "bad_request", "url-safe alphabet");
  await expect({ ...ok, data_b64: ok.data_b64.slice(0, -4) }, 400, "bad_request", "cut short"); await expect({ ...ok, data_b64: ok.data_b64.slice(0, 4) + "\n" + ok.data_b64.slice(5) }, 400, "bad_request", "line break");
  const odd = rpFile(3, { n: 65 }), oddB = rpBody(odd); // (65 bytes end in "=": the last character must be the canonical one)
  assert.ok(oddB.data_b64.endsWith("=")); await expect({ ...oddB, data_b64: oddB.data_b64.slice(0, -2) + "B=" }, 400, "bad_request", "non-canonical padding bits");
  await expect({ ...oddB, data_b64: oddB.data_b64.slice(0, -1) }, 400, "bad_request", "padding missing");
  await expect(rpBody(rpFile(4, { mode: 4 })), 400, "bad_request", "first byte is not a game mode"); await expect(rpBody(rpFile(5, { mode: 255 })), 400, "bad_request", "first byte 255");
  await expect({ ...ok, meta: [] }, 400, "bad_request", "meta is a list"); await expect({ ...ok, meta: "x" }, 400, "bad_request", "meta is text");
  await expect({ ...ok, meta: { title: "あ".repeat(300), artist: "あ".repeat(300), version: "あ".repeat(300), creator: "あ".repeat(300), modNames: Array(20).fill("あ".repeat(8)), player: "あ".repeat(64) } }, 400, "bad_request", "meta over 4096 bytes");
  assert.equal((await rpRows(U)).length, 0, "nothing was kept");
  // wrong values in the score info are dropped, not an error; text is cut to size
  const tidy = await post(rpBody(b, { player: "p".repeat(100), mapMd5: "nothex", setId: -1, beatmapId: "5", score: -5, combo: 1.5, acc: 2, rank: "SSSS", mods: "HD", modNames: ["a".repeat(20), 5, ...Array(30).fill("DT")], counts: { n300: 1, miss: -1, evil: 2 }, date: "x", lazer: "yes", title: 5 }));
  assert.equal(tidy.status, 200); assert.deepEqual(tidy.body.replay.meta, { mode: 0, player: "p".repeat(64), rank: "SSS", modNames: ["a".repeat(8), ...Array(19).fill("DT")], counts: { n300: 1 } });
  const nul = await post(rpBody(rpFile(6), { setId: null, beatmapId: null, date: null })); assert.deepEqual(nul.body.replay.meta, { mode: 0, setId: null, beatmapId: null, date: null });
  const nometa = await post({ ...rpBody(rpFile(7)), meta: undefined }); assert.equal(nometa.status, 200); assert.deepEqual(nometa.body.replay.meta, { mode: 0 });
  // exactly 1 MiB goes through (the body is about 1.4 MB of text); the body limit is checked before anything is decoded
  const big = rpFile(8, { n: 1048576 }), ip2 = rpIp(12), bigR = await api("POST", "replays", { as: U, body: rpBody(big), headers: ip2 }); assert.equal(bigR.status, 200, JSON.stringify(bigR.body).slice(0, 200));
  assert.deepEqual(Buffer.from((await api("GET", "replays/" + bigR.body.replay.id, { as: U, headers: ip2 })).body.data_b64, "base64"), big);
});

test("replays: too much text is refused with 413 before it is read", async () => {
  const ip = rpIp(5), U = 7105, b = rpFile(9, { n: 1048576 });
  const r = await post413(U, ip, { ...rpBody(b), data_b64: rpBody(b).data_b64 + "A".repeat(4) }); assert.equal(r.status, 413); assert.equal(r.body.error, "too_large");
  const huge = await post413(U, ip, { ...rpBody(b), data_b64: "A".repeat(1700000) }); assert.equal(huge.status, 413, "over the body limit");
  const over = rpFile(10, { n: 1048577 }), o = await post413(U, ip, rpBody(over)); assert.equal(o.status, 413); assert.equal(o.body.error, "too_large");
  assert.equal((await rpRows(U)).length, 0);
});
async function post413(as, ip, body) { return api("POST", "replays", { as, body, headers: { ...ip, connection: "close" } }); } // (the server answers before it has read it all: the connection is not reused)

test("replays: limit per person (403 replay_limit), the site budget (503 storage_full), saving paused (503)", async () => {
  const ip = rpIp(6), U = 7106, V = 7107;
  await rpSetting("replays_per_user", 2);
  try {
    assert.equal((await api("POST", "replays", { as: U, body: rpBody(rpFile(20)), headers: ip })).status, 200);
    assert.equal((await api("POST", "replays", { as: U, body: rpBody(rpFile(21)), headers: ip })).status, 200);
    const e = await api("POST", "replays", { as: U, body: rpBody(rpFile(22)), headers: ip });
    assert.equal(e.status, 403); assert.equal(e.body.error, "replay_limit"); assert.equal(e.body.detail.limit, 2);
    assert.equal((await api("POST", "replays", { as: U, body: rpBody(rpFile(20)), headers: ip })).body.existed, true, "the same file at the limit is answered");
    assert.equal((await api("GET", "replays", { as: U, headers: ip })).body.limits.per_user, 2);
    assert.equal((await api("POST", "replays", { as: V, body: rpBody(rpFile(22)), headers: ip })).status, 200, "per person");
  } finally { await rpSetting("replays_per_user", null); }
  const used = (await api("GET", "replays", { as: U, headers: ip })).body.limits.used_bytes;
  await rpSetting("replay_budget_bytes", used + 10);
  try {
    const f = await api("POST", "replays", { as: U, body: rpBody(rpFile(23, { n: 11 })), headers: ip });
    assert.equal(f.status, 503, JSON.stringify(f.body)); assert.equal(f.body.error, "storage_full");
    assert.equal((await api("POST", "replays", { as: U, body: rpBody(rpFile(23, { n: 10 })), headers: ip })).status, 200, "up to the budget");
  } finally { await rpSetting("replay_budget_bytes", null); }
  assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: { saving_enabled: false } } })).status, 200);
  try {
    const p = await api("POST", "replays", { as: U, body: rpBody(rpFile(24)), headers: ip }); assert.equal(p.status, 503); assert.equal(p.body.error, "saving_disabled");
    assert.equal((await api("GET", "replays", { as: U, headers: ip })).status, 200, "reading still works");
  } finally { await api("POST", "admin/settings", { as: OWNER, body: { values: { saving_enabled: true } } }); }
});

test("replays: nobody else can read or delete someone's replay (404, same as one that doesn't exist)", async () => {
  const ip = rpIp(7), U = 7108, V = 7109;
  const s = (await api("POST", "replays", { as: U, body: rpBody(rpFile(30)), headers: ip })).body.replay;
  const none = "22222222-2222-4222-8222-222222222222";
  for (const [m, body] of [["GET"], ["DELETE", {}]]) {
    const other = await api(m, "replays/" + s.id, { as: V, body, headers: ip }), missing = await api(m, "replays/" + none, { as: V, body, headers: ip });
    assert.equal(other.status, 404, m); assert.deepEqual(other.body, missing.body);
  }
  assert.deepEqual((await api("GET", "replays", { as: V, headers: ip })).body.replays, []);
  assert.equal((await api("GET", "replays/" + s.id, { as: U, headers: ip })).status, 200, "still there for the owner");
});

test("replays: the Replays switch refuses every route (503 feature_disabled) and comes back", async () => {
  const ip = rpIp(8), U = 7110, id = "33333333-3333-4333-8333-333333333333";
  const s = (await api("POST", "replays", { as: U, body: rpBody(rpFile(40)), headers: ip })).body.replay;
  assert.equal((await api("POST", "admin/features", { as: OWNER, body: { values: { feat_replays: false } } })).status, 200);
  try {
    assert.deepEqual((await api("GET", "me")).body.features.off, ["replays"]);
    for (const [m, route, body] of [["GET", "replays"], ["POST", "replays", rpBody(rpFile(41))], ["GET", "replays/" + s.id], ["DELETE", "replays/" + s.id, {}], ["GET", "replays/" + id]]) {
      const r = await api(m, route, { as: U, body, headers: ip }); assert.equal(r.status, 503, m + " " + route); assert.equal(r.body.error, "feature_disabled"); assert.equal(r.body.detail.feature, "replays");
    }
    assert.equal((await api("GET", "projects", { as: U })).status, 200, "nothing else is switched off");
  } finally { await api("POST", "admin/features", { as: OWNER, body: { values: { feat_replays: true } } }); }
  assert.equal((await api("GET", "replays/" + s.id, { as: U, headers: ip })).status, 200);
  assert.deepEqual((await api("GET", "me")).body.features.off, []);
});

test("replays: the daily cleanup deletes them after 60 days (and keeps the rest); before the migration it is not an error", async () => {
  const ip = rpIp(9), U = 7111, cron = () => fetch(base + "/api/cron", { headers: { authorization: "Bearer cron-secret-for-tests" } }).then(async r => ({ status: r.status, body: await r.json() }));
  const old = (await api("POST", "replays", { as: U, body: rpBody(rpFile(50)), headers: ip })).body.replay, keep = (await api("POST", "replays", { as: U, body: rpBody(rpFile(51)), headers: ip })).body.replay;
  await emu.db.query("update obv.replays set expires_at = now() - interval '1 second' where id = $1", [old.id]);
  assert.deepEqual((await api("GET", "replays", { as: U, headers: ip })).body.replays.map(r => r.id), [keep.id], "expired: gone from the list at once");
  assert.equal((await api("GET", "replays/" + old.id, { as: U, headers: ip })).status, 404);
  assert.equal((await rpRows(U)).length, 2, "the row is still there until the cleanup");
  const c = await cron(); assert.equal(c.status, 200); assert.equal(c.body.ok, true); assert.ok(c.body.replays_deleted >= 1);
  assert.deepEqual((await rpRows(U)).map(r => r.id), [keep.id]);
  assert.deepEqual(c.body.errors, []);
  await hideReplayFunctions(true);
  try { const c2 = await cron(); assert.equal(c2.status, 200); assert.deepEqual(c2.body.errors, []); assert.equal(c2.body.replays_deleted, undefined); }
  finally { await hideReplayFunctions(false); }
});

// "the migration hasn't been run yet": the database function isn't there. Postgres: renamed (PostgREST then answers PGRST202, as Supabase does);
// D1: the JavaScript function is taken out.
const RP_FUNCS = { obv_replay_list: "bigint", obv_replay_save: "bigint, text, integer, jsonb, text", obv_replay_get: "bigint, uuid", obv_replay_delete: "bigint, uuid", obv_replays_gc: "integer",
  obv_replay_share: "bigint, uuid, text", obv_replay_shared: "bigint, uuid, text", obv_replay_card: "uuid, text" };
async function hideReplayFunctions(hide) {
  if (d1) {
    const { F } = require(join(root, "api/_lib/d1.js"));
    for (const n of Object.keys(RP_FUNCS)) { if (hide) { F[n + "_hidden"] = F[n]; delete F[n]; } else { F[n] = F[n + "_hidden"]; delete F[n + "_hidden"]; } }
    return;
  }
  for (const [n, args] of Object.entries(RP_FUNCS)) await emu.db.exec(hide ? `alter function public.${n}(${args}) rename to ${n}_hidden` : `alter function public.${n}_hidden(${args}) rename to ${n}`);
  emu.forgetFunctions();
}
test("replays: before the migration is run: the list says saving is off (200), saving and opening say 503 not_configured; other database errors stay errors", async () => {
  const ip = rpIp(10), U = 7112;
  const s = (await api("POST", "replays", { as: U, body: rpBody(rpFile(60)), headers: ip })).body.replay;
  await hideReplayFunctions(true);
  try {
    const l = await api("GET", "replays", { as: U, headers: ip }); assert.equal(l.status, 200); assert.deepEqual(l.body, { replays: [], saving: false, limits: null });
    for (const [m, route, body] of [["POST", "replays", rpBody(rpFile(61))], ["GET", "replays/" + s.id], ["DELETE", "replays/" + s.id, {}],
      ["POST", "replays/" + s.id + "/share", { mode: "on" }], ["GET", "replays/shared/" + s.id + "?key=" + "A".repeat(32)]]) {
      const r = await api(m, route, { as: U, body, headers: ip }); assert.equal(r.status, 503, m + " " + route); assert.equal(r.body.error, "not_configured");
    }
    assert.equal((await api("GET", "projects", { as: U })).status, 200, "everything else keeps working");
    assert.equal((await api("POST", "replays", { as: U, body: { sha256: "x" }, headers: ip })).status, 400, "input is checked first");
    // the layer below: a missing function is told apart from any other database error
    const db = require(join(root, "api/_lib/db.js"));
    const e = await db.rpc("obv_replay_list", { p_actor: U }).catch(x => x); assert.equal(e.code, "db_error"); assert.equal(e.missing, true);
  } finally { await hideReplayFunctions(false); }
  assert.equal((await api("GET", "replays/" + s.id, { as: U, headers: ip })).status, 200, "and back");
  assert.equal((await api("GET", "replays", { as: U, headers: ip })).body.saving, true);
});

test("replays: a database error that isn't 'function missing' is not turned into 'not set up'", async () => {
  const ip = rpIp(11), U = 7113, db = require(join(root, "api/_lib/db.js")), real = db.rpc;
  await api("GET", "replays", { as: U, headers: ip }); // (the session is known before the database is "broken")
  db.rpc = async (name, args) => { if (name === "obv_replay_save" || name === "obv_replay_get") throw new db.ApiError("db_error", 502); return real(name, args); };
  try {
    assert.equal((await api("POST", "replays", { as: U, body: rpBody(rpFile(70)), headers: ip })).status, 502);
    assert.equal((await api("GET", "replays/44444444-4444-4444-8444-444444444444", { as: U, headers: ip })).body.error, "db_error");
  } finally { db.rpc = real; }
});

test("replays: 30 requests a minute from one address, then 429 (before anything else is looked at)", async () => {
  const ip = rpIp(13); let last;
  for (let i = 0; i < 31; i++) last = await api("GET", "replays", { as: 7114, headers: ip });
  assert.equal(last.status, 429); assert.equal(last.body.error, "too_many_requests");
  assert.equal((await api("GET", "replays", { as: 7114, headers: rpIp(14) })).status, 200, "another address is fine");
});

// ---------- sharing a saved replay by link, members only: POST replays/:id/share, GET replays/shared/:id?key= (20261011150000_obv_replay_share.sql, d1/migrations/0006) ----------
const RK = /^[A-Za-z0-9_-]{32}$/;
const rpShare = (as, id, mode, ip) => api("POST", "replays/" + id + "/share", { as, body: { mode }, headers: ip });
const rpOpen = (as, id, key, ip) => api("GET", "replays/shared/" + id + (key === undefined ? "" : "?key=" + encodeURIComponent(key)), { as, headers: ip });

test("replay links: the owner shares, resets and stops; a member opens it (the same bytes, nothing about the owner); every bad link is the same 404", async () => {
  let k = 0; const nip = () => ({ "x-real-ip": "10.82.0." + (++k) }), U = 7120, V = 7121; // (a new address per call: this test makes more than 30)
  const meta = { player: "Tester", title: "Song", artist: "Artist", version: "Insane", score: 4242 };
  const rep = (await api("POST", "replays", { as: U, body: rpBody(RPF, meta), headers: nip() })).body.replay;
  assert.equal(rep.share_key, null, "a new save isn't shared");
  const on = await rpShare(U, rep.id, "on", nip());
  assert.equal(on.status, 200); assert.deepEqual(Object.keys(on.body).sort(), ["expires_at", "share_key"]); assert.match(on.body.share_key, RK);
  assert.equal(on.headers.get("cache-control"), "private, no-store"); assert.equal(Date.parse(on.body.expires_at), Date.parse(rep.expires_at));
  const key = on.body.share_key;
  assert.equal((await rpShare(U, rep.id, "on", nip())).body.share_key, key, "on again: the same link");
  assert.equal((await api("GET", "replays", { as: U, headers: nip() })).body.replays.find(r => r.id === rep.id).share_key, key, "the owner's list shows it is shared, with its key");
  assert.equal((await api("GET", "replays/" + rep.id, { as: U, headers: nip() })).body.replay.share_key, key);
  // a member opens it
  const g = await rpOpen(V, rep.id, key, nip());
  assert.equal(g.status, 200); assert.equal(g.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(g.body).sort(), ["data_b64", "replay"]); assert.deepEqual(Object.keys(g.body.replay).sort(), ["created_at", "expires_at", "id", "meta", "size"]);
  assert.deepEqual(Buffer.from(g.body.data_b64, "base64"), RPF, "the same bytes as saved");
  assert.equal(g.body.replay.id, rep.id); assert.equal(g.body.replay.size, RPF.length); assert.deepEqual(g.body.replay.meta, rep.meta);
  const txt = JSON.stringify(g.body);
  assert.ok(!/owner|sha256|share_key/.test(txt) && !txt.includes(key) && !txt.includes("user" + U), "no owner, account data or key in the answer");
  assert.equal((await api("GET", "replays/" + rep.id, { as: V, headers: nip() })).status, 404, "the owner-only route stays owner-only");
  // every bad link: 404 with the same body
  const nf = []; const bad = async (why, r) => { assert.equal(r.status, 404, why); assert.equal(r.headers.get("cache-control"), "no-store", why); nf.push([why, r.body]); };
  await bad("a wrong key", await rpOpen(V, rep.id, "B".repeat(32), nip()));
  await bad("a malformed key", await rpOpen(V, rep.id, "short", nip()));
  await bad("a key with a bad character", await rpOpen(V, rep.id, key.slice(0, 31) + ".", nip()));
  await bad("a key too long", await rpOpen(V, rep.id, key + "A", nip()));
  await bad("no key", await rpOpen(V, rep.id, undefined, nip()));
  await bad("an unknown id", await rpOpen(V, "55555555-5555-4555-8555-555555555555", key, nip()));
  const other = (await api("POST", "replays", { as: U, body: rpBody(rpFile(80)), headers: nip() })).body.replay, otherKey = (await rpShare(U, other.id, "on", nip())).body.share_key;
  await bad("another replay's key", await rpOpen(V, rep.id, otherKey, nip()));
  const reset = await rpShare(U, rep.id, "reset", nip()); assert.match(reset.body.share_key, RK); assert.notEqual(reset.body.share_key, key);
  await bad("the old key after a reset", await rpOpen(V, rep.id, key, nip()));
  assert.equal((await rpOpen(V, rep.id, reset.body.share_key, nip())).status, 200, "the new one works");
  const off = await rpShare(U, rep.id, "off", nip()); assert.equal(off.status, 200); assert.equal(off.body.share_key, null);
  await bad("a revoked key", await rpOpen(V, rep.id, reset.body.share_key, nip()));
  assert.equal((await api("GET", "replays", { as: U, headers: nip() })).body.replays.find(r => r.id === rep.id).share_key, null);
  await emu.db.query("update obv.replays set expires_at = now() - interval '1 second' where id = $1", [other.id]);
  await bad("an expired replay", await rpOpen(V, other.id, otherKey, nip()));
  const del = (await api("POST", "replays", { as: U, body: rpBody(rpFile(81)), headers: nip() })).body.replay, delKey = (await rpShare(U, del.id, "on", nip())).body.share_key;
  assert.equal((await rpOpen(V, del.id, delKey, nip())).status, 200);
  assert.equal((await api("DELETE", "replays/" + del.id, { as: U, body: {}, headers: nip() })).status, 200);
  await bad("a deleted replay", await rpOpen(V, del.id, delKey, nip()));
  for (const [why, b] of nf) assert.deepEqual(b, { error: "not_found" }, why);
  // only the owner can share or stop sharing (someone else: 404, the same as an unknown id); a bad mode is 400
  const mine = (await api("POST", "replays", { as: U, body: rpBody(rpFile(82)), headers: nip() })).body.replay, mineKey = (await rpShare(U, mine.id, "on", nip())).body.share_key;
  for (const mode of ["on", "reset", "off"]) {
    const r = await rpShare(V, mine.id, mode, nip()), u = await rpShare(V, "66666666-6666-4666-8666-666666666666", mode, nip());
    assert.equal(r.status, 404, mode); assert.deepEqual(r.body, u.body);
  }
  assert.equal((await rpOpen(V, mine.id, mineKey, nip())).status, 200, "still shared with the same key");
  for (const b of [{}, { mode: "ON" }, { mode: 1 }, { mode: "delete" }]) { const r = await api("POST", "replays/" + mine.id + "/share", { as: U, body: b, headers: nip() }); assert.equal(r.status, 400, JSON.stringify(b)); assert.equal(r.body.error, "bad_request"); }
  assert.equal((await api("POST", "replays/" + mine.id + "/share", { as: U, body: { mode: "on" }, headers: { ...nip(), "sec-fetch-site": "cross-site" } })).status, 403, "from this site only");
  assert.equal((await api("GET", "replays/" + mine.id + "/share", { as: U, headers: nip() })).status, 405);
  assert.equal((await api("GET", "replays/shared/not-an-id?key=" + mineKey, { as: V, headers: nip() })).status, 404);
});

test("replay links: guests get 401, a logged-in account without access 403, members and admins open it", async () => {
  const ip = rpIp(21), U = 7122, M = 7123, N = 7124;
  const rep = (await api("POST", "replays", { as: U, body: rpBody(rpFile(90)), headers: ip })).body.replay, key = (await rpShare(U, rep.id, "on", ip)).body.share_key;
  for (const r of [await rpOpen(undefined, rep.id, key, ip), await api("POST", "replays/" + rep.id + "/share", { body: { mode: "off" }, headers: ip })]) { assert.equal(r.status, 401); assert.equal(r.body.error, "login_required"); }
  try {
    await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
    await api("GET", "me", { as: M }); await api("GET", "me", { as: N }); // (refreshes the server's cached switch; makes the accounts)
    assert.equal((await api("POST", `admin/access/${M}`, { as: OWNER, body: { access: "approved" } })).status, 200);
    assert.equal((await api("POST", `admin/access/${U}`, { as: OWNER, body: { access: "approved" } })).status, 200);
    const guest = await rpOpen(undefined, rep.id, key, ip); assert.equal(guest.status, 401); assert.equal(guest.body.error, "login_required");
    const no = await rpOpen(N, rep.id, key, ip); assert.equal(no.status, 403); assert.equal(no.body.error, "no_access", "logged in, not let in yet");
    assert.equal((await rpOpen(N, rep.id, "Z".repeat(32), ip)).status, 403, "the same with a wrong key: nothing to learn");
    assert.equal((await rpShare(N, rep.id, "off", ip)).status, 403);
    const ok = await rpOpen(M, rep.id, key, ip); assert.equal(ok.status, 200); assert.equal(ok.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(ok.body.data_b64, "base64"), rpFile(90));
    assert.equal((await rpOpen(OWNER, rep.id, key, ip)).status, 200, "admins");
    assert.equal((await rpShare(U, rep.id, "on", ip)).body.share_key, key, "the approved owner still manages it");
    // the guests' areas never include it (perm "online" is off for guests whatever the settings)
    assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: { perm_guest_listing: true, perm_guest_player: true, perm_guest_mappers: true } } })).status, 200);
    assert.equal((await rpOpen(undefined, rep.id, key, ip)).status, 401); assert.equal((await rpOpen(N, rep.id, key, ip)).status, 403);
  } finally {
    await emu.db.query("update obv.settings set value = 'false' where key = 'access_required'");
    await api("GET", "me", { as: M });
  }
});

test("replay links: the Replays switch refuses them (503), and 30 a minute per address like the other replay routes", async () => {
  const ip = rpIp(22), U = 7125, V = 7126;
  const rep = (await api("POST", "replays", { as: U, body: rpBody(rpFile(95)), headers: ip })).body.replay, key = (await rpShare(U, rep.id, "on", ip)).body.share_key;
  assert.equal((await api("POST", "admin/features", { as: OWNER, body: { values: { feat_replays: false } } })).status, 200);
  try {
    for (const r of [await rpOpen(V, rep.id, key, ip), await rpOpen(V, rep.id, "bad", ip), await rpShare(U, rep.id, "off", ip)]) { assert.equal(r.status, 503); assert.equal(r.body.error, "feature_disabled"); assert.equal(r.body.detail.feature, "replays"); }
  } finally { await api("POST", "admin/features", { as: OWNER, body: { values: { feat_replays: true } } }); }
  assert.equal((await rpOpen(V, rep.id, key, ip)).status, 200, "back on: the link still works");
  const ip2 = rpIp(23); let last;
  for (let i = 0; i < 31; i++) last = await rpOpen(V, rep.id, i % 2 ? key : "C".repeat(32), ip2);
  assert.equal(last.status, 429); assert.equal(last.body.error, "too_many_requests");
  assert.equal((await rpShare(U, rep.id, "on", ip2)).status, 429, "one count for every replay route");
  assert.equal((await rpOpen(V, rep.id, key, rpIp(24))).status, 200, "another address is fine");
});

test("replay links: the link preview card shows the map only (never the player or the score); a wrong or revoked key gets no card", async () => {
  const og = require(join(root, "api/og.js")); og.useTemplate(readFileSync(join(root, "index.html"), "utf8"));
  const page = async (path, n) => {
    const out = { headers: {} };
    await og({ url: path, headers: { host: "preview.example", "x-real-ip": "10.81.0." + n } }, { statusCode: 0, setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: b => { out.body = b; } });
    out.head = out.body.slice(0, out.body.indexOf("</head>")); out.title = (out.body.match(/<title>([^<]*)<\/title>/) || [])[1]; return out;
  };
  const ip = rpIp(25), U = 7127;
  const rep = (await api("POST", "replays", { as: U, body: rpBody(rpFile(97), { player: "SecretPlayer", title: "Song", artist: "Artist", version: "Insane", score: 98765432 }), headers: ip })).body.replay;
  const key = (await rpShare(U, rep.id, "on", ip)).body.share_key;
  const ok = await page(`/?replay=${rep.id}&key=${key}`, 1);
  assert.equal(ok.title, "Artist - Song [Insane] · KIKI Beatmap Viewer");
  assert.match(ok.head, /<meta property="og:description" content="A replay shared on beatmap viewer\. Log in with your osu! account to watch it \(members only\)\.">/);
  assert.ok(!/SecretPlayer|98765432|user7127/.test(ok.body), "no player name, score or owner anywhere in the page");
  assert.match(ok.head, /<meta name="robots" content="noindex">/); assert.equal(ok.headers["x-robots-tag"], "noindex"); assert.equal(ok.headers["cache-control"], "no-store", "no shared copy of the card");
  const HOME = "KIKI Beatmap Viewer: preview and edit osu! beatmaps online";
  for (const [why, path, n] of [["a wrong key", `/?replay=${rep.id}&key=${"D".repeat(32)}`, 2], ["a malformed key", `/?replay=${rep.id}&key=short`, 3], ["no key", `/?replay=${rep.id}`, 4],
    ["a bad id", `/?replay=${rep.id.toUpperCase()}&key=${key}`, 5], ["an unknown id", `/?replay=77777777-7777-4777-8777-777777777777&key=${key}`, 6]]) {
    const p = await page(path, n);
    assert.equal(p.title, HOME, why); assert.ok(!/Song|Artist/.test(p.head), why); assert.match(p.head, /<meta name="robots" content="noindex">/, why); assert.equal(p.headers["cache-control"], "no-store", why);
  }
  await rpShare(U, rep.id, "off", ip);
  const revoked = await page(`/?replay=${rep.id}&key=${key}`, 7);
  assert.equal(revoked.title, HOME, "a revoked key: no card"); assert.ok(!/Song/.test(revoked.head));
  assert.deepEqual(og.PRIVATE.keys.slice(0, 9), ["s", "b", "u", "live", "collab", "project", "invite", "replay", "key"], "replay links are never indexed");
});

test("osu! replay (a pasted score link): the file passes through, an unknown score is 404, a refusal is replay_needs_login and is not asked again for an hour, bad ids never reach osu!", async () => {
  fillBuckets(); osuLib()._replay.off.until = 0;
  const get = id => { fillBuckets(); return fetch(base + "/api/v1/osu/replay?score=" + id, { headers: freshIp() }); };
  const calls0 = osuCalls.length;
  for (const bad of ["", "abc", "12x", "-1", "1234567890123", "1/2", "8001%2F..", "1.5"]) { const r = await get(bad); assert.equal(r.status, 400, "score: " + bad); assert.equal((await r.json()).error, "bad_request"); }
  assert.equal((await fetch(base + "/api/v1/osu/replay", { headers: freshIp() })).status, 400);
  assert.equal(osuCalls.length, calls0, "bad ids never reach osu!");
  const ok = await get(8001);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("content-type"), "application/octet-stream"); assert.equal(ok.headers.get("cache-control"), "no-store"); assert.match(ok.headers.get("content-disposition"), /score-8001\.osr/);
  const b = new Uint8Array(await ok.arrayBuffer()); assert.equal(b.length, 300); assert.equal(b[1], 7); assert.equal(ok.headers.get("content-length"), "300");
  const nf = await get(8002); assert.equal(nf.status, 404); assert.equal((await nf.json()).error, "not_found");
  const big = await get(8004); assert.equal(big.status, 413); assert.equal((await big.json()).error, "replay_too_big");
  const denied = await get(8003); assert.equal(denied.status, 403); assert.equal((await denied.json()).error, "replay_needs_login");
  const n = osuHits["/api/v2/scores/8003/download"] || 0; assert.equal(n, 1);
  const again = await get(8001); assert.equal(again.status, 403, "after a refusal osu! is not asked for an hour"); assert.equal((await again.json()).error, "replay_needs_login"); assert.equal(osuHits["/api/v2/scores/8001/download"], 1);
  osuLib()._replay.off.until = 0;
});
