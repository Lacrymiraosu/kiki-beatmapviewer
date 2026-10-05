"use strict";
// ============ loading overlay ============
function showLoading(text, p) {
  $("loading").hidden = false; $("loadText").textContent = text;
  const ring = $("ring");
  if (p < 0) ring.classList.add("spin");
  else { ring.classList.remove("spin"); $("ringP").style.strokeDashoffset = 264 * (1 - clamp01(p)); }
}
const hideLoading = () => $("loading").hidden = true;

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
const VIEW_EL = { home: "homeView", songs: "select", editor: "edhub", create: "create", credits: "page", privacy: "page", changelog: "page", guide: "page", projects: "projects", admin: "admin", invite: "invite", account: "account" };
const VIEW_TITLE = { guide: "Guide", editor: "Editor", create: "Create a new beatmap", credits: "Credits", privacy: "Privacy", changelog: "Changelog", projects: "My online projects", admin: "Admin", invite: "Invite friends", account: "Account settings" };
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
  if (v === "admin") renderAdmin();
  if (v === "invite") renderInvite();
  if (v === "account") renderAccountPage();
}
function goView(v, extra) {
  const p = new URLSearchParams(extra || {}); if (v !== "home") p.set("view", v);
  const s = p.toString(); history.pushState(null, "", location.pathname + (s ? "?" + s : ""));
  route(); scrollTo(0, 0);
}
document.addEventListener("click", e => { // <a data-go="view"> links inside the site
  const a = e.target.closest("[data-go]"); if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
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
function leaveMap() {
  if (!R.inMap) return;
  R.inMap = false;
  if (R.mapPushed) { R.mapPushed = false; history.back(); }
  else { history.replaceState(null, "", R.listURL); route(); }
}
const listTitle = ctx => ctx.u ? `${ctx.u} (mapper)` : ctx.q ? tr("Search \"{q}\"", { q: ctx.q }) : "";

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
    b.onclick = () => goList({ ...(R.ctx || { q: "", u: "" }), st }, false);
    $("filters").append(b);
  }
  if (typeof advChip === "function" && !(R.ctx && R.ctx.u)) $("filters").append(advChip());
  if (R.ctx) syncSearchUI(R.ctx);
}
buildFilters();
function syncSearchUI(ctx) {
  document.querySelectorAll("#filters .chip").forEach(b => { const on = b.dataset.st === ctx.st; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  const q = $("q"); if (document.activeElement !== q) q.value = ctx.u ? `mapper:${ctx.u}` : ctx.q;
}
function goList(ctx, push) {
  history[push ? "pushState" : "replaceState"](null, "", listURL(ctx));
  route();
}
function goMapper(name) {
  const url = listURL({ u: name, q: "", st: "" });
  if (R.inMap) { hideDetail(); R.inMap = false; R.mapPushed = false; history.replaceState(null, "", url); }
  else history.pushState(null, "", url);
  route();
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
  if ((m = q.match(/[?&]s=(\d+)/))) return { s: m[1], b: (q.match(/[?&]b=(\d+)/) || [])[1] };
  if ((m = q.match(/beatmapsets\/(\d+)(?:#\w+\/(\d+))?/))) return { s: m[1], b: m[2] };
  if ((m = q.match(/(?:\/b\/|\/beatmaps\/)(\d+)/))) return { b: m[1] };
  if ((m = q.match(/\/s\/(\d+)/)) || (m = q.match(/^(\d+)$/))) return { s: m[1] };
  if ((m = q.match(/\/users?\/([^/?#\s]+)/))) return /^\d+$/.test(m[1]) ? { err: tr("Type the mapper's name instead of a user ID, e.g. mapper:Sotarks") } : { u: decodeURIComponent(m[1]) };
  if ((m = q.match(/^(?:mapper|creator|u)\s*[:=]\s*(.+)$/i))) return { u: m[1].trim().replace(/^"|"$/g, "") };
  return { q };
}
$("searchForm").onsubmit = e => {
  e.preventDefault(); $("q").blur();
  const r = parseQuery($("q").value);
  if (r.err) return toast(r.err);
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
  const fn = ctx.u ? 0 : fCount(ctx.f);
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
      if (fNeedsOsu(ctx.f)) toast(tr("Tag filters and sorting need the osu! connection; showing mirror results filtered here"), 4000);
    }
  }
  try {
    const r = await searchSets({ q: ctx.q, creator: ctx.u, st: ctx.st, page: R.page }, sig, R.mirror);
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
  if (!can("mappers")) return h("span", null, name); // mapper pages are off for this visitor (Admin → Permissions)
  const a = h("a", cls, name); a.href = listURL({ u: name, q: "", st: "" });
  a.onclick = e => { e.preventDefault(); e.stopPropagation(); goMapper(name); };
  return a;
}
function card(s, i) {
  const c = h("article", "card"); c.style.setProperty("--i", Math.min(i, 12));
  const bg = `https://assets.ppy.sh/beatmaps/${s.id}/covers/${(devicePixelRatio || 1) > 1.4 ? "card@2x" : "card"}.jpg`;
  if (cardIO) { c.dataset.bg = bg; cardIO.observe(c); } else c.style.backgroundImage = `url("${bg}")`;
  const main = h("button", "cmain"); main.setAttribute("aria-label", `${s.artist} - ${s.title} (${s.creator})`);
  main.onclick = () => openSet(s);
  const ci = h("div", "ci"), sm = h("small");
  sm.append(avatarEl(s.uid, s.creator), "mapped by ", mapperLink(s.creator));
  ci.append(h("b", null, s.title), h("span", null, s.artist), sm);
  const tags = h("div", "tags");
  if (s.status) tags.append(h("em", "st-" + s.status, s.status));
  if (s.stars.length) tags.append(h("em", null, `★ ${Math.min(...s.stars).toFixed(1)}${s.stars.length > 1 ? "–" + Math.max(...s.stars).toFixed(1) : ""}`));
  if (s.diffs.length) {
    const dots = h("span", "dots");
    s.diffs.slice(0, 14).forEach(d => { const i = h("i"); i.style.background = starColor(d.stars); dots.append(i); });
    tags.append(dots);
  }
  ci.append(tags);
  const act = h("div", "cact"), dl = h("a", "cbtn"), pv = h("button", "cbtn cplay");
  pv.innerHTML = playIcon; pv.title = tr("Listen to the preview"); pv.setAttribute("aria-label", pv.title);
  pv.onclick = e => { e.stopPropagation(); togglePreview(`https://b.ppy.sh/preview/${s.id}.mp3`, c); };
  dl.href = osuDlURL(s.id); dl.target = "_blank"; dl.rel = "noopener"; dl.innerHTML = dlIcon;
  dl.title = tr("Download from osu! (opens osu.ppy.sh)"); dl.setAttribute("aria-label", dl.title);
  dl.onclick = e => e.stopPropagation();
  act.append(pv, dl);
  c.append(main, ci, act, h("i", "cprog"));
  if (pvOwner && pvOwner.sid === s.id && !prevAudio.paused) setPvOwner(c);
  c.sid = s.id;
  return c;
}

// ---------- song previews (b.ppy.sh), playable straight from the cards and the detail panel ----------
const playIcon = `<svg viewBox="0 0 24 24"><path class="pi" d="M8 5l11 7-11 7z"/><path class="pa" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;
let pvOwner = null, pvRaf = 0;
function setPvOwner(o) {
  if (pvOwner && pvOwner.classList) { pvOwner.classList.remove("playing"); pvOwner.style.removeProperty("--pp"); }
  pvOwner = o; if (o && o.classList) o.classList.add("playing");
  $("dPrev").textContent = tr(o === "detail" ? "❚❚ Stop" : "▶ Listen");
}
function togglePreview(url, owner) {
  if (pvOwner === owner && !prevAudio.paused) { pausePreview(); return; }
  ensureAudioCtx();
  prevAudio.src = url; prevAudio.currentTime = 0; prevAudio.volume = musGain();
  setPvOwner(owner);
  prevAudio.play().catch(() => { toast(tr("Couldn't play the preview")); setPvOwner(null); });
}
function pausePreview() { prevAudio.pause(); }
function pvTick() { // progress bar on the playing card
  cancelAnimationFrame(pvRaf);
  if (prevAudio.paused || !pvOwner || !pvOwner.style) return;
  pvOwner.style.setProperty("--pp", (prevAudio.currentTime / (prevAudio.duration || 10) * 100).toFixed(2) + "%");
  pvRaf = requestAnimationFrame(pvTick);
}
prevAudio.addEventListener("play", pvTick);
prevAudio.addEventListener("pause", () => setPvOwner(null));
prevAudio.addEventListener("ended", () => setPvOwner(null));

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
  const share = h("button", "btn ghost sm", tr("Share this page")); share.onclick = () => shareLink(location.origin + listURL({ u: name, q: "", st: ctx.st }), `${name} · KIKI BEATMAP VIEWER`);
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
let detailInfo = null, detailPick = null, detailOnGo = null, detailBid = null;
function starColor(s) {
  if (s == null) return "#8a7fa3";
  const stops = [[0, "#4290fb"], [2, "#4fc0ff"], [2.5, "#4fffd5"], [3.3, "#7cff4f"], [4.2, "#f6f05c"], [4.9, "#ff8068"], [5.8, "#ff4e6f"], [6.7, "#c645b8"], [7.7, "#6563de"], [9, "#18158e"]];
  let c = stops[0][1]; for (const [v, col] of stops) if (s >= v) c = col; return c;
}
function detailFromSet(s) {
  return { sid: s.id, title: s.title, artist: s.artist, creator: s.creator, status: s.status, bpm: s.bpm, len: s.len, plays: s.plays, favs: s.favs, source: s.source,
    cover: `https://assets.ppy.sh/beatmaps/${s.id}/covers/cover@2x.jpg`, fallbackCover: `https://assets.ppy.sh/beatmaps/${s.id}/covers/card@2x.jpg`,
    preview: `https://b.ppy.sh/preview/${s.id}.mp3`, diffs: s.diffs, video: s.video, storyboard: s.storyboard, genre: s.genre, language: s.language, tags: s.tags, nsfw: s.nsfw };
}
function openSet(s, bid, noPush) {
  curSet = s;
  showDetail(detailFromSet(s), (d, mode) => download(s.id, d, mode), bid);
  setMapURL(s.id, detailPick && detailPick.bid, !noPush);
  setTitle(`${s.artist} - ${s.title}`);
}
function showDetail(info, onGo, bid) {
  detailInfo = info; detailOnGo = onGo; detailPick = null; detailBid = bid;
  loadJSZip().catch(() => {}); // warm up, the user will probably open it
  $("dCover").style.backgroundImage = info.cover ? `url("${info.cover}")${info.fallbackCover ? `, url("${info.fallbackCover}")` : ""}` : "none";
  $("dTitle").textContent = info.title || "?";
  $("dArtist").textContent = info.artist || "";
  const dm = $("dMapper"); dm.innerHTML = "";
  if (info.creator) { dm.append("mapped by "); dm.append(info.sid ? mapperLink(info.creator) : info.creator); }
  const chips = $("dChips"); chips.innerHTML = "";
  const chip = (txt, cls) => chips.append(h("em", cls, txt));
  if (info.status) chip(info.status === "local" ? tr("Local file") : info.status, "st-" + info.status);
  if (info.bpm) chip(`${Math.round(info.bpm)} BPM`);
  if (info.len) chip(fmt(info.len));
  if (info.diffs.length) chip(`${info.diffs.length} diff`);
  if (info.plays) chip(`▶ ${fmtInt(info.plays)}`);
  if (info.favs) chip(`♥ ${fmtInt(info.favs)}`);
  if (info.storyboard) chip("storyboard");
  if (info.video) chip("video");
  if (info.source) chip(info.source);
  if (typeof renderSetMeta === "function") renderSetMeta($("dMeta"), info);
  // actions
  const keepPv = pvOwner && pvOwner !== "detail" && !prevAudio.paused && info.preview && prevAudio.src === info.preview;
  if (keepPv) setPvOwner("detail"); else pausePreview(); // the card's preview keeps playing into its detail
  const pb = $("dPrev"); pb.hidden = !info.preview; pb.textContent = tr(pvOwner === "detail" ? "❚❚ Stop" : "▶ Listen");
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
  if (!info.diffs.length) { list.innerHTML = `<div class="dempty">${esc(tr("The mirror didn't send the difficulty list; you can pick one after the map loads"))}</div>`; $("dGo").textContent = tr("Load map"); }
  info.diffs.forEach((d, i) => {
    const r = h("button", "drow"); r.style.setProperty("--i", Math.min(i, 16));
    const st = h("span", "star", d.stars != null ? `${d.est ? "≈" : ""}★ ${d.stars.toFixed(2)}` : `#${i + 1}`);
    if (d.est) st.title = tr("Estimated star rating (this difficulty isn't on osu!)");
    st.style.background = starColor(d.stars); st.style.color = d.stars != null && d.stars >= 6.7 ? "#fff" : "#1c1726";
    const nm = h("span", "dname"), sm = h("small");
    nm.append(h("b", null, d.name + (d.guest ? ` (${d.guest})` : "")), sm);
    for (const [k, v] of [["CS", d.cs], ["AR", d.ar], ["OD", d.od], ["HP", d.hp]]) sm.append(h("span", null, `${k} ${fmtNum(v)}`));
    if (d.len) sm.append(h("span", null, fmt(d.len)));
    if (d.circles != null) sm.append(h("span", null, `${d.circles}○ ${d.sliders}〰 ${d.spinners}◎`));
    if (d.combo) sm.append(h("span", null, `${d.combo}x`));
    r.append(st, nm);
    r.onclick = () => pickDiff(i);
    r.ondblclick = () => { pickDiff(i); $("dGo").click(); };
    list.append(r);
  });
  if (info.diffs.length) {
    let i = info.diffs.length - 1;
    if (bid) { const j = info.diffs.findIndex(d => String(d.bid) === String(bid)); if (j >= 0) i = j; }
    pickDiff(i, true);
  }
  $("detail").hidden = false;
  $("dBody").scrollTop = 0;
  $("dGo").focus({ preventScroll: true });
}
function pickDiff(i, silent) {
  detailPick = detailInfo.diffs[i];
  $("dList").querySelectorAll(".drow").forEach((r, j) => r.classList.toggle("on", j === i));
  $("dGo").textContent = tr("Preview: {d}", { d: detailPick.name });
  if (detailInfo.osuLink) detailInfo.osuLink.href = osuSetURL(detailInfo.sid, detailPick.bid);
  if (!silent) { $("dList").children[i].scrollIntoView({ block: "nearest", behavior: "smooth" }); if (detailInfo.sid && R.inMap) setMapURL(detailInfo.sid, detailPick.bid, false); }
}
function hideDetail() { if (!$("detail").hidden) $("detail").hidden = true; if (pvOwner === "detail") pausePreview(); }
function closeDetail() { hideDetail(); if (detailInfo && detailInfo.sid && UI.player.hidden) leaveMap(); }
$("dClose").onclick = closeDetail;
$("detail").addEventListener("pointerdown", e => { if (e.target.id === "detail") closeDetail(); });
const goDetail = mode => { const d = detailPick, go = detailOnGo; hideDetail(); go && go(d, mode); };
$("dGo").onclick = () => goDetail("preview");
$("dEdit").onclick = () => goDetail("mod");
$("dVol").append(volControl());
// swipe the sheet down to close (phones)
(() => {
  const pnl = $("dPanel"); let y0 = null, dy = 0, cap = false;
  const start = e => { if (innerWidth > 560 || $("dBody").scrollTop > 0 || e.target.closest("button,a")) return; y0 = e.clientY; dy = 0; cap = false; pnl.style.transition = "none"; };
  const move = e => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    if (!cap && dy > 8) { cap = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch {} }
    pnl.style.transform = `translateY(${dy}px)`;
  };
  const end = () => { if (y0 == null) return; y0 = null; pnl.style.transition = ""; pnl.style.transform = ""; if (dy > 110) closeDetail(); };
  for (const el of [$("dGrab"), $("dCover")]) { el.addEventListener("pointerdown", start); el.addEventListener("pointermove", move); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end); }
})();

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
async function oszGet(id) { try { return (await idbTx("osz", "readonly", s => s.get(+id))) || null; } catch { return null; } }
async function oszPut(id, blob, updated) {
  try { await idbTx("osz", "readwrite", s => s.put({ id: +id, blob, size: blob.size, updated: updated || "", savedAt: Date.now(), usedAt: Date.now() })); await oszTrim(); } catch {}
}
async function oszList() { try { return (await idbTx("osz", "readonly", s => s.getAll())) || []; } catch { return []; } } // (the blobs stay on disk until read)
async function oszTrim() {
  const all = (await oszList()).sort((a, b) => b.usedAt - a.usedAt); let total = 0;
  const drop = all.filter((r, i) => (total += r.size) > OSZ_MAX || i >= OSZ_COUNT).map(r => r.id);
  if (drop.length) await idbTx("osz", "readwrite", s => { for (const id of drop) s.delete(id); });
}
// a newer version on osu! than the kept copy? (the set's last update after the copy's, or after it was kept)
function oszOutdated(rec, id) {
  const upd = curSet && +curSet.id === +id ? Date.parse(curSet.updated || "") : NaN;
  return isFinite(upd) && upd > (Date.parse(rec.updated || "") || rec.savedAt) + 1000;
}
async function oszOpen(rec, id, want, mode) { // -> true when the kept copy opened
  try {
    showLoading(tr("Unpacking…"), -1);
    const zip = await (await loadJSZip()).loadAsync(rec.blob);
    rec.usedAt = Date.now(); idbTx("osz", "readwrite", s => s.put(rec)).catch(() => {});
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
async function download(id, want, mode) {
  dlCtl && dlCtl.abort(); const ctl = dlCtl = new AbortController(), sig = ctl.signal;
  const kept = await oszGet(id);
  if (sig.aborted) return;
  if (kept) {
    const busy = (typeof LIVE !== "undefined" && LIVE.opening) || (typeof COLLAB !== "undefined" && COLLAB.opening); // joining: always the newest
    const outdated = oszOutdated(kept, id);
    const useKept = !outdated || (!busy && !(await ask(tr("This beatmap was updated on osu! ({date}) after you downloaded it.\n\nDownload the new version?", { date: fmtDate(curSet.updated, false) }), { title: tr("Newer version on osu!"), ok: tr("Download the new version"), cancel: tr("Open my copy") })));
    if (useKept && await oszOpen(kept, id, want, mode)) return;
    if (sig.aborted) return;
  }
  const order = orderedMirrors();
  for (let i = 0; i < order.length; i++) {
    const mi = order[i], one = dlOne = new AbortController(), kill = () => one.abort();
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
      $("nextMirror").hidden = true;
      oszPut(id, blob, curSet && +curSet.id === +id ? curSet.updated : ""); // keep it: no download next time
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
  hideLoadingDl();
  if (UI.player.hidden && detailInfo) $("detail").hidden = false;
  // new / pending / graveyard maps often aren't on any mirror: get the .osz from osu! and open it here
  if ((await ask(tr("None of the mirrors has map #{id} (new, pending and some graveyard maps can take a while to reach them).\n\nDownload it from osu! (opens osu.ppy.sh, login needed) and then open the .osz here?", { id }), { title: tr("Not on the mirrors yet"), ok: tr("Open osu!") }))) {
    open(osuDlURL(id), "_blank", "noopener");
    toast(tr("When the download finishes, drop the .osz on this page or press \"Open .osz file\""), 7000);
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
function fillDiffSelects() {
  for (const sel of [$("diff"), $("diffQuick")]) { sel.innerHTML = ""; osuFiles.forEach((o, i) => sel.add(new Option(diffLabel(o), i))); sel.value = curDiff; }
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
async function aspireAsk(entries, read) {
  const tags = new Set(); let key = "", name = "";
  for (const p in entries) {
    if (entries[p].dir || !norm(p).endsWith(".osu")) continue;
    let t; try { t = await read(entries[p]); } catch { continue; }
    const end = t.indexOf("[HitObjects]"), head = end < 0 ? t.slice(0, 200000) : t.slice(0, end); // (the metadata comes before the objects)
    const g = k => ((head.match(new RegExp("^" + k + "[ \\t]*:[ \\t]*(.*)$", "m")) || [])[1] || "").trim(); // (not \s: an empty "Source:" would take the next line)
    for (const w of (g("Tags") + " " + g("Source")).split(/\s+/)) if (/aspire/i.test(w)) tags.add(w.toLowerCase());
    if (!key) { key = +g("BeatmapSetID") > 0 ? "s" + g("BeatmapSetID") : g("Title") + "|" + g("Creator"); name = [g("Artist"), g("Title")].filter(Boolean).join(" - "); }
  }
  if (!tags.size || ASPIRE_OK.has(key)) return true;
  hideLoading();
  const body = h("div", "mdlb aspw"), map1 = h("div", "aspmap");
  if (name) map1.append(h("b", null, name));
  const chips = h("div", "aspchips"); for (const t of [...tags].slice(0, 5)) chips.append(h("span", "aspchip", t)); map1.append(chips);
  const risks = h("ul", "asprisk");
  for (const r of ["It may look wrong", "It may run very slowly, or freeze the page for a while", "Modding may not work on it"]) risks.append(h("li", null, tr(r)));
  body.append(map1, h("p", null, tr("Its tags say it's an Aspire map. Aspire maps break osu!'s rules on purpose, so on this site:")), risks, h("p", "aspq", tr("Open it anyway?")));
  const no = { label: tr("Don't open"), value: false, cls: "main" };
  const ok = await modal({ title: tr("Aspire map: unstable here"), body, icon: "warn", dismiss: false,
    buttons: [{ label: tr("Open anyway"), value: true, cls: "ghost danger aspgo" }, no] });
  if (ok) ASPIRE_OK.add(key);
  return !!ok;
}
async function openEntries(entries, id, want, mode, opts = {}) {
  if (!opts.force && !(await edConfirmDiscard())) { hideLoading(); return; }
  if (LIVE.on && LIVE.host && !(opts.live || LIVE.opening) && !(await ask(tr("Opening another map ends your live session. Continue?"), { ok: tr("Continue"), danger: true }))) { hideLoading(); return; }
  const texts = new Map(), readText = async e => { if (!texts.has(e)) texts.set(e, await e.async("string")); return texts.get(e); }; // (each .osu read once)
  if (!(await aspireAsk(entries, readText))) {
    hideLoading();
    if (LIVE.on && LIVE.opening) liveEnd(true, tr("You left the live session"));
    if (COLLAB.on && COLLAB.opening) collabEnd(true, tr("You left the collab session"));
    return;
  }
  if (LIVE.on && !(opts.live || LIVE.opening)) liveEnd(true);
  if (COLLAB.on && !(opts.collab || COLLAB.opening)) collabEnd(true);
  draftDetach(); annReset(opts.annotations || []); cloudDetach(opts.cloud || null);
  if (typeof gdAttach === "function") gdAttach(opts.drive || null);
  pausePlayback();
  showLoading(tr("Unpacking…"), -1);
  const skinsP = ensureSkins(); // load skins while the map unpacks
  objURLs.forEach(u => URL.revokeObjectURL(u)); objURLs = [];
  files = {}; images = {}; osuFiles = []; osbText = ""; sbTint.clear(); bodyCache.clear(); heavyClear(); parsedCache.clear(); scaled[0] = scaled[1] = null; setId = id || null; onlineSet = id || null;
  if (!id) curSet = null;
  A.pause(); audio.pause(); A.buf = null; A.bufKey = ""; A.mode = "virt"; songMeta = null;
  for (const p in entries) files[norm(p)] = entries[p];
  let mania = false;
  for (const p in files) {
    if (p.endsWith(".osu")) { const text = await readText(files[p]), meta = quickMeta(text); if (meta.mode === "0") osuFiles.push({ text, meta, path: files[p].name }); else if (meta.mode === "3") mania = true; } // osu!standard only
    else if (p.endsWith(".osb")) osbText = await files[p].async("string");
  }
  if (!osuFiles.length) { hideLoading(); toast(tr(mania ? "osu!mania isn't supported: this site opens osu!standard difficulties only" : "This package has no osu!standard difficulty"), mania ? 5000 : undefined); return; }
  rateDiffs();
  if (opts.created) osuFiles.forEach(o => o.created = true); // made in the browser: unsaved until exported
  if (opts.ids) osuFiles.forEach(f => { if (Array.isArray(opts.ids[f.path])) f.ids = opts.ids[f.path]; }); // object ids saved with an online project
  draftPkg(opts.live || LIVE.opening ? "live" : opts.collab || COLLAB.opening ? "collab" : opts.cloud ? "cloud" : id ? "set" : opts.created ? "new" : "local", { setId: id, projectId: opts.cloud && opts.cloud.id });
  if (!setId) { const sid = osuFiles.map(o => +o.meta.sid).find(v => v > 0); if (sid) setId = sid; }
  fillDiffSelects();
  await skinsP;
  if (want) {
    const wn = String(want.name || "").trim().toLowerCase();
    let pick = osuFiles.findIndex(o => want.bid && String(o.meta.bid) === String(want.bid));
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
  pausePlayback();
  showLoading(tr("Preparing the map…"), -1);
  curDiff = i; $("diff").value = $("diffQuick").value = i;
  map = parseOsu(osuFiles[i].text);
  adoptIds(osuFiles[i]);
  edReset(); if (osuFiles[i].created || osuFiles[i].edited) EDIT.changed = true;
  sb = parseStoryboard((osbText ? osbText + "\n" : "") + "[Events]\n" + map.eventsRaw, map.vars);
  const paths = new Set(sb.flatMap(s => s.frames));
  if (map.bg) paths.add(map.bg);
  let done = 0; const all = [...paths];
  await Promise.all(all.map(async p => { await loadImage(p); done++; if (all.length > 20) showLoading(tr("Loading storyboard images {a}/{b}", { a: done, b: all.length }), done / all.length); }));
  bgHidden = !!map.bg && sb.some(s => s.frames.includes(norm(map.bg)));
  const title = map.meta.TitleUnicode || map.meta.Title || "", artist = map.meta.ArtistUnicode || map.meta.Artist || "";
  $("mTitle").textContent = artist ? `${artist} - ${title}` : title; // (the invite page's demo map has only a title)
  $("mSub").textContent = `[${map.meta.Version || "?"}]` + (map.meta.Creator ? ` · mapped by ${map.meta.Creator}` : "");
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
  hideLoading();
}
function switchDiff(i, fromLive) { // from the top-bar picker, settings, or the rhythm view
  if (i === curDiff || !osuFiles[i]) return;
  if (LIVE.on && !LIVE.host && !fromLive) { $("diff").value = $("diffQuick").value = curDiff; return toast(tr("In a live session the host picks the difficulty")); }
  if (COLLAB.on) return collabLeaveForDiff().then(ok => { if (ok) return switchDiffNow(i); $("diff").value = $("diffQuick").value = curDiff; });
  return switchDiffNow(i);
}
function switchDiffNow(i) {
  stashDiff(); draftSchedule();
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
  if (COLLAB.on) collabEnd(true);
  draftDetach();
  EDIT.changed = false; osuFiles.forEach(o => o.created = o.edited = false);
  exitPlayerUI();
  if (onlineSet && R.inMap) leaveMap();
  else setTitle(R.ctx ? listTitle(R.ctx) : "");
};
$("shareBtn").onclick = () => { const u = shareURL(); if (!u && map) return cloudShareLocal(); shareLink(u, map ? `${map.meta.Artist} - ${map.meta.Title} [${map.meta.Version}]` : ""); };

// file open & drag-drop
$("pick").onclick = () => $("file").click();
$("homeOpen").onclick = () => { R.intent = ""; $("file").click(); };
$("hubOpen").onclick = () => { R.intent = "edit"; $("file").click(); };
fileAccept($("file"), ".osz,.zip");
$("file").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; if (!fileIs(f, ["osz", "zip"])) return toast(tr("Pick an .osz file (a beatmap package)"), 3000); openZip(f); };
let dragN = 0;
addEventListener("dragenter", e => { e.preventDefault(); dragN++; $("drop").hidden = false; });
addEventListener("dragleave", () => { if (--dragN <= 0) { dragN = 0; $("drop").hidden = true; } });
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => {
  e.preventDefault(); dragN = 0; $("drop").hidden = true;
  const f = e.dataTransfer.files[0]; if (!f) return;
  if (/\.osk$/i.test(f.name)) importOsk(f); else openZip(f);
});

// language switch: re-render the dynamic parts
addEventListener("langchange", () => {
  buildFilters(); showStatus(); renderMapperHead(); advRender();
  if (R.list.length) { const box = $("results"); box.innerHTML = ""; R.list.forEach((s, i) => box.append(card(s, i))); }
  if (!$("detail").hidden && detailInfo) showDetail(detailInfo, detailOnGo, detailPick && detailPick.bid);
  if (R.ctx && UI.player.hidden && R.view === "songs") setTitle(listTitle(R.ctx));
  if (!UI.sheet.hidden) renderSkinUI();
  if (UI.player.hidden && R.view) showView(R.view);
});

// ============ router ============
async function route() {
  const p = new URLSearchParams(location.search), sid = p.get("s"), bid = p.get("b");
  if (GATE.locked && GATE.guest && !p.has("invite") && (sid || bid || viewFromParams(p) !== "home")) { // a guest leaving the preview page (back button, a link) for a page they may use
    const n = routeNeeds(p); if (!n || n.some(can)) return gateUnlock(false);
  }
  if (GATE.locked && (sid || bid || !GATE_OPEN_VIEWS.has(p.get("view")))) return gateLock(); // invite-only: no access yet (gate.js)
  // permissions (gate.js): a part this visitor can't use opens the access page for guests, the home page for members
  const need = routeNeeds(p);
  if (GATE.guest && !sid && !bid && viewFromParams(p) === "home" && !["live", "collab", "project"].some(k => p.has(k))) return gateLock(); // guests' home page is the preview page (tour, try the editor, request access)
  if (need && !need.some(can)) {
    if (GATE.guest) return gateLock();
    toast(tr("You don't have access to this part of the site."), 2500);
    history.replaceState(null, "", location.pathname); return route();
  }
  if (p.get("login")) { const why = p.get("login"), linked = why.match(/^linked_(google)$/), good = why === "ok" || why === "deleted" || !!linked;
    toast(why === "ok" ? tr("Logged in") : why === "deleted" ? tr("Your account was deleted. Thanks for using KIKI BEATMAP VIEWER.") : linked ? tr("{p} account linked: if osu!'s login ever doesn't work, you can log in with it", { p: "Google" }) : tr("Login failed: {err}", { err: loginWhy(why) }), good ? 4500 : 7000); p.delete("login"); history.replaceState(history.state, "", location.pathname + (p.toString() ? "?" + p : "")); }
  if (!sid && !bid) {
    R.inMap = false; R.mapPushed = false;
    hideDetail();
    if (!UI.player.hidden) { if (!(LIVE.on && !LIVE.host) && !(await edConfirmDiscard())) { history.pushState({ map: 1 }, "", R.lastMapURL || location.href); R.inMap = R.mapPushed = true; return; } if (COLLAB.on) collabEnd(true); draftDetach(); EDIT.changed = false; osuFiles.forEach(o => o.created = o.edited = false); exitPlayerUI(); }
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
    return;
  }
  // a beatmap link
  R.inMap = true; R.mapPushed = !!(history.state && history.state.map); R.lastMapURL = location.href;
  if (R.view === null) { showView("songs"); syncSearchUI({ q: "", u: "", st: defSt() }); loadList({ q: "", u: "", st: defSt() }); } // something behind the sheet
  if (!UI.player.hidden && onlineSet && String(onlineSet) === String(sid)) return;
  if (!$("detail").hidden && detailInfo && String(detailInfo.sid) === String(sid)) return;
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
function routeNeeds(p) {
  if (p.get("live")) return ["online", "live"]; // guests may be allowed to watch
  if (p.get("collab") || p.get("project")) return ["online"];
  if (p.get("s") || p.get("b")) return p.get("mode") === "mod" && can("editor") ? ["editor"] : ["player", "listing"];
  const v = viewFromParams(p);
  return v === "songs" ? (p.get("u") ? ["mappers"] : ["listing"]) : v === "editor" || v === "create" ? ["editor"] : v === "projects" || v === "invite" ? ["online"] : null;
}
// the first route() runs at the end of pages.js, once every script is loaded

$("refreshList").onclick = () => { refreshList(); toast(tr("Loading the newest list…"), 1500); };

// ---------- install as an app (sw.js: the site opens without a connection; maps you downloaded stay in this browser) ----------
let installPrompt = null;
const appInstalled = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && !DEMO_TOUR)
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; if (typeof renderAccount === "function") renderAccount(); });
addEventListener("appinstalled", () => { installPrompt = null; toast(tr("Installed: open KIKI BEATMAP VIEWER from your home screen or apps"), 3500); if (typeof renderAccount === "function") renderAccount(); });
// the button in the account menu and on the Guide page: the browser's own install dialog, or how to do it on iPhone / iPad
function installButton(cls) {
  if (appInstalled() || (!installPrompt && !isIOS())) return null;
  const b = h("button", cls || "btn ghost sm wide", "⤓ " + tr("Install as an app"));
  b.onclick = async () => {
    if (installPrompt) { installPrompt.prompt(); try { await installPrompt.userChoice; } catch {} installPrompt = null; if (typeof renderAccount === "function") renderAccount(); return; }
    modal({ title: tr("Install as an app"), body: h("p", null, tr("In Safari, tap Share (the square with an arrow), then \"Add to Home Screen\".")), buttons: [{ label: tr("OK"), value: true, cls: "main" }] });
  };
  return b;
}
