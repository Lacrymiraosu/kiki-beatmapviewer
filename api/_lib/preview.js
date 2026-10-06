// Preview deployments fail closed: no database, no login, no secrets. Cloudflare Worker Previews (one per Git branch,
// "<branch>-osu-beatmap-viewer.<account>.workers.dev", wrangler.jsonc "previews") and Vercel preview deployments run
// whatever code a branch pushes, and may be given the same secrets as production (dashboard settings). So unless a preview
// is explicitly given its own backend (PREVIEW_BACKEND=1, meant with a separate, non-production Supabase project set up
// for previews), worker.js answers every /api/* with 503 { error: "preview_backend_disabled" } and serves the plain page,
// without running any api/** code (and without touching process.env, which a Worker instance shares with every request
// it serves, production's included). On a Vercel preview deployment (its own deployment) the secrets below are removed
// from process.env when db.js / auth.js load, so a buggy code path can't reach them. The static site (the UI being
// reviewed) works as usual.
// Not a defence against a malicious branch, which can change this file: only the secrets a preview is given can be.

// production on workers.dev is exactly "<worker>.<account>.workers.dev" (the worker named in wrangler.jsonc:
// "kiki-beatmap-viewer" as in wrangler.example.jsonc, or "osu-beatmap-viewer"), or the host of SITE_URL; any other
// workers.dev host that reaches this Worker is a preview (a branch or a version), look-alikes included. A Worker with
// another name: set SITE_URL to its address (or change this pattern).
const PROD_WORKERS_DEV = /^(?:kiki|osu)-beatmap-viewer\.[a-z0-9-]+\.workers\.dev$/;
const yes = v => /^(1|true|yes|on)$/i.test(String(v == null ? "" : v).trim());
function siteHost(env) { try { return new URL(String(env.SITE_URL || "").trim()).hostname.toLowerCase(); } catch { return ""; } }
function previewHost(host, env = {}) {
  const h = String(host || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return /\.workers\.dev$/.test(h) && !PROD_WORKERS_DEV.test(h) && h !== siteHost(env);
}
// env: the Worker's env (OBV_PREVIEW: a variable wrangler.jsonc sets for previews only) or process.env (Vercel)
const isPreview = (host, env = {}) => yes(env.OBV_PREVIEW) || env.VERCEL_ENV === "preview" || previewHost(host, env);
const backendAllowed = (env = {}) => String(env.PREVIEW_BACKEND || "").trim() === "1";

// what a preview never gets: database and storage keys, osu!/Google OAuth secrets, session/cron secrets, the owner's
// identity, TURN and Cloudflare analytics tokens; plus anything that looks like a secret
const SENSITIVE = /^(SUPABASE_\w*|OSU_CLIENT_\w*|GOOGLE_\w*|SESSION_\w*|CRON_SECRET|OWNER_OSU_ID|TURN_\w*|CF_ANALYTICS_TOKEN|CF_ACCOUNT_ID|DB_BACKEND)$|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|_KEY$|_KEY_|API_KEY/i;
const sensitive = k => SENSITIVE.test(k);
function scrub(target) { for (const k of Object.keys(target)) if (sensitive(k)) delete target[k]; return target; }
const ERROR = "preview_backend_disabled";

// Vercel preview deployments: every function loads db.js or auth.js (both load this first), so the secrets go before any
// handler runs. Never on Cloudflare Workers, where process.env is shared by the instance (worker.js locks previews itself)
const ON_WORKERS = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
if (!ON_WORKERS && typeof process !== "undefined" && process.env && process.env.VERCEL_ENV === "preview" && !backendAllowed(process.env)) scrub(process.env);

module.exports = { isPreview, previewHost, backendAllowed, scrub, sensitive, ERROR };
