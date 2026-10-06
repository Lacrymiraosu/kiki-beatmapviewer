// POST /api/auth/logout (JSON, from this site) -> clears the session cookie; the page then navigates by itself.
// A GET changes nothing (a link or <img> on another site mustn't be able to log people out): it just goes to "/".
const { cookie, redirect, json, sameOrigin } = require("../_lib/auth");

module.exports = (req, res) => {
  if (req.method === "GET" || req.method === "HEAD") return redirect(res, "/");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, 405, { error: "method_not_allowed" }); }
  if (!sameOrigin(req)) return json(res, 403, { error: "bad_origin" });
  res.setHeader("Set-Cookie", cookie("obv_s", "", 0));
  return json(res, 200, { ok: true });
};
