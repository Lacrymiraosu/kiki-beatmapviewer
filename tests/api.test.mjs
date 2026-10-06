// The server API (api/v1.js, api/cron.js) end to end: real handlers + real SQL (PGlite) + a Storage stand-in.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startSupabaseEmu } from "./emu/supabase-emu.mjs";
import { startOsuMock } from "./emu/osu-mock.mjs";
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
  return { status: r.status, body: j };
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
  assert.equal((await api("GET", "osu/set?id=999999")).status, 404);
  assert.equal((await api("GET", "osu/beatmap?id=10012")).body.set_id, 1001);
  assert.equal((await api("GET", "osu/beatmap?id=5")).status, 404);
});

test("invite-only: without an approved account only me, the request and the changelog answer; admins approve", async () => {
  const P = 5501, Q = 5502;
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  const me0 = await api("GET", "me", { as: P }); // also refreshes the server's cached switch
  assert.equal(me0.body.gate, true); assert.equal(me0.body.access, "none");
  // guests: the Beatmap page, the player and mapper pages by default, nothing online
  assert.equal((await api("GET", "osu/tags")).status, 200);
  assert.equal((await api("GET", "osu/user?u=1")).status !== 401, true);
  assert.equal((await api("GET", "projects")).status, 401);
  assert.equal((await api("GET", "projects", { as: P })).status, 403);
  assert.deepEqual(me0.body.perms.guest, { listing: true, player: true, mappers: true, editor: false, online: false, live: false });
  // an admin turns the guest areas off: guests get nothing again
  const off = { perm_guest_listing: false, perm_guest_player: false, perm_guest_mappers: false };
  assert.equal((await api("POST", "admin/settings", { as: OWNER, body: { values: off } })).status, 200);
  assert.equal((await api("GET", "osu/tags")).status, 401);
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
    const home = await call(host, "/?s=1", { ...extraSecrets, ...extra });
    assert.equal(home.status, 200); assert.match(home.text, /<html/i); assert.match(home.headers.get("content-type"), /text\/html/);
    assert.equal(home.headers.get("x-robots-tag"), "noindex"); assert.ok(home.headers.get("content-security-policy"), "site headers");
    const js = await call(host, "/js/core.js", { ...extraSecrets, ...extra }); assert.equal(js.status, 200); assert.match(js.text, /use strict/);
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
    await locked("my-branch-kiki-beatmap-viewer.lacrymira.workers.dev");
    await locked("0a1b2c3d-osu-beatmap-viewer.lacrymira.workers.dev"); // (a version's preview URL)
    await locked("evil-osu-beatmap-viewer.attacker.workers.dev"); // look-alikes fail closed too
    await locked("something-else.lacrymira.workers.dev");
    await locked("my-branch-kiki-beatmap-viewer.lacrymira.workers.dev", { PREVIEW_BACKEND: "true" }); // only exactly "1" opts in
    await locked("viewer.example.com", { OBV_PREVIEW: "1" }); // the variable wrangler.jsonc gives previews, on any host
    await normal("osu-beatmap-viewer.lacrymira.workers.dev"); // production (after a preview request in the same instance)
    await normal("viewer.example.com"); // a custom domain
    await normal("my-branch-kiki-beatmap-viewer.lacrymira.workers.dev", { PREVIEW_BACKEND: "1" }); // opted in
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
