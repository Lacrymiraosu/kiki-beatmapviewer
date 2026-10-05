// Error reports (POST errors, no login), Admin → Errors, and the admins' counts in GET me: real handlers + real SQL (PGlite).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startSupabaseEmu } from "./emu/supabase-emu.mjs";
import { startApi } from "./lib/server.mjs";
let SRV;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const A = 1001, OWNER = 9999;
let emu, srv, base, auth;

before(async () => {
  emu = await startSupabaseEmu();
  Object.assign(process.env, { SUPABASE_URL: emu.url, SUPABASE_SECRET_KEY: emu.key, OSU_CLIENT_ID: "1", OSU_CLIENT_SECRET: "test-only-secret", OWNER_OSU_ID: String(OWNER) });
  const v1 = require(join(root, "api/v1.js")); auth = require(join(root, "api/_lib/auth.js"));
  SRV = await startApi(root, emu); srv = SRV.srv; base = SRV.base;
});
after(async () => { srv.close(); await emu.close(); });

const cookieFor = id => "obv_s=" + encodeURIComponent(auth.sign({ id, username: "user" + id, avatar: "", country: "TH", kind: "session", iat: Date.now(), exp: Date.now() + 36e5 }, auth.cfg({ headers: { host: "x" } })));
async function api(method, route, { as, body, ip = "10.0.0.1", origin = "same-origin" } = {}) {
  const h = { "x-real-ip": ip }; if (as) h.cookie = cookieFor(as);
  if (body !== undefined) { h["content-type"] = "application/json"; h["sec-fetch-site"] = origin; }
  const r = await fetch(base + "/api/v1/" + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j };
}
const report = (extra = {}, opt = {}) => api("POST", "errors", { body: { message: "TypeError: x is undefined", source: "/js/editor.js:10:5", stack: "at f (/js/editor.js:10:5)", page: "editor", version: "139", browser: "Safari · iOS", ...extra }, ...opt });

test("anyone can report (no login, gate on); the same error is counted on one row", async () => {
  await emu.db.query("update obv.settings set value = 'true' where key = 'access_required'");
  assert.equal((await report()).body.ok, true);
  assert.equal((await report({ page: "home" })).body.ok, true);
  assert.equal((await report({ message: "ReferenceError: y" })).body.ok, true);
  const { rows } = await emu.db.query("select message, count, page from obv.client_errors order by message");
  assert.deepEqual(rows.map(r => [r.message, r.count, r.page]), [["ReferenceError: y", 1, "editor"], ["TypeError: x is undefined", 2, "home"]]);
  assert.equal((await report({ message: "" })).status, 400);
  assert.equal((await report({}, { origin: "cross-site" })).status, 403, "other sites can't send reports");
  const long = await report({ message: "z".repeat(2000), stack: "s".repeat(5000) });
  assert.equal((await report({ stack: "s".repeat(20000) })).status, 413, "too big");
  assert.equal(long.status, 200);
  const { rows: [l] } = await emu.db.query("select char_length(message) m, char_length(stack) s from obv.client_errors where message like 'zzz%'");
  assert.deepEqual([l.m, l.s], [300, 2000]);
});

test("reports are rate-limited per IP", async () => {
  let last; for (let i = 0; i < 22; i++) last = await report({ message: "spam " + i }, { ip: "10.9.9.9" });
  assert.equal(last.status, 429);
  assert.equal((await report({ message: "other ip" }, { ip: "10.9.9.8" })).status, 200);
});

test("only admins see Errors; mark fixed, reopen when it happens again, clear fixed", async () => {
  assert.equal((await api("GET", "admin/errors", { as: A })).status, 403);
  const r = await api("GET", "admin/errors", { as: OWNER });
  assert.equal(r.status, 200); assert.ok(r.body.open >= 3); assert.equal(r.body.rows[0].message, "other ip", "newest first");
  const te = r.body.rows.find(x => x.message.startsWith("TypeError"));
  assert.equal((await api("POST", "admin/errors", { as: OWNER, body: { sig: te.sig, resolved: true } })).body.ok, true);
  assert.equal((await api("POST", "admin/errors", { as: A, body: { sig: te.sig, resolved: true } })).status, 403);
  const fixed = await api("GET", "admin/errors?resolved=1", { as: OWNER });
  assert.deepEqual(fixed.body.rows.map(x => x.message), ["TypeError: x is undefined"]);
  await report(); // happens again: back in New
  assert.equal((await api("GET", "admin/errors?resolved=1", { as: OWNER })).body.total, 0);
  await api("POST", "admin/errors", { as: OWNER, body: { sig: te.sig, resolved: true } });
  const c = await api("POST", "admin/errors", { as: OWNER, body: { clear: true } });
  assert.equal(c.body.deleted, 1);
  assert.equal((await api("POST", "admin/errors", { as: OWNER, body: { sig: "nope" } })).status, 400);
});

test("GET me: admins get the counts (people waiting, new errors), others don't", async () => {
  await emu.db.query("insert into obv.users (osu_id, username, access, access_requested_at) values (5001, 'Waiting', 'pending', now()) on conflict do nothing");
  const o = await api("GET", "me", { as: OWNER });
  assert.equal(o.body.badges.pending, 1); assert.ok(o.body.badges.errors >= 3);
  assert.equal((await api("GET", "me", { as: A })).body.badges, undefined);
});

test("Report a problem: kept apart from errors, osu! name only when asked, rate-limited", async () => {
  const send = (b, o = {}) => api("POST", "feedback", { body: { message: "the save button does nothing", page: "editor", version: "141", browser: "Chrome · Android · touch", ...b }, ip: "10.1.1.1", ...o });
  assert.equal((await send({})).status, 200);
  assert.equal((await send({ message: "same text" }, { as: A })).status, 200);
  assert.equal((await send({ message: "with my name", with_name: true }, { as: A })).status, 200);
  assert.equal((await send({ message: "named but logged out", with_name: true })).status, 200);
  assert.equal((await send({ message: "x" })).status, 400);
  const reps = await api("GET", "admin/errors?kind=report", { as: OWNER });
  assert.equal(reps.body.open_reports, 4);
  const by = Object.fromEntries(reps.body.rows.map(r => [r.message, r.reporter]));
  assert.equal(by["with my name"], "user1001 (#1001)"); assert.equal(by["same text"], null); assert.equal(by["named but logged out"], null);
  assert.ok(reps.body.rows.every(r => r.kind === "report"));
  const errs = await api("GET", "admin/errors", { as: OWNER });
  assert.ok(errs.body.rows.every(r => r.kind === "error"), "errors list has no reports");
  assert.equal((await send({ message: "sixth one" })).status, 429, "5 a minute per IP");
  assert.equal((await api("GET", "me", { as: OWNER })).body.badges.errors, reps.body.open, "the count includes reports");
});
