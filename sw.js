/* Baseline service worker — network-first with offline fallback.
   Strategy: always try the network (so a deploy is picked up on the next
   visit — no stale-forever trap), cache every successful GET, and serve
   from cache only when the network fails. That makes the installed app
   work offline from whatever it last saw, without a version-bump ritual. */
const CACHE = 'baseline-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // never intercept cross-origin (tool links, video)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || Response.error()))
  );
});
