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

test("a non-owner admin can't change anything on their own account or the owner's; the owner can", async () => {
  const M = 4401, U = 4402; await login(M); await login(U);
  const up = (actor, isOwner, user, patch) => rpc(db, "obv_admin_user_update", { p_actor: actor, p_actor_is_owner: isOwner, p_owner_id: OWNER, p_user: user, p_patch: patch });
  const upErr = (actor, isOwner, user, patch) => rpcErr(db, "obv_admin_user_update", { p_actor: actor, p_actor_is_owner: isOwner, p_owner_id: OWNER, p_user: user, p_patch: patch });
  await up(OWNER, true, M, { role: "admin" });
  for (const patch of [{ max_projects: 1000 }, { max_project_bytes: 2000000000 }, { retention_days: 365 }, { note: "hi" }, { max_projects: null }]) {
    assert.equal(code(await upErr(M, false, M, patch)), "forbidden", "own account: " + JSON.stringify(patch));
    assert.equal(code(await upErr(M, false, OWNER, patch)), "forbidden", "owner's account: " + JSON.stringify(patch));
  }
  assert.equal((await rpc(db, "obv_admin_user_get", { p_user: M })).limits.custom.max_projects, false, "nothing was written");
  assert.equal((await rpc(db, "obv_admin_user_get", { p_user: OWNER })).limits.custom.max_project_bytes, false);
  // another (normal) user's limits are still theirs to change
  let u = await up(M, false, U, { max_projects: 3, max_project_bytes: 50000000, retention_days: 20, note: "ok" });
  assert.equal(u.limits.max_projects, 3); assert.equal(u.limits.max_project_bytes, 50000000); assert.equal(u.note, "ok");
  // the owner can change anything: their own limits, an admin's, a user's
  u = await up(OWNER, true, OWNER, { max_projects: 1000, max_project_bytes: 2000000000, retention_days: 365, note: "me" });
  assert.equal(u.limits.max_projects, 1000); assert.equal(u.limits.max_project_bytes, 2000000000); assert.equal(u.note, "me");
  u = await up(OWNER, true, M, { max_projects: 7, note: "admin" });
  assert.equal(u.limits.max_projects, 7); assert.equal(u.note, "admin");
  await up(OWNER, true, OWNER, { max_projects: null, max_project_bytes: null, retention_days: null, note: null });
  await up(OWNER, true, U, { max_projects: null, max_project_bytes: null, retention_days: null, note: null });
  await up(OWNER, true, M, { role: "user", max_projects: null, note: null });
});

test("invite codes: 10 characters from the unambiguous alphabet, all different", async () => {
  const re = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{10}$/, seen = new Set();
  const first = await rpc(db, "obv_invite_mine", { p_actor: A, p_owner_id: OWNER });
  assert.match(first.code, re); seen.add(first.code);
  for (let i = 0; i < 40; i++) {
    const c = (await rpc(db, "obv_invite_reset", { p_actor: A, p_owner_id: OWNER })).code;
    assert.match(c, re); assert.ok(!seen.has(c), "unique"); seen.add(c);
  }
  const l = await rpc(db, "obv_admin_invite_link_create", { p_actor: OWNER, p_owner_id: OWNER, p_max: 1, p_note: "rng" });
  assert.match(l.code, re); assert.ok(!seen.has(l.code));
  await rpc(db, "obv_admin_invite_link_update", { p_actor: OWNER, p_owner_id: OWNER, p_code: l.code, p_patch: { revoke: true } });
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

// a Google-only account moving into an osu! account (POST me/merge-google, once its owner confirms): see
// 20261008120000_obv_google_merge_safe.sql
test("Google-only merge: never lifts a denial; a denied or suspended Google-only account can't move; the preview says what would move", async () => {
  const D = 1301, N = 1302, S = 1303;
  for (const id of [D, N, S]) await login(id);
  const gacct = async (sub, set) => { const g = await rpc(db, "obv_google_account", { p_sub: sub }); if (set) await db.query(`update obv.users set ${set} where osu_id = $1`, [g.id]); return g.id; };
  const access = async id => (await db.query("select access from obv.users where osu_id = $1", [id])).rows[0].access;
  const merge = (from, to) => ["obv_google_merge", { p_from: from, p_to: to, p_username: "u" + to, p_avatar: null, p_country: null }];
  // an approved Google-only account into a denied osu! account: what it has moves, the denial stays
  const g1 = await gacct("merge-g1", "access = 'approved'"), p1 = await create(g1);
  await db.query("update obv.users set access = 'denied' where osu_id = $1", [D]);
  const pv = await rpc(db, "obv_google_merge_preview", { p_from: g1, p_to: D });
  assert.equal(pv.ok, true); assert.equal(pv.projects, 1); assert.ok(pv.created_at);
  assert.equal((await project(p1.id)).owner_id, g1, "the preview changes nothing");
  const m1 = await rpc(db, ...merge(g1, D));
  assert.equal(m1.merged, true); assert.equal(m1.projects, 1);
  assert.equal(await access(D), "denied"); assert.equal((await project(p1.id)).owner_id, D);
  // a denied or suspended Google-only account doesn't get out of it by moving into a fresh osu! account
  for (const [sub, set] of [["merge-g2", "access = 'denied'"], ["merge-g3", "status = 'suspended'"]]) {
    const g = await gacct(sub), p = await create(g); await db.query(`update obv.users set ${set} where osu_id = $1`, [g]);
    const v = await rpc(db, "obv_google_merge_preview", { p_from: g, p_to: N }); assert.equal(v.ok, false); assert.equal(v.reason, "source_denied");
    const e = await rpcErr(db, ...merge(g, N)); assert.equal(code(e), "forbidden"); assert.match(String(e.detail), /source_denied/);
    assert.equal((await project(p.id)).owner_id, g, sub); assert.equal(await access(N), "none"); assert.equal((await db.query("select status from obv.users where osu_id = $1", [N])).rows[0].status, "active");
  }
  // otherwise the better access of the two (approved > pending > none)
  const g4 = await gacct("merge-g4", "access = 'pending'");
  assert.equal((await rpc(db, ...merge(g4, S))).merged, true); assert.equal(await access(S), "pending");
  const g5 = await gacct("merge-g5", "access = 'approved'");
  assert.equal((await rpc(db, ...merge(g5, S))).merged, true); assert.equal(await access(S), "approved");
  const g6 = await gacct("merge-g6");
  assert.equal((await rpc(db, ...merge(g6, S))).merged, true); assert.equal(await access(S), "approved", "never downgraded");
  assert.equal((await rpc(db, "obv_google_merge_preview", { p_from: g6, p_to: S })).reason, "gone");
  assert.equal(code(await rpcErr(db, "obv_google_merge_preview", { p_from: D, p_to: S })), "bad_user");
});

// ---------- saved replays (20261010090000_obv_replays.sql / d1/migrations/0005_replays.sql / api/_lib/d1-replays.js) ----------
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const sha256 = b => createHash("sha256").update(b).digest("hex");
// a made-up replay file: byte 0 is the game mode, bytes 1..4 make each one different
const rpFile = (tag, { n = 64, mode = 0 } = {}) => { const b = Buffer.alloc(n, 7); b[0] = mode; if (n > 4) b.writeUInt32LE(tag, 1); return b; };
const rpArgs = (actor, b, meta = { mode: b[0], player: "p" }) => ({ p_actor: actor, p_sha256: sha256(b), p_size: b.length, p_meta: meta, p_data: b.toString("base64") });
const rpSave = (actor, b, meta) => rpc(db, "obv_replay_save", rpArgs(actor, b, meta));
const detailOf = e => JSON.parse(String(e.detail || "{}"));
async function setSetting(key, value) {
  if (value === null) return db.query("delete from obv.settings where key = $1", [key]);
  return db.query("insert into obv.settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value", [key, String(value)]);
}
const require_db = () => { const db = createRequire(import.meta.url)("../api/_lib/db.js"); db.useD1(process.env.OBV_D1 ? dbRef().d1 : null); return db; };
const dbRef = () => db;
const rpRows = async owner => (await db.query("select * from obv.replays where owner_id = $1", [owner])).rows;
const expire = id => db.query("update obv.replays set expires_at = now() - interval '1 second' where id = $1", [id]);
const RPA = 1401, RPB = 1402, RPC = 1403;
test("replays: save, list (never the file), open (the same bytes), delete; kept 60 days", async () => {
  for (const id of [RPA, RPB, RPC]) await login(id);
  const real = readFileSync(new URL("./fixtures/stable-small.osr", import.meta.url));
  const s = await rpSave(RPA, real, { mode: 0, player: "Tester", score: 123 });
  assert.equal(s.existed, false); assert.equal(s.replay.size, real.length); assert.equal(s.replay.sha256, sha256(real)); assert.deepEqual(s.replay.meta, { mode: 0, player: "Tester", score: 123 });
  const days = (Date.parse(s.replay.expires_at) - Date.parse(s.replay.created_at)) / 864e5;
  assert.ok(Math.abs(days - 60) < 0.01, "60 days: " + days);
  assert.ok(Date.parse(s.replay.expires_at) > Date.now() + 59 * 864e5);
  const l = await rpc(db, "obv_replay_list", { p_actor: RPA });
  assert.equal(l.replays.length, 1); assert.deepEqual(Object.keys(l.replays[0]).sort(), ["created_at", "expires_at", "id", "meta", "sha256", "share_key", "size"]); assert.equal(l.replays[0].share_key, null, "not shared");
  assert.ok(!JSON.stringify(l).includes(real.toString("base64").slice(0, 40)), "no file bytes in the list");
  assert.equal(l.limits.max_bytes, 1048576); assert.equal(l.limits.per_user, 20); assert.equal(l.limits.days, 60); assert.equal(l.limits.budget_bytes, 100000000); assert.ok(l.limits.used_bytes >= real.length);
  const g = await rpc(db, "obv_replay_get", { p_actor: RPA, p_id: s.replay.id });
  assert.deepEqual(Buffer.from(g.data, "base64"), real, "the same bytes come back"); assert.equal(g.replay.id, s.replay.id);
  // newest first
  const s2 = await rpSave(RPA, rpFile(2)); assert.deepEqual((await rpc(db, "obv_replay_list", { p_actor: RPA })).replays.map(r => r.id), [s2.replay.id, s.replay.id]);
  assert.equal((await rpc(db, "obv_replay_delete", { p_actor: RPA, p_id: s2.replay.id })).ok, true);
  assert.equal(code(await rpcErr(db, "obv_replay_get", { p_actor: RPA, p_id: s2.replay.id })), "not_found");
  assert.equal(code(await rpcErr(db, "obv_replay_delete", { p_actor: RPA, p_id: s2.replay.id })), "not_found");
  assert.equal((await rpc(db, "obv_replay_list", { p_actor: RPA })).replays.length, 1);
});

test("replays: the same file again returns the one that is there (existed), the deletion date does not move", async () => {
  const b = rpFile(10), a = await rpSave(RPB, b);
  const sooner = new Date(Date.parse(a.replay.expires_at) - 10 * 864e5).toISOString();
  await db.query("update obv.replays set expires_at = $2 where id = $1", [a.replay.id, sooner]);
  const again = await rpSave(RPB, b, { mode: 0, player: "other" });
  assert.equal(again.existed, true); assert.equal(again.replay.id, a.replay.id);
  assert.equal(Date.parse(again.replay.expires_at), new Date((await rpRows(RPB))[0].expires_at).getTime(), "no new date");
  assert.ok(Date.parse(again.replay.expires_at) < Date.parse(a.replay.expires_at) - 9 * 864e5, "not extended");
  assert.equal((await rpRows(RPB)).length, 1);
  assert.equal((await rpSave(RPC, b)).existed, false, "another person can keep the same file");
});

test("replays: bad input is refused (size, base64, hash, game mode, score info)", async () => {
  const b = rpFile(20), ok = rpArgs(RPA, b), bad = (over, why) => rpcErr(db, "obv_replay_save", { ...ok, ...over }).then(e => assert.equal(code(e), why, JSON.stringify(Object.keys(over))));
  await bad({ p_size: 1048577 }, "too_large");
  await bad({ p_size: 0 }, "bad_request"); await bad({ p_size: null }, "bad_request");
  await bad({ p_sha256: "ABC" }, "bad_request"); await bad({ p_sha256: sha256(b).toUpperCase() }, "bad_request"); await bad({ p_sha256: null }, "bad_request");
  await bad({ p_sha256: sha256("other") }, "bad_request"); // (the hash isn't the file's)
  await bad({ p_data: null }, "bad_request"); await bad({ p_data: "" }, "bad_request"); await bad({ p_data: "not base64!" + b.toString("base64").slice(11) }, "bad_request");
  await bad({ p_data: b.toString("base64") + "AAAA" }, "bad_request"); // (longer than the size says)
  await bad({ p_size: b.length - 1 }, "bad_request");
  await bad({ p_data: "\n" + b.toString("base64").slice(1) }, "bad_request");
  const m4 = rpFile(21, { mode: 4 }); assert.equal(code(await rpcErr(db, "obv_replay_save", rpArgs(RPA, m4))), "bad_request", "the first byte is the game mode: 0..3");
  for (const meta of [null, [], '"x"', 5]) assert.equal(code(await rpcErr(db, "obv_replay_save", { ...ok, p_meta: meta })), "bad_request", JSON.stringify(meta));
  assert.equal(code(await rpcErr(db, "obv_replay_save", { ...ok, p_meta: { player: "x".repeat(7000) } })), "bad_request", "score info too big");
  for (const mode of [0, 1, 2, 3]) assert.equal((await rpSave(RPA, rpFile(30 + mode, { mode }))).existed, false, "mode " + mode);
  const one = Buffer.from([2]); assert.equal((await rpSave(RPA, one)).replay.size, 1, "one byte is the smallest");
  const max = rpFile(40, { n: 1048576 }); assert.equal((await rpSave(RPA, max)).replay.size, 1048576, "exactly 1 MiB is fine");
  assert.deepEqual(Buffer.from((await rpc(db, "obv_replay_get", { p_actor: RPA, p_id: (await rpRows(RPA)).find(r => r.size === 1048576).id })).data, "base64"), max);
  assert.equal(code(await rpcErr(db, "obv_replay_save", rpArgs(RPA, rpFile(41, { n: 1048577 })))), "too_large", "one byte more is not");
  assert.equal(code(await rpcErr(db, "obv_replay_save", rpArgs(999999, rpFile(42)))), "no_user");
});

test("replays: per-user limit, global budget, paused saving; a duplicate or an expired row doesn't count", async () => {
  const U = 1411; await login(U);
  await setSetting("replays_per_user", 3);
  try {
    const kept = [];
    for (let i = 0; i < 3; i++) kept.push(await rpSave(U, rpFile(100 + i)));
    const e = await rpcErr(db, "obv_replay_save", rpArgs(U, rpFile(103))); assert.equal(code(e), "replay_limit"); assert.equal(detailOf(e).limit, 3);
    assert.equal((await rpSave(U, rpFile(100))).existed, true, "the same file at the limit is not an error");
    await expire(kept[0].replay.id);
    assert.equal((await rpSave(U, rpFile(103))).existed, false, "an expired one no longer counts");
    assert.equal(code(await rpcErr(db, "obv_replay_save", rpArgs(U, rpFile(104)))), "replay_limit");
    await rpc(db, "obv_replay_delete", { p_actor: U, p_id: kept[1].replay.id });
    assert.equal((await rpSave(U, rpFile(104))).existed, false, "deleting makes room");
    assert.equal((await rpSave(RPB, rpFile(105))).existed, false, "the limit is per person");
  } finally { await setSetting("replays_per_user", null); }
  // the budget (all replays together)
  const used = (await rpc(db, "obv_replay_list", { p_actor: U })).limits.used_bytes;
  await setSetting("replay_budget_bytes", used + 100);
  try {
    assert.equal((await rpSave(U, rpFile(110, { n: 100 }))).existed, false, "exactly to the budget is fine");
    const e = await rpcErr(db, "obv_replay_save", rpArgs(U, rpFile(111, { n: 5 }))); assert.equal(code(e), "storage_full");
    assert.equal((await rpSave(U, rpFile(110, { n: 100 }))).existed, true, "a file that is already kept is still answered");
    assert.equal((await rpc(db, "obv_replay_list", { p_actor: U })).limits.budget_bytes, used + 100);
  } finally { await setSetting("replay_budget_bytes", null); }
  assert.equal((await rpSave(U, rpFile(111, { n: 5 }))).existed, false);
  // paused saving (the move to D1) stops new replays, not reading or the ones already there
  await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { saving_enabled: false } });
  try {
    assert.equal(code(await rpcErr(db, "obv_replay_save", rpArgs(U, rpFile(120)))), "saving_disabled");
    assert.equal((await rpSave(U, rpFile(111, { n: 5 }))).existed, true);
    assert.ok((await rpc(db, "obv_replay_list", { p_actor: U })).replays.length > 0);
  } finally { await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { saving_enabled: true } }); }
});

test("replays: nobody else can read or delete them (not_found, as if it didn't exist); suspended accounts can't use them", async () => {
  const U = 1412, V = 1413; await login(U); await login(V);
  const s = await rpSave(U, rpFile(200));
  for (const fn of ["obv_replay_get", "obv_replay_delete"]) {
    const other = await rpcErr(db, fn, { p_actor: V, p_id: s.replay.id }), missing = await rpcErr(db, fn, { p_actor: V, p_id: "00000000-0000-4000-8000-000000000000" });
    assert.equal(code(other), "not_found", fn); assert.equal(code(missing), "not_found"); assert.equal(other.message, missing.message, "same answer: no sign that it exists");
  }
  assert.equal((await rpc(db, "obv_replay_list", { p_actor: V })).replays.length, 0);
  assert.equal((await rpRows(U)).length, 1, "still there");
  await db.query("update obv.users set status = 'suspended' where osu_id = $1", [V]);
  try { for (const [fn, a] of [["obv_replay_list", {}], ["obv_replay_get", { p_id: s.replay.id }], ["obv_replay_save", rpArgs(V, rpFile(201))]]) assert.equal(code(await rpcErr(db, fn, { p_actor: V, ...a })), "suspended", fn); }
  finally { await db.query("update obv.users set status = 'active' where osu_id = $1", [V]); }
});

test("replays: after 60 days they are gone at once (list, open), saving the file again is a new save, and the cleanup removes the rows", async () => {
  const U = 1414; await login(U);
  await rpc(db, "obv_replays_gc", { p_limit: 5000 }); // (rows that expired in the tests above)
  const a = await rpSave(U, rpFile(300)), b = await rpSave(U, rpFile(301));
  await expire(a.replay.id);
  assert.deepEqual((await rpc(db, "obv_replay_list", { p_actor: U })).replays.map(r => r.id), [b.replay.id], "expired: not listed");
  assert.equal(code(await rpcErr(db, "obv_replay_get", { p_actor: U, p_id: a.replay.id })), "not_found");
  assert.equal((await rpc(db, "obv_replays_gc", { p_limit: 0 })).deleted, 0, "limit 0 removes nothing");
  assert.equal((await rpRows(U)).length, 2);
  const again = await rpSave(U, rpFile(300)); assert.equal(again.existed, false, "an expired copy is not 'existed'"); assert.notEqual(again.replay.id, a.replay.id);
  assert.ok(Date.parse(again.replay.expires_at) > Date.now() + 59 * 864e5, "a new 60 days");
  await expire(again.replay.id); await expire(b.replay.id);
  const c = await rpSave(U, rpFile(302)); // (one that stays)
  assert.equal((await rpc(db, "obv_replays_gc", { p_limit: 1 })).deleted, 1, "p_limit rows at a time");
  const g = await rpc(db, "obv_replays_gc", {}); assert.equal(g.deleted, 1, "the default limit; the rest");
  assert.deepEqual((await rpRows(U)).map(r => r.id), [c.replay.id], "only the one that is still kept is left");
  assert.equal((await rpc(db, "obv_replays_gc", {})).deleted, 0);
});

test("replays: settings and the feature switch are in the list; switching it off shows in obv_site_features", async () => {
  const set = (await rpc(db, "obv_admin_settings", {})).settings, get = k => set.find(s => s.key === k);
  assert.deepEqual([get("replay_budget_bytes").min, get("replay_budget_bytes").max, get("replay_budget_bytes").default, get("replay_budget_bytes").value], [1000000, 1000000000, 100000000, 100000000]);
  assert.deepEqual([get("replays_per_user").min, get("replays_per_user").max, get("replays_per_user").default], [1, 200, 20]);
  assert.equal(get("feat_replays").value, true); assert.equal(get("feat_replays").kind, "bool");
  assert.equal(code(await rpcErr(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { replays_per_user: 0 } })), "bad_request");
  assert.equal(code(await rpcErr(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { replays_per_user: 201 } })), "bad_request");
  assert.equal(code(await rpcErr(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { replay_budget_bytes: 999999 } })), "bad_request");
  assert.equal(code(await rpcErr(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { replays_per_user: "5" } })), "bad_request");
  await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { replays_per_user: 7 } });
  assert.equal((await rpc(db, "obv_replay_list", { p_actor: RPA })).limits.per_user, 7, "the setting is what the list reports");
  await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { replays_per_user: 20 } });
  assert.ok(!(await rpc(db, "obv_site_features", {})).includes("replays"));
  await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { feat_replays: false } });
  try { assert.ok((await rpc(db, "obv_site_features", {})).includes("replays")); }
  finally { await rpc(db, "obv_admin_settings_set", { p_actor: OWNER, p_values: { feat_replays: true } }); }
  assert.ok(!(await rpc(db, "obv_site_features", {})).includes("replays"));
});

test("replays: Delete account removes them at once (even while its projects are still being deleted); deleting the user row cascades; the export lists them without the file", async () => {
  const U = 1415, V = 1416; await login(U); await login(V);
  await create(U); // (an own project: the account row stays until its files are gone)
  const s = await rpSave(U, rpFile(400), { mode: 0, player: "me", title: "Song" }); await rpSave(U, rpFile(401));
  await expire((await rpSave(U, rpFile(402))).replay.id);
  const ex = await rpc(db, "obv_account_export", { p_user: U });
  assert.equal(ex.replays.length, 2, "the ones still kept"); assert.deepEqual(Object.keys(ex.replays[0]).sort(), ["created_at", "expires_at", "id", "meta", "shared", "size"]);
  assert.ok(ex.replays.every(r => r.shared === false));
  assert.deepEqual(ex.replays.find(r => r.id === s.replay.id).meta, { mode: 0, player: "me", title: "Song" });
  assert.ok(!JSON.stringify(ex).includes(rpFile(400).toString("base64").slice(0, 30)), "no file bytes in the export");
  assert.equal((await rpc(db, "obv_account_export", { p_user: V })).replays.length, 0);
  await rpSave(V, rpFile(400));
  await rpc(db, "obv_account_delete", { p_user: U, p_owner_id: OWNER });
  assert.equal((await db.query("select count(*) n from obv.users where osu_id = $1", [U])).rows[0].n, 1, "the account row is still there (its project is being deleted)");
  assert.equal((await rpRows(U)).length, 0, "but the replays are gone");
  assert.equal((await rpRows(V)).length, 1, "nobody else's");
  // without a project the row goes with the account: the foreign key does the rest
  const W = 1417; await login(W); await rpSave(W, rpFile(410));
  await db.query("delete from obv.users where osu_id = $1", [W]);
  assert.equal((await rpRows(W)).length, 0, "cascade");
});

test("replays: a Google-only account moving into an osu! account takes its replays along (a duplicate file is dropped)", async () => {
  const T = 1418; await login(T);
  const g = (await rpc(db, "obv_google_account", { p_sub: "replay-merge-1" })).id, gf = rpFile(500), shared = rpFile(501);
  await db.query("update obv.users set access = 'approved' where osu_id = $1", [g]);
  await rpSave(g, gf); const gs = await rpSave(g, shared); await rpSave(T, shared);
  const before = await rpSave(T, rpFile(502));
  const moved = await rpc(db, "obv_google_merge", { p_from: g, p_to: T, p_username: "u", p_avatar: null, p_country: null });
  assert.equal(moved.merged, true);
  const rows = await rpRows(T); assert.equal(rows.length, 3, "own two + the one that was only on the Google account");
  assert.deepEqual(rows.map(r => r.sha256).sort(), [sha256(gf), sha256(shared), sha256(rpFile(502))].sort());
  assert.equal((await rpRows(g)).length, 0);
  assert.equal(code(await rpcErr(db, "obv_replay_get", { p_actor: T, p_id: gs.replay.id })), "not_found", "the duplicate's id is gone; the kept copy is the osu! account's own");
  const moved2 = (await rpc(db, "obv_replay_list", { p_actor: T })).replays.find(r => r.sha256 === sha256(gf));
  assert.deepEqual(Buffer.from((await rpc(db, "obv_replay_get", { p_actor: T, p_id: moved2.id })).data, "base64"), gf, "the moved file opens");
  assert.ok(before.replay.id);
});

test("replays: the table is behind the server only (Postgres: no browser role reaches it or the functions)", { skip: process.env.OBV_D1 ? "D1 has no database roles: only the Worker reaches it" : false }, async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(asRole(db, role, "select * from obv.replays"), /permission denied/);
    for (const [fn, a] of [["obv_replay_list", { p_actor: RPA }], ["obv_replay_get", { p_actor: RPA, p_id: "00000000-0000-4000-8000-000000000000" }], ["obv_replay_save", rpArgs(RPA, rpFile(600))], ["obv_replay_delete", { p_actor: RPA, p_id: "00000000-0000-4000-8000-000000000000" }], ["obv_replays_gc", {}]])
      await assert.rejects(rpc(db, fn, a, role), /permission denied/, fn);
  }
  assert.equal((await db.query("select relrowsecurity from pg_class where oid = 'obv.replays'::regclass")).rows[0].relrowsecurity, true, "row level security is on");
  const ex = await rpc(db, "obv_export_all", {});
  assert.ok(Array.isArray(ex.replays) && ex.replays.length > 0 && ex.replays.every(r => typeof r.data_b64 === "string" && r.owner_id && r.sha256), "the copy to D1 gets the replays");
});

test("replays (D1): before 0005_replays.sql is applied, Delete account, the Google merge and Download my data still work", { skip: !process.env.OBV_D1 && "D1 only: Postgres has these changes in the SQL, which keeps the old definitions until it is run" }, async () => {
  const U = 1421, T = 1422; await login(U); await login(T); await create(U);
  const g = (await rpc(db, "obv_google_account", { p_sub: "replay-nomig" })).id;
  db.d1.raw.exec("alter table replays rename to replays_off");
  try {
    assert.deepEqual((await rpc(db, "obv_account_export", { p_user: U })).replays, []);
    assert.equal((await rpc(db, "obv_google_merge", { p_from: g, p_to: T, p_username: "u", p_avatar: null, p_country: null })).merged, true);
    assert.equal((await rpc(db, "obv_account_delete", { p_user: U, p_owner_id: OWNER })).projects.length, 1);
    const viaDb = await require_db().rpc("obv_replay_list", { p_actor: T }).catch(e => e); // (as the routes call it)
    assert.equal(viaDb.code, "db_error"); assert.equal(viaDb.missing, true, "a missing table counts as 'not set up' like a missing function");
  } finally { db.d1.raw.exec("alter table replays_off rename to replays"); }
});

// ---------- sharing a saved replay by link (20261011150000_obv_replay_share.sql / d1/migrations/0006_replay_share.sql / api/_lib/d1-replays.js) ----------
const KEY_RE = /^[A-Za-z0-9_-]{32}$/, NONE_ID = "00000000-0000-4000-8000-000000000000";
const share = (actor, id, mode) => rpc(db, "obv_replay_share", { p_actor: actor, p_id: id, p_mode: mode });
const opened = (actor, id, key) => rpc(db, "obv_replay_shared", { p_actor: actor, p_id: id, p_key: key });
const card = (id, key) => rpc(db, "obv_replay_card", { p_id: id, p_key: key });
test("replay links: the owner turns a link on (the same key again), resets it (a new key) and off; only the owner sees the key", async () => {
  const U = 1431, V = 1432; await login(U); await login(V);
  const s = await rpSave(U, rpFile(700));
  const on = await share(U, s.replay.id, "on");
  assert.deepEqual(Object.keys(on).sort(), ["expires_at", "id", "share_key"]); assert.match(on.share_key, KEY_RE); assert.equal(on.id, s.replay.id);
  assert.equal(Date.parse(on.expires_at), Date.parse(s.replay.expires_at), "the link ends with the replay");
  assert.equal((await share(U, s.replay.id, "on")).share_key, on.share_key, "on again keeps the key");
  assert.equal((await rpc(db, "obv_replay_list", { p_actor: U })).replays[0].share_key, on.share_key, "the owner's list has the key");
  assert.equal((await rpc(db, "obv_replay_get", { p_actor: U, p_id: s.replay.id })).replay.share_key, on.share_key);
  assert.equal((await rpSave(U, rpFile(700))).replay.share_key, on.share_key, "saving the same file again answers the replay with its key");
  const re = await share(U, s.replay.id, "reset"); assert.match(re.share_key, KEY_RE); assert.notEqual(re.share_key, on.share_key, "reset: a new key");
  const off = await share(U, s.replay.id, "off"); assert.equal(off.share_key, null);
  assert.equal((await rpc(db, "obv_replay_list", { p_actor: U })).replays[0].share_key, null);
  assert.equal((await rpRows(U))[0].share_key, null);
  // someone else, an unknown id, a bad mode, an expired replay
  for (const mode of ["on", "reset", "off"]) assert.equal(code(await rpcErr(db, "obv_replay_share", { p_actor: V, p_id: s.replay.id, p_mode: mode })), "not_found", "not the owner: " + mode);
  assert.equal((await rpRows(U))[0].share_key, null, "nothing changed");
  assert.equal(code(await rpcErr(db, "obv_replay_share", { p_actor: U, p_id: NONE_ID, p_mode: "on" })), "not_found");
  for (const mode of ["", "ON", "of", null]) assert.equal(code(await rpcErr(db, "obv_replay_share", { p_actor: U, p_id: s.replay.id, p_mode: mode })), "bad_request", String(mode));
  const old = await rpSave(U, rpFile(701)); await expire(old.replay.id);
  assert.equal(code(await rpcErr(db, "obv_replay_share", { p_actor: U, p_id: old.replay.id, p_mode: "on" })), "not_found", "expired: can't be shared");
  assert.equal(code(await rpcErr(db, "obv_replay_share", { p_actor: 999998, p_id: s.replay.id, p_mode: "on" })), "no_user");
  // only a key of the right format can be stored (the database checks it too)
  await assert.rejects(db.query("update obv.replays set share_key = $2 where id = $1", [s.replay.id, "short"]));
  await assert.rejects(db.query("update obv.replays set share_key = $2 where id = $1", [s.replay.id, "A".repeat(31) + "!"]));
});

test("replay links: a member with the key gets the same bytes and the score info, never the owner; every other case is the same not_found", async () => {
  const U = 1433, V = 1434; await login(U, "SecretOwner"); await login(V);
  const real = readFileSync(new URL("./fixtures/stable-small.osr", import.meta.url));
  const s = await rpSave(U, real, { mode: 0, player: "Tester", title: "Song", artist: "Artist", version: "Insane", score: 5 });
  const key = (await share(U, s.replay.id, "on")).share_key;
  const g = await opened(V, s.replay.id, key);
  assert.deepEqual(Object.keys(g).sort(), ["data", "replay"]); assert.deepEqual(Object.keys(g.replay).sort(), ["created_at", "expires_at", "id", "meta", "size"]);
  assert.deepEqual(Buffer.from(g.data, "base64"), real, "the same bytes"); assert.equal(g.replay.id, s.replay.id); assert.equal(g.replay.size, real.length);
  assert.deepEqual(g.replay.meta, { mode: 0, player: "Tester", title: "Song", artist: "Artist", version: "Insane", score: 5 });
  const txt = JSON.stringify(g);
  assert.ok(!txt.includes(key) && !txt.includes("owner") && !txt.includes("SecretOwner") && !txt.includes(String(U)) && !txt.includes(s.replay.sha256), "no key, owner or account data");
  assert.deepEqual(Buffer.from((await opened(U, s.replay.id, key)).data, "base64"), real, "the owner can open their own link");
  // the preview card: the map only
  assert.deepEqual(await card(s.replay.id, key), { title: "Song", artist: "Artist", version: "Insane" });
  const notFound = async (why, id, k) => {
    const e = await rpcErr(db, "obv_replay_shared", { p_actor: V, p_id: id, p_key: k }), c = await rpcErr(db, "obv_replay_card", { p_id: id, p_key: k });
    assert.equal(code(e), "not_found", why); assert.equal(code(c), "not_found", "card: " + why);
    return e.message + "|" + String(e.detail || "") + "|" + c.message + "|" + String(c.detail || "");
  };
  const answers = new Set();
  answers.add(await notFound("a wrong key", s.replay.id, "B".repeat(32)));
  answers.add(await notFound("a malformed key", s.replay.id, "short"));
  answers.add(await notFound("a key with a bad character", s.replay.id, key.slice(0, 31) + "!"));
  answers.add(await notFound("no key", s.replay.id, null));
  answers.add(await notFound("an unknown id", NONE_ID, key));
  const other = await rpSave(U, rpFile(710)); const otherKey = (await share(U, other.replay.id, "on")).share_key;
  answers.add(await notFound("another replay's key", s.replay.id, otherKey));
  const reset = (await share(U, s.replay.id, "reset")).share_key;
  answers.add(await notFound("the old key after a reset", s.replay.id, key));
  assert.equal((await opened(V, s.replay.id, reset)).replay.id, s.replay.id, "the new key works");
  await share(U, s.replay.id, "off");
  answers.add(await notFound("a revoked key", s.replay.id, reset));
  assert.equal(code(await rpcErr(db, "obv_replay_shared", { p_actor: V, p_id: s.replay.id, p_key: null })), "not_found");
  // expired (at once, before the cleanup), deleted
  const ek = (await share(U, other.replay.id, "on")).share_key; assert.equal(ek, otherKey);
  await expire(other.replay.id); answers.add(await notFound("an expired replay", other.replay.id, otherKey));
  const d = await rpSave(U, rpFile(711)), dk = (await share(U, d.replay.id, "on")).share_key;
  await rpc(db, "obv_replay_delete", { p_actor: U, p_id: d.replay.id }); answers.add(await notFound("a deleted replay", d.replay.id, dk));
  assert.equal(answers.size, 1, "the same answer every time: " + [...answers].join(" / "));
  // a suspended owner's links stop; a suspended (or unknown) viewer can't open any
  const live = await rpSave(U, rpFile(712)), lk = (await share(U, live.replay.id, "on")).share_key;
  await db.query("update obv.users set status = 'suspended' where osu_id = $1", [U]);
  try { assert.equal(await notFound("a suspended owner", live.replay.id, lk), [...answers][0]); }
  finally { await db.query("update obv.users set status = 'active' where osu_id = $1", [U]); }
  assert.equal((await opened(V, live.replay.id, lk)).replay.id, live.replay.id);
  await db.query("update obv.users set status = 'suspended' where osu_id = $1", [V]);
  try { assert.equal(code(await rpcErr(db, "obv_replay_shared", { p_actor: V, p_id: live.replay.id, p_key: lk })), "suspended"); }
  finally { await db.query("update obv.users set status = 'active' where osu_id = $1", [V]); }
  assert.equal(code(await rpcErr(db, "obv_replay_shared", { p_actor: 999997, p_id: live.replay.id, p_key: lk })), "no_user");
  // the card never has the player or the score, and only text
  const odd = await rpSave(U, rpFile(713), { mode: 0, player: "Tester", score: 99, title: 5, artist: "A".repeat(300) }), ok2 = (await share(U, odd.replay.id, "on")).share_key;
  assert.deepEqual(await card(odd.replay.id, ok2), { title: null, artist: "A".repeat(300), version: null });
  // Download my data says which are shared (not the key); Delete account ends every link
  const ex = await rpc(db, "obv_account_export", { p_user: U });
  assert.deepEqual(ex.replays.filter(r => r.shared).map(r => r.id).sort(), [live.replay.id, odd.replay.id].sort());
  assert.ok(!JSON.stringify(ex.replays).includes(lk), "no key in the export");
  await rpc(db, "obv_account_delete", { p_user: U, p_owner_id: OWNER });
  assert.equal(code(await rpcErr(db, "obv_replay_shared", { p_actor: V, p_id: live.replay.id, p_key: lk })), "not_found", "the account is gone: so is the link");
});

test("replay links: the cleanup ends them; a Google-only account's shared replay keeps its link when it moves", async () => {
  const U = 1435, V = 1436, T = 1437; await login(U); await login(V); await login(T);
  const s = await rpSave(U, rpFile(720)), k = (await share(U, s.replay.id, "on")).share_key;
  await expire(s.replay.id); await rpc(db, "obv_replays_gc", { p_limit: 5000 });
  assert.equal((await rpRows(U)).length, 0); assert.equal(code(await rpcErr(db, "obv_replay_shared", { p_actor: V, p_id: s.replay.id, p_key: k })), "not_found");
  const g = (await rpc(db, "obv_google_account", { p_sub: "replay-share-merge" })).id;
  await db.query("update obv.users set access = 'approved' where osu_id = $1", [g]);
  const gs = await rpSave(g, rpFile(721)), gk = (await share(g, gs.replay.id, "on")).share_key;
  assert.equal((await rpc(db, "obv_google_merge", { p_from: g, p_to: T, p_username: "t", p_avatar: null, p_country: null })).merged, true);
  assert.equal((await opened(V, gs.replay.id, gk)).replay.id, gs.replay.id, "the link still opens the moved replay");
  assert.equal((await rpc(db, "obv_replay_list", { p_actor: T })).replays.find(r => r.id === gs.replay.id).share_key, gk, "its new owner sees the key");
  assert.equal((await share(T, gs.replay.id, "off")).share_key, null, "and can stop it");
});

test("replay links: the browser roles can't call the new functions (Postgres)", { skip: process.env.OBV_D1 ? "D1 has no database roles: only the Worker reaches it" : false }, async () => {
  for (const role of ["anon", "authenticated"])
    for (const [fn, a] of [["obv_replay_share", { p_actor: RPA, p_id: NONE_ID, p_mode: "on" }], ["obv_replay_shared", { p_actor: RPA, p_id: NONE_ID, p_key: "A".repeat(32) }], ["obv_replay_card", { p_id: NONE_ID, p_key: "A".repeat(32) }]])
      await assert.rejects(rpc(db, fn, a, role), /permission denied/, role + " " + fn);
  const U = 1439; await login(U); const s = await rpSave(U, rpFile(740)), k = (await share(U, s.replay.id, "on")).share_key;
  const ex = await rpc(db, "obv_export_all", {});
  assert.equal(ex.replays.find(r => r.id === s.replay.id).share_key, k, "the copy to D1 gets the share keys");
});

test("replay links (D1): before 0006_replay_share.sql is applied, the rest of the replays works and sharing counts as 'not set up'", { skip: !process.env.OBV_D1 && "D1 only" }, async () => {
  const U = 1438; await login(U);
  const s = await rpSave(U, rpFile(730));
  db.d1.raw.exec("drop index replays_share_key_idx"); db.d1.raw.exec("alter table replays drop column share_key");
  try {
    assert.equal((await rpc(db, "obv_replay_list", { p_actor: U })).replays[0].share_key, null);
    assert.equal((await rpSave(U, rpFile(731))).existed, false);
    assert.equal((await rpc(db, "obv_replay_get", { p_actor: U, p_id: s.replay.id })).replay.share_key, null);
    assert.ok((await rpc(db, "obv_account_export", { p_user: U })).replays.every(r => r.shared === false));
    const viaDb = require_db();
    for (const [fn, a] of [["obv_replay_share", { p_actor: U, p_id: s.replay.id, p_mode: "on" }], ["obv_replay_shared", { p_actor: U, p_id: s.replay.id, p_key: "A".repeat(32) }], ["obv_replay_card", { p_id: s.replay.id, p_key: "A".repeat(32) }]]) {
      const e = await viaDb.rpc(fn, a).catch(x => x); assert.equal(e.code, "db_error", fn + " " + e.code + " " + e.message); assert.equal(e.missing, true, fn);
    }
  } finally {
    db.d1.raw.exec(readFileSync(new URL("../d1/migrations/0006_replay_share.sql", import.meta.url), "utf8"));
  }
  assert.equal((await share(U, s.replay.id, "on")).share_key.length, 32, "and back");
});
