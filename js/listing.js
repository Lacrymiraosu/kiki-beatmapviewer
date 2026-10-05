"use strict";
// ============ song select extras: the Filters panel, osu! details of a map, mapper profile pages ============

// ---------- Filters (like the osu! beatmap listing): sort, genre, language, player tags, ranges, extras ----------
const ADV = { open: false, cat: "", tip: null, pending: null, timer: 0, tags: null };
const curF = () => ADV.pending || (R.ctx && !R.ctx.u && R.ctx.f) || fEmpty();
const fClone = f => JSON.parse(JSON.stringify(f));
function setF(mut, now) { // change the current list's filters; quick taps are gathered into one search
  const f = fClone(curF()); mut(f); ADV.pending = f; advRender(); syncAdvChip();
  clearTimeout(ADV.timer);
  ADV.timer = setTimeout(() => { const f2 = ADV.pending; ADV.pending = null; goList({ ...(R.ctx || { q: "", st: defSt() }), u: "", f: f2 }, false); }, now ? 0 : 450);
}
// search for maps with a filter (from a map's details or a profile): leaves the map, opens the list
function searchWith(fp, q = "") {
  const url = listURL({ q, u: "", st: "", f: { ...fEmpty(), ...fp } });
  if (R.inMap) { hideDetail(); R.inMap = false; R.mapPushed = false; history.replaceState(null, "", url); } else history.pushState(null, "", url);
  if (UI.player.hidden) { route(); scrollTo(0, 0); }
}
function advChip() {
  const n = fCount(curF()), b = h("button", "chip fchip" + (ADV.open ? " open" : "") + (n ? " has" : ""));
  b.id = "advChip"; b.type = "button"; b.setAttribute("aria-expanded", ADV.open);
  b.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`;
  b.append(h("span", null, tr("Filters")), h("b", "fcount", n ? String(n) : ""));
  b.onclick = () => { ADV.open = !ADV.open; syncAdvChip(); advRender(); if (ADV.open) $("advPanel").scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  return b;
}
function syncAdvChip() { const b = $("advChip"); if (b) b.replaceWith(advChip()); }
const sortLabel = so => { const [k, dir] = so.split("_"); const x = SORTS.find(s => s[0] === k); return (x ? tr(x[1]) : k) + (dir === "asc" ? " ↑" : " ↓"); };
function advRender() {
  const box = $("advPanel"), pills = $("advPills"); if (!box || !pills) return;
  const onList = R.view === "songs" && !(R.ctx && R.ctx.u), f = curF();
  // what's on, as removable pills (also while the panel is closed)
  pills.innerHTML = ""; pills.hidden = !onList || !fCount(f);
  const pill = (label, rm, title) => { const b = h("button", "fpill"); b.type = "button"; b.append(h("span", null, label), h("b", null, "×")); b.title = title || tr("Remove this filter"); b.onclick = () => setF(rm, true); pills.append(b); };
  if (f.g) pill(tr(genreName(f.g)), x => { x.g = 0; });
  if (f.l) pill(tr(langName(f.l)), x => { x.l = 0; });
  if (f.k) pill(`${f.k}K`, x => { x.k = 0; }, tr("osu!mania keys: remove this filter"));
  for (const t of f.tags) pill(`${catLabel(tagCat(t))}: ${tagShort(t)}`, x => { x.tags = x.tags.filter(y => y !== t); });
  for (const [k, , label] of RANGES) { const v = f.r[k]; if (v) pill(`${tr(label)} ${v[0] ?? "0"}–${v[1] ?? "∞"}`, x => { delete x.r[k]; }); }
  if (f.video) pill(tr("Has video"), x => { x.video = false; });
  if (f.sb) pill(tr("Has storyboard"), x => { x.sb = false; });
  if (f.nsfw) pill(tr("Explicit content"), x => { x.nsfw = false; });
  if (f.sort) pill(sortLabel(f.sort), x => { x.sort = ""; });
  if (fCount(f) > 1) { const c = h("button", "mlink", tr("Clear all")); c.type = "button"; c.onclick = () => setF(x => Object.assign(x, fEmpty()), true); pills.append(c); }
  box.hidden = !onList || !ADV.open;
  if (box.hidden) return;
  box.innerHTML = "";
  const sec = (label, ...kids) => { const r = h("div", "advrow"); r.append(h("div", "advl", tr(label))); const c = h("div", "advc"); c.append(...kids); r.append(c); box.append(r); return c; };
  const chip = (label, on, click, title) => { const b = h("button", "chip sm" + (on ? " on" : ""), label); b.type = "button"; b.setAttribute("aria-pressed", !!on); if (title) b.title = title; b.onclick = click; return b; };
  // sort
  const ds = defSort(R.ctx && R.ctx.q, R.ctx && R.ctx.st), cur = f.sort || ds, sorts = SORTS.map(([k, l]) => {
    const on = cur.startsWith(k + "_"), dir = on ? cur.split("_")[1] : (k === "title" || k === "artist" ? "asc" : "desc");
    const pick = s2 => s2 === ds ? "" : s2; // the default isn't written in the link
    return chip(tr(l) + (on ? (dir === "asc" ? " ↑" : " ↓") : ""), on, () => setF(x => { x.sort = pick(on ? (dir === "asc" ? `${k}_desc` : `${k}_asc`) : `${k}_${dir}`); }), on ? tr("Tap again to reverse") : "");
  });
  sec("Sort by", ...sorts);
  if (gameMode() === 3) sec("Keys", chip(tr("Any"), !f.k, () => setF(x => { x.k = 0; })), ...KEY_COUNTS.map(k => chip(`${k}K`, f.k === k, () => setF(x => { x.k = x.k === k ? 0 : k; }))));
  sec("Genre", chip(tr("Any"), !f.g, () => setF(x => { x.g = 0; })), ...GENRES.map(([id, l]) => chip(tr(l), f.g === id, () => setF(x => { x.g = x.g === id ? 0 : id; }))));
  sec("Language", chip(tr("Any"), !f.l, () => setF(x => { x.l = 0; })), ...LANGUAGES.map(([id, l]) => chip(tr(l), f.l === id, () => setF(x => { x.l = x.l === id ? 0 : id; }))));
  sec("Extra", chip(tr("Has video"), f.video, () => setF(x => { x.video = !x.video; })), chip(tr("Has storyboard"), f.sb, () => setF(x => { x.sb = !x.sb; })),
    chip(tr("Explicit content"), f.nsfw, () => setF(x => { x.nsfw = !x.nsfw; }), tr("Also show maps marked explicit")));
  // ranges
  const rg = h("div", "advranges");
  for (const [k, , label, step] of RANGES) {
    const r = h("label", "advrange"), v = f.r[k] || [null, null], a = h("input"), b = h("input");
    for (const [inp, i] of [[a, 0], [b, 1]]) {
      inp.type = "number"; inp.min = 0; inp.step = step; inp.inputMode = "decimal"; inp.placeholder = i ? tr("max") : tr("min"); inp.setAttribute("aria-label", tr(label) + " " + inp.placeholder); inp.value = v[i] ?? "";
      inp.onchange = () => setF(x => { const cur = x.r[k] || [null, null], n = inp.value === "" ? null : Math.max(0, +inp.value); cur[i] = isNaN(n) ? null : n; if (cur[0] == null && cur[1] == null) delete x.r[k]; else x.r[k] = cur; }, true);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
    }
    r.append(h("span", null, tr(label)), a, h("i", null, "–"), b); rg.append(r);
  }
  sec("Ranges", rg, h("p", "hint", tr("A map matches when any of its difficulties is in range. Length is in seconds.")));
  // player tags
  const tc = sec("Player tags");
  if (osuApi.ok === false) tc.append(h("p", "hint", tr("Tags need the osu! connection, which isn't available on this site.")));
  else if (!ADV.tags) { tc.append(h("p", "hint", tr("Loading tags…"))); osuTags().then(t => { ADV.tags = t; if (ADV.open) advRender(); }); }
  else if (!ADV.tags.length) tc.append(h("p", "hint", tr("Couldn't load the tags.")));
  else renderTagPicker(tc, f);
  const foot = h("div", "advfoot"), reset = h("button", "btn ghost sm", tr("Reset filters")), close = h("button", "btn ghost sm", tr("Close"));
  reset.type = close.type = "button"; reset.disabled = !fCount(f);
  reset.onclick = () => setF(x => Object.assign(x, fEmpty()), true);
  close.onclick = () => { ADV.open = false; syncAdvChip(); advRender(); };
  foot.append(h("p", "hint", tr("Filters use the same search as the osu! website.")), reset, close);
  box.append(foot);
}
function renderTagPicker(box, f) {
  const cats = [...TAG_CATS.map(c => c[0]), ...new Set(ADV.tags.map(t => tagCat(t.name)).filter(c => !TAG_CATS.some(k => k[0] === c)))].filter(c => ADV.tags.some(t => tagCat(t.name) === c));
  if (!cats.includes(ADV.cat)) ADV.cat = (f.tags[0] && tagCat(f.tags[0])) || cats[0];
  const tabs = h("div", "tagtabs");
  for (const c of cats) {
    const n = f.tags.filter(t => tagCat(t) === c).length, b = h("button", "tagtab" + (c === ADV.cat ? " on" : ""), catLabel(c) + (n ? ` · ${n}` : ""));
    b.type = "button"; b.onclick = () => { ADV.cat = c; ADV.tip = null; advRender(); };
    tabs.append(b);
  }
  const list = h("div", "taglist"), tip = h("p", "tagtip");
  const showTip = t => { tip.innerHTML = ""; if (!t) { tip.append(tr("Tap a tag to find maps players gave it. Hover or long-press to read what it means.")); return; } tip.append(h("b", null, t.name), " — ", t.description || tr("(no description)")); };
  for (const t of ADV.tags.filter(t => tagCat(t.name) === ADV.cat).sort((a, b) => a.name.localeCompare(b.name))) {
    const on = f.tags.includes(t.name), b = h("button", "chip sm tagchip" + (on ? " on" : ""), tagShort(t.name));
    b.type = "button"; b.title = t.description || ""; b.setAttribute("aria-pressed", on);
    b.onmouseenter = b.onfocus = () => showTip(t); b.onmouseleave = () => showTip(ADV.tip);
    b.onclick = () => { ADV.tip = t; setF(x => { x.tags = on ? x.tags.filter(y => y !== t.name) : [...x.tags, t.name].slice(-8); }); };
    list.append(b);
  }
  showTip(ADV.tip);
  box.append(tabs, list, tip);
}

// ---------- a map's details from osu!: genre, language, player tags, mapper tags, nominators, rating ----------
async function renderSetMeta(box, info) {
  if (!box) return; box.innerHTML = "";
  if (!info || !info.sid) return;
  const draw = set => {
    box.innerHTML = "";
    const g = set ? set.genre && set.genre.id : info.genre, l = set ? set.language && set.language.id : info.language;
    const row = h("div", "dmrow");
    const link = (label, title, go) => { const b = h("button", "dmchip", label); b.type = "button"; b.title = title; b.onclick = go; return b; };
    if (g && g !== 1) row.append(link(tr(genreName(g) || (set && set.genre.name) || "?"), tr("Genre: find more maps like this"), () => searchWith({ g })));
    if (l && l !== 1) row.append(link(tr(langName(l) || (set && set.language.name) || "?"), tr("Language: find more maps like this"), () => searchWith({ l })));
    if (set && set.rating) { const e = h("em", "dmrate", `★ ${set.rating.avg.toFixed(1)}`); e.title = tr("Players' rating ({n} votes)", { n: fmtInt(set.rating.n) }); row.append(e); }
    if (info.nsfw || (set && set.nsfw)) row.append(h("em", "dmnsfw", tr("Explicit")));
    if (row.children.length) box.append(row);
    if (set && set.nominators && set.nominators.length) {
      const nr = h("div", "dmnoms"); nr.append(h("span", "dml", tr("Nominated by")));
      for (const n of set.nominators) { const a = mapperLink(n.username || "#" + n.id, "dmnom"); a.prepend(avatarEl(n.id, n.username, "cav")); if (n.groups.length) a.append(h("small", null, n.groups.join(" "))); nr.append(a); }
      box.append(nr);
    }
    // player tags: votes across the difficulties (the highest count of each tag), grouped by category
    if (set && set.related_tags && set.related_tags.length) {
      const votes = new Map(); for (const b of set.map_tags || []) for (const t of b.tags) votes.set(t.name, Math.max(votes.get(t.name) || 0, t.count));
      const desc = new Map(set.related_tags.map(t => [t.name, t.description])), byCat = new Map();
      for (const t of set.related_tags) { const c = tagCat(t.name); if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(t.name); }
      const sec = h("div", "dmtags"), tip = h("p", "tagtip");
      sec.append(h("div", "dml", tr("Player tags")));
      const order = [...TAG_CATS.map(c => c[0]), ...byCat.keys()];
      for (const c of [...new Set(order)].filter(c => byCat.has(c))) {
        const line = h("div", "dmtagrow"); line.append(h("span", "dmcat", catLabel(c)));
        for (const n of byCat.get(c).sort((a, b) => (votes.get(b) || 0) - (votes.get(a) || 0))) {
          const b = h("button", "dmtag"); b.type = "button"; b.title = desc.get(n) || "";
          b.append(tagShort(n)); if (votes.get(n)) b.append(h("small", null, String(votes.get(n))));
          b.onmouseenter = b.onfocus = () => { tip.innerHTML = ""; tip.append(h("b", null, n), " — ", desc.get(n) || ""); };
          b.onclick = () => searchWith({ tags: [n] });
          line.append(b);
        }
        sec.append(line);
      }
      tip.textContent = tr("Tap a tag to find more maps with it.");
      sec.append(tip); box.append(sec);
    }
    // the mapper's own search tags
    const mt = [...new Set(String((set ? set.tags : info.tags) || "").split(/\s+/).filter(Boolean))].slice(0, 40);
    if (mt.length) {
      const sec = h("div", "dmtags"); sec.append(h("div", "dml", tr("Mapper tags")));
      const line = h("div", "dmtagrow mt");
      for (const t of mt) { const b = h("button", "dmtag plain", t); b.type = "button"; b.title = tr("Search for \"{q}\"", { q: t }); b.onclick = () => searchWith({}, t); line.append(b); }
      sec.append(line); box.append(sec);
    }
  };
  draw(null);
  const set = await osuSet(info.sid);
  if (set && detailInfo === info && !$("detail").hidden) draw(set);
}

// ---------- mapper profile (osu! profile through our server) ----------
// the role people know a mapper by: osu! groups first (NAT, BN, ...), else what they've mapped
const MAP_GROUPS = ["nat", "bng", "bng_limited", "gmt", "loved", "bsc", "alumni"];
const MODE_NAME = { osu: "osu!", taiko: "osu!taiko", fruits: "osu!catch", mania: "osu!mania" };
function mapperRole(u) {
  const g = (u.groups || []).slice().sort((a, b) => (MAP_GROUPS.indexOf(a.identifier) + 1 || 99) - (MAP_GROUPS.indexOf(b.identifier) + 1 || 99))[0];
  if (g && MAP_GROUPS.includes(g.identifier)) return (g.probationary ? tr("Probationary") + " " : "") + g.name + (g.playmodes.length ? ` (${g.playmodes.map(m => MODE_NAME[m] || m).join(", ")})` : "");
  const c = u.counts;
  if (c.ranked) return tr("Ranked mapper");
  if (c.loved) return tr("Mapper with loved maps");
  if (c.guest) return tr("Guest mapper");
  if (c.pending || c.graveyard) return tr("Mapper (no ranked maps yet)");
  return tr("No maps yet");
}
function relTime(d) {
  const ms = new Date(d) - Date.now(); if (!d || isNaN(ms)) return "";
  const rtf = new Intl.RelativeTimeFormat(LANG || undefined, { numeric: "auto" }), a = Math.abs(ms);
  return a < 36e5 ? rtf.format(Math.round(ms / 6e4), "minute") : a < 864e5 * 2 ? rtf.format(Math.round(ms / 36e5), "hour") : a < 864e5 * 60 ? rtf.format(Math.round(ms / 864e5), "day") : rtf.format(Math.round(ms / (864e5 * 30.4)), "month");
}
// a flag picture (Windows has no emoji flags: it would show just the letters): osu!'s own flag images (twemoji),
// then the twemoji CDN, then the letters
function flagEl(cc, name) {
  cc = String(cc).toUpperCase(); if (!/^[A-Z]{2}$/.test(cc)) return h("span", "flag", cc);
  const cp = [...cc].map(c => (127397 + c.charCodeAt(0)).toString(16)).join("-"), img = h("img", "flag");
  const srcs = [`https://osu.ppy.sh/assets/images/flags/${cp}.svg`, `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${cp}.svg`];
  img.alt = cc; img.title = name || cc; img.referrerPolicy = "no-referrer"; img.src = srcs.shift();
  img.onerror = () => { if (srcs.length) img.src = srcs.shift(); else img.replaceWith(h("span", "flag", cc)); };
  return img;
}
function renderUserHead(box, u) {
  R.userChips = true;
  box.classList.add("prof");
  box.classList.toggle("hascover", !!u.cover_url);
  if (u.cover_url) box.style.setProperty("--cover", `url("${u.cover_url}")`); else box.style.removeProperty("--cover");
  if (u.profile_hue != null) box.style.setProperty("--hue", u.profile_hue); else box.style.removeProperty("--hue");
  const top = h("div", "ptop"), info = h("div", "minfo"), name = h("h2", null, u.username);
  if (u.country_code) name.prepend(flagEl(u.country_code, u.country), " ");
  if (u.is_supporter) { const s = h("span", "psup", "♥".repeat(Math.max(1, Math.min(3, u.support_level || 1)))); s.title = tr("osu!supporter"); name.append(s); }
  info.append(name);
  if (u.groups && u.groups.length) {
    const gr = h("div", "pgroups");
    for (const g of u.groups) {
      const b = h("span", "pgroup" + (g.probationary ? " prob" : "")); if (g.colour) b.style.setProperty("--gc", g.colour);
      b.append(h("b", null, g.short), h("span", null, g.name + (g.playmodes.length ? " · " + g.playmodes.map(m => MODE_NAME[m] || m).join(", ") : "")));
      b.title = g.name + (g.probationary ? " (" + tr("probation") + ")" : ""); gr.append(b);
    }
    info.append(gr);
  }
  if (!(u.groups || []).some(g => MAP_GROUPS.includes(g.identifier))) info.append(h("p", "prole", mapperRole(u))); // a mapping group already says it
  const seen = u.is_online ? tr("online now") : u.last_visit ? tr("last seen {t}", { t: relTime(u.last_visit) }) : "";
  info.append(h("p", "pmeta", [u.title, u.join_date ? tr("joined {d}", { d: fmtDate(u.join_date, false) }) : "", seen, u.previous_usernames.length ? tr("formerly {n}", { n: u.previous_usernames.slice(0, 3).join(", ") }) : ""].filter(Boolean).join(" · ")));
  top.append(avatarEl(u.id, u.username, "mav"), info);
  box.append(top);
  // badges
  if (u.badges && u.badges.length) {
    const bd = h("div", "pbadges");
    for (const b of u.badges) { const im = h("img"); im.src = b.image; im.alt = b.description; im.title = b.description + (b.at ? ` (${fmtDate(b.at, false)})` : ""); im.loading = "lazy"; im.referrerPolicy = "no-referrer"; im.onerror = () => im.remove(); bd.append(im); }
    box.append(bd);
  }
  // mapping numbers (tap one to open that list), then player numbers
  const tiles = h("div", "ptiles"), tile = (label, v, st) => {
    if (v == null) return; const t = h(st ? "button" : "div", "ptile" + (st && R.ctx && R.ctx.st === st ? " on" : "")); t.append(h("b", null, v), h("span", null, tr(label)));
    if (st) { t.type = "button"; t.onclick = () => goList({ ...R.ctx, st }, false); } tiles.append(t);
  };
  const c = u.counts;
  tile("Ranked", fmtInt(c.ranked), c.ranked ? "ranked" : null); tile("Loved", fmtInt(c.loved), c.loved ? "loved" : null); tile("Guest difficulties", fmtInt(c.guest), c.guest ? "guest" : null);
  tile("Nominated", fmtInt(c.nominated), c.nominated ? "nominated" : null); tile("Pending", fmtInt(c.pending), c.pending ? "pending" : null); tile("Graveyard", fmtInt(c.graveyard), c.graveyard ? "graveyard" : null);
  tile("Mapping followers", u.mapping_followers != null ? fmtInt(u.mapping_followers) : null); tile("Kudosu", u.kudosu != null ? fmtInt(u.kudosu) : null);
  box.append(tiles);
  const st = u.stats, ps = h("div", "pstats"), stat = (label, v) => { if (v == null || v === "") return; const s = h("span"); s.append(h("b", null, v), " " + tr(label)); ps.append(s); };
  if (st.global_rank) stat("global rank", "#" + fmtInt(st.global_rank));
  if (st.country_rank) stat("country rank", "#" + fmtInt(st.country_rank));
  if (st.pp) stat("pp", fmtInt(Math.round(st.pp)));
  if (st.accuracy) stat("accuracy", st.accuracy.toFixed(2) + "%");
  if (st.play_count) stat("plays", fmtInt(st.play_count));
  if (st.level) stat("level", String(st.level));
  if (st.rank_highest) stat("highest rank", "#" + fmtInt(st.rank_highest.rank));
  if (u.medals) stat("medals", fmtInt(u.medals));
  if (u.followers != null) stat("followers", fmtInt(u.followers));
  if (u.favourites) stat("favourite maps", fmtInt(u.favourites));
  if (ps.children.length) box.append(ps);
  const about = [["📍", u.location], ["💡", u.interests], ["💼", u.occupation], ["💬", u.discord && "Discord: " + u.discord]].filter(x => x[1]);
  if (about.length || u.website) {
    const p = h("p", "pinfo"); about.forEach(([i, v]) => p.append(h("span", null, i + " " + v)));
    if (u.website && /^https?:\/\//i.test(u.website)) { const a = h("a", null, "🔗 " + u.website.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")); a.href = u.website; a.target = "_blank"; a.rel = "noopener nofollow"; p.append(a); }
    box.append(p);
  }
  // recent mapping activity (osu! keeps about a month) and kudosu from modding
  const act = h("div", "pact"); act.append(h("div", "dml", tr("Recent mapping activity")), h("p", "hint", tr("Loading…")));
  box.append(act);
  osuActivity(u.id).then(a => { if (R.user === u) renderActivity(act, a); });
  const acts = h("div", "macts");
  const prof = h("a", "btn ghost sm", tr("osu! profile")); prof.href = `https://osu.ppy.sh/users/${u.id}`; prof.target = "_blank"; prof.rel = "noopener";
  const share = h("button", "btn ghost sm", tr("Share this page")); share.onclick = () => shareLink(location.origin + listURL({ u: u.username, q: "", st: R.ctx.st }), `${u.username} · KIKI BEATMAP VIEWER`);
  const back = h("button", "btn ghost sm", tr("← All maps")); back.onclick = () => goList({ q: "", u: "", st: defSt() }, true);
  acts.append(prof, share, back);
  if (AUTH.user && AUTH.user.id === u.id && typeof cloudEnabled === "function" && cloudEnabled()) { const mine = h("a", "btn ghost sm", tr("My private projects")); mine.href = "?view=projects"; mine.dataset.go = "projects"; acts.append(mine); }
  box.append(acts, h("p", "hint pubnote", tr("Public beatmaps and profile from osu!. Projects saved on this site are private and never listed here.")));
}
const ACT_LABEL = { beatmapsetUpload: "Submitted", beatmapsetUpdate: "Updated", beatmapsetRevive: "Revived", beatmapsetDelete: "Deleted" };
const APPROVAL = { ranked: "Ranked", approved: "Approved", qualified: "Qualified", loved: "Loved" };
function renderActivity(box, a) {
  box.innerHTML = ""; box.append(h("div", "dml", tr("Recent mapping activity")));
  if (!a) { box.append(h("p", "hint", tr("Couldn't load the activity."))); return; }
  const rows = [];
  for (const e of a.events) {
    const label = e.type === "beatmapsetApprove" ? tr(APPROVAL[e.approval] || e.approval) : e.type === "beatmapPlaycount" ? tr("{n} plays", { n: fmtInt(e.count) }) : tr(ACT_LABEL[e.type] || e.type);
    rows.push({ at: e.at, kind: e.type === "beatmapsetApprove" ? "ap-" + e.approval : e.type, label, title: e.title, sid: e.sid, bid: e.bid });
  }
  for (const k of a.kudosu) rows.push({ at: k.at, kind: "kudosu", label: tr(k.amount >= 0 ? "+{n} kudosu" : "{n} kudosu", { n: k.amount }), title: k.title, sid: k.sid, note: k.giver ? tr("from {u}", { u: k.giver }) : "" });
  rows.sort((x, y) => new Date(y.at) - new Date(x.at));
  // one line for many updates of the same map on the same day ("Updated ×5")
  for (let i = rows.length - 1; i > 0; i--) {
    const a = rows[i - 1], b = rows[i];
    if (a.kind === "beatmapsetUpdate" && b.kind === a.kind && a.sid && a.sid === b.sid && new Date(a.at).toDateString() === new Date(b.at).toDateString()) { a.n = (a.n || 1) + (b.n || 1); rows.splice(i, 1); }
  }
  for (const r of rows) if (r.n > 1) r.label += " ×" + r.n;
  if (!rows.length) { box.append(h("p", "hint", tr("Nothing in the last month."))); return; }
  const list = h("div", "actlist");
  rows.forEach((r, i) => {
    const row = h("div", "actrow " + r.kind.replace(/[^\w-]/g, "")); if (i >= 6) row.hidden = true;
    const t = r.sid || r.bid ? h("a", "mlink", r.title) : h("span", null, r.title);
    if (r.sid || r.bid) { t.href = r.sid ? mapURL(r.sid) : "?b=" + r.bid; t.onclick = e => { e.preventDefault(); goMap(r.sid, r.bid); }; }
    const when = h("time", null, relTime(r.at)); when.title = fmtDate(r.at);
    row.append(h("em", null, r.label), t); if (r.note) row.append(h("small", null, r.note)); row.append(when);
    list.append(row);
  });
  box.append(list);
  if (rows.length > 6) { const more = h("button", "mlink", tr("Show all ({n})", { n: rows.length })); more.onclick = () => { list.querySelectorAll(".actrow").forEach(r => r.hidden = false); more.remove(); }; box.append(more); }
}
buildFilters(); // app.js built the chips before this file was loaded: now with the Filters button
