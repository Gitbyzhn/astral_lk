// Клиент телефонына хабарлама (Web Push, Cloudflare D1) — server/services/push.js логикасымен бірдей.
import { badRequest, notFound } from '../server/errors.js';
import { PUSH_HOSTS, pushLang, sendPush, validEndpoint, vapidSubject } from '../server/webpush.js';
import { nowIso } from './time.js';

const MAX_PER_ORDER = 10;

/** «Хабарлау» басқанда: құрылғыны талонға жазу. */
export async function subscribePush(ctx, code, body) {
  const endpoint = validEndpoint(body?.endpoint, { hosts: PUSH_HOSTS });
  if (!endpoint) throw badRequest('invalid_push');
  if (typeof code !== 'string' || code.length > 40) throw notFound('order_not_found');
  const order = await ctx.db.prepare('SELECT id, status FROM orders WHERE code = ?').bind(code.toLowerCase()).first();
  if (!order) throw notFound('order_not_found');
  if (order.status !== 'waiting' && order.status !== 'serving') throw badRequest('order_closed');
  const { n } = await ctx.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE order_id = ?').bind(order.id).first();
  if (n >= MAX_PER_ORDER) throw badRequest('invalid_push');
  await ctx.db
    .prepare(
      `INSERT INTO push_subscriptions (order_id, endpoint, lang, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (order_id, endpoint) DO UPDATE SET lang = excluded.lang`,
    )
    .bind(order.id, endpoint, pushLang(body?.lang), nowIso())
    .run();
  return { ok: true };
}

/** Service worker push алғанда: бұл құрылғының шақырылған немесе келесі тұрған талондары. */
export async function pendingPush(ctx, endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return { orders: [] };
  const { results } = await ctx.db
    .prepare(
      `SELECT o.code, o.number, o.status, s.lang,
              (SELECT COUNT(*) FROM orders w WHERE w.status = 'waiting' AND w.id < o.id) AS ahead
       FROM push_subscriptions s JOIN orders o ON o.id = s.order_id
       WHERE s.endpoint = ? AND o.status IN ('waiting', 'serving')
       ORDER BY o.id`,
    )
    .bind(endpoint)
    .all();
  return {
    orders: results.filter((o) => o.status === 'serving' || o.ahead === 0).map(({ code, number, status, lang }) => ({ code, number, status, lang })),
  };
}

/**
 * Кезек өзгергеннен кейін: шақырылған топқа — «кезегіңіз келді», кезекте бірінші тұрғанға — «келесі сіз»
 * (бір-ақ рет). Жауап кейін жіберіледі (ctx.waitUntil).
 */
export async function notifyQueue(ctx, { calledId = null } = {}) {
  const { db } = ctx;
  const [called, next, keys] = await db.batch([
    db.prepare('SELECT endpoint FROM push_subscriptions WHERE order_id = ?').bind(calledId ?? 0),
    db.prepare(
      `SELECT s.order_id, s.endpoint FROM push_subscriptions s
       WHERE s.next_sent = 0 AND s.order_id = (SELECT id FROM orders WHERE status = 'waiting' ORDER BY id LIMIT 1)`,
    ),
    db.prepare("SELECT key, value FROM settings WHERE key IN ('vapid_public', 'vapid_private')"),
  ]);
  const endpoints = new Set(called.results.map((r) => r.endpoint));
  if (next.results.length) {
    await db.prepare('UPDATE push_subscriptions SET next_sent = 1 WHERE order_id = ?').bind(next.results[0].order_id).run();
    for (const r of next.results) endpoints.add(r.endpoint);
  }
  if (!endpoints.size) return [];
  const setting = Object.fromEntries(keys.results.map((r) => [r.key, r.value]));
  const list = [...endpoints];
  const results = await Promise.all(
    list.map((endpoint) =>
      sendPush({ endpoint, publicKey: setting.vapid_public, privateJwk: setting.vapid_private, subject: vapidSubject(ctx.origin) }),
    ),
  );
  const gone = list.filter((_, i) => results[i].gone);
  if (gone.length) {
    await db.batch(gone.map((endpoint) => db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint)));
  }
  return results;
}
