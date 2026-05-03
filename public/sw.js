// BELTO service worker — caches everything needed to run the app offline
// after the first successful load. Network-first for tile data (so live
// modes still work when online), cache-first for the app shell + model.

const CACHE_VERSION = 'belto-v0.10.1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/models/belto-cnn.onnx'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('belto-') && k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // ONNX runtime wasm + js from CDN — cache first
  const isOnnxRuntime = url.hostname.includes('jsdelivr.net') || url.hostname.includes('unpkg.com');

  // Same-origin app assets — cache first
  const isAppAsset = url.origin === self.location.origin;

  // GIBS / NOAA / EONET tiles — network first (we want fresh data when online)
  const isLiveData =
    url.hostname.includes('earthdata.nasa.gov') ||
    url.hostname.includes('gsfc.nasa.gov') ||
    url.hostname.includes('nesdis.noaa.gov');

  if (isLiveData) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Cache the response so we have it offline next time
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, clone)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  if (isAppAsset || isOnnxRuntime) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(request, clone)).catch(() => {});
          }
          return res;
        });
      })
    );
  }
});
