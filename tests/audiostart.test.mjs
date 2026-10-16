// A song started while the audio output isn't running (Safari starts it only inside a tap; a Watch or a lead-in starts the song later,
// outside one) must not stand still "playing" with nothing to tap (js/audio.js A.play): after a moment it stops and asks for a tap
// ("tap again to play", onPlayBlocked), and a tap that finds the output still asleep makes a new one (js/player.js resumeFromTap).
// A is cut out of js/audio.js and run in a vm with stubs for the page's globals and a fake Web Audio output.
import { test } from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import vm from "node:vm";
const src = readFileSync(new URL("../js/audio.js", import.meta.url), "utf8"), pl = readFileSync(new URL("../js/player.js", import.meta.url), "utf8");
const a = src.indexOf("const A = {"), b = src.indexOf("\n};\n", a) + 4;
assert.ok(a > 0 && b > a, "audio.js: the A block moved");
const r0 = pl.indexOf("function resumeFromTap()"), r1 = pl.indexOf("function pausePlayback()");
assert.ok(r0 > 0 && r1 > r0, "player.js: resumeFromTap moved");
function make(state = "running", resumeTo = "running") {
  const timers = [], blocked = [], log = [];
  const mkCtx = st => { const c = { state: st, currentTime: 5, destination: {}, resumes: 0,
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() { return this; } }; },
    createBufferSource() { return { buffer: null, playbackRate: { value: 1 }, connect() { return this; }, start() {}, stop() {} }; },
    resume() { c.resumes++; return new Promise(res => { if (resumeTo === "running") { c.state = "running"; res(); } /* else: never settles */ }); } }; return c; };
  const cx = { console, performance, Promise, document: { hidden: false }, outLat: () => 0, musGain: () => 1, resetSched() {}, stopPending() {}, kpWaiting: () => false, kpReady: () => null,
    audio: { paused: true }, onSongEnd() {}, keepAwake() {}, audioStuck: () => false, audioRestart() { log.push("restart"); cx.actx = mkCtx("running"); cx.A.gain = null; },
    ensureAudioCtx() { if (cx.actx.state === "suspended") cx.actx.resume(); },
    setTimeout: (f, ms) => timers.push({ f, ms }), onPlayBlocked: e => blocked.push(e), actx: mkCtx(state), $: () => ({}), UI: { tapStart: { hidden: false } }, needTapResume: false,
    toast() {}, tr: x => x, showUI() {}, A: null };
  vm.createContext(cx);
  vm.runInContext(src.slice(a, b) + "\nthis.A = A;", cx);
  cx.A.mode = "buf"; cx.A.buf = { duration: 300 }; cx.A.dur = () => 300000;
  return { cx, timers, blocked, log };
}
test("the output runs: the song plays, no check is left waiting", () => {
  const { cx, timers, blocked } = make("running"); cx.A.play();
  assert.equal(cx.A.on, true); assert.equal(timers.length, 0); assert.equal(blocked.length, 0);
});
test("the output never wakes: after the wait the song stops and a tap is asked for (not left playing on a frozen clock)", () => {
  const { cx, timers, blocked } = make("suspended", "never"); cx.A.play();
  assert.equal(cx.A.on, true); assert.equal(timers.length, 1);
  timers[0].f(); assert.equal(cx.A.on, false, "stopped, so the next tap plays again"); assert.equal(blocked.length, 1);
});
test("the output wakes in time (a slow resume inside a tap): nothing is stopped", () => {
  const { cx, timers, blocked } = make("suspended", "never"); cx.A.play();
  cx.actx.state = "running"; timers[0].f();
  assert.equal(cx.A.on, true); assert.equal(blocked.length, 0);
});
test("a song stopped or replaced meanwhile is left alone by the late check", () => {
  const { cx, timers, blocked } = make("suspended", "never"); cx.A.play(); cx.A.pause(); timers[0].f();
  assert.equal(blocked.length, 0); assert.equal(cx.A.on, false);
  const t = make("suspended", "never"); t.cx.A.play(); t.cx.actx = { state: "suspended" }; t.timers[0].f(); assert.equal(t.blocked.length, 0, "a new output: not this check's business");
});
test("the tap after a blocked start: an output still asleep is replaced by a new one made inside the tap", () => {
  const { cx, log } = make("suspended", "never");
  vm.runInContext(pl.slice(r0, r1) + "\nthis.resumeFromTap = resumeFromTap;", cx);
  cx.A.play = () => Promise.resolve(); cx.needTapResume = true; cx.resumeFromTap();
  assert.deepEqual(log, ["restart"]);
  const t = make("running"); vm.runInContext(pl.slice(r0, r1) + "\nthis.resumeFromTap = resumeFromTap;", t.cx); t.cx.A.play = () => Promise.resolve(); t.cx.resumeFromTap(); assert.deepEqual(t.log, [], "a running output is kept");
});
