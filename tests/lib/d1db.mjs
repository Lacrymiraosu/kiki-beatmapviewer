// The helpers of lib/pg.mjs for the D1 database (OBV_D1=1): the same database tests run against the JavaScript versions
// of the functions (api/_lib/d1.js) on the D1 stand-in. Storage is a map of key -> size: the Worker checks R2 itself and
// hands the sizes to obv_save_commit, so they're filled in here the same way.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fakeD1 } from "../emu/d1-fake.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { F, Q } = require(join(root, "api/_lib/d1.js"));

export async function freshDb() {
  const d1 = fakeD1(root), db = d1.pg;
  db.d1 = d1; db.objects = new Map(); db.close = async () => {};
  return db;
}
export async function rpc(db, name, args = {}) {
  const a = { ...args };
  if (name === "obv_save_commit" && a.p_stored === undefined) a.p_stored = Object.fromEntries(db.objects); // (what the Worker found on R2)
  // what the Worker does around these: it deletes the files from R2 first and reports what's gone
  if (name === "obv_gc_finish") a.p_keys = a.p_keys.filter(k => !db.objects.has(k));
  if (name === "obv_cleanup_finish") {
    const keys = (await F.obv_cleanup_keys(new Q(db.d1), { p_project: a.p_project }) || { keys: [] }).keys;
    if (keys.some(k => db.objects.has(k)) && a.p_error == null) a.p_error = "files still in storage";
    if (a.p_error != null) a.p_gone = keys.filter(k => !db.objects.has(k));
  }
  const r = await F[name](new Q(db.d1), a);
  return r === undefined ? null : r;
}
export async function rpcErr(db, name, args) {
  try { await rpc(db, name, args); }
  catch (e) { // like a Postgres error: "OBV:<code>", detail as jsonb text
    e.message = "OBV:" + (e.code || e.message);
    if (e.detail && typeof e.detail === "object") e.detail = JSON.stringify(e.detail).replace(/":/g, '": ').replace(/,"/g, ', "');
    return e;
  }
  throw new Error(`${name} should have failed`);
}
export async function asRole() { throw new Error("permission denied (D1 has no database roles: only the Worker reaches it)"); }
export async function putObject(db, key, size) { if (!db.objects.has(key)) db.objects.set(key, size); }
export async function deleteObjects(db, keys) { for (const k of keys) db.objects.delete(k); }
export const sha = s => createHash("sha256").update(String(s)).digest("hex");
