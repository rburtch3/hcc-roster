// HCC Roster service worker: lets the app install and open offline.
// The page is always fetched fresh when online (network first), so a deploy never strands a phone on an
// old copy; the last good copy is only used when there is no connection. /api and /auth are never cached.
const CACHE = "roster-v2";
// Only the app page itself is kept as the offline copy: /signin, /7shifts.html and the rest must never replace it.
const APP_PAGE = /^\/(?:(?:vol|admin)(?:\/.*)?)?$/;
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/hub/") || url.pathname.startsWith("/__/")) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { if (r.ok && APP_PAGE.test(url.pathname)) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); } return r; })
      .catch(() => caches.match("/").then((r) => r || new Response("You're offline. Open Roster again when you're connected.", { headers: { "content-type": "text/plain" } }))));
    return;
  }
  if (/\.(png|webmanifest)$/.test(url.pathname) || url.pathname === "/roster-data.json") {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; }).catch(() => caches.match(req)));
  }
});
