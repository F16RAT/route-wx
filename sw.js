const V = "routewx-v1";
const SHELL = ["./", "index.html", "app.css", "manifest.json", "js/geo.js", "js/route.js", "js/hazards.js", "js/aeroapi.js", "js/app.js",
  "icons/icon-180.png", "icons/icon-192.png", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = u.origin === location.origin;
  // weather data + app code: network first, fall back to cache (offline)
  if (sameOrigin && !u.pathname.includes("/nav/")) {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  // nav data + leaflet: cache first
  if ((sameOrigin && u.pathname.includes("/nav/")) || u.host === "unpkg.com") {
    e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then((r) => { const c = r.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); return r; })));
  }
});
