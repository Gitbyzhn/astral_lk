/**
 * Claude сілтемесі нұсқасындағы «API»: беттер сервердегідей api('/admin/...') шақырады,
 * ал мұнда жауап Claude деректер базасынан (әкімші) немесе бетке салынған жария күйден (клиент) құрылады.
 * Жауаптардың пішіні server/app.js-тегімен бірдей — беттердің коды өзгермейді.
 */
import { todayKey } from '../public/assets/js/core/format.js';
import { runtime } from './runtime.js';
import { data, mergeDoc, readStats, scheduleStats, watchedDays, withLock } from './store.js';
import { embeddedSnapshot, markDirty } from './publisher.js';
import {
  ApiError,
  STATUSES,
  aggregateDay,
  badRequest,
  boardFromSnapshot,
  buildReport,
  effectiveStatus,
  localParts,
  newOrderId,
  newTypeId,
  nextColor,
  notFound,
  orderView,
  parseOrderItems,
  parseTypeInput,
  publicFromSnapshot,
  queueState,
  typeList,
  decodeTicket,
  isDay,
  isMonth,
} from './domain.js';

export { ApiError };

/** Сервер нұсқасымен үйлесімділік үшін (мұнда кіру Claude аккаунты арқылы). */
export const auth = { token: null, onUnauthorized() {} };

const isAdmin = () => runtime.isAdmin && runtime.db !== null;
const timeZone = () => data.settings.timeZone || 'Asia/Almaty';
const nowIso = () => new Date().toISOString();

function info() {
  if (isAdmin()) {
    return { businessName: data.settings.businessName || 'Astral Labyrinth', timeZone: timeZone(), publicUrl: data.settings.publicUrl || null };
  }
  const snap = embeddedSnapshot();
  return { businessName: snap?.business || 'Astral Labyrinth', timeZone: snap?.tz || 'Asia/Almaty', publicUrl: null };
}

/* ------------------------------------ Түрлер ------------------------------------ */
function getType(id) {
  const type = data.catalog.types?.[id];
  if (!type || type.deleted) throw notFound('ticket_type_not_found');
  return typeList(data.catalog, { includeInactive: true }).find((t) => t.id === id);
}

async function createType(body) {
  const input = parseTypeInput(body, { partial: false });
  const id = newTypeId();
  const maxSort = Math.max(-1, ...Object.values(data.catalog.types).map((t) => t.sort ?? 0));
  const record = {
    name: input.name,
    price: input.price,
    description: input.description ?? '',
    color: input.color ?? nextColor(data.catalog),
    active: input.active ?? true,
    sort: maxSort + 1,
    deleted: false,
    createdAt: nowIso(),
  };
  await mergeDoc('meta/catalog', { types: { [id]: record } }, data.catalog);
  markDirty();
  return getType(id);
}

async function updateType(id, body) {
  getType(id);
  const input = parseTypeInput(body, { partial: true });
  if (Object.keys(input).length) {
    await mergeDoc('meta/catalog', { types: { [id]: input } }, data.catalog);
    markDirty();
  }
  return getType(id);
}

async function removeType(id) {
  getType(id);
  await mergeDoc('meta/catalog', { types: { [id]: { deleted: true, active: false } } }, data.catalog);
  markDirty();
  return null;
}

async function reorderTypes(ids) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !data.catalog.types[id])) throw badRequest('invalid_order');
  const patch = { types: Object.fromEntries(ids.map((id, index) => [id, { sort: index }])) };
  await mergeDoc('meta/catalog', patch, data.catalog);
  return typeList(data.catalog, { includeInactive: true });
}

/* ---------------------------------- Тапсырыстар ---------------------------------- */
function findOrder(id) {
  const [day, oid] = String(id).split(':');
  const rec = data.days[day]?.orders?.[oid];
  if (!rec) throw notFound('order_not_found');
  return { day, oid, rec };
}

const view = ({ day, oid }) => orderView(day, oid, data.days[day].orders[oid], data.catalog);

async function patchOrders(changes) {
  // changes: [{ day, oid, patch }] — бір күн құжатына бір жазу
  const byDay = new Map();
  for (const { day, oid, patch } of changes) {
    const orders = byDay.get(day) ?? {};
    orders[oid] = { ...(orders[oid] ?? {}), ...patch };
    byDay.set(day, orders);
  }
  await Promise.all(
    [...byDay].map(async ([day, orders]) => {
      await mergeDoc(`days/${day}`, { day, orders }, data.days[day]);
      scheduleStats(day);
    }),
  );
}

async function createOrder(items) {
  const { lines, people, total } = parseOrderItems(items, data.catalog);
  const createdAt = nowIso();
  const { day, hour } = localParts(createdAt, timeZone());
  const oid = newOrderId();
  await withLock('meta/lock', async () => {
    // Нөмірді деректер базасындағы ең соңғы күйден есептейміз (басқа құрылғы да беріп жатуы мүмкін)
    const fresh = await runtime.db.doc(`days/${day}`).get();
    const orders = fresh.exists ? fresh.data().orders ?? {} : {};
    const local = data.days[day]?.orders ?? {};
    const n = Math.max(0, ...Object.values(orders).map((o) => o.n), ...Object.values(local).map((o) => o.n)) + 1;
    const rec = { n, hour, status: 'waiting', people, total, items: lines, createdAt, calledAt: null, doneAt: null };
    data.days[day] ??= { day, orders: {} };
    await mergeDoc(`days/${day}`, { day, orders: { [oid]: rec } }, data.days[day]);
  });
  scheduleStats(day);
  return view({ day, oid });
}

function liveOrders() {
  const now = Date.now();
  const all = [];
  for (const day of watchedDays()) {
    for (const [oid, rec] of Object.entries(data.days[day]?.orders ?? {})) all.push({ day, oid, rec, status: effectiveStatus(rec, now) });
  }
  return all;
}

async function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw badRequest('invalid_status');
  const target = findOrder(id);
  const now = nowIso();
  const changes = [];
  if (status === 'serving') {
    // Бір уақытта бір топ шақырылады: алдыңғысы аяқталды деп белгіленеді
    for (const o of liveOrders()) {
      if (o.status === 'serving' && !(o.day === target.day && o.oid === target.oid)) changes.push({ day: o.day, oid: o.oid, patch: { status: 'done', doneAt: now } });
    }
    changes.push({ day: target.day, oid: target.oid, patch: { status: 'serving', calledAt: now, doneAt: null } });
  } else if (status === 'waiting') {
    changes.push({ day: target.day, oid: target.oid, patch: { status: 'waiting', calledAt: null, doneAt: null } });
  } else {
    changes.push({ day: target.day, oid: target.oid, patch: { status, doneAt: now } });
  }
  await patchOrders(changes);
  markDirty();
  return view(target);
}

async function callNext() {
  const now = nowIso();
  const live = liveOrders();
  const changes = live.filter((o) => o.status === 'serving').map((o) => ({ day: o.day, oid: o.oid, patch: { status: 'done', doneAt: now } }));
  const next = live
    .filter((o) => o.status === 'waiting')
    .sort((a, b) => a.rec.createdAt.localeCompare(b.rec.createdAt) || a.rec.n - b.rec.n)[0];
  if (next) changes.push({ day: next.day, oid: next.oid, patch: { status: 'serving', calledAt: now, doneAt: null } });
  if (changes.length) {
    await patchOrders(changes);
    markDirty();
  }
  return { called: next ? view(next) : null, ...queueState(data.days, data.catalog, todayKey()) };
}

/* ------------------------------------ Есептер ------------------------------------ */
async function report(period, date) {
  if (!['day', 'month', 'all'].includes(period)) throw badRequest('invalid_period');
  const today = todayKey();
  const filter =
    period === 'day' ? { day: isDay(date) ? date : today } : period === 'month' ? { month: isMonth(date) ? date : today.slice(0, 7) } : null;
  const watched = watchedDays();
  const stored = filter?.day && watched.includes(filter.day) ? [] : await readStats(filter);
  const byDay = new Map(stored.map((a) => [a.day, a]));
  // Бақыланатын күндер (бүгін, кеше) үшін ең жаңа деректі қолданамыз — жиынтық 1–2 с кешігуі мүмкін
  for (const day of watched) {
    const doc = data.days[day];
    if (!doc) continue;
    const inScope = !filter || (filter.day ? day === filter.day : day.startsWith(filter.month));
    if (inScope) byDay.set(day, aggregateDay(day, doc));
  }
  return buildReport(period, date, [...byDay.values()], data.catalog, today);
}

/* ------------------------------------ Баптаулар ------------------------------------ */
async function updateSettings(body) {
  const patch = {};
  if (body?.businessName !== undefined) {
    const name = String(body.businessName ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60) throw badRequest('invalid_business_name');
    patch.businessName = name;
  }
  if (body?.publicUrl !== undefined) {
    const url = String(body.publicUrl ?? '').trim();
    if (url && (!/^https?:\/\/\S+$/i.test(url) || url.length > 500)) throw badRequest('invalid_public_url');
    patch.publicUrl = url.replace(/#.*$/, '');
  }
  await mergeDoc('meta/settings', patch, data.settings);
  markDirty();
  return info();
}

/* ----------------------------------- Маршруттар ----------------------------------- */
function requireAdmin() {
  if (!isAdmin()) throw new ApiError(401, 'unauthorized');
}

function publicOrder(code) {
  if (isAdmin()) {
    const ticket = decodeTicket(code);
    const day = ticket && localParts(ticket.createdAt, timeZone()).day;
    const rec = ticket && data.days[day]?.orders?.[ticket.oid];
    if (rec) {
      const order = orderView(day, ticket.oid, rec, data.catalog);
      const live = liveOrders();
      const before = live.filter((o) => o.status === 'waiting' && o.rec.createdAt < rec.createdAt);
      const { id: _id, ...publicOrder } = order;
      return {
        order: { ...publicOrder, code },
        queue: {
          ahead: order.status === 'waiting' ? before.length : 0,
          aheadPeople: order.status === 'waiting' ? before.reduce((s, o) => s + o.rec.people, 0) : 0,
          serving: live.filter((o) => o.status === 'serving').map((o) => o.rec.n),
          waiting: live.filter((o) => o.status === 'waiting').length,
        },
        business: { businessName: info().businessName },
      };
    }
  }
  return publicFromSnapshot(code, embeddedSnapshot());
}

function board() {
  if (!isAdmin()) return boardFromSnapshot(embeddedSnapshot());
  const state = queueState(data.days, data.catalog, todayKey());
  return {
    serving: state.serving.map((o) => ({ number: o.number, people: o.people, calledAt: o.calledAt })),
    next: state.waiting.slice(0, 12).map((o) => ({ number: o.number, people: o.people })),
    waiting: state.waiting.length,
    business: { businessName: info().businessName },
  };
}

async function route(method, path, body) {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const parts = pathname.split('/').filter(Boolean);

  if (pathname === '/public/info') return info();
  if (pathname === '/public/board') return board();
  if (parts[0] === 'public' && parts[1] === 'orders' && parts[2]) return publicOrder(decodeURIComponent(parts[2]));

  // Касса беті (/kassa/...): мұнда кассир рөлі мен төлем түрлері жоқ — әкімшінің өзі сатады
  if (parts[0] === 'kassa') {
    requireAdmin();
    const section = parts[1];
    if (section === 'session' && method === 'GET') return { ok: true, role: 'admin' };
    if (section === 'catalog' && method === 'GET') return { types: typeList(data.catalog), paymentMethods: [], defaultPaymentMethodId: null };
    if (section === 'orders' && !parts[2] && method === 'POST') return createOrder(body?.items);
    if (section === 'orders' && parts[2] && method === 'GET') return view(findOrder(decodeURIComponent(parts[2])));
    if (section === 'orders' && parts[2] && method === 'PATCH') return setStatus(decodeURIComponent(parts[2]), body?.status);
    if (section === 'queue' && !parts[2] && method === 'GET') return queueState(data.days, data.catalog, todayKey());
    if (section === 'queue' && parts[2] === 'next' && method === 'POST') return callNext();
    if (section === 'summary' && method === 'GET') {
      const day = await report('day', params.get('date') ?? undefined);
      return { date: day.date, totals: day.totals, byType: day.byType, byPayment: [], orders: [] };
    }
    throw notFound();
  }

  if (parts[0] !== 'admin') throw notFound();
  requireAdmin();
  const [, section, id] = parts;

  if (section === 'session') return { ok: true, passwordIsDefault: false, lanUrls: [] };
  if (section === 'settings') {
    if (method === 'GET') return { ...info(), passwordIsDefault: false };
    if (method === 'PATCH') return updateSettings(body);
  }
  if (section === 'types') {
    if (id === 'reorder' && method === 'POST') return reorderTypes(body?.ids);
    if (!id && method === 'GET') return typeList(data.catalog, { includeInactive: params.get('all') === '1' });
    if (!id && method === 'POST') return createType(body);
    if (id && method === 'PATCH') return updateType(id, body);
    if (id && method === 'DELETE') return removeType(id);
  }
  if (section === 'orders') {
    if (!id && method === 'POST') return createOrder(body?.items);
    if (id && method === 'GET') return view(findOrder(decodeURIComponent(id)));
    if (id && method === 'PATCH') return setStatus(decodeURIComponent(id), body?.status);
  }
  if (section === 'queue') {
    if (!id && method === 'GET') return queueState(data.days, data.catalog, todayKey());
    if (id === 'next' && method === 'POST') return callNext();
  }
  if (section === 'reports' && method === 'GET') return report(params.get('period') ?? 'day', params.get('date') ?? undefined);
  throw notFound();
}

/** Сервердегі api() функциясымен бірдей интерфейс. */
export async function api(path, { method = 'GET', body } = {}) {
  try {
    return await route(method, path, body);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const code = err?.code;
    console.warn('api', path, code, err?.message ?? err);
    if (code === 'quota_exceeded') throw new ApiError(507, 'quota_exceeded');
    throw new ApiError(0, 'network');
  }
}
