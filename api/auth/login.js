// GET /api/auth/login?next=/path  -> osu! authorization page (scope: identify)
const crypto = require("crypto");
const { cfg, sign, cookie, query, safeNext, redirect, json } = require("../_lib/auth");

module.exports = (req, res) => {
  const c = cfg(req);
  if (!c.secret || !c.id) return json(res, 500, { error: "OSU_CLIENT_ID / OSU_CLIENT_SECRET are not set" });
  const state = crypto.randomBytes(16).toString("hex"), next = safeNext(query(req).get("next"));
  const u = new URL("https://osu.ppy.sh/oauth/authorize");
  u.search = new URLSearchParams({ client_id: c.id, redirect_uri: c.redirect, response_type: "code", scope: "identify", state }).toString();
  redirect(res, u.toString(), cookie("obv_st", sign({ state, next, exp: Date.now() + 10 * 60 * 1000 }, c), 600));
};
