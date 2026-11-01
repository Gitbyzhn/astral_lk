import { badRequest } from '../errors.js';
import { daysInMonth, isDay, isMonth, localParts, nextMonth } from '../time.js';

/** Кезең → күндер аралығы және графиктің топтау қадамы. */
function resolveRange(period, date) {
  const now = localParts();
  switch (period) {
    case 'day': {
      const day = isDay(date) ? date : now.day;
      return { period, date: day, from: day, to: day, group: 'hour' };
    }
    case 'month': {
      const month = isMonth(date) ? date : now.month;
      return { period, date: month, from: `${month}-01`, to: `${month}-${daysInMonth(month)}`, group: 'day' };
    }
    case 'all':
      return { period, date: null, from: null, to: null, group: 'month' };
    default:
      throw badRequest('invalid_period');
  }
}

/** Бос сағат/күн/айларды нөлмен толтырады — график үзіліссіз болуы үшін. */
function fillSeries(range, rows) {
  const byKey = new Map(rows.map((r) => [String(r.k), r]));
  let keys = [];
  if (range.group === 'hour') {
    keys = Array.from({ length: 24 }, (_, h) => String(h));
  } else if (range.group === 'day') {
    const month = range.date;
    keys = Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  } else {
    const current = localParts().month;
    const first = rows.length ? String(rows[0].k) : current;
    const last = rows.length && String(rows.at(-1).k) > current ? String(rows.at(-1).k) : current;
    for (let m = first; m <= last; m = nextMonth(m)) keys.push(m);
  }
  return keys.map((key) => {
    const r = byKey.get(key);
    return { key, orders: r?.orders ?? 0, people: r?.people ?? 0, revenue: r?.revenue ?? 0 };
  });
}

/** Есептер: күндік / айлық / жалпы. Болдырылмаған (cancelled) тапсырыстар есепке кірмейді. */
export function createReports(db) {
  return {
    build(period = 'day', date) {
      const range = resolveRange(period, date);
      const params = range.from ? { from: range.from, to: range.to } : {};
      const inRange = range.from ? 'o.day BETWEEN @from AND @to' : '1 = 1';
      const valid = `${inRange} AND o.status != 'cancelled'`;

      const totals = db
        .prepare(
          `SELECT COUNT(*) AS orders, COALESCE(SUM(o.people), 0) AS people, COALESCE(SUM(o.total), 0) AS revenue
           FROM orders o WHERE ${valid}`,
        )
        .get(params);

      const cancelled = db
        .prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${inRange} AND o.status = 'cancelled'`)
        .get(params).n;

      const sold = db
        .prepare(
          `SELECT i.ticket_type_id AS id,
                  COALESCE(t.name, i.name) AS name,
                  t.color AS color,
                  COALESCE(t.deleted, 1) AS deleted,
                  SUM(i.qty) AS qty,
                  SUM(i.qty * i.price) AS revenue,
                  COUNT(DISTINCT o.id) AS orders
           FROM order_items i
           JOIN orders o ON o.id = i.order_id
           LEFT JOIN ticket_types t ON t.id = i.ticket_type_id
           WHERE ${valid}
           GROUP BY COALESCE(CAST(i.ticket_type_id AS TEXT), 'name:' || i.name)
           ORDER BY revenue DESC, qty DESC`,
        )
        .all(params);

      // Белсенді, бірақ бұл кезеңде сатылмаған түрлер де көрінсін (0 деп).
      const soldIds = new Set(sold.map((r) => r.id));
      const unsold = db
        .prepare('SELECT id, name, color FROM ticket_types WHERE deleted = 0 AND active = 1 ORDER BY sort, id')
        .all()
        .filter((t) => !soldIds.has(t.id))
        .map((t) => ({ ...t, deleted: 0, qty: 0, revenue: 0, orders: 0 }));

      const keyExpr = { hour: 'o.hour', day: 'o.day', month: 'substr(o.day, 1, 7)' }[range.group];
      const seriesRows = db
        .prepare(
          `SELECT ${keyExpr} AS k, COUNT(*) AS orders, SUM(o.people) AS people, SUM(o.total) AS revenue
           FROM orders o WHERE ${valid} GROUP BY k ORDER BY k`,
        )
        .all(params);

      return {
        period: range.period,
        date: range.date,
        from: range.from,
        to: range.to,
        group: range.group,
        totals: {
          ...totals,
          avgCheck: totals.orders ? Math.round(totals.revenue / totals.orders) : 0,
          cancelled,
        },
        byType: [...sold, ...unsold].map((r) => ({ ...r, deleted: r.deleted === 1 })),
        series: fillSeries(range, seriesRows),
      };
    },
  };
}
