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

## After deploying

- `https://<your-domain>/api/auth/me` should return `{"user":null,"ticket":null}` (`"configured":false` means `OSU_CLIENT_ID` or `OSU_CLIENT_SECRET` isn't set)
- The Callback URL of the osu! OAuth app must match the real domain
- If browsers still get old CSS/JS, you forgot to bump `?v=N` (see [Rules when changing the code](development.md#rules-when-changing-the-code))
