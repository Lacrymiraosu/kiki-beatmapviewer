// Database rules, run against a real PostgreSQL (PGlite) with the migrations from supabase/migrations.
import { test, before } from "node:test";
import assert from "node:assert/strict";
// OBV_D1=1: the same rules against the D1 versions of the functions (api/_lib/d1.js)
const { freshDb, rpc, rpcErr, asRole, putObject, deleteObjects, sha } = process.env.OBV_D1 ? await import("./lib/d1db.mjs") : await import("./lib/pg.mjs");

const A = 1001, B = 1002, C = 1003, OWNER = 9999;
const LIMIT = 30000000;
let db;
const code = e => (e.message.match(/OBV:(\w+)/) || [])[1] || e.message;
const file = (path, size, content = path + size) => ({ path, size, sha256: sha(content) });

async function login(id, name = "user" + id) { return rpc(db, "obv_user_login", { p_id: id, p_username: name, p_avatar: `https://a.ppy.sh/${id}`, p_country: "TH" }); }
async function create(actor, key = "key-" + actor + "-" + Math.random().toString(36).slice(2, 10), title = "Song") {
  return rpc(db, "obv_project_create", { p_actor: actor, p_client_key: key, p_title: title, p_artist: "Artist", p_creator: "mapper", p_set_id: null });
}
// begin -> "upload" (storage row with the real size) -> commit
async function save(actor, pid, base, files, { upload = true, sizes = {}, annotations = null } = {}) {
  const b = await rpc(db, "obv_save_begin", { p_actor: actor, p_project: pid, p_base_revision: base, p_files: files });
  if (upload) for (const u of b.uploads) await putObject(db, u.key, sizes[u.path] ?? u.size);
  const c = await rpc(db, "obv_save_commit", { p_actor: actor, p_save: b.save_id, p_annotations: annotations });
  return { begin: b, commit: c };
}
async function project(pid) { return (await db.query("select * from obv.projects where id = $1", [pid])).rows[0]; }
async function setExpired(pid) { // simulate the passing of 15 days (the trigger forbids changing expires_at otherwise)
  await db.exec("alter table obv.projects disable trigger projects_fix_expiry");
  await db.query("update obv.projects set expires_at = now() - interval '1 second' where id = $1", [pid]);
  await db.exec("alter table obv.projects enable trigger projects_fix_expiry");
}

before(async () => {
  db = await freshDb();
  await db.query("update obv.settings set value = '100' where key = 'max_projects_per_user'");
  for (const id of [A, B, C, OWNER]) await login(id);
});

test("the browser roles (anon/authenticated) can't reach projects, blobs or any obv_ function", { skip: process.env.OBV_D1 ? "D1 has no database roles: only the Worker reaches it" : false }, async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(asRole(db, role, "select * from obv.projects"), /permission denied/);
    await assert.rejects(asRole(db, role, "select * from obv.blobs"), /permission denied/);
    await assert.rejects(asRole(db, role, "select * from obv.users"), /permission denied/);
    await assert.rejects(rpc(db, "obv_projects_list", { p_actor: A }, role), /permission denied/);
    await assert.rejects(rpc(db, "obv_changelog_admin", {}, role), /permission denied/);
    await assert.rejects(rpc(db, "obv_admin_overview", {}, role), /permission denied/);
    await assert.rejects(rpc(db, "obv_changelog_public", {}, role), /permission denied/); // even this goes through the server
  }
});

test("new project: expires 15 days after creation; a retry with the same client key returns the same project", async () => {
  const p1 = await create(A, "same-key-123");
  const p2 = await create(A, "same-key-123");
  assert.equal(p1.id, p2.id);
  assert.equal(p2.existing, true);
  const row = await project(p1.id);
  assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 15 * 864e5);
  assert.equal(p1.role, "owner");
  assert.equal(p1.limit_bytes, LIMIT);
});

test("user A can't read, change, share, save or delete user B's private project", async () => {
  const p = await create(B);
  await save(B, p.id, 0, [file("map.osu", 1000)]);
  for (const [fn, args] of [
    ["obv_project_get", { p_actor: A, p_project: p.id }],
    ["obv_project_role", { p_actor: A, p_project: p.id }],
    ["obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 1, p_files: [file("x.osu", 10)] }],
    ["obv_project_delete", { p_actor: A, p_project: p.id }],
    ["obv_member_set", { p_actor: A, p_project: p.id, p_user: A, p_username: "a", p_avatar: null, p_role: "editor" }],
  ]) assert.equal(code(await rpcErr(db, fn, args)), "not_found", fn);
  const list = await rpc(db, "obv_projects_list", { p_actor: A });
  assert.ok(!list.some(x => x.id === p.id));
  assert.equal((await project(p.id)).status, "active");
});

test("sharing: viewers read only, editors save, owners manage; revoking removes access", async () => {
  const p = await create(A);
  await save(A, p.id, 0, [file("map.osu", 500)]);
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: B, p_username: "b", p_avatar: null, p_role: "viewer" });
  const got = await rpc(db, "obv_project_get", { p_actor: B, p_project: p.id });
  assert.equal(got.role, "viewer");
  assert.deepEqual(got.members, []); // only the owner sees the member list
  assert.equal(code(await rpcErr(db, "obv_save_begin", { p_actor: B, p_project: p.id, p_base_revision: 1, p_files: [file("map.osu", 10)] })), "forbidden");
  assert.equal(code(await rpcErr(db, "obv_project_delete", { p_actor: B, p_project: p.id })), "forbidden");
  assert.equal(code(await rpcErr(db, "obv_member_set", { p_actor: B, p_project: p.id, p_user: C, p_username: "c", p_avatar: null, p_role: "viewer" })), "forbidden");
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: B, p_username: "b", p_avatar: null, p_role: "editor" });
  const r = await save(B, p.id, 1, [file("map.osu", 600)]);
  assert.equal(r.commit.revision, 2);
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: B, p_username: "b", p_avatar: null, p_role: "none" });
  assert.equal(code(await rpcErr(db, "obv_project_get", { p_actor: B, p_project: p.id })), "not_found");
});

test("30,000,000 bytes per project: exactly the limit is fine, one byte more is refused", async () => {
  const p = await create(A);
  const ok = await save(A, p.id, 0, [file("song.mp3", 29000000), file("map.osu", 1000000)]);
  assert.equal(ok.commit.size_bytes, LIMIT);
  const e = await rpcErr(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 1, p_files: [file("song.mp3", 29000000), file("map.osu", 1000001, "other")] });
  assert.equal(code(e), "too_large");
});

test("lying about sizes doesn't get around the limit: commit checks what Storage really stored", async () => {
  const p = await create(A);
  const b = await rpc(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 0, p_files: [file("song.mp3", 1000), file("map.osu", 100)] });
  await putObject(db, b.uploads[0].key, 29999999); // declared 1000, uploaded ~30 MB
  await putObject(db, b.uploads[1].key, 100);
  assert.equal(code(await rpcErr(db, "obv_save_commit", { p_actor: A, p_save: b.save_id, p_annotations: null })), "size_mismatch");
  const row = await project(p.id);
  assert.equal(row.revision, 0);
  assert.equal(Number(row.size_bytes), 0);
});

test("a save whose upload never arrived fails and the previous revision stays complete", async () => {
  const p = await create(A);
  const r1 = await save(A, p.id, 0, [file("map.osu", 100, "v1"), file("bg.jpg", 5000)]);
  const before = await project(p.id);
  const b = await rpc(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 1, p_files: [file("map.osu", 120, "v2"), file("bg.jpg", 5000)] });
  assert.equal(b.uploads.length, 1, "only the changed file is uploaded");
  assert.equal(b.reused, 1);
  assert.equal(code(await rpcErr(db, "obv_save_commit", { p_actor: A, p_save: b.save_id, p_annotations: null })), "missing_upload");
  const after = await project(p.id);
  assert.equal(after.revision, 1);
  assert.deepEqual(after.manifest, before.manifest);
  for (const m of after.manifest) {
    const blob = (await db.query("select state from obv.blobs where key = $1", [m.key])).rows[0];
    assert.equal(blob.state, "committed");
  }
  assert.equal(r1.commit.revision, 1);
});

test("saving never moves expires_at, and nothing else can change it either", async () => {
  const p = await create(A);
  const e0 = (await project(p.id)).expires_at.getTime();
  await save(A, p.id, 0, [file("map.osu", 100, "a")]);
  await save(A, p.id, 1, [file("map.osu", 100, "b")]);
  await rpc(db, "obv_project_get", { p_actor: A, p_project: p.id });
  assert.equal((await project(p.id)).expires_at.getTime(), e0);
  await assert.rejects(db.query("update obv.projects set expires_at = expires_at + interval '1 day' where id = $1", [p.id]), /expiry_immutable/);
});

test("stale saves are refused (revision check), not silently overwritten", async () => {
  const p = await create(A);
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: B, p_username: "b", p_avatar: null, p_role: "editor" });
  await save(A, p.id, 0, [file("map.osu", 100, "base")]);
  const a = await rpc(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 1, p_files: [file("map.osu", 101, "A")] });
  const b = await rpc(db, "obv_save_begin", { p_actor: B, p_project: p.id, p_base_revision: 1, p_files: [file("map.osu", 102, "B")] });
  for (const u of [...a.uploads, ...b.uploads]) await putObject(db, u.key, u.size);
  await rpc(db, "obv_save_commit", { p_actor: A, p_save: a.save_id, p_annotations: null });
  const e = await rpcErr(db, "obv_save_commit", { p_actor: B, p_save: b.save_id, p_annotations: null });
  assert.equal(code(e), "conflict");
  assert.match(e.detail, /"revision": 2/);
  const row = await project(p.id);
  assert.equal(row.manifest[0].sha256, sha("A"));
  // starting a save from an old revision is refused straight away too
  assert.equal(code(await rpcErr(db, "obv_save_begin", { p_actor: B, p_project: p.id, p_base_revision: 1, p_files: [file("map.osu", 5)] })), "conflict");
});

test("committing twice (retry after a lost response) is harmless", async () => {
  const p = await create(A);
  const b = await rpc(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 0, p_files: [file("map.osu", 10)] });
  for (const u of b.uploads) await putObject(db, u.key, u.size);
  const c1 = await rpc(db, "obv_save_commit", { p_actor: A, p_save: b.save_id, p_annotations: null });
  const c2 = await rpc(db, "obv_save_commit", { p_actor: A, p_save: b.save_id, p_annotations: null });
  assert.equal(c1.revision, 1); assert.equal(c2.revision, 1); assert.equal(c2.already, true);
  assert.equal((await project(p.id)).revision, 1);
});

test("replaced files become orphans and are garbage-collected only after a grace period, and only if gone from storage", async () => {
  const p = await create(A);
  const r1 = await save(A, p.id, 0, [file("map.osu", 10, "one")]);
  const oldKey = r1.commit.manifest[0].key;
  await save(A, p.id, 1, [file("map.osu", 11, "two")]);
  assert.equal((await db.query("select state from obv.blobs where key = $1", [oldKey])).rows[0].state, "orphaned");
  assert.ok(!(await rpc(db, "obv_gc_list", { p_limit: 100 })).includes(oldKey), "not before 30 minutes");
  await db.query("update obv.blobs set orphaned_at = now() - interval '31 minutes' where key = $1", [oldKey]);
  assert.ok((await rpc(db, "obv_gc_list", { p_limit: 100 })).includes(oldKey));
  assert.equal((await rpc(db, "obv_gc_finish", { p_keys: [oldKey] })).deleted, 0, "still in storage: row kept");
  await deleteObjects(db, [oldKey]);
  assert.equal((await rpc(db, "obv_gc_finish", { p_keys: [oldKey] })).deleted, 1);
});

test("expired projects are refused at once; cleanup removes rows only after every file is gone; changelog untouched", async () => {
  const p = await create(A, undefined, "Expiring");
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: B, p_username: "b", p_avatar: null, p_role: "editor" });
  const ann = { upsert: [{ id: "11111111-1111-4111-8111-111111111111", diff: "map.osu", kind: "comment", object_id: "5", time_ms: 1000, body: "spacing" }] };
  await save(A, p.id, 0, [file("map.osu", 10, "e1"), file("song.mp3", 20, "e2")], { annotations: ann });
  const changelogBefore = (await db.query("select count(*)::int as n from obv.changelog")).rows[0].n;
  await setExpired(p.id);
  assert.equal(code(await rpcErr(db, "obv_project_get", { p_actor: A, p_project: p.id })), "expired");
  assert.equal(code(await rpcErr(db, "obv_project_get", { p_actor: B, p_project: p.id })), "expired");
  assert.equal(code(await rpcErr(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 1, p_files: [file("map.osu", 5)] })), "expired");
  assert.ok(!(await rpc(db, "obv_projects_list", { p_actor: A })).some(x => x.id === p.id));
  const due = await rpc(db, "obv_cleanup_due", { p_limit: 10 });
  const item = due.find(x => x.id === p.id);
  assert.equal(item.keys.length, 2);
  // the server failed to delete one file: the project row must stay (so the file isn't forgotten)
  await deleteObjects(db, [item.keys[0]]);
  const half = await rpc(db, "obv_cleanup_finish", { p_project: p.id, p_error: "storage timeout" });
  assert.equal(half.done, false);
  const row = await project(p.id);
  assert.equal(row.status, "deleting"); assert.equal(row.cleanup_attempts, 1); assert.equal(row.cleanup_error, "storage timeout");
  // retry
  const again = (await rpc(db, "obv_cleanup_due", { p_limit: 10 })).find(x => x.id === p.id);
  assert.deepEqual(again.keys, [item.keys[1]]);
  await deleteObjects(db, again.keys);
  assert.equal((await rpc(db, "obv_cleanup_finish", { p_project: p.id, p_error: null })).done, true);
  assert.equal(await project(p.id), undefined);
  for (const t of ["members", "annotations", "saves", "blobs"])
    assert.equal((await db.query(`select count(*)::int as n from obv.${t} where project_id = $1`, [p.id])).rows[0].n, 0, t);
  assert.equal((await db.query("select count(*)::int as n from obv.changelog")).rows[0].n, changelogBefore);
});

test("a project row can't be deleted while its blob rows exist (no orphaned storage files)", async () => {
  const p = await create(A);
  await save(A, p.id, 0, [file("map.osu", 10, "fk")]);
  await assert.rejects(db.query("delete from obv.projects where id = $1", [p.id]), /foreign key/i);
});

test("owner delete: access stops immediately, then files and rows go", async () => {
  const p = await create(A);
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: B, p_username: "b", p_avatar: null, p_role: "viewer" });
  await save(A, p.id, 0, [file("map.osu", 10, "del")]);
  await rpc(db, "obv_project_delete", { p_actor: A, p_project: p.id });
  assert.equal(code(await rpcErr(db, "obv_project_get", { p_actor: B, p_project: p.id })), "not_found");
  const k = await rpc(db, "obv_cleanup_keys", { p_project: p.id });
  await deleteObjects(db, k.keys);
  assert.equal((await rpc(db, "obv_cleanup_finish", { p_project: p.id, p_error: null })).done, true);
});

test("annotations: author edits text, other editors only move the anchor, owner may delete, stale versions conflict", async () => {
  const p = await create(A);
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: B, p_username: "b", p_avatar: null, p_role: "editor" });
  const id1 = "22222222-2222-4222-8222-222222222222", id2 = "33333333-3333-4333-8333-333333333333";
  await save(B, p.id, 0, [file("map.osu", 10, "an1")], { annotations: { upsert: [
    { id: id1, diff: "map.osu", kind: "comment", object_id: "42", time_ms: 1500, body: "too far" },
    { id: id2, diff: "map.osu", kind: "arrow", object_id: "43", time_ms: 1600, body: "", data: { x1: 1, y1: 2, x2: 30, y2: 40 } }] } });
  let got = await rpc(db, "obv_project_get", { p_actor: A, p_project: p.id });
  assert.equal(got.annotations.length, 2);
  assert.equal(got.annotations.find(x => x.id === id1).author.id, B);
  // A (owner, not author) edits the text: allowed for the owner
  await save(A, p.id, 1, [file("map.osu", 10, "an1")], { annotations: { upsert: [{ id: id1, diff: "map.osu", kind: "comment", object_id: "42", time_ms: 1500, body: "owner edit", base_version: 1 }] } });
  // C editor (not author): text change ignored, anchor (object moved / deleted) kept up to date
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: C, p_username: "c", p_avatar: null, p_role: "editor" });
  const r = await save(C, p.id, 2, [file("map.osu", 10, "an1")], { annotations: { upsert: [
    { id: id1, diff: "map.osu", kind: "comment", object_id: "42", time_ms: 1750, body: "hijack", base_version: 2 },
    { id: id2, diff: "map.osu", kind: "arrow", object_id: "43", time_ms: 1600, object_missing: true, body: "", data: { x1: 1, y1: 2, x2: 30, y2: 40 } }],
    delete: [{ id: id2 }] } });
  assert.deepEqual(r.commit.annotations.denied, [id2]);
  got = await rpc(db, "obv_project_get", { p_actor: A, p_project: p.id });
  const a1 = got.annotations.find(x => x.id === id1), a2 = got.annotations.find(x => x.id === id2);
  assert.equal(a1.body, "owner edit"); assert.equal(a1.time_ms, 1750);
  assert.equal(a2.object_missing, true);
  // B edits with a stale version -> conflict, nothing changes
  const s = await save(B, p.id, 3, [file("map.osu", 10, "an1")], { annotations: { upsert: [{ id: id1, diff: "map.osu", kind: "comment", object_id: "42", time_ms: 1750, body: "old", base_version: 1 }] } });
  assert.deepEqual(s.commit.annotations.conflicts, [id1]);
  // viewers can't save at all (so they can't annotate)
  await rpc(db, "obv_member_set", { p_actor: A, p_project: p.id, p_user: C, p_username: "c", p_avatar: null, p_role: "viewer" });
  assert.equal(code(await rpcErr(db, "obv_save_begin", { p_actor: C, p_project: p.id, p_base_revision: 4, p_files: [file("map.osu", 10, "an1")] })), "forbidden");
  // garbage in annotations doesn't break the save
  const g = await save(A, p.id, 4, [file("map.osu", 10, "an1")], { annotations: { upsert: [{ id: "not-a-uuid" }, { id: "44444444-4444-4444-8444-444444444444", diff: "../x", kind: "comment", time_ms: "abc" }] } });
  assert.equal(g.commit.revision, 5);
});

test("suspended accounts can't use cloud projects", async () => {
  const p = await create(C);
  await rpc(db, "obv_admin_user_status", { p_actor: OWNER, p_user: C, p_status: "suspended", p_reason: "spam" });
  assert.equal(code(await rpcErr(db, "obv_project_get", { p_actor: C, p_project: p.id })), "suspended");
  assert.equal(code(await rpcErr(db, "obv_project_create", { p_actor: C, p_client_key: "abcdefgh1", p_title: "", p_artist: "", p_creator: "", p_set_id: null })), "suspended");
  await rpc(db, "obv_admin_user_status", { p_actor: OWNER, p_user: C, p_status: "active", p_reason: null });
  assert.equal((await rpc(db, "obv_project_get", { p_actor: C, p_project: p.id })).role, "owner");
  const audit = await rpc(db, "obv_admin_audit", { p_limit: 50, p_offset: 0 });
  assert.ok(audit.rows.some(r => r.action === "user.suspended" && r.target_id === String(C) && r.actor === OWNER));
});

test("paths are checked, per-user project count is limited", async () => {
  const p = await create(A);
  for (const bad of ["../x.osu", "/abs.osu", "a/../b", "a\\b.osu", "", "a//b"])
    assert.equal(code(await rpcErr(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 0, p_files: [file(bad, 1)] })), "bad_files", bad);
  assert.equal(code(await rpcErr(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 0, p_files: [file("a.osu", 1), file("A.OSU", 2)] })), "bad_files");
  await db.query("update obv.settings set value = '10' where key = 'max_projects_per_user'");
  const D = 1004; await login(D);
  for (let i = 0; i < 10; i++) await create(D);
  assert.equal(code(await rpcErr(db, "obv_project_create", { p_actor: D, p_client_key: "one-too-many", p_title: "", p_artist: "", p_creator: "", p_set_id: null })), "too_many_projects");
  await db.query("update obv.settings set value = '100' where key = 'max_projects_per_user'");
});

test("changelog: drafts stay private, publish/unpublish/reorder/delete work and are audited; anon sees published only", async () => {
  const d = await rpc(db, "obv_changelog_save", { p_actor: OWNER, p_id: null, p_title: "Draft note", p_version: "v99", p_content: "- secret", p_status: "draft", p_published_at: null, p_base_updated_at: null });
  let pub = await rpc(db, "obv_changelog_public");
  assert.ok(!pub.some(x => x.id === d.id), "draft not public");
  if (!process.env.OBV_D1) { // (Postgres row-level security; D1 has no database roles)
    const anonRows = (await asRole(db, "anon", "select id, status from obv.changelog")).rows;
    assert.ok(anonRows.length > 0 && anonRows.every(r => r.status === "published"), "RLS: anon reads published rows only");
    assert.ok(!anonRows.some(r => r.id === d.id));
    await assert.rejects(asRole(db, "anon", "update obv.changelog set title = 'x'"), /permission denied/);
    await assert.rejects(asRole(db, "anon", "insert into obv.changelog (title) values ('x')"), /permission denied/);
  }
  const p1 = await rpc(db, "obv_changelog_save", { p_actor: OWNER, p_id: d.id, p_title: "Now public", p_version: "v99", p_content: "- hello", p_status: "published", p_published_at: null, p_base_updated_at: d.updated_at });
  assert.ok(p1.published_at);
  pub = await rpc(db, "obv_changelog_public");
  assert.equal(pub[0].id, d.id, "newest first");
  // a stale editor tab can't overwrite a newer edit
  assert.equal(code(await rpcErr(db, "obv_changelog_save", { p_actor: OWNER, p_id: d.id, p_title: "stale", p_version: "", p_content: "", p_status: "published", p_published_at: null, p_base_updated_at: d.updated_at })), "conflict");
  await rpc(db, "obv_changelog_move", { p_actor: OWNER, p_id: d.id, p_dir: -1 });
  assert.equal((await rpc(db, "obv_changelog_admin"))[1].id, d.id, "moved down one place (in the full list, drafts included)");
  await rpc(db, "obv_changelog_move", { p_actor: OWNER, p_id: d.id, p_dir: 1 });
  assert.equal((await rpc(db, "obv_changelog_public"))[0].id, d.id);
  const un = await rpc(db, "obv_changelog_save", { p_actor: OWNER, p_id: d.id, p_title: "Now public", p_version: "v99", p_content: "- hello", p_status: "draft", p_published_at: null, p_base_updated_at: p1.updated_at });
  assert.ok(!(await rpc(db, "obv_changelog_public")).some(x => x.id === d.id), "unpublished");
  await rpc(db, "obv_changelog_delete", { p_actor: OWNER, p_id: un.id });
  const actions = (await rpc(db, "obv_admin_audit", { p_limit: 100, p_offset: 0 })).rows.filter(r => r.target_id === d.id).map(r => r.action);
  for (const a of ["changelog.create", "changelog.publish", "changelog.reorder", "changelog.unpublish", "changelog.delete"]) assert.ok(actions.includes(a), a);
  assert.equal(code(await rpcErr(db, "obv_changelog_save", { p_actor: OWNER, p_id: null, p_title: " ", p_version: "", p_content: "", p_status: "draft", p_published_at: null, p_base_updated_at: null })), "bad_request");
});

test("the changelog starts over with one published first-release entry", async () => {
  const pub = await rpc(db, "obv_changelog_public");
  const first = pub.filter(x => x.version_label === "v1.0");
  assert.equal(first.length, 1);
  assert.equal(first[0].title, "First release");
  assert.match(first[0].content_md, /### Editor/);
  assert.ok(!pub.some(x => /^v(1[0-2]|[1-9])$/.test(x.version_label)), "the old entries are gone");
});

test("admin overview and storage figures come from the database and storage.objects", async () => {
  const o = await rpc(db, "obv_admin_overview");
  assert.equal(o.limit_bytes, LIMIT);
  assert.ok(o.storage.bytes >= o.tracked_bytes.committed - 1);
  assert.equal(typeof o.untracked.objects, "number");
  const projects = await rpc(db, "obv_admin_projects", { p_q: "", p_status: "", p_limit: 5, p_offset: 0 });
  assert.ok(projects.total > 0 && projects.rows.length <= 5);
  const users = await rpc(db, "obv_admin_users", { p_q: "user100", p_limit: 10, p_offset: 0 });
  assert.ok(users.rows.every(u => u.username.includes("user100")));
});

test("settings: admins change limits within safe ranges; new projects follow them; changes are audited", async () => {
  const s0 = await rpc(db, "obv_admin_settings");
  assert.equal(s0.settings.find(x => x.key === "max_project_bytes").value, LIMIT);
  for (const bad of [{ max_project_bytes: 10 }, { retention_days: 0 }, { retention_days: 1.5 }, { saving_enabled: "yes" }, { nope: 1 }, { max_projects_per_user: "5" }])
    assert.equal(code(await rpcErr(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: bad })), "bad_request", JSON.stringify(bad));
  const r = await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { max_project_bytes: 50000000, retention_days: 30 } });
  assert.deepEqual(Object.keys(r.changed).sort(), ["max_project_bytes", "retention_days"]);
  assert.equal(r.bucket.bucket_limit, 50000000);
  if (!process.env.OBV_D1) assert.equal(Number((await db.query("select file_size_limit from storage.buckets where id = 'obv-projects'")).rows[0].file_size_limit), 50000000, "bucket follows"); // (Supabase Storage only)
  const p = await create(A);
  assert.equal(p.limit_bytes, 50000000);
  const row = await project(p.id);
  assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 30 * 864e5);
  await save(A, p.id, 0, [file("big.mp3", 40000000)]);  // above the old 30 MB
  assert.ok((await rpc(db, "obv_admin_audit", { p_limit: 20, p_offset: 0, p_action: "settings" })).rows.some(x => x.action === "settings.change"));
  await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { max_project_bytes: LIMIT, retention_days: 15 } });
  assert.equal((await create(A)).limit_bytes, LIMIT);
});

test("per-user limits override the site-wide ones, and null goes back to the default", async () => {
  const E = 1005; await login(E);
  let u = await rpc(db, "obv_admin_user_update", { p_actor: OWNER, p_actor_is_owner: true, p_owner_id: OWNER, p_user: E, p_patch: { max_projects: 1, max_project_bytes: 60000000, retention_days: 3, note: "  trusted mapper  " } });
  assert.equal(u.limits.max_projects, 1); assert.equal(u.limits.max_project_bytes, 60000000); assert.equal(u.note, "trusted mapper");
  assert.equal((await rpc(db, "obv_user_touch", { p_id: E, p_username: "user1005", p_avatar: null, p_country: null })).limits.retention_days, 3);
  const p = await create(E);
  const row = await project(p.id);
  assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 3 * 864e5);
  assert.equal(code(await rpcErr(db, "obv_project_create", { p_actor: E, p_client_key: "second-one", p_title: "", p_artist: "", p_creator: "", p_set_id: null })), "too_many_projects");
  // an editor saving into E's project gets E's (the owner's) limit
  await rpc(db, "obv_member_set", { p_actor: E, p_project: p.id, p_user: A, p_username: "user1001", p_avatar: null, p_role: "editor" });
  await save(A, p.id, 0, [file("song.mp3", 55000000)]);
  assert.equal(code(await rpcErr(db, "obv_admin_user_update", { p_actor: OWNER, p_actor_is_owner: true, p_owner_id: OWNER, p_user: E, p_patch: { retention_days: 999 } })), "bad_request");
  u = await rpc(db, "obv_admin_user_update", { p_actor: OWNER, p_actor_is_owner: true, p_owner_id: OWNER, p_user: E, p_patch: { max_projects: null, max_project_bytes: null, retention_days: null } });
  assert.equal(u.limits.max_project_bytes, LIMIT); assert.equal(u.limits.custom.max_projects, false);
  assert.equal(u.projects.length, 1);
});

test("admins: only the owner adds or removes them; admins can't suspend each other or the owner; nobody changes themselves", async () => {
  const M = 1006, N = 1007; await login(M); await login(N);
  const up = (actor, isOwner, user, patch) => rpc(db, "obv_admin_user_update", { p_actor: actor, p_actor_is_owner: isOwner, p_owner_id: OWNER, p_user: user, p_patch: patch });
  const upErr = (actor, isOwner, user, patch) => rpcErr(db, "obv_admin_user_update", { p_actor: actor, p_actor_is_owner: isOwner, p_owner_id: OWNER, p_user: user, p_patch: patch });
  await up(OWNER, true, M, { role: "admin" });
  assert.equal((await rpc(db, "obv_admin_role", { p_id: M })).role, "admin");
  assert.ok((await rpc(db, "obv_admin_admins", { p_owner_id: OWNER })).some(a => a.id === M));
  assert.equal(code(await upErr(M, false, N, { role: "admin" })), "forbidden", "an admin can't make admins");
  await up(OWNER, true, N, { role: "admin" });
  assert.equal(code(await upErr(M, false, N, { status: "suspended" })), "forbidden", "an admin can't suspend another admin");
  assert.equal(code(await upErr(M, false, OWNER, { status: "suspended" })), "forbidden", "nor the owner");
  assert.equal(code(await upErr(M, false, M, { status: "suspended" })), "forbidden", "nor themselves");
  assert.equal(code(await upErr(OWNER, true, OWNER, { role: "user" })), "forbidden");
  await up(M, false, C, { status: "suspended", reason: "spam" });  // but they can suspend normal users
  await up(M, false, C, { status: "active" });
  await up(OWNER, true, N, { role: "user" });
  assert.equal((await rpc(db, "obv_admin_role", { p_id: N })).role, "user");
  const acts = (await rpc(db, "obv_admin_audit", { p_limit: 50, p_offset: 0, p_action: "admin." })).rows.map(r => r.action);
  assert.ok(acts.includes("admin.add") && acts.includes("admin.remove"));
});

test("an admin can move one project's expiry; nothing else can, and not into the past", async () => {
  const p = await create(A);
  const to = new Date(Date.now() + 40 * 864e5).toISOString();
  const r = await rpc(db, "obv_admin_project_expiry", { p_actor: OWNER, p_project: p.id, p_expires_at: to });
  assert.equal(new Date(r.expires_at).getTime(), new Date(to).getTime());
  assert.equal(code(await rpcErr(db, "obv_admin_project_expiry", { p_actor: OWNER, p_project: p.id, p_expires_at: new Date(Date.now() - 1000).toISOString() })), "bad_request");
  assert.equal(code(await rpcErr(db, "obv_admin_project_expiry", { p_actor: OWNER, p_project: p.id, p_expires_at: new Date(Date.now() + 400 * 864e5).toISOString() })), "bad_request");
  await assert.rejects(db.query("update obv.projects set expires_at = expires_at + interval '1 day' where id = $1", [p.id]), /expiry_immutable/);
  const d = await rpc(db, "obv_admin_project_get", { p_project: p.id });
  assert.equal(d.status, "active"); assert.ok(Array.isArray(d.files) && Array.isArray(d.saves));
});

test("pausing online saving stops new projects and saves, but reading still works", async () => {
  const p = await create(A);
  await save(A, p.id, 0, [file("a.osu", 10)]);
  await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { saving_enabled: false } });
  try {
    assert.equal(code(await rpcErr(db, "obv_project_create", { p_actor: A, p_client_key: "paused-key", p_title: "", p_artist: "", p_creator: "", p_set_id: null })), "saving_disabled");
    assert.equal(code(await rpcErr(db, "obv_save_begin", { p_actor: A, p_project: p.id, p_base_revision: 1, p_files: [file("a.osu", 11)] })), "saving_disabled");
    assert.equal((await rpc(db, "obv_project_get", { p_actor: A, p_project: p.id })).revision, 1);
  } finally { await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { saving_enabled: true } }); }
});

test("admin lists: filters and sorting", async () => {
  const big = await rpc(db, "obv_admin_projects", { p_q: "", p_status: "active", p_limit: 5, p_offset: 0, p_sort: "size", p_owner: null });
  const sizes = big.rows.map(r => r.size_bytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
  const mine = await rpc(db, "obv_admin_projects", { p_q: "", p_status: "", p_limit: 100, p_offset: 0, p_sort: "", p_owner: A });
  assert.ok(mine.rows.length && mine.rows.every(r => r.owner.id === A));
  const byBytes = await rpc(db, "obv_admin_users", { p_q: "", p_limit: 50, p_offset: 0, p_status: "active", p_role: "", p_sort: "bytes" });
  const b = byBytes.rows.map(r => Number(r.bytes)); assert.deepEqual(b, [...b].sort((x, y) => y - x));
  const o = await rpc(db, "obv_admin_overview");
  assert.equal(o.saves_by_day.length, 14); assert.ok(o.saves_7d > 0); assert.ok(o.top_users.length > 0);
});
