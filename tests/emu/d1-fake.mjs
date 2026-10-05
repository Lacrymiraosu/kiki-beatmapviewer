// A stand-in for a Cloudflare D1 binding (prepare / bind / first / all / run, batch in one transaction) on Node's
// built-in SQLite, with the schema from d1/migrations, for local tests only. `pg` runs the Postgres-flavoured SQL the
// tests use for setup and checks (obv.*, $1, ::casts, now(), interval) on it, so the same tests cover both databases.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function fakeD1(root) {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  const dir = join(root, "d1", "migrations");
  for (const f of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const val = v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, a.map(val)); }
    exec() { const s = db.prepare(this.sql); return s; }
    async first() { return this.exec().get(...this.args) ?? null; }
    async all() { return { results: this.exec().all(...this.args) }; }
    async run() { const r = this.exec().run(...this.args); return { meta: { changes: Number(r.changes) } }; }
  }
  const d1 = {
    raw: db,
    prepare: sql => new Stmt(sql),
    async batch(list) {
      db.exec("begin");
      try { const out = list.map(s => ({ meta: { changes: Number(db.prepare(s.sql).run(...s.args).changes) } })); db.exec("commit"); return out; }
      catch (e) { db.exec("rollback"); throw e; }
    },
  };
  // the tests' Postgres SQL -> SQLite (only what they use)
  const NOWX = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const SIGS = { obv_user_touch: ["p_id", "p_username", "p_avatar", "p_country"], obv_admin_access: ["p_status", "p_q", "p_limit", "p_offset"] };
  const lit = s => s === "null" ? null : /^-?\d+$/.test(s) ? Number(s) : s.replace(/^'|'$/g, "").replace(/''/g, "'");
  let expiryFree = false;
  d1.pg = {
    async exec(sql) { const t = sql.match(/(disable|enable) trigger projects_fix_expiry/); if (t) { expiryFree = t[1] === "disable"; return; } db.exec(sql); }, // (D1: the trigger lets a change through when expiry_v moves too)
    async query(sql, params = []) {
      const call = sql.match(/^select public\.(obv_\w+)\((.*)\)(?: as r)?$/s);
      if (call) { // a database function: the D1 version, with its arguments by name
        const { F, Q } = await import("../../api/_lib/d1.js").then(m => m.default || m);
        const vals = call[2].match(/'(?:[^']|'')*'|[^,\s]+/g) || [], a = {}; SIGS[call[1]].forEach((k, i) => { a[k] = lit(vals[i]); });
        return { rows: [{ r: await F[call[1]](new Q(d1), a) }] };
      }
      let s = sql.replace(/\bobv\./g, "").replace(/::\w+/g, "").replace(/\bchar_length\(/g, "length(")
        .replace(/(\w+)\s*\+\s*interval\s*'(\d+) (second|minute|hour|day)s?'/g, (_, c, n, u) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${c}, '+${n} ${u}')`)
        .replace(/now\(\)\s*-\s*interval\s*'(\d+) (second|minute|hour|day)s?'/g, (_, n, u) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${n} ${u}')`).replace(/\bnow\(\)/g, NOWX)
        .replace(/\$(\d+)/g, "?$1");
      if (expiryFree) s = s.replace(/(update projects set expires_at = .*?)( where )/, "$1, expiry_v = expiry_v + 1$2");
      const st = db.prepare(s), args = params.map(v => val(v !== null && typeof v === "object" ? JSON.stringify(v) : v));
      const BOOL = new Set(["verified", "ok", "invite_fx", "invite_fx_allowed", "turn_relay", "allow_add", "object_missing", "can_invite"]); // (Postgres booleans)
      const JSONC = new Set(["manifest", "detail", "data", "prefs", "value"]), TIME = /(^|_)at$/; // (Postgres returned jsonb as objects, timestamptz as Dates)
      const pgv = (k, v) => v == null ? v : BOOL.has(k) ? !!v : JSONC.has(k) && typeof v === "string" ? JSON.parse(v) : TIME.test(k) && typeof v === "string" ? new Date(v) : v;
      if (/^\s*(select|with)/i.test(s)) return { rows: st.all(...args).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, pgv(k, v)]))) };
      const r = st.run(...args); return { rows: [], rowCount: Number(r.changes) };
    },
  };
  return d1;
}
