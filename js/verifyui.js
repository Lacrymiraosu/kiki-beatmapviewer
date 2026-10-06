"use strict";
// ============ Verify page: a menu of views — overview, checks, audio & spectrum, rhythm, difficulties, metadata, files ============
// The checks are in verify.js, the spectrum in spectrum.js. The page remembers the open view (S.vfyTab) and the filters.
const VFY = { tab: null, scope: "all", cat: "all", q: "", lv: { problem: true, warning: true, minor: false }, ok: false, open: null, ff: "all", box: null, res: null };
const VFY_TABS = [["overview", "Overview", "◎"], ["checks", "Checks", "✓"], ["audio", "Audio & spectrum", "♫"], ["rhythm", "Rhythm", "♩"], ["diffs", "Difficulties", "★"], ["meta", "Metadata", "Aa"], ["files", "Files", "▤"]];
const VFY_TAB_CATS = { audio: ["Audio"], diffs: ["Settings", "Spread"], meta: ["Metadata"], files: ["Files", "Resources"] }; // the menu badge counts these
const VFY_SYM = { problem: "✕", warning: "!", minor: "·", ok: "✓" }, VFY_LVN = { problem: "Problems", warning: "Warnings", minor: "Minor" };
const vfyIcon = l => h("span", "vi " + l, VFY_SYM[l]);
const vfyWorst = c => c.problem ? "problem" : c.warning ? "warning" : c.minor ? "minor" : "ok";
function vfyCount(results, cats) { const c = { problem: 0, warning: 0, minor: 0 }; for (const r of results) if (!cats || cats.includes(r.c.cat)) for (const i of r.issues) c[i.lvl]++; return c; }
// General first, then the open difficulty, then the rest
function vfyScopes(res) {
  const cur = res.diffs.find(d => d.x.i === curDiff), rest = res.diffs.filter(d => d !== cur);
  return [{ key: "general", title: tr("General (whole mapset)"), results: res.general, diffIdx: null },
    ...(cur ? [cur, ...rest] : rest).map(d => ({ key: "d" + d.x.i, title: "[" + (d.x.m.meta.Version || "?") + "]", results: d.res, diffIdx: d.x.i, x: d.x, cur: d === cur }))];
}
const vfyStars = x => { const f = osuFiles[x.i]; return f && f.stars > 0 ? { v: f.stars, est: !!f.estStars } : x.stars != null ? { v: x.stars, est: false } : null; };
const vfyStarTxt = st => st ? (st.est ? "≈" : "") + "★" + st.v.toFixed(2) : "–";
const vfyTs = i => i.objs ? tsFor(i.objs).replace(/ - $/, "") : i.t != null ? fmtMs(i.t) : "";
const vfySize = f => !f ? null : f._data ? f._data.uncompressedSize : f.size ?? null;
const vfyBox = (title, ...kids) => { const b = h("section", "vfybox"); if (title) b.append(h("h4", null, title)); b.append(...kids); return b; };
function vfyGo(tab, opt) {
  VFY.tab = tab; S.vfyTab = tab; save(); if (opt) Object.assign(VFY, opt);
  if (VFY.box && VFY.box.isConnected) { renderVerify(VFY.box); const p = VFY.box.closest(".edpanel") || $("tBody"); if (p) p.scrollTop = 0; }
}
// to an issue: switch difficulty if needed, seek, select its objects and show the playfield
function vfyJump(i, diffIdx) {
  const go = () => {
    if (i.t == null) return;
    seekTo(i.t);
    if (EDIT.on) { if (i.objs) { const ts = new Set(i.objs.map(o => Math.round(o.t))); edSelectIds(map.hit.filter(o => ts.has(Math.round(o.t))).map(o => o.lid)); } if (EDIT.tab !== "compose") edTab("compose"); dirty = true; }
    else closeTools();
  };
  if (diffIdx != null && diffIdx !== curDiff) { const p = switchDiff(diffIdx); if (p && p.then) p.then(go); return; }
  go();
}

// results from before the latest edits: say so, with ↻ to check again
function vfyStaleBar(box) {
  if (box.querySelector(".vfystale")) return;
  const bar = h("div", "aalert vfystale"), auto = S.vfyAuto !== false;
  bar.append(h("span", null, tr(auto ? "Checking again when you stop editing…" : "These results are from before your latest edits.")));
  const b = h("button", "btn ghost sm", "↻ " + tr("Check again")); b.type = "button"; b.onclick = vfyRecheck; bar.append(b);
  box.prepend(bar);
}
function renderVerify(box) {
  if (!map) return;
  VFY.box = box; box.innerHTML = "";
  const res = VFY.res = vfyResults(), every = [...res.general, ...res.diffs.flatMap(d => d.res)], all = vfyCount(every);
  if (!VFY.tab) VFY.tab = VFY_TABS.some(t => t[0] === S.vfyTab) ? S.vfyTab : "overview";
  const wrap = h("div", "vfyc"), root = h("div", "vfy"), nav = h("nav", "vfynav"), main = h("div", "vfymain");
  nav.setAttribute("aria-label", tr("Verify"));
  for (const [k, l, ic] of VFY_TABS) {
    const b = h("button", "vfyt" + (k === VFY.tab ? " on" : "")); b.type = "button"; if (k === VFY.tab) b.setAttribute("aria-current", "page");
    b.append(h("span", "vfyic", ic), h("span", "vfyl", tr(l)));
    const c = k === "checks" ? all : VFY_TAB_CATS[k] ? vfyCount(every, VFY_TAB_CATS[k]) : null;
    if (c && (c.problem || c.warning)) b.append(h("em", "vfyb " + (c.problem ? "problem" : "warning"), String(c.problem || c.warning)));
    b.onclick = () => vfyGo(k); nav.append(b);
  }
  root.append(nav, main); wrap.append(root); box.append(wrap);
  if (vfyHeld()) vfyStaleBar(box);
  try { ({ overview: vfyOverview, checks: vfyChecks, audio: vfyAudio, rhythm: vfyRhythm, diffs: vfyDiffs, meta: vfyMeta, files: vfyFiles })[VFY.tab](main, res, all); }
  catch (e) { console.error(e); main.append(h("p", "aalert", tr("Couldn't show this: {err}", { err: e.message }))); }
}

// ---------- overview: verdict, counts, where the issues are, the difficulties, the mapset in short ----------
function vfyOverview(main, res, all) {
  const st = vfyWorst(all), v = h("section", "vfyverdict " + st), vt = h("div");
  vt.append(h("b", null, all.problem ? tr("{n} problems to fix before it can be ranked", { n: all.problem }) : all.warning ? tr("No problems. {n} warnings to look at", { n: all.warning }) : tr("No problems or warnings found")),
    h("small", null, tr("Checks follow the osu! Ranking Criteria, modelled on MapsetVerifier by Naxess. Always double-check before posting.")));
  v.append(vfyIcon(st === "minor" ? "ok" : st), vt);
  const cards = h("div", "vfycards");
  for (const k of ["problem", "warning", "minor"]) {
    const c = h("button", "vfycard " + k); c.type = "button"; c.append(vfyIcon(k), h("b", null, String(all[k])), h("small", null, tr(VFY_LVN[k])));
    c.onclick = () => vfyGo("checks", { lv: { problem: k === "problem", warning: k === "warning", minor: k === "minor" }, scope: "all", cat: "all", q: "" }); cards.append(c);
  }
  main.append(v, cards, vfyIssueMap(res), vfyDiffTable(res), vfyFacts());
}
// every difficulty over the whole song, with a mark where each issue is
function vfyIssueMap(res) {
  const c = h("canvas", "vfymap"), tip = h("div", "rtip"), cw = h("div", "rcw"); tip.hidden = true; cw.append(c, tip);
  const rows = vfyScopes(res).filter(s => s.diffIdx != null).map(s => ({ s, iss: s.results.flatMap(r => r.issues.filter(i => i.t != null)).sort((a, b) => LV[b.lvl] - LV[a.lvl]) }));
  const len = Math.max(songMeta && songMeta.dur ? songMeta.dur * 1000 : 0, ...rows.map(r => r.s.x.m.last || 0), 1000);
  const laneH = 26, botH = 16, COL = { problem: "#ff5a6e", warning: "#ffcf6b", minor: "#8fa3c9" };
  let hover = null;
  const draw = () => {
    if (!c.isConnected) return;
    const w = c.clientWidth || 600, hh = rows.length * laneH + botH, d = Math.min(devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * d) || c.height !== Math.round(hh * d)) { c.width = Math.round(w * d); c.height = Math.round(hh * d); c.style.height = hh + "px"; }
    const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, hh);
    const labelW = Math.min(140, w * .3), pw = w - labelW - 6, X = ms => labelW + ms / len * pw;
    c.geom = { labelW, pw, laneH, X };
    rows.forEach((r, li) => {
      const y = li * laneH, m = r.s.x.m, cur = r.s.diffIdx === curDiff;
      g.fillStyle = cur ? "rgba(255,102,170,.12)" : li % 2 ? "rgba(255,255,255,.03)" : "rgba(255,255,255,.06)"; g.fillRect(0, y, w, laneH - 2);
      const st = vfyStars(r.s.x); g.fillStyle = starColor(st ? st.v : null); g.fillRect(0, y, 4, laneH - 2);
      g.fillStyle = "rgba(255,200,80,.13)"; for (const [a, b] of m.kiai) g.fillRect(X(a), y, X(Math.min(b, len)) - X(a), laneH - 2);
      g.fillStyle = "rgba(0,0,0,.35)"; for (const [a, b] of m.breaks) g.fillRect(X(a), y, X(b) - X(a), laneH - 2);
      g.fillStyle = "rgba(255,255,255,.18)"; g.fillRect(X(m.first), y + laneH / 2 - 1, X(m.last) - X(m.first), 1);
      g.fillStyle = cur ? "#fff" : "#cfc6de"; g.font = (cur ? "600 " : "") + "12px Inter,sans-serif"; g.textBaseline = "middle";
      g.fillText((m.meta.Version || "?").slice(0, 20), 9, y + laneH / 2, labelW - 14);
      for (let k = r.iss.length - 1; k >= 0; k--) { const i = r.iss[k], x = X(i.t); g.fillStyle = COL[i.lvl]; if (i.lvl === "minor") { g.globalAlpha = .6; g.fillRect(x - .5, y + 9, 1.5, laneH - 20); g.globalAlpha = 1; } else g.fillRect(x - 1.5, y + 4, 3, laneH - 10); }
    });
    g.fillStyle = "#a99fbd"; g.font = "10px sans-serif"; g.textBaseline = "alphabetic";
    const stepS = len > 300000 ? 60000 : len > 120000 ? 30000 : 15000;
    for (let t = 0; t <= len; t += stepS) { g.fillRect(X(t), hh - botH, 1, 3); g.fillText(fmt(t / 1000), X(t) + 2, hh - 3); }
    g.fillStyle = "#ff66aa"; g.fillRect(X(A.cur()) - 1, 0, 2, hh - botH);
    if (hover) { g.strokeStyle = "#fff"; g.lineWidth = 2; g.strokeRect(X(hover.i.t) - 4, hover.li * laneH + 2, 8, laneH - 6); }
  };
  const find = e => {
    const r = c.getBoundingClientRect(), g2 = c.geom; if (!g2) return null;
    const x = e.clientX - r.left, li = Math.floor((e.clientY - r.top) / laneH), row = rows[li]; if (!row) return null;
    let best = null, bd = 7; for (const i of row.iss) { const dd = Math.abs(g2.X(i.t) - x) + LV[i.lvl] * 1.5; if (dd < bd) { bd = dd; best = i; } }
    return { x, y: e.clientY - r.top, li, row, i: best, t: Math.max(0, (x - g2.labelW) / g2.pw * len) };
  };
  c.addEventListener("pointermove", e => {
    const p = find(e); hover = p && p.i ? p : null; draw();
    if (!hover) { tip.hidden = true; c.style.cursor = p && p.x > c.geom.labelW ? "pointer" : ""; return; }
    c.style.cursor = "pointer"; tip.textContent = `[${p.row.s.x.m.meta.Version}] ${vfyTs(p.i)} · ${tr(p.i.msg, p.i.v)}`; tip.hidden = false;
    const r = c.getBoundingClientRect(); tip.style.transform = `translate(${Math.min(Math.max(4, p.x + 12), r.width - tip.offsetWidth - 4)}px,${Math.max(0, p.y - 34)}px)`;
  });
  c.addEventListener("pointerleave", () => { hover = null; tip.hidden = true; draw(); });
  c.addEventListener("click", e => {
    const p = find(e); if (!p) return;
    if (p.i) return vfyJump(p.i, p.row.s.diffIdx);
    if (p.x > c.geom.labelW) { if (p.row.s.diffIdx !== curDiff) switchDiff(p.row.s.diffIdx); seekTo(p.t); draw(); }
  });
  let lastT = NaN; // follow the song: redraw when the time changes, while the map is on screen
  const follow = () => { if (!c.isConnected) return; const t = A.cur(); if (t !== lastT) { lastT = t; draw(); } requestAnimationFrame(follow); };
  requestAnimationFrame(follow);
  if (window.ResizeObserver) new ResizeObserver((_, ro) => { if (!c.isConnected) return ro.disconnect(); draw(); }).observe(c);
  const leg = h("div", "rleg");
  for (const [k, col] of [["Problems", "#ff5a6e"], ["Warnings", "#ffcf6b"], ["Minor", "#8fa3c9"], ["Kiai", "rgba(255,200,80,.5)"], ["Break", "#000"]]) { const sp = h("span"), dot = h("i"); dot.style.background = col; sp.append(dot, tr(k)); leg.append(sp); }
  return vfyBox(tr("Where the issues are"), cw, leg, h("p", "hint", tr("Each row is a difficulty over the whole song. Click a mark to go to that issue (it switches difficulty if needed).")));
}
function vfyDiffTable(res) {
  const tw = h("div", "vfytw"), t = h("table", "vfytbl click"), hr = h("tr");
  for (const l of [tr("Difficulty"), tr("Star rating"), tr("Objects"), tr("Drain time"), "✕", "!", "·"]) hr.append(h("th", l.length === 1 ? "n" : null, l));
  const thead = h("thead"); thead.append(hr); t.append(thead);
  const tb = h("tbody");
  const ds = [...res.diffs].sort((a, b) => ((vfyStars(a.x) || {}).v ?? a.x.lvl) - ((vfyStars(b.x) || {}).v ?? b.x.lvl));
  for (const d of ds) {
    const c = vfyCount(d.res), s = vfyDiffStats(d.x.m), tr2 = h("tr", d.x.i === curDiff ? "cur" : ""), st = vfyStars(d.x), name = h("td", "nm"), dot = h("i", "sdot");
    dot.style.background = starColor(st ? st.v : null); name.append(dot, d.x.m.meta.Version || "?");
    tr2.append(name, h("td", null, vfyStarTxt(st)), h("td", null, String(s.n)), h("td", null, fmt(s.drain / 1000)));
    for (const k of ["problem", "warning", "minor"]) tr2.append(h("td", "n " + (c[k] ? k : "zero"), String(c[k])));
    tr2.onclick = () => vfyGo("checks", { scope: "d" + d.x.i, lv: { problem: true, warning: true, minor: !c.problem && !c.warning }, cat: "all", q: "" });
    tr2.title = tr("Show this difficulty's checks"); tb.append(tr2);
  }
  t.append(tb); tw.append(t);
  return vfyBox(tr("Difficulties"), tw);
}
function vfyFacts() {
  const a = songMeta, n = Object.keys(files).length, total = Object.values(files).reduce((s, f) => s + (vfySize(f) || 0), 0);
  const bg = map.bg && files[norm(map.bg)], im = map.bg && images[norm(map.bg)], sprites = sb.length;
  const facts = [
    [tr("Song"), a ? [a.fmt ? a.fmt.replace(/ \(.*\)/, "") : "?", a.kbps ? Math.round(a.kbps) + " kbps" : "", a.dur ? fmt(a.dur) : ""].filter(Boolean).join(" · ") : tr("None")],
    [tr("Background"), bg ? [im ? `${im.width} × ${im.height}` : "", vfySize(bg) != null ? fmtBytes(vfySize(bg)) : ""].filter(Boolean).join(" · ") || map.bg : tr("None")],
    [tr("Video"), map.video ? map.video : tr("None")],
    [tr("Storyboard"), osbText || sprites ? tr("{n} sprites", { n: sprites }) : tr("None")],
    [tr("Files"), `${n} · ${fmtBytes(total)}`],
  ];
  const g = h("div", "vfyfacts");
  for (const [k, v] of facts) { const d = h("div"); d.append(h("small", null, k), h("b", null, v)); g.append(d); }
  return vfyBox(tr("Mapset"), g);
}

// ---------- checks: where (whole set / general / a difficulty), levels, category, search ----------
function vfyChecks(main, res) {
  const scopes = vfyScopes(res);
  if (VFY.scope !== "all" && !scopes.some(s => s.key === VFY.scope)) VFY.scope = "all";
  const where = h("div", "vfychips");
  const chip = (key, label, c) => {
    const b = h("button", "vfychip" + (VFY.scope === key ? " on" : "")); b.type = "button"; b.append(label);
    const w = vfyWorst(c); if (w !== "ok") b.append(h("em", "vfyb " + w, String(c[w])));
    b.onclick = () => { VFY.scope = key; renderVerify(VFY.box); }; return b;
  };
  where.append(chip("all", tr("Everything"), vfyCount(scopes.flatMap(s => s.results))), ...scopes.map(s => chip(s.key, s.diffIdx == null ? tr("General") : s.title, vfyCount(s.results))));
  const shown = scopes.filter(s => VFY.scope === "all" || s.key === VFY.scope), cnt = vfyCount(shown.flatMap(s => s.results));
  const bar = h("div", "vsum");
  for (const k of ["problem", "warning", "minor"]) { const b = h("button", VFY.lv[k] ? "on" : ""); b.type = "button"; b.append(vfyIcon(k), ` ${cnt[k]} ${tr(VFY_LVN[k])}`); b.onclick = () => { VFY.lv[k] = !VFY.lv[k]; renderVerify(VFY.box); }; bar.append(b); }
  const cats = [...new Set([...SET_CHECKS, ...DIFF_CHECKS].map(c => c.cat))], sel = h("select", "vfysel");
  sel.add(new Option(tr("All categories"), "all"));
  for (const c of cats) { const n = vfyCount(shown.flatMap(s => s.results), [c]); sel.add(new Option(`${tr(c)}${n.problem + n.warning ? ` (${n.problem + n.warning})` : ""}`, c)); }
  sel.value = VFY.cat; sel.onchange = () => { VFY.cat = sel.value; renderVerify(VFY.box); };
  const q = h("input", "vfyq"); q.type = "search"; q.placeholder = tr("Search the checks"); q.setAttribute("aria-label", q.placeholder); q.value = VFY.q; q.addEventListener("keydown", e => e.stopPropagation());
  const okB = h("button", VFY.ok ? "on" : "", tr("Show passed checks")); okB.type = "button"; okB.onclick = () => { VFY.ok = !VFY.ok; renderVerify(VFY.box); };
  const exp = h("button", "", tr(VFY.open ? "Collapse all" : "Expand all")); exp.type = "button"; exp.onclick = () => { VFY.open = !VFY.open; renderVerify(VFY.box); };
  const cp = h("button", "", tr("Copy report")); cp.type = "button"; cp.onclick = async () => toast(await copyText(verifyReport(res)) ? tr("Report copied") : tr("Couldn't copy"));
  const tools = h("div", "vfytools"); tools.append(sel, q, okB, exp, cp);
  const list = h("div", "vfylist");
  const fill = () => {
    list.innerHTML = ""; const qq = VFY.q.trim().toLowerCase();
    for (const s of shown) {
      const grp = h("div", "vgrp"), head = h("h3");
      head.append(s.title + (s.x ? " · " + tr(LEVELS[s.x.lvl]) + (s.cur ? " · " + tr("current") : "") : ""));
      if (s.x) head.append(h("small", null, vfyStarTxt(vfyStars(s.x))));
      grp.append(head);
      let n = 0;
      for (const r of s.results) {
        if (VFY.cat !== "all" && r.c.cat !== VFY.cat) continue;
        const name = (tr(r.c.title) + " " + tr(r.c.cat)).toLowerCase(), byName = !qq || name.includes(qq);
        const iss = r.issues.filter(i => VFY.lv[i.lvl] && (byName || tr(i.msg, i.v).toLowerCase().includes(qq) || vfyTs(i).includes(qq)));
        if (!iss.length && !(VFY.ok && !r.issues.length && byName)) continue;
        n++;
        const worst = iss.reduce((w, i) => LV[i.lvl] < LV[w] ? i.lvl : w, "minor"), d = h("details", "vchk"), sm = h("summary");
        sm.append(vfyIcon(iss.length ? worst : "ok"), h("span", "vct", tr(r.c.title)), h("span", "vcat", tr(r.c.cat)), h("span", "n", iss.length ? String(iss.length) : ""));
        d.append(sm);
        if (iss.length) {
          d.open = VFY.open ?? (iss.some(i => i.lvl === "problem") || iss.length <= 3);
          const ul = h("div", "vissues");
          for (const i of iss.slice(0, 300)) {
            const row = h("div", "viss"), ts = vfyTs(i), msg = tr(i.msg, i.v); row.tabIndex = 0; row.setAttribute("role", "button");
            row.append(vfyIcon(i.lvl)); if (ts) row.append(h("span", "ts", ts)); row.append(h("span", "vmsg", msg));
            const c2 = h("button", "vcopy", "⧉"); c2.type = "button"; c2.title = tr("Copy"); c2.onclick = async e => { e.stopPropagation(); toast(await copyText(ts ? `${ts} - ${msg}` : msg) ? tr("Copied") : tr("Couldn't copy"), 1200); };
            row.append(c2);
            if (i.t != null) { row.title = s.diffIdx != null && s.diffIdx !== curDiff ? tr("Switch to {d} and go there", { d: s.title }) : tr("Go there"); row.onclick = () => vfyJump(i, s.diffIdx); row.onkeydown = e => { if (e.key === "Enter") { e.stopPropagation(); vfyJump(i, s.diffIdx); } }; }
            else row.classList.add("nt");
            ul.append(row);
          }
          if (iss.length > 300) ul.append(h("p", "hint", tr("…and {n} more", { n: iss.length - 300 })));
          d.append(ul);
        }
        grp.append(d);
      }
      if (!n) grp.append(h("p", "hint ok", tr("No issues")));
      list.append(grp);
    }
  };
  q.oninput = () => { VFY.q = q.value; fill(); };
  fill();
  main.append(where, bar, tools, list);
}
function verifyReport(res) {
  const lines = [];
  for (const s of vfyScopes(res)) {
    if (VFY.scope !== "all" && s.key !== VFY.scope) continue;
    const iss = s.results.filter(r => VFY.cat === "all" || r.c.cat === VFY.cat).flatMap(r => r.issues.filter(i => VFY.lv[i.lvl]));
    if (!iss.length) continue;
    lines.push(`## ${s.title}`);
    for (const i of iss) lines.push(`${i.objs ? tsFor(i.objs) : i.t != null ? fmtMs(i.t) + " - " : ""}${tr(i.msg, i.v)}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ---------- rhythm ----------
function vfyRhythm(main) { main.append(rhythmView()); }

// ---------- difficulties side by side ----------
function vfyDiffStats(m) {
  let br = 0; for (const [a, b] of m.breaks) br += b - a;
  const drain = Math.max(0, m.last - m.first - br), c = { circle: 0, slider: 0, spinner: 0 };
  for (const o of m.hit) c[o.kind]++;
  const reds = m.timing.filter(t => t.uninherited).length, svs = m.timing.filter(t => !t.uninherited && t.beat < 0).map(t => -100 / t.beat);
  return { drain, n: m.hit.length, c, reds, greens: m.timing.length - reds, sv: svs.length ? [Math.min(...svs), Math.max(...svs)] : null, nps: drain ? m.hit.length / (drain / 1000) : 0 };
}
// a table: rows = properties, columns = difficulties (easiest first); "same" rows mark the cells that differ from the first
function vfyCompare(xs, rows) {
  const tw = h("div", "vfytw"), t = h("table", "vfytbl cmp"), hr = h("tr");
  hr.append(h("th"));
  for (const x of xs) { const th = h("th", x.i === curDiff ? "cur" : ""), dot = h("i", "sdot"), st = vfyStars(x); dot.style.background = starColor(st ? st.v : null); th.append(dot, x.m.meta.Version || "?"); if (st) th.append(h("small", null, vfyStarTxt(st))); hr.append(th); }
  const thead = h("thead"); thead.append(hr); t.append(thead);
  const tb = h("tbody");
  for (const row of rows) {
    if (row.head) { const r = h("tr", "sec"), td = h("td", null, row.head); td.colSpan = xs.length + 1; r.append(td); tb.append(r); continue; }
    const r = h("tr"), vals = xs.map(x => row.v(x)), key = v => v instanceof Node ? v.textContent : String(v ?? "");
    r.append(h("th", null, row.label));
    vals.forEach((v, k) => {
      const td = h("td"); td.append(v instanceof Node ? v : String(v ?? "–"));
      if (row.same && k > 0 && key(v) !== key(vals[0])) { td.classList.add("diff"); td.title = tr("Different from [{d}]", { d: xs[0].m.meta.Version }); }
      if (row.bad && row.bad(xs[k])) { td.classList.add("bad"); td.title = row.badMsg || ""; }
      r.append(td);
    });
    tb.append(r);
  }
  t.append(tb); tw.append(t); return tw;
}
const vfySorted = res => res.diffs.map(d => d.x).sort((a, b) => ((vfyStars(a) || {}).v ?? a.lvl) - ((vfyStars(b) || {}).v ?? b.lvl) || a.i - b.i);
function vfyDiffs(main, res) {
  const xs = vfySorted(res), stats = new Map(xs.map(x => [x, vfyDiffStats(x.m)]));
  // spread: one bar per difficulty, and the step from the one before
  const sp = h("div", "vfyspread"), mx = Math.max(6, ...xs.map(x => (vfyStars(x) || { v: 0 }).v));
  xs.forEach((x, k) => {
    const st = vfyStars(x), row = h("div", "vfysp" + (x.i === curDiff ? " cur" : "")), bar = h("div", "vfyspb"), fill = h("i");
    fill.style.width = (st ? st.v / mx * 100 : 0) + "%"; fill.style.background = starColor(st ? st.v : null); bar.append(fill);
    const prev = k && vfyStars(xs[k - 1]), gap = st && prev ? st.v - prev.v : null;
    row.append(h("span", "nm", x.m.meta.Version || "?"), bar, h("b", null, vfyStarTxt(st)), h("small", gap != null && gap > 1.3 ? "big" : "", gap != null ? "+" + gap.toFixed(2) : ""));
    row.onclick = () => { if (x.i !== curDiff) switchDiff(x.i); };
    sp.append(row);
  });
  const S2 = x => stats.get(x), D = k => x => x.m.diff[k] ?? "–", G = k => x => x.m.general[k] ?? "–", M = k => x => x.m.meta[k] ?? "–";
  const swatches = x => { const s = h("span", "vfysw"); if (!x.m.colours.length) s.append(tr("Default")); for (const c of x.m.colours) { const i = h("i"); i.style.background = `rgb(${c.join(",")})`; s.append(i); } return s; };
  const rows = [
    { head: tr("Difficulty settings") },
    { label: tr("Star rating"), v: x => vfyStarTxt(vfyStars(x)) }, { label: tr("Level (guessed)"), v: x => tr(LEVELS[x.lvl]) },
    { label: "HP", v: D("HPDrainRate") }, { label: "CS", v: D("CircleSize") }, { label: "AR", v: x => x.m.diff.ApproachRate ?? x.m.diff.OverallDifficulty ?? "–" }, { label: "OD", v: D("OverallDifficulty") },
    { label: "SliderMultiplier", v: D("SliderMultiplier") }, { label: "SliderTickRate", v: D("SliderTickRate") }, { label: "StackLeniency", v: G("StackLeniency") },
    { head: tr("Content") },
    { label: tr("Objects"), v: x => S2(x).n }, { label: tr("Circles / sliders / spinners"), v: x => `${S2(x).c.circle} / ${S2(x).c.slider} / ${S2(x).c.spinner}` },
    { label: tr("Drain time"), v: x => fmt(S2(x).drain / 1000) }, { label: tr("Objects per second"), v: x => S2(x).nps.toFixed(2) },
    { label: tr("Breaks"), v: x => x.m.breaks.length }, { label: tr("Kiai sections"), v: x => x.m.kiai.length },
    { label: tr("Red lines"), v: x => S2(x).reds }, { label: tr("Green lines"), v: x => S2(x).greens },
    { label: tr("SV range"), v: x => S2(x).sv ? `${S2(x).sv[0].toFixed(2)}x – ${S2(x).sv[1].toFixed(2)}x` : "1.00x" },
    { label: tr("Combo colours"), v: swatches },
    { head: tr("Should be the same in every difficulty") },
    { label: "PreviewTime", v: G("PreviewTime"), same: true }, { label: "AudioLeadIn", v: G("AudioLeadIn"), same: true }, { label: "Countdown", v: G("Countdown"), same: true },
    { label: "EpilepsyWarning", v: G("EpilepsyWarning"), same: true }, { label: "LetterboxInBreaks", v: G("LetterboxInBreaks"), same: true }, { label: "WidescreenStoryboard", v: G("WidescreenStoryboard"), same: true },
    { label: "SkinPreference", v: G("SkinPreference"), same: true }, { label: "BeatmapSetID", v: M("BeatmapSetID"), same: true },
  ];
  main.append(vfyBox(tr("Difficulty spread"), sp, h("p", "hint", tr("Easiest first. The number on the right is the step from the difficulty above (orange when it's a big jump). Click one to open it."))),
    vfyBox(tr("Side by side"), vfyCompare(xs, rows), h("p", "hint", tr("Orange cells differ from the first difficulty where they should be the same."))));
}

// ---------- metadata side by side ----------
function vfyMeta(main, res) {
  const xs = vfySorted(res), asciiBad = k => x => [...(x.m.meta[k] || "")].some(c => c.charCodeAt(0) > 127);
  const allTags = xs.map(x => new Set((x.m.meta.Tags || "").toLowerCase().split(/\s+/).filter(Boolean)));
  const tags = (x, k) => { const s = h("span", "vfytags"), set = allTags[k]; for (const t of [...set].sort()) s.append(h("span", allTags.every(o => o.has(t)) ? "" : "odd", t), " "); if (!set.size) s.append("–"); return s; };
  const M = k => x => x.m.meta[k] || "–";
  const rows = [
    { label: "Title", v: M("Title"), same: true, bad: asciiBad("Title"), badMsg: tr("Romanised fields can only use plain (ASCII) characters") },
    { label: "TitleUnicode", v: M("TitleUnicode"), same: true },
    { label: "Artist", v: M("Artist"), same: true, bad: asciiBad("Artist"), badMsg: tr("Romanised fields can only use plain (ASCII) characters") },
    { label: "ArtistUnicode", v: M("ArtistUnicode"), same: true },
    { label: "Creator", v: M("Creator"), same: true }, { label: "Version", v: M("Version") }, { label: "Source", v: M("Source"), same: true },
    { label: "Tags", v: x => tags(x, xs.indexOf(x)), same: true },
    { label: "BeatmapID", v: M("BeatmapID") }, { label: "BeatmapSetID", v: M("BeatmapSetID"), same: true },
    { label: "AudioFilename", v: x => x.m.general.AudioFilename || "–", same: true }, { label: tr("Background"), v: x => x.m.bg || "–" }, { label: tr("Video"), v: x => x.m.video ? `${x.m.video} (${x.m.videoOffset} ms)` : "–", same: true },
  ];
  const meta = res.general.filter(r => r.c.cat === "Metadata"), c = vfyCount(meta);
  const go = h("button", "btn ghost sm", tr("Metadata checks") + (c.problem + c.warning ? ` (${c.problem + c.warning})` : "")); go.onclick = () => vfyGo("checks", { scope: "general", cat: "Metadata", q: "" });
  main.append(vfyBox(tr("Metadata"), vfyCompare(xs, rows), h("p", "hint", tr("Orange cells differ from the first difficulty. Underlined tags aren't in every difficulty. Red = not allowed.")), go));
}

// ---------- files in the package ----------
function vfyFiles(main) {
  const kinds = fileKinds(allMaps(), sb.length ? sb : []), ORDER = ["Song", "Background", "Video", "Difficulty", "Storyboard script", "Storyboard", "Hit sound", "Skin element", "System file"];
  const rows = [...kinds].map(([k, kind]) => ({ k, f: files[k], kind, size: vfySize(files[k]) }))
    .sort((a, b) => (a.kind ? ORDER.indexOf(a.kind) : -1) - (b.kind ? ORDER.indexOf(b.kind) : -1) || a.k.localeCompare(b.k));
  const total = rows.reduce((s, r) => s + (r.size || 0), 0), unused = rows.filter(r => !r.kind).length;
  const isImg = k => /\.(png|jpe?g)$/.test(k), isAud = k => /\.(wav|ogg|mp3)$/.test(k);
  const chips = h("div", "vfychips");
  for (const [k, l, n] of [["all", tr("All"), rows.length], ["unused", tr("Unused"), unused], ["img", tr("Images"), rows.filter(r => isImg(r.k)).length], ["aud", tr("Audio"), rows.filter(r => isAud(r.k)).length]]) {
    const b = h("button", "vfychip" + (VFY.ff === k ? " on" : "")); b.type = "button"; b.append(l, h("em", "vfyb " + (k === "unused" && n ? "problem" : "minor"), String(n))); b.onclick = () => { VFY.ff = k; renderVerify(VFY.box); }; chips.append(b);
  }
  const tw = h("div", "vfytw"), t = h("table", "vfytbl files"), hr = h("tr");
  for (const l of [tr("File"), tr("Used as"), tr("Size"), ""]) hr.append(h("th", null, l));
  const thead = h("thead"); thead.append(hr); t.append(thead);
  const tb = h("tbody");
  for (const r of rows) {
    if (VFY.ff === "unused" && r.kind) continue; if (VFY.ff === "img" && !isImg(r.k)) continue; if (VFY.ff === "aud" && !isAud(r.k)) continue;
    const tr2 = h("tr", r.kind ? "" : "bad"), act = h("td", "act");
    const big = r.kind === "Background" && r.size > 2.5 * 1048576, zero = r.size === 0;
    tr2.append(h("td", "nm", r.f.name), h("td", null, r.kind ? tr(r.kind) : ""), h("td", "n" + (big || zero ? " warn" : ""), r.size == null ? "?" : zero ? tr("0 bytes") : fmtBytes(r.size)), act);
    if (!r.kind) tr2.children[1].append(h("em", "abadge expired", tr("Unused")));
    if (isAud(r.k) && r.kind !== "Song") {
      const p = h("button", "btn ghost sm", "▶"); p.title = tr("Listen");
      p.onclick = async () => { ensureAudioCtx(); try { const b = await decodeAB(await r.f.async("arraybuffer")); playBuf(b, hsGain() || .6, 0); } catch { toast(tr("Couldn't play this file"), 2000); } };
      act.append(p);
    }
    if (isImg(r.k)) {
      const v = h("button", "btn ghost sm", tr("View")), prev = h("tr", "vfyprev"), td = h("td"); td.colSpan = 4; prev.append(td); prev.hidden = true;
      v.onclick = async () => {
        if (!prev.hidden) { prev.hidden = true; return; }
        if (!td.firstChild) { const im = h("img"); im.alt = r.f.name; try { im.src = mkURL(await r.f.async("blob")); } catch {} im.onload = () => { td.append(h("small", null, `${im.naturalWidth} × ${im.naturalHeight}`)); }; td.append(im); }
        prev.hidden = false;
      };
      act.append(v); tb.append(tr2, prev); continue;
    }
    tb.append(tr2);
  }
  t.append(tb); tw.append(t);
  const head = h("div", "vfyfacts");
  for (const [k, v] of [[tr("Files"), String(rows.length)], [tr("Total size"), fmtBytes(total)], [tr("Unused"), String(unused)]]) { const d = h("div"); d.append(h("small", null, k), h("b", null, v)); head.append(d); }
  main.append(vfyBox(tr("Files in the package"), head, chips, tw, h("p", "hint", tr("Unused files are a problem for ranking: remove them, or use them in a difficulty or the storyboard."))));
}
