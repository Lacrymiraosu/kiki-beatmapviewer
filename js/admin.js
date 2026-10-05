"use strict";
// ============ admin dashboard (the site owner and the admins they add) + Markdown for the changelog ============
// The page only shows controls; every admin request is checked on the server against the caller's verified osu! id.

// ---------- safe Markdown: builds DOM nodes (never HTML strings), so stored text can't inject markup ----------
// Supports: # ## ### headings, - * and 1. lists, > quotes, ``` code blocks, ---, **bold**, *italic* / _italic_,
// `code`, [links](https://…) (http/https or site-relative only). With translate, plain list items / paragraphs that
// match a known UI string are shown in the reader's language (keeps the old built-in changelog translated).
function mdInline(text, parent) {
  const RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\n]+\*|\b_[^_\n]+_\b)/g;
  let last = 0;
  for (const m of text.matchAll(RE)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const s = m[0];
    if (m[1]) parent.append(h("code", null, s.slice(1, -1)));
    else if (m[2]) { const b = h("strong"); mdInline(s.slice(2, -2), b); parent.append(b); }
    else if (m[3]) {
      const mm = s.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/), url = mm[2];
      if (/^https?:\/\//i.test(url) || /^[?/](?!\/)/.test(url)) { const a = h("a", null, mm[1]); a.href = url; if (/^https?:/i.test(url)) { a.target = "_blank"; a.rel = "noopener noreferrer nofollow"; } parent.append(a); }
      else parent.append(mm[1]);
    } else if (m[4]) { const i = h("em"); mdInline(s.slice(1, -1), i); parent.append(i); }
    last = m.index + s.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
function mdRender(src, opts = {}) {
  const out = document.createDocumentFragment(), lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const plain = t => opts.translate && !/[`*_\[]/.test(t) ? tr(t) : t;
  let list = null, para = null, code = null;
  const flush = () => { list = null; if (para) { out.append(para.el); para = null; } };
  for (const raw of lines) {
    if (code) { if (/^```/.test(raw)) { out.append(code); code = null; } else code.firstChild.append(raw + "\n"); continue; }
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line)) { flush(); code = h("pre"); code.append(h("code")); continue; }
    if (!line.trim()) { flush(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) { flush(); const el = h("h" + (m[1].length + 3)); mdInline(plain(m[2]), el); out.append(el); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line)) { flush(); out.append(h("hr")); continue; }
    if ((m = line.match(/^\s*([-*]|\d{1,3}[.)])\s+(.+)$/))) {
      if (para) { out.append(para.el); para = null; }
      const ordered = /\d/.test(m[1]);
      if (!list || list.ordered !== ordered) { list = { ordered, el: h(ordered ? "ol" : "ul") }; out.append(list.el); }
      const li = h("li"); mdInline(plain(m[2]), li); list.el.append(li); continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) { flush(); const q = h("blockquote"); mdInline(plain(m[1]), q); out.append(q); continue; }
    list = null;
    if (!para) para = { el: h("p") }; else para.el.append(h("br"));
    mdInline(plain(line.trim()), para.el);
  }
  if (code) out.append(code);
  flush();
  return out;
}

// ---------- dashboard ----------
// Tabs: overview, users, projects, storage & cleanup, settings, admins, audit log, changelog. Details (a user, a project)
// open in a side panel; every change is sent to the server, which checks the caller's role again.
const ADM = { tab: "overview", role: null, users: { q: "", status: "", role: "", sort: "" }, access: { status: "pending", q: "" }, projects: { q: "", status: "", sort: "" }, audit: { action: "", q: "" }, errors: { resolved: false, kind: "error", rows: [] }, cl: null, stack: [] };
const ADM_TABS = [["overview", "Overview"], ["users", "Users"], ["access", "Access"], ["errors", "Errors"], ["projects", "Projects"], ["storage", "Storage & cleanup"], ["turn", "TURN relay"], ["settings", "Settings"], ["admins", "Admins"], ["audit", "Audit log"], ["changelog", "Changelog"]];
async function aapi(method, route, body) { return capi(method, "admin/" + route, body); }
const admFail = e => toast(tr("Failed: {err}", { err: admErr(e) }), 4500);
function admErr(e) {
  const d = e.detail || {};
  if (e.code === "bad_request" && d.min != null) return tr("Allowed range: {a} to {b}", { a: fmtInt(d.min), b: fmtInt(d.max) });
  if (e.code === "forbidden" && d.reason === "own account") return tr("You can't change your own account here");
  if (e.code === "forbidden" && d.reason === "site owner") return tr("The site owner's account can't be changed");
  if (e.code === "forbidden") return tr("Only the site owner can do this");
  if (e.code === "user_not_found") return tr("No osu! user with that name");
  return cloudErrText(e);
}
// sizes as people read them on this page: 30,000,000 bytes = "30 MB" (decimal, like the limits are set)
const admBytes = b => { b = Number(b) || 0; return b >= 1e9 ? +(b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? +(b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB"; };
function admRel(d) {
  const ms = new Date(d) - Date.now(); if (!d || isNaN(ms)) return "";
  const rtf = new Intl.RelativeTimeFormat(LANG, { numeric: "auto" }), a = Math.abs(ms);
  return a < 36e5 ? rtf.format(Math.round(ms / 6e4), "minute") : a < 864e5 * 2 ? rtf.format(Math.round(ms / 36e5), "hour") : rtf.format(Math.round(ms / 864e5), "day");
}
const admWhen = d => d ? h("span", "admwhen", admRel(d)) : h("span", "admwhen", "—");
function admWhenEl(d) { const e = admWhen(d); if (d) e.title = fmtDate(d); return e; }
const admBadge = (text, cls = "") => h("em", "abadge " + cls, text);
function admStatusBadge(st) { return admBadge(tr({ active: "Active", suspended: "Suspended", expired: "Expired", deleting: "Being deleted" }[st] || st), st); }
function admBar(used, limit, cls = "") {
  const b = h("div", "abar " + cls), i = h("i"), pct = limit ? Math.min(100, used / limit * 100) : 0;
  i.style.width = pct.toFixed(1) + "%"; if (pct > 90) b.classList.add("hot"); b.append(i); return b;
}
function admSection(title, ...kids) { const s = h("section", "asec"); if (title) s.append(h("h3", "asech", title)); s.append(...kids.filter(Boolean)); return s; }
function admKv(label, value, opts = {}) {
  const d = h(opts.onclick ? "button" : "div", "akpi" + (opts.cls ? " " + opts.cls : ""));
  d.append(h("small", null, label), h("b", null, value)); if (opts.sub) d.append(h("span", "akpisub", opts.sub));
  if (opts.onclick) { d.type = "button"; d.onclick = opts.onclick; }
  return d;
}
function admToolbar(...els) { const f = h("form", "atool"); f.append(...els); f.onsubmit = e => e.preventDefault(); f.querySelectorAll("input").forEach(i => i.addEventListener("keydown", e => e.stopPropagation())); return f; }
function admSelect(opts, value, onchange, label) {
  const s = h("select"); for (const [v, l] of opts) s.add(new Option(tr(l), v)); s.value = value; s.onchange = () => onchange(s.value);
  if (label) s.setAttribute("aria-label", label); return s;
}
function admSearch(value, placeholder, onsearch) {
  const i = h("input"); i.type = "search"; i.value = value; i.placeholder = placeholder; i.setAttribute("aria-label", placeholder);
  let t; i.oninput = () => { clearTimeout(t); t = setTimeout(() => onsearch(i.value.trim()), 350); };
  i.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(t); onsearch(i.value.trim()); } });
  return i;
}
function admMore(shown, total, load) { if (shown >= total) return null; const b = h("button", "btn ghost wide", tr("Load more ({n} left)", { n: fmtInt(total - shown) })); b.onclick = load; return b; }

async function renderAdmin() {
  const box = $("admin"); box.innerHTML = "";
  const head = h("div", "ahead"), titles = h("div");
  titles.append(h("h2", null, tr("Admin")));
  head.append(titles); box.append(head);
  const me = await cloudMe(true);
  if (!me.cloud) { box.append(h("div", "empty", tr("Online saving isn't set up on this site yet"))); return; }
  if (!me.admin) { box.append(h("div", "empty", tr("This page is only for the site's admins."))); return; }
  ADM.role = me.admin;
  try { const r = await aapi("GET", "me"); ADM.role = r.role; ADM.ownerId = r.owner_id; } catch {}
  titles.append(h("small", "ahsub", ADM.role === "owner" ? tr("Signed in as the site owner") : tr("Signed in as an admin (the owner manages settings and admins)")));
  const refresh = h("button", "btn ghost sm", "↻ " + tr("Refresh")); refresh.onclick = () => admShowTab(); head.append(refresh);
  const nav = h("nav", "anav"); nav.setAttribute("role", "tablist");
  for (const [k, l] of ADM_TABS) {
    const b = h("button", "anavb" + (ADM.tab === k ? " on" : ""), tr(l)); b.type = "button"; b.dataset.tab = k; b.setAttribute("role", "tab");
    b.onclick = () => { ADM.tab = k; nav.querySelectorAll(".anavb").forEach(x => x.classList.toggle("on", x === b)); admShowTab(); }; nav.append(b);
  }
  const body = h("div", "abody"); body.id = "admBody";
  const wrap = h("div", "awrap"); wrap.append(nav, body); box.append(wrap);
  if (me.badges) { admBadgeSet("access", me.badges.pending); admBadgeSet("errors", me.badges.errors); }
  admShowTab();
}
function admGo(tab, patch) {
  if (patch) Object.assign(ADM[tab], patch);
  ADM.tab = tab; document.querySelectorAll(".anavb").forEach(x => x.classList.toggle("on", x.dataset.tab === tab)); admShowTab();
}
async function admShowTab() {
  const body = $("admBody"); if (!body) return;
  body.innerHTML = ""; body.append(h("div", "card sk"), h("div", "card sk"));
  const fn = { overview: admOverview, users: admUsers, access: admAccess, errors: admErrors, projects: admProjects, storage: admStorage, turn: admTurn, settings: admSettings, admins: admAdmins, audit: admAudit, changelog: admChangelog }[ADM.tab];
  try { await fn(body); }
  catch (e) { body.innerHTML = ""; const d = h("div", "empty", admErr(e) + " "); const again = h("button", "btn ghost sm", tr("Try again")); again.onclick = admShowTab; d.append(again); body.append(d); }
}

// ----- side panel with a back stack (user -> their project -> …) -----
function admPanel() {
  let p = $("admPanel");
  if (!p) {
    p = h("div", "apanel"); p.id = "admPanel"; p.hidden = true;
    const shade = h("div", "apshade"), sheet = h("aside", "apsheet"); sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
    const top = h("div", "aptop"), back = h("button", "btn ghost sm", "← " + tr("Back")), close = h("button", "icon", "✕");
    back.id = "admBack"; close.setAttribute("aria-label", tr("Close"));
    back.onclick = () => { ADM.stack.pop(); const prev = ADM.stack.pop(); prev ? admOpen(prev[0], prev[1]) : admClose(); };
    close.onclick = admClose; shade.onclick = admClose;
    const content = h("div", "apbody"); content.id = "admPanelBody";
    top.append(back, h("span", "aptitle"), close); sheet.append(top, content); p.append(shade, sheet); document.body.append(p);
    addEventListener("keydown", e => { if (e.key === "Escape" && !p.hidden && !document.querySelector(".mdl")) { e.stopPropagation(); admClose(); } }, true);
  }
  return p;
}
function admClose() { const p = $("admPanel"); if (p) p.hidden = true; ADM.stack = []; }
async function admOpen(kind, id) {
  const p = admPanel(), body = $("admPanelBody");
  ADM.stack.push([kind, id]);
  $("admBack").hidden = ADM.stack.length < 2;
  p.querySelector(".aptitle").textContent = kind === "user" ? tr("User") : tr("Project");
  p.hidden = false; body.innerHTML = ""; body.append(h("div", "card sk"));
  try { await (kind === "user" ? admUserPanel : admProjectPanel)(body, id); }
  catch (e) { body.innerHTML = ""; body.append(h("div", "empty", admErr(e))); }
}
const admReopen = () => { const cur = ADM.stack.pop(); if (cur) admOpen(cur[0], cur[1]); };

// ----- overview -----
async function admOverview(body) {
  const o = await aapi("GET", "overview"); body.innerHTML = "";
  const used = o.storage.bytes, pctUsed = o.budget_bytes ? used / o.budget_bytes * 100 : 0;
  const alerts = h("div", "aalerts"), alert = (t, cls, go) => { const a = h(go ? "button" : "div", "aalert " + cls, t); if (go) { a.type = "button"; a.onclick = go; } alerts.append(a); };
  try { const a = await aapi("GET", "access?status=pending&limit=1"); if (a.counts.pending) alert(tr("{n} access request(s) waiting for an answer.", { n: fmtInt(a.counts.pending) }), "warn", () => admGo("access", { status: "pending" })); } catch {}
  if (!o.saving_enabled) alert(tr("Online saving is paused: nobody can create or save projects."), "warn", () => admGo("settings"));
  if (pctUsed >= 80) alert(tr("Storage is {p}% full.", { p: Math.round(pctUsed) }), pctUsed >= 95 ? "bad" : "warn", () => admGo("storage"));
  if (o.untracked.objects) alert(tr("{n} file(s) in storage that no project knows about.", { n: fmtInt(o.untracked.objects) }), "warn", () => admGo("storage"));
  if (o.deleting) alert(tr("{n} project(s) waiting for their files to be deleted.", { n: fmtInt(o.deleting) }), "warn", () => admGo("storage"));
  if (o.last_cleanup && !o.last_cleanup.ok) alert(tr("The last cleanup had problems."), "bad", () => admGo("storage"));
  const r2m = o.r2 && o.r2.months && o.r2.months[0], thisMonth = new Date().toISOString().slice(0, 7);
  if (r2m && r2m.month.slice(0, 7) === thisMonth) for (const [v, m, l] of [[r2m.a, o.r2.max_a, "uploads"], [r2m.b, o.r2.max_b, "downloads"]]) { // R2's free monthly operations
    if (m && v >= m) alert(tr("R2 {what} reached this month's limit: refused until next month.", { what: tr(l) }), "bad", () => admGo("storage"));
    else if (m && v >= m * .8) alert(tr("R2 {what}: {p}% of this month's limit used.", { what: tr(l), p: Math.round(v / m * 100) }), "warn", () => admGo("storage"));
  }
  try { // the TURN relay's monthly limit (only when the usage can be read)
    const tu = await aapi("GET", "turn"), lim = tu.month_gb * 1e9, used = tu.usage && tu.usage.bytes;
    if (tu.capped) alert(tr("The TURN relay reached this month's limit: live sessions are peer-to-peer only until next month."), "bad", () => admGo("turn"));
    else if (lim && used >= lim * .8) alert(tr("The TURN relay has used {p}% of this month's limit.", { p: Math.round(used / lim * 100) }), "warn", () => admGo("turn"));
  } catch {}
  if (!alerts.children.length) alert(tr("Everything looks fine."), "ok");
  const k = h("div", "akpis");
  k.append(
    admKv(tr("Users"), fmtInt(o.users), { sub: tr("+{n} this week", { n: fmtInt(o.new_users_7d) }), onclick: () => admGo("users", { q: "", status: "", role: "", sort: "created" }) }),
    admKv(tr("Active this week"), fmtInt(o.active_users_7d), { onclick: () => admGo("users", { q: "", status: "", role: "", sort: "" }) }),
    admKv(tr("Active projects"), fmtInt(o.projects), { onclick: () => admGo("projects", { q: "", status: "active", sort: "" }) }),
    admKv(tr("Expiring in 24 h"), fmtInt(o.expiring_24h), { cls: o.expiring_24h ? "warn" : "", onclick: () => admGo("projects", { q: "", status: "expiring", sort: "expires" }) }),
    admKv(tr("Saves this week"), fmtInt(o.saves_7d)),
    admKv(tr("Suspended"), fmtInt(o.suspended), { cls: o.suspended ? "warn" : "", onclick: () => admGo("users", { q: "", status: "suspended", role: "", sort: "" }) }),
    admKv(tr("Admins"), fmtInt(o.admins + 1), { onclick: () => admGo("admins") }));
  // storage
  const t = o.tracked_bytes, seg = h("div", "astack");
  for (const [v, cls, l] of [[t.committed, "c", "In saved projects"], [t.pending, "p", "Unfinished uploads"], [t.orphaned, "o", "Replaced, waiting to be deleted"], [o.untracked.bytes, "u", "In storage but not tracked"]]) {
    if (!v) continue; const i = h("i", cls); i.style.width = Math.max(.5, v / o.budget_bytes * 100).toFixed(2) + "%"; i.title = `${tr(l)}: ${admBytes(v)}`; seg.append(i);
  }
  const legend = h("div", "alegend");
  for (const [v, cls, l] of [[t.committed, "c", "In saved projects"], [t.pending, "p", "Unfinished uploads"], [t.orphaned, "o", "Replaced, waiting to be deleted"]]) { const s = h("span"); s.append(h("i", cls), `${tr(l)} ${admBytes(v)}`); legend.append(s); }
  const limits = h("div", "alimits");
  for (const [l, v] of [["Per project", admBytes(o.limit_bytes)], ["Kept for", tr("{n} days", { n: o.retention_days })], ["Projects per user", fmtInt(o.max_projects)]]) { const s = h("span"); s.append(h("small", null, tr(l)), h("b", null, v)); limits.append(s); }
  const change = h("button", "mlink", tr("Change limits →")); change.onclick = () => admGo("settings"); limits.append(change);
  const storage = admSection(tr("Storage") + (o.backend === "r2" ? " · Cloudflare R2" : " · Supabase"), h("p", "abig", tr("{u} of {b} used", { u: admBytes(used), b: admBytes(o.budget_bytes) })), seg, legend, limits);
  // activity: saves per day, last 14 days
  const max = Math.max(1, ...o.saves_by_day.map(d => d.saves)), chart = h("div", "achart");
  for (const d of o.saves_by_day) {
    const col = h("div", "acol"), bar = h("i"); bar.style.height = Math.max(2, d.saves / max * 100) + "%";
    col.title = `${new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${tr("{n} saves", { n: d.saves })}`;
    col.append(bar, h("small", null, new Date(d.day + "T00:00:00").getDate())); chart.append(col);
  }
  const activity = admSection(tr("Saves per day (last 14 days)"), chart);
  const list = (rows, render) => { const ul = h("div", "alist"); if (!rows.length) ul.append(h("p", "hint", tr("Nothing yet."))); rows.forEach(r => ul.append(render(r))); return ul; };
  const topUsers = admSection(tr("Most storage used"), list(o.top_users, u => admRow([admUserName(u.id, u.username), h("span", "anum", admBytes(u.bytes)), h("span", "adim", tr("{n} projects", { n: u.projects }))], () => admOpen("user", u.id))));
  const largest = admSection(tr("Largest projects"), list(o.largest, p => admRow([h("b", "aclip", `${p.artist || "?"} - ${p.title || "?"}`), h("span", "adim", p.owner), h("span", "anum", admBytes(p.size_bytes))], () => admOpen("project", p.id))));
  const lc = o.last_cleanup;
  const clean = admSection(tr("Daily cleanup"), h("p", "hint", lc ? `${tr("Last run")}: ${fmtDate(lc.at)} (${admRel(lc.at)}) · ${lc.ok ? tr("OK") : tr("with problems")}` : tr("Not run yet (it runs once a day)")));
  const grid = h("div", "agrid2"); grid.append(storage, activity, topUsers, largest);
  body.innerHTML = ""; body.append(alerts, k, grid, clean);
}
function admRow(cells, onclick) {
  const r = h(onclick ? "button" : "div", "arow"); if (onclick) { r.type = "button"; r.onclick = onclick; }
  r.append(...cells); return r;
}
function admUserName(id, name) { const s = h("span", "auser"); s.append(avatarEl(id, name), h("b", null, name || "#" + id)); return s; }

// ----- users -----
async function admUsers(body, append) {
  const f = ADM.users;
  if (!append) f.rows = [];
  const r = await aapi("GET", `users?q=${enc(f.q)}&status=${f.status}&role=${f.role}&sort=${f.sort}&offset=${f.rows.length}&limit=40`);
  f.rows.push(...r.rows); f.total = r.total;
  body.innerHTML = "";
  body.append(admToolbar(
    admSearch(f.q, tr("osu! name or id"), v => { f.q = v; admUsers(body); }),
    admSelect([["", "Any status"], ["active", "Active"], ["suspended", "Suspended"]], f.status, v => { f.status = v; admUsers(body); }, tr("Status")),
    admSelect([["", "Everyone"], ["admin", "Admins"], ["custom", "With their own limits"]], f.role, v => { f.role = v; admUsers(body); }, tr("Show")),
    admSelect([["", "Last seen"], ["bytes", "Most storage"], ["projects", "Most projects"], ["created", "Newest"], ["name", "Name"]], f.sort, v => { f.sort = v; admUsers(body); }, tr("Sort by"))));
  body.append(h("p", "acount", tr("{n} users", { n: fmtInt(f.total) })));
  if (!f.rows.length) { body.append(h("div", "empty", tr("No users match."))); return; }
  const list = h("div", "atable users");
  const head = h("div", "athead"); for (const c of ["User", "Projects", "Storage", "Last seen"]) head.append(h("span", null, tr(c))); list.append(head);
  for (const u of f.rows) {
    const who = admUserName(u.id, u.username);
    if (u.role === "admin") who.append(admBadge(tr("Admin"), "admin"));
    if (u.status !== "active") who.append(admStatusBadge(u.status));
    if (u.limits && (u.limits.custom.max_projects || u.limits.custom.max_project_bytes || u.limits.custom.retention_days)) who.append(admBadge(tr("Own limits"), "custom"));
    const st = h("span", "acell"); st.append(h("span", "anum", admBytes(u.bytes)), admBar(u.bytes, u.limits ? u.limits.max_project_bytes * Math.max(1, u.limits.max_projects) : 0));
    list.append(admRow([who, h("span", "acell anum", `${fmtInt(u.projects)} / ${u.limits ? fmtInt(u.limits.max_projects) : "?"}`), st, (() => { const c = h("span", "acell"); c.append(admWhenEl(u.last_seen_at)); return c; })()], () => admOpen("user", u.id)));
  }
  body.append(list);
  const more = admMore(f.rows.length, f.total, () => admUsers(body, true)); if (more) body.append(more);
}
function admLimitField(label, unit, cur, def, conv, key, min, max) {
  // cur = override (null = default); conv: value in the unit <-> stored value
  const row = h("div", "alim"), use = h("input"), num = h("input"), lab = h("label", "alimdef");
  use.type = "checkbox"; use.checked = cur == null; num.type = "number"; num.min = min; num.max = max; num.step = "1";
  num.value = cur == null ? conv.to(def) : conv.to(cur); num.disabled = use.checked;
  use.onchange = () => { num.disabled = use.checked; if (use.checked) num.value = conv.to(def); else num.focus(); };
  num.addEventListener("keydown", e => e.stopPropagation());
  lab.append(use, " " + tr("Site default ({v})", { v: `${conv.to(def)} ${unit}` }));
  const inp = h("div", "aliminp"); inp.append(num, h("span", "adim", unit));
  row.append(h("b", null, label), inp, lab);
  row.value = () => use.checked ? null : conv.from(Number(num.value));
  row.key = key; return row;
}
async function admUserPanel(body, id) {
  const { user: u } = await aapi("GET", `users/${id}`); body.innerHTML = "";
  const me = CLOUD.me && CLOUD.me.user, isMe = !!me && me.id === u.id, isOwnerAcct = ADM.ownerId === u.id;
  const head = h("div", "aphead"), av = avatarEl(u.id, u.username, "apav"), names = h("div");
  const prof = h("a", "mlink", tr("osu! profile ↗")); prof.href = `https://osu.ppy.sh/users/${u.id}`; prof.target = "_blank"; prof.rel = "noopener";
  if (u.id >= 1e12) names.append(h("h3", null, u.username), h("small", "adim", tr("Google only (no osu! account yet)"))); // (Google sign-in without osu!)
  else names.append(h("h3", null, u.username), h("small", "adim", `#${u.id}${u.country ? " · " + u.country : ""} · `), prof);
  const badges = h("div", "abadges");
  if (isOwnerAcct) badges.append(admBadge(tr("Owner"), "owner")); else if (u.role === "admin") badges.append(admBadge(tr("Admin"), "admin"));
  badges.append(admStatusBadge(u.status));
  names.append(badges); head.append(av, names); body.append(head);
  if (u.status === "suspended" && u.status_reason) body.append(h("p", "aalert warn", tr("Suspended: {r}", { r: u.status_reason })));
  if (u.access && u.access.access && !isOwnerAcct) {
    const a = u.access, box = h("div", "aaccess"), line = h("p", null);
    line.append(admAccessBadge(a.access), " ", a.decided_at ? tr("{w} by {n}", { w: fmtDate(a.decided_at), n: a.decided_by || "?" }) : a.requested_at ? tr("Requested {d}", { d: fmtDate(a.requested_at) }) : "");
    box.append(line); if (a.message) box.append(h("blockquote", "anote", a.message));
    if (!isMe) box.append(admAccessButtons({ id: u.id, username: u.username, access: a.access, role: u.role }, admReopen));
    body.append(admSection(tr("Access"), box));
  }
  if (u.invites) { await admSettingsCache(); body.append(admInvitesSection(u, isOwnerAcct || u.role === "admin")); }
  if (typeof u.turn_relay === "boolean") body.append(admTurnSection(u));
  const L = u.limits, k = h("div", "akpis small");
  k.append(admKv(tr("Projects"), `${u.projects.filter(p => p.status === "active").length} / ${L.max_projects}`), admKv(tr("Storage used"), admBytes(u.bytes)),
    admKv(tr("Saves (30 days)"), fmtInt(u.saves_30d)), admKv(tr("Joined"), fmtDate(u.created_at, false)), admKv(tr("Last seen"), admRel(u.last_seen_at) || "—"));
  body.append(k);
  // limits
  const S2 = await admSettingsCache();
  const mb = { to: v => Math.round(v / 1e6), from: v => Math.round(v) * 1e6 }, same = { to: v => v, from: v => Math.round(v) };
  const fields = [
    admLimitField(tr("Max size per project"), "MB", u.overrides.max_project_bytes, S2.max_project_bytes, mb, "max_project_bytes", 1, 95),
    admLimitField(tr("Days a project is kept"), tr("days"), u.overrides.retention_days, S2.retention_days, same, "retention_days", 1, 365),
    admLimitField(tr("Online projects at once"), tr("projects"), u.overrides.max_projects, S2.max_projects_per_user, same, "max_projects", 0, 1000)];
  const saveL = h("button", "btn main sm", tr("Save limits"));
  saveL.onclick = async () => {
    const patch = {}; for (const f of fields) { const v = f.value(); if (v != null && !Number.isFinite(v)) return toast(tr("Enter a number")); patch[f.key] = v; }
    saveL.disabled = true;
    try { await aapi("POST", `users/${u.id}`, patch); toast(tr("Limits saved"), 1800); admReopen(); } catch (e) { admFail(e); saveL.disabled = false; }
  };
  const limBox = h("div", "alims"); limBox.append(...fields);
  body.append(admSection(tr("Limits"), h("p", "hint", tr("Leave \"Site default\" ticked to follow the site-wide settings. A new number of days applies to projects created from now on; change a single project's date in its panel.")), limBox, saveL));
  // account
  const acct = h("div", "aacct");
  if (isMe) acct.append(h("p", "hint", tr("This is your own account.")));
  else if (isOwnerAcct) acct.append(h("p", "hint", tr("The site owner's account can't be suspended or demoted.")));
  else {
    const canStatus = u.role !== "admin" || ADM.role === "owner";
    if (u.status === "active") {
      const reason = h("input"); reason.placeholder = tr("Reason (kept in the audit log)"); reason.maxLength = 300; reason.addEventListener("keydown", e => e.stopPropagation());
      const b = h("button", "btn ghost sm danger", tr("Suspend")); b.disabled = !canStatus;
      b.onclick = async () => {
        if (!(await ask(tr("Suspend {n}? They can't open, create or save online projects until reactivated.", { n: u.username }), { ok: tr("Suspend"), danger: true }))) return;
        try { await aapi("POST", `users/${u.id}`, { status: "suspended", reason: reason.value.trim() }); toast(tr("{n} is suspended", { n: u.username })); admReopen(); } catch (e) { admFail(e); }
      };
      const row = h("div", "arowin"); row.append(reason, b); acct.append(row);
    } else {
      const b = h("button", "btn main sm", tr("Reactivate")); b.disabled = !canStatus;
      b.onclick = async () => { try { await aapi("POST", `users/${u.id}`, { status: "active" }); toast(tr("{n} is active again", { n: u.username })); admReopen(); } catch (e) { admFail(e); } };
      acct.append(b);
    }
    if (!canStatus) acct.append(h("p", "hint", tr("Only the site owner can suspend an admin.")));
    if (ADM.role === "owner") {
      const b = h("button", "btn ghost sm", u.role === "admin" ? tr("Remove admin rights") : tr("Make admin"));
      b.onclick = async () => {
        if (!(await ask(u.role === "admin" ? tr("Remove {n}'s admin rights?", { n: u.username }) : tr("Make {n} an admin? They'll see everyone's projects and can manage users, projects and the changelog.", { n: u.username }), u.role === "admin" ? { ok: tr("Remove"), danger: true } : { ok: tr("Make admin") }))) return;
        try { await aapi("POST", `users/${u.id}`, { role: u.role === "admin" ? "user" : "admin" }); admReopen(); } catch (e) { admFail(e); }
      };
      acct.append(b);
    }
  }
  body.append(admSection(tr("Account"), acct));
  // note
  const note = h("textarea"); note.value = u.note || ""; note.maxLength = 1000; note.rows = 3; note.placeholder = tr("Only admins see this note"); note.addEventListener("keydown", e => e.stopPropagation());
  const saveN = h("button", "btn ghost sm", tr("Save note"));
  saveN.onclick = async () => { try { await aapi("POST", `users/${u.id}`, { note: note.value }); toast(tr("Note saved"), 1500); } catch (e) { admFail(e); } };
  const nb = h("div", "anote"); nb.append(note, saveN);
  body.append(admSection(tr("Admin note"), nb));
  // projects
  const pl = h("div", "alist");
  if (!u.projects.length) pl.append(h("p", "hint", tr("No projects.")));
  for (const p of u.projects) pl.append(admRow([h("b", "aclip", `${p.artist || "?"} - ${p.title || "?"}`), admStatusBadge(p.status), h("span", "anum", admBytes(p.size_bytes)), h("span", "adim", tr("expires {d}", { d: admRel(p.expires_at) }))], () => admOpen("project", p.id)));
  body.append(admSection(tr("Their projects"), pl));
  if (u.shared_with.length) {
    const sl = h("div", "alist");
    for (const p of u.shared_with) sl.append(admRow([h("b", "aclip", p.title || "?"), h("span", "adim", tr("by {n}", { n: p.owner })), admBadge(tr(p.role === "editor" ? "can edit" : "view only"))], () => admOpen("project", p.id)));
    body.append(admSection(tr("Shared with them"), sl));
  }
  body.append(admSection(tr("Recent activity"), admAuditList(u.activity)));
}

// ----- projects -----
async function admProjects(body, append) {
  const f = ADM.projects;
  if (!append) f.rows = [];
  const r = await aapi("GET", `projects?q=${enc(f.q)}&status=${f.status}&sort=${f.sort}&offset=${f.rows.length}&limit=40`);
  f.rows.push(...r.rows); f.total = r.total; f.bytes = r.bytes;
  body.innerHTML = "";
  body.append(admToolbar(
    admSearch(f.q, tr("Title, artist, owner or id"), v => { f.q = v; admProjects(body); }),
    admSelect([["", "All"], ["active", "Active"], ["expiring", "Expiring in 48 h"], ["expired", "Expired"], ["deleting", "Being deleted"]], f.status, v => { f.status = v; admProjects(body); }, tr("Status")),
    admSelect([["", "Newest"], ["size", "Largest"], ["expires", "Expiring first"], ["updated", "Recently saved"]], f.sort, v => { f.sort = v; admProjects(body); }, tr("Sort by"))));
  body.append(h("p", "acount", tr("{n} projects · {s}", { n: fmtInt(f.total), s: admBytes(f.bytes) })));
  if (!f.rows.length) { body.append(h("div", "empty", tr("No projects match."))); return; }
  const list = h("div", "atable projects");
  const head = h("div", "athead"); for (const c of ["Project", "Owner", "Size", "Expires"]) head.append(h("span", null, tr(c))); list.append(head);
  for (const p of f.rows) {
    const t = h("span", "acell aproj"); t.append(h("b", "aclip", `${p.artist || "?"} - ${p.title || "?"}`)); if (p.status !== "active") t.append(admStatusBadge(p.status));
    const sz = h("span", "acell"); sz.append(h("span", "anum", `${admBytes(p.stored_bytes || p.size_bytes)} / ${admBytes(p.limit_bytes)}`), admBar(p.size_bytes, p.limit_bytes));
    const ex = h("span", "acell" + (p.status === "active" && new Date(p.expires_at) - Date.now() < 864e5 ? " soon" : "")); ex.append(admWhenEl(p.expires_at));
    list.append(admRow([t, h("span", "acell adim", p.owner.username), sz, ex], () => admOpen("project", p.id)));
  }
  body.append(list);
  const more = admMore(f.rows.length, f.total, () => admProjects(body, true)); if (more) body.append(more);
}
async function admProjectPanel(body, id) {
  const { project: p } = await aapi("GET", `projects/${id}`); body.innerHTML = "";
  const head = h("div", "aphead"), names = h("div");
  names.append(h("h3", null, `${p.artist || "?"} - ${p.title || "?"}`));
  const owner = h("button", "mlink", tr("by {n}", { n: p.owner ? p.owner.username : "?" })); owner.onclick = () => admOpen("user", p.owner.id);
  const idb = h("button", "mlink adim", p.id.slice(0, 8) + "…"); idb.title = tr("Copy the id"); idb.onclick = () => copyText(p.id).then(() => toast(tr("Copied"), 1200));
  const badges = h("div", "abadges"); badges.append(admStatusBadge(p.status));
  names.append(owner, " · ", idb, badges); head.append(names); body.append(head);
  if (p.cleanup_error) body.append(h("p", "aalert warn", tr("Cleanup problem: {e}", { e: p.cleanup_error })));
  const k = h("div", "akpis small");
  k.append(admKv(tr("Size"), `${admBytes(p.size_bytes)} / ${admBytes(p.limit_bytes)}`), admKv(tr("Revision"), fmtInt(p.revision)), admKv(tr("Files"), fmtInt(p.files.length)),
    admKv(tr("Shared with"), fmtInt(p.members.length)), admKv(tr("Annotations"), fmtInt(p.annotations)), admKv(tr("Created"), fmtDate(p.created_at, false)));
  body.append(k, admBar(p.size_bytes, p.limit_bytes, "big"));
  // expiry
  const ex = h("div", "aexp");
  ex.append(h("p", null, tr("Expires {d} ({r})", { d: fmtDate(p.expires_at), r: admRel(p.expires_at) })));
  if (p.status === "active") {
    const set = async to => {
      try { await aapi("POST", `projects/${p.id}/expiry`, { expiresAt: to.toISOString() }); toast(tr("New expiry: {d}", { d: fmtDate(to) }), 2500); admReopen(); }
      catch (e) { admFail(e); }
    };
    const quick = h("div", "btnrow");
    for (const d of [7, 15, 30]) { const b = h("button", "btn ghost sm", tr("+{n} days", { n: d })); b.onclick = () => set(new Date(new Date(p.expires_at).getTime() + d * 864e5)); quick.append(b); }
    const date = h("input"); date.type = "date"; date.value = String(p.expires_at).slice(0, 10);
    date.min = new Date(Date.now() + 864e5).toISOString().slice(0, 10); date.max = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
    const go = h("button", "btn ghost sm", tr("Set date")); go.onclick = () => { if (date.value) set(new Date(date.value + "T" + new Date(p.expires_at).toISOString().slice(11, 19) + "Z")); };
    const row = h("div", "arowin"); row.append(date, go);
    ex.append(quick, row, h("p", "hint", tr("Up to a year from today. The owner and the people it's shared with see the new date.")));
  }
  body.append(admSection(tr("Expiry"), ex));
  // files
  const ft = h("div", "alist files");
  if (!p.files.length) ft.append(h("p", "hint", tr("Nothing saved yet.")));
  for (const f of p.files.slice(0, 60)) ft.append(admRow([h("span", "aclip", f.path), h("span", "anum", admBytes(f.size))]));
  if (p.files.length > 60) ft.append(h("p", "hint", tr("…and {n} more", { n: p.files.length - 60 })));
  body.append(admSection(tr("Files (largest first)"), ft));
  if (p.members.length) {
    const ml = h("div", "alist");
    for (const m of p.members) ml.append(admRow([admUserName(m.id, m.username), admBadge(tr(m.role === "editor" ? "can edit" : "view only"))], () => admOpen("user", m.id)));
    body.append(admSection(tr("Shared with"), ml));
  }
  if (p.saves.length) {
    const sl = h("div", "alist");
    for (const s of p.saves) sl.append(admRow([h("span", "anum", tr("revision {r}", { r: s.revision })), h("span", null, s.user || "?"), admWhenEl(s.at)]));
    body.append(admSection(tr("Save history"), sl));
  }
  if (p.status !== "deleting") {
    const del = h("button", "btn ghost danger", tr("Delete this project"));
    del.onclick = async () => {
      if (!(await ask(tr("Delete the project \"{t}\" of {o} and all its files? This can't be undone.", { t: p.title || p.id, o: p.owner.username }), { ok: tr("Delete"), danger: true }))) return;
      try { const r = await aapi("DELETE", `projects/${p.id}`, {}); toast(r.files_removed ? tr("Deleted, with all its files") : tr("Access removed; {n} file(s) couldn't be deleted yet ({err}). The daily cleanup retries.", { n: r.remaining, err: r.error || "" }), 5000); admReopen(); if (ADM.tab === "projects") admShowTab(); }
      catch (e) { admFail(e); }
    };
    body.append(admSection(tr("Danger zone"), del));
  }
}

// ----- storage & cleanup -----
async function admStorage(body) {
  const [o, c] = await Promise.all([aapi("GET", "overview"), aapi("GET", "cleanup")]); body.innerHTML = "";
  const t = o.tracked_bytes;
  const k = h("div", "akpis");
  k.append(admKv(tr("In storage"), admBytes(o.storage.bytes), { sub: o.storage.objects != null ? tr("{n} files", { n: fmtInt(o.storage.objects) }) : "Cloudflare R2" }), admKv(tr("Budget"), admBytes(o.budget_bytes), { onclick: () => admGo("settings") }),
    admKv(tr("In saved projects"), admBytes(t.committed)), admKv(tr("Unfinished uploads"), admBytes(t.pending)), admKv(tr("Replaced, waiting to be deleted"), admBytes(t.orphaned)),
    admKv(tr("In storage but not tracked"), `${fmtInt(o.untracked.objects)} · ${admBytes(o.untracked.bytes)}`, { cls: o.untracked.objects ? "warn" : "" }));
  body.append(k, admBar(o.storage.bytes, o.budget_bytes, "big"),
    h("p", "hint", o.backend === "r2" ? tr("Files are on Cloudflare R2 (free tier: 10 GB). Measured from the files the projects track. New uploads are refused once the budget is reached.") : tr("Measured from Storage's own records. New uploads are refused once the budget is reached.")));
  if (o.r2) { // R2 operations per month, refused above the limits (Settings) so the free tier is never passed
    const m = (o.r2.months || [])[0], cur = m && m.month.slice(0, 7) === new Date().toISOString().slice(0, 7) ? m : { a: 0, b: 0, refused_a: 0, refused_b: 0 };
    const row = (l, v, max, ref) => { const d = h("div", "ar2row"); d.append(h("span", null, tr(l)), h("b", "anum", `${fmtInt(v)} / ${fmtInt(max)}`), admBar(v, max), ref ? h("small", "abad", tr("{n} refused", { n: fmtInt(ref) })) : ""); return d; };
    const past = h("div", "alist");
    for (const x of (o.r2.months || []).slice(0, 6)) past.append(admRow([h("span", null, x.month.slice(0, 7)), h("span", "anum", tr("{n} uploads", { n: fmtInt(x.a) })), h("span", "anum", tr("{n} downloads", { n: fmtInt(x.b) }))]));
    const ch = h("button", "mlink", tr("Change limits →")); ch.onclick = () => admGo("settings");
    body.append(admSection(tr("R2 operations this month"), row("Uploads and file lists (Class A)", cur.a, o.r2.max_a, cur.refused_a), row("Downloads and file checks (Class B)", cur.b, o.r2.max_b, cur.refused_b),
      h("p", "hint", tr("R2's free tier: 1 000 000 Class A and 10 000 000 Class B operations a month. Above the limits here, uploads or downloads are refused until next month instead of being billed. Deleting is free.")), ch, past));
  }
  const run = h("button", "btn main", tr("Run cleanup now"));
  run.onclick = async () => {
    if (!(await ask(tr("Delete the files and records of all expired or deleted projects and of unfinished uploads now?"), { ok: tr("Delete"), danger: true }))) return;
    run.disabled = true; run.textContent = tr("Running…");
    try { const r = await aapi("POST", "cleanup", {}); toast(tr("Cleanup: {p} projects deleted, {g} old files removed, {w} still pending", { p: r.purged, g: r.gc_deleted, w: r.pending }) + (r.errors.length ? " · " + r.errors.join(", ") : ""), 6000); }
    catch (e) { admFail(e); }
    admShowTab();
  };
  body.append(admSection(tr("Cleanup"), h("p", "hint", tr("Expired projects can't be opened from the moment they expire. Their files and records are deleted by the daily cleanup; records are only removed after Storage confirms the files are gone.")), run,
    h("p", "hint", tr("Replaced files waiting: {o} · unfinished uploads older than 3 h: {p}", { o: c.gc_waiting.orphaned, p: c.gc_waiting.pending_stale }))));
  const wait = h("div", "alist");
  if (!c.deleting.length) wait.append(h("p", "hint", tr("Nothing waiting.")));
  for (const d of c.deleting) wait.append(admRow([h("b", "aclip", d.title || d.id), h("span", "adim", tr({ expired: "expired", owner: "deleted by the owner", admin: "deleted by an admin" }[d.reason] || d.reason || "")),
    h("span", "anum", tr("{n} files left", { n: d.files })), h("span", d.error ? "abad" : "adim", d.error ? tr("{n} attempts · {e}", { n: d.attempts, e: d.error }) : admRel(d.at))], () => admOpen("project", d.id)));
  body.append(admSection(tr("Waiting to be deleted"), wait));
  const runs = h("div", "alist");
  if (!c.runs.length) runs.append(h("p", "hint", tr("Not run yet (it runs once a day)")));
  for (const r of c.runs) runs.append(admRow([admWhenEl(r.at), admBadge(r.ok ? tr("OK") : tr("with problems"), r.ok ? "active" : "suspended"),
    h("span", "adim aclip", r.detail ? tr("{p} projects deleted, {g} old files removed, {w} still pending", { p: r.detail.purged ?? 0, g: r.detail.gc_deleted ?? 0, w: r.detail.pending ?? 0 }) : "")]));
  body.append(admSection(tr("Recent runs"), runs));
}

// ----- TURN relay: this month's usage (Cloudflare analytics) against the free allowance and the limit -----
const TURN_FREE_GB = 1000, TURN_USD_GB = 0.05;
async function admTurn(body, fresh) {
  const t = await aapi("GET", "turn" + (fresh ? "?fresh=1" : "")); body.innerHTML = "";
  const alerts = h("div", "aalerts"), alert = (x, cls, go) => { const a = h(go ? "button" : "div", "aalert " + cls, x); if (go) { a.type = "button"; a.onclick = go; } alerts.append(a); };
  if (!t.key) alert(tr("The TURN key isn't set up on the server yet: add the secrets TURN_KEY_ID and TURN_KEY_API_TOKEN (Cloudflare → Realtime → TURN). Until then live sessions stay peer-to-peer only."), "warn");
  else if (t.capped) alert(tr("This month's limit is reached: nobody gets the relay until next month (live sessions stay peer-to-peer). Raise the limit in Settings to turn it back on."), "bad", () => admGo("settings"));
  else if (!t.on) alert(tr("The TURN relay is turned off in Settings."), "warn", () => admGo("settings"));
  if (!t.analytics) alert(tr("Usage can't be read yet: add the secrets CF_ANALYTICS_TOKEN (a Cloudflare API token with Account Analytics: Read) and CF_ACCOUNT_ID. Without them the monthly limit isn't checked."), "warn");
  if (t.error) alert(tr("Couldn't read the usage from Cloudflare: {err}", { err: t.error }), "bad");
  body.append(alerts);
  const u = t.usage; if (!u) return admTurnFoot(body, t);
  const used = u.bytes, limit = t.month_gb * 1e9, free = TURN_FREE_GB * 1e9, over = Math.max(0, used - free);
  const k = h("div", "akpis");
  k.append(admKv(tr("Used this month"), admBytes(used), { sub: new Date(u.from).toLocaleDateString(undefined, { month: "long", year: "numeric" }) }),
    admKv(tr("Monthly limit"), t.month_gb ? fmtInt(t.month_gb) + " GB" : tr("No limit"), { cls: limit && used >= limit * .8 ? "warn" : "", onclick: () => admGo("settings") }),
    admKv(tr("Free allowance"), fmtInt(TURN_FREE_GB) + " GB", { sub: tr("{p}% used", { p: +(used / free * 100).toFixed(used < free * .01 ? 2 : 1) }) }),
    admKv(tr("Estimated cost"), "$" + (over / 1e9 * TURN_USD_GB).toFixed(2), { sub: tr("$0.05 per GB above the free allowance") }));
  body.append(k);
  const bars = h("div", "aturnbars");
  if (limit) bars.append(h("small", null, tr("{u} of the {l} GB limit", { u: admBytes(used), l: fmtInt(t.month_gb) })), admBar(used, limit));
  bars.append(h("small", null, tr("{u} of the {l} GB free allowance", { u: admBytes(used), l: fmtInt(TURN_FREE_GB) })), admBar(used, free));
  body.append(admSection(tr("This month"), bars));
  if (u.days) {
    const max = Math.max(1, ...u.days.map(d => d.bytes)), chart = h("div", "achart");
    if (!u.days.length) chart.append(h("p", "hint", tr("No relay traffic this month.")));
    for (const d of u.days) {
      const col = h("div", "acol"), bar = h("i"); bar.style.height = Math.max(2, d.bytes / max * 100) + "%";
      col.title = `${new Date(d.day + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${admBytes(d.bytes)}`;
      col.append(bar, h("small", null, +d.day.slice(8))); chart.append(col);
    }
    body.append(admSection(tr("Relay traffic per day"), chart));
  }
  if (u.people) {
    const l = h("div", "alist"); if (!u.people.length) l.append(h("p", "hint", tr("Nothing yet.")));
    for (const p of u.people) {
      const who = p.id ? admUserName(p.id, p.username) : h("b", null, p.ident === "guest" ? tr("Guests (not logged in)") : p.ident || tr("Unknown"));
      l.append(admRow([who, h("span", "anum", admBytes(p.bytes))], p.id ? () => admOpen("user", p.id) : null));
    }
    body.append(admSection(tr("Who used the relay most"), l));
  }
  admTurnFoot(body, t);
}
function admTurnFoot(body, t) {
  const note = h("p", "hint", tr("Numbers come from Cloudflare: sampled (close, not exact), a few minutes behind, and kept here 5 minutes. Only traffic sent from Cloudflare to people is counted (that's what is billed). The month is the calendar month in UTC."));
  const again = h("button", "btn ghost sm", "↻ " + tr("Ask Cloudflare again")); again.onclick = () => admTurn(body, true).catch(e => admFail(e));
  const set = h("button", "btn ghost sm", tr("Limit and settings →")); set.onclick = () => admGo("settings");
  const row = h("div", "btnrow"); row.append(again, set); body.append(note, row);
  if (t && t.ping_ms) body.append(h("p", "hint", tr("People switch to the relay when their ping to the host is above {ms} ms.", { ms: t.ping_ms })));
}

// ----- settings -----
let ADM_SET = null;
async function admSettingsCache(force) {
  if (!ADM_SET || force) { const r = await aapi("GET", "settings"); ADM_SET = { raw: r }; for (const s of r.settings) ADM_SET[s.key] = s.value; }
  return ADM_SET;
}
const ADM_SETTINGS = [ // key, label, unit, to shown unit, from shown unit, help
  ["max_project_bytes", "Max size per project", "MB", v => v / 1e6, v => Math.round(v * 1e6), "All files of one project together (difficulties, song, images, storyboard). At most 95 MB (the largest upload the site's server accepts). While files are still on Supabase, its limit per file also applies (Free plan: 50 MB)."],
  ["storage_budget_bytes", "Storage budget", "MB", v => v / 1e6, v => Math.round(v * 1e6), "New uploads are refused above this total. On Cloudflare R2 (free: 10 GB) it can go up to 9500 MB; while files are on Supabase, keep it below its plan (Free: 1 GB)."],
  ["r2_class_a_month", "R2 uploads per month", "operations", v => v, v => Math.round(v), "Cloudflare R2 Class A operations (each uploaded file, each file list of the cleanup). Free tier: 1 000 000 a month, the most allowed here. Above it, saving is refused until next month."],
  ["r2_class_b_month", "R2 downloads per month", "operations", v => v, v => Math.round(v), "Cloudflare R2 Class B operations (each downloaded file, each file check when saving). Free tier: 10 000 000 a month, the most allowed here. Above it, opening online projects is refused until next month."],
  ["retention_days", "Days a project is kept", "days", v => v, v => Math.round(v), "Counted from the first online save. Applies to projects created after the change; existing projects keep their date (change one in its panel)."],
  ["max_projects_per_user", "Online projects per user", "projects", v => v, v => Math.round(v), "Active projects one person may own at the same time."],
  ["max_members_per_project", "People per project", "people", v => v, v => Math.round(v), "How many people one project can be shared with."],
  ["max_annotations", "Annotations per project", "annotations", v => v, v => Math.round(v), "Comments, arrows and highlights stored with one project."],
  ["invites_per_user", "Invites per person", "people", v => v, v => Math.round(v), "How many people each person's invite link can let in (0 = no invites). People who came in with an invite can't invite anyone until you allow it in their panel. Admins have no limit. A person's own number in their panel overrides this."]];
const PERM_ROWS = [ // area, label, help (the settings are perm_guest_<area> and perm_member_<area>)
  ["listing", "Beatmap", "Search osu! beatmaps, map details, song previews and downloads"],
  ["player", "Preview player", "Watch maps with storyboard and hitsounds, open .osz files and shared links"],
  ["mappers", "Mapper pages", "Mapper profiles: groups, badges, maps and recent activity"],
  ["editor", "Editor and modding", "Editor, Hitsound Studio, Verify, mod notes and annotations, drafts"],
  ["online", "Online features", "Online projects, live sessions, collab and invite links (needs an account)"],
  ["live", "Watch live sessions", "Join a live session from its invite link and only watch: the host's playback and edits, no editing, highlights, comments or chat. Members join live sessions with Online features."]];
async function admSettings(body) {
  const S2 = await admSettingsCache(true), raw = S2.raw, owner = ADM.role === "owner"; body.innerHTML = "";
  if (!owner) body.append(h("p", "aalert", tr("Only the site owner can change these. You can see them.")));
  const sw = h("label", "aswitch"), cb = h("input"); cb.type = "checkbox"; cb.className = "switch"; cb.checked = S2.saving_enabled !== false; cb.disabled = !owner;
  const swt = h("span", "swt"); swt.append(h("b", null, tr("Online saving")), h("small", null, tr("Off: nobody can create or save online projects (opening them still works). Use it for maintenance or when storage is nearly full.")));
  sw.append(swt, cb);
  body.append(admSection(tr("Online saving"), sw));
  const asw = h("label", "aswitch"), acb = h("input"); acb.type = "checkbox"; acb.className = "switch"; acb.checked = S2.access_required !== false; acb.disabled = !owner;
  const aswt = h("span", "swt"); aswt.append(h("b", null, tr("Invite-only")), h("small", null, tr("On: people log in with osu! and ask for access; only approved accounts (and admins) can use the site. Off: anyone can use it.")));
  asw.append(aswt, acb);
  if ("access_required" in S2) body.append(admSection(tr("Access"), asw));
  // who can use what while the site is invite-only (admins always everything)
  const permCbs = {};
  if ("perm_guest_listing" in S2) {
    const t = h("table", "aperm"), hr = h("tr");
    hr.append(h("th", null, tr("Part of the site")), h("th", null, tr("Guest")), h("th", null, tr("Member")));
    const th = h("thead"); th.append(hr); t.append(th); const tb = h("tbody");
    for (const [a, label, help] of PERM_ROWS) {
      const r = h("tr"), name = h("td"); name.append(h("b", null, tr(label)), h("small", null, tr(help))); r.append(name);
      for (const who of ["guest", "member"]) {
        const key = `perm_${who}_${a}`, td = h("td");
        if (key in S2) { const c = h("input"); c.type = "checkbox"; c.className = "switch"; c.checked = S2[key] === true; c.disabled = !owner; c.setAttribute("aria-label", `${tr(label)} · ${tr(who === "guest" ? "Guest" : "Member")}`); permCbs[key] = c; td.append(c); }
        else td.append(h("span", "adim", "—"));
        r.append(td);
      }
      tb.append(r);
    }
    t.append(tb);
    body.append(admSection(tr("Permissions"), h("p", "hint", tr("While the site is invite-only. Guest = not logged in, or logged in without approved access. Member = approved. Admins can always use everything. What someone can't use is hidden from them, and the server refuses it too.")), t));
  }
  const isw = h("label", "aswitch"), icb = h("input"); icb.type = "checkbox"; icb.className = "switch"; icb.checked = S2.invitees_can_invite === true; icb.disabled = !owner;
  if ("invitees_can_invite" in S2) {
    const iswt = h("span", "swt"); iswt.append(h("b", null, tr("People who came in with an invite can invite")), h("small", null, tr("On: everyone who joined with an invite gets a working invite link too. Off: only the people you allow in their panel. A person's own choice in their panel always wins.")));
    isw.append(iswt, icb);
    const ov = (raw.overrides.invite_limit || 0) + (raw.overrides.can_invite || 0), extra = [];
    if (ov) {
      extra.push(h("p", "hint", tr("{a} person/people have their own number of invites, {b} have their own allowed / not allowed.", { a: raw.overrides.invite_limit || 0, b: raw.overrides.can_invite || 0 })));
      if (owner) {
        const rb = h("button", "btn ghost sm", tr("Use the site settings for everyone"));
        rb.onclick = async () => { if (!(await ask(tr("Clear everyone's own invite numbers and allowed / not allowed, so the settings on this page apply to all?"), { ok: tr("Clear"), danger: true }))) return; rb.disabled = true; try { await aapi("POST", "invites/reset-all", {}); toast(tr("Everyone follows the site settings now"), 2200); admSettings(body); } catch (e) { admFail(e); rb.disabled = false; } };
        extra.push(rb);
      }
    }
    body.append(admSection(tr("Invites"), isw, h("p", "hint", tr("How many people each link lets in: \"Invites per person\" below. Admins can also make links with their own number on the Invite friends page.")), ...extra));
  }
  // TURN relay for live sessions: on/off and the ping above which people switch to it
  const tsw = h("label", "aswitch"), tcb = h("input"); tcb.type = "checkbox"; tcb.className = "switch"; tcb.checked = S2.turn_enabled !== false; tcb.disabled = !owner;
  let tping = null, tmonth = null;
  if ("turn_enabled" in S2) {
    const tswt = h("span", "swt"); tswt.append(h("b", null, tr("TURN relay in live sessions")), h("small", null, tr("Live sessions are peer-to-peer. With this on, someone whose ping to the host is above the limit below switches to Cloudflare's TURN relay by themselves, and people you pick in their panel always use it. The relay is only given out for a live session that was started.")));
    tsw.append(tswt, tcb);
    const tspec = raw.settings.find(s => s.key === "turn_ping_ms"), extra = [];
    if (tspec) {
      tping = h("input"); tping.type = "number"; tping.step = "1"; tping.min = tspec.min; tping.max = tspec.max; tping.value = tspec.value; tping.disabled = !owner; tping.addEventListener("keydown", e => e.stopPropagation());
      const row = h("div", "aset"), top = h("div", "asettop"), inw = h("div", "aliminp"); inw.append(tping, h("span", "adim", "ms"));
      top.append(h("b", null, tr("Switch to the relay above")), inw);
      row.append(top, h("small", "adim", tr("Default {d} {u} · allowed {a} to {b}", { d: tspec.default, u: "ms", a: tspec.min, b: tspec.max })));
      extra.push(row);
    }
    const mspec = raw.settings.find(s => s.key === "turn_month_gb");
    if (mspec) {
      tmonth = h("input"); tmonth.type = "number"; tmonth.step = "1"; tmonth.min = mspec.min; tmonth.max = mspec.max; tmonth.value = mspec.value; tmonth.disabled = !owner; tmonth.addEventListener("keydown", e => e.stopPropagation());
      const row = h("div", "aset"), top = h("div", "asettop"), inw = h("div", "aliminp"); inw.append(tmonth, h("span", "adim", "GB"));
      top.append(h("b", null, tr("Monthly limit")), inw);
      row.append(top, h("small", "hint", tr("Relay traffic per month (Cloudflare's numbers). Over it, nobody gets the relay until the next month. 0 = no limit. The first 1,000 GB each month are free, then $0.05 per GB.")),
        h("small", "adim", tr("Default {d} {u} · allowed {a} to {b}", { d: mspec.default, u: "GB", a: mspec.min, b: fmtInt(mspec.max) })));
      extra.push(row);
    }
    if (raw.turn_configured === false) extra.push(h("p", "aalert warn", tr("The TURN key isn't set up on the server yet: add the secrets TURN_KEY_ID and TURN_KEY_API_TOKEN (Cloudflare → Realtime → TURN). Until then live sessions stay peer-to-peer only.")));
    body.append(admSection(tr("TURN relay"), tsw, ...extra));
  }
  const form = h("div", "asettings"), inputs = {};
  for (const [key, label, unit, to, from, help] of ADM_SETTINGS) {
    const spec = raw.settings.find(s => s.key === key); if (!spec) continue;
    const row = h("div", "aset"), inp = h("input"); inp.type = "number"; inp.step = "any"; inp.value = +to(spec.value).toFixed(2); inp.disabled = !owner;
    inp.min = to(spec.min); inp.max = to(spec.max); inp.addEventListener("keydown", e => e.stopPropagation());
    const top = h("div", "asettop"), inw = h("div", "aliminp"); inw.append(inp, h("span", "adim", tr(unit)));
    top.append(h("b", null, tr(label)), inw);
    const ov = key === "max_project_bytes" ? raw.overrides.max_project_bytes : key === "retention_days" ? raw.overrides.retention_days : key === "max_projects_per_user" ? raw.overrides.max_projects : 0;
    row.append(top, h("small", "hint", tr(help)), h("small", "adim", tr("Default {d} {u} · allowed {a} to {b}", { d: +to(spec.default).toFixed(2), u: tr(unit), a: +to(spec.min).toFixed(2), b: fmtInt(+to(spec.max).toFixed(2)) }) + (ov ? " · " + tr("{n} user(s) have their own value", { n: ov }) : "")));
    inputs[key] = { inp, spec, to, from }; form.append(row);
  }
  body.append(admSection(tr("Limits"), form));
  if (owner) {
    const save = h("button", "btn main", tr("Save settings")), status = h("p", "hint");
    save.onclick = async () => {
      const values = {};
      for (const [k, { inp, spec, from }] of Object.entries(inputs)) {
        const v = Number(inp.value); if (!Number.isFinite(v)) return toast(tr("Enter a number"));
        const stored = from(v); if (stored !== spec.value) values[k] = stored;
      }
      if (cb.checked !== (S2.saving_enabled !== false)) values.saving_enabled = cb.checked;
      if ("access_required" in S2 && acb.checked !== (S2.access_required !== false)) values.access_required = acb.checked;
      if ("invitees_can_invite" in S2 && icb.checked !== (S2.invitees_can_invite === true)) values.invitees_can_invite = icb.checked;
      for (const [k, c] of Object.entries(permCbs)) if (c.checked !== (S2[k] === true)) values[k] = c.checked;
      if ("turn_enabled" in S2 && tcb.checked !== (S2.turn_enabled !== false)) values.turn_enabled = tcb.checked;
      if (tping) { const v = Number(tping.value); if (!Number.isInteger(v)) return toast(tr("Enter a number")); if (v !== S2.turn_ping_ms) values.turn_ping_ms = v; }
      if (tmonth) { const v = Number(tmonth.value); if (!Number.isInteger(v)) return toast(tr("Enter a number")); if (v !== S2.turn_month_gb) values.turn_month_gb = v; }
      if (!Object.keys(values).length) return toast(tr("Nothing changed"), 1500);
      save.disabled = true;
      try {
        const r = await aapi("POST", "settings", { values });
        toast(tr("Settings saved"), 2000);
        status.textContent = r.bucket && !r.bucket.synced ? tr("Saved. The storage bucket's own file limit couldn't be updated automatically; set it to {s} in Supabase (Storage → the obv-projects bucket).", { s: admBytes(r.bucket.bucket_limit) }) : "";
        await admSettings(body); if (status.textContent) body.append(status);
      } catch (e) { admFail(e); save.disabled = false; }
    };
    const row = h("div", "btnrow asticky"); row.append(save); body.append(row, status);
  }
  body.append(h("p", "hint", tr("Per-user limits (in a user's panel) override these for that person. Every change is recorded in the audit log.")));
  if (owner) admDatabase(body).catch(() => {});
}
// moving the database from Supabase to Cloudflare D1 (owner only; api/_lib/d1copy.js)
async function admDatabase(body) {
  const d = await aapi("GET", "database"), box = h("div");
  const where = h("p", null, tr(d.backend === "d1" ? "The site runs on Cloudflare D1." : "The site runs on Supabase."));
  box.append(where);
  if (d.backend !== "d1") {
    if (!d.d1_bound) box.append(h("p", "aalert warn", tr("No D1 database is connected to the Worker yet (binding DB).")));
    else if (!d.r2) box.append(h("p", "aalert warn", tr("Move the project files to R2 first: D1 can't see files on Supabase.")));
    else {
      box.append(h("p", "hint", tr("Copy turns online saving off, copies every table from Supabase to D1 (replacing what D1 has) and compares the rows. Then set the variable DB_BACKEND = d1 on the Worker (Settings → Variables) and turn online saving back on here. Removing the variable goes back to Supabase; what was saved on D1 stays there.")));
      const go = h("button", "btn main", tr("Copy Supabase → D1")), out = h("div");
      go.onclick = async () => {
        if (!(await ask(tr("Turn online saving off and copy everything to D1? What D1 has now is replaced."), { ok: tr("Continue"), danger: true }))) return;
        go.disabled = true; out.textContent = tr("Copying…");
        try {
          const r = await aapi("POST", "database/copy", {}); out.innerHTML = "";
          out.append(h("p", r.ok ? "aalert" : "aalert warn", tr(r.ok ? "Copied: every table has the same rows on both." : "Copied, but some tables don't match. Don't switch yet.")));
          for (const [t, c] of Object.entries(r.tables)) out.append(admRow([h("b", null, t), h("span", "anum", `${fmtInt(c.supabase)} → ${fmtInt(c.d1)}`), h("span", c.ok ? "adim" : "bad", c.ok ? "✓" : "✗")]));
          ADM_SET = null;
        } catch (e) { out.textContent = ""; admFail(e); }
        go.disabled = false;
      };
      const row = h("div", "btnrow"); row.append(go); box.append(row, out);
    }
  }
  if (d.d1_rows) box.append(h("small", "adim", tr("Rows in D1: {n}", { n: fmtInt(Object.values(d.d1_rows).reduce((a, b) => a + (b || 0), 0)) })));
  body.append(admSection(tr("Database"), box));
}

// ----- access (invite-only site) -----
const ADM_ACCESS = { pending: ["Pending approval", "warn"], approved: ["Approved", "ok"], denied: ["Denied", "bad"], none: ["Never asked", "dim"] };
function admAccessBadge(a) { const [l, c] = ADM_ACCESS[a] || [a, "dim"]; return admBadge(tr(l), "acc " + c); }
function admAccessButtons(u, after) {
  const row = h("div", "btnrow"), set = async (access, b) => {
    if (access !== "approved" && !(await ask(access === "denied" ? tr("Deny {n}'s request? They can ask again a day later.", { n: u.username }) : tr("Take away {n}'s access? They'll see the request page again.", { n: u.username }), { ok: access === "denied" ? tr("Deny") : tr("Take away"), danger: true }))) return;
    b.disabled = true;
    try { await aapi("POST", `access/${u.id}`, { access }); toast(access === "approved" ? tr("{n} can use the site now", { n: u.username }) : access === "denied" ? tr("Request denied") : tr("Access removed"), 2000); after(); }
    catch (e) { admFail(e); b.disabled = false; }
  };
  const mk = (label, access, cls) => { const b = h("button", "btn sm " + cls, tr(label)); b.onclick = e => { e.stopPropagation(); set(access, b); }; row.append(b); };
  if (u.role === "admin") { row.append(h("small", "adim", tr("Admins always have access"))); return row; }
  if (u.access !== "approved") mk("Approve", "approved", "main");
  if (u.access === "pending") mk("Deny", "denied", "ghost danger");
  if (u.access === "approved") mk("Remove access", "none", "ghost danger");
  return row;
}
async function admAccess(body, append) {
  const f = ADM.access; if (!append) f.rows = [];
  const r = await aapi("GET", `access?status=${f.status}&q=${enc(f.q)}&offset=${f.rows.length}&limit=40`);
  f.rows.push(...r.rows); f.total = r.total;
  if (r.counts) admWaitingSet("pending", r.counts.pending);
  const S2 = await admSettingsCache();
  body.innerHTML = "";
  if (S2.access_required === false) body.append(h("p", "aalert warn", tr("Access isn't required right now: everyone can use the site. Turn it on in Settings.")));
  // let someone in before they ask
  const add = h("input"); add.placeholder = tr("osu! name or id"); add.maxLength = 32;
  const addB = h("button", "btn main sm", tr("Approve"));
  addB.onclick = async () => {
    if (!add.value.trim()) return; addB.disabled = true;
    try { const x = await aapi("POST", "access", { user: add.value.trim() }); toast(tr("{n} can use the site now", { n: x.username }), 2000); add.value = ""; admAccess(body); }
    catch (e) { admFail(e); addB.disabled = false; }
  };
  const addRow = admToolbar(add, addB); addRow.onsubmit = e => { e.preventDefault(); addB.click(); };
  body.append(admSection(tr("Let someone in"), h("p", "hint", tr("Approve an osu! account before they ask (e.g. someone you invited).")), addRow));
  const chips = h("div", "chips achips");
  for (const [k, l] of [["pending", "Pending approval"], ["approved", "Approved"], ["invited", "Came in with an invite"], ["denied", "Denied"], ["", "Everyone"]]) {
    const n = k ? r.counts[k] : null, c = h("button", "chip" + (f.status === k ? " on" : ""), tr(l) + (n != null ? ` (${fmtInt(n)})` : ""));
    c.type = "button"; c.onclick = () => { f.status = k; admAccess(body); }; chips.append(c);
  }
  body.append(admToolbar(chips, admSearch(f.q, tr("osu! name or id"), v => { f.q = v; admAccess(body); })));
  if (!f.rows.length) { body.append(h("div", "empty", f.status === "pending" ? tr("No requests waiting.") : tr("No users match."))); return; }
  const list = h("div", "aacclist");
  for (const u of f.rows) {
    const row = h("div", "aaccrow"), top = h("div", "aacctop"), who = admUserName(u.id, u.username);
    who.append(admAccessBadge(u.access)); if (u.role === "admin") who.append(admBadge(tr("Admin"), "admin")); if (u.status !== "active") who.append(admStatusBadge(u.status));
    who.style.cursor = "pointer"; who.onclick = () => admOpen("user", u.id);
    const when = h("small", "adim", u.access === "pending" && u.requested_at ? tr("Requested {d}", { d: admRel(u.requested_at) || fmtDate(u.requested_at) })
      : u.decided_at ? tr("{w} by {n}", { w: fmtDate(u.decided_at), n: u.decided_by || "?" }) : tr("Last seen {d}", { d: admRel(u.last_seen_at) || "—" }));
    top.append(who, when); row.append(top);
    if (u.google) who.append(admBadge(u.google.verified ? tr("Google") : tr("Google · not verified"), u.google.verified ? "" : "warn"));
    if (u.google && !u.google.verified && u.access === "pending") row.append(h("p", "aalert warn", tr("Asked with Google: the osu! name was typed, not verified. Make sure it's really them (e.g. ask on osu!) before approving.")));
    if (u.message) row.append(h("blockquote", "anote", u.message));
    const btns = admAccessButtons(u, () => admAccess(body));
    if (u.invited_by) {
      row.append(h("small", "adim", tr("Came in with {n}'s invite", { n: u.invited_by }) + (u.can_invite ? "" : " · " + tr("can't invite yet"))));
      if (u.role !== "admin" && u.access === "approved") {
        const t = h("button", "btn ghost sm", u.can_invite ? tr("Turn their invites off") : tr("Allow them to invite"));
        t.onclick = async () => { t.disabled = true; try { await aapi("POST", `users/${u.id}/invites`, { can_invite: !u.can_invite }); admAccess(body); } catch (e) { admFail(e); t.disabled = false; } };
        btns.append(t);
      }
    }
    row.append(btns);
    list.append(row);
  }
  body.append(h("p", "acount", tr("{n} users", { n: fmtInt(f.total) })), list);
  const more = admMore(f.rows.length, f.total, () => admAccess(body, true)); if (more) body.append(more);
}

// ----- TURN relay (in a user's panel) -----
function admTurnSection(u) {
  const sw = h("label", "aswitch"), cb = h("input"); cb.type = "checkbox"; cb.className = "switch"; cb.checked = u.turn_relay;
  const swt = h("span", "swt"); swt.append(h("b", null, tr("Always use the TURN relay")), h("small", null, tr("In live sessions they skip peer-to-peer and connect through Cloudflare's TURN relay from the start. Everyone else switches to it only when their ping is high.")));
  sw.append(swt, cb);
  cb.onchange = async () => { cb.disabled = true; try { await aapi("POST", `users/${u.id}/turn`, { on: cb.checked }); toast(tr("Saved"), 1500); } catch (e) { admFail(e); cb.checked = !cb.checked; } cb.disabled = false; };
  return admSection(tr("TURN relay"), sw);
}

// ----- invites (in a user's panel) -----
function admInvitesSection(u, unlimited) {
  const I = u.invites, box = h("div", "ainv");
  if (I.invited_by) { const p = h("p", null, tr("Came in with {n}'s invite", { n: I.invited_by.username }) + (I.invited_at ? " · " + fmtDate(I.invited_at, false) : "") + " "); const o = h("button", "mlink", tr("Open")); o.onclick = () => admOpen("user", I.invited_by.id); p.append(o); box.append(p); }
  box.append(h("p", null, I.unlimited ? tr("No limit (admin) · {n} joined with their link", { n: I.used }) : tr("{a} of {b} invites used", { a: I.used, b: I.limit })));
  if (!unlimited) {
    const site = !I.invited_by || (ADM_SET || {}).invitees_can_invite === true;
    const sel = admSelect([["", tr("Follow the site setting ({v})", { v: tr(site ? "allowed" : "not allowed") })], ["on", tr("Allowed")], ["off", tr("Not allowed")]],
      I.custom_can_invite == null ? "" : I.custom_can_invite ? "on" : "off", async v => {
        try { await aapi("POST", `users/${u.id}/invites`, { can_invite: v === "" ? null : v === "on" }); toast(tr("Saved"), 1500); admReopen(); } catch (e) { admFail(e); }
      }, tr("Can invite people"));
    box.append(sel, h("p", "hint", I.can_invite ? tr("Their invite link works now.") : tr("Their invite link is off.")));
    const S2 = ADM_SET || {}, lim = admLimitField(tr("Invites"), tr("people"), I.custom_limit, S2.invites_per_user != null ? S2.invites_per_user : 3, { to: v => v, from: v => Math.round(v) }, "invite_limit", 0, 1000);
    const save = h("button", "btn main sm", tr("Save"));
    save.onclick = async () => { const v = lim.value(); if (v != null && !Number.isFinite(v)) return toast(tr("Enter a number")); save.disabled = true; try { await aapi("POST", `users/${u.id}/invites`, { invite_limit: v }); toast(tr("Saved"), 1500); admReopen(); } catch (e) { admFail(e); save.disabled = false; } };
    const lb = h("div", "alims"); lb.append(lim); box.append(lb, save);
  }
  if (!unlimited && typeof I.fx_allowed === "boolean") { // the animated invitation is a privilege
    const sw = h("label", "aswitch"), cb = h("input"); cb.type = "checkbox"; cb.className = "switch"; cb.checked = I.fx_allowed;
    const swt = h("span", "swt"); swt.append(h("b", null, tr("Can use the animated invitation")), h("small", null, tr("Lets them turn on the animated invitation for their links on their Invite friends page. Turning this off puts their links back to the normal invite page.")));
    sw.append(swt, cb);
    cb.onchange = async () => { cb.disabled = true; try { await aapi("POST", `users/${u.id}/invite-fx`, { on: cb.checked }); toast(tr("Saved"), 1500); admReopen(); } catch (e) { admFail(e); cb.checked = !cb.checked; cb.disabled = false; } };
    box.append(sw);
  }
  if (I.invited.length) {
    const l = h("div", "ainvlist"); l.append(h("small", "adim", tr("People who joined with their link")));
    for (const x of I.invited) { const b = admUserName(x.id, x.username); b.classList.add("mlink"); b.style.cursor = "pointer"; b.onclick = () => admOpen("user", x.id); if (x.access !== "approved") b.append(admAccessBadge(x.access)); l.append(b); }
    box.append(l);
  }
  return admSection(tr("Invites"), box);
}

// ----- admins -----
async function admAdmins(body) {
  const r = await aapi("GET", "admins"), owner = ADM.role === "owner"; body.innerHTML = "";
  ADM.ownerId = r.owner_id;
  const info = h("ul", "plist");
  for (const t of [tr("The site owner is set by the server (OWNER_OSU_ID) and can't be removed here."),
    tr("Admins can see every account and project, change per-user limits, suspend normal users, delete projects, change expiry dates, run the cleanup and edit the changelog."),
    tr("Only the owner can change site-wide settings, add or remove admins, or suspend an admin.")]) info.append(h("li", null, t));
  body.append(admSection(tr("Who can use this page"), info));
  const list = h("div", "alist");
  for (const a of r.admins) {
    const cells = [admUserName(a.id, a.username), admBadge(a.owner ? tr("Owner") : tr("Admin"), a.owner ? "owner" : "admin"), h("span", "adim", tr("last seen {d}", { d: admRel(a.last_seen_at) || "—" }))];
    if (owner && !a.owner) {
      const rm = h("button", "btn ghost sm danger", tr("Remove"));
      rm.onclick = async e => { e.stopPropagation(); if (!(await ask(tr("Remove {n}'s admin rights?", { n: a.username }), { ok: tr("Remove"), danger: true }))) return; try { await aapi("DELETE", `admins/${a.id}`, {}); toast(tr("Removed"), 1500); admShowTab(); } catch (err) { admFail(err); } };
      cells.push(rm);
    }
    list.append(admRow(cells, () => admOpen("user", a.id)));
  }
  body.append(admSection(tr("Admins"), list));
  if (owner) {
    const inp = h("input"); inp.placeholder = tr("osu! username or id"); inp.maxLength = 32;
    const add = h("button", "btn main sm", tr("Add admin"));
    const f = admToolbar(inp, add);
    f.onsubmit = async e => {
      e.preventDefault(); const who = inp.value.trim(); if (!who) return;
      if (!(await ask(tr("Make {n} an admin? They'll see everyone's projects and can manage users, projects and the changelog.", { n: who }), { ok: tr("Make admin") }))) return;
      add.disabled = true;
      try { await aapi("POST", "admins", { user: who }); toast(tr("{n} is now an admin", { n: who }), 2000); admShowTab(); }
      catch (err) { admFail(err); add.disabled = false; }
    };
    body.append(admSection(tr("Add an admin"), h("p", "hint", tr("They need to log in to this site with that osu! account.")), f));
  }
}

// ----- audit log -----
const ADM_ACTIONS = [["", "Everything"], ["user.", "Accounts"], ["access.", "Access"], ["invite.", "Invites"], ["admin.", "Admins"], ["settings.", "Settings"], ["project.", "Projects"], ["changelog.", "Changelog"], ["cleanup.", "Cleanup"]];
function admAuditText(a) {
  const d = a.detail || {}, n = d.username || d.title || a.target_id || "";
  const lim = () => ["max_project_bytes", "retention_days", "max_projects"].filter(k => k in d).map(k => `${tr({ max_project_bytes: "Max size per project", retention_days: "Days a project is kept", max_projects: "Online projects at once" }[k])}: ${d[k] == null ? tr("site default") : k === "max_project_bytes" ? admBytes(d[k]) : d[k]}`).join(", ");
  switch (a.action) {
    case "user.suspended": return tr("Suspended {n}", { n }) + (d.reason ? ` (${d.reason})` : "");
    case "user.active": return tr("Reactivated {n}", { n });
    case "user.limits": return tr("Changed {n}'s limits", { n }) + ": " + lim();
    case "user.note": return tr("Edited the note on {n}", { n });
    case "access.request": return tr("{n} asked for access", { n });
    case "access.approved": return tr("Approved {n}'s access", { n });
    case "access.denied": return tr("Denied {n}'s request", { n });
    case "access.none": return tr("Took away {n}'s access", { n });
    case "access.invite": return tr("{n} came in with {i}'s invite", { n, i: d.inviter_name || "?" }) + (d.note ? ` (${d.note})` : "");
    case "invite.reset": return tr("Made a new invite link");
    case "invite.follow": return tr("{n}'s invites follow the site setting again", { n });
    case "invite.link_create": return tr("Made an invite link for {m} people", { m: d.max_uses }) + (d.note ? ` (${d.note})` : "");
    case "invite.link_limit": return tr("Changed an invite link to {m} people", { m: d.to }) + (d.note ? ` (${d.note})` : "");
    case "invite.link_revoke": return tr("Turned off an invite link") + (d.note ? ` (${d.note})` : "");
    case "invite.fx_allow": return tr("Let {n} use the animated invitation", { n });
    case "turn.relay_on": return tr("{n} always uses the TURN relay now", { n });
    case "turn.relay_off": return tr("{n} uses peer-to-peer again (TURN relay only when needed)", { n });
    case "invite.fx_block": return tr("Took the animated invitation away from {n}", { n });
    case "invite.reset_all": return tr("Put everyone back on the site's invite settings");
    case "invite.allow": return tr("Allowed {n} to invite people", { n });
    case "invite.block": return tr("Turned off {n}'s invite link", { n });
    case "invite.limit": return tr("Changed {n}'s invites: {a} → {b}", { n, a: d.from == null ? tr("site default") : d.from, b: d.to == null ? tr("site default") : d.to });
    case "admin.add": return tr("Made {n} an admin", { n });
    case "admin.remove": return tr("Removed {n}'s admin rights", { n });
    case "settings.change": return tr("Changed settings") + ": " + Object.entries(d).map(([k, v]) => { const s = ADM_SETTINGS.find(x => x[0] === k); const f = x => s ? `${+s[3](x).toFixed(2)} ${tr(s[2])}` : String(x); return `${s ? tr(s[1]) : k === "saving_enabled" ? tr("Online saving") : k === "access_required" ? tr("Invite-only") : k === "invitees_can_invite" ? tr("People who came in with an invite can invite") : k === "turn_enabled" ? tr("TURN relay in live sessions") : k === "turn_ping_ms" ? tr("Switch to the relay above") : k === "turn_month_gb" ? tr("Monthly limit") : k} ${f(v.from)} → ${f(v.to)}`; }).join(", ");
    case "project.expiry": return tr("Moved the expiry of \"{t}\" to {d}", { t: n, d: fmtDate(d.to) });
    case "project.delete": return tr("Deleted the project \"{t}\"", { t: n });
    case "project.purged": return tr("Removed the files of \"{t}\" ({r})", { t: n, r: d.reason || "" });
    case "project.purged_by_admin": return tr("Files removed after an admin deleted the project");
    case "project.purge_pending": return tr("Some files couldn't be deleted yet; the cleanup retries");
    case "project.link_on": return tr("Turned on the share link of \"{t}\"", { t: n });
    case "project.link_reset": return tr("Made a new share link for \"{t}\"", { t: n });
    case "project.link_off": return tr("Turned off the share link of \"{t}\"", { t: n });
    case "changelog.create": return tr("Created the changelog entry \"{t}\"", { t: n });
    case "changelog.edit": return tr("Edited the changelog entry \"{t}\"", { t: n });
    case "changelog.publish": return tr("Published \"{t}\"", { t: n });
    case "changelog.unpublish": return tr("Unpublished \"{t}\"", { t: n });
    case "changelog.reorder": return tr("Moved \"{t}\" in the changelog", { t: n });
    case "changelog.delete": return tr("Deleted the changelog entry \"{t}\"", { t: n });
    case "cleanup.run": return tr("Ran the cleanup") + (d.purged != null ? `: ${tr("{p} projects deleted, {g} old files removed, {w} still pending", { p: d.purged, g: d.gc_deleted, w: d.pending })}` : "");
  }
  return `${a.action} ${JSON.stringify(d).slice(0, 160)}`;
}
function admAuditList(rows) {
  const l = h("div", "alist audit");
  if (!rows.length) l.append(h("p", "hint", tr("Nothing yet.")));
  for (const a of rows) {
    const who = a.actor_name || (a.actor ? "#" + a.actor : tr("system"));
    const go = a.target_type === "user" && a.target_id ? () => admOpen("user", +a.target_id) : a.target_type === "project" && /^[0-9a-f-]{36}$/.test(a.target_id || "") && !/purged/.test(a.action) ? () => admOpen("project", a.target_id) : null;
    l.append(admRow([admWhenEl(a.at), h("b", "awho", who), h("span", "atext", admAuditText(a))], go));
  }
  return l;
}
async function admAudit(body, append) {
  const f = ADM.audit;
  if (!append) f.rows = [];
  const r = await aapi("GET", `audit?action=${enc(f.action)}&q=${enc(f.q)}&offset=${f.rows.length}&limit=50`);
  f.rows.push(...r.rows); f.total = r.total;
  body.innerHTML = "";
  body.append(admToolbar(admSearch(f.q, tr("Name, id or text"), v => { f.q = v; admAudit(body); }), admSelect(ADM_ACTIONS, f.action, v => { f.action = v; admAudit(body); }, tr("Show"))),
    h("p", "acount", tr("{n} entries · admin actions and automatic deletions; file contents and secrets are never logged", { n: fmtInt(f.total) })), admAuditList(f.rows));
  const more = admMore(f.rows.length, f.total, () => admAudit(body, true)); if (more) body.append(more);
}

// ---------- errors: the site broke in someone's browser (core.js sends a short report; nothing about the person) ----------
async function admErrors(body, append) {
  const f = ADM.errors;
  if (!append) f.rows = [];
  const r = await aapi("GET", `errors?resolved=${f.resolved ? 1 : 0}&kind=${f.kind}&offset=${f.rows.length}&limit=30`);
  f.rows.push(...r.rows); f.total = r.total; admWaitingSet("errors", r.open);
  body.innerHTML = "";
  const tabs = h("div", "achips"), oe = r.open_errors != null ? r.open_errors : r.open;
  for (const [res, kind, l] of [[false, "error", tr("New errors ({n})", { n: fmtInt(oe) })], [false, "report", tr("Reports ({n})", { n: fmtInt(r.open_reports || 0) })], [true, f.kind, tr("Fixed")]]) {
    const b = h("button", "chip" + (f.resolved === res && (res || f.kind === kind) ? " on" : ""), l); b.type = "button"; b.onclick = () => { f.resolved = res; f.kind = kind; admErrors(body); }; tabs.append(b);
  }
  body.append(tabs, h("p", "acount", f.kind === "report" && !f.resolved ? tr("What visitors wrote with \"Report a problem\", with the kind of page, the site's version and the browser; their osu! name only if they chose to add it.")
    : tr("Errors in the site's own code, reported by visitors' browsers. Only the error, where in the code, the kind of page, the site's version and the browser; nothing about the person. Rows not seen for 60 days are removed.")));
  if (f.resolved && f.rows.length) {
    const clr = h("button", "btn ghost sm", tr("Delete all fixed")); clr.onclick = async () => {
      if (!(await ask(tr("Delete every error marked as fixed?"), { ok: tr("Delete"), danger: true }))) return;
      try { await aapi("POST", "errors", { clear: true }); admErrors(body); } catch (e) { admFail(e); }
    }; body.append(clr);
  }
  const l = h("div", "alist aerrs");
  if (!f.rows.length) l.append(h("p", "hint", f.resolved ? tr("Nothing yet.") : f.kind === "report" ? tr("No reports.") : tr("No new errors.")));
  for (const e of f.rows) {
    const rep = e.kind === "report", card = h("details", "aerr" + (rep ? " rep" : "")), sum = h("summary");
    sum.append(h("b", "aerrmsg", rep && e.message.length > 140 ? e.message.slice(0, 140) + "…" : e.message),
      h("span", "aerrmeta", [rep ? "💬 " + (e.reporter || tr("anonymous")) : tr("{n}×", { n: fmtInt(e.count) }), e.page, e.browser, e.version && "v" + e.version].filter(Boolean).join(" · ")), admWhenEl(e.last_at));
    if (rep && e.message.length > 140) card.dataset.full = "1";
    const btn = h("button", "btn ghost sm", e.resolved_at ? tr("Open again") : rep ? tr("Mark as done") : tr("Mark as fixed"));
    btn.onclick = async () => { btn.disabled = true; try { await aapi("POST", "errors", { sig: e.sig, resolved: !e.resolved_at }); admErrors(body); } catch (x) { btn.disabled = false; admFail(x); } };
    const copy = h("button", "btn ghost sm", tr("Copy")); copy.onclick = () => navigator.clipboard.writeText([e.message, e.source, e.stack, e.reporter && "from: " + e.reporter, `page: ${e.page} · ${e.browser} · v${e.version} · ${e.count}×`].filter(Boolean).join("\n")).then(() => toast(tr("Copied"), 1200), () => {});
    const det = h("div", "aerrbody");
    if (rep) det.append(h("p", "aerrfull", e.message));
    det.append(h("small", null, rep ? fmtDate(e.first_at) : tr("First seen {a} · last seen {b}", { a: fmtDate(e.first_at), b: fmtDate(e.last_at) })));
    if (e.source) det.append(h("code", null, e.source));
    if (e.stack) det.append(h("pre", null, e.stack));
    const row = h("div", "btnrow"); row.append(btn, copy); det.append(row);
    card.append(sum, det); l.append(card);
  }
  body.append(l);
  const more = admMore(f.rows.length, f.total, () => admErrors(body, true)); if (more) body.append(more);
}
// keep the counts on the tabs and on the account button up to date
function admWaitingSet(k, n) {
  admBadgeSet(k === "pending" ? "access" : "errors", n);
  if (CLOUD.me && CLOUD.me.badges && CLOUD.me.badges[k] !== n) { CLOUD.me.badges[k] = n; renderAccount(); }
}
// a count on an Admin tab (and on the account menu's Admin link: live.js)
function admBadgeSet(tab, n) {
  const b = document.querySelector(`.anavb[data-tab="${tab}"]`); if (!b) return;
  let c = b.querySelector(".acnt"); if (!n) { if (c) c.remove(); return; }
  if (!c) { c = h("span", "acnt"); b.append(c); } c.textContent = n > 99 ? "99+" : n;
}

// ---------- changelog management ----------
async function admChangelog(body) {
  const r = await aapi("GET", "changelog"); ADM.cl = r.entries; body.innerHTML = "";
  const top = h("div", "btnrow"), add = h("button", "btn main sm", tr("New entry")); add.onclick = () => clEdit(body, null);
  const view = h("a", "btn ghost sm", tr("View the public page")); view.href = "?view=changelog"; view.target = "_blank";
  top.append(add, view); body.append(top, h("p", "hint", tr("Published entries show on the public Changelog page immediately (no redeploy). Drafts are only visible here. Order: top of this list = top of the page.")));
  const list = h("div", "cllist");
  ADM.cl.forEach((e, i) => {
    const row = h("div", "clrow " + e.status), info = h("div", "clinfo");
    info.append(h("b", null, `${e.version_label ? e.version_label + " · " : ""}${e.title}`), h("small", null, `${tr(e.status === "published" ? "Published" : "Draft")}${e.published_at ? " · " + fmtDate(e.published_at, false) : ""} · ${tr("edited {d}", { d: fmtDate(e.updated_at) })}`));
    const acts = h("div", "clacts");
    const btn = (label, fn, cls = "btn ghost sm") => { const b = h("button", cls, label); b.onclick = fn; acts.append(b); return b; };
    btn(tr("Edit"), () => clEdit(body, e));
    const up = btn("↑", () => clMove(body, e, 1)); up.disabled = i === 0; up.title = tr("Move up");
    const dn = btn("↓", () => clMove(body, e, -1)); dn.disabled = i === ADM.cl.length - 1; dn.title = tr("Move down");
    btn(e.status === "published" ? tr("Unpublish") : tr("Publish"), () => clSave(body, e, { ...clFields(e), status: e.status === "published" ? "draft" : "published" }));
    btn(tr("Delete"), async () => {
      if (!(await ask(tr("Delete the changelog entry \"{t}\"? This can't be undone.", { t: e.title }), { ok: tr("Delete"), danger: true }))) return;
      try { await aapi("DELETE", `changelog/${e.id}`, {}); toast(tr("Deleted")); admChangelog(body); } catch (err) { toast(tr("Failed: {err}", { err: cloudErrText(err) }), 4000); }
    }, "btn ghost sm danger");
    row.append(info, acts); list.append(row);
  });
  body.append(list);
}
const clFields = e => ({ title: e.title, versionLabel: e.version_label, content: e.content_md, status: e.status, publishedAt: e.published_at });
async function clMove(body, e, dir) { try { await aapi("POST", `changelog/${e.id}/move`, { dir }); admChangelog(body); } catch (err) { toast(tr("Failed: {err}", { err: cloudErrText(err) }), 4000); } }
async function clSave(body, e, f, status) {
  const payload = { ...f, id: e ? e.id : undefined, baseUpdatedAt: e ? e.updated_at : undefined };
  if (status) status.textContent = tr("Saving…"), status.className = "clstatus saving";
  try {
    const r = await aapi("POST", "changelog", payload);
    if (status) { status.textContent = tr("Saved {t}", { t: new Date().toLocaleTimeString() }); status.className = "clstatus ok"; }
    toast(r.entry.status === "published" ? tr("Saved and published") : tr("Saved as a draft (not public)"), 2500);
    return r.entry;
  } catch (err) {
    const msg = err.code === "conflict" ? tr("This entry was changed somewhere else (another tab?). Reload it before saving.") : err.code === "bad_request" ? tr("Check the fields: a title is required; the text is limited to 20,000 characters.") : cloudErrText(err);
    if (status) { status.textContent = tr("Not saved: {err}", { err: msg }); status.className = "clstatus err"; } else toast(tr("Failed: {err}", { err: msg }), 5000);
    return null;
  } finally { if (!status) admChangelog(body); }
}
function clEdit(body, e) {
  body.innerHTML = "";
  let cur = e;
  const form = h("div", "cledit"), left = h("div", "clform"), right = h("div", "clpreview");
  const field = (label, el) => { const l = h("label", "cf"); l.append(h("span", null, label), el); left.append(l); return el; };
  const title = field(tr("Title"), h("input")); title.maxLength = 200; title.value = e ? e.title : "";
  const ver = field(tr("Version label (optional)"), h("input")); ver.maxLength = 40; ver.value = e ? e.version_label : ""; ver.placeholder = "v12";
  const date = field(tr("Publication date"), h("input")); date.type = "date"; date.value = e && e.published_at ? String(e.published_at).slice(0, 10) : "";
  const ta = field(tr("Text (Markdown: **bold**, - lists, [link](https://…))"), h("textarea")); ta.maxLength = 20000; ta.rows = 14; ta.value = e ? e.content_md : "";
  const count = h("small", "hint"), status = h("p", "clstatus");
  left.append(count, status);
  for (const el of [title, ver, date, ta]) el.addEventListener("keydown", ev => ev.stopPropagation());
  const preview = () => {
    right.innerHTML = ""; right.append(h("small", "hint", tr("Preview")));
    const s = h("section", "clog"), hd = h("div", "clh"); hd.append(h("b", null, ver.value || ""), h("span", "cltitle", title.value || tr("(no title)")), date.value ? h("small", null, date.value) : "");
    const c = h("div", "md"); c.append(mdRender(ta.value)); s.append(hd, c); right.append(s);
    count.textContent = tr("{n} / 20,000 characters", { n: fmtInt(ta.value.length) });
    status.textContent = cur && !status.dataset.touched ? "" : tr("Unsaved changes"); status.className = "clstatus";
  };
  for (const el of [title, ver, date, ta]) el.addEventListener("input", () => { status.dataset.touched = "1"; preview(); });
  const fields = st => ({ title: title.value.trim(), versionLabel: ver.value.trim(), content: ta.value, status: st, publishedAt: date.value ? new Date(date.value + "T12:00:00Z").toISOString() : null });
  const valid = () => { if (!title.value.trim()) { status.textContent = tr("A title is required"); status.className = "clstatus err"; title.focus(); return false; } return true; };
  const acts = h("div", "btnrow sticky");
  const save = async st => { if (!valid()) return; const r = await clSave(body, cur, fields(st), status); if (r) { cur = r; delete status.dataset.touched; if (cur.published_at) date.value = String(cur.published_at).slice(0, 10); pub.textContent = cur.status === "published" ? tr("Update (published)") : tr("Publish"); unpub.hidden = cur.status !== "published"; } };
  const draft = h("button", "btn ghost", tr("Save draft")); draft.onclick = () => save("draft");
  const pub = h("button", "btn main", e && e.status === "published" ? tr("Update (published)") : tr("Publish")); pub.onclick = () => save("published");
  const unpub = h("button", "btn ghost", tr("Unpublish")); unpub.hidden = !(e && e.status === "published"); unpub.onclick = () => save("draft");
  const back = h("button", "btn ghost", tr("Back to the list")); back.onclick = async () => { if (status.dataset.touched && !(await ask(tr("Leave without saving your changes?"), { ok: tr("Leave"), danger: true }))) return; admChangelog(body); };
  acts.append(back, draft, unpub, pub);
  form.append(left, right); body.append(form, acts);
  preview(); status.textContent = "";
}
