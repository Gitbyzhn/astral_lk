import crypto from 'node:crypto';
import { badRequest, notFound } from '../errors.js';
import { localParts, nowIso, today } from '../time.js';

/** QR сілтемесіндегі код: шатастыратын таңбаларсыз (0/o, 1/l/i жоқ). */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 10;
const MAX_QTY = 999;
export const STATUSES = ['waiting', 'serving', 'done', 'cancelled'];

function randomCode() {
  // Rejection sampling: әр таңба бірдей ықтималдықпен шығуы үшін.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CODE_LENGTH * 2)) {
      if (byte < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return out;
}

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

const toItem = (row) => ({
  ticketTypeId: row.ticket_type_id,
  name: row.name,
  price: row.price,
  qty: row.qty,
  color: row.color ?? null,
});

/**
 * Тапсырыс (order) = бір кезек нөмірі + бір QR. Ішінде бірнеше билет түрі әртүрлі санмен болуы мүмкін:
 * мысалы 5 адамдық топ — 3 «Ересек» + 2 «Балалар», бәріне бір кезек.
 */
export function createOrders(db, { ttlHours = 12 } = {}) {
  const activeType = db.prepare('SELECT id, name, price FROM ticket_types WHERE id = ? AND deleted = 0 AND active = 1');
  const nextNumber = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM orders WHERE day = ?');
  const codeExists = db.prepare('SELECT 1 FROM orders WHERE code = ?');
  const insertOrder = db.prepare(`
    INSERT INTO orders (code, number, day, hour, people, total, created_at)
    VALUES (@code, @number, @day, @hour, @people, @total, @created_at)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, ticket_type_id, name, price, qty)
    VALUES (@order_id, @ticket_type_id, @name, @price, @qty)
  `);
  const byId = db.prepare('SELECT * FROM orders WHERE id = ?');
  const byCode = db.prepare('SELECT * FROM orders WHERE code = ?');
  const itemsFor = db.prepare(`
    SELECT i.*, t.color AS color
    FROM order_items i LEFT JOIN ticket_types t ON t.id = i.ticket_type_id
    WHERE i.order_id IN (SELECT value FROM json_each(?)) ORDER BY i.id
  `);
  const servingRows = db.prepare("SELECT * FROM orders WHERE status = 'serving' ORDER BY called_at, id");
  const waitingRows = db.prepare("SELECT * FROM orders WHERE status = 'waiting' ORDER BY id");
  const recentRows = db.prepare(`
    SELECT * FROM orders WHERE day = ? AND status IN ('done', 'cancelled')
    ORDER BY COALESCE(done_at, created_at) DESC, id DESC LIMIT 30
  `);
  const dayStats = db.prepare(`
    SELECT
      COUNT(*) AS orders,
      COALESCE(SUM(status = 'done'), 0) AS done,
      COALESCE(SUM(status != 'cancelled'), 0) AS valid,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN people END), 0) AS people,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total END), 0) AS revenue
    FROM orders WHERE day = ?
  `);
  const ahead = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(people), 0) AS people
    FROM orders WHERE status = 'waiting' AND id < ?
  `);
  const waitingCount = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'waiting'");
  const completeServing = db.prepare("UPDATE orders SET status = 'done', done_at = ? WHERE status = 'serving'");
  const firstWaiting = db.prepare("SELECT id FROM orders WHERE status = 'waiting' ORDER BY id LIMIT 1");
  const setServing = db.prepare("UPDATE orders SET status = 'serving', called_at = ?, done_at = NULL WHERE id = ?");
  const setWaiting = db.prepare("UPDATE orders SET status = 'waiting', called_at = NULL, done_at = NULL WHERE id = ?");
  const setClosed = db.prepare('UPDATE orders SET status = ?, done_at = ? WHERE id = ?');
  const expire = db.prepare(`
    UPDATE orders SET status = 'done', done_at = ?
    WHERE status IN ('waiting', 'serving') AND created_at < ?
  `);

  /** Бірнеше тапсырыстың билеттерін бір сұраумен жүктейді. */
  function hydrate(rows) {
    if (!rows.length) return [];
    const grouped = new Map(rows.map((r) => [r.id, []]));
    for (const item of itemsFor.all(JSON.stringify(rows.map((r) => r.id)))) {
      grouped.get(item.order_id).push(toItem(item));
    }
    return rows.map((r) => toOrder(r, grouped.get(r.id)));
  }

  const hydrateOne = (row) => (row ? hydrate([row])[0] : null);

  function getById(id) {
    const order = hydrateOne(byId.get(Number(id)));
    if (!order) throw notFound('order_not_found');
    return order;
  }

  function uniqueCode() {
    for (;;) {
      const code = randomCode();
      if (!codeExists.get(code)) return code;
    }
  }

  function parseItems(items) {
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
    const lines = [...merged].map(([id, qty]) => {
      const type = activeType.get(id);
      if (!type) throw badRequest('invalid_ticket_type', { ticketTypeId: id });
      return { ticket_type_id: id, name: type.name, price: type.price, qty };
    });
    const people = lines.reduce((s, l) => s + l.qty, 0);
    if (people > MAX_QTY) throw badRequest('invalid_qty');
    return { lines, people, total: lines.reduce((s, l) => s + l.qty * l.price, 0) };
  }

  const create = db.transaction((items) => {
    const { lines, people, total } = parseItems(items);
    const now = new Date();
    const { day, hour } = localParts(now);
    const info = insertOrder.run({
      code: uniqueCode(),
      number: nextNumber.get(day).n,
      day,
      hour,
      people,
      total,
      created_at: now.toISOString(),
    });
    for (const line of lines) insertItem.run({ order_id: info.lastInsertRowid, ...line });
    return getById(info.lastInsertRowid);
  });

  const callNext = db.transaction(() => {
    const now = nowIso();
    completeServing.run(now);
    const next = firstWaiting.get();
    if (!next) return null;
    setServing.run(now, next.id);
    return getById(next.id);
  });

  const setStatus = db.transaction((id, status) => {
    if (!STATUSES.includes(status)) throw badRequest('invalid_status');
    const order = getById(id);
    const now = nowIso();
    if (status === 'serving') {
      // Бір уақытта бір топ шақырылады: алдыңғысы аяқталды деп белгіленеді.
      completeServing.run(now);
      setServing.run(now, order.id);
    } else if (status === 'waiting') {
      setWaiting.run(order.id);
    } else {
      setClosed.run(status, now, order.id);
    }
    return getById(order.id);
  });

  return {
    create: (items) => create.immediate(items),
    get: getById,
    callNext: () => callNext.immediate(),
    setStatus: (id, status) => setStatus.immediate(id, status),

    /** Әкімшіге: қазір шақырылғандар, күтіп тұрғандар, бүгін жабылғандар және бүгінгі қысқа статистика. */
    queue() {
      return {
        serving: hydrate(servingRows.all()),
        waiting: hydrate(waitingRows.all()),
        recent: hydrate(recentRows.all(today())),
        today: dayStats.get(today()),
      };
    },

    /** Клиентке: тек өз талоны және кезектегі орны (басқалардың деректері берілмейді). */
    publicView(code) {
      const row = typeof code === 'string' ? byCode.get(code.toLowerCase()) : null;
      if (!row) throw notFound('order_not_found');
      const order = hydrateOne(row);
      const before = row.status === 'waiting' ? ahead.get(row.id) : { n: 0, people: 0 };
      const { id: _id, ...publicOrder } = order;
      return {
        order: publicOrder,
        queue: {
          ahead: before.n,
          aheadPeople: before.people,
          serving: servingRows.all().map((r) => r.number),
          waiting: waitingCount.get().n,
        },
      };
    },

    /** Залдағы экранға (табло): қазір кім шақырылды, кімдер келесі. */
    board() {
      return {
        serving: servingRows.all().map((r) => ({ number: r.number, people: r.people, calledAt: r.called_at })),
        next: waitingRows.all().slice(0, 12).map((r) => ({ number: r.number, people: r.people })),
        waiting: waitingCount.get().n,
      };
    },

    /** Ұмытылып қалған ескі талондарды жабады. Өзгеріс болса — саны қайтарылады. */
    expireStale() {
      const cutoff = new Date(Date.now() - ttlHours * 3_600_000).toISOString();
      return expire.run(nowIso(), cutoff).changes;
    },
  };
}
