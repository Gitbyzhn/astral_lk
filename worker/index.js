/**
 * Astral — Cloudflare Workers нұсқасы (тегін хостинг): статикалық беттер Workers Static Assets арқылы,
 * API және деректер — осы Worker + D1 (SQLite). Сервер нұсқасының API-імен бірдей жолдар мен жауаптар;
 * айырмашылығы — нақты уақыттағы жаңарту SSE емес, /api/public/version сұрауы (әр 10 с).
 */
import { HttpError, notFound } from '../server/errors.js';
import { buildManifest } from '../server/manifest.js';
import { SECURITY_HEADERS, errorResponse, json, readBody } from './http.js';
import { ensureReady, getSettings, setSetting, bump, versions } from './data.js';
import { changePassword, login, loginWithKey, requireRole, rotateAdminKey, rotateCashierKey } from './auth.js';
import { createType, listTypes, removeType, reorderTypes, updateType } from './types.js';
import { createPayment, listPayments, removePayment, updatePayment } from './payments.js';
import { board, callNext, createOrder, dayOrders, getOrder, listRange, publicView, queueState, removeOrders, setStatus } from './orders.js';
import { buildReport, resolveRange } from './reports.js';
import { notifyQueue, pendingPush, subscribePush } from './push.js';
import { deleteTarget } from '../server/orderLines.js';

const DEFAULT_BUSINESS = 'Astral Labyrinth';

function publicInfo(settings, ctx) {
  return {
    businessName: settings.get('business_name') || DEFAULT_BUSINESS,
    timeZone: ctx.tz,
    publicUrl: ctx.env.PUBLIC_URL || null,
    realtime: 'poll',
    // Клиент телефонына хабарлама жазылымы үшін (VAPID ашық кілті)
    pushKey: settings.get('vapid_public') || null,
  };
}

async function updateSettings(ctx, settings, body) {
  if (body?.businessName === undefined) return publicInfo(settings, ctx);
  const name = String(body.businessName ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) throw new HttpError(400, 'invalid_business_name');
  await ctx.db.batch([setSetting(ctx.db, 'business_name', name), bump(ctx.db, 'settings')]);
  settings.set('business_name', name);
  return publicInfo(settings, ctx);
}

/** Кассаға бір күннің қорытындысы: қай билет қанша, қандай төлеммен, және сол күнгі талондар. */
async function kassaSummary(ctx, date) {
  const { date: day, totals, byType, byPayment } = await buildReport(ctx, 'day', date);
  return { date: day, totals, byType, byPayment, orders: await dayOrders(ctx.db, day) };
}

const createOrderRoute = async (ctx, _p, request) => [201, await createOrder(ctx, (await readBody(request)).items)];

/** Кезек өзгергеннен кейін клиенттерге хабарлама — жауапты күттірмей (waitUntil). */
const notify = (ctx, calledId = null) => ctx.waitUntil(notifyQueue(ctx, { calledId }).catch((err) => console.error('push', err?.message ?? err)));

const queueNextRoute = async (ctx) => {
  const result = await callNext(ctx);
  notify(ctx, result.called?.id ?? null);
  return result;
};

const patchOrderRoute = async (ctx, [id], request) => {
  const order = await setStatus(ctx, id, (await readBody(request)).status);
  notify(ctx, order.status === 'serving' ? order.id : null);
  return order;
};

const range = (ctx, url) => resolveRange(url.searchParams.get('period') ?? 'day', url.searchParams.get('date') ?? undefined, ctx.tz);

/**
 * API маршруттары: [әдіс, үлгі, өңдеуші(ctx, params, request, url, auth), кімге]
 *   кімге: жоқ — бәріне, 'staff' — әкімші мен кассир, 'admin' — тек әкімші. auth = { settings, role }
 */
const ROUTES = [
  ['GET', /^\/api\/health$/, () => ({ ok: true })],
  ['GET', /^\/api\/public\/version$/, (ctx) => versions(ctx.db)],
  ['GET', /^\/api\/public\/info$/, async (ctx) => publicInfo(await getSettings(ctx.db), ctx)],
  ['GET', /^\/api\/public\/board$/, async (ctx) => ({ ...(await board(ctx)), business: publicInfo(await getSettings(ctx.db), ctx) })],
  [
    'GET',
    /^\/api\/public\/orders\/([^/]+)$/,
    async (ctx, [code]) => ({ ...(await publicView(ctx, decodeURIComponent(code))), business: publicInfo(await getSettings(ctx.db), ctx) }),
  ],
  // Клиенттің телефонына хабарлама: «Хабарлау» басқанда жазылу, service worker push алғанда — не болғанын сұрау
  ['POST', /^\/api\/public\/orders\/([^/]+)\/push$/, async (ctx, [code], request) => subscribePush(ctx, decodeURIComponent(code), await readBody(request))],
  ['POST', /^\/api\/public\/push\/pending$/, async (ctx, _p, request) => pendingPush(ctx, (await readBody(request)).endpoint)],
  ['POST', /^\/api\/auth\/login$/, async (ctx, _p, request) => login(ctx, (await readBody(request)).password)],
  ['POST', /^\/api\/auth\/key$/, async (ctx, _p, request) => loginWithKey(ctx, (await readBody(request)).key)],

  // Касса: әкімші де, кассир де (касса сілтемесі арқылы кірген)
  ['GET', /^\/api\/kassa\/session$/, (_ctx, _p, _r, _u, a) => ({ ok: true, role: a.role }), 'staff'],
  [
    'GET',
    /^\/api\/kassa\/catalog$/,
    async (ctx, _p, _r, _u, a) => {
      const [types, paymentMethods] = await Promise.all([listTypes(ctx.db), listPayments(ctx.db, a.settings)]);
      return { types, paymentMethods, defaultPaymentMethodId: paymentMethods.find((m) => m.isDefault)?.id ?? null };
    },
    'staff',
  ],
  ['POST', /^\/api\/kassa\/orders$/, createOrderRoute, 'staff'],
  // Кезек: «Келесіні шақыру», «Аяқтау», «Қате билет» — әкімші де, кассир де
  ['GET', /^\/api\/kassa\/queue$/, (ctx) => queueState(ctx), 'staff'],
  ['POST', /^\/api\/kassa\/queue\/next$/, queueNextRoute, 'staff'],
  ['GET', /^\/api\/kassa\/orders\/([^/]+)$/, (ctx, [id]) => getOrder(ctx.db, id), 'staff'],
  ['PATCH', /^\/api\/kassa\/orders\/([^/]+)$/, patchOrderRoute, 'staff'],
  ['GET', /^\/api\/kassa\/summary$/, (ctx, _p, _r, url) => kassaSummary(ctx, url.searchParams.get('date') ?? undefined), 'staff'],

  // Әкімші
  ['GET', /^\/api\/admin\/session$/, (ctx, _p, _r, _u, a) => ({ ok: true, passwordIsDefault: a.settings.get('password_is_default') === '1', lanUrls: [] }), 'admin'],
  ['GET', /^\/api\/admin\/types$/, (ctx, _p, _r, url) => listTypes(ctx.db, { includeInactive: url.searchParams.get('all') === '1' }), 'admin'],
  ['POST', /^\/api\/admin\/types$/, async (ctx, _p, request) => [201, await createType(ctx.db, await readBody(request))], 'admin'],
  ['POST', /^\/api\/admin\/types\/reorder$/, async (ctx, _p, request) => reorderTypes(ctx.db, (await readBody(request)).ids), 'admin'],
  ['PATCH', /^\/api\/admin\/types\/([^/]+)$/, async (ctx, [id], request) => updateType(ctx.db, id, await readBody(request)), 'admin'],
  ['DELETE', /^\/api\/admin\/types\/([^/]+)$/, async (ctx, [id]) => (await removeType(ctx.db, id), [204, null]), 'admin'],
  ['GET', /^\/api\/admin\/payment-methods$/, (ctx, _p, _r, _u, a) => listPayments(ctx.db, a.settings), 'admin'],
  ['POST', /^\/api\/admin\/payment-methods$/, async (ctx, _p, request, _u, a) => [201, await createPayment(ctx.db, a.settings, await readBody(request))], 'admin'],
  ['PATCH', /^\/api\/admin\/payment-methods\/([^/]+)$/, async (ctx, [id], request, _u, a) => updatePayment(ctx.db, a.settings, id, await readBody(request)), 'admin'],
  ['DELETE', /^\/api\/admin\/payment-methods\/([^/]+)$/, async (ctx, [id]) => (await removePayment(ctx.db, id), [204, null]), 'admin'],
  // Ескі жолдар (әкімші ғана) — жаңалары /kassa/... астында
  ['POST', /^\/api\/admin\/orders$/, createOrderRoute, 'admin'],
  ['GET', /^\/api\/admin\/orders\/([^/]+)$/, (ctx, [id]) => getOrder(ctx.db, id), 'admin'],
  ['PATCH', /^\/api\/admin\/orders\/([^/]+)$/, patchOrderRoute, 'admin'],
  ['GET', /^\/api\/admin\/queue$/, (ctx) => queueState(ctx), 'admin'],
  ['POST', /^\/api\/admin\/queue\/next$/, queueNextRoute, 'admin'],
  // Есепті тазалау: кезеңдегі талондар тізімі және оларды біржола өшіру
  ['GET', /^\/api\/admin\/report-orders$/, (ctx, _p, _r, url) => listRange(ctx.db, range(ctx, url)), 'admin'],
  [
    'POST',
    /^\/api\/admin\/orders\/delete$/,
    async (ctx, _p, request) => ({ deleted: await removeOrders(ctx.db, deleteTarget(await readBody(request), (p, d) => resolveRange(p, d, ctx.tz))) }),
    'admin',
  ],
  ['GET', /^\/api\/admin\/reports$/, (ctx, _p, _r, url) => buildReport(ctx, url.searchParams.get('period') ?? 'day', url.searchParams.get('date') ?? undefined), 'admin'],
  [
    'GET',
    /^\/api\/admin\/settings$/,
    (ctx, _p, _r, _u, { settings: s }) => ({
      ...publicInfo(s, ctx),
      passwordIsDefault: s.get('password_is_default') === '1',
      adminKey: s.get('admin_key'),
      cashierKey: s.get('cashier_key'),
    }),
    'admin',
  ],
  ['PATCH', /^\/api\/admin\/settings$/, async (ctx, _p, request, _u, a) => updateSettings(ctx, a.settings, await readBody(request)), 'admin'],
  ['POST', /^\/api\/admin\/admin-key\/rotate$/, (ctx, _p, _r, _u, a) => rotateAdminKey(ctx, a.settings), 'admin'],
  ['POST', /^\/api\/admin\/cashier-key\/rotate$/, (ctx, _p, _r, _u, a) => rotateCashierKey(ctx, a.settings), 'admin'],
  [
    'POST',
    /^\/api\/admin\/password$/,
    async (ctx, _p, request, _u, a) => {
      const body = await readBody(request);
      return changePassword(ctx, a.settings, body.current, body.next);
    },
    'admin',
  ],
];

async function handleApi(request, env, url, execution) {
  const ctx = {
    env,
    db: env.DB,
    tz: env.APP_TIMEZONE || 'Asia/Almaty',
    ip: request.headers.get('CF-Connecting-IP') || 'local',
    origin: url.origin,
    waitUntil: (promise) => (execution?.waitUntil ? execution.waitUntil(promise) : promise),
  };
  for (const [method, pattern, handler, access] of ROUTES) {
    const match = pattern.exec(url.pathname);
    if (!match || method !== request.method) continue;
    const auth = access ? await requireRole(ctx, request, access) : null;
    const result = await handler(ctx, match.slice(1), request, url, auth);
    const [status, body] = Array.isArray(result) && typeof result[0] === 'number' ? result : [200, result];
    return json(body, status);
  }
  throw notFound();
}

/** Клиент/әкімші/касса қосымшасының HTML қабығы (History API жолдары үшін). */
async function shell(env, url, path, status = 200) {
  const page = await env.ASSETS.fetch(new Request(new URL(path, url)));
  const headers = new Headers(page.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  headers.set('Cache-Control', 'no-cache');
  return new Response(page.body, { status, headers });
}

const MANIFESTS = {
  '/manifest.webmanifest': 'client',
  '/admin/manifest.webmanifest': 'admin',
  '/kassa/manifest.webmanifest': 'kassa',
};

const under = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export default {
  async fetch(request, env, execution) {
    const url = new URL(request.url);
    try {
      await ensureReady(env);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url, execution);

      const manifest = MANIFESTS[url.pathname];
      if (manifest) {
        const settings = await getSettings(env.DB);
        return new Response(JSON.stringify(buildManifest(manifest, settings.get('business_name') || DEFAULT_BUSINESS)), {
          headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS },
        });
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        if (under(url.pathname, '/admin')) return await shell(env, url, '/admin/');
        if (under(url.pathname, '/kassa')) return await shell(env, url, '/kassa/');
        if (url.pathname.startsWith('/t/') || url.pathname === '/board') return await shell(env, url, '/');
        return await shell(env, url, '/', 404);
      }
      throw notFound();
    } catch (err) {
      return errorResponse(err);
    }
  },
};
