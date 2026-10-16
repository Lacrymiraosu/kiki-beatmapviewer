"use strict";
// ============ loading overlay ============
function showLoading(text, p) {
  $("loading").hidden = false; $("loadText").textContent = text;
  ldsShow(p); // the one loading scene (js/loadscene.js)
}
const hideLoading = () => { $("loading").hidden = true; ldsHidden(); };

// why an osu! login didn't work (the reason comes back from /api/auth/callback as ?login=...)
function loginWhy(why) {
  const M = { cancelled: "you cancelled it on osu!", expired: "it took too long or started in another tab, please try again",
    bad_key: "osu! didn't accept this site's app key (the site admin needs to check OSU_CLIENT_ID / OSU_CLIENT_SECRET)",
    bad_code: "osu! didn't accept the login code (already used, or the callback URL differs), please try again",
    profile: "couldn't read your osu! profile, please try again", network: "couldn't reach osu!, please try again",
    not_configured: "osu! login isn't set up on this site yet",
    busy: "osu! is limiting requests from this site right now (too many requests), please wait a few minutes and try again",
    alt_off: "that login isn't set up on this site", link_login: "log in with osu! first, then link it",
    linked_elsewhere: "that account is already linked to another osu! account here",
    not_linked: "that account isn't linked to an osu! account here yet: log in with osu! once and link it in Account → Backup logins",
    alt_error: "the sign-in didn't work, please try again",
    google_new: "that Google account isn't linked to an osu! account here yet: log in with osu! once and link it in Account settings → Backup logins" };
  return M[why] ? tr(M[why]) : /^token_\d+$/.test(why) ? tr("osu! refused the login (HTTP {s})", { s: why.slice(6) }) : why;
}
// ============ URL state ============
// home menu: ./   song select: ?view=songs | ?q=<text> | ?u=<mapper> (+ &st=<status>, &for=edit = picking a map for the editor)
// other pages: ?view=editor|create|credits|privacy|changelog   live session: ?live=<code>
// a beatmap:  ?s=<setId>&b=<beatmapId>[&t=<ms>][&mode=mod]
const STATUSES = ["leaderboard", "", "ranked", "loved", "qualified", "pending", "graveyard"];
const ST_LABEL = { leaderboard: "Has leaderboard", "": "All", ranked: "Ranked", loved: "Loved", qualified: "Qualified", pending: "Pending", graveyard: "Graveyard" };
const R = { key: null, ctx: null, page: 0, more: false, mirror: null, list: [], busy: false, inMap: false, mapPushed: false, listURL: location.pathname, status: null, view: null, intent: "" };
let curSet = null;      // normalized set info of the open beatmap (from the mirror API)
let onlineSet = null;   // set id when the open package came from a mirror
const defSt = u => u ? "" : "leaderboard"; // Select beatmap opens on the maps with a leaderboard (ranked, approved, qualified, loved) like osu!'s listing; a mapper page shows everything
const ctxFromParams = p => { const u = p.get("u") || "", raw = p.get("st"); return { q: p.get("q") || "", u, st: raw === "all" ? "" : raw && (STATUSES.includes(raw) || u && USER_TYPES.some(t => t[0] === raw)) ? raw : defSt(u), f: u ? fEmpty() : fFromParams(p) }; };
const ctxKey = c => [c.u, c.q, c.st, c.u ? "" : fKey(c.f)].join("\u0001");
function listURL(ctx) {
  const p = new URLSearchParams();
  if (ctx.u) p.set("u", ctx.u); else if (ctx.q) p.set("q", ctx.q);
  if (ctx.st !== defSt(ctx.u)) p.set("st", ctx.st || "all");
  if (!p.has("q") && !p.has("u") && !p.has("st")) p.set("view", "songs");
  if (!ctx.u) fToParams(ctx.f, p); // genre, language, tags, ranges, sort (see osudata.js)
  if (R.intent === "edit") p.set("for", "edit");
  return location.pathname + "?" + p;
}
// ---------- views (pages of the site shell) ----------
const VIEW_EL = { home: "homeView", songs: "select", editor: "edhub", create: "create", credits: "page", privacy: "page", changelog: "page", guide: "page", projects: "projects", admin: "admin", invite: "invite", account: "account", replays: "replays" };
const VIEW_TITLE = { guide: "Guide", editor: "osu! beatmap editor", create: "Create a new beatmap", credits: "Credits", privacy: "Privacy", changelog: "Changelog", projects: "My online projects", admin: "Admin", invite: "Invite friends", account: "Account settings", replays: "Replays" };
// search engines: as the page changes, the same description, canonical URL and noindex api/og.js gives a fresh load of
// it (SEO_DESC = its PAGES descriptions, SEO_PRIVATE = its private keys and views; tests/seo.test.mjs keeps them equal)
const SEO_SITE = "https://osu-beatmap-viewer.lacrymira.workers.dev";
const SEO_DESC = {
  home: "Preview osu! beatmaps online with storyboard and hitsounds, open .osz files, write mod notes and edit maps in an osu!-style editor. Free.",
  songs: "Search osu! beatmaps by status, stars, genre and language, listen to previews and watch any difficulty with its storyboard and hitsounds in your browser.",
  editor: "An osu!-style beatmap editor in your browser: compose, timing, hitsounds and checks, mod notes, and live mapping with friends. Open an .osz or start a map.",
  guide: "How to use beatmap viewer: find and preview maps, mod them with notes and Verify, answer mods, edit maps like in osu!'s editor, plus every shortcut.",
  changelog: "What's new in beatmap viewer: new features, fixes and changes, newest first.",
  credits: "Where beatmap viewer's data, skins, sounds and libraries come from, who made them, and the licences they are used under.",
  privacy: "What beatmap viewer stores and where it goes, and how to delete it: osu! login, online projects, live sessions, and data kept in your browser.",
};
const SEO_PRIVATE = { keys: ["s", "b", "u", "live", "collab", "project", "invite", "replay", "key", "q", "st", "m", "for", "mode", "t", "notes", "login", "access", "accept", "lt", "nt", "score"], views: ["admin", "account", "projects", "invite", "create", "replays"] };
function seoSync() {
  const p = new URLSearchParams(location.search), raw = p.get("view") || "", v = raw in SEO_DESC && raw !== "home" ? raw : "home";
  const priv = SEO_PRIVATE.keys.some(k => p.has(k)) || SEO_PRIVATE.views.includes(raw);
  const tag = (sel, make) => document.head.querySelector(sel) || document.head.appendChild(make());
  if (!priv) tag('meta[name="description"]', () => Object.assign(document.createElement("meta"), { name: "description" })).content = SEO_DESC[v];
  const canon = document.head.querySelector('link[rel="canonical"]'), robots = document.head.querySelector('meta[name="robots"]');
  if (priv) { canon && canon.remove(); tag('meta[name="robots"]', () => Object.assign(document.createElement("meta"), { name: "robots" })).content = "noindex"; }
  else { robots && robots.remove(); tag('link[rel="canonical"]', () => Object.assign(document.createElement("link"), { rel: "canonical" })).href = SEO_SITE + "/" + (v === "home" ? "" : "?view=" + v); }
}
function viewFromParams(p) { const v = p.get("view"); if (v in VIEW_EL) return v; return p.has("q") || p.has("u") || p.has("st") ? "songs" : "home"; }
function showView(v) {
  const was = R.view; R.view = v;
  for (const id of new Set(Object.values(VIEW_EL))) { const el = $(id), on = VIEW_EL[v] === id; if (el.hidden === on) { el.hidden = !on; if (on && was) { el.classList.remove("vin"); void el.offsetWidth; el.classList.add("vin"); } } }
  document.querySelectorAll("#topnav [data-go]").forEach(a => { const on = a.dataset.go === v || (v === "create" && a.dataset.go === "editor"); a.classList.toggle("on", on); on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); });
  $("pickBanner").hidden = !(v === "songs" && R.intent === "edit");
  if (v === "create") renderCreate();
  if (v === "credits" || v === "privacy" || v === "changelog" || v === "guide") renderPage(v);
  if (VIEW_TITLE[v]) setTitle(tr(VIEW_TITLE[v])); else if (v === "home") setTitle("");
  if (v !== "songs") pausePreview();
  if (v === "home") demoStart(); else demoStop();
  if (v === "home" || v === "editor") renderDrafts();
  if (v === "projects") renderProjects();
  if (v === "admin") loadLazy("admin").then(() => {
    if (R.view !== "admin") return; // (left before it arrived)
    if (ADM_HINT) { ADM.tab = ADM_HINT; ADM_HINT = null; }
    renderAdmin();
  }, e => toast(e.message, 4000));
  if (v === "invite") renderInvite();
  if (v === "account") renderAccountPage();
  if (v === "replays") loadLazy("replayui").then(() => { if (R.view === "replays") renderReplays(); }, e => toast(e.message, 4000)); // (replayui.js: the replays kept on this device)
}
function goView(v, extra) {
  const p = new URLSearchParams(extra || {}); if (v !== "home") p.set("view", v);
  const s = p.toString(); history.pushState(null, "", location.pathname + (s ? "?" + s : ""));
  R.leaving = true; route(); scrollTo(0, 0); // (the site's own link: no "Leave this map?")
}
document.addEventListener("click", e => { // <a data-go="view"> links inside the site (only links: a <button data-go="1"> is a "jump there in Compose" button, tools.js panelClick)
  const a = e.target.closest("a[data-go]"); if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
  e.preventDefault(); const v = a.dataset.go;
  if (v === "songs") { R.intent = a.dataset.for || ""; goList({ q: "", u: "", st: defSt() }, true); scrollTo(0, 0); } else goView(v);
});
function mapURL(sid, bid, extra = {}) {
  const p = new URLSearchParams({ s: sid }); if (bid) p.set("b", bid);
  for (const k in extra) if (extra[k] != null) p.set(k, extra[k]);
  return location.pathname + "?" + p;
}
function shareURL(t) {
  const sid = +setId > 0 ? setId : null;
  if (!sid) return typeof cloudLinkURL === "function" && CLOUD.project ? cloudLinkURL(CLOUD.project, t) : null; // a map that isn't on osu!: its project link
  const bid = map && +map.meta.BeatmapID > 0 ? map.meta.BeatmapID : null;
  return location.origin + mapURL(sid, bid, { t: t != null && t > 0 ? Math.round(t) : null });
}
function setMapURL(sid, bid, push) {
  const cur = new URLSearchParams(location.search), url = mapURL(sid, bid, { mode: cur.get("mode"), notes: cur.get("notes") }) + location.hash;
  if (push && !R.mapPushed) { R.listURL = location.pathname + location.search; history.pushState({ map: 1 }, "", url); R.mapPushed = true; }
  else history.replaceState(history.state, "", url);
  R.inMap = true;
}
function setModeParam(on) {
  if (!R.inMap) return;
  const p = new URLSearchParams(location.search); if (!p.get("s")) return;
  on ? p.set("mode", "mod") : p.delete("mode"); p.delete("t");
  history.replaceState(history.state, "", location.pathname + "?" + p);
}
// user closed the beatmap (detail or player): go back to the list it came from
// the page's address now and just before the latest change (pushState, or back / forward): route() can put the page
// back exactly as it was when a back from the open map is refused (registered before route()'s own popstate listener)
const NAV = { here: location.href, before: location.href };
{ const ps = history.pushState.bind(history), rs = history.replaceState.bind(history);
  history.pushState = (st, t, u) => { NAV.before = NAV.here; ps(st, t, u); NAV.here = location.href; };
  history.replaceState = (st, t, u) => { rs(st, t, u); NAV.here = location.href; }; }
addEventListener("popstate", () => { NAV.before = NAV.here; NAV.here = location.href; });
function leaveMap() {
  if (!R.inMap) return;
  R.inMap = false; R.leaving = true; // (route() then doesn't ask: this is the site's own way out)
  if (R.mapPushed) { R.mapPushed = false; history.back(); }
  else { history.replaceState(null, "", R.listURL); route(); }
}
const listTitle = ctx => ctx.u ? `${ctx.u} (mapper)` : ctx.q ? tr("Search \"{q}\"", { q: ctx.q }) : tr("Browse osu! beatmaps");

// ============ search / list ============
let listCtl = null;
function buildFilters() {
  $("filters").innerHTML = "";
  const prof = R.ctx && R.ctx.u && R.user;
  if (prof) {
    for (const [t, label] of USER_TYPES) {
      const n = prof.counts[t] || 0; if (!n && R.ctx.st !== t) continue;
      const b = h("button", "chip", `${tr(label)} ${n}`); b.dataset.st = t; b.setAttribute("role", "tab");
      b.onclick = () => goList({ ...R.ctx, st: t }, false);
      $("filters").append(b);
    }
    syncSearchUI(R.ctx); return;
  }
  for (const st of STATUSES) {
    const b = h("button", "chip", tr(ST_LABEL[st])); b.dataset.st = st; b.setAttribute("role", "tab");
    b.onclick = () => { const c = R.ctx || { q: "", u: "" }; goList({ ...c, q: kwStrip(c.q, t => t.kind === "status"), st }, false); }; // (a chip replaces status=… in the box)
    $("filters").append(b);
  }
  if (typeof advChip === "function" && !(R.ctx && R.ctx.u)) $("filters").append(advChip());
  if (R.ctx) syncSearchUI(R.ctx);
}
buildFilters();
function syncSearchUI(ctx) {
  const kst = !ctx.u && kwStatus(kwParse(ctx.q)); // (status=… in the box overrides the chips)
  document.querySelectorAll("#filters .chip").forEach(b => { const on = !kst && b.dataset.st === ctx.st; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  const q = $("q"); if (document.activeElement !== q) q.value = ctx.u ? `mapper:${ctx.u}` : ctx.q;
}
function goList(ctx, push) {
  history[push ? "pushState" : "replaceState"](null, "", listURL(ctx));
  R.leaving = true; route();
}
function goMapper(name) {
  const url = listURL({ u: name, q: "", st: "" });
  if (R.inMap) { hideDetail(); R.inMap = false; R.mapPushed = false; history.replaceState(null, "", url); }
  else history.pushState(null, "", url);
  R.leaving = true; route();
  scrollTo(0, 0);
}
function goMap(sid, bid) {
  R.listURL = location.pathname + location.search;
  const p = new URLSearchParams(); if (sid) p.set("s", sid); if (bid) p.set("b", bid);
  history.pushState({ map: 1 }, "", location.pathname + "?" + p);
  route();
}
function parseQuery(raw) {
  const q = raw.trim(); let m;
  if ((m = q.match(/osu\.ppy\.sh\/scores\/(?:[a-z]+\/)?(\d{1,12})(?!\d)/i))) return { score: m[1] }; // (a score link: its replay, js/replayui.js rpuPasteScore)
  if ((m = q.match(/[?&]s=(\d+)/))) return { s: m[1], b: (q.match(/[?&]b=(\d+)/) || [])[1] };
  if ((m = q.match(/beatmapsets\/(\d+)(?:#\w+\/(\d+))?/))) return { s: m[1], b: m[2] };
  if ((m = q.match(/(?:\/b\/|\/beatmaps\/)(\d+)/))) return { b: m[1] };
  if ((m = q.match(/\/s\/(\d+)/)) || (m = q.match(/^(\d+)$/))) return { s: m[1] };
  if ((m = q.match(/\/users?\/([^/?#\s]+)/))) return /^\d+$/.test(m[1]) ? { err: tr("Type the mapper's name instead of a user ID, e.g. mapper:Sotarks") } : { u: decodeURIComponent(m[1]) };
  // mapper:name alone opens the mapper's page (names can have spaces); with other keywords it's a keyword search
  if ((m = q.match(/^(?:mapper|creator|u)\s*[:=]\s*(.+)$/i)) && !kwParse(m[1]).terms.length) return { u: m[1].trim().replace(/^"|"$/g, "") };
  return { q };
}
$("searchForm").onsubmit = e => {
  e.preventDefault(); $("q").blur();
  const r = parseQuery($("q").value);
  if (r.err) return toast(r.err);
  if (r.score) { loadLazy("replayui").then(() => rpuPasteScore(r.score), e => toast(e.message, 4000)); return; }
  if (r.s || r.b) return goMap(r.s, r.b);
  if (r.u) return goMapper(r.u);
  goList({ q: r.q, u: "", st: R.ctx ? R.ctx.st : "", f: R.ctx && !R.ctx.u ? R.ctx.f : undefined }, true);
};
$("home").onclick = e => { e.preventDefault(); if (location.search) goView("home"); scrollTo({ top: 0, behavior: "smooth" }); };
// quick search from the home menu and the editor page
for (const [f, i, edit] of [["homeSearch", "homeQ", false], ["hubSearch", "hubQ", true]]) $(f).onsubmit = e => {
  e.preventDefault(); $(i).blur(); R.intent = edit ? "edit" : "";
  const r = parseQuery($(i).value); $(i).value = "";
  if (r.err) return toast(r.err);
  if (r.score) { loadLazy("replayui").then(() => rpuPasteScore(r.score), e => toast(e.message, 4000)); return; }
  if (r.s || r.b) return goMap(r.s, r.b);
  if (r.u) return goMapper(r.u);
  goList({ q: r.q, u: "", st: defSt() }, true);
};
$("pickBannerX").onclick = () => { R.intent = ""; goList(R.ctx || { q: "", u: "", st: defSt() }, false); };

function showStatus() {
  const s = R.status; if (!s) return setStatus("");
  setStatus(s.loading ? tr(s.loading, { u: s.u }) : s.count ? `${s.u ? tr("{n} maps", { n: s.count }) : s.q || s.filtered ? tr("{n} results", { n: s.count }) : tr("Latest maps")} · ${s.src} · ${tr("tap a card for details")}` : "");
}
// Refresh (button, mirror change, or coming back after a while): the list again from the mirror, not from any cache,
// so newly ranked / updated maps show up
function refreshList() {
  if (!R.ctx || R.view !== "songs") return;
  fetchFresh = true; jsonCache.clear();
  loadList(R.ctx).finally(() => { fetchFresh = false; });
}
async function loadList(ctx, append) {
  const key = ctxKey(ctx), box = $("results");
  if (!append) R.loadedAt = Date.now();
  if (!append) {
    R.ctx = ctx; R.key = key; R.page = 0; R.list = []; R.mirror = null; R.more = false; R.user = null; R.cursor = null; R.viaOsu = false;
    box.innerHTML = ""; for (let i = 0; i < 6; i++) box.append(h("div", "card sk"));
    renderMapperHead(); if (typeof advRender === "function") advRender();
    setTitle(listTitle(ctx));
  }
  listCtl && listCtl.abort(); listCtl = new AbortController(); const sig = listCtl.signal;
  R.busy = true; $("more").hidden = true;
  R.status = { loading: ctx.u ? "Loading maps by {u}…" : ctx.q ? "Searching…" : "Loading the latest maps…", u: ctx.u }; showStatus();
  if (ctx.u) {
    if (!append) { R.user = null; R.userErr = ""; }
    if (!append && osuApi.ok !== false) {
      let u = null; try { u = await osuUser(ctx.u, sig); } catch { if (sig.aborted) return; }
      if (R.key !== key) return;
      if (u === false) { R.busy = false; R.userErr = "missing"; box.innerHTML = `<div class="empty">${esc(tr("No osu! user called {u} (check the spelling)", { u: ctx.u }))}</div>`; R.status = null; showStatus(); renderMapperHead(); buildFilters(); return; }
      if (u) { R.user = u; if (!ctx.st || !USER_TYPES.some(t => t[0] === ctx.st)) { const first = USER_TYPES.find(t => u.counts[t[0]] > 0); ctx.st = first ? first[0] : "ranked"; R.key = ctxKey(ctx); history.replaceState(history.state, "", listURL(ctx)); } buildFilters(); renderMapperHead(); }
    }
    if (R.user) return loadUserSets(ctx, append, sig);
  }
  // Searches with words go to the mirrors (osu.direct first, the one picked in Mirror) and to osu! through our server
  // when no mirror answers. The list without words (osu!'s own listing: Has leaderboard, newest first) and filtered
  // lists (genre, language, tags, ranges, sort: osu! does them all) go to osu! first, the mirrors filtered here after.
  // keywords in the box (stars>5 source="touhou", osudata.js) count as filters: osu! does them all, mirrors partly
  const kw = ctx.u ? null : kwParse(ctx.q), fn = ctx.u ? 0 : fCount(ctx.f) + kw.terms.length;
  const fromOsu = async () => {
    const r = await osuSearch({ q: ctx.q, st: ctx.st, f: ctx.f, cursor: append ? R.cursor : null }, sig);
    if (R.key !== key) return;
    if (!append) box.innerHTML = "";
    R.viaOsu = true; R.cursor = r.cursor; R.more = !!r.cursor; R.page++;
    const fresh = r.list.filter(s => !R.list.some(x => x.id === s.id));
    R.list.push(...fresh); fresh.forEach((s, i) => box.append(card(s, i)));
    R.busy = false;
    if (!R.list.length) box.innerHTML = `<div class="empty">${esc(fn ? tr("No maps match these filters") : tr("No results, try other words"))}</div>`;
    R.status = R.list.length ? { count: (r.total != null ? fmtInt(r.total) : R.list.length + (R.more ? "+" : "")), q: ctx.q, filtered: !!fn, src: "osu!" } : null; showStatus();
    $("more").hidden = !R.more;
  };
  const canOsu = !ctx.u && osuApi.ok !== false;
  if (canOsu && (append ? R.viaOsu : fn || !ctx.q.trim())) {
    try { return await fromOsu(); }
    catch (e) {
      if (sig.aborted) return;
      if (append) { R.busy = false; toast(tr("Couldn't load more, try again")); $("more").hidden = false; return; } // (the next page has to come from osu! too)
      console.warn("osu! search", e.message, "· trying the mirrors");
      if (fNeedsOsu(ctx.f) || kw.terms.some(t => t.key === "tag" && t.v.includes("/"))) toast(tr("Tag filters and sorting need the osu! connection; showing mirror results filtered here"), 4000);
    }
  }
  try {
    const r = await searchSets({ q: ctx.q, creator: ctx.u, st: ctx.st, page: R.page, kw }, sig, R.mirror);
    if (R.key !== key) return;
    if (!append) box.innerHTML = "";
    R.mirror = r.src.id; R.more = r.more; R.page++;
    if (fn) r.list = r.list.filter(s => fMatch(s, ctx.f));
    const fresh = r.list.filter(s => !R.list.some(x => x.id === s.id));
    R.list.push(...fresh);
    fresh.forEach((s, i) => box.append(card(s, i)));
    R.busy = false;
    if (!R.list.length && R.more && R.page < (fn ? 10 : 6)) return loadList(ctx, true); // creator filter (or the filters) can empty a whole page
    if (!R.list.length) box.innerHTML = `<div class="empty">${esc(ctx.u ? tr("No {mode} maps by {u} (check the spelling)", { mode: "osu!", u: ctx.u }) : fn ? tr("No maps match these filters") : tr("No results, try other words"))}</div>`;
    R.status = R.list.length ? { count: R.list.length + (R.more ? "+" : ""), u: ctx.u, q: ctx.q, filtered: !!fn, src: r.src.name } : null; showStatus();
    $("more").hidden = !R.more;
    renderMapperHead();
  } catch (e) {
    if (sig.aborted) return;
    if (!append && canOsu && !R.viaOsu && ctx.q.trim() && !fn) { // no mirror answered: osu! itself
      try { return await fromOsu(); } catch (e2) { if (sig.aborted) return; console.warn("osu! search", e2.message); }
    }
    R.busy = false;
    if (!append) { box.innerHTML = `<div class="empty">${esc(tr("Couldn't reach the mirrors ({err}). Try another mirror, or enter a beatmapset ID directly.", { err: e.message }))}</div>`; R.status = null; showStatus(); }
    else { toast(tr("Couldn't load more, try again")); $("more").hidden = false; }
  }
}
// a user's public beatmaps from osu! (osu! lists the first 100 of each kind), 20 at a time
async function loadUserSets(ctx, append, sig) {
  const box = $("results"), key = R.key, u = R.user, type = ctx.st, total = Math.min(100, u.counts[type] || 0);
  try {
    const list = total ? await osuUserSets(u.id, type, R.page * 20, sig) : [];
    if (R.key !== key) return;
    if (!append) box.innerHTML = "";
    R.page++;
    const fresh = list.filter(s => !R.list.some(x => x.id === s.id));
    R.list.push(...fresh); fresh.forEach((s, i) => box.append(card(s, i)));
    R.more = list.length === 20 && R.page * 20 < total;
    R.busy = false;
    if (!R.list.length) box.innerHTML = `<div class="empty">${esc(tr("{u} has no maps in this list", { u: u.username }))}</div>`;
    else if (!R.more && (u.counts[type] || 0) > 100) box.append(h("div", "empty small", tr("osu! only lists the first 100 here. See the rest on the osu! profile.")));
    R.status = R.list.length ? { count: R.list.length + (R.more ? "+" : ""), u: ctx.u, src: "osu!" } : null; showStatus();
    $("more").hidden = !R.more;
  } catch (e) {
    if (sig.aborted) return;
    R.busy = false;
    if (!append) { box.innerHTML = ""; const d = h("div", "empty", tr("Couldn't load the maps from osu! ({err}).", { err: e.message })); const again = h("button", "btn ghost sm", tr("Try again")); again.onclick = () => loadList(ctx); d.append(" ", again); box.append(d); R.status = null; showStatus(); }
    else { toast(tr("Couldn't load more, try again")); $("more").hidden = false; }
  }
}
$("more").onclick = () => { if (!R.busy && R.more) loadList(R.ctx, true); };
if ("IntersectionObserver" in window) new IntersectionObserver(es => { if (es[0].isIntersecting && !R.busy && R.more && !$("select").hidden) loadList(R.ctx, true); }, { rootMargin: "600px" }).observe($("more"));

const dlIcon = `<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>`;
const cardIO = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { e.target.style.backgroundImage = `url("${e.target.dataset.bg}")`; cardIO.unobserve(e.target); }
}), { rootMargin: "400px" }) : null;
function mapperLink(name, cls = "mlink") {
  if (!can("mappers") || !featOn("mappers")) return h("span", null, name); // mapper pages are off for this visitor (Admin → Permissions) or for everyone (Admin → Features)
  const a = h("a", cls, name); a.href = listURL({ u: name, q: "", st: "" });
  a.onclick = e => { e.preventDefault(); e.stopPropagation(); goMapper(name); };
  return a;
}
function card(s, i) {
  const c = h("article", "card"); c.style.setProperty("--i", Math.min(i, 12));
  const bg = `https://assets.ppy.sh/beatmaps/${s.id}/covers/${(devicePixelRatio || 1) > 1.4 ? "card@2x" : "card"}.jpg`;
  const cov = h("div", "bc-cov"), img = h("div", "bc-img"); cov.append(img);
  if (cardIO) { img.dataset.bg = bg; cardIO.observe(img); } else img.style.backgroundImage = `url("${bg}")`;
  const main = h("button", "cmain"); main.setAttribute("aria-label", `${s.artist} - ${s.title} (${s.creator})`);
  main.onclick = () => openSet(s, undefined, false, c); // (c: the panel grows out of this card)
  const pre = () => { if (!c._pc) { c._pc = new Image(); c._pc.src = `https://assets.ppy.sh/beatmaps/${s.id}/covers/cover@2x.jpg`; } }; // (the panel's cover, fetched when the card is pointed at or touched: usually loaded by the click, so the flying picture is the box's own)
  main.addEventListener("pointerenter", pre); main.addEventListener("pointerdown", pre); main.addEventListener("focus", pre);
  if (s.status) cov.append(h("em", "bc-tag st-" + s.status, s.status));
  const pv = h("button", "bc-play cplay"), dl = h("button", "bc-dl"); dl.type = "button";
  pv.innerHTML = playIcon; pv.title = tr("Listen to the preview"); pv.setAttribute("aria-label", pv.title);
  pv.onclick = e => { e.stopPropagation(); togglePreview(pvURL(s.id), c); };
  dl.innerHTML = dlIcon; // (the set from the mirrors, saved as a file; osu!'s own download is in the detail panel's menu)
  dl.title = tr("Download from the mirror"); dl.setAttribute("aria-label", dl.title);
  dl.onclick = e => { e.stopPropagation(); downloadSave(s); };
  cov.append(dl, pv, h("i", "cprog"));
  const body = h("div", "bc-body"), by = h("div", "bc-by");
  by.append(h("span", null, s.artist), " · ", mapperLink(s.creator));
  const ft = h("div", "bc-ft"), bars = h("span", "bc-bars");
  s.diffs.slice(0, 12).forEach(d => { const k = h("i"); k.style.background = starColor(d.stars); k.title = `${d.name} ★${(+d.stars || 0).toFixed(2)}`; bars.append(k); });
  const meta = [s.bpm ? `${Math.round(s.bpm)} BPM` : "", s.len ? fmt(s.len) : "", s.stars.length ? `★ ${Math.max(...s.stars).toFixed(2)}` : ""].filter(Boolean).join(" · ");
  ft.append(bars, h("span", "bc-meta", meta));
  body.append(h("b", "bc-t", s.title), by, ft);
  c.append(cov, main, body);
  if (pvOwner && pvOwner.sid === s.id && !pvPaused()) setPvOwner(c);
  if (detailInfo && !$("detail").hidden && String(detailInfo.sid) === String(s.id)) c.classList.add("sel");
  if (dSrc != null && String(s.id) === dSrc) c.classList.add("dsrc"); // (rebuilt while the panel stands in for it, e.g. a language change: still hidden)
  c.sid = s.id; oszMark(c); // (the "Downloaded" mark)
  if (SAVING.has(String(s.id))) { dl.disabled = true; dl.setAttribute("aria-busy", "true"); } // (re-rendered while it downloads: the card is not in the page yet)
  return c;
}

// ---------- song previews (b.ppy.sh), playable straight from the cards and the detail panel ----------
const playIcon = `<svg viewBox="0 0 24 24"><path class="pi" d="M8 5l11 7-11 7z"/><path class="pa" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;
let pvOwner = null, pvRaf = 0;
// a set id is a number: anything else from a mirror gets no preview (no button in the detail panel)
const pvURL = id => /^\d+$/.test(String(id ?? "")) ? `https://b.ppy.sh/preview/${+id}.mp3` : "";
function setPvOwner(o) {
  if (pvOwner && pvOwner.classList) { pvOwner.classList.remove("playing"); pvOwner.style.removeProperty("--pp"); }
  pvOwner = o; if (o && o.classList) o.classList.add("playing");
  dPrevLabel(o === "detail");
}
// the Listen / Stop button of the detail panel: the glyph and the words apart, so a narrow panel can show the glyph alone (the words stay in aria-label)
function dPrevLabel(on) {
  const b = $("dPrev"), t = tr(on ? "❚❚ Stop" : "▶ Listen"), m = /^(\S+)\s+(.+)$/.exec(t);
  b.replaceChildren(...(m ? [h("span", "bic", m[1]), h("span", "btxt", m[2])] : [h("span", "btxt", t)])); b.setAttribute("aria-label", m ? m[2] : t);
}
// iPhone / iPad (VOL_FIXED, core.js): the preview is fetched, decoded and played through pvGain, which applyVolumes keeps
// at the site volume while it plays; the <audio> element (above) everywhere else, and there too if b.ppy.sh can't be fetched
let pvWAok = VOL_FIXED && !!(window.AudioContext || window.webkitAudioContext);
const PVW = { url: "", state: "", req: 0, node: null, at: 0, dur: 0, buf: null, bufUrl: "" }; // state: "" | "load" | "play"
const pvPaused = () => PVW.state ? false : prevAudio.paused;
const pvSrc = () => PVW.state ? PVW.url : prevAudio.src;
// iOS only lets an <audio> element start inside a tap, and the fetch below ends after it: so the tap also starts
// prevAudio muted (pvPrime). If the fetch fails it's simply unmuted; if it works it's stopped and Web Audio plays.
// (Its pause / ended events are ignored while PVW.state is set.)
let pvPrime = false;
function pvPrimeStart(url) { pvPrime = true; prevAudio.muted = true; prevAudio.src = url; prevAudio.currentTime = 0; prevAudio.play().catch(() => {}); }
function pvPrimeStop() { if (!pvPrime) return; pvPrime = false; prevAudio.pause(); prevAudio.muted = false; }
function pvStopWA() {
  const n = PVW.node; PVW.node = null; PVW.state = ""; PVW.req++;
  if (n) { n.onended = null; try { n.stop(); } catch {} }
}
async function pvPlayWA(url) {
  const req = ++PVW.req; PVW.url = url; PVW.state = "load";
  if (PVW.bufUrl !== url) pvPrimeStart(url); else pvPrimeStop(); // (still inside the tap: togglePreview calls this synchronously)
  try {
    if (PVW.bufUrl !== url) {
      const r = await fetch(url); if (!r.ok) throw 0;
      const ab = await r.arrayBuffer(); if (req !== PVW.req) return;
      PVW.buf = await decodeAB(ab); PVW.bufUrl = url;
    }
  } catch {
    if (req !== PVW.req) return;
    pvWAok = false; PVW.state = ""; // (no CORS from the server, say): the <audio> element from now on, at its fixed volume
    const primed = pvPrime && prevAudio.src === url; pvPrime = false; prevAudio.muted = false;
    if (!primed) prevAudio.src = url;
    prevAudio.currentTime = 0; prevAudio.volume = musGain();
    if (primed && !prevAudio.paused) return pvTick(); // already playing (unlocked in the tap): just heard now
    prevAudio.play().catch(() => { toast(tr("Couldn't play the preview")); setPvOwner(null); });
    return;
  }
  if (req !== PVW.req) return;
  pvPrimeStop();
  ensureAudioCtx();
  if (!pvGain || pvGain.context !== actx) { pvGain = actx.createGain(); pvGain.connect(actx.destination); } // (a new output after audioRestart)
  pvGain.gain.value = musGain();
  const n = actx.createBufferSource(); n.buffer = PVW.buf; n.connect(pvGain); n.start(0);
  PVW.node = n; PVW.at = actx.currentTime; PVW.dur = PVW.buf.duration; PVW.state = "play";
  n.onended = () => { if (PVW.node === n) { PVW.node = null; PVW.state = ""; setPvOwner(null); } };
  pvTick();
}
function togglePreview(url, owner) {
  if (pvOwner === owner && !pvPaused()) { pausePreview(); return; }
  if (!url) { toast(tr("Couldn't play the preview")); return; }
  ensureAudioCtx();
  if (pvWAok) { pvStopWA(); setPvOwner(owner); pvPlayWA(url); return; }
  pvPrime = false; prevAudio.muted = false;
  prevAudio.src = url; prevAudio.currentTime = 0; prevAudio.volume = musGain();
  setPvOwner(owner);
  prevAudio.play().catch(() => { toast(tr("Couldn't play the preview")); setPvOwner(null); });
}
function pausePreview() { if (PVW.state) { pvStopWA(); setPvOwner(null); } pvPrime = false; prevAudio.pause(); prevAudio.muted = false; }
function pvTick() { // progress bar on the playing card
  cancelAnimationFrame(pvRaf);
  if (pvPaused() || !pvOwner || !pvOwner.style) return;
  const [cur, dur] = PVW.state ? [PVW.node ? actx.currentTime - PVW.at : 0, PVW.dur] : [prevAudio.currentTime, prevAudio.duration];
  pvOwner.style.setProperty("--pp", (cur / (dur || 10) * 100).toFixed(2) + "%");
  pvRaf = requestAnimationFrame(pvTick);
}
prevAudio.addEventListener("play", pvTick);
prevAudio.addEventListener("pause", () => { if (!PVW.state) setPvOwner(null); });
prevAudio.addEventListener("ended", () => { if (!PVW.state) setPvOwner(null); });

// mapper profile header
const uidCache = {};
async function findUid(name) { // Nerinyan results have no user id; ask catboy once for the avatar
  const k = name.toLowerCase(); uidCache[k] = null;
  try {
    const arr = await fetchJSON(`https://catboy.best/api/v2/search?q=${enc(cbCreator(name))}&limit=1&mode=0`);
    const s = Array.isArray(arr) && arr[0];
    if (s && String(s.creator).toLowerCase() === k && s.user_id) { uidCache[k] = s.user_id; if (R.ctx && R.ctx.u.toLowerCase() === k) renderMapperHead(); }
  } catch {}
}
function renderMapperHead() {
  const box = $("mapper"), ctx = R.ctx;
  if (!ctx || !ctx.u) { box.hidden = true; if ($("filters").querySelector("[data-st=guest],[data-st=nominated]") || R.userChips) { R.userChips = false; buildFilters(); } return; }
  box.hidden = false; box.innerHTML = "";
  if (R.user) return renderUserHead(box, R.user);
  box.classList.remove("prof", "hascover");
  const L = R.list, name = (L[0] && L[0].creator) || ctx.u, uid = (L.find(s => s.uid) || {}).uid || uidCache[name.toLowerCase()];
  if (!uid && L.length && !(name.toLowerCase() in uidCache)) findUid(name);
  const av = avatarEl(uid, name, "mav");
  const info = h("div", "minfo");
  info.append(h("h2", null, name), h("p", null, tr("mapper · {mode} maps", { mode: "osu!" })));
  const stats = h("div", "mstats");
  const stat = (label, v) => { const s = h("span"); s.append(h("b", null, v), " " + tr(label)); stats.append(s); };
  if (L.length) {
    stat("maps", L.length + (R.more ? "+" : ""));
    const rk = L.filter(s => s.status === "ranked" || s.status === "approved").length, lv = L.filter(s => s.status === "loved").length;
    if (rk) stat("ranked", rk); if (lv) stat("loved", lv);
    const plays = L.reduce((a, s) => a + (+s.plays || 0), 0), favs = L.reduce((a, s) => a + (+s.favs || 0), 0);
    if (plays) stat("plays", fmtInt(plays)); if (favs) stat("favourites", fmtInt(favs));
    const all = L.flatMap(s => s.stars); if (all.length) stat("top star rating", "★" + Math.max(...all).toFixed(2));
    const years = L.map(s => (s.submitted || s.ranked || "").slice(0, 4)).filter(Boolean).sort();
    if (years.length) stat("years", years[0] === years[years.length - 1] ? years[0] : `${years[0]}–${years[years.length - 1]}`);
  }
  info.append(stats);
  const acts = h("div", "macts");
  const prof = h("a", "btn ghost sm", tr("osu! profile")); prof.href = `https://osu.ppy.sh/users/${uid || enc(name)}`; prof.target = "_blank"; prof.rel = "noopener";
  const share = h("button", "btn ghost sm", tr("Share this page")); share.onclick = () => shareLink(location.origin + listURL({ u: name, q: "", st: ctx.st }), `${name} · beatmap viewer`);
  const back = h("button", "btn ghost sm", tr("← All maps")); back.onclick = () => goList({ q: "", u: "", st: defSt() }, true);
  acts.append(prof, share, back);
  box.append(av, info, acts);
}

// volume popover on the home screen
$("volPop").append(volControl());
$("volBtn").onclick = e => {
  e.stopPropagation();
  const p = $("volPop"); p.hidden = !p.hidden; $("volBtn").setAttribute("aria-expanded", !p.hidden);
  if (!p.hidden) { $("acctPop").hidden = true; syncVol(); placePop(p, $("volBtn")); }
};
// the same volume sliders in the player / editor top bar (the settings sheet is a long way to go for them)
{
  const pop = h("div", "volpop pvolpop"); pop.id = "pVolPop"; pop.hidden = true; pop.append(volControl()); $("player").append(pop);
  $("pVolBtn").onclick = e => {
    e.stopPropagation(); pop.hidden = !pop.hidden; $("pVolBtn").setAttribute("aria-expanded", !pop.hidden);
    if (!pop.hidden) { syncVol(); placePop(pop, $("pVolBtn")); clearTimeout(uiTimer); }
  };
  document.addEventListener("pointerdown", e => { if (!pop.hidden && !pop.contains(e.target) && !$("pVolBtn").contains(e.target)) { pop.hidden = true; $("pVolBtn").setAttribute("aria-expanded", "false"); } });
  addEventListener("resize", () => { if (!pop.hidden) placePop(pop, $("pVolBtn")); });
}
document.addEventListener("pointerdown", e => { const p = $("volPop"); if (!p.hidden && !p.contains(e.target) && !$("volBtn").contains(e.target)) { p.hidden = true; $("volBtn").setAttribute("aria-expanded", "false"); } });

// ============ beatmap detail panel ============
let detailInfo = null, detailPick = null, detailOnGo = null, detailBid = null, detailFrom = false;
function starColor(s) {
  if (s == null) return "#8a7fa3";
  const stops = [[0, "#4290fb"], [2, "#4fc0ff"], [2.5, "#4fffd5"], [3.3, "#7cff4f"], [4.2, "#f6f05c"], [4.9, "#ff8068"], [5.8, "#ff4e6f"], [6.7, "#c645b8"], [7.7, "#6563de"], [9, "#18158e"]];
  let c = stops[0][1]; for (const [v, col] of stops) if (s >= v) c = col; return c;
}
// the pair of a difficulty chip: dark text on the light colours, white on the dark ones, 4.5:1 or more on every one of them. The purple of 6.7-7.7 stars
// (#c645b8) reaches only 4.25:1 with white and 4.12:1 with dark text, so the chip (not the cards' bars or the verifier, which keep starColor) uses a darker one
function starChip(s) {
  const v = s == null || s === "" ? null : +s;
  return { bg: v != null && v >= 6.7 && v < 7.7 ? "#b03aa3" : starColor(v), fg: v != null && v >= 6.7 ? "#fff" : "#1c1726" };
}
function detailFromSet(s) {
  return { sid: s.id, title: s.title, artist: s.artist, titleU: s.titleU, artistU: s.artistU, creator: s.creator, uid: s.uid, status: s.status, bpm: s.bpm, len: s.len, plays: s.plays, favs: s.favs, source: s.source,
    submitted: s.submitted, ranked: s.ranked, updated: s.updated,
    cover: `https://assets.ppy.sh/beatmaps/${s.id}/covers/cover@2x.jpg`, fallbackCover: `https://assets.ppy.sh/beatmaps/${s.id}/covers/card@2x.jpg`,
    preview: pvURL(s.id), diffs: s.diffs, video: s.video, storyboard: s.storyboard, genre: s.genre, language: s.language, tags: s.tags, nsfw: s.nsfw };
}
function openSet(s, bid, noPush, from) { // from: the card that was clicked (the panel grows out of it), none from a link
  curSet = s;
  showDetail(detailFromSet(s), (d, mode) => download(s.id, d, mode), bid, from);
  setMapURL(s.id, detailPick && detailPick.bid, !noPush);
  setTitle(`${s.artist} - ${s.title}`);
}
let detailAt = 0, detailGuard = 350;
function showDetail(info, onGo, bid, from) {
  const d = $("detail"); let wasShut = d.hidden;
  if (!wasShut && (d.classList.contains("out") || (dFlight && dFlight.mode === "close"))) { dFlyStop(); dSrcSet(null); d.classList.remove("out", "fly", "dlate"); wasShut = true; } // opened again while closing: that close is dropped, this is a fresh open
  dGen++;
  const again = info === detailInfo; // (the same panel drawn again: a language change)
  detailAt = performance.now(); detailInfo = info; detailOnGo = onGo; detailPick = null; detailBid = bid;
  document.querySelectorAll("#results .card").forEach(c => c.classList.toggle("sel", !!info.sid && String(c.sid) === String(info.sid)));
  $("dStats").hidden = true;
  loadJSZip().catch(() => {}); // warm up, the user will probably open it
  $("dCover").style.backgroundImage = info.cover ? `url("${info.cover}")${info.fallbackCover ? `, url("${info.fallbackCover}")` : ""}` : "none";
  // (the cover keeps it short: the title 2 lines, the artist and the mapper 1 line each, the full text in the tooltip; the original-script
  // title / artist are in Set information)
  $("dTitle").textContent = info.title || "?"; $("dTitle").title = info.title || "";
  $("dArtist").textContent = info.artist || ""; $("dArtist").title = info.artist || "";
  const dm = $("dMapper"); dm.innerHTML = ""; dm.title = "";
  if (info.creator) { const [pre, post] = tr("mapped by {u}", { u: "\0" }).split("\0"); dm.append(pre, info.sid ? mapperLink(info.creator) : info.creator, post || ""); dm.title = tr("mapped by {u}", { u: info.creator }); }
  const chips = $("dChips"); chips.innerHTML = ""; // (the status badge on the cover; Explicit joins it)
  const chip = (txt, cls) => chips.append(h("em", cls, txt));
  if (info.status) chip(info.status === "local" ? tr("Local file") : info.status, "st-" + info.status);
  if (info.nsfw) chip(tr("Explicit"), "nsfw");
  if (typeof renderSetMeta === "function") renderSetMeta($("dMeta"), info);
  detailHave();
  // actions
  const keepPv = pvOwner && pvOwner !== "detail" && !pvPaused() && info.preview && pvSrc() === info.preview;
  if (keepPv) setPvOwner("detail"); else pausePreview(); // the card's preview keeps playing into its detail
  const pb = $("dPrev"); pb.hidden = !info.preview; dPrevLabel(pvOwner === "detail");
  pb.onclick = () => togglePreview(info.preview, "detail");
  $("dShare").hidden = !info.sid;
  $("dShare").onclick = () => shareLink(location.origin + mapURL(info.sid, detailPick && detailPick.bid), `${info.artist} - ${info.title}`);
  const dd = $("dDl"); dd.hidden = !info.sid; dd.open = false;
  if (info.sid) { // osu! first (the official download, opens in a new tab), then the mirrors
    const menu = $("dDlMenu"); menu.innerHTML = "";
    const link = (href, cls, name, note) => { const a = h("a", cls); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.append(h("span", null, name), h("small", null, note)); menu.append(a); return a; };
    link(osuDlURL(info.sid), "osu", tr("Download from osu!"), tr("official • opens osu.ppy.sh (login needed)"));
    menu.append(h("div", "ddlsep", tr("Mirrors")));
    for (const m of MIRRORS) link(m.dl(info.sid), "", m.name, tr("no video"));
    detailInfo.osuLink = link(osuSetURL(info.sid, detailPick && detailPick.bid), "", tr("Map page on osu.ppy.sh"), tr("needs login"));
  }
  const ed = R.intent === "edit"; // picking a map for the editor: Editor becomes the main button
  $("dEdit").className = "btn " + (ed ? "main" : "ghost"); $("dGo").className = "btn " + (ed ? "ghost" : "main");
  $("dfoot").classList.toggle("edfirst", ed);
  const list = $("dList"); list.innerHTML = "";
  if (!info.diffs.length) { list.innerHTML = `<div class="dempty">${esc(tr("The mirror didn't send the difficulty list; you can pick one after the map loads"))}</div>`; $("dGo").textContent = tr("Load map"); $("dGo").title = ""; }
  else list.append(diffTable(info));
  $("dCount").textContent = info.diffs.length > 1 ? String(info.diffs.length) : ""; // (a quiet number after the heading; no new wording)
  dRailBuild(info);
  if (info.diffs.length) {
    let i = info.diffs.length - 1;
    if (bid) { const j = info.diffs.findIndex(d => String(d.bid) === String(bid)); if (j >= 0) i = j; }
    pickDiff(i, true);
  }
  if (wasShut) detailFrom = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("cmain") ? true : false; // (keyboard: the card comes back into focus when the panel closes)
  if (!again) dCoverFx(info, from);
  const fly = wasShut && from && from.isConnected && dWide() ? from : null; // (a wide screen: the panel grows out of the card)
  if (wasShut) { d.classList.toggle("fly", !!fly); d.classList.toggle("dlate", !!from && !RM); } // (fly: no CSS float-in; dlate: the content comes in once the window has opened)
  d.classList.remove("out"); d.hidden = false;
  $("dBody").scrollTop = 0; $("dPanel").classList.remove("dscr"); dTouched = false; dReveal(); dRailCenter(true);
  $("dCover").querySelector(".dhead").classList.remove("xp"); $("dTitle").removeAttribute("aria-expanded");
  if (fly) { if (dFlyOpen(fly)) dSrcSet(info.sid); else d.classList.remove("fly"); } // (the card can't be seen: the plain float-in)
  else if (wasShut && from && !RM && innerWidth <= 700) { const im = from.querySelector(".bc-img"); if (im && im.animate) im.animate({ filter: ["brightness(1)", "brightness(1.4)", "brightness(1)"] }, { duration: 320, easing: "ease-out" }); } // (phones: the sheet slides up, the card lights up under it)
  if (wasShut) detailGuard = dFlight ? D_OPEN : 350;
  $("dGo").focus({ preventScroll: true });
}
// ---------- the picked difficulty in view: when the panel opens (the hardest one is picked, which is far down a long list) the list scrolls to it ----------
// Only the panel's own scrollers move (the list on a wide screen, the sheet otherwise), never the page, and by the rects of the row and its strip
// (divided by the panel's scale while it is still floating in), so the grow-out-of-the-card move, which measures the panel's own box, is untouched. It runs
// as the panel opens, and once more when osu!'s set information has arrived (on phones that is above the list and moves it), unless the reader has scrolled meanwhile.
let dTouched = false;
$("dBody").addEventListener("scroll", () => $("dPanel").classList.toggle("dscr", $("dBody").scrollTop > 2), { passive: true }); // (the grab handle gets its solid strip while the sheet is scrolled)
for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) $("dPanel").addEventListener(ev, () => { dTouched = true; }, { capture: true, passive: true });
function dReveal() {
  const row = $("dList").querySelector(".drow.on"); if (dTouched || $("detail").hidden || !row || innerWidth <= 700) return; // (phones: the sheet opens at the top, where the set information is)
  let sc = null; for (let e = row.parentElement; e && e.id !== "dPanel"; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight + 1) { sc = e; break; } }
  if (!sc) return;
  const sr = sc.getBoundingClientRect(), k = sc.offsetHeight ? sr.height / sc.offsetHeight : 1, th = $("dList").querySelector(".dtab th"); // (k: the panel's scale while it floats in)
  const topInset = innerWidth <= 700 ? 52 : th && getComputedStyle(th).position === "sticky" ? th.offsetHeight : 0; // (the band under the grab handle and the close button on phones / the sticky header; layout px, like the margins below)
  const visTop = sr.top + (topInset + 4) * k, visBot = sr.bottom - 8 * k, rr = row.getBoundingClientRect(), st = $("dStrip"), tr = st && st.offsetParent ? st.getBoundingClientRect() : null;
  const bot = Math.max(rr.bottom, tr ? tr.bottom : 0);
  const dy = rr.top < visTop ? rr.top - visTop : bot > visBot ? Math.min(bot - visBot, rr.top - visTop) : 0; // (down: as far as the strip needs, but the row itself stays in view)
  if (Math.abs(dy) > 1 && k > 0) sc.scrollTop += dy / k;
}
// pickDiff:start
let dPkT = 0;
function pickDiff(i, silent, fromRail) { // fromRail: picked from the pills at the top of the sheet (phones): the sheet stays where it is
  if (!silent && detailPick && detailPick === detailInfo.diffs[i]) return; // (the picked row clicked again: nothing changes; rebuilding its strip made it fold and open again, a blink)
  detailPick = detailInfo.diffs[i];
  const rows = [...$("dList").querySelectorAll(".drow")];
  // (.dpk while the strips fold/open: the highlight moves in one frame, not in fades of different lengths, and the rows that slide under a still pointer don't light up)
  if (!silent && !RM) { const l = $("dList"); l.classList.add("dpk"); clearTimeout(dPkT); dPkT = setTimeout(() => l.classList.remove("dpk"), 280); }
  rows.forEach((r, j) => { r.classList.toggle("on", j === i); r.setAttribute("aria-current", j === i ? "true" : "false"); });
  dStripTo(rows, i, silent, fromRail);
  dRailPick(i, silent);
  // a long difficulty name ends in "…" (the whole name is in the list above and in the tooltip); a flex button can't ellipsize its own text
  // (the picked difficulty's star chip stands before the label: the row you picked and the button you press are visibly the same thing; the chip is decoration, the label says it all)
  const go = $("dGo"), goT = tr("Preview: {d}", { d: detailPick.name }), gc = starEl(detailPick, i, "gostar"); gc.removeAttribute("title"); gc.setAttribute("aria-hidden", "true");
  go.replaceChildren(gc, h("span", "btxt", goT)); go.title = goT;
  // (#dStats stays hidden: every figure of the picked difficulty is in its row of the table or in the strip under it)
  if (detailInfo.osuLink) detailInfo.osuLink.href = osuSetURL(detailInfo.sid, detailPick.bid);
  if (!silent) { if (rows[i] && !fromRail) rows[i].scrollIntoView({ block: "nearest", behavior: RM ? "auto" : "smooth" }); if (detailInfo.sid && R.inMap) setMapURL(detailInfo.sid, detailPick.bid, false); }
}
// pickDiff:end
// ---------- the difficulty table: one row per difficulty with the figures that matter at a glance; the rest is in the strip under the picked row ----------
const dNum = v => v != null && v !== "" && isFinite(+v), dPos = v => dNum(v) && +v > 0;
// a column only when some difficulty has the figure (older cached sets / local files: no counts, no BPM -> those columns just aren't there)
const D_COLS = [
  { k: "cs", head: () => "CS", get: d => d.cs, fmt: fmtNum, ok: dNum },
  { k: "ar", head: () => "AR", get: d => d.ar, fmt: fmtNum, ok: dNum },
  { k: "od", head: () => "OD", get: d => d.od, fmt: fmtNum, ok: dNum },
  { k: "hp", head: () => "HP", get: d => d.hp, fmt: fmtNum, ok: dNum },
  { k: "bpm", head: () => "BPM", get: (d, i) => d.bpm || i.bpm, fmt: v => String(Math.round(v)), ok: dPos },
  { k: "len", head: () => tr("Length"), get: d => d.len, fmt: v => fmt(v), ok: dPos },
];
// the strip: labelled bars for the four settings, and the figures that don't fit a row (each only when the difficulty has it)
const D_BARS = [
  { k: "cs", head: "CS", name: () => tr("Circle Size"), get: d => d.cs },
  { k: "ar", head: "AR", name: () => tr("Approach Rate"), get: d => d.ar },
  { k: "od", head: "OD", name: () => tr("Overall Difficulty"), get: d => d.od },
  { k: "hp", head: "HP", name: () => tr("HP Drain Rate"), get: d => d.hp },
];
function dStripBuild(d, info, n) {
  const bars = h("div", "dsbars"), objs = h("dl", "dsobj");
  for (const c of D_BARS) {
    const v = c.get(d); if (!dNum(v)) continue;
    const e = h("div", "dsb"); e.title = c.name(); e.append(h("span", "dsl", c.head), h("b", null, fmtNum(v)));
    const bar = h("i"); bar.style.setProperty("--p", Math.max(0, Math.min(1, +v / 10))); e.append(bar); bars.append(e);
  }
  const o = (label, val) => { const r = h("div"); r.append(h("dt", null, label), h("dd", null, val)); objs.append(r); return r; };
  if (dNum(d.circles)) o(tr("Circles"), fmtInt(d.circles));
  if (dNum(d.sliders)) o(tr("Sliders"), fmtInt(d.sliders));
  if (dNum(d.spinners)) o(tr("Spinners"), fmtInt(d.spinners));
  if (dPos(d.combo)) o(tr("Max combo"), fmtInt(d.combo) + "x");
  if (dPos(d.drain)) o(tr("Drain time"), fmt(d.drain));
  if (info.sid && d.bid != null && /^\d+$/.test(String(d.bid))) { // the difficulty's own page on osu!
    const a = h("a", "dsid", "#" + d.bid); a.href = osuSetURL(info.sid, d.bid); a.target = "_blank"; a.rel = "noopener"; a.title = tr("Map page on osu.ppy.sh");
    const r = o(tr("Beatmap ID"), ""); r.classList.add("dsidr"); r.lastChild.append(a);
  }
  if (!bars.children.length && !objs.children.length) return null;
  const tr_ = h("tr", "dstrip"), td = h("td"), w = h("div", "dsw"), in_ = h("div", "dsin"), c = h("div", "dsc");
  tr_.id = "dStrip"; td.colSpan = n;
  if (bars.children.length) c.append(bars);
  if (objs.children.length) c.append(objs);
  in_.append(c); w.append(in_); td.append(w); tr_.append(td); return tr_;
}
// the strip moves to the picked row: the old one folds up, the new one opens (reduced motion: at once)
function dStripTo(rows, i, silent, still) { // still: don't scroll the sheet to the new strip (picked from the pills)
  const list = $("dList"), tb = list.querySelector(".dtab");
  for (const r of rows) { const b = r.querySelector(".dn"); if (b) { b.setAttribute("aria-expanded", "false"); b.removeAttribute("aria-controls"); } }
  // (a folding strip has no frame, fill or figures, see css: only its height closes, so nothing is left behind under the row that was picked; it goes when that
  // height has reached 0, which changes nothing on screen; a second pick while one is still folding: both go)
  for (const old of list.querySelectorAll(".dstrip")) {
    old.removeAttribute("id"); old.classList.remove("open", "first");
    const w = old.querySelector(".dsw");
    if (RM || silent || !w || !old.offsetParent) { old.remove(); continue; }
    w.addEventListener("transitionend", e => { if (e.target === w && e.propertyName === "grid-template-rows") old.remove(); });
    setTimeout(() => old.remove(), 400);
  }
  if (!tb || !rows[i]) return;
  const s = dStripBuild(detailInfo.diffs[i], detailInfo, tb._n); if (!s) return;
  s.style.setProperty("--i", Math.min(i, 16)); if (silent) s.classList.add("first");
  rows[i].after(s);
  const b = rows[i].querySelector(".dn"); if (b) { b.setAttribute("aria-expanded", "true"); b.setAttribute("aria-controls", "dStrip"); }
  if (silent || RM) s.classList.add("open");
  else { void s.offsetHeight; s.classList.add("open"); if (!still) setTimeout(() => { if (s.isConnected && s.classList.contains("open")) s.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 230); }
}
// the star chip of a difficulty (a row, a pill, the footer button): its colours by the rating, "#n" when there is none
function starEl(d, i, cls) {
  const st = h("span", "star" + (cls ? " " + cls : ""), d.stars != null && d.stars !== "" ? `${d.est ? "≈" : ""}★ ${(+d.stars).toFixed(2)}` : `#${i + 1}`);
  if (d.est) st.title = tr("Estimated star rating (this difficulty isn't on osu!)");
  const c = starChip(d.stars); st.style.background = c.bg; st.style.color = c.fg;
  return st;
}
// ---------- phones: a rail of pills (star chip + short name) right under Listen / Share / Download, so the choice is the first thing under the actions ----------
// The pills are the same choice as the table rows (pickDiff). A pill is a button (Tab, Enter / Space); the picked one is centred in the rail, the rail's edges fade while it
// can scroll that way; one difficulty (a local file): no rail. The sheet's swipe-down logic leaves a sideways drag alone, so a drag on the rail only scrolls it.
function dRailBuild(info) {
  const rail = $("dRail"); rail.replaceChildren(); rail.classList.remove("fl", "fr");
  rail.hidden = info.diffs.length < 2;
  if (rail.hidden) return;
  info.diffs.forEach((d, i) => {
    const b = h("button", "dpill"); b.type = "button"; b.dataset.i = i;
    const nm = h("span", "pname", d.name || "?");
    b.append(starEl(d, i), nm);
    b.title = (d.name || "?") + (d.guest ? " " + tr("by {n}", { n: d.guest }) : "");
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => { if (detailPick !== d) pickDiff(i, false, true); };
    rail.append(b);
  });
}
function dRailFade() {
  const r = $("dRail"); if (r.hidden) return;
  r.classList.toggle("fl", r.scrollLeft > 4); r.classList.toggle("fr", r.scrollLeft + r.clientWidth < r.scrollWidth - 4);
}
// the picked pill into the middle of the rail (by the rail's own scroll only, never the sheet's); now: at once (the sheet has just opened)
function dRailCenter(now) {
  const rail = $("dRail"), on = rail.querySelector(".dpill.on");
  if (rail.hidden || !on || !rail.offsetParent) { dRailFade(); return; }
  const to = Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, on.offsetLeft + on.offsetWidth / 2 - rail.clientWidth / 2));
  if (now || RM) { rail.scrollLeft = to; dRailFade(); } else rail.scrollTo({ left: to, behavior: "smooth" });
}
function dRailPick(i, silent) {
  const rail = $("dRail"); if (rail.hidden) return;
  rail.querySelectorAll(".dpill").forEach((p, j) => { const on = j === i; p.classList.toggle("on", on); p.setAttribute("aria-pressed", String(on)); if (on) p.setAttribute("aria-current", "true"); else p.removeAttribute("aria-current"); });
  dRailCenter(!!silent);
}
$("dRail").addEventListener("scroll", dRailFade, { passive: true });
try { const mq = matchMedia("(max-width:700px)"), f = () => dRailCenter(true); if (mq.addEventListener) mq.addEventListener("change", f); else if (mq.addListener) mq.addListener(f); } catch {} // (resized across the phone width: the rail has just been laid out)
function diffTable(info) {
  const cols = D_COLS.filter(c => info.diffs.some(d => c.ok(c.get(d, info))));
  const tb = h("table", "dtab"), cell = (cls, txt) => h("td", cls, txt);
  tb._n = 2 + cols.length;
  tb.setAttribute("aria-label", tr("Choose a difficulty"));
  const hr = h("tr"); hr.append(h("th", "c-star", "★"), h("th", "c-name", tr("Difficulty")));
  for (const c of cols) hr.append(h("th", "c-n c-" + c.k, c.head()));
  tb.append(h("thead", "dth")); tb.firstChild.append(hr);
  const body = h("tbody");
  info.diffs.forEach((d, i) => {
    const r = h("tr", "drow"); r.style.setProperty("--i", Math.min(i, 16));
    const sc = cell("c-star"), rad = h("i", "rad"); rad.setAttribute("aria-hidden", "true"); // (the radio mark: an empty ring, filled and ticked on the picked row; the row's own state is aria-current)
    sc.append(rad, starEl(d, i));
    const nc = cell("c-name"), nb = h("button", "dn"); nb.type = "button";
    nb.append(h("b", null, d.name || "?")); if (d.guest) nb.append(h("small", null, tr("by {n}", { n: d.guest })));
    nb.title = d.name + (d.guest ? " " + tr("by {n}", { n: d.guest }) : "");
    nc.append(nb); r.append(sc, nc);
    for (const c of cols) {
      const v = c.get(d, info), ok = c.ok(v), td = cell("c-n c-" + c.k + (ok ? "" : " none"));
      td.dataset.k = c.head(); // (the label of the figure on a phone, where there are no column headers)
      td.append(h("b", null, ok ? c.fmt(v) : "–"));
      r.append(td);
    }
    (r.lastElementChild || nc).classList.add("c-last"); // (the last cell the wide table shows: it closes the row's outline; the phone-only cells come after it and are hidden there)
    // phones: line 1 is star + name + "3:10 · 180 BPM" (the figures of those two columns), line 2 CS AR OD HP
    const mob = [d.len > 0 ? fmt(d.len) : "", (d.bpm || info.bpm) > 0 ? Math.round(d.bpm || info.bpm) + " BPM" : ""].filter(Boolean).join(" · ");
    if (mob) r.append(cell("c-mob", mob));
    if (d.guest) { const g = cell("c-guest", tr("by {n}", { n: d.guest })); g.setAttribute("aria-hidden", "true"); r.append(g); } // (narrow table only: the guest's credit on line 2, see css)
    r.addEventListener("click", () => pickDiff(i));
    r.addEventListener("dblclick", () => { pickDiff(i); $("dGo").click(); });
    body.append(r);
  });
  tb.append(body);
  return tb;
}
// ---------- motion: on a wide screen the panel opens out of the card that was clicked and closes back into it ----------
// A shared-element move with the Web Animations API. The panel is only MOVED, never scaled (its text and pictures keep their size), and a
// window clipped out of it starts exactly on the card and opens to the whole panel. The card's picture is a layer of its own (.dshr): its
// box goes from the card's cover to the panel's cover, and the picture in it is drawn at one scale for both axes as the crop that box
// shows (never stretched, the crop widens or narrows smoothly). It ends drawn exactly as the panel's cover is, so the hand-over when it
// lands changes no pixel. A copy of the card (its text, tag and buttons; not its picture) sits on top and fades as the window opens; the
// backdrop dims with it. Phones keep the bottom sheet; reduced motion: none of it. Every way out goes through dFlyStop (and hideDetail),
// which leaves no animation, copy, class or inline style behind.
// flipGeo:start
// the start of the move: the panel (p: its rect at rest) moved by (tx, ty), and the window cut out of it (ins: top right bottom left, in
// px, corners r) lies exactly on the card (c), anchored at the panel's top-left (its cover). No scale (a card larger than the panel, which
// a wide screen never has, gets a window the panel's size)
function flipGeo(c, p, rc) {
  const w = Math.min(c.width, p.width), hh = Math.min(c.height, p.height);
  return { tx: c.left - p.left, ty: c.top - p.top, w, h: hh, ins: [0, p.width - w, p.height - hh, 0], r: rc || 0 };
}
// the size a picture of shape `ac` (width / height) is drawn at in a box (w x hh) to show what a picture of shape `at` shows there as a
// 'cover' crop. osu!'s card (400x140) and cover (1800x500) are both full-width centre crops of the same background, so the width the
// picture spans is the same, max(w, hh * at), and its height follows its own shape: one scale for both axes, never stretched.
// at = ac: that picture's own 'cover' crop
function picDraw(w, hh, at, ac) { const dw = Math.max(w, hh * at); return [dw, dw / ac]; }
// flipGeo:end
const D_OPEN = 480, D_CLOSE = 320, D_EASE = "cubic-bezier(.2,.7,.2,1)", D_EASE_C = "cubic-bezier(.4,0,.2,1)", D_LEAD = 60; // (D_LEAD: the picture is in place a little before the window: it leads, the window follows)
const D_OUT = "inset(-70px -110px -130px -110px round 6px)"; // (the open window: past the panel's edges, its shadow shows as it lands, nothing pops when the clip goes)
const D_COV = 1800 / 500, D_CARD = 400 / 140; // (the shapes of osu!'s cover@2x and card / card@2x, until the pictures themselves say)
const dT = g => `translate(${g.tx}px,${g.ty}px)`, dClip = g => `inset(${g.ins.map(v => v + "px").join(" ")} round ${g.r}px)`;
let dSrc = null, dFlight = null, dGen = 0; // dSrc: the set whose card the panel stands in for (hidden meanwhile); dFlight: the move playing; dGen: a close in progress is stale once this has moved on
const dWide = () => innerWidth > 700 && !RM && !!document.body.animate;
const dCardOf = sid => sid == null ? null : [...document.querySelectorAll("#results .card")].find(c => String(c.sid) === String(sid)) || null; // (looked up now: a language change rebuilds the cards)
function dSrcSet(sid) { dSrc = sid == null ? null : String(sid); document.querySelectorAll("#results .card").forEach(c => c.classList.toggle("dsrc", dSrc != null && String(c.sid) === dSrc)); }
// a card the panel can fly to/from: in the page, and at least half of it on the screen below the sticky search bar
function dCardRect(c) {
  if (!c || !c.isConnected || !c.offsetParent) return null;
  const r = c.getBoundingClientRect(), sb = document.querySelector(".searchbar"), top = Math.max(0, sb && sb.offsetParent ? sb.getBoundingClientRect().bottom : 0);
  return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && Math.min(r.bottom, innerHeight) - Math.max(r.top, top) >= r.height / 2 ? r : null;
}
// the card's picture: its url, its shape once it is in the cache (else the default), and its layers (the sharper card@2x on top when it is
// already in the cache: the same crop, so nothing moves if it shows; the card's own picture under it)
const dBgUrl = el => { const m = el && /url\(["']?([^"')]+)["']?\)/.exec(el.style.backgroundImage || ""); return m ? m[1] : ""; };
function dPicShape(u, dflt) { if (!u) return dflt; const im = new Image(); im.src = u; return im.complete && im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : dflt; }
const dPicLayers = (src, hi) => hi && hi !== src && dPicShape(hi, 0) ? [hi, src] : [src];
const dBgImg = L => L.map(u => `url("${u}")`).join(", "), dBgSize = (L, w, hh) => L.map(() => `${w}px ${hh}px`).join(", ");
// the copy of the card the panel starts as (and ends as, closing): inside the panel, so it moves and is clipped with it. pic: the picture
// flies on its own layer (dShared), the copy shows only the card's text, tag and buttons over it
function dGhost(card, r, pic) {
  const k = card.cloneNode(true), pn = $("dPanel"), w = card.offsetWidth || r.width, hh = card.offsetHeight || r.height;
  // the card as it looks this instant (hovered: lifted, the download button out; pressed: a little smaller): the moved/scaled parts are
  // copied over, and the copy is laid out at the card's own size, then scaled onto what is seen (r)
  const src = [card, ...card.querySelectorAll("*")], dst = [k, ...k.querySelectorAll("*")];
  src.forEach((el, i) => { const cs = getComputedStyle(el), t = dst[i]; if (t && i) { t.style.transform = cs.transform; t.style.opacity = cs.opacity; } });
  k.classList.remove("sel", "dsrc", "playing"); k.classList.add("dghost"); if (pic) k.classList.add("dgp"); k.setAttribute("aria-hidden", "true"); k.inert = true;
  Object.assign(k.style, { left: -pn.clientLeft + "px", top: -pn.clientTop + "px", width: w + "px", height: hh + "px", borderColor: getComputedStyle(card).borderColor, opacity: "", transform: `scale(${r.width / w})` });
  pn.append(k); return k;
}
// the card's picture, flying: one layer in the panel (it moves with it), its box from the card's cover (a) to the panel's cover (b), the
// picture in it drawn as each box's crop: a, the card's own (its hover zoom included); b, the panel cover's (picDraw). r: the card, p:
// the panel at rest. null: nothing to fly (the card's picture isn't there yet, no cover): the window opens over the panel's own cover
function dShared(card, r, p) {
  const im = card.querySelector(".bc-img"), cov = card.querySelector(".bc-cov"), info = detailInfo, pn = $("dPanel"), cv = $("dCover"), src = dBgUrl(im);
  if (!src || !cov || !info || !info.cover || !cv.offsetParent) return null;
  const cr = cov.getBoundingClientRect(), vr = cv.getBoundingClientRect(), bl = pn.clientLeft, bt = pn.clientTop;
  if (!cr.width || !cr.height || !vr.width || !vr.height) return null;
  // the layer shows the panel's own cover (cover@2x, preloaded when the card was pointed at) cropped exactly as the box shows it (CSS
  // 'cover' at every size, so it never stretches and lands identical to the box: nothing zooms after it opens); the card's own picture
  // lies on top of it near the card (.dshc) and fades as it leaves the card / comes back as it lands on it. Cover not loaded yet: the
  // card's picture all the way, the same 'cover' crop the box then shows until the cover arrives
  const covOk = dPicShape(info.cover, 0) > 0, L = covOk ? [info.cover] : dPicLayers(src, info.fallbackCover);
  const rc = parseFloat(getComputedStyle(cov).borderTopLeftRadius) || 0;
  const box = (x, y, w, hh, rad) => ({ left: x + "px", top: y + "px", width: w + "px", height: hh + "px", borderRadius: `${rad}px ${rad}px 0px 0px` });
  // (the panel's own px: at the start it stands with its top-left on the card's; at the end where it rests)
  const a = box(cr.left - r.left - bl, cr.top - r.top - bt, cr.width, cr.height, rc), b = box(vr.left - p.left - bl, vr.top - p.top - bt, vr.width, vr.height, 0);
  const el = h("i", "dshr"), sh = h("i", "dshade"); el.setAttribute("aria-hidden", "true");
  let cp = null; if (covOk) { cp = h("i", "dshc"); cp.style.backgroundImage = dBgImg(dPicLayers(src, info.fallbackCover)); el.append(cp); }
  el.append(sh); el.style.backgroundImage = dBgImg(L); Object.assign(el.style, b);
  pn.append(el); $("detail").classList.add("dpicfly"); // (.dpicfly: the panel's own cover picture steps aside meanwhile, its title stays above the flying one)
  return { el, sh, cp, a, b };
}
let dSettle = null; // the panel growing to its new height after it landed (set information that arrived meanwhile)
function dFlyStop() { // the move ends at once: the panel as it is at rest (whether it stays open is the caller's business)
  const f = dFlight; dFlight = null;
  if (dSettle) { try { dSettle.cancel(); } catch {} dSettle = null; }
  if (f) { clearTimeout(f.timer); for (const a of f.anims) try { a.cancel(); } catch {} if (f.ghost) f.ghost.remove(); if (f.pic) f.pic.el.remove(); }
  $("detail").classList.remove("flyout", "dpicfly"); $("dPanel").style.height = "";
}
function dLand(f) { // a move has played out (or its time is up)
  if (dFlight !== f) return;
  if (f.mode === "close" && f.done && !f.handed) { // closing back into the card: the card is shown UNDER the flying layers first and they stay for two frames (its picture is decoded and painted again by then), so the card is never caught half painted
    f.handed = true; dSrcSet(null);
    const card = dCardOf(detailInfo && detailInfo.sid), u = dBgUrl(card && card.querySelector(".bc-img")), im = u ? new Image() : null; if (im) im.src = u;
    const go = () => requestAnimationFrame(() => requestAnimationFrame(() => dLand(f)));
    (im && im.decode ? Promise.race([im.decode().catch(() => {}), new Promise(r => setTimeout(r, 150))]) : Promise.resolve()).then(go);
    return;
  }
  const pn = $("dPanel"), held = parseFloat(pn.style.height) || 0, done = f.mode === "close" && f.done; dFlyStop(); if (done) return done();
  dFxGone(); // (the card's picture is now on the cover, drawn exactly as the flying one ended; the cover itself fades in over it once it is there)
  // its height was held while it flew (the set information comes in meanwhile, 0.1-0.4 s after the click): it now grows (or
  // shrinks) to fit what arrived, smoothly, instead of jumping right after it landed
  const now = pn.offsetHeight;
  if (held && Math.abs(now - held) > 1 && !RM) { const a = dSettle = pn.animate([{ height: held + "px" }, { height: now + "px" }], { duration: 240, easing: D_EASE }); a.onfinish = () => { if (dSettle === a) dSettle = null; }; }
}
function dFly(f, ms) { dFlight = f; if (f.main.finished) f.main.finished.then(() => dLand(f), () => {}); f.timer = setTimeout(() => dLand(f), ms + 250); } // (the timer: a tab in the background runs no animation frames)
// the panel has just been shown (with .fly): it opens out of the card
function dFlyOpen(card) {
  const r = dCardRect(card), d = $("detail"), pn = $("dPanel"); if (!r) return false;
  const p = pn.getBoundingClientRect(); if (!p.width || !p.height) return false;
  pn.style.height = p.height + "px"; // (held while it flies: its height follows the content, and the set information can still arrive meanwhile; dLand lets it go smoothly)
  const g = flipGeo(r, p, parseFloat(getComputedStyle(card).borderTopLeftRadius)), pic = dShared(card, r, p), ghost = dGhost(card, r, !!pic);
  const main = pn.animate([{ transform: dT(g), clipPath: dClip(g) }, { transform: "translate(0px,0px)", clipPath: D_OUT }], { duration: D_OPEN, easing: D_EASE, fill: "forwards" });
  const anims = [main,
    ghost.animate([{ opacity: 1 }, { opacity: 1, offset: .04 }, { opacity: 0, offset: pic ? .26 : .42 }, { opacity: 0 }], { duration: D_OPEN, fill: "forwards" }), // (with the picture apart: the card's words go in the first ~120 ms)
    d.animate({ backgroundColor: ["rgba(10,12,20,0)", getComputedStyle(d).backgroundColor] }, { duration: 300, easing: "ease-out", fill: "forwards" })];
  if (pic) { const o = { duration: D_OPEN - D_LEAD, easing: D_EASE, fill: "forwards" }; anims.push(pic.el.animate([pic.a, pic.b], o), pic.sh.animate([{ opacity: 0 }, { opacity: 1 }], o)); if (pic.cp) anims.push(pic.cp.animate([{ opacity: 1 }, { opacity: 0, offset: .35 }, { opacity: 0 }], { duration: D_OPEN - D_LEAD, fill: "forwards" })); }
  dFly({ mode: "open", main, ghost, pic, anims }, D_OPEN);
  return true;
}
// the panel's content that fades as it closes: each part on its own (a fade on #dBody would put the cover's title under the flying picture)
const D_PARTS = ".dchips,.dhead,.dhave,.dacts,.drail,.dlabel,.dmeta,.dvol,.dstats,.dlist";
// closing on a wide screen: back into the card (true), or false when it can't (the caller closes its own way)
function dFlyBack(done) {
  const f = dFlight, d = $("detail"), pn = $("dPanel");
  if (f && f.mode === "open") { // still opening: the same move plays back from where it is
    f.mode = "close"; f.done = done; d.classList.add("flyout"); clearTimeout(f.timer);
    for (const a of f.anims) try { a.reverse(); } catch {}
    f.timer = setTimeout(() => dLand(f), D_OPEN + 250); return true;
  }
  if (f || !dWide()) return false;
  const card = dCardOf(detailInfo && detailInfo.sid), r = dCardRect(card); if (!r) return false;
  if (dSettle) { try { dSettle.cancel(); } catch {} dSettle = null; } // (still growing to fit: its final size, then measured)
  const p = pn.getBoundingClientRect(); if (!p.width || !p.height) return false;
  pn.style.height = p.height + "px"; // (held while it shrinks: set information arriving now must not move it)
  d.classList.add("fly", "flyout"); // (no CSS motion; nothing under the pointer while it shrinks: a click lands on the page)
  const g = flipGeo(r, p, parseFloat(getComputedStyle(card).borderTopLeftRadius)), pic = dShared(card, r, p), ghost = dGhost(card, r, !!pic), o = { duration: D_CLOSE, easing: D_EASE_C, fill: "forwards" };
  const main = pn.animate([{ transform: "translate(0px,0px)", clipPath: D_OUT }, { transform: dT(g), clipPath: dClip(g) }], o);
  const fade = [{ opacity: 1 }, { opacity: 0 }], fo = { duration: D_CLOSE * .4, easing: "ease-in", fill: "forwards" };
  const anims = [main,
    ghost.animate([{ opacity: 0 }, { opacity: 0, offset: .25 }, { opacity: 1, offset: .7 }, { opacity: 1 }], { duration: D_CLOSE, fill: "forwards" }),
    d.animate({ backgroundColor: [getComputedStyle(d).backgroundColor, "rgba(10,12,20,0)"] }, { duration: D_CLOSE, easing: "ease-in", fill: "forwards" }),
    ...(pic ? [...$("dBody").querySelectorAll(D_PARTS)] : [$("dBody")]).map(e => e.animate(fade, fo)), $("dfoot").animate(fade, fo)];
  if (pic) { anims.push(pic.el.animate([pic.b, pic.a], o), pic.sh.animate([{ opacity: 1 }, { opacity: 0 }], o)); if (pic.cp) anims.push(pic.cp.animate([{ opacity: 0 }, { opacity: 0, offset: .65 }, { opacity: 1 }], { duration: D_CLOSE, fill: "forwards" })); }
  dFly({ mode: "close", done, main, ghost, pic, anims }, D_CLOSE);
  return true;
}
// the cover: the card's picture (already loaded) until the panel's own cover has arrived, then that fades in over it. The card's picture is
// drawn as the cover's crop (picDraw), not as its own: the two are the same picture at the same place and scale, so the fade only
// sharpens it (no zoom, no jump), and the flying picture lands on it pixel for pixel
let dFx = null; // { info, L (the card picture's layers), ac (its shape), at (the cover's), ok (the cover has arrived) }
function dFxFit() {
  const cv = $("dCover"), fx = cv.querySelector(".dcovfx"); if (!fx || fx.hidden || !dFx) return;
  fx.style.backgroundSize = "cover"; // (the same crop the box gives the cover)
}
if (window.ResizeObserver) new ResizeObserver(() => dFxFit()).observe($("dCover")); // (the window resized, the title opened: the cover's box changed)
function dFxGone() { // the cover has arrived and nothing is flying: the card's picture fades away
  const fx = $("dCover").querySelector(".dcovfx"), f = dFx; if (!fx || fx.hidden || !f || !f.ok || dFlight || f.fading) return;
  if (RM || !fx.animate) { fx.hidden = true; return; }
  f.fading = true; const a = fx.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: "ease-out", fill: "forwards" });
  const end = () => { if (dFx === f) fx.hidden = true; a.cancel(); };
  if (a.finished) a.finished.then(end, () => {}); else setTimeout(end, 260);
}
function dCoverFx(info, from) {
  const cv = $("dCover"); let fx = cv.querySelector(".dcovfx");
  if (!fx) { fx = h("i", "dcovfx"); fx.setAttribute("aria-hidden", "true"); cv.prepend(fx); }
  for (const a of fx.getAnimations ? fx.getAnimations() : []) a.cancel();
  const src = dBgUrl(from && from.querySelector(".bc-img"));
  dFx = null; fx.hidden = true; fx.style.backgroundImage = "";
  if (!src || !info.cover || dPicShape(info.cover, 0)) return; // (the cover is already loaded: it shows itself, no stand-in to fade away later)
  const f = dFx = { info, L: dPicLayers(src, info.fallbackCover), ac: dPicShape(src, D_CARD), at: dPicShape(info.cover, D_COV), ok: false };
  fx.style.backgroundImage = dBgImg(f.L); fx.hidden = false; dFxFit();
  const im = new Image(), got = () => { if (dFx !== f || !im.naturalWidth) return; f.ok = true; dFxGone(); };
  im.onload = () => (im.decode ? im.decode() : Promise.resolve()).then(got, got); // (failed: the card's picture stays, drawn as the cover would be)
  im.src = info.cover;
}
// anim: the Back button (route): back into the card when it can, else at once. Everyone else hides it at once (something else takes over)
function hideDetail(anim) {
  const d = $("detail");
  if (anim === true && !d.hidden && !d.classList.contains("out") && !(dFlight && dFlight.mode === "close")) { const gen = ++dGen; if (dFlyBack(() => { if (gen === dGen) hideDetail(); })) return; }
  dGen++; dFlyStop(); d.classList.remove("fly", "dlate");
  if (!d.hidden) d.hidden = true; d.classList.remove("out"); $("dPanel").style.transform = ""; if (pvOwner === "detail") pausePreview(); document.querySelectorAll("#results .card.sel").forEach(c => c.classList.remove("sel")); dSrcSet(null);
}
// closing by hand: back into the card (wide screens), else the panel sinks away first (.out), then hides
function closeDetail() {
  const d = $("detail"), gen = ++dGen, done = () => {
    if (gen !== dGen) return; // (opened again, or hidden another way, meanwhile)
    const sid = detailInfo && detailInfo.sid, back = detailFrom; hideDetail(); if (detailInfo && detailInfo.sid && UI.player.hidden) leaveMap();
    // keyboard users land on the card they opened (looked up now: the cards are rebuilt on a language change; nothing when the list has moved on)
    if (back && sid && UI.player.hidden) { const c = [...document.querySelectorAll("#results .card")].find(x => String(x.sid) === String(sid)), m = c && c.querySelector(".cmain"); if (m && m.offsetParent) try { m.focus({ preventScroll: true }); } catch {} }
  };
  if (d.hidden || d.classList.contains("out") || RM || (dFlight && dFlight.mode === "close")) return done(); // (asked again while closing: at once)
  if (dFlyBack(done)) return;
  d.classList.remove("fly"); d.classList.add("out"); setTimeout(done, 170);
}
$("dClose").onclick = closeDetail;
// the page under the panel stays put while the panel is on screen (core.js pageLock), taken from the real state whichever way it was
// shown or hidden (showDetail, the re-shows after a cancelled / finished download, a declined prompt, Back from a picked file; hideDetail
// after the move back into the card has played out). The gate hides the panel by css: the page is free meanwhile. The live-session join
// prompt is the same kind of overlay
{
  const sync = () => { const g = document.body.classList.contains("gated"); pageLock("detail", !$("detail").hidden && !g); pageLock("liveJoin", !$("liveJoin").hidden && !g); };
  const mo = new MutationObserver(sync);
  for (const id of ["detail", "liveJoin"]) mo.observe($(id), { attributes: true, attributeFilter: ["hidden"] });
  mo.observe(document.body, { attributes: true, attributeFilter: ["class"] }); sync();
}
document.addEventListener("pointerdown", e => { const dd = $("dDl"); if (dd.open && !dd.contains(e.target)) dd.open = false; }); // (the Download menu is a popover: a press anywhere else folds it)
// Tab stays inside the panel while it is open (the same rule as modal() in core.js; the <details> menu's summary counts as a stop)
$("detail").addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  const f = [...$("dPanel").querySelectorAll("button,input,select,textarea,a[href],summary,[tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && !x.hidden && x.offsetParent !== null && !x.closest("details:not([open])>:not(summary)") && !x.closest(".dghost"));
  if (!f.length) return; const a = f[0], z = f[f.length - 1], at = document.activeElement;
  if (!$("dPanel").contains(at)) { e.preventDefault(); a.focus(); }
  else if (e.shiftKey && at === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && at === z) { e.preventDefault(); a.focus(); }
});
// the backdrop closes on its click, not on pointerdown: closing on the press let the click that follows (a touch's
// click comes after the finger lifts) land on the card under it once the panel was gone, opening that map instead.
// The press has to start on the backdrop too (dragging out of the panel, e.g. selecting text, doesn't close it)
let dDownBg = false;
$("detail").addEventListener("pointerdown", e => { dDownBg = e.target.id === "detail"; });
$("detail").addEventListener("click", e => { if (e.target.id === "detail" && dDownBg) closeDetail(); dDownBg = false; });
$("dRedl").onclick = async () => {
  const info = detailInfo, d = detailPick, go = detailOnGo; if (!info || !info.sid || !go) return;
  if (!(await ask(tr("Download {t} again?\n\nThe copy kept in this browser is replaced by the current version from the mirrors. Edits you haven't saved stay as a draft.", { t: info.title || "#" + info.sid }), { title: tr("Re-download"), ok: tr("Re-download") }))) return;
  hideDetail(); download(info.sid, d, R.intent === "edit" ? "mod" : "preview", { fresh: true });
};
const goDetail = mode => { const d = detailPick, go = detailOnGo; hideDetail(); go && go(d, mode); };
$("dGo").onclick = () => goDetail("preview");
$("dEdit").onclick = () => goDetail("mod");
// a second tap (the one that opened the sheet, repeated) lands on whatever is now under the finger, e.g. a tag that
// searches for maps and leaves this one: taps in the first 350 ms after the sheet opens are ignored
$("detail").addEventListener("click", e => { if (performance.now() - detailAt < detailGuard) { e.stopPropagation(); e.preventDefault(); } }, true); // (detailGuard: as long as the panel takes to grow out of its card)
$("dVol").append(volControl("masterVol")); // (Master only here)
// swipe the sheet down to close (phones): from the grab handle (always), from the cover and from the content when it is scrolled to the top
(() => {
  const pnl = $("dPanel"), body = $("dBody"); let y0 = null, dy = 0, cap = false;
  const start = e => { if (innerWidth > 700 || (body.scrollTop > 0 && e.currentTarget.id !== "dGrab") || e.target.closest("button,a")) return; y0 = e.clientY; dy = 0; cap = false; pnl.style.transition = "none"; };
  const move = e => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    if (!cap && dy > 8) { cap = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch {} }
    pnl.style.transform = `translateY(${dy}px)`;
  };
  const end = () => { if (y0 == null) return; y0 = null; pnl.style.transition = ""; if (dy > 110) closeDetail(); else pnl.style.transform = ""; }; // (closing slides on from where the finger let go)
  for (const el of [$("dGrab"), $("dCover")]) { el.addEventListener("pointerdown", start); el.addEventListener("pointermove", move); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end); }
  // the content: a pull down from scrollTop 0 closes the sheet the same way. The browser starts scrolling as soon as a finger moves, which ends pointer events, so
  // this uses touch events (non-passive: the first move decides; a pull down is taken over, anything else scrolls or drags as before). Not from the cover / handle
  // (their own handlers above), a slider, a field or the Download menu; a sideways move is left alone.
  let ty = null, tx = 0, on = false, dead = false;
  body.addEventListener("touchstart", e => {
    ty = null; if (innerWidth > 700 || body.scrollTop > 0 || e.touches.length !== 1 || e.target.closest("#dCover,#dGrab,input,select,textarea,.ddlmenu,summary")) return;
    ty = e.touches[0].clientY; tx = e.touches[0].clientX; on = dead = false; dy = 0;
  }, { passive: true });
  body.addEventListener("touchmove", e => {
    if (ty == null || dead) return;
    const y = e.touches[0].clientY - ty, x = e.touches[0].clientX - tx;
    if (!on) {
      if (body.scrollTop > 0 || y < -6 || (Math.abs(x) > 8 && Math.abs(x) > Math.abs(y))) { dead = true; return; }
      if (y <= 8) return;
      on = true; pnl.style.transition = "none";
    }
    if (e.cancelable) e.preventDefault();
    dy = Math.max(0, y); pnl.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const tend = () => { if (ty == null) return; ty = null; if (!on) return; on = false; pnl.style.transition = ""; if (dy > 110) closeDetail(); else pnl.style.transform = ""; };
  body.addEventListener("touchend", tend); body.addEventListener("touchcancel", tend);
})();
// the title and artist are cut to two lines / one line on the cover (the full text is the tooltip, which a finger can't read): a press on them opens the whole text, again folds it
$("dCover").querySelector(".dhead").addEventListener("click", e => {
  const hd = e.currentTarget, t = $("dTitle"), a = $("dArtist"), m = $("dMapper");
  if (e.target.closest("button,a")) return;
  const cut = t.scrollHeight > t.clientHeight + 1 || a.scrollWidth > a.clientWidth + 1 || m.scrollWidth > m.clientWidth + 1;
  if (!cut && !hd.classList.contains("xp")) return;
  t.setAttribute("aria-expanded", String(hd.classList.toggle("xp")));
});

// ============ download with mirror fallback ============
// Each mirror gets its own abort controller with a connect timeout and a stall timeout (no data for a while),
// so a mirror that hangs or breaks mid-download moves on to the next one instead of loading forever.
// A broken/partial .osz also counts as a failure. "Try the next mirror" skips the current one by hand.
let dlCtl = null, routeCtl = null, dlOne = null;
$("cancelLoad").onclick = () => { dlCtl && dlCtl.abort(); routeCtl && routeCtl.abort(); hideLoading(); if (UI.player.hidden && detailInfo && R.inMap) $("detail").hidden = false; };
$("nextMirror").onclick = () => { if (dlOne) { dlOne.skipped = true; dlOne.abort(); } };
const hideLoadingDl = () => { $("nextMirror").hidden = true; hideLoading(); };
// ---------- downloaded maps, kept in this browser ----------
// Every .osz from a mirror is kept in IndexedDB ("obv" → "osz"), so opening the map again needs no download. When osu!
// says the set was updated after the copy was kept, the user picks: the new version, or the copy they have. The least
// recently opened maps go first once the cache is over OSZ_MAX (Settings → General shows it and can clear it).
const OSZ_MAX = 500 * 1048576, OSZ_COUNT = 200;
// the sets kept here (id -> the record without its file), for the "Downloaded" marks on the cards and the detail panel: read once at the start, again soon after anything in the store changes
const OSZ_IDX = new Map(); let oszIdxTimer = 0;
async function oszIndexLoad(tries = 5) { // (right after a reload the database can still be busy closing in the page before: a failed read is tried again, not taken for "nothing kept")
  let all = null;
  for (let k = 0; k < tries && !all; k++) { try { all = (await idbTx("osz", "readonly", s => s.getAll())) || []; } catch { await new Promise(r => setTimeout(r, 400 * (k + 1))); } }
  if (!all) return;
  OSZ_IDX.clear();
  for (const r of all) OSZ_IDX.set(+r.id, { id: +r.id, size: r.size || 0, savedAt: r.savedAt || 0, updated: r.updated || "", v: r.v, name: r.name || "" });
  oszMarks();
}
function oszIndexSoon() { clearTimeout(oszIdxTimer); oszIdxTimer = setTimeout(() => oszIndexLoad().catch(() => {}), 250); }
function oszMark(c) { // one card's "Downloaded" mark: a solid green pill on the cover and a green frame
  const on = OSZ_IDX.has(+c.sid), m = c.querySelector(".bc-have");
  c.classList.toggle("has", on);
  if (on && !m) { const e = h("em", "bc-have", "✓ " + tr("Downloaded")); e.title = oszNote(+c.sid); c.querySelector(".bc-cov").append(e); } else if (!on && m) m.remove();
}
function oszMarks() { // the cards and the open detail panel follow the index
  document.querySelectorAll("#results .card").forEach(oszMark);
  if (typeof detailInfo !== "undefined" && detailInfo && detailInfo.sid && !$("detail").hidden) detailHave();
}
const oszNote = id => { const r = OSZ_IDX.get(+id); return r ? tr("Kept in this browser since {date} · {mb} MB", { date: fmtDate(new Date(r.savedAt).toISOString(), false), mb: (r.size / 1048576).toFixed(1) }) : ""; };
// the detail panel: a green bar "Downloaded" with the date and size and the Re-download button when this set is kept here; amber, with the button as the main one, when osu! has a newer version
let dHaveSeq = 0;
function detailHave() {
  const sid = detailInfo && detailInfo.sid, r = sid && OSZ_IDX.get(+sid), bar = $("dHave"), seq = ++dHaveSeq;
  bar.hidden = !r; bar.classList.remove("upd"); $("dRedl").classList.remove("main"); $("dRedl").classList.add("ghost");
  if (!r) return;
  $("dHaveNote").textContent = oszNote(sid);
  osuSetNow(sid).then(set => { // (osu!'s answer is cached: a newer version than this copy turns the bar amber)
    if (seq !== dHaveSeq || !set || !set.last_updated || !OSZ_IDX.has(+sid)) return;
    if (oszOutdated(OSZ_IDX.get(+sid), set.last_updated)) {
      bar.classList.add("upd"); $("dRedl").classList.replace("ghost", "main");
      $("dHaveNote").textContent = tr("A newer version is on osu! ({date}). Re-download to get it.", { date: fmtDate(set.last_updated, false) });
    }
  }).catch(() => {});
}
setTimeout(() => oszIndexLoad().catch(() => {}), 0); // (the marks on the first page of cards: the index is read as soon as the page is up)
async function oszGet(id) { try { return (await idbTx("osz", "readonly", s => s.get(+id))) || null; } catch { return null; } }
const OSZ_PUTS = new Map(); // id -> the save still running (oszDrop waits for it)
function oszPut(id, blob, updated, name) { // (name: for a card's download, which has no curSet)
  const p = oszSave(id, blob, updated, name || (curSet && +curSet.id === +id ? `${curSet.artist} - ${curSet.title}` : "")).finally(() => { if (OSZ_PUTS.get(+id) === p) OSZ_PUTS.delete(+id); });
  OSZ_PUTS.set(+id, p); return p;
}
// a kept copy thrown away: the Aspire warning answered "Don't open" (no reason to keep a map nobody wants open)
async function oszDrop(id) { try { await OSZ_PUTS.get(+id); await idbTx("osz", "readwrite", s => s.delete(+id)); } catch {} }
async function oszSave(id, blob, updated, name) { // (name: what the Clear cache list calls it)
  try { await idbTx("osz", "readwrite", s => s.put({ id: +id, blob, size: blob.size, updated: updated || "", v: 2, name: name || "", savedAt: Date.now(), usedAt: Date.now() })); await oszTrim(); } catch {}
}
async function oszList() { try { return (await idbTx("osz", "readonly", s => s.getAll())) || []; } catch { return []; } } // (the blobs stay on disk until read)
async function oszTrim() {
  const all = (await oszList()).sort((a, b) => b.usedAt - a.usedAt); let total = 0;
  const drop = all.filter((r, i) => (total += r.size) > OSZ_MAX || i >= OSZ_COUNT).map(r => r.id);
  if (drop.length) await idbTx("osz", "readwrite", s => { for (const id of drop) s.delete(id); });
}
// a newer version on osu! than the kept copy? (the set's last update after the copy's, or after it was kept)
// upd: the set's last update as osu! has it (setUpdated). A kept copy's own date counts only when it was saved by this check (v 2): before, it was whatever the list's mirror said
function oszOutdated(rec, upd) {
  const t = Date.parse(upd || "");
  return isFinite(t) && t > (rec.v === 2 && Date.parse(rec.updated || "") || rec.savedAt) + 1000;
}
// When osu! says the set was last uploaded (the mapper's last update, osu!api through our server, cached for minutes). The mirrors' own dates are not osu!'s (Nerinyan's
// follow its own refreshes), so theirs only count when osu! can't be asked and the list came from another mirror. "" = unknown.
const osuSetNow = id => typeof osuSet === "function" ? Promise.race([osuSet(id).catch(() => null), new Promise(r => setTimeout(r, 3000, null))]) : Promise.resolve(null); // (no answer in 3 s: null)
async function setUpdated(id, set) {
  const s = set === undefined ? await osuSetNow(id) : set;
  if (s && s.last_updated) { if (curSet && +curSet.id === +id) curSet.updated = s.last_updated; return s.last_updated; }
  return curSet && +curSet.id === +id && curSet.src !== "nerinyan" ? curSet.updated || "" : "";
}
// Is this copy older than what osu! has? Some osu!standard difficulty osu! lists (by the MD5 of its .osu) is missing from it: a mirror that kept the old files (osu.direct's
// list says the new checksums while its download holds the old files: all of them differ when every difficulty was touched). No verdict (false) when osu! can't be asked.
async function osuStale(zip, set) {
  const want = ((set && set.beatmaps) || []).filter(b => (b.mode_int ?? 0) === 0 && /^[0-9a-f]{32}$/.test(b.checksum || "")).map(b => b.checksum);
  if (!want.length) return false;
  if (typeof md5Hex !== "function") { try { await loadLazy("replay"); } catch { return false; } } // (the MD5 lives in js/replay.js: loaded when there is something to compare)
  if (typeof md5Hex !== "function") return false;
  const have = new Set();
  for (const f of Object.values(zip.files)) { if (f.dir || !/\.osu$/i.test(f.name)) continue; try { have.add(md5Hex(await f.async("uint8array"))); } catch {} }
  const hit = want.filter(c => have.has(c)).length;
  return hit < want.length;
}
// What a mirror itself lists for the set (its API: osu.direct and catboy give each difficulty's checksum, the same MD5 osu! has) against osu!'s, before anything is downloaded
// from it: true = it lacks one of osu!'s difficulties (an older version), false = it has them all, null = can't tell (no list, no checksums)
function sumsOlder(list, set) {
  const want = ((set && set.beatmaps) || []).filter(b => (b.mode_int ?? 0) === 0 && /^[0-9a-f]{32}$/.test(b.checksum || "")).map(b => b.checksum);
  const have = new Set((Array.isArray(list) ? list : []).map(b => b && b.checksum).filter(c => /^[0-9a-f]{32}$/.test(c || "")));
  if (!want.length || !have.size) return null;
  return want.some(c => !have.has(c));
}
async function mirrorOlder(mi, id, set, signal) {
  if (!mi.set || !set) return null;
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 4000), off = () => ctl.abort();
  signal && signal.addEventListener("abort", off);
  try { const r = await fetch(mi.set(id), { signal: ctl.signal, cache: "no-store" }); if (!r.ok) return null; const j = await r.json(); return sumsOlder(j.beatmaps || j.ChildrenBeatmaps, set); }
  catch { return null; } finally { clearTimeout(tm); signal && signal.removeEventListener("abort", off); }
}
async function oszOpen(rec, id, want, mode, save) { // -> true when the kept copy opened (save: saved as a file instead, see downloadSave)
  try {
    if (!save) showLoading(tr("Unpacking…"), -1);
    const zip = await (await loadJSZip()).loadAsync(rec.blob);
    rec.usedAt = Date.now(); idbTx("osz", "readwrite", s => s.put(rec)).catch(() => {});
    if (save) { oszSaved(rec.blob, save.name); return true; }
    await openZip(zip, id, want, mode); return true;
  } catch (e) { try { await idbTx("osz", "readwrite", s => s.delete(+id)); } catch {} return false; } // broken copy: download it again
}
async function oszCacheUI() {
  const box = $("oszCache"); if (!box) return;
  const all = await oszList(), mb = all.reduce((n, r) => n + r.size, 0) / 1048576;
  box.innerHTML = "";
  const t = h("span"); t.append(h("b", null, tr("Downloaded maps")), h("small", null, tr("{n} kept in this browser · {mb} MB (up to {max} MB). Opening them again needs no download.", { n: all.length, mb: mb.toFixed(1), max: OSZ_MAX / 1048576 })));
  const b = h("button", "btn ghost sm", tr("Clear")); b.disabled = !all.length;
  b.onclick = async () => { if (!(await ask(tr("Delete the {n} downloaded maps kept in this browser? They download again when you open them.", { n: all.length }), { ok: tr("Delete"), danger: true }))) return; try { await idbTx("osz", "readwrite", s => s.clear()); } catch {} oszCacheUI(); toast(tr("Downloaded maps cleared"), 1500); };
  box.append(t, b);
}

// ---------- Clear cache (the nav bar button): choose what to delete among what this browser keeps to open things faster ----------
// Downloaded beatmaps and kept replays, one by one or by group or everything; the delete button needs two more presses (it asks "1 of 2", then "2 of 2")
// before anything goes. Drafts, settings and imported skins are not cache and are not listed.
const CM = { open: false };
async function openCacheMgr() {
  if (CM.open) return; CM.open = true;
  try {
    const [maps, reps] = await Promise.all([oszList(), idbTx("replays", "readonly", s => s.getAll()).catch(() => [])]);
    maps.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0)); (reps || []).sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
    const rname = r => { const m = r.meta || {}, t = [m.artist, m.title].filter(Boolean).join(" - "); return (t ? t + (m.version ? ` [${m.version}]` : "") : tr("Replay")) + (m.player ? " · " + m.player : ""); };
    const groups = [
      { key: "osz", title: tr("Beatmaps"), items: maps.map(r => ({ id: r.id, name: r.name || tr("Set #{id}", { id: r.id }), noName: !r.name, size: r.size || 0, at: r.savedAt })) },
      { key: "replays", title: tr("Replays"), items: (reps || []).map(r => ({ id: r.id, name: rname(r), size: r.size || 0, at: r.savedAt })) }];
    const box = h("div", "cmgr"), picked = new Set(); // (picked: "osz:<id>" / "replays:<id>")
    const keyOf = (g, it) => g.key + ":" + it.id, all = groups.flatMap(g => g.items.map(it => ({ g, it, k: keyOf(g, it) })));
    const mb = n => (n / 1048576).toFixed(n < 1048576 * 10 ? 1 : 0);
    const sum = h("div", "cmsum"), top = h("label", "cmrow cmall"), topCb = h("input"); topCb.type = "checkbox"; top.append(topCb, h("b", null, tr("Select all")));
    box.append(h("p", "hint", tr("Kept in this browser to open things faster, and downloaded again or looked up again when needed. Your drafts, settings and imported skins are not touched.")), top);
    const rows = []; // [{ cb, k }]
    const heads = [];
    for (const g of groups) {
      const sec = h("section", "cmgrp"), hd = h("label", "cmrow cmhd"), gcb = h("input"); gcb.type = "checkbox";
      const tot = g.items.reduce((n, it) => n + it.size, 0);
      hd.append(gcb, h("b", null, g.title), h("small", null, g.items.length ? `${g.items.length} · ${mb(tot)} MB` : ""));
      sec.append(hd);
      const list = h("div", "cmlist");
      if (!g.items.length) list.append(h("p", "cmnone", g.key === "osz" ? tr("No downloaded beatmaps") : tr("No replays kept")));
      for (const it of g.items) {
        const row = h("label", "cmrow"), cb = h("input"); cb.type = "checkbox";
        const nm = h("span", "cmn", it.name); nm.title = it.name; it.el = nm;
        row.append(cb, nm, h("small", null, `${mb(it.size)} MB · ${fmtDate(new Date(it.at || 0).toISOString(), false)}`));
        cb.onchange = () => { cb.checked ? picked.add(keyOf(g, it)) : picked.delete(keyOf(g, it)); sync(); };
        rows.push({ cb, k: keyOf(g, it), g }); list.append(row);
      }
      sec.append(list); box.append(sec); heads.push({ g, gcb });
      gcb.onchange = () => { for (const r of rows) if (r.g === g) { r.cb.checked = gcb.checked; gcb.checked ? picked.add(r.k) : picked.delete(r.k); } sync(); };
    }
    topCb.onchange = () => { for (const r of rows) { r.cb.checked = topCb.checked; topCb.checked ? picked.add(r.k) : picked.delete(r.k); } sync(); };
    // the delete button: three presses (choose, then 1 of 2, then 2 of 2); a change of choice or 15 s without a press starts it over
    const act = h("button", "btn danger cmgo"); act.type = "button"; let stage = 0, tm = 0;
    const picks = () => all.filter(x => picked.has(x.k)), bytes = () => picks().reduce((n, x) => n + x.it.size, 0);
    const label = () => {
      const n = picked.size;
      if (!n) return tr("Select something to clear");
      if (stage === 0) return tr("Clear selected ({n} · {mb} MB)", { n, mb: mb(bytes()) });
      if (stage === 1) return tr("Confirm (1 of 2): delete {n}?", { n });
      return tr("Confirm again (2 of 2): this can't be undone");
    };
    const redraw = () => { act.textContent = label(); act.disabled = !picked.size; act.classList.toggle("armed", stage > 0); act.classList.toggle("armed2", stage === 2); };
    const reset = () => { stage = 0; clearTimeout(tm); redraw(); };
    function sync() {
      for (const { g, gcb } of heads) { const rs = rows.filter(r => r.g === g), n = rs.filter(r => r.cb.checked).length; gcb.checked = !!rs.length && n === rs.length; gcb.indeterminate = n > 0 && n < rs.length; gcb.disabled = !rs.length; }
      const n = rows.filter(r => r.cb.checked).length; topCb.checked = !!rows.length && n === rows.length; topCb.indeterminate = n > 0 && n < rows.length; topCb.disabled = !rows.length;
      sum.textContent = picked.size ? tr("{n} selected · {mb} MB", { n: picked.size, mb: mb(bytes()) }) : "";
      reset();
    }
    act.onclick = async () => {
      if (!picked.size) return;
      if (stage < 2) { stage++; redraw(); clearTimeout(tm); tm = setTimeout(reset, 15000); return; }
      act.disabled = true; clearTimeout(tm);
      const ids = g => picks().filter(x => x.g.key === g).map(x => x.it.id), o = ids("osz"), r = ids("replays"), freed = bytes(), n = picked.size;
      try {
        if (o.length) await idbTx("osz", "readwrite", s => { for (const id of o) s.delete(id); });
        if (r.length) await idbTx("replays", "readwrite", s => { for (const id of r) s.delete(id); });
      } catch { toast(tr("Couldn't clear the cache"), 3000); }
      oszIndexLoad().catch(() => {}); if (typeof oszCacheUI === "function") oszCacheUI(); if (typeof rpuRefreshViews === "function") rpuRefreshViews();
      closeCm(true); toast(tr("Cleared {n} ({mb} MB)", { n, mb: mb(freed) }), 2500);
    };
    box.append(sum, act); sync();
    let closeCm = () => {};
    const done = modal({ title: tr("Clear cache"), body: box, buttons: [{ label: tr("Close"), value: true, cls: "ghost" }], dismiss: true, wide: true });
    closeCm = () => { const b = document.querySelector(".mdl .mdlbtns .btn"); if (b) b.click(); };
    // names the older kept maps lack: asked from osu! (cached by our server), a few at a time
    (async () => { let k = 0; for (const it of groups[0].items) { if (!it.noName || k++ >= 20) continue; const s = await osuSetNow(it.id); if (s && s.title && it.el.isConnected) { it.name = `${s.artist} - ${s.title}`; it.el.textContent = it.name; it.el.title = it.name; } } })().catch(() => {});
    await done;
  } finally { CM.open = false; }
}
$("cacheBtn").onclick = openCacheMgr;
// the set being downloaded and opened (route() leaves it alone), cleared when that's over
let dlId = null;
// opts.accept(zip) (a replay's map, js/replayui.js): false = this mirror's copy is another version of the map, the next mirror is tried; when no mirror has
// the one asked for, the first copy is opened after all (opts.out.fallback = true tells the caller)
async function download(id, want, mode, opts) {
  dlId = id; showLoading(tr("Loading map info…"), -1); // (at once: the Aspire check before the download can take a moment)
  try { return await downloadRun(id, want, mode, opts); } finally { if (String(dlId) === String(id)) dlId = null; }
}
// a card's download button: the same mirrors, fallback and checks as download(), but the .osz is saved to the computer (opts.save = { name, label }) and nothing opens.
// One at a time: the loading cover (Cancel, "Try the next mirror") is shared with download() and covers the list. No Aspire warning: that is about opening a map here.
const SAVING = new Set(); // (set ids as strings)
function cardSaving(id) { // the live cards of the set (the list may have been re-rendered since the click)
  document.querySelectorAll("#results .card").forEach(c => {
    if (String(c.sid) !== String(id)) return;
    const b = c.querySelector(".bc-dl"); if (!b) return;
    const on = SAVING.has(String(id)); b.disabled = on; if (on) b.setAttribute("aria-busy", "true"); else b.removeAttribute("aria-busy");
  });
}
function oszSaved(blob, name) { downloadBlob(blob, name); hideLoadingDl(); toast(tr("Downloaded")); }
async function downloadSave(s) {
  const id = s && s.id;
  if (!/^\d+$/.test(String(id ?? ""))) { toast(tr("This map has no valid set ID")); return; }
  if (SAVING.size || dlId) return; // (one at a time)
  const key = String(id), label = [s.artist, s.title].filter(Boolean).join(" - ");
  SAVING.add(key); cardSaving(id); dlId = id; showLoading(tr("Loading map info…"), -1);
  try { await downloadRun(id, null, "preview", { save: { name: oszFileName(id, s.artist, s.title), label } }); }
  catch (e) { hideLoadingDl(); toast(String(e && e.message || e)); }
  finally {
    SAVING.delete(key); if (String(dlId) === key) dlId = null; cardSaving(id);
    const b = [...document.querySelectorAll("#results .card")].find(c => String(c.sid) === key);
    if (b && (!document.activeElement || document.activeElement === document.body)) b.querySelector(".bc-dl")?.focus({ preventScroll: true }); // (a disabled button drops the focus)
  }
}
async function downloadRun(id, want, mode, opts) {
  const save = opts && opts.save;
  dlCtl && dlCtl.abort(); const ctl = dlCtl = new AbortController(), sig = ctl.signal;
  if (!save && !(await aspirePre(id))) { aspireDeclined(); return; } // (an Aspire map: asked before anything is downloaded)
  if (sig.aborted) return;
  const kept = opts && opts.fresh ? null : await oszGet(id), osuS = await osuSetNow(id), upd = await setUpdated(id, osuS); // (opts.fresh: Re-download, the kept copy is not used, the new one replaces it)
  if (sig.aborted) return;
  if (kept) {
    const busy = (typeof LIVE !== "undefined" && LIVE.opening) || (typeof COLLAB !== "undefined" && COLLAB.opening); // joining: always the newest
    const outdated = oszOutdated(kept, upd);
    let useKept = !outdated || (!busy && !(await ask(tr("This beatmap was updated on osu! ({date}) after you downloaded it.\n\nDownload the new version?", { date: fmtDate(upd, false) }), { title: tr("Newer version on osu!"), ok: tr("Download the new version"), cancel: save ? tr("Save my copy") : tr("Open my copy") })));
    if (useKept && opts && opts.accept) { try { if (!(await opts.accept(await (await loadJSZip()).loadAsync(kept.blob)))) useKept = false; } catch {} } // (a replay's map: a kept copy of another version isn't used, the mirrors are asked)
    if (useKept && osuS) { try { if (await osuStale(await (await loadJSZip()).loadAsync(kept.blob), osuS)) useKept = false; } catch {} } // (kept from a mirror that had an older version)
    if (useKept && await oszOpen(kept, id, want, mode, save)) return;
    if (sig.aborted) return;
  }
  if (save && navigator.onLine === false) { hideLoadingDl(); toast(tr("You're offline: only maps already downloaded can be saved")); return; }
  const order = orderedMirrors(), late = new Set(), olderOk = new Set(); let fallback = null, stale = null;
  const canAsk = !((typeof LIVE !== "undefined" && LIVE.opening) || (typeof COLLAB !== "undefined" && COLLAB.opening)) && !(opts && opts.accept); // (joining a session and a replay's map never stop to ask)
  const askOlder = mi => ask(tr("{m} has an older version of this map than osu!.\n\nTry another mirror?", { m: mi.name }), { title: tr("Older version on the mirror"), ok: tr("Try another mirror"), cancel: tr("Use this older version") });
  for (let i = 0; i < order.length; i++) {
    const mi = order[i];
    if (!late.has(mi) && !olderOk.has(mi) && await mirrorOlder(mi, id, osuS, sig)) { // (its own list says it has an older version than osu!)
      if (sig.aborted) return;
      if (canAsk ? await askOlder(mi) : true) { // (asked: another mirror first, it comes last; "use this older version" goes on with it)
        if (sig.aborted) return;
        late.add(mi); order.push(mi); if (!canAsk) toast(tr("{m} still has an older version than osu!, trying another mirror", { m: mi.name }), 2500); continue;
      }
      olderOk.add(mi);
    }
    const one = dlOne = new AbortController(), kill = () => one.abort();
    sig.addEventListener("abort", kill);
    let timer = 0; const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { one.timedOut = true; one.abort(); }, ms); };
    try {
      showLoading(tr("Contacting {m}…", { m: mi.name }), -1); $("nextMirror").hidden = i === order.length - 1;
      arm(20000);
      const r = await fetch(mi.dl(id), { signal: one.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const total = +r.headers.get("content-length") || 0;
      let blob;
      if (r.body) {
        const reader = r.body.getReader(), chunks = []; let got = 0, shown = 0;
        one.signal.addEventListener("abort", () => reader.cancel().catch(() => {}));
        for (;;) {
          arm(25000); // stalled for 25 s = give up on this mirror
          const { done, value } = await reader.read(); if (done) break;
          if (one.signal.aborted) throw new DOMException("aborted", "AbortError");
          chunks.push(value); got += value.length;
          if (got - shown > 131072) { shown = got; showLoading(`${tr("Downloading from {m}", { m: mi.name })} · ${(got / 1048576).toFixed(1)}${total ? " / " + (total / 1048576).toFixed(1) : ""} MB`, total ? got / total : -1); }
        }
        if (total && got < total) throw new Error(tr("the download was cut off"));
        blob = new Blob(chunks);
      } else blob = await r.blob();
      clearTimeout(timer);
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error(tr("the file isn't a .osz"));
      showLoading(tr("Unpacking…"), -1);
      let zip; try { zip = await (await loadJSZip()).loadAsync(blob); } catch (e) { if (/JSZip/.test(e.message)) throw Object.assign(e, { fatal: true }); throw new Error(tr("the file is broken")); }
      if (opts && opts.accept && !(await opts.accept(zip))) { fallback = fallback || { zip, blob }; throw new Error(tr("another version of the map")); }
      if (!olderOk.has(mi) && await osuStale(zip, osuS)) { // (this mirror's file is an older version: the next one is asked, unless it was chosen)
        if (canAsk && !late.has(mi) && !(await askOlder(mi))) olderOk.add(mi);
        else { stale = stale || { zip, blob }; throw new Error(tr("older than the one on osu!")); }
      }
      $("nextMirror").hidden = true;
      if (!olderOk.has(mi)) oszPut(id, blob, upd, save && save.label); // (an older version chosen anyway is not kept: asked again next time) // keep it: no download next time
      if (save) { oszSaved(blob, save.name); return; }
      await openZip(zip, id, want, mode);
      return;
    } catch (e) {
      if (sig.aborted) { hideLoadingDl(); return; } // cancelled by the user (or a newer download)
      if (e.fatal) { hideLoadingDl(); toast(e.message); break; }
      const why = one.skipped ? tr("skipped") : one.timedOut ? tr("timed out") : e.name === "TypeError" ? tr("network error") : e.message;
      if (i < order.length - 1) toast(tr("{m} failed ({err}), trying {next}", { m: mi.name, err: why, next: order[i + 1].name }));
    } finally { clearTimeout(timer); sig.removeEventListener("abort", kill); if (dlOne === one) dlOne = null; }
  }
  if (sig.aborted) return;
  if (fallback) { // (no mirror has the version asked for: the first copy opens, the caller says what differs)
    $("nextMirror").hidden = true; if (opts.out) opts.out.fallback = true;
    oszPut(id, fallback.blob, upd);
    await openZip(fallback.zip, id, want, mode); return;
  }
  if (stale && save) { // (the same, saved: not kept either)
    downloadBlob(stale.blob, save.name); hideLoadingDl(); toast(tr("Every mirror has an older version of this map than osu!. It was saved anyway; for the newest, download it from osu!."), 9000); return;
  }
  if (stale) { // (every mirror has an older version than osu!: it opens, not kept, and says so)
    $("nextMirror").hidden = true; toast(tr("Every mirror has an older version of this map than osu!. It opened anyway; for the newest, download it from osu! and drop the .osz here."), 9000);
    await openZip(stale.zip, id, want, mode); return;
  }
  hideLoadingDl();
  if (UI.player.hidden && detailInfo && !save) $("detail").hidden = false;
  // new / pending / graveyard maps often aren't on any mirror: get the .osz from osu! and open it here
  if ((await ask(tr("None of the mirrors has map #{id} (new, pending and some graveyard maps can take a while to reach them).\n\nDownload it from osu! (opens osu.ppy.sh, login needed) and then open the .osz here?", { id }), { title: tr("Not on the mirrors yet"), ok: tr("Open osu!") }))) {
    open(osuDlURL(id), "_blank", "noopener");
    if (!save) toast(tr("When the download finishes, drop the .osz on this page or press \"Open .osz file\""), 7000);
  }
}

// ============ beatmap package ============
function quickMeta(t) {
  const g = k => ((t.match(new RegExp("^" + k + "[ \\t]*:[ \\t]*(.*)$", "m")) || [])[1] || "").trim(); // (an empty "TitleUnicode:" mustn't take the next line)
  const lastObj = +((t.trimEnd().split(/\r?\n/).pop() || "").split(",")[2]) || 0;
  return { version: g("Version") || "?", mode: g("Mode") || "0", bid: g("BeatmapID"), sid: g("BeatmapSetID"),
    title: g("TitleUnicode") || g("Title"), artist: g("ArtistUnicode") || g("Artist"), creator: g("Creator"),
    cs: g("CircleSize"), ar: g("ApproachRate") || g("OverallDifficulty"), od: g("OverallDifficulty"), hp: g("HPDrainRate"),
    bg: (t.match(/^0\s*,\s*0\s*,\s*"([^"]+)"/m) || [])[1] || "", len: lastObj / 1000, rank: (+g("OverallDifficulty") || 0) + (+g("ApproachRate") || 0) * 0.5 + (+g("CircleSize") || 0) * 0.1 + t.split("\n").length / 5000 };
}
// Rough star rating for difficulties without an official one (made here, or opened from a file): osu!'s classic
// aim + speed strain method (strains decay over time, the hardest 400 ms sections count most). Close to osu!'s old
// star ratings: good for ordering difficulties, shown as "≈".
function estimateStars(text) {
  const g = k => +(((text.match(new RegExp("^" + k + "\\s*:\\s*(.*)$", "m")) || [])[1]) || NaN);
  const cs = isFinite(g("CircleSize")) ? g("CircleSize") : 5, radius = 32 * (1 - 0.7 * (cs - 5) / 5);
  let scale = 52 / radius; if (radius < 30) scale *= 1 + Math.min(30 - radius, 5) / 50;
  const sec = text.indexOf("[HitObjects]"); if (sec < 0) return 0;
  const objs = [];
  for (const line of text.slice(sec + 12).split(/\r?\n/)) {
    const p = line.split(","); if (p.length < 4) continue;
    const type = +p[3]; if (type & 8) continue; // spinners add nothing here
    const t = +p[2]; if (!isFinite(t) || Math.abs(t) > T_MAX) continue; // (osu! skips these too)
    objs.push({ x: +p[0] * scale, y: +p[1] * scale, t });
  }
  if (objs.length < 2) return 0;
  const speedW = d => d > 125 ? 2.5 : d > 110 ? 1.6 + 0.9 * (d - 110) / 15 : d > 90 ? 1.2 + 0.4 * (d - 90) / 20 : d > 45 ? 0.95 + 0.25 * (d - 45) / 45 : 0.95;
  const skill = (value, decay) => {
    let strain = 0, peak = 0, sectionEnd = Math.ceil(objs[0].t / 400) * 400; const peaks = [];
    for (let i = 1; i < objs.length; i++) {
      const a = objs[i - 1], b = objs[i], dt = Math.max(b.t - a.t, 50), d = Math.hypot(b.x - a.x, b.y - a.y);
      if (b.t - sectionEnd > 4e5) { peaks.push(peak); peak = 0; sectionEnd = Math.ceil(b.t / 400) * 400 - 400; } // (a gap of minutes: the strain is gone anyway, skip the empty sections)
      while (b.t > sectionEnd) { peaks.push(peak); peak = strain * Math.pow(decay, (sectionEnd - a.t) / 1000); sectionEnd += 400; }
      strain = strain * Math.pow(decay, (b.t - a.t) / 1000) + value(d) / dt;
      peak = Math.max(peak, strain);
    }
    peaks.push(peak);
    peaks.sort((x, y) => y - x);
    let sum = 0, w = 1; for (const x of peaks) { sum += x * w; w *= 0.9; }
    return Math.sqrt(sum) * 0.0675;
  };
  const aim = skill(d => Math.pow(d, 0.99) * 26.25, 0.15), speed = skill(d => speedW(d) * 1400, 0.3);
  return aim + speed + Math.abs(aim - speed) * 0.5;
}
// difficulties ordered by star rating: the official one when the set is on osu!, else the estimate
function rateDiffs() {
  const online = curSet && Array.isArray(curSet.diffs) ? curSet.diffs : [];
  for (const o of osuFiles) {
    const d = online.find(x => o.meta.bid && String(x.bid) === String(o.meta.bid)) || online.find(x => x.name === o.meta.version);
    if (d && d.stars > 0) { o.stars = d.stars; o.estStars = false; }
    else { o.stars = estimateStars(o.text); o.estStars = true; }
  }
  osuFiles.sort((a, b) => a.stars - b.stars || a.meta.rank - b.meta.rank);
}
const diffLabel = o => (o.stars > 0 ? `${o.meta.version} · ${o.estStars ? "≈" : ""}★${o.stars.toFixed(2)}` : o.meta.version);
// a dot on the difficulties whose edits aren't exported yet (they're kept in the browser as you switch, in a local draft too: only an export writes the file)
function diffMarks() {
  if (typeof EDIT === "undefined") return;
  for (const sel of [$("diff"), $("diffQuick")]) osuFiles.forEach((o, i) => {
    const op = sel.options[i]; if (!op) return;
    const cur = i === curDiff && map, lab = diffLabel(cur ? { ...o, meta: { ...o.meta, version: map.meta.Version } } : o);
    op.text = (o.edited || o.created || (i === curDiff && EDIT.changed) ? "● " : "") + lab;
  });
}
function fillDiffSelects() {
  for (const sel of [$("diff"), $("diffQuick")]) { sel.innerHTML = ""; osuFiles.forEach((o, i) => sel.add(new Option(diffLabel(o), i))); sel.value = curDiff; }
  diffMarks();
  $("diffQuick").hidden = osuFiles.length < 2;
}
async function openZip(blob, id, want, mode) {
  let zip = blob;
  if (!blob.forEach) {
    showLoading(tr("Unpacking…"), -1);
    try { zip = await (await loadJSZip()).loadAsync(blob); } catch (e) { hideLoading(); toast(/JSZip/.test(e.message) ? e.message : tr("Couldn't open the file, it may be broken")); return; }
  }
  const entries = {}; zip.forEach((p, f) => { if (!f.dir) entries[p] = f; });
  return openEntries(entries, id, want, mode);
}
// a file map { path: { name, async(type) } } (JSZip entries, or blobEntry() for files made in the browser)
const blobEntry = (name, blob) => ({ name, dir: false, size: blob.size, async: t => t === "string" ? blob.text() : t === "arraybuffer" ? blob.arrayBuffer() : t === "uint8array" ? blob.arrayBuffer().then(b => new Uint8Array(b)) : Promise.resolve(blob) });
// Aspire maps (their Tags or Source say so) break osu!'s rules on purpose, so they can stall the page or not work in
// Modding: ask before anything is parsed or the open map is closed. "Don't open" is the main button and has the focus
// (Enter, Esc or a click outside all mean no); "Open anyway" is the quiet one. Yes is remembered for that set until
// the page is closed; no keeps the open map (a guest in a live or collab session leaves it: they can't follow the host).
const ASPIRE_OK = new Set();
// The Aspire warning's sound, made in Web Audio (no files): modern horror. A sub drone beating slowly under a distorted
// growl, a cluster of high strings a semitone apart bending slowly down, a soft system alarm (two tones, every bar), a
// metallic screech now and then; each approach circle landing (in step with the CSS: every 1.6 s from 0.62 s) has a
// breath drawn in before it. The tear-in is a crushed burst, the title's decoding harsh digital clicks, each glitch
// (every 7 s from 8.5 s) a bit-crushed stutter. Holding "Open anyway": the alarm goes 4x, everything rises and
// distorts more; opening a lone violin gliding up and a gust of wind passing, not opening a tape stop. (No heartbeat.) Scheduled ahead on the audio clock. At the site's volume (master × music).
function aspSfx() {
  const vol = typeof musGain === "function" ? musGain() : 0; // the site's volume (master × music, like the song previews here)
  let c; try { c = getCtx(); if (c.state !== "running") c.resume().catch(() => {}); } catch { c = null; }
  const dead = { tick() {}, hold() {}, go() {}, cancel() {} };
  if (!c || vol <= 0) return dead;
  const t0 = c.currentTime, sr = c.sampleRate, nodes = [];
  const out = c.createGain(), comp = c.createDynamicsCompressor(), master = c.createGain(); master.gain.value = Math.min(1, vol); // (after the compressor: its make-up gain no longer lifts quiet settings)
  comp.threshold.value = -14; comp.ratio.value = 5; out.connect(comp); comp.connect(master); master.connect(c.destination);
  const gain = v => { const g = c.createGain(); g.gain.value = v; return g; };
  const pan = p => { const n = c.createStereoPanner ? c.createStereoPanner() : c.createGain(); if (n.pan) n.pan.value = p; return n; };
  const shaper = k => { const w = c.createWaveShaper(), cv = new Float32Array(1024); for (let j = 0; j < 1024; j++) { const x = j / 511.5 - 1; cv[j] = Math.tanh(k * x) / Math.tanh(k); } w.curve = cv; w.oversample = "2x"; return w; };
  const crusher = steps => { const w = c.createWaveShaper(), cv = new Float32Array(1024); for (let j = 0; j < 1024; j++) { const x = j / 511.5 - 1; cv[j] = Math.round(x * steps) / steps; } w.curve = cv; return w; };
  // a dark hall (the noise of its tail smoothed, so it rumbles rather than hisses)
  const rev = c.createConvolver(), len = sr * 3.5 | 0, ir = c.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let lp = 0; for (let k = 0; k < len; k++) { lp += ((Math.random() * 2 - 1) - lp) * .18; d[k] = lp * 2.4 * Math.pow(1 - k / len, 2.6); } }
  rev.buffer = ir; const revOut = gain(.7); rev.connect(revOut); revOut.connect(out);
  const send = (n, d, r, p = 0) => { const pp = pan(p); n.connect(pp); if (d) { const g = gain(d); pp.connect(g); g.connect(out); } if (r) { const g = gain(r); pp.connect(g); g.connect(rev); } };
  let noiseBuf = null;
  const noise = () => { if (!noiseBuf) { noiseBuf = c.createBuffer(1, sr * 2, sr); const d = noiseBuf.getChannelData(0); for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1; } const n = c.createBufferSource(); n.buffer = noiseBuf; n.loop = true; return n; };
  const env = (g, at, a, peak, d) => { g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + a); g.gain.exponentialRampToValueAtTime(.0008, at + a + d); };
  // ---- the beds ----
  const sub = gain(0), growl = gain(0), strBus = gain(0), dist = shaper(6), growlLp = c.createBiquadFilter(); growlLp.type = "lowpass"; growlLp.frequency.value = 220; growlLp.Q.value = 9;
  for (const f of [36.71, 37.9]) { const o = c.createOscillator(); o.frequency.value = f; nodes.push(o); o.connect(sub); } // (beating ~1.2 Hz)
  send(sub, .9, .2);
  for (const [f, dt] of [[36.71, -12], [36.71, 9], [73.42, 0]]) { const o = c.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = dt; nodes.push(o); o.connect(dist); }
  dist.connect(growlLp); growlLp.connect(growl); send(growl, .7, .5);
  const glfo = c.createOscillator(), glfoG = gain(140); glfo.frequency.value = .13; nodes.push(glfo); glfo.connect(glfoG); glfoG.connect(growlLp.frequency);
  const strs = [];
  for (const [f, p] of [[932.33, -.7], [987.77, .7], [1046.5, -.2], [1479.98, .3]]) { // (B♭, B, C, F♯: semitones and a tritone)
    const o = c.createOscillator(), g = gain(1), tr = c.createOscillator(), trG = gain(.35); o.type = "sawtooth"; o.frequency.value = f; tr.frequency.value = 5 + Math.random() * 2;
    tr.connect(trG); trG.connect(g.gain); nodes.push(o, tr); strs.push(o);
    const bp = c.createBiquadFilter(), pp = pan(p); bp.type = "bandpass"; bp.frequency.value = f * 1.5; bp.Q.value = 1.5; o.connect(bp); bp.connect(g); g.connect(pp); pp.connect(strBus);
    o.frequency.setValueAtTime(f, t0 + 1); o.frequency.linearRampToValueAtTime(f * .94, t0 + 30); // (bending down, slowly)
  }
  send(strBus, .25, 1); strBus.gain.setValueAtTime(0, t0); strBus.gain.linearRampToValueAtTime(.05, t0 + 3);
  sub.gain.setValueAtTime(0, t0); sub.gain.linearRampToValueAtTime(.5, t0 + 1.2);
  growl.gain.setValueAtTime(0, t0); growl.gain.linearRampToValueAtTime(.1, t0 + 2);
  // the riser while held: saws climbing two octaves through distortion, and noise
  const riseLp = c.createBiquadFilter(), riseG = gain(0), riseDist = shaper(4); riseLp.type = "lowpass"; riseLp.frequency.value = 400;
  const risers = [110, 116.54].map(f => { const o = c.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; nodes.push(o); o.connect(riseDist); return o; });
  riseDist.connect(riseLp); riseLp.connect(riseG); send(riseG, .7, .5);
  const hiss = noise(), hissG = gain(0), hissHp = c.createBiquadFilter(); hissHp.type = "highpass"; hissHp.frequency.value = 2500; hiss.connect(hissHp); hissHp.connect(hissG); send(hissG, .6, .5); nodes.push(hiss);
  for (const o of nodes) o.start(t0);
  // ---- one-shots ----
  const inhale = (at, dur, lvl) => { const n = noise(), bp = c.createBiquadFilter(), g = gain(0); bp.type = "bandpass"; bp.Q.value = 3; bp.frequency.setValueAtTime(700, at); bp.frequency.exponentialRampToValueAtTime(2600, at + dur);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(lvl, at + dur * .95); g.gain.linearRampToValueAtTime(0, at + dur); n.connect(bp); bp.connect(g); send(g, .5, .8, Math.random() - .5); n.start(at); n.stop(at + dur + .02); };
  const alarm = (at, lvl) => { for (const [dt, f] of [[0, 880], [.14, 698.46]]) { const o = c.createOscillator(), bp = c.createBiquadFilter(), g = gain(0); o.type = "square"; o.frequency.value = f; bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = 6;
    o.connect(bp); bp.connect(g); env(g, at + dt, .005, lvl, .12); send(g, .5, .6, dt ? .4 : -.4); o.start(at + dt); o.stop(at + dt + .15); } };
  const screech = (at, lvl) => { const car = c.createOscillator(), mod = c.createOscillator(), mg = gain(0), g = gain(0), f = 1800 + Math.random() * 1600;
    car.frequency.setValueAtTime(f, at); car.frequency.exponentialRampToValueAtTime(f * (.5 + Math.random() * .3), at + .9); mod.frequency.value = f * 1.41; mg.gain.value = f * 2.5;
    mod.connect(mg); mg.connect(car.frequency); car.connect(g); g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(lvl, at + .3); g.gain.linearRampToValueAtTime(0, at + .9);
    send(g, .3, 1, Math.random() * 1.6 - .8); car.start(at); mod.start(at); car.stop(at + .95); mod.stop(at + .95); };
  const burst = (at, dur, lvl, steps) => { const n = noise(), cr = crusher(steps), bp = c.createBiquadFilter(), g = gain(0); bp.type = "bandpass"; bp.frequency.value = 1800; bp.Q.value = .7;
    for (let k = 0; k < dur; k += .025) g.gain.setValueAtTime(Math.random() < .65 ? lvl : 0, at + k);
    g.gain.setValueAtTime(0, at + dur); n.connect(cr); cr.connect(bp); bp.connect(g); send(g, 1, .3, Math.random() - .5); n.start(at); n.stop(at + dur + .02); };
  // the tear-in
  burst(t0, .35, .5, 6);
  // ---- the clock: landings, alarm, screeches, glitches ----
  const T1 = t0 + .62, BAR = 1.6;
  let nextBeat = T1, nextAlarm = T1 + .8, nextScreech = t0 + 3 + Math.random() * 3, glitchAt = t0 + 8.51, holdK = 0, ended = false, loopT = 0;
  const loop = () => {
    if (ended) return;
    const now = c.currentTime, until = now + .3;
    while (nextBeat < until) { // a breath drawn in before each landing
      if (nextBeat > now - .02 && !holdK) inhale(nextBeat - .34, .32, .16);
      nextBeat += BAR;
    }
    while (nextAlarm < until) { if (nextAlarm > now - .02) alarm(nextAlarm, .05 + holdK * .07); nextAlarm += holdK > .3 ? BAR / 4 : BAR; }
    if (nextScreech < until) { screech(nextScreech, .025 + holdK * .03); nextScreech += 4 + Math.random() * 5 - holdK * 3; }
    if (glitchAt < until) { burst(glitchAt, .18, .4, 4); glitchAt += 7; }
    loopT = setTimeout(loop, 90);
  };
  loopT = setTimeout(loop, 0);
  const end = (fade, dive) => {
    if (ended) return; ended = true; clearTimeout(loopT);
    const now = c.currentTime;
    if (dive) for (const o of nodes) if (o.frequency) o.frequency.setTargetAtTime(Math.max(8, o.frequency.value * .2), now, fade / 3); // (tape stop)
    out.gain.cancelScheduledValues(now); out.gain.setValueAtTime(out.gain.value, now); out.gain.linearRampToValueAtTime(0, now + fade);
    setTimeout(() => { for (const o of nodes) try { o.stop(); } catch {} try { comp.disconnect(); } catch {} }, fade * 1000 + 150);
  };
  return {
    tick() { if (ended) return; const now = c.currentTime, o = c.createOscillator(), cr = crusher(3), g = gain(0); o.type = "square"; o.frequency.value = 400 + Math.random() * 3000;
      o.connect(cr); cr.connect(g); env(g, now, .002, .04, .03); send(g, 1, .1, Math.random() - .5); o.start(now); o.stop(now + .05); },
    hold(k) { if (ended) return; const now = c.currentTime; holdK = k;
      risers[0].frequency.setTargetAtTime(110 * Math.pow(4, k), now, .04); risers[1].frequency.setTargetAtTime(116.54 * Math.pow(4, k), now, .04);
      riseLp.frequency.setTargetAtTime(400 + k * 5000, now, .05); riseG.gain.setTargetAtTime(k ? .04 + k * .14 : 0, now, k ? .04 : .1);
      hissG.gain.setTargetAtTime(k * k * .1, now, .05); growlLp.frequency.setTargetAtTime(220 + k * 900, now, .08); growl.gain.setTargetAtTime(.1 + k * .15, now, .08); strBus.gain.setTargetAtTime(.05 + k * .09, now, .08); },
    go() { if (ended) return; const now = c.currentTime + .005;
      // the moment it's let through: a lone violin and a gust of wind. The beds fade within a quarter second; a bowed
      // string (a saw through a violin body's resonances, bow noise, vibrato widening as it goes) glides slowly up from
      // E5 and hangs high and thin, a second one a semitone off, quieter, behind it; wind howls past from left to right
      ended = true; clearTimeout(loopT);
      for (const g of [sub, growl, riseG, hissG, strBus]) { g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + .25); }
      const violin = (at, f0, f1, lvl, p) => {
        const o = c.createOscillator(), vib = c.createOscillator(), vibG = gain(0), body = gain(0), g = gain(0), pp = pan(p);
        o.type = "sawtooth"; o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + 1.3); o.frequency.exponentialRampToValueAtTime(f1 * .985, at + 3.2);
        vib.frequency.value = 5.6; vibG.gain.setValueAtTime(f0 * .003, at); vibG.gain.linearRampToValueAtTime(f1 * .012, at + 2.4); vib.connect(vibG); vibG.connect(o.frequency);
        for (const [ff, q, l] of [[290, 4, .5], [1050, 3, .8], [2900, 2.5, .6], [4500, 3, .25]]) { const bp = c.createBiquadFilter(), bg = gain(l); bp.type = "bandpass"; bp.frequency.value = ff; bp.Q.value = q; o.connect(bp); bp.connect(bg); bg.connect(body); }
        const bow = noise(), bowBp = c.createBiquadFilter(), bowG = gain(lvl * .25); bowBp.type = "bandpass"; bowBp.frequency.value = f1 * 2; bowBp.Q.value = 2; bow.connect(bowBp); bowBp.connect(bowG); bowG.connect(g);
        body.connect(g); body.gain.value = 1; g.connect(pp);
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(lvl, at + .45); g.gain.setValueAtTime(lvl, at + 1.8); g.gain.linearRampToValueAtTime(0, at + 3.4);
        const dry = gain(.45), wet = gain(1); pp.connect(dry); dry.connect(out); pp.connect(wet); wet.connect(rev);
        for (const n of [o, vib, bow]) { n.start(at); n.stop(at + 3.5); }
      };
      violin(now, 659.26, 1760, .07, -.15);       // (E5 up to A6)
      violin(now + .12, 698.46, 1864.66, .03, .3); // (a semitone off, behind it)
      { const n = noise(), bp = c.createBiquadFilter(), howl = c.createBiquadFilter(), g = gain(0), pp = pan(-1), lfo = c.createOscillator(), lfoG = gain(160);
        bp.type = "bandpass"; bp.Q.value = 1.2; bp.frequency.setValueAtTime(300, now); bp.frequency.exponentialRampToValueAtTime(1800, now + .9); bp.frequency.exponentialRampToValueAtTime(400, now + 2.6);
        howl.type = "peaking"; howl.frequency.value = 720; howl.Q.value = 12; howl.gain.value = 18; lfo.frequency.value = .9; lfo.connect(lfoG); lfoG.connect(howl.frequency);
        if (pp.pan) { pp.pan.setValueAtTime(-1, now); pp.pan.linearRampToValueAtTime(1, now + 2.6); }
        g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(.16, now + .8); g.gain.linearRampToValueAtTime(0, now + 2.8);
        n.connect(bp); bp.connect(howl); howl.connect(g); g.connect(pp); const dry = gain(.7), wet = gain(.6); pp.connect(dry); dry.connect(out); pp.connect(wet); wet.connect(rev);
        n.start(now); lfo.start(now); n.stop(now + 2.9); lfo.stop(now + 2.9); }
      setTimeout(() => { for (const o of nodes) try { o.stop(); } catch {} }, 400);
      setTimeout(() => { try { comp.disconnect(); } catch {} }, 7000); },
    cancel() { end(1.7, true); },
  };
}
// player tags (the ones osu! players vote on) that mark the same kind of map: Aspire, and 2B (objects at the same time)
const ASPIRE_USER_TAGS = ["gimmick/aspire", "gimmick/2b"];
async function aspireAsk(entries, read, setId) {
  const tags = new Set(); let key = "", name = "", sid = +setId > 0 ? +setId : 0, card = null;
  for (const p in entries) {
    if (entries[p].dir || !norm(p).endsWith(".osu")) continue;
    let t; try { t = await read(entries[p]); } catch { continue; }
    const end = t.indexOf("[HitObjects]"), head = end < 0 ? t.slice(0, 200000) : t.slice(0, end); // (the metadata comes before the objects)
    const g = k => ((head.match(new RegExp("^" + k + "[ \\t]*:[ \\t]*(.*)$", "m")) || [])[1] || "").trim(); // (not \s: an empty "Source:" would take the next line)
    for (const w of (g("Tags") + " " + g("Source")).split(/\s+/)) if (/aspire/i.test(w)) tags.add(w.toLowerCase());
    if (!key) {
      if (!sid && +g("BeatmapSetID") > 0) sid = +g("BeatmapSetID"); key = sid ? "s" + sid : g("Title") + "|" + g("Creator"); name = [g("Artist"), g("Title")].filter(Boolean).join(" - ");
      const bg = (head.match(/^\s*0\s*,\s*0\s*,\s*"?([^",\r\n]+?)"?\s*(?:,|$)/m) || [])[1]; // (the background, for the card when there's no set cover)
      card = { title: g("Title"), artist: g("Artist"), creator: g("Creator"), bg: bg ? norm(bg) : "" };
    }
  }
  if (ASPIRE_OK.has(key)) return true;
  const info = sid ? await aspireSetInfo(sid) : { ranked: false, user: [] };
  if (info.ranked) return true;
  if (!tags.size && !info.user.length) return true;
  if (card) { // the cover: the set's on osu! (when it has one), else the package's own background
    card.sid = sid;
    const e = card.bg && Object.keys(entries).find(p => norm(p) === card.bg);
    if (e) try { const b = await entries[e].async("blob"); if (b && b.size) card.blob = b; } catch {}
  }
  return aspireWarn({ key, name, tags, user: info.user, card });
}
// what osu! says of the set (fetched for its page or ahead; waited for 1.5 s at most): ranked or not, and the player
// tags that mark it. Ranked, Approved and Qualified maps passed osu!'s rules, so they're never warned about (Loved,
// Graveyard and the rest are)
async function aspireSetInfo(sid) {
  const set = typeof osuSet === "function" ? await Promise.race([osuSet(sid).catch(() => null), new Promise(r => setTimeout(() => r(null), 1500))]) : null;
  const cur = curSet && +curSet.id === +sid ? curSet : null, st = String((set && set.status) || (cur && cur.status) || "").toLowerCase();
  return { set: set || cur, ranked: ["ranked", "approved", "qualified", "1", "2", "3"].includes(st), user: ((set && set.related_tags) || []).map(t => String(t.name)).filter(n => ASPIRE_USER_TAGS.includes(n.toLowerCase())) };
}
// before a set is downloaded: what's known of it already (its tags and source from the listing, its player tags on osu!)
// is enough to warn, so a map nobody wants open is never downloaded. Maps that only show it in their files (no tags in
// the listing, a local .osz) are still caught after the download (aspireAsk)
async function aspirePre(id) {
  const key = "s" + id; if (ASPIRE_OK.has(key)) return true;
  const s = curSet && +curSet.id === +id ? curSet : null, tags = new Set();
  if (s && ["ranked", "approved", "qualified"].includes(String(s.status))) { ASPIRE_OK.add(key); return true; } // (no wait for osu!)
  if (s) for (const w of ((s.tags || "") + " " + (s.source || "")).split(/\s+/)) if (/aspire/i.test(w)) tags.add(w.toLowerCase());
  const info = await aspireSetInfo(id);
  if (info.ranked) { ASPIRE_OK.add(key); return true; } // (and no check after the download either)
  if (!tags.size && !info.user.length) return true;
  const o = s || info.set || {}, card = { sid: id, title: o.title || "", artist: o.artist || "", creator: o.creator || "" };
  return aspireWarn({ key, name: [card.artist, card.title].filter(Boolean).join(" - "), tags, user: info.user, card });
}
// said no: a guest joining a live or collab session leaves it (they can't follow the host)
function aspireDeclined() {
  hideLoading();
  if (UI.player.hidden && detailInfo && R.inMap) $("detail").hidden = false; // (back to the map's sheet, not a bare list)
  if (LIVE.on && LIVE.opening) liveEnd(true, tr("You left the live session"));
  if (COLLAB.on && COLLAB.opening) collabEnd(true, tr("You left the collab session"));
}
// what makes the warning creepier while it's open (assets/app.css .hzfx): the light flickering now and then, red drips running down from the box's top edge,
// and the title glitching back into noise for a moment every few seconds. -> a function that stops it
function aspireFx(wrap, tt) {
  const fx = h("div", "hzfx"); fx.setAttribute("aria-hidden", "true");
  const flick = h("div", "hzflick");
  fx.append(flick); wrap.prepend(fx);
  const panel = wrap.querySelector(".mdlp");
  for (let k = 0; k < 3; k++) { const d = h("i", "hzdrip"); d.style.left = (12 + k * 33 + Math.random() * 18) + "%"; d.style.animationDelay = (1.5 + k * 1.9 + Math.random()) + "s"; panel.append(d); }
  // the title slipping back into noise for a moment
  const fin = tt.textContent, noise = "!#%&*?/<>[]=+▓▒░"; let alive = true;
  const glitch = () => {
    if (!alive) return;
    const idx = new Set(Array.from({ length: 2 + (Math.random() * 3 | 0) }, () => Math.random() * fin.length | 0));
    tt.textContent = Array.from(fin, (ch, i) => idx.has(i) && ch !== " " ? noise[Math.random() * noise.length | 0] : ch).join("");
    setTimeout(() => { if (alive) tt.textContent = fin; }, 90 + Math.random() * 80);
    setTimeout(glitch, 2600 + Math.random() * 3200);
  };
  setTimeout(glitch, 2200);
  return () => { alive = false; tt.textContent = fin; };
}
// the map the warning is about, as a card: its cover (the set's on osu!, or the package's background), the title, the
// artist and who mapped it. -> [element, cleanup]
function aspireCard(c) {
  const el = h("div", "aspcard"), art = h("div", "aspcov"), txt = h("div", "aspctx");
  art.setAttribute("aria-hidden", "true");
  let url = "", revoke = null;
  if (c.blob) { url = URL.createObjectURL(c.blob); revoke = () => URL.revokeObjectURL(url); }
  else if (c.sid > 0) url = `https://assets.ppy.sh/beatmaps/${c.sid}/covers/${(devicePixelRatio || 1) > 1.4 ? "card@2x" : "card"}.jpg`;
  if (url) {
    const img = new Image(); img.alt = ""; img.decoding = "async"; img.referrerPolicy = "no-referrer";
    img.onload = () => el.classList.add("pic"); img.onerror = () => img.remove(); img.src = url; art.append(img);
  }
  txt.append(h("b", "aspct", c.title || c.artist));
  if (c.artist && c.title) txt.append(h("span", "aspca", c.artist));
  if (c.creator) txt.append(h("span", "aspcm", tr("by {n}", { n: c.creator })));
  el.append(art, txt);
  return [el, () => revoke && revoke()];
}
async function aspireWarn({ key, name, tags, user, card }) {
  const only2b = !tags.size && user.every(n => /2b$/i.test(n)); // (2B alone: a gimmick map, not an Aspire one)
  hideLoading();
  // the look (assets/app.css .v-hazard): a hit circle with "!" that approach circles keep closing in on, the title
  // decoding from noise, the map and the risks. "Don't open" has the focus (Enter / Esc / a click outside: no);
  // "Open anyway" has to be held down (pointer, or Enter / Space on it) for a moment, while the box shakes harder and
  // the screen goes red; letting go early cancels
  const body = h("div", "mdlb aspw"), map1 = h("div", "aspmap");
  const head = h("div", "asphd"), ring = h("div", "aspring"); ring.setAttribute("aria-hidden", "true"); ring.append(h("i"), h("i"), h("b", null, "!"));
  const ttl = h("div", "asptt"), tt = h("h3", "aspt", tr(only2b ? "Gimmick map: unstable here" : "Aspire map: unstable here")); ttl.append(h("span", "aspk", tr("Warning")), tt); head.append(ring, ttl);
  const [cardEl, cardDone] = card && (card.title || card.artist) ? aspireCard(card) : [null, null];
  if (cardEl) { map1.classList.add("hascard"); map1.append(cardEl); } else if (name) map1.append(h("b", null, name));
  const chips = h("div", "aspchips"); for (const t of [...tags].slice(0, 5)) chips.append(h("span", "aspchip", t));
  for (const t of user) { const c = h("span", "aspchip user", t); c.title = tr("Player tag on osu!"); chips.append(c); }
  map1.append(chips);
  const risks = h("ul", "asprisk");
  for (const r of ["It may look wrong", "It may run very slowly, or freeze the page for a while", "Modding may not work on it"]) risks.append(h("li", null, tr(r)));
  body.append(head, map1, h("p", null, tr(only2b ? "Players tagged it 2B: objects placed at the same moment, which osu!'s rules don't allow, so on this site:" : tags.size ? "Its tags say it's an Aspire map. Aspire maps break osu!'s rules on purpose, so on this site:" : "Players tagged it as an Aspire map. Aspire maps break osu!'s rules on purpose, so on this site:")), risks, h("p", "aspq", tr("Open it anyway?")));
  let held = false; const sfx = aspSfx();
  const no = { label: tr("Don't open"), value: false, cls: "main aspno" };
  const okP = modal({ body, dismiss: false, variant: "hazard",
    buttons: [{ label: tr("Hold to open anyway"), value: () => held || undefined, cls: "ghost danger aspgo" }, no] });
  const wrap = body.closest(".mdl"), go = wrap && wrap.querySelector(".aspgo");
  if (wrap) wrap.querySelector(".mdlp").setAttribute("aria-label", tt.textContent);
  if (go) {
    const HOLD = 1100, set = k => wrap.style.setProperty("--hold", k); let t0 = 0, raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / HOLD); set(k.toFixed(3)); sfx.hold(k);
      if (k < 1) { raf = requestAnimationFrame(step); return; }
      held = true; wrap.classList.add("go"); sfx.go(); go.click();
    };
    const start = e => {
      if (t0 || held || (e.type === "keydown" && e.key !== " " && e.key !== "Enter")) return;
      if (e.type === "keydown") e.preventDefault();
      t0 = performance.now(); wrap.classList.add("holding"); raf = requestAnimationFrame(step);
    };
    const stop = () => { if (held || !t0) return; t0 = 0; cancelAnimationFrame(raf); wrap.classList.remove("holding"); set(0); sfx.hold(0); };
    go.addEventListener("pointerdown", e => { try { go.setPointerCapture(e.pointerId); } catch {} start(e); });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture", "keyup", "blur"]) go.addEventListener(ev, stop);
    go.addEventListener("keydown", start); go.addEventListener("contextmenu", e => e.preventDefault());
  }
  if (!RM) { // the title decodes from noise as the box comes in
    const fin = tt.textContent, noise = "!#%&*?/<>[]=+▓▒░", N = 16; let n = 0;
    const iv = setInterval(() => {
      n++; if (n % 2) sfx.tick(); tt.textContent = n >= N ? fin : Array.from(fin, (c, i) => c === " " || i < n / N * fin.length ? c : noise[Math.random() * noise.length | 0]).join("");
      if (n >= N) clearInterval(iv);
    }, 38);
  }
  const fx = !RM && wrap ? aspireFx(wrap, tt) : null;
  const ok = await okP;
  if (fx) fx(); if (cardDone) cardDone();
  if (!ok) sfx.cancel(); else sfx.go(); // (go: already playing when held to the end)
  if (ok) await new Promise(r => setTimeout(r, 280)); // (after the red flash)
  if (!ok || !(await aspireFyi())) return false;
  ASPIRE_OK.add(key);
  return true;
}
// after "Open anyway": a plain heads-up (no sound, the usual dialog) on what playing the map will be like here. "Got it"
// opens it, "Don't open" still backs out (the downloaded copy is dropped then too, see openEntries)
async function aspireFyi() {
  const body = h("div", "mdlb aspfyi");
  const list = h("ul", "aspfyil");
  for (const r of ["Huge sliders are drawn in the background: some show up a moment late, or empty at first.",
    "Sliders under extreme timing finish instantly, and their thousands of repeats sound once.",
    "Objects far outside the playfield aren't drawn.",
    "The first seconds of play may stutter. If the page stops responding, give it a moment: your edits are kept as drafts on this device.",
    "Too slow? Settings → Quality → Battery saver, or turn off Storyboard."]) list.append(h("li", null, tr(r)));
  body.append(h("p", null, tr("Good to know before you press play:")), list);
  // the buttons lean towards no: "Don't open" is the main one (and has the focus), "Open anyway" is faint and can't be
  // pressed for the first seconds (a countdown on it) so the list gets read
  const p = modal({ title: tr("Before you play"), body, icon: "warn", dismiss: false, variant: "fyi",
    buttons: [{ label: tr("Open anyway"), value: true, cls: "ghost fyigo" }, { label: tr("Don't open"), value: false, cls: "main fyino" }] });
  const go = body.closest(".mdl") && body.closest(".mdl").querySelector(".fyigo");
  if (go) {
    const label = go.textContent; let n = 3; go.disabled = true;
    const tick = () => { if (!go.isConnected) return; if (n > 0) { go.textContent = label + " (" + n-- + ")"; setTimeout(tick, 1000); } else { go.textContent = label; go.disabled = false; } };
    tick();
  }
  return !!(await p);
}
async function openEntries(entries, id, want, mode, opts = {}) {
  const sheetBack = () => { if (UI.player.hidden && detailInfo && R.inMap) $("detail").hidden = false; };
  if (!opts.force && !(await edConfirmDiscard())) { hideLoading(); sheetBack(); return; }
  if (LIVE.on && LIVE.host && !(opts.live || LIVE.opening) && !(await ask(tr("Opening another map ends your live session. Continue?"), { ok: tr("Continue"), danger: true }))) { hideLoading(); return; }
  const texts = new Map(), readText = async e => { if (!texts.has(e)) texts.set(e, await e.async("string")); return texts.get(e); }; // (each .osu read once)
  if (!(await aspireAsk(entries, readText, id))) {
    if (id && +id > 0) oszDrop(id); // (downloaded for this: not kept)
    aspireDeclined(); return;
  }
  if (LIVE.on && !(opts.live || LIVE.opening)) liveEnd(true);
  if (COLLAB.on && !(opts.collab || COLLAB.opening)) collabEnd(true);
  draftDetach(); annReset(opts.annotations || []); cloudDetach(opts.cloud || null);
  if (typeof gdAttach === "function") gdAttach(opts.drive || null);
  pausePlayback();
  showLoading(tr("Unpacking…"), -1);
  const skinsP = ensureSkins(); // load skins while the map unpacks
  objURLs.forEach(u => URL.revokeObjectURL(u)); objURLs = [];
  files = {}; imagesFree(); osuFiles = []; osbText = ""; sbTintClear(); SBC.text = SBC.chunk = SBC.pend = null; bodyCache.clear(); heavyClear(); parsedCache.clear(); scaled[0] = scaled[1] = null; setId = id || null; onlineSet = id || null;
  if (!id) curSet = null;
  A.pause(); audio.pause(); A.buf = null; A.bufKey = ""; A.mode = "virt"; songMeta = null;
  for (const p in entries) files[norm(p)] = entries[p];
  let mania = false;
  for (const p in files) {
    if (p.endsWith(".osu")) { const text = await readText(files[p]), meta = quickMeta(text); if (meta.mode === "0") osuFiles.push({ text, meta, path: files[p].name }); else if (meta.mode === "3") mania = true; } // osu!standard only
    else if (p.endsWith(".osb")) osbText = await files[p].async("string");
  }
  if (!osuFiles.length) { hideLoading(); sheetBack(); toast(tr(mania ? "osu!mania isn't supported: this site opens osu!standard difficulties only" : "This package has no osu!standard difficulty"), mania ? 5000 : undefined); return; }
  rateDiffs();
  if (opts.created) osuFiles.forEach(o => o.created = true); // made in the browser: unsaved until exported
  if (opts.ids) osuFiles.forEach(f => { if (Array.isArray(opts.ids[f.path])) f.ids = opts.ids[f.path]; }); // object ids saved with an online project
  draftPkg(opts.live || LIVE.opening ? "live" : opts.collab || COLLAB.opening ? "collab" : opts.cloud ? "cloud" : id ? "set" : opts.created ? "new" : "local", { setId: id, projectId: opts.cloud && opts.cloud.id });
  if (!setId) { const sid = osuFiles.map(o => +o.meta.sid).find(v => v > 0); if (sid) setId = sid; }
  fillDiffSelects();
  await skinsP;
  if (want) {
    const wn = String(want.name || "").trim().toLowerCase();
    let pick = -1;
    if (want.md5 && typeof md5Hex === "function") { // a replay's map: the difficulty whose file has exactly this MD5 (js/replayui.js)
      for (let k = 0; k < osuFiles.length && pick < 0; k++) { const e = files[norm(osuFiles[k].path)]; try { if (e && md5Hex(await e.async("uint8array")) === want.md5) pick = k; } catch {} }
    }
    if (pick < 0) pick = osuFiles.findIndex(o => want.bid && String(o.meta.bid) === String(want.bid));
    if (pick < 0) pick = osuFiles.findIndex(o => o.meta.version.trim().toLowerCase() === wn);
    if (pick < 0) pick = osuFiles.length - 1;
    return enterPack(pick, mode);
  }
  // no choice made yet (local .osz or set without diff info): let the user pick first
  hideLoading();
  const m0 = osuFiles[osuFiles.length - 1].meta;
  let cover = "";
  if (m0.bg && files[norm(m0.bg)]) { try { cover = mkURL(await files[norm(m0.bg)].async("blob")); } catch {} }
  showDetail({
    sid: null, title: m0.title, artist: m0.artist, creator: m0.creator, status: id ? "" : "local", cover,
    len: Math.max(...osuFiles.map(o => o.meta.len)),
    diffs: osuFiles.map((o, i) => ({ idx: i, mode: +o.meta.mode || 0, name: o.meta.version, stars: o.stars > 0 ? o.stars : null, est: o.estStars, cs: o.meta.cs, ar: o.meta.ar, od: o.meta.od, hp: o.meta.hp, len: o.meta.len })),
  }, (d, mode) => enterPack(d.idx, mode));
}
async function enterPack(pick, mode) {
  if (typeof rpStop === "function") rpStop(); // (a map that opens, in Modding too, ends a replay first: setMode(true) is off while one plays)
  $("diff").value = $("diffQuick").value = pick;
  setMode(mode === "mod");
  enterPlayer();
  if (S.hsSrc !== "off") preloadDefaults();
  showLoading(tr("Loading hitsounds…"), -1);
  await Promise.all([loadMapSamples(), ensureSkins()]);
  await selectDiff(pick);
  hideLoading();
  draftAttach();
  setCloud(CLOUD.status, CLOUD.err);
}
async function selectDiff(i) {
  if (typeof rpStop === "function") rpStop(); // (a replay of another map must not play on this one; the replay flow starts its replay after the map is in)
  pausePlayback();
  showLoading(tr("Preparing the map…"), -1);
  curDiff = i; $("diff").value = $("diffQuick").value = i;
  map = parseOsu(osuFiles[i].text);
  adoptIds(osuFiles[i]);
  edReset(); if (osuFiles[i].created || osuFiles[i].edited) EDIT.changed = true;
  const sbNew = await sbLoad(osbText, map); // (a big .osb is read in a worker, once per set)
  if (curDiff !== i) return; // (another difficulty was picked meanwhile: that one carries on)
  sb = sbNew; sbLod(0); // (a new map: the storyboard starts at full detail)
  const paths = new Set(sb.names);
  if (map.bg) paths.add(map.bg);
  let done = 0; const all = [...paths];
  await loadImages(all, new Set(map.bg ? [norm(map.bg)] : []), () => { done++; if (all.length > 20) showLoading(tr("Loading storyboard images {a}/{b}", { a: done, b: all.length }), done / all.length); });
  bgHidden = !!map.bg && sb.uses(norm(map.bg));
  const title = map.meta.TitleUnicode || map.meta.Title || "", artist = map.meta.ArtistUnicode || map.meta.Artist || "";
  $("mTitle").textContent = artist ? `${artist} - ${title}` : title; // (the invite page's demo map has only a title)
  $("mSub").textContent = `[${map.meta.Version || "?"}]` + (map.meta.Creator ? ` · mapped by ${map.meta.Creator}` : ""); edSongSync();
  $("tapInfo").textContent = `${title} [${map.meta.Version || "?"}]${startAt > 0 ? ` · ${tr("starts at {t}", { t: fmtMs(startAt) })}` : ""}`;
  setTitle(`${artist} - ${title} [${map.meta.Version || "?"}]`);
  const songKey = norm(map.general.AudioFilename || ""), af = files[songKey];
  A.pause(); audio.pause(); A.on = false; A.pos = 0; needTapResume = false;
  if (af) {
    if (A.bufKey !== songKey || !A.buf && A.mode !== "el") {
      A.buf = null; A.bufKey = "";
      showLoading(tr("Preparing the song…"), -1);
      const ab = await af.async("arraybuffer");
      songMeta = analyzeAudio(ab);
      try { if (ab.byteLength > (S.btMode ? 150e6 : 30e6)) throw 0; A.buf = await decodeAB(ab.slice(0)); A.bufKey = songKey; } catch { A.buf = null; }
      if (!A.buf) { A.bufKey = songKey; A.src = mkURL(new Blob([ab])); audio.src = A.src; audio.load(); }
    }
    A.mode = A.buf ? "buf" : "el";
  } else { A.mode = "virt"; A.src = ""; audio.removeAttribute("src"); songMeta = null; toast(tr("No song file in this package, playing without sound")); }
  applyVolumes();
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: map.meta.Version || "", artwork: setId ? [{ src: `https://assets.ppy.sh/beatmaps/${setId}/covers/list@2x.jpg`, sizes: "300x300", type: "image/jpeg" }] : [] }); } catch {}
  }
  if (onlineSet && R.inMap) setMapURL(onlineSet, +map.meta.BeatmapID > 0 ? map.meta.BeatmapID : null, false);
  clock.pre = false; lastT = null; dispScore = 0;
  if (EDIT.on) { UI.tapStart.hidden = true; if (startAt > 0) { A.seek(startAt); startAt = 0; } }
  else UI.tapStart.hidden = false;
  UI.skip.hidden = true;
  showUI(); dirty = true; drawTimeline(); renderTools(); updateEdUI();
  if (EDIT.on && EDIT.tab !== "compose") edTab(EDIT.tab);
  if (pendingNotes) setTimeout(applyPendingNotes, 300);
  diffMarks();
  hideLoading();
  const epi = epiWarn(); // (the map's epilepsy warning, when it has one)
  setTimeout(sbglSuggest, epi ? epi + 400 : 400); // (a heavy storyboard on the canvas: offer WebGL, once per device; after the warning)
}
function switchDiff(i, fromLive) { // from the top-bar picker, settings, or the rhythm view
  if (typeof RP !== "undefined" && RP.on) { $("diff").value = $("diffQuick").value = curDiff; return; } // (a replay is watched on its own difficulty)
  if (i === curDiff || !osuFiles[i]) return;
  if (LIVE.on && !LIVE.host && !fromLive) { $("diff").value = $("diffQuick").value = curDiff; return toast(tr("In a live session the host picks the difficulty")); }
  if (COLLAB.on) return collabLeaveForDiff().then(ok => { if (ok) return switchDiffNow(i); $("diff").value = $("diffQuick").value = curDiff; });
  return switchDiffNow(i);
}
const DIFF_NOTED = new Set(); // (the difficulties the "kept, not exported" note was shown for)
function switchDiffNow(i) {
  const f = osuFiles[curDiff], note = map && EDIT.changed && f && !DIFF_NOTED.has(f.path) ? f : null;
  stashDiff(); draftSchedule(); draftFlush(); // (written to the local draft now, not in a second)
  if (note) { DIFF_NOTED.add(note.path); toast(tr("[{d}] is kept in this browser, not saved to a file yet. Export the .osz to save every difficulty.", { d: note.meta.version || "?" }), 6000); }
  closeSheet(); return selectDiff(i).then(() => { if (LIVE.on && LIVE.host) liveSendState(); });
}
function stashDiff() { // keep the open diff's edits when leaving it
  if (!map || !EDIT.changed || !osuFiles[curDiff]) return;
  const f = osuFiles[curDiff]; parsedCache.delete(f.text); f.text = editedText(); f.meta = quickMeta(f.text); f.edited = true;
  f.ids = map.lines.map(L => L.id);
}
// stable object ids per difficulty ([HitObjects] line order): the same ids every time the diff is opened again, in
// drafts and cloud saves. Annotations and collab edits refer to objects by these ids.
function adoptIds(f) { // the diff's saved object ids (drafts, online projects, collab, coming back to a diff)
  if (Array.isArray(f.ids) && f.ids.length === map.lines.length) {
    const to = new Map(); map.lines.forEach((L, k) => { to.set(L.id, f.ids[k]); L.id = f.ids[k]; });
    for (const o of map.hit) if (to.has(o.lid)) o.lid = to.get(o.lid); // (the objects were built with the parser's ids: they follow, or selecting one points at no line)
  } else f.ids = map.lines.map(L => L.id);
}
function refreshDiffSelects() {
  fillDiffSelects();
}
$("diff").onchange = e => switchDiff(+e.target.value);
$("diffQuick").onchange = e => switchDiff(+e.target.value);
$("back").onclick = async () => {
  if (!(await edConfirmDiscard())) return;
  if (typeof rpStop === "function") rpStop();
  if (COLLAB.on) collabEnd(true);
  draftDetach();
  EDIT.changed = false; osuFiles.forEach(o => o.created = o.edited = false);
  exitPlayerUI();
  if (onlineSet && R.inMap) leaveMap();
  else setTitle(R.ctx ? listTitle(R.ctx) : "");
};
{ const ps = playStart; playStart = function (from) { return rpLocked() ? undefined : ps(from); }; } // (watching a replay: no test play; play.js is loaded before this file)
$("shareBtn").onclick = () => { if (!featGuard("ed_share")) return; const u = shareURL(); if (!u && map) return rpLocked() ? toast(tr("This file has no beatmap ID, so it can't be shared as a link")) : cloudShareLocal(); shareLink(u, map ? `${map.meta.Artist} - ${map.meta.Title} [${map.meta.Version}]` : ""); };

// file open & drag-drop
$("pick").onclick = () => $("file").click();
$("homeOpen").onclick = () => { R.intent = ""; $("file").click(); };
$("hubOpen").onclick = () => { R.intent = "edit"; $("file").click(); };
fileAccept($("file"), ".osz,.zip,.osr"); $("file").multiple = true; // (.osr: a replay, alone or with the map's .osz: js/replayui.js)
// files opened or dropped: replays (and a map dropped while a replay waits for its map) go to replayui.js, the rest the way they always did
function openPicked(list, drop) {
  const fs = [...list]; if (!fs.length) return;
  if (fs.some(f => fileIs(f, ["osr"])) || (fs.some(f => fileIs(f, ["osz", "zip", "osu"])) && typeof replayPending === "function" && replayPending())) return loadLazy("replayui").then(() => replayOpenFiles(fs), e => toast(e.message, 4000));
  const f = fs[0];
  if (drop) { if (/\.osk$/i.test(f.name)) importOsk(f); else openZip(f); return; }
  if (!fileIs(f, ["osz", "zip"])) return toast(tr("Pick an .osz file (a beatmap package)"), 3000);
  openZip(f);
}
$("file").onchange = e => { const fs = [...e.target.files]; e.target.value = ""; openPicked(fs, false); };
let dragN = 0;
addEventListener("dragenter", e => { e.preventDefault(); dragN++; $("drop").hidden = false; });
addEventListener("dragleave", () => { if (--dragN <= 0) { dragN = 0; $("drop").hidden = true; } });
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => {
  e.preventDefault(); dragN = 0; $("drop").hidden = true;
  openPicked(e.dataTransfer.files, true);
});

// language switch: re-render the dynamic parts
addEventListener("langchange", () => {
  buildFilters(); showStatus(); renderMapperHead(); advRender();
  if (R.list.length) { const box = $("results"); box.innerHTML = ""; R.list.forEach((s, i) => box.append(card(s, i))); }
  if (!$("detail").hidden && detailInfo && !$("detail").classList.contains("out") && !(dFlight && dFlight.mode === "close")) showDetail(detailInfo, detailOnGo, detailPick && detailPick.bid); // (not while it is closing: it would open again)
  if (R.ctx && UI.player.hidden && R.view === "songs") setTitle(listTitle(R.ctx));
  if (!UI.sheet.hidden) renderSkinUI();
  if (UI.player.hidden && R.view) showView(R.view);
});

// ============ router ============
async function route() {
  seoSync();
  const p = new URLSearchParams(location.search), sid = p.get("s"), bid = p.get("b");
  if (GATE.locked && GATE.guest && !p.has("invite") && (sid || bid || viewFromParams(p) !== "home")) { // a guest leaving the preview page (back button, a link) for a page they may use
    const n = routeNeeds(p); if (!n || n.some(can)) return gateUnlock(false);
  }
  if (GATE.locked && (sid || bid || !GATE_OPEN_VIEWS.has(p.get("view")))) return gateLock(); // invite-only: no access yet (gate.js)
  // permissions (gate.js): a part this visitor can't use opens the access page for guests, the home page for members
  const need = routeNeeds(p);
  if (GATE.guest && !sid && !bid && viewFromParams(p) === "home" && !["live", "collab", "project", "replay", "score"].some(k => p.has(k))) return gateLock(); // guests' home page is the preview page (tour, try the editor, request access)
  if (need && !need.some(can)) {
    if (GATE.guest) return gateLock();
    toast(tr("You don't have access to this part of the site."), 2500);
    history.replaceState(null, "", location.pathname); return route();
  }
  // a part the admins switched off (features.js): back to the home page, for everyone
  // (only once the server has answered: the switches remembered from the last visit alone must not throw a bookmark away)
  if (featFresh && routeFeats(p).some(k => !featOn(k))) { toast(tr("This part of the site is switched off for now."), 2500); history.replaceState(null, "", location.pathname); return route(); }
  if (GATE.welcome && !gateWelcomeWants(p)) gateWelcomeEnd(); // leaving the welcome page for the app (gate.js)
  if (p.get("login")) { const why = p.get("login"), linked = why.match(/^linked_(google)$/), good = why === "ok" || why === "deleted" || !!linked;
    toast(why === "ok" ? tr("Logged in") : why === "deleted" ? tr("Your account was deleted. Thanks for using beatmap viewer.") : linked ? tr("{p} account linked: if osu!'s login ever doesn't work, you can log in with it", { p: "Google" }) : tr("Login failed: {err}", { err: loginWhy(why) }), good ? 4500 : 7000); p.delete("login"); history.replaceState(history.state, "", location.pathname + (p.toString() ? "?" + p : "")); }
  if (!sid && !bid) {
    const leaving = R.leaving; R.leaving = false;
    // back while a map is still loading: stop it (it would open later over the list, on the list's URL)
    if (UI.player.hidden && (dlId || routeCtl)) { dlCtl && dlCtl.abort(); routeCtl && routeCtl.abort(); dlId = null; hideLoading(); }
    const edited = EDIT.changed || osuFiles.some(o => o.created || o.edited);
    if (!UI.player.hidden && (edited || !leaving) && !(LIVE.on && !LIVE.host)) {
      // leaving the open map: unsaved edits always ask (as before); without edits, a back that isn't the site's own (on
      // iPhone: Safari's swipe from the left edge, easy to start by accident next to the editor's tools) asks too.
      // The map's page goes back on top meanwhile; leaving goes back to where it was headed
      history.pushState({ map: 1 }, "", NAV.before); R.inMap = R.mapPushed = !!new URLSearchParams(new URL(NAV.here).search).get("s");
      const go = edited ? await edConfirmDiscard() : await ask(tr("Leave this map?"), { ok: tr("Leave"), cancel: tr("Stay") });
      if (go) { R.leaving = true; history.back(); }
      return;
    }
    R.inMap = false; R.mapPushed = false;
    hideDetail(viewFromParams(p) === "songs" && R.view === "songs" && ctxKey(ctxFromParams(p)) === R.key); // (back to the same list: the panel shrinks into its card; the list changing under it: at once)
    if (typeof replayClose === "function") replayClose(); // (the results screen and the end menu of a replay)
    if (!UI.player.hidden) { if (typeof rpStop === "function") rpStop(); if (COLLAB.on) collabEnd(true); draftDetach(); EDIT.changed = false; osuFiles.forEach(o => o.created = o.edited = false); exitPlayerUI(); }
    if (gateWelcomeWants(p)) return gateWelcome(); // not logged in, on an open site: the home page is the welcome page (gate.js)
    const v = viewFromParams(p);
    R.intent = p.get("for") === "edit" ? "edit" : "";
    R.listURL = location.pathname + location.search;
    showView(v);
    if (v === "songs") {
      const ctx = ctxFromParams(p);
      syncSearchUI(ctx);
      if (ctxKey(ctx) !== R.key) loadList(ctx);
      else if (Date.now() - (R.loadedAt || 0) > 600000) refreshList(); // back after 10+ minutes: pick up new maps
      else setTitle(listTitle(ctx));
    }
    if (p.get("live")) liveJoinPrompt(p.get("live"), p.get("lt") || "");
    if (p.get("collab")) collabJoinPrompt(p.get("collab"), p.get("nt") === "1");
    if (p.get("project") && /^[0-9a-f-]{36}$/.test(p.get("project"))) cloudOpenProject(p.get("project"), { key: p.get("key") || "", t: Math.max(0, +p.get("t") || 0) });
    if (/^\d{1,12}$/.test(p.get("score") || "")) { // a link to an osu! score (a replay shared that was fetched from osu!, replayui.js rpuPasteScore): nothing is stored for it here
      const sc = p.get("score"); history.replaceState(history.state, "", location.pathname);
      loadLazy("replayui").then(() => rpuPasteScore(sc), e => toast(e.message, 4000));
    }
    if (p.get("replay")) { // a shared replay (replayui.js replayOpenShared): the key leaves the address bar and the history entry at once
      const rid = p.get("replay"), rk = p.get("key") || ""; history.replaceState(history.state, "", location.pathname);
      loadLazy("replayui").then(() => replayOpenShared(rid, rk), e => toast(e.message, 4000));
    }
    return;
  }
  // a beatmap link
  R.leaving = false; R.inMap = true; R.mapPushed = !!(history.state && history.state.map); R.lastMapURL = location.href;
  if (R.view === null) { showView("songs"); syncSearchUI({ q: "", u: "", st: defSt() }); loadList({ q: "", u: "", st: defSt() }); } // something behind the sheet
  if (!UI.player.hidden && onlineSet && String(onlineSet) === String(sid)) return;
  if (!$("detail").hidden && detailInfo && String(detailInfo.sid) === String(sid)) return;
  if (UI.player.hidden && dlId && String(dlId) === String(sid)) return; // (already downloading: a late route() mustn't bring its sheet back)
  startAt = Math.max(0, +p.get("t") || 0);
  { const hn = location.hash.match(/[#&]n=([\w.-]+)/), nu = p.get("notes"); if (hn || nu) pendingNotes = { hash: hn && hn[1], url: nu }; }
  const wantMode = p.get("mode") === "mod" && can("editor") ? "mod" : "preview";
  routeCtl && routeCtl.abort(); routeCtl = new AbortController(); const sig = routeCtl.signal;
  showLoading(tr("Loading map info…"), -1);
  R.intent = R.intent || (wantMode === "mod" ? "edit" : "");
  let id = sid;
  try {
    if (!id) id = await lookupBeatmap(bid, sig);
    const s = id ? await lookupSet(id, sig) : null;
    if (sig.aborted) return;
    hideLoading();
    if (s) {
      openSet(s, bid, true);
      if (startAt > 0 || wantMode === "mod") { const d = detailPick; hideDetail(); download(s.id, d, wantMode); } // deep link with a time / mod mode goes straight in
    } else if (id) { hideDetail(); download(id, bid ? { bid } : null, wantMode); }
    else { toast(tr("This beatmap wasn't found on the mirrors")); leaveMap(); }
  } catch (e) {
    if (sig.aborted) return;
    hideLoading();
    if (id) download(id, bid ? { bid } : null, wantMode); else { toast(tr("Couldn't load the map info: {err}", { err: e.message })); leaveMap(); }
  }
}
addEventListener("popstate", route);
// which permission areas a URL needs (any one of them), null = none
// the feature switches a URL needs (all must be on)
function routeFeats(p) {
  if (p.get("live")) return ["live"];
  if (p.get("collab")) return ["collab"];
  if (p.get("project")) return ["projects"];
  if (p.get("replay") || p.get("score")) return ["replays"];
  if (p.get("s") || p.get("b")) return p.get("mode") === "mod" ? ["editor"] : ["preview"];
  const v = viewFromParams(p);
  return v === "songs" ? [p.get("u") ? "mappers" : "songs"] : v === "editor" ? ["editor"] : v === "create" ? ["create", "editor"] : v === "projects" ? ["projects"] : v === "replays" ? ["preview", "replays"] : [];
}
function routeNeeds(p) {
  if (p.get("live")) return ["online", "live"]; // guests may be allowed to watch
  if (p.get("score")) return ["player"]; // (a link to an osu! score: nothing is stored for it here)
  if (p.get("collab") || p.get("project") || p.get("replay")) return ["online"];
  if (p.get("s") || p.get("b")) return p.get("mode") === "mod" && can("editor") ? ["editor"] : ["player", "listing"];
  const v = viewFromParams(p);
  return v === "songs" ? (p.get("u") ? ["mappers"] : ["listing"]) : v === "editor" || v === "create" ? ["editor"] : v === "projects" || v === "invite" ? ["online"] : v === "replays" ? ["player"] : null;
}
// the first route() runs at the end of pages.js, once every script is loaded

$("refreshList").onclick = () => { refreshList(); toast(tr("Loading the newest list…"), 1500); };

// ---------- install as an app (sw.js: the site opens without a connection; maps you downloaded stay in this browser) ----------
let installPrompt = null;
const appInstalled = () => DEV.standalone; // (display-mode: standalone, or iOS navigator.standalone: device.js)
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && !DEMO_TOUR)
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; if (typeof renderAccount === "function") renderAccount(); });
addEventListener("appinstalled", () => { installPrompt = null; toast(tr("Installed: open beatmap viewer from your home screen or apps"), 3500); if (typeof renderAccount === "function") renderAccount(); });
// the button in the account menu and on the Guide page: the browser's own install dialog, or how to do it on iPhone / iPad
function installButton(cls) {
  if (appInstalled() || (!installPrompt && !isIOS())) return null;
  const b = h("button", cls || "btn ghost sm wide", "⤓ " + tr("Install as an app"));
  b.onclick = async () => {
    if (installPrompt) { installPrompt.prompt(); try { await installPrompt.userChoice; } catch {} installPrompt = null; if (typeof renderAccount === "function") renderAccount(); return; }
    modal({ title: tr("Install as an app"), body: h("p", null, DEV.browser === "safari" ? tr("In Safari, tap Share (the square with an arrow), then \"Add to Home Screen\".") : tr("Tap Share (the square with an arrow, in the address bar or the browser's menu), then \"Add to Home Screen\".")), buttons: [{ label: tr("OK"), value: true, cls: "main" }] }); // (Chrome, Edge and Firefox on iPhone / iPad have it too, since iOS 16.4)
  };
  return b;
}
