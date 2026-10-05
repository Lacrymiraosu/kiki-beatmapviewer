// POST /api/auth/verify { ticket, aud } -> { ok, user }  (a live-session host checks who a visitor really is, and whether
// they're a member of the site or a guest who may only watch)
const { cfg, unsign, json } = require("../_lib/auth");
const db = require("../_lib/db");
// "admin" | "member" | "guest" (approved or not, for an invite-only site: guests only watch), null when unknown
async function accessOf(id) {
  const o = String(process.env.OWNER_OSU_ID || "").trim();
  if (/^\d{1,12}$/.test(o) && +o === +id) return "admin";
  if (!db.configured()) return null;
  try { const a = await db.rpc("obv_access_of", { p_id: +id }); return a.status !== "active" ? "guest" : a.role === "admin" ? "admin" : a.access === "approved" ? "member" : "guest"; }
  catch { return null; }
}

async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = ""; for await (const ch of req) { raw += ch; if (raw.length > 8192) break; }
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}
module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { ok: false });
  const c = cfg(req); if (!c.secret) return json(res, 200, { ok: false });
  // a ticket only counts for the audience it was made for (this session, or this person in it): one passed on to
  // someone (a host's ticket to its guests, a guest's to the host) can't be shown anywhere else
  const b = await body(req), t = unsign(b.ticket, c);
  if (!t || t.kind !== "ticket" || typeof b.aud !== "string" || !t.aud || t.aud !== b.aud) return json(res, 200, { ok: false });
  json(res, 200, { ok: true, user: { id: t.id, username: t.username, avatar: t.avatar, country: t.country, access: await accessOf(t.id) } });
};
