// Тапсырыс жолдарына ортақ ережелер (өз сервер нұсқасы да, Cloudflare нұсқасы да қолданады).
import { badRequest } from './errors.js';

export const MAX_QTY = 999;

/**
 * Кассадан келген билеттерді тексеріп, (билет түрі, төлем түрі) жұбы бойынша біріктіреді.
 * Төлем түрі көрсетілмесе — әдепкісі (мысалы, Каспий) қойылады.
 * Билет түрі мен төлем түрінің бар-жоғын шақырушы өзі тексереді.
 * @param {unknown} items  [{ ticketTypeId, qty, paymentMethodId? }]
 * @param {{ defaultPayment?: number | null }} [options]
 * @returns {{ typeId: number, paymentMethodId: number | null, qty: number }[]}
 */
export function normalizeItems(items, { defaultPayment = null } = {}) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw badRequest('empty_order');
  const merged = new Map();
  for (const item of items) {
    const typeId = Number(item?.ticketTypeId);
    const qty = Number(item?.qty);
    const given = item?.paymentMethodId;
    const paymentMethodId = given === undefined || given === null || given === '' ? defaultPayment : Number(given);
    if (!Number.isInteger(typeId) || typeId <= 0) throw badRequest('invalid_ticket_type');
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) throw badRequest('invalid_qty');
    if (paymentMethodId !== null && (!Number.isInteger(paymentMethodId) || paymentMethodId <= 0)) {
      throw badRequest('invalid_payment_method');
    }
    if (qty === 0) continue;
    const key = `${typeId}:${paymentMethodId ?? ''}`;
    const line = merged.get(key);
    if (line) line.qty += qty;
    else merged.set(key, { typeId, paymentMethodId, qty });
  }
  if (merged.size === 0) throw badRequest('empty_order');
  const lines = [...merged.values()];
  if (lines.reduce((sum, line) => sum + line.qty, 0) > MAX_QTY) throw badRequest('invalid_qty');
  return lines;
}

/** Деректер базасындағы жол → API пішіні. */
export const toItem = (row) => ({
  ticketTypeId: row.ticket_type_id,
  name: row.name,
  price: row.price,
  qty: row.qty,
  color: row.color ?? null,
  paymentMethodId: row.payment_method_id ?? null,
  paymentName: row.payment_name ?? null,
});

/**
 * Клиентке көрсетілетін билеттер: бір түр әртүрлі төлеммен бөлінсе де бір жол болады,
 * төлем мәліметтері жария етілмейді.
 */
export function publicItems(items) {
  const merged = new Map();
  for (const { ticketTypeId, name, price, qty, color } of items) {
    const key = `${ticketTypeId ?? ''}|${name}|${price}`;
    const line = merged.get(key);
    if (line) line.qty += qty;
    else merged.set(key, { ticketTypeId, name, price, qty, color });
  }
  return [...merged.values()];
}

const MAX_PAYMENT_NAME = 40;

/** Төлем түрінің атауы: бос емес, 40 таңбаға дейін. */
export function paymentName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_PAYMENT_NAME) throw badRequest('invalid_name');
  return name;
}

/** Әдепкі төлем түрі: баптаудағысы жойылған болса — тізімдегі біріншісі. */
export function effectiveDefault(rows, saved) {
  const id = Number(saved);
  return rows.some((row) => row.id === id) ? id : (rows[0]?.id ?? null);
}

/** Төлем түрлерінің тізімі (кассадағы ретпен) және әдепкісі белгіленген. */
export function paymentList(rows, saved) {
  const def = effectiveDefault(rows, saved);
  return rows.map((row) => ({ id: row.id, name: row.name, isDefault: row.id === def }));
}

export const MAX_PAYMENT_METHODS = 12;

/**
 * Есептегі төлем түрлері: барлық белсенді түр (сатылмаса да, 0 деп) тұрақты ретпен,
 * кейін жойылған түрлер, соңында төлем түрі көрсетілмеген ескі тапсырыстар.
 * @param {{ id: number | null, name: string | null, deleted: number, qty: number, revenue: number, orders: number }[]} paid
 * @param {{ id: number, name: string }[]} active
 */
export function paymentBreakdown(paid, active) {
  const seen = new Set(paid.map((row) => row.id));
  const rows = [
    ...paid.map((row) => ({
      id: row.id ?? null,
      name: row.name ?? null,
      deleted: row.deleted === 1,
      qty: row.qty,
      revenue: row.revenue,
      orders: row.orders,
    })),
    ...active.filter((m) => !seen.has(m.id)).map((m) => ({ id: m.id, name: m.name, deleted: false, qty: 0, revenue: 0, orders: 0 })),
  ];
  const rank = (row) => (row.id === null ? 2 : row.deleted ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.id ?? 0) - (b.id ?? 0));
}

/** Төлем түрлері бойынша есептің SQL бөлігі (WHERE шарты шақырушыдан). */
export const PAYMENT_REPORT_SQL = (where) => `
  SELECT i.payment_method_id AS id, p.name AS name, COALESCE(p.deleted, 0) AS deleted,
         SUM(i.qty) AS qty, SUM(i.qty * i.price) AS revenue, COUNT(DISTINCT o.id) AS orders
  FROM order_items i
  JOIN orders o ON o.id = i.order_id
  LEFT JOIN payment_methods p ON p.id = i.payment_method_id
  WHERE ${where}
  GROUP BY i.payment_method_id`;
