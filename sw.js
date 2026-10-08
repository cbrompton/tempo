// Tempo service worker: precache everything, then serve cache-first so the app
// works fully offline. Bump CACHE whenever you deploy changed files.
const CACHE = 'tempo-1.0.0';

const SPLASH = [
  '1320x2868', '1206x2622', '1290x2796', '1179x2556', '1284x2778', '1170x2532',
  '1080x2340', '1242x2688', '828x1792', '1125x2436', '750x1334',
].map((s) => `icons/splash-${s}.png`);

const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'stacks.js',
  'force.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  ...SPLASH,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let hit = await cache.match(req, { ignoreSearch: true });
    if (!hit && req.mode === 'navigate') hit = await cache.match('index.html');
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch {
      return Response.error();
    }
  })());
});
