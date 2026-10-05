"use strict";
// ============ Account settings (?view=account): settings kept with your account, your data, delete account ============
// ---------- "Sync my settings across devices": the site's settings follow the account ----------
// Device-specific ones stay on each device (audio offset and calibration, volumes, quality, frame rate, view) and so
// does a skin loaded from a file (.osk lives in this browser only).
const PREFS_LOCAL = new Set(["tlH", "edSize", "offset", "offsetBt", "btMode", "hsDelay", "quality", "fps", "masterVol", "musVol", "hsVol", "view", "prefsAt", "acctSync", "skinDefV", "mirrorDefV"]);
function prefsOut() {
  const o = {};
  for (const [k, v] of Object.entries(S)) if (!PREFS_LOCAL.has(k) && !(k === "skin" && /^osk:/.test(v)) && v !== undefined) o[k] = v;
  return o;
}
let prefsTimer = 0, prefsBusy = false;
// called after the settings are written (core.js); uploads a few seconds later, while sync is on
function prefsQueue() {
  if (!S.acctSync || !AUTH.user || AUTH.user.dev || prefsBusy) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(async () => {
    try {
      const r = await capi("POST", "me/account", { prefs: prefsOut() });
      prefsBusy = true; S.acctSync = !!r.sync; if (r.prefs_at) S.prefsAt = r.prefs_at; writeS(); prefsBusy = false;
    } catch {}
  }, 4000);
}
// on load: newer settings on the account than this browser last had -> use them
async function prefsPull(me) {
  if (!me || !me.user || !me.prefs_at || me.prefs_at === S.prefsAt) return;
  let r; try { r = await capi("GET", "me/prefs"); } catch { return; }
  if (!r.sync || !r.prefs) return;
  const keepLang = S.lang;
  prefsBusy = true;
  for (const [k, v] of Object.entries(r.prefs)) if (!PREFS_LOCAL.has(k) && k in DEF) S[k] = v;
  S.acctSync = true; S.prefsAt = r.prefs_at; writeS(); prefsBusy = false;
  if (S.lang !== keepLang && typeof setLang === "function") setLang(S.lang);
  dirty = true;
  if (typeof map === "undefined" || !map) { toast(tr("Your settings were loaded from your account"), 2500); setTimeout(() => location.reload(), 1200); }
  else toast(tr("Your settings were loaded from your account (reload the page to apply all of them)"), 4500);
}

// ---------- the page ----------
async function renderAccountPage() {
  const box = $("account"); box.innerHTML = "";
  const head = h("div", "vhead"); head.append(h("h2", null, tr("Account settings")));
  box.append(head);
  if (!AUTH.checked) { box.append(h("div", "card sk")); return; } // (drawn again once the login is checked: live.js)
  if (!AUTH.user || AUTH.user.dev) {
    const d = h("div", "empty", tr("Log in with osu! to see your account settings.") + " "), b = h("button", "btn main sm", tr("Log in with osu!"));
    b.onclick = authLogin; d.append(b); box.append(d); return;
  }
  const wrap = h("div", "invwrap acctwrap"); wrap.append(h("div", "card sk")); box.append(wrap);
  let a; try { a = await capi("GET", "me/account"); }
  catch (e) { wrap.innerHTML = ""; wrap.append(h("div", "empty", e.code === "not_configured" ? tr("Accounts aren't set up on this site yet.") : tr("Couldn't load your account: {err}", { err: e.message }))); return; }
  wrap.innerHTML = "";
  const card = (title, ...kids) => { const c = h("section", "acard"); if (title) c.append(h("h3", null, title)); c.append(...kids); wrap.append(c); return c; };

  // profile
  const me = h("div", "acctme"), av = h("i", "av big"); if (AUTH.user.avatar) av.style.backgroundImage = `url("${AUTH.user.avatar}")`;
  const nm = h("div"); nm.append(h("b", null, AUTH.user.username),
    h("small", null, tr("osu! ID {id}", { id: AUTH.user.id }) + (a.created_at ? " · " + tr("on this site since {date}", { date: fmtDate(a.created_at, false) }) : "")),
    h("small", null, a.via === "google" ? tr("Logged in with Google (backup login)") : tr("Logged in with osu!")));
  me.append(av, nm);
  const prof = h("a", "btn ghost sm", tr("osu! profile")); prof.href = `https://osu.ppy.sh/users/${AUTH.user.id}`; prof.target = "_blank"; prof.rel = "noopener";
  card(null, me, prof);

  // settings kept with the account
  const sw = (label, hint, on, set) => {
    const l = h("label", "sw"), t = h("span", "swt"), i = h("input"); i.type = "checkbox"; i.className = "switch"; i.checked = on;
    t.append(h("b", null, label), h("small", null, hint)); l.append(t, i);
    i.onchange = async () => { i.disabled = true; try { await set(i.checked); } catch (e) { i.checked = !i.checked; toast(tr("Couldn't save: {err}", { err: e.message }), 3000); } i.disabled = false; };
    return l;
  };
  card(tr("Settings"),
    sw(tr("Sync my settings across devices"), tr("The site's settings (skin, editor options, language, mod note categories…) follow your account to your other devices. Audio offset, volumes, quality and a skin loaded from a file stay on each device. Turning it off deletes them from the server."), !!a.sync,
      async on => {
        const r = await capi("POST", "me/account", { sync: on }); S.acctSync = !!r.sync;
        if (on) { const x = await capi("POST", "me/account", { prefs: prefsOut() }); if (x.prefs_at) S.prefsAt = x.prefs_at; } else S.prefsAt = null;
        prefsBusy = true; writeS(); prefsBusy = false;
        toast(on ? tr("Your settings now follow your account") : tr("Settings sync is off; the copy on the server was deleted"), 2500);
      }),
    sw(tr("Verify: check again after edits"), tr("While Verify or the quick verify list is open, the checks run again when you change the map. Off: they only run again when you press ↻ (saves battery on big mapsets)"), S.vfyAuto !== false,
      async on => { S.vfyAuto = on; save(); }),
    sw(tr("Verify: wait until I stop editing"), tr("Checks again a moment after your last change instead of after every one, so dragging objects stays smooth"), S.vfyWait !== false,
      async on => { S.vfyWait = on; save(); }),
    sw(tr("Let others add me to their online projects"), tr("When off, nobody can share an online project with you by your osu! name. You stay in projects you're already in until you leave or the owner removes you."), a.allow_add !== false,
      async on => { await capi("POST", "me/account", { allow_add: on }); toast(tr("Saved"), 1200); }));

  // backup logins
  if (typeof altOn === "function" && altOn().length) {
    const b = h("button", "btn ghost sm", tr("Manage backup logins")); b.onclick = openBackupLogins;
    const bl = card(tr("Backup logins"), h("p", "hint", tr("A Google account linked to your osu! account, for when osu!'s login doesn't work.")), b);
    capi("GET", "me/logins").then(r => { // asked for access with Google: the osu! name is confirmed by one osu! login in this browser
      if (r && r.linked && r.linked.google && r.linked.google.verified === false) bl.append(h("p", "warnline", tr("Your osu! name isn't verified yet: log in with osu! once in this browser to confirm it's yours.")));
    }).catch(() => {});
  }

  // your data
  const dl = h("a", "btn ghost sm", tr("Download my data (.json)")); dl.href = "/api/v1/me/export";
  const pv = h("a", "mlink", tr("Privacy")); pv.href = "?view=privacy"; pv.dataset.go = "privacy";
  card(tr("Your data"), h("p", "hint", tr("A file with everything this site keeps about your account: your profile here, projects, shares, backup logins, settings and recent activity.")), dl, pv);

  // delete account
  const del = h("button", "btn danger sm", tr("Delete account…"));
  const dz = card(tr("Delete account"), h("p", "hint", tr("Deletes your account on this site for good. Your osu! account isn't touched.")), del);
  dz.classList.add("danger");
  if (a.owner) { del.disabled = true; dz.append(h("p", "hint", tr("The site owner's account can't be deleted."))); }
  else del.onclick = () => confirmDeleteAccount(a);
}

// typing "Confirm" (exactly) unlocks the button; the server checks the same word
async function confirmDeleteAccount(a) {
  const body = h("div", "delacct");
  const ul = h("ul");
  for (const t of [tr("your online projects ({n}) and all their files", { n: a.projects || 0 }), tr("you in other people's projects, and your comments there"),
    tr("your invite links, backup logins and settings kept on the server"), tr("your login on every device (you're logged out everywhere)")]) ul.append(h("li", null, t));
  const inp = h("input"); inp.type = "text"; inp.autocomplete = "off"; inp.spellcheck = false; inp.placeholder = "Confirm"; inp.setAttribute("aria-label", tr("Type Confirm to delete your account"));
  const go = h("button", "btn danger", tr("Delete my account")); go.disabled = true;
  const msg = h("p", "warnline"); msg.hidden = true;
  inp.oninput = () => { go.disabled = inp.value !== "Confirm"; };
  inp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter" && !go.disabled) go.click(); });
  go.onclick = async () => {
    if (inp.value !== "Confirm") return;
    go.disabled = true; inp.disabled = true; go.textContent = tr("Deleting…");
    try { await capi("POST", "me/delete", { confirm: "Confirm" }); }
    catch (e) { msg.hidden = false; msg.textContent = tr("Couldn't delete the account: {err}", { err: e.detail && e.detail.reason === "owner" ? tr("The site owner's account can't be deleted.") : e.message }); go.textContent = tr("Delete my account"); inp.disabled = false; go.disabled = inp.value !== "Confirm"; return; }
    try { localStorage.removeItem("obv-gate"); } catch {}
    S.acctSync = false; S.prefsAt = null; writeS();
    location.replace(location.pathname + "?login=deleted");
  };
  body.append(h("p", null, tr("This deletes, right away and for good:")), ul,
    h("p", "hint", tr("What stays: your osu! ID and when the account was deleted (so older logins stop working), and entries in the admins' activity log. Logging in again later starts a new, empty account.")),
    h("p", null, tr("Type Confirm below to delete your account.")), inp, go, msg);
  setTimeout(() => inp.focus(), 50);
  await modal({ title: tr("Delete your account?"), body, dismiss: false, buttons: [{ label: tr("Cancel"), value: false, cls: "main" }] });
}
