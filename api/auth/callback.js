// GET /api/auth/callback?code=&state=  (osu! sends the user back here)
// Swaps the code for a token, reads /me once, then forgets the token and sets a signed session cookie.
const { cfg, sign, unsign, cookies, cookie, query, safeNext, redirect, withParam } = require("../_lib/auth");
const crypto = require("crypto");
const db = require("../_lib/db");

module.exports = async (req, res) => {
  const c = cfg(req), q = query(req), st = unsign(cookies(req).obv_st, c);
  const next = safeNext(st && st.next), clear = cookie("obv_st", "", 0); // (checked again on the way back too)
  const fail = why => redirect(res, withParam(next, "login", why), clear);
  if (!c.secret || !c.id) return fail("not_configured");
  if (q.get("error")) return fail(q.get("error") === "access_denied" ? "cancelled" : "error");
  if (!st || !q.get("state") || q.get("state") !== st.state) return fail("expired");
  try {
    const tr = await fetch("https://osu.ppy.sh/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: +c.id, client_secret: c.secret, code: q.get("code"), grant_type: "authorization_code", redirect_uri: c.redirect }),
    });
    if (!tr.ok) {
      // osu! says why: invalid_client = the app's ID / secret (OSU_CLIENT_ID, OSU_CLIENT_SECRET) don't match the osu!
      // OAuth app; invalid_grant = the code was already used or expired, or the callback URL differs from the one the
      // login started with (OSU_REDIRECT_URI vs the app's Application Callback URL). Logged for the Worker's logs.
      const j = await tr.json().catch(() => null), err = j && typeof j.error === "string" ? j.error : "";
      console.error("osu! token", tr.status, err, j && (j.hint || j.error_description || j.message) || "", "redirect_uri=" + c.redirect);
      return fail(err === "invalid_client" ? "bad_key" : err === "invalid_grant" ? "bad_code" : tr.status === 429 ? "busy" : "token_" + tr.status);
    }
    const tok = await tr.json();
    const mr = await fetch("https://osu.ppy.sh/api/v2/me", { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" } });
    if (!mr.ok) { console.error("osu! /me", mr.status); return fail("profile"); }
    const me = await mr.json();
    const user = { id: me.id, username: me.username, avatar: me.avatar_url || `https://a.ppy.sh/${me.id}`, country: me.country_code || "" };
    // sid: this login's own random id, which the "move your Google-only account here?" note below is bound to
    const days = 30, sid = crypto.randomBytes(12).toString("hex"), session = sign({ ...user, kind: "session", sid, iat: Date.now(), exp: Date.now() + days * 864e5 }, c);
    // a Google account that asked for access for this osu! account in this browser is now confirmed; an unconfirmed one
    // from anywhere else is removed (someone may have typed this person's osu! name)
    const gl = unsign(cookies(req).obv_gl, c), mine = gl && gl.kind === "glink" && +gl.osu === +me.id ? gl.sub : null, extra = [];
    if (db.configured()) { try { await db.rpc("obv_osu_login", { p_id: me.id, p_google_sub: mine }); if (mine) extra.push(...cookie("obv_gl", "", 0)); } catch {} }
    // logged in with Google only (no osu!) in this browser until now: that account and what it has can move to this osu!
    // one (and its Google login then opens this account), but only once this person says so: the page asks, and
    // POST /api/v1/me/merge-google does it. Nothing moves here: that Google-only login may have been left by someone else
    // (a shared computer) or set by another site. The note lasts 10 minutes and only counts for this login (sid).
    const was = unsign(cookies(req).obv_s, c), gm = was && was.kind === "session" && was.gonly && +was.id >= 1e12 && db.configured()
      ? cookie("obv_gm", sign({ kind: "gmerge", from: +was.id, to: me.id, sid, exp: Date.now() + 10 * 60000 }, c), 600) : cookie("obv_gm", "", 0);
    redirect(res, withParam(next, "login", "ok"), [...clear, ...cookie("obv_s", session, days * 86400), ...gm, ...extra]);
  } catch (e) {
    console.error("osu! login", e && (e.message || e.name));
    fail("network");
  }
};
