// Moving the database from Supabase to Cloudflare D1, once (Admin → Settings → Database, site owner only): online
// saving is paused on Supabase, every table is read there (obv_export_all) and written to D1 in the same order the
// foreign keys need, replacing whatever D1 had; then the row counts of both are compared. The site keeps using
// Supabase until DB_BACKEND=d1 is set on the Worker; removing it goes back. Saving stays paused on D1 too until the
// owner turns it on there (Admin → Settings), so nothing is saved on the side that's about to be left.
const DEL_ORDER = ["annotations", "members", "saves", "blobs", "projects", "user_logins", "invite_links", "audit_log", "job_runs", "changelog", "client_errors", "settings", "r2_usage", "account_deletions", "users"];
const INS_ORDER = [...DEL_ORDER].reverse();
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/; // (Postgres timestamptz as JSON)

function cell(table, col, v) {
  if (v === null || v === undefined) return null;
  if (table === "settings" && col === "value") return JSON.stringify(v); // (jsonb scalars: true, 15…)
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "string" && TS.test(v)) return new Date(v).toISOString();
  return v;
}
async function columns(d1, table) { return ((await d1.prepare(`pragma table_info(${table})`).all()).results || []).map(c => c.name); }

async function copyToD1(pgRpc, d1, actor) {
  const t0 = Date.now();
  await pgRpc("obv_admin_settings_set", { p_actor: actor, p_values: { saving_enabled: false } }); // (nothing changes while it copies)
  const data = await pgRpc("obv_export_all", {});
  const stmts = DEL_ORDER.map(t => d1.prepare(`delete from ${t}`)), counts = {};
  const users = data.users || [];
  for (const t of INS_ORDER) {
    const cols = await columns(d1, t), rows = data[t] || []; counts[t] = rows.length;
    for (const r of rows) {
      const row = { ...r };
      if (t === "users") row.invited_by = null; // (set below, once every user is there)
      if (t === "settings" && row.key === "saving_enabled") row.value = false;
      const use = cols.filter(c => c in row);
      stmts.push(d1.prepare(`insert into ${t} (${use.join(", ")}) values (${use.map(() => "?").join(", ")})`).bind(...use.map(c => cell(t, c, row[c]))));
    }
  }
  for (const u of users) if (u.invited_by != null) stmts.push(d1.prepare("update users set invited_by = ? where osu_id = ?").bind(u.invited_by, u.osu_id));
  if (!(data.settings || []).some(s => s.key === "saving_enabled")) stmts.push(d1.prepare("insert or replace into settings (key, value) values ('saving_enabled', 'false')"));
  // one transaction: D1 runs a batch all or nothing
  await d1.batch(stmts);
  const check = {};
  for (const t of INS_ORDER) { const n = (await d1.prepare(`select count(*) n from ${t}`).first()).n; check[t] = { supabase: counts[t], d1: n, ok: n === counts[t] }; }
  return { ok: Object.values(check).every(c => c.ok), tables: check, exported_at: data.exported_at, ms: Date.now() - t0 };
}
async function d1Counts(d1) {
  const out = {}; for (const t of INS_ORDER) { try { out[t] = (await d1.prepare(`select count(*) n from ${t}`).first()).n; } catch { out[t] = null; } } return out;
}
module.exports = { copyToD1, d1Counts };
