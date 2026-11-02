import crypto from 'node:crypto';
import { badRequest, notFound } from '../errors.js';
import { nowIso } from '../time.js';
import { PUSH_HOSTS, pushLang, sendPush, validEndpoint, vapidSubject } from '../webpush.js';

const MAX_PER_ORDER = 10;

/**
 * Клиент телефонына хабарлама (Web Push): «Сіздің кезегіңіз келді!» және «Келесі — сіз!».
 * Бет жабық немесе телефон құлыптаулы болса да келеді, дыбысы — телефонның өз хабарлама дыбысы.
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof import('./settings.js').createSettings>} settings
 * @param {{ origin?: string | null, hosts?: string[], allowInsecure?: boolean }} [options]
 */
export function createPush(db, settings, { origin = null, hosts = PUSH_HOSTS, allowInsecure = false } = {}) {
  if (!settings.get('vapid_public') || !settings.get('vapid_private')) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    settings.set('vapid_public', raw.toString('base64url'));
    settings.set('vapid_private', JSON.stringify(jwk));
  }

  const orderByCode = db.prepare("SELECT id, status FROM orders WHERE code = ?");
  const countFor = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE order_id = ?');
  const insert = db.prepare(`
    INSERT INTO push_subscriptions (order_id, endpoint, lang, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (order_id, endpoint) DO UPDATE SET lang = excluded.lang
  `);
  const endpointsFor = db.prepare('SELECT endpoint FROM push_subscriptions WHERE order_id = ?');
  const firstWaiting = db.prepare("SELECT id FROM orders WHERE status = 'waiting' ORDER BY id LIMIT 1");
  const unsentNext = db.prepare('SELECT endpoint FROM push_subscriptions WHERE order_id = ? AND next_sent = 0');
  const markNext = db.prepare('UPDATE push_subscriptions SET next_sent = 1 WHERE order_id = ?');
  const removeEndpoint = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const pendingFor = db.prepare(`
    SELECT o.code, o.number, o.status, s.lang,
           (SELECT COUNT(*) FROM orders w WHERE w.status = 'waiting' AND w.id < o.id) AS ahead
    FROM push_subscriptions s JOIN orders o ON o.id = s.order_id
    WHERE s.endpoint = ? AND o.status IN ('waiting', 'serving')
    ORDER BY o.id
  `);
  const cleanupStmt = db.prepare(
    "DELETE FROM push_subscriptions WHERE order_id NOT IN (SELECT id FROM orders WHERE status IN ('waiting', 'serving'))",
  );

  async function ping(endpoints) {
    const keys = { publicKey: settings.get('vapid_public'), privateJwk: settings.get('vapid_private'), subject: vapidSubject(origin) };
    const results = await Promise.all(endpoints.map((endpoint) => sendPush({ endpoint, ...keys })));
    results.forEach((r, i) => r.gone && removeEndpoint.run(endpoints[i]));
    return results;
  }

  return {
    publicKey: () => settings.get('vapid_public'),

    /** Клиент «Хабарлау» басқанда: құрылғыны талонға жазу. */
    subscribe(code, body) {
      const endpoint = validEndpoint(body?.endpoint, { hosts, allowInsecure });
      if (!endpoint) throw badRequest('invalid_push');
      const order = typeof code === 'string' ? orderByCode.get(code.toLowerCase()) : null;
      if (!order) throw notFound('order_not_found');
      if (order.status !== 'waiting' && order.status !== 'serving') throw badRequest('order_closed');
      if (countFor.get(order.id).n >= MAX_PER_ORDER) throw badRequest('invalid_push');
      insert.run(order.id, endpoint, pushLang(body?.lang), nowIso());
      return { ok: true };
    },

    /** Service worker push алғанда: бұл құрылғының шақырылған немесе келесі тұрған талондары. */
    pending(endpoint) {
      if (typeof endpoint !== 'string' || endpoint.length > 1024) return { orders: [] };
      const orders = pendingFor
        .all(endpoint)
        .filter((o) => o.status === 'serving' || o.ahead === 0)
        .map(({ code, number, status, lang }) => ({ code, number, status, lang }));
      return { orders };
    },

    /**
     * Кезек өзгергеннен кейін: шақырылған топқа — «кезегіңіз келді», кезекте бірінші тұрғанға — «келесі сіз»
     * (соңғысы бір-ақ рет). Сұраудың жауабын күттірмейді.
     * @param {{ calledId?: number | null }} [options]
     */
    async notifyQueue({ calledId = null } = {}) {
      const endpoints = new Set();
      if (calledId) for (const r of endpointsFor.all(calledId)) endpoints.add(r.endpoint);
      const next = firstWaiting.get();
      if (next) {
        const fresh = unsentNext.all(next.id);
        if (fresh.length) {
          markNext.run(next.id);
          for (const r of fresh) endpoints.add(r.endpoint);
        }
      }
      if (!endpoints.size) return [];
      return ping([...endpoints]);
    },

    /** Жабылған талондардың жазылымдарын тазалау (минутына бір рет). */
    cleanup: () => cleanupStmt.run().changes,
  };
}
