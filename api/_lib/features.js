// Feature switches: the admin can turn any of these off for everyone at once (Admin → Features), e.g. when a menu has a
// serious bug. One list for every layer: the settings are `feat_<key>` (bool, default on) in obv.setting_spec()
// (the newest supabase migration that defines it: 20261010090000_obv_replays.sql now) and in api/_lib/d1.js SPEC (built from this list), the client
// has the same keys with labels in js/features.js. tests/features.test.mjs fails if they drift apart.
// Keys: a-z 0-9 _ only. "compose" (the editor's fallback tab) is deliberately not here, nor is anything in the admin area.
const FEATURE_KEYS = [
  // the site
  "songs", "preview", "mappers", "editor", "create", "projects", "live", "collab", "drive", "replays",
  // inside the editor
  "ed_timing", "ed_hitsounds", "ed_verify", "ed_setup", "ed_notes", "ed_compare", "ed_test", "ed_auto", "ed_adv", "ed_tools", "ed_share", "ed_annot",
];
const FEAT_RE = /^[a-z0-9_]{1,32}$/;
// the server-backed features: a route that needs one is refused with 503 feature_disabled while it is off (the rest of the
// switches are the page's own menus: the server can't see them, so for those this is bug containment, not security).
// -> the features that serve the route (it is refused only when every one of them is off: map lookups also serve the player), or null
function routeFeature(key) {
  if (/^(projects|saves)(\/|$)/.test(key) || key === "link/:id") return ["projects"];
  if (key === "live/ticket") return ["live", "collab"]; // (collab asks for its identity tickets here too)
  if (key.startsWith("live/")) return ["live"];
  if (key.startsWith("collab/")) return ["collab"];
  if (/^replays(\/|$)/.test(key)) return ["replays"]; // (the replay watcher: "replays" and "replays/:id")
  if (key === "osu/scores" || key === "osu/replay") return ["replays"]; // (the top 50 scores of a replay's map)
  if (key === "osu/search") return ["songs"];
  if (/^osu\/(beatmap|lookup|set|tags)$/.test(key)) return ["songs", "preview"];
  if (/^osu\/(user|beatmaps|activity)$/.test(key)) return ["mappers", "songs"];
  return null;
}
module.exports = { FEATURE_KEYS, FEAT_RE, routeFeature };
