// Cloudflare Realtime TURN: short-lived credentials made on the server with the TURN key (secrets TURN_KEY_ID and
// TURN_KEY_API_TOKEN, from Cloudflare → Realtime → TURN). The key never reaches the browser, only the credentials.
// Usage (for Admin → TURN relay and the monthly limit) comes from Cloudflare's GraphQL Analytics API with a separate
// read-only token: CF_ANALYTICS_TOKEN (Account Analytics: Read) and CF_ACCOUNT_ID.
function conf() {
  const id = String(process.env.TURN_KEY_ID || "").trim(), token = String(process.env.TURN_KEY_API_TOKEN || "").trim();
  return { id, token, ok: /^[A-Za-z0-9]{8,64}$/.test(id) && token.length > 10 };
}
const configured = () => conf().ok;
function aconf() {
  const token = String(process.env.CF_ANALYTICS_TOKEN || "").trim(), account = String(process.env.CF_ACCOUNT_ID || "").trim().toLowerCase();
  return { token, account, ok: token.length > 10 && /^[0-9a-f]{32}$/.test(account) };
}
const analyticsConfigured = () => aconf().ok;

async function post(url, headers, body, ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { method: "POST", signal: ctl.signal, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  finally { clearTimeout(t); }
}

// -> iceServers (STUN + TURN) valid for ttlSec, or [] when not configured or Cloudflare doesn't answer.
// ident tags the credentials (an osu! id, or "guest") so the usage can be split per person.
async function iceServers(ttlSec, ident) {
  const c = conf(); if (!c.ok) return [];
  const base = process.env.TURN_API_BASE || "https://rtc.live.cloudflare.com"; // (a stand-in in local tests)
  const url = `${base}/v1/turn/keys/${c.id}/credentials/generate-ice-servers`, auth = { Authorization: "Bearer " + c.token };
  const ttl = Math.max(300, Math.min(48 * 3600, Math.round(ttlSec)));
  try {
    let r = await post(url, auth, ident ? { ttl, customIdentifier: String(ident).slice(0, 64) } : { ttl }, 6000);
    if (r.status === 400 && ident) r = await post(url, auth, { ttl }, 6000); // (without the tag, should Cloudflare refuse it)
    if (!r.ok) { console.error("turn", r.status); return []; }
    const j = await r.json(), list = [].concat(j && j.iceServers || []);
    // port 53 is blocked by browsers (the URL would only time out)
    return list.map(s => ({ ...s, urls: [].concat(s.urls || []).filter(u => typeof u === "string" && !/:53(\?|$)/.test(u)) })).filter(s => s.urls.length);
  } catch (e) { console.error("turn", e && e.name); return []; }
}

async function gql(query, variables) {
  const a = aconf(), base = process.env.CF_API_BASE || "https://api.cloudflare.com";
  const r = await post(`${base}/client/v4/graphql`, { Authorization: "Bearer " + a.token }, { query, variables: { account: a.account, ...variables } }, 8000);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || (j.errors && j.errors.length)) throw new Error((j && j.errors && j.errors[0] && j.errors[0].message) || "HTTP " + r.status);
  const acc = j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0];
  return (acc && acc.g) || [];
}
const Q = (fields, extra) => `query($account: string!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $account }) {
  g: callsTurnUsageAdaptiveGroups(filter: { datetimeMinute_geq: $from, datetimeMinute_lt: $to }, ${extra}) { ${fields} sum { egressBytes } } } } }`;
// this month's (UTC) relay traffic: total, per day and the biggest users. Numbers are sampled by Cloudflare (close,
// not exact) and a few minutes behind. Days and people are best effort: the total alone is enough for the limit.
async function usage(now = new Date()) {
  if (!analyticsConfigured()) return null;
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to = new Date(now.getTime() + 60000);
  const v = { from: from.toISOString(), to: to.toISOString() };
  const total = await gql(Q("", "limit: 1"), v);
  const out = { from: v.from, to: v.to, bytes: total.reduce((n, g) => n + (+(g.sum && g.sum.egressBytes) || 0), 0), days: null, people: null };
  try {
    const hours = await gql(Q("dimensions { datetimeHour }", "limit: 1000, orderBy: [datetimeHour_ASC]"), v), days = new Map();
    for (const g of hours) { const d = String(g.dimensions && g.dimensions.datetimeHour || "").slice(0, 10); if (d) days.set(d, (days.get(d) || 0) + (+g.sum.egressBytes || 0)); }
    out.days = [...days].map(([day, bytes]) => ({ day, bytes }));
  } catch (e) { console.error("turn usage days", e.message); }
  try {
    const ppl = await gql(Q("dimensions { customIdentifier }", "limit: 20, orderBy: [sum_egressBytes_DESC]"), v);
    out.people = ppl.map(g => ({ ident: String(g.dimensions && g.dimensions.customIdentifier || ""), bytes: +g.sum.egressBytes || 0 })).filter(p => p.bytes > 0);
  } catch (e) { console.error("turn usage people", e.message); }
  return out;
}
// the same, kept 5 minutes (per server instance), so live sessions don't ask Cloudflare every time
let cached = { at: 0, v: null, err: null };
async function usageCached(fresh) {
  if (!fresh && Date.now() - cached.at < 300000) { if (cached.err) throw cached.err; return cached.v; }
  try { cached = { at: Date.now(), v: await usage(), err: null }; }
  catch (e) { cached = { at: Date.now() - 240000, v: null, err: e }; throw e; } // try again in a minute
  return cached.v;
}

module.exports = { configured, analyticsConfigured, iceServers, usage, usageCached };
