[← Documentation](README.md) · [Project README](../README.md)

# In-app settings

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
