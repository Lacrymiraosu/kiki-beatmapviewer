"use strict";
// ============ info pages: credits & licences, privacy, changelog ============
const APP_VERSION = "1.0";
const CREDITS = [
  ["Beatmap data & media", [
    { name: "osu!", url: "https://osu.ppy.sh", by: "ppy Pty Ltd • beatmaps © their mappers, music © the artists", lic: "osu! Terms of Service",
      what: "Beatmap covers (assets.ppy.sh), song previews (b.ppy.sh), avatars (a.ppy.sh), map pages, official downloads and the osu! login",
      ok: "Shown and linked from osu!'s own servers, not re-hosted. Login uses the official OAuth API with the smallest scope (identify)." },
    { name: "Nerinyan", url: "https://nerinyan.moe", by: "Nerinyan team (community mirror)", lic: "Public API", what: "Beatmap search and .osz downloads",
      ok: "Used through its public API; files go straight from the mirror to your browser." },
    { name: "catboy.best", url: "https://catboy.best", by: "Mino (community mirror)", lic: "Public API", what: "Beatmap search, map lookups and .osz downloads",
      ok: "Used through its public API; files go straight from the mirror to your browser." },
    { name: "osu.direct", url: "https://osu.direct", by: "osu.direct (community mirror)", lic: "Public API", what: "Map lookups and .osz downloads",
      ok: "Used through its public API; files go straight from the mirror to your browser." },
    { name: "Sayobot", url: "https://osu.sayobot.cn", by: "Sayobot (community mirror)", lic: "Public download links", what: ".osz downloads (fallback)",
      ok: "Only its public download links are used." },
  ]],
  ["Code, rules & references", [
    { name: "ppy/osu and osu-framework (osu!lazer)", url: "https://github.com/ppy/osu", by: "ppy Pty Ltd and contributors", lic: "MIT", what: "How osu! stacks objects, draws sliders, plays Auto, converts osu!mania notes and rates their difficulty",
      ok: "Yes, with its notice: parts of the code (stacking, slider curves, Auto, osu!mania conversion and star rating) are translated from ppy/osu and ppy/osu-framework. Their MIT notice is in THIRD_PARTY_NOTICES.txt." },
    { name: "osucad", url: "https://github.com/minetoblend/osucad", by: "Marvin Schürz (minetoblend)", lic: "MIT", what: "Editor ideas: slider length snapping, distance snap",
      ok: "Yes: MIT allows reuse with credit. Used as a reference." },
    { name: "MapsetVerifier", url: "https://github.com/Naxesss/MapsetVerifier", by: "Naxess", lic: "GPL-3.0", what: "Which checks to run, their thresholds and how they measure the map (Verify tab)",
      ok: "Verify follows its rules, thresholds and ways of measuring, and its tests are rebuilt from MapsetVerifier's own. To respect its licence, this whole project is released under GPL-3.0." },
    { name: "osu! wiki • Ranking Criteria", url: "https://osu.ppy.sh/wiki/Ranking_criteria", by: "ppy and the osu! wiki contributors (ppy/osu-wiki)", lic: "CC BY-NC 4.0", what: "The rules behind the Verify checks",
      ok: "Rules are referenced and linked; the text isn't copied." },
  ]],
  ["Skins & sounds", [
    { name: "ppy/osu-resources", url: "https://github.com/ppy/osu-resources", by: "ppy Pty Ltd", lic: "CC BY-NC 4.0", what: "osu! default and retro skins, default hitsounds",
      ok: "Yes, for non-commercial use with credit (this site is free and non-commercial). Images were converted to WebP." },
  ]],
  ["Libraries, fonts & hosting", [
    { name: "JSZip", url: "https://github.com/Stuk/jszip", by: "Stuart Knightley and contributors", lic: "MIT or GPL-3.0 (your choice)", what: "Opening and building .osz / .osk files",
      ok: "Yes: used under the MIT option, loaded from cdnjs." },
    { name: "PeerJS", url: "https://github.com/peers/peerjs", by: "PeerJS contributors", lic: "MIT", what: "Peer-to-peer connections for live sessions",
      ok: "Yes: MIT. Its free public server (0.peerjs.com) only helps browsers find each other." },
    { name: "Varela Round", url: "https://fonts.google.com/specimen/Varela+Round", by: "Joe Prince", lic: "SIL Open Font License 1.1", what: "Main font", ok: "Yes: free to use, served by Google Fonts." },
    { name: "IBM Plex Sans Thai", url: "https://fonts.google.com/specimen/IBM+Plex+Sans+Thai", by: "IBM", lic: "SIL Open Font License 1.1", what: "Thai text", ok: "Yes: free to use, served by Google Fonts." },
    { name: "Twemoji", url: "https://github.com/jdecked/twemoji", by: "Twitter, Inc. and contributors (jdecked/twemoji)", lic: "CC BY 4.0", what: "Flag pictures, when osu!'s own flag image can't load",
      ok: "Yes: CC BY 4.0 allows use with credit. Loaded from jsDelivr, not stored here." },
    { name: "cdnjs", url: "https://cdnjs.com", by: "cdnjs (Cloudflare)", lic: "Public CDN", what: "Delivering the JSZip and PeerJS libraries",
      ok: "Yes: a free public CDN for open-source libraries." },
  ]],
];
// the licence texts the Credits page links to (by the "lic" shown on each entry)
const LIC_URL = { "MIT": "https://opensource.org/license/mit", "GPL-3.0": "https://www.gnu.org/licenses/gpl-3.0.html", "CC BY-NC 4.0": "https://creativecommons.org/licenses/by-nc/4.0/", "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
  "MIT or GPL-3.0 (your choice)": "https://github.com/Stuk/jszip/blob/main/LICENSE.markdown", "SIL Open Font License 1.1": "https://openfontlicense.org", "osu! Terms of Service": "https://osu.ppy.sh/legal/en/Terms" };
// the Privacy page: [title, text, [[label, value], ...]] (every string goes through tr)
const PRIVACY = [
  ["In short", "No ads, no analytics, no tracking cookies. While the site is invite-only, you need access to use the editor and the rest of the site: log in with osu! (or Google) and get approved by an admin, or join with someone's invite. Watching, editing and modding happen inside your browser. Data only leaves your browser in the cases listed below, and this page says exactly what, to whom and for how long.", [["Last updated", "2 October 2026"], ["Invite-only", "While the site is invite-only, using it (the editor included) needs a login with osu! or Google and either an approved access request or someone's invite (see Access and invites below). Without access you can still open the preview page, Privacy, Credits and Changelog."]]],
  ["What happens where", "What leaves your browser depends on what you use:", [["Browsing and watching maps", "Searches go to a beatmap mirror (or, with Filters, through our server to osu!). Covers, previews and avatars load from osu!. Maps are downloaded into your browser and played there. Nothing about you is saved on our server."], ["Editing and modding", "Your edits, drafts, mod notes, annotations and settings stay in this browser."], ["Logging in with osu!", "Our server learns your osu! ID, username, avatar and country."], ["Save online, share links, live and collab", "Only these send map data out of your browser: to our storage (Save online) or straight to the other people in your session (live, collab)."], ["When the site breaks", "If the site's own code hits an error in your browser, a short report goes to our server for the admins: the error message, where in our code it happened, the kind of page (not its link), the site's version and the browser family (e.g. \"Safari · iOS\"). Nothing about you: no osu! ID, and no IP address is kept. Each report is removed after 60 days without the error happening again."], ["Report a problem", "Only what you write, the kind of page, the site's version and your browser family, plus your osu! name if you tick the box. The admins see it in their dashboard; it's removed after at most 90 days."]]],
  ["Stored in your browser only", "These never reach our server. The button at the bottom of this page deletes all of them.", [["Settings", "localStorage \"obv-settings\": skin, volumes, offset, language, editor options."], ["Mod notes", "localStorage \"obv-notes:…\", one list per map."], ["Which page opens first", "localStorage \"obv-gate\": whether this browser last opened the app or the invite page, so the right one shows at once. Just that word, nothing about you."], ["Drafts of unsaved work", "IndexedDB \"obv\": the difficulties you changed, object IDs and annotations (for maps made here or opened from a file, also the song and images), per osu! account or \"guest\". Deleted 30 days after the last change, or when you restore or discard them."], ["Imported skins", "IndexedDB \"obv\": the .osk files you added."], ["Downloaded maps", "IndexedDB \"obv\": the .osz files downloaded from the mirrors, so opening a map again needs no download (up to 500 MB, the least recently opened go first; Settings → General clears them)."], ["Files you open", ".osz files, songs and images you open or create are read inside your browser and are not uploaded, except with Save online or to the people in your live or collab session."], ["Offline copy of the site", "Your browser keeps a copy of the site's own files (scripts, styles, translations, icons; not your maps or account) so it opens faster and without a connection, also when installed as an app."]]],
  ["osu! login (optional)", "Needed only for Save online, live and collab sessions.", [["What we get", "Through osu!'s \"identify\" permission: your osu! user ID, username, avatar and country."], ["What we never get", "Your password, e-mail, friends, messages or scores."], ["osu! access token", "Used once to read that profile, then thrown away."], ["Cookies", "All signed and HttpOnly, only for logging in: \"obv_s\" keeps you logged in (30 days; Log out deletes it). \"obv_st\" and \"obv_alt\" last 10 minutes while you log in with osu! or Google. With Google only: \"obv_gp\" (30 minutes) remembers a Google sign-in that isn't linked yet, and \"obv_gl\" (up to 400 days) remembers which Google account asked for access, so your next osu! login can confirm it."], ["Kept on our server", "Only once you use online projects: your osu! ID, username, avatar link, country, when you last used them, and any limits or role the admins set for your account."]]],
  ["Backup login (optional): Google", "Only if you link one in Account → Backup logins (so you can still log in when osu!'s login doesn't work), or ask for access with Google.", [["What we get", "Only the account's ID at Google (a code that stands for your account there). We ask for no name, no e-mail and nothing else."], ["Kept on our server", "That ID with your osu! ID, when you linked it and when you last logged in with it, until you unlink it (or your account is removed)."], ["Asking for access with Google", "We look up the osu! name you type on osu! (public profile: name, avatar, country) and keep it with the Google ID, marked \"not verified\" until you log in with osu! once in the same browser. A cookie in that browser remembers which Google account asked (up to 400 days) so that login can confirm it. If someone else logs in with that osu! account first, the unconfirmed link is removed."], ["Who sees what", "Google sees that you log in to this site, as with any sign-in through Google, under its own privacy policy."]]],
  ["Your account: settings, your data, deleting it", "In Account settings (account menu), once you're logged in.", [["Sync my settings across devices", "Only if you turn it on: the site's settings are kept with your account so your other devices get them. Turning it off deletes them from our server."], ["Download my data", "A file with everything we keep about your account."], ["Delete account", "Deletes your online projects and their files, you in other people's projects and your comments there, your invite links, backup logins and settings, and logs you out on every device. What stays: your osu! ID and when the account was deleted (so older logins stop working), and entries in the admins' activity log. Logging in again later starts a new, empty account."]]],
  ["Google Drive (optional)", "Only if you use it, to save, open and export maps in your own Google Drive.", [["Where the files go", "Straight from your browser to your Google Drive (folder \"beatmap viewer\"). This site's server never receives the files or your Google access token."], ["What the site can see in your Drive", "Only the files it created there, or a file you pick with Google's file picker (Google's \"drive.file\" permission). Nothing else in your Drive."], ["Google access", "Google's sign-in gives your browser a token for about an hour, kept only in that page's memory. Disconnect it in the Google Drive window, or remove the site's access in your Google Account (Security → Third-party connections)."], ["Who sees what", "Google keeps the files under its own privacy policy and terms."]]],
  ["Online projects (Save online)", "Only when you press Save online.", [["What is stored", "The map's files (difficulties, song, images, storyboard; no video) within the size limit shown when you save, your annotations, the project name and who saved what, when."], ["Where", "Our database and private file storage. Files are only reachable through short-lived signed links our server hands out after checking who you are."], ["Who can open it", "You, the people you add by osu! name (viewer or editor), and anyone with its share link if you turn one on. Every request is checked on the server."], ["How long", "Until the date shown on the project (by default 15 days after the first online save; saving again doesn't extend it). After that nobody can open it and the files are deleted, usually within a day. You can delete a project any time; copies others downloaded aren't affected."], ["Admins", "The site owner and the admins they appoint run the service and can technically reach stored data. The admin tools show names, sizes and dates, not your files, and every admin action is logged."]]],
  ["Share links", "If a project's owner turns on its share link, anyone with the link can open, play and download that project without logging in, but not change it. The link stops working when the owner turns it off or makes a new one, or when the project expires. Links can be passed on, so only share them with people you trust with the map.", []],
  ["Your uploads, and asking for something to be removed", "Save online and share links only what you're allowed to share: maps, songs and images belong to their mappers, artists and owners. The site doesn't check this for you.", [["What you save stays yours", "The site only keeps it for you and, if you turn on a share link, lets people with the link open and download it."], ["If something here is yours", "To have a shared project, a built-in skin or anything else on this site taken down, use Report a problem (at the bottom of every page) with the link and why. An admin removes it."]]],
  ["Mapper pages, Filters and map details", "These ask our server, and our server asks the osu! API with the site's own app key. osu! receives only what is being looked up: the search words and filters, the mapper's name or ID, or the map ID. It doesn't receive your IP address or who you are. Answers are kept in a cache for about 5–10 minutes (the tag list for a day). Online projects are never shown on mapper pages.", []],
  ["Access and invites", "While the site is invite-only, you need access before you can use the editor: log in with osu! (or Google) and either ask for access and wait for an admin to approve it, or open someone's invite link.", [["Kept on our server", "Your osu! ID, username, avatar link and country; the state of your access (pending, approved or denied), when you asked and when it was answered, and the optional note you write for the admins; who invited you and when, if you came in with an invite; your own invite code and whether you may invite people."], ["Invite links", "Your link has a random code. Anyone who opens it sees your osu! name and avatar. When someone joins with it, you see their osu! name, avatar and the day they joined; you don't see anything else about them. Make a new link at any time to stop the old one."], ["Who sees it", "The site's owner and admins, to answer requests and manage invites (who invited whom, how many invites each person has). Requests, answers and invite changes are recorded in the admin audit log."], ["How long", "As long as your account exists. Delete it yourself in Account settings, or ask the site owner on osu!."]]],
  ["Live and collab sessions", "Both are peer-to-peer (WebRTC): the browsers in the session talk to each other directly, not through our server.", [["What others in the session see", "Your osu! name and avatar (or guest name), pointer, selections, highlights, chat and comments; in collab also the map and every edit. Like any peer-to-peer connection, they can see your IP address."], ["Services that help connect", "The free PeerJS server (0.peerjs.com) introduces the browsers to each other (it sees the session code and your IP address). Google's STUN server tells your browser its public address. If a direct connection isn't possible, a relay (TURN) server may pass the encrypted data along."], ["Our server", "Only checks osu! logins (and, for an online project, your role in it). It stores nothing about the session."], ["Recording", "Nothing is recorded. Live sessions close after 3 hours; everyone keeps their own copy of what they received."]]],
  ["Where your data goes (other services)", "Your browser connects to these services directly, so each of them sees your IP address and the usual browser information, and has its own privacy policy.", [["Beatmap mirrors", "Nerinyan, catboy.best, osu.direct, Sayobot: your search words, the status you picked, and the IDs of maps you open or download."], ["osu! (ppy)", "Covers, song previews, avatars, flags and badges load from osu.ppy.sh, assets.ppy.sh, b.ppy.sh and a.ppy.sh. osu.ppy.sh also handles the login page and the official download link."], ["Libraries, fonts and pictures", "cdnjs (JSZip, PeerJS), Google Fonts (the fonts), GitHub (the default hitsounds from ppy/osu-resources) and jsDelivr (flag pictures, only if osu!'s don't load)."], ["Links you paste", "Importing mod notes from a GitHub Gist or Pastebin link fetches that page from your browser."], ["This site's server", "Like any website, it keeps standard access logs (address of the page, time, IP address, browser) for a short time to keep the service running and safe."]]],
  ["What we don't do", "No ads, no analytics or tracking scripts, no selling or sharing of data, no e-mails, and no profiling. The site is free and non-commercial.", []],
  ["Your choices", "", [["In this browser", "The button below deletes settings, mod notes, imported skins, drafts and downloaded maps (and logs you out)."], ["Online", "Delete your projects in My online projects, download everything we keep in Account settings → Download my data, or delete your whole account there (type Confirm)."], ["Children and contact", "The site doesn't knowingly collect data from children. Questions: message the site owner on osu!."]]],
];
// the release notes built into the site; the live changelog is managed in the admin dashboard (database). This copy is only
// shown when the server can't be reached.
const CHANGELOG = { version: "v1.0", title: "First release", date: "2026-09-30", md: `### Song select
- Search osu! beatmaps by song, artist, mapper:name or an osu.ppy.sh link, through community mirrors (Nerinyan, catboy.best, osu.direct, Sayobot); Ranked by default, other statuses one tap away
- Play song previews straight from the cards
- Map details with every difficulty; download from osu! (default) or a mirror, moving on to the next mirror if one fails
- Mapper pages with the osu! profile and their beatmaps
- Open a .osz file from your device
### Player
- Watch maps with storyboard and hitsounds; objects, sliders, stacking and approach timing follow osu!
- Skins: osu! default, osu! retro, or your own .osk
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
- Free, no ads` };
function renderPage(kind) {
  const box = $("page"); box.innerHTML = "";
  const head = h("div", "vhead"), back = h("a", "btn ghost sm", "← " + tr("Home")); back.href = "./"; back.dataset.go = "home";
  head.append(back, h("h2", null, tr(VIEW_TITLE[kind])));
  box.append(head);
  if (kind === "credits") {
    const free = h("section", "freebox");
    free.append(h("b", null, tr("Free to use")), h("p", null, tr("This website is completely free: no payment, subscription, ads or paywall, and it will never ask you for money. It's a non-commercial fan project and isn't affiliated with or endorsed by ppy Pty Ltd. osu! is a trademark of ppy Pty Ltd.")));
    box.append(free, h("p", "hint", tr("Where the data comes from, who made what, and whether we're allowed to use it:")));
    for (const [group, items] of CREDITS) {
      box.append(h("h3", "pgh", tr(group)));
      const list = h("div", "credits");
      for (const c of items) {
        const el = h("article", "credit"), a = h("a", null, c.name); a.href = c.url; a.target = "_blank"; a.rel = "noopener";
        const lic = h("em", "lic"), lu = LIC_URL[c.lic];
        if (lu) { const l = h("a", null, tr(c.lic)); l.href = lu; l.target = "_blank"; l.rel = "noopener license"; lic.append(l); } else lic.textContent = tr(c.lic);
        const t = h("div", "ct"); t.append(a, lic);
        el.append(t, h("p", "cw", tr(c.what)), h("small", "cby", tr(c.by)), h("p", "cok", tr(c.ok)));
        list.append(el);
      }
      box.append(list);
    }
    const tpn = h("a", null, tr("Licence notices, and what was translated from where: THIRD_PARTY_NOTICES.txt")); tpn.href = "THIRD_PARTY_NOTICES.txt"; tpn.target = "_blank"; tpn.rel = "noopener license";
    const tpp = h("p", "hint"); tpp.append(tpn); box.append(tpp);
    box.append(h("p", "hint", tr("Skin files are listed with their licences in skins/NOTICE.txt. If you own something used here and want it credited differently or removed, please get in touch.")));
  } else if (kind === "privacy") {
    for (const [t, p, rows] of PRIVACY) {
      const s = h("section", "psec"); s.append(h("h3", "pgh", tr(t))); if (p) s.append(h("p", null, tr(p)));
      if (rows && rows.length) { const dl = h("dl", "prows"); for (const [k, v] of rows) dl.append(h("dt", null, tr(k)), h("dd", null, tr(v))); s.append(dl); }
      box.append(s);
    }
    const b = h("button", "btn ghost", tr("Delete everything this site stored in this browser"));
    b.onclick = async () => {
      if (!(await ask(tr("Delete your settings, mod notes, imported skins, drafts and downloaded maps from this browser?"), { ok: tr("Delete"), danger: true }))) return;
      try { for (const k of Object.keys(localStorage)) if (k.startsWith("obv-")) localStorage.removeItem(k); } catch {}
      try { indexedDB.deleteDatabase("obv"); } catch {}
      if (AUTH.user && !AUTH.user.dev) { authLogout(); return; }
      toast(tr("Deleted. The page will reload.")); setTimeout(() => location.reload(), 1200);
    };
    box.append(b);
  } else if (kind === "changelog") {
    const list = h("div", "cloglist"); list.append(h("div", "card sk"), h("div", "card sk")); box.append(list);
    loadChangelog(list);
  } else if (kind === "guide") renderGuide(box);
}

// ---------- Guide: where to start, and every keyboard shortcut (the same list as Settings → Shortcuts) ----------
const GUIDE = [
  ["Find a map", "Beatmap: search by name, mapper or tags (Filters for genre, language and more), paste an osu! link, or drop an .osz / .osu file anywhere on the page."],
  ["Watch it", "Preview plays the map with its storyboard, skin and hitsounds. ⚙ Settings: skin, volumes, audio offset (and calibration for Bluetooth headphones)."],
  ["Mod it", "Switch to Modding (F5). Tap an object and press \"+ Note\" (or N) to write a mod with its timestamp, sort notes into categories, then Copy all and paste into the osu! discussion. Verify lists common problems."],
  ["Answer mods (for the mapper)", "Import the modder's notes (file, link or pasted text), mark each one Fixed, Partly or Not fixed with a reason, then Copy reply. Send your notes file back so the modder sees the answers."],
  ["Edit or make a map", "Editor: open a map or create a new one. Compose, Hitsounds, Timing and Setup work like osu!'s editor; Export gives an .osu or .osz. Compare shows what changed between two versions."],
  ["Save and share", "Save online keeps a project on the site (with a share link). Google Drive saves to your own Drive. Live sessions let others watch you map; collab lets them edit with you."],
];
function renderGuide(box) {
  for (const [i, [t, p]] of GUIDE.entries()) { const s = h("section", "psec gstep"); s.append(h("h3", "pgh", `${i + 1}. ${tr(t)}`), h("p", null, tr(p))); box.append(s); }
  const app = h("section", "psec"); app.append(h("h3", "pgh", tr("Install as an app")), h("p", null, tr("Add the site to your home screen or apps: it opens full screen, and maps you downloaded open without a connection.")));
  const ib = typeof installButton === "function" && installButton("btn main sm");
  app.append(ib || h("p", "hint", typeof appInstalled === "function" && appInstalled() ? tr("You're using the app already.") : tr("In Chrome or Edge: the install icon in the address bar, or the browser menu → Install. In Safari on iPhone / iPad: Share → Add to Home Screen.")));
  box.append(app);
  const keys = h("section", "psec"); keys.append(h("h3", "pgh", tr("Keyboard shortcuts")));
  for (const [g, rows] of KEY_GROUPS) {
    const card = h("div", "card2 keys"); for (const [k, d] of rows) { const r = h("div", "krow"); r.append(h("kbd", null, k), h("span", null, tr(d))); card.append(r); }
    keys.append(h("div", "subh", tr(g)), card);
  }
  box.append(keys);
  const help = h("section", "psec"); help.append(h("h3", "pgh", tr("Something wrong?")), h("p", null, tr("Tell the admins what happened: a button that does nothing, a wrong translation, something that looks broken on your screen.")));
  const rb = h("button", "btn ghost sm", tr("Report a problem")); rb.onclick = openReport; help.append(rb); box.append(help);
}

// ---------- Report a problem: a short text for the admins (Admin → Errors → Reports) ----------
async function openReport() {
  const body = h("div", "rpbox"), ta = h("textarea"); ta.rows = 5; ta.maxLength = 1000;
  ta.placeholder = tr("What happened? e.g. on my phone the Save button doesn't respond in the editor");
  ta.addEventListener("keydown", e => e.stopPropagation());
  body.append(ta);
  let named = null;
  if (AUTH.user && !AUTH.user.dev) { const l = h("label", "nquote"); named = h("input"); named.type = "checkbox"; l.append(named, h("span", null, tr("Add my osu! name so the admins can ask me"))); body.append(l); }
  const ctx = siteContext();
  body.append(h("p", "hint", tr("Sent with it: the kind of page ({page}), the site's version and your browser ({browser}). Nothing else.", { page: ctx.page, browser: ctx.browser })));
  setTimeout(() => ta.focus(), 50);
  if (!(await modal({ title: tr("Report a problem"), body, dismiss: false, buttons: [{ label: tr("Cancel"), value: false }, { label: tr("Send"), value: true, cls: "main" }] }))) return;
  const message = ta.value.trim();
  if (message.length < 3) return toast(tr("Write a few words about what happened"), 2500);
  try {
    const r = await fetch("/api/v1/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, with_name: !!(named && named.checked), ...ctx }) });
    if (!r.ok) throw new Error(r.status === 429 ? tr("too many reports, try again in a minute") : "HTTP " + r.status);
    toast(tr("Thanks! The admins will see it."), 3000);
  } catch (e) { toast(tr("Couldn't send the report: {err}", { err: e.message }), 4000); }
}
$("footReport").onclick = e => { e.preventDefault(); openReport(); };
// published entries from the server (owner's order, newest first); no cache, so edits show right away
async function fetchChangelog() {
  try { const r = await fetch("/api/v1/changelog", { cache: "no-store" }); if (r.ok && (r.headers.get("content-type") || "").includes("json")) { const e = (await r.json()).entries; setFootVer(e); return e; } } catch {}
  return null;
}
// the footer shows the current (top) published changelog version from Admin → Changelog; the built-in number until then
function setFootVer(entries) {
  const e = (entries || []).find(x => x.version_label), v = e ? String(e.version_label).trim() : APP_VERSION;
  $("footVer").textContent = /^v/i.test(v) ? v : "v" + v;
}
async function loadChangelog(list) {
  const entries = await fetchChangelog();
  list.innerHTML = "";
  if (entries) {
    if (!entries.length) { list.append(h("div", "empty", tr("No changelog entries yet"))); return; }
    entries.forEach((e, i) => {
      const s = h("section", "clog" + (i === 0 ? " cur" : "")), hd = h("div", "clh");
      const auto = /^Version \d+$/.test(e.title) && e.version_label; // untitled entries: the version label is enough
      hd.append(e.version_label ? h("b", null, e.version_label) : "", auto ? "" : h("span", "cltitle", e.title), e.published_at ? h("small", null, fmtDate(e.published_at, false)) : "", i === 0 ? h("em", null, tr("current")) : "");
      const c = h("div", "md"); c.append(mdRender(e.content_md, { translate: true }));
      s.append(hd, c); list.append(s);
    });
    return;
  }
  list.append(h("p", "hint", tr("Couldn't load the latest changelog, showing the history built into this version.")));
  const s = h("section", "clog cur"), hd = h("div", "clh"), c = h("div", "md");
  hd.append(h("b", null, CHANGELOG.version), h("span", "cltitle", tr(CHANGELOG.title)), h("small", null, CHANGELOG.date), h("em", null, tr("current")));
  c.append(mdRender(CHANGELOG.md, { translate: true }));
  s.append(hd, c); list.append(s);
}
setFootVer(null); fetchChangelog();

// ---------- boot: every script is loaded now (and the language file, when one is needed) ----------
I18N_READY.then(() => { if (LANG !== "en" && Object.keys(I18N_DICT).length) i18nRefresh(); gateBoot(); }); // gate.js: the app, or the access page
