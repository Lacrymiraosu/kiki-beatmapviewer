// Backup login with Google, for osu! accounts that linked one (Account → Backup logins). The osu! account stays the
// account: logging in with a Google account signs you in as the osu! account it's linked to.
// GET /api/auth/google?mode=login|link&next=/path  -> Google's sign-in page
// GET /api/auth/google?code=&state=                 <- Google sends the person back here
// Env (server only, never printed):
//   Google: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (Google Cloud → APIs & Services → Credentials → OAuth client, type
//           "Web application", redirect URI https://<site>/api/auth/google)
// Only the account's ID at Google ("sub") is used: no name, no e-mail (only "openid" is asked for).
const crypto = require("crypto");
const { cfg, sign, unsign, cookies, cookie, query, safeNext, redirect, withParam } = require("./auth");
const db = require("./db");

const env = k => String(process.env[k] || "").trim();
const PROVIDERS = {
  google: {
    ok: () => !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET")),
    authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"], clientId: () => env("GOOGLE_CLIENT_ID"),
    extra: { scope: "openid", prompt: "select_account" },
    secret: async () => env("GOOGLE_CLIENT_SECRET"),
  },
};
const configured = () => ({ google: PROVIDERS.google.ok() });

const redirectUri = (req, p) => `https://${req.headers["x-forwarded-host"] || req.headers.host}/api/auth/${p}`;
// the id_token comes straight from the provider's token endpoint over HTTPS (with our secret), so its claims are read
// without checking its signature (as Google allows for this flow); who it's for, who made it, when and the
// nonce are still checked
function claims(idToken, P, nonce) {
  let c = null; try { c = JSON.parse(Buffer.from(String(idToken).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()); } catch {}
  if (!c || !c.sub) return null;
  const aud = [].concat(c.aud || []);
  if (!aud.includes(P.clientId()) || !P.issuers.includes(c.iss) || !(c.exp * 1000 > Date.now() - 60000) || c.nonce !== nonce) return null;
  return c;
}

// a 30-day session for the osu! account a Google account is linked to (unverified: asked for with Google, not yet
// confirmed by an osu! login)
// A Google account linked to nobody has its own account (id from 10^12, no osu!): gonly in the session
const GONLY = 1e12;
function altSession(c, p, u) {
  const gonly = +u.id >= GONLY;
  const user = { id: u.id, username: u.username, avatar: gonly ? "" : u.avatar || `https://a.ppy.sh/${u.id}`, country: u.country || "" };
  return sign({ ...user, kind: "session", via: p, ...(gonly ? { gonly: true } : {}), ...(u.verified === false ? { unverified: true } : {}), iat: Date.now(), exp: Date.now() + 30 * 864e5 }, c);
}
// one handler per provider (api/auth/google.js)
const handler = p => async (req, res) => {
  const P = PROVIDERS[p], c = cfg(req), q = query(req);
  if (!q.get("code") && !q.get("error")) { // start
    const next = safeNext(q.get("next")), mode = q.get("mode") === "link" ? "link" : "login";
    if (!c.secret || !P.ok()) return redirect(res, withParam(next, "login", "alt_off"));
    const st = { p, mode, next, state: crypto.randomBytes(16).toString("hex"), nonce: crypto.randomBytes(16).toString("hex"), exp: Date.now() + 10 * 60000 };
    if (mode === "link") { const s = unsign(cookies(req).obv_s, c); if (!s || s.kind !== "session" || !(s.id > 0)) return redirect(res, withParam(next, "login", "link_login")); st.uid = s.id; }
    const u = new URL(P.authorize);
    u.search = new URLSearchParams({ client_id: P.clientId(), redirect_uri: redirectUri(req, p), response_type: "code", state: st.state, nonce: st.nonce, ...P.extra }).toString();
    return redirect(res, u.toString(), cookie("obv_alt", sign(st, c), 600));
  }
  // back from the provider
  const st = unsign(cookies(req).obv_alt, c), next = st && st.next || "/", clear = cookie("obv_alt", "", 0);
  const done = (why, extra) => redirect(res, withParam(next, "login", why), [clear, ...(extra || [])]);
  if (q.get("error")) return done(/access_denied/.test(q.get("error")) ? "cancelled" : "alt_error");
  if (!st || st.p !== p || q.get("state") !== st.state) return done("expired");
  try {
    const tr = await fetch(P.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: P.clientId(), client_secret: await P.secret(), code: q.get("code"), grant_type: "authorization_code", redirect_uri: redirectUri(req, p) }) });
    const tj = await tr.json().catch(() => null);
    if (!tr.ok || !tj || !tj.id_token) { console.error(p + " token", tr.status, tj && tj.error || ""); return done("alt_error"); }
    const id = claims(tj.id_token, P, st.nonce); if (!id) { console.error(p + " id_token rejected"); return done("alt_error"); }
    if (st.mode === "link") {
      const s = unsign(cookies(req).obv_s, c);
      if (!s || s.kind !== "session" || s.id !== st.uid) return done("link_login");
      await db.rpc("obv_user_touch", { p_id: s.id, p_username: String(s.username || "").slice(0, 64), p_avatar: s.avatar || null, p_country: s.country || null });
      try { await db.rpc("obv_login_link", { p_user: s.id, p_provider: p, p_subject: String(id.sub).slice(0, 255) }); }
      catch (e) { if (e.code === "conflict") return done("linked_elsewhere"); throw e; }
      return done("linked_" + p);
    }
    // linked to an osu! account: that one; else its own account (made now, the first time), without osu!. It follows the
    // site's rules like everyone (invite-only: an invite or an approved request); live sessions ask for an osu! login.
    let u = await db.rpc("obv_login_find", { p_provider: p, p_subject: String(id.sub).slice(0, 255) });
    if (!u || !u.id) u = await db.rpc("obv_google_account", { p_sub: String(id.sub).slice(0, 255) });
    if (!u || !u.id) return done("alt_error");
    return done("ok", [cookie("obv_s", altSession(c, p, u), 30 * 86400), cookie("obv_gp", "", 0)]);
  } catch (e) {
    console.error(p + " login", e && (e.code || e.message || e.name));
    return done(e && e.code === "not_configured" ? "alt_off" : "network");
  }
};

module.exports = { handler, configured, PROVIDERS, altSession, GONLY };
