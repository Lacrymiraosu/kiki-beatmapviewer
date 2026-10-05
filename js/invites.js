"use strict";
// ============ Invite friends: your personal invite link (?view=invite) ============
// Everyone with access has one (made the first time this page opens). People who open it and log in with osu! get in
// straight away, up to the number the admins set, and show up here. People who came in with an invite can invite
// others once an admin allows it. The server checks all of it (api/v1.js, obv_invite_* in the database); the page
// that opens the link is gate.js.
const siteInviteURL = code => location.origin + location.pathname + "?invite=" + code;
async function renderInvite() {
  const box = $("invite"); box.innerHTML = "";
  const head = h("div", "vhead"); head.append(h("h2", null, tr("Invite friends")), h("p", null, tr("Your invite link lets people in straight away, without waiting for an admin. Share it with people you trust.")));
  const wrap = h("div", "invwrap"); wrap.append(h("div", "card sk"));
  box.append(head, wrap);
  let r;
  try { r = await capi("GET", "invites"); }
  catch (e) {
    wrap.innerHTML = "";
    if (e.code === "login_required") { const d = h("div", "empty", tr("Log in with osu! to see your invite link.") + " "), b = h("button", "btn main sm", tr("Log in with osu!")); b.onclick = authLogin; d.append(b); wrap.append(d); }
    else wrap.append(h("div", "empty", e.code === "server_error" || e.code === "not_configured" ? tr("Invites aren't set up on this site yet.") : tr("Couldn't load your invite link: {err}", { err: e.message })));
    return;
  }
  wrap.innerHTML = "";
  const me = CLOUD.me || {}, off = !r.unlimited && r.limit === 0;
  if (me.gate === false) wrap.append(h("p", "aalert", tr("Right now anyone can use the site, so nobody needs an invite. Your link works again whenever access is required.")));
  if (!r.can_invite) wrap.append(h("p", "aalert warn", tr("Your invite link isn't active yet. People who joined with an invite can invite others once an admin allows it.")));
  else if (off) wrap.append(h("p", "aalert warn", tr("Invites are turned off for your account right now.")));
  const card = h("section", "invcard" + (!r.can_invite || off ? " off" : "")), url = siteInviteURL(r.code);
  const inp = h("input", "invurl"); inp.readOnly = true; inp.value = url; inp.onclick = () => inp.select(); inp.setAttribute("aria-label", tr("Your invite link"));
  const row = h("div", "invrow"), copy = h("button", "btn main", tr("Copy link"));
  copy.onclick = async () => toast(await copyText(url) ? tr("Invite link copied") : url, 2000);
  row.append(inp, copy);
  if (navigator.share) { const sh = h("button", "btn ghost", tr("Share")); sh.onclick = () => navigator.share({ title: "KIKI BEATMAP VIEWER", text: tr("Join me on KIKI BEATMAP VIEWER"), url }).catch(() => {}); row.append(sh); }
  const use = h("div", "invuse");
  if (r.unlimited) use.append(h("b", null, tr("No limit")), h("small", null, tr("{n} joined with your link", { n: r.used })));
  else {
    const left = Math.max(0, r.limit - r.used), bar = h("div", "invbar"), fill = h("i");
    fill.style.width = (r.limit ? Math.min(100, r.used / r.limit * 100) : 100) + "%"; bar.append(fill);
    use.append(h("b", null, tr("{a} of {b} used", { a: r.used, b: r.limit })), bar,
      h("small", null, off ? "" : left ? tr("{n} more can join with it", { n: left }) : tr("Your link is full. An admin can give you more invites.")));
  }
  const reset = h("button", "mlink", tr("Make a new link"));
  reset.onclick = async () => {
    if (!(await ask(tr("Make a new invite link? The old one stops working; people who already joined keep their access."), { ok: tr("Make a new link") }))) return;
    try { await capi("POST", "invites/reset", {}); toast(tr("New invite link made"), 1800); renderInvite(); } catch (e) { toast(e.message, 3000); }
  };
  card.append(h("h3", null, tr("Your invite link")), row, use, reset);
  if (typeof r.fx === "boolean" && r.fx_allowed !== false) { // only people an admin allowed (and admins) get this switch
    const sw = h("label", "aswitch invfx"), cb = h("input"); cb.type = "checkbox"; cb.className = "switch"; cb.checked = r.fx;
    const swt = h("span", "swt"); swt.append(h("b", null, tr("Invitation effect")), h("small", null, tr("On: your link opens with the animated invitation (glitches, lightning and a few flashes). Off: it opens the normal invite page.")));
    sw.append(swt, cb);
    cb.onchange = async () => { cb.disabled = true; try { await capi("POST", "invites/fx", { on: cb.checked }); toast(cb.checked ? tr("Invitation effect on") : tr("Invitation effect off"), 1500); } catch (e) { cb.checked = !cb.checked; toast(e.message, 3000); } finally { cb.disabled = false; } };
    card.append(sw);
  }
  const list = h("section", "invlist"); list.append(h("h3", null, tr("People who joined with your link")));
  if (!r.invited.length) list.append(h("p", "hint", tr("Nobody yet.")));
  for (const x of r.invited) {
    const p = h("div", "invp"); p.append(avatarEl(x.id, x.username, "cav"), mapperLink(x.username), h("small", null, fmtDate(x.at, false)));
    if (!x.active) p.append(h("em", "abadge", tr("no access now")));
    list.append(p);
  }
  wrap.append(card);
  if (me.admin) wrap.append(invAdminLinks());
  wrap.append(list, h("p", "hint", tr("The invite page shows your osu! name and avatar to whoever opens your link. See Privacy.")));
}
// admins: extra links that each let in a set number of people (e.g. 10 for a Discord server)
function invAdminLinks() {
  const sec = h("section", "invcard invadm"), listBox = h("div", "invlinks");
  sec.append(h("h3", null, tr("Invite links with a limit")), h("p", "hint", tr("Admins: make a link that lets in exactly as many people as you choose, e.g. for a Discord server. You can give it more room or turn it off at any time.")));
  const form = h("form", "invform"), num = h("input", "invnum"), note = h("input", "invnote"), mk = h("button", "btn main", tr("Create link"));
  num.type = "number"; num.min = 1; num.max = 1000; num.step = 1; num.value = 5; num.setAttribute("aria-label", tr("How many people"));
  note.maxLength = 80; note.placeholder = tr("Label (optional), e.g. Discord server"); note.setAttribute("aria-label", tr("Label"));
  const nl = h("label", "invlab"); nl.append(h("span", null, tr("How many people")), num);
  form.append(nl, note, mk);
  form.onsubmit = async e => {
    e.preventDefault(); const n = Math.round(+num.value);
    if (!(n >= 1 && n <= 1000)) return toast(tr("Enter a number from 1 to 1000"), 2000);
    mk.disabled = true;
    try { const r = await capi("POST", "admin/invite-links", { max_uses: n, note: note.value.trim() }); note.value = ""; const url = siteInviteURL(r.link.code); toast(await copyText(url) ? tr("Link made and copied") : url, 2500); await invLoadLinks(listBox); }
    catch (err) { toast(err.message, 3000); } finally { mk.disabled = false; }
  };
  sec.append(form, listBox); invLoadLinks(listBox);
  return sec;
}
async function invLoadLinks(box) {
  box.innerHTML = ""; box.append(h("div", "card sk"));
  let links; try { links = (await capi("GET", "admin/invite-links")).links; } catch (e) { box.innerHTML = ""; box.append(h("p", "hint", tr("Couldn't load the links: {err}", { err: e.message }))); return; }
  box.innerHTML = "";
  if (!links.length) { box.append(h("p", "hint", tr("No links yet."))); return; }
  for (const l of links) {
    const row = h("div", "invl" + (l.state !== "ok" ? " off" : "")), top = h("div", "invltop"), url = siteInviteURL(l.code);
    const name = h("b", null, l.note || l.code), st = h("em", "abadge " + (l.state === "ok" ? "active" : l.state === "full" ? "expired" : "suspended"), tr(l.state === "ok" ? "Active" : l.state === "full" ? "Full" : "Off"));
    top.append(name, st, h("small", null, tr("{a} of {b} people", { a: l.uses, b: l.max_uses })));
    const bar = h("div", "invbar"), fill = h("i"); fill.style.width = Math.min(100, l.uses / l.max_uses * 100) + "%"; bar.append(fill);
    const acts = h("div", "btnrow");
    if (!l.revoked_at) {
      const cp = h("button", "btn ghost sm", tr("Copy link")); cp.onclick = async () => toast(await copyText(url) ? tr("Invite link copied") : url, 2000);
      const more = h("button", "btn ghost sm", tr("Change the number"));
      more.onclick = async () => {
        const v = (await askText(tr("How many people can this link let in? (at least {n})", { n: Math.max(1, l.uses) }), String(l.max_uses), { type: "number", min: Math.max(1, l.uses), max: 1000 })); if (v == null) return;
        try { await capi("POST", "admin/invite-links/update", { code: l.code, max_uses: Math.round(+v) }); invLoadLinks(box); } catch (e) { toast(e.code === "bad_request" ? tr("Enter a number from {a} to 1000", { a: Math.max(1, l.uses) }) : e.message, 3000); }
      };
      const off = h("button", "btn ghost sm danger", tr("Turn off"));
      off.onclick = async () => { if (!(await ask(tr("Turn this link off? Nobody else can join with it; people who already joined stay."), { ok: tr("Turn off"), danger: true }))) return; try { await capi("POST", "admin/invite-links/update", { code: l.code, revoke: true }); invLoadLinks(box); } catch (e) { toast(e.message, 3000); } };
      acts.append(cp, more, off);
    }
    const meta = h("small", "adim", tr("Made by {n} · {d}", { n: l.created_by ? l.created_by.username : "?", d: fmtDate(l.created_at, false) }) + (l.joined.length ? " · " + l.joined.map(x => x.username).join(", ") : ""));
    row.append(top, bar, meta, acts); box.append(row);
  }
}
