// Hosting config: Cloudflare (wrangler.jsonc, _headers, .assetsignore, worker.js) keeps the same headers and hides the
// same files as Vercel (vercel.json, .vercelignore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = f => readFileSync(join(root, f), "utf8");
const wranglerFile = existsSync(join(root, "wrangler.jsonc")) ? "wrangler.jsonc" : "wrangler.example.jsonc"; // (the public repo ships only the example)
const vercel = JSON.parse(read("vercel.json"));

test("_headers has vercel.json's site-wide headers and cache rules", () => {
  const blocks = {}; let cur = null;
  for (const line of read("_headers").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) { cur = blocks[line.trim()] = {}; continue; }
    const i = line.indexOf(":"); cur[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const site = vercel.routes.find(r => r.src === "/(.*)" && r.headers).headers;
  assert.deepEqual(blocks["/*"], site);
  for (const d of ["js", "assets", "i18n"]) assert.equal(blocks[`/${d}/*`]["Cache-Control"], "public, max-age=31536000, immutable");
  assert.equal(blocks["/"]["Cache-Control"], "public, max-age=0, must-revalidate");
});

test("CSP script-src allows only the exact cdnjs library paths, and those loads carry SRI", () => {
  const csp = vercel.routes.find(r => r.src === "/(.*)" && r.headers).headers["Content-Security-Policy"];
  const src = (csp.split(";").map(s => s.trim()).find(s => s.startsWith("script-src ")) || "").split(/\s+/).slice(1);
  assert.ok(!/unsafe-(inline|eval)/.test(src.join(" ")), "no unsafe-inline/unsafe-eval");
  const cdn = src.filter(s => /cdnjs\.cloudflare\.com/.test(s));
  // the bare host would allow every library on cdnjs, including known CSP-bypass gadgets (old AngularJS etc.)
  for (const s of cdn) assert.match(s, /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[\w.-]+\/[\w.-]+\/$/, s);
  assert.ok(!src.some(s => /^(https:\/\/)?cdnjs\.cloudflare\.com\/?$/.test(s)), "bare cdnjs host in script-src");
  const loads = [];
  for (const f of ["js/core.js", "js/live.js"]) {
    const code = read(f);
    for (const m of code.matchAll(/"(https:\/\/cdnjs\.cloudflare\.com\/[^"]+\.js)"/g)) {
      loads.push(m[1]);
      const after = code.slice(m.index, m.index + 600);
      assert.match(after, /\.integrity = "sha(384|512)-[A-Za-z0-9+/]+={0,2}"/, m[1] + " has integrity");
      assert.match(after, /\.crossOrigin = "anonymous"/, m[1] + " has crossOrigin");
    }
  }
  assert.equal(loads.length, 2);
  for (const u of loads) assert.ok(cdn.some(p => u.startsWith(p)), u + " is allowed by script-src");
  assert.equal(cdn.length, loads.length, "no unused cdnjs paths in script-src");
});

test("server code, tests and the database aren't served as static files", () => {
  const ignored = read(".assetsignore").split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  for (const x of ["api", "tests", "scripts", "supabase", "worker.js", "wrangler.jsonc", ".env*", ".git", "*.md"]) assert.ok(ignored.includes(x), x);
});

test("wrangler.jsonc runs the Worker for the API and for shared links on /", () => {
  const w = JSON.parse(read(wranglerFile).replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(w.main, "worker.js");
  assert.ok(w.compatibility_flags.includes("nodejs_compat"));
  assert.deepEqual(w.assets.run_worker_first, ["/", "/api/*"]);
  assert.deepEqual(w.triggers.crons, vercel.crons.map(c => c.schedule));
});

test("THIRD_PARTY_NOTICES.txt is served and carries ppy's MIT notices (code translated from ppy/osu and osu-framework)", () => {
  const n = read("THIRD_PARTY_NOTICES.txt");
  assert.match(n, /Copyright \(c\) 2025 ppy Pty Ltd/); assert.match(n, /Copyright \(c\) 2024 ppy Pty Ltd/);
  assert.equal((n.match(/Permission is hereby granted, free of charge/g) || []).length, 2);
  assert.match(n, /creativecommons\.org\/licenses\/by-nc\/4\.0/);
  const ignored = read(".assetsignore") + "\n" + read(".vercelignore");
  assert.ok(!/THIRD_PARTY|\*\.txt/.test(ignored), "not excluded from the static files");
  for (const f of ["js/parse.js", "js/auto.js"]) assert.match(read(f).split("\n")[1], /translated from ppy\/osu.*THIRD_PARTY_NOTICES\.txt/, f);
});

test("LICENSE is the GPL-3.0 text, and the notices say what isn't under it", () => {
  const l = read("LICENSE"), n = read("THIRD_PARTY_NOTICES.txt");
  assert.match(l, /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(n, /released under the GNU General Public License, version 3/);
  const notOurs = ["CC BY-NC 4.0", "demo map", "what users upload"].concat(existsSync(join(root, "skins/yugen")) ? ["YUGEN"] : []); // (the public repo has no YUGEN skin)
  for (const x of notOurs) assert.ok(n.slice(0, n.indexOf("1. ppy/osu")).includes(x), x);
});
