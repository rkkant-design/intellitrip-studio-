/*
 * IntelliTrip service worker: lets the installed app open with no signal.
 * - Pages: network first, falling back to the saved app shell offline.
 * - Built files (/assets/*, hashed names): saved once, served from the cache.
 * - Fonts and icons: served from the cache, refreshed in the background.
 * Trips themselves live in the browser's storage, so they need nothing here.
 * AI calls (/api/*), sign-in, sync and map tiles always go to the network.
 */
const CACHE = 'intellitrip-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-32.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const assetsIn = (html) => [...new Set((html.match(/\/assets\/[^"'\s)]+/g) || []))];

// Saves a fresh copy of the app shell and the built files it uses; drops built files it no longer uses.
async function saveShell(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  await cache.put('/', response.clone());
  const wanted = assetsIn(html);
  await Promise.all(wanted.map(async (url) => {
    if (!(await cache.match(url))) {
      try {
        const r = await fetch(url);
        if (r.ok) await cache.put(url, r);
      } catch { /* picked up next time */ }
    }
  }));
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/') && !wanted.includes(path)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.slice(1));
    const r = await fetch('/', { cache: 'no-store' });
    if (r.ok) await saveShell(r);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/') || url.pathname.startsWith('/__/')) return;
    if (req.mode === 'navigate') {
      // Network first, but on weak signal ("lie-fi") don't make people wait: after 3.5 s the saved
      // copy opens, and the fresh one still updates the cache in the background.
      event.respondWith((async () => {
        const network = fetch(req).then((r) => {
          if (r.ok && (r.headers.get('content-type') || '').includes('text/html')) event.waitUntil(saveShell(r.clone()));
          return r;
        });
        event.waitUntil(network.catch(() => undefined));
        const saved = caches.match('/');
        const slow = new Promise((resolve) => setTimeout(resolve, 3500, 'slow'));
        try {
          const first = await Promise.race([network, slow]);
          if (first !== 'slow') return first;
          return (await saved) || (await network);
        } catch {
          return (await saved) || Response.error();
        }
      })());
      return;
    }
    if (url.pathname.startsWith('/assets/')) {
      event.respondWith((async () => {
        const hit = await caches.match(url.pathname);
        if (hit) return hit;
        const r = await fetch(req);
        if (r.ok) (await caches.open(CACHE)).put(url.pathname, r.clone());
        return r;
      })());
      return;
    }
    if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
      event.respondWith(staleWhileRevalidate(req));
    }
    return;
  }

  if (FONT_HOSTS.includes(url.hostname)) event.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((r) => {
    if (r.ok || r.type === 'opaque') cache.put(req, r.clone());
    return r;
  }).catch(() => hit || Response.error());
  return hit || fresh;
}
