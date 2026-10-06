// Request counters for rate limits: a fixed window per key (e.g. "osu:<ip>"), kept in memory. Per server instance /
// Worker isolate, so best effort: a Cloudflare Rate Limiting binding (or a Durable Object) would make them global.
// When the table is full, finished windows go first, then the oldest ones; it is never wiped all at once (that would
// hand everyone, including whoever filled it, a fresh budget).
function limiter(max = 20000) {
  const m = new Map();
  function sweep(now) {
    for (const [k, e] of m) if (now - e.at >= e.w) m.delete(k);
    for (const k of m.keys()) { if (m.size < max * 0.9) break; m.delete(k); } // (Map order: the oldest windows first)
  }
  // counts one request for key; true when it's over limit in the current window
  return function over(key, limit, windowMs = 60000) {
    const now = Date.now(); let e = m.get(key);
    if (!e || now - e.at >= e.w) {
      if (e) m.delete(key); else if (m.size >= max) sweep(now);
      m.set(key, e = { at: now, n: 0, w: windowMs });
    }
    return ++e.n > limit;
  };
}
// the caller's IP as the host passes it on: x-real-ip (Vercel sets it; worker.js copies Cloudflare's cf-connecting-ip
// into it). Not cf-connecting-ip itself: on Vercel that would be whatever the client sent.
const clientIp = req => String((req.headers && (req.headers["x-real-ip"] || req.headers["x-forwarded-for"])) || "").split(",")[0].trim() || "?";

module.exports = { limiter, clientIp };
