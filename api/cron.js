// GET /api/cron: daily cleanup (vercel.json "crons"). Vercel sends "Authorization: Bearer <CRON_SECRET>".
// Deletes the files and rows of expired / deleted projects (access to them already stopped at expiry) and
// replaced or abandoned uploads. Safe to run twice or to miss a day: everything outstanding is picked up next time.
const db = require("./_lib/db");
const { runCleanup } = require("./_lib/cleanup");
const crypto = require("crypto");

// constant-time compare of fixed-size digests: any header (non-ASCII too, whose byte length isn't its string length) is
// just a mismatch, never a thrown error
const digest = s => crypto.createHash("sha256").update(String(s), "utf8").digest();

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET || "", got = String(req.headers.authorization || "");
  const want = "Bearer " + secret;
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  if (!secret || !crypto.timingSafeEqual(digest(got), digest(want))) { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); } // (no CRON_SECRET: always refused)
  if (!db.configured()) { res.statusCode = 503; return res.end('{"error":"not_configured"}'); }
  try { const out = await runCleanup(); res.statusCode = 200; res.end(JSON.stringify({ ok: true, ...out })); }
  catch (e) { console.error("cron", e && e.code); res.statusCode = 500; res.end(JSON.stringify({ error: (e && e.code) || "server_error" })); }
};
