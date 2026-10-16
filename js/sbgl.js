"use strict";
// ============ the storyboard drawn by WebGL (Settings → Screen and performance → Storyboard drawing) ============
// A big storyboard is ten thousand sprites a frame; the canvas draws them one call each, WebGL in a handful of calls (instanced: one quad per
// sprite, its place, size, turn, colour and opacity in a buffer). What each sprite looks like comes from the same sbCalc as on the canvas (skins.js).
// The picture is made on its own WebGL canvas, the size of the 854 x 480 playfield box, and drawn into the page's canvas in one piece, in the
// place the storyboard has there. That picture is opaque: it starts as the page's own base colour, then the background (when the map's
// storyboard doesn't replace it), then the sprites. (A see-through picture would have to carry the glowing, "additive" sprites as light on
// nothing; whether a browser keeps that when it draws the canvas is up to it, and the iPhone's may not.) A map with a video, a browser without
// WebGL 2, a lost context or any error draws the old way instead: the page never shows a black frame.
const GLS = { cv: null, gl: null, prog: null, vbo: null, ibo: null, vao: null, u: null, tex: new Map(), lost: false, dead: false, W: 0, H: 0, inst: new Float32Array(12 * 2048), runs: [], calls: 0, count: 0, build: 0, used: false, max: 4096, scratch: null, sg: null };
const SBGL_OK = typeof WebGL2RenderingContext !== "undefined";
const SBGL_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aA;
layout(location=2) in vec4 aB;
layout(location=3) in vec4 aC;
uniform vec2 uSize;
uniform vec4 uBox;
out vec2 vUV;
out vec4 vCol;
void main() {
  vec2 p = (aCorner - aB.zw) * uSize * aA.zw;
  vec2 r = vec2(aB.x * p.x - aB.y * p.y, aB.y * p.x + aB.x * p.y);
  vec2 w = r + aA.xy;
  gl_Position = vec4(w.x * uBox.x + uBox.z, w.y * uBox.y + uBox.w, 0.0, 1.0);
  vUV = aCorner;
  vCol = aC;
}`;
const SBGL_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUV;
in vec4 vCol;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUV);
  o = vec4(t.rgb * vCol.rgb, t.a) * vCol.a;
}`;
function sbglInit() {
  if (GLS.gl && !GLS.lost) return GLS.gl;
  if (!SBGL_OK || GLS.dead || GLS.lost) return null;
  try {
    const cv = GLS.cv = GLS.cv || document.createElement("canvas");
    const gl = cv.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "default" });
    if (!gl) { GLS.dead = true; return null; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, SBGL_VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, SBGL_FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    GLS.prog = prog; GLS.u = { size: gl.getUniformLocation(prog, "uSize"), box: gl.getUniformLocation(prog, "uBox"), tex: gl.getUniformLocation(prog, "uTex") };
    GLS.vao = gl.createVertexArray(); gl.bindVertexArray(GLS.vao);
    GLS.ibo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, GLS.ibo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    GLS.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, GLS.vbo);
    for (let a = 1; a <= 3; a++) { gl.enableVertexAttribArray(a); gl.vertexAttribDivisor(a, 1); }
    GLS.max = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    GLS.gl = gl; GLS.tex.clear();
    if (!GLS.hooked) {
      GLS.hooked = true;
      cv.addEventListener("webglcontextlost", e => { e.preventDefault(); GLS.lost = true; GLS.gl = null; GLS.tex.clear(); dirty = true; }); // (iOS takes it when the page is in the background: drawn on the canvas meanwhile)
      cv.addEventListener("webglcontextrestored", () => { GLS.lost = false; GLS.W = GLS.H = 0; dirty = true; });
    }
    return gl;
  } catch (e) { GLS.dead = true; GLS.gl = null; try { console.warn("WebGL storyboard off:", e); } catch {} return null; }
}
// is this frame's storyboard to be drawn by WebGL? (the setting, a context, no video under it)
function sbglOn() { return S.sbGL === "on" && SBGL_OK && !GLS.dead && !GLS.lost && !!(GLS.gl || sbglInit()); }
// a texture of a picture, once: through a 2D canvas, so that it's premultiplied for sure (an ImageBitmap's isn't up to us) and no bigger than the card takes
function sbglTex(img) {
  let e = GLS.tex.get(img); if (e !== undefined) return e;
  const gl = GLS.gl; e = null;
  try {
    const w0 = img.width, h0 = img.height; if (!(w0 > 0 && h0 > 0)) throw 0;
    const k = Math.min(1, GLS.max / Math.max(w0, h0)), w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const sc = GLS.sg || (GLS.sg = document.createElement("canvas")); if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; } else GLS.sg.getContext("2d").clearRect(0, 0, w, h);
    sc.getContext("2d").drawImage(img, 0, 0, w, h);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sc);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    e = { tex, w: img.ow || img.width, h: img.oh || img.height };
  } catch { e = null; }
  GLS.tex.set(img, e); return e;
}
function sbglFree() { // pictures of a map that is gone (the next one's are made as it needs them)
  const gl = GLS.gl; if (gl && !GLS.lost) for (const e of GLS.tex.values()) if (e) gl.deleteTexture(e.tex);
  GLS.tex.clear();
}
function sbglRelease() { sbglFree(); if (GLS.cv) { GLS.cv.width = GLS.cv.height = 1; GLS.W = GLS.H = 0; } } // (the setting turned off: the memory goes back)
// the frame: bgq = the background as the canvas would draw it { img, x, y, k, fallback() } or null; returns false when the canvas must do it all
function sbglFrame(t, bgq, base) {
  const gl = sbglInit(); if (!gl) return false;
  try {
    if (bgq && !sbglTex(bgq.img)) return false; // (the background can't be made into a picture: the canvas does it all)
    sbFrameState();
    // (kk: the picture's pixels to the osu!pixel; the box it covers is a little over 854 x 480 so that it has whole pixels)
    const kk = Math.min((Math.hypot(SBM[0], SBM[1]) || 1) * SBL.eRes, GLS.max / 854, GLS.max / 480);
    const W = Math.max(1, Math.ceil(854 * kk)), H = Math.max(1, Math.ceil(480 * kk)), bw = W / kk, bh = H / kk;
    if (GLS.W !== W || GLS.H !== H) { GLS.cv.width = W; GLS.cv.height = H; GLS.W = W; GLS.H = H; }
    gl.viewport(0, 0, W, H); gl.clearColor(base[0], base[1], base[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const cs = sb.chunks; let total = 0; for (const c of cs) { sbActive(c, t); total += c.na; } SBL.active = total;
    // instances, in drawing order, in runs of one picture and one blend mode
    const tb = performance.now(), runs = GLS.runs; runs.length = 0; let n = 0, last = null, cur = null;
    const need = (total + 2) * 12; if (GLS.inst.length < need) GLS.inst = new Float32Array(Math.max(need, GLS.inst.length * 2));
    const I = GLS.inst, R = SBR;
    const put = (x, y, sx, sy, cs_, sn, ox, oy, r, g, b, a, add, img) => {
      if (img !== last) { last = img; cur = null; if (img) cur = sbglTex(img); }
      if (!cur) return;
      const rn = runs.length ? runs[runs.length - 1] : null;
      if (!rn || rn.e !== cur || rn.add !== add) runs.push({ e: cur, add, s: n, n: 0 });
      runs[runs.length - 1].n++;
      const o = n * 12; I[o] = x; I[o + 1] = y; I[o + 2] = sx; I[o + 3] = sy; I[o + 4] = cs_; I[o + 5] = sn; I[o + 6] = ox; I[o + 7] = oy; I[o + 8] = r; I[o + 9] = g; I[o + 10] = b; I[o + 11] = a; n++;
    };
    if (bgq) put(bgq.x, bgq.y, bgq.k, bgq.k, 1, 0, .5, .5, 1, 1, 1, 1, false, bgq.img);
    const one = (c, i) => { if (!sbCalc(c, i, t)) return; put(R.x, R.y, R.sx, R.sy, R.cs, R.sn, R.ox, R.oy, R.tint ? R.q0 / 255 : 1, R.tint ? R.q1 / 255 : 1, R.tint ? R.q2 / 255 : 1, R.o, R.add, R.img); };
    if (cs.length === 1) { const c = cs[0], act = c.act; for (let k = 0; k < c.na; k++) one(c, act[k]); }
    else if (cs.length === 2) {
      const a = cs[0], b = cs[1]; let ia = 0, ib = 0;
      for (let L = 0; L < 5; L++) { while (ia < a.na && a.layer[a.act[ia]] === L) one(a, a.act[ia++]); while (ib < b.na && b.layer[b.act[ib]] === L) one(b, b.act[ib++]); }
    }
    GLS.count = n; GLS.calls = runs.length; GLS.build = performance.now() - tb; // (build: the page's own time for it, in ms: the sprites worked out and put in the buffer)
    if (n) {
      gl.useProgram(GLS.prog); gl.bindVertexArray(GLS.vao); gl.bindBuffer(gl.ARRAY_BUFFER, GLS.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, n * 48, gl.DYNAMIC_DRAW); gl.bufferSubData(gl.ARRAY_BUFFER, 0, I, 0, n * 12); // (a new store each frame: the last frame's may still be being read)
      gl.uniform4f(GLS.u.box, 2 / bw, -2 / bh, -1 + 2 * 107 / bw, 1); gl.uniform1i(GLS.u.tex, 0); gl.activeTexture(gl.TEXTURE0);
      let add = null;
      for (const rn of runs) {
        if (rn.add !== add) { add = rn.add; if (add) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
        gl.bindTexture(gl.TEXTURE_2D, rn.e.tex); gl.uniform2f(GLS.u.size, rn.e.w, rn.e.h);
        const o = rn.s * 48;
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 48, o); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 48, o + 16); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 48, o + 32);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rn.n);
      }
    }
    if (gl.isContextLost()) { GLS.lost = true; throw new Error("lost"); }
    // into the page's canvas, the box in its place (1 : 1 pixels at full resolution)
    ctx.setTransform(SBM[0], SBM[1], SBM[2], SBM[3], SBM[4], SBM[5]);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(GLS.cv, -107, 0, bw, bh);
    GLS.used = true; return true;
  } catch (e) { if (!GLS.lost) GLS.dead = true; try { console.warn("WebGL storyboard: drawn on the canvas instead", e); } catch {} return false; }
}

// A storyboard with thousands of sprites showing at once, opened while it's drawn on the canvas, on a device where WebGL works: offer to switch,
// once per device whatever the answer (Settings → Graphics changes it later). Not during a replay, a live or collab session, or the site's tour.
const SBGL_HEAVY = 2500;
async function sbglSuggest() {
  if (S.sbGLAsked || S.sbGL === "on" || !S.sb || !sb.length || (sb.peak || 0) < SBGL_HEAVY || DEMO_TOUR) return;
  if (RP.on || (typeof LIVE !== "undefined" && LIVE.on) || (typeof COLLAB !== "undefined" && COLLAB.on)) return;
  if (!sbglInit()) return; // (no WebGL here after all: nothing to offer)
  S.sbGLAsked = true; save();
  const yes = await ask(tr("It has up to {n} sprites on screen at once. WebGL draws big storyboards on the graphics chip and is usually much smoother. Switch the storyboard to WebGL? You can change it any time in Settings → Graphics.", { n: sb.peak.toLocaleString() }),
    { title: tr("This storyboard is heavy"), ok: tr("Use WebGL"), cancel: tr("Keep Canvas") });
  if (yes) S.sbGL = "on"; else sbglRelease();
  save(); dirty = true;
}
