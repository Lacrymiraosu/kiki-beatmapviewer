-- The changelog that used to be written in js/pages.js, moved into the database so the site owner can manage it from
-- the admin dashboard. Entries are permanent (not affected by project expiry). Oldest first, so v11 ends up on top.
insert into obv.changelog (title, version_label, content_md, status, published_at, sort_order)
values
  ($md$Version 1$md$, $md$v1$md$, $md$- Beatmap viewer: search the mirrors, play maps with storyboard and hitsounds$md$, 'published', null, 1),
  ($md$Version 2$md$, $md$v2$md$, $md$- Volume on every screen, better phone layout, shareable links
- Mapping tools: timing, BPM, map details, song file info
- Mapper pages and downloads from mirrors$md$, 'published', null, 2),
  ($md$Version 3$md$, $md$v3$md$, $md$- Split into separate JS/CSS files with long-term caching$md$, 'published', null, 3),
  ($md$Version 4$md$, $md$v4$md$, $md$- Modding mode: select, move and place objects, copy timestamps$md$, 'published', null, 4),
  ($md$Version 5$md$, $md$v5$md$, $md$- Recommended mapping skins (osu! default, YUGEN) and objects drawn like the osu! client
- Languages: English, ไทย, Bahasa Melayu, Bahasa Indonesia, 한국어, 日本語$md$, 'published', null, 5),
  ($md$Version 6$md$, $md$v6$md$, $md$- Editor layout like osu!'s (Compose / Timing / Verify / Setup)
- Verify checks modelled on MapsetVerifier
- Your own prefix/suffix for copied mod notes$md$, 'published', null, 6),
  ($md$Version 7$md$, $md$v7$md$, $md$- YUGEN Remastered becomes the default skin (with Garin's permission)
- Hitsound buttons flash with what is playing
- Sliders can be reshaped; quick mod notes with markers on the timeline$md$, 'published', null, 7),
  ($md$Version 8$md$, $md$v8$md$, $md$- Rhythm comparison of all difficulties and many more MapsetVerifier-style checks
- Difficulty switcher in the top bar
- Settings reorganised into tabs; the metronome is easy to find and turn off$md$, 'published', null, 8),
  ($md$Version 9$md$, $md$v9$md$, $md$- Import/export mod notes (JSON file, URL, link with the notes inside)
- Rhythm comparison: hover details, mouse-wheel scrolling and zoom, drag to scrub$md$, 'published', null, 9),
  ($md$Version 10$md$, $md$v10$md$, $md$- New home menu: Song select or Editor
- Song select: play previews straight from the cards; detail downloads from osu! first, then mirrors; open any map in the editor from its detail
- Create a new beatmap in the browser (song, metadata, HP/CS/AR/OD, BPM with Tap BPM, background) and edit Setup like osu!
- Editor: add, edit and delete timing points (Timing tab and Ctrl+P / Ctrl+Shift+P), zoomable timeline, slider → stream with start/end spacing, polygon circles, rotate, scale, flip, reverse, copy/paste
- Edits of every difficulty are kept while you switch; .osz export includes them all
- osu! login and live modding/mapping sessions (host & visitors, permissions, highlights, comments, 3-hour limit)
- Frame-rate setting (30–240 FPS, 50 by default) for slower phones
- Smoother rhythm comparison; slider ticks animate like osu!; lighter snaking sliders
- Mirror downloads now time out and move to the next mirror instead of getting stuck
- Credits & licences, privacy and changelog pages$md$, 'published', '2026-09-29T12:00:00Z', 10),
  ($md$Version 11$md$, $md$v11$md$, $md$- Advanced hitsounding: edit a slider's head, repeats and tail separately, addition bank, sample index and volume, hitsounds for new objects, hitsound by beat, copy hitsounds from another difficulty
- Hitsound buttons show all / some of the selection; Shift/Alt + Q W E R set the sample set / addition bank
- Slider end circles (can be turned off)
- Master volume
- Song select opens on Ranked
- A beatmap plays on the home page$md$, 'published', '2026-09-30T12:00:00Z', 11);

-- this update's notes, as a draft for the site owner to review and publish from the admin dashboard
insert into obv.changelog (title, version_label, content_md, status, published_at, sort_order)
values ($md$Save online, collab, annotations$md$, $md$v12$md$, $md$- **Save online** (osu! login): private projects with everything in the map, up to 30 MB, kept 15 days; share them with people by osu! name as viewers or editors
- **Collab together**: map one difficulty with friends, everyone editing at the same time; changes merge automatically
- **Annotations**: comments, arrows and highlights on the playfield that stay attached to their object
- **Drafts**: unsaved work is kept on your device; restore or discard it when you open the map again
- **User pages** with the osu! profile and beatmap lists, and mapper avatars on the cards
- Sliders, stacking, combo colours and approach timing now follow osu! more closely$md$, 'draft', null, 12);
