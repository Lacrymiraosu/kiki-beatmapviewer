[← Documentation](README.md) · [Project README](../README.md)

# Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `OSU_CLIENT_ID` | ✅ (for login) | – | Client ID of the osu! OAuth app |
| `OSU_CLIENT_SECRET` | ✅ (for login) | – | Client Secret of the osu! OAuth app; exchanges codes and signs cookies |
| `OSU_REDIRECT_URI` | – | `https://<host>/api/auth/callback` | Fixed callback URL (useful with several domains) |
| `SUPABASE_URL` | for online features | – | `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | for online features | – | Supabase secret key (`sb_secret_…`) or legacy `service_role` key (`SUPABASE_SERVICE_ROLE_KEY` is also read) |
| `OWNER_OSU_ID` | for admin | – | Numeric osu! user id of the site owner |
| `CRON_SECRET` | for cleanup | – | Random string; the daily `/api/cron` call must carry it |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | – | – | Cloudflare Realtime TURN key (relay for live sessions and collab) |
| `CF_ANALYTICS_TOKEN` / `CF_ACCOUNT_ID` | – | – | Cloudflare API token with Account Analytics: Read, and the account id: TURN usage in Admin → TURN relay and the monthly limit |
| `TURN_URLS` | – | – | Comma-separated `turn:` / `turns:` URLs for collab (when there's no Cloudflare TURN key) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | – | – | Fixed TURN login |
| `TURN_SECRET` | – | – | coturn shared secret (short-lived credentials instead of a fixed login) |

[`.env.example`](../.env.example) lists them all. Without the osu! pair the site still works, but without the login; without the Supabase pair the online features are off.
