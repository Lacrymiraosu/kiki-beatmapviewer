// The "Downloaded" marks read the kept maps (js/app.js oszIndexLoad). Reading them once at the start was lost in an edit and no mark showed after a reload: this keeps that call in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
test("the kept-maps index is read at the start (marks after a reload)", () => {
  assert.match(src, /^setTimeout\(\(\) => oszIndexLoad\(\)\.catch\(\(\) => \{\}\), 0\);/m);
});
test("the index is read again after the store changes (idbTx hook) and a failed read is tried again", () => {
  assert.match(readFileSync(new URL("../js/skins.js", import.meta.url), "utf8"), /store === "osz" && mode === "readwrite" && typeof oszIndexSoon === "function"/);
  assert.match(src, /async function oszIndexLoad\(tries = 5\)/);
});
