// A real PostgreSQL (PGlite, WASM) set up like a Supabase project: the anon / authenticated / service_role roles with
// Supabase's default grants, and a minimal `storage` schema (buckets + objects with metadata.size), then our migrations.
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(root, "supabase", "migrations");

const SUPABASE_LIKE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants everything in public to the API roles by default (RLS is what protects tables)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[],
  created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text,
  owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant all on storage.objects, storage.buckets to service_role;
grant select on storage.objects, storage.buckets to anon, authenticated;
`;

export async function freshDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_LIKE);
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort()) {
    try { await db.exec(readFileSync(join(MIGRATIONS, f), "utf8")); }
    catch (e) { e.message = `${f}: ${e.message}`; throw e; }
  }
  return db;
}

// call a public function like PostgREST does (named arguments), as a given role
export async function rpc(db, name, args = {}, role = "service_role") {
  const keys = Object.keys(args);
  const vals = keys.map(k => { const v = args[k]; if (k === "p_keys") return "{" + v.map(x => JSON.stringify(String(x))).join(",") + "}"; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; });
  const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  await db.exec(`set role ${role}`);
  try { const res = await db.query(sql, vals); return res.rows[0].r; }
  finally { await db.exec("reset role"); }
}

export async function rpcErr(db, name, args, role) {
  try { await rpc(db, name, args, role); } catch (e) { return e; }
  throw new Error(`${name} should have failed`);
}

export async function asRole(db, role, sql, params) {
  await db.exec(`set role ${role}`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role"); }
}

// what Supabase Storage does when an upload finishes: a row in storage.objects with the stored size
export async function putObject(db, key, size, bucket = "obv-projects") {
  await db.query("insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3) on conflict (bucket_id, name) do nothing",
    [bucket, key, JSON.stringify({ size, mimetype: "application/octet-stream" })]);
}
export async function deleteObjects(db, keys, bucket = "obv-projects") {
  await db.query("delete from storage.objects where bucket_id = $1 and name = any($2::text[])", [bucket, keys]);
}
export const sha = s => createHash("sha256").update(String(s)).digest("hex");
