-- The first changelog entry, for a new empty site (not needed when the data is copied from Supabase).
insert or ignore into changelog (id, title, version_label, content_md, status, published_at, sort_order, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000001', 'First release', 'v1.0', '### Song select
- Search osu! beatmaps by song, artist, mapper:name or an osu.ppy.sh link, through community mirrors (Nerinyan, catboy.best, osu.direct, Sayobot); Ranked by default, other statuses one tap away
- Play song previews straight from the cards
- Map details with every difficulty; download from osu! (default) or a mirror, moving on to the next mirror if one fails
- Mapper pages with the osu! profile and their beatmaps
- Open a .osz file from your device
### Player
- Watch maps with storyboard and hitsounds; objects, sliders, stacking and approach timing follow osu!
- Skins: YUGEN Remastered (default, used with Garin''s permission), osu! default, osu! retro, or your own .osk
- Master, music and hitsound volume on every screen, metronome, playback speed and visual offset
- Display settings: background dim, parallax, kiai effects, snaking sliders, slider end circles, timing overlay, 30–240 FPS and quality
- Mapping tools: timing and BPM, map details and song file info
- Shareable links to a map, a difficulty or a moment in the song
### Editor
- Laid out like the osu! editor: Compose, Timing, Verify, Setup and Mod notes
- Place, select, move and reshape circles, sliders and spinners, with beat snap, grid snap and distance snap; copy, paste, undo and redo
- Right-click (or long-press) menus like osu!lazer
- Add, edit and delete timing points (Ctrl+P / Ctrl+Shift+P) on a zoomable timeline
- Slider to stream, polygon circles, rotate, scale, flip and reverse
- Advanced hitsounding: slider head, repeats and tail, sample set, addition bank, sample index and volume, hitsound by beat, copy from another difficulty; the hitsound buttons flash with what is playing
- Create a new beatmap from a song file: metadata, HP/CS/AR/OD, Tap BPM and background
- Switch difficulties from the top bar; edits to every difficulty are kept and exported together as .osz
- Unsaved work is kept as a draft on your device
### Modding
- Verify: MapsetVerifier-style checks and a rhythm comparison of all difficulties (hover, scroll and zoom)
- Mod notes with timestamps, bookmarks, a quick-add menu and your own prefix/suffix; import and export as JSON, a URL or a link
- Annotations: comments, arrows and highlights on the playfield
### Together and online (osu! login)
- Live sessions: mod or map together in real time, with chat, highlights and permissions
- Collab: edit one difficulty with friends at the same time; changes merge automatically
- Save online: private projects up to 30 MB, kept 15 days, shared by osu! name with viewers or editors
### Everywhere
- Works on phones and computers, and can be installed as an app
- English, ไทย, Bahasa Melayu, Bahasa Indonesia, 한국어 and 日本語
- Free, no ads', 'published', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
