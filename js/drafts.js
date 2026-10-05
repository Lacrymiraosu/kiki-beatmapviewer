"use strict";
// ============ unsaved work: drafts on this device (IndexedDB) ============
// A moment after every change, the open map's unsaved edits (the .osu text of changed difficulties, object ids) and its
// annotations are copied to IndexedDB, so a closed tab, crash or reload doesn't lose them. Opening the same map again
// asks: Restore or Discard. Drafts never leave this device (Save online is a separate, explicit action), are kept per
// osu! account ("guest" when logged out) and per map, and are deleted after 30 days without changes.
// Browser storage can be full, disabled or cleared by the browser: this is a safety net, not a guarantee.
const DRAFT_DAYS = 30, DRAFT_MS = DRAFT_DAYS * 864e5, DRAFT_FILES_MAX = 40e6;
const DRAFT = { key: "", uid: "", timer: 0, state: "", at: 0, hold: false, auto: "", filesKey: "", warned: false, ok: true, base: {} };
let PKG = null; // identity of the open package: { kind, pkey, setId, projectId, names, hash }

function draftUid() { const u = AUTH.user; return u ? (u.dev ? "dev:" + u.username : String(u.id)) : "guest"; }
function fnv(s, x = 2166136261) { for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
const textHash = t => fnv(t).toString(36) + t.length.toString(36);
const draftAvailable = () => DRAFT.ok && !!DRAFT.key && typeof indexedDB !== "undefined";

// called by openEntries once the difficulties are read (before any edit)
function draftPkg(kind, info = {}) {
  const fs = osuFiles.slice().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let x = 2166136261; for (const o of fs) x = fnv(o.path + "\n" + o.text, x);
  PKG = { kind, setId: info.setId || null, projectId: info.projectId || null, names: fs.map(o => o.path), hash: (x >>> 0).toString(36) };
  PKG.pkey = kind === "cloud" ? "cloud:" + PKG.projectId : kind === "set" ? "set:" + PKG.setId : "pkg:" + PKG.hash;
  DRAFT.base = Object.fromEntries(osuFiles.map(o => [o.path, textHash(o.text)])); // to tell if the map changed since a draft
  return PKG;
}
const draftKey = (uid, pkey) => `d|${uid}|${pkey}`;
const filesKey = (uid, pkey) => `f|${uid}|${pkey}`;

// ---------- writing ----------
function draftSchedule() {
  if (!DRAFT.key || DRAFT.hold) return;
  clearTimeout(DRAFT.timer);
  DRAFT.timer = setTimeout(() => { DRAFT.timer = 0; draftWrite(); }, 1200);
  if (DRAFT.state !== "error") setDraftState("pending");
}
function draftFlush() { if (DRAFT.timer) { clearTimeout(DRAFT.timer); DRAFT.timer = 0; draftWrite(); } }
// stop autosaving this package (leaving it / opening another): whatever is pending is written first
function draftDetach() { if (DRAFT.key && !DRAFT.hold) draftFlush(); clearTimeout(DRAFT.timer); DRAFT.timer = 0; DRAFT.key = ""; DRAFT.filesKey = ""; DRAFT.hold = false; setDraftState(""); }

function draftSnapshot() { // taken synchronously, so later state changes can't leak into it
  if (!map || !osuFiles[curDiff]) return null;
  const diffs = {};
  osuFiles.forEach((f, i) => {
    const cur = i === curDiff && EDIT.changed;
    if (!cur && !f.edited && !f.created) return;
    diffs[f.path] = { text: cur ? editedText() : f.text, ids: cur ? map.lines.map(L => L.id) : f.ids || null, created: !!f.created, version: cur ? map.meta.Version : f.meta.version, base: DRAFT.base[f.path] || "" };
  });
  const annotations = annExport();
  if (!Object.keys(diffs).length && !annHasLocal()) return { empty: true };
  return { key: DRAFT.key, type: "draft", uid: DRAFT.uid, pkey: PKG.pkey, kind: PKG.kind, setId: PKG.setId, projectId: PKG.projectId, names: PKG.names,
    title: `${map.meta.Artist || ""} - ${map.meta.Title || ""}`, creator: map.meta.Creator || "", version: map.meta.Version || "", cur: osuFiles[curDiff].path,
    diffs, annotations, savedAt: Date.now() };
}
async function draftWrite() {
  if (!DRAFT.key || DRAFT.hold) return;
  const rec = draftSnapshot(); if (!rec) return;
  const key = DRAFT.key, fkey = filesKey(DRAFT.uid, PKG.pkey), needFiles = !rec.empty && (PKG.kind === "new" || PKG.kind === "local") && DRAFT.filesKey !== fkey;
  setDraftState("saving");
  try {
    if (rec.empty) { await idbTx("drafts", "readwrite", s => { s.delete(key); s.delete(fkey); }); DRAFT.filesKey = ""; if (DRAFT.key === key) setDraftState("clean"); return; }
    await idbTx("drafts", "readwrite", s => s.put(rec));
    if (needFiles) { // song, background, storyboard files of a map that exists only here, so the draft can reopen it
      DRAFT.filesKey = fkey;
      const out = {}; let size = 0;
      for (const k in files) { const f = files[k]; if (f.name.toLowerCase().endsWith(".osu")) continue; const b = await f.async("blob"); size += b.size; if (size > DRAFT_FILES_MAX) break; out[f.name] = b; }
      if (size <= DRAFT_FILES_MAX) await idbTx("drafts", "readwrite", s => s.put({ key: fkey, type: "files", uid: DRAFT.uid, pkey: rec.pkey, files: out, osu: osuFiles.filter(o => !o.created).map(o => ({ path: o.path, text: DRAFT.origText && DRAFT.origText[o.path] || o.text })), savedAt: Date.now() }));
    }
    if (DRAFT.key === key) { DRAFT.at = Date.now(); setDraftState("saved"); }
  } catch (e) {
    DRAFT.filesKey = "";
    const full = e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""));
    setDraftState("error", full ? tr("Storage on this device is full") : tr("This browser won't store drafts"));
    if (!DRAFT.warned) { DRAFT.warned = true; toast(full ? tr("Couldn't keep a draft: storage on this device is full. Export the .osz to keep your work.") : tr("Couldn't keep a draft on this device ({err}). Export the .osz to keep your work.", { err: e && e.name || "error" }), 6000); }
  }
}

// ---------- status chip in the editor (separate from the cloud status) ----------
function setDraftState(st, err) {
  DRAFT.state = st; DRAFT.err = err || "";
  const c = $("draftChip"); if (!c) return;
  c.hidden = !st || st === "clean" && !DRAFT.at;
  c.className = "dchip " + st;
  c.textContent = st === "pending" || st === "saving" ? tr("Saving draft…") : st === "saved" ? tr("Draft on this device") : st === "error" ? tr("Draft not saved") : st === "clean" ? tr("No unsaved edits") : "";
  c.title = st === "error" ? DRAFT.err : st === "saved" ? tr("Saved on this device at {t}", { t: new Date(DRAFT.at).toLocaleTimeString() }) : "";
}

// ---------- restore ----------
// when a package has been opened: offer a draft of it, or apply it straight away (Restore from the home page)
async function draftAttach() {
  DRAFT.key = ""; setDraftState("");
  if (DEMO_TOUR || !PKG || PKG.kind === "live" || typeof indexedDB === "undefined") return;
  const noAsk = PKG.kind === "collab"; // joining someone's session: their map, the draft question comes separately (collabDraftCheck)
  if (!AUTH.checked) await authCheck();
  DRAFT.uid = draftUid(); const key = draftKey(DRAFT.uid, PKG.pkey);
  DRAFT.key = key; DRAFT.hold = true; DRAFT.origText = Object.fromEntries(osuFiles.map(o => [o.path, o.text]));
  let rec = null;
  try { rec = await idbTx("drafts", "readonly", s => s.get(key)); DRAFT.ok = true; } catch { DRAFT.ok = false; }
  if (DRAFT.key !== key) return; // another map was opened meanwhile
  if (rec && Date.now() - rec.savedAt > DRAFT_MS) { draftDelete(rec); rec = null; }
  if (rec && rec.type === "draft" && !noAsk) {
    const auto = DRAFT.auto === key; DRAFT.auto = "";
    const go = auto || await draftAsk(rec);
    if (DRAFT.key !== key) return;
    if (go === true) await draftApply(rec);
    else if (go === false) await draftDelete(rec);
  }
  DRAFT.hold = false;
  if (anyEdits() || annHasLocal()) draftSchedule();
}
function draftSummary(rec) {
  const n = Object.keys(rec.diffs || {}).length, a = (rec.annotations || []).filter(x => !x.deleted).length;
  return [n ? tr("{n} difficulties with edits", { n }) : "", a ? tr("{n} annotations", { n: a }) : ""].filter(Boolean).join(" · ");
}
async function draftAsk(rec) {
  const box = h("div", "mdlb");
  box.append(h("p", null, tr("You have unsaved work on this map from {t}, kept on this device.", { t: fmtDate(rec.savedAt) })), h("p", "hint", draftSummary(rec)));
  const changed = Object.entries(rec.diffs || {}).some(([p, d]) => d.base && DRAFT.base[p] && d.base !== DRAFT.base[p]);
  if (changed) box.append(h("p", "warnline", tr("This map changed since the draft was made (for example, it was updated on osu!). Restoring puts your draft's version of the edited difficulties back.")));
  if (COLLAB.on) box.append(h("p", "warnline", tr("You're in a collab session: restoring sends these changes to everyone in it.")));
  return modal({ title: tr("Restore unsaved work?"), body: box, buttons: [{ label: tr("Discard draft"), value: false, cls: "ghost danger" }, { label: tr("Restore"), value: true, cls: "main" }] });
}
async function draftApply(rec) {
  for (const [path, d] of Object.entries(rec.diffs || {})) {
    let i = osuFiles.findIndex(o => o.path === path);
    if (i < 0) { files[norm(path)] = blobEntry(path, new Blob([d.text])); osuFiles.push({ text: d.text, meta: quickMeta(d.text), path, created: true }); i = osuFiles.length - 1; }
    const f = osuFiles[i]; parsedCache.delete(f.text);
    f.text = d.text; f.meta = quickMeta(d.text); f.ids = Array.isArray(d.ids) ? d.ids : null;
    if (d.created) f.created = true; else f.edited = true;
  }
  annImport(rec.annotations || []);
  refreshDiffSelects();
  const ci = osuFiles.findIndex(o => o.path === rec.cur);
  await selectDiff(ci >= 0 ? ci : curDiff);
  if (COLLAB.on) collabPushLocal(tr("Restored draft"));
  toast(tr("Draft restored"), 2500);
}
async function draftDelete(rec) {
  try { await idbTx("drafts", "readwrite", s => { s.delete(rec.key); s.delete(filesKey(rec.uid, rec.pkey)); }); } catch {}
}
async function draftsList() { // this account's drafts, newest first (expired ones are removed)
  if (typeof indexedDB === "undefined") return [];
  let all = [];
  try { all = await idbTx("drafts", "readonly", s => s.getAll()); } catch { return []; }
  const uid = draftUid(), now = Date.now(), out = [];
  for (const r of all) {
    if (r.type !== "draft") continue;
    if (now - r.savedAt > DRAFT_MS) { draftDelete(r); continue; }
    if (r.uid === uid) out.push(r);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
async function draftsClearMine() {
  const uid = draftUid();
  try { const all = await idbTx("drafts", "readonly", s => s.getAll()); await idbTx("drafts", "readwrite", s => { for (const r of all) if (r.uid === uid) s.delete(r.key); }); } catch {}
  DRAFT.filesKey = "";
}
// Restore from the home page: open the map, then apply the draft without asking again
async function draftOpen(rec) {
  DRAFT.auto = rec.key;
  if (rec.kind === "set" && rec.setId) { R.intent = "edit"; history.pushState({ map: 1 }, "", mapURL(rec.setId, null, { mode: "mod" })); route(); return; }
  if (rec.kind === "new" || rec.kind === "local") {
    let fr = null; try { fr = await idbTx("drafts", "readonly", s => s.get(filesKey(rec.uid, rec.pkey))); } catch {}
    if (fr && fr.osu) {
      const entries = {};
      for (const o of fr.osu) entries[o.path] = blobEntry(o.path, new Blob([o.text]));
      for (const [p, b] of Object.entries(fr.files || {})) entries[p] = blobEntry(p, b);
      return openEntries(entries, null, { name: rec.version }, "mod", { force: true, created: rec.kind === "new" });
    }
    DRAFT.auto = "";
    toast(tr("Open the same .osz file again to restore this draft."), 5000); $("file").click(); return;
  }
  if (rec.kind === "cloud" && rec.projectId && typeof cloudOpenProject === "function") return cloudOpenProject(rec.projectId);
  DRAFT.auto = ""; toast(tr("This draft can't be opened here"));
}

// ---------- the list on the home page and in the editor hub ----------
async function renderDrafts() {
  const boxes = [$("homeDrafts"), $("hubDrafts")].filter(Boolean);
  if (!AUTH.checked) await authCheck();
  const list = await draftsList();
  for (const box of boxes) {
    box.innerHTML = ""; box.hidden = !list.length; if (!list.length) continue;
    const head = h("div", "drhead"); head.append(h("b", null, tr("Unsaved work on this device")), h("small", null, tr("Kept in this browser only, for {n} days after the last change.", { n: DRAFT_DAYS })));
    box.append(head);
    for (const r of list.slice(0, 8)) {
      const row = h("div", "drrow"), info = h("div", "drinfo");
      info.append(h("b", null, `${r.title} [${r.version}]`), h("small", null, `${fmtDate(r.savedAt)} · ${{ set: tr("osu! beatmap"), local: tr("file from your computer"), new: tr("new beatmap"), cloud: tr("online project") }[r.kind] || ""}${draftSummary(r) ? " · " + draftSummary(r) : ""}`));
      const go = h("button", "btn main sm", tr("Restore")); go.onclick = () => draftOpen(r);
      const del = h("button", "btn ghost sm", tr("Discard")); del.onclick = async () => { if (!(await ask(tr("Delete this draft from this device? This can't be undone."), { ok: tr("Delete"), danger: true }))) return; await draftDelete(r); renderDrafts(); };
      row.append(info, go, del); box.append(row);
    }
    const clr = h("button", "mlink", tr("Delete all my drafts on this device"));
    clr.onclick = async () => { if (!(await ask(tr("Delete all your drafts from this device? This can't be undone."), { ok: tr("Delete"), danger: true }))) return; await draftsClearMine(); renderDrafts(); toast(tr("Drafts deleted")); };
    box.append(clr);
  }
}

// ---------- the chip: what is stored, where, for how long ----------
function draftInfo() {
  const box = h("div", "mdlb");
  box.append(h("p", null, tr("Your unsaved edits are copied to this browser's storage (IndexedDB) a moment after each change, so a closed tab or a crash doesn't lose them.")));
  const ul = h("ul", "plist");
  for (const t of [tr("Stored: the .osu text of the difficulties you changed, object ids and your annotations; for maps made here or opened from a file, also the song and image files."),
    tr("Only on this device and only for this osu! account (or \"guest\"). Nothing is uploaded: Save online is a separate button."),
    tr("Kept for {n} days after the last change, or until you restore, discard or clear it.", { n: DRAFT_DAYS }),
    tr("The browser may clear its storage (private windows, low space), so this isn't a guarantee: export the .osz to keep your work.")]) ul.append(h("li", null, t));
  box.append(ul);
  if (DRAFT.state === "error") box.append(h("p", "warnline", DRAFT.err));
  modal({ title: tr("Drafts on this device"), body: box, dismiss: null, buttons: [
    { label: tr("Delete all my drafts on this device"), value: "clear", cls: "ghost danger" }, { label: tr("Export .osz"), value: "osz", cls: "ghost" }, { label: tr("Close"), value: null, cls: "main" }] })
    .then(async v => {
      if (v === "osz") exportOsz();
      if (v === "clear" && (await ask(tr("Delete all your drafts from this device? This can't be undone."), { ok: tr("Delete"), danger: true }))) { await draftsClearMine(); setDraftState("clean"); toast(tr("Drafts deleted")); if (anyEdits() || annHasLocal()) draftSchedule(); }
    });
}

$("draftChip").onclick = draftInfo;
addEventListener("pagehide", draftFlush);
document.addEventListener("visibilitychange", () => { if (document.hidden) draftFlush(); });
