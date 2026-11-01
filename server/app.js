import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ROOT_DIR, config } from './config.js';
import { HttpError } from './errors.js';
import { createAuth } from './auth.js';
import { createSettings } from './services/settings.js';
import { createTicketTypes } from './services/ticketTypes.js';
import { createOrders } from './services/orders.js';
import { createReports } from './services/reports.js';
import { buildManifest } from './manifest.js';

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

/** Компьютердің жергілікті желідегі IPv4 мекенжайлары (Wi-Fi арқылы телефоннан кіру үшін). */
export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);
}

function apiErrorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    if (err.details?.retryAfter) res.set('Retry-After', String(err.details.retryAfter));
    return res.status(err.status).json({ error: err.code, ...err.details });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
}

/**
 * Express қосымшасын құрастырады. Тесттерде `:memory:` базамен қолданылады.
 * @param {{ db: import('better-sqlite3').Database, events: ReturnType<typeof import('./events.js').createEventHub>, options?: Partial<typeof config> }} deps
 */
export function createApp({ db, events, options = {} }) {
  const opts = { ...config, ...options };
  const settings = createSettings(db, { timeZone: opts.timeZone, publicUrl: opts.publicUrl });
  const auth = createAuth({ settings, initialPassword: opts.initialPassword, sessionDays: opts.sessionDays });
  const types = createTicketTypes(db);
  const orders = createOrders(db, { ttlHours: opts.queueTtlHours });
  const reports = createReports(db);

  if (!settings.get('seeded')) {
    types.seedExamples();
    settings.set('seeded', '1');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy);
  app.use((_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  /* ------------------------------ API ------------------------------ */
  const api = express.Router();
  api.use(express.json({ limit: '32kb' }));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.get('/events', (req, res) => events.handler(req, res));

  // Клиент (жария) бөлігі
  api.get('/public/info', (_req, res) => res.json(settings.publicInfo()));
  api.get('/public/orders/:code', (req, res) =>
    res.json({ ...orders.publicView(req.params.code), business: settings.publicInfo() }),
  );
  api.get('/public/board', (_req, res) => res.json({ ...orders.board(), business: settings.publicInfo() }));

  // Кіру
  api.post('/auth/login', (req, res) => res.json(auth.login(req.body?.password, req.ip)));
  api.post('/auth/key', (req, res) => res.json(auth.loginWithKey(req.body?.key, req.ip)));

  // Әкімші (диспетчер) бөлігі — токен міндетті
  const admin = express.Router();
  admin.use(auth.require);

  admin.get('/session', (req, res) =>
    res.json({
      ok: true,
      passwordIsDefault: auth.isDefault(),
      // Әкімші бетін localhost арқылы ашса — телефондар үшін желідегі мекенжайды ұсынамыз
      lanUrls: lanAddresses().map((ip) => `http://${ip}:${req.socket.localPort}`),
    }),
  );

  admin.get('/types', (req, res) => res.json(types.list({ includeInactive: req.query.all === '1' })));
  admin.post('/types', (req, res) => {
    const type = types.create(req.body);
    events.emit('types');
    res.status(201).json(type);
  });
  admin.patch('/types/:id', (req, res) => {
    const type = types.update(req.params.id, req.body);
    events.emit('types');
    res.json(type);
  });
  admin.delete('/types/:id', (req, res) => {
    types.remove(req.params.id);
    events.emit('types');
    res.status(204).end();
  });
  admin.post('/types/reorder', (req, res) => {
    const list = types.reorder(req.body?.ids);
    events.emit('types');
    res.json(list);
  });

  admin.post('/orders', (req, res) => {
    const order = orders.create(req.body?.items);
    events.emit('queue');
    res.status(201).json(order);
  });
  admin.get('/orders/:id', (req, res) => res.json(orders.get(req.params.id)));
  admin.patch('/orders/:id', (req, res) => {
    const order = orders.setStatus(req.params.id, req.body?.status);
    events.emit('queue');
    res.json(order);
  });

  admin.get('/queue', (_req, res) => res.json(orders.queue()));
  admin.post('/queue/next', (_req, res) => {
    const called = orders.callNext();
    events.emit('queue');
    res.json({ called, ...orders.queue() });
  });

  admin.get('/reports', (req, res) => {
    const period = String(req.query.period ?? 'day');
    const date = req.query.date ? String(req.query.date) : undefined;
    res.json(reports.build(period, date));
  });

  admin.get('/settings', (_req, res) =>
    res.json({ ...settings.publicInfo(), passwordIsDefault: auth.isDefault(), adminKey: auth.adminKey() }),
  );
  admin.post('/admin-key/rotate', (_req, res) => res.json(auth.rotateAdminKey()));
  admin.patch('/settings', (req, res) => {
    const info = settings.update(req.body);
    events.emit('settings');
    res.json(info);
  });
  admin.post('/password', (req, res) => res.json(auth.changePassword(req.body?.current, req.body?.next, req.ip)));

  api.use('/admin', admin);
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  api.use(apiErrorHandler);
  app.use('/api', api);

  /* ------------------------- Статикалық файлдар ------------------------- */
  const sendPage = (res, file) =>
    res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC_DIR, file));

  const sendManifest = (kind) => (_req, res) =>
    res
      .type('application/manifest+json')
      .set('Cache-Control', 'no-cache')
      .send(JSON.stringify(buildManifest(kind, settings.publicInfo().businessName)));
  app.get('/manifest.webmanifest', sendManifest('client'));
  app.get('/admin/manifest.webmanifest', sendManifest('admin'));
  // Cloudflare нұсқасына арналған файл — өз серверде қажет емес
  app.get('/_headers', (_req, res) => res.status(404).end());
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      redirect: false,
      setHeaders(res, filePath) {
        const isIcon = filePath.includes(`${path.sep}icons${path.sep}`);
        res.setHeader('Cache-Control', isIcon ? 'public, max-age=604800' : 'no-cache');
      },
    }),
  );
  app.get('/admin{/*rest}', (_req, res) => sendPage(res, 'admin/index.html'));
  app.get(['/', '/t/:code', '/board'], (_req, res) => sendPage(res, 'index.html'));
  app.use((_req, res) => sendPage(res.status(404), 'index.html'));

  return { app, services: { settings, auth, types, orders, reports } };
}
