# beatmap viewer

A web app for previewing, modding and mapping osu!standard beatmaps in the browser: play maps with storyboard and hitsounds, an osu!-style editor, MapsetVerifier-style checks, mod notes, a new-beatmap creator, and live sessions for modding/mapping together.

- Live site: https://osu-beatmap-viewer.lacrymira.workers.dev
- Vanilla JS + Canvas 2D, **no build step**: edit a file and reload
- Server code: small functions in `api/` for the osu! login (OAuth) and the online features (saved projects, sharing, annotations, admin, changelog), backed by Supabase (Postgres + a private Storage bucket). Without Supabase the site still works; only the online features are off.

---

## Contents

1. [Project structure](#project-structure)
2. [Running locally](#running-locally)
3. [Setting up the osu! login (OAuth)](#setting-up-the-osu-login-oauth)
4. [Setting up the database (Supabase)](#setting-up-the-database-supabase)
5. [Deploying](#deploying)
6. [Environment variables](#environment-variables)
7. [In-app settings](#in-app-settings)
8. [Shareable URLs](#shareable-urls)
9. [Working on the code](#working-on-the-code)
10. [Licences and credits](#licences-and-credits)

---

## Project structure

```
index.html            the page (markup only); loads all CSS/JS with defer
assets/app.css        all styles
assets/home/demo.osu  the beatmap that plays on loop on the home page (notes only)
js/                   browser code (load order below)
api/_lib/auth.js      OAuth helpers (HMAC-signed cookies)
api/_lib/db.js        Supabase access (database functions + private Storage bucket)
api/_lib/osu.js       osu! API calls made by the server (user lookups)
api/_lib/cleanup.js   deletes expired projects and abandoned uploads
api/auth/*.js         login, callback, me, verify, logout
api/v1.js             /api/v1/* : projects, members, annotations, user pages, admin, changelog, TURN (ice), saved replays and their share links
api/cron.js           daily cleanup (vercel.json "crons")
supabase/migrations/  database schema, functions and the changelog seed (run once, in order)
scripts/dev-server.mjs  local server: static site + the api/ functions, reads .env.local
tests/                local tests (not deployed)
.env.example          every environment variable, with notes
skins/default         osu! default skin (ppy/osu-resources, CC BY-NC 4.0)
skins/retro           osu! retro skin (ppy/osu-resources, CC BY-NC 4.0)
skins/NOTICE.txt      skin licence details
i18n/*.json           translations, one file per language (i18n/README.md explains how to edit them)
vercel.json           routes: security + cache headers (js/assets cached for 1 year), share-link previews, /api/v1
manifest.webmanifest  installable as an app (PWA)
```

Files in `js/`, in load order (they all share one global scope):

| File | What it does |
|---|---|
| `core.js` | Utilities, settings (`DEF`), volume, copy/share |
| `i18n.js` | `tr()` and language switching; loads `i18n/<lang>.json` |
| `features.js` | Feature switches (Admin → Features): `featOn(key)`, `featGuard(key)`, hiding by `data-feat`. Keys match `api/_lib/features.js` |
| `api.js` | Beatmap mirrors, search, map lookups |
| `osudata.js` | osu! listing data: genres, languages, player tag categories, search filters (URL ↔ state, osu! query) |
| `parse.js` | `.osu` parser, sliders, stacking, storyboard |
| `skins.js` | Skin loading, imported `.osk` skins, slider body rendering |
| `audio.js` | Song transport, hitsounds, metronome |
| `auto.js` | Auto's cursor: osu!lazer's autoplay (ppy/osu OsuAutoGenerator) ported: reaction time, eased moves, slider follow, spinner spin, alternating buttons |
| `player.js` | Player UI, settings sheet, object rendering, FPS cap |
| `verify.js` | Map checks + rhythm comparison of all difficulties |
| `tools.js` | Tools panel, timing, song file info, mod notes |
| `editor.js` | Modding mode / editor, hitsounds, timing points, mapping tools |
| `hsstudio.js` | Hitsound Studio (editor tab): hitsound grid, painting, the map's own sample files |
| `play.js` | Test play (▶ Test / 🎮 Test play / F5, off until turned on in Settings → Test play): play the map yourself, judged like osu!stable, results; Settings → Test play (keys, input, HUD) |
| `app.js` | Views, search, detail panel, downloads, URL router |
| `listing.js` | Song select Filters panel, a map's osu! details (genre, player tags, nominators), mapper profile pages |
| `create.js` | New beatmap page + the editor's Setup tab |
| `live.js` | osu! login (client side) + live sessions (PeerJS) |
| `drafts.js` | Local drafts of edited maps (IndexedDB) |
| `replay.js` | Replay reading (.osr: LZMA, MD5, parser, mods, rank). Loaded on demand (`loadLazy("replay")`), not by `index.html` |
| `replayui.js` | Replay watcher screens: results, end menu, Replays page, local cache (IndexedDB `replays`), finding the map, saving a replay online for 60 days (`/api/v1/replays`, SQL `20261010090000_obv_replays.sql`, D1 `0005_replays.sql`; limits `replays_per_user` and `replay_budget_bytes` in Admin → Settings; the feature switch `replays`), sharing a saved replay by a link only logged-in members can open (`?replay=<id>&key=<key>`; `POST /api/v1/replays/:id/share`, `GET /api/v1/replays/shared/:id?key=`; SQL `20261011150000_obv_replay_share.sql`, D1 `0006_replay_share.sql`; until it has run these answer `503 not_configured`). Loaded on demand |
| `replayana.js` | Replay analysis engine (pure functions): matches key presses to hit objects with the stable rules, hit timing/Unstable Rate, aim offsets, cursor heat map and speed, key stats. Loaded on demand |
| `replayanaui.js` | The Analysis view of a replay (tabs Timing / Aim / Cursor / Keys, canvas charts). Loaded on demand |
| `annot.js` | Annotations on the playfield / timeline |
| `collab.js` | Collaborative editing (merging edits from several people) |
| `cloud.js` | Save online: projects, sharing, members |
| `admin.js` | Admin dashboard (site owner) and changelog editor. Loaded on demand (`loadLazy("admin")` in `core.js`), not by `index.html`; the Markdown renderer the public changelog needs lives in `pages.js` |
| `home.js` | The beatmap playing on the home page |
| `pages.js` | Credits / Privacy / Changelog pages, and startup (`route()`) |

---

## Running locally

There are no dependencies to install. Serve the folder with any static server:

```bash
python -m http.server 5173
```

Then open http://localhost:5173

Or, with Node.js:

```bash
npx serve -l 5173
```

> Open it over `http://`, not by double-clicking `index.html` (`file://`); browsers block some loads from local files.

**What doesn't work with a plain static server**

- The osu! login, because it needs the functions in `api/`. On `localhost` the login button asks for a test name instead (dev login), so live sessions can still be tried.
- To run the `api/` functions locally, copy `.env.example` to `.env.local`, fill it in, and run `node scripts/dev-server.mjs` (http://localhost:5174). It serves the site plus the same functions and `/api/v1/*` rewrite as the deployed site, and adds a dev-only `/api/dev/login?name=<name>&id=<id>`. `.env.local` is git-ignored; never commit it.

**Trying live sessions locally:** open two tabs. In the first, open a map → Modding mode → Live button → start a session, then open the invite link in the second tab.

**Tests** (parser, API functions, database functions on an in-memory Postgres, collab merging):

```bash
npm --prefix tests install
npm --prefix tests test
```

**Syntax check before committing:**

```bash
for f in js/*.js api/*.js api/_lib/*.js api/auth/*.js; do node --check "$f"; done
cat js/core.js js/i18n.js js/features.js js/api.js js/osudata.js js/parse.js js/skins.js js/audio.js js/auto.js js/player.js js/verify.js js/tools.js js/editor.js js/hsstudio.js js/play.js js/app.js js/listing.js js/create.js js/live.js js/drafts.js js/replay.js js/replayui.js js/annot.js js/sidelists.js js/collab.js js/cloud.js js/admin.js js/home.js js/invites.js js/demo.js js/invscene.js js/gate.js js/pages.js > /tmp/all.js && node --check /tmp/all.js
```

The second line concatenates all files to catch duplicate top-level names across files.

---

## Setting up the osu! login (OAuth)

The osu! login is needed for live sessions and the online features (Save online, sharing, annotations, admin); everything else works without it.

1. Go to https://osu.ppy.sh/home/account/edit → **OAuth** → **New OAuth Application**
2. Give it a name and set the **Application Callback URL** to
   ```
   https://<your-domain>/api/auth/callback
   ```
3. You get a **Client ID** and a **Client Secret**
4. Put them in the server's environment variables (next sections). **Never put the Client Secret in the code or commit it.**

How it works:

- Only the `identify` scope is requested (user ID, username, avatar, country)
- The osu! access token is used once to read the profile and then discarded
- Logins are kept with an HttpOnly cookie `__Host-obv_s` (30 days; the `__Host-` prefix means no other site under the same parent domain can set it, and a login from before under the old name `obv_s` is still read and moved to the new name), HMAC-signed with a key derived from the Client Secret
- `/api/auth/me` returns a 4-hour `ticket` that proves who you are to others in a live session (checked with `/api/auth/verify`)
- Resetting the Client Secret logs everyone out

---

## Setting up the database (Supabase)

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

**TURN relay for live sessions (Cloudflare Realtime TURN):** live sessions are peer-to-peer. Create a TURN key in Cloudflare (Realtime → TURN) and set `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`; the server then makes short-lived relay credentials, only for a live session that was started (the host gets a token signed for the session code, which goes in the invite link). Every connection can fall back to the relay; a visitor whose ping to the host stays above the limit switches to it by themselves (and back if it's slower), and people an admin picks (their panel: "Always use the TURN relay") use only the relay. Admin → Settings → TURN relay: on/off, the ping limit (default 150 ms) and a monthly limit in GB (default 1000; needs `CF_ANALYTICS_TOKEN` + `CF_ACCOUNT_ID` to read the usage, shown in Admin → TURN relay). The limit fails closed: without the analytics token, with a limit of 0, or when the usage can't be read, nobody gets the relay (peer-to-peer/STUN only) unless `TURN_CAP_DISABLED=1` is set, which allows running without a working limit (0 = no limit then); a limit that can be checked is always enforced, and unreadable usage always means no relay. Needs `supabase/migrations/20261002110000_obv_turn_limit.sql` too. Needs `supabase/migrations/20261002090000_obv_turn.sql`.

**Collab through strict networks (optional):** collab uses the Cloudflare relay above when it's set up; otherwise set `TURN_URLS` (comma-separated `turn:`/`turns:` URLs) plus either `TURN_USERNAME` + `TURN_CREDENTIAL`, or `TURN_SECRET` for a coturn `use-auth-secret` server (2-hour credentials). The browser gets them from `/api/v1/ice`, which needs a login (collab does anyway) and allows 10 requests a minute per IP; credentials last 3 hours at most. Anonymous live-session guests get relay credentials only with the session's token (`POST /api/v1/live/ice`).

---

## Deploying

The site is static files plus Node.js serverless functions in `api/`. Any host that supports an `api/` functions folder in this layout works, e.g. Vercel.

### Vercel dashboard

1. Import this repository as a new project
2. Framework Preset: **Other** · Build Command, Output Directory and Install Command: leave empty
3. Add the environment variables below for **Production**
4. Deploy; the functions in `api/` are picked up automatically

### Vercel CLI

```bash
npx vercel link
```

```bash
npx vercel env add OSU_CLIENT_ID production
```

```bash
npx vercel env add OSU_CLIENT_SECRET production --sensitive
```

Add the others from [Environment variables](#environment-variables) the same way (`--sensitive` for secrets), then:

```bash
npx vercel deploy --prod
```

### After deploying

- `https://<your-domain>/api/auth/me` should return `{"user":null,"ticket":null}` (`"configured":false` means `OSU_CLIENT_ID` or `OSU_CLIENT_SECRET` isn't set)
- The Callback URL of the osu! OAuth app must match the real domain
- If browsers still get old CSS/JS, you forgot to bump `?v=N` (see [Working on the code](#working-on-the-code))

### Preview deployments

Cloudflare Worker Previews (`wrangler.jsonc` `previews`: one per Git branch, `<branch>-osu-beatmap-viewer.<account>.workers.dev`) and Vercel preview deployments (`VERCEL_ENV=preview`) run a branch's unreviewed code, so they fail closed (`api/_lib/preview.js`):

- On Cloudflare, any `workers.dev` host other than `osu-beatmap-viewer.<account>.workers.dev` (look-alikes included), or `OBV_PREVIEW=1` (set for previews in `wrangler.jsonc`), is a preview. Every `/api/*` request gets `503 {"error":"preview_backend_disabled"}` (login, `/api/v1`, cron), `/` is the plain page (noindex), and no API code runs, so no secret or binding is used. The static site works as usual, logged out, for UI review.
- On Vercel, the secrets (Supabase, osu!/Google OAuth, `SESSION_SECRET`, `CRON_SECRET`, `OWNER_OSU_ID`, TURN, analytics) are removed from every function's environment before it runs, so login, online features, admin and cron report "not configured".
- `PREVIEW_BACKEND=1` turns the API back on for previews. Set it only together with a separate, non-production Supabase project (and its own osu! app and `SESSION_SECRET`) given to previews, never with production's.
- The guard can't stop a malicious branch, which can change the code. In the Cloudflare dashboard, check which secrets and variables previews receive (production's must not reach them; on Vercel, don't tick **Preview** for production secrets), and keep previews behind Cloudflare Access.

---

## Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `OSU_CLIENT_ID` | ✅ (for login) | – | Client ID of the osu! OAuth app |
| `OSU_CLIENT_SECRET` | ✅ (for login) | – | Client Secret of the osu! OAuth app; exchanges codes, and signs cookies while `SESSION_SECRET` isn't set |
| `SESSION_SECRET` | recommended | – | A secret only this site has (`wrangler secret put SESSION_SECRET`, at least 32 random bytes, e.g. `openssl rand -base64 48`; a different one per environment). When set, login cookies, file links and live-session tokens are signed with separate keys derived from it instead of from `OSU_CLIENT_SECRET` (see [Rotating the session key](#rotating-the-session-key)) |
| `SESSION_LEGACY_OK` | – | on | While `SESSION_SECRET` is set and this isn't `0`, logins signed with the old `OSU_CLIENT_SECRET` key still work (and are signed again with the new key on the next visit). Set it to `0` once the grace period is over |
| `OSU_REDIRECT_URI` | – | `<site>/api/auth/callback` | Fixed callback URL (useful with several domains) |
| `SITE_URL` | – | – | The site's address (`https://…`); when set, OAuth redirect URIs and preview cards always use it |
| `ALLOWED_HOSTS` | – | – | Comma-separated hostnames the site is served on. Without `SITE_URL`, a request's host is only used for those URLs when it's listed here, localhost, or a `workers.dev` / `vercel.app` deployment named `osu-beatmap-viewer`; anything else gets the default address |
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
| `PREVIEW_BACKEND` | – | – | `1` lets preview deployments use the API (off by default: see [Preview deployments](#preview-deployments)); only with a separate, non-production backend |

`.env.example` lists them all. Without the osu! pair the site still works, but without the login; without the Supabase pair the online features are off.

### Rotating the session key

Without `SESSION_SECRET`, logins are signed with a key derived from `OSU_CLIENT_SECRET`, which osu! and every
environment that has it also know. To move to a key only this site has, without logging anybody out:

1. Run the session migration (`supabase/migrations/20261008110000_obv_session_revoke.sql`, or
   `d1/migrations/0004_session_revoke.sql` on D1) and deploy this version.
2. `wrangler secret put SESSION_SECRET` (a new random value, different per environment; never reuse `OSU_CLIENT_SECRET`).
   New logins use the new key; existing ones keep working and are signed again with it on their next visit. File links
   (≤ 2 h) and live-session relay tokens (≤ 3 h) made before simply expire: a live session started before the switch
   may have to be started again to use the relay.
3. After a while (logins last 30 days; a week or two covers active users), `wrangler secret put SESSION_LEGACY_OK` with
   `0`: logins still signed with the old key stop working. Then reset the osu! app's Client Secret if it may have
   leaked (only the osu! login needs it from then on).

To change `SESSION_SECRET` itself later, replace it: everybody is logged out once (there's no grace period for an old
`SESSION_SECRET`). One person's logins on every device end with Account settings → "Log out everywhere" (also when a
Google backup login is unlinked, and when an admin suspends the account).

---

## In-app settings

Users change settings with the ⚙ button in the player. Everything is stored in `localStorage` under `obv-settings` (defaults: `const DEF` in `js/core.js`).

| Tab | Settings |
|---|---|
| **Audio** | Master / Music / Hitsound volume (Master starts at 10%), hitsound source (map / default / off), metronome, playback speed, visual offset |
| **Display** | Notes, Auto cursor, score/combo, 300 judgements, snaking sliders, **slider end circles**, timing overlay, storyboard, parallax, kiai effects, background dim, screen layout, **frame rate (30–240 FPS, 50 by default)**, quality |
| **Skin** | osu! default (default), osu! retro, or your own `.osk` (stored in IndexedDB) |
| **General** | Difficulty, language (English, ไทย, Bahasa Melayu, Bahasa Indonesia, 한국어, 日本語), keyboard shortcuts |

Other data kept in the browser:

- Mod notes: `localStorage` keys `obv-notes:<beatmapId>`
- Imported skins and local drafts: IndexedDB
- Everything can be deleted from the Privacy page

Other defaults worth knowing:

- Song select opens on **Ranked** (mapper pages show every status)
- The mirror used for search/downloads is chosen on the Song select page (Nerinyan, catboy.best, osu.direct, Sayobot); if one is down or stalls, the next is tried automatically
- Download buttons use osu! first (opens osu.ppy.sh), then the mirrors

---

## Shareable URLs

| URL | Opens |
|---|---|
| `./` | Home menu |
| `?view=songs` | Song select (Ranked) · `&st=all\|ranked\|loved\|qualified\|pending\|graveyard` |
| `?q=<text>` | Search results |
| `?u=<mapper>` | Mapper page |
| `?view=editor` · `?view=create` | Editor page · new beatmap page |
| `?view=credits` · `?view=privacy` · `?view=changelog` | Info pages |
| `?s=<setId>&b=<beatmapId>` | A map's detail panel |
| `…&t=<ms>` | Straight into the player at that time |
| `…&mode=mod` | Opens in Modding mode |
| `…&notes=<url of a .json>` or `#n=<data>` | Offers to import mod notes |
| `?live=<code>` | Join a live session |
| `?project=<id>` | An online project (you must be its owner or shared with you) |
| `?project=<id>&key=<key>` | A project's share link: opens read-only without logging in (`&t=<ms>` for a time). How maps that aren't on osu! are shared |

---

## Working on the code

- **Cache busting:** `vercel.json` caches `/js/*` and `/assets/*` for a year. Whenever you change any CSS/JS, bump the `?v=N` on every `<link>` / `<script>` in `index.html`, or users keep the old files.
- **JS load order:** top-level code may only use things from files loaded before it. New files need a `<script>` tag in the right place.
- **UI text:** English strings are the keys. Wrap text in `tr("…")` or `data-i18n="…"` and add the key to every file in `i18n/` (see [i18n/README.md](i18n/README.md); `node scripts/i18n.mjs add rows.json` does it in one go). Missing or empty entries fall back to English. Translators can edit the JSON files directly on GitHub.
- **Editor:** change `map.lines` (raw HitObject lines), `map.timing` and `map.general/meta/diff` inside `edCommit()`, which calls `rebuildEdit()`, so undo and live sessions keep working. Never edit `map.hit` directly.
- **Audio:** the song is decoded into an AudioBuffer so seeking is exact and hitsounds share its clock (`<audio>` is only a fallback for files over 30 MB or that can't be decoded).
- **Live sessions:** PeerJS (from cdnjs) with PeerJS's free public server for matchmaking, so there is nothing to set up. The host holds the map state; up to 16 people; sessions close after 3 hours.
- **Home page map:** replace `assets/home/demo.osu` (and bump the `?v=` in `DEMO.url` in `js/home.js`). It always uses the osu! default skin, with no song or background.

---

## Licences and credits

The code is released under the **[GNU General Public License v3.0](LICENSE)**. The skins, the demo map and what users upload are separate works under their own terms (below and in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)), not under GPL-3.0.

The full list is on the site's **Credits** page (`?view=credits`) and in `skins/NOTICE.txt`. In short:

- Beatmap data, covers, previews and avatars come from osu! (ppy Pty Ltd). Beatmaps belong to their mappers, music to its artists.
- Mirrors: Nerinyan, catboy.best, osu.direct, Sayobot (used through their public APIs/links)
- osu! default / retro skins (stored in `skins/`) and the default hitsounds (loaded at run time, not stored): ppy/osu-resources, **[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)** (non-commercial use with credit only; if you fork this for commercial use, remove them)
- Translated from ppy/osu and ppy/osu-framework (MIT, © ppy Pty Ltd): stacking, slider paths and curves, Auto. Their notice and the other licences: [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
- Referenced for ideas (no code copied): osucad (MIT), osu! wiki (CC BY-NC 4.0)
- Verify follows MapsetVerifier's (GPL-3.0) check rules, thresholds and ways of measuring, and `tests/verify.test.mjs` rebuilds the cases from its check tests; to respect its licence, this project is released under GPL-3.0.
- Libraries: JSZip (MIT), PeerJS (MIT) · Fonts: Inter, IBM Plex Sans Thai (SIL OFL 1.1) · Twemoji flags (CC BY 4.0) · all loaded from CDNs, not stored here
- Dev only (not deployed): `@electric-sql/pglite` (Apache-2.0), used by the tests
- Test replays in `tests/fixtures` are synthetic (invented player names), not real players' replays

The site is free to use, with no fees, and is not affiliated with ppy Pty Ltd. osu! is a trademark of ppy Pty Ltd.
