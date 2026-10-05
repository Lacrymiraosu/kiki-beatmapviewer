// Service worker: lets the site be installed as an app and open without a connection.
// - Pages: from the network first; offline, the last copy of the site's page (maps downloaded earlier live in the
//   browser's own storage and still open).
// - The site's own scripts, styles, translations, skins and icons: from this cache. Links with the site's version (?v=)
//   never change (a new version is a new link; older copies of the same file are dropped); files without it (skins,
//   icon, manifest) are served from the cache and refreshed from the network in the background.
// - Nothing else: the API, other sites (mirrors, osu!, Google), audio ranges and uploads always go to the network.
const CACHE = "obv-v1";
const STATIC = /^\/(js|assets|i18n|skins)\/|^\/(icon\.svg|manifest\.webmanifest)$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add(new Request("/", { cache: "reload" }))).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || req.headers.has("range") || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && url.pathname === "/") { const copy = res.clone(); caches.open(CACHE).then(c => c.put("/", copy)); }
      return res;
    }).catch(async () => (await caches.match("/")) || Response.error()));
    return;
  }
  if (!STATIC.test(url.pathname)) return;
  const versioned = url.searchParams.has("v");
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(async res => {
      if (res.ok && res.type === "basic") {
        await c.put(req, res.clone());
        if (versioned) for (const k of await c.keys()) { const u = new URL(k.url); if (u.pathname === url.pathname && u.search !== url.search) c.delete(k); } // (older versions)
      }
      return res;
    });
    if (hit) { if (!versioned) e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});
