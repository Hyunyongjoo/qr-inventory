const CACHE_NAME = 'qr-inventory-shell-v3';
const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/api.js',
  './js/app.js',
  './lib/html5-qrcode.min.js',
  './lib/qrcode.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 앱 셸(정적 파일)은 캐시 우선, Apps Script API 호출은 항상 네트워크로 직접 전달합니다.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isApiCall = url.hostname.includes('script.google.com') || url.hostname.includes('script.googleusercontent.com');

  if (isApiCall) {
    return; // 네트워크로 그대로 통과 (오프라인 큐잉은 app.js에서 처리)
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
