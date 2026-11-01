/**
 * Astral — Cloudflare Workers нұсқасы (тегін хостинг): статикалық беттер Workers Static Assets арқылы,
 * API және деректер — осы Worker + D1 (SQLite). Сервер нұсқасының API-імен бірдей жолдар мен жауаптар;
 * айырмашылығы — нақты уақыттағы жаңарту SSE емес, /api/public/version сұрауы (әр 10 с).
 */
import { HttpError, notFound } from '../server/errors.js';
import { buildManifest } from '../server/manifest.js';
import { SECURITY_HEADERS, errorResponse, json, readBody } from './http.js';
import { ensureReady, getSettings, setSetting, bump, versions } from './data.js';
import { changePassword, login, loginWithKey, requireAdmin, rotateAdminKey } from './auth.js';
import { createType, listTypes, removeType, reorderTypes, updateType } from './types.js';
import { board, callNext, createOrder, getOrder, publicView, queueState, setStatus } from './orders.js';
import { buildReport } from './reports.js';

const DEFAULT_BUSINESS = 'Astral';

function publicInfo(settings, ctx) {
  return {
    businessName: settings.get('business_name') || DEFAULT_BUSINESS,
    timeZone: ctx.tz,
    publicUrl: ctx.env.PUBLIC_URL || null,
    realtime: 'poll',
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

/** API маршруттары: [әдіс, үлгі, өңдеуші(ctx, params, request, url)] */
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
  ['POST', /^\/api\/auth\/login$/, async (ctx, _p, request) => login(ctx, (await readBody(request)).password)],
  ['POST', /^\/api\/auth\/key$/, async (ctx, _p, request) => loginWithKey(ctx, (await readBody(request)).key)],

  // Әкімші — токен міндетті (admin: true)
  ['GET', /^\/api\/admin\/session$/, (ctx, _p, _r, _u, s) => ({ ok: true, passwordIsDefault: s.get('password_is_default') === '1', lanUrls: [] }), true],
  ['GET', /^\/api\/admin\/types$/, (ctx, _p, _r, url) => listTypes(ctx.db, { includeInactive: url.searchParams.get('all') === '1' }), true],
  ['POST', /^\/api\/admin\/types$/, async (ctx, _p, request) => [201, await createType(ctx.db, await readBody(request))], true],
  ['POST', /^\/api\/admin\/types\/reorder$/, async (ctx, _p, request) => reorderTypes(ctx.db, (await readBody(request)).ids), true],
  ['PATCH', /^\/api\/admin\/types\/([^/]+)$/, async (ctx, [id], request) => updateType(ctx.db, id, await readBody(request)), true],
  ['DELETE', /^\/api\/admin\/types\/([^/]+)$/, async (ctx, [id]) => (await removeType(ctx.db, id), [204, null]), true],
  ['POST', /^\/api\/admin\/orders$/, async (ctx, _p, request) => [201, await createOrder(ctx, (await readBody(request)).items)], true],
  ['GET', /^\/api\/admin\/orders\/([^/]+)$/, (ctx, [id]) => getOrder(ctx.db, id), true],
  ['PATCH', /^\/api\/admin\/orders\/([^/]+)$/, async (ctx, [id], request) => setStatus(ctx, id, (await readBody(request)).status), true],
  ['GET', /^\/api\/admin\/queue$/, (ctx) => queueState(ctx), true],
  ['POST', /^\/api\/admin\/queue\/next$/, (ctx) => callNext(ctx), true],
  ['GET', /^\/api\/admin\/reports$/, (ctx, _p, _r, url) => buildReport(ctx, url.searchParams.get('period') ?? 'day', url.searchParams.get('date') ?? undefined), true],
  [
    'GET',
    /^\/api\/admin\/settings$/,
    (ctx, _p, _r, _u, s) => ({ ...publicInfo(s, ctx), passwordIsDefault: s.get('password_is_default') === '1', adminKey: s.get('admin_key') }),
    true,
  ],
  ['PATCH', /^\/api\/admin\/settings$/, async (ctx, _p, request, _u, s) => updateSettings(ctx, s, await readBody(request)), true],
  ['POST', /^\/api\/admin\/admin-key\/rotate$/, (ctx, _p, _r, _u, s) => rotateAdminKey(ctx, s), true],
  [
    'POST',
    /^\/api\/admin\/password$/,
    async (ctx, _p, request, _u, s) => {
      const body = await readBody(request);
      return changePassword(ctx, s, body.current, body.next);
    },
    true,
  ],
];

async function handleApi(request, env, url) {
  const ctx = {
    env,
    db: env.DB,
    tz: env.APP_TIMEZONE || 'Asia/Almaty',
    ip: request.headers.get('CF-Connecting-IP') || 'local',
  };
  for (const [method, pattern, handler, isAdmin] of ROUTES) {
    const match = pattern.exec(url.pathname);
    if (!match || method !== request.method) continue;
    const settings = isAdmin ? await requireAdmin(ctx, request) : null;
    const result = await handler(ctx, match.slice(1), request, url, settings);
    const [status, body] = Array.isArray(result) && typeof result[0] === 'number' ? result : [200, result];
    return json(body, status);
  }
  throw notFound();
}

/** Клиент/әкімші қосымшасының HTML қабығы (History API жолдары үшін). */
async function shell(env, url, path, status = 200) {
  const page = await env.ASSETS.fetch(new Request(new URL(path, url)));
  const headers = new Headers(page.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  headers.set('Cache-Control', 'no-cache');
  return new Response(page.body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      await ensureReady(env);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);

      if (url.pathname === '/manifest.webmanifest' || url.pathname === '/admin/manifest.webmanifest') {
        const settings = await getSettings(env.DB);
        const kind = url.pathname.startsWith('/admin') ? 'admin' : 'client';
        return new Response(JSON.stringify(buildManifest(kind, settings.get('business_name') || DEFAULT_BUSINESS)), {
          headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS },
        });
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await shell(env, url, '/admin/');
        if (url.pathname.startsWith('/t/') || url.pathname === '/board') return await shell(env, url, '/');
        return await shell(env, url, '/', 404);
      }
      throw notFound();
    } catch (err) {
      return errorResponse(err);
    }
  },
};
