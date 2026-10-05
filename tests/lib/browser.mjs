// Run the site's classic browser scripts (js/*.js share one global scope) inside a Node vm, with small stubs for the
// few browser helpers they touch. Returns a proxy: P.name evaluates `name` in that scope (works for const/let too).
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUBS = `
const clamp01 = v => Math.max(0, Math.min(1, v));
const norm = p => String(p).replace(/\\\\/g, "/").replace(/^\\.\\//, "").toLowerCase();
let map = null;
class Path2D { moveTo() {} lineTo() {} }
`;

export function loadScripts(files, extra = "") {
  const ctx = vm.createContext({ console, Math, JSON, Date, Map, Set, Array, Object, Number, String, Promise, TextEncoder, TextDecoder, crypto: globalThis.crypto, structuredClone });
  vm.runInContext(STUBS + extra, ctx, { filename: "stubs.js" });
  for (const f of files) vm.runInContext(readFileSync(join(root, f), "utf8"), ctx, { filename: f });
  return new Proxy({}, { get: (_, k) => typeof k === "string" ? vm.runInContext(k, ctx) : undefined });
}
// values from the vm have other Array/Object prototypes: compare them as plain JSON
export const J = x => JSON.parse(JSON.stringify(x));
