"use strict";
// ============ invite-only: the preview page and asking for access ============
// When the site requires access (a switch in Admin → Settings), people without an approved account see this page
// instead of the app: what the site can do, and at the bottom "Request access with osu!". Logging in with osu! sends
// the request at once; the page then shows it as pending and lets them in by itself as soon as an admin approves.
// The server enforces it on every request (api/v1.js); this page is only what people see. Privacy, Credits and the
// Changelog stay readable for everyone.
const GATE = { locked: false, me: null, poll: 0, sending: false };
const GATE_OPEN_VIEWS = new Set(["privacy", "credits", "changelog", "guide"]);
const GATE_FEATURES = [
  ["M9 18V5l11-2v13|c6,18,3|c17,16,3", "Beatmap", "Search osu! beatmaps like on the website: status, stars, genre, language, player tags (tech, style, skill) and more. Listen to previews, download, or open a map straight away."],
  ["M7 4l13 8-13 8z", "Preview player", "Watch any difficulty with its storyboard, video and hitsounds, in the osu! default or retro skin, or your own .osk. Speed, offset and Bluetooth calibration included."],
  ["M4 20h4L19 9l-4-4L4 16z|M13.5 6.5l4 4", "An editor like osu!'s", "Compose, Timing, Hitsounds, Verify and Setup, with beat snap, grid and distance snap, mapping guides for spacing and angles, slider previews on the timeline, colours and hotkeys you already know."],
  ["M4 5h16v11H9l-5 4z", "Modding tools", "Mod notes with osu! timestamps, annotations (comments, arrows, highlights) on the objects, side lists to follow them through the map, and checks for common issues."],
  ["M4 9v6h4l5 4V5L8 9z|M16.5 8.5a5 5 0 0 1 0 7", "Hitsound Studio", "All hitsounds in lanes under the timeline: stretch them, go full screen with a tool dock, right-click for sample sets and green lines, slider ticks, and keysound numbering for piano-style hitsounding."],
  ["c12,12,2.5|M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4|M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2", "Live mapping", "Map and mod with friends in real time: a live session led by the host, or a collab where everyone edits one difficulty and the changes merge. With chat, where everyone is in the song and a log of recent changes."],
  ["M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.2 4.4 4.4 0 0 0 7 18z|M12 15V10M9.5 12.5L12 10l2.5 2.5", "Online projects", "Save a whole beatmap package privately, share it with people by osu! name or with a read-only link, and never lose work: drafts are kept on your device too."],
  ["c12,8,4|M4 21a8 8 0 0 1 16 0", "Mapper pages", "A mapper's groups, badges, ranked, loved, guest and pending maps, recent mapping activity and kudosu, all in one page."],
  ["M3 5h12M9 3v2M5 5c1.5 4 4.5 7 9 9M13 5c-1 4-4 8-9 10|M13 21l4-9 4 9M14.5 18h5", "In your language, on any device", "English, ไทย, Bahasa Melayu, Bahasa Indonesia, 한국어 and 日本語. Nothing to install: it works in the browser on a computer, a tablet or a phone."],
];
// the home page's feature cards (index.html, #homeFeats) get the same icons as the access page's
function homeFeatIcons() { document.querySelectorAll("#homeFeats .mic[data-feat]").forEach(m => { const f = GATE_FEATURES[+m.dataset.feat]; if (f && !m.firstChild) m.append(gateIcon(f[0])); }); }
function gateIcon(spec) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const part of spec.split("|")) {
    let el;
    if (part[0] === "c") { const [x, y, r] = part.slice(1).split(",").map(Number); el = document.createElementNS(NS, "circle"); el.setAttribute("cx", x); el.setAttribute("cy", y); el.setAttribute("r", r); }
    else { el = document.createElementNS(NS, "path"); el.setAttribute("d", part); }
    svg.append(el);
  }
  return svg;
}
// ---------- permissions: what this visitor may use (Admin → Settings → Permissions; the server checks the same) ----------
// Everything while the site is open, for admins, and for members per the Member column; guests (not logged in, or not
// approved) per the Guest column. When guests may use something, they get the app with the rest hidden (and a
// "Request access" button); when they may use nothing, they get this page.
const PERM_AREAS = ["listing", "player", "mappers", "editor", "online", "live"]; // live: watch live sessions (members: with online)
const PERM_ALL = Object.fromEntries(PERM_AREAS.map(a => [a, true])), PERM_NONE = Object.fromEntries(PERM_AREAS.map(a => [a, false]));
let PERM = DEMO_TOUR ? PERM_ALL : (() => { try { const v = JSON.parse(localStorage.getItem("obv-perm") || "null"); return v && typeof v === "object" ? { ...PERM_ALL, ...v } : PERM_ALL; } catch { return PERM_ALL; } })();
const can = a => PERM[a] !== false;
const isGuest = me => !!(me && me.gate && !me.admin && !(me.access === "approved" && me.status !== "suspended"));
function permOf(me) {
  if (!me || !me.gate || me.admin) return PERM_ALL;
  const P = me.perms || { guest: PERM_NONE, member: PERM_ALL };
  return isGuest(me) ? { ...PERM_NONE, ...P.guest, online: false } : { ...PERM_ALL, ...P.member };
}
const guestCanBrowse = () => PERM.listing || PERM.player || PERM.mappers;
function permApply() {
  for (const a of PERM_AREAS) document.body.classList.toggle("noperm-" + a, !PERM[a]);
  const gr = $("guestReq"); if (gr) gr.hidden = !GATE.guest;
}
function permSet(me) {
  if (DEMO_TOUR) return false; // the tour and the playable demo on the access page show the whole editor
  const was = JSON.stringify(PERM); PERM = permOf(me); GATE.guest = isGuest(me) && guestCanBrowse();
  try { localStorage.setItem("obv-perm", JSON.stringify(PERM)); } catch {}
  permApply(); return was !== JSON.stringify(PERM);
}
// a guest who can browse opens this page from "Request access" (it's also their home page) and enters the app with
// "Browse beatmaps"
function gateOpenAsGuest() { history.pushState(null, "", location.pathname); gateLock(); }
function gateBrowse() {
  gateInviteClean();
  const p = new URLSearchParams(location.search), need = routeNeeds(p);
  if (!need || !need.some(can)) history.pushState(null, "", location.pathname + (PERM.listing ? "?view=songs" : ""));
  gateUnlock(false);
}
permApply();
if ($("guestReq")) $("guestReq").onclick = gateOpenAsGuest;

// before the first route(): decide whether the app opens or this page does
// The answer can take a moment (a cold server start), so the screen this browser showed last time (the app or the
// invite page, remembered as "obv-gate") opens at once and the answer only corrects it when something changed.
// Links that log in, ask, accept or carry an invite always wait for the answer.
const gateHint = () => { try { return localStorage.getItem("obv-gate") || ""; } catch { return ""; } };
const gateHintSet = v => { try { v ? localStorage.setItem("obv-gate", v) : localStorage.removeItem("obv-gate"); } catch {} };
async function gateBoot() {
  if (DEMO_TOUR && window.parent !== window) return DEMO_TRY ? tryStart() : tourStart(); // the frames on the invite page (demo.js)
  const q0 = new URLSearchParams(location.search), special = ["login", "access", "accept", "invite"].some(k => q0.has(k));
  const early = special ? "" : gateHint(), meP = cloudMe(true);
  if (early === "open") route();
  else if (early === "locked") { GATE.me = { gate: true }; gateLock(); }
  const me = await meP;
  GATE.me = me;
  const changed = permSet(me);
  const locked = isGuest(me) && (!GATE.guest || special); // guests who can browse get the app (an invite, login or request link shows this page)
  if (me && me.gate != null) gateHintSet(locked ? "locked" : "open");
  if (GATE.guest && me.access === "pending") gatePoll();
  if (early === "open") { if (locked) gateLock(); else if (changed || GATE.guest) route(); return; }
  if (early === "locked") { if (!locked) gateUnlock(false); else { gateRefresh(); if (me.access === "pending") gatePoll(); } return; }
  if (locked) return gateLock();
  if (new URLSearchParams(location.search).has("invite")) { gateInviteClean(); if (me && me.gate && me.user) toast(tr("You already have access"), 2500); } // an invite link, but no need for it
  route();
}
async function gateLock() {
  GATE.locked = true;
  const p = new URLSearchParams(location.search), v = p.get("view");
  if (!p.get("s") && !p.get("b") && GATE_OPEN_VIEWS.has(v)) { document.body.classList.remove("gated"); $("gate").hidden = true; route(); return; }
  document.body.classList.add("gated"); $("gate").hidden = false;
  const login = p.get("login"), ask = p.get("access") === "request";
  if (login || ask) { p.delete("login"); p.delete("access"); history.replaceState(history.state, "", location.pathname + (p.toString() ? "?" + p : "")); }
  if (login && login !== "ok" && !/^linked_/.test(login) && !(login === "google_new" && GATE.me && GATE.me.google_pending)) toast(tr("Login failed: {err}", { err: loginWhy(login) }), 7000);
  if (login === "google_new" && !p.has("invite")) setTimeout(() => { const a = $("gateAsk"); if (a) a.scrollIntoView({ behavior: "smooth", block: "center" }); }, 400);
  await gateInviteLoad();
  const acceptNow = () => { if (GATE.me.user && gateInviteOk()) gateAccept(); else { const q = new URLSearchParams(location.search); q.delete("accept"); history.replaceState(history.state, "", location.pathname + "?" + q); } };
  // an invite link: the invitation scene first (invscene.js), unless the inviter turned it off; the regular page only if they look around
  if (GATE.invite && !(GATE.invite.info && GATE.invite.info.fx === false)) {
    gisShow();
    if (p.get("accept") === "1") acceptNow();
    return;
  }
  gateRender();
  if (GATE.invite) { if (p.get("accept") === "1") acceptNow(); }
  else if (ask && GATE.me.user && (GATE.me.access === "none" || !GATE.me.access)) gateRequest("");
  if (GATE.me.access === "pending") gatePoll();
  demoStart();
}
function gateUnlock(msg) {
  permSet(GATE.me); GATE.locked = false; clearInterval(GATE.poll); GATE.poll = 0;
  document.body.classList.remove("gated"); $("gate").hidden = true;
  if (GATE.stage) { GATE.stage.remove(); GATE.stage = null; GATE.tell = null; } // stops the tour
  gateTryClose();
  const demo = $("heroDemo"); if (demo) $("homeView").querySelector(".hero").prepend(demo);
  demoStop(); if (msg !== false) toast(msg || tr("You're in! Welcome to KIKI BEATMAP VIEWER."), 3500);
  route();
}
function gatePoll() {
  if (GATE.poll) return;
  GATE.poll = setInterval(async () => {
    if (document.hidden) return;
    const me = await cloudMe(true); GATE.me = me;
    if (!me.gate || me.access === "approved") gateUnlock(); else if (me.access !== "pending") { clearInterval(GATE.poll); GATE.poll = 0; if (GATE.locked) gateRender(); }
  }, 30000);
}
function gateLoginURL(kind, via = "osu") { // after logging in: send the access request, or accept the invite in the URL
  const p = new URLSearchParams(location.search); if (kind === "accept") p.set("accept", "1"); else p.set("access", "request");
  const next = encodeURIComponent(location.pathname + "?" + p);
  return via === "google" ? "/api/auth/google?mode=login&next=" + next : "/api/auth/login?next=" + next;
}
// Request access with Google: signed in with a Google account that isn't linked yet, they type their osu! name
async function gateGoogleRequest(osu, message) {
  if (GATE.sending) return; GATE.sending = true; gateRender();
  try {
    await capi("POST", "access/request-google", { osu, message });
    toast(tr("Request sent. You'll get in as soon as an admin approves it."), 3500);
    setTimeout(() => location.replace(location.pathname + location.search), 600); // (now logged in: the page shows the pending request)
  } catch (e) {
    const r = e.detail && e.detail.reason;
    toast(e.code === "conflict" && r === "osu_in_use" ? tr("This osu! account already uses the site: log in with osu! instead, or ask an admin.")
      : e.code === "conflict" && r === "linked_elsewhere" ? tr("This Google account is already linked to another osu! account here.")
      : e.code === "user_not_found" ? tr("No osu! user with that name") : e.code === "osu_lookup_failed" ? tr("Couldn't look up that osu! name right now; try again in a few minutes.")
      : e.code === "google_expired" ? tr("Your Google sign-in expired; sign in with Google again.") : e.code === "too_soon" ? tr("You can ask again a day after the last answer.")
      : tr("Couldn't send the request: {err}", { err: e.message }), 5000);
    GATE.sending = false; gateRender();
  }
}
// ---------- invite links (?invite=CODE): someone with access lets this person in at once (limits: Admin) ----------
async function gateInviteLoad() {
  const code = new URLSearchParams(location.search).get("invite");
  if (!code || !/^[A-Za-z0-9]{10}$/.test(code)) { GATE.invite = code ? { code, err: "not_found" } : null; return; }
  GATE.invite = { code, info: null };
  try { GATE.invite.info = await capi("GET", "invite?code=" + code); } catch (e) { GATE.invite.err = e.code || "error"; }
}
function gateInviteClean() { const p = new URLSearchParams(location.search); p.delete("invite"); p.delete("accept"); history.replaceState(history.state, "", location.pathname + (p.toString() ? "?" + p : "")); }
const gateInviteOk = () => !!(GATE.invite && GATE.invite.info && GATE.invite.info.ok);
async function gateAccept() {
  const I = GATE.invite; if (!I || GATE.sending) return;
  GATE.sending = true; gateRefresh();
  try {
    const r = await capi("POST", "invite/accept", { code: I.code });
    gateInviteClean(); GATE.invite = null;
    if (r.access === "approved") {
      GATE.me.access = "approved"; GATE.sending = false;
      if (gisWelcome(r.inviter ? r.inviter.username : "")) return; // the invitation scene says welcome, then opens the home page
      return gateUnlock(r.inviter ? tr("You're in! {n} invited you.", { n: r.inviter.username }) : "");
    }
  } catch (e) {
    toast(e.code === "invite_full" ? tr("This invite link has been used up.") : e.code === "invite_inactive" ? tr("This invite link isn't active.")
      : e.code === "forbidden" ? tr("An admin declined your access request, so an invite can't let you in.") : e.code === "suspended" ? tr("This account is suspended on this site.")
      : tr("Couldn't accept the invite: {err}", { err: e.message }), 5000);
    if (I.info && e.code !== "network") I.info.ok = false;
    const q = new URLSearchParams(location.search); q.delete("accept"); history.replaceState(history.state, "", location.pathname + "?" + q);
  } finally { GATE.sending = false; if (GATE.locked && !GIS.welcome) gateRefresh(); }
}
const gateRefresh = () => $("gis") ? gisRender() : gateRender();
// the invite's accept buttons for someone not logged in: osu! or Google (Google works without osu!)
function gateInviteActs(cls) {
  const me = GATE.me || {}, out = [];
  const a = h("a", cls); a.href = gateLoginURL("accept"); a.append(osuMark(), h("span", null, tr("Accept the invite with osu!"))); out.push(a);
  if (altOn(me).length) { const g = h("a", cls + " alt"); g.href = gateLoginURL("accept", "google"); g.append(altMark("google"), h("span", null, tr("Accept the invite with Google"))); out.push(g); }
  return out;
}
function gateInviteBox() {
  const I = GATE.invite; if (!I) return null;
  const box = h("section", "ginv"), me = GATE.me || {};
  if (!I.info) {
    box.classList.add("bad");
    box.append(h("b", null, tr("This invite link doesn't work")), h("span", null, tr("It may have been replaced by a new one. You can still ask for access at the bottom of the page.")));
    return box;
  }
  const inv = I.info.inviter, who = h("div", "ginvwho"), t = h("div");
  t.append(h("b", null, tr("{n} invited you to KIKI BEATMAP VIEWER", { n: inv.username })), h("span", null, tr("Accept with your osu! account and you're in straight away, no waiting.")));
  who.append(avatarEl(inv.id, inv.username, "mav"), t); box.append(who);
  if (!I.info.ok) {
    box.classList.add("bad");
    box.append(h("p", "gstate bad", I.info.reason === "full" ? tr("This invite link has been used up. Ask {n} to have more invites, or ask for access below.", { n: inv.username }) : tr("This invite link isn't active. You can still ask for access below.")));
    return box;
  }
  if (!me.user) {
    box.append(...gateInviteActs("btn main gbig"));
  } else {
    const b = h("button", "btn main gbig", GATE.sending ? tr("Sending…") : tr("Accept the invite")); b.disabled = GATE.sending; b.onclick = gateAccept;
    box.append(b, h("small", "hint", tr("Logged in as {n}", { n: me.user.username })));
  }
  return box;
}
async function gateRequest(message) {
  if (GATE.sending) return; GATE.sending = true; gateRender();
  try {
    const r = await capi("POST", "access/request", { message });
    GATE.me.access = r.access; GATE.me.access_requested_at = r.access_requested_at || GATE.me.access_requested_at;
    if (r.access === "approved") return gateUnlock();
    toast(message ? tr("Note sent to the admins") : tr("Request sent. You'll get in as soon as an admin approves it."), 3500);
    gatePoll();
  } catch (e) {
    toast(e.code === "too_soon" ? tr("You can ask again a day after the last answer.") : tr("Couldn't send the request: {err}", { err: e.message }), 4000);
  } finally { GATE.sending = false; gateRender(); }
}
function gateAskBox() {
  const me = GATE.me || {}, u = me.user, a = me.access || "none", box = h("div", "gask");
  box.id = "gateAsk";
  box.append(h("h3", null, tr("Get access")));
  if (!u && me.google_pending) { // back from Google with an account that isn't linked: which osu! account is it for?
    box.append(h("p", null, tr("You signed in with Google. Which osu! account is this request for?")));
    const osu = h("input", "gosu"); osu.type = "text"; osu.maxLength = 40; osu.autocomplete = "off"; osu.placeholder = tr("osu! username or profile link"); osu.setAttribute("aria-label", tr("osu! username"));
    const note = h("textarea", "gnote"); note.maxLength = 300; note.rows = 2; note.placeholder = tr("Anything the admins should know? (optional, e.g. who invited you)");
    for (const el of [osu, note]) el.addEventListener("keydown", e => e.stopPropagation());
    const b = h("button", "btn main gbig", GATE.sending ? tr("Sending…") : tr("Request access")); b.disabled = GATE.sending;
    b.onclick = () => { const v = osu.value.trim(); if (!v) { osu.focus(); return; } gateGoogleRequest(v, note.value.trim()); };
    box.append(osu, note, b, h("small", "hint", tr("The admins see that this request came with Google and that the osu! name isn't verified yet. Log in with osu! once later (in this browser) to confirm it.")));
    return box;
  }
  if (!u) {
    box.append(h("p", null, tr("KIKI BEATMAP VIEWER is invite-only for now. Log in to ask for access: an admin looks at every request.")));
    const b = h("a", "btn main gbig"); b.href = gateLoginURL(); b.append(osuMark(), h("span", null, tr("Request access with osu!")));
    box.append(b);
    if (altOn(me).length) { const g = h("a", "btn ghost gbig"); g.href = gateLoginURL("", "google"); g.append(altMark("google"), h("span", null, tr("Request access with Google"))); box.append(g); }
    box.append(h("small", "hint", tr("We only read your public osu! profile (name, avatar, country), never your password. With Google, only your account's ID at Google, no e-mail. See Privacy.")));
    return box;
  }
  const who = h("div", "gwho"); who.append(avatarEl(u.id, u.username, "mav"));
  const nm = h("div"); nm.append(h("b", null, u.username), h("small", null, u.google_only || u.id >= 1e12 ? tr("logged in with Google") : "#" + u.id)); who.append(nm);
  const out = h("a", "mlink", tr("Not you? Log out")); out.href = "/api/auth/logout?next=" + encodeURIComponent(location.pathname + location.search); who.append(out);
  box.append(who);
  if (me.status === "suspended") { box.append(h("p", "gstate bad", tr("This account is suspended on this site."))); return box; }
  const note = h("textarea", "gnote"); note.maxLength = 300; note.rows = 2; note.placeholder = tr("Anything the admins should know? (optional, e.g. who invited you)");
  note.addEventListener("keydown", e => e.stopPropagation());
  if (a === "pending") {
    const st = h("div", "gstate pend"); st.append(h("b", null, tr("Pending approval")), h("span", null, tr("Your request is waiting for an admin. This page lets you in by itself as soon as it's approved.")));
    if (me.access_requested_at) st.append(h("small", null, tr("Requested {d}", { d: new Date(me.access_requested_at).toLocaleString() })));
    box.append(st, note);
    const row = h("div", "btnrow"), send = h("button", "btn ghost sm", tr("Send the note")), again = h("button", "btn ghost sm", "↻ " + tr("Check again"));
    send.disabled = GATE.sending; send.onclick = () => { if (note.value.trim()) gateRequest(note.value.trim()); };
    again.onclick = async () => { again.disabled = true; const m = await cloudMe(true); GATE.me = m; if (!m.gate || m.access === "approved") gateUnlock(); else { gateRender(); toast(tr("Still pending"), 1500); } };
    row.append(send, again); box.append(row);
    return box;
  }
  if (a === "denied") box.append(h("p", "gstate bad", tr("Your last request wasn't approved. You can ask again a day after the answer.")));
  box.append(note);
  const b = h("button", "btn main gbig", GATE.sending ? tr("Sending…") : a === "denied" ? tr("Ask again") : tr("Request access")); b.disabled = GATE.sending;
  b.onclick = () => gateRequest(note.value.trim());
  box.append(b);
  return box;
}
// the live tour: the real app in a frame, driven by demo.js (created once: moving a frame would reload it). It plays the
// chapters one after another, and only while it's on screen (so the page stays light).
function gateStage() {
  if (GATE.stage) return GATE.stage;
  const st = h("section", "gstage"), head = h("div", "gshead"), box = h("div", "gsbox"), screen = h("div", "gscreen"), fr = h("iframe");
  fr.src = location.pathname + "?demo=tour"; fr.loading = "lazy"; fr.tabIndex = -1; fr.setAttribute("aria-hidden", "true"); fr.title = "KIKI BEATMAP VIEWER";
  const cap = h("div", "gcap"), chaps = h("ol", "gchaps");
  screen.append(fr); box.append(screen, chaps); st.append(head, box, cap);
  GATE.stage = st; GATE.frame = fr; GATE.chap = 0;
  const fit = () => { const w = screen.clientWidth; if (!w) return; const k = w / 1280; fr.style.transform = `scale(${k})`; screen.style.height = Math.round(720 * k) + "px";
    chaps.style.maxHeight = getComputedStyle(box).gridTemplateColumns.split(" ").length > 1 ? Math.round(720 * k) + "px" : ""; };
  new ResizeObserver(fit).observe(screen);
  const tell = msg => { try { fr.contentWindow && fr.contentWindow.postMessage({ obv: "tour", ...msg }, location.origin); } catch {} };
  GATE.tell = tell;
  const vis = () => tell({ cmd: "visible", on: !!GATE.seen && !document.hidden && !$("gateTry") });
  GATE.vis = vis;
  new IntersectionObserver(es => { GATE.seen = es[es.length - 1].isIntersecting; vis(); }, { threshold: .15 }).observe(screen);
  document.addEventListener("visibilitychange", vis);
  fr.addEventListener("load", vis);
  addEventListener("message", e => { if (e.origin === location.origin && e.source === fr.contentWindow && e.data && e.data.obv === "tour" && Number.isInteger(e.data.i)) { GATE.chap = e.data.i; gateStageText(); } });
  return st;
}
// the playable demo editor, full screen (demo.js tryStart): the same editor on the same map, nothing saved
function gateTry() {
  if ($("gateTry")) return;
  const o = h("div", "gtry"), bar = h("div", "gtrybar"), fr = h("iframe"), me = GATE.me || {};
  o.id = "gateTry"; o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true"); o.setAttribute("aria-label", tr("Try the editor"));
  const info = h("div", "gtryinfo"); info.append(h("b", null, tr("Try the editor")), h("span", null, tr("The real editor on a demo map. Click, drag, place, hitsound: nothing is saved.")));
  const acts = h("div", "gacts");
  if (me.access !== "pending") {
    const req = me.user ? h("button", "btn main sm", tr("Request access")) : h("a", "btn main sm", tr("Request access"));
    if (me.user) req.onclick = () => { gateTryClose(); gateRequest(""); }; else req.href = gateLoginURL();
    acts.append(req);
  } else acts.append(h("span", "gpill", tr("Pending approval")));
  const reset = h("button", "btn ghost sm", "↺ " + tr("Start over"));
  reset.onclick = () => { try { fr.contentWindow.postMessage({ obv: "try", reset: true }, location.origin); fr.contentWindow.focus(); } catch {} };
  acts.prepend(reset);
  const x = h("button", "icon gtryx", "✕"); x.setAttribute("aria-label", tr("Close")); x.onclick = gateTryClose; acts.append(x);
  bar.append(info, acts);
  fr.src = location.pathname + "?demo=try"; fr.title = tr("Try the editor"); fr.allow = "fullscreen";
  o.append(bar, fr); document.body.append(o); document.body.classList.add("gtrying"); GATE.vis && GATE.vis(); // the tour rests meanwhile
  fr.addEventListener("load", () => { try { fr.contentWindow.focus(); } catch {} });
}
function gateTryClose() {
  const o = $("gateTry"); if (!o) return;
  o.remove(); document.body.classList.remove("gtrying");
  GATE.vis && GATE.vis(); // the tour picks up again
}
addEventListener("message", e => { if (e.origin === location.origin && e.data && e.data.obv === "try" && e.data.close) gateTryClose(); });
addEventListener("keydown", e => { if (e.key === "Escape" && $("gateTry")) gateTryClose(); });
function gateStageText() {
  const st = GATE.stage; if (!st) return;
  const head = st.querySelector(".gshead"), chaps = st.querySelector(".gchaps"), cap = st.querySelector(".gcap"), i = GATE.chap || 0;
  if (!head.firstChild || head.dataset.lang !== LANG) {
    head.dataset.lang = LANG; head.innerHTML = "";
    head.append(h("h3", null, tr("See it in action")), h("p", null, tr("This is the real editor running on a real map, with a pretend mouse. Pick a chapter to jump to it.")));
    chaps.innerHTML = "";
    TOUR_TEXT.forEach(([t], k) => {
      const li = h("li"), b = h("button", "gchap"); b.type = "button";
      b.append(h("em", null, String(k + 1)), h("span", null, tr(t)));
      b.onclick = () => { GATE.chap = k; gateStageText(); GATE.tell({ cmd: "goto", i: k }); };
      li.append(b); chaps.append(li);
    });
  }
  chaps.querySelectorAll(".gchap").forEach((b, k) => b.classList.toggle("on", k === i));
  const on = chaps.children[i]; if (on && chaps.scrollWidth > chaps.clientWidth + 4) chaps.scrollTo({ left: on.offsetLeft - 16, behavior: "smooth" });
  if (cap.dataset.i !== String(i) || cap.dataset.lang !== LANG) {
    cap.dataset.i = i; cap.dataset.lang = LANG; cap.innerHTML = "";
    const t = h("div", "gcapin"), txt = h("div"), tb = h("button", "btn main sm", "▶ " + tr("Try it yourself")); tb.onclick = gateTry;
    txt.append(h("b", null, `${i + 1}. ${tr(TOUR_TEXT[i][0])}`), h("span", null, tr(TOUR_TEXT[i][1]))); t.append(txt, tb); cap.append(t);
  }
}
function gateLang() {
  const lang = h("select", "langsel"); lang.setAttribute("aria-label", "Language");
  LANGS.forEach(([c, n]) => lang.add(new Option(n, c))); lang.value = LANG; lang.onchange = () => { setLang(lang.value); GATE.tell && GATE.tell({ cmd: "lang", lang: lang.value }); };
  return lang;
}
function gateActs() {
  const me = GATE.me || {}, u = me.user, a = me.access || "none", acts = h("div", "gacts");
  if (GATE.guest) { // into the app: the page in the address bar if they may use it, else the first part they can use (on phones: the hero's button)
    const back = h("button", "btn ghost sm gback", tr(PERM.listing ? "Browse beatmaps" : "Open the site")); back.onclick = gateBrowse; acts.append(back); }
  if (!u) {
    const login = h("a", "btn ghost sm gbtn"); login.href = "/api/auth/login?next=" + encodeURIComponent(location.pathname + location.search);
    login.append(osuMark(), h("span", null, tr("Log in"))); acts.append(login);
    if (altOn(me).length) acts.append(altButtons("gbtn", me, "short"));
    const req = h("a", "btn main sm"); req.href = gateLoginURL(gateInviteOk() ? "accept" : ""); req.textContent = tr(gateInviteOk() ? "Accept the invite" : "Request access"); acts.append(req);
    return acts;
  }
  const chip = h("button", "gchip"); chip.type = "button"; chip.append(avatarEl(u.id, u.username), h("span", null, u.username));
  chip.onclick = () => $("gateAsk").scrollIntoView({ behavior: "smooth", block: "center" }); acts.append(chip);
  if (gateInviteOk() && me.status !== "suspended") { const b = h("button", "btn main sm", tr("Accept the invite")); b.disabled = GATE.sending; b.onclick = gateAccept; acts.append(b); }
  else if (a === "pending") acts.append(h("span", "gpill", tr("Pending approval")));
  else if (me.status !== "suspended") { const req = h("button", "btn main sm", tr(a === "denied" ? "Ask again" : "Request access")); req.disabled = GATE.sending; req.onclick = () => gateRequest(""); acts.append(req); }
  return acts;
}
// a live session's code (or its invite link), only when Admin → Permissions lets guests watch (else not shown at all)
function gateLiveBox() {
  if (!can("live")) return "";
  const f = h("form", "glive"), row = h("div", "glrow"), inp = h("input"), go = h("button", "btn ghost sm", tr("Join"));
  inp.placeholder = tr("Session code"); inp.autocomplete = "off"; inp.maxLength = 300; inp.setAttribute("aria-label", tr("Session code"));
  row.append(h("span", null, tr("Join live mapping")), inp, go);
  f.append(row, h("small", "hint", tr("Type the code or paste the invite link to watch a live session. You only watch: the host edits.")));
  f.onsubmit = e => {
    e.preventDefault(); if (!can("live")) return;
    const v = inp.value.trim(), link = v.match(/[?&]live=([a-z0-9]+)/i), lt = v.match(/[?&]lt=([0-9a-z]{1,12}\.[A-Za-z0-9_-]{22})/);
    const code = (link ? link[1] : v).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
    if (!code) return inp.focus();
    history.pushState(null, "", location.pathname + "?live=" + code + (lt ? "&lt=" + lt[1] : ""));
    gateBrowse(); // into the app, which opens the join dialog for this code
  };
  return f;
}
function gateRender() {
  const g = $("gate"); if (!g || g.hidden) return;
  const keepDemo = $("heroDemo"), stage = gateStage();
  for (const c of [...g.children]) if (c !== stage) c.remove();
  const top = h("header", "gtop"), brand = h("div", "brand"); brand.append(h("div", "logo"), h("strong", "bname", "KIKI BEATMAP VIEWER"));
  top.append(brand, gateLang(), gateActs()); // (phones: logo and language on top, the buttons on their own row)
  const hero = h("section", "hero ghero"); if (keepDemo) hero.append(keepDemo);
  hero.append(h("h1", null, tr("Preview, mod and map osu! beatmaps right in your browser")),
    h("p", null, tr("KIKI BEATMAP VIEWER is invite-only for now. Here's everything it can do. Ask for access with your osu! account at the bottom of the page.")));
  const more = h("button", "btn ghost", tr("See what it can do") + " ↓"); more.onclick = () => stage.scrollIntoView({ behavior: "smooth" });
  const tryB = h("button", "btn main", "▶ " + tr("Try the editor")); tryB.onclick = gateTry;
  const hb = h("div", "btnrow ghbtns"); hb.append(tryB);
  if (GATE.guest) { const br = h("button", "btn ghost", tr(PERM.listing ? "Browse beatmaps" : "Open the site") + " →"); br.onclick = gateBrowse; hb.append(br); }
  hb.append(more); hero.append(hb, gateLiveBox());
  const grid = h("section", "gfeat");
  for (const [icon, title, text] of GATE_FEATURES) {
    const c = h("article", "gcard"), ic = h("span", "mic"); ic.append(gateIcon(icon));
    c.append(ic, h("b", null, tr(title)), h("span", null, tr(text))); grid.append(c);
  }
  const how = h("section", "ghow");
  how.append(h("h3", null, tr("How to get in")));
  const ol = h("ol");
  for (const t of ["Log in with osu! (only your public profile is read).", "Your request goes to the site's admins, marked pending.", "Once approved, this page opens the app by itself."]) ol.append(h("li", null, tr(t)));
  how.append(ol);
  const foot = h("footer", "foot"), nav = h("nav");
  for (const [v, l] of [["guide", "Guide"], ["credits", "Credits"], ["privacy", "Privacy"], ["changelog", "Changelog"]]) { const a = h("a", null, tr(l)); a.href = "?view=" + v; nav.append(a); }
  const rp = h("a", null, tr("Report a problem")); rp.href = "#"; rp.onclick = e => { e.preventDefault(); openReport(); }; nav.append(rp);
  const gh = h("a", null, "GitHub"); gh.href = "https://github.com/Lacrymiraosu/kiki-beatmap-viewer"; gh.target = "_blank"; gh.rel = "noopener"; nav.append(gh);
  foot.append(nav, h("small", null, tr("Not affiliated with ppy Pty Ltd. osu! is a trademark of ppy Pty Ltd.")));
  if (!stage.parentNode) g.append(stage);
  g.insertBefore(top, stage); const ib = gateInviteBox(); if (ib) g.insertBefore(ib, stage); g.insertBefore(hero, stage);
  stage.after(grid, how, gateAskBox(), foot);
  gateStageText();
}
addEventListener("langchange", () => { if (GATE.locked) gateRender(); });
document.addEventListener("visibilitychange", () => { if (!GATE.locked || $("gate").hidden) return; if (document.hidden) demoStop(); else demoStart(); });
homeFeatIcons();
