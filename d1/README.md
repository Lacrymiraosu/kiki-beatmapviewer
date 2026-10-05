# D1 schema

The site's database on Cloudflare D1 (SQLite): the same tables as the Supabase schema (`obv.*`), used by the server
functions in `api/_lib/d1*.js`. Times are ISO 8601 text in UTC, JSON is text, true / false are 1 / 0.

- `migrations/0001_init.sql`: the tables, indexes, the trigger that keeps a project's dates fixed (only an admin's expiry
  change, which bumps `expiry_v`, may move `expires_at`) and the starting settings. No comments, and the trigger written in
  capitals on several lines, so the statement splitters of the D1 API and wrangler read it. The dashboard console runs
  only the first statement of a paste.
- `migrations/0002_changelog_seed.sql`: the first changelog entry for a new empty site. Not needed when the data is
  copied from Supabase (Admin → Settings → Database).

From the command line: `npx wrangler d1 migrations apply osu-beatmap-viewer-db --remote`
