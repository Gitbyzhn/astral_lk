import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  const created = createApp({
    db,
    events,
    // Тесттегі жалған push қызметі 127.0.0.1-де (шынайы ортада тек https push қызметтері)
    options: { initialPassword: 'admin', trustProxy: false, pushHosts: ['127.0.0.1'], pushAllowInsecure: true },
  });
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
    assert.equal(res.data.business.businessName, 'Astral Labyrinth');
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

describe('төлем түрлері (Наличка / Каспий / Банк)', () => {
  let order;
  let baseline;
  const byPayment = async () => {
    const { data } = await call('/api/admin/reports?period=day');
    return { totals: data.totals, rows: data.byPayment, by: Object.fromEntries(data.byPayment.map((p) => [p.name ?? 'none', p])) };
  };

  test('алдын ала дайын үш түр, әдепкісі — Каспий', async () => {
    const res = await call('/api/admin/payment-methods');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.data.map((m) => [m.name, m.isDefault]),
      [
        ['Наличка', false],
        ['Каспий', true],
        ['Банк', false],
      ],
    );
    const catalog = await call('/api/kassa/catalog');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.data.defaultPaymentMethodId, 2);
    assert.equal(catalog.data.paymentMethods.length, 3);
    assert.ok(catalog.data.types.length >= 3);
  });

  test('әр билет жолының өз төлем түрі, көрсетілмесе — Каспий', async () => {
    baseline = await byPayment();
    const res = await call('/api/kassa/orders', {
      method: 'POST',
      body: {
        items: [
          { ticketTypeId: 1, qty: 2 }, // әдепкі → Каспий
          { ticketTypeId: 1, qty: 1, paymentMethodId: 1 }, // бір ересек — қолма-қол
          { ticketTypeId: 2, qty: 1, paymentMethodId: 3 },
          { ticketTypeId: 1, qty: 1, paymentMethodId: 2 }, // Каспиймен біріктіріледі
        ],
      },
    });
    assert.equal(res.status, 201);
    order = res.data;
    assert.equal(order.people, 5);
    assert.deepEqual(
      order.items.map((i) => [i.ticketTypeId, i.qty, i.paymentName]),
      [
        [1, 3, 'Каспий'],
        [1, 1, 'Наличка'],
        [2, 1, 'Банк'],
      ],
    );

    // Клиентке төлем мәліметтері көрсетілмейді, бір түр бір жол болып шығады
    const client = await call(`/api/public/orders/${order.code}`, { auth: false });
    assert.deepEqual(
      client.data.order.items.map((i) => [i.ticketTypeId, i.qty, i.paymentName]),
      [
        [1, 4, undefined],
        [2, 1, undefined],
      ],
    );
  });

  test('есепте төлем түрлері бойынша бөлінеді, ескі тапсырыстар — «көрсетілмеген»', async () => {
    const after = await byPayment();
    const delta = (name, key) => after.by[name][key] - (baseline.by[name]?.[key] ?? 0);
    assert.equal(delta('Каспий', 'qty'), 3);
    assert.equal(delta('Каспий', 'revenue'), 3 * 2000);
    assert.equal(delta('Наличка', 'revenue'), 2000);
    assert.equal(delta('Банк', 'revenue'), 1000);
    assert.equal(after.by.none, undefined);

    // Жаңартуға дейін берілген талон (төлем түрі жоқ) бөлек жолға түседі
    const { lastInsertRowid } = db
      .prepare("INSERT INTO orders (code, number, day, hour, people, total, created_at) VALUES ('legacy2345', 900, ?, 10, 1, 700, ?)")
      .run(localParts().day, new Date().toISOString());
    db.prepare("INSERT INTO order_items (order_id, ticket_type_id, name, price, qty) VALUES (?, 2, 'Балалар', 700, 1)").run(lastInsertRowid);
    const withLegacy = await byPayment();
    assert.equal(withLegacy.by.none.revenue, 700);
    assert.deepEqual(
      withLegacy.rows.map((p) => p.name),
      ['Наличка', 'Каспий', 'Банк', null],
      'тұрақты рет: белсенді түрлер, соңында көрсетілмеген',
    );
    assert.equal(
      withLegacy.rows.reduce((s, p) => s + p.revenue, 0),
      withLegacy.totals.revenue,
    );
  });

  test('жоқ немесе жойылған төлем түрі қабылданбайды', async () => {
    for (const paymentMethodId of [999, 'x', -1]) {
      const res = await call('/api/kassa/orders', { method: 'POST', body: { items: [{ ticketTypeId: 1, qty: 1, paymentMethodId }] } });
      assert.equal(res.status, 400, String(paymentMethodId));
      assert.equal(res.data.error, 'invalid_payment_method');
    }
  });

  test('қосу, атын өзгерту, әдепкі ету, жою', async () => {
    assert.equal((await call('/api/admin/payment-methods', { method: 'POST', body: { name: ' ' } })).data.error, 'invalid_name');
    const created = await call('/api/admin/payment-methods', { method: 'POST', body: { name: '  Halyk   QR ' } });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, 'Halyk QR');
    assert.equal(created.data.isDefault, false);

    const renamed = await call(`/api/admin/payment-methods/${created.data.id}`, { method: 'PATCH', body: { name: 'Halyk', isDefault: true } });
    assert.equal(renamed.data.name, 'Halyk');
    assert.equal(renamed.data.isDefault, true);
    assert.equal((await call('/api/kassa/catalog')).data.defaultPaymentMethodId, created.data.id);

    // Әдепкі түр жойылса — тізімдегі бірінші түр әдепкі болады
    assert.equal((await call(`/api/admin/payment-methods/${created.data.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await call(`/api/admin/payment-methods/${created.data.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await call('/api/kassa/catalog')).data.defaultPaymentMethodId, 1);
    const bad = await call('/api/kassa/orders', { method: 'POST', body: { items: [{ ticketTypeId: 1, qty: 1, paymentMethodId: created.data.id }] } });
    assert.equal(bad.data.error, 'invalid_payment_method');

    // Каспийді қайта әдепкі етеміз
    assert.equal((await call('/api/admin/payment-methods/2', { method: 'PATCH', body: { isDefault: true } })).data.isDefault, true);
  });
});

describe('касса кабинеті (кассир)', () => {
  let cashierToken;
  const asCashier = (path, options = {}) => {
    const saved = token;
    token = cashierToken;
    return call(path, options).finally(() => {
      token = saved;
    });
  };

  test('касса сілтемесі арқылы кіру → кассир рөлі', async () => {
    const { data: settings } = await call('/api/admin/settings');
    assert.match(settings.cashierKey, /^[A-Za-z0-9]{24}$/);
    assert.notEqual(settings.cashierKey, settings.adminKey);

    const res = await call('/api/auth/key', { method: 'POST', body: { key: settings.cashierKey }, auth: false });
    assert.equal(res.status, 200);
    assert.equal(res.data.role, 'cashier');
    cashierToken = res.data.token;
    assert.deepEqual((await asCashier('/api/kassa/session')).data, { ok: true, role: 'cashier' });
  });

  test('кассир билет береді және бүгінгі сатылымды көреді', async () => {
    const catalog = await asCashier('/api/kassa/catalog');
    assert.equal(catalog.status, 200);
    const created = await asCashier('/api/kassa/orders', {
      method: 'POST',
      body: { items: [{ ticketTypeId: 3, qty: 2, paymentMethodId: 1 }] },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.items[0].paymentName, 'Наличка');

    const summary = await asCashier('/api/kassa/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.data.date, localParts().day);
    assert.equal(summary.data.orders[0].id, created.data.id, 'ең жаңа талон бірінші');
    assert.ok(summary.data.orders[0].code);
    const cash = summary.data.byPayment.find((p) => p.name === 'Наличка');
    assert.ok(cash.revenue >= 2 * 5000);
    assert.ok(summary.data.byType.length >= 3);
    assert.equal(summary.data.series, undefined, 'кассирге тек қорытынды');
  });

  test('кассир әкімші бөлігіне кіре алмайды (403, сессия сақталады)', async () => {
    for (const [path, method] of [
      ['/api/admin/reports', 'GET'],
      ['/api/admin/settings', 'GET'],
      ['/api/admin/types', 'POST'],
      ['/api/admin/queue/next', 'POST'],
      ['/api/admin/payment-methods', 'GET'],
      ['/api/admin/cashier-key/rotate', 'POST'],
    ]) {
      const res = await asCashier(path, { method, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 403, path);
      assert.equal(res.data.error, 'forbidden');
    }
    assert.equal((await asCashier('/api/kassa/session')).status, 200);
  });

  test('жаңа касса сілтемесі: ескі кілт пен кассир сессиялары өшеді, әкімші қалады', async () => {
    const { data: before } = await call('/api/admin/settings');
    const rotated = await call('/api/admin/cashier-key/rotate', { method: 'POST' });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.data.cashierKey, before.cashierKey);

    assert.equal((await asCashier('/api/kassa/session')).status, 401);
    assert.equal((await call('/api/auth/key', { method: 'POST', body: { key: before.cashierKey }, auth: false })).status, 401);
    assert.equal((await call('/api/kassa/session')).data.role, 'admin', 'әкімші де кассаны қолдана алады');
    assert.equal((await call('/api/admin/types')).status, 200, 'әкімші сессиясы өзгермейді');

    const fresh = await call('/api/auth/key', { method: 'POST', body: { key: rotated.data.cashierKey }, auth: false });
    assert.equal(fresh.data.role, 'cashier');
  });

  test('касса беті мен манифесі', async () => {
    for (const path of ['/kassa', '/kassa/', '/kassa/sales']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.ok((await res.text()).includes('kassa/main.js'), path);
    }
    const manifest = await (await fetch(`${base}/kassa/manifest.webmanifest`)).json();
    assert.equal(manifest.scope, '/kassa/');
    assert.equal(manifest.short_name, 'Касса');
  });
});

describe('кассирдің кезегі және «Қате билет»', () => {
  let cashier;
  const asCashier = (path, options = {}) => {
    const saved = token;
    token = cashier;
    return call(path, options).finally(() => {
      token = saved;
    });
  };

  test('кассир кезекті көреді, шақырады, қате деп белгілейді', async () => {
    const { data: s } = await call('/api/admin/settings');
    cashier = (await call('/api/auth/key', { method: 'POST', body: { key: s.cashierKey }, auth: false })).data.token;

    const order = (await asCashier('/api/kassa/orders', { method: 'POST', body: { items: [{ ticketTypeId: 1, qty: 1 }] } })).data;
    const queue = await asCashier('/api/kassa/queue');
    assert.equal(queue.status, 200);
    assert.ok(queue.data.waiting.some((o) => o.id === order.id));

    const next = await asCashier('/api/kassa/queue/next', { method: 'POST' });
    assert.equal(next.status, 200);

    const before = (await call('/api/admin/reports?period=day')).data.totals;
    const wrong = await asCashier(`/api/kassa/orders/${order.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
    assert.equal(wrong.status, 200);
    assert.equal(wrong.data.status, 'cancelled');
    const after = (await call('/api/admin/reports?period=day')).data.totals;
    assert.equal(after.revenue, before.revenue - 2000, '«Қате билет» есепке кірмейді');
    assert.equal(after.cancelled, before.cancelled + 1);
    assert.equal((await asCashier(`/api/kassa/orders/${order.id}`)).data.status, 'cancelled');
  });

  test('кассирге есепті тазалау жабық', async () => {
    assert.equal((await asCashier('/api/admin/report-orders?period=day')).status, 403);
    assert.equal((await asCashier('/api/admin/orders/delete', { method: 'POST', body: { ids: [1] } })).status, 403);
  });
});

describe('есепті тазалау (талондарды өшіру)', () => {
  test('кезеңдегі талондар тізімі', async () => {
    const res = await call('/api/admin/report-orders?period=day');
    assert.equal(res.status, 200);
    assert.ok(res.data.total >= 5);
    assert.equal(res.data.orders.length, Math.min(res.data.total, 300));
    const ids = res.data.orders.map((o) => o.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'ең жаңасы бірінші');
    assert.ok(res.data.orders[0].items.length > 0);
    assert.equal((await call('/api/admin/report-orders?period=year')).status, 400);
  });

  test('таңдалған талондарды өшіру — есептен де, клиенттен де жоғалады', async () => {
    const order = (await call('/api/kassa/orders', { method: 'POST', body: { items: [{ ticketTypeId: 3, qty: 2 }] } })).data;
    const before = (await call('/api/admin/reports?period=day')).data.totals;
    const res = await call('/api/admin/orders/delete', { method: 'POST', body: { ids: [order.id, order.id] } });
    assert.equal(res.status, 200);
    assert.equal(res.data.deleted, 1);
    const after = (await call('/api/admin/reports?period=day')).data.totals;
    assert.equal(after.revenue, before.revenue - 10000);
    assert.equal(after.orders, before.orders - 1);
    assert.equal((await call(`/api/public/orders/${order.code}`, { auth: false })).status, 404);
    for (const body of [{}, { ids: [] }, { ids: ['x'] }, { ids: [1.5] }]) {
      const bad = await call('/api/admin/orders/delete', { method: 'POST', body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal(bad.data.error, 'invalid_ids');
    }
  });

  test('«Барлығын таңдау»: бүкіл кезеңді өшіру, нөмірлеу қайта 1-ден', async () => {
    const res = await call('/api/admin/orders/delete', { method: 'POST', body: { all: true, period: 'day' } });
    assert.equal(res.status, 200);
    assert.ok(res.data.deleted > 0);
    const list = await call('/api/admin/report-orders?period=day');
    assert.equal(list.data.total, 0);
    const report = await call('/api/admin/reports?period=day');
    assert.equal(report.data.totals.revenue, 0);
    assert.equal(report.data.totals.cancelled, 0);
    const fresh = await call('/api/kassa/orders', { method: 'POST', body: { items: [{ ticketTypeId: 1, qty: 1 }] } });
    assert.equal(fresh.data.number, 1);
    await call('/api/admin/orders/delete', { method: 'POST', body: { ids: [fresh.data.id] } });
  });
});

describe('клиент телефонына хабарлама (Web Push)', () => {
  let pushServer;
  let pushBase;
  const received = [];
  const waitFor = async (predicate, ms = 3000) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > ms) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  };

  before(async () => {
    pushServer = http.createServer((req, res) => {
      received.push({ path: req.url, headers: req.headers });
      res.statusCode = req.url.includes('gone') ? 410 : 201;
      res.end();
    });
    await new Promise((resolve) => pushServer.listen(0, '127.0.0.1', resolve));
    pushBase = `http://127.0.0.1:${pushServer.address().port}`;
  });
  after(() => pushServer.close());

  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));
  const pending = async (endpoint) => (await call('/api/public/push/pending', { method: 'POST', body: { endpoint }, auth: false })).data.orders;

  test('жазылу: тек push қызметтері, тек ашық талон', async () => {
    const order = (await call('/api/kassa/orders', { method: 'POST', body: { items: [{ ticketTypeId: 1, qty: 1 }] } })).data;
    const sub = (endpoint, code = order.code) => call(`/api/public/orders/${code}/push`, { method: 'POST', body: { endpoint, lang: 'ru' }, auth: false });
    assert.equal((await sub('https://evil.example.com/x')).data.error, 'invalid_push');
    assert.equal((await sub('not a url')).data.error, 'invalid_push');
    assert.equal((await sub(`${pushBase}/push/x`, 'zzzzzzzzzz')).status, 404);
    assert.equal((await sub(`${pushBase}/push/x`)).status, 200);
    await call(`/api/kassa/orders/${order.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
    assert.equal((await sub(`${pushBase}/push/y`)).data.error, 'order_closed');
    await call('/api/admin/orders/delete', { method: 'POST', body: { ids: [order.id] } });
  });

  test('«Келесі — сіз» бір рет, «Кезегіңіз келді» әр шақыруда, ескірген жазылым өшеді', async () => {
    const info = (await call('/api/public/info', { auth: false })).data;
    assert.match(info.pushKey, /^[A-Za-z0-9_-]{87}$/, 'VAPID ашық кілті (65 байт)');
    const make = async () => (await call('/api/kassa/orders', { method: 'POST', body: { items: [{ ticketTypeId: 2, qty: 1 }] } })).data;
    const [a, b, c] = [await make(), await make(), await make()];
    const bEnd = `${pushBase}/push/b`;
    const cEnd = `${pushBase}/push/c-gone`;
    await call(`/api/public/orders/${b.code}/push`, { method: 'POST', body: { endpoint: bEnd, lang: 'ru' }, auth: false });
    await call(`/api/public/orders/${c.code}/push`, { method: 'POST', body: { endpoint: cEnd }, auth: false });
    received.length = 0;

    // a шақырылады → b кезекте бірінші → «Келесі — сіз»
    const first = await call('/api/kassa/queue/next', { method: 'POST' });
    assert.equal(first.data.called.id, a.id);
    assert.ok(await waitFor(() => received.some((r) => r.path === '/push/b')), 'b-ға push келді');
    assert.deepEqual(await pending(bEnd), [{ code: b.code, number: b.number, status: 'waiting', lang: 'ru' }]);

    // VAPID: қолтаңба ашық кілтпен тексеріледі
    const auth = received.find((r) => r.path === '/push/b').headers.authorization;
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
    assert.equal(k, info.pushKey);
    const [h64, p64, s64] = jwt.split('.');
    const key = await crypto.subtle.importKey('raw', b64(info.pushKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64(s64), new TextEncoder().encode(`${h64}.${p64}`)));
    const claims = JSON.parse(Buffer.from(p64, 'base64url').toString());
    assert.equal(claims.aud, pushBase);
    assert.ok(claims.exp > Date.now() / 1000 && claims.sub);
    assert.equal(received.find((r) => r.path === '/push/b').headers.ttl, '3600');

    // b шақырылады → «Кезегіңіз келді»; c бірінші → push 410 → жазылым өшеді
    received.length = 0;
    await call('/api/kassa/queue/next', { method: 'POST' });
    assert.ok(await waitFor(() => received.some((r) => r.path === '/push/b') && received.some((r) => r.path === '/push/c-gone')));
    assert.deepEqual(await pending(bEnd), [{ code: b.code, number: b.number, status: 'serving', lang: 'ru' }]);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      gone = (await pending(cEnd)).length === 0;
      if (!gone) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(gone, '410 — жазылым өшірілді');

    // Қайта шақыру → тағы хабарлама; «Келесі — сіз» қайталанбайды
    received.length = 0;
    await call(`/api/kassa/orders/${b.id}`, { method: 'PATCH', body: { status: 'serving' } });
    assert.ok(await waitFor(() => received.some((r) => r.path === '/push/b')));
    assert.equal(received.filter((r) => r.path === '/push/b').length, 1);

    await call('/api/admin/orders/delete', { method: 'POST', body: { ids: [a.id, b.id, c.id] } });
    assert.deepEqual(await pending(bEnd), []);
  });
});
