/* Astral service worker: қосымша қабығын кэштейді (желі нашар болса да ашылады).
   Стратегия — алдымен желі, болмаса кэш. API сұраулары кэштелмейді (деректер әрқашан жаңа). */
const VERSION = 'astral-v4';

const SHELL = [
  '/',
  '/admin/',
  '/kassa/',
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
  '/assets/js/kassa/main.js',
  '/assets/js/kassa/login.js',
  '/assets/js/kassa/sales.js',
  '/vendor/qrcode.mjs',
  '/brand/mark.webp',
  '/brand/logo.webp',
  '/icons/favicon.png',
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
    // Әр қосымшаның беттері бір index.html — офлайн кезде сол қабық ашылады.
    const shell = url.pathname.startsWith('/admin') ? '/admin/' : url.pathname.startsWith('/kassa') ? '/kassa/' : '/';
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

/* ---------------- Клиент телефонына хабарлама (Web Push) ----------------
   Сервер «бос» push жібереді (шифрлау керек емес) — қай талон шақырылғанын осы жерде сұраймыз.
   Хабарлама телефонның өз дыбысымен және дірілімен келеді (бет жабық, экран құлыптаулы болса да). */
const PUSH_TEXT = {
  kk: {
    turn: 'Сіздің кезегіңіз келді!',
    turnBody: '№{n} · Кассаға немесе кіреберіске келіңіз',
    next: 'Келесі — сіз!',
    nextBody: '№{n} · Дайын болыңыз',
    check: 'Кезек жаңарды',
    checkBody: 'Талоныңызды ашып қараңыз',
  },
  ru: {
    turn: 'Ваша очередь!',
    turnBody: '№{n} · Подойдите к кассе или ко входу',
    next: 'Следующий — вы!',
    nextBody: '№{n} · Будьте готовы',
    check: 'Очередь обновилась',
    checkBody: 'Откройте свой талон',
  },
};

async function showPushNotifications() {
  let orders = [];
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub) {
      const res = await fetch('/api/public/push/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
        cache: 'no-store',
      });
      if (res.ok) orders = (await res.json()).orders ?? [];
    }
  } catch {
    /* желі жоқ — жалпы хабарлама */
  }
  const common = {
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    vibrate: [400, 150, 400, 150, 800],
    renotify: true,
    silent: false,
  };
  if (!orders.length) {
    const text = PUSH_TEXT.kk;
    return self.registration.showNotification(text.check, { ...common, body: text.checkBody, tag: 'astral-queue', data: { url: '/' } });
  }
  await Promise.all(
    orders.map(async (order) => {
      const text = PUSH_TEXT[order.lang] ?? PUSH_TEXT.kk;
      const turn = order.status === 'serving';
      // Кезек келді — «Келесі — сіз» хабарламасы енді керек емес
      if (turn) for (const old of await self.registration.getNotifications({ tag: `next-${order.code}` })) old.close();
      return self.registration.showNotification(turn ? text.turn : text.next, {
        ...common,
        body: (turn ? text.turnBody : text.nextBody).replace('{n}', order.number),
        tag: `${turn ? 'turn' : 'next'}-${order.code}`,
        requireInteraction: turn,
        timestamp: Date.now(),
        data: { url: `/t/${order.code}` },
      });
    }),
  );
}

self.addEventListener('push', (event) => {
  event.waitUntil(showPushNotifications());
});

// Хабарламаны басқанда — талон бетін ашу (ашық тұрса — соған өту).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
