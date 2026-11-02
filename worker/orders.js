// Тапсырыстар мен кезек (Cloudflare D1) — server/services/orders.js логикасымен бірдей.
// D1-де интерактивті транзакция жоқ, сондықтан әр әрекет бір batch (атомарлы) ретінде жазылады.
import { badRequest, notFound } from '../server/errors.js';
import { effectiveDefault, normalizeItems, publicItems, toItem } from '../server/orderLines.js';
import { localParts, nowIso } from './time.js';
import { randomString } from './http.js';
import { bump } from './data.js';

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const STATUSES = ['waiting', 'serving', 'done', 'cancelled'];
const TTL_MS = 12 * 3_600_000;

const toOrder = (row, items = []) => ({
  id: row.id,
  code: row.code,
  number: row.number,
  day: row.day,
  status: row.status,
  people: row.people,
  total: row.total,
  createdAt: row.created_at,
  calledAt: row.called_at,
  doneAt: row.done_at,
  items,
});

const ITEMS_SQL = `SELECT i.*, t.color AS color, p.name AS payment_name
  FROM order_items i
  LEFT JOIN ticket_types t ON t.id = i.ticket_type_id
  LEFT JOIN payment_methods p ON p.id = i.payment_method_id`;

function attach(rows, items) {
  const grouped = new Map(rows.map((r) => [r.id, []]));
  for (const item of items) grouped.get(item.order_id)?.push(toItem(item));
  return rows.map((r) => toOrder(r, grouped.get(r.id) ?? []));
}

async function hydrate(db, rows) {
  if (!rows.length) return [];
  const { results } = await db.prepare(`${ITEMS_SQL} WHERE i.order_id IN (SELECT value FROM json_each(?)) ORDER BY i.id`).bind(JSON.stringify(rows.map((r) => r.id))).all();
  return attach(rows, results);
}

export async function getOrder(db, id) {
  const row = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(Number(id) || 0).first();
  if (!row) throw notFound('order_not_found');
  return (await hydrate(db, [row]))[0];
}

/* ---------------- Ұмытылған ескі талондарды жабу (изолятта минутына бір рет) ---------------- */
let lastExpire = 0;
async function expireStale(db) {
  if (Date.now() - lastExpire < 60_000) return;
  lastExpire = Date.now();
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  const result = await db
    .prepare("UPDATE orders SET status = 'done', done_at = ? WHERE status IN ('waiting', 'serving') AND created_at < ?")
    .bind(nowIso(), cutoff)
    .run();
  if (result.meta.changes) await bump(db, 'queue').run();
  // Жабылған талондардың хабарлама жазылымдары керек емес
  await db.prepare("DELETE FROM push_subscriptions WHERE order_id NOT IN (SELECT id FROM orders WHERE status IN ('waiting', 'serving'))").run();
}

/* ------------------------------------ Жасау ------------------------------------ */
export async function createOrder(ctx, items) {
  const { db } = ctx;
  // Бір сұраумен: белсенді билет түрлері, төлем түрлері және әдепкі төлем түрі
  const [typesRes, methodsRes, savedRes] = await db.batch([
    db.prepare('SELECT id, name, price FROM ticket_types WHERE deleted = 0 AND active = 1'),
    db.prepare('SELECT id, name FROM payment_methods WHERE deleted = 0 ORDER BY id'),
    db.prepare("SELECT value FROM settings WHERE key = 'default_payment_method'"),
  ]);
  const methods = methodsRes.results;
  const activeMethods = new Set(methods.map((m) => m.id));
  const byId = new Map(typesRes.results.map((t) => [t.id, t]));
  const lines = normalizeItems(items, { defaultPayment: effectiveDefault(methods, savedRes.results[0]?.value) }).map((line) => {
    const type = byId.get(line.typeId);
    if (!type) throw badRequest('invalid_ticket_type', { ticketTypeId: line.typeId });
    if (line.paymentMethodId !== null && !activeMethods.has(line.paymentMethodId)) throw badRequest('invalid_payment_method');
    return { id: type.id, name: type.name, price: type.price, qty: line.qty, payment: line.paymentMethodId };
  });
  const people = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);

  const now = new Date();
  const { day, hour } = localParts(ctx.tz, now);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomString(10, CODE_ALPHABET);
    try {
      // Нөмір сол транзакцияның ішінде есептеледі — қатар келген сұраулар қайталанбайды (UNIQUE(day, number))
      await db.batch([
        db
          .prepare(
            `INSERT INTO orders (code, number, day, hour, people, total, created_at)
             VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM orders WHERE day = ?), ?, ?, ?, ?, ?)`,
          )
          .bind(code, day, day, hour, people, total, now.toISOString()),
        ...lines.map((l) =>
          db
            .prepare(
              `INSERT INTO order_items (order_id, ticket_type_id, name, price, qty, payment_method_id)
               VALUES ((SELECT id FROM orders WHERE code = ?), ?, ?, ?, ?, ?)`,
            )
            .bind(code, l.id, l.name, l.price, l.qty, l.payment),
        ),
        bump(db, 'queue'),
      ]);
      const row = await db.prepare('SELECT * FROM orders WHERE code = ?').bind(code).first();
      return (await hydrate(db, [row]))[0];
    } catch (err) {
      if (attempt === 2 || !/UNIQUE/i.test(String(err?.message))) throw err;
    }
  }
}

/* ------------------------------------- Кезек ------------------------------------- */
export async function setStatus(ctx, id, status) {
  const { db } = ctx;
  if (!STATUSES.includes(status)) throw badRequest('invalid_status');
  const order = await getOrder(db, id);
  const now = nowIso();
  const stmts = [];
  if (status === 'serving') {
    // Бір уақытта бір топ шақырылады: алдыңғысы аяқталды деп белгіленеді
    stmts.push(db.prepare("UPDATE orders SET status = 'done', done_at = ? WHERE status = 'serving' AND id != ?").bind(now, order.id));
    stmts.push(db.prepare("UPDATE orders SET status = 'serving', called_at = ?, done_at = NULL WHERE id = ?").bind(now, order.id));
  } else if (status === 'waiting') {
    stmts.push(db.prepare("UPDATE orders SET status = 'waiting', called_at = NULL, done_at = NULL WHERE id = ?").bind(order.id));
  } else {
    stmts.push(db.prepare('UPDATE orders SET status = ?, done_at = ? WHERE id = ?').bind(status, now, order.id));
  }
  stmts.push(bump(db, 'queue'));
  await db.batch(stmts);
  return getOrder(db, order.id);
}

export async function callNext(ctx) {
  const { db } = ctx;
  await expireStale(db);
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE orders SET status = 'done', done_at = ? WHERE status = 'serving'").bind(now),
    db
      .prepare(
        `UPDATE orders SET status = 'serving', called_at = ?, done_at = NULL
         WHERE id = (SELECT id FROM orders WHERE status = 'waiting' ORDER BY id LIMIT 1)`,
      )
      .bind(now),
    bump(db, 'queue'),
  ]);
  const called = await db.prepare("SELECT * FROM orders WHERE status = 'serving' AND called_at = ? ORDER BY id LIMIT 1").bind(now).first();
  return { called: called ? (await hydrate(db, [called]))[0] : null, ...(await queueState(ctx)) };
}

/** Әкімшіге: шақырылғандар, күтудегілер, бүгін жабылғандар және бүгінгі қысқа статистика. */
export async function queueState(ctx) {
  const { db } = ctx;
  await expireStale(db);
  const today = localParts(ctx.tz).day;
  const recentSql = `SELECT * FROM orders WHERE day = ? AND status IN ('done', 'cancelled')
                     ORDER BY COALESCE(done_at, created_at) DESC, id DESC LIMIT 30`;
  const [serving, waiting, recent, stats, items] = await db.batch([
    db.prepare("SELECT * FROM orders WHERE status = 'serving' ORDER BY called_at, id"),
    db.prepare("SELECT * FROM orders WHERE status = 'waiting' ORDER BY id"),
    db.prepare(recentSql).bind(today),
    db
      .prepare(
        `SELECT COUNT(*) AS orders,
                COALESCE(SUM(status = 'done'), 0) AS done,
                COALESCE(SUM(status != 'cancelled'), 0) AS valid,
                COALESCE(SUM(CASE WHEN status != 'cancelled' THEN people END), 0) AS people,
                COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total END), 0) AS revenue
         FROM orders WHERE day = ?`,
      )
      .bind(today),
    db
      .prepare(
        `${ITEMS_SQL} WHERE i.order_id IN (
           SELECT id FROM orders WHERE status IN ('waiting', 'serving')
           UNION SELECT id FROM (${recentSql}))
         ORDER BY i.id`,
      )
      .bind(today),
  ]);
  return {
    serving: attach(serving.results, items.results),
    waiting: attach(waiting.results, items.results),
    recent: attach(recent.results, items.results),
    today: stats.results[0],
  };
}

/** Кассаға: бір күннің тапсырыстары (ең жаңасы бірінші) — QR-ды қайта көрсету үшін. */
export async function dayOrders(db, day) {
  const { results } = await db.prepare('SELECT * FROM orders WHERE day = ? ORDER BY id DESC LIMIT 100').bind(day).all();
  return hydrate(db, results);
}

/** Клиентке: тек өз талоны және кезектегі орны. */
export async function publicView(ctx, code) {
  const { db } = ctx;
  if (typeof code !== 'string' || code.length > 40) throw notFound('order_not_found');
  await expireStale(db);
  const row = await db.prepare('SELECT * FROM orders WHERE code = ?').bind(code.toLowerCase()).first();
  if (!row) throw notFound('order_not_found');
  const [items, ahead, serving, waiting] = await db.batch([
    db.prepare(`${ITEMS_SQL} WHERE i.order_id = ? ORDER BY i.id`).bind(row.id),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS people FROM orders WHERE status = 'waiting' AND id < ?").bind(row.id),
    db.prepare("SELECT number FROM orders WHERE status = 'serving' ORDER BY called_at, id"),
    db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'waiting'"),
  ]);
  const { id: _id, items: lines, ...order } = toOrder(row, items.results.map(toItem));
  const before = row.status === 'waiting' ? ahead.results[0] : { n: 0, people: 0 };
  return {
    order: { ...order, items: publicItems(lines) },
    queue: {
      ahead: before.n,
      aheadPeople: before.people,
      serving: serving.results.map((r) => r.number),
      waiting: waiting.results[0].n,
    },
  };
}

/** Залдағы экранға (табло). */
export async function board(ctx) {
  const { db } = ctx;
  await expireStale(db);
  const [serving, next, waiting] = await db.batch([
    db.prepare("SELECT number, people, called_at FROM orders WHERE status = 'serving' ORDER BY called_at, id"),
    db.prepare("SELECT number, people FROM orders WHERE status = 'waiting' ORDER BY id LIMIT 12"),
    db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'waiting'"),
  ]);
  return {
    serving: serving.results.map((r) => ({ number: r.number, people: r.people, calledAt: r.called_at })),
    next: next.results.map((r) => ({ number: r.number, people: r.people })),
    waiting: waiting.results[0].n,
  };
}

/* ------------------------------ Есепті тазалау ------------------------------ */
const rangeWhere = (range) => (range.from ? 'day BETWEEN ? AND ?' : '1 = 1');
const rangeArgs = (range) => (range.from ? [range.from, range.to] : []);

/** Есеп кезеңіндегі талондар (ең жаңасы бірінші). */
export async function listRange(db, range, limit = 300) {
  const where = rangeWhere(range);
  const args = rangeArgs(range);
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${where}`).bind(...args),
    db.prepare(`SELECT * FROM orders WHERE ${where} ORDER BY id DESC LIMIT ${Number(limit) | 0}`).bind(...args),
  ]);
  return { total: count.results[0].n, orders: await hydrate(db, rows.results) };
}

/** Талондарды біржола өшіру: тізім бойынша ({ ids }) немесе бүкіл кезеңді ({ range }). */
export async function removeOrders(db, { ids, range }) {
  const where = range ? rangeWhere(range) : 'id IN (SELECT value FROM json_each(?))';
  const args = range ? rangeArgs(range) : [JSON.stringify(ids)];
  const results = await db.batch([
    db.prepare(`DELETE FROM push_subscriptions WHERE order_id IN (SELECT id FROM orders WHERE ${where})`).bind(...args),
    db.prepare(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE ${where})`).bind(...args),
    db.prepare(`DELETE FROM orders WHERE ${where}`).bind(...args),
    bump(db, 'queue'),
  ]);
  return results[2].meta.changes;
}
