// The site's page (index.html) with link previews filled in for shared links, so Discord, X, LINE, Messenger… show a
// card: a map (?s= / ?b=), a mapper page (?u=), a live mapping invite (?live= / ?collab=), a shared project (?project=&key=)
// or an invite link to the site (?invite=).
// vercel.json "routes" send "/" with one of those parameters here (routes, not rewrites: rewrites only run when no static
// file matches, and "/" always matches index.html); everything else is the static index.html. The page itself is
// the same for people (the preview crawlers don't run JavaScript, so they only read these tags). Any problem -> the plain page.
const osu = require("./_lib/osu");
const db = require("./_lib/db");
const { query, siteUrl } = require("./_lib/auth");
const { limiter, clientIp } = require("./_lib/rate");

// the page template: read from disk on Vercel / the dev server; on Cloudflare the Worker hands it over (useTemplate)
let TPL = null;
const page = () => TPL || (TPL = require("fs").readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8"));
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const fmtLen = s => { s = Math.round(+s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const fmtMs = ms => { ms = Math.max(0, Math.round(+ms || 0)); const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60; return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(ms % 1000).padStart(3, "0")}`; };
const ST = { ranked: "Ranked", approved: "Approved", qualified: "Qualified", loved: "Loved", pending: "Pending", wip: "WIP", graveyard: "Graveyard" };
const img = (origin, f) => `${origin}/assets/og/${f}.png?v=1`;

// ---------- what a card costs: osu! and database requests, so anyone making up links can't spend them ----------
// Cards come from osu! data (the "og" budget in osu.js: cards go without first) kept here per server instance and, on
// Cloudflare, in the edge cache, so a link shared in a busy chat asks osu! once in 10 minutes (a miss for a minute).
// What still needs a request is counted per IP; over the limit (or out of budget) the page comes without the card.
const OG_RATE = { osu: 20, link: 30 }, over = limiter(); // per IP per minute, per server instance (best effort)
const OG_TTL = 600000, OG_MISS_TTL = 60000, OG_MAX = 500, mem = new Map();
class Limited extends Error {}
function memGet(k) {
  const e = mem.get(k); if (!e) return undefined;
  mem.delete(k); if (Date.now() > e.exp) return undefined;
  mem.set(k, e); return e.v; // (most recently used last)
}
function memSet(k, v) {
  mem.delete(k); mem.set(k, { v, exp: Date.now() + (v == null ? OG_MISS_TTL : OG_TTL) });
  while (mem.size > OG_MAX) mem.delete(mem.keys().next().value);
}
const edge = () => { try { return typeof caches !== "undefined" && caches && caches.default || null; } catch { return null; } };
const edgeKey = k => new Request("https://og-cache.invalid/" + encodeURIComponent(k));
// one request's budget check: the first request it has to make counts once against its IP
function allow(rq, kind) {
  if (rq.ok == null) rq.ok = !over(kind + ":" + rq.ip, OG_RATE[kind]);
  if (!rq.ok) throw new Limited();
}
async function cached(rq, k, load) {
  let v = memGet(k); if (v !== undefined) return v;
  const c = edge();
  if (c) try { const r = await c.match(edgeKey(k)); if (r) { v = (await r.json()).v; memSet(k, v === undefined ? null : v); return v == null ? null : v; } } catch {}
  allow(rq, "osu");
  v = await load(); if (v === undefined) v = null; // (an error isn't kept: osu! busy now isn't "no such map")
  memSet(k, v);
  if (c) try { await c.put(edgeKey(k), new Response(JSON.stringify({ v }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + (v == null ? OG_MISS_TTL : OG_TTL) / 1000 } })); } catch {}
  return v;
}
// only what a card shows
const userCard = u => u && { username: u.username, counts: u.counts, groups: (u.groups || []).map(g => ({ short: g.short, playmodes: g.playmodes })),
  mapping_followers: u.mapping_followers, cover_url: u.cover_url, avatar_url: u.avatar_url };
const setCard = s => s && { id: s.id, artist: s.artist, title: s.title, creator: s.creator, status: s.status, bpm: s.bpm,
  beatmaps: (s.beatmaps || []).filter(b => b.mode === "osu" || b.mode_int === 0).map(b => ({ id: b.id, version: b.version, difficulty_rating: b.difficulty_rating, total_length: b.total_length })) };
const ID = /^\d{1,10}$/;

async function card(q, origin, rq) {
  const code = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12).toUpperCase();
  const inv = q.get("invite");
  if (inv && /^[A-Za-z0-9]{10}$/.test(inv) && db.configured()) {
    allow(rq, "link");
    const owner = /^\d{1,12}$/.test(String(process.env.OWNER_OSU_ID || "").trim()) ? +process.env.OWNER_OSU_ID : null;
    const r = await db.rpc("obv_invite_info", { p_code: inv, p_owner_id: owner }), n = r.inviter && r.inviter.username;
    return { title: n ? `${n} invited you to KIKI BEATMAP VIEWER` : "You're invited to KIKI BEATMAP VIEWER",
      desc: r.ok ? "Preview, mod and map osu! beatmaps in your browser. Accept with your osu! account and you're in straight away." : "This invite link can't let anyone else in, but you can still ask for access.",
      image: img(origin, "default"), large: true };
  }
  if (q.get("live")) return { title: "Join my live mapping session", desc: `Live session ${code(q.get("live"))}: map and mod together in real time on KIKI BEATMAP VIEWER (osu! login).`, image: img(origin, "live"), large: true };
  if (q.get("collab")) return { title: "Join my collab", desc: `Collab ${code(q.get("collab"))}: edit one difficulty together in real time on KIKI BEATMAP VIEWER (osu! login).`, image: img(origin, "collab"), large: true };
  if (q.get("project") && /^[0-9a-f-]{36}$/.test(q.get("project")) && /^[A-Za-z0-9_-]{32}$/.test(q.get("key") || "") && db.configured()) {
    allow(rq, "link");
    const p = await db.rpc("obv_project_by_link", { p_project: q.get("project"), p_key: q.get("key") });
    const t = [p.artist, p.title].filter(Boolean).join(" - ") || "Shared beatmap project";
    return { title: clip(t, 90), desc: clip(`${p.creator ? "Mapped by " + p.creator + " · " : ""}Shared project on KIKI BEATMAP VIEWER: open it to play, mod and download, no login needed.`, 200), image: img(origin, "project"), large: true };
  }
  const u = q.get("u");
  if (u && /^[\w\-\[\] ]{1,32}$/.test(u)) {
    const name = u.trim().toLowerCase(); if (!name) return null;
    const user = await cached(rq, "u:" + name, async () => userCard(await osu.getUser(u.trim(), "og"))); if (!user) return null;
    const c = user.counts || {}, groups = (user.groups || []).map(g => g.short + (g.playmodes && g.playmodes.length ? ` (${g.playmodes.join(", ")})` : "")).join(", ");
    const parts = [groups, c.ranked ? `${c.ranked} ranked` : "", c.loved ? `${c.loved} loved` : "", c.guest ? `${c.guest} guest diffs` : "", c.pending ? `${c.pending} pending` : "",
      c.graveyard ? `${c.graveyard} graveyard` : "", user.mapping_followers ? `${user.mapping_followers} mapping followers` : ""].filter(Boolean);
    return { title: `${user.username} · osu! mapper`, desc: clip(parts.join(" · ") || "osu! mapper", 200), image: user.cover_url || user.avatar_url, thumb: user.avatar_url, large: !!user.cover_url };
  }
  let sid = q.get("s"); const bid = q.get("b");
  if (!sid && bid && ID.test(bid)) sid = await cached(rq, "b:" + +bid, () => osu.getBeatmapSetId(String(+bid), "og"));
  if (sid != null && ID.test(String(sid))) {
    sid = String(+sid);
    const s = await cached(rq, "s:" + sid, async () => setCard(await osu.getSet(sid, "og"))); if (!s) return null;
    const std = s.beatmaps || [], d = bid ? std.find(b => String(b.id) === bid) : null;
    const stars = std.map(b => b.difficulty_rating).filter(Boolean), len = Math.max(0, ...std.map(b => b.total_length || 0));
    const t = +q.get("t") > 0 ? ` at ${fmtMs(q.get("t"))}` : "";
    const title = `${s.artist} - ${s.title}` + (d ? ` [${d.version}]` : "");
    const desc = [`Mapped by ${s.creator}`, ST[s.status] || s.status, d ? `★${(+d.difficulty_rating).toFixed(2)}` : stars.length ? `★${Math.min(...stars).toFixed(1)}–${Math.max(...stars).toFixed(1)}` : "",
      s.bpm ? `${Math.round(s.bpm)} BPM` : "", len ? fmtLen(len) : "", std.length ? `${std.length} diff${std.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
    return { title: clip(title + t, 110), desc: clip((q.get("mode") === "mod" ? "Modding · " : "") + desc, 200), image: `https://assets.ppy.sh/beatmaps/${s.id}/covers/card@2x.jpg`, large: true };
  }
  return null;
}
function inject(html, c, url) {
  const tags = [
    `<meta property="og:site_name" content="KIKI BEATMAP VIEWER">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(c.title)}">`,
    `<meta property="og:description" content="${esc(c.desc)}">`,
    `<meta name="description" content="${esc(c.desc)}">`,
    `<meta property="og:image" content="${esc(c.image)}">`,
    `<meta name="twitter:card" content="${c.large ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${esc(c.title)}">`,
    `<meta name="twitter:description" content="${esc(c.desc)}">`,
    `<meta name="twitter:image" content="${esc(c.large ? c.image : c.thumb || c.image)}">`,
    `<meta name="theme-color" content="#ff66aa">`,
    `<title>${esc(c.title === "KIKI BEATMAP VIEWER" ? c.title : c.title + " · KIKI BEATMAP VIEWER")}</title>`,
  ].join("\n");
  return html.replace(/<meta name="theme-color"[^>]*>\n?/, "").replace(/<meta name="description"[^>]*>\n?/, "").replace(/<meta property="og:[^>]*>\n?/g, "").replace(/<meta name="twitter:[^>]*>\n?/g, "").replace(/<title>[^<]*<\/title>\n?/, "")
    .replace(/<meta charset="utf-8">/, m => m + "\n" + tags);
}
module.exports = async (req, res) => {
  let html = page();
  const q = query(req), origin = siteUrl(req, req.headers["x-forwarded-proto"]); // (SITE_URL, else the request's host only when it's allowed: auth.js)
  let timer;
  try {
    const c = await Promise.race([card(q, origin, { ip: clientIp(req), ok: null }), new Promise(r => { timer = setTimeout(() => r(null), 3500); })]); // never make people wait on osu! (over the limit / out of budget: no card)
    clearTimeout(timer);
    html = inject(html, c || { title: "KIKI BEATMAP VIEWER", desc: "Preview, mod and map osu! beatmaps in your browser.", image: img(origin, "default"), large: true }, origin + "/?" + q.toString());
  } catch { clearTimeout(timer); html = inject(html, { title: "KIKI BEATMAP VIEWER", desc: "Preview, mod and map osu! beatmaps in your browser.", image: img(origin, "default"), large: true }, origin + "/"); }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
  res.end(html);
};
module.exports.useTemplate = html => { TPL = html; };
module.exports.hasTemplate = () => !!TPL;
module.exports._cache = mem; // (tests)
