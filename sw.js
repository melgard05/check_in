/* Tonnage Log service worker.
   Purpose: let the app open with no connection, and satisfy the browser's
   requirement for an installable app.

   Strategy is network-first for the page itself, so a newly deployed build is
   picked up as soon as there is a connection, with the cached copy used only
   when the network fails. Firebase traffic is never cached — stale tonnage
   numbers would be worse than none. */

const CACHE = "tonnage-shell-v1";
const SHELL = ["./", "./index.html"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache the database or any cross-origin call.
  if (url.origin !== self.location.origin) return;
  if (/firebaseio|firebasedatabase|googleapis/.test(url.hostname)) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => hit || caches.match("./index.html") || caches.match("./"))
      )
  );
});
