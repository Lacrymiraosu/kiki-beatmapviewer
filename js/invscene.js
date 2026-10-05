"use strict";
// ============ the invitation: what an invite link opens first (?invite=CODE) ============
// A dark purple scene: approach circles closing in on the inviter's avatar, rising embers, a slow rune ring, and only
// who invited you plus one Accept button. Accepting plays a short ominous welcome, then the normal home page opens.
// "What is this place?" (or a link that no longer works) shows the regular invite page instead (gate.js).
const GIS = { raf: 0, speed: 1, t: 0, last: 0, cv: null, welcome: false, mad: 0, shake: 0, mx: 0, my: 0 };
function gisShow() {
  let s = $("gis");
  if (!s) {
    s = h("div", "gis"); s.id = "gis"; s.setAttribute("role", "dialog"); s.setAttribute("aria-modal", "true");
    const cv = h("canvas", "gisfx"); cv.setAttribute("aria-hidden", "true");
    s.append(cv, h("div", "gisin")); document.body.append(s); document.body.classList.add("gising");
    gisFx(cv);
  }
  gisRender();
}
function gisRender() {
  const s = $("gis"); if (!s || GIS.welcome) return;
  const inner = s.querySelector(".gisin"), I = GATE.invite || {}, me = GATE.me || {};
  inner.innerHTML = "";
  const look = h("button", "gislook", tr("What is this place?")); look.onclick = gisLeave;
  if (!I.info) {
    inner.append(h("p", "gisfrom", tr("An invitation")), h("h1", "gisname", tr("This invitation has faded.")), h("p", "gisline", tr("It was used up, turned off or replaced by a new one.")));
    const b = h("button", "btn gisbtn", tr("See the site")); b.onclick = gisLeave; inner.append(b);
    return;
  }
  const inv = I.info.inviter, av = h("div", "gisav"); av.append(avatarEl(inv.id, inv.username, "mav"));
  const name = h("h1", "gisname", inv.username); name.dataset.text = inv.username;
  inner.append(av, h("p", "gisfrom", tr("An invitation from")), name);
  if (!I.info.ok) {
    inner.append(h("p", "gisline", tr("This invitation has faded.")), h("p", "gissub", I.info.reason === "full" ? tr("Everyone it could let in has already answered.") : tr("It was used up, turned off or replaced by a new one.")));
    const b = h("button", "btn gisbtn", tr("See the site")); b.onclick = gisLeave; inner.append(b);
    return;
  }
  inner.append(h("p", "gisline", tr("The circles are waiting. Will you answer?")));
  if (!me.user) {
    inner.append(...gateInviteActs("btn gisbtn"));
  } else {
    const b = h("button", "btn gisbtn", GATE.sending ? tr("Sending…") : tr("Accept the invite")); b.disabled = GATE.sending; b.onclick = gateAccept;
    inner.append(b, h("p", "gissub", tr("as {n}", { n: me.user.username })));
  }
  inner.append(look);
}
// "What is this place?": the regular invite page (preview, tour, request access)
function gisLeave() {
  gisClose();
  gateRender(); demoStart();
}
function gisClose() {
  const s = $("gis"); cancelAnimationFrame(GIS.raf); GIS.raf = 0; GIS.cv = null; GIS.welcome = false; GIS.speed = 1;
  if (s) s.remove(); document.body.classList.remove("gising");
}
// accepted: a short ominous welcome, then the normal home page
function gisWelcome(inviter) {
  const s = $("gis"); if (!s) return false;
  GIS.welcome = true; GIS.speed = 3.2; GIS.mad = 1; GIS.shake = 1; s.classList.add("welcome");
  const inner = s.querySelector(".gisin"), you = (GATE.me.user || {}).username || "";
  inner.innerHTML = "";
  const lines = [tr("Welcome, {n}.", { n: you }), tr("The circles have chosen you."), tr("Every beat you place will echo in the timeline, long after the song has ended."), inviter ? tr("{n} will be watching.", { n: inviter }) : ""].filter(Boolean);
  const box = h("div", "gisprop"); inner.append(box);
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    s.classList.add("flash", "out");
    setTimeout(() => { gisClose(); history.replaceState(null, "", location.pathname); gateUnlock(false); scrollTo(0, 0); }, 900);
  };
  lines.forEach((t, i) => setTimeout(() => { if (!done) box.append(h("p", i === 0 ? "gisw first" : "gisw", t)); }, 700 + i * 1500));
  setTimeout(finish, 700 + lines.length * 1500 + 1800);
  s.addEventListener("click", finish); addEventListener("keydown", function k(e) { if (e.key === "Escape" || e.key === "Enter") { removeEventListener("keydown", k); finish(); } });
  return true;
}
// the motion, in pale lavender and ink: a bright hazy centre with dark edges, rose windows turning in the haze, slanted
// glitch beams in magenta with red / cyan fringes, lightning that shakes the screen, torn horizontal bars and whole-screen
// tears; approach circles closing in on the avatar with a shockwave each time one lands, a thorned ring of beat ticks,
// white shards and ash drifting up; everything leans a little towards the pointer. Welcome = all of it, faster.
function gisFx(cv) {
  GIS.cv = cv; const g = cv.getContext("2d"), still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rnd = (a, b) => a + Math.random() * (b - a), TAU = Math.PI * 2;
  const BITS = Array.from({ length: 110 }, () => ({ x: Math.random(), y: Math.random(), s: rnd(1, 5), v: rnd(.01, .05), a: rnd(0, 6.3), w: rnd(-2, 2), ink: Math.random() < .55, z: rnd(.3, 1.4) }));
  const BEAMS = Array.from({ length: 8 }, () => ({ x: rnd(-.1, 1.1), ang: rnd(-1.25, -1.0), len: rnd(.6, 1.3), off: rnd(0, 6.3), sp: rnd(.4, 1.3), w: rnd(1.5, 4), drift: rnd(-.03, .03), kinks: Array.from({ length: 6 }, () => rnd(-.02, .02)) }));
  const ROSES = [[.12, .2, .2, .05], [.9, .16, .16, -.07], [.08, .86, .15, .04], [.92, .82, .22, -.035]].map(([x, y, r, sp]) => ({ x, y, r, sp, petals: 6 + (Math.random() * 4 | 0) }));
  let W = 0, H = 0, dpr = 1, bolt = null, nextBolt = 2.2, bars = [], nextBars = 1, nextTear = 2.5, nextCorrupt = 3, waves = [], lastPh = [0, 0, 0];
  const size = () => { dpr = Math.min(2, devicePixelRatio || 1); W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr; };
  size(); addEventListener("resize", size);
  addEventListener("pointermove", e => { GIS.mx = e.clientX / innerWidth * 2 - 1; GIS.my = e.clientY / innerHeight * 2 - 1; });
  GIS.last = performance.now();
  const beam = (b, t) => { // a slanted glitch line: magenta core, red and cyan split, a few kinks
    const flick = Math.sin(t * b.sp * (3 + GIS.mad * 1.5) + b.off), vis = flick > .35 ? 1 : flick > .1 ? .35 : 0; if (!vis) return;
    const x0 = ((b.x + b.drift * t) % 1.2 + 1.2) % 1.2 * W - W * .1 + GIS.mx * 30 * dpr, y0 = -H * .05, dx = -Math.cos(b.ang), dy = -Math.sin(b.ang), L = b.len * H * 1.2;
    const pts = b.kinks.map((k, i) => [x0 + dx * L * (i / (b.kinks.length - 1)) + k * W * (1 + GIS.mad * 2 * Math.random()), y0 + dy * L * (i / (b.kinks.length - 1))]);
    const line = (col, ox, lw, al) => { g.globalAlpha = al * vis; g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x + ox, y) : g.moveTo(x + ox, y)); g.stroke(); };
    line("#ff3b5c", -3 * dpr, b.w * dpr, .55); line("#3fd6ff", 3 * dpr, b.w * dpr, .55);
    g.shadowColor = "#ff5bd6"; g.shadowBlur = 16 * dpr; line("#ff6ad8", 0, b.w * dpr, .9); line("#fff", 0, Math.max(1, b.w * .35) * dpr, .9); g.shadowBlur = 0;
  };
  const rose = (o, t) => { // a gothic rose window, turning, now and then split into magenta / cyan
    const R = o.r * Math.min(W, H), x = o.x * W - GIS.mx * 18 * dpr, y = o.y * H - GIS.my * 18 * dpr;
    const draw = (ox, col, al) => {
      g.save(); g.translate(x + ox, y); g.rotate(t * o.sp); g.globalAlpha = al; g.strokeStyle = col; g.lineWidth = 2 * dpr;
      g.beginPath(); g.arc(0, 0, R, 0, TAU); g.stroke(); g.beginPath(); g.arc(0, 0, R * .82, 0, TAU); g.stroke(); g.beginPath(); g.arc(0, 0, R * .2, 0, TAU); g.stroke();
      for (let i = 0; i < o.petals; i++) { const a = i / o.petals * TAU; g.beginPath(); g.arc(Math.cos(a) * R * .5, Math.sin(a) * R * .5, R * .28, 0, TAU); g.stroke();
        g.beginPath(); g.moveTo(Math.cos(a) * R * .2, Math.sin(a) * R * .2); g.lineTo(Math.cos(a) * R * .82, Math.sin(a) * R * .82); g.stroke(); }
      g.restore();
    };
    draw(0, "#2a2542", .28);
    if (Math.sin(t * 1.7 + o.sp * 40) > .93 || GIS.mad && Math.random() < .05) { draw(-6 * dpr, "#ff3bbf", .35); draw(6 * dpr, "#1fb8ff", .35); }
  };
  const frame = now => {
    if (GIS.cv !== cv) return;
    const dt = Math.min(.05, (now - GIS.last) / 1000); GIS.last = now; GIS.t += dt * GIS.speed; const t = GIS.t;
    GIS.shake = Math.max(0, GIS.shake - dt * 2.2);
    const sh = GIS.shake * 9 * dpr, sx = rnd(-sh, sh), sy = rnd(-sh, sh);
    const inner = document.querySelector("#gis .gisin"); if (inner) inner.style.transform = GIS.shake > .02 ? `translate(${sx / dpr * .6}px,${sy / dpr * .6}px)` : "";
    g.setTransform(1, 0, 0, 1, sx, sy); g.clearRect(-sh - 2, -sh - 2, W + sh * 2 + 4, H + sh * 2 + 4);
    const av = document.querySelector("#gis .gisav"), r = av ? av.getBoundingClientRect() : null;
    const cx = r ? (r.left + r.width / 2) * dpr : W / 2, cy = r ? (r.top + r.height / 2) * dpr : H * .42, R = (r ? r.width / 2 : 48) * dpr;
    // light haze drifting over the pale centre
    for (let i = 0; i < 3; i++) {
      const fx = W * (.5 + .3 * Math.sin(t * .06 + i * 2.1)), fy = H * (.42 + .25 * Math.cos(t * .05 + i * 1.7)), fr = Math.max(W, H) * (.35 + .08 * i);
      const fg = g.createRadialGradient(fx, fy, 0, fx, fy, fr); fg.addColorStop(0, i === 1 ? "rgba(255,190,245,.16)" : "rgba(245,243,255,.22)"); fg.addColorStop(1, "rgba(245,243,255,0)");
      g.fillStyle = fg; g.fillRect(0, 0, W, H);
    }
    for (const o of ROSES) rose(o, t);
    for (const b of BEAMS) beam(b, t);
    g.globalAlpha = 1;
    // lightning: a white-violet bolt, a flash, the screen shakes
    if (t > nextBolt && !still) {
      const x = rnd(.1, .9) * W, pts = [[x, -10]]; let y = 0, xx = x; while (y < H * rnd(.45, .85)) { y += rnd(20, 60) * dpr; xx += rnd(-45, 45) * dpr; pts.push([xx, y]); }
      const fork = pts.slice(0, 1 + (Math.random() * pts.length | 0)).concat([[xx + rnd(-120, 120) * dpr, y + rnd(40, 120) * dpr]]);
      bolt = { pts, fork, at: t }; GIS.shake = Math.min(1, GIS.shake + .45); nextBolt = t + (GIS.mad ? rnd(1.6, 2.8) : rnd(5, 9));
    }
    if (bolt && t - bolt.at < .35) {
      const k = 1 - (t - bolt.at) / .35;
      g.fillStyle = `rgba(250,248,255,${.08 * k})`; g.fillRect(0, 0, W, H); // a soft flash (kept low on purpose)
      g.globalAlpha = k; g.strokeStyle = "#f6f0ff"; g.shadowColor = "#c9a6ff"; g.shadowBlur = 22 * dpr;
      for (const [line, lw] of [[bolt.pts, 2.4], [bolt.fork, 1.2]]) { g.lineWidth = lw * dpr; g.beginPath(); line.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); }
      g.shadowBlur = 0; g.globalAlpha = 1;
    }
    g.save(); g.translate(cx, cy);
    // approach circles closing in; each one that lands sends a shockwave out
    for (let k = 0; k < 3; k++) {
      const ph = (t * (.42 + GIS.mad * .3) + k / 3) % 1, rad = R * (1.05 + 2.8 * (1 - ph)), a = ph < .85 ? ph * .7 : (1 - ph) / .15 * .6;
      if (ph < lastPh[k]) { waves.push({ at: t }); if (GIS.mad) GIS.shake = Math.min(1, GIS.shake + .12); } lastPh[k] = ph;
      g.globalAlpha = a; g.strokeStyle = "#241f3d"; g.lineWidth = 3 * dpr; g.shadowColor = "#b58cff"; g.shadowBlur = 12 * dpr;
      g.beginPath(); g.arc(0, 0, rad, 0, TAU); g.stroke();
    }
    waves = waves.filter(w => t - w.at < .7);
    for (const w of waves) { const k = (t - w.at) / .7; g.globalAlpha = (1 - k) * .5; g.strokeStyle = "#ffffff"; g.lineWidth = (6 - 5 * k) * dpr; g.shadowColor = "#ff6ad8"; g.shadowBlur = 20 * dpr; g.beginPath(); g.arc(0, 0, R * (1.05 + 3.2 * k), 0, TAU); g.stroke(); }
    g.shadowBlur = 0;
    // a thorned halo: beat ticks (long every 4th, like thorns), turning the wrong way; broken rings outside it
    g.rotate(-t * (.12 + GIS.mad * .5));
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * TAU, thorn = i % 4 === 0, rr = R * 1.6, l = (thorn ? 16 + Math.sin(t * 6 + i) * 4 * (1 + GIS.mad * 2) : 5) * dpr;
      g.globalAlpha = thorn ? .85 : .5; g.strokeStyle = thorn ? "#6f5b3a" : "#2a2542"; g.lineWidth = (thorn ? 2.2 : 1) * dpr;
      g.beginPath(); g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); g.lineTo(Math.cos(a) * (rr + l), Math.sin(a) * (rr + l)); g.stroke();
    }
    g.rotate(t * .3); g.globalAlpha = .55; g.strokeStyle = "#2a2542"; g.lineWidth = 1.6 * dpr;
    for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(0, 0, R * 2.05, i * 1.26, i * 1.26 + .9); g.stroke(); }
    g.globalAlpha = .35; for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(0, 0, R * 2.3, i * 2.1 + .4, i * 2.1 + 1.3); g.stroke(); }
    g.restore(); g.globalAlpha = 1;
    // white shards and ash, drifting up and turning (nearer ones lean more towards the pointer)
    for (const e of BITS) {
      e.y -= e.v * dt * GIS.speed; e.a += e.w * dt * GIS.speed; if (e.y < -.05) { e.y = 1.05; e.x = Math.random(); }
      const x = (e.x + Math.sin(t * .5 + e.a) * .01) * W - GIS.mx * 40 * e.z * dpr, y = e.y * H - GIS.my * 30 * e.z * dpr, s = e.s * e.z * dpr;
      g.save(); g.translate(x, y); g.rotate(e.a); g.globalAlpha = e.ink ? .55 : .8; g.fillStyle = e.ink ? "#1d1a2c" : "#f7f5ff";
      g.beginPath(); g.moveTo(-s, 0); g.lineTo(0, -s * .6); g.lineTo(s * 1.3, s * .2); g.lineTo(0, s * .7); g.closePath(); g.fill(); g.restore();
    }
    // torn horizontal glitch bars
    if (t > nextBars && !still) { bars = Array.from({ length: 2 + (Math.random() * (4 + GIS.mad * 6) | 0) }, () => ({ x: rnd(0, 1) * W, y: rnd(0, 1) * H, w: rnd(.05, .35) * W, h: rnd(2, 12) * dpr, c: ["#ff6ad8", "#3fd6ff", "#e8e4ff", "#231f36"][Math.random() * 4 | 0], at: t })); nextBars = t + (GIS.mad ? rnd(.5, 1.1) : rnd(.9, 2.4)); }
    for (const b of bars) if (t - b.at < .12) { g.globalAlpha = .7; g.fillStyle = b.c; g.fillRect(b.x, b.y, b.w, b.h); }
    g.globalAlpha = 1; g.setTransform(1, 0, 0, 1, 0, 0);
    const scene = $("gis");
    // the whole screen tears for a moment
    if (t > nextTear && !still && scene) { scene.classList.add("tear"); setTimeout(() => scene.classList.remove("tear"), 180); nextTear = t + (GIS.mad ? rnd(1.4, 2.6) : rnd(3.5, 7)); }
    // the name corrupts into noise for a blink
    if (t > nextCorrupt && !still) {
      const nm = document.querySelector("#gis .gisname"); nextCorrupt = t + (GIS.mad ? rnd(.6, 1.5) : rnd(2.5, 5));
      if (nm && nm.dataset.text) { const src = nm.dataset.text, noise = "▓▒░█▚▞◆◇※†‡¤§∆ΩΞΨ#@%&"; nm.textContent = [...src].map(c => Math.random() < .5 ? noise[Math.random() * noise.length | 0] : c).join(""); setTimeout(() => { if (nm.isConnected) nm.textContent = src; }, 140); }
    }
    if (!still) GIS.raf = requestAnimationFrame(frame);
  };
  GIS.raf = requestAnimationFrame(frame);
}
