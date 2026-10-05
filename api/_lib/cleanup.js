// Deleting project files. A project row is only removed after its files are gone from Storage (Supabase: checked in the
// database against storage.objects; R2: the Worker's deletes, which are immediate, succeeded); if Storage fails, the project stays marked "deleting" (already inaccessible)
// and the next run retries. Used by the daily cron, the owner's Delete, and the admin dashboard.
const db = require("./db");

async function purgeProject(id) {
  let err = null;
  try {
    const k = await db.rpc("obv_cleanup_keys", { p_project: id });
    if (k && Array.isArray(k.keys) && k.keys.length) await db.removeKeys(k.keys);
    const stray = await db.listFolder(`p/${id}`); // anything in its folder that isn't tracked
    if (stray.length) await db.removeKeys(stray);
  } catch (e) { err = (e && e.code) || "storage_error"; }
  return db.rpc("obv_cleanup_finish", db.r2on() ? { p_project: id, p_error: err, p_external: true } : { p_project: id, p_error: err });
}

// maxProjects: each project takes ~4 requests to the database / storage (Cloudflare's free plan allows 50 per run)
async function runCleanup(budgetMs = 45000, maxProjects = 50) {
  const t0 = Date.now(), out = { purged: 0, pending: 0, gc_deleted: 0, errors: [] };
  const due = await db.rpc("obv_cleanup_due", { p_limit: maxProjects }) || [];
  for (const p of due) {
    if (Date.now() - t0 > budgetMs) { out.pending++; continue; }
    try { const r = await purgeProject(p.id); if (r && r.done) out.purged++; else out.pending++; }
    catch (e) { out.pending++; out.errors.push((e && e.code) || "error"); }
  }
  if (Date.now() - t0 < budgetMs) {
    const keys = await db.rpc("obv_gc_list", { p_limit: 500 }) || [];
    if (keys.length) {
      let gcErr = false; try { await db.removeKeys(keys); } catch (e) { gcErr = true; out.errors.push("gc_storage"); }
      if (!db.r2on() || !gcErr) { // (R2: the rows go only once the files are deleted; Supabase: checked against storage.objects)
        const r = await db.rpc("obv_gc_finish", db.r2on() ? { p_keys: keys, p_external: true } : { p_keys: keys });
        out.gc_deleted = (r && r.deleted) || 0;
      }
    }
  }
  try { const a = await db.rpc("obv_account_gc", {}); if (a && a.removed) out.accounts_removed = a.removed; } catch {} // deleted accounts whose projects are gone (before the account migration: nothing)
  out.ms = Date.now() - t0;
  await db.rpc("obv_job_log", { p_job: "cleanup", p_ok: !out.errors.length && !out.pending, p_detail: out });
  return out;
}
module.exports = { purgeProject, runCleanup };
