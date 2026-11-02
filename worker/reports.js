// Есептер (Cloudflare D1) — server/services/reports.js логикасымен бірдей.
import { badRequest } from '../server/errors.js';
import { daysInMonth, isDay, isMonth, localParts, nextMonth } from './time.js';
import { PAYMENT_REPORT_SQL, paymentBreakdown } from '../server/orderLines.js';

export function resolveRange(period, date, timeZone) {
  const now = localParts(timeZone);
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

function fillSeries(range, rows, timeZone) {
  const byKey = new Map(rows.map((r) => [String(r.k), r]));
  let keys = [];
  if (range.group === 'hour') {
    keys = Array.from({ length: 24 }, (_, h) => String(h));
  } else if (range.group === 'day') {
    keys = Array.from({ length: daysInMonth(range.date) }, (_, i) => `${range.date}-${String(i + 1).padStart(2, '0')}`);
  } else {
    const current = localParts(timeZone).month;
    const first = rows.length ? String(rows[0].k) : current;
    const last = rows.length && String(rows.at(-1).k) > current ? String(rows.at(-1).k) : current;
    for (let m = first; m <= last; m = nextMonth(m)) keys.push(m);
  }
  return keys.map((key) => {
    const r = byKey.get(key);
    return { key, orders: r?.orders ?? 0, people: r?.people ?? 0, revenue: r?.revenue ?? 0 };
  });
}

export async function buildReport(ctx, period = 'day', date) {
  const { db } = ctx;
  const range = resolveRange(period, date, ctx.tz);
  const bounds = range.from ? [range.from, range.to] : [];
  const inRange = range.from ? 'o.day BETWEEN ? AND ?' : '1 = 1';
  const valid = `${inRange} AND o.status != 'cancelled'`;
  const keyExpr = { hour: 'o.hour', day: 'o.day', month: 'substr(o.day, 1, 7)' }[range.group];

  const [totals, cancelled, sold, active, series, paid, methods] = await db.batch([
    db
      .prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(o.people), 0) AS people, COALESCE(SUM(o.total), 0) AS revenue FROM orders o WHERE ${valid}`)
      .bind(...bounds),
    db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${inRange} AND o.status = 'cancelled'`).bind(...bounds),
    db
      .prepare(
        `SELECT i.ticket_type_id AS id, COALESCE(t.name, i.name) AS name, t.color AS color, COALESCE(t.deleted, 1) AS deleted,
                SUM(i.qty) AS qty, SUM(i.qty * i.price) AS revenue, COUNT(DISTINCT o.id) AS orders
         FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN ticket_types t ON t.id = i.ticket_type_id
         WHERE ${valid}
         GROUP BY COALESCE(CAST(i.ticket_type_id AS TEXT), 'name:' || i.name)
         ORDER BY revenue DESC, qty DESC`,
      )
      .bind(...bounds),
    db.prepare('SELECT id, name, color FROM ticket_types WHERE deleted = 0 AND active = 1 ORDER BY sort, id'),
    db
      .prepare(`SELECT ${keyExpr} AS k, COUNT(*) AS orders, SUM(o.people) AS people, SUM(o.total) AS revenue FROM orders o WHERE ${valid} GROUP BY k ORDER BY k`)
      .bind(...bounds),
    // Төлем түрлері бойынша: Наличка / Каспий / Банк
    db.prepare(PAYMENT_REPORT_SQL(valid)).bind(...bounds),
    db.prepare('SELECT id, name FROM payment_methods WHERE deleted = 0 ORDER BY id'),
  ]);

  const t = totals.results[0];
  const soldIds = new Set(sold.results.map((r) => r.id));
  const unsold = active.results
    .filter((type) => !soldIds.has(type.id))
    .map((type) => ({ ...type, deleted: 0, qty: 0, revenue: 0, orders: 0 }));

  return {
    period: range.period,
    date: range.date,
    from: range.from,
    to: range.to,
    group: range.group,
    totals: { ...t, avgCheck: t.orders ? Math.round(t.revenue / t.orders) : 0, cancelled: cancelled.results[0].n },
    byType: [...sold.results, ...unsold].map((r) => ({ ...r, deleted: r.deleted === 1 })),
    byPayment: paymentBreakdown(paid.results, methods.results),
    series: fillSeries(range, series.results, ctx.tz),
  };
}
