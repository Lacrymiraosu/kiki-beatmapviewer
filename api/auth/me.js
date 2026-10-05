// GET /api/auth/me -> { user, ticket } (user = null when logged out)
// ticket: true when this login may prove who it is to other people in live sessions and collabs (each proof is a
// short ticket for one audience, from POST /api/v1/live/ticket), null when it may not (Google only, unverified).
const { cfg, unsign, cookies, json } = require("../_lib/auth");

module.exports = (req, res) => {
  const c = cfg(req);
  if (!c.secret || !c.id) return json(res, 200, { user: null, ticket: null, configured: false });
  const s = unsign(cookies(req).obv_s, c);
  if (!s || s.kind !== "session") return json(res, 200, { user: null, ticket: null });
  const user = { id: s.id, username: s.username, avatar: s.avatar, country: s.country };
  // signed in with Google only (no osu!), or with Google for an osu! name that account hasn't confirmed yet: no ticket
  // (a ticket proves who you are to other people in live sessions), live sessions ask for an osu! login
  if (s.gonly) return json(res, 200, { user: { ...user, google_only: true }, ticket: null });
  if (s.unverified) return json(res, 200, { user: { ...user, unverified: true }, ticket: null });
  json(res, 200, { user, ticket: true });
};
