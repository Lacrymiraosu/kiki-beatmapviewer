[← Documentation](README.md) · [Project README](../README.md)

# Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `OSU_CLIENT_ID` | ✅ (for login) | – | Client ID of the osu! OAuth app |
| `OSU_CLIENT_SECRET` | ✅ (for login) | – | Client Secret of the osu! OAuth app; exchanges codes, and signs cookies while `SESSION_SECRET` isn't set |
| `SESSION_SECRET` | recommended | – | A secret only this site has (`wrangler secret put SESSION_SECRET`, at least 32 random bytes, e.g. `openssl rand -base64 48`; a different one per environment). Signs logins, file links and live-session tokens with separate keys. See [Rotating the session key](deploying.md#rotating-the-session-key) |
| `SESSION_LEGACY_OK` | – | on | While `SESSION_SECRET` is set and this isn't `0`, logins signed with the old `OSU_CLIENT_SECRET` key still work (and are signed again with the new key on the next visit) |
| `OSU_REDIRECT_URI` | – | `<site>/api/auth/callback` | Fixed callback URL (useful with several domains) |
| `SITE_URL` | – | – | The site's address (`https://…`); when set, OAuth redirect URIs and preview cards always use it. Also set it when the Worker isn't named `kiki-beatmap-viewer` (or `osu-beatmap-viewer`) and runs on `workers.dev` |
| `ALLOWED_HOSTS` | – | – | Comma-separated hostnames the site is served on. Without `SITE_URL`, a request's host is only used for those URLs when it's listed here, localhost, or a `workers.dev` / `vercel.app` deployment of this project |
| `SUPABASE_URL` | for online features | – | `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | for online features | – | Supabase secret key (`sb_secret_…`) or legacy `service_role` key (`SUPABASE_SERVICE_ROLE_KEY` is also read) |
| `OWNER_OSU_ID` | for admin | – | Numeric osu! user id of the site owner |
| `CRON_SECRET` | for cleanup | – | Random string; the daily `/api/cron` call must carry it |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | – | – | Cloudflare Realtime TURN key (relay for live sessions and collab) |
| `CF_ANALYTICS_TOKEN` / `CF_ACCOUNT_ID` | – | – | Cloudflare API token with Account Analytics: Read, and the account id: TURN usage in Admin → TURN relay and the monthly limit |
| `TURN_CAP_DISABLED` | – | – | `1` lets the TURN relay run without a working monthly limit (no `CF_ANALYTICS_TOKEN`, or a limit of 0 = no limit). Unset (the default): no checkable limit means no relay |
| `TURN_URLS` | – | – | Comma-separated `turn:` / `turns:` URLs for collab (when there's no Cloudflare TURN key) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | – | Fixed TURN login |
| `TURN_SECRET` | – | – | coturn shared secret (short-lived credentials instead of a fixed login) |
| `PREVIEW_BACKEND` | – | – | `1` lets preview deployments use the API (off by default: see [Preview deployments](deploying.md#preview-deployments)); only with a separate, non-production backend |

[`.env.example`](../.env.example) lists them all. Without the osu! pair the site still works, but without the login; without the Supabase pair the online features are off.
