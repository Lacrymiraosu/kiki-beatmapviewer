[← Documentation](README.md) · [Project README](../README.md)

# Deploying

The site is static files plus Node.js serverless functions in `api/`. Any host that supports an `api/` functions folder in this layout works, e.g. Vercel.

## Vercel dashboard

1. Import this repository as a new project
2. Framework Preset: **Other** · Build Command, Output Directory and Install Command: leave empty
3. Add the [environment variables](environment-variables.md) for **Production**
4. Deploy; the functions in `api/` are picked up automatically

## Vercel CLI

```bash
npx vercel link
```

```bash
npx vercel env add OSU_CLIENT_ID production
```

```bash
npx vercel env add OSU_CLIENT_SECRET production --sensitive
```

Add the others from [Environment variables](environment-variables.md) the same way (`--sensitive` for secrets), then:

```bash
npx vercel deploy --prod
```

## Cloudflare Workers

The site also runs on Cloudflare Workers (`worker.js`). For your own deploy, copy `wrangler.example.jsonc` to `wrangler.jsonc` and put your own Worker name, R2 bucket and D1 database ID in it, set the secrets listed at the top of that file with `npx wrangler secret put NAME`, then `npx wrangler deploy`. Never commit a secret.

## Preview deployments

Cloudflare Worker Previews (`wrangler.jsonc` `previews`: one per Git branch, `<branch>-kiki-beatmap-viewer.<account>.workers.dev`) and Vercel preview deployments (`VERCEL_ENV=preview`) run a branch's unreviewed code, and may be given the same secrets as production. So previews fail closed:

- On Cloudflare, any `workers.dev` host other than the production Worker's (`kiki-beatmap-viewer.<account>.workers.dev`, or the host of `SITE_URL`), or `OBV_PREVIEW=1` (set for previews in `wrangler.example.jsonc`), is a preview. Every `/api/*` answers `503 {"error":"preview_backend_disabled"}`, `/` is the plain page, and cron does nothing. No API code runs there.
- On Vercel, the secrets are removed from every function's environment before it runs, so login, online features and TURN are off.
- `PREVIEW_BACKEND=1` turns the API back on for previews. Set it only together with a separate, non-production Supabase project (and its own osu! app and `SESSION_SECRET`), never with production's secrets, and never on production.
- The guard can't stop a malicious branch, which can change the code. In the Cloudflare dashboard, check which secrets and variables previews receive (production's must not reach them; on Vercel, don't give "Preview" the production values), and keep preview URLs behind Cloudflare Access / Vercel Deployment Protection.

## Rotating the session key

Without `SESSION_SECRET`, logins are signed with a key derived from `OSU_CLIENT_SECRET`, which osu! and every environment that has it also know. To move to a key only this site has, without logging anybody out:

1. Run the session migration (`supabase/migrations/20261008110000_obv_session_revoke.sql`, or `d1/migrations/0004_session_revoke.sql` on D1) and deploy this version.
2. `wrangler secret put SESSION_SECRET` (a new random value, different per environment; never reuse `OSU_CLIENT_SECRET`). New logins use the new key; existing ones keep working and are signed again with it on their next visit. File links (≤ 2 h) and live-session relay tokens (≤ 3 h) made before simply expire.
3. After a while (logins last 30 days; a week or two covers active users), `wrangler secret put SESSION_LEGACY_OK` with `0`: logins still signed with the old key stop working. Then reset the osu! app's Client Secret if it may have leaked.

To change `SESSION_SECRET` itself later, replace it: everybody is logged out once.

## After deploying

- `https://<your-domain>/api/auth/me` should return `{"user":null,"ticket":null}` (`"configured":false` means `OSU_CLIENT_ID` or `OSU_CLIENT_SECRET` isn't set)
- The Callback URL of the osu! OAuth app must match the real domain
- If browsers still get old CSS/JS, you forgot to bump `?v=N` (see [Rules when changing the code](development.md#rules-when-changing-the-code))
