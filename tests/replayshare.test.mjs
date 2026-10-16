// Sharing a replay by link (js/replay.js): the id and key checks, the link, and reading it back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScripts } from "./lib/browser.mjs";

const P = loadScripts(["js/replay.js"], "", { URLSearchParams }); // (a browser has it)
const ID = "3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f", KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"; // (32 base64url characters)

test("rpShareOk: a uuid and exactly 32 base64url characters", () => {
  assert.equal(KEY.length, 32);
  assert.equal(P.rpShareOk(ID, KEY), true);
  assert.equal(P.rpShareOk(ID, "A-_" + KEY.slice(3)), true);
  for (const bad of [KEY.slice(1), KEY + "A", KEY.slice(0, 31) + "+", KEY.slice(0, 31) + "=", KEY.slice(0, 31) + " ", "", null, undefined]) assert.equal(P.rpShareOk(ID, bad), false, String(bad));
  for (const bad of ["", "12345", ID.toUpperCase(), ID.slice(1), ID + "0", "../" + ID.slice(3), null, undefined]) assert.equal(P.rpShareOk(bad, KEY), false, String(bad));
});
test("rpShareURL: ?replay=<id>&key=<key> on the page's own address, nothing else kept", () => {
  assert.equal(P.rpShareURL("https://x.test/app/", ID, KEY), `https://x.test/app/?replay=${ID}&key=${KEY}`);
  assert.equal(P.rpShareURL("https://x.test/app/?s=1&key=old#top", ID, KEY), `https://x.test/app/?replay=${ID}&key=${KEY}`);
  assert.equal(P.rpShareURL("https://x.test/", ID, "short"), "");
  assert.equal(P.rpShareURL("https://x.test/", "nope", KEY), "");
});
test("rpShareParse: reads a link back, a broken one is null", () => {
  assert.deepEqual({ ...P.rpShareParse(`?replay=${ID}&key=${KEY}`) }, { id: ID, key: KEY });
  assert.deepEqual({ ...P.rpShareParse(`?key=${KEY}&replay=${ID.toUpperCase()}&x=1`) }, { id: ID, key: KEY }); // (the id is lower-cased, as the server does)
  assert.equal(P.rpShareParse(`?replay=${ID}`), null);
  assert.equal(P.rpShareParse(`?replay=${ID}&key=${KEY}x`), null);
  assert.equal(P.rpShareParse(`?replay=%3Cscript%3E&key=${KEY}`), null);
  assert.equal(P.rpShareParse(""), null);
  assert.equal(P.rpShareParse(null), null);
});
test("the link built is the link parsed", () => {
  const u = new URL(P.rpShareURL("https://x.test/p", ID, KEY));
  assert.deepEqual({ ...P.rpShareParse(u.search) }, { id: ID, key: KEY });
});
