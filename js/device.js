"use strict";
// ============ device ============
// What the site runs on, worked out once in this browser so the page can adapt (⌘ or Ctrl in shortcut hints, no key
// chips on touch-only screens, the iPhone / iPad audio and file-picker paths). Nothing here is stored or sent; only
// siteContext (core.js) puts a short summary ("Safari · iOS · touch") in error reports and "Report a problem", as the
// Privacy page says. Loaded in <head> without defer so the dev-* classes on <html> are there before the first paint:
//   dev-<os> (ios ipados android mac windows linux chromeos other), dev-<browser>, dev-apple (⌘ shortcuts),
//   dev-phone / dev-tablet / dev-desktop, dev-touch, and live: dev-coarse, dev-hover, dev-touchonly, dev-standalone,
//   dev-portrait / dev-landscape.
const DEV = (() => {
  const nav = navigator, ua = nav.userAgent || "", uad = nav.userAgentData || null, tp = nav.maxTouchPoints || 0;
  const mq = q => { try { return matchMedia(q); } catch { return { matches: false }; } };
  const hp = String(uad && uad.platform || ""), brands = uad && uad.brands ? uad.brands.map(b => b.brand).join(" ") : "";
  // iPadOS asks for the desktop site by default: its Safari says "Macintosh", but a Mac has no touch screen
  const fromUA = /iPhone|iPod/.test(ua) ? "ios" : /iPad/.test(ua) ? "ipados" : /Android/.test(ua) ? "android" : /CrOS/.test(ua) ? "chromeos"
    : /Macintosh|Mac OS X/.test(ua) ? (tp > 1 ? "ipados" : "mac") : /Windows/.test(ua) ? "windows" : /Linux/.test(ua) ? "linux" : "other";
  const fromHints = { android: "android", "chrome os": "chromeos", "chromium os": "chromeos", ios: "ios", linux: "linux", macos: tp > 1 ? "ipados" : "mac", windows: "windows" }[hp.toLowerCase()];
  const os = fromHints && !(fromHints === "linux" && fromUA === "android") ? fromHints : fromUA; // (Client Hints first where the browser has them)
  const webkitOnly = os === "ios" || os === "ipados"; // every browser on iPhone / iPad is Safari's engine underneath
  // (the user agent keeps the browser's name even where it's reduced; the brand hints only when it names none)
  const browser = /SamsungBrowser\//.test(ua) ? "samsung" : /Edg(e|A|iOS)?\//.test(ua) ? "edge" : /Firefox\/|FxiOS\//.test(ua) ? "firefox"
    : /OPR\/|Opera/.test(ua) ? "opera" : /CriOS\/|Chrome\/|Chromium\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari"
    : /Microsoft Edge/.test(brands) ? "edge" : /\bOpera\b/.test(brands) ? "opera" : /Chrom/.test(brands) ? "chrome" : "other";
  const mobile = os === "ios" || (os === "android" && (uad && "mobile" in uad ? uad.mobile || /Mobile/.test(ua) : /Mobile/.test(ua)));
  const tablet = os === "ipados" || (os === "android" && !mobile);
  const touch = tp > 0 || "ontouchstart" in window;
  const Q = { coarse: mq("(pointer: coarse)"), hover: mq("(hover: hover)"), standalone: mq("(display-mode: standalone)"), portrait: mq("(orientation: portrait)") };
  const d = Object.freeze({
    os, browser, webkitOnly, mobile, tablet, touch,
    apple: os === "mac" || webkitOnly, // shortcuts read ⌘ (the key handlers take metaKey as well as ctrlKey)
    get coarse() { return Q.coarse.matches; },
    get hover() { return Q.hover.matches; },
    get touchOnly() { return Q.coarse.matches && !Q.hover.matches; }, // a phone or tablet without a mouse or trackpad
    get standalone() { return Q.standalone.matches || nav.standalone === true; }, // installed as an app (iOS: navigator.standalone)
    get portrait() { return Q.portrait.matches; },
  });
  const cl = document.documentElement.classList;
  cl.add("dev-" + os, "dev-" + browser, mobile ? "dev-phone" : tablet ? "dev-tablet" : "dev-desktop");
  if (d.apple) cl.add("dev-apple");
  if (touch) cl.add("dev-touch");
  const live = () => {
    cl.toggle("dev-coarse", d.coarse); cl.toggle("dev-hover", d.hover); cl.toggle("dev-touchonly", d.touchOnly);
    cl.toggle("dev-standalone", d.standalone); cl.toggle("dev-portrait", d.portrait); cl.toggle("dev-landscape", !d.portrait);
  };
  live();
  for (const m of Object.values(Q)) {
    const f = () => { live(); try { dispatchEvent(new Event("devchange")); } catch {} };
    if (m.addEventListener) m.addEventListener("change", f); else if (m.addListener) m.addListener(f); // (Safari before 14)
  }
  return d;
})();
// a shortcut as this device's keyboard shows it: ⌘ instead of Ctrl on a Mac, iPhone or iPad. ⌘H (hide the window) and
// ⌘, / ⌘. (settings, stop) belong to the system there, so those keep Ctrl, which works on a Mac too
const kbdMod = s => DEV.apple && s && !/Ctrl ?\+ ?(H\b|<|,|\.)/.test(s) ? String(s).replace(/\bCtrl\b/g, "⌘") : s;
