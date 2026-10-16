-- Changelog: the replay watcher, and the fixes since v2.0. Added as a DRAFT: review it and publish it from the admin dashboard
-- (Changelog tab), where it can also be edited. Run once, after the earlier migrations. It changes nothing else.
insert into obv.changelog (title, version_label, content_md, status, published_at, sort_order)
select $md$Replay watcher$md$, $md$v2.1$md$, $md$### Replay watcher
- Open an osu!standard replay (.osr from osu!stable or osu!lazer): drop the file on the page or choose it, and see the results first: player, mods, score, accuracy, combo and hit counts
- The site finds the beatmap by itself and only downloads it when you press Watch; or drop the map's .osz to use your own copy
- Watch the replay on the playfield with its own cursor and key presses, with Hidden, Hard Rock, Easy, Double Time and Half Time applied, and your skin
- It plays what the replay really did: hit bursts and 100 / 50 / miss marks at the real presses, the slider follow circle only while it is really followed, missed ticks, a spinner that turns as the player turned it and says Clear only when it was cleared
- Hitsounds follow the real presses (nothing for a miss, and slider ticks, repeats and the end only when they were hit), and a combo-break sound plays when a long combo really breaks
- The combo counter shows the replay's own combo and falls at a real break
- **Live Top 50**: while the replay plays, see where it would rank among the map's global top 50 scores, like osu!. Turn it off in Settings or with the Tab key
- **Replay analysis**, all read from the replay file
- Timing: hit error bar and histogram, error over time (scatter plot), mean error and spread (UR)
- Aim: where inside each circle the cursor hit, average offset and distance
- Keys: presses per key, how steadily they alternate, fastest tapping
- Cursor: heat map, speed over time, furthest hit and longest jump
- An estimate of the 300 / 100 / 50 / miss counts next to the replay's own numbers
- **Replays page**: replays you open are kept on this device; log in with osu! to save one online for 60 days (up to 1 MB)
- **Share a replay**: on the results page, Share saves it online if needed and gives a link that other signed-in members can open to watch it (view only, no download of the map until they press Watch). You can stop sharing at any time
- After the last object a Skip button takes you to the results; the song plays to its end otherwise
- Works in mobile view too, with a lighter picture on big touch screens so it stays smooth

### Fixes
- Mobile view: the page no longer zooms in when a text field gets the focus, and zooms back out after typing
- Mobile view: an old cached copy of the site could break with "Can't find variable: kbdMod"; the site now reloads itself once to the new version
- Mobile view: a swipe back from the edge of the screen no longer throws you out of a map you just opened; it asks "Leave this map?" first. Going back while a map is downloading cancels the download, and the map list no longer shows empty for a moment after you open a map
- Beatmaps: tapping outside the map panel closes it and no longer opens the map behind it
- Editor: the Now button in the Timing panel no longer sticks out of the form
- Editor timeline: a click only selects, and no longer jumps the song; with a mouse you can start a selection box over a long slider
- Editor: Ctrl+A or a timeline selection now keeps every selected object visible on the playfield, like osu!stable
- Verify: the checks now give the same results as MapsetVerifier for osu!standard maps
- Live sessions: guests follow the host more smoothly, also over relay (TURN) connections$md$, 'draft', null, 8
where not exists (select 1 from obv.changelog where title = 'Replay watcher' and version_label = 'v2.1');
