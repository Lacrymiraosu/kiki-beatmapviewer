[← Documentation](README.md) · [Project README](../README.md)

# Working on the code

How the code is laid out, how to test it, and the rules to follow when changing it. For how osu! behaviour is reproduced (circle size, stacking, sliders…), see [EDITOR_REFERENCE.md](EDITOR_REFERENCE.md).

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
api/v1.js             /api/v1/* : projects, members, annotations, user pages, admin, changelog, TURN (ice)
api/cron.js           daily cleanup (vercel.json "crons")
supabase/migrations/  database schema, functions and the changelog seed (run once, in order)
scripts/dev-server.mjs  local server: static site + the api/ functions, reads .env.local
tests/                local tests (not deployed)
.env.example          every environment variable, with notes
wrangler.example.jsonc  Cloudflare Workers config with placeholder IDs (copy to wrangler.jsonc for your own deploy)
LICENSE               GPL-3.0
THIRD_PARTY_NOTICES.txt  notices for translated code, skins, libraries and fonts
skins/default         osu! default skin (ppy/osu-resources, CC BY-NC 4.0)
skins/retro           osu! retro skin (ppy/osu-resources, CC BY-NC 4.0)
skins/NOTICE.txt      skin licence details
docs/                 these documentation pages
i18n/*.json           translations, one file per language (i18n/README.md explains how to edit them)
vercel.json           routes: security + cache headers (js/assets cached for 1 year), share-link previews, /api/v1
manifest.webmanifest  installable as an app (PWA)
```

Files in `js/`, in load order (they all share one global scope):

| File | What it does |
|---|---|
| `core.js` | Utilities, settings (`DEF`), volume, copy/share |
| `i18n.js` | `tr()` and language switching; loads `i18n/<lang>.json` |
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
| `annot.js` | Annotations on the playfield / timeline |
| `collab.js` | Collaborative editing (merging edits from several people) |
| `cloud.js` | Save online: projects, sharing, members |
| `admin.js` | Admin dashboard (site owner) and changelog editor |
| `home.js` | The beatmap playing on the home page |
| `pages.js` | Credits / Privacy / Changelog pages, and startup (`route()`) |

## Tests and checks

**Tests** (parser, API functions, database functions on an in-memory Postgres, collab merging):

```bash
npm --prefix tests install
npm --prefix tests test
```

**Syntax check before committing** (CI runs the same check and the tests on every push and pull request):

```bash
bash scripts/check-syntax.sh
```

It runs `node --check` on every JS file, then joins the site's scripts in the order `index.html` loads them and checks them as one file, to catch the same top-level name declared in two files.

## Rules when changing the code

- **Cache busting:** `vercel.json` caches `/js/*` and `/assets/*` for a year. Whenever you change any CSS/JS, bump the `?v=N` on every `<link>` / `<script>` in `index.html`, or users keep the old files.
- **JS load order:** top-level code may only use things from files loaded before it. New files need a `<script>` tag in the right place.
- **UI text:** English strings are the keys. Wrap text in `tr("…")` or `data-i18n="…"` and add the key to every file in `i18n/` (see [i18n/README.md](../i18n/README.md); `node scripts/i18n.mjs add rows.json` does it in one go). Missing or empty entries fall back to English. Translators can edit the JSON files directly on GitHub.
- **Editor:** change `map.lines` (raw HitObject lines), `map.timing` and `map.general/meta/diff` inside `edCommit()`, which calls `rebuildEdit()`, so undo and live sessions keep working. Never edit `map.hit` directly.
- **Audio:** the song is decoded into an AudioBuffer so seeking is exact and hitsounds share its clock (`<audio>` is only a fallback for files over 30 MB or that can't be decoded).
- **Live sessions:** PeerJS (from cdnjs) with PeerJS's free public server for matchmaking, so there is nothing to set up. The host holds the map state; up to 16 people; sessions close after 3 hours.
- **Home page map:** replace `assets/home/demo.osu` (and bump the `?v=` in `DEMO.url` in `js/home.js`). It always uses the osu! default skin, with no song or background.
