// Search engines: robots.txt, the sitemap, noindex on the API and on private pages, and each public page's own <head>
// (api/og.js fills it in for every "/" request, on Cloudflare and on Vercel alike).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = f => readFileSync(join(root, f), "utf8");
const vercel = JSON.parse(read("vercel.json"));
const SITE = "https://osu-beatmap-viewer.lacrymira.workers.dev";

test("the API is noindex on both hosts", async () => {
  const r = vercel.routes.find(x => x.src === "/api/(.*)" && x.headers);
  assert.equal(r && r.headers["X-Robots-Tag"], "noindex");
  assert.ok(vercel.routes.indexOf(r) < vercel.routes.findIndex(x => x.dest && x.dest.startsWith("/api/v1")), "before the API routes");
  const worker = (await import(join(root, "worker.js"))).default;
  const res = await worker.fetch(new Request("https://x.test/api/nothing"), { ASSETS: { fetch: () => new Response("") } }, { waitUntil() {} });
  assert.equal(res.status, 404); assert.equal(res.headers.get("x-robots-tag"), "noindex");
});

// api/og.js: every "/" request's <head>
import { createRequire } from "node:module";
const og = createRequire(import.meta.url)(join(root, "api/og.js"));
async function page(path) {
  og.useTemplate(read("index.html"));
  const out = { headers: {} }, res = { statusCode: 0, setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, end: b => { out.body = b; } };
  await og({ url: path, headers: { host: "preview.example" } }, res);
  const head = out.body.slice(0, out.body.indexOf("</head>")), all = re => [...head.matchAll(re)].map(m => m[1]);
  return { ...out, head, title: all(/<title>([^<]*)<\/title>/g), canonical: all(/<link rel="canonical" href="([^"]*)">/g), robots: all(/<meta name="robots" content="([^"]*)">/g),
    desc: all(/<meta name="description" content="([^"]*)">/g), ogUrl: all(/<meta property="og:url" content="([^"]*)">/g) };
}

test("each public page has its own title, description and canonical URL (the site's address, whatever host answered)", async () => {
  const seen = new Set();
  for (const v of ["", "songs", "editor", "guide", "changelog", "credits", "privacy"]) {
    const p = await page("/" + (v ? "?view=" + v : "")), url = SITE + "/" + (v ? "?view=" + v : "");
    assert.deepEqual(p.canonical, [url], v); assert.deepEqual(p.ogUrl, [url]); assert.deepEqual(p.robots, []); assert.equal(p.headers["x-robots-tag"], undefined);
    assert.equal(p.title.length, 1); assert.ok(p.title[0].length <= 60, p.title[0]); assert.equal(p.desc.length, 1); assert.ok(p.desc[0].replace(/&#?\w+;/g, "x").length <= 155, v + " description");
    assert.ok(!seen.has(p.title[0]) && !seen.has(p.desc[0]), "unique: " + v); seen.add(p.title[0]); seen.add(p.desc[0]);
    assert.equal(p.headers["cache-control"], "public, max-age=0, must-revalidate");
  }
  assert.deepEqual((await page("/?view=guide&utm_source=x")).canonical, [SITE + "/?view=guide"], "tracking parameters: the same page");
  assert.deepEqual((await page("/?view=nope")).canonical, [SITE + "/"], "an unknown view is the home page");
});

test("private views, searches and links to maps, mappers, sessions, projects and invites are noindex", async () => {
  for (const path of ["/?view=admin", "/?view=account", "/?view=projects", "/?view=invite", "/?view=create", "/?view=songs&q=camellia", "/?view=songs&st=loved",
    "/?q=x", "/?view=songs&for=edit", "/?live=abc123", "/?collab=abc123", "/?invite=AbCdEfGhIj", "/?project=00000000-0000-0000-0000-000000000000&key=" + "k".repeat(32), "/?login=ok"]) {
    const p = await page(path);
    assert.deepEqual(p.robots, ["noindex"], path); assert.equal(p.headers["x-robots-tag"], "noindex", path); assert.deepEqual(p.canonical, [], path);
  }
  for (const k of ["s=1", "b=1", "u=peppy", "s=1&mode=mod"]) assert.equal(og.pageMeta(new URLSearchParams(k)).noindex, true, k);
  const live = await page("/?live=abc123"); assert.match(live.title[0], /live mapping/, "the preview card stays");
});

test("only one of each tag, and the page's own tags are replaced, not doubled", async () => {
  const p = await page("/?view=credits");
  for (const re of [/<title>/g, /name="description"/g, /property="og:title"/g, /property="og:url"/g, /name="twitter:title"/g, /rel="canonical"/g, /name="theme-color"/g]) assert.equal((p.head.match(re) || []).length, 1, String(re));
  assert.match(p.head, /<meta name="theme-color" content="#1c1726">/, "the page's own theme colour (only preview cards are pink)");
});

test("the Worker sends every \"/\" request through api/og.js", async () => {
  const worker = (await import(join(root, "worker.js"))).default, html = read("index.html");
  const env = { ASSETS: { fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) } };
  const home = await worker.fetch(new Request("https://x.test/?view=guide"), env, { waitUntil() {} });
  assert.match(await home.text(), new RegExp(`<link rel="canonical" href="${SITE}/\\?view=guide">`));
  assert.equal(home.headers.get("x-robots-tag"), null); assert.ok(home.headers.get("content-security-policy"), "site-wide headers");
  const adm = await worker.fetch(new Request("https://x.test/?view=admin"), env, { waitUntil() {} });
  assert.equal(adm.headers.get("x-robots-tag"), "noindex");
});

test("the page keeps what api/og.js gave it as the view changes (js/app.js: the same descriptions, private keys and titles)", () => {
  const app = read("js/app.js"), core = read("js/core.js");
  const block = app.slice(app.indexOf("const SEO_DESC = {"), app.indexOf("};", app.indexOf("const SEO_DESC = {")));
  const desc = Object.fromEntries([...block.matchAll(/^\s*(\w+): "((?:[^"\\]|\\.)*)",?$/gm)].map(m => [m[1], JSON.parse('"' + m[2] + '"')]));
  assert.deepEqual(desc, Object.fromEntries(Object.entries(og.PAGES).map(([k, v]) => [k || "home", v.desc])));
  const priv = JSON.parse(app.match(/const SEO_PRIVATE = (\{.*\});/)[1].replace(/(\w+):/g, '"$1":'));
  assert.deepEqual(priv, og.PRIVATE);
  assert.match(app, new RegExp(`const SEO_SITE = "${SITE}"`));
  // titles: "<view title> · KIKI Beatmap Viewer" (core.js setTitle), the home page "KIKI Beatmap Viewer: preview and edit osu! beatmaps online"
  assert.match(core, /"KIKI Beatmap Viewer: " \+ tr\("preview and edit osu! beatmaps online"\)/); assert.equal(og.PAGES[""].title, "KIKI Beatmap Viewer: preview and edit osu! beatmaps online");
  assert.match(app, /editor: "osu! beatmap editor"/); assert.equal(og.PAGES.editor.title, "osu! beatmap editor · KIKI Beatmap Viewer");
  assert.match(app, /: tr\("Browse osu! beatmaps"\);/); assert.equal(og.PAGES.songs.title, "Browse osu! beatmaps · KIKI Beatmap Viewer");
  for (const v of ["guide", "credits", "privacy", "changelog"]) assert.equal(og.PAGES[v].title, v[0].toUpperCase() + v.slice(1) + " · KIKI Beatmap Viewer");
});

test("structured data: WebSite and WebApplication, free, no ratings or reviews, and api/og.js leaves it in place", async () => {
  const blocks = [...read("index.html").matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
  assert.equal(blocks.length, 1); const g = blocks[0]["@graph"], t = Object.fromEntries(g.map(x => [x["@type"], x]));
  assert.equal(blocks[0]["@context"], "https://schema.org"); assert.deepEqual(Object.keys(t).sort(), ["WebApplication", "WebSite"]);
  assert.equal(t.WebSite.url, SITE + "/"); assert.equal(t.WebApplication.url, SITE + "/");
  assert.equal(t.WebApplication.operatingSystem, "Web"); assert.equal(t.WebApplication.offers.price, "0"); assert.equal(t.WebApplication.isAccessibleForFree, true);
  assert.deepEqual(t.WebSite.inLanguage.sort(), ["en", "id", "ja", "ko", "ms", "th"]);
  const keys = JSON.stringify(blocks[0]); for (const k of ['"aggregateRating"', '"review"', '"ratingValue"']) assert.ok(!keys.includes(k), k);
  assert.equal(t.WebApplication.description, og.PAGES[""].desc);
  // the site name people know it by: in the structured data, the link cards and the page footer
  assert.equal(t.WebSite.name, "KIKI Beatmap Viewer"); assert.ok(t.WebSite.alternateName.includes("osu! beatmap viewer"));
  assert.match(read("index.html"), /<meta property="og:site_name" content="KIKI Beatmap Viewer">/); assert.match(read("api/og.js"), /og:site_name" content="KIKI Beatmap Viewer"/);
  assert.match(read("index.html"), /<footer class="foot">\s*<b class="footname">KIKI Beatmap Viewer<\/b>/);
  assert.match((await page("/?view=guide")).head, /application\/ld\+json/);
});
