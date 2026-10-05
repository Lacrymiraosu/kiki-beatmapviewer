"use strict";
// ============ Google Drive: save, open and export maps in the user's own Google Drive ============
// With the user's own Google account, straight from the browser to Google: this site's server never sees the files or
// the Google token, and the admins have nothing to do with it. Permission "drive.file": the site only sees the files it
// created in the user's Drive (or a file they pick with Google's picker), nothing else there.
// In Drive: a folder "beatmap viewer" with one folder per map ("Artist - Title (Creator)") holding its files (every
// .osu, the song, images, storyboard…), and the .osz files exported there.
// Autosave: while a map that's saved in Drive is open, every 5 minutes when something changed, and only the files that
// changed (usually the .osu, a few KB). Google allows ~12,000 requests a minute per user and asks for at most ~3 writes a
// second; an autosave is one listing plus one upload per changed file. Saving by hand: at most every 15 seconds. When
// Google says "rate limit" (403/429), nothing is sent for a while: 1, 2, 4… minutes, up to 30.
const GD_SCOPE = "https://www.googleapis.com/auth/drive.file", GD_API = "https://www.googleapis.com/drive/v3", GD_UP = "https://www.googleapis.com/upload/drive/v3";
const GD_FOLDER = "application/vnd.google-apps.folder", GD_AUTO_MS = 5 * 60000, GD_MIN_MS = 15000, GD_SIMPLE_MAX = 5 * 1024 * 1024;
const GD = { token: "", exp: 0, root: null, folder: null, remote: null, lastSave: 0, saving: null, dirty: false, backoff: 0, backoffUntil: 0, status: "", pct: 0, err: "", sha: new WeakMap(), scripts: {} };
const gdCfg = () => (typeof CLOUD !== "undefined" && CLOUD.me && CLOUD.me.drive) || null;
const gdOn = () => !!(gdCfg() && gdCfg().client_id);
const gdErr = (code, status) => Object.assign(new Error(code), { code, status });
function gdErrText(e) {
  return ({ reconnect: tr("Google Drive needs you to connect again (Google's sign-in lasts an hour)"), cancelled: tr("Google sign-in was cancelled"),
    scope: tr("Google Drive access wasn't allowed. Tick the Drive box on Google's page to use it."), auth: tr("Couldn't sign in to Google"),
    popup: tr("Your browser blocked Google's sign-in window: allow pop-ups for this site and try again"),
    rate_limited: tr("Google Drive asked to slow down; trying again in a few minutes"), api_off: tr("Google Drive isn't turned on for this site yet (the site admin needs to enable the Drive API)"),
    full: tr("Your Google Drive is full"), not_found: tr("That file isn't in your Google Drive any more"), script: tr("Couldn't load Google's sign-in (blocked or offline)") })[e.code] ||
    tr("Google Drive error ({err})", { err: e.status ? "HTTP " + e.status : e.message });
}
function gdScript(src) {
  return GD.scripts[src] || (GD.scripts[src] = new Promise((ok, bad) => {
    const s = document.createElement("script"); s.src = src; s.async = true; s.onload = ok;
    s.onerror = () => { delete GD.scripts[src]; s.remove(); bad(gdErr("script")); }; document.head.append(s);
  }));
}
// ---------- Google's sign-in (a token for an hour; it needs a click to ask again) ----------
async function gdToken(interactive) {
  if (GD.token && Date.now() < GD.exp - 60000) return GD.token;
  if (!interactive) throw gdErr("reconnect");
  if (!(window.google && google.accounts && google.accounts.oauth2)) await gdScript("https://accounts.google.com/gsi/client");
  return new Promise((ok, bad) => {
    const client = google.accounts.oauth2.initTokenClient({ client_id: gdCfg().client_id, scope: GD_SCOPE,
      callback: r => {
        if (!r || r.error || !r.access_token) return bad(gdErr(r && r.error === "access_denied" ? "cancelled" : "auth"));
        if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(r, GD_SCOPE)) return bad(gdErr("scope"));
        GD.token = r.access_token; GD.exp = Date.now() + (+r.expires_in || 3600) * 1000; ok(GD.token);
      },
      error_callback: e => bad(gdErr(e && e.type === "popup_failed_to_open" ? "popup" : e && e.type === "popup_closed" ? "cancelled" : "auth")) });
    client.requestAccessToken({ prompt: "" });
  });
}
function gdDisconnect() {
  try { if (GD.token && window.google && google.accounts) google.accounts.oauth2.revoke(GD.token, () => {}); } catch {}
  GD.token = ""; GD.exp = 0; GD.root = null; gdStatus(GD.folder ? "reconnect" : "");
}
async function gdFetch(url, opts = {}, interactive) {
  if (Date.now() < GD.backoffUntil) throw gdErr("rate_limited");
  const tok = await gdToken(interactive);
  let r; try { r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + tok } }); }
  catch { throw gdErr("network"); }
  if (r.ok) { GD.backoff = 0; return r; }
  let j = null; try { j = await r.clone().json(); } catch {}
  const why = JSON.stringify(j && j.error || "");
  if (r.status === 401) { GD.token = ""; throw gdErr("reconnect"); }
  if (r.status === 429 || (r.status === 403 && /rateLimit|RateLimit|RESOURCE_EXHAUSTED/.test(why))) {
    GD.backoff = Math.min(30 * 60000, Math.max(60000, GD.backoff * 2)); GD.backoffUntil = Date.now() + GD.backoff; throw gdErr("rate_limited");
  }
  if (r.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used/.test(why)) throw gdErr("api_off");
  if (r.status === 403 && /storageQuotaExceeded/.test(why)) throw gdErr("full");
  if (r.status === 404) throw gdErr("not_found");
  throw gdErr("http", r.status);
}
const gdQ = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
async function gdList(q, interactive, fields = "id,name,mimeType,appProperties,size,modifiedTime") {
  const out = []; let page = "";
  do {
    const p = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: "1000", spaces: "drive", orderBy: "modifiedTime desc" });
    if (page) p.set("pageToken", page);
    const j = await (await gdFetch(GD_API + "/files?" + p, {}, interactive)).json();
    out.push(...(j.files || [])); page = j.nextPageToken || "";
  } while (page);
  return out;
}
async function gdFolder(name, parent, props, interactive) {
  const meta = { name, mimeType: GD_FOLDER, appProperties: props, ...(parent ? { parents: [parent] } : {}) };
  return (await gdFetch(GD_API + "/files?fields=id,name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) }, interactive)).json();
}
// create (no id) or replace a file; small ones in one request, big ones (songs, videos) as a resumable upload
async function gdUpload({ id, meta, blob }, interactive) {
  const q = "fields=id,name,appProperties,size,modifiedTime", url = `${GD_UP}/files${id ? "/" + id : ""}`, method = id ? "PATCH" : "POST";
  if (blob.size <= GD_SIMPLE_MAX) {
    const fd = new FormData(); fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" })); fd.append("file", blob);
    return (await gdFetch(`${url}?uploadType=multipart&${q}`, { method, body: fd }, interactive)).json();
  }
  const r = await gdFetch(`${url}?uploadType=resumable&${q}`, { method, headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(blob.size) }, body: JSON.stringify(meta) }, interactive);
  const loc = r.headers.get("location"); if (!loc) throw gdErr("http", 0);
  let r2; try { r2 = await fetch(loc, { method: "PUT", body: blob }); } catch { throw gdErr("network"); }
  if (!r2.ok) throw gdErr("http", r2.status);
  return r2.json();
}
async function gdRoot(interactive) {
  if (GD.root) return GD.root;
  const f = (await gdList(`mimeType='${GD_FOLDER}' and appProperties has { key='obv' and value='root' } and trashed=false`, interactive))[0];
  GD.root = f ? f.id : (await gdFolder("beatmap viewer", null, { obv: "root" }, interactive)).id;
  return GD.root;
}
async function gdShaOf(entry) {
  if (GD.sha.has(entry)) return GD.sha.get(entry);
  const s = await sha256hex(await entry.async("arraybuffer")); GD.sha.set(entry, s); return s;
}
// a map's key in Drive: its beatmapset ID, else a hash of artist / title / creator
async function gdKey() { const M = map.meta; return +setId > 0 ? "s" + setId : "h" + (await sha256hex(new TextEncoder().encode(`${M.Artist}|${M.Title}|${M.Creator}`))).slice(0, 20); }

// ---------- status (editor bar) ----------
function gdStatus(st, err) {
  GD.status = st; if (err !== undefined) GD.err = err;
  const b = $("gdBtn"), c = $("gdChip"); if (!b) return;
  b.hidden = !gdOn(); c.hidden = b.hidden || !GD.folder && st !== "saving" && st !== "error";
  c.className = "cchip gdchip " + st;
  c.textContent = st === "saving" ? tr("Drive {p}%", { p: GD.pct }) : st === "saved" ? tr("Saved to Drive") : st === "unsaved" ? tr("Drive: not saved") : st === "reconnect" ? tr("Drive: connect again") : st === "error" ? tr("Drive save failed") : "";
  c.title = (GD.folder ? tr("Google Drive: {f}", { f: GD.folder.name }) + (GD.lastSave ? " · " + tr("last saved {t}", { t: new Date(GD.lastSave).toLocaleTimeString() }) : "") : "") + (GD.err ? "\n" + GD.err : "");
}
function gdTouch() { if (!GD.folder) return; GD.dirty = true; if (!GD.saving && GD.status !== "error" && GD.status !== "reconnect") gdStatus("unsaved"); } // (cloud.js cloudTouch)
// a map was opened (app.js openEntries): from Drive, or something else (no Drive folder then)
function gdAttach(d) { GD.folder = d ? d.folder : null; GD.remote = d ? d.remote : null; GD.dirty = false; GD.lastSave = d ? Date.now() : 0; GD.err = ""; gdStatus(d ? "saved" : ""); }

// ---------- save the open map to Drive (only the files that changed) ----------
function gdSave(opts = {}) {
  if (GD.saving) return GD.saving;
  GD.saving = gdSaveRun(opts).finally(() => { GD.saving = null; });
  return GD.saving;
}
async function gdSaveRun({ manual }) {
  if (!map || !gdOn()) return false;
  if (manual && Date.now() - GD.lastSave < GD_MIN_MS && !GD.dirty && GD.folder) { toast(tr("Already saved to Drive"), 1500); return true; }
  if (manual && Date.now() - GD.lastSave < GD_MIN_MS) { toast(tr("Saved to Drive a moment ago; try again in a few seconds"), 2000); return false; }
  GD.pct = 0; gdStatus("saving");
  const gen = CLOUD.gen;
  try {
    const root = await gdRoot(!!manual);
    if (!GD.folder) {
      const key = await gdKey(), M = map.meta;
      const found = (await gdList(`'${root}' in parents and mimeType='${GD_FOLDER}' and appProperties has { key='key' and value='${gdQ(key)}' } and trashed=false`, !!manual))[0];
      const f = found || await gdFolder(safeName(`${M.Artist} - ${M.Title} (${M.Creator})`) || "map", root, { obv: "map", key }, !!manual);
      GD.folder = { id: f.id, name: f.name }; GD.remote = null;
    }
    if (!GD.remote) GD.remote = new Map((await gdList(`'${GD.folder.id}' in parents and trashed=false`, !!manual)).filter(x => x.mimeType !== GD_FOLDER).map(x => [x.name, { id: x.id, sha: x.appProperties && x.appProperties.sha }]));
    const { osu, rest } = cloudFiles(), local = [];
    for (const o of osu) { const blob = new Blob([o.text], { type: "text/plain" }); local.push({ path: o.path, blob, sha: await sha256hex(await blob.arrayBuffer()) }); }
    for (const f of rest) local.push({ path: f.name, entry: f, sha: await gdShaOf(f) });
    const todo = local.filter(l => { const r = GD.remote.get(l.path); return !r || r.sha !== l.sha; });
    const gone = [...GD.remote.keys()].filter(p => !local.some(l => l.path === p));
    let done = 0; const total = Math.max(1, todo.length + gone.length);
    for (const l of todo) {
      const blob = l.blob || await l.entry.async("blob"), r = GD.remote.get(l.path);
      const meta = r ? { appProperties: { sha: l.sha } } : { name: l.path, parents: [GD.folder.id], appProperties: { obv: "file", sha: l.sha } };
      const up = await gdUpload({ id: r && r.id, meta, blob }, !!manual);
      GD.remote.set(l.path, { id: up.id, sha: l.sha });
      GD.pct = Math.round(++done / total * 100); gdStatus("saving");
    }
    for (const p of gone) { // files no longer in the map go to Drive's bin (restorable for 30 days)
      await gdFetch(`${GD_API}/files/${GD.remote.get(p).id}?fields=id`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) }, !!manual);
      GD.remote.delete(p); GD.pct = Math.round(++done / total * 100); gdStatus("saving");
    }
    GD.lastSave = Date.now(); if (CLOUD.gen === gen) GD.dirty = false;
    gdStatus(GD.dirty ? "unsaved" : "saved", "");
    if (manual) toast(todo.length || gone.length ? tr("Saved to Google Drive ({n} files updated)", { n: todo.length + gone.length }) : tr("Already saved to Drive"), 2200);
    return true;
  } catch (e) {
    if (e.code === "reconnect") { gdStatus("reconnect", gdErrText(e)); if (manual) toast(gdErrText(e), 3500); return false; }
    if (e.code === "not_found") { GD.folder = null; GD.remote = null; } // (the folder was deleted in Drive: a new one next time)
    gdStatus("error", gdErrText(e)); if (manual) toast(gdErrText(e), 4500);
    return false;
  }
}
// autosave: checked every 30 s, saves when 5 minutes have passed since the last save and something changed
setInterval(() => {
  if (!GD.folder || !GD.dirty || !map || GD.saving || S.gdAuto === false || document.hidden) return;
  if (Date.now() - GD.lastSave < GD_AUTO_MS || Date.now() < GD.backoffUntil) return;
  if (!GD.token || Date.now() >= GD.exp - 60000) { if (GD.status !== "reconnect") gdStatus("reconnect", gdErrText(gdErr("reconnect"))); return; }
  gdSave({});
}, 30000);

// ---------- export the .osz to Drive ----------
async function gdExportOsz() {
  if (!map) return;
  try {
    await gdToken(true);
    showLoading(tr("Building the .osz…"), -1);
    const { blob, name } = await buildOsz(), root = await gdRoot(true);
    showLoading(tr("Uploading to Google Drive…"), -1);
    const old = (await gdList(`'${root}' in parents and name='${gdQ(name)}' and appProperties has { key='obv' and value='osz' } and trashed=false`, true))[0];
    await gdUpload({ id: old && old.id, meta: old ? {} : { name, parents: [root], appProperties: { obv: "osz" } }, blob }, true);
    hideLoading(); toast(tr("Exported {name} to Google Drive", { name }), 2500);
  } catch (e) { hideLoading(); toast(gdErrText(e), 4500); }
}

// ---------- open from Drive ----------
async function gdDownload(id) { return (await gdFetch(`${GD_API}/files/${id}?alt=media`, {}, true)).blob(); }
async function gdOpenFolder(f) {
  try {
    showLoading(tr("Downloading from Google Drive…"), 0);
    const list = (await gdList(`'${f.id}' in parents and trashed=false`, true)).filter(x => x.mimeType !== GD_FOLDER);
    if (!list.some(x => /\.osu$/i.test(x.name))) { hideLoading(); return toast(tr("There's no .osu file in that folder"), 3000); }
    const total = list.reduce((n, x) => n + (+x.size || 0), 0) || 1, entries = {};
    let got = 0;
    for (const x of list) { const b = await gdDownload(x.id); entries[x.name] = blobEntry(x.name, b); got += +x.size || b.size; showLoading(tr("Downloading from Google Drive…"), Math.min(1, got / total)); }
    const remote = new Map(list.map(x => [x.name, { id: x.id, sha: x.appProperties && x.appProperties.sha }]));
    const key = f.appProperties && f.appProperties.key || "", sid = /^s\d+$/.test(key) ? +key.slice(1) : null;
    await openEntries(entries, sid, { name: "" }, can("editor") ? "mod" : "preview", { drive: { folder: { id: f.id, name: f.name }, remote } });
  } catch (e) { hideLoading(); toast(gdErrText(e), 4500); }
}
async function gdOpenFile(f) {
  try {
    showLoading(tr("Downloading from Google Drive…"), -1);
    const b = await gdDownload(f.id);
    if (/\.osu$/i.test(f.name)) await openEntries({ [f.name]: blobEntry(f.name, b) }, null, { name: "" }, can("editor") ? "mod" : "preview");
    else await openZip(b, null, { name: "" }, can("editor") ? "mod" : "preview");
  } catch (e) { hideLoading(); toast(gdErrText(e), 4500); }
}
// Google's file picker (when the site has an API key): any .osz / .osu / .zip in the user's Drive
async function gdPick() {
  const c = gdCfg(); if (!c.api_key) return;
  const tok = await gdToken(true);
  await gdScript("https://apis.google.com/js/api.js");
  await new Promise(ok => gapi.load("picker", ok));
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(false).setSelectFolderEnabled(false);
  new google.picker.PickerBuilder().setOAuthToken(tok).setDeveloperKey(c.api_key).setAppId(c.app_id).addView(view)
    .setCallback(d => {
      if (d.action !== google.picker.Action.PICKED || !d.docs || !d.docs[0]) return;
      const f = d.docs[0];
      if (!/\.(osz|osu|zip)$/i.test(f.name || "")) return toast(tr("Pick an .osz, .osu or .zip file"), 2500);
      gdOpenFile({ id: f.id, name: f.name });
    }).build().setVisible(true);
}

// ---------- the Google Drive window ----------
async function openDrive() {
  if (!gdOn()) return;
  const body = h("div", "gdbox"), list = h("div", "gdlist");
  const row = h("div", "btnrow");
  if (map) {
    const sv = h("button", "btn main sm", GD.folder ? tr("Save to Drive now") : tr("Save this map to Drive"));
    sv.onclick = async () => { sv.disabled = true; if (await gdSave({ manual: true })) fill(); sv.disabled = false; sv.textContent = tr("Save to Drive now"); };
    const ex = h("button", "btn ghost sm", tr("Export .osz to Drive")); ex.onclick = async () => { await gdExportOsz(); fill(); };
    row.append(sv, ex);
  }
  if (gdCfg().api_key) { const pk = h("button", "btn ghost sm", tr("Pick a file from Drive…")); pk.onclick = () => gdPick().catch(e => toast(gdErrText(e), 4000)); row.append(pk); }
  const auto = h("label", "sw"), at = h("span", "swt"), ai = h("input"); ai.type = "checkbox"; ai.className = "switch"; ai.checked = S.gdAuto !== false;
  at.append(h("b", null, tr("Autosave to Drive every 5 minutes")), h("small", null, tr("While a map saved in Drive is open and something changed; only the changed files are sent (usually just the .osu).")));
  auto.append(at, ai); ai.onchange = () => { S.gdAuto = ai.checked; save(); };
  const st = h("p", "hint");
  const dc = h("button", "mlink", tr("Disconnect Google Drive")); dc.onclick = () => { gdDisconnect(); fill(); toast(tr("Google Drive disconnected on this device"), 1800); };
  body.append(h("p", "hint", tr("Your maps go to your own Google Drive (folder \"beatmap viewer\"), straight from your browser: this site's server never sees them. The site can only see the files it put there.")), row, auto, st, list, dc);
  const fill = async () => {
    st.textContent = GD.folder ? tr("This map is in Drive: {f}", { f: GD.folder.name }) + (GD.lastSave ? " · " + tr("last saved {t}", { t: new Date(GD.lastSave).toLocaleTimeString() }) : "") : map ? tr("This map isn't in your Drive yet.") : "";
    list.replaceChildren();
    if (!GD.token || Date.now() >= GD.exp - 60000) {
      const cn = h("button", "btn ghost sm", tr("Connect Google Drive to see your maps there"));
      cn.onclick = async () => { try { await gdToken(true); fill(); if (GD.folder && GD.status === "reconnect") gdSave({}); } catch (e) { toast(gdErrText(e), 4000); } };
      list.append(cn); return;
    }
    list.append(h("p", "hint", tr("Loading…")));
    try {
      const root = await gdRoot(false), items = await gdList(`'${root}' in parents and trashed=false`, false);
      list.replaceChildren();
      const maps = items.filter(x => x.mimeType === GD_FOLDER), osz = items.filter(x => x.mimeType !== GD_FOLDER && /\.(osz|osu|zip)$/i.test(x.name));
      if (!maps.length && !osz.length) list.append(h("p", "hint", tr("Nothing in your Drive from this site yet.")));
      const item = (x, isMap) => {
        const r = h("div", "gditem"), info = h("div");
        info.append(h("b", null, x.name), h("small", null, (isMap ? tr("map folder") : ".osz · " + cloudMB(+x.size || 0)) + " · " + fmtDate(x.modifiedTime)));
        const op = h("button", "btn ghost sm", tr("Open")); op.onclick = () => { closeMdl(); isMap ? gdOpenFolder(x) : gdOpenFile(x); };
        r.append(info, op); list.append(r);
      };
      if (maps.length) { list.append(h("h4", null, tr("Maps"))); maps.forEach(x => item(x, true)); }
      if (osz.length) { list.append(h("h4", null, tr("Exported .osz"))); osz.forEach(x => item(x, false)); }
    } catch (e) { list.replaceChildren(h("p", "warnline", gdErrText(e))); }
  };
  let closeMdl = () => {};
  fill();
  const p = modal({ title: tr("Google Drive"), body, dismiss: null, wide: true, buttons: [{ label: tr("Close"), value: null, cls: "main" }] });
  closeMdl = () => { const w = body.closest(".mdl"); if (w) w.querySelector(".mdlbtns .btn").click(); };
  await p;
}

// ---------- older versions: Google Drive keeps the earlier copies of each file (about 30 days, or 100 copies) ----------
// Compare (compare.js) lists them for the open difficulty's .osu; one can be compared with or brought back.
function gdCompareButton() {
  if (!gdOn() || !GD.folder || !GD.remote || !osuFiles[curDiff] || !GD.remote.get(osuFiles[curDiff].path)) return null;
  const b = h("button", "chip", "☁ " + tr("An older copy in Drive…")); b.type = "button"; b.onclick = gdVersions; return b;
}
async function gdVersions() {
  const path = osuFiles[curDiff].path, f = GD.remote.get(path); if (!f) return;
  const body = h("div", "gdbox"), list = h("div", "gdlist"); body.append(h("p", "hint", tr("Earlier saves of {f} in your Drive (Google keeps them about 30 days). Pick one to compare with what's open now.", { f: path })), list);
  list.append(h("p", "hint", tr("Loading…")));
  let close = () => {};
  (async () => {
    try {
      const r = await (await gdFetch(`${GD_API}/files/${f.id}/revisions?pageSize=200&fields=revisions(id,modifiedTime,size)`, {}, true)).json();
      const revs = (r.revisions || []).slice().reverse(); list.replaceChildren();
      if (!revs.length) list.append(h("p", "hint", tr("No earlier copies yet.")));
      revs.forEach((v, i) => {
        const row = h("div", "gditem"), info = h("div");
        info.append(h("b", null, fmtDate(v.modifiedTime)), h("small", null, (i === 0 ? tr("latest save") + " · " : "") + (v.size ? (+v.size / 1024).toFixed(1) + " KB" : "")));
        const cmp = h("button", "btn ghost sm", tr("Compare"));
        cmp.onclick = async () => {
          cmp.disabled = true;
          try { const t = await (await gdFetch(`${GD_API}/files/${f.id}/revisions/${v.id}?alt=media`, {}, true)).text(); close(); cmpUse("drive", fmtDate(v.modifiedTime), t); }
          catch (e) { cmp.disabled = false; toast(gdErrText(e), 4000); }
        };
        row.append(info, cmp); list.append(row);
      });
    } catch (e) { list.replaceChildren(h("p", "warnline", gdErrText(e))); }
  })();
  const p = modal({ title: tr("Older copies in Drive"), body, dismiss: null, wide: true, buttons: [{ label: tr("Close"), value: null, cls: "main" }] });
  close = () => { const w = body.closest(".mdl"); if (w) w.querySelector(".mdlbtns .btn").click(); };
  await p;
}

// ---------- buttons ----------
function gdButtons() {
  const on = gdOn();
  if (on) gdScript("https://accounts.google.com/gsi/client").catch(() => {}); // (ready before the first click: Google's window needs the click)
  document.querySelectorAll(".gdopen").forEach(b => { b.hidden = !on; b.onclick = openDrive; });
  gdStatus(GD.status);
}
$("gdBtn").onclick = openDrive;
$("gdChip").onclick = async () => {
  if (GD.status === "reconnect") { try { await gdToken(true); gdSave({}); } catch (e) { toast(gdErrText(e), 4000); } return; }
  if (GD.status === "unsaved" || GD.status === "error") return gdSave({ manual: true });
  openDrive();
};
addEventListener("beforeunload", e => { if (GD.folder && GD.dirty && GD.saving) { e.preventDefault(); e.returnValue = ""; } });
