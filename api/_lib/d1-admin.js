// D1 versions of the database functions (3/3): the admin dashboard (overview, users, projects, settings, access requests,
// invites, errors and reports, audit log, changelog). See d1.js.
const crypto = require("crypto");
const D = require("./d1");
const { F, J, err, uuid, left, trim, isObj, has, jtype, DAY, HOUR } = D;
const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? Math.trunc(+v) : d));
const like = s => "%" + s + "%";
const statusOf = (p, now) => p.status === "active" && p.expires_at <= now ? "expired" : p.status;

// ---------- overview ----------
F.obv_admin_overview = async q => {
  const n = (sql, ...a) => q.val(sql, ...a), s = await q.settings();
  const startDay = new Date(Date.UTC(q.at.getUTCFullYear(), q.at.getUTCMonth(), q.at.getUTCDate() - 13));
  const saves = (await q.all("select committed_at from saves where state = 'committed' and committed_at >= ?", startDay.toISOString())).map(x => x.committed_at.slice(0, 10));
  const days = []; for (let i = 0; i < 14; i++) { const d = new Date(startDay.getTime() + i * DAY).toISOString().slice(0, 10); days.push({ day: d, saves: saves.filter(x => x === d).length }); }
  const blobsBy = st => n("select coalesce(sum(size), 0) from blobs where state = ?", st);
  const last = await q.one("select finished_at, ok, detail from job_runs where job = 'cleanup' order by id desc limit 1");
  return {
    users: await n("select count(*) from users"), suspended: await n("select count(*) from users where status = 'suspended'"), admins: await n("select count(*) from users where role = 'admin'"),
    new_users_7d: await n("select count(*) from users where created_at > ?", q.ago(7 * DAY)), active_users_7d: await n("select count(*) from users where last_seen_at > ?", q.ago(7 * DAY)),
    projects: await n("select count(*) from projects where status = 'active' and expires_at > ?", q.now), expired_waiting: await n("select count(*) from projects where status = 'active' and expires_at <= ?", q.now),
    deleting: await n("select count(*) from projects where status = 'deleting'"), expiring_24h: await n("select count(*) from projects where status = 'active' and expires_at > ? and expires_at <= ?", q.now, q.ahead(DAY)),
    saves_7d: await n("select count(*) from saves where state = 'committed' and committed_at > ?", q.ago(7 * DAY)), saves_by_day: days,
    top_users: (await q.all("select u.osu_id, u.username, sum(p.size_bytes) bytes, count(*) n from projects p join users u on u.osu_id = p.owner_id where p.status = 'active' group by u.osu_id, u.username order by sum(p.size_bytes) desc limit 5"))
      .map(x => ({ id: x.osu_id, username: x.username, bytes: x.bytes, projects: x.n })),
    largest: (await q.all("select p.id, p.title, p.artist, p.size_bytes, u.username, p.expires_at from projects p join users u on u.osu_id = p.owner_id where p.status = 'active' and p.expires_at > ? order by p.size_bytes desc limit 5", q.now))
      .map(x => ({ id: x.id, title: x.title, artist: x.artist, size_bytes: x.size_bytes, owner: x.username, expires_at: x.expires_at })),
    tracked_bytes: { committed: await blobsBy("committed"), pending: await blobsBy("pending"), orphaned: await blobsBy("orphaned") },
    storage: { objects: await n("select count(*) from blobs"), bytes: await n("select coalesce(sum(size), 0) from blobs") }, untracked: { objects: 0, bytes: 0 }, // (the files are on R2: what the projects track)
    budget_bytes: s.storage_budget_bytes == null ? null : Number(s.storage_budget_bytes), limit_bytes: await D.maxProjectBytes(q),
    retention_days: s.retention_days == null ? null : Number(s.retention_days), max_projects: s.max_projects_per_user == null ? null : Number(s.max_projects_per_user),
    saving_enabled: await D.savingOn(q), last_cleanup: last ? { at: last.finished_at, ok: D.B(last.ok), detail: J(last.detail) } : null,
  };
};
F.obv_admin_badges = async q => ({ pending: await q.val("select count(*) from users where access = 'pending'"), errors: await q.val("select count(*) from client_errors where resolved_at is null") });
F.obv_admin_admins = async (q, { p_owner_id }) => (await q.all("select * from users where role = 'admin' or osu_id = ? order by (osu_id = ?) desc, username", p_owner_id, p_owner_id))
  .map(u => ({ id: u.osu_id, username: u.username, avatar: u.avatar_url, status: u.status, last_seen_at: u.last_seen_at, owner: u.osu_id === p_owner_id, role: u.osu_id === p_owner_id ? "owner" : u.role }));

// ---------- users ----------
F.obv_admin_users = async (q, { p_q, p_limit, p_offset, p_status, p_role, p_sort }) => {
  const where = [], a = [q.now];
  if (p_q) { where.push("(u.username like ? or cast(u.osu_id as text) = ?)"); a.push(like(p_q), p_q); }
  if (p_status) { where.push("u.status = ?"); a.push(p_status); }
  if (p_role) { where.push("(u.role = ? or (? = 'custom' and (u.max_projects is not null or u.max_project_bytes is not null or u.retention_days is not null)))"); a.push(p_role, p_role); }
  const f = `select u.*, (select count(*) from projects p where p.owner_id = u.osu_id and p.status = 'active' and p.expires_at > ?) n_projects,
    (select coalesce(sum(p.size_bytes), 0) from projects p where p.owner_id = u.osu_id and p.status = 'active') n_bytes from users u ${where.length ? "where " + where.join(" and ") : ""}`;
  const order = { bytes: "n_bytes desc,", projects: "n_projects desc,", created: "created_at desc,", name: "lower(username) asc," }[p_sort] || "";
  const rows = await q.all(`select * from (${f}) order by ${order} last_seen_at desc nulls last, osu_id limit ? offset ?`, ...a, clamp(p_limit, 1, 100, 30), clamp(p_offset, 0, 1e9, 0));
  const out = [];
  for (const o of rows) out.push({ id: o.osu_id, username: o.username, avatar: o.avatar_url, country: o.country, status: o.status, status_reason: o.status_reason, role: o.role,
    created_at: o.created_at, last_login_at: o.last_login_at, last_seen_at: o.last_seen_at, projects: o.n_projects, bytes: o.n_bytes, limits: await D.userLimits(q, o.osu_id) });
  return { total: await q.val(`select count(*) from (${f})`, ...a), rows: out };
};
F.obv_admin_user_get = async (q, { p_user }) => {
  const u = await D.userRow(q, p_user); if (!u) err("not_found");
  const projects = (await q.all("select p.*, (select count(*) from members m where m.project_id = p.id) nm from projects p where p.owner_id = ? order by p.updated_at desc", u.osu_id))
    .map(p => ({ id: p.id, title: p.title, artist: p.artist, size_bytes: p.size_bytes, revision: p.revision, created_at: p.created_at, updated_at: p.updated_at, expires_at: p.expires_at, status: statusOf(p, q.now), members: p.nm }));
  const shared = (await q.all("select p.id, p.title, m.role, (select username from users o where o.osu_id = p.owner_id) owner from members m join projects p on p.id = m.project_id where m.user_id = ? and p.status = 'active' order by p.updated_at desc", u.osu_id))
    .map(x => ({ id: x.id, title: x.title, role: x.role, owner: x.owner }));
  const id = String(u.osu_id), acts = await q.all(`select a.*, (select username from users x where x.osu_id = a.actor_id) actor_name from audit_log a
    where (a.target_type = 'user' and a.target_id = ?) or a.actor_id = ? or json_extract(a.detail, '$.owner') = ? or cast(json_extract(a.detail, '$.owner') as text) = ? order by a.id desc limit 30`, id, u.osu_id, u.osu_id, id);
  return { id: u.osu_id, username: u.username, avatar: u.avatar_url, country: u.country, status: u.status, status_reason: u.status_reason, role: u.role, note: u.admin_note,
    created_at: u.created_at, last_login_at: u.last_login_at, last_seen_at: u.last_seen_at, limits: await D.userLimits(q, u.osu_id),
    overrides: { max_project_bytes: u.max_project_bytes, retention_days: u.retention_days, max_projects: u.max_projects },
    bytes: await q.val("select coalesce(sum(size_bytes), 0) from projects where owner_id = ? and status = 'active'", u.osu_id), projects, shared_with: shared,
    saves_30d: await q.val("select count(*) from saves where user_id = ? and state = 'committed' and committed_at > ?", u.osu_id, q.ago(30 * DAY)),
    activity: acts.map(a => ({ at: a.at, action: a.action, actor: a.actor_id, actor_name: a.actor_name, target_type: a.target_type, target_id: a.target_id, detail: J(a.detail) })) };
};
F.obv_admin_user_status = async (q, { p_actor, p_user, p_status, p_reason }) => {
  if (!["active", "suspended"].includes(p_status)) err("bad_request", { field: "status" });
  if (p_user === p_actor) err("bad_request", { reason: "cannot change your own account" });
  if (!await q.run("update users set status = ?, status_reason = ? where osu_id = ?", p_status, p_status === "suspended" ? left(p_reason, 300) : null, p_user)) err("not_found");
  await D.audit(q, p_actor, "user." + p_status, "user", p_user, { username: await D.nameOf(q, p_user), reason: left(p_reason, 300) });
  return { id: p_user, status: p_status };
};
F.obv_admin_user_update = async (q, { p_actor, p_actor_is_owner, p_owner_id, p_user, p_patch }) => {
  if (!isObj(p_patch)) err("bad_request");
  const u = await D.userRow(q, p_user); if (!u) err("not_found");
  const pt = p_patch, changed = {};
  if (has(pt, "status") || has(pt, "role")) {
    if (p_user === p_actor) err("forbidden", { reason: "own account" });
    if (p_user === p_owner_id) err("forbidden", { reason: "site owner" });
  }
  if (has(pt, "status")) {
    if (!["active", "suspended"].includes(pt.status)) err("bad_request", { field: "status" });
    if (u.role === "admin" && !p_actor_is_owner) err("forbidden", { reason: "admins are managed by the owner" });
    if (pt.status !== u.status) {
      await q.run("update users set status = ?, status_reason = ? where osu_id = ?", pt.status, pt.status === "suspended" ? left(pt.reason, 300) : null, p_user);
      await D.audit(q, p_actor, "user." + pt.status, "user", p_user, { username: u.username, reason: left(pt.reason, 300) });
    }
  }
  if (has(pt, "role")) {
    if (!p_actor_is_owner) err("forbidden", { reason: "only the site owner manages admins" });
    if (!["user", "admin"].includes(pt.role)) err("bad_request", { field: "role" });
    if (pt.role !== u.role) { await q.run("update users set role = ? where osu_id = ?", pt.role, p_user); await D.audit(q, p_actor, pt.role === "admin" ? "admin.add" : "admin.remove", "user", p_user, { username: u.username }); }
  }
  for (const [k, lo, hi] of [["max_projects", 0, 1000], ["max_project_bytes", 1000000, 2000000000], ["retention_days", 1, 365]]) {
    if (!has(pt, k)) continue;
    const v = pt[k];
    if (v !== null && (typeof v !== "number" || v !== Math.trunc(v) || v < lo || v > hi)) err("bad_request", typeof v === "number" ? { field: k, min: lo, max: hi } : { field: k });
    await q.run(`update users set ${k} = ? where osu_id = ?`, v, p_user);
    changed[k] = v;
  }
  if (has(pt, "note")) await q.run("update users set admin_note = ? where osu_id = ?", left(trim(pt.note == null ? "" : String(pt.note)), 1000) || null, p_user);
  if (Object.keys(changed).length) await D.audit(q, p_actor, "user.limits", "user", p_user, { username: u.username, ...changed });
  else if (has(pt, "note")) await D.audit(q, p_actor, "user.note", "user", p_user, { username: u.username });
  return F.obv_admin_user_get(q, { p_user });
};
F.obv_admin_turn_relay = async (q, { p_actor, p_user, p_on }) => {
  if (p_on == null) err("bad_request", { field: "on" });
  const u = await D.userRow(q, p_user); if (!u) err("not_found");
  if (u.turn_relay !== !!p_on) { await q.run("update users set turn_relay = ? where osu_id = ?", !!p_on, p_user); await D.audit(q, p_actor, p_on ? "turn.relay_on" : "turn.relay_off", "user", p_user, { username: u.username }); }
  return { id: p_user, turn_relay: !!p_on };
};

// ---------- access requests ----------
F.obv_admin_access = async (q, { p_status, p_q, p_limit, p_offset }) => {
  const where = [], a = [];
  if (p_status) { where.push("(access = ? or (? = 'invited' and invited_by is not null))"); a.push(p_status, p_status); }
  if (p_q) { where.push("(username like ? or cast(osu_id as text) = ?)"); a.push(like(p_q), p_q); }
  const w = where.length ? "where " + where.join(" and ") : "", inv = (await D.setOr(q, "invitees_can_invite", false)) === true;
  const rows = await q.all(`select * from users ${w} order by case when access = 'pending' then access_requested_at end asc nulls last,
    coalesce(access_decided_at, access_requested_at, created_at) desc nulls last, osu_id limit ? offset ?`, ...a, clamp(p_limit, 1, 100, 30), clamp(p_offset, 0, 1e9, 0));
  const c = await q.one(`select sum(access = 'pending') pending, sum(access = 'approved') approved, sum(access = 'denied') denied, sum(access = 'none') none, sum(invited_by is not null) invited from users`);
  const out = [];
  for (const r of rows.map(D.U)) {
    const g = await q.one("select verified from user_logins where osu_id = ? and provider = 'google'", r.osu_id);
    out.push({ id: r.osu_id, username: r.username, avatar: r.avatar_url, country: r.country, status: r.status, role: r.role, access: r.access, message: r.access_message,
      requested_at: r.access_requested_at, decided_at: r.access_decided_at, decided_by: await D.nameOf(q, r.access_decided_by), invited_by: await D.nameOf(q, r.invited_by),
      can_invite: r.can_invite != null ? r.can_invite : (r.invited_by == null || inv), custom_can_invite: r.can_invite, google: g ? { verified: !!g.verified } : null,
      created_at: r.created_at, last_seen_at: r.last_seen_at });
  }
  return { total: await q.val(`select count(*) from users ${w}`, ...a), counts: { pending: c.pending || 0, approved: c.approved || 0, denied: c.denied || 0, none: c.none || 0, invited: c.invited || 0 }, rows: out };
};
F.obv_admin_access_set = async (q, { p_actor, p_owner_id, p_user, p_access }) => {
  if (!["approved", "denied", "none"].includes(p_access)) err("bad_request", { field: "access" });
  const u = await D.userRow(q, p_user); if (!u) err("not_found");
  if (p_user === p_owner_id || p_user === p_actor) err("forbidden");
  if (u.access !== p_access) {
    await q.run("update users set access = ?, access_decided_at = ?, access_decided_by = ? where osu_id = ?", p_access, q.now, p_actor, p_user);
    await D.audit(q, p_actor, "access." + p_access, "user", p_user, { username: u.username, from: u.access });
  }
  return { id: p_user, access: p_access };
};
F.obv_admin_user_access = async (q, { p_user }) => {
  const u = await q.one("select * from users where osu_id = ?", p_user); if (!u) return {};
  return { access: u.access, message: u.access_message, requested_at: u.access_requested_at, decided_at: u.access_decided_at, decided_by: await D.nameOf(q, u.access_decided_by) };
};

// ---------- invites ----------
F.obv_admin_user_invites = async (q, { p_user, p_owner_id }) => {
  const u = await D.userRow(q, p_user); if (!u) err("not_found");
  return { ...await D.inviteState(q, u, p_owner_id), has_link: u.invite_code != null, fx_allowed: D.fxAllowed(u, p_owner_id), fx_custom: u.invite_fx_allowed,
    fx: !!(u.invite_fx && D.fxAllowed(u, p_owner_id)), invited_by: await D.userBrief(q, u.invited_by), invited_at: u.invited_at,
    invited: (await q.all("select osu_id, username, invited_at, access from users where invited_by = ? order by invited_at desc", u.osu_id)).map(x => ({ id: x.osu_id, username: x.username, at: x.invited_at, access: x.access })) };
};
F.obv_admin_invites_set = async (q, { p_actor, p_owner_id, p_user, p_patch }) => {
  if (!isObj(p_patch)) err("bad_request");
  const u = await D.userRow(q, p_user); if (!u) err("not_found");
  if (has(p_patch, "can_invite")) {
    const v = p_patch.can_invite; if (v !== null && typeof v !== "boolean") err("bad_request", { field: "can_invite" });
    if (v !== u.can_invite) { await q.run("update users set can_invite = ? where osu_id = ?", v, p_user); await D.audit(q, p_actor, v == null ? "invite.follow" : v ? "invite.allow" : "invite.block", "user", p_user, { username: u.username }); }
  }
  if (has(p_patch, "invite_limit")) {
    const v = p_patch.invite_limit;
    if (v !== null && !(typeof v === "number" && v >= 0 && v <= 1000 && v === Math.trunc(v))) err("bad_request", { field: "invite_limit" });
    if (v !== u.invite_limit) { await q.run("update users set invite_limit = ? where osu_id = ?", v, p_user); await D.audit(q, p_actor, "invite.limit", "user", p_user, { username: u.username, from: u.invite_limit, to: v }); }
  }
  return F.obv_admin_user_invites(q, { p_user, p_owner_id });
};
F.obv_admin_invites_reset_all = async (q, { p_actor }) => {
  const c = await q.one("select sum(invite_limit is not null) l, sum(can_invite is not null) c from users"), lim = c.l || 0, ci = c.c || 0;
  await q.run("update users set invite_limit = null, can_invite = null where invite_limit is not null or can_invite is not null");
  await D.audit(q, p_actor, "invite.reset_all", "settings", null, { limits: lim, switches: ci });
  return { limits: lim, switches: ci };
};
F.obv_admin_invite_fx_allow = async (q, { p_actor, p_user, p_on }) => {
  if (p_on == null) err("bad_request", { field: "on" });
  const u = await D.userRow(q, p_user); if (!u) err("not_found");
  if (u.invite_fx_allowed !== !!p_on) { await q.run("update users set invite_fx_allowed = ? where osu_id = ?", !!p_on, p_user); await D.audit(q, p_actor, p_on ? "invite.fx_allow" : "invite.fx_block", "user", p_user, { username: u.username }); }
  return { id: p_user, fx_allowed: !!p_on };
};
F.obv_admin_invite_links = async (q, { p_owner_id }) => {
  const out = []; for (const l of await q.all("select * from invite_links order by (revoked_at is null) desc, created_at desc")) out.push(await D.linkJson(q, l, p_owner_id)); return out;
};
F.obv_admin_invite_link_create = async (q, { p_actor, p_owner_id, p_max, p_note }) => {
  const note = left(trim(p_note || ""), 80) || null;
  if (p_max == null || !(p_max >= 1 && p_max <= 1000)) err("bad_request", { field: "max_uses" });
  if (await q.val("select count(*) from invite_links where revoked_at is null") >= 200) err("too_many_pending");
  const code = await D.newInviteCode(q);
  await q.run("insert into invite_links (code, created_by, max_uses, note, created_at) values (?, ?, ?, ?, ?)", code, p_actor, Math.trunc(p_max), note, q.now);
  await D.audit(q, p_actor, "invite.link_create", "invite", code, { max_uses: Math.trunc(p_max), note });
  return D.linkJson(q, await q.one("select * from invite_links where code = ?", code), p_owner_id);
};
F.obv_admin_invite_link_update = async (q, { p_actor, p_owner_id, p_code, p_patch }) => {
  let l = await q.one("select * from invite_links where code = ?", p_code); if (!l) err("not_found");
  const pt = isObj(p_patch) ? p_patch : {};
  if (pt.revoke === true && l.revoked_at == null) {
    await q.run("update invite_links set revoked_at = ? where code = ?", q.now, p_code); l = await q.one("select * from invite_links where code = ?", p_code);
    await D.audit(q, p_actor, "invite.link_revoke", "invite", l.code, { note: l.note, uses: l.uses });
  }
  if (has(pt, "max_uses")) {
    if (typeof pt.max_uses !== "number") err("bad_request", { field: "max_uses" });
    const m = Math.round(pt.max_uses);
    if (m < Math.max(1, l.uses) || m > 1000) err("bad_request", { field: "max_uses", min: Math.max(1, l.uses) });
    if (m !== l.max_uses) { await q.run("update invite_links set max_uses = ? where code = ?", m, p_code); l = await q.one("select * from invite_links where code = ?", p_code); await D.audit(q, p_actor, "invite.link_limit", "invite", l.code, { note: l.note, to: m }); }
  }
  return D.linkJson(q, l, p_owner_id);
};

// ---------- projects ----------
F.obv_admin_projects = async (q, { p_q, p_status, p_limit, p_offset, p_sort, p_owner }) => {
  const where = [], a = [];
  if (p_q) { where.push("(p.title like ? or p.artist like ? or u.username like ? or p.id = ?)"); a.push(like(p_q), like(p_q), like(p_q), String(p_q).toLowerCase()); }
  if (p_owner != null) { where.push("p.owner_id = ?"); a.push(p_owner); }
  if (p_status === "active") { where.push("p.status = 'active' and p.expires_at > ?"); a.push(q.now); }
  else if (p_status === "expiring") { where.push("p.status = 'active' and p.expires_at > ? and p.expires_at <= ?"); a.push(q.now, q.ahead(48 * HOUR)); }
  else if (p_status === "expired") { where.push("p.status = 'active' and p.expires_at <= ?"); a.push(q.now); }
  else if (p_status === "deleting") where.push("p.status = 'deleting'");
  else if (p_status) where.push("0");
  const f = `select p.*, u.username, u.max_project_bytes umax from projects p join users u on u.osu_id = p.owner_id ${where.length ? "where " + where.join(" and ") : ""}`;
  const order = { size: "size_bytes desc,", expires: "expires_at asc,", updated: "updated_at desc," }[p_sort] || "";
  const rows = await q.all(`select o.*, (select count(*) from members m where m.project_id = o.id) nm, (select count(*) from blobs b where b.project_id = o.id) nb,
    (select coalesce(sum(b.size), 0) from blobs b where b.project_id = o.id) sb from (${f}) o order by ${order} created_at desc limit ? offset ?`, ...a, clamp(p_limit, 1, 100, 30), clamp(p_offset, 0, 1e9, 0));
  const def = await D.maxProjectBytes(q), agg = await q.one(`select count(*) n, coalesce(sum(size_bytes), 0) b from (${f})`, ...a);
  return { total: agg.n, bytes: agg.b, rows: rows.map(o => ({ id: o.id, title: o.title, artist: o.artist, owner: { id: o.owner_id, username: o.username }, size_bytes: o.size_bytes,
    limit_bytes: o.umax != null ? o.umax : def, revision: o.revision, created_at: o.created_at, updated_at: o.updated_at, expires_at: o.expires_at, status: statusOf(o, q.now),
    delete_reason: o.delete_reason, cleanup_attempts: o.cleanup_attempts, cleanup_error: o.cleanup_error, cleanup_at: o.cleanup_at, members: o.nm, files: o.nb, stored_bytes: o.sb })) };
};
F.obv_admin_project_get = async (q, { p_project }) => {
  const p = D.P(await q.one("select * from projects where id = ?", uuid(p_project))); if (!p) err("not_found");
  const bl = await q.one("select sum(state = 'committed') c, sum(state = 'pending') pe, sum(state = 'orphaned') o, coalesce(sum(size), 0) b from blobs where project_id = ?", p.id);
  return { ...await D.projectJson(q, p, "admin"), status: statusOf(p, q.now), delete_reason: p.delete_reason, cleanup_attempts: p.cleanup_attempts, cleanup_error: p.cleanup_error,
    files: p.manifest.map(m => ({ path: m.path, size: Number(m.size) })).sort((a, b) => b.size - a.size),
    blobs: { committed: bl.c || 0, pending: bl.pe || 0, orphaned: bl.o || 0, bytes: bl.b },
    members: (await q.all("select u.osu_id, u.username, m.role, m.added_at from members m join users u on u.osu_id = m.user_id where m.project_id = ? order by m.added_at", p.id)).map(m => ({ id: m.osu_id, username: m.username, role: m.role, added_at: m.added_at })),
    annotations: await q.val("select count(*) from annotations where project_id = ?", p.id),
    saves: (await q.all("select s.revision, s.committed_at, (select username from users x where x.osu_id = s.user_id) un from saves s where project_id = ? and state = 'committed' order by committed_at desc limit 15", p.id))
      .map(s => ({ revision: s.revision, at: s.committed_at, user: s.un })) };
};
F.obv_admin_project_delete = async (q, { p_actor, p_project }) => {
  const pid = uuid(p_project), p = pid && await q.one("select * from projects where id = ?", pid); if (!p) err("not_found");
  await q.batch([["update projects set status = 'deleting', delete_reason = coalesce(case when status = 'deleting' then delete_reason end, 'admin'), cleanup_at = ? where id = ?", q.now, pid],
    ["update saves set state = 'expired' where project_id = ? and state = 'open'", pid]]);
  await D.audit(q, p_actor, "project.delete", "project", pid, { title: p.title, owner: p.owner_id, size: p.size_bytes });
  return { id: pid, status: "deleting" };
};
F.obv_admin_project_expiry = async (q, { p_actor, p_project, p_expires_at }) => {
  const pid = uuid(p_project), p = pid && await q.one("select * from projects where id = ?", pid); if (!p) err("not_found");
  if (p.status !== "active") err("bad_request", { reason: "being deleted" });
  const t = p_expires_at == null ? NaN : Date.parse(p_expires_at);
  if (!Number.isFinite(t) || t <= q.at.getTime() + 5 * 60e3 || t > q.at.getTime() + 366 * DAY) err("bad_request", { field: "expires_at" });
  const to = new Date(t).toISOString();
  await q.run("update projects set expires_at = ?, expiry_v = expiry_v + 1 where id = ?", to, pid); // (the trigger lets only this change it)
  await D.audit(q, p_actor, "project.expiry", "project", pid, { title: p.title, owner: p.owner_id, from: p.expires_at, to });
  return { id: pid, expires_at: to };
};
F.obv_admin_cleanup_status = async q => {
  const deleting = (await q.all("select p.*, (select count(*) from blobs b where b.project_id = p.id) nf from projects p where p.status = 'deleting' order by p.cleanup_at"))
    .map(p => ({ id: p.id, title: p.title, reason: p.delete_reason, attempts: p.cleanup_attempts, error: p.cleanup_error, at: p.cleanup_at, files: p.nf }));
  const g = await q.one("select sum(state = 'orphaned') o, sum(state = 'pending' and created_at < ?) p from blobs", q.ago(3 * HOUR));
  return { deleting, gc_waiting: { orphaned: g.o || 0, pending_stale: g.p || 0 },
    runs: (await q.all("select * from job_runs order by id desc limit 20")).map(j => ({ job: j.job, at: j.finished_at, ok: D.B(j.ok), detail: J(j.detail) })) };
};

// ---------- settings ----------
F.obv_admin_settings = async q => {
  const s = await q.settings(), c = await q.one(`select sum(max_project_bytes is not null) a, sum(retention_days is not null) b, sum(max_projects is not null) c, sum(invite_limit is not null) d, sum(can_invite is not null) e from users`);
  return { settings: [...D.SPEC].sort((x, y) => x[0] < y[0] ? -1 : 1).map(([key, kind, min, max, def]) => ({ key, kind, min, max, default: def, value: key in s ? s[key] : def })),
    bucket_limit: null, overrides: { max_project_bytes: c.a || 0, retention_days: c.b || 0, max_projects: c.c || 0, invite_limit: c.d || 0, can_invite: c.e || 0 } };
};
F.obv_admin_settings_set = async (q, { p_actor, p_values }) => {
  if (!isObj(p_values)) err("bad_request");
  if (Object.keys(p_values).some(k => !D.SPEC.some(s => s[0] === k))) err("bad_request", { reason: "unknown setting" });
  const s = await q.settings(), changed = {};
  for (const [key, kind, min, max] of D.SPEC) {
    if (!has(p_values, key)) continue;
    const v = p_values[key];
    if (kind === "bool") { if (typeof v !== "boolean") err("bad_request", { field: key }); }
    else { if (typeof v !== "number") err("bad_request", { field: key }); if (v !== Math.trunc(v) || v < min || v > max) err("bad_request", { field: key, min, max }); }
    const old = key in s ? s[key] : null;
    if (JSON.stringify(old) !== JSON.stringify(v)) {
      await q.run("insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", key, JSON.stringify(v));
      changed[key] = { from: old, to: v };
    }
  }
  q._s = null;
  if (Object.keys(changed).length) await D.audit(q, p_actor, "settings.change", "settings", null, changed);
  return { ...await F.obv_admin_settings(q), changed, bucket: { bucket_limit: await D.maxProjectBytes(q), synced: false } };
};

// ---------- errors and reports ----------
F.obv_admin_errors = async (q, { p_resolved, p_limit, p_offset, p_kind }) => {
  const res = !!p_resolved, w = res ? "resolved_at is not null" : "resolved_at is null and kind = ?", a = res ? [] : [p_kind || "error"];
  const rows = await q.all(`select * from client_errors where ${w} order by last_at desc limit ? offset ?`, ...a, clamp(p_limit, 1, 100, 30), clamp(p_offset, 0, 1e9, 0));
  return { total: await q.val(`select count(*) from client_errors where ${w}`, ...a), open: await q.val("select count(*) from client_errors where resolved_at is null"),
    open_errors: await q.val("select count(*) from client_errors where resolved_at is null and kind = 'error'"), open_reports: await q.val("select count(*) from client_errors where resolved_at is null and kind = 'report'"),
    rows: rows.map(e => ({ sig: e.sig, kind: e.kind, message: e.message, source: e.source, stack: e.stack, page: e.page, version: e.version, browser: e.browser, reporter: e.reporter,
      count: e.count, first_at: e.first_at, last_at: e.last_at, resolved_at: e.resolved_at })) };
};
F.obv_admin_error_set = async (q, { p_actor, p_sig, p_resolved, p_clear }) => {
  if (p_clear) { const n = await q.run("delete from client_errors where resolved_at is not null"); await D.audit(q, p_actor, "errors.clear", "site", "errors", { count: n }); return { deleted: n }; }
  if (!await q.run("update client_errors set resolved_at = ? where sig = ?", p_resolved ? q.now : null, p_sig)) err("not_found");
  return { ok: true };
};

// ---------- audit log ----------
F.obv_admin_audit = async (q, { p_limit, p_offset, p_action, p_q }) => {
  const where = [], a = [];
  if (p_action) { where.push("a.action like ?"); a.push(p_action.replace(/[%_]/g, "\\$&") + "%"); }
  if (p_q) { where.push("(a.target_id = ? or cast(a.actor_id as text) = ? or a.detail like ? or exists (select 1 from users x where x.osu_id = a.actor_id and x.username like ?))"); a.push(p_q, p_q, like(p_q), like(p_q)); }
  const w = where.length ? "where " + where.join(" and ").replace("a.action like ?", "a.action like ? escape '\\'") : "";
  const rows = await q.all(`select a.*, (select username from users where osu_id = a.actor_id) an from audit_log a ${w} order by a.id desc limit ? offset ?`, ...a, clamp(p_limit, 1, 200, 50), clamp(p_offset, 0, 1e9, 0));
  return { total: await q.val(`select count(*) from audit_log a ${w}`, ...a), rows: rows.map(x => ({ id: x.id, at: x.at, actor: x.actor_id, actor_name: x.an, action: x.action, target_type: x.target_type, target_id: x.target_id, detail: J(x.detail) })) };
};

// ---------- changelog ----------
const clJson = c => c && ({ id: c.id, title: c.title, version_label: c.version_label, content_md: c.content_md, status: c.status, published_at: c.published_at, sort_order: c.sort_order, created_at: c.created_at, updated_at: c.updated_at });
F.obv_changelog_admin = async q => (await q.all("select * from changelog order by sort_order desc, published_at desc nulls last, created_at desc")).map(clJson);
F.obv_changelog_save = async (q, { p_actor, p_id, p_title, p_version, p_content, p_status, p_published_at, p_base_updated_at }) => {
  if (!trim(p_title || "")) err("bad_request", { field: "title" });
  if (!["draft", "published"].includes(p_status)) err("bad_request", { field: "status" });
  if (p_title.length > 200 || (p_version || "").length > 40 || (p_content || "").length > 20000) err("bad_request", { reason: "too long" });
  const pub = p_published_at == null ? null : new Date(p_published_at).toISOString();
  let c;
  if (p_id == null) {
    const id = crypto.randomUUID(), order = (await q.val("select coalesce(max(sort_order), 0) from changelog")) + 1;
    await q.run(`insert into changelog (id, title, version_label, content_md, status, published_at, sort_order, created_at, updated_at, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, trim(p_title), trim(p_version || ""), p_content || "", p_status, p_status === "published" ? (pub || q.now) : pub, order, q.now, q.now, p_actor, p_actor);
    c = await q.one("select * from changelog where id = ?", id);
    await D.audit(q, p_actor, "changelog.create", "changelog", c.id, { title: c.title, status: c.status });
  } else {
    const id = uuid(p_id), cur = id && await q.one("select * from changelog where id = ?", id); if (!cur) err("not_found");
    if (p_base_updated_at != null && Date.parse(cur.updated_at) !== Date.parse(p_base_updated_at)) err("conflict", { updated_at: cur.updated_at });
    await q.run("update changelog set title = ?, version_label = ?, content_md = ?, status = ?, published_at = ?, updated_at = ?, updated_by = ? where id = ?",
      trim(p_title), trim(p_version || ""), p_content || "", p_status, p_status === "published" ? (pub || cur.published_at || q.now) : pub,
      new Date(Math.max(Date.now(), Date.parse(cur.updated_at) + 1)).toISOString(), p_actor, id); // (always later: an open edit form from before is a conflict, even within the same millisecond)
    c = await q.one("select * from changelog where id = ?", id);
    await D.audit(q, p_actor, cur.status === "draft" && p_status === "published" ? "changelog.publish" : cur.status === "published" && p_status === "draft" ? "changelog.unpublish" : "changelog.edit",
      "changelog", c.id, { title: c.title, status: c.status });
  }
  return clJson(c);
};
F.obv_changelog_delete = async (q, { p_actor, p_id }) => {
  const id = uuid(p_id), c = id && await q.one("select * from changelog where id = ?", id); if (!c) err("not_found");
  await q.run("delete from changelog where id = ?", id);
  await D.audit(q, p_actor, "changelog.delete", "changelog", c.id, { title: c.title, status: c.status });
  return { deleted: c.id };
};
F.obv_changelog_move = async (q, { p_actor, p_id, p_dir }) => {
  const all = await q.all("select id, sort_order from changelog order by sort_order, published_at nulls first, created_at, id");
  await q.batch(all.map((r, i) => r.sort_order !== i + 1 ? ["update changelog set sort_order = ? where id = ?", i + 1, r.id] : null).filter(Boolean)); // (1, 2, 3… first)
  const id = uuid(p_id), c = id && await q.one("select * from changelog where id = ?", id); if (!c) err("not_found");
  const o = await q.one("select * from changelog where sort_order = ?", c.sort_order + (p_dir > 0 ? 1 : -1));
  if (o) {
    await q.batch([["update changelog set sort_order = ? where id = ?", o.sort_order, c.id], ["update changelog set sort_order = ? where id = ?", c.sort_order, o.id]]); // (order only: not a content edit)
    await D.audit(q, p_actor, "changelog.reorder", "changelog", c.id, { title: c.title, dir: Math.sign(p_dir) });
  }
  return clJson(await q.one("select * from changelog where id = ?", id));
};
