// The one-time move of the database from Supabase to D1 (api/_lib/d1copy.js): everything written through the Postgres
// functions ends up the same on D1, and the D1 functions read it back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, rpc, putObject, sha } from "./lib/pg.mjs";
import { fakeD1 } from "./emu/d1-fake.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { copyToD1, d1Counts } = require(join(root, "api/_lib/d1copy.js"));
const { F, Q } = require(join(root, "api/_lib/d1.js"));
const sqliteOk = (() => { try { require("node:sqlite"); return true; } catch { return false; } })();

test("copy Supabase → D1", { skip: !sqliteOk && "needs node --experimental-sqlite" }, async () => {
  const pg = await freshDb(), call = (n, a) => rpc(pg, n, a);
  // a small site: an owner, an invited user, a project with a member, a save with files and annotations, settings, a report
  await call("obv_user_login", { p_id: 1, p_username: "owner", p_avatar: null, p_country: "TH" });
  const inv = await call("obv_invite_mine", { p_actor: 1, p_owner_id: 1 });
  await call("obv_invite_accept", { p_id: 2, p_username: "friend", p_avatar: null, p_country: "JP", p_code: inv.code, p_owner_id: 1 });
  const p = await call("obv_project_create", { p_actor: 1, p_client_key: "abcdefgh12", p_title: "Song", p_artist: "Artist", p_creator: "owner", p_set_id: 123 });
  await call("obv_member_set", { p_actor: 1, p_project: p.id, p_user: 2, p_username: "friend", p_avatar: null, p_role: "editor" });
  const body = "osu file", s = await call("obv_save_begin", { p_actor: 1, p_project: p.id, p_base_revision: 0, p_files: [{ path: "a.osu", size: body.length, sha256: sha(body) }] });
  for (const f of s.uploads) await putObject(pg, f.key, f.size);
  await call("obv_save_commit", { p_actor: 1, p_save: s.save_id, p_annotations: { upsert: [{ id: "6f1c3e2a-1b2c-4d3e-8f40-123456789abc", diff: "a.osu", kind: "comment", time_ms: 1000, body: "hi", data: { x: 1 } }] } });
  await call("obv_admin_settings_set", { p_actor: 1, p_values: { retention_days: 20 } });
  await call("obv_error_report", { p_message: "boom", p_source: "x.js", p_stack: "", p_page: "/", p_version: "1", p_browser: "t" });

  const d1 = fakeD1(root);
  await d1.prepare("insert into users (osu_id, username) values (99, 'stale')").run(); // (replaced by the copy)
  const r = await copyToD1(call, d1, 1);
  assert.equal(r.ok, true, JSON.stringify(r.tables));
  assert.equal(r.tables.users.d1, 2); assert.equal(r.tables.projects.d1, 1); assert.equal(r.tables.annotations.d1, 1);
  assert.ok(r.tables.blobs.d1 >= 1 && r.tables.saves.d1 >= 1 && r.tables.members.d1 === 1);
  const counts = await d1Counts(d1); assert.equal(counts.users, 2);

  // saving is paused on both sides; the settings came along
  assert.equal((await call("obv_admin_settings", {})).settings.find(x => x.key === "saving_enabled").value, false);
  const q = new Q(d1), set = await F.obv_admin_settings(q, {});
  assert.equal(set.settings.find(x => x.key === "saving_enabled").value, false);
  assert.equal(set.settings.find(x => x.key === "retention_days").value, 20);
  // the D1 functions read the copied data the same way
  const viaPg = await call("obv_project_get", { p_actor: 2, p_project: p.id }), viaD1 = await F.obv_project_get(q, { p_actor: 2, p_project: p.id });
  assert.equal(viaD1.title, "Song"); assert.equal(viaD1.revision, viaPg.revision); assert.deepEqual(viaD1.manifest, viaPg.manifest);
  assert.equal(Date.parse(viaD1.expires_at), Date.parse(viaPg.expires_at));
  assert.deepEqual(viaD1.annotations.map(a => [a.id, a.body, a.data]), viaPg.annotations.map(a => [a.id, a.body, a.data]));
  const norm = o => JSON.parse(JSON.stringify(o, (k, v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : v));
  assert.deepEqual(norm(await F.obv_admin_user_get(q, { p_user: 2 })), norm(await call("obv_admin_user_get", { p_user: 2 })));
  const raw = await d1.prepare("select invited_by from users where osu_id = 2").first(); assert.equal(raw.invited_by, 1);
  assert.equal((await d1.prepare("select count(*) n from client_errors").first()).n, 1);
  await pg.close();
});
