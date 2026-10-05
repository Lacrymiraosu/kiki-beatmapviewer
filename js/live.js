"use strict";
// ============ osu! login (OAuth through /api/auth/*) ============
// The server functions keep the client secret; the page only learns { id, username, avatar } and gets a short-lived
// signed "ticket" it can show to other people in a live session (they check it with /api/auth/verify).
const AUTH = { user: null, ticket: null, checked: false, api: false, dev: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) };
const liveUser = () => AUTH.user && !AUTH.user.google_only ? AUTH.user : null; // (signed in with Google only: no osu! identity for live sessions)
async function authCheck() {
  try {
    const r = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    if ((r.headers.get("content-type") || "").includes("json")) { AUTH.api = true; const j = await r.json(); AUTH.user = j.user || null; AUTH.ticket = j.ticket || null; }
  } catch {}
  AUTH.checked = true; renderAccount();
  if (typeof R !== "undefined" && R.view === "account" && typeof renderAccountPage === "function") renderAccountPage(); // (opened before the login check)
  if (CR && !CR.meta.Creator && liveUser()) CR.meta.Creator = AUTH.user.username;
}
const osuMark = () => { const i = h("i", "osumark"); i.setAttribute("aria-hidden", "true"); return i; };
// admins: people waiting for an answer to their access request + errors nobody has looked at (GET me → badges)
const adminWaiting = () => { const b = typeof CLOUD !== "undefined" && CLOUD.me && CLOUD.me.admin && CLOUD.me.badges; return b ? (b.pending || 0) + (b.errors || 0) : 0; };
function adminWaitingText() {
  const b = CLOUD.me.badges || {}, t = [];
  if (b.pending) t.push(tr("{n} waiting for access", { n: b.pending }));
  if (b.errors) t.push(tr("{n} new errors", { n: b.errors }));
  return t.join(" · ");
}
function renderAccount() {
  const b = $("acctBtn"); b.innerHTML = "";
  if (AUTH.user) { const av = h("i", "av"); if (AUTH.user.avatar) av.style.backgroundImage = `url("${AUTH.user.avatar}")`; b.append(av, h("span", null, AUTH.user.username)); b.setAttribute("aria-label", tr("Account")); }
  else { b.append(osuMark(), h("span", "acctl", tr("Log in"))); b.setAttribute("aria-label", tr("Log in with osu!")); }
  b.classList.toggle("out", !AUTH.user);
  const n = adminWaiting(); if (AUTH.user && n) { const d = h("span", "acctdot", n > 99 ? "99+" : String(n)); d.title = adminWaitingText(); b.append(d); }
  const p = $("acctPop"); if (!p.hidden) fillAcct();
}
function fillAcct() {
  const p = $("acctPop"); p.innerHTML = "";
  if (AUTH.user) {
    const top = h("div", "acctme"), av = h("i", "av big"); if (AUTH.user.avatar) av.style.backgroundImage = `url("${AUTH.user.avatar}")`;
    const go = !!AUTH.user.google_only;
    const nm = h("div"); nm.append(h("b", null, AUTH.user.username), h("small", null, AUTH.user.dev ? tr("dev login (this computer only)") : go ? tr("logged in with Google") : tr("logged in with osu!")));
    top.append(av, nm); p.append(top);
    if (go) { // no osu! account yet: logging in with osu! moves everything there (and is needed for live sessions)
      const li = h("button", "btn main sm wide", tr("Log in with osu!")); li.prepend(osuMark()); li.onclick = authLogin;
      p.append(li, h("small", "hint", tr("For live sessions. Your access and projects move to your osu! account, and Google keeps working as a way in.")));
    }
    // your mapper page on this site (profile, maps, groups, recent activity)
    const me = h("a", "btn " + (go ? "ghost" : "main") + " sm wide", tr("My profile")); me.dataset.perm = "mappers"; me.href = listURL({ u: AUTH.user.username, q: "", st: "" });
    me.onclick = e => { e.preventDefault(); p.hidden = true; goMapper(AUTH.user.username); };
    if (!go) p.append(me);
    if (AUTH.user.id > 0 && !go) { const a = h("a", "btn ghost sm wide", tr("osu! profile")); a.href = `https://osu.ppy.sh/users/${AUTH.user.id}`; a.target = "_blank"; a.rel = "noopener"; p.append(a); }
    if (typeof cloudEnabled === "function" && cloudEnabled() && can("online")) { const a = h("a", "btn ghost sm wide", tr("My online projects")); a.href = "?view=projects"; a.dataset.go = "projects"; a.onclick = () => p.hidden = true; p.append(a); }
    if (CLOUD.me && CLOUD.me.gate && CLOUD.me.access === "approved" && can("online")) { const a = h("a", "btn ghost sm wide", tr("Invite friends")); a.href = "?view=invite"; a.dataset.go = "invite"; a.onclick = () => p.hidden = true; p.append(a); }
    if (CLOUD.me && CLOUD.me.admin) {
      const a = h("a", "btn ghost sm wide", tr("Admin dashboard")); a.href = "?view=admin"; a.dataset.go = "admin"; a.onclick = () => p.hidden = true;
      const bd = CLOUD.me.badges || {}; // open the tab that needs a look: access requests first, then errors
      if (bd.pending || bd.errors) { const c = h("span", "acnt", String(adminWaiting())); c.title = adminWaitingText(); a.append(c); a.href = "?view=admin"; a.onclick = () => { p.hidden = true; if (typeof ADM !== "undefined") ADM.tab = bd.pending ? "access" : "errors"; }; }
      p.append(a);
    }
    if (!AUTH.user.dev && cloudEnabled()) { const a = h("a", "btn ghost sm wide", tr("Account settings")); a.href = "?view=account"; a.dataset.go = "account"; a.onclick = () => p.hidden = true; p.append(a); }
    const lo = h("button", "btn ghost sm wide", tr("Log out")); lo.onclick = authLogout; p.append(lo);
  } else {
    p.append(h("p", "hint", tr("Log in with your osu! account to host or join live mapping sessions. We only get your osu! username, ID and avatar, never your password.")));
    const li = h("button", "btn main wide", tr("Log in with osu!")); li.prepend(osuMark()); li.onclick = authLogin; p.append(li);
    if (altOn().length) p.append(altButtons("wide"), h("small", "hint althint", tr("With Google you get in without osu!; live sessions still need an osu! login.")));
  }
  const ins = typeof installButton === "function" && installButton(); if (ins) { ins.addEventListener("click", () => p.hidden = true); p.append(ins); }
  const pv = h("a", "mlink", tr("Privacy")); pv.href = "?view=privacy"; pv.dataset.go = "privacy"; p.append(pv);
}
// ---------- backup login (Google) for when osu!'s login doesn't work, for osu! accounts that linked one ----------
const ALT = [["google", "Google"]]; // (one list, so another provider is one line)
const altOn = (me = CLOUD.me) => { const a = me && me.alt; return ALT.filter(([k]) => a && a[k]); };
const altURL = (k, mode) => `/api/auth/${k}?mode=${mode}&next=` + enc(location.pathname + location.search);
function altMark(k) {
  const i = h("i", "altmark " + k); i.setAttribute("aria-hidden", "true");
  i.innerHTML = '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.5z"/><path fill="#34A853" d="M12 23.5c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3A11.5 11.5 0 0 0 12 23.5z"/><path fill="#FBBC05" d="M5.6 14.2a6.9 6.9 0 0 1 0-4.4v-3H1.8a11.5 11.5 0 0 0 0 10.4l3.8-3z"/><path fill="#EA4335" d="M12 5.1c1.7 0 3.2.6 4.4 1.7l3.3-3.3A11.5 11.5 0 0 0 1.8 6.8l3.8 3C6.5 7.1 9 5.1 12 5.1z"/></svg>';
  return i;
}
// look: "full" ("Log in with Google"), "short" ("Google") or "icon" (the label is the tooltip / for screen readers)
function altButtons(cls, me, look = "full") {
  const box = h("div", "altlogin" + (look === "icon" ? " compact" : ""));
  for (const [k, n] of altOn(me)) {
    const label = tr("Log in with {p}", { p: n }), a = h("a", "btn ghost sm " + (cls || ""), look === "full" ? label : "");
    if (look === "short") a.append(h("span", null, n)); // (the name can be hidden on narrow screens)
    a.href = altURL(k, "login"); a.prepend(altMark(k)); if (look !== "full") { a.title = label; a.setAttribute("aria-label", label); } box.append(a);
  }
  return box;
}
async function openBackupLogins() {
  const body = h("div", "altbox");
  const fill = async () => {
    body.replaceChildren(h("p", "hint", tr("Loading…")));
    let r = null; try { const x = await fetch("/api/v1/me/logins", { cache: "no-store" }); r = await x.json(); if (!x.ok) throw new Error(r && r.error || "HTTP " + x.status); }
    catch (e) { body.replaceChildren(h("p", "warnline", tr("Couldn't load your backup logins: {err}", { err: e.message }))); return; }
    body.replaceChildren(h("p", "hint", tr("If osu!'s login ever doesn't work, a Google account linked here logs you in to this same osu! account. Only the account's ID at Google is kept, never your e-mail or name.")));
    if (!r.linked) { body.append(h("p", "warnline", tr("Backup logins aren't set up on the server yet."))); return; }
    for (const [k, n] of ALT) {
      if (!r.configured[k]) continue;
      const row = h("div", "altrow"), l = r.linked[k], info = h("div");
      info.append(h("b", null, n), h("small", null, l ? tr("Linked {date}", { date: fmtDate(l.linked_at, false) }) + (l.last_used_at ? " · " + tr("last used {date}", { date: fmtDate(l.last_used_at, false) }) : "") : tr("Not linked")));
      const lab = h("span", "altname"); lab.append(altMark(k), info); row.append(lab);
      if (l) { const u = h("button", "btn ghost sm", tr("Unlink")); u.onclick = async () => {
        if (!(await ask(tr("Unlink your {p} account? You won't be able to log in with it any more.", { p: n }), { ok: tr("Unlink"), danger: true }))) return;
        u.disabled = true; try { const x = await fetch("/api/v1/me/logins/" + k, { method: "DELETE", headers: { "Content-Type": "application/json" } }); if (!x.ok) throw new Error("HTTP " + x.status); toast(tr("{p} unlinked", { p: n }), 1800); } catch (e) { toast(tr("Couldn't unlink: {err}", { err: e.message }), 3000); }
        fill(); }; row.append(u); }
      else { const a = h("a", "btn main sm", tr("Link")); a.href = altURL(k, "link"); row.append(a); }
      body.append(row);
    }
  };
  fill();
  await modal({ title: tr("Backup logins"), body, dismiss: null, buttons: [{ label: tr("Close"), value: null, cls: "main" }] });
}
function openAcct() { const p = $("acctPop"); $("volPop").hidden = true; p.hidden = false; fillAcct(); placePop(p, $("acctBtn")); }
$("acctBtn").onclick = e => { e.stopPropagation(); const p = $("acctPop"); if (p.hidden) openAcct(); else p.hidden = true; };
document.addEventListener("pointerdown", e => { const p = $("acctPop"); if (!p.hidden && !p.contains(e.target) && !$("acctBtn").contains(e.target)) p.hidden = true; });
async function authLogin() {
  if (!AUTH.api && AUTH.dev) { const n = (await askText("localhost: osu! login needs the deployed site. Name to test with:", "tester")); if (n) { AUTH.user = { id: -1, username: n.slice(0, 32), avatar: "", dev: true }; renderAccount(); } return; }
  location.href = "/api/auth/login?next=" + enc(location.pathname + location.search);
}
function authLogout() {
  try { localStorage.removeItem("obv-gate"); } catch {} // the next page waits for the real answer (gate.js)
  if (AUTH.user && AUTH.user.dev) { AUTH.user = null; renderAccount(); return; }
  location.href = "/api/auth/logout?next=" + enc(location.pathname + location.search);
}
// Proving who you are to someone in a session: a 10-minute ticket made for that audience only ("live:<code>" to show
// the host, "live:<code>:<their peer>" for the host to show one guest; "collab:" the same), so a ticket passed on can't
// be shown anywhere else. AUTH.ticket says whether this login may get them (osu!, confirmed).
async function ticketFor(aud) {
  if (!AUTH.ticket || !AUTH.api || !liveUser() || AUTH.user.dev) return null;
  try { const r = await fetch("/api/v1/live/ticket", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ aud: String(aud).toLowerCase() }) }); const j = await r.json(); return j.ticket || null; } catch { return null; }
}
const ticketCache = new Map();
async function verifyTicket(t, aud) { // -> user or null
  if (!t || !AUTH.api || !aud) return null;
  aud = String(aud).toLowerCase(); const key = aud + "|" + t;
  if (ticketCache.has(key)) return ticketCache.get(key);
  let u = null;
  try { const r = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: t, aud }) }); const j = await r.json(); if (j.ok) u = j.user; } catch {}
  if (ticketCache.size > 500) ticketCache.clear();
  ticketCache.set(key, u); return u;
}

// ============ live modding / mapping sessions ============
// Peer-to-peer (WebRTC through PeerJS). The host's browser is the session: it holds the map, checks who joins,
// decides who may edit, and relays everything. Visitors connect only to the host. A session closes after 3 hours.
const LIVE = { on: false, host: false, code: "", peer: null, conns: new Map(), hostConn: null, me: null, members: new Map(), expires: 0, idBase: 0, canEdit: false,
  follow: true, guests: false, comments: [], highlights: [], feed: [], flash: null, seq: 0, lastPres: 0, presKey: "", timer: 0, pkg: null, pkgBlob: null, pkgKey: "", opening: false,
  mx: -999, my: -999, sumBad: 0, tab: "people", hostId: "", chat: [], unread: 0, chatOpen: false,
  turn: null, token: "", relay: false, rk: "", ping: null, autoDone: false, directPing: null, switching: false, tick: 0, watch: false };
// an invite-only site's guests (when Admin → Permissions lets them watch) join as watchers: the host's playback and edits
// only. The host decides it from the server's answer about the visitor (verifyTicket) and ignores anything else they send.
const liveWatchOnly = () => { if (LIVE.on && LIVE.watch) { toast(tr("You're watching: only the host can do this"), 2200); return true; } return false; };
const LIVE_MS = 3 * 3600 * 1000, LIVE_MAX = 16;
const LIVE_COLS = ["#ff66aa", "#66ccff", "#ffd84a", "#57d68d", "#b35cff", "#ff8a4d", "#4dffd2", "#ff5a6e"];
const liveCanEdit = () => !LIVE.on || LIVE.host || LIVE.canEdit;
function liveNoEdit() { toast(tr("View only: ask the host for edit permission"), 2200); }
let peerjsP = null;
function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  return peerjsP || (peerjsP = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js";
    s.onload = () => res(window.Peer); s.onerror = () => { peerjsP = null; rej(new Error(tr("Couldn't load the live-session library, check your connection"))); };
    document.head.append(s);
  }));
}
// ---------- TURN relay (Cloudflare) ----------
// Peer-to-peer first. A started session gets relay credentials from the server (a token signed for its code goes in the
// invite link and the welcome message): they're added to every connection, so it falls back to the relay when a direct
// one can't be made. People an admin picked use only the relay, and a visitor whose ping to the host stays above the
// limit (Admin → Settings → TURN relay) switches to it by themselves (and back if the relay turns out slower).
async function liveApi(path, body) {
  try { const r = await fetch("/api/v1/" + path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
// the host's choice before starting (remembered): TURN relay on, or peer-to-peer only
function liveTurnPref(v) {
  try { if (v !== undefined) localStorage.setItem("obv-live-turn", v ? "1" : "0"); return localStorage.getItem("obv-live-turn") !== "0"; } catch { return v !== undefined ? v : true; }
}
const turnOk = t => !!(t && t.on && Array.isArray(t.iceServers) && t.iceServers.length);
const peerOpts = (t, relay) => turnOk(t) ? { debug: 0, config: { iceServers: t.iceServers, iceTransportPolicy: relay ? "relay" : "all" } } : { debug: 0 };
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1]) : null; };
const randCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const peerId = code => "obv-live-" + code;
const inviteURL = () => location.origin + location.pathname + "?live=" + LIVE.code + (LIVE.token ? "&lt=" + LIVE.token : "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const liveUid = () => LIVE.me.id + ":" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); // unique even for two messages in the same ms
function meInfo() { const u = liveUser() || {}; return { name: u.username || "?", avatar: u.avatar || "", uid: u.id > 0 ? u.id : null, verified: !!(u.id > 0 && !u.dev), country: u.country || "" }; }
function member(id) { return LIVE.members.get(id) || { name: "?", color: "#fff" }; }
function feed(text, t) { LIVE.feed.unshift({ at: Date.now(), text, t }); if (LIVE.feed.length > 80) LIVE.feed.pop(); if (LIVE.tab === "activity") renderLive(); }
function send(c, msg) { try { if (c && c.open) c.send(msg); } catch {} }
function broadcast(msg, except) { for (const [id, e] of LIVE.conns) if (id !== except && e.m) send(e.c, msg); }
function toHost(msg) { send(LIVE.hostConn, msg); }
const liveSendAll = msg => LIVE.host ? broadcast(msg) : toHost(msg);

// ---------- host ----------
async function liveStart() {
  if (!map) return;
  if (LIVE.on) return openLive();
  if (AUTH.user && AUTH.user.google_only) { toast(tr("Live sessions need an osu! login: log in with osu! (what you have moves to that account)."), 4500); authLogin(); return; }
  if (!AUTH.user) { toast(tr("Log in with osu! to host a live session"), 3000); openAcct(); return; }
  if (!(await ask(tr("Start a live session? People with the link can watch and comment; you choose who may edit. It closes automatically after 3 hours. Participants connect directly to your browser (they can see your IP address)."), { title: tr("Live session"), ok: tr("Start") }))) return;
  let Peer; try { Peer = await loadPeerJS(); } catch (e) { return toast(e.message); }
  if (!EDIT.on) setMode(true);
  showLoading(tr("Starting the live session…"), -1);
  const tryOpen = async n => {
    const code = randCode(), t = AUTH.user.dev || !liveTurnPref() ? null : await liveApi("live/start", { code }); // the relay token for this code (none: peer-to-peer only)
    return new Promise((res, rej) => {
      const peer = new Peer(peerId(code), peerOpts(t, t && t.relay));
      const to = setTimeout(() => { peer.destroy(); rej(new Error(tr("timed out"))); }, 15000);
      peer.on("open", () => { clearTimeout(to); res({ peer, code, t }); });
      peer.on("error", e => { clearTimeout(to); peer.destroy(); if (e.type === "unavailable-id" && n < 3) tryOpen(n + 1).then(res, rej); else rej(e); });
    });
  };
  try {
    const { peer, code, t } = await tryOpen(0);
    Object.assign(LIVE, { on: true, host: true, code, peer, hostId: peer.id, expires: Date.now() + LIVE_MS, idBase: 0, canEdit: true, seq: 0, comments: [], highlights: [], feed: [], pkgBlob: null, follow: false, chat: [], unread: 0,
      turn: t, token: t && t.token || "", relay: !!(turnOk(t) && t.relay), tick: 0 });
    LIVE.members.clear();
    LIVE.me = { id: peer.id, num: 0, ...meInfo(), host: true, canEdit: true, color: LIVE_COLS[0], relay: LIVE.relay };
    LIVE.members.set(peer.id, LIVE.me);
    peer.on("connection", hostAccept);
    peer.on("disconnected", () => { if (LIVE.on) try { peer.reconnect(); } catch {} });
    peer.on("error", e => { if (LIVE.on && e.type !== "peer-unavailable") feed(tr("Connection problem: {err}", { err: e.type || e.message })); });
    liveTimers(); hideLoading();
    feed(tr("Session started"));
    openLive();
    copyText(inviteURL()).then(ok => toast(ok ? tr("Live session started • invite link copied") : tr("Live session started"), 3000));
  } catch (e) { hideLoading(); toast(tr("Couldn't start the live session: {err}", { err: e.type || e.message }), 4000); }
}
function hostAccept(c) {
  c.on("open", () => {
    if (!LIVE.on) return c.close();
    if ([...LIVE.conns.values()].filter(e => e.m).length >= LIVE_MAX) { send(c, { t: "denied", why: "full" }); setTimeout(() => c.close(), 400); return; }
    LIVE.conns.set(c.peer, { c, m: null });
  });
  c.on("data", d => hostOnData(c, d).catch(e => console.warn("live", e)));
  c.on("close", () => memberLeft(c.peer));
  c.on("error", () => memberLeft(c.peer));
}
function roster() { return [...LIVE.members.values()].map(m => ({ id: m.id, name: m.name, avatar: m.avatar, verified: m.verified, host: !!m.host, canEdit: !!m.canEdit, color: m.color, num: m.num, country: m.country || "", relay: !!m.relay, ping: m.ping ?? null, watch: !!m.watch })); }
function sendRoster() { broadcast({ t: "roster", members: roster() }); renderLive(); updateLivePill(); }
async function hostOnData(c, d) {
  const ent = LIVE.conns.get(c.peer); if (!ent || !d || typeof d !== "object") return;
  if (d.t === "join") {
    if (ent.m) return;
    let who = { username: String((d.user && d.user.username) || "guest").slice(0, 32) }, verified = false;
    const v = await verifyTicket(d.ticket, "live:" + LIVE.code); if (v) { who = v; verified = true; }
    if (!verified && !LIVE.guests && !AUTH.dev) { send(c, { t: "denied", why: "login" }); setTimeout(() => c.close(), 500); return; }
    const site = typeof CLOUD !== "undefined" && CLOUD.me || {}, watch = !!site.gate && !(verified && (who.access === "member" || who.access === "admin"));
    if (watch && !(site.perms && site.perms.guest && site.perms.guest.live === true)) { send(c, { t: "denied", why: "perm" }); setTimeout(() => c.close(), 500); return; }
    const num = ++LIVE.seq;
    const m = { id: c.peer, num, name: who.username, avatar: verified ? who.avatar || "" : "", uid: verified ? who.id : null, verified, canEdit: false, color: LIVE_COLS[num % LIVE_COLS.length], pres: null,
      country: verified ? String(who.country || "").slice(0, 4) : "", relay: !!d.relay, rk: randCode() + randCode(), rtt: [], ping: null, watch };
    ent.m = m; LIVE.members.set(c.peer, m);
    const myTicket = await ticketFor("live:" + LIVE.code + ":" + c.peer); // (for this guest only)
    if (!LIVE.conns.has(c.peer)) return; // (left while the ticket came)
    send(c, { t: "welcome", you: m, hostId: LIVE.hostId, code: LIVE.code, expires: LIVE.expires, idBase: num * 1e7, ticket: myTicket, comments: LIVE.comments.slice(-300), chat: LIVE.chat.filter(x => !x.sys).slice(-100), lt: LIVE.token, ink: inkSnapshot() });
    send(c, stateMsg());
    sendRoster();
    feed(tr("{n} joined", { n: m.name })); toast(tr("{n} joined the live session", { n: m.name }), 2000);
    const sj = chatSys("join", m.name); broadcast({ t: "sys", m: sj }, c.peer);
    return;
  }
  if (d.t === "resume") { // a visitor moving to a new connection (to or from the relay): same person, same permissions
    if (ent.m) return;
    const m = LIVE.members.get(String(d.id || ""));
    if (!m || m.host || !m.rk || m.rk !== d.rk) { send(c, { t: "denied", why: "resume" }); setTimeout(() => c.close(), 400); return; }
    for (const [k, e] of LIVE.conns) if (e.m === m && k !== c.peer) { LIVE.conns.delete(k); try { e.c.close(); } catch {} }
    ent.m = m; m.relay = !!d.relay; m.rtt = []; m.ping = null;
    send(c, { t: "resumed" }); send(c, stateMsg(true)); sendRoster();
    feed(tr(m.relay ? "{n} switched to the TURN relay" : "{n} is connected directly again", { n: m.name }));
    return;
  }
  const m = ent.m; if (!m) return;
  if (d.t === "pong") { const ms = performance.now() - d.s; if (ms >= 0 && ms < 60000) { m.rtt.push(ms); if (m.rtt.length > 5) m.rtt.shift(); m.ping = median(m.rtt); } return; }
  if (m.watch && !["needpkg", "resync"].includes(d.t)) return; // watchers only receive
  if (d.t === "patch") {
    if (!m.canEdit) { send(c, stateMsg()); return; }
    if (d.p.diff !== osuFiles[curDiff].path) return;
    applyRemotePatch(d.p, m); broadcast({ ...d, by: m.id }, c.peer);
    feed(tr("{n}: {what}", { n: m.name, what: tr(d.label || "Edit") }), d.p.t);
  } else if (d.t === "cur") { m.pres = { ...d, at: performance.now() }; broadcast({ ...d, id: m.id }, c.peer); dirty = true; }
  else if (d.t === "drag") { if (!m.canEdit) return; const g = cleanDrag(d); if (g) { m.drag = g; broadcast({ ...d, id: m.id }, c.peer); dirty = true; } }
  else if (d.t === "ink") { const st = inkClean(d.s, m); if (st) { inkAdd(st); broadcast({ t: "ink", s: { ...inkWire(st), by: m.id } }, c.peer); } }
  else if (d.t === "inkdel") { const ids = (Array.isArray(d.ids) ? d.ids : []).slice(0, 400).map(String); inkRemove(ids, m.id); broadcast({ t: "inkdel", ids, by: m.id }, c.peer); }
  else if (d.t === "inkclr") { inkClear(m.id); broadcast({ t: "inkclr", by: m.id }, c.peer); }
  else if (d.t === "hl") { const hl = cleanHl(d.h, m); if (hl) { addHl(hl); broadcast({ t: "hl", h: hl }, c.peer); } }
  else if (d.t === "cm") { const cm = cleanCm(d.c, m); if (cm) { addCm(cm); broadcast({ t: "cm", c: cm }, c.peer); } }
  else if (d.t === "chat") { const cm = cleanChat(d.m, m); if (cm) { chatAdd(cm); broadcast({ t: "chat", m: cm }, c.peer); } }
  else if (d.t === "cmdel") { const cm = LIVE.comments.find(x => x.id === d.id); if (cm && cm.by === m.id) { delCm(d.id); broadcast({ t: "cmdel", id: d.id }, c.peer); } }
  else if (d.t === "needpkg") sendPackage(c);
  else if (d.t === "resync") send(c, stateMsg(true));
}
function memberLeft(id) {
  const e = LIVE.conns.get(id); LIVE.conns.delete(id);
  if (e && e.m) { LIVE.members.delete(e.m.id); feed(tr("{n} left", { n: e.m.name })); broadcast({ t: "sys", m: chatSys("left", e.m.name) }); sendRoster(); dirty = true; }
}
function stateMsg(resync) {
  const f = osuFiles[curDiff];
  return { t: "state", resync: !!resync, sid: onlineSet ? +onlineSet : 0, pkg: LIVE.code + ":" + (onlineSet || "local"), path: f.path, version: map.meta.Version, bid: +map.meta.BeatmapID || 0,
    text: editedText(), ids: map.lines.map(L => L.id), title: `${map.meta.Artist} - ${map.meta.Title}` };
}
function liveSendState() { if (LIVE.on && LIVE.host) broadcast(stateMsg()); }
async function sendPackage(c) { // for maps that aren't on the mirrors (local/created): the whole .osz, in chunks
  try {
    if (!LIVE.pkgBlob) {
      const Z = await loadJSZip(), zip = new Z(), own = new Set(osuFiles.map(o => o.path));
      for (const k in files) { const f = files[k]; if (!own.has(f.name)) zip.file(f.name, f.async("uint8array")); }
      osuFiles.forEach((o, i) => zip.file(o.path, i === curDiff ? editedText() : o.text));
      LIVE.pkgBlob = await zip.generateAsync({ type: "arraybuffer", compression: "STORE" });
    }
    const buf = LIVE.pkgBlob, CH = 64000, n = Math.ceil(buf.byteLength / CH);
    send(c, { t: "pkg0", n, size: buf.byteLength });
    for (let i = 0; i < n; i++) {
      while (c.dataChannel && c.dataChannel.bufferedAmount > 1.5e6) await sleep(25);
      if (!c.open) return;
      send(c, { t: "pkg", i, b: buf.slice(i * CH, (i + 1) * CH) });
      if (i % 16 === 15) await sleep(0);
    }
  } catch (e) { feed(tr("Couldn't send the map: {err}", { err: e.message })); }
}
function setPerm(id, canEdit) {
  const m = LIVE.members.get(id); if (!m || m.host || (canEdit && m.watch)) return;
  m.canEdit = canEdit; sendRoster();
  feed(tr(canEdit ? "{n} can now edit" : "{n} is view-only now", { n: m.name }));
}
function kick(id) { // id: the member's id (their connection may have changed since they joined)
  const k = [...LIVE.conns.keys()].find(k => LIVE.conns.get(k).m && LIVE.conns.get(k).m.id === id); if (k == null) return;
  const e = LIVE.conns.get(k);
  send(e.c, { t: "kick" }); setTimeout(() => { try { e.c.close(); } catch {} memberLeft(k); }, 300);
}

// ---------- visitor ----------
function liveJoinPrompt(code, lt) {
  code = String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (!code) return;
  if (LIVE.on) { if (LIVE.code === code) return openLive(); return toast(tr("You're already in a live session")); }
  const dlg = $("liveJoin"); dlg.hidden = false; $("ljCode").textContent = code.toUpperCase(); dlg.dataset.code = code;
  dlg.dataset.lt = /^[0-9a-z]{1,12}\.[A-Za-z0-9_-]{22}$/.test(lt || "") ? lt : "";
  const who = $("ljWho"); who.innerHTML = "";
  const lu = liveUser();
  if (lu) { const av = h("i", "av"); if (lu.avatar) av.style.backgroundImage = `url("${lu.avatar}")`; who.append(av, h("span", null, tr("Joining as {n}", { n: lu.username }))); $("ljGuest").hidden = true; $("ljLogin").hidden = true; }
  else { who.append(h("span", null, tr("Log in with osu! so the host knows who you are, or join as a guest (if the host allows guests)."))); $("ljGuest").hidden = false; $("ljLogin").hidden = false; }
  if (!AUTH.checked) authCheck().then(() => { if (!dlg.hidden) liveJoinPrompt(code, dlg.dataset.lt); });
}
$("ljCancel").onclick = () => { $("liveJoin").hidden = true; const p = new URLSearchParams(location.search); if (p.has("live")) { p.delete("live"); p.delete("lt"); history.replaceState(history.state, "", location.pathname + (p.toString() ? "?" + p : "")); } };
$("ljLogin").onclick = authLogin;
$("ljGo").onclick = () => {
  const code = $("liveJoin").dataset.code, guest = $("ljName").value.trim();
  if (!liveUser() && !guest) { $("ljName").focus(); return toast(tr("Type a name or log in with osu!")); }
  $("liveJoin").hidden = true; liveJoin(code, guest, $("liveJoin").dataset.lt || "");
};
async function liveJoin(code, guest, lt) {
  const tP = lt ? liveApi("live/ice", { code, token: lt }) : null; // relay credentials, when the link carries the session's token
  let Peer; try { Peer = await loadPeerJS(); } catch (e) { return toast(e.message); }
  if (!(await edConfirmDiscard())) return;
  showLoading(tr("Connecting to the live session…"), -1);
  const t = tP ? await tP : null, relay = !!(turnOk(t) && t.relay);
  const peer = new Peer(peerOpts(t, relay));
  let welcomed = false;
  const fail = msg => { hideLoading(); if (!welcomed) { try { peer.destroy(); } catch {} toast(msg, 4500); } };
  const to = setTimeout(() => { if (!welcomed) fail(tr("Couldn't reach the host (timed out). Check the code, or the host may be offline.")); }, 20000);
  peer.on("error", e => { clearTimeout(to); if (e.type === "peer-unavailable") fail(tr("No live session with this code (it may have ended).")); else if (!welcomed) fail(tr("Couldn't connect: {err}", { err: e.type || e.message })); });
  peer.on("open", () => {
    const c = peer.connect(peerId(code), { reliable: true });
    c.on("open", async () => send(c, { t: "join", user: liveUser() ? { username: liveUser().username } : { username: guest || "guest" }, ticket: await ticketFor("live:" + code), relay }));
    c.on("data", d => {
      if (d && d.t === "denied") { welcomed = true; clearTimeout(to); hideLoading(); toast(d.why === "full" ? tr("This session is full") : d.why === "perm" ? tr("This site doesn't let guests watch live sessions") : tr("The host only allows people logged in with osu!"), 4500); setTimeout(() => { try { peer.destroy(); } catch {} }, 200); return; }
      if (d && d.t === "welcome") {
        welcomed = true; clearTimeout(to);
        Object.assign(LIVE, { on: true, host: false, code, peer, hostConn: c, hostId: d.hostId, expires: d.expires, idBase: d.idBase, canEdit: false, comments: d.comments || [], chat: d.chat || [], unread: (d.chat || []).length ? 1 : 0, highlights: [], feed: [], follow: true, pkgKey: "", sumBad: 0,
          turn: t, token: d.lt || lt || "", relay, rk: d.you.rk || "", ping: null, autoDone: false, directPing: null, switching: false, watch: !!d.you.watch });
        LIVE.me = d.you; LIVE.members.clear();
        INK.strokes = []; LIVE.inkIn = Array.isArray(d.ink) ? d.ink : []; // drawn once the roster (their colours) is in
        liveTimers(); feed(tr("Joined session {c}", { c: code.toUpperCase() }));
        if (!t && LIVE.token) liveApi("live/ice", { code, token: LIVE.token }).then(t2 => { // joined with the code only: the token came with the welcome
          if (!LIVE.on || LIVE.host || LIVE.code !== code) return;
          LIVE.turn = t2; if (turnOk(t2) && t2.relay && !LIVE.relay) liveSwitch(true, "admin");
        });
        verifyTicket(d.ticket, "live:" + code + ":" + peer.id).then(u => { const hm = LIVE.members.get(d.hostId); if (hm) { hm.verified = !!u; renderLive(); } });
      }
      if (LIVE.hostConn && c !== LIVE.hostConn) return; // moved to another connection (the relay)
      visitorOnData(d).catch(e => console.warn("live", e));
    });
    c.on("close", () => { if (c === LIVE.hostConn && LIVE.on && !LIVE.host) liveEnd(false, tr("The host ended the session or went offline")); });
  });
}
async function visitorOnData(d) {
  if (!d || typeof d !== "object") return;
  switch (d.t) {
    case "state": await applyState(d); break;
    case "pkg0": LIVE.pkg = { n: d.n, got: 0, parts: new Array(d.n), size: d.size }; showLoading(tr("Receiving the map from the host… {p}%", { p: 0 }), 0); break;
    case "pkg": {
      const P = LIVE.pkg; if (!P || P.parts[d.i]) break;
      P.parts[d.i] = d.b; P.got++;
      if (P.got % 8 === 0 || P.got === P.n) showLoading(tr("Receiving the map from the host… {p}%", { p: Math.round(P.got / P.n * 100) }), P.got / P.n);
      if (P.got === P.n) { const blob = new Blob(P.parts), done = LIVE.pkgDone; LIVE.pkg = null; LIVE.pkgDone = null; done && done(blob); }
      break;
    }
    case "patch": if (map && d.p.diff === osuFiles[curDiff].path) { applyRemotePatch(d.p, member(d.by)); feed(tr("{n}: {what}", { n: member(d.by).name, what: tr(d.label || "Edit") }), d.p.t); } break;
    case "roster": {
      const old = LIVE.members; LIVE.members = new Map(d.members.map(m => [m.id, { ...(old.get(m.id) || {}), ...m }]));
      if (LIVE.inkIn) { for (const s0 of LIVE.inkIn) { const m = LIVE.members.get(s0.by), st = m && inkClean(s0, m); if (st) { st.done = true; inkAdd(st); } } LIVE.inkIn = null; }
      const me = LIVE.members.get(LIVE.me.id);
      if (me && me.canEdit !== LIVE.canEdit) { LIVE.canEdit = me.canEdit; toast(tr(me.canEdit ? "The host gave you edit permission" : "You're view-only now"), 2500); }
      renderLive(); updateLivePill(); break;
    }
    case "cur": { const m = LIVE.members.get(d.id); if (m) { m.pres = { ...d, at: performance.now() }; dirty = true; } break; }
    case "hl": addHl(d.h); break;
    case "cm": addCm(d.c); break;
    case "chat": chatAdd(d.m); break;
    case "sys": if (d.m && d.m.sys) chatAdd({ ...d.m }); break;
    case "cmdel": delCm(d.id); break;
    case "sum": if (map && !LIVE.pkg && d.path === osuFiles[curDiff].path) { if (d.h !== stateHash()) { if (++LIVE.sumBad >= 2) { LIVE.sumBad = 0; toHost({ t: "resync" }); } } else LIVE.sumBad = 0; } break;
    case "time": LIVE.expires = d.expires; break;
    case "ping": toHost({ t: "pong", s: d.s }); break;
    case "drag": { const m = LIVE.members.get(d.id), g = cleanDrag(d); if (m && g) { m.drag = g; dirty = true; } break; }
    case "ink": { const m = LIVE.members.get(d.s && d.s.by), st = m && inkClean(d.s, m); if (st) inkAdd(st); break; }
    case "inkdel": { const by = LIVE.members.get(d.by); inkRemove((d.ids || []).map(String), by && by.host ? null : d.by); break; }
    case "inkclr": inkClear(d.all ? null : d.by); break;
    case "pings": {
      for (const [id, ping, relay, n] of Array.isArray(d.p) ? d.p : []) {
        const m = LIVE.members.get(id); if (m) { m.ping = ping; m.relay = relay; }
        if (id === LIVE.me.id) liveAutoRelay(ping, n);
      }
      if (LIVE.tab === "people") renderLive();
      break;
    }
    case "kick": liveEnd(false, tr("The host removed you from the session")); break;
    case "end": liveEnd(false, d.why === "time" ? tr("The live session reached its 3-hour limit and was closed") : tr("The host ended the live session")); break;
  }
}
// switch to the relay when the ping to the host stays high; back to direct if the relay is slower still
function liveAutoRelay(ping, n) {
  LIVE.ping = ping;
  const t = LIVE.turn; if (!turnOk(t) || LIVE.switching || ping == null || n < 3) return;
  if (!LIVE.relay && !LIVE.autoDone && ping > t.ping_ms) { LIVE.autoDone = true; LIVE.directPing = ping; liveSwitch(true, "auto", ping); }
  else if (LIVE.relay && !t.relay && LIVE.directPing != null && ping > LIVE.directPing + 20) { LIVE.directPing = null; liveSwitch(false, "back"); }
}
// a new connection to the host (relay only, or direct again); the host moves this person over to it, then the old one closes
async function liveSwitch(relay, why, ping) {
  if (LIVE.switching || !LIVE.on || LIVE.host || !turnOk(LIVE.turn) || LIVE.relay === relay) return;
  LIVE.switching = true;
  let peer = null;
  try {
    const Peer = await loadPeerJS(), code = LIVE.code;
    peer = new Peer(peerOpts(LIVE.turn, relay));
    const c = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(tr("timed out"))), 15000);
      peer.on("error", e => { clearTimeout(to); rej(e); });
      peer.on("open", () => {
        const c = peer.connect(peerId(code), { reliable: true }); let ok = false;
        c.on("open", () => send(c, { t: "resume", id: LIVE.me.id, rk: LIVE.rk, relay }));
        c.on("data", d => {
          if (!ok) { if (d && d.t === "resumed") { ok = true; clearTimeout(to); res(c); } else if (d && d.t === "denied") { clearTimeout(to); rej(new Error(d.why || "denied")); } return; }
          if (c === LIVE.hostConn) visitorOnData(d).catch(e => console.warn("live", e));
        });
        c.on("close", () => { if (c === LIVE.hostConn && LIVE.on && !LIVE.host) liveEnd(false, tr("The host ended the session or went offline")); });
      });
    });
    if (!LIVE.on || LIVE.code !== code) { peer.destroy(); return; }
    const old = LIVE.peer;
    Object.assign(LIVE, { peer, hostConn: c, relay });
    setTimeout(() => { try { old && old.destroy(); } catch {} }, 500);
    const msg = why === "auto" ? tr("Your ping to the host is {ms} ms: switched to the TURN relay", { ms: ping }) : why === "back" ? tr("The relay was slower: connected directly again") : tr("Connected through the TURN relay");
    feed(msg); toast(msg, 3500); renderLive();
  } catch (e) {
    try { peer && peer.destroy(); } catch {}
    if (relay) feed(tr("Couldn't switch to the TURN relay ({err}), staying connected directly", { err: e.type || e.message }));
  } finally { LIVE.switching = false; }
}
// the host's map: download it from a mirror (or receive it), pick the host's diff, then take the host's text + object ids
async function applyState(d) {
  const key = d.sid ? "s" + d.sid : d.pkg;
  if (LIVE.pkgKey !== key || !osuFiles.length) {
    LIVE.opening = true;
    try {
      if (d.sid) await download(d.sid, { bid: d.bid || null, name: d.version }, "mod");
      else {
        const blob = await new Promise(res => { LIVE.pkg = null; LIVE.pkgDone = res; toHost({ t: "needpkg" }); }); // set before asking: a small map can arrive in one go
        await openZip(blob, null, { name: d.version }, "mod");
      }
    } finally { LIVE.opening = false; }
    if (!LIVE.on) return; // (left while it opened: said no to an Aspire map)
    if (!map) { toast(tr("Couldn't open the host's map")); return; }
    LIVE.pkgKey = key;
  }
  let i = osuFiles.findIndex(o => o.path === d.path);
  if (i < 0) i = osuFiles.findIndex(o => o.meta.version === d.version);
  if (i < 0) { // a diff the host made during the session
    files[norm(d.path)] = blobEntry(d.path, new Blob([d.text]));
    osuFiles.push({ text: d.text, meta: quickMeta(d.text), path: d.path, stars: estimateStars(d.text), estStars: true });
    for (const sel of [$("diff"), $("diffQuick")]) sel.add(new Option(diffLabel(osuFiles[osuFiles.length - 1]), osuFiles.length - 1));
    $("diffQuick").hidden = osuFiles.length < 2; i = osuFiles.length - 1;
  }
  osuFiles[i].path = d.path;
  if (i !== curDiff) { osuFiles[i].text = d.text; await selectDiff(i); applyText(d.text, d.ids); }
  else applyText(d.text, d.ids);
  if (!EDIT.on) setMode(true);
  EDIT.changed = false; osuFiles.forEach(o => o.created = o.edited = false);
  hideLoading(); updateLivePill(); renderLive();
  if (!d.resync) toast(tr("Live: {t}", { t: d.title }), 2000);
}
function applyText(text, ids) { // replace the open diff's content in place (keeps song, background, storyboard)
  const m2 = parseOsu(text);
  m2.lines.forEach((L, k) => { if (ids && ids[k] != null) L.id = ids[k]; });
  map.lines = m2.lines; map.timing = m2.timing; map.bookmarks = m2.bookmarks; map.general = m2.general; map.meta = m2.meta; map.diff = m2.diff; map.colourKV = m2.colourKV;
  if (osuFiles[curDiff]) { osuFiles[curDiff].text = text; osuFiles[curDiff].ids = map.lines.map(L => L.id); }
  EDIT.undo = []; EDIT.redo = [];
  rebuildEdit(true); EDIT.changed = LIVE.host;
}

// ---------- shared: patches, presence, highlights, comments ----------
function makePatch(before) {
  const prev = new Map(before.lines.map(L => [L.id, L.s])), now = new Set(), set = [], del = [];
  for (const L of map.lines) { now.add(L.id); if (prev.get(L.id) !== L.s) set.push([L.id, L.s]); }
  for (const id of prev.keys()) if (!now.has(id)) del.push(id);
  const p = { diff: osuFiles[curDiff].path, t: Math.round(A.cur()) };
  if (set.length) p.set = set; if (del.length) p.del = del;
  if (before.bm.join() !== map.bookmarks.join()) p.bm = map.bookmarks.slice();
  const tl = map.timing.map(timingLine).join("\n"); if (tl !== before.timing.map(timingLine).join("\n")) p.timing = tl;
  const kv = { g: map.general, m: map.meta, d: map.diff, c: map.colourKV };
  if (JSON.stringify(before.kv) !== JSON.stringify(kv)) p.kv = kv;
  if (before.br && JSON.stringify(before.br) !== JSON.stringify(map.breaks)) p.br = map.breaks.map(b => b.slice());
  return set.length || del.length || p.bm || p.timing != null || p.kv || p.br ? p : null;
}
function liveSendPatch(before, label) {
  const p = makePatch(before); if (!p) return;
  liveSendAll({ t: "patch", p, label, by: LIVE.me.id });
  LIVE.pkgBlob = null;
}
function applyRemotePatch(p, who) {
  const byId = new Map(map.lines.map(L => [L.id, L]));
  for (const id of p.del || []) byId.delete(id);
  for (const [id, s] of p.set || []) { const L = byId.get(id); if (L) L.s = s; else byId.set(id, { id, s }); if (id < 1e7 && id > lineSeq) lineSeq = id; }
  map.lines = [...byId.values()];
  if (p.bm) map.bookmarks = p.bm.slice();
  if (p.timing != null) map.timing = p.timing ? p.timing.split("\n").map(parseTimingLine).filter(Boolean) : [];
  if (p.kv) { map.general = { ...p.kv.g }; map.meta = { ...p.kv.m }; map.diff = { ...p.kv.d }; if (p.kv.c) map.colourKV = { ...p.kv.c }; }
  if (Array.isArray(p.br)) map.breaks = p.br.filter(b => Array.isArray(b) && isFinite(b[0]) && isFinite(b[1])).map(b => [+b[0], +b[1]]);
  EDIT.undo = []; EDIT.redo = []; // local history no longer matches the shared state
  rebuildEdit(true);
  if (p.set) LIVE.flash = { ids: new Set(p.set.map(x => x[0])), color: who.color || "#fff", at: performance.now() };
  LIVE.pkgBlob = null;
}
function stateHash() {
  let x = 2166136261;
  const add = s => { for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } };
  for (const L of map.lines) add(L.id + ":" + L.s + "\n");
  for (const tp of map.timing) add(timingLine(tp));
  return x >>> 0;
}
cv.addEventListener("pointermove", e => { if (LIVE.on && EDIT.on) { const p = toOsu(e); LIVE.mx = p[0]; LIVE.my = p[1]; } });
// moving objects or slider points: everyone sees where they go while the drag is on (~25/s), not only the result
function liveDragSend(now) {
  if (LIVE.watch || !liveCanEdit()) return;
  let msg = null;
  if (EDIT.drag && EDIT.sel.size) msg = { t: "drag", ids: [...EDIT.sel].slice(0, 200), dx: Math.round(EDIT.dx), dy: Math.round(EDIT.dy) };
  else if (EDIT.anchor && EDIT.anchor.moved) msg = { t: "drag", a: EDIT.anchor.o.lid, pts: EDIT.anchor.pts.slice(0, 200).map(p => [Math.round(p[0]), Math.round(p[1])]) };
  const out = m => liveSendAll(LIVE.host ? { ...m, id: LIVE.me.id } : m);
  if (!msg) { if (LIVE.dragKey) { LIVE.dragKey = ""; out({ t: "drag", end: true }); } return; }
  const key = JSON.stringify(msg); if (key === LIVE.dragKey || now - (LIVE.dragAt || 0) < 40) return;
  LIVE.dragKey = key; LIVE.dragAt = now; out(msg);
}
function cleanDrag(d) {
  if (d.end) return { end: true, at: performance.now() };
  if (Array.isArray(d.ids)) return { ids: d.ids.slice(0, 200).map(Number), dx: Math.max(-1000, Math.min(1000, +d.dx || 0)), dy: Math.max(-1000, Math.min(1000, +d.dy || 0)), at: performance.now() };
  if (Array.isArray(d.pts)) return { a: +d.a, pts: d.pts.slice(0, 200).map(p => [+p[0] || 0, +p[1] || 0]), at: performance.now() };
  return null;
}
// presence (time, play state, pointer, selection) and following the host's playback. The render loop only runs while
// something moves, so a paused player draws no frames: a timer does both too, or a pause would never reach the others.
function livePresence(t, playing, now) {
  const changed = playing !== LIVE.presPlaying; // play / pause goes out at once
  if (!changed && now - LIVE.lastPres <= 50) return; // ~20/s at most, only when something changes
  const sel = [...EDIT.sel].slice(0, 60), key = [Math.round(t / 8), playing, Math.round(LIVE.mx), Math.round(LIVE.my), sel.join(), A.rate].join();
  if (key === LIVE.presKey && now - LIVE.lastPres <= 2500) return;
  LIVE.presKey = key; LIVE.lastPres = now; LIVE.presPlaying = playing;
  const msg = { t: "cur", time: Math.round(t), playing, x: Math.round(LIVE.mx), y: Math.round(LIVE.my), sel, rate: A.rate };
  if (LIVE.host) broadcast({ ...msg, id: LIVE.me.id }); else if (!LIVE.watch) toHost(msg);
}
function liveFollow(now) {
  if (LIVE.host || !(LIVE.follow || LIVE.watch) || !map || LIVE.opening) return; // (watchers always follow)
  const hp = (LIVE.members.get(LIVE.hostId) || {}).pres;
  if (!hp || now - hp.at > 5000) return;
  const ht = hp.time + (hp.playing ? (now - hp.at) * (hp.rate || 1) : 0);
  if (hp.playing && !isPlaying()) { seekTo(ht); playNow(); }
  else if (!hp.playing && isPlaying()) { pausePlayback(); seekTo(hp.time); }
  else if (Math.abs(ht - A.cur()) > (hp.playing ? 180 : 3)) seekTo(ht);
}
function liveFrame(t, playing) {
  const now = performance.now();
  liveDragSend(now); livePresence(t, playing, now); liveFollow(now);
  if (LIVE.flash || LIVE.highlights.length) dirty = true;
}
setInterval(() => { if (LIVE.on && map) { const now = performance.now(); livePresence(A.cur(), isPlaying(), now); liveFollow(now); } }, 200);
function liveDrawOver(t, px) {
  const now = performance.now(), r = map.radius, H = map.hit;
  if (LIVE.lidHit !== H) { LIVE.lidHit = H; LIVE.lidMap = new Map(H.map(o => [o.lid, o])); }
  const byLid = id => LIVE.lidMap.get(id) || null;
  const ring = (o, col, w, a, grow = 1) => { if (!o) return; ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = w * px; ctx.beginPath(); ctx.arc(o.x, o.y, r * 1.12 * grow, 0, 7); ctx.stroke(); };
  const visible = o => o && t >= o.t - map.preempt && t <= o.end + 700;
  // highlights (pulsing, 20 s)
  LIVE.highlights = LIVE.highlights.filter(hl => now - hl.at < 20000);
  for (const hl of LIVE.highlights) {
    const k = (now - hl.at) / 20000, pulse = .5 + .5 * Math.sin(now / 160);
    let first = null;
    for (const id of hl.ids) { const o = byLid(id); if (!visible(o)) continue; first = first || o; ring(o, hl.color, 5, (1 - k) * (.55 + .45 * pulse), 1 + .08 * pulse); }
    if (first) { ctx.globalAlpha = 1 - k; ctx.font = `600 ${12 * px}px "Varela Round",sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillStyle = hl.color; ctx.fillText("✦ " + hl.name, first.x + r * .9, first.y - r * .9); }
  }
  if (LIVE.flash) { const k = (now - LIVE.flash.at) / 900; if (k >= 1) LIVE.flash = null; else for (const id of LIVE.flash.ids) { const o = byLid(id); if (visible(o)) ring(o, LIVE.flash.color, 4, 1 - k, 1 + .3 * k); } }
  // other people: their selection and pointer
  for (const m of LIVE.members.values()) {
    if (m.id === LIVE.me.id || !m.pres || now - m.pres.at > 15000) continue;
    const p = m.pres;
    for (const id of p.sel || []) { const o = byLid(id); if (visible(o)) { ctx.setLineDash([6 * px, 5 * px]); ring(o, m.color, 2.5, .95); ctx.setLineDash([]); } }
    if (p.x > -100 && p.x < 612 && p.y > -100 && p.y < 484) {
      ctx.globalAlpha = 1; ctx.fillStyle = m.color; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.2 * px;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 11 * px, p.y + 12 * px); ctx.lineTo(p.x + 4.5 * px, p.y + 12 * px); ctx.lineTo(p.x, p.y + 17 * px); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.font = `600 ${11 * px}px "Varela Round",sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "top";
      const w = ctx.measureText(m.name).width + 10 * px;
      ctx.fillRect(p.x + 12 * px, p.y + 14 * px, w, 16 * px); ctx.fillStyle = "#1c1726"; ctx.fillText(m.name, p.x + 17 * px, p.y + 16 * px);
    }
  }
  // objects someone is dragging right now: where they'd land, in that person's colour, with their name
  for (const m of LIVE.members.values()) {
    const g = m.drag; if (!g || m.id === LIVE.me.id) continue;
    if (g.end || now - g.at > 1500) { if (g.end && now - g.at > 300) m.drag = null; continue; }
    ctx.globalAlpha = .95; ctx.strokeStyle = m.color; ctx.fillStyle = m.color; ctx.lineWidth = 3 * px;
    let lab = null;
    if (g.ids) {
      for (const id of g.ids) {
        const o = byLid(id); if (!o || !visible(o)) continue;
        const nx = o.x + g.dx, ny = o.y + g.dy;
        if (o.path) { ctx.globalAlpha = .7; ctx.beginPath(); tracePath(ctx, o.path, g.dx, g.dy); ctx.stroke(); }
        ctx.globalAlpha = .95; ctx.beginPath(); ctx.arc(nx, ny, r, 0, 7); ctx.stroke();
        ctx.globalAlpha = .25; ctx.beginPath(); ctx.arc(nx, ny, r, 0, 7); ctx.fill();
        ctx.globalAlpha = .6; ctx.setLineDash([4 * px, 4 * px]); ctx.lineWidth = 1.5 * px; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(nx, ny); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 3 * px;
        lab = lab || [nx + r, ny - r];
      }
    } else if (g.pts && g.pts.length) {
      const o = byLid(g.a), d = o ? o.x - o.rx : 0; // (stacking offset)
      ctx.globalAlpha = .95; ctx.setLineDash([6 * px, 4 * px]); ctx.beginPath(); g.pts.forEach((p, j) => j ? ctx.lineTo(p[0] + d, p[1] + d) : ctx.moveTo(p[0] + d, p[1] + d)); ctx.stroke(); ctx.setLineDash([]);
      for (const p of g.pts) { ctx.beginPath(); ctx.arc(p[0] + d, p[1] + d, 4 * px, 0, 7); ctx.fill(); }
      lab = [g.pts[0][0] + d + 8 * px, g.pts[0][1] + d - 8 * px];
    }
    if (lab) { ctx.globalAlpha = 1; ctx.font = `600 ${11 * px}px "Varela Round",sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText("✥ " + m.name, lab[0], lab[1]); }
    dirty = true;
  }
  inkDraw(px);
  ctx.globalAlpha = 1;
}
function liveDrawTimeline(g, X, t0, t1, hh) {
  for (const c of LIVE.comments) if (c.t >= t0 && c.t <= t1) { const x = X(c.t); g.fillStyle = c.color || "#fff"; g.fillRect(x - 1, hh - 10, 2, 10); g.beginPath(); g.arc(x, hh - 11, 4, 0, 7); g.fill(); }
  for (const m of LIVE.members.values()) {
    if (m.id === LIVE.me.id || !m.pres || performance.now() - m.pres.at > 15000) continue;
    const x = X(m.pres.time + (m.pres.playing ? (performance.now() - m.pres.at) * (m.pres.rate || 1) : 0)); if (x < 0 || x > g.canvas.width) continue;
    g.fillStyle = m.color; g.globalAlpha = .9; g.fillRect(x - .5, 0, 1, hh); g.beginPath(); g.moveTo(x - 5, hh); g.lineTo(x + 5, hh); g.lineTo(x, hh - 7); g.fill(); g.globalAlpha = 1;
  }
}
function cleanHl(h0, m) { if (!h0 || !Array.isArray(h0.ids)) return null; return { id: String(h0.id || Date.now()).slice(0, 80), ids: h0.ids.slice(0, 60).map(Number), t: +h0.t || 0, ts: String(h0.ts || "").slice(0, 60), by: m.id, name: m.name, color: m.color, at: performance.now() }; }
function addHl(hl) {
  hl.at = performance.now(); LIVE.highlights.push(hl); if (LIVE.highlights.length > 30) LIVE.highlights.shift();
  if (hl.by !== LIVE.me.id) toast(tr("{n} highlighted {ts}", { n: hl.name, ts: hl.ts }), 2200);
  feed(tr("{n} highlighted {ts}", { n: hl.name, ts: hl.ts }), hl.t); dirty = true;
}
function liveHighlight() {
  if (!LIVE.on || !map || liveWatchOnly()) return;
  const objs = selObjs(), t = objs.length ? objs[0].t : Math.round(A.cur());
  const hl = { id: liveUid(), ids: objs.map(o => o.lid).slice(0, 60), t, ts: (objs.length ? tsFor(objs) : tsAt(t)).replace(/ - $/, ""), by: LIVE.me.id, name: LIVE.me.name, color: LIVE.me.color };
  if (!hl.ids.length) { const o = map.hit.find(x => Math.abs(x.t - t) < 5); if (o) hl.ids = [o.lid]; else return toast(tr("Select objects to highlight"), 1500); }
  addHl({ ...hl }); liveSendAll({ t: "hl", h: hl });
}
function cleanCm(c0, m) { if (!c0 || typeof c0.text !== "string" || !c0.text.trim()) return null; return { id: String(c0.id || Date.now()).slice(0, 80), t: Math.max(0, +c0.t || 0), ts: String(c0.ts || "").slice(0, 60), text: c0.text.trim().slice(0, 1000), by: m.id, name: m.name, color: m.color, at: Date.now() }; }
function addCm(c) { if (LIVE.comments.some(x => x.id === c.id)) return; LIVE.comments.push(c); LIVE.comments.sort((a, b) => a.t - b.t); if (c.by !== LIVE.me.id && !LIVE.chatOpen) { LIVE.unread++; chatBubble({ ...c, cm: true }); } renderLive(); renderChat(); updateLivePill(); dirty = true; }
function delCm(id) { LIVE.comments = LIVE.comments.filter(x => x.id !== id); renderLive(); dirty = true; }
function liveComment(text) {
  text = String(text || "").trim(); if (!text || !map || liveWatchOnly()) return; // a comment belongs to a time in the map
  const objs = selObjs(), t = objs.length ? objs[0].t : Math.round(A.cur());
  const c = { id: liveUid(), t, ts: (objs.length ? tsFor(objs) : tsAt(t)).replace(/ - $/, ""), text: text.slice(0, 1000), by: LIVE.me.id, name: LIVE.me.name, color: LIVE.me.color, at: Date.now() };
  addCm(c); liveSendAll({ t: "cm", c });
}

// ---------- timers, ending ----------
function liveTimers() {
  clearInterval(LIVE.timer);
  let warned = 0;
  LIVE.timer = setInterval(() => {
    if (!LIVE.on) return clearInterval(LIVE.timer);
    const left = LIVE.expires - Date.now();
    updateLivePill();
    if (LIVE.host) {
      if (left <= 0) return liveEnd(true, tr("The live session reached its 3-hour limit and was closed"), "time");
      if (left < 600000 && warned < 1) { warned = 1; toast(tr("The live session closes in 10 minutes (3-hour limit). Export your work."), 5000); }
      if (left < 60000 && warned < 2) { warned = 2; toast(tr("The live session closes in 1 minute"), 4000); }
      if (map && LIVE.conns.size && Date.now() % 5000 < 1000) broadcast({ t: "sum", h: stateHash(), path: osuFiles[curDiff].path });
      // ping: every 2 s to each person; everyone gets the list every 4 s (each person's round trip to the host)
      const tick = ++LIVE.tick;
      if (tick % 2 === 0) for (const e of LIVE.conns.values()) if (e.m) send(e.c, { t: "ping", s: performance.now() });
      if (tick % 4 === 0 && LIVE.conns.size) {
        broadcast({ t: "pings", p: [...LIVE.members.values()].filter(m => !m.host).map(m => [m.id, m.ping ?? null, !!m.relay, (m.rtt || []).length]) });
        if (LIVE.tab === "people") renderLive();
      }
    } else if (left < -15000) liveEnd(false, tr("The live session reached its 3-hour limit and was closed"));
  }, 1000);
}
function liveEnd(notify, msg, why) {
  if (!LIVE.on && !LIVE.peer) return;
  const watched = LIVE.watch;
  if (LIVE.host) { broadcast({ t: "end", why }); }
  const peer = LIVE.peer;
  setTimeout(() => { try { peer && peer.destroy(); } catch {} }, 300);
  clearInterval(LIVE.timer);
  Object.assign(LIVE, { on: false, host: false, peer: null, hostConn: null, canEdit: false, idBase: 0, highlights: [], flash: null, pkg: null, pkgBlob: null, pkgKey: "",
    turn: null, token: "", relay: false, rk: "", ping: null, autoDone: false, directPing: null, switching: false, watch: false });
  if (watched && !can("editor")) setMode(false, true); // a guest who watched: back to the preview
  LIVE.conns.clear(); LIVE.members.clear();
  inkReset(); LIVE.dragKey = "";
  closeLive(); updateLivePill(); dirty = true;
  if (msg) toast(msg, 4500);
}
function liveLeftPlayer() { if (LIVE.on) liveEnd(true, LIVE.host ? tr("Live session ended") : tr("You left the live session")); }

// ---------- UI: pill in the top bar + side sheet (people / comments / activity) ----------
function updateLivePill() {
  if (document.body.classList.contains("live-watch") !== (LIVE.on && LIVE.watch)) { document.body.classList.toggle("live-watch", LIVE.on && LIVE.watch); measureIns(); dirty = true; }
  if (typeof inkUpdate === "function") inkUpdate();
  const p = $("livePill"); p.hidden = !LIVE.on; if ($("liveChat").hidden === chatOn()) { if (!chatOn()) chatOpen(false, false); renderChat(); } $("liveBtn").classList.toggle("lit", LIVE.on || (typeof COLLAB !== "undefined" && COLLAB.on)); $("edHl").hidden = !LIVE.on;
  if (!LIVE.on) return;
  const left = Math.max(0, LIVE.expires - Date.now()), hh = Math.floor(left / 3600000), mm = Math.floor(left / 60000) % 60, ss = Math.floor(left / 1000) % 60;
  const txt = `LIVE ${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} · ${LIVE.members.size || 1}`;
  if (p.textContent !== txt) p.textContent = txt;
  p.classList.toggle("warn", left < 600000);
}
function openLive() { closeSheet(); closeTools(); $("liveSheet").hidden = false; clearTimeout(uiTimer); renderLive(); }
function closeLive() { if (!$("liveSheet").hidden) { $("liveSheet").hidden = true; showUI(); } }
function renderLive() {
  const sh = $("liveSheet"); if (sh.hidden) return;
  const body = $("lsBody"), head = $("lsHead"); head.innerHTML = ""; body.innerHTML = "";
  if (!LIVE.on) {
    head.append(h("p", "hint", tr("Mod or map this beatmap together in real time. As the host you can edit everything, give people permission to move objects, and remove them. Visitors can highlight objects and comment. Sessions close after 3 hours.")));
    if (liveUser()) {
      const ts = h("label", "sw"), tt = h("span", "swt"), ti = h("input"); ti.type = "checkbox"; ti.className = "switch"; ti.checked = liveTurnPref();
      tt.append(h("b", null, tr("TURN relay")), h("small", null, tr("On: people who can't connect directly, or whose ping is high, go through Cloudflare's TURN relay. Off: peer-to-peer only.")));
      ti.onchange = () => liveTurnPref(ti.checked); ts.append(tt, ti); head.append(ts);
    }
    const b = h("button", "btn main wide", tr("Start a live session")); b.onclick = liveStart; head.append(b);
    if (!liveUser()) head.append(h("p", "hint", tr("Hosting needs an osu! login.")));
    const jf = h("form", "searchrow"), ji = h("input"), jb = h("button", "btn ghost", tr("Join"));
    ji.placeholder = tr("Session code"); ji.setAttribute("aria-label", ji.placeholder); ji.autocomplete = "off"; jf.onsubmit = e => { e.preventDefault(); liveJoinPrompt(ji.value); }; jf.append(ji, jb);
    body.append(h("h3", null, tr("Join a session")), jf);
    return;
  }
  const top = h("div", "lstop"), code = h("b", "lscode", LIVE.code.toUpperCase());
  const inv = h("button", "btn ghost sm", tr("Copy invite link")); inv.onclick = async () => toast(await copyText(inviteURL()) ? tr("Invite link copied") : inviteURL());
  const end = h("button", "btn ghost sm danger", tr(LIVE.host ? "End session" : "Leave")); end.onclick = async () => { if ((await ask(tr(LIVE.host ? "End the live session for everyone?" : "Leave the live session?"), { ok: tr(LIVE.host ? "End session" : "Leave"), danger: true }))) liveEnd(true, tr(LIVE.host ? "Live session ended" : "You left the live session")); };
  top.append(h("span", "lsdot"), code, inv, end); head.append(top);
  const left = Math.max(0, LIVE.expires - Date.now());
  head.append(h("p", "hint", LIVE.watch ? tr("You're watching • only the host edits, you follow their playback • closes in {m} min", { m: Math.ceil(left / 60000) })
    : tr(LIVE.host ? "You're the host • closes in {m} min • export your work before it ends" : "You're a visitor ({perm}) • closes in {m} min", { m: Math.ceil(left / 60000), perm: tr(LIVE.canEdit ? "can edit" : "view only") })));
  const tabs = h("div", "tabs");
  for (const [k, l] of [["people", "People"], ["comments", "Comments"], ["activity", "Activity"]]) { const b = h("button", "tab" + (LIVE.tab === k ? " on" : ""), tr(l) + (k === "comments" && LIVE.comments.length ? ` (${LIVE.comments.length})` : "")); b.onclick = () => { LIVE.tab = k; renderLive(); }; tabs.append(b); }
  head.append(tabs);
  if (LIVE.tab === "people") {
    if (LIVE.host) {
      const g = h("label", "sw"), gt = h("span", "swt"), gi = h("input"); gi.type = "checkbox"; gi.className = "switch"; gi.checked = LIVE.guests;
      gt.append(h("b", null, tr("Allow guests")), h("small", null, tr("People without an osu! login can join"))); gi.onchange = () => { LIVE.guests = gi.checked; }; g.append(gt, gi); body.append(g);
    } else if (!LIVE.watch) {
      const g = h("label", "sw"), gt = h("span", "swt"), gi = h("input"); gi.type = "checkbox"; gi.className = "switch"; gi.checked = LIVE.follow;
      gt.append(h("b", null, tr("Follow the host")), h("small", null, tr("Play, pause and seek along with the host"))); gi.onchange = () => { LIVE.follow = gi.checked; }; g.append(gt, gi); body.append(g);
    }
    if (!LIVE.watch) {
      const g = h("label", "sw"), gt = h("span", "swt"), gi = h("input"); gi.type = "checkbox"; gi.className = "switch"; gi.checked = !!S.inkTools;
      gt.append(h("b", null, tr("Drawing tools")), h("small", null, tr("A brush button on the playfield: pen, highlighter and point for everyone. While a tool is out, objects can't be selected."))); gi.onchange = () => inkShow(gi.checked); g.append(gt, gi); body.append(g);
    }
    for (const m of [...LIVE.members.values()].sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0) || a.num - b.num)) {
      const row = h("div", "lsm"), av = h("i", "av"); av.style.borderColor = m.color; if (m.avatar) av.style.backgroundImage = `url("${m.avatar}")`;
      const nm = h("div", "lsn"), sm = h("small", null, [m.host ? tr("host") : m.watch ? tr("watching (guest)") : m.canEdit ? tr("can edit") : tr("view only"), m.verified ? "osu! ✓" : tr("guest"), m.country || ""].filter(Boolean).join(" • "));
      if (!m.host && m.ping != null) { sm.append(" • "); sm.append(h("span", "lsping " + (m.ping > ((LIVE.turn && LIVE.turn.ping_ms) || 150) ? "bad" : m.ping > 80 ? "mid" : "ok"), tr("{ms} ms", { ms: m.ping }))); }
      if (m.relay || (m.id === LIVE.me.id && LIVE.relay)) { sm.append(" • "); sm.append(h("span", "lsrelay", "TURN")); }
      nm.append(h("b", null, m.name + (m.id === LIVE.me.id ? " " + tr("(you)") : "")), sm);
      row.append(av, nm);
      if (LIVE.host && !m.host) {
        const pe = h("input"); pe.type = "checkbox"; pe.className = "switch"; pe.checked = !!m.canEdit; pe.title = tr("Can edit"); pe.setAttribute("aria-label", tr("Can edit")); pe.onchange = () => setPerm(m.id, pe.checked);
        const kb = h("button", "btn ghost sm", tr("Remove")); kb.onclick = async () => { if ((await ask(tr("Remove {n} from the session?", { n: m.name }), { ok: tr("Remove"), danger: true }))) kick(m.id); };
        if (m.watch) row.append(kb); else row.append(pe, kb); // a guest only watches: no edit permission to give
      }
      body.append(row);
    }
    if (LIVE.host && LIVE.members.size < 2) body.append(h("p", "hint", tr("Nobody here yet. Send the invite link or the code {c}.", { c: LIVE.code.toUpperCase() })));
    body.append(h("p", "hint", !turnOk(LIVE.turn) ? tr("Connection: peer-to-peer. Ping is each person's round trip to the host.")
      : LIVE.relay ? tr("Your connection goes through the TURN relay (Cloudflare). Ping is each person's round trip to the host.")
      : tr("Connection: peer-to-peer. Ping is each person's round trip to the host; above {ms} ms they switch to the TURN relay (Cloudflare) by themselves.", { ms: LIVE.turn.ping_ms })));
    if (!LIVE.watch) body.append(h("p", "hint", tr("Shortcuts: H highlights the selected objects for everyone.")));
  } else if (LIVE.tab === "comments") {
    const f = h("form", "searchrow"), i = h("input"), b = h("button", "btn main", tr("Send"));
    i.placeholder = tr("Comment at the current time / selection"); i.setAttribute("aria-label", i.placeholder); i.maxLength = 1000; i.autocomplete = "off";
    i.addEventListener("keydown", e => e.stopPropagation());
    f.onsubmit = e => { e.preventDefault(); liveComment(i.value); i.value = ""; setTimeout(() => $("lsBody").querySelector("input") && $("lsBody").querySelector("input").focus(), 0); };
    f.append(i, b); if (!LIVE.watch) body.append(f); // watchers read only
    const list = h("div", "tlist");
    for (const c of LIVE.comments) {
      const el = h("div", "note"), hd = h("div", "nh"), go = h("button", "mlink", c.ts || fmtMs(c.t));
      el.style.borderLeftColor = c.color;
      go.onclick = () => { seekTo(c.t); const o = map.hit.find(x => Math.abs(x.t - c.t) < 2); if (o) edSelectIds([o.lid]); if (EDIT.tab !== "compose") edTab("compose"); };
      hd.append(go, h("span", null, c.name));
      if (LIVE.host) { const tn = h("button", "mlink", tr("→ Mod note")); tn.onclick = () => { const all = loadNotes(); all.push({ id: Date.now(), t: c.t, ts: c.ts, type: "note", text: `${c.text} (${c.name})` }); saveNotes(all); toast(tr("Saved as a mod note"), 1200); }; hd.append(tn); }
      if (LIVE.host || c.by === LIVE.me.id) { const dl = h("button", "mlink", tr("Delete")); dl.onclick = () => { delCm(c.id); liveSendAll({ t: "cmdel", id: c.id }); }; hd.append(dl); }
      el.append(hd, h("p", null, c.text)); list.append(el);
    }
    if (!LIVE.comments.length) list.append(h("p", "hint", tr("No comments yet. Select objects (or move to a time) and write one.")));
    body.append(list);
  } else {
    const list = h("div", "tlist");
    for (const f of LIVE.feed) {
      const r = h("button", "viss"); r.append(h("span", "ts", new Date(f.at).toTimeString().slice(0, 5)), h("span", null, f.text));
      if (f.t != null) r.onclick = () => seekTo(f.t); list.append(r);
    }
    body.append(list);
  }
}
// one "Live mapping" button for both ways of working together: live session and collab
$("liveBtn").onclick = e => {
  if (!$("liveSheet").hidden) return closeLive();
  if (LIVE.on) return openLive();
  if (typeof COLLAB !== "undefined" && COLLAB.on) return collabOpen();
  const r = $("liveBtn").getBoundingClientRect(); e.stopPropagation();
  ctxMenu(r.left, r.bottom + 6, [
    { label: tr("Live session") + " — " + tr("the host decides who may edit"), action: () => openLive() },
    { label: tr("Collab together") + " — " + tr("everyone edits one difficulty"), action: () => collabOpen() }]);
};
$("livePill").onclick = openLive;
$("lsClose").onclick = closeLive;
$("edHl").onclick = liveHighlight;
$("hubJoin").onsubmit = e => { e.preventDefault(); liveJoinPrompt($("hubCode").value); $("hubCode").value = ""; };
$("homeJoin").onclick = async () => {
  if (!can("editor")) { const c = (await askText(tr("Session code"))); if (c) liveJoinPrompt(c); return; } // guests who may only watch
  goView("editor"); setTimeout(() => $("hubCode").focus(), 60);
};

// ---------- chat popup: messages pop up as bubbles over the editor; the panel keeps the whole conversation ----------
// Chat lines, timeline comments and join/leave notices share one stream. Timestamps like 00:12:345 (1,2) become links.
// The same chat serves a collab session (collab.js relays it through the collab host).
const CHAT_MAX = 300;
const chatOn = () => LIVE.on || (typeof COLLAB !== "undefined" && COLLAB.on);
const chatMe = () => LIVE.on ? LIVE.me : COLLAB.me && { id: COLLAB.me.uid, name: COLLAB.me.name, color: COLLAB.me.color };
function cleanChat(m0, m) { if (!m0 || typeof m0.text !== "string" || !m0.text.trim()) return null; return { id: String(m0.id || Date.now()).slice(0, 80), text: m0.text.trim().slice(0, 500), by: m.id, name: m.name, color: m.color, at: Date.now() }; }
function chatAdd(m) {
  if (m.id && LIVE.chat.some(x => x.id === m.id)) return;
  LIVE.chat.push(m); if (LIVE.chat.length > CHAT_MAX) LIVE.chat.shift();
  const me = chatMe(), mine = m.by && me && m.by === me.id;
  if (!LIVE.chatOpen && !mine) { if (!m.sys) LIVE.unread++; chatBubble(m); }
  renderChat();
}
function liveChat(text) {
  text = String(text || "").trim(); const me = chatMe(); if (!text || !chatOn() || !me || liveWatchOnly()) return;
  const m = { id: LIVE.on ? liveUid() : cid(), text: text.slice(0, 500), by: me.id, name: me.name, color: me.color, at: Date.now() };
  chatAdd(m); if (LIVE.on) liveSendAll({ t: "chat", m }); else collabChatSend(m);
}
function chatSys(k, n) { const m = { id: "sys:" + k + ":" + n + ":" + Date.now(), sys: k, n, at: Date.now() }; chatAdd(m); return m; }
function chatText(el, text) { // plain text with osu! timestamps turned into seek links
  const re = /(\d{2,}:\d{2}:\d{3}(?: \([\d,|]+\))?)/g; let last = 0, mm;
  while ((mm = re.exec(text))) {
    if (mm.index > last) el.append(text.slice(last, mm.index));
    const a = h("button", "mlink lcts", mm[1]), ms = tsToMs(mm[1]);
    a.onclick = () => { if (ms == null || !map) return; seekTo(ms); const o = map.hit.find(x => Math.abs(x.t - ms) < 2); if (o && EDIT.on) edSelectIds([o.lid]); if (EDIT.on && EDIT.tab !== "compose") edTab("compose"); };
    el.append(a); last = re.lastIndex;
  }
  if (last < text.length) el.append(text.slice(last));
}
function chatLine(m, compact) {
  const row = h("div", "lcm" + (m.sys ? " sys" : "") + (m.cm ? " cm" : ""));
  if (m.sys) { row.textContent = tr(m.sys === "join" ? "{n} joined" : "{n} left", { n: m.n }); return row; }
  const who = h("b", null, m.name); who.style.color = m.color || "#fff";
  row.style.setProperty("--c", m.color || "#fff");
  const body = h("span", "lct");
  if (m.cm) { const ts = h("button", "mlink lcts", m.ts || fmtMs(m.t)); ts.onclick = () => { seekTo(m.t); const o = map && map.hit.find(x => Math.abs(x.t - m.t) < 2); if (o && EDIT.on) edSelectIds([o.lid]); }; body.append("💬 ", ts, " "); }
  chatText(body, m.text);
  row.append(who, body);
  if (!compact) row.title = new Date(m.at).toLocaleTimeString();
  return row;
}
function chatBubble(m) {
  const box = $("lcBubbles"); if (!box || $("liveChat").hidden) return;
  const b = chatLine(m, true); b.classList.add("lcb"); b.onclick = e => { if (!e.target.closest(".lcts")) chatOpen(true); };
  box.append(b); while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { b.classList.add("out"); setTimeout(() => b.remove(), 400); }, m.sys ? 3000 : 6500);
}
function renderChat() {
  const wrap = $("liveChat"); if (!wrap) return;
  wrap.hidden = !chatOn(); $("lcForm").hidden = LIVE.on && LIVE.watch; // watchers read the chat only
  const badge = $("lcBadge"); badge.hidden = !LIVE.unread; badge.textContent = LIVE.unread > 99 ? "99+" : LIVE.unread;
  if (!LIVE.chatOpen) return;
  const list = $("lcList"), atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = "";
  const items = [...LIVE.chat, ...LIVE.comments.map(c => ({ ...c, cm: true }))].sort((a, b) => a.at - b.at);
  if (!items.length) list.append(h("p", "hint", tr("No messages yet. Say hi!")));
  for (const m of items.slice(-200)) list.append(chatLine(m));
  if (atEnd || !chatOpen.scrolled) { list.scrollTop = list.scrollHeight; chatOpen.scrolled = true; }
}
function chatOpen(on, focus = true) {
  LIVE.chatOpen = on; $("lcPanel").hidden = !on; $("lcBtn").classList.toggle("on", on);
  if (on) { LIVE.unread = 0; $("lcBubbles").innerHTML = ""; chatOpen.scrolled = false; renderChat(); if (focus) setTimeout(() => $("lcInput").focus(), 30); }
  renderChat();
}
$("lcBtn").onclick = () => chatOpen(!LIVE.chatOpen);
$("lcClose").onclick = () => chatOpen(false);
$("lcForm").onsubmit = e => { e.preventDefault(); liveChat($("lcInput").value); $("lcInput").value = ""; };
$("lcInput").addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); $("lcInput").blur(); chatOpen(false); } e.stopPropagation(); });
// Enter opens the chat while a live or collab session is on (like in-game chat)
document.addEventListener("keydown", e => {
  if (!chatOn() || UI.player.hidden || e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || EDIT.sliderPts || CTX.stack.length) return;
  e.preventDefault(); chatOpen(true);
}, true);
addEventListener("langchange", () => { renderAccount(); renderLive(); renderChat(); });
addEventListener("beforeunload", () => { if (LIVE.on && LIVE.host) broadcast({ t: "end" }); });
renderAccount();
authCheck();
