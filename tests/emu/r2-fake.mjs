// A stand-in for a Cloudflare R2 bucket binding (put / get / head / delete / list), in memory, for local tests only.
export function fakeR2() {
  const m = new Map(), fail = { remove: 0 }; // fail.remove = n: the next n deletes throw (like a storage outage)
  return {
    m, fail,
    // like R2: onlyIf { etagDoesNotMatch: "*" } -> null when the object exists; sha256 (hex) -> throws when the bytes differ
    async put(key, body, opts = {}) {
      const b = new Uint8Array(await new Response(body).arrayBuffer());
      if (opts.onlyIf && opts.onlyIf.etagDoesNotMatch === "*" && m.has(key)) return null;
      if (opts.sha256 && Buffer.from(await crypto.subtle.digest("SHA-256", b)).toString("hex") !== String(opts.sha256).toLowerCase())
        throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      m.set(key, b); return { key, size: b.length };
    },
    async get(key) { const b = m.get(key); return b ? { key, size: b.length, httpEtag: '"' + b.length + '"', body: new Blob([b]).stream() } : null; },
    async head(key) { const b = m.get(key); return b ? { key, size: b.length } : null; },
    async delete(keys) { if (fail.remove > 0) { fail.remove--; throw new Error("R2 unavailable"); } for (const k of [].concat(keys)) m.delete(k); },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort(), s = +(cursor || 0);
      return { objects: all.slice(s, s + limit).map(key => ({ key, size: m.get(key).length })), truncated: s + limit < all.length, cursor: String(s + limit) };
    },
  };
}
