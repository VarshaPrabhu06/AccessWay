// AccessWay service worker: saves the app shell so the page opens offline.
// Network first, so you always get the newest files when online.
// Live data (search, reports, admin, photos) is never saved.

const CACHE = "accessway-v1";
const SHELL = [
    "/",
    "/style.css",
    "/accessway-upgrade.css",
    "/script.js",
    "/accessway-upgrade.js",
    "/icon-192.png"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE)
            .then(cache => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);

    if (request.method !== "GET" || url.origin !== self.location.origin) return;

    if (url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/admin") ||
        url.pathname.startsWith("/uploads/")) return;

    event.respondWith(
        fetch(request)
            .then(response => {
                const copy = response.clone();
                caches.open(CACHE).then(cache => cache.put(request, copy));
                return response;
            })
            .catch(() => caches.match(request).then(saved => saved || caches.match("/")))
    );
});