"use strict";
// ============ Save online: private projects ============
// Optional. A project = the whole beatmap package (every difficulty, song, images) plus its annotations, stored privately
// within the owner's limits (30,000,000 bytes and 15 days from the first online save by default; the site's admins can
// change them; saving again doesn't extend the date). Only you and the people you share it with (viewer / editor) can
// open it, or anyone with its share link (read-only) when the owner turns that on; the server checks it on every request.
// Saving uploads only files that changed (by SHA-256), straight to storage with one-time signed links, then the
// server checks them and switches the project to the new revision in one step, or refuses (e.g. someone else saved
// first): the last complete revision always stays usable. Unsaved work is also kept on this device (drafts.js).
const CLOUD = { me: null, project: null, role: "", status: "", err: "", busy: false, clientKey: "", gen: 0, savedGen: -1, pct: 0 };
const VIDEO_EXT = /\.(mp4|avi|flv|m4v|mov|wmv|mkv|webm|mpg|mpeg)$/i;

async function cloudMe(force) {
  if (CLOUD.me && !force) return CLOUD.me;
  try {
    const r = await fetch("/api/v1/me", { cache: "no-store", credentials: "same-origin" });
    CLOUD.me = (r.headers.get("content-type") || "").includes("json") ? await r.json() : { cloud: false };
  } catch { CLOUD.me = { cloud: false }; }
  if (CLOUD.me.deleted && typeof AUTH !== "undefined" && AUTH.user && !AUTH.user.dev) { AUTH.user = null; if (typeof renderAccount === "function") renderAccount(); } // (a login from before the account was deleted)
  if (typeof prefsPull === "function") prefsPull(CLOUD.me);
  if (typeof gdButtons === "function") gdButtons();
  if (typeof renderAccount === "function" && CLOUD.me.badges) renderAccount(); // (admins: a count of people waiting / new errors)
  return CLOUD.me;
}
const cloudEnabled = () => !!(CLOUD.me && CLOUD.me.cloud);
// the logged-in user's limits, as the server reports them (site settings or the user's own)
const cloudLimits = () => Object.assign({ max_project_bytes: 30000000, retention_days: 15, max_projects: 10, saving_enabled: true }, CLOUD.me && CLOUD.me.limits || {});
const cloudMB = b => +(b / 1e6).toFixed(1) + " MB";
const projLimit = p => p && p.limit_bytes || cloudLimits().max_project_bytes;
const cloudLinkURL = (p, t) => p && p.link_key ? `${location.origin}${location.pathname}?project=${p.id}&key=${p.link_key}${t > 0 ? "&t=" + Math.round(t) : ""}` : null;
async function capi(method, route, body) {
  let r;
  try { r = await fetch("/api/v1/" + route, { method, credentials: "same-origin", cache: "no-store", headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error(tr("Couldn't reach the server")), { code: "network" }); }
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error((j && j.error) || "HTTP " + r.status), { code: (j && j.error) || "http_" + r.status, status: r.status, detail: j && j.detail });
  return j;
}
function cloudErrText(e) {
  const d = e.detail || {};
  return ({
    login_required: tr("Log in with osu! to save online"), not_configured: tr("Online saving isn't set up on this site yet"),
    too_large: tr("The project is bigger than {l} ({s}). Leave out the video or big storyboard files.", { l: cloudMB(d.limit || cloudLimits().max_project_bytes), s: cloudMB(d.size || 0) }),
    expired: tr("This project has expired and can't be opened or saved any more."),
    saving_disabled: tr("Online saving is paused by the site's admins right now. Your work stays on this device; try again later."),
    too_many_members: tr("This project is already shared with the most people allowed ({n}).", { n: d.limit || 20 }),
    forbidden: d.reason === "no_add" ? tr("This person doesn't let others add them to online projects") : tr("You can only view this project"),
    account_deleted: tr("This account was deleted. Log in again to start a new one."), not_found: tr("This project doesn't exist or you don't have access to it"),
    suspended: tr("Your account can't use online projects right now"), storage_full: tr("The server's storage is full right now. Try again later, or delete old projects."), storage_limit: tr("Online projects have reached this month's free limit. They work again next month."),
    too_many_projects: tr("You have too many online projects (up to {n}). Delete one first.", { n: d.limit || 10 }),
    size_mismatch: tr("An upload didn't arrive complete. Nothing was changed online; try again."), missing_upload: tr("An upload didn't arrive complete. Nothing was changed online; try again."),
    save_expired: tr("The save took too long. Nothing was changed online; try again."), too_many_pending: tr("Too many unfinished uploads. Try again in a few hours."),
    network: tr("Couldn't reach the server"), conflict: tr("Someone saved a newer version online"), bad_files: tr("Some file names in this map can't be saved online"),
  })[e.code] || tr("Couldn't save online ({err})", { err: e.code || e.message });
}

// ---------- status in the editor ----------
function setCloud(st, err) {
  CLOUD.status = st; CLOUD.err = err || "";
  const b = $("cloudBtn"), c = $("cloudChip"); if (!b) return;
  b.hidden = !cloudEnabled() || !map || PKG && PKG.kind === "live";
  b.disabled = CLOUD.busy || (CLOUD.project && !["owner", "editor"].includes(CLOUD.role));
  c.hidden = b.hidden || !CLOUD.project && st !== "error" && st !== "saving";
  c.className = "cchip " + st;
  const p = CLOUD.project;
  c.textContent = st === "saving" ? tr("Saving online… {p}%", { p: CLOUD.pct }) : st === "saved" ? tr("Saved online") : st === "unsaved" ? tr("Not saved online") : st === "error" ? tr("Online save failed") : st === "view" ? tr("Online · view only") : "";
  c.title = p ? tr("Revision {r} · {s} of {l} · expires {d}", { r: p.revision, s: cloudMB(p.size_bytes || 0), l: cloudMB(projLimit(p)), d: fmtDate(p.expires_at) }) + (err ? "\n" + err : "") : err || "";
}
function cloudTouch() { // something changed in the map or its annotations
  CLOUD.gen++;
  if (typeof gdTouch === "function") gdTouch(); // (Google Drive autosave)
  if (CLOUD.project && !CLOUD.busy && CLOUD.status !== "error") setCloud(["owner", "editor"].includes(CLOUD.role) ? "unsaved" : "view");
}
function cloudDetach(next) { CLOUD.project = next || null; CLOUD.role = next ? next.role : ""; CLOUD.clientKey = ""; CLOUD.status = ""; ANN.role = CLOUD.role; setCloud(next ? (["owner", "editor"].includes(next.role) ? "saved" : "view") : ""); }

// ---------- saving ----------
function cloudFiles() { // the package as it is now: every .osu (with unsaved edits), song, images, storyboard; ids of the objects
  const out = [], own = new Set(osuFiles.map(o => norm(o.path))), ids = {};
  osuFiles.forEach((f, i) => {
    const cur = i === curDiff && map && EDIT.changed;
    out.push({ path: f.path, text: cur ? editedText() : f.text });
    ids[f.path] = cur ? map.lines.map(L => L.id) : f.ids || null;
  });
  const rest = [];
  for (const k in files) { if (own.has(k)) continue; const f = files[k]; if (f.dir || f.name.startsWith(".obv/")) continue; rest.push(f); }
  return { osu: out, rest, ids };
}
async function sha256hex(buf) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function cloudExplain() {
  const box = h("div", "mdlb"), ul = h("ul", "plist");
  box.append(h("p", null, tr("Your map is saved as a private project on this site's server so you can open it again from another device or share it.")));
  for (const t of [tr("Private: only you, and people you add by their osu! name, can open it. Your osu! profile page never lists it."),
    tr("Kept for {n} days from this first online save. Saving again doesn't extend it. After that it can't be opened and is deleted (usually within a day). Download the .osz to keep a copy.", { n: cloudLimits().retention_days }),
    tr("Up to {l} in total (all difficulties, the song, images and storyboard files). Video files are left out.", { l: cloudMB(cloudLimits().max_project_bytes) }),
    tr("Stored: the files of the map, your annotations, the project name, your osu! id and name, and when it was saved. You can delete it any time."),
    tr("The site owner and the admins they appoint run the service and can technically reach stored data; the admin tools show names, sizes and dates, not your files, and admin actions are logged.")]) ul.append(h("li", null, t));
  box.append(ul);
  const pv = h("a", "mlink", tr("Privacy")); pv.href = "?view=privacy"; pv.target = "_blank"; box.append(pv);
  return modal({ title: tr("Save online?"), body: box, dismiss: false, buttons: [{ label: tr("Cancel"), value: false }, { label: tr("Save online"), value: true, cls: "main" }] });
}
// one save at a time: a second click (or Ctrl+S) while saving joins the running save instead of starting another
function cloudSave(opts = {}) {
  if (CLOUD.running) return CLOUD.running;
  CLOUD.running = cloudSaveRun(opts).finally(() => {
    CLOUD.running = null;
    if (CLOUD.conflict) { const d = CLOUD.conflict; CLOUD.conflict = null; cloudConflict(d); }
  });
  return CLOUD.running;
}
async function cloudSaveRun(opts) {
  if (!map) return;
  await cloudMe();
  if (!cloudEnabled()) return toast(tr("Online saving isn't set up on this site yet"), 3000);
  if (!AUTH.checked) await authCheck();
  if (!AUTH.user || AUTH.user.dev) {
    const v = await modal({ title: tr("Log in to save online"), body: tr("Online projects belong to your osu! account. Your unsaved work stays on this device as a draft while you log in."), dismiss: false, buttons: [{ label: tr("Cancel"), value: false }, { label: tr("Log in with osu!"), value: true, cls: "main" }] });
    if (v) { draftFlush(); authLogin(); }
    return;
  }
  if (CLOUD.project && !["owner", "editor"].includes(CLOUD.role)) return toast(tr("You can only view this project"), 2500);
  if (COLLAB.on && !collabCanEdit()) return collabNoEdit();
  if (!CLOUD.project && !opts.skipExplain && !await cloudExplain()) return;
  CLOUD.busy = true; CLOUD.pct = 0; setCloud("saving");
  const gen = CLOUD.gen;
  try {
    // 1. the files and their fingerprints
    const pk = cloudFiles(), items = [];
    for (const o of pk.osu) { const data = new TextEncoder().encode(o.text); items.push({ path: o.path, data }); }
    for (const f of pk.rest) { if (VIDEO_EXT.test(f.name)) continue; const data = new Uint8Array(await f.async("arraybuffer")); items.push({ path: f.name, data }); }
    items.push({ path: ".obv/ids.json", data: new TextEncoder().encode(JSON.stringify({ v: 1, ids: pk.ids })) });
    const total = items.reduce((s, x) => s + x.data.length, 0);
    if (total > projLimit(CLOUD.project)) throw Object.assign(new Error("too_large"), { code: "too_large", detail: { size: total, limit: projLimit(CLOUD.project) } });
    for (const it of items) it.sha256 = await sha256hex(it.data);
    // 2. the project (the same client key on a retry, so a double click never makes two)
    if (!CLOUD.project) {
      CLOUD.clientKey = CLOUD.clientKey || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^\w-]/g, "");
      const m = map.meta, r = await capi("POST", "projects", { clientKey: CLOUD.clientKey, title: m.TitleUnicode || m.Title || "", artist: m.ArtistUnicode || m.Artist || "", creator: m.Creator || "", setId: +onlineSet > 0 ? +onlineSet : null });
      CLOUD.project = r.project; CLOUD.role = "owner"; ANN.role = "owner";
    }
    const p = CLOUD.project, baseRevision = opts.base != null ? opts.base : p.revision;
    // 3. which files to upload (unchanged ones are reused), each straight to storage
    const b = await capi("POST", `projects/${p.id}/saves`, { baseRevision, files: items.map(x => ({ path: x.path, size: x.data.length, sha256: x.sha256 })) });
    const up = b.uploads, upBytes = up.reduce((s, u) => s + u.size, 0) || 1; let done = 0;
    for (const u of up) {
      const it = items.find(x => x.path === u.path), own = u.url.startsWith("/"), fd = new FormData(); // own: this site's R2 link (the file as it is), else Supabase Storage (a form)
      if (!own) { fd.append("cacheControl", "3600"); fd.append("", new Blob([it.data])); }
      let ok = false;
      for (let tries = 0; tries < 3 && !ok; tries++) {
        try { const r = own ? await fetch(u.url, { method: "PUT", body: new Blob([it.data]) }) : await fetch(u.url, { method: "PUT", body: fd, headers: { "x-upsert": "false" } }); ok = r.ok || r.status === 409 || (r.status === 400 && /exists/i.test(await r.text())); } catch {}
        if (!ok) await sleep(800 * (tries + 1));
      }
      if (!ok) throw Object.assign(new Error("upload"), { code: "missing_upload" });
      done += u.size; CLOUD.pct = Math.round(done / upBytes * 100); setCloud("saving");
    }
    // 4. commit: the server checks the uploads and switches to the new revision (or refuses, and nothing changes)
    const c = await capi("POST", `saves/${b.saveId}/commit`, { annotations: annChanges() });
    Object.assign(p, { revision: c.revision, size_bytes: c.size_bytes, expires_at: c.expires_at, updated_at: c.updated_at });
    await cloudSyncAnnotations(c.annotations);
    if (PKG && PKG.kind !== "cloud") { const old = DRAFT.key; draftDetach(); if (old) draftDelete({ key: old, uid: DRAFT.uid || draftUid(), pkey: old.split("|")[2] }); draftPkg("cloud", { projectId: p.id }); draftAttach(); }
    if (CLOUD.gen === gen) { // nothing changed while saving: the online copy is the current state
      EDIT.changed = false; osuFiles.forEach(o => { if (o.edited || o.created) { o.edited = o.created = false; } });
      osuFiles.forEach((o, i) => { if (i !== curDiff) return; o.text = editedText(); o.ids = map.lines.map(L => L.id); });
      CLOUD.savedGen = gen; setCloud("saved");
    } else setCloud("unsaved");
    draftSchedule();
    if (COLLAB.on) collabNotifySaved(c.revision);
    toast(tr("Saved online (revision {r})", { r: c.revision }) + (b.uploads.length ? "" : " · " + tr("no files changed")), 2500);
    if (c.annotations && (c.annotations.conflicts.length || c.annotations.denied.length)) toast(tr("Some annotations weren't saved: someone changed them meanwhile, or they aren't yours"), 4000);
  } catch (e) {
    if (e.code === "conflict") { CLOUD.conflict = e.detail || {}; setCloud("error", cloudErrText(e)); return; }
    setCloud("error", cloudErrText(e)); toast(cloudErrText(e), 5000);
  } finally { CLOUD.busy = false; if (CLOUD.status === "saving") setCloud("error"); else setCloud(CLOUD.status, CLOUD.err); }
}
async function cloudConflict(d) {
  const v = await modal({ title: tr("Someone saved a newer version"), body: tr("Revision {r} was saved online by {n} ({t}) after you opened this project. Your changes are still here, and kept as a draft on this device.", { r: d.revision, n: d.saved_by || "?", t: fmtDate(d.updated_at) }),
    dismiss: null, buttons: [{ label: tr("Cancel"), value: null }, { label: tr("Open the newer version"), value: "open" }, { label: tr("Replace it with mine"), value: "mine", cls: "ghost danger" }] });
  if (v === "mine" && (await ask(tr("Replace revision {r} with your version? Their changes will only be in the older revision's history if they kept a copy.", { r: d.revision }), { ok: tr("Replace") }))) cloudSave({ base: d.revision, skipExplain: true });
  if (v === "open") { draftFlush(); cloudOpenProject(CLOUD.project.id); }
}
// annotations: what changed here since the last online save
function annChanges() {
  const upsert = [], del = [];
  for (const a of ANN.list) {
    if (!annIsLocal(a)) continue;
    if (a.local === "deleted") { if (a.version) del.push({ id: a.id, base_version: a.version }); continue; }
    const v = { id: a.id, diff: a.diff, kind: a.kind, object_id: a.object_id, time_ms: Math.round(a.time_ms || 0), body: a.body || "", data: a.data || {}, object_missing: !!a.object_missing };
    if (a.version && a.local !== "anchor") v.base_version = a.version;
    upsert.push(v);
  }
  return { upsert, delete: del };
}
async function cloudSyncAnnotations(res) {
  const keep = new Set([...(res && res.conflicts || []), ...(res && res.denied || [])]);
  const g = await capi("GET", `projects/${CLOUD.project.id}?files=0`);
  const server = (g.project.annotations || []).map(a => ({ ...a, local: "" }));
  const stillLocal = ANN.list.filter(a => keep.has(a.id));
  const ids = new Set(stillLocal.map(a => a.id));
  annImport([...server.filter(a => !ids.has(a.id)), ...stillLocal]);
  CLOUD.project.members = g.project.members;
}

// ---------- opening a project ----------
// opts.key: a share link's key (opens read-only without logging in; members who are logged in get their own role)
async function cloudOpenProject(id, opts = {}) {
  await cloudMe();
  if (!AUTH.checked) await authCheck();
  const key = /^[A-Za-z0-9_-]{32}$/.test(opts.key || "") ? opts.key : "";
  if (!AUTH.user && !key) { toast(tr("Log in with osu! to open online projects"), 3000); openAcct(); return; }
  if (!(await edConfirmDiscard())) return;
  showLoading(tr("Opening the project…"), -1);
  try {
    let p = null;
    if (AUTH.user && !AUTH.user.dev) { try { p = (await capi("GET", `projects/${id}`)).project; } catch (e) { if (!key || !["not_found", "forbidden", "suspended", "login_required"].includes(e.code)) throw e; } }
    if (!p) p = (await capi("GET", `link/${id}?key=${key}`)).project;
    const entries = {}; let idsDoc = null, got = 0; const total = p.files.reduce((s, f) => s + f.size, 0) || 1;
    for (const f of p.files) {
      const r = await fetch(f.url); if (!r.ok) throw Object.assign(new Error("download"), { code: "download" });
      const blob = await r.blob(); if (blob.size !== f.size) throw Object.assign(new Error("download"), { code: "download" });
      got += f.size; showLoading(tr("Downloading the project… {p}%", { p: Math.round(got / total * 100) }), got / total);
      if (f.path === ".obv/ids.json") { try { idsDoc = JSON.parse(await blob.text()); } catch {} }
      else entries[f.path] = blobEntry(f.path, blob);
    }
    if (!Object.keys(entries).some(k => k.toLowerCase().endsWith(".osu"))) throw Object.assign(new Error("empty"), { code: "empty" });
    const annotations = (p.annotations || []).map(a => ({ ...a, local: "" }));
    if (opts.t > 0) startAt = opts.t;
    await openEntries(entries, p.source_set_id || null, { name: "" }, "mod", { force: true, cloud: p, ids: idsDoc && idsDoc.ids, annotations });
    if (location.search.includes("project=")) history.replaceState(history.state, "", location.pathname + "?project=" + p.id + (key ? "&key=" + key : ""));
    if (p.role === "link") toast(tr("Opened from a share link: you can look and download; only its owner and editors can save."), 4500);
  } catch (e) { hideLoading(); toast(e.code === "download" ? tr("Couldn't download the project's files. Try again.") : e.code === "empty" ? tr("This project has nothing saved yet") : cloudErrText(e), 5000); }
}

// ---------- project info (the chip) ----------
async function cloudInfo() {
  const p = CLOUD.project; if (!p) return cloudSave();
  const box = h("div", "mdlb cinfo");
  const pct = Math.min(100, (p.size_bytes || 0) / projLimit(p) * 100);
  const bar = h("div", "sizebar"), fill = h("i"); fill.style.width = pct.toFixed(1) + "%"; bar.append(fill);
  box.append(h("p", null, `${p.artist || ""} - ${p.title || ""}`), bar,
    h("p", "hint", tr("{s} of {l} · revision {r} · you are {role}", { s: cloudMB(p.size_bytes || 0), l: cloudMB(projLimit(p)), r: p.revision, role: tr({ owner: "the owner", editor: "an editor", viewer: "a viewer", link: "a viewer (share link)" }[CLOUD.role] || CLOUD.role) })),
    h("p", "expline", tr("Expires {d} (saving doesn't extend it)", { d: fmtDate(p.expires_at) })),
    h("p", "hint", CLOUD.status === "unsaved" ? tr("You have changes that aren't saved online yet.") : CLOUD.status === "error" ? CLOUD.err : tr("Private: only the people you share it with can open it.")));
  const btns = [{ label: tr("Close"), value: null }];
  if (CLOUD.role === "owner") btns.unshift({ label: tr("Delete project"), value: "del", cls: "ghost danger" }, { label: tr("Share"), value: "share" });
  else if (CLOUD.role === "link" && p.link_key) btns.unshift({ label: tr("Copy the link"), value: "link" });
  if (["owner", "editor"].includes(CLOUD.role)) btns.push({ label: tr("Save online"), value: "save", cls: "main" });
  const v = await modal({ title: tr("Online project"), body: box, dismiss: null, buttons: btns });
  if (v === "save") cloudSave();
  if (v === "share") cloudShare(p);
  if (v === "link") shareLink(cloudLinkURL(p), p.title || "");
  if (v === "del") cloudDelete(p, true);
}
async function cloudDelete(p, open) {
  if (!(await ask(tr("Delete \"{t}\" from the server for everyone? This can't be undone. People who downloaded it keep their copies.", { t: p.title || p.id }), { ok: tr("Delete"), danger: true }))) return false;
  try {
    const r = await capi("DELETE", `projects/${p.id}`, {});
    toast(r.files_removed ? tr("Project deleted") : tr("Project deleted. Its files will be removed from storage within a day."), 3500);
    if (open && CLOUD.project && CLOUD.project.id === p.id) { cloudDetach(null); draftPkg("local", {}); draftAttach(); }
    return true;
  } catch (e) { toast(cloudErrText(e), 4000); return false; }
}
async function cloudShare(p) {
  let members = Array.isArray(p.members) ? p.members : null; // the projects list only has a count
  if (!members || p.link_key === undefined) {
    try { const g = (await capi("GET", `projects/${p.id}?files=0`)).project; members = g.members; p.link_key = g.link_key || null; } catch (e) { return toast(cloudErrText(e)); }
  }
  const box = h("div", "mdlb share"), list = h("div", "cslist");
  // "anyone with the link can view"
  const linkBox = h("div", "clink");
  const drawLink = () => {
    linkBox.innerHTML = "";
    const head = h("div", "clinkh"); head.append(h("b", null, tr("Share link")), h("small", null, p.link_key ? tr("On: anyone with the link can open and download it, without logging in. They can't save.") : tr("Off: only the people below can open it.")));
    linkBox.append(head);
    if (p.link_key) {
      const url = cloudLinkURL(p), inp = h("input", "clinkurl"); inp.readOnly = true; inp.value = url; inp.onfocus = () => inp.select();
      const copy = h("button", "btn main sm", tr("Copy")); copy.type = "button"; copy.onclick = () => shareLink(url, p.title || "");
      const reset = h("button", "mlink", tr("New link (the old one stops working)")); reset.type = "button"; reset.onclick = () => setLink("reset");
      const off = h("button", "mlink", tr("Turn off")); off.type = "button"; off.onclick = () => setLink("off");
      const row = h("div", "clinkrow"); row.append(inp, copy);
      const row2 = h("div", "clinkrow2"); row2.append(reset, off);
      linkBox.append(row, row2, h("small", "hint", tr("Works until {d}, when the project expires.", { d: fmtDate(p.expires_at) })));
    } else {
      const on = h("button", "btn ghost sm", tr("Create a link")); on.type = "button"; on.onclick = () => setLink("on"); linkBox.append(on);
    }
  };
  const setLink = async mode => {
    if (mode === "off" && !(await ask(tr("Turn the link off? People who have it can't open the project any more."), { ok: tr("Turn off"), danger: true }))) return;
    try { const r = await capi("POST", `projects/${p.id}/link`, { mode }); p.link_key = r.link_key; if (CLOUD.project && CLOUD.project.id === p.id) CLOUD.project.link_key = r.link_key; drawLink(); if (r.link_key && mode !== "off") shareLink(cloudLinkURL(p), p.title || ""); }
    catch (e) { toast(cloudErrText(e), 3500); }
  };
  drawLink();
  const draw = () => {
    list.innerHTML = "";
    if (!members.length) list.append(h("p", "hint", tr("Not shared with anyone yet.")));
    for (const m of members) {
      const row = h("div", "csm"), sel = h("select");
      for (const [v, l] of [["viewer", tr("view only")], ["editor", tr("can edit")]]) sel.add(new Option(l, v));
      sel.value = m.role; sel.onchange = () => set(String(m.id), sel.value);
      const rm = h("button", "mlink", tr("Remove")); rm.onclick = () => set(String(m.id), "none");
      row.append(avatarEl(m.id, m.username), h("span", "csname", m.username), sel, rm); list.append(row);
    }
  };
  const set = async (user, role) => {
    try { members = (await capi("POST", `projects/${p.id}/members`, { user, role })).members; p.members = members; draw(); toast(role === "none" ? tr("Access removed") : tr("Shared"), 1500); }
    catch (e) { toast(e.code === "user_not_found" ? tr("No osu! user with that name") : e.code === "osu_lookup_failed" ? tr("Couldn't look the name up on osu!, try again") : cloudErrText(e), 3500); }
  };
  const form = h("form", "searchrow"), inp = h("input"), role = h("select"), add = h("button", "btn main sm", tr("Add"));
  inp.placeholder = tr("osu! username"); inp.maxLength = 32; inp.autocomplete = "off";
  for (const [v, l] of [["viewer", tr("view only")], ["editor", tr("can edit")]]) role.add(new Option(l, v));
  form.append(inp, role, add);
  form.onsubmit = e => { e.preventDefault(); const u = inp.value.trim(); if (u) set(u, role.value).then(() => { inp.value = ""; }); };
  inp.addEventListener("keydown", e => e.stopPropagation());
  box.append(linkBox, h("b", "cshead", tr("People")), h("p", "hint", tr("People you add can open this project after logging in with osu!. Editors can also save and annotate; viewers can only look and download. Removing someone stops their access at once, but copies they downloaded stay with them.")), form, list);
  draw();
  modal({ title: tr("Share \"{t}\"", { t: p.title || "" }), body: box, dismiss: null, buttons: [{ label: tr("Done"), value: null, cls: "main" }] });
}

// ---------- My projects page ----------
async function renderProjects() {
  const box = $("projects"); box.innerHTML = "";
  const head = h("div", "vhead"), back = h("a", "btn ghost sm", "← " + tr("Editor")); back.href = "?view=editor"; back.dataset.go = "editor";
  head.append(back, h("h2", null, tr("My online projects")), h("p", null, tr("Private projects saved on this site. Each one is kept for {n} days from its first online save, up to {l}.", { n: cloudLimits().retention_days, l: cloudMB(cloudLimits().max_project_bytes) })));
  box.append(head);
  await cloudMe(true);
  if (!AUTH.checked) await authCheck();
  if (!cloudEnabled()) { box.append(h("div", "empty", tr("Online saving isn't set up on this site yet"))); return; }
  if (!AUTH.user || AUTH.user.dev) { const e = h("div", "empty", tr("Log in with osu! to see your online projects") + " "); const b = h("button", "btn main sm", tr("Log in with osu!")); b.onclick = authLogin; e.append(b); box.append(e); return; }
  const list = h("div", "plistbox"); list.append(h("div", "card sk"), h("div", "card sk")); box.append(list);
  let projects;
  try { projects = (await capi("GET", "projects")).projects; } catch (e) { list.innerHTML = ""; const d = h("div", "empty", cloudErrText(e) + " "); const again = h("button", "btn ghost sm", tr("Try again")); again.onclick = renderProjects; d.append(again); list.append(d); return; }
  list.innerHTML = "";
  if (!projects.length) { list.append(h("div", "empty", tr("No online projects yet. Open a map in the editor and press Save online."))); return; }
  for (const p of projects) {
    const el = h("article", "proj"), left = Math.max(0, new Date(p.expires_at) - Date.now()), days = Math.floor(left / 864e5), hrs = Math.floor(left / 36e5) % 24;
    const top = h("div", "projtop");
    top.append(h("b", null, `${p.artist || "?"} - ${p.title || "?"}`), h("em", "badge" + (p.role === "owner" ? "" : " dim"), tr({ owner: "owner", editor: "can edit", viewer: "view only" }[p.role])));
    const bar = h("div", "sizebar"), fill = h("i"); fill.style.width = Math.min(100, p.size_bytes / projLimit(p) * 100).toFixed(1) + "%"; bar.append(fill);
    const meta = h("small", null, `${cloudMB(p.size_bytes)} / ${cloudMB(projLimit(p))} · ${tr("revision {r}", { r: p.revision })} · ${p.owner && p.role !== "owner" ? tr("by {n}", { n: p.owner.username }) + " · " : ""}${p.members ? tr("shared with {n}", { n: p.members }) + " · " : ""}${tr("saved {d}", { d: fmtDate(p.updated_at) })}`);
    const exp = h("small", "expline" + (left < 864e5 ? " soon" : ""), tr("Expires {d} ({n})", { d: fmtDate(p.expires_at), n: days ? tr("in {d} days {h} h", { d: days, h: hrs }) : tr("in {h} h", { h: hrs }) }));
    const acts = h("div", "btnrow"), open = h("button", "btn main sm", tr("Open")); open.onclick = () => cloudOpenProject(p.id);
    acts.append(open);
    if (p.role === "owner") {
      const sh = h("button", "btn ghost sm", tr("Share")); sh.onclick = () => cloudShare(p);
      const del = h("button", "btn ghost sm danger", tr("Delete")); del.onclick = async () => { if (await cloudDelete(p)) renderProjects(); };
      acts.append(sh, del);
    }
    el.append(top, bar, meta, exp, acts); list.append(el);
  }
}

$("cloudBtn").onclick = () => CLOUD.project && CLOUD.status !== "unsaved" && CLOUD.status !== "error" ? cloudInfo() : cloudSave();
$("cloudChip").onclick = cloudInfo;
addEventListener("keydown", e => { // Ctrl+S = save online (when the site has it)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "s" && EDIT.on && map && cloudEnabled() && !e.target.closest("input,textarea")) { e.preventDefault(); cloudSave(); }
});
cloudMe().then(() => setCloud(CLOUD.status));

// the top bar's Share button for a map that isn't on osu! (made here or opened from a file): a project share link
async function cloudShareLocal() {
  if (!map) return;
  const p = CLOUD.project;
  if (p && p.link_key) return shareLink(cloudLinkURL(p), p.title || "");
  if (p && CLOUD.role === "owner") return cloudShare(p);
  if (p) return toast(tr("Only the project's owner can make a share link."), 3000);
  await cloudMe();
  if (!cloudEnabled()) return toast(tr("This map isn't on osu!, so it has no public link. Export the .osz to send it."), 4000);
  const L = cloudLimits(), box = h("div", "mdlb");
  box.append(h("p", null, tr("This map isn't on osu!, so it has no public link yet.")),
    h("p", null, tr("Save it online and turn on a share link: anyone with the link can open, play and download it (read-only), without logging in. It's kept for {n} days from the first save.", { n: L.retention_days })));
  const v = await modal({ title: tr("Share this map"), body: box, dismiss: false, buttons: [{ label: tr("Cancel"), value: false }, { label: tr("Save online and get a link"), value: true, cls: "main" }] });
  if (!v) return;
  await cloudSave({ skipExplain: true });
  if (!CLOUD.project || CLOUD.status === "error") return;
  try { const r = await capi("POST", `projects/${CLOUD.project.id}/link`, { mode: "on" }); CLOUD.project.link_key = r.link_key; shareLink(cloudLinkURL(CLOUD.project), CLOUD.project.title || ""); }
  catch (e) { toast(cloudErrText(e), 3500); }
}
