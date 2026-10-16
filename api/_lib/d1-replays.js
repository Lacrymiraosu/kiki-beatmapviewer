// D1 versions of the database functions (3/3): saved replays (kept 60 days) and their share links. Same names, arguments, answers and
// errors as the SQL in supabase/migrations/20261010090000_obv_replays.sql and 20261011150000_obv_replay_share.sql; the table is
// d1/migrations/0005_replays.sql, its share_key column 0006_replay_share.sql (until that has run, the share functions fail like a missing
// function: db.js maps "no such column: share_key" to missing(); the rest works as before). See d1.js.
const crypto = require("crypto");
const D = require("./d1");
const { F, J, err, uuid, isObj, DAY } = D;

const MAX_BYTES = 1048576, KEEP_DAYS = 60, META_MAX = 6144;
const rep = r => r && { id: r.id, sha256: r.sha256, size: r.size, meta: J(r.meta), created_at: r.created_at, expires_at: r.expires_at, share_key: r.share_key == null ? null : r.share_key }; // (what the owner sees)
const KEY = /^[A-Za-z0-9_-]{32}$/;
// the row a share link opens: the right key, not expired, its owner active; anything else null (the callers answer not_found for all of it)
async function sharedRow(q, p_id, p_key) {
  const id = uuid(p_id);
  if (!id || typeof p_key !== "string" || !KEY.test(p_key)) return null;
  return q.one(`select r.* from replays r join users o on o.osu_id = r.owner_id where r.id = ? and r.share_key is not null and r.share_key = ? and r.expires_at > ?
    and o.status = 'active' and not exists (select 1 from account_deletions d where d.osu_id = r.owner_id)`, id, p_key, q.now);
}
const metaStr = (m, k) => m && typeof m[k] === "string" ? m[k].slice(0, 300) : null;
const perUser = async q => Number(await D.setOr(q, "replays_per_user", 20));
const budget = async q => Number(await D.setOr(q, "replay_budget_bytes", 100000000));
const usedBytes = async q => Number(await q.val("select coalesce(sum(size), 0) from replays"));
const limits = async q => ({ max_bytes: MAX_BYTES, per_user: await perUser(q), days: KEEP_DAYS, budget_bytes: await budget(q), used_bytes: await usedBytes(q) });

F.obv_replay_list = async (q, { p_actor }) => {
  await D.activeUser(q, p_actor);
  return { replays: (await q.all("select * from replays where owner_id = ? and expires_at > ? order by created_at desc, rowid desc", p_actor, q.now)).map(rep), limits: await limits(q) };
};
F.obv_replay_save = async (q, { p_actor, p_sha256, p_size, p_meta, p_data }) => {
  await D.activeUser(q, p_actor);
  if (typeof p_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p_sha256) || !Number.isInteger(p_size) || p_size < 1) err("bad_request", { field: "size" });
  if (p_size > MAX_BYTES) err("too_large", { limit: MAX_BYTES });
  let meta = p_meta; if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = null; } }
  if (!isObj(meta) || Buffer.byteLength(JSON.stringify(meta)) > META_MAX) err("bad_request", { field: "meta" });
  if (typeof p_data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(p_data) || p_data.length !== 4 * Math.floor((p_size + 2) / 3)) err("bad_request", { field: "data" });
  const raw = Buffer.from(p_data, "base64");
  if (raw.length !== p_size || crypto.createHash("sha256").update(raw).digest("hex") !== p_sha256) err("bad_request", { field: "sha256" });
  if (raw[0] > 3) err("bad_request", { field: "mode" });
  await q.run("delete from replays where owner_id = ? and sha256 = ? and expires_at <= ?", p_actor, p_sha256, q.now); // (an expired copy not removed yet: this is a new save)
  const find = async () => q.one("select * from replays where owner_id = ? and sha256 = ?", p_actor, p_sha256);
  let r = await find();
  if (r) return { replay: rep(r), existed: true };
  if ((await D.setOr(q, "saving_enabled", true)) === false) err("saving_disabled");
  const lim = await perUser(q), cap = await budget(q), id = crypto.randomUUID();
  // one statement checks the two limits and inserts, so two saves at once can't both pass the same room
  const n = await q.run(`insert into replays (id, owner_id, sha256, size, meta, data_b64, created_at, expires_at)
    select ?, ?, ?, ?, ?, ?, ?, ? where (select count(*) from replays where owner_id = ? and expires_at > ?) < ? and (select coalesce(sum(size), 0) from replays) + ? <= ?
    on conflict (owner_id, sha256) do nothing`,
    id, p_actor, p_sha256, p_size, JSON.stringify(meta), p_data, q.now, q.ahead(KEEP_DAYS * DAY), p_actor, q.now, lim, p_size, cap);
  r = await find();
  if (!n) {
    if (r) return { replay: rep(r), existed: true }; // (the same file saved at the same time)
    if (Number(await q.val("select count(*) from replays where owner_id = ? and expires_at > ?", p_actor, q.now)) >= lim) err("replay_limit", { limit: lim });
    err("storage_full");
  }
  return { replay: rep(r), existed: false };
};
F.obv_replay_get = async (q, { p_actor, p_id }) => {
  await D.activeUser(q, p_actor);
  const id = uuid(p_id), r = id && await q.one("select * from replays where id = ? and owner_id = ? and expires_at > ?", id, p_actor, q.now);
  if (!r) err("not_found");
  return { replay: rep(r), data: r.data_b64 };
};
F.obv_replay_delete = async (q, { p_actor, p_id }) => {
  await D.activeUser(q, p_actor);
  const id = uuid(p_id);
  if (!id || !await q.run("delete from replays where id = ? and owner_id = ?", id, p_actor)) err("not_found");
  return { ok: true };
};
// the owner shares a replay: on (keep the key or make one) | reset (a new key) | off; someone else's, an expired or a missing one: not_found
F.obv_replay_share = async (q, { p_actor, p_id, p_mode }) => {
  await D.activeUser(q, p_actor);
  if (!["on", "reset", "off"].includes(p_mode)) err("bad_request", { field: "mode" });
  const id = uuid(p_id), r = id && await q.one("select id, share_key, expires_at from replays where id = ? and owner_id = ? and expires_at > ?", id, p_actor, q.now);
  if (!r) err("not_found");
  const key = p_mode === "off" ? null : p_mode === "reset" ? D.newLinkKey() : (r.share_key || D.newLinkKey());
  await q.run("update replays set share_key = ? where id = ? and owner_id = ?", key, id, p_actor);
  await D.audit(q, p_actor, "replay.share_" + p_mode, "replay", id, {});
  return { id, share_key: key, expires_at: r.expires_at };
};
// a member opens a shared link: the file and its score info, never who saved it
F.obv_replay_shared = async (q, { p_actor, p_id, p_key }) => {
  await D.activeUser(q, p_actor);
  const r = await sharedRow(q, p_id, p_key);
  if (!r) err("not_found");
  return { replay: { id: r.id, size: r.size, meta: J(r.meta), created_at: r.created_at, expires_at: r.expires_at }, data: r.data_b64 };
};
// the link preview card (api/og.js, no login): the map's title, artist and difficulty name only
F.obv_replay_card = async (q, { p_id, p_key }) => {
  const r = await sharedRow(q, p_id, p_key);
  if (!r) err("not_found");
  const m = J(r.meta);
  return { title: metaStr(m, "title"), artist: metaStr(m, "artist"), version: metaStr(m, "version") };
};
F.obv_replays_gc = async (q, a) => {
  const lim = a && a.p_limit != null ? Math.max(0, Math.floor(Number(a.p_limit)) || 0) : 500;
  return { deleted: lim ? await q.run("delete from replays where id in (select id from replays where expires_at < ? order by expires_at limit ?)", q.now, lim) : 0 };
};
