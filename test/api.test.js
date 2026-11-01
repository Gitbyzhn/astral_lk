import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createEventHub } from '../server/events.js';
import { createApp } from '../server/app.js';
import { localParts } from '../server/time.js';

let server;
let base;
let db;
let events;
let services;
let token;

async function call(path, { method = 'GET', body, auth = true, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

before(async () => {
  db = openDatabase(':memory:');
  events = createEventHub({ heartbeatMs: 60_000 });
  const created = createApp({ db, events, options: { initialPassword: 'admin', trustProxy: false } });
  services = created.services;
  const { app } = created;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  events.close();
  server.close();
  db.close();
});

describe('кіру (auth)', () => {
  test('қате құпиясөз → 401', async () => {
    const res = await call('/api/auth/login', { method: 'POST', body: { password: 'nope' }, auth: false });
    assert.equal(res.status, 401);
    assert.equal(res.data.error, 'wrong_password');
  });

  test('токенсіз әкімші API → 401', async () => {
    const res = await call('/api/admin/types', { auth: false });
    assert.equal(res.status, 401);
  });

  test('дұрыс құпиясөз → токен', async () => {
    const res = await call('/api/auth/login', { method: 'POST', body: { password: 'admin' }, auth: false });
    assert.equal(res.status, 200);
    assert.ok(res.data.token);
    assert.equal(res.data.passwordIsDefault, true);
    token = res.data.token;
  });
});

describe('билет түрлері', () => {
  test('мысал түрлер алғашқы іске қосуда қосылады', async () => {
    const res = await call('/api/admin/types');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.data.map((t) => t.name),
      ['Ересек', 'Балалар', 'VIP'],
    );
  });

  test('валидация: бос атау және теріс баға', async () => {
    assert.equal((await call('/api/admin/types', { method: 'POST', body: { name: ' ', price: 100 } })).data.error, 'invalid_name');
    assert.equal((await call('/api/admin/types', { method: 'POST', body: { name: 'X', price: -1 } })).data.error, 'invalid_price');
    assert.equal((await call('/api/admin/types', { method: 'POST', body: { name: 'X', price: 1.5 } })).data.error, 'invalid_price');
  });

  test('қосу, өзгерту, жасыру, реттеу, жою', async () => {
    const created = await call('/api/admin/types', { method: 'POST', body: { name: '  Студент  ', price: 1500 } });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, 'Студент');
    assert.equal(created.data.color, 3, 'бос тұрған бірінші түс таңдалады');

    const updated = await call(`/api/admin/types/${created.data.id}`, { method: 'PATCH', body: { price: 1800, active: false } });
    assert.equal(updated.data.price, 1800);
    assert.equal(updated.data.active, false);

    const cashier = await call('/api/admin/types');
    assert.ok(!cashier.data.some((t) => t.id === created.data.id), 'жасырылған түр кассада көрінбейді');
    const all = await call('/api/admin/types?all=1');
    assert.ok(all.data.some((t) => t.id === created.data.id));

    const ids = all.data.map((t) => t.id).reverse();
    const reordered = await call('/api/admin/types/reorder', { method: 'POST', body: { ids } });
    assert.deepEqual(
      reordered.data.map((t) => t.id),
      ids,
    );
    await call('/api/admin/types/reorder', { method: 'POST', body: { ids: [...ids].reverse() } });

    const removed = await call(`/api/admin/types/${created.data.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    const after = await call('/api/admin/types?all=1');
    assert.ok(!after.data.some((t) => t.id === created.data.id));
  });
});

describe('топтық тапсырыс және кезек', () => {
  const orders = [];

  test('5 адамдық топ: әртүрлі билеттер → бір кезек нөмірі', async () => {
    const res = await call('/api/admin/orders', {
      method: 'POST',
      body: {
        items: [
          { ticketTypeId: 1, qty: 2 },
          { ticketTypeId: 2, qty: 2 },
          { ticketTypeId: 1, qty: 1 }, // қайталанса — біріктіріледі
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.number, 1);
    assert.equal(res.data.people, 5);
    assert.equal(res.data.total, 3 * 2000 + 2 * 1000);
    assert.equal(res.data.items.length, 2);
    assert.match(res.data.code, /^[a-z2-9]{10}$/);
    assert.equal(res.data.day, localParts().day);
    orders.push(res.data);
  });

  test('келесі тапсырыстар реттік нөмір алады', async () => {
    for (const items of [[{ ticketTypeId: 3, qty: 1 }], [{ ticketTypeId: 2, qty: 4 }]]) {
      const res = await call('/api/admin/orders', { method: 'POST', body: { items } });
      assert.equal(res.status, 201);
      orders.push(res.data);
    }
    assert.deepEqual(
      orders.map((o) => o.number),
      [1, 2, 3],
    );
  });

  test('қате тапсырыстар қабылданбайды', async () => {
    const cases = [
      [{ items: [] }, 'empty_order'],
      [{ items: [{ ticketTypeId: 1, qty: 0 }] }, 'empty_order'],
      [{ items: [{ ticketTypeId: 1, qty: 1000 }] }, 'invalid_qty'],
      [{ items: [{ ticketTypeId: 1, qty: 1.5 }] }, 'invalid_qty'],
      [{ items: [{ ticketTypeId: 999, qty: 1 }] }, 'invalid_ticket_type'],
      [{}, 'empty_order'],
    ];
    for (const [body, error] of cases) {
      const res = await call('/api/admin/orders', { method: 'POST', body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.data.error, error);
    }
  });

  test('клиент өз талонын көреді: алдында қанша топ', async () => {
    const res = await call(`/api/public/orders/${orders[2].code}`, { auth: false });
    assert.equal(res.status, 200);
    assert.equal(res.data.order.number, 3);
    assert.equal(res.data.order.id, undefined, 'ішкі id жарияланбайды');
    assert.equal(res.data.queue.ahead, 2);
    assert.equal(res.data.queue.aheadPeople, 6);
    assert.deepEqual(res.data.queue.serving, []);
    assert.equal(res.data.business.businessName, 'Astral');
  });

  test('белгісіз код → 404', async () => {
    const res = await call('/api/public/orders/zzzzzzzzzz', { auth: false });
    assert.equal(res.status, 404);
  });

  test('«Келесіні шақыру»: алдыңғысы аяқталады, келесі шақырылады', async () => {
    let res = await call('/api/admin/queue/next', { method: 'POST' });
    assert.equal(res.data.called.number, 1);
    assert.equal(res.data.serving.length, 1);
    assert.equal(res.data.waiting.length, 2);

    const client = await call(`/api/public/orders/${orders[0].code}`, { auth: false });
    assert.equal(client.data.order.status, 'serving');

    res = await call('/api/admin/queue/next', { method: 'POST' });
    assert.equal(res.data.called.number, 2);
    const first = await call(`/api/public/orders/${orders[0].code}`, { auth: false });
    assert.equal(first.data.order.status, 'done');

    const third = await call(`/api/public/orders/${orders[2].code}`, { auth: false });
    assert.equal(third.data.queue.ahead, 0);
    assert.deepEqual(third.data.queue.serving, [2]);
  });

  test('нақты талонды шақыру, болдырмау және кезекке қайтару', async () => {
    let res = await call(`/api/admin/orders/${orders[2].id}`, { method: 'PATCH', body: { status: 'serving' } });
    assert.equal(res.data.status, 'serving');
    const second = await call(`/api/admin/orders/${orders[1].id}`);
    assert.equal(second.data.status, 'done', 'бір уақытта бір топ шақырылады');

    res = await call(`/api/admin/orders/${orders[2].id}`, { method: 'PATCH', body: { status: 'cancelled' } });
    assert.equal(res.data.status, 'cancelled');

    res = await call(`/api/admin/orders/${orders[2].id}`, { method: 'PATCH', body: { status: 'waiting' } });
    assert.equal(res.data.status, 'waiting');
    assert.equal(res.data.calledAt, null);

    res = await call(`/api/admin/orders/${orders[2].id}`, { method: 'PATCH', body: { status: 'cancelled' } });
    assert.equal(res.data.status, 'cancelled');

    assert.equal((await call(`/api/admin/orders/${orders[2].id}`, { method: 'PATCH', body: { status: 'bogus' } })).status, 400);
    assert.equal((await call('/api/admin/orders/9999', { method: 'PATCH', body: { status: 'done' } })).status, 404);
  });

  test('кезек бос болса «Келесі» ешкімді шақырмайды', async () => {
    const res = await call('/api/admin/queue/next', { method: 'POST' });
    assert.equal(res.data.called, null);
    assert.equal(res.data.serving.length, 0);
    assert.equal(res.data.today.done, 2);
  });

  test('табло: шақырылған және келесі нөмірлер', async () => {
    await call('/api/admin/orders', { method: 'POST', body: { items: [{ ticketTypeId: 1, qty: 1 }] } });
    const res = await call('/api/public/board', { auth: false });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.data.next.map((n) => n.number),
      [4],
    );
    assert.equal(res.data.waiting, 1);
  });
});

describe('есептер', () => {
  test('күндік есеп: болдырылмағандар есепке кірмейді', async () => {
    const res = await call('/api/admin/reports?period=day');
    assert.equal(res.status, 200);
    // №1: 3×2000 + 2×1000, №2: 1×5000, №4: 1×2000; №3 болдырылмады
    assert.equal(res.data.totals.revenue, 8000 + 5000 + 2000);
    assert.equal(res.data.totals.people, 5 + 1 + 1);
    assert.equal(res.data.totals.orders, 3);
    assert.equal(res.data.totals.cancelled, 1);
    assert.equal(res.data.totals.avgCheck, 5000);
    const adult = res.data.byType.find((t) => t.name === 'Ересек');
    assert.equal(adult.qty, 4);
    assert.equal(adult.revenue, 8000);
    assert.equal(res.data.series.length, 24);
    assert.equal(
      res.data.series.reduce((s, p) => s + p.revenue, 0),
      res.data.totals.revenue,
    );
  });

  test('айлық және жалпы есеп', async () => {
    const { month } = localParts();
    const monthly = await call(`/api/admin/reports?period=month&date=${month}`);
    assert.equal(monthly.data.totals.revenue, 15000);
    assert.equal(monthly.data.series.length >= 28, true);
    const all = await call('/api/admin/reports?period=all');
    assert.equal(all.data.totals.revenue, 15000);
    assert.equal(all.data.series.at(-1).key, month);
  });

  test('бұрынғы күн бос, қате кезең → 400', async () => {
    const past = await call('/api/admin/reports?period=day&date=2020-01-01');
    assert.equal(past.data.totals.orders, 0);
    assert.equal((await call('/api/admin/reports?period=year')).status, 400);
  });
});

describe('баптаулар және құпиясөз', () => {
  test('мекеме атауын өзгерту клиентке де көрінеді', async () => {
    const res = await call('/api/admin/settings', { method: 'PATCH', body: { businessName: 'Ғарыш Парк' } });
    assert.equal(res.data.businessName, 'Ғарыш Парк');
    const info = await call('/api/public/info', { auth: false });
    assert.equal(info.data.businessName, 'Ғарыш Парк');
    assert.equal((await call('/api/admin/settings', { method: 'PATCH', body: { businessName: '' } })).status, 400);
  });

  test('құпиясөзді өзгерткенде ескі токендер жарамсыз болады', async () => {
    const wrong = await call('/api/admin/password', { method: 'POST', body: { current: 'x', next: 'secret1' } });
    assert.equal(wrong.status, 400);
    const weak = await call('/api/admin/password', { method: 'POST', body: { current: 'admin', next: '12' } });
    assert.equal(weak.data.error, 'weak_password');

    const oldToken = token;
    const ok = await call('/api/admin/password', { method: 'POST', body: { current: 'admin', next: 'secret1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.passwordIsDefault, false);

    token = oldToken;
    assert.equal((await call('/api/admin/types')).status, 401);
    token = ok.data.token;
    assert.equal((await call('/api/admin/types')).status, 200);
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { password: 'admin' }, auth: false })).status, 401);
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { password: 'secret1' }, auth: false })).status, 200);
  });
});

describe('нақты уақыт (SSE) және ескі талондар', () => {
  test('тапсырыс құрылғанда барлық беттерге хабар барады', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const waitFor = async (needle) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
      }
      return buffer.includes(needle);
    };
    assert.ok(await waitFor('event: hello'));
    await call('/api/admin/orders', { method: 'POST', body: { items: [{ ticketTypeId: 2, qty: 1 }] } });
    assert.ok(await waitFor('event: queue'));
    controller.abort();
  });

  test('ұмытылған ескі талондар автоматты түрде жабылады', () => {
    const old = new Date(Date.now() - 13 * 3_600_000).toISOString();
    db.prepare(
      "INSERT INTO orders (code, number, day, hour, status, people, total, created_at) VALUES ('oldoldold2', 999, '2000-01-01', 10, 'waiting', 1, 100, ?)",
    ).run(old);
    assert.equal(services.orders.expireStale(), 1);
    assert.equal(db.prepare("SELECT status FROM orders WHERE code = 'oldoldold2'").get().status, 'done');
  });
});

describe('беттер және PWA', () => {
  test('SPA маршруттары дұрыс HTML береді', async () => {
    for (const [path, marker] of [
      ['/', 'client/main.js'],
      ['/t/abc', 'client/main.js'],
      ['/board', 'client/main.js'],
      ['/admin', 'admin/main.js'],
      ['/admin/queue', 'admin/main.js'],
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.ok((await res.text()).includes(marker), path);
    }
    assert.equal((await fetch(`${base}/no-such-page`)).status, 404);
    assert.equal((await fetch(`${base}/api/no-such`)).status, 404);
  });

  test('манифестер мекеме атауымен', async () => {
    const client = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(client.start_url, '/');
    assert.match(client.name, /Ғарыш Парк/);
    const admin = await (await fetch(`${base}/admin/manifest.webmanifest`)).json();
    assert.equal(admin.scope, '/admin/');
    for (const icon of [...client.icons, ...admin.icons]) {
      assert.equal((await fetch(base + icon.src)).status, 200, icon.src);
    }
  });

  test('service worker кэштейтін барлық файл бар', async () => {
    const sw = await (await fetch(`${base}/sw.js`)).text();
    const shell = JSON.parse(sw.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
    for (const path of shell) assert.equal((await fetch(base + path)).status, 200, path);
  });

  test('қауіпсіздік тақырыптары', async () => {
    const res = await fetch(`${base}/`);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('әкімші сілтемесі (аккаунтсыз кіру)', () => {
  test('кілт арқылы кіру, жаңа сілтеме жасағанда ескісі өшеді', async () => {
    const settingsRes = await call('/api/admin/settings');
    const key = settingsRes.data.adminKey;
    assert.match(key, /^[A-Za-z0-9]{24}$/);

    const wrong = await call('/api/auth/key', { method: 'POST', body: { key: 'x'.repeat(24) }, auth: false });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.error, 'invalid_admin_link');

    const ok = await call('/api/auth/key', { method: 'POST', body: { key }, auth: false });
    assert.equal(ok.status, 200);
    const viaLink = ok.data.token;
    token = viaLink;
    assert.equal((await call('/api/admin/types')).status, 200);

    const rotated = await call('/api/admin/admin-key/rotate', { method: 'POST' });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.data.adminKey, key);

    // ескі кілт және ескі сессиялар жарамсыз
    assert.equal((await call('/api/auth/key', { method: 'POST', body: { key }, auth: false })).status, 401);
    assert.equal((await call('/api/admin/types')).status, 401);
    // жаңасы жұмыс істейді, ауыстырған құрылғы кірген күйде қалады
    token = rotated.data.token;
    assert.equal((await call('/api/admin/types')).status, 200);
    const fresh = await call('/api/auth/key', { method: 'POST', body: { key: rotated.data.adminKey }, auth: false });
    assert.equal(fresh.status, 200);
  });
});
