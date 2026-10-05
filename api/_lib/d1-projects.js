// D1 versions of the database functions (2/3): online projects, saving, sharing, annotations, cleanup, R2 counts, invites,
// error reports and the public changelog. See d1.js.
const crypto = require("crypto");
const D = require("./d1");
const { F, J, err, uuid, left, trim, isObj, has, jtype, toInt, toBool, validPath, DAY, HOUR } = D;

// ---------- projects ----------
F.obv_projects_list = async (q, { p_actor }) => {
  await D.activeUser(q, p_actor);
  const rows = await q.all(`select p.*, m.role mrole, (select count(*) from members mm where mm.project_id = p.id) nmem from projects p
    left join members m on m.project_id = p.id and m.user_id = ? where (p.owner_id = ? or m.user_id is not null) and p.status = 'active' and p.expires_at > ? order by p.updated_at desc`, p_actor, p_actor, q.now);
  const out = [];
  for (const r of rows) out.push({ ...await D.projectJson(q, D.P(r), r.owner_id === p_actor ? "owner" : r.mrole), members: r.nmem });
  return out;
};
F.obv_project_create = async (q, { p_actor, p_client_key, p_title, p_artist, p_creator, p_set_id }) => {
  await D.activeUser(q, p_actor);
  if (p_client_key == null || !/^[A-Za-z0-9_-]{8,64}$/.test(String(p_client_key))) err("bad_request", { field: "client_key" });
  const find = async () => D.P(await q.one("select * from projects where owner_id = ? and client_key = ?", p_actor, p_client_key));
  let p = await find();
  if (p) {
    if (p.status !== "active" || p.expires_at <= q.now) err("expired", { expires_at: p.expires_at });
    return { ...await D.projectJson(q, p, "owner"), existing: true };
  }
  if (!await D.savingOn(q)) err("saving_disabled");
  const lim = (await D.userLimits(q, p_actor)).max_projects;
  const n = await q.val("select count(*) from projects where owner_id = ? and status = 'active' and expires_at > ?", p_actor, q.now);
  if (n >= lim) err("too_many_projects", { limit: lim });
  const days = (await D.userLimits(q, p_actor)).retention_days; // (Postgres: the projects_fix_expiry trigger)
  await q.run(`insert into projects (id, owner_id, client_key, title, artist, creator, source_set_id, created_at, updated_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (owner_id, client_key) do nothing`, crypto.randomUUID(), p_actor, p_client_key, left(p_title || "", 300), left(p_artist || "", 300), left(p_creator || "", 64),
    p_set_id > 0 ? p_set_id : null, q.now, q.now, q.ahead(days * DAY));
  p = await find();
  return { ...await D.projectJson(q, p, "owner"), existing: false };
};
F.obv_project_get = async (q, { p_actor, p_project }) => {
  const pid = uuid(p_project);
  await D.activeUser(q, p_actor);
  const r = await D.access(q, p_actor, pid), p = D.P(await q.one("select * from projects where id = ?", pid));
  return { ...await D.projectJson(q, p, r), manifest: p.manifest, link_key: r === "owner" ? p.link_key : null,
    members: r === "owner" ? await D.membersOf(q, pid) : [], annotations: await D.annotationsOf(q, pid) };
};
F.obv_project_role = async (q, { p_actor, p_project }) => {
  const pid = uuid(p_project);
  await D.activeUser(q, p_actor);
  const r = await D.access(q, p_actor, pid), p = await q.one("select expires_at, revision from projects where id = ?", pid);
  return { role: r, expires_at: p.expires_at, revision: p.revision };
};
F.obv_project_by_link = async (q, { p_project, p_key }) => {
  const pid = uuid(p_project), p = pid && D.P(await q.one("select * from projects where id = ?", pid));
  if (!p || p.link_key == null || p_key == null || p.link_key !== p_key || p.status !== "active") err("not_found");
  if (p.expires_at <= q.now) err("expired", { expires_at: p.expires_at });
  return { ...await D.projectJson(q, p, "link"), manifest: p.manifest, members: [], annotations: await D.annotationsOf(q, pid) };
};
F.obv_project_link = async (q, { p_actor, p_project, p_mode }) => {
  const pid = uuid(p_project);
  await D.activeUser(q, p_actor);
  if (await D.access(q, p_actor, pid) !== "owner") err("forbidden");
  if (!["on", "reset", "off"].includes(p_mode)) err("bad_request", { field: "mode" });
  const cur = await q.one("select link_key, title, expires_at from projects where id = ?", pid);
  const key = p_mode === "off" ? null : p_mode === "reset" ? D.newLinkKey() : (cur.link_key || D.newLinkKey());
  await q.run("update projects set link_key = ? where id = ?", key, pid);
  await D.audit(q, p_actor, "project.link_" + p_mode, "project", pid, { title: cur.title });
  return { id: pid, link_key: key, expires_at: cur.expires_at };
};
F.obv_project_delete = async (q, { p_actor, p_project }) => {
  const pid = uuid(p_project);
  await D.activeUser(q, p_actor);
  if (await D.access(q, p_actor, pid) !== "owner") err("forbidden");
  await q.batch([["update projects set status = 'deleting', delete_reason = 'owner', cleanup_at = ? where id = ?", q.now, pid],
    ["update saves set state = 'expired' where project_id = ? and state = 'open'", pid]]);
  return { id: pid, status: "deleting" };
};
F.obv_member_set = async (q, { p_actor, p_project, p_user, p_username, p_avatar, p_role }) => {
  const pid = uuid(p_project), lim = Number(await D.setOr(q, "max_members_per_project", 20));
  await D.activeUser(q, p_actor);
  if (await D.access(q, p_actor, pid) !== "owner") err("forbidden");
  if (!(p_user > 0) || p_user === p_actor) err("bad_request", { field: "user" });
  if (p_role === "none") await q.run("delete from members where project_id = ? and user_id = ?", pid, p_user);
  else if (p_role === "viewer" || p_role === "editor") {
    const already = await q.one("select 1 from members where project_id = ? and user_id = ?", pid, p_user);
    if (!already && (await q.one("select 1 from users where osu_id = ? and allow_add = 0", p_user) || await q.one("select 1 from account_deletions where osu_id = ?", p_user))) err("forbidden", { reason: "no_add" });
    if (!already && await q.val("select count(*) from members where project_id = ?", pid) >= lim) err("too_many_members", { limit: lim });
    await D.ensureUser(q, p_user, p_username, p_avatar);
    await q.run("insert into members (project_id, user_id, role, added_by, added_at) values (?, ?, ?, ?, ?) on conflict (project_id, user_id) do update set role = excluded.role", pid, p_user, p_role, p_actor, q.now);
  } else err("bad_request", { field: "role" });
  return D.membersOf(q, pid);
};

// ---------- annotations (stored with a save) ----------
async function applyAnnotations(q, actor, role, pid, changes) {
  let done = 0; const conflicts = [], denied = [];
  if (!isObj(changes)) return { applied: 0, conflicts, denied };
  const lim = Number(await D.setOr(q, "max_annotations", 2000));
  for (const a of Array.isArray(changes.delete) ? changes.delete : []) {
    const aid = isObj(a) ? uuid(a.id) : null; if (!aid) continue;
    const cur = await q.one("select author_id, version from annotations where id = ? and project_id = ?", aid, pid); if (!cur) continue;
    if (cur.author_id !== actor && role !== "owner") { denied.push(aid); continue; }
    if (has(a, "base_version") && toInt(a.base_version) !== cur.version) { conflicts.push(aid); continue; }
    await q.run("delete from annotations where id = ?", aid); done++;
  }
  for (const a of Array.isArray(changes.upsert) ? changes.upsert : []) {
    const aid = isObj(a) ? uuid(a.id) : null; if (!aid) continue;
    if (!["comment", "arrow", "highlight"].includes(a.kind || "") || !validPath(a.diff || "") || (has(a, "data") && (!isObj(a.data) || JSON.stringify(a.data).length > 2048))) { denied.push(aid); continue; }
    const cur = await q.one("select project_id, author_id, version, time_ms, object_missing from annotations where id = ?", aid);
    const tms = toInt(a.time_ms == null ? null : String(a.time_ms)), miss = toBool(a.object_missing == null ? null : String(a.object_missing));
    if (!cur) {
      if (await q.val("select count(*) from annotations where project_id = ?", pid) >= lim) { conflicts.push(aid); continue; }
      await q.run(`insert into annotations (id, project_id, author_id, diff, kind, object_id, time_ms, body, data, object_missing, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        aid, pid, actor, a.diff, a.kind, a.object_id == null ? null : left(String(a.object_id), 40), tms == null ? 0 : tms, left(a.body == null ? "" : String(a.body), 2000), isObj(a.data) ? a.data : {}, miss == null ? false : miss, q.now, q.now);
      done++;
    } else if (cur.project_id !== pid) denied.push(aid);
    else if (cur.author_id === actor || role === "owner") {
      if (has(a, "base_version") && toInt(a.base_version) !== cur.version) { conflicts.push(aid); continue; }
      await q.run("update annotations set kind = ?, object_id = ?, time_ms = ?, body = ?, data = ?, object_missing = ?, version = version + 1, updated_at = ? where id = ?",
        a.kind, a.object_id == null ? null : left(String(a.object_id), 40), tms == null ? 0 : tms, left(a.body == null ? "" : String(a.body), 2000), isObj(a.data) ? a.data : {}, miss == null ? false : miss, q.now, aid);
      done++;
    } else { // other editors may only keep the anchor current (the object moved in time / was deleted), not change the text
      const t2 = tms == null ? cur.time_ms : tms, m2 = miss == null ? !!cur.object_missing : miss;
      if (t2 !== cur.time_ms || m2 !== !!cur.object_missing) await q.run("update annotations set time_ms = ?, object_missing = ? where id = ?", t2, m2, aid);
    }
  }
  return { applied: done, conflicts, denied };
}

// ---------- saving: begin (which files to upload) and commit (switch to the new revision) ----------
F.obv_save_begin = async (q, { p_actor, p_project, p_base_revision, p_files }) => {
  const pid = uuid(p_project);
  await D.activeUser(q, p_actor);
  const r = await D.access(q, p_actor, pid);
  if (r !== "owner" && r !== "editor") err("forbidden");
  if (!await D.savingOn(q)) err("saving_disabled");
  const p = D.P(await q.one("select * from projects where id = ?", pid)), lim = await D.limitBytes(q, p.owner_id);
  if (p.revision !== p_base_revision) err("conflict", await D.conflictDetail(q, p));
  if (!Array.isArray(p_files)) err("bad_files");
  const n = p_files.length; if (n < 1 || n > 500) err("bad_files", { count: n });
  let total = 0;
  for (const f of p_files) {
    if (!isObj(f) || !validPath(f.path)) err("bad_files", { path: isObj(f) && f.path != null ? left(String(f.path), 80) : null });
    if (typeof f.size !== "number" || !/^\d{1,10}$/.test(String(f.size))) err("bad_files", { size: f.size === undefined ? null : f.size });
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || "")) err("bad_files", { sha256: f.sha256 == null ? null : left(String(f.sha256), 80) });
    total += f.size;
  }
  if (new Set(p_files.map(f => f.path.toLowerCase())).size !== n) err("bad_files", { reason: "duplicate path" });
  if (total > lim) err("too_large", { size: total, limit: lim });
  const plan = []; let newBytes = 0;
  for (const f of p_files) {
    let k = await q.val("select key from blobs where project_id = ? and state = 'committed' and sha256 = ? and size = ? limit 1", pid, f.sha256, f.size), up = false;
    if (k == null) { const same = plan.find(x => x.sha256 === f.sha256 && x.size === f.size && x.isNew); if (same) k = same.key; else { k = `p/${pid}/${crypto.randomUUID()}`; newBytes += f.size; up = true; } }
    plan.push({ path: f.path, key: k, size: f.size, sha256: f.sha256, isNew: up, upload: up });
  }
  const pend = await q.val("select coalesce(sum(size), 0) from blobs where project_id = ? and state = 'pending'", pid);
  if (pend + newBytes > 2 * lim) err("too_many_pending");
  const used = await q.val("select coalesce(sum(size), 0) from blobs");
  if (used + newBytes > Number(await D.setOr(q, "storage_budget_bytes", 900000000))) err("storage_full");
  const sid = crypto.randomUUID(), manifest = plan.map(x => ({ path: x.path, key: x.key, size: x.size, sha256: x.sha256 })), ups = plan.filter(x => x.upload);
  await q.batch([["insert into saves (id, project_id, user_id, base_revision, manifest, created_at) values (?, ?, ?, ?, ?, ?)", sid, pid, p_actor, p_base_revision, manifest, q.now],
    ...ups.map(e => ["insert into blobs (key, project_id, size, sha256, state, save_id, created_at) values (?, ?, ?, ?, 'pending', ?, ?)", e.key, pid, e.size, e.sha256, sid, q.now])]);
  return { save_id: sid, uploads: ups.map(e => ({ path: e.path, key: e.key, size: e.size })), reused: n - ups.length, size: total, limit: lim };
};
F.obv_save_pending = async (q, { p_actor, p_save }) =>
  q.all("select b.key, b.size from blobs b join saves s on s.id = b.save_id where b.save_id = ? and b.state = 'pending' and s.user_id = ?", uuid(p_save), p_actor);
F.obv_save_commit = async (q, { p_actor, p_save, p_annotations, p_stored }) => {
  const sid = uuid(p_save), sv = sid && await q.one("select * from saves where id = ?", sid);
  if (!sv || sv.user_id !== p_actor) err("not_found");
  if (sv.state === "committed") { const p = await q.one("select * from projects where id = ?", sv.project_id); return { revision: sv.revision, already: true, size_bytes: p.size_bytes, expires_at: p.expires_at, updated_at: p.updated_at }; }
  if (sv.state !== "open" || sv.created_at < q.ago(3 * HOUR)) err("save_expired");
  await D.activeUser(q, p_actor);
  const r = await D.access(q, p_actor, sv.project_id);
  if (r !== "owner" && r !== "editor") err("forbidden");
  let p = D.P(await q.one("select * from projects where id = ?", sv.project_id));
  const lim = await D.limitBytes(q, p.owner_id), manifest = J(sv.manifest);
  if (p.revision !== sv.base_revision) err("conflict", await D.conflictDetail(q, p));
  const stored = isObj(p_stored) ? p_stored : {}; // (D1 runs with R2: the Worker checked the uploads)
  for (const bl of await q.all("select key, size from blobs where save_id = ? and state = 'pending'", sid)) {
    const act = stored[bl.key] == null ? null : Number(stored[bl.key]);
    if (act == null) err("missing_upload", { key: bl.key });
    if (act !== bl.size) err("size_mismatch", { key: bl.key, declared: bl.size, stored: act });
  }
  const keys = manifest.map(m => m.key), rows = keys.length ? await q.all(`select key, size, state, save_id from blobs where project_id = ? and key in (${keys.map(() => "?").join(",")})`, p.id, ...keys) : [];
  const byKey = new Map(rows.map(b => [b.key, b]));
  if (keys.some(k => { const b = byKey.get(k); return !b || !(b.state === "committed" || (b.state === "pending" && b.save_id === sid)); })) err("bad_manifest");
  const total = keys.reduce((s, k) => s + byKey.get(k).size, 0);
  if (total > lim) err("too_large", { size: total, limit: lim });
  // the revision moves only if nobody saved in between (Postgres locked the row; here the update checks it)
  if (!await q.run("update projects set revision = revision + 1, manifest = ?, size_bytes = ?, updated_at = ?, saved_by = ? where id = ? and revision = ?", manifest, total, q.now, p_actor, p.id, sv.base_revision)) {
    p = D.P(await q.one("select * from projects where id = ?", p.id)); err("conflict", await D.conflictDetail(q, p));
  }
  await q.batch([["update blobs set state = 'committed' where save_id = ? and state = 'pending'", sid],
    [`update blobs set state = 'orphaned', orphaned_at = ? where project_id = ? and state = 'committed'${keys.length ? ` and key not in (${keys.map(() => "?").join(",")})` : ""}`, q.now, p.id, ...keys]]);
  p = D.P(await q.one("select * from projects where id = ?", p.id));
  const ann = await applyAnnotations(q, p_actor, r, p.id, p_annotations);
  await q.run("update saves set state = 'committed', committed_at = ?, revision = ? where id = ?", q.now, p.revision, sid);
  return { revision: p.revision, size_bytes: p.size_bytes, expires_at: p.expires_at, updated_at: p.updated_at, annotations: ann, manifest: p.manifest };
};

// ---------- cleanup (cron) and the storage counters ----------
F.obv_cleanup_due = async (q, { p_limit }) => {
  await q.batch([["update projects set status = 'deleting', delete_reason = 'expired', cleanup_at = ? where status = 'active' and expires_at <= ?", q.now, q.now],
    ["update saves set state = 'expired' where state = 'open' and (created_at < ? or project_id in (select id from projects where status = 'deleting'))", q.ago(3 * HOUR)]]);
  const ps = await q.all("select id, cleanup_attempts from projects where status = 'deleting' order by cleanup_attempts, cleanup_at limit ?", Math.max(1, Math.min(p_limit || 1, 200)));
  const out = [];
  for (const p of ps) out.push({ id: p.id, attempts: p.cleanup_attempts, keys: (await q.all("select key from blobs where project_id = ?", p.id)).map(b => b.key) });
  return out;
};
F.obv_cleanup_keys = async (q, { p_project }) => {
  const p = await q.one("select id, status from projects where id = ? and status = 'deleting'", uuid(p_project)); if (!p) return null;
  return { id: p.id, status: p.status, keys: (await q.all("select key from blobs where project_id = ?", p.id)).map(b => b.key) };
};
// p_gone: on a failure, the files that were deleted anyway (their rows go; the rest stay for the next try)
F.obv_cleanup_finish = async (q, { p_project, p_error, p_gone }) => { // (D1 runs with R2: the Worker's deletes are what counts)
  const p = await q.one("select * from projects where id = ?", uuid(p_project));
  if (!p) return { done: true, gone: true };
  if (p.status !== "deleting") err("not_deleting");
  if (p_error == null) await q.run("delete from blobs where project_id = ?", p.id);
  else for (const k of (Array.isArray(p_gone) ? p_gone : []).slice(0, 1000)) await q.run("delete from blobs where project_id = ? and key = ?", p.id, String(k));
  const leftRows = await q.val("select count(*) from blobs where project_id = ?", p.id);
  if (leftRows > 0 || p_error != null) {
    await q.run("update projects set cleanup_attempts = cleanup_attempts + 1, cleanup_at = ?, cleanup_error = ? where id = ?", q.now, left(p_error != null ? p_error : `${leftRows} file(s) still in storage`, 500), p.id);
    return { done: false, remaining: leftRows };
  }
  await q.run("delete from projects where id = ?", p.id);
  await D.audit(q, null, "project.purged", "project", p.id, { reason: p.delete_reason, title: p.title, owner: p.owner_id, size: p.size_bytes });
  return { done: true };
};
F.obv_gc_list = async (q, { p_limit }) => (await q.all(`select key from blobs where (state = 'orphaned' and orphaned_at < ?) or (state = 'pending' and created_at < ?) order by created_at limit ?`,
  q.ago(30 * 60e3), q.ago(3 * HOUR), Math.max(1, Math.min(p_limit || 1, 1000)))).map(b => b.key);
F.obv_gc_finish = async (q, { p_keys }) => {
  const keys = Array.isArray(p_keys) ? p_keys.map(String) : []; if (!keys.length) return { deleted: 0 };
  let n = 0;
  for (let i = 0; i < keys.length; i += 90) { const part = keys.slice(i, i + 90);
    n += await q.run(`delete from blobs where key in (${part.map(() => "?").join(",")}) and (state = 'orphaned' or (state = 'pending' and created_at < ?))`, ...part, q.ago(3 * HOUR)); }
  return { deleted: n };
};
F.obv_job_log = async (q, { p_job, p_ok, p_detail }) => {
  await q.batch([["insert into job_runs (job, started_at, finished_at, ok, detail) values (?, ?, ?, ?, ?)", p_job, q.now, q.now, p_ok == null ? null : !!p_ok, p_detail || {}],
    ["delete from job_runs where id in (select id from job_runs order by id desc limit -1 offset 200)"]]);
  return null;
};
const r2Max = async (q, k, hard) => Math.min(hard, Number(await D.setOr(q, k, D.specDef(k))));
const monthOf = d => d.toISOString().slice(0, 7) + "-01";
F.obv_r2_use = async (q, { p_a, p_b }) => {
  const m = monthOf(q.at), a = Math.max(p_a || 0, 0), b = Math.max(p_b || 0, 0), ma = await r2Max(q, "r2_class_a_month", 1000000), mb = await r2Max(q, "r2_class_b_month", 10000000);
  await q.run("insert into r2_usage (month) values (?) on conflict (month) do nothing", m);
  // one statement: counted only while under both limits (D1 runs statements one at a time, so two requests can't both slip past)
  const ok = await q.run("update r2_usage set class_a = class_a + ?, class_b = class_b + ? where month = ? and class_a + ? <= ? and class_b + ? <= ?", a, b, m, a, ma, b, mb);
  const u = await q.one("select * from r2_usage where month = ?", m);
  if (!ok) {
    await q.run("update r2_usage set refused_a = refused_a + ?, refused_b = refused_b + ? where month = ?", u.class_a + a > ma ? 1 : 0, u.class_b + b > mb ? 1 : 0, m);
    return { ok: false, a: u.class_a, b: u.class_b, max_a: ma, max_b: mb };
  }
  const old = new Date(Date.UTC(q.at.getUTCFullYear(), q.at.getUTCMonth() - 13, 1)).toISOString().slice(0, 10);
  await q.run("delete from r2_usage where month < ?", old);
  return { ok: true, a: u.class_a, b: u.class_b, max_a: ma, max_b: mb };
};
F.obv_r2_usage = async q => ({ max_a: await r2Max(q, "r2_class_a_month", 1000000), max_b: await r2Max(q, "r2_class_b_month", 10000000),
  months: (await q.all("select * from r2_usage order by month desc limit 12")).map(x => ({ month: x.month, a: x.class_a, b: x.class_b, refused_a: x.refused_a, refused_b: x.refused_b })) });

// ---------- error reports and "Report a problem" ----------
const md5 = s => crypto.createHash("md5").update(s).digest("hex");
F.obv_error_report = async (q, { p_message, p_source, p_stack, p_page, p_version, p_browser }) => {
  if (p_message == null || !String(p_message).length) return null;
  const k = md5(left(p_message, 300) + "|" + (p_source == null ? "" : left(p_source, 300)));
  await q.batch([[`insert into client_errors (sig, message, source, stack, page, version, browser, first_at, last_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (sig) do update set count = min(client_errors.count + 1, 1000000000), last_at = excluded.last_at, resolved_at = null,
      stack = coalesce(excluded.stack, client_errors.stack), page = excluded.page, version = excluded.version, browser = excluded.browser`,
      k, left(p_message, 300), left(p_source, 300), left(p_stack, 2000), left(p_page, 60), left(p_version, 20), left(p_browser, 60), q.now, q.now],
    ["delete from client_errors where kind = 'error' and last_at < ?", q.ago(60 * DAY)],
    ["delete from client_errors where sig in (select sig from client_errors where kind = 'error' order by last_at desc limit -1 offset 300)"]]);
  return null;
};
F.obv_feedback = async (q, { p_message, p_page, p_version, p_browser, p_reporter }) => {
  if (p_message == null || String(p_message).trim().length < 3) err("bad_request", { field: "message" });
  await q.batch([["insert into client_errors (sig, kind, message, page, version, browser, reporter, first_at, last_at) values (?, 'report', ?, ?, ?, ?, ?, ?, ?)",
      md5(crypto.randomUUID() + q.now), left(String(p_message).trim(), 1000), left(p_page, 60), left(p_version, 20), left(p_browser, 60), left(p_reporter, 64), q.now, q.now],
    ["delete from client_errors where kind = 'report' and (last_at < ? or resolved_at < ?)", q.ago(90 * DAY), q.ago(60 * DAY)],
    ["delete from client_errors where sig in (select sig from client_errors where kind = 'report' order by last_at desc limit -1 offset 200)"]]);
  return null;
};

// ---------- the public changelog ----------
F.obv_changelog_public = async q => (await q.all("select * from changelog where status = 'published' order by sort_order desc, published_at desc nulls last, created_at desc"))
  .map(c => ({ id: c.id, title: c.title, version_label: c.version_label, content_md: c.content_md, published_at: c.published_at, updated_at: c.updated_at }));

// ---------- invites (the person's own link, accepting one) ----------
F.obv_invite_info = async (q, { p_code, p_owner_id }) => {
  if (p_code == null || !/^[A-Za-z0-9]{10}$/.test(p_code)) err("not_found");
  const l = await q.one("select * from invite_links where code = ?", p_code);
  if (l) {
    const u = await D.userRow(q, l.created_by), why = await D.linkOk(q, l, p_owner_id);
    return { inviter: { id: u.osu_id, username: u.username, avatar: u.avatar_url }, ok: why == null, reason: why, fx: !!(u.invite_fx && D.fxAllowed(u, p_owner_id)) };
  }
  const u = D.U(await q.one("select * from users where invite_code = ?", p_code)); if (!u) err("not_found");
  const active = u.status === "active" && (u.access === "approved" || u.role === "admin" || u.osu_id === p_owner_id), room = await D.inviteRoom(q, u, p_owner_id), st = await D.inviteState(q, u, p_owner_id);
  return { inviter: { id: u.osu_id, username: u.username, avatar: u.avatar_url }, ok: active && room,
    reason: !active ? "inactive" : !st.can_invite ? "not_allowed" : !room ? "full" : null, fx: !!(u.invite_fx && D.fxAllowed(u, p_owner_id)) };
};
F.obv_invite_mine = async (q, { p_actor, p_owner_id }) => {
  let u = await D.userRow(q, p_actor); if (!u) err("no_user");
  if (u.invite_code == null) { await q.run("update users set invite_code = ? where osu_id = ?", await D.newInviteCode(q), p_actor); u = await D.userRow(q, p_actor); }
  return { code: u.invite_code, fx: !!(u.invite_fx && D.fxAllowed(u, p_owner_id)), fx_allowed: D.fxAllowed(u, p_owner_id), ...await D.inviteState(q, u, p_owner_id),
    invited: (await q.all("select osu_id, username, avatar_url, invited_at, status, access from users where invited_by = ? order by invited_at desc", p_actor))
      .map(x => ({ id: x.osu_id, username: x.username, avatar: x.avatar_url, at: x.invited_at, active: x.status === "active" && x.access === "approved" })) };
};
F.obv_invite_reset = async (q, { p_actor, p_owner_id }) => {
  if (!await q.run("update users set invite_code = ? where osu_id = ?", await D.newInviteCode(q), p_actor)) err("no_user");
  await D.audit(q, p_actor, "invite.reset", "user", p_actor, {});
  return F.obv_invite_mine(q, { p_actor, p_owner_id });
};
F.obv_invite_fx_set = async (q, { p_actor, p_on, p_owner_id }) => {
  if (p_on == null) err("bad_request", { field: "on" });
  const u = await D.userRow(q, p_actor); if (!u) err("no_user");
  if (p_on && !D.fxAllowed(u, p_owner_id)) err("forbidden", { reason: "fx_not_allowed" });
  await q.run("update users set invite_fx = ? where osu_id = ?", !!p_on, p_actor);
  return { fx: !!p_on };
};
F.obv_invite_accept = async (q, { p_id, p_username, p_avatar, p_country, p_code, p_owner_id }) => {
  if (p_code == null || !/^[A-Za-z0-9]{10}$/.test(p_code)) err("not_found");
  await F.obv_user_touch(q, { p_id, p_username, p_avatar, p_country });
  const l = await q.one("select * from invite_links where code = ?", p_code);
  const inv = l ? await D.userRow(q, l.created_by) : D.U(await q.one("select * from users where invite_code = ?", p_code));
  if (!inv) err("not_found");
  const me = await D.userRow(q, p_id);
  if (me.access === "approved" || me.role === "admin" || p_id === p_owner_id) return { access: "approved", already: true };
  if (me.status !== "active") err("suspended");
  if (me.access === "denied") err("forbidden", { reason: "denied" }); // an admin said no: an invite doesn't overrule that
  if (inv.osu_id === p_id) err("bad_request");
  if (l) {
    const why = await D.linkOk(q, l, p_owner_id);
    if (why === "full") err("invite_full"); else if (why != null) err("invite_inactive");
    if (!await q.run("update invite_links set uses = uses + 1 where code = ? and uses < max_uses", l.code)) err("invite_full"); // (the limit holds with two at once)
  } else {
    if (inv.status !== "active" || !(inv.access === "approved" || inv.role === "admin" || inv.osu_id === p_owner_id)) err("invite_inactive");
    if (!(await D.inviteState(q, inv, p_owner_id)).can_invite) err("invite_inactive");
    if (!await D.inviteRoom(q, inv, p_owner_id)) err("invite_full");
  }
  await q.run("update users set access = 'approved', access_decided_at = ?, access_decided_by = ?, invited_by = ?, invited_at = ?, invited_via = ?, can_invite = null where osu_id = ?",
    q.now, inv.osu_id, inv.osu_id, q.now, l ? l.code : null, p_id);
  await D.audit(q, p_id, "access.invite", "user", p_id, { username: me.username, inviter: inv.osu_id, inviter_name: inv.username, link: l ? l.code : null, note: l ? l.note : null });
  return { access: "approved", inviter: { id: inv.osu_id, username: inv.username } };
};

module.exports = { applyAnnotations };
