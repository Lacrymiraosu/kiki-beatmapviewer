// The database functions on Cloudflare D1 (SQLite): the same names, arguments, answers and errors as the SQL functions
// in supabase/migrations (public.obv_*), written in JavaScript because D1 has no stored procedures. db.rpc() calls them
// when the Worker runs on D1 (DB_BACKEND=d1 with the DB binding; see worker.js). Schema: d1/migrations.
// Times are ISO text (UTC), JSON is text, booleans are 0 / 1; rows are turned back into what Postgres returned.
const crypto = require("crypto");
const { ApiError, STATUS } = require("./errors");

const err = (code, detail) => { throw new ApiError(code, STATUS[code] || 400, detail == null ? null : detail); };
const J = s => s == null ? null : typeof s === "string" ? JSON.parse(s) : s;
const B = v => v == null ? null : !!v;
const DAY = 864e5, HOUR = 36e5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = v => { const s = String(v == null ? "" : v).toLowerCase(); return UUID.test(s) ? s : null; };
const left = (s, n) => s == null ? null : String(s).slice(0, n);
const trim = s => s == null ? null : String(s).trim();
const isObj = v => v != null && typeof v === "object" && !Array.isArray(v);
const toInt = p => { if (p == null || !/^-?\d{1,10}(\.\d+)?$/.test(String(p))) return null; const n = Math.round(Number(p)); return Number.isFinite(n) && Math.abs(n) <= 2147483647 ? n : null; };
const toBool = p => { const s = String(p == null ? "" : p).toLowerCase(); return s === "true" ? true : s === "false" ? false : null; };
const validPath = p => p != null && typeof p === "string" && p.length >= 1 && p.length <= 255 && !/[\x00-\x1f\\]/.test(p) && p[0] !== "/" && !/(^|\/)\.\.?(\/|$)/.test(p) && !/\/\//.test(p);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const jtype = v => v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "boolean" ? "boolean" : typeof v === "number" ? "number" : typeof v === "string" ? "string" : "undefined";

// ---------- queries ----------
class Q {
  constructor(db) { this.db = db; this.at = new Date(); this.now = this.at.toISOString(); this._s = null; }
  bind(sql, a) { return this.db.prepare(sql).bind(...a.map(v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : isObj(v) || Array.isArray(v) ? JSON.stringify(v) : v)); }
  async one(sql, ...a) { return (await this.bind(sql, a).first()) || null; }
  async all(sql, ...a) { return (await this.bind(sql, a).all()).results || []; }
  async run(sql, ...a) { const r = await this.bind(sql, a).run(); return (r && r.meta && r.meta.changes) || 0; }
  async val(sql, ...a) { const r = await this.one(sql, ...a); return r ? Object.values(r)[0] : null; }
  async batch(list) { if (list.length) await this.db.batch(list.map(([sql, ...a]) => this.bind(sql, a))); }
  ago(ms) { return new Date(this.at.getTime() - ms).toISOString(); }
  ahead(ms) { return new Date(this.at.getTime() + ms).toISOString(); }
  async settings() { if (!this._s) { this._s = {}; for (const r of await this.all("select key, value from settings")) this._s[r.key] = J(r.value); } return this._s; }
  async setting(k) { const s = await this.settings(); return k in s ? s[k] : null; }
}

// ---------- rows -> what Postgres returned ----------
const U = r => r && { ...r, can_invite: B(r.can_invite), invite_fx: !!r.invite_fx, invite_fx_allowed: !!r.invite_fx_allowed, turn_relay: !!r.turn_relay, allow_add: !!r.allow_add, prefs: J(r.prefs) };
const P = r => r && { ...r, manifest: J(r.manifest) || [] };

const SPEC = [ // obv.setting_spec(): key, kind, min, max, default
  ["max_project_bytes", "int", 1000000, 95000000, 30000000], ["storage_budget_bytes", "int", 10000000, 9500000000, 900000000],
  ["retention_days", "int", 1, 365, 15], ["max_projects_per_user", "int", 1, 1000, 10], ["max_members_per_project", "int", 1, 100, 20],
  ["max_annotations", "int", 10, 20000, 2000], ["saving_enabled", "bool", null, null, true], ["access_required", "bool", null, null, true],
  ["invites_per_user", "int", 0, 1000, 3], ["invitees_can_invite", "bool", null, null, false],
  ["perm_guest_listing", "bool", null, null, true], ["perm_guest_player", "bool", null, null, true], ["perm_guest_mappers", "bool", null, null, true],
  ["perm_guest_editor", "bool", null, null, false], ["perm_member_listing", "bool", null, null, true], ["perm_member_player", "bool", null, null, true],
  ["perm_member_mappers", "bool", null, null, true], ["perm_member_editor", "bool", null, null, true], ["perm_member_online", "bool", null, null, true],
  ["turn_enabled", "bool", null, null, true], ["turn_ping_ms", "int", 50, 1000, 150], ["perm_guest_live", "bool", null, null, false],
  ["turn_month_gb", "int", 0, 100000, 1000], ["r2_class_a_month", "int", 0, 1000000, 900000], ["r2_class_b_month", "int", 0, 10000000, 9000000]];
const specDef = k => (SPEC.find(s => s[0] === k) || [])[4];
const num = v => v == null ? null : Number(v);
async function setOr(q, k, d) { const v = await q.setting(k); return v == null ? d : v; }
async function maxProjectBytes(q) { return num(await setOr(q, "max_project_bytes", 30000000)); }
async function savingOn(q) { return (await setOr(q, "saving_enabled", true)) !== false; }
async function accessRequired(q) { return (await setOr(q, "access_required", true)) !== false; }

// ---------- users ----------
async function userRow(q, id) { return U(await q.one("select * from users where osu_id = ?", id)); }
async function activeUser(q, id) {
  const u = await userRow(q, id);
  if (!u || await q.one("select 1 from account_deletions where osu_id = ?", id)) err("no_user");
  if (u.status !== "active") err("suspended", { reason: u.status_reason });
  return u;
}
async function ensureUser(q, id, username, avatar) {
  await q.run("insert into users (osu_id, username, avatar_url, created_at) values (?, ?, ?, ?) on conflict (osu_id) do nothing", id, left(username, 64), left(avatar, 300), q.now);
}
async function userLimits(q, id) {
  const u = id == null ? null : await q.one("select max_project_bytes, retention_days, max_projects from users where osu_id = ?", id);
  return {
    max_project_bytes: (u && u.max_project_bytes != null) ? u.max_project_bytes : await maxProjectBytes(q),
    retention_days: (u && u.retention_days != null) ? u.retention_days : num(await setOr(q, "retention_days", 15)),
    max_projects: (u && u.max_projects != null) ? u.max_projects : num(await setOr(q, "max_projects_per_user", 10)),
    saving_enabled: await savingOn(q),
    custom: { max_project_bytes: !!(u && u.max_project_bytes != null), retention_days: !!(u && u.retention_days != null), max_projects: !!(u && u.max_projects != null) },
  };
}
async function limitBytes(q, owner) { const r = await q.one("select max_project_bytes from users where osu_id = ?", owner); return r && r.max_project_bytes != null ? r.max_project_bytes : maxProjectBytes(q); }
async function audit(q, actor, action, type, id, detail) {
  await q.run("insert into audit_log (at, actor_id, action, target_type, target_id, detail) values (?, ?, ?, ?, ?, ?)", q.now, actor == null ? null : actor, action, type, id == null ? null : String(id), detail || {});
}
const userBrief = async (q, id) => { if (id == null) return null; const u = await q.one("select osu_id, username from users where osu_id = ?", id); return u ? { id: u.osu_id, username: u.username } : null; };
const nameOf = async (q, id) => id == null ? null : q.val("select username from users where osu_id = ?", id);

// ---------- projects ----------
async function access(q, actor, pid) {
  const p = pid && P(await q.one("select * from projects where id = ?", pid));
  if (!p) err("not_found");
  const r = p.owner_id === actor ? "owner" : await q.val("select role from members where project_id = ? and user_id = ?", pid, actor);
  if (!r) err("not_found");
  if (p.status !== "active") err("not_found");
  if (p.expires_at <= q.now) err("expired", { expires_at: p.expires_at });
  return r;
}
async function projectJson(q, p, role) {
  const o = await q.one("select osu_id, username, avatar_url from users where osu_id = ?", p.owner_id);
  return { id: p.id, title: p.title, artist: p.artist, creator: p.creator, source_set_id: p.source_set_id, revision: p.revision, size_bytes: p.size_bytes,
    limit_bytes: await limitBytes(q, p.owner_id), created_at: p.created_at, updated_at: p.updated_at, expires_at: p.expires_at,
    owner: o ? { id: o.osu_id, username: o.username, avatar: o.avatar_url } : null, saved_by: await userBrief(q, p.saved_by), role };
}
async function annotationsOf(q, pid) {
  return (await q.all("select a.*, u.osu_id uid, u.username uname from annotations a join users u on u.osu_id = a.author_id where a.project_id = ? order by a.time_ms", pid)).map(a => ({
    id: a.id, author: { id: a.uid, username: a.uname }, diff: a.diff, kind: a.kind, object_id: a.object_id, time_ms: a.time_ms, body: a.body, data: J(a.data),
    object_missing: !!a.object_missing, version: a.version, created_at: a.created_at, updated_at: a.updated_at }));
}
async function membersOf(q, pid) {
  return (await q.all("select u.osu_id, u.username, u.avatar_url, m.role from members m join users u on u.osu_id = m.user_id where m.project_id = ? order by m.added_at", pid))
    .map(m => ({ id: m.osu_id, username: m.username, avatar: m.avatar_url, role: m.role }));
}
const conflictDetail = async (q, p) => ({ revision: p.revision, updated_at: p.updated_at, saved_by: await nameOf(q, p.saved_by) });

// ---------- invites ----------
const fxAllowed = (u, owner) => !!(u.invite_fx_allowed || u.role === "admin" || u.osu_id === owner);
async function inviteState(q, u, owner) {
  const top = u.osu_id === owner || u.role === "admin";
  const lim = top ? null : (u.invite_limit != null ? u.invite_limit : num(await setOr(q, "invites_per_user", 3)));
  const can = top || (u.can_invite != null ? u.can_invite : (u.invited_by == null || (await setOr(q, "invitees_can_invite", false)) === true));
  return { unlimited: top, limit: lim, custom_limit: u.invite_limit, used: await q.val("select count(*) from users where invited_by = ?", u.osu_id), can_invite: !!can, custom_can_invite: u.can_invite };
}
async function inviteRoom(q, u, owner) { const s = await inviteState(q, u, owner); return s.can_invite && (s.unlimited || s.used < s.limit); }
async function linkOk(q, l, owner) {
  if (l.revoked_at != null) return "inactive";
  if (!await q.one("select 1 from users where osu_id = ? and status = 'active' and (role = 'admin' or osu_id = ?)", l.created_by, owner)) return "inactive";
  if (l.uses >= l.max_uses) return "full";
  return null;
}
async function linkJson(q, l, owner) {
  return { code: l.code, max_uses: l.max_uses, uses: l.uses, note: l.note, created_at: l.created_at, revoked_at: l.revoked_at, created_by: await userBrief(q, l.created_by),
    state: (await linkOk(q, l, owner)) || "ok",
    joined: (await q.all("select osu_id, username, invited_at from users where invited_via = ? order by invited_at desc", l.code)).map(x => ({ id: x.osu_id, username: x.username, at: x.invited_at })) };
}
const CODE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
async function newInviteCode(q) {
  for (;;) {
    // bytes >= 224 (= 56 * 4) are dropped so every character is equally likely (no modulo bias)
    let c = ""; while (c.length < 10) for (const x of crypto.randomBytes(16)) if (x < 224 && c.length < 10) c += CODE_CH[x % CODE_CH.length];
    if (!await q.one("select 1 from users where invite_code = ?", c) && !await q.one("select 1 from invite_links where code = ?", c)) return c;
  }
}
const newLinkKey = () => crypto.randomBytes(24).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").slice(0, 32);

const F = {}; // the functions, by name

// ---------- sign-in, users ----------
F.obv_user_login = async (q, { p_id, p_username, p_avatar, p_country }) => {
  if (!(p_id > 0)) err("bad_user");
  await q.run(`insert into users (osu_id, username, avatar_url, country, last_login_at, last_seen_at, created_at) values (?, ?, ?, ?, ?, ?, ?)
    on conflict (osu_id) do update set username = excluded.username, avatar_url = excluded.avatar_url, country = excluded.country, last_login_at = excluded.last_login_at, last_seen_at = excluded.last_seen_at`,
    p_id, left(p_username, 64), left(p_avatar, 300), left(p_country, 4), q.now, q.now, q.now);
  const u = await userRow(q, p_id);
  return { id: u.osu_id, username: u.username, status: u.status, status_reason: u.status_reason };
};
F.obv_user_touch = async (q, { p_id, p_username, p_avatar, p_country }) => {
  if (!(p_id > 0)) err("bad_user");
  const d = await q.val("select deleted_at from account_deletions where osu_id = ?", p_id);
  if (d != null) return { id: p_id, status: "deleted", deleted_at: d };
  await q.run(`insert into users (osu_id, username, avatar_url, country, last_seen_at, created_at) values (?, ?, ?, ?, ?, ?)
    on conflict (osu_id) do update set last_seen_at = excluded.last_seen_at, username = coalesce(excluded.username, users.username), avatar_url = coalesce(excluded.avatar_url, users.avatar_url)`,
    p_id, left(p_username, 64), left(p_avatar, 300), left(p_country, 4), q.now, q.now);
  const u = await userRow(q, p_id);
  return { id: u.osu_id, username: u.username, status: u.status, status_reason: u.status_reason, role: u.role, limits: await userLimits(q, u.osu_id),
    access: u.access, access_requested_at: u.access_requested_at, access_decided_at: u.access_decided_at, access_required: await accessRequired(q), prefs_at: u.prefs_at,
    sessions_valid_after: u.sessions_valid_after == null ? null : u.sessions_valid_after };
};
// every login of p_user made up to p_at ends (d1/migrations/0004_session_revoke.sql); never moves back
F.obv_sessions_revoke = async (q, { p_user, p_at }) => {
  if (!(p_user > 0)) err("bad_user");
  const t = Date.parse(p_at), at = Number.isFinite(t) ? new Date(t).toISOString() : q.now;
  await q.run("update users set sessions_valid_after = case when sessions_valid_after is not null and sessions_valid_after > ? then sessions_valid_after else ? end where osu_id = ?", at, at, p_user);
  return { sessions_valid_after: await q.val("select sessions_valid_after from users where osu_id = ?", p_user) };
};
F.obv_usernames = async (q, { p_ids }) => {
  const ids = (Array.isArray(p_ids) ? p_ids : []).slice(0, 100).map(Number).filter(Number.isFinite); if (!ids.length) return [];
  return (await q.all(`select osu_id, username, avatar_url from users where osu_id in (${ids.map(() => "?").join(",")})`, ...ids)).map(u => ({ id: u.osu_id, username: u.username, avatar: u.avatar_url }));
};
F.obv_admin_role = async (q, { p_id }) => { const u = await q.one("select role, status from users where osu_id = ?", p_id); return u ? { role: u.role, status: u.status } : { role: "user", status: "none" }; };
F.obv_access_of = async (q, { p_id }) => { const u = await q.one("select access, role, status from users where osu_id = ?", p_id); return u ? { access: u.access, role: u.role, status: u.status } : { access: "none", role: "user", status: "none" }; };
F.obv_access_required = async q => accessRequired(q);
F.obv_admin_user_ensure = async (q, { p_id, p_username, p_avatar }) => { if (!(p_id > 0)) err("bad_user"); await ensureUser(q, p_id, p_username || String(p_id), p_avatar); return { id: p_id }; };
F.obv_audit_add = async (q, { p_actor, p_action, p_type, p_id, p_detail }) => { await audit(q, p_actor, left(p_action, 80), left(p_type, 40), left(p_id, 120), p_detail); return null; };
F.obv_turn_conf = async (q, { p_user }) => {
  const u = await q.one("select turn_relay, status from users where osu_id = ?", p_user);
  return { on: (await setOr(q, "turn_enabled", true)) !== false, ping_ms: num(await setOr(q, "turn_ping_ms", 150)), month_gb: num(await setOr(q, "turn_month_gb", 1000)), relay: !!(u && u.turn_relay && u.status === "active") };
};
F.obv_site_perms = async q => {
  const s = await q.settings(), v = k => k in s ? s[k] : specDef(k), guest = {}, member = {};
  for (const [k] of SPEC) { if (k.startsWith("perm_guest_")) guest[k.slice(11)] = v(k); else if (k.startsWith("perm_member_")) member[k.slice(12)] = v(k); }
  guest.online = false;
  return { guest, member };
};

// ---------- access requests ----------
F.obv_access_request = async (q, { p_id, p_username, p_avatar, p_country, p_message }) => {
  const msg = left(trim(p_message || ""), 300) || null;
  await F.obv_user_touch(q, { p_id, p_username, p_avatar, p_country });
  const u = await userRow(q, p_id);
  if (u.status !== "active") err("suspended");
  if (u.access === "approved") return { access: "approved" };
  if (u.access === "pending") { await q.run("update users set access_message = coalesce(?, access_message) where osu_id = ?", msg, p_id); return { access: "pending", access_requested_at: u.access_requested_at }; }
  if (u.access === "denied" && u.access_decided_at > q.ago(DAY)) err("too_soon", { retry_at: new Date(Date.parse(u.access_decided_at) + DAY).toISOString() });
  await q.run("update users set access = 'pending', access_message = ?, access_requested_at = ? where osu_id = ?", msg, q.now, p_id);
  await audit(q, p_id, "access.request", "user", p_id, { username: u.username });
  return { access: "pending", access_requested_at: q.now };
};
F.obv_google_request = async (q, { p_sub, p_id, p_username, p_avatar, p_country, p_message }) => {
  if (p_sub == null || String(p_sub).length < 1 || String(p_sub).length > 255) err("bad_request", { field: "subject" });
  if (!(p_id > 0)) err("bad_user");
  if (!await accessRequired(q)) err("bad_request", { reason: "open" });
  const other = await q.val("select osu_id from user_logins where provider = 'google' and subject = ?", p_sub);
  if (other != null && other !== p_id) err("conflict", { reason: "linked_elsewhere" });
  if (other == null) {
    const u = await userRow(q, p_id);
    if (await q.one("select 1 from user_logins where osu_id = ?", p_id) || (u && (u.last_seen_at != null || u.access !== "none" || u.role !== "user" || u.status !== "active"
        || await q.one("select 1 from projects where owner_id = ?", p_id) || await q.one("select 1 from members where user_id = ?", p_id)))) err("conflict", { reason: "osu_in_use" });
    await q.run("delete from account_deletions where osu_id = ?", p_id);
  }
  const r = await F.obv_access_request(q, { p_id, p_username, p_avatar, p_country, p_message });
  await q.run("insert into user_logins (provider, subject, osu_id, verified, created_at) values ('google', ?, ?, 0, ?) on conflict (provider, subject) do nothing", p_sub, p_id, q.now);
  await audit(q, p_id, "access.request_google", "user", p_id, { username: p_username });
  return { ...r, verified: B(await q.val("select verified from user_logins where provider = 'google' and subject = ?", p_sub)) };
};

// ---------- backup logins ----------
F.obv_login_list = async (q, { p_user }) => {
  const l = await q.one("select created_at, last_used_at, verified from user_logins where osu_id = ? and provider = 'google'", p_user);
  return { google: l ? { linked_at: l.created_at, last_used_at: l.last_used_at, verified: !!l.verified } : null };
};
F.obv_login_find = async (q, { p_provider, p_subject }) => {
  const r = await q.one("select u.*, l.verified lv from user_logins l join users u on u.osu_id = l.osu_id where l.provider = ? and l.subject = ?", p_provider, p_subject);
  if (!r) return null;
  await q.run("update user_logins set last_used_at = ? where provider = ? and subject = ?", q.now, p_provider, p_subject);
  return { id: r.osu_id, username: r.username, avatar: r.avatar_url, country: r.country, status: r.status, verified: !!r.lv };
};
// Google sign-in without osu!: its own account at once (ids from 10^12, name "Google user"); see the Supabase migration
// 20261006090000_obv_google_only.sql
const GONLY = 1e12;
F.obv_google_account = async (q, { p_sub }) => {
  if (p_sub == null || String(p_sub).length < 1 || String(p_sub).length > 255) err("bad_request", { field: "subject" });
  let uid = await q.val("select osu_id from user_logins where provider = 'google' and subject = ?", p_sub);
  if (uid == null) {
    do uid = GONLY + Math.floor(Math.random() * GONLY);
    while (await q.one("select 1 from users where osu_id = ?", uid) || await q.one("select 1 from account_deletions where osu_id = ?", uid));
    await q.batch([
      ["insert into users (osu_id, username, last_login_at, last_seen_at, created_at) values (?, 'Google user', ?, ?, ?)", uid, q.now, q.now, q.now],
      ["insert into user_logins (provider, subject, osu_id, verified, created_at) values ('google', ?, ?, 1, ?)", p_sub, uid, q.now]]);
    await audit(q, uid, "login.google_account", "user", uid, {});
  }
  return F.obv_login_find(q, { p_provider: "google", p_subject: p_sub });
};
// what a merge of p_from into p_to would do, without changing anything (20261008120000_obv_google_merge_safe.sql)
F.obv_google_merge_preview = async (q, { p_from, p_to }) => {
  if (!(p_from >= GONLY) || !(p_to > 0 && p_to < GONLY)) err("bad_user");
  const f = await userRow(q, p_from); if (!f) return { ok: false, reason: "gone" };
  if (f.access === "denied" || f.status !== "active") return { ok: false, reason: "source_denied" };
  if (await q.one("select 1 from account_deletions where osu_id = ?", p_to)) return { ok: false, reason: "deleted" };
  return { ok: true, created_at: f.created_at, projects: Number(await q.val("select count(*) from projects where owner_id = ? and status = 'active'", p_from)) };
};
// the Google-only account p_from moves into the osu! account p_to (confirmed by its owner: POST me/merge-google):
// everything moves, p_from is gone. A denial is never lifted: a denied or suspended p_from can't move, a denied p_to stays
// denied (see 20261008120000_obv_google_merge_safe.sql)
F.obv_google_merge = async (q, { p_from, p_to, p_username, p_avatar, p_country }) => {
  if (!(p_from >= GONLY) || !(p_to > 0 && p_to < GONLY)) err("bad_user");
  const f = await userRow(q, p_from); if (!f) return { merged: false };
  if (f.access === "denied" || f.status !== "active") err("forbidden", { reason: "source_denied" });
  if (await q.one("select 1 from account_deletions where osu_id = ?", p_to)) return { merged: false };
  await q.run("insert into users (osu_id, username, avatar_url, country, last_login_at, last_seen_at, created_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (osu_id) do nothing",
    p_to, left(p_username || "user", 64), left(p_avatar, 300), left(p_country, 4), q.now, q.now, q.now);
  const t = await userRow(q, p_to), rank = a => ({ approved: 3, pending: 2 })[a] || 0, st = [];
  if (t.access !== "denied") {
    if (rank(f.access) > rank(t.access)) st.push(["update users set access = ?, access_message = ?, access_requested_at = ?, access_decided_at = ?, access_decided_by = ?, invited_by = coalesce(invited_by, ?), invited_at = coalesce(invited_at, ?), invited_via = coalesce(invited_via, ?) where osu_id = ?",
      f.access, f.access_message, f.access_requested_at, f.access_decided_at, f.access_decided_by, f.invited_by, f.invited_at, f.invited_via, p_to]);
    st.push(["update users set can_invite = coalesce(can_invite, ?), invite_limit = coalesce(invite_limit, ?) where osu_id = ?", f.can_invite == null ? null : f.can_invite ? 1 : 0, f.invite_limit, p_to]);
    if (t.invite_code == null && f.invite_code != null) st.push(["update users set invite_code = null where osu_id = ?", p_from], ["update users set invite_code = ? where osu_id = ?", f.invite_code, p_to]);
  }
  const moved = await q.val("select count(*) from projects where owner_id = ?", p_from);
  st.push(["update projects set client_key = substr(client_key, 1, 50) || '-g' || substr(id, 1, 8) where owner_id = ? and exists (select 1 from projects x where x.owner_id = ? and x.client_key = projects.client_key)", p_from, p_to],
    ["update projects set owner_id = ? where owner_id = ?", p_to, p_from],
    ["update projects set saved_by = ? where saved_by = ?", p_to, p_from],
    ["delete from members where user_id = ? and exists (select 1 from members x where x.project_id = members.project_id and x.user_id = ?)", p_from, p_to],
    ["update members set user_id = ? where user_id = ?", p_to, p_from],
    ["delete from members where user_id = ? and exists (select 1 from projects p where p.id = members.project_id and p.owner_id = ?)", p_to, p_to],
    ["update members set added_by = ? where added_by = ?", p_to, p_from],
    ["update saves set user_id = ? where user_id = ?", p_to, p_from],
    ["update annotations set author_id = ? where author_id = ?", p_to, p_from],
    ["update invite_links set created_by = ? where created_by = ?", p_to, p_from],
    ["update users set invited_by = ? where invited_by = ?", p_to, p_from]);
  if (await q.one("select 1 from user_logins where provider = 'google' and osu_id = ?", p_to)) st.push(["delete from user_logins where osu_id = ?", p_from]);
  else st.push(["update user_logins set osu_id = ?, verified = 1 where osu_id = ?", p_to, p_from]);
  st.push(["insert into account_deletions (osu_id, deleted_at) values (?, ?) on conflict do nothing", p_from, q.now], ["delete from users where osu_id = ?", p_from]);
  await q.batch(st);
  await audit(q, p_to, "login.google_merged", "user", p_to, { from: p_from, projects: moved });
  return { merged: true, projects: moved };
};
F.obv_login_link = async (q, { p_user, p_provider, p_subject }) => {
  if (p_provider !== "google") err("bad_request", { field: "provider" });
  if (p_subject == null || String(p_subject).length < 1 || String(p_subject).length > 255) err("bad_request", { field: "subject" });
  if (!await q.one("select 1 from users where osu_id = ?", p_user)) err("no_user");
  const other = await q.val("select osu_id from user_logins where provider = ? and subject = ?", p_provider, p_subject);
  if (other != null && other !== p_user) err("conflict", { reason: "linked_elsewhere" });
  await q.run("delete from user_logins where provider = ? and osu_id = ? and subject <> ?", p_provider, p_user, p_subject);
  await q.run("insert into user_logins (provider, subject, osu_id, verified, created_at) values (?, ?, ?, 1, ?) on conflict (provider, subject) do update set verified = 1", p_provider, p_subject, p_user, q.now);
  await audit(q, p_user, "login.link", "user", p_user, { provider: p_provider });
  return F.obv_login_list(q, { p_user });
};
F.obv_login_unlink = async (q, { p_user, p_provider }) => {
  if (await q.run("delete from user_logins where provider = ? and osu_id = ?", p_provider, p_user)) await audit(q, p_user, "login.unlink", "user", p_user, { provider: p_provider });
  return F.obv_login_list(q, { p_user });
};
F.obv_osu_login = async (q, { p_id, p_google_sub }) => {
  if (p_google_sub != null) await q.run("update user_logins set verified = 1 where provider = 'google' and osu_id = ? and subject = ? and verified = 0", p_id, p_google_sub);
  const n = await q.run("delete from user_logins where osu_id = ? and verified = 0", p_id);
  if (n > 0) await audit(q, p_id, "login.unverified_removed", "user", p_id, { count: n });
  return { removed: n };
};

// ---------- the account (Account settings) ----------
F.obv_account_get = async (q, { p_user }) => {
  const u = await activeUser(q, p_user);
  return { id: u.osu_id, username: u.username, avatar: u.avatar_url, country: u.country, created_at: u.created_at, allow_add: u.allow_add,
    sync: !!(u.prefs && u.prefs.sync === true), prefs_at: u.prefs_at, projects: await q.val("select count(*) from projects where owner_id = ? and status = 'active'", p_user) };
};
F.obv_account_prefs = async (q, { p_user }) => {
  const u = await activeUser(q, p_user);
  return { sync: !!(u.prefs && u.prefs.sync === true), prefs: u.prefs && u.prefs.data !== undefined ? u.prefs.data : null, prefs_at: u.prefs_at };
};
F.obv_account_set = async (q, { p_user, p_patch }) => {
  const u = await activeUser(q, p_user), patch = isObj(p_patch) ? p_patch : {};
  if (has(patch, "allow_add")) { if (typeof patch.allow_add !== "boolean") err("bad_request", { field: "allow_add" }); await q.run("update users set allow_add = ? where osu_id = ?", patch.allow_add, p_user); }
  let prefs = u.prefs, prefsAt = u.prefs_at;
  if (has(patch, "sync")) {
    if (typeof patch.sync !== "boolean") err("bad_request", { field: "sync" });
    prefs = patch.sync ? { sync: true, data: prefs && prefs.data !== undefined ? prefs.data : {} } : null; prefsAt = patch.sync ? (prefsAt || q.now) : null; // (off forgets what was kept)
    await q.run("update users set prefs = ?, prefs_at = ? where osu_id = ?", prefs, prefsAt, p_user);
  }
  if (has(patch, "prefs")) {
    if (!isObj(patch.prefs)) err("bad_request", { field: "prefs" });
    if (Buffer.byteLength(JSON.stringify(patch.prefs)) > 16000) err("too_large", { field: "prefs" });
    if (prefs && prefs.sync === true) await q.run("update users set prefs = ?, prefs_at = ? where osu_id = ?", { sync: true, data: patch.prefs }, q.now, p_user);
  }
  return F.obv_account_get(q, { p_user });
};
F.obv_account_export = async (q, { p_user }) => {
  const u = await activeUser(q, p_user), account = { ...u }; delete account.admin_note; delete account.prefs;
  return { account, settings: u.prefs,
    own_projects: (await q.all("select * from projects where owner_id = ? order by created_at", p_user)).map(p => ({ id: p.id, title: p.title, artist: p.artist, creator: p.creator, status: p.status, created_at: p.created_at, expires_at: p.expires_at, size_bytes: p.size_bytes, revision: p.revision })),
    shared_with_you: (await q.all("select p.id, p.title, m.role, m.added_at from members m join projects p on p.id = m.project_id where m.user_id = ?", p_user)).map(x => ({ project: x.id, title: x.title, role: x.role, added_at: x.added_at })),
    your_comments: await q.val("select count(*) from annotations where author_id = ?", p_user),
    invite_links: await q.all("select * from invite_links where created_by = ?", p_user),
    backup_logins: (await q.all("select provider, created_at, last_used_at from user_logins where osu_id = ?", p_user)).map(l => ({ provider: l.provider, linked_at: l.created_at, last_used_at: l.last_used_at })),
    activity_log: (await q.all("select * from audit_log where actor_id = ? order by at desc limit 200", p_user)).map(a => ({ ...a, detail: J(a.detail) })),
    exported_at: q.now };
};
F.obv_account_finish = async (q, { p_user }) => {
  if (!await q.one("select 1 from account_deletions where osu_id = ?", p_user)) return { removed: false };
  if (await q.one("select 1 from projects where owner_id = ?", p_user)) return { removed: false };
  await q.batch([["delete from annotations where author_id = ?", p_user], ["delete from users where osu_id = ?", p_user]]);
  return { removed: true };
};
F.obv_account_delete = async (q, { p_user, p_owner_id }) => {
  await activeUser(q, p_user);
  if (p_owner_id != null && p_user === p_owner_id) err("forbidden", { reason: "owner" });
  const ids = (await q.all("select id from projects where owner_id = ? and status = 'active'", p_user)).map(r => r.id);
  await q.batch([
    ["update saves set state = 'expired' where state = 'open' and project_id in (select id from projects where owner_id = ?)", p_user],
    ["update projects set status = 'deleting', delete_reason = 'account', cleanup_at = ? where owner_id = ? and status = 'active'", q.now, p_user],
    ["delete from annotations where author_id = ? and project_id not in (select id from projects where owner_id = ?)", p_user, p_user],
    ["delete from members where user_id = ?", p_user],
    ["delete from invite_links where created_by = ?", p_user],
    ["delete from user_logins where osu_id = ?", p_user],
    ["update users set invited_by = null where invited_by = ?", p_user],
    [`update users set username = 'deleted', avatar_url = null, country = null, status_reason = null, role = 'user', access = 'none', access_message = null, access_requested_at = null,
      access_decided_at = null, access_decided_by = null, admin_note = null, invite_code = null, invited_by = null, invited_via = null, prefs = null, prefs_at = null, turn_relay = 0 where osu_id = ?`, p_user],
    ["insert into account_deletions (osu_id, deleted_at) values (?, ?) on conflict (osu_id) do update set deleted_at = excluded.deleted_at", p_user, q.now]]);
  await audit(q, p_user, "account.delete", "user", p_user, { projects: ids.length });
  await F.obv_account_finish(q, { p_user });
  return { projects: ids };
};
F.obv_account_restart = async (q, { p_id, p_since }) => {
  const d = await q.val("select deleted_at from account_deletions where osu_id = ?", p_id);
  if (d == null) return { restarted: false };
  if (p_since == null || !(Date.parse(p_since) > Date.parse(d))) err("forbidden", { reason: "deleted" });
  await q.run("delete from account_deletions where osu_id = ?", p_id);
  return { restarted: true };
};
F.obv_account_gc = async q => {
  let n = 0;
  for (const d of await q.all("select a.osu_id from account_deletions a join users u on u.osu_id = a.osu_id where not exists (select 1 from projects p where p.owner_id = a.osu_id)")) { await F.obv_account_finish(q, { p_user: d.osu_id }); n++; }
  return { removed: n };
};

module.exports = { F, Q, SPEC, J, B, U, P, err, uuid, left, trim, isObj, has, jtype, toInt, toBool, validPath, DAY, HOUR, setOr, maxProjectBytes, savingOn, accessRequired,
  userRow, activeUser, ensureUser, userLimits, limitBytes, audit, userBrief, nameOf, access, projectJson, annotationsOf, membersOf, conflictDetail,
  fxAllowed, inviteState, inviteRoom, linkOk, linkJson, newInviteCode, newLinkKey, specDef };
require("./d1-projects");
require("./d1-admin");
