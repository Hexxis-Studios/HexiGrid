importScripts('/pwa-policy.js');

const { CACHE_NAME, SHELL_ASSETS, isSafeCacheRequest } = self.HexiGridPwaPolicy;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Navigation fragments select a view, never a different shell or cache entry.
  const navigationUrl = new URL(request.url);
  if (request.mode === 'navigate') navigationUrl.hash = '';
  const cacheRequest = request.mode === 'navigate' ? navigationUrl.href : request;
  if (!isSafeCacheRequest({ method: request.method, url: navigationUrl.href }, self.location.origin)) return;
  event.respondWith(
    fetch(request, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok || response.redirected || response.type === 'opaque') return response;
        const cacheControl = response.headers.get('cache-control') || '';
        if (/no-store|private/i.test(cacheControl)) return response;
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(cacheRequest, response.clone())));
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(cacheRequest);
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/');
        return Response.error();
      })
  );
});
