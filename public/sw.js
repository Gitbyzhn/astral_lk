/* Astral service worker: қосымша қабығын кэштейді (желі нашар болса да ашылады).
   Стратегия — алдымен желі, болмаса кэш. API сұраулары кэштелмейді (деректер әрқашан жаңа). */
const VERSION = 'astral-v2';

const SHELL = [
  '/',
  '/admin/',
  '/assets/css/app.css',
  '/assets/js/core/api.js',
  '/assets/js/core/dom.js',
  '/assets/js/core/env.js',
  '/assets/js/core/format.js',
  '/assets/js/core/i18n.js',
  '/assets/js/core/icons.js',
  '/assets/js/core/live.js',
  '/assets/js/core/logo.js',
  '/assets/js/core/media.js',
  '/assets/js/core/pwa.js',
  '/assets/js/core/qr.js',
  '/assets/js/core/router.js',
  '/assets/js/core/ui.js',
  '/assets/js/client/main.js',
  '/assets/js/client/app.js',
  '/assets/js/client/common.js',
  '/assets/js/client/home.js',
  '/assets/js/client/ticket.js',
  '/assets/js/client/board.js',
  '/assets/js/client/saved.js',
  '/assets/js/admin/main.js',
  '/assets/js/admin/app.js',
  '/assets/js/admin/shared.js',
  '/assets/js/admin/login.js',
  '/assets/js/admin/cashier.js',
  '/assets/js/admin/queue.js',
  '/assets/js/admin/types.js',
  '/assets/js/admin/reports.js',
  '/assets/js/admin/chart.js',
  '/assets/js/admin/settings.js',
  '/vendor/qrcode.mjs',
  '/icons/logo.svg',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Барлық клиент беттері бір index.html — офлайн кезде сол қабық ашылады.
    const shell = url.pathname.startsWith('/admin') ? '/admin/' : '/';
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(shell, copy));
          }
          return response;
        })
        .catch(() => caches.match(shell)),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});

// «Сіздің кезегіңіз келді» хабарламасын басқанда — талон бетін ашу.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
