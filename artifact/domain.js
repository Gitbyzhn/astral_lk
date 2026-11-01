/**
 * Claude сілтемесі нұсқасының бизнес-логикасы (таза функциялар): билет түрлері, тапсырыстар, кезек,
 * есептер, клиенттерге арналған жария күй және QR ішіндегі талон коды.
 * Сервер нұсқасының (server/services/*) ережелерімен бірдей.
 */

export const STATUSES = ['waiting', 'serving', 'done', 'cancelled'];
export const TTL_MS = 12 * 3_600_000;
const MAX_QTY = 999;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 160;
const MAX_PRICE = 100_000_000;
const PALETTE = 8;

export class ApiError extends Error {
  constructor(status, code, data) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}
export const badRequest = (code) => new ApiError(400, code);
export const notFound = (code = 'not_found') => new ApiError(404, code);

/* ------------------------------- Идентификаторлар ------------------------------- */
const ALNUM = 'abcdefghjkmnpqrstuvwxyz23456789';
const LETTERS = 'abcdefghijkmnoqrstuvwxyz';

export function randomId(length, alphabet = ALNUM) {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let out = '';
  for (const v of values) out += alphabet[v % alphabet.length];
  return out;
}
/** Билет түрінің id-і тек әріптен — талон кодында «түр+саны+p+баға» деп бір жолға жазылады. */
export const newTypeId = () => randomId(4, LETTERS);
export const newOrderId = () => randomId(5);

/* ------------------------------------ Күндер ------------------------------------ */
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isDay = (s) => typeof s === 'string' && DAY_RE.test(s);
export const isMonth = (s) => typeof s === 'string' && MONTH_RE.test(s);

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export function shiftDay(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
/** ISO уақыт → бизнес уақыт белдеуіндегі күн мен сағат. */
export function localParts(iso, timeZone) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))) {
    parts[type] = value;
  }
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/* --------------------------------- Билет түрлері --------------------------------- */
export function typeList(catalog, { includeInactive = false } = {}) {
  return Object.entries(catalog?.types ?? {})
    .filter(([, t]) => !t.deleted && (includeInactive || t.active !== false))
    .map(([id, t]) => ({
      id,
      name: t.name,
      price: t.price,
      description: t.description ?? '',
      color: t.color ?? 0,
      active: t.active !== false,
      sort: t.sort ?? 0,
    }))
    .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}

export function parseTypeInput(body = {}, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > MAX_NAME) throw badRequest('invalid_name');
    out.name = name;
  }
  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) throw badRequest('invalid_price');
    out.price = price;
  }
  if (body.description !== undefined) {
    const description = String(body.description ?? '').trim();
    if (description.length > MAX_DESCRIPTION) throw badRequest('invalid_description');
    out.description = description;
  }
  if (body.color !== undefined) {
    const color = Number(body.color);
    if (!Number.isInteger(color) || color < 0 || color >= PALETTE) throw badRequest('invalid_color');
    out.color = color;
  }
  if (body.active !== undefined) out.active = Boolean(body.active);
  return out;
}

export function nextColor(catalog) {
  const used = Object.values(catalog?.types ?? {})
    .filter((t) => !t.deleted)
    .map((t) => t.color);
  for (let c = 0; c < PALETTE; c++) if (!used.includes(c)) return c;
  return used.length % PALETTE;
}

/* ---------------------------------- Тапсырыстар ---------------------------------- */
/**
 * Тапсырыс күн құжатында сақталады: days/<күн> → { orders: { <id>: запись } }.
 * запись = { n, hour, status, people, total, items: [[типId, саны, бағасы, атауы]], createdAt, calledAt, doneAt }
 */
export function parseOrderItems(items, catalog) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw badRequest('empty_order');
  const merged = new Map();
  for (const item of items) {
    const id = String(item?.ticketTypeId ?? '');
    const qty = Number(item?.qty);
    if (!/^[a-z]{1,12}$/.test(id)) throw badRequest('invalid_ticket_type');
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) throw badRequest('invalid_qty');
    if (qty > 0) merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  if (merged.size === 0) throw badRequest('empty_order');
  const lines = [...merged].map(([id, qty]) => {
    const type = catalog?.types?.[id];
    if (!type || type.deleted || type.active === false) throw badRequest('invalid_ticket_type');
    return [id, qty, type.price, type.name];
  });
  const people = lines.reduce((s, l) => s + l[1], 0);
  if (people > MAX_QTY) throw badRequest('invalid_qty');
  return { lines, people, total: lines.reduce((s, l) => s + l[1] * l[2], 0) };
}

/** Ұмытылып қалған (12 сағаттан ескі) ашық талондар жабық деп есептеледі. */
export function effectiveStatus(rec, now = Date.now()) {
  if ((rec.status === 'waiting' || rec.status === 'serving') && now - Date.parse(rec.createdAt) > TTL_MS) return 'done';
  return rec.status;
}

/** QR ішіндегі талон коды: «уақыт(минут,36)-нөмір-id-түрСАНЫpБАҒА-…» — тек латын әріп, сан, сызықша. */
export function encodeTicket(oid, rec) {
  const minutes = Math.floor(Date.parse(rec.createdAt) / 60_000).toString(36);
  const items = rec.items.map(([tid, qty, price]) => `${tid}${qty}p${price}`).join('-');
  return `${minutes}-${rec.n}-${oid}-${items}`;
}

export function decodeTicket(code) {
  const parts = String(code ?? '').toLowerCase().split('-');
  if (parts.length < 4) return null;
  const [minutesRaw, nRaw, oid, ...itemParts] = parts;
  const minutes = parseInt(minutesRaw, 36);
  const n = Number(nRaw);
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(n) || n <= 0 || !/^[a-z0-9]{5}$/.test(oid)) return null;
  const items = [];
  for (const part of itemParts) {
    const m = /^([a-z]{1,12})(\d{1,3})p(\d{1,9})$/.exec(part);
    if (!m) return null;
    items.push({ t: m[1], q: Number(m[2]), p: Number(m[3]) });
  }
  if (!items.length) return null;
  return { createdAt: new Date(minutes * 60_000).toISOString(), n, oid, items };
}

export function orderView(day, oid, rec, catalog, now = Date.now()) {
  return {
    id: `${day}:${oid}`,
    code: encodeTicket(oid, rec),
    number: rec.n,
    day,
    status: effectiveStatus(rec, now),
    people: rec.people,
    total: rec.total,
    createdAt: rec.createdAt,
    calledAt: rec.calledAt ?? null,
    doneAt: rec.doneAt ?? null,
    items: rec.items.map(([tid, qty, price, name]) => ({
      ticketTypeId: tid,
      name: name || catalog?.types?.[tid]?.name || '—',
      price,
      qty,
      color: catalog?.types?.[tid]?.color ?? null,
    })),
  };
}

/** Бақыланатын күндердің барлық тапсырыстары: [{ day, oid, rec }] */
export function collectOrders(days) {
  const out = [];
  for (const [day, doc] of Object.entries(days ?? {})) {
    for (const [oid, rec] of Object.entries(doc?.orders ?? {})) out.push({ day, oid, rec });
  }
  return out;
}

const byCreated = (a, b) => a.rec.createdAt.localeCompare(b.rec.createdAt) || a.rec.n - b.rec.n;

/** Кезек: шақырылғандар, күтудегілер, бүгін жабылғандар және бүгінгі қысқа статистика. */
export function queueState(days, catalog, today, now = Date.now()) {
  const all = collectOrders(days);
  const view = (o) => orderView(o.day, o.oid, o.rec, catalog, now);
  const status = (o) => effectiveStatus(o.rec, now);
  const serving = all
    .filter((o) => status(o) === 'serving')
    .sort((a, b) => String(a.rec.calledAt).localeCompare(String(b.rec.calledAt)))
    .map(view);
  const waiting = all.filter((o) => status(o) === 'waiting').sort(byCreated).map(view);
  const todays = all.filter((o) => o.day === today);
  const recent = todays
    .filter((o) => status(o) === 'done' || status(o) === 'cancelled')
    .sort((a, b) => String(b.rec.doneAt || b.rec.createdAt).localeCompare(String(a.rec.doneAt || a.rec.createdAt)))
    .slice(0, 30)
    .map(view);
  const valid = todays.filter((o) => o.rec.status !== 'cancelled');
  return {
    serving,
    waiting,
    recent,
    today: {
      orders: todays.length,
      done: todays.filter((o) => status(o) === 'done').length,
      valid: valid.length,
      people: valid.reduce((s, o) => s + o.rec.people, 0),
      revenue: valid.reduce((s, o) => s + o.rec.total, 0),
    },
  };
}

/* ------------------------------------ Есептер ------------------------------------ */
/** Бір күннің жиынтығы — stats/<күн> құжатына жазылады (есептер жылдам ашылуы үшін). */
export function aggregateDay(day, doc) {
  const agg = { day, month: day.slice(0, 7), o: 0, p: 0, r: 0, x: 0, h: {}, t: {} };
  for (const rec of Object.values(doc?.orders ?? {})) {
    if (rec.status === 'cancelled') {
      agg.x += 1;
      continue;
    }
    agg.o += 1;
    agg.p += rec.people;
    agg.r += rec.total;
    const hour = String(rec.hour ?? 0);
    const h = (agg.h[hour] ??= [0, 0, 0]);
    h[0] += 1;
    h[1] += rec.people;
    h[2] += rec.total;
    const seen = new Set();
    for (const [tid, qty, price, name] of rec.items) {
      const t = (agg.t[tid] ??= [0, 0, 0, name || '']);
      t[0] += qty;
      t[1] += qty * price;
      if (!seen.has(tid)) t[2] += 1;
      seen.add(tid);
    }
  }
  return agg;
}

/** Есеп: сервердегі /api/admin/reports жауабымен бірдей пішін. */
export function buildReport(period, date, aggregates, catalog, today) {
  let range;
  if (period === 'day') {
    const day = isDay(date) ? date : today;
    range = { period, date: day, from: day, to: day, group: 'hour' };
  } else if (period === 'month') {
    const month = isMonth(date) ? date : today.slice(0, 7);
    range = { period, date: month, from: `${month}-01`, to: `${month}-${daysInMonth(month)}`, group: 'day' };
  } else if (period === 'all') {
    range = { period, date: null, from: null, to: null, group: 'month' };
  } else {
    throw badRequest('invalid_period');
  }

  const inRange = aggregates.filter((a) => !range.from || (a.day >= range.from && a.day <= range.to));
  const totals = { orders: 0, people: 0, revenue: 0, cancelled: 0 };
  const types = new Map();
  for (const a of inRange) {
    totals.orders += a.o;
    totals.people += a.p;
    totals.revenue += a.r;
    totals.cancelled += a.x;
    for (const [tid, [qty, rev, orders, name]] of Object.entries(a.t ?? {})) {
      const t = types.get(tid) ?? { qty: 0, revenue: 0, orders: 0, name };
      t.qty += qty;
      t.revenue += rev;
      t.orders += orders;
      types.set(tid, t);
    }
  }

  const sold = [...types]
    .map(([id, t]) => {
      const type = catalog?.types?.[id];
      return {
        id,
        name: type?.name || t.name || id,
        color: type?.color ?? null,
        deleted: !type || Boolean(type.deleted),
        qty: t.qty,
        revenue: t.revenue,
        orders: t.orders,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty);
  const unsold = typeList(catalog)
    .filter((t) => !types.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, color: t.color, deleted: false, qty: 0, revenue: 0, orders: 0 }));

  let series;
  if (range.group === 'hour') {
    const h = inRange[0]?.h ?? {};
    series = Array.from({ length: 24 }, (_, i) => {
      const [o, p, r] = h[String(i)] ?? [0, 0, 0];
      return { key: String(i), orders: o, people: p, revenue: r };
    });
  } else if (range.group === 'day') {
    const byDay = new Map(inRange.map((a) => [a.day, a]));
    series = Array.from({ length: daysInMonth(range.date) }, (_, i) => {
      const key = `${range.date}-${String(i + 1).padStart(2, '0')}`;
      const a = byDay.get(key);
      return { key, orders: a?.o ?? 0, people: a?.p ?? 0, revenue: a?.r ?? 0 };
    });
  } else {
    const byMonth = new Map();
    for (const a of inRange) {
      const m = byMonth.get(a.month) ?? { orders: 0, people: 0, revenue: 0 };
      m.orders += a.o;
      m.people += a.p;
      m.revenue += a.r;
      byMonth.set(a.month, m);
    }
    const current = today.slice(0, 7);
    const months = [...byMonth.keys()].sort();
    const first = months[0] ?? current;
    const last = months.at(-1) > current ? months.at(-1) : current;
    series = [];
    for (let m = first; m <= last; m = nextMonth(m)) series.push({ key: m, ...(byMonth.get(m) ?? { orders: 0, people: 0, revenue: 0 }) });
  }

  return {
    ...range,
    totals: { ...totals, avgCheck: totals.orders ? Math.round(totals.revenue / totals.orders) : 0 },
    byType: [...sold, ...unsold],
    series,
  };
}

/* ------------------------- Клиенттерге арналған жария күй ------------------------- */
/**
 * Бетке салынатын шағын күй: Claude-қа кірмеген клиент те осыны көреді.
 * u — бүгінгі ең үлкен нөмір (жарияланған сәтте), open — күтудегілер [нөмір, адам],
 * serving — шақырылғандар [нөмір, уақыт], cancelled — болдырылмағандар.
 * Жаңа талондар үшін бетті қайта жариялау керек емес: нөмірі u-дан үлкен талонның
 * алдындағылар = open + (нөмір − u − 1).
 */
export function buildSnapshot({ days, catalog, settings, today, timeZone, now = Date.now() }) {
  let u = 0;
  const open = [];
  const serving = [];
  const cancelled = [];
  for (const rec of Object.values(days?.[today]?.orders ?? {})) {
    u = Math.max(u, rec.n);
    const status = effectiveStatus(rec, now);
    if (status === 'waiting') open.push([rec.n, rec.people]);
    else if (status === 'serving') serving.push([rec.n, rec.calledAt ?? null]);
    else if (status === 'cancelled') cancelled.push(rec.n);
  }
  open.sort((a, b) => a[0] - b[0]);
  serving.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  cancelled.sort((a, b) => a - b);
  const types = {};
  for (const [id, t] of Object.entries(catalog?.types ?? {})) types[id] = [t.name, t.color ?? 0];
  return { v: 1, day: today, u, open, serving, cancelled, types, business: settings?.businessName || 'Astral', tz: timeZone };
}

export const snapshotKey = (s) => JSON.stringify({ ...s, at: undefined });

/** Клиент талоны жария күй бойынша (Claude-қа кірмеген клиентке). */
export function publicFromSnapshot(code, snap) {
  const ticket = decodeTicket(code);
  if (!ticket) throw notFound('order_not_found');
  const timeZone = snap?.tz || 'Asia/Almaty';
  const { day } = localParts(ticket.createdAt, timeZone);
  const types = snap?.types ?? {};
  const items = ticket.items.map((it) => ({
    ticketTypeId: it.t,
    name: types[it.t]?.[0] || '—',
    price: it.p,
    qty: it.q,
    color: types[it.t]?.[1] ?? null,
  }));
  const open = snap?.open ?? [];
  let status = 'waiting';
  let ahead = 0;
  let aheadPeople = 0;
  let calledAt = null;
  let serving = [];

  if (!snap?.day || day > snap.day) {
    ahead = ticket.n - 1; // бүгін әлі ешкім шақырылмаған
    aheadPeople = null;
  } else if (day < snap.day) {
    status = 'done'; // басқа күннің талоны
  } else {
    serving = (snap.serving ?? []).map(([n]) => n);
    const called = (snap.serving ?? []).find(([n]) => n === ticket.n);
    if (ticket.n > snap.u) {
      ahead = open.length + (ticket.n - snap.u - 1);
      aheadPeople = ticket.n - snap.u - 1 > 0 ? null : open.reduce((s, [, p]) => s + p, 0);
    } else if (called) {
      status = 'serving';
      calledAt = called[1];
    } else if ((snap.cancelled ?? []).includes(ticket.n)) {
      status = 'cancelled';
    } else if (open.some(([n]) => n === ticket.n)) {
      const before = open.filter(([n]) => n < ticket.n);
      ahead = before.length;
      aheadPeople = before.reduce((s, [, p]) => s + p, 0);
    } else {
      status = 'done';
    }
  }

  return {
    order: {
      code,
      number: ticket.n,
      day,
      status,
      people: ticket.items.reduce((s, it) => s + it.q, 0),
      total: ticket.items.reduce((s, it) => s + it.q * it.p, 0),
      createdAt: ticket.createdAt,
      calledAt,
      doneAt: null,
      items,
    },
    queue: { ahead, aheadPeople, serving, waiting: open.length },
    business: { businessName: snap?.business || 'Astral' },
  };
}

export function boardFromSnapshot(snap) {
  return {
    serving: (snap?.serving ?? []).map(([number, calledAt]) => ({ number, people: 0, calledAt })),
    next: (snap?.open ?? []).slice(0, 12).map(([number, people]) => ({ number, people })),
    waiting: snap?.open?.length ?? 0,
    business: { businessName: snap?.business || 'Astral' },
  };
}
