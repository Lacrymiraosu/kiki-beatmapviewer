# KIKI BEATMAP VIEWER

[![CI](https://github.com/Lacrymiraosu/kiki-beatmapviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/Lacrymiraosu/kiki-beatmapviewer/actions/workflows/ci.yml)
[![Secret scan](https://github.com/Lacrymiraosu/kiki-beatmapviewer/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/Lacrymiraosu/kiki-beatmapviewer/actions/workflows/secret-scan.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Live site](https://img.shields.io/badge/live%20site-open-ff66aa.svg)](https://osu-beatmap-viewer.lacrymira.workers.dev)

A web app for previewing, modding and mapping osu!standard beatmaps in the browser: play maps with storyboard and hitsounds, an osu!-style editor, MapsetVerifier-style checks, mod notes, a new-beatmap creator, and live sessions for modding/mapping together.

- Live site: https://osu-beatmap-viewer.lacrymira.workers.dev
- Vanilla JS + Canvas 2D, **no build step**: edit a file and reload
- Licence: **GPL-3.0** ([LICENSE](LICENSE)); third-party notices in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
- Server code: small functions in `api/` for the osu! login (OAuth) and the online features (saved projects, sharing, annotations, admin, changelog), backed by Supabase (Postgres + a private Storage bucket). Without Supabase the site still works; only the online features are off.

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

Tests and the syntax check: see [Working on the code](docs/development.md#tests-and-checks).

---

## Documentation

- [Setting up the osu! login (OAuth)](docs/setup-osu-login.md)
- [Setting up the database (Supabase)](docs/setup-database.md)
- [Deploying](docs/deploying.md) (Vercel, Cloudflare Workers)
- [Environment variables](docs/environment-variables.md)
- [In-app settings](docs/settings.md)
- [Shareable URLs](docs/urls.md)
- [Working on the code](docs/development.md): project structure, tests, rules
- [Editor & renderer reference](docs/EDITOR_REFERENCE.md)
- [Translations](i18n/README.md)

All pages: [docs/](docs/README.md)

---

## Licence and credits

### This project

**KIKI BEATMAP VIEWER is released under the [GNU General Public License v3.0](LICENSE).** You can use, change and share
it, as long as what you share stays under GPL-3.0 with its source available. The skins, the demo map and what users
upload are separate works under their own terms (below), not under GPL-3.0. Full notices for everything below are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt); the site's own [Credits page](https://osu-beatmap-viewer.lacrymira.workers.dev/?view=credits) lists the same.

### Code from other projects

| Project | Licence | Used for | In this repo |
|---|---|---|---|
| [ppy/osu](https://github.com/ppy/osu) (osu!lazer), ppy Pty Ltd | [MIT](https://github.com/ppy/osu/blob/master/LICENCE) | Translated to JavaScript: object stacking, slider paths, Auto | Translated: [js/parse.js](js/parse.js), [js/auto.js](js/auto.js). Follow its behaviour and values: [js/editor.js](js/editor.js), [js/player.js](js/player.js), [js/play.js](js/play.js), [js/skins.js](js/skins.js) |
| [ppy/osu-framework](https://github.com/ppy/osu-framework), ppy Pty Ltd | [MIT](https://github.com/ppy/osu-framework/blob/master/LICENCE) | Translated to JavaScript: slider curves (bezier, perfect circle, catmull) | [js/parse.js](js/parse.js) |
| [MapsetVerifier](https://github.com/Naxesss/MapsetVerifier), Naxess | [GPL-3.0](https://github.com/Naxesss/MapsetVerifier/blob/main/LICENSE) | Verify follows its check rules, thresholds and ways of measuring; the tests rebuild its check tests. | [js/verify.js](js/verify.js), [tests/verify.test.mjs](tests/verify.test.mjs) |

### Skins and sounds

| Asset | By | Licence | In this repo |
|---|---|---|---|
| osu! default and retro skins, default hitsounds, from [ppy/osu-resources](https://github.com/ppy/osu-resources) | ppy Pty Ltd | [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) (non-commercial, with credit) | [skins/default](skins/default), [skins/retro](skins/retro), [skins/NOTICE.txt](skins/NOTICE.txt) |

The skins are separate works under their own licence, not under GPL-3.0.

### Libraries, fonts and pictures (loaded from their CDN, not stored here)

| Name | By | Licence |
|---|---|---|
| [JSZip](https://github.com/Stuk/jszip) | Stuart Knightley and contributors | MIT (dual MIT / GPL-3.0) |
| [PeerJS](https://github.com/peers/peerjs) | PeerJS contributors | MIT |
| [Varela Round](https://fonts.google.com/specimen/Varela+Round) | Joe Prince | [SIL OFL 1.1](https://openfontlicense.org) |
| [IBM Plex Sans Thai](https://fonts.google.com/specimen/IBM+Plex+Sans+Thai) | IBM | [SIL OFL 1.1](https://openfontlicense.org) |
| [Twemoji](https://github.com/jdecked/twemoji) (flag pictures, fallback) | Twitter, Inc. and contributors | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

### Data and services

- Beatmap data, covers, previews and avatars: [osu!](https://osu.ppy.sh) (ppy Pty Ltd), under the [osu! Terms of Service](https://osu.ppy.sh/legal/en/Terms). Beatmaps belong to their mappers, music to its artists.
- Beatmap mirrors, through their public APIs and links: [Nerinyan](https://nerinyan.moe), [catboy.best](https://catboy.best), [osu.direct](https://osu.direct), [Sayobot](https://osu.sayobot.cn).
- The home page demo map ([assets/home/demo.osu](assets/home/demo.osu)) is [by this site's owner](https://osu.ppy.sh/beatmapsets/2578807#osu/5746002).

### Used as references (no code taken)

[osucad](https://github.com/minetoblend/osucad) (MIT) for editor ideas, and the [osu! wiki](https://osu.ppy.sh/wiki/Ranking_criteria) Ranking Criteria ([CC BY-NC 4.0](https://github.com/ppy/osu-wiki/blob/master/LICENCE.md)) for the rules behind Verify.

---

KIKI BEATMAP VIEWER is free to use, with no fees, and is not affiliated with or endorsed by ppy Pty Ltd. osu! is a trademark of ppy Pty Ltd.
