// GET /api/auth/logout?next=/path -> clears the session cookie
const { cookie, query, safeNext, redirect } = require("../_lib/auth");

module.exports = (req, res) => redirect(res, safeNext(query(req).get("next")), cookie("obv_s", "", 0));
