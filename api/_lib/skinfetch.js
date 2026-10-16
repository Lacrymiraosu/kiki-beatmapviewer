// Settings → Skin → "Import from a link": a skin (.osk, a zip) from a direct download link, passed through the Worker when the browser can't fetch it itself (most
// file hosts send no CORS headers). Not an open proxy: https only, a public DNS name only (no IP, no single-label or internal name, no other port, never this site
// itself), every redirect checked again, the answer must be a zip (its first two bytes), at most MAX bytes, nothing cached. No env, secret or binding is used.
const MAX = 64 * 1024 * 1024, HOPS = 4, UA = "KIKI-Beatmap-Viewer skin import (+https://github.com/Lacrymiraosu/kiki-beatmapviewer)";
const INTERNAL = /(^|\.)(localhost|local|internal|lan|home|corp|intranet|localdomain|test|invalid|example)$/;

// -> the URL when it may be fetched, else null. self: host names that are this very site (never fetched: a request chained through itself)
function checkUrl(raw, self) {
  if (typeof raw !== "string" || raw.length > 1000) return null;
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".") || h.includes(":") || h.includes("[") || INTERNAL.test(h)) return null;
  const tld = h.slice(h.lastIndexOf(".") + 1);
  if (!(/^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld))) return null; // (a numeric last label is an IP: 127.0.0.1, 10.1.2.3)
  if (/(^|[-.])osu-beatmap-viewer\./.test(h) || (self || []).some(s => String(s).toLowerCase() === h)) return null;
  u.hash = ""; return u;
}

// -> { ok: true, body (a ReadableStream, starting with the zip's first bytes), length (the upstream's, or null) } | { ok: false, status, error }
async function fetchSkin(raw, self, f = fetch) {
  let u = checkUrl(raw, self); if (!u) return { ok: false, status: 400, error: "bad_url" };
  let r = null;
  for (let hop = 0; ; hop++) {
    try { r = await f(u.href, { method: "GET", redirect: "manual", headers: { "User-Agent": UA, Accept: "*/*" } }); } catch { return { ok: false, status: 502, error: "unreachable" }; }
    const loc = r.status >= 300 && r.status < 400 && r.headers.get("location");
    if (!loc) break;
    if (hop >= HOPS) return { ok: false, status: 502, error: "too_many_redirects" };
    let next = null; try { next = checkUrl(new URL(loc, u).href, self); } catch {}
    if (!next) return { ok: false, status: 400, error: "bad_redirect" }; // (a redirect to an address that would not have been fetched as asked)
    u = next;
  }
  if (!r.ok || !r.body) return { ok: false, status: 502, error: "upstream_" + r.status };
  const len = +r.headers.get("content-length") || 0;
  if (len > MAX) { try { r.body.cancel(); } catch {} return { ok: false, status: 413, error: "too_big" }; }
  const rd = r.body.getReader(), first = [];
  let have = 0;
  while (have < 2) {
    let c; try { c = await rd.read(); } catch { return { ok: false, status: 502, error: "unreachable" }; }
    if (c.done) break;
    first.push(c.value); have += c.value.length;
  }
  const sig = []; for (const c of first) for (const b of c) if (sig.length < 2) sig.push(b);
  if (sig[0] !== 0x50 || sig[1] !== 0x4b) { try { rd.cancel(); } catch {} return { ok: false, status: 415, error: "not_a_zip" }; }
  let total = 0, i = 0;
  const body = new ReadableStream({
    async pull(ctl) {
      let c; if (i < first.length) c = { value: first[i++] }; else { try { c = await rd.read(); } catch (e) { ctl.error(e); return; } if (c.done) { ctl.close(); return; } }
      total += c.value.length;
      if (total > MAX) { try { rd.cancel(); } catch {} ctl.error(new Error("too_big")); return; } // (a truncated body: the browser's length check refuses it)
      ctl.enqueue(c.value);
    },
    cancel() { try { rd.cancel(); } catch {} },
  });
  return { ok: true, body, length: r.headers.get("content-encoding") ? null : (len || null) };
}

// a soft per-isolate limit by client address (a Worker isolate is not shared: the limit is only as good as that)
const hits = new Map();
function limited(ip, now = Date.now(), max = 10, win = 600000) {
  const k = String(ip || "?"), a = (hits.get(k) || []).filter(t => now - t < win);
  if (a.length >= max) { hits.set(k, a); return true; }
  a.push(now); hits.set(k, a);
  if (hits.size > 2000) for (const [x, v] of hits) if (!v.some(t => now - t < win)) hits.delete(x);
  return false;
}

module.exports = { MAX, checkUrl, fetchSkin, limited, _hits: hits };
