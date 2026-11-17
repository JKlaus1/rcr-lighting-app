// Offline cache for the RCR Lighting app. Network first (so an updated app wins),
// cache as the fallback (so the app opens in a garage with no signal).
// Bump CACHE on every publish. test/sw.test.mjs fails when a file of the app is missing from FILES.
const CACHE = "rcr-lighting-v35";
const APP = ["barshape", "bike", "bikeview", "bikeview-3d", "bikeview-flat", "bikeview-math", "bikeview-place", "core", "fx",
  "fxdata", "lights", "link", "main", "matrix", "ride", "sheet", "sheet-look",
  "sheet-placement", "sheet-sections", "sheet-wiring", "store", "system", "system-backup", "system-controller", "system-diag",
  "system-kit", "system-pods", "system-power", "ui", "wizard"];
const CSS = ["base", "bike", "bikeview", "matrix", "ride", "sheet", "system"];
const FILES = ["./", "./index.html", "./v049.html", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png",
  ...APP.map(m => `./app/${m}.js`), ...CSS.map(c => `./app/css/${c}.css`),
  "./core/rcr-core.wasm", "./vendor/three/three.bundle.js",
  "./bikes/onyx-rcr.glb", "./bikes/onyx-rcr-side.jpg", "./bikes/onyx-rcr-rear.jpg"];
// One file at a time: a file that fails to load must not stop the rest from being cached.
async function precache() {
  const c = await caches.open(CACHE);
  await Promise.all(FILES.map(f => c.add(f).catch(() => {})));
}
self.addEventListener("install", e => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })
      .then(r => r || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
