// Local stand-in for the parts of Supabase the server uses, for tests only:
//  * POST /rest/v1/rpc/<fn>  -> calls public.<fn>(named args) in a real PostgreSQL (PGlite) with our migrations,
//    as the service_role, and answers like PostgREST (JSON result; errors as 400 { code, message, details }).
//  * Storage: signed upload URLs (one object each, no overwrite), signed download URLs, list, delete, with the bucket's
//    file_size_limit enforced like Supabase. Every stored object gets a storage.objects row with metadata.size, which
//    is what the database functions check.
// It is not Supabase: it only mimics the requests/responses this app relies on.
import http from "node:http";
import crypto from "node:crypto";
import { freshDb } from "../lib/pg.mjs";

export async function startSupabaseEmu({ port = 0, key = "emu-secret-key-for-local-tests-only" } = {}) {
  const db = await freshDb();
  const blobs = new Map(), upTokens = new Map(), dlTokens = new Map(), sigs = new Map();
  const emu = { db, key, blobs, calls: [], fail: { remove: 0 } };
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "authorization,apikey,content-type,x-upsert,cache-control,x-client-info" };
  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise((ok, bad) => { const ch = []; req.on("data", c => ch.push(c)); req.on("end", () => ok(Buffer.concat(ch))); req.on("error", bad); });
  async function signature(fn) {
    if (!sigs.has(fn)) {
      const r = await db.query(`select array_to_json(p.proargnames) as names, array_to_json(p.proargtypes::regtype[]::text[]) as types
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn]);
      sigs.set(fn, r.rows[0] ? (r.rows[0].names || []).map((n, i) => [n, r.rows[0].types[i]]) : null);
    }
    return sigs.get(fn);
  }
  async function rpc(fn, args) {
    const sig = await signature(fn);
    if (!sig) return [404, { code: "PGRST202", message: `Could not find the function public.${fn}` }];
    const names = Object.keys(args), vals = [], parts = [];
    for (const n of names) {
      const t = (sig.find(s => s[0] === n) || [])[1];
      if (!t) return [404, { code: "PGRST202", message: `no parameter ${n}` }];
      let v = args[n];
      if (v !== null && t === "jsonb") v = JSON.stringify(v);
      else if (v !== null && t.endsWith("[]")) v = "{" + v.map(x => JSON.stringify(String(x))).join(",") + "}";
      else if (v !== null && typeof v === "object") v = JSON.stringify(v);
      vals.push(v); parts.push(`${n} => $${vals.length}::${t}`);
    }
    try { // one transaction per call, like PostgREST (PGlite runs them one at a time)
      const out = await db.transaction(async tx => { await tx.exec("set local role service_role"); const r = await tx.query(`select public.${fn}(${parts.join(", ")}) as r`, vals); return r.rows[0].r ?? null; });
      return [200, out];
    } catch (e) { return [400, { code: e.code || "P0001", message: e.message, details: e.detail || null, hint: null }]; }
  }
  const authed = req => req.headers.apikey === key;
  async function bucketLimit(b) { const r = await db.query("select file_size_limit from storage.buckets where id = $1", [b]); return r.rows[0] ? Number(r.rows[0].file_size_limit || 0) : null; }
  function fileFromMultipart(buf, ctype) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype || ""); if (!m) return buf;
    const bnd = Buffer.from("--" + (m[1] || m[2]));
    let pos = buf.indexOf(bnd);
    while (pos >= 0) {
      const next = buf.indexOf(bnd, pos + bnd.length); if (next < 0) break;
      const part = buf.subarray(pos + bnd.length + 2, next - 2), he = part.indexOf("\r\n\r\n");
      const head = part.subarray(0, he).toString(), data = part.subarray(he + 4);
      if (/filename=/.test(head) || /name=""/.test(head)) return data;
      pos = next;
    }
    return Buffer.alloc(0);
  }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
    emu.calls.push(req.method + " " + p.replace(/[0-9a-f-]{36}/g, ":id"));
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    try {
      let m;
      if ((m = p.match(/^\/rest\/v1\/rpc\/(\w+)$/)) && req.method === "POST") {
        if (!authed(req)) return json(res, 401, { message: "Invalid API key" });
        const [code, out] = await rpc(m[1], JSON.parse((await readBody(req)).toString() || "{}"));
        return json(res, code, out);
      }
      if ((m = p.match(/^\/storage\/v1\/object\/upload\/sign\/([\w-]+)\/(.+)$/))) {
        const [, bucket, name] = m;
        if (req.method === "POST") {
          if (!authed(req)) return json(res, 400, { statusCode: "403", error: "Unauthorized", message: "Invalid Compact JWS" });
          const token = crypto.randomBytes(16).toString("hex");
          upTokens.set(token, { bucket, name, exp: Date.now() + 7200e3, upsert: req.headers["x-upsert"] === "true" });
          return json(res, 200, { url: `/object/upload/sign/${bucket}/${name}?token=${token}`, token });
        }
        if (req.method === "PUT") {
          const t = upTokens.get(u.searchParams.get("token"));
          if (!t || t.bucket !== bucket || t.name !== name || t.exp < Date.now()) return json(res, 400, { statusCode: "403", error: "Unauthorized", message: "invalid signature" });
          const data = fileFromMultipart(await readBody(req), req.headers["content-type"]);
          const limit = await bucketLimit(bucket);
          if (limit && data.length > limit) return json(res, 413, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" });
          const exists = blobs.has(bucket + "/" + name);
          if (exists && !t.upsert) return json(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
          blobs.set(bucket + "/" + name, data);
          await db.query("insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3) on conflict (bucket_id, name) do update set metadata = excluded.metadata",
            [bucket, name, JSON.stringify({ size: data.length, mimetype: "application/octet-stream" })]);
          return json(res, 200, { Key: `${bucket}/${name}` });
        }
      }
      if ((m = p.match(/^\/storage\/v1\/object\/sign\/([\w-]+)$/)) && req.method === "POST") {
        if (!authed(req)) return json(res, 400, { statusCode: "403", error: "Unauthorized" });
        const b = JSON.parse((await readBody(req)).toString()), bucket = m[1];
        return json(res, 200, (b.paths || []).map(path => {
          if (!blobs.has(bucket + "/" + path)) return { path, signedURL: null, error: "Either the object does not exist or you do not have access to it" };
          const token = crypto.randomBytes(16).toString("hex"); dlTokens.set(token, { bucket, path, exp: Date.now() + (b.expiresIn || 60) * 1000 });
          return { path, signedURL: `/object/sign/${bucket}/${path}?token=${token}`, error: null };
        }));
      }
      if ((m = p.match(/^\/storage\/v1\/object\/sign\/([\w-]+)\/(.+)$/)) && req.method === "GET") {
        const t = dlTokens.get(u.searchParams.get("token"));
        if (!t || t.bucket !== m[1] || t.path !== m[2] || t.exp < Date.now()) return json(res, 400, { statusCode: "400", error: "InvalidJWT", message: "jwt expired" });
        const data = blobs.get(m[1] + "/" + m[2]); if (!data) return json(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
        res.writeHead(200, { "content-type": "application/octet-stream", ...cors }); return res.end(data);
      }
      if ((m = p.match(/^\/storage\/v1\/object\/([\w-]+)$/)) && req.method === "DELETE") {
        if (!authed(req)) return json(res, 400, { statusCode: "403", error: "Unauthorized" });
        if (emu.fail.remove > 0) { emu.fail.remove--; return json(res, 500, { statusCode: "500", error: "internal", message: "simulated storage failure" }); }
        const b = JSON.parse((await readBody(req)).toString()), bucket = m[1], out = [];
        for (const name of b.prefixes || []) if (blobs.delete(bucket + "/" + name)) { out.push({ name, bucket_id: bucket }); await db.query("delete from storage.objects where bucket_id = $1 and name = $2", [bucket, name]); }
        return json(res, 200, out);
      }
      if ((m = p.match(/^\/storage\/v1\/object\/list\/([\w-]+)$/)) && req.method === "POST") {
        if (!authed(req)) return json(res, 400, { statusCode: "403", error: "Unauthorized" });
        const b = JSON.parse((await readBody(req)).toString()), bucket = m[1], pre = String(b.prefix || "").replace(/\/?$/, "/");
        const names = [...blobs.keys()].filter(k => k.startsWith(bucket + "/" + pre)).map(k => k.slice(bucket.length + 1 + pre.length)).filter(n => !n.includes("/")).sort();
        return json(res, 200, names.slice(b.offset || 0, (b.offset || 0) + (b.limit || 100)).map(name => ({ name, id: crypto.randomUUID(), metadata: { size: blobs.get(bucket + "/" + pre + name).length } })));
      }
      json(res, 404, { message: "not found" });
    } catch (e) { json(res, 500, { message: e.message }); }
  });
  await new Promise(r => srv.listen(port, "127.0.0.1", r));
  emu.url = `http://127.0.0.1:${srv.address().port}`;
  emu.close = () => new Promise(r => srv.close(r));
  return emu;
}
