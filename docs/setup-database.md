[← Documentation](README.md) · [Project README](../README.md)

# Setting up the database (Supabase)

Only needed for the online features. Everything runs through the server functions; the browser never talks to the database.

1. Create a Supabase project (the Free plan is enough; its Storage is 1 GB, and the app refuses new uploads above 900 MB, see `storage_budget_bytes` below).
2. Run the migrations **once, in filename order**, in the SQL Editor (paste each file and run) or with the Supabase CLI:
   ```bash
   npx supabase link --project-ref <your-project-ref>
   ```
   ```bash
   npx supabase db push
   ```
   - `20260930120000_obv_init.sql`: schema `obv` (not exposed to the Data API), tables with RLS, the `public.obv_*` functions (only `service_role` may call them) and the private Storage bucket `obv-projects`
   - `20260930120100_obv_changelog_seed.sql`: the old changelog entries, plus the newest one as a **draft** to review and publish from the admin dashboard
   - `20260930130000_obv_changelog_first_release.sql`: replaces those entries with one published **v1.0 First release** entry listing what the site can do
   - `20260930140000_obv_admin_v2.sql`: limits editable from the admin dashboard (site-wide and per user), admin accounts, changing one project's expiry, pausing online saving, and share links for projects
   - `20260930150000_obv_access.sql`: invite-only access: people log in with osu! and ask for access, admins approve or deny (Admin → Access); a switch in Admin → Settings turns it off. Until it has run the site stays open. Existing admins and anyone who owns or shares a project keep access.
   - `20260930160000_obv_invites.sql`: invite links: everyone with access has one that lets people in at once, up to Admin → Settings → "Invites per person" (or a person's own number); people who came in with an invite can invite once an admin allows it (their panel, or the Access tab).
   - `20260930170000_obv_invites_global.sql`: a site-wide switch for whether people who came in with an invite can invite (a person's own choice still wins), "Use the site settings for everyone", and admins' invite links with their own number of people.
   - `20260930180000_obv_invite_fx.sql`: each person turns the animated invitation on or off for their links (Invite friends page). Until it has run, every link opens with the animation.
   - `20260930190000_obv_invite_fx_off.sql`: the animated invitation is off by default (everyone starts with it off; turn it on per person).
   - `20261001100000_obv_invite_fx_perm.sql`: only people an admin allows (their panel → "Can use the animated invitation"), plus admins and the owner, can turn the animated invitation on.
3. Project Settings → API Keys: copy the project URL and a **secret key** (`sb_secret_…`, or the legacy `service_role` key). Put them in `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Never put the secret key in the code or the browser.
4. Set `OWNER_OSU_ID` to the site owner's **numeric** osu! user id (the number in `osu.ppy.sh/users/<id>`). That account gets the admin dashboard. Names are never used for this.
5. Set `CRON_SECRET` to a long random string. Vercel sends it to `/api/cron`, which runs daily at 03:00 UTC (`vercel.json`) and deletes expired projects and abandoned uploads. Missing a day is fine; the next run catches up.

Limits are changed from the admin dashboard (**Settings**; stored in `obv.settings`), no SQL needed. Defaults:

- 30 MB per project (all files together); projects are deleted 15 days after they were first saved online (saving again doesn't extend it)
- 10 online projects per user, 20 people per project, 2,000 annotations per project
- Storage budget 900 MB: new uploads are refused above this total
- A user's panel can override the size, days and project count for that one person; an admin can move one project's expiry (up to a year ahead)
- Supabase's own per-file upload limit still applies (Free plan: 50 MB). Raising the project size above it also needs Supabase → Storage → Settings

**Admins:** the account in `OWNER_OSU_ID` is the owner. On the dashboard's **Admins** tab the owner adds admins by osu! name. Admins can see accounts and projects, change per-user limits, suspend normal users, delete projects, change expiry dates, run the cleanup and edit the changelog; only the owner changes site-wide settings, adds or removes admins, or suspends an admin. Every admin action is in the audit log.

Check it works: `https://<your-domain>/api/v1/changelog` should return the published entries. `503 not_configured` means `SUPABASE_URL` / `SUPABASE_SECRET_KEY` aren't set.

**TURN relay for live sessions (Cloudflare Realtime TURN):** live sessions are peer-to-peer. Create a TURN key in Cloudflare (Realtime → TURN) and set `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`; the server then makes short-lived relay credentials, only for a live session that was started (the host gets a token signed for the session code, which goes in the invite link). Every connection can fall back to the relay; a visitor whose ping to the host stays above the limit switches to it by themselves (and back if it's slower), and people an admin picks (their panel: "Always use the TURN relay") use only the relay. Admin → Settings → TURN relay: on/off, the ping limit (default 150 ms) and a monthly limit in GB (default 1000, 0 = none; needs `CF_ANALYTICS_TOKEN` + `CF_ACCOUNT_ID` to read the usage, shown in Admin → TURN relay). Needs `supabase/migrations/20261002110000_obv_turn_limit.sql` too. Needs `supabase/migrations/20261002090000_obv_turn.sql`.

**Collab through strict networks (optional):** collab uses the Cloudflare relay above when it's set up; otherwise set `TURN_URLS` (comma-separated `turn:`/`turns:` URLs) plus either `TURN_USERNAME` + `TURN_CREDENTIAL`, or `TURN_SECRET` for a coturn `use-auth-secret` server (2-hour credentials). The browser gets them from `/api/v1/ice`.
