// Тапсырыстар мен кезек (Cloudflare D1) — server/services/orders.js логикасымен бірдей.
// D1-де интерактивті транзакция жоқ, сондықтан әр әрекет бір batch (атомарлы) ретінде жазылады.
import { badRequest, notFound } from '../server/errors.js';
import { localParts, nowIso } from './time.js';
import { randomString } from './http.js';
import { bump } from './data.js';

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_QTY = 999;
const STATUSES = ['waiting', 'serving', 'done', 'cancelled'];
const TTL_MS = 12 * 3_600_000;

const toItem = (row) => ({ ticketTypeId: row.ticket_type_id, name: row.name, price: row.price, qty: row.qty, color: row.color ?? null });
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

const ITEMS_SQL = `SELECT i.*, t.color AS color FROM order_items i LEFT JOIN ticket_types t ON t.id = i.ticket_type_id`;

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
}

/* ------------------------------------ Жасау ------------------------------------ */
export async function createOrder(ctx, items) {
  const { db } = ctx;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw badRequest('empty_order');
  const merged = new Map();
  for (const item of items) {
    const id = Number(item?.ticketTypeId);
    const qty = Number(item?.qty);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('invalid_ticket_type');
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) throw badRequest('invalid_qty');
    if (qty > 0) merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  if (merged.size === 0) throw badRequest('empty_order');

  const { results: types } = await db
    .prepare('SELECT id, name, price FROM ticket_types WHERE deleted = 0 AND active = 1 AND id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...merged.keys()]))
    .all();
  const byId = new Map(types.map((t) => [t.id, t]));
  const lines = [...merged].map(([id, qty]) => {
    const type = byId.get(id);
    if (!type) throw badRequest('invalid_ticket_type', { ticketTypeId: id });
    return { id, name: type.name, price: type.price, qty };
  });
  const people = lines.reduce((s, l) => s + l.qty, 0);
  if (people > MAX_QTY) throw badRequest('invalid_qty');
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
            .prepare('INSERT INTO order_items (order_id, ticket_type_id, name, price, qty) VALUES ((SELECT id FROM orders WHERE code = ?), ?, ?, ?, ?)')
            .bind(code, l.id, l.name, l.price, l.qty),
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
  const { id: _id, ...order } = toOrder(row, items.results.map(toItem));
  const before = row.status === 'waiting' ? ahead.results[0] : { n: 0, people: 0 };
  return {
    order,
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
