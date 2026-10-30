/* Service worker: lets the app reopen on a weak connection and caches map
 * tiles that were already viewed. App files are network-first, so edits to
 * config.js show up on the next load while online. js/vendor/jsQR.js is
 * only fetched (and then cached) on phones without a built-in QR decoder. */
const VERSION = 'hunt-v5';
const TILE_CACHE = 'hunt-tiles-v1';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon-192.png',
  'js/config.js', 'js/geo.js', 'js/store.js', 'js/overlay.js', 'js/app.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.destination === 'image' && url.origin !== location.origin) e.respondWith(cacheFirst(req));
  else if (url.origin === location.origin || url.hostname === 'unpkg.com') e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  network.catch(() => {});
  try {
    // Don't hang on a crawling connection: after 4 s use the cached copy if there is one.
    return await Promise.race([network, new Promise((_, reject) => setTimeout(reject, 4000))]);
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true })) || network;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
